/** Display formatting. Metrics never render as bare percentages. OWNED BY: web-shell. */
import type { DateWindow, Ratio } from "@shared/types";

const nf = new Intl.NumberFormat(undefined);

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return nf.format(n);
}

/** Percentage only (e.g. "12.5%"); prefer formatRatio wherever a Ratio is available. */
export function formatPercent(value: number | null, digits = 1): string {
  if (value === null || Number.isNaN(value)) return "Unavailable";
  return `${(value * 100).toFixed(digits).replace(/\.0+$/, "")}%`;
}

/** "12.5% (5 of 40)" or "Unavailable (0 responses)" when the denominator is 0. */
export function formatRatio(r: Ratio, unit = "responses", digits = 1): string {
  if (r.denominator === 0 || r.value === null) return `Unavailable (0 ${unit})`;
  return `${formatPercent(r.value, digits)} (${formatNumber(r.numerator)} of ${formatNumber(r.denominator)})`;
}

/** Just the "5 of 40" part. */
export function formatFraction(r: Ratio): string {
  return `${formatNumber(r.numerator)} of ${formatNumber(r.denominator)}`;
}

/**
 * "$0.12" (actual), "~$0.12 est." (estimate from configured rates), "Unknown" (null — never $0).
 */
export function formatUsd(value: number | null | undefined, isEstimate = false): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "Unknown";
  const digits = value !== 0 && Math.abs(value) < 0.01 ? 4 : 2;
  const s = `$${value.toFixed(digits)}`;
  return isEstimate ? `~${s} est.` : s;
}

function toDate(v: string | Date): Date | null {
  if (v instanceof Date) return v;
  // Plain YYYY-MM-DD dates are calendar dates, not instants: render them without timezone shifts.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00`) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "Sep 30, 2026" */
export function formatDate(v: string | Date | null | undefined): string {
  if (!v) return "—";
  const d = toDate(v);
  return d ? d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : String(v);
}

/** "Sep 30, 2026, 14:05" */
export function formatDateTime(v: string | Date | null | undefined): string {
  if (!v) return "—";
  const d = toDate(v);
  return d
    ? d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : String(v);
}

/** "14:05" */
export function formatTime(v: string | Date | null | undefined): string {
  if (!v) return "—";
  const d = toDate(v);
  return d ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : String(v);
}

/** "Sep 3 – Sep 30, 2026 (28 days)" or "No window" */
export function formatWindow(w: DateWindow | null | undefined): string {
  if (!w) return "No window";
  const s = toDate(w.start);
  const e = toDate(w.end);
  if (!s || !e) return `${w.start} – ${w.end}`;
  const days = Math.round((e.getTime() - s.getTime()) / 86_400_000) + 1;
  const sameYear = s.getFullYear() === e.getFullYear();
  const startStr = s.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
  return `${startStr} – ${formatDate(e)} (${days} day${days === 1 ? "" : "s"})`;
}

/** "3 min ago", "2 h ago", "Sep 3" */
export function formatRelative(v: string | null | undefined, now = Date.now()): string {
  if (!v) return "never";
  const d = toDate(v);
  if (!d) return v;
  const diff = Math.round((now - d.getTime()) / 1000);
  if (diff < 0) return formatDateTime(d);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} d ago`;
  return formatDate(d);
}

export function agentLabel(agent: "seo" | "geo"): string {
  return agent === "seo" ? "SEO" : "GEO";
}

/** "rate_limited" → "Rate limited" */
export function humanize(s: string): string {
  const t = s.replace(/[_-]+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}
