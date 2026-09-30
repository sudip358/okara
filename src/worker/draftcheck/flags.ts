/**
 * [A23] Draft check deterministic flag scan. Flags point at wording a reviewer should verify or support;
 * they never judge who or what wrote the text (no "AI-written" labels) and never predict rankings.
 *
 * Kinds:
 *  - guarantee_language: outcome promises. Reuses the writing validator's guarantee / ranking-promise
 *    rules (validateDraft; negated wording such as "does not guarantee" is not flagged), plus
 *    "risk-free" and "100% effective/safe/successful". Commercial policy terms ("30-day money-back
 *    guarantee") are unsupported_claim instead: they need evidence that the policy exists.
 *  - fabricated_testimonial: quoted first-person praise (or a star rating) with a name/role attribution
 *    and no link or citation in the same block. The app cannot verify it, so the reviewer must.
 *  - filler: a fixed list of phrases that add no information.
 *  - unsupported_claim: "#1", superlatives ("best in the world", "industry-leading"), statistics framed
 *    as findings ("73% of homeowners", "studies show", "3x faster"), "proven" claims, and certification
 *    terms, when the sentence's block carries no link, URL, or citation marker ([1], "Source: ...",
 *    "according to <Name>").
 * Suspicious sentences the rules do not flag (numbers or comparisons without a source) are returned as
 * Jev candidates; Jev decides whether they need a source.
 */
import type { DraftCheckFlag } from "@shared/types";
import { splitSentences } from "../seo/crawl/extract";
import { validateDraft } from "../writing/validate";
import type { DraftBlock } from "./parse";

export const FLAG_RULES_VERSION = "draft-flags-2026-09-30.1";
export const MAX_FLAGS = 40;
export const MAX_FLAGS_PER_KIND = 12;
export const MAX_JEV_CANDIDATES = 8;
const EXCERPT_MAX = 300;

export const FILLER_PHRASES: readonly string[] = [
  "in today's fast-paced world",
  "in today's digital age",
  "in today's world",
  "in this day and age",
  "it goes without saying",
  "needless to say",
  "at the end of the day",
  "it is important to note that",
  "it's important to note that",
  "it is worth noting that",
  "it's worth noting that",
  "without further ado",
  "look no further",
  "last but not least",
  "all things considered",
  "for all intents and purposes",
  "the fact of the matter is",
  "when all is said and done",
  "first and foremost",
  "each and every",
  "as we all know",
  "let's dive in",
  "let's dive into",
  "dive deep into",
  "unlock the full potential",
  "take it to the next level",
  "a game-changer",
  "whether you're a beginner or an expert",
];

const FILLER_RE = new RegExp(
  `(?:^|[^\\p{L}])(${FILLER_PHRASES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "['’]")).join("|")})(?![\\p{L}])`,
  "iu",
);

/** Outcome guarantees beyond the validator's rules. */
const EXTRA_GUARANTEE_RE = /\brisk[- ]free\b|\b100\s?%\s+(?:effective|safe|successful|success|satisfaction|results?)\b|\bno[- ]risk\b/i;
/** Commercial policy terms: a claim to confirm, not an outcome promise. */
const POLICY_GUARANTEE_RE = /\b(?:money[- ]back|satisfaction|price[- ]match|lifetime|best[- ]price|\d+[- ](?:day|month|year)s?)\s+guarantee(?:d|s)?\b/i;

const SUPERLATIVE_RE =
  /(?:#\s?1\b|\bno\.\s?1\b|\bnumber[- ]one\b|\bbest in the (?:world|country|industry|business|market|business)\b|\bworld['’]s (?:best|finest|leading|most)\b|\bworld[- ]class\b|\bbest[- ]selling\b|\bbestselling\b|\bindustry[- ]leading\b|\bmarket[- ]leading\b|\bleading (?:provider|brand|manufacturer|supplier|expert)s?\b|\bmost trusted\b|\bmost popular\b|\bunbeatable\b|\bunmatched\b|\bunrivall?ed\b|\bsecond to none\b|\baward[- ]winning\b|\b(?:the )?best (?:\w+ ){0,3}(?:on|in) the market\b|\btop[- ]rated\b)/i;
const STAT_RE =
  /\b\d{1,3}(?:\.\d+)?\s?%\s+of\s+(?:\w+\s+){0,2}(?:customers|people|users|buyers|homeowners|shoppers|consumers|americans|designers|experts|clients|businesses|companies|respondents|readers|owners)\b|\b(?:studies|research|surveys?|data|experts|scientists|doctors)\s+(?:show|shows|prove|proves|found|finds|suggests?|confirms?|agree)\b|\b\d+(?:\.\d+)?\s?(?:x|times)\s+(?:faster|more|better|stronger|longer|cheaper|brighter|safer|less)\b|\b\d{1,3}(?:\.\d+)?\s?%\s+(?:more|less|faster|better|cheaper|stronger|longer|brighter|safer|fewer)\b/i;
const PROVEN_RE = /\b(?:clinically|scientifically|laboratory|lab)[- ](?:proven|tested)\b|\bproven to\b|\bFDA[- ](?:approved|cleared)\b|\bdoctor[- ]recommended\b|\bdermatologist[- ]tested\b/i;
/** Named attribution counts as a source: "according to the U.S. Department of Energy". */
const NAMED_SOURCE_RE = /\b[Aa]ccording to (?:the |a |an )?(?:\d{4} )?(?!our\b|us\b|we\b|many\b|some\b|most\b)[A-Z][\p{L}.&'-]*/u;
const CERT_LABELS = new Set(["UL listing", "ETL listing", "CSA certification", "CE marking", "Energy Star", "FCC", "ADA compliance", "Title 24", "certification", "IP rating"]);

/** Candidate claims for Jev: a number next to a comparison, or a causal/benefit verb. */
const JEV_CANDIDATE_RE =
  /(?:\b\d[\d,.]*\s?(?:%|x\b|times\b|percent\b)|\b(?:more|less|fewer|faster|slower|stronger|longer|cheaper|safer|better|healthier|lasts?)\b[^.]{0,40}\bthan\b|\b(?:reduces?|improves?|prevents?|eliminates?|increases?|boosts?|cuts?|saves?)\b[^.]{0,40}\b\d[\d,.]*)/i;

// Testimonials: quoted text, first person, praise or rating, and an attribution near the quote.
const QUOTE_RE = /[“"]([^”"\n]{12,500})[”"]/g;
const FIRST_PERSON_RE = /\b(?:I|I['’]m|I['’]ve|I['’]d|I['’]ll|[Mm]e|[Mm]y|[Ww]e|[Ww]e['’]ve|[Ww]e['’]re|[Oo]ur|us)\b/;
const PRAISE_RE =
  /\b(?:love[ds]?|loving|best|amazing|great|excellent|recommend(?:ed)?|changed|incredible|perfect|fantastic|highly|thank(?:s| you)|wonderful|awesome|beautiful|stunning|happy|impressed|five[- ]stars?|5[- ]stars?|exceeded|obsessed|game[- ]changer)\b/i;
const RATING_RE = /★{3,}|\b[45](?:\.\d)?\s?\/\s?5\b|\b[45] out of 5\b/;
const NAME = String.raw`[A-Z][\p{L}'’.-]*(?:\s+[A-Z][\p{L}'’.-]*){0,3}`;
const ATTRIBUTION_AFTER_RE = new RegExp(String.raw`^\s*[,.]?\s*(?:[—–]|-{1,2}|~)\s*(${NAME})|^\s*[,.]?\s*(?:says|said|writes|wrote|shares|shared)\s+(${NAME})`, "u");
const ATTRIBUTION_BEFORE_RE = new RegExp(String.raw`(${NAME}),?\s+(?:[\p{Ll} ,]{0,40}\s)?(?:says|said|writes|wrote|told us|shares|shared)\s*[:,]?\s*$`, "u");

export interface FlagScan {
  flags: DraftCheckFlag[];
  /** Unsourced sentences with claim-like wording that no rule flagged (for the optional Jev question). */
  jevCandidates: string[];
  /** Sentences scanned (for the completeness label). */
  sentences: number;
}

const excerpt = (s: string) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > EXCERPT_MAX ? `${t.slice(0, EXCERPT_MAX - 1)}…` : t;
};

/** Validator errors for promise language in one sentence (negated wording is only a warning there). */
function promiseErrors(sentence: string): string[] {
  const r = validateDraft([sentence], ["ev_draft"], [{ id: "ev_draft", text: "" }]);
  return r.errors.filter((e) => e.startsWith("Promise language is not allowed"));
}

function certificationErrors(sentence: string): string[] {
  const r = validateDraft([sentence], ["ev_draft"], [{ id: "ev_draft", text: "" }]);
  return r.errors.filter((e) => {
    const m = /^Certification\/spec term not present in cited evidence \(([^)]+)\)/.exec(e);
    return !!m && CERT_LABELS.has(m[1]!);
  });
}

function isSourced(sentence: string, block: DraftBlock): boolean {
  return block.hasSource || NAMED_SOURCE_RE.test(sentence) || /\[\^?\d{1,3}\]|\(\s*sources?\s*:|\bhttps?:\/\//i.test(sentence);
}

function sentencesOf(block: DraftBlock): string[] {
  if (block.kind === "table") return block.text.split("\n").filter(Boolean);
  return block.text.split("\n").flatMap((line) => splitSentences(line));
}

export function scanFlags(blocks: readonly DraftBlock[]): FlagScan {
  const flags: DraftCheckFlag[] = [];
  const seen = new Set<string>();
  const perKind = new Map<string, number>();
  const flaggedSentences = new Set<string>();
  const guaranteeSentences = new Set<string>();
  const add = (kind: DraftCheckFlag["kind"], text: string, sentenceKey?: string) => {
    const t = excerpt(text);
    const key = `${kind}|${t.toLowerCase()}`;
    if (!t || seen.has(key) || flags.length >= MAX_FLAGS) return;
    if ((perKind.get(kind) ?? 0) >= MAX_FLAGS_PER_KIND) return;
    seen.add(key);
    perKind.set(kind, (perKind.get(kind) ?? 0) + 1);
    flags.push({ kind, text: t, method: "rule", noul: null });
    if (sentenceKey) flaggedSentences.add(sentenceKey);
  };

  // 1. Testimonials (block level: the attribution can sit on the next line of a quote block).
  for (const b of blocks) {
    if (b.kind === "code") continue;
    for (const m of b.text.matchAll(QUOTE_RE)) {
      const quote = m[1]!;
      if (!FIRST_PERSON_RE.test(quote)) continue;
      const start = m.index ?? 0;
      const end = start + m[0].length;
      const after = b.text.slice(end, end + 120);
      const before = b.text.slice(Math.max(0, start - 80), start);
      const praise = PRAISE_RE.test(quote) || RATING_RE.test(b.text);
      const attrAfter = ATTRIBUTION_AFTER_RE.exec(after);
      const attrBefore = ATTRIBUTION_BEFORE_RE.exec(before);
      if (!praise || (!attrAfter && !attrBefore)) continue;
      if (b.hasSource) continue; // a linked or cited quote is attributable evidence
      const tail = attrAfter ? after.slice(0, attrAfter[0].length + after.slice(attrAfter[0].length).search(/\n|$/)) : "";
      const text = attrAfter ? `${m[0]}${tail}` : `${attrBefore![0]}${m[0]}`;
      add("fabricated_testimonial", text);
    }
  }

  // 2. Sentence-level rules.
  const candidates: string[] = [];
  let sentenceCount = 0;
  for (const b of blocks) {
    if (b.kind === "code") continue;
    for (const s of sentencesOf(b)) {
      sentenceCount++;
      const key = s.trim().toLowerCase();
      const sourced = isSourced(s, b);

      if (POLICY_GUARANTEE_RE.test(s)) {
        if (!sourced) add("unsupported_claim", s, key);
      } else if (promiseErrors(s).length > 0 || EXTRA_GUARANTEE_RE.test(s)) {
        add("guarantee_language", s, key);
        guaranteeSentences.add(key);
      }

      if (FILLER_RE.test(s)) add("filler", s, key);

      if (!sourced) {
        if (SUPERLATIVE_RE.test(s) || STAT_RE.test(s) || PROVEN_RE.test(s) || certificationErrors(s).length > 0) {
          // One flag per sentence for promises: a guarantee already covers "#1 ranking" style wording.
          if (!guaranteeSentences.has(key)) add("unsupported_claim", s, key);
        } else if (!flaggedSentences.has(key) && JEV_CANDIDATE_RE.test(s) && candidates.length < MAX_JEV_CANDIDATES) {
          const t = excerpt(s);
          if (!candidates.includes(t)) candidates.push(t);
        }
      }
    }
  }
  return { flags, jevCandidates: candidates, sentences: sentenceCount };
}
