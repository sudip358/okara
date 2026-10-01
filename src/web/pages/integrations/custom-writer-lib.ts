/**
 * Pure helpers for the writer card's custom (OpenAI-compatible) provider flow. The server is
 * authoritative for every check (routes/custom-providers.ts); these only give quick inline feedback.
 * Model ids come from a third-party /models list: they are untrusted plain text, never markup.
 */
import type { CustomProviderStatus, CustomProvidersResponse } from "@shared/types";

/** Most options rendered in the model dropdown at once (the search narrows the rest). */
export const MODEL_OPTIONS_SHOWN = 200;

/** Case-insensitive match of every whitespace-separated term, in list order; at most `limit` results. */
export function filterModels(models: readonly string[], query: string, limit = MODEL_OPTIONS_SHOWN): { shown: string[]; matched: number } {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = terms.length === 0 ? models : models.filter((m) => terms.every((t) => m.toLowerCase().includes(t)));
  return { shown: matches.slice(0, limit), matched: matches.length };
}

/** Quick client-side check of a base URL (the server applies the full SSRF rules). null = looks fine. */
export function baseUrlInputError(raw: string): string | null {
  const v = raw.trim();
  if (!v) return "Enter the provider's base URL, e.g. https://openrouter.ai/api/v1.";
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return "Base URL is not a valid URL.";
  }
  if (u.protocol !== "https:") return "Base URL must use https://.";
  if (u.username || u.password) return "Base URL must not contain a user name or password; put the key in the API key field.";
  if (u.search || u.hash) return "Base URL must not contain a query string or fragment.";
  return null;
}

/**
 * The server's message when a 400 names this field (details.field), else null. Structural check of the
 * api client's ApiError ({status, body: {details}}), so this module stays free of browser-only imports.
 */
export function fieldErrorFor(err: unknown, field: string): string | null {
  if (!(err instanceof Error)) return null;
  const e = err as Error & { status?: unknown; body?: { details?: unknown } };
  if (e.status !== 400 || !e.body || typeof e.body !== "object") return null;
  const details = e.body.details as { field?: unknown } | undefined;
  return details && typeof details === "object" && details.field === field ? e.message : null;
}

/** True when the error is a field error that fieldErrorFor already shows next to a field. */
export function isFieldError(err: unknown, fields: readonly string[]): boolean {
  return fields.some((f) => fieldErrorFor(err, f) !== null);
}

export function activeCustomWriter(data: CustomProvidersResponse | null | undefined): CustomProviderStatus | null {
  return data?.providers.find((p) => p.isWriter) ?? null;
}

/** "Writer (Anthropic)" -> "Anthropic"; the operator-configured default writer's name for the radio. */
export function defaultWriterName(label: string): string {
  const m = /^Writer \((.+)\)$/.exec(label);
  return m ? m[1]! : "Default writer";
}

/** Plain-text test outcome, matching the provider key rows. */
export function testOutcomeText(ok: boolean | null, detail: string): string {
  return `${ok === true ? "Test passed" : ok === null ? "Test not confirmed" : "Test failed"}: ${detail}`;
}
