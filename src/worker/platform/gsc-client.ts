/**
 * Search Console API client implementing GscProvider (providers/types.ts). Access tokens are obtained
 * server-side from the encrypted refresh token and cached only in this isolate's memory.
 * Contract (verified against developers.google.com/webmaster-tools/v1):
 *   GET  https://www.googleapis.com/webmasters/v3/sites -> { siteEntry: [{ siteUrl, permissionLevel }] }
 *   POST https://www.googleapis.com/webmasters/v3/sites/{siteUrl}/searchAnalytics/query
 *        body { startDate, endDate, dimensions, type, rowLimit (1..25000), startRow, dataState,
 *               dimensionFilterGroups?: [{ groupType: "and", filters: [{ dimension, operator, expression }] }] }
 *        -> { rows: [{ keys, clicks, impressions, ctr, position }], responseAggregationType, metadata? }
 *   (filters re-verified 2026-10-03: dimension country|device|page|query|searchAppearance; operator equals|
 *    notEquals|contains|notContains|includingRegex|excludingRegex; used only by Ask Okara's live query.)
 */
import type { Env } from "../env";
import type { Db } from "../lib/db";
import { decryptSecret } from "../lib/crypto";
import { iso } from "../lib/time";
import type { GscProvider, GscQueryRequest, GscRow } from "../providers/types";
import { GOOGLE_TOKEN_ENDPOINT, GOOGLE_TOKEN_TIMEOUT_MS, gscOAuthConfigured, gscTokenAad, loadGscConnection } from "./gsc-oauth";

export const GSC_API_BASE = "https://www.googleapis.com/webmasters/v3";
export const GSC_MAX_ROW_LIMIT = 25000;

export class GscApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** In-memory access token cache, keyed by project and the stored envelope (a reconnect invalidates it). */
const tokenCache = new Map<string, { envelope: string; token: string; expiresAt: number }>();

export function clearGscTokenCache(projectId?: string) {
  if (projectId) tokenCache.delete(projectId);
  else tokenCache.clear();
}

export async function createGscProvider(
  env: Env,
  db: Db,
  project: { id: string; workspaceId: string },
  fetchImpl: typeof fetch,
  clock: () => Date = () => new Date(),
): Promise<GscProvider | null> {
  if (!gscOAuthConfigured(env)) return null;
  const conn = await loadGscConnection(db, project.workspaceId, project.id);
  if (!conn || conn.status !== "connected" || !conn.refresh_token_enc) return null;
  const envelope = conn.refresh_token_enc;

  async function markError(message: string) {
    await db.run(
      "UPDATE oauth_connections SET status = 'error', last_error = ?, updated_at = ? WHERE workspace_id = ? AND project_id = ? AND provider = 'google_gsc'",
      message,
      iso(clock()),
      project.workspaceId,
      project.id,
    );
  }

  async function accessToken(forceRefresh = false): Promise<string> {
    const cached = tokenCache.get(project.id);
    const nowMs = clock().getTime();
    if (!forceRefresh && cached && cached.envelope === envelope && cached.expiresAt - 60_000 > nowMs) return cached.token;
    const refreshToken = await decryptSecret(env, envelope, gscTokenAad(project.id));
    let res: Response;
    try {
      res = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: env.GOOGLE_CLIENT_ID!,
          client_secret: env.GOOGLE_CLIENT_SECRET!,
        }).toString(),
        signal: AbortSignal.timeout(GOOGLE_TOKEN_TIMEOUT_MS),
      });
    } catch {
      throw new GscApiError(0, "network", "Could not reach Google's token endpoint.");
    }
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !body.access_token) {
      tokenCache.delete(project.id);
      if (body.error === "invalid_grant") {
        const msg = "Google rejected the stored Search Console authorization (invalid_grant). Reconnect Search Console.";
        await markError(msg);
        throw new GscApiError(res.status || 400, "invalid_grant", msg);
      }
      throw new GscApiError(res.status, body.error ?? "token_refresh_failed", `Token refresh failed (${res.status}).`);
    }
    const ttl = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
    tokenCache.set(project.id, { envelope, token: body.access_token, expiresAt: nowMs + ttl * 1000 });
    return body.access_token;
  }

  async function call(url: string, init: RequestInit): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await accessToken(attempt > 0);
      let res: Response;
      try {
        res = await fetchImpl(url, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}`, accept: "application/json" } });
      } catch {
        throw new GscApiError(0, "network", "Could not reach the Search Console API.");
      }
      if (res.status === 401 && attempt === 0) {
        tokenCache.delete(project.id);
        continue;
      }
      const json = (await res.json().catch(() => null)) as { error?: { message?: string; status?: string } } | null;
      if (!res.ok) {
        const code = res.status === 429 ? "quota_exceeded" : res.status === 403 ? "forbidden" : (json?.error?.status ?? "gsc_error");
        throw new GscApiError(res.status, code, `Search Console API error ${res.status}: ${(json?.error?.message ?? "").slice(0, 300)}`);
      }
      return json;
    }
    throw new GscApiError(401, "unauthorized", "Search Console rejected the access token.");
  }

  return {
    async listProperties() {
      const json = (await call(`${GSC_API_BASE}/sites`, { method: "GET" })) as { siteEntry?: Array<{ siteUrl?: string; permissionLevel?: string }> } | null;
      return (json?.siteEntry ?? [])
        .filter((e): e is { siteUrl: string; permissionLevel: string } => typeof e.siteUrl === "string" && typeof e.permissionLevel === "string")
        .map((e) => ({ siteUrl: e.siteUrl, permissionLevel: e.permissionLevel }));
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
      const url = `${GSC_API_BASE}/sites/${encodeURIComponent(req.property)}/searchAnalytics/query`;
      const json = (await call(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })) as {
        rows?: GscRow[];
        responseAggregationType?: string;
        metadata?: { first_incomplete_date?: unknown; first_incomplete_hour?: unknown };
      } | null;
      const meta = json?.metadata;
      const metadata =
        meta && (typeof meta.first_incomplete_date === "string" || typeof meta.first_incomplete_hour === "string")
          ? {
              ...(typeof meta.first_incomplete_date === "string" ? { first_incomplete_date: meta.first_incomplete_date.slice(0, 40) } : {}),
              ...(typeof meta.first_incomplete_hour === "string" ? { first_incomplete_hour: meta.first_incomplete_hour.slice(0, 40) } : {}),
            }
          : undefined;
      return { rows: json?.rows ?? [], responseAggregationType: json?.responseAggregationType, ...(metadata ? { metadata } : {}) };
    },
  };
}
