/**
 * GEO read models for the API (docs/api.md geo rows). Every query filters by workspace_id and
 * project_id. Metric math lives in metrics.ts; this file only loads rows and assembles shapes.
 *
 * Lanes: one per API provider (configured or with history), computed over that provider's LATEST
 * cohort only (prompt-set version + model + grounding config), discovery prompts only. Manual imports
 * get their own lanes per imported surface (provider 'manual') and are never merged into API lanes,
 * share of voice, or trends. Observations with status 'ok' that have not been analyzed yet are
 * excluded from metrics (reported in labels) rather than counted as absences.
 */
import type {
  DisplacementSummary,
  GeoLane,
  GeoObservationDetail,
  GeoResults,
  RecommendationStatusInAnswer,
  SearchQuerySummary,
  Sentiment,
  SourceType,
} from "@shared/types";
import type { Env } from "../env";
import type { Db } from "../lib/db";
import { parseJson } from "../lib/db";
import { notFound } from "../lib/errors";
import { requireProject, type ProjectRow } from "../platform/access";
import { capabilityPresence } from "../runs/runtime";
import { projectBrands } from "./detect";
import {
  METRICS_VERSION,
  SMALL_SAMPLE_MIN,
  buildTrend,
  citationRate,
  laneCounts,
  mentionRate,
  sample,
  shareOfVoice,
  smallSampleWarning,
  type MetricObservation,
} from "./metrics";
import { getActivePromptSet } from "./prompts";
import { normalizeQuery } from "./analyze";
import { isSourceType } from "./source-type";
import { GEO_ENGINE_IDS, isGeoEngineId } from "./engines";

export const OBSERVATION_LOAD_LIMIT = 2000;
export const API_PROVIDERS = GEO_ENGINE_IDS;
const PROVIDER_LABELS: Record<(typeof API_PROVIDERS)[number], string> = {
  gemini: "Gemini API (API-sampled)",
  perplexity: "Perplexity API (API-sampled)",
  openai_geo: "OpenAI API with web search (API-sampled)",
  anthropic_geo: "Anthropic API with web search (API-sampled)",
};

export const GEO_LABELS = {
  apiSampled:
    "API-sampled visibility: answers come from provider APIs, not consumer apps (ChatGPT, Gemini app, Perplexity app) or Google AI Overviews.",
  denominators: "Failed or ungrounded responses are excluded from the relevant denominators.",
  definitions: `Mention rate = successful responses mentioning the brand / successful responses. Citation rate = successful grounded responses citing a verified brand domain (parsed hostname match) / successful grounded responses. Metrics ${METRICS_VERSION}.`,
  discoveryOnly: "Visibility metrics use brand-blind discovery prompts only; reputation prompts are shown per prompt and never mixed into these rates.",
  shareOfVoice: "Share of voice is restricted to the brands you track, within the latest sample; it is not market share.",
  cohorts: "Trends compare only matching cohorts (prompt-set version, provider, model, grounding configuration); a configuration change starts a new, annotated series.",
  manual: "Manual imports are separate lanes labelled with their surface, reported by you, and never merged into API-sampled metrics.",
  smallSample: `Small sample: fewer than ${SMALL_SAMPLE_MIN} responses in a denominator; do not draw conclusions from these rates.`,
  demo: "Demo data - simulated run",
  noCausal: "Rates describe sampled answers only; they do not show that a specific change caused a difference.",
} as const;

interface ObsRow {
  id: string;
  run_id: string | null;
  prompt_id: string | null;
  prompt_text: string;
  prompt_type: "discovery" | "reputation";
  cohort_key: string;
  provider: string;
  model: string;
  grounding_mode: string;
  measurement_type: "api" | "manual_import";
  imported_surface: string | null;
  status: "ok" | "failed" | "incomplete";
  grounded: number;
  cost_usd: number | null;
  cost_is_estimate: number;
  usage_json: string;
  created_at: string;
}

interface BrandRow {
  observation_id: string;
  brand_key: string;
  is_self: number;
  mentioned: number;
  cited: number;
  sentiment: Sentiment;
  list_rank: number | null;
  recommendation_status: RecommendationStatusInAnswer;
}

interface DispRow {
  observation_id: string;
  entity: string;
  url: string | null;
  source_type: string;
}

interface Loaded {
  rows: ObsRow[];
  brands: Map<string, BrandRow[]>;
  displacements: Map<string, DispRow[]>;
}

async function loadProjectObservations(db: Db, ws: string, pid: string): Promise<Loaded> {
  const rows = await db.all<ObsRow>(
    `SELECT id, run_id, prompt_id, prompt_text, prompt_type, cohort_key, provider, model, grounding_mode, measurement_type, imported_surface,
            status, grounded, cost_usd, cost_is_estimate, usage_json, created_at
       FROM geo_observations WHERE workspace_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT ${OBSERVATION_LOAD_LIMIT}`,
    ws,
    pid,
  );
  const brands = new Map<string, BrandRow[]>();
  const displacements = new Map<string, DispRow[]>();
  if (rows.length > 0) {
    const brandRows = await db.all<BrandRow>(
      `SELECT b.observation_id, b.brand_key, b.is_self, b.mentioned, b.cited, b.sentiment, b.list_rank, b.recommendation_status
         FROM geo_brand_observations b JOIN geo_observations o ON o.id = b.observation_id AND o.workspace_id = b.workspace_id
        WHERE b.workspace_id = ? AND b.project_id = ?`,
      ws,
      pid,
    );
    for (const b of brandRows) {
      if (!brands.has(b.observation_id)) brands.set(b.observation_id, []);
      brands.get(b.observation_id)!.push(b);
    }
    const dispRows = await db.all<DispRow>(
      "SELECT observation_id, entity, url, source_type FROM geo_displacements WHERE workspace_id = ? AND project_id = ? ORDER BY rowid",
      ws,
      pid,
    );
    for (const d of dispRows) {
      if (!displacements.has(d.observation_id)) displacements.set(d.observation_id, []);
      displacements.get(d.observation_id)!.push(d);
    }
  }
  return { rows, brands, displacements };
}

/** Rows usable in metrics: not 'ok'-but-unanalyzed. */
function toMetric(rows: ObsRow[], brands: Map<string, BrandRow[]>): { metric: MetricObservation[]; pending: number } {
  const metric: MetricObservation[] = [];
  let pending = 0;
  for (const r of rows) {
    const b = brands.get(r.id) ?? [];
    if (r.status === "ok" && b.length === 0) {
      pending++;
      continue;
    }
    metric.push({
      id: r.id,
      cohortKey: r.cohort_key,
      provider: r.provider,
      promptId: r.prompt_id,
      promptType: r.prompt_type === "reputation" ? "reputation" : "discovery",
      measurementType: r.measurement_type,
      status: r.status,
      grounded: r.grounded === 1,
      runId: r.run_id,
      createdAt: r.created_at,
      brands: b.map((x) => ({ brandKey: x.brand_key, isSelf: x.is_self === 1, mentioned: x.mentioned === 1, cited: x.cited === 1 })),
    });
  }
  return { metric, pending };
}

function asSourceType(s: string): SourceType {
  return isSourceType(s) ? s : "other";
}

function topCitedInstead(ids: Set<string>, displacements: Map<string, DispRow[]>): GeoLane["topCitedInstead"] {
  const counts = new Map<string, { entity: string; sourceType: SourceType; obs: Set<string> }>();
  for (const id of ids) {
    for (const d of displacements.get(id) ?? []) {
      const st = asSourceType(d.source_type);
      const k = `${d.entity}\u0000${st}`;
      if (!counts.has(k)) counts.set(k, { entity: d.entity, sourceType: st, obs: new Set() });
      counts.get(k)!.obs.add(id);
    }
  }
  let best: GeoLane["topCitedInstead"] = null;
  for (const v of counts.values()) {
    if (!best || v.obs.size > best.count) best = { entity: v.entity, sourceType: v.sourceType, count: v.obs.size };
  }
  return best;
}

function laneCost(rows: ObsRow[]): GeoLane["cost"] {
  if (rows.length === 0) return { usd: null, isEstimate: true };
  if (rows.some((r) => r.cost_usd === null)) return { usd: null, isEstimate: true };
  return { usd: rows.reduce((a, r) => a + (r.cost_usd ?? 0), 0), isEstimate: rows.some((r) => r.cost_is_estimate === 1) };
}

async function searchQueryState(db: Db, ws: string, rows: ObsRow[]): Promise<GeoLane["searchQueries"]> {
  if (rows.length === 0) return { state: "not_exposed", count: 0 };
  const ids = rows.map((r) => r.id);
  let count = 0;
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const r = await db.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM geo_search_queries WHERE workspace_id = ? AND observation_id IN (${chunk.map(() => "?").join(",")})`,
      ws,
      ...chunk,
    );
    count += r?.n ?? 0;
  }
  const exposed = count > 0 || rows.some((r) => exposedFlag(r.usage_json) === true);
  return { state: exposed ? "captured" : "not_exposed", count };
}

function exposedFlag(usageJson: string): boolean | null {
  const u = parseJson<Record<string, unknown>>(usageJson, {});
  if (u.searchQueriesExposed === true || Array.isArray(u.searchQueries)) return true;
  if (u.searchQueriesExposed === false) return false;
  return null;
}

function latestCohortRows(rows: ObsRow[]): ObsRow[] {
  // rows are newest first
  const latest = rows[0];
  return latest ? rows.filter((r) => r.cohort_key === latest.cohort_key) : [];
}

export async function buildGeoResults(env: Env, db: Db, project: ProjectRow): Promise<GeoResults> {
  const ws = project.workspace_id;
  const pid = project.id;
  const [promptSet, presence, loaded] = await Promise.all([getActivePromptSet(db, ws, pid), capabilityPresence(env, db, ws), loadProjectObservations(db, ws, pid)]);
  const isDemo = project.is_demo === 1;
  const configured = new Set(API_PROVIDERS.filter((p) => presence[p]));
  const approved = promptSet?.prompts.filter((p) => p.approved) ?? [];
  const labels: string[] = [];
  if (isDemo) labels.push(GEO_LABELS.demo);
  labels.push(GEO_LABELS.apiSampled, GEO_LABELS.denominators, GEO_LABELS.definitions, GEO_LABELS.discoveryOnly, GEO_LABELS.shareOfVoice, GEO_LABELS.cohorts, GEO_LABELS.noCausal);

  const { metric, pending } = toMetric(loaded.rows, loaded.brands);
  const metricById = new Map(metric.map((m) => [m.id, m]));
  const apiRows = loaded.rows.filter((r) => r.measurement_type === "api");
  const providers = [...new Set<string>([...configured, ...apiRows.map((r) => r.provider)])];

  const lanes: GeoLane[] = [];
  const latestSample: MetricObservation[] = [];
  const laneRowsByProvider = new Map<string, ObsRow[]>();
  let anySmall = false;
  for (const provider of providers) {
    const rows = latestCohortRows(apiRows.filter((r) => r.provider === provider));
    laneRowsByProvider.set(provider, rows);
    const m = rows.map((r) => metricById.get(r.id)).filter((x): x is MetricObservation => !!x);
    const disc = sample(m);
    latestSample.push(...disc);
    const mr = mentionRate(disc);
    const cr = citationRate(disc);
    const small = rows.length > 0 && smallSampleWarning(mr);
    anySmall ||= small;
    const latest = rows[0];
    lanes.push({
      provider,
      label: isGeoEngineId(provider) ? PROVIDER_LABELS[provider] : `${provider} API (API-sampled)`,
      model: latest?.model ?? null,
      groundingMode: latest?.grounding_mode ?? null,
      state: isDemo ? "demo" : isGeoEngineId(provider) && configured.has(provider) ? "ready" : "setup_required",
      cohortKey: latest?.cohort_key ?? null,
      promptsRun: new Set(disc.map((o) => o.promptId ?? o.id)).size,
      counts: laneCounts(disc),
      mentionRate: mr,
      citationRate: cr,
      topCitedInstead: topCitedInstead(new Set(disc.map((o) => o.id)), loaded.displacements),
      searchQueries: await searchQueryState(db, ws, rows),
      cost: laneCost(rows),
      smallSampleWarning: small,
    });
  }

  // Manual imports: one lane per surface, never merged.
  const manualRows = loaded.rows.filter((r) => r.measurement_type === "manual_import");
  const surfaces = [...new Set(manualRows.map((r) => r.imported_surface ?? "Manual import"))];
  for (const surface of surfaces) {
    const rows = manualRows.filter((r) => (r.imported_surface ?? "Manual import") === surface);
    const m = rows.map((r) => metricById.get(r.id)).filter((x): x is MetricObservation => !!x);
    const disc = sample(m, { measurementType: "manual_import" });
    const mr = mentionRate(disc, "self", { measurementType: "manual_import" });
    const cr = citationRate(disc, "self", { measurementType: "manual_import" });
    lanes.push({
      provider: "manual",
      label: `${surface}: manual import (reported by you, not API-sampled)`,
      model: "n/a",
      groundingMode: "manual_citations",
      state: isDemo ? "demo" : "ready",
      cohortKey: rows[0]?.cohort_key ?? null,
      promptsRun: new Set(disc.map((o) => o.promptId ?? o.id)).size,
      counts: laneCounts(disc),
      mentionRate: mr,
      citationRate: cr,
      topCitedInstead: topCitedInstead(new Set(disc.map((o) => o.id)), loaded.displacements),
      searchQueries: { state: "not_exposed", count: 0 },
      cost: { usd: null, isEstimate: false },
      smallSampleWarning: smallSampleWarning(mr),
    });
  }
  if (surfaces.length > 0) labels.push(GEO_LABELS.manual);
  if (anySmall) labels.push(GEO_LABELS.smallSample);
  if (pending > 0) labels.push(`${pending} successful response(s) are awaiting analysis and are not yet counted.`);

  const brandKeys = projectBrands(project).map((b) => b.key);
  const sov = shareOfVoice(latestSample, brandKeys).map((s) => ({ brandKey: s.brandKey, isSelf: s.brandKey === "self", ratio: s.ratio }));

  const trend = buildTrend(metric.filter((m) => m.measurementType === "api")).map((p) => ({
    cohortKey: p.cohortKey,
    runAt: p.runAt,
    mentionRate: p.mentionRate,
    citationRate: p.citationRate,
    annotation: p.annotation,
  }));

  const apiLanes = lanes.filter((l) => l.provider !== "manual");
  const prompts: GeoResults["prompts"] = (promptSet?.prompts ?? []).map((p) => ({
    promptId: p.id,
    text: p.text,
    promptType: p.promptType,
    perProvider: apiLanes.map((lane) => {
      const rows = laneRowsByProvider.get(lane.provider) ?? [];
      const r = rows.find((x) => x.prompt_id === p.id) ?? rows.find((x) => x.prompt_id === null && x.prompt_text === p.text);
      if (!r) {
        return { provider: lane.provider, observationId: null, status: "not_run" as const, grounded: false, mentioned: null, cited: null, sentiment: null, listRank: null, citedInstead: null };
      }
      const self = (loaded.brands.get(r.id) ?? []).find((b) => b.is_self === 1);
      const d = (loaded.displacements.get(r.id) ?? [])[0];
      return {
        provider: lane.provider,
        observationId: r.id,
        status: r.status,
        grounded: r.grounded === 1,
        mentioned: self ? self.mentioned === 1 : null,
        cited: self ? self.cited === 1 : null,
        sentiment: self ? self.sentiment : null,
        listRank: self ? self.list_rank : null,
        citedInstead: d ? { entity: d.entity, sourceType: asSourceType(d.source_type), url: d.url } : null,
      };
    }),
  }));

  let state: GeoResults["state"] = "ready";
  if (isDemo) state = "demo";
  else if (approved.length === 0 || configured.size === 0) state = "setup_required";
  if (!isDemo && approved.length === 0) labels.push("Setup required: approve at least one prompt.");
  if (!isDemo && configured.size === 0) labels.push("Setup required: configure a GEO provider key and model (OpenAI, Anthropic, Gemini or Perplexity).");

  return { state, promptSetVersion: promptSet?.version ?? null, lanes, shareOfVoice: sov, trend, prompts, labels };
}

// ------------------------------------------------------------------ observation detail
interface FullObsRow extends ObsRow {
  workspace_id: string;
  project_id: string;
  raw_answer: string | null;
  request_id: string | null;
}

export async function buildObservationDetail(db: Db, userId: string, observationId: string): Promise<GeoObservationDetail> {
  const row = await db.first<FullObsRow>(
    `SELECT o.* FROM geo_observations o JOIN memberships m ON m.workspace_id = o.workspace_id AND m.user_id = ? WHERE o.id = ?`,
    userId,
    observationId,
  );
  if (!row) throw notFound("Observation");
  await requireProject(db, userId, row.project_id);
  const ws = row.workspace_id;
  const [brands, citations, queries, disps] = await Promise.all([
    db.all<BrandRow & { spans_json: string; method: string }>(
      "SELECT observation_id, brand_key, is_self, mentioned, cited, sentiment, list_rank, recommendation_status, spans_json, method FROM geo_brand_observations WHERE workspace_id = ? AND observation_id = ? ORDER BY is_self DESC, rowid",
      ws,
      row.id,
    ),
    db.all<{ url: string; host: string; title: string | null; position: number | null; brand_key: string | null; source_type: string }>(
      "SELECT url, host, title, position, brand_key, source_type FROM geo_citations WHERE workspace_id = ? AND observation_id = ? ORDER BY position IS NULL, position, rowid",
      ws,
      row.id,
    ),
    db.all<{ query: string }>("SELECT query FROM geo_search_queries WHERE workspace_id = ? AND observation_id = ? ORDER BY rowid", ws, row.id),
    db.all<{ entity: string; url: string | null; source_type: string; span: string | null }>(
      "SELECT entity, url, source_type, span FROM geo_displacements WHERE workspace_id = ? AND observation_id = ? ORDER BY rowid",
      ws,
      row.id,
    ),
  ]);
  const usage = parseJson<Record<string, unknown>>(row.usage_json, {});
  let searchQueries: string[] | null;
  if (queries.length > 0) searchQueries = queries.map((q) => q.query);
  else if (Array.isArray(usage.searchQueries)) searchQueries = usage.searchQueries.filter((q): q is string => typeof q === "string");
  else if (usage.searchQueriesExposed === true) searchQueries = [];
  else searchQueries = null;

  return {
    id: row.id,
    promptText: row.prompt_text,
    promptType: row.prompt_type === "reputation" ? "reputation" : "discovery",
    provider: row.provider,
    model: row.model,
    groundingMode: row.grounding_mode,
    measurementType: row.measurement_type,
    importedSurface: row.imported_surface,
    status: row.status,
    grounded: row.grounded === 1,
    rawAnswer: row.raw_answer,
    requestId: row.request_id,
    cost: { usd: row.cost_usd, isEstimate: row.cost_usd === null ? true : row.cost_is_estimate === 1 },
    brands: brands.map((b) => ({
      brandKey: b.brand_key,
      isSelf: b.is_self === 1,
      mentioned: b.mentioned === 1,
      cited: b.cited === 1,
      recommendationStatus: b.recommendation_status,
      listRank: b.list_rank,
      sentiment: b.sentiment,
      spans: parseJson<Array<{ start: number; end: number; text: string }>>(b.spans_json, []).map((s) => ({ start: s.start, end: s.end, text: s.text })),
      method: b.method,
    })),
    citations: citations.map((c) => ({
      url: c.url,
      host: c.host,
      title: c.title,
      position: c.position,
      brandKey: c.brand_key,
      sourceType: asSourceType(c.source_type),
    })),
    searchQueries,
    displacements: disps.map((d) => ({ entity: d.entity, url: d.url, sourceType: d.source_type, span: d.span })),
    createdAt: row.created_at,
  };
}

// ------------------------------------------------------------------ displacements
/**
 * [A1] Aggregate displacing entities/URLs across the latest cohort of each API provider (or across
 * all manual imports when measurement = 'manual_import'). count = distinct observations.
 */
export async function buildDisplacementSummary(db: Db, project: ProjectRow, measurement: "api" | "manual_import" = "api"): Promise<DisplacementSummary[]> {
  const loaded = await loadProjectObservations(db, project.workspace_id, project.id);
  let rows = loaded.rows.filter((r) => r.measurement_type === measurement && r.status === "ok");
  if (measurement === "api") {
    const byProvider = new Map<string, ObsRow[]>();
    for (const r of rows) {
      if (!byProvider.has(r.provider)) byProvider.set(r.provider, []);
      byProvider.get(r.provider)!.push(r);
    }
    rows = [...byProvider.values()].flatMap(latestCohortRows);
  }
  const agg = new Map<string, { entity: string; sourceType: SourceType; url: string | null; obs: Set<string>; prompts: Set<string> }>();
  for (const r of rows) {
    for (const d of loaded.displacements.get(r.id) ?? []) {
      const st = asSourceType(d.source_type);
      const k = `${d.entity}\u0000${d.url ?? ""}\u0000${st}`;
      if (!agg.has(k)) agg.set(k, { entity: d.entity, sourceType: st, url: d.url, obs: new Set(), prompts: new Set() });
      const a = agg.get(k)!;
      a.obs.add(r.id);
      a.prompts.add(r.prompt_text);
    }
  }
  return [...agg.values()]
    .map((a) => ({ entity: a.entity, sourceType: a.sourceType, url: a.url, count: a.obs.size, prompts: [...a.prompts].slice(0, 20) }))
    .sort((a, b) => b.count - a.count || a.entity.localeCompare(b.entity));
}

// ------------------------------------------------------------------ [A6] search queries x GSC
export const GSC_RANKING_POSITION = 10;

/**
 * Engine search queries (only those the provider exposed) matched against the latest GSC sync's
 * current window. Impressions come from query-level rows when present (page IS NULL, device IS NULL),
 * otherwise from query x page rows (device IS NULL), never both, to avoid double counting.
 * gscPosition is the best (lowest) position among rows for the query; no averaging across slices.
 *   ranking                   a row with a page at position <= 10
 *   impressions_weak_position rows exist but none with a page at position <= 10
 *   no_matching_page          GSC data exists but the query has no rows
 *   unknown                   no completed GSC sync
 * gscWindow is the current window of the sync used (null when there is no GSC data).
 */
export async function buildSearchQuerySummary(db: Db, project: ProjectRow): Promise<SearchQuerySummary[]> {
  const ws = project.workspace_id;
  const pid = project.id;
  const rows = await db.all<{ query: string; normalized: string; provider: string }>(
    `SELECT q.query, q.normalized, q.provider FROM geo_search_queries q
       JOIN geo_observations o ON o.id = q.observation_id AND o.workspace_id = q.workspace_id
      WHERE q.workspace_id = ? AND q.project_id = ? AND o.measurement_type = 'api'`,
    ws,
    pid,
  );
  const agg = new Map<string, { count: number; providers: Set<string> }>();
  for (const r of rows) {
    const n = normalizeQuery(r.normalized || r.query);
    if (!n) continue;
    if (!agg.has(n)) agg.set(n, { count: 0, providers: new Set() });
    const a = agg.get(n)!;
    a.count++;
    a.providers.add(r.provider);
  }
  const sync = await db.first<{ id: string; window_start: string; window_end: string }>(
    "SELECT id, window_start, window_end FROM gsc_syncs WHERE workspace_id = ? AND project_id = ? AND status IN ('completed', 'partial') ORDER BY synced_at DESC LIMIT 1",
    ws,
    pid,
  );
  const gsc = new Map<string, Array<{ page: string | null; device: string | null; impressions: number; position: number }>>();
  if (sync) {
    const metrics = await db.all<{ query: string; page: string | null; device: string | null; impressions: number; position: number }>(
      "SELECT query, page, device, impressions, position FROM gsc_metrics WHERE workspace_id = ? AND project_id = ? AND sync_id = ? AND window = 'current' AND query IS NOT NULL",
      ws,
      pid,
      sync.id,
    );
    for (const m of metrics) {
      const n = normalizeQuery(m.query);
      if (!agg.has(n)) continue;
      if (!gsc.has(n)) gsc.set(n, []);
      gsc.get(n)!.push(m);
    }
  }
  return [...agg.entries()]
    .map(([normalized, a]): SearchQuerySummary => {
      const base = { normalized, count: a.count, providers: [...a.providers].sort(), gscWindow: sync ? { start: sync.window_start, end: sync.window_end } : null };
      if (!sync) return { ...base, gscMatch: "unknown", gscImpressions: null, gscPosition: null };
      const m = gsc.get(normalized) ?? [];
      if (m.length === 0) return { ...base, gscMatch: "no_matching_page", gscImpressions: 0, gscPosition: null };
      const queryLevel = m.filter((x) => x.page === null && x.device === null);
      const pageLevel = m.filter((x) => x.page !== null && x.device === null);
      const impressionsRows = queryLevel.length > 0 ? queryLevel : pageLevel.length > 0 ? pageLevel : m;
      const impressions = impressionsRows.reduce((s, x) => s + x.impressions, 0);
      const best = Math.min(...m.map((x) => x.position));
      const ranking = m.some((x) => x.page !== null && x.position <= GSC_RANKING_POSITION);
      return { ...base, gscMatch: ranking ? "ranking" : "impressions_weak_position", gscImpressions: impressions, gscPosition: Number.isFinite(best) ? best : null };
    })
    .sort((a, b) => b.count - a.count || a.normalized.localeCompare(b.normalized));
}
