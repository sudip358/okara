/**
 * Live view containers per mode (docs/live-view-design.md sections 4, 5, 17 and 18): their keys (the panel testIds
 * the run buttons and the "Containers" menu use), numbers, titles, phone-tab labels and accents, plus the
 * per-viewer show/hide state. Pure (no React, no DOM): storage is passed in, so a private window or blocked
 * storage simply means "everything shown".
 */
/** The accents of parts.tsx (kept as a plain union here so this module stays importable without JSX). */
export type Accent = "sky" | "amber" | "emerald" | "rose" | "zinc";

export type LiveModeKey = "seo" | "geo";

export interface ContainerDef {
  key: string;
  /** "01".."20" (GEO "01".."12"); empty for the GEO engine columns (a group, not a numbered panel). */
  num: string;
  title: string;
  /** Phone-width tab label. */
  tab: string;
  accent: Accent;
  /** Added by section 17 (project-level containers fetched on their own, lazily below the fold). */
  more?: boolean;
  /** Added by section 18: internal-link containers on the links workbench (fetched on their own, lazily below the fold). */
  links?: boolean;
}

/** Containers that fetch their own data and mount when they come near the viewport (sections 17 and 18). */
export const isLazy = (c: ContainerDef) => !!(c.more || c.links);

export const SEO_CONTAINERS: readonly ContainerDef[] = [
  { key: "pages", num: "01", title: "Pages being read", tab: "Crawl", accent: "sky" },
  { key: "gsc", num: "02", title: "Search Console", tab: "GSC", accent: "sky" },
  { key: "queries", num: "03", title: "Queries classified by Jev", tab: "Queries", accent: "sky" },
  { key: "elements", num: "04", title: "Every SEO element, judged one by one", tab: "Elements", accent: "sky" },
  { key: "competitors", num: "05", title: "Competitor pages worth adapting", tab: "Competitors", accent: "amber" },
  { key: "coverage", num: "06", title: "Do our pages answer what people ask AI?", tab: "Coverage", accent: "emerald" },
  { key: "ai-answers", num: "07", title: "How our pages show up in AI answers", tab: "AI answers", accent: "rose" },
  { key: "links", num: "08", title: "Internal links judged", tab: "Links", accent: "sky" },
  { key: "recs", num: "09", title: "Recommendations drafted and checked", tab: "Recs", accent: "zinc" },
  { key: "striking", num: "10", title: "Striking-distance queries", tab: "Striking", accent: "sky", more: true },
  { key: "movers", num: "11", title: "Pages gaining and losing clicks", tab: "Movers", accent: "sky", more: true },
  { key: "technical", num: "12", title: "Technical issues from the latest crawl", tab: "Technical", accent: "rose", more: true },
  { key: "competitor-gap", num: "13", title: "Competitor keyword gap (DataForSEO)", tab: "Gap", accent: "amber", more: true },
  { key: "sheets", num: "14", title: "Master sheet sync", tab: "Sheets", accent: "zinc", more: true },
  { key: "budget", num: "15", title: "Budget and quotas today", tab: "Budget", accent: "zinc", more: true },
  { key: "link-graph", num: "16", title: "Link graph coverage", tab: "Link graph", accent: "sky", links: true },
  { key: "broken-links", num: "17", title: "Broken and redirected internal links", tab: "Broken links", accent: "rose", links: true },
  { key: "cluster-gaps", num: "18", title: "Hub and cluster gaps", tab: "Clusters", accent: "emerald", links: true },
  { key: "anchor-flags", num: "19", title: "Anchor text flags", tab: "Anchors", accent: "amber", links: true },
  { key: "placed-links", num: "20", title: "Placed links verification", tab: "Placed links", accent: "zinc", links: true },
];

export const GEO_CONTAINERS: readonly ContainerDef[] = [
  { key: "lanes", num: "", title: "Engine columns", tab: "Engines", accent: "zinc" },
  { key: "heatmap", num: "01", title: "Prompt × engine", tab: "01 Prompts", accent: "sky" },
  { key: "latest-answer", num: "02", title: "Inside the latest answer", tab: "02 Latest answer", accent: "sky" },
  { key: "cited-instead", num: "03", title: "Cited instead, this run", tab: "03 Cited instead", accent: "rose" },
  { key: "coverage", num: "04", title: "Do our pages answer what people ask AI?", tab: "04 Coverage", accent: "emerald" },
  { key: "recs", num: "05", title: "Proposals drafted and checked", tab: "05 Proposals", accent: "zinc" },
  { key: "engine-queries", num: "06", title: "What the AI engines searched for", tab: "06 Engine searches", accent: "sky", more: true },
  { key: "brands", num: "07", title: "Brands in AI answers", tab: "07 Brands", accent: "emerald", more: true },
  { key: "cited-domains", num: "08", title: "Most-cited domains, last 30 days", tab: "08 Cited domains", accent: "amber", more: true },
  { key: "prompt-history", num: "09", title: "Prompt history", tab: "09 History", accent: "sky", more: true },
  { key: "sheet-prompts", num: "10", title: "AI questions from your sheet", tab: "10 Sheet questions", accent: "zinc", more: true },
  { key: "budget", num: "11", title: "Budget and quotas today", tab: "11 Budget", accent: "zinc", more: true },
  // [A37] Companion of 10 (sheet questions); appended as 12 so 10 and 11 keep their numbers.
  { key: "gsc-questions", num: "12", title: "Question queries from Search Console", tab: "12 GSC questions", accent: "sky", more: true },
];

export const containersOf = (mode: LiveModeKey): readonly ContainerDef[] => (mode === "seo" ? SEO_CONTAINERS : GEO_CONTAINERS);
export const containerDef = (mode: LiveModeKey, key: string): ContainerDef | undefined => containersOf(mode).find((c) => c.key === key);

// ------------------------------------------------------------------ show / hide (per viewer, per mode)
/** localStorage key of the hidden containers of a mode (a JSON array of keys). */
export const hiddenStorageKey = (mode: LiveModeKey) => `okara.live.hidden.${mode}`;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Known keys only, deduped; anything malformed reads as "nothing hidden" (default all on). */
export function parseHidden(raw: string | null | undefined, mode: LiveModeKey): Set<string> {
  if (!raw) return new Set();
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return new Set();
  }
  if (!Array.isArray(v)) return new Set();
  const known = new Set(containersOf(mode).map((c) => c.key));
  return new Set(v.filter((k): k is string => typeof k === "string" && known.has(k)));
}

/** Stable order (the mode's container order), so the stored value does not churn. */
export function serializeHidden(hidden: ReadonlySet<string>, mode: LiveModeKey): string {
  return JSON.stringify(containersOf(mode).map((c) => c.key).filter((k) => hidden.has(k)));
}

export function toggleHidden(hidden: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(hidden);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** Reads the stored state; a throwing or missing storage means nothing is hidden. */
export function readHidden(storage: StorageLike | null | undefined, mode: LiveModeKey): Set<string> {
  try {
    return parseHidden(storage?.getItem(hiddenStorageKey(mode)) ?? null, mode);
  } catch {
    return new Set();
  }
}

/** Best effort: a convenience only, never required for the page to work. */
export function writeHidden(storage: StorageLike | null | undefined, mode: LiveModeKey, hidden: ReadonlySet<string>): void {
  try {
    storage?.setItem(hiddenStorageKey(mode), serializeHidden(hidden, mode));
  } catch {
    /* storage unavailable: the choice lasts for this visit only */
  }
}
