/**
 * analyzeObservation: turn one stored GEO answer into brand observations, attributed citations with
 * source types, displacement evidence [A1], decision records, and evidence rows.
 *
 * Pipeline (all per observation, scoped by workspace + project):
 *   1. Load the observation. status != 'ok' -> nothing is derived (failed/incomplete runs are excluded
 *      from metrics, never counted as absences).
 *   2. Deterministic detection on the response body only (detect.ts): alias spans per brand, citation
 *      hosts, ordered-list rank, English recommendation cues, rule-based source types.
 *   3. One Jev systemOne call (when a DecisionProvider is configured) batching: [A14] injection
 *      preflight on the sanitized answer, adjudication of ambiguous spans, recommendation status for
 *      brands whose cues are unclear, passage sentiment per mentioned brand, and source type for
 *      citations no rule matched. The provider itself reserves budget and records provider_calls.
 *   4. Code decides with tierFor(): Act/Flag answers are used, Drop answers fall back to deterministic
 *      values or 'unknown'.
 *   5. Persist brand rows, citations, displacements, decision records (one per question), evidence.
 *
 * [A14] taint semantics:
 *   - decisions provider not configured -> preflight skipped, tainted = false, method notes
 *     "preflight unavailable (decisions not configured)". Deterministic guards remain the control.
 *   - provider configured but unreachable / out of budget / answer missing -> tainted = true (fail closed).
 *   - answered -> tainted unless the Noul value is at or below the policy's confident-no band.
 *
 * Citation input convention (geo-providers writes observations): citations are read from existing
 * geo_citations rows for the observation (re-attributed in place), else from usage_json.citations
 * ([{url, title, position}]). Search queries: geo_search_queries rows, else usage_json.searchQueries
 * (inserted here); usage_json.searchQueriesExposed=true marks "exposed but empty".
 */
import type { RecommendationStatusInAnswer, Sentiment, SourceType } from "@shared/types";
import type { RunContext } from "../runs/context";
import type { DecisionAnswer, DecisionQuestion, DecisionResult } from "../providers/types";
import { DEFAULT_NOUL_BANDS, POLICY_VERSION, QUESTION_POLICY, tierFor } from "../runs/policy";
import { hashJson } from "../lib/hash";
import { newId } from "../lib/ids";
import { iso } from "../lib/time";
import { parseJson } from "../lib/db";
import { BudgetExceededError } from "../lib/errors";
import { createEvidence } from "../recommendations/evidence";
import {
  type BrandDef,
  type BrandSpan,
  brandForHost,
  containingSentence,
  contextWindow,
  citationMarkers,
  detectBrands,
  listRankFor,
  onListLine,
  parseOrderedLists,
  passageAround,
  projectBrands,
  recommendationCues,
  resolveCitationHost,
  sanitizeUntrusted,
  sentences,
  sentenceIndexAt,
} from "./detect";
import { classifySourceByRules, isSourceType, type SourceTypeMethod } from "./source-type";
import { GEO_QUESTION_IDS, geoQuestion, geoQuestionVersion, type GeoQuestionId } from "./questions";

export const ANALYSIS_VERSION = "geo-analysis-2026-09-30.1";
const MAX_ADJUDICATIONS = 12;
const MAX_SOURCE_QUESTIONS = 20;
const MAX_BRAND_QUESTIONS = 6;
const RAW_TEXT_FOR_JEV = 6000;

export interface ObservationRow {
  id: string;
  workspace_id: string;
  project_id: string;
  run_id: string | null;
  prompt_id: string | null;
  prompt_set_id: string | null;
  prompt_text: string;
  prompt_type: string;
  cohort_key: string;
  provider: string;
  model: string;
  grounding_mode: string;
  measurement_type: "api" | "manual_import";
  imported_surface: string | null;
  status: "ok" | "failed" | "incomplete";
  grounded: number;
  raw_answer: string | null;
  request_id: string | null;
  usage_json: string;
  cost_usd: number | null;
  cost_is_estimate: number;
  error: string | null;
  created_at: string;
}

interface ProjectForAnalysis {
  id: string;
  workspace_id: string;
  brand_name: string;
  brand_aliases_json: string;
  competitors_json: string;
  site_url: string;
  verified_host: string | null;
  gsc_property: string | null;
  product_description: string;
}

export interface AnalyzedCitation {
  id: string;
  existing: boolean;
  url: string;
  host: string | null;
  title: string | null;
  position: number | null;
  brandKey: string | null;
  sourceType: SourceType;
  method: SourceTypeMethod;
}

export interface AnalyzedBrand {
  brandKey: string;
  isSelf: boolean;
  name: string;
  mentioned: boolean;
  cited: boolean;
  recommendationStatus: RecommendationStatusInAnswer;
  listRank: number | null;
  sentiment: Sentiment;
  spans: Array<{ start: number; end: number; text: string; ambiguous?: boolean; adjudication?: string }>;
  method: string;
  unresolvedAmbiguous: number;
}

export interface AnalyzedDisplacement {
  entity: string;
  url: string | null;
  sourceType: SourceType;
  span: string | null;
}

export interface AnalyzeSummary {
  observationId: string;
  skipped: string | null;
  tainted: boolean;
  decisions: "not_configured" | "ok" | "unreachable" | "budget" | "not_needed";
  brands: AnalyzedBrand[];
  citations: AnalyzedCitation[];
  displacements: AnalyzedDisplacement[];
}

type DecisionStatus = AnalyzeSummary["decisions"];

interface AskedQuestion {
  key: string;
  id: GeoQuestionId;
  question: DecisionQuestion;
}

function usable(tier: string): boolean {
  return tier === "act" || tier === "flag";
}

async function loadCitations(ctx: RunContext, obs: ObservationRow): Promise<Array<{ id: string | null; url: string; title: string | null; position: number | null }>> {
  const rows = await ctx.db.all<{ id: string; url: string; title: string | null; position: number | null }>(
    "SELECT id, url, title, position FROM geo_citations WHERE workspace_id = ? AND project_id = ? AND observation_id = ? ORDER BY position IS NULL, position, rowid",
    ctx.project.workspaceId,
    ctx.project.id,
    obs.id,
  );
  if (rows.length > 0) return rows;
  const usage = parseJson<Record<string, unknown>>(obs.usage_json, {});
  const list = Array.isArray(usage.citations) ? usage.citations : [];
  const out: Array<{ id: string | null; url: string; title: string | null; position: number | null }> = [];
  for (const c of list.slice(0, 100)) {
    if (!c || typeof c !== "object") continue;
    const r = c as Record<string, unknown>;
    if (typeof r.url !== "string" || !r.url) continue;
    out.push({ id: null, url: r.url.slice(0, 2000), title: typeof r.title === "string" ? r.title.slice(0, 500) : null, position: typeof r.position === "number" ? r.position : null });
  }
  return out;
}

/** Normalize an engine search query for aggregation (NFKC, lowercase, collapsed whitespace, trimmed punctuation). */
export function normalizeQuery(q: string): string {
  return q
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s"'“”‘’?!.,;:]+|[\s"'“”‘’?!.,;:]+$/g, "");
}

async function ensureSearchQueries(ctx: RunContext, obs: ObservationRow): Promise<void> {
  const existing = await ctx.db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM geo_search_queries WHERE workspace_id = ? AND observation_id = ?",
    ctx.project.workspaceId,
    obs.id,
  );
  if ((existing?.n ?? 0) > 0) return;
  const usage = parseJson<Record<string, unknown>>(obs.usage_json, {});
  if (!Array.isArray(usage.searchQueries)) return;
  const now = iso(ctx.clock());
  const stmts: Array<[string, ...unknown[]]> = [];
  for (const q of usage.searchQueries.slice(0, 50)) {
    if (typeof q !== "string" || !q.trim()) continue;
    stmts.push([
      "INSERT INTO geo_search_queries (id, workspace_id, project_id, observation_id, provider, model, query, normalized, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      newId("gsq"), ctx.project.workspaceId, ctx.project.id, obs.id, obs.provider, obs.model, q.slice(0, 500), normalizeQuery(q).slice(0, 500), now,
    ]);
  }
  await ctx.db.batch(stmts);
}

/** Sentences (text) containing each span. */
function spanSentences(text: string, spans: Array<{ start: number }>): string[] {
  const sents = sentences(text);
  const out = new Set<string>();
  for (const s of spans) {
    const i = sentenceIndexAt(sents, s.start);
    const st = sents[i];
    if (st) out.add(text.slice(st.start, st.end));
  }
  return [...out];
}

export async function analyzeObservation(ctx: RunContext, observationId: string): Promise<AnalyzeSummary> {
  const obs = await ctx.db.first<ObservationRow>(
    "SELECT * FROM geo_observations WHERE id = ? AND workspace_id = ? AND project_id = ?",
    observationId,
    ctx.project.workspaceId,
    ctx.project.id,
  );
  if (!obs) throw new Error("GEO observation not found in this project.");
  const empty: AnalyzeSummary = { observationId, skipped: null, tainted: false, decisions: "not_needed", brands: [], citations: [], displacements: [] };
  if (obs.status !== "ok") return { ...empty, skipped: `status_${obs.status}` };

  const project = await ctx.db.first<ProjectForAnalysis>(
    "SELECT id, workspace_id, brand_name, brand_aliases_json, competitors_json, site_url, verified_host, gsc_property, product_description FROM projects WHERE id = ? AND workspace_id = ?",
    ctx.project.id,
    ctx.project.workspaceId,
  );
  if (!project) throw new Error("Project not found.");

  await ensureSearchQueries(ctx, obs);

  const brands = projectBrands(project);
  const refOf = new Map<string, string>(brands.map((b, i) => [b.key, b.isSelf ? "self" : `c${i - 1}`]));
  const trackedDomains = brands.flatMap((b) => b.domains);
  const text = obs.raw_answer ?? "";
  const spansByBrand = detectBrands(text, brands);
  const listItems = parseOrderedLists(text);

  // ---------------------------------------------------------------- citations (deterministic)
  const rawCitations = await loadCitations(ctx, obs);
  const citations: AnalyzedCitation[] = rawCitations.map((c) => {
    const { host } = resolveCitationHost(c.url, c.title);
    const brandKey = brandForHost(host, brands);
    const rule = classifySourceByRules({ url: c.url, host, title: c.title }, trackedDomains);
    return {
      id: c.id ?? newId("gcit"),
      existing: c.id !== null,
      url: c.url,
      host,
      title: c.title,
      position: c.position,
      brandKey,
      sourceType: rule?.sourceType ?? "other",
      method: rule ? "rule" : "unknown",
    };
  });

  // ---------------------------------------------------------------- pre-Jev per-brand state
  const preCue = new Map<string, ReturnType<typeof recommendationCues>>();
  for (const b of brands) {
    const spans = spansByBrand.get(b.key) ?? [];
    if (spans.length === 0) continue;
    preCue.set(b.key, recommendationCues(spanSentences(text, spans), spans.some((s) => onListLine(text, s.start))));
  }

  // ---------------------------------------------------------------- Jev batch
  const asked: AskedQuestion[] = [];
  const adjudicationKeys = new Map<BrandSpan, string>();
  const state: Record<string, unknown> = {
    brand_description: project.product_description.slice(0, 600),
    brands: Object.fromEntries(brands.map((b) => [refOf.get(b.key)!, { name: b.name, aliases: b.aliases.slice(0, 10), is_self: b.isSelf }])),
    tracked_domains: trackedDomains,
  };
  const spansState: Record<string, unknown> = {};
  const mentionsState: Record<string, unknown> = {};
  const passagesState: Record<string, unknown> = {};
  const citationsState: Record<string, unknown> = {};
  const sanitized = sanitizeUntrusted(text, RAW_TEXT_FOR_JEV);

  if (ctx.decisions && sanitized.trim()) {
    state.text = sanitized;
    asked.push({ key: "injection_risk", id: GEO_QUESTION_IDS.injectionRisk, question: geoQuestion(GEO_QUESTION_IDS.injectionRisk, "text") });

    let n = 0;
    for (const b of brands) {
      for (const s of spansByBrand.get(b.key) ?? []) {
        if (!s.ambiguous || n >= MAX_ADJUDICATIONS) continue;
        const key = `adj_${n++}`;
        adjudicationKeys.set(s, key);
        spansState[key] = { brand: refOf.get(b.key), matched: s.text, context: sanitizeUntrusted(contextWindow(text, s), 600) };
        asked.push({ key, id: GEO_QUESTION_IDS.mentionAdjudication, question: geoQuestion(GEO_QUESTION_IDS.mentionAdjudication, key, refOf.get(b.key)) });
      }
    }
    let bq = 0;
    for (const b of brands) {
      const spans = spansByBrand.get(b.key) ?? [];
      if (spans.length === 0 || bq >= MAX_BRAND_QUESTIONS) continue;
      bq++;
      const ref = refOf.get(b.key)!;
      if (preCue.get(b.key) === "unclear") {
        mentionsState[ref] = spans.slice(0, 5).map((s) => s.text);
        asked.push({ key: `rec_${ref}`, id: GEO_QUESTION_IDS.recommendationStatus, question: geoQuestion(GEO_QUESTION_IDS.recommendationStatus, ref) });
      }
      passagesState[ref] = sanitizeUntrusted(passageAround(text, spans[0]!.start).text, 1200);
      asked.push({ key: `sent_${ref}`, id: GEO_QUESTION_IDS.brandSentiment, question: geoQuestion(GEO_QUESTION_IDS.brandSentiment, ref) });
    }
    let sq = 0;
    citations.forEach((c, i) => {
      if (c.method !== "unknown" || sq >= MAX_SOURCE_QUESTIONS || !c.host) return;
      sq++;
      const key = `src_${i}`;
      citationsState[key] = { url: c.url, title: c.title ? sanitizeUntrusted(c.title, 300) : null };
      asked.push({ key, id: GEO_QUESTION_IDS.sourceType, question: geoQuestion(GEO_QUESTION_IDS.sourceType, key) });
    });
    state.spans = spansState;
    state.mentions = mentionsState;
    state.passages = passagesState;
    state.citations = citationsState;
  }

  let decisionStatus: DecisionStatus = ctx.decisions ? (asked.length > 0 ? "ok" : "not_needed") : "not_configured";
  let result: DecisionResult | null = null;
  if (ctx.decisions && asked.length > 0) {
    try {
      result = await ctx.decisions.decide({
        purpose: "geo.analyze_observation",
        state,
        questions: Object.fromEntries(asked.map((q) => [q.key, q.question])),
      });
    } catch (e) {
      decisionStatus = e instanceof BudgetExceededError ? "budget" : "unreachable";
    }
  }
  const answer = (key: string): DecisionAnswer | undefined => result?.answers[key];
  const choiceIf = (key: string, id: GeoQuestionId): string | null => {
    const a = answer(key);
    if (!a || a.type !== "choice") return null;
    return usable(tierFor(id, a)) ? a.choice : null;
  };

  // ---------------------------------------------------------------- [A14] preflight outcome
  let tainted = false;
  let preflightNote: string;
  if (!sanitized.trim()) preflightNote = "preflight not needed (empty answer)";
  else if (!ctx.decisions) preflightNote = "preflight unavailable (decisions not configured)";
  else if (!result) {
    tainted = true;
    preflightNote = `preflight ${decisionStatus === "budget" ? "skipped: budget exhausted" : "unreachable"}; treated as tainted`;
  } else {
    const a = answer("injection_risk");
    const noBand = QUESTION_POLICY[GEO_QUESTION_IDS.injectionRisk]?.noul?.no ?? DEFAULT_NOUL_BANDS.no;
    if (!a || a.type !== "noul") {
      tainted = true;
      preflightNote = "preflight answer missing; treated as tainted";
    } else {
      tainted = !(a.noul <= noBand);
      preflightNote = tainted ? `preflight flagged (noul ${a.noul.toFixed(2)})` : "preflight clean";
    }
  }

  // ---------------------------------------------------------------- brands
  const analyzed: AnalyzedBrand[] = brands.map((b) => {
    const ref = refOf.get(b.key)!;
    const all = spansByBrand.get(b.key) ?? [];
    let usedJev = false;
    let unresolved = 0;
    const kept: AnalyzedBrand["spans"] = [];
    const confirmed: BrandSpan[] = [];
    for (const s of all) {
      if (!s.ambiguous) {
        confirmed.push(s);
        kept.push({ start: s.start, end: s.end, text: s.text });
        continue;
      }
      const key = adjudicationKeys.get(s);
      const verdict = key ? choiceIf(key, GEO_QUESTION_IDS.mentionAdjudication) : null;
      if (verdict) usedJev = true;
      if (verdict === "tracked_brand") {
        confirmed.push(s);
        kept.push({ start: s.start, end: s.end, text: s.text, ambiguous: true, adjudication: verdict });
      } else {
        if (!verdict) unresolved++;
        kept.push({ start: s.start, end: s.end, text: s.text, ambiguous: true, adjudication: verdict ?? "unresolved" });
      }
    }
    const mentioned = confirmed.length > 0;
    const cited = citations.some((c) => c.brandKey === b.key);
    let recommendationStatus: RecommendationStatusInAnswer = "not_mentioned";
    let sentiment: Sentiment = "not_applicable";
    let listRank: number | null = null;
    if (mentioned) {
      const cue = recommendationCues(spanSentences(text, confirmed), confirmed.some((s) => onListLine(text, s.start)));
      if (cue !== "unclear") recommendationStatus = cue;
      else {
        const j = choiceIf(`rec_${ref}`, GEO_QUESTION_IDS.recommendationStatus);
        if (j && j !== "not_mentioned") {
          recommendationStatus = j as RecommendationStatusInAnswer;
          usedJev = true;
        } else recommendationStatus = "unknown";
      }
      const s = choiceIf(`sent_${ref}`, GEO_QUESTION_IDS.brandSentiment);
      if (s) usedJev = true;
      sentiment = (s as Sentiment | null) ?? "unknown";
      listRank = listRankFor(listItems, confirmed);
    } else if (unresolved > 0) {
      recommendationStatus = "unknown";
      sentiment = "unknown";
    }
    const notes = [preflightNote];
    if (unresolved > 0) notes.push(`${unresolved} ambiguous span(s) unresolved (alias collision)`);
    return {
      brandKey: b.key,
      isSelf: b.isSelf,
      name: b.name,
      mentioned,
      cited,
      recommendationStatus,
      listRank,
      sentiment,
      spans: kept,
      method: `${usedJev ? "deterministic+jev" : "deterministic"}; ${notes.join("; ")}`,
      unresolvedAmbiguous: unresolved,
    };
  });

  // ---------------------------------------------------------------- source types from Jev
  citations.forEach((c, i) => {
    const key = `src_${i}`;
    if (!citationsState[key]) return;
    const j = choiceIf(key, GEO_QUESTION_IDS.sourceType);
    if (j && isSourceType(j)) {
      c.sourceType = j;
      c.method = "jev";
    }
  });

  // ---------------------------------------------------------------- [A1] displacements
  const displacements = computeDisplacements(text, brands, analyzed, citations, spansByBrand);

  // ---------------------------------------------------------------- persist
  const now = iso(ctx.clock());
  const ws = ctx.project.workspaceId;
  const pid = ctx.project.id;
  const stmts: Array<[string, ...unknown[]]> = [
    ["DELETE FROM geo_brand_observations WHERE workspace_id = ? AND project_id = ? AND observation_id = ?", ws, pid, obs.id],
    ["DELETE FROM geo_displacements WHERE workspace_id = ? AND project_id = ? AND observation_id = ?", ws, pid, obs.id],
  ];
  for (const b of analyzed) {
    stmts.push([
      `INSERT INTO geo_brand_observations (id, workspace_id, project_id, observation_id, brand_key, is_self, mentioned, cited, recommendation_status, list_rank, sentiment, spans_json, method)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      newId("gbo"), ws, pid, obs.id, b.brandKey, b.isSelf ? 1 : 0, b.mentioned ? 1 : 0, b.cited ? 1 : 0, b.recommendationStatus, b.listRank, b.sentiment,
      JSON.stringify(b.spans), b.method.slice(0, 500),
    ]);
  }
  for (const c of citations) {
    if (c.existing) {
      stmts.push([
        "UPDATE geo_citations SET host = ?, brand_key = ?, source_type = ?, source_type_method = ? WHERE id = ? AND workspace_id = ? AND project_id = ?",
        c.host ?? "", c.brandKey, c.sourceType, c.method, c.id, ws, pid,
      ]);
    } else {
      stmts.push([
        `INSERT INTO geo_citations (id, workspace_id, project_id, observation_id, url, host, title, position, brand_key, source_type, source_type_method)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        c.id, ws, pid, obs.id, c.url, c.host ?? "", c.title, c.position, c.brandKey, c.sourceType, c.method,
      ]);
    }
  }
  for (const d of displacements) {
    stmts.push([
      "INSERT INTO geo_displacements (id, workspace_id, project_id, observation_id, entity, url, source_type, span, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      newId("gdis"), ws, pid, obs.id, d.entity.slice(0, 300), d.url, d.sourceType, d.span, now,
    ]);
  }
  if (ctx.decisions && asked.length > 0) {
    const stateHash = await hashJson(state);
    for (const q of asked) {
      const a = answer(q.key);
      const tier = result ? tierFor(q.id, a) : "drop";
      const reason = !result || !a ? "decision_unavailable" : tier === "drop" ? "insufficient_evidence" : null;
      stmts.push([
        `INSERT INTO decision_records (id, workspace_id, project_id, run_id, agent, candidate_key, question_id, question_version, policy_version, provider, model, state_hash, answer_json, tier, outcome, reason_code, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        newId("dec"), ws, pid, ctx.runId, "geo", `obs:${obs.id}:${q.key}`, q.id, await geoQuestionVersion(q.id), POLICY_VERSION,
        result?.provider ?? ctx.decisions.name, result?.model ?? null, stateHash, a ? JSON.stringify(a) : null, tier,
        tier === "drop" ? "rejected" : "selected", reason, now,
      ]);
    }
  }
  await ctx.db.batch(stmts);

  await writeEvidence(ctx, obs, analyzed, citations, displacements, text, tainted);

  return { observationId, skipped: null, tainted, decisions: decisionStatus, brands: analyzed, citations, displacements };
}

/**
 * [A1] When self is absent (not mentioned and not cited, and no unresolved self ambiguity) and a
 * tracked competitor is recommended/listed or any attributable non-self citation exists, record who
 * took the slot. Competitor mentions link to a citation via explicit [n] markers in their sentence,
 * else to the competitor's own-domain citation. Remaining attributable non-self citations become
 * their own displacement (entity = competitor name when the host is theirs, else the host).
 * Unresolved-host citations are never attributed.
 */
export function computeDisplacements(
  text: string,
  brands: BrandDef[],
  analyzed: AnalyzedBrand[],
  citations: AnalyzedCitation[],
  spansByBrand: Map<string, BrandSpan[]>,
): AnalyzedDisplacement[] {
  const self = analyzed.find((b) => b.isSelf);
  if (!self || self.mentioned || self.cited || self.unresolvedAmbiguous > 0) return [];
  const out: AnalyzedDisplacement[] = [];
  const used = new Set<number>();
  const hasPositions = citations.some((c) => c.position !== null);
  const citationForMarker = (n: number): number => {
    if (hasPositions) return citations.findIndex((c) => c.position === n);
    return n - 1 < citations.length ? n - 1 : -1;
  };
  for (const b of analyzed) {
    if (b.isSelf || !b.mentioned || b.recommendationStatus === "mentioned_negatively") continue;
    const first = (spansByBrand.get(b.brandKey) ?? []).find((s) => b.spans.some((k) => k.start === s.start && (!k.ambiguous || k.adjudication === "tracked_brand")));
    if (!first) continue;
    const sentence = containingSentence(text, first.start);
    let idx = -1;
    for (const n of citationMarkers(sentence)) {
      const i = citationForMarker(n);
      if (i >= 0 && citations[i]!.host && citations[i]!.brandKey !== "self") {
        idx = i;
        break;
      }
    }
    if (idx < 0) idx = citations.findIndex((c) => c.brandKey === b.brandKey);
    const cit = idx >= 0 ? citations[idx]! : null;
    if (idx >= 0) used.add(idx);
    out.push({ entity: b.name, url: cit?.url ?? null, sourceType: cit?.sourceType ?? "other", span: sentence || null });
  }
  const sents = sentences(text);
  citations.forEach((c, i) => {
    if (used.has(i) || !c.host || c.brandKey === "self") return;
    const entity = c.brandKey ? (brands.find((b) => b.key === c.brandKey)?.name ?? c.brandKey) : c.host;
    const marker = c.position ?? i + 1;
    const sent = sents.find((s) => citationMarkers(text.slice(s.start, s.end)).includes(marker));
    if (out.some((d) => d.entity === entity && d.url === c.url)) return;
    out.push({ entity, url: c.url, sourceType: c.sourceType, span: sent ? text.slice(sent.start, sent.end).slice(0, 300) : null });
  });
  return out;
}

async function writeEvidence(
  ctx: RunContext,
  obs: ObservationRow,
  brands: AnalyzedBrand[],
  citations: AnalyzedCitation[],
  displacements: AnalyzedDisplacement[],
  text: string,
  tainted: boolean,
): Promise<void> {
  const source = obs.measurement_type === "manual_import" ? "manual_import" : "geo_observation";
  const existing = await ctx.db.all<{ id: string; data_json: string }>(
    "SELECT id, data_json FROM evidence WHERE workspace_id = ? AND project_id = ? AND source = ? AND ref_id = ?",
    ctx.project.workspaceId,
    ctx.project.id,
    source,
    obs.id,
  );
  if (existing.length > 0) {
    // Re-analysis: refresh the taint flag of the passage evidence only (summary text is code-generated).
    await ctx.db.run(
      `UPDATE evidence SET tainted = ? WHERE workspace_id = ? AND project_id = ? AND source = ? AND ref_id = ? AND json_extract(data_json, '$.kind') = 'passage'`,
      tainted ? 1 : 0, ctx.project.workspaceId, ctx.project.id, source, obs.id,
    );
    return;
  }
  const self = brands.find((b) => b.isSelf)!;
  const surface = obs.measurement_type === "manual_import" ? `${obs.imported_surface ?? "manual import"}` : `${obs.provider} API (API-sampled), model ${obs.model}`;
  const competitors = brands.filter((b) => !b.isSelf && b.mentioned).map((b) => `${b.name} (${b.recommendationStatus})`);
  const d0 = displacements[0];
  const summary = [
    `${surface}, ${obs.grounded ? "grounded" : "not grounded"}, ${obs.created_at.slice(0, 10)}.`,
    `Prompt: "${obs.prompt_text.slice(0, 160)}".`,
    `Brand ${self.mentioned ? `mentioned (${self.recommendationStatus}${self.listRank ? `, list rank ${self.listRank}` : ""})` : "not mentioned"}; ${self.cited ? "own domain cited" : "own domain not cited"}.`,
    competitors.length ? `Competitors mentioned: ${competitors.join(", ")}.` : "",
    d0 ? `Cited instead: ${d0.entity} via ${d0.sourceType}${d0.url ? ` (${d0.url})` : ""}.` : "",
  ].filter(Boolean).join(" ");
  await createEvidence(ctx, {
    source,
    refId: obs.id,
    window: obs.created_at.slice(0, 10),
    text: summary,
    data: {
      kind: "summary",
      observationId: obs.id,
      provider: obs.provider,
      model: obs.model,
      measurementType: obs.measurement_type,
      importedSurface: obs.imported_surface,
      grounded: obs.grounded === 1,
      promptId: obs.prompt_id,
      promptType: obs.prompt_type,
      prompt: obs.prompt_text,
      cohortKey: obs.cohort_key,
      brands: brands.map((b) => ({ brandKey: b.brandKey, isSelf: b.isSelf, mentioned: b.mentioned, cited: b.cited, recommendationStatus: b.recommendationStatus, sentiment: b.sentiment, listRank: b.listRank })),
      citations: citations.slice(0, 10).map((c) => ({ url: c.url, host: c.host, sourceType: c.sourceType, brandKey: c.brandKey })),
      displacements: displacements.slice(0, 5),
      analysisVersion: ANALYSIS_VERSION,
    },
    tainted: false,
  });
  const quoted = brands.find((b) => b.isSelf && b.mentioned) ?? brands.find((b) => b.mentioned);
  if (quoted && quoted.spans[0]) {
    const passage = passageAround(text, quoted.spans[0].start, 500);
    await createEvidence(ctx, {
      source,
      refId: obs.id,
      window: obs.created_at.slice(0, 10),
      text: `Passage about ${quoted.name} (${surface}): "${passage.text}"`,
      data: { kind: "passage", observationId: obs.id, brandKey: quoted.brandKey, start: passage.start, end: passage.end },
      tainted,
    });
  }
}
