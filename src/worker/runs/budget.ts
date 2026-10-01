/**
 * Atomic budget reservations over usage_counters + usage_reservations.
 *
 * reserve(resource, amount):
 *   1. UPSERT the project counter row for today (limit from project_limits; see dailyLimit()).
 *   2. One conditional UPDATE: `used = used + amount WHERE ... AND used + amount <= limit_value`.
 *      changes = 0 -> BudgetExceededError. Concurrent reservations cannot overspend because the
 *      check and the increment are the same statement.
 *   3. For usd_micros, provider_calls, jev_calls and writer_tokens spent on an OPERATOR key, repeat
 *      against the global counter (GLOBAL_*_PER_DAY; defaults below); if the global reservation
 *      fails, the project increment is rolled back. Spend on a tenant's own (workspace) key is bounded
 *      by the project limits only, so one tenant's usage never exhausts another's BYO-key runs.
 *      Which key a reservation spends: the provider named via budgetFor(budget, provider), else the
 *      providers that can spend that resource (jev_calls -> typesafe, writer_tokens -> writer,
 *      usd_micros -> the GEO engines gemini/perplexity/openai_geo/anthropic_geo, provider_calls -> any). Conservative: the global cap applies
 *      when any candidate provider uses the operator key (with no key at all, only usd_micros).
 *   4. Insert reservation rows (status 'reserved').
 * settle(actual): counters adjusted by (actual - amount), never below zero; status 'settled'.
 * release():      amount subtracted; status 'released'. Only when the call certainly did not happen.
 * markUnknown():  counters untouched (conservatively counted); status 'unknown'.
 * Status transitions are claimed with a conditional UPDATE so a reservation is settled at most once.
 */
import type { Env } from "../env";
import type { Db } from "../lib/db";
import { credentialSources, type CredentialProviderId, type CredentialSource } from "../platform/credentials";
import { BudgetExceededError } from "../lib/errors";
import { newId } from "../lib/ids";
import { iso, systemClock, utcDay, type Clock } from "../lib/time";
import type { Budget, BudgetResource } from "./context";

export const DEFAULT_GLOBAL_USD_MICROS_PER_DAY = 2_000_000; // $2.00/day across all projects
/**
 * Engineering defaults for operator-key usage across all projects per UTC day. provider_calls counts
 * every reserved attempt of every provider (a Jev call reserves provider_calls AND jev_calls), so its
 * cap is not below the Jev cap.
 */
export const DEFAULT_GLOBAL_JEV_CALLS_PER_DAY = 2_000;
export const DEFAULT_GLOBAL_PROVIDER_CALLS_PER_DAY = 3_000;
export const DEFAULT_GLOBAL_WRITER_TOKENS_PER_DAY = 1_000_000;

/**
 * Per-run limits (crawl pages, GSC rows, GEO prompts) are stored per run in project_limits; the daily
 * ceiling allows the scheduled run plus the manual-run quota for each agent.
 */
export const RUNS_PER_AGENT_PER_DAY = 1 + 3;
/** GEO prompt executions count once per prompt per enabled provider (up to four engine lanes). */
/** Built-in GEO engines (4) plus at most 2 custom GEO engines per workspace (platform/custom-providers.ts). */
export const MAX_GEO_PROVIDERS = 6;
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

type GlobalEnvKey = "GLOBAL_USD_MICROS_PER_DAY" | "GLOBAL_JEV_CALLS_PER_DAY" | "GLOBAL_PROVIDER_CALLS_PER_DAY" | "GLOBAL_WRITER_TOKENS_PER_DAY";

/** Resources with a global (operator-key) daily cap: env var and default. */
const GLOBAL_CAPS: Partial<Record<BudgetResource, { env: GlobalEnvKey; fallback: number }>> = {
  usd_micros: { env: "GLOBAL_USD_MICROS_PER_DAY", fallback: DEFAULT_GLOBAL_USD_MICROS_PER_DAY },
  jev_calls: { env: "GLOBAL_JEV_CALLS_PER_DAY", fallback: DEFAULT_GLOBAL_JEV_CALLS_PER_DAY },
  provider_calls: { env: "GLOBAL_PROVIDER_CALLS_PER_DAY", fallback: DEFAULT_GLOBAL_PROVIDER_CALLS_PER_DAY },
  writer_tokens: { env: "GLOBAL_WRITER_TOKENS_PER_DAY", fallback: DEFAULT_GLOBAL_WRITER_TOKENS_PER_DAY },
};

/** Providers whose key can spend each globally capped resource (when the caller names none). */
const RESOURCE_PROVIDERS: Partial<Record<BudgetResource, readonly CredentialProviderId[]>> = {
  usd_micros: ["gemini", "perplexity", "openai_geo", "anthropic_geo"],
  jev_calls: ["typesafe"],
  provider_calls: ["typesafe", "writer", "gemini", "perplexity", "openai_geo", "anthropic_geo"],
  writer_tokens: ["writer"],
};

const PROVIDER_IDS: readonly CredentialProviderId[] = ["typesafe", "writer", "gemini", "perplexity", "openai_geo", "anthropic_geo"];

/** Credential source per provider; a missing entry means no key (null). */
export type CredentialSources = Partial<Record<CredentialProviderId, CredentialSource | null>>;

function parseCap(raw: string | undefined, fallback: number): number {
  const t = raw?.trim();
  const n = t ? Number(t) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function globalUsdMicrosPerDay(env: Pick<Env, "GLOBAL_USD_MICROS_PER_DAY">): number {
  return parseCap(env.GLOBAL_USD_MICROS_PER_DAY, DEFAULT_GLOBAL_USD_MICROS_PER_DAY);
}

/** Global daily cap for a resource, or null when the resource has no global cap. */
export function globalDailyLimit(resource: BudgetResource, env: Partial<Pick<Env, GlobalEnvKey>>): number | null {
  const cap = GLOBAL_CAPS[resource];
  return cap ? parseCap(env[cap.env], cap.fallback) : null;
}

/**
 * Whether a reservation counts against the global cap, given the credential source of each provider.
 * Applies when any candidate provider uses the operator key.
 */
export function spendsOperatorKey(resource: BudgetResource, provider: CredentialProviderId | null, sources: CredentialSources): boolean {
  if (!GLOBAL_CAPS[resource]) return false;
  const candidates = provider ? [provider] : (RESOURCE_PROVIDERS[resource] ?? PROVIDER_IDS);
  const keyed = candidates.filter((p) => (sources[p] ?? null) !== null);
  // No key at all: the runtime builds no provider, so nothing real is spent; usd_micros keeps its
  // pre-existing global accounting (conservative for injected providers).
  if (keyed.length === 0) return resource === "usd_micros";
  return keyed.some((p) => sources[p] === "operator_key");
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

const PROVIDER_VIEW = Symbol("budget.forProvider");
/**
 * A workspace custom provider (custom GEO engine, "custom_geo:<id>"): always the tenant's own key, so the
 * global operator-key caps never apply; project limits do.
 */
export const WORKSPACE_CUSTOM_PROVIDER = "workspace_custom" as const;
type BudgetProvider = CredentialProviderId | typeof WORKSPACE_CUSTOM_PROVIDER;
type ProviderAwareBudget = Budget & { [PROVIDER_VIEW]: (provider: BudgetProvider) => Budget };

/**
 * A view of `budget` whose reservations are attributed to `provider`'s credential, so the global
 * (operator-key) caps apply exactly when that provider uses the operator key. Settle/release/markUnknown
 * are shared with the underlying budget. Budgets not made by createBudget (test fakes) are returned as is.
 */
export function budgetFor(budget: Budget, provider: string): Budget {
  const view = (budget as Partial<ProviderAwareBudget>)[PROVIDER_VIEW];
  if (!view) return budget;
  if (provider.startsWith("custom_geo:")) return view(WORKSPACE_CUSTOM_PROVIDER);
  return (PROVIDER_IDS as readonly string[]).includes(provider) ? view(provider as CredentialProviderId) : budget;
}

export function createBudget(
  db: Db,
  env: Env,
  scope: BudgetScope,
  clock: Clock = systemClock,
  opts: {
    /** Sources from the same resolution that picked the keys (runtime), so attribution cannot drift if a key is saved mid-step. */
    sources?: CredentialSources;
  } = {},
): Budget {
  // Resolved once per budget (i.e. per run step / request), like the keys the runtime resolves.
  let sources: Promise<CredentialSources> | null = opts.sources ? Promise.resolve(opts.sources) : null;
  // A rejected lookup (e.g. a transient D1 error) is not cached, so the next reserve() retries it.
  const loadSources = () =>
    (sources ??= credentialSources(env, db, scope.workspaceId).catch((e: unknown) => {
      sources = null;
      throw e;
    }));
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

  async function reserve(resource: BudgetResource, amount: number, provider: BudgetProvider | null): Promise<string> {
    if (!Number.isFinite(amount) || amount < 0) throw new Error(`Invalid reservation amount: ${amount}`);
    const amt = Math.ceil(amount);
    const day = utcDay(clock());
    const limits = await loadProjectLimits(db, scope.workspaceId, scope.projectId);
    const pKey = projectScopeKey(scope.projectId);
    const globalLimit = globalDailyLimit(resource, env);
    const withGlobal =
      globalLimit !== null && provider !== WORKSPACE_CUSTOM_PROVIDER && spendsOperatorKey(resource, provider, await loadSources());
    await upsertCounter(pKey, day, resource, dailyLimit(resource, limits));
    if (!(await tryIncrement(pKey, day, resource, amt))) {
      throw new BudgetExceededError(resource, `Project daily limit reached for ${resource}.`);
    }
    if (withGlobal) {
      await upsertCounter(GLOBAL_SCOPE_KEY, day, resource, globalLimit);
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
  }

  const budget: ProviderAwareBudget = {
    reserve: (resource, amount) => reserve(resource, amount, null),

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

    [PROVIDER_VIEW]: (provider: BudgetProvider): Budget => ({
      reserve: (resource, amount) => reserve(resource, amount, provider),
      settle: (id, actual) => budget.settle(id, actual),
      release: (id) => budget.release(id),
      markUnknown: (id) => budget.markUnknown(id),
    }),
  };
  return budget;
}
