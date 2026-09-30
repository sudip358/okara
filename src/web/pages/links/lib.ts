/** Pure helpers for the internal-links page [A25] (no DOM, unit-tested in tests/links-web.test.ts). */
import type { LinkRole, LinkSuggestion } from "@shared/types";

export const LINK_LABEL_REVIEW = "Suggestions for review. Okara never edits your pages.";
export const LINK_LABEL_CONFIDENCE = "Confidence values are Jev's reported confidence/probability, not predicted traffic.";

export const ROLE_LABEL: Record<LinkRole, string> = {
  explains_concept: "Explains a concept",
  deeper_detail: "Deeper detail",
  broader_guide: "Broader guide",
  next_step: "Next step",
  product_service: "Product / service",
  comparison: "Comparison",
};
export const ROLES = Object.keys(ROLE_LABEL) as LinkRole[];

export type StatusFilter = "actionable" | "suggested" | "review" | "rejected" | "all";
export const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: "actionable", label: "Suggested + review" },
  { value: "suggested", label: "Suggested" },
  { value: "review", label: "Review" },
  { value: "rejected", label: "Rejected" },
  { value: "all", label: "All" },
];

export type UserStatus = LinkSuggestion["userStatus"];
export type UserFilter = UserStatus | "all";
export const USER_STATUS_LABEL: Record<UserStatus, string> = {
  open: "Open",
  accepted: "Accepted",
  dismissed: "Dismissed",
  implemented: "Implemented",
};

export interface LinkFilters {
  status: StatusFilter;
  role: LinkRole | "all" | "none";
  target: string; // target URL or "all"
  user: UserFilter;
}

export const DEFAULT_FILTERS: LinkFilters = { status: "actionable", role: "all", target: "all", user: "all" };

export function filterSuggestions(list: readonly LinkSuggestion[], f: LinkFilters): LinkSuggestion[] {
  return list.filter((s) => {
    if (f.status === "actionable" && s.status === "rejected") return false;
    if (f.status !== "actionable" && f.status !== "all" && s.status !== f.status) return false;
    if (f.role === "none" && s.role !== null) return false;
    if (f.role !== "all" && f.role !== "none" && s.role !== f.role) return false;
    if (f.target !== "all" && s.target.url !== f.target) return false;
    if (f.user !== "all" && s.userStatus !== f.user) return false;
    return true;
  });
}

/**
 * Split a plain-text sentence around the first case-insensitive occurrence of the anchor, so the UI can
 * highlight it with a <mark> element (never by injecting HTML). null when the anchor is absent.
 */
export function splitAnchor(sentence: string, anchor: string | null | undefined): { before: string; match: string; after: string } | null {
  if (!anchor) return null;
  const i = sentence.toLowerCase().indexOf(anchor.toLowerCase());
  if (i < 0) return null;
  return { before: sentence.slice(0, i), match: sentence.slice(i, i + anchor.length), after: sentence.slice(i + anchor.length) };
}

/** "93%" for a 0..1 value; "—" when null. */
export function pct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${Math.round(v * 100)}%`;
}

/** Path + query of a URL for compact display; the input when it does not parse. */
export function shortUrl(u: string): string {
  try {
    const x = new URL(u);
    return `${x.pathname}${x.search}` || "/";
  } catch {
    return u;
  }
}

/** Only http(s) URLs become links. */
export function safeHref(u: string): string | null {
  try {
    const x = new URL(u);
    return x.protocol === "https:" || x.protocol === "http:" ? x.toString() : null;
  } catch {
    return null;
  }
}

export function counts(list: readonly LinkSuggestion[]) {
  const c = { suggested: 0, review: 0, rejected: 0, open: 0, accepted: 0, dismissed: 0, implemented: 0 };
  for (const s of list) {
    c[s.status]++;
    c[s.userStatus]++;
  }
  return c;
}

/** Labels other than the two always-shown notices (method notes, caveats, setup messages). */
export function extraLabels(labels: readonly string[]): string[] {
  return labels.filter((l) => l !== LINK_LABEL_REVIEW && l !== LINK_LABEL_CONFIDENCE);
}

/**
 * Notices about Jev availability that the page shows as a banner (the run itself succeeds; affected pairs
 * are deterministic review suggestions). Matches the label texts written by src/worker/links/run.ts.
 */
export function jevNotices(labels: readonly string[]): { budget: string | null; unavailable: string | null; notConfigured: string | null } {
  return {
    budget: labels.find((l) => l.startsWith("Jev budget reached")) ?? null,
    unavailable: labels.find((l) => l.startsWith("Jev could not be reached")) ?? null,
    notConfigured: labels.find((l) => l.startsWith("Jev (TypeSafe) is not configured")) ?? null,
  };
}
