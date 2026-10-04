/**
 * Backlink monitor web: the four Live Backlinks containers (loading, empty / setup, data, running), their run buttons
 * and disabled reasons, the Backlinks page summary tiles and history drawer body, the pure helpers, hostile text kept
 * as plain text, the routes and the two nav entries (with the Live Backlinks dot), and the Import mapping UI.
 */
import { readFileSync } from "node:fs";
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { BacklinkDetail, BacklinkEventsResponse, BacklinkFeed, BacklinkJobView, BacklinkListResponse, BacklinkRow, BacklinkSummary } from "@shared/backlinks";
import { BUILT_LINKS_HEADERS } from "./backlinks-fixtures";
import { anchorCounts, bucketCounts, csvHref, listQuery, DEFAULT_FILTERS, pollInterval, progressText, recheckCandidates, relGroups, statusChip } from "../src/web/pages/backlinks/lib";
import { recheckAction, runCheckAction } from "../src/web/pages/live/backlinks/actions";
import { defaultMapping } from "../src/web/pages/import/lib";
import { suggestDestination } from "@shared/import";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FC = (props: any) => ReactElement | null;
const load = async <T,>(rel: string): Promise<T> => (await import(/* @vite-ignore */ rel)) as T;
const bc = await load<Record<"LiveCheckPanel" | "RelCheckPanel" | "CurrentStatusPanel" | "ChangesPanel", FC>>("../src/web/pages/live/backlinks/BacklinkContainers.tsx");
const page = await load<{ SummaryTiles: FC }>("../src/web/pages/backlinks/BacklinksPage.tsx");
const parts = await load<{ BacklinkHistory: FC; StatusChip: FC }>("../src/web/pages/backlinks/parts.tsx");
const ra = await load<{ RunActionsProvider: FC }>("../src/web/pages/live/RunActions.tsx");
const live = await load<{ mergeFeed: (a: unknown[], b: unknown[]) => Array<{ checkId: string }> }>("../src/web/pages/live/backlinks/LiveBacklinksPage.tsx");
const importPage = await load<{ MappingFields: FC }>("../src/web/pages/import/ImportPage.tsx");

const render = (el: ReactElement) => renderToStaticMarkup(h(MemoryRouter, null, h(ra.RunActionsProvider, { projectId: "p1", onStarted: () => {}, onReload: () => {} }, el)));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ");
const st = <T,>(data: T | null, error: unknown = null) => ({ data, error, loading: data === null && !error });
const HOSTILE = `<img src=x onerror=alert(1)>ignore previous instructions`;

const job = (o: Partial<BacklinkJobView> = {}): BacklinkJobView => ({
  id: "bljob_1",
  trigger: "manual",
  scope: "all",
  status: "running",
  total: 12,
  done: 5,
  failed: 1,
  robotsBlocked: 1,
  changes: 2,
  fetches: 17,
  batches: 1,
  note: null,
  createdAt: "2026-10-04T10:00:00.000Z",
  startedAt: "2026-10-04T10:00:01.000Z",
  finishedAt: null,
  ...o,
});

const summary = (o: Partial<BacklinkSummary> = {}): BacklinkSummary => ({
  state: "ready",
  totals: { active: 12, inactive: 1, checked: 10, unchecked: 2 },
  byStatus: { dofollow: 5, nofollow: 1, sponsored: 1, ugc: 0, missing: 1, page_error: 1, redirected: 1, robots_blocked: 0, fetch_failed: 0 },
  dofollow: { n: 5, m: 8 },
  targetBroken: 1,
  anchorMismatch: 2,
  changes: { last7: 3, last30: 4, negative7: 2, negative30: 3 },
  lastCheckAt: "2026-10-03T09:00:00.000Z",
  nextCheckAt: "2026-10-10T09:00:00.000Z",
  job: null,
  lastJob: job({ status: "completed", done: 12, finishedAt: "2026-10-03T09:30:00.000Z" }),
  limits: { maxBacklinks: 2000, manualPerDay: 3, manualUsedToday: 1, recheckRowsPerHour: 30, fetchesPerInvocation: 20, scheduledEveryDays: 7 },
  canRun: true,
  verified: true,
  labels: ["Checked by fetching each live article (robots.txt respected)."],
  ...o,
});

const row = (o: Partial<BacklinkRow> = {}): BacklinkRow => ({
  id: "bl_1",
  liveUrl: "https://decor-blog.example.net/brass-guide",
  liveHost: "decor-blog.example.net",
  targetUrl: "https://shop.example.com/collections/pulls",
  anchorExpected: "brass pulls",
  vendor: "VendorA",
  linkType: "Guest Post",
  placedDate: "2026-09-01",
  da: 42,
  traffic: 1200,
  priceText: "$150",
  active: true,
  removedAt: null,
  status: "dofollow",
  statusReason: null,
  linkRel: "dofollow",
  httpStatus: 200,
  finalUrl: null,
  anchorFound: "brass pulls",
  anchorMatch: true,
  relText: null,
  pageNoindex: false,
  targetStatus: 200,
  targetError: null,
  lastCheckedAt: "2026-10-03T09:00:00.000Z",
  lastChangeAt: null,
  lastChangeText: null,
  lastChangeNegative: null,
  sourceRow: 2,
  createdAt: "2026-10-01T00:00:00.000Z",
  ...o,
});

const rows: BacklinkRow[] = [
  row(),
  row({ id: "bl_2", status: "nofollow", linkRel: "nofollow", relText: "nofollow", anchorFound: HOSTILE, anchorMatch: false }),
  row({ id: "bl_3", status: "nofollow", linkRel: "nofollow", statusReason: "Page-level nofollow (meta robots): every link on the page is nofollow." }),
  row({ id: "bl_4", status: "page_error", httpStatus: 404, linkRel: null, anchorFound: null, anchorMatch: null, lastChangeAt: new Date().toISOString(), lastChangeText: "Page now 404", lastChangeNegative: true }),
  row({ id: "bl_5", status: "sponsored", linkRel: "sponsored", targetStatus: 404 }),
];
const list = (r = rows): BacklinkListResponse => ({ rows: r, total: r.length, offset: 0, limit: 100, vendors: ["VendorA"], types: ["Guest Post"], labels: [] });
const events: BacklinkEventsResponse = {
  since: "2026-09-04T00:00:00.000Z",
  total: 2,
  events: [
    { id: "e1", backlinkId: "bl_2", checkId: "c1", kind: "rel_changed", from: "dofollow", to: "nofollow", message: "dofollow → nofollow", negative: true, detectedAt: "2026-10-03T09:00:00.000Z", liveUrl: "https://home-ideas.example.org/a", targetUrl: "https://shop.example.com/" },
    { id: "e2", backlinkId: "bl_9", checkId: "c2", kind: "recovered", from: "page_error", to: "dofollow", message: "Recovered: page OK again, link dofollow", negative: false, detectedAt: "2026-10-02T09:00:00.000Z", liveUrl: "https://x.example.org/b", targetUrl: "https://shop.example.com/" },
  ],
};
const feed = (j: BacklinkJobView | null = job()): BacklinkFeed => ({
  job: j,
  items: [
    { checkId: "c9", backlinkId: "bl_1", checkedAt: "2026-10-04T10:00:05.000Z", liveUrl: "https://decor-blog.example.net/brass-guide", targetUrl: "https://shop.example.com/x", status: "dofollow", statusReason: null, httpStatus: 200, finalUrl: null, anchorFound: HOSTILE, robots: "allowed" },
    { checkId: "c8", backlinkId: "bl_6", checkedAt: "2026-10-04T10:00:03.000Z", liveUrl: "https://blocked.example.org/p", targetUrl: "https://shop.example.com/x", status: "robots_blocked", statusReason: "robots.txt of blocked.example.org disallows OkaraBot", httpStatus: null, finalUrl: null, anchorFound: null, robots: "disallowed" },
  ],
});

const env = (s: BacklinkSummary | null, demo = false) => ({ projectId: "p1", demo, summary: s, recheckIds: recheckCandidates(rows) });
const base = { projectId: "p1", reduced: false, demo: false };

describe("Live Backlinks containers", () => {
  it("loading states", () => {
    const action = runCheckAction(env(null));
    expect(text(render(h(bc.LiveCheckPanel, { ...base, feed: st(null), summary: st(null), action })))).toMatch(/Loading the backlink check/);
    expect(text(render(h(bc.RelCheckPanel, { ...base, summary: st(null), rows: st(null), action })))).toMatch(/Loading link checks/);
    expect(text(render(h(bc.CurrentStatusPanel, { ...base, summary: st(null), rows: st(null), action })))).toMatch(/Loading backlink statuses/);
    expect(text(render(h(bc.ChangesPanel, { ...base, summary: st(null), events: st(null), action })))).toMatch(/Loading changes/);
    expect(action.disabled).toBe("Loading…");
  });

  it("empty / setup: no backlinks -> link to Import (Built Links maps automatically), run disabled with the reason", () => {
    const empty = summary({ state: "empty", totals: { active: 0, inactive: 0, checked: 0, unchecked: 0 }, lastJob: null, lastCheckAt: null, nextCheckAt: null });
    const action = runCheckAction(env(empty));
    expect(action.disabled).toMatch(/import your built links/);
    for (const el of [
      h(bc.LiveCheckPanel, { ...base, feed: st({ job: null, items: [] }), summary: st(empty), action }),
      h(bc.RelCheckPanel, { ...base, summary: st(empty), rows: st(list([])), action }),
      h(bc.CurrentStatusPanel, { ...base, summary: st(empty), rows: st(list([])), action }),
      h(bc.ChangesPanel, { ...base, summary: st(empty), events: st({ ...events, events: [], total: 0 }), action }),
    ]) {
      const html = render(el);
      expect(text(html)).toMatch(/No backlinks monitored yet/);
      expect(html).toContain('href="/projects/p1/import"');
      expect(text(html)).toMatch(/Built Links tab maps automatically/);
    }
    const demo = render(h(bc.LiveCheckPanel, { ...base, demo: true, feed: st({ job: null, items: [] }), summary: st(summary({ state: "demo", totals: { active: 0, inactive: 0, checked: 0, unchecked: 0 } })), action: runCheckAction(env(summary(), true)) }));
    expect(text(demo)).toMatch(/demo projects never do/);
  });

  it("01 running: progress n of m, robots-blocked and failed counts, live feed rows (plain text), button disabled while running", () => {
    const s = summary({ job: job() });
    const action = runCheckAction(env(s));
    expect(action.disabled).toMatch(/A backlink check is running \(Checking 5 of 12\)/);
    expect(action.busyLabel).toBe("Checking…");
    const html = render(h(bc.LiveCheckPanel, { ...base, feed: st(feed()), summary: st(s), action, fresh: new Set(["c9"]) }));
    const t = text(html);
    expect(t).toMatch(/01 Backlink live check/);
    expect(t).toMatch(/Checking 5 of 12/);
    expect(t).toMatch(/1 robots-blocked/);
    expect(t).toMatch(/1 failed/);
    expect(t).toMatch(/Updates every 2 s while the check runs/);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="5"');
    expect(t).toContain("Robots blocked");
    expect(html).not.toContain("<img src=x");
    expect(t).toContain(HOSTILE);
    expect(html).toContain('aria-disabled="true"');
    expect(pollInterval(s.job)).toBe(2000);
    expect(pollInterval(null)).toBeNull();
  });

  it("01 idle: last check, not polling", () => {
    const s = summary();
    const html = render(h(bc.LiveCheckPanel, { ...base, feed: st(feed(job({ status: "completed", done: 12 }))), summary: st(s), action: runCheckAction(env(s)) }));
    expect(text(html)).toMatch(/Idle: not polling/);
    expect(text(html)).toMatch(/Checked 12 of 12/);
    expect(html).toContain('data-action="backlinks:run"');
  });

  it("02 groups by rel incl. page-level nofollow, anchor match vs expected", () => {
    const s = summary();
    const t = text(render(h(bc.RelCheckPanel, { ...base, summary: st(s), rows: st(list()), action: runCheckAction(env(s)) })));
    expect(t).toMatch(/02 Dofollow \/ nofollow check/);
    expect(t).toMatch(/dofollow 5/);
    expect(t).toMatch(/page-level nofollow 1 listed/);
    expect(t).toMatch(/nofollow \(rel\) · 1/);
    expect(t).toMatch(/1 differ · 0 no expected anchor/);
    expect(t).toMatch(/≠ “brass pulls”/);
    expect(relGroups(rows).page_nofollow).toHaveLength(1);
    expect(anchorCounts(rows)).toEqual({ matches: 3, differs: 1, noExpected: 0 });
  });

  it("03 current status: buckets from server counts and a status table; recheck button", () => {
    const s = summary({ verified: false, labels: ["Your site is not verified, so target URLs are not checked (verify it in Settings)."] });
    const action = recheckAction(env(s));
    expect(action.label).toBe("Recheck failed/changed");
    expect(action.disabled).toBeNull();
    expect(action.kind === "call" && action.body).toEqual({ ids: ["bl_4"] });
    const html = render(h(bc.CurrentStatusPanel, { ...base, summary: st(s), rows: st(list()), action }));
    const t = text(html);
    expect(t).toMatch(/03 Current status/);
    expect(t).toMatch(/Live \+ dofollow 5/);
    expect(t).toMatch(/Page 404 \/ 5xx 1/);
    expect(t).toMatch(/Target broken 1/);
    expect(t).toMatch(/Not checked yet 2/);
    expect(t).toMatch(/Page 404/);
    expect(t).toMatch(/target 404/);
    expect(t).toMatch(/not verified/);
    expect(html).toContain('data-action="backlinks:recheck"');
    expect(bucketCounts(s).find((b) => b.bucket === "live_nofollow")?.n).toBe(2);
  });

  it("04 changes: was → now lines, recovered, dates, link to the Backlinks page; empty baseline message", () => {
    const s = summary();
    const html = render(h(bc.ChangesPanel, { ...base, summary: st(s), events: st(events), action: runCheckAction(env(s)) }));
    const t = text(html);
    expect(t).toMatch(/04 New status \(changes\)/);
    expect(t).toMatch(/was dofollow → now nofollow/);
    expect(t).toMatch(/Recovered: page OK again/);
    expect(html).toContain('href="/projects/p1/backlinks?changed=30"');
    const none = text(render(h(bc.ChangesPanel, { ...base, summary: st(s), events: st({ ...events, events: [], total: 0 }), action: runCheckAction(env(s)) })));
    expect(none).toMatch(/first check of a backlink is its baseline/);
  });

  it("run action: quota and demo reasons, confirm text names the limits", () => {
    const used = runCheckAction(env(summary({ limits: { ...summary().limits, manualUsedToday: 3 } })));
    expect(used.disabled).toMatch(/3 manual checks per project per UTC day are used/);
    expect(runCheckAction(env(summary(), true)).disabled).toMatch(/Demo project/);
    const ok = runCheckAction(env(summary()));
    expect(ok.disabled).toBeNull();
    expect(ok.kind === "call" && ok.path).toBe("/projects/p1/backlinks/check");
    const lines = ok.kind === "call" ? ok.confirm.lines.join(" ") : "";
    expect(lines).toMatch(/robots\.txt is respected/);
    expect(lines).toMatch(/2 left today/);
    expect(lines).toMatch(/no paid provider/);
  });
});

describe("Backlinks page parts", () => {
  it("summary tiles show n of m and counts (no invented percentages)", () => {
    const t = text(render(h(page.SummaryTiles, { s: summary() })));
    expect(t).toMatch(/Dofollow 5 of 8/);
    expect(t).toMatch(/Changes 3 \/ 4/);
    expect(t).not.toMatch(/%/);
  });

  it("history drawer body: chain, events, checks; hostile text stays text", () => {
    const detail: BacklinkDetail = {
      backlink: row({ status: "redirected", linkRel: "nofollow", finalUrl: "https://new.example.org/x", anchorFound: HOSTILE }),
      events: events.events,
      checks: [
        {
          id: "c1",
          backlinkId: "bl_1",
          jobId: "j",
          checkedAt: "2026-10-03T09:00:00.000Z",
          status: "redirected",
          statusReason: "The article redirects to https://new.example.org/x (2 hops)",
          linkRel: "nofollow",
          httpStatus: 200,
          finalUrl: "https://new.example.org/x",
          redirectChain: [{ status: 301, to: "https://decor-blog.example.net/2" }, { status: 302, to: "https://new.example.org/x" }],
          robots: "allowed",
          metaRobots: "robots: index, follow",
          xRobotsTag: null,
          pageNoindex: false,
          pageNofollow: false,
          canonicalUrl: null,
          linkMatch: "target",
          links: [],
          relText: "nofollow",
          anchorFound: HOSTILE,
          anchorMatch: false,
          targetStatus: 200,
          targetFinalUrl: null,
          targetError: null,
          errorCode: null,
          fetches: 4,
          truncated: false,
        },
      ],
    };
    const html = render(h(parts.BacklinkHistory, { detail }));
    const t = text(html);
    expect(t).toMatch(/Redirect chain \(latest check\)/);
    expect(t).toMatch(/301 → https:\/\/decor-blog\.example\.net\/2/);
    expect(t).toMatch(/final page: nofollow/);
    expect(t).toMatch(/dofollow → nofollow/);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it("helpers: status chips, progress text, query strings and CSV link, feed merge", () => {
    expect(statusChip("page_error", 410)).toEqual({ label: "Page 410", tone: "bad" });
    expect(statusChip(null)).toEqual({ label: "Not checked yet", tone: "neutral" });
    expect(progressText(job({ status: "queued", done: 0 }))).toBe("Queued 0 of 12");
    expect(listQuery({ ...DEFAULT_FILTERS, status: "nofollow", vendor: "V & Co", changed: "7" })).toBe("?status=nofollow&vendor=V+%26+Co&changed=7");
    expect(csvHref("p1", { ...DEFAULT_FILTERS, offset: 100 })).toBe("/api/projects/p1/backlinks?format=csv");
    const merged = live.mergeFeed([{ checkId: "a", checkedAt: "2026-10-04T10:00:00Z" }], [{ checkId: "b", checkedAt: "2026-10-04T10:00:02Z" }, { checkId: "a", checkedAt: "2026-10-04T10:00:00Z" }]);
    expect(merged.map((m) => m.checkId)).toEqual(["b", "a"]);
  });
});

describe("wiring", () => {
  it("routes, Backlinks (SEO group) and Live Backlinks nav entries with the job dot", () => {
    const appSrc = readFileSync(new URL("../src/web/App.tsx", import.meta.url), "utf8");
    expect(appSrc).toContain('path: "backlinks"');
    expect(appSrc).toContain('path: "live/backlinks"');
    const layout = readFileSync(new URL("../src/web/layouts/ProjectLayout.tsx", import.meta.url), "utf8");
    expect(layout).toContain('{ to: "live/backlinks", label: "Live Backlinks" }');
    expect(layout).toContain('{ to: "backlinks", label: "Backlinks" }');
    expect(layout).toContain("<BacklinkNavDot projectId={projectId} />");
    // Live Backlinks sits right after Live GEO; Backlinks inside the SEO group.
    expect(layout.indexOf('label: "Live GEO"')).toBeLessThan(layout.indexOf('label: "Live Backlinks"'));
    expect(layout.indexOf('group: "SEO"')).toBeLessThan(layout.indexOf('label: "Backlinks"'));
    expect(layout.indexOf('label: "Backlinks"')).toBeLessThan(layout.indexOf('group: "GEO"'));
  });

  it("Import: the Built Links tab suggests the backlinks destination and shows its mapping fields", () => {
    const s = suggestDestination("Built Links", BUILT_LINKS_HEADERS);
    const mapping = defaultMapping(s, "backlinks", BUILT_LINKS_HEADERS, "Built Links");
    const html = renderToStaticMarkup(h(importPage.MappingFields, { destination: "backlinks", mapping, headers: BUILT_LINKS_HEADERS, onChange: () => {} }));
    const t = text(html);
    expect(t).toMatch(/Live URL \(the article\)/);
    expect(t).toMatch(/Target 2/);
    expect(html).toContain('data-testid="backlinks-mapping"');
  });
});
