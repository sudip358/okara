/**
 * TypeSafe (Jev) DecisionProvider via the official SDK (@typesafe-ai/sdk 0.6).
 *
 * - One `systemOne({ state, questions, model })` call per DecisionRequest (all questions for one
 *   state batched, as documented). Model: TYPESAFE_MODEL or the `jev-latest` alias; the resolved
 *   model returned by the API is recorded on every result.
 * - Transport: the SDK's `fetch` option is set to the runtime's allowlisted fetch, wrapped to observe
 *   every HTTP attempt. SDK retries (maxRetries 2) cover 408/429/5xx/connection/timeouts; each
 *   attempt is written to provider_calls and counted against provider_calls + jev_calls budgets.
 * - Timeout 12 s per attempt.
 * - Answers: Choice/Score carry `confidence` + `probabilities`; Noul carries only `noul` (the yes
 *   probability). A Noul answer never gets a confidence field. Malformed answers are dropped
 *   (undefined), never defaulted.
 * - Cost: no verified per-call Jev price is configured, so cost_usd is recorded as NULL (unknown,
 *   flagged as estimate) and spend is bounded by hard call caps instead.
 */
import { TypeSafeClient, APIConnectionError, APIError, APITimeoutError, type Fetch, type Questions } from "@typesafe-ai/sdk";
import type { Budget } from "../runs/context";
import type { CallRecorder, DecisionAnswer, DecisionProvider, DecisionQuestion, DecisionRequest, DecisionResult } from "./types";
import { redact } from "../runs/calls";

export const TYPESAFE_DEFAULT_MODEL_ALIAS = "jev-latest";
export const TYPESAFE_TIMEOUT_MS = 12_000;
export const TYPESAFE_MAX_RETRIES = 2;

export interface TypeSafeProviderConfig {
  apiKey: string;
  model?: string | null;
  fetchImpl: typeof fetch;
  calls?: CallRecorder | null;
  budget?: Budget | null;
  timeoutMs?: number;
  maxRetries?: number;
  /** Test hook: shorten SDK backoff. */
  backoffInitialMs?: number;
}

interface SystemOneData {
  model: string;
  answers: Record<string, unknown>;
  usage: { input_tokens: number; output_tokens: number };
}

interface Attempt {
  status: number | null;
  requestId: string | null;
  latencyMs: number;
  error: string | null;
}

export function resolveTypeSafeModel(envModel: string | undefined | null): string {
  return envModel?.trim() || TYPESAFE_DEFAULT_MODEL_ALIAS;
}

export function createTypeSafeProvider(cfg: TypeSafeProviderConfig): DecisionProvider {
  const model = resolveTypeSafeModel(cfg.model);
  const maxRetries = cfg.maxRetries ?? TYPESAFE_MAX_RETRIES;

  function client(attempts: Attempt[]): TypeSafeClient {
    const observed: Fetch = async (input, init) => {
      const started = Date.now();
      try {
        const fetchImpl = cfg.fetchImpl; // no receiver: safe for the platform fetch on workerd
        const res = await fetchImpl(input, init);
        attempts.push({ status: res.status, requestId: res.headers.get("x-typesafe-request-id"), latencyMs: Date.now() - started, error: res.ok ? null : `HTTP ${res.status}` });
        return res;
      } catch (e) {
        attempts.push({ status: null, requestId: null, latencyMs: Date.now() - started, error: e instanceof Error ? redact(e.message) : "network error" });
        throw e;
      }
    };
    return new TypeSafeClient({
      apiKey: cfg.apiKey,
      defaultModel: model,
      fetch: observed,
      timeout: cfg.timeoutMs ?? TYPESAFE_TIMEOUT_MS,
      retry: { maxRetries, ...(cfg.backoffInitialMs !== undefined ? { backoffInitialMs: cfg.backoffInitialMs, backoffMaxMs: cfg.backoffInitialMs * 4 } : {}) },
      logLevel: "off",
    });
  }

  async function reserve(): Promise<Array<string>> {
    if (!cfg.budget) return [];
    const ids: string[] = [];
    try {
      ids.push(await cfg.budget.reserve("provider_calls", maxRetries + 1));
      ids.push(await cfg.budget.reserve("jev_calls", maxRetries + 1));
    } catch (e) {
      for (const id of ids) await cfg.budget.release(id);
      throw e;
    }
    return ids;
  }

  return {
    name: "typesafe",
    async decide(req: DecisionRequest): Promise<DecisionResult> {
      if (Object.keys(req.questions).length === 0) throw new Error("DecisionRequest has no questions.");
      const resv = await reserve();
      const attempts: Attempt[] = [];
      let finalError: unknown = null;
      let data: SystemOneData | null = null;
      let requestId: string | null = null;
      try {
        const r = await client(attempts)
          .systemOne({ state: req.state as never, questions: req.questions as unknown as Questions, model })
          .withResponse();
        data = r.data as unknown as SystemOneData;
        requestId = r.requestId ?? null;
      } catch (e) {
        finalError = e;
      }

      // Record every attempt. The last attempt carries the outcome (tokens on success).
      for (let i = 0; i < attempts.length; i++) {
        const a = attempts[i]!;
        const isLast = i === attempts.length - 1;
        if (isLast && data) {
          await cfg.calls?.record({
            provider: "typesafe",
            model: typeof data.model === "string" ? data.model : model,
            purpose: req.purpose,
            status: "ok",
            requestId: requestId ?? a.requestId,
            inputTokens: num(data.usage?.input_tokens),
            outputTokens: num(data.usage?.output_tokens),
            costUsd: null,
            costIsEstimate: true,
            latencyMs: a.latencyMs,
          });
        } else {
          const status = isLast && finalError ? statusFor(finalError) : a.status === null ? "unknown" : "error";
          await cfg.calls?.record({
            provider: "typesafe",
            model,
            purpose: req.purpose,
            status,
            requestId: a.requestId,
            costUsd: null,
            costIsEstimate: true,
            latencyMs: a.latencyMs,
            error: isLast && finalError ? errorMessage(finalError) : a.error,
          });
        }
      }
      if (attempts.length === 0 && finalError) {
        await cfg.calls?.record({ provider: "typesafe", model, purpose: req.purpose, status: "error", costUsd: null, costIsEstimate: true, error: errorMessage(finalError) });
      }
      if (cfg.budget) {
        // Each attempt counts; if none left the process, release.
        for (const id of resv) {
          if (attempts.length === 0) await cfg.budget.release(id);
          else await cfg.budget.settle(id, attempts.length);
        }
      }
      if (finalError || !data) throw finalError ?? new Error("TypeSafe returned no data.");

      const answers: Record<string, DecisionAnswer | undefined> = {};
      for (const [id, q] of Object.entries(req.questions)) answers[id] = mapAnswer(q, data.answers?.[id]);
      return {
        provider: "typesafe",
        model: typeof data.model === "string" && data.model ? data.model : model,
        answers,
        usage: { inputTokens: num(data.usage?.input_tokens), outputTokens: num(data.usage?.output_tokens) },
      };
    },

    /** Free credential check: models.list() (no inference). */
    async test() {
      try {
        const models = await client([]).models.list({ retry: { maxRetries: 0 } });
        return { ok: true, detail: `Key accepted; ${models.length} model(s) available.` };
      } catch (e) {
        if (e instanceof APIError && (e.status === 401 || e.status === 403)) return { ok: false, detail: "Key rejected by TypeSafe." };
        return { ok: false, detail: `TypeSafe check failed: ${errorMessage(e)}` };
      }
    },
  };
}

/** Map a raw SDK answer onto DecisionAnswer; returns undefined for anything malformed. */
export function mapAnswer(q: DecisionQuestion, raw: unknown): DecisionAnswer | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const type = typeof r.type === "string" ? r.type : q.type;
  if (type !== q.type) return undefined;
  if (q.type === "noul") {
    const noul = r.noul;
    if (typeof noul !== "number" || !Number.isFinite(noul) || noul < 0 || noul > 1) return undefined;
    return { type: "noul", noul }; // no confidence: Noul does not have one
  }
  const confidence = r.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return undefined;
  const probabilities = numberRecord(r.probabilities);
  if (!probabilities) return undefined;
  if (q.type === "choice") {
    const choice = r.choice;
    if (typeof choice !== "string" || !(choice in q.criteria)) return undefined;
    return { type: "choice", choice, confidence, probabilities };
  }
  const score = r.score;
  if (typeof score !== "number" || !Number.isFinite(score)) return undefined;
  const legend = stringRecord(r.legend);
  return legend ? { type: "score", score, confidence, probabilities, legend } : { type: "score", score, confidence, probabilities };
}

function numberRecord(v: unknown): Record<string, number> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, number> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (typeof x !== "number" || !Number.isFinite(x)) return null;
    out[k] = x;
  }
  return out;
}

function stringRecord(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (x === null || x === undefined) continue;
    out[k] = typeof x === "string" ? x : JSON.stringify(x);
  }
  return out;
}

function statusFor(e: unknown): "error" | "timeout" | "unknown" {
  if (e instanceof APITimeoutError) return "timeout";
  if (e instanceof APIConnectionError) return "unknown";
  return "error";
}

function errorMessage(e: unknown): string {
  if (e instanceof APIError) return `HTTP ${e.status}`;
  if (e instanceof Error) return redact(e.message).slice(0, 300);
  return "unknown error";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
