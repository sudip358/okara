/**
 * [A35] Which chat actions need a secret typed into the confirmation card, and where the browser sends it.
 * Pure (no I/O) so the store (ChatAction.secretField), the service (confirm checks) and the tools agree.
 *
 * The request always targets an EXISTING credential route of the action's own workspace; the body holds only
 * non-secret fields the action already validated (base URL, model, label, role). The browser adds the typed
 * values, calls the route itself (session cookie + CSRF, the route's own owner check, validation and rate limit),
 * then confirms the chat action with {ok, keyHint} only.
 */
import type { ChatSecretField } from "@shared/types";

export const BUILT_IN_KEY_TARGETS = ["typesafe", "gemini", "perplexity", "openai_geo", "anthropic_geo", "writer"] as const;
export type BuiltInKeyTarget = (typeof BUILT_IN_KEY_TARGETS)[number];
export const CREDENTIAL_TARGET_RE = /^(typesafe|gemini|perplexity|openai_geo|anthropic_geo|writer|dataforseo|maton|custom:[a-z0-9_]{1,100})$/;

export const TARGET_LABEL: Record<string, string> = {
  typesafe: "TypeSafe (Jev)",
  gemini: "Google Gemini",
  perplexity: "Perplexity",
  openai_geo: "OpenAI (AI engine)",
  anthropic_geo: "Anthropic Claude (AI engine)",
  writer: "Writer",
  dataforseo: "DataForSEO",
  maton: "Maton.ai",
};

const enc = encodeURIComponent;
const NOTE = "The key goes straight from this field to Okara's server (encrypted at rest). It is never sent to the chat or the model.";

function apiKeyField(label: string, request: ChatSecretField["request"]): ChatSecretField {
  return { label, fields: [{ name: "apiKey", label: "API key" }], request, hintFrom: "apiKey", note: NOTE };
}

/** The secure-input card for an action, or null when the action needs no secret. */
export function secretFieldFor(name: string, args: Record<string, unknown>, workspaceId: string): ChatSecretField | null {
  const ws = `/workspaces/${enc(workspaceId)}`;
  if (name === "manage_credentials" && args.op === "set_key" && typeof args.target === "string" && CREDENTIAL_TARGET_RE.test(args.target)) {
    const t = args.target;
    if (t === "dataforseo") {
      return {
        label: "DataForSEO API login and password",
        fields: [
          { name: "login", label: "API login" },
          { name: "password", label: "API password" },
        ],
        request: { method: "PUT", path: `${ws}/dataforseo`, body: {} },
        hintFrom: "password",
        note: NOTE,
      };
    }
    if (t === "maton") return apiKeyField("Maton.ai API key", { method: "PUT", path: `${ws}/maton`, body: {} });
    if (t.startsWith("custom:")) return apiKeyField("Custom provider API key", { method: "PATCH", path: `${ws}/custom-providers/${enc(t.slice(7))}`, body: {} });
    return apiKeyField(`${TARGET_LABEL[t] ?? t} API key`, { method: "PUT", path: `${ws}/credentials/${enc(t)}`, body: {} });
  }
  if (name === "manage_models") {
    if (args.op === "add_provider" && typeof args.baseUrl === "string" && typeof args.model === "string") {
      const role = args.role === "geo" ? "geo" : "writer";
      const body: Record<string, string | boolean> = { baseUrl: args.baseUrl, model: args.model };
      if (typeof args.label === "string" && args.label.trim()) body.label = args.label;
      if (role === "geo") body.role = "geo";
      else body.useAsWriter = args.useAsWriter !== false;
      return apiKeyField(role === "geo" ? "API key for the new custom GEO engine" : "API key for the new custom writer", { method: "POST", path: `${ws}/custom-providers`, body });
    }
    if (args.op === "update_base_url" && args.keepSavedKey !== true && typeof args.providerId === "string" && typeof args.baseUrl === "string") {
      const body: Record<string, string | boolean> = { baseUrl: args.baseUrl };
      if (typeof args.model === "string") body.model = args.model;
      return apiKeyField("API key for the new base URL", { method: "PATCH", path: `${ws}/custom-providers/${enc(args.providerId)}`, body });
    }
  }
  return null;
}

/** Last 4 characters of a typed secret, as the routes store it (trimmed first). */
export const keyHintOf = (secret: string): string => secret.trim().slice(-4);
