/**
 * Page-type classification (build kit SEO AGENT): JSON-LD types first, then URL patterns (Shopify and
 * generic), then sitemap membership (e.g. Shopify's sitemap_products_1.xml), else 'other'. The method is
 * stored with the page so users can see and correct it (a 'user' method is never overwritten).
 */
import type { PageType } from "@shared/types";

export type PageTypeMethod = "url_pattern" | "jsonld" | "sitemap" | "default" | "user";

export interface Classification {
  pageType: PageType;
  method: PageTypeMethod;
}

const JSONLD_MAP: Array<[string[], PageType]> = [
  [["Product", "ProductGroup"], "product"],
  [["CollectionPage", "ItemList", "OfferCatalog", "SearchResultsPage"], "collection"],
  [["Article", "BlogPosting", "NewsArticle", "TechArticle", "Report"], "article"],
];

const URL_PATTERNS: Array<[RegExp, PageType]> = [
  // Shopify: /products/x and /collections/c/products/x
  [/\/products\/[^/]+\/?$/i, "product"],
  [/\/(product|p|item|dp)\/[^/]+/i, "product"],
  [/\/collections(\/[^/]+)?\/?$/i, "collection"],
  [/\/(category|categories|shop|catalog|c)\/[^/]+/i, "collection"],
  [/\/blogs\/[^/]+\/[^/]+/i, "article"],
  [/\/(blog|blogs|news|articles|article|posts|post|guides|journal)\/[^/]+/i, "article"],
  [/\/(pages|landing|lp|l)\/[^/]+/i, "landing"],
];

const SITEMAP_MAP: Array<[RegExp, PageType]> = [
  [/product/i, "product"],
  [/collection|categor/i, "collection"],
  [/blog|article|post|news/i, "article"],
  [/^sitemap_pages/i, "landing"],
];

export function classifyPageType(input: { url: string; jsonLdTypes?: string[]; sitemapFile?: string | null }): Classification {
  let u: URL;
  try {
    u = new URL(input.url);
  } catch {
    return { pageType: "other", method: "default" };
  }
  const path = u.pathname.replace(/\/+$/, "") || "/";
  if (path === "/" && !u.search) return { pageType: "home", method: "url_pattern" };

  const types = input.jsonLdTypes ?? [];
  for (const [names, type] of JSONLD_MAP) {
    if (names.some((n) => types.includes(n))) return { pageType: type, method: "jsonld" };
  }
  for (const [re, type] of URL_PATTERNS) {
    if (re.test(u.pathname)) return { pageType: type, method: "url_pattern" };
  }
  if (input.sitemapFile) {
    for (const [re, type] of SITEMAP_MAP) {
      if (re.test(input.sitemapFile)) return { pageType: type, method: "sitemap" };
    }
  }
  return { pageType: "other", method: "default" };
}

/** Template label used for grouping findings (e.g. 'product template'). */
export function templateName(pageType: PageType): string | null {
  return pageType === "product" || pageType === "collection" || pageType === "article" ? `${pageType} template` : null;
}
