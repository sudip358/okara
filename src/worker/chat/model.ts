/**
 * Which model Ask Okara uses [A36]: its own chat model when the workspace owner selected one, else the workspace
 * writer (chat model source "writer", the default, unchanged behaviour).
 *  - Selected chat model (a custom provider with role 'chat', is_chat = 1; Integrations → Ask Okara chat model):
 *    OpenAI-compatible Chat Completions with function tools (the text-tools fallback of model-openai.ts applies); only
 *    its host joins this request's API allowlist; its own base URL, key and model id. Selected but unusable ->
 *    setup_required with the reason (never a fallback to the writer). Workspace key -> the workspace's own spend.
 * Chat model source "writer":
 *  - A selected workspace custom writer (OpenAI-compatible Chat Completions) -> function tools; only its host
 *    joins this request's API allowlist. Selected but unusable -> setup_required (never a fallback).
 *  - Otherwise the operator writer: WRITER_PROVIDER anthropic (Messages API tools via the SDK) or
 *    openai_compatible (Chat Completions tools), WRITER_MODEL, a key (workspace BYO first, then operator).
 * Model ids come only from that configuration; nothing is hardcoded. Anything missing -> setup_required with
 * the reason. Spend: provider_calls + writer_tokens reserved per model round through the writer's budget view
 * (operator global caps apply when the writer runs on the operator key) and recorded in provider_calls with
 * purpose "chat.turn".
 */
import type { Env } from "../env";
import type { Db } from "../lib/db";
import type { Clock } from "../lib/time";
import { resolveProviderKey, type ResolvedKey } from "../platform/credentials";
import { cleanModelId, resolveCustomChat, resolveCustomWriter, selectedCustomChat, validateCustomBaseUrl } from "../platform/custom-providers";
import { CUSTOM_WRITER_MAX_RESPONSE_BYTES, writerConfigStatus } from "../providers/writer";
import { budgetFor, createBudget } from "../runs/budget";
import { createCallRecorder } from "../runs/calls";
import { createApiFetch, writerStatusForWorkspace } from "../runs/runtime";
import { createAnthropicChatModel } from "./model-anthropic";
import { createOpenAiChatModel } from "./model-openai";
import { chatModelPrefStore } from "./prefs";
import type { ChatModel } from "./types";

export type ChatModelResolution =
  | { status: "ready"; model: ChatModel }
  | { status: "setup_required"; message: string; provider: string | null; model: string | null };

/** Where the chat model is changed (shown in "pick another model" errors). */
const CHAT_CARD_HINT = "Integrations → Ask Okara chat model → Change model";

export interface ChatModelOptions {
  fetchImpl?: typeof fetch;
  clock?: Clock;
}

/** Test hook: replace model resolution (fake models). Pass null to restore. */
type Resolver = (env: Env, db: Db, workspaceId: string, projectId: string, opts: ChatModelOptions) => Promise<ChatModelResolution>;
let override: Resolver | null = null;
export function setChatModelResolver(r: Resolver | null): void {
  override = r;
}

export async function resolveChatModel(env: Env, db: Db, workspaceId: string, projectId: string, opts: ChatModelOptions = {}): Promise<ChatModelResolution> {
  if (override) return override(env, db, workspaceId, projectId, opts);
  const clock = opts.clock ?? (() => new Date());
  const calls = createCallRecorder(db, { workspaceId, projectId, runId: null }, clock);
  const chat = await resolveCustomChat(env, db, workspaceId);
  if (chat.status === "unusable") {
    return { status: "setup_required", provider: "openai_compatible", model: chat.model, message: `Ask Okara's chat model (${chat.host}) is selected but cannot be used: ${chat.detail} Fix it under Integrations → Ask Okara chat model, or switch the chat back to the writer.` };
  }
  if (chat.status === "ready") {
    const p = chat.provider;
    const budget = budgetFor(createBudget(db, env, { workspaceId, projectId, runId: null }, clock, { sources: { writer: "workspace_key" } }), "writer");
    return {
      status: "ready",
      model: createOpenAiChatModel({
        apiKey: p.key,
        model: p.model,
        baseUrl: p.baseUrl,
        fetchImpl: createApiFetch(env, opts.fetchImpl ?? fetch, [p.host]),
        maxResponseBytes: CUSTOM_WRITER_MAX_RESPONSE_BYTES,
        changeModelHint: CHAT_CARD_HINT,
        prefs: chatModelPrefStore(db, workspaceId, p.host, p.model, clock),
        calls,
        budget,
      }),
    };
  }
  const custom = await resolveCustomWriter(env, db, workspaceId);
  if (custom.status === "unusable") {
    return { status: "setup_required", provider: "openai_compatible", model: custom.model, message: `The workspace's custom writer (${custom.host}) is selected but cannot be used: ${custom.detail}` };
  }
  if (custom.status === "ready") {
    const p = custom.provider;
    const budget = budgetFor(createBudget(db, env, { workspaceId, projectId, runId: null }, clock, { sources: { writer: "workspace_key" } }), "writer");
    return {
      status: "ready",
      model: createOpenAiChatModel({
        apiKey: p.key,
        model: p.model,
        baseUrl: p.baseUrl,
        fetchImpl: createApiFetch(env, opts.fetchImpl ?? fetch, [p.host]),
        maxResponseBytes: CUSTOM_WRITER_MAX_RESPONSE_BYTES,
        prefs: chatModelPrefStore(db, workspaceId, p.host, p.model, clock),
        calls,
        budget,
      }),
    };
  }
  const status = writerConfigStatus(env);
  if (!status.configured || !status.provider || !status.model) {
    return { status: "setup_required", provider: status.provider, model: status.model, message: `No chat model is configured (missing: ${status.missing.join(", ")}). Ask Okara uses the workspace writer.` };
  }
  let key: ResolvedKey | null = null;
  try {
    key = await resolveProviderKey(env, db, workspaceId, "writer");
  } catch {
    key = null;
  }
  if (!key) return { status: "setup_required", provider: status.provider, model: status.model, message: "Add a writer API key on the Integrations page to use Ask Okara." };
  const budget = budgetFor(createBudget(db, env, { workspaceId, projectId, runId: null }, clock, { sources: { writer: key.source } }), "writer");
  const fetchImpl = createApiFetch(env, opts.fetchImpl ?? fetch);
  if (status.provider === "anthropic") {
    return { status: "ready", model: createAnthropicChatModel({ apiKey: key.key, model: status.model, fetchImpl, calls, budget }) };
  }
  const prefs = chatModelPrefStore(db, workspaceId, hostOf(env.WRITER_BASE_URL), status.model, clock);
  return { status: "ready", model: createOpenAiChatModel({ apiKey: key.key, model: status.model, baseUrl: env.WRITER_BASE_URL!, fetchImpl, prefs, calls, budget }) };
}

function hostOf(url: string | undefined): string {
  try {
    return new URL(url ?? "").host;
  } catch {
    return "writer";
  }
}

/** Readiness without decrypting anything (GET .../chat/status). */
export interface ChatModelStatusResult {
  ready: boolean;
  provider: string | null;
  model: string | null;
  message: string | null;
  /** [A36] "custom": Ask Okara's own chat model is selected; "writer": it uses the workspace writer. */
  source: "writer" | "custom";
  /** The selected chat provider's host (source "custom" only). */
  host: string | null;
}

export async function chatModelStatus(env: Env, db: Db, workspaceId: string): Promise<ChatModelStatusResult> {
  if (override) {
    const r = await override(env, db, workspaceId, "", {});
    return r.status === "ready"
      ? { ready: true, provider: r.model.provider, model: r.model.model, message: null, source: "writer", host: null }
      : { ready: false, provider: r.provider, model: r.model, message: r.message, source: "writer", host: null };
  }
  const chat = await selectedCustomChat(db, workspaceId);
  if (chat) {
    const check = validateCustomBaseUrl(chat.base_url, env.APP_ORIGIN);
    const ok = check.ok && check.host === chat.host && cleanModelId(chat.model) !== null;
    return ok
      ? { ready: true, provider: "openai_compatible", model: chat.model, message: null, source: "custom", host: chat.host }
      : {
          ready: false,
          provider: "openai_compatible",
          model: chat.model,
          message: "Ask Okara's chat model cannot be used: re-save a valid base URL and model under Integrations → Ask Okara chat model, or switch the chat back to the writer.",
          source: "custom",
          host: chat.host,
        };
  }
  const w = await writerStatusForWorkspace(env, db, workspaceId);
  if (w.source === "custom") {
    return w.configured
      ? { ready: true, provider: "openai_compatible", model: w.custom?.model ?? null, message: null, source: "writer", host: w.custom?.host ?? null }
      : { ready: false, provider: "openai_compatible", model: w.custom?.model ?? null, message: `The custom writer cannot be used: ${w.missing.join(", ")}.`, source: "writer", host: w.custom?.host ?? null };
  }
  const status = writerConfigStatus(env);
  return w.configured
    ? { ready: true, provider: status.provider, model: status.model, message: null, source: "writer", host: null }
    : { ready: false, provider: status.provider, model: status.model, message: `No chat model is configured (missing: ${w.missing.join(", ")}). Ask Okara uses the workspace writer.`, source: "writer", host: null };
}
