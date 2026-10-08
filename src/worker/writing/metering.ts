/**
 * Budget + call accounting shared by writing providers.
 * - Reserves provider_calls for every possible attempt and writer_tokens for (estimated input +
 *   max output) before sending anything; BudgetExceededError propagates to the caller.
 * - Every attempt is recorded in provider_calls (cost NULL: no verified writer rate is configured).
 * - Settles provider_calls to the actual attempt count. Tokens settle to reported usage; when an
 *   attempt's outcome is unknown (timeout / dropped connection) the token reservation is kept
 *   (markUnknown) so spend is conservatively accounted.
 */
import type { Budget } from "../runs/context";
import type { CallRecorder } from "../providers/types";
import { ProviderHttpError, type AttemptInfo } from "./http";

export interface WriterHooks {
  calls?: CallRecorder | null;
  budget?: Budget | null;
  sleep?: (ms: number) => Promise<void>;
}

export const WRITER_MAX_RETRIES = 2;
export const WRITER_TIMEOUT_MS = 90_000;

/** Rough, conservative token estimate for budgeting only (never shown as usage). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export async function metered<T extends { usage: { inputTokens: number; outputTokens: number; estimated?: boolean } }>(
  hooks: WriterHooks,
  meta: { provider: string; model: string; purpose: string; estimatedTokens: number; maxRetries: number },
  run: (onAttempt: (a: AttemptInfo) => Promise<void>) => Promise<{ result: T; requestId: string | null; latencyMs: number; failure: WriterOutputError | null }>,
): Promise<T> {
  const budget = hooks.budget ?? null;
  let callsResv: string | null = null;
  let tokensResv: string | null = null;
  if (budget) {
    callsResv = await budget.reserve("provider_calls", meta.maxRetries + 1);
    try {
      tokensResv = await budget.reserve("writer_tokens", meta.estimatedTokens);
    } catch (e) {
      await budget.release(callsResv);
      throw e;
    }
  }
  let attempts = 0;
  let unknownOutcome = false;
  const onAttempt = async (a: AttemptInfo) => {
    attempts++;
    if (a.outcomeUnknown) unknownOutcome = true;
    if (!a.ok) {
      await hooks.calls?.record({
        provider: meta.provider,
        model: meta.model,
        purpose: meta.purpose,
        status: a.timedOut ? "timeout" : a.outcomeUnknown ? "unknown" : "error",
        requestId: a.requestId,
        costUsd: null,
        costIsEstimate: true,
        latencyMs: a.latencyMs,
        error: a.error,
      });
    }
  };
  let settled = false;
  try {
    const { result, requestId, latencyMs, failure } = await run(onAttempt);
    await hooks.calls?.record({
      provider: meta.provider,
      model: meta.model,
      purpose: meta.purpose,
      status: failure ? "error" : "ok",
      requestId,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      ...(result.usage.estimated ? { tokensAreEstimate: true } : {}),
      costUsd: null,
      costIsEstimate: true,
      latencyMs,
      error: failure ? failure.message : null,
    });
    if (budget && callsResv) await budget.settle(callsResv, Math.max(1, attempts));
    if (budget && tokensResv) {
      if (unknownOutcome) await budget.markUnknown(tokensResv);
      else await budget.settle(tokensResv, result.usage.inputTokens + result.usage.outputTokens);
    }
    settled = true;
    if (failure) throw failure;
    return result;
  } catch (e) {
    if (settled) throw e;
    if (budget && callsResv) {
      if (attempts === 0 && !(e instanceof ProviderHttpError)) await budget.release(callsResv);
      else await budget.settle(callsResv, Math.max(1, attempts));
    }
    if (budget && tokensResv) {
      if (unknownOutcome) await budget.markUnknown(tokensResv);
      else if (attempts === 0) await budget.release(tokensResv);
      else await budget.settle(tokensResv, 0);
    }
    throw e;
  }
}

export class WriterOutputError extends Error {
  constructor(message: string, public readonly reason: "refusal" | "truncated" | "invalid_json" | "empty") {
    super(message);
  }
}
