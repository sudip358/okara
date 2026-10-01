/**
 * Pure helpers for the AI engines board (docs/geo-board-design.md). No React, no fetch: unit-tested in
 * tests/geo-batch-board-lib.test.ts. Nothing here projects or scores: every number shown on the board comes
 * from the API with its numerator/denominator, and missing values render as "Unknown"/"Unavailable", never 0.
 */
import type {
  CapabilityState,
  CompetitorAssessmentState,
  CompetitorCheck,
  CompetitorCheckKey,
  CompetitorPageAssessment,
  CostUsd,
  EngineFeedItem,
  EngineFeedStatus,
  EngineLaneSummary,
  FactorStatus,
  GeoEngineProviderId,
  Ratio,
  RewritePlan,
  RewritePlanItem,
  RunSummary,
  SourceType,
} from "@shared/types";
import { formatNumber, formatPercent, formatUsd } from "@web/lib/format";

/** Same union as `BadgeTone` in components/ui.tsx (kept local so this module stays JSX- and DOM-free for tests). */
export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info" | "demo";

// ------------------------------------------------------------------ labels (exact strings, design §7)
export const LABELS = {
  apiSampled: "API-sampled",
  apiSampledTip: "Answers from the provider's API with web search; consumer apps may answer differently.",
  measured: "Measured from crawl",
  heuristic: "Heuristic",
  jev: "Jev judgment",
  manualPlan: "Manual plan · Publishing: manual (not connected)",
  footer: "Practices, not guarantees. No projected traffic, revenue, rankings or citations are shown.",
  skipCaveat: "These are observable differences, not causes. Engines do not publish ranking factors.",
  confirmFetch: "Okara will fetch this one page once, respecting robots.txt, and keep short evidence only.",
  adaptNote: "Adapt the structure; never copy their text.",
  indexnow: "Submit to IndexNow (Bing and participating engines, not Google) · optional",
} as const;

/** Fallback disclosures when the API sends none (it always should). */
export const DEFAULT_DISCLOSURES = ["API-sampled answers; not consumer-app answers", "Measured, not projected"];

// ------------------------------------------------------------------ engines
const ENGINE_META: Record<GeoEngineProviderId, { name: string; vendor: string; glyph: string }> = {
  openai_geo: { name: "OpenAI", vendor: "OpenAI", glyph: "O" },
  anthropic_geo: { name: "Anthropic", vendor: "Anthropic", glyph: "A" },
  gemini: { name: "Gemini", vendor: "Google Gemini", glyph: "G" },
  perplexity: { name: "Perplexity", vendor: "Perplexity", glyph: "P" },
};

/** API name of the engine. Never "ChatGPT" / "Claude app": these are API answers. */
export function engineName(provider: string): string {
  return (ENGINE_META as Record<string, { name: string }>)[provider]?.name ?? provider;
}
export function engineVendor(provider: string): string {
  return (ENGINE_META as Record<string, { vendor: string }>)[provider]?.vendor ?? provider;
}
/** Plain monochrome glyph letter per vendor (no brand logos). */
export function engineGlyph(provider: string): string {
  return (ENGINE_META as Record<string, { glyph: string }>)[provider]?.glyph ?? (provider.charAt(0).toUpperCase() || "?");
}

/** Static Tailwind classes so the compiler sees them: 1 column on mobile, 2 on tablet, up to 4 on desktop. */
export function laneGridClass(laneCount: number): string {
  const xl = laneCount >= 4 ? "xl:grid-cols-4" : laneCount === 3 ? "xl:grid-cols-3" : laneCount === 2 ? "xl:grid-cols-2" : "xl:grid-cols-1";
  return `grid min-w-0 grid-cols-1 gap-4 ${laneCount >= 2 ? "md:grid-cols-2" : ""} ${xl}`.replace(/\s+/g, " ").trim();
}

// ------------------------------------------------------------------ gauge (semicircle)
export const GAUGE = { width: 100, height: 56, cx: 50, cy: 50, r: 40 } as const;

/** Clamp a ratio value into [0, 1]; null stays null (unavailable, not zero). */
export function gaugeFraction(r: Ratio): number | null {
  if (r.denominator <= 0 || r.value === null || !Number.isFinite(r.value)) return null;
  return Math.min(1, Math.max(0, r.value));
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Point on the gauge arc for fraction f (0 = left end, 1 = right end). */
export function gaugePoint(f: number): { x: number; y: number } {
  const angle = Math.PI * (1 - f);
  return { x: round2(GAUGE.cx + GAUGE.r * Math.cos(angle)), y: round2(GAUGE.cy - GAUGE.r * Math.sin(angle)) };
}

/** SVG paths for the gauge: the full track and the value arc (null when unavailable or 0). */
export function gaugePaths(r: Ratio): { track: string; value: string | null; fraction: number | null } {
  const start = gaugePoint(0);
  const end = gaugePoint(1);
  const track = `M ${start.x} ${start.y} A ${GAUGE.r} ${GAUGE.r} 0 0 1 ${end.x} ${end.y}`;
  const f = gaugeFraction(r);
  if (f === null || f === 0) return { track, value: null, fraction: f };
  const p = gaugePoint(f);
  return { track, value: `M ${start.x} ${start.y} A ${GAUGE.r} ${GAUGE.r} 0 0 1 ${p.x} ${p.y}`, fraction: f };
}

/** Visible gauge text: "21.1% · 109 of 523", or "Unavailable (no valid answers)". */
export function gaugeText(r: Ratio): string {
  if (gaugeFraction(r) === null) return "Unavailable (no valid answers)";
  return `${formatPercent(r.value)} · ${formatNumber(r.numerator)} of ${formatNumber(r.denominator)}`;
}

/** Full accessible label for the gauge SVG. */
export function gaugeAriaLabel(r: Ratio): string {
  if (gaugeFraction(r) === null) return "Citation rate unavailable: no valid answers";
  return `Citation rate ${formatPercent(r.value)}: ${formatNumber(r.numerator)} of ${formatNumber(r.denominator)} valid answers cited your site`;
}

// ------------------------------------------------------------------ cost
export type CostBasis = "Actual" | "Estimate (versioned rates)" | "Unknown";

/** "$0.31" + "Actual" / "~$0.31 est." + "Estimate (versioned rates)" / "Unknown" (never $0 for unknown). */
export function costDisplay(c: CostUsd): { value: string; basis: CostBasis } {
  if (c.value === null || !Number.isFinite(c.value)) return { value: "Unknown", basis: "Unknown" };
  return { value: formatUsd(c.value, c.isEstimate), basis: c.isEstimate ? "Estimate (versioned rates)" : "Actual" };
}

/**
 * Board-level cost: sum over lanes that ran prompts. Unknown when any of those lanes has an unknown cost
 * (a partial sum would understate spend); null value when no lane ran.
 */
export function sumLaneCost(lanes: Pick<EngineLaneSummary, "costUsd" | "promptsRun">[]): CostUsd {
  const ran = lanes.filter((l) => l.promptsRun > 0);
  if (ran.length === 0) return { value: null, isEstimate: false };
  let total = 0;
  let isEstimate = false;
  for (const l of ran) {
    if (l.costUsd.value === null || !Number.isFinite(l.costUsd.value)) return { value: null, isEstimate: l.costUsd.isEstimate };
    total += l.costUsd.value;
    isEstimate ||= l.costUsd.isEstimate;
  }
  return { value: Math.round(total * 1e6) / 1e6, isEstimate };
}

// ------------------------------------------------------------------ runs (top bar)
/** Newest GEO run by createdAt (any status). */
export function latestGeoRun(runs: RunSummary[] | null | undefined): RunSummary | null {
  let best: RunSummary | null = null;
  for (const r of runs ?? []) {
    if (r.agent !== "geo") continue;
    if (!best || Date.parse(r.createdAt) > Date.parse(best.createdAt)) best = r;
  }
  return best;
}

/** True while the run is pending or running (the board polls then). */
export function runIsActive(run: Pick<RunSummary, "status"> | null | undefined): boolean {
  return run?.status === "pending" || run?.status === "running";
}

/** True exactly when a run that was active is now finished: the board reloads once at that moment. */
export function runJustFinished(wasActive: boolean, run: Pick<RunSummary, "status"> | null | undefined): boolean {
  return wasActive && run != null && !runIsActive(run);
}

/** Wall-clock duration of a finished run in ms; null when it has not started or finished. */
export function runDurationMs(run: Pick<RunSummary, "startedAt" | "finishedAt"> | null): number | null {
  if (!run?.startedAt || !run.finishedAt) return null;
  const ms = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** "850 ms", "18 s", "2 min 5 s", "1 h 3 min"; "—" for null. */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** Provider latency for a feed card: "377 ms", "1.2 s"; null when not recorded (the card omits it). */
export function formatLatency(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")} s`;
}

// ------------------------------------------------------------------ feed
export const FEED_STATUS: Record<EngineFeedStatus, { label: string; tone: BadgeTone }> = {
  missing: { label: "Missing", tone: "danger" },
  named: { label: "Named", tone: "warning" },
  cited: { label: "Cited", tone: "success" },
  not_run: { label: "Not run", tone: "neutral" },
};

export function feedStatusLabel(s: EngineFeedStatus): string {
  return FEED_STATUS[s]?.label ?? s;
}

/** "#2 in list" only when the answer had a real ordered list. */
export function positionLabel(position: number | null): string | null {
  return position !== null && Number.isInteger(position) && position > 0 ? `#${position} in list` : null;
}

export const FEED_MAX = 50;

export function feedItems(feed: EngineFeedItem[]): EngineFeedItem[] {
  return feed.slice(0, FEED_MAX);
}

/** "1,301 valid · 1,280 grounded · 4 failed" (+ incomplete when > 0). */
export function countsLine(c: EngineLaneSummary["counts"]): string {
  const parts = [`${formatNumber(c.valid)} valid`, `${formatNumber(c.grounded)} grounded`, `${formatNumber(c.failed)} failed`];
  if (c.incomplete > 0) parts.push(`${formatNumber(c.incomplete)} incomplete`);
  return parts.join(" · ");
}

/** "38 engine searches captured" / "Search queries not exposed". */
export function searchQueriesLine(q: EngineLaneSummary["searchQueries"]): string {
  if (q.state !== "captured") return "Search queries not exposed";
  return `${formatNumber(q.count)} engine search${q.count === 1 ? "" : "es"} captured`;
}

/** "21.1% (240 of 1,146 skipping answers)" for the cited-instead host. */
export function citedInsteadShare(c: NonNullable<EngineLaneSummary["citedInstead"]>): string {
  if (c.share.value === null || c.share.denominator <= 0) return "Share unavailable";
  return `${formatPercent(c.share.value)} (${formatNumber(c.share.numerator)} of ${formatNumber(c.share.denominator)} skipping answers)`;
}

/** "example.com · 21.1% (240 of 1,146 skipping answers)" or "No other source dominates". */
export function citedInsteadLine(c: EngineLaneSummary["citedInstead"]): string {
  return c ? `${c.host} · ${citedInsteadShare(c)}` : "No other source dominates";
}

/** Lane body mode by state (design §2 "Lane empty / setup states"). */
export type LaneBodyMode = "setup" | "disabled" | "error" | "no_answers" | "ready";
export function laneBodyMode(lane: Pick<EngineLaneSummary, "state" | "promptsRun">): LaneBodyMode {
  const s: CapabilityState = lane.state;
  if (s === "setup_required") return "setup";
  if (s === "disabled") return "disabled";
  if (s === "error") return "error";
  if (lane.promptsRun <= 0) return "no_answers";
  return "ready";
}

/** Lanes with data first-open on mobile: the first lane that can render a body. */
export function firstOpenLane(lanes: Pick<EngineLaneSummary, "provider" | "state" | "promptsRun">[]): string | null {
  return lanes.find((l) => laneBodyMode(l) === "ready")?.provider ?? lanes[0]?.provider ?? null;
}

// ------------------------------------------------------------------ factors / checks
export const FACTOR_STATUS: Record<FactorStatus, { label: string; tone: BadgeTone; level: number | null }> = {
  present: { label: "Present", tone: "success", level: 1 },
  partial: { label: "Partial", tone: "warning", level: 0.5 },
  missing: { label: "Missing", tone: "danger", level: 0 },
  unknown: { label: "Unknown", tone: "neutral", level: null },
};

export function factorStatusLabel(s: FactorStatus): string {
  return FACTOR_STATUS[s]?.label ?? s;
}

export function methodLabel(method: "measured" | "heuristic" | "jev" | "manual"): string {
  if (method === "heuristic") return LABELS.heuristic;
  if (method === "jev") return LABELS.jev;
  if (method === "manual") return "Check this yourself";
  return "Measured";
}

/** "yes-probability 0.82" (Noul has no confidence field). */
export function noulLabel(noul: number | null): string | null {
  return noul === null || !Number.isFinite(noul) ? null : `yes-probability ${noul.toFixed(2)}`;
}

/**
 * Presence of a competitor check. Uses `status` when the API sends it; otherwise, for Jev checks, a tier
 * "act" answer maps to present (noul >= 0.5) or missing; flag/drop/not run → unknown. Measured checks
 * without a status are unknown (their detail text is shown in the table instead).
 */
export function checkStatus(c: CompetitorCheck): FactorStatus {
  if (c.status) return c.status;
  if (c.method === "jev" && c.tier === "act" && c.noul !== null && Number.isFinite(c.noul)) return c.noul >= 0.5 ? "present" : "missing";
  return "unknown";
}

export function checkResultText(c: CompetitorCheck): string {
  // Neutral: Jev checks stay null for several reasons (not configured, budget, error, screened text, no
  // linked prompt). The real reason is in the assessment's stateDetail, which AssessmentCard shows.
  if (c.method === "jev" && c.noul === null) return c.detail ? `Not run · ${c.detail}` : "Not run";
  return c.detail ?? factorStatusLabel(checkStatus(c));
}

// ------------------------------------------------------------------ radar
export const RADAR_AXES: Array<{ key: CompetitorCheckKey; label: string }> = [
  { key: "answer_first", label: "Answer" },
  { key: "faq", label: "FAQ" },
  { key: "author", label: "Author" },
  { key: "freshness", label: "Fresh" },
  { key: "proof", label: "Sources" },
  { key: "entity", label: "Entity" },
];

export interface RadarAxis {
  key: CompetitorCheckKey;
  label: string;
  status: FactorStatus;
  /** End of the axis spoke. */
  end: { x: number; y: number };
  /** Label anchor just outside the spoke. */
  labelAt: { x: number; y: number };
  /** Plotted point; null for unknown (no point). Centre for missing. */
  point: { x: number; y: number } | null;
}

function polar(cx: number, cy: number, r: number, i: number, n: number): { x: number; y: number } {
  const a = -Math.PI / 2 + (2 * Math.PI * i) / n; // first axis at 12 o'clock, clockwise
  return { x: round2(cx + r * Math.cos(a)), y: round2(cy + r * Math.sin(a)) };
}

/** Axes, points, and the polygon for a competitor's checks. present = outer ring, partial = middle, missing = centre, unknown = no point. */
export function radarGeometry(
  checks: CompetitorCheck[],
  opts: { cx?: number; cy?: number; r?: number } = {},
): { axes: RadarAxis[]; polygon: string | null; rings: string[] } {
  const cx = opts.cx ?? 60;
  const cy = opts.cy ?? 60;
  const r = opts.r ?? 40;
  const n = RADAR_AXES.length;
  const byKey = new Map(checks.map((c) => [c.key, c]));
  const axes = RADAR_AXES.map((ax, i): RadarAxis => {
    const c = byKey.get(ax.key);
    const status = c ? checkStatus(c) : "unknown";
    const level = FACTOR_STATUS[status].level;
    return {
      key: ax.key,
      label: ax.label,
      status,
      end: polar(cx, cy, r, i, n),
      labelAt: polar(cx, cy, r + 12, i, n),
      point: level === null ? null : polar(cx, cy, r * level, i, n),
    };
  });
  const pts = axes.filter((a) => a.point !== null).map((a) => `${a.point!.x},${a.point!.y}`);
  const rings = [0.5, 1].map((lv) =>
    Array.from({ length: n }, (_, i) => {
      const p = polar(cx, cy, r * lv, i, n);
      return `${p.x},${p.y}`;
    }).join(" "),
  );
  return { axes, polygon: pts.length >= 3 ? pts.join(" ") : null, rings };
}

// ------------------------------------------------------------------ competitor assessments
export const VERDICT: Record<"adapt" | "skip" | "review", { label: string; tone: BadgeTone; note: string }> = {
  adapt: { label: "Adapt", tone: "success", note: LABELS.adaptNote },
  skip: { label: "Skip", tone: "neutral", note: "Nothing to adapt for this page." },
  review: { label: "Review", tone: "warning", note: "Check this yourself before acting." },
};

export const ASSESSMENT_STATE: Record<CompetitorAssessmentState, { label: string; tone: BadgeTone; pending: boolean }> = {
  queued: { label: "Queued", tone: "neutral", pending: true },
  fetching: { label: "Reading page", tone: "info", pending: true },
  assessed: { label: "Assessed", tone: "success", pending: false },
  blocked: { label: "Blocked", tone: "warning", pending: false },
  failed: { label: "Failed", tone: "danger", pending: false },
};

/** Assessments whose stored citations came from this engine. */
export function assessmentsForEngine(list: CompetitorPageAssessment[], provider: string): CompetitorPageAssessment[] {
  return list.filter((a) => a.citedIn.some((c) => c.provider === provider));
}

/** Normalise for de-duplication only (never for fetching): lowercase host, drop hash and trailing slash. */
export function urlKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname;
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return url.trim();
  }
}

export interface ApprovalCandidate {
  url: string;
  host: string;
  sourceType: SourceType;
  promptText: string;
}

/**
 * URLs this engine cited instead of us that the user may approve for reading: unique feed `citedInstead.url`
 * values (https only, as the API requires) not already assessed. Newest feed first; max `limit`.
 */
const APPROVAL_DONE_STATES: ReadonlySet<CompetitorPageAssessment["state"]> = new Set(["assessed", "queued", "fetching", "blocked"]);

export function approvalCandidates(
  feed: EngineFeedItem[],
  assessed: CompetitorPageAssessment[],
  limit = 5,
): ApprovalCandidate[] {
  // Failed reads may be retried (the server's reuse query only matches assessed/queued/fetching rows);
  // robots.txt blocks are not retried, so blocked stays excluded.
  const done = new Set(assessed.filter((a) => APPROVAL_DONE_STATES.has(a.state)).map((a) => urlKey(a.url)));
  const seen = new Set<string>();
  const out: ApprovalCandidate[] = [];
  if (limit <= 0) return out;
  for (const f of feed) {
    const ci = f.citedInstead;
    if (!ci?.url) continue;
    let ok = false;
    try {
      ok = new URL(ci.url).protocol === "https:";
    } catch {
      ok = false;
    }
    if (!ok) continue;
    const k = urlKey(ci.url);
    if (done.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push({ url: ci.url, host: ci.host, sourceType: ci.sourceType, promptText: f.promptText });
    if (out.length >= limit) break;
  }
  return out;
}

// ------------------------------------------------------------------ skip-factor candidates
export interface SkipCandidate {
  promptId: string;
  promptText: string;
  pageId: string | null;
  pageUrl: string | null;
  citedInsteadHost: string | null;
}

/**
 * For each `missing` prompt in this lane, the matched page from answer coverage (resolved to a page id by
 * URL from the crawl's page list). pageId null → "No matching page".
 */
export function skipCandidates(
  feed: EngineFeedItem[],
  coverage: Array<{ promptId: string; matchedPage: { url: string } | null }>,
  pages: Array<{ id: string; url: string }>,
): SkipCandidate[] {
  const byPrompt = new Map(coverage.map((r) => [r.promptId, r]));
  const byUrl = new Map(pages.map((p) => [urlKey(p.url), p.id]));
  const out: SkipCandidate[] = [];
  const seen = new Set<string>();
  for (const f of feed) {
    if (f.status !== "missing" || seen.has(f.promptId)) continue;
    seen.add(f.promptId);
    const m = byPrompt.get(f.promptId)?.matchedPage ?? null;
    out.push({
      promptId: f.promptId,
      promptText: f.promptText,
      pageId: m ? byUrl.get(urlKey(m.url)) ?? null : null,
      pageUrl: m?.url ?? null,
      citedInsteadHost: f.citedInstead?.host ?? null,
    });
  }
  return out;
}

export function skipFactorsPath(projectId: string, c: { pageId: string; promptId: string | null }, engine: string): string {
  const q = new URLSearchParams();
  if (c.promptId) q.set("promptId", c.promptId);
  q.set("engine", engine);
  return `/projects/${encodeURIComponent(projectId)}/geo/pages/${encodeURIComponent(c.pageId)}/skip-factors?${q.toString()}`;
}

// ------------------------------------------------------------------ rewrite plans
export const PLAN_ITEM_STATUS: Record<RewritePlanItem["status"], { glyph: string; label: string }> = {
  done: { glyph: "✓", label: "Done" },
  todo: { glyph: "☐", label: "To do" },
  not_applicable: { glyph: "–", label: "Not applicable" },
  unknown: { glyph: "?", label: "Unknown" },
};

/** The IndexNow item always carries its scope, whatever label the API sent. */
export function planItemLabel(item: RewritePlanItem): string {
  if (item.key === "indexnow") return LABELS.indexnow;
  return item.optional ? `${item.label} · optional` : item.label;
}

export function plansForEngine(plans: RewritePlan[], provider: string): RewritePlan[] {
  return plans.filter((p) => p.engine === provider);
}

export function plansWithoutEngine(plans: RewritePlan[]): RewritePlan[] {
  return plans.filter((p) => p.engine === null);
}

/** "3 of 7 done" over applicable items. */
export function planProgress(items: RewritePlanItem[]): string {
  const applicable = items.filter((i) => i.status !== "not_applicable");
  const done = applicable.filter((i) => i.status === "done").length;
  return `${formatNumber(done)} of ${formatNumber(applicable.length)} done`;
}
