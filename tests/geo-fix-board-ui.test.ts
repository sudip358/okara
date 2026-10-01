/**
 * Board UI follow-up fixes: retryable failed approvals, neutral "Not run" Jev text, run polling + reload
 * on finish, no top-bar total cost, lane cost label, "Measured from crawl" label, feed card accessible name.
 * Server-rendered markup only (no DOM); hooks are stubbed so the page can render with data.
 */
import { readFileSync } from "node:fs";
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompetitorCheck, RunSummary } from "../src/shared/types";
import { approvalCandidates, checkResultText, runIsActive, runJustFinished } from "../src/web/pages/geo/board/lib";
import { assessment, board, readyLane, setupLane, skipFactors } from "./geo-batch-board-fixtures";

type ApiState = { data: unknown; error: null; loading: boolean; reload: () => void; setData: (d: unknown) => void };
const hookState = vi.hoisted(() => ({
  responses: new Map<string, unknown>(),
  reloads: new Map<string, number>(),
  polls: [] as Array<{ fn: () => void; active: boolean; ms: number | undefined }>,
}));

vi.mock("@web/lib/hooks", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    useApi: (path: string | null): ApiState => {
      const key = path ?? "";
      return {
        data: path && hookState.responses.has(key) ? hookState.responses.get(key) : null,
        error: null,
        loading: false,
        reload: () => hookState.reloads.set(key, (hookState.reloads.get(key) ?? 0) + 1),
        setData: () => {},
      };
    },
    usePolling: (fn: () => void, active: boolean, ms?: number) => {
      hookState.polls.push({ fn, active, ms });
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FC = (props: any) => ReactElement | null;
const load = async <T,>(rel: string): Promise<T> => (await import(/* @vite-ignore */ rel)) as T;
const { EngineBoardPage } = await load<Record<"EngineBoardPage", FC>>("../src/web/pages/geo/EngineBoardPage.tsx");
const { LaneHeader } = await load<Record<"LaneHeader", FC>>("../src/web/pages/geo/board/LaneHeader.tsx");
const { AssessmentCard } = await load<Record<"AssessmentCard", FC>>("../src/web/pages/geo/board/CompetitorPanel.tsx");
const { FactorRow } = await load<Record<"FactorRow", FC>>("../src/web/pages/geo/board/SkipFactorsPanel.tsx");
const { FeedCard } = await load<Record<"FeedCard", FC>>("../src/web/pages/geo/board/PromptFeed.tsx");

const render = (el: ReactElement) => renderToStaticMarkup(h(MemoryRouter, null, el));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

const geoRun = (status: RunSummary["status"]): RunSummary => ({
  id: "run1",
  agent: "geo",
  trigger: "manual",
  status,
  createdAt: "2026-09-30T10:00:00Z",
  startedAt: "2026-09-30T10:00:01Z",
  finishedAt: status === "pending" || status === "running" ? null : "2026-09-30T10:02:00Z",
  error: null,
  summary: {},
});

function renderPage(runs: RunSummary[], lanes = board().lanes): string {
  hookState.responses.set("/projects/p1/geo/board", { ...board(), lanes });
  hookState.responses.set("/projects/p1/runs", runs);
  hookState.responses.set("/projects/p1/geo/rewrite-plans", { plans: [] });
  hookState.responses.set("/projects/p1/geo/competitor-pages", []);
  return renderToStaticMarkup(
    h(MemoryRouter, { initialEntries: ["/projects/p1/geo/board"] }, h(Routes, null, h(Route, { path: "/projects/:projectId/geo/board", element: h(EngineBoardPage) }))),
  );
}
const boardPoll = () => hookState.polls.find((p) => p.ms === 8000);

beforeEach(() => {
  hookState.responses.clear();
  hookState.reloads.clear();
  hookState.polls.length = 0;
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe("approval candidates: failed reads can be retried", () => {
  const feed = readyLane().feed;
  const url = "https://rival.example/best-widgets/";
  it("failed assessments do not hide the URL", () => {
    expect(approvalCandidates(feed, [assessment({ url, state: "failed", verdict: null, checks: [] })]).map((c) => c.url)).toEqual([url]);
  });
  it("assessed, queued, fetching and blocked stay excluded", () => {
    for (const state of ["assessed", "queued", "fetching", "blocked"] as const) {
      expect(approvalCandidates(feed, [assessment({ url, state })]), state).toEqual([]);
    }
  });
  it("a failed row next to an assessed row for the same URL stays excluded", () => {
    expect(approvalCandidates(feed, [assessment({ url, state: "failed" }), assessment({ id: "a2", url, state: "assessed" })])).toEqual([]);
  });
});

describe("checkResultText is neutral for Jev checks that did not run", () => {
  const c = (over: Partial<CompetitorCheck>): CompetitorCheck => ({ key: "entity", label: "Entity facts", noul: null, tier: null, method: "jev", detail: null, ...over });
  it("never claims Jev is not configured", () => {
    expect(checkResultText(c({}))).toBe("Not run");
    expect(checkResultText(c({ detail: "daily budget reached" }))).toBe("Not run · daily budget reached");
    expect(checkResultText(c({ noul: 0.91, tier: "act", detail: "named in first paragraph" }))).toBe("named in first paragraph");
  });
  it("assessment card shows the neutral text and the stateDetail reason", () => {
    const t = text(
      render(h(AssessmentCard, { a: assessment({ stateDetail: "Jev daily budget reached", checks: [{ key: "entity", label: "Entity facts", noul: null, tier: null, method: "jev", detail: null }] }), showRadar: false })),
    );
    expect(t).toContain("Not run");
    expect(t).not.toContain("Jev not configured");
    expect(t).toContain("Jev daily budget reached");
  });
});

describe("run polling helpers", () => {
  it("active only while pending or running", () => {
    expect(runIsActive(geoRun("pending"))).toBe(true);
    expect(runIsActive(geoRun("running"))).toBe(true);
    for (const s of ["completed", "failed", "partial", "cancelled", "rate_limited", "setup_required"] as const) expect(runIsActive({ status: s })).toBe(false);
    expect(runIsActive(null)).toBe(false);
  });
  it("just finished only on an active -> finished transition", () => {
    expect(runJustFinished(true, geoRun("completed"))).toBe(true);
    expect(runJustFinished(true, geoRun("failed"))).toBe(true);
    expect(runJustFinished(true, geoRun("running"))).toBe(false);
    expect(runJustFinished(false, geoRun("completed"))).toBe(false);
    expect(runJustFinished(true, null)).toBe(false);
  });
});

describe("EngineBoardPage", () => {
  it("polls runs, board and plans every 8 s while the latest GEO run is running", () => {
    renderPage([geoRun("running")]);
    const p = boardPoll();
    expect(p?.active).toBe(true);
    p!.fn();
    expect(hookState.reloads.get("/projects/p1/runs")).toBe(1);
    expect(hookState.reloads.get("/projects/p1/geo/board")).toBe(1);
    expect(hookState.reloads.get("/projects/p1/geo/rewrite-plans")).toBe(1);
  });
  it("polls while pending, and not once the run finished", () => {
    renderPage([geoRun("pending")]);
    expect(boardPoll()?.active).toBe(true);
    hookState.polls.length = 0;
    renderPage([geoRun("completed")]);
    expect(boardPoll()?.active).toBe(false);
    hookState.polls.length = 0;
    renderPage([]);
    expect(boardPoll()?.active).toBe(false);
  });
  it("reloads board and plans once when the run finishes (effect wired to the transition helper)", () => {
    const src = readFileSync("src/web/pages/geo/EngineBoardPage.tsx", "utf8");
    expect(src).toMatch(/runJustFinished\(wasActive\.current, run\)\)\s*\{\s*board\.reload\(\);\s*plans\.reload\(\);/);
    expect(src).toContain("wasActive.current = active");
  });
  it("has no top-bar total cost, even when no lane has run", () => {
    const t = text(renderPage([geoRun("completed")], [setupLane("openai_geo"), readyLane({ promptsRun: 0, costUsd: { value: null, isEstimate: false } })]));
    expect(t).toContain("Last GEO run");
    expect(t).not.toContain("Cost of latest cohorts");
    expect(t).not.toContain("Unknown (Unknown)");
  });
});

describe("labels and accessible names", () => {
  it("lane cost is labelled as the latest cohort", () => {
    const t = text(render(h(LaneHeader, { lane: readyLane(), showMetrics: true })));
    expect(t).toContain("Cost (latest cohort)");
    expect(t).not.toContain("Cost so far");
  });
  it("measured skip factors say 'Measured from crawl'; heuristic ones say 'Heuristic'", () => {
    const base = skipFactors().factors[0]!;
    const measured = text(render(h("ul", null, h(FactorRow, { f: { ...base, method: "measured" } }))));
    expect(measured).toContain("Measured from crawl");
    expect(text(render(h("ul", null, h(FactorRow, { f: { ...base, method: "heuristic" } }))))).toContain("Heuristic");
  });
  it("feed card button keeps its visible content as the name, with an sr-only suffix", () => {
    const item = { ...readyLane().feed[0]!, sentiment: { value: "positive" as const, method: "deterministic+jev" } };
    const html = render(h(FeedCard, { item, onOpen: () => {} }));
    const button = html.match(/<button[^>]*>/)![0];
    expect(button).not.toContain("aria-label");
    expect(html).toContain('<span class="sr-only">Open the raw answer</span>');
    const t = text(html);
    expect(t).toContain("rival.example via");
    expect(t).toContain("377 ms");
  });
});
