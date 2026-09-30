/**
 * Bounded-retry JSON POST/GET for writing providers. Every attempt (including failed ones) is
 * reported through `onAttempt` so the caller can log it to provider_calls and count it against the
 * budget. Retries only 408/429/5xx, network errors, and timeouts, with exponential backoff + jitter.
 */
import { redact } from "../runs/calls";

export class ProviderHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly timedOut: boolean,
    public readonly requestId: string | null,
    /** True when the provider may have processed the request (timeout or dropped connection). */
    public readonly outcomeUnknown: boolean,
  ) {
    super(message);
  }
}

export interface AttemptInfo {
  attempt: number;
  ok: boolean;
  status: number | null;
  timedOut: boolean;
  outcomeUnknown: boolean;
  requestId: string | null;
  latencyMs: number;
  error: string | null;
}

export interface JsonRequest {
  fetchImpl: typeof fetch;
  url: string;
  method?: "GET" | "POST";
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  maxRetries: number;
  requestIdHeader: string;
  onAttempt: (info: AttemptInfo) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

const RETRYABLE = (s: number) => s === 408 || s === 429 || (s >= 500 && s <= 599);
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function backoffMs(attempt: number, retryAfter: string | null): number {
  const ra = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(ra) && ra >= 0 && ra <= 30) return ra * 1000;
  const base = Math.min(8000, 500 * 2 ** attempt);
  return Math.round(base * (0.75 + Math.random() * 0.25));
}

export async function requestJson(req: JsonRequest): Promise<{ json: unknown; requestId: string | null; latencyMs: number; attempts: number }> {
  const sleep = req.sleep ?? defaultSleep;
  let last: ProviderHttpError | null = null;
  for (let attempt = 0; attempt <= req.maxRetries; attempt++) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    req.signal?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, req.timeoutMs);
    const started = Date.now();
    let retryAfter: string | null = null;
    try {
      const res = await req.fetchImpl(req.url, {
        method: req.method ?? "POST",
        headers: req.headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: controller.signal,
      });
      const text = await res.text();
      const latencyMs = Date.now() - started;
      const requestId = res.headers.get(req.requestIdHeader);
      if (res.ok) {
        let json: unknown;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          await req.onAttempt({ attempt, ok: false, status: res.status, timedOut: false, outcomeUnknown: false, requestId, latencyMs, error: "Response was not valid JSON." });
          throw new ProviderHttpError("Provider returned a non-JSON response.", res.status, false, requestId, false);
        }
        await req.onAttempt({ attempt, ok: true, status: res.status, timedOut: false, outcomeUnknown: false, requestId, latencyMs, error: null });
        return { json, requestId, latencyMs, attempts: attempt + 1 };
      }
      retryAfter = res.headers.get("retry-after");
      const msg = `HTTP ${res.status}: ${redact(text).slice(0, 300)}`;
      await req.onAttempt({ attempt, ok: false, status: res.status, timedOut: false, outcomeUnknown: false, requestId, latencyMs, error: msg });
      last = new ProviderHttpError(msg, res.status, false, requestId, false);
      if (!RETRYABLE(res.status)) throw last;
    } catch (e) {
      if (e instanceof ProviderHttpError) {
        if (e === last && last.status !== null && RETRYABLE(last.status)) {
          // fall through to retry
        } else throw e;
      } else {
        const latencyMs = Date.now() - started;
        if (req.signal?.aborted) throw new ProviderHttpError("Request cancelled.", null, false, null, true);
        const msg = timedOut ? `Timed out after ${req.timeoutMs} ms.` : `Connection error: ${e instanceof Error ? redact(e.message) : "unknown"}`;
        await req.onAttempt({ attempt, ok: false, status: null, timedOut, outcomeUnknown: true, requestId: null, latencyMs, error: msg });
        last = new ProviderHttpError(msg, null, timedOut, null, true);
      }
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
    }
    if (attempt < req.maxRetries) await sleep(backoffMs(attempt, retryAfter));
  }
  throw last ?? new ProviderHttpError("Request failed.", null, false, null, false);
}
