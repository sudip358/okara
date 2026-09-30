/**
 * [A1] Source-type classification for cited pages. Deterministic URL/domain/title rules first; the
 * remainder is sent to Jev `geo.source_type` (see questions.ts) by analyze.ts, and falls back to
 * `other` with method `unknown` when Jev is unavailable or not decisive. The method is always stored.
 *
 * Rule order (first match wins):
 *   1. brand_page       host matches a tracked brand's domain (self or competitor)
 *   2. forum_ugc        reddit, quora, stackexchange/stackoverflow, HN, forum./community. hosts, /forum(s) or /community paths
 *   3. review_site      trustpilot, g2, capterra, yelp, getapp, softwareadvice, tripadvisor, sitejabber, consumeraffairs
 *   4. marketplace      amazon.*, ebay.*, etsy.com, wayfair.com, walmart.com, target.com, aliexpress, alibaba, overstock
 *   5. listicle_roundup title or path contains "best", "top N", "vs", "alternatives", "review(s)", "compared", "roundup"
 *   6. publisher        known news/media domains, news.* hosts, /news/ paths
 */
import type { SourceType } from "@shared/types";
import { hostMatchesDomain } from "./detect";

export const SOURCE_TYPE_RULES_VERSION = "source-type-rules-2026-09-30.1";

export type SourceTypeMethod = "rule" | "jev" | "unknown";

export interface SourceTypeResult {
  sourceType: SourceType;
  method: SourceTypeMethod;
  /** Which rule matched (for audit), when method is 'rule'. */
  rule: string | null;
}

const FORUM_DOMAINS = ["reddit.com", "quora.com", "stackexchange.com", "stackoverflow.com", "news.ycombinator.com", "superuser.com", "serverfault.com", "askubuntu.com"];
const REVIEW_DOMAINS = ["trustpilot.com", "g2.com", "capterra.com", "yelp.com", "getapp.com", "softwareadvice.com", "sitejabber.com", "consumeraffairs.com", "tripadvisor.com", "trustradius.com"];
const MARKETPLACE_DOMAINS = ["etsy.com", "wayfair.com", "walmart.com", "target.com", "aliexpress.com", "alibaba.com", "overstock.com", "homedepot.com", "lowes.com", "bestbuy.com", "rakuten.co.jp", "mercadolibre.com"];
const PUBLISHER_DOMAINS = [
  "nytimes.com", "theguardian.com", "bbc.co.uk", "bbc.com", "forbes.com", "wired.com", "theverge.com", "techcrunch.com",
  "cnn.com", "reuters.com", "apnews.com", "washingtonpost.com", "wsj.com", "bloomberg.com", "businessinsider.com",
  "cnet.com", "zdnet.com", "engadget.com", "arstechnica.com", "usatoday.com", "time.com", "nbcnews.com", "cbsnews.com",
  "abcnews.go.com", "npr.org", "latimes.com", "ft.com", "economist.com", "theatlantic.com", "vox.com", "axios.com",
  "architecturaldigest.com", "housebeautiful.com", "elledecor.com", "apartmenttherapy.com", "bhg.com", "thespruce.com",
  "goodhousekeeping.com", "vogue.com", "gq.com", "nymag.com", "spiegel.de", "zeit.de", "faz.net", "lemonde.fr", "asahi.com",
  "nikkei.com", "yomiuri.co.jp",
];

/** Labels like amazon.com, amazon.co.uk, amazon.de, smile.amazon.com, ebay.co.uk. */
function hasBrandLabelDomain(host: string, label: string): boolean {
  const parts = host.split(".");
  const idx = parts.indexOf(label);
  if (idx < 0) return false;
  const suffix = parts.slice(idx + 1);
  return suffix.length >= 1 && suffix.length <= 2 && suffix.every((s) => /^[a-z]{2,3}$/.test(s));
}

const LISTICLE_TEXT = /(?:\bbest\b|\btop[\s-]*\d{1,3}\b|\btop[\s-]+(?:picks|rated|brands|choices)\b|\bvs\.?\b|\bversus\b|\balternatives?\b|\breviews?\b|\bcompared\b|\bcomparison\b|\broundup\b|\bround-up\b|\bbuying guide\b)/i;

function pathText(url: string): string {
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname).replace(/[-_/+.]+/g, " ");
  } catch {
    return "";
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Deterministic classification. `trackedDomains` = every verified self domain and competitor domain.
 * Returns null when no rule matches (caller asks Jev or falls back to other/unknown).
 */
export function classifySourceByRules(
  input: { url: string; host: string | null; title: string | null },
  trackedDomains: string[],
): SourceTypeResult | null {
  const host = input.host;
  const path = pathOf(input.url);
  if (host) {
    if (trackedDomains.some((d) => hostMatchesDomain(host, d))) return { sourceType: "brand_page", method: "rule", rule: "tracked_domain" };
    if (FORUM_DOMAINS.some((d) => hostMatchesDomain(host, d)) || /(^|\.)(forums?|community|discuss)\./.test(host) || hostMatchesDomain(host, "stackexchange.com")) {
      return { sourceType: "forum_ugc", method: "rule", rule: "forum_domain" };
    }
    if (/\/(forums?|community|discussions?|threads?)\//.test(path)) return { sourceType: "forum_ugc", method: "rule", rule: "forum_path" };
    if (REVIEW_DOMAINS.some((d) => hostMatchesDomain(host, d))) return { sourceType: "review_site", method: "rule", rule: "review_domain" };
    if (hasBrandLabelDomain(host, "amazon") || hasBrandLabelDomain(host, "ebay") || MARKETPLACE_DOMAINS.some((d) => hostMatchesDomain(host, d))) {
      return { sourceType: "marketplace", method: "rule", rule: "marketplace_domain" };
    }
  }
  const text = `${input.title ?? ""} ${pathText(input.url)}`;
  if (LISTICLE_TEXT.test(text)) return { sourceType: "listicle_roundup", method: "rule", rule: "listicle_title_or_path" };
  if (host) {
    if (PUBLISHER_DOMAINS.some((d) => hostMatchesDomain(host, d)) || /^news\./.test(host)) {
      return { sourceType: "publisher", method: "rule", rule: "publisher_domain" };
    }
    if (/\/news\//.test(path)) return { sourceType: "publisher", method: "rule", rule: "publisher_path" };
  }
  return null;
}

export const UNKNOWN_SOURCE: SourceTypeResult = { sourceType: "other", method: "unknown", rule: null };

export const SOURCE_TYPES: readonly SourceType[] = ["brand_page", "listicle_roundup", "review_site", "forum_ugc", "publisher", "marketplace", "other"];

export function isSourceType(v: unknown): v is SourceType {
  return typeof v === "string" && (SOURCE_TYPES as readonly string[]).includes(v);
}
