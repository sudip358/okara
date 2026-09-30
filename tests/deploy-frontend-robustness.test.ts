/** Deploy-readiness (frontend): stale-chunk recovery [L9], CSRF refresh-and-retry [L10], safe provider hrefs [L14]. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { isChunkLoadError, reloadOnce, RELOAD_GUARD_MS } from "@web/components/chunk-reload";

// api.ts (DOM RequestInit) and ExternalUrl.tsx (JSX) are outside the worker tsconfig that typechecks tests,
// so they are imported by path at runtime with the minimal types the tests need.
const webModule = (rel: string) => new URL(`../src/web/${rel}`, import.meta.url).pathname;
type ApiModule = {
  api: <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;
  ApiError: new (...args: never[]) => Error;
  setCsrfToken: (t: string | null) => void;
};
const { api, ApiError, setCsrfToken } = (await import(/* @vite-ignore */ webModule("lib/api.ts"))) as ApiModule;
const { ExternalUrl } = (await import(/* @vite-ignore */ webModule("components/ExternalUrl.tsx"))) as { ExternalUrl: ComponentType<{ url: string }> };

describe("[L9] stale route chunk detection and one-time reload", () => {
  it("recognises failed dynamic imports across browsers, and nothing else", () => {
    expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: https://app.example/assets/Usage-abc.js"))).toBe(true);
    expect(isChunkLoadError(new TypeError("error loading dynamically imported module: https://app.example/assets/x.js"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isChunkLoadError(new Error("Unable to preload CSS for /assets/x.css"))).toBe(true);
    expect(isChunkLoadError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });

  function memStore() {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  }

  it("reloads once, then not again inside the guard window, then again after it", () => {
    const store = memStore();
    const reload = vi.fn();
    let now = 1_000_000;
    const deps = { storage: () => store, reload, now: () => now };
    expect(reloadOnce(deps)).toBe(true);
    expect(reloadOnce(deps)).toBe(false);
    now += RELOAD_GUARD_MS + 1;
    expect(reloadOnce(deps)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("never auto-reloads when sessionStorage is missing or throws (no reload loop possible)", () => {
    const reload = vi.fn();
    const throwing = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => undefined,
    };
    expect(reloadOnce({ storage: () => throwing, reload, now: () => 1 })).toBe(false);
    expect(reloadOnce({ storage: () => null, reload, now: () => 1 })).toBe(false);
    expect(
      reloadOnce({
        storage: () => {
          throw new Error("denied");
        },
        reload,
        now: () => 1,
      }),
    ).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("[L10] api(): 403 csrf_failed refreshes the token from /me and retries once", () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  let calls: Array<{ url: string; method: string; csrf: string | undefined }>;

  beforeEach(() => {
    calls = [];
    setCsrfToken("stale");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setCsrfToken(null);
  });

  function stub(handler: (url: string, method: string, csrf: string | undefined) => Response) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const csrf = (init?.headers as Record<string, string> | undefined)?.["X-CSRF-Token"];
        calls.push({ url, method, csrf });
        return handler(url, method, csrf);
      }),
    );
  }

  it("retries the write with the fresh token and returns its data", async () => {
    stub((url, _m, csrf) => {
      if (url === "/api/me") return json(200, { data: { csrfToken: "fresh" } });
      return csrf === "fresh" ? json(200, { data: { ok: true } }) : json(403, { error: { code: "csrf_failed", message: "CSRF check failed." } });
    });
    await expect(api<{ ok: boolean }>("/projects/p1/runs", { method: "POST", body: {} })).resolves.toEqual({ ok: true });
    expect(calls.map((c) => `${c.method} ${c.url} ${c.csrf ?? "-"}`)).toEqual(["POST /api/projects/p1/runs stale", "GET /api/me -", "POST /api/projects/p1/runs fresh"]);

    // The fresh token is kept for later writes.
    await api("/projects/p1/runs", { method: "POST", body: {} });
    expect(calls.at(-1)?.csrf).toBe("fresh");
  });

  it("retries at most once and surfaces the 403 when the token is unchanged or the session is gone", async () => {
    stub((url) => (url === "/api/me" ? json(200, { data: { csrfToken: "stale" } }) : json(403, { error: { code: "csrf_failed", message: "x" } })));
    await expect(api("/projects/p1/runs", { method: "POST" })).rejects.toMatchObject({ status: 403, code: "csrf_failed" });
    expect(calls).toHaveLength(2);

    calls = [];
    stub((url) => (url === "/api/me" ? json(401, { error: { code: "unauthorized", message: "x" } }) : json(403, { error: { code: "csrf_failed", message: "x" } })));
    await expect(api("/projects/p1/runs", { method: "POST" })).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(2);
  });

  it("does not refresh on other 403s", async () => {
    stub(() => json(403, { error: { code: "forbidden", message: "no" } }));
    await expect(api("/projects/p1", { method: "DELETE" })).rejects.toMatchObject({ status: 403, code: "forbidden" });
    expect(calls).toHaveLength(1);
  });
});

describe("[L14] provider/crawl URLs only become links when http(s)", () => {
  const render = (url: string) => renderToStaticMarkup(createElement(ExternalUrl, { url }));

  it("links http(s) URLs with safe rel attributes", () => {
    const html = render("https://example.com/a?b=1");
    expect(html).toContain('href="https://example.com/a?b=1"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it("renders javascript:, data: and unparsable URLs as plain text with no href", () => {
    for (const u of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>alert(1)</script>", "not a url"]) {
      const html = render(u);
      expect(html).not.toContain("href=");
      expect(html.startsWith("<span")).toBe(true);
    }
  });
});
