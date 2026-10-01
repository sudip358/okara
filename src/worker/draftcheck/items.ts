/**
 * Draft-check-only checklist items (2026-10-01, "7 workflows" reference): nine items on top of the 16
 * per-page on-page items, so a draft check runs 25 checks.
 *
 *   page.while_write.answer_first_40_words     measured: the first 40 words of the opening share the target
 *                                               query's words (deterministic; never asked of Jev)
 *   page.while_write.faq_when_useful            Jev Noul (seo.draft.faq_when_useful)
 *   page.while_write.compare_table              Jev Noul (seo.draft.compare_table)
 *   page.while_write.headings_match_questions   Jev Noul (seo.draft.headings_match_questions)
 *   page.while_write.clear_next_step            Jev Noul (seo.draft.clear_next_step)
 *   page.before_write.author_credentials        Jev Noul (seo.draft.author_credentials)
 *   page.publish_check.numbers_sourced          Jev Noul (seo.draft.numbers_sourced)
 *   page.publish_check.product_facts            Jev Noul (seo.draft.product_facts), only with provided fields
 *   page.publish_check.schema_fit               Jev Noul (seo.draft.schema_fit), only with JSON-LD types
 * "Internal links present" is the existing measured item page.publish_check.internal_links (the draft's own
 * same-site links are counted); it is not asked of Jev because code can count links.
 *
 * Without Jev (or when Jev's answer is withheld) the Jev items stay `manual` with a measured hint in the
 * summary; items whose inputs are absent are `not_applicable` or `unknown` and Jev is not asked.
 * Nothing here predicts rankings, citations, or traffic.
 */
import type { ChecklistStatus, PageType } from "@shared/types";
import { THRESHOLDS } from "../checklists/signals";
import { coverage, isQuestionHeading, pct, tokenSet } from "../checklists/text";
import type { ItemDef, ItemResult } from "../checklists/items/common";
import { countWords, splitSentences } from "../seo/crawl/extract";

export const FIRST_WORDS = 40;
export const MAX_PRODUCT_FACTS = 20;

export interface DraftItemContext {
  mode: "draft" | "page";
  targetQuery: string;
  pageType: PageType;
  /** Opening paragraph (first paragraph with 3+ words), or null. */
  opening: string | null;
  headings: Array<{ level: number; text: string }>;
  /** Body text without headings or code. For crawled pages: the stored excerpt and link-context sentences. */
  body: string;
  tableCount: number;
  author: string | null;
  schemaTypes: string[];
  /** Outbound links plus citation markers found (drafts: outbound links; pages: outbound citations). */
  sourceCount: number;
  /** True when the whole text is available (pasted drafts); false for a crawled page's compact excerpt. */
  fullText: boolean;
  productFacts: Record<string, string> | null;
  measurable: boolean;
}

const NOT_MEASURABLE: ItemResult = {
  status: "unknown",
  method: "measured",
  summary: "This page has no crawl snapshot yet, so this cannot be checked.",
  guidance: "Run an SEO crawl of the verified site, then check the page again.",
};

/** The first `n` words of a text (whitespace-separated), joined with single spaces. Pure. */
export function firstWords(text: string | null | undefined, n = FIRST_WORDS): string {
  if (!text) return "";
  return text.trim().split(/\s+/).filter(Boolean).slice(0, n).join(" ");
}

/**
 * Measured: share of the target query's content words found in the first 40 words of the opening.
 * met >= THRESHOLDS.answerCoverage (60%), partial > 0, not_met 0 or no opening; unknown when the query
 * has no content words. Pure.
 */
export function answerInFirstWords(opening: string | null, query: string): { status: ChecklistStatus; coverage: number | null; words: string } {
  const words = firstWords(opening);
  if (!words) return { status: "not_met", coverage: null, words };
  const cov = coverage(query, tokenSet(words));
  if (cov === null) return { status: "unknown", coverage: null, words };
  return { status: cov >= THRESHOLDS.answerCoverage ? "met" : cov > 0 ? "partial" : "not_met", coverage: cov, words };
}

const FAQ_HEADING = /\b(faqs?|frequently asked|common questions|questions and answers|q&a)\b/i;
const COMPARE_WORDS = /\b(vs\.?|versus|compare[sd]?|comparison|alternatives?|best|top \d+)\b/i;
const BYLINE = /(?:^|\n)\s*(?:by|written by|reviewed by|author:)\s+\p{Lu}/iu;
const HAS_NUMBER = /\d/;

export const hasNumbers = (text: string) => HAS_NUMBER.test(text);
export const subheadings = (ctx: Pick<DraftItemContext, "headings">) => ctx.headings.filter((h) => h.level > 1);

const subject = (ctx: DraftItemContext) => (ctx.mode === "draft" ? "The draft" : "The page excerpt");
const jevHint = " Jev (TypeSafe) answers this yes/no when configured; otherwise check it yourself.";

function manual(summary: string, guidance: string, extra: Partial<ItemResult> = {}): ItemResult {
  return { status: "manual", method: "manual", summary: `${summary}${jevHint}`, guidance, ...extra };
}

export const DRAFT_EXTRA_ITEMS: ItemDef<DraftItemContext>[] = [
  {
    id: "page.while_write.answer_first_40_words",
    section: "while_write",
    label: "Answer in the first 40 words",
    tier: null,
    evaluate(ctx) {
      const guidance = "Put the direct answer to the target query in the first 40 words of the opening paragraph, then add detail.";
      if (!ctx.measurable) return NOT_MEASURABLE;
      const r = answerInFirstWords(ctx.opening, ctx.targetQuery);
      return {
        status: r.status,
        method: "measured",
        summary: !r.words
          ? `${subject(ctx)} has no opening paragraph.`
          : r.coverage === null
            ? `The target query "${ctx.targetQuery}" has no content words to look for.`
            : `The first ${Math.min(FIRST_WORDS, countWords(r.words))} words of the opening contain ${pct(r.coverage)} of the words in the target query "${ctx.targetQuery}".`,
        evidence: r.words ? [{ label: `First ${FIRST_WORDS} words`, url: null, detail: r.words }] : [],
        guidance,
        caveat: "Measured word overlap in the first 40 words (60% or more counts as met), not a judgment of answer quality. Never stuff the query into the opening.",
      };
    },
  },
  {
    id: "page.while_write.faq_when_useful",
    section: "while_write",
    label: "FAQ section where readers have follow-up questions",
    tier: null,
    evaluate(ctx) {
      if (!ctx.measurable) return NOT_MEASURABLE;
      const q = ctx.headings.filter((h) => isQuestionHeading(h.text)).length;
      const faq = ctx.headings.some((h) => FAQ_HEADING.test(h.text));
      return manual(
        `${subject(ctx)} has ${faq ? "an FAQ heading" : "no FAQ heading"} and ${q} question-style heading${q === 1 ? "" : "s"}.`,
        "Where searchers have common follow-up questions, answer them in a short FAQ or question-led sections. Skip the FAQ when the topic has none.",
      );
    },
  },
  {
    id: "page.while_write.compare_table",
    section: "while_write",
    label: "Comparison table when comparing options",
    tier: null,
    evaluate(ctx) {
      if (!ctx.measurable) return NOT_MEASURABLE;
      const comparing = COMPARE_WORDS.test(ctx.targetQuery) || ctx.headings.some((h) => /\b(vs\.?|versus|compar)/i.test(h.text));
      return manual(
        `${subject(ctx)} has ${ctx.tableCount} table${ctx.tableCount === 1 ? "" : "s"}; the target query or headings ${comparing ? "use" : "do not use"} comparison wording.`,
        "When the text compares products, materials, or options, put the comparison in a table with the same attributes for each option.",
      );
    },
  },
  {
    id: "page.while_write.headings_match_questions",
    section: "while_write",
    label: "Subheadings match the reader's questions",
    tier: null,
    evaluate(ctx) {
      if (!ctx.measurable) return NOT_MEASURABLE;
      const subs = subheadings(ctx);
      if (subs.length < 2) {
        return {
          status: "not_applicable",
          method: "measured",
          summary: `${subject(ctx)} has ${subs.length} subheading${subs.length === 1 ? "" : "s"}, so there is nothing to match against the reader's questions.`,
          guidance: "Add descriptive subheadings first (see \"Clear main heading + descriptive subheadings\").",
        };
      }
      const q = subs.filter((h) => isQuestionHeading(h.text)).length;
      return manual(
        `${q} of ${subs.length} subheadings are phrased as questions.`,
        "Phrase subheadings the way a searcher asks (or clearly names) each subtopic, so a reader scanning them finds their question.",
      );
    },
  },
  {
    id: "page.while_write.clear_next_step",
    section: "while_write",
    label: "Clear next step for the reader",
    tier: null,
    evaluate(ctx) {
      if (!ctx.measurable) return NOT_MEASURABLE;
      if (!ctx.fullText) {
        return {
          status: "unknown",
          method: "measured",
          summary: "Only the first 2,000 characters of the crawled page are stored, so the end of the page cannot be checked.",
          guidance: "Check the end of the live page yourself: tell the reader what to do next (buy, contact, read the next guide).",
        };
      }
      return manual("Whether the text ends with a clear next step is a reading judgment.", "Tell the reader what to do next: buy, book, contact, or read the next guide, with a link where it helps.");
    },
  },
  {
    id: "page.before_write.author_credentials",
    section: "before_write",
    label: "Author named with relevant credentials",
    tier: null,
    evaluate(ctx) {
      if (!ctx.measurable) return NOT_MEASURABLE;
      const byline = BYLINE.test(ctx.body);
      return manual(
        ctx.author ? `Declared author: "${ctx.author}".` : byline ? "A byline line was found in the text." : `${subject(ctx)} declares no author and has no byline line.`,
        "Name the author or reviewer and state the experience or credentials that make them qualified on this topic.",
      );
    },
  },
  {
    id: "page.publish_check.numbers_sourced",
    section: "publish_check",
    label: "Specific numbers are sourced",
    tier: null,
    evaluate(ctx) {
      if (!ctx.measurable) return NOT_MEASURABLE;
      const withNumbers = splitSentences(ctx.body).filter(hasNumbers).length;
      if (withNumbers === 0) {
        return { status: "not_applicable", method: "measured", summary: `${subject(ctx)} contains no numbers.`, guidance: "When you add prices, measurements, or statistics, say where each comes from." };
      }
      return manual(
        `${withNumbers} sentence${withNumbers === 1 ? "" : "s"} contain numbers; ${ctx.sourceCount} outbound source${ctx.sourceCount === 1 ? "" : "s"} or citation${ctx.sourceCount === 1 ? "" : "s"} found.`,
        "Attribute each statistic, price, or measurement to a source, your own data, or a described measurement.",
      );
    },
  },
  {
    id: "page.publish_check.product_facts",
    section: "publish_check",
    label: "Product facts match the provided fields",
    tier: null,
    evaluate(ctx) {
      if (!ctx.measurable) return NOT_MEASURABLE;
      const n = ctx.productFacts ? Object.keys(ctx.productFacts).length : 0;
      if (n === 0) {
        return ctx.pageType === "product"
          ? { status: "unknown", method: "measured", summary: "No product fields were provided, so product facts cannot be compared.", guidance: "Provide the product's fields (price, dimensions, materials, finish) to compare them with the text." }
          : { status: "not_applicable", method: "measured", summary: "No product fields were provided.", guidance: "For product copy, provide the product's fields to check the text against them." };
      }
      return manual(`${n} product field${n === 1 ? "" : "s"} provided for comparison.`, "Make every price, size, material, and finish in the text match the product's own fields.");
    },
  },
  {
    id: "page.publish_check.schema_fit",
    section: "publish_check",
    label: "Structured data type fits the page type",
    tier: null,
    evaluate(ctx) {
      if (!ctx.measurable) return NOT_MEASURABLE;
      if (ctx.schemaTypes.length === 0) {
        return {
          status: "not_applicable",
          method: "measured",
          summary: ctx.mode === "draft" ? "The draft has no JSON-LD; structured data is checked on the published page." : "The crawled page declares no JSON-LD types.",
          guidance: `Use the schema.org type that matches a ${ctx.pageType} page (for example Product for a product page, Article for an article).`,
        };
      }
      return manual(
        `JSON-LD types: ${ctx.schemaTypes.slice(0, 10).join(", ")}; page type: ${ctx.pageType}.`,
        "Use the schema.org type that describes what the page is, and only mark up content that is visible on the page.",
        { caveat: "Structured data never guarantees rich results." },
      );
    },
  },
];

export const DRAFT_EXTRA_ITEM_IDS: readonly string[] = DRAFT_EXTRA_ITEMS.map((d) => d.id);
