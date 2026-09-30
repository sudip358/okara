/**
 * Typed API client (contract for all pages). OWNED BY: web-shell module; web-features pages consume it.
 * - Sends credentials (session cookie) and X-CSRF-Token on state-changing requests.
 * - Unwraps { data } / throws ApiError for { error }.
 * - A 401 on any request calls the registered unauthorized handler (the shell redirects to /signin).
 */
import type { ApiErrorBody } from "@shared/types";

export class ApiError extends Error {
  constructor(public status: number, public body: ApiErrorBody) {
    super(body.message);
  }
  get code(): string {
    return this.body.code;
  }
}

let csrfToken: string | null = null;
export const setCsrfToken = (t: string | null) => {
  csrfToken = t;
};

let unauthorizedHandler: (() => void) | null = null;
/** Registered by the app shell; called when any request returns 401. */
export const setUnauthorizedHandler = (fn: (() => void) | null) => {
  unauthorizedHandler = fn;
};

export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && csrfToken) headers["X-CSRF-Token"] = csrfToken;
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: "same-origin",
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
  });
  const json = (await res.json().catch(() => null)) as { data?: T; error?: ApiErrorBody } | null;
  if (!res.ok || !json || json.error) {
    if (res.status === 401 && unauthorizedHandler && !path.startsWith("/me")) unauthorizedHandler();
    throw new ApiError(res.status, json?.error ?? { code: "network", message: `Request failed (${res.status}).` });
  }
  return json.data as T;
}

/** Human-readable message for any thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message || `Request failed (${err.status}).`;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

/** True when the error means a capability needs configuration (HTTP 412 / code setup_required). */
export function isSetupRequired(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 412 || err.code === "setup_required");
}

/** True when the error is a quota / rate limit (HTTP 429 / code rate_limited or quota_exceeded). */
export function isRateLimited(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 429 || err.code === "rate_limited" || err.code === "quota_exceeded" || err.code === "budget_exceeded");
}
