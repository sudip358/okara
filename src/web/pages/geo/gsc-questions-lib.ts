/**
 * [A37] Pure helpers for "From Search Console" question queries (GEO prompts page and Live GEO 12).
 * Strings from Search Console are untrusted: callers render them as plain text only.
 */
import type { GscAddedPrompt, GscQuestionRule, GscQuestionsResponse } from "@shared/gsc-questions";
import { promptKey } from "@shared/import";

export const MAX_ADD_PER_REQUEST = 25;

export const RULE_LABEL: Record<GscQuestionRule, string> = {
  wh_start: "question",
  wh_word: "question word",
  aux_start: "yes/no question",
  best: "best",
  top: "top",
  vs: "vs",
  difference_between: "difference between",
  ideas: "ideas",
  guide: "guide",
  review: "review",
  alternatives: "alternatives",
  compare: "compare",
};

const nf = new Intl.NumberFormat("en-US");
export const intText = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? "—" : nf.format(Math.round(n)));

/** "8.3" or "—" (CSV imports have no usable position). */
export function positionText(p: number | null | undefined): string {
  return p === null || p === undefined || !Number.isFinite(p) || p <= 0 ? "—" : p.toFixed(1);
}

/** Landing page shown as its path ("/blogs/care/brass"), falling back to the raw value. */
export function landingPath(url: string | null | undefined): string {
  if (!url) return "—";
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || "/";
  } catch {
    return url;
  }
}

/** "12 new question queries from Search Console" (eligible = after every exclusion, before the display cap). */
export function countHeadline(d: Pick<GscQuestionsResponse, "counts" | "state"> | null): string | null {
  if (!d || (d.state !== "ready" && d.state !== "demo")) return null;
  const n = d.counts.eligible;
  return n === 0 ? "No new question queries from Search Console" : `${intText(n)} new question ${n === 1 ? "query" : "queries"} from Search Console`;
}

/** "stored sync 2026-10-03 · window 2026-09-03..2026-09-30" */
export function syncText(d: Pick<GscQuestionsResponse, "sync"> | null): string | null {
  if (!d?.sync) return null;
  return `stored sync ${d.sync.syncedAt.slice(0, 10)} · window ${d.sync.window.start}..${d.sync.window.end}${d.sync.source === "csv_import" ? " (CSV import)" : ""}`;
}

/** How many more can be selected: room left in the set, and at most MAX_ADD_PER_REQUEST per request. */
export function selectionLimit(room: number): number {
  return Math.max(0, Math.min(room, MAX_ADD_PER_REQUEST));
}

/** Toggle a key, never exceeding `limit` selected keys. */
export function toggleKey(selected: ReadonlySet<string>, key: string, limit: number): Set<string> {
  const next = new Set(selected);
  if (next.has(key)) next.delete(key);
  else if (next.size < limit) next.add(key);
  return next;
}

/** The first `limit` keys in list order (the candidates arrive ranked by impressions). */
export function selectTop(keys: readonly string[], limit: number): Set<string> {
  return new Set(keys.slice(0, Math.max(0, limit)));
}

/** Provenance note of a prompt that was added from Search Console (matched by the prompt key). */
export function addedFor(added: readonly GscAddedPrompt[] | null | undefined, text: string): GscAddedPrompt | null {
  if (!added?.length) return null;
  const k = promptKey(text);
  return added.find((a) => a.key === k) ?? null;
}

export function addedNoteText(a: GscAddedPrompt): string {
  const e = a.evidence;
  if (!e) return `Added from Search Console on ${a.addedAt.slice(0, 10)}.`;
  const parts = [`${intText(e.impressions)} impressions`, `${intText(e.clicks)} clicks`];
  if (e.position !== null) parts.push(`avg. position ${positionText(e.position)}`);
  return `Search query “${e.query}”: ${parts.join(" · ")} in ${e.window.start}..${e.window.end} (stored sync ${e.syncedAt.slice(0, 10)}).`;
}
