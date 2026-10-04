/**
 * [A37] GEO prompts from Search Console question queries (owner request 2026-10-04: "You can also use GSC for a
 * question instead of a sheet"). A deterministic, free prompt source next to manual entry, the writer suggestions
 * (POST /geo/prompts/generate, paid) and the master-sheet "AI Questions" import: the question-style queries people
 * already typed into Google for this site, read from the project's STORED Search Console sync. No provider call, no
 * Jev, no writer; nothing is rewritten.
 *
 * Method (GSC_QUESTION_RULES_VERSION):
 *  1. Source: the latest usable sync (completed or partial; seo/gsc/overview.ts latestUsableSync), its current-window
 *     query rows (gsc_metrics, window 'current', query IS NOT NULL), read in keyset pages of GSC_QUESTION_PAGE_ROWS
 *     (at most GSC_QUESTION_MAX_ROWS rows). Rows are summed per normalized query (seo/gsc/demand.ts
 *     normalizeDemandQuery): clicks, impressions; position = impression-weighted mean of the query's rows (a labelled
 *     approximation; null for CSV imports, which store no usable position); landing page = the page with the most
 *     impressions for the query (null when the sync has no page rows).
 *  2. English only (seo/gsc/demand.ts isEnglish on the project language): the rule list is an English word list;
 *     other languages get state 'disabled' and no candidates (never guessed).
 *  3. A query is a question query when it has at least GSC_QUESTION_MIN_WORDS words and matches at least one rule
 *     (whole words after lowercasing and replacing punctuation with spaces):
 *       wh_start            first word is how / what / which / why / where / when / who          (interrogative)
 *       wh_word             one of those words appears later in the query ("brass knobs how to clean")
 *       aux_start           first word is does / do / is / are / should, or "can" followed by a pronoun or
 *                           determiner (i, you, we, they, it, he, she, a, an, the, my, your, our, this, that,
 *                           these, those, there): "can lights for kitchen" is a product, not a question  (interrogative)
 *       best                "best" anywhere
 *       top                 "top" as the first word, or followed by a number ("top 10 brass finishes"); "vanity top" is not
 *       vs                  "vs" / "versus" anywhere ("vs." included)
 *       difference_between  the phrase "difference between"
 *       ideas               "ideas" anywhere
 *       guide               "guide" anywhere
 *       review              "review" / "reviews" anywhere
 *       alternatives        "alternatives" anywhere, or the phrase "alternative to"
 *       compare             "compare" / "comparison" anywhere
 *     Queries containing a search operator or a URL ("site:", "inurl:", "://", "www.") and queries longer than
 *     MAX_PROMPT_LENGTH characters are skipped.
 *  4. Brand: self-brand queries (seo/gsc/brand.ts via projectBrandClassifier) are excluded by default (includeBrand
 *     keeps them). Every kept query is then checked with the prompt sets' own brand-blind rule (geo/prompts.ts
 *     brandBlindViolations): a query naming a tracked brand, alias, competitor or tracked domain becomes a REPUTATION
 *     prompt (reported separately, never in the default visibility metrics), exactly like a sheet import.
 *  5. Near-duplicates: queries with the same normalized token set (words sorted and deduplicated, "a", "an", "the"
 *     dropped) are merged; the query with the most impressions is kept and the others are listed as its variants.
 *  6. Exclusions: queries already in the active prompt set (geo prompt key: shared/import.ts promptKey, or the same
 *     token set) and queries added from Search Console earlier that you then removed from the set (provenance below)
 *     are not suggested.
 *  7. Rank by impressions desc, then clicks desc, then query asc; show at most GSC_QUESTION_CANDIDATE_CAP.
 *  8. Prompt text = the query as typed: trimmed, spaces collapsed, first letter capitalized, and "?" appended for
 *     interrogatives (wh_start / aux_start) that do not already end with one. No other rewriting.
 *
 * Adding (POST): the selected keys are matched again against a fresh computation (no client text is trusted), then
 * saved through geo/prompts.ts savePromptSet as UNAPPROVED prompts in a new prompt-set version labelled "Added from
 * Search Console <date>", with the same caps and checks as PUT /geo/prompts (25 per set, brand-blind, duplicates).
 * geo_prompts has no source column, so provenance is stored the way imported prompts store theirs, without a
 * migration: one import_records row per prompt (destination 'gsc_prompts', record_key = promptKey(text),
 * source_key 'gsc:<syncId>', data_json = the evidence). Sheet imports use destination 'geo_prompts', so the two never
 * collide. Every query filters by workspace_id and project_id; no statement binds more than a handful of parameters.
 *
 * Exported for a future Ask Okara tool (chat files are owned by another module): buildGscQuestions,
 * addGscQuestionPrompts, matchQuestionRules, promptTextFromQuery.
 */
import type { GeoPromptSet } from "@shared/types";
import { promptKey } from "@shared/import";
import type {
  GscAddedPrompt,
  GscQuestionCandidate,
  GscQuestionCounts,
  GscQuestionEvidence,
  GscQuestionRule,
  GscQuestionsAddResult,
  GscQuestionsResponse,
} from "@shared/gsc-questions";
import type { Db } from "../lib/db";
import { parseJson } from "../lib/db";
import { badRequest, conflict, setupRequired } from "../lib/errors";
import { stableStringify } from "../lib/hash";
import { newId } from "../lib/ids";
import { iso, utcDay } from "../lib/time";
import type { ProjectRow } from "../platform/access";
import { weightedPosition } from "../seo/gsc/aggregate";
import { isEnglish, normalizeDemandQuery } from "../seo/gsc/demand";
import { latestUsableSync, projectBrandClassifier, type SyncRow } from "../seo/gsc/overview";
import { windowLabel } from "../seo/gsc/windows";
import { brandBlindViolations, getActivePromptSet, MAX_PROMPT_LENGTH, MAX_PROMPTS_PER_SET, savePromptSet, type PromptInput } from "./prompts";

export const GSC_QUESTION_RULES_VERSION = "gsc-questions-en-2026-10-04.1";
export const GSC_QUESTION_MIN_WORDS = 3;
/** Candidates returned (display cap). */
export const GSC_QUESTION_CANDIDATE_CAP = 50;
/** Queries one POST may add (the set itself holds MAX_PROMPTS_PER_SET). */
export const GSC_QUESTION_MAX_ADD = 25;
/** Stored rows read per page (keyset on gsc_metrics.id). */
export const GSC_QUESTION_PAGE_ROWS = 2000;
/** Hard ceiling on stored rows read per request. */
export const GSC_QUESTION_MAX_ROWS = 50_000;
/** import_records destination holding the provenance of prompts added from Search Console. */
export const GSC_PROMPTS_DESTINATION = "gsc_prompts";

export const WH_WORDS: ReadonlySet<string> = new Set(["how", "what", "which", "why", "where", "when", "who"]);
export const AUX_START_WORDS: ReadonlySet<string> = new Set(["does", "do", "is", "are", "should"]);
/** Words that may follow a leading "can" for it to read as a question ("can i ...", "can the ..."). */
export const CAN_FOLLOWERS: ReadonlySet<string> = new Set(["i", "you", "we", "they", "it", "he", "she", "a", "an", "the", "my", "your", "our", "this", "that", "these", "those", "there"]);
/** Single-word rules (whole words, anywhere in the query). */
export const WORD_RULES = {
  best: new Set(["best"]),
  vs: new Set(["vs", "versus"]),
  ideas: new Set(["ideas"]),
  guide: new Set(["guide"]),
  review: new Set(["review", "reviews"]),
  alternatives: new Set(["alternatives"]),
  compare: new Set(["compare", "comparison"]),
} as const satisfies Record<string, ReadonlySet<string>>;
const FILLER: ReadonlySet<string> = new Set(["a", "an", "the"]);

export const GSC_QUESTION_LABELS = {
  method:
    "Question queries: Search Console queries of at least 3 words that start with or contain a question word (how, what, which, why, where, when, who; does, do, is, are, should, can I/you/…) or read like an AI-style ask (best, top, vs, difference between, ideas, guide, review, alternatives, compare). English only; self-brand queries are left out; near-duplicates are merged.",
  verbatim: "Each prompt is the query exactly as searchers typed it (only trimmed, capitalized, with \"?\" for questions). Added prompts stay unapproved until you approve them.",
  notVolume: "Impressions and clicks are from your own Search Console data for the stated window, not market search volume.",
  position: "Position is an impression-weighted average of query+page rows (an approximation, not Google's aggregate).",
  noGsc: "No Search Console data is stored yet. Connect Search Console on the Integrations page (or import a Queries CSV export) and run a Search Console sync; question queries then appear here.",
  demo: "Demo data: the queries come from the demo project's fictional Search Console sync.",
} as const;

// ------------------------------------------------------------------ pure: rules, text, keys
const words = (q: string) =>
  q
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

export interface RuleMatch {
  rules: GscQuestionRule[];
  /** wh_start or aux_start: the prompt text gets a "?". */
  interrogative: boolean;
}

/** Which question rules a query matches (empty when none). English rule list; pure. */
export function matchQuestionRules(query: string): RuleMatch {
  const w = words(query);
  const rules: GscQuestionRule[] = [];
  if (w.length === 0) return { rules, interrogative: false };
  const first = w[0]!;
  if (WH_WORDS.has(first)) rules.push("wh_start");
  else if (w.slice(1).some((x) => WH_WORDS.has(x))) rules.push("wh_word");
  if (AUX_START_WORDS.has(first) || (first === "can" && w.length > 1 && CAN_FOLLOWERS.has(w[1]!))) rules.push("aux_start");
  const has = (set: ReadonlySet<string>) => w.some((x) => set.has(x));
  const phrase = (a: string, b: string) => w.some((x, i) => x === a && w[i + 1] === b);
  if (has(WORD_RULES.best)) rules.push("best");
  if (first === "top" || w.some((x, i) => x === "top" && i + 1 < w.length && /^\d+$/.test(w[i + 1]!))) rules.push("top");
  if (has(WORD_RULES.vs)) rules.push("vs");
  if (phrase("difference", "between")) rules.push("difference_between");
  if (has(WORD_RULES.ideas)) rules.push("ideas");
  if (has(WORD_RULES.guide)) rules.push("guide");
  if (has(WORD_RULES.review)) rules.push("review");
  if (has(WORD_RULES.alternatives) || phrase("alternative", "to")) rules.push("alternatives");
  if (has(WORD_RULES.compare)) rules.push("compare");
  return { rules, interrogative: rules.includes("wh_start") || rules.includes("aux_start") };
}

/** Search operators and URLs are not questions people ask an assistant. */
export function looksLikeOperatorOrUrl(query: string): boolean {
  return /(^|\s)(site|inurl|intitle|filetype|related|cache):/i.test(query) || /:\/\//.test(query) || /\bwww\./i.test(query);
}

/** The query as typed: trimmed, spaces collapsed, first letter capitalized, "?" for interrogatives. Pure. */
export function promptTextFromQuery(query: string, interrogative: boolean): string {
  let t = query.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!t) return t;
  t = t.charAt(0).toLocaleUpperCase("en-US") + t.slice(1);
  if (interrogative && !/[?？]$/u.test(t)) t = `${t.replace(/[.!\s]+$/u, "")}?`;
  return t;
}

/** Near-duplicate key: sorted, deduplicated words without "a", "an", "the". */
export function tokenSetKey(text: string): string {
  return [...new Set(words(text).filter((x) => !FILLER.has(x)))].sort().join(" ");
}

const wordCount = (q: string) => words(q).length;

// ------------------------------------------------------------------ pure: selection
export interface AggregatedQuery {
  query: string;
  key: string;
  clicks: number;
  impressions: number;
  position: number | null;
  landingPage: string | null;
}

export interface SelectOptions {
  includeBrand: boolean;
  isSelfBrand: (q: string) => boolean;
  /** Brand-blind check of the prompt sets (true = names a tracked brand/alias/competitor/domain). */
  namesTrackedBrand: (text: string) => boolean;
  /** promptKey and tokenSetKey of every prompt in the active set. */
  existingKeys: ReadonlySet<string>;
  /** promptKeys of prompts added from Search Console earlier and since removed from the set. */
  removedKeys: ReadonlySet<string>;
  evidenceBase: Omit<GscQuestionEvidence, "query" | "impressions" | "clicks" | "position" | "landingPage">;
  /** Cap on returned candidates (Infinity for validation). */
  cap: number;
}

export interface Selection {
  candidates: GscQuestionCandidate[];
  counts: Omit<GscQuestionCounts, "rowsRead">;
}

const byImpressions = (a: AggregatedQuery, b: AggregatedQuery) =>
  b.impressions - a.impressions || b.clicks - a.clicks || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** Rules, brand, near-duplicate and existing-prompt filters, ranking and cap. Pure. */
export function selectQuestionCandidates(queries: AggregatedQuery[], o: SelectOptions): Selection {
  const counts = { queries: queries.length, questionQueries: 0, brandExcluded: 0, alreadyInSet: 0, removedEarlier: 0, mergedDuplicates: 0, eligible: 0 };
  const matched: Array<{ q: AggregatedQuery; m: RuleMatch }> = [];
  for (const q of queries) {
    if (q.impressions <= 0) continue;
    if (wordCount(q.query) < GSC_QUESTION_MIN_WORDS || q.query.length > MAX_PROMPT_LENGTH || looksLikeOperatorOrUrl(q.query)) continue;
    const m = matchQuestionRules(q.query);
    if (m.rules.length === 0) continue;
    counts.questionQueries++;
    if (!o.includeBrand && o.isSelfBrand(q.query)) {
      counts.brandExcluded++;
      continue;
    }
    matched.push({ q, m });
  }
  matched.sort((a, b) => byImpressions(a.q, b.q));
  const groups = new Map<string, { head: { q: AggregatedQuery; m: RuleMatch }; variants: AggregatedQuery[] }>();
  for (const x of matched) {
    const k = tokenSetKey(x.q.query);
    const g = groups.get(k);
    if (g) {
      g.variants.push(x.q);
      counts.mergedDuplicates++;
    } else groups.set(k, { head: x, variants: [] });
  }
  const candidates: GscQuestionCandidate[] = [];
  for (const [tokens, g] of groups) {
    const { q, m } = g.head;
    const text = promptTextFromQuery(q.query, m.interrogative);
    const pk = promptKey(text);
    if (o.existingKeys.has(pk) || o.existingKeys.has(tokens) || g.variants.some((v) => o.existingKeys.has(promptKey(v.query)))) {
      counts.alreadyInSet++;
      continue;
    }
    if (o.removedKeys.has(pk)) {
      counts.removedEarlier++;
      continue;
    }
    counts.eligible++;
    if (candidates.length >= o.cap) continue;
    candidates.push({
      key: q.key,
      text,
      promptType: o.namesTrackedBrand(text) ? "reputation" : "discovery",
      rules: m.rules,
      evidence: { ...o.evidenceBase, query: q.query, impressions: q.impressions, clicks: q.clicks, position: q.position, landingPage: q.landingPage },
      variants: g.variants.slice(0, 10).map((v) => ({ query: v.query, impressions: v.impressions })),
    });
  }
  return { candidates, counts };
}

// ------------------------------------------------------------------ stored rows
type GscQueryRow = { id: number; query: string; page: string | null; clicks: number; impressions: number; position: number };

/** Current-window query rows of a sync in keyset pages (bounded statement size, at most GSC_QUESTION_MAX_ROWS). */
export async function readQuestionRows(db: Db, workspaceId: string, projectId: string, syncId: string, maxRows = GSC_QUESTION_MAX_ROWS): Promise<{ rows: GscQueryRow[]; truncated: boolean }> {
  const rows: GscQueryRow[] = [];
  let after = 0;
  for (;;) {
    const limit = Math.min(GSC_QUESTION_PAGE_ROWS, maxRows - rows.length);
    if (limit <= 0) return { rows, truncated: true };
    const page = await db.all<GscQueryRow>(
      `SELECT id, query, page, clicks, impressions, position FROM gsc_metrics
        WHERE workspace_id = ? AND project_id = ? AND sync_id = ? AND window = 'current' AND query IS NOT NULL AND id > ?
        ORDER BY id LIMIT ?`,
      workspaceId,
      projectId,
      syncId,
      after,
      limit,
    );
    rows.push(...page);
    if (page.length < limit) return { rows, truncated: false };
    after = page[page.length - 1]!.id;
  }
}

/** Rows summed per normalized query, with the weighted position and the top landing page. Pure. */
export function aggregateQueryRows(rows: GscQueryRow[], positionAvailable: boolean): AggregatedQuery[] {
  const by = new Map<string, { query: string; clicks: number; impressions: number; parts: Array<{ page: string | null; impressions: number; position: number }> }>();
  for (const r of rows) {
    if (typeof r.query !== "string") continue;
    const key = normalizeDemandQuery(r.query);
    if (!key) continue;
    const a = by.get(key) ?? { query: r.query.replace(/\s+/g, " ").trim(), clicks: 0, impressions: 0, parts: [] };
    a.clicks += Math.max(0, Math.round(Number(r.clicks) || 0));
    a.impressions += Math.max(0, Math.round(Number(r.impressions) || 0));
    a.parts.push({ page: r.page, impressions: Math.max(0, Math.round(Number(r.impressions) || 0)), position: Number(r.position) || 0 });
    by.set(key, a);
  }
  return [...by.entries()].map(([key, a]) => {
    const pages = new Map<string, number>();
    for (const p of a.parts) if (p.page) pages.set(p.page, (pages.get(p.page) ?? 0) + p.impressions);
    const top = [...pages.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0];
    const pos = positionAvailable ? weightedPosition(a.parts.filter((p) => p.position > 0)) : null;
    return { query: a.query, key, clicks: a.clicks, impressions: a.impressions, position: pos === null ? null : Math.round(pos * 10) / 10, landingPage: top?.[0] ?? null };
  });
}

// ------------------------------------------------------------------ provenance
interface RecordRow {
  record_key: string;
  label: string;
  status: string;
  data_json: string;
  created_at: string;
  updated_at: string;
}

/** Prompts added from Search Console (bounded; empty when migration 0015 is missing). */
export async function gscPromptRecords(db: Db, workspaceId: string, projectId: string): Promise<RecordRow[]> {
  try {
    return await db.all<RecordRow>(
      "SELECT record_key, label, status, data_json, created_at, updated_at FROM import_records WHERE workspace_id = ? AND project_id = ? AND destination = ? ORDER BY created_at, rowid LIMIT 2000",
      workspaceId,
      projectId,
      GSC_PROMPTS_DESTINATION,
    );
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------ build (GET)
export interface BuildOptions {
  includeBrand?: boolean;
  /** Candidate cap (default GSC_QUESTION_CANDIDATE_CAP). */
  cap?: number;
  maxRows?: number;
}

const emptyCounts = (): GscQuestionCounts => ({ rowsRead: 0, queries: 0, questionQueries: 0, brandExcluded: 0, alreadyInSet: 0, removedEarlier: 0, mergedDuplicates: 0, eligible: 0 });

export function syncLabel(sync: Pick<SyncRow, "synced_at" | "window_start" | "window_end" | "source">): string {
  return `Search Console, stored sync ${sync.synced_at.slice(0, 10)}, window ${windowLabel({ start: sync.window_start, end: sync.window_end })}${sync.source === "csv_import" ? " (CSV import)" : sync.source === "demo" ? " (demo data)" : ""}`;
}

/** Question-query candidates from the project's latest usable stored Search Console sync. Read-only. */
export async function buildGscQuestions(db: Db, project: ProjectRow, opts: BuildOptions = {}): Promise<GscQuestionsResponse> {
  const includeBrand = opts.includeBrand === true;
  const cap = opts.cap ?? GSC_QUESTION_CANDIDATE_CAP;
  const active = await getActivePromptSet(db, project.workspace_id, project.id);
  const records = await gscPromptRecords(db, project.workspace_id, project.id);
  const activeKeys = new Set((active?.prompts ?? []).map((p) => promptKey(p.text)));
  const added: GscAddedPrompt[] = records
    .filter((r) => r.status === "in_set" && activeKeys.has(r.record_key))
    .map((r) => ({ key: r.record_key, text: r.label, status: "in_set", addedAt: r.created_at, evidence: parseJson<{ evidence?: GscQuestionEvidence }>(r.data_json, {}).evidence ?? null }));
  const base: GscQuestionsResponse = {
    state: "setup_required",
    message: null,
    methodVersion: GSC_QUESTION_RULES_VERSION,
    sync: null,
    labels: [],
    candidates: [],
    counts: emptyCounts(),
    cap,
    includeBrand,
    promptSet: active ? { id: active.id, version: active.version, size: active.prompts.length, room: Math.max(0, MAX_PROMPTS_PER_SET - active.prompts.length), max: MAX_PROMPTS_PER_SET } : null,
    added,
  };
  const isDemo = project.is_demo === 1;
  const sync = await latestUsableSync(db, project.workspace_id, project.id);
  if (!sync) return { ...base, state: isDemo ? "demo" : "setup_required", message: GSC_QUESTION_LABELS.noGsc, labels: [GSC_QUESTION_LABELS.noGsc] };
  const window = { start: sync.window_start, end: sync.window_end };
  const syncInfo: GscQuestionsResponse["sync"] = { id: sync.id, source: sync.source, syncedAt: sync.synced_at, window, status: sync.status === "partial" ? "partial" : "completed", truncated: sync.truncated === 1 };
  if (!isEnglish(project.language)) {
    return {
      ...base,
      state: "disabled",
      sync: syncInfo,
      message: `Question detection uses an English word list; this project's language is "${project.language}", so no queries are suggested (never guessed).`,
      labels: [syncLabel(sync)],
    };
  }
  const { rows, truncated } = await readQuestionRows(db, project.workspace_id, project.id, sync.id, opts.maxRows);
  const queries = aggregateQueryRows(rows, sync.source !== "csv_import");
  const classifier = await projectBrandClassifier(db, project);
  const existingKeys = new Set<string>();
  for (const p of active?.prompts ?? []) {
    existingKeys.add(promptKey(p.text));
    existingKeys.add(tokenSetKey(p.text));
  }
  const removedKeys = new Set(records.filter((r) => r.status === "in_set" && !activeKeys.has(r.record_key)).map((r) => r.record_key));
  const sel = selectQuestionCandidates(queries, {
    includeBrand,
    isSelfBrand: (q) => classifier.isSelfBrand(q),
    namesTrackedBrand: (text) => brandBlindViolations(text, project).length > 0,
    existingKeys,
    removedKeys,
    evidenceBase: { source: "gsc", window, syncId: sync.id, syncedAt: sync.synced_at, syncSource: sync.source },
    cap,
  });
  const counts: GscQuestionCounts = { rowsRead: rows.length, ...sel.counts };
  const labels: string[] = [syncLabel(sync)];
  if (sync.status === "partial") labels.push("The stored sync is partial: some rows may be missing.");
  if (sync.truncated === 1 || truncated) labels.push(truncated ? `Only the first ${rows.length.toLocaleString("en-US")} stored query rows were read.` : "The sync reached its row cap; anonymized and low-volume queries are not in the stored data.");
  labels.push(GSC_QUESTION_LABELS.method, GSC_QUESTION_LABELS.verbatim, GSC_QUESTION_LABELS.notVolume);
  if (sync.source !== "csv_import") labels.push(GSC_QUESTION_LABELS.position);
  if (isDemo || sync.source === "demo") labels.unshift(GSC_QUESTION_LABELS.demo);
  const excluded = [
    !includeBrand && counts.brandExcluded ? `${counts.brandExcluded} brand ${counts.brandExcluded === 1 ? "query" : "queries"} left out` : null,
    counts.alreadyInSet ? `${counts.alreadyInSet} already in the prompt set` : null,
    counts.removedEarlier ? `${counts.removedEarlier} added earlier and removed by you (not suggested again; add them by hand if wanted)` : null,
    counts.mergedDuplicates ? `${counts.mergedDuplicates} near-duplicate${counts.mergedDuplicates === 1 ? "" : "s"} merged` : null,
  ].filter(Boolean);
  if (excluded.length) labels.push(`${excluded.join("; ")}.`);
  return { ...base, state: isDemo || sync.source === "demo" ? "demo" : "ready", sync: syncInfo, labels, candidates: sel.candidates, counts };
}

// ------------------------------------------------------------------ add (POST)
export interface AddInput {
  /** Query keys (or the queries themselves) from GET candidates. */
  queries: string[];
  /** Active prompt-set id the client saw; a different active set is a 409 (reload first). */
  setId?: string | null;
  includeBrand?: boolean;
}

/**
 * Add selected question queries as UNAPPROVED prompts (new prompt-set version through savePromptSet: same caps and
 * checks as PUT /geo/prompts) and record their Search Console provenance.
 */
export async function addGscQuestionPrompts(db: Db, project: ProjectRow, input: AddInput, now: Date): Promise<GscQuestionsAddResult> {
  if (input.queries.length === 0) throw badRequest("Select at least one query.");
  if (input.queries.length > GSC_QUESTION_MAX_ADD) throw badRequest(`At most ${GSC_QUESTION_MAX_ADD} queries per request.`);
  const built = await buildGscQuestions(db, project, { includeBrand: input.includeBrand === true, cap: Number.POSITIVE_INFINITY });
  if (!built.sync) throw setupRequired(built.message ?? GSC_QUESTION_LABELS.noGsc);
  if (built.state === "disabled") throw badRequest(built.message ?? "Question detection is not available for this project.");
  const active = await getActivePromptSet(db, project.workspace_id, project.id);
  if (input.setId !== undefined && input.setId !== null && (active?.id ?? null) !== input.setId) {
    throw conflict("The prompt set changed since these suggestions were loaded. Reload the page and select again.");
  }
  if (input.setId === null && active) throw conflict("A prompt set was saved since these suggestions were loaded. Reload the page and select again.");
  const byKey = new Map<string, GscQuestionCandidate>();
  for (const c of built.candidates) {
    byKey.set(c.key, c);
    for (const v of c.variants) if (!byKey.has(normalizeDemandQuery(v.query))) byKey.set(normalizeDemandQuery(v.query), c);
  }
  const activeKeys = new Set((active?.prompts ?? []).map((p) => promptKey(p.text)));
  const chosen: GscQuestionCandidate[] = [];
  const skipped: GscQuestionsAddResult["skipped"] = [];
  const seen = new Set<string>();
  for (const raw of input.queries) {
    const key = normalizeDemandQuery(raw);
    const c = byKey.get(key);
    if (!c) {
      const asText = promptKey(raw);
      skipped.push({
        query: raw.slice(0, 200),
        reason: activeKeys.has(asText) || activeKeys.has(promptKey(`${raw}?`))
          ? "already in the prompt set"
          : "not a question query in the latest stored Search Console sync (or already in the set, brand, or removed earlier)",
      });
      continue;
    }
    if (seen.has(c.key)) {
      skipped.push({ query: raw.slice(0, 200), reason: "duplicate of another selected query" });
      continue;
    }
    seen.add(c.key);
    chosen.push(c);
  }
  if (chosen.length === 0) throw badRequest("None of the selected queries can be added.", { skipped });
  const size = active?.prompts.length ?? 0;
  const room = Math.max(0, MAX_PROMPTS_PER_SET - size);
  if (chosen.length > room) {
    throw badRequest(
      `The prompt set holds at most ${MAX_PROMPTS_PER_SET} prompts and has ${size}, so ${room === 0 ? "nothing more can be added" : `at most ${room} more can be added`}. Select fewer queries or remove prompts first.`,
      { room, requested: chosen.length, max: MAX_PROMPTS_PER_SET },
    );
  }
  const kept: PromptInput[] = (active?.prompts ?? []).map((p) => ({ text: p.text, promptType: p.promptType, stage: p.stage, approved: p.approved }));
  const next: PromptInput[] = [...kept, ...chosen.map((c) => ({ text: c.text, promptType: c.promptType, stage: null, approved: false }))];
  const set: GeoPromptSet = await savePromptSet(db, project, next, now, { label: `Added from Search Console ${utcDay(now)}` });
  const addId = newId("gqa");
  const at = iso(now);
  const stmts: Array<[string, ...unknown[]]> = chosen.map((c) => [
    `INSERT INTO import_records (id, workspace_id, project_id, destination, record_key, label, status, data_json, source_key, first_import_id, last_import_id, created_at, updated_at, removed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
     ON CONFLICT (project_id, destination, record_key) DO UPDATE SET
       label = excluded.label, status = excluded.status, data_json = excluded.data_json, source_key = excluded.source_key,
       last_import_id = excluded.last_import_id, created_at = excluded.created_at, updated_at = excluded.updated_at, removed_at = NULL`,
    newId("irec"),
    project.workspace_id,
    project.id,
    GSC_PROMPTS_DESTINATION,
    promptKey(c.text),
    c.text.slice(0, 500),
    "in_set",
    stableStringify({ evidence: c.evidence, promptType: c.promptType, rules: c.rules, methodVersion: GSC_QUESTION_RULES_VERSION, setVersion: set.version }),
    `gsc:${c.evidence.syncId}`,
    addId,
    addId,
    at,
    at,
  ]);
  try {
    for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  } catch {
    // Provenance only (migration 0015 missing): the prompts are saved; the page shows them without the source note.
  }
  return { set, added: chosen.map((c) => ({ text: c.text, promptType: c.promptType, evidence: c.evidence })), skipped };
}
