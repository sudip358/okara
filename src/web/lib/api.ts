/**
 * Typed API client (contract for all pages). OWNED BY: web-shell module; web-features pages consume it.
 * - Sends credentials (session cookie) and X-CSRF-Token on state-changing requests.
 * - Unwraps { data } / throws ApiError for { error }.
 * - A 401 on any request calls the registered unauthorized handler (the shell redirects to /signin).
 * - A 403 csrf_failed (token rotated by a sign-in in another tab) re-reads /me for the fresh token and retries once,
 *   but only when /me still belongs to the user this tab loaded. A different user (another account signed in
 *   elsewhere) or a 401 calls the unauthorized handler instead, so the write never runs as someone else.
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
/** User id the shell loaded with the token; a CSRF refresh is replayed only for this same user. */
let csrfUserId: string | null = null;
export const setCsrfToken = (t: string | null, userId: string | null = null) => {
  csrfToken = t;
  csrfUserId = t ? userId : null;
};

let unauthorizedHandler: (() => void) | null = null;
/** Registered by the app shell; called when any request returns 401. */
export const setUnauthorizedHandler = (fn: (() => void) | null) => {
  unauthorizedHandler = fn;
};

export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const method = init.method ?? "GET";
  let res = await send(path, method, init);
  if (res.status === 403 && method !== "GET") {
    const peek = (await res.clone().json().catch(() => null)) as { error?: ApiErrorBody } | null;
    if (peek?.error?.code === "csrf_failed" && (await refreshCsrfToken(init.signal))) res = await send(path, method, init);
  }
  const json = (await res.json().catch(() => null)) as { data?: T; error?: ApiErrorBody } | null;
  if (!res.ok || !json || json.error) {
    if (res.status === 401 && unauthorizedHandler && !path.startsWith("/me")) unauthorizedHandler();
    throw new ApiError(res.status, json?.error ?? { code: "network", message: `Request failed (${res.status}).` });
  }
  return json.data as T;
}

function send(path: string, method: string, init: { body?: unknown; signal?: AbortSignal }): Promise<Response> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && csrfToken) headers["X-CSRF-Token"] = csrfToken;
  return fetch(`/api${path}`, {
    method,
    headers,
    credentials: "same-origin",
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
  });
}

/**
 * Re-reads the session's CSRF token from GET /me. True only when there is a new token for the same user this
 * tab loaded. False (no retry) when the token is unchanged, the session is gone (401: unauthorized handler),
 * or the cookie now belongs to another user or the loaded user is unknown (unauthorized handler, so the
 * shell re-reads /me instead of silently acting as someone else).
 */
async function refreshCsrfToken(signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch("/api/me", { headers: { Accept: "application/json" }, credentials: "same-origin", signal });
    if (res.status === 401) {
      unauthorizedHandler?.();
      return false;
    }
    const json = (await res.json().catch(() => null)) as { data?: { csrfToken?: string; user?: { id?: string } } } | null;
    const token = res.ok ? json?.data?.csrfToken : undefined;
    if (!token || token === csrfToken) return false;
    const userId = json?.data?.user?.id;
    if (!csrfUserId || !userId || userId !== csrfUserId) {
      unauthorizedHandler?.();
      return false;
    }
    csrfToken = token;
    return true;
  } catch {
    return false;
  }
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

/**
 * POST whose success response is newline-delimited JSON (Ask Okara `?stream=1`). Same CSRF retry and 401
 * handling as api(); a JSON error response throws ApiError before any event. Calls `onEvent` once per line.
 */
export async function apiStream<E>(path: string, body: unknown, onEvent: (event: E) => void, signal?: AbortSignal): Promise<void> {
  let res = await send(path, "POST", { body, signal });
  if (res.status === 403) {
    const peek = (await res.clone().json().catch(() => null)) as { error?: ApiErrorBody } | null;
    if (peek?.error?.code === "csrf_failed" && (await refreshCsrfToken(signal))) res = await send(path, "POST", { body, signal });
  }
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || !type.includes("ndjson") || !res.body) {
    const json = (await res.json().catch(() => null)) as { error?: ApiErrorBody } | null;
    if (res.status === 401 && unauthorizedHandler) unauthorizedHandler();
    throw new ApiError(res.status, json?.error ?? { code: "network", message: `Request failed (${res.status}).` });
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) {
        try {
          onEvent(JSON.parse(line) as E);
        } catch {
          // a malformed line is skipped; the final "done" event carries the full state
        }
      }
      nl = buffer.indexOf("\n");
    }
    if (done) break;
  }
  const rest = buffer.trim();
  if (rest) {
    try {
      onEvent(JSON.parse(rest) as E);
    } catch {
      // ignored (see above)
    }
  }
}
