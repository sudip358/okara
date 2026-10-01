/**
 * [A23] Pure helpers for the draft check page: form validation, request building, verdict and flag text,
 * read-only checklist shaping, and 400 validation-detail parsing. No React, no fetch: unit-tested in
 * tests/draft-check-web.test.ts.
 */
import type { Checklist, DraftCheckFlag, DraftCheckRequest, DraftCheckResult, PageRow, PageType } from "@shared/types";

export const MAX_QUERY_CHARS = 200;
export const MAX_DRAFT_CHARS = 60_000;
/** Client-side guards only; the contract does not state limits for these two fields. */
export const MAX_TITLE_CHARS = 300;
export const MAX_META_CHARS = 1_000;

/** Always shown on the page, whatever the server returns. */
export const GATE_LABEL = "A quality gate before human review — not an AI detector and not a ranking prediction.";

export type DraftMode = "paste" | "page";

export interface DraftForm {
  mode: DraftMode;
  targetQuery: string;
  draftText: string;
  pageId: string;
  title: string;
  metaDescription: string;
}

export type DraftField = "targetQuery" | "draftText" | "pageId" | "title" | "metaDescription";
export type FormErrors = Partial<Record<DraftField, string>>;

/** Order used to move focus to the first invalid field. */
export const FIELD_ORDER: DraftField[] = ["targetQuery", "draftText", "pageId", "title", "metaDescription"];

export const EMPTY_FORM: DraftForm = { mode: "paste", targetQuery: "", draftText: "", pageId: "", title: "", metaDescription: "" };

const fmt = (n: number) => n.toLocaleString("en-US");

export function validateDraftForm(f: DraftForm): FormErrors {
  const errors: FormErrors = {};
  const q = f.targetQuery.trim();
  if (!q) errors.targetQuery = "Enter the search query this page should answer.";
  else if (q.length > MAX_QUERY_CHARS) errors.targetQuery = `The query is ${fmt(q.length)} characters; the limit is ${MAX_QUERY_CHARS}.`;

  if (f.mode === "paste") {
    if (!f.draftText.trim()) errors.draftText = "Paste the draft text to check.";
    else if (f.draftText.length > MAX_DRAFT_CHARS)
      errors.draftText = `The draft is ${fmt(f.draftText.length)} characters; the limit is ${fmt(MAX_DRAFT_CHARS)}. Check it in parts.`;
    if (f.title.trim().length > MAX_TITLE_CHARS) errors.title = `The title can be at most ${MAX_TITLE_CHARS} characters.`;
    if (f.metaDescription.trim().length > MAX_META_CHARS) errors.metaDescription = `The meta description can be at most ${fmt(MAX_META_CHARS)} characters.`;
  } else if (!f.pageId) {
    errors.pageId = "Choose a crawled page.";
  }
  return errors;
}

export function firstInvalidField(errors: FormErrors): DraftField | null {
  return FIELD_ORDER.find((k) => errors[k]) ?? null;
}

/** Builds the request body with exactly one of pageId | draftText. Optional fields are sent only in paste mode and only when non-empty. */
export function buildDraftCheckRequest(f: DraftForm): { ok: true; body: DraftCheckRequest } | { ok: false; errors: FormErrors } {
  const errors = validateDraftForm(f);
  if (firstInvalidField(errors)) return { ok: false, errors };
  const body: DraftCheckRequest = { targetQuery: f.targetQuery.trim() };
  if (f.mode === "page") {
    body.pageId = f.pageId;
    return { ok: true, body };
  }
  body.draftText = f.draftText.trim();
  const title = f.title.trim();
  const meta = f.metaDescription.trim();
  if (title) body.title = title;
  if (meta) body.metaDescription = meta;
  return { ok: true, body };
}

// ------------------------------------------------------------------ what the check covers
export type CheckMethodLabel = "Measured" | "Heuristic" | "Jev judgment" | "Heuristic + Jev";

/**
 * The checks a draft check runs (25: the 16 on-page checklist items plus 9 draft-check items). Shown on
 * the page so users know what is measured and what is a Jev (model) yes/no judgment. Jev items stay manual
 * ("Check this yourself") without a TypeSafe key; items whose inputs are absent are shown as not applicable.
 */
export const DRAFT_CHECKS: ReadonlyArray<{ id: string; label: string; method: CheckMethodLabel; note?: string }> = [
  { id: "page.before_write.search_intent", label: "Match the search intent", method: "Heuristic" },
  { id: "page.before_write.topic_coverage", label: "Cover the topic fully", method: "Heuristic + Jev" },
  { id: "page.before_write.unique_angle", label: "Unique angle or original information", method: "Jev judgment" },
  { id: "page.before_write.first_hand", label: "First-hand experience or evidence", method: "Jev judgment" },
  { id: "page.before_write.author_credentials", label: "Author named with relevant credentials", method: "Jev judgment" },
  { id: "page.while_write.answer_early", label: "Answer the main question early", method: "Heuristic + Jev" },
  { id: "page.while_write.answer_first_40_words", label: "Answer in the first 40 words", method: "Measured", note: "Word overlap with the target query, not answer quality." },
  { id: "page.while_write.headings", label: "Clear main heading + descriptive subheadings", method: "Measured" },
  { id: "page.while_write.headings_match_questions", label: "Subheadings match the reader's questions", method: "Jev judgment", note: "Needs at least two subheadings." },
  { id: "page.while_write.terms_entities", label: "Relevant terms and entities naturally", method: "Heuristic + Jev" },
  { id: "page.while_write.faq_when_useful", label: "FAQ section where readers have follow-up questions", method: "Jev judgment" },
  { id: "page.while_write.compare_table", label: "Comparison table when comparing options", method: "Jev judgment" },
  { id: "page.while_write.clear_next_step", label: "Clear next step for the reader", method: "Jev judgment", note: "Pasted drafts only; a crawled page's stored excerpt stops at 2,000 characters." },
  { id: "page.while_write.crawlable_text", label: "Important information in crawlable text", method: "Measured" },
  { id: "page.details.title", label: "Clear descriptive title", method: "Measured" },
  { id: "page.details.meta_description", label: "Meta description that earns the click", method: "Measured" },
  { id: "page.details.url", label: "Short descriptive URL", method: "Measured", note: "After publishing." },
  { id: "page.details.alt_text", label: "Descriptive alt text on informative images", method: "Measured" },
  { id: "page.publish_check.internal_links", label: "Internal links with descriptive anchor text", method: "Measured" },
  { id: "page.publish_check.sources", label: "Credible sources where claims need support", method: "Measured" },
  { id: "page.publish_check.numbers_sourced", label: "Specific numbers are sourced", method: "Jev judgment", note: "Only when the text contains numbers." },
  { id: "page.publish_check.product_facts", label: "Product facts match the provided fields", method: "Jev judgment", note: "Only when product fields are provided." },
  { id: "page.publish_check.schema_fit", label: "Structured data type fits the page type", method: "Jev judgment", note: "Only when JSON-LD is present." },
  { id: "page.publish_check.indexability", label: "Crawlability, indexability + canonical", method: "Measured", note: "After publishing." },
  { id: "page.publish_check.structured_data_ux", label: "Structured data, mobile UX + Core Web Vitals", method: "Measured", note: "After publishing." },
];

const countBy = (m: CheckMethodLabel) => DRAFT_CHECKS.filter((c) => c.method === m).length;
export const DRAFT_CHECKS_SUMMARY = `${DRAFT_CHECKS.length} checks: ${countBy("Measured")} measured, ${countBy("Heuristic")} word heuristic, ${countBy("Jev judgment")} answered by Jev as yes/no questions, and ${countBy("Heuristic + Jev")} word heuristics replaced by a Jev yes/no judgment when TypeSafe is configured. Jev answers are judgments, not measurements; uncertain ones say "Check this yourself".`;

// ------------------------------------------------------------------ verdict
export type VerdictTone = "success" | "warning" | "danger";

export const VERDICT_META: Record<DraftCheckResult["verdict"], { label: string; tone: VerdictTone; symbol: string; explanation: string }> = {
  pass: {
    label: "Pass",
    tone: "success",
    symbol: "✓",
    explanation: "Nothing blocking was found by the checks that ran. A person should still review it before publishing.",
  },
  needs_review: {
    label: "Needs review",
    tone: "warning",
    symbol: "!",
    explanation: "Some excerpts or checklist items need a person to look at them before this goes further.",
  },
  fail: {
    label: "Fail",
    tone: "danger",
    symbol: "✕",
    explanation: "At least one blocking issue was found. Fix the flagged items below and run the check again.",
  },
};

export function verdictText(verdict: DraftCheckResult["verdict"]): string {
  const m = VERDICT_META[verdict];
  return m ? `${m.label}: ${m.explanation}` : String(verdict);
}

// ------------------------------------------------------------------ flags
export const FLAG_KIND_ORDER: DraftCheckFlag["kind"][] = ["unsupported_claim", "fabricated_testimonial", "guarantee_language", "filler"];

export const FLAG_KIND_META: Record<DraftCheckFlag["kind"], { label: string; description: string }> = {
  unsupported_claim: {
    label: "Unsupported claim",
    description: "A factual, numeric, or comparative claim with no source or evidence given. Add the source or soften the claim.",
  },
  fabricated_testimonial: {
    label: "Unsourced testimonial",
    description: "A quoted review or endorsement attributed to a person or outlet with no source. Okara can't tell whether it is real: verify it and link the source, or remove it. Never publish invented testimonials.",
  },
  guarantee_language: {
    label: "Guarantee language",
    description: "Promises of outcomes that cannot be guaranteed (results, rankings, cures). Rephrase as what the product does.",
  },
  filler: {
    label: "Filler",
    description: "Wording that adds length without adding information.",
  },
};

export const FLAG_METHOD_LABEL: Record<DraftCheckFlag["method"], string> = { rule: "Rule", jev: "Jev" };
export const FLAG_METHOD_HINT: Record<DraftCheckFlag["method"], string> = {
  rule: "Matched by a fixed text rule.",
  jev: "Judged by Jev (a model). Check it yourself.",
};

export interface FlagGroup {
  kind: DraftCheckFlag["kind"];
  label: string;
  description: string;
  flags: DraftCheckFlag[];
}

/** Groups flags by kind in a fixed order, keeping server order within a group. Unknown kinds go last under their raw name. */
export function groupFlags(flags: DraftCheckFlag[]): FlagGroup[] {
  const byKind = new Map<string, DraftCheckFlag[]>();
  for (const f of flags) {
    const list = byKind.get(f.kind) ?? [];
    list.push(f);
    byKind.set(f.kind, list);
  }
  const kinds = [...FLAG_KIND_ORDER.filter((k) => byKind.has(k)), ...[...byKind.keys()].filter((k) => !FLAG_KIND_ORDER.includes(k as DraftCheckFlag["kind"]))];
  return kinds.map((kind) => {
    const meta = FLAG_KIND_META[kind as DraftCheckFlag["kind"]] ?? { label: kind.replace(/_/g, " "), description: "" };
    return { kind: kind as DraftCheckFlag["kind"], label: meta.label, description: meta.description, flags: byKind.get(kind)! };
  });
}

/** The noul value exactly as returned (no rounding or rescaling); null when absent. */
export function noulText(noul: number | null | undefined): string | null {
  return typeof noul === "number" && Number.isFinite(noul) ? String(noul) : null;
}

/** Server labels minus the one the page already shows. */
export function extraLabels(labels: string[]): string[] {
  const seen = new Set<string>([GATE_LABEL]);
  return labels.filter((l) => {
    const t = l.trim();
    if (!t || seen.has(t)) return false;
    seen.add(t);
    return true;
  });
}

// ------------------------------------------------------------------ checklist
/**
 * Draft results are not persisted per item, so manual controls are removed: items keep their status,
 * but `manual` is cleared so ChecklistView renders no "Mark as done" form (it has no read-only prop).
 */
export function readOnlyChecklist(c: Checklist): Checklist {
  return { ...c, items: c.items.map((i) => (i.manual ? { ...i, manual: null } : i)) };
}

// ------------------------------------------------------------------ pages
const PAGE_TYPE_LABEL: Record<PageType, string> = {
  home: "Home",
  collection: "Collection",
  product: "Product",
  article: "Article",
  landing: "Landing",
  other: "Other",
};

export function pageTypeLabel(t: PageType): string {
  return PAGE_TYPE_LABEL[t] ?? t;
}

export function pageOptionLabel(p: PageRow): string {
  const base = `${p.url} — ${pageTypeLabel(p.pageType)}`;
  return p.skippedReason ? `${base} (skipped: ${p.skippedReason})` : base;
}

/** Pages sorted by URL for the select. */
export function sortPages(pages: PageRow[]): PageRow[] {
  return [...pages].sort((a, b) => a.url.localeCompare(b.url));
}

// ------------------------------------------------------------------ 400 details
/**
 * Extracts validation messages from an ApiError body's `details` (shape not fixed by the contract).
 * Accepts: string[]; [{path|field, message}]; {issues: [...]}; {fieldErrors: {field: string[]}}; {field: string}.
 * Messages whose field is a known form field are returned in `fields`; the rest in `general`.
 */
export function parseValidationDetails(details: unknown): { fields: FormErrors; general: string[] } {
  const fields: FormErrors = {};
  const general: string[] = [];
  const known = new Set<string>(FIELD_ORDER);
  const add = (field: unknown, message: unknown) => {
    if (typeof message !== "string" || !message.trim()) return;
    const f = Array.isArray(field) ? field[0] : field;
    if (typeof f === "string" && known.has(f) && !fields[f as DraftField]) fields[f as DraftField] = message;
    else general.push(message);
  };
  const walk = (d: unknown) => {
    if (!d) return;
    if (typeof d === "string") return add(null, d);
    if (Array.isArray(d)) {
      for (const x of d) {
        if (typeof x === "string") add(null, x);
        else if (x && typeof x === "object") {
          const o = x as Record<string, unknown>;
          add(o.path ?? o.field, o.message);
        }
      }
      return;
    }
    if (typeof d === "object") {
      const o = d as Record<string, unknown>;
      if (Array.isArray(o.issues)) return walk(o.issues);
      if (o.fieldErrors && typeof o.fieldErrors === "object") {
        for (const [k, v] of Object.entries(o.fieldErrors as Record<string, unknown>)) add(k, Array.isArray(v) ? v[0] : v);
        return;
      }
      for (const [k, v] of Object.entries(o)) add(k, Array.isArray(v) ? v[0] : v);
    }
  };
  walk(details);
  return { fields, general };
}
