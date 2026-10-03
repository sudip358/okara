/**
 * Live view GEO project containers (docs/live-view-design.md section 17): 06 what the AI engines searched for,
 * 07 brands in AI answers, 08 most-cited domains, 09 prompt history. API-sampled stored answers only (manual
 * imports are never mixed in). Every statement filters workspace_id AND project_id, has a LIMIT and binds at
 * most 50 values; caps are in insights-lib.ts and a hit cap is reported (`truncated`, lower bounds).
 */
import type {
  LiveBrandsInsight,
  LiveCitedDomainsInsight,
  LiveEngineQueriesInsight,
  LiveInsightWindow,
  LivePromptHistoryInsight,
} from "@shared/types";
import type { Db } from "../lib/db";
import type { ProjectRow } from "../platform/access";
import { clip, DEMO_LABEL } from "../coverage/common";
import { normalizeQuery } from "../geo/analyze";
import { projectBrands } from "../geo/detect";
import { normalizeDemandQuery } from "../seo/gsc/demand";
import { loadGscMetrics } from "./lookups";
import { usableSync } from "./insights-seo";
import {
  CITED_DOMAINS,
  ENGINE_QUERIES_LIMIT,
  INSIGHT_WINDOW_DAYS,
  PROMPT_HISTORY,
  brandTable,
  engineOrder,
  groupCitedDomains,
  promptHistoryGrid,
  sinceIso,
  type BrandGroup,
  type CitationLite,
  type HistoryObservation,
} from "./insights-lib";

const API_SAMPLED = "API-sampled answers; consumer apps may answer differently.";
/** (engine, brand) groups read at most (engines × tracked brands is small; a hit cap is reported). */
const BRAND_GROUP_CAP = 500;

function windowOf(now: Date): LiveInsightWindow {
  return { from: sinceIso(now, INSIGHT_WINDOW_DAYS), to: now.toISOString(), days: INSIGHT_WINDOW_DAYS };
}
const labelsOf = (p: ProjectRow, ...more: string[]) => [...(p.is_demo === 1 ? [DEMO_LABEL] : []), API_SAMPLED, ...more];
const stateOf = (p: ProjectRow) => (p.is_demo === 1 ? ("demo" as const) : ("ready" as const));

// ------------------------------------------------------------------ 06 what the AI engines searched for

/**
 * Engine search queries ("fan-out" searches the provider exposed) of API answers stored in the window, grouped by
 * the stored normalized query: engines, distinct answers, last seen. Each listed query is looked up EXACTLY (same
 * normalized text) in the latest usable Search Console sync's current window (live/lookups.ts loadGscMetrics).
 */
export async function buildEngineQueries(db: Db, p: ProjectRow, now: Date): Promise<LiveEngineQueriesInsight> {
  const ws = p.workspace_id;
  const window = windowOf(now);
  const where = `q.workspace_id = ? AND q.project_id = ? AND o.workspace_id = ? AND o.project_id = ? AND o.measurement_type = 'api' AND o.created_at >= ?`;
  const args = [ws, p.id, ws, p.id, window.from] as const;
  const join = "geo_search_queries q JOIN geo_observations o ON o.id = q.observation_id AND o.workspace_id = q.workspace_id AND o.project_id = q.project_id";
  const [count, groups] = await Promise.all([
    db.first<{ n: number }>(`SELECT COUNT(DISTINCT q.normalized) AS n FROM ${join} WHERE ${where} LIMIT 1`, ...args),
    db.all<{ normalized: string; answers: number; last_seen: string; providers: string | null }>(
      `SELECT q.normalized AS normalized, COUNT(DISTINCT q.observation_id) AS answers, MAX(o.created_at) AS last_seen, GROUP_CONCAT(DISTINCT q.provider) AS providers
         FROM ${join} WHERE ${where}
        GROUP BY q.normalized ORDER BY answers DESC, last_seen DESC, q.normalized LIMIT ?`,
      ...args,
      ENGINE_QUERIES_LIMIT,
    ),
  ]);
  // Stored forms are normalized at analysis time; normalizeQuery again so variants of one search merge.
  const merged = new Map<string, { answers: number; lastSeen: string; engines: Set<string> }>();
  for (const g of groups) {
    const key = normalizeQuery(g.normalized);
    if (!key) continue;
    const m = merged.get(key) ?? { answers: 0, lastSeen: "", engines: new Set<string>() };
    m.answers += Number(g.answers);
    if (g.last_seen > m.lastSeen) m.lastSeen = g.last_seen;
    for (const e of (g.providers ?? "").split(",")) if (e) m.engines.add(e);
    merged.set(key, m);
  }
  const queries = [...merged.keys()];
  const sync = await usableSync(db, p);
  const gsc = sync && queries.length ? await loadGscMetrics(db, ws, p.id, [], queries) : null;
  const rows = [...merged]
    .sort((a, b) => b[1].answers - a[1].answers || (b[1].lastSeen < a[1].lastSeen ? -1 : b[1].lastSeen > a[1].lastSeen ? 1 : 0) || (a[0] < b[0] ? -1 : 1))
    .map(([query, m]) => ({
      query: clip(query, 200),
      engines: engineOrder(m.engines),
      answers: m.answers,
      lastSeen: m.lastSeen,
      gsc: gsc?.queries.get(normalizeDemandQuery(query)) ?? null,
    }));
  const total = Number(count?.n ?? 0);
  return {
    kind: "engine_queries",
    state: stateOf(p),
    message: null,
    generatedAt: now.toISOString(),
    labels: labelsOf(
      p,
      "Only engines that expose their searches are listed.",
      "Search Console match: the exact normalized query text in the latest sync's current window, summed over your pages (≈ position = impression-weighted).",
    ),
    truncated: false,
    window,
    rows,
    total,
    gscSync: sync ? { syncedAt: sync.synced_at, window: { start: sync.window_start, end: sync.window_end } } : null,
    limit: ENGINE_QUERIES_LIMIT,
  };
}

// ------------------------------------------------------------------ 07 brands in AI answers

/**
 * Per engine and tracked brand (your brand = "self"), over analysed API answers to DISCOVERY prompts stored in
 * the window: answers that checked the brand (m), and those mentioning it, citing its site, recommending it and
 * mentioning it negatively (n). One brand row per answer is counted once (MAX per answer, then SUM).
 */
export async function buildBrands(db: Db, p: ProjectRow, now: Date): Promise<LiveBrandsInsight> {
  const ws = p.workspace_id;
  const window = windowOf(now);
  const rows = await db.all<{ provider: string; brand_key: string; is_self: number; answers: number; mentioned: number; cited: number; recommended: number; negative: number }>(
    `SELECT provider, brand_key, MAX(is_self) AS is_self, COUNT(*) AS answers, SUM(m) AS mentioned, SUM(c) AS cited, SUM(r) AS recommended, SUM(n) AS negative
       FROM (SELECT o.provider AS provider, b.observation_id AS obs, b.brand_key AS brand_key, MAX(b.is_self) AS is_self,
                    MAX(b.mentioned) AS m, MAX(b.cited) AS c,
                    MAX(CASE WHEN b.recommendation_status = 'recommended' THEN 1 ELSE 0 END) AS r,
                    MAX(CASE WHEN b.recommendation_status = 'mentioned_negatively' THEN 1 ELSE 0 END) AS n
               FROM geo_observations o JOIN geo_brand_observations b ON b.observation_id = o.id AND b.workspace_id = o.workspace_id AND b.project_id = o.project_id
              WHERE o.workspace_id = ? AND o.project_id = ? AND o.measurement_type = 'api' AND o.status = 'ok' AND o.prompt_type = 'discovery' AND o.created_at >= ?
              GROUP BY o.provider, b.observation_id, b.brand_key)
      GROUP BY provider, brand_key ORDER BY provider, brand_key LIMIT ?`,
    ws,
    p.id,
    window.from,
    BRAND_GROUP_CAP + 1,
  );
  const truncated = rows.length > BRAND_GROUP_CAP;
  const groups: BrandGroup[] = rows.slice(0, BRAND_GROUP_CAP).map((r) => ({
    provider: r.provider,
    brandKey: clip(r.brand_key, 120),
    isSelf: Number(r.is_self) === 1,
    answers: Number(r.answers),
    mentioned: Number(r.mentioned),
    cited: Number(r.cited),
    recommended: Number(r.recommended),
    negative: Number(r.negative),
  }));
  const t = brandTable(groups, { self: clip(p.brand_name, 120) || "Your brand" });
  return {
    kind: "brands",
    state: stateOf(p),
    message: null,
    generatedAt: now.toISOString(),
    labels: labelsOf(
      p,
      "Discovery prompts only (reputation prompts name your brand). Counts are n of m analysed answers that checked each brand; no share is claimed.",
      "Mentioned = named in the answer; cited = a citation of the brand's site; recommended and mentioned negatively are the stored recommendation status.",
    ),
    truncated,
    window,
    engines: t.engines,
    brands: t.brands,
  };
}

// ------------------------------------------------------------------ 08 most-cited domains

/** Citations of 'ok' API answers stored in the window (at most CITED_DOMAINS.rowCap rows, newest answers first), grouped by host. */
export async function buildCitedDomains(db: Db, p: ProjectRow, now: Date): Promise<LiveCitedDomainsInsight> {
  const ws = p.workspace_id;
  const window = windowOf(now);
  const rows = await db.all<{ observation_id: string; provider: string; url: string; title: string | null; source_type: string }>(
    `SELECT c.observation_id, o.provider, c.url, c.title, c.source_type
       FROM geo_observations o JOIN geo_citations c ON c.observation_id = o.id AND c.workspace_id = o.workspace_id AND c.project_id = o.project_id
      WHERE o.workspace_id = ? AND o.project_id = ? AND o.measurement_type = 'api' AND o.status = 'ok' AND o.created_at >= ?
      ORDER BY o.created_at DESC, c.rowid LIMIT ?`,
    ws,
    p.id,
    window.from,
    CITED_DOMAINS.rowCap + 1,
  );
  const truncated = rows.length > CITED_DOMAINS.rowCap;
  const list: CitationLite[] = rows.slice(0, CITED_DOMAINS.rowCap).map((r) => ({ observationId: r.observation_id, provider: r.provider, url: r.url, title: r.title, sourceType: r.source_type }));
  const g = groupCitedDomains(list, projectBrands(p), CITED_DOMAINS.limit);
  const labels = labelsOf(
    p,
    "Hosts of the citations in stored answers (a provider redirect link counts by its bare-domain title, else it is unresolved). Your site and tracked competitors are tagged by their configured domains.",
  );
  if (truncated) labels.push(`Only the citations of the newest answers (${CITED_DOMAINS.rowCap.toLocaleString("en-US")} rows) were read: counts are lower bounds.`);
  return {
    kind: "cited_domains",
    state: stateOf(p),
    message: null,
    generatedAt: now.toISOString(),
    labels,
    truncated,
    window,
    rows: g.rows.map((r) => ({ ...r, host: clip(r.host, 200) })),
    own: g.own ? { ...g.own, host: clip(g.own.host, 200) } : null,
    answersWithCitations: g.answersWithCitations,
    totalHosts: g.totalHosts,
    unresolved: g.unresolved,
    limit: CITED_DOMAINS.limit,
  };
}

// ------------------------------------------------------------------ 09 prompt history

/**
 * Approved prompts of the active set × engine × the engine's last runs (PROMPT_HISTORY): the stored outcome of
 * each answer (cited / named / missing / failed / not analysed) or "none". Reads the newest GEO runs of the
 * project (runScan) and their API answers (observationCap) with the self brand row of each.
 */
export async function buildPromptHistory(db: Db, p: ProjectRow, now: Date): Promise<LivePromptHistoryInsight> {
  const ws = p.workspace_id;
  const set = await db.first<{ id: string; version: number; label: string | null }>(
    "SELECT id, version, label FROM geo_prompt_sets WHERE workspace_id = ? AND project_id = ? AND active = 1 ORDER BY version DESC LIMIT 1",
    ws,
    p.id,
  );
  const base = { kind: "prompt_history" as const, generatedAt: now.toISOString(), maxRuns: PROMPT_HISTORY.runsPerEngine };
  if (!set) {
    return { ...base, state: p.is_demo === 1 ? "demo" : "setup_required", message: "No prompt set yet: add and approve prompts on the GEO prompts page.", labels: labelsOf(p), truncated: false, promptSet: null, engines: [], rows: [] };
  }
  const [prompts, runs] = await Promise.all([
    db.all<{ id: string; text: string }>(
      "SELECT id, text FROM geo_prompts WHERE workspace_id = ? AND project_id = ? AND prompt_set_id = ? AND approved = 1 ORDER BY position LIMIT ?",
      ws,
      p.id,
      set.id,
      PROMPT_HISTORY.prompts,
    ),
    db.all<{ id: string; created_at: string }>(
      "SELECT id, created_at FROM agent_runs WHERE workspace_id = ? AND project_id = ? AND agent = 'geo' ORDER BY created_at DESC, id DESC LIMIT ?",
      ws,
      p.id,
      PROMPT_HISTORY.runScan,
    ),
  ]);
  let obs: Array<{ run_id: string; provider: string; prompt_text: string; status: string; created_at: string; analysed: number; self_cited: number | null; self_mentioned: number | null }> = [];
  if (runs.length > 0) {
    obs = await db.all(
      `SELECT o.run_id, o.provider, o.prompt_text, o.status, o.created_at,
              EXISTS (SELECT 1 FROM geo_brand_observations b WHERE b.observation_id = o.id AND b.workspace_id = o.workspace_id AND b.project_id = o.project_id) AS analysed,
              (SELECT MAX(b.cited) FROM geo_brand_observations b
                WHERE b.observation_id = o.id AND b.workspace_id = o.workspace_id AND b.project_id = o.project_id AND b.is_self = 1) AS self_cited,
              (SELECT MAX(b.mentioned) FROM geo_brand_observations b
                WHERE b.observation_id = o.id AND b.workspace_id = o.workspace_id AND b.project_id = o.project_id AND b.is_self = 1) AS self_mentioned
         FROM geo_observations o
        WHERE o.workspace_id = ? AND o.project_id = ? AND o.measurement_type = 'api' AND o.run_id IN (${runs.map(() => "?").join(", ")})
        ORDER BY o.created_at DESC LIMIT ?`,
      ws,
      p.id,
      ...runs.map((r) => r.id),
      PROMPT_HISTORY.observationCap + 1,
    );
  }
  const truncated = obs.length > PROMPT_HISTORY.observationCap;
  const history: HistoryObservation[] = obs.slice(0, PROMPT_HISTORY.observationCap).map((o) => ({
    runId: o.run_id,
    provider: o.provider,
    promptText: o.prompt_text,
    status: o.status,
    analysed: Number(o.analysed) === 1,
    selfCited: Number(o.self_cited) === 1,
    selfMentioned: Number(o.self_mentioned) === 1,
    createdAt: o.created_at,
  }));
  const grid = promptHistoryGrid(prompts.map((x) => ({ id: x.id, text: x.text })), history, runs.map((r) => ({ id: r.id, createdAt: r.created_at })), PROMPT_HISTORY.runsPerEngine);
  const labels = labelsOf(
    p,
    `Each engine's last ${PROMPT_HISTORY.runsPerEngine} runs with stored answers, oldest first. Cited = your site cited; mentioned = brand named without a citation; absent = neither; no answer = failed or nothing stored for the prompt in that run.`,
  );
  if (truncated) labels.push(`Only the newest ${PROMPT_HISTORY.observationCap.toLocaleString("en-US")} answers were read: older cells may read "no answer".`);
  return {
    ...base,
    state: stateOf(p),
    message: prompts.length === 0 ? "No approved prompts in the active set." : null,
    labels,
    truncated,
    promptSet: { version: Number(set.version), label: set.label ? clip(set.label, 120) : null },
    engines: grid.engines,
    rows: grid.rows.map((r) => ({ ...r, text: clip(r.text, 300) })),
  };
}
