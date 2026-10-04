/**
 * [A37] "From Search Console" question queries, web side: pure helpers (counts, selection limits, position and
 * landing-page text, provenance notes), the GEO prompts page panel (collapsed count, table, setup / disabled /
 * empty states, unsaved-changes guard, plain text for hostile queries) and Live GEO 12 (rows, review link, setup).
 */
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { GscQuestionCandidate, GscQuestionsResponse } from "../src/shared/gsc-questions";
import { GEO_CONTAINERS } from "../src/web/pages/live/more/registry";
import {
  addedFor,
  addedNoteText,
  countHeadline,
  landingPath,
  positionText,
  selectTop,
  selectionLimit,
  syncText,
  toggleKey,
} from "../src/web/pages/geo/gsc-questions-lib";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FC = (props: any) => ReactElement | null;
const load = async <T,>(rel: string): Promise<T> => (await import(/* @vite-ignore */ rel)) as T;
const panel = await load<Record<"GscQuestionsPanel" | "PromptGscNote", FC>>("../src/web/pages/geo/GscQuestionsPanel.tsx");
const live = await load<Record<"GscQuestionsLivePanel", FC>>("../src/web/pages/live/more/GscQuestionsContainer.tsx");

const render = (el: ReactElement) => renderToStaticMarkup(h(MemoryRouter, null, el));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ");
const HOSTILE = '<script>alert("x")</script><img src=x onerror=alert(1)>';
const WINDOW = { start: "2026-08-30", end: "2026-09-26" };

function cand(query: string, impressions: number, over: Partial<GscQuestionCandidate> = {}): GscQuestionCandidate {
  return {
    key: query,
    text: query.charAt(0).toUpperCase() + query.slice(1) + "?",
    promptType: "discovery",
    rules: ["wh_start"],
    evidence: { source: "gsc", query, impressions, clicks: 7, position: 8.25, landingPage: "https://shop.example.com/blogs/care/clean-brass", window: WINDOW, syncId: "gsync_1", syncedAt: "2026-10-03T06:00:00.000Z", syncSource: "api" },
    variants: [],
    ...over,
  };
}

function resp(over: Partial<GscQuestionsResponse> = {}): GscQuestionsResponse {
  const candidates = [cand("how to clean brass knobs", 400, { variants: [{ query: "how to clean the brass knobs", impressions: 50 }] }), cand("what is unlacquered brass", 300), cand(`best brass pulls ${HOSTILE}`, 120, { rules: ["best"], promptType: "reputation", text: `Best brass pulls ${HOSTILE}` })];
  return {
    state: "ready",
    message: null,
    methodVersion: "gsc-questions-en-2026-10-04.1",
    sync: { id: "gsync_1", source: "api", syncedAt: "2026-10-03T06:00:00.000Z", window: WINDOW, status: "completed", truncated: false },
    labels: ["Search Console, stored sync 2026-10-03, window 2026-08-30..2026-09-26", "1 brand query left out."],
    candidates,
    counts: { rowsRead: 900, queries: 400, questionQueries: 20, brandExcluded: 1, alreadyInSet: 2, removedEarlier: 0, mergedDuplicates: 1, eligible: 12 },
    cap: 50,
    includeBrand: false,
    promptSet: { id: "gps_1", version: 3, size: 23, room: 2, max: 25 },
    added: [{ key: "does brass tarnish outdoors", text: "Does brass tarnish outdoors?", status: "in_set", addedAt: "2026-10-03T07:00:00.000Z", evidence: { ...cand("does brass tarnish outdoors", 80).evidence, clicks: 4, position: 7 } }],
    ...over,
  };
}

const panelProps = (over: Record<string, unknown> = {}) => ({
  projectId: "p1", data: resp(), error: null, loading: false, onReload: () => {}, includeBrand: false, onIncludeBrand: () => {}, setId: "gps_1", dirty: false, onAdded: () => {}, defaultOpen: true, ...over,
});

describe("gsc questions lib", () => {
  it("counts, sync text, position and landing page", () => {
    expect(countHeadline(resp())).toBe("12 new question queries from Search Console");
    expect(countHeadline(resp({ counts: { ...resp().counts, eligible: 1 } }))).toBe("1 new question query from Search Console");
    expect(countHeadline(resp({ counts: { ...resp().counts, eligible: 0 } }))).toBe("No new question queries from Search Console");
    expect(countHeadline(resp({ state: "setup_required" }))).toBeNull();
    expect(syncText(resp())).toBe("stored sync 2026-10-03 · window 2026-08-30..2026-09-26");
    expect(positionText(8.25)).toBe("8.3");
    expect(positionText(null)).toBe("—");
    expect(landingPath("https://shop.example.com/blogs/care?x=1")).toBe("/blogs/care?x=1");
    expect(landingPath(null)).toBe("—");
  });
  it("selection never exceeds the room left in the set (and 25 per request)", () => {
    expect(selectionLimit(2)).toBe(2);
    expect(selectionLimit(40)).toBe(25);
    expect(selectionLimit(-1)).toBe(0);
    let s = toggleKey(new Set(), "a", 2);
    s = toggleKey(s, "b", 2);
    s = toggleKey(s, "c", 2);
    expect([...s]).toEqual(["a", "b"]);
    expect([...toggleKey(s, "a", 2)]).toEqual(["b"]);
    expect([...selectTop(["a", "b", "c"], 2)]).toEqual(["a", "b"]);
  });
  it("provenance notes match prompts by prompt key", () => {
    const a = addedFor(resp().added, "does brass tarnish outdoors");
    expect(a?.text).toBe("Does brass tarnish outdoors?");
    expect(addedFor(resp().added, "Something else?")).toBeNull();
    expect(addedNoteText(a!)).toBe("Search query “does brass tarnish outdoors”: 80 impressions · 4 clicks · avg. position 7.0 in 2026-08-30..2026-09-26 (stored sync 2026-10-03).");
  });
});

describe("GEO prompts page: From Search Console panel", () => {
  it("collapsed: shows the count and the stored sync, not the table", () => {
    const html = render(h(panel.GscQuestionsPanel, panelProps({ defaultOpen: false })));
    const t = text(html);
    expect(t).toContain("12 new question queries from Search Console");
    expect(t).toContain("Search Console, stored sync 2026-10-03 · window 2026-08-30..2026-09-26");
    expect(html).not.toContain('data-testid="gsc-question-row"');
    expect(html).toContain('aria-expanded="false"');
  });
  it("open: table with impressions, clicks, position, landing page, checkboxes and the add button; hostile text stays plain", () => {
    const html = render(h(panel.GscQuestionsPanel, panelProps()));
    const t = text(html);
    expect((html.match(/data-testid="gsc-question-row"/g) ?? []).length).toBe(3);
    expect((html.match(/type="checkbox"/g) ?? []).length).toBe(4); // 3 rows + "include brand"
    expect(t).toContain("How to clean brass knobs?");
    expect(t).toContain("+1 similar");
    expect(t).toContain("400");
    expect(t).toContain("8.3");
    expect(t).toContain("/blogs/care/clean-brass");
    expect(t).toContain("Reputation (names a tracked brand)");
    expect(t).toContain("room for 2 more in the set");
    expect(t).toContain("Showing the top 3 of 12 by impressions.");
    expect(t).toContain("Add selected as prompts");
    expect(t).toContain("Select top 2");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(t).toContain(HOSTILE);
  });
  it("unsaved edits block adding; full set says so", () => {
    const dirty = render(h(panel.GscQuestionsPanel, panelProps({ dirty: true })));
    expect(text(dirty)).toContain("Save or discard your edits");
    const full = text(render(h(panel.GscQuestionsPanel, panelProps({ data: resp({ promptSet: { id: "gps_1", version: 3, size: 25, room: 0, max: 25 } }) }))));
    expect(full).toContain("The prompt set is full (25 prompts)");
  });
  it("setup, disabled and empty states", () => {
    const setup = render(h(panel.GscQuestionsPanel, panelProps({ data: resp({ state: "setup_required", message: "No Search Console data is stored yet.", sync: null, candidates: [] }) })));
    expect(text(setup)).toContain("Connect Search Console in Integrations");
    expect(setup).toContain('href="/projects/p1/integrations"');
    const off = text(render(h(panel.GscQuestionsPanel, panelProps({ data: resp({ state: "disabled", message: "Question detection uses an English word list.", candidates: [] }) }))));
    expect(off).toContain("Question detection uses an English word list.");
    const empty = render(h(panel.GscQuestionsPanel, panelProps({ data: resp({ candidates: [], counts: { ...resp().counts, eligible: 0 } }) })));
    expect(empty).toContain('data-testid="gsc-questions-empty"');
    expect(text(empty)).toContain("No new question queries from Search Console");
    const loading = text(render(h(panel.GscQuestionsPanel, panelProps({ data: null, loading: true }))));
    expect(loading).toContain("Reading your stored Search Console queries");
  });
  it("prompt provenance note", () => {
    const t = text(render(h(panel.PromptGscNote, { note: resp().added[0] })));
    expect(t).toContain("From Search Console:");
    expect(t).toContain("80 impressions");
    expect(render(h(panel.PromptGscNote, { note: null }))).toBe("");
  });
});

describe("Live GEO 12: Question queries from Search Console", () => {
  const st = (d: GscQuestionsResponse | null) => ({ data: d, error: null, loading: d === null });
  it("is registered as GEO 12 (10 and 11 keep their numbers)", () => {
    const def = GEO_CONTAINERS.find((c) => c.key === "gsc-questions")!;
    expect(def).toMatchObject({ num: "12", title: "Question queries from Search Console", more: true });
    expect(GEO_CONTAINERS.find((c) => c.key === "sheet-prompts")!.num).toBe("10");
    expect(GEO_CONTAINERS.find((c) => c.key === "budget")!.num).toBe("11");
  });
  it("lists the top candidates with a review link and no run button", () => {
    const html = render(h(live.GscQuestionsLivePanel, { state: st(resp()), reduced: false, projectId: "p1", replaying: false }));
    const t = text(html);
    expect(html).toContain('data-panel="gsc-questions"');
    expect(t).toContain("12 Question queries from Search Console");
    expect((html.match(/data-testid="gsc-question-live-row"/g) ?? []).length).toBe(3);
    expect(t).toContain("↗ Review on GEO prompts");
    expect(html).toContain('href="/projects/p1/geo/prompts#from-search-console"');
    expect(t).toContain("From your latest Search Console sync");
    expect(t).toContain("Showing 3 of 12.");
    expect(html).not.toContain("data-action=");
    expect(html).not.toContain("<script>");
  });
  it("setup and replay captions", () => {
    const setup = render(h(live.GscQuestionsLivePanel, { state: st(resp({ state: "setup_required", message: "No Search Console data is stored yet.", sync: null, candidates: [] })), reduced: false, projectId: "p1", replaying: false }));
    expect(setup).toContain('href="/projects/p1/integrations"');
    const replay = text(render(h(live.GscQuestionsLivePanel, { state: st(resp()), reduced: false, projectId: "p1", replaying: true })));
    expect(replay).toContain("not replayed");
  });
});
