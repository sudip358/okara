/** Deterministic text helpers for candidate heuristics: URL normalization, tokens, formatting. */

/** Normalize a URL for matching GSC pages to crawled pages: lowercase host, no hash, no trailing slash (except root). */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    let path = u.pathname;
    if (path.length > 1 && path.endsWith("/")) path = path.replace(/\/+$/, "");
    return `${u.protocol}//${u.host}${path}${u.search}`;
  } catch {
    return raw.trim().toLowerCase();
  }
}

export function resolveUrl(href: string, base: string): string | null {
  try {
    return normalizeUrl(new URL(href, base).toString());
  } catch {
    return null;
  }
}

export function pathOf(url: string): string {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return url;
  }
}

// English stopwords (MVP scope: English exports/sites; other languages degrade to fewer matches).
const STOPWORDS = new Set(
  (
    "a an and are as at be by for from has have how i in into is it its of on or our that the their them there these this to was " +
    "we what when where which who why will with you your vs versus best top near me my do does can should buy shop online new " +
    "com www https http html page"
  ).split(" "),
);

/** Lowercased, stopword-free tokens with light plural folding ("knobs" -> "knob"). */
export function tokens(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    let t = raw;
    if (t.length > 3 && t.endsWith("ies")) t = `${t.slice(0, -3)}y`;
    else if (t.length > 3 && t.endsWith("es") && /(sh|ch|x|ss)es$/.test(t)) t = t.slice(0, -2);
    else if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) t = t.slice(0, -1);
    out.push(t);
  }
  return out;
}

export const tokenSet = (text: string | null | undefined) => new Set(tokens(text));

/** Fraction of `needle` tokens present in `hay` (0 when needle has no tokens). */
export function coverage(needle: Set<string>, hay: Set<string>): number {
  if (needle.size === 0) return 0;
  let hit = 0;
  for (const t of needle) if (hay.has(t)) hit++;
  return hit / needle.size;
}

export function sharedCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

/** Search-query normalization used to match engine queries to GSC queries. */
export function normalizeQuery(q: string): string {
  return q
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Order-insensitive token key ("brass knobs cabinet" == "cabinet brass knob"). */
export function queryKey(q: string): string {
  return [...new Set(tokens(q))].sort().join(" ");
}

// ------------------------------------------------------------------ formatting (evidence text)
export const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
export const fmtPct = (r: number | null) => (r === null ? "n/a" : `${(r * 100).toFixed(1)}%`);
export const fmtPos = (p: number | null) => (p === null ? "n/a" : p.toFixed(1));

export function clip(s: string | null | undefined, max: number): string {
  if (!s) return "";
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Deterministic pre-screen for instruction-like text in untrusted page content ([A14] quality
 * signal only; the deterministic guards remain the control). Tainted text is kept as evidence but
 * excluded from Jev state and writer context.
 */
export function looksLikeInstructions(text: string | null | undefined): boolean {
  if (!text) return false;
  return /ignore (all |any )?(the )?(previous|prior|above) (instructions|prompts?)|disregard (all |the )?(previous|prior|above)|you are (now )?(an? )?(ai|assistant|language model|chatgpt)|system prompt|<\s*\/?\s*(system|assistant)\s*>|do not follow (your|the) (rules|instructions)/i.test(
    text,
  );
}
