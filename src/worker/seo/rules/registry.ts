/**
 * [A16] Deterministic rule registry. Every rule has a stable id, area, class (fact | heuristic),
 * severity, applicable page types, an applicability/limitations text, and an emitter. A registry test
 * fails when a registered rule has no emitter or never fires on its positive fixture, so any rule count
 * shown to users is real.
 *
 * Findings are per URL (or site-wide with url null). For templateable rules, when several URLs of the
 * same templated page type share an issue, each finding carries `template` (e.g. 'product template') so
 * the SEO analysis module can emit one template recommendation instead of N page ones ([A9]).
 * Priority is NOT computed here (seo-analysis owns the versioned reach-weighted formula).
 */
import type { AiCrawlerAccess, PageType, Severity, SiteType } from "@shared/types";
import { normalizeHost } from "../ssrf";
import { robotsAllows, type RobotsState } from "../crawl/robots";
import { FLAGGED_PURPOSES } from "./ai-crawlers";
import { templateName } from "../crawl/page-type";
import type { JsonLdIssue } from "../crawl/extract";
import { countWords } from "../crawl/extract";

export const RULESET_VERSION = "2026-09-30.2";
/** Minimum URLs of one page type sharing an issue before findings are labelled with a template. */
export const TEMPLATE_MIN_URLS = 3;

export interface RuleSnapshot {
  url: string;
  finalUrl: string | null;
  statusCode: number | null;
  pageType: PageType;
  skippedReason: string | null;
  title: string | null;
  metaDescription: string | null;
  h1s: string[];
  headings: Array<{ level: number; text: string }>;
  canonical: string | null;
  robotsMeta: string | null;
  jsonLdTypes: string[];
  jsonLdIssues: JsonLdIssue[];
  internalLinks: string[];
  wordCount: number | null;
  firstParagraph: string | null;
  contentHash: string | null;
  /** Hash of the extracted main text (duplicate-content detection); falls back to contentHash. */
  textHash?: string | null;
}

export interface RuleInput {
  siteType: SiteType;
  verifiedHost: string;
  snapshots: RuleSnapshot[];
  sitemapUrls: string[];
  robots: RobotsState | null;
  aiCrawlerAccess: AiCrawlerAccess | null;
}

export interface RuleContext extends RuleInput {
  /** Analyzable (2xx, not skipped, not redirected) snapshots whose page type the rule applies to. */
  pages: RuleSnapshot[];
  /** Every snapshot in the crawl (including errors/skips). */
  all: RuleSnapshot[];
}

export interface RuleFinding {
  ruleId: string;
  severity: Severity;
  url: string | null;
  template: string | null;
  pageType: PageType | null;
  detail: string;
  evidence: Record<string, unknown>;
}

type Emitted = Omit<RuleFinding, "ruleId" | "severity" | "template">;

export interface Rule {
  id: string;
  name: string;
  area: "indexing" | "metadata" | "headings" | "canonical" | "status" | "links" | "content" | "structured_data" | "ecommerce" | "ai_crawlers";
  class: "fact" | "heuristic";
  severity: Severity;
  appliesTo: PageType[] | "all";
  /** Site types this rule runs for; omitted = all site types. */
  siteTypes?: SiteType[];
  templateable: boolean;
  applicability: string;
  emit(ctx: RuleContext): Emitted[];
}

// ------------------------------------------------------------------------------------------ helpers

export function normalizeUrlKey(u: string): string {
  try {
    const url = new URL(u);
    url.hash = "";
    url.hostname = normalizeHost(url.hostname);
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return u;
  }
}

export function isAnalyzable(s: RuleSnapshot): boolean {
  const ok = s.statusCode !== null && s.statusCode >= 200 && s.statusCode < 300 && !s.skippedReason;
  const redirected = !!s.finalUrl && normalizeUrlKey(s.finalUrl) !== normalizeUrlKey(s.url);
  return ok && !redirected;
}

const page = (s: RuleSnapshot, detail: string, evidence: Record<string, unknown> = {}): Emitted => ({
  url: s.url,
  pageType: s.pageType,
  detail,
  evidence,
});

function canonicalPointsElsewhere(s: RuleSnapshot): boolean {
  return !!s.canonical && normalizeUrlKey(s.canonical) !== normalizeUrlKey(s.url);
}

function duplicateGroups(pages: RuleSnapshot[], key: (s: RuleSnapshot) => string | null): RuleSnapshot[][] {
  const map = new Map<string, RuleSnapshot[]>();
  for (const s of pages) {
    if (canonicalPointsElsewhere(s)) continue; // consolidated by canonical: intended duplicate
    const k = key(s);
    if (!k) continue;
    const list = map.get(k) ?? [];
    list.push(s);
    map.set(k, list);
  }
  return [...map.values()].filter((g) => g.length > 1);
}

function emitDuplicates(groups: RuleSnapshot[][], what: string, valueOf: (s: RuleSnapshot) => string | null): Emitted[] {
  const out: Emitted[] = [];
  for (const g of groups) {
    for (const s of g) {
      const others = g.filter((o) => o !== s).map((o) => o.url);
      out.push(page(s, `${what} is shared with ${others.length} other crawled URL(s).`, { value: valueOf(s), otherUrls: others.slice(0, 5), groupSize: g.length }));
    }
  }
  return out;
}

const FACET_PARAM = /^(filter(\..+)?|filters?|sort|sort_by|sortby|order|orderby|dir|view|limit|per_page|price|min_price|max_price|color|colour|size|brand|material|finish|constraint|pf_.+|q)$/i;

function facetParams(u: string): string[] {
  try {
    return [...new URL(u).searchParams.keys()].filter((k) => FACET_PARAM.test(k));
  } catch {
    return [];
  }
}

function canonicalHasParams(canonical: string | null, params: string[]): boolean {
  if (!canonical) return true;
  try {
    const c = new URL(canonical);
    return params.some((p) => c.searchParams.has(p));
  } catch {
    return true;
  }
}

const PRODUCT_OFFER_ISSUES = new Set<JsonLdIssue["issue"]>(["missing_offers", "offer_missing_price", "offer_missing_currency", "aggregate_offer_missing_low_price"]);

// ------------------------------------------------------------------------------------------ rules

export const RULES: readonly Rule[] = [
  {
    id: "SEO-TITLE-MISSING",
    name: "Missing title",
    area: "metadata",
    class: "fact",
    severity: "major",
    appliesTo: "all",
    templateable: true,
    applicability: "Search engines may generate a title from page content when none is present, but a missing <title> removes your control over it.",
    emit: (ctx) => ctx.pages.filter((s) => !s.title?.trim()).map((s) => page(s, "The page has no <title> element or it is empty.")),
  },
  {
    id: "SEO-TITLE-DUPLICATE",
    name: "Duplicate title",
    area: "metadata",
    class: "fact",
    severity: "moderate",
    appliesTo: "all",
    templateable: false,
    applicability: "Duplicate titles make pages harder to tell apart in results; they are not a penalty. Pages consolidated by canonical are excluded.",
    emit: (ctx) =>
      emitDuplicates(
        duplicateGroups(ctx.pages, (s) => (s.title?.trim() ? s.title.trim().toLowerCase() : null)),
        "Title",
        (s) => s.title,
      ),
  },
  {
    id: "SEO-META-DESC-MISSING",
    name: "Missing meta description",
    area: "metadata",
    class: "fact",
    severity: "minor",
    appliesTo: "all",
    templateable: true,
    applicability: "Meta descriptions are not a ranking factor; search engines may generate snippets from page text regardless.",
    emit: (ctx) => ctx.pages.filter((s) => !s.metaDescription?.trim()).map((s) => page(s, "The page has no meta description.")),
  },
  {
    id: "SEO-META-DESC-DUPLICATE",
    name: "Duplicate meta description",
    area: "metadata",
    class: "fact",
    severity: "minor",
    appliesTo: "all",
    templateable: false,
    applicability: "Shared descriptions reduce snippet usefulness; search engines may rewrite snippets anyway.",
    emit: (ctx) =>
      emitDuplicates(
        duplicateGroups(ctx.pages, (s) => (s.metaDescription?.trim() ? s.metaDescription.trim().toLowerCase() : null)),
        "Meta description",
        (s) => s.metaDescription,
      ),
  },
  {
    id: "SEO-H1-MISSING",
    name: "Missing H1",
    area: "headings",
    class: "heuristic",
    severity: "moderate",
    appliesTo: "all",
    templateable: true,
    applicability: "A missing H1 is not automatically a ranking failure; it is a structure and accessibility signal worth checking.",
    emit: (ctx) => ctx.pages.filter((s) => s.h1s.filter((h) => h.trim()).length === 0).map((s) => page(s, "No non-empty <h1> found in the served HTML.")),
  },
  {
    id: "SEO-H1-MULTIPLE",
    name: "Multiple H1s",
    area: "headings",
    class: "heuristic",
    severity: "minor",
    appliesTo: "all",
    templateable: true,
    applicability: "Multiple H1s are valid HTML and not a ranking penalty; one clear main heading is usually easier for readers.",
    emit: (ctx) => ctx.pages.filter((s) => s.h1s.length > 1).map((s) => page(s, `The page has ${s.h1s.length} <h1> elements.`, { h1s: s.h1s.slice(0, 5) })),
  },
  {
    id: "SEO-HEADING-SKIP",
    name: "Skipped heading level",
    area: "headings",
    class: "heuristic",
    severity: "advisory",
    appliesTo: "all",
    templateable: true,
    applicability: "Skipped heading levels mostly affect accessibility and document outline, not rankings.",
    emit: (ctx) => {
      const out: Emitted[] = [];
      for (const s of ctx.pages) {
        let prev = 0;
        for (const h of s.headings) {
          if (prev > 0 && h.level > prev + 1) {
            out.push(page(s, `Heading level jumps from h${prev} to h${h.level}.`, { from: prev, to: h.level, heading: h.text }));
            break;
          }
          prev = h.level;
        }
      }
      return out;
    },
  },
  {
    id: "SEO-CANONICAL-MISSING",
    name: "Missing canonical",
    area: "canonical",
    class: "fact",
    severity: "minor",
    appliesTo: "all",
    templateable: true,
    applicability: "A canonical is a hint, not a directive; pages without one can still be indexed correctly, but duplicates are harder to consolidate.",
    emit: (ctx) => ctx.pages.filter((s) => !s.canonical).map((s) => page(s, "No rel=canonical link found.")),
  },
  {
    id: "SEO-CANONICAL-OFFHOST",
    name: "Canonical points to another host",
    area: "canonical",
    class: "fact",
    severity: "major",
    appliesTo: "all",
    templateable: true,
    applicability: "Cross-host canonicals are sometimes intentional (syndication, host migration); otherwise they can move indexing to the other host.",
    emit: (ctx) =>
      ctx.pages
        .filter((s) => {
          if (!s.canonical) return false;
          try {
            return normalizeHost(new URL(s.canonical).hostname) !== normalizeHost(ctx.verifiedHost);
          } catch {
            return true;
          }
        })
        .map((s) => page(s, `Canonical points off the verified host: ${s.canonical}`, { canonical: s.canonical })),
  },
  {
    id: "SEO-CANONICAL-TARGET-BAD",
    name: "Canonical target is an error, redirect, or noindex",
    area: "canonical",
    class: "fact",
    severity: "major",
    appliesTo: "all",
    templateable: false,
    applicability: "Only evaluated when the canonical target was itself crawled in this run.",
    emit: (ctx) => {
      const byKey = new Map(ctx.all.map((s) => [normalizeUrlKey(s.url), s]));
      const out: Emitted[] = [];
      for (const s of ctx.pages) {
        if (!canonicalPointsElsewhere(s)) continue;
        const t = byKey.get(normalizeUrlKey(s.canonical!));
        if (!t || t.skippedReason === "robots_disallowed") continue;
        const redirected = !!t.finalUrl && normalizeUrlKey(t.finalUrl) !== normalizeUrlKey(t.url);
        const noindex = /\b(noindex|none)\b/.test(t.robotsMeta ?? "");
        if ((t.statusCode !== null && (t.statusCode < 200 || t.statusCode >= 300)) || redirected || noindex) {
          const why = redirected ? `redirects to ${t.finalUrl}` : noindex ? "is noindex" : `returned ${t.statusCode}`;
          out.push(page(s, `Canonical target ${s.canonical} ${why}.`, { canonical: s.canonical, targetStatus: t.statusCode, targetFinalUrl: t.finalUrl }));
        }
      }
      return out;
    },
  },
  {
    id: "SEO-NOINDEX",
    name: "Declared noindex",
    area: "indexing",
    class: "fact",
    severity: "major",
    appliesTo: "all",
    templateable: true,
    applicability: "Intentional noindex (cart, account, filtered or thin pages) is correct; review only pages you want in search.",
    emit: (ctx) =>
      ctx.pages.filter((s) => /\b(noindex|none)\b/.test(s.robotsMeta ?? "")).map((s) => page(s, `Robots directives declare noindex: "${s.robotsMeta}".`, { robots: s.robotsMeta })),
  },
  {
    id: "SEO-STATUS-4XX",
    name: "Client error status",
    area: "status",
    class: "fact",
    severity: "major",
    appliesTo: "all",
    templateable: false,
    applicability: "Intentionally removed pages may correctly return 404/410; linked or sitemapped ones should be fixed or redirected.",
    emit: (ctx) =>
      ctx.all
        .filter((s) => !s.skippedReason && s.statusCode !== null && s.statusCode >= 400 && s.statusCode < 500)
        .map((s) => page(s, `The URL returned HTTP ${s.statusCode}.`, { status: s.statusCode, inSitemap: ctx.sitemapUrls.some((u) => normalizeUrlKey(u) === normalizeUrlKey(s.url)) })),
  },
  {
    id: "SEO-STATUS-5XX",
    name: "Server error status",
    area: "status",
    class: "fact",
    severity: "critical",
    appliesTo: "all",
    templateable: false,
    applicability: "A single 5xx may be transient; recheck before acting. Persistent 5xx responses block crawling of the page.",
    emit: (ctx) =>
      ctx.all
        .filter((s) => !s.skippedReason && s.statusCode !== null && s.statusCode >= 500)
        .map((s) => page(s, `The URL returned HTTP ${s.statusCode}.`, { status: s.statusCode })),
  },
  {
    id: "SEO-LINK-BROKEN-INTERNAL",
    name: "Broken internal links",
    area: "links",
    class: "fact",
    severity: "moderate",
    appliesTo: "all",
    templateable: false,
    applicability: "Only links to URLs checked in this crawl are evaluated; links to uncrawled URLs are not claimed broken.",
    emit: (ctx) => {
      const byKey = new Map(ctx.all.map((s) => [normalizeUrlKey(s.url), s]));
      const out: Emitted[] = [];
      for (const s of ctx.pages) {
        const broken = s.internalLinks
          .map((l) => byKey.get(normalizeUrlKey(l)))
          .filter((t): t is RuleSnapshot => !!t && !t.skippedReason && t.statusCode !== null && t.statusCode >= 400);
        if (broken.length) {
          out.push(page(s, `${broken.length} internal link(s) point to URLs that returned an error.`, { targets: broken.slice(0, 10).map((t) => ({ url: t.url, status: t.statusCode })) }));
        }
      }
      return out;
    },
  },
  {
    id: "SEO-CONTENT-THIN",
    name: "Thin content",
    area: "content",
    class: "heuristic",
    severity: "minor",
    appliesTo: ["article", "landing", "other"],
    templateable: false,
    applicability: "Word count is a rough proxy; short pages can fully satisfy intent. Product and collection pages use separate checks.",
    emit: (ctx) =>
      ctx.pages.filter((s) => s.wordCount !== null && s.wordCount < 150).map((s) => page(s, `Main content has about ${s.wordCount} words (threshold 150).`, { wordCount: s.wordCount })),
  },
  {
    id: "SEO-CONTENT-DUPLICATE",
    name: "Duplicate content",
    area: "content",
    class: "heuristic",
    severity: "moderate",
    appliesTo: "all",
    templateable: false,
    applicability: "Identical extracted main text across URLs; pages consolidated by canonical are excluded. Near-duplicates are not detected here.",
    emit: (ctx) =>
      emitDuplicates(
        duplicateGroups(ctx.pages.filter((s) => (s.wordCount ?? 0) >= 20), (s) => s.textHash ?? s.contentHash),
        "Main content",
        (s) => s.textHash ?? s.contentHash,
      ),
  },
  {
    id: "SEO-ROBOTS-SITEMAP-CONFLICT",
    name: "Sitemap URL disallowed by robots.txt",
    area: "indexing",
    class: "fact",
    severity: "moderate",
    appliesTo: "all",
    templateable: false,
    applicability: "Evaluated for the Googlebot group (or * when no Googlebot group exists). Sitemap presence is not proof of indexing.",
    emit: (ctx) => {
      if (!ctx.robots || ctx.robots.status !== "ok") return [];
      const robots = ctx.robots;
      return ctx.sitemapUrls
        .filter((u) => !robotsAllows(robots, "Googlebot", u))
        .slice(0, 50)
        .map((u) => ({ url: u, pageType: ctx.all.find((s) => normalizeUrlKey(s.url) === normalizeUrlKey(u))?.pageType ?? null, detail: "Listed in the sitemap but disallowed by robots.txt.", evidence: { evaluatedFor: "Googlebot" } }));
    },
  },
  {
    id: "SEO-JSONLD-INVALID",
    name: "Invalid JSON-LD",
    area: "structured_data",
    class: "fact",
    severity: "minor",
    appliesTo: "all",
    templateable: true,
    applicability: "Unparseable JSON-LD blocks are ignored by consumers; only JSON syntax is checked here.",
    emit: (ctx) => ctx.pages.filter((s) => s.jsonLdIssues.some((i) => i.issue === "invalid_json")).map((s) => page(s, "A JSON-LD block is not valid JSON.")),
  },
  {
    id: "ECOM-PRODUCT-JSONLD-MISSING",
    name: "Product page without Product structured data",
    area: "ecommerce",
    class: "fact",
    severity: "moderate",
    appliesTo: ["product"],
    siteTypes: ["ecommerce"],
    templateable: true,
    applicability: "Product structured data is required for product rich-result eligibility, not a guarantee of it. Only server-delivered HTML is checked.",
    emit: (ctx) =>
      ctx.pages.filter((s) => !s.jsonLdTypes.includes("Product") && !s.jsonLdTypes.includes("ProductGroup")).map((s) => page(s, "No Product JSON-LD found on a product page.", { jsonLdTypes: s.jsonLdTypes })),
  },
  {
    id: "ECOM-PRODUCT-OFFER-INCOMPLETE",
    name: "Product structured data missing offer price",
    area: "ecommerce",
    class: "fact",
    severity: "moderate",
    appliesTo: "all",
    siteTypes: ["ecommerce"],
    templateable: true,
    applicability: "Offers with price and priceCurrency (or AggregateOffer with lowPrice and priceCurrency) are needed for merchant/product rich-result eligibility; eligibility is never guaranteed.",
    emit: (ctx) =>
      ctx.pages
        .filter((s) => (s.jsonLdTypes.includes("Product") || s.jsonLdTypes.includes("ProductGroup")) && s.jsonLdIssues.some((i) => PRODUCT_OFFER_ISSUES.has(i.issue)))
        .map((s) => {
          const issues = s.jsonLdIssues.filter((i) => PRODUCT_OFFER_ISSUES.has(i.issue));
          return page(s, `Product JSON-LD: ${issues.map((i) => i.detail).join(" ")}`, { issues: issues.map((i) => i.issue) });
        }),
  },
  {
    id: "ECOM-COLLECTION-NO-INTRO",
    name: "Collection page without introductory copy",
    area: "ecommerce",
    class: "heuristic",
    severity: "minor",
    appliesTo: ["collection"],
    siteTypes: ["ecommerce"],
    templateable: true,
    applicability: "Approximation: no paragraph of at least 10 words in the main content. Intro copy helps readers and context; it is not a ranking guarantee.",
    emit: (ctx) =>
      ctx.pages
        .filter((s) => !s.firstParagraph || countWords(s.firstParagraph) < 10)
        .map((s) => page(s, "No introductory paragraph found on the collection page.", { firstParagraph: s.firstParagraph, wordCount: s.wordCount })),
  },
  {
    id: "ECOM-FACETED-NO-CANONICAL",
    name: "Faceted URL without canonical to the clean URL",
    area: "ecommerce",
    class: "fact",
    severity: "moderate",
    appliesTo: "all",
    siteTypes: ["ecommerce"],
    templateable: true,
    applicability: "Filter/sort URLs usually should canonicalize to the unfiltered page (or be noindex). Pagination parameters are not treated as facets.",
    emit: (ctx) =>
      ctx.pages
        .filter((s) => {
          const params = facetParams(s.url);
          return params.length > 0 && canonicalHasParams(s.canonical, params) && !/\bnoindex\b/.test(s.robotsMeta ?? "");
        })
        .map((s) => page(s, s.canonical ? `Canonical keeps facet parameters: ${s.canonical}` : "Faceted URL has no canonical.", { params: facetParams(s.url), canonical: s.canonical })),
  },
  {
    id: "ECOM-VARIANT-NO-CANONICAL",
    name: "Variant URL without canonical to the product URL",
    area: "ecommerce",
    class: "fact",
    severity: "moderate",
    appliesTo: "all",
    siteTypes: ["ecommerce"],
    templateable: true,
    applicability: "Variant URLs (?variant=) usually should canonicalize to the main product URL unless variants are intentionally indexed.",
    emit: (ctx) =>
      ctx.pages
        .filter((s) => {
          try {
            return new URL(s.url).searchParams.has("variant") && canonicalHasParams(s.canonical, ["variant"]);
          } catch {
            return false;
          }
        })
        .map((s) => page(s, s.canonical ? `Canonical keeps the variant parameter: ${s.canonical}` : "Variant URL has no canonical.", { canonical: s.canonical })),
  },
  {
    id: "AI-SEARCH-CRAWLER-BLOCKED",
    name: "Search engine or AI answer/search crawler disallowed",
    area: "ai_crawlers",
    class: "fact",
    severity: "advisory",
    appliesTo: "all",
    templateable: false,
    applicability: "Advisory only. Covers search-engine and AI answer/search crawlers; user-initiated fetchers are informational. robots.txt settings are not shown to cause or prevent AI citations. Blocking training crawlers is a business choice and is never flagged.",
    emit: (ctx) =>
      (ctx.aiCrawlerAccess?.crawlers ?? [])
        .filter((c) => FLAGGED_PURPOSES.has(c.purpose) && c.allowed === false)
        .map((c) => ({
          url: null,
          pageType: null,
          detail: `${c.token} (${c.vendor}) is disallowed for the site root by robots.txt.`,
          evidence: { token: c.token, vendor: c.vendor, purpose: c.purpose, sourceUrl: c.sourceUrl },
        })),
  },
];

export const RULES_BY_ID: ReadonlyMap<string, Rule> = new Map(RULES.map((r) => [r.id, r]));

export function getRule(id: string): Rule | undefined {
  return RULES_BY_ID.get(id);
}

/** Run every applicable rule and label template-level groups. */
export function runRules(input: RuleInput): RuleFinding[] {
  const analyzable = input.snapshots.filter(isAnalyzable);
  const findings: RuleFinding[] = [];
  for (const rule of RULES) {
    if (rule.siteTypes && !rule.siteTypes.includes(input.siteType)) continue;
    const pages = rule.appliesTo === "all" ? analyzable : analyzable.filter((s) => (rule.appliesTo as PageType[]).includes(s.pageType));
    const emitted = rule.emit({ ...input, pages, all: input.snapshots });
    const counts = new Map<PageType, number>();
    if (rule.templateable) {
      for (const f of emitted) if (f.url && f.pageType) counts.set(f.pageType, (counts.get(f.pageType) ?? 0) + 1);
    }
    for (const f of emitted) {
      const n = f.pageType ? (counts.get(f.pageType) ?? 0) : 0;
      const template = rule.templateable && f.pageType && n >= TEMPLATE_MIN_URLS ? templateName(f.pageType) : null;
      findings.push({
        ...f,
        ruleId: rule.id,
        severity: rule.severity,
        template,
        evidence: template ? { ...f.evidence, templateAffectedUrls: n } : f.evidence,
      });
    }
  }
  return findings;
}
