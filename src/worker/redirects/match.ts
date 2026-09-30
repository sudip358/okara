/**
 * Redirect map [A23]: deterministic URL normalization, matching, and shortlisting. Pure functions,
 * no I/O. Jev (src/worker/redirects/jev.ts) only sees what this module shortlists.
 *
 * Normalization (both sides):
 *   - Inputs may be absolute http(s) URLs or site paths ("/old/page"); host-like inputs without a
 *     scheme ("shop.example.com/x") get https. Other schemes, URL credentials, and non-default
 *     ports are rejected.
 *   - Host: lowercased, trailing dot removed. New URLs must be on the project host exactly. Old URLs
 *     must be on the project host or its www/non-www twin (pre-migration URLs often used www); the
 *     CSV holds paths only, so the host never reaches the export.
 *   - Path: duplicate slashes collapsed, trailing slash removed (except "/"). Query and fragment are
 *     ignored for matching (the new side keeps its query in the target).
 *   - Matching key (`matchPath`): each segment percent-decoded safely (malformed escapes are kept
 *     as-is), NFC-normalized, lowercased; Shopify nested product paths
 *     /collections/<c>/products/<p>[/...] canonicalize to /products/<p>[/...].
 *
 * Deterministic matches (auto, confidence null):
 *   1. exact_path: old matchPath equals a new matchPath.
 *   2. normalized_slug: the old slug key equals exactly one new URL's slug key, where the slug key is
 *      the last segment's tokens (extension, UUIDs, stop words, pure numbers, and id-like tokens
 *      removed; simple plurals singularized) joined in order. A one-token key must also be the
 *      same raw slug on both sides ("lamps" = "lamps"), so "/p/12345-lamp" never auto-matches
 *      "/collections/lamp" just because the id was removed.
 *
 * Shortlist (everything else): top SHORTLIST_SIZE new URLs by
 *   score = (0.55·slugSim + 0.30·titleSim + 0.15·pathSim) / (sum of the weights used)
 *   slugSim  = Dice(old slug tokens, new slug tokens)          = 2|A∩B| / (|A|+|B|)
 *   titleSim = |old slug tokens ∩ new title+H1 tokens| / |old slug tokens|
 *              (only when the new page has a crawled title or H1; otherwise the term and its weight
 *              are left out, so pages without crawl data are not penalized)
 *   pathSim  = Dice(all old path tokens, all new path tokens)  (parent segments + slug; structural
 *              words such as "products" or "collections" excluded)
 * Scores are rounded to 3 decimals; candidates need score > 0; ties break by URL (ascending).
 */

export const MATCH_VERSION = "redirect-match-2026-09-30.1";
export const SHORTLIST_SIZE = 5;
export const SCORE_WEIGHTS = { slug: 0.55, title: 0.3, path: 0.15 } as const;

/** Small, documented stop-word list (English function words and web-file cruft). */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "the", "of", "for", "to", "in", "on", "at", "by", "with", "from", "or", "is", "are",
  "your", "our", "my", "its", "it", "this", "that", "as", "be",
  "html", "htm", "php", "asp", "aspx", "jsp", "index", "default", "www",
]);

/** Path segments that describe site structure rather than the page (excluded from path tokens). */
export const STRUCTURAL_WORDS: ReadonlySet<string> = new Set([
  "product", "products", "collection", "collections", "page", "pages", "blog", "blogs", "category",
  "categories", "shop", "store", "catalog", "item", "items", "p", "c", "en", "article", "articles", "post", "posts",
]);

const FILE_EXTENSION = /\.(?:html?|shtml|php\d?|aspx?|jsp|cfm)$/i;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export type UrlSide = "old" | "new";

export interface ParsedSiteUrl {
  input: string;
  host: string;
  protocol: "http:" | "https:";
  /** Encoded pathname, duplicate slashes collapsed, trailing slash removed (except "/"). */
  path: string;
  /** Query string including "?" (kept for new-side targets only), or "". */
  search: string;
  /** protocol//host + path (+ search on the new side). */
  absolute: string;
  /** Decoded, lowercased, Shopify-canonical path used for exact matching. */
  matchPath: string;
  /** Raw last segment (decoded, lowercased, extension removed). */
  rawSlug: string;
  slugTokens: string[];
  /** Tokens of every segment (parent segments + slug), structural words removed. */
  pathTokens: string[];
  /** True when a query or fragment was present and ignored for matching. */
  droppedQuery: boolean;
}

export type ParseResult = { ok: true; url: ParsedSiteUrl } | { ok: false; reason: string };

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.+$/, "");
}

/** www/non-www twins of the project host (old side only). */
export function isSameSiteHost(host: string, projectHost: string): boolean {
  const h = normalizeHost(host);
  const p = normalizeHost(projectHost);
  return h === p || h === `www.${p}` || `www.${h}` === p;
}

/** decodeURIComponent that never throws: malformed escapes are kept as written. */
export function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    // Decode the valid escapes one by one and keep invalid ones verbatim.
    return segment.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run;
      }
    });
  }
}

/** Collapse duplicate slashes and strip the trailing slash (root stays "/"). */
export function cleanPath(pathname: string): string {
  return `/${pathname.split("/").filter((s) => s.length > 0).join("/")}`;
}

/** Decoded, lowercased segments of an (encoded) pathname. */
export function decodedSegments(pathname: string): string[] {
  return pathname
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => safeDecode(s).normalize("NFC").toLowerCase());
}

/** /collections/<c>/products/<p>[/...] -> /products/<p>[/...] (Shopify nested product URLs). */
export function shopifyCanonicalSegments(segments: string[]): string[] {
  if (segments.length >= 4 && segments[0] === "collections" && segments[2] === "products") return segments.slice(2);
  return segments;
}

function singularize(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith("s") && !/(?:ss|us|is)$/.test(token)) return token.slice(0, -1);
  return token;
}

/** True for tokens that are numbers or look like database ids / hashes / SKUs. */
export function isIdLike(token: string): boolean {
  if (/^\d+$/.test(token)) return true;
  const digits = (token.match(/\d/g) ?? []).length;
  if (digits === 0) return false;
  if (/^[0-9a-f]{8,}$/.test(token)) return true; // hex hashes
  const letters = token.length - digits;
  return digits >= 3 && letters <= 3; // p12345, sku9876, 12345ab
}

/** Tokenize free text (a slug, title, or H1) into comparable tokens. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const cleaned = text.normalize("NFC").toLowerCase().replace(UUID, " ");
  for (const raw of cleaned.split(/[^\p{L}\p{N}]+/u)) {
    if (!raw) continue;
    if (STOP_WORDS.has(raw) || isIdLike(raw)) continue;
    out.push(singularize(raw));
  }
  return out;
}

function stripExtension(segment: string): string {
  return segment.replace(FILE_EXTENSION, "");
}

/** Slug tokens of the last path segment. */
export function slugTokensOf(segments: string[]): string[] {
  const last = segments[segments.length - 1];
  return last ? tokenize(stripExtension(last)) : [];
}

function pathTokensOf(segments: string[]): string[] {
  const out: string[] = [];
  segments.forEach((seg, i) => {
    const s = i === segments.length - 1 ? stripExtension(seg) : seg;
    if (STRUCTURAL_WORDS.has(s)) return;
    for (const t of tokenize(s)) if (!STRUCTURAL_WORDS.has(t)) out.push(t);
  });
  return out;
}

/** Stable slug key for normalized-slug matching ("" = no usable slug). */
export function slugKey(tokens: string[]): string {
  return tokens.join("-");
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Parse an old or new URL for the project host. Returns a reason (safe to show) on rejection.
 * Accepts absolute http(s) URLs, protocol-relative URLs, "/paths", and "host/path" without a scheme.
 */
export function parseSiteUrl(input: string, projectHost: string, side: UrlSide): ParseResult {
  const raw = input.trim();
  const host = normalizeHost(projectHost);
  if (!raw) return { ok: false, reason: "Empty line." };
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { ok: false, reason: "Contains control characters." };

  let candidate: string;
  if (SCHEME.test(raw)) {
    if (!/^https?:/i.test(raw)) return { ok: false, reason: "Only http(s) URLs or site paths are accepted." };
    candidate = raw;
  } else if (raw.startsWith("//")) {
    candidate = `https:${raw}`;
  } else if (raw.startsWith("/")) {
    candidate = `https://${host}${raw}`;
  } else {
    const first = raw.split(/[/?#]/, 1)[0] ?? "";
    candidate = first.includes(".") && !/\s/.test(first) && !FILE_EXTENSION.test(first) ? `https://${raw}` : `https://${host}/${raw}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, reason: "Not a valid URL or path." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "Only http(s) URLs or site paths are accepted." };
  if (url.username || url.password) return { ok: false, reason: "URLs with credentials are not accepted." };
  if (url.port) return { ok: false, reason: "URLs with a non-default port are not accepted." };
  const urlHost = normalizeHost(url.hostname);
  const hostOk = side === "new" ? urlHost === host : isSameSiteHost(urlHost, host);
  if (!hostOk) {
    return {
      ok: false,
      reason: side === "new" ? `Not on the verified host ${host}; new URLs must be on it.` : `Not on ${host}; old URLs must be paths or URLs on this site.`,
    };
  }

  const path = cleanPath(url.pathname);
  const segments = decodedSegments(path);
  const canonical = shopifyCanonicalSegments(segments);
  const last = segments[segments.length - 1] ?? "";
  const search = side === "new" ? url.search : "";
  return {
    ok: true,
    url: {
      input: raw,
      host: urlHost,
      protocol: url.protocol,
      path,
      search,
      absolute: `${url.protocol}//${urlHost}${path}${search}`,
      matchPath: `/${canonical.join("/")}`,
      rawSlug: stripExtension(last),
      slugTokens: slugTokensOf(canonical),
      pathTokens: pathTokensOf(canonical),
      droppedQuery: url.search !== "" || url.hash !== "",
    },
  };
}

// ------------------------------------------------------------------ similarity

export function dice(a: readonly string[], b: readonly string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return (2 * inter) / (A.size + B.size);
}

export function coverage(of: readonly string[], within: readonly string[]): number {
  const A = new Set(of);
  if (A.size === 0) return 0;
  const B = new Set(within);
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  return hit / A.size;
}

export interface NewPage {
  url: ParsedSiteUrl;
  /** Crawled title (untrusted text; used for tokens and shown as evidence). */
  title: string | null;
  h1: string[];
  /** Tokens of title + H1 (empty when not crawled). */
  titleTokens: string[];
}

export function makeNewPage(url: ParsedSiteUrl, title: string | null, h1: string[] = []): NewPage {
  const texts = [title ?? "", ...h1].filter((t) => t.trim().length > 0);
  return { url, title, h1, titleTokens: texts.length ? tokenize(texts.join(" ")) : [] };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Documented similarity score in [0, 1] (see the module comment). */
export function similarity(old: ParsedSiteUrl, page: NewPage): number {
  const slugSim = dice(old.slugTokens, page.url.slugTokens);
  const pathSim = dice(old.pathTokens, page.url.pathTokens);
  let num = SCORE_WEIGHTS.slug * slugSim + SCORE_WEIGHTS.path * pathSim;
  let den = SCORE_WEIGHTS.slug + SCORE_WEIGHTS.path;
  if (page.titleTokens.length > 0) {
    num += SCORE_WEIGHTS.title * coverage(old.slugTokens, page.titleTokens);
    den += SCORE_WEIGHTS.title;
  }
  return round3(num / den);
}

export interface ShortlistEntry {
  page: NewPage;
  score: number;
}

export function shortlist(old: ParsedSiteUrl, pages: readonly NewPage[], size = SHORTLIST_SIZE): ShortlistEntry[] {
  return pages
    .map((page) => ({ page, score: similarity(old, page) }))
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score || (a.page.url.absolute < b.page.url.absolute ? -1 : a.page.url.absolute > b.page.url.absolute ? 1 : 0))
    .slice(0, size);
}

// ------------------------------------------------------------------ deterministic matching

export interface NewPageIndex {
  pages: NewPage[];
  byMatchPath: Map<string, NewPage>;
  bySlugKey: Map<string, NewPage[]>;
}

/** Dedupe new pages by matchPath (first wins) and index them. */
export function indexNewPages(pages: readonly NewPage[]): NewPageIndex {
  const byMatchPath = new Map<string, NewPage>();
  const bySlugKey = new Map<string, NewPage[]>();
  const unique: NewPage[] = [];
  for (const p of pages) {
    if (byMatchPath.has(p.url.matchPath)) continue;
    byMatchPath.set(p.url.matchPath, p);
    unique.push(p);
    const key = slugKey(p.url.slugTokens);
    if (key) bySlugKey.set(key, [...(bySlugKey.get(key) ?? []), p]);
  }
  return { pages: unique, byMatchPath, bySlugKey };
}

export type DeterministicMatch =
  | { kind: "exact_path"; page: NewPage }
  | { kind: "normalized_slug"; page: NewPage }
  | { kind: "unresolved"; candidates: ShortlistEntry[]; ambiguousSlug: number };

export function matchOld(old: ParsedSiteUrl, index: NewPageIndex): DeterministicMatch {
  const exact = index.byMatchPath.get(old.matchPath);
  if (exact) return { kind: "exact_path", page: exact };
  const key = slugKey(old.slugTokens);
  const sameSlug = key ? index.bySlugKey.get(key) ?? [] : [];
  if (sameSlug.length === 1) {
    const page = sameSlug[0]!;
    const multiToken = old.slugTokens.length >= 2;
    if (multiToken || (old.rawSlug !== "" && old.rawSlug === page.url.rawSlug)) return { kind: "normalized_slug", page };
  }
  return { kind: "unresolved", candidates: shortlist(old, index.pages), ambiguousSlug: sameSlug.length > 1 ? sameSlug.length : 0 };
}

// ------------------------------------------------------------------ Shopify CSV

export const SHOPIFY_CSV_HEADER = "Redirect from,Redirect to";

/** RFC 4180 field escaping: quote when the value has a comma, quote, CR/LF, or edge spaces. */
export function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value) || value !== value.trim()) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** Comparable form of a path: decoded, lowercased, no trailing slash. */
export function comparablePath(path: string): string {
  return `/${decodedSegments(path.split(/[?#]/, 1)[0] ?? "").join("/")}`;
}

/** "Redirect from,Redirect to" + one line per pair; LF line endings, trailing newline. */
export function buildShopifyCsv(pairs: ReadonlyArray<{ fromPath: string; toPath: string }>): string {
  const lines = [SHOPIFY_CSV_HEADER];
  for (const p of pairs) lines.push(`${csvEscape(p.fromPath)},${csvEscape(p.toPath)}`);
  return `${lines.join("\n")}\n`;
}

/** Path (+ query) of an absolute URL on the project host; null when it cannot be parsed. */
export function pathOf(absolute: string): string | null {
  try {
    const u = new URL(absolute);
    return `${cleanPath(u.pathname)}${u.search}`;
  } catch {
    return null;
  }
}
