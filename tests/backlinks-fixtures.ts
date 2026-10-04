/**
 * Backlink monitor fixtures: a SYNTHETIC "Built Links" tab (same header row as the owner's master sheet; no real
 * rows), article HTML builders and a fake fetch that records every request. Hosts are example.* names.
 */
import type { CheckDeps } from "@worker/backlinks/check";

export const OUR_HOST = "shop.example.com";
export const T = (path: string) => `https://${OUR_HOST}${path}`;

/** Header row of the Built Links tab: the vendor column's header is a number ("3"). */
export const BUILT_LINKS_HEADERS = ["3", "Type", "Date", "Live URL", "Anchor 1", "Target", "Anchor 2", "Target 2", "DA", "Traffic", "Price"];

export function builtLinksCsv(rows: string[][], headers: string[] = BUILT_LINKS_HEADERS): string {
  const cell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [headers, ...rows].map((r) => r.map(cell).join(",")).join("\n");
}

/** Six synthetic rows: two with a second (anchor, target) pair, one bad live URL, one off-site target. */
export const BUILT_LINKS_ROWS: string[][] = [
  ["VendorA", "Guest Post", "2026-09-01", "https://decor-blog.example.net/brass-hardware-guide", "brass cabinet pulls", T("/collections/pulls"), "", "", "42", "1,200", "$150"],
  ["VendorB", "Niche Edit", "2026-09-03", "https://home-ideas.example.org/kitchen-refresh", "kitchen knobs", T("/collections/knobs"), "solid brass hinges", T("/collections/hinges"), "35", "800", "$90"],
  ["VendorA", "Digital PR", "2026-09-05", "https://news.example.com/design-trends", "Residence Example", T("/"), "", "", "70", "50000", "$400"],
  ["VendorC", "Guest Post", "2026-09-07", "http://127.0.0.1/admin", "x", T("/collections/pulls"), "", "", "", "", ""],
  ["VendorC", "Guest Post", "2026-09-08", "https://other-blog.example.net/post", "y", "https://elsewhere.example.org/page", "", "", "", "", ""],
  ["VendorB", "Niche Edit", "2026-09-09", "home-ideas.example.org/lighting", "pendant lights", "/collections/lighting", "", "", "28", "", "$60"],
];

export const UA = "OkaraBot/0.1 (+http://localhost:5173/bot)";

export function article(body: string, head = ""): string {
  return `<!doctype html><html><head><title>Article</title>${head}</head><body><article>${body}</article></body></html>`;
}

export type Route = { status: number; body?: string; headers?: Record<string, string> } | (() => { status: number; body?: string; headers?: Record<string, string> }) | Error;

/** A fake platform fetch: exact URL routes; unknown robots.txt -> 404 (allow all); anything else -> network error. */
export function fakeFetch(routes: Record<string, Route>) {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    expectManual(init);
    let r = routes[url];
    if (r === undefined && url.endsWith("/robots.txt")) r = { status: 404, body: "" };
    if (r === undefined) throw new TypeError(`fetch failed: ${url}`);
    if (r instanceof Error) throw r;
    const spec = typeof r === "function" ? r() : r;
    const headers = new Headers(spec.headers ?? {});
    if (!headers.has("content-type") && spec.status >= 200 && spec.status < 300) headers.set("content-type", url.endsWith("/robots.txt") ? "text/plain" : "text/html; charset=utf-8");
    const nullBody = [204, 301, 302, 303, 307, 308].includes(spec.status) || spec.body === undefined;
    return new Response(nullBody ? null : spec.body, { status: spec.status, headers });
  }) as typeof fetch;
  return { fetch: f, calls };
}

function expectManual(init?: RequestInit) {
  if (init?.redirect !== "manual") throw new Error("fetch must use redirect: manual");
}

export function deps(fetchImpl: typeof fetch): CheckDeps & { slept: number[] } {
  let now = 1_700_000_000_000;
  const slept: number[] = [];
  return {
    fetchImpl,
    userAgent: UA,
    clock: () => now,
    sleep: async (ms: number) => {
      slept.push(ms);
      now += ms;
    },
    slept,
  };
}
