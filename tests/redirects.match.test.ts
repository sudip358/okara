import { describe, expect, it } from "vitest";
import {
  buildShopifyCsv,
  csvEscape,
  indexNewPages,
  isIdLike,
  makeNewPage,
  matchOld,
  parseSiteUrl,
  safeDecode,
  shortlist,
  similarity,
  tokenize,
  type ParsedSiteUrl,
} from "@worker/redirects/match";

const HOST = "shop.example.com";

function url(input: string, side: "old" | "new" = "old"): ParsedSiteUrl {
  const r = parseSiteUrl(input, HOST, side);
  if (!r.ok) throw new Error(`expected ${input} to parse: ${r.reason}`);
  return r.url;
}
const page = (input: string, title: string | null = null, h1: string[] = []) => makeNewPage(url(input, "new"), title, h1);

describe("redirect map: URL normalization", () => {
  it("lowercases the host, strips the trailing slash, and drops query/fragment for matching", () => {
    const u = url("HTTPS://Shop.Example.com./Old-Page/?utm_source=x#top");
    expect(u.host).toBe(HOST);
    expect(u.path).toBe("/Old-Page");
    expect(u.matchPath).toBe("/old-page");
    expect(u.search).toBe("");
    expect(u.droppedQuery).toBe(true);
    expect(u.absolute).toBe("https://shop.example.com/Old-Page");
  });

  it("canonicalizes Shopify nested product paths to /products/<handle>", () => {
    const u = url("https://shop.example.com/collections/Lamps/products/Brass-Table-Lamp/");
    expect(u.path).toBe("/collections/Lamps/products/Brass-Table-Lamp");
    expect(u.matchPath).toBe("/products/brass-table-lamp");
    expect(u.slugTokens).toEqual(["brass", "table", "lamp"]);
    // Only the nested product form is rewritten.
    expect(url("/collections/lamps").matchPath).toBe("/collections/lamps");
    expect(url("/collections/lamps/products/x/extra").matchPath).toBe("/products/x/extra");
  });

  it("decodes percent-encoding safely (malformed escapes are kept, never thrown)", () => {
    expect(url("/caf%C3%A9-chairs").matchPath).toBe("/café-chairs");
    expect(safeDecode("bad%E0%A4%A")).toBe("bad%E0%A4%A");
    expect(safeDecode("ok%20then%ZZ")).toBe("ok then%ZZ");
    expect(() => url("/100%-cotton")).not.toThrow();
  });

  it("collapses duplicate slashes and accepts paths, bare paths, and host/path without a scheme", () => {
    expect(url("//shop.example.com//a///b/").matchPath).toBe("/a/b");
    expect(url("old-page").path).toBe("/old-page");
    expect(url("about-us.html").path).toBe("/about-us.html");
    expect(url("shop.example.com/products/x").matchPath).toBe("/products/x");
    expect(url("/").matchPath).toBe("/");
  });

  it("rejects non-http(s) schemes, credentials, ports, and other hosts", () => {
    for (const bad of ["javascript:alert(1)", "ftp://shop.example.com/x", "mailto:a@shop.example.com", "data:text/html,hi"]) {
      const r = parseSiteUrl(bad, HOST, "old");
      expect(r.ok, bad).toBe(false);
    }
    expect(parseSiteUrl("https://user:pw@shop.example.com/x", HOST, "old").ok).toBe(false);
    expect(parseSiteUrl("https://shop.example.com:8443/x", HOST, "new").ok).toBe(false);
    expect(parseSiteUrl("https://evil.example/x", HOST, "old").ok).toBe(false);
    expect(parseSiteUrl("//evil.example/x", HOST, "new").ok).toBe(false);
  });

  it("new URLs must be on the verified host exactly; old URLs may use the www twin", () => {
    const n = parseSiteUrl("https://www.shop.example.com/products/x", HOST, "new");
    expect(n.ok).toBe(false);
    if (!n.ok) expect(n.reason).toMatch(/verified host shop\.example\.com/);
    expect(parseSiteUrl("https://other.example.com/products/x", HOST, "new").ok).toBe(false);
    expect(parseSiteUrl("https://www.shop.example.com/old", HOST, "old").ok).toBe(true);
    expect(parseSiteUrl("http://shop.example.com/products/x", HOST, "new").ok).toBe(true);
  });

  it("keeps the query on new-side targets but never uses it for matching", () => {
    const u = url("/products/x?variant=1", "new");
    expect(u.search).toBe("?variant=1");
    expect(u.absolute).toBe("https://shop.example.com/products/x?variant=1");
    expect(u.matchPath).toBe("/products/x");
  });
});

describe("redirect map: tokens", () => {
  it("removes extensions, stop words, numbers, ids, and UUIDs; singularizes simple plurals", () => {
    expect(url("/shop/12345-the-brass-cabinet-knobs.html").slugTokens).toEqual(["brass", "cabinet", "knob"]);
    expect(url("/p/sku98765-oak-tables").slugTokens).toEqual(["oak", "table"]);
    expect(url("/item/550e8400-e29b-41d4-a716-446655440000-linen-sofa").slugTokens).toEqual(["linen", "sofa"]);
    expect(tokenize("Accessories & Glass Lamps")).toEqual(["accessory", "glass", "lamp"]);
    expect(isIdLike("2024")).toBe(true);
    expect(isIdLike("deadbeef42")).toBe(true);
    expect(isIdLike("24in")).toBe(false);
    expect(isIdLike("brass")).toBe(false);
  });

  it("path tokens skip structural words such as products and collections", () => {
    expect(url("/collections/lighting/table-lamps").pathTokens).toEqual(["lighting", "table", "lamp"]);
  });
});

describe("redirect map: deterministic matching", () => {
  it("exact path (after normalization) wins, including Shopify nested product URLs", () => {
    const index = indexNewPages([page("/products/brass-table-lamp"), page("/collections/lamps")]);
    const m = matchOld(url("/collections/sale/products/Brass-Table-Lamp/"), index);
    expect(m.kind).toBe("exact_path");
    if (m.kind === "exact_path") expect(m.page.url.path).toBe("/products/brass-table-lamp");
  });

  it("normalized slug matches a unique new URL with the same slug words", () => {
    const index = indexNewPages([page("/products/brass-cabinet-knobs"), page("/collections/knobs")]);
    const m = matchOld(url("/shop/1234-brass-cabinet-knob.html"), index);
    expect(m.kind).toBe("normalized_slug");
    if (m.kind === "normalized_slug") expect(m.page.url.path).toBe("/products/brass-cabinet-knobs");
  });

  it("a one-token slug only auto-matches when the raw slug is identical", () => {
    const index = indexNewPages([page("/collections/lamp")]);
    expect(matchOld(url("/p/12345-lamp"), index).kind).toBe("unresolved");
    expect(matchOld(url("/shop/lamp"), index).kind).toBe("normalized_slug");
  });

  it("an ambiguous slug (several new URLs) is not matched automatically", () => {
    const index = indexNewPages([page("/products/oak-table"), page("/blogs/news/oak-table")]);
    const m = matchOld(url("/old/oak-tables"), index);
    expect(m.kind).toBe("unresolved");
    if (m.kind === "unresolved") {
      expect(m.ambiguousSlug).toBe(2);
      expect(m.candidates.map((c) => c.page.url.path)).toEqual(expect.arrayContaining(["/products/oak-table", "/blogs/news/oak-table"]));
    }
  });

  it("dedupes new URLs by normalized path (first wins)", () => {
    const index = indexNewPages([page("/products/x"), page("/Products/X/"), page("/collections/all/products/x")]);
    expect(index.pages).toHaveLength(1);
  });
});

describe("redirect map: shortlist formula", () => {
  it("score = (0.55 slugSim + 0.30 titleSim + 0.15 pathSim) / weights used", () => {
    const old = url("/lighting/brass-table-lamp");
    // slugSim = 2*2/(3+2) = 0.8; pathSim = 2*2/(4+2) = 0.667; no title: (0.44 + 0.1) / 0.70 = 0.771
    expect(similarity(old, page("/products/brass-lamp"))).toBe(0.771);
    // with a title covering all 3 old slug tokens: (0.44 + 0.30 + 0.1) / 1.0 = 0.84
    expect(similarity(old, page("/products/brass-lamp", "Brass Table Lamp | Shop"))).toBe(0.84);
    // an H1 alone also counts as title evidence
    expect(similarity(old, page("/products/brass-lamp", null, ["Brass table lamp"]))).toBe(0.84);
    expect(similarity(old, page("/pages/contact"))).toBe(0);
  });

  it("returns at most 5 candidates with score > 0, best first, ties by URL", () => {
    const pages = [
      page("/products/brass-lamp-alpha"),
      page("/products/brass-lamp-bravo"),
      page("/products/brass-lamp-charlie"),
      page("/products/brass-lamp-delta"),
      page("/products/brass-lamp-echo"),
      page("/products/brass-lamp-foxtrot"),
      page("/products/brass-table-lamp-large"),
      page("/pages/contact"),
    ];
    const s = shortlist(url("/old/brass-table-lamp"), pages);
    expect(s).toHaveLength(5);
    expect(s[0]!.page.url.path).toBe("/products/brass-table-lamp-large");
    expect(s.every((e) => e.score > 0)).toBe(true);
    expect(s.slice(1).map((e) => e.page.url.path)).toEqual(["/products/brass-lamp-alpha", "/products/brass-lamp-bravo", "/products/brass-lamp-charlie", "/products/brass-lamp-delta"]);
  });
});

describe("redirect map: Shopify CSV", () => {
  it("escapes commas, quotes, newlines, and edge spaces (RFC 4180)", () => {
    expect(csvEscape("/plain")).toBe("/plain");
    expect(csvEscape("/a,b")).toBe('"/a,b"');
    expect(csvEscape('/say-"hi"')).toBe('"/say-""hi"""');
    expect(csvEscape("/line\nbreak")).toBe('"/line\nbreak"');
    expect(csvEscape(" /x")).toBe('" /x"');
  });

  it("has the Shopify header and path-only rows", () => {
    expect(buildShopifyCsv([])).toBe("Redirect from,Redirect to\n");
    expect(buildShopifyCsv([{ fromPath: "/old,one", toPath: "/products/new?variant=1" }])).toBe('Redirect from,Redirect to\n"/old,one",/products/new?variant=1\n');
  });
});
