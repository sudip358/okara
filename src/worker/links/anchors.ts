/**
 * [A25] Anchor phrase candidates for one source -> target pair.
 *
 * Candidates are contiguous phrases of 1..MAX_ANCHOR_WORDS words inside the pair's candidate sentences,
 * within one clause (no commas, semicolons, colons, brackets, dashes, or quotes inside), that:
 *   - contain at least one of the target's defining terms,
 *   - do not start or end with a stopword,
 *   - are not generic ("click here", "read more", "this page", ...; see isGenericAnchor),
 *   - are at least 4 characters when they are a single word.
 * Score (ANCHORS_VERSION):
 *   term weight   sum of the weights of the distinct target terms in the phrase
 * + title/H1     +1.5 when the phrase (2+ words) appears word-for-word, as stems, in the target title or an H1
 * + density      share of the phrase's words that are target terms or title/H1 words
 * + length       1 word -0.3, 2-3 words +0.3, 4 words +0.1, 5 words -0.2
 * + sentence     +0.2 x (1 - rank / 4) for the rank of the sentence it comes from
 * Duplicates (case-insensitive) keep their best-scoring occurrence; the top MAX_ANCHORS_PER_PAIR are kept
 * and keyed a0..a4.
 */
import { GENERIC_ANCHOR_TEXTS, isGenericAnchorText } from "../seo/crawl/extract";
import type { RankedSentence } from "./sentences";
import { STOPWORDS, round, wordTokens, type DefiningTerm, type WordToken } from "./terms";

export const ANCHORS_VERSION = "links-anchors-2026-09-30.1";
export const MAX_ANCHORS_PER_PAIR = 5;
export const MAX_ANCHOR_WORDS = 5;

/** Generic anchors rejected in addition to the crawler's list (compared normalized, lower-case). */
export const GENERIC_ANCHORS: ReadonlySet<string> = new Set([
  ...GENERIC_ANCHOR_TEXTS,
  "click here", "read more", "here", "this page", "learn more", "this article", "this guide", "this post", "this link",
  "this website", "this site", "our site", "our website", "the website", "website", "page", "article", "post", "guide",
  "the page", "that page", "the article", "the guide", "our guide", "our blog", "blog", "more here", "see here", "go here",
  "read this", "check out", "check this out", "find out", "find out more", "learn more about", "read more about",
  "more details", "full details", "full article", "source", "website link", "url", "homepage", "home page", "home",
  "shop now", "buy now", "view all", "see all", "view details", "view product", "discover more", "explore", "explore more",
]);

const GENERIC_WORDS = new Set(["click", "here", "read", "more", "learn", "this", "page", "link", "article", "post", "guide", "site", "website", "now", "view", "see", "details"]);

function normalizeAnchor(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").replace(/[\s.:!?…›»→>-]+$/u, "").replace(/^[\s«‹←<-]+/u, "").trim();
}

/** True for anchors that say nothing about the target. */
export function isGenericAnchor(text: string): boolean {
  const n = normalizeAnchor(text);
  if (!n) return true;
  if (isGenericAnchorText(n) || GENERIC_ANCHORS.has(n)) return true;
  const words = wordTokens(n);
  return words.length > 0 && words.every((w) => GENERIC_WORDS.has(w.lower) || STOPWORDS.has(w.lower));
}

export interface AnchorCandidate {
  /** a0..a4 by score. */
  key: string;
  text: string;
  /** Key of the ranked sentence (s0..s3) the phrase was taken from. */
  sentenceKey: string;
  /** Index into the source page's stored sentences. */
  sentenceIndex: number;
  score: number;
  inTitle: boolean;
  matched: string[];
}

const CLAUSE_BREAK = /[,;:()[\]{}"“”«»|–—]|\s-\s|\.\s/u;

/** Split tokens into clauses: a new clause starts where the text between two words has punctuation. */
function clauses(text: string, words: WordToken[]): WordToken[][] {
  const out: WordToken[][] = [];
  let cur: WordToken[] = [];
  words.forEach((w, i) => {
    if (i > 0 && CLAUSE_BREAK.test(text.slice(words[i - 1]!.end, w.start))) {
      if (cur.length) out.push(cur);
      cur = [];
    }
    cur.push(w);
  });
  if (cur.length) out.push(cur);
  return out;
}

function containsSeq(hay: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > hay.length) return false;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

const LENGTH_ADJ = [0, -0.3, 0.3, 0.3, 0.1, -0.2];

export function anchorCandidates(
  sentences: readonly RankedSentence[],
  target: { terms: readonly DefiningTerm[]; title: string | null; h1s: readonly string[] },
  max = MAX_ANCHORS_PER_PAIR,
): AnchorCandidate[] {
  const weightOf = new Map(target.terms.map((t) => [t.term, t.weight]));
  const titleSeqs = [target.title, ...target.h1s].filter((s): s is string => !!s).map((s) => wordTokens(s).map((w) => w.stem));
  const titleStems = new Set(titleSeqs.flat());
  const best = new Map<string, Omit<AnchorCandidate, "key">>();

  sentences.forEach((s, rank) => {
    const words = wordTokens(s.text);
    for (const clause of clauses(s.text, words)) {
      for (let i = 0; i < clause.length; i++) {
        if (STOPWORDS.has(clause[i]!.lower)) continue;
        for (let j = i; j < Math.min(clause.length, i + MAX_ANCHOR_WORDS); j++) {
          const last = clause[j]!;
          if (STOPWORDS.has(last.lower)) continue;
          const span = clause.slice(i, j + 1);
          const matched = [...new Set(span.map((w) => w.stem).filter((st) => weightOf.has(st)))];
          if (matched.length === 0) continue;
          const text = s.text.slice(clause[i]!.start, last.end);
          if (span.length === 1 && text.length < 4) continue;
          if (isGenericAnchor(text)) continue;
          const stems = span.map((w) => w.stem);
          const inTitle = span.length >= 2 && titleSeqs.some((seq) => containsSeq(seq, stems));
          const termWeight = matched.reduce((a, st) => a + (weightOf.get(st) ?? 0), 0);
          const density = span.filter((w) => weightOf.has(w.stem) || titleStems.has(w.stem)).length / span.length;
          const score = round(termWeight + (inTitle ? 1.5 : 0) + density + (LENGTH_ADJ[span.length] ?? 0) + 0.2 * (1 - rank / 4));
          const k = text.toLowerCase();
          const prev = best.get(k);
          if (!prev || score > prev.score) best.set(k, { text, sentenceKey: s.key, sentenceIndex: s.index, score, inTitle, matched });
        }
      }
    }
  });

  return [...best.values()]
    .sort((a, b) => b.score - a.score || a.text.length - b.text.length || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0))
    .slice(0, max)
    .map((a, i) => ({ key: `a${i}`, ...a }));
}

/**
 * Deterministic pick: the best-ranked sentence and the best anchor inside it; when that sentence has no
 * anchor candidate, the best anchor overall and its sentence.
 */
export function deterministicPick(
  sentences: readonly RankedSentence[],
  anchors: readonly AnchorCandidate[],
): { sentence: RankedSentence; anchor: AnchorCandidate } | null {
  const first = sentences[0];
  if (!first || anchors.length === 0) return null;
  const inFirst = anchors.find((a) => a.sentenceKey === first.key);
  if (inFirst) return { sentence: first, anchor: inFirst };
  const a = anchors[0]!;
  const s = sentences.find((x) => x.key === a.sentenceKey);
  return s ? { sentence: s, anchor: a } : null;
}

/** True when `anchor` occurs in `sentence` (case-insensitive). */
export function anchorInSentence(anchor: string, sentence: string): boolean {
  return sentence.toLowerCase().includes(anchor.toLowerCase());
}
