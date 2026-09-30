/**
 * Typed API client (contract for all pages). OWNED BY: web-shell module; web-features pages consume it.
 * - Sends credentials (session cookie) and X-CSRF-Token on state-changing requests.
 * - Unwraps { data } / throws ApiError for { error }.
 */
import type { ApiErrorBody } from "@shared/types";

export class ApiError extends Error {
  constructor(public status: number, public body: ApiErrorBody) {
    super(body.message);
  }
}

let csrfToken: string | null = null;
export const setCsrfToken = (t: string | null) => {
  csrfToken = t;
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
    throw new ApiError(res.status, json?.error ?? { code: "network", message: `Request failed (${res.status}).` });
  }
  return json.data as T;
}
