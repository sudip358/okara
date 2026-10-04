/**
 * [A37] GEO prompts from Search Console question queries: shared API shapes (worker <-> web).
 * Kept in its own module so the GEO prompts page, the Live GEO container and a future Ask Okara tool
 * share one contract. Every string that came from Search Console (queries, landing pages) is untrusted
 * text: the UI renders it as plain text only.
 */
import type { DateWindow, GeoPromptSet } from "./types";

/** Rule ids of the question-query rule list (src/worker/geo/gsc-questions.ts, GSC_QUESTION_RULES_VERSION). */
export type GscQuestionRule =
  | "wh_start"
  | "wh_word"
  | "aux_start"
  | "best"
  | "top"
  | "vs"
  | "difference_between"
  | "ideas"
  | "guide"
  | "review"
  | "alternatives"
  | "compare";

/** What the stored sync says about one query (the evidence carried into the prompt's provenance). */
export interface GscQuestionEvidence {
  source: "gsc";
  /** The query exactly as Search Console stored it. */
  query: string;
  impressions: number;
  clicks: number;
  /** Impression-weighted mean of the query's rows (approximation); null for CSV imports. */
  position: number | null;
  /** The page with the most impressions for the query; null when the sync has no page rows (CSV query export). */
  landingPage: string | null;
  window: DateWindow;
  syncId: string;
  syncedAt: string;
  syncSource: "api" | "csv_import" | "demo";
}

export interface GscQuestionCandidate {
  /** normalizeDemandQuery(query): the key POST accepts. */
  key: string;
  /** Prompt text: the query as typed, lightly normalized (trim, spaces collapsed, first letter capitalized, "?" for interrogatives). */
  text: string;
  /** discovery unless the text names a tracked brand, alias or domain (then reputation, reported separately). */
  promptType: "discovery" | "reputation";
  rules: GscQuestionRule[];
  evidence: GscQuestionEvidence;
  /** Near-duplicate queries merged into this one (same normalized token set), by impressions. */
  variants: Array<{ query: string; impressions: number }>;
}

export interface GscQuestionCounts {
  /** Stored current-window query rows read. */
  rowsRead: number;
  /** Distinct normalized queries. */
  queries: number;
  /** Queries matching a question rule with at least the minimum word count. */
  questionQueries: number;
  brandExcluded: number;
  alreadyInSet: number;
  /** Added from Search Console earlier and then removed from the set by you: not suggested again. */
  removedEarlier: number;
  /** Near-duplicates merged into a higher-impression query. */
  mergedDuplicates: number;
  /** Candidates after every exclusion (before the display cap). */
  eligible: number;
}

/** A prompt added from Search Console (provenance kept in import_records, destination 'gsc_prompts'). */
export interface GscAddedPrompt {
  key: string;
  text: string;
  status: "in_set";
  addedAt: string;
  evidence: GscQuestionEvidence | null;
}

export interface GscQuestionsResponse {
  state: "ready" | "setup_required" | "disabled" | "demo";
  /** Why there are no candidates (setup / language), plain text. */
  message: string | null;
  methodVersion: string;
  sync: { id: string; source: "api" | "csv_import" | "demo"; syncedAt: string; window: DateWindow; status: "completed" | "partial"; truncated: boolean } | null;
  /** Provenance and method labels, e.g. "Search Console, stored sync 2026-10-03, window 2026-09-03..2026-09-30". */
  labels: string[];
  candidates: GscQuestionCandidate[];
  counts: GscQuestionCounts;
  /** Display cap on candidates. */
  cap: number;
  includeBrand: boolean;
  promptSet: { id: string; version: number; size: number; room: number; max: number } | null;
  added: GscAddedPrompt[];
}

export interface GscQuestionsAddResult {
  set: GeoPromptSet;
  added: Array<{ text: string; promptType: "discovery" | "reputation"; evidence: GscQuestionEvidence }>;
  skipped: Array<{ query: string; reason: string }>;
}
