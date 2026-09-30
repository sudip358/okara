/**
 * [A21] Checklist -> agent bridge. Evaluates the SEO and GEO readiness checklists (and the per-page
 * checklist for the project's top pages) from the same stored data the checklist pages use, and returns
 * normalized "gap" descriptors the SEO agent and the GEO agent turn into candidates. It never writes and
 * never calls external services (the robots.txt re-read for the advisor is a separate helper below,
 * called by an agent step with ctx.crawlFetch through the SSRF guard).
 *
 * A gap is an item that is
 *   - status not_met | partial, AND
 *   - method measured | heuristic (never manual, not_connected, not_applicable, unknown), AND
 *   - not already produced by a rule-based candidate (COVERED_BY_RULES), AND
 *   - when it is measured from page snapshots: from a crawl extracted with the checklist's extraction
 *     fields ([A21] migration 0002). Snapshots taken before that (images_total NULL on every analyzable
 *     page) still render on the checklist page with its own caveats, but do not feed recommendations
 *     until the next crawl re-extracts them; the agents' runs crawl before they recommend.
 * The reference tier (tacticTier) is never read here: gaps carry no tier, so it cannot reach priority.
 */
import type { ChecklistItem, ChecklistKind, ChecklistSection, CrawlerPurpose, PageType } from "@shared/types";
import type { Env } from "../env";
import type { Db } from "../lib/db";
import type { ProjectRow } from "../platform/access";
import { crawlerUserAgent, isPathAllowed, parseRobots, ROBOTS_MAX_BYTES } from "../seo/crawl/robots";
import { buildRobotsSuggestion, type RobotsSuggestionCore } from "../seo/robots-advisor";
import { AI_CRAWLERS, selectCrawlerGroup } from "../seo/rules/ai-crawlers";
import { normalizeUrlKey } from "../seo/rules/registry";
import { CrawlFetchError, guardedFetch } from "../seo/ssrf";
import { loadChecklistData, type ChecklistData, type DecisionInfo, type Snap } from "./data";
import { candidateUrl, PAGE_ITEMS, type PageContext } from "./items/page";
import { urlIssues } from "./items/seo";
import { schemaCheckFor } from "./items/shared";
import { CHECKLIST_VERSION, evaluateItem, ITEMS_BY_KIND } from "./registry";
import { Signals, THRESHOLDS } from "./signals";
import { BESTOF_PATTERN, COMPARISON_PATTERN, coverage, isQuestionHeading, LOGIN_PATH, pathOf, titleAndPath, tokenSet } from "./text";

export const BRIDGE_VERSION = "checklist-bridge-2026-09-30.1";
export const DEFAULT_TOP_PAGES = 10;
const MAX_EVIDENCE_URLS = 5;

// ------------------------------------------------------------------ coverage by rule-based candidates
/**
 * Checklist items whose signal is already produced by a rule-based candidate: the crawler's rule
 * registry findings (SEO-*, ECOM-*, AI-*) or a deterministic SEO/GEO candidate rule (weak_ctr,
 * striking_distance, declining, internal_link, coverage_gap, duplicate_prefilter, geo_displacement).
 *   mode "item":  the whole item is covered, so it never becomes a checklist candidate.
 *   mode "pages": only affected pages that carry a finding from these rules are covered; the item stays
 *                 a gap for the remaining pages (e.g. schema: product Offer issues are ECOM-* findings,
 *                 but a missing Article or Organization type on other pages is not a rule finding).
 * The search-engine / answer-search robots.txt blocks (AI-SEARCH-CRAWLER-BLOCKED) are covered here and
 * handled by each agent's dedicated robots.txt advisor path instead of a generic checklist candidate.
 */
export const COVERED_BY_RULES: Readonly<Record<string, { rules: readonly string[]; mode: "item" | "pages" }>> = {
  // SEO checklist
  "seo.technical.robots_noindex": { rules: ["SEO-NOINDEX", "SEO-ROBOTS-SITEMAP-CONFLICT", "AI-SEARCH-CRAWLER-BLOCKED"], mode: "item" },
  "seo.technical.canonical_tags": { rules: ["SEO-CANONICAL-MISSING", "SEO-CANONICAL-OFFHOST", "SEO-CANONICAL-TARGET-BAD", "ECOM-FACETED-NO-CANONICAL", "ECOM-VARIANT-NO-CANONICAL"], mode: "item" },
  "seo.technical.broken_links": { rules: ["SEO-LINK-BROKEN-INTERNAL", "SEO-STATUS-4XX", "SEO-STATUS-5XX"], mode: "item" },
  "seo.technical.schema_rich_results": { rules: ["SEO-JSONLD-INVALID", "ECOM-PRODUCT-JSONLD-MISSING", "ECOM-PRODUCT-OFFER-INCOMPLETE"], mode: "pages" },
  "seo.on_page.title_length": { rules: ["SEO-TITLE-MISSING", "SEO-TITLE-DUPLICATE"], mode: "item" },
  "seo.on_page.unique_meta": { rules: ["SEO-META-DESC-MISSING", "SEO-META-DESC-DUPLICATE"], mode: "item" },
  "seo.on_page.heading_structure": { rules: ["SEO-H1-MISSING", "SEO-H1-MULTIPLE", "SEO-HEADING-SKIP"], mode: "item" },
  "seo.on_page.internal_links": { rules: ["internal_link"], mode: "item" },
  "seo.quick_wins.low_ctr": { rules: ["weak_ctr"], mode: "item" },
  "seo.quick_wins.page_two": { rules: ["striking_distance"], mode: "item" },
  "seo.quick_wins.declining_pages": { rules: ["declining"], mode: "item" },
  "seo.content.cannibalization": { rules: ["duplicate_prefilter", "SEO-CONTENT-DUPLICATE"], mode: "item" },
  "seo.content.merge_thin": { rules: ["SEO-CONTENT-THIN", "SEO-CONTENT-DUPLICATE"], mode: "item" },
  // GEO checklist
  "geo.access.ai_search_bots_allowed": { rules: ["AI-SEARCH-CRAWLER-BLOCKED"], mode: "item" },
  "geo.access.noindex_canonical": { rules: ["SEO-NOINDEX", "SEO-CANONICAL-OFFHOST", "SEO-CANONICAL-TARGET-BAD", "SEO-CANONICAL-MISSING", "ECOM-FACETED-NO-CANONICAL", "ECOM-VARIANT-NO-CANONICAL"], mode: "item" },
  "geo.access.no_login_walls": { rules: ["SEO-STATUS-4XX"], mode: "pages" },
  "geo.content.cited_pages_gaps": { rules: ["geo_displacement"], mode: "item" },
  "geo.structure.internal_links": { rules: ["internal_link"], mode: "item" },
  "geo.structure.schema_markup": { rules: ["SEO-JSONLD-INVALID", "ECOM-PRODUCT-JSONLD-MISSING", "ECOM-PRODUCT-OFFER-INCOMPLETE"], mode: "pages" },
  "geo.trust.public_pricing": { rules: ["ECOM-PRODUCT-JSONLD-MISSING", "ECOM-PRODUCT-OFFER-INCOMPLETE"], mode: "pages" },
  // Per-page checklist
  "page.before_write.topic_coverage": { rules: ["coverage_gap"], mode: "item" },
  "page.while_write.terms_entities": { rules: ["coverage_gap"], mode: "item" },
  "page.while_write.headings": { rules: ["SEO-H1-MISSING", "SEO-H1-MULTIPLE", "SEO-HEADING-SKIP"], mode: "item" },
  "page.details.title": { rules: ["SEO-TITLE-MISSING", "SEO-TITLE-DUPLICATE"], mode: "item" },
  "page.details.meta_description": { rules: ["SEO-META-DESC-MISSING", "SEO-META-DESC-DUPLICATE", "weak_ctr"], mode: "item" },
  "page.publish_check.internal_links": { rules: ["internal_link"], mode: "item" },
  "page.publish_check.indexability": { rules: ["SEO-NOINDEX", "SEO-CANONICAL-OFFHOST", "SEO-CANONICAL-TARGET-BAD", "SEO-STATUS-4XX", "SEO-STATUS-5XX"], mode: "item" },
};

/**
 * Per-page items that measure the same thing as a project-level item across every crawled page; the
 * project-level gap already lists the page, so agents use the project-level item instead.
 */
export const PAGE_ITEM_EQUIVALENT: Readonly<Record<string, string>> = {
  "page.while_write.answer_early": "seo.on_page.answer_first_lines",
  "page.while_write.crawlable_text": "seo.technical.js_crawlable",
  "page.details.url": "seo.technical.clean_urls",
  "page.details.alt_text": "seo.on_page.image_alt",
  "page.publish_check.sources": "geo.trust.reputable_sources",
  "page.publish_check.structured_data_ux": "seo.technical.schema_rich_results",
};

/** Items measured from sources other than page snapshots (not subject to the extraction gate). */
const NOT_SNAPSHOT_DERIVED = new Set<string>([
  "seo.technical.gsc_ga4",
  "seo.technical.sitemap_submitted",
  "seo.technical.indexing_issues",
  "seo.technical.core_web_vitals",
  "seo.on_page.search_intent",
  "seo.content.cannibalization",
  "geo.access.ai_search_bots_allowed",
  "geo.access.sitemap_indexnow",
  "geo.content.use_case_pages",
  "geo.content.cited_pages_gaps",
]);
const NOT_SNAPSHOT_SECTIONS = new Set<ChecklistSection>(["quick_wins", "links", "mentions", "tracking"]);

function snapshotDerived(kind: ChecklistKind, itemId: string, section: ChecklistSection): boolean {
  if (kind === "page") return true;
  if (NOT_SNAPSHOT_DERIVED.has(itemId) || NOT_SNAPSHOT_SECTIONS.has(section)) return false;
  return true;
}

/** Where the item's measurement comes from (used for the evidence source: 'crawl' vs 'rule'). */
export type GapSource = "crawl" | "robots" | "gsc" | "geo" | "decisions";

const ROBOTS_RECORD_ITEMS = new Set(["seo.technical.sitemap_submitted", "geo.access.sitemap_indexnow", "geo.access.ai_search_bots_allowed"]);
const GEO_DATA_ITEMS = new Set(["geo.content.use_case_pages", "geo.content.cited_pages_gaps"]);

function sourceOf(kind: ChecklistKind, itemId: string, section: ChecklistSection): GapSource {
  if (ROBOTS_RECORD_ITEMS.has(itemId)) return "robots";
  if (section === "quick_wins" || itemId === "seo.technical.gsc_ga4") return "gsc";
  if (section === "mentions" || section === "tracking" || section === "links" || GEO_DATA_ITEMS.has(itemId)) return "geo";
  if (itemId === "seo.on_page.search_intent" || itemId === "page.before_write.search_intent") return "decisions";
  return snapshotDerived(kind, itemId, section) ? "crawl" : "gsc";
}

// ------------------------------------------------------------------ gap descriptors
export interface AffectedPage {
  url: string;
  pageId: string;
  pageType: PageType;
  /** Short observable detail for this page (evidence text), e.g. "no BreadcrumbList JSON-LD or breadcrumb markup". */
  detail: string;
}

export interface ChecklistGap {
  kind: ChecklistKind;
  itemId: string;
  label: string;
  section: ChecklistSection;
  status: "not_met" | "partial";
  method: "measured" | "heuristic";
  summary: string;
  /** Up to five affected URLs (or, for mention lists, cited third-party URLs). */
  evidence: string[];
  /** Affected crawled pages after rule coverage; null when the item has no page population (site-level). */
  affectedCount: number | null;
  /** Page checklist gaps: the page they belong to. */
  pageId?: string;
  checklistVersion: string;
  // ---- additive fields used by the agents
  pageUrl?: string;
  /** Full affected set when the item has a page population (after rule coverage). */
  affected: AffectedPage[] | null;
  source: GapSource;
  /** Page items that duplicate a project-level item (agents prefer the project-level gap). */
  equivalentTo?: string;
  /** The evaluated item's evidence rows (labels/details), for evidence text. */
  itemEvidence: ChecklistItem["evidence"];
  caveat: string | null;
}

export interface ExcludedItem {
  kind: ChecklistKind;
  itemId: string;
  reason: "covered_by_rules" | "stale_extraction" | "no_confirmed_pages";
  pageId?: string;
}

export interface CrawlerAccessSummary {
  crawlRunId: string | null;
  crawledAt: string | null;
  /** Search-engine and AI answer/search crawlers disallowed at the site root (crawl record and/or AI-SEARCH-CRAWLER-BLOCKED findings). */
  blocked: Array<{ token: string; vendor: string; purpose: CrawlerPurpose; sourceUrl: string | null; from: "crawl_robots" | "finding" }>;
  trainingBlocked: string[];
  trainingAllowed: string[];
  robotsStatus: string | null;
}

export interface ChecklistSignalsResult {
  bridgeVersion: string;
  checklistVersion: string;
  gaps: ChecklistGap[];
  excluded: ExcludedItem[];
  /** "current": crawl snapshots carry the [A21] extraction; "legacy": older snapshots (snapshot items gated); "none": no crawl. */
  extraction: "current" | "legacy" | "none";
  crawlerAccess: CrawlerAccessSummary | null;
  /** Every evaluated item per kind (including non-gaps), for agents that need an item's status as evidence. */
  items: { seo: ChecklistItem[]; geo: ChecklistItem[]; pages: Array<{ pageId: string; url: string; items: ChecklistItem[] }> };
  /** Pages whose per-page checklist was evaluated (by current-window GSC impressions, else by inlinks). */
  topPages: string[];
  data: ChecklistData;
  signals: Signals;
}

export interface ChecklistSignalsOptions {
  kinds: ReadonlyArray<ChecklistKind>;
  /** Per-page checklists for up to this many top pages (0 = none). Default 10. */
  topPages?: number;
}

const GAP_STATUSES = new Set(["not_met", "partial"]);
const GAP_METHODS = new Set(["measured", "heuristic"]);

/** Evaluate the requested checklists and return gap descriptors (no writes, no external calls). */
export async function checklistSignals(env: Env, db: Db, project: ProjectRow, now: Date, opts: ChecklistSignalsOptions): Promise<ChecklistSignalsResult> {
  const data = await loadChecklistData(env, db, project, now);
  return checklistSignalsFromData(data, opts);
}

/** Pure part of checklistSignals (exported for tests). */
export function checklistSignalsFromData(data: ChecklistData, opts: ChecklistSignalsOptions): ChecklistSignalsResult {
  const sig = new Signals(data);
  const analyzable = sig.analyzable();
  const extraction: ChecklistSignalsResult["extraction"] = !data.crawl
    ? "none"
    : analyzable.length > 0 && analyzable.every((s) => s.imagesTotal !== null)
      ? "current"
      : "legacy";
  const gaps: ChecklistGap[] = [];
  const excluded: ExcludedItem[] = [];
  const items: ChecklistSignalsResult["items"] = { seo: [], geo: [], pages: [] };

  const consider = (kind: ChecklistKind, item: ChecklistItem, page?: { id: string; url: string; pageType: PageType }) => {
    if (!GAP_STATUSES.has(item.status) || !GAP_METHODS.has(item.method)) return;
    const base = { kind, itemId: item.id, ...(page ? { pageId: page.id } : {}) };
    const cover = COVERED_BY_RULES[item.id];
    if (cover?.mode === "item") {
      excluded.push({ ...base, reason: "covered_by_rules" });
      return;
    }
    if (snapshotDerived(kind, item.id, item.section) && extraction !== "current") {
      excluded.push({ ...base, reason: "stale_extraction" });
      return;
    }
    let affected: AffectedPage[] | null;
    if (page) {
      affected = [{ url: page.url, pageId: page.id, pageType: page.pageType, detail: item.summary }];
    } else {
      const found = AFFECTED[item.id]?.(sig) ?? null;
      affected = found ? found.map((a) => ({ url: a.snap.url, pageId: a.snap.pageId, pageType: a.snap.pageType, detail: a.detail })) : null;
    }
    if (affected && cover?.mode === "pages") {
      const coveredUrls = new Set(sig.findingUrls(cover.rules).map(normalizeUrlKey));
      const before = affected.length;
      affected = affected.filter((a) => !coveredUrls.has(normalizeUrlKey(a.url)));
      if (affected.length === 0 && before > 0) {
        excluded.push({ ...base, reason: "covered_by_rules" });
        return;
      }
    }
    if (affected && affected.length === 0) {
      excluded.push({ ...base, reason: "no_confirmed_pages" });
      return;
    }
    const itemUrls = item.evidence.map((e) => e.url).filter((u): u is string => !!u);
    gaps.push({
      kind,
      itemId: item.id,
      label: item.label,
      section: item.section,
      status: item.status as ChecklistGap["status"],
      method: item.method as ChecklistGap["method"],
      summary: item.summary,
      evidence: (affected ? affected.map((a) => a.url) : itemUrls).slice(0, MAX_EVIDENCE_URLS),
      affectedCount: affected ? affected.length : null,
      ...(page ? { pageId: page.id, pageUrl: page.url } : {}),
      checklistVersion: CHECKLIST_VERSION,
      affected,
      source: sourceOf(kind, item.id, item.section),
      ...(PAGE_ITEM_EQUIVALENT[item.id] ? { equivalentTo: PAGE_ITEM_EQUIVALENT[item.id] } : {}),
      itemEvidence: item.evidence,
      caveat: item.caveat,
    });
  };

  for (const kind of ["seo", "geo"] as const) {
    if (!opts.kinds.includes(kind)) continue;
    for (const def of ITEMS_BY_KIND[kind]) {
      const item = evaluateItem(def, sig, undefined, kind);
      items[kind].push(item);
      consider(kind, item);
    }
  }

  const topPages: string[] = [];
  const n = opts.kinds.includes("page") ? (opts.topPages ?? DEFAULT_TOP_PAGES) : 0;
  if (n > 0 && data.crawl) {
    for (const snap of rankTopPages(sig, n)) {
      topPages.push(snap.url);
      const ctx: PageContext = {
        sig,
        page: { id: snap.pageId, url: snap.url, pageType: snap.pageType },
        snap,
        queries: sig.queriesForPage(snap.url),
        intent: latestIntent(data.decisions, snap.url),
      };
      const pageItems = PAGE_ITEMS.map((def) => evaluateItem(def, ctx, undefined, "page"));
      items.pages.push({ pageId: snap.pageId, url: snap.url, items: pageItems });
      for (const item of pageItems) consider("page", item, ctx.page);
    }
  }

  return {
    bridgeVersion: BRIDGE_VERSION,
    checklistVersion: CHECKLIST_VERSION,
    gaps,
    excluded,
    extraction,
    crawlerAccess: crawlerAccessSummary(data),
    items,
    topPages,
    data,
    signals: sig,
  };
}

/** Top pages: current-window GSC impressions (desc), else internal inlinks from crawled pages (desc). */
function rankTopPages(sig: Signals, n: number): Snap[] {
  const analyzable = sig.analyzable();
  const byKey = new Map(analyzable.map((s) => [normalizeUrlKey(s.url), s]));
  const out: Snap[] = [];
  if (sig.hasGsc) {
    const ranked = [...sig.pageMetricsCurrent().entries()].sort((a, b) => b[1].impressions - a[1].impressions || a[1].url.localeCompare(b[1].url));
    for (const [k] of ranked) {
      const s = byKey.get(k);
      if (s && !out.includes(s)) out.push(s);
      if (out.length >= n) return out;
    }
    if (out.length > 0) return out;
  }
  return [...analyzable].sort((a, b) => sig.inlinkCount(b.url) - sig.inlinkCount(a.url) || a.url.localeCompare(b.url)).slice(0, n);
}

function latestIntent(decisions: DecisionInfo[], url: string): DecisionInfo | null {
  const key = normalizeUrlKey(url);
  return (
    decisions.find((d) => {
      if (d.questionId !== "seo.intent_page_fit") return false;
      const u = candidateUrl(d.candidate);
      return !!u && normalizeUrlKey(u) === key;
    }) ?? null
  );
}

// ------------------------------------------------------------------ affected populations
/**
 * Full affected page sets for items with a page population (the item's own evidence is capped at five
 * URLs). Each mirrors the item's evaluator; breadcrumbs count only pages where the absence was confirmed
 * (no BreadcrumbList JSON-LD AND breadcrumb navigation markup extracted as absent).
 */
type Affected = Array<{ snap: Snap; detail: string }>;
const OFFER_ISSUES = new Set(["missing_offers", "offer_missing_price", "offer_missing_currency", "aggregate_offer_missing_low_price"]);
const PRICING_PATH = /\/(?:pricing|prices|plans|price-list|rates)(?:\/|$)/i;

const nonHome = (sig: Signals) => sig.analyzable().filter((s) => s.pageType !== "home");
const withDetail = (snaps: Snap[], detail: (s: Snap) => string): Affected => snaps.map((snap) => ({ snap, detail: detail(snap) }));

function schemaAffected(sig: Signals): Affected {
  return sig
    .analyzable()
    .map((s) => schemaCheckFor(s, sig.d.project.siteType))
    .filter((c): c is NonNullable<typeof c> => c !== null && !c.ok)
    .map((c) => ({ snap: c.snap, detail: `${c.snap.pageType}: ${c.problem} (expected ${c.expected})` }));
}

function jsAffected(sig: Signals): Affected {
  return withDetail(
    sig.d.snapshots.filter((s) => s.skippedReason === "js_rendered"),
    (s) => `${s.wordCount ?? 0} words in the served HTML with a JavaScript app root (skipped as js_rendered)`,
  );
}

function articleAttr(attr: "author" | "updated" | "citations") {
  return (sig: Signals): Affected => {
    const has = (s: Snap) => (attr === "author" ? !!s.author?.trim() : attr === "updated" ? !!s.lastUpdated?.trim() : (s.outboundCitations ?? 0) >= 1);
    const what = attr === "author" ? "no declared author" : attr === "updated" ? "no declared modified date" : "no outbound links in the main content";
    return withDetail(
      sig.analyzable().filter((s) => s.pageType === "article" && !has(s)),
      () => what,
    );
  };
}

/** null = the item has no page population (site-level). */
const AFFECTED: Readonly<Record<string, (sig: Signals) => Affected | null>> = {
  "seo.technical.breadcrumbs": (sig) =>
    withDetail(
      nonHome(sig).filter((s) => !s.jsonLdTypes.includes("BreadcrumbList") && s.breadcrumbNav === false),
      () => "no BreadcrumbList JSON-LD and no breadcrumb navigation markup",
    ),
  "seo.technical.orphan_pages": (sig) => withDetail(nonHome(sig).filter((s) => sig.inlinkCount(s.url) === 0), () => "no internal links from other crawled pages"),
  "seo.technical.schema_rich_results": schemaAffected,
  "geo.structure.schema_markup": schemaAffected,
  "seo.technical.mobile_friendly": (sig) =>
    withDetail(
      sig.analyzable().filter((s) => s.imagesTotal !== null && !/width\s*=\s*device-width/i.test(s.viewport ?? "")),
      (s) => (s.viewport ? `viewport: ${s.viewport.slice(0, 80)}` : "no viewport meta tag"),
    ),
  "seo.technical.clean_urls": (sig) =>
    sig
      .analyzable()
      .map((snap) => ({ snap, issues: urlIssues(snap.url) }))
      .filter((x) => x.issues.length > 0)
      .map((x) => ({ snap: x.snap, detail: x.issues.join(", ") })),
  "seo.technical.js_crawlable": jsAffected,
  "geo.access.key_text_in_html": jsAffected,
  "seo.on_page.image_alt": (sig) =>
    withDetail(
      sig.analyzable().filter((s) => (s.imagesMissingAlt ?? 0) > 0),
      (s) => `${s.imagesMissingAlt} of ${s.imagesTotal} images without alt`,
    ),
  "seo.on_page.answer_first_lines": (sig) => {
    if (!sig.hasGsc) return [];
    const top = sig.topQueryByPage();
    const out: Affected = [];
    for (const s of sig.analyzable()) {
      if (s.pageType === "home") continue;
      const q = top.get(normalizeUrlKey(s.url));
      if (!q?.query) continue;
      const cov = coverage(q.query, tokenSet(s.firstParagraph));
      if (cov !== null && cov < THRESHOLDS.answerCoverage) out.push({ snap: s, detail: `top query "${q.query}": ${Math.round(cov * 100)}% of its words in the first paragraph` });
    }
    return out;
  },
  "seo.content.author_eeat": articleAttr("author"),
  "geo.trust.author_bio": articleAttr("author"),
  "seo.content.date_modified": articleAttr("updated"),
  "geo.trust.last_updated": articleAttr("updated"),
  "geo.trust.reputable_sources": articleAttr("citations"),
  "geo.structure.question_headings": (sig) => {
    const content = sig.analyzable().filter((s) => s.pageType === "article" || s.pageType === "landing" || s.pageType === "other");
    const pages = content.length ? content : sig.analyzable();
    return withDetail(
      pages.filter((s) => !s.headings.some((h) => (h.level === 2 || h.level === 3) && isQuestionHeading(h.text))),
      () => "no question-style H2/H3",
    );
  },
  "geo.structure.comparison_tables": (sig) =>
    withDetail(
      sig.analyzable().filter((s) => (COMPARISON_PATTERN.test(titleAndPath(s.title, s.url)) || BESTOF_PATTERN.test(titleAndPath(s.title, s.url))) && (s.tableCount ?? 0) === 0),
      () => "comparison or 'best of' page without an HTML table",
    ),
  "geo.access.no_login_walls": (sig) =>
    withDetail(
      sig.d.snapshots.filter((s) => {
        if (LOGIN_PATH.test(pathOf(s.url))) return false;
        if (s.statusCode === 401 || s.statusCode === 403) return true;
        const redirected = !!s.finalUrl && normalizeUrlKey(s.finalUrl) !== normalizeUrlKey(s.url);
        return redirected && LOGIN_PATH.test(pathOf(s.finalUrl!));
      }),
      (s) => (s.statusCode === 401 || s.statusCode === 403 ? `HTTP ${s.statusCode}` : `redirects to ${s.finalUrl}`),
    ),
  "geo.trust.public_pricing": (sig) => {
    const products = sig.analyzable().filter((s) => s.pageType === "product");
    const pricingPages = sig.analyzable().filter((s) => PRICING_PATH.test(pathOf(s.url)));
    // Mirrors publicPricing(): the products path, else a site-level pricing-page check (no page population).
    if (!(sig.d.project.siteType === "ecommerce" || (products.length > 0 && pricingPages.length === 0))) return null;
    return withDetail(
      products.filter((s) => !((s.jsonLdTypes.includes("Product") || s.jsonLdTypes.includes("ProductGroup")) && !s.jsonLdIssues.some((i) => OFFER_ISSUES.has(i.issue)))),
      () => "no Offer price in Product structured data",
    );
  },
};

// ------------------------------------------------------------------ crawler access (robots.txt)
const TOKEN_DEFS = new Map(AI_CRAWLERS.map((c) => [c.token.toLowerCase(), c]));

export function crawlerAccessSummary(data: ChecklistData): CrawlerAccessSummary | null {
  if (!data.crawl) return null;
  const access = data.crawl.robots.access;
  const blocked = new Map<string, CrawlerAccessSummary["blocked"][number]>();
  for (const c of access?.crawlers ?? []) {
    if ((c.purpose === "search_engine" || c.purpose === "answer_search") && c.allowed === false) {
      blocked.set(c.token.toLowerCase(), { token: c.token, vendor: c.vendor, purpose: c.purpose, sourceUrl: c.sourceUrl ?? null, from: "crawl_robots" });
    }
  }
  for (const f of data.findings) {
    if (f.ruleId !== "AI-SEARCH-CRAWLER-BLOCKED") continue;
    const def = AI_CRAWLERS.find((d) => f.detail.startsWith(`${d.token} (`));
    if (!def || (def.purpose !== "search_engine" && def.purpose !== "answer_search")) continue;
    if (!blocked.has(def.token.toLowerCase())) blocked.set(def.token.toLowerCase(), { token: def.token, vendor: def.vendor, purpose: def.purpose, sourceUrl: def.sourceUrl, from: "finding" });
  }
  const training = (access?.crawlers ?? []).filter((c) => c.purpose === "training" || TOKEN_DEFS.get(c.token.toLowerCase())?.purpose === "training");
  return {
    crawlRunId: data.crawl.id,
    crawledAt: data.crawl.finishedAt ?? data.crawl.startedAt,
    blocked: [...blocked.values()],
    trainingBlocked: training.filter((c) => c.allowed === false).map((c) => c.token),
    trainingAllowed: training.filter((c) => c.allowed === true).map((c) => c.token),
    robotsStatus: data.crawl.robots.status,
  };
}

// ------------------------------------------------------------------ robots.txt re-read for the advisor [A19]/[A20]
export const ROBOTS_ADVICE_TIMEOUT_MS = 10_000;

export interface RobotsAdvice {
  /** ready: robots.txt read (2xx); not_found: 4xx, crawlers treat as allow-all; error: not readable; skipped: no verified host. */
  state: "ready" | "not_found" | "error" | "skipped";
  url: string | null;
  fetchedAt: string;
  suggestion: RobotsSuggestionCore | null;
  error: string | null;
  /** Current effective state of every documented crawler token at the site root in the re-read file. */
  current: Array<{ token: string; purpose: CrawlerPurpose; allowed: boolean }>;
  /** Training crawlers are left exactly as they are (the current policy is preserved). */
  training: { allowTraining: boolean; blocked: string[]; allowed: string[] };
}

/**
 * Re-read https://<verified host>/robots.txt through the SSRF guard (512 KB cap, same-host redirects,
 * crawler UA) and build the advisor suggestion. Training crawlers are excluded from the advisor's plan,
 * so their current rules (blocked or allowed) are kept byte-for-byte; `allowTraining` reports the
 * current effective policy. The suggestion is for review; Okara never edits robots.txt.
 */
export async function robotsAdvice(fetchImpl: typeof fetch, opts: { host: string | null; siteType: string; appOrigin: string; now: Date }): Promise<RobotsAdvice> {
  const fetchedAt = opts.now.toISOString();
  const empty = (state: RobotsAdvice["state"], error: string | null, url: string | null = null): RobotsAdvice => ({
    state,
    url,
    fetchedAt,
    suggestion: null,
    error,
    current: [],
    training: { allowTraining: true, blocked: [], allowed: [] },
  });
  if (!opts.host) return empty("skipped", "No verified host: robots.txt was not read.");
  const url = `https://${opts.host}/robots.txt`;
  let text: string | null;
  let state: RobotsAdvice["state"] = "ready";
  try {
    const res = await guardedFetch(fetchImpl, url, {
      verifiedHost: opts.host,
      maxBytes: ROBOTS_MAX_BYTES,
      timeoutMs: ROBOTS_ADVICE_TIMEOUT_MS,
      maxRedirects: 5,
      kind: "robots",
      lenientContentType: true,
      truncateAtCap: true,
      userAgent: crawlerUserAgent(opts.appOrigin),
    });
    if (res.status >= 200 && res.status < 300) {
      if (res.truncated) return empty("error", `robots.txt is larger than ${ROBOTS_MAX_BYTES / 1024} KB, so no suggestion was built from a partial read.`, url);
      text = res.body;
    } else if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      text = null;
      state = "not_found";
    } else {
      return empty("error", `robots.txt returned HTTP ${res.status}.`, url);
    }
  } catch (e) {
    const code = e instanceof CrawlFetchError ? e.code : "error";
    return empty("error", `robots.txt could not be read (${code}).`, url);
  }
  const parsed = text === null ? null : parseRobots(text);
  const current = AI_CRAWLERS.map((def) => ({
    token: def.token,
    purpose: def.purpose,
    allowed: parsed === null ? true : isPathAllowed(selectCrawlerGroup(parsed, def), "/"),
  }));
  const trainingRows = current.filter((c) => c.purpose === "training");
  const blocked = trainingRows.filter((c) => !c.allowed).map((c) => c.token);
  const training = { allowTraining: blocked.length === 0, blocked, allowed: trainingRows.filter((c) => c.allowed).map((c) => c.token) };
  const suggestion = buildRobotsSuggestion(text, {
    allowTraining: training.allowTraining,
    siteType: opts.siteType,
    host: opts.host,
    crawlers: AI_CRAWLERS.filter((c) => c.purpose !== "training"),
  });
  return { state, url, fetchedAt, suggestion, error: null, current, training };
}

/** Load the project row for an agent step (workspace-scoped). */
export async function loadProjectRow(db: Db, project: { id: string; workspaceId: string }): Promise<ProjectRow | null> {
  return db.first<ProjectRow>("SELECT * FROM projects WHERE id = ? AND workspace_id = ?", project.id, project.workspaceId);
}
