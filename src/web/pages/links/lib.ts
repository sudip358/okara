/** Pure helpers for the internal-links page [A25] and its workbench tabs (no DOM; unit-tested in tests/links-web*.test.ts). */
import type {
  AnchorAuditView,
  BrokenLinkRow,
  LinkGraphFilter,
  LinkGraphSort,
  LinkGraphSummary,
  LinkRole,
  LinkSuggestion,
  LinkVerificationStatus,
} from "@shared/types";
/** Same values as BadgeTone in @web/components/ui (kept local so this module stays DOM- and JSX-free for tests). */
export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info" | "demo";

export const LINK_LABEL_REVIEW = "Suggestions for review. Okara never edits your pages.";
export const LINK_LABEL_CONFIDENCE = "Confidence values are Jev's reported confidence/probability, not predicted traffic.";
export const DRAFT_LABEL = "Draft sentence — review before publishing";

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

export type GapFilter = "all" | "gap" | "no_gap";
export type MethodFilter = "all" | "existing_sentence" | "draft_sentence";
export type VerificationFilter = "all" | LinkVerificationStatus;

export interface LinkFilters {
  status: StatusFilter;
  role: LinkRole | "all" | "none";
  target: string; // target URL or "all"
  user: UserFilter;
  /** Hub URL, "none" (no cluster), or "all". */
  hub?: string;
  gap?: GapFilter;
  method?: MethodFilter;
  verification?: VerificationFilter;
}

export const DEFAULT_FILTERS: LinkFilters = { status: "actionable", role: "all", target: "all", user: "all", hub: "all", gap: "all", method: "all", verification: "all" };

export const METHOD_LABEL: Record<"existing_sentence" | "draft_sentence", string> = {
  existing_sentence: "Wrap existing sentence",
  draft_sentence: "Insert drafted sentence",
};

export function filterSuggestions(list: readonly LinkSuggestion[], f: LinkFilters): LinkSuggestion[] {
  return list.filter((s) => {
    if (f.status === "actionable" && s.status === "rejected") return false;
    if (f.status !== "actionable" && f.status !== "all" && s.status !== f.status) return false;
    if (f.role === "none" && s.role !== null) return false;
    if (f.role !== "all" && f.role !== "none" && s.role !== f.role) return false;
    if (f.target !== "all" && s.target.url !== f.target) return false;
    if (f.user !== "all" && s.userStatus !== f.user) return false;
    if (f.hub && f.hub !== "all") {
      if (f.hub === "none" ? !!s.cluster : s.cluster?.hubUrl !== f.hub) return false;
    }
    if (f.gap === "gap" && !s.cluster?.gap) return false;
    if (f.gap === "no_gap" && s.cluster?.gap) return false;
    if (f.method && f.method !== "all" && (s.placement ?? "existing_sentence") !== f.method) return false;
    if (f.verification && f.verification !== "all" && (s.verification?.status ?? "not_checked") !== f.verification) return false;
    return true;
  });
}

export type SuggestionSort = "priority" | "score";
const STATUS_RANK: Record<LinkSuggestion["status"], number> = { suggested: 0, review: 1, rejected: 2 };

/** Default: status, then priority (high first), then the legacy score. "score" ignores priority. */
export function sortSuggestions(list: readonly LinkSuggestion[], sort: SuggestionSort = "priority"): LinkSuggestion[] {
  return list.slice().sort((a, b) => {
    const st = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (st) return st;
    if (sort === "priority") {
      const pa = a.priority?.value ?? -1;
      const pb = b.priority?.value ?? -1;
      if (pa !== pb) return pb - pa;
    }
    return b.score - a.score || (a.source.url < b.source.url ? -1 : a.source.url > b.source.url ? 1 : 0);
  });
}

/** Hubs referenced by the suggestions, for the hub filter. */
export function suggestionHubs(list: readonly LinkSuggestion[]): Array<{ url: string; title: string | null }> {
  const m = new Map<string, string | null>();
  for (const s of list) if (s.cluster) m.set(s.cluster.hubUrl, s.cluster.hubTitle);
  return [...m.entries()].map(([url, title]) => ({ url, title })).sort((a, b) => (a.url < b.url ? -1 : 1));
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
  const c = { suggested: 0, review: 0, rejected: 0, open: 0, accepted: 0, dismissed: 0, implemented: 0, drafts: 0, gaps: 0 };
  for (const s of list) {
    c[s.status]++;
    c[s.userStatus]++;
    if (s.placement === "draft_sentence") c.drafts++;
    if (s.cluster?.gap) c.gaps++;
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

// ------------------------------------------------------------------------------------ workbench helpers

export type WorkbenchTab = "suggestions" | "clusters" | "graph" | "broken" | "anchors" | "placed";
export const WORKBENCH_TABS: Array<{ id: WorkbenchTab; label: string }> = [
  { id: "suggestions", label: "Suggestions" },
  { id: "clusters", label: "Clusters" },
  { id: "graph", label: "Link graph" },
  { id: "broken", label: "Broken links" },
  { id: "anchors", label: "Anchors" },
  { id: "placed", label: "Placed & verified" },
];

export function tabFromParam(v: string | null | undefined): WorkbenchTab {
  return WORKBENCH_TABS.some((t) => t.id === v) ? (v as WorkbenchTab) : "suggestions";
}

export const VERIFICATION_TONE: Record<LinkVerificationStatus, BadgeTone> = {
  verified: "success",
  not_found: "danger",
  pending: "neutral",
  source_unavailable: "warning",
  not_checked: "neutral",
};

export const VERIFICATION_FILTERS: Array<{ value: VerificationFilter; label: string }> = [
  { value: "all", label: "Any" },
  { value: "verified", label: "Verified" },
  { value: "not_found", label: "Not found" },
  { value: "pending", label: "Pending crawl" },
  { value: "source_unavailable", label: "Source unavailable" },
  { value: "not_checked", label: "Not checked" },
];

export const GRAPH_FILTER_LABEL: Record<LinkGraphFilter, string> = {
  all: "All URLs",
  orphans: "Orphans (0 inlinks)",
  no_content_links: "No content links in",
  issues: "Redirecting or failing",
  stale: "Stale snapshots",
  not_crawled: "Not crawled yet",
  hubs: "Hubs",
  sitemap: "In sitemap",
  anchor_flags: "Anchor flags",
};

export const GRAPH_SORT_LABEL: Record<LinkGraphSort, string> = {
  url: "URL",
  links_in: "Links in",
  content_links_in: "Content links in",
  links_out: "Links out",
  impressions: "Impressions",
  fetched_at: "Last crawled",
};

export interface GraphQuery {
  filter: LinkGraphFilter;
  sort: LinkGraphSort;
  dir: "asc" | "desc";
  q: string;
  offset: number;
  limit: number;
}

export const DEFAULT_GRAPH_QUERY: GraphQuery = { filter: "all", sort: "links_in", dir: "desc", q: "", offset: 0, limit: 50 };

/** Query string for GET .../graph/urls (empty search omitted). */
export function graphQueryString(q: GraphQuery): string {
  const p = new URLSearchParams({ filter: q.filter, sort: q.sort, dir: q.dir, offset: String(q.offset), limit: String(q.limit) });
  if (q.q.trim()) p.set("q", q.q.trim());
  return p.toString();
}

/** Clicking a column header: same column toggles the direction; a new column starts descending (URL ascending). */
export function nextSort(q: GraphQuery, sort: LinkGraphSort): GraphQuery {
  if (q.sort === sort) return { ...q, dir: q.dir === "asc" ? "desc" : "asc", offset: 0 };
  return { ...q, sort, dir: sort === "url" ? "asc" : "desc", offset: 0 };
}

export function issueLabel(issue: "redirect" | "client_error" | "server_error" | null, status: number | null): string {
  if (!issue) return status !== null ? `HTTP ${status}` : "Not crawled";
  if (issue === "redirect") return status !== null ? `Redirect (${status})` : "Redirect";
  return `${issue === "client_error" ? "Client error" : "Server error"}${status !== null ? ` (${status})` : ""}`;
}

export function issueTone(issue: BrokenLinkRow["issue"] | null): BadgeTone {
  return issue === "redirect" ? "warning" : issue ? "danger" : "neutral";
}

export function chainText(chain: ReadonlyArray<{ status: number; to: string }>): string {
  return chain.map((h) => `${h.status} → ${shortUrl(h.to)}`).join(" · ");
}

export const KIND_LABEL: Record<"content" | "image" | "breadcrumb" | "navigation", string> = {
  content: "Content",
  image: "Image",
  breadcrumb: "Breadcrumb",
  navigation: "Navigation / template",
};

export const ANCHOR_FLAG_LABEL: Record<AnchorAuditView["flags"][number], string> = {
  exact_match_heavy: "Exact-match heavy",
  repeated_anchor: "Repeated anchor",
  generic_anchor: "Generic anchors",
  empty_anchor: "Empty anchors",
  no_query_terms: "No query terms",
};

export const KEYWORD_BASIS_LABEL: Record<NonNullable<AnchorAuditView["keywordBasis"]>, string> = {
  search_console_query: "top Search Console query",
  h1: "H1 (no Search Console query)",
  title: "title (no Search Console query or H1)",
};

/** Download URL for an export (CSV, JSON, or the owner's sheet format), optionally limited to selected ids or statuses. */
export function exportHref(base: string, format: "csv" | "json" | "sheet", opts: { ids?: readonly string[]; userStatus?: readonly UserStatus[] } = {}): string {
  const p = new URLSearchParams({ format });
  if (opts.ids?.length) p.set("ids", opts.ids.slice(0, 500).join(","));
  if (opts.userStatus?.length) p.set("userStatus", opts.userStatus.join(","));
  return `/api${base}/export?${p.toString()}`;
}

/** "312 of 1,904 sitemap URLs analysed (oldest snapshot 2026-09-02)" plus stale and rolling-crawl context. */
export function coverageLines(g: LinkGraphSummary | null | undefined): string[] {
  if (!g || !g.coverageLabel) return [];
  const out = [g.coverageLabel];
  if (g.coverage && g.coverage.stalePages > 0) out.push(`${g.coverage.stalePages.toLocaleString("en-US")} snapshots older than ${g.coverage.staleDays} days (stale)`);
  if (g.rolling) out.push(`rolling crawl: ${g.rolling.neverCrawled.toLocaleString("en-US")} known URLs not crawled yet, up to ${g.rolling.pagesPerRun} pages per run`);
  return out;
}

/** Plain-text priority summary for a suggestion row. */
export function priorityText(s: LinkSuggestion): string {
  const p = s.priority;
  if (!p) return "—";
  return p.value.toFixed(2);
}

export function positionBandLabel(band: NonNullable<LinkSuggestion["priority"]>["positionBand"]): string {
  return { top_3: "positions 1–3", near_top: "positions 3–8", striking_distance: "striking distance 8–20", beyond_20: "beyond 20", none: "no position" }[band];
}
