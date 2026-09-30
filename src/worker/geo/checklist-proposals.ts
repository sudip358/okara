/**
 * [A21] GEO agent: readiness-checklist gaps -> GEO proposal candidates (checklists/bridge.ts), plus the
 * robots.txt advisor [A19] when an AI answer/search crawler is blocked. They join generateGeoProposals'
 * existing flow: dedup, Jev geo.proposal_fit (one batched call), the daily cap, and decision_records
 * with reason codes. Drafts are code-generated templates (no writer), checked by validateDraft and the
 * GEO claim guard; a failing draft is rejected validation_failed and never saved.
 *
 * Candidates:
 *   Access     an answer/search crawler (OAI-SearchBot, Claude-SearchBot, PerplexityBot) disallowed at
 *              the site root -> one site proposal whose snippet is the advisor's suggested robots.txt,
 *              re-read through the SSRF guard (ctx.crawlFetch). Training crawlers keep their current
 *              rules (blocked stays blocked). CDN/WAF caveat included. Login walls on crawled pages
 *              (401/403 already covered by SEO-STATUS-4XX) -> access proposal.
 *   Structure  question H2s, comparison tables, schema;  Trust  author, last updated, outbound sources,
 *              public pricing. Tied, when possible, to discovery prompts where the brand was absent and
 *              another source was cited instead (geo_displacements): our closest crawled page by
 *              title/H1 word overlap (heuristic, labelled) must be among the gap's affected pages. The
 *              evidence cites the checklist item, the displacement tie (observation ids, cited URL), the
 *              observations' own evidence rows, and our page's observable crawl attributes. Without ties:
 *              one site/template/page proposal from the affected pages. Schema is proposed here only when
 *              tied (otherwise the SEO agent's structured-data candidate covers it).
 *   Mentions   one proposal listing the third-party sources AI answers cite without the brand, by type
 *              (forum threads, listicles, review sites/marketplaces, YouTube, publishers), as manual
 *              review/outreach targets. URLs already covered by a geo_displacement proposal are left out;
 *              no proposal when nothing is left. Never automated posting, reviews, or outreach.
 *   Tracking   gaps are never proposals.
 * Heuristic gaps (question headings, public pricing) need a usable geo.proposal_fit answer (Act/Flag);
 * without Jev they are rejected decision_unavailable. Measured gaps use Jev when available, like the
 * other GEO proposals. Content-format and JS/sitemap items belong to the SEO agent.
 *
 * Priority (code, GEO_CHECKLIST_PRIORITY_VERSION): weighted mean of severity (0.4; blocked answer
 * crawler 1.0, measured not_met 0.5, partial/heuristic/mentions 0.25), frequency (0.35; min(pairs,10)/10
 * of tied prompt x provider pairs), reach (0.25; affected / checked pages, dropped when unknown), and fit
 * (0.2; score / 4 when usable), renormalized over available parts, x100. Reference tiers are never read.
 */
import type { EvidenceBullet, EvidenceSource, Level, PageType } from "@shared/types";
import {
  checklistSignals,
  loadProjectRow,
  robotsAdvice,
  type ChecklistGap,
  type ChecklistSignalsResult,
  type RobotsAdvice,
} from "../checklists/bridge";
import type { Snap } from "../checklists/data";
import { CHECKLIST_VERSION } from "../checklists/registry";
import type { MentionSourceKey } from "../checklists/signals";
import { tokens as textTokens } from "../checklists/text";
import { hashJson } from "../lib/hash";
import { parseJson } from "../lib/db";
import { createEvidence, EVIDENCE_TEXT_MAX } from "../recommendations/evidence";
import type { RunContext } from "../runs/context";
import { ADVISOR_REVIEW_LABEL, CDN_WARNING } from "../seo/robots-advisor";
import { normalizeUrlKey } from "../seo/rules/registry";
import { validateDraft, type ValidationEvidence } from "../writing/validate";
import type { GeoCandidate, ObsLite, BrandLite, EvidenceLite } from "./proposals";

export const GEO_CHECKLIST_PRIORITY_VERSION = "geo-priority-checklist-2026-09-30.1";
const TEMPLATE_PAGE_TYPES = new Set<PageType>(["product", "collection", "article"]);
const TIE_MIN_SHARED_TOKENS = 2;
const TIE_MIN_PAGE_SHARE = 0.5;
const MAX_MENTION_URLS_PER_TYPE = 3;
const MAX_MENTION_URLS = 12;
const API_LIMITATION = "Based on API-sampled answers from the listed providers/models; not consumer-app answers or Google AI Overviews, and not proof of what every user sees.";
const A7_NOTE = "Cited third-party pages are not fetched automatically; open them yourself to compare.";
const MANUAL_ONLY = "This is a manual-action list: Okara does not post, review, or contact anyone on your behalf.";

// ------------------------------------------------------------------ plan carried on the GeoCandidate
export interface ChecklistEvidenceSpec {
  source: EvidenceSource;
  refId: string | null;
  window: string | null;
  text: string;
  data: Record<string, unknown>;
}

export interface GeoChecklistPlan {
  itemIds: string[];
  checklistVersion: string;
  requiresJev: boolean;
  /** 0..1 severity input to the checklist priority formula. */
  severity: number;
  reach: number | null;
  evidence: ChecklistEvidenceSpec[];
  /** Existing geo_observation evidence rows (observation summaries) to cite. */
  observationEvidence: EvidenceLite[];
  draft: {
    trigger: string;
    issue: string;
    action: string;
    rationale: string;
    limitations: string;
    snippet: string | null;
    /** robots: the site's own robots.txt plus suggested groups (not prose: not claim-checked); list: our text. */
    snippetKind: "robots" | "list" | null;
    effort: Level;
    uncertainty: Level;
    verified: boolean;
  };
}

export interface GeoChecklistInputs {
  obs: ObsLite[];
  brands: BrandLite[];
  disps: Array<{ observation_id: string; entity: string; url: string | null; source_type: string }>;
  evidence: EvidenceLite[];
  brandName: string;
}

/** Documented priority for checklist-derived GEO proposals (0..100). */
export function geoChecklistPriority(plan: Pick<GeoChecklistPlan, "severity" | "reach">, pairs: number, fit: number | null): number {
  const parts: Array<[number, number]> = [
    [Math.max(0, Math.min(1, plan.severity)), 0.4],
    [Math.min(Math.max(pairs, 0), 10) / 10, 0.35],
  ];
  if (plan.reach !== null) parts.push([Math.max(0, Math.min(1, plan.reach)), 0.25]);
  if (fit !== null) parts.push([Math.max(0, Math.min(1, fit)), 0.2]);
  const w = parts.reduce((s, [, x]) => s + x, 0);
  const raw = parts.reduce((s, [v, x]) => s + v * x, 0) / w;
  return Math.round(raw * 1000) / 10;
}

const pairKey = (o: ObsLite) => `${o.prompt_id ?? o.prompt_text}\u0000${o.provider}`;
const distinctPairs = (obs: ObsLite[]) => new Set(obs.map(pairKey)).size;
const latestOf = (obs: ObsLite[], fallback: string) => obs.map((o) => o.created_at).sort().at(-1) ?? fallback;
const clip = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

async function dedupKey(projectId: string, itemId: string, target: string): Promise<string> {
  const h = await hashJson({ p: projectId, k: "checklist", i: itemId, t: target });
  return `geo:checklist:${h.slice(0, 24)}`;
}

// ------------------------------------------------------------------ builder
export interface GeoChecklistBuild {
  candidates: GeoCandidate[];
  notes: string[];
  signals: ChecklistSignalsResult | null;
  robots: RobotsAdvice | null;
}

/** Checklist-derived GEO candidates for this run (reads only; one robots.txt GET when an answer crawler is blocked). */
export async function buildGeoChecklistCandidates(ctx: RunContext, inputs: GeoChecklistInputs, observationCandidates: GeoCandidate[]): Promise<GeoChecklistBuild> {
  const project = await loadProjectRow(ctx.db, ctx.project);
  if (!project) return { candidates: [], notes: [], signals: null, robots: null };
  const now = ctx.clock();
  const signals = await checklistSignals(ctx.env, ctx.db, project, now, { kinds: ["geo"], topPages: 0 });
  const b = new Builder(ctx, inputs, signals, observationCandidates);
  const out: GeoCandidate[] = [];
  const notes: string[] = [];
  if (signals.extraction === "legacy") notes.push("Checklist: the latest crawl predates the checklist extraction fields, so page-based GEO checklist gaps will feed proposals after the next crawl.");

  let robots: RobotsAdvice | null = null;
  const answerBlocked = (signals.crawlerAccess?.blocked ?? []).filter((x) => x.purpose === "answer_search");
  if (answerBlocked.length > 0) {
    robots = await robotsAdvice(ctx.crawlFetch, { host: project.verified_host, siteType: project.site_type, appOrigin: ctx.env.APP_ORIGIN, now });
    const c = await b.access(answerBlocked, robots);
    if (c) out.push(c);
    else notes.push("Checklist: robots.txt no longer blocks the AI answer/search crawlers reported by the latest crawl; no access proposal.");
  }
  for (const gap of signals.gaps) {
    if (gap.kind !== "geo") continue;
    const route = STRUCTURE_TRUST[gap.itemId];
    if (!route) continue;
    const c = await b.structureTrust(gap, route);
    if (c) out.push(c);
  }
  const mentions = await b.mentions(signals.gaps.filter((g) => g.kind === "geo" && g.section === "mentions"));
  if (mentions) out.push(mentions);
  return { candidates: out, notes, signals, robots };
}

interface StructureRoute {
  requiresJev: boolean;
  tiedOnly?: boolean;
  action: (target: string, prompt: string | null) => string;
}

/** GEO structure / trust / access items that become proposals (tracking and content items never do). */
const STRUCTURE_TRUST: Readonly<Record<string, StructureRoute>> = {
  "geo.structure.question_headings": {
    requiresJev: true,
    action: (t, prompt) => `On ${t}, phrase key subheadings as the questions buyers ask${prompt ? ` (for example "${clip(prompt, 100)}")` : ""} and put a direct answer right below each [confirm: the answers you can support with facts].`,
  },
  "geo.structure.comparison_tables": {
    requiresJev: false,
    action: (t) => `Put the comparisons on ${t} into HTML tables with clear column headings [confirm: the products and attributes to compare].`,
  },
  "geo.structure.schema_markup": {
    requiresJev: false,
    tiedOnly: true,
    action: (t) => `Add structured data that describes ${t} using only facts shown on the page [confirm: values for the required properties].`,
  },
  "geo.trust.author_bio": {
    requiresJev: false,
    action: (t) => `Show a real author name on ${t}, linked to a short bio that states relevant experience [confirm: the author and their experience]. Never invent authors or credentials.`,
  },
  "geo.trust.last_updated": {
    requiresJev: false,
    action: (t) => `Show a visible last-updated date on ${t} and keep dateModified in structured data in sync, changing it only for real updates [confirm: the date of the last real update].`,
  },
  "geo.trust.reputable_sources": {
    requiresJev: false,
    action: (t) => `Link the claims on ${t} that need support to primary or reputable sources [confirm: the sources for each claim].`,
  },
  "geo.trust.public_pricing": {
    requiresJev: true,
    action: (t) => `Show current prices as text on ${t}, and as an Offer price in product structured data where it applies [confirm: the current prices].`,
  },
  "geo.access.no_login_walls": {
    requiresJev: false,
    action: (t) => `Keep ${t} publicly readable and put only account-specific pages behind sign-in [confirm: which pages must stay private].`,
  },
};

interface Tie {
  obs: ObsLite;
  entity: string;
  url: string;
  sourceType: string;
  page: Snap;
  shared: number;
}

class Builder {
  readonly ws: string;
  readonly pid: string;
  readonly snaps: Snap[];
  readonly crawlDay: string | null;
  readonly obsById: Map<string, ObsLite>;

  constructor(
    readonly ctx: RunContext,
    readonly inp: GeoChecklistInputs,
    readonly sig: ChecklistSignalsResult,
    readonly obsCandidates: GeoCandidate[],
  ) {
    this.ws = ctx.project.workspaceId;
    this.pid = ctx.project.id;
    this.snaps = sig.signals.analyzable();
    const c = sig.data.crawl;
    this.crawlDay = c ? (c.finishedAt ?? c.startedAt).slice(0, 10) : null;
    this.obsById = new Map(inp.obs.map((o) => [o.id, o]));
  }

  selfOf(obsId: string): BrandLite | undefined {
    return this.inp.brands.find((b) => b.observation_id === obsId && b.is_self === 1);
  }

  brandAbsent(obsId: string): boolean {
    const s = this.selfOf(obsId);
    return !!s && s.mentioned === 0 && s.cited === 0;
  }

  obsEvidence(obs: ObsLite[], max = 3): EvidenceLite[] {
    const ids = new Set(obs.map((o) => o.id));
    return this.inp.evidence.filter((e) => ids.has(e.ref_id) && parseJson<{ kind?: string }>(e.data_json, {}).kind === "summary").slice(0, max);
  }

  checklistEvidence(gap: ChecklistGap, extra: Record<string, unknown> = {}): ChecklistEvidenceSpec {
    return {
      source: gap.source === "crawl" || gap.source === "robots" ? "crawl" : "rule",
      refId: gap.source === "crawl" || gap.source === "robots" ? (this.sig.data.crawl?.id ?? null) : null,
      window: this.crawlDay,
      text: `Checklist: ${gap.label} — ${gap.summary}`,
      data: {
        checklistItemId: gap.itemId,
        checklistKind: gap.kind,
        checklistVersion: gap.checklistVersion,
        status: gap.status,
        method: gap.method,
        urls: (gap.affected?.map((a) => a.url) ?? gap.evidence).slice(0, 10),
        summary: gap.summary,
        affectedCount: gap.affectedCount,
        caveat: gap.caveat,
        brand: this.inp.brandName,
        ...extra,
      },
    };
  }

  /** Observable attributes of our crawled page (no page prose), like proposals.ts crawl evidence. */
  pageEvidence(s: Snap): ChecklistEvidenceSpec {
    const present = (v: string | null) => (v && v.trim() ? "present" : "absent");
    const count = (n: number | null) => (n === null ? "unknown" : String(n));
    const types = s.jsonLdTypes.filter((t) => /^[A-Za-z][A-Za-z0-9:_-]{0,60}$/.test(t)).slice(0, 10);
    const questionHeadings = s.headings.filter((h) => (h.level === 2 || h.level === 3) && /\?\s*$|^(how|what|why|which|who|where|when|can|does|do|is|are|should)\b/i.test(h.text.trim())).length;
    const day = s.fetchedAt.slice(0, 10);
    const data = {
      kind: "page_attributes",
      url: s.url,
      pageType: s.pageType,
      fetchedAt: s.fetchedAt,
      namedAuthor: present(s.author),
      visibleLastUpdated: present(s.lastUpdated),
      outboundSourceLinks: s.outboundCitations,
      tables: s.tableCount,
      questionHeadings,
      structuredDataTypes: types,
    };
    return {
      source: "crawl",
      refId: s.crawlRunId,
      window: day,
      text: `Crawled ${s.url} (${s.pageType}) on ${day}: named author ${data.namedAuthor}; visible last-updated date ${data.visibleLastUpdated}; outbound source links ${count(s.outboundCitations)}; tables ${count(s.tableCount)}; question-style subheadings ${questionHeadings}; structured data types: ${types.join(", ") || "none"}.`,
      data,
    };
  }

  /** Discovery prompts where the brand was absent and another source was cited instead, tied to our closest page. */
  ties(affectedUrls: Set<string>): Tie[] {
    const out: Tie[] = [];
    const pageTokens = new Map(this.snaps.map((s) => [s.url, new Set(textTokens(`${s.title ?? ""} ${s.h1s.join(" ")}`))]));
    for (const d of this.inp.disps) {
      const o = this.obsById.get(d.observation_id);
      if (!o || o.prompt_type !== "discovery" || !d.url || !this.brandAbsent(o.id)) continue;
      const prompt = new Set(textTokens(o.prompt_text));
      let best: { page: Snap; shared: number; share: number } | null = null;
      for (const s of this.snaps) {
        const pt = pageTokens.get(s.url)!;
        if (pt.size === 0) continue;
        let shared = 0;
        for (const t of pt) if (prompt.has(t)) shared++;
        const share = shared / pt.size;
        if (shared < TIE_MIN_SHARED_TOKENS || share < TIE_MIN_PAGE_SHARE) continue;
        if (!best || shared > best.shared || (shared === best.shared && share > best.share)) best = { page: s, shared, share };
      }
      if (best && affectedUrls.has(normalizeUrlKey(best.page.url))) out.push({ obs: o, entity: d.entity, url: d.url, sourceType: d.source_type, page: best.page, shared: best.shared });
    }
    return out;
  }

  scopeOf(pages: Array<{ url: string; pageType: PageType }>): { scope: "page" | "template" | "site"; target: GeoCandidate["target"]; key: string; text: string } {
    if (pages.length === 1) return { scope: "page", target: { kind: "url", url: pages[0]!.url }, key: normalizeUrlKey(pages[0]!.url), text: pages[0]!.url };
    const types = new Set(pages.map((p) => p.pageType));
    const examples = pages.slice(0, 3).map((p) => p.url);
    if (pages.length >= 3 && types.size === 1 && TEMPLATE_PAGE_TYPES.has(pages[0]!.pageType)) {
      const template = `${pages[0]!.pageType} template`;
      return { scope: "template", target: { kind: "template", template, affectedUrlCount: pages.length, exampleUrls: examples }, key: template, text: `the ${template} (${examples.join(", ")})` };
    }
    if (pages.length === 0) return { scope: "site", target: { kind: "site" }, key: "site", text: "your key pages" };
    return { scope: "site", target: { kind: "site", affectedUrlCount: pages.length, exampleUrls: examples }, key: "site", text: `the affected pages (for example ${examples.join(", ")})` };
  }

  // ---------------------------------------------------------------- access: AI answer/search crawler blocked
  async access(blocked: Array<{ token: string; vendor: string }>, advice: RobotsAdvice): Promise<GeoCandidate | null> {
    const reread = advice.state === "ready" || advice.state === "not_found";
    let tokens = blocked.map((b) => b.token);
    if (reread) tokens = tokens.filter((t) => advice.current.find((c) => c.token.toLowerCase() === t.toLowerCase())?.allowed === false);
    if (tokens.length === 0) return null;
    const who = tokens.join(", ");
    const vendors = new Set(blocked.filter((b) => tokens.includes(b.token)).map((b) => b.vendor.toLowerCase()));
    // Tie to sampled answers from the same vendor's API (e.g. PerplexityBot <-> Perplexity) that did not cite the brand.
    const tied = this.inp.obs.filter((o) => vendors.has(o.provider.toLowerCase()) && (this.selfOf(o.id)?.cited ?? 0) === 0);
    const s = advice.suggestion;
    const snippet = s?.suggestedRobotsTxt ?? null;
    const preserved = s?.preservedRules ?? [];
    const training = advice.training;
    const item = this.sig.items.geo.find((i) => i.id === "geo.access.ai_search_bots_allowed");
    const fetchedDay = advice.fetchedAt.slice(0, 10);
    const evidence: ChecklistEvidenceSpec[] = [
      {
        source: "crawl",
        refId: this.sig.data.crawl?.id ?? null,
        window: this.crawlDay,
        text: `Checklist: ${item?.label ?? "Allow AI search bots in robots.txt"} — ${item?.summary ?? `blocked: ${who}.`}`,
        data: {
          checklistItemId: "geo.access.ai_search_bots_allowed",
          checklistKind: "geo",
          checklistVersion: CHECKLIST_VERSION,
          status: item?.status ?? "not_met",
          method: "measured",
          urls: advice.url ? [advice.url] : [],
          blocked: tokens,
          brand: this.inp.brandName,
          pairs: distinctPairs(tied),
        },
      },
    ];
    if (reread && s) {
      evidence.push({
        source: "crawl",
        refId: null,
        window: fetchedDay,
        text: `robots.txt re-read from ${advice.url} on ${fetchedDay} (RFC 9309 group selection): ${who} blocked at the site root. The suggestion gives each AI answer/search and search-engine crawler its own group that repeats ${preserved.length} rule(s) from the "*" group; training crawlers keep their current rules${training.blocked.length ? ` (blocked: ${training.blocked.join(", ")})` : ""}.`,
        data: { url: advice.url, fetchedAt: advice.fetchedAt, rfc: "RFC 9309", preservedRules: preserved, changes: s.changes, warnings: s.warnings, training, review: ADVISOR_REVIEW_LABEL, cdn: CDN_WARNING },
      });
    } else {
      evidence.push({
        source: "crawl",
        refId: null,
        window: fetchedDay,
        text: `robots.txt could not be re-read during this run${advice.error ? ` (${clip(advice.error, 160)})` : ""}, so no suggested robots.txt was built.`,
        data: { url: advice.url, error: advice.error, review: ADVISOR_REVIEW_LABEL, cdn: CDN_WARNING },
      });
    }
    const example = preserved.find((r) => /^Disallow:/i.test(r))?.replace(/^Disallow:\s*/i, "") ?? null;
    const trainingText = training.blocked.length ? `training crawlers keep their current rules (still blocked: ${training.blocked.join(", ")})` : "training crawlers keep their current rules";
    const action = snippet
      ? `Review the suggested robots.txt and apply it through your platform's supported method: it gives ${who} a group that allows the site and repeats your existing "*" rules${example ? ` (such as ${example})` : ""}, and ${trainingText}. Then check your CDN or WAF bot settings for these crawlers [confirm: CDN/WAF bot settings reviewed] [confirm: that these AI services may fetch your pages].`
      : `Remove the rule that disallows the site root for ${who}, repeating your existing "*" rules in any group you add for it; ${trainingText}. Check your CDN or WAF bot settings too [confirm: current robots.txt] [confirm: CDN/WAF bot settings reviewed].`;
    const limitationParts = [ADVISOR_REVIEW_LABEL, CDN_WARNING];
    if (preserved.length) limitationParts.push(`Kept from "*": ${preserved.join(", ")}.`);
    if (!snippet) limitationParts.push("No suggested robots.txt: the file could not be re-read during this run.");
    let limitations = "";
    for (const part of limitationParts) {
      const next = limitations ? `${limitations} ${part}` : part;
      if (next.length > 400) break;
      limitations = next;
    }
    const summary = `robots.txt disallows the site root for ${who} (AI answer/search crawler); propose the robots.txt advisor's suggestion, which allows it while keeping the site's "*" rules and its current training-crawler policy.`;
    return {
      dedupKey: await dedupKey(this.pid, "geo.access.ai_search_bots_allowed", "site"),
      issueType: "geo_checklist:geo.access.ai_search_bots_allowed",
      summary,
      observations: tied,
      pairs: distinctPairs(tied),
      latestAt: latestOf(tied, this.sig.data.crawl?.finishedAt ?? this.ctx.clock().toISOString()),
      scope: "site",
      target: { kind: "site" },
      entity: null,
      prompts: [...new Set(tied.map((o) => o.prompt_text))],
      competitors: [],
      checklist: {
        itemIds: ["geo.access.ai_search_bots_allowed"],
        checklistVersion: CHECKLIST_VERSION,
        requiresJev: false,
        severity: 1,
        reach: 1,
        evidence,
        observationEvidence: this.obsEvidence(tied),
        draft: {
          trigger: clip(`AI answer/search crawler blocked in robots.txt: ${who}`, 200),
          issue: clip(`robots.txt disallows the site root for ${who}, so ${tokens.length > 1 ? "these AI services are" : "this AI service is"} asked not to fetch any page of the site.`, 400),
          action: clip(action, 600),
          rationale: clip(
            `A crawler that is disallowed in robots.txt is asked not to fetch your pages, so that service's search features have no fresh copy of them to draw on; allowing it is a precondition only, and inclusion is not promised. Blocking training crawlers is a business choice and stays as it is.`,
            600,
          ),
          limitations,
          snippet,
          snippetKind: snippet ? "robots" : null,
          effort: "low",
          uncertainty: "low",
          verified: reread,
        },
      },
    };
  }

  // ---------------------------------------------------------------- structure / trust (+ login walls)
  async structureTrust(gap: ChecklistGap, route: StructureRoute): Promise<GeoCandidate | null> {
    const affected = gap.affected ?? [];
    const affectedUrls = new Set(affected.map((a) => normalizeUrlKey(a.url)));
    const ties = affected.length ? this.ties(affectedUrls) : [];
    if (route.tiedOnly && ties.length === 0) return null;
    const byUrl = new Map(this.snaps.map((s) => [normalizeUrlKey(s.url), s]));
    const tiedPages = [...new Map(ties.map((t) => [normalizeUrlKey(t.page.url), t.page])).values()];
    const pages: Array<{ url: string; pageType: PageType }> = ties.length ? tiedPages.map((p) => ({ url: p.url, pageType: p.pageType })) : affected.map((a) => ({ url: a.url, pageType: a.pageType }));
    const sc = this.scopeOf(pages);
    const tiedObs = [...new Map(ties.map((t) => [t.obs.id, t.obs])).values()];
    const pairs = distinctPairs(tiedObs);
    const prompts = [...new Set(tiedObs.map((o) => o.prompt_text))];
    const evidence: ChecklistEvidenceSpec[] = [this.checklistEvidence(gap, { pairs, scope: sc.scope, targetUrls: pages.map((p) => p.url).slice(0, 10) })];
    if (ties.length) {
      const t = ties[0]!;
      evidence.push({
        source: "rule",
        refId: t.obs.id,
        window: t.obs.created_at.slice(0, 10),
        text: clip(
          `Prompt "${t.obs.prompt_text}": ${this.inp.brandName} absent in API-sampled answers from ${t.obs.provider} (${t.obs.model}); ${t.entity} cited instead via ${t.url} (${t.sourceType.replace(/_/g, " ")}). Closest crawled page by title/H1 words (heuristic): ${t.page.url}. Tied pairs: ${pairs}.`,
          EVIDENCE_TEXT_MAX,
        ),
        data: {
          kind: "checklist_displacement_tie",
          checklistItemId: gap.itemId,
          observationIds: tiedObs.map((o) => o.id).slice(0, 10),
          prompts: prompts.slice(0, 5),
          displacements: ties.slice(0, 5).map((x) => ({ observationId: x.obs.id, entity: x.entity, url: x.url, sourceType: x.sourceType, page: x.page.url, sharedWords: x.shared })),
          matchMethod: "title_h1_token_overlap",
          pairs,
          brand: this.inp.brandName,
        },
      });
    }
    for (const p of pages.slice(0, 2)) {
      const s = byUrl.get(normalizeUrlKey(p.url));
      if (s) evidence.push(this.pageEvidence(s));
    }
    const verified = pages.some((p) => byUrl.has(normalizeUrlKey(p.url)));
    const t0 = ties[0];
    const tieText = t0 ? ` For the buyer prompt "${clip(t0.obs.prompt_text, 120)}", API-sampled answers left ${this.inp.brandName} out and cited ${t0.entity} (${t0.url}, ${t0.sourceType.replace(/_/g, " ")}) instead.` : "";
    const action = `${route.action(sc.text, t0?.obs.prompt_text ?? null)}${t0 ? ` Open ${t0.url} yourself if you want to compare.` : ""}`;
    const reviewNote = verified ? "" : " Review required: no crawl snapshot of the target page is available.";
    const summary = clip(`${gap.label} on ${sc.text} (readiness checklist, ${gap.method})${t0 ? `, tied to ${prompts.length} buyer prompt(s) where ${this.inp.brandName} was absent from API-sampled answers` : ""}.`, 500);
    return {
      dedupKey: await dedupKey(this.pid, gap.itemId, sc.key),
      issueType: `geo_checklist:${gap.itemId}`,
      summary,
      observations: tiedObs,
      pairs,
      latestAt: latestOf(tiedObs, this.sig.data.crawl?.finishedAt ?? this.ctx.clock().toISOString()),
      scope: sc.scope,
      target: sc.target,
      entity: null,
      prompts,
      competitors: [],
      checklist: {
        itemIds: [gap.itemId],
        checklistVersion: gap.checklistVersion,
        requiresJev: route.requiresJev || gap.method === "heuristic",
        severity: gap.method === "measured" && gap.status === "not_met" ? 0.5 : 0.25,
        reach: gap.affectedCount !== null && this.snaps.length > 0 ? Math.min(1, pages.length / this.snaps.length) : null,
        evidence,
        observationEvidence: this.obsEvidence(tiedObs),
        draft: {
          trigger: clip(t0 ? `Provider answers missing ${this.inp.brandName}; checklist: ${gap.label}` : `Checklist gap: ${gap.label}`, 200),
          issue: clip(`${gap.label}: ${gap.summary}${tieText}`, 400),
          action: clip(action, 600),
          rationale: clip(
            t0
              ? `The checklist measured this attribute on your own crawled page, and the prompts it is tied to are ones where ${this.inp.brandName} was absent; cited pages are not fetched here, so this does not explain why an engine chose another source. Clear, verifiable facts give answer engines accurate material, and inclusion is not promised.`
              : `The readiness checklist found this gap on your own crawled pages; clear, verifiable structure and trust signals make pages easier to understand and quote, and inclusion is not promised.`,
            600,
          ),
          limitations: clip(`${t0 ? `${API_LIMITATION} ${A7_NOTE} ` : ""}From the GEO readiness checklist (${gap.checklistVersion}), ${gap.method}. ${gap.caveat ?? ""}${reviewNote}`, 400),
          snippet: null,
          snippetKind: null,
          effort: gap.itemId === "geo.trust.reputable_sources" || gap.itemId === "geo.structure.comparison_tables" ? "medium" : "low",
          uncertainty: gap.method === "heuristic" ? "high" : "medium",
          verified,
        },
      },
    };
  }

  // ---------------------------------------------------------------- mentions: manual outreach list
  async mentions(gaps: ChecklistGap[]): Promise<GeoCandidate | null> {
    if (gaps.length === 0) return null;
    const ecommerce = this.sig.data.project.siteType === "ecommerce";
    const gapIds = new Set(gaps.map((g) => g.itemId));
    const sections: Array<{ label: string; itemId: string; key: MentionSourceKey }> = [
      { label: "Forum and Reddit threads", itemId: "geo.mentions.reddit_threads", key: "forum" },
      { label: "Listicles and roundups", itemId: "geo.mentions.listicles", key: "listicle" },
      { label: ecommerce ? "Review sites and marketplaces" : "Review sites", itemId: "geo.mentions.review_platforms", key: ecommerce ? "reviewOrMarketplace" : "review" },
      { label: "YouTube videos", itemId: "geo.mentions.youtube", key: "youtube" },
      { label: "News and publisher sites", itemId: "geo.mentions.news_coverage", key: "publisher" },
      { label: "Other third-party pages", itemId: "geo.mentions.cited_pages", key: "thirdParty" },
    ];
    const covered = new Set(
      this.obsCandidates
        .filter((c) => c.issueType === "geo_displacement" && c.entity?.url)
        .map((c) => normalizeUrlKey(c.entity!.url!)),
    );
    const listed = new Set<string>();
    const lists: Array<{ label: string; itemId: string; urls: Array<{ url: string; host: string; title: string | null; count: number }> }> = [];
    for (const sec of sections) {
      if (!gapIds.has(sec.itemId)) continue;
      const agg = this.sig.signals.mentionAggregate(sec.key);
      const urls = agg.gapUrls
        .filter((g) => !covered.has(normalizeUrlKey(g.url)) && !listed.has(normalizeUrlKey(g.url)))
        .slice(0, MAX_MENTION_URLS_PER_TYPE);
      if (listed.size + urls.length > MAX_MENTION_URLS) urls.splice(MAX_MENTION_URLS - listed.size);
      for (const u of urls) listed.add(normalizeUrlKey(u.url));
      if (urls.length) lists.push({ label: sec.label, itemId: sec.itemId, urls: urls.map((u) => ({ url: u.url, host: u.host, title: u.title, count: u.count })) });
    }
    if (lists.length === 0) return null;
    // Answers (API, valid) that cited a listed URL and did not mention the brand.
    const selfMentioned = this.sig.signals.selfMentioned();
    const valid = new Set(this.sig.signals.validObs().map((o) => o.id));
    const obsIds = new Set(
      this.sig.data.geo.citations.filter((c) => listed.has(normalizeUrlKey(c.url)) && valid.has(c.observationId) && !selfMentioned.has(c.observationId)).map((c) => c.observationId),
    );
    const tied = this.inp.obs.filter((o) => obsIds.has(o.id));
    const pairs = tied.length ? distinctPairs(tied) : obsIds.size;
    const evidence: ChecklistEvidenceSpec[] = lists.map((l) => {
      const gap = gaps.find((g) => g.itemId === l.itemId)!;
      return this.checklistEvidence(gap, {
        urls: l.urls.map((u) => u.url),
        sources: l.urls.map((u) => ({ url: u.url, host: u.host, title: u.title, answersWithoutBrand: u.count })),
        listLabel: l.label,
        urlCount: l.urls.length,
        answers: obsIds.size,
        pairs,
      });
    });
    const snippet = [
      `Third-party sources cited in API-sampled answers that did not mention ${this.inp.brandName} (manual review list):`,
      ...lists.flatMap((l) => [``, `${l.label}:`, ...l.urls.map((u) => `- ${u.url}: cited in ${u.count} answer(s) without you`)]),
      ``,
      MANUAL_ONLY,
    ].join("\n");
    const typeList = lists.map((l) => `${l.label.toLowerCase()} (${l.urls.length})`).join(", ");
    const summary = clip(`Manual outreach list of third-party sources that API-sampled answers cite without ${this.inp.brandName}: ${typeList}. Review each page and pursue accurate inclusion where the brand genuinely fits.`, 500);
    return {
      dedupKey: await dedupKey(this.pid, "geo.mentions", "site"),
      issueType: "geo_checklist:geo.mentions",
      summary,
      observations: tied,
      pairs,
      latestAt: latestOf(tied, this.ctx.clock().toISOString()),
      scope: "site",
      target: { kind: "site" },
      entity: null,
      prompts: [...new Set(tied.map((o) => o.prompt_text))],
      competitors: [],
      checklist: {
        itemIds: lists.map((l) => l.itemId),
        checklistVersion: CHECKLIST_VERSION,
        requiresJev: false,
        severity: 0.25,
        reach: null,
        evidence,
        observationEvidence: this.obsEvidence(tied),
        draft: {
          trigger: clip(`Third-party sources AI answers cite without ${this.inp.brandName}`, 200),
          issue: clip(`API-sampled answers cited these third-party sources (${typeList}) in answers that did not mention ${this.inp.brandName}.`, 400),
          action: clip(
            `Work through the list below by hand. For each page, check whether ${this.inp.brandName} genuinely fits; where it does, send the editor or community accurate product facts through the site's own process, with your affiliation disclosed, and ask real customers for honest reviews on the review sites listed [confirm: which sources are relevant to your products] [confirm: the product facts you can verify]. ${MANUAL_ONLY}`,
            600,
          ),
          rationale: clip(
            `These pages already appear in answers for your prompts while ${this.inp.brandName} does not; they are a starting list for genuine, manual outreach. Being named on them is not promised, and cited pages are not fetched here.`,
            600,
          ),
          limitations: clip(`${API_LIMITATION} ${MANUAL_ONLY} Never write, buy, or incentivize reviews, and never post from fake accounts.`, 400),
          snippet,
          snippetKind: "list",
          effort: "high",
          uncertainty: "high",
          verified: false,
        },
      },
    };
  }
}

// ------------------------------------------------------------------ drafting at selection time
export interface ChecklistProposalDraft {
  trigger: string;
  issue: string;
  action: string;
  rationale: string;
  suggestedSnippet: string | null;
  effort: Level;
  uncertainty: Level;
  limitations: string;
  confirmPlaceholders: string[];
  evidenceIds: string[];
  bullets: EvidenceBullet[];
  verified: boolean;
  writer: null;
}

/**
 * Create the plan's evidence rows, cite them in the code-generated text, and run validateDraft plus the
 * GEO claim guard (`guard`, geoClaimViolations). Returns validation_failed without saving on any error.
 */
export async function draftChecklistProposal(
  ctx: RunContext,
  c: GeoCandidate & { checklist: GeoChecklistPlan },
  guard: (text: string) => string[],
): Promise<{ ok: true; draft: ChecklistProposalDraft } | { ok: false; reason: "validation_failed" | "insufficient_evidence"; errors: string[] }> {
  const plan = c.checklist;
  const created: Array<{ id: string; spec: ChecklistEvidenceSpec }> = [];
  for (const spec of plan.evidence) {
    const id = await createEvidence(ctx, { source: spec.source, refId: spec.refId, window: spec.window, text: spec.text, data: spec.data });
    created.push({ id, spec });
  }
  if (created.length === 0) return { ok: false, reason: "insufficient_evidence", errors: ["no checklist evidence"] };
  const obsEv = plan.observationEvidence;
  const ids = [...created.map((e) => e.id), ...obsEv.map((e) => e.id)];
  const cite = (xs: string[]) => xs.map((id) => `[${id}]`).join("");
  const primary = created[0]!.id;
  const second = created[1]?.id ?? obsEv[0]?.id ?? null;
  const d = plan.draft;
  const text = {
    trigger: d.trigger,
    issue: clip(`${d.issue} ${cite([primary])}`, 400),
    action: clip(`${d.action} ${cite(second ? [second] : [primary])}`, 600),
    rationale: clip(`${d.rationale} ${cite(ids.slice(0, 3))}`, 600),
    limitations: d.limitations,
  };
  const validation: ValidationEvidence[] = [
    ...created.map((e) => ({ id: e.id, text: e.spec.text.slice(0, EVIDENCE_TEXT_MAX), data: { window: e.spec.window, data: e.spec.data } })),
    ...obsEv.map((e) => ({ id: e.id, text: e.text, data: parseJson(e.data_json, {}) })),
  ];
  // A robots.txt snippet is the site's own file plus suggested groups, not prose: it is not claim-checked.
  const fields = [text.trigger, text.issue, text.action, text.rationale, text.limitations, d.snippetKind === "list" ? (d.snippet ?? "") : ""];
  const check = validateDraft(fields, ids, validation);
  const violations = guard(fields.join("\n"));
  if (!check.ok || violations.length > 0) return { ok: false, reason: "validation_failed", errors: [...check.errors, ...violations] };
  const bullets: EvidenceBullet[] = [
    ...created.map((e) => ({ evidenceId: e.id, source: e.spec.source, text: e.spec.text.length > 300 ? `${e.spec.text.slice(0, 299)}…` : e.spec.text })),
    ...obsEv.map((e) => ({ evidenceId: e.id, source: e.source, text: e.text.slice(0, 300) })),
  ].slice(0, 4);
  return {
    ok: true,
    draft: {
      ...text,
      suggestedSnippet: d.snippet,
      effort: d.effort,
      uncertainty: d.uncertainty,
      confirmPlaceholders: check.confirmPlaceholders,
      evidenceIds: ids,
      bullets,
      verified: d.verified,
      writer: null,
    },
  };
}
