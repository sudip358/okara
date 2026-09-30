/**
 * [A19] AI crawler access check (advisory only).
 *
 * The token list is versioned; every entry was checked against the vendor's own documentation on
 * AI_CRAWLERS_VERIFIED_ON. Tokens that could not be verified from vendor docs are omitted. User-
 * initiated fetchers for which the vendor states robots.txt may not apply (OpenAI ChatGPT-User) are
 * omitted because a robots evaluation would be misleading.
 *
 * Never claim that robots.txt or llms.txt settings cause or prevent citations. Blocking training
 * crawlers is a business choice, not a defect; only answer/search crawlers produce an advisory finding.
 */
import type { AiCrawlerAccess } from "@shared/types";
import { guardedFetch } from "../ssrf";
import { robotsAllows, type RobotsState } from "../crawl/robots";

export const AI_CRAWLERS_VERSION = "2026-09-30.1";
export const AI_CRAWLERS_VERIFIED_ON = "2026-09-30";

export interface AiCrawlerDef {
  token: string;
  vendor: string;
  purpose: "answer_search" | "training";
  sourceUrl: string;
  note: string;
}

export const AI_CRAWLERS: readonly AiCrawlerDef[] = [
  {
    token: "OAI-SearchBot",
    vendor: "OpenAI",
    purpose: "answer_search",
    sourceUrl: "https://developers.openai.com/api/docs/bots",
    note: "Used to surface websites in ChatGPT search features.",
  },
  {
    token: "GPTBot",
    vendor: "OpenAI",
    purpose: "training",
    sourceUrl: "https://developers.openai.com/api/docs/bots",
    note: "Used for generative AI foundation model training.",
  },
  {
    token: "Claude-SearchBot",
    vendor: "Anthropic",
    purpose: "answer_search",
    sourceUrl: "https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler",
    note: "Indexes content to improve search result quality for Claude users.",
  },
  {
    token: "Claude-User",
    vendor: "Anthropic",
    purpose: "answer_search",
    sourceUrl: "https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler",
    note: "User-initiated retrieval when people ask Claude questions.",
  },
  {
    token: "ClaudeBot",
    vendor: "Anthropic",
    purpose: "training",
    sourceUrl: "https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler",
    note: "Collects web content that may contribute to model training.",
  },
  {
    token: "PerplexityBot",
    vendor: "Perplexity",
    purpose: "answer_search",
    sourceUrl: "https://docs.perplexity.ai/guides/bots",
    note: "Surfaces and links websites in Perplexity search results; vendor states it is not used for foundation-model training.",
  },
  {
    token: "Google-Extended",
    vendor: "Google",
    purpose: "training",
    sourceUrl: "https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers",
    note: "Controls use of content for Gemini model training and grounding in Gemini apps; vendor states it does not affect Google Search inclusion or ranking.",
  },
];

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

export function evaluateAiCrawlerAccess(robots: RobotsState, llms: LlmsTxtCheck, siteRoot = "https://example.invalid/"): AiCrawlerAccess {
  const crawlers = AI_CRAWLERS.map((c) => ({
    token: c.token,
    vendor: c.vendor,
    purpose: c.purpose,
    // Unreachable robots.txt: we cannot say what third-party crawlers will do -> null (unknown).
    allowed: robots.status === "unreachable" ? null : robotsAllows(robots, c.token, siteRoot),
    sourceUrl: c.sourceUrl,
  }));
  const advisory: string[] = [
    `AI crawler token list version ${AI_CRAWLERS_VERSION} (checked against vendor documentation on ${AI_CRAWLERS_VERIFIED_ON}).`,
    "These settings are reported for information only; they are not shown to cause or prevent AI citations.",
    "Blocking training crawlers is a business choice, not a defect.",
  ];
  for (const c of crawlers) {
    if (c.purpose === "answer_search" && c.allowed === false) {
      advisory.push(`${c.token} (${c.vendor}, answer/search) is disallowed for the site root. If you want to be eligible to appear in ${c.vendor} answers, review this rule.`);
    }
  }
  if (robots.status === "unreachable") advisory.push("robots.txt was unreachable, so AI crawler access could not be evaluated.");
  return { llmsTxt: { present: llms.present, notes: llms.notes }, crawlers, advisory };
}
