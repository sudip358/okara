/**
 * [A23] Schema-content match prefilter (SCHEMA_MATCH_VERSION). Pure.
 *
 * Deterministic conflicts between a page's JSON-LD types (as stored by the crawler) and what the crawl
 * shows about the page shortlist it for seo.schema_content_match (Noul), which judges the actual match:
 *   product_on_article   Product / ProductGroup / Offer / AggregateOffer markup on a page classified article
 *   article_on_product   Article / BlogPosting / NewsArticle markup on a page classified product
 *   faq_without_questions FAQPage markup, but no crawled heading or H1 is phrased as a question
 * Offer price vs visible price (`offerPriceCheck`): compares Offer prices from JSON-LD with prices in the
 * visible text. The crawler does not store Offer price values or a visible price today, so the check is
 * skipped (status 'skipped') until those fields exist; it never guesses a price.
 */
export const SCHEMA_MATCH_VERSION = "schema-match-2026-09-30.1";

const PRODUCT_TYPES = new Set(["Product", "ProductGroup", "Offer", "AggregateOffer", "IndividualProduct", "ProductModel"]);
const ARTICLE_TYPES = new Set(["Article", "BlogPosting", "NewsArticle", "TechArticle"]);
const QUESTION_HEADING = /\?\s*$|^(how|what|why|which|when|where|who|can|does|do|is|are|should|will)\b/i;

export type SchemaConflict = "product_on_article" | "article_on_product" | "faq_without_questions";

export const SCHEMA_CONFLICT_TEXT: Record<SchemaConflict, string> = {
  product_on_article: "Product or Offer markup on a page classified as an article",
  article_on_product: "Article markup on a page classified as a product page",
  faq_without_questions: "FAQPage markup, but no crawled heading is phrased as a question",
};

export function schemaConflicts(p: { pageType: string; jsonLdTypes: readonly string[]; headings: readonly string[]; h1: string | null }): SchemaConflict[] {
  const types = new Set(p.jsonLdTypes);
  const out: SchemaConflict[] = [];
  if (p.pageType === "article" && [...types].some((t) => PRODUCT_TYPES.has(t))) out.push("product_on_article");
  if (p.pageType === "product" && [...types].some((t) => ARTICLE_TYPES.has(t))) out.push("article_on_product");
  if (types.has("FAQPage") && ![p.h1 ?? "", ...p.headings].some((h) => QUESTION_HEADING.test(h.trim()))) out.push("faq_without_questions");
  return out;
}

export interface PriceCheck {
  status: "match" | "mismatch" | "skipped";
  reason: string;
  offerPrices: number[];
  visiblePrices: number[];
}

const PRICE_RE = /(?:[$€£¥]\s?|\b(?:USD|EUR|GBP|CAD|AUD)\s?)(\d{1,3}(?:[,.\s]\d{3})*(?:[.,]\d{2})?|\d+(?:[.,]\d{2})?)|(\d{1,3}(?:[,.]\d{3})*(?:[.,]\d{2})?|\d+(?:[.,]\d{2})?)\s?(?:USD|EUR|GBP|CAD|AUD|€|£)/g;

function toNumber(raw: string): number | null {
  let t = raw.replace(/\s/g, "");
  // "1.299,00" (comma decimals) -> 1299.00; "1,299.00" -> 1299.00
  if (/,\d{2}$/.test(t) && !/\.\d{2}$/.test(t)) t = t.replace(/\./g, "").replace(",", ".");
  else t = t.replace(/,/g, "");
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function visiblePrices(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(PRICE_RE)) {
    const n = toNumber(m[1] ?? m[2] ?? "");
    if (n !== null && n > 0) out.push(n);
  }
  return [...new Set(out)].slice(0, 20);
}

/** Offer price(s) vs prices in the visible text. Skipped when either side is unavailable. */
export function offerPriceCheck(offerPrices: readonly number[] | null, visibleText: string | null): PriceCheck {
  const offers = (offerPrices ?? []).filter((n) => Number.isFinite(n) && n > 0);
  if (offers.length === 0) return { status: "skipped", reason: "No Offer price values are stored for this page.", offerPrices: [], visiblePrices: [] };
  const shown = visibleText ? visiblePrices(visibleText) : [];
  if (shown.length === 0) return { status: "skipped", reason: "No visible price was found in the stored page text.", offerPrices: offers, visiblePrices: [] };
  const match = offers.some((o) => shown.some((v) => Math.abs(o - v) < 0.005));
  return match
    ? { status: "match", reason: "An Offer price equals a visible price.", offerPrices: offers, visiblePrices: shown }
    : { status: "mismatch", reason: `Offer price ${offers.join(", ")} does not equal any visible price (${shown.join(", ")}).`, offerPrices: offers, visiblePrices: shown };
}
