/** Deploy-readiness round 2 (web): CSRF refresh replays a write only for the same user; a 401 on refresh signs out. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// api.ts uses DOM types outside the worker tsconfig that typechecks tests: import by path with local types.
const webModule = (rel: string) => new URL(`../src/web/${rel}`, import.meta.url).pathname;
type ApiModule = {
  api: <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;
  setCsrfToken: (t: string | null, userId?: string | null) => void;
  setUnauthorizedHandler: (fn: (() => void) | null) => void;
};
const { api, setCsrfToken, setUnauthorizedHandler } = (await import(/* @vite-ignore */ webModule("lib/api.ts"))) as ApiModule;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const csrfFailed = () => json(403, { error: { code: "csrf_failed", message: "CSRF check failed." } });

describe("refreshCsrfToken: same-user check and 401 handling", () => {
  let calls: string[];
  let onUnauthorized: ReturnType<typeof vi.fn<() => void>>;

  function stub(me: () => Response) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const csrf = (init?.headers as Record<string, string> | undefined)?.["X-CSRF-Token"];
        calls.push(`${method} ${url} ${csrf ?? "-"}`);
        if (url === "/api/me") return me();
        return csrf === "fresh" ? json(200, { data: { ok: true } }) : csrfFailed();
      }),
    );
  }

  beforeEach(() => {
    calls = [];
    onUnauthorized = vi.fn<() => void>();
    setUnauthorizedHandler(onUnauthorized);
    setCsrfToken("stale", "user-x");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setUnauthorizedHandler(null);
    setCsrfToken(null);
  });

  it("retries once when /me still belongs to the loaded user", async () => {
    stub(() => json(200, { data: { csrfToken: "fresh", user: { id: "user-x" } } }));
    await expect(api("/projects/p1/runs", { method: "POST" })).resolves.toEqual({ ok: true });
    expect(calls).toEqual(["POST /api/projects/p1/runs stale", "GET /api/me -", "POST /api/projects/p1/runs fresh"]);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("does not replay the write as a different user; calls the unauthorized handler", async () => {
    stub(() => json(200, { data: { csrfToken: "fresh", user: { id: "user-y" } } }));
    await expect(api("/projects/p1", { method: "DELETE" })).rejects.toMatchObject({ status: 403, code: "csrf_failed" });
    expect(calls).toEqual(["DELETE /api/projects/p1 stale", "GET /api/me -"]);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    // The fresh token was not adopted: a later write still carries the old one.
    calls = [];
    await api("/projects/p1", { method: "DELETE" }).catch(() => undefined);
    expect(calls[0]).toBe("DELETE /api/projects/p1 stale");
  });

  it("does not replay when the loaded user is unknown or /me has no user id", async () => {
    setCsrfToken("stale");
    stub(() => json(200, { data: { csrfToken: "fresh", user: { id: "user-x" } } }));
    await expect(api("/projects/p1/runs", { method: "POST" })).rejects.toMatchObject({ status: 403 });
    expect(calls).toHaveLength(2);

    calls = [];
    setCsrfToken("stale", "user-x");
    stub(() => json(200, { data: { csrfToken: "fresh" } }));
    await expect(api("/projects/p1/runs", { method: "POST" })).rejects.toMatchObject({ status: 403 });
    expect(calls).toHaveLength(2);
  });

  it("a 401 from the refresh calls the unauthorized handler (send to sign-in)", async () => {
    stub(() => json(401, { error: { code: "unauthorized", message: "x" } }));
    await expect(api("/projects/p1/runs", { method: "POST" })).rejects.toMatchObject({ status: 403, code: "csrf_failed" });
    expect(calls).toHaveLength(2);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("an unchanged token does not retry and does not sign out", async () => {
    stub(() => json(200, { data: { csrfToken: "stale", user: { id: "user-x" } } }));
    await expect(api("/projects/p1/runs", { method: "POST" })).rejects.toMatchObject({ status: 403 });
    expect(calls).toHaveLength(2);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
