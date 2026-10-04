/**
 * Deterministic brand, citation, and list detection over a GEO answer. Pure functions, no I/O.
 *
 * Rules (docs/build-kit.md, GEO AGENT):
 * - Brand/competitor detection runs on the RESPONSE BODY only. The prompt, page titles, and citations
 *   are separate fields; a brand named only in the prompt is not a response mention.
 * - Alias matching is case-insensitive, NFKC-normalized, whitespace-collapsed, and Unicode-aware at
 *   word boundaries. Scripts written without spaces between words (Han, Kana, Hangul, Thai, ...) do
 *   not require a boundary on the side of the alias that is written in such a script. Spans always
 *   refer to offsets in the ORIGINAL text (UTF-16 code units), so `text.slice(start, end)` is exact.
 * - When a self alias and a competitor alias match the same text, both spans are flagged ambiguous
 *   (resolved later by Jev `geo.mention_adjudication`, or left unresolved). When one match strictly
 *   contains another brand's match, the longer (more specific) match wins.
 * - Citations are attributed by parsed hostname only (URL API, lowercase, `www.` stripped): a host
 *   matches a verified domain when `host === d || host.endsWith("." + d)`. Never substring on text.
 * - Gemini grounding returns redirect-wrapper URIs (vertexaisearch.cloud.google.com/grounding-api-redirect/...).
 *   Their real destination is not in the URL. We use the citation title when it is a bare domain
 *   (Gemini sets it to the source domain, e.g. "example.com"); otherwise the host is unknown and the
 *   citation cannot be attributed to any brand (it never counts as a brand citation).
 * - list_rank is recorded only for a real ORDERED (numbered) list. Bulleted lists and prose are
 *   presentation order, not a ranking, so they yield null (build-kit: "Record actual list rank only
 *   for a real ordered recommendation list; otherwise use null").
 */

export interface Span {
  start: number;
  end: number;
  text: string;
}

export interface BrandDef {
  /** 'self' or the competitor name. */
  key: string;
  isSelf: boolean;
  name: string;
  aliases: string[];
  /** Verified/declared domains, normalized (lowercase, punycode, no www.). */
  domains: string[];
}

export interface BrandSpan extends Span {
  brandKey: string;
  alias: string;
  ambiguous: boolean;
  /** Other brand keys whose aliases matched the same or crossing text. */
  collidesWith: string[];
}

// ------------------------------------------------------------------ normalization with offset map
interface NormText {
  norm: string;
  /** For each UTF-16 unit of `norm`, the start/end offsets of the source cluster in the original. */
  starts: number[];
  ends: number[];
}

const CLUSTER = /\P{M}\p{M}*|\p{M}+/gsu;
const APOSTROPHES = /[‘’ʼ′＇]/g;
const DASHES = /[‐-―−﹘﹣－]/g;
const ZERO_WIDTH = /[​-‍⁠﻿­]/;

function normCluster(cluster: string): string {
  return cluster.normalize("NFKC").toLowerCase().replace(APOSTROPHES, "'").replace(DASHES, "-");
}

/** NFKC + lowercase + unified apostrophes/dashes + collapsed whitespace, with an offset map back to `text`. */
export function normalizeWithMap(text: string): NormText {
  const starts: number[] = [];
  const ends: number[] = [];
  let norm = "";
  for (const m of text.matchAll(CLUSTER)) {
    const s = m.index;
    const e = s + m[0].length;
    const cluster = m[0];
    if (ZERO_WIDTH.test(cluster) && cluster.length === 1) continue;
    if (/^\s+$/u.test(cluster)) {
      if (norm.length > 0 && norm[norm.length - 1] === " ") {
        ends[ends.length - 1] = e;
        continue;
      }
      norm += " ";
      starts.push(s);
      ends.push(e);
      continue;
    }
    const n = normCluster(cluster);
    for (let i = 0; i < n.length; i++) {
      starts.push(s);
      ends.push(e);
    }
    norm += n;
  }
  return { norm, starts, ends };
}

/** Normalize an alias the same way as text (without the offset map). */
export function normalizeAlias(alias: string): string {
  return normalizeWithMap(alias.trim()).norm.trim();
}

// ------------------------------------------------------------------ word boundaries
const WORD_CHAR = /[\p{L}\p{N}\p{M}_]/u;
const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/** A word character of a script that separates words with spaces (Latin, Cyrillic, Greek, Arabic, ...). */
function isSpacedWordChar(ch: string | undefined): boolean {
  if (!ch) return false;
  return WORD_CHAR.test(ch) && !UNSPACED_SCRIPT.test(ch);
}

function codePointBefore(s: string, i: number): string | undefined {
  if (i <= 0) return undefined;
  const lo = s.charCodeAt(i - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && i >= 2) return s.slice(i - 2, i);
  return s[i - 1];
}

function codePointAt(s: string, i: number): string | undefined {
  if (i >= s.length) return undefined;
  const cp = s.codePointAt(i);
  return cp === undefined ? undefined : String.fromCodePoint(cp);
}

function boundaryOk(norm: string, start: number, end: number, alias: string): boolean {
  const first = codePointAt(alias, 0);
  const last = codePointBefore(alias, alias.length);
  if (isSpacedWordChar(first) && isSpacedWordChar(codePointBefore(norm, start))) return false;
  if (isSpacedWordChar(last) && isSpacedWordChar(codePointAt(norm, end))) {
    // Possessive/genitive "s" without apostrophe (German "Residence Examples Griffe"): allowed for
    // Latin aliases of 3+ characters when the word ends right after the "s". The span excludes the "s".
    const genitive = /[a-z]/.test(last ?? "") && [...alias].length >= 3 && norm[end] === "s" && !isSpacedWordChar(codePointAt(norm, end + 1));
    if (!genitive) return false;
  }
  return true;
}

/** All occurrences of `alias` (already normalized) in normalized text, as normalized ranges. */
function findAlias(nt: NormText, alias: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (alias.length === 0) return out;
  let from = 0;
  for (;;) {
    const i = nt.norm.indexOf(alias, from);
    if (i < 0) break;
    const j = i + alias.length;
    if (boundaryOk(nt.norm, i, j, alias)) out.push([i, j]);
    from = i + 1;
  }
  return out;
}

function toOriginal(nt: NormText, text: string, i: number, j: number): Span {
  const start = nt.starts[i]!;
  const end = nt.ends[j - 1]!;
  return { start, end, text: text.slice(start, end) };
}

/** Aliases for a brand: name + aliases, normalized, deduped, empties and 1-char aliases dropped. */
export function brandAliases(b: Pick<BrandDef, "name" | "aliases">): string[] {
  const set = new Set<string>();
  for (const a of [b.name, ...b.aliases]) {
    const n = normalizeAlias(a ?? "");
    if ([...n].length >= 2) set.add(n);
  }
  return [...set];
}

/** Alias strings shared between self and a competitor (a configuration collision). */
export function aliasCollisions(brands: BrandDef[]): Array<{ alias: string; brandKeys: string[] }> {
  const owners = new Map<string, Set<string>>();
  for (const b of brands) for (const a of brandAliases(b)) {
    if (!owners.has(a)) owners.set(a, new Set());
    owners.get(a)!.add(b.key);
  }
  return [...owners.entries()].filter(([, s]) => s.size > 1).map(([alias, s]) => ({ alias, brandKeys: [...s] }));
}

/**
 * Detect every brand's alias spans in `text` (the response body only).
 * Returns spans per brand key (empty array when not found), sorted by start.
 */
export function detectBrands(text: string, brands: BrandDef[]): Map<string, BrandSpan[]> {
  const nt = normalizeWithMap(text ?? "");
  type Cand = { brandKey: string; alias: string; i: number; j: number; ambiguous: boolean; collidesWith: Set<string>; dropped: boolean };
  const cands: Cand[] = [];
  for (const b of brands) {
    const own: Cand[] = [];
    for (const alias of brandAliases(b)) {
      for (const [i, j] of findAlias(nt, alias)) own.push({ brandKey: b.key, alias, i, j, ambiguous: false, collidesWith: new Set(), dropped: false });
    }
    // Within one brand: keep the longest of overlapping matches ("Residence Example" over "Residence").
    own.sort((a, b2) => a.i - b2.i || b2.j - b2.i - (a.j - a.i));
    let lastEnd = -1;
    for (const c of own) {
      if (c.i < lastEnd) continue;
      cands.push(c);
      lastEnd = c.j;
    }
  }
  // Across brands: identical or crossing ranges are ambiguous; strict containment -> longer wins.
  for (let x = 0; x < cands.length; x++) {
    for (let y = x + 1; y < cands.length; y++) {
      const a = cands[x]!;
      const b = cands[y]!;
      if (a.brandKey === b.brandKey) continue;
      if (a.j <= b.i || b.j <= a.i) continue; // no overlap
      if (a.i === b.i && a.j === b.j) {
        a.ambiguous = b.ambiguous = true;
        a.collidesWith.add(b.brandKey);
        b.collidesWith.add(a.brandKey);
      } else if (a.i <= b.i && a.j >= b.j) {
        b.dropped = true;
      } else if (b.i <= a.i && b.j >= a.j) {
        a.dropped = true;
      } else {
        a.ambiguous = b.ambiguous = true;
        a.collidesWith.add(b.brandKey);
        b.collidesWith.add(a.brandKey);
      }
    }
  }
  const out = new Map<string, BrandSpan[]>();
  for (const b of brands) out.set(b.key, []);
  for (const c of cands) {
    if (c.dropped) continue;
    out.get(c.brandKey)!.push({
      ...toOriginal(nt, text, c.i, c.j),
      brandKey: c.brandKey,
      alias: c.alias,
      ambiguous: c.ambiguous,
      collidesWith: [...c.collidesWith],
    });
  }
  for (const spans of out.values()) spans.sort((a, b) => a.start - b.start);
  return out;
}

/** True when `needle` (a name/alias/domain) occurs in `text` under the same matching rules. */
export function containsTerm(text: string, term: string): Span | null {
  return termMatcher(text)(term);
}

/**
 * containsTerm for many terms over one text: the text is normalized once (with up to 60 tracked competitors a
 * brand-blind check tests hundreds of names, aliases and domains against the same prompt).
 */
export function termMatcher(text: string): (term: string) => Span | null {
  const nt = normalizeWithMap(text);
  return (term: string) => {
    const alias = normalizeAlias(term);
    if ([...alias].length < 2) return null;
    const hit = findAlias(nt, alias)[0];
    return hit ? toOriginal(nt, text, hit[0], hit[1]) : null;
  };
}

// ------------------------------------------------------------------ domains and citations
/**
 * Normalize a domain or URL-ish string to a comparable host: lowercase, punycode (via URL API),
 * trailing dot and leading `www.` removed. Returns null for anything that is not a hostname.
 */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = input.trim();
  if (!s) return null;
  if (s.startsWith("sc-domain:")) s = s.slice("sc-domain:".length);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let host: string;
  try {
    host = new URL(s).hostname.toLowerCase();
  } catch {
    return null;
  }
  host = host.replace(/\.$/, "");
  if (host.startsWith("www.")) host = host.slice(4);
  if (!host || !host.includes(".")) return null;
  return host;
}

export function hostMatchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

export const GEMINI_REDIRECT_HOST = "vertexaisearch.cloud.google.com";
const DOMAIN_TITLE = /^(?:www\.)?(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+[\p{L}]{2,63}\.?$/u;

export interface ResolvedCitationHost {
  /** Normalized host, or null when it cannot be determined. */
  host: string | null;
  via: "url" | "title" | "unresolved";
}

/**
 * Parse the citation's host. For Gemini grounding redirect URIs the destination is unknown; we use the
 * title only when it is a bare domain (e.g. "example.com"). Otherwise the host is unresolved.
 */
export function resolveCitationHost(url: string, title: string | null | undefined): ResolvedCitationHost {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { host: null, via: "unresolved" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return { host: null, via: "unresolved" };
  const host = normalizeDomain(parsed.hostname);
  if (host === GEMINI_REDIRECT_HOST && parsed.pathname.startsWith("/grounding-api-redirect/")) {
    const t = (title ?? "").trim();
    if (t && DOMAIN_TITLE.test(t)) {
      const th = normalizeDomain(t);
      if (th) return { host: th, via: "title" };
    }
    return { host: null, via: "unresolved" };
  }
  return host ? { host, via: "url" } : { host: null, via: "unresolved" };
}

/**
 * Which tracked brand owns this host? The longest matching domain wins; a tie between different
 * brands (misconfiguration) attributes to nobody.
 */
export function brandForHost(host: string | null, brands: BrandDef[]): string | null {
  if (!host) return null;
  let best: { key: string; len: number } | null = null;
  let tie = false;
  for (const b of brands) {
    for (const d of b.domains) {
      if (!hostMatchesDomain(host, d)) continue;
      if (!best || d.length > best.len) {
        best = { key: b.key, len: d.length };
        tie = false;
      } else if (d.length === best.len && best.key !== b.key) {
        tie = true;
      }
    }
  }
  return best && !tie ? best.key : null;
}

// Multi-label public suffixes we recognise without a full PSL. Anything else: last two labels.
const MULTI_SUFFIX = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "edu.au", "co.nz", "org.nz", "co.jp", "ne.jp", "or.jp",
  "com.br", "com.mx", "co.in", "co.za", "com.sg", "com.tr", "com.cn", "com.hk", "co.kr", "com.tw", "com.ar", "co.il",
]);
/** Shared-hosting parents: a registrable domain here would match every tenant, so it is never used. */
const SHARED_HOSTING = new Set([
  "myshopify.com", "github.io", "netlify.app", "vercel.app", "pages.dev", "workers.dev", "herokuapp.com",
  "wordpress.com", "blogspot.com", "wixsite.com", "squarespace.com", "webflow.io", "azurewebsites.net",
  "cloudfront.net", "appspot.com", "firebaseapp.com", "web.app", "fly.dev", "onrender.com", "bigcartel.com",
]);

/** Approximate registrable domain (eTLD+1) using a small suffix list; null for shared hosting parents. */
export function registrableDomain(host: string): string | null {
  const labels = host.split(".");
  if (labels.length <= 2) return SHARED_HOSTING.has(host) ? null : host;
  const last2 = labels.slice(-2).join(".");
  const reg = MULTI_SUFFIX.has(last2) ? labels.slice(-3).join(".") : last2;
  return SHARED_HOSTING.has(reg) ? null : reg;
}

/**
 * The project's own domains: site_url host, verified host, sc-domain property, and the verified
 * host's registrable domain (so shop.example.com also covers blog.example.com), except on shared hosts.
 */
export function selfDomains(p: { site_url: string; verified_host: string | null; gsc_property: string | null }): string[] {
  const set = new Set<string>();
  const site = normalizeDomain(p.site_url);
  if (site) set.add(site);
  const verified = normalizeDomain(p.verified_host);
  if (verified) {
    set.add(verified);
    const reg = registrableDomain(verified);
    if (reg) set.add(reg);
  }
  if (p.gsc_property?.startsWith("sc-domain:")) {
    const d = normalizeDomain(p.gsc_property);
    if (d && !SHARED_HOSTING.has(d)) set.add(d);
  }
  return [...set];
}

// ------------------------------------------------------------------ sentences and passages
export interface Sentence {
  start: number;
  end: number;
}

/** Split into sentences: after .!? followed by whitespace, after CJK full stops, and at newlines. */
export function sentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  let start = 0;
  const push = (end: number) => {
    let s = start;
    let e = end;
    while (s < e && /\s/.test(text[s]!)) s++;
    while (e > s && /\s/.test(text[e - 1]!)) e--;
    if (e > s) out.push({ start: s, end: e });
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\n") {
      push(i);
      start = i + 1;
    } else if ("。！？".includes(ch)) {
      push(i + 1);
      start = i + 1;
    } else if (".!?".includes(ch) && (i + 1 >= text.length || /\s/.test(text[i + 1]!))) {
      push(i + 1);
      start = i + 1;
    }
  }
  push(text.length);
  return out;
}

export function sentenceIndexAt(sents: Sentence[], offset: number): number {
  for (let i = 0; i < sents.length; i++) if (offset < sents[i]!.end) return i;
  return Math.max(0, sents.length - 1);
}

/** The sentence containing `offset`, capped. */
export function containingSentence(text: string, offset: number, max = 300): string {
  const sents = sentences(text);
  if (sents.length === 0) return "";
  const s = sents[sentenceIndexAt(sents, offset)]!;
  return text.slice(s.start, s.end).slice(0, max);
}

/** The passage around `offset`: its sentence plus one sentence on each side, capped. */
export function passageAround(text: string, offset: number, max = 1200): Span {
  const sents = sentences(text);
  if (sents.length === 0) return { start: 0, end: 0, text: "" };
  const k = sentenceIndexAt(sents, offset);
  const a = sents[Math.max(0, k - 1)]!;
  const b = sents[Math.min(sents.length - 1, k + 1)]!;
  const t = text.slice(a.start, b.end);
  return { start: a.start, end: a.start + Math.min(t.length, max), text: t.slice(0, max) };
}

/** Context window of ±radius characters around a span, for mention adjudication. */
export function contextWindow(text: string, span: { start: number; end: number }, radius = 200): string {
  return text.slice(Math.max(0, span.start - radius), Math.min(text.length, span.end + radius));
}

/** Citation markers like [1], [1][2], [1, 3], 【2】 in a piece of text (1-based numbers). */
export function citationMarkers(text: string): number[] {
  const out = new Set<number>();
  for (const m of text.matchAll(/[[【]\s*(\d{1,3}(?:\s*[,，]\s*\d{1,3})*)\s*[\]】]/g)) {
    for (const n of m[1]!.split(/[,，]/)) out.add(Number(n.trim()));
  }
  return [...out].filter((n) => Number.isInteger(n) && n > 0);
}

// ------------------------------------------------------------------ lists
export interface ListItem {
  /** Offsets of the whole item (head line + body until the next item / end of list). */
  start: number;
  end: number;
  /** Offset where the item's first line ends. */
  headEnd: number;
  /** 1-based position within its list. */
  ordinal: number;
  listIndex: number;
}

const ORDERED_ITEM = /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*|__)?[ \t]*([0-9０-９]{1,3})[.)．）][ \t]*(?:\*\*|__)?[ \t]*\S/u;

function toInt(digits: string): number {
  return Number(digits.normalize("NFKC"));
}

/**
 * Parse numbered (ordered) list items. Consecutive numbers (n, n+1, ...) continue one list even when
 * non-indented description paragraphs sit between items; a number that does not continue the
 * sequence starts a new list. The last item of a list ends at the first blank line after its body.
 */
export function parseOrderedLists(text: string): ListItem[] {
  const lines: Array<{ start: number; end: number; text: string }> = [];
  let pos = 0;
  for (const line of text.split("\n")) {
    lines.push({ start: pos, end: pos + line.length, text: line });
    pos += line.length + 1;
  }
  const items: Array<ListItem & { number: number; lineIdx: number }> = [];
  let listIndex = -1;
  let prevNumber: number | null = null;
  let ordinal = 0;
  lines.forEach((ln, idx) => {
    const m = ORDERED_ITEM.exec(ln.text);
    if (!m) return;
    const n = toInt(m[1]!);
    if (prevNumber === null || n !== prevNumber + 1) {
      listIndex++;
      ordinal = 0;
    }
    ordinal++;
    prevNumber = n;
    items.push({ start: ln.start, end: ln.end, headEnd: ln.end, ordinal, listIndex, number: n, lineIdx: idx });
  });
  for (let k = 0; k < items.length; k++) {
    const it = items[k]!;
    const next = items[k + 1];
    if (next && next.listIndex === it.listIndex) {
      it.end = next.start;
      continue;
    }
    // Last item of its list: extend over following lines until a blank line (then stop), unless the
    // lines after the blank are indented continuation lines.
    let end = it.headEnd;
    for (let i = it.lineIdx + 1; i < lines.length; i++) {
      const ln = lines[i]!;
      if (next && ln.start >= next.start) break;
      if (ln.text.trim() === "") {
        const after = lines[i + 1];
        if (after && /^[ \t]{2,}\S/.test(after.text)) continue;
        break;
      }
      end = ln.end;
    }
    it.end = end;
  }
  return items.map(({ number: _n, lineIdx: _l, ...rest }) => rest);
}

/**
 * Rank of the ordered-list item that mentions the brand: prefer an item whose head line contains a
 * span; otherwise the first item whose body contains one. null when not in an ordered list.
 */
export function listRankFor(items: ListItem[], spans: Array<{ start: number; end: number }>): number | null {
  if (spans.length === 0 || items.length === 0) return null;
  for (const it of items) if (spans.some((s) => s.start >= it.start && s.end <= it.headEnd)) return it.ordinal;
  for (const it of items) if (spans.some((s) => s.start >= it.start && s.end <= it.end)) return it.ordinal;
  return null;
}

// ------------------------------------------------------------------ recommendation cues (English heuristics)
const NEGATIVE_CUES =
  /\b(?:avoid|(?:do not|don't|would not|wouldn't|cannot|can't|not) (?:recommend(?:ed)?|suggest(?:ed)?)|not recommended|poor(?:ly)?|complaints?|overpriced|downsides?|drawbacks?|worse|unreliable|negative reviews?|issues with|problems with|lawsuits?|scam|disappointing|mixed reviews?)\b/giu;
const POSITIVE_CUES =
  /\b(?:recommend(?:ed|s)?|top (?:pick|choice)|best (?:overall|option|choice|for)|great (?:option|choice|pick)|excellent|stands? out|standout|worth (?:considering|a look|checking)|go-to|highly rated|popular choice|favou?rite|solid (?:choice|option)|ideal (?:for|choice)|well[- ]regarded|reputable|trusted)\b/giu;

export type CueResult = "recommended" | "mentioned_negatively" | "listed_neutral" | "unclear";

/**
 * Deterministic treatment from the sentences that contain the brand. English cue lists only; any
 * other language (or conflicting cues) is "unclear" and left for Jev or reported as unknown.
 */
export function recommendationCues(sentencesText: string[], inOrderedOrBulletList: boolean): CueResult {
  const joined = sentencesText.join(" ");
  const negative = NEGATIVE_CUES.test(joined);
  NEGATIVE_CUES.lastIndex = 0;
  const stripped = joined.replace(NEGATIVE_CUES, " ");
  NEGATIVE_CUES.lastIndex = 0;
  const positive = POSITIVE_CUES.test(stripped);
  POSITIVE_CUES.lastIndex = 0;
  if (positive && !negative) return "recommended";
  if (negative && !positive) return "mentioned_negatively";
  if (positive && negative) return "unclear";
  return inOrderedOrBulletList ? "listed_neutral" : "unclear";
}

const BULLET_ITEM = /^[ \t]*[-*+•・][ \t]+\S/u;

/** True when the offset sits on a numbered or bulleted list line. */
export function onListLine(text: string, offset: number): boolean {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const lineEnd = text.indexOf("\n", offset);
  const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
  return ORDERED_ITEM.test(line) || BULLET_ITEM.test(line);
}

/** Deterministic sanitization of untrusted text before it is sent to Jev: control/zero-width chars removed, capped. */
export function sanitizeUntrusted(text: string, max = 6000): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[​-‏‪-‮⁠-⁤﻿]/g, "")
    .slice(0, max);
}

// ------------------------------------------------------------------ project brands
export interface ProjectBrandSource {
  brand_name: string;
  brand_aliases_json: string;
  competitors_json: string;
  site_url: string;
  verified_host: string | null;
  gsc_property: string | null;
}

function parseArray(s: string): unknown[] {
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Self first, then competitors in configured order. Competitor brand_key = competitor name. */
export function projectBrands(p: ProjectBrandSource): BrandDef[] {
  const aliases = parseArray(p.brand_aliases_json).filter((a): a is string => typeof a === "string");
  const out: BrandDef[] = [{ key: "self", isSelf: true, name: p.brand_name, aliases, domains: selfDomains(p) }];
  const seen = new Set<string>(["self"]);
  for (const c of parseArray(p.competitors_json)) {
    if (!c || typeof c !== "object") continue;
    const r = c as { name?: unknown; domains?: unknown; aliases?: unknown };
    if (typeof r.name !== "string" || !r.name.trim() || seen.has(r.name.trim())) continue;
    const name = r.name.trim();
    seen.add(name);
    const domains = (Array.isArray(r.domains) ? r.domains : []).map((d) => (typeof d === "string" ? normalizeDomain(d) : null)).filter((d): d is string => !!d);
    const al = (Array.isArray(r.aliases) ? r.aliases : []).filter((a): a is string => typeof a === "string");
    out.push({ key: name, isSelf: false, name, aliases: al, domains });
  }
  return out;
}
