/**
 * D1 per-query limits (https://developers.cloudflare.com/d1/platform/limits/): at most 100 bound
 * parameters per statement. The test shim (tests/helpers/d1.ts) enforces it; these tests drive the
 * code paths with dynamic IN lists at production-sized inputs so a regression fails here, not in D1.
 */
import { describe, expect, it } from "vitest";
import { Db } from "@worker/lib/db";
import type { DecisionAnswer, DecisionQuestion } from "@worker/providers/types";
import { judgeQueries } from "@worker/seo/recommend/query-batch";
import { createTestD1, D1_MAX_BOUND_PARAMS } from "./helpers/d1";
import { scenario } from "./fixtures/gsc/scenario";

describe("test D1 shim enforces D1 limits", () => {
  it("rejects more than 100 bound parameters", async () => {
    const d1 = createTestD1();
    const ok = Array.from({ length: D1_MAX_BOUND_PARAMS }, (_, i) => i);
    await expect(d1.prepare(`SELECT 1 WHERE 1 IN (${ok.map(() => "?").join(",")})`).bind(...ok).all()).resolves.toBeTruthy();
    const tooMany = [...ok, 100];
    expect(() => d1.prepare(`SELECT 1 WHERE 1 IN (${tooMany.map(() => "?").join(",")})`).bind(...tooMany)).toThrow(/too many SQL variables/);
  });
});

describe("judgeQueries stays within D1's bound-parameter limit", () => {
  it("classifies and then re-reads 250 queries from the cache", async () => {
    const s = await scenario({ findings: [] });
    const queries = Array.from({ length: 250 }, (_, i) => `brass cabinet pull ${i}`);
    const spec = { id: "seo.buyer_query", make: (path: string): DecisionQuestion => ({ type: "noul", instructions: `Is ${path} a buyer query?` }) };
    let calls = 0;
    const deps = (now: Date) => ({
      db: new Db(s.env.DB),
      workspaceId: s.workspaceId,
      projectId: s.projectId,
      runId: null,
      now,
      call: async (_purpose: string, _state: unknown, questions: Record<string, DecisionQuestion>) => {
        calls++;
        const answers: Record<string, DecisionAnswer> = {};
        for (const id of Object.keys(questions)) answers[id] = { type: "noul", noul: 0.9 };
        return { provider: "typesafe", model: "jev-1.13.0", answers, usage: { inputTokens: 10, outputTokens: 0 } };
      },
    });
    const opts = {
      purpose: "test",
      cachePrefix: "buyer",
      specs: [spec],
      baseState: {},
      queries,
      outcome: () => ({ outcome: "selected" as const, reasonCode: null }),
      maxCalls: 20,
    };
    const now = new Date("2026-09-30T12:00:00Z");

    const first = await judgeQueries(deps(now), opts);
    expect(first.error).toBeNull();
    expect(first.results.size).toBe(250);
    expect(calls).toBeGreaterThan(0);

    calls = 0;
    const second = await judgeQueries(deps(now), opts);
    expect(second.error).toBeNull();
    expect(calls).toBe(0);
    expect(second.cached).toBe(250);
  });
});
