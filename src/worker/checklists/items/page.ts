/**
 * [A21] Per-page on-page checklist (reference: Okara "On-page SEO checklist", 16 items in four phases).
 * Measured from the page's latest snapshot, its GSC queries, and Jev intent-fit decisions where present.
 * Originality, experience, and topic completeness stay manual or Jev-flagged ("Check this yourself").
 */
import { normalizeUrlKey } from "../../seo/rules/registry";
import type { DecisionInfo, GscRow, Snap } from "../data";
import type { Signals } from "../signals";
import { THRESHOLDS } from "../signals";
import { coverage, pct, plural, tokenSet, tokens } from "../text";
import { LINK, type ItemDef, type ItemResult, manualItem, notConnected, urlEvidence } from "./common";
import { urlIssues } from "./seo";
import { schemaCheckFor } from "./shared";

export interface PageContext {
  sig: Signals;
  page: { id: string; url: string; pageType: Snap["pageType"] };
  snap: Snap | null;
  /** Current-window GSC query rows for this page, by impressions (desc). */
  queries: GscRow[];
  intent: DecisionInfo | null;
}

const NO_SNAPSHOT: ItemResult = {
  status: "unknown",
  method: "measured",
  summary: "This page has no crawl snapshot yet.",
  guidance: "Run an SEO crawl of the verified site to measure this page.",
  links: [LINK.seo],
};

function snapCompleteness(ctx: PageContext) {
  const s = ctx.snap;
  return s ? { note: `Snapshot from ${s.fetchedAt.slice(0, 16).replace("T", " ")} UTC (compact extraction: title, meta, headings, first paragraph, 2,000-character excerpt, links).`, covered: null, total: null } : null;
}

const pageText = (s: Snap) => [s.title, ...s.h1s, ...s.headings.map((h) => h.text), s.firstParagraph, s.excerpt].filter(Boolean).join(" ");

/** Parse the page URL out of a decision candidate key such as "weak_ctr:<url>" or "striking_distance:<q>|<url>". */
export function candidateUrl(candidate: string | null): string | null {
  if (!candidate) return null;
  const rest = candidate.slice(candidate.indexOf(":") + 1);
  const part = rest.includes("|") ? rest.slice(rest.lastIndexOf("|") + 1) : rest;
  return /^https?:\/\//i.test(part) ? part : null;
}

const INTENT_WORDS: Array<{ intent: string; re: RegExp; fits: Array<Snap["pageType"]> }> = [
  { intent: "transactional", re: /\b(buy|price|prices|pricing|cheap|deal|deals|sale|order|shop|coupon|discount|for sale)\b/i, fits: ["product", "collection", "landing"] },
  { intent: "commercial investigation", re: /\b(best|top|review|reviews|vs|versus|compare|comparison|alternatives?)\b/i, fits: ["article", "landing", "collection"] },
  { intent: "informational", re: /^(how|what|why|when|where|who|which|can|does|is|are)\b|\b(guide|tips|ideas|tutorial|meaning|examples?)\b/i, fits: ["article", "landing", "other"] },
];

function runnerUp(answer: Record<string, unknown> | null): string | null {
  const probs = answer?.probabilities;
  if (!probs || typeof probs !== "object") return null;
  const sorted = Object.entries(probs as Record<string, number>).filter(([, v]) => typeof v === "number").sort((a, b) => b[1] - a[1]);
  return sorted[1]?.[0] ?? null;
}

// ------------------------------------------------------------------ Before you write
const beforeWrite: ItemDef<PageContext>[] = [
  {
    id: "page.before_write.search_intent",
    section: "before_write",
    label: "Match the search intent",
    tier: null,
    evaluate(ctx) {
      const guidance = "Make the page's format match what searchers want for its main query: a guide for how-to queries, a comparison for 'best' or 'vs' queries, a product or category page for buying queries.";
      const d = ctx.intent;
      const choice = typeof d?.answer?.choice === "string" ? d.answer.choice : null;
      if (d && d.tier !== "drop" && choice && choice !== "insufficient_context") {
        const flagged = d.tier === "flag";
        const ru = flagged ? runnerUp(d.answer) : null;
        return {
          status: choice === "fits" ? "met" : choice === "partial_fit" ? "partial" : "not_met",
          method: "heuristic",
          summary: `Jev intent-fit judgment: ${choice.replace(/_/g, " ")}${flagged ? ` (Check this yourself${ru ? `; runner-up: ${ru.replace(/_/g, " ")}` : ""})` : ""}.`,
          evidence: [{ label: "seo.intent_page_fit", url: ctx.page.url, detail: `${d.createdAt.slice(0, 10)}; tier ${d.tier ?? "n/a"}` }],
          completeness: snapCompleteness(ctx),
          guidance,
          caveat: "A Jev model judgment on title, H1, and opening text, not a measurement.",
          links: [LINK.recs],
        };
      }
      const top = ctx.queries[0]?.query ?? null;
      if (top) {
        const hit = INTENT_WORDS.find((w) => w.re.test(top));
        if (hit) {
          const fits = hit.fits.includes(ctx.page.pageType);
          return {
            status: fits ? "met" : "partial",
            method: "heuristic",
            summary: `Top GSC query "${top}" reads as ${hit.intent}; this is a ${ctx.page.pageType} page${fits ? ", which usually serves that intent" : ", which may not serve that intent (check this yourself)"}.`,
            completeness: ctx.sig.gscCompleteness(),
            guidance,
            caveat: "Keyword heuristic on the top query only; intent can be mixed. No Jev intent judgment is available for this page.",
            links: [LINK.recs],
          };
        }
      }
      return manualItem(top ? `Top GSC query "${top}" has no clear intent keywords; judge the fit yourself.` : "No Jev judgment or GSC query for this page; judge the intent fit yourself.", guidance, { completeness: snapCompleteness(ctx) });
    },
  },
  {
    id: "page.before_write.topic_coverage",
    section: "before_write",
    label: "Cover the topic fully",
    tier: null,
    evaluate(ctx) {
      const guidance = "Cover the subtopics searchers ask about for this page's queries, in sections that answer them; do not pad the page to hit a length.";
      if (!ctx.snap) return NO_SNAPSHOT;
      const qs = ctx.queries.slice(0, 10);
      if (qs.length === 0) return manualItem("No GSC queries for this page; judge topic coverage yourself.", guidance, { completeness: snapCompleteness(ctx) });
      const hay = tokenSet(pageText(ctx.snap));
      const rated = qs.map((q) => ({ q: q.query!, cov: coverage(q.query!, hay) })).filter((x): x is { q: string; cov: number } => x.cov !== null);
      const missing = rated.filter((x) => x.cov < THRESHOLDS.answerCoverage);
      return {
        status: rated.length === 0 ? "unknown" : missing.length === 0 ? "met" : missing.length * 2 <= rated.length ? "partial" : "not_met",
        method: "heuristic",
        summary: `${rated.length - missing.length} of ${rated.length} top GSC queries for this page have most of their words in its title, headings, or opening text.`,
        evidence: missing.slice(0, 5).map((x) => ({ label: "Query weakly covered", url: null, detail: `"${x.q}" (${pct(x.cov)} of its words present)` })),
        completeness: ctx.sig.gscCompleteness(),
        guidance,
        caveat: "Heuristic word overlap on the stored extract (title, headings, first 2,000 characters), not a judgment of completeness.",
        links: [LINK.recs],
      };
    },
  },
  {
    id: "page.before_write.unique_angle",
    section: "before_write",
    label: "Unique angle or original information",
    tier: null,
    evaluate: (ctx) =>
      manualItem("Originality cannot be measured automatically.", "Add something the other results do not have: your own data, tests, photos, or a clear point of view. Never invent studies or statistics.", {
        completeness: snapCompleteness(ctx),
      }),
  },
  {
    id: "page.before_write.first_hand",
    section: "before_write",
    label: "First-hand experience or evidence",
    tier: null,
    evaluate(ctx) {
      const author = ctx.snap?.author?.trim();
      return manualItem(
        author ? `A named author is declared ("${author}"); that supports, but does not show, first-hand experience.` : "No declared author; first-hand experience cannot be measured automatically.",
        "Show real use: what was tested, how, and what happened, with your own photos or results. Never fabricate experiences or testimonials.",
        { completeness: snapCompleteness(ctx) },
      );
    },
  },
];

// ------------------------------------------------------------------ While you write
const whileWrite: ItemDef<PageContext>[] = [
  {
    id: "page.while_write.answer_early",
    section: "while_write",
    label: "Answer the main question early",
    tier: null,
    evaluate(ctx) {
      const guidance = "Answer the page's main question in the first paragraph, then add detail.";
      if (!ctx.snap) return NO_SNAPSHOT;
      const top = ctx.queries[0]?.query ?? null;
      if (!top) return { status: "unknown", method: "heuristic", summary: "No GSC query for this page, so the main question is unknown.", completeness: ctx.sig.gscCompleteness(), guidance, links: [LINK.integrations] };
      const cov = coverage(top, tokenSet(ctx.snap.firstParagraph));
      const status = !ctx.snap.firstParagraph ? "not_met" : cov === null ? "unknown" : cov >= THRESHOLDS.answerCoverage ? "met" : cov > 0 ? "partial" : "not_met";
      return {
        status,
        method: "heuristic",
        summary: ctx.snap.firstParagraph ? `The first paragraph contains ${cov === null ? "n/a" : pct(cov)} of the words in the top query "${top}".` : "No first paragraph was found in the main content.",
        evidence: ctx.snap.firstParagraph ? [{ label: "First paragraph", url: null, detail: ctx.snap.firstParagraph.slice(0, 200) }] : [],
        completeness: snapCompleteness(ctx),
        guidance,
        caveat: "Heuristic word overlap (60% or more counts as met), not a judgment of answer quality. Never stuff the query into the opening.",
        links: [LINK.recs],
      };
    },
  },
  {
    id: "page.while_write.headings",
    section: "while_write",
    label: "Clear main heading + descriptive subheadings",
    tier: null,
    evaluate(ctx) {
      const guidance = "Use exactly one H1 that names the topic, and descriptive H2/H3 subheadings in order.";
      if (!ctx.snap) return NO_SNAPSHOT;
      const s = ctx.snap;
      const h1 = s.h1s.filter((h) => h.trim()).length;
      const h2 = s.headings.filter((h) => h.level === 2).length;
      let prev = 0;
      let skip: string | null = null;
      for (const h of s.headings) {
        if (prev > 0 && h.level > prev + 1) {
          skip = `h${prev} → h${h.level}`;
          break;
        }
        prev = h.level;
      }
      const issues: string[] = [];
      if (h1 !== 1) issues.push(h1 === 0 ? "no H1" : `${h1} H1s`);
      if (ctx.page.pageType === "article" && h2 < 2) issues.push(`${h2} H2 subheading${h2 === 1 ? "" : "s"} on an article`);
      if (skip) issues.push(`skipped level (${skip})`);
      return {
        status: h1 === 0 ? "not_met" : issues.length ? "partial" : "met",
        method: "measured",
        summary: `${plural(h1, "H1")}, ${plural(h2, "H2")}; ${issues.length ? issues.join("; ") : "no skipped levels"}.`,
        evidence: s.headings.slice(0, 5).map((h) => ({ label: `h${h.level}`, url: null, detail: h.text })),
        completeness: snapCompleteness(ctx),
        guidance,
        caveat: "Headings are read from server-delivered HTML (first 60). Structure is an accessibility and clarity signal, not a ranking guarantee.",
        links: [LINK.seo],
      };
    },
  },
  {
    id: "page.while_write.terms_entities",
    section: "while_write",
    label: "Relevant terms and entities naturally",
    tier: null,
    evaluate(ctx) {
      const guidance = "Use the specific names, attributes, and terms searchers use (products, materials, standards, places) where they fit naturally. Do not target a keyword density.";
      if (!ctx.snap) return NO_SNAPSHOT;
      const qs = ctx.queries.slice(0, 10);
      if (qs.length === 0) return manualItem("No GSC queries for this page; check the terms yourself.", guidance, { completeness: snapCompleteness(ctx) });
      const terms = [...new Set(qs.flatMap((q) => tokens(q.query)))];
      const hay = tokenSet(pageText(ctx.snap));
      const present = terms.filter((t) => hay.has(t));
      const share = terms.length ? present.length / terms.length : 0;
      const absent = terms.filter((t) => !hay.has(t));
      return {
        status: terms.length === 0 ? "unknown" : share >= 0.6 ? "met" : share >= 0.3 ? "partial" : "not_met",
        method: "heuristic",
        summary: `${present.length} of ${terms.length} distinct words from this page's top GSC queries appear in its title, headings, or opening text.`,
        evidence: absent.length ? [{ label: "Query words not found", url: null, detail: absent.slice(0, 15).join(", ") }] : [],
        completeness: ctx.sig.gscCompleteness(),
        guidance,
        caveat: "Heuristic overlap on the stored extract only. Never add terms unnaturally or repeat them for density; relevance matters more than frequency.",
        links: [LINK.recs],
      };
    },
  },
  {
    id: "page.while_write.crawlable_text",
    section: "while_write",
    label: "Important information in crawlable text",
    tier: null,
    evaluate(ctx) {
      const guidance = "Put key facts (specs, prices, answers) in the HTML as text, not only in images, tabs loaded by JavaScript, or PDFs.";
      if (!ctx.snap) return NO_SNAPSHOT;
      const s = ctx.snap;
      if (s.skippedReason === "js_rendered") {
        return { status: "not_met", method: "measured", summary: `The served HTML has ${s.wordCount ?? 0} words and a JavaScript app root (skipped as js_rendered).`, completeness: snapCompleteness(ctx), guidance, caveat: "This app does not execute JavaScript.", links: [LINK.seo] };
      }
      if (s.skippedReason || s.statusCode === null || s.statusCode >= 300) {
        return { status: "unknown", method: "measured", summary: `The page was not analyzed (${s.skippedReason ?? `HTTP ${s.statusCode ?? "error"}`}).`, completeness: snapCompleteness(ctx), guidance, links: [LINK.seo] };
      }
      const min = ["product", "collection", "home"].includes(ctx.page.pageType) ? 50 : THRESHOLDS.thinWords;
      const words = s.wordCount ?? 0;
      return {
        status: words >= min ? "met" : "partial",
        method: "measured",
        summary: `${words.toLocaleString("en-US")} words of main-content text in the served HTML (guideline for this page type: at least ${min}).`,
        completeness: snapCompleteness(ctx),
        guidance,
        caveat: "Word count is a rough proxy; short pages can fully satisfy intent. Text inside images is not detected.",
        links: [LINK.seo],
      };
    },
  },
];

// ------------------------------------------------------------------ The details
const details: ItemDef<PageContext>[] = [
  {
    id: "page.details.title",
    section: "details",
    label: "Clear descriptive title",
    tier: null,
    evaluate(ctx) {
      const guidance = "Write a unique title that names the page's topic in plain words, leading with what the searcher looks for.";
      if (!ctx.snap) return NO_SNAPSHOT;
      const t = ctx.snap.title?.trim() ?? "";
      if (!t) return { status: "not_met", method: "measured", summary: "The page has no title.", completeness: snapCompleteness(ctx), guidance, links: [LINK.seo] };
      const issues: string[] = [];
      const dup = ctx.sig.findingUrls(["SEO-TITLE-DUPLICATE"]).some((u) => normalizeUrlKey(u) === normalizeUrlKey(ctx.page.url));
      if (dup) issues.push("shared with another crawled page");
      if (t.length < 30) issues.push(`${t.length} characters (short)`);
      if (t.length > 60) issues.push(`${t.length} characters (may be truncated)`);
      const top = ctx.queries[0]?.query ?? null;
      if (top && (coverage(top, tokenSet(t)) ?? 1) === 0) issues.push(`no word from the top query "${top}"`);
      return {
        status: issues.length ? "partial" : "met",
        method: "measured",
        summary: `"${t}" (${t.length} characters)${issues.length ? `: ${issues.join("; ")}` : ""}.`,
        completeness: snapCompleteness(ctx),
        guidance,
        caveat: "Length is a guideline (30–60 characters): Google truncates titles by pixel width and may rewrite them.",
        links: [LINK.seo, LINK.recs],
      };
    },
  },
  {
    id: "page.details.meta_description",
    section: "details",
    label: "Meta description that earns the click",
    tier: null,
    evaluate(ctx) {
      const guidance = "Summarize what the page offers and why it is worth clicking, in plain language that matches the query; keep claims to facts on the page.";
      if (!ctx.snap) return NO_SNAPSHOT;
      const m = ctx.snap.metaDescription?.trim() ?? "";
      if (!m) return { status: "not_met", method: "measured", summary: "The page has no meta description.", completeness: snapCompleteness(ctx), guidance, links: [LINK.seo] };
      const issues: string[] = [];
      const key = normalizeUrlKey(ctx.page.url);
      if (ctx.sig.findingUrls(["SEO-META-DESC-DUPLICATE"]).some((u) => normalizeUrlKey(u) === key)) issues.push("shared with another crawled page");
      if (m.length < 70) issues.push(`${m.length} characters (short)`);
      if (m.length > 160) issues.push(`${m.length} characters (may be truncated)`);
      const weak = ctx.sig.hasGsc ? ctx.sig.weakCtr().filter((r) => normalizeUrlKey(r.page) === key) : [];
      if (weak.length) issues.push(`${plural(weak.length, "query", "queries")} with CTR below 0.8x the position-bucket median`);
      return {
        status: issues.length ? "partial" : "met",
        method: "measured",
        summary: `${m.length}-character meta description${issues.length ? `: ${issues.join("; ")}` : ""}.`,
        evidence: [
          { label: "Meta description", url: null, detail: m.slice(0, 200) },
          ...weak.slice(0, 4).map((r) => ({ label: "Weak CTR", url: null, detail: `"${r.query}": ${pct(r.ctr)} at position ${r.position.toFixed(1)} (median ${pct(r.median)})` })),
        ],
        completeness: ctx.sig.hasGsc ? ctx.sig.gscCompleteness() : snapCompleteness(ctx),
        guidance,
        caveat: "Length is a guideline (about 70–160 characters). Search engines may show their own snippet; CTR also depends on position and SERP features.",
        links: [LINK.seo, LINK.recs],
      };
    },
  },
  {
    id: "page.details.url",
    section: "details",
    label: "Short descriptive URL",
    tier: null,
    evaluate(ctx) {
      const issues = urlIssues(ctx.page.url);
      return {
        status: issues.length === 0 ? "met" : issues.length === 1 ? "partial" : "not_met",
        method: "heuristic",
        summary: issues.length ? `URL issues: ${issues.join(", ")}.` : "The URL is short, lowercase, and free of parameters and ID-like segments.",
        evidence: urlEvidence([ctx.page.url], "URL"),
        completeness: null,
        guidance: "Prefer a short, lowercase, hyphenated path that describes the page. If you change a live URL, redirect the old one.",
        caveat: "Heuristic pattern checks; platform URL formats may be fine as they are.",
        links: [],
      };
    },
  },
  {
    id: "page.details.alt_text",
    section: "details",
    label: "Descriptive alt text on informative images",
    tier: null,
    evaluate(ctx) {
      const guidance = "Describe informative images in their alt text; use alt=\"\" for purely decorative ones.";
      if (!ctx.snap) return NO_SNAPSHOT;
      const s = ctx.snap;
      if (s.imagesTotal === null) return { status: "unknown", method: "measured", summary: "Image alt attributes were not extracted for this snapshot; re-crawl to measure them.", completeness: snapCompleteness(ctx), guidance, links: [LINK.seo] };
      if (s.imagesTotal === 0) return { status: "not_applicable", method: "measured", summary: "No <img> elements in the served HTML.", completeness: snapCompleteness(ctx), guidance, links: [] };
      const missing = s.imagesMissingAlt ?? 0;
      return {
        status: missing === 0 ? "met" : missing >= s.imagesTotal ? "not_met" : "partial",
        method: "measured",
        summary: `${missing} of ${s.imagesTotal} images have no alt attribute.`,
        completeness: snapCompleteness(ctx),
        guidance,
        caveat: "Counts missing alt attributes only; whether the text is descriptive is not judged. Decorative images (role=presentation, aria-hidden) are excluded.",
        links: [LINK.seo],
      };
    },
  },
];

// ------------------------------------------------------------------ Publish and check
const publish: ItemDef<PageContext>[] = [
  {
    id: "page.publish_check.internal_links",
    section: "publish_check",
    label: "Internal links with descriptive anchor text",
    tier: null,
    evaluate(ctx) {
      const guidance = "Link to this page from related pages, and use anchor text that says what the target is (not 'click here' or 'read more').";
      if (!ctx.snap) return NO_SNAPSHOT;
      const inlinks = ctx.sig.inlinkCount(ctx.page.url);
      const sources = [...(ctx.sig.inlinks().get(normalizeUrlKey(ctx.page.url)) ?? [])];
      const generic = ctx.snap.genericAnchors;
      const isHome = ctx.page.pageType === "home";
      const status = !isHome && inlinks === 0 ? "not_met" : (!isHome && inlinks < THRESHOLDS.keyPageMinInlinks) || (generic?.length ?? 0) > 0 ? "partial" : "met";
      return {
        status,
        method: "measured",
        summary: `${plural(inlinks, "crawled page")} link here; ${generic === null ? "anchor text was not extracted for this snapshot" : `${plural(generic.length, "outgoing internal link")} on this page use generic anchor text`}.`,
        evidence: [
          ...(generic ?? []).slice(0, 3).map((g) => ({ label: `Generic anchor "${g.text}"`, url: g.href, detail: null })),
          ...sources.slice(0, 2).map((u) => ({ label: "Linked from", url: u, detail: null })),
        ],
        completeness: ctx.sig.crawlCompleteness("inlinks counted within crawl coverage only"),
        guidance,
        caveat: "Inlinks are counted from crawled pages only; generic-anchor detection covers this page's own outgoing internal links.",
        links: [LINK.seo, LINK.recs],
      };
    },
  },
  {
    id: "page.publish_check.sources",
    section: "publish_check",
    label: "Credible sources where claims need support",
    tier: null,
    evaluate(ctx) {
      const guidance = "Link claims that need support (statistics, standards, safety, comparisons) to primary or reputable sources.";
      if (ctx.page.pageType !== "article") return manualItem("Not measured for non-article pages; check claims that need support yourself.", guidance, { completeness: snapCompleteness(ctx) });
      if (!ctx.snap) return NO_SNAPSHOT;
      const n = ctx.snap.outboundCitations ?? 0;
      return {
        status: n >= 1 ? "met" : "not_met",
        method: "measured",
        summary: `${plural(n, "outbound link")} in the main content.`,
        completeness: snapCompleteness(ctx),
        guidance,
        caveat: "Counts outbound links outside navigation, header, and footer; whether sources are credible is not judged.",
        links: [LINK.seo],
      };
    },
  },
  {
    id: "page.publish_check.indexability",
    section: "publish_check",
    label: "Crawlability, indexability + canonical",
    tier: null,
    evaluate(ctx) {
      const guidance = "Return 200, allow crawling in robots.txt, avoid noindex on pages you want found, and use a self-referencing canonical (or a valid one to the preferred URL).";
      if (!ctx.snap) return NO_SNAPSHOT;
      const s = ctx.snap;
      const key = normalizeUrlKey(ctx.page.url);
      const problems: string[] = [];
      const warnings: string[] = [];
      if (s.skippedReason === "robots_disallowed") problems.push("disallowed by robots.txt for this crawler");
      else if (s.skippedReason && s.skippedReason !== "js_rendered") problems.push(`not fetched (${s.skippedReason})`);
      if (s.statusCode !== null && (s.statusCode < 200 || s.statusCode >= 300)) problems.push(`HTTP ${s.statusCode}${s.finalUrl && normalizeUrlKey(s.finalUrl) !== key ? ` → ${s.finalUrl}` : ""}`);
      if (/\b(noindex|none)\b/.test(s.robotsMeta ?? "")) problems.push(`noindex ("${s.robotsMeta}")`);
      if (!s.canonical) {
        if (!problems.length && s.statusCode !== null && s.statusCode < 300) warnings.push("no canonical tag");
      } else if (normalizeUrlKey(s.canonical) !== key) {
        const offHost = (() => {
          try {
            return new URL(s.canonical!).hostname.toLowerCase() !== new URL(ctx.page.url).hostname.toLowerCase();
          } catch {
            return true;
          }
        })();
        const target = ctx.sig.byKey().get(normalizeUrlKey(s.canonical));
        const targetBad = !!target && ((target.statusCode !== null && (target.statusCode < 200 || target.statusCode >= 300)) || /\b(noindex|none)\b/.test(target.robotsMeta ?? ""));
        if (offHost) problems.push(`canonical points to another host (${s.canonical})`);
        else if (targetBad) problems.push(`canonical target ${s.canonical} is an error, redirect, or noindex`);
        else warnings.push(`canonicalized to ${s.canonical} (fine if intentional)`);
      }
      return {
        status: problems.length ? "not_met" : warnings.length ? "partial" : "met",
        method: "measured",
        summary: problems.length || warnings.length ? `${[...problems, ...warnings].join("; ")}.` : "HTTP 200, crawlable, no noindex, self-referencing canonical.",
        completeness: snapCompleteness(ctx),
        guidance,
        caveat: "Crawlability is not index status; index coverage needs Search Console URL Inspection, which is not imported.",
        links: [LINK.seo],
      };
    },
  },
  {
    id: "page.publish_check.structured_data_ux",
    section: "publish_check",
    label: "Structured data, mobile UX + Core Web Vitals",
    tier: null,
    evaluate(ctx) {
      const guidance = "Add structured data that matches the page type, use a responsive viewport, and check Core Web Vitals in Search Console or PageSpeed Insights.";
      if (!ctx.snap) return NO_SNAPSHOT;
      const s = ctx.snap;
      const schema = schemaCheckFor(s, ctx.sig.d.project.siteType);
      const viewportKnown = s.imagesTotal !== null;
      const responsive = /width\s*=\s*device-width/i.test(s.viewport ?? "");
      const parts = [
        schema ? (schema.ok ? `structured data OK (${schema.expected})` : `structured data: ${schema.problem}`) : `no page-type schema expectation (types present: ${s.jsonLdTypes.join(", ") || "none"})`,
        viewportKnown ? (responsive ? "responsive viewport declared" : "no responsive viewport meta") : "viewport not extracted (older snapshot)",
        "Core Web Vitals: not connected",
      ];
      const bad = (schema && !schema.ok) || (viewportKnown && !responsive);
      if (!schema && !viewportKnown) {
        return notConnected(`${parts.join("; ")}.`, guidance, { completeness: snapCompleteness(ctx), caveat: "Core Web Vitals need field data, which is not connected." });
      }
      return {
        status: bad ? "not_met" : "partial",
        method: "measured",
        summary: `${parts.join("; ")}.`,
        completeness: snapCompleteness(ctx),
        guidance,
        caveat: "At most partial: Core Web Vitals need field data, which is not connected. The viewport check is a heuristic; structured data never guarantees rich results.",
        links: [LINK.seo, LINK.integrations],
      };
    },
  },
];

export const PAGE_ITEMS: readonly ItemDef<PageContext>[] = [...beforeWrite, ...whileWrite, ...details, ...publish];
