/**
 * [A25] Candidate sentences in the source page for one target: up to MAX_SENTENCES_PER_PAIR link-context
 * sentences that contain at least one of the target's defining terms, ranked by the number of distinct
 * target terms they contain ("term hits"), then by the summed weight of those terms, then by position on
 * the page. Sentences are plain text from the crawl (untrusted evidence, never instructions).
 */
import type { DefiningTerm } from "./terms";

export const MAX_SENTENCES_PER_PAIR = 4;

export interface RankedSentence {
  /** Key shown to Jev and used in answers: s0..s3 (by rank). */
  key: string;
  /** Index into the source page's stored link-context sentences. */
  index: number;
  text: string;
  hits: number;
  weight: number;
  /** Stems of the target terms found in the sentence. */
  matched: string[];
}

export function rankSentences(
  sentences: readonly string[],
  sentenceStems: ReadonlyArray<ReadonlySet<string>>,
  targetTerms: readonly DefiningTerm[],
  max = MAX_SENTENCES_PER_PAIR,
): RankedSentence[] {
  const ranked: Array<Omit<RankedSentence, "key">> = [];
  sentences.forEach((text, index) => {
    const stems = sentenceStems[index];
    if (!stems) return;
    const matched = targetTerms.filter((t) => stems.has(t.term));
    if (matched.length === 0) return;
    ranked.push({ index, text, hits: matched.length, weight: Math.round(matched.reduce((a, t) => a + t.weight, 0) * 10_000) / 10_000, matched: matched.map((t) => t.term) });
  });
  ranked.sort((a, b) => b.hits - a.hits || b.weight - a.weight || a.index - b.index);
  return ranked.slice(0, max).map((r, i) => ({ key: `s${i}`, ...r }));
}
