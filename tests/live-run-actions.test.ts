/**
 * Live view section run controls (docs/live-view-design.md section 16): panel -> action mapping, labels,
 * disabled reasons (demo, running, quota, setup), confirm text, "Run all" menu, and rendered buttons (each
 * panel's button, none where there is no action), plus partial-run labels in the Activity window.
 */
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { TimelineEvent } from "../src/web/pages/live/engine";
import { buildTimeline } from "../src/web/pages/live/engine";
import {
  DEMO_REASON,
  QUOTA_REASON,
  geoPanelActions,
  manualRunsToday,
  runAllActions,
  seoPanelActions,
  type ActionEnv,
  type SectionAction,
} from "../src/web/pages/live/run-actions";
import { LINK_RUN_RATE_LIMIT } from "../src/worker/routes/links";
import { assessment, plan } from "./geo-batch-board-fixtures";
import { activity, at, coverageRow, evidenceRow, geoFeed, linkReport, overview, run, seoFeed, step, item } from "./live-web-fixtures";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FC = (props: any) => ReactElement | null;
const load = async <T,>(rel: string): Promise<T> => (await import(/* @vite-ignore */ rel)) as T;
const ra = await load<{
  PanelActionsContext: { Provider: FC };
  RunActionsProvider: FC;
  RunAllMenu: FC;
  SectionButton: FC;
  ConfirmDialog: FC;
  runBody: (s: { agent: string; steps: string[] | null; engines?: string[] }) => Record<string, unknown>;
}>("../src/web/pages/live/RunActions.tsx");
const { SeoBoard } = await load<Record<"SeoBoard", FC>>("../src/web/pages/live/SeoBoard.tsx");
const { GeoBoard } = await load<Record<"GeoBoard", FC>>("../src/web/pages/live/GeoBoard.tsx");
const { RunHeader } = await load<Record<"RunHeader", FC>>("../src/web/components/activity/ActivityView.tsx");

const render = (el: ReactElement) => renderToStaticMarkup(h(MemoryRouter, null, el));
const NONE: ReadonlySet<string> = new Set();
const st = <T,>(data: T | null) => ({ data, error: null, loading: data === null, reload: () => {}, setData: () => {} });

function env(over: Partial<ActionEnv> = {}): ActionEnv {
  return {
    projectId: "p1",
    demo: false,
    verifiedHost: "shop.example",
    gscProperty: "sc-domain:shop.example",
    running: { seo: false, geo: false },
    manualToday: 0,
    engines: [
      { provider: "gemini", name: "Gemini", ready: true, detail: null },
      { provider: "perplexity", name: "Perplexity", ready: false, detail: "Set PERPLEXITY_MODEL and a Perplexity key" },
    ],
    promptCount: 4,
    buyer: { state: "ready", labels: [] },
    links: { state: "ready", labels: [] },
    path: (sub) => `/projects/p1/${sub}`,
    ...over,
  };
}

const runOf = (a: SectionAction | undefined) => (a && a.kind === "run" ? a : null);

describe("panel -> action mapping (SEO)", () => {
  it("maps every SEO panel to its step, tool or approval flow", () => {
    const m = seoPanelActions(env());
    expect(Object.keys(m).sort()).toEqual(["ai-answers", "competitors", "coverage", "elements", "gsc", "links", "pages", "queries", "recs"].sort());
    expect(runOf(m.pages)?.runs).toEqual([{ agent: "seo", steps: ["crawl"] }]);
    expect(m.pages!.label).toBe("Run crawl");
    expect(runOf(m.gsc)?.runs).toEqual([{ agent: "seo", steps: ["gsc_sync"] }]);
    expect(runOf(m.elements)?.runs).toEqual([{ agent: "seo", steps: ["recommend"] }]);
    expect(runOf(m.recs)?.runs).toEqual([{ agent: "seo", steps: ["recommend"] }]);
    expect(runOf(m.coverage)?.runs).toEqual([{ agent: "geo", steps: ["batch"] }]);
    expect(runOf(m["ai-answers"])?.runs).toEqual([{ agent: "geo", steps: ["batch"] }]);
    expect(m.queries).toMatchObject({ kind: "call", path: "/projects/p1/seo/buyer-queries", reload: "buyer", label: "Classify queries" });
    expect(m.links).toMatchObject({ kind: "call", path: "/projects/p1/seo/internal-links/run", reload: "links" });
    // Competitor pages need the user's approval per URL: the button opens that flow, it never fetches.
    expect(m.competitors).toMatchObject({ kind: "link", to: "/projects/p1/geo/board" });
    for (const a of Object.values(m)) expect(a.disabled).toBeNull();
  });

  it("explains why an action is disabled: demo, running agent, quota, missing setup", () => {
    expect(seoPanelActions(env({ demo: true })).pages!.disabled).toBe(DEMO_REASON);
    expect(seoPanelActions(env({ demo: true })).links!.disabled).toBe(DEMO_REASON);
    const running = seoPanelActions(env({ running: { seo: true, geo: false } }));
    expect(running.pages!.disabled).toMatch(/^Running… a SEO run is in progress/);
    expect(running.pages!.busyLabel).toBe("Running…");
    expect(running.coverage!.disabled).toBeNull(); // the GEO agent is free
    expect(running.links!.disabled).toBeNull(); // standalone tool, not an agent run
    expect(seoPanelActions(env({ manualToday: 3 })).gsc!.disabled).toBe(QUOTA_REASON);
    expect(seoPanelActions(env({ manualToday: 3 })).queries!.disabled).toBeNull(); // not a manual run
    const setup = seoPanelActions(env({ verifiedHost: null, gscProperty: null, buyer: { state: "setup_required", labels: ["Connect Search Console first."] }, links: { state: "setup_required", labels: ["Run a crawl first."] } }));
    expect(setup.pages!.disabled).toMatch(/Verify site ownership first/);
    expect(setup.gsc!.disabled).toMatch(/Connect Search Console/);
    expect(setup.queries!.disabled).toBe("Connect Search Console first.");
    expect(setup.links!.disabled).toBe("Run a crawl first.");
    expect(seoPanelActions(env({ engines: [{ provider: "gemini", name: "Gemini", ready: false, detail: null }] })).coverage!.disabled).toMatch(/No AI engine is set up/);
  });

  it("confirm text says what is called and what it uses", () => {
    const m = seoPanelActions(env({ manualToday: 1 }));
    const crawl = m.pages as Extract<SectionAction, { kind: "run" }>;
    expect(crawl.confirm.title).toBe("Run crawl now?");
    expect(crawl.confirm.lines.join(" ")).toContain("Partial SEO run: crawl only");
    expect(crawl.confirm.lines.join(" ")).toContain("2 left today");
    const rec = m.recs as Extract<SectionAction, { kind: "run" }>;
    expect(rec.confirm.lines.join(" ")).toContain("latest stored crawl and Search Console sync");
    const links = m.links as Extract<SectionAction, { kind: "call" }>;
    expect(links.confirm.lines.join(" ")).toContain(`Limited to ${LINK_RUN_RATE_LIMIT.limit} per hour per project`);
  });
});

describe("panel -> action mapping (GEO)", () => {
  it("one action per engine column with its engine filter; no button for the latest answer or cited-instead", () => {
    const m = geoPanelActions(env(), ["gemini", "perplexity"]);
    expect(Object.keys(m).sort()).toEqual(["coverage", "heatmap", "lane:gemini", "lane:perplexity", "recs"]);
    expect(m["latest-answer"]).toBeUndefined();
    expect(m["cited-instead"]).toBeUndefined();
    const g = runOf(m["lane:gemini"])!;
    expect(g.label).toBe("Ask Gemini");
    expect(g.runs).toEqual([{ agent: "geo", steps: ["batch"], engines: ["gemini"] }]);
    expect(g.disabled).toBeNull();
    expect(g.confirm.lines[0]).toBe("Partial GEO run: ask 4 prompts × Gemini, then analyse each stored answer.");
    expect(g.confirm.lines[1]).toContain("uses your daily GEO budget");
    expect(m["lane:perplexity"]!.disabled).toBe("Perplexity is not set up: Set PERPLEXITY_MODEL and a Perplexity key");
    expect(runOf(m.recs)?.runs).toEqual([{ agent: "geo", steps: ["proposals"] }]);
    expect(runOf(m.heatmap)?.runs).toEqual([{ agent: "geo", steps: ["batch"] }]);
    // Unknown prompt count: no invented number.
    const unknown = runOf(geoPanelActions(env({ promptCount: null }), ["gemini"])["lane:gemini"])!;
    expect(unknown.confirm.lines[0]).toContain("your approved prompts (up to the per-run cap) × Gemini");
  });
});

describe("Run all menu", () => {
  it("offers SEO, GEO and both, with quota-aware reasons", () => {
    const items = runAllActions(env());
    expect(items.map((i) => i.label)).toEqual(["Run SEO agent (all steps)", "Run GEO agent (all steps)", "Run both"]);
    expect(runOf(items[2])!.runs).toEqual([
      { agent: "seo", steps: null },
      { agent: "geo", steps: null },
    ]);
    const two = runAllActions(env({ manualToday: 2 }));
    expect(two[0]!.disabled).toBeNull();
    expect(two[2]!.disabled).toBe("Needs 2 manual runs; 1 left today (3 per project per UTC day).");
    expect(runAllActions(env({ running: { seo: false, geo: true } }))[2]!.disabled).toMatch(/GEO run is in progress/);
    expect(runAllActions(env({ demo: true })).every((i) => i.disabled === DEMO_REASON)).toBe(true);
    expect(ra.runBody({ agent: "seo", steps: null })).toEqual({ agent: "seo" });
    expect(ra.runBody({ agent: "geo", steps: ["batch"], engines: ["gemini"] })).toEqual({ agent: "geo", steps: ["batch"], engines: ["gemini"] });
  });

  it("counts today's manual runs in UTC (the server's quota window)", () => {
    const now = new Date("2026-10-03T12:00:00Z");
    expect(manualRunsToday(null, now)).toBeNull();
    expect(
      manualRunsToday(
        [
          { trigger: "manual", createdAt: "2026-10-03T01:00:00.000Z" },
          { trigger: "schedule", createdAt: "2026-10-03T02:00:00.000Z" },
          { trigger: "manual", createdAt: "2026-10-02T23:59:00.000Z" },
        ],
        now,
      ),
    ).toBe(1);
  });

  it("renders a keyboard-accessible menu button and the confirm dialog", () => {
    const html = render(h(ra.RunActionsProvider, { projectId: "p1", onStarted: () => {}, onReload: () => {} }, h(ra.RunAllMenu, { actions: runAllActions(env()) })));
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Run all");
    const dlg = render(h(ra.ConfirmDialog, { action: runOf(geoPanelActions(env(), ["gemini"])["lane:gemini"]), busy: false, error: null, onCancel: () => {}, onConfirm: () => {} }));
    expect(dlg).toContain('role="alertdialog"');
    expect(dlg).toContain("Ask Gemini now?");
    expect(dlg).toContain("Start run");
    expect(dlg).toContain("Cancel");
  });
});

// ------------------------------------------------------------------ rendered boards
function seoBoardHtml(actions: Record<string, SectionAction> | null) {
  const a = activity();
  const feed = seoFeed();
  const tl = buildTimeline(a.items, { elements: feed.elements, queries: feed.queries, recommendations: feed.recommendations });
  const board = h(SeoBoard, {
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
    seo: feed,
    feedError: null,
    data: {
      overview: st(overview()),
      buyer: st({ state: "ready", generatedAt: at(0), rows: [], completeness: null, labels: [] }),
      links: st(linkReport()),
      competitors: st([assessment()]),
      coverage: st({ state: "ready", generatedAt: at(0), rows: [coverageRow()], completeness: null, labels: [] }),
      evidence: st({ state: "ready", generatedAt: at(0), rows: [evidenceRow()], completeness: null, labels: [] }),
    },
  });
  const inner = actions ? h(ra.PanelActionsContext.Provider, { value: actions }, board) : board;
  return render(h(ra.RunActionsProvider, { projectId: "p1", onStarted: () => {}, onReload: () => {} }, inner));
}

/** The markup of one panel (from its data-panel attribute to the next panel). */
function panel(html: string, id: string): string {
  const i = html.indexOf(`data-panel="${id}"`);
  if (i < 0) return "";
  const j = html.indexOf("data-panel=", i + 10);
  return html.slice(i, j < 0 ? undefined : j);
}

describe("rendered panel buttons", () => {
  it("SEO board: each panel header carries its button and label", () => {
    const html = seoBoardHtml(seoPanelActions(env()));
    const expectBtn = (id: string, key: string, label: string) => {
      const p = panel(html, id);
      expect(p, id).toContain(`data-action="${key}"`);
      expect(p, id).toContain(label);
    };
    expectBtn("pages", "crawl", "Run crawl");
    expectBtn("gsc", "gsc_sync", "Run Search Console sync");
    expectBtn("queries", "classify", "Classify queries");
    expectBtn("elements", "recommend-judge", "Run judging");
    expectBtn("competitors", "competitors", "Review pages to approve");
    expectBtn("coverage", "geo-batch-coverage", "Ask AI engines");
    expectBtn("ai-answers", "geo-batch-answers", "Ask AI engines");
    expectBtn("links", "links", "Run link analysis");
    expectBtn("recs", "recommend-draft", "Run drafting");
    // The approval flow is a link, never a fetch.
    expect(panel(html, "competitors")).toMatch(/<a [^>]*data-action="competitors"[^>]*href="\/projects\/p1\/geo\/board"/);
  });

  it("disabled buttons stay focusable with the reason as tooltip and description", () => {
    const html = seoBoardHtml(seoPanelActions(env({ running: { seo: true, geo: false } })));
    const p = panel(html, "pages");
    expect(p).toContain('aria-disabled="true"');
    expect(p).toContain("Running…");
    expect(p).toMatch(/title="Running… a SEO run is in progress/);
    expect(p).not.toMatch(/<button[^>]*\sdisabled=""/);
    const demo = seoBoardHtml(seoPanelActions(env({ demo: true })));
    expect(panel(demo, "gsc")).toContain(DEMO_REASON);
  });

  it("no actions in context -> no buttons (existing renders unchanged)", () => {
    expect(seoBoardHtml(null)).not.toContain("data-action=");
  });

  it("GEO board: a button per engine column, none on the latest answer or cited-instead panels", () => {
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
    const actions = geoPanelActions(
      env({ engines: [{ provider: "gemini", name: "Gemini", ready: true, detail: null }, { provider: "openai_geo", name: "OpenAI", ready: false, detail: "Set OPENAI_GEO_MODEL" }] }),
      ["gemini", "openai_geo"],
    );
    const board = h(GeoBoard, {
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
        board: st({ state: "ready", promptSetVersion: 1, generatedAt: at(0), lanes: [], labels: [] }),
        competitors: st([assessment()]),
        plans: st({ state: "ready", generatedAt: at(0), plans: [plan()], labels: [] }),
        coverage: st({ state: "ready", generatedAt: at(0), rows: [coverageRow()], completeness: null, labels: [] }),
      },
    });
    const html = render(h(ra.RunActionsProvider, { projectId: "p1", onStarted: () => {}, onReload: () => {} }, h(ra.PanelActionsContext.Provider, { value: actions }, board)));
    expect(html).toContain('data-action="lane:gemini"');
    expect(html).toContain("Ask Gemini");
    expect(html).toMatch(/data-action="lane:openai_geo"[^>]*aria-disabled="true"[^>]*title="OpenAI is not set up: Set OPENAI_GEO_MODEL"/);
    expect(panel(html, "heatmap")).toContain('data-action="geo-batch-heatmap"');
    expect(panel(html, "recs")).toContain('data-action="proposals"');
    expect(panel(html, "latest-answer")).not.toContain("data-action=");
    expect(panel(html, "cited-instead")).not.toContain("data-action=");
  });
});

describe("partial runs in the Activity window", () => {
  it("shows the partial-run label next to the trigger", () => {
    const a = activity({ run: run({ scope: { steps: ["crawl"], engines: null } }) });
    const html = render(h(RunHeader, { activity: a, items: [], now: Date.parse(at(60)), replay: false }));
    expect(html).toContain("Partial run: crawl only");
  });
});
