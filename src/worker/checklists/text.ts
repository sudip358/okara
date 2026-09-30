/** Small, deterministic text helpers for checklist heuristics (no model calls). */

const STOPWORDS = new Set(
  (
    "a an the and or but for to of in on at by with from into over under about as is are was were be been being it its this that these those " +
    "your you yours my our we us i me he she they them their his her do does did can could should would will shall may might must " +
    "not no yes so than then there here near vs versus via per each any all some more most much many very"
  ).split(" "),
);

/** Lower-cased word tokens (letters/digits), stopwords removed, a trailing plural "s" folded for words > 3 chars. */
export function tokens(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)) {
    let t = m[0].replace(/['’]s$/, "");
    if (t.length < 2 || STOPWORDS.has(t)) continue;
    if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) t = t.slice(0, -1);
    out.push(t);
  }
  return out;
}

export const tokenSet = (text: string | null | undefined) => new Set(tokens(text));

/** Share of `query` tokens present in `hay` (0..1); null when the query has no content tokens. */
export function coverage(query: string, hay: Set<string>): number | null {
  const q = [...new Set(tokens(query))];
  if (q.length === 0) return null;
  return q.filter((t) => hay.has(t)).length / q.length;
}

const QUESTION_START = /^(how|what|why|which|who|whom|whose|where|when|can|could|does|do|did|is|are|was|were|should|will|would|may|has|have)\b/i;

/** Question-style heading: ends with "?" or starts with a question word. */
export function isQuestionHeading(text: string): boolean {
  const t = text.trim();
  return t.endsWith("?") || QUESTION_START.test(t);
}

export function isQuestionQuery(q: string): boolean {
  return QUESTION_START.test(q.trim());
}

function pathText(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname).replace(/[-_/+.]+/g, " ");
  } catch {
    return "";
  }
}

/** Title + URL path text for content-format heuristics. */
export const titleAndPath = (title: string | null, url: string) => `${title ?? ""} ${pathText(url)}`;

export const HOWTO_PATTERN = /\bhow[\s-]+to\b|\bguides?\b|\btutorials?\b|\bstep[\s-]+by[\s-]+step\b/i;
export const BESTOF_PATTERN = /\bbest\b|\btop[\s-]*\d{1,3}\b/i;
export const COMPARISON_PATTERN = /\bvs\.?\b|\bversus\b|\bcompar(?:e|es|ed|ing|ison|isons)\b|\balternatives?\b/i;

/** Login-wall destinations (sign-in, account, auth paths). */
export const LOGIN_PATH = /\/(?:login|log-in|log_in|signin|sign-in|sign_in|sign-on|sso|auth(?:enticate)?|account(?:s)?)(?:\/|$|\?|\.)/i;

export function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function hostIs(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  return h === domain || h.endsWith(`.${domain}`);
}

/** Parse a declared date (ISO or RFC-ish); null when unparseable. */
export function parseDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v.trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export const pct = (x: number) => `${(x * 100).toFixed(1).replace(/\.0$/, "")}%`;
