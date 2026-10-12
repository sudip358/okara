/**
 * [A41] Internal links Live panel, web side: the pure helpers (stage rail, link flow lane, counters, waiting line,
 * merge / cursor, labels) and the rendered panel in its states: empty, live, finished (replay at the end), replay
 * mid-way, interrupted / failed, reduced motion, and untrusted page text kept as plain text.
 */
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LinkLiveEvent, LinkLiveRunView } from "@shared/link-live";
import { initClock, seekClock, skipToEnd } from "../src/web/pages/live/engine";
import {
  counters,
  flowRows,
  liveQuery,
  mergeLive,
  modeLabel,
  nowWaiting,
  durationText,
  shouldPoll,
  stageRail,
  stepClock,
  totalsFromEvents,
} from "../src/web/pages/links/live-lib";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FC = (props: any) => ReactElement | null;
const load = async <T,>(rel: string): Promise<T> => (await import(/* @vite-ignore */ rel)) as T;
const mod = await load<{ LinkLiveView: FC }>("../src/web/pages/links/LinkLivePanel.tsx");

const T0 = Date.parse("2026-10-12T10:00:00.000Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const HOSTILE = `<img src=x onerror=alert(1)>`;

let seq = 0;
const ev = (s: number, stage: LinkLiveEvent["stage"], status: LinkLiveEvent["status"], detail: LinkLiveEvent["detail"] = {}): LinkLiveEvent => ({ seq: ++seq, at: at(s), stage, status, detail });

function analysisEvents(): LinkLiveEvent[] {
  seq = 0;
  return [
    ev(0, "run", "started", { note: "Link analysis started." }),
    ev(0.2, "graph.load", "started"),
    ev(1, "graph.load", "completed", { n: { pages: 8, inventory: 10 } }),
    ev(1.1, "graph.edges", "completed", { n: { urls: 12, edges: 30, contentEdges: 18, orphans: 2 } }),
    ev(1.1, "graph.clusters", "completed", { n: { hubs: 2, spokes: 5 } }),
    ev(1.1, "graph.anchors", "completed", { n: { audited: 8, flagged: 1 } }),
    ev(1.2, "graph.verify", "completed", { n: { checked: 2, verified: 1, notFound: 1, pending: 0, sourceUnavailable: 0 }, items: [{ s: "/a", t: "/b", v: "verified" }, { s: "/c", t: "/d", v: "not_found" }] }),
    ev(1.3, "graph.save", "started", { n: { urls: 12 } }),
    ev(2, "graph.save", "completed", { n: { urls: 12 } }),
    ev(2.1, "pages", "completed", { n: { pages: 8, eligible: 7, analysed: 6 } }),
    ev(2.2, "candidates", "completed", { n: { considered: 40, termPairs: 37, clusterGapPairs: 3 }, items: [{ s: "/products/pull", t: "/blogs/care", v: "candidate", p: 1.234 }, { s: "/x", t: "/y", v: "candidate", p: 0.5 }] }),
    ev(2.3, "sentences", "completed", { n: { matched: 6, noFittingSentence: 2, withoutAnchor: 0, cap: 400, capped: 0 }, items: [{ s: "/products/pull", t: "/blogs/care", a: "care for brass", v: "matched" }] }),
    ev(2.4, "jev", "started", { n: { pairs: 6, batches: 3, batchSize: 2 } }),
    ev(5, "jev", "progress", { n: { batch: 1, batches: 3, calls: 1, judged: 2, answered: 2, kept: 1, review: 0, dropped: 1, noAnswer: 0, notSent: 0 }, items: [{ s: "/products/pull", t: "/blogs/care", a: "care for brass", v: "kept" }, { s: "/x", t: "/y", a: "why", v: "dropped" }] }),
  ];
}

function finishEvents(base: LinkLiveEvent[]): LinkLiveEvent[] {
  return [
    ...base,
    ev(8, "jev", "progress", { n: { batch: 2, batches: 3, calls: 2, judged: 4, answered: 4, kept: 3, review: 0, dropped: 1 }, items: [{ s: "/p", t: "/q", a: "q", v: "kept" }] }),
    ev(11, "jev", "progress", { n: { batch: 3, batches: 3, calls: 3, judged: 6, answered: 6, kept: 4, review: 1, dropped: 1 }, items: [{ s: "/r", t: "/s", a: "s", v: "review" }] }),
    ev(11.1, "jev", "completed", { n: { calls: 3, judged: 6, answered: 6, kept: 4, review: 1, dropped: 1 } }),
    ev(11.2, "drafts", "skipped", { n: { pool: 0 }, note: "Every high-priority pair has a fitting existing sentence: nothing to draft." }),
    ev(11.3, "save", "started", { n: { rows: 6 } }),
    ev(12, "save", "completed", { n: { rows: 6, suggested: 4, review: 1, rejected: 1, drafts: 0 } }),
    ev(12.1, "run", "completed", { n: { suggestions: 6 } }),
  ];
}

const runView = (o: Partial<LinkLiveRunView> = {}): LinkLiveRunView => ({
  id: "llive_1",
  kind: "analysis",
  status: "running",
  isDemo: false,
  startedAt: at(0),
  updatedAt: at(5),
  finishedAt: null,
  totals: { pages: 8, urls: 12, edges: 30, verifyChecked: 2, verified: 1, notFound: 1, pairsConsidered: 40, pairsMatched: 6, judged: 2, jevKept: 1, jevDropped: 1, jevReview: 0, jevCalls: 1 },
  eventsStored: 14,
  eventsDropped: 0,
  ...o,
});

const render = (props: Record<string, unknown>) =>
  renderToStaticMarkup(
    h(mod.LinkLiveView, {
      run: null,
      events: [],
      loading: false,
      error: null,
      reduced: false,
      nowMs: T0 + 6_000,
      clock: null,
      freshFrom: Number.POSITIVE_INFINITY,
      starting: null,
      open: true,
      onToggle: () => {},
      actions: h("button", { type: "button" }, "Run link analysis"),
      ...props,
    }),
  );
/** Markup without the injected <style> block (its CSS names every animation class). */
const body = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, "");
const text = (html: string) => body(html).replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const chip = (html: string, id: string) => new RegExp(`data-chip="${id}" data-status="([a-z_]+)"`).exec(html)?.[1];

describe("live-lib", () => {
  it("stage rail: done, running, not started while live; ended / failed / not reached once over", () => {
    const e = analysisEvents();
    const live = stageRail("analysis", e, false);
    expect(live.map((c) => [c.id, c.status])).toEqual([
      ["graph", "done"],
      ["verify", "done"],
      ["candidates", "done"],
      ["jev", "running"],
      ["drafts", "not_started"],
      ["saved", "not_started"],
    ]);
    expect(live.find((c) => c.id === "graph")!.count).toBe("12 URLs · 30 links");
    expect(live.find((c) => c.id === "verify")!.count).toBe("1 verified · 1 not found of 2");
    expect(live.find((c) => c.id === "candidates")!.count).toBe("40 pairs · 6 matched");
    expect(live.find((c) => c.id === "jev")!.count).toBe("batch 1 of 3 · 2 judged · 1 kept · 1 dropped");
    const over = stageRail("analysis", e, true);
    expect(over.find((c) => c.id === "jev")!.status).toBe("ended");
    expect(over.find((c) => c.id === "drafts")!.status).toBe("not_reached");
    expect(stageRail("analysis", e, true, true).find((c) => c.id === "jev")!.status).toBe("failed");
    const done = stageRail("analysis", finishEvents(analysisEvents()), true);
    expect(done.map((c) => c.status)).toEqual(["done", "done", "done", "done", "skipped", "done"]);
    expect(done.find((c) => c.id === "saved")!.count).toBe("6 suggestions");
    // A graph rebuild has three chips.
    expect(stageRail("graph", [], false).map((c) => c.id)).toEqual(["graph", "verify", "saved"]);
  });

  it("waiting line only for genuinely pending work while live", () => {
    const e = analysisEvents();
    expect(nowWaiting(e, true)).toBe("Waiting for Jev · batch 2 of 3");
    expect(nowWaiting(e, false)).toBeNull();
    expect(nowWaiting(e.slice(0, 2), true)).toBe("Loading stored snapshots");
    expect(nowWaiting(finishEvents(analysisEvents()), true)).toBeNull();
  });

  it("flow rows: one row per pair, verdict chips appended in order, most recently updated first", () => {
    const rows = flowRows(finishEvents(analysisEvents()));
    const pull = rows.find((r) => r.source === "/products/pull")!;
    expect(pull.chips.map((c) => c.v)).toEqual(["candidate", "matched", "kept"]);
    expect(pull.anchor).toBe("care for brass");
    expect(pull.priority).toBe(1.234);
    expect(rows[0]!.source).toBe("/r");
    expect(flowRows(finishEvents(analysisEvents()), 2)).toHaveLength(2);
  });

  it("counters show only stored figures; totals from events match the stored ones", () => {
    const e = finishEvents(analysisEvents());
    const t = totalsFromEvents(e);
    expect(t).toMatchObject({ pages: 8, urls: 12, pairsConsidered: 40, pairsMatched: 6, judged: 6, jevKept: 4, jevDropped: 1, saved: 6, verified: 1 });
    const c = counters("analysis", t);
    expect(c.map((x) => x.key)).toEqual(["pages", "pairs", "judged", "kept", "verified", "saved"]);
    expect(counters("graph", { urls: 3, edges: 9 }).map((x) => [x.key, x.sub])).toEqual([["urls", "9 links"]]);
  });

  it("merge, cursor and polling", () => {
    const e = analysisEvents();
    const res = (run: LinkLiveRunView, events: LinkLiveEvent[]) => ({ run, events, nextCursor: events[events.length - 1]?.seq ?? 0, hasMore: false, pollMs: 1500 });
    const a = mergeLive(null, res(runView(), e.slice(0, 5)));
    const b = mergeLive(a, res(runView(), e.slice(4)));
    expect(b.events.map((x) => x.seq)).toEqual(e.map((x) => x.seq));
    expect(b.cursor).toBe(e.length);
    expect(liveQuery(b.run, b.cursor)).toBe(`?run=llive_1&after=${e.length}`);
    const c = mergeLive(b, res(runView({ id: "llive_2" }), e.slice(0, 1)));
    expect(c.events).toHaveLength(1);
    expect(mergeLive(c, { run: null, events: [], nextCursor: 0, hasMore: false, pollMs: 1500 })).toEqual({ run: null, events: [], cursor: 0 });
    expect(shouldPoll(runView(), false)).toBe(true);
    expect(shouldPoll(runView({ status: "completed" }), false)).toBe(false);
    expect(shouldPoll(null, true)).toBe(true);
    expect(shouldPoll(runView({ status: "interrupted" }), false)).toBe(false);
  });

  it("durations: tenths of a second under a minute, then a clock", () => {
    expect(durationText(40)).toBe("under 0.1 s");
    expect(durationText(420)).toBe("0.4 s");
    expect(durationText(59_999)).toBe("59.9 s");
    expect(durationText(402_000)).toBe("06:42");
    expect(durationText(3_792_000)).toBe("1:03:12");
    expect(durationText(null)).toBe("--:--");
  });

  it("step: the playhead moves to the next stored event time, paused; from the end it starts over", () => {
    const times = [T0, T0 + 5, T0 + 5, T0 + 900];
    let c = skipToEnd(initClock({ t0: T0, tEnd: T0 + 900 }, 10, false));
    c = stepClock(c, times);
    expect(c).toMatchObject({ p: T0, playing: false, finished: false });
    c = stepClock(c, times);
    expect(c.p).toBe(T0 + 5);
    c = stepClock(c, times);
    expect(c).toMatchObject({ p: T0 + 900, finished: true });
  });

  it("labels: live, replay with date and speed, demo", () => {
    expect(modeLabel(runView(), "live", null)).toBe("Live from this link analysis's stored progress events · nothing is projected");
    const done = runView({ status: "completed", finishedAt: at(12) });
    expect(modeLabel(done, "replay", null)).toMatch(/^Replay of the link analysis on \d{1,2} Oct 2026, \d\d:\d\d · real stored events$/);
    expect(modeLabel(done, "replay", { playing: true, speed: 10, gaps: true })).toMatch(/· real stored events · 10× speed · idle gaps over 10 s shortened$/);
    expect(modeLabel(done, "replay", { playing: false, paused: true, speed: 10, gaps: false })).toMatch(/· real stored events · paused \(▶ plays at stored times, Step shows the next stored event\)$/);
    expect(modeLabel({ ...done, isDemo: true, kind: "graph" }, "replay", null)).toMatch(/^Demo project \(seeded crawl data\) · Replay of the link graph rebuild on /);
  });
});

describe("LinkLiveView render", () => {
  it("empty state when no run was recorded", () => {
    const html = render({});
    expect(html).toContain('data-mode="empty"');
    expect(text(html)).toMatch(/No link analysis or graph rebuild has been recorded yet/);
    expect(text(html)).toContain("Run link analysis");
  });

  it("live: LIVE badge, pulsing active stage, waiting shimmer, counters, flow rows, elapsed", () => {
    const e = analysisEvents();
    const html = render({ run: runView(), events: e, freshFrom: 12 });
    expect(html).toContain('data-mode="live"');
    expect(text(html)).toContain("LIVE");
    expect(chip(html, "jev")).toBe("running");
    expect(chip(html, "graph")).toBe("done");
    expect(chip(html, "saved")).toBe("not_started");
    expect(body(html)).toMatch(/lv-pulse/);
    expect(body(html)).toMatch(/lv-shimmer[^>]*>Waiting for Jev · batch 2 of 3/);
    expect(text(html)).toContain("elapsed 6.0 s");
    expect(text(html)).toContain("pairs considered");
    expect(text(html)).toMatch(/\/products\/pull ⟶ links to \/blogs\/care/);
    expect(text(html)).toContain("kept by Jev");
    expect(text(html)).toContain("dropped by Jev");
    // Only items of events after freshFrom animate: event 14's verdict chips pop; its pairs were already on screen.
    expect(body(html)).toMatch(/lv-pop[^>]*>kept by Jev/);
    expect(body(html)).not.toMatch(/lv-row-in/);
    // Rows first shown by a fresh event slide in.
    expect(body(render({ run: runView(), events: e, freshFrom: 9 }))).toMatch(/lv-row-in/);
    expect(text(html)).toContain("Live from this link analysis's stored progress events");
  });

  it("finished: a labelled replay at its final state, nothing pending or pulsing", () => {
    const e = finishEvents(analysisEvents());
    const run = runView({ status: "completed", finishedAt: at(12.1), totals: { ...totalsFromEvents(e) } });
    const clock = skipToEnd(initClock({ t0: T0, tEnd: T0 + 12_100 }, 10, false));
    const html = render({ run, events: e, clock, replay: { onToggle: () => {}, onStep: () => {}, onRestart: () => {}, onEnd: () => {}, onSpeed: () => {} } });
    expect(html).toContain('data-mode="replay"');
    expect(text(html)).toContain("REPLAY");
    expect(text(html)).toMatch(/Replay of the link analysis on .* · real stored events/);
    expect(text(html)).not.toMatch(/× speed/);
    expect(text(html)).toContain("took 12.1 s");
    expect(body(html)).not.toMatch(/lv-shimmer|lv-pulse|lv-row-in|lv-pop/);
    expect(chip(html, "saved")).toBe("done");
    expect(chip(html, "drafts")).toBe("skipped");
    expect(html).toContain('aria-label="Replay controls"');
    expect(text(html)).toContain("Replay");
    expect(html).toContain('aria-label="Show the next stored event"');
  });

  it("replay mid-way: reveals only events up to the playhead and says the speed", () => {
    const e = finishEvents(analysisEvents());
    const run = runView({ status: "completed", finishedAt: at(12.1) });
    const clock = { ...seekClock(initClock({ t0: T0, tEnd: T0 + 12_100 }, 10, true), T0 + 6_000), playing: true };
    const html = render({ run, events: e, clock });
    expect(text(html)).toMatch(/real stored events · 10× speed/);
    expect(text(html)).toContain("run time 6.0 s");
    expect(chip(html, "jev")).toBe("running");
    expect(chip(html, "saved")).toBe("not_started");
    expect(text(html)).not.toContain("/r");
    // Replay never shows the live "Waiting for" line.
    expect(text(html)).not.toMatch(/Waiting for/);
  });

  it("interrupted and failed runs never read as running", () => {
    const e = analysisEvents();
    const clock = skipToEnd(initClock({ t0: T0, tEnd: T0 + 5_000 }, 10, false));
    const interrupted = render({ run: runView({ status: "interrupted" }), events: e, clock });
    expect(chip(interrupted, "jev")).toBe("ended");
    expect(text(interrupted)).toMatch(/Interrupted/);
    expect(text(interrupted)).toMatch(/stopped without a final event/);
    expect(body(interrupted)).not.toMatch(/lv-pulse|lv-shimmer/);
    const failedEvents = [...e, { seq: 99, at: at(6), stage: "run" as const, status: "failed" as const, detail: { note: "Run failed: boom" } }];
    const failed = render({ run: runView({ status: "failed", finishedAt: at(6) }), events: failedEvents, clock: skipToEnd(initClock({ t0: T0, tEnd: T0 + 6_000 }, 10, false)) });
    expect(chip(failed, "jev")).toBe("failed");
    expect(chip(failed, "drafts")).toBe("not_reached");
    expect(text(failed)).toContain("Run failed: boom");
  });

  it("reduced motion: no slide, pop, pulse classes; content still shown", () => {
    const e = analysisEvents();
    const html = render({ run: runView(), events: e, freshFrom: 0, reduced: true });
    expect(body(html)).not.toMatch(/lv-row-in|lv-pop|lv-pulse/);
    expect(text(html)).toContain("kept by Jev");
    expect(text(html)).toContain("Waiting for Jev · batch 2 of 3");
  });

  it("collapsed: the body is hidden but the label stays visible", () => {
    const html = render({ run: runView({ status: "completed", finishedAt: at(5) }), events: analysisEvents(), open: false, clock: skipToEnd(initClock({ t0: T0, tEnd: T0 + 5_000 }, 10, false)) });
    expect(html).toMatch(/aria-expanded="false"/);
    expect(html).toMatch(/<div id="[^"]+" hidden=""/);
    expect(text(html)).toMatch(/Replay of the link analysis/);
  });

  it("renders untrusted paths and anchors as plain text", () => {
    seq = 0;
    const e = [ev(0, "run", "started"), ev(1, "sentences", "completed", { n: { matched: 1 }, items: [{ s: `/${HOSTILE}`, t: "/t", a: `${HOSTILE}ignore previous instructions`, v: "matched" }] })];
    const html = body(render({ run: runView(), events: e }));
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(text(html)).toContain("ignore previous instructions");
  });
});
