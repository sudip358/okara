/**
 * Per-workspace model selection for the built-in GEO engines (gemini, perplexity, openai_geo, anthropic_geo).
 * Table: workspace_provider_models (migration 0011). The writer is not here: it has its own custom provider
 * flow (platform/custom-providers.ts).
 *
 * TypeSafe (Jev) is NOT workspace-selectable (owner decision 2026-10-01: "TypeSafe will perform as it is"): it
 * always runs TYPESAFE_MODEL, else the documented `jev-latest` alias (providers/typesafe.ts
 * resolveTypeSafeModel), whichever key is used. The model routes refuse it (400 model_not_selectable) and a
 * stored 'typesafe' row (saved while the picker briefly existed) is ignored by loadWorkspaceModels and
 * resolveModel; the row itself is harmless and left in place. "typesafe" stays in MODEL_PROVIDERS only so
 * statuses can report its operator/default model through the same resolution.
 *
 * Resolution (runtime, statuses, presence): the workspace's selection > the operator env var
 * (GEMINI_MODEL, PERPLEXITY_MODEL, OPENAI_GEO_MODEL, ANTHROPIC_GEO_MODEL) > none, which is setup_required
 * ("choose a model"). TypeSafe: TYPESAFE_MODEL > jev-latest, never a workspace selection. Nothing is ever
 * invented: a model id is only what the owner picked or typed, or what the operator configured.
 *
 * Model lists are fetched server-side with the provider's own documented list endpoint (verified 2026-10-01,
 * cited in docs/provider-contracts.md "Workspace model selection"):
 *   gemini        GET https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000  (x-goog-api-key)
 *                 -> {models: [{name: "models/<id>", displayName, supportedGenerationMethods[]}], nextPageToken?};
 *                 only models whose supportedGenerationMethods include "generateContent" are listed.
 *   openai_geo    GET https://api.openai.com/v1/models  (Bearer) -> {object: "list", data: [{id, created, owned_by}]}
 *   anthropic_geo GET https://api.anthropic.com/v1/models?limit=1000  (x-api-key, anthropic-version: 2023-06-01)
 *                 -> {data: [{id, display_name, ...}], has_more, first_id, last_id}
 *   perplexity    GET https://api.perplexity.ai/v1/models  (Bearer) -> {object: "list", data: [{id, ...}]};
 *                 ids are "provider/model" (Agent API models)
 *   typesafe      GET https://api.typesafe.ai/v1/models  (Bearer) -> {models: [{name, description, release_date}]}
 *                 (documented here for reference; the model routes no longer list TypeSafe models)
 * Requests go through the guarded API fetch (allowlisted hosts), `redirect: "manual"` (a 3xx is reported,
 * never followed), a 10 s timeout covering headers and body, and a bounded body read. Provider bodies are
 * never echoed; ids are untrusted strings (validated per provider, at most 200 characters, no control
 * characters, deduped, at most 500 returned).
 *
 * A list cannot prove that a model supports the feature a lane needs (web search, grounding): no capability
 * flag is invented. The UI says "Must support <feature>; the Test run will tell you".
 *
 * Operator-key spend guard (modelForKeySource): before this feature only the operator chose the model that
 * runs on the operator's key. A model without a verified price in providers/rates.ts reserves and settles a
 * flat UNKNOWN_RATE_RESERVE_USD_MICROS per call whatever it really costs, so the operator's
 * GLOBAL_USD_MICROS_PER_DAY cap would undercount. On the operator key a workspace's selection is therefore
 * honoured only when its price is verified (or it is the operator's own env model); otherwise no lane is built
 * and the card shows setup_required ("add your own key"). Model lists fetched with the operator key show only priced ids
 * (and, for OpenAI, no fine-tuned or org-owned models), so the operator's private model names never leak.
 */
import type { ModelSelectableProviderId, ModelSource, ProviderModelList, ProviderModelOption } from "@shared/types";
import type { Env } from "../env";
import type { Db } from "../lib/db";
import { readCapped } from "../lib/read-capped";
import { isValidAnthropicModelId } from "../providers/anthropic-geo";
import { GEMINI_API_BASE, isValidGeminiModelId } from "../providers/gemini";
import { isValidOpenAiModelId } from "../providers/openai-geo";
import { PERPLEXITY_API_BASE, isValidPerplexityModelId } from "../providers/perplexity";
import { findRate } from "../providers/rates";
import { TYPESAFE_DEFAULT_MODEL_ALIAS } from "../providers/typesafe";
import { MAX_MODEL_ID_LENGTH, MAX_MODEL_LIST_BYTES, MAX_MODELS_RETURNED, isMissingTableError } from "./custom-providers";

export const MODEL_PROVIDERS: readonly ModelSelectableProviderId[] = ["typesafe", "gemini", "perplexity", "openai_geo", "anthropic_geo"];
export const MODEL_LIST_TIMEOUT_MS = 10_000;
/** Upper bound on list entries inspected. */
const MAX_ENTRIES_SCANNED = 10_000;
const MAX_LABEL_CHARS = 120;

export const MODEL_ENV: Record<ModelSelectableProviderId, "TYPESAFE_MODEL" | "GEMINI_MODEL" | "PERPLEXITY_MODEL" | "OPENAI_GEO_MODEL" | "ANTHROPIC_GEO_MODEL"> = {
  typesafe: "TYPESAFE_MODEL",
  gemini: "GEMINI_MODEL",
  perplexity: "PERPLEXITY_MODEL",
  openai_geo: "OPENAI_GEO_MODEL",
  anthropic_geo: "ANTHROPIC_GEO_MODEL",
};

/** Vendor names used in list details and guard messages. */
const NAME: Record<ModelSelectableProviderId, string> = {
  typesafe: "TypeSafe",
  gemini: "Gemini",
  perplexity: "Perplexity",
  openai_geo: "OpenAI",
  anthropic_geo: "Anthropic",
};

/** The feature each lane needs from the model (shown as "Must support <feature>"); null = nothing special. */
export const MUST_SUPPORT: Record<ModelSelectableProviderId, string | null> = {
  typesafe: null,
  gemini: "Grounding with Google Search (generateContent with the google_search tool)",
  perplexity: "the Agent API with the web_search tool",
  openai_geo: "the Responses API web_search tool",
  anthropic_geo: "the Messages API web search tool",
};

export function isModelProvider(p: string): p is ModelSelectableProviderId {
  return (MODEL_PROVIDERS as readonly string[]).includes(p);
}

/** Providers whose model a workspace may choose (TypeSafe is excluded: it always runs the operator's model). */
export const WORKSPACE_MODEL_PROVIDERS: readonly ModelSelectableProviderId[] = ["gemini", "perplexity", "openai_geo", "anthropic_geo"];

export function isWorkspaceModelProvider(p: string): p is ModelSelectableProviderId {
  return (WORKSPACE_MODEL_PROVIDERS as readonly string[]).includes(p);
}

/** 400 message of the model routes for TypeSafe (any key source). */
export const TYPESAFE_MODEL_NOT_SELECTABLE =
  "TypeSafe (Jev) always uses the operator's model (TYPESAFE_MODEL, else the documented jev-latest alias); a TypeSafe model cannot be chosen per workspace.";

/** TypeSafe model ids go into a JSON body via the SDK; same plain-id rule as OpenAI ids. */
function isValidTypeSafeModelId(model: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:\-]{0,99}$/.test(model);
}

/**
 * A model id as the owner picked or typed it, validated for `provider` (the id goes into a URL path for
 * Gemini, into JSON bodies for the others). Gemini's "models/" prefix is removed. null when invalid.
 */
export function normalizeModelId(provider: ModelSelectableProviderId, raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let v = raw.trim();
  if (!v || v.length > MAX_MODEL_ID_LENGTH || /[\x00-\x1f\x7f]/.test(v)) return null;
  switch (provider) {
    case "gemini":
      if (!isValidGeminiModelId(v)) return null;
      v = v.replace(/^models\//i, "");
      return v;
    case "perplexity":
      return isValidPerplexityModelId(v) ? v : null;
    case "openai_geo":
      return isValidOpenAiModelId(v) ? v : null;
    case "anthropic_geo":
      return isValidAnthropicModelId(v) ? v : null;
    case "typesafe":
      return isValidTypeSafeModelId(v) ? v : null;
  }
}

/** Format hint per provider for the 400 message (never echoes the value). */
export const MODEL_ID_FORMAT: Record<ModelSelectableProviderId, string> = {
  typesafe: "letters, digits, '.', '_', ':' or '-' (e.g. as listed by TypeSafe)",
  gemini: "a Gemini model id such as the ones the model list shows (letters, digits, '.', '-')",
  perplexity: "provider/model format, as the Agent API model list shows it",
  openai_geo: "letters, digits, '.', '_', ':' or '-', as the OpenAI model list shows it",
  anthropic_geo: "letters, digits, '.', '_', ':', '@' or '-', as the Anthropic model list shows it",
};

// ------------------------------------------------------------------ stored selection

export type WorkspaceModels = Partial<Record<ModelSelectableProviderId, string>>;

/**
 * The workspace's selections ({} when none, or before migration 0011). A stored TypeSafe row is ignored
 * (TypeSafe is not workspace-selectable); it stays in the table, harmless.
 */
export async function loadWorkspaceModels(db: Db, workspaceId: string): Promise<WorkspaceModels> {
  try {
    const rows = await db.all<{ provider: string; model: string }>("SELECT provider, model FROM workspace_provider_models WHERE workspace_id = ?", workspaceId);
    const out: WorkspaceModels = {};
    for (const r of rows) if (isWorkspaceModelProvider(r.provider)) out[r.provider] = r.model;
    return out;
  } catch (e) {
    if (isMissingTableError(e)) return {};
    throw e;
  }
}

export interface ResolvedModel {
  model: string | null;
  source: ModelSource | null;
}

/**
 * workspace selection > env var > none. TypeSafe: TYPESAFE_MODEL > jev-latest alias, never a workspace
 * selection (even one passed in `saved`). Invalid stored ids are skipped.
 */
export function resolveModel(env: Partial<Pick<Env, (typeof MODEL_ENV)[ModelSelectableProviderId]>>, saved: WorkspaceModels, provider: ModelSelectableProviderId): ResolvedModel {
  const ws = isWorkspaceModelProvider(provider) ? saved[provider] : undefined;
  const wsModel = ws !== undefined ? normalizeModelId(provider, ws) : null;
  if (wsModel) return { model: wsModel, source: "workspace" };
  const raw = env[MODEL_ENV[provider]];
  const envModel = typeof raw === "string" && raw.trim() ? raw.trim() : null;
  if (envModel) return { model: envModel, source: "operator" };
  if (provider === "typesafe") return { model: TYPESAFE_DEFAULT_MODEL_ALIAS, source: "default" };
  return { model: null, source: null };
}

export type ResolvedModels = Record<ModelSelectableProviderId, ResolvedModel>;

export function resolveAllModels(env: Partial<Pick<Env, (typeof MODEL_ENV)[ModelSelectableProviderId]>>, saved: WorkspaceModels): ResolvedModels {
  const out = {} as ResolvedModels;
  for (const p of MODEL_PROVIDERS) out[p] = resolveModel(env, saved, p);
  return out;
}

export async function resolveWorkspaceModels(env: Env, db: Db, workspaceId: string): Promise<ResolvedModels> {
  return resolveAllModels(env, await loadWorkspaceModels(db, workspaceId));
}

/**
 * Whether the GEO rate table (providers/rates.ts) has a verified rate for this model now. false = cost is
 * recorded as unknown (null). null = not applicable (TypeSafe is priced by the resolved model the API
 * returns; no model selected).
 */
export function rateKnownFor(provider: ModelSelectableProviderId, model: string | null, at: Date = new Date()): boolean | null {
  if (!model || provider === "typesafe") return null;
  return findRate(provider, model, at) !== null;
}

// ------------------------------------------------------------------ operator-key spend guard

/** Which key a provider would use for the workspace (platform/credentials.ts); null or "none" = no key. */
export type ModelKeySource = "workspace_key" | "operator_key" | "none" | null;

export interface ModelInUse extends ResolvedModel {
  /**
   * Plain-text reason why the workspace's selection cannot run on the operator key (no lane is built; the
   * card and the board show setup_required with this text). null when the model can be used.
   */
  blocked: string | null;
}

/** "<Vendor> model <id> has no verified price and this workspace uses the operator key; add your own <Vendor> key to use it." */
export function operatorKeyUnpricedMessage(provider: ModelSelectableProviderId, model: string): string {
  return `${NAME[provider]} model ${model} has no verified price and this workspace uses the operator key; add your own ${NAME[provider]} key to use it.`;
}

/**
 * The model a provider really uses with `keySource` (workspace selection > env > none; TypeSafe always
 * TYPESAFE_MODEL > jev-latest, whatever the key), applying the operator-key spend guard:
 *   - workspace key, or no key: the resolved model as is;
 *   - operator key and a workspace selection equal to the operator's env model: allowed (the operator chose it);
 *   - operator key and a GEO engine selection without a verified rate (providers/rates.ts findRate at `at`):
 *     blocked (unpriced calls would reserve and settle only the flat unknown-rate amount against the
 *     operator's global usd cap).
 */
export function modelForKeySource(
  env: Partial<Pick<Env, (typeof MODEL_ENV)[ModelSelectableProviderId]>>,
  saved: WorkspaceModels,
  provider: ModelSelectableProviderId,
  keySource: ModelKeySource | undefined,
  at: Date = new Date(),
): ModelInUse {
  const r = resolveModel(env, saved, provider);
  const usable = (m: ResolvedModel): ModelInUse => ({ ...m, blocked: null });
  if (keySource !== "operator_key" || r.source !== "workspace" || !r.model) return usable(r);
  const operator = resolveModel(env, {}, provider);
  if (operator.model === r.model) return usable(r);
  if (findRate(provider, r.model, at) !== null) return usable(r);
  return { ...r, blocked: operatorKeyUnpricedMessage(provider, r.model) };
}

/**
 * Save-time check for PUT /credentials/:provider/model when the workspace has no key of its own and the
 * operator key would be used: null = allowed; otherwise the 400 reason and message (never echoing the id).
 */
export function operatorKeyModelRefusal(
  env: Partial<Pick<Env, (typeof MODEL_ENV)[ModelSelectableProviderId]>>,
  provider: ModelSelectableProviderId,
  model: string,
  at: Date = new Date(),
): { reason: "operator_key_unpriced"; message: string } | null {
  const use = modelForKeySource(env, { [provider]: model }, provider, "operator_key", at);
  if (use.blocked) return { reason: "operator_key_unpriced", message: "Add your own API key to use a model without a verified price." };
  return null;
}

// ------------------------------------------------------------------ model lists

export type ModelListCore = Omit<ProviderModelList, "keySource" | "mustSupport">;

interface ListRequest {
  url: string;
  headers: Record<string, string>;
}

function listRequest(provider: ModelSelectableProviderId, apiKey: string): ListRequest {
  switch (provider) {
    case "gemini":
      return { url: `${GEMINI_API_BASE}/models?pageSize=1000`, headers: { "x-goog-api-key": apiKey } };
    case "openai_geo":
      return { url: "https://api.openai.com/v1/models", headers: { Authorization: `Bearer ${apiKey}` } };
    case "anthropic_geo":
      return { url: "https://api.anthropic.com/v1/models?limit=1000", headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } };
    case "perplexity":
      return { url: `${PERPLEXITY_API_BASE}/v1/models`, headers: { Authorization: `Bearer ${apiKey}` } };
    case "typesafe":
      return { url: "https://api.typesafe.ai/v1/models", headers: { Authorization: `Bearer ${apiKey}` } };
  }
}

const cleanLabelText = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, MAX_LABEL_CHARS) : null;
};

/** OpenAI `owned_by` values of OpenAI's own models; anything else ("org-...", "user-...") is an account's own model. */
const OPENAI_FIRST_PARTY_OWNERS: ReadonlySet<string> = new Set(["openai", "system", "openai-internal"]);

/**
 * Whether a listed id may be shown when the list was fetched with the OPERATOR key: only ids with a verified
 * rate (the only ones a workspace may run on that key), and for OpenAI never a fine-tuned ("ft:") or
 * account-owned model (its name would disclose the operator's organisation and private models).
 */
function listableWithOperatorKey(provider: ModelSelectableProviderId, id: string, entry: Record<string, unknown>, at: Date): boolean {
  if (provider === "openai_geo") {
    if (id.toLowerCase().startsWith("ft:")) return false;
    if (typeof entry.owned_by !== "string" || !OPENAI_FIRST_PARTY_OWNERS.has(entry.owned_by)) return false;
  }
  return findRate(provider, id, at) !== null;
}

export interface ModelListParseOptions {
  /** The list was fetched with the operator's key: keep only ids listableWithOperatorKey allows. */
  operatorKey?: boolean;
  /** Date for the rate lookup (default now). */
  at?: Date;
}

/**
 * Model options from a provider's documented list body. `recognized` is false when the body does not have
 * the documented shape (then it is not a model list). `more` is true when the provider says more pages exist.
 * `filtered` counts distinct valid ids left out by the operator-key rule.
 */
export function parseProviderModelList(
  provider: ModelSelectableProviderId,
  json: unknown,
  opts: ModelListParseOptions = {},
): { options: ProviderModelOption[]; total: number; truncated: boolean; recognized: boolean; more: boolean; filtered: number } {
  const o = json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : null;
  let items: unknown[] | null = null;
  let more = false;
  if (o) {
    if (provider === "gemini" || provider === "typesafe") {
      if (Array.isArray(o.models)) items = o.models;
      if (provider === "gemini" && typeof o.nextPageToken === "string" && o.nextPageToken) more = true;
    } else if (Array.isArray(o.data)) {
      items = o.data;
      if (provider === "anthropic_geo" && o.has_more === true) more = true;
    }
  }
  if (!items) return { options: [], total: 0, truncated: false, recognized: false, more: false, filtered: 0 };
  const at = opts.at ?? new Date();
  const byId = new Map<string, string>();
  const filtered = new Set<string>();
  for (const it of items.slice(0, MAX_ENTRIES_SCANNED)) {
    if (!it || typeof it !== "object") continue;
    const r = it as Record<string, unknown>;
    let rawId: unknown;
    let label: string | null = null;
    switch (provider) {
      case "gemini": {
        const methods = Array.isArray(r.supportedGenerationMethods) ? r.supportedGenerationMethods : [];
        if (!methods.includes("generateContent")) continue;
        rawId = r.name;
        label = cleanLabelText(r.displayName);
        break;
      }
      case "anthropic_geo":
        rawId = r.id;
        label = cleanLabelText(r.display_name);
        break;
      case "typesafe":
        rawId = r.name;
        break;
      default:
        rawId = r.id;
    }
    const id = normalizeModelId(provider, rawId);
    if (!id || byId.has(id)) continue;
    if (opts.operatorKey && !listableWithOperatorKey(provider, id, r, at)) {
      filtered.add(id);
      continue;
    }
    byId.set(id, label && label !== id ? `${label} (${id})` : id);
  }
  const sorted = [...byId.entries()]
    .map(([id, l]) => ({ id, label: l }))
    .sort((a, b) => {
      const la = a.id.toLowerCase();
      const lb = b.id.toLowerCase();
      return la < lb ? -1 : la > lb ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  return { options: sorted.slice(0, MAX_MODELS_RETURNED), total: sorted.length, truncated: sorted.length > MAX_MODELS_RETURNED, recognized: true, more, filtered: filtered.size };
}

export const OPERATOR_KEY_LIST_NOTE = "Only models with a verified price are listed with the operator key; add your own key to see all models.";

/**
 * GET the provider's model list with `apiKey`. `fetchImpl` must be the guarded API fetch. The key goes only
 * in a header. The body is never echoed; only validated ids and display names are returned. With
 * `operatorKey` (the key is the operator's) only ids a workspace may run on that key are returned.
 */
export async function listProviderModels(
  provider: ModelSelectableProviderId,
  apiKey: string,
  fetchImpl: typeof fetch,
  opts: { operatorKey?: boolean; timeoutMs?: number; at?: Date } = {},
): Promise<ModelListCore> {
  const timeoutMs = opts.timeoutMs ?? MODEL_LIST_TIMEOUT_MS;
  const fail = (ok: boolean | null, detail: string): ModelListCore => ({ ok, detail, models: [], total: 0, truncated: false });
  const { url, headers } = listRequest(provider, apiKey);
  const name = NAME[provider];
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: { ...headers, Accept: "application/json" },
      // "manual", not "error": workerd rejects redirect "error" before sending. A 3xx is reported below.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return fail(false, `Could not reach ${name} (network error or timeout).`);
  }
  const discard = () => res.body?.cancel().catch(() => undefined);
  if (res.status >= 300 && res.status < 400) {
    await discard();
    return fail(false, `${name} answered with a redirect (HTTP ${res.status}); not followed.`);
  }
  if (res.status === 401 || res.status === 403) {
    await discard();
    return fail(false, `Key rejected by ${name} (HTTP ${res.status}).`);
  }
  if (res.status === 429) {
    await discard();
    return fail(null, `${name} rate-limited the request; try again later, or type a model id.`);
  }
  if (!res.ok) {
    await discard();
    return fail(false, `${name} returned HTTP ${res.status} for the model list; type a model id instead.`);
  }
  let text: string | null;
  try {
    text = await readCapped(res, MAX_MODEL_LIST_BYTES);
  } catch {
    return fail(null, `The ${name} model list could not be read (network error or timeout); type a model id.`);
  }
  if (text === null) return fail(null, `The ${name} model list is too large to read; type a model id.`);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return fail(false, `${name} did not return a model list (not JSON).`);
  }
  const parsed = parseProviderModelList(provider, json, { operatorKey: opts.operatorKey, at: opts.at });
  if (!parsed.recognized) return fail(false, `${name} did not return a model list in its documented shape.`);
  const filteredNote = parsed.filtered > 0 ? ` ${OPERATOR_KEY_LIST_NOTE}` : "";
  if (parsed.options.length === 0) {
    return {
      ok: true,
      detail: `${name} listed no usable model ids${provider === "gemini" ? " that support generateContent" : ""}; type a model id.${filteredNote}`,
      models: [],
      total: 0,
      truncated: false,
    };
  }
  const notes: string[] = [];
  if (parsed.truncated) notes.push(`showing the first ${MAX_MODELS_RETURNED}`);
  if (parsed.more) notes.push("the provider has more models than one page; type the id if yours is missing");
  return {
    ok: true,
    detail: `${name} listed ${parsed.total} model${parsed.total === 1 ? "" : "s"}${provider === "gemini" ? " supporting generateContent" : ""}${notes.length ? ` (${notes.join("; ")})` : ""}.${filteredNote}`,
    models: parsed.options,
    total: parsed.total,
    truncated: parsed.truncated || parsed.more,
  };
}
