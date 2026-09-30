/** Shared item-definition types, links, and small result helpers for the checklist registries. */
import type { ChecklistItem, ChecklistSection, ChecklistStatus, Completeness } from "@shared/types";
import type { Signals } from "../signals";

export type TacticTier = NonNullable<ChecklistItem["tacticTier"]>;
export type Method = ChecklistItem["method"];
export type Evidence = ChecklistItem["evidence"][number];
export type Link = ChecklistItem["links"][number];

export interface ItemResult {
  status: ChecklistStatus;
  method: Method;
  summary: string;
  evidence?: Evidence[];
  completeness?: Completeness | null;
  guidance: string;
  caveat?: string | null;
  links?: Link[];
}

export interface ItemDef<C = Signals> {
  id: string;
  section: ChecklistSection;
  label: string;
  /** Okara "SEO tactics, ranked by impact" reference tier (external opinion; ordering/display only). */
  tier: TacticTier | null;
  evaluate(ctx: C): ItemResult;
}

/** In-app deep links, relative to /projects/:projectId. */
export const LINK = {
  seo: { label: "SEO audit", to: "seo" },
  robots: { label: "robots.txt advisor", to: "seo#robots" },
  recs: { label: "Recommendations", to: "recommendations" },
  geoResults: { label: "GEO results", to: "geo/results" },
  geoPrompts: { label: "GEO prompts", to: "geo/prompts" },
  competitors: { label: "Competitors", to: "competitors" },
  integrations: { label: "Integrations", to: "integrations" },
  overview: { label: "Context documents (Overview)", to: "" },
  usage: { label: "Usage and limits", to: "usage" },
} as const satisfies Record<string, Link>;

export const MAX_EVIDENCE = 5;

/** met when nothing is wrong, not_met when everything is, partial in between; unknown with no population. */
export function ratioStatus(bad: number, total: number): ChecklistStatus {
  if (total === 0) return "unknown";
  if (bad === 0) return "met";
  if (bad >= total) return "not_met";
  return "partial";
}

export function urlEvidence(urls: Array<string | { url: string; detail?: string | null; label?: string }>, label = "Page"): Evidence[] {
  return urls.slice(0, MAX_EVIDENCE).map((u) => (typeof u === "string" ? { label, url: u, detail: null } : { label: u.label ?? label, url: u.url, detail: u.detail ?? null }));
}

export const NO_CRAWL_SUMMARY = "No completed crawl of a verified site yet, so this cannot be measured.";

export function noCrawl(ctx: Signals, guidance: string, method: Method = "measured"): ItemResult {
  return {
    status: "unknown",
    method,
    summary: NO_CRAWL_SUMMARY,
    completeness: ctx.crawlCompleteness(),
    guidance,
    links: [LINK.seo],
  };
}

export function noGsc(ctx: Signals, guidance: string, method: Method = "measured"): ItemResult {
  return {
    status: "not_connected",
    method,
    summary: "No Search Console data: connect Google Search Console (or import a CSV) to measure this.",
    completeness: ctx.gscCompleteness(),
    guidance,
    links: [LINK.integrations],
  };
}

export function manualItem(summary: string, guidance: string, extra: Partial<ItemResult> = {}): ItemResult {
  return { status: "manual", method: "manual", summary, guidance, ...extra };
}

/** A data source this app does not connect (analytics, keyword/backlink/SERP data, CWV field data). */
export function notConnected(summary: string, guidance: string, extra: Partial<ItemResult> = {}): ItemResult {
  return { status: "not_connected", method: "measured", summary, guidance, links: [LINK.integrations], ...extra };
}
