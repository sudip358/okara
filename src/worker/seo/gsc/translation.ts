/**
 * [A25] Translation opportunities from the Search Console country slices (TRANSLATION_VERSION).
 *
 * Method: current-window ['country'] rows of the latest API sync (gsc/slices.ts). Share of impressions =
 * country impressions / sum of all country rows (the country slice, not the property total; rows past
 * the slice cap are omitted and noted). A country is listed when it is not the project's locale country,
 * its share >= TRANSLATION_MIN_SHARE (5%), and it has >= TRANSLATION_MIN_IMPRESSIONS (100) impressions.
 * "zzz" (unknown region) is never listed. topPages = up to 3 URLs with the most impressions from that
 * country (['country','page'] slice). servedLanguage is null: the crawler does not store hreflang/lang
 * yet, so whether the site already serves that market's language is unknown (never guessed).
 * These rows show demand from those markets, not a promise of rankings or traffic after translating.
 */
import type { CoverageResponse, TranslationOpportunityRow } from "@shared/types";
import type { Db } from "../../lib/db";
import type { ProjectRow } from "../../platform/access";
import { parseTotalsJson, ratio } from "./aggregate";
import { countryName, localeCountryAlpha3 } from "./countries";
import { latestUsableSync } from "./overview";
import type { CountryPageTuple, CountryTuple } from "./slices";
import { windowLabel } from "./windows";

export const TRANSLATION_VERSION = "translation-opportunities-2026-09-30.1";
export const TRANSLATION_MIN_SHARE = 0.05;
export const TRANSLATION_MIN_IMPRESSIONS = 100;
export const TRANSLATION_TOP_PAGES = 3;

export const TRANSLATION_LABELS = {
  method: `Countries outside your locale's country with at least ${TRANSLATION_MIN_SHARE * 100}% of country-attributed impressions and at least ${TRANSLATION_MIN_IMPRESSIONS} impressions in the window (${TRANSLATION_VERSION}).`,
  demand: "This is demand from searchers in those markets, not a promise of rankings or traffic after translating.",
  served: "Served language: unknown. The crawler does not store hreflang or lang attributes yet, so Okara cannot tell whether you already serve these markets.",
  localize: "Where a market already speaks your language, localization (currency, shipping, units) may matter more than translation.",
  noCountry: "Country data arrives with the next Search Console API sync; CSV imports and older syncs do not include it.",
} as const;

/** Rows from the country slices (pure). `home` is the project's alpha-3 country, or null when unknown. */
export function translationRows(countries: CountryTuple[], countryPages: CountryPageTuple[], home: string | null, window: string): TranslationOpportunityRow[] {
  const total = countries.reduce((n, [, , i]) => n + i, 0);
  if (total <= 0) return [];
  const out: TranslationOpportunityRow[] = [];
  for (const [country, clicks, impressions] of countries) {
    const code = country.toLowerCase();
    if (code === "zzz" || (home && code === home)) continue;
    const share = ratio(impressions, total);
    if (impressions < TRANSLATION_MIN_IMPRESSIONS || (share.value ?? 0) < TRANSLATION_MIN_SHARE) continue;
    const topPages = countryPages
      .filter(([c]) => c.toLowerCase() === code)
      .sort((a, b) => b[3] - a[3] || (a[1] < b[1] ? -1 : 1))
      .slice(0, TRANSLATION_TOP_PAGES)
      .map(([, page]) => page);
    const name = countryName(code) ?? code.toUpperCase();
    out.push({
      country: code,
      impressions,
      clicks,
      shareOfImpressions: share,
      topPages,
      servedLanguage: null,
      note: `Searchers in ${name} saw your pages ${impressions.toLocaleString("en-US")} times in ${window}. This shows demand from that market, not a promise of rankings or traffic after translating.`,
    });
  }
  return out.sort((a, b) => b.impressions - a.impressions || (a.country < b.country ? -1 : 1));
}

export async function buildTranslationOpportunities(db: Db, project: Pick<ProjectRow, "id" | "workspace_id" | "locale" | "is_demo">, now: Date): Promise<CoverageResponse<TranslationOpportunityRow>> {
  const generatedAt = now.toISOString();
  const isDemo = project.is_demo === 1;
  const sync = await latestUsableSync(db, project.workspace_id, project.id);
  const extras = sync ? parseTotalsJson(sync.totals_json).extras : undefined;
  if (!sync || !extras?.countries) {
    return {
      state: isDemo ? "demo" : "setup_required",
      generatedAt,
      rows: [],
      completeness: { note: sync ? "The latest sync has no country data." : "No Search Console data imported yet.", covered: null, total: null },
      labels: [TRANSLATION_LABELS.noCountry],
    };
  }
  const home = localeCountryAlpha3(project.locale);
  const window = windowLabel(extras.countries.window);
  const rows = translationRows(extras.countries.rows, extras.countryPages?.rows ?? [], home, window);
  const labels: string[] = [TRANSLATION_LABELS.method, TRANSLATION_LABELS.demand, TRANSLATION_LABELS.served, TRANSLATION_LABELS.localize];
  if (!home) labels.push(`Your project locale (${project.locale}) has no country, so every country is compared.`);
  const notes: string[] = [`${rows.length} of ${extras.countries.rows.length} countries in ${window} meet the threshold`];
  if (extras.countries.truncated) notes.push("the country slice was truncated at its row cap");
  if (!extras.countryPages) notes.push("top pages unavailable (no country+page slice)");
  else if (extras.countryPages.truncated) notes.push("country+page rows were truncated, so top pages may be incomplete");
  return {
    state: isDemo ? "demo" : "ready",
    generatedAt,
    rows,
    completeness: { note: `${notes.join("; ")}.`, covered: rows.length, total: extras.countries.rows.length },
    labels,
  };
}
