/**
 * Activity window: server-rendered markup from contract fixtures (no live calls, no DOM). Checks the
 * header/counters/lanes/queued/feed content, honesty labels, plain-text rendering of untrusted text,
 * the finished state with links, accessibility hooks, and that no rate or projection is rendered.
 */
import { readFileSync } from "node:fs";
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { activity, item } from "./activity-web-fixtures";

// Web .tsx modules load dynamically (test tsconfig has no JSX); Vitest transforms them at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FC = (props: any) => ReactElement | null;
const load = async <T,>(rel: string): Promise<T> => (await import(/* @vite-ignore */ rel)) as T;
const view = await load<Record<"ActivityBody" | "FeedItem" | "Feed" | "QueuedCards" | "Lanes", FC>>("../src/web/components/activity/ActivityView.tsx");
const win = await load<Record<"ActivityLauncher" | "ActivityPanel", FC>>("../src/web/components/activity/ActivityWindow.tsx");
const bus = await load<{ openActivity: (r: { projectId: string; runId?: string }) => void; onOpenActivity: (fn: (r: unknown) => void) => () => void }>(
  "../src/web/components/activity/bus.ts",
);

const render = (el: ReactElement) => renderToStaticMarkup(h(MemoryRouter, null, el));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const NOW = Date.parse("2026-10-01T10:07:12Z");

function body(a = activity(), over: Record<string, unknown> = {}) {
  return render(
    h(view.ActivityBody, {
      activity: a,
      items: a.items.slice().reverse(),
      projectId: "proj1",
      now: NOW,
      replay: false,
      announcement: "",
      ...over,
    }),
  );
}

describe("ActivityBody (active GEO run)", () => {
  const html = body();
  const t = text(html);
  it("header: agent, status chip with live dot, trigger, big mm:ss elapsed, spend with labels, call count", () => {
    expect(t).toContain("GEO run");
    expect(t).toContain("Running");
    expect(html).toContain("okara-activity-ping");
    expect(t).toContain("Manual");
    expect(t).toContain("Elapsed");
    expect(t).toContain("07:12");
    expect(html).toContain("tabular-nums");
    expect(t).toContain("Spend so far $0.162");
    expect(t).toContain("Estimate · 2 calls with unknown cost");
    expect(t).toContain("Calls 14");
    expect(t).toContain("Live from this run's stored events");
  });
  it("stat row: citing (green) / skipping (red) / cited instead from loaded answers", () => {
    expect(t).toContain("Answers citing you 3");
    expect(t).toContain("+1 named, not cited");
    expect(t).toContain("Answers skipping you 9");
    expect(t).toContain("1 failed");
    expect(html).toContain("text-emerald-600");
    expect(html).toContain("text-red-600");
    expect(t).toContain("Cited instead forum.example");
    expect(t).toContain("in 1 of 1 loaded answers");
    expect(t).toContain("2 act · 1 flag · 4 drop");
  });
  it("lane cards: initial badge, short name, server label, state chip, progress, latency; queued", () => {
    expect(t).toContain("Gemini");
    expect(t).toContain("Asking & reading");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="5"');
    expect(t).toContain("5 of 12");
    expect(t).toContain("last 190 ms");
    expect(t).toContain("Queued (1)");
    expect(t).toContain("API-sampled");
  });
  it("renders untrusted prompt text as plain text", () => {
    expect(html).not.toContain("<b>linen</b>");
    expect(html).toContain("&lt;b&gt;linen&lt;/b&gt;");
  });
  it("feed: titled Live feed; list is a non-live log, announcements go to a sibling sr-only status", () => {
    expect(t).toContain("Live feed");
    expect(html).toMatch(/<p role="status" aria-live="polite" class="sr-only">/);
    expect(html).toContain('role="log" aria-live="off"');
    // The status region is not inside the log.
    const log = html.slice(html.indexOf('role="log"'));
    expect(log).not.toContain('aria-live="polite"');
  });
  it("feed card: latency top-left, outcome chip, kind + cost meta", () => {
    expect(t).toContain("Engine answer");
    expect(t).toContain("227 ms");
    expect(t).toContain("~$0.0012 est.");
    expect(t).toContain("Missing");
    expect(t).toContain('Gemini answered: "best linen sofa"');
  });
  it("shows no rates, projections or scores", () => {
    expect(t.toLowerCase()).not.toMatch(/prompts ?\/ ?sec|per second|projected|forecast|score/);
  });
});

describe("ActivityBody (SEO crawl)", () => {
  it("shows Now reading and page progress", () => {
    const a = activity({
      run: { ...activity().run, agent: "seo" },
      lanes: [],
      queued: [],
      totals: { ...activity().totals, pagesRead: 12, pagesPlanned: 50, answers: { cited: 0, named: 0, missing: 0, failed: 0 } },
      nowReading: { url: "https://shop.example/blog/linen", at: "2026-10-01T10:07:00Z" },
      items: [item({ id: "snap:1", kind: "page_read", provider: "crawler", title: "Read /blog/linen", detail: "200 · 1,240 words", url: "https://shop.example/blog/linen", outcome: null, status: "ok", costUsd: null, latencyMs: 340 })],
    });
    const t = text(body(a));
    expect(t).toContain("Last page read · shop.example");
    expect(t).toContain("shop.example/blog/linen");
    expect(t).toContain("Pages read 12 of 50 planned");
    expect(t).toContain("Read");
    expect(t).toContain("200 · 1,240 words");
    expect(t).not.toContain("Answers");
    expect(t).not.toContain("API-sampled");
  });
});

describe("ActivityBody (finished replay)", () => {
  const a = activity({
    active: false,
    run: { ...activity().run, status: "completed", finishedAt: "2026-10-01T10:07:12Z", elapsedMs: 432_000 },
    nowReading: { url: "https://x.example/", at: "2026-10-01T10:00:00Z" },
  });
  const html = body(a, { replay: true });
  const t = text(html);
  it("final duration, Last run label, links to Runs and AI engines; no queued/now reading", () => {
    expect(t).toContain("Run finished in 7m 12s");
    expect(t).toContain("Duration");
    expect(t).toContain("Last run");
    expect(html).toContain('href="/projects/proj1/runs"');
    expect(html).toContain('href="/projects/proj1/geo/board"');
    expect(html).toContain('href="/projects/proj1/runs/run1"');
    expect(t).not.toContain("Queued (");
    expect(t).not.toContain("Last page read");
    expect(t).not.toContain("Live from this run");
    expect(t).toContain("Replay");
    expect(t).toContain("07:12");
  });
});

describe("FeedItem", () => {
  it("unknown cost is labelled Unknown, never $0", () => {
    const t = text(render(h("ol", null, h(view.FeedItem, { item: item({ kind: "provider_call", costUsd: null, outcome: null }) }))));
    expect(t).toContain("Unknown");
    expect(t).not.toContain("$0");
  });
  it("fresh items get the slide-in class", () => {
    expect(render(h("ol", null, h(view.FeedItem, { item: item(), fresh: true })))).toContain("okara-activity-in");
  });
  it("empty feed message", () => {
    expect(text(render(h(view.Feed, { items: [], announcement: "" })))).toContain("No stored events for this run yet.");
  });
});

describe("Launcher + panel shell", () => {
  it("launcher renders an Activity button announcing a dialog", () => {
    const html = render(h(win.ActivityLauncher, { projectId: "proj1", isDemo: false }));
    expect(html).toContain("Activity");
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
  });
  it("panel: labelled dialog, close button, demo note, empty state", () => {
    const html = render(h(win.ActivityPanel, { projectId: "proj1", isDemo: true, runs: [], runId: null, onSelectRun: () => {}, onClose: () => {} }));
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-label="Close activity window"');
    expect(text(html)).toContain("Demo data");
    expect(text(html)).toContain("No runs yet");
    expect(html).toContain("sm:w-[460px]");
    expect(html).toContain("sm:top-[var(--okara-activity-top)]");
    expect(html).toContain("Expand");
    expect(html).toContain("prefers-reduced-motion");
  });
  it("panel: run chooser when several runs are listed", () => {
    const runs = [
      { id: "a", agent: "seo", status: "running" },
      { id: "b", agent: "geo", status: "pending" },
    ];
    const t = text(render(h(win.ActivityPanel, { projectId: "proj1", isDemo: false, runs, runId: "a", onSelectRun: () => {}, onClose: () => {} })));
    expect(t).toContain("SEO · Running");
    expect(t).toContain("GEO · Pending");
  });
});

describe("bus + wiring", () => {
  it("openActivity reaches subscribers until unsubscribed", () => {
    const got: unknown[] = [];
    const off = bus.onOpenActivity((r) => got.push(r));
    bus.openActivity({ projectId: "p", runId: "r" });
    off();
    bus.openActivity({ projectId: "p" });
    expect(got).toEqual([{ projectId: "p", runId: "r" }]);
  });
  it("RunNowButton opens the window for the started run; project shell mounts the launcher", () => {
    const btn = readFileSync(new URL("../src/web/components/RunNowButton.tsx", import.meta.url), "utf8");
    expect(btn).toContain("openActivity({ projectId, runId: run.id, opener })");
    const shell = readFileSync(new URL("../src/web/layouts/ProjectLayout.tsx", import.meta.url), "utf8");
    expect(shell).toContain("<ActivityLauncher");
    expect(shell).toContain("topAnchor={activityTop}");
    expect(shell).toMatch(/data-activity-top-anchor[^\n]*\n\s*\{project\.isDemo && <DemoBanner \/>\}/);
  });
  it("activity module never renders HTML from strings", () => {
    for (const f of ["ActivityView.tsx", "ActivityWindow.tsx"]) {
      const src = readFileSync(new URL(`../src/web/components/activity/${f}`, import.meta.url), "utf8");
      expect(src).not.toContain("dangerouslySetInnerHTML");
    }
  });
});
