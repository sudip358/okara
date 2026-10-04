/**
 * Ask Okara secret guard [A35]: API keys never pass through the model or the chat tables.
 *
 *  - `redactSecrets(text)` masks key-like substrings in a user message (and in the stored answer) BEFORE it is
 *    stored or sent to the model: the stored text and the model both see `KEY_PLACEHOLDER` instead.
 *  - `keyLikeIn(input)` finds key-like strings anywhere in a tool call's arguments; the loop refuses such a call
 *    (no step args, no pending action) and tells the model to use the secure field.
 *  - `scrubKeyLike(raw)` masks key-like strings inside a provider-native assistant round before it is kept in the
 *    turn transcript (thinking blocks and their signatures are left untouched: they are opaque/signed).
 *
 * Detection is deliberately high-precision: well-known key prefixes (sk-, sk-ant-, AIza, pplx-, ghp_, xox?-, AKIA,
 * JWTs, Google OAuth tokens ...), a long token right after a key/secret/token/password word, and (tool input /
 * free text) a long mixed-case alphanumeric token that is not part of a URL and is not a Google file id.
 */

export const KEY_PLACEHOLDER = "[key removed — use the secure field]";

const PREFIXED: RegExp[] = [
  /\bsk-(?:ant-|proj-|or-|live-|test-|svcacct-)?[A-Za-z0-9_-]{16,}/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bpplx-[A-Za-z0-9]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\b(?:hf|gsk|r8)_[A-Za-z0-9]{24,}/g,
  /\bya29\.[A-Za-z0-9_-]{20,}/g,
  /(?<![\w/])1\/\/[A-Za-z0-9_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

/** "api key is X", "token: X", "Bearer X", "password = X" (X: 20+ chars, or 8+ after password). */
const CONTEXT: RegExp[] = [
  /\b(?:api[ _-]?key|apikey|access[ _-]?key|secret(?:[ _-]?key)?|token|bearer|authorization|key)\b\s*(?:is|=|:|was)?\s*["'`]?([A-Za-z0-9_\-.\/+=~#%&*!^@]{20,})/gi,
  /\b(?:password|passwd|pwd)\b\s*(?:is|=|:|was)?\s*["'`]?([^\s"'`]{8,})/gi,
];

/** Argument names that only a secret would have (no tool takes one). */
const KEY_NAMED = /^(api_?key|apikey|key|secret|password|passwd|token|access_?token|authorization)$/i;

/** A long mixed-case alphanumeric run (upper + lower + digit), as random API keys are. */
const GENERIC = /[A-Za-z0-9_\-+/=]{32,}/g;

function genericKeyLike(token: string, text: string, index: number): boolean {
  if (!(/[A-Z]/.test(token) && /[a-z]/.test(token) && /\d/.test(token))) return false;
  // Part of a URL (a sheet link, a docs page): not a key by itself.
  const before = text.slice(Math.max(0, index - 200), index);
  if (/https?:\/\/\S*$/.test(before) || before.endsWith("/")) return false;
  // Google Drive / Sheets file ids (44 chars starting with 1) are ids, not secrets.
  if (/^1[A-Za-z0-9_-]{43}$/.test(token)) return false;
  return true;
}

/**
 * Plain words and model ids ("the key is configured", "key claude-opus-4-20250514") are not secrets: a password
 * needs a letter and a digit or symbol; any other key needs upper + lower + digit, or 32+ chars with a letter
 * and a digit (hex / lowercase keys).
 */
function contextTokenLooksRandom(tok: string, password: boolean): boolean {
  const letter = /[A-Za-z]/.test(tok);
  if (password) return letter && /[\d_\-+/=#%&*!^@~]/.test(tok);
  if (/[A-Z]/.test(tok) && /[a-z]/.test(tok) && /\d/.test(tok)) return true;
  return tok.length >= 32 && letter && /\d/.test(tok);
}

interface Hit {
  start: number;
  end: number;
}

function hits(text: string, generic: boolean): Hit[] {
  const out: Hit[] = [];
  for (const re of PREFIXED) for (const m of text.matchAll(re)) out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  for (const re of CONTEXT) {
    for (const m of text.matchAll(re)) {
      const tok = m[1]!;
      if (!contextTokenLooksRandom(tok, re === CONTEXT[1])) continue;
      const start = (m.index ?? 0) + m[0].length - tok.length;
      out.push({ start, end: start + tok.length });
    }
  }
  if (generic) {
    for (const m of text.matchAll(GENERIC)) {
      if (genericKeyLike(m[0], text, m.index ?? 0)) out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** True when the text contains something that looks like an API key, token or password. */
export function looksLikeSecret(text: string, opts: { generic?: boolean } = {}): boolean {
  return hits(text, opts.generic ?? true).length > 0;
}

/** Text with every key-like substring replaced by KEY_PLACEHOLDER; `count` = replacements. */
export function redactSecrets(text: string, opts: { generic?: boolean } = {}): { text: string; count: number } {
  const hs = hits(text, opts.generic ?? true);
  if (!hs.length) return { text, count: 0 };
  let out = "";
  let at = 0;
  let count = 0;
  for (const h of hs) {
    if (h.start < at) continue; // overlapping match already masked
    out += text.slice(at, h.start) + KEY_PLACEHOLDER;
    at = h.end;
    count++;
  }
  return { text: out + text.slice(at), count };
}

/**
 * Paths of string values in a tool call's arguments that look like a key ("baseUrl", "note", "add.0.text").
 * Fields that legitimately hold long random-looking ids skip the generic rule (prefix/context rules still apply).
 */
export function keyLikeIn(input: unknown, idFields: readonly string[] = ["spreadsheet", "range", "propertyId", "connectionId"]): string[] {
  const found: string[] = [];
  const walk = (v: unknown, path: string, key: string, depth: number) => {
    if (depth > 6 || found.length > 5) return;
    if (typeof v === "string") {
      if (looksLikeSecret(v, { generic: !idFields.includes(key) })) found.push(path || "input");
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, path ? `${path}.${i}` : String(i), key, depth + 1));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      // A key-named argument is refused whatever its value (no tool takes one).
      if (KEY_NAMED.test(k) && x !== undefined && x !== null && x !== "") found.push(path ? `${path}.${k}` : k);
      else walk(x, path ? `${path}.${k}` : k, k, depth + 1);
    }
  };
  walk(input, "", "", 0);
  return found;
}

/** Deep copy of a provider-native round with key-like strings masked (thinking text and signatures untouched). */
export function scrubKeyLike<T>(raw: T): T {
  const skip = new Set(["signature", "thinking", "data", "id", "tool_use_id", "call_id", "type"]);
  const walk = (v: unknown, key: string): unknown => {
    if (typeof v === "string") {
      if (skip.has(key)) return v;
      if (KEY_NAMED.test(key) && v) return KEY_PLACEHOLDER;
      return redactSecrets(v).text;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(raw, "") as T;
}

export const SECRET_REFUSAL =
  "Refused: the arguments contain something that looks like an API key, token or password. Keys must never be put in chat messages or tool input. Propose the change with manage_credentials or manage_models instead: the user types the key into the secure field on the confirmation card, and it goes straight to the server, never through the chat.";
