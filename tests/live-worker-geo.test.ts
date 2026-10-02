import { describe, expect, it } from "vitest";
import type { LiveGeoBoardResponse } from "@shared/types";
import { DEMO_LABEL } from "@worker/demo/fixtures";
import { seedDemoProject } from "@worker/demo/seed";
import { insertStatement, type Db } from "@worker/lib/db";
import { newId } from "@worker/lib/ids";
import { buildLiveGeo, decodeLiveGeoCursor, encodeLiveGeoCursor } from "@worker/live/geo-board";
import { encodeLiveSeoCursor } from "@worker/live/seo-board";
import { OBS_HOLD_MS } from "@worker/runs/activity";
import { FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";
import { caller, ORIGIN, seedCrawl, seedGsc, seedPage, seedRec, seedRun, setup, t } from "./live-worker-seed";

type Ctx = Awaited<ReturnType<typeof setup>>;
/** Seconds before FIXED_NOW (inside the observation hold window when small). */
const ago = (sec: number) => new Date(FIXED_NOW.getTime() - sec * 1000).toISOString();

async function seedPromptSet(db: Db, ws: string, pid: string, n: number, active = 1) {
  const setId = newId("gps");
  await db.insert("geo_prompt_sets", { id: setId, workspace_id: ws, project_id: pid, version: 1, active, created_at: t(-100) });
  const prompts: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = newId("gp");
    prompts.push(id);
    await db.insert("geo_prompts", {
      id, workspace_id: ws, project_id: pid, prompt_set_id: setId, text: `best oak table ${i}`, prompt_type: "discovery", locale: "en-US", language: "en", approved: 1, position: i,
    });
  }
  return { setId, prompts };
}

interface ObsSeed {
  id?: string;
  provider?: string;
  promptId?: string | null;
  setId?: string | null;
  text?: string;
  status?: string;
  at: string;
  cost?: number | null;
  estimate?: 0 | 1;
  latency?: number | null;
  usage?: Record<string, unknown>;
  /** self brand row; omitted = not analysed */
  self?: { mentioned: 0 | 1; cited: 0 | 1; rank?: number | null; sentiment?: string; status?: string; method?: string };
  citations?: Array<{ url: string; position: number | null; sourceType?: string; title?: string | null }>;
  queries?: string[];
  /** default 1 */
  grounded?: 0 | 1;
}

async function seedObs(db: Db, ws: string, pid: string, runId: string, o: ObsSeed) {
  const id = o.id ?? newId("obs");
  const req = `req-${id}`;
  const S: Array<[string, ...unknown[]]> = [];
  S.push(insertStatement("geo_observations", {
    id, workspace_id: ws, project_id: pid, run_id: runId, prompt_id: o.promptId ?? null, prompt_set_id: o.setId ?? null, prompt_text: o.text ?? "best oak table",
    prompt_type: "discovery", cohort_key: "c1", provider: o.provider ?? "gemini", model: "m", grounding_mode: "g", measurement_type: "api",
    status: o.status ?? "ok", grounded: o.grounded ?? 1, request_id: req, usage_json: JSON.stringify(o.usage ?? {}), cost_usd: o.cost ?? null, cost_is_estimate: o.estimate ?? 1,
    error: null, created_at: o.at,
  }));
  S.push(insertStatement("provider_calls", {
    id: newId("call"), workspace_id: ws, project_id: pid, run_id: runId, provider: o.provider ?? "gemini", model: "m", purpose: "geo_answer", status: "ok",
    request_id: req, cost_usd: o.cost ?? null, cost_is_estimate: 1, latency_ms: o.latency ?? null, created_at: o.at,
  }));
  if (o.self) S.push(selfRow(ws, pid, id, o.self));
  for (const c of o.citations ?? []) {
    S.push(insertStatement("geo_citations", {
      id: newId("cit"), workspace_id: ws, project_id: pid, observation_id: id, url: c.url, host: new URL(c.url).hostname, title: c.title ?? null, position: c.position,
      source_type: c.sourceType ?? "other", source_type_method: "rule",
    }));
  }
  for (const q of o.queries ?? []) {
    S.push(insertStatement("geo_search_queries", { id: newId("gsq"), workspace_id: ws, project_id: pid, observation_id: id, provider: o.provider ?? "gemini", model: "m", query: q, normalized: q.toLowerCase(), created_at: o.at }));
  }
  await db.batch(S);
  return id;
}

function selfRow(ws: string, pid: string, observationId: string, s: NonNullable<ObsSeed["self"]>) {
  return insertStatement("geo_brand_observations", {
    id: newId("gbo"), workspace_id: ws, project_id: pid, observation_id: observationId, brand_key: "self", is_self: 1, mentioned: s.mentioned, cited: s.cited,
    recommendation_status: s.status ?? (s.mentioned ? "recommended" : "not_mentioned"), list_rank: s.rank ?? null, sentiment: s.sentiment ?? (s.mentioned ? "positive" : "not_applicable"),
    method: s.method ?? "deterministic",
  });
}

const build = async (ctx: Ctx, run: string, after: string | null = null, limit = 200, now = FIXED_NOW) =>
  (await buildLiveGeo(ctx.db, ctx.p, run, { now, limit, after: decodeLiveGeoCursor(after) }))!;

describe("GET /projects/:pid/live/geo: access and input", () => {
  it("404s across tenants and projects, 400s on SEO runs and on foreign cursors", async () => {
    const ctx = await setup();
    const other = await seedUser(ctx.env);
    const pOther = await seedProject(ctx.env, other.workspaceId);
    const runOther = await seedRun(ctx.db, other.workspaceId, pOther, "geo", "completed");
    const pSibling = await seedProject(ctx.env, ctx.ws);
    const runSibling = await seedRun(ctx.db, ctx.ws, pSibling, "geo", "completed");
    const geo = await seedRun(ctx.db, ctx.ws, ctx.pid, "geo", "completed");
    const seo = await seedRun(ctx.db, ctx.ws, ctx.pid, "seo", "completed");
    await seedObs(ctx.db, other.workspaceId, pOther, runOther, { at: t(10), self: { mentioned: 1, cited: 1 } });
    const call = caller(ctx.env, ctx.u);
    expect((await call(`/projects/${pOther}/live/geo?runId=${runOther}`)).status).toBe(404);
    expect((await call(`/projects/${ctx.pid}/live/geo?runId=${runOther}`)).status).toBe(404);
    expect((await call(`/projects/${ctx.pid}/live/geo?runId=${runSibling}`)).status).toBe(404);
    expect((await call(`/projects/${ctx.pid}/live/geo`)).json.error.details).toEqual({ field: "runId" });
    const mismatch = await call(`/projects/${ctx.pid}/live/geo?runId=${seo}`);
    expect(mismatch.status).toBe(400);
    expect(mismatch.json.error.details).toEqual({ reason: "agent_mismatch" });
    expect((await call(`/projects/${ctx.pid}/live/geo?runId=${geo}&after=${encodeLiveSeoCursor({ d: 0, f: 0, r: 0 })}`)).status).toBe(400);
    expect((await call(`/projects/${ctx.pid}/live/geo?runId=${geo}&limit=0`)).status).toBe(400);
    const ok = await call(`/projects/${ctx.pid}/live/geo?runId=${geo}`);
    expect(ok.status).toBe(200);
    expect(ok.json.data).toMatchObject({ answers: [], recommendations: [], cursor: null, plannedPrompts: null, totals: { lanes: [], truncated: false } });
  });

  it("round-trips the cursor, including the bounded list of answers awaiting analysis", () => {
    const c = { o: 5, r: 2, p: [3, 4] };
    expect(decodeLiveGeoCursor(encodeLiveGeoCursor(c))).toEqual(c);
    expect(decodeLiveGeoCursor(encodeLiveGeoCursor({ o: 1, r: 0, p: [] }))).toEqual({ o: 1, r: 0 });
    const b64u = (v: unknown) => btoa(JSON.stringify(v)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    for (const bad of [b64u({ o: 1, r: 0, p: [1, -2] }), b64u({ o: 1, r: 0, p: "1" }), b64u({ o: 1, r: 0, p: Array.from({ length: 21 }, (_, i) => i) }), b64u({ o: 1 })]) {
      expect(() => decodeLiveGeoCursor(bad)).toThrow();
    }
  });
});

describe("live GEO feed: answers", () => {
  it("returns each stored answer with its stored fields only", async () => {
    const ctx = await setup();
    const run = await seedRun(ctx.db, ctx.ws, ctx.pid, "geo", "completed");
    const { setId, prompts } = await seedPromptSet(ctx.db, ctx.ws, ctx.pid, 3);
    const cited = await seedObs(ctx.db, ctx.ws, ctx.pid, run, {
      promptId: prompts[0], setId, at: t(10), cost: 0.0012, estimate: 0, latency: 377, usage: { searchQueriesExposed: true },
      self: { mentioned: 1, cited: 1, rank: 2, sentiment: "positive", method: "deterministic+jev" },
      citations: [
        { url: "https://reviews.example/oak", position: 2, sourceType: "review_site" },
        { url: `${ORIGIN}/products/oak`, position: 3 },
        { url: "https://forum.example/t/1", position: 1, sourceType: "forum_ugc" },
      ],
      queries: ["best oak table", "oak table reviews"],
    });
    const missing = await seedObs(ctx.db, ctx.ws, ctx.pid, run, {
      provider: "perplexity", promptId: prompts[1], setId, at: t(5), text: `<b>x</b> ${"long ".repeat(100)}`,
      self: { mentioned: 0, cited: 0 }, citations: [{ url: "https://reviews.example/a", position: null, sourceType: "review_site" }],
    });
    const failed = await seedObs(ctx.db, ctx.ws, ctx.pid, run, { provider: "openai_geo", promptId: prompts[2], setId, at: t(20), status: "failed" });
    const exposedNone = await seedObs(ctx.db, ctx.ws, ctx.pid, run, { provider: "anthropic_geo", promptId: prompts[2], setId, at: t(21), usage: { searchQueries: [] }, self: { mentioned: 1, cited: 0, sentiment: "neutral", status: "listed_neutral" } });
    const r = await build(ctx, run);
    const a = new Map(r.answers.map((x) => [x.observationId, x]));
    expect(r.answers.map((x) => x.at)).toEqual(r.answers.map((x) => x.at).slice().sort());
    expect(a.get(cited)).toMatchObject({
      id: `obs:${cited}`, provider: "gemini", outcome: "cited", grounded: true, latencyMs: 377, cost: { value: 0.0012, isEstimate: false },
      position: 2, sentiment: { value: "positive", method: "deterministic+jev" }, recommendationStatus: "recommended",
      citedInstead: { host: "forum.example", url: "https://forum.example/t/1", sourceType: "forum_ugc" }, ownCitedUrl: `${ORIGIN}/products/oak`,
      citationCount: 3, searchQueryCount: 2, promptId: prompts[0],
    });
    expect(a.get(missing)).toMatchObject({ outcome: "missing", position: null, sentiment: null, recommendationStatus: "not_mentioned", cost: { value: null }, latencyMs: null, searchQueryCount: null, ownCitedUrl: null, citationCount: 1 });
    expect(a.get(missing)!.promptText.length).toBeLessThanOrEqual(300);
    expect(a.get(missing)!.promptText.startsWith("<b>x</b>")).toBe(true); // plain text; rendered as text
    expect(a.get(failed)).toMatchObject({ outcome: "failed", citedInstead: null, sentiment: null, recommendationStatus: null });
    expect(a.get(exposedNone)).toMatchObject({ outcome: "named", searchQueryCount: 0, sentiment: { value: "neutral" } });
    // Planned prompts (first page only): the run's prompt set by position, capped by project_limits (default 5).
    expect(r.plannedPrompts!.map((p) => p.promptId)).toEqual(prompts);
    const again = await build(ctx, run, r.cursor);
    expect(again.plannedPrompts).toBeNull();
    expect(again.answers).toEqual([]);
    expect(again.cursor).toBe(r.cursor);
  });

  it("holds an unanalysed answer while the run is active, then sends it once with its outcome", async () => {
    const ctx = await setup();
    const run = await seedRun(ctx.db, ctx.ws, ctx.pid, "geo", "running", { finished_at: null });
    const first = await seedObs(ctx.db, ctx.ws, ctx.pid, run, { at: ago(30), self: { mentioned: 0, cited: 0 } });
    const held = await seedObs(ctx.db, ctx.ws, ctx.pid, run, { at: ago(20) });
    const after = await seedObs(ctx.db, ctx.ws, ctx.pid, run, { at: ago(10), self: { mentioned: 1, cited: 1 } });
    const a = await build(ctx, run);
    expect(a.answers.map((x) => x.observationId)).toEqual([first]); // the held answer stops the source
    expect(a.totals!.lanes[0]).toMatchObject({ provider: "gemini", missing: 1, cited: 1, pending: 1 });
    expect(a.labels).toContain("1 stored answer(s) are awaiting analysis; their outcome is not counted yet.");
    await ctx.db.batch([selfRow(ctx.ws, ctx.pid, held, { mentioned: 1, cited: 0 })]);
    const b = await build(ctx, run, a.cursor);
    expect(b.answers.map((x) => [x.observationId, x.outcome])).toEqual([[held, "named"], [after, "cited"]]);
    expect(decodeLiveGeoCursor(b.cursor)!.p).toBeUndefined();
    expect((await build(ctx, run, b.cursor)).answers).toEqual([]);
  });

  it("sends an answer without its outcome after the hold, then re-sends it with the same id once analysed", async () => {
    const ctx = await setup();
    const run = await seedRun(ctx.db, ctx.ws, ctx.pid, "geo", "running", { finished_at: null });
    const slow = await seedObs(ctx.db, ctx.ws, ctx.pid, run, { at: ago(OBS_HOLD_MS / 1000 + 5) });
    const a = await build(ctx, run);
    expect(a.answers.map((x) => [x.id, x.outcome])).toEqual([[`obs:${slow}`, null]]);
    expect(decodeLiveGeoCursor(a.cursor)!.p).toHaveLength(1);
    // Still not analysed: nothing new, the cursor is echoed.
    const b = await build(ctx, run, a.cursor);
    expect(b.answers).toEqual([]);
    expect(b.cursor).toBe(a.cursor);
    await ctx.db.batch([selfRow(ctx.ws, ctx.pid, slow, { mentioned: 1, cited: 1 })]);
    const c = await build(ctx, run, b.cursor);
    expect(c.answers.map((x) => [x.id, x.outcome])).toEqual([[`obs:${slow}`, "cited"]]);
    expect(decodeLiveGeoCursor(c.cursor)!.p).toBeUndefined();
    expect((await build(ctx, run, c.cursor)).answers).toEqual([]);
  });

  it("a finished run's unanalysed answer is 'not analysed' (its analysis will never come), never 'awaiting analysis'", async () => {
    const ctx = await setup();
    const run = await seedRun(ctx.db, ctx.ws, ctx.pid, "geo", "partial");
    const lost = await seedObs(ctx.db, ctx.ws, ctx.pid, run, { at: t(20) });
    const r = await build(ctx, run);
    expect(r.answers.map((x) => [x.observationId, x.outcome])).toEqual([[lost, null]]);
    expect(r.labels).toContain("1 stored answer(s) were not analysed; their outcome is not counted.");
    expect(r.labels.some((l) => l.includes("awaiting analysis"))).toBe(false);
    // Each answer carries the model and grounding mode it was stored with.
    expect(r.answers[0]).toHaveProperty("model");
    expect(r.answers[0]).toHaveProperty("groundingMode");
  });

  it("never holds answers of a finished run", async () => {
    const ctx = await setup();
    const run = await seedRun(ctx.db, ctx.ws, ctx.pid, "geo", "partial");
    const x = await seedObs(ctx.db, ctx.ws, ctx.pid, run, { at: ago(5) });
    const y = await seedObs(ctx.db, ctx.ws, ctx.pid, run, { at: ago(4), self: { mentioned: 0, cited: 0 } });
    const r = await build(ctx, run);
    expect(r.answers.map((a) => [a.observationId, a.outcome])).toEqual([[x, null], [y, "missing"]]);
  });

  it("pages every answer and recommendation exactly once with out-of-order timestamps", async () => {
    const ctx = await setup();
    const run = await seedRun(ctx.db, ctx.ws, ctx.pid, "geo", "completed");
    const want: string[] = [];
    const stamps = [50, 3, 40, 3, 99, 0, 7, 7, 20, 1];
    for (let i = 0; i < stamps.length; i++) {
      want.push(`obs:${await seedObs(ctx.db, ctx.ws, ctx.pid, run, { at: t(stamps[i]!), provider: i % 2 ? "gemini" : "perplexity", self: { mentioned: 0, cited: 0 } })}`);
      want.push(`rec:${await seedRec(ctx.db, ctx.ws, ctx.pid, run, { agent: "geo", dedupKey: `geo:k${i}`, target: { kind: "site" }, at: t(stamps[(i + 4) % stamps.length]!) })}`);
    }
    for (const limit of [1, 3, 7]) {
      const ids: string[] = [];
      let c: string | null = null;
      for (let i = 0; i < 100; i++) {
        const r = await build(ctx, run, c, limit);
        const got = [...r.answers, ...r.recommendations].map((x) => x.id);
        if (got.length === 0) break;
        ids.push(...got);
        c = r.cursor;
      }
      expect([...ids].sort()).toEqual([...want].sort());
    }
    const r = await build(ctx, run);
    expect(r.recommendations.every((x) => x.agent === "geo" && x.targetLabel === "Site")).toBe(true);
    expect(r.totals!.pipeline).toMatchObject({ created: 10 });
  });
});

describe("live GEO feed: totals and matching", () => {
  it("counts each lane's outcomes, cost (unknown stays null) and the host most often cited instead", async () => {
    const ctx = await setup();
    const run = await seedRun(ctx.db, ctx.ws, ctx.pid, "geo", "completed");
    const other = await seedRun(ctx.db, ctx.ws, ctx.pid, "geo", "completed");
    const cite = (host: string, position = 1) => [{ url: `https://${host}/x`, position }];
    await seedObs(ctx.db, ctx.ws, ctx.pid, run, { provider: "gemini", at: t(1), cost: 0.001, estimate: 0, self: { mentioned: 1, cited: 1 }, citations: [...cite("a.example"), { url: `${ORIGIN}/p`, position: 2 }] });
    await seedObs(ctx.db, ctx.ws, ctx.pid, run, { provider: "gemini", at: t(2), cost: 0.002, estimate: 1, self: { mentioned: 0, cited: 0 }, citations: cite("b.example") });
    await seedObs(ctx.db, ctx.ws, ctx.pid, run, { provider: "gemini", at: t(3), cost: 0.003, estimate: 0, self: { mentioned: 1, cited: 0 }, citations: cite("b.example") });
    await seedObs(ctx.db, ctx.ws, ctx.pid, run, { provider: "gemini", at: t(4), cost: 0.001, estimate: 0, status: "failed" });
    await seedObs(ctx.db, ctx.ws, ctx.pid, run, { provider: "perplexity", at: t(5), cost: null, self: { mentioned: 0, cited: 0 }, citations: [...cite(`www.${new URL(ORIGIN).hostname}`), ...cite("c.example", 2)] });
    await seedObs(ctx.db, ctx.ws, ctx.pid, run, { provider: "perplexity", at: t(6), cost: 0.004 });
    await seedObs(ctx.db, ctx.ws, ctx.pid, other, { provider: "openai_geo", at: t(7), self: { mentioned: 0, cited: 0 } }); // another run
    const r = await build(ctx, run);
    expect(r.totals!.lanes).toEqual([
      { provider: "gemini", cited: 1, named: 1, missing: 1, grounded: 3, failed: 1, pending: 0, cost: { value: 0.007, isEstimate: true }, citedInstead: { host: "b.example", sourceType: "other", answers: 2 } },
      { provider: "perplexity", cited: 0, named: 0, missing: 1, grounded: 1, failed: 0, pending: 1, cost: { value: null, isEstimate: true }, citedInstead: { host: "c.example", sourceType: "other", answers: 1 } },
    ]);
    expect(r.totals!.truncated).toBe(false);
  });

  it("custom GEO lanes: grounded counts only valid answers with provider-reported sources", async () => {
    const ctx = await setup();
    const run = await seedRun(ctx.db, ctx.ws, ctx.pid, "geo", "completed");
    await seedObs(ctx.db, ctx.ws, ctx.pid, run, { provider: "custom_geo:a", at: t(1), grounded: 1, self: { mentioned: 1, cited: 1 }, citations: [{ url: `${ORIGIN}/p`, position: 1 }] });
    await seedObs(ctx.db, ctx.ws, ctx.pid, run, { provider: "custom_geo:a", at: t(2), grounded: 0, self: { mentioned: 1, cited: 0 } });
    await seedObs(ctx.db, ctx.ws, ctx.pid, run, { provider: "custom_geo:b", at: t(3), grounded: 0, self: { mentioned: 0, cited: 0 } });
    const r = await build(ctx, run);
    expect(r.totals!.lanes.map((l) => [l.provider, l.cited, l.named, l.missing, l.grounded])).toEqual([
      ["custom_geo:a", 1, 1, 0, 1],
      ["custom_geo:b", 0, 0, 1, 0],
    ]);
  });

  it("matches our best page from the answer's engine search queries and Search Console, else title/H1 overlap", async () => {
    const ctx = await setup();
    const run = await seedRun(ctx.db, ctx.ws, ctx.pid, "geo", "completed");
    const crawl = await seedCrawl(ctx.db, ctx.ws, ctx.pid, null, t(-100));
    await seedPage(ctx.db, ctx.ws, ctx.pid, crawl, `${ORIGIN}/guides/oak-care`, { title: "How to care for solid oak furniture", h1: ["Oak furniture care guide"] }, "article");
    await seedPage(ctx.db, ctx.ws, ctx.pid, crawl, `${ORIGIN}/collections/lamps`, { title: "Brass lamps", h1: ["Brass table lamps"] }, "collection");
    await seedGsc(ctx.db, ctx.ws, ctx.pid, { rows: [{ query: "brass reading lamp", page: `${ORIGIN}/collections/lamps`, clicks: 3, impressions: 90, position: 7 }] });
    const viaQuery = await seedObs(ctx.db, ctx.ws, ctx.pid, run, { at: t(1), text: "which lamp should I buy", queries: ["brass reading lamp"], self: { mentioned: 0, cited: 0 } });
    const viaTitle = await seedObs(ctx.db, ctx.ws, ctx.pid, run, { at: t(2), text: "how do I care for solid oak furniture", self: { mentioned: 0, cited: 0 } });
    const none = await seedObs(ctx.db, ctx.ws, ctx.pid, run, { at: t(3), text: "wallpaper ideas", self: { mentioned: 0, cited: 0 } });
    const r = await build(ctx, run);
    const a = new Map(r.answers.map((x) => [x.observationId, x]));
    expect(a.get(viaQuery)!.matchedPage).toMatchObject({ url: `${ORIGIN}/collections/lamps`, method: "engine_search_query", score: 1 });
    expect(a.get(viaQuery)!.matchedPage!.pageId).toBeTruthy();
    expect(a.get(viaTitle)!.matchedPage).toMatchObject({ url: `${ORIGIN}/guides/oak-care`, method: "title_heading_overlap" });
    expect(a.get(none)!.matchedPage).toBeNull();
  });

  it("returns planned prompts from the active set while an active run has no answer, honouring the per-run cap", async () => {
    const ctx = await setup();
    const run = await seedRun(ctx.db, ctx.ws, ctx.pid, "geo", "running", { finished_at: null });
    const { prompts } = await seedPromptSet(ctx.db, ctx.ws, ctx.pid, 8);
    expect((await build(ctx, run)).plannedPrompts!.map((p) => p.promptId)).toEqual(prompts.slice(0, 5));
    await ctx.db.run("UPDATE project_limits SET geo_prompts_per_run = 3 WHERE project_id = ?", ctx.pid);
    expect((await build(ctx, run)).plannedPrompts).toHaveLength(3);
    await ctx.db.run("UPDATE project_limits SET geo_prompts_per_run = 0 WHERE project_id = ?", ctx.pid);
    expect((await build(ctx, run)).plannedPrompts).toEqual([]);
    const finished = await seedRun(ctx.db, ctx.ws, ctx.pid, "geo", "completed");
    expect((await build(ctx, finished)).plannedPrompts).toBeNull(); // no answers, not active: unknown
  });

  it(`stays under D1's bound-parameter limit with 300 answers`, async () => {
    const ctx = await setup();
    const run = await seedRun(ctx.db, ctx.ws, ctx.pid, "geo", "completed");
    for (let i = 0; i < 300; i++) {
      await seedObs(ctx.db, ctx.ws, ctx.pid, run, {
        at: t(i % 41), provider: ["gemini", "perplexity", "openai_geo"][i % 3], latency: 100 + i, self: { mentioned: 0, cited: 0, rank: null },
        citations: [{ url: `https://site${i % 5}.example/a`, position: 1 }], queries: [`query ${i}`],
      });
    }
    const ids = new Set<string>();
    let c: string | null = null;
    const pages: LiveGeoBoardResponse[] = [];
    for (let i = 0; i < 10; i++) {
      const r: LiveGeoBoardResponse = await build(ctx, run, c, 200);
      pages.push(r);
      if (r.answers.length === 0) break;
      r.answers.forEach((x) => {
        expect(ids.has(x.id)).toBe(false);
        ids.add(x.id);
        expect(x.latencyMs).toBeGreaterThanOrEqual(100);
        expect(x.searchQueryCount).toBe(1);
      });
      c = r.cursor;
    }
    expect(ids.size).toBe(300);
    // Whole-run totals only on the last page of a read: the full first page has none, the short second has them.
    expect(pages[0]!.answers).toHaveLength(200);
    expect(pages[0]!.totals).toBeNull();
    expect(pages[1]!.answers).toHaveLength(100);
    const totals = pages[1]!.totals!.lanes;
    expect(totals.map((l) => [l.provider, l.missing])).toEqual([["openai_geo", 100], ["gemini", 100], ["perplexity", 100]]);
    expect((await build(ctx, run, c, 200)).totals!.lanes).toEqual(totals);
  });
});

describe("live GEO feed: labelled demo replay", () => {
  it("replays the seeded demo GEO run", async () => {
    const ctx = await setup({ DEMO_MODE: "true" });
    const demo = await seedDemoProject(ctx.env, ctx.db, ctx.u.userId, FIXED_NOW);
    const call = caller(ctx.env, ctx.u);
    const runs = (await call(`/projects/${demo.id}/activity/current`)).json.data.runs as Array<{ id: string; agent: string }>;
    const geoRun = runs.find((r) => r.agent === "geo")!.id;
    const res = await call(`/projects/${demo.id}/live/geo?runId=${geoRun}`);
    expect(res.status).toBe(200);
    const r = res.json.data as LiveGeoBoardResponse;
    expect(r.labels[0]).toBe(DEMO_LABEL);
    expect(r.answers).toHaveLength(10);
    expect(r.plannedPrompts).toHaveLength(5);
    expect(new Set(r.answers.map((a) => a.outcome))).toEqual(new Set(["cited", "named", "missing", "failed"]));
    expect(r.answers.every((a) => a.cost.value === null && a.latencyMs === null)).toBe(true); // demo: unknown, never $0
    expect(r.recommendations).toHaveLength(2);
    expect(r.totals!.lanes.map((l) => l.provider)).toEqual(["gemini", "perplexity"]);
    // The same answers, with the same ids, as the activity feed's engine_answer items.
    const act = (await call(`/projects/${demo.id}/runs/${geoRun}/activity?limit=200`)).json.data;
    const answerIds = act.items.filter((i: { kind: string }) => i.kind === "engine_answer").map((i: { id: string }) => i.id).sort();
    expect(r.answers.map((a) => a.id).sort()).toEqual(answerIds);
    // The SEO demo run is not a GEO run.
    const seoRun = runs.find((x) => x.agent === "seo")!.id;
    expect((await call(`/projects/${demo.id}/live/geo?runId=${seoRun}`)).status).toBe(400);
  });
});
