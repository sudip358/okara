/**
 * [A19] AI crawler access check (advisory only).
 *
 * The token list is versioned; every entry was checked against the vendor's own documentation on
 * AI_CRAWLERS_VERIFIED_ON (sourceUrl). Tokens that could not be verified from vendor docs are omitted.
 *
 * Purposes (CrawlerPurpose):
 *  - search_engine: classic search crawlers whose index also feeds the vendor's AI search features.
 *  - answer_search: AI answer/search crawlers.
 *  - user_fetch: fetches made on a user's request. Some vendors say robots.txt may not apply to these;
 *    they are reported for information only.
 *  - training: model-training crawlers or opt-out control tokens. Blocking them is a business choice.
 *
 * Never claim that robots.txt or llms.txt settings cause or prevent citations. Only search_engine and
 * answer_search crawlers blocked at the site root produce an advisory finding.
 */
import type { AiCrawlerAccess, CrawlerPurpose } from "@shared/types";
import { guardedFetch } from "../ssrf";
import { isPathAllowed, selectGroup, type ParsedRobots, type RobotsGroup, type RobotsState } from "../crawl/robots";

export const AI_CRAWLERS_VERSION = "2026-09-30.2";
export const AI_CRAWLERS_VERIFIED_ON = "2026-09-30";

export interface AiCrawlerDef {
  token: string;
  vendor: string;
  purpose: CrawlerPurpose;
  sourceUrl: string;
  note: string;
  /**
   * Vendor-documented fallback groups used when robots.txt has no group for `token` (checked before
   * "*"). Applebot follows Googlebot rules; bingbot follows msnbot rules.
   */
  robotsFallback?: readonly string[];
  /** The vendor says robots.txt may not apply to this fetcher. */
  robotsMayNotApply?: boolean;
}

const GOOGLE_CRAWLERS = "https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers";
const BING_BOT = "https://blogs.bing.com/webmaster/2012/05/03/to-crawl-or-not-to-crawl-that-is-bingbots-question/";
const APPLE_BOT = "https://support.apple.com/en-us/119829";
const OPENAI_BOTS = "https://developers.openai.com/api/docs/bots";
const ANTHROPIC_BOTS = "https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler";
const PERPLEXITY_BOTS = "https://docs.perplexity.ai/guides/bots";
const COMMON_CRAWL_BOT = "https://commoncrawl.org/ccbot";

export const AI_CRAWLERS: readonly AiCrawlerDef[] = [
  // ------------------------------------------------------------------ search engines
  {
    token: "Googlebot",
    vendor: "Google",
    purpose: "search_engine",
    sourceUrl: GOOGLE_CRAWLERS,
    note: "Google Search crawler; its rules apply to Google Search and all Search features. Google says AI Overviews and AI Mode need a page to be indexed and eligible for a Search snippet, with no additional technical requirements.",
  },
  {
    token: "Bingbot",
    vendor: "Microsoft",
    purpose: "search_engine",
    sourceUrl: BING_BOT,
    note: "Bing's crawler indexes content that appears in Bing search results. Bing honours the bingbot group, else an msnbot group, else \"*\". (Bing's help page on its crawlers is JavaScript-only; the token is taken from the Bing Webmaster Blog.)",
    robotsFallback: ["msnbot"],
  },
  {
    token: "Applebot",
    vendor: "Apple",
    purpose: "search_engine",
    sourceUrl: APPLE_BOT,
    note: "Powers search features in Spotlight, Siri, and Safari. Apple says that if robots.txt does not mention Applebot but mentions Googlebot, Applebot follows the Googlebot rules.",
    robotsFallback: ["googlebot"],
  },
  // ------------------------------------------------------------------ AI answer / search
  {
    token: "OAI-SearchBot",
    vendor: "OpenAI",
    purpose: "answer_search",
    sourceUrl: OPENAI_BOTS,
    note: "Used to surface websites in search results in ChatGPT's search features.",
  },
  {
    token: "Claude-SearchBot",
    vendor: "Anthropic",
    purpose: "answer_search",
    sourceUrl: ANTHROPIC_BOTS,
    note: "Indexes content to improve search result quality for Claude users.",
  },
  {
    token: "PerplexityBot",
    vendor: "Perplexity",
    purpose: "answer_search",
    sourceUrl: PERPLEXITY_BOTS,
    note: "Surfaces and links websites in Perplexity search results; the vendor states it is not used to crawl content for AI foundation models.",
  },
  // ------------------------------------------------------------------ user-initiated fetchers
  {
    token: "ChatGPT-User",
    vendor: "OpenAI",
    purpose: "user_fetch",
    sourceUrl: OPENAI_BOTS,
    note: "Used for certain user actions in ChatGPT and Custom GPTs. OpenAI says that because these actions are initiated by a user, robots.txt rules may not apply.",
    robotsMayNotApply: true,
  },
  {
    token: "Claude-User",
    vendor: "Anthropic",
    purpose: "user_fetch",
    sourceUrl: ANTHROPIC_BOTS,
    note: "Retrieves pages when people ask Claude questions. Anthropic says its bots honour robots.txt; blocking it may reduce visibility for user-directed web search.",
  },
  {
    token: "Perplexity-User",
    vendor: "Perplexity",
    purpose: "user_fetch",
    sourceUrl: PERPLEXITY_BOTS,
    note: "Visits pages to answer a user's question in Perplexity. Perplexity says this fetcher generally ignores robots.txt rules because a user requested the fetch.",
    robotsMayNotApply: true,
  },
  // ------------------------------------------------------------------ training (your call)
  {
    token: "GPTBot",
    vendor: "OpenAI",
    purpose: "training",
    sourceUrl: OPENAI_BOTS,
    note: "Disallowing GPTBot indicates the site's content should not be used in training generative AI foundation models.",
  },
  {
    token: "ClaudeBot",
    vendor: "Anthropic",
    purpose: "training",
    sourceUrl: ANTHROPIC_BOTS,
    note: "Collects web content that could contribute to model training; restricting it signals future content should be excluded from training datasets.",
  },
  {
    token: "Google-Extended",
    vendor: "Google",
    purpose: "training",
    sourceUrl: GOOGLE_CRAWLERS,
    note: "A robots.txt control token, not a separate crawler (crawling uses existing Google user agents). Controls use for Gemini model training and grounding; Google says it does not affect inclusion or ranking in Google Search, so it does not control AI Overviews.",
  },
  {
    token: "Applebot-Extended",
    vendor: "Apple",
    purpose: "training",
    sourceUrl: APPLE_BOT,
    note: "A control token, not a crawler: it decides whether data crawled by Applebot may train Apple foundation models (Apple Intelligence). Pages that disallow it can still appear in Apple search results.",
  },
  {
    token: "CCBot",
    vendor: "Common Crawl",
    purpose: "training",
    sourceUrl: COMMON_CRAWL_BOT,
    note: "Builds Common Crawl's open repository of web crawl data. Listed with training crawlers because the repository is openly reused; Common Crawl's page does not itself describe model training.",
  },
];

export const PURPOSE_LABELS: Record<CrawlerPurpose, string> = {
  search_engine: "Search engine",
  answer_search: "AI answer / search",
  user_fetch: "User-initiated fetcher",
  training: "Training (your call)",
};

/** Purposes whose root-level block is flagged. Training is never flagged; user fetchers are informational. */
export const FLAGGED_PURPOSES: ReadonlySet<CrawlerPurpose> = new Set<CrawlerPurpose>(["search_engine", "answer_search"]);

/**
 * RFC 9309 group selection for one crawler, plus the vendor-documented fallback tokens (e.g. Applebot
 * uses the Googlebot group when there is no Applebot group). Returns null when no group applies.
 */
export function selectCrawlerGroup(parsed: ParsedRobots, def: Pick<AiCrawlerDef, "token" | "robotsFallback">): RobotsGroup | null {
  const named = (t: string) => parsed.groups.some((g) => g.agents.includes(t.toLowerCase()));
  for (const t of [def.token, ...(def.robotsFallback ?? [])]) if (named(t)) return selectGroup(parsed, t);
  return selectGroup(parsed, def.token); // falls back to "*" (or null)
}

export interface LlmsTxtCheck {
  present: boolean;
  notes: string[];
}

/** GET /llms.txt through the SSRF guard (64 KB cap). Presence + basic shape only. */
export async function checkLlmsTxt(fetchImpl: typeof fetch, verifiedHost: string, userAgent: string): Promise<LlmsTxtCheck> {
  try {
    const res = await guardedFetch(fetchImpl, `https://${verifiedHost}/llms.txt`, {
      verifiedHost,
      maxBytes: 64 * 1024,
      timeoutMs: 8000,
      kind: "llms",
      userAgent,
    });
    if (res.status < 200 || res.status >= 300) return { present: false, notes: [`/llms.txt returned ${res.status}.`] };
    const firstLine = res.body.replace(/^﻿/, "").split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
    const notes: string[] = [];
    if (/^#\s+\S/.test(firstLine)) notes.push("/llms.txt present and starts with a '# ' title line.");
    else notes.push("/llms.txt present but does not start with a '# ' title line (basic shape check).");
    notes.push("llms.txt is an informal proposal; its presence is not shown to affect AI citations.");
    return { present: true, notes };
  } catch (e) {
    return { present: false, notes: [`/llms.txt not readable (${(e as Error).message}).`] };
  }
}

function crawlerAllowed(robots: RobotsState, def: AiCrawlerDef, siteRoot: string): boolean | null {
  // Unreachable robots.txt: we cannot say what third-party crawlers will do -> null (unknown).
  if (robots.status === "unreachable") return null;
  if (robots.status === "not_found") return true;
  const u = new URL(siteRoot);
  return isPathAllowed(selectCrawlerGroup(robots.parsed, def), u.pathname + u.search);
}

export function evaluateAiCrawlerAccess(robots: RobotsState, llms: LlmsTxtCheck, siteRoot = "https://example.invalid/"): AiCrawlerAccess {
  const crawlers = AI_CRAWLERS.map((c) => ({
    token: c.token,
    vendor: c.vendor,
    purpose: c.purpose,
    allowed: crawlerAllowed(robots, c, siteRoot),
    sourceUrl: c.sourceUrl,
    note: c.note,
  }));
  const advisory: string[] = [
    `AI crawler token list version ${AI_CRAWLERS_VERSION} (checked against vendor documentation on ${AI_CRAWLERS_VERIFIED_ON}).`,
    "These settings are reported for information only; they are not shown to cause or prevent AI citations.",
    "Blocking training crawlers is a business choice, not a defect.",
  ];
  for (const c of crawlers) {
    if (FLAGGED_PURPOSES.has(c.purpose) && c.allowed === false) {
      const where = c.purpose === "search_engine" ? `${c.vendor} search results and the AI features built on that index` : `${c.vendor} answers`;
      advisory.push(`${c.token} (${c.vendor}, ${PURPOSE_LABELS[c.purpose].toLowerCase()}) is disallowed for the site root. If you want to be eligible to appear in ${where}, review this rule.`);
    }
  }
  for (const c of AI_CRAWLERS) {
    const row = crawlers.find((x) => x.token === c.token)!;
    if (c.purpose === "user_fetch" && row.allowed === false && c.robotsMayNotApply) {
      advisory.push(`${c.token} is disallowed in robots.txt, but ${c.vendor} says robots.txt may not apply to user-initiated fetches (informational).`);
    }
  }
  if (robots.status === "unreachable") advisory.push("robots.txt was unreachable, so AI crawler access could not be evaluated.");
  return { llmsTxt: { present: llms.present, notes: llms.notes }, crawlers, advisory };
}
