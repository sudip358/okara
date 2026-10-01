/**
 * Custom GEO engine lanes: a workspace custom OpenAI-compatible provider with role 'geo'
 * (workspace_custom_providers, migrations 0010 + 0011). Its provider id in geo_observations,
 * provider_calls and run events is "custom_geo:<row id>".
 *
 * Measurement rules (docs/build-kit.md amendment "Custom GEO engine lanes"):
 *   - the approved prompt goes to {base}/chat/completions with no tools: nothing proves a web search, so
 *     every observation is stored grounded = 0, grounding_mode "none (custom provider)", no citations, no
 *     search queries, cost NULL (unknown, never guessed);
 *   - metrics.ts citationRate counts grounded responses only, so these lanes contribute to mention rate (and
 *     tracked-brand share of voice) only; their citation rate is unavailable (denominator 0);
 *   - every surface labels them "Custom · no web search proof · mention rate only".
 */
import type { CustomGeoProviderId } from "@shared/types";
import type { Db } from "../lib/db";
import { listCustomGeoEngines } from "../platform/custom-providers";

export const CUSTOM_GEO_PREFIX = "custom_geo:";
export const CUSTOM_GEO_GROUNDING_MODE = "none (custom provider)";
export const CUSTOM_GEO_NOTE = "Custom · no web search proof · mention rate only";

export const customGeoProviderId = (rowId: string): CustomGeoProviderId => `custom_geo:${rowId}`;

export function isCustomGeoId(provider: string | null | undefined): provider is CustomGeoProviderId {
  return typeof provider === "string" && provider.startsWith(CUSTOM_GEO_PREFIX) && provider.length > CUSTOM_GEO_PREFIX.length;
}

/** "<name> (<host>) · Custom · no web search proof · mention rate only". Name and host are plain text. */
export function customGeoLaneLabel(name: string, host: string): string {
  return name === host ? `${host} · ${CUSTOM_GEO_NOTE}` : `${name} (${host}) · ${CUSTOM_GEO_NOTE}`;
}

/** Label for a custom lane whose provider row is gone (history only). */
export const REMOVED_CUSTOM_GEO_LABEL = `Custom GEO engine (removed) · ${CUSTOM_GEO_NOTE}`;

/** Lane labels of the workspace's current custom GEO engines, by provider id. */
export async function customGeoLabels(db: Db, workspaceId: string): Promise<Map<string, string>> {
  const rows = await listCustomGeoEngines(db, workspaceId);
  return new Map(rows.map((r) => [customGeoProviderId(r.id), customGeoLaneLabel(r.label, r.host)]));
}

export function customGeoLabelFor(provider: string, labels: ReadonlyMap<string, string>): string {
  return labels.get(provider) ?? REMOVED_CUSTOM_GEO_LABEL;
}
