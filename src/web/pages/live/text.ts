/**
 * Live view labels (docs/live-view-design.md sections 0, 2, 7 and 9). Pure string helpers, unit-tested.
 * Exact honesty wording lives here so every panel says the same thing:
 * - Jev never gets a confidence it does not have: Noul shows "Jev act · 0.92"; Choice shows
 *   "Jev act · update · conf 0.87"; tier drop withholds the value; rule rows show "Rule · fact".
 * - Cost is actual, estimate or unknown; unknown is never $0.
 * - Replay always says it is a replay of real stored events, with its date and speed.
 */
import type { DateWindow, LiveGscMetrics, LiveJevJudgment, LiveSeoElementRow, LiveSeoVerdict, RunActivity } from "@shared/types";
import type { Speed, SpendSoFar } from "./engine";

export const DEMO_LABEL = "Demo data - simulated run";

export const LIVE_TEXT = {
  honestyLive: "Live from this run's stored rows · Jev judgments are stored answers · nothing is projected",
  honestyReplay: "Replay of stored rows · Jev judgments are stored answers · nothing is projected",
  apiSampled: "API-sampled answers; consumer apps may answer differently",
  gone: "This run is no longer available.",
  reconnecting: "Reconnecting… the panels show the last stored rows received.",
  projectLevel: "Current state, not replayed",
  waitingJudgment: "Waiting for the next stored judgment",
  /** Same wording as the server label (src/worker/live/seo-board.ts). */
  noJevAnswers: "No Jev answers were stored in this run: rule findings only.",
  lowerBound: "≥ = lower bound (query+page rows; anonymized queries are omitted)",
  elementsSubtitle: "Jev answers one narrow question per element; code turns the stored answer into keep, change or review.",
  competitorsSubtitle: "Only pages you approved. Checks are measured or Jev Noul; we adapt structure, never copy text.",
  skipCaption: "Measured from the crawl · observable differences, not causes.",
  manualPlan: "Manual plan · Publishing: manual (not connected)",
  geoSubtitle: "Asks the configured AI engines (API-sampled) your approved prompts and records who they cite.",
} as const;

// ------------------------------------------------------------------ numbers
const nf = new Intl.NumberFormat("en-US");
export const fmtInt = (n: number | null | undefined): string => (n === null || n === undefined || !Number.isFinite(n) ? "—" : nf.format(Math.round(n)));

/** "$0.07", "$0.0012" (never "$0" for unknown: callers handle null). */
export function fmtUsd(usd: number): string {
  const digits = usd !== 0 && Math.abs(usd) < 0.01 ? 4 : 2;
  return `$${usd.toFixed(digits)}`;
}

/** "06:42", "1:03:12"; "--:--" when unknown. */
export function clockText(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "--:--";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Spend phrase for the header pill (design section 2 table). */
export function spendPhrase(spend: RunActivity["totals"]["spend"], providerCalls: number): string {
  if (providerCalls <= 0 && spend.unknownCalls <= 0) return "$0.00 spent (no provider calls)";
  if (spend.usd === null || !Number.isFinite(spend.usd)) return `spend unknown (${fmtInt(spend.unknownCalls)} call${spend.unknownCalls === 1 ? "" : "s"} unpriced)`;
  if (spend.unknownCalls > 0) return `${fmtUsd(spend.usd)}+ spent (estimate; ${fmtInt(spend.unknownCalls)} call${spend.unknownCalls === 1 ? "" : "s"} unpriced)`;
  return `${fmtUsd(spend.usd)} spent (${spend.isEstimate ? "estimate" : "actual"})`;
}

/** Spend at the replay playhead: "$0.03 spent so far (estimate)", "$0.03 + 2 unpriced". */
export function spendSoFarText(s: SpendSoFar): string {
  if (s.priced === 0 && s.unpriced === 0) return "$0.00 spent so far (no provider calls yet)";
  if (s.priced === 0) return `spend unknown so far (${fmtInt(s.unpriced)} unpriced)`;
  const base = `${fmtUsd(s.usd)} spent so far (${s.isEstimate ? "estimate" : "actual"})`;
  return s.unpriced > 0 ? `${fmtUsd(s.usd)} + ${fmtInt(s.unpriced)} unpriced so far` : base;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "29 Sep 2026, 14:02" (local time). */
export function replayDate(iso: string | null | undefined): string {
  if (!iso) return "an unknown date";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "an unknown date";
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "29 Sep" */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00`) : new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** "1–28 Sep" or "29 Aug–27 Sep". */
export function windowShort(w: DateWindow | null | undefined): string {
  if (!w) return "no window";
  const s = new Date(`${w.start}T00:00:00`);
  const e = new Date(`${w.end}T00:00:00`);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return `${w.start}–${w.end}`;
  return s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear()
    ? `${s.getDate()}–${e.getDate()} ${MONTHS[e.getMonth()]}`
    : `${s.getDate()} ${MONTHS[s.getMonth()]}–${e.getDate()} ${MONTHS[e.getMonth()]}`;
}

// ------------------------------------------------------------------ pill
export type LiveMode = "live" | "pending" | "finished" | "replay";

/** The replay label (always visible): exact wording from design section 9. */
export function replayLabel(startedAt: string | null, speed: Speed, gapsShortened: boolean, demo: boolean): string {
  const base = `Replay of the run on ${replayDate(startedAt)} · real stored events · ${speed}× speed${gapsShortened ? " · idle gaps over 10 s shortened" : ""}`;
  return demo ? `${DEMO_LABEL} · ${base}` : base;
}

export interface PillInput {
  mode: LiveMode;
  /** Stored run status (agent_runs.status): a failed, partial or cancelled run never reads as complete. */
  status: string;
  demo: boolean;
  elapsedMs: number | null;
  spend: RunActivity["totals"]["spend"];
  providerCalls: number;
  startedAt: string | null;
  speed: Speed;
  gapsShortened: boolean;
}

const statusWord = (status: string) => status.replace(/_/g, " ");

/** Header pill text. The leading glyph is decorative (rendered separately by the component). */
export function pillText(p: PillInput): string {
  let s: string;
  if (p.mode === "replay") return `${replayLabel(p.startedAt, p.speed, p.gapsShortened, p.demo)}${p.status !== "completed" ? ` · run ${statusWord(p.status)}` : ""}`;
  if (p.mode === "pending") s = "Queued run · waiting to start";
  else if (p.mode === "finished") s = `Run ${p.status === "completed" ? "finished" : statusWord(p.status)} · ${clockText(p.elapsedMs)} · ${spendPhrase(p.spend, p.providerCalls)}`;
  else s = `Live run · ${clockText(p.elapsedMs)} elapsed · ${spendPhrase(p.spend, p.providerCalls)}`;
  return p.demo ? `${DEMO_LABEL} · ${s}` : s;
}

/**
 * Dedupe label chips (server labels + ours), ignoring case, dash style and trailing dots. A label is also
 * dropped when an earlier one starts with the same first clause (the text before ';'), e.g. two wordings of
 * "API-sampled answers; …".
 */
export function dedupeLabels(labels: ReadonlyArray<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const clauses = new Set<string>();
  const out: string[] = [];
  for (const l of labels) {
    if (!l) continue;
    const k = l.toLowerCase().replace(/[‐-―-]/g, "-").replace(/\s+/g, " ").trim().replace(/\.+$/, "");
    const i = k.indexOf(";");
    const clause = i > 0 ? k.slice(0, i).trim() : null;
    if (seen.has(k) || (clause !== null && clauses.has(clause))) continue;
    seen.add(k);
    if (clause !== null) clauses.add(clause);
    out.push(l);
  }
  return out;
}

// ------------------------------------------------------------------ Jev / verdicts
const num2 = (n: number) => n.toFixed(2);

/**
 * "Jev act · 0.92" (Noul: tier + raw yes-probability), "Jev act · update · conf 0.87" (Choice: real
 * confidence field), "Jev drop · withheld" (drop withholds the value), "Rule · fact" (audit rule rows).
 */
export function jevChipText(jev: LiveJevJudgment | null, rule?: LiveSeoElementRow["rule"]): string {
  if (!jev) return rule ? `Rule · ${rule.class}` : "No stored answer";
  const tier = jev.tier && jev.tier !== "n/a" ? jev.tier : null;
  const head = `Jev ${tier ?? "no tier"}`;
  if (tier === "drop") return `${head} · withheld`;
  if (jev.choice !== null) {
    const choice = jev.choice.replace(/_/g, " ");
    return jev.confidence !== null && Number.isFinite(jev.confidence) ? `${head} · ${choice} · conf ${num2(jev.confidence)}` : `${head} · ${choice}`;
  }
  if (jev.noul !== null && Number.isFinite(jev.noul)) return jev.questionId === "links.should_exist" ? `${head} · should-exist ${num2(jev.noul)}` : `${head} · ${num2(jev.noul)}`;
  return `${head} · no answer`;
}

/** Tooltip for a Jev chip: how the verdict was computed plus provider and model (plain text). */
export function jevTooltip(row: Pick<LiveSeoElementRow, "verdictBasis" | "jev" | "rule" | "questionId">): string {
  const parts = [row.verdictBasis];
  if (row.jev) parts.push(`Question ${row.jev.questionId}`, [row.jev.provider, row.jev.model].filter(Boolean).join(" · ") || "Provider not recorded");
  else if (row.rule) parts.push(`Rule ${row.rule.ruleId} (${row.rule.severity})`);
  return parts.filter(Boolean).join(" — ");
}

export const VERDICT_META: Record<LiveSeoVerdict, { label: string; tone: "keep" | "change" | "review" }> = {
  keep: { label: "Keep", tone: "keep" },
  change: { label: "Change", tone: "change" },
  review: { label: "Review", tone: "review" },
};

/** "≈ 11.2" for page aggregates (approximate), "11.2" for a single query row; "—" without GSC. */
export function positionText(gsc: LiveGscMetrics | null | undefined): string {
  if (!gsc || gsc.position === null || !Number.isFinite(gsc.position)) return "—";
  const v = gsc.position.toFixed(1);
  return gsc.basis === "query_rows" ? v : `≈ ${v}`;
}

/** "≥ " for Search Console sums over query+page rows: a lower bound (anonymized queries are omitted). */
export function lowerBoundPrefix(gsc: Pick<LiveGscMetrics, "basis"> | null | undefined): string {
  return gsc?.basis === "query_page_rows" ? "≥ " : "";
}

export function clicksText(gsc: LiveGscMetrics | null | undefined): string {
  return gsc ? `${lowerBoundPrefix(gsc)}${fmtInt(gsc.clicks)}` : "—";
}

export function bandLabel(band: "yes" | "no" | "middle" | null): { label: string; tone: "keep" | "change" | "review" | "none" } {
  if (band === "yes") return { label: "Relevant", tone: "keep" };
  if (band === "no") return { label: "Not relevant", tone: "change" };
  if (band === "middle") return { label: "Unsure", tone: "review" };
  return { label: "No answer", tone: "none" };
}

/** Plain-text clip for untrusted strings (whitespace collapsed). */
export function clipText(s: string | null | undefined, max = 160): string {
  if (!s) return "";
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** URL path for display ("/products/oak"), falling back to the clipped input. */
export function urlPath(url: string | null | undefined): string {
  if (!url) return "—";
  try {
    const u = new URL(url);
    return clipText(`${u.pathname}${u.search}` || "/", 200);
  } catch {
    return clipText(url, 200);
  }
}

export function urlHost(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
