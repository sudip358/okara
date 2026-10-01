/**
 * The built-in GEO answer engines (API-sampled lanes) this build can run: every id here has an adapter in
 * src/worker/providers (gemini.ts, perplexity.ts, openai-geo.ts, anthropic-geo.ts) and a credential
 * slot (platform/credentials.ts). The GEO agent is ready when at least one of them is configured.
 * Order is registration order (results lanes, checklist provider list); the AI engine board keeps its
 * own display order (geo/board.ts BOARD_LANES). Workspace custom GEO engines ("custom_geo:<id>",
 * geo/custom-lanes.ts) are extra, ungrounded lanes that are not in this list.
 */
import type { GeoEngineProviderId } from "@shared/types";

export const GEO_ENGINE_IDS = ["gemini", "perplexity", "openai_geo", "anthropic_geo"] as const satisfies readonly GeoEngineProviderId[];

export function isGeoEngineId(id: string): id is GeoEngineProviderId {
  return (GEO_ENGINE_IDS as readonly string[]).includes(id);
}

/** True when any GEO engine (built-in, or a custom GEO engine lane) is configured in a capability map (presence only). */
export function anyGeoEngineConfigured(caps: Partial<Record<GeoEngineProviderId, boolean>> & { customGeoEngines?: readonly string[] }): boolean {
  return GEO_ENGINE_IDS.some((p) => caps[p] === true) || (caps.customGeoEngines?.length ?? 0) > 0;
}
