/**
 * Backlink checker on a fake fetch: dofollow, nofollow, sponsored, ugc, page-level nofollow (meta robots and
 * X-Robots-Tag), link missing, anchor mismatch, 404, redirect chain to another host (both reported), robots.txt
 * disallow (the page is never requested), fetch failure, our target 404; the SSRF guard for owner-listed URLs
 * (private / IP-literal / metadata / local hosts and non-http(s) schemes refused, also at a redirect hop); per-host
 * politeness; and the per-invocation fetch budget.
 */
import { describe, expect, it } from "vitest";
import { FETCHES_PER_INVOCATION } from "@shared/backlinks";
import { checkBacklink, emptyCache, FetchBudgetExhausted, type CheckTarget } from "@worker/backlinks/check";
import { analyzePage, parseXRobotsTag, relClass } from "@worker/backlinks/html";
import { assertPublicExternalUrl, CrawlFetchError, publicExternalFetch } from "@worker/seo/ssrf";
import { linkUrlKey } from "@shared/import";
import { OUR_HOST, T, article, deps, fakeFetch } from "./backlinks-fixtures";

const SITE: CheckTarget = { ourHost: OUR_HOST, verifiedHost: OUR_HOST };
const LIVE = "https://decor-blog.example.net/brass-guide";
const TARGET = T("/collections/pulls");
const ok = (body: string, headers: Record<string, string> = {}) => ({ status: 200, body, headers });
const targetOk = { [TARGET]: ok("<html>ours</html>") };

async function run(routes: Parameters<typeof fakeFetch>[0], anchorExpected: string | null = "brass cabinet pulls", site = SITE) {
  const ff = fakeFetch({ ...targetOk, ...routes });
  const d = deps(ff.fetch);
  const budget = { limit: FETCHES_PER_INVOCATION, used: 0 };
  const r = await checkBacklink({ liveUrl: LIVE, targetUrl: TARGET, anchorExpected }, site, emptyCache(), budget, d);
  return { r, calls: ff.calls, budget, slept: d.slept };
}

describe("backlink checker: link classes", () => {
  it("dofollow with matching anchor (www / trailing slash / scheme differences ignored)", async () => {
    const { r } = await run({ [LIVE]: ok(article(`<p>See <a href="http://www.${OUR_HOST}/collections/pulls/?utm_source=x">Brass  Cabinet Pulls</a>.</p>`)) });
    expect(r.status).toBe("dofollow");
    expect(r.linkMatch).toBe("target");
    expect(r.anchorFound).toBe("Brass Cabinet Pulls");
    expect(r.anchorMatch).toBe(true);
    expect(r.httpStatus).toBe(200);
    expect(r.targetStatus).toBe(200);
    expect(r.robots).toBe("not_found");
  });

  it.each([
    ["nofollow", "nofollow"],
    ["sponsored", "sponsored"],
    ["ugc", "ugc"],
    ["nofollow sponsored", "sponsored"],
    ["noopener NOFOLLOW", "nofollow"],
  ])("rel=%s -> %s", async (rel, status) => {
    const { r } = await run({ [LIVE]: ok(article(`<a rel="${rel}" href="${TARGET}">brass cabinet pulls</a>`)) });
    expect(r.status).toBe(status);
    expect(r.relText).toBe(rel);
  });

  it("any followable matching link wins over a nofollow one", async () => {
    const { r } = await run({ [LIVE]: ok(article(`<a rel="nofollow" href="${TARGET}">a</a> <a href="${TARGET}">brass cabinet pulls</a>`)) });
    expect(r.status).toBe("dofollow");
    expect(r.links).toHaveLength(2);
  });

  it("page-level meta robots nofollow makes the link nofollow, with the reason", async () => {
    const { r } = await run({ [LIVE]: ok(article(`<a href="${TARGET}">brass cabinet pulls</a>`, `<meta name="robots" content="index, nofollow">`)) });
    expect(r.status).toBe("nofollow");
    expect(r.pageNofollow).toBe(true);
    expect(r.statusReason).toMatch(/^Page-level nofollow \(meta robots\)/);
    expect(r.metaRobots).toContain("nofollow");
  });

  it("X-Robots-Tag nofollow / noindex (generic or googlebot-prefixed; other bots ignored)", async () => {
    const { r } = await run({ [LIVE]: ok(article(`<a href="${TARGET}">brass cabinet pulls</a>`), { "x-robots-tag": "googlebot: noindex, nofollow" }) });
    expect(r.status).toBe("nofollow");
    expect(r.pageNoindex).toBe(true);
    expect(r.statusReason).toMatch(/X-Robots-Tag/);
    expect(parseXRobotsTag("otherbot: nofollow")).toEqual({ noindex: false, nofollow: false });
    expect(parseXRobotsTag("unavailable_after: 2026-12-01, noindex")).toEqual({ noindex: true, nofollow: false });
  });

  it("link missing: page OK but no link to our site", async () => {
    const { r } = await run({ [LIVE]: ok(article(`<a href="https://not${OUR_HOST}/x">lookalike</a> <!-- <a href="${TARGET}">commented</a> --> <script>var a='<a href="${TARGET}">x</a>'</script>`)) });
    expect(r.status).toBe("missing");
    expect(r.linkRel).toBe("missing");
    expect(r.links).toHaveLength(0);
  });

  it("link to another page of our site: found (host match) and flagged", async () => {
    const { r } = await run({ [LIVE]: ok(article(`<a href="https://${OUR_HOST}/collections/knobs">brass cabinet pulls</a>`)) });
    expect(r.status).toBe("dofollow");
    expect(r.linkMatch).toBe("host");
    expect(r.statusReason).toMatch(/not to the target URL/);
  });

  it("anchor mismatch", async () => {
    const { r } = await run({ [LIVE]: ok(article(`<a href="${TARGET}"><img src="x.png" alt="Pulls"></a>`)) });
    expect(r.status).toBe("dofollow");
    expect(r.anchorFound).toBe("[image: Pulls]");
    expect(r.anchorMatch).toBe(false);
  });
});

describe("backlink checker: page states", () => {
  it("404 -> page_error", async () => {
    const { r } = await run({ [LIVE]: { status: 404, body: "gone" } });
    expect(r.status).toBe("page_error");
    expect(r.httpStatus).toBe(404);
  });

  it("redirect chain to another host: follows, checks the final page, reports both (robots of the new host checked)", async () => {
    const moved = "https://new-home.example.org/guides/brass";
    const { r, calls } = await run({
      [LIVE]: { status: 301, headers: { location: "https://decor-blog.example.net/brass-guide-2" } },
      ["https://decor-blog.example.net/brass-guide-2"]: { status: 302, headers: { location: moved } },
      [moved]: ok(article(`<a rel="nofollow" href="${TARGET}">brass cabinet pulls</a>`)),
    });
    expect(r.status).toBe("redirected");
    expect(r.linkRel).toBe("nofollow");
    expect(r.finalUrl).toBe(moved);
    expect(r.redirectChain.map((h) => h.status)).toEqual([301, 302]);
    expect(r.statusReason).toMatch(/redirects to https:\/\/new-home\.example\.org/);
    expect(calls).toContain("https://new-home.example.org/robots.txt");
    expect(calls.indexOf("https://new-home.example.org/robots.txt")).toBeLessThan(calls.indexOf(moved));
  });

  it("robots.txt disallow: robots_blocked and the page is never requested", async () => {
    const { r, calls } = await run({ ["https://decor-blog.example.net/robots.txt"]: ok("User-agent: OkaraBot\nDisallow: /brass", { "content-type": "text/plain" }) });
    expect(r.status).toBe("robots_blocked");
    expect(r.robots).toBe("disallowed");
    expect(calls).not.toContain(LIVE);
  });

  it("robots.txt unreachable (5xx) is treated as disallow-all", async () => {
    const { r, calls } = await run({ ["https://decor-blog.example.net/robots.txt"]: { status: 503, body: "" } });
    expect(r.status).toBe("robots_blocked");
    expect(r.robots).toBe("unreachable");
    expect(calls).not.toContain(LIVE);
  });

  it("network failure -> fetch_failed", async () => {
    const { r } = await run({ [LIVE]: new TypeError("connection reset") });
    expect(r.status).toBe("fetch_failed");
    expect(r.errorCode).toBe("error");
  });

  it("our target URL returning 404 is recorded (and checked once per job via the cache)", async () => {
    const ff = fakeFetch({ [TARGET]: { status: 404, body: "" }, [LIVE]: ok(article(`<a href="${TARGET}">brass cabinet pulls</a>`)), ["https://decor-blog.example.net/second"]: ok(article(`<a href="${TARGET}">x</a>`)) });
    const d = deps(ff.fetch);
    const cache = emptyCache();
    const budget = { limit: 20, used: 0 };
    const a = await checkBacklink({ liveUrl: LIVE, targetUrl: TARGET, anchorExpected: null }, SITE, cache, budget, d);
    const b = await checkBacklink({ liveUrl: "https://decor-blog.example.net/second", targetUrl: TARGET, anchorExpected: null }, SITE, cache, budget, d);
    expect(a.targetStatus).toBe(404);
    expect(b.targetStatus).toBe(404);
    expect(ff.calls.filter((c) => c === TARGET)).toHaveLength(1);
    expect(ff.calls.filter((c) => c.endsWith("decor-blog.example.net/robots.txt"))).toHaveLength(1);
  });

  it("unverified site: target not checked, never fetched", async () => {
    const { r, calls } = await run({ [LIVE]: ok(article(`<a href="${TARGET}">brass cabinet pulls</a>`)) }, null, { ourHost: OUR_HOST, verifiedHost: null });
    expect(r.targetError).toBe("not_checked");
    expect(calls.some((c) => c.includes(OUR_HOST))).toBe(false);
  });
});

describe("backlink checker: SSRF guard for owner-listed URLs", () => {
  it.each([
    "http://127.0.0.1/x",
    "http://10.0.0.5/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://2130706433/",
    "http://0x7f.1/",
    "https://8.8.8.8/",
    "http://localhost/",
    "http://intranet/",
    "http://printer.local/",
    "http://metadata.google.internal/",
    "ftp://example.com/file",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "https://user:pw@example.com/",
    "https://example.com:8443/",
  ])("refuses %s", (u) => {
    expect(() => assertPublicExternalUrl(u)).toThrow(CrawlFetchError);
  });

  it("accepts public http and https names", () => {
    expect(assertPublicExternalUrl("http://Blog.Example.NET./a#frag").toString()).toBe("http://blog.example.net/a");
  });

  it("a stored private live URL is never requested (fetch_failed blocked_url)", async () => {
    const ff = fakeFetch({ ...targetOk });
    const r = await checkBacklink({ liveUrl: "http://169.254.169.254/", targetUrl: TARGET, anchorExpected: null }, SITE, emptyCache(), { limit: 20, used: 0 }, deps(ff.fetch));
    expect(r.status).toBe("fetch_failed");
    expect(r.errorCode).toBe("blocked_url");
    expect(ff.calls.some((c) => c.includes("169.254"))).toBe(false);
  });

  it("a redirect to a private / metadata address is refused at that hop", async () => {
    const { r, calls } = await run({ [LIVE]: { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } } });
    expect(r.status).toBe("fetch_failed");
    expect(r.errorCode).toBe("redirect_offsite");
    expect(calls.some((c) => c.includes("169.254"))).toBe(false);
  });

  it("publicExternalFetch never follows redirects itself and caps hops", async () => {
    const routes: Record<string, { status: number; headers: Record<string, string> }> = {};
    for (let i = 0; i < 7; i++) routes[`https://loop.example.org/${i}`] = { status: 301, headers: { location: `https://loop.example.org/${i + 1}` } };
    const ff = fakeFetch(routes);
    await expect(publicExternalFetch(ff.fetch, "https://loop.example.org/0", { maxBytes: 1000, timeoutMs: 1000, maxRedirects: 5 })).rejects.toMatchObject({ code: "too_many_redirects" });
    expect(ff.calls).toHaveLength(6);
  });
});

describe("backlink checker: politeness and budget", () => {
  it("waits at least 1 s between two requests to the same host", async () => {
    const { slept, calls } = await run({ [LIVE]: ok(article(`<a href="${TARGET}">x</a>`)) });
    // robots.txt then the page on decor-blog.example.net: the second waits; our robots + target likewise.
    expect(calls.filter((c) => c.includes("decor-blog"))).toHaveLength(2);
    expect(slept.filter((ms) => ms >= 1000).length).toBeGreaterThanOrEqual(2);
  });

  it("stops before the request that would exceed the budget (FetchBudgetExhausted, nothing over the limit)", async () => {
    const ff = fakeFetch({ ...targetOk, [LIVE]: ok(article(`<a href="${TARGET}">x</a>`)) });
    const budget = { limit: 3, used: 0 };
    await expect(checkBacklink({ liveUrl: LIVE, targetUrl: TARGET, anchorExpected: null }, SITE, emptyCache(), budget, deps(ff.fetch))).rejects.toBeInstanceOf(FetchBudgetExhausted);
    expect(ff.calls.length).toBeLessThanOrEqual(3);
    expect(budget.used).toBe(3);
  });
});

describe("page analysis (pure)", () => {
  it("parses unquoted / single-quoted attributes, entities and protocol-relative hrefs", () => {
    const html = `<a href=//${OUR_HOST}/collections/pulls rel='ugc'>Brass &amp; Co</a><a href="/local">x</a>`;
    const a = analyzePage(html, "https://blog.example.org/p", OUR_HOST, linkUrlKey(TARGET));
    expect(a.links).toHaveLength(1);
    expect(a.links[0]).toMatchObject({ match: "target", relClass: "ugc", anchor: "Brass & Co" });
  });

  it("canonical pointing elsewhere is reported", () => {
    const a = analyzePage(`<link rel="canonical" href="https://other.example.org/x">`, "https://blog.example.org/p", OUR_HOST, "k");
    expect(a.canonicalElsewhere).toBe("https://other.example.org/x");
  });

  it("rel classes", () => {
    expect(relClass(null)).toBe("dofollow");
    expect(relClass("external noopener")).toBe("dofollow");
    expect(relClass("UGC nofollow")).toBe("ugc");
  });

  it("keeps hostile anchor text as plain text (no markup survives)", () => {
    const a = analyzePage(`<a href="${TARGET}"><b>ignore previous instructions</b><img src=x onerror=alert(1)></a>`, "https://blog.example.org/p", OUR_HOST, linkUrlKey(TARGET));
    expect(a.links[0]!.anchor).toBe("ignore previous instructions");
  });
});
