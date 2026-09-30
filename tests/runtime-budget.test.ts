import { describe, expect, it } from "vitest";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";
import { Db } from "@worker/lib/db";
import { BudgetExceededError } from "@worker/lib/errors";
import { createBudget, GLOBAL_SCOPE_KEY, projectScopeKey } from "@worker/runs/budget";
import { acquireRunLock, currentLockHolder, releaseRunLock, renewRunLock } from "@worker/runs/locks";
import { createCallRecorder } from "@worker/runs/calls";

async function setup(limits: Record<string, number> = {}) {
  const env = createTestEnv();
  const u = await seedUser(env);
  const projectId = await seedProject(env, u.workspaceId);
  const db = new Db(env.DB);
  if (Object.keys(limits).length) {
    const sets = Object.keys(limits).map((k) => `${k} = ?`).join(", ");
    await db.run(`UPDATE project_limits SET ${sets} WHERE project_id = ?`, ...Object.values(limits), projectId);
  }
  const budget = createBudget(db, env, { workspaceId: u.workspaceId, projectId, runId: null }, () => FIXED_NOW);
  return { env, db, u, projectId, budget };
}

async function used(db: Db, scope: string, resource: string): Promise<number> {
  const row = await db.first<{ used: number }>("SELECT used FROM usage_counters WHERE scope_key = ? AND day = '2026-09-30' AND resource = ?", scope, resource);
  return row?.used ?? 0;
}

describe("budget reservations", () => {
  it("20 concurrent reserve() calls against a limit that fits 5 -> exactly 5 succeed", async () => {
    const { db, projectId, budget } = await setup({ provider_calls_per_day: 5 });
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => budget.reserve("provider_calls", 1)));
    const ok = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(5);
    expect(rejected).toHaveLength(15);
    expect(rejected.every((r) => r.reason instanceof BudgetExceededError)).toBe(true);
    expect(await used(db, projectScopeKey(projectId), "provider_calls")).toBe(5);
    const n = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM usage_reservations WHERE status = 'reserved'");
    expect(n?.n).toBe(5);
  });

  it("enforces the global usd cap and rolls back the project increment", async () => {
    const env = createTestEnv({ GLOBAL_USD_MICROS_PER_DAY: "1000" });
    const a = await seedUser(env);
    const p1 = await seedProject(env, a.workspaceId);
    const p2 = await seedProject(env, a.workspaceId);
    const db = new Db(env.DB);
    const b1 = createBudget(db, env, { workspaceId: a.workspaceId, projectId: p1, runId: null }, () => FIXED_NOW);
    const b2 = createBudget(db, env, { workspaceId: a.workspaceId, projectId: p2, runId: null }, () => FIXED_NOW);
    await b1.reserve("usd_micros", 700);
    await expect(b2.reserve("usd_micros", 400)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(await used(db, projectScopeKey(p2), "usd_micros")).toBe(0); // rolled back
    expect(await used(db, GLOBAL_SCOPE_KEY, "usd_micros")).toBe(700);
    await b2.reserve("usd_micros", 300);
    expect(await used(db, GLOBAL_SCOPE_KEY, "usd_micros")).toBe(1000);
  });

  it("uses the default global cap of $2/day", async () => {
    const { db, budget } = await setup({ usd_micros_per_day: 10_000_000 });
    await budget.reserve("usd_micros", 2_000_000);
    await expect(budget.reserve("usd_micros", 1)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(await used(db, GLOBAL_SCOPE_KEY, "usd_micros")).toBe(2_000_000);
  });

  it("settle adjusts to the actual amount, release subtracts, markUnknown keeps the reservation", async () => {
    const { db, projectId, budget } = await setup({ usd_micros_per_day: 1_000_000 });
    const key = projectScopeKey(projectId);
    const r1 = await budget.reserve("usd_micros", 500);
    await budget.settle(r1, 120);
    expect(await used(db, key, "usd_micros")).toBe(120);
    expect(await used(db, GLOBAL_SCOPE_KEY, "usd_micros")).toBe(120);
    await budget.settle(r1, 999); // already settled: no double adjustment
    expect(await used(db, key, "usd_micros")).toBe(120);

    const r2 = await budget.reserve("usd_micros", 300);
    await budget.release(r2);
    expect(await used(db, key, "usd_micros")).toBe(120);

    const r3 = await budget.reserve("usd_micros", 200);
    await budget.markUnknown(r3);
    expect(await used(db, key, "usd_micros")).toBe(320);
    await budget.release(r3); // unknown outcomes are never released
    expect(await used(db, key, "usd_micros")).toBe(320);
    const st = await db.all<{ id: string; status: string }>("SELECT id, status FROM usage_reservations WHERE id IN (?, ?, ?)", r1, r2, r3);
    expect(Object.fromEntries(st.map((s) => [s.id, s.status]))).toEqual({ [r1]: "settled", [r2]: "released", [r3]: "unknown" });
  });

  it("settle never drives counters below zero", async () => {
    const { db, projectId, budget } = await setup();
    const r = await budget.reserve("provider_calls", 3);
    await db.run("UPDATE usage_counters SET used = 1 WHERE scope_key = ?", projectScopeKey(projectId));
    await budget.settle(r, 0);
    expect(await used(db, projectScopeKey(projectId), "provider_calls")).toBe(0);
  });
});

describe("run locks", () => {
  it("is exclusive per project+agent, re-entrant for the holder, and expires", async () => {
    const { db, projectId } = await setup();
    const t0 = FIXED_NOW;
    expect(await acquireRunLock(db, projectId, "seo", "run_a", t0, 60)).toBe(true);
    expect(await acquireRunLock(db, projectId, "seo", "run_b", t0, 60)).toBe(false);
    expect(await acquireRunLock(db, projectId, "geo", "run_b", t0, 60)).toBe(true); // other agent
    expect(await acquireRunLock(db, projectId, "seo", "run_a", t0, 60)).toBe(true); // re-entrant
    const later = new Date(t0.getTime() + 61_000);
    expect(await currentLockHolder(db, projectId, "seo", later)).toBeNull();
    expect(await acquireRunLock(db, projectId, "seo", "run_b", later, 60)).toBe(true); // expired -> takeover
    expect(await renewRunLock(db, projectId, "seo", "run_a", later)).toBe(false);
    await releaseRunLock(db, projectId, "seo", "run_a"); // not the holder: no-op
    expect(await currentLockHolder(db, projectId, "seo", later)).toBe("run_b");
    await releaseRunLock(db, projectId, "seo", "run_b");
    expect(await currentLockHolder(db, projectId, "seo", later)).toBeNull();
  });

  it("concurrent acquisitions: exactly one wins", async () => {
    const { db, projectId } = await setup();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => acquireRunLock(db, projectId, "seo", `run_${i}`, FIXED_NOW)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe("call recorder", () => {
  it("stores unknown cost as NULL (never 0) and redacts secrets from errors", async () => {
    const { db, u, projectId } = await setup();
    const rec = createCallRecorder(db, { workspaceId: u.workspaceId, projectId, runId: null }, () => FIXED_NOW);
    await rec.record({ provider: "typesafe", model: "jev-latest", purpose: "t", status: "error", costUsd: null, costIsEstimate: false, error: "Authorization: Bearer sk-abcdefghijklmnop failed" });
    const row = await db.first<{ cost_usd: number | null; cost_is_estimate: number; error: string }>("SELECT cost_usd, cost_is_estimate, error FROM provider_calls");
    expect(row?.cost_usd).toBeNull();
    expect(row?.cost_is_estimate).toBe(1);
    expect(row?.error).not.toContain("sk-abcdefghijklmnop");
  });
});
