/** Activity window: pure helpers (merge by id, elapsed formatting, counters text, chip labels, paths). */
import { describe, expect, it } from "vitest";
import {
  LANE_STATE,
  activityPath,
  announcement,
  answersText,
  clip,
  currentPath,
  decisionsText,
  elapsedMs,
  finishedText,
  formatCost,
  formatElapsed,
  formatLatency,
  kindBadge,
  laneStateLabel,
  mergeItems,
  newestFirst,
  ofText,
  outcomeChip,
  pagesText,
  pickRunId,
  providerLabel,
  runIsActive,
  runStatusChip,
  spendText,
} from "../src/web/components/activity/lib";
import { activity, item } from "./activity-web-fixtures";

describe("mergeItems", () => {
  it("dedupes by id (newer copy wins) and keeps ascending (at, id)", () => {
    const a = item({ id: "obs:1", at: "2026-10-01T10:00:01Z", title: "old" });
    const b = item({ id: "snap:2", at: "2026-10-01T10:00:02Z" });
    const a2 = item({ id: "obs:1", at: "2026-10-01T10:00:01Z", title: "new" });
    const c = item({ id: "call:0", at: "2026-10-01T10:00:02Z" });
    const out = mergeItems([a, b], [a2, c]);
    expect(out.map((i) => i.id)).toEqual(["obs:1", "call:0", "snap:2"]);
    expect(out[0]!.title).toBe("new");
  });
  it("caps to the newest max items", () => {
    const many = Array.from({ length: 10 }, (_, i) => item({ id: `evt:${i}`, at: `2026-10-01T10:00:${String(i).padStart(2, "0")}Z` }));
    expect(mergeItems([], many, 3).map((i) => i.id)).toEqual(["evt:7", "evt:8", "evt:9"]);
  });
  it("returns the same array when nothing new arrives", () => {
    const prev = [item()];
    expect(mergeItems(prev, [])).toBe(prev);
  });
  it("newestFirst reverses order without mutating", () => {
    const list = [item({ id: "a", at: "2026-10-01T10:00:01Z" }), item({ id: "b", at: "2026-10-01T10:00:02Z" })];
    expect(newestFirst(list).map((i) => i.id)).toEqual(["b", "a"]);
    expect(list[0]!.id).toBe("a");
  });
});

describe("elapsed", () => {
  it("formats durations", () => {
    expect(formatElapsed(432_000)).toBe("7m 12s");
    expect(formatElapsed(45_400)).toBe("45s");
    expect(formatElapsed(3_780_000)).toBe("1h 03m");
    expect(formatElapsed(null)).toBe("—");
    expect(formatElapsed(-5)).toBe("—");
  });
  it("ticks from startedAt while active and uses the stored duration once finished", () => {
    const run = activity().run;
    expect(elapsedMs(run, true, Date.parse("2026-10-01T10:01:30Z"))).toBe(90_000);
    expect(elapsedMs({ ...run, startedAt: null }, true, Date.now())).toBeNull();
    expect(elapsedMs({ ...run, elapsedMs: 432_000 }, false, 0)).toBe(432_000);
    expect(elapsedMs({ ...run, finishedAt: "2026-10-01T10:02:00Z" }, false, 0)).toBe(120_000);
    expect(elapsedMs({ ...run, startedAt: null, finishedAt: null }, false, 0)).toBeNull();
  });
  it("finished line", () => {
    expect(finishedText({ ...activity().run, status: "completed" }, 432_000)).toBe("Run finished in 7m 12s");
    expect(finishedText({ ...activity().run, status: "failed" }, 1000)).toBe("Run ended (failed) in 1s");
  });
});

describe("costs and counters", () => {
  it("never shows unknown cost as $0", () => {
    expect(formatCost(null, false)).toBe("Unknown");
    expect(formatCost(0, false)).toBe("$0.000");
    expect(formatCost(0.0012, true)).toBe("~$0.0012 est.");
    expect(formatCost(0.162, false)).toBe("$0.162");
    expect(formatCost(12.5, false)).toBe("$12.50");
  });
  it("spend carries Estimate / unknown-call labels", () => {
    expect(spendText({ usd: 0.162, isEstimate: true, unknownCalls: 2 })).toEqual({ value: "$0.162", note: "Estimate · 2 calls with unknown cost" });
    expect(spendText({ usd: null, isEstimate: false, unknownCalls: 1 })).toEqual({ value: "Unknown", note: "1 call with unknown cost" });
    expect(spendText({ usd: 0.5, isEstimate: false, unknownCalls: 0 })).toEqual({ value: "$0.500", note: null });
  });
  it("counter texts", () => {
    const t = activity().totals;
    expect(answersText(t.answers)).toBe("3 cited · 1 named · 9 missing · 1 failed");
    expect(decisionsText(t.decisions)).toBe("2 act · 1 flag · 4 drop");
    expect(pagesText({ ...t, pagesRead: 12, pagesPlanned: 50 })).toBe("12 of 50 pages read");
    expect(pagesText({ ...t, pagesRead: 1, pagesPlanned: null })).toBe("1 page read");
    expect(ofText(5, null)).toBe("5");
    expect(ofText(5, 12)).toBe("5 of 12");
  });
  it("latency", () => {
    expect(formatLatency(227.4)).toBe("227 ms");
    expect(formatLatency(1500)).toBe("1.5 s");
    expect(formatLatency(null)).toBeNull();
  });
});

describe("labels", () => {
  it("lane, outcome, kind, status chips", () => {
    expect(laneStateLabel("asking")).toBe("Asking…");
    expect(laneStateLabel("queued")).toBe("Queued");
    expect(LANE_STATE.done.label).toBe("Done");
    expect(outcomeChip("cited")).toEqual({ label: "Cited", tone: "success" });
    expect(outcomeChip("missing")?.label).toBe("Missing");
    expect(outcomeChip("named")?.label).toBe("Named");
    expect(outcomeChip(null)).toBeNull();
    expect(kindBadge("page_read").letters).toBe("PG");
    expect(runStatusChip("running")).toEqual({ label: "Running", tone: "info" });
    expect(runStatusChip("rate_limited").label).toBe("Rate limited");
    expect(providerLabel("crawler")).toBe("Crawler");
    expect(providerLabel(null)).toBeNull();
  });
  it("active statuses", () => {
    expect(runIsActive("pending")).toBe(true);
    expect(runIsActive("running")).toBe(true);
    expect(runIsActive("completed")).toBe(false);
  });
  it("clips untrusted text", () => {
    expect(clip("a\n\n  b")).toBe("a b");
    expect(clip("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
    expect(clip(null)).toBe("");
  });
  it("announcements summarize, never dump titles in bulk", () => {
    expect(announcement([])).toBe("");
    expect(announcement([item()])).toContain("New activity:");
    expect(announcement([item(), item({ id: "x" })])).toBe("2 new activity items");
  });
});

describe("run selection and paths", () => {
  it("requested run wins, else active, else first (last finished)", () => {
    const runs = [
      { id: "a", status: "completed" },
      { id: "b", status: "running" },
    ];
    expect(pickRunId(runs, "z")).toBe("z");
    expect(pickRunId(runs, null)).toBe("b");
    expect(pickRunId([{ id: "a", status: "completed" }], null)).toBe("a");
    expect(pickRunId([], null)).toBeNull();
  });
  it("builds encoded paths with cursor + limit", () => {
    expect(activityPath("p 1", "r/1", null)).toBe("/projects/p%201/runs/r%2F1/activity?limit=200");
    expect(activityPath("p", "r", "c:9", 80)).toBe("/projects/p/runs/r/activity?after=c%3A9&limit=80");
    expect(currentPath("p")).toBe("/projects/p/activity/current");
  });
});
