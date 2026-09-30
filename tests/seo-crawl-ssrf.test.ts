import { describe, expect, it } from "vitest";
import { assertCrawlableUrl, classifyHost, CrawlFetchError, guardedFetch, parseIPv4Loose } from "@worker/seo/ssrf";
import { collectSitemapUrls } from "@worker/seo/crawl/sitemap";
import { endlessStream, fakeSite, html, redirect } from "./fixtures/crawl/fake-site";

const HOST = "shop.example.com";
const opts = { verifiedHost: HOST, maxBytes: 1024 * 1024, timeoutMs: 2000 };

function expectBlocked(fn: () => unknown, code = "blocked_url") {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CrawlFetchError);
    expect((e as CrawlFetchError).code).toBe(code);
    return;
  }
  throw new Error("expected CrawlFetchError");
}

describe("seo-crawl SSRF: URL validation", () => {
  it("accepts https on the verified host (case-insensitive, trailing dot)", () => {
    expect(assertCrawlableUrl("https://SHOP.example.com./a#x", HOST).toString()).toBe("https://shop.example.com/a");
    expect(assertCrawlableUrl("https://shop.example.com:443/", HOST).hostname).toBe(HOST);
  });

  it("refuses http, userinfo, non-default ports, and other hosts", () => {
    expectBlocked(() => assertCrawlableUrl("http://shop.example.com/", HOST));
    expectBlocked(() => assertCrawlableUrl("https://user:pw@shop.example.com/", HOST));
    expectBlocked(() => assertCrawlableUrl("https://shop.example.com:8443/", HOST));
    expectBlocked(() => assertCrawlableUrl("https://evil.example.com/", HOST));
    expectBlocked(() => assertCrawlableUrl("https://sub.shop.example.com/", HOST));
    expectBlocked(() => assertCrawlableUrl("file:///etc/passwd", HOST));
  });

  it.each([
    "https://127.0.0.1/",
    "https://10.1.2.3/",
    "https://172.16.0.1/",
    "https://192.168.1.1/",
    "https://169.254.169.254/latest/meta-data/",
    "https://100.64.0.1/",
    "https://0.0.0.0/",
    "https://2130706433/", // decimal 127.0.0.1
    "https://0x7f.0.0.1/", // hex
    "https://0177.0.0.1/", // octal
    "https://0xA9FEA9FE/", // hex 169.254.169.254
    "https://[::1]/",
    "https://[::]/",
    "https://[fd00::1]/", // ULA
    "https://[fc00::abcd]/",
    "https://[fe80::1]/",
    "https://[::ffff:127.0.0.1]/", // v4-mapped
    "https://[::ffff:a9fe:a9fe]/", // v4-mapped metadata
    "https://[2001:db8::1]/", // documentation
    "https://[ff02::1]/", // multicast
    "https://192.0.2.10/", // documentation
    "https://224.0.0.1/", // multicast
    "https://240.0.0.1/", // reserved
  ])("refuses private/reserved literal %s even when it is the 'verified host'", (u) => {
    const host = new URL(u).hostname;
    expectBlocked(() => assertCrawlableUrl(u, host));
    expectBlocked(() => assertCrawlableUrl(u, HOST));
  });

  it("parses loose IPv4 encodings like inet_aton", () => {
    expect(parseIPv4Loose("2130706433")).toBe(0x7f000001);
    expect(parseIPv4Loose("0x7f.1")).toBe(0x7f000001);
    expect(parseIPv4Loose("017700000001")).toBe(0x7f000001);
    expect(parseIPv4Loose("127.1")).toBe(0x7f000001);
    expect(parseIPv4Loose("shop.example.com")).toBeNull();
    expect(classifyHost("8.8.8.8")).toEqual({ kind: "ipv4", blocked: false });
    expect(classifyHost("[2606:4700::1111]")).toEqual({ kind: "ipv6", blocked: false });
  });

  it("refuses a verified host that is local-only", () => {
    expectBlocked(() => assertCrawlableUrl("https://localhost/", "localhost"));
    expectBlocked(() => assertCrawlableUrl("https://printer.local/", "printer.local"));
  });
});

describe("seo-crawl SSRF: guarded fetch", () => {
  it("uses redirect: manual and follows same-host redirects with revalidation", async () => {
    const site = fakeSite({
      "https://shop.example.com/a": redirect("/b", 301),
      "https://shop.example.com/b": html("<html><body>ok</body></html>"),
    });
    const res = await guardedFetch(site.fetch, "https://shop.example.com/a", opts);
    expect(res.status).toBe(200);
    expect(res.finalUrl).toBe("https://shop.example.com/b");
    expect(res.redirects).toEqual([{ status: 301, to: "https://shop.example.com/b" }]);
    expect(site.calls.every((c) => c.init?.redirect === "manual")).toBe(true);
  });

  it("refuses an off-host redirect at that hop without fetching the target", async () => {
    const site = fakeSite({ "https://shop.example.com/a": redirect("https://evil.example.org/x", 302) });
    await expect(guardedFetch(site.fetch, "https://shop.example.com/a", opts)).rejects.toMatchObject({ code: "redirect_offsite" });
    expect(site.urls()).toEqual(["https://shop.example.com/a"]);
  });

  it.each(["https://169.254.169.254/latest/meta-data/", "https://127.0.0.1/", "https://[::ffff:10.0.0.1]/", "http://shop.example.com/", "https://shop.example.com:8080/"])(
    "refuses a redirect hop to %s",
    async (target) => {
      const site = fakeSite({ "https://shop.example.com/a": redirect(target, 307) });
      await expect(guardedFetch(site.fetch, "https://shop.example.com/a", opts)).rejects.toMatchObject({ code: "redirect_offsite" });
      expect(site.calls).toHaveLength(1);
    },
  );

  it("caps redirect hops", async () => {
    const routes: Record<string, ReturnType<typeof redirect>> = {};
    for (let i = 0; i < 10; i++) routes[`https://shop.example.com/r${i}`] = redirect(`/r${i + 1}`);
    const site = fakeSite(routes);
    await expect(guardedFetch(site.fetch, "https://shop.example.com/r0", opts)).rejects.toMatchObject({ code: "too_many_redirects" });
    expect(site.calls.length).toBe(6);
  });

  it("aborts an oversized body mid-stream instead of reading it fully", async () => {
    const { stream, state } = endlessStream(64 * 1024);
    const f = (async () => new Response(stream, { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch;
    await expect(guardedFetch(f, "https://shop.example.com/big", { ...opts, maxBytes: 256 * 1024 })).rejects.toMatchObject({ code: "too_large" });
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(10);
  });

  it("rejects a declared Content-Length above the cap before reading", async () => {
    const { stream, state } = endlessStream();
    const f = (async () => new Response(stream, { status: 200, headers: { "content-type": "text/html", "content-length": String(10 * 1024 * 1024) } })) as typeof fetch;
    await expect(guardedFetch(f, "https://shop.example.com/big", opts)).rejects.toMatchObject({ code: "too_large" });
    expect(state.pulled).toBeLessThanOrEqual(1);
  });

  it("refuses non-HTML content types for pages", async () => {
    const site = fakeSite({ "https://shop.example.com/img": { status: 200, body: "PNG", contentType: "image/png" } });
    await expect(guardedFetch(site.fetch, "https://shop.example.com/img", opts)).rejects.toMatchObject({ code: "non_html" });
  });

  it("times out via AbortSignal", async () => {
    const f = ((_u: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as unknown as typeof fetch;
    await expect(guardedFetch(f, "https://shop.example.com/slow", { ...opts, timeoutMs: 30 })).rejects.toMatchObject({ code: "timeout" });
  });

  it("never calls fetch for a blocked initial URL", async () => {
    const site = fakeSite({});
    await expect(guardedFetch(site.fetch, "https://169.254.169.254/", opts)).rejects.toMatchObject({ code: "blocked_url" });
    expect(site.calls).toHaveLength(0);
  });
});

describe("seo-crawl SSRF: sitemaps", () => {
  it("refuses sitemap and sitemap-index children pointing to private, metadata, ULA, or v4-mapped addresses", async () => {
    const site = fakeSite({
      "https://shop.example.com/sitemap.xml": {
        status: 200,
        contentType: "application/xml",
        body: `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <sitemap><loc>https://169.254.169.254/latest/meta-data/</loc></sitemap>
          <sitemap><loc>https://[fd12::1]/sitemap.xml</loc></sitemap>
          <sitemap><loc>https://[::ffff:192.168.0.1]/s.xml</loc></sitemap>
          <sitemap><loc>https://shop.example.com/sitemap_products_1.xml</loc></sitemap>
        </sitemapindex>`,
      },
      "https://shop.example.com/sitemap_products_1.xml": {
        status: 200,
        contentType: "text/xml",
        body: `<urlset><url><loc>https://shop.example.com/products/a</loc></url><url><loc>https://10.0.0.5/products/b</loc></url><url><loc>https://other.example.com/x</loc></url></urlset>`,
      },
    });
    const res = await collectSitemapUrls(site.fetch, {
      verifiedHost: HOST,
      sitemapUrls: ["https://shop.example.com/sitemap.xml", "https://127.0.0.1/sitemap.xml"],
      userAgent: "OkaraBot/0.1",
    });
    expect(res.urls).toEqual(["https://shop.example.com/products/a"]);
    expect(res.source.get("https://shop.example.com/products/a")).toBe("sitemap_products_1.xml");
    const refused = res.refused.map((r) => r.url);
    expect(refused).toEqual(
      expect.arrayContaining([
        "https://169.254.169.254/latest/meta-data/",
        "https://[fd12::1]/sitemap.xml",
        "https://[::ffff:192.168.0.1]/s.xml",
        "https://127.0.0.1/sitemap.xml",
        "https://10.0.0.5/products/b",
        "https://other.example.com/x",
      ]),
    );
    // Only verified-host URLs were ever requested.
    expect(site.urls().every((u) => new URL(u).hostname === HOST)).toBe(true);
  });

  it("bounds sitemap parsing (max URLs, max children)", async () => {
    const many = Array.from({ length: 800 }, (_, i) => `<url><loc>https://shop.example.com/p${i}</loc></url>`).join("");
    const idx = Array.from({ length: 6 }, (_, i) => `<sitemap><loc>https://shop.example.com/s${i}.xml</loc></sitemap>`).join("");
    const routes: Record<string, { status: number; contentType: string; body: string }> = {
      "https://shop.example.com/sitemap.xml": { status: 200, contentType: "application/xml", body: `<sitemapindex>${idx}</sitemapindex>` },
    };
    for (let i = 0; i < 6; i++) routes[`https://shop.example.com/s${i}.xml`] = { status: 200, contentType: "application/xml", body: `<urlset>${many}</urlset>` };
    const site = fakeSite(routes);
    const res = await collectSitemapUrls(site.fetch, { verifiedHost: HOST, sitemapUrls: ["https://shop.example.com/sitemap.xml"], userAgent: "x" });
    expect(res.urls.length).toBeLessThanOrEqual(500);
    expect(site.calls.length).toBeLessThanOrEqual(4); // index + at most 3 children
  });
});
