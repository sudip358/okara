/**
 * generateGeoProposals: zero to two evidence-backed GEO proposals per day.
 *
 * Candidates (code, from analyzed API observations in each provider's latest cohort, last 30 days):
 *   geo_displacement            a displacing entity/URL recurring across >= 2 prompt x provider pairs [A1]
 *   geo_missing_from_answer     a discovery prompt where the brand is absent and a competitor is recommended
 *   geo_inconsistent_positioning passages about the brand with negative/mixed sentiment or negative treatment
 *   geo_evidence_gap            the brand is mentioned in grounded answers but its own domain is not cited
 * Judgement: Jev `geo.proposal_fit` (Score, one batched call) when a DecisionProvider and a positioning
 * document exist. Act/Flag answers are used; a low fit (levels 1-2) rejects the candidate; Drop withholds
 * the value and the deterministic priority is used.
 * Priority (code, GEO_PRIORITY_VERSION): frequency = min(pairs, 10) / 10; recency = 1 - age_days / 30
 * (floored at 0); fit = score / 4 when usable.
 *   with fit:    100 * (0.6 * frequency + 0.2 * recency + 0.2 * fit)
 *   without fit: 100 * (0.75 * frequency + 0.25 * recency)
 * Drafting: the writer (GEO_WRITER_SYSTEM + recommendation.v1 schema) drafts from untainted evidence
 * only; the draft must pass validateDraft and a GEO guarantee/prediction guard, else the deterministic
 * template is used (and a validation_failed decision is recorded). Templates never claim FAQ schema,
 * llms.txt, IndexNow, or any change guarantees inclusion, and never predict citation likelihood.
 * [A7] side-by-side is only possible for a cited URL the user approved for a single fetch; no such
 * snapshot mechanism exists yet, so page-change proposals are verified only when our target page has a
 * crawl snapshot (cited as 'crawl' evidence with observable attributes only, and passed to the writer
 * as PAGE_EVIDENCE), otherwise verified=false with "review required". The writer can never upgrade
 * verification.
 * Selection: eligible candidates in priority order until the day's remaining slots are filled; a
 * candidate without observation evidence is rejected (insufficient_evidence) and frees its slot.
 * Every candidate gets a decision record: selected, or rejected with duplicate | low_fit |
 * decision_unavailable | budget | daily_cap | insufficient_evidence; a writer draft that was not used
 * gets a `<dedupKey>:draft` record (validation_failed, or the writer failure reason).
 *
 * [A21] Readiness-checklist candidates (checklist-proposals.ts: blocked AI answer/search crawlers with the
 * robots.txt advisor snippet, structure/trust gaps tied to displaced prompts, and one manual mentions
 * list) join the same dedup, Jev proposal_fit, daily cap, and decision_records flow. They are drafted by
 * code templates (validateDraft + GEO claim guard) and prioritized with GEO_CHECKLIST_PRIORITY_VERSION;
 * heuristic ones without a usable fit answer are rejected (decision_unavailable when Jev is not asked).
 */
import type { EvidenceBullet, EvidenceSource, Level, SourceType, Tier } from "@shared/types";
import type { RunContext } from "../runs/context";
import type { DecisionAnswer } from "../providers/types";
import { POLICY_VERSION, tierFor } from "../runs/policy";
import { hashJson } from "../lib/hash";
import { newId } from "../lib/ids";
import { iso } from "../lib/time";
import { parseJson } from "../lib/db";
import { BudgetExceededError } from "../lib/errors";
import { createEvidence, EVIDENCE_TEXT_MAX } from "../recommendations/evidence";
import { isDuplicate, remainingToday, saveRecommendation, type RecommendationDraft } from "../recommendations/store";
import { validateDraft } from "../writing/validate";
import { GEO_WRITER_SYSTEM } from "../writing/prompts";
import { RECOMMENDATION_V1_JSON_SCHEMA, recommendationOutputSchema, recommendationTextFields, toProviderSchema, type RecommendationOutput } from "../writing/schemas";
import { GEO_QUESTION_IDS, PROPOSAL_FIT_LEVELS, geoQuestion, geoQuestionVersion } from "./questions";
import { buildGeoChecklistCandidates, draftChecklistProposal, GEO_CHECKLIST_PRIORITY_VERSION, geoChecklistPriority, type GeoChecklistPlan } from "./checklist-proposals";
import { isSourceType } from "./source-type";

export interface GeoProposalSummary {
  candidates: number;
  created: number;
  rejected: number;
  note: string;
}

export const GEO_PRIORITY_VERSION = "geo-priority-2026-09-30.1";
export const PROPOSAL_WINDOW_DAYS = 30;
const MAX_FIT_QUESTIONS = 10;
const RECURRING_MIN = 2;

type IssueType = "geo_displacement" | "geo_missing_from_answer" | "geo_inconsistent_positioning" | "geo_evidence_gap";

export interface ObsLite {
  id: string;
  provider: string;
  model: string;
  prompt_id: string | null;
  prompt_text: string;
  prompt_type: string;
  cohort_key: string;
  grounded: number;
  created_at: string;
}

export interface BrandLite {
  observation_id: string;
  brand_key: string;
  is_self: number;
  mentioned: number;
  cited: number;
  recommendation_status: string;
  sentiment: string;
}

export interface EvidenceLite {
  id: string;
  ref_id: string;
  source: EvidenceSource;
  text: string;
  data_json: string;
  tainted: number;
  window: string | null;
}

export interface GeoCandidate {
  dedupKey: string;
  issueType: IssueType | `geo_checklist:${string}`;
  summary: string;
  observations: ObsLite[];
  pairs: number;
  latestAt: string;
  scope: "page" | "template" | "site";
  target: RecommendationDraft["target"];
  entity: { name: string; url: string | null; sourceType: SourceType } | null;
  prompts: string[];
  competitors: string[];
  /** [A21] Set for readiness-checklist candidates (checklist-proposals.ts). */
  checklist?: GeoChecklistPlan;
}

interface Scored extends GeoCandidate {
  priority: number;
  fit: { answer: DecisionAnswer | undefined; tier: Tier; asked: boolean };
}

const pairKey = (o: ObsLite) => `${o.prompt_id ?? o.prompt_text}\u0000${o.provider}`;

function distinctPairs(obs: ObsLite[]): number {
  return new Set(obs.map(pairKey)).size;
}

function latest(obs: ObsLite[]): string {
  return obs.map((o) => o.created_at).sort().at(-1) ?? "";
}

function shortHash(s: string): Promise<string> {
  return hashJson(s).then((h) => h.slice(0, 16));
}

export function geoPriority(pairs: number, ageDays: number, fit: number | null): number {
  const frequency = Math.min(pairs, 10) / 10;
  const recency = Math.max(0, 1 - ageDays / PROPOSAL_WINDOW_DAYS);
  const raw = fit === null ? 0.75 * frequency + 0.25 * recency : 0.6 * frequency + 0.2 * recency + 0.2 * fit;
  return Math.round(raw * 1000) / 10;
}

interface GeoClaimRule {
  label: string;
  /** Global + indices flags. */
  pattern: RegExp;
  /**
   * Capture group holding the guarantee verb. A negation right before it ("does not guarantee",
   * "without any guarantee") is a disclaimer, not a claim, so the match is ignored (same semantics as
   * validateDraft's negated-guarantee warning). Rules without a verb group are never softened:
   * predicting citation likelihood is not allowed in any form, negated or not.
   */
  verbGroup?: number;
}

const GEO_CLAIM_RULES: GeoClaimRule[] = [
  {
    label: "claims a format change guarantees inclusion",
    pattern: /\b(?:faq schema|llms\.txt|indexnow|schema markup|structured data)\b[^.]{0,80}?\b(guarantee[sd]?|guaranteeing|ensures?|ensuring|will (?:get|be|make)|secures?)\b/dgi,
    verbGroup: 1,
  },
  {
    label: "guarantees inclusion or citation",
    pattern: /\b(guarantee[sd]?|guaranteeing|ensures?|ensuring)\b[^.]{0,60}?\b(?:inclusion|included|cited|citations?|mentions?|mentioned|appear(?:s|ance)?)\b/dgi,
    verbGroup: 1,
  },
  { label: "predicts citation likelihood", pattern: /\b(?:likely|likelihood|probability|chance|odds)\b[^.]{0,40}\b(?:cited|citations?|mentioned|included|recommended)\b/dgi },
  { label: "predicts a citation outcome", pattern: /\bwill (?:be|get) (?:cited|mentioned|recommended|included)\b/dgi },
  { label: "names a consumer surface for API-sampled evidence", pattern: /\b(?:ChatGPT|Google AI Overviews?) (?:shows?|says|displays?)\b/dgi },
];

const NEGATED_BEFORE = /\b(?:not|no|never|cannot|can['’]t|doesn['’]t|don['’]t|won['’]t|isn['’]t|aren['’]t|without|nor)\b(?:\s+\w+){0,2}\s*$/i;
const NOT_ONLY_BEFORE = /\bnot\s+only\s*$/i;

/** GEO-specific guard on top of validateDraft: no inclusion guarantees, no citation predictions. */
export function geoClaimViolations(text: string): string[] {
  const out: string[] = [];
  for (const rule of GEO_CLAIM_RULES) {
    for (const m of text.matchAll(rule.pattern)) {
      if (rule.verbGroup !== undefined) {
        const verbStart = m.indices?.[rule.verbGroup]?.[0] ?? m.index;
        const before = text.slice(Math.max(0, verbStart - 40), verbStart);
        if (NEGATED_BEFORE.test(before) && !NOT_ONLY_BEFORE.test(before)) continue;
      }
      out.push(rule.label);
      break;
    }
  }
  return out;
}

async function loadInputs(ctx: RunContext) {
  const ws = ctx.project.workspaceId;
  const pid = ctx.project.id;
  const since = iso(new Date(ctx.clock().getTime() - PROPOSAL_WINDOW_DAYS * 86400_000));
  // Custom GEO engine lanes (custom_geo:<id>): only answers with provider-reported sources (grounded = 1) are
  // inputs, like any grounded answer; their answers without sources count toward mention rate only
  // (geo/custom-lanes.ts) and never create proposals.
  const all = await ctx.db.all<ObsLite>(
    `SELECT id, provider, model, prompt_id, prompt_text, prompt_type, cohort_key, grounded, created_at FROM geo_observations
      WHERE workspace_id = ? AND project_id = ? AND measurement_type = 'api' AND status = 'ok' AND created_at >= ?
        AND (substr(provider, 1, 11) <> 'custom_geo:' OR grounded = 1)
      ORDER BY created_at DESC LIMIT 1000`,
    ws,
    pid,
    since,
  );
  // Latest cohort per provider only (no cross-cohort aggregation).
  const latestCohort = new Map<string, string>();
  for (const o of all) if (!latestCohort.has(o.provider)) latestCohort.set(o.provider, o.cohort_key);
  const obs = all.filter((o) => latestCohort.get(o.provider) === o.cohort_key);
  const ids = new Set(obs.map((o) => o.id));
  const brands = (
    await ctx.db.all<BrandLite>(
      "SELECT observation_id, brand_key, is_self, mentioned, cited, recommendation_status, sentiment FROM geo_brand_observations WHERE workspace_id = ? AND project_id = ?",
      ws,
      pid,
    )
  ).filter((b) => ids.has(b.observation_id));
  const disps = (
    await ctx.db.all<{ observation_id: string; entity: string; url: string | null; source_type: string }>(
      "SELECT observation_id, entity, url, source_type FROM geo_displacements WHERE workspace_id = ? AND project_id = ? ORDER BY rowid",
      ws,
      pid,
    )
  ).filter((d) => ids.has(d.observation_id));
  const selfCitations = (
    await ctx.db.all<{ observation_id: string; url: string }>(
      "SELECT observation_id, url FROM geo_citations WHERE workspace_id = ? AND project_id = ? AND brand_key = 'self'",
      ws,
      pid,
    )
  ).filter((c) => ids.has(c.observation_id));
  const evidence = (
    await ctx.db.all<EvidenceLite>(
      "SELECT id, ref_id, source, text, data_json, tainted, window FROM evidence WHERE workspace_id = ? AND project_id = ? AND source = 'geo_observation' ORDER BY created_at",
      ws,
      pid,
    )
  ).filter((e) => ids.has(e.ref_id));
  const project = await ctx.db.first<{ brand_name: string; is_demo: number }>("SELECT brand_name, is_demo FROM projects WHERE id = ? AND workspace_id = ?", pid, ws);
  const positioning = await ctx.db.first<{ id: string; version: number; content: string }>(
    "SELECT id, version, content FROM context_documents WHERE workspace_id = ? AND project_id = ? AND kind = 'positioning' ORDER BY version DESC LIMIT 1",
    ws,
    pid,
  );
  return { obs, brands, disps, selfCitations, evidence, brandName: project?.brand_name ?? "the brand", isDemo: project?.is_demo === 1, positioning };
}

/** Build candidates from analyzed observations (exported for tests). */
export async function buildCandidates(input: Awaited<ReturnType<typeof loadInputs>>): Promise<GeoCandidate[]> {
  const { obs, brands, disps, selfCitations } = input;
  const byId = new Map(obs.map((o) => [o.id, o]));
  const brandsOf = (id: string) => brands.filter((b) => b.observation_id === id);
  const selfOf = (id: string) => brandsOf(id).find((b) => b.is_self === 1);
  const out: GeoCandidate[] = [];

  // a. displacement: recurring displacing entity/URL across discovery prompts x providers
  const dAgg = new Map<string, { entity: string; url: string | null; sourceType: SourceType; obs: ObsLite[] }>();
  for (const d of disps) {
    const o = byId.get(d.observation_id);
    if (!o || o.prompt_type !== "discovery") continue;
    const k = `${d.entity}\u0000${d.url ?? ""}`;
    if (!dAgg.has(k)) dAgg.set(k, { entity: d.entity, url: d.url, sourceType: isSourceType(d.source_type) ? d.source_type : "other", obs: [] });
    const a = dAgg.get(k)!;
    if (!a.obs.some((x) => x.id === o.id)) a.obs.push(o);
  }
  for (const a of dAgg.values()) {
    const pairs = distinctPairs(a.obs);
    if (pairs < RECURRING_MIN) continue;
    out.push({
      dedupKey: `geo:geo_displacement:${await shortHash(`${a.entity}|${a.url ?? ""}`)}`,
      issueType: "geo_displacement",
      summary: `${a.entity}${a.url ? ` (${a.url}, ${a.sourceType})` : ""} appeared instead of the brand in ${pairs} API-sampled prompt/provider pairs; propose reviewing that source and adding genuine comparison or fact content to the brand's own pages.`,
      observations: a.obs,
      pairs,
      latestAt: latest(a.obs),
      scope: "site",
      target: { kind: "site" },
      entity: { name: a.entity, url: a.url, sourceType: a.sourceType },
      prompts: [...new Set(a.obs.map((o) => o.prompt_text))],
      competitors: [],
    });
  }

  // b. missing from answer: self absent, a competitor recommended (per discovery prompt)
  const mAgg = new Map<string, { obs: ObsLite[]; competitors: Set<string> }>();
  for (const o of obs) {
    if (o.prompt_type !== "discovery") continue;
    const self = selfOf(o.id);
    if (!self || self.mentioned === 1 || self.cited === 1) continue;
    const recs = brandsOf(o.id).filter((b) => b.is_self === 0 && b.mentioned === 1 && b.recommendation_status === "recommended");
    if (recs.length === 0) continue;
    const k = o.prompt_id ?? o.prompt_text;
    if (!mAgg.has(k)) mAgg.set(k, { obs: [], competitors: new Set() });
    mAgg.get(k)!.obs.push(o);
    for (const r of recs) mAgg.get(k)!.competitors.add(r.brand_key);
  }
  for (const [k, a] of mAgg) {
    const prompt = a.obs[0]!.prompt_text;
    const comps = [...a.competitors];
    out.push({
      dedupKey: `geo:geo_missing_from_answer:${await shortHash(k)}`,
      issueType: "geo_missing_from_answer",
      summary: `For the buyer prompt "${prompt}", API-sampled answers recommended ${comps.join(", ")} but did not mention the brand; propose clarifying the specific product facts that answer this question on the brand's pages.`,
      observations: a.obs,
      pairs: distinctPairs(a.obs),
      latestAt: latest(a.obs),
      scope: "site",
      target: { kind: "site" },
      entity: null,
      prompts: [prompt],
      competitors: comps,
    });
  }

  // c. inconsistent positioning: negative / mixed passages about the brand
  const neg = obs.filter((o) => {
    const s = selfOf(o.id);
    return s && s.mentioned === 1 && (s.sentiment === "negative" || s.sentiment === "mixed" || s.recommendation_status === "mentioned_negatively");
  });
  if (neg.length > 0) {
    const urls = [...new Set(selfCitations.filter((c) => neg.some((o) => o.id === c.observation_id)).map((c) => c.url))];
    out.push({
      dedupKey: `geo:geo_inconsistent_positioning:${urls[0] ? await shortHash(urls[0]) : "site"}`,
      issueType: "geo_inconsistent_positioning",
      summary: `API-sampled answers described the brand negatively or with mixed sentiment in ${distinctPairs(neg)} prompt/provider pairs; propose reviewing how the brand's positioning is stated on its own pages.`,
      observations: neg,
      pairs: distinctPairs(neg),
      latestAt: latest(neg),
      scope: urls[0] ? "page" : "site",
      target: urls[0] ? { kind: "url", url: urls[0] } : { kind: "site" },
      entity: null,
      prompts: [...new Set(neg.map((o) => o.prompt_text))],
      competitors: [],
    });
  }

  // d. evidence gap: mentioned in grounded answers without a citation to the brand's domain
  const gap = obs.filter((o) => {
    const s = selfOf(o.id);
    return o.grounded === 1 && s && s.mentioned === 1 && s.cited === 0;
  });
  if (distinctPairs(gap) >= RECURRING_MIN) {
    out.push({
      dedupKey: "geo:geo_evidence_gap:site",
      issueType: "geo_evidence_gap",
      summary: `Grounded API-sampled answers mentioned the brand in ${distinctPairs(gap)} prompt/provider pairs without citing its own domain; propose making the facts those answers state verifiable on the brand's pages.`,
      observations: gap,
      pairs: distinctPairs(gap),
      latestAt: latest(gap),
      scope: "site",
      target: { kind: "site" },
      entity: null,
      prompts: [...new Set(gap.map((o) => o.prompt_text))],
      competitors: [],
    });
  }
  return out;
}

interface SnapshotAttributesRow {
  id: string;
  fetched_at: string;
  word_count: number | null;
  first_paragraph: string | null;
  author: string | null;
  last_updated: string | null;
  outbound_citations: number | null;
  table_count: number | null;
  jsonld_types_json: string;
}

const JSONLD_TYPE = /^[A-Za-z][A-Za-z0-9:_-]{0,60}$/;

/**
 * Crawl evidence for OUR target page (latest usable snapshot), as observable attributes only ([A7]
 * list): first paragraph present, named author, visible last-updated date, outbound source links,
 * tables, word count, structured data types. No page prose is copied, so nothing from the page can
 * reach the writer as text. Returns null when the page has not been crawled.
 */
async function crawlPageEvidence(ctx: RunContext, url: string): Promise<EvidenceLite | null> {
  const s = await ctx.db.first<SnapshotAttributesRow>(
    `SELECT s.id, s.fetched_at, s.word_count, s.first_paragraph, s.author, s.last_updated, s.outbound_citations, s.table_count, s.jsonld_types_json
       FROM page_snapshots s JOIN pages p ON p.id = s.page_id AND p.workspace_id = s.workspace_id
      WHERE s.workspace_id = ? AND s.project_id = ? AND p.url = ? AND s.skipped_reason IS NULL
      ORDER BY s.fetched_at DESC LIMIT 1`,
    ctx.project.workspaceId,
    ctx.project.id,
    url,
  );
  if (!s) return null;
  const types = parseJson<unknown[]>(s.jsonld_types_json, [])
    .filter((t): t is string => typeof t === "string" && JSONLD_TYPE.test(t))
    .slice(0, 10);
  const present = (v: string | null) => (v && v.trim() ? "present" : "absent");
  const count = (n: number | null) => (n === null ? "unknown" : String(n));
  const day = s.fetched_at.slice(0, 10);
  const data = {
    kind: "page_attributes",
    url,
    snapshotId: s.id,
    fetchedAt: s.fetched_at,
    firstParagraph: present(s.first_paragraph),
    namedAuthor: present(s.author),
    visibleLastUpdated: present(s.last_updated),
    outboundSourceLinks: s.outbound_citations,
    tables: s.table_count,
    wordCount: s.word_count,
    structuredDataTypes: types,
  };
  const text =
    `Crawled ${url} on ${day}: first paragraph ${data.firstParagraph}; named author ${data.namedAuthor}; visible last-updated date ${data.visibleLastUpdated}; ` +
    `outbound source links ${count(s.outbound_citations)}; tables ${count(s.table_count)}; word count ${count(s.word_count)}; structured data types: ${types.join(", ") || "none"}.`;
  const id = await createEvidence(ctx, { source: "crawl", refId: s.id, window: day, text, data });
  return { id, ref_id: s.id, source: "crawl", text: text.slice(0, EVIDENCE_TEXT_MAX), data_json: JSON.stringify(data), tainted: 0, window: day };
}

function ageDays(now: Date, at: string): number {
  const t = Date.parse(at);
  return Number.isFinite(t) ? Math.max(0, (now.getTime() - t) / 86400_000) : PROPOSAL_WINDOW_DAYS;
}

interface Draft {
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
  writer: { provider: string; model: string } | null;
}

const A7_LIMITATION = "No side-by-side comparison: a cited third-party page is fetched only after you approve that single URL.";
const API_LIMITATION = "Based on API-sampled answers from the listed providers/models; not consumer-app answers or Google AI Overviews, and not proof of what every user sees.";

function providersLabel(c: GeoCandidate): string {
  return [...new Set(c.observations.map((o) => `${o.provider} (${o.model})`))].join(", ");
}

/** Deterministic, code-generated proposal text (no model involved). */
export function templateDraft(c: GeoCandidate, brand: string, evidence: EvidenceLite[], verified: boolean): Draft {
  const ids = evidence.map((e) => e.id);
  const bullets = evidence.slice(0, 4).map((e) => ({ evidenceId: e.id, source: e.source, text: e.text.slice(0, 300) }));
  const prompt = c.prompts[0] ?? "";
  const reviewNote = verified ? "" : " Review required: no crawl snapshot of the target page is available.";
  const base = {
    evidenceIds: ids,
    bullets,
    verified,
    writer: null,
    suggestedSnippet: null,
  };
  switch (c.issueType) {
    case "geo_displacement": {
      const e = c.entity!;
      return {
        ...base,
        trigger: `Provider answers missing ${brand}; cited instead: ${e.name} via ${e.sourceType}`.slice(0, 200),
        issue: `In API-sampled answers from ${providersLabel(c)}, ${brand} was absent while ${e.name}${e.url ? ` (${e.url})` : ""} appeared instead, across ${c.pairs} prompt/provider pairs.`.slice(0, 400),
        action: `Open ${e.url ?? e.name} manually and note which facts it states about the products in question. Where ${brand}'s own pages do not state the equivalent facts, add them in plain language, for example as a genuine comparison section [confirm: which of your pages covers "${prompt.slice(0, 80)}"] [confirm: the product facts you can verify].`.slice(0, 600),
        rationale: `The same source took the slot in more than one sampled answer, so the answers relied on information that is available elsewhere; this does not show why the engine chose it.`.slice(0, 600),
        effort: "medium",
        uncertainty: "high",
        limitations: `${API_LIMITATION} ${A7_LIMITATION}${reviewNote}`.slice(0, 400),
        confirmPlaceholders: [`which of your pages covers "${prompt.slice(0, 80)}"`, "the product facts you can verify"],
      };
    }
    case "geo_missing_from_answer":
      return {
        ...base,
        trigger: `Provider answers missing ${brand} for "${prompt.slice(0, 120)}"`.slice(0, 200),
        issue: `For "${prompt}", API-sampled answers from ${providersLabel(c)} recommended ${c.competitors.join(", ")} and did not mention ${brand}.`.slice(0, 400),
        action: `Make sure the page that best answers this buyer question states the specific facts a buyer needs (what the product is, who it is for, and the requirement named in the question) [confirm: the page URL] [confirm: the facts that apply to your products].`.slice(0, 600),
        rationale: `Competitors were recommended for this question while ${brand} was absent; stating the relevant facts clearly on your own page gives answer engines accurate material to draw on, without any guarantee of inclusion.`.slice(0, 600),
        effort: "medium",
        uncertainty: "high",
        limitations: `${API_LIMITATION}${reviewNote}`.slice(0, 400),
        confirmPlaceholders: ["the page URL", "the facts that apply to your products"],
      };
    case "geo_inconsistent_positioning":
      return {
        ...base,
        trigger: `Provider answers describe ${brand} negatively or with mixed sentiment`.slice(0, 200),
        issue: `API-sampled answers from ${providersLabel(c)} described ${brand} negatively or with mixed sentiment in ${c.pairs} prompt/provider pairs.`.slice(0, 400),
        action: `Read the quoted passages and compare them with how ${brand}'s positioning is stated on ${c.target.url ?? "your key pages"}. Where the passages rely on outdated or unclear information, update the page to state the current facts [confirm: which statements are inaccurate] [confirm: the current facts].`.slice(0, 600),
        rationale: `The sentiment judgement applies only to the passage about ${brand}, not the whole answer; consistent, current positioning on your own pages is the part you control.`.slice(0, 600),
        effort: "low",
        uncertainty: "high",
        limitations: `${API_LIMITATION}${reviewNote}`.slice(0, 400),
        confirmPlaceholders: ["which statements are inaccurate", "the current facts"],
      };
    case "geo_evidence_gap":
      return {
        ...base,
        trigger: `Grounded answers mention ${brand} without citing its domain`.slice(0, 200),
        issue: `Grounded API-sampled answers from ${providersLabel(c)} mentioned ${brand} without citing its verified domain in ${c.pairs} prompt/provider pairs.`.slice(0, 400),
        action: `Check that the facts these answers state about ${brand} are published and easy to find on your own pages, with a direct answer near the top of the relevant page [confirm: the page URL] [confirm: which stated facts are correct].`.slice(0, 600),
        rationale: `The answers already name ${brand} but cite other sources for it; publishing the same facts on your own pages makes them verifiable, without any guarantee that engines will cite them.`.slice(0, 600),
        effort: "low",
        uncertainty: "high",
        limitations: `${API_LIMITATION}${reviewNote}`.slice(0, 400),
        confirmPlaceholders: ["the page URL", "which stated facts are correct"],
      };
    default:
      // Checklist candidates are drafted by checklist-proposals.ts, never by this template.
      throw new Error(`No template for ${c.issueType}`);
  }
}

async function writerDraft(ctx: RunContext, c: GeoCandidate, evidence: EvidenceLite[], verified: boolean, positioning: { id: string; version: number; content: string } | null): Promise<{ draft: Draft | null; failure: string | null }> {
  if (!ctx.writer) return { draft: null, failure: null };
  const usable = evidence.filter((e) => e.tainted === 0);
  if (usable.length === 0) return { draft: null, failure: "all evidence tainted" };
  const observations = usable
    .filter((e) => parseJson<{ kind?: string }>(e.data_json, {}).kind === "summary")
    .map((e) => {
      const d = parseJson<Record<string, unknown>>(e.data_json, {});
      const self = Array.isArray(d.brands) ? (d.brands as Array<Record<string, unknown>>).find((b) => b.isSelf) : undefined;
      return {
        id: e.id,
        provider: d.provider,
        model: d.model,
        grounded: d.grounded,
        prompt: d.prompt,
        mention_status: self ? { mentioned: self.mentioned, cited: self.cited, recommendation_status: self.recommendationStatus, sentiment: self.sentiment } : null,
        citations: d.citations,
        displacements: d.displacements,
        search_queries: null,
      };
    });
  const input = {
    OBSERVATIONS: observations,
    EVIDENCE: usable.map((e) => ({ id: e.id, source: e.source, window: e.window, text: e.text })),
    PAGE_EVIDENCE: usable
      .filter((e) => e.source === "crawl")
      .map((e) => {
        const d = parseJson<Record<string, unknown>>(e.data_json, {});
        const { kind: _kind, url, ...attributes } = d;
        return { id: e.id, url, attributes };
      }),
    CONTEXT_DOCS: positioning ? [{ id: `ctx_positioning_v${positioning.version}`, kind: "positioning", version: positioning.version, excerpt: positioning.content.slice(0, 1500) }] : [],
    PROPOSAL: { issue_type: c.issueType, summary: c.summary, scope: c.scope, target: c.target, verified },
  };
  let output: RecommendationOutput;
  let meta: { provider: string; model: string };
  try {
    const res = await ctx.writer.write({ purpose: "geo_proposal", system: GEO_WRITER_SYSTEM, input, jsonSchema: toProviderSchema(RECOMMENDATION_V1_JSON_SCHEMA), maxOutputTokens: 1500 });
    const parsed = recommendationOutputSchema.safeParse(res.output);
    if (!parsed.success) return { draft: null, failure: "writer output did not match recommendation.v1" };
    output = parsed.data;
    meta = { provider: res.provider, model: res.model };
  } catch (e) {
    return { draft: null, failure: e instanceof BudgetExceededError ? "writer budget exhausted" : "writer call failed" };
  }
  const allowed = new Set(usable.map((e) => e.id));
  if (output.agent !== "geo") return { draft: null, failure: "writer output agent is not geo" };
  if (output.evidence_ids.some((id) => !allowed.has(id))) return { draft: null, failure: "writer cited evidence outside the supplied set" };
  const cited = usable.filter((e) => output.evidence_ids.includes(e.id));
  const fields = recommendationTextFields(output);
  let validation;
  try {
    validation = validateDraft(fields, output.evidence_ids, cited.map((e) => ({ id: e.id, text: e.text, data: parseJson(e.data_json, {}) })));
  } catch {
    return { draft: null, failure: "validator unavailable" };
  }
  const guard = geoClaimViolations(fields.join("\n"));
  if (!validation.ok || guard.length > 0) return { draft: null, failure: [...validation.errors, ...guard].join("; ").slice(0, 300) || "validation failed" };
  const bullets: EvidenceBullet[] = (output.evidence_bullets ?? [])
    .filter((b) => allowed.has(b.evidence_id))
    .map((b) => ({ evidenceId: b.evidence_id, source: usable.find((e) => e.id === b.evidence_id)!.source, text: b.text }));
  return {
    draft: {
      trigger: output.trigger,
      issue: output.issue,
      action: output.action,
      rationale: output.rationale,
      suggestedSnippet: output.suggested_snippet ?? null,
      effort: output.effort,
      uncertainty: output.uncertainty,
      limitations: output.limitations,
      confirmPlaceholders: [...new Set([...(output.confirm_placeholders ?? []), ...validation.confirmPlaceholders])],
      evidenceIds: output.evidence_ids,
      bullets: bullets.length ? bullets : cited.slice(0, 4).map((e) => ({ evidenceId: e.id, source: e.source, text: e.text.slice(0, 300) })),
      // Never let the writer upgrade verification: code decides from crawl evidence.
      verified: verified && output.verified,
      writer: meta,
    },
    failure: null,
  };
}

export async function generateGeoProposals(ctx: RunContext): Promise<GeoProposalSummary> {
  const remaining = await remainingToday(ctx, "geo");
  if (remaining <= 0) return { candidates: 0, created: 0, rejected: 0, note: "Daily proposal cap reached; no new proposals today." };
  const inputs = await loadInputs(ctx);
  const observationCandidates = await buildCandidates(inputs);
  // [A21] Checklist gaps + robots.txt advisor. Never fatal: without them the run continues as before.
  let checklistCandidates: GeoCandidate[] = [];
  try {
    const cl = await buildGeoChecklistCandidates(ctx, inputs, observationCandidates);
    checklistCandidates = cl.candidates;
    for (const n of cl.notes) await ctx.log.event("geo.proposals", "info", n);
  } catch (e) {
    await ctx.log.event("geo.proposals", "info", `Checklist gaps unavailable this run (${e instanceof Error ? e.message.slice(0, 200) : "error"}); continuing without them.`);
  }
  const candidates = [...observationCandidates, ...checklistCandidates];
  if (candidates.length === 0) return { candidates: 0, created: 0, rejected: 0, note: "No new verified opportunities today." };

  const now = ctx.clock();
  const nowIso = iso(now);
  const ws = ctx.project.workspaceId;
  const pid = ctx.project.id;
  const decisions: Array<[string, ...unknown[]]> = [];
  const fitVersion = await geoQuestionVersion(GEO_QUESTION_IDS.proposalFit);
  const record = (key: string, outcome: "selected" | "rejected", reason: string | null, fit?: { answer: DecisionAnswer | undefined; tier: Tier; asked: boolean }, meta?: { provider: string | null; model: string | null; stateHash: string | null }) => {
    decisions.push([
      `INSERT INTO decision_records (id, workspace_id, project_id, run_id, agent, candidate_key, question_id, question_version, policy_version, provider, model, state_hash, answer_json, tier, outcome, reason_code, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      newId("dec"), ws, pid, ctx.runId, "geo", key, fit?.asked ? GEO_QUESTION_IDS.proposalFit : null, fit?.asked ? fitVersion : null, POLICY_VERSION,
      meta?.provider ?? null, meta?.model ?? null, meta?.stateHash ?? null, fit?.answer ? JSON.stringify(fit.answer) : null, fit?.asked ? fit.tier : "n/a",
      outcome, reason, nowIso,
    ]);
  };

  // Checklist candidates use their own documented formula; the reference tier never enters either.
  const priorityOf = (c: GeoCandidate, fit: number | null) => (c.checklist ? geoChecklistPriority(c.checklist, c.pairs, fit) : geoPriority(c.pairs, ageDays(now, c.latestAt), fit));

  // Deterministic pre-priority, then dedup.
  const live: Scored[] = [];
  let rejected = 0;
  for (const c of candidates.sort((a, b) => priorityOf(b, null) - priorityOf(a, null))) {
    if (await isDuplicate(ctx, c.dedupKey)) {
      record(c.dedupKey, "rejected", "duplicate");
      rejected++;
      continue;
    }
    live.push({ ...c, priority: priorityOf(c, null), fit: { answer: undefined, tier: "n/a", asked: false } });
  }

  // Jev geo.proposal_fit (one batched call) when configured and a positioning document exists.
  let jevMeta: { provider: string | null; model: string | null; stateHash: string | null } = { provider: null, model: null, stateHash: null };
  let jevFailure: "decision_unavailable" | "budget" | null = null;
  const asked = live.slice(0, MAX_FIT_QUESTIONS);
  if (ctx.decisions && inputs.positioning && asked.length > 0) {
    const state = {
      positioning: { version: inputs.positioning.version, text: inputs.positioning.content.slice(0, 3000) },
      proposals: Object.fromEntries(asked.map((c, i) => [`p${i}`, c.summary])),
    };
    jevMeta.stateHash = await hashJson(state);
    try {
      const res = await ctx.decisions.decide({
        purpose: "geo.proposal_fit",
        state,
        questions: Object.fromEntries(asked.map((_, i) => [`fit_p${i}`, geoQuestion(GEO_QUESTION_IDS.proposalFit, `p${i}`)])),
      });
      jevMeta = { ...jevMeta, provider: res.provider, model: res.model };
      asked.forEach((c, i) => {
        const a = res.answers[`fit_p${i}`];
        c.fit = { answer: a, tier: tierFor(GEO_QUESTION_IDS.proposalFit, a), asked: true };
      });
    } catch (e) {
      jevFailure = e instanceof BudgetExceededError ? "budget" : "decision_unavailable";
      jevMeta.provider = ctx.decisions.name;
      for (const c of asked) c.fit = { answer: undefined, tier: "drop", asked: true };
    }
  }

  const eligible: Scored[] = [];
  for (const c of live) {
    if (jevFailure && c.fit.asked) {
      record(c.dedupKey, "rejected", jevFailure, c.fit, jevMeta);
      rejected++;
      continue;
    }
    const a = c.fit.answer;
    let fitNorm: number | null = null;
    if (a && a.type === "score" && (c.fit.tier === "act" || c.fit.tier === "flag")) {
      fitNorm = Math.max(0, Math.min(1, a.score / (PROPOSAL_FIT_LEVELS - 1)));
      if (a.score <= 1) {
        record(c.dedupKey, "rejected", "low_fit", c.fit, jevMeta);
        rejected++;
        continue;
      }
    }
    if (c.checklist?.requiresJev && fitNorm === null) {
      // Heuristic checklist gaps need a usable Jev judgment, like SEO content candidates.
      const reason = c.fit.asked ? "insufficient_evidence" : ctx.decisions && inputs.positioning ? "budget" : "decision_unavailable";
      record(c.dedupKey, "rejected", reason, c.fit, jevMeta);
      rejected++;
      continue;
    }
    c.priority = priorityOf(c, fitNorm);
    eligible.push(c);
  }
  eligible.sort((a, b) => b.priority - a.priority);

  // Highest priority first; a candidate rejected for missing evidence frees its slot for the next one.
  let created = 0;
  for (const c of eligible) {
    if (created >= remaining) {
      record(c.dedupKey, "rejected", "daily_cap", c.fit, jevMeta);
      rejected++;
      continue;
    }
    let d: Draft;
    if (c.checklist) {
      const r = await draftChecklistProposal(ctx, { ...c, checklist: c.checklist }, geoClaimViolations);
      if (!r.ok) {
        await ctx.log.event("geo.proposals", "info", `Checklist proposal not used (${r.reason}): ${r.errors.slice(0, 3).join("; ").slice(0, 300)}`);
        record(c.dedupKey, "rejected", r.reason, c.fit, jevMeta);
        rejected++;
        continue;
      }
      d = r.draft;
    } else {
      const obsIds = new Set(c.observations.map((o) => o.id));
      const ev = inputs.evidence.filter((e) => obsIds.has(e.ref_id));
      const summaries = ev.filter((e) => parseJson<{ kind?: string }>(e.data_json, {}).kind === "summary").slice(0, 6);
      const passages = ev.filter((e) => parseJson<{ kind?: string }>(e.data_json, {}).kind === "passage").slice(0, 2);
      const observationEvidence = [...summaries, ...passages];
      if (observationEvidence.length === 0) {
        record(c.dedupKey, "rejected", "insufficient_evidence", c.fit, jevMeta);
        rejected++;
        continue;
      }
      // verified = our own target page has a usable crawl snapshot, cited as crawl evidence. A cited
      // third-party page is never fetched here ([A7] requires the user's approval of that single URL).
      const page = c.target.kind === "url" && c.target.url ? await crawlPageEvidence(ctx, c.target.url) : null;
      const verified = page !== null;
      const evidence = page ? [page, ...observationEvidence] : observationEvidence;
      const w = await writerDraft(ctx, c, evidence, verified, inputs.positioning);
      if (w.failure && ctx.writer) {
        const reason = /writer (call failed|budget)/.test(w.failure) ? (w.failure.includes("budget") ? "budget" : "decision_unavailable") : w.failure === "all evidence tainted" ? "insufficient_evidence" : "validation_failed";
        record(`${c.dedupKey}:draft`, "rejected", reason);
        await ctx.log.event("geo.proposals", "info", `Writer draft not used (${w.failure}); used the deterministic template.`);
      }
      d = w.draft ?? templateDraft(c, inputs.brandName, evidence, verified);
    }
    // The 0-2/day cap and dedup are re-checked at save time: drafting is slow, and another attempt of
    // this step (a Workflow retry, or a concurrent manual run) may have saved in the meantime.
    if ((await remainingToday(ctx, "geo")) <= 0) {
      record(c.dedupKey, "rejected", "daily_cap", c.fit, jevMeta);
      rejected++;
      continue;
    }
    if (await isDuplicate(ctx, c.dedupKey)) {
      record(c.dedupKey, "rejected", "duplicate", c.fit, jevMeta);
      rejected++;
      continue;
    }
    const fitFields: Record<string, number | string> | null =
      c.fit.answer && c.fit.answer.type === "score" && (c.fit.tier === "act" || c.fit.tier === "flag")
        ? { question: GEO_QUESTION_IDS.proposalFit, score: c.fit.answer.score, confidence: c.fit.answer.confidence }
        : null;
    const savedId = await saveRecommendation(
      ctx,
      {
        agent: "geo",
        scope: c.scope,
        target: c.target,
        issueType: c.issueType,
        trigger: d.trigger,
        issue: d.issue,
        action: d.action,
        suggestedSnippet: d.suggestedSnippet,
        rationale: d.rationale,
        effort: d.effort,
        uncertainty: d.uncertainty,
        limitations: d.limitations,
        verified: d.verified,
        priority: c.priority,
        priorityVersion: c.checklist ? GEO_CHECKLIST_PRIORITY_VERSION : GEO_PRIORITY_VERSION,
        decisionTier: fitFields ? c.fit.tier : null,
        decisionFields: fitFields,
        evidenceIds: d.evidenceIds,
        evidenceBullets: d.bullets,
        confirmPlaceholders: d.confirmPlaceholders,
        dedupKey: c.dedupKey,
        writerProvider: d.writer?.provider ?? null,
        writerModel: d.writer?.model ?? null,
      },
      inputs.isDemo,
    );
    if (savedId === null) {
      // Another attempt filled the daily cap between the re-check and the (atomic) insert.
      record(c.dedupKey, "rejected", "daily_cap", c.fit, jevMeta);
      rejected++;
      continue;
    }
    record(c.dedupKey, "selected", null, c.fit, jevMeta);
    created++;
  }
  await ctx.db.batch(decisions);
  return {
    candidates: candidates.length,
    created,
    rejected,
    note: created > 0 ? `${created} new GEO proposal(s).` : "No new verified opportunities today.",
  };
}
