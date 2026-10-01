/**
 * Buyer-query sorting over the full Search Console export (2026-10-01 amendment to [A23]): every non-brand
 * query with impressions up to a configurable cap (default 5,000), classified in batches of 50 questions
 * (25 queries) per Jev call, at most BUYER_CALLS_PER_REQUEST calls per POST, reusing the 7-day cache, and
 * bounded by the daily jev_calls budget. Progress is reported honestly ("N of M classified").
 * Fake providers only; the D1 shim enforces 100 bound parameters per statement.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "@worker/app";
import type { Env } from "@worker/env";
import type { BuyerQueryRow, CoverageResponse } from "@shared/types";
import type { DecisionAnswer, DecisionQuestion, GscRow } from "@worker/providers/types";
import { Db } from "@worker/lib/db";
import { HttpError } from "@worker/lib/errors";
import { seoOverviewRoutes, setSeoJevDecisionsFactory } from "@worker/routes/seo-overview";
import { QUESTION } from "@worker/seo/questions";
import { BUYER_CALLS_PER_REQUEST, BUYER_MAX_QUERIES, GSC_PAGE_ROWS, BUYER_MAX_QUERIES_LIMIT, buyerQueryCap } from "@worker/seo/recommend/buyer-queries";
import { judgeQueries, QUERY_BATCH_QUESTIONS } from "@worker/seo/recommend/query-batch";
import { FIXED_NOW } from "./helpers/fixtures";
import { DEFAULT_GSC_DATA, fakeDecisions, noul, U } from "./fixtures/gsc/site";
import { scenario } from "./fixtures/gsc/scenario";
import { answers } from "./seo-jev.fixtures";

const row = (keys: string[], clicks: number, impressions: number, position: number): GscRow => ({ keys, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position });

function makeApp(env: Env, userId: string) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", new Db(c.env.DB));
    c.set("now", FIXED_NOW);
    c.set("user", { id: userId, email: "u@example.com", name: null });
    c.set("session", null);
    await next();
  });
  app.route("/", seoOverviewRoutes);
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    throw err;
  });
  return async (path: string, method: "GET" | "POST" = "GET") => {
    const res = await app.request(path, { method }, env);
    return { status: res.status, json: (await res.json()) as { data: CoverageResponse<BuyerQueryRow> } };
  };
}

/** N distinct non-brand queries with descending impressions (q0 has the most). */
function manyQueries(n: number): GscRow[] {
  return Array.from({ length: n }, (_, i) => row([`walnut drawer pull style ${i}`, U.knob], 1, 10_000 - i, 8));
}
const dataWith = (n: number) => ({ ...DEFAULT_GSC_DATA, qp: { current: manyQueries(n), previous: [] } });

const queryOf = (req: { state: unknown }, id: string) => (req.state as { queries: Record<string, string> }).queries[id.split("#")[1]!]!;
/** Every even-numbered query is a ready-to-buy buyer query; odd ones are not buyer queries. */
const jev = () =>
  fakeDecisions(
    answers({
      [QUESTION.buyerQuery]: (req, id) => noul(Number(queryOf(req, id).split(" ").pop()) % 2 === 0 ? 0.95 : 0.05),
      [QUESTION.buyerReady]: () => noul(0.9),
    }),
  );

afterEach(() => setSeoJevDecisionsFactory(null));

describe("buyerQueryCap", () => {
  it("defaults to 5,000, accepts positive integers, and clamps to the hard ceiling", () => {
    expect(BUYER_MAX_QUERIES).toBe(5000);
    expect(buyerQueryCap(undefined)).toBe(5000);
    expect(buyerQueryCap("")).toBe(5000);
    expect(buyerQueryCap("abc")).toBe(5000);
    expect(buyerQueryCap("0")).toBe(5000);
    expect(buyerQueryCap(-3)).toBe(5000);
    expect(buyerQueryCap("1200")).toBe(1200);
    expect(buyerQueryCap(250.7)).toBe(250);
    expect(buyerQueryCap(10_000_000)).toBe(BUYER_MAX_QUERIES_LIMIT);
  });
});

describe("POST /seo/buyer-queries pages through the full export", () => {
  it("classifies beyond the old top-300 in per-request batches, reuses the cache, and reports N of M", async () => {
    const s = await scenario({ crawl: false, gsc: dataWith(1100) });
    const fake = jev();
    setSeoJevDecisionsFactory(async () => fake);
    const call = makeApp(s.env, s.userId);
    const path = `/projects/${s.projectId}/seo/buyer-queries`;

    // GET never calls Jev.
    const before = (await call(path)).json.data;
    expect(fake.requests).toHaveLength(0);
    expect(before.completeness).toMatchObject({ covered: 0, total: 1100 });
    expect(before.completeness!.note).toMatch(/^0 of 1,100 non-brand queries classified \(all 1,100 with impressions; .*1,100 not classified yet/);

    // First POST: at most BUYER_CALLS_PER_REQUEST calls of <= 50 questions (25 queries x 2).
    const first = (await call(path, "POST")).json.data;
    expect(fake.requests).toHaveLength(BUYER_CALLS_PER_REQUEST);
    for (const r of fake.requests) expect(Object.keys(r.questions).length).toBeLessThanOrEqual(QUERY_BATCH_QUESTIONS);
    const perRequest = BUYER_CALLS_PER_REQUEST * (QUERY_BATCH_QUESTIONS / 2);
    expect(first.completeness).toMatchObject({ covered: perRequest, total: 1100 });
    expect(first.completeness!.note).toMatch(new RegExp(`^${perRequest} of 1,100 non-brand queries classified .*600 not classified yet: one request asks Jev at most ${BUYER_CALLS_PER_REQUEST} times, so Classify with Jev again to continue`));
    // Highest-impression queries go first, and the old 300 cap is gone.
    const firstAsked = new Set(fake.requests.flatMap((r) => Object.values((r.state as { queries: Record<string, string> }).queries)));
    expect(firstAsked.has("walnut drawer pull style 0")).toBe(true);
    expect(firstAsked.has("walnut drawer pull style 499")).toBe(true);
    expect(firstAsked.has("walnut drawer pull style 500")).toBe(false);
    expect(first.rows).toHaveLength(perRequest / 2);

    // Second POST continues from the cache: no query is asked twice.
    const second = (await call(path, "POST")).json.data;
    expect(fake.requests).toHaveLength(2 * BUYER_CALLS_PER_REQUEST);
    const secondAsked = fake.requests.slice(BUYER_CALLS_PER_REQUEST).flatMap((r) => Object.values((r.state as { queries: Record<string, string> }).queries));
    expect(secondAsked.filter((q) => firstAsked.has(q))).toEqual([]);
    expect(second.completeness).toMatchObject({ covered: 1000, total: 1100 });
    expect(second.completeness!.note).toMatch(/500 from the 7-day cache, 20 Jev calls/);

    // Third POST finishes the remaining 100 queries in 4 calls.
    const third = (await call(path, "POST")).json.data;
    expect(fake.requests).toHaveLength(2 * BUYER_CALLS_PER_REQUEST + 4);
    expect(third.completeness).toMatchObject({ covered: 1100, total: 1100 });
    expect(third.completeness!.note).not.toMatch(/not classified yet|budget/);
    expect(third.rows).toHaveLength(550);
    expect(third.rows.every((r) => r.intent === "transactional" && r.intentTier === "act")).toBe(true);

    // GET now reads everything from the cache.
    const cached = (await call(path)).json.data;
    expect(fake.requests).toHaveLength(2 * BUYER_CALLS_PER_REQUEST + 4);
    expect(cached.completeness).toMatchObject({ covered: 1100, total: 1100 });
    expect(cached.rows).toEqual(third.rows);
  });

  it("stops at the daily jev_calls budget and says so; the next request continues from the cache", async () => {
    const s = await scenario({ crawl: false, gsc: dataWith(400) });
    await new Db(s.env.DB).run("UPDATE project_limits SET provider_calls_per_day = 5 WHERE project_id = ?", s.projectId);
    const fake = jev();
    setSeoJevDecisionsFactory(async () => fake);
    const d = (await makeApp(s.env, s.userId)(`/projects/${s.projectId}/seo/buyer-queries`, "POST")).json.data;
    expect(fake.requests).toHaveLength(5);
    expect(d.completeness).toMatchObject({ covered: 125, total: 400 });
    expect(d.completeness!.note).toMatch(/^125 of 400 .*daily Jev budget was reached, so 275 are unclassified/);
  });

  it("honours the BUYER_QUERIES_MAX cap and says the scope is capped", async () => {
    const s = await scenario({ crawl: false, gsc: dataWith(120) });
    const fake = jev();
    setSeoJevDecisionsFactory(async () => fake);
    const env = { ...s.env, BUYER_QUERIES_MAX: "50" } as Env;
    const d = (await makeApp(env, s.userId)(`/projects/${s.projectId}/seo/buyer-queries`, "POST")).json.data;
    expect(fake.requests).toHaveLength(2);
    expect(d.completeness).toMatchObject({ covered: 50, total: 50 });
    expect(d.completeness!.note).toMatch(/^50 of 50 non-brand queries classified \(top 50 of 120 by impressions \(cap\)/);
  });
});

describe("stored rows are read in keyset pages", () => {
  it("counts every stored query when there are more rows than one page", async () => {
    const n = GSC_PAGE_ROWS + 150;
    const s = await scenario({ crawl: false, gsc: dataWith(1) });
    const db = new Db(s.env.DB);
    const sync = await db.first<{ sync_id: string }>("SELECT sync_id FROM gsc_metrics WHERE project_id = ? AND window = 'current' LIMIT 1", s.projectId);
    await db.run("DELETE FROM gsc_metrics WHERE project_id = ? AND sync_id = ? AND query IS NOT NULL", s.projectId, sync!.sync_id);
    const stmts: Array<[string, ...unknown[]]> = Array.from({ length: n }, (_, i) => [
      "INSERT INTO gsc_metrics (workspace_id, project_id, sync_id, window, query, page, device, clicks, impressions, ctr, position) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      s.workspaceId, s.projectId, sync!.sync_id, "current", `walnut drawer pull style ${i}`, U.knob, null, 1, 10_000 - i, 0, 8,
    ]);
    await db.batch(stmts);
    setSeoJevDecisionsFactory(async () => null);
    const d = (await makeApp(s.env, s.userId)(`/projects/${s.projectId}/seo/buyer-queries`)).json.data;
    expect(d.state).toBe("setup_required");
    expect(d.completeness).toMatchObject({ covered: 0, total: n });
  });
});

describe("judgeQueries cache lookup", () => {
  it("reads 2,000 cached queries x 2 specs within D1's parameter limit and flags hitMaxCalls", async () => {
    const s = await scenario({ findings: [] });
    const queries = Array.from({ length: 2000 }, (_, i) => `oak shelf bracket ${i}`);
    const specs = ["a", "b"].map((x) => ({ id: `seo.test_${x}`, make: (path: string): DecisionQuestion => ({ type: "noul", instructions: `${x}: ${path}?` }) }));
    let calls = 0;
    const deps = {
      db: new Db(s.env.DB),
      workspaceId: s.workspaceId,
      projectId: s.projectId,
      runId: null,
      now: FIXED_NOW,
      call: async (_p: string, _s: unknown, questions: Record<string, DecisionQuestion>) => {
        calls++;
        const out: Record<string, DecisionAnswer> = {};
        for (const id of Object.keys(questions)) out[id] = { type: "noul", noul: 0.9 };
        return { provider: "typesafe", model: "jev-test", answers: out, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const opts = { purpose: "t", cachePrefix: "t", specs, baseState: {}, queries, outcome: () => ({ outcome: "selected" as const, reasonCode: null }) };
    const capped = await judgeQueries(deps, { ...opts, maxCalls: 3 });
    expect(capped).toMatchObject({ calls: 3, asked: 75, hitMaxCalls: true, stoppedBy: "budget" });
    const all = await judgeQueries(deps, opts);
    expect(all.cached).toBe(75);
    expect(all.hitMaxCalls).toBe(false);
    expect(all.results.size).toBe(2000);
    calls = 0;
    const again = await judgeQueries(deps, { ...opts, maxCalls: 0 });
    expect(calls).toBe(0);
    expect(again.cached).toBe(2000);
    expect(again.hitMaxCalls).toBe(false);
  });
});
