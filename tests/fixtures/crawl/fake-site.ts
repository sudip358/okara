/** Fake fetch for crawler tests: maps absolute URLs to canned Responses and records every call. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type FakeRoute =
  | { status?: number; body?: string; contentType?: string; headers?: Record<string, string> }
  | ((url: string, init?: RequestInit) => Response | Promise<Response>);

export function fixture(name: string): string {
  return readFileSync(join(process.cwd(), "tests/fixtures/crawl", name), "utf8");
}

export function html(body: string, headers: Record<string, string> = {}): FakeRoute {
  return { status: 200, body, contentType: "text/html; charset=utf-8", headers };
}

export function redirect(to: string, status = 301): FakeRoute {
  return { status, body: "", headers: { location: to } };
}

export function fakeSite(routes: Record<string, FakeRoute>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    const route = routes[url];
    if (typeof route === "function") return route(url, init);
    if (!route) return new Response("<html><body>Not found</body></html>", { status: 404, headers: { "content-type": "text/html" } });
    const headers = new Headers(route.headers ?? {});
    if (route.contentType) headers.set("content-type", route.contentType);
    const status = route.status ?? 200;
    const nullBody = status === 204 || status === 304 || (status >= 300 && status < 400 && !route.body);
    return new Response(nullBody ? null : (route.body ?? ""), { status, headers });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls, urls: () => calls.map((c) => c.url) };
}

/** A body stream that never ends on its own; counts pulled chunks and whether it was cancelled. */
export function endlessStream(chunkSize = 64 * 1024) {
  const state = { pulled: 0, cancelled: false };
  const chunk = new Uint8Array(chunkSize).fill(0x61);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulled++;
      controller.enqueue(chunk);
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}
