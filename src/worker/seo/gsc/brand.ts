/**
 * Brand / non-brand classification of Search Console queries [A23] (deterministic; versioned).
 *
 * Method (BRAND_METHOD_VERSION):
 *  1. Terms: the project's brand name + brand aliases ("self") and every competitor's name + aliases
 *     ("competitor"). Domains are not turned into terms (a hostname label is not reliably a brand).
 *     A term shorter than MIN_TERM_CHARS characters after normalization is skipped (too ambiguous), and a
 *     term listed as both self and competitor is skipped on both sides (alias collisions are resolved by
 *     the user, never guessed).
 *  2. Normalization (terms and queries alike): Unicode NFKC, lowercase, accents removed (NFD, combining
 *     marks dropped), every run of non-letter/non-digit characters becomes one space.
 *  3. A term matches when its words appear in the query as a contiguous run of whole words (word
 *     boundaries: "brass co" matches "brass co knobs" but not "brass cabinet"). A multi-word term also
 *     matches its spaceless form as one word ("residence example" -> "residenceexample") when that form
 *     has at least MIN_JOINED_CHARS characters.
 *  4. Kind: self_brand when any self term matches (even if a competitor term matches too); otherwise
 *     competitor_brand when a competitor term matches; otherwise non_brand.
 *
 * The brand split counts self_brand queries as "brand" and everything else as "non-brand".
 * Competitor-brand queries are non-brand for the split (they are demand this site does not own) but are
 * counted and flagged separately. Weak-CTR and striking-distance candidates exclude self-brand queries;
 * the demand curve is built from non-brand queries by default.
 */
import type { Ratio } from "@shared/types";
import { ratio } from "./aggregate";

export const BRAND_METHOD_VERSION = "brand-split-2026-09-30.1";
export const MIN_TERM_CHARS = 3;
export const MIN_JOINED_CHARS = 6;

export type BrandKind = "self_brand" | "competitor_brand" | "non_brand";

export interface BrandTermsInput {
  brandName: string | null | undefined;
  brandAliases: readonly string[];
  competitors: ReadonlyArray<{ name?: string | null; aliases?: readonly string[] | null }>;
}

export interface BrandTerms {
  /** Normalized self terms (brand name + aliases). */
  self: string[];
  /** Normalized competitor terms (names + aliases). */
  competitors: string[];
  /** Terms left out, with the reason (shown in the method note). */
  skipped: Array<{ term: string; reason: "too_short" | "collision" }>;
}

export interface BrandMatch {
  kind: BrandKind;
  /** The self term that matched (null unless self_brand). */
  selfTerm: string | null;
  /** The competitor term that matched, when any (also set for self_brand queries that name a competitor). */
  competitorTerm: string | null;
}

export function normalizeBrandText(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .normalize("NFKC")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Build the normalized term lists from project settings. Pure. */
export function brandTermsFrom(input: BrandTermsInput): BrandTerms {
  const skipped: BrandTerms["skipped"] = [];
  const collect = (raw: Array<string | null | undefined>) => {
    const out = new Set<string>();
    for (const r of raw) {
      const t = normalizeBrandText(r);
      if (!t) continue;
      if (t.replace(/ /g, "").length < MIN_TERM_CHARS) {
        if (!skipped.some((s) => s.term === t)) skipped.push({ term: t, reason: "too_short" });
        continue;
      }
      out.add(t);
    }
    return out;
  };
  const self = collect([input.brandName, ...input.brandAliases]);
  const comp = collect(input.competitors.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
  for (const t of [...self]) {
    if (comp.has(t)) {
      self.delete(t);
      comp.delete(t);
      skipped.push({ term: t, reason: "collision" });
    }
  }
  return { self: [...self], competitors: [...comp], skipped };
}

interface CompiledTerm {
  term: string;
  words: string[];
  joined: string | null;
}

function compile(terms: string[]): CompiledTerm[] {
  return terms.map((term) => {
    const words = term.split(" ").filter(Boolean);
    const joinedForm = words.join("");
    return { term, words, joined: words.length > 1 && joinedForm.length >= MIN_JOINED_CHARS ? joinedForm : null };
  });
}

function matches(words: string[], t: CompiledTerm): boolean {
  if (t.words.length === 0) return false;
  if (t.joined && words.includes(t.joined)) return true;
  outer: for (let i = 0; i + t.words.length <= words.length; i++) {
    for (let j = 0; j < t.words.length; j++) if (words[i + j] !== t.words[j]) continue outer;
    return true;
  }
  return false;
}

export interface BrandClassifier {
  readonly terms: BrandTerms;
  classify(query: string): BrandMatch;
  isSelfBrand(query: string | null | undefined): boolean;
}

export function createBrandClassifier(terms: BrandTerms): BrandClassifier {
  const self = compile(terms.self);
  const comp = compile(terms.competitors);
  const cache = new Map<string, BrandMatch>();
  const classify = (query: string): BrandMatch => {
    const norm = normalizeBrandText(query);
    const hit = cache.get(norm);
    if (hit) return hit;
    const words = norm.split(" ").filter(Boolean);
    const s = self.find((t) => matches(words, t)) ?? null;
    const c = comp.find((t) => matches(words, t)) ?? null;
    const m: BrandMatch = { kind: s ? "self_brand" : c ? "competitor_brand" : "non_brand", selfTerm: s?.term ?? null, competitorTerm: c?.term ?? null };
    if (cache.size < 50_000) cache.set(norm, m);
    return m;
  };
  return { terms, classify, isSelfBrand: (q) => (q ? classify(q).kind === "self_brand" : false) };
}

// ------------------------------------------------------------------ brand split (SeoOverview.brandSplit)
export interface BrandSplitRow {
  query: string | null;
  clicks: number;
  impressions: number;
}

export interface BrandSplitPart {
  queries: number;
  clicks: number;
  impressions: number;
  ctr: Ratio;
}

export interface BrandSplit {
  method: string;
  brand: BrandSplitPart;
  nonBrand: BrandSplitPart;
}

export interface BrandSplitDetail {
  split: BrandSplit;
  competitorQueries: number;
  competitorImpressions: number;
}

/**
 * Split current-window query rows into brand (self) and non-brand. Rows are aggregated per normalized
 * query first so a query shown on two URLs counts as one query. CTR = Σclicks/Σimpressions (null at 0).
 * Returns null when there are no query rows or no usable brand terms (nothing to split on).
 */
export function brandSplitOf(rows: BrandSplitRow[], classifier: BrandClassifier, source: { window: string | null; basis: "query_page_rows" | "query_rows" }): BrandSplitDetail | null {
  if (classifier.terms.self.length === 0) return null;
  const agg = new Map<string, { clicks: number; impressions: number }>();
  for (const r of rows) {
    if (typeof r.query !== "string") continue;
    const k = normalizeBrandText(r.query);
    if (!k) continue;
    const a = agg.get(k) ?? { clicks: 0, impressions: 0 };
    a.clicks += Math.max(0, Math.round(Number(r.clicks) || 0));
    a.impressions += Math.max(0, Math.round(Number(r.impressions) || 0));
    agg.set(k, a);
  }
  if (agg.size === 0) return null;
  const part = () => ({ queries: 0, clicks: 0, impressions: 0 });
  const brand = part();
  const non = part();
  let competitorQueries = 0;
  let competitorImpressions = 0;
  for (const [q, a] of agg) {
    const m = classifier.classify(q);
    const target = m.kind === "self_brand" ? brand : non;
    target.queries++;
    target.clicks += a.clicks;
    target.impressions += a.impressions;
    if (m.kind === "competitor_brand") {
      competitorQueries++;
      competitorImpressions += a.impressions;
    }
  }
  const skipped = classifier.terms.skipped.length ? ` Skipped terms: ${classifier.terms.skipped.map((s) => `"${s.term}" (${s.reason === "collision" ? "listed as both brand and competitor" : "too short"})`).join(", ")}.` : "";
  const basis = source.basis === "query_page_rows" ? "summed from query+page rows (a query shown on two of your URLs counts once per URL)" : "from query rows";
  const method =
    `Deterministic alias match (${BRAND_METHOD_VERSION}): a query is brand when it contains your brand name or an alias as whole words (${classifier.terms.self.length} term${classifier.terms.self.length === 1 ? "" : "s"}; case-, accent-, and punctuation-insensitive). ` +
    `Competitor-name queries count as non-brand (${competitorQueries} this window). Search Console ${source.window ?? "current window"} impressions ${basis}; anonymized queries are excluded, so these totals are lower than the property totals.${skipped}`;
  return {
    split: {
      method,
      brand: { ...brand, ctr: ratio(brand.clicks, brand.impressions) },
      nonBrand: { ...non, ctr: ratio(non.clicks, non.impressions) },
    },
    competitorQueries,
    competitorImpressions,
  };
}
