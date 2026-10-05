/**
 * Backlink checker: one owner-listed backlink (live article URL -> our target URL) per call. Pure of D1: the caller
 * (jobs.ts) loads the job cache, passes a fetch budget, and stores the result.
 *
 * OWNER-APPROVED EXCEPTION to "crawl only verified hosts" (docs/build-kit.md [A38], 2026-10-04). The article pages are
 * on third-party hosts. Guards:
 *   - URLs come only from the owner's own sheet/CSV import (backlinks.live_url), never from model output; a redirect
 *     Location is followed only after the hop is re-validated;
 *   - every request goes through seo/ssrf.ts publicExternalFetch: http(s) only, no userinfo, default port, public
 *     hostnames only (every IP literal and local name refused, at every redirect hop), manual redirects (<= 5 hops,
 *     chain recorded), one 15 s timeout, streamed 2 MB cap (the first 2 MB are analysed, "truncated" noted), HTML
 *     content types only;
 *   - robots.txt of each host (per scheme + host, RFC 9309) is read once per check job and respected for our crawler
 *     token (OkaraBot, the crawl's honest User-Agent); a disallowed page is not fetched (status robots_blocked); an
 *     unreachable robots.txt (5xx / network) is treated as disallow-all, a 4xx as allow-all, like the crawl;
 *   - at most 1 request per second per host (robots Crawl-delay honoured up to 10 s) and at most
 *     FETCHES_PER_INVOCATION requests per invocation (robots.txt, redirect hops and our own target checks included):
 *     a check that would exceed the budget stops before the request and is retried in the next batch;
 *   - only compact facts are kept (status, final URL, chain, robots/meta verdicts, the links to our site with rel and
 *     plain anchor text); page text is never stored and never sent to a model.
 * Our own target URL is checked on the verified host with the crawl's guard (seo/ssrf.ts guardedFetch) and robots.txt.
 */
import { anchorsMatch, HOST_INTERVAL_MS, MAX_REDIRECT_HOPS, PAGE_MAX_BYTES, PAGE_TIMEOUT_MS, type BacklinkFoundLink, type BacklinkStatus, type LinkRel } from "@shared/backlinks";
import { linkUrlKey } from "@shared/import";
import { CRAWLER_UA_TOKEN, isPathAllowed, parseRobots, ROBOTS_MAX_BYTES, selectGroup, type RobotsGroup, type RobotsStatus } from "../seo/crawl/robots";
import { assertPublicExternalUrl, CrawlFetchError, guardedFetch, normalizeHost, publicExternalFetch, type GuardedResponse } from "../seo/ssrf";
import { analyzePage, parseXRobotsTag } from "./html";

export const ROBOTS_TIMEOUT_MS = 10_000;
export const TARGET_TIMEOUT_MS = 10_000;
/** Bytes of our target page read (status check only; the body is not analysed). */
export const TARGET_MAX_BYTES = 64 * 1024;
export const MAX_CRAWL_DELAY_MS = 10_000;
const MAX_ROBOTS_RULES = 500;

// ------------------------------------------------------------------ budget + cache
/** Thrown before a request that would exceed the invocation's fetch budget; the backlink is retried next batch. */
export class FetchBudgetExhausted extends Error {
  constructor() {
    super("Fetch budget for this invocation is used up.");
    this.name = "FetchBudgetExhausted";
  }
}

export interface FetchBudget {
  limit: number;
  used: number;
}

export interface RobotsVerdict {
  status: RobotsStatus;
  httpStatus: number | null;
  /** The group selected for our token (rules capped), null = no group applies (allow-all). */
  group: RobotsGroup | null;
}

export interface TargetResult {
  status: number | null;
  finalUrl: string | null;
  error: string | null;
}

/** Per-job cache (persisted in backlink_job_cache between invocations). Keys: robots origin, host, target key. */
export interface JobCache {
  robots: Map<string, RobotsVerdict>;
  /** Last request time (ms) per host. */
  pace: Map<string, number>;
  targets: Map<string, TargetResult>;
  /** Cache keys changed in this invocation (written back by the caller). */
  dirty: Set<string>;
}

export const emptyCache = (): JobCache => ({ robots: new Map(), pace: new Map(), targets: new Map(), dirty: new Set() });

/**
 * Owner decision (2026-10-05, "don't respect robots.txt for backlink monitor"): the backlink checker verifies the
 * owner's own placed links on single article URLs from the owner's sheet, so robots.txt is NOT consulted by default.
 * Still enforced: the public-host SSRF guard, the honest User-Agent, >= 1 s between requests per host, the per-
 * invocation request cap. Our own site's crawl (seo/crawl) keeps respecting robots.txt.
 */
export const BACKLINK_RESPECT_ROBOTS = false;

export interface CheckDeps {
  fetchImpl: typeof fetch;
  userAgent: string;
  /** Consult robots.txt before fetching an article (default BACKLINK_RESPECT_ROBOTS). */
  respectRobots?: boolean;
  /** Wall-clock milliseconds (tests inject a fake clock). */
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface CheckTarget {
  /** Our host (the project's verified host, or the site URL's host when unverified). */
  ourHost: string;
  /** Verified host for our own target checks; null = the site is not verified (target not checked). */
  verifiedHost: string | null;
}

export interface CheckInput {
  liveUrl: string;
  targetUrl: string;
  anchorExpected: string | null;
}

export interface CheckResult {
  status: BacklinkStatus;
  statusReason: string | null;
  linkRel: LinkRel | null;
  httpStatus: number | null;
  finalUrl: string | null;
  redirectChain: Array<{ status: number; to: string }>;
  /** robots.txt verdict for the article's host: allowed | disallowed | unreachable | not_found. */
  robots: string | null;
  metaRobots: string | null;
  xRobotsTag: string | null;
  pageNoindex: boolean;
  pageNofollow: boolean;
  canonicalUrl: string | null;
  linkMatch: "target" | "host" | "none" | null;
  links: BacklinkFoundLink[];
  relText: string | null;
  anchorFound: string | null;
  anchorMatch: boolean | null;
  targetStatus: number | null;
  targetFinalUrl: string | null;
  targetError: string | null;
  errorCode: string | null;
  fetches: number;
  bytes: number;
  truncated: boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ request accounting
class Requester {
  readonly clock: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  fetches = 0;
  constructor(
    private readonly budget: FetchBudget,
    private readonly cache: JobCache,
    deps: CheckDeps,
  ) {
    this.clock = deps.clock ?? (() => Date.now());
    this.sleep = deps.sleep ?? defaultSleep;
  }

  /** Before every request: budget first (no request, no wait when it is used up), then per-host politeness. */
  async before(host: string, crawlDelayMs = 0): Promise<void> {
    if (this.budget.used >= this.budget.limit) throw new FetchBudgetExhausted();
    const h = normalizeHost(host);
    const last = this.cache.pace.get(h);
    const interval = Math.max(HOST_INTERVAL_MS, Math.min(crawlDelayMs, MAX_CRAWL_DELAY_MS));
    if (last !== undefined) {
      const wait = last + interval - this.clock();
      if (wait > 0) await this.sleep(wait);
    }
    this.budget.used++;
    this.fetches++;
    this.cache.pace.set(h, this.clock());
    this.cache.dirty.add(`pace:${h}`);
  }
}

// ------------------------------------------------------------------ robots
export const robotsKey = (u: URL) => `${u.protocol}//${normalizeHost(u.hostname)}`;

async function robotsFor(origin: URL, req: Requester, cache: JobCache, deps: CheckDeps): Promise<RobotsVerdict> {
  const key = robotsKey(origin);
  const hit = cache.robots.get(key);
  if (hit) return hit;
  let verdict: RobotsVerdict;
  try {
    const res = await publicExternalFetch(deps.fetchImpl, `${key}/robots.txt`, {
      maxBytes: ROBOTS_MAX_BYTES,
      timeoutMs: ROBOTS_TIMEOUT_MS,
      maxRedirects: MAX_REDIRECT_HOPS,
      kind: "robots",
      lenientContentType: true,
      truncateAtCap: true,
      userAgent: deps.userAgent,
      beforeRequest: (u) => req.before(u.hostname),
    });
    if (res.status >= 200 && res.status < 300) {
      const g = selectGroup(parseRobots(res.body), CRAWLER_UA_TOKEN);
      verdict = { status: "ok", httpStatus: res.status, group: g ? { ...g, rules: g.rules.slice(0, MAX_ROBOTS_RULES) } : null };
    } else if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      verdict = { status: "not_found", httpStatus: res.status, group: null };
    } else {
      verdict = { status: "unreachable", httpStatus: res.status, group: null };
    }
  } catch (e) {
    if (e instanceof FetchBudgetExhausted) throw e;
    verdict = { status: "unreachable", httpStatus: null, group: null };
  }
  cache.robots.set(key, verdict);
  cache.dirty.add(`robots:${key}`);
  return verdict;
}

export function robotsAllowsUrl(v: RobotsVerdict, u: URL): boolean {
  if (v.status === "not_found") return true;
  if (v.status === "unreachable") return false;
  return isPathAllowed(v.group, u.pathname + u.search);
}

const robotsWord = (v: RobotsVerdict, allowed: boolean) => (v.status === "unreachable" ? "unreachable" : v.status === "not_found" ? "not_found" : allowed ? "allowed" : "disallowed");

class RobotsBlocked extends Error {
  constructor(
    readonly url: URL,
    readonly unreachable: boolean,
  ) {
    super("robots.txt disallows");
  }
}

// ------------------------------------------------------------------ our target URL
async function checkTarget(targetUrl: string, site: CheckTarget, req: Requester, cache: JobCache, deps: CheckDeps): Promise<TargetResult> {
  const key = linkUrlKey(targetUrl);
  const hit = cache.targets.get(key);
  if (hit) return hit;
  let result: TargetResult;
  if (!site.verifiedHost) {
    result = { status: null, finalUrl: null, error: "not_checked" };
  } else {
    let url: URL;
    try {
      url = new URL(targetUrl);
      // The sheet may list the www. twin of the verified host: our pages are checked on the verified host only.
      if (normalizeHost(url.hostname).replace(/^www\./, "") === normalizeHost(site.verifiedHost).replace(/^www\./, "")) url.hostname = site.verifiedHost;
      url.protocol = "https:";
    } catch {
      result = { status: null, finalUrl: null, error: "invalid_url" };
      cache.targets.set(key, result);
      cache.dirty.add(`target:${key}`);
      return result;
    }
    const verified = site.verifiedHost;
    const okey = robotsKey(new URL(`https://${verified}/`));
    let robots = cache.robots.get(okey);
    if (!robots) {
      const counted = countingFetch(deps.fetchImpl, req);
      try {
        const res = await guardedFetch(counted.fetch, `https://${verified}/robots.txt`, {
          verifiedHost: verified,
          maxBytes: ROBOTS_MAX_BYTES,
          timeoutMs: ROBOTS_TIMEOUT_MS,
          maxRedirects: MAX_REDIRECT_HOPS,
          kind: "robots",
          lenientContentType: true,
          truncateAtCap: true,
          userAgent: deps.userAgent,
        });
        if (res.status >= 200 && res.status < 300) {
          const g = selectGroup(parseRobots(res.body), CRAWLER_UA_TOKEN);
          robots = { status: "ok", httpStatus: res.status, group: g ? { ...g, rules: g.rules.slice(0, MAX_ROBOTS_RULES) } : null };
        } else if (res.status >= 400 && res.status < 500 && res.status !== 429) robots = { status: "not_found", httpStatus: res.status, group: null };
        else robots = { status: "unreachable", httpStatus: res.status, group: null };
      } catch {
        if (counted.exhausted) throw new FetchBudgetExhausted();
        robots = { status: "unreachable", httpStatus: null, group: null };
      }
      cache.robots.set(okey, robots);
      cache.dirty.add(`robots:${okey}`);
    }
    if (!robotsAllowsUrl(robots, url)) {
      result = { status: null, finalUrl: null, error: "robots_blocked" };
    } else {
      const counted = countingFetch(deps.fetchImpl, req);
      try {
        const res = await guardedFetch(counted.fetch, url.toString(), {
          verifiedHost: verified,
          maxBytes: TARGET_MAX_BYTES,
          timeoutMs: TARGET_TIMEOUT_MS,
          maxRedirects: MAX_REDIRECT_HOPS,
          kind: "html",
          lenientContentType: true,
          truncateAtCap: true,
          userAgent: deps.userAgent,
        });
        result = { status: res.status, finalUrl: res.finalUrl !== url.toString() ? res.finalUrl : null, error: null };
      } catch (e) {
        if (counted.exhausted) throw new FetchBudgetExhausted();
        result = { status: null, finalUrl: null, error: e instanceof CrawlFetchError ? e.code : "error" };
      }
    }
  }
  cache.targets.set(key, result);
  cache.dirty.add(`target:${key}`);
  return result;
}

/**
 * guardedFetch (our verified host) follows same-host redirects itself; this wrapper puts every request of it, hops
 * included, through the budget and per-host pacing. guardedFetch turns a throwing fetch into a network error, so the
 * wrapper remembers that the budget ran out and the caller rethrows FetchBudgetExhausted.
 */
function countingFetch(f: typeof fetch, req: Requester): { fetch: typeof fetch; exhausted: boolean } {
  const out = {
    exhausted: false,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      try {
        await req.before(u.hostname);
      } catch (e) {
        if (e instanceof FetchBudgetExhausted) out.exhausted = true;
        throw e;
      }
      return f(input, init);
    }) as typeof fetch,
  };
  return out;
}

// ------------------------------------------------------------------ the check
const relText = (links: BacklinkFoundLink[]) => {
  const rels = [...new Set(links.map((l) => l.rel ?? "(none)"))];
  return rels.length ? rels.join(" | ").slice(0, 200) : null;
};

/**
 * Check one backlink. Throws FetchBudgetExhausted when the budget ran out before a needed request (nothing to store;
 * the caller retries the backlink in the next batch; robots/target results already fetched stay cached).
 */
export async function checkBacklink(input: CheckInput, site: CheckTarget, cache: JobCache, budget: FetchBudget, deps: CheckDeps): Promise<CheckResult> {
  const req = new Requester(budget, cache, deps);
  const result: CheckResult = {
    status: "fetch_failed",
    statusReason: null,
    linkRel: null,
    httpStatus: null,
    finalUrl: null,
    redirectChain: [],
    robots: null,
    metaRobots: null,
    xRobotsTag: null,
    pageNoindex: false,
    pageNofollow: false,
    canonicalUrl: null,
    linkMatch: null,
    links: [],
    relText: null,
    anchorFound: null,
    anchorMatch: null,
    targetStatus: null,
    targetFinalUrl: null,
    targetError: null,
    errorCode: null,
    fetches: 0,
    bytes: 0,
    truncated: false,
  };
  // Our target first (cheap, deduplicated per job): its result is part of every check.
  const target = await checkTarget(input.targetUrl, site, req, cache, deps);
  result.targetStatus = target.status;
  result.targetFinalUrl = target.finalUrl;
  result.targetError = target.error;

  let start: URL;
  try {
    // The same guard as every request: a stored live URL that is not a public http(s) URL is never requested.
    start = assertPublicExternalUrl(input.liveUrl);
  } catch {
    return { ...result, status: "fetch_failed", errorCode: "blocked_url", statusReason: fetchErrorText("blocked_url", null), fetches: req.fetches };
  }

  let res: GuardedResponse;
  try {
    const useRobots = deps.respectRobots ?? BACKLINK_RESPECT_ROBOTS;
    const first: RobotsVerdict = useRobots ? await robotsFor(start, req, cache, deps) : { status: "not_found", httpStatus: null, group: null };
    const firstAllowed = robotsAllowsUrl(first, start);
    result.robots = useRobots ? robotsWord(first, firstAllowed) : "not_consulted";
    if (!firstAllowed) throw new RobotsBlocked(start, first.status === "unreachable");
    res = await publicExternalFetch(deps.fetchImpl, start.toString(), {
      maxBytes: PAGE_MAX_BYTES,
      timeoutMs: PAGE_TIMEOUT_MS,
      maxRedirects: MAX_REDIRECT_HOPS,
      kind: "html",
      truncateAtCap: true,
      userAgent: deps.userAgent,
      onRedirect: (hop) => result.redirectChain.push(hop),
      beforeRequest: async (u, hop) => {
        const v = hop === 0 || !useRobots ? first : await robotsFor(u, req, cache, deps);
        if (hop > 0 && !robotsAllowsUrl(v, u)) throw new RobotsBlocked(u, v.status === "unreachable");
        await req.before(u.hostname, (v.group?.crawlDelay ?? 0) * 1000);
      },
    });
  } catch (e) {
    if (e instanceof FetchBudgetExhausted) throw e;
    result.fetches = req.fetches;
    if (e instanceof RobotsBlocked) {
      const offsite = linkUrlKey(e.url.toString()) !== linkUrlKey(start.toString());
      return {
        ...result,
        status: "robots_blocked",
        finalUrl: offsite ? e.url.toString() : null,
        statusReason: e.unreachable
          ? `robots.txt of ${e.url.hostname} could not be read; treated as disallow-all (RFC 9309), so the page was not fetched.`
          : `robots.txt of ${e.url.hostname} disallows ${CRAWLER_UA_TOKEN}; the page was not fetched.`,
      };
    }
    const code = e instanceof CrawlFetchError ? e.code : "error";
    return { ...result, status: "fetch_failed", errorCode: code, statusReason: fetchErrorText(code, e) };
  }
  result.fetches = req.fetches;
  result.bytes = res.bytes;
  return classifyLoadedPage(result, { status: res.status, finalUrl: res.finalUrl, startUrl: start.toString(), body: res.body, xRobotsTag: res.headers.get("x-robots-tag"), truncated: res.truncated }, input, site);
}

/** A loaded article page (plain fetch or headless browser), as the classification needs it. */
export interface LoadedPage {
  /** HTTP status of the main document response. */
  status: number;
  /** URL after redirects. */
  finalUrl: string;
  /** The URL that was requested first (the stored live URL, validated). */
  startUrl: string;
  /** HTML (plain: the response body; browser: the rendered DOM serialized by page.content()). */
  body: string;
  xRobotsTag: string | null;
  truncated: boolean;
}

/**
 * Status / rel / anchor / page-level robots classification of a loaded page. Shared by the plain checker and the
 * browser re-check (browser.ts) so both apply identical rules: page_error for >= 400, dofollow when any matching link is
 * followable and the page does not nofollow every link, redirected when the article moved to another URL, etc.
 * `base` carries the fields already known (target result, redirect chain, robots, fetches).
 */
export function classifyLoadedPage(base: CheckResult, page: LoadedPage, input: CheckInput, site: CheckTarget): CheckResult {
  const result: CheckResult = { ...base };
  const targetKey = linkUrlKey(input.targetUrl);
  result.httpStatus = page.status;
  result.truncated = page.truncated;
  const movedOff = linkUrlKey(page.finalUrl) !== linkUrlKey(page.startUrl);
  result.finalUrl = page.finalUrl !== page.startUrl ? page.finalUrl : null;

  if (page.status >= 400) {
    return { ...result, status: "page_error", statusReason: `The page returned HTTP ${page.status}${movedOff ? ` after redirecting to ${page.finalUrl}` : ""}.` };
  }
  if (page.status < 200 || page.status >= 300) {
    return { ...result, status: "fetch_failed", errorCode: "unexpected_status", statusReason: `The page returned HTTP ${page.status}.` };
  }

  const xrt = page.xRobotsTag;
  const header = parseXRobotsTag(xrt);
  const analysis = analyzePage(page.body, page.finalUrl, site.ourHost, targetKey);
  result.xRobotsTag = xrt ? xrt.slice(0, 300) : null;
  result.metaRobots = analysis.metaRobots;
  result.pageNoindex = header.noindex || analysis.metaNoindex;
  result.pageNofollow = header.nofollow || analysis.metaNofollow;
  result.canonicalUrl = analysis.canonicalElsewhere;
  result.links = analysis.links;
  const targetLinks = analysis.links.filter((l) => l.match === "target");
  const matching = targetLinks.length ? targetLinks : analysis.links;
  result.linkMatch = targetLinks.length ? "target" : analysis.links.length ? "host" : "none";

  let rel: LinkRel;
  let reason: string | null = null;
  if (matching.length === 0) {
    rel = "missing";
    reason = page.truncated
      ? `No link to your site in the first ${Math.round(PAGE_MAX_BYTES / 1024 / 1024)} MB of the page (the page is larger; the rest was not read).`
      : "The page loaded but has no link to your site.";
  } else {
    // The backlink counts as dofollow when any matching link is followable and the page does not nofollow all links.
    const best = matching.find((l) => l.relClass === "dofollow") ?? matching[0]!;
    if (result.pageNofollow) {
      rel = "nofollow";
      reason = `Page-level nofollow (${header.nofollow ? "X-Robots-Tag header" : "meta robots"}): every link on the page is nofollow.`;
    } else rel = best.relClass;
    result.relText = relText(matching);
    result.anchorFound = best.anchor;
    result.anchorMatch = anchorsMatch(input.anchorExpected, best.anchor);
    if (result.linkMatch === "host") reason = `${reason ? `${reason} ` : ""}Links to ${best.href}, not to the target URL.`;
  }
  result.linkRel = rel;
  if (movedOff) {
    result.status = "redirected";
    result.statusReason = `The article redirects to ${page.finalUrl} (${result.redirectChain.length} hop${result.redirectChain.length === 1 ? "" : "s"}); on that page the link is ${rel === "missing" ? "missing" : rel}.${reason ? ` ${reason}` : ""}`;
  } else {
    result.status = rel === "missing" ? "missing" : rel;
    result.statusReason = reason;
  }
  return result;
}

function fetchErrorText(code: string, e: unknown): string {
  switch (code) {
    case "timeout":
      return `The page did not respond within ${PAGE_TIMEOUT_MS / 1000} s.`;
    case "too_many_redirects":
      return `More than ${MAX_REDIRECT_HOPS} redirects.`;
    case "redirect_offsite":
      return `A redirect was refused: ${e instanceof Error ? e.message.slice(0, 200) : "blocked address"}.`;
    case "blocked_url":
      return "The live URL is not a public http(s) URL (IP addresses, local names, credentials and non-default ports are refused).";
    case "non_html":
      return `The page is not HTML (${e instanceof Error ? e.message.slice(0, 120) : "unsupported content type"}).`;
    case "too_large":
      return "The page is larger than the size cap.";
    default:
      return "The page could not be fetched (network error).";
  }
}
