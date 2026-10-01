/**
 * Live view GEO feed (docs/api.md "Live view", GET /projects/:pid/live/geo). A read model over the STORED rows
 * of ONE GEO run; nothing is simulated, interpolated, projected or re-asked:
 *
 *   geo_observations (o, measurement_type 'api') -> answers          id "obs:<id>" (same as engine_answer items)
 *   recommendations  (r)                         -> recommendations  id "rec:<id>"
 *
 * Outcome uses the AI engine board's definition (runs/activity.ts answerOutcome). While the run is active, an
 * 'ok' answer not analysed yet holds back the observation source for at most OBS_HOLD_MS (as the activity
 * feed does), so answers normally arrive once, with their outcome. After that an answer is sent with outcome
 * null; its rowid is kept in the opaque cursor (`p`, at most CURSOR_LIST_MAX) and it is re-sent with the same
 * id once its analysis is stored. Paging otherwise uses per-source rowid marks (cursor.ts).
 *
 * Totals (lanes, pipeline) always cover the whole run. Rules: every query filters workspace_id AND project_id
 * (and run_id) and has a LIMIT; dynamic IN lists stay under D1's 100 bound parameters; untrusted text is
 * clipped plain text; unknown cost stays null (never $0).
 */
import type {
  BoardLaneProviderId,
  CostUsd,
  LiveGeoAnswerRow,
  LiveGeoBoardResponse,
  LiveGeoLaneTotals,
  RecommendationStatusInAnswer,
  RunActivity,
  Sentiment,
  SourceType,
} from "@shared/types";
import type { Db } from "../lib/db";
import { parseJson } from "../lib/db";
import { badRequest } from "../lib/errors";
import type { ProjectRow } from "../platform/access";
import { clip, DEMO_LABEL, inChunks, isAnalyzable, pageKey, uniq, type GscPageData } from "../coverage/common";
import { resolveCitation } from "../coverage/geo-data";
import { brandTokenSet, contentTokens, matchPrompt, type CandidatePage } from "../coverage/answer-coverage";
import { normalizeQuery } from "../geo/analyze";
import { DEFAULT_PROMPTS_PER_RUN } from "../geo/batch";
import { BOARD_LANES, laneCost } from "../geo/board";
import { selfDomains } from "../geo/detect";
import { CUSTOM_GEO_NOTE, CUSTOM_GEO_PREFIX, isCustomGeoId } from "../geo/custom-lanes";
import { GEO_ENGINE_IDS, isGeoEngineId } from "../geo/engines";
import { latestUsableSync } from "../seo/gsc/overview";
import { answerOutcome, ACTIVITY_OBSERVATION_CAP, OBS_HOLD_MS } from "../runs/activity";
import { compareAtId, CURSOR_LIST_MAX, decodeLiveCursor, encodeLiveCursor, LIVE_DEFAULT_LIMIT, LIVE_MAX_LIMIT, mergeMarked } from "./cursor";
import { pipelineTotals, REC_COLUMNS, recommendationRow, type RecRaw } from "./seo-board";

const PROMPT_TEXT_MAX = 300;
/** Citation rows read for the run's lane totals (cited-instead host per lane). */
const TOTALS_CITATION_CAP = 20_000;
/** Pages of the latest crawl compared by matchPrompt. */
const MATCH_PAGE_CAP = 2_000;

export const LIVE_GEO_LABELS = {
  apiSampled: "API-sampled answers; consumer apps may answer differently.",
  outcome:
    "Outcome per stored answer: cited = your site was cited; named = your brand was mentioned without a citation of your site; missing = neither; failed answers are not absences. Nothing is projected.",
  match: "Our best page: engine search queries matched to Search Console or crawled titles/H1s, else prompt-to-title/H1 overlap (a labelled heuristic).",
} as const;

// ------------------------------------------------------------------ cursor

export interface LiveGeoCursor {
  /** geo_observations rowid mark */
  o: number;
  /** recommendations rowid mark */
  r: number;
  /** rowids of answers sent with outcome null (analysis not stored yet), re-sent once analysed */
  p?: number[];
}

export function encodeLiveGeoCursor(c: LiveGeoCursor): string {
  return encodeLiveCursor(c.p && c.p.length > 0 ? { o: c.o, r: c.r, p: c.p } : { o: c.o, r: c.r });
}

/** 400 on anything malformed, including an SEO-feed or activity cursor. */
export function decodeLiveGeoCursor(raw: string | null | undefined): LiveGeoCursor | null {
  return decodeLiveCursor(raw, ["o", "r"] as const, [] as const, ["p"] as const);
}

// ------------------------------------------------------------------ rows

interface RunRow {
  id: string;
  agent: "seo" | "geo";
  status: string;
  trigger: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface ObsRaw {
  rid: number;
  id: string;
  provider: string;
  prompt_id: string | null;
  prompt_set_id: string | null;
  prompt_text: string;
  status: string;
  grounded: number;
  request_id: string | null;
  usage_json: string;
  cost_usd: number | null;
  cost_is_estimate: number;
  created_at: string;
  analysed: number;
  self_cited: number | null;
  self_mentioned: number | null;
}

/** Analysis subqueries match workspace AND project (same columns as runs/activity.ts). */
const OBS_COLUMNS = `o.rowid AS rid, o.id, o.provider, o.prompt_id, o.prompt_set_id, o.prompt_text, o.status, o.grounded, o.request_id, o.usage_json,
              o.cost_usd, o.cost_is_estimate, o.created_at,
              EXISTS (SELECT 1 FROM geo_brand_observations b WHERE b.observation_id = o.id AND b.workspace_id = o.workspace_id AND b.project_id = o.project_id) AS analysed,
              (SELECT MAX(b.cited) FROM geo_brand_observations b
                WHERE b.observation_id = o.id AND b.workspace_id = o.workspace_id AND b.project_id = o.project_id AND b.is_self = 1) AS self_cited,
              (SELECT MAX(b.mentioned) FROM geo_brand_observations b
                WHERE b.observation_id = o.id AND b.workspace_id = o.workspace_id AND b.project_id = o.project_id AND b.is_self = 1) AS self_mentioned`;

const outcomeOf = (o: Pick<ObsRaw, "status" | "analysed" | "self_cited" | "self_mentioned">) =>
  answerOutcome({ status: o.status, analysed: o.analysed === 1, selfCited: o.self_cited === 1, selfMentioned: o.self_mentioned === 1 });

/** Same rule as geo/board.ts: the provider exposes engine search queries for this answer. */
function searchQueriesExposed(usageJson: string): boolean {
  const u = parseJson<Record<string, unknown>>(usageJson, {});
  return u.searchQueriesExposed === true || Array.isArray(u.searchQueries);
}

const isLaneProvider = (p: string): p is BoardLaneProviderId => isGeoEngineId(p) || isCustomGeoId(p);
/** SQL form of isLaneProvider, so every answer read is shown (pages are never shortened after the merge). */
const LANE_PROVIDER_SQL = `(o.provider IN (${GEO_ENGINE_IDS.map(() => "?").join(", ")}) OR (substr(o.provider, 1, ${CUSTOM_GEO_PREFIX.length}) = ? AND length(o.provider) > ${CUSTOM_GEO_PREFIX.length}))`;
const LANE_PROVIDER_PARAMS = [...GEO_ENGINE_IDS, CUSTOM_GEO_PREFIX];
const SENTIMENTS = new Set<Sentiment>(["positive", "neutral", "negative", "mixed", "unknown"]);
const REC_STATUSES = new Set<RecommendationStatusInAnswer>(["recommended", "listed_neutral", "mentioned_negatively", "not_mentioned", "unknown"]);

type Payload = { kind: "obs"; o: ObsRaw } | { kind: "rec"; r: RecRaw };

// ------------------------------------------------------------------ builder

export interface BuildLiveGeoOptions {
  after?: LiveGeoCursor | null;
  limit?: number;
  now: Date;
}

/** Returns null when the run does not exist in this workspace + project; 400 agent_mismatch for an SEO run. */
export async function buildLiveGeo(db: Db, project: ProjectRow, runId: string, opts: BuildLiveGeoOptions): Promise<LiveGeoBoardResponse | null> {
  const ws = project.workspace_id;
  const pid = project.id;
  const run = await db.first<RunRow>(
    "SELECT id, agent, status, trigger, created_at, started_at, finished_at FROM agent_runs WHERE workspace_id = ? AND project_id = ? AND id = ? LIMIT 1",
    ws,
    pid,
    runId,
  );
  if (!run) return null;
  if (run.agent !== "geo") throw badRequest("This run is not a GEO run; use the SEO live feed.", { reason: "agent_mismatch" });
  const limit = Math.max(1, Math.min(opts.limit ?? LIVE_DEFAULT_LIMIT, LIVE_MAX_LIMIT));
  const cursor = opts.after ?? null;
  const from = { o: cursor?.o ?? 0, r: cursor?.r ?? 0 };
  const pendingFrom = uniq(cursor?.p ?? []).filter((rid) => rid <= from.o);
  const active = run.status === "pending" || run.status === "running";
  const nowMs = opts.now.getTime();

  const [obsRows, recRows, pendingRows] = await Promise.all([
    db.all<ObsRaw>(
      `SELECT ${OBS_COLUMNS} FROM geo_observations o
        WHERE o.workspace_id = ? AND o.project_id = ? AND o.run_id = ? AND o.measurement_type = 'api' AND o.rowid > ? AND ${LANE_PROVIDER_SQL}
        ORDER BY o.rowid LIMIT ?`,
      ws,
      pid,
      run.id,
      from.o,
      ...LANE_PROVIDER_PARAMS,
      limit,
    ),
    db.all<RecRaw>(
      `SELECT ${REC_COLUMNS} FROM recommendations WHERE workspace_id = ? AND project_id = ? AND run_id = ? AND rowid > ? ORDER BY rowid LIMIT ?`,
      ws,
      pid,
      run.id,
      from.r,
      limit,
    ),
    pendingFrom.length > 0
      ? db.all<ObsRaw>(
          `SELECT ${OBS_COLUMNS} FROM geo_observations o
            WHERE o.workspace_id = ? AND o.project_id = ? AND o.run_id = ? AND o.measurement_type = 'api' AND o.rowid IN (${pendingFrom.map(() => "?").join(", ")})
            LIMIT ${pendingFrom.length}`,
          ws,
          pid,
          run.id,
          ...pendingFrom,
        )
      : Promise.resolve([] as ObsRaw[]),
  ]);

  // While active, the observation source stops at the first 'ok' answer not analysed yet (for at most
  // OBS_HOLD_MS), so the answer is sent once, with its outcome.
  const stream: ObsRaw[] = [];
  for (const o of obsRows) {
    const age = nowMs - Date.parse(o.created_at);
    if (active && o.status === "ok" && o.analysed !== 1 && !(age >= OBS_HOLD_MS)) break;
    stream.push(o);
  }
  const merged = mergeMarked<"o" | "r", Payload>(
    {
      o: stream.map((o) => ({ rid: o.rid, at: o.created_at, id: `obs:${o.id}`, payload: { kind: "obs", o } })),
      r: recRows.map((r) => ({ rid: r.rid, at: r.created_at, id: `rec:${r.id}`, payload: { kind: "rec", r } })),
    },
    from,
    limit,
  );
  const takenObs = merged.taken.flatMap((x) => (x.entry.payload.kind === "obs" ? [x.entry.payload.o] : []));
  const takenRecs = merged.taken.flatMap((x) => (x.entry.payload.kind === "rec" ? [{ id: x.entry.id, r: x.entry.payload.r }] : []));
  // Answers sent earlier without an outcome: re-sent (same id) once their analysis is stored or they are no
  // longer 'ok'; still pending ones stay in the cursor.
  const resend = pendingRows.filter((o) => o.analysed === 1 || o.status !== "ok");
  const stillPending = pendingRows.filter((o) => o.status === "ok" && o.analysed !== 1).map((o) => o.rid);
  const newlyPending = takenObs.filter((o) => o.status === "ok" && o.analysed !== 1).map((o) => o.rid);
  const pending = uniq([...stillPending, ...newlyPending])
    .sort((a, b) => a - b)
    .slice(-CURSOR_LIST_MAX);

  const pendingSorted = [...pendingFrom].sort((a, b) => a - b);
  const samePending = pending.length === pendingSorted.length && pending.every((x, i) => x === pendingSorted[i]);
  const changed = merged.taken.length > 0 || resend.length > 0 || !samePending;
  const nextCursor = changed ? encodeLiveGeoCursor({ o: merged.marks.o, r: merged.marks.r, p: pending }) : cursor ? encodeLiveGeoCursor(cursor) : null;

  // ---------------------------------------------------------------- answers (this page only)
  const pageObs = [...takenObs, ...resend];
  const answers = await enrichAnswers(db, project, run.id, pageObs);
  answers.sort(compareAtId);
  const recommendations = takenRecs.map((x) => recommendationRow(x.id, x.r));
  recommendations.sort(compareAtId);

  // ---------------------------------------------------------------- totals, planned prompts, labels
  const [lanes, pipe, plannedPrompts] = await Promise.all([
    laneTotals(db, project, run.id),
    pipelineTotals(db, ws, pid, run.id),
    cursor ? Promise.resolve(null) : plannedPromptsOf(db, ws, pid, run.id, active),
  ]);

  const labels: string[] = [];
  if (project.is_demo === 1) labels.push(DEMO_LABEL);
  labels.push(LIVE_GEO_LABELS.apiSampled, LIVE_GEO_LABELS.outcome);
  if (answers.some((a) => a.matchedPage)) labels.push(LIVE_GEO_LABELS.match);
  const pendingTotal = lanes.lanes.reduce((a, l) => a + l.pending, 0);
  if (pendingTotal > 0) labels.push(`${pendingTotal} stored answer(s) are awaiting analysis; their outcome is not counted yet.`);
  if (lanes.lanes.some((l) => isCustomGeoId(l.provider))) labels.push(`Custom GEO engines: ${CUSTOM_GEO_NOTE}.`);
  const truncated = lanes.truncated || pipe.truncated;
  if (truncated) labels.push(`Totals are lower bounds: the run has more stored rows than a totals read covers (${ACTIVITY_OBSERVATION_CAP} answers).`);

  const startedMs = run.started_at ? Date.parse(run.started_at) : NaN;
  const endMs = run.finished_at ? Date.parse(run.finished_at) : active ? nowMs : NaN;
  const elapsedMs = Number.isFinite(startedMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startedMs) : null;
  const runOut: RunActivity["run"] = {
    id: run.id,
    agent: run.agent,
    status: run.status,
    trigger: run.trigger,
    createdAt: run.created_at,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    elapsedMs,
  };
  return {
    run: runOut,
    active,
    answers,
    plannedPrompts,
    recommendations,
    totals: { lanes: lanes.lanes, pipeline: pipe.pipeline, truncated },
    cursor: nextCursor,
    labels,
  };
}

// ------------------------------------------------------------------ answer enrichment

async function enrichAnswers(db: Db, project: ProjectRow, runId: string, obs: ObsRaw[]): Promise<LiveGeoAnswerRow[]> {
  if (obs.length === 0) return [];
  const ws = project.workspace_id;
  const pid = project.id;
  const ids = uniq(obs.map((o) => o.id));
  const requestIds = uniq(obs.map((o) => o.request_id).filter((r): r is string => !!r));
  const domains = selfDomains(project);
  const [brands, cits, queries, calls] = await Promise.all([
    inChunks(ids, (chunk, ph) =>
      db.all<{ observation_id: string; list_rank: number | null; sentiment: string; method: string; recommendation_status: string }>(
        `SELECT observation_id, list_rank, sentiment, method, recommendation_status FROM geo_brand_observations
          WHERE workspace_id = ? AND project_id = ? AND is_self = 1 AND observation_id IN (${ph}) ORDER BY rowid LIMIT ${chunk.length * 4}`,
        ws,
        pid,
        ...chunk,
      ),
    ),
    inChunks(ids, (chunk, ph) =>
      db.all<{ observation_id: string; url: string; title: string | null; position: number | null; source_type: string }>(
        `SELECT observation_id, url, title, position, source_type FROM geo_citations
          WHERE workspace_id = ? AND project_id = ? AND observation_id IN (${ph}) ORDER BY position IS NULL, position, rowid LIMIT ${chunk.length * 50}`,
        ws,
        pid,
        ...chunk,
      ),
    ),
    inChunks(ids, (chunk, ph) =>
      db.all<{ observation_id: string; query: string; normalized: string }>(
        `SELECT observation_id, query, normalized FROM geo_search_queries
          WHERE workspace_id = ? AND project_id = ? AND observation_id IN (${ph}) ORDER BY rowid LIMIT ${chunk.length * 50}`,
        ws,
        pid,
        ...chunk,
      ),
    ),
    requestIds.length > 0
      ? inChunks(requestIds, (chunk, ph) =>
          db.all<{ request_id: string; latency_ms: number | null }>(
            `SELECT request_id, latency_ms FROM provider_calls
              WHERE workspace_id = ? AND project_id = ? AND run_id = ? AND purpose LIKE 'geo_answer%' AND request_id IN (${ph})
              ORDER BY rowid LIMIT ${chunk.length * 2}`,
            ws,
            pid,
            runId,
            ...chunk,
          ),
        )
      : Promise.resolve([] as Array<{ request_id: string; latency_ms: number | null }>),
  ]);
  const brandOf = new Map<string, (typeof brands)[number]>();
  for (const b of brands) if (!brandOf.has(b.observation_id)) brandOf.set(b.observation_id, b);
  const citesOf = new Map<string, ReturnType<typeof resolveCitation>[]>();
  for (const row of cits) {
    const c = resolveCitation(row, domains);
    const list = citesOf.get(c.observationId) ?? [];
    list.push(c);
    citesOf.set(c.observationId, list);
  }
  const queryCount = new Map<string, number>();
  for (const q of queries) queryCount.set(q.observation_id, (queryCount.get(q.observation_id) ?? 0) + 1);
  const queriesOf = new Map<string, string[]>();
  for (const q of queries) {
    const n = normalizeQuery(q.normalized || q.query);
    if (!n) continue;
    const list = queriesOf.get(q.observation_id) ?? [];
    if (!list.includes(n)) list.push(n);
    queriesOf.set(q.observation_id, list);
  }
  const latencyOf = new Map<string, number | null>();
  for (const c of calls) latencyOf.set(c.request_id, c.latency_ms);

  const match = await matcher(db, project, uniq([...queriesOf.values()].flat()));

  return obs.map((o) => {
    const b = brandOf.get(o.id);
    const list = citesOf.get(o.id) ?? [];
    const other = list.find((c) => !c.self && c.host);
    const own = list.find((c) => c.self);
    const engineQueries = queriesOf.get(o.id) ?? [];
    const m = o.status === "ok" ? match(o.prompt_text, engineQueries) : null;
    const sentiment = b && SENTIMENTS.has(b.sentiment as Sentiment) ? { value: b.sentiment as Sentiment, method: clip(b.method, 60) } : null;
    return {
      id: `obs:${o.id}`,
      observationId: o.id,
      at: o.created_at,
      provider: o.provider as BoardLaneProviderId,
      promptId: o.prompt_id,
      promptText: clip(o.prompt_text, PROMPT_TEXT_MAX),
      outcome: outcomeOf(o),
      grounded: o.grounded === 1,
      latencyMs: o.request_id ? (latencyOf.get(o.request_id) ?? null) : null,
      cost: { value: o.cost_usd, isEstimate: o.cost_usd === null ? true : o.cost_is_estimate === 1 },
      // list_rank is stored only for a real ordered list.
      position: b?.list_rank ?? null,
      sentiment,
      recommendationStatus: b && REC_STATUSES.has(b.recommendation_status as RecommendationStatusInAnswer) ? (b.recommendation_status as RecommendationStatusInAnswer) : null,
      citedInstead: other ? { host: other.host!, url: other.url ? clip(other.url, 300) : null, sourceType: other.sourceType } : null,
      ownCitedUrl: own ? clip(own.url, 300) : null,
      citationCount: list.length,
      // Stored engine search queries; 0 when the provider exposes them and there were none; null when not exposed.
      searchQueryCount: queryCount.get(o.id) ?? (searchQueriesExposed(o.usage_json) ? 0 : null),
      matchedPage: m ? { pageId: m.page.pageId, url: m.page.url, method: m.method, score: m.score } : null,
    };
  });
}

/**
 * Our best page for a prompt: coverage/answer-coverage.ts matchPrompt over the latest completed crawl of a
 * verified site (titles/H1s) and the latest usable sync's query+page rows for the given engine queries.
 * Loaded once per request, only when the page has answers.
 */
async function matcher(db: Db, project: ProjectRow, engineQueries: string[]): Promise<(promptText: string, queries: string[]) => ReturnType<typeof matchPrompt>> {
  const ws = project.workspace_id;
  const pid = project.id;
  const brand = brandTokenSet(project);
  const pages: CandidatePage[] = [];
  if (project.verified_host || project.is_demo === 1) {
    const crawl = await db.first<{ id: string }>(
      "SELECT id FROM crawl_runs WHERE workspace_id = ? AND project_id = ? AND status IN ('completed', 'partial') ORDER BY started_at DESC, rowid DESC LIMIT 1",
      ws,
      pid,
    );
    if (crawl) {
      const rows = await db.all<{ page_id: string; url: string; status_code: number | null; skipped_reason: string | null; final_url: string | null; title: string | null; h1_json: string }>(
        `SELECT s.page_id, p.url, s.status_code, s.skipped_reason, s.final_url, s.title, s.h1_json
           FROM page_snapshots s JOIN pages p ON p.id = s.page_id AND p.workspace_id = s.workspace_id AND p.project_id = s.project_id
          WHERE s.workspace_id = ? AND s.project_id = ? AND s.crawl_run_id = ?
          ORDER BY p.url, s.fetched_at DESC, s.rowid DESC LIMIT ${MATCH_PAGE_CAP}`,
        ws,
        pid,
        crawl.id,
      );
      const seen = new Set<string>();
      for (const r of rows) {
        if (seen.has(r.page_id)) continue;
        seen.add(r.page_id);
        if (!isAnalyzable({ statusCode: r.status_code, skippedReason: r.skipped_reason, finalUrl: r.final_url, url: r.url })) continue;
        const key = pageKey(r.url);
        if (!key) continue;
        const h1s = parseJson<unknown[]>(r.h1_json, []).filter((h): h is string => typeof h === "string");
        pages.push({ pageId: r.page_id, url: r.url, key, tokens: contentTokens([r.title ?? "", ...h1s].join(" "), brand) });
      }
    }
  }
  let gsc: GscPageData | null = null;
  if (engineQueries.length > 0) {
    const sync = await latestUsableSync(db, ws, pid);
    if (sync) {
      const rows = await inChunks(engineQueries, (chunk, ph) =>
        db.all<{ query: string; page: string; impressions: number; clicks: number }>(
          `SELECT query, page, SUM(impressions) AS impressions, SUM(clicks) AS clicks FROM gsc_metrics
            WHERE workspace_id = ? AND project_id = ? AND sync_id = ? AND window = 'current' AND device IS NULL AND page IS NOT NULL AND query IN (${ph})
            GROUP BY query, page LIMIT ${chunk.length * 50}`,
          ws,
          pid,
          sync.id,
          ...chunk,
        ),
      );
      const queryPages = new Map<string, Map<string, { url: string; impressions: number; clicks: number }>>();
      for (const r of rows) {
        const q = normalizeQuery(r.query);
        const k = pageKey(r.page);
        if (!q || !k) continue;
        const byPage = queryPages.get(q) ?? new Map<string, { url: string; impressions: number; clicks: number }>();
        const cur = byPage.get(k) ?? { url: r.page, impressions: 0, clicks: 0 };
        cur.impressions += r.impressions;
        cur.clicks += r.clicks;
        byPage.set(k, cur);
        queryPages.set(q, byPage);
      }
      gsc = { window: { start: sync.window_start, end: sync.window_end }, source: sync.source, truncated: sync.truncated === 1, totals: null, pages: new Map(), queryPages };
    }
  }
  return (promptText, queries) => matchPrompt(promptText, queries, gsc, pages, brand);
}

// ------------------------------------------------------------------ totals

/** One entry per provider with answers in the run (board order, then custom lanes), over at most ACTIVITY_OBSERVATION_CAP answers. */
async function laneTotals(db: Db, project: ProjectRow, runId: string): Promise<{ lanes: LiveGeoLaneTotals[]; truncated: boolean }> {
  const ws = project.workspace_id;
  const pid = project.id;
  const [obs, cits] = await Promise.all([
    db.all<Pick<ObsRaw, "id" | "provider" | "status" | "cost_usd" | "cost_is_estimate" | "analysed" | "self_cited" | "self_mentioned">>(
      `SELECT o.id, o.provider, o.status, o.cost_usd, o.cost_is_estimate,
              EXISTS (SELECT 1 FROM geo_brand_observations b WHERE b.observation_id = o.id AND b.workspace_id = o.workspace_id AND b.project_id = o.project_id) AS analysed,
              (SELECT MAX(b.cited) FROM geo_brand_observations b
                WHERE b.observation_id = o.id AND b.workspace_id = o.workspace_id AND b.project_id = o.project_id AND b.is_self = 1) AS self_cited,
              (SELECT MAX(b.mentioned) FROM geo_brand_observations b
                WHERE b.observation_id = o.id AND b.workspace_id = o.workspace_id AND b.project_id = o.project_id AND b.is_self = 1) AS self_mentioned
         FROM geo_observations o
        WHERE o.workspace_id = ? AND o.project_id = ? AND o.run_id = ? AND o.measurement_type = 'api'
        ORDER BY o.created_at, o.id LIMIT ${ACTIVITY_OBSERVATION_CAP}`,
      ws,
      pid,
      runId,
    ),
    db.all<{ observation_id: string; url: string; title: string | null; position: number | null; source_type: string }>(
      `SELECT c.observation_id, c.url, c.title, c.position, c.source_type
         FROM geo_citations c
         JOIN geo_observations o ON o.id = c.observation_id AND o.workspace_id = c.workspace_id AND o.project_id = c.project_id
        WHERE c.workspace_id = ? AND c.project_id = ? AND o.run_id = ? AND o.measurement_type = 'api'
        ORDER BY c.observation_id, c.position IS NULL, c.position, c.rowid LIMIT ${TOTALS_CITATION_CAP}`,
      ws,
      pid,
      runId,
    ),
  ]);
  const domains = selfDomains(project);
  const firstOther = new Map<string, { host: string; sourceType: SourceType }>();
  for (const row of cits) {
    if (firstOther.has(row.observation_id)) continue;
    const c = resolveCitation(row, domains);
    if (!c.self && c.host) firstOther.set(row.observation_id, { host: c.host, sourceType: c.sourceType });
  }
  const byProvider = new Map<string, typeof obs>();
  for (const o of obs) {
    if (!isLaneProvider(o.provider)) continue;
    const list = byProvider.get(o.provider) ?? [];
    list.push(o);
    byProvider.set(o.provider, list);
  }
  const order = [...BOARD_LANES.filter((p) => byProvider.has(p)), ...[...byProvider.keys()].filter(isCustomGeoId).sort()];
  const lanes = order.map((provider): LiveGeoLaneTotals => {
    const rows = byProvider.get(provider)!;
    const t: LiveGeoLaneTotals = { provider: provider as BoardLaneProviderId, cited: 0, named: 0, missing: 0, failed: 0, pending: 0, cost: laneCost(rows) as CostUsd, citedInstead: null };
    const hosts = new Map<string, { answers: number; sourceType: SourceType }>();
    for (const o of rows) {
      const out = outcomeOf(o);
      if (out === null) t.pending++;
      else t[out]++;
      if (out === "missing" || out === "named") {
        const h = firstOther.get(o.id);
        if (h) {
          const cur = hosts.get(h.host) ?? { answers: 0, sourceType: h.sourceType };
          cur.answers++;
          hosts.set(h.host, cur);
        }
      }
    }
    let best: [string, { answers: number; sourceType: SourceType }] | null = null;
    for (const e of hosts) if (!best || e[1].answers > best[1].answers || (e[1].answers === best[1].answers && e[0] < best[0])) best = e;
    if (best) t.citedInstead = { host: best[0], sourceType: best[1].sourceType, answers: best[1].answers };
    return t;
  });
  return { lanes, truncated: obs.length >= ACTIVITY_OBSERVATION_CAP || cits.length >= TOTALS_CITATION_CAP };
}

/**
 * Prompts the run samples: the same selection as geo/batch.ts and the activity lanes (approved prompts of the
 * run's prompt set by position, capped per run; the active set while the run has no answer yet). Null when
 * unknown.
 */
async function plannedPromptsOf(db: Db, ws: string, pid: string, runId: string, active: boolean): Promise<Array<{ promptId: string; text: string }> | null> {
  const first = await db.first<{ prompt_set_id: string | null }>(
    `SELECT prompt_set_id FROM geo_observations WHERE workspace_id = ? AND project_id = ? AND run_id = ? AND measurement_type = 'api' AND prompt_set_id IS NOT NULL
      ORDER BY created_at, rowid LIMIT 1`,
    ws,
    pid,
    runId,
  );
  let setId = first?.prompt_set_id ?? null;
  if (!setId && active) {
    const set = await db.first<{ id: string }>(
      "SELECT id FROM geo_prompt_sets WHERE workspace_id = ? AND project_id = ? AND active = 1 ORDER BY version DESC LIMIT 1",
      ws,
      pid,
    );
    setId = set?.id ?? null;
  }
  if (!setId) return null;
  const limits = await db.first<{ geo_prompts_per_run: number }>("SELECT geo_prompts_per_run FROM project_limits WHERE workspace_id = ? AND project_id = ? LIMIT 1", ws, pid);
  const cap = limits?.geo_prompts_per_run ?? DEFAULT_PROMPTS_PER_RUN;
  if (cap <= 0) return [];
  const rows = await db.all<{ id: string; text: string }>(
    "SELECT id, text FROM geo_prompts WHERE workspace_id = ? AND project_id = ? AND prompt_set_id = ? AND approved = 1 ORDER BY position ASC, id ASC LIMIT ?",
    ws,
    pid,
    setId,
    Math.min(cap, 200),
  );
  return rows.map((r) => ({ promptId: r.id, text: clip(r.text, PROMPT_TEXT_MAX) }));
}
