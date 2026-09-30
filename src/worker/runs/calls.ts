/**
 * CallRecorder over provider_calls. One row per HTTP attempt (retries included) so every attempt
 * is visible in usage. Unknown cost is stored as NULL, never 0.
 */
import type { Db } from "../lib/db";
import { newId } from "../lib/ids";
import { iso, systemClock, type Clock } from "../lib/time";
import type { CallRecorder, ProviderCallRecord } from "../providers/types";

export interface CallScope {
  workspaceId: string;
  projectId: string | null;
  runId: string | null;
}

const ERROR_MAX = 500;

export function createCallRecorder(db: Db, scope: CallScope, clock: Clock = systemClock): CallRecorder {
  return {
    async record(call: ProviderCallRecord) {
      const cost = typeof call.costUsd === "number" && Number.isFinite(call.costUsd) ? call.costUsd : null;
      await db.insert("provider_calls", {
        id: newId("pc"),
        workspace_id: scope.workspaceId,
        project_id: scope.projectId,
        run_id: scope.runId,
        provider: call.provider,
        model: call.model,
        purpose: call.purpose,
        status: call.status,
        request_id: call.requestId ?? null,
        input_tokens: intOrNull(call.inputTokens),
        output_tokens: intOrNull(call.outputTokens),
        search_requests: intOrNull(call.searchRequests),
        cost_usd: cost,
        // A null cost is unknown, which is never "actual".
        cost_is_estimate: cost === null ? 1 : call.costIsEstimate ? 1 : 0,
        rate_version: call.rateVersion ?? null,
        latency_ms: intOrNull(call.latencyMs),
        error: call.error ? redact(call.error).slice(0, ERROR_MAX) : null,
        created_at: iso(clock()),
      });
    },
  };
}

function intOrNull(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
}

/** Strip anything that looks like a credential from error text before it is stored. */
export function redact(text: string): string {
  return text
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|x-api-key|key|token|authorization)["']?\s*[:=]\s*["']?)[^\s"'&,}]+/gi, "$1[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, "[redacted]");
}
