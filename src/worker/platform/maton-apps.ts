/**
 * Maton app slugs Okara knows about (no imports, so platform/maton.ts and platform/maton-credentials.ts can both use
 * them without an import cycle). Slugs from Maton's api-gateway skill docs (SKILL.md "Supported Services").
 */

/** Apps Okara's own features read through Maton (Import / live sync, Search Console sync). */
export const MATON_USED_APPS = ["google-sheets", "google-search-console"] as const;
/** Google Analytics apps: read-only report helpers exported for Ask Okara; no Okara feature uses them yet. */
export const MATON_GA_APPS = ["google-analytics-data", "google-analytics-admin"] as const;
/** Apps reported by the key test and cached in maton_connections. */
export const MATON_LISTED_APPS = [...MATON_USED_APPS, ...MATON_GA_APPS] as const;

export type MatonUsedApp = (typeof MATON_USED_APPS)[number];
export type MatonListedApp = (typeof MATON_LISTED_APPS)[number];

export const isListedApp = (s: string): s is MatonListedApp => (MATON_LISTED_APPS as readonly string[]).includes(s);
export const isUsedApp = (s: string): s is MatonUsedApp => (MATON_USED_APPS as readonly string[]).includes(s);
