/**
 * [A25] Defining terms per page by TF-IDF over the crawl corpus.
 *
 * Tokens: letters/digits (lower-cased, NFKC), possessive 's dropped, pure numbers and tokens shorter than
 * 3 characters dropped, stopwords (English function words, web boilerplate words, and optionally the
 * project's brand name/aliases) removed, then a light plural stemmer ("sofas" -> "sofa", "boxes" -> "box",
 * "batteries" -> "battery") so singular and plural forms match.
 *
 * Weighted term frequency per page: title x3, each H1 x3, other headings x2, link-context sentences x1.
 * idf = ln((1 + N) / (1 + df)) + 1 (smoothed; df = pages containing the term in any field).
 * score = weighted tf x idf. The top TOP_TERMS terms per page (ties broken alphabetically) are the page's
 * defining terms; `weight` = score / the page's top score, so weights are comparable across pages (0..1].
 * Site-wide vocabulary: when the corpus has at least SITE_WIDE_MIN_DOCS pages, terms found on more than
 * SITE_WIDE_SHARE of them (for example "brass" on a brass-hardware store) define no single page and are
 * not defining terms.
 */

export const TERMS_VERSION = "links-terms-2026-09-30.1";
export const TOP_TERMS = 12;
export const FIELD_WEIGHTS = { title: 3, h1: 3, heading: 2, sentence: 1 } as const;
export const SITE_WIDE_SHARE = 0.8;
export const SITE_WIDE_MIN_DOCS = 5;
const MIN_TOKEN_LENGTH = 3;

/** English function words and web boilerplate words that never define a page's topic. */
export const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "about", "above", "across", "after", "again", "against", "all", "almost", "along", "also", "although", "always", "am",
  "among", "an", "and", "another", "any", "anyone", "anything", "are", "around", "as", "at", "back", "be", "because", "been",
  "before", "being", "below", "best", "better", "between", "both", "but", "by", "can", "cannot", "could", "did", "do", "does",
  "doing", "done", "down", "during", "each", "either", "else", "enough", "etc", "even", "ever", "every", "everything", "few",
  "find", "first", "for", "from", "further", "get", "gets", "getting", "give", "go", "goes", "going", "good", "got", "great",
  "had", "has", "have", "having", "he", "her", "here", "hers", "herself", "him", "himself", "his", "how", "however", "i", "if",
  "in", "include", "includes", "including", "into", "is", "it", "its", "itself", "just", "keep", "know", "last", "least",
  "less", "let", "like", "lot", "lots", "made", "make", "makes", "making", "many", "may", "me", "might", "more", "most",
  "much", "must", "my", "myself", "need", "needs", "never", "new", "next", "no", "nor", "not", "now", "of", "off", "often",
  "on", "once", "one", "only", "or", "other", "others", "our", "ours", "ourselves", "out", "over", "own", "part", "per",
  "really", "right", "same", "see", "seen", "several", "shall", "she", "should", "since", "so", "some", "something", "still",
  "such", "sure", "take", "than", "that", "the", "their", "theirs", "them", "themselves", "then", "there", "these", "they",
  "thing", "things", "this", "those", "though", "through", "thus", "to", "today", "too", "two", "under", "until", "up",
  "upon", "us", "use", "used", "uses", "using", "very", "via", "want", "was", "way", "ways", "we", "well", "were", "what",
  "when", "where", "whether", "which", "while", "who", "whom", "whose", "why", "will", "with", "within", "without", "would",
  "yet", "you", "your", "yours", "yourself", "yourselves",
  // web boilerplate
  "click", "read", "learn", "page", "pages", "site", "website", "home", "menu", "cart", "account", "login", "log", "sign",
  "search", "view", "shop", "buy", "free", "info", "information", "link", "links", "more", "welcome", "contact", "privacy",
  "cookie", "cookies", "terms", "copyright", "rights", "reserved", "skip", "content", "main", "close", "open", "toggle",
]);

/** Words that stay as they are in the plural stemmer. */
const STEM_EXCEPTIONS = new Set(["series", "species", "news", "glass", "gas", "bus", "lens", "cannabis", "chassis", "canvas", "dais", "always", "perhaps", "towards", "various", "previous", "famous", "gorgeous", "analysis", "basis", "thesis", "hvac", "lcd"]);

/** Light English plural stemmer (never touches words of 3 characters or fewer). */
export function stem(word: string): string {
  const w = word.toLowerCase();
  if (w.length <= 3 || STEM_EXCEPTIONS.has(w)) return w;
  if (w.endsWith("ies") && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith("sses")) return w.slice(0, -2);
  if (/(?:x|zz|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s") && !/(?:ss|us|is|ous)$/.test(w)) return w.slice(0, -1);
  return w;
}

export interface WordToken {
  /** Original text of the word as it appears in the input. */
  surface: string;
  lower: string;
  stem: string;
  start: number;
  end: number;
}

const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu;

/** Every word in `text` with its offsets (no stopword filtering). */
export function wordTokens(text: string): WordToken[] {
  const out: WordToken[] = [];
  const t = text.normalize("NFKC");
  for (const m of t.matchAll(WORD_RE)) {
    const surface = m[0];
    const lower = surface.toLowerCase().replace(/['’]s$/, "");
    out.push({ surface, lower, stem: stem(lower), start: m.index, end: m.index + surface.length });
  }
  return out;
}

/** True when a lower-cased word can be a term (not a stopword, long enough, not a pure number). */
export function isTermWord(lower: string, extraStop?: ReadonlySet<string>): boolean {
  if (lower.length < MIN_TOKEN_LENGTH || /^\p{N}+$/u.test(lower)) return false;
  if (STOPWORDS.has(lower)) return false;
  if (extraStop && (extraStop.has(lower) || extraStop.has(stem(lower)))) return false;
  return true;
}

/** Term stems in `text` (stopwords removed), in order, with repeats. */
export function termStems(text: string | null | undefined, extraStop?: ReadonlySet<string>): string[] {
  if (!text) return [];
  return wordTokens(text)
    .filter((w) => isTermWord(w.lower, extraStop))
    .map((w) => w.stem);
}

/** Brand name and aliases as extra stopwords (lower-cased words and their stems). */
export function brandStopwords(brandName: string | null | undefined, aliases: readonly string[] = []): Set<string> {
  const out = new Set<string>();
  for (const s of [brandName ?? "", ...aliases]) {
    for (const w of wordTokens(s)) {
      if (w.lower.length < MIN_TOKEN_LENGTH) continue;
      out.add(w.lower);
      out.add(w.stem);
    }
  }
  return out;
}

export interface TermDoc {
  id: string;
  title: string | null;
  h1s: readonly string[];
  /** Headings other than H1. */
  headings: readonly string[];
  sentences: readonly string[];
}

export interface DefiningTerm {
  /** Stemmed term (the matching key). */
  term: string;
  /** Most frequent surface form on the page, lower-cased (for display). */
  label: string;
  /** Raw TF-IDF score. */
  score: number;
  /** score / the page's highest score, 0..1. */
  weight: number;
}

/** Defining terms for every document, keyed by document id. */
export function computeDefiningTerms(docs: readonly TermDoc[], opts: { extraStop?: ReadonlySet<string>; top?: number } = {}): Map<string, DefiningTerm[]> {
  const top = opts.top ?? TOP_TERMS;
  const tfs = new Map<string, Map<string, number>>();
  const labels = new Map<string, Map<string, Map<string, number>>>();
  const df = new Map<string, number>();

  for (const doc of docs) {
    const tf = new Map<string, number>();
    const lab = new Map<string, Map<string, number>>();
    const add = (text: string | null | undefined, weight: number) => {
      if (!text) return;
      for (const w of wordTokens(text)) {
        if (!isTermWord(w.lower, opts.extraStop)) continue;
        tf.set(w.stem, (tf.get(w.stem) ?? 0) + weight);
        const forms = lab.get(w.stem) ?? new Map<string, number>();
        forms.set(w.lower, (forms.get(w.lower) ?? 0) + 1);
        lab.set(w.stem, forms);
      }
    };
    add(doc.title, FIELD_WEIGHTS.title);
    for (const h of doc.h1s) add(h, FIELD_WEIGHTS.h1);
    for (const h of doc.headings) add(h, FIELD_WEIGHTS.heading);
    for (const s of doc.sentences) add(s, FIELD_WEIGHTS.sentence);
    tfs.set(doc.id, tf);
    labels.set(doc.id, lab);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }

  const n = docs.length;
  const out = new Map<string, DefiningTerm[]>();
  for (const doc of docs) {
    const tf = tfs.get(doc.id)!;
    const lab = labels.get(doc.id)!;
    const siteWide = (term: string) => n >= SITE_WIDE_MIN_DOCS && (df.get(term) ?? 0) / n > SITE_WIDE_SHARE;
    const scored = [...tf.entries()]
      .filter(([term]) => !siteWide(term))
      .map(([term, f]) => ({ term, score: f * (Math.log((1 + n) / (1 + (df.get(term) ?? 0))) + 1) }));
    scored.sort((a, b) => b.score - a.score || (a.term < b.term ? -1 : a.term > b.term ? 1 : 0));
    const kept = scored.slice(0, top);
    const max = kept[0]?.score ?? 0;
    out.set(
      doc.id,
      kept.map((k) => {
        const forms = [...(lab.get(k.term) ?? new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length);
        return { term: k.term, label: forms[0]?.[0] ?? k.term, score: round(k.score), weight: max > 0 ? round(k.score / max) : 0 };
      }),
    );
  }
  return out;
}

export function round(x: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}
