/**
 * Follow-up fixes (seo-extras): buyer-query spending is capped separately from the shared Jev pool
 * (8 calls = 200 queries per POST, 3 classify POSTs per project per day), and judgeQueries writes each
 * call's decision rows in one D1 batch of single-row INSERTs. Fake providers only.
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
import { BUYER_CALLS_PER_REQUEST, BUYER_CLASSIFY_DAILY_LIMIT } from "@worker/seo/recommend/buyer-queries";
import { judgeQueries, QUERY_BATCH_QUESTIONS } from "@worker/seo/recommend/query-batch";
import { BUYER_CLASSIFY_HINT, BUYER_CLASSIFY_PER_DAY, BUYER_QUERIES_PER_CLICK } from "@web/pages/seo/lib";
import { FIXED_NOW } from "./helpers/fixtures";
import { DEFAULT_GSC_DATA, fakeDecisions, noul, U } from "./fixtures/gsc/site";
import { scenario } from "./fixtures/gsc/scenario";
import { answers } from "./seo-jev.fixtures";

afterEach(() => setSeoJevDecisionsFactory(null));

function makeApp(env: Env, userId: string, now: Date = FIXED_NOW) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", new Db(c.env.DB));
    c.set("now", now);
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
    return {
      status: res.status,
      retryAfter: res.headers.get("Retry-After"),
      json: (await res.json()) as { data: CoverageResponse<BuyerQueryRow>; error?: { code: string; message: string } },
    };
  };
}

const row = (q: string, impressions: number): GscRow => ({ keys: [q, U.knob], clicks: 1, impressions, ctr: 1 / impressions, position: 8 });
const dataWith = (n: number) => ({
  ...DEFAULT_GSC_DATA,
  qp: { current: Array.from({ length: n }, (_, i) => row(`walnut drawer pull style ${i}`, 10_000 - i)), previous: [] },
});
const jev = () => fakeDecisions(answers({ [QUESTION.buyerQuery]: () => noul(0.95), [QUESTION.buyerReady]: () => noul(0.9) }));

describe("buyer-query spending caps", () => {
  it("one POST asks at most 8 calls (200 queries); the UI copy matches", () => {
    expect(BUYER_CALLS_PER_REQUEST).toBe(8);
    expect(BUYER_CALLS_PER_REQUEST * (QUERY_BATCH_QUESTIONS / 2)).toBe(BUYER_QUERIES_PER_CLICK);
    expect(BUYER_CLASSIFY_PER_DAY).toBe(BUYER_CLASSIFY_DAILY_LIMIT);
    expect(BUYER_CLASSIFY_HINT).toMatch(/up to 200 queries .* at most 3 times per project per day/);
  });

  it("allows 3 classify POSTs per project per day, then 429 rate_limited with a clear message; GET still works", async () => {
    const s = await scenario({ crawl: false, gsc: dataWith(1000) });
    const fake = jev();
    setSeoJevDecisionsFactory(async () => fake);
    const call = makeApp(s.env, s.userId);
    const path = `/projects/${s.projectId}/seo/buyer-queries`;
    for (let i = 1; i <= 3; i++) {
      const r = await call(path, "POST");
      expect(r.status).toBe(200);
      expect(r.json.data.completeness).toMatchObject({ covered: 200 * i, total: 1000 });
    }
    expect(fake.requests).toHaveLength(3 * BUYER_CALLS_PER_REQUEST);
    const fourth = await call(path, "POST");
    expect(fourth.status).toBe(429);
    expect(fourth.json.error).toEqual({
      code: "rate_limited",
      message: "Buyer-query classification is limited to 3 requests per project per day. Cached answers are kept; continue tomorrow.",
    });
    expect(Number(fourth.retryAfter)).toBeGreaterThan(0);
    expect(fake.requests).toHaveLength(3 * BUYER_CALLS_PER_REQUEST); // no Jev call on the refused POST
    const get = await call(path);
    expect(get.status).toBe(200);
    expect(get.json.data.completeness).toMatchObject({ covered: 600, total: 1000 });
    // The next day the limit resets.
    const tomorrow = await makeApp(s.env, s.userId, new Date(FIXED_NOW.getTime() + 86_400_000))(path, "POST");
    expect(tomorrow.status).toBe(200);
  });

  it("POSTs without Jev (setup_required) do not use the daily classify allowance", async () => {
    const s = await scenario({ crawl: false, gsc: dataWith(30) });
    setSeoJevDecisionsFactory(async () => null);
    const call = makeApp(s.env, s.userId);
    const path = `/projects/${s.projectId}/seo/buyer-queries`;
    for (let i = 0; i < 4; i++) {
      const r = await call(path, "POST");
      expect(r.status).toBe(200);
      expect(r.json.data.state).toBe("setup_required");
    }
    const fake = jev();
    setSeoJevDecisionsFactory(async () => fake);
    expect((await call(path, "POST")).status).toBe(200);
    expect(fake.requests.length).toBeGreaterThan(0);
  });
});

describe("judgeQueries writes decision rows in one batch per call", () => {
  it("uses db.batch (never one insert per row) with single-row statements under 100 parameters", async () => {
    const s = await scenario({ findings: [] });
    const real = new Db(s.env.DB);
    const batches: Array<Array<[string, ...unknown[]]>> = [];
    class SpyDb extends Db {
      override async insert(): Promise<void> {
        throw new Error("insert must not be used for decision rows");
      }
      override async batch(statements: Array<[string, ...unknown[]]>): Promise<void> {
        batches.push(statements);
        return super.batch(statements);
      }
    }
    const db = new SpyDb(s.env.DB);
    const queries = Array.from({ length: 60 }, (_, i) => `oak shelf bracket ${i}`);
    const specs = ["a", "b"].map((x) => ({ id: `seo.test_${x}`, make: (path: string): DecisionQuestion => ({ type: "noul", instructions: `${x}: ${path}?` }) }));
    const res = await judgeQueries(
      {
        db,
        workspaceId: s.workspaceId,
        projectId: s.projectId,
        runId: null,
        now: FIXED_NOW,
        call: async (_p: string, _s: unknown, questions: Record<string, DecisionQuestion>) => {
          const out: Record<string, DecisionAnswer> = {};
          for (const id of Object.keys(questions)) out[id] = { type: "noul", noul: 0.9 };
          return { provider: "typesafe", model: "jev-test", answers: out, usage: { inputTokens: 1, outputTokens: 1 } };
        },
      },
      { purpose: "t", cachePrefix: "t", specs, baseState: {}, queries, outcome: () => ({ outcome: "selected" as const, reasonCode: null }) },
    );
    expect(res.calls).toBe(3); // 25 + 25 + 10 queries
    expect(batches.map((b) => b.length)).toEqual([50, 50, 20]);
    for (const b of batches) {
      for (const [sql, ...params] of b) {
        expect(sql).toMatch(/^INSERT INTO decision_records \(/);
        expect(params.length).toBeLessThan(100);
      }
    }
    const n = await real.first<{ n: number }>("SELECT COUNT(*) AS n FROM decision_records WHERE project_id = ? AND workspace_id = ?", s.projectId, s.workspaceId);
    expect(n?.n).toBe(120);
  });
});
