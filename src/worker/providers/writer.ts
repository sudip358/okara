/**
 * Writer factory. WRITER_PROVIDER ('anthropic' | 'openai_compatible') and WRITER_MODEL are both
 * required (plus WRITER_BASE_URL for openai_compatible, and a key). Anything missing -> null, which
 * callers surface as setup_required. There is deliberately no default model id.
 */
import type { Env } from "../env";
import type { WritingProvider } from "./types";
import { createAnthropicWriter } from "./writer-anthropic";
import { createOpenAiCompatibleWriter, parseReasoningEffort, parseReasoningHeadroom, reasoningHeadroomTokens, OPENAI_REASONING_EFFORTS, OPENAI_REASONING_HEADROOM_MAX } from "./writer-openai";
import type { WriterHooks } from "../writing/metering";

export type WriterKind = "anthropic" | "openai_compatible";

export interface WriterConfigStatus {
  configured: boolean;
  provider: WriterKind | null;
  model: string | null;
  missing: string[];
  /** Non-blocking notes (settings that are set but ignored for this provider). */
  warnings: string[];
}

type WriterEnv = Pick<Env, "WRITER_PROVIDER" | "WRITER_MODEL" | "WRITER_BASE_URL" | "WRITER_REASONING_EFFORT" | "WRITER_REASONING_HEADROOM_TOKENS">;

export function writerConfigStatus(env: WriterEnv): WriterConfigStatus {
  const missing: string[] = [];
  const raw = env.WRITER_PROVIDER?.trim() ?? "";
  const provider: WriterKind | null = raw === "anthropic" || raw === "openai_compatible" ? raw : null;
  if (!provider) missing.push(raw ? `WRITER_PROVIDER (unsupported value "${raw}")` : "WRITER_PROVIDER");
  const model = env.WRITER_MODEL?.trim() || null;
  if (!model) missing.push("WRITER_MODEL");
  if (provider === "openai_compatible") {
    const base = env.WRITER_BASE_URL?.trim();
    if (!base) missing.push("WRITER_BASE_URL");
    else {
      try {
        if (new URL(base).protocol !== "https:") missing.push("WRITER_BASE_URL (must be https)");
      } catch {
        missing.push("WRITER_BASE_URL (invalid URL)");
      }
    }
  }
  // Optional reasoning settings: an unrecognised value is a config error (like an invalid WRITER_BASE_URL),
  // not something to drop silently; they only apply to openai_compatible.
  const warnings: string[] = [];
  const effort = env.WRITER_REASONING_EFFORT?.trim() ?? "";
  const headroom = env.WRITER_REASONING_HEADROOM_TOKENS?.trim() ?? "";
  if (provider === "openai_compatible") {
    if (effort && !parseReasoningEffort(effort)) {
      missing.push(`WRITER_REASONING_EFFORT (unrecognised value "${effort}"; use ${OPENAI_REASONING_EFFORTS.join("|")} or leave unset)`);
    }
    if (headroom && parseReasoningHeadroom(headroom) === null) {
      missing.push(`WRITER_REASONING_HEADROOM_TOKENS (unrecognised value "${headroom}"; use a whole number 0-${OPENAI_REASONING_HEADROOM_MAX} or leave unset)`);
    }
  } else if (provider && (effort || headroom)) {
    warnings.push("WRITER_REASONING_EFFORT / WRITER_REASONING_HEADROOM_TOKENS apply only to WRITER_PROVIDER=openai_compatible (ignored).");
  }
  return { configured: missing.length === 0, provider, model, missing, warnings };
}

export function createWriter(
  env: WriterEnv,
  apiKey: string | null,
  fetchImpl: typeof fetch,
  hooks: WriterHooks = {},
): WritingProvider | null {
  const status = writerConfigStatus(env);
  if (!status.configured || !status.provider || !status.model || !apiKey) return null;
  if (status.provider === "anthropic") return createAnthropicWriter({ apiKey, model: status.model, fetchImpl, ...hooks });
  const reasoningEffort = parseReasoningEffort(env.WRITER_REASONING_EFFORT);
  return createOpenAiCompatibleWriter({
    apiKey,
    model: status.model,
    baseUrl: env.WRITER_BASE_URL!,
    fetchImpl,
    reasoningEffort,
    reasoningHeadroomTokens: reasoningHeadroomTokens(reasoningEffort, env.WRITER_REASONING_HEADROOM_TOKENS),
    ...hooks,
  });
}
