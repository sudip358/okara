/**
 * Live view: server-rendered markup of every panel from contract fixtures (no live calls, no DOM).
 * Checks honesty labels (replay label, Jev tier + raw Noul, measured GSC with window, Adapt, manual plan),
 * that forbidden video labels never render ("Simulated run", "Prompts / sec", "citability", "Steal",
 * "After", chance, x/10, projected traffic/revenue, "ChatGPT"), that untrusted text is plain text,
 * that "Reading…"-style pending states appear only for genuinely pending rows, and reduced-motion CSS.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { ActivityLane, GeoObservationDetail, PageSkipFactors } from "../src/shared/types";
import { buildTimeline, elementDisplay, initClock, queryGroups, type TimelineEvent } from "../src/web/pages/live/engine";
import { assessment, plan } from "./geo-batch-board-fixtures";
import { HOSTILE, activity, answer, at, coverageRow, element, evidenceRow, geoFeed, item, linkReport, overview, rec, run, seoFeed, step } from "./live-web-fixtures";

// Web .tsx modules load dynamically (test tsconfig has no JSX); Vitest transforms them at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FC = (props: any) => ReactElement | null;
const load = async <T,>(rel: string): Promise<T> => (await import(/* @vite-ignore */ rel)) as T;
const seoPanels = await load<Record<"PagesPanel" | "GscPanel" | "QueriesPanel", FC>>("../src/web/pages/live/seo/RunPanels.tsx");
const { ElementsPanel } = await load<Record<"ElementsPanel", FC>>("../src/web/pages/live/seo/ElementsPanel.tsx");
const { LinksPanel } = await load<Record<"LinksPanel", FC>>("../src/web/pages/live/seo/LinksPanel.tsx");
const proj = await load<Record<"CompetitorsPanel" | "CoveragePanel" | "AiAnswersPanel", FC>>("../src/web/pages/live/ProjectPanels.tsx");
const { RecsPanel } = await load<Record<"RecsPanel", FC>>("../src/web/pages/live/RecsPanel.tsx");
const { RunRail } = await load<Record<"RunRail", FC>>("../src/web/pages/live/RunRail.tsx");
const header = await load<Record<"LiveHeader" | "LivePill", FC>>("../src/web/pages/live/LiveHeader.tsx");
const { ReplayControls } = await load<Record<"ReplayControls", FC>>("../src/web/pages/live/ReplayControls.tsx");
const lane = await load<Record<"LaneColumn", FC>>("../src/web/pages/live/geo/LaneColumn.tsx");
const geoPanels = await load<Record<"HeatmapPanel" | "LatestAnswerPanel" | "CitedInsteadPanel", FC>>("../src/web/pages/live/geo/GeoPanels.tsx");
const { SeoBoard } = await load<Record<"SeoBoard", FC>>("../src/web/pages/live/SeoBoard.tsx");
const { GeoBoard } = await load<Record<"GeoBoard", FC>>("../src/web/pages/live/GeoBoard.tsx");
const { LivePage } = await load<Record<"LivePage", FC>>("../src/web/pages/live/LivePage.tsx");
const { LiveNavDot } = await load<Record<"LiveNavDot", FC>>("../src/web/pages/live/LiveNavDot.tsx");
const { ProjectProvider } = await load<Record<"ProjectProvider", FC>>("../src/web/lib/project-context.tsx");
const motion = await load<{ LIVE_CSS: string }>("../src/web/pages/live/motion.tsx");
const geoLib = await load<{ citedInsteadBars: (a: unknown[]) => unknown[]; answerIndex: (a: unknown[]) => Map<string, unknown>; heatCell: (...a: unknown[]) => unknown }>("../src/web/pages/live/engine.ts");

const render = (el: ReactElement) => renderToStaticMarkup(h(MemoryRouter, null, el));
const text = (html: string) =>
  html
    .replace(/<style>[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ");
const NONE: ReadonlySet<string> = new Set();
const st = <T,>(data: T | null, error: unknown = null) => ({ data, error, loading: data === null && !error, reload: () => {}, setData: () => {} });

/** Labels from the reference videos that must never render (honest replacements are used instead). */
const FORBIDDEN: Array<[RegExp, string]> = [
  [/Simulated run/, "Simulated run"],
  [/Prompts\s*\/\s*sec/i, "Prompts / sec"],
  [/citability/i, "citability"],
  [/\bsteal/i, "Steal"],
  [/\bAfter\b/, "After"],
  [/\bchance\b/i, "Chance"],
  [/\d\s*\/\s*10\b/, "x/10"],
  [/\bTraffic\b/, "Traffic"],
  [/\bRevenue\b/, "Revenue"],
  [/Conv\. rate/, "Conv. rate"],
  [/ChatGPT/, "ChatGPT"],
  [/\bConfidence\b/, "Confidence"],
  [/creating page/i, "creating page"],
  [/Prompts per second/i, "prompts per second"],
];
function expectHonest(html: string) {
  const t = text(html);
  for (const [re, name] of FORBIDDEN) expect(re.test(t), `forbidden label "${name}" rendered`).toBe(false);
  // Untrusted text is plain text: no live markup from fixtures.
  expect(html).not.toContain("<script>");
  expect(html).not.toMatch(/<img[^>]*onerror/);
  // No event-handler attribute (React always quotes real attributes; escaped text inside a title is inert).
  expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+="/i);
}

describe("SEO panels", () => {
  const feed = seoFeed();
  it("01 Pages being read: counter of the page limit, now-reading card with caption, ticker, skipped reasons", () => {
    const a = activity();
    const html = render(
      h(seoPanels.PagesPanel, {
        reads: a.items.filter((i) => i.kind === "page_read").reverse(),
        pagesRead: 38,
        pagesPlanned: 50,
        nowReading: { url: "https://shop.example/products/oak-table", at: at(5) },
        crawl: "running",
        crawlMessage: null,
        skipped: [{ reason: "robots_disallowed", count: 1 }],
        finished: false,
        fresh: new Set(["snap:2"]),
        reduced: false,
        projectId: "p1",
        verified: true,
      }),
    );
    const t = text(html);
    expect(t).toContain("01 Pages being read");
    expect(t).toContain("38 / 50 pages");
    expect(t).toContain("Now reading · shop.example");
    expect(t).toContain("may trail the crawler by up to 10 pages");
    expect(t).toContain("1 skipped: 1 robots_disallowed");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain("lv-stripes-run");
    expect(html).toContain("lv-row-in");
    expectHonest(html);
  });
  it("01 says the run did not crawl only once it is over", () => {
    const base = { reads: [], pagesRead: 0, pagesPlanned: null, nowReading: null, crawl: "not_started", crawlMessage: null, skipped: [], fresh: NONE, reduced: false, projectId: "p1", verified: true };
    expect(text(render(h(seoPanels.PagesPanel, { ...base, finished: true })))).toContain("This run did not crawl.");
    expect(text(render(h(seoPanels.PagesPanel, { ...base, finished: false })))).toContain("Waiting for the crawl step to start.");
  });
  it("02 Search Console: source, rows of cap, windows, measured totals with difference; not connected shows no zeros", () => {
    const html = render(h(seoPanels.GscPanel, { overview: overview(), overviewError: null, sync: feed.gscSync, step: "completed", stepMessage: null, reduced: false, projectId: "p1", replaying: false }));
    const t = text(html);
    expect(t).toContain("02 Search Console");
    expect(t).toContain("Search Console API");
    expect(t).toContain("Rows 4,812 of 25,000");
    expect(t).toContain("1–28 Sep vs 4–31 Aug");
    expect(t).toContain("12,480");
    expect(t).toContain("(+1,480 vs previous)");
    expect(t).toContain("Clicks per day");
    expectHonest(html);
    const nc = text(render(h(seoPanels.GscPanel, { overview: { ...overview(), state: "setup_required" }, overviewError: null, sync: null, step: "skipped", stepMessage: "Search Console not connected", reduced: false, projectId: "p1", replaying: false })));
    expect(nc).toContain("Search Console not connected");
    expect(nc).not.toContain("12,480");
  });
  it("03 Queries: relevance band and Jev chips (Noul tier + value, Choice with conf), no volume", () => {
    const html = render(h(seoPanels.QueriesPanel, { groups: queryGroups(feed.queries), relevant: 214, distinct: 260, buyer: [], fresh: NONE, reduced: false, finished: true }));
    const t = text(html);
    expect(t).toContain("03 Queries classified by Jev");
    expect(t).toContain("214 relevant");
    expect(t).toContain("of 260 queries classified");
    expect(t).toContain("Relevant");
    expect(t).toContain("Not relevant");
    expect(t).toContain("Jev act · 0.92");
    expect(t).toContain("transactional Jev act · conf 0.88");
    expect(t).toContain("clicks · impr. · pos., GSC 1–28 Sep");
    expect(t).toContain("40 · 1,200 · 7.1");
    expect(t).not.toMatch(/volume\b(?!.*no source)/i);
    expect(html).toContain("&lt;script&gt;");
    expect(t).not.toContain("Reading…");
    expectHonest(html);
  });
  it("04 Elements: counter, now → proposed, ≈ position, measured clicks with window, Jev chips, verdict chips, Next note", () => {
    const html = render(h(ElementsPanel, { rows: elementDisplay(feed.elements), change: 1284, judged: 3910, skeletons: 0, fresh: new Set(["dec:4"]), reduced: false, projectId: "p1", runId: "run1", notReplayed: 0, jevMissing: false }));
    const t = text(html);
    expect(t).toContain("04 Every SEO element, judged one by one");
    expect(t).toContain("1,284 to change");
    expect(t).toContain("of 3,910 judged in this run");
    expect(t).toContain("code turns the stored answer into keep, change or review");
    expect(t).toContain("Oak Table | Shop");
    expect(t).toContain("Solid Oak Dining Table, 6 Seats");
    expect(t).toContain("≈ 11.2");
    expect(t).toContain("Search Console 1–28 Sep · ≈ = page aggregate");
    expect(html).toContain("Clicks (GSC, 1–28 Sep); measured, not projected");
    expect(t).toContain("310");
    expect(t).not.toContain("+310");
    expect(t).toContain("Jev act · 0.08");
    expect(t).toContain("Jev flag · 0.55");
    expect(t).toContain("unsure");
    expect(t).toContain("Rule · fact");
    expect(t).toContain("Next: Title + meta");
    for (const v of ["Change", "Keep", "Review"]) expect(t).toContain(v);
    expect(t).not.toContain("Reading…");
    expect(html).toContain("shadow-[inset_2px_0_0_var(--color-rose-600)]");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('href="/projects/p1/recommendations/rec1"');
    expectHonest(html);
  });
  it("04 shows Reading… only on replay rows whose time is not reached (blurred, aria-hidden values) and live skeletons", () => {
    const pending = elementDisplay(feed.elements.slice(0, 1), [element({ id: "dec:20", at: at(500), element: "Schema", now: "Product, Offer" })]);
    const html = render(h(ElementsPanel, { rows: pending, change: 1, judged: 1, skeletons: 0, fresh: NONE, reduced: false, projectId: "p1", runId: "run1", notReplayed: 0, jevMissing: false }));
    expect((html.match(/Reading…/g) ?? []).length).toBe(1);
    expect(html).toContain('data-pending="true"');
    expect(html).toContain("lv-blur");
    const sk = text(render(h(ElementsPanel, { rows: [], change: 0, judged: 0, skeletons: 3, fresh: NONE, reduced: false, projectId: "p1", runId: "run1", notReplayed: 0, jevMissing: false })));
    expect((sk.match(/Waiting for the next stored judgment/g) ?? []).length).toBe(3);
  });
  it("04 replay rows later in the run, before their step starts, are a static 'Up next' (no shimmer, values blurred)", () => {
    const pending = elementDisplay([], [element({ id: "dec:21", at: at(600), element: "Schema", now: "Product, Offer" })]);
    const html = render(h(ElementsPanel, { rows: pending, change: 0, judged: 0, skeletons: 0, fresh: NONE, reduced: false, projectId: "p1", runId: "run1", notReplayed: 0, jevMissing: false, pendingLabel: "Up next" }));
    expect(text(html)).toContain("Up next");
    expect(html).not.toContain("Reading…");
    expect(html).not.toContain("lv-shimmer");
    expect(html).toContain('data-pending="true"');
    expect(html).toContain("lv-blur");
  });
  it("05 Competitors: Adapt (never steal), host not brand, block bars from stored statuses, cited in N stored answers, Assessing… only while queued", () => {
    const list = [assessment(), assessment({ id: "ca2", url: "https://q.example/x", host: "q.example", state: "queued", verdict: null, checks: [] })];
    const html = render(h(proj.CompetitorsPanel, { state: st(list), reduced: false, projectId: "p1", captions: ["From your latest GEO data, not part of this run"] }));
    const t = text(html);
    expect(t).toContain("05 Competitor pages worth adapting");
    expect(t).toContain("1 to adapt");
    expect(t).toContain("we adapt structure, never copy text");
    expect(t).toContain("other.example");
    expect(t).toContain("1 stored answer");
    expect(t).toContain("Adapt");
    expect((t.match(/Assessing…/g) ?? []).length).toBe(1);
    expect(html).toContain('aria-label="Answer: present"');
    expect(t).toContain("not part of this run");
    expectHonest(html);
    expect(text(render(h(proj.CompetitorsPanel, { state: st([]), reduced: false, projectId: "p1", captions: [] })))).toContain("No approved competitor pages yet.");
  });
  it("06 Coverage: no-page ratio, engines asked (not question volume), overlap with method, verdicts from the gap", () => {
    const rows = [coverageRow(), coverageRow({ promptId: "p2", text: HOSTILE, matchedPage: null, gap: "create_page", aiSource: "not_run", topOtherSource: null }), coverageRow({ promptId: "p3", text: "sofa", gap: "covered", aiSource: "your_site", topOtherSource: null })];
    const html = render(h(proj.CoveragePanel, { state: st({ rows }), reduced: false, projectId: "p1", ownHost: "shop.example", captions: [] }));
    const t = text(html);
    expect(t).toContain("06 Do our pages answer what people ask AI?");
    expect(t).toContain("33%");
    expect(t).toContain("1 of 3 approved prompts");
    expect(t).toContain("0.46 overlap, engine search query");
    expect(t).toContain("Eng.");
    expect(html).toContain('title="Engines asked: engines that answered this prompt (no question-volume source exists)"');
    expect(t).toContain("Page not cited");
    expect(t).toContain("No page");
    expect(t).toContain("Cited");
    expect(t).toContain("Not asked");
    expect(t).toContain("Consider a new page");
    expect(t).toContain("Approved prompt");
    expect(t).not.toMatch(/Asked \d/);
    expect(t).not.toContain("Asking…");
    expectHonest(html);
    // GEO live: a queued prompt shows Asking…; an answer of this run updates AI cites at once.
    const live = text(render(h(proj.CoveragePanel, { state: st({ rows }), reduced: false, projectId: "p1", ownHost: "shop.example", captions: [], askingPrompts: new Set(["p3"]), answersByPrompt: new Map([["p1", answer({ outcome: "cited", citedInstead: null, ownCitedUrl: "https://shop.example/sofas" })]]) })));
    expect(live).toContain("Asking…");
  });
  it("07 AI answers: cited-our-site ratio, measured factor dots, first missing factor; no chance / now / after", () => {
    const sf: PageSkipFactors = {
      state: "ready",
      page: { pageId: "pg2", url: "https://shop.example/sofas", snapshotAt: at(0), wordCount: 900 },
      promptId: null,
      promptText: null,
      engine: null,
      citedInsteadHost: null,
      competitorAssessmentId: null,
      factors: [
        { key: "answer_first", label: "Answer first", status: "missing", measured: "answer at word 180", value: 180, method: "heuristic", citedPage: null },
        { key: "entity_facts", label: "Entity facts", status: "present", measured: "12 numeric facts", value: 12, method: "measured", citedPage: null },
      ],
      basis: "page",
      labels: [],
    };
    const html = render(h(proj.AiAnswersPanel, { evidence: st({ rows: [evidenceRow()] }), coverage: [coverageRow(), coverageRow({ promptId: "p3", aiSource: "your_site", gap: "covered" })], skipFor: (id: string) => (id === "pg2" ? sf : undefined), reduced: false, captions: [] }));
    const t = text(html);
    expect(t).toContain("07 How our pages show up in AI answers");
    expect(t).toContain("50%");
    expect(t).toContain("1 of 2 answered prompts");
    expect(t).toContain("latest stored answer per prompt");
    expect(t).toContain("Cited in 4 answers");
    expect(t).toContain("Cited in 0 answers");
    expect(t).toContain("First missing: Answer first");
    expect(html).toContain('aria-label="Answer first: missing"');
    expect(html).toContain('aria-label="Entity facts: present"');
    expectHonest(html);
  });
  it("08 Links: suggested counter, anchor as <mark> around plain text, should-exist Noul, +1 judged bucket", () => {
    const row = element({ id: "dec:l1", element: "Links", questionId: "links.should_exist", linkSuggestionId: "ls1", jev: { questionId: "links.should_exist", tier: "act", noul: 0.91, choice: null, confidence: null, provider: "typesafe", model: "m" } });
    const html = render(h(LinksPanel, { report: { data: linkReport(), error: null }, runRows: [row], reduced: false, projectId: "p1", replaying: false }));
    const t = text(html);
    expect(t).toContain("08 Internal links judged");
    expect(t).toContain("1 suggested");
    expect(t).toContain("1 orphan pages");
    expect(html).toContain("Oil the oak</mark>");
    expect(html).toContain("&lt;script&gt;");
    expect(t).toContain("Jev act · should-exist 0.91");
    expect(t).toContain("Deeper detail");
    expect(t).toContain("+1 judged in this run");
    expectHonest(html);
    const idle = text(render(h(LinksPanel, { report: { data: linkReport(), error: null }, runRows: [], reduced: false, projectId: "p1", replaying: false })));
    expect(idle).toContain("Report generated 27 Sep · current state · not part of this run");
    // The report is current state: the caption says so whenever it shows, and "not replayed" in a replay.
    expect(t).toContain("Report generated 27 Sep · current state");
    expect(t).toContain("1 link judgment in this run");
    const replay = text(render(h(LinksPanel, { report: { data: linkReport(), error: null }, runRows: [row], reduced: false, projectId: "p1", replaying: true })));
    expect(replay).toContain("Report generated 27 Sep · current state · not replayed");
  });
  it("09 Recommendations: pipeline stations, rejected reasons, code priority with version, no publish", () => {
    const html = render(h(RecsPanel, { num: "09", title: "Recommendations drafted and checked", recs: [rec()], pipeline: feed.totals!.pipeline, fresh: NONE, reduced: false, projectId: "p1", finished: true }));
    const t = text(html);
    expect(t).toContain("09 Recommendations drafted and checked");
    for (const s of ["Candidates", "Judged by Jev", "Drafted", "Awaiting approval", "Implemented"]) expect(t).toContain(s);
    expect(t).toContain("12 low fit");
    expect(t).toContain("Priority 0.62 (priority-v3)");
    expect(t).toContain("3 evidence items");
    expect(t).not.toMatch(/\bPublish\b/);
    expect(html).toContain("&lt;script&gt;");
    expectHonest(html);
  });
});

describe("run rail, header and replay controls", () => {
  it("rail: step chips, counters, step log with plain-text messages; p50 hidden under 5 latencies", () => {
    const a = activity();
    a.items.push(step("evt:9", 401, "seo.summary", "completed", HOSTILE));
    const html = render(h(RunRail, { agent: "seo", items: a.items, t0: Date.parse(at(0)), axisEnd: Date.parse(at(432)), playhead: Date.parse(at(200)), pages: { read: 38, planned: 50 }, decisions: a.totals!.decisions, providerCalls: 2, laneLabels: new Map() }));
    const t = text(html);
    for (const s of ["Validate", "Crawl", "Search Console sync", "Judge and draft"]) expect(t).toContain(s);
    expect(t).toContain("calls 2");
    expect(t).toContain("Jev act 23 · flag 4 · drop 2");
    expect(t).toContain("pages 38 / 50");
    expect(t).not.toContain("p50");
    expect(html).toContain('role="log"');
    expect(html).toContain('aria-live="off"');
    expect(html).toContain("&lt;script&gt;");
    expectHonest(html);
  });
  it("replay pill: exact label with date, real stored events and speed, plus run time and spend so far", () => {
    const html = render(h(header.LivePill, { mode: "replay", text: "Replay of the run on 29 Sep 2026, 14:02 · real stored events · 10× speed", sub: "Run time 03:12 of 07:12 · $0.03 spent so far (estimate)" }));
    const t = text(html);
    expect(t).toContain("Replay of the run on 29 Sep 2026, 14:02 · real stored events · 10× speed");
    expect(t).toContain("Run time 03:12 of 07:12");
    expectHonest(html);
  });
  it("header: h1, domain, letter badges (no logos), SEO|GEO toggle, full-screen button, honesty strip", () => {
    const html = render(
      h(header.LiveHeader, {
        agent: "geo",
        domain: "shop.example",
        engines: [{ provider: "openai_geo", label: "OpenAI Responses API · web_search" }, { provider: "gemini", label: "Gemini API · google_search" }],
        pill: h(header.LivePill, { mode: "live", text: "Live run · 06:42 elapsed · $0.07 spent (estimate)" }),
        toggle: { seo: true, geo: true, onSelect: () => {} },
        fullscreen: false,
        onFullscreen: () => {},
        labels: ["API-sampled answers; not consumer-app answers"],
        replaying: false,
      }),
    );
    const t = text(html);
    expect(html).toMatch(/<h1[^>]*>Live · GEO agent<\/h1>/);
    expect(t).toContain("shop.example");
    expect(t).toContain("Live run · 06:42 elapsed · $0.07 spent (estimate)");
    expect(t).toContain("Live from this run's stored rows · Jev judgments are stored answers · nothing is projected");
    // The server's API-sampled disclosure is shown; ours is added only when no such label came with the data.
    expect(t).toContain("API-sampled answers; not consumer-app answers");
    expect(t).not.toContain("consumer apps may answer differently");
    expect(html).toContain('title="OpenAI Responses API · web_search"');
    expect(html).not.toMatch(/<img/);
    expect(html).toContain('aria-pressed="true"');
    expect(t).toContain("Enter full screen");
    expect(html).toContain("lv-ping");
    expectHonest(html);
  });
  it("GEO header without server labels still carries the API-sampled disclosure", () => {
    const html = render(h(header.LiveHeader, { agent: "geo", domain: "shop.example", engines: [], pill: null, toggle: { seo: true, geo: true, onSelect: () => {} }, fullscreen: false, onFullscreen: () => {}, labels: [], replaying: true }));
    const t = text(html);
    expect(t).toContain("API-sampled answers; consumer apps may answer differently");
    expect(t).toContain("Replay of stored rows · Jev judgments are stored answers · nothing is projected");
  });
  it("replay controls: toolbar, play/pause, restart, end, aria-pressed speeds 1×/10×/30×, labelled scrubber, keyboard list", () => {
    const clock = initClock({ t0: Date.parse(at(0)), tEnd: Date.parse(at(432)) }, 10);
    const html = render(h(ReplayControls, { clock: { ...clock, p: Date.parse(at(192)) }, onToggle: () => {}, onRestart: () => {}, onEnd: () => {}, onSpeed: () => {}, onSeek: () => {} }));
    expect(html).toContain('role="toolbar"');
    expect(html).toContain('aria-label="Replay controls"');
    expect(html).toContain('aria-label="Pause replay"');
    expect(html).toContain('aria-label="Restart replay"');
    expect(html).toContain('aria-label="Skip to end"');
    expect(html).toMatch(/aria-pressed="true"[^>]*>10×/);
    expect(html).toContain('aria-valuetext="Run time 03:12 of 07:12"');
    expect(html).toContain('type="range"');
    expect(text(html)).toContain("Keyboard");
  });
});

describe("GEO engine column and panels", () => {
  const feed = geoFeed();
  const gem: ActivityLane = { provider: "gemini", label: "Gemini API · google_search", state: "asking", done: 41, planned: 60, lastLatencyMs: 377 };
  const props = {
    provider: "gemini",
    lane: gem,
    board: { provider: "gemini", label: "Gemini API · google_search", model: "gemini-test-model", groundingMode: "google_search", state: "ready", stateDetail: null },
    laneState: "asking",
    totals: feed.totals!.lanes[0],
    answered: 41,
    runModel: { model: "gemini-test-model", groundingMode: "google_search" },
    runActive: true,
    strip: feed.answers.filter((a) => a.provider === "gemini"),
    queued: { provider: "gemini", label: "Gemini", promptText: "sofa for small flat" },
    pending: null,
    skipped: { row: feed.answers[0], total: 9, withPage: 6 },
    skipFactors: undefined,
    assessments: [assessment()],
    assessment: assessment(),
    approval: null,
    plans: [plan()],
    plan: plan(),
    replaying: false,
    fresh: new Set(["obs:2"]),
    reduced: false,
    projectId: "p1",
    demo: false,
  };
  it("header and stats: real lane label, exact model, state, gauge n of m, honest stats; no prompts/sec or share", () => {
    const html = render(h(lane.LaneColumn, props));
    const t = text(html);
    expect(t).toContain("Gemini API · google_search");
    expect(t).toContain("gemini-test-model");
    expect(t).toContain("Asking");
    expect(t).toContain("Citation rate, this run");
    expect(t).toContain("23 of 98 answers");
    expect(t).toContain("Answered 41");
    expect(t).toContain("of 60 planned · 1 failed · last 377 ms");
    // Short engine name on top (full lane label as its title), the rest of the label on the model line.
    expect(html).toMatch(/<h3[^>]*title="Gemini API · google_search"[^>]*>Gemini API<\/h3>/);
    expect(t).not.toContain("latest configuration");
    expect(t).toContain("Citing us 23");
    expect(t).toContain("Naming us, not citing 10");
    expect(t).toContain("Skipping us 65");
    expect(t).toContain("reviews.example");
    expect(t).toContain("in 31 answers");
    expect(t).toContain("~$0.16 est.");
    expect(t).not.toMatch(/\bShare\b/);
    expect(html).toContain('role="img"');
    expectHonest(html);
  });
  it("A strip: cards with latency, outcome, plain-text prompt, #n in list only for real lists, sentiment + method, queued card", () => {
    const html = render(h(lane.LaneColumn, props));
    const t = text(html);
    expect(t).toContain("41 approved prompts answered by Gemini in this run · of 60 planned");
    expect(t).toContain("Live from stored answers");
    expect(t).toContain("377 ms");
    expect(t).toContain("Missing");
    expect(t).toContain("Cited");
    expect(t).toContain("#2 in list");
    expect(t).toContain("Neutral (deterministic+jev)");
    expect(t).toContain("Cited instead: reviews.example via review site");
    expect(t).toContain("Queued");
    expect(t).toContain("sofa for small flat");
    expect(html).toContain("lv-card-in");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toMatch(/aria-label="Gemini, Missing: &#x27;best washable sofa&#x27;, 377 ms, cited instead reviews.example"/);
    expect(t).not.toContain("Analysing…");
  });
  it("B/C/D: our best page (not 'now reading'), observed reasons, manual plan with measured GSC and AI citations", () => {
    const t = text(render(h(lane.LaneColumn, props)));
    expect(t).toContain("9 prompts Gemini answered without us");
    expect(t).toContain("6 with a matching page");
    expect(t).toContain("Our best page");
    expect(t).not.toContain("Now reading");
    expect(t).toContain("For “best washable sofa” Gemini cited reviews.example via review site");
    expect(t).toContain("See rewrite plan");
    expect(t).toContain("Draft check this page");
    expect(t).toContain("1 approved pages cited by Gemini");
    expect(t).toContain("What their page has (observed)");
    expect(t).toContain("Adapt");
    expect(t).toContain("1 rewrite plans for pages Gemini skips");
    expect(t).toContain("Manual plan · Publishing: manual (not connected)");
    expect(t).toContain("Clicks 12 · Impressions 1,268");
    expect(t).toContain("Cited in 3 stored answers");
    expectHonest(render(h(lane.LaneColumn, props)));
  });
  it("an unanalysed answer shows Analysing… only while the run is active; custom lanes show mention rate and no B/C/D", () => {
    const t = text(render(h(lane.LaneColumn, { ...props, strip: [answer({ outcome: null })], queued: null })));
    expect(t).toContain("Analysing…");
    // Finished run or replay: the analysis will never come, so a static "Not analysed" (no shimmer).
    const done = render(h(lane.LaneColumn, { ...props, runActive: false, laneState: "done", strip: [answer({ outcome: null })], queued: null }));
    expect(text(done)).toContain("Not analysed");
    expect(text(done)).not.toContain("Analysing…");
    expect(done).toMatch(/aria-label="Gemini, Not analysed: /);
    const noSources = { ...props.totals, provider: "custom_geo:abc" as const, grounded: 0 };
    const c = text(render(h(lane.LaneColumn, { ...props, provider: "custom_geo:abc", lane: { ...gem, provider: "custom_geo:abc" }, board: undefined, totals: noSources })));
    expect(c).toContain("Mention rate (no sources returned)");
    expect(c).toContain("Custom · citations count only when the provider returns sources");
    expect(c).toContain("no sources returned · mention rate only");
    expect(c).not.toContain("approved pages cited by");
    expect(c).not.toContain("no web search proof");
  });
  it("a custom lane whose run returned provider-reported sources is measured on citation rate with B/C/D", () => {
    const withSources = { ...props.totals, provider: "custom_geo:abc" as const, cited: 2, named: 1, missing: 3, grounded: 4 };
    const c = text(render(h(lane.LaneColumn, { ...props, provider: "custom_geo:abc", lane: { ...gem, provider: "custom_geo:abc" }, board: undefined, totals: withSources })));
    expect(c).toContain("Citation rate, this run (answers with sources)");
    expect(c).toContain("provider-reported sources in 4 of 6 answers");
    expect(c).toContain("2 of 4 answers");
    expect(c).not.toContain("Mention rate (no sources returned)");
    expect(c).toContain("approved pages cited by Custom engine");
    expect(c).toContain("rewrite plans for pages Custom engine skips");
  });
  it("01 heatmap: letters with colour, real table with caption, pending only for pending pairs, hatched not run", () => {
    const idx = geoLib.answerIndex(feed.answers);
    const none = new Set<string>();
    const cell = (pid: string, prov: string) => geoLib.heatCell(idx, none, none, pid, prov, { liveActive: false, laneBusy: false });
    const html = render(h(geoPanels.HeatmapPanel, { prompts: feed.plannedPrompts, lanes: [{ provider: "openai_geo", label: "OpenAI" }, { provider: "gemini", label: "Gemini" }], cell, reduced: false, fresh: NONE, captions: [] }));
    const t = text(html);
    expect(html).toContain("<caption");
    expect(t).toContain("Outcome per approved prompt and engine, this run");
    expect(html).toMatch(/>M<\/button>/);
    expect(html).toMatch(/>C<\/button>/);
    expect(html).toContain("lv-hatch");
    expect(html).not.toContain("lv-shimmer");
    expect(html).toContain('scope="row"');
    expect(html).toContain("&lt;script&gt;");
    expectHonest(html);
  });
  it("02 latest answer: plain-text answer with brand spans as <mark>, citations by position, search queries or not exposed", () => {
    const detail: GeoObservationDetail = {
      id: "o1",
      promptText: "best washable sofa",
      promptType: "discovery",
      provider: "gemini",
      model: "gemini-test-model",
      groundingMode: "google_search",
      measurementType: "api",
      importedSurface: null,
      status: "ok",
      grounded: true,
      rawAnswer: `Try Acme sofas. ${HOSTILE} Rival is fine.`,
      requestId: null,
      cost: { usd: 0.001, isEstimate: true },
      brands: [{ brandKey: "acme", isSelf: true, mentioned: true, cited: false, recommendationStatus: "recommended", listRank: null, sentiment: "positive", spans: [{ start: 4, end: 8, text: "Acme" }], method: "deterministic" }],
      citations: [
        { url: "https://reviews.example/a", host: "reviews.example", title: null, position: 2, brandKey: null, sourceType: "review_site" },
        { url: "https://shop.example/sofas", host: "shop.example", title: null, position: 1, brandKey: "acme", sourceType: "brand_page" },
      ],
      searchQueries: null,
      displacements: [],
      createdAt: at(20),
    };
    const html = render(h(geoPanels.LatestAnswerPanel, { answer: answer(), detail, error: null, reduced: false, ownHost: "shop.example" }));
    const t = text(html);
    expect(html).toMatch(/<mark[^>]*>Acme<\/mark>/);
    expect(html).toContain("&lt;script&gt;");
    expect(t.indexOf("shop.example Brand page")).toBeLessThan(t.indexOf("reviews.example Review site"));
    expect(t).toContain("Engine searches: Not exposed by this provider");
    expect(t).toContain("API-sampled answer");
    expectHonest(html);
  });
  it("03 cited instead: host bars with source type and lane badges", () => {
    const html = render(h(geoPanels.CitedInsteadPanel, { bars: geoLib.citedInsteadBars(feed.answers), reduced: false }));
    const t = text(html);
    expect(t).toContain("03 Cited instead, this run");
    expect(t).toContain("reviews.example Review site");
    expect(t).toContain("First non-own citation per answer that left us out (missing or named), this run.");
    expectHonest(html);
  });
});

describe("boards and page (composition)", () => {
  it("SEO board renders all nine stage panels from stored rows, with no forbidden labels", () => {
    const a = activity();
    const feed = seoFeed();
    const tl = buildTimeline(a.items, { elements: feed.elements, queries: feed.queries, recommendations: feed.recommendations });
    const html = render(
      h(SeoBoard, {
        projectId: "p1",
        runId: "run1",
        ownHost: "shop.example",
        verified: true,
        activity: a,
        revealed: tl,
        upcoming: [] as TimelineEvent[],
        replaying: false,
        atEnd: true,
        mode: "finished",
        fresh: NONE,
        reduced: false,
        seo: { ...feed, totals: feed.totals },
        feedError: null,
        data: {
          overview: st(overview()),
          buyer: st({ state: "ready", generatedAt: at(0), rows: [], completeness: null, labels: [] }),
          links: st(linkReport()),
          competitors: st([assessment()]),
          coverage: st({ state: "ready", generatedAt: at(0), rows: [coverageRow()], completeness: null, labels: [] }),
          evidence: st({ state: "ready", generatedAt: at(0), rows: [evidenceRow()], completeness: null, labels: [] }),
        },
      }),
    );
    const t = text(html);
    for (const n of ["01 Pages being read", "02 Search Console", "03 Queries classified by Jev", "04 Every SEO element, judged one by one", "05 Competitor pages worth adapting", "06 Do our pages answer what people ask AI?", "07 How our pages show up in AI answers", "08 Internal links judged", "09 Recommendations drafted and checked"])
      expect(t).toContain(n);
    expect(t).toContain("1,284 to change");
    expect(t).toContain("From your latest GEO data, not part of this run");
    expect(t).not.toContain("Reading…");
    expectHonest(html);
  });
  it("GEO board renders lanes in board order plus the five extra panels", () => {
    const feed = geoFeed();
    const a = activity({
      run: run({ agent: "geo" }),
      lanes: [
        { provider: "gemini", label: "Gemini API · google_search", state: "done", done: 2, planned: 3, lastLatencyMs: 377 },
        { provider: "openai_geo", label: "OpenAI Responses API · web_search", state: "done", done: 1, planned: 3, lastLatencyMs: 820 },
      ],
      items: [step("e1", 0, "geo.batch", "started"), item({ id: "obs:1", at: at(20), kind: "engine_answer", agent: "geo", provider: "gemini", costUsd: 0.0012, costIsEstimate: true, outcome: "missing" })],
    });
    const tl = buildTimeline(a.items, { answers: feed.answers, recommendations: [] });
    const html = render(
      h(GeoBoard, {
        projectId: "p1",
        ownHost: "shop.example",
        demo: false,
        activity: a,
        revealed: tl,
        upcoming: [],
        replaying: false,
        atEnd: true,
        mode: "finished",
        fresh: NONE,
        reduced: false,
        geo: { answers: feed.answers, plannedPrompts: feed.plannedPrompts, recommendations: [], totals: feed.totals, labels: feed.labels },
        feedError: null,
        data: {
          board: st({ state: "ready", promptSetVersion: 1, generatedAt: at(0), lanes: [{ provider: "openai_geo", label: "OpenAI Responses API · web_search", model: "gpt-test", groundingMode: "web_search", state: "ready" }, { provider: "gemini", label: "Gemini API · google_search", model: "gemini-test-model", groundingMode: "google_search", state: "ready" }], labels: [] }),
          competitors: st([assessment()]),
          plans: st({ state: "ready", generatedAt: at(0), plans: [plan()], labels: [] }),
          coverage: st({ state: "ready", generatedAt: at(0), rows: [coverageRow()], completeness: null, labels: [] }),
        },
      }),
    );
    const t = text(html);
    expect(t.indexOf("OpenAI Responses API · web_search")).toBeLessThan(t.indexOf("Gemini API · google_search"));
    for (const n of ["01 Prompt × engine", "02 Inside the latest answer", "03 Cited instead, this run", "04 Do our pages answer what people ask AI?", "05 Proposals drafted and checked"]) expect(t).toContain(n);
    // Each lane shows the model stored with THIS run's answers, not the board's latest configuration.
    expect(t).toContain("gpt-run-model");
    expect(t).not.toContain("gpt-test");
    expect(t).not.toContain("latest configuration");
    // A failed call is not an answer: Gemini's "Answered" is cited + named + missing + pending of its totals.
    expect(t).toContain("Answered 98 of 3 planned · 1 failed");
    expectHonest(html);
  });
  it("Live page renders its frame (h1, toggle) while looking for runs; the nav dot is silent without an active run", () => {
    const project = { id: "p1", workspaceId: "w1", name: "Shop", siteUrl: "https://shop.example", isDemo: false, verifiedAt: null, verifiedHost: null };
    const html = render(h(ProjectProvider, { value: { project, projectId: "p1", reload: () => {}, setProject: () => {} } }, h(LivePage)));
    const t = text(html);
    expect(t).toContain("Live · SEO agent");
    expect(t).toContain("Looking for runs…");
    expect(html).toContain('aria-live="polite"');
    expectHonest(html);
    expect(render(h(LiveNavDot, { projectId: "p1" }))).toBe("");
  });
});

describe("review fixes: nothing pending that is not pending, nothing shown before it existed", () => {
  const seo = seoFeed();
  const geo = geoFeed();
  const seoData = {
    overview: st(overview()),
    buyer: st({ state: "ready", generatedAt: at(0), rows: [], completeness: null, labels: [] }),
    links: st(linkReport()),
    competitors: st([assessment()]),
    coverage: st({ state: "ready", generatedAt: at(0), rows: [coverageRow()], completeness: null, labels: [] }),
    evidence: st({ state: "ready", generatedAt: at(0), rows: [evidenceRow()], completeness: null, labels: [] }),
  };
  const seoBoard = (over: Record<string, unknown>) =>
    text(
      render(
        h(SeoBoard, {
          projectId: "p1",
          runId: "run1",
          ownHost: "shop.example",
          verified: true,
          activity: activity(),
          revealed: buildTimeline(activity().items, { elements: seo.elements, queries: seo.queries, recommendations: seo.recommendations }),
          upcoming: [],
          replaying: false,
          atEnd: true,
          mode: "finished",
          fresh: NONE,
          reduced: false,
          seo,
          feedError: null,
          data: seoData,
          ...over,
        }),
      ),
    );

  it("07: pages whose factors are never requested show '—' with a caption, never a shimmer", () => {
    const html = render(
      h(proj.AiAnswersPanel, { evidence: st({ rows: [evidenceRow()] }), coverage: [coverageRow()], skipFor: () => "not_loaded", factorPages: 8, reduced: false, captions: [] }),
    );
    expect(html).not.toContain("lv-shimmer");
    expect(text(html)).toContain("Factors are loaded for the first 8 pages only.");
    expect(html).toContain('title="Factors are loaded for the first 8 pages only"');
    // A requested page still loading is genuinely pending.
    expect(render(h(proj.AiAnswersPanel, { evidence: st({ rows: [evidenceRow()] }), coverage: [], skipFor: () => undefined, reduced: false, captions: [] }))).toContain("lv-shimmer");
  });

  it("GEO: a stored answer without an outcome is 'not analysed' (static) once the run is over; failed pairs are not answered", () => {
    const answers = [answer({ outcome: null }), answer({ id: "obs:f", promptId: "p2", outcome: "failed", citedInstead: null })];
    const idx = geoLib.answerIndex(answers);
    const none = new Set<string>();
    const cell = (pid: string, prov: string) => geoLib.heatCell(idx, none, none, pid, prov, { liveActive: false, laneBusy: false });
    const html = render(h(geoPanels.HeatmapPanel, { prompts: geo.plannedPrompts, lanes: [{ provider: "gemini", label: "Gemini" }], cell, reduced: false, fresh: NONE, captions: [] }));
    const t = text(html);
    expect(html).not.toContain("lv-shimmer");
    expect(html).toMatch(/aria-label="Gemini, not analysed: /);
    expect(t).toContain("0 of 3 pairs answered");
    expect(html).toContain('aria-label="Gemini: no stored answer"');
    expect(html).not.toContain("not run");
  });

  it("GEO cards: 'Cited instead' only for answers that left us out; 'Also cited' next to our own citation", () => {
    const t = text(render(h(lane.LaneColumn, { ...geoLaneProps(), strip: [answer({ outcome: "cited", ownCitedUrl: "https://shop.example/x" })], queued: null })));
    expect(t).toContain("Also cited: reviews.example via review site");
    expect(t).not.toContain("Cited instead: reviews.example via review site");
  });

  it("GEO C and D are labelled current state during a replay; D labels a page-level plan", () => {
    const t = text(render(h(lane.LaneColumn, { ...geoLaneProps(), replaying: true, planFallback: true })));
    expect((t.match(/Current state, not replayed/g) ?? []).length).toBe(2);
    expect(t).toContain("Manual plan · Publishing: manual (not connected)");
    expect(t).toContain("Rewrite plan for this page (not engine-specific)");
    // A lane with no answer in the run falls back to the board's model, labelled as the latest configuration.
    expect(text(render(h(lane.LaneColumn, { ...geoLaneProps(), runModel: null })))).toContain("gemini-test-model (latest configuration)");
  });

  it("09: pipeline totals are withheld mid-replay and captioned as whole-run / current status otherwise", () => {
    const mid = text(render(h(RecsPanel, { num: "09", title: "Recommendations drafted and checked", recs: [], pipeline: null, replaying: true, fresh: NONE, reduced: false, projectId: "p1", finished: false })));
    expect(mid).toContain("Pipeline totals appear at the end of the replay.");
    expect(mid).not.toMatch(/Candidates \d/);
    const end = text(render(h(RecsPanel, { num: "09", title: "Recommendations drafted and checked", recs: [rec()], pipeline: seo.totals!.pipeline, fresh: NONE, reduced: false, projectId: "p1", finished: true })));
    expect(end).toContain("Whole run · approval and implemented are current status");
  });

  it("02: this run's sync row is not shown before the replay reaches the end of the sync step; live without a sync says 'earlier sync'", () => {
    const base = { overview: overview(), overviewError: null, stepMessage: null, reduced: false, projectId: "p1" };
    const mid = text(render(h(seoPanels.GscPanel, { ...base, sync: seo.gscSync, step: "running", replaying: true })));
    expect(mid).toContain("Sync running");
    for (const s of ["Search Console API", "Sync completed", "Rows 4,812"]) expect(mid).not.toContain(s);
    const before = text(render(h(seoPanels.GscPanel, { ...base, sync: { ...seo.gscSync!, status: "failed", error: "boom" }, step: "not_started", replaying: true })));
    expect(before).not.toContain("Sync failed");
    const after = text(render(h(seoPanels.GscPanel, { ...base, sync: seo.gscSync, step: "completed", replaying: true })));
    expect(after).toContain("Rows 4,812 of 25,000");
    const live = text(render(h(seoPanels.GscPanel, { ...base, sync: null, step: "running", replaying: false })));
    expect(live).toContain("From an earlier sync (29 Sep)");
  });

  it("04: the rule-only note says what is stored (never 'not configured'); query sums over query+page rows are lower bounds", () => {
    const t = text(render(h(ElementsPanel, { rows: elementDisplay(seo.elements.filter((e) => e.role === "rule")), change: 1, judged: 1, skeletons: 0, fresh: NONE, reduced: false, projectId: "p1", runId: "run1", notReplayed: 0, jevMissing: true })));
    expect(t).toContain("No Jev answers were stored in this run: rule findings only.");
    expect(t).not.toContain("not configured");
    const q = text(render(h(seoPanels.QueriesPanel, { groups: queryGroups([seo.queries[0]!].map((x) => ({ ...x, gsc: { ...x.gsc!, basis: "query_page_rows" as const } }))), relevant: 1, distinct: 1, buyer: [], fresh: NONE, reduced: false, finished: true })));
    expect(q).toContain("≥ 40 · ≥ 1,200 · ≈ 7.1");
  });

  it("SEO board: live mode never claims 'no Jev answers'; mid-replay hides drafts not yet stored and withholds pipeline totals", () => {
    const rulesOnly = { ...seo, elements: seo.elements.filter((e) => e.role === "rule") };
    const live = seoBoard({ mode: "live", seo: rulesOnly, revealed: buildTimeline(activity().items, { elements: rulesOnly.elements }) });
    expect(live).not.toContain("No Jev answers were stored");
    const finished = seoBoard({ seo: rulesOnly, revealed: buildTimeline(activity().items, { elements: rulesOnly.elements }) });
    expect(finished).toContain("No Jev answers were stored in this run: rule findings only.");
    // Replay before the recommendation row: no "now → proposed" arrow; after it, the draft shows.
    const noRec = seoBoard({ mode: "replay", replaying: true, atEnd: false, revealed: buildTimeline(activity().items, { elements: seo.elements, queries: seo.queries }) });
    expect(noRec).not.toContain("proposed: Solid Oak Dining Table");
    expect(noRec).toContain("Pipeline totals appear at the end of the replay.");
    const withRec = seoBoard({ mode: "replay", replaying: true, atEnd: false });
    expect(withRec).toContain("proposed: Solid Oak Dining Table");
  });

  it("GEO board: lane state at the end of a replay is the server's (never 'Asking'); answered prompts outside the plan keep their rows", () => {
    const a = activity({
      run: run({ agent: "geo" }),
      lanes: [{ provider: "gemini", label: "Gemini API · google_search", state: "done", done: 3, planned: 3, lastLatencyMs: 377 }],
      items: [step("e1", 0, "geo.batch", "started"), item({ id: "obs:1", at: at(20), kind: "engine_answer", agent: "geo", provider: "gemini", costUsd: 0.0012, costIsEstimate: true, outcome: "missing" })],
    });
    const answers = [...geo.answers.filter((x) => x.provider === "gemini"), answer({ id: "obs:9", observationId: "o9", at: at(40), promptId: "p9", promptText: "unplanned prompt answered in the run" })];
    const props = (over: Record<string, unknown>) => ({
      projectId: "p1",
      ownHost: "shop.example",
      demo: false,
      activity: a,
      revealed: buildTimeline(a.items, { answers }),
      upcoming: [],
      replaying: true,
      atEnd: true,
      mode: "replay",
      fresh: NONE,
      reduced: false,
      geo: { answers, plannedPrompts: geo.plannedPrompts, recommendations: [], totals: geo.totals, labels: [] },
      feedError: null,
      data: {
        board: st({ state: "ready", promptSetVersion: 1, generatedAt: at(0), lanes: [{ provider: "gemini", label: "Gemini API · google_search", model: "gemini-test-model", groundingMode: "google_search", state: "ready" }], labels: [] }),
        competitors: st([]),
        plans: st({ state: "ready", generatedAt: at(0), plans: [], labels: [] }),
        coverage: st({ state: "ready", generatedAt: at(0), rows: [], completeness: null, labels: [] }),
      },
      ...over,
    });
    const end = text(render(h(GeoBoard, props({}))));
    expect(end).toContain("· Done");
    expect(end).not.toContain("Asking");
    expect(end).toContain("unplanned prompt answered in the run");
    const mid = text(render(h(GeoBoard, props({ atEnd: false }))));
    expect(mid).toContain("Asking");
    expect(mid).toContain("Pipeline totals appear at the end of the replay.");
  });

  it("rail: a step without a terminal event after the run ended reads 'ended without a result' (no pulse); info notes are neutral", () => {
    const items = [step("s1", 0, "seo.recommend", "started"), step("s2", 5, "seo.recommend", "info", "Step seo.recommend already finished (completed) on an earlier attempt; not run again.")];
    const over = render(h(RunRail, { agent: "seo", items, t0: Date.parse(at(0)), axisEnd: Date.parse(at(60)), playhead: null, pages: null, decisions: { act: 0, flag: 0, drop: 0 }, providerCalls: 0, laneLabels: new Map(), runOver: true }));
    expect(text(over)).toContain("ended without a result");
    expect(over).not.toContain("lv-pulse");
    expect(over).toMatch(/text-zinc-400[^>]*>info</);
    const running = render(h(RunRail, { agent: "seo", items: items.slice(0, 1), t0: Date.parse(at(0)), axisEnd: Date.parse(at(60)), playhead: null, pages: null, decisions: { act: 0, flag: 0, drop: 0 }, providerCalls: 0, laneLabels: new Map(), runOver: false }));
    expect(running).toContain("lv-pulse");
  });

  it("header: honesty sentence and pinned chips on one line; other data notes behind a toggle; near-duplicate wordings dropped", () => {
    const labels = [
      "Demo data - simulated run",
      "API-sampled answers; consumer apps may answer differently.",
      "API-sampled answers; not consumer-app answers (another wording)",
      "Outcome per stored answer: cited = your site was cited.",
      "Our best page: a labelled heuristic.",
    ];
    const html = render(h(header.LiveHeader, { agent: "geo", domain: "shop.example", engines: [], pill: null, toggle: { seo: true, geo: true, onSelect: () => {} }, fullscreen: false, onFullscreen: () => {}, labels, replaying: false }));
    const t = text(html);
    expect(t).toContain("Demo data - simulated run");
    expect(t).toContain("API-sampled answers; consumer apps may answer differently.");
    expect(t).not.toContain("another wording");
    expect(t).toContain("2 data notes");
    expect(t).not.toContain("Outcome per stored answer");
    expect(html).toContain('aria-expanded="false"');
  });
});

function geoLaneProps() {
  const feed = geoFeed();
  return {
    provider: "gemini",
    lane: { provider: "gemini", label: "Gemini API · google_search", state: "done", done: 41, planned: 60, lastLatencyMs: 377 } as ActivityLane,
    board: { provider: "gemini", label: "Gemini API · google_search", model: "gemini-test-model", groundingMode: "google_search", state: "ready", stateDetail: null },
    laneState: "done",
    totals: feed.totals!.lanes[0],
    answered: 98,
    runModel: { model: "gemini-test-model", groundingMode: "google_search" },
    runActive: false,
    strip: feed.answers.filter((a) => a.provider === "gemini"),
    queued: null,
    pending: null,
    skipped: { row: feed.answers[0], total: 9, withPage: 6 },
    skipFactors: undefined,
    assessments: [assessment()],
    assessment: assessment(),
    approval: null,
    plans: [plan()],
    plan: plan(),
    replaying: false,
    fresh: NONE,
    reduced: false,
    projectId: "p1",
    demo: false,
  };
}

describe("source rules", () => {
  const dir = new URL("../src/web/pages/live/", import.meta.url).pathname;
  const files: Array<[string, string]> = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else files.push([p, readFileSync(p, "utf8")]);
    }
  };
  walk(dir);
  it("never renders HTML from strings and never uses vendor logos", () => {
    for (const [f, src] of files) {
      expect(src, f).not.toContain("dangerouslySetInnerHTML");
      expect(src, f).not.toMatch(/\.svg["']|logo\.png/);
    }
  });
  it("every live table is fixed-layout and full width (no horizontal page scroll at 390 px)", () => {
    for (const [f, src] of files) for (const m of src.matchAll(/<table className="([^"]*)"/g)) expect(m[1], f).toMatch(/w-full table-fixed/);
  });
  it("reduced motion: every keyframe animation sits inside a no-preference media query", () => {
    const css = motion.LIVE_CSS;
    const i = css.indexOf("@media (prefers-reduced-motion:no-preference){");
    expect(i).toBeGreaterThan(0);
    const before = css.slice(0, i);
    expect(before).not.toMatch(/animation:/);
    expect(css).toContain("@media (prefers-reduced-motion:reduce)");
  });
  it("route, nav entry and the Activity link are wired", () => {
    expect(readFileSync(new URL("../src/web/App.tsx", import.meta.url), "utf8")).toContain('{ path: "live", lazy: page(() => import("./pages/live/LivePage"), "LivePage") }');
    const layout = readFileSync(new URL("../src/web/layouts/ProjectLayout.tsx", import.meta.url), "utf8");
    expect(layout).toContain('{ to: "live", label: "Live" }');
    expect(layout).toContain("<LiveNavDot projectId={projectId} />");
    expect(readFileSync(new URL("../src/web/components/activity/ActivityView.tsx", import.meta.url), "utf8")).toContain("Open live view");
  });
});
