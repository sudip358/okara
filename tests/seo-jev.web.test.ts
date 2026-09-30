/**
 * [A23]/[A25] Web additions: brand split tiles, the non-brand demand-curve label, and the buyer-query and
 * translation tables. Untrusted text stays plain text; no projections; honest setup states.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEMAND_NOTE, nonBrandNote } from "@worker/seo/gsc/demand";

const src = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const NEW = ["src/web/pages/seo/components/BuyerQueriesTable.tsx", "src/web/pages/seo/components/TranslationOpportunitiesTable.tsx"];

describe("SEO web additions", () => {
  it("new tables render plain text only, use the shared coverage card, and never project outcomes", () => {
    for (const f of NEW) {
      const s = src(f);
      expect(s, f).not.toContain("dangerouslySetInnerHTML");
      expect(s, f).not.toMatch(/innerHTML|projected|forecast(ed)? (traffic|clicks|citations)|estimated (traffic|revenue)/i);
      expect(s, f).toContain("CoverageCard");
      expect(s, f).toContain("UrlText");
    }
    expect(src(NEW[0]!)).toContain("TierBadge"); // flag rows read "Check this yourself"
    expect(src(NEW[1]!)).toMatch(/Unknown/); // served language null -> Unknown
    const page = src("src/web/pages/seo/SeoAuditPage.tsx");
    expect(page).toContain("<BuyerQueriesTable");
    expect(page).toContain("<TranslationOpportunitiesTable");
  });

  it("the overview shows brand vs non-brand tiles with the API's method label", () => {
    const s = src("src/web/components/overview/MetricsPanel.tsx");
    expect(s).toContain("BrandSplitTiles");
    expect(s).toContain("split.method");
    expect(s).not.toContain("dangerouslySetInnerHTML");
  });

  it("the demand curve label keys off the API note for non-brand curves", () => {
    const chart = src("src/web/components/DemandCurveChart.tsx");
    expect(chart).toContain("/\\bNon-brand queries only\\b/");
    const note = `${DEMAND_NOTE} ${nonBrandNote({ excludedQueries: 3, excludedImpressions: 900, methodVersion: "brand-split-2026-09-30.1" })}`;
    expect(/\bNon-brand queries only\b/.test(note)).toBe(true);
    expect(/\bNon-brand queries only\b/.test(`${DEMAND_NOTE} ${nonBrandNote({ excludedQueries: 0, excludedImpressions: 0, methodVersion: "v" })}`)).toBe(true);
    expect(/\bNon-brand queries only\b/.test(DEMAND_NOTE)).toBe(false);
  });
});
