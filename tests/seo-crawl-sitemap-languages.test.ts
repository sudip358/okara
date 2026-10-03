/**
 * Language-version sitemaps (Shopify Markets subfolders): a sitemap index that lists "/da/sitemap_products_1.xml"
 * next to "/sitemap_products_1.xml" repeats the same pages in translation. The crawl inventory reads the primary
 * sitemaps only, so the rolling crawl and the link graph cover the primary pages instead of spending the page and
 * subrequest budget on translations. Synthetic store; no real site data.
 */
import { describe, expect, it } from "vitest";
import { collectSitemapUrls, splitLanguageAlternates } from "@worker/seo/crawl/sitemap";
import { fakeSite } from "./fixtures/crawl/fake-site";

const HOST = "shop.example.com";
const O = `https://${HOST}`;

describe("splitLanguageAlternates", () => {
  it("leaves out language folders that repeat an unprefixed sitemap (same path and query)", () => {
    const children = [
      `${O}/sitemap_products_1.xml?from=1&to=9`,
      `${O}/sitemap_pages_1.xml`,
      `${O}/da/sitemap_products_1.xml?from=1&to=9`,
      `${O}/fr-ca/sitemap_pages_1.xml`,
      `${O}/es/sitemap_products_1.xml?from=10&to=19`, // no unprefixed twin with this query: kept
      `${O}/us/sitemap_extra.xml`, // two-letter folder without a twin: kept
      `${O}/blog/sitemap_pages_1.xml`, // not a language folder: kept
    ];
    const r = splitLanguageAlternates(children);
    expect(r.alternates).toEqual([`${O}/da/sitemap_products_1.xml?from=1&to=9`, `${O}/fr-ca/sitemap_pages_1.xml`]);
    expect(r.folders).toEqual(["da", "fr-ca"]);
    expect(r.primary).toEqual([
      `${O}/sitemap_products_1.xml?from=1&to=9`,
      `${O}/sitemap_pages_1.xml`,
      `${O}/es/sitemap_products_1.xml?from=10&to=19`,
      `${O}/us/sitemap_extra.xml`,
      `${O}/blog/sitemap_pages_1.xml`,
    ]);
  });

  it("keeps everything when no sitemap has a language folder, and ignores unparseable entries", () => {
    const r = splitLanguageAlternates([`${O}/a.xml`, "not a url", `${O}/b.xml`]);
    expect(r.alternates).toEqual([]);
    expect(r.primary).toEqual([`${O}/a.xml`, "not a url", `${O}/b.xml`]);
  });
});

describe("collectSitemapUrls with language-version sitemaps", () => {
  const index = (locs: string[]) =>
    `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map((l) => `<sitemap><loc>${l.replace(/&/g, "&amp;")}</loc></sitemap>`).join("")}</sitemapindex>`;
  const urlset = (paths: string[]) => `<urlset>${paths.map((p) => `<url><loc>${O}${p}</loc></url>`).join("")}</urlset>`;

  it("reads only the primary sitemaps, never requests the translated ones, and says what it left out", async () => {
    const primary = [`${O}/sitemap_products_1.xml?from=1&to=9`, `${O}/sitemap_collections_1.xml`, `${O}/sitemap_blogs_1.xml`];
    const translated = ["da", "es", "fr"].flatMap((l) => primary.map((u) => u.replace(`${O}/`, `${O}/${l}/`)));
    const routes: Record<string, { status: number; contentType: string; body: string }> = {
      [`${O}/sitemap.xml`]: { status: 200, contentType: "application/xml", body: index([...primary, ...translated]) },
      [`${O}/sitemap_products_1.xml?from=1&to=9`]: { status: 200, contentType: "application/xml", body: urlset(["/products/oak-table", "/products/brass-sconce"]) },
      [`${O}/sitemap_collections_1.xml`]: { status: 200, contentType: "application/xml", body: urlset(["/collections/sconces"]) },
      [`${O}/sitemap_blogs_1.xml`]: { status: 200, contentType: "application/xml", body: urlset(["/blogs/journal/lighting-guide"]) },
    };
    for (const u of translated) routes[u] = { status: 200, contentType: "application/xml", body: urlset(["/da/products/should-not-be-read"]) };
    const site = fakeSite(routes);

    const res = await collectSitemapUrls(site.fetch, { verifiedHost: HOST, sitemapUrls: [`${O}/sitemap.xml`], userAgent: "x", maxChildren: 25, maxUrls: 10_000 });

    expect(res.urls).toEqual([`${O}/products/oak-table`, `${O}/products/brass-sconce`, `${O}/collections/sconces`, `${O}/blogs/journal/lighting-guide`]);
    expect(site.urls().some((u) => /\/(da|es|fr)\//.test(new URL(u).pathname))).toBe(false);
    expect(site.calls.length).toBe(4); // the index + 3 primary sitemaps
    const note = res.notes.find((n) => n.includes("language-version"));
    expect(note).toContain("left out 9 language-version sitemaps (/da/, /es/, /fr/)");
    // Leaving translations out is a choice, not a cap: the rolling inventory must not read it as truncated.
    expect(res.notes.some((n) => /lists \d+ sitemaps|capped|not followed|Skipped gzip/i.test(n))).toBe(false);
  });
});
