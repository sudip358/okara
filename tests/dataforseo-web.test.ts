/**
 * DataForSEO UI: pure helpers and server-rendered markup (no DOM, no live calls) for the Competitors page
 * panel and the Integrations card. Third-party keywords/URLs render as plain text; labels say "estimate".
 */
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { CompetitorDataPanel, CompetitorDomainDetail, CompetitorDomainSummary, DataForSeoCredentialStatus } from "@shared/competitor-data";
import { bucketGroups, maxCostText, provenanceLabel, refreshCostNote, refreshState, shouldPoll } from "@web/pages/geo/competitor-data-lib";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FC = (props: any) => ReactElement | null;
const load = async <T,>(rel: string): Promise<T> => (await import(/* @vite-ignore */ rel)) as T;
const panelMod = await load<Record<"CompetitorDataView" | "DomainTablesView" | "CompetitorDomainPanel", FC>>("../src/web/pages/geo/CompetitorDataPanel.tsx");
const cardMod = await load<Record<"DataForSeoRow", FC>>("../src/web/pages/integrations/DataForSeo.tsx");

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const buttons = (html: string) => [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({ label: text(m[2]!).trim(), disabled: /\sdisabled=""/.test(m[1]!) }));
const render = (el: ReactElement) => renderToStaticMarkup(h(MemoryRouter, null, el));
const noop = () => {};

const domain = (over: Partial<CompetitorDomainSummary> = {}): CompetitorDomainSummary => ({
  competitorName: "Rival Co",
  domain: "rival.example",
  latestFetch: { id: "f1", status: "completed", trigger: "competitor_added", createdAt: "2026-10-02T10:00:00.000Z", startedAt: "2026-10-02T10:00:01.000Z", finishedAt: "2026-10-02T10:00:09.000Z", costUsd: 0.03656, error: null },
  snapshot: {
    fetchId: "f1",
    fetchedAt: "2026-10-02T10:00:09.000Z",
    location: { locationCode: 2840, locationName: "United States", languageCode: "en", languageName: "English" },
    costUsd: 0.03656,
    overview: {
      organicKeywords: 3689,
      organicEtv: 16248.6,
      estimatedPaidTrafficCost: 105396.2,
      buckets: { pos_1: 26, pos_2_3: 49, pos_4_10: 569, pos_11_20: 628, pos_21_30: 510, pos_31_40: 373, pos_41_50: 312, pos_51_60: 288, pos_61_70: 260, pos_71_80: 233, pos_81_90: 251, pos_91_100: 190 },
      isNew: 1110,
      isUp: 1181,
      isDown: 1118,
      isLost: 0,
      totalCount: 3696,
    },
    endpoints: [
      { endpoint: "ranked_keywords", status: "ok", fetchedAt: "2026-10-02T10:00:09.000Z", costUsd: 0.0122, totalCount: 3696, itemCount: 2, error: null },
      { endpoint: "domain_intersection", status: "ok", fetchedAt: "2026-10-02T10:00:09.000Z", costUsd: 0.01212, totalCount: 481348, itemCount: 1, error: null },
      { endpoint: "relevant_pages", status: "ok", fetchedAt: "2026-10-02T10:00:09.000Z", costUsd: 0.01224, totalCount: 1520, itemCount: 2, error: null },
    ],
  },
  refreshesToday: 1,
  ...over,
});

const panel = (over: Partial<CompetitorDataPanel> = {}): CompetitorDataPanel => ({
  state: "ready",
  message: null,
  credentialSource: "workspace_key",
  canManage: true,
  location: { locationCode: 2840, locationName: "United States", languageCode: "en", languageName: "English" },
  locationSource: "auto",
  autoFetch: true,
  caps: { refreshesPerDomainPerDay: 2, fetchesPerProjectPerDay: 10, fetchesToday: 1, keepSnapshotsPerDomain: 3 },
  pricing: { perTaskUsd: 0.012, perItemUsd: 0.00012, maxRefreshUsd: 0.0624, readOn: "2026-10-02", sourceUrl: "https://dataforseo.com/pricing/dataforseo-labs/dataforseo-google-api" },
  limits: { topKeywords: 100, keywordGap: 100, topPages: 20 },
  ownDomain: "shop.example.com",
  domains: [domain()],
  ...over,
});

const detail = (over: Partial<CompetitorDomainDetail> = {}): CompetitorDomainDetail => ({
  ...domain(),
  ownDomain: "shop.example.com",
  topKeywords: [
    { keyword: "<script>alert(1)</script> brass knobs", position: 3, searchVolume: 5400, url: "javascript:alert(1)", etv: 120.5 },
    { keyword: "brass hinges", position: 1, searchVolume: 900, url: "https://rival.example/hinges", etv: 300 },
  ],
  keywordGap: [{ keyword: "solid brass pulls", searchVolume: 2400, competitorPosition: 7, competitorUrl: "https://rival.example/pulls", etv: 50, keywordDifficulty: 31, cpc: 1.2 }],
  topPages: [{ url: "https://rival.example/", etv: 900.5, keywords: 400, top3: 15 }],
  ...over,
});

describe("competitor data lib", () => {
  it("labels provenance as a DataForSEO estimate with location, date and cost", () => {
    const label = provenanceLabel(domain().snapshot!);
    expect(label).toMatch(/^DataForSEO estimate · United States · English · fetched .*2026 · cost \$0\.04$/);
    expect(provenanceLabel({ ...domain().snapshot!, costUsd: null, location: null })).toMatch(/location not set · fetched .* · cost unknown$/);
  });

  it("groups rank buckets and decides refresh/poll states", () => {
    expect(bucketGroups(domain().snapshot!.overview!.buckets)).toEqual([
      { label: "#1", value: 26 },
      { label: "#2–3", value: 49 },
      { label: "#4–10", value: 569 },
      { label: "#11–20", value: 628 },
      { label: "#21–100", value: 510 + 373 + 312 + 288 + 260 + 233 + 251 + 190 },
    ]);
    expect(refreshState(panel(), domain())).toEqual({ disabled: false, reason: null });
    expect(refreshState(panel({ canManage: false }), domain()).disabled).toBe(true);
    expect(refreshState(panel(), domain({ refreshesToday: 2 })).reason).toMatch(/Daily limit/);
    expect(refreshState(panel(), domain({ latestFetch: { ...domain().latestFetch!, status: "running" } })).reason).toMatch(/in progress/);
    expect(refreshState(panel({ state: "setup_required", message: "Add credentials" }), domain()).reason).toBe("Add credentials");
    expect(shouldPoll(panel())).toBe(false);
    expect(shouldPoll(panel({ domains: [domain({ latestFetch: { ...domain().latestFetch!, status: "queued" } })] }))).toBe(true);
    expect(maxCostText(0.0624)).toBe("$0.0624");
    expect(refreshCostNote(panel())).toContain("at most $0.0624");
  });
});

describe("competitor data panel markup", () => {
  it("renders the overview with honest labels, the cost before refresh, and an enabled Refresh for the owner", () => {
    const html = render(h(panelMod.CompetitorDataView, { projectId: "prj_1", panel: panel(), onChange: noop }));
    const t = text(html);
    expect(t).toContain("rival.example");
    expect(t).toContain("DataForSEO estimate · United States · English");
    expect(t).toContain("Organic keywords (estimate)");
    expect(t).toContain("3,689");
    expect(t).toContain("Est. organic traffic / month");
    expect(t).toContain("at most $0.0624");
    expect(t).toContain("Location: United States · English (from the project locale)");
    expect(buttons(html).find((b) => b.label === "Refresh data")).toEqual({ label: "Refresh data", disabled: false });
    expect(t).not.toMatch(/Search Console data shows/);
  });

  it("shows setup_required with a link to add credentials and no data", () => {
    const html = render(
      h(panelMod.CompetitorDataView, {
        projectId: "prj_1",
        panel: panel({ state: "setup_required", message: "Add DataForSEO API credentials (API login and API password) on the Integrations page to pull competitor data.", credentialSource: "none", domains: [domain({ latestFetch: null, snapshot: null, refreshesToday: 0 })] }),
        onChange: noop,
      }),
    );
    const t = text(html);
    expect(t).toContain("Setup required");
    expect(t).toContain("Add DataForSEO credentials");
    expect(t).toContain("No DataForSEO data yet for this domain.");
    expect(buttons(html).find((b) => b.label === "Refresh data")?.disabled).toBe(true);
    expect(buttons(html).some((b) => b.label === "Choose location")).toBe(false);
  });

  it("offers the location chooser when the locale is not mappable, and hides owner actions from members", () => {
    const html = render(h(panelMod.CompetitorDataView, { projectId: "prj_1", panel: panel({ state: "setup_required", message: "Choose a location", location: null, locationSource: null }), onChange: noop }));
    expect(buttons(html).some((b) => b.label === "Choose location")).toBe(true);
    const member = render(h(panelMod.CompetitorDataView, { projectId: "prj_1", panel: panel({ canManage: false }), onChange: noop }));
    expect(buttons(member).map((b) => b.label)).not.toContain("Refresh data");
    expect(buttons(member).map((b) => b.label)).not.toContain("Change location");
  });

  it("shows failed and in-progress refreshes as plain text", () => {
    const html = render(
      h(panelMod.CompetitorDataView, {
        projectId: "prj_1",
        panel: panel({ domains: [domain({ snapshot: null, latestFetch: { ...domain().latestFetch!, status: "failed", error: "The DataForSEO account balance is too low (40210). Top up the account to continue." } }), domain({ domain: "b.example", snapshot: null, latestFetch: { ...domain().latestFetch!, status: "running" } })] }),
        onChange: noop,
      }),
    );
    const t = text(html);
    expect(t).toContain("balance is too low (40210)");
    expect(t).toContain("Fetching DataForSEO data…");
  });

  it("renders keyword, gap and page tables with untrusted text escaped and unsafe URLs as text", () => {
    const html = render(h(panelMod.DomainTablesView, { detail: detail() }));
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; brass knobs");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('href="https://rival.example/hinges"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    const t = text(html);
    expect(t).toContain("Keyword gap vs shop.example.com");
    expect(t).toContain("solid brass pulls");
    expect(t).toContain("2,400");
    expect(t).toContain("Top pages (by estimated organic traffic)");
    // No invented "add to prompts" / Search Console actions: those features do not exist for keywords.
    expect(t).not.toMatch(/add to GEO prompts|check in Search Console/i);
  });

  it("shows per-endpoint errors and empty tables honestly", () => {
    const d = detail({ keywordGap: [], topPages: [] });
    d.snapshot!.endpoints = d.snapshot!.endpoints.map((e) => (e.endpoint === "relevant_pages" ? { ...e, status: "error", error: "DataForSEO did not answer in time." } : e));
    const t = text(render(h(panelMod.DomainTablesView, { detail: d })));
    expect(t).toContain("No gap keywords returned.");
    expect(t).toContain("DataForSEO did not answer in time.");
  });
});

describe("DataForSEO integrations card", () => {
  const status = (over: Partial<DataForSeoCredentialStatus> = {}): DataForSeoCredentialStatus => ({
    provider: "dataforseo",
    label: "DataForSEO (competitor data)",
    source: "workspace_key",
    keyHint: "alue",
    state: "ready",
    lastTestedAt: "2026-10-02T09:00:00.000Z",
    lastTestOk: true,
    lastTestDetail: "Credentials accepted. Balance $42.50 at test time.",
    lastBalanceUsd: 42.5,
    dataSent: "Competitor domains, your site's domain (for the keyword gap) and the project's location and language.",
    storageReady: true,
    ...over,
  });

  it("shows source, password hint, balance and save/test/delete actions; never the credentials", () => {
    const html = render(h(cardMod.DataForSeoRow, { workspaceId: "ws_1", s: status(), onChange: noop }));
    const t = text(html);
    expect(t).toContain("Workspace credentials");
    expect(t).toContain("password ending alue");
    expect(t).toContain("Remaining balance: $42.50");
    expect(t).toContain("Data sent:");
    expect(html).toContain('type="password"');
    expect(buttons(html).map((b) => b.label)).toEqual(["Save credentials", "Test saved credentials", "Delete credentials"]);
  });

  it("is setup_required without credentials and cannot test the operator's account", () => {
    const html = render(h(cardMod.DataForSeoRow, { workspaceId: "ws_1", s: status({ source: "none", keyHint: null, state: "setup_required", lastTestedAt: null, lastTestOk: null, lastTestDetail: null, lastBalanceUsd: null }), onChange: noop }));
    expect(text(html)).toContain("Setup required");
    expect(text(html)).not.toContain("Remaining balance");
    expect(buttons(html).find((b) => b.label === "Test saved credentials")?.disabled).toBe(true);
    const op = render(h(cardMod.DataForSeoRow, { workspaceId: "ws_1", s: status({ source: "operator_key", keyHint: null, lastBalanceUsd: null, lastTestedAt: null, lastTestOk: null, lastTestDetail: null }), onChange: noop }));
    expect(text(op)).toContain("Operator credentials (shared, global daily caps apply)");
    expect(buttons(op).find((b) => b.label === "Test saved credentials")?.disabled).toBe(true);
  });
});
