/**
 * [A21] SEO agent: readiness-checklist gaps -> 'checklist' candidates, plus the robots.txt advisor
 * [A19] when a search-engine crawler is blocked.
 *
 * Sources: checklists/bridge.ts gap descriptors for the SEO checklist and the per-page checklist of the
 * top pages. Only items listed in SEO_ROUTES become candidates; everything else stays on the checklist:
 *   - items already produced by rule-based candidates are excluded by the bridge (COVERED_BY_RULES);
 *   - page items with a project-level equivalent use the project-level gap (it already lists the page);
 *   - shared signals go to the agent they fit: author / dateModified / outbound sources are GEO trust
 *     proposals, mention lists are the GEO mentions proposal; sitemap, JS-only text, schema, and content
 *     formats (comparison pages, listicles) are SEO;
 *   - setup and tracking items (GSC/GA4) are not recommendations.
 *
 * Scope [A9]: template when >= 3 affected pages share a templated page type (product, collection,
 * article); page when one page is affected; otherwise site (one candidate per group).
 * Severity (documented mapping, feeds the existing priority formula): measured + not_met -> moderate;
 * partial or heuristic -> minor; a blocked search-engine crawler -> critical.
 * Priority: the existing versioned formula (priority.ts) with reach = affected / crawled pages and a
 * metric part only when affected pages have GSC rows. The checklist's reference tier is never read.
 * Jev: technical/structural items are deterministic (no Jev question); heuristic content items require
 * seo.action_choice like other content candidates and are rejected decision_unavailable without Jev.
 * Robots: the verified host's robots.txt is re-read through the SSRF guard (ctx.crawlFetch, 512 KB cap)
 * and the advisor's suggestion becomes the code-owned snippet; if the re-read fails there is no snippet
 * and the action asks for [confirm: current robots.txt]. Okara never edits robots.txt.
 */
import type { Level, PageType, Scope, Severity } from "@shared/types";
import {
  checklistSignals,
  DEFAULT_TOP_PAGES,
  loadProjectRow,
  robotsAdvice,
  type AffectedPage,
  type ChecklistGap,
  type ChecklistSignalsResult,
  type CrawlerAccessSummary,
  type RobotsAdvice,
} from "../../checklists/bridge";
import { CHECKLIST_VERSION } from "../../checklists/registry";
import type { RunContext } from "../../runs/context";
import { templateName } from "../crawl/page-type";
import { pageMetrics } from "../gsc/aggregate";
import { windowLabel } from "../gsc/windows";
import type { ActionChoice } from "../questions";
import { ADVISOR_REVIEW_LABEL } from "../robots-advisor";
import type { Candidate, ChecklistCandidateMeta, EvidenceSpec } from "./candidates";
import type { CandidateInputs, PageInfo } from "./inputs";
import { SEVERITY_WEIGHT, type PriorityInputs } from "./priority";
import { clip, fmtInt, normalizeUrl } from "./text";

export const SEO_CHECKLIST_CANDIDATES_VERSION = "seo-checklist-candidates-2026-09-30.1";
/** Checklist item whose robots.txt signal the dedicated robots candidate represents (dedup identity). */
export const ROBOTS_ITEM_ID = "seo.technical.robots_noindex";
const TEMPLATE_MIN_PAGES = 3;
const TEMPLATE_PAGE_TYPES = new Set<PageType>(["product", "collection", "article"]);

export interface SeoRoute {
  /** deterministic: no Jev question (technical/structural); jev: seo.action_choice decides (heuristic content). */
  mode: "deterministic" | "jev";
  action: ActionChoice | null;
  effort: Level;
  /** Deterministic action text with [confirm: ...] placeholders; null = the Jev action's template. */
  actionText: ((target: string) => string) | null;
  /** Human review required (tier capped at flag). */
  reviewRequired?: boolean;
  /** The gap affects the whole site (reach 1) even without a page population. */
  siteWide?: boolean;
  wantsIntent?: boolean;
}

/** Checklist items that fit the SEO agent (see the file header for what is excluded and why). */
export const SEO_ROUTES: Readonly<Record<string, SeoRoute>> = {
  "seo.technical.sitemap_submitted": {
    mode: "deterministic",
    action: null,
    effort: "low",
    siteWide: true,
    actionText: () =>
      "Publish an XML sitemap listing the pages you want found, reference it with a Sitemap: line in robots.txt, and submit it in Google Search Console and Bing Webmaster Tools; [confirm: the sitemap URL your platform generates].",
  },
  "seo.technical.mobile_friendly": {
    mode: "deterministic",
    action: null,
    effort: "medium",
    actionText: (t) => `Add a responsive viewport meta tag (width=device-width) to ${t} and check layout, font size, and tap targets on a phone; [confirm: whether this template already adapts to small screens].`,
  },
  "seo.technical.js_crawlable": {
    mode: "deterministic",
    action: null,
    effort: "high",
    actionText: (t) => `Server-render or pre-render the main content of ${t} so key text is in the HTML response, not only after JavaScript runs; [confirm: which content is rendered only in the browser].`,
  },
  "seo.technical.clean_urls": {
    mode: "deterministic",
    action: null,
    effort: "high",
    actionText: (t) =>
      `For ${t}, use short, lowercase, hyphenated paths on new pages; change a live URL only with a permanent redirect from the old URL and updated internal links; [confirm: which URLs are worth changing].`,
  },
  "seo.technical.breadcrumbs": {
    mode: "deterministic",
    action: null,
    effort: "medium",
    actionText: (t) => `Add visible breadcrumb navigation with matching BreadcrumbList structured data to ${t}; [confirm: the breadcrumb trail for these pages].`,
  },
  "seo.technical.orphan_pages": {
    mode: "deterministic",
    action: "add_internal_links",
    effort: "low",
    actionText: (t) =>
      `Link to ${t} from at least one relevant category, hub, or related page with descriptive anchor text, not only from the sitemap; [confirm: which pages should link here].`,
  },
  "seo.technical.schema_rich_results": {
    mode: "deterministic",
    action: "fix_structured_data",
    effort: "medium",
    actionText: (t) =>
      `Add structured data that matches the page type on ${t} (for example Organization on the home page, Article on posts, CollectionPage or ItemList on category pages), using only facts shown on the page, and check it in Google's Rich Results Test; [confirm: values for the required properties].`,
  },
  "seo.on_page.image_alt": {
    mode: "deterministic",
    action: null,
    effort: "low",
    actionText: (t) => `Add descriptive alt text to the informative images on ${t} (an empty alt for decorative images); [confirm: what each image shows].`,
  },
  "seo.on_page.answer_first_lines": { mode: "jev", action: "improve_intro_answer", effort: "medium", actionText: null },
  "seo.content.comparison_pages": { mode: "jev", action: "new_page_candidate", effort: "high", actionText: null, reviewRequired: true },
  "seo.content.listicles": { mode: "jev", action: "new_page_candidate", effort: "high", actionText: null, reviewRequired: true },
  "page.before_write.search_intent": { mode: "jev", action: null, effort: "medium", actionText: null, wantsIntent: true },
};

/** Documented severity mapping (the only severity input for checklist candidates). */
export function checklistSeverity(gap: Pick<ChecklistGap, "status" | "method">): Severity {
  return gap.method === "measured" && gap.status === "not_met" ? "moderate" : "minor";
}

export interface SeoChecklistResult {
  candidates: Candidate[];
  /** Keys of existing candidates superseded by a checklist candidate (the technical AI-SEARCH-CRAWLER-BLOCKED group). */
  supersedes: string[];
  notes: string[];
  signals: ChecklistSignalsResult | null;
  robots: RobotsAdvice | null;
}

/** Load checklist gaps for this run and turn the SEO ones into candidates (reads only; one robots.txt GET when needed). */
export async function buildSeoChecklistCandidates(ctx: RunContext, inputs: CandidateInputs, existing: Candidate[], opts: { topPages?: number } = {}): Promise<SeoChecklistResult> {
  const project = await loadProjectRow(ctx.db, ctx.project);
  if (!project) return { candidates: [], supersedes: [], notes: [], signals: null, robots: null };
  const now = ctx.clock();
  const signals = await checklistSignals(ctx.env, ctx.db, project, now, { kinds: ["seo", "page"], topPages: opts.topPages ?? DEFAULT_TOP_PAGES });
  const notes: string[] = [];
  if (signals.extraction === "legacy") {
    notes.push("Checklist: the latest crawl predates the checklist extraction fields, so page-based checklist gaps will feed recommendations after the next crawl.");
  }
  const candidates = checklistCandidatesFromGaps(signals.gaps, inputs);
  const supersedes: string[] = [];
  let robots: RobotsAdvice | null = null;
  const seBlocked = (signals.crawlerAccess?.blocked ?? []).filter((b) => b.purpose === "search_engine");
  if (signals.crawlerAccess && seBlocked.length > 0) {
    robots = await robotsAdvice(ctx.crawlFetch, { host: project.verified_host, siteType: project.site_type, appOrigin: ctx.env.APP_ORIGIN, now });
    const robotsItem = signals.items.seo.find((i) => i.id === ROBOTS_ITEM_ID) ?? null;
    const c = robotsCandidate(signals.crawlerAccess, robots, inputs, robotsItem ? { status: robotsItem.status, summary: robotsItem.summary, label: robotsItem.label } : null);
    if (c) {
      candidates.push(c);
      for (const e of existing) if (e.kind === "technical" && e.issueType === "technical:AI-SEARCH-CRAWLER-BLOCKED") supersedes.push(e.key);
    } else {
      notes.push("Checklist: robots.txt no longer blocks the search-engine crawlers reported by the latest crawl; no robots.txt recommendation.");
    }
  }
  const byItem = candidates.reduce<Record<string, number>>((m, c) => ((m[c.checklist!.itemId] = (m[c.checklist!.itemId] ?? 0) + 1), m), {});
  if (candidates.length > 0) {
    notes.push(
      `Checklist gaps (${CHECKLIST_VERSION}): ${Object.entries(byItem)
        .map(([k, n]) => `${k} ${n}`)
        .join(", ")}; ${signals.excluded.filter((x) => x.reason === "covered_by_rules").length} item(s) left to rule-based candidates.`,
    );
  }
  return { candidates, supersedes, notes, signals, robots };
}

// ------------------------------------------------------------------ gaps -> candidates (pure)
interface Group {
  scope: Scope;
  pages: AffectedPage[];
  pageType: PageType | null;
}

/** Split a gap's affected pages into template / page / site groups ([A9]). */
export function scopeGroups(gap: ChecklistGap, route: SeoRoute): Group[] {
  const pages = gap.affected;
  if (!pages || route.siteWide) return [{ scope: "site", pages: pages ?? [], pageType: null }];
  if (gap.kind === "page" || pages.length === 1) return [{ scope: "page", pages: pages.slice(0, 1), pageType: pages[0]!.pageType }];
  const byType = new Map<PageType, AffectedPage[]>();
  for (const p of pages) byType.set(p.pageType, [...(byType.get(p.pageType) ?? []), p]);
  const groups: Group[] = [];
  const rest: AffectedPage[] = [];
  for (const [type, list] of byType) {
    if (TEMPLATE_PAGE_TYPES.has(type) && list.length >= TEMPLATE_MIN_PAGES) groups.push({ scope: "template", pages: list, pageType: type });
    else rest.push(...list);
  }
  if (rest.length === 1) groups.push({ scope: "page", pages: rest, pageType: rest[0]!.pageType });
  else if (rest.length > 1) groups.push({ scope: "site", pages: rest, pageType: null });
  return groups;
}

export function checklistCandidatesFromGaps(gaps: ChecklistGap[], inputs: CandidateInputs): Candidate[] {
  const ctx = new GapContext(inputs);
  const out: Candidate[] = [];
  for (const gap of gaps) {
    if (gap.kind === "geo" || gap.equivalentTo) continue;
    const route = SEO_ROUTES[gap.itemId];
    if (!route) continue;
    for (const g of scopeGroups(gap, route)) out.push(ctx.candidate(gap, route, g));
  }
  return out;
}

class GapContext {
  readonly pagesByNorm: Map<string, PageInfo>;
  readonly metrics: ReturnType<typeof pageMetrics>;
  readonly day: string | null;
  readonly win: string | null;
  readonly totalImpr: number | null;
  readonly totalClicks: number | null;
  readonly crawled: number;

  constructor(readonly inp: CandidateInputs) {
    this.pagesByNorm = new Map(inp.pages.map((p) => [p.norm, p]));
    this.metrics = pageMetrics(inp.rows, "current", normalizeUrl);
    this.day = inp.crawl?.day ?? null;
    this.win = inp.sync ? windowLabel(inp.sync.current) : null;
    const cur = inp.rows.filter((r) => r.window === "current" && r.query && r.page);
    const t = inp.sync?.totals.current;
    const sliceImpr = cur.reduce((s, r) => s + r.impressions, 0);
    const sliceClicks = cur.reduce((s, r) => s + r.clicks, 0);
    this.totalImpr = t ? t.impressions : sliceImpr > 0 ? sliceImpr : null;
    this.totalClicks = t ? t.clicks : sliceClicks > 0 ? sliceClicks : null;
    this.crawled = Math.max(1, inp.crawl?.crawledCount ?? 0);
  }

  topQuery(url: string): string | null {
    const k = normalizeUrl(url);
    const rows = this.inp.rows.filter((r) => r.window === "current" && r.query && r.page && normalizeUrl(r.page) === k).sort((a, b) => b.impressions - a.impressions);
    return rows[0]?.query ?? null;
  }

  candidate(gap: ChecklistGap, route: SeoRoute, g: Group): Candidate {
    const n = g.pages.length;
    const infos = g.pages.map((p) => this.pagesByNorm.get(normalizeUrl(p.url)) ?? null);
    const first = infos.find((p): p is PageInfo => p !== null) ?? null;
    const examples = g.pages.slice(0, 3);
    const severity = checklistSeverity(gap);
    const withMetrics = g.pages.map((p) => this.metrics.get(normalizeUrl(p.url))).filter((m): m is NonNullable<typeof m> => !!m);
    const impressions = withMetrics.length ? withMetrics.reduce((s, m) => s + m.impressions, 0) : null;
    const clicks = withMetrics.length ? withMetrics.reduce((s, m) => s + m.clicks, 0) : null;
    const reach = route.siteWide ? 1 : n > 0 ? Math.min(1, n / this.crawled) : null;
    const priority: PriorityInputs = { impressions, clicks, totalImpressions: this.totalImpr, totalClicks: this.totalClicks, severity: SEVERITY_WEIGHT[severity], reach, effort: route.effort };
    const template = g.scope === "template" && g.pageType ? (templateName(g.pageType) ?? `${g.pageType} template`) : null;
    const targetKey = g.scope === "page" ? normalizeUrl(g.pages[0]!.url) : (template ?? "site");
    const target: Candidate["target"] =
      g.scope === "page"
        ? { kind: "url", url: g.pages[0]!.url }
        : g.scope === "template"
          ? { kind: "template", template: template!, affectedUrlCount: n, exampleUrls: examples.map((p) => p.url) }
          : n > 0
            ? { kind: "site", affectedUrlCount: n, exampleUrls: examples.map((p) => p.url) }
            : { kind: "site" };
    const targetText = g.scope === "page" ? g.pages[0]!.url : g.scope === "template" ? `the ${template} (${examples.map((p) => p.url).join(", ")})` : n > 0 ? `the affected pages (for example ${examples.map((p) => p.url).join(", ")})` : "the site";

    const evidence: EvidenceSpec[] = [this.checklistEvidence(gap, g)];
    for (const p of g.scope === "page" ? g.pages.slice(0, 1) : examples) {
      const info = this.pagesByNorm.get(normalizeUrl(p.url));
      evidence.push({
        source: "crawl",
        refId: info?.snapshotId ?? this.inp.crawl?.id ?? null,
        window: this.day,
        text: `Crawled ${p.url} (${p.pageType})${this.day ? ` on ${this.day}` : ""}: ${clip(p.detail, 240)}.`,
        data: { url: p.url, pageType: p.pageType, detail: p.detail, checklistItemId: gap.itemId },
        tainted: info?.tainted,
      });
    }
    if (impressions !== null && this.inp.sync) {
      const gscSource = this.inp.sync.source === "csv_import" ? "manual_import" : "gsc";
      evidence.push({
        source: gscSource,
        refId: this.inp.sync.id,
        window: this.win,
        text: `GSC ${this.win}: the ${withMetrics.length} affected URL(s) with Search Console rows received ${fmtInt(impressions)} impressions and ${fmtInt(clicks ?? 0)} clicks combined (lower bound).`,
        data: { impressions, clicks, urls: withMetrics.length },
      });
    }
    if (evidence.length < 2 && this.inp.crawl) {
      evidence.push({
        source: "crawl",
        refId: this.inp.crawl.id,
        window: this.day,
        text: `Crawl on ${this.day} checked ${this.inp.crawl.crawledCount} pages.`,
        data: { crawled: this.inp.crawl.crawledCount },
      });
    }

    const query = route.mode === "jev" && g.pages[0] ? this.topQuery(g.pages[0].url) : null;
    const meta: ChecklistCandidateMeta = {
      itemId: gap.itemId,
      checklistKind: gap.kind,
      checklistVersion: gap.checklistVersion,
      label: gap.label,
      status: gap.status,
      method: gap.method,
      actionText: route.actionText ? route.actionText(targetText) : null,
      rationale:
        route.mode === "jev"
          ? `The readiness checklist flagged this heuristic gap (${gap.method}) in the project's own data, and Jev chose the change; it describes a practice to review, and no ranking change is promised.`
          : `The readiness checklist measured this gap in the project's own ${gap.source === "gsc" ? "Search Console data" : gap.source === "robots" ? "robots.txt and sitemap record" : "crawl"}; fixing it once at the reported scope addresses every affected page, and no ranking change is promised.`,
      snippet: null,
      deterministicOnly: false,
      effort: route.effort,
    };
    const trigger =
      g.scope === "template"
        ? `Checklist gap on ${n} ${g.pageType} URLs: ${gap.label}`
        : g.scope === "page"
          ? `Checklist gap on one page: ${gap.label}`
          : n > 0
            ? `Checklist gap on ${n} pages: ${gap.label}`
            : `Checklist gap: ${gap.label}`;
    return {
      key: `checklist:${gap.itemId}|${targetKey}`,
      kind: "checklist",
      issueType: `checklist:${gap.itemId}`,
      jevDependent: route.mode === "jev",
      scope: g.scope,
      target,
      trigger: clip(trigger, 200),
      issue: clip(`${gap.label}: ${gap.summary}`, 400),
      query,
      page: g.scope === "page" || route.mode === "jev" ? first : null,
      pageB: null,
      sharedQueries: [],
      pageType: g.pageType,
      severity,
      metrics: { affected: n, crawled: this.inp.crawl?.crawledCount ?? null, impressions, clicks, checklistStatus: gap.status, checklistMethod: gap.method },
      priority,
      defaultAction: route.action,
      evidence,
      identity: { checklist: gap.itemId, target: targetKey },
      engineMatch: null,
      wantsIntent: !!route.wantsIntent && !!query,
      wantsPillar: false,
      verified: n > 0 || gap.source !== "geo",
      reviewRequired: !!route.reviewRequired,
      limitations: clip(
        `From the ${gap.kind === "page" ? "per-page" : "SEO"} readiness checklist (${gap.checklistVersion}); ${gap.method}${this.day && gap.source === "crawl" ? ` on the crawl of ${this.inp.crawl?.crawledCount ?? 0} pages on ${this.day}` : ""}. ${gap.caveat ?? ""} Pages outside the crawl may also be affected.`.replace(/\s+/g, " "),
        400,
      ),
      demand: null,
      checklist: meta,
    };
  }

  checklistEvidence(gap: ChecklistGap, g: Group): EvidenceSpec {
    const urls = g.pages.length ? g.pages.map((p) => p.url).slice(0, 10) : gap.evidence;
    return {
      source: gap.source === "crawl" || gap.source === "robots" ? "crawl" : "rule",
      refId: gap.source === "crawl" || gap.source === "robots" ? (this.inp.crawl?.id ?? null) : null,
      window: this.day,
      text: `Checklist: ${gap.label} — ${gap.summary}`,
      data: {
        checklistItemId: gap.itemId,
        checklistKind: gap.kind,
        checklistVersion: gap.checklistVersion,
        status: gap.status,
        method: gap.method,
        urls,
        summary: gap.summary,
        crawled: this.inp.crawl?.crawledCount ?? null,
        section: gap.section,
        affectedCount: g.pages.length || gap.affectedCount,
        scope: g.scope,
        pageType: g.pageType,
        caveat: gap.caveat,
        candidatesVersion: SEO_CHECKLIST_CANDIDATES_VERSION,
      },
    };
  }
}

// ------------------------------------------------------------------ robots.txt: blocked search-engine crawlers
const firstSentence = (s: string) => {
  const m = /^(.+?[.!?])(\s|$)/.exec(s);
  return (m ? m[1]! : s).trim();
};

/**
 * One critical site-scope candidate when a search-engine crawler (Googlebot, Bingbot, Applebot) is
 * disallowed at the site root, with the advisor's suggested robots.txt as the code-owned snippet.
 * Returns null when a fresh read of robots.txt shows those crawlers are no longer blocked.
 */
export function robotsCandidate(
  access: CrawlerAccessSummary,
  advice: RobotsAdvice | null,
  inputs: CandidateInputs,
  item: { status: string; summary: string; label: string } | null,
): Candidate | null {
  let tokens = access.blocked.filter((b) => b.purpose === "search_engine").map((b) => b.token);
  const reread = advice && (advice.state === "ready" || advice.state === "not_found");
  if (reread) {
    tokens = tokens.filter((t) => advice!.current.find((c) => c.token.toLowerCase() === t.toLowerCase())?.allowed === false);
    if (tokens.length === 0) return null;
  }
  if (tokens.length === 0) return null;
  const who = tokens.join(", ");
  const day = (access.crawledAt ?? "").slice(0, 10) || null;
  const s = advice?.suggestion ?? null;
  const snippet = s?.suggestedRobotsTxt ?? null;
  const preserved = s?.preservedRules ?? [];
  const evidence: EvidenceSpec[] = [
    {
      source: "crawl",
      refId: access.crawlRunId,
      window: day,
      text: `Checklist: ${item?.label ?? "Check robots.txt and noindex tags"} — robots.txt disallows the site root for ${who} (search engine crawler${tokens.length > 1 ? "s" : ""}) in the crawl${day ? ` on ${day}` : ""}.${item ? ` ${item.summary}` : ""}`,
      data: {
        checklistItemId: ROBOTS_ITEM_ID,
        checklistKind: "seo",
        checklistVersion: CHECKLIST_VERSION,
        status: item?.status ?? "not_met",
        method: "measured",
        urls: advice?.url ? [advice.url] : [],
        blocked: access.blocked.filter((b) => tokens.includes(b.token)),
      },
    },
  ];
  for (const f of inputs.findings.filter((x) => x.ruleId === "AI-SEARCH-CRAWLER-BLOCKED" && tokens.some((t) => x.detail.startsWith(`${t} (`))).slice(0, 2)) {
    evidence.push({ source: "rule", refId: f.id, window: day, text: `Rule ${f.ruleId} (${f.severity})${day ? ` in crawl on ${day}` : ""}: ${clip(f.detail, 300)}`, data: { ruleId: f.ruleId, severity: f.severity, url: f.url } });
  }
  const fetchedDay = advice?.fetchedAt.slice(0, 10) ?? null;
  if (reread && s) {
    evidence.push({
      source: "crawl",
      refId: null,
      window: fetchedDay,
      text: `robots.txt re-read from ${advice!.url} on ${fetchedDay} (RFC 9309 group selection): ${who} blocked at the site root. The suggestion gives each search engine and AI answer/search crawler its own group that repeats ${preserved.length} rule(s) from the "*" group${preserved.length ? ` (${clip(preserved.slice(0, 4).join("; "), 160)})` : ""}; training crawlers keep their current rules.`,
      data: {
        url: advice!.url,
        fetchedAt: advice!.fetchedAt,
        rfc: "RFC 9309",
        preservedRules: preserved,
        changes: s.changes,
        warnings: s.warnings,
        training: advice!.training,
        review: ADVISOR_REVIEW_LABEL,
      },
    });
  } else {
    evidence.push({
      source: "crawl",
      refId: null,
      window: fetchedDay,
      text: `robots.txt could not be re-read during this run${advice?.error ? ` (${clip(advice.error, 160)})` : ""}, so no suggested robots.txt was built.`,
      data: { url: advice?.url ?? null, error: advice?.error ?? null, rfc: "RFC 9309", review: ADVISOR_REVIEW_LABEL },
    });
  }
  const example = preserved.find((r) => /^Disallow:/i.test(r))?.replace(/^Disallow:\s*/i, "") ?? null;
  const actionText = snippet
    ? `Review the suggested robots.txt below and apply it through your platform's supported method (for example a Shopify robots.txt.liquid template): it lets ${who} crawl the site while repeating your existing "*" rules in each named group${example ? `, so paths such as ${example} stay disallowed` : ""}; [confirm: that these crawlers should be allowed]. ${ADVISOR_REVIEW_LABEL}`
    : `Remove the rule that disallows the site root for ${who}, and repeat your existing "*" rules in any group you add for these crawlers; [confirm: current robots.txt]. ${ADVISOR_REVIEW_LABEL}`;
  const limitationParts = [ADVISOR_REVIEW_LABEL];
  if (preserved.length) limitationParts.push(`Kept from "*" in each named group: ${preserved.join(", ")}.`);
  if (!snippet) limitationParts.push("No suggested robots.txt: the file could not be re-read during this run.");
  for (const w of s?.warnings ?? []) limitationParts.push(firstSentence(w));
  let limitations = "";
  for (const part of limitationParts) {
    const next = limitations ? `${limitations} ${part}` : part;
    if (next.length > 400) break;
    limitations = next;
  }
  const meta: ChecklistCandidateMeta = {
    itemId: ROBOTS_ITEM_ID,
    checklistKind: "seo",
    checklistVersion: CHECKLIST_VERSION,
    label: item?.label ?? "Check robots.txt and noindex tags",
    status: "not_met",
    method: "measured",
    actionText,
    rationale: `robots.txt asks ${who} not to crawl any page, and these search engines' indexes also feed their AI search features. Under RFC 9309 a crawler with its own group ignores the "*" group, so the suggestion repeats those rules instead of a bare "Allow: /" group.`,
    snippet,
    deterministicOnly: true,
    effort: "low",
  };
  const crawled = inputs.crawl?.crawledCount ?? null;
  return {
    key: "checklist:robots_search_engine|site",
    kind: "checklist",
    issueType: "checklist:robots_search_engine_blocked",
    jevDependent: false,
    scope: "site",
    target: crawled ? { kind: "site", affectedUrlCount: crawled } : { kind: "site" },
    trigger: clip(`Search engine crawler blocked in robots.txt: ${who}`, 200),
    issue: clip(`robots.txt disallows the site root for ${who}, a search engine crawler, so it is asked not to crawl any page of the site.`, 400),
    query: null,
    page: null,
    pageB: null,
    sharedQueries: [],
    pageType: null,
    severity: "critical",
    metrics: { affected: crawled, crawled, blocked: who },
    priority: { impressions: null, clicks: null, totalImpressions: null, totalClicks: null, severity: SEVERITY_WEIGHT.critical, reach: 1, effort: "low" },
    defaultAction: "fix_canonical_or_indexing",
    evidence,
    identity: { checklist: ROBOTS_ITEM_ID, target: "site" },
    engineMatch: null,
    wantsIntent: false,
    wantsPillar: false,
    verified: true,
    reviewRequired: false,
    limitations,
    demand: null,
    checklist: meta,
  };
}
