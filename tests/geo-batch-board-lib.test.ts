/** AI engines board: pure helpers (gauge math, radar points, formatting, status labels, filters). */
import { describe, expect, it } from "vitest";
import {
  FEED_STATUS,
  GAUGE,
  LABELS,
  approvalCandidates,
  assessmentsForEngine,
  checkResultText,
  checkStatus,
  citedInsteadLine,
  costDisplay,
  countsLine,
  engineName,
  feedItems,
  feedStatusLabel,
  firstOpenLane,
  formatDuration,
  formatLatency,
  gaugeAriaLabel,
  gaugeFraction,
  gaugePaths,
  gaugePoint,
  gaugeText,
  laneBodyMode,
  laneGridClass,
  latestGeoRun,
  noulLabel,
  planItemLabel,
  planProgress,
  plansForEngine,
  plansWithoutEngine,
  positionLabel,
  radarGeometry,
  runDurationMs,
  searchQueriesLine,
  skipCandidates,
  skipFactorsPath,
  sumLaneCost,
  urlKey,
} from "../src/web/pages/geo/board/lib";
import type { CompetitorCheck, RunSummary } from "../src/shared/types";
import { assessment, plan, readyLane, setupLane } from "./geo-batch-board-fixtures";

const ratio = (n: number, d: number) => ({ numerator: n, denominator: d, value: d > 0 ? n / d : null });

describe("gauge", () => {
  it("prints percent with numerator and denominator", () => {
    expect(gaugeText(ratio(109, 523))).toBe("20.8% · 109 of 523");
    expect(gaugeText(ratio(21, 100))).toBe("21% · 21 of 100");
    expect(gaugeText(ratio(292, 1386))).toMatch(/^21\.1% · 292 of 1.386$/);
  });
  it("is unavailable (not 0%) without valid answers", () => {
    expect(gaugeText(ratio(0, 0))).toBe("Unavailable (no valid answers)");
    expect(gaugeFraction(ratio(0, 0))).toBeNull();
    expect(gaugePaths(ratio(0, 0)).value).toBeNull();
    expect(gaugeAriaLabel(ratio(0, 0))).toMatch(/unavailable/i);
  });
  it("has a full aria label", () => {
    expect(gaugeAriaLabel(ratio(21, 100))).toBe("Citation rate 21%: 21 of 100 valid answers cited your site");
  });
  it("maps fraction to the semicircle", () => {
    expect(gaugePoint(0)).toEqual({ x: GAUGE.cx - GAUGE.r, y: GAUGE.cy });
    expect(gaugePoint(1)).toEqual({ x: GAUGE.cx + GAUGE.r, y: GAUGE.cy });
    expect(gaugePoint(0.5)).toEqual({ x: GAUGE.cx, y: GAUGE.cy - GAUGE.r });
    const g = gaugePaths(ratio(1, 2));
    expect(g.track).toBe("M 10 50 A 40 40 0 0 1 90 50");
    expect(g.value).toBe("M 10 50 A 40 40 0 0 1 50 10");
    expect(gaugePaths(ratio(0, 5)).value).toBeNull(); // 0% draws only the track
  });
  it("clamps out-of-range values", () => {
    expect(gaugeFraction({ numerator: 5, denominator: 4, value: 1.25 })).toBe(1);
    expect(gaugeFraction({ numerator: 0, denominator: 4, value: -0.1 })).toBe(0);
    expect(gaugeFraction({ numerator: 0, denominator: 4, value: Number.NaN })).toBeNull();
  });
});

describe("cost", () => {
  it("labels actual, estimate and unknown; never $0 for unknown", () => {
    expect(costDisplay({ value: 0.307, isEstimate: false })).toEqual({ value: "$0.31", basis: "Actual" });
    expect(costDisplay({ value: 0.307, isEstimate: true })).toEqual({ value: "~$0.31 est.", basis: "Estimate (versioned rates)" });
    expect(costDisplay({ value: null, isEstimate: false })).toEqual({ value: "Unknown", basis: "Unknown" });
  });
  it("sums only lanes that ran; unknown if any ran lane is unknown", () => {
    expect(sumLaneCost([setupLane(), readyLane({ costUsd: { value: 0.1, isEstimate: false } }), readyLane({ costUsd: { value: 0.2, isEstimate: true } })])).toEqual({ value: 0.3, isEstimate: true });
    expect(sumLaneCost([readyLane({ costUsd: { value: 0.1, isEstimate: false } }), readyLane({ costUsd: { value: null, isEstimate: false } })]).value).toBeNull();
    expect(sumLaneCost([setupLane()]).value).toBeNull();
  });
});

describe("runs and durations", () => {
  const run = (id: string, agent: "seo" | "geo", createdAt: string, startedAt: string | null, finishedAt: string | null): RunSummary => ({
    id, agent, trigger: "manual", status: "completed", createdAt, startedAt, finishedAt, error: null, summary: {},
  });
  it("picks the newest geo run", () => {
    const r = latestGeoRun([
      run("a", "geo", "2026-09-29T00:00:00Z", null, null),
      run("b", "seo", "2026-09-30T05:00:00Z", null, null),
      run("c", "geo", "2026-09-30T00:00:00Z", "2026-09-30T00:00:01Z", "2026-09-30T00:00:19Z"),
    ]);
    expect(r?.id).toBe("c");
    expect(runDurationMs(r)).toBe(18_000);
    expect(latestGeoRun([])).toBeNull();
    expect(runDurationMs(run("x", "geo", "2026-09-30T00:00:00Z", "2026-09-30T00:00:00Z", null))).toBeNull();
  });
  it("formats durations and latency", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(850)).toBe("850 ms");
    expect(formatDuration(18_000)).toBe("18 s");
    expect(formatDuration(125_000)).toBe("2 min 5 s");
    expect(formatDuration(120_000)).toBe("2 min");
    expect(formatDuration(3_780_000)).toBe("1 h 3 min");
    expect(formatLatency(377)).toBe("377 ms");
    expect(formatLatency(1250)).toBe("1.3 s");
    expect(formatLatency(2000)).toBe("2 s");
    expect(formatLatency(null)).toBeNull();
  });
});

describe("feed and lane labels", () => {
  it("status labels", () => {
    expect(feedStatusLabel("missing")).toBe("Missing");
    expect(feedStatusLabel("named")).toBe("Named");
    expect(feedStatusLabel("cited")).toBe("Cited");
    expect(feedStatusLabel("not_run")).toBe("Not run");
    expect(FEED_STATUS.missing.tone).toBe("danger");
    expect(FEED_STATUS.cited.tone).toBe("success");
  });
  it("position only for a real list rank", () => {
    expect(positionLabel(2)).toBe("#2 in list");
    expect(positionLabel(null)).toBeNull();
    expect(positionLabel(0)).toBeNull();
  });
  it("caps the feed at 50", () => {
    const item = readyLane().feed[0]!;
    expect(feedItems(Array.from({ length: 80 }, (_, i) => ({ ...item, promptId: `p${i}` }))).length).toBe(50);
  });
  it("counts, search queries, cited instead", () => {
    expect(countsLine({ valid: 1386, grounded: 1301, failed: 4, incomplete: 0 })).toMatch(/^1.386 valid · 1.301 grounded · 4 failed$/);
    expect(countsLine({ valid: 1, grounded: 1, failed: 0, incomplete: 2 })).toContain("2 incomplete");
    expect(searchQueriesLine({ state: "captured", count: 38 })).toBe("38 engine searches captured");
    expect(searchQueriesLine({ state: "captured", count: 1 })).toBe("1 engine search captured");
    expect(searchQueriesLine({ state: "not_exposed", count: 0 })).toBe("Search queries not exposed");
    expect(citedInsteadLine(null)).toBe("No other source dominates");
    expect(citedInsteadLine(readyLane().citedInstead)).toBe("rival.example · 21.1% (80 of 380 skipping answers)");
  });
  it("engine names are API names, never consumer apps", () => {
    expect(engineName("openai_geo")).toBe("OpenAI");
    expect(engineName("anthropic_geo")).toBe("Anthropic");
    expect(engineName("gemini")).toBe("Gemini");
    expect(engineName("unknown_x")).toBe("unknown_x");
    for (const p of ["openai_geo", "anthropic_geo", "gemini", "perplexity"]) expect(engineName(p)).not.toMatch(/chatgpt|claude/i);
  });
  it("lane body mode and first open lane", () => {
    expect(laneBodyMode(setupLane())).toBe("setup");
    expect(laneBodyMode(readyLane({ state: "disabled" }))).toBe("disabled");
    expect(laneBodyMode(readyLane({ state: "error" }))).toBe("error");
    expect(laneBodyMode(readyLane({ promptsRun: 0 }))).toBe("no_answers");
    expect(laneBodyMode(readyLane({ state: "demo" }))).toBe("ready");
    expect(firstOpenLane([setupLane(), readyLane({ provider: "perplexity" })])).toBe("perplexity");
    expect(firstOpenLane([setupLane("anthropic_geo")])).toBe("anthropic_geo");
    expect(firstOpenLane([])).toBeNull();
  });
  it("grid: 1 col mobile, 2 tablet, up to 4 desktop", () => {
    expect(laneGridClass(4)).toBe("grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4");
    expect(laneGridClass(3)).toContain("xl:grid-cols-3");
    expect(laneGridClass(1)).not.toContain("md:grid-cols-2");
  });
});

describe("checks and radar", () => {
  const c = (over: Partial<CompetitorCheck>): CompetitorCheck => ({ key: "answer_first", label: "Answer", noul: null, tier: null, method: "measured", detail: null, ...over });
  it("derives status from explicit status, else Jev tier/noul", () => {
    expect(checkStatus(c({ status: "partial" }))).toBe("partial");
    expect(checkStatus(c({ method: "jev", noul: 0.9, tier: "act" }))).toBe("present");
    expect(checkStatus(c({ method: "jev", noul: 0.1, tier: "act" }))).toBe("missing");
    expect(checkStatus(c({ method: "jev", noul: 0.6, tier: "flag" }))).toBe("unknown");
    expect(checkStatus(c({ method: "jev", noul: null, tier: null }))).toBe("unknown");
    expect(checkStatus(c({}))).toBe("unknown");
  });
  it("Noul is shown as a yes-probability (no confidence)", () => {
    expect(noulLabel(0.823)).toBe("yes-probability 0.82");
    expect(noulLabel(null)).toBeNull();
    expect(checkResultText(c({ method: "jev", noul: null }))).toBe("Not run (Jev not configured)");
    expect(checkResultText(c({ detail: "1,709 words" }))).toBe("1,709 words");
  });
  it("plots present at the outer ring, partial mid, missing centre, unknown no point", () => {
    const g = radarGeometry(assessment().checks, { cx: 60, cy: 60, r: 40 });
    const by = Object.fromEntries(g.axes.map((a) => [a.key, a]));
    expect(g.axes.map((a) => a.label)).toEqual(["Answer", "FAQ", "Author", "Fresh", "Sources", "Entity"]);
    expect(by.answer_first!.point).toEqual({ x: 60, y: 20 }); // present, 12 o'clock
    expect(by.answer_first!.end).toEqual({ x: 60, y: 20 });
    expect(by.author!.point).toEqual({ x: 60, y: 60 }); // missing → centre
    const faq = by.faq!.point!; // partial → half radius
    expect(Math.hypot(faq.x - 60, faq.y - 60)).toBeCloseTo(20, 1);
    expect(by.entity!.point).toBeNull(); // flag → unknown → no point
    expect(g.polygon!.split(" ").length).toBe(5);
    expect(g.rings).toHaveLength(2);
  });
  it("no polygon with fewer than 3 known points", () => {
    expect(radarGeometry([c({ status: "present" })]).polygon).toBeNull();
  });
});

describe("filters and candidates", () => {
  it("assessments and plans by engine", () => {
    expect(assessmentsForEngine([assessment()], "gemini")).toHaveLength(1);
    expect(assessmentsForEngine([assessment()], "perplexity")).toHaveLength(0);
    const plans = [plan(), plan({ engine: "perplexity", pageId: "pg2" }), plan({ engine: null, pageId: "pg3" })];
    expect(plansForEngine(plans, "gemini").map((p) => p.pageId)).toEqual(["pg1"]);
    expect(plansWithoutEngine(plans).map((p) => p.pageId)).toEqual(["pg3"]);
  });
  it("approval candidates: https cited URLs not yet assessed, de-duplicated", () => {
    const lane = readyLane();
    const base = lane.feed[0]!;
    const feed = [
      base,
      { ...base, promptId: "x1", citedInstead: { ...base.citedInstead!, url: "https://RIVAL.example/best-widgets" } },
      { ...base, promptId: "x2", citedInstead: { ...base.citedInstead!, url: "http://insecure.example/a" } },
      { ...base, promptId: "x3", citedInstead: { ...base.citedInstead!, url: "javascript:alert(1)" } },
      { ...base, promptId: "x4", citedInstead: { host: "other.example", url: "https://other.example/guide", sourceType: "publisher" as const } },
    ];
    const out = approvalCandidates(feed, [assessment()]);
    expect(out.map((o) => o.url)).toEqual(["https://rival.example/best-widgets/"]);
    expect(approvalCandidates(feed, [], 0)).toEqual([]);
  });
  it("urlKey normalises host case, hash and trailing slash only", () => {
    expect(urlKey("https://A.example/x/#h")).toBe("https://a.example/x");
    expect(urlKey("https://a.example/")).toBe("https://a.example/");
    expect(urlKey("https://a.example/x?q=1")).toBe("https://a.example/x?q=1");
    expect(urlKey(" not a url ")).toBe("not a url");
  });
  it("skip candidates map missing prompts to crawled pages", () => {
    const lane = readyLane();
    const out = skipCandidates(
      [...lane.feed, { ...lane.feed[0]!, promptId: "p9", promptText: "No match" }],
      [
        { promptId: "p1", matchedPage: { url: "https://shop.example/widgets" } },
        { promptId: "p2", matchedPage: { url: "https://shop.example/vs" } },
      ],
      [{ id: "pg1", url: "https://shop.example/widgets/" }],
    );
    expect(out).toEqual([
      { promptId: "p1", promptText: lane.feed[0]!.promptText, pageId: "pg1", pageUrl: "https://shop.example/widgets", citedInsteadHost: "rival.example" },
      { promptId: "p9", promptText: "No match", pageId: null, pageUrl: null, citedInsteadHost: "rival.example" },
    ]);
  });
  it("skip factors path encodes ids and query", () => {
    expect(skipFactorsPath("pr 1", { pageId: "a/b", promptId: "p&1" }, "gemini")).toBe("/projects/pr%201/geo/pages/a%2Fb/skip-factors?promptId=p%261&engine=gemini");
    expect(skipFactorsPath("p", { pageId: "x", promptId: null }, "perplexity")).toBe("/projects/p/geo/pages/x/skip-factors?engine=perplexity");
  });
});

describe("rewrite plans", () => {
  it("IndexNow always carries its scope", () => {
    const item = plan().items.find((i) => i.key === "indexnow")!;
    expect(planItemLabel(item)).toBe(LABELS.indexnow);
    expect(LABELS.indexnow).toContain("not Google");
    expect(planItemLabel({ ...plan().items[1]!, optional: true })).toBe("FAQ · optional");
  });
  it("progress counts applicable items", () => {
    expect(planProgress(plan().items)).toBe("1 of 4 done");
    expect(planProgress([{ ...plan().items[1]!, status: "not_applicable" }])).toBe("0 of 0 done");
  });
});
