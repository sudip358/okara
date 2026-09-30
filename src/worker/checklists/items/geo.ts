/**
 * [A21] GEO readiness checklist (sections: Access, Content, Structure, Mentions, Trust, Tracking).
 * GEO items carry no reference tier. Mentions items are manual-action lists built from the sources AI
 * answers already cite; the app never posts, reviews, or contacts anyone on the user's behalf.
 */
import { BESTOF_PATTERN, COMPARISON_PATTERN, HOWTO_PATTERN, isQuestionHeading, plural, titleAndPath } from "../text";
import { LINK, type ItemDef, manualItem, noCrawl, notConnected, ratioStatus, urlEvidence } from "./common";
import { useCasePages } from "./seo";
import {
  aiCrawlerAccess,
  articleAttribute,
  jsRendered,
  keyPageLinks,
  loginWalls,
  mentions,
  noindexCanonical,
  publicPricing,
  schemaByType,
  sitemap,
  stalePages,
} from "./shared";

const API_SAMPLED = "API-sampled here: answers come from provider APIs (labelled with provider and model), not the consumer ChatGPT, Claude, or Gemini apps; consumer-app answers enter only as labelled manual imports.";

// ------------------------------------------------------------------ Access
const access: ItemDef[] = [
  { id: "geo.access.ai_search_bots_allowed", section: "access", label: "Allow AI search bots in robots.txt", tier: null, evaluate: aiCrawlerAccess },
  {
    id: "geo.access.cdn_not_blocking",
    section: "access",
    label: "Check your CDN isn't blocking them",
    tier: null,
    evaluate: () =>
      manualItem(
        "Cannot be measured from here: CDN/WAF rules decide per request, and this app never crawls with another company's bot user-agent.",
        "Review your CDN/WAF bot settings (for example Cloudflare's AI crawler controls) and server logs for 403/challenge responses to the AI answer/search crawlers you allowed in robots.txt.",
        {
          caveat: "Cloudflare and other WAF bot blocking overrides robots.txt: a crawler allowed in robots.txt can still be refused at the edge.",
          links: [LINK.robots],
        },
      ),
  },
  { id: "geo.access.sitemap_indexnow", section: "access", label: "Submit your sitemap and use IndexNow", tier: null, evaluate: (ctx) => sitemap(ctx, "geo") },
  { id: "geo.access.noindex_canonical", section: "access", label: "Fix noindex and canonical issues", tier: null, evaluate: noindexCanonical },
  { id: "geo.access.key_text_in_html", section: "access", label: "Key text in HTML, not JS or images", tier: null, evaluate: (ctx) => jsRendered(ctx, "geo") },
  { id: "geo.access.no_login_walls", section: "access", label: "No login walls on key pages", tier: null, evaluate: loginWalls },
];

// ------------------------------------------------------------------ Content
const content: ItemDef[] = [
  {
    id: "geo.content.original_research",
    section: "content",
    label: "Original research and data",
    tier: null,
    evaluate: () =>
      manualItem(
        "Originality cannot be measured automatically.",
        "Publish data only you have (usage statistics, test results, surveys) with the method explained. Never invent studies, statistics, or awards.",
      ),
  },
  {
    id: "geo.content.first_hand_experience",
    section: "content",
    label: "First-hand experience and opinions",
    tier: null,
    evaluate: () =>
      manualItem(
        "First-hand experience cannot be measured automatically.",
        "Show real use: what you tested, what went wrong, photos you took, and clear opinions with reasons. Never fabricate experiences or testimonials.",
      ),
  },
  {
    id: "geo.content.howto_bestof_comparison",
    section: "content",
    label: "How-to, best-of and comparison pages",
    tier: null,
    evaluate(ctx) {
      const guidance = "Cover the formats buyers ask AI about: how-to guides, 'best X for Y' roundups with clear criteria, and fair comparisons.";
      if (!ctx.hasCrawl) return noCrawl(ctx, guidance, "heuristic");
      const pages = ctx.analyzable();
      const kinds = [
        { name: "how-to", re: HOWTO_PATTERN },
        { name: "best-of", re: BESTOF_PATTERN },
        { name: "comparison", re: COMPARISON_PATTERN },
      ].map((k) => ({ ...k, pages: pages.filter((s) => k.re.test(titleAndPath(s.title, s.url))) }));
      const present = kinds.filter((k) => k.pages.length > 0);
      return {
        status: present.length === 3 ? "met" : present.length > 0 ? "partial" : "not_met",
        method: "heuristic",
        summary: `${kinds.map((k) => `${k.name}: ${k.pages.length}`).join(", ")} (by title or URL among ${plural(pages.length, "crawled page")}).`,
        evidence: urlEvidence(kinds.flatMap((k) => k.pages.slice(0, 2).map((s) => ({ url: s.url, detail: `${k.name}: ${s.title ?? ""}` }))), "Format"),
        completeness: ctx.crawlCompleteness(),
        guidance,
        caveat: "Heuristic title/URL match within crawl coverage; it does not judge whether a page answers the question well.",
        links: [LINK.seo],
      };
    },
  },
  { id: "geo.content.use_case_pages", section: "content", label: "A page for every use case", tier: null, evaluate: useCasePages },
  {
    id: "geo.content.update_stats",
    section: "content",
    label: "Update outdated stats and examples",
    tier: null,
    evaluate: (ctx) => stalePages(ctx, "Review pages not updated in the last 12 months: refresh statistics, prices, screenshots, and examples, and update the modified date when you do."),
  },
  {
    id: "geo.content.cited_pages_gaps",
    section: "content",
    label: "Add what cited pages are missing",
    tier: null,
    evaluate(ctx) {
      const guidance = "Open the pages cited instead of you, compare observable attributes (direct answer, author, dates, tables, sources) with your closest page, and add what is genuinely missing.";
      if (!ctx.hasGeo || ctx.validObs().length === 0) {
        return { status: "unknown", method: "measured", summary: "No valid GEO observations yet.", completeness: ctx.geoCompleteness(), guidance, links: [LINK.geoPrompts, LINK.geoResults] };
      }
      const valid = new Set(ctx.validObs().map((o) => o.id));
      const disp = ctx.d.geo.displacements.filter((d) => valid.has(d.observationId));
      const answers = new Set(disp.map((d) => d.observationId));
      const byUrl = new Map<string, { url: string; entity: string; sourceType: string; count: number }>();
      for (const d of disp) {
        if (!d.url) continue;
        const e = byUrl.get(d.url) ?? { url: d.url, entity: d.entity, sourceType: d.sourceType, count: 0 };
        e.count++;
        byUrl.set(d.url, e);
      }
      const top = [...byUrl.values()].sort((a, b) => b.count - a.count);
      return {
        status: answers.size ? "partial" : "met",
        method: "measured",
        summary: `${answers.size} of ${ctx.validObs().length} valid answers named or cited another entity while leaving you out ("cited instead"), via ${plural(top.length, "distinct URL")}.`,
        evidence: top.slice(0, 5).map((d) => ({ label: `${d.entity} via ${d.sourceType.replace(/_/g, " ")}`, url: d.url, detail: `in ${plural(d.count, "answer")}` })),
        completeness: ctx.geoCompleteness(),
        guidance,
        caveat: `Cited pages are not fetched automatically; the side-by-side comparison fetches one URL only after you approve it. ${API_SAMPLED}`,
        links: [LINK.geoResults, LINK.competitors],
      };
    },
  },
];

// ------------------------------------------------------------------ Structure
const structure: ItemDef[] = [
  {
    id: "geo.structure.question_headings",
    section: "structure",
    label: "Question H2s, answer right below",
    tier: null,
    evaluate(ctx) {
      const guidance = "Phrase key subheadings as the questions buyers ask and put a direct one- or two-sentence answer immediately below each.";
      if (!ctx.hasCrawl) return noCrawl(ctx, guidance, "heuristic");
      const contentPages = ctx.analyzable().filter((s) => s.pageType === "article" || s.pageType === "landing" || s.pageType === "other");
      const pages = contentPages.length ? contentPages : ctx.analyzable();
      const withQ = pages.filter((s) => s.headings.some((h) => (h.level === 2 || h.level === 3) && isQuestionHeading(h.text)));
      const share = pages.length ? withQ.length / pages.length : 0;
      return {
        status: pages.length === 0 ? "unknown" : withQ.length === 0 ? "not_met" : share >= 0.5 ? "met" : "partial",
        method: "heuristic",
        summary: `${withQ.length} of ${pages.length} ${contentPages.length ? "content pages (articles, landing, other)" : "pages"} have at least one question-style H2/H3.`,
        evidence: urlEvidence(pages.filter((s) => !withQ.includes(s)).map((s) => s.url), "No question headings"),
        completeness: ctx.crawlCompleteness(),
        guidance,
        caveat: "Heuristic: a heading ending in '?' or starting with how/what/why/which/can/does/is. Whether the answer sits right below is not verified (only headings and an excerpt are stored). Met at 50% of pages or more.",
        links: [LINK.seo],
      };
    },
  },
  {
    id: "geo.structure.follow_up_questions",
    section: "structure",
    label: "Answer the follow-up questions",
    tier: null,
    evaluate: () =>
      manualItem(
        "Follow-up coverage cannot be measured automatically.",
        "After the main answer, cover the next questions buyers ask (price, compatibility, setup, alternatives), using only facts you can support.",
        { links: [LINK.geoResults] },
      ),
  },
  {
    id: "geo.structure.self_contained_sections",
    section: "structure",
    label: "Each section makes sense on its own",
    tier: null,
    evaluate: () =>
      manualItem(
        "Section self-containment cannot be measured automatically.",
        "Write each section so it can be quoted alone: name the subject instead of 'it' or 'this', and restate the key fact.",
      ),
  },
  {
    id: "geo.structure.comparison_tables",
    section: "structure",
    label: "Tables for comparisons",
    tier: null,
    evaluate(ctx) {
      const guidance = "Put comparisons and specifications in real HTML tables with clear column headings.";
      if (!ctx.hasCrawl) return noCrawl(ctx, guidance);
      const all = ctx.analyzable();
      const comparisons = all.filter((s) => COMPARISON_PATTERN.test(titleAndPath(s.title, s.url)) || BESTOF_PATTERN.test(titleAndPath(s.title, s.url)));
      const withTables = all.filter((s) => (s.tableCount ?? 0) > 0);
      const missing = comparisons.filter((s) => (s.tableCount ?? 0) === 0);
      return {
        status: comparisons.length === 0 ? "unknown" : ratioStatus(missing.length, comparisons.length),
        method: "measured",
        summary:
          comparisons.length === 0
            ? `No comparison or 'best of' pages found by title/URL; ${plural(withTables.length, "crawled page")} contain HTML tables.`
            : `${comparisons.length - missing.length} of ${comparisons.length} comparison or 'best of' pages contain an HTML table.`,
        evidence: urlEvidence(missing.map((s) => s.url), "No table"),
        completeness: ctx.crawlCompleteness(),
        guidance,
        caveat: "Comparison pages are identified by title/URL words (vs, compare, alternatives, best, top N); tables rendered only by JavaScript are not seen.",
        links: [LINK.seo],
      };
    },
  },
  { id: "geo.structure.internal_links", section: "structure", label: "Internal links to key pages", tier: null, evaluate: keyPageLinks },
  { id: "geo.structure.schema_markup", section: "structure", label: "Schema markup where it fits", tier: null, evaluate: (ctx) => schemaByType(ctx, "geo") },
];

// ------------------------------------------------------------------ Mentions
const NO_AUTOMATION = "This is a manual-action list: the app never posts, reviews, or contacts anyone for you.";

const mentionItems: ItemDef[] = [
  {
    id: "geo.mentions.reddit_threads",
    section: "mentions",
    label: "Show up in Reddit threads",
    tier: null,
    evaluate: (ctx) =>
      mentions(
        ctx,
        "forum",
        `Join the cited threads only where you can genuinely help, with your real identity and disclosed affiliation. ${NO_AUTOMATION}`,
      ),
  },
  {
    id: "geo.mentions.listicles",
    section: "mentions",
    label: "Get into listicles that rank",
    tier: null,
    evaluate: (ctx) =>
      mentions(
        ctx,
        "listicle",
        `Where you genuinely fit, send the editors of these roundups accurate product facts. Never pay for undisclosed placement. ${NO_AUTOMATION}`,
        "Shows listicles AI answers cite; search rankings of these pages need SERP data, which is not connected.",
      ),
  },
  {
    id: "geo.mentions.cited_pages",
    section: "mentions",
    label: "Get mentioned on pages AI already cites",
    tier: null,
    evaluate: (ctx) =>
      mentions(
        ctx,
        "thirdParty",
        `Review the third-party pages cited in answers that leave you out and pursue accurate inclusion where it is warranted (corrections, data, expert input). ${NO_AUTOMATION}`,
      ),
  },
  {
    id: "geo.mentions.review_platforms",
    section: "mentions",
    label: "Reviews on G2 and Capterra",
    tier: null,
    evaluate(ctx) {
      const ecommerce = ctx.d.project.siteType === "ecommerce";
      const r = mentions(
        ctx,
        ecommerce ? "reviewOrMarketplace" : "review",
        `Ask real customers to review you on the ${ecommerce ? "review platforms and marketplaces" : "review sites"} AI already cites for your category. Never write, buy, or incentivize fake reviews. ${NO_AUTOMATION}`,
        ecommerce ? "For ecommerce, relevant review platforms and marketplaces are shown instead of G2 and Capterra." : undefined,
      );
      return r;
    },
  },
  {
    id: "geo.mentions.youtube",
    section: "mentions",
    label: "YouTube videos about you",
    tier: null,
    evaluate: (ctx) =>
      mentions(ctx, "youtube", `Consider genuine videos (demos, reviews by real users, how-tos) on topics where AI cites YouTube. ${NO_AUTOMATION}`),
  },
  {
    id: "geo.mentions.news_coverage",
    section: "mentions",
    label: "Coverage on trusted news sites",
    tier: null,
    evaluate: (ctx) =>
      mentions(ctx, "publisher", `Earn coverage with real news or data (launches, research, expert commentary). Never fabricate endorsements or awards. ${NO_AUTOMATION}`),
  },
];

// ------------------------------------------------------------------ Trust
const trust: ItemDef[] = [
  {
    id: "geo.trust.author_bio",
    section: "trust",
    label: "Author name and bio on posts",
    tier: null,
    evaluate: (ctx) =>
      articleAttribute(
        ctx,
        "author",
        "Show a real author name on posts, linked to a short bio stating relevant experience.",
        "Measures a declared author (meta or JSON-LD) only; the bio itself is not checked. Never invent authors or credentials.",
      ),
  },
  {
    id: "geo.trust.last_updated",
    section: "trust",
    label: "Visible \"last updated\" date",
    tier: null,
    evaluate: (ctx) =>
      articleAttribute(
        ctx,
        "updated",
        "Show a visible 'last updated' date on posts and keep dateModified in structured data in sync; change it only for real updates.",
        "Checks the declared modified date in metadata (article:modified_time or JSON-LD dateModified); whether the date is visible on the page is not verified.",
      ),
  },
  {
    id: "geo.trust.reputable_sources",
    section: "trust",
    label: "Link to reputable sources",
    tier: null,
    evaluate: (ctx) =>
      articleAttribute(
        ctx,
        "citations",
        "Support claims with links to primary or reputable sources in the main content.",
        "Counts outbound links in the main content; whether sources are reputable is not judged.",
      ),
  },
  {
    id: "geo.trust.screenshots_quotes",
    section: "trust",
    label: "Screenshots, demos, customer quotes",
    tier: null,
    evaluate: () =>
      manualItem(
        "Cannot be measured automatically.",
        "Add real screenshots, demo videos, and customer quotes you have permission to use. Never fabricate quotes, logos, or testimonials.",
      ),
  },
  { id: "geo.trust.public_pricing", section: "trust", label: "Current pricing on a public page", tier: null, evaluate: publicPricing },
  {
    id: "geo.trust.consistent_brand_info",
    section: "trust",
    label: "Same brand and founder info everywhere",
    tier: null,
    evaluate: (ctx) =>
      manualItem(
        `Cannot be measured automatically. Brand name on file: "${ctx.d.project.brandName}".`,
        "Keep your brand name, description, founders, and key facts identical on your site, profiles, directories, and review sites; fix inconsistencies at the source.",
        { links: [LINK.overview] },
      ),
  },
];

// ------------------------------------------------------------------ Tracking
const SUGGESTED_PROMPTS = 20;

const tracking: ItemDef[] = [
  {
    id: "geo.tracking.prompt_list",
    section: "tracking",
    label: "List 20 prompts your buyers ask",
    tier: null,
    evaluate(ctx) {
      const set = ctx.d.geo.promptSet;
      const approved = set?.approved ?? 0;
      const perRun = ctx.d.geo.promptsPerRun ?? 5;
      return {
        status: approved >= SUGGESTED_PROMPTS ? "met" : approved > 0 ? "partial" : "not_met",
        method: "measured",
        summary: set
          ? `${approved} approved of ${set.total} prompts in active set v${set.version} (the reference checklist suggests ${SUGGESTED_PROMPTS}). Each run samples up to ${perRun} prompts per provider under the budget (default 5).`
          : `No prompt set yet (the reference checklist suggests ${SUGGESTED_PROMPTS}; each run samples up to ${perRun} prompts per provider by default).`,
        completeness: set ? { note: `${approved} of ${set.total} prompts approved`, covered: approved, total: set.total } : null,
        guidance: "Write the questions real buyers ask before choosing (brand-blind discovery prompts), approve them, and keep reputation prompts separate. Raise the per-run prompt limit only within your budget.",
        caveat: "More prompts mean more provider calls and cost; runs stay within project limits.",
        links: [LINK.geoPrompts, LINK.usage],
      };
    },
  },
  {
    id: "geo.tracking.rerun_engines",
    section: "tracking",
    label: "Re-run them in ChatGPT, Claude, Gemini",
    tier: null,
    evaluate(ctx) {
      const withObs = [...new Set(ctx.validObs().map((o) => o.provider))];
      const enabled = ctx.d.geo.providers.filter((p) => p.state === "ready");
      const manual = ctx.manualImports();
      const surfaces = [...new Set(manual.map((o) => o.importedSurface).filter(Boolean))];
      const status = withObs.length >= 2 ? "met" : withObs.length === 1 ? "partial" : enabled.length ? "not_met" : "not_connected";
      return {
        status,
        method: "measured",
        summary: `${plural(withObs.length, "provider")} with valid API-sampled answers (${withObs.join(", ") || "none"}); ${plural(enabled.length, "GEO provider")} enabled (${enabled.map((p) => p.label).join(", ") || "none"}); ${plural(manual.length, "labelled manual import")}${surfaces.length ? ` (${surfaces.join(", ")})` : ""}.`,
        completeness: ctx.geoCompleteness(),
        guidance: "Enable the supported GEO providers (Gemini API with Google Search grounding, Perplexity API) and run the same prompt set on a schedule. Import consumer-app answers manually if you want them, labelled as such.",
        caveat: `${API_SAMPLED} ChatGPT and Claude are not sampled by API in this app.`,
        links: [LINK.integrations, LINK.geoResults],
      };
    },
  },
  {
    id: "geo.tracking.study_cited_sections",
    section: "tracking",
    label: "Study the section that got cited",
    tier: null,
    evaluate(ctx) {
      const self = ctx.d.geo.citations.filter((c) => c.brandKey === "self");
      const byUrl = new Map<string, number>();
      for (const c of self) byUrl.set(c.url, (byUrl.get(c.url) ?? 0) + 1);
      const top = [...byUrl.entries()].sort((a, b) => b[1] - a[1]);
      return manualItem(
        ctx.hasGeo ? `Your pages were cited ${plural(self.length, "time")} across API-sampled answers (${plural(top.length, "distinct URL")}). Open them and study which section answers the prompt.` : "No GEO observations yet.",
        "For each of your cited pages (and pages cited instead of you), find the passage that answers the prompt and reuse that pattern (direct answer, specifics, sources) elsewhere.",
        {
          evidence: top.slice(0, 5).map(([url, n]) => ({ label: "Your cited page", url, detail: `cited ${plural(n, "time")}` })),
          completeness: ctx.geoCompleteness(),
          caveat: "Provider APIs return cited URLs (sometimes titles), not the exact passage used.",
          links: [LINK.geoResults],
        },
      );
    },
  },
  {
    id: "geo.tracking.citation_share",
    section: "tracking",
    label: "Track citation share vs competitors",
    tier: null,
    evaluate(ctx) {
      const comps = ctx.d.project.competitors;
      const valid = ctx.validObs();
      const grounded = valid.filter((o) => o.grounded);
      const groundedIds = new Set(grounded.map((o) => o.id));
      const cites = (key: string, isSelf: boolean) =>
        new Set(ctx.d.geo.brandObs.filter((b) => groundedIds.has(b.observationId) && b.cited && (isSelf ? b.isSelf : b.brandKey === key)).map((b) => b.observationId)).size;
      const status = comps.length === 0 ? "not_met" : valid.length === 0 ? "partial" : "met";
      const parts = grounded.length ? [`you: ${cites("self", true)}`, ...comps.map((c) => `${c.name}: ${cites(c.name, false)}`)] : [];
      return {
        status,
        method: "measured",
        summary:
          comps.length === 0
            ? "No competitors configured, so tracked-brand share cannot be computed."
            : `${plural(comps.length, "competitor")} configured; ${plural(grounded.length, "grounded answer")} sampled.${parts.length ? ` Answers citing each brand's domain: ${parts.join(", ")}.` : ""}`,
        completeness: ctx.geoCompleteness(),
        guidance: "Configure up to five competitors with their domains and aliases, then compare citation and mention rates on GEO results over matching cohorts.",
        caveat: `Tracked-brand share is restricted to the brands you configure; it is not market share. ${API_SAMPLED}`,
        links: [LINK.competitors, LINK.geoResults],
      };
    },
  },
  {
    id: "geo.tracking.ai_referrals",
    section: "tracking",
    label: "Track AI referrals and signups",
    tier: null,
    evaluate: () =>
      notConnected(
        "AI referral visits and signups need an analytics source (GA4 or similar), which is not connected. No traffic or conversion values are estimated.",
        "In your analytics tool, segment sessions referred by AI assistants and track signups or orders from them.",
      ),
  },
  {
    id: "geo.tracking.gsc_bing_reports",
    section: "tracking",
    label: "Check GSC and Bing AI reports monthly",
    tier: null,
    evaluate(ctx) {
      const g = ctx.d.gsc;
      const gsc = g.connection === "connected" ? `Search Console connected${g.sync ? `, last sync ${g.sync.syncedAt.slice(0, 10)}` : ""}` : g.sync ? `Search Console data present (${g.sync.source})` : "Search Console not connected";
      return manualItem(
        `${gsc}. Bing Webmaster Tools is not connected; review its reports yourself.`,
        "Once a month, review Search Console performance and Bing Webmaster Tools reports (including any AI-related reports they offer) and note changes.",
        {
          completeness: ctx.gscCompleteness(),
          caveat: "What each report shows about AI features is defined by Google and Microsoft; this app imports Search Console performance data only.",
          links: [LINK.integrations],
        },
      );
    },
  },
];

export const GEO_ITEMS: readonly ItemDef[] = [...access, ...content, ...structure, ...mentionItems, ...trust, ...tracking];
