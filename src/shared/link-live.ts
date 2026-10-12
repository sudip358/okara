/**
 * Internal links "Live" panel contract ([A41], 2026-10-12; docs/api.md "Internal links live progress").
 *
 * The link agent's two kinds of work (an analysis run, POST .../internal-links/run, and a manual graph rebuild,
 * POST .../internal-links/graph/rebuild) append progress events to `link_live_events` as their real code paths reach
 * each stage (src/worker/links/progress.ts). GET .../internal-links/live pages them. Every count and every item in an
 * event comes from the code that emitted it; nothing is projected. Item paths and anchors are untrusted page text and
 * render as plain text.
 */

export type LinkLiveKind = "analysis" | "graph";

/** Stored run status, plus "interrupted" (computed on read): still 'running' but no stored update for 10 minutes. */
export type LinkLiveRunStatus = "running" | "completed" | "partial" | "failed" | "interrupted";

/**
 * Stages in execution order. Graph stages run in both kinds (an analysis run builds the graph first).
 *   run            start / end of the tracked run
 *   graph.load     stored snapshots, crawl inventory, Search Console rows, cluster overrides
 *   graph.edges    the link graph (URLs, edges)
 *   graph.clusters hubs and spokes
 *   graph.anchors  anchor text audit
 *   graph.verify   auto-verification of placed links
 *   graph.save     storing the graph (skipped when another build is in progress)
 *   pages          pages of the graph usable for the analysis
 *   candidates     candidate pairs with their priority
 *   sentences      existing-sentence and anchor matching, until the per-run pair cap
 *   jev            Jev judging in batches
 *   drafts         writer-drafted sentences
 *   save           storing the suggestions
 */
export type LinkLiveStage =
  | "run"
  | "graph.load"
  | "graph.edges"
  | "graph.clusters"
  | "graph.anchors"
  | "graph.verify"
  | "graph.save"
  | "pages"
  | "candidates"
  | "sentences"
  | "jev"
  | "drafts"
  | "save";

export const LINK_LIVE_STAGES: readonly LinkLiveStage[] = [
  "run",
  "graph.load",
  "graph.edges",
  "graph.clusters",
  "graph.anchors",
  "graph.verify",
  "graph.save",
  "pages",
  "candidates",
  "sentences",
  "jev",
  "drafts",
  "save",
];

export type LinkLiveEventStatus = "started" | "progress" | "completed" | "partial" | "skipped" | "failed";

/**
 * What happened to one source -> target pair at a stage (code-computed):
 *   candidate        considered as a candidate pair (with its priority)
 *   matched          an existing sentence and anchor were found (kept for judging)
 *   kept             Jev: act tier, the link should exist (status suggested)
 *   review           Jev: flag tier or a withheld answer (status review, "Check this yourself")
 *   dropped          Jev: should not exist, or no fitting sentence / anchor (status rejected)
 *   no_answer        the call succeeded but Jev returned no usable answer for the pair
 *   not_sent         not sent to Jev (budget used up or Jev unreachable)
 *   drafted          the writer drafted a sentence that passed validation
 *   draft_rejected   the draft failed validation
 *   not_drafted      no draft (writer budget or failure)
 *   verified / not_found / pending / source_unavailable   auto-verification of a placed link
 */
export type LinkLiveVerdict =
  | "candidate"
  | "matched"
  | "kept"
  | "review"
  | "dropped"
  | "no_answer"
  | "not_sent"
  | "drafted"
  | "draft_rejected"
  | "not_drafted"
  | "verified"
  | "not_found"
  | "pending"
  | "source_unavailable";

/** One pair the code processed: source path, target path (plain text, clipped), anchor, verdict, priority. */
export interface LinkLiveItem {
  s: string;
  t: string;
  a?: string | null;
  v: LinkLiveVerdict;
  /** Priority value (candidates only). */
  p?: number;
}

export interface LinkLiveDetail {
  /** Stage counts as the code computed them (e.g. {considered: 412, clusterGapPairs: 9}). */
  n?: Record<string, number>;
  /** At most 20 items per event. */
  items?: LinkLiveItem[];
  /** A short code-written note (never page text). */
  note?: string;
}

export interface LinkLiveEvent {
  seq: number;
  at: string;
  stage: LinkLiveStage;
  status: LinkLiveEventStatus;
  detail: LinkLiveDetail;
}

/** Running totals stored with the run (updated at each stored batch of events); null = the stage did not report yet. */
export interface LinkLiveTotals {
  pages?: number | null;
  urls?: number | null;
  edges?: number | null;
  verifyChecked?: number | null;
  verified?: number | null;
  notFound?: number | null;
  pairsConsidered?: number | null;
  pairsMatched?: number | null;
  judged?: number | null;
  jevKept?: number | null;
  jevReview?: number | null;
  jevDropped?: number | null;
  jevCalls?: number | null;
  draftPool?: number | null;
  drafted?: number | null;
  draftRejected?: number | null;
  writerCalls?: number | null;
  saved?: number | null;
}

export interface LinkLiveRunView {
  id: string;
  kind: LinkLiveKind;
  status: LinkLiveRunStatus;
  isDemo: boolean;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  totals: LinkLiveTotals;
  /** Events stored for the run, and events not stored because the per-run cap was reached. */
  eventsStored: number;
  eventsDropped: number;
}

export interface LinkLiveResponse {
  /** The project's latest tracked run, or null when none was recorded yet. */
  run: LinkLiveRunView | null;
  /** Events with seq > the cursor, ascending, at most `limit` (default and max 200). */
  events: LinkLiveEvent[];
  /** Pass back as ?after= together with ?run=<run.id>. */
  nextCursor: number;
  hasMore: boolean;
  /** Suggested polling interval while the run is running. */
  pollMs: number;
}

export const LINK_LIVE_POLL_MS = 1_500;
export const LINK_LIVE_PAGE_MAX = 200;
