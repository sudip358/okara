/**
 * Pure helpers for the writer card's custom (OpenAI-compatible) provider flow. The server is
 * authoritative for every check (routes/custom-providers.ts); these give quick inline feedback and build the
 * PATCH/POST bodies and the re-test decision of both forms (so they are unit-tested outside a DOM).
 * Model ids come from a third-party /models list: they are untrusted plain text, never markup.
 */
import type {
  CustomProviderChange,
  CustomProviderInput,
  CustomProviderPatchInput,
  CustomProviderRole,
  CustomProviderStatus,
  CustomProvidersResponse,
} from "@shared/types";

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

/**
 * True when the active custom writer differs between two provider lists (one was activated, another chosen, or
 * the active one removed). The writer card leaves the "Custom" panel only then, never after an edit of a saved
 * provider (its automatic re-test and "Change model" offer must stay on screen).
 */
export function activeWriterChanged(before: CustomProvidersResponse | null | undefined, next: CustomProvidersResponse | null | undefined): boolean {
  return (activeCustomWriter(before)?.id ?? null) !== (activeCustomWriter(next)?.id ?? null);
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

// ------------------------------------------------------------------ base URL on a new host (tunnels)

/** Lowercase host of a typed base URL (a trailing dot removed), or null when it does not parse. */
export function typedHost(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  try {
    const host = new URL(v).hostname.toLowerCase().replace(/\.$/, "");
    return host || null;
  } catch {
    return null;
  }
}

/** The typed base URL's host when it differs from the saved host; null when it is the same or does not parse. */
export function newHostFor(savedHost: string | null | undefined, typedBaseUrl: string): string | null {
  if (!savedHost) return null;
  const host = typedHost(typedBaseUrl);
  return host && host !== savedHost.toLowerCase() ? host : null;
}

/** Label of the required confirmation checkbox. */
export const sendSavedKeyLabel = (host: string) => `Send my saved key to ${host}`;

/**
 * Shown with that checkbox: runs and Test send the saved key to the saved host automatically, so a tunnel name
 * that someone else can claim while the tunnel is down (a chosen localtunnel subdomain) would receive it.
 */
export const TUNNEL_NAME_NOTE =
  "Runs and Test send the saved key to this host automatically. If someone else can claim this tunnel name while your tunnel is down (for example a chosen *.loca.lt subdomain), they would receive the key: prefer random or reserved names, and when you stop the tunnel, update the URL, remove the provider, or rotate the key.";

export interface HostChangeGate {
  /** The typed URL's host when it differs from the saved host. */
  newHost: string | null;
  /** A new host and no new key typed: the owner must confirm sending the saved key (checkbox shown). */
  needsConfirm: boolean;
  /** The checkbox is ticked for exactly this new host (a confirmation never carries over to another host). */
  confirmed: boolean;
  /** Save is enabled. */
  canSave: boolean;
  /** Why Save is disabled; null when it is enabled. */
  blockedReason: string | null;
}

/**
 * Save gating for "Edit URL or key" and "Quick update URL": a base URL on a new host needs a new key or the
 * ticked "Send my saved key to <new host>" box (unchecked by default). The server enforces the same rule
 * (PATCH 400 key_required_for_new_host without keepKeyForNewHost or a new key).
 */
export function hostChangeGate(opts: { savedHost: string | null | undefined; typedBaseUrl: string; typedKey: string; confirmedHost: string | null }): HostChangeGate {
  const newHost = newHostFor(opts.savedHost, opts.typedBaseUrl);
  const needsConfirm = newHost !== null && !opts.typedKey.trim();
  const confirmed = needsConfirm && opts.confirmedHost === newHost;
  const canSave = !needsConfirm || confirmed;
  return {
    newHost,
    needsConfirm,
    confirmed,
    canSave,
    blockedReason: canSave ? null : `Tick "${sendSavedKeyLabel(newHost!)}" or enter a new API key for it.`,
  };
}

// ------------------------------------------------------------------ request bodies (pure, so they are unit-tested)

/**
 * `keepKeyForNewHost: true` only when the typed URL is on a new host, no new key is typed, and the owner ticked
 * "Send my saved key to <host>" for exactly that host. The gate is derived here from the same inputs that are
 * sent, so a confirmation given for another host (or a stale gate) can never attach the flag.
 */
function keepKeyFlag(savedHost: string, baseUrl: string, apiKey: string, confirmedHost: string | null): { keepKeyForNewHost?: true } {
  const gate = hostChangeGate({ savedHost, typedBaseUrl: baseUrl, typedKey: apiKey, confirmedHost });
  return gate.needsConfirm && gate.confirmed ? { keepKeyForNewHost: true } : {};
}

/** PATCH body of "Quick update URL": the URL only (key, model and name stay), plus the flag when confirmed. */
export function quickUrlPatchBody(p: Pick<CustomProviderStatus, "host">, url: string, confirmedHost: string | null): CustomProviderPatchInput {
  return { baseUrl: url.trim(), ...keepKeyFlag(p.host, url, "", confirmedHost) };
}

/**
 * PATCH body of "Edit URL or key". The name is sent only when it differs from the saved one, so the server's
 * default applies (a name that is the host follows a new host); a typed key replaces the saved key (and then
 * the flag is never sent); the flag only as in keepKeyFlag.
 */
export function editPatchBody(opts: {
  initial: Pick<CustomProviderStatus, "host" | "label">;
  baseUrl: string;
  apiKey: string;
  model: string;
  label: string;
  confirmedHost: string | null;
}): CustomProviderPatchInput {
  const body: CustomProviderPatchInput = { baseUrl: opts.baseUrl.trim(), model: opts.model.trim() };
  const label = opts.label.trim();
  if (label && label !== opts.initial.label) body.label = label;
  if (opts.apiKey.trim()) body.apiKey = opts.apiKey.trim();
  return { ...body, ...keepKeyFlag(opts.initial.host, opts.baseUrl, opts.apiKey, opts.confirmedHost) };
}

/** POST body of the add form (writer: selected as the writer; geo: a custom GEO engine lane). */
export function newProviderBody(opts: { role: CustomProviderRole; baseUrl: string; apiKey: string; model: string; label: string }): CustomProviderInput {
  const body: CustomProviderInput = { baseUrl: opts.baseUrl.trim(), apiKey: opts.apiKey.trim(), model: opts.model.trim() };
  if (opts.label.trim()) body.label = opts.label.trim();
  if (opts.role === "geo") body.role = "geo";
  else body.useAsWriter = true;
  return body;
}

/**
 * The provider whose Test re-runs right after an edit is saved: the edited one when its base URL or key
 * changed (a new host may serve other models: the card then offers "Change model"); null for a model- or
 * name-only edit, and for a new provider.
 */
export function retestIdAfterSave(initial: Pick<CustomProviderStatus, "id" | "baseUrl"> | null, baseUrl: string, apiKey: string): string | null {
  if (!initial) return null;
  return baseUrl.trim() !== initial.baseUrl || apiKey.trim() !== "" ? initial.id : null;
}

/** True when a test result says the saved model is not in the provider's (complete) model list. */
export function modelNotListed(result: { ok: boolean | null; detail?: string; modelListed?: boolean | null } | null | undefined): boolean {
  return !!result && result.ok === true && result.modelListed === false;
}

/** The newest recorded change that moved the base URL, or null. */
export function latestUrlChange(p: Pick<CustomProviderStatus, "changes">): CustomProviderChange | null {
  return p.changes?.find((c) => c.fields.includes("baseUrl")) ?? null;
}

/** "old.host → new.host · saved key kept · by Test User" (the caller adds the formatted date). Plain text. */
export function urlChangeSummary(c: CustomProviderChange): string {
  const parts: string[] = [];
  if (c.fromHost && c.toHost && c.fromHost !== c.toHost) parts.push(`${c.fromHost} → ${c.toHost}`);
  else if (c.fromBaseUrl && c.toBaseUrl) parts.push(`${c.fromBaseUrl} → ${c.toBaseUrl}`);
  if (c.keyKeptForNewHost) parts.push("saved key kept");
  else if (c.fields.includes("apiKey")) parts.push("new key");
  if (c.by) parts.push(`by ${c.by}`);
  return parts.join(" · ");
}
