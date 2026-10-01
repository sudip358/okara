/**
 * Live view engine (src/web/pages/live/engine.ts) and labels (text.ts): pure reducer over stored events.
 * Ordering and joining by id, reveal on stored time (replay) vs everything received (live), the replay clock
 * (speeds, pause, idle-gap shortening, end), counters and tweens between RECEIVED values only, spend so far,
 * lane totals, the prompt × engine cell rules, run selection, and the exact honesty wording.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SPEED,
  GAP_LEAD_WALL_MS,
  IDLE_GAP_MS,
  MAX_ANIMATED,
  MAX_PENDING,
  STRIP_MAX,
  advanceClock,
  animatedIds,
  answerIndex,
  arrivalSummary,
  citedInsteadBars,
  buildTimeline,
  callTicks,
  decisionCounts,
  elementCounts,
  elementDisplay,
  hasLongGaps,
  heatCell,
  initClock,
  itemsOf,
  laneRatio,
  laneStateAt,
  laneStrip,
  laneTotalsFrom,
  latestSkipped,
  medianLatency,
  mergeById,
  mergeGeoFeed,
  mergeKeepingSteps,
  mergeSeoFeed,
  parseSpeed,
  parseStep,
  pauseClock,
  pickLiveRun,
  queryCounts,
  queryGroups,
  replayBounds,
  restartClock,
  retarget,
  revealCount,
  seekClock,
  setClockSpeed,
  skipToEnd,
  skippedReasons,
  spendSeries,
  spendSoFar,
  splitAt,
  staggerDelay,
  stepSegments,
  stepStatus,
  togglePlay,
  tweenValue,
  type TimelineEvent,
} from "../src/web/pages/live/engine";
import { clicksText, clockText, dedupeLabels, jevChipText, pillText, positionText, replayLabel, spendPhrase, spendSoFarText, windowShort } from "../src/web/pages/live/text";
import { HOSTILE, activity, answer, at, call, element, geoFeed as geoFeedBase, item, query, read, rec, seoFeed, step } from "./live-web-fixtures";

const ms = (sec: number) => Date.parse(at(sec));

describe("timeline: union of stored rows, joined by id, ordered by (at, id)", () => {
  it("joins the jev_decision item and the element row with the same id; feed row wins for at; sorted", () => {
    const items = [item({ id: "dec:1", at: at(71), kind: "jev_decision", title: "Jev act: cand", outcome: "act" }), read("snap:1", 5, "https://shop.example/a"), step("evt:1", 0, "seo.crawl", "started")];
    const tl = buildTimeline(items, { elements: [element({ id: "dec:1", at: at(70) })], recommendations: [rec()] });
    expect(tl.map((e) => e.id)).toEqual(["evt:1", "snap:1", "dec:1", "rec:rec1"]);
    const dec = tl.find((e) => e.id === "dec:1")!;
    expect(dec.item?.kind).toBe("jev_decision");
    expect(dec.element?.element).toBe("Title");
    expect(dec.at).toBe(at(70));
  });
  it("ties on time break by id; invalid timestamps sort first instead of NaN", () => {
    const tl = buildTimeline([item({ id: "b", at: at(1) }), item({ id: "a", at: at(1) }), item({ id: "z", at: "not a date" })]);
    expect(tl.map((e) => e.id)).toEqual(["z", "a", "b"]);
  });
  it("mergeById keeps the newer copy of a re-sent row (a held answer arriving with its outcome) and caps the oldest", () => {
    const merged = mergeById([answer({ outcome: null })], [answer({ outcome: "cited" }), answer({ id: "obs:2", at: at(1) })]);
    expect(merged.map((a) => a.id)).toEqual(["obs:2", "obs:1"]);
    expect(merged.find((a) => a.id === "obs:1")!.outcome).toBe("cited");
    expect(mergeById([answer({ id: "x1", at: at(1) }), answer({ id: "x2", at: at(2) })], [answer({ id: "x3", at: at(3) })], 2).map((a) => a.id)).toEqual(["x2", "x3"]);
  });
});

describe("reveal: live shows everything received; replay reveals at stored time", () => {
  const tl = buildTimeline(Array.from({ length: 20 }, (_, i) => item({ id: `evt:${String(i).padStart(2, "0")}`, at: at(i * 10) })));
  it("live (playhead null): all revealed, none pending", () => {
    const s = splitAt(tl, null);
    expect(s.revealed.length).toBe(20);
    expect(s.pending).toEqual([]);
  });
  it("replay: rows at or before the playhead are resolved; the next MAX_PENDING are pending, ascending", () => {
    const s = splitAt(tl, ms(45));
    expect(s.revealed.map((e) => e.id)).toEqual(["evt:00", "evt:01", "evt:02", "evt:03", "evt:04"]);
    expect(s.pending.length).toBe(MAX_PENDING);
    expect(s.pending[0]!.id).toBe("evt:05");
    expect(revealCount(tl, ms(50))).toBe(6); // a row resolves exactly when its time is reached
    expect(revealCount(tl, ms(50) - 1)).toBe(5);
  });
});

describe("replay clock", () => {
  const times = [0, 1, 2, 3, 60, 61].map(ms);
  const bounds = { t0: ms(0), tEnd: ms(70) };
  it("bounds: startedAt..finishedAt, never before the first or after the last event", () => {
    const b = replayBounds(activity().run, buildTimeline(activity().items));
    expect(b).toEqual({ t0: ms(0), tEnd: ms(432) });
    expect(replayBounds({ startedAt: null, createdAt: at(5), finishedAt: null }, [{ t: ms(2) }, { t: ms(9) }])).toEqual({ t0: ms(2), tEnd: ms(9) });
  });
  it("advances by dt × speed (1×, 10×, 30×)", () => {
    for (const speed of [1, 10, 30] as const) {
      const c = advanceClock(initClock(bounds, speed), 100, times);
      expect(c.p - bounds.t0).toBe(100 * speed);
    }
    expect(initClock(bounds).speed).toBe(DEFAULT_SPEED);
  });
  it("pause stops the playhead; toggle resumes; speed change keeps position", () => {
    const c = pauseClock(advanceClock(initClock(bounds, 10), 100, times));
    expect(advanceClock(c, 5_000, times).p).toBe(c.p);
    const resumed = togglePlay(c);
    expect(resumed.playing).toBe(true);
    expect(setClockSpeed(resumed, 30).p).toBe(c.p);
  });
  it("shortens idle gaps over 10 s: jumps to 1 s before the next stored event at 1×", () => {
    let c = seekClock(initClock(bounds, 1), ms(3));
    c = advanceClock(c, 100, times);
    expect(c.p).toBe(ms(60) - 1000 + 100);
    expect(hasLongGaps(times, bounds.t0, bounds.tEnd)).toBe(true);
    expect(hasLongGaps([0, 5, 9].map(ms), ms(0), ms(9) + IDLE_GAP_MS - 1)).toBe(false);
  });
  it("after a shortened gap the next event is still ~0.45 s of wall time away at 10× and ~0.33 s at 30× (order unchanged)", () => {
    const c10 = advanceClock(seekClock(initClock(bounds, 10), ms(3)), 100, times);
    expect(c10.p).toBe(ms(60) - GAP_LEAD_WALL_MS * 10 + 100 * 10);
    // Wall time from landing to the event: lead / speed.
    expect((ms(60) - (c10.p - 1000)) / 10).toBe(GAP_LEAD_WALL_MS);
    const c30 = advanceClock(seekClock(initClock(bounds, 30), ms(3)), 100, times);
    expect(c30.p).toBe(ms(60) - (IDLE_GAP_MS - 1) + 100 * 30);
    expect(c30.p).toBeLessThan(ms(60)); // the event is not skipped past
    // A sparse run takes several ticks per row: rows 1 s apart still reveal on different frames at 10×.
    let c = seekClock(initClock(bounds, 10), ms(3));
    const seen: number[] = [];
    for (let i = 0; i < 40 && !c.finished; i++) {
      c = advanceClock(c, 100, times);
      seen.push(revealCount(times.map((t) => ({ t })), c.p));
    }
    expect(seen.indexOf(5)).toBeGreaterThan(seen.indexOf(4) + 2);
  });
  it("finishes at the end and stops; toggling a finished replay restarts it; seek clamps", () => {
    let c = advanceClock(seekClock(initClock(bounds, 30), ms(69)), 10_000, times);
    expect(c.finished).toBe(true);
    expect(c.playing).toBe(false);
    expect(c.p).toBe(bounds.tEnd);
    c = togglePlay(c);
    expect(c.p).toBe(bounds.t0);
    expect(c.playing && !c.finished).toBe(true);
    expect(seekClock(c, ms(-100)).p).toBe(bounds.t0);
    expect(seekClock(c, ms(10_000)).finished).toBe(true);
    expect(skipToEnd(c).p).toBe(bounds.tEnd);
    expect(restartClock(skipToEnd(c)).p).toBe(bounds.t0);
  });
  it("speed parsing falls back to the default for unknown values", () => {
    expect(parseSpeed("30")).toBe(30);
    expect(parseSpeed("5")).toBe(DEFAULT_SPEED);
    expect(parseSpeed(null)).toBe(DEFAULT_SPEED);
  });
});

describe("counters: tween only between received values", () => {
  it("eases from the old stored value to the new one and ends exactly on it", () => {
    const tw = retarget({ from: 10, to: 10, start: 0, duration: 0 }, 20, 1000);
    expect(tweenValue(tw, 1000)).toBe(10);
    const mid = tweenValue(tw, 1300);
    expect(mid).toBeGreaterThan(15);
    expect(mid).toBeLessThan(20);
    expect(tweenValue(tw, 1600)).toBe(20);
  });
  it("retargets mid-flight from the current value (one tween per counter); reduced motion is instant", () => {
    const a = retarget({ from: 0, to: 0, start: 0, duration: 0 }, 100, 0);
    const b = retarget(a, 50, 300);
    expect(b.from).toBeCloseTo(tweenValue(a, 300));
    expect(retarget(a, 70, 300, true)).toMatchObject({ from: 70, to: 70, duration: 0 });
  });
});

describe("SEO selectors", () => {
  const feed = seoFeed();
  it("element counts follow the server rule: action rows count only for candidates without an element row", () => {
    expect(elementCounts(feed.elements)).toEqual({ judged: 4, keep: 1, change: 2, review: 1 });
  });
  it("display: action row folds into a 'Next:' note; time order (oldest first); replay-pending rows sit under the resolved ones, flagged", () => {
    const rows = elementDisplay(feed.elements, [element({ id: "dec:9", at: at(200), element: "Schema" }), element({ id: "dec:8", at: at(150), element: "Meta" })]);
    expect(rows.map((r) => r.row.id)).toEqual(["find:1", "dec:1", "dec:2", "dec:4", "dec:8", "dec:9"]);
    expect(rows.slice(0, 4).every((r) => !r.pending)).toBe(true);
    expect(rows.slice(4).every((r) => r.pending)).toBe(true);
    expect(rows.find((r) => r.row.id === "dec:2")!.next).toBe("Next: Title + meta");
    expect(rows.some((r) => r.row.id === "dec:3")).toBe(false);
    // maxResolved keeps the NEWEST resolved rows.
    expect(elementDisplay(feed.elements, [], 2).map((r) => r.row.id)).toEqual(["dec:2", "dec:4"]);
  });
  it("queries group by key, cells fill as answers arrive; counts by band", () => {
    const g = queryGroups(feed.queries);
    expect(g.map((x) => x.queryKey)).toEqual(["q:oak table", "q:x"]);
    const oak = g.find((x) => x.queryKey === "q:oak table")!;
    expect(oak.relevance?.band).toBe("yes");
    expect(oak.intent?.jev.choice).toBe("transactional");
    expect(queryCounts(feed.queries)).toEqual({ distinct: 2, relevant: 1, notRelevant: 1, unsure: 0 });
    const withPending = queryGroups([query()], [query({ id: "dec:q7", queryKey: "q:new", query: "new" })]);
    expect(withPending.map((x) => [x.queryKey, x.pending])).toEqual([["q:oak table", false], ["q:new", true]]);
  });
  it("crawl skips are counted by stored reason", () => {
    expect(skippedReasons(activity().items)).toEqual([{ reason: "robots_disallowed", count: 1 }]);
  });
});

describe("run rail", () => {
  const items = activity().items;
  it("parses step items and builds segments with terminal status; running without an end", () => {
    expect(parseStep(items[0]!)).toEqual({ step: "seo.validate", status: "started" });
    const { steps } = stepSegments(items.slice(0, 9), "seo");
    expect(steps.map((s) => s.status)).toEqual(["completed", "completed", "completed", "running"]);
    expect(steps[3]!.end).toBeNull();
  });
  it("an info note after a step's terminal event never re-opens it (Workflows retry: 'already finished … not run again')", () => {
    const evs = [step("s1", 0, "seo.recommend", "started"), step("s2", 10, "seo.recommend", "completed"), step("s3", 20, "seo.recommend", "info", "Step seo.recommend already finished (completed) on an earlier attempt; not run again.")];
    expect(parseStep(evs[2]!)).toEqual({ step: "seo.recommend", status: "info" });
    expect(stepStatus(evs, "seo.recommend")).toBe("completed");
    const seg = stepSegments(evs, "seo").steps.find((x) => x.step === "seo.recommend")!;
    expect(seg).toMatchObject({ status: "completed", end: ms(10) });
    expect(seg.message).toContain("already finished");
    // Any unknown raw status is a note too, and a lane's per-answer analysis failure is not a lane end.
    expect(parseStep(step("s4", 1, "seo.crawl", "warming"))!.status).toBe("info");
    const lane = [step("l1", 0, "geo_batch:gemini", "started"), step("l2", 5, "geo_batch:gemini", "failed", "Analysis failed for observation obs_1: boom")];
    expect(stepStatus(lane, "geo_batch:gemini")).toBe("running");
    expect(laneStateAt(lane, "gemini", 1)).toBe("asking");
  });
  it("GEO lane sub-bars come from geo_batch:<engine> steps; lane state at the playhead", () => {
    const geoItems = [step("e1", 0, "geo.batch", "started"), step("e2", 1, "geo_batch:gemini", "started"), step("e3", 30, "geo_batch:gemini", "completed")];
    expect(stepSegments(geoItems, "geo").lanes.map((l) => [l.lane, l.status])).toEqual([["gemini", "completed"]]);
    expect(laneStateAt(geoItems.slice(0, 2), "gemini", 0)).toBe("asking");
    expect(laneStateAt(geoItems, "gemini", 3)).toBe("done");
    expect(laneStateAt(geoItems.slice(0, 1), "openai_geo", 0)).toBe("queued");
    // Without a lane step (legacy events), stored answers mean asking only until geo.batch ends.
    expect(laneStateAt(geoItems.slice(0, 1), "openai_geo", 2)).toBe("asking");
    expect(laneStateAt([...geoItems, step("e4", 40, "geo.batch", "partial")], "openai_geo", 2)).toBe("done");
    expect(laneStateAt([step("e5", 40, "geo.batch", "completed")], "openai_geo", 0)).toBe("idle");
  });
  it("p50 latency only from 5 stored latencies; spend line stops at the first unpriced call", () => {
    const ticks = callTicks([call("c1", 1, 0.01, 100), call("c2", 2, 0.02, 300), call("c3", 3, null, 200), call("c4", 4, 0.01, 500)]);
    expect(medianLatency(ticks)).toBeNull();
    expect(medianLatency(callTicks([1, 2, 3, 4, 5].map((i) => call(`c${i}`, i, 0.01, i * 100))))).toBe(300);
    const s = spendSeries(ticks);
    expect(s.points.map((p) => p.usd)).toEqual([0.01, 0.03]);
    expect(s.unpricedFrom).toBe(ms(3));
  });
  it("spend so far sums revealed priced rows and counts unpriced ones (never $0 for unknown)", () => {
    const tl = buildTimeline([call("c1", 1, 0.01), call("c2", 2, null)], { answers: [answer({ cost: { value: 0.002, isEstimate: true } })] });
    expect(spendSoFar(tl)).toEqual({ usd: 0.012, unpriced: 1, priced: 2, isEstimate: true });
    expect(spendSoFarText(spendSoFar(tl))).toBe("$0.01 + 1 unpriced so far");
    expect(spendSoFarText({ usd: 0, unpriced: 3, priced: 0, isEstimate: false })).toBe("spend unknown so far (3 unpriced)");
  });
  it("decision counts from revealed jev_decision items", () => {
    expect(decisionCounts([item({ kind: "jev_decision", outcome: "act" }), item({ id: "d2", kind: "jev_decision", outcome: "drop" })])).toEqual({ act: 1, flag: 0, drop: 1 });
  });
});

describe("GEO selectors", () => {
  const answers = Array.from({ length: 15 }, (_, i) => answer({ id: `obs:${String(i).padStart(2, "0")}`, observationId: `o${i}`, at: at(i), promptId: `p${i}`, outcome: i % 3 === 0 ? "cited" : i % 3 === 1 ? "named" : "missing", cost: { value: 0.001, isEstimate: true } }));
  it("lane totals from revealed answers; unknown cost makes the sum unknown", () => {
    const t = laneTotalsFrom(answers, "gemini");
    expect([t.cited, t.named, t.missing, t.pending]).toEqual([5, 5, 5, 0]);
    expect(t.cost.value).toBeCloseTo(0.015);
    expect(t.citedInstead).toEqual({ host: "reviews.example", sourceType: "review_site", answers: 10 });
    expect(laneTotalsFrom([...answers, answer({ id: "obs:x", cost: { value: null, isEstimate: false }, outcome: null })], "gemini")).toMatchObject({ pending: 1, cost: { value: null } });
  });
  it("gauge ratio: citation rate cited/(cited+named+missing); custom lanes use mention rate", () => {
    expect(laneRatio({ cited: 23, named: 10, missing: 65 }, false)).toEqual({ numerator: 23, denominator: 98, value: 23 / 98 });
    expect(laneRatio({ cited: 23, named: 10, missing: 65 }, true).numerator).toBe(33);
    expect(laneRatio({ cited: 0, named: 0, missing: 0 }, false).value).toBeNull();
  });
  it("strip keeps the newest STRIP_MAX of the lane, newest at the right", () => {
    const s = laneStrip(answers, "gemini");
    expect(s.length).toBe(STRIP_MAX);
    expect(s[s.length - 1]!.id).toBe("obs:14");
    expect(laneStrip(answers, "openai_geo")).toEqual([]);
  });
  it("B card: newest skipped answer with a matched page; counts prompts", () => {
    const k = latestSkipped(answers, "gemini");
    expect(k.row!.id).toBe("obs:14");
    expect(k.total).toBe(10);
  });
  it("cited-instead bars count only answers that left us out (missing or named), like the lane stat", () => {
    const bars = citedInsteadBars([
      answer({ id: "a1", outcome: "missing" }),
      answer({ id: "a2", outcome: "named" }),
      answer({ id: "a3", outcome: "cited", ownCitedUrl: "https://shop.example/x" }),
      answer({ id: "a4", outcome: null }),
      answer({ id: "a5", outcome: "failed" }),
    ]);
    expect(bars).toEqual([{ host: "reviews.example", sourceType: "review_site", count: 2, providers: ["gemini"] }]);
    expect(bars[0]!.count).toBe(laneTotalsFrom([answer({ id: "a1" }), answer({ id: "a2", outcome: "named" }), answer({ id: "a3", outcome: "cited" })], "gemini").citedInstead!.answers);
  });
  it("heatmap cells: pending only when genuinely pending; not run only when the run is over", () => {
    const idx = answerIndex([answer(), answer({ id: "obs:n", promptId: "p2", outcome: null })]);
    const none = new Set<string>();
    expect(heatCell(idx, none, none, "p1", "gemini", { liveActive: false, laneBusy: false })).toMatchObject({ kind: "answer", outcome: "missing" });
    expect(heatCell(idx, none, none, "p2", "gemini", { liveActive: true, laneBusy: true }).kind).toBe("analysing");
    // Finished run or replay: an answer without an outcome will never be analysed.
    expect(heatCell(idx, none, none, "p2", "gemini", { liveActive: false, laneBusy: false }).kind).toBe("not_analysed");
    expect(heatCell(idx, none, none, "p3", "gemini", { liveActive: true, laneBusy: true }).kind).toBe("pending");
    expect(heatCell(idx, none, none, "p3", "gemini", { liveActive: true, laneBusy: false }).kind).toBe("none");
    expect(heatCell(idx, none, none, "p3", "gemini", { liveActive: false, laneBusy: false }).kind).toBe("not_run");
    expect(heatCell(idx, new Set(["p3|gemini"]), new Set(["p3|gemini"]), "p3", "gemini", { liveActive: false, laneBusy: false }).kind).toBe("pending");
    expect(heatCell(idx, none, new Set(["p3|gemini"]), "p3", "gemini", { liveActive: false, laneBusy: false }).kind).toBe("none");
  });
});

describe("run selection", () => {
  const cur = [
    { id: "g1", agent: "geo" as const, status: "running" },
    { id: "s1", agent: "seo" as const, status: "completed" },
  ];
  it("?run= wins, else the newest active run, else the latest finished", () => {
    expect(pickLiveRun(cur, "x", null)).toBe("x");
    expect(pickLiveRun(cur, null, null)).toBe("g1");
    expect(pickLiveRun([cur[1]!], null, null)).toBe("s1");
    expect(pickLiveRun(null, null, null)).toBeNull();
  });
  it("mode picks that agent's run, falling back to the run list; null when it has none", () => {
    expect(pickLiveRun(cur, null, "seo")).toBe("s1");
    expect(pickLiveRun([cur[0]!], null, "seo", [{ id: "s0", agent: "seo", status: "completed", createdAt: at(1) }, { id: "s2", agent: "seo", status: "failed", createdAt: at(9) }])).toBe("s2");
    expect(pickLiveRun([cur[0]!], null, "seo", [])).toBeNull();
  });
});

describe("arrivals: animation batching and announcements", () => {
  it("animates only the newest MAX_ANIMATED rows of a batch, staggered in time order (presentation only)", () => {
    const evs = Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, t: i }));
    const ids = animatedIds(evs);
    expect(ids.size).toBe(MAX_ANIMATED);
    expect(ids.has("e19")).toBe(true);
    expect(ids.has("e0")).toBe(false);
    expect([...ids][0]).toBe("e8");
    expect(staggerDelay(ids, "e8")).toBe(0);
    expect(staggerDelay(ids, "e9")).toBe(70);
    expect(staggerDelay(ids, "e19")).toBe(8 * 70);
    expect(staggerDelay(ids, "nope")).toBe(0);
  });
  it("the capped item list never evicts step items (rail and panels derive from them)", () => {
    const steps = [step("evt:a", 0, "seo.crawl", "started"), step("evt:b", 1, "seo.crawl", "completed")];
    const reads = Array.from({ length: 10 }, (_, i) => read(`snap:${String(i).padStart(2, "0")}`, 10 + i, `https://shop.example/${i}`));
    const out = mergeKeepingSteps(steps, reads, 5);
    expect(out.map((i) => i.id)).toEqual(["evt:a", "evt:b", "snap:07", "snap:08", "snap:09"]);
    expect(stepStatus(out, "seo.crawl")).toBe("completed");
    expect(mergeKeepingSteps(out, [read("snap:00", 10, "https://shop.example/0")], 5).map((i) => i.id)).toEqual(["evt:a", "evt:b", "snap:07", "snap:08", "snap:09"]);
  });
  it("summarises arrivals in one sentence and never echoes untrusted text", () => {
    const feed = seoFeed();
    const tl: TimelineEvent[] = buildTimeline([read("snap:9", 1, "https://shop.example/x")], { elements: feed.elements.slice(0, 2), answers: [answer({ promptText: HOSTILE, outcome: "cited" }), answer({ id: "obs:2" })] });
    const s = arrivalSummary(tl);
    expect(s).toBe("2 new judgments: 1 change, 1 keep. 2 new answers: 1 cited. 1 page read.");
    expect(s).not.toContain("<");
  });
});

describe("labels (exact honesty wording)", () => {
  const spend = { usd: 0.07, isEstimate: true, unknownCalls: 0 };
  it("spend phrase per case; unknown is never $0", () => {
    expect(spendPhrase({ usd: 0.07, isEstimate: false, unknownCalls: 0 }, 4)).toBe("$0.07 spent (actual)");
    expect(spendPhrase(spend, 4)).toBe("$0.07 spent (estimate)");
    expect(spendPhrase({ usd: 0.07, isEstimate: true, unknownCalls: 3 }, 7)).toBe("$0.07+ spent (estimate; 3 calls unpriced)");
    expect(spendPhrase({ usd: null, isEstimate: false, unknownCalls: 12 }, 12)).toBe("spend unknown (12 calls unpriced)");
    expect(spendPhrase({ usd: null, isEstimate: false, unknownCalls: 0 }, 0)).toBe("$0.00 spent (no provider calls)");
  });
  it("pill: live, queued, finished, replay and demo", () => {
    const base = { demo: false, elapsedMs: 402_000, spend, providerCalls: 4, startedAt: "2026-09-29T14:02:00", speed: 10 as const, gapsShortened: false, status: "completed" };
    expect(pillText({ ...base, mode: "live" })).toBe("Live run · 06:42 elapsed · $0.07 spent (estimate)");
    expect(pillText({ ...base, mode: "pending" })).toBe("Queued run · waiting to start");
    expect(pillText({ ...base, mode: "finished", elapsedMs: 432_000 })).toBe("Run finished · 07:12 · $0.07 spent (estimate)");
    // The run's status is shown: a failed or partial run never reads as complete.
    expect(pillText({ ...base, mode: "finished", elapsedMs: 432_000, status: "failed" })).toBe("Run failed · 07:12 · $0.07 spent (estimate)");
    expect(pillText({ ...base, mode: "finished", elapsedMs: 432_000, status: "rate_limited" })).toBe("Run rate limited · 07:12 · $0.07 spent (estimate)");
    expect(pillText({ ...base, mode: "replay", status: "partial" })).toBe("Replay of the run on 29 Sep 2026, 14:02 · real stored events · 10× speed · run partial");
    expect(pillText({ ...base, mode: "replay" })).toBe("Replay of the run on 29 Sep 2026, 14:02 · real stored events · 10× speed");
    expect(pillText({ ...base, mode: "replay", speed: 30, gapsShortened: true })).toBe("Replay of the run on 29 Sep 2026, 14:02 · real stored events · 30× speed · idle gaps over 10 s shortened");
    expect(pillText({ ...base, mode: "live", demo: true })).toMatch(/^Demo data - simulated run · Live run/);
    expect(replayLabel("2026-09-29T14:02:00", 1, false, true)).toBe("Demo data - simulated run · Replay of the run on 29 Sep 2026, 14:02 · real stored events · 1× speed");
    expect(clockText(3_723_000)).toBe("1:02:03");
  });
  it("Jev chips: Noul tier + raw value, Choice with its real confidence, drop withheld, rule class", () => {
    expect(jevChipText(element().jev)).toBe("Jev act · 0.08");
    expect(jevChipText({ questionId: "seo.page_action", tier: "act", noul: null, choice: "update", confidence: 0.87, provider: "t", model: "m" })).toBe("Jev act · update · conf 0.87");
    expect(jevChipText({ questionId: "q", tier: "drop", noul: 0.4, choice: null, confidence: null, provider: "t", model: "m" })).toBe("Jev drop · withheld");
    expect(jevChipText({ questionId: "links.should_exist", tier: "act", noul: 0.91, choice: null, confidence: null, provider: "t", model: "m" })).toBe("Jev act · should-exist 0.91");
    expect(jevChipText(null, { ruleId: "R", severity: "major", class: "fact" })).toBe("Rule · fact");
    expect(jevChipText(element().jev)).not.toMatch(/confidence/i);
  });
  it("position is approximate (≈) for page aggregates, exact for a query row; window short form; label dedupe", () => {
    expect(positionText(element().gsc)).toBe("≈ 11.2");
    expect(positionText(query().gsc)).toBe("7.1");
    expect(positionText(null)).toBe("—");
    expect(windowShort({ start: "2026-09-01", end: "2026-09-28" })).toBe("1–28 Sep");
    expect(dedupeLabels(["Demo data - simulated run", "Demo data – simulated run", "x"])).toEqual(["Demo data - simulated run", "x"]);
    // Same first clause (before ';'): the later wording is dropped.
    expect(dedupeLabels(["API-sampled answers; consumer apps may answer differently.", "API-sampled answers; not consumer-app answers", "Other note."])).toEqual([
      "API-sampled answers; consumer apps may answer differently.",
      "Other note.",
    ]);
    // Search Console sums over query+page rows are lower bounds.
    expect(clicksText({ ...element().gsc!, basis: "query_page_rows" })).toBe("≥ 310");
    expect(clicksText(element().gsc)).toBe("310");
  });
  it("itemsOf keeps activity items of revealed events only", () => {
    expect(itemsOf(buildTimeline([read("snap:1", 1, "https://a.example/")], { recommendations: [rec()] })).map((i) => i.id)).toEqual(["snap:1"]);
  });
});

describe("feed merge", () => {
  it("keeps the previous totals on full pages (totals null) and takes the complete label set from the page with totals", () => {
    const g1 = mergeGeoFeed(null, geoFeedPage({ labels: ["2 stored answer(s) are awaiting analysis; their outcome is not counted yet."] }));
    const g2 = mergeGeoFeed(g1, geoFeedPage({ totals: null, labels: ["x"] }));
    expect(g2.totals).toBe(g1.totals);
    expect(g2.labels).toContain("2 stored answer(s) are awaiting analysis; their outcome is not counted yet.");
    const g3 = mergeGeoFeed(g2, geoFeedPage({ labels: ["API-sampled answers; consumer apps may answer differently."] }));
    expect(g3.labels).toEqual(["API-sampled answers; consumer apps may answer differently."]);
    const s1 = mergeSeoFeed(null, seoFeed());
    expect(mergeSeoFeed(s1, seoFeed({ totals: null, gscSync: null, elements: [] })).totals).toBe(s1.totals);
  });
});

function geoFeedPage(over: Partial<import("../src/shared/types").LiveGeoBoardResponse>) {
  return { ...geoFeedBase(), ...over };
}
