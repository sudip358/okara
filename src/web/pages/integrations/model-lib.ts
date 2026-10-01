/**
 * Pure helpers for the "Model" row on built-in GEO engine cards (Gemini, Perplexity, OpenAI, Anthropic) and
 * for custom GEO engines. TypeSafe (Jev) has no model row: it always runs the operator's model (TYPESAFE_MODEL,
 * else jev-latest) and its card shows that model as before. The server is authoritative (routes/credentials.ts
 * model routes refuse TypeSafe; platform/provider-models.ts). Model ids and display names come from provider
 * lists: untrusted plain text.
 */
import type { CustomProviderStatus, CustomProvidersResponse, IntegrationsStatus, ModelSelectableProviderId, ModelSource, ProviderModelOption } from "@shared/types";
import { MODEL_OPTIONS_SHOWN } from "./custom-writer-lib";

type ProviderStatus = IntegrationsStatus["providers"][number];

/** Cards with a model picker row. Not TypeSafe: "TypeSafe will perform as it is" (no model selection). */
export const MODEL_SELECTABLE: readonly ModelSelectableProviderId[] = ["gemini", "perplexity", "openai_geo", "anthropic_geo"];
export const GEO_ENGINE_PROVIDERS: readonly string[] = ["gemini", "perplexity", "openai_geo", "anthropic_geo"];

export function isModelSelectable(provider: string): provider is ModelSelectableProviderId {
  return (MODEL_SELECTABLE as readonly string[]).includes(provider);
}

/** Same label the server uses for every custom GEO engine surface. */
export const CUSTOM_GEO_NOTE = "Custom · no web search proof · mention rate only";

export const COHORT_NOTE =
  "Changing the model starts a new trend series: results are only compared with answers from the same model (cohort), never mixed.";

export const UNKNOWN_RATE_NOTE = "No verified price for this model in the rate table: its cost is recorded as unknown, never guessed.";

/** "Must support <feature>; the Test run will tell you." (no capability flag is invented). null when nothing special. */
export function mustSupportNote(feature: string | null | undefined): string | null {
  return feature ? `Must support ${feature}; the Test run will tell you.` : null;
}

/** Feature per provider, shown before a list is fetched (the server sends the same text with a list). */
export const MUST_SUPPORT_TEXT: Record<ModelSelectableProviderId, string | null> = {
  typesafe: null,
  gemini: "Grounding with Google Search (generateContent with the google_search tool)",
  perplexity: "the Agent API with the web_search tool",
  openai_geo: "the Responses API web_search tool",
  anthropic_geo: "the Messages API web search tool",
};

export function modelSourceText(source: ModelSource | null | undefined): string {
  switch (source) {
    case "workspace":
      return "chosen for this workspace";
    case "operator":
      return "operator default";
    case "default":
      return "documented default alias";
    default:
      return "not chosen";
  }
}

/** One-line summary of the model row. */
export function modelSummary(p: Pick<ProviderStatus, "model" | "modelSource">): string {
  return p.model ? `${p.model} (${modelSourceText(p.modelSource)})` : "No model chosen: choose one to use this provider.";
}

/**
 * Hint in the model form when the card runs on the operator's key (the server enforces it: PUT .../model
 * refuses such a choice, and the runtime builds no lane for a stored one). null with the workspace's own key.
 */
export function operatorKeyHint(p: Pick<ProviderStatus, "provider" | "source">): string | null {
  if (p.source !== "operator_key") return null;
  if (GEO_ENGINE_PROVIDERS.includes(p.provider)) return "With the operator key only models with a verified price can be used; add your own key to use any model.";
  return null;
}

/** The workspace has a stored selection (in effect or not), so "Use operator default" can reset it. */
export function hasWorkspaceSelection(p: Pick<ProviderStatus, "modelSource" | "workspaceModel">): boolean {
  return p.modelSource === "workspace" || (typeof p.workspaceModel === "string" && p.workspaceModel.length > 0);
}

/** Rate note for GEO engines only: shown when the selected model has no verified rate. */
export function rateNote(p: Pick<ProviderStatus, "provider" | "model" | "rateKnown">): string | null {
  return GEO_ENGINE_PROVIDERS.includes(p.provider) && p.model && p.rateKnown === false ? UNKNOWN_RATE_NOTE : null;
}

/** Case-insensitive match of every term against the id or the display label, in list order; at most `limit`. */
export function filterModelOptions(options: readonly ProviderModelOption[], query: string, limit = MODEL_OPTIONS_SHOWN): { shown: ProviderModelOption[]; matched: number } {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches =
    terms.length === 0 ? options : options.filter((o) => terms.every((t) => o.id.toLowerCase().includes(t) || o.label.toLowerCase().includes(t)));
  return { shown: matches.slice(0, limit), matched: matches.length };
}

export const toOptions = (ids: readonly string[]): ProviderModelOption[] => ids.map((id) => ({ id, label: id }));

/** Quick client check of a typed model id (the server validates per provider). null = looks fine. */
export function modelInputError(raw: string): string | null {
  const v = raw.trim();
  if (!v) return "Choose a model, or type a model id.";
  if (v.length > 200) return "Model id must be at most 200 characters.";
  if (/[\x00-\x1f\x7f]/.test(v)) return "Model id must not contain control characters.";
  return null;
}

/** Custom providers by role. Rows without a role predate migration 0011 and are writers. */
export function writerProviders(data: CustomProvidersResponse | null | undefined): CustomProviderStatus[] {
  return (data?.providers ?? []).filter((p) => (p.role ?? "writer") === "writer");
}
export function geoEngines(data: CustomProvidersResponse | null | undefined): CustomProviderStatus[] {
  return (data?.providers ?? []).filter((p) => p.role === "geo");
}
