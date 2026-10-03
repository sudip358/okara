/**
 * Pure helpers of the Live view project containers (src/worker/live/insights-lib.ts): the striking-distance
 * thresholds, gainers and losers, brand counts, cited-domain grouping and the prompt-history grid. No database.
 */
import { describe, expect, it } from "vitest";
import type { BrandDef } from "@worker/geo/detect";
import {
  STRIKING_DISTANCE,
  brandTable,
  engineOrder,
  groupCitedDomains,
  historyCell,
  inStrikingDistance,
  pageMovers,
  promptHistoryGrid,
  sinceIso,
  strikingRows,
  type HistoryObservation,
  type PageWindowGroup,
} from "@worker/live/insights-lib";

describe("striking distance", () => {
  it("is one exported constant: positions 8 to 20 inclusive, at least one impression, 50 rows", () => {
    expect(STRIKING_DISTANCE).toEqual({ minPosition: 8, maxPosition: 20, minImpressions: 1, maxRows: 50 });
  });
  it("includes both edges and excludes rows outside or without impressions", () => {
    expect(inStrikingDistance({ position: 8, impressions: 1 })).toBe(true);
    expect(inStrikingDistance({ position: 20, impressions: 1 })).toBe(true);
    expect(inStrikingDistance({ position: 7.99, impressions: 100 })).toBe(false);
    expect(inStrikingDistance({ position: 20.01, impressions: 100 })).toBe(false);
    expect(inStrikingDistance({ position: 12, impressions: 0 })).toBe(false);
    expect(inStrikingDistance({ position: Number.NaN, impressions: 10 })).toBe(false);
  });
  it("sorts by impressions (then query, page), caps the list and joins the same query+page of the previous window", () => {
    const cur = [
      { query: "b", page: "/1", clicks: 1, impressions: 50, position: 9 },
      { query: "a", page: "/2", clicks: 2, impressions: 50, position: 10 },
      { query: "c", page: "/3", clicks: 0, impressions: 900, position: 30 },
      { query: "d", page: "/4", clicks: 4, impressions: 80, position: 19.4 },
    ];
    const prev = [{ query: "a", page: "/2", clicks: 7, impressions: 70, position: 14.444 }, { query: "a", page: "/9", clicks: 1, impressions: 1, position: 1 }];
    const rows = strikingRows(cur, prev);
    expect(rows.map((r) => r.query)).toEqual(["d", "a", "b"]);
    expect(rows[1]).toMatchObject({ ctr: 0.04, previous: { clicks: 7, impressions: 70, position: 14.44 } });
    expect(rows[2]!.previous).toBeNull();
    expect(strikingRows(cur, prev, { ...STRIKING_DISTANCE, maxRows: 1 })).toHaveLength(1);
  });
});

describe("pages gaining and losing clicks", () => {
  const g = (page: string, cur: number | null, prev: number | null): PageWindowGroup => ({
    page,
    inCur: cur !== null,
    inPrev: prev !== null,
    cur: { clicks: cur ?? 0, impressions: (cur ?? 0) * 10, wpos: (cur ?? 0) * 10 * 4, wimp: (cur ?? 0) * 10 },
    prev: { clicks: prev ?? 0, impressions: (prev ?? 0) * 10, wpos: (prev ?? 0) * 10 * 6, wimp: (prev ?? 0) * 10 },
  });
  it("ranks only pages in both windows; new and lost pages are counted, never ranked", () => {
    const m = pageMovers([g("/up", 50, 10), g("/up2", 30, 10), g("/down", 1, 40), g("/same", 5, 5), g("/new", 900, null), g("/lost", null, 900)], 8);
    expect(m.gainers.map((x) => [x.page, x.clickDelta])).toEqual([
      ["/up", 40],
      ["/up2", 20],
    ]);
    expect(m.losers.map((x) => [x.page, x.clickDelta])).toEqual([["/down", -39]]);
    expect(m.counts).toEqual({ both: 4, unchanged: 1, newPages: 1, lostPages: 1 });
    expect(m.gainers[0]).toMatchObject({ current: { clicks: 50, impressions: 500, position: 4 }, previous: { clicks: 10, impressions: 100, position: 6 } });
  });
  it("breaks ties by current (gainers) or previous (losers) clicks, then page; caps each list", () => {
    const m = pageMovers([g("/b", 20, 10), g("/a", 20, 10), g("/c", 30, 20), g("/x", 10, 20), g("/y", 30, 40)], 2);
    expect(m.gainers.map((x) => x.page)).toEqual(["/c", "/a"]);
    expect(m.losers.map((x) => x.page)).toEqual(["/y", "/x"]);
  });
  it("position is null without impressions (never 0)", () => {
    const m = pageMovers([{ page: "/z", inCur: true, inPrev: true, cur: { clicks: 1, impressions: 0, wpos: 0, wimp: 0 }, prev: { clicks: 0, impressions: 0, wpos: 0, wimp: 0 } }]);
    expect(m.gainers[0]!.current.position).toBeNull();
  });
});

describe("brands", () => {
  it("puts your brand first, then competitors by answers naming them; totals are sums of n and m", () => {
    const t = brandTable(
      [
        { provider: "gemini", brandKey: "Zed", isSelf: false, answers: 4, mentioned: 1, cited: 0, recommended: 0, negative: 0 },
        { provider: "gemini", brandKey: "self", isSelf: true, answers: 4, mentioned: 2, cited: 1, recommended: 1, negative: 1 },
        { provider: "openai_geo", brandKey: "self", isSelf: true, answers: 2, mentioned: 2, cited: 0, recommended: 0, negative: 0 },
        { provider: "gemini", brandKey: "Acme", isSelf: false, answers: 4, mentioned: 3, cited: 1, recommended: 2, negative: 0 },
      ],
      { self: "Shop" },
    );
    expect(t.engines).toEqual(["openai_geo", "gemini"]);
    expect(t.brands.map((b) => b.name)).toEqual(["Shop", "Acme", "Zed"]);
    expect(t.brands[0]!.engines.map((e) => e.provider)).toEqual(["openai_geo", "gemini"]);
    expect(t.brands[0]!.total).toEqual({ answers: 6, mentioned: 4, cited: 1, recommended: 1, negative: 1 });
  });
});

describe("most-cited domains", () => {
  const brands: BrandDef[] = [
    { key: "self", isSelf: true, name: "Shop", aliases: [], domains: ["shop.example.com"] },
    { key: "Acme", isSelf: false, name: "Acme", aliases: [], domains: ["acme.example"] },
  ];
  const redirect = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/xyz";
  it("groups by resolved host (www. folded, redirect links by bare-domain title), counts distinct answers, tags brands", () => {
    const r = groupCitedDomains(
      [
        { observationId: "o1", provider: "gemini", url: "https://www.reviews.example/a", title: null, sourceType: "review_site" },
        { observationId: "o1", provider: "gemini", url: "https://reviews.example/b", title: null, sourceType: "publisher" },
        { observationId: "o2", provider: "perplexity", url: "https://reviews.example/c", title: null, sourceType: "review_site" },
        { observationId: "o2", provider: "perplexity", url: redirect, title: "acme.example", sourceType: "bogus" },
        { observationId: "o3", provider: "gemini", url: redirect, title: "Not a domain title", sourceType: "other" },
        { observationId: "o3", provider: "gemini", url: "https://blog.shop.example.com/x", title: null, sourceType: "brand_page" },
      ],
      brands,
    );
    expect(r.answersWithCitations).toBe(3);
    expect(r.unresolved).toBe(1);
    expect(r.totalHosts).toBe(3);
    expect(r.rows[0]).toMatchObject({ host: "reviews.example", answers: 2, citations: 3, engines: ["gemini", "perplexity"], sourceTypes: ["review_site", "publisher"], brand: null, rank: 1 });
    expect(r.rows.find((x) => x.host === "acme.example")).toMatchObject({ brand: { key: "Acme", isSelf: false }, sourceTypes: ["other"] });
    expect(r.rows.find((x) => x.host === "blog.shop.example.com")!.brand).toEqual({ key: "self", isSelf: true });
    expect(r.own).toBeNull();
  });
  it("returns your row separately when it ranks below the listed hosts", () => {
    const rows = [
      ...Array.from({ length: 3 }, (_, i) => ({ observationId: `o${i}`, provider: "gemini", url: `https://top${i}.example/`, title: null, sourceType: "other" })),
      ...Array.from({ length: 3 }, (_, i) => ({ observationId: `o${i}`, provider: "gemini", url: `https://top${i}.example/b`, title: null, sourceType: "other" })),
      { observationId: "o5", provider: "gemini", url: "https://top0.example/c", title: null, sourceType: "other" },
      { observationId: "o9", provider: "gemini", url: "https://shop.example.com/p", title: null, sourceType: "brand_page" },
    ];
    const r = groupCitedDomains(rows, brands, 2);
    expect(r.rows.map((x) => x.host)).toEqual(["top0.example", "top1.example"]);
    expect(r.own).toMatchObject({ host: "shop.example.com", rank: 4, brand: { key: "self", isSelf: true } });
  });
});

describe("prompt history", () => {
  const obs = (runId: string, provider: string, text: string, o: Partial<HistoryObservation> = {}): HistoryObservation => ({
    runId,
    provider,
    promptText: text,
    status: "ok",
    analysed: true,
    selfCited: false,
    selfMentioned: false,
    createdAt: "2026-09-30T00:00:00.000Z",
    ...o,
  });
  it("maps stored outcomes to cells (cited / named / missing / failed / not analysed)", () => {
    expect(historyCell({ status: "ok", analysed: true, selfCited: true, selfMentioned: true })).toBe("cited");
    expect(historyCell({ status: "ok", analysed: true, selfCited: false, selfMentioned: true })).toBe("named");
    expect(historyCell({ status: "ok", analysed: true, selfCited: false, selfMentioned: false })).toBe("missing");
    expect(historyCell({ status: "failed", analysed: false, selfCited: false, selfMentioned: false })).toBe("failed");
    expect(historyCell({ status: "incomplete", analysed: true, selfCited: true, selfMentioned: true })).toBe("failed");
    expect(historyCell({ status: "ok", analysed: false, selfCited: false, selfMentioned: false })).toBe("not_analysed");
  });
  it("keeps each engine's newest runs (oldest first), matches prompts by text, and fills 'none'", () => {
    const runs = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, createdAt: `2026-09-${String(10 + i).padStart(2, "0")}T00:00:00.000Z` }));
    const observations = [
      ...runs.map((r, i) => obs(r.id, "gemini", "Best knobs", { selfCited: i % 2 === 0 })),
      obs("r9", "openai_geo", "best knobs?", { selfMentioned: true }),
      obs("r9", "openai_geo", "Other prompt", { status: "failed", analysed: false }),
      obs("unknown-run", "gemini", "Best knobs", { selfCited: true }),
    ];
    const g = promptHistoryGrid([{ id: "p1", text: "Best knobs?" }, { id: "p2", text: "Never asked" }], observations, runs, 8);
    expect(g.engines.map((e) => e.provider)).toEqual(["openai_geo", "gemini"]);
    expect(g.engines[1]!.runs.map((r) => r.runId)).toEqual(["r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9"]);
    expect(g.rows[0]!.cells.gemini).toEqual(["cited", "missing", "cited", "missing", "cited", "missing", "cited", "missing"]);
    expect(g.rows[0]!.cells.openai_geo).toEqual(["named"]);
    expect(g.rows[1]!.cells.gemini).toEqual(Array(8).fill("none"));
  });
  it("uses the newest stored answer when a run stored several for the pair", () => {
    const runs = [{ id: "r1", createdAt: "2026-09-01T00:00:00.000Z" }];
    const g = promptHistoryGrid(
      [{ id: "p", text: "Q" }],
      [obs("r1", "gemini", "Q", { status: "failed", analysed: false, createdAt: "2026-09-01T00:00:01.000Z" }), obs("r1", "gemini", "Q", { selfCited: true, createdAt: "2026-09-01T00:00:05.000Z" })],
      runs,
    );
    expect(g.rows[0]!.cells.gemini).toEqual(["cited"]);
  });
});

describe("small helpers", () => {
  it("orders engines like the Live lanes (board order, then others by id)", () => {
    expect(engineOrder(["perplexity", "custom_geo:b", "gemini", "openai_geo", "custom_geo:a"])).toEqual(["openai_geo", "gemini", "perplexity", "custom_geo:a", "custom_geo:b"]);
  });
  it("windows are measured back from now", () => {
    expect(sinceIso(new Date("2026-10-03T12:00:00.000Z"), 30)).toBe("2026-09-03T12:00:00.000Z");
  });
});
