import { describe, expect, it } from "vitest";
import { extractPage, analyzeJsonLd } from "@worker/seo/crawl/extract";
import { classifyPageType, templateName } from "@worker/seo/crawl/page-type";
import { parseSitemap } from "@worker/seo/crawl/sitemap";
import { fixture } from "./fixtures/crawl/fake-site";

describe("seo-crawl extraction", () => {
  it("extracts every compact field from a product page with a JSON-LD @graph", () => {
    const x = extractPage(fixture("product-graph.html"), "https://shop.example.com/products/brass-pull");
    expect(x.title).toBe("Solid Brass Cabinet Pull & Knob | Residence Example");
    expect(x.metaDescription).toBe("A solid brass cabinet pull, hand finished.");
    expect(x.metaRobots).toBe("index, follow");
    expect(x.canonical).toBe("https://shop.example.com/products/brass-pull");
    expect(x.h1s).toEqual(["Solid Brass Cabinet Pull"]);
    expect(x.headings).toEqual([
      { level: 1, text: "Solid Brass Cabinet Pull" },
      { level: 2, text: "Specifications" },
      { level: 3, text: "Finish" },
    ]);
    expect(x.internalLinks).toEqual([
      "https://shop.example.com/",
      "https://shop.example.com/collections/pulls",
      "https://shop.example.com/pages/care",
      "https://shop.example.com/products/brass-knob?variant=123",
    ]);
    expect(x.jsonLdTypes).toEqual(["Organization", "Product", "BreadcrumbList"]);
    expect(x.jsonLdIssues).toEqual([]);
    expect(x.hasProductOffer).toBe(true);
    expect(x.author).toBe("Jane Maker");
    expect(x.lastUpdated).toBe("2026-09-01T10:00:00Z");
    // Only the external link inside main content counts as a citation (nav/footer links do not).
    expect(x.outboundCitations).toBe(1);
    expect(x.tableCount).toBe(1);
    expect(x.firstParagraph).toBe("This solid brass cabinet pull is machined from a single bar and hand finished in our workshop.");
    // Main text: <main> only; scripts, styles, noscript, nav, footer excluded.
    expect(x.excerpt).toContain("machined from a single bar");
    expect(x.excerpt).not.toContain("script text");
    expect(x.excerpt).not.toContain("Enable JavaScript");
    expect(x.excerpt).not.toContain("Footer words");
    expect(x.excerpt).not.toContain(".x{color");
    expect(x.wordCount).toBeGreaterThan(20);
    expect(x.wordCount).toBeLessThan(60);
    expect(x.jsRendered).toBe(false);
  });

  it("handles JSON-LD arrays, author arrays, invalid blocks, and Product issues", () => {
    const x = extractPage(fixture("article-array.html"), "https://shop.example.com/blogs/news/how-to-choose");
    expect(x.jsonLdTypes).toEqual(["BlogPosting", "Product"]);
    expect(x.author).toBe("Alex Writer");
    expect(x.lastUpdated).toBe("2026-08-15");
    expect(x.jsonLdIssues.map((i) => i.issue).sort()).toEqual(["invalid_json", "missing_offers"]);
    expect(x.firstParagraph).toBe("Choosing cabinet hardware starts with the size of the door and the style of the room you are working with.");
    expect(x.headings.map((h) => h.level)).toEqual([1, 3]);
    expect(x.canonical).toBeNull();
    expect(x.metaDescription).toBeNull();
  });

  it("validates AggregateOffer and flags offers missing currency or name", () => {
    const x = extractPage(fixture("aggregate-offer.html"), "https://shop.example.com/products/set");
    expect(x.hasProductOffer).toBe(true);
    expect(x.jsonLdIssues.map((i) => i.issue).sort()).toEqual(["missing_name", "offer_missing_currency"]);
    const r = analyzeJsonLd(['{"@type":"Product","name":"A","offers":{"@type":"Offer","priceSpecification":{"price":1,"priceCurrency":"EUR"}}}']);
    expect(r.issues).toEqual([]);
    expect(r.hasProductOffer).toBe(true);
  });

  it("detects likely JS-rendered pages", () => {
    const x = extractPage(fixture("js-app.html"), "https://shop.example.com/app");
    expect(x.hasAppRoot).toBe(true);
    expect(x.jsRendered).toBe(true);
    const plain = extractPage("<html><body><p>tiny</p></body></html>", "https://shop.example.com/tiny");
    expect(plain.jsRendered).toBe(false);
  });

  it("caps headings and internal links", () => {
    const many = Array.from({ length: 300 }, (_, i) => `<h2>H${i}</h2><a href="/p/${i}">x</a>`).join("");
    const x = extractPage(`<html><body>${many}</body></html>`, "https://shop.example.com/");
    expect(x.headings).toHaveLength(60);
    expect(x.internalLinks).toHaveLength(200);
  });

  it("parses urlset, sitemapindex, and text sitemaps", () => {
    expect(parseSitemap('<urlset xmlns="x"><url><loc> https://a.example/1 </loc></url></urlset>')).toEqual({ kind: "urlset", locs: ["https://a.example/1"], truncated: false });
    expect(parseSitemap("<sitemapindex><sitemap><loc>https://a.example/s.xml</loc></sitemap></sitemapindex>").kind).toBe("sitemapindex");
    expect(parseSitemap("https://a.example/1\nhttps://a.example/2\n").locs).toHaveLength(2);
    expect(parseSitemap("<urlset><url><loc>a</loc></url><url><loc>b</loc></url></urlset>", 1)).toEqual({ kind: "urlset", locs: ["a"], truncated: true });
  });
});

describe("seo-crawl page-type classification", () => {
  const c = (url: string, jsonLdTypes: string[] = [], sitemapFile: string | null = null) => classifyPageType({ url, jsonLdTypes, sitemapFile });
  it.each([
    ["https://s.example/", [], null, "home", "url_pattern"],
    ["https://s.example/x", ["Product"], null, "product", "jsonld"],
    ["https://s.example/x", ["CollectionPage"], null, "collection", "jsonld"],
    ["https://s.example/x", ["ItemList"], null, "collection", "jsonld"],
    ["https://s.example/x", ["BlogPosting"], null, "article", "jsonld"],
    ["https://s.example/products/brass-pull", [], null, "product", "url_pattern"],
    ["https://s.example/collections/pulls/products/brass-pull", [], null, "product", "url_pattern"],
    ["https://s.example/collections/pulls", [], null, "collection", "url_pattern"],
    ["https://s.example/blogs/news/post-1", [], null, "article", "url_pattern"],
    ["https://s.example/product/widget", [], null, "product", "url_pattern"],
    ["https://s.example/category/lighting", [], null, "collection", "url_pattern"],
    ["https://s.example/blog/hello", [], null, "article", "url_pattern"],
    ["https://s.example/pages/about", [], null, "landing", "url_pattern"],
    ["https://s.example/weird-slug", [], "sitemap_products_1.xml", "product", "sitemap"],
    ["https://s.example/weird-slug", [], null, "other", "default"],
  ] as const)("%s %j -> %s via %s", (url, types, file, type, method) => {
    expect(c(url, [...types], file)).toEqual({ pageType: type, method });
  });

  it("names templates for templated page types only", () => {
    expect(templateName("product")).toBe("product template");
    expect(templateName("collection")).toBe("collection template");
    expect(templateName("home")).toBeNull();
  });
});
