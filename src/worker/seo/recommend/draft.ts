/**
 * Drafting: the writing provider (if configured) drafts from stored evidence only, using the SEO
 * writer system prompt and the recommendation.v1 schema; output is zod-validated and then checked by
 * the [A10]/[A17] validator. Without a writer, a deterministic template builds a factual draft that
 * copies evidence text and cites evidence ids (writerProvider null). Both paths run validateDraft;
 * a failing draft is never saved.
 */
import type { EvidenceBullet, Level, Tier } from "@shared/types";
import type { RunContext } from "../../runs/context";
import type { ValidationEvidence } from "../../writing/validate";
import { validateDraft } from "../../writing/validate";
import { SEO_WRITER_SYSTEM } from "../../writing/prompts";
import { RECOMMENDATION_V1_JSON_SCHEMA, recommendationOutputSchema, recommendationTextFields } from "../../writing/schemas";
import { demandPhrase } from "../gsc/demand";
import { safeMessage } from "../gsc/sync";
import type { ActionChoice } from "../questions";
import type { Candidate, EvidenceSpec } from "./candidates";
import { isSelfAccounting } from "./decide";
import { clip } from "./text";

export const WRITER_MAX_OUTPUT_TOKENS = 1500;

export interface StoredEvidence {
  id: string;
  spec: EvidenceSpec;
}

export interface DraftInput {
  candidate: Candidate;
  action: ActionChoice | null;
  tier: Tier;
  intent: string | null;
  severityScore: number | null;
  evidence: StoredEvidence[];
  contextDocs: Array<{ id: string; kind: string; version: number; excerpt: string }>;
}

export interface Draft {
  trigger: string;
  issue: string;
  action: string;
  suggestedSnippet: string | null;
  rationale: string;
  effort: Level;
  uncertainty: Level;
  limitations: string;
  verified: boolean;
  evidenceIds: string[];
  evidenceBullets: EvidenceBullet[];
  confirmPlaceholders: string[];
  writerProvider: string | null;
  writerModel: string | null;
}

export type DraftResult = { ok: true; draft: Draft; warnings: string[] } | { ok: false; reason: "validation_failed" | "writer_failed"; errors: string[] };

const EFFORT_BY_ACTION: Record<ActionChoice, Level> = {
  rewrite_title_meta: "low",
  add_internal_links: "low",
  improve_intro_answer: "medium",
  add_section: "medium",
  add_comparison_or_spec_table: "medium",
  fix_structured_data: "medium",
  fix_canonical_or_indexing: "medium",
  consolidate_duplicate: "high",
  new_page_candidate: "high",
  no_action: "low",
};

export function effortFor(c: Candidate, action: ActionChoice | null): Level {
  if (c.kind === "technical") return c.scope === "page" ? "low" : "medium";
  // [A21] Deterministic checklist candidates carry their own effort; Jev-dependent ones follow the chosen action.
  if (c.kind === "checklist" && c.checklist && !c.jevDependent) return c.checklist.effort;
  return action ? EFFORT_BY_ACTION[action] : c.priority.effort;
}

export function uncertaintyFor(c: Candidate, tier: Tier): Level {
  if (c.reviewRequired || tier === "flag") return "high";
  if (c.kind === "technical") return c.severity === "critical" || c.severity === "major" ? "low" : "medium";
  if (c.kind === "checklist" && c.checklist) return c.severity === "critical" || (c.checklist.method === "measured" && c.checklist.status === "not_met") ? "low" : "medium";
  return "medium";
}

function validationEvidence(ev: StoredEvidence[]): ValidationEvidence[] {
  // The window travels in data so dates/windows quoted in text validate against the evidence.
  return ev.map((e) => ({ id: e.id, text: e.spec.text, data: { window: e.spec.window, data: e.spec.data } }));
}

/**
 * 2-4 bullets, tagged by source, in the candidate's evidence order (candidates list the most direct
 * evidence first; a template candidate lists the rule summary, then three example URLs [A9]).
 */
export function codeBullets(ev: StoredEvidence[]): EvidenceBullet[] {
  return ev.slice(0, 4).map((e) => ({ evidenceId: e.id, source: e.spec.source, text: bulletText(e.spec.text) }));
}

/** Evidence text up to 300 chars, cut at a sentence/clause boundary so no number is split. */
function bulletText(t: string): string {
  if (t.length <= 300) return t;
  const cut = t.slice(0, 299);
  const at = Math.max(cut.lastIndexOf("; "), cut.lastIndexOf(". "));
  return `${at > 80 ? cut.slice(0, at) : cut.replace(/[\d.,%]+$/, "")}…`;
}

// ------------------------------------------------------------------ writer path
export async function draftWithWriter(ctx: RunContext, d: DraftInput): Promise<DraftResult> {
  const writer = ctx.writer!;
  const c = d.candidate;
  const input = {
    DECISION: { action_choice: d.action, scope: c.scope, severity_score: d.severityScore, intent: d.intent, tier: d.tier },
    TARGET: { url_or_template: c.target.url ?? c.target.template ?? "site", page_type: c.pageType, target: c.target },
    CONTEXT_DOCS: d.contextDocs,
    EVIDENCE: d.evidence.map((e) => ({
      id: e.id,
      source: e.spec.source,
      window: e.spec.window,
      // [A14] tainted evidence can be cited but its text is excluded from writer context.
      text_or_metric: e.spec.tainted ? "[withheld: text flagged as possible instructions to an AI system]" : e.spec.text,
    })),
    REQUIRED_FIELDS: { agent: "seo", scope: c.scope, trigger_hint: c.trigger, issue_hint: c.issue, limitations_hint: c.limitations, verified_max: c.verified && !c.reviewRequired },
  };
  const selfAccounting = isSelfAccounting(writer as { name: string; recordsCalls?: boolean });
  const inputTokensEstimate = Math.ceil(JSON.stringify(input).length / 4) + Math.ceil(SEO_WRITER_SYSTEM.length / 4);
  const reservation = selfAccounting ? null : await ctx.budget.reserve("writer_tokens", inputTokensEstimate + WRITER_MAX_OUTPUT_TOKENS);
  const started = Date.now();
  let output: unknown;
  let provider = writer.name;
  let model = writer.model;
  try {
    const res = await writer.write({
      purpose: "seo_recommendation",
      system: SEO_WRITER_SYSTEM,
      input,
      jsonSchema: RECOMMENDATION_V1_JSON_SCHEMA as unknown as Record<string, unknown>,
      maxOutputTokens: WRITER_MAX_OUTPUT_TOKENS,
    });
    output = res.output;
    provider = res.provider;
    model = res.model;
    if (reservation !== null) await ctx.budget.settle(reservation, (res.usage?.inputTokens ?? 0) + (res.usage?.outputTokens ?? 0));
    if (!selfAccounting) {
      await ctx.calls.record({
        provider: res.provider,
        model: res.model,
        purpose: "seo_recommendation",
        status: "ok",
        inputTokens: res.usage?.inputTokens ?? null,
        outputTokens: res.usage?.outputTokens ?? null,
        costUsd: null,
        costIsEstimate: false,
        latencyMs: Date.now() - started,
      });
    }
  } catch (e) {
    if (reservation !== null) await ctx.budget.markUnknown(reservation);
    if (!selfAccounting) {
      await ctx.calls.record({ provider: writer.name, model: writer.model, purpose: "seo_recommendation", status: "error", costUsd: null, costIsEstimate: false, latencyMs: Date.now() - started, error: safeMessage(e) });
    }
    return { ok: false, reason: "writer_failed", errors: [safeMessage(e)] };
  }

  const parsed = recommendationOutputSchema.safeParse(output);
  if (!parsed.success) return { ok: false, reason: "validation_failed", errors: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`) };
  const o = parsed.data;
  if (o.agent !== "seo") return { ok: false, reason: "validation_failed", errors: ["Writer output agent is not 'seo'."] };
  const check = validateDraft(recommendationTextFields(o), o.evidence_ids, validationEvidence(d.evidence));
  if (!check.ok) return { ok: false, reason: "validation_failed", errors: check.errors };

  const known = new Set(d.evidence.map((e) => e.id));
  const specById = new Map(d.evidence.map((e) => [e.id, e.spec]));
  let bullets: EvidenceBullet[] = (o.evidence_bullets ?? [])
    .filter((b) => known.has(b.evidence_id))
    .map((b) => ({ evidenceId: b.evidence_id, source: specById.get(b.evidence_id)!.source, text: b.text }));
  if (bullets.length < 2) bullets = codeBullets(d.evidence.filter((e) => o.evidence_ids.includes(e.id)).concat(d.evidence.filter((e) => !o.evidence_ids.includes(e.id))));
  const evidenceIds = [...new Set([...o.evidence_ids, ...bullets.map((b) => b.evidenceId)])];

  return {
    ok: true,
    warnings: check.warnings,
    draft: {
      trigger: o.trigger,
      issue: o.issue,
      action: o.action,
      // A code-owned snippet (robots.txt advisor) always wins over anything the writer produced.
      suggestedSnippet: c.checklist?.snippet ?? o.suggested_snippet ?? null,
      rationale: o.rationale,
      // Code owns scope/target/effort (priority used it) and verification; the writer cannot change them.
      effort: effortFor(c, d.action),
      uncertainty: maxLevel(o.uncertainty, uncertaintyFor(c, d.tier)),
      limitations: o.limitations,
      verified: o.verified && c.verified && !c.reviewRequired,
      evidenceIds,
      evidenceBullets: bullets.slice(0, 4),
      confirmPlaceholders: [...new Set([...(o.confirm_placeholders ?? []), ...check.confirmPlaceholders])],
      writerProvider: provider,
      writerModel: model,
    },
  };
}

const LEVEL_ORDER: Record<Level, number> = { low: 0, medium: 1, high: 2 };
const maxLevel = (a: Level, b: Level): Level => (LEVEL_ORDER[b] > LEVEL_ORDER[a] ? b : a);

// ------------------------------------------------------------------ deterministic path
/** Every deterministic action names the facts a human must supply as [confirm: ...] placeholders [A10]. */
const ACTION_TEXT: Record<ActionChoice, (target: string) => string> = {
  rewrite_title_meta: (t) => `Rewrite the title and meta description of ${t} so the search snippet reflects the queries shown in the evidence. Keep every claim to facts already on the page; [confirm: product facts to mention in the snippet].`,
  improve_intro_answer: (t) => `Revise the opening paragraph of ${t} so it directly answers the search demand shown in the evidence before any secondary content; [confirm: the answer or facts to lead with].`,
  add_section: (t) => `Add a section to ${t} that covers the queries shown in the evidence, using only facts the business can confirm; [confirm: facts for the new section].`,
  add_comparison_or_spec_table: (t) => `Add a comparison or specification table to ${t}; [confirm: specifications and values to include].`,
  add_internal_links: (t) => `Add contextual internal links to ${t} from related pages, using descriptive anchor text that matches the page topic; [confirm: which related pages should link here].`,
  fix_structured_data: (t) => `Fix the structured data on ${t} so the reported properties are present and valid; [confirm: values for any missing required properties].`,
  fix_canonical_or_indexing: (t) => `Fix the canonical/indexing signals reported for ${t} so the intended URL is indexable and self-consistent; [confirm: the intended canonical URL and whether it should be indexed].`,
  consolidate_duplicate: (t) => `Review ${t} for consolidation: merge the overlapping content into the stronger URL and redirect or canonicalize the other; [confirm: which URL to keep].`,
  new_page_candidate: (t) => `Review whether a new page is needed for the search demand in the evidence${t === "the site" ? "" : ` (related: ${t})`}; a human must confirm scope before any drafting; [confirm: whether a page on this topic is wanted].`,
  no_action: () => "No change recommended.",
};

const RATIONALE: Record<Candidate["kind"], string> = {
  weak_ctr: "These rows earn a lower click-through rate than the site's median for the same position bucket, so a snippet that matches the query more clearly may earn more clicks.",
  striking_distance: "The query already earns impressions just outside the top positions, so content that answers it more directly may help the page compete.",
  declining: "Clicks fell between the previous and current windows; checking whether the page still answers current searches is a reasonable first step.",
  query_page_mismatch: "Search Console shows a different page for this query than the page whose title and H1 match it best; clearer internal signals may help search engines choose the better page.",
  coverage_gap: "The page receives impressions for queries whose words are missing from its headings and opening text; covering them may make the page a better match.",
  internal_link: "The page earns impressions but few crawled pages link to it; contextual links help users and crawlers find it.",
  engine_query: "AI engines issued this search while answering sampled prompts; aligning a page with it is a hypothesis to review, not a measured effect.",
  technical: "The rule reported this on the crawled HTML; fixing it once at the reported scope addresses every affected URL together.",
  duplicate: "Jev judged that the two pages compete for the same search intent, and they share title words or queries, so one strong page may serve searchers better than two partial ones.",
  checklist: "The readiness checklist measured this gap from the project's own crawl, Search Console, or robots.txt data; it describes a practice that makes pages easier to crawl and understand, and no ranking change is promised.",
};

export function draftDeterministic(d: DraftInput): DraftResult {
  const c = d.candidate;
  const targetText = c.target.url ?? (c.target.template ? `the ${c.target.template}` : "the site");
  const cite = (ids: string[]) => ids.map((id) => `[${id}]`).join("");
  const ids = d.evidence.map((e) => e.id);
  const primary = d.evidence.slice(0, 2).map((e) => e.id);
  let actionText: string;
  // [A21] Deterministic checklist candidates carry code-owned action text; Jev-dependent ones use the chosen action.
  if (c.checklist?.actionText && (!c.jevDependent || !d.action)) actionText = c.checklist.actionText;
  else if (d.action) actionText = ACTION_TEXT[d.action](targetText);
  else {
    const rule = c.issueType.startsWith("technical:") ? c.issueType.slice("technical:".length) : c.issueType;
    actionText = `Resolve rule ${rule} at the reported scope (${c.scope}) for ${targetText}, following the finding details; [confirm: the intended fix for this rule].`;
  }
  if (c.scope === "template") actionText += " Make the change once in the shared template rather than page by page.";
  actionText = `${actionText} ${cite(primary)}`;
  // Demand segment of the query in the site's own GSC impressions (never market volume) [gsc/demand.ts].
  const demandEv = c.demand ? d.evidence.find((e) => (e.spec.data as { demand?: unknown } | null)?.demand) : undefined;
  const demandText =
    c.demand && demandEv
      ? ` In this site's own Search Console impressions, "${clip(c.demand.query, 80)}" is ${demandPhrase(c.demand)}; this describes first-party visibility, not market search volume. ${cite([demandEv.id])}`
      : "";
  const rationale = `${c.checklist?.rationale ?? RATIONALE[c.kind]} ${cite(ids.slice(0, 3))}${demandText}`;
  const text = {
    trigger: clip(c.trigger, 200),
    issue: `${clip(c.issue, 360)} ${cite(primary.slice(0, 1))}`,
    action: clip(actionText, 600),
    rationale: clip(rationale, 600),
    limitations: clip(c.limitations, 400),
  };
  const check = validateDraft([text.trigger, text.issue, text.action, text.rationale, text.limitations], ids, validationEvidence(d.evidence));
  if (!check.ok) return { ok: false, reason: "validation_failed", errors: check.errors };
  return {
    ok: true,
    warnings: check.warnings,
    draft: {
      ...text,
      suggestedSnippet: c.checklist?.snippet ?? null,
      effort: effortFor(c, d.action),
      uncertainty: uncertaintyFor(c, d.tier),
      verified: c.verified && !c.reviewRequired,
      evidenceIds: ids,
      evidenceBullets: codeBullets(d.evidence),
      confirmPlaceholders: check.confirmPlaceholders,
      writerProvider: null,
      writerModel: null,
    },
  };
}
