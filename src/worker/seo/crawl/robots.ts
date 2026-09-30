/**
 * robots.txt per RFC 9309 (https://www.rfc-editor.org/rfc/rfc9309).
 *  - Group selection: the groups whose user-agent equals our product token (case-insensitive) are
 *    combined; only if none match is the "*" group used. The "*" group is never unioned with a
 *    specific group (a pattern [A20] explicitly avoids).
 *  - Rules support "*" wildcards and a trailing "$" end anchor. The most specific (longest) match wins;
 *    on a tie between allow and disallow, allow wins.
 *  - Crawl-delay (non-standard, widely used) is honoured by the crawler; Sitemap lines are collected.
 *  - Fetch status: 2xx parse; 4xx "unavailable" -> allow all; 5xx / unreachable -> disallow all.
 *    429 is treated like 5xx (conservative).
 * The product token used for matching is the one in the fetch User-Agent header ([A20]).
 */
import { CrawlFetchError, guardedFetch } from "../ssrf";

export const CRAWLER_UA_TOKEN = "OkaraBot";
export const CRAWLER_VERSION = "0.1";
export const crawlerUserAgent = (appOrigin: string) => `${CRAWLER_UA_TOKEN}/${CRAWLER_VERSION} (+${appOrigin.replace(/\/+$/, "")}/bot)`;

export const ROBOTS_MAX_BYTES = 512 * 1024;

export interface RobotsRule {
  allow: boolean;
  path: string;
}
export interface RobotsGroup {
  agents: string[]; // lowercased product tokens, "*" for any
  rules: RobotsRule[];
  crawlDelay: number | null;
}
export interface ParsedRobots {
  groups: RobotsGroup[];
  sitemaps: string[];
}

/** The product token portion of a user-agent line ("Googlebot/2.1" -> "googlebot"). */
function productToken(value: string): string {
  const v = value.trim();
  if (v === "*") return "*";
  const m = /^[A-Za-z_-]+/.exec(v);
  return m ? m[0].toLowerCase() : "";
}

export function parseRobots(text: string): ParsedRobots {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  // Strip a UTF-8 BOM.
  const body = text.replace(/^﻿/, "");
  for (const rawLine of body.split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      const token = productToken(value);
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      if (token) current.agents.push(token);
      lastWasAgent = true;
      continue;
    }
    if (key === "sitemap") {
      if (value) sitemaps.push(value);
      continue; // sitemap lines do not end a group's agent list semantics
    }
    lastWasAgent = false;
    if (!current) continue; // rules before any user-agent line are ignored
    if (key === "allow" || key === "disallow") {
      if (value === "") continue; // empty rule matches nothing
      current.rules.push({ allow: key === "allow", path: value });
    } else if (key === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
    }
  }
  return { groups, sitemaps };
}

/** Combine the groups that apply to `token` (specific groups only; else "*"; else none). */
export function selectGroup(robots: ParsedRobots, token: string): RobotsGroup | null {
  const t = token.toLowerCase();
  const specific = robots.groups.filter((g) => g.agents.includes(t));
  const chosen = specific.length > 0 ? specific : robots.groups.filter((g) => g.agents.includes("*"));
  if (chosen.length === 0) return null;
  const delays = chosen.map((g) => g.crawlDelay).filter((d): d is number => d !== null);
  return {
    agents: [...new Set(chosen.flatMap((g) => g.agents))],
    rules: chosen.flatMap((g) => g.rules),
    crawlDelay: delays.length ? Math.max(...delays) : null,
  };
}

/** Normalize percent-encoding so %2f and %2F compare equal; encode raw non-ASCII. */
function normalizePath(p: string): string {
  let out = p.replace(/%[0-9a-f]{2}/gi, (m) => m.toUpperCase());
  out = out.replace(/[^\x21-\x7e]/g, (ch) => encodeURIComponent(ch));
  return out;
}

function patternToRegex(pattern: string): RegExp {
  const p = normalizePath(pattern);
  const anchored = p.endsWith("$");
  const core = anchored ? p.slice(0, -1) : p;
  const escaped = core
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}${anchored ? "$" : ""}`);
}

/** Longest-match evaluation of a path (+query) against a group. */
export function isPathAllowed(group: RobotsGroup | null, pathAndQuery: string): boolean {
  if (!group) return true;
  const target = normalizePath(pathAndQuery || "/");
  if (target === "/robots.txt") return true;
  let best: { len: number; allow: boolean } | null = null;
  for (const rule of group.rules) {
    if (!patternToRegex(rule.path).test(target)) continue;
    const len = normalizePath(rule.path).length;
    if (!best || len > best.len || (len === best.len && rule.allow && !best.allow)) best = { len, allow: rule.allow };
  }
  return best ? best.allow : true;
}

export type RobotsStatus = "ok" | "not_found" | "unreachable";

export interface RobotsState {
  status: RobotsStatus;
  httpStatus: number | null;
  parsed: ParsedRobots;
  note: string;
}

export function robotsAllows(state: RobotsState, token: string, url: string | URL): boolean {
  if (state.status === "not_found") return true;
  if (state.status === "unreachable") return false;
  const u = new URL(String(url));
  return isPathAllowed(selectGroup(state.parsed, token), u.pathname + u.search);
}

export function robotsCrawlDelay(state: RobotsState, token: string): number | null {
  if (state.status !== "ok") return null;
  return selectGroup(state.parsed, token)?.crawlDelay ?? null;
}

/** Fetch /robots.txt through the SSRF guard (512 KB cap). */
export async function fetchRobots(
  fetchImpl: typeof fetch,
  verifiedHost: string,
  userAgent: string,
  opts: { timeoutMs?: number } = {},
): Promise<RobotsState> {
  const empty: ParsedRobots = { groups: [], sitemaps: [] };
  try {
    const res = await guardedFetch(fetchImpl, `https://${verifiedHost}/robots.txt`, {
      verifiedHost,
      maxBytes: ROBOTS_MAX_BYTES,
      timeoutMs: opts.timeoutMs ?? 10_000,
      maxRedirects: 5,
      kind: "robots",
      lenientContentType: true,
      truncateAtCap: true,
      userAgent,
    });
    if (res.status >= 200 && res.status < 300) {
      return { status: "ok", httpStatus: res.status, parsed: parseRobots(res.body), note: `robots.txt fetched (${res.status})${res.truncated ? "; truncated at 512 KB" : ""}.` };
    }
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      return { status: "not_found", httpStatus: res.status, parsed: empty, note: `robots.txt returned ${res.status}; treated as allow-all (RFC 9309).` };
    }
    return { status: "unreachable", httpStatus: res.status, parsed: empty, note: `robots.txt returned ${res.status}; treated as disallow-all (RFC 9309).` };
  } catch (e) {
    const code = e instanceof CrawlFetchError ? e.code : "error";
    if (code === "non_html") {
      // A 2xx robots.txt with a binary content type: unparseable, treat as unreachable (conservative).
      return { status: "unreachable", httpStatus: null, parsed: empty, note: "robots.txt had an unreadable content type; treated as disallow-all." };
    }
    return { status: "unreachable", httpStatus: null, parsed: empty, note: `robots.txt unreachable (${code}); treated as disallow-all (RFC 9309).` };
  }
}
