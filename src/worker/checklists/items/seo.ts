/**
 * [A21] SEO readiness checklist (sections: Technical, On-page, Quick wins, Content, Links).
 * Reference tiers come from Okara's "SEO tactics, ranked by impact" graphic: an external opinion used
 * only to order items within a section. Where project data contradicts a tier, the caveat says so.
 */
import { normalizeUrlKey } from "../../seo/rules/registry";
import type { Signals } from "../signals";
import { THRESHOLDS } from "../signals";
import { BESTOF_PATTERN, COMPARISON_PATTERN, coverage, isQuestionQuery, pct, plural, titleAndPath, tokenSet } from "../text";
import { LINK, type ItemDef, type ItemResult, manualItem, noCrawl, noGsc, notConnected, ratioStatus, urlEvidence } from "./common";
import { articleAttribute, canonicalTags, jsRendered, keyPageLinks, mentions, robotsAndNoindex, schemaByType, sitemap } from "./shared";

/** Data-over-opinion note for title/snippet items rated D by the reference graphic. */
function titleTierNote(ctx: Signals): string | null {
  const n = ctx.hasGsc ? ctx.weakCtr().length : 0;
  if (n === 0) return null;
  return `The reference graphic rates title tweaks tier D (external opinion), but your Search Console data shows ${plural(n, "high-impression, low-CTR row")}; the measured data takes precedence for this project.`;
}

const joinCaveat = (...parts: Array<string | null | undefined>) => parts.filter(Boolean).join(" ") || null;

// ------------------------------------------------------------------ Technical
const technical: ItemDef[] = [
  {
    id: "seo.technical.gsc_ga4",
    section: "technical",
    label: "Set up GSC and GA4",
    tier: null,
    evaluate(ctx) {
      const g = ctx.d.gsc;
      const connected = g.connection === "connected";
      const gscState = connected ? "Search Console connected" : g.sync ? `Search Console data present (${g.sync.source === "csv_import" ? "CSV import" : g.sync.source === "demo" ? "demo fixture" : "API"}), OAuth ${g.connection ?? "not connected"}` : "Search Console not connected";
      return {
        status: connected || g.sync ? "partial" : "not_met",
        method: "measured",
        summary: `${gscState}${g.sync ? `; last sync ${g.sync.syncedAt.slice(0, 10)}` : ""}. GA4: not connected (this app has no analytics integration, so it cannot be verified).`,
        completeness: ctx.gscCompleteness(),
        guidance: "Connect Google Search Console here (read-only scope). Set up GA4 (or another analytics tool) in your own account; this app does not read analytics data.",
        caveat: "GA4 status is not_connected by design: no analytics source is integrated, so this item can be at most partial.",
        links: [LINK.integrations],
      };
    },
  },
  { id: "seo.technical.sitemap_submitted", section: "technical", label: "Submit sitemap to GSC and Bing", tier: "S", evaluate: (ctx) => sitemap(ctx, "seo") },
  {
    id: "seo.technical.indexing_issues",
    section: "technical",
    label: "Fix indexing issues",
    tier: "S",
    evaluate(ctx) {
      const signals = ctx.hasCrawl
        ? `Crawl-side signals: ${ctx.findingUrls(["SEO-NOINDEX"]).length} noindex, ${ctx.findingUrls(["SEO-STATUS-5XX"]).length} 5xx, ${ctx.findingUrls(["SEO-STATUS-4XX"]).length} 4xx, ${ctx.findingUrls(["SEO-ROBOTS-SITEMAP-CONFLICT"]).length} sitemap URLs disallowed by robots.txt.`
        : "No crawl yet.";
      return notConnected(
        `Index coverage requires Search Console URL Inspection / page indexing data, which is not imported. ${signals}`,
        "Review the Page indexing report and URL Inspection in Search Console; fix crawl-side blockers listed in the SEO audit.",
        {
          evidence: ctx.findings(["SEO-NOINDEX", "SEO-STATUS-5XX", "SEO-STATUS-4XX", "SEO-ROBOTS-SITEMAP-CONFLICT"]).slice(0, 5).map((f) => ({ label: f.ruleId, url: f.url, detail: f.detail })),
          completeness: ctx.crawlCompleteness(),
          caveat: "Crawl findings are not index status: a crawlable page can still be excluded from the index, and sitemap presence is not proof of indexing.",
          links: [LINK.seo, LINK.integrations],
        },
      );
    },
  },
  { id: "seo.technical.robots_noindex", section: "technical", label: "Check robots.txt and noindex tags", tier: "S", evaluate: robotsAndNoindex },
  { id: "seo.technical.canonical_tags", section: "technical", label: "Add canonical tags", tier: "B", evaluate: canonicalTags },
  {
    id: "seo.technical.core_web_vitals",
    section: "technical",
    label: "Fix Core Web Vitals",
    tier: "D",
    evaluate: () =>
      notConnected(
        "Core Web Vitals need field data (Chrome UX Report or your own real-user monitoring), which is not connected. No lab or field measurement is claimed.",
        "Check the Core Web Vitals report in Search Console or PageSpeed Insights, and fix the templates with poor LCP, INP, or CLS.",
      ),
  },
  {
    id: "seo.technical.mobile_friendly",
    section: "technical",
    label: "Make the site mobile friendly",
    tier: "D",
    evaluate(ctx) {
      const guidance = "Use a responsive layout with <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">, readable font sizes, and tap targets that are not crowded.";
      if (!ctx.hasCrawl) return noCrawl(ctx, guidance, "heuristic");
      const pages = ctx.analyzable().filter((s) => s.imagesTotal !== null);
      if (pages.length === 0) {
        return manualItem("Viewport data was not extracted for the latest crawl, so check mobile rendering yourself.", guidance, {
          caveat: "Re-crawl to extract viewport meta tags. A viewport tag alone does not make a layout mobile friendly.",
          links: [LINK.seo],
        });
      }
      const bad = pages.filter((s) => !/width\s*=\s*device-width/i.test(s.viewport ?? ""));
      return {
        status: ratioStatus(bad.length, pages.length),
        method: "heuristic",
        summary: `${pages.length - bad.length} of ${pages.length} pages declare a responsive viewport (width=device-width).`,
        evidence: urlEvidence(bad.map((s) => ({ url: s.url, detail: s.viewport ? `viewport: ${s.viewport}` : "no viewport meta tag" })), "No responsive viewport"),
        completeness: ctx.crawlCompleteness(),
        guidance,
        caveat: "Heuristic only: a responsive viewport tag is necessary but not sufficient; layout, font size, and tap targets are not rendered or tested here.",
        links: [LINK.seo],
      };
    },
  },
  { id: "seo.technical.js_crawlable", section: "technical", label: "Check JS content is crawlable", tier: "S", evaluate: (ctx) => jsRendered(ctx, "seo") },
  {
    id: "seo.technical.broken_links",
    section: "technical",
    label: "Fix broken links, 404s, redirect chains",
    tier: "C",
    evaluate(ctx) {
      const guidance = "Update internal links that point to errors or redirects so they point straight at the final 200 URL; redirect or restore removed pages that still get links.";
      if (!ctx.hasCrawl) return noCrawl(ctx, guidance);
      const errors = ctx.findings(["SEO-LINK-BROKEN-INTERNAL", "SEO-STATUS-4XX", "SEO-STATUS-5XX"]);
      const byKey = ctx.byKey();
      const redirecting = new Map<string, { url: string; target: string | null; from: Set<string> }>();
      for (const s of ctx.analyzable()) {
        for (const l of s.internalLinks) {
          const t = byKey.get(normalizeUrlKey(l));
          if (t && t.statusCode !== null && t.statusCode >= 300 && t.statusCode < 400) {
            const e = redirecting.get(t.url) ?? { url: t.url, target: t.finalUrl, from: new Set<string>() };
            e.from.add(s.url);
            redirecting.set(t.url, e);
          }
        }
      }
      const status = errors.length ? "not_met" : redirecting.size ? "partial" : "met";
      return {
        status,
        method: "measured",
        summary: `${ctx.findingUrls(["SEO-LINK-BROKEN-INTERNAL"]).length} pages link to error URLs; ${ctx.findingUrls(["SEO-STATUS-4XX"]).length} crawled URLs return 4xx and ${ctx.findingUrls(["SEO-STATUS-5XX"]).length} return 5xx; ${plural(redirecting.size, "redirecting URL")} still linked internally.`,
        evidence: [
          ...errors.map((f) => ({ label: f.ruleId, url: f.url, detail: f.detail })),
          ...[...redirecting.values()].map((r) => ({ label: "Linked redirect", url: r.url, detail: `redirects to ${r.target ?? "unknown"}; linked from ${plural(r.from.size, "page")}` })),
        ].slice(0, 5),
        completeness: ctx.crawlCompleteness(),
        guidance,
        caveat: "Only URLs fetched in this crawl are evaluated; links to uncrawled URLs are not claimed broken. Redirect hop counts are not stored, so single redirects and chains are both listed.",
        links: [LINK.seo, LINK.recs],
      };
    },
  },
  {
    id: "seo.technical.clean_urls",
    section: "technical",
    label: "Use clean, descriptive URLs",
    tier: null,
    evaluate(ctx) {
      const guidance = "Prefer short, lowercase, hyphenated paths that describe the page; avoid session IDs and tracking parameters in linked URLs. Do not change existing URLs without redirects.";
      if (!ctx.hasCrawl) return noCrawl(ctx, guidance, "heuristic");
      const flagged = ctx.analyzable().flatMap((s) => {
        const issues = urlIssues(s.url);
        return issues.length ? [{ url: s.url, detail: issues.join(", ") }] : [];
      });
      const total = ctx.analyzable().length;
      return {
        status: ratioStatus(flagged.length, total),
        method: "heuristic",
        summary: `${total - flagged.length} of ${total} crawled URLs look clean; ${flagged.length} have query parameters, long or deep paths, uppercase, underscores, or ID-like segments.`,
        evidence: urlEvidence(flagged, "URL"),
        completeness: ctx.crawlCompleteness(),
        guidance,
        caveat: "Heuristic pattern checks; platform-generated URL formats (for example Shopify /collections/x/products/y) may be fine as they are.",
        links: [LINK.seo],
      };
    },
  },
  {
    id: "seo.technical.breadcrumbs",
    section: "technical",
    label: "Add breadcrumbs",
    tier: "B",
    evaluate(ctx) {
      const guidance = "Add visible breadcrumb navigation on category, product, and article templates, with matching BreadcrumbList structured data.";
      if (!ctx.hasCrawl) return noCrawl(ctx, guidance);
      const pages = ctx.analyzable().filter((s) => s.pageType !== "home");
      const has = (s: (typeof pages)[number]) => s.jsonLdTypes.includes("BreadcrumbList") || s.breadcrumbNav === true;
      const missing = pages.filter((s) => !has(s));
      const navUnknown = pages.filter((s) => s.breadcrumbNav === null).length;
      return {
        status: ratioStatus(missing.length, pages.length),
        method: "measured",
        summary: `${pages.length - missing.length} of ${pages.length} non-home pages have BreadcrumbList structured data or breadcrumb navigation markup.${navUnknown ? ` HTML breadcrumb markup was not extracted for ${plural(navUnknown, "page")} (older snapshot); only JSON-LD was checked there.` : ""}`,
        evidence: urlEvidence(missing.map((s) => s.url), "No breadcrumbs"),
        completeness: ctx.crawlCompleteness(),
        guidance,
        caveat: "Breadcrumb markup detection looks for BreadcrumbList JSON-LD/microdata or elements labelled 'breadcrumb'; visual breadcrumbs without such markup are not detected.",
        links: [LINK.seo],
      };
    },
  },
  {
    id: "seo.technical.orphan_pages",
    section: "technical",
    label: "Fix orphan pages",
    tier: "B",
    evaluate(ctx) {
      const guidance = "Link every page you want found from at least one relevant page (category, hub, or related article), not only from the sitemap.";
      if (!ctx.hasCrawl) return noCrawl(ctx, guidance);
      const pages = ctx.analyzable().filter((s) => s.pageType !== "home");
      const orphans = pages.filter((s) => ctx.inlinkCount(s.url) === 0);
      const limited = ctx.limitReached;
      const status = orphans.length === 0 ? (pages.length ? "met" : "unknown") : limited ? "partial" : "not_met";
      return {
        status,
        method: "measured",
        summary: `${orphans.length} of ${pages.length} crawled non-home pages have no internal links from any other crawled page (they were reached through the sitemap).`,
        evidence: urlEvidence(orphans.map((s) => s.url), "Orphan within coverage"),
        completeness: ctx.crawlCompleteness(limited ? "orphan status is provisional because the crawl stopped at its page limit" : undefined),
        guidance,
        caveat: "Within crawl coverage only: a page linked solely from uncrawled pages appears orphaned here.",
        links: [LINK.seo, LINK.recs],
      };
    },
  },
  { id: "seo.technical.schema_rich_results", section: "technical", label: "Add schema, test in Rich Results", tier: "B", evaluate: (ctx) => schemaByType(ctx, "seo") },
];

export function urlIssues(url: string): string[] {
  const issues: string[] = [];
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return ["unparseable"];
  }
  const path = u.pathname;
  if (u.search) issues.push("query parameters");
  if (url.length > 115) issues.push("long URL");
  if (path.split("/").filter(Boolean).length > 5) issues.push("deep path");
  if (/[A-Z]/.test(path)) issues.push("uppercase");
  if (/_/.test(path)) issues.push("underscores");
  if (/(?:^|\/)(?:\d{6,}|[0-9a-f]{16,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$|\.)/i.test(path)) issues.push("ID-like segment");
  if (/[;]|(?:jsessionid|phpsessid|sid=)/i.test(url)) issues.push("session ID");
  return issues;
}

// ------------------------------------------------------------------ On-page
const onPage: ItemDef[] = [
  {
    id: "seo.on_page.search_intent",
    section: "on_page",
    label: "Match every page to search intent",
    tier: "A",
    evaluate(ctx) {
      const guidance = "Make each page's format match what searchers want for its main query: guides for how-to queries, comparisons for 'best' or 'vs' queries, product pages for buying queries.";
      const latest = new Map<string, (typeof ctx.d.decisions)[number]>();
      for (const d of ctx.d.decisions) {
        if (d.questionId !== "seo.intent_page_fit") continue;
        const key = d.candidate ?? d.createdAt;
        if (!latest.has(key)) latest.set(key, d);
      }
      const judged = [...latest.values()].filter((d) => d.tier !== "drop" && typeof d.answer?.choice === "string" && d.answer.choice !== "insufficient_context");
      if (judged.length === 0) {
        return {
          status: "unknown",
          method: "heuristic",
          summary: "No Jev intent-fit judgments yet (they are made for GSC-backed candidates during SEO runs when decisions are configured).",
          completeness: ctx.gscCompleteness(),
          guidance,
          caveat: "Intent fit is a model judgment, not a measurement. Check it yourself before restructuring a page.",
          links: [LINK.recs, LINK.integrations],
        };
      }
      const count = (c: string) => judged.filter((d) => d.answer!.choice === c).length;
      const mismatch = count("mismatch");
      const partial = count("partial_fit");
      const flagged = judged.filter((d) => d.tier === "flag").length;
      return {
        status: mismatch ? "not_met" : partial ? "partial" : "met",
        method: "heuristic",
        summary: `Jev intent-fit judgments for ${plural(judged.length, "candidate")}: ${count("fits")} fit, ${partial} partial fit, ${mismatch} mismatch${flagged ? ` (${flagged} flagged: check this yourself)` : ""}.`,
        evidence: judged
          .filter((d) => d.answer!.choice !== "fits")
          .slice(0, 5)
          .map((d) => ({ label: `seo.intent_page_fit: ${String(d.answer!.choice)}${d.tier === "flag" ? " (check this yourself)" : ""}`, url: null, detail: d.candidate })),
        completeness: { note: `${judged.length} non-withheld judgments from decision records (drop-tier answers are withheld).`, covered: judged.length, total: latest.size },
        guidance,
        caveat: "Intent fit is a Jev model judgment on title, H1, and opening text, not a measurement; flagged answers are shown with 'Check this yourself'.",
        links: [LINK.recs],
      };
    },
  },
  {
    id: "seo.on_page.title_length",
    section: "on_page",
    label: "Titles 50–60 characters",
    tier: "D",
    evaluate(ctx) {
      const guidance = "Write a unique, descriptive title for each page that leads with the main topic; roughly 50–60 characters usually fits without truncation.";
      if (!ctx.hasCrawl) return noCrawl(ctx, guidance);
      const pages = ctx.analyzable();
      const missing = pages.filter((s) => !s.title?.trim());
      const titled = pages.filter((s) => s.title?.trim());
      const long = titled.filter((s) => s.title!.trim().length > THRESHOLDS.titleMax);
      const short = titled.filter((s) => s.title!.trim().length < THRESHOLDS.titleMin);
      const dup = ctx.findingUrls(["SEO-TITLE-DUPLICATE"]);
      const inRange = titled.length - long.length - short.length;
      const status = pages.length === 0 ? "unknown" : missing.length || dup.length ? "not_met" : long.length || short.length ? "partial" : "met";
      return {
        status,
        method: "measured",
        summary: `${inRange} of ${pages.length} titles are 50–60 characters; ${long.length} longer (may be truncated), ${short.length} shorter, ${missing.length} missing, ${dup.length} duplicated.`,
        evidence: urlEvidence(
          [
            ...missing.map((s) => ({ url: s.url, detail: "no title" })),
            ...dup.map((u) => ({ url: u, detail: "duplicate title" })),
            ...long.map((s) => ({ url: s.url, detail: `${s.title!.trim().length} chars: ${s.title!.trim()}` })),
            ...short.map((s) => ({ url: s.url, detail: `${s.title!.trim().length} chars: ${s.title!.trim()}` })),
          ],
          "Title",
        ),
        completeness: ctx.crawlCompleteness(),
        guidance,
        caveat: joinCaveat("Character counts are a guideline: Google truncates titles by pixel width and may rewrite them.", titleTierNote(ctx)),
        links: [LINK.seo, LINK.recs],
      };
    },
  },
  {
    id: "seo.on_page.unique_meta",
    section: "on_page",
    label: "Unique meta descriptions",
    tier: "D",
    evaluate(ctx) {
      const guidance = "Give each important page its own meta description that summarizes the page and why to click; do not reuse one across templates.";
      if (!ctx.hasCrawl) return noCrawl(ctx, guidance);
      const total = ctx.analyzable().length;
      const missing = ctx.findingUrls(["SEO-META-DESC-MISSING"]);
      const dup = ctx.findingUrls(["SEO-META-DESC-DUPLICATE"]);
      const bad = new Set([...missing, ...dup]);
      return {
        status: ratioStatus(bad.size, total),
        method: "measured",
        summary: `${total - bad.size} of ${total} analyzable pages have a unique meta description; ${missing.length} missing, ${dup.length} duplicated.`,
        evidence: urlEvidence([...missing.map((u) => ({ url: u, detail: "missing" })), ...dup.map((u) => ({ url: u, detail: "duplicate" }))], "Meta description"),
        completeness: ctx.crawlCompleteness(),
        guidance,
        caveat: joinCaveat("Meta descriptions are not a ranking factor, and search engines may write their own snippet.", titleTierNote(ctx)),
        links: [LINK.seo, LINK.recs],
      };
    },
  },
  {
    id: "seo.on_page.heading_structure",
    section: "on_page",
    label: "Fix heading structure",
    tier: null,
    evaluate(ctx) {
      const guidance = "Use one clear H1 per page and nest H2/H3 subheadings in order so the outline describes the content.";
      if (!ctx.hasCrawl) return noCrawl(ctx, guidance);
      const total = ctx.analyzable().length;
      const f = ctx.findings(["SEO-H1-MISSING", "SEO-H1-MULTIPLE", "SEO-HEADING-SKIP"]);
      const urls = new Set(f.map((x) => x.url).filter(Boolean));
      return {
        status: ratioStatus(urls.size, total),
        method: "measured",
        summary: `${total - urls.size} of ${total} pages have a single H1 and no skipped heading levels; ${ctx.findingUrls(["SEO-H1-MISSING"]).length} missing H1, ${ctx.findingUrls(["SEO-H1-MULTIPLE"]).length} multiple H1s, ${ctx.findingUrls(["SEO-HEADING-SKIP"]).length} skipped levels.`,
        evidence: f.slice(0, 5).map((x) => ({ label: x.ruleId, url: x.url, detail: x.detail })),
        completeness: ctx.crawlCompleteness(),
        guidance,
        caveat: "A missing H1 or skipped level is a structure and accessibility signal, not automatically a ranking failure.",
        links: [LINK.seo],
      };
    },
  },
  {
    id: "seo.on_page.answer_first_lines",
    section: "on_page",
    label: "Answer the query in the first 2 lines",
    tier: "S",
    evaluate(ctx) {
      const guidance = "Open each page with a direct answer to its main query (what it is, who it is for, the key fact) before background or marketing copy.";
      if (!ctx.hasGsc) return noGsc(ctx, guidance, "heuristic");
      if (!ctx.hasCrawl) return noCrawl(ctx, guidance, "heuristic");
      const top = ctx.topQueryByPage();
      const checked = ctx.analyzable().flatMap((s) => {
        const q = top.get(normalizeUrlKey(s.url));
        if (!q?.query) return [];
        const cov = coverage(q.query, tokenSet(s.firstParagraph));
        return cov === null ? [] : [{ s, query: q.query, cov }];
      });
      const miss = checked.filter((c) => c.cov < THRESHOLDS.answerCoverage);
      return {
        status: ratioStatus(miss.length, checked.length),
        method: "heuristic",
        summary:
          checked.length === 0
            ? "No crawled page has a matching top Search Console query yet."
            : `${checked.length - miss.length} of ${checked.length} pages mention most words of their top GSC query in the first paragraph.`,
        evidence: urlEvidence(miss.map((c) => ({ url: c.s.url, detail: `top query "${c.query}": ${pct(c.cov)} of its words in the first paragraph` })), "Opening misses query"),
        completeness: ctx.gscCompleteness(),
        guidance,
        caveat: "Heuristic: word overlap between the top query and the first paragraph (at least 60%), not a judgment of answer quality. Never stuff keywords into the opening.",
        links: [LINK.seo, LINK.recs],
      };
    },
  },
  {
    id: "seo.on_page.image_alt",
    section: "on_page",
    label: "Optimize images, add alt text",
    tier: "D",
    evaluate(ctx) {
      const guidance = "Add descriptive alt text to informative images (empty alt=\"\" for decorative ones) and serve appropriately sized, compressed formats.";
      if (!ctx.hasCrawl) return noCrawl(ctx, guidance);
      const pages = ctx.analyzable().filter((s) => s.imagesTotal !== null);
      if (pages.length === 0) {
        return { status: "unknown", method: "measured", summary: "Image alt attributes were not extracted for the latest crawl; re-crawl to measure them.", completeness: ctx.crawlCompleteness(), guidance, links: [LINK.seo] };
      }
      const images = pages.reduce((a, s) => a + (s.imagesTotal ?? 0), 0);
      const missing = pages.reduce((a, s) => a + (s.imagesMissingAlt ?? 0), 0);
      const withImages = pages.filter((s) => (s.imagesTotal ?? 0) > 0);
      const badPages = withImages.filter((s) => (s.imagesMissingAlt ?? 0) > 0);
      return {
        status: withImages.length === 0 ? "not_applicable" : ratioStatus(badPages.length, withImages.length),
        method: "measured",
        summary: `${missing} of ${images} images lack an alt attribute, on ${badPages.length} of ${withImages.length} pages with images.`,
        evidence: urlEvidence(badPages.map((s) => ({ url: s.url, detail: `${s.imagesMissingAlt} of ${s.imagesTotal} images without alt` })), "Missing alt"),
        completeness: ctx.crawlCompleteness(),
        guidance,
        caveat: "Counts missing alt attributes only; alt text quality, file size, and image formats are not measured. Images marked decorative (role=presentation or aria-hidden) are excluded.",
        links: [LINK.seo],
      };
    },
  },
  { id: "seo.on_page.internal_links", section: "on_page", label: "Internal links to important pages", tier: "B", evaluate: keyPageLinks },
];

// ------------------------------------------------------------------ Quick wins
const quickWins: ItemDef[] = [
  {
    id: "seo.quick_wins.low_ctr",
    section: "quick_wins",
    label: "High impressions, low CTR in GSC (rewrite title/meta)",
    tier: "D",
    evaluate(ctx) {
      const guidance = "Rewrite the title and meta description of these pages so the snippet clearly matches the query; keep claims to facts on the page.";
      if (!ctx.hasGsc) return noGsc(ctx, guidance);
      const rows = ctx.weakCtr();
      const medians = [...ctx.ctrMedians().entries()].map(([b, m]) => `${b}: ${pct(m.median)} over ${m.n} rows`).join("; ");
      return {
        status: rows.length ? "not_met" : "met",
        method: "measured",
        summary: rows.length
          ? `${plural(rows.length, "query/page row")} with at least ${THRESHOLDS.minImpressions} impressions have CTR below ${THRESHOLDS.ctrBelowMedianFactor}x the median for their position bucket.`
          : `No query/page rows with at least ${THRESHOLDS.minImpressions} impressions fall below ${THRESHOLDS.ctrBelowMedianFactor}x their position-bucket median CTR.`,
        evidence: urlEvidence(
          rows.map((r) => ({ url: r.page, detail: `${r.query ? `"${r.query}": ` : ""}${r.impressions.toLocaleString("en-US")} impressions, ${r.clicks} clicks (${pct(r.ctr)}), position ${r.position.toFixed(1)}; bucket ${r.bucket} median ${pct(r.median)}` })),
          "Weak CTR",
        ),
        completeness: { ...ctx.gscCompleteness(), note: `${ctx.gscCompleteness().note}. Medians: ${medians || "not enough rows per bucket"}.` },
        guidance,
        caveat: joinCaveat(
          "CTR also depends on SERP features and brand familiarity; these are hypotheses, not predicted gains.",
          rows.length ? `The reference graphic rates title tweaks tier D (external opinion), but this is a measured opportunity in your own Search Console data, so the data takes precedence.` : null,
        ),
        links: [LINK.recs, LINK.seo],
      };
    },
  },
  {
    id: "seo.quick_wins.site_search_titles",
    section: "quick_wins",
    label: "Search site:you.com on Google (fix cut-off titles)",
    tier: "D",
    evaluate(ctx) {
      const long = ctx.analyzable().filter((s) => (s.title?.trim().length ?? 0) > THRESHOLDS.titleMax);
      return manualItem(
        ctx.hasCrawl
          ? `Run the site: search yourself. From the crawl, ${plural(long.length, "title")} exceed ${THRESHOLDS.titleMax} characters and are likely candidates for truncation.`
          : "Run the site: search yourself; no crawl yet to suggest likely truncated titles.",
        "Search site:yourdomain in Google, note titles that are cut off or rewritten, and shorten or clarify them.",
        {
          evidence: urlEvidence(long.map((s) => ({ url: s.url, detail: `${s.title!.trim().length} chars` })), "Long title"),
          completeness: ctx.crawlCompleteness(),
          caveat: joinCaveat("This app never scrapes Google results; the check is manual.", titleTierNote(ctx)),
          links: [LINK.seo],
        },
      );
    },
  },
  {
    id: "seo.quick_wins.page_two",
    section: "quick_wins",
    label: "Old pages ranking on page 2 (update first)",
    tier: "S",
    evaluate(ctx) {
      const guidance = "Refresh these pages first: update facts and examples, answer the queries they already get impressions for, and improve internal links to them.";
      if (!ctx.hasGsc) return noGsc(ctx, guidance);
      const rows = ctx.page2();
      const byKey = ctx.byKey();
      return {
        status: rows.length ? "not_met" : "met",
        method: "measured",
        summary: rows.length
          ? `${plural(rows.length, "page")} average positions ${Math.ceil(THRESHOLDS.page2Min)}–${Math.floor(THRESHOLDS.page2Max)} with at least ${THRESHOLDS.minImpressions} impressions.`
          : `No pages average positions 11–20 with at least ${THRESHOLDS.minImpressions} impressions.`,
        evidence: urlEvidence(
          rows.map((r) => {
            const snap = byKey.get(normalizeUrlKey(r.url));
            return { url: r.url, detail: `position ${r.position!.toFixed(1)}, ${r.impressions.toLocaleString("en-US")} impressions; declared modified ${snap?.lastUpdated ?? "unknown"}` };
          }),
          "Page 2",
        ),
        completeness: ctx.gscCompleteness(),
        guidance,
        caveat: "Position is Search Console's average (impression-weighted across queries when aggregated from query rows); 'old' uses the declared modified date where available.",
        links: [LINK.recs, LINK.seo],
      };
    },
  },
  {
    id: "seo.quick_wins.people_also_ask",
    section: "quick_wins",
    label: "\"People also ask\" on your keywords",
    tier: "B",
    evaluate(ctx) {
      const questions = [...new Set(ctx.qpCurrent().filter((r) => isQuestionQuery(r.query!)).map((r) => r.query!))];
      return notConnected(
        `"People also ask" needs SERP data, which is not connected. As a first-party alternative, ${plural(questions.length, "question-form query", "question-form queries")} appear in your Search Console data.`,
        "Answer recurring questions on the most relevant page (a short heading plus a direct answer). Check live results yourself.",
        {
          evidence: questions.slice(0, 5).map((q) => ({ label: "GSC question query", url: null, detail: q })),
          completeness: ctx.gscCompleteness(),
          caveat: "This app never scrapes Google results; paid SERP providers must be enabled explicitly and are not configured.",
        },
      );
    },
  },
  {
    id: "seo.quick_wins.declining_pages",
    section: "quick_wins",
    label: "Pages losing traffic or rankings (refresh)",
    tier: "S",
    evaluate(ctx) {
      const guidance = "Check what changed on these pages (content, links, competing pages) and refresh the ones that still match demand.";
      if (!ctx.hasGsc) return noGsc(ctx, guidance);
      const rows = ctx.declining();
      return {
        status: rows.length ? "not_met" : "met",
        method: "measured",
        summary: rows.length
          ? `${plural(rows.length, "page")} lost at least ${pct(THRESHOLDS.decliningMinDrop)} of clicks vs the previous 28 days (minimum ${THRESHOLDS.decliningMinPrevClicks} previous clicks).`
          : `No page lost ${pct(THRESHOLDS.decliningMinDrop)} or more of clicks vs the previous 28 days (minimum ${THRESHOLDS.decliningMinPrevClicks} previous clicks).`,
        evidence: urlEvidence(rows.map((r) => ({ url: r.url, detail: `clicks ${r.prevClicks} → ${r.curClicks} (−${pct(r.drop)})` })), "Declining"),
        completeness: ctx.gscCompleteness(),
        guidance,
        caveat: "Seasonality and Search Console reporting changes can also move clicks; compare like-for-like periods before acting.",
        links: [LINK.recs, LINK.seo],
      };
    },
  },
];

// ------------------------------------------------------------------ Content
const content: ItemDef[] = [
  {
    id: "seo.content.competitor_keywords",
    section: "seo_content",
    label: "Find your competitors' keywords",
    tier: "A",
    evaluate: () =>
      notConnected(
        "Competitor keyword rankings need a keyword data source, which is not connected. Only your own Search Console queries are available.",
        "Use a keyword research tool you trust for competitor rankings; this app shows observed first-party opportunities only.",
        { links: [LINK.integrations, LINK.competitors] },
      ),
  },
  {
    id: "seo.content.volume_kd",
    section: "seo_content",
    label: "Find high volume, low KD keywords",
    tier: "A",
    evaluate: () =>
      notConnected(
        "Search volume and keyword difficulty need a keyword data source, which is not connected. No volume or KD values are estimated.",
        "Use a keyword research tool for volume and difficulty; validate demand with your own Search Console impressions.",
      ),
  },
  {
    id: "seo.content.cannibalization",
    section: "seo_content",
    label: "Fix keyword cannibalization",
    tier: "B",
    evaluate(ctx) {
      const guidance = "Where two pages compete for the same intent, merge them or make their intents clearly distinct, then redirect or canonicalize the weaker URL.";
      if (!ctx.hasGsc && !ctx.hasCrawl) return noCrawl(ctx, guidance);
      const overlaps = ctx.d.decisions.filter((d) => d.questionId === "seo.page_overlap");
      const merge = overlaps.filter((d) => d.outcome === "selected");
      const shared = ctx.sharedQueries();
      const dupContent = ctx.findingUrls(["SEO-CONTENT-DUPLICATE"]);
      const status = merge.length || dupContent.length ? "not_met" : shared.length ? "partial" : "met";
      return {
        status,
        method: "measured",
        summary: `${plural(shared.length, "GSC query", "GSC queries")} send impressions to two or more pages; Jev judged ${plural(merge.length, "pair")} as competing for the same intent (of ${overlaps.length} judged); ${plural(dupContent.length, "page")} share identical main text.`,
        evidence: [
          ...shared.slice(0, 3).map((q) => ({ label: `Shared query "${q.query}"`, url: q.pages[0] ?? null, detail: q.pages.join(" | ") })),
          ...dupContent.map((u) => ({ label: "SEO-CONTENT-DUPLICATE", url: u, detail: "identical main text" })),
        ].slice(0, 5),
        completeness: ctx.hasGsc ? ctx.gscCompleteness() : ctx.crawlCompleteness(),
        guidance,
        caveat: "Sharing a query is a prompt to review, not proof of cannibalization; only confident merge-side Jev judgments become consolidate recommendations ([A15]).",
        links: [LINK.recs, LINK.seo],
      };
    },
  },
  {
    id: "seo.content.merge_thin",
    section: "seo_content",
    label: "Merge thin or overlapping pages",
    tier: "B",
    evaluate(ctx) {
      const guidance = "Expand thin pages that serve a real need; merge or remove ones that overlap, with redirects.";
      if (!ctx.hasCrawl) return noCrawl(ctx, guidance);
      const thin = ctx.findingUrls(["SEO-CONTENT-THIN"]);
      const dup = ctx.findingUrls(["SEO-CONTENT-DUPLICATE"]);
      const merge = ctx.d.decisions.filter((d) => d.questionId === "seo.page_overlap" && d.outcome === "selected");
      const total = ctx.analyzable().length;
      const bad = new Set([...thin, ...dup]).size + merge.length;
      return {
        status: bad === 0 ? (total ? "met" : "unknown") : "not_met",
        method: "measured",
        summary: `${plural(thin.length, "page")} under ${THRESHOLDS.thinWords} words of main content, ${plural(dup.length, "page")} with duplicated main text, ${plural(merge.length, "overlapping pair")} judged for consolidation.`,
        evidence: urlEvidence([...thin.map((u) => ({ url: u, detail: "thin" })), ...dup.map((u) => ({ url: u, detail: "duplicate text" }))], "Content"),
        completeness: ctx.crawlCompleteness(),
        guidance,
        caveat: "Word count is a rough proxy; short pages can fully satisfy intent. Product and collection pages use separate checks.",
        links: [LINK.seo, LINK.recs],
      };
    },
  },
  {
    id: "seo.content.topic_clusters",
    section: "seo_content",
    label: "Topic clusters around pillar pages",
    tier: "A",
    evaluate(ctx) {
      const p = ctx.d.pillars;
      return manualItem(
        p ? `Content pillars context document v${p.version} is defined (${plural(p.factCount, "fact")}). Confirm each pillar has a hub page linked to and from its supporting pages.` : "No content pillars context document yet. Define pillars, then confirm each has a hub page with linked supporting pages.",
        "Pick a few pillar topics, give each a hub page, and link related articles and products to and from it.",
        { evidence: p ? [{ label: `Pillars v${p.version}`, url: null, detail: p.content.slice(0, 200) }] : [], links: [LINK.overview, LINK.seo] },
      );
    },
  },
  {
    id: "seo.content.feature_use_case_pages",
    section: "seo_content",
    label: "Pages for each feature and use case",
    tier: "A",
    evaluate: (ctx) => useCasePages(ctx),
  },
  {
    id: "seo.content.comparison_pages",
    section: "seo_content",
    label: "Comparison and alternatives pages",
    tier: "A",
    evaluate(ctx) {
      const guidance = "Publish fair, factual comparison or alternatives pages for real buyer questions; cite sources and never misstate a competitor.";
      if (!ctx.hasCrawl) return noCrawl(ctx, guidance, "heuristic");
      const pages = ctx.analyzable().filter((s) => COMPARISON_PATTERN.test(titleAndPath(s.title, s.url)));
      return {
        status: pages.length ? "met" : "not_met",
        method: "heuristic",
        summary: `${plural(pages.length, "crawled page")} look like comparison or alternatives pages ("vs", "compare", "alternatives" in the title or URL).`,
        evidence: urlEvidence(pages.map((s) => ({ url: s.url, detail: s.title })), "Comparison page"),
        completeness: ctx.crawlCompleteness(),
        guidance,
        caveat: "Heuristic title/URL match within crawl coverage; it does not judge quality or fairness.",
        links: [LINK.seo, LINK.competitors],
      };
    },
  },
  {
    id: "seo.content.listicles",
    section: "seo_content",
    label: "The best listicles in your category",
    tier: "A",
    evaluate(ctx) {
      const guidance = "Where it genuinely helps buyers, publish a 'best X' guide with clear criteria, disclosed affiliation, and fair treatment of alternatives.";
      if (!ctx.hasCrawl) return noCrawl(ctx, guidance, "heuristic");
      const pages = ctx.analyzable().filter((s) => BESTOF_PATTERN.test(titleAndPath(s.title, s.url)));
      return {
        status: pages.length ? "met" : "not_met",
        method: "heuristic",
        summary: `${plural(pages.length, "crawled page")} look like 'best of' or 'top N' listicles.`,
        evidence: urlEvidence(pages.map((s) => ({ url: s.url, detail: s.title })), "Listicle"),
        completeness: ctx.crawlCompleteness(),
        guidance,
        caveat: "Heuristic title/URL match within crawl coverage. Self-ranking listicles should disclose that you are one of the options.",
        links: [LINK.seo],
      };
    },
  },
  {
    id: "seo.content.author_eeat",
    section: "seo_content",
    label: "Author bio and E-E-A-T signals",
    tier: "A",
    evaluate: (ctx) =>
      articleAttribute(
        ctx,
        "author",
        "Name a real author on articles, link to a bio that states relevant experience, and add expert review where the topic needs it.",
        "Measures a declared author only; bio quality and expertise are not assessed. Never invent authors or credentials.",
      ),
  },
  {
    id: "seo.content.date_modified",
    section: "seo_content",
    label: "Update dateModified on refresh",
    tier: "S",
    evaluate: (ctx) =>
      articleAttribute(
        ctx,
        "updated",
        "When you materially update an article, update dateModified in structured data and the visible 'last updated' date. Do not bump dates without real changes.",
        "Checks that a modified date is declared (meta or JSON-LD), not that it changes on each refresh.",
      ),
  },
];

/** Shared by SEO "Pages for each feature and use case" and GEO "A page for every use case". */
export function useCasePages(ctx: Signals): ItemResult {
  const queries = [...new Set(ctx.d.geo.searchQueries)];
  const gscQueries = new Set(ctx.qpCurrent().map((r) => r.query!.toLowerCase().replace(/\s+/g, " ").trim()));
  const noMatch = ctx.hasGsc ? queries.filter((q) => !gscQueries.has(q.toLowerCase().replace(/\s+/g, " ").trim())) : [];
  const summary = queries.length
    ? ctx.hasGsc
      ? `AI engines issued ${plural(queries.length, "distinct search query", "distinct search queries")} for your prompts; ${noMatch.length} have no Search Console rows for your site (possible missing pages, needs human review).`
      : `AI engines issued ${plural(queries.length, "distinct search query", "distinct search queries")} for your prompts; connect Search Console to see which have no matching page.`
    : "No engine search queries captured yet (only some providers expose them).";
  return manualItem(summary, "List your features and use cases, and confirm each has a page that explains it with specifics. Review 'no matching page' engine queries on GEO results.", {
    evidence: noMatch.slice(0, 5).map((q) => ({ label: "Engine query without GSC rows", url: null, detail: q })),
    completeness: ctx.geoCompleteness(),
    caveat: "Engine search queries are captured only where the provider exposes them; a query without GSC rows is a content hypothesis, not a verified gap.",
    links: [LINK.geoResults, LINK.overview],
  });
}

// ------------------------------------------------------------------ Links
const linkItems: ItemDef[] = [
  {
    id: "seo.links.brand_mentions",
    section: "links",
    label: "Turn brand mentions into backlinks",
    tier: "C",
    evaluate: () =>
      notConnected(
        "Finding unlinked brand mentions needs backlink/mention data, which is not connected.",
        "Search for pages that name your brand without linking and ask the author, politely and manually, to add a link where it helps readers. Never automate outreach.",
      ),
  },
  {
    id: "seo.links.backlink_gap",
    section: "links",
    label: "Backlink gap: who links to competitors",
    tier: "C",
    evaluate: () =>
      notConnected(
        "A backlink gap needs backlink data for your site and competitors, which is not connected.",
        "Use a backlink tool to see which relevant sites link to competitors but not to you; pursue only genuine, relevant placements.",
        { links: [LINK.integrations, LINK.competitors] },
      ),
  },
  {
    id: "seo.links.best_x_lists",
    section: "links",
    label: "Get into other sites' \"best X\" lists",
    tier: "S",
    evaluate: (ctx) =>
      mentions(
        ctx,
        "listicle",
        "Review the roundups AI answers cite for your prompts and, where you genuinely fit, contact the editor with accurate product facts. Never pay for undisclosed placement or supply fabricated reviews.",
        "These are listicles AI answers cite; search rankings of these pages need SERP data, which is not connected.",
      ),
  },
  {
    id: "seo.links.reddit_threads",
    section: "links",
    label: "Show up in Reddit threads that rank",
    tier: null,
    evaluate: (ctx) =>
      mentions(
        ctx,
        "forum",
        "Participate genuinely in relevant threads with your real identity and disclosed affiliation; answer the question asked. Never post from fake accounts or automate posting.",
        "\"Threads that rank\" needs SERP data, which is not connected; AI-cited threads are shown instead.",
      ),
  },
  {
    id: "seo.links.google_business_profile",
    section: "links",
    label: "Google Business Profile (local businesses)",
    tier: "S",
    evaluate(ctx) {
      if (ctx.d.project.siteType !== "local") {
        return {
          status: "not_applicable",
          method: "manual",
          summary: `Applies to local businesses; this project's site type is ${ctx.d.project.siteType}.`,
          guidance: "If you serve customers at a physical location or service area, change the site type to local in project settings.",
          links: [],
        };
      }
      return manualItem(
        "Google Business Profile data is not connected; confirm the profile yourself.",
        "Claim and verify your Google Business Profile, keep name, address, phone, hours, and categories consistent with your site, and respond to genuine reviews.",
        { caveat: "Never solicit fake reviews or incentivize reviews against Google's policies." },
      );
    },
  },
];

export const SEO_ITEMS: readonly ItemDef[] = [...technical, ...onPage, ...quickWins, ...content, ...linkItems];
