/**
 * Run activity window (docs/api.md "Run activity"). A read model over the STORED rows of one run, so
 * the UI can show work as it happens (and replay a finished run) without simulating anything:
 *
 *   run_events          -> kind "step"           (id "evt:<id>",  at = created_at)
 *   page_snapshots      -> kind "page_read"      (id "snap:<id>", at = fetched_at; via crawl_runs.run_id + pages)
 *   geo_observations    -> kind "engine_answer"  (id "obs:<id>",  at = created_at; outcome from analysis rows)
 *   decision_records    -> kind "jev_decision"   (id "dec:<id>",  at = created_at; outcome = stored tier)
 *   provider_calls      -> kind "provider_call"  (id "call:<id>", at = created_at; geo_answer calls are folded
 *                                                 into their engine_answer item and not listed twice)
 *
 * Paging: items are ordered by (at, id). The cursor encodes the last (at, id) returned; each source selects
 * only rows with (at, prefixed id) > cursor, ordered and LIMITed, then the sources are merge-sorted and cut
 * to `limit`. Totals, lanes and queued pairs are always computed over the whole run.
 *
 * Rules: every query filters workspace_id AND project_id (plus run_id); every source query has a LIMIT;
 * dynamic IN lists are chunked below D1's 100 bound parameters; unknown cost stays null (never $0);
 * no aggregated score and no projections. Untrusted text (prompts, errors, URLs) is clipped plain text.
 */
import type {
  ActivityItem,
  ActivityLane,
  ActivityQueuedItem,
  GeoEngineProviderId,
  RunActivity,
} from "@shared/types";
import type { Db } from "../lib/db";
import { badRequest } from "../lib/errors";
import type { ProjectRow } from "../platform/access";
import { clip, inChunks } from "../coverage/common";
import { resolveCitation } from "../coverage/geo-data";
import { selfDomains } from "../geo/detect";
import { BOARD_LANES, LANE_LABELS } from "../geo/board";
import { isGeoEngineId } from "../geo/engines";

export const ACTIVITY_DEFAULT_LIMIT = 80;
export const ACTIVITY_MAX_LIMIT = 200;
export const ACTIVITY_QUEUED_MAX = 12;
/** Cap on the run's observations read for totals/lanes (a run samples at most prompts-per-run x engines). */
export const ACTIVITY_OBSERVATION_CAP = 2000;
const TITLE_MAX = 160;
const DETAIL_MAX = 200;

const ENGINE_NAME: Record<string, string> = { gemini: "Gemini", perplexity: "Perplexity", openai_geo: "OpenAI", anthropic_geo: "Anthropic" };
const TERMINAL_STEP = new Set(["completed", "failed", "partial", "skipped"]);

// ------------------------------------------------------------------ outcome of one engine answer

export type AnswerOutcome = "cited" | "named" | "missing" | "failed";

/**
 * Outcome of one stored engine answer, with the AI engine board's definition (geo/board.ts feed status):
 * cited = the brand's own site was cited (self brand row cited=1); named = the brand was mentioned but its
 * site not cited; missing = neither. Failed and incomplete answers are "failed" (never counted as absences).
 * An 'ok' answer without analysis rows yet returns null: it is pending, not an absence.
 */
export function answerOutcome(o: { status: string; analysed: boolean; selfCited: boolean; selfMentioned: boolean }): AnswerOutcome | null {
  if (o.status !== "ok") return "failed";
  if (!o.analysed) return null;
  if (o.selfCited) return "cited";
  if (o.selfMentioned) return "named";
  return "missing";
}

// ------------------------------------------------------------------ cursor

export interface ActivityCursor {
  at: string;
  id: string;
}

const CURSOR_ID = /^(evt|snap|obs|dec|call):[A-Za-z0-9_.-]{1,120}$/;
const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T[0-9:.]{5,18}Z$/;

export function encodeCursor(c: ActivityCursor): string {
  return btoa(`${c.at}|${c.id}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decodes an opaque cursor; throws 400 on anything malformed. */
export function decodeCursor(raw: string | null | undefined): ActivityCursor | null {
  if (raw === null || raw === undefined || raw === "") return null;
  let text: string;
  try {
    if (raw.length > 400 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error("bad");
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    text = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  } catch {
    throw badRequest("Invalid activity cursor.");
  }
  const sep = text.indexOf("|");
  const at = sep > 0 ? text.slice(0, sep) : "";
  const id = sep > 0 ? text.slice(sep + 1) : "";
  if (!CURSOR_AT.test(at) || !CURSOR_ID.test(id)) throw badRequest("Invalid activity cursor.");
  return { at, id };
}

export function parseLimit(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw === "") return ACTIVITY_DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw badRequest("limit must be a positive integer.");
  return Math.min(n, ACTIVITY_MAX_LIMIT);
}

function itemKey(i: { at: string; id: string }): [string, string] {
  return [i.at, i.id];
}

function compareItems(a: { at: string; id: string }, b: { at: string; id: string }): number {
  const [aa, ai] = itemKey(a);
  const [ba, bi] = itemKey(b);
  if (aa !== ba) return aa < ba ? -1 : 1;
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}

function afterCursor(item: { at: string; id: string }, c: ActivityCursor | null): boolean {
  return c === null || compareItems(item, c) > 0;
}

// ------------------------------------------------------------------ rows

interface RunRowLite {
  id: string;
  agent: "seo" | "geo";
  status: string;
  trigger: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface EventRow {
  id: string;
  step: string;
  status: string;
  message: string;
  created_at: string;
}

interface SnapRow {
  id: string;
  status_code: number | null;
  skipped_reason: string | null;
  word_count: number | null;
  created_at: string;
  url: string;
}

interface ObsRow {
  id: string;
  provider: string;
  prompt_id: string | null;
  prompt_set_id: string | null;
  prompt_text: string;
  status: string;
  grounded: number;
  request_id: string | null;
  cost_usd: number | null;
  cost_is_estimate: number;
  error: string | null;
  created_at: string;
  analysed: number;
  self_cited: number | null;
  self_mentioned: number | null;
}

interface DecisionRow {
  id: string;
  agent: "seo" | "geo";
  candidate_key: string;
  question_id: string | null;
  provider: string | null;
  tier: string | null;
  outcome: string;
  reason_code: string | null;
  created_at: string;
}

interface CallRow {
  id: string;
  provider: string;
  model: string | null;
  purpose: string;
  status: string;
  cost_usd: number | null;
  cost_is_estimate: number;
  latency_ms: number | null;
  error: string | null;
  created_at: string;
}

const CURSOR_SQL = (col: string, prefix: string, idCol: string) => `(${col} > ? OR (${col} = ? AND ('${prefix}:' || ${idCol}) > ?))`;

function cursorParams(c: ActivityCursor | null): [string, string, string] {
  // An empty cursor matches every stored row (ISO timestamps are non-empty).
  return c ? [c.at, c.at, c.id] : ["", "", ""];
}

// ------------------------------------------------------------------ item mapping

function stepItem(r: EventRow, agent: "seo" | "geo"): ActivityItem {
  const provider = r.step.startsWith("geo_batch:") ? r.step.slice("geo_batch:".length) || null : null;
  const status: ActivityItem["status"] =
    r.status === "failed" ? "error" : r.status === "partial" || r.status === "skipped" ? "warn" : r.status === "completed" ? "ok" : "info";
  return {
    id: `evt:${r.id}`,
    at: r.created_at,
    kind: "step",
    agent,
    title: clip(r.message, TITLE_MAX) || r.step,
    detail: clip(`${r.step} · ${r.status}`, DETAIL_MAX),
    status,
    provider,
    latencyMs: null,
    costUsd: null,
    costIsEstimate: false,
    url: null,
    outcome: null,
  };
}

function snapItem(r: SnapRow): ActivityItem {
  let detail: string;
  let status: ActivityItem["status"];
  if (r.skipped_reason) {
    detail = `Skipped: ${r.skipped_reason}`;
    status = "warn";
  } else {
    const code = r.status_code === null ? "no status" : String(r.status_code);
    detail = r.word_count === null ? code : `${code} · ${r.word_count.toLocaleString("en-US")} words`;
    status = r.status_code !== null && r.status_code >= 400 ? "error" : r.status_code === null ? "warn" : "ok";
  }
  return {
    id: `snap:${r.id}`,
    at: r.created_at,
    kind: "page_read",
    agent: "seo",
    title: clip(`Read ${r.url}`, TITLE_MAX),
    detail,
    status,
    provider: "crawler",
    latencyMs: null,
    costUsd: null,
    costIsEstimate: false,
    url: r.url,
    outcome: null,
  };
}

interface CitationInfo {
  selfHost: string | null;
  otherHost: string | null;
  count: number;
}

function obsItem(r: ObsRow, cites: CitationInfo | undefined, latencyMs: number | null): ActivityItem {
  const outcome = answerOutcome({ status: r.status, analysed: r.analysed === 1, selfCited: r.self_cited === 1, selfMentioned: r.self_mentioned === 1 });
  const engine = ENGINE_NAME[r.provider] ?? r.provider;
  const prompt = clip(r.prompt_text, TITLE_MAX);
  const verb = outcome === "failed" ? (r.status === "incomplete" ? "returned an incomplete answer" : "failed") : "answered";
  const title = clip(`${engine} ${verb}: "${prompt}"`, TITLE_MAX);
  let detail: string;
  let status: ActivityItem["status"];
  switch (outcome) {
    case "cited":
      detail = cites?.selfHost ? `Cited · ${cites.selfHost}` : "Cited";
      status = "ok";
      break;
    case "named":
      detail = cites?.otherHost ? `Named · not cited; cited instead: ${cites.otherHost}` : "Named · not cited";
      status = "info";
      break;
    case "missing":
      detail = cites?.otherHost ? `Missing · cited instead: ${cites.otherHost}` : r.grounded === 1 ? "Missing" : "Missing · no sources cited";
      status = "warn";
      break;
    case "failed":
      detail = r.status === "incomplete" ? "Incomplete answer" : r.error ? `Failed · ${clip(r.error, 160)}` : "Failed";
      status = "error";
      break;
    default:
      detail = "Answer stored · awaiting analysis";
      status = "info";
  }
  return {
    id: `obs:${r.id}`,
    at: r.created_at,
    kind: "engine_answer",
    agent: "geo",
    title,
    detail: clip(detail, DETAIL_MAX),
    status,
    provider: r.provider,
    latencyMs,
    costUsd: r.cost_usd,
    costIsEstimate: r.cost_usd === null ? true : r.cost_is_estimate === 1,
    url: null,
    outcome,
  };
}

function decisionItem(r: DecisionRow): ActivityItem {
  const tier = r.tier === "act" || r.tier === "flag" || r.tier === "drop" ? r.tier : null;
  const parts = [tier ?? r.tier ?? "no tier", r.question_id ?? null, r.outcome === "rejected" ? `rejected${r.reason_code ? ` (${r.reason_code})` : ""}` : null].filter(
    (x): x is string => !!x,
  );
  return {
    id: `dec:${r.id}`,
    at: r.created_at,
    kind: "jev_decision",
    agent: r.agent,
    title: clip(`Jev ${tier ?? "decision"}: ${r.candidate_key}`, TITLE_MAX),
    detail: clip(parts.join(" · "), DETAIL_MAX),
    status: tier === "act" ? "ok" : tier === "flag" ? "warn" : "info",
    provider: r.provider,
    latencyMs: null,
    costUsd: null,
    costIsEstimate: false,
    url: null,
    outcome: tier,
  };
}

function callItem(r: CallRow, agent: "seo" | "geo"): ActivityItem {
  const status: ActivityItem["status"] = r.status === "ok" ? "ok" : r.status === "unknown" ? "warn" : "error";
  const detail = [r.status, r.model, r.error ? clip(r.error, 120) : null].filter((x): x is string => !!x).join(" · ");
  return {
    id: `call:${r.id}`,
    at: r.created_at,
    kind: "provider_call",
    agent,
    title: clip(`${r.provider} call · ${r.purpose}`, TITLE_MAX),
    detail: clip(detail, DETAIL_MAX),
    status,
    provider: r.provider,
    latencyMs: r.latency_ms,
    costUsd: r.cost_usd,
    costIsEstimate: r.cost_usd === null ? true : r.cost_is_estimate === 1,
    url: null,
    outcome: null,
  };
}

// ------------------------------------------------------------------ builder

export interface BuildActivityOptions {
  after?: ActivityCursor | null;
  limit?: number;
  now: Date;
  /** GEO engines configured for the workspace now (presence only); used for lanes of an active run. */
  configuredEngines?: readonly GeoEngineProviderId[];
}

/** Returns null when the run does not exist in this workspace + project. */
export async function buildRunActivity(db: Db, project: ProjectRow, runId: string, opts: BuildActivityOptions): Promise<RunActivity | null> {
  const ws = project.workspace_id;
  const pid = project.id;
  const run = await db.first<RunRowLite>(
    "SELECT id, agent, status, trigger, created_at, started_at, finished_at FROM agent_runs WHERE workspace_id = ? AND project_id = ? AND id = ?",
    ws,
    pid,
    runId,
  );
  if (!run) return null;
  const limit = Math.max(1, Math.min(opts.limit ?? ACTIVITY_DEFAULT_LIMIT, ACTIVITY_MAX_LIMIT));
  const cursor = opts.after ?? null;
  const cp = cursorParams(cursor);
  const active = run.status === "pending" || run.status === "running";
  const isGeo = run.agent === "geo";

  const [events, snaps, obs, decisions, calls, answerCalls, spendRow, decisionCounts, crawl, pagesReadRow, laneEvents] = await Promise.all([
    db.all<EventRow>(
      `SELECT id, step, status, message, created_at FROM run_events
        WHERE workspace_id = ? AND project_id = ? AND run_id = ? AND ${CURSOR_SQL("created_at", "evt", "id")}
        ORDER BY created_at, id LIMIT ?`,
      ws,
      pid,
      run.id,
      ...cp,
      limit,
    ),
    db.all<SnapRow>(
      `SELECT s.id, s.status_code, s.skipped_reason, s.word_count, s.fetched_at AS created_at, p.url
         FROM page_snapshots s
         JOIN crawl_runs c ON c.id = s.crawl_run_id AND c.workspace_id = s.workspace_id AND c.project_id = s.project_id
         JOIN pages p ON p.id = s.page_id AND p.workspace_id = s.workspace_id AND p.project_id = s.project_id
        WHERE s.workspace_id = ? AND s.project_id = ? AND c.run_id = ? AND ${CURSOR_SQL("s.fetched_at", "snap", "s.id")}
        ORDER BY s.fetched_at, s.id LIMIT ?`,
      ws,
      pid,
      run.id,
      ...cp,
      limit,
    ),
    // Every observation of the run (bounded): items, answer totals, lanes and queued pairs share it.
    db.all<ObsRow>(
      `SELECT o.id, o.provider, o.prompt_id, o.prompt_set_id, o.prompt_text, o.status, o.grounded, o.request_id, o.cost_usd, o.cost_is_estimate,
              o.error, o.created_at,
              EXISTS (SELECT 1 FROM geo_brand_observations b WHERE b.observation_id = o.id AND b.workspace_id = o.workspace_id) AS analysed,
              (SELECT MAX(b.cited) FROM geo_brand_observations b WHERE b.observation_id = o.id AND b.workspace_id = o.workspace_id AND b.is_self = 1) AS self_cited,
              (SELECT MAX(b.mentioned) FROM geo_brand_observations b WHERE b.observation_id = o.id AND b.workspace_id = o.workspace_id AND b.is_self = 1) AS self_mentioned
         FROM geo_observations o
        WHERE o.workspace_id = ? AND o.project_id = ? AND o.run_id = ?
        ORDER BY o.created_at, o.id LIMIT ${ACTIVITY_OBSERVATION_CAP}`,
      ws,
      pid,
      run.id,
    ),
    db.all<DecisionRow>(
      `SELECT id, agent, candidate_key, question_id, provider, tier, outcome, reason_code, created_at FROM decision_records
        WHERE workspace_id = ? AND project_id = ? AND run_id = ? AND ${CURSOR_SQL("created_at", "dec", "id")}
        ORDER BY created_at, id LIMIT ?`,
      ws,
      pid,
      run.id,
      ...cp,
      limit,
    ),
    db.all<CallRow>(
      `SELECT id, provider, model, purpose, status, cost_usd, cost_is_estimate, latency_ms, error, created_at FROM provider_calls
        WHERE workspace_id = ? AND project_id = ? AND run_id = ? AND purpose NOT LIKE 'geo_answer%' AND ${CURSOR_SQL("created_at", "call", "id")}
        ORDER BY created_at, id LIMIT ?`,
      ws,
      pid,
      run.id,
      ...cp,
      limit,
    ),
    // Engine-answer calls: latency per request id (folded into engine_answer items and lanes).
    db.all<{ request_id: string; provider: string; latency_ms: number | null }>(
      `SELECT request_id, provider, latency_ms FROM provider_calls
        WHERE workspace_id = ? AND project_id = ? AND run_id = ? AND purpose LIKE 'geo_answer%' AND request_id IS NOT NULL
        ORDER BY created_at, id LIMIT ${ACTIVITY_OBSERVATION_CAP}`,
      ws,
      pid,
      run.id,
    ),
    db.first<{ n: number; priced: number; usd: number | null; unknown_n: number; est_n: number }>(
      `SELECT COUNT(*) AS n, COUNT(cost_usd) AS priced, SUM(cost_usd) AS usd,
              SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unknown_n,
              SUM(CASE WHEN cost_usd IS NOT NULL AND cost_is_estimate = 1 THEN 1 ELSE 0 END) AS est_n
         FROM provider_calls WHERE workspace_id = ? AND project_id = ? AND run_id = ?`,
      ws,
      pid,
      run.id,
    ),
    db.all<{ tier: string | null; n: number }>(
      "SELECT tier, COUNT(*) AS n FROM decision_records WHERE workspace_id = ? AND project_id = ? AND run_id = ? GROUP BY tier LIMIT 10",
      ws,
      pid,
      run.id,
    ),
    db.first<{ id: string; status: string; pages_limit: number }>(
      "SELECT id, status, pages_limit FROM crawl_runs WHERE workspace_id = ? AND project_id = ? AND run_id = ? ORDER BY started_at DESC, id DESC LIMIT 1",
      ws,
      pid,
      run.id,
    ),
    db.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM page_snapshots s JOIN crawl_runs c ON c.id = s.crawl_run_id AND c.workspace_id = s.workspace_id
        WHERE s.workspace_id = ? AND s.project_id = ? AND c.run_id = ? AND s.skipped_reason IS NULL`,
      ws,
      pid,
      run.id,
    ),
    isGeo
      ? db.all<{ step: string; status: string }>(
          `SELECT step, status FROM run_events WHERE workspace_id = ? AND project_id = ? AND run_id = ? AND (step LIKE 'geo_batch:%' OR step = 'geo.batch')
            ORDER BY created_at, id LIMIT 200`,
          ws,
          pid,
          run.id,
        )
      : Promise.resolve([] as Array<{ step: string; status: string }>),
  ]);

  const latencyByRequest = new Map<string, number | null>();
  for (const c of answerCalls) latencyByRequest.set(c.request_id, c.latency_ms);
  const latencyOf = (o: ObsRow) => (o.request_id ? (latencyByRequest.get(o.request_id) ?? null) : null);

  // ---------------------------------------------------------------- items (merge of all sources)
  const pageObs = obs.filter((o) => afterCursor({ at: o.created_at, id: `obs:${o.id}` }, cursor)).slice(0, limit);
  const citeInfo = new Map<string, CitationInfo>();
  const okIds = pageObs.filter((o) => o.status === "ok").map((o) => o.id);
  if (okIds.length > 0) {
    const domains = selfDomains(project);
    const cits = await inChunks(okIds, (chunk, ph) =>
      db.all<{ observation_id: string; url: string; title: string | null; position: number | null; source_type: string }>(
        `SELECT observation_id, url, title, position, source_type FROM geo_citations
          WHERE workspace_id = ? AND project_id = ? AND observation_id IN (${ph}) ORDER BY position IS NULL, position, rowid LIMIT 2000`,
        ws,
        pid,
        ...chunk,
      ),
    );
    for (const row of cits) {
      const c = resolveCitation(row, domains);
      const info = citeInfo.get(c.observationId) ?? { selfHost: null, otherHost: null, count: 0 };
      info.count++;
      if (c.self && c.host && !info.selfHost) info.selfHost = c.host;
      if (!c.self && c.host && !info.otherHost) info.otherHost = c.host;
      citeInfo.set(c.observationId, info);
    }
  }

  const merged: ActivityItem[] = [
    ...events.map((e) => stepItem(e, run.agent)),
    ...snaps.map(snapItem),
    ...pageObs.map((o) => obsItem(o, citeInfo.get(o.id), latencyOf(o))),
    ...decisions.map(decisionItem),
    ...calls.map((c) => callItem(c, run.agent)),
  ].filter((i) => afterCursor(i, cursor));
  merged.sort(compareItems);
  const items = merged.slice(0, limit);
  const last = items[items.length - 1];
  const nextCursor = last ? encodeCursor({ at: last.at, id: last.id }) : cursor ? encodeCursor(cursor) : null;

  // ---------------------------------------------------------------- totals
  const answers = { cited: 0, named: 0, missing: 0, failed: 0 };
  for (const o of obs) {
    const out = answerOutcome({ status: o.status, analysed: o.analysed === 1, selfCited: o.self_cited === 1, selfMentioned: o.self_mentioned === 1 });
    if (out) answers[out]++;
  }
  const decisionTotals = { act: 0, flag: 0, drop: 0 };
  for (const d of decisionCounts) if (d.tier === "act" || d.tier === "flag" || d.tier === "drop") decisionTotals[d.tier] += d.n;
  const callsN = spendRow?.n ?? 0;
  const priced = spendRow?.priced ?? 0;
  const spend: RunActivity["totals"]["spend"] = {
    // No calls -> nothing spent ($0 actual); calls but none priced -> unknown (null), never $0.
    usd: callsN === 0 ? 0 : priced === 0 ? null : Math.round((spendRow?.usd ?? 0) * 1e6) / 1e6,
    isEstimate: (spendRow?.est_n ?? 0) > 0,
    unknownCalls: spendRow?.unknown_n ?? 0,
  };

  // ---------------------------------------------------------------- now reading (crawl step active)
  let nowReading: RunActivity["nowReading"] = null;
  if (active && crawl && crawl.status === "running") {
    const latest = await db.first<{ url: string; at: string }>(
      `SELECT p.url, s.fetched_at AS at FROM page_snapshots s JOIN pages p ON p.id = s.page_id AND p.workspace_id = s.workspace_id
        WHERE s.workspace_id = ? AND s.project_id = ? AND s.crawl_run_id = ? ORDER BY s.fetched_at DESC, s.id DESC LIMIT 1`,
      ws,
      pid,
      crawl.id,
    );
    if (latest) nowReading = { url: latest.url, at: latest.at };
  }

  // ---------------------------------------------------------------- lanes + queued (GEO only)
  let lanes: ActivityLane[] = [];
  let queued: ActivityQueuedItem[] = [];
  if (isGeo) {
    const built = await buildLanes(db, ws, pid, run, active, obs, laneEvents, latencyOf, opts.configuredEngines ?? []);
    lanes = built.lanes;
    queued = built.queued;
  }

  const startedMs = run.started_at ? Date.parse(run.started_at) : NaN;
  const endMs = run.finished_at ? Date.parse(run.finished_at) : active ? opts.now.getTime() : NaN;
  const elapsedMs = Number.isFinite(startedMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startedMs) : null;

  return {
    run: {
      id: run.id,
      agent: run.agent,
      status: run.status,
      trigger: run.trigger,
      createdAt: run.created_at,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      elapsedMs,
    },
    active,
    totals: {
      spend,
      providerCalls: callsN,
      pagesRead: pagesReadRow?.n ?? 0,
      pagesPlanned: crawl ? crawl.pages_limit : null,
      answers,
      decisions: decisionTotals,
    },
    lanes,
    queued,
    nowReading,
    items,
    cursor: nextCursor,
  };
}

async function buildLanes(
  db: Db,
  ws: string,
  pid: string,
  run: RunRowLite,
  active: boolean,
  obs: ObsRow[],
  laneEvents: Array<{ step: string; status: string }>,
  latencyOf: (o: ObsRow) => number | null,
  configured: readonly GeoEngineProviderId[],
): Promise<{ lanes: ActivityLane[]; queued: ActivityQueuedItem[] }> {
  const started = new Set<string>();
  const finished = new Set<string>();
  let batchFinished = false;
  for (const e of laneEvents) {
    if (e.step === "geo.batch") {
      if (TERMINAL_STEP.has(e.status)) batchFinished = true;
      continue;
    }
    const p = e.step.slice("geo_batch:".length);
    if (e.status === "started") started.add(p);
    else if (TERMINAL_STEP.has(e.status)) finished.add(p);
  }
  const seen = new Set<string>([...obs.map((o) => o.provider), ...started, ...finished].filter(isGeoEngineId));
  const include = new Set<string>([...seen, ...(active ? configured : [])]);
  const order = BOARD_LANES.filter((p) => include.has(p));

  // The run's prompt set: the one its answers were sampled from; while active and before any answer, the
  // project's active set (the one geo/batch.ts reads).
  let setId = obs.find((o) => o.prompt_set_id)?.prompt_set_id ?? null;
  if (!setId && active) {
    const set = await db.first<{ id: string }>(
      "SELECT id FROM geo_prompt_sets WHERE workspace_id = ? AND project_id = ? AND active = 1 ORDER BY version DESC LIMIT 1",
      ws,
      pid,
    );
    setId = set?.id ?? null;
  }
  let planned: number | null = null;
  let prompts: Array<{ id: string; text: string }> = [];
  if (setId) {
    const limits = await db.first<{ geo_prompts_per_run: number }>(
      "SELECT geo_prompts_per_run FROM project_limits WHERE workspace_id = ? AND project_id = ?",
      ws,
      pid,
    );
    const cap = limits ? Math.max(0, limits.geo_prompts_per_run) : 200;
    // Same selection as geo/batch.ts: approved prompts of the set by position, capped per run.
    prompts = await db.all<{ id: string; text: string }>(
      "SELECT id, text FROM geo_prompts WHERE workspace_id = ? AND project_id = ? AND prompt_set_id = ? AND approved = 1 ORDER BY position ASC, id ASC LIMIT ?",
      ws,
      pid,
      setId,
      Math.min(cap, 200),
    );
    planned = prompts.length;
  }

  const observedPairs = new Set(obs.filter((o) => o.prompt_id).map((o) => `${o.prompt_id}|${o.provider}`));
  const lanes: ActivityLane[] = order.map((provider) => {
    const rows = obs.filter((o) => o.provider === provider);
    let lastLatencyMs: number | null = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      const l = latencyOf(rows[i]!);
      if (l !== null) {
        lastLatencyMs = l;
        break;
      }
    }
    let state: ActivityLane["state"];
    if (finished.has(provider) || (!active && rows.length > 0)) state = "done";
    else if (!active || batchFinished) state = rows.length > 0 ? "done" : "idle";
    else if (started.has(provider) || rows.length > 0) state = "asking";
    else state = "queued";
    return { provider, label: LANE_LABELS[provider], state, done: rows.length, planned, lastLatencyMs };
  });

  const queued: ActivityQueuedItem[] = [];
  if (active && prompts.length > 0) {
    const pending = [...lanes.filter((l) => l.state === "asking"), ...lanes.filter((l) => l.state === "queued")];
    outer: for (const lane of pending) {
      for (const p of prompts) {
        if (queued.length >= ACTIVITY_QUEUED_MAX) break outer;
        if (observedPairs.has(`${p.id}|${lane.provider}`)) continue;
        queued.push({ provider: lane.provider, label: lane.label, promptText: clip(p.text, TITLE_MAX) });
      }
    }
  }
  return { lanes, queued };
}

// ------------------------------------------------------------------ current runs

export async function currentActivityRuns(db: Db, ws: string, pid: string): Promise<Array<{ id: string; agent: "seo" | "geo"; status: string }>> {
  const activeRuns = await db.all<{ id: string; agent: "seo" | "geo"; status: string }>(
    `SELECT id, agent, status FROM agent_runs WHERE workspace_id = ? AND project_id = ? AND status IN ('pending', 'running')
      ORDER BY created_at DESC, id DESC LIMIT 10`,
    ws,
    pid,
  );
  if (activeRuns.length > 0) return activeRuns;
  const out: Array<{ id: string; agent: "seo" | "geo"; status: string }> = [];
  for (const agent of ["seo", "geo"] as const) {
    const r = await db.first<{ id: string; agent: "seo" | "geo"; status: string }>(
      `SELECT id, agent, status FROM agent_runs WHERE workspace_id = ? AND project_id = ? AND agent = ? AND status NOT IN ('pending', 'running')
        ORDER BY COALESCE(finished_at, created_at) DESC, id DESC LIMIT 1`,
      ws,
      pid,
      agent,
    );
    if (r) out.push(r);
  }
  return out;
}
