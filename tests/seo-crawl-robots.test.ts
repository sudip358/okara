import { describe, expect, it } from "vitest";
import { CRAWLER_UA_TOKEN, crawlerUserAgent, fetchRobots, isPathAllowed, parseRobots, robotsAllows, robotsCrawlDelay, selectGroup } from "@worker/seo/crawl/robots";
import { fakeSite } from "./fixtures/crawl/fake-site";

// RFC 9309 section 5.1 example.
const RFC_EXAMPLE = `
User-Agent: *
Disallow: *.gif$
Disallow: /example/
Allow: /publications/

User-Agent: foobot
Disallow:/
Allow:/example/page.html
Allow:/example/allowed.gif

User-Agent: barbot
User-Agent: bazbot
Disallow: /example/page.html

User-Agent: quxbot

Sitemap: https://www.example.com/sitemap.xml
`;

const allowed = (robots: string, agent: string, path: string) => isPathAllowed(selectGroup(parseRobots(robots), agent), path);

describe("seo-crawl robots.txt (RFC 9309)", () => {
  it("uses the fetch UA product token for matching", () => {
    expect(CRAWLER_UA_TOKEN).toBe("OkaraBot");
    expect(crawlerUserAgent("https://app.example.com/")).toBe("OkaraBot/0.1 (+https://app.example.com/bot)");
    expect(crawlerUserAgent("https://app.example.com").startsWith(`${CRAWLER_UA_TOKEN}/`)).toBe(true);
  });

  it("matches the RFC 9309 5.1 example: specific group only, never unioned with *", () => {
    expect(allowed(RFC_EXAMPLE, "foobot", "/example/page.html")).toBe(true);
    expect(allowed(RFC_EXAMPLE, "foobot", "/example/allowed.gif")).toBe(true);
    expect(allowed(RFC_EXAMPLE, "foobot", "/example/disallowed.gif")).toBe(false);
    expect(allowed(RFC_EXAMPLE, "foobot", "/")).toBe(false);
    expect(allowed(RFC_EXAMPLE, "FooBot", "/publications/")).toBe(false); // case-insensitive token; * Allow not unioned
    // barbot/bazbot: only their own group applies, so the * group's *.gif$ and /example/ do not.
    expect(allowed(RFC_EXAMPLE, "barbot", "/example/page.html")).toBe(false);
    expect(allowed(RFC_EXAMPLE, "bazbot", "/example/page.html")).toBe(false);
    expect(allowed(RFC_EXAMPLE, "barbot", "/example/other.gif")).toBe(true);
    // quxbot: empty group -> allow everything (does not fall back to *).
    expect(allowed(RFC_EXAMPLE, "quxbot", "/example/x.gif")).toBe(true);
    // Unknown agent -> * group.
    expect(allowed(RFC_EXAMPLE, "OkaraBot", "/images/a.gif")).toBe(false);
    expect(allowed(RFC_EXAMPLE, "OkaraBot", "/images/a.gif?x=1")).toBe(true); // $ anchors the end
    expect(allowed(RFC_EXAMPLE, "OkaraBot", "/example/")).toBe(false);
    expect(allowed(RFC_EXAMPLE, "OkaraBot", "/publications/x")).toBe(true);
    expect(parseRobots(RFC_EXAMPLE).sitemaps).toEqual(["https://www.example.com/sitemap.xml"]);
  });

  it("longest match wins; allow wins a tie", () => {
    const r = `User-agent: *\nAllow: /example/page/\nDisallow: /example/page/disallowed.gif\nAllow: /tie\nDisallow: /tie\nDisallow: /a\nAllow: /a/b`;
    expect(allowed(r, "x", "/example/page/")).toBe(true);
    expect(allowed(r, "x", "/example/page/disallowed.gif")).toBe(false);
    expect(allowed(r, "x", "/tie")).toBe(true);
    expect(allowed(r, "x", "/a/c")).toBe(false);
    expect(allowed(r, "x", "/a/b/c")).toBe(true);
  });

  it("supports * wildcards and $ end anchors", () => {
    const r = `User-agent: *\nDisallow: /*.php$\nDisallow: /private*/\nDisallow: /*?sort=`;
    expect(allowed(r, "x", "/index.php")).toBe(false);
    expect(allowed(r, "x", "/index.php?x")).toBe(true);
    expect(allowed(r, "x", "/private-area/doc")).toBe(false);
    expect(allowed(r, "x", "/collections/a?sort=price")).toBe(false);
    expect(allowed(r, "x", "/collections/a")).toBe(true);
    expect(allowed(r, "x", "/robots.txt")).toBe(true);
  });

  it("combines multiple groups for the same agent and honours crawl-delay", () => {
    const r = `User-agent: OkaraBot\nDisallow: /a\nCrawl-delay: 2\n\nUser-agent: *\nDisallow: /\n\nUser-agent: okarabot\nDisallow: /b`;
    const g = selectGroup(parseRobots(r), CRAWLER_UA_TOKEN)!;
    expect(g.rules.map((x) => x.path)).toEqual(["/a", "/b"]);
    expect(g.crawlDelay).toBe(2);
    expect(isPathAllowed(g, "/c")).toBe(true);
    const state = { status: "ok" as const, httpStatus: 200, parsed: parseRobots(r), note: "" };
    expect(robotsCrawlDelay(state, CRAWLER_UA_TOKEN)).toBe(2);
  });

  it("ignores version suffixes in user-agent lines and rules before any group", () => {
    const r = `Disallow: /x\nUser-agent: OkaraBot/1.0\nDisallow: /y`;
    expect(allowed(r, "OkaraBot", "/x")).toBe(true);
    expect(allowed(r, "OkaraBot", "/y")).toBe(false);
  });

  it("4xx -> allow all; 5xx or unreachable -> disallow all", async () => {
    const mk = (status: number) => fakeSite({ "https://shop.example.com/robots.txt": { status, body: "x", contentType: "text/plain" } }).fetch;
    const s404 = await fetchRobots(mk(404), "shop.example.com", "OkaraBot/0.1");
    expect(s404.status).toBe("not_found");
    expect(robotsAllows(s404, "OkaraBot", "https://shop.example.com/anything")).toBe(true);
    const s503 = await fetchRobots(mk(503), "shop.example.com", "OkaraBot/0.1");
    expect(s503.status).toBe("unreachable");
    expect(robotsAllows(s503, "OkaraBot", "https://shop.example.com/")).toBe(false);
    const failing = (async () => {
      throw new TypeError("connection refused");
    }) as unknown as typeof fetch;
    const down = await fetchRobots(failing, "shop.example.com", "OkaraBot/0.1");
    expect(down.status).toBe("unreachable");
  });

  it("fetches robots.txt with the crawler UA through the guard and truncates at 512 KB", async () => {
    const big = "User-agent: *\nDisallow: /secret\n" + "# pad\n".repeat(200_000);
    const site = fakeSite({ "https://shop.example.com/robots.txt": { status: 200, body: big, contentType: "text/plain" } });
    const st = await fetchRobots(site.fetch, "shop.example.com", "OkaraBot/0.1 (+x)");
    expect(st.status).toBe("ok");
    expect(st.note).toMatch(/truncated/);
    expect(robotsAllows(st, "OkaraBot", "https://shop.example.com/secret")).toBe(false);
    const headers = new Headers(site.calls[0]!.init?.headers);
    expect(headers.get("user-agent")).toBe("OkaraBot/0.1 (+x)");
    expect(site.calls[0]!.init?.redirect).toBe("manual");
  });
});
