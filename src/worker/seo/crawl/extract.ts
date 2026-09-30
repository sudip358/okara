/**
 * Compact evidence extraction from crawled HTML.
 *
 * Parser choice: htmlparser2 (event-based, streaming-capable tokenizer) replaces Cloudflare's
 * HTMLRewriter for portability and testability: it runs identically on Workers and in Node/Vitest, so
 * the same extractor is exercised by the fixture tests. It never builds a DOM and every collected field
 * is capped, so memory stays bounded for the capped response sizes enforced by the SSRF guard.
 *
 * Only compact evidence leaves this module (title, meta, headings, links, JSON-LD types/issues, a
 * 2,000-char excerpt, ...); full HTML is never stored. Page text is untrusted evidence, never
 * instructions.
 */
import { Parser } from "htmlparser2";
import { normalizeHost } from "../ssrf";

export const CAPS = {
  title: 300,
  metaDescription: 500,
  headingText: 200,
  headings: 60,
  internalLinks: 200,
  excerpt: 2000,
  firstParagraph: 400,
  jsonLdBlocks: 20,
  jsonLdBytes: 200_000,
} as const;

export interface JsonLdIssue {
  type: string;
  issue:
    | "invalid_json"
    | "missing_name"
    | "missing_offers"
    | "offer_missing_price"
    | "offer_missing_currency"
    | "aggregate_offer_missing_low_price";
  detail: string;
}

export interface ExtractedPage {
  title: string | null;
  metaDescription: string | null;
  metaRobots: string | null;
  canonical: string | null;
  h1s: string[];
  headings: Array<{ level: number; text: string }>;
  internalLinks: string[];
  jsonLdTypes: string[];
  jsonLdIssues: JsonLdIssue[];
  hasProductOffer: boolean;
  wordCount: number;
  excerpt: string;
  firstParagraph: string | null;
  author: string | null;
  lastUpdated: string | null;
  outboundCitations: number;
  tableCount: number;
  hasAppRoot: boolean;
  jsRendered: boolean;
}

const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "svg", "iframe", "object", "canvas"]);
const BOILERPLATE_TAGS = new Set(["nav", "header", "footer", "aside"]);
const BLOCK_TAGS = new Set([
  "p", "div", "section", "article", "main", "li", "ul", "ol", "br", "tr", "td", "th", "table",
  "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "dd", "dt", "figcaption", "form",
]);
const APP_ROOT_IDS = new Set(["root", "app", "__next", "__nuxt", "___gatsby", "svelte", "q-app"]);

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
export const countWords = (s: string) => (s.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;

/** Resolve an href against the page URL; http(s) only; hash stripped. */
function resolveHref(href: string, base: URL): URL | null {
  const h = href.trim();
  if (!h || h.startsWith("#") || /^(javascript|mailto|tel|data|sms|ftp):/i.test(h)) return null;
  try {
    const u = new URL(h, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u;
  } catch {
    return null;
  }
}

export function extractPage(html: string, pageUrl: string): ExtractedPage {
  const base = new URL(pageUrl);
  const pageHost = normalizeHost(base.hostname);

  let title: string | null = null;
  let metaDescription: string | null = null;
  const robotsParts: string[] = [];
  let canonical: string | null = null;
  let authorMeta: string | null = null;
  let modifiedMeta: string | null = null;
  const headings: Array<{ level: number; text: string }> = [];
  const h1s: string[] = [];
  const internal = new Set<string>();
  const outbound = new Set<string>();
  let tableCount = 0;
  let hasAppRoot = false;
  let hasMain = false;

  const jsonLdRaw: string[] = [];

  // Element state
  let skipDepth = 0;
  let boilerDepth = 0;
  let svgDepth = 0;
  let mainDepth = 0;
  let inTitle = false;
  let titleBuf = "";
  let headingLevel = 0;
  let headingBuf = "";
  let inJsonLd = false;
  let jsonLdBuf = "";
  let pDepth = 0;
  let pBuf = "";
  let firstParagraph: string | null = null;
  let inBody = false;

  // Text accumulators (bounded): body text excluding boilerplate, and text inside <main>/<article role=main>.
  const MAX_TEXT = 400_000;
  let bodyText = "";
  let mainText = "";
  const pushText = (t: string) => {
    if (bodyText.length < MAX_TEXT) bodyText += t;
    if (mainDepth > 0 && mainText.length < MAX_TEXT) mainText += t;
  };

  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (name === "body") inBody = true;
        if (name === "svg") svgDepth++;
        if (name === "script") {
          const type = (attrs.type ?? "").toLowerCase().trim();
          if (type === "application/ld+json" && jsonLdRaw.length < CAPS.jsonLdBlocks) {
            inJsonLd = true;
            jsonLdBuf = "";
          }
        }
        if (SKIP_TAGS.has(name)) {
          skipDepth++;
          return;
        }
        if (BOILERPLATE_TAGS.has(name)) boilerDepth++;
        if (name === "main" || attrs.role === "main") {
          mainDepth++;
          hasMain = true;
        }
        if (BLOCK_TAGS.has(name)) pushText(" ");

        const id = (attrs.id ?? "").toLowerCase();
        if (name === "div" && (APP_ROOT_IDS.has(id) || "data-reactroot" in attrs || "ng-app" in attrs || "data-server-rendered" in attrs)) {
          hasAppRoot = true;
        }
        if (name === "app-root") hasAppRoot = true;

        if (name === "title" && svgDepth === 0 && title === null) {
          inTitle = true;
          titleBuf = "";
        } else if (name === "meta") {
          const key = (attrs.name ?? attrs.property ?? "").toLowerCase().trim();
          const content = attrs.content ?? "";
          if (key === "description" && metaDescription === null) metaDescription = cap(collapse(content), CAPS.metaDescription);
          else if (key === "robots") robotsParts.push(collapse(content).toLowerCase());
          else if (key === "author" && !authorMeta) authorMeta = cap(collapse(content), 200) || null;
          else if ((key === "article:modified_time" || key === "og:updated_time") && !modifiedMeta) modifiedMeta = cap(collapse(content), 64) || null;
        } else if (name === "link") {
          const rel = (attrs.rel ?? "").toLowerCase().split(/\s+/);
          if (rel.includes("canonical") && canonical === null && attrs.href) {
            const u = resolveHref(attrs.href, base);
            canonical = u ? u.toString() : cap(attrs.href.trim(), 500);
          }
        } else if (/^h[1-6]$/.test(name) && skipDepth === 0) {
          headingLevel = Number(name[1]);
          headingBuf = "";
        } else if (name === "a" && attrs.href) {
          const u = resolveHref(attrs.href, base);
          if (u) {
            const host = normalizeHost(u.hostname);
            if (host === pageHost) {
              if (internal.size < CAPS.internalLinks) internal.add(u.toString());
            } else if (boilerDepth === 0 && inBody) {
              outbound.add(u.toString());
            }
          }
        } else if (name === "table") {
          tableCount++;
        } else if (name === "p" && boilerDepth === 0 && inBody) {
          pDepth++;
          if (pDepth === 1) pBuf = "";
        }
      },
      ontext(text) {
        if (inJsonLd) {
          if (jsonLdBuf.length < CAPS.jsonLdBytes) jsonLdBuf += text;
          return;
        }
        if (inTitle) {
          titleBuf += text;
          return;
        }
        if (skipDepth > 0) return;
        if (headingLevel) headingBuf += text;
        if (pDepth > 0 && pBuf.length < 4000) pBuf += text;
        if (boilerDepth === 0 && inBody) pushText(text);
      },
      onclosetag(name) {
        if (name === "script" && inJsonLd) {
          inJsonLd = false;
          jsonLdRaw.push(jsonLdBuf);
        }
        if (name === "svg" && svgDepth > 0) svgDepth--;
        if (SKIP_TAGS.has(name)) {
          if (skipDepth > 0) skipDepth--;
          return;
        }
        if (name === "title" && inTitle) {
          inTitle = false;
          title = cap(collapse(titleBuf), CAPS.title);
        }
        if (/^h[1-6]$/.test(name) && headingLevel) {
          const text = cap(collapse(headingBuf), CAPS.headingText);
          if (headingLevel === 1) h1s.push(text);
          if (headings.length < CAPS.headings) headings.push({ level: headingLevel, text });
          headingLevel = 0;
        }
        if (name === "p" && pDepth > 0) {
          pDepth--;
          if (pDepth === 0 && firstParagraph === null) {
            const t = collapse(pBuf);
            if (countWords(t) >= 3) firstParagraph = cap(t, CAPS.firstParagraph);
          }
        }
        if (BOILERPLATE_TAGS.has(name) && boilerDepth > 0) boilerDepth--;
        if (name === "main" && mainDepth > 0) mainDepth--;
        if (BLOCK_TAGS.has(name)) pushText(" ");
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();

  const text = collapse(hasMain && mainText.trim() ? mainText : bodyText);
  const wordCount = countWords(text);

  const ld = analyzeJsonLd(jsonLdRaw);
  const jsRendered = wordCount < 50 && hasAppRoot;

  return {
    title: title || null,
    metaDescription,
    metaRobots: robotsParts.length ? robotsParts.join(", ") : null,
    canonical,
    h1s,
    headings,
    internalLinks: [...internal],
    jsonLdTypes: ld.types,
    jsonLdIssues: ld.issues,
    hasProductOffer: ld.hasProductOffer,
    wordCount,
    excerpt: cap(text, CAPS.excerpt),
    firstParagraph,
    author: authorMeta ?? ld.author,
    lastUpdated: modifiedMeta ?? ld.dateModified,
    outboundCitations: outbound.size,
    tableCount,
    hasAppRoot,
    jsRendered,
  };
}

// ------------------------------------------------------------------------------------------- JSON-LD

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function typesOf(node: { [k: string]: Json }): string[] {
  const t = node["@type"];
  const list = Array.isArray(t) ? t : t === undefined ? [] : [t];
  return list.filter((x): x is string => typeof x === "string").map((x) => x.replace(/^https?:\/\/schema\.org\//i, ""));
}

function asArray(v: Json | undefined): Json[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function nonEmpty(v: Json | undefined): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (typeof v === "number") return Number.isFinite(v);
  return true;
}

function nameOf(v: Json | undefined): string | null {
  for (const item of asArray(v)) {
    if (typeof item === "string" && item.trim()) return cap(item.trim(), 200);
    if (item && typeof item === "object" && !Array.isArray(item) && typeof item.name === "string" && item.name.trim()) return cap(item.name.trim(), 200);
  }
  return null;
}

/** Top-level JSON-LD nodes: arrays and @graph members are flattened one level. */
function topNodes(doc: Json): Array<{ [k: string]: Json }> {
  const out: Array<{ [k: string]: Json }> = [];
  for (const item of asArray(doc)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    if (Array.isArray(item["@graph"])) {
      for (const g of item["@graph"]) if (g && typeof g === "object" && !Array.isArray(g)) out.push(g);
    }
    if (item["@type"] !== undefined) out.push(item);
  }
  return out;
}

function checkProduct(node: { [k: string]: Json }, issues: JsonLdIssue[]): boolean {
  if (!nonEmpty(node.name)) issues.push({ type: "Product", issue: "missing_name", detail: "Product has no name." });
  const offers = asArray(node.offers).filter((o): o is { [k: string]: Json } => !!o && typeof o === "object" && !Array.isArray(o));
  if (offers.length === 0) {
    issues.push({ type: "Product", issue: "missing_offers", detail: "Product has no offers." });
    return false;
  }
  let complete = false;
  for (const offer of offers) {
    const t = typesOf(offer);
    if (t.includes("AggregateOffer")) {
      const hasLow = nonEmpty(offer.lowPrice);
      const hasCur = nonEmpty(offer.priceCurrency);
      if (!hasLow) issues.push({ type: "Product", issue: "aggregate_offer_missing_low_price", detail: "AggregateOffer has no lowPrice." });
      if (!hasCur) issues.push({ type: "Product", issue: "offer_missing_currency", detail: "AggregateOffer has no priceCurrency." });
      if (hasLow && hasCur) complete = true;
      continue;
    }
    const spec = asArray(offer.priceSpecification).find((s) => s && typeof s === "object" && !Array.isArray(s)) as { [k: string]: Json } | undefined;
    const hasPrice = nonEmpty(offer.price) || (spec ? nonEmpty(spec.price) : false);
    const hasCur = nonEmpty(offer.priceCurrency) || (spec ? nonEmpty(spec.priceCurrency) : false);
    if (!hasPrice) issues.push({ type: "Product", issue: "offer_missing_price", detail: "Offer has no price." });
    if (!hasCur) issues.push({ type: "Product", issue: "offer_missing_currency", detail: "Offer has no priceCurrency." });
    if (hasPrice && hasCur) complete = true;
  }
  return complete;
}

export function analyzeJsonLd(blocks: string[]): {
  types: string[];
  issues: JsonLdIssue[];
  hasProductOffer: boolean;
  author: string | null;
  dateModified: string | null;
} {
  const types = new Set<string>();
  const issues: JsonLdIssue[] = [];
  let hasProductOffer = false;
  let author: string | null = null;
  let dateModified: string | null = null;
  for (const raw of blocks) {
    let doc: Json;
    try {
      doc = JSON.parse(raw.trim().replace(/^<!--|-->$/g, "")) as Json;
    } catch {
      issues.push({ type: "(unparsed)", issue: "invalid_json", detail: "A JSON-LD block is not valid JSON." });
      continue;
    }
    for (const node of topNodes(doc)) {
      const t = typesOf(node);
      t.forEach((x) => types.add(x));
      if (t.includes("Product") || t.includes("ProductGroup")) {
        if (checkProduct(node, issues)) hasProductOffer = true;
      }
      if (!author && node.author !== undefined) author = nameOf(node.author);
      if (!dateModified && typeof node.dateModified === "string") dateModified = cap(node.dateModified, 64);
    }
  }
  // Deduplicate identical issues (e.g. several offers each missing currency).
  const seen = new Set<string>();
  const uniq = issues.filter((i) => {
    const k = `${i.type}:${i.issue}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { types: [...types].slice(0, 30), issues: uniq, hasProductOffer, author, dateModified };
}
