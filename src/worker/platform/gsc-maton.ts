/**
 * Search Console through the Maton.ai gateway, and the project's Search Console source resolution.
 *
 * Source precedence (owner request 2026-10-03; docs/api.md "Maton.ai"):
 *   1. the project's direct Google OAuth connection (platform/gsc-client.ts), unchanged and default, whenever it is
 *      connected;
 *   2. otherwise, when the project's "Search Console source" is 'maton' and the workspace has a Maton key with an
 *      active google-search-console connection, the same native API through Maton (platform/maton.ts);
 *   3. otherwise none: callers report setup_required.
 * The Maton provider sends exactly the native request bodies of gsc-client.ts and parses the same response shapes.
 */
import type { Env } from "../env";
import type { Db } from "../lib/db";
import type { CallRecorder, GscProvider, GscQueryRequest, GscRow } from "../providers/types";
import { createGscProvider, GSC_MAX_ROW_LIMIT, GscApiError } from "./gsc-client";
import { gscListSites, gscSearchAnalytics, MatonApiError, MatonPolicyError, type MatonDeps } from "./maton";
import { matonTransport, type MatonTransport } from "./maton-credentials";

export type GscSource = "direct" | "maton";

/** The project's stored Search Console source ('direct' when unset or before migration 0018). */
export async function loadGscSource(db: Db, workspaceId: string, projectId: string): Promise<GscSource> {
  try {
    const row = await db.first<{ gsc_source: string | null }>("SELECT gsc_source FROM projects WHERE workspace_id = ? AND id = ?", workspaceId, projectId);
    return row?.gsc_source === "maton" ? "maton" : "direct";
  } catch {
    return "direct";
  }
}

function toGscError(e: unknown): unknown {
  if (e instanceof MatonApiError) {
    const code = e.status === 429 ? "quota_exceeded" : e.code === "unauthorized" ? "maton_unauthorized" : e.code === "forbidden" ? "forbidden" : `maton_${e.code}`;
    return new GscApiError(e.status, code, e.message);
  }
  if (e instanceof MatonPolicyError) return new GscApiError(0, "maton_policy", e.message);
  return e;
}

export interface MatonGscOptions {
  calls?: CallRecorder | null;
  purpose?: string;
  fetchImpl?: typeof fetch;
}

/** GscProvider over Maton (native webmasters/v3 shapes; see gsc-client.ts for the contract). */
export function createMatonGscProvider(env: Env, transport: MatonTransport, opts: MatonGscOptions = {}): GscProvider {
  const deps: MatonDeps = { env, apiKey: transport.apiKey, calls: opts.calls ?? null, purpose: opts.purpose ?? "gsc_sync", fetchImpl: opts.fetchImpl };
  return {
    transport: { kind: "maton", label: transport.label },
    async listProperties() {
      let json: { siteEntry?: Array<{ siteUrl?: unknown; permissionLevel?: unknown }> } | null;
      try {
        json = (await gscListSites(deps, transport.connectionId)) as typeof json;
      } catch (e) {
        throw toGscError(e);
      }
      return (json?.siteEntry ?? [])
        .filter((e): e is { siteUrl: string; permissionLevel: string } => typeof e.siteUrl === "string" && typeof e.permissionLevel === "string")
        .map((e) => ({ siteUrl: e.siteUrl.slice(0, 300), permissionLevel: e.permissionLevel.slice(0, 40) }));
    },
    async query(req: GscQueryRequest) {
      const body = {
        startDate: req.startDate,
        endDate: req.endDate,
        dimensions: req.dimensions,
        type: req.type ?? "web",
        rowLimit: Math.max(1, Math.min(GSC_MAX_ROW_LIMIT, Math.floor(req.rowLimit))),
        startRow: Math.max(0, Math.floor(req.startRow)),
        dataState: req.dataState ?? "final",
        ...(req.dimensionFilterGroups?.length ? { dimensionFilterGroups: req.dimensionFilterGroups } : {}),
      };
      let json: { rows?: GscRow[]; responseAggregationType?: string; metadata?: { first_incomplete_date?: unknown; first_incomplete_hour?: unknown } } | null;
      try {
        json = (await gscSearchAnalytics(deps, transport.connectionId, req.property, body)) as typeof json;
      } catch (e) {
        throw toGscError(e);
      }
      const meta = json?.metadata;
      const metadata =
        meta && (typeof meta.first_incomplete_date === "string" || typeof meta.first_incomplete_hour === "string")
          ? {
              ...(typeof meta.first_incomplete_date === "string" ? { first_incomplete_date: meta.first_incomplete_date.slice(0, 40) } : {}),
              ...(typeof meta.first_incomplete_hour === "string" ? { first_incomplete_hour: meta.first_incomplete_hour.slice(0, 40) } : {}),
            }
          : undefined;
      return { rows: Array.isArray(json?.rows) ? json!.rows : [], responseAggregationType: json?.responseAggregationType, ...(metadata ? { metadata } : {}) };
    },
  };
}

/** The workspace's Maton Search Console transport (null = no key or no active connection). */
export async function matonGscTransport(env: Env, db: Db, workspaceId: string): Promise<MatonTransport | null> {
  return matonTransport(env, db, workspaceId, "google-search-console");
}

/**
 * The project's Search Console provider by precedence: direct OAuth, else Maton when the project chose it, else null.
 * `fetchImpl` is the guarded fetch for the direct path (unchanged); Maton builds its own guarded fetch.
 */
export async function resolveGscProvider(
  env: Env,
  db: Db,
  project: { id: string; workspaceId: string },
  fetchImpl: typeof fetch,
  clock: () => Date = () => new Date(),
  opts: MatonGscOptions = {},
): Promise<GscProvider | null> {
  const direct = await createGscProvider(env, db, project, fetchImpl, clock);
  if (direct) return direct;
  if ((await loadGscSource(db, project.workspaceId, project.id)) !== "maton") return null;
  const t = await matonGscTransport(env, db, project.workspaceId);
  return t ? createMatonGscProvider(env, t, opts) : null;
}
