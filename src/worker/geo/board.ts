/**
 * AI engine board [A6-A8, A11] (docs/api.md "GET /projects/:pid/geo/board", UI docs/geo-board-design.md).
 * Stored data only: no provider call, no Jev, no budget. Every query filters by workspace_id + project_id.
 *
 * One lane per engine in fixed order (openai_geo, anthropic_geo, gemini, perplexity), always present, then
 * one lane per custom GEO engine ("custom_geo:<id>": configured ones, then removed ones with history in this
 * project; their answers count toward citation rate only when the provider returned web sources (grounded),
 * otherwise mention rate only; a custom lane without grounded answers in its cohort has citation rate
 * unavailable, denominator 0):
 *   - metrics over the engine's LATEST cohort (geo_observations with measurement_type 'api', same
 *     cohort_key), with the metrics.ts definitions used by GeoResults lanes (discovery prompts; 'ok' rows
 *     not analysed yet are excluded and reported in labels): citationRate, mentionRate, laneCounts;
 *   - answersSkippingUs = valid discovery answers where the brand is neither mentioned nor cited;
 *     citedInstead = the host (parsed, www-less; own-site hosts excluded) cited in the most skipping
 *     answers, share = those answers / answersSkippingUs;
 *   - costUsd sums geo_observations.cost_usd of the cohort: null when any is unknown, isEstimate when any
 *     is an estimate (never $0 for unknown); searchQueries counts geo_search_queries of the cohort;
 *   - feed: latest valid (ok + analysed) observation per approved prompt of the active set within the
 *     cohort, newest first, max FEED_LIMIT; prompts without one are 'not_run' (no cards at all
 *     while the lane has never run). position = the stored
 *     list_rank of a real ordered list; sentiment only when the brand was mentioned and a sentiment was
 *     measured; latencyMs from provider_calls joined on request_id (null when not linked).
 * Lane state: demo (demo project) > setup_required (engine not configured: key or model missing) > error (every answer of the engine's latest run failed; stateDetail = the
 * stored error) > ready. A configured engine that never ran is 'ready' with an empty feed and zero counts.
 */
import type {
  BoardLaneProviderId,
  CapabilityState,
  CostUsd,
  EngineBoardResponse,
  EngineFeedItem,
  EngineLaneSummary,
  GeoEngineProviderId,
  Sentiment,
  SourceType,
} from "@shared/types";
import type { Env } from "../env";
import type { Db } from "../lib/db";
import { parseJson } from "../lib/db";
import type { ProjectRow } from "../platform/access";
import { capabilityPresence, type CapabilityPresence } from "../runs/runtime";
import { resolveWorkspaceModels, type ResolvedModels } from "../platform/provider-models";
import { CUSTOM_GEO_NO_SOURCES_NOTE, CUSTOM_GEO_NOTE, CUSTOM_GEO_SOURCES_NOTE, customGeoLabelFor, customGeoLabels, isCustomGeoId } from "./custom-lanes";
import { answerOutcome } from "../runs/activity";
import { inChunks } from "../coverage/common";
import { resolveCitation } from "../coverage/geo-data";
import { selfDomains } from "./detect";
import { citationRate, laneCounts, mentionRate, ratio, sample, smallSampleWarning, SMALL_SAMPLE_MIN, type MetricObservation } from "./metrics";
import { getActivePromptSet } from "./prompts";
import { GEO_LABELS } from "./results";
import { isSourceType } from "./source-type";

export const BOARD_LANES: readonly GeoEngineProviderId[] = ["openai_geo", "anthropic_geo", "gemini", "perplexity"];
export const FEED_LIMIT = 50;
/** Rows read per lane (latest cohort). */
export const BOARD_OBSERVATION_LIMIT = 1000;

export const LANE_LABELS: Record<GeoEngineProviderId, string> = {
  openai_geo: "OpenAI Responses API · web_search (API-sampled)",
  anthropic_geo: "Anthropic Messages API · web_search (API-sampled)",
  gemini: "Gemini API · Google Search grounding (API-sampled)",
  perplexity: "Perplexity API · web search (API-sampled)",
};

const VENDOR: Record<GeoEngineProviderId, string> = { openai_geo: "OpenAI", anthropic_geo: "Anthropic", gemini: "Gemini", perplexity: "Perplexity" };
const MODEL_ENV: Record<GeoEngineProviderId, "OPENAI_GEO_MODEL" | "ANTHROPIC_GEO_MODEL" | "GEMINI_MODEL" | "PERPLEXITY_MODEL"> = {
  openai_geo: "OPENAI_GEO_MODEL",
  anthropic_geo: "ANTHROPIC_GEO_MODEL",
  gemini: "GEMINI_MODEL",
  perplexity: "PERPLEXITY_MODEL",
};

export const BOARD_LABELS = {
  apiSampled: "API-sampled answers; not consumer-app answers (ChatGPT, Claude, Gemini or Perplexity apps may answer differently).",
  measured: "Measured, not projected: no traffic, revenue, ranking or citation forecasts.",
  cohort: "Each engine column uses that engine's latest configuration (prompt-set version, model, grounding); other configurations are not mixed in.",
} as const;

interface ObsRow {
  id: string;
  run_id: string | null;
  prompt_id: string | null;
  prompt_text: string;
  prompt_type: string;
  cohort_key: string;
  provider: string;
  model: string;
  grounding_mode: string;
  status: "ok" | "failed" | "incomplete";
  grounded: number;
  request_id: string | null;
  cost_usd: number | null;
  cost_is_estimate: number;
  usage_json: string;
  error: string | null;
  created_at: string;
}

interface SelfRow {
  observation_id: string;
  mentioned: number;
  cited: number;
  list_rank: number | null;
  sentiment: Sentiment;
  method: string;
}

/** Max custom lanes shown (configured ones plus removed ones with history). */
const MAX_CUSTOM_BOARD_LANES = 6;

function setupDetail(provider: GeoEngineProviderId, models: ResolvedModels): string {
  const modelVar = MODEL_ENV[provider];
  const article = VENDOR[provider] === "OpenAI" || VENDOR[provider] === "Anthropic" ? "an" : "a";
  const key = `${article} ${VENDOR[provider]} API key`;
  if (!models[provider].model) return `Choose ${article} ${VENDOR[provider]} model on the Integrations page (or set ${modelVar}) and add ${key}`;
  return `Add ${key} (or check that the ${VENDOR[provider]} model id is valid)`;
}

export const CUSTOM_LANE_BOARD_LABEL = `Custom GEO engines (${CUSTOM_GEO_NOTE}): an answer counts toward citation rate only when the provider returned web sources (${CUSTOM_GEO_SOURCES_NOTE}); answers without sources (${CUSTOM_GEO_NO_SOURCES_NOTE}). Citation rate is not measured for a custom lane with no sourced answers.`;

export function laneCost(rows: Array<{ cost_usd: number | null; cost_is_estimate: number }>): CostUsd {
  if (rows.length === 0) return { value: null, isEstimate: true };
  if (rows.some((r) => r.cost_usd === null)) return { value: null, isEstimate: true };
  return { value: rows.reduce((a, r) => a + (r.cost_usd ?? 0), 0), isEstimate: rows.some((r) => r.cost_is_estimate === 1) };
}

function asSourceType(s: string): SourceType {
  return isSourceType(s) ? s : "other";
}

function exposedFlag(usageJson: string): boolean {
  const u = parseJson<Record<string, unknown>>(usageJson, {});
  return u.searchQueriesExposed === true || Array.isArray(u.searchQueries);
}

export async function buildEngineBoard(env: Env, db: Db, project: ProjectRow, now: Date): Promise<EngineBoardResponse> {
  const ws = project.workspace_id;
  const pid = project.id;
  const isDemo = project.is_demo === 1;
  const [presence, models, customLabels, customHistory] = await Promise.all([
    capabilityPresence(env, db, ws, now) as Promise<CapabilityPresence>,
    resolveWorkspaceModels(env, db, ws),
    customGeoLabels(db, ws),
    db.all<{ provider: string }>(
      `SELECT DISTINCT provider FROM geo_observations WHERE workspace_id = ? AND project_id = ? AND measurement_type = 'api' AND provider LIKE 'custom_geo:%' LIMIT ${MAX_CUSTOM_BOARD_LANES}`,
      ws,
      pid,
    ),
  ]);
  const configuredCustom = new Set(presence.customGeoEngines);
  const customLanes = [...new Set<string>([...presence.customGeoEngines, ...customHistory.map((r) => r.provider).filter(isCustomGeoId).sort()])].slice(
    0,
    MAX_CUSTOM_BOARD_LANES,
  ) as BoardLaneProviderId[];
  const allLanes: BoardLaneProviderId[] = [...BOARD_LANES, ...customLanes];
  const [promptSet, laneEntries] = await Promise.all([
    getActivePromptSet(db, ws, pid),
    // Per lane: its latest cohort, then that cohort's rows (newest first). Queried per engine so one busy
    // engine can never push another engine's latest cohort out of a shared row cap.
    Promise.all(
      allLanes.map(async (provider): Promise<[BoardLaneProviderId, ObsRow[]]> => {
        const latest = await db.first<{ cohort_key: string }>(
          `SELECT cohort_key FROM geo_observations WHERE workspace_id = ? AND project_id = ? AND measurement_type = 'api' AND provider = ?
            ORDER BY created_at DESC, rowid DESC LIMIT 1`,
          ws,
          pid,
          provider,
        );
        if (!latest) return [provider, []];
        const rows = await db.all<ObsRow>(
          `SELECT id, run_id, prompt_id, prompt_text, prompt_type, cohort_key, provider, model, grounding_mode, status, grounded, request_id,
                  cost_usd, cost_is_estimate, usage_json, error, created_at
             FROM geo_observations WHERE workspace_id = ? AND project_id = ? AND measurement_type = 'api' AND provider = ? AND cohort_key = ?
            ORDER BY created_at DESC, rowid DESC LIMIT ${BOARD_OBSERVATION_LIMIT}`,
          ws,
          pid,
          provider,
          latest.cohort_key,
        );
        return [provider, rows];
      }),
    ),
  ]);
  const laneRows = new Map<BoardLaneProviderId, ObsRow[]>(laneEntries);
  const cohortIds = [...laneRows.values()].flatMap((rs) => rs.map((r) => r.id));
  const okIds = [...laneRows.values()].flatMap((rs) => rs.filter((r) => r.status === "ok").map((r) => r.id));
  const requestIds = [...new Set([...laneRows.values()].flatMap((rs) => rs.map((r) => r.request_id).filter((x): x is string => !!x)))];

  const [brandRows, citationRows, queryCounts, latencyRows] = await Promise.all([
    inChunks(okIds, (chunk, ph) =>
      db.all<SelfRow & { brand_key: string; is_self: number }>(
        // Self + competitors mentioned or cited only ([A39]: the board reads nothing else; bounded at 60 competitors).
        `SELECT observation_id, brand_key, is_self, mentioned, cited, list_rank, sentiment, method FROM geo_brand_observations
          WHERE workspace_id = ? AND project_id = ? AND observation_id IN (${ph}) AND (is_self = 1 OR mentioned = 1 OR cited = 1)`,
        ws,
        pid,
        ...chunk,
      ),
    ),
    inChunks(okIds, (chunk, ph) =>
      db.all<{ observation_id: string; url: string; title: string | null; position: number | null; source_type: string }>(
        `SELECT observation_id, url, title, position, source_type FROM geo_citations
          WHERE workspace_id = ? AND project_id = ? AND observation_id IN (${ph}) ORDER BY position IS NULL, position, rowid`,
        ws,
        pid,
        ...chunk,
      ),
    ),
    inChunks(cohortIds, (chunk, ph) =>
      db.all<{ observation_id: string; n: number }>(
        `SELECT observation_id, COUNT(*) AS n FROM geo_search_queries WHERE workspace_id = ? AND project_id = ? AND observation_id IN (${ph}) GROUP BY observation_id`,
        ws,
        pid,
        ...chunk,
      ),
    ),
    inChunks(requestIds, (chunk, ph) =>
      db.all<{ request_id: string; latency_ms: number | null }>(
        `SELECT request_id, latency_ms FROM provider_calls WHERE workspace_id = ? AND project_id = ? AND request_id IN (${ph}) ORDER BY created_at DESC`,
        ws,
        pid,
        ...chunk,
      ),
    ),
  ]);

  const brandsByObs = new Map<string, Array<SelfRow & { brand_key: string; is_self: number }>>();
  for (const b of brandRows) {
    if (!brandsByObs.has(b.observation_id)) brandsByObs.set(b.observation_id, []);
    brandsByObs.get(b.observation_id)!.push(b);
  }
  const domains = selfDomains(project);
  const citationsByObs = new Map<string, ReturnType<typeof resolveCitation>[]>();
  for (const c of citationRows) {
    const r = resolveCitation(c, domains);
    if (!citationsByObs.has(r.observationId)) citationsByObs.set(r.observationId, []);
    citationsByObs.get(r.observationId)!.push(r);
  }
  const queriesByObs = new Map(queryCounts.map((q) => [q.observation_id, q.n]));
  const latencyByRequest = new Map<string, number | null>();
  for (const l of latencyRows) if (!latencyByRequest.has(l.request_id)) latencyByRequest.set(l.request_id, l.latency_ms);

  const approved = promptSet?.prompts.filter((p) => p.approved) ?? [];
  const labels: string[] = [];
  if (isDemo) labels.push(GEO_LABELS.demo);
  labels.push(BOARD_LABELS.apiSampled, BOARD_LABELS.measured, BOARD_LABELS.cohort, GEO_LABELS.definitions, GEO_LABELS.discoveryOnly, GEO_LABELS.noCausal);

  let pendingTotal = 0;
  let anySmall = false;
  const lanes: EngineLaneSummary[] = allLanes.map((provider) => {
    const lrows = laneRows.get(provider) ?? [];
    const custom = isCustomGeoId(provider);
    const configured = custom ? configuredCustom.has(provider) : presence[provider];

    // Metric observations (ok rows without analysis are pending, not absences).
    const metric: MetricObservation[] = [];
    for (const r of lrows) {
      const b = brandsByObs.get(r.id) ?? [];
      if (r.status === "ok" && b.length === 0) {
        pendingTotal++;
        continue;
      }
      metric.push({
        id: r.id,
        cohortKey: r.cohort_key,
        provider: r.provider,
        promptId: r.prompt_id,
        promptType: r.prompt_type === "reputation" ? "reputation" : "discovery",
        measurementType: "api",
        status: r.status,
        grounded: r.grounded === 1,
        runId: r.run_id,
        createdAt: r.created_at,
        brands: b.map((x) => ({ brandKey: x.brand_key, isSelf: x.is_self === 1, mentioned: x.mentioned === 1, cited: x.cited === 1 })),
      });
    }
    const disc = sample(metric);
    const mr = mentionRate(disc);
    const cr = citationRate(disc);
    const selfOf = (id: string) => (brandsByObs.get(id) ?? []).find((b) => b.is_self === 1);
    const skipping = disc.filter((o) => {
      if (o.status !== "ok") return false;
      const s = o.brands.find((b) => b.isSelf);
      return !s || (!s.mentioned && !s.cited);
    });
    const hostCounts = new Map<string, number>();
    for (const o of skipping) {
      const hosts = new Set((citationsByObs.get(o.id) ?? []).filter((c) => !c.self && c.host).map((c) => c.host!));
      for (const h of hosts) hostCounts.set(h, (hostCounts.get(h) ?? 0) + 1);
    }
    let citedInstead: EngineLaneSummary["citedInstead"] = null;
    for (const [host, n] of hostCounts) {
      if (!citedInstead || n > citedInstead.share.numerator || (n === citedInstead.share.numerator && host < citedInstead.host)) {
        citedInstead = { host, share: ratio(n, skipping.length) };
      }
    }
    const sqCount = lrows.reduce((a, r) => a + (queriesByObs.get(r.id) ?? 0), 0);
    const exposed = sqCount > 0 || lrows.some((r) => exposedFlag(r.usage_json));
    const small = lrows.length > 0 && smallSampleWarning(mr);
    anySmall ||= small;
    const latest = lrows[0] ?? null;

    // Feed: latest valid (ok + analysed) observation per approved prompt.
    const feed: EngineFeedItem[] = approved.map((p) => {
      const r = lrows.find((x) => x.status === "ok" && (brandsByObs.get(x.id)?.length ?? 0) > 0 && (x.prompt_id === p.id || (x.prompt_id === null && x.prompt_text === p.text)));
      if (!r) {
        return { promptId: p.id, promptText: p.text, observationId: null, status: "not_run", position: null, sentiment: null, latencyMs: null, grounded: false, citedInstead: null, observedAt: null };
      }
      const self = selfOf(r.id);
      const status = answerOutcome({ status: r.status, analysed: true, selfCited: self?.cited === 1, selfMentioned: self?.mentioned === 1 }) as EngineFeedItem["status"];
      const measuredSentiment = self && self.mentioned === 1 && self.sentiment !== "not_applicable" && self.sentiment !== "unknown";
      const other = status === "cited" ? null : (citationsByObs.get(r.id) ?? []).find((c) => !c.self && c.host);
      return {
        promptId: p.id,
        promptText: p.text,
        observationId: r.id,
        status,
        position: self?.list_rank ?? null,
        sentiment: measuredSentiment ? { value: self!.sentiment, method: self!.method } : null,
        latencyMs: r.request_id ? (latencyByRequest.get(r.request_id) ?? null) : null,
        grounded: r.grounded === 1,
        citedInstead: other ? { host: other.host!, url: other.via === "url" ? other.url : null, sourceType: asSourceType(other.sourceType) } : null,
        observedAt: r.created_at,
      };
    });
    feed.sort((a, b) => {
      if (a.observedAt === b.observedAt) return 0;
      if (a.observedAt === null) return 1;
      if (b.observedAt === null) return -1;
      return a.observedAt < b.observedAt ? 1 : -1;
    });

    // State.
    let state: CapabilityState = "ready";
    let stateDetail: string | null = null;
    if (isDemo) state = "demo";
    else if (!configured) {
      state = "setup_required";
      stateDetail = custom
        ? customLabels.has(provider)
          ? "Check this custom GEO engine's base URL and model on the Integrations page"
          : "This custom GEO engine was removed; its earlier answers are shown"
        : (presence.modelBlocked[provider as GeoEngineProviderId] ?? setupDetail(provider as GeoEngineProviderId, models));
    } else if (latest) {
      const lastRun = lrows.filter((r) => (latest.run_id ? r.run_id === latest.run_id : r.created_at.slice(0, 10) === latest.created_at.slice(0, 10)));
      if (lastRun.length > 0 && lastRun.every((r) => r.status === "failed")) {
        state = "error";
        const err = lastRun.find((r) => r.error)?.error ?? null;
        stateDetail = err ? `Latest run failed: ${err.replace(/\s+/g, " ").slice(0, 300)}` : "Latest run failed for every prompt.";
      }
    }

    const configuredModel = custom ? null : models[provider as GeoEngineProviderId].model;
    return {
      provider,
      label: custom ? customGeoLabelFor(provider, customLabels) : LANE_LABELS[provider as GeoEngineProviderId],
      model: latest?.model ?? (configured && configuredModel ? configuredModel : null),
      groundingMode: latest?.grounding_mode ?? null,
      state,
      stateDetail,
      cohortKey: latest?.cohort_key ?? null,
      promptsRun: new Set(disc.map((o) => o.promptId ?? o.id)).size,
      counts: laneCounts(disc),
      citationRate: cr,
      mentionRate: mr,
      answersCitingUs: cr.numerator,
      answersSkippingUs: skipping.length,
      citedInstead,
      searchQueries: { state: exposed ? "captured" : "not_exposed", count: sqCount },
      costUsd: laneCost(lrows),
      lastRunAt: latest?.created_at ?? null,
      smallSampleWarning: small,
      // A lane that never produced an observation has nothing to show yet (no placeholder cards).
      feed: lrows.length === 0 ? [] : feed.slice(0, FEED_LIMIT),
    };
  });

  if (customLanes.length > 0) labels.push(CUSTOM_LANE_BOARD_LABEL);
  if (anySmall) labels.push(`Small sample: fewer than ${SMALL_SAMPLE_MIN} answers in a denominator; do not draw conclusions from these rates.`);
  if (pendingTotal > 0) labels.push(`${pendingTotal} successful answer(s) are awaiting analysis and are not yet counted.`);

  let state: CapabilityState = "ready";
  if (isDemo) state = "demo";
  else if (approved.length === 0 || !lanes.some((l) => l.state === "ready" || l.state === "error")) state = "setup_required";
  if (!isDemo && approved.length === 0) labels.push("Setup required: approve at least one prompt.");
  if (!isDemo && !BOARD_LANES.some((p) => presence[p]) && configuredCustom.size === 0) labels.push("Setup required: configure at least one AI engine (key and model).");

  return { state, promptSetVersion: promptSet?.version ?? null, generatedAt: now.toISOString(), lanes, labels };
}
