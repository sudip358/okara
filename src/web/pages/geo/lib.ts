/**
 * Pure helpers for GEO pages. All provider text is rendered as plain text; highlighting is done by
 * splitting strings into segments, never by building HTML.
 */
import type { GeoPrompt, GeoResults, Sentiment, SourceType } from "@shared/types";

export const SOURCE_TYPE_LABEL: Record<SourceType, string> = {
  brand_page: "Brand page",
  listicle_roundup: "Listicle / roundup",
  review_site: "Review site",
  forum_ugc: "Forum / UGC",
  publisher: "Publisher",
  marketplace: "Marketplace",
  other: "Other / unknown",
};

export function sourceTypeLabel(s: string | null | undefined): string {
  if (!s) return "Unknown";
  return (SOURCE_TYPE_LABEL as Record<string, string>)[s] ?? s;
}

export const SENTIMENT_LABEL: Record<Sentiment, string> = {
  positive: "Positive",
  neutral: "Neutral",
  negative: "Negative",
  mixed: "Mixed",
  unknown: "Unknown",
  not_applicable: "n/a",
};

export interface Segment {
  text: string;
  /** brandKey when this segment is a highlighted span. */
  brandKey: string | null;
  isSelf: boolean;
}

export interface SpanInput {
  brandKey: string;
  isSelf: boolean;
  spans: Array<{ start: number; end: number }>;
}

/**
 * Split `text` into plain/highlighted segments. Overlapping or out-of-range spans are clipped;
 * earlier-starting spans win on overlap.
 */
export function segmentText(text: string, brands: SpanInput[]): Segment[] {
  const spans: Array<{ start: number; end: number; brandKey: string; isSelf: boolean }> = [];
  for (const b of brands) {
    for (const s of b.spans) {
      const start = Math.max(0, Math.min(text.length, Math.floor(s.start)));
      const end = Math.max(0, Math.min(text.length, Math.floor(s.end)));
      if (end > start) spans.push({ start, end, brandKey: b.brandKey, isSelf: b.isSelf });
    }
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Segment[] = [];
  let pos = 0;
  for (const s of spans) {
    if (s.end <= pos) continue;
    const start = Math.max(s.start, pos);
    if (start > pos) out.push({ text: text.slice(pos, start), brandKey: null, isSelf: false });
    out.push({ text: text.slice(start, s.end), brandKey: s.brandKey, isSelf: s.isSelf });
    pos = s.end;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), brandKey: null, isSelf: false });
  return out;
}

export type TrendPoint = GeoResults["trend"][number];

/** Group trend points by consecutive cohort so no line is drawn across a cohort change. */
export function groupTrendByCohort(trend: TrendPoint[]): Array<{ cohortKey: string; points: TrendPoint[] }> {
  const sorted = [...trend].sort((a, b) => a.runAt.localeCompare(b.runAt));
  const groups: Array<{ cohortKey: string; points: TrendPoint[] }> = [];
  for (const p of sorted) {
    const last = groups[groups.length - 1];
    if (last && last.cohortKey === p.cohortKey) last.points.push(p);
    else groups.push({ cohortKey: p.cohortKey, points: [p] });
  }
  return groups;
}

export const MAX_PROMPTS = 25;

export interface DraftPrompt {
  key: string;
  id: string | null;
  text: string;
  promptType: GeoPrompt["promptType"];
  stage: string;
  approved: boolean;
}

let draftCounter = 0;
export function newDraftKey(): string {
  draftCounter += 1;
  return `draft-${Date.now().toString(36)}-${draftCounter}`;
}

export function toDraft(p: GeoPrompt): DraftPrompt {
  return { key: p.id, id: p.id, text: p.text, promptType: p.promptType, stage: p.stage ?? "", approved: p.approved };
}

export interface Suggestion {
  text: string;
  stage: string | null;
  rationale: string | null;
  promptType: GeoPrompt["promptType"];
}

/**
 * The generate endpoint's response shape is not pinned in docs/api.md. Accept the plausible
 * shapes (array of prompts, `{prompts}`, `{suggestions}`, a GeoPromptSet) and ignore anything else.
 */
export function normalizeSuggestions(raw: unknown): Suggestion[] {
  let list: unknown = raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    list = r.suggestions ?? r.prompts ?? r.items ?? [];
  }
  if (!Array.isArray(list)) return [];
  const out: Suggestion[] = [];
  for (const item of list) {
    if (typeof item === "string") {
      out.push({ text: item, stage: null, rationale: null, promptType: "discovery" });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const text = typeof o.text === "string" ? o.text : typeof o.prompt === "string" ? o.prompt : null;
    if (!text) continue;
    out.push({
      text,
      stage: typeof o.stage === "string" ? o.stage : null,
      rationale: typeof o.rationale === "string" ? o.rationale : null,
      promptType: o.promptType === "reputation" ? "reputation" : "discovery",
    });
  }
  return out;
}

/** Extract a list of human-readable messages from an ApiError `details` payload. */
export function detailMessages(details: unknown): string[] {
  if (details === null || details === undefined) return [];
  if (typeof details === "string") return [details];
  if (Array.isArray(details)) return details.flatMap((d) => detailMessages(d));
  if (typeof details === "object") {
    const o = details as Record<string, unknown>;
    const msgs: string[] = [];
    const prefix =
      typeof o.index === "number"
        ? `Prompt ${o.index + 1}: `
        : typeof o.position === "number"
          ? `Prompt ${o.position + 1}: `
          : typeof o.prompt === "string"
            ? `“${o.prompt}”: `
            : typeof o.text === "string"
              ? `“${o.text}”: `
              : "";
    if (typeof o.message === "string") msgs.push(prefix + o.message);
    else if (typeof o.reason === "string") msgs.push(prefix + o.reason);
    if (Array.isArray(o.matched) && o.matched.length) msgs.push(`${prefix}names ${o.matched.map(String).join(", ")}`);
    for (const k of ["violations", "errors", "issues", "prompts"]) {
      if (Array.isArray(o[k])) msgs.push(...detailMessages(o[k]));
    }
    if (msgs.length === 0) {
      try {
        msgs.push(JSON.stringify(details));
      } catch {
        /* ignore */
      }
    }
    return msgs;
  }
  return [String(details)];
}

export function providerStatusLabel(s: "ok" | "failed" | "incomplete" | "not_run"): string {
  return s === "ok" ? "OK" : s === "failed" ? "Failed" : s === "incomplete" ? "Incomplete" : "Not run";
}

/** Normalize an unknown thrown value into {status, code, message, details}. */
export function errorInfo(e: unknown): { status: number | null; code: string | null; message: string; details: unknown } {
  if (e && typeof e === "object") {
    const o = e as { status?: unknown; body?: { code?: unknown; message?: unknown; details?: unknown }; message?: unknown };
    const status = typeof o.status === "number" ? o.status : null;
    const code = o.body && typeof o.body.code === "string" ? o.body.code : null;
    const message =
      o.body && typeof o.body.message === "string" ? o.body.message : typeof o.message === "string" ? o.message : "Request failed.";
    return { status, code, message, details: o.body?.details };
  }
  return { status: null, code: null, message: typeof e === "string" ? e : "Request failed.", details: undefined };
}
