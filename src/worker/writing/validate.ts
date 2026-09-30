/**
 * [A10]/[A17] Output validator. Pure (no I/O). Signature is the contract used by both agents.
 *
 * Errors (draft is rejected):
 *  - a cited evidence id (argument or inline "[ev_...]" reference) that is not in `evidence`
 *  - a rule id (e.g. SEO-TITLE-MISSING, ECOM-..., AI-...) or decision id (dec_...) referenced in the text
 *    that the writer was never given: known ids are those appearing in any supplied evidence (text or
 *    data) plus `opts.knownRuleIds` / `opts.knownDecisionIds`
 *  - a number / percentage / money amount / dimension in the text that does not appear in the text
 *    or data of the cited evidence (1,234 == 1234; 12.5% == 12.50; $1,299.00 == 1299)
 *  - a certification / spec term (UL, ETL, CSA, CE, damp/wet rating, IP44/IP65, dimmable, lumens,
 *    kelvin, warranty, lead time, ...) that does not appear in the cited evidence
 *  - guarantee / ranking-promise language ("guarantee", "will rank", "ensures inclusion", "#1 ranking")
 *  - [A25] when `opts.titleQuery` is given: a suggested title ("Title: ..." / "Suggested title: ..." line,
 *    `suggested|new|proposed|revised title "..."`, or <title>...</title>) that does not contain every
 *    non-stopword term of that query (case-, accent-, and simple-plural-insensitive; word order free);
 *    a title quoted verbatim from the cited evidence (the current title) is not treated as a suggestion
 * Warnings (shown, not rejected):
 *  - negated guarantee wording ("does not guarantee"), guarantee wording quoted from evidence
 *  - URLs that do not appear in cited evidence
 *
 * Text inside "[confirm: ...]" placeholders is a request for a missing fact, so it is excluded from
 * the number and term checks and returned in `confirmPlaceholders`.
 */
export interface ValidationEvidence {
  id: string;
  text: string;
  data?: unknown;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  confirmPlaceholders: string[];
}

export interface ValidateOptions {
  /** Rule ids the caller knows exist (e.g. the rule registry); ids in supplied evidence are always known. */
  knownRuleIds?: Iterable<string>;
  /** Decision record ids the writer was given; ids in supplied evidence are always known. */
  knownDecisionIds?: Iterable<string>;
  /**
   * [A25] The page's top Search Console query: any suggested title in the text must keep its
   * non-stopword terms. Omitted (the default) = no title check, so existing callers are unaffected.
   */
  titleQuery?: string | null;
}

export const VALIDATOR_VERSION = "validator-2026-09-30.3";

const PLACEHOLDER_RE = /\[confirm:\s*([^\]]*)\]/gi;
/** Rule registry id shape (src/worker/seo/rules/registry.ts): uppercase prefix + dash-separated segments. */
const RULE_ID_RE = /(?<![A-Za-z0-9_-])(?:SEO|ECOM|AI|GEO)-[A-Z0-9]+(?:-[A-Z0-9]+)*(?![A-Za-z0-9_-])/g;
/** Decision record ids (lib/ids.ts newId("dec")): lowercase base32 suffix. */
const DECISION_ID_RE = /\bdec_[a-z0-9]+\b/g;
const EVIDENCE_REF_RE = /\[\s*((?:ev_[A-Za-z0-9_-]+)(?:\s*[,;]\s*ev_[A-Za-z0-9_-]+)*)\s*\]/g;
const URL_RE = /\bhttps?:\/\/[^\s<>"'\])]+/gi;
const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;
const DIMENSION_RE = /(\d[\d,]*(?:\.\d+)?)\s*(?:["″']|in\b|cm\b|mm\b|ft\b)?\s*[x×]\s*(\d[\d,]*(?:\.\d+)?)(?:\s*(?:["″']|in\b|cm\b|mm\b|ft\b)?\s*[x×]\s*(\d[\d,]*(?:\.\d+)?))?/gi;
/** A standalone number: not glued to a preceding letter/digit (so H1, IP44, ev_12, UTF-8 are skipped). */
const NUMBER_RE = /(?<![\p{L}\p{N}_.])(?<!\p{L}-)(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/gu;

interface TermRule {
  label: string;
  /** Pattern found in the draft text. */
  pattern: RegExp;
  /** Pattern that must be found in the cited evidence corpus (defaults to `pattern`). */
  evidence?: (match: string) => RegExp;
}

const TERM_RULES: TermRule[] = [
  { label: "UL listing", pattern: /\bc?UL(?:us)?\b(?:[- ]?listed)?/ },
  { label: "ETL listing", pattern: /\bETL\b/ },
  { label: "CSA certification", pattern: /\bCSA\b/ },
  { label: "CE marking", pattern: /\bCE\b/ },
  { label: "damp rating", pattern: /\bdamp[- ]?(?:rated|rating|location)s?\b/i, evidence: () => /\bdamp\b/i },
  { label: "wet rating", pattern: /\bwet[- ]?(?:rated|rating|location)s?\b/i, evidence: () => /\bwet[- ]?(?:rated|rating|location)/i },
  { label: "IP rating", pattern: /\bIP\s?\d{2}\b/i, evidence: (m) => new RegExp(`\\bIP\\s?${m.replace(/\D/g, "")}\\b`, "i") },
  { label: "dimmable", pattern: /\bdimmable\b/i },
  { label: "dimmer compatibility", pattern: /\bdimmer[- ]compatible\b/i, evidence: () => /\bdimm(?:er|able)/i },
  { label: "lumens", pattern: /\blumens?\b|\b\d[\d,]*\s?lm\b/i, evidence: () => /\blumens?\b|\d\s?lm\b/i },
  { label: "color temperature (kelvin)", pattern: /\bkelvin\b|\b\d{3,5}\s?K\b/, evidence: () => /\bkelvin\b|\b\d{3,5}\s?K\b/i },
  { label: "warranty", pattern: /\bwarrant(?:y|ies|ed)\b/i, evidence: () => /\bwarrant/i },
  { label: "lead time", pattern: /\blead[- ]times?\b/i },
  { label: "Energy Star", pattern: /\benergy[- ]star\b/i },
  { label: "FCC", pattern: /\bFCC\b/ },
  { label: "ADA compliance", pattern: /\bADA[- ]compliant\b|\bADA\b/ },
  { label: "Title 24", pattern: /\btitle\s?24\b/i },
  { label: "certification", pattern: /\bcertified\b|\bcertification\b/i, evidence: () => /\bcertifi/i },
];

interface GuaranteeRule {
  label: string;
  pattern: RegExp;
  /** Negation / quoting from evidence may downgrade to a warning. */
  softenable: boolean;
}

const GUARANTEE_RULES: GuaranteeRule[] = [
  { label: "guarantee language", pattern: /\bguarantee(?:s|d|ing)?\b/gi, softenable: true },
  { label: "ranking promise", pattern: /\bwill\s+(?:rank|outrank|appear\s+(?:first|at\s+the\s+top|in\s+ai))\b/gi, softenable: false },
  { label: "inclusion promise", pattern: /\bensur(?:e|es|ing)\s+(?:your\s+|the\s+brand'?s?\s+)?(?:inclusion|citations?|ai\s+citations?|rankings?)\b/gi, softenable: false },
  { label: "#1 ranking promise", pattern: /#\s?1\s+(?:rank(?:ing)?|position|spot|result)|\b(?:rank|ranking|position)\s+(?:#\s?1|number\s+one|first)\b/gi, softenable: false },
  { label: "citation promise", pattern: /\bwill\s+(?:be\s+cited|get\s+cited|cite\s+(?:you|your|the\s+brand))\b/gi, softenable: false },
];

const NEGATIONS = /\b(?:not|no|never|cannot|can't|doesn't|don't|won't|without)\b(?:\s+\w+){0,2}\s*$/i;

export function validateDraft(textFields: string[], citedEvidenceIds: string[], evidence: ValidationEvidence[], opts: ValidateOptions = {}): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const confirmPlaceholders: string[] = [];

  const byId = new Map(evidence.map((e) => [e.id, e]));
  const fullText = textFields.filter((t) => typeof t === "string").join("\n");

  // 1. Placeholders.
  for (const m of fullText.matchAll(PLACEHOLDER_RE)) {
    const p = (m[1] ?? "").trim();
    if (!p) warnings.push('Empty "[confirm: ]" placeholder.');
    else if (!confirmPlaceholders.includes(p)) confirmPlaceholders.push(p);
  }

  // 2. Evidence ids: declared and inline.
  const cited = new Set<string>();
  for (const id of citedEvidenceIds) {
    if (!byId.has(id)) errors.push(`Unknown evidence id cited: ${id}`);
    else cited.add(id);
  }
  for (const m of fullText.matchAll(EVIDENCE_REF_RE)) {
    for (const id of (m[1] ?? "").split(/\s*[,;]\s*/)) {
      if (!id) continue;
      if (!byId.has(id)) {
        const msg = `Unknown evidence id referenced in text: ${id}`;
        if (!errors.includes(msg)) errors.push(msg);
      } else if (!cited.has(id)) {
        // Referenced inline but not declared: still evidence the writer was given; include it.
        cited.add(id);
        warnings.push(`Evidence ${id} is referenced in text but missing from evidence_ids.`);
      }
    }
  }
  if (citedEvidenceIds.length === 0) errors.push("No evidence cited.");

  // 3. Build the corpus of cited evidence (text + data) and its number set.
  const corpusParts: string[] = [];
  for (const id of cited) {
    const e = byId.get(id)!;
    corpusParts.push(e.text ?? "");
    if (e.data !== undefined && e.data !== null) corpusParts.push(flattenData(e.data));
  }
  const corpus = corpusParts.join("\n");
  const corpusNumbers = extractNumbers(corpus);
  const corpusDates = new Set(corpus.match(DATE_RE) ?? []);

  // 4. Text to check: remove placeholders and evidence refs.
  let checkText = fullText.replace(PLACEHOLDER_RE, " ").replace(EVIDENCE_REF_RE, " ");

  // Rule and decision ids [A17]: known only if supplied to the writer (any evidence) or by the caller.
  const supplied = evidence.map((e) => `${e.text ?? ""}\n${e.data !== undefined && e.data !== null ? flattenData(e.data) : ""}`).join("\n");
  const knownRules = new Set<string>([...(opts.knownRuleIds ?? []), ...(supplied.match(RULE_ID_RE) ?? [])]);
  const knownDecisions = new Set<string>([...(opts.knownDecisionIds ?? []), ...(supplied.match(DECISION_ID_RE) ?? [])]);
  for (const id of new Set(checkText.match(RULE_ID_RE) ?? [])) {
    if (!knownRules.has(id)) errors.push(`Unknown rule id referenced in text: ${id}`);
  }
  for (const id of new Set(checkText.match(DECISION_ID_RE) ?? [])) {
    if (!knownDecisions.has(id)) errors.push(`Unknown decision id referenced in text: ${id}`);
  }
  checkText = checkText.replace(RULE_ID_RE, " ").replace(DECISION_ID_RE, " ");

  // URLs: must appear in evidence (warning); removed before number checks.
  for (const url of checkText.match(URL_RE) ?? []) {
    const clean = url.replace(/[.,;:]+$/, "");
    if (!corpus.includes(clean) && !corpus.includes(clean.replace(/\/$/, ""))) warnings.push(`URL not found in cited evidence: ${clean}`);
  }
  checkText = checkText.replace(URL_RE, " ");

  // Dates: exact string match.
  for (const d of checkText.match(DATE_RE) ?? []) {
    if (!corpusDates.has(d) && !corpus.includes(d)) errors.push(`Date not present in cited evidence: ${d}`);
  }
  checkText = checkText.replace(DATE_RE, " ");

  // 5. Numbers (dimensions first so "3x4" yields 3 and 4).
  const missing = new Set<string>();
  checkText = checkText.replace(DIMENSION_RE, (whole, a: string, b: string, c: string | undefined) => {
    for (const n of [a, b, c]) if (n && !hasNumber(corpusNumbers, n)) missing.add(n);
    return " ".repeat(whole.length);
  });
  for (const m of checkText.matchAll(NUMBER_RE)) {
    const n = m[1]!;
    if (!hasNumber(corpusNumbers, n)) missing.add(n);
  }
  for (const n of missing) errors.push(`Number not present in cited evidence: ${n}`);

  // 6. Certification / spec terms.
  for (const rule of TERM_RULES) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags.includes("g") ? rule.pattern.flags : rule.pattern.flags + "g");
    const seen = new Set<string>();
    for (const m of checkText.matchAll(re)) {
      const found = m[0];
      const key = found.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const evRe = rule.evidence ? rule.evidence(found) : new RegExp(rule.pattern.source, rule.pattern.flags.replace("g", ""));
      if (!evRe.test(corpus)) errors.push(`Certification/spec term not present in cited evidence (${rule.label}): "${found.trim()}"`);
    }
  }

  // 7. Guarantee / promise language.
  for (const rule of GUARANTEE_RULES) {
    for (const m of checkText.matchAll(rule.pattern)) {
      const before = checkText.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0);
      if (rule.softenable && NEGATIONS.test(before)) {
        warnings.push(`Negated ${rule.label}: "${m[0]}" (allowed; review wording).`);
        continue;
      }
      if (rule.softenable && new RegExp(rule.pattern.source, "i").test(corpus)) {
        warnings.push(`${rule.label} appears in cited evidence; confirm it is quoted, not promised: "${m[0]}".`);
        continue;
      }
      errors.push(`Promise language is not allowed (${rule.label}): "${m[0]}"`);
    }
  }

  // 8. [A25] Suggested titles keep the top query's terms.
  if (opts.titleQuery) {
    const need = [...titleTerms(opts.titleQuery)];
    if (need.length) {
      const corpusLower = corpus.toLowerCase();
      for (const title of suggestedTitles(fullText.replace(PLACEHOLDER_RE, " ").replace(EVIDENCE_REF_RE, " "))) {
        // A title quoted verbatim from the cited evidence (the page's current title) is not a suggestion.
        if (title.length >= 3 && corpusLower.includes(title.toLowerCase())) continue;
        const have = titleTerms(title);
        const missingTerms = need.filter((t) => !have.has(t));
        if (missingTerms.length) {
          errors.push(`Suggested title "${title.slice(0, 80)}" drops terms of the page's top Search Console query "${opts.titleQuery.slice(0, 80)}": ${missingTerms.join(", ")}`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors: dedupe(errors), warnings: dedupe(warnings), confirmPlaceholders };
}

// ------------------------------------------------------------------ [A25] title terms
/** English stopwords and generic search modifiers that a title does not have to repeat. */
const TITLE_STOPWORDS = new Set(
  (
    "a an and are as at be by for from has have how i in into is it its of on or our that the their them there these this to was " +
    "we what when where which who why will with you your vs versus best top near me my do does can should buy shop online new"
  ).split(" "),
);

/** Lowercased, accent-free, stopword-free terms with light plural folding ("knobs" -> "knob"). */
export function titleTerms(text: string): Set<string> {
  const out = new Set<string>();
  const norm = text.normalize("NFKC").toLowerCase().normalize("NFD").replace(/\p{M}+/gu, "");
  for (const raw of norm.split(/[^\p{L}\p{N}]+/u)) {
    if (!raw || TITLE_STOPWORDS.has(raw)) continue;
    let t = raw;
    if (t.length > 3 && t.endsWith("ies")) t = `${t.slice(0, -3)}y`;
    else if (t.length > 3 && /(sh|ch|x|ss)es$/.test(t)) t = t.slice(0, -2);
    else if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) t = t.slice(0, -1);
    out.add(t);
  }
  return out;
}

const TITLE_LINE_RE = /^[ \t>*•-]*(?:suggested |new |proposed |revised |recommended )?(?:page |seo )?title(?: tag)?\s*[:：]\s*(.+)$/gim;
const TITLE_TAG_RE = /<title>([^<]{1,300})<\/title>/gi;
const TITLE_INLINE_RE = /\b(?:suggested|new|proposed|revised|recommended) (?:page |seo )?title(?: tag)?(?:\s*[:：])?\s*["“]([^"”]{1,300})["”]/gi;

/** Suggested titles written in the draft text (see the header for the recognized forms). */
export function suggestedTitles(text: string): string[] {
  const out: string[] = [];
  const clean = (t: string) =>
    t
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[\s.;,]+$/, "")
      .replace(/^["“'`]+|["”'`]+$/g, "")
      .trim();
  for (const m of text.matchAll(TITLE_LINE_RE)) out.push(clean(m[1] ?? ""));
  for (const m of text.matchAll(TITLE_TAG_RE)) out.push(clean(m[1] ?? ""));
  for (const m of text.matchAll(TITLE_INLINE_RE)) out.push(clean(m[1] ?? ""));
  return [...new Set(out.filter((t) => t.length > 0))];
}

// ------------------------------------------------------------------ helpers
/** Normalize "1,234.50" -> 1234.5; returns null for non-numeric. */
export function normalizeNumber(raw: string): number | null {
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function extractNumbers(text: string): Set<number> {
  // Liberal on the evidence side: numbers glued to letters (IP44, 3000K, $1,299) still count.
  const out = new Set<number>();
  for (const m of text.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)) {
    const n = normalizeNumber(m[0]);
    if (n !== null) out.add(n);
  }
  return out;
}

function hasNumber(set: Set<number>, raw: string): boolean {
  const n = normalizeNumber(raw);
  if (n === null) return true;
  if (set.has(n)) return true;
  // Tolerate float representation noise (e.g. 0.1 + 0.2) but nothing else.
  for (const v of set) if (Math.abs(v - n) < 1e-9) return true;
  return false;
}

function flattenData(data: unknown): string {
  const parts: string[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 6 || v === null || v === undefined) return;
    if (typeof v === "string") parts.push(v);
    else if (typeof v === "number" || typeof v === "boolean") parts.push(String(v));
    else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        parts.push(k);
        walk(x, depth + 1);
      }
    }
  };
  walk(data, 0);
  return parts.join(" ");
}

function dedupe(list: string[]): string[] {
  return [...new Set(list)];
}
