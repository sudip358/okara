/**
 * Custom GEO engine lanes: a workspace custom OpenAI-compatible provider with role 'geo'
 * (workspace_custom_providers, migrations 0010 + 0011). Its provider id in geo_observations,
 * provider_calls and run events is "custom_geo:<row id>".
 *
 * Measurement rules (docs/build-kit.md amendments "Custom GEO engine lanes" 2026-10-01 and 2026-10-02):
 *   - the approved prompt goes to {base}/chat/completions with no tools or plugins requested (the owner picks
 *     a model/provider that searches by itself, e.g. an OpenRouter ":online" model);
 *   - an answer whose response carries provider-reported web sources in a documented OpenAI-compatible shape
 *     (providers/custom-geo.ts parseCustomGeoResponse) is stored grounded = 1, grounding_mode
 *     CUSTOM_GEO_SOURCES_MODE, with those sources as citations; it counts toward citation rate exactly like
 *     any other grounded answer;
 *   - an answer without sources is stored grounded = 0, grounding_mode CUSTOM_GEO_GROUNDING_MODE, no
 *     citations: mention rate (and tracked-brand share of voice) only, as before;
 *   - search queries are never exposed (null) and cost is NULL (unknown, never guessed);
 *   - the lane's cohort uses CUSTOM_GEO_LANE_GROUNDING_MODE (fixed per lane), so answers with and without
 *     sources of one model stay in ONE series; metrics.ts counts only the grounded ones in citation rate;
 *   - surfaces label the lane CUSTOM_GEO_NOTE and each answer/cohort with CUSTOM_GEO_SOURCES_NOTE or
 *     CUSTOM_GEO_NO_SOURCES_NOTE.
 */
import type { CustomGeoProviderId } from "@shared/types";
import type { Db } from "../lib/db";
import { listCustomGeoEngines } from "../platform/custom-providers";

export const CUSTOM_GEO_PREFIX = "custom_geo:";
/** Per-answer grounding mode of an answer WITHOUT provider-reported sources (grounded = 0). */
export const CUSTOM_GEO_GROUNDING_MODE = "none (custom provider)";
/** Per-answer grounding mode of an answer WITH provider-reported sources (grounded = 1). */
export const CUSTOM_GEO_SOURCES_MODE = "custom (provider-reported sources)";
/** Lane-level grounding mode (adapter + cohort key): fixed, so one lane's series never splits per answer. */
export const CUSTOM_GEO_LANE_GROUNDING_MODE = "custom (sources only when the provider returns them)";
/** Lane / engine note. */
export const CUSTOM_GEO_NOTE = "Custom · citations count only when the provider returns sources";
/** Answer (or cohort) without provider-reported sources. */
export const CUSTOM_GEO_NO_SOURCES_NOTE = "no sources returned · mention rate only";
/** Answer (or cohort) with provider-reported sources. */
export const CUSTOM_GEO_SOURCES_NOTE = "provider-reported sources";

export const customGeoProviderId = (rowId: string): CustomGeoProviderId => `custom_geo:${rowId}`;

export function isCustomGeoId(provider: string | null | undefined): provider is CustomGeoProviderId {
  return typeof provider === "string" && provider.startsWith(CUSTOM_GEO_PREFIX) && provider.length > CUSTOM_GEO_PREFIX.length;
}

/** "<name> (<host>) · Custom · citations count only when the provider returns sources". Name and host are plain text. */
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
