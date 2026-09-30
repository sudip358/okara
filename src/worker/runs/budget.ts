/**
 * Atomic budget reservations over usage_counters + usage_reservations.
 *
 * reserve(resource, amount):
 *   1. UPSERT the project counter row for today (limit from project_limits; see dailyLimit()).
 *   2. One conditional UPDATE: `used = used + amount WHERE ... AND used + amount <= limit_value`.
 *      changes = 0 -> BudgetExceededError. Concurrent reservations cannot overspend because the
 *      check and the increment are the same statement.
 *   3. For usd_micros, repeat against the global counter (GLOBAL_USD_MICROS_PER_DAY, default $2);
 *      if the global reservation fails, the project increment is rolled back.
 *   4. Insert reservation rows (status 'reserved').
 * settle(actual): counters adjusted by (actual - amount), never below zero; status 'settled'.
 * release():      amount subtracted; status 'released'. Only when the call certainly did not happen.
 * markUnknown():  counters untouched (conservatively counted); status 'unknown'.
 * Status transitions are claimed with a conditional UPDATE so a reservation is settled at most once.
 */
import type { Env } from "../env";
import type { Db } from "../lib/db";
import { BudgetExceededError } from "../lib/errors";
import { newId } from "../lib/ids";
import { iso, systemClock, utcDay, type Clock } from "../lib/time";
import type { Budget, BudgetResource } from "./context";

export const DEFAULT_GLOBAL_USD_MICROS_PER_DAY = 2_000_000; // $2.00/day across all projects

/**
 * Per-run limits (crawl pages, GSC rows, GEO prompts) are stored per run in project_limits; the daily
 * ceiling allows the scheduled run plus the manual-run quota for each agent.
 */
export const RUNS_PER_AGENT_PER_DAY = 1 + 3;
/** GEO prompt executions count once per prompt per enabled provider (up to two providers). */
export const MAX_GEO_PROVIDERS = 2;
/** Engineering default: writer tokens (input + output) per project per day. No DB column yet. */
export const DEFAULT_WRITER_TOKENS_PER_DAY = 200_000;

export interface ProjectLimitsRow {
  crawl_pages: number;
  gsc_rows: number;
  geo_prompts_per_run: number;
  provider_calls_per_day: number;
  usd_micros_per_day: number;
}

export const DEFAULT_PROJECT_LIMITS: ProjectLimitsRow = {
  crawl_pages: 20,
  gsc_rows: 5000,
  geo_prompts_per_run: 5,
  provider_calls_per_day: 60,
  usd_micros_per_day: 500_000,
};

export function dailyLimit(resource: BudgetResource, l: ProjectLimitsRow): number {
  switch (resource) {
    case "usd_micros":
      return l.usd_micros_per_day;
    case "provider_calls":
    case "jev_calls":
      return l.provider_calls_per_day;
    case "crawl_pages":
      return l.crawl_pages * RUNS_PER_AGENT_PER_DAY;
    case "gsc_rows":
      return l.gsc_rows * RUNS_PER_AGENT_PER_DAY;
    case "geo_prompts":
      return l.geo_prompts_per_run * MAX_GEO_PROVIDERS * RUNS_PER_AGENT_PER_DAY;
    case "writer_tokens":
      return DEFAULT_WRITER_TOKENS_PER_DAY;
  }
}

export function globalUsdMicrosPerDay(env: Pick<Env, "GLOBAL_USD_MICROS_PER_DAY">): number {
  const raw = env.GLOBAL_USD_MICROS_PER_DAY?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_GLOBAL_USD_MICROS_PER_DAY;
}

export async function loadProjectLimits(db: Db, workspaceId: string, projectId: string): Promise<ProjectLimitsRow> {
  const row = await db.first<ProjectLimitsRow>(
    `SELECT crawl_pages, gsc_rows, geo_prompts_per_run, provider_calls_per_day, usd_micros_per_day
       FROM project_limits WHERE workspace_id = ? AND project_id = ?`,
    workspaceId,
    projectId,
  );
  return row ?? DEFAULT_PROJECT_LIMITS;
}

export interface BudgetScope {
  workspaceId: string;
  projectId: string;
  runId: string | null;
}

export const projectScopeKey = (projectId: string) => `project:${projectId}`;
export const GLOBAL_SCOPE_KEY = "global";

export function createBudget(db: Db, env: Pick<Env, "GLOBAL_USD_MICROS_PER_DAY">, scope: BudgetScope, clock: Clock = systemClock): Budget {
  async function upsertCounter(scopeKey: string, day: string, resource: string, limit: number) {
    await db.run(
      `INSERT INTO usage_counters (scope_key, day, resource, used, limit_value) VALUES (?, ?, ?, 0, ?)
         ON CONFLICT (scope_key, day, resource) DO UPDATE SET limit_value = excluded.limit_value`,
      scopeKey,
      day,
      resource,
      limit,
    );
  }

  async function tryIncrement(scopeKey: string, day: string, resource: string, amount: number): Promise<boolean> {
    const r = await db.run(
      `UPDATE usage_counters SET used = used + ?
        WHERE scope_key = ? AND day = ? AND resource = ? AND used + ? <= limit_value`,
      amount,
      scopeKey,
      day,
      resource,
      amount,
    );
    return r.changes === 1;
  }

  async function adjust(scopeKey: string, day: string, resource: string, delta: number) {
    if (delta === 0) return;
    await db.run(
      `UPDATE usage_counters SET used = MAX(0, used + ?) WHERE scope_key = ? AND day = ? AND resource = ?`,
      delta,
      scopeKey,
      day,
      resource,
    );
  }

  interface ReservationRow {
    id: string;
    scope_key: string;
    day: string;
    resource: string;
    amount: number;
  }

  /** Claim all rows of a reservation for a status transition; returns the rows that were claimed. */
  async function claim(reservationId: string, to: "settled" | "released" | "unknown", from: string[], settledAmount: number | null): Promise<ReservationRow[]> {
    const rows = await db.all<ReservationRow>(
      `SELECT id, scope_key, day, resource, amount FROM usage_reservations WHERE (id = ? OR id = ?) AND project_id = ?`,
      reservationId,
      `${reservationId}_g`,
      scope.projectId,
    );
    const claimed: ReservationRow[] = [];
    for (const row of rows) {
      const r = await db.run(
        `UPDATE usage_reservations SET status = ?, settled_amount = ?, updated_at = ?
          WHERE id = ? AND status IN (${from.map(() => "?").join(",")})`,
        to,
        settledAmount,
        iso(clock()),
        row.id,
        ...from,
      );
      if (r.changes === 1) claimed.push(row);
    }
    return claimed;
  }

  return {
    async reserve(resource: BudgetResource, amount: number): Promise<string> {
      if (!Number.isFinite(amount) || amount < 0) throw new Error(`Invalid reservation amount: ${amount}`);
      const amt = Math.ceil(amount);
      const day = utcDay(clock());
      const limits = await loadProjectLimits(db, scope.workspaceId, scope.projectId);
      const pKey = projectScopeKey(scope.projectId);
      await upsertCounter(pKey, day, resource, dailyLimit(resource, limits));
      if (!(await tryIncrement(pKey, day, resource, amt))) {
        throw new BudgetExceededError(resource, `Project daily limit reached for ${resource}.`);
      }
      const withGlobal = resource === "usd_micros";
      if (withGlobal) {
        await upsertCounter(GLOBAL_SCOPE_KEY, day, resource, globalUsdMicrosPerDay(env));
        if (!(await tryIncrement(GLOBAL_SCOPE_KEY, day, resource, amt))) {
          await adjust(pKey, day, resource, -amt);
          throw new BudgetExceededError(resource, "Global daily spending allowance reached.");
        }
      }
      const id = newId("resv");
      const now = iso(clock());
      const base = { workspace_id: scope.workspaceId, project_id: scope.projectId, run_id: scope.runId, day, resource, amount: amt, status: "reserved", created_at: now, updated_at: now };
      const stmts: Array<[string, ...unknown[]]> = [
        [
          `INSERT INTO usage_reservations (id, workspace_id, project_id, run_id, scope_key, day, resource, amount, status, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          id, base.workspace_id, base.project_id, base.run_id, pKey, day, resource, amt, "reserved", now, now,
        ],
      ];
      if (withGlobal) {
        stmts.push([
          `INSERT INTO usage_reservations (id, workspace_id, project_id, run_id, scope_key, day, resource, amount, status, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          `${id}_g`, base.workspace_id, base.project_id, base.run_id, GLOBAL_SCOPE_KEY, day, resource, amt, "reserved", now, now,
        ]);
      }
      try {
        await db.batch(stmts);
      } catch (e) {
        // Could not record the reservation: undo the counters so nothing is leaked.
        await adjust(pKey, day, resource, -amt);
        if (withGlobal) await adjust(GLOBAL_SCOPE_KEY, day, resource, -amt);
        throw e;
      }
      return id;
    },

    async settle(reservationId: string, actualAmount: number): Promise<void> {
      const actual = Math.max(0, Math.ceil(Number.isFinite(actualAmount) ? actualAmount : 0));
      // An 'unknown' reservation may still be settled if the true amount becomes known later.
      const rows = await claim(reservationId, "settled", ["reserved", "unknown"], actual);
      for (const r of rows) await adjust(r.scope_key, r.day, r.resource, actual - r.amount);
    },

    async release(reservationId: string): Promise<void> {
      const rows = await claim(reservationId, "released", ["reserved"], 0);
      for (const r of rows) await adjust(r.scope_key, r.day, r.resource, -r.amount);
    },

    async markUnknown(reservationId: string): Promise<void> {
      await claim(reservationId, "unknown", ["reserved"], null);
    },
  };
}
