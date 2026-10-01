/**
 * Activity window fixes (web): catch-up paging keeps the cursor local until every page succeeded, pages
 * a large replay to the end, drains backlogs immediately; run pick by recency; final errors; new
 * helpers for the restyled header/lanes/feed; expanded + error render states.
 */
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { ActivityItem, RunActivity } from "../src/shared/types";
import {
  MAX_CATCHUP_PAGES,
  OUTCOME,
  PAGE_LIMIT,
  POLL,
  catchUp,
  formatClock,
  isFinalError,
  itemChip,
  laneAnswers,
  laneModel,
  laneProgress,
  latestFinished,
  mergeItems,
  nextFeedDelay,
  pickRunId,
  readingParts,
  topCitedInstead,
} from "../src/web/components/activity/lib";
import { activity, item } from "./activity-web-fixtures";

/** Fake server: `total` items in insertion order; opaque cursor "c<n>" = n items consumed. */
function server(total: number, opts: { failOnCall?: number; active?: boolean } = {}) {
  const all: ActivityItem[] = Array.from({ length: total }, (_, i) =>
    item({ id: `evt:${String(i).padStart(6, "0")}`, at: new Date(Date.parse("2026-10-01T10:00:00Z") + i * 1000).toISOString() }),
  );
  let calls = 0;
  const seen: Array<string | null> = [];
  const fetchPage = async (after: string | null): Promise<RunActivity> => {
    calls++;
    seen.push(after);
    if (opts.failOnCall === calls) throw new Error("network blip");
    const from = after ? Number(after.slice(1)) : 0;
    const page = all.slice(from, from + PAGE_LIMIT);
    return activity({ active: opts.active ?? false, items: page, cursor: page.length ? `c${from + page.length}` : after });
  };
  return { all, fetchPage, seen, calls: () => calls };
}

describe("catchUp (cursor + paging)", () => {
  it("a failing later page rejects and leaves the caller's cursor untouched; the retry refetches those events", async () => {
    const s = server(900, { failOnCall: 3 });
    let cursor: string | null = null;
    await expect(catchUp(s.fetchPage, cursor)).rejects.toThrow("network blip");
    expect(cursor).toBeNull();
    const r = await catchUp(s.fetchPage, cursor);
    cursor = r.cursor;
    expect(cursor).toBe("c900");
    expect(r.received).toBe(900);
    expect(r.more).toBe(false);
  });
  it("a finished run with more than 1000 stored events is paged to the end, so the last event is shown", async () => {
    const s = server(1350, { active: false });
    const r = await catchUp(s.fetchPage, null);
    expect(r.more).toBe(false);
    expect(r.cursor).toBe("c1350");
    const kept = mergeItems([], r.items);
    expect(kept.at(-1)!.id).toBe(s.all.at(-1)!.id);
    expect(nextFeedDelay(r.more, r.last.active)).toBeNull();
  });
  it("stops at MAX_CATCHUP_PAGES per tick and asks for an immediate next tick", async () => {
    const s = server(PAGE_LIMIT * (MAX_CATCHUP_PAGES + 2), { active: true });
    const r = await catchUp(s.fetchPage, null);
    expect(s.calls()).toBe(MAX_CATCHUP_PAGES);
    expect(r.more).toBe(true);
    expect(nextFeedDelay(r.more, true)).toBe(0);
    const r2 = await catchUp(s.fetchPage, r.cursor);
    expect(r2.more).toBe(false);
    expect(r2.cursor).toBe(`c${PAGE_LIMIT * (MAX_CATCHUP_PAGES + 2)}`);
  });
  it("treats the cursor as opaque (passed back verbatim) and stops on a full page whose cursor did not move", async () => {
    const page = Array.from({ length: PAGE_LIMIT }, (_, i) => item({ id: `evt:${i}` }));
    let n = 0;
    const r = await catchUp(async () => {
      n++;
      return activity({ items: page, cursor: "eyJlIjo1fQ" });
    }, "eyJlIjo1fQ");
    expect(n).toBe(1);
    expect(r.more).toBe(false);
    expect(r.cursor).toBe("eyJlIjo1fQ");
  });
  it("polls every 2s while active, stops once finished", () => {
    expect(nextFeedDelay(false, true)).toBe(POLL.feed);
    expect(nextFeedDelay(false, false)).toBeNull();
  });
});

describe("run pick + errors", () => {
  it("replay shows the most recently finished run across agents when finishedAt is sent", () => {
    const runs = [
      { id: "seo1", status: "completed", finishedAt: "2026-10-01T09:00:00Z" },
      { id: "geo1", status: "partial", finishedAt: "2026-10-01T10:00:00Z" },
    ];
    expect(pickRunId(runs, null)).toBe("geo1");
    expect(latestFinished(runs)?.id).toBe("geo1");
    // Without timestamps the API order (already newest first) is kept.
    expect(pickRunId([{ id: "a", status: "completed" }, { id: "b", status: "completed" }], null)).toBe("a");
  });
  it("a pinned run stays on screen even after another run becomes the latest", () => {
    expect(pickRunId([{ id: "new", status: "running" }], "pinned")).toBe("pinned");
  });
  it("404/403 are final; other errors retry", () => {
    // Shaped like ApiError (an Error with a numeric status); api.ts itself is not imported in Node tests.
    const apiErr = (status: number) => Object.assign(new Error("x"), { status });
    expect(isFinalError(apiErr(404))).toBe(true);
    expect(isFinalError(apiErr(403))).toBe(true);
    expect(isFinalError(apiErr(503))).toBe(false);
    expect(isFinalError(new Error("net"))).toBe(false);
  });
});

describe("restyle helpers", () => {
  it("formatClock is a tabular mm:ss clock", () => {
    expect(formatClock(402_000)).toBe("06:42");
    expect(formatClock(3_792_000)).toBe("1:03:12");
    expect(formatClock(null)).toBe("--:--");
  });
  it("outcome chips use the reference colours", () => {
    expect(OUTCOME.missing.tone).toBe("danger");
    expect(OUTCOME.named.tone).toBe("warning");
    expect(OUTCOME.cited.tone).toBe("success");
    expect(OUTCOME.act.tone).toBe("success");
    expect(OUTCOME.flag.tone).toBe("warning");
    expect(OUTCOME.drop.tone).toBe("neutral");
    expect(OUTCOME.failed.tone).toBe("danger");
    expect(itemChip(item({ kind: "page_read", outcome: null, status: "ok" }))).toEqual({ label: "Read", tone: "info" });
    expect(itemChip(item({ kind: "step", outcome: null, status: "info" }))).toBeNull();
  });
  it("cited-instead host counts only loaded engine answers", () => {
    const items = [
      item({ id: "a", detail: "Missing · cited instead: forum.example" }),
      item({ id: "b", detail: "Named · not cited; cited instead: shop.other", outcome: "named" }),
      item({ id: "c", detail: "Missing · cited instead: forum.example" }),
      item({ id: "d", detail: "Cited · me.example", outcome: "cited" }),
    ];
    expect(topCitedInstead(items)).toEqual({ host: "forum.example", count: 2, of: 3 });
    expect(topCitedInstead([item({ detail: "Missing" })])).toBeNull();
  });
  it("lane model from the newest stored call; progress; per-lane answers newest first", () => {
    const items = [
      item({ id: "call:1", kind: "provider_call", provider: "gemini", detail: "ok · gemini-old" }),
      item({ id: "call:2", kind: "provider_call", provider: "gemini", detail: "ok · gemini-new" }),
      item({ id: "obs:1", provider: "gemini" }),
      item({ id: "obs:2", provider: "perplexity" }),
      item({ id: "obs:3", provider: "gemini" }),
    ];
    expect(laneModel(items, "gemini")).toBe("gemini-new");
    expect(laneModel(items, "perplexity")).toBeNull();
    expect(laneAnswers(items, "gemini").map((i) => i.id)).toEqual(["obs:3", "obs:1"]);
    expect(laneProgress({ done: 7, planned: 12 })).toBeCloseTo(7 / 12);
    expect(laneProgress({ done: 7, planned: null })).toBeNull();
  });
  it("reading parts", () => {
    expect(readingParts("https://directpeptides.com/blog/x/")).toEqual({ host: "directpeptides.com", path: "directpeptides.com/blog/x/" });
    expect(readingParts("not a url").host).toBe("");
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FC = (props: any) => ReactElement | null;
// Web .tsx modules load dynamically (test tsconfig has no JSX); Vitest transforms them at runtime.
const load = async <T,>(rel: string): Promise<T> => (await import(/* @vite-ignore */ rel)) as T;
const view = await load<Record<string, FC>>("../src/web/components/activity/ActivityView.tsx");
const win = await load<Record<string, FC>>("../src/web/components/activity/ActivityWindow.tsx");
const render = (el: ReactElement) => renderToStaticMarkup(h(MemoryRouter, null, el));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");

describe("restyled render states", () => {
  const a = activity({
    items: [item({ id: "obs:1" }), item({ id: "obs:2", provider: "perplexity", title: "Perplexity answered", outcome: "cited", status: "ok", detail: "Cited" })],
  });
  const props = { activity: a, items: a.items.slice().reverse(), projectId: "p", now: Date.parse("2026-10-01T10:06:42Z"), replay: false, announcement: "" };
  it("expanded: lanes as columns with a scrollable answer strip each (queued greyed at the end), feed in two columns", () => {
    const html = render(h(view.ActivityBody!, { ...props, expanded: true }));
    const t = text(html);
    expect(t).toContain("06:42");
    expect(html).toContain('aria-label="Gemini answers, scrollable"');
    expect(html).toContain('aria-label="Perplexity answers, scrollable"');
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("sm:grid-cols-2");
    expect(t).toContain("Queued Perplexity");
    expect(t).not.toContain("Up next");
  });
  it("narrow: lanes stacked, queued strip, feed single column", () => {
    const html = render(h(view.ActivityBody!, { ...props, expanded: false }));
    expect(html).not.toContain("answers, scrollable");
    expect(text(html)).toContain("Up next · Queued (1)");
  });
  it("loading earlier events is visible while a backlog is paged in", () => {
    expect(text(render(h(view.ActivityBody!, { ...props, loadingEarlier: true })))).toContain("Loading earlier events…");
    expect(text(render(h(view.ActivityBody!, props)))).not.toContain("Loading earlier events");
  });
  it("feed cards carry a coloured left rail and the fresh animation class", () => {
    const html = render(h("ol", null, h(view.FeedItem!, { item: item(), fresh: true })));
    expect(html).toContain("border-l-red-500");
    expect(html).toContain("okara-activity-in");
    expect(html).toContain("line-clamp-2");
  });
  it("animations are wrapped in prefers-reduced-motion: no-preference", () => {
    const css = (view as unknown as { ACTIVITY_CSS: string }).ACTIVITY_CSS;
    expect(css).toMatch(/@media \(prefers-reduced-motion:no-preference\)\{\.okara-activity-in\{animation:okara-activity-in 200ms/);
    expect(css.indexOf(".okara-activity-ping{")).toBeGreaterThan(css.indexOf("no-preference"));
  });
  it("/activity/current failure shows an error with retry instead of loading forever", () => {
    const html = render(
      h(win.ActivityPanel!, { projectId: "p", isDemo: false, runs: null, runsError: new Error("boom"), onRetryRuns: () => {}, runId: null, onSelectRun: () => {}, onClose: () => {} }),
    );
    expect(text(html)).toContain("Could not load runs");
    expect(text(html)).not.toContain("Looking for runs");
  });
  it("expanded panel is 880px wide; the toggle is a pressed button hidden on phones", () => {
    const html = render(h(win.ActivityPanel!, { projectId: "p", isDemo: true, runs: [], runId: null, onSelectRun: () => {}, onClose: () => {}, defaultExpanded: true }));
    expect(html).toContain("sm:w-[880px]");
    expect(html).toMatch(/aria-pressed="true"[^>]*>Collapse/);
    expect(html).toContain("max-sm:hidden");
    expect(text(html).match(/Demo data/g)?.length).toBe(1);
  });
});
