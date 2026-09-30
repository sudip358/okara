/**
 * The context every agent step receives. Built by the runtime (src/worker/runs/runtime.ts) from Env,
 * credentials, and budgets; faked in tests. Agent modules must only reach external services through
 * the members here so budgets, logging, and SSRF rules are enforced in one place.
 */
import type { Db } from "../lib/db";
import type { Env } from "../env";
import type { Clock } from "../lib/time";
import type { DecisionProvider, GeoProvider, GscProvider, WritingProvider, CallRecorder } from "../providers/types";

export interface ProjectRef {
  id: string;
  workspaceId: string;
}

export interface Budget {
  /**
   * Atomically reserve `amount` of `resource` for this project (and the global operator-key caps for
   * usd_micros/provider_calls/jev_calls/writer_tokens; see runs/budget.ts).
   * Throws BudgetExceededError when it would exceed a limit. Returns a reservation id to settle.
   */
  reserve(resource: BudgetResource, amount: number): Promise<string>;
  /** Settle to the actual amount (may be lower or higher). */
  settle(reservationId: string, actualAmount: number): Promise<void>;
  /** Release an unused reservation (only when the call certainly did not happen). */
  release(reservationId: string): Promise<void>;
  /** Outcome unknown (timeout after send): keep the full reservation counted. */
  markUnknown(reservationId: string): Promise<void>;
}

export type BudgetResource = "usd_micros" | "provider_calls" | "crawl_pages" | "gsc_rows" | "geo_prompts" | "jev_calls" | "writer_tokens";

export interface RunLogger {
  event(step: string, status: "started" | "completed" | "skipped" | "failed" | "partial" | "info", message: string): Promise<void>;
}

export interface RunContext {
  env: Env;
  db: Db;
  clock: Clock;
  project: ProjectRef;
  runId: string | null;
  log: RunLogger;
  budget: Budget;
  calls: CallRecorder;
  /** Outbound fetch for provider APIs only (allowlisted hosts). Never use for crawling. */
  apiFetch: typeof fetch;
  /** Fetch for crawling verified hosts; SSRF guard enforced by src/worker/seo/ssrf.ts. */
  crawlFetch: typeof fetch;
  /** null = not configured (setup required). Never substitute a fake in production. */
  decisions: DecisionProvider | null;
  writer: WritingProvider | null;
  geoProviders: GeoProvider[];
  gsc: GscProvider | null;
  /** True when this run is cancelled; steps check between units of work. */
  isCancelled(): Promise<boolean>;
}
