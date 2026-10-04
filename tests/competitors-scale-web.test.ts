/**
 * [A39] Web side of "add competitors data from sheet": the shared 60 cap in the project form validation, domain
 * cleaning in the form (typos rejected with the suggestion, never corrected), the Import preview's DataForSEO option
 * (estimate, default on <= 10 new, off above) and typo-fix checkboxes, and the competitor panel's waiting note.
 * Server-rendered markup only (no DOM, no network).
 */
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ImportPlan } from "@shared/import";
import { MAX_COMPETITORS } from "@shared/competitors";
import { LIMITS, MAX_COMPETITORS as WEB_MAX, domainError, normalizeDomain, validateProjectInput } from "@web/lib/validation";
import { competitorFetchCaption, fetchCompetitorDataChecked, importRequestBody, stageCsv, withDomainFix } from "@web/pages/import/lib";
import { waitingText } from "@web/pages/geo/competitor-data-lib";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FC = (props: any) => ReactElement | null;
const load = async <T,>(rel: string): Promise<T> => (await import(/* @vite-ignore */ rel)) as T;
const page = await load<Record<"CompetitorImportOptions", FC>>("../src/web/pages/import/ImportPage.tsx");

function plan(over: Partial<NonNullable<ImportPlan["competitorFetch"]>> = {}, fixes: ImportPlan["domainFixes"] = []): ImportPlan {
  return {
    destination: "competitors",
    sourceLabel: 'CSV "04 - Competitors.csv"',
    rowsRead: 56,
    truncated: false,
    counts: { add: 52, update: 0, unchanged: 0, skip: 4, remove: 0, not_added: 0 },
    summary: [],
    notes: [],
    items: [],
    itemsTotal: 56,
    competitorFetch: {
      newDomains: 52,
      perDomainUsd: 0.0624,
      maxUsd: 3.2448,
      perDay: 10,
      days: 6,
      estimate: "52 new competitor domains → up to 52 × $0.0624 DataForSEO (≈$3.24), fetched at most 10 per day (about 6 days)",
      defaultOn: false,
      selected: null,
      willFetch: false,
      state: "ready",
      message: null,
      ...over,
    },
    domainFixes: fixes,
  };
}

describe("[A39] project form: 60 competitors, cleaned domains", () => {
  it("uses the shared cap and the shared cleaning rules", () => {
    expect(WEB_MAX).toBe(MAX_COMPETITORS);
    expect(WEB_MAX).toBe(60);
    expect(LIMITS.domains).toBe(5);
    const input = (n: number) => ({
      name: "P",
      siteUrl: "https://www.residence.example",
      siteType: "ecommerce" as const,
      brandName: "Residence",
      brandAliases: [],
      competitors: Array.from({ length: n }, (_, i) => ({ name: `C${i}`, domains: [`c${i}.example`], aliases: [] })),
      productDescription: "",
      audience: "",
      locale: "en-US",
      language: "en",
      voice: "",
    });
    expect(validateProjectInput(input(60)).errors.competitors).toBeUndefined();
    expect(validateProjectInput(input(61)).errors.competitors).toBe("Up to 60 competitors.");
    expect(normalizeDomain("https://www.Example.com/n/ideas?x=1")).toBe("example.com");
    expect(normalizeDomain("lights.example/")).toBe("lights.example");
    expect(normalizeDomain("Articture.Example")).toBe("articture.example");
    expect(domainError("ww.lampshop.example")).toBe('"ww.lampshop.example" looks like a typo. Did you mean lampshop.example? Type the corrected domain to add it.');
    expect(domainError("wwww.lampshop.example")).toMatch(/Did you mean lampshop\.example\?/);
    expect(domainError("not a domain")).toMatch(/is not a valid domain name/);
    // A domain already saved on the project is only checked for validity (no typo nag on every save).
    const saved = input(1);
    saved.competitors[0]!.domains = ["ww.lampshop.example"];
    expect(validateProjectInput(saved).errors["competitors.0.domains"]).toBeUndefined();
  });
});

describe("[A39] Import preview: DataForSEO option and typo fixes", () => {
  it("checkbox state: the owner's choice, else the plan default (on <= 10 new, off above)", () => {
    expect(fetchCompetitorDataChecked({}, plan())).toBe(false);
    expect(fetchCompetitorDataChecked({}, plan({ newDomains: 4, defaultOn: true }))).toBe(true);
    expect(fetchCompetitorDataChecked({ fetchCompetitorData: true }, plan())).toBe(true);
    expect(fetchCompetitorDataChecked({ fetchCompetitorData: false }, plan({ defaultOn: true }))).toBe(false);
    expect(withDomainFix({}, "ww.a.example", true)).toEqual({ acceptDomainFixes: ["ww.a.example"] });
    expect(withDomainFix({ acceptDomainFixes: ["ww.a.example"] }, "ww.a.example", false)).toEqual({});
    const tab = { ...stageCsv("04 - Competitors.csv", "Competing Domains\nexample.com"), options: { fetchCompetitorData: true, acceptDomainFixes: ["ww.a.example"] } };
    expect(importRequestBody(tab).options).toEqual({ fetchCompetitorData: true, acceptDomainFixes: ["ww.a.example"] });
  });

  it("captions: default rule, deferral, and why nothing is fetched", () => {
    expect(competitorFetchCaption(plan())).toMatch(/Default: on for up to 10 new domains, off above.*Nothing is fetched or billed now/);
    expect(competitorFetchCaption(plan({ willFetch: true, selected: true }))).toMatch(/at most 10 per project per UTC day; the rest wait for the next days/);
    expect(competitorFetchCaption(plan({ state: "setup_required", message: "DataForSEO is not configured: nothing will be fetched or billed." }))).toBe(
      "DataForSEO is not configured: nothing will be fetched or billed.",
    );
  });

  it("renders the estimate, the option (disabled without credentials) and the typo fixes as plain text", () => {
    const fixes = [{ key: "ww.lampshop.example", from: "ww.lampshop.example", to: "lampshop.example", row: 7, accepted: false }];
    const html = renderToStaticMarkup(h(page.CompetitorImportOptions, { plan: plan({}, fixes), options: {}, busy: false, onOptions: () => {} }));
    expect(html).toContain("Fetch DataForSEO data for new competitors");
    expect(html).toContain("52 new competitor domains → up to 52 × $0.0624 DataForSEO (≈$3.24), fetched at most 10 per day");
    expect(html).toContain("Row 7: ");
    expect(html).toContain("<code>ww.lampshop.example</code> → <code>lampshop.example</code>");
    expect(html).toContain("never applied automatically");
    expect(html).not.toMatch(/<input type="checkbox" checked=""[^>]*>\s*Fetch DataForSEO/); // default off above 10
    const setup = renderToStaticMarkup(h(page.CompetitorImportOptions, { plan: plan({ state: "setup_required", message: "DataForSEO is not configured: nothing will be fetched or billed." }), options: { fetchCompetitorData: true }, busy: false, onOptions: () => {} }));
    expect(setup).toMatch(/<input type="checkbox" disabled=""/);
    expect(setup).toContain("DataForSEO is not configured");
  });

  it("competitor panel: waiting backlog note", () => {
    expect(waitingText(42, 10)).toBe("42 new domains wait for later days (fetched automatically, at most 10 refreshes per day)");
    expect(waitingText(1, 10)).toBe("1 new domain waits for later days (fetched automatically, at most 10 refreshes per day)");
  });
});
