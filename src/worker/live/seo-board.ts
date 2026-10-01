/**
 * Live view SEO feed (docs/api.md "Live view", GET /projects/:pid/live/seo). A read model over the STORED
 * rows of ONE SEO run; nothing is simulated, interpolated, projected or re-asked:
 *
 *   decision_records (d)  -> elements (role element/action, Links rows) and queries   id "dec:<id>"  at created_at
 *   audit_findings  (f)   -> elements (role rule) of the run's crawl attempt          id "find:<id>" at created_at
 *   recommendations (r)   -> recommendations created by the run                      id "rec:<id>"  at created_at
 *
 * Element and verdict come from LIVE_SEO_ELEMENT_MAP (elements.ts): code over the stored tier and raw answer,
 * never Jev text. Paging uses per-source rowid high-water marks (cursor.ts), as runs/activity.ts does, so rows
 * stamped out of order are never missed; `k` (crawl attempt) restarts the finding mark when a retried crawl
 * rewrote its findings. The SQL reads only rows that become list rows (element/action questions, query answers
 * with stored query text, reused link suggestions, mapped rules), so an empty page means "nothing new right
 * now". Should a read row still be hidden (e.g. whitespace-only query text), it advances its mark, and reading
 * continues in the same request (at most MAX_READ_ROUNDS reads) until the page is full or every source is
 * drained, so a page shorter than `limit` means nothing more is stored right now.
 *
 * Enrichment is batched over the page's rows only (lookups.ts). Totals always cover the whole run and are
 * grouped queries capped at LIVE_TOTALS_GROUP_CAP groups (`truncated` when a cap was hit); they (and the run's
 * sync row) are computed only on the last page of a read (fewer rows than `limit`; null on full pages), so a
 * replay paging in a long run does not rescan the run per page.
 *
 * A drafted snippet ("proposed") is shown only against rows of the element the candidate's DECIDED action
 * addresses (decidedActionElement mirrors seo/recommend/decide.ts over the stored rows); when that action
 * cannot be told from the stored rows, no snippet is shown.
 *
 * Rules: every query filters workspace_id AND project_id (and run_id or the run's crawl attempt) and has a
 * LIMIT; dynamic IN lists stay under D1's 100 bound parameters; untrusted text is clipped plain text.
 */
import type {
  LiveBandCounts,
  LiveGscSync,
  LiveJevJudgment,
  LivePipelineTotals,
  LiveQueryQuestion,
  LiveRecommendationRow,
  LiveSeoBoardResponse,
  LiveSeoElement,
  LiveSeoElementRow,
  LiveSeoQueryRow,
  LiveSeoVerdict,
  PageType,
  RecommendationStage,
  RecommendationStatus,
  RunActivity,
  Severity,
  Tier,
} from "@shared/types";
import type { Db } from "../lib/db";
import { parseJson } from "../lib/db";
import { badRequest } from "../lib/errors";
import type { ProjectRow } from "../platform/access";
import { clip, DEMO_LABEL, inChunks, pageKey, uniq } from "../coverage/common";
import { getRule } from "../seo/rules/registry";
import { normalizeDemandQuery } from "../seo/gsc/demand";
import { QUESTION } from "../seo/questions";
import {
  ACTION_QUESTION_IDS,
  actionFamily,
  ELEMENT_QUESTION_IDS,
  ELEMENT_RULE_IDS,
  isQueryQuestion,
  judgeElement,
  judgeLinkSuggestion,
  judgeRule,
  LIVE_ELEMENTS_VERSION,
  LIVE_SEO_ELEMENT_MAP,
  parseCandidateKey,
  QUERY_QUESTION_IDS,
  queryBand,
  storedAnswer,
  type ElementJudgment,
} from "./elements";
import { compareAtId, decodeLiveCursor, encodeLiveCursor, LIVE_DEFAULT_LIMIT, LIVE_MAX_LIMIT, mergeMarked, type MarkedEntry } from "./cursor";
import {
  loadGscMetrics,
  loadLinkSuggestions,
  loadPagesByUrl,
  loadSnapshots,
  pathLabel,
  type GscLookup,
  type LinkSuggestionLite,
  type PageLite,
  type SnapshotLite,
} from "./lookups";

export const LIVE_TOTALS_GROUP_CAP = 500;
/** Same wording as the web panel (src/web/pages/live/text.ts LIVE_TEXT.noJevAnswers). */
export const NO_JEV_ANSWERS_LABEL = "No Jev answers were stored in this run: rule findings only.";
/** Reads per request while hidden rows keep a page from filling (see the module note). */
const MAX_READ_ROUNDS = 5;
/** Query-batch cache keys (seo/recommend/query-batch.ts): relevance pre-filter and buyer-query view. */
const QUERY_BATCH_PREFIXES = ["qrel:", "buyer:"] as const;
const TEXT_MAX = 160;

// ------------------------------------------------------------------ cursor

export interface LiveSeoCursor {
  /** decision_records rowid mark */
  d: number;
  /** audit_findings rowid mark (of crawl attempt `k`) */
  f: number;
  /** recommendations rowid mark */
  r: number;
  /** Crawl attempt the `f` mark refers to (Date.parse of crawl_runs.started_at); absent/0 = none. */
  k?: number;
}

const SEO_KEYS = ["d", "f", "r"] as const;

export function encodeLiveSeoCursor(c: LiveSeoCursor): string {
  return encodeLiveCursor(c.k ? { d: c.d, f: c.f, r: c.r, k: c.k } : { d: c.d, f: c.f, r: c.r });
}

/** 400 on anything malformed, including a GEO-feed or activity cursor. */
export function decodeLiveSeoCursor(raw: string | null | undefined): LiveSeoCursor | null {
  return decodeLiveCursor(raw, SEO_KEYS, ["k"] as const);
}

// ------------------------------------------------------------------ SQL fragments

/** answer_json when valid JSON (json_extract on malformed JSON would fail the whole statement). */
const A = "(CASE WHEN json_valid(answer_json) THEN answer_json END)";
/** Same rule as elements.ts storedAnswer: a top-level string `type` is a bare answer, else `$.answer`. */
const TOP = `json_type(${A}, '$.type') = 'text'`;
const field = (f: string) => `(CASE WHEN ${TOP} THEN json_extract(${A}, '$.${f}') ELSE json_extract(${A}, '$.answer.${f}') END)`;
const fieldType = (f: string) => `(CASE WHEN ${TOP} THEN json_type(${A}, '$.${f}') ELSE json_type(${A}, '$.answer.${f}') END)`;
/** Group columns that decide a verdict: answer type, Noul side (>= 0.5), Choice option. */
const ANSWER_GROUP_COLUMNS = `${field("type")} AS atype,
       CASE WHEN ${fieldType("noul")} IN ('integer', 'real') THEN (CASE WHEN ${field("noul")} >= 0.5 THEN 1 ELSE 0 END) END AS yes,
       CASE WHEN ${fieldType("choice")} = 'text' THEN ${field("choice")} END AS choice`;
/** Question-less rows that reused an internal link suggestion (elements.ts judgeLinkSuggestion). */
const LINK_ROW_SQL = `(question_id IS NULL AND json_type(${A}, '$.linkSuggestionId') = 'text' AND json_extract(${A}, '$.kind') IN (${LIVE_SEO_ELEMENT_MAP.linkSuggestion.kinds
  .map(() => "?")
  .join(", ")}))`;
const LINK_KINDS = LIVE_SEO_ELEMENT_MAP.linkSuggestion.kinds;
const ROW_QUESTION_IDS = uniq([...ELEMENT_QUESTION_IDS, ...ACTION_QUESTION_IDS]);
/** Query answers are listed only with their stored query text (storedQueryText); the rest are never read. */
const QUERY_ROW_SQL = `(question_id IN (${QUERY_QUESTION_IDS.map(() => "?").join(", ")}) AND json_type(${A}, '$.query') = 'text' AND trim(json_extract(${A}, '$.query')) <> '')`;
const ph = (n: number) => Array.from({ length: n }, () => "?").join(", ");

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

export interface DecisionRaw {
  rid: number;
  id: string;
  candidate_key: string;
  question_id: string | null;
  provider: string | null;
  model: string | null;
  tier: string | null;
  outcome: "selected" | "rejected";
  reason_code: string | null;
  answer_json: string | null;
  created_at: string;
}

export interface FindingRaw {
  rid: number;
  id: string;
  rule_id: string;
  severity: Severity;
  url: string | null;
  template: string | null;
  created_at: string;
}

export interface RecRaw {
  rid: number;
  id: string;
  agent: "seo" | "geo";
  scope: "page" | "template" | "site";
  target_json: string;
  issue_type: string;
  action: string;
  suggested_snippet: string | null;
  stage: RecommendationStage;
  status: RecommendationStatus;
  priority: number;
  priority_version: string;
  effort: "low" | "medium" | "high";
  uncertainty: "low" | "medium" | "high";
  decision_label: string | null;
  evidence_ids_json: string;
  writer_provider: string | null;
  writer_model: string | null;
  created_at: string;
}

type Payload =
  | { kind: "element"; d: DecisionRaw; answer: Record<string, unknown> | null; j: ElementJudgment }
  | { kind: "link"; d: DecisionRaw; answer: Record<string, unknown> | null; link: NonNullable<ReturnType<typeof judgeLinkSuggestion>> }
  | { kind: "query"; d: DecisionRaw; answer: Record<string, unknown> | null; questionId: LiveQueryQuestion; query: string }
  | { kind: "rule"; f: FindingRaw }
  | { kind: "rec"; r: RecRaw };

type SourceKey = "d" | "f" | "r";

export function tierOf(v: string | null | undefined): Tier | null {
  return v === "act" || v === "flag" || v === "drop" || v === "n/a" ? v : null;
}

function ruleClass(ruleId: string): "fact" | "heuristic" {
  return getRule(ruleId)?.class ?? "heuristic";
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * The query text a decision row stores (`answer_json.query`, written by query-batch.ts). Readable candidate
 * keys hold a token bag (text.ts queryKey), not the typed query, so they are never used as query text.
 */
function storedQueryText(answer: Record<string, unknown> | null): string | null {
  const q = answer?.query;
  return typeof q === "string" && q.trim() !== "" ? q : null;
}

/** Element/query/link classification of one decision row; null = read but not shown. Pure. */
export function classifyDecision(d: DecisionRaw): Payload | null {
  const answer = asObject(parseJson<unknown>(d.answer_json, null));
  if (d.question_id === null) {
    const link = judgeLinkSuggestion(answer);
    return link ? { kind: "link", d, answer, link } : null;
  }
  if (isQueryQuestion(d.question_id)) {
    const query = storedQueryText(answer);
    return query ? { kind: "query", d, answer, questionId: d.question_id, query } : null;
  }
  const j = judgeElement(d.question_id, answer, tierOf(d.tier));
  return j ? { kind: "element", d, answer, j } : null;
}

function classifyFinding(f: FindingRaw): Payload | null {
  return judgeRule(f.rule_id, ruleClass(f.rule_id)) ? { kind: "rule", f } : null;
}

// ------------------------------------------------------------------ targets and values

interface Target {
  url: string | null;
  label: string;
}

/** Target of a recommendation's target_json: URL path, "Template: <name> (N URLs)" or "Site". */
export function targetOf(targetJson: string): Target | null {
  const t = asObject(parseJson<unknown>(targetJson, null));
  if (!t) return null;
  if (t.kind === "url" && typeof t.url === "string" && t.url) return { url: t.url, label: pathLabel(t.url) };
  if (t.kind === "template") {
    const n = typeof t.affectedUrlCount === "number" && t.affectedUrlCount > 0 ? t.affectedUrlCount : null;
    const name = typeof t.template === "string" && t.template.trim() ? t.template : "unnamed";
    return { url: null, label: clip(`Template: ${name}${n === null ? "" : ` (${n} URL${n === 1 ? "" : "s"})`}`, TEXT_MAX) };
  }
  if (t.kind === "site") return { url: null, label: "Site" };
  return null;
}

const text = (v: string | null | undefined): string | null => {
  const t = clip(v, TEXT_MAX);
  return t === "" ? null : t;
};

/** The element's current stored value (docs/live-view-design.md section 6 "now by element"). */
export function nowValue(element: LiveSeoElement, snap: SnapshotLite | null, pageType: PageType | null, link: LinkSuggestionLite | null): string | null {
  switch (element) {
    case "Title":
      return text(snap?.title);
    case "Meta":
      return text(snap?.metaDescription);
    case "Title + meta":
      return snap ? text(`Title: ${clip(snap.title, 80) || "none"} · Meta: ${clip(snap.metaDescription, 80) || "none"}`) : null;
    case "H1":
      return text(snap?.h1[0]);
    case "Headings":
      return snap && snap.headings.length > 0 ? text(snap.headings.slice(0, 3).join(" · ")) : null;
    case "Intro":
      return text(snap?.firstParagraph);
    case "Schema":
      return snap && snap.jsonldTypes.length > 0 ? text(snap.jsonldTypes.join(", ")) : null;
    case "Content":
      return snap && snap.wordCount !== null ? `${snap.wordCount.toLocaleString("en-US")} words` : null;
    case "Freshness":
      return snap?.lastUpdated ? text(`Updated ${snap.lastUpdated.slice(0, 10)}`) : null;
    case "Canonical":
      return text(snap?.canonical);
    case "Indexing":
      return text(snap?.robotsMeta);
    case "Status":
      return snap && snap.statusCode !== null ? `HTTP ${snap.statusCode}` : null;
    case "Intent":
      return pageType ? `${pageType} page` : null;
    case "Links":
      return link ? text(`${pathLabel(link.targetUrl)} has ${link.targetInlinks} internal link${link.targetInlinks === 1 ? "" : "s"} in`) : null;
    default:
      return null;
  }
}

function jevOf(questionId: string, d: DecisionRaw, answer: Record<string, unknown> | null): LiveJevJudgment {
  const a = storedAnswer(answer);
  return {
    questionId: questionId.split("#")[0]!,
    tier: tierOf(d.tier),
    noul: a?.type === "noul" ? a.noul : null,
    choice: a?.type === "choice" ? a.choice : null,
    confidence: a?.type === "choice" ? a.confidence : null,
    provider: d.provider,
    model: d.model,
  };
}

// ------------------------------------------------------------------ decided action (snippet placement)

/** Stored rows that decide a candidate's action (seo/recommend/decide.ts). */
const ACTION_INPUT_QUESTIONS = [QUESTION.actionChoice, QUESTION.titleMatchesQuery, QUESTION.metaMatchesQuery, QUESTION.pageAction] as const;

export interface ActionInputRow {
  candidate_key: string;
  question_id: string;
  tier: string | null;
  answer_json: string | null;
}

/**
 * The element of a candidate's DECIDED action, from its stored rows, mirroring seo/recommend/decide.ts:
 * - seo.action_choice counts only with a usable tier (act or flag; drop and n/a are not answers);
 * - a confident (act) "no" on title/meta-matches-query means rewrite_title_meta ("Title + meta") when there is
 *   no action, when it is no_action, and for weak_ctr candidates (the only ones asked those questions);
 * - an act-tier seo.page_action "merge" means consolidate_duplicate ("Duplicate").
 * null when the action cannot be told from the stored rows (e.g. a candidate default action): then no snippet
 * is placed against any element row.
 */
export function decidedActionElement(rows: readonly ActionInputRow[]): LiveSeoElement | null {
  const by = new Map(rows.map((r) => [r.question_id, r]));
  const spec = LIVE_SEO_ELEMENT_MAP.questions[QUESTION.actionChoice];
  let action: { choice: string; element: LiveSeoElement | null } | null = null;
  const act = by.get(QUESTION.actionChoice);
  const actTier = tierOf(act?.tier);
  if (act && (actTier === "act" || actTier === "flag") && spec?.type === "choice") {
    const a = storedAnswer(parseJson<unknown>(act.answer_json, null));
    if (a?.type === "choice" && a.choice !== null) action = { choice: a.choice, element: spec.options[a.choice]?.element ?? null };
  }
  const confidentNo = (q: string) => {
    const r = by.get(q);
    if (!r || tierOf(r.tier) !== "act") return false;
    const a = storedAnswer(parseJson<unknown>(r.answer_json, null));
    return a?.type === "noul" && a.noul !== null && a.noul < 0.5;
  };
  const misaligned = confidentNo(QUESTION.titleMatchesQuery) || confidentNo(QUESTION.metaMatchesQuery);
  const pa = by.get(QUESTION.pageAction);
  const paAnswer = pa && tierOf(pa.tier) === "act" ? storedAnswer(parseJson<unknown>(pa.answer_json, null)) : null;
  const merge = paAnswer?.type === "choice" && paAnswer.choice === "merge";
  if (merge) return "Duplicate";
  const noAction = !action || action.choice === "no_action" || action.choice === "none";
  if (misaligned) return "Title + meta";
  if (noAction) return null;
  return action!.element;
}

// ------------------------------------------------------------------ builder

export interface BuildLiveSeoOptions {
  after?: LiveSeoCursor | null;
  limit?: number;
  now: Date;
}

/** Returns null when the run does not exist in this workspace + project; 400 agent_mismatch for a GEO run. */
export async function buildLiveSeo(db: Db, project: ProjectRow, runId: string, opts: BuildLiveSeoOptions): Promise<LiveSeoBoardResponse | null> {
  const ws = project.workspace_id;
  const pid = project.id;
  const run = await db.first<RunRow>(
    "SELECT id, agent, status, trigger, created_at, started_at, finished_at FROM agent_runs WHERE workspace_id = ? AND project_id = ? AND id = ? LIMIT 1",
    ws,
    pid,
    runId,
  );
  if (!run) return null;
  if (run.agent !== "seo") throw badRequest("This run is not an SEO run; use the GEO live feed.", { reason: "agent_mismatch" });
  const limit = Math.max(1, Math.min(opts.limit ?? LIVE_DEFAULT_LIMIT, LIVE_MAX_LIMIT));
  const cursor = opts.after ?? null;
  const active = run.status === "pending" || run.status === "running";

  // The run's crawl attempt: a retried crawl rewrites its findings (rowids can be reused), so the finding
  // mark only applies to the attempt it was taken on.
  const crawl = await db.first<{ id: string; started_at: string | null }>(
    "SELECT id, started_at FROM crawl_runs WHERE workspace_id = ? AND project_id = ? AND run_id = ? ORDER BY started_at DESC, id DESC LIMIT 1",
    ws,
    pid,
    run.id,
  );
  const crawlKey = crawl?.started_at ? Math.max(0, Date.parse(crawl.started_at) || 0) : 0;
  const start = { d: cursor?.d ?? 0, f: (cursor?.k ?? 0) === crawlKey ? (cursor?.f ?? 0) : 0, r: cursor?.r ?? 0 };

  // ---------------------------------------------------------------- read + merge (bounded rounds)
  // Reads continue until the page is full or every source is drained, so a page shorter than `limit` means
  // nothing more is stored right now (hidden rows never shorten a page while more rows exist).
  let marks = { ...start };
  const taken: Array<{ source: SourceKey; entry: MarkedEntry<Payload> & { payload: Payload } }> = [];
  for (let round = 0; round < MAX_READ_ROUNDS && taken.length < limit; round++) {
    const want = limit - taken.length;
    const [dRows, fRows, rRows] = await Promise.all([
      db.all<DecisionRaw>(
        `SELECT rowid AS rid, id, candidate_key, question_id, provider, model, tier, outcome, reason_code, answer_json, created_at
           FROM decision_records
          WHERE workspace_id = ? AND project_id = ? AND run_id = ? AND rowid > ?
            AND (question_id IN (${ph(ROW_QUESTION_IDS.length)}) OR ${QUERY_ROW_SQL} OR ${LINK_ROW_SQL})
          ORDER BY rowid LIMIT ?`,
        ws,
        pid,
        run.id,
        marks.d,
        ...ROW_QUESTION_IDS,
        ...QUERY_QUESTION_IDS,
        ...LINK_KINDS,
        want,
      ),
      crawl
        ? db.all<FindingRaw>(
            `SELECT rowid AS rid, id, rule_id, severity, url, template, created_at FROM audit_findings
              WHERE workspace_id = ? AND project_id = ? AND crawl_run_id = ? AND rowid > ? AND rule_id IN (${ph(ELEMENT_RULE_IDS.length)})
              ORDER BY rowid LIMIT ?`,
            ws,
            pid,
            crawl.id,
            marks.f,
            ...ELEMENT_RULE_IDS,
            want,
          )
        : Promise.resolve([] as FindingRaw[]),
      db.all<RecRaw>(
        `SELECT ${REC_COLUMNS}
           FROM recommendations
          WHERE workspace_id = ? AND project_id = ? AND run_id = ? AND rowid > ?
          ORDER BY rowid LIMIT ?`,
        ws,
        pid,
        run.id,
        marks.r,
        want,
      ),
    ]);
    const merged = mergeMarked<SourceKey, Payload>(
      {
        d: dRows.map((r) => ({ rid: r.rid, at: r.created_at, id: `dec:${r.id}`, payload: classifyDecision(r) })),
        f: fRows.map((r) => ({ rid: r.rid, at: r.created_at, id: `find:${r.id}`, payload: classifyFinding(r) })),
        r: rRows.map((r) => ({ rid: r.rid, at: r.created_at, id: `rec:${r.id}`, payload: { kind: "rec", r } as Payload })),
      },
      marks,
      want,
    );
    marks = merged.marks;
    taken.push(...merged.taken);
    // Stopped at the limit, or every source was read to its end: nothing more to read now.
    if (!merged.exhausted) break;
    if (dRows.length < want && fRows.length < want && rRows.length < want) break;
  }

  const crawlChanged = (cursor?.k ?? 0) !== crawlKey;
  const advanced = marks.d !== start.d || marks.f !== start.f || marks.r !== start.r;
  // With nothing new, the request's cursor is echoed (null when none was given); a changed crawl attempt or
  // hidden rows read still return a cursor so they are not re-read on every poll.
  const nextCursor =
    taken.length > 0 || advanced || (cursor && crawlChanged)
      ? encodeLiveSeoCursor({ ...marks, k: crawlKey })
      : cursor
        ? encodeLiveSeoCursor(cursor)
        : null;

  // ---------------------------------------------------------------- enrichment (this page's rows only)
  const payloads = taken.map((t) => ({ id: t.entry.id, at: t.entry.at, p: t.entry.payload }));
  const decisionPayloads = payloads.filter((x) => x.p.kind === "element" || x.p.kind === "link") as Array<{
    id: string;
    at: string;
    p: Extract<Payload, { kind: "element" | "link" }>;
  }>;
  const findingPayloads = payloads.filter((x) => x.p.kind === "rule") as Array<{ id: string; at: string; p: Extract<Payload, { kind: "rule" }> }>;
  const queryPayloads = payloads.filter((x) => x.p.kind === "query") as Array<{ id: string; at: string; p: Extract<Payload, { kind: "query" }> }>;
  const recPayloads = payloads.filter((x) => x.p.kind === "rec") as Array<{ id: string; at: string; p: Extract<Payload, { kind: "rec" }> }>;

  // Recommendations of this run for the page's candidates (target, snippet, id).
  const candidateKeys = uniq(decisionPayloads.map((x) => x.p.d.candidate_key));
  const recByKey = new Map<string, { id: string; target_json: string; suggested_snippet: string | null }>();
  if (candidateKeys.length > 0) {
    const rows = await inChunks(candidateKeys, (chunk, p) =>
      // The newest recommendation per candidate key (one row per key).
      db.all<{ id: string; dedup_key: string; target_json: string; suggested_snippet: string | null }>(
        `SELECT id, dedup_key, target_json, suggested_snippet FROM recommendations
          WHERE workspace_id = ? AND project_id = ?
            AND rowid IN (SELECT MAX(rowid) FROM recommendations
                           WHERE workspace_id = ? AND project_id = ? AND run_id = ? AND dedup_key IN (${p}) GROUP BY dedup_key)
          LIMIT ${chunk.length}`,
        ws,
        pid,
        ws,
        pid,
        run.id,
        ...chunk,
      ),
    );
    for (const r of rows) if (!recByKey.has(r.dedup_key)) recByKey.set(r.dedup_key, r);
  }
  // The decided action of candidates that have a drafted snippet: a snippet is shown only against rows of
  // the elements that action addresses (elements.ts actionFamily).
  const actionElementByKey = new Map<string, LiveSeoElement>();
  const snippetKeys = candidateKeys.filter((k) => recByKey.get(k)?.suggested_snippet);
  if (snippetKeys.length > 0) {
    const rows = await inChunks(snippetKeys, (chunk, p) =>
      // The newest stored row per candidate and decisive question.
      db.all<ActionInputRow>(
        `SELECT candidate_key, question_id, tier, answer_json FROM decision_records
          WHERE workspace_id = ? AND project_id = ?
            AND rowid IN (SELECT MAX(rowid) FROM decision_records
                           WHERE workspace_id = ? AND project_id = ? AND run_id = ? AND question_id IN (${ph(ACTION_INPUT_QUESTIONS.length)}) AND candidate_key IN (${p})
                           GROUP BY candidate_key, question_id)
          LIMIT ${chunk.length * ACTION_INPUT_QUESTIONS.length}`,
        ws,
        pid,
        ws,
        pid,
        run.id,
        ...ACTION_INPUT_QUESTIONS,
        ...chunk,
      ),
    );
    const byKey = new Map<string, ActionInputRow[]>();
    for (const r of rows) byKey.set(r.candidate_key, [...(byKey.get(r.candidate_key) ?? []), r]);
    for (const [key, list] of byKey) {
      const el = decidedActionElement(list);
      if (el) actionElementByKey.set(key, el);
    }
  }

  // Targets (first match wins): the candidate's recommendation, the readable candidate key's URL, the finding.
  const targetOfDecision = (d: DecisionRaw, answer: Record<string, unknown> | null): Target => {
    const rec = recByKey.get(d.candidate_key);
    const fromRec = rec ? targetOf(rec.target_json) : null;
    if (fromRec) return fromRec;
    const readable = typeof answer?.candidate === "string" ? answer.candidate : null;
    const parsed = parseCandidateKey(readable);
    if (parsed.url) return { url: parsed.url, label: pathLabel(parsed.url) };
    return { url: null, label: clip(`Candidate ${readable ?? d.candidate_key}`, TEXT_MAX) };
  };
  const targetOfFinding = (f: FindingRaw): Target =>
    f.url ? { url: f.url, label: pathLabel(f.url) } : f.template ? { url: null, label: clip(`Template: ${f.template}`, TEXT_MAX) } : { url: null, label: "Site" };

  const decisionTargets = new Map(decisionPayloads.map((x) => [x.id, targetOfDecision(x.p.d, x.p.answer)]));
  const findingTargets = new Map(findingPayloads.map((x) => [x.id, targetOfFinding(x.p.f)]));
  const urls = uniq([...decisionTargets.values(), ...findingTargets.values()].map((t) => t.url).filter((u): u is string => !!u));
  const linkIds = uniq(decisionPayloads.flatMap((x) => (x.p.kind === "link" ? [x.p.link.linkSuggestionId] : [])));
  const queries = uniq(queryPayloads.map((x) => x.p.query));

  const [pages, links, gsc] = await Promise.all([
    loadPagesByUrl(db, ws, pid, urls),
    loadLinkSuggestions(db, ws, pid, linkIds),
    loadGscMetrics(db, ws, pid, urls, queries),
  ]);
  const snaps = await loadSnapshots(
    db,
    ws,
    pid,
    [...pages.values()].map((p) => p.id),
    crawl?.id ?? null,
  );
  const pageOf = (url: string | null): PageLite | null => {
    const k = url ? pageKey(url) : null;
    return k ? (pages.get(k) ?? null) : null;
  };
  const gscOfUrl = (url: string | null, g: GscLookup | null) => {
    const k = url ? pageKey(url) : null;
    return k && g ? (g.pages.get(k) ?? null) : null;
  };

  // ---------------------------------------------------------------- rows
  const elements: LiveSeoElementRow[] = [];
  for (const x of decisionPayloads) {
    const d = x.p.d;
    const t = decisionTargets.get(x.id)!;
    const page = pageOf(t.url);
    const snap = page ? (snaps.get(page.id) ?? null) : null;
    const rec = recByKey.get(d.candidate_key) ?? null;
    let row: Omit<LiveSeoElementRow, "proposed">;
    if (x.p.kind === "link") {
      const link = x.p.link;
      const ls = links.get(link.linkSuggestionId) ?? null;
      row = {
        id: x.id,
        at: x.at,
        role: "element",
        candidateKey: d.candidate_key,
        pagePath: t.url ? pathLabel(t.url) : null,
        url: t.url,
        pageId: page?.id ?? null,
        targetLabel: t.label,
        element: link.element,
        questionId: LIVE_SEO_ELEMENT_MAP.linkSuggestion.questionId,
        now: nowValue(link.element, snap, page?.pageType ?? null, ls),
        gsc: gscOfUrl(t.url, gsc),
        jev: {
          questionId: LIVE_SEO_ELEMENT_MAP.linkSuggestion.questionId,
          tier: link.tier,
          noul: link.noul,
          choice: null,
          confidence: null,
          provider: ls?.provider ?? d.provider,
          model: ls?.model ?? d.model,
        },
        rule: null,
        verdict: link.verdict,
        verdictBasis: link.basis,
        outcome: d.outcome,
        reasonCode: d.reason_code,
        recommendationId: rec?.id ?? null,
        linkSuggestionId: link.linkSuggestionId,
      };
    } else {
      const j = x.p.j;
      row = {
        id: x.id,
        at: x.at,
        role: j.role,
        candidateKey: d.candidate_key,
        pagePath: t.url ? pathLabel(t.url) : null,
        url: t.url,
        pageId: page?.id ?? null,
        targetLabel: t.label,
        element: j.element,
        questionId: d.question_id!.split("#")[0]!,
        now: nowValue(j.element, snap, page?.pageType ?? null, null),
        gsc: gscOfUrl(t.url, gsc),
        jev: jevOf(d.question_id!, d, x.p.answer),
        rule: null,
        verdict: j.verdict,
        verdictBasis: j.basis,
        outcome: d.outcome,
        reasonCode: d.reason_code,
        recommendationId: rec?.id ?? null,
        linkSuggestionId: null,
      };
    }
    // The candidate's drafted snippet, only on rows that still need work and that its decided action
    // addresses; never when the decided action is unknown, never on a drop-tier action row.
    const actionEl = actionElementByKey.get(d.candidate_key) ?? null;
    const showsSnippet =
      row.verdict !== "keep" && actionEl !== null && (row.role === "action" ? row.jev?.tier !== "drop" && actionFamily(actionEl).includes(row.element) : actionFamily(actionEl).includes(row.element));
    elements.push({ ...row, proposed: showsSnippet && rec?.suggested_snippet ? text(rec.suggested_snippet) : null });
  }
  for (const x of findingPayloads) {
    const f = x.p.f;
    const cls = ruleClass(f.rule_id);
    const judged = judgeRule(f.rule_id, cls)!;
    const t = findingTargets.get(x.id)!;
    const page = pageOf(t.url);
    const snap = page ? (snaps.get(page.id) ?? null) : null;
    elements.push({
      id: x.id,
      at: x.at,
      role: "rule",
      candidateKey: null,
      pagePath: t.url ? pathLabel(t.url) : null,
      url: t.url,
      pageId: page?.id ?? null,
      targetLabel: t.label,
      element: judged.element,
      questionId: f.rule_id,
      now: nowValue(judged.element, snap, page?.pageType ?? null, null),
      proposed: null,
      gsc: gscOfUrl(t.url, gsc),
      jev: null,
      rule: { ruleId: f.rule_id, severity: f.severity, class: cls },
      verdict: judged.verdict,
      verdictBasis: judged.basis,
      outcome: null,
      reasonCode: null,
      recommendationId: null,
      linkSuggestionId: null,
    });
  }
  elements.sort(compareAtId);

  const queryRows: LiveSeoQueryRow[] = queryPayloads.map((x) => {
    const d = x.p.d;
    const key = normalizeDemandQuery(x.p.query);
    return {
      id: x.id,
      at: x.at,
      queryKey: key,
      query: clip(x.p.query, TEXT_MAX),
      questionId: x.p.questionId,
      band: queryBand(storedAnswer(x.p.answer), tierOf(d.tier)),
      jev: jevOf(x.p.questionId, d, x.p.answer),
      gsc: gsc ? (gsc.queries.get(key) ?? null) : null,
    };
  });
  queryRows.sort(compareAtId);

  const recommendations = recPayloads.map((x) => recommendationRow(x.id, x.p.r));
  recommendations.sort(compareAtId);

  // ---------------------------------------------------------------- totals, sync, labels
  // Whole-run totals only on the last page of a read: a full page means more rows follow right away.
  const lastPage = taken.length < limit;
  const [totals, gscSync] = lastPage
    ? await Promise.all([seoTotals(db, ws, pid, run.id, crawl?.id ?? null), runGscSync(db, ws, pid, run.id)])
    : [null, null];

  const labels: string[] = [];
  if (project.is_demo === 1) labels.push(DEMO_LABEL);
  labels.push(
    "Stored rows of this run. Keep, change and review are computed by code from stored Jev answers and rule findings; nothing is re-asked or projected.",
  );
  if (gsc && (elements.some((e) => e.gsc) || queryRows.some((q) => q.gsc))) {
    labels.push(
      `Search Console: latest usable sync, ${gsc.window.start} to ${gsc.window.end}; positions are impression-weighted averages of stored rows; query+page sums are lower bounds.`,
    );
  }
  if (totals && !active && totals.pipeline.judged === 0 && totals.elements.judged > 0) labels.push(NO_JEV_ANSWERS_LABEL);
  if (totals?.truncated) labels.push(`Totals are lower bounds: a grouped count reached its ${LIVE_TOTALS_GROUP_CAP}-group cap.`);

  const startedMs = run.started_at ? Date.parse(run.started_at) : NaN;
  const endMs = run.finished_at ? Date.parse(run.finished_at) : active ? opts.now.getTime() : NaN;
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
    elements,
    queries: queryRows,
    recommendations,
    gscSync,
    totals,
    cursor: nextCursor,
    labels: uniq(labels),
  };
}

// ------------------------------------------------------------------ recommendations

export function recommendationRow(id: string, r: RecRaw): LiveRecommendationRow {
  const t = targetOf(r.target_json) ?? { url: null, label: r.scope === "site" ? "Site" : "Unknown target" };
  return {
    id,
    recommendationId: r.id,
    at: r.created_at,
    agent: r.agent,
    scope: r.scope,
    issueType: r.issue_type,
    targetLabel: t.label,
    url: t.url,
    action: clip(r.action, 200),
    suggestedSnippet: r.suggested_snippet ? clip(r.suggested_snippet, 400) : null,
    stage: r.stage,
    status: r.status,
    priority: r.priority,
    priorityVersion: r.priority_version,
    effort: r.effort,
    uncertainty: r.uncertainty,
    tier: tierOf(r.decision_label),
    evidenceCount: parseJson<unknown[]>(r.evidence_ids_json, []).length,
    writer: { provider: r.writer_provider, model: r.writer_model },
  };
}

export const REC_COLUMNS = `rowid AS rid, id, agent, scope, target_json, issue_type, action, suggested_snippet, stage, status, priority, priority_version,
                effort, uncertainty, decision_label, evidence_ids_json, writer_provider, writer_model, created_at`;

// ------------------------------------------------------------------ totals (whole run, grouped)

const STAGES: RecommendationStage[] = ["collected", "judged", "drafted", "awaiting_approval", "marked_implemented"];
const STATUSES: RecommendationStatus[] = ["open", "approved", "dismissed", "implemented"];

interface AnswerGroup {
  question_id: string;
  tier: string | null;
  atype: string | null;
  yes: number | null;
  choice: string | null;
  n: number;
}

/** A minimal stored answer that decides the same verdict as the grouped rows (see ANSWER_GROUP_COLUMNS). */
function groupAnswer(g: AnswerGroup): Record<string, unknown> | null {
  if (g.atype === "noul" && g.yes !== null) return { type: "noul", noul: g.yes === 1 ? 1 : 0 };
  if (g.atype === "choice" && g.choice !== null) return { type: "choice", choice: g.choice, confidence: null };
  if (g.atype === "score") return { type: "score" };
  return null;
}

const emptyBand = (): LiveBandCounts => ({ yes: 0, no: 0, middle: 0, unanswered: 0 });

/**
 * Pipeline counts of one run's decisions (query-batch keys excluded) and recommendations. Shared with the
 * GEO feed (its decisions and recommendations carry the same columns).
 */
export async function pipelineTotals(db: Db, ws: string, pid: string, runId: string): Promise<{ pipeline: LivePipelineTotals; truncated: boolean }> {
  const notBatch = QUERY_BATCH_PREFIXES.map(() => "candidate_key NOT LIKE ?").join(" AND ");
  const batchPatterns = QUERY_BATCH_PREFIXES.map((p) => `${p}%`);
  const [counts, rejected, recs] = await Promise.all([
    db.first<{ candidates: number; judged: number }>(
      `SELECT COUNT(DISTINCT candidate_key) AS candidates, COUNT(DISTINCT CASE WHEN provider IS NOT NULL THEN candidate_key END) AS judged
         FROM decision_records WHERE workspace_id = ? AND project_id = ? AND run_id = ? AND ${notBatch} LIMIT 1`,
      ws,
      pid,
      runId,
      ...batchPatterns,
    ),
    db.all<{ reason_code: string | null; n: number }>(
      `SELECT reason_code, COUNT(DISTINCT candidate_key) AS n FROM decision_records
        WHERE workspace_id = ? AND project_id = ? AND run_id = ? AND outcome = 'rejected' AND ${notBatch}
        GROUP BY reason_code LIMIT ${LIVE_TOTALS_GROUP_CAP}`,
      ws,
      pid,
      runId,
      ...batchPatterns,
    ),
    db.all<{ stage: RecommendationStage; status: RecommendationStatus; n: number }>(
      `SELECT stage, status, COUNT(*) AS n FROM recommendations WHERE workspace_id = ? AND project_id = ? AND run_id = ?
        GROUP BY stage, status LIMIT ${LIVE_TOTALS_GROUP_CAP}`,
      ws,
      pid,
      runId,
    ),
  ]);
  const rejectedByReason: Record<string, number> = {};
  for (const r of rejected) rejectedByReason[r.reason_code ?? "unspecified"] = (rejectedByReason[r.reason_code ?? "unspecified"] ?? 0) + r.n;
  const byStage = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<RecommendationStage, number>;
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<RecommendationStatus, number>;
  let created = 0;
  for (const r of recs) {
    created += r.n;
    if (r.stage in byStage) byStage[r.stage] += r.n;
    if (r.status in byStatus) byStatus[r.status] += r.n;
  }
  return {
    pipeline: { candidates: counts?.candidates ?? 0, judged: counts?.judged ?? 0, rejectedByReason, created, byStage, byStatus },
    truncated: rejected.length >= LIVE_TOTALS_GROUP_CAP || recs.length >= LIVE_TOTALS_GROUP_CAP,
  };
}

type SeoTotals = NonNullable<LiveSeoBoardResponse["totals"]>;

export async function seoTotals(db: Db, ws: string, pid: string, runId: string, crawlId: string | null): Promise<SeoTotals> {
  const elementIds = [...ELEMENT_QUESTION_IDS, ...ACTION_QUESTION_IDS];
  const [elementGroups, linkGroups, ruleGroups, queryGroups, distinct, pipe] = await Promise.all([
    // Element + action rows; an action row counts only for candidates with no element-question row.
    db.all<AnswerGroup>(
      `SELECT question_id, tier, ${ANSWER_GROUP_COLUMNS}, COUNT(*) AS n
         FROM decision_records
        WHERE workspace_id = ? AND project_id = ? AND run_id = ? AND question_id IN (${ph(elementIds.length)})
          AND NOT (question_id IN (${ph(ACTION_QUESTION_IDS.length)}) AND candidate_key IN (
                SELECT candidate_key FROM decision_records
                 WHERE workspace_id = ? AND project_id = ? AND run_id = ? AND question_id IN (${ph(ELEMENT_QUESTION_IDS.length)})))
        GROUP BY question_id, tier, atype, yes, choice LIMIT ${LIVE_TOTALS_GROUP_CAP}`,
      ws,
      pid,
      runId,
      ...elementIds,
      ...ACTION_QUESTION_IDS,
      ws,
      pid,
      runId,
      ...ELEMENT_QUESTION_IDS,
    ),
    db.all<{ st: string | null; n: number }>(
      `SELECT json_extract(${A}, '$.suggestionTier') AS st, COUNT(*) AS n FROM decision_records
        WHERE workspace_id = ? AND project_id = ? AND run_id = ? AND ${LINK_ROW_SQL}
        GROUP BY st LIMIT ${LIVE_TOTALS_GROUP_CAP}`,
      ws,
      pid,
      runId,
      ...LINK_KINDS,
    ),
    crawlId
      ? db.all<{ rule_id: string; n: number }>(
          `SELECT rule_id, COUNT(*) AS n FROM audit_findings
            WHERE workspace_id = ? AND project_id = ? AND crawl_run_id = ? AND rule_id IN (${ph(ELEMENT_RULE_IDS.length)})
            GROUP BY rule_id LIMIT ${LIVE_TOTALS_GROUP_CAP}`,
          ws,
          pid,
          crawlId,
          ...ELEMENT_RULE_IDS,
        )
      : Promise.resolve([] as Array<{ rule_id: string; n: number }>),
    db.all<AnswerGroup>(
      `SELECT question_id, tier, ${ANSWER_GROUP_COLUMNS}, COUNT(*) AS n
         FROM decision_records
        WHERE workspace_id = ? AND project_id = ? AND run_id = ? AND question_id IN (${ph(QUERY_QUESTION_IDS.length)})
        GROUP BY question_id, tier, atype, yes, choice LIMIT ${LIVE_TOTALS_GROUP_CAP}`,
      ws,
      pid,
      runId,
      ...QUERY_QUESTION_IDS,
    ),
    // Distinct queries with stored text: the normalized query of query-batch keys, else answer_json.query.
    db.first<{ n: number }>(
      `SELECT COUNT(DISTINCT CASE WHEN candidate_key LIKE 'qrel:%' THEN substr(candidate_key, 6)
                                  WHEN candidate_key LIKE 'buyer:%' THEN substr(candidate_key, 7)
                                  WHEN json_type(${A}, '$.query') = 'text' THEN lower(trim(json_extract(${A}, '$.query'))) END) AS n
         FROM decision_records
        WHERE workspace_id = ? AND project_id = ? AND run_id = ? AND question_id IN (${ph(QUERY_QUESTION_IDS.length)}) LIMIT 1`,
      ws,
      pid,
      runId,
      ...QUERY_QUESTION_IDS,
    ),
    pipelineTotals(db, ws, pid, runId),
  ]);

  const elements: SeoTotals["elements"] = { judged: 0, keep: 0, change: 0, review: 0, byElement: {} };
  const count = (element: LiveSeoElement, verdict: LiveSeoVerdict, n: number) => {
    elements.judged += n;
    elements[verdict] += n;
    const b = elements.byElement[element] ?? { keep: 0, change: 0, review: 0 };
    b[verdict] += n;
    elements.byElement[element] = b;
  };
  for (const g of elementGroups) {
    const j = judgeElement(g.question_id, groupAnswer(g), tierOf(g.tier));
    if (j) count(j.element, j.verdict, g.n);
  }
  for (const g of linkGroups) {
    // Same rule as judgeLinkSuggestion: the suggester's act tier = change, anything else = review.
    count(LIVE_SEO_ELEMENT_MAP.linkSuggestion.element, g.st === "act" ? "change" : "review", g.n);
  }
  for (const g of ruleGroups) {
    const j = judgeRule(g.rule_id, ruleClass(g.rule_id));
    if (j) count(j.element, j.verdict, g.n);
  }

  const queries: SeoTotals["queries"] = {
    distinct: distinct?.n ?? 0,
    relevance: emptyBand(),
    buyer: emptyBand(),
    buyerReady: emptyBand(),
    intent: {},
  };
  const bandOf: Partial<Record<string, LiveBandCounts>> = {
    [QUESTION.queryRelevance]: queries.relevance,
    [QUESTION.buyerQuery]: queries.buyer,
    [QUESTION.buyerReady]: queries.buyerReady,
  };
  for (const g of queryGroups) {
    const tier = tierOf(g.tier);
    if (g.question_id === QUESTION.queryIntent) {
      // Intent counts per stored option, act and flag tiers only (a drop-tier option is not an answer).
      if (g.atype === "choice" && g.choice !== null && (tier === "act" || tier === "flag")) queries.intent[g.choice] = (queries.intent[g.choice] ?? 0) + g.n;
      continue;
    }
    const target = bandOf[g.question_id];
    if (!target) continue;
    const band = queryBand(storedAnswer(groupAnswer(g)), tier);
    target[band ?? "unanswered"] += g.n;
  }

  const truncated =
    pipe.truncated ||
    [elementGroups, linkGroups, ruleGroups, queryGroups].some((list) => list.length >= LIVE_TOTALS_GROUP_CAP);
  return { elements, queries, pipeline: pipe.pipeline, truncated };
}

// ------------------------------------------------------------------ the run's Search Console sync

export async function runGscSync(db: Db, ws: string, pid: string, runId: string): Promise<LiveGscSync | null> {
  const s = await db.first<{
    id: string;
    source: LiveGscSync["source"];
    status: LiveGscSync["status"];
    window_start: string;
    window_end: string;
    prev_window_start: string;
    prev_window_end: string;
    rows_fetched: number;
    row_cap: number;
    truncated: number;
    error: string | null;
    synced_at: string;
  }>(
    `SELECT id, source, status, window_start, window_end, prev_window_start, prev_window_end, rows_fetched, row_cap, truncated, error, synced_at
       FROM gsc_syncs WHERE workspace_id = ? AND project_id = ? AND run_id = ? ORDER BY synced_at DESC, rowid DESC LIMIT 1`,
    ws,
    pid,
    runId,
  );
  if (!s) return null;
  return {
    id: s.id,
    source: s.source,
    status: s.status,
    window: { start: s.window_start, end: s.window_end },
    previousWindow: { start: s.prev_window_start, end: s.prev_window_end },
    rowsFetched: s.rows_fetched,
    rowCap: s.row_cap,
    truncated: s.truncated === 1,
    syncedAt: s.synced_at,
    error: s.error ? clip(s.error, 200) : null,
  };
}

/** Exposed for tests and docs: the element map version the feed computes with. */
export const LIVE_SEO_FEED_VERSION = LIVE_ELEMENTS_VERSION;
