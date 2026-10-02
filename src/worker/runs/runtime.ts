/**
 * Runtime assembly: builds the RunContext every agent step receives.
 * - Credentials resolve through resolveProviderKey (workspace BYO key, then operator key).
 * - Providers are constructed only when both a key and a model exist; otherwise they are null / absent and
 *   steps report setup_required. Nothing is ever faked. GEO engine models resolve through
 *   platform/provider-models.ts: the workspace's selection > the operator env var > none. TypeSafe (Jev) is
 *   not workspace-selectable: it always runs TYPESAFE_MODEL, else the documented jev-latest alias
 *   (providers/typesafe.ts resolveTypeSafeModel); a stored TypeSafe selection is ignored.
 *   Operator-key spend guard (provider-models.ts modelForKeySource): on the operator's key a workspace-chosen
 *   GEO engine model runs only when providers/rates.ts has a verified price for it (otherwise no lane, a run
 *   event says why).
 * - Custom GEO engines (workspace custom providers with role 'geo') become extra GEO lanes, each with its
 *   own guarded fetch that admits only that provider's host (never the shared apiFetch).
 * - `apiFetch` is an allowlisted fetch for provider APIs only; `crawlFetch` is the platform fetch,
 *   which the crawler wraps in its SSRF guard (src/worker/seo/ssrf.ts).
 */
import type { AgentKind, GeoEngineProviderId, ModelSelectableProviderId } from "@shared/types";
import type { Env } from "../env";
import { Db } from "../lib/db";
import { newId } from "../lib/ids";
import { iso, systemClock, type Clock } from "../lib/time";
import type { ProjectRow } from "../platform/access";
import { OPERATOR_KEY_ENV, resolveProviderKey, type CredentialProviderId, type ResolvedKey } from "../platform/credentials";
import { cleanModelId, listCustomGeoEngines, resolveCustomProviderRow, resolveCustomWriter, selectedCustomWriter, validateCustomBaseUrl } from "../platform/custom-providers";
import { loadWorkspaceModels, modelForKeySource, type ModelInUse } from "../platform/provider-models";
import { customGeoLaneLabel, customGeoProviderId } from "../geo/custom-lanes";
import { createCustomGeoProvider } from "../providers/custom-geo";
import { createGscProvider } from "../platform/gsc-client";
import { anthropicGeoConfigured, createAnthropicGeoProvider } from "../providers/anthropic-geo";
import { createGeminiProvider, geminiConfigured } from "../providers/gemini";
import { createOpenAiGeoProvider, openaiGeoConfigured } from "../providers/openai-geo";
import { createPerplexityProvider, perplexityConfigured } from "../providers/perplexity";
import { createTypeSafeProvider } from "../providers/typesafe";
import type { GeoProvider, WritingProvider } from "../providers/types";
import { createCustomProviderWriter, createWriter, writerConfigStatus } from "../providers/writer";
import { budgetFor, createBudget } from "./budget";
import { createCallRecorder } from "./calls";
import type { RunContext, RunLogger } from "./context";

// ------------------------------------------------------------------ outbound allowlist
/**
 * Provider API hosts reachable from runs, plus the configured WRITER_BASE_URL host. Nothing else:
 * crawling uses crawlFetch (SSRF guard), and DNS-over-HTTPS verification runs in its own route with
 * its own fetch, not in agent runs. A workspace's custom provider host is added per run/request only for
 * that workspace (see createApiFetch's `extraHosts`), never globally.
 */
export const API_HOST_ALLOWLIST: readonly string[] = [
  "api.typesafe.ai",
  "generativelanguage.googleapis.com",
  "api.perplexity.ai",
  "api.anthropic.com",
  "api.openai.com",
  "oauth2.googleapis.com",
  "www.googleapis.com",
  "searchconsole.googleapis.com",
  // DataForSEO (competitor data; HTTP Basic auth, see providers/dataforseo.ts). Not used by agent runs.
  "api.dataforseo.com",
];

export class OutboundBlockedError extends Error {}

/**
 * Allowlisted hosts. `extraHosts` are the hosts of the custom providers the current workspace uses
 * (platform/custom-providers.ts); each is re-checked with the custom base URL rules (public hostname, no IP
 * literal, no local name) so nothing else can be smuggled in.
 */
export function allowedApiHosts(env: Pick<Env, "WRITER_BASE_URL">, extraHosts: Iterable<string> = []): Set<string> {
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
  for (const h of extraHosts) {
    const check = typeof h === "string" ? validateCustomBaseUrl(`https://${h}`) : null;
    if (check?.ok && check.host === h.toLowerCase()) hosts.add(check.host);
  }
  return hosts;
}

/**
 * Fetch that only reaches allowlisted provider API hosts over https on the default port, never
 * follows redirects (a 3xx is returned to the caller, not followed to another host), and refuses
 * URLs with embedded credentials. `extraHosts`: the current workspace's custom provider hosts in use.
 */
export function createApiFetch(env: Pick<Env, "WRITER_BASE_URL">, baseFetch: typeof fetch = fetch, extraHosts: Iterable<string> = []): typeof fetch {
  const hosts = allowedApiHosts(env, extraHosts);
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

async function safeKey(env: Env, db: Db, workspaceId: string, provider: CredentialProviderId, log?: RunLogger): Promise<ResolvedKey | null> {
  try {
    return await resolveProviderKey(env, db, workspaceId, provider);
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
  const calls = createCallRecorder(db, { workspaceId: ref.workspaceId, projectId: ref.id, runId: run.id }, clock);
  // A selected custom writer replaces the default writer for this workspace; its host (and only its host)
  // joins this run's allowlist. Selected but unusable -> no writer (setup_required), never a silent fallback.
  const custom = await resolveCustomWriter(env, db, ref.workspaceId);
  const apiFetch = createApiFetch(env, opts.fetchImpl ?? fetch, custom.status === "ready" ? [custom.provider.host] : []);
  // Wrapped so `ctx.crawlFetch(url)` never invokes the platform fetch with `this = ctx`
  // (workerd throws "Illegal invocation" for a fetch called on a foreign receiver).
  const baseCrawlFetch = opts.crawlFetchImpl ?? fetch;
  const crawlFetch = ((input: RequestInfo | URL, init?: RequestInit) => baseCrawlFetch(input, init)) as typeof fetch;

  const [savedModels, customGeoRows] = await Promise.all([loadWorkspaceModels(db, ref.workspaceId), listCustomGeoEngines(db, ref.workspaceId)]);
  const [typesafe, writerResolved, gemini, perplexity, openaiGeo, anthropicGeo] = await Promise.all([
    safeKey(env, db, ref.workspaceId, "typesafe", log),
    custom.status === "none" ? safeKey(env, db, ref.workspaceId, "writer", log) : Promise.resolve(null),
    safeKey(env, db, ref.workspaceId, "gemini", log),
    safeKey(env, db, ref.workspaceId, "perplexity", log),
    safeKey(env, db, ref.workspaceId, "openai_geo", log),
    safeKey(env, db, ref.workspaceId, "anthropic_geo", log),
  ]);
  const typesafeKey = typesafe?.key ?? null;
  const writerKey = writerResolved?.key ?? null;
  const geminiKey = gemini?.key ?? null;
  const perplexityKey = perplexity?.key ?? null;
  const openaiGeoKey = openaiGeo?.key ?? null;
  const anthropicGeoKey = anthropicGeo?.key ?? null;
  // Budget attribution uses the same resolution that picked the keys (global operator-key caps).
  const budget = createBudget(db, env, { workspaceId: ref.workspaceId, projectId: ref.id, runId: run.id }, clock, {
    sources: {
      typesafe: typesafe?.source ?? null,
      writer: custom.status === "ready" ? "workspace_key" : (writerResolved?.source ?? null),
      gemini: gemini?.source ?? null,
      perplexity: perplexity?.source ?? null,
      openai_geo: openaiGeo?.source ?? null,
      anthropic_geo: anthropicGeo?.source ?? null,
    },
  });

  // The model each provider really uses with the key it resolved to (operator-key spend guard applied).
  const modelInUse = (provider: ModelSelectableProviderId, key: ResolvedKey | null): ModelInUse => modelForKeySource(env, savedModels, provider, key?.source ?? null, clock());
  // TypeSafe always runs the operator's model (TYPESAFE_MODEL, else jev-latest): never a workspace selection.
  const decisions = typesafeKey
    ? createTypeSafeProvider({ apiKey: typesafeKey, model: env.TYPESAFE_MODEL, fetchImpl: apiFetch, calls, budget: budgetFor(budget, "typesafe") })
    : null;
  // Provider views: global operator-key caps apply only when that provider uses the operator key.
  const writerHooks = { calls, budget: budgetFor(budget, "writer") };
  const writer =
    custom.status === "ready"
      ? createCustomProviderWriter(custom.provider, apiFetch, writerHooks)
      : custom.status === "none"
        ? createWriter(env, writerKey, apiFetch, writerHooks)
        : null;
  if (custom.status === "unusable") {
    await log.event("runtime", "info", `The workspace's custom writer (${custom.host}) is selected but cannot be used: ${custom.detail} Drafting is unavailable until it is fixed.`);
  }

  const geoProviders: GeoProvider[] = [];
  // Model ids come only from the workspace's selection or the operator's configuration; both a key and a
  // valid model id are required. A workspace-chosen model without a verified price never runs on the
  // operator's key (its spend could not be counted against the operator's global usd cap): no lane, and a
  // run event says why.
  const engineModel = async (provider: GeoEngineProviderId, key: ResolvedKey | null): Promise<string | null> => {
    if (!key) return null;
    const use = modelInUse(provider, key);
    if (use.blocked) {
      await log.event("runtime", "info", use.blocked);
      return null;
    }
    return use.model;
  };
  const gm = await engineModel("gemini", gemini);
  if (geminiKey && gm && geminiConfigured(env, geminiKey, gm)) {
    geoProviders.push(createGeminiProvider({ apiKey: geminiKey, model: gm, fetchImpl: apiFetch, now: clock, thinkingLevel: env.GEMINI_THINKING_LEVEL }));
  }
  const pm = await engineModel("perplexity", perplexity);
  if (perplexityKey && pm && perplexityConfigured(env, perplexityKey, pm)) {
    geoProviders.push(createPerplexityProvider({ apiKey: perplexityKey, model: pm, fetchImpl: apiFetch, now: clock }));
  }
  const om = await engineModel("openai_geo", openaiGeo);
  if (openaiGeoKey && om && openaiGeoConfigured(env, openaiGeoKey, om)) {
    geoProviders.push(createOpenAiGeoProvider({ apiKey: openaiGeoKey, model: om, fetchImpl: apiFetch, now: clock }));
  }
  const am = await engineModel("anthropic_geo", anthropicGeo);
  if (anthropicGeoKey && am && anthropicGeoConfigured(env, anthropicGeoKey, am)) {
    geoProviders.push(createAnthropicGeoProvider({ apiKey: anthropicGeoKey, model: am, fetchImpl: apiFetch, now: clock }));
  }
  // Custom GEO engines: grounded only when the provider returns web sources, each reaching only its own host.
  for (const row of customGeoRows) {
    const use = await resolveCustomProviderRow(env, db, ref.workspaceId, row);
    if (!use) continue;
    if (use.status === "unusable") {
      await log.event("runtime", "info", `The custom GEO engine ${use.host} cannot be used: ${use.detail} Its lane is skipped until it is fixed.`);
      continue;
    }
    const p = use.provider;
    geoProviders.push(
      createCustomGeoProvider({
        id: customGeoProviderId(p.id),
        label: customGeoLaneLabel(p.label, p.host),
        model: p.model,
        baseUrl: p.baseUrl,
        apiKey: p.key,
        fetchImpl: createApiFetch(env, opts.fetchImpl ?? fetch, [p.host]),
      }),
    );
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
 * workspace (and project when given); budgets apply only when a projectId is supplied. A selected custom
 * writer is used instead of the default writer (null when it is unusable; never a fallback).
 */
export async function buildWriterForWorkspace(
  env: Env,
  db: Db,
  workspaceId: string,
  opts: { projectId?: string | null; fetchImpl?: typeof fetch; clock?: Clock } = {},
): Promise<WritingProvider | null> {
  const custom = await resolveCustomWriter(env, db, workspaceId);
  if (custom.status === "unusable") return null;
  const resolved: ResolvedKey | null = custom.status === "none" ? await safeKey(env, db, workspaceId, "writer") : null;
  if (custom.status === "none" && !resolved) return null;
  const clock = opts.clock ?? systemClock;
  const projectId = opts.projectId ?? null;
  const calls = createCallRecorder(db, { workspaceId, projectId, runId: null }, clock);
  const source = custom.status === "ready" ? "workspace_key" : resolved!.source;
  const budget = projectId
    ? budgetFor(createBudget(db, env, { workspaceId, projectId, runId: null }, clock, { sources: { writer: source } }), "writer")
    : null;
  if (custom.status === "ready") {
    return createCustomProviderWriter(custom.provider, createApiFetch(env, opts.fetchImpl ?? fetch, [custom.provider.host]), { calls, budget });
  }
  return createWriter(env, resolved!.key, createApiFetch(env, opts.fetchImpl ?? fetch), { calls, budget });
}

export interface WorkspaceWriterStatus {
  /** "custom" when the workspace selected one of its custom providers as writer. */
  source: "default" | "custom";
  /** A writer can be built: configuration and a key are present (presence only; nothing is decrypted). */
  configured: boolean;
  /** What is missing when not configured (env names, or the custom provider problem). */
  missing: string[];
  custom: { id: string; host: string; model: string } | null;
}

/** Writer readiness for a workspace without decrypting any key (agent state, setup messages). */
export async function writerStatusForWorkspace(env: Env, db: Db, workspaceId: string): Promise<WorkspaceWriterStatus> {
  const custom = await selectedCustomWriter(db, workspaceId);
  if (custom) {
    const check = validateCustomBaseUrl(custom.base_url, env.APP_ORIGIN);
    const ok = check.ok && check.host === custom.host && cleanModelId(custom.model) !== null;
    return {
      source: "custom",
      configured: ok,
      missing: ok ? [] : ["a valid base URL and model for the custom writer (re-save it on the integrations page)"],
      custom: { id: custom.id, host: custom.host, model: custom.model },
    };
  }
  const status = writerConfigStatus(env);
  const saved = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM provider_credentials WHERE workspace_id = ? AND provider = 'writer'", workspaceId);
  const hasKey = (saved?.n ?? 0) > 0 || (typeof env.WRITER_API_KEY === "string" && env.WRITER_API_KEY.trim().length > 0);
  return {
    source: "default",
    configured: status.configured && hasKey,
    missing: [...status.missing, ...(hasKey ? [] : ["a writer API key"])],
    custom: null,
  };
}

export type CapabilityPresence = Record<CredentialProviderId, boolean> & {
  /** Provider ids ("custom_geo:<id>") of the workspace's custom GEO engines whose saved config validates. */
  customGeoEngines: string[];
  /**
   * GEO engines whose workspace-chosen model cannot run on the operator key (no verified price), with the
   * plain-text reason (provider-models.ts modelForKeySource). Those engines are not configured.
   */
  modelBlocked: Partial<Record<GeoEngineProviderId, string>>;
};

/** Which capabilities are configured for a workspace, without decrypting any key. */
export async function capabilityPresence(env: Env, db: Db, workspaceId: string, at: Date = new Date()): Promise<CapabilityPresence> {
  const [rows, customWriter, saved, customGeo] = await Promise.all([
    db.all<{ provider: CredentialProviderId }>("SELECT provider FROM provider_credentials WHERE workspace_id = ?", workspaceId),
    selectedCustomWriter(db, workspaceId),
    loadWorkspaceModels(db, workspaceId),
    listCustomGeoEngines(db, workspaceId),
  ]);
  const savedKeys = new Set(rows.map((r) => r.provider));
  const op = (v: string | undefined) => typeof v === "string" && v.trim().length > 0;
  const modelBlocked: CapabilityPresence["modelBlocked"] = {};
  // Presence only (no decryption): a saved BYO key stands in as "some key"; without one the operator key (if
  // set) is used, and the operator-key spend guard applies to the workspace's model.
  const engine = (provider: GeoEngineProviderId, configured: (env: Env, key: string | null, model: string | null) => boolean): boolean => {
    const hasSaved = savedKeys.has(provider);
    const source = hasSaved ? "workspace_key" : op(env[OPERATOR_KEY_ENV[provider]] as string | undefined) ? "operator_key" : null;
    const use = modelForKeySource(env, saved, provider, source, at);
    if (use.blocked) {
      modelBlocked[provider] = use.blocked;
      return false;
    }
    return configured(env, hasSaved ? "saved" : null, use.model);
  };
  return {
    typesafe: savedKeys.has("typesafe") || op(env.TYPESAFE_API_KEY),
    // A selected custom writer is the workspace's writer (its own key).
    writer: customWriter !== null || savedKeys.has("writer") || op(env.WRITER_API_KEY),
    gemini: engine("gemini", geminiConfigured),
    perplexity: engine("perplexity", perplexityConfigured),
    openai_geo: engine("openai_geo", openaiGeoConfigured),
    anthropic_geo: engine("anthropic_geo", anthropicGeoConfigured),
    modelBlocked,
    customGeoEngines: customGeo
      .filter((r) => {
        const check = validateCustomBaseUrl(r.base_url, env.APP_ORIGIN);
        return check.ok && check.host === r.host && cleanModelId(r.model) !== null;
      })
      .map((r) => customGeoProviderId(r.id)),
  };
}
