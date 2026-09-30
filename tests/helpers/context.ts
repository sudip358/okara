/** Build a RunContext with fakes for unit tests. Override any member per test. */
import { Db } from "@worker/lib/db";
import type { Env } from "@worker/env";
import type { RunContext, Budget } from "@worker/runs/context";
import type { ProviderCallRecord } from "@worker/providers/types";
import { FIXED_NOW } from "./fixtures";

export function unlimitedBudget(): Budget & { reservations: Array<{ resource: string; amount: number; state: string }> } {
  const reservations: Array<{ resource: string; amount: number; state: string }> = [];
  return {
    reservations,
    async reserve(resource, amount) {
      reservations.push({ resource, amount, state: "reserved" });
      return String(reservations.length - 1);
    },
    async settle(id) { reservations[Number(id)]!.state = "settled"; },
    async release(id) { reservations[Number(id)]!.state = "released"; },
    async markUnknown(id) { reservations[Number(id)]!.state = "unknown"; },
  };
}

export function makeTestContext(env: Env, project: { id: string; workspaceId: string }, overrides: Partial<RunContext> = {}): RunContext & { recordedCalls: ProviderCallRecord[]; events: Array<{ step: string; status: string; message: string }> } {
  const recordedCalls: ProviderCallRecord[] = [];
  const events: Array<{ step: string; status: string; message: string }> = [];
  const failFetch: typeof fetch = async () => {
    throw new Error("Network disabled in tests; inject a fetch fake.");
  };
  return {
    env,
    db: new Db(env.DB),
    clock: () => FIXED_NOW,
    project,
    runId: null,
    log: { async event(step, status, message) { events.push({ step, status, message }); } },
    budget: unlimitedBudget(),
    calls: { async record(c) { recordedCalls.push(c); } },
    apiFetch: failFetch,
    crawlFetch: failFetch,
    decisions: null,
    writer: null,
    geoProviders: [],
    gsc: null,
    async isCancelled() { return false; },
    recordedCalls,
    events,
    ...overrides,
  };
}
