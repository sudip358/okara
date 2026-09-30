/**
 * Runtime assembly: builds the RunContext every agent step receives.
 * - Credentials resolve through resolveProviderKey (workspace BYO key, then operator key).
 * - Providers are constructed only when both a key and a configured model exist; otherwise they are
 *   null / absent and steps report setup_required. Nothing is ever faked.
 * - `apiFetch` is an allowlisted fetch for provider APIs only; `crawlFetch` is the platform fetch,
 *   which the crawler wraps in its SSRF guard (src/worker/seo/ssrf.ts).
 */
import type { AgentKind, ProviderId } from "@shared/types";
import type { Env } from "../env";
import { Db } from "../lib/db";
import { newId } from "../lib/ids";
import { iso, systemClock, type Clock } from "../lib/time";
import type { ProjectRow } from "../platform/access";
import { resolveProviderKey } from "../platform/credentials";
import { createGscProvider } from "../platform/gsc-client";
import { createGeminiProvider, isValidGeminiModelId } from "../providers/gemini";
import { createPerplexityProvider, isValidPerplexityModelId } from "../providers/perplexity";
import { createTypeSafeProvider } from "../providers/typesafe";
import type { GeoProvider, WritingProvider } from "../providers/types";
import { createWriter } from "../providers/writer";
import { createBudget } from "./budget";
import { createCallRecorder } from "./calls";
import type { RunContext, RunLogger } from "./context";

// ------------------------------------------------------------------ outbound allowlist
export const API_HOST_ALLOWLIST: readonly string[] = [
  "api.typesafe.ai",
  "generativelanguage.googleapis.com",
  "api.perplexity.ai",
  "api.anthropic.com",
  "oauth2.googleapis.com",
  "www.googleapis.com",
  "searchconsole.googleapis.com",
  "cloudflare-dns.com",
];

export class OutboundBlockedError extends Error {}

export function allowedApiHosts(env: Pick<Env, "WRITER_BASE_URL">): Set<string> {
  const hosts = new Set(API_HOST_ALLOWLIST);
  const base = env.WRITER_BASE_URL?.trim();
  if (base) {
    try {
      const u = new URL(base);
      if (u.protocol === "https:" && !u.username && !u.password) hosts.add(u.hostname.toLowerCase());
    } catch {
      // invalid base URL: not added; the writer factory reports it as setup_required
    }
  }
  return hosts;
}

/**
 * Fetch that only reaches allowlisted provider API hosts over https on the default port, never
 * follows redirects (a 3xx is returned to the caller, not followed to another host), and refuses
 * URLs with embedded credentials.
 */
export function createApiFetch(env: Pick<Env, "WRITER_BASE_URL">, baseFetch: typeof fetch = fetch): typeof fetch {
  const hosts = allowedApiHosts(env);
  const guarded = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new OutboundBlockedError("Outbound request blocked: invalid URL.");
    }
    if (url.protocol !== "https:") throw new OutboundBlockedError(`Outbound request blocked: ${url.protocol} is not allowed.`);
    if (url.username || url.password) throw new OutboundBlockedError("Outbound request blocked: URL credentials are not allowed.");
    if (url.port && url.port !== "443") throw new OutboundBlockedError("Outbound request blocked: non-standard port.");
    const host = url.hostname.toLowerCase();
    if (!hosts.has(host)) throw new OutboundBlockedError(`Outbound request blocked: ${host} is not an allowlisted provider host.`);
    return baseFetch(input, { ...init, redirect: "manual" });
  };
  return guarded as typeof fetch;
}

// ------------------------------------------------------------------ helpers
export interface RunRow {
  id: string;
  workspace_id: string;
  project_id: string;
  agent: AgentKind;
  trigger: "schedule" | "manual" | "demo";
  status: string;
  cancel_requested: number;
  workflow_instance_id: string | null;
  policy_version: string | null;
  error: string | null;
  summary_json: string;
  created_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export async function loadRun(db: Db, runId: string): Promise<RunRow | null> {
  return db.first<RunRow>("SELECT * FROM agent_runs WHERE id = ?", runId);
}

export function createRunLogger(db: Db, run: { id: string; workspaceId: string; projectId: string }, clock: Clock = systemClock): RunLogger {
  return {
    async event(step, status, message) {
      await db.insert("run_events", {
        id: newId("evt"),
        workspace_id: run.workspaceId,
        project_id: run.projectId,
        run_id: run.id,
        step,
        status,
        message: message.slice(0, 1000),
        created_at: iso(clock()),
      });
    },
  };
}

async function safeKey(env: Env, db: Db, workspaceId: string, provider: ProviderId, log?: RunLogger): Promise<string | null> {
  try {
    return (await resolveProviderKey(env, db, workspaceId, provider))?.key ?? null;
  } catch {
    await log?.event("runtime", "info", `The saved ${provider} key could not be decrypted; treating ${provider} as not configured.`);
    return null;
  }
}

export interface RuntimeOptions {
  /** Base fetch for provider APIs (tests inject a fake). Always wrapped by the allowlist. */
  fetchImpl?: typeof fetch;
  /** Fetch handed to the crawler (which applies its own SSRF guard). */
  crawlFetchImpl?: typeof fetch;
  clock?: Clock;
}

// ------------------------------------------------------------------ context
export async function buildRunContext(env: Env, runId: string, opts: RuntimeOptions = {}): Promise<RunContext> {
  const db = new Db(env.DB);
  const clock = opts.clock ?? systemClock;
  const run = await loadRun(db, runId);
  if (!run) throw new Error(`Run ${runId} not found.`);
  const project = await db.first<ProjectRow>("SELECT * FROM projects WHERE id = ? AND workspace_id = ?", run.project_id, run.workspace_id);
  if (!project) throw new Error(`Project for run ${runId} not found.`);

  const ref = { id: project.id, workspaceId: project.workspace_id };
  const log = createRunLogger(db, { id: run.id, workspaceId: run.workspace_id, projectId: run.project_id }, clock);
  const budget = createBudget(db, env, { workspaceId: ref.workspaceId, projectId: ref.id, runId: run.id }, clock);
  const calls = createCallRecorder(db, { workspaceId: ref.workspaceId, projectId: ref.id, runId: run.id }, clock);
  const apiFetch = createApiFetch(env, opts.fetchImpl ?? fetch);
  const crawlFetch = opts.crawlFetchImpl ?? fetch;

  const [typesafeKey, writerKey, geminiKey, perplexityKey] = await Promise.all([
    safeKey(env, db, ref.workspaceId, "typesafe", log),
    safeKey(env, db, ref.workspaceId, "writer", log),
    safeKey(env, db, ref.workspaceId, "gemini", log),
    safeKey(env, db, ref.workspaceId, "perplexity", log),
  ]);

  const decisions = typesafeKey ? createTypeSafeProvider({ apiKey: typesafeKey, model: env.TYPESAFE_MODEL, fetchImpl: apiFetch, calls, budget }) : null;
  const writer = createWriter(env, writerKey, apiFetch, { calls, budget });

  const geoProviders: GeoProvider[] = [];
  const geminiModel = env.GEMINI_MODEL?.trim();
  if (geminiKey && geminiModel && isValidGeminiModelId(geminiModel)) {
    geoProviders.push(createGeminiProvider({ apiKey: geminiKey, model: geminiModel, fetchImpl: apiFetch }));
  }
  const perplexityModel = env.PERPLEXITY_MODEL?.trim();
  if (perplexityKey && perplexityModel && isValidPerplexityModelId(perplexityModel)) {
    geoProviders.push(createPerplexityProvider({ apiKey: perplexityKey, model: perplexityModel, fetchImpl: apiFetch }));
  }

  let gsc: RunContext["gsc"] = null;
  try {
    gsc = await createGscProvider(env, db, ref, apiFetch, clock);
  } catch {
    await log.event("runtime", "info", "Search Console connection could not be loaded; treating it as not connected.");
  }

  return {
    env,
    db,
    clock,
    project: ref,
    runId: run.id,
    log,
    budget,
    calls,
    apiFetch,
    crawlFetch,
    decisions,
    writer,
    geoProviders,
    gsc,
    async isCancelled() {
      const row = await db.first<{ cancel_requested: number }>("SELECT cancel_requested FROM agent_runs WHERE id = ?", run.id);
      return (row?.cancel_requested ?? 0) === 1;
    },
  };
}

/**
 * Writer for request-scoped routes (e.g. GEO prompt generation). Calls are recorded against the
 * workspace (and project when given); budgets apply only when a projectId is supplied.
 */
export async function buildWriterForWorkspace(
  env: Env,
  db: Db,
  workspaceId: string,
  opts: { projectId?: string | null; fetchImpl?: typeof fetch; clock?: Clock } = {},
): Promise<WritingProvider | null> {
  const key = await safeKey(env, db, workspaceId, "writer");
  if (!key) return null;
  const clock = opts.clock ?? systemClock;
  const projectId = opts.projectId ?? null;
  const calls = createCallRecorder(db, { workspaceId, projectId, runId: null }, clock);
  const budget = projectId ? createBudget(db, env, { workspaceId, projectId, runId: null }, clock) : null;
  return createWriter(env, key, createApiFetch(env, opts.fetchImpl ?? fetch), { calls, budget });
}

/** Which capabilities are configured for a workspace, without decrypting any key. */
export async function capabilityPresence(env: Env, db: Db, workspaceId: string): Promise<Record<ProviderId, boolean>> {
  const rows = await db.all<{ provider: ProviderId }>("SELECT provider FROM provider_credentials WHERE workspace_id = ?", workspaceId);
  const saved = new Set(rows.map((r) => r.provider));
  const op = (v: string | undefined) => typeof v === "string" && v.trim().length > 0;
  return {
    typesafe: saved.has("typesafe") || op(env.TYPESAFE_API_KEY),
    writer: saved.has("writer") || op(env.WRITER_API_KEY),
    gemini: (saved.has("gemini") || op(env.GEMINI_API_KEY)) && isValidGeminiModelId(env.GEMINI_MODEL),
    perplexity: (saved.has("perplexity") || op(env.PERPLEXITY_API_KEY)) && isValidPerplexityModelId(env.PERPLEXITY_MODEL),
  };
}
