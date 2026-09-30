/**
 * Evaluators shared by the SEO and GEO checklists (and some per-page items). Each returns an ItemResult
 * computed only from stored crawl/GSC/GEO data. Wording never promises rankings, inclusion, or citations.
 */
import type { PageType } from "@shared/types";
import { normalizeUrlKey } from "../../seo/rules/registry";
import type { Snap } from "../data";
import { MENTION_SOURCES, type MentionSourceKey, type Signals, THRESHOLDS } from "../signals";
import { LOGIN_PATH, parseDate, pathOf, plural } from "../text";
import { LINK, type Evidence, type ItemResult, noCrawl, ratioStatus, urlEvidence } from "./common";

// ------------------------------------------------------------------ AI crawler access [A19]
const PURPOSE_LABEL: Record<string, string> = {
  search_engine: "search engine",
  answer_search: "AI answer/search",
  user_fetch: "user-initiated fetcher",
  training: "training",
};

export function aiCrawlerAccess(ctx: Signals): ItemResult {
  const guidance =
    "Allow the answer/search crawlers of the AI services you want to be eligible to appear in, and keep Googlebot and Bingbot allowed (their indexes also feed Google and Microsoft AI features). Use the robots.txt advisor, which keeps your existing '*' rules in every named group.";
  if (!ctx.hasCrawl) return { ...noCrawl(ctx, guidance), links: [LINK.robots, LINK.seo] };
  const access = ctx.d.crawl!.robots.access;
  if (!access) {
    return { status: "unknown", method: "measured", summary: "AI crawler access was not recorded for the latest crawl.", guidance, links: [LINK.robots, LINK.seo], completeness: ctx.crawlCompleteness() };
  }
  const relevant = access.crawlers.filter((c) => c.purpose === "answer_search" || c.purpose === "search_engine");
  const training = access.crawlers.filter((c) => c.purpose === "training");
  const userFetch = access.crawlers.filter((c) => c.purpose === "user_fetch");
  const allowed = relevant.filter((c) => c.allowed === true);
  const blocked = relevant.filter((c) => c.allowed === false);
  const unknown = relevant.filter((c) => c.allowed === null);
  const status =
    relevant.length === 0 || unknown.length === relevant.length ? "unknown" : blocked.length === 0 && unknown.length === 0 ? "met" : blocked.length >= relevant.length ? "not_met" : "partial";
  const names = (xs: typeof relevant) => xs.map((c) => c.token).join(", ");
  const parts = [`${allowed.length} of ${relevant.length} search-engine and AI answer/search crawlers allowed at the site root`];
  if (blocked.length) parts.push(`blocked: ${names(blocked)}`);
  if (unknown.length) parts.push(`not evaluable (robots.txt unreachable): ${names(unknown)}`);
  const trainingBlocked = training.filter((c) => c.allowed === false);
  if (trainingBlocked.length) parts.push(`training crawlers blocked: ${names(trainingBlocked)} (a business choice, not a failure)`);
  if (userFetch.length) parts.push(`user-initiated fetchers (informational): ${userFetch.map((c) => `${c.token} ${c.allowed === true ? "allowed" : c.allowed === false ? "blocked" : "unknown"}`).join(", ")}`);
  const state = (a: boolean | null) => (a === true ? "allowed" : a === false ? "blocked" : "unknown");
  const ordered = [...blocked, ...unknown, ...allowed, ...userFetch, ...training];
  const evidence: Evidence[] = ordered.slice(0, 5).map((c) => ({ label: `${c.token} (${c.vendor})`, url: c.sourceUrl, detail: `${PURPOSE_LABEL[c.purpose] ?? c.purpose}: ${state(c.allowed)}` }));
  return {
    status,
    method: "measured",
    summary: `${parts.join("; ")}.`,
    evidence,
    completeness: { note: `${access.crawlers.length} vendor-documented crawler tokens evaluated against robots.txt for the site root.`, covered: access.crawlers.length, total: access.crawlers.length },
    guidance,
    caveat:
      "robots.txt settings are not shown to cause or prevent AI citations. Blocking training crawlers is a business choice and never counts as a failure. CDN or WAF bot blocking (for example Cloudflare AI bot settings) overrides robots.txt; see the CDN item.",
    links: [LINK.robots, LINK.seo],
  };
}

// ------------------------------------------------------------------ robots + noindex (SEO)
export function robotsAndNoindex(ctx: Signals): ItemResult {
  const guidance = "Remove noindex from pages you want in search, keep it on cart/account/filter pages, and make sure robots.txt does not disallow URLs listed in your sitemap.";
  if (!ctx.hasCrawl) return noCrawl(ctx, guidance);
  const noindex = ctx.findingUrls(["SEO-NOINDEX"]);
  const conflicts = ctx.findingUrls(["SEO-ROBOTS-SITEMAP-CONFLICT"]);
  const robotsStatus = ctx.d.crawl!.robots.status;
  const seBlocked = (ctx.d.crawl!.robots.access?.crawlers ?? []).filter((c) => c.purpose === "search_engine" && c.allowed === false);
  const disallowedSkips = ctx.skipped().robots_disallowed ?? 0;
  const bad = noindex.length + conflicts.length + seBlocked.length;
  const status = bad > 0 || robotsStatus === "unreachable" ? "not_met" : "met";
  const parts = [
    `${plural(noindex.length, "crawled page")} declare noindex`,
    `${plural(conflicts.length, "sitemap URL")} disallowed by robots.txt`,
    `robots.txt: ${robotsStatus ?? "status not recorded"}`,
  ];
  if (disallowedSkips) parts.push(`${plural(disallowedSkips, "URL")} skipped because robots.txt disallows this crawler`);
  if (seBlocked.length) parts.push(`search engine crawlers blocked: ${seBlocked.map((c) => c.token).join(", ")}`);
  return {
    status,
    method: "measured",
    summary: `${parts.join("; ")}.`,
    evidence: [...urlEvidence(noindex, "noindex"), ...urlEvidence(conflicts, "Disallowed sitemap URL")].slice(0, 5),
    completeness: ctx.crawlCompleteness(),
    guidance,
    caveat: "Intentional noindex (cart, account, filtered or thin pages) is correct. An unreachable robots.txt (5xx) makes crawlers treat the whole site as disallowed.",
    links: [LINK.seo, LINK.robots],
  };
}

// ------------------------------------------------------------------ sitemap
export function sitemap(ctx: Signals, variant: "seo" | "geo"): ItemResult {
  const guidance =
    variant === "geo"
      ? "Keep an XML sitemap of the pages you want found, reference it with a Sitemap: line in robots.txt, and optionally notify IndexNow when pages change."
      : "Reference the sitemap in robots.txt and submit it in Google Search Console and Bing Webmaster Tools.";
  const caveat =
    variant === "geo"
      ? "IndexNow is used by Bing and other participating engines, not Google. IndexNow pings are not tracked here. Sitemap presence is not proof of indexing."
      : "Submission status in Search Console and Bing Webmaster Tools is not imported; confirm it in each tool. Sitemap presence is not proof of indexing.";
  if (!ctx.hasCrawl) return noCrawl(ctx, guidance);
  const r = ctx.d.crawl!.robots;
  if (!r.recorded) {
    return { status: "unknown", method: "measured", summary: "robots.txt and sitemap details were not recorded for the latest crawl.", guidance, caveat, completeness: ctx.crawlCompleteness(), links: [LINK.seo] };
  }
  const urls = r.sitemapUrlCount ?? 0;
  const found = r.sitemapsFetched.length > 0 && urls > 0;
  const advertised = r.sitemapsAdvertised.length > 0;
  const status = found && advertised ? "met" : found || advertised ? "partial" : "not_met";
  const gscNote = variant === "seo" ? (ctx.d.gsc.connection === "connected" ? " Search Console is connected." : " Search Console is not connected.") : "";
  const summary = found
    ? `${plural(r.sitemapsFetched.length, "sitemap file")} read with ${plural(urls, "URL")}; ${advertised ? `advertised in robots.txt (${plural(r.sitemapsAdvertised.length, "Sitemap line")})` : "not advertised in robots.txt (found at the default /sitemap.xml)"}.${gscNote}`
    : advertised
      ? `robots.txt advertises ${plural(r.sitemapsAdvertised.length, "sitemap")}, but no URLs could be read from it.${gscNote}`
      : `No sitemap was found (none advertised in robots.txt and /sitemap.xml returned no URLs).${gscNote}`;
  return {
    status,
    method: "measured",
    summary,
    evidence: urlEvidence([...new Set([...r.sitemapsFetched, ...r.sitemapsAdvertised])], "Sitemap"),
    completeness: { note: "Sitemaps read with bounded parsing (max 3 child sitemaps, 500 URLs).", covered: urls, total: null },
    guidance,
    caveat,
    links: variant === "seo" ? [LINK.seo, LINK.integrations] : [LINK.seo],
  };
}

// ------------------------------------------------------------------ canonical / noindex
const SEVERE_INDEXING = ["SEO-NOINDEX", "SEO-CANONICAL-OFFHOST", "SEO-CANONICAL-TARGET-BAD"] as const;
const MILD_CANONICAL = ["SEO-CANONICAL-MISSING", "ECOM-FACETED-NO-CANONICAL", "ECOM-VARIANT-NO-CANONICAL"] as const;

export function noindexCanonical(ctx: Signals): ItemResult {
  const guidance = "Remove unintended noindex directives and point canonicals at the indexable, self-hosted version of each page.";
  if (!ctx.hasCrawl) return noCrawl(ctx, guidance);
  const severe = ctx.findings(SEVERE_INDEXING);
  const mild = ctx.findings(MILD_CANONICAL);
  const count = (id: string) => ctx.findingUrls([id]).length;
  const status = severe.length ? "not_met" : mild.length ? "partial" : "met";
  return {
    status,
    method: "measured",
    summary: `${count("SEO-NOINDEX")} noindex, ${count("SEO-CANONICAL-OFFHOST")} off-host canonical, ${count("SEO-CANONICAL-TARGET-BAD")} canonical to an error/redirect/noindex target, ${count("SEO-CANONICAL-MISSING")} missing canonical, ${count("ECOM-FACETED-NO-CANONICAL") + count("ECOM-VARIANT-NO-CANONICAL")} faceted/variant URLs without a clean canonical.`,
    evidence: [...severe, ...mild].slice(0, 5).map((f) => ({ label: f.ruleId, url: f.url, detail: f.detail })),
    completeness: ctx.crawlCompleteness(),
    guidance,
    caveat: "Intentional noindex is correct for private or filtered pages. A canonical is a hint, not a directive.",
    links: [LINK.seo],
  };
}

export function canonicalTags(ctx: Signals): ItemResult {
  const guidance = "Give every indexable page a self-referencing canonical, and canonicalize filter, sort, and variant URLs to the clean URL.";
  if (!ctx.hasCrawl) return noCrawl(ctx, guidance);
  const total = ctx.analyzable().length;
  const missing = ctx.findingUrls(["SEO-CANONICAL-MISSING"]);
  const bad = ctx.findings(["SEO-CANONICAL-OFFHOST", "SEO-CANONICAL-TARGET-BAD"]);
  const facets = ctx.findings(["ECOM-FACETED-NO-CANONICAL", "ECOM-VARIANT-NO-CANONICAL"]);
  let status = ratioStatus(missing.length, total);
  if (bad.length) status = "not_met";
  else if (facets.length && status === "met") status = "partial";
  return {
    status,
    method: "measured",
    summary: `${total - missing.length} of ${total} analyzable pages declare a canonical; ${bad.length} canonical(s) point off-host or to an error/redirect/noindex target; ${facets.length} faceted/variant URL(s) keep parameters in the canonical.`,
    evidence: [...bad, ...facets, ...ctx.findings(["SEO-CANONICAL-MISSING"])].slice(0, 5).map((f) => ({ label: f.ruleId, url: f.url, detail: f.detail })),
    completeness: ctx.crawlCompleteness(),
    guidance,
    caveat: "A canonical is a hint, not a directive; search engines may choose a different canonical.",
    links: [LINK.seo, LINK.recs],
  };
}

// ------------------------------------------------------------------ JS-only text
export function jsRendered(ctx: Signals, variant: "seo" | "geo"): ItemResult {
  const guidance =
    variant === "geo"
      ? "Serve key facts (product details, prices, answers) as text in the initial HTML, not only after JavaScript runs or inside images."
      : "Server-render or pre-render important content so it is present in the HTML response; do not rely on client-side rendering for text you want indexed.";
  if (!ctx.hasCrawl) return noCrawl(ctx, guidance);
  const fetched = ctx.d.snapshots.filter((s) => s.statusCode !== null && s.statusCode >= 200 && s.statusCode < 300);
  const js = ctx.d.snapshots.filter((s) => s.skippedReason === "js_rendered");
  const status = fetched.length === 0 ? "unknown" : js.length > 0 ? "not_met" : "met";
  return {
    status,
    method: "measured",
    summary: `${js.length} of ${fetched.length} fetched HTML pages served under 50 words of text with a JavaScript app root (skipped as js_rendered).`,
    evidence: urlEvidence(js.map((s) => ({ url: s.url, detail: `${s.wordCount ?? 0} words in served HTML` })), "JS-rendered"),
    completeness: ctx.crawlCompleteness(),
    guidance,
    caveat: "Only server-delivered HTML is analysed; this app does not execute JavaScript, and text inside images is not detected.",
    links: [LINK.seo],
  };
}

// ------------------------------------------------------------------ login walls
export function loginWalls(ctx: Signals): ItemResult {
  const guidance = "Keep product, pricing, documentation, and article pages publicly readable; put only account-specific pages behind sign-in.";
  if (!ctx.hasCrawl) return noCrawl(ctx, guidance);
  const walls = ctx.d.snapshots.filter((s) => {
    if (LOGIN_PATH.test(pathOf(s.url))) return false; // the sign-in/account page itself is not a wall
    if (s.statusCode === 401 || s.statusCode === 403) return true;
    const redirected = !!s.finalUrl && normalizeUrlKey(s.finalUrl) !== normalizeUrlKey(s.url);
    return redirected && LOGIN_PATH.test(pathOf(s.finalUrl!));
  });
  const checked = ctx.d.snapshots.filter((s) => s.statusCode !== null).length;
  return {
    status: checked === 0 ? "unknown" : walls.length ? "not_met" : "met",
    method: "measured",
    summary: `${walls.length} of ${checked} fetched URLs returned 401/403 or redirected to a sign-in/account path.`,
    evidence: urlEvidence(walls.map((s) => ({ url: s.url, detail: s.statusCode === 401 || s.statusCode === 403 ? `HTTP ${s.statusCode}` : `redirects to ${s.finalUrl}` })), "Login wall"),
    completeness: ctx.crawlCompleteness(),
    guidance,
    caveat: "Only crawled URLs are checked. A 401/403 can also come from bot protection blocking this crawler; confirm in a private browser window. Intentionally private pages (account, checkout) are fine.",
    links: [LINK.seo],
  };
}

// ------------------------------------------------------------------ structured data by page type
const EXPECTED_SCHEMA: Partial<Record<PageType, { types: string[]; label: string }>> = {
  home: { types: ["Organization", "WebSite", "LocalBusiness", "Corporation", "OnlineStore", "Store"], label: "Organization or WebSite" },
  product: { types: ["Product", "ProductGroup"], label: "Product" },
  article: { types: ["Article", "BlogPosting", "NewsArticle", "TechArticle", "Report"], label: "Article or BlogPosting" },
  collection: { types: ["CollectionPage", "ItemList", "OfferCatalog", "BreadcrumbList"], label: "CollectionPage, ItemList, or BreadcrumbList" },
};
const OFFER_ISSUES = new Set(["missing_offers", "offer_missing_price", "offer_missing_currency", "aggregate_offer_missing_low_price"]);

export interface SchemaCheck {
  snap: Snap;
  expected: string;
  ok: boolean;
  problem: string | null;
}

export function schemaCheckFor(s: Snap, siteType: string): SchemaCheck | null {
  const exp = EXPECTED_SCHEMA[s.pageType];
  if (!exp) return null;
  const has = exp.types.some((t) => s.jsonLdTypes.includes(t));
  let problem: string | null = has ? null : `no ${exp.label} JSON-LD`;
  if (!problem && s.jsonLdIssues.some((i) => i.issue === "invalid_json")) problem = "a JSON-LD block is not valid JSON";
  if (!problem && siteType === "ecommerce" && s.pageType === "product" && s.jsonLdIssues.some((i) => OFFER_ISSUES.has(i.issue))) problem = "Product JSON-LD without a complete Offer (price and currency)";
  return { snap: s, expected: exp.label, ok: problem === null, problem };
}

export function schemaByType(ctx: Signals, variant: "seo" | "geo"): ItemResult {
  const guidance =
    variant === "seo"
      ? "Add structured data that matches each page type (Product with Offer, Article, Organization, BreadcrumbList), then validate templates in Google's Rich Results Test."
      : "Add structured data where it describes the page (Product with Offer, Article with author and dates, Organization), using only facts shown on the page.";
  const caveat =
    variant === "seo"
      ? "Rich Results Test runs are manual (not automated here). Structured data makes pages eligible for rich results; it never guarantees them."
      : "Structured data helps machines parse facts; it is not shown to cause AI citations.";
  if (!ctx.hasCrawl) return noCrawl(ctx, guidance);
  const checks = ctx.analyzable().map((s) => schemaCheckFor(s, ctx.d.project.siteType)).filter((c): c is SchemaCheck => c !== null);
  const bad = checks.filter((c) => !c.ok);
  return {
    status: ratioStatus(bad.length, checks.length),
    method: "measured",
    summary:
      checks.length === 0
        ? "No home, product, article, or collection pages among crawled pages, so no page-type expectation applies."
        : `${checks.length - bad.length} of ${checks.length} pages have the structured data expected for their page type; ${bad.length} missing or incomplete.`,
    evidence: urlEvidence(bad.map((c) => ({ url: c.snap.url, detail: `${c.snap.pageType}: ${c.problem}` })), "Structured data"),
    completeness: ctx.crawlCompleteness(),
    guidance,
    caveat,
    links: [LINK.seo, LINK.recs],
  };
}

// ------------------------------------------------------------------ internal links to key pages
export function keyPageLinks(ctx: Signals): ItemResult {
  const guidance = "Link to your most important pages from related pages with descriptive anchor text (navigation, category pages, and in-content links).";
  if (!ctx.hasCrawl) return noCrawl(ctx, guidance);
  const analyzable = ctx.analyzable();
  const byKey = new Map(analyzable.map((s) => [normalizeUrlKey(s.url), s]));
  let basis = "top Search Console pages by clicks";
  let key: Snap[] = [];
  if (ctx.hasGsc) {
    key = [...ctx.pageMetricsCurrent().entries()]
      .sort((a, b) => b[1].clicks - a[1].clicks || b[1].impressions - a[1].impressions)
      .map(([k]) => byKey.get(k))
      .filter((s): s is Snap => !!s && s.pageType !== "home")
      .slice(0, 5);
  }
  if (key.length === 0) {
    basis = "collection and landing pages";
    key = analyzable.filter((s) => s.pageType === "collection" || s.pageType === "landing").slice(0, 10);
  }
  if (key.length === 0) {
    basis = "crawled non-home pages";
    key = analyzable.filter((s) => s.pageType !== "home").slice(0, 10);
  }
  const weak = key.filter((s) => ctx.inlinkCount(s.url) < THRESHOLDS.keyPageMinInlinks);
  return {
    status: ratioStatus(weak.length, key.length),
    method: "measured",
    summary: `${key.length - weak.length} of ${key.length} key pages (${basis}) have at least ${THRESHOLDS.keyPageMinInlinks} internal links from other crawled pages; ${weak.length} weakly linked.`,
    evidence: urlEvidence(weak.map((s) => ({ url: s.url, detail: `${plural(ctx.inlinkCount(s.url), "inlink")} from crawled pages` })), "Weakly linked"),
    completeness: ctx.crawlCompleteness(ctx.limitReached ? "links from pages outside the crawl are not counted" : undefined),
    guidance,
    caveat: "Counts only links found on crawled pages (up to 200 internal links extracted per page); pages outside crawl coverage may also link here.",
    links: [LINK.seo, LINK.recs],
  };
}

// ------------------------------------------------------------------ article attributes
export function articleAttribute(ctx: Signals, attr: "author" | "updated" | "citations", guidance: string, caveat: string): ItemResult {
  if (!ctx.hasCrawl) return noCrawl(ctx, guidance);
  const articles = ctx.analyzable().filter((s) => s.pageType === "article");
  const has = (s: Snap) => (attr === "author" ? !!s.author?.trim() : attr === "updated" ? !!s.lastUpdated?.trim() : (s.outboundCitations ?? 0) >= 1);
  const what = attr === "author" ? "a named author (meta author or JSON-LD author)" : attr === "updated" ? "a declared modified date (article:modified_time or JSON-LD dateModified)" : "at least one outbound link in the main content";
  const missing = articles.filter((s) => !has(s));
  return {
    status: ratioStatus(missing.length, articles.length),
    method: "measured",
    summary: articles.length === 0 ? `No article pages among ${plural(ctx.analyzable().length, "analyzable page")}, so there is nothing to check yet.` : `${articles.length - missing.length} of ${articles.length} article pages have ${what}.`,
    evidence: urlEvidence(missing.map((s) => s.url), "Missing"),
    completeness: ctx.crawlCompleteness(),
    guidance,
    caveat,
    links: [LINK.seo],
  };
}

// ------------------------------------------------------------------ stale pages
export function stalePages(ctx: Signals, guidance: string): ItemResult {
  if (!ctx.hasCrawl) return noCrawl(ctx, guidance, "heuristic");
  const cutoff = new Date(ctx.d.now.getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - THRESHOLDS.staleMonths);
  const dated = ctx.analyzable().map((s) => ({ s, d: parseDate(s.lastUpdated) })).filter((x): x is { s: Snap; d: Date } => x.d !== null);
  const stale = dated.filter((x) => x.d < cutoff);
  return {
    status: ratioStatus(stale.length, dated.length),
    method: "heuristic",
    summary:
      dated.length === 0
        ? `None of ${plural(ctx.analyzable().length, "analyzable page")} declares a modified date, so staleness cannot be estimated.`
        : `${stale.length} of ${dated.length} pages with a declared date were last modified more than ${THRESHOLDS.staleMonths} months ago.`,
    evidence: urlEvidence(stale.map((x) => ({ url: x.s.url, detail: `declared ${x.s.lastUpdated}` })), "Stale"),
    completeness: ctx.crawlCompleteness(),
    guidance,
    caveat: "Uses the declared modified date (meta or JSON-LD), which may differ from the date shown on the page. An old date is a prompt to review, not proof the content is outdated.",
    links: [LINK.seo],
  };
}

// ------------------------------------------------------------------ public pricing
const PRICING_PATH = /\/(?:pricing|prices|plans|price-list|rates)(?:\/|$)/i;

export function publicPricing(ctx: Signals): ItemResult {
  const guidance = "Show current prices as text on a public page (a pricing page, or Offer price on product pages) and keep them in sync with structured data.";
  const siteType = ctx.d.project.siteType;
  if (siteType === "publisher") {
    return { status: "not_applicable", method: "heuristic", summary: "Pricing pages are not expected for publisher sites.", guidance, links: [] };
  }
  if (!ctx.hasCrawl) return noCrawl(ctx, guidance, "heuristic");
  const analyzable = ctx.analyzable();
  const pricingPages = analyzable.filter((s) => PRICING_PATH.test(pathOf(s.url)));
  const products = analyzable.filter((s) => s.pageType === "product");
  const priced = products.filter((s) => (s.jsonLdTypes.includes("Product") || s.jsonLdTypes.includes("ProductGroup")) && !s.jsonLdIssues.some((i) => OFFER_ISSUES.has(i.issue)));
  const caveat = "Heuristic: looks for a /pricing-style URL or a complete Offer (price and currency) in Product structured data; prices shown only as images or loaded by JavaScript are not seen.";
  if (siteType === "ecommerce" || (products.length > 0 && pricingPages.length === 0)) {
    const unpriced = products.filter((s) => !priced.includes(s));
    return {
      status: ratioStatus(unpriced.length, products.length),
      method: "heuristic",
      summary: products.length === 0 ? "No product pages among crawled pages." : `${priced.length} of ${products.length} product pages carry an Offer price in structured data.`,
      evidence: urlEvidence(unpriced.map((s) => s.url), "No Offer price"),
      completeness: ctx.crawlCompleteness(),
      guidance,
      caveat,
      links: [LINK.seo],
    };
  }
  const found = pricingPages.length > 0;
  return {
    status: found ? "met" : siteType === "saas" ? "not_met" : "unknown",
    method: "heuristic",
    summary: found ? `Public pricing page found: ${pricingPages[0]!.url}.` : `No /pricing, /plans, or /prices page among ${plural(analyzable.length, "crawled page")}.`,
    evidence: urlEvidence(pricingPages.map((s) => s.url), "Pricing page"),
    completeness: ctx.crawlCompleteness(),
    guidance,
    caveat,
    links: [LINK.seo],
  };
}

// ------------------------------------------------------------------ data-driven mention lists
const MENTION_CAVEAT =
  "API-sampled answers (provider and model labelled on GEO results), not consumer-app answers. \"With you\" means your brand was named in an answer that cited this source type; cited pages are not fetched, so we cannot confirm a page names you.";

export function mentions(ctx: Signals, key: MentionSourceKey, guidance: string, extraCaveat?: string, label?: string): ItemResult {
  const what = label ?? MENTION_SOURCES[key].label;
  const caveat = extraCaveat ? `${extraCaveat} ${MENTION_CAVEAT}` : MENTION_CAVEAT;
  const links = [LINK.geoResults, LINK.competitors];
  if (!ctx.hasGeo || ctx.validObs().length === 0) {
    return { status: "unknown", method: "measured", summary: "No valid GEO observations yet, so no cited sources are known.", completeness: ctx.geoCompleteness(), guidance, caveat, links: [LINK.geoPrompts, LINK.geoResults] };
  }
  const a = ctx.mentionAggregate(key);
  const base = `${a.answersCiting} of ${a.validAnswers} valid answers cited ${what}`;
  if (a.answersCiting === 0) {
    return { status: "unknown", method: "measured", summary: `${base}.`, completeness: ctx.geoCompleteness(), guidance, caveat, links };
  }
  const status = a.answersWithoutBrand === 0 ? "met" : "partial";
  const evidence: Evidence[] =
    status === "partial"
      ? a.gapUrls.slice(0, 5).map((g) => ({
          label: g.title ? `${g.host}: ${g.title}` : g.host,
          url: g.url,
          detail: `cited in ${plural(g.count, "answer")} that did not mention you${g.entities.length ? `; named instead: ${g.entities.slice(0, 3).join(", ")}` : ""}`,
        }))
      : a.withBrandUrls.slice(0, 5).map((g) => ({ label: g.title ? `${g.host}: ${g.title}` : g.host, url: g.url, detail: `cited in ${plural(g.count, "answer")} that mentioned you` }));
  return {
    status,
    method: "measured",
    summary: `${base}; you were mentioned in ${a.answersWithBrand} of those ${a.answersCiting}. ${plural(a.gapUrls.length, "distinct URL")} cited without you.`,
    evidence,
    completeness: ctx.geoCompleteness(),
    guidance,
    caveat,
    links,
  };
}
