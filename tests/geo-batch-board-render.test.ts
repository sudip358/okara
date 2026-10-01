/**
 * AI engines board: server-rendered markup from contract fixtures (no live calls, no DOM). Checks lane
 * setup/empty states, honesty labels, plain-text rendering of untrusted text, the confirm-gated approval,
 * the radar + table fallback, the IndexNow label, and that no simulated/projected element is rendered.
 */
import { readFileSync, readdirSync } from "node:fs";
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiErrorBody } from "../src/shared/types";
import { assessment, plan, readyLane, setupLane, skipFactors } from "./geo-batch-board-fixtures";

/*
 * Web modules are loaded dynamically: the test tsconfig (tsconfig.worker.json) has no JSX or DOM lib, so a
 * static import of .tsx files would fail `npm run typecheck`. Vitest transforms them normally at runtime.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FC = (props: any) => ReactElement | null;
const load = async <T,>(rel: string): Promise<T> => (await import(/* @vite-ignore */ rel)) as T;
const board = await load<Record<"EngineColumn", FC>>("../src/web/pages/geo/board/EngineColumn.tsx");
const header = await load<Record<"CitationGauge" | "LaneHeader", FC>>("../src/web/pages/geo/board/LaneHeader.tsx");
const comp = await load<Record<"AssessmentCard" | "CompetitorBody", FC>>("../src/web/pages/geo/board/CompetitorPanel.tsx");
const plansMod = await load<Record<"RewritePlanCard", FC>>("../src/web/pages/geo/board/RewritePlansPanel.tsx");
const skipMod = await load<Record<"FactorRow", FC>>("../src/web/pages/geo/board/SkipFactorsPanel.tsx");
const feedMod = await load<Record<"FeedCard", FC>>("../src/web/pages/geo/board/PromptFeed.tsx");
const pageMod = await load<Record<"EngineBoardPage", FC>>("../src/web/pages/geo/EngineBoardPage.tsx");
const dataMod = await load<{ approvalErrorMessage: (e: unknown) => string; boardPaths: Record<"board" | "competitorPages" | "rewritePlans", (p: string) => string> }>(
  "../src/web/pages/geo/board/data.ts",
);
const apiMod = await load<{
  ApiError: new (status: number, body: ApiErrorBody) => Error;
  api: (path: string, init?: { method?: string; body?: unknown }) => Promise<unknown>;
  setCsrfToken: (t: string | null, userId?: string | null) => void;
}>("../src/web/lib/api.ts");
const { EngineColumn } = board;
const { CitationGauge, LaneHeader } = header;
const { AssessmentCard, CompetitorBody } = comp;
const { RewritePlanCard } = plansMod;
const { FactorRow } = skipMod;
const { FeedCard } = feedMod;
const { EngineBoardPage } = pageMod;
const { approvalErrorMessage, boardPaths } = dataMod;
const { ApiError, api, setCsrfToken } = apiMod;
type EngineColumnProps = Record<string, unknown>;

const render = (el: ReactElement) => renderToStaticMarkup(h(MemoryRouter, null, el));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

const listState = <T,>(data: T) => ({ data, error: null, loading: false, reload: () => {} });
function column(over: Partial<EngineColumnProps> = {}): string {
  const props: EngineColumnProps = {
    projectId: "proj1",
    lane: readyLane(),
    compact: false,
    competitors: listState([assessment()]),
    plans: listState([plan()]),
    skipInputs: { coverage: null, pages: null, loading: false, error: null, reload: () => {} },
    onNeedSkipInputs: () => {},
    onApproved: () => {},
    ...over,
  };
  return render(h(EngineColumn, props));
}

const BANNED = [/simulated/i, /\/\s*10\b/, /citability/i, /\btraffic\b/i, /revenue/i, /conv\.? ?rate/i, /\bsteal\b/i, /\bpublish\b(?!ing: manual)/i, /chatgpt/i, /prompts ?\/ ?sec/i];

describe("lane header", () => {
  it("shows the gauge text and an accessible label", () => {
    const html = render(h(CitationGauge, { rate: { numerator: 21, denominator: 100, value: 0.21 } }));
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Citation rate 21%: 21 of 100 valid answers cited your site"');
    expect(text(html)).toContain("21% · 21 of 100");
  });
  it("shows exact model, grounding, stats and cost basis", () => {
    const t = text(render(h(LaneHeader, { lane: readyLane(), showMetrics: true })));
    expect(t).toContain("gemini-test-model");
    expect(t).toContain("google_search");
    expect(t).toContain("API-sampled");
    expect(t).toContain("Answers citing us 109");
    expect(t).toContain("Answers skipping us 380");
    expect(t).toContain("rival.example");
    expect(t).toContain("~$0.31 est.");
    expect(t).toContain("Estimate (versioned rates)");
    expect(t).toContain("38 engine searches captured");
  });
});

describe("lane states", () => {
  it("setup_required keeps the header, shows the reason, no gauge and no zeros", () => {
    const html = column({ lane: setupLane("openai_geo") });
    const t = text(html);
    expect(t).toContain("OpenAI");
    expect(t).toContain("Model not set");
    expect(t).toContain("Connect OpenAI to sample answers");
    expect(t).toContain("Not implemented yet");
    expect(html).toContain('href="/projects/proj1/integrations"');
    expect(html).not.toContain('role="img"');
    expect(t).not.toContain("Answers citing us");
    expect(t).not.toContain("$0");
  });
  it("disabled, error and no-answers states", () => {
    expect(text(column({ lane: readyLane({ state: "disabled" }) }))).toContain("Turned off for this project");
    const err = column({ lane: readyLane({ state: "error", stateDetail: "Web search is not enabled for this Anthropic organization" }) });
    expect(err).toContain('role="alert"');
    expect(text(err)).toContain("Web search is not enabled for this Anthropic organization");
    const none = text(column({ lane: readyLane({ promptsRun: 0 }) }));
    expect(none).toContain("No answers yet");
    expect(none).toContain("Approve prompts, then run GEO.");
  });
});

describe("ready lane (desktop)", () => {
  const html = column();
  const t = text(html);
  it("renders the four sections with honest labels", () => {
    expect(t).toContain("523 prompts answered by Gemini");
    expect(t).toContain("Latest cohort · API-sampled");
    expect(t).toMatch(/1 prompt where Gemini skips you/);
    expect(t).toContain("Pages Gemini cites: what they do");
    expect(t).toContain("Pages to rewrite for Gemini");
    expect(t).toContain("Manual plan · Publishing: manual (not connected)");
  });
  it("feed cards: status, latency, position, sentiment, cited instead", () => {
    expect(t).toContain("Missing");
    expect(t).toContain("Named");
    expect(t).toContain("Cited");
    expect(t).toContain("377 ms");
    expect(t).toContain("#2 in list");
    expect(t).toContain("Sentiment Positive");
    expect(html).toContain('title="Method: deterministic+jev"');
    expect(t).toContain("rival.example via");
    expect(html).toContain('role="list"');
  });
  it("renders untrusted text as plain text", () => {
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<b>bold</b>");
  });
  it("radar is decorative and the table is the accessible fallback", () => {
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"[^>]*viewBox="-22 0 164 120"|<svg[^>]*viewBox="-22 0 164 120"[^>]*aria-hidden="true"/);
    expect(html).toContain("<table");
    expect(t).toContain("yes-probability 0.91");
    expect(t).toContain("Jev judgment");
    expect(t).toContain("Adapt");
    expect(t).toContain("never copy their text");
  });
  it("contains no simulated, projected or scored element", () => {
    for (const re of BANNED) expect(t, String(re)).not.toMatch(re);
  });
});

describe("compact (mobile) lane", () => {
  it("is a details element with B-D as tabs and no radar", () => {
    const html = column({ compact: true, defaultOpen: true });
    expect(html).toMatch(/^<details[^>]*open/);
    expect(html).toContain('role="tablist"');
    const t = text(html);
    for (const tab of ["Prompts", "Our pages", "Cited pages", "Plans"]) expect(t).toContain(tab);
    expect(html).not.toContain('viewBox="-22 0 164 120"');
  });
});

describe("competitor panel", () => {
  it("offers 'Assess this page' for cited URLs not yet read, and never fetches without confirmation", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const html = render(h(CompetitorBody, { projectId: "proj1", lane: readyLane(), all: [], assessments: [], showRadar: true, onApproved: () => {} }));
    const t = text(html);
    expect(t).toContain("Assess this page");
    expect(t).toContain("https://rival.example/best-widgets/");
    expect(t).not.toContain("Okara will fetch this one page once"); // only after the first click
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("hides candidates already assessed", () => {
    const t = text(render(h(CompetitorBody, { projectId: "p", lane: readyLane(), all: [assessment({ url: "https://rival.example/best-widgets/" })], assessments: [], showRadar: true, onApproved: () => {} })));
    expect(t).not.toContain("Assess this page");
  });
  it("blocked / pending / Jev-not-configured assessments", () => {
    expect(text(render(h(AssessmentCard, { a: assessment({ state: "blocked", stateDetail: "robots.txt disallows", verdict: null, checks: [] }), showRadar: true })))).toContain("robots.txt disallows");
    expect(text(render(h(AssessmentCard, { a: assessment({ state: "fetching", verdict: null, checks: [] }), showRadar: true })))).toContain("Reading page");
    const t = text(render(h(AssessmentCard, { a: assessment({ checks: [{ key: "entity", label: "Entity facts", noul: null, tier: null, method: "jev", detail: null }] }), showRadar: false })));
    expect(t).toContain("Not run");
    expect(t).not.toContain("Jev not configured");
  });
});

describe("skip factors and plans", () => {
  it("factor rows show measured text, method, and the cited-page column; no percentages", () => {
    const f = skipFactors().factors[0]!;
    const t = text(render(h("ul", null, h(FactorRow, { f }))));
    expect(t).toContain("answer at word 180");
    expect(t).toContain("Heuristic");
    expect(t).toContain("Cited page: present · answer at word 30");
    expect(t).not.toMatch(/\d+%/);
  });
  it("plan card: checklist, IndexNow scope, measured GSC and citations, no Publish", () => {
    const html = render(h(RewritePlanCard, { plan: plan(), projectId: "proj1" }));
    const t = text(html);
    expect(t).toContain("Submit to IndexNow (Bing and participating engines, not Google) · optional");
    expect(t).toContain("Clicks 12 · Impressions 1,268");
    expect(t).toContain("Cited in 3 stored answers");
    expect(t).toContain("Check this yourself");
    expect(t).not.toContain("Check this yourself · Check this yourself");
    expect(t).toContain("1 of 4 done");
    expect(html).toContain('href="/projects/proj1/recommendations/rec1"');
    for (const re of BANNED) expect(t, String(re)).not.toMatch(re);
    const none = text(render(h(RewritePlanCard, { plan: plan({ gsc: null, aiCitations: null }), projectId: "p" })));
    expect(none).toContain("GSC not connected");
    expect(none).toContain("No GEO data");
  });
  it("feed card without an observation is not a button", () => {
    const html = render(h(FeedCard, { item: readyLane().feed[3]!, onOpen: () => {} }));
    expect(html).not.toContain("<button");
    expect(text(html)).toContain("Not run");
  });
});

describe("page and data", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("page renders the loading state on the server", () => {
    vi.stubGlobal("fetch", vi.fn());
    const html = renderToStaticMarkup(
      h(MemoryRouter, { initialEntries: ["/projects/p1/geo/board"] }, h(Routes, null, h(Route, { path: "/projects/:projectId/geo/board", element: h(EngineBoardPage) }))),
    );
    expect(text(html)).toContain("AI engines");
    expect(text(html)).toContain("Loading AI engines");
  });
  it("paths are the documented endpoints", () => {
    expect(boardPaths.board("p 1")).toBe("/projects/p%201/geo/board");
    expect(boardPaths.competitorPages("p")).toBe("/projects/p/geo/competitor-pages");
    expect(boardPaths.rewritePlans("p")).toBe("/projects/p/geo/rewrite-plans");
  });
  it("approval POST goes through api() with JSON body and CSRF header", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ data: assessment({ state: "queued" }) }), { status: 202, headers: { "Content-Type": "application/json" } });
    });
    setCsrfToken("tok", "u1");
    const a = await api(boardPaths.competitorPages("p"), { method: "POST", body: { url: "https://rival.example/x" } });
    setCsrfToken(null);
    expect((a as { state: string }).state).toBe("queued");
    expect(calls[0]!.url).toBe("/api/projects/p/geo/competitor-pages");
    expect((calls[0]!.init.headers as Record<string, string>)["X-CSRF-Token"]).toBe("tok");
    expect(calls[0]!.init.body).toBe(JSON.stringify({ url: "https://rival.example/x" }));
  });
  it("approval errors map to plain messages", () => {
    expect(approvalErrorMessage(new ApiError(400, { code: "bad_request", message: "x", details: { reason: "url_not_cited" } }))).toMatch(/not among the citations/);
    expect(approvalErrorMessage(new ApiError(429, { code: "budget_exceeded", message: "x" }))).toMatch(/budget/i);
    expect(approvalErrorMessage(new ApiError(429, { code: "rate_limited", message: "x" }))).toMatch(/10 pages per project per hour/);
    expect(approvalErrorMessage(new ApiError(500, { code: "internal", message: "Boom" }))).toBe("Boom");
  });
});

describe("source rules", () => {
  const dir = new URL("../src/web/pages/geo/board/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx")).map((f) => [f, readFileSync(new URL(f, dir), "utf8")] as const);
  files.push(["EngineBoardPage.tsx", readFileSync(new URL("../src/web/pages/geo/EngineBoardPage.tsx", import.meta.url), "utf8")]);
  it("no HTML injection, no hard-coded colours, no simulated/projection wording", () => {
    for (const [f, s] of files) {
      expect(s, f).not.toContain("dangerouslySetInnerHTML");
      expect(s, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b(?![\w-])/);
      expect(s, f).not.toMatch(/rgb\(|hsl\(/);
      const code = s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, f).not.toMatch(/Simulated|citability|\/10\b|Publish\b|Steal|Copy text/);
    }
  });
  it("route and nav entry are registered", () => {
    expect(readFileSync(new URL("../src/web/App.tsx", import.meta.url), "utf8")).toContain('path: "geo/board"');
    expect(readFileSync(new URL("../src/web/layouts/ProjectLayout.tsx", import.meta.url), "utf8")).toContain('{ to: "geo/board", label: "AI engines" }');
  });
});
