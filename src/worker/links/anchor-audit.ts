/**
 * Anchor text audit (internal-links workbench 2026-10-03, item 6). Pure over the link graph: per target page, the
 * anchor texts of CONTENT links pointing to it (navigation, header, footer, sidebar and breadcrumb links are excluded;
 * one count per source page and distinct anchor). Thresholds are engineering defaults (ANCHOR_AUDIT_VERSION), not
 * search-engine rules, and every flag says which threshold it crossed.
 *
 * Keyword ("exact match"): the target's top non-brand Search Console query by impressions (latest stored sync,
 * current window); without Search Console data, the target's H1 (else its title before a "|"/"–" separator),
 * labelled as such. An anchor is an exact match when its normalized text equals the normalized keyword.
 *
 * Flags (a target is audited when it has at least MIN_ANCHORED_INLINKS anchored content links):
 *   exact_match_heavy  more than EXACT_MATCH_SHARE of anchored inlinks use the exact-match anchor, with at least
 *                      EXACT_MATCH_MIN_INLINKS anchored inlinks;
 *   repeated_anchor    one identical anchor from at least REPEATED_MIN_SOURCES sources AND at least REPEATED_SHARE of
 *                      anchored inlinks;
 *   generic_anchor     any generic anchor ("click here", "read more", ...; links/anchors.ts isGenericAnchor);
 *   empty_anchor       content links with no anchor text (no text, no image alt, no aria-label);
 *   no_query_terms     the target has Search Console queries and none of its anchors contains a term of its top
 *                      queries (stopwords ignored, simple plural folding), with at least MIN_ANCHORED_INLINKS inlinks.
 * New suggestions avoid an anchor that would worsen a repetition flag (`worsensRepetition`).
 */
import { isGenericAnchor } from "./anchors";
import { normalizeAnchorText, type GraphNode, type LinkGraph } from "./graph";
import { titleTerms } from "../writing/validate";

export const ANCHOR_AUDIT_VERSION = "links-anchor-audit-2026-10-03.1";
export const ANCHOR_THRESHOLDS = {
  MIN_ANCHORED_INLINKS: 3,
  EXACT_MATCH_SHARE: 0.5,
  EXACT_MATCH_MIN_INLINKS: 5,
  REPEATED_MIN_SOURCES: 10,
  REPEATED_SHARE: 0.6,
} as const;

export type AnchorFlag = "exact_match_heavy" | "repeated_anchor" | "generic_anchor" | "empty_anchor" | "no_query_terms";

export interface AnchorAudit {
  target: number;
  /** Distinct (source, anchor) uses; a source using two anchors counts twice. */
  anchoredInlinks: number;
  distinctAnchors: number;
  keyword: string | null;
  keywordBasis: "search_console_query" | "h1" | "title" | null;
  exactMatchSources: number;
  exactMatchShare: number | null;
  top: Array<{ text: string; sources: number; share: number }>;
  generic: Array<{ text: string; sources: number }>;
  emptyAnchors: number;
  queryTerms: string[];
  flags: AnchorFlag[];
  reasons: string[];
}

function keywordOf(n: GraphNode): { keyword: string | null; basis: AnchorAudit["keywordBasis"] } {
  const q = n.topQueries[0]?.query;
  if (q) return { keyword: q, basis: "search_console_query" };
  if (n.h1) return { keyword: n.h1, basis: "h1" };
  if (n.title) return { keyword: n.title.split(/\s[|–—-]\s/)[0]!.trim() || null, basis: "title" };
  return { keyword: null, basis: null };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function auditAnchors(n: GraphNode): AnchorAudit | null {
  const uses = [...n.anchors.values()];
  const anchored = uses.reduce((a, u) => a + u.sources, 0);
  if (anchored === 0 && n.emptyAnchors === 0) return null;
  const T = ANCHOR_THRESHOLDS;
  const { keyword, basis } = keywordOf(n);
  const kw = keyword ? normalizeAnchorText(keyword) : "";
  const exact = kw ? (n.anchors.get(kw)?.sources ?? 0) : 0;
  const sorted = uses.slice().sort((a, b) => b.sources - a.sources || (a.text < b.text ? -1 : 1));
  const top = sorted.slice(0, 10).map((u) => ({ text: u.text, sources: u.sources, share: anchored ? Math.round((u.sources / anchored) * 1000) / 1000 : 0 }));
  const generic = sorted.filter((u) => isGenericAnchor(u.text)).map((u) => ({ text: u.text, sources: u.sources }));
  const queryTerms = [...new Set(n.topQueries.flatMap((q) => [...titleTerms(q.query)]))].slice(0, 12);
  const flags: AnchorFlag[] = [];
  const reasons: string[] = [];
  const share = anchored ? exact / anchored : null;
  if (anchored >= T.EXACT_MATCH_MIN_INLINKS && share !== null && share > T.EXACT_MATCH_SHARE) {
    flags.push("exact_match_heavy");
    reasons.push(`${pct(share)} of ${anchored} anchored links use the exact-match anchor "${keyword}" (threshold: more than ${pct(T.EXACT_MATCH_SHARE)} with at least ${T.EXACT_MATCH_MIN_INLINKS} links).`);
  }
  const first = sorted[0];
  if (first && first.sources >= T.REPEATED_MIN_SOURCES && first.sources / anchored >= T.REPEATED_SHARE) {
    flags.push("repeated_anchor");
    reasons.push(`"${first.text}" is used by ${first.sources} of ${anchored} anchored links (threshold: at least ${T.REPEATED_MIN_SOURCES} sources and ${pct(T.REPEATED_SHARE)}).`);
  }
  if (generic.length) {
    flags.push("generic_anchor");
    reasons.push(`Generic anchor text: ${generic.slice(0, 3).map((g) => `"${g.text}" (${g.sources})`).join(", ")}.`);
  }
  if (n.emptyAnchors > 0) {
    flags.push("empty_anchor");
    reasons.push(`${n.emptyAnchors} content link${n.emptyAnchors === 1 ? " has" : "s have"} no anchor text (no text, image alt, or aria-label).`);
  }
  if (anchored >= T.MIN_ANCHORED_INLINKS && queryTerms.length > 0) {
    const hit = uses.some((u) => {
      const terms = titleTerms(u.text);
      return queryTerms.some((t) => terms.has(t));
    });
    if (!hit) {
      flags.push("no_query_terms");
      reasons.push(`None of the ${uses.length} anchor texts contains a term of the page's top Search Console queries (${n.topQueries.map((q) => `"${q.query}"`).join(", ")}).`);
    }
  }
  return {
    target: n.id,
    anchoredInlinks: anchored,
    distinctAnchors: uses.length,
    keyword,
    keywordBasis: basis,
    exactMatchSources: exact,
    exactMatchShare: share === null ? null : Math.round(share * 1000) / 1000,
    top,
    generic,
    emptyAnchors: n.emptyAnchors,
    queryTerms,
    flags,
    reasons,
  };
}

export function auditAllAnchors(graph: LinkGraph): Map<number, AnchorAudit> {
  const out = new Map<number, AnchorAudit>();
  for (const n of graph.nodes) {
    const a = auditAnchors(n);
    if (a) out.set(n.id, a);
  }
  return out;
}

/**
 * True when adding one more link with `anchor` to the audited target would keep or push it over a repetition
 * threshold: the anchor is the target's most-used anchor and that anchor already has REPEATED_SHARE of at least 5
 * anchored links, or the anchor is the exact-match keyword and exact matches would exceed EXACT_MATCH_SHARE.
 */
export function worsensRepetition(audit: AnchorAudit | null | undefined, anchor: string): boolean {
  if (!audit || audit.anchoredInlinks === 0) return false;
  const T = ANCHOR_THRESHOLDS;
  const norm = normalizeAnchorText(anchor);
  if (!norm) return false;
  const top = audit.top[0];
  if (top && normalizeAnchorText(top.text) === norm && audit.anchoredInlinks >= 5 && (top.sources + 1) / (audit.anchoredInlinks + 1) >= T.REPEATED_SHARE) return true;
  if (audit.keyword && normalizeAnchorText(audit.keyword) === norm) {
    const after = (audit.exactMatchSources + 1) / (audit.anchoredInlinks + 1);
    if (audit.anchoredInlinks + 1 >= T.EXACT_MATCH_MIN_INLINKS && after > T.EXACT_MATCH_SHARE) return true;
  }
  return false;
}

export const ANCHOR_FLAG_LABEL: Record<AnchorFlag, string> = {
  exact_match_heavy: "Exact-match heavy",
  repeated_anchor: "Repeated anchor",
  generic_anchor: "Generic anchors",
  empty_anchor: "Empty anchors",
  no_query_terms: "No query terms",
};
