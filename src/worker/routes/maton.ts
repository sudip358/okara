/**
 * Maton.ai API gateway key and Search Console source (docs/api.md "Maton.ai"; owner request 2026-10-03).
 *   GET    /workspaces/:wid/maton                         member; MatonStatus (never the key; last 4 characters only)
 *   PUT    /workspaces/:wid/maton                         owner; body {apiKey}; stored AES-GCM encrypted; clears the cached
 *                                                         connection list (test again to refresh it)
 *   DELETE /workspaces/:wid/maton                         owner; deletes the key and the cached connections
 *   POST   /workspaces/:wid/maton/test                    owner; body {apiKey?}; GET ctrl.maton.ai/connections?status=ACTIVE;
 *                                                         returns the apps Okara lists only; a saved-key test stores the list
 *   PUT    /workspaces/:wid/maton/connections/:app        owner; body {connectionId: string | null}; Maton-Connection pick
 *   GET    /projects/:pid/gsc/maton                       member; GscMatonStatus (the project's Search Console source)
 *   GET    /projects/:pid/gsc/maton/sites                 owner; Search Console sites through Maton
 *   PUT    /projects/:pid/gsc/source                      owner; body {source: "direct"} | {source: "maton", property}
 * Every Maton request goes through platform/maton.ts (strict egress policy). State-changing routes go through the
 * global CSRF middleware (app.ts) and are rate-limited.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app";
import type { GscMatonStatus, MatonSite, MatonTestResult } from "@shared/maton";
import type { Db } from "../lib/db";
import { encryptionConfigured, encryptSecret } from "../lib/crypto";
import { HttpError, badRequest, notFound, setupRequired, unauthorized } from "../lib/errors";
import { newId } from "../lib/ids";
import { iso } from "../lib/time";
import { requireProject, requireWorkspaceMember, requireWorkspaceOwner, type ProjectRow, type SessionUser } from "../platform/access";
import { rateLimit } from "../platform/rate-limit";
import { createCallRecorder } from "../runs/calls";
import { listActiveConnections, MatonApiError, MatonPolicyError, gscListSites, type MatonConnection } from "../platform/maton";
import { isListedApp, isUsedApp } from "../platform/maton-apps";
import {
  clearMatonConnections,
  matonAad,
  matonAvailability,
  matonRow,
  matonTransport,
  matonWorkspaceStatus,
  MATON_CREDENTIAL,
  MATON_MIGRATION_PENDING,
  resolveMatonKey,
  saveMatonListing,
  selectMatonConnection,
} from "../platform/maton-credentials";
import { loadGscConnection } from "../platform/gsc-oauth";
import { loadGscSource } from "../platform/gsc-maton";
import { siteHost } from "../platform/projects";
import { gscEntryVerifiesHost, markVerified, verificationStatus } from "../platform/verification";
import { keySchema } from "./credentials";

export const matonRoutes = new Hono<AppEnv>();

function userOf(c: Context<AppEnv>): SessionUser {
  const u = c.get("user");
  if (!u) throw unauthorized();
  return u;
}

async function jsonBody(c: Context<AppEnv>): Promise<unknown> {
  const text = await c.req.text();
  if (text.length > 4096) throw badRequest("Request body too large.");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest("Invalid JSON body.");
  }
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  // Messages only; never echo input values (they may contain the key).
  if (!r.success) throw badRequest(r.error.issues[0]?.message ?? "Invalid request.", r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  return r.data;
}

const userKey = (prefix: string) => (c: Context<AppEnv>) =>
  `${prefix}:${c.req.param("wid") ?? c.req.param("pid") ?? ""}:${c.get("user")?.id ?? c.req.header("CF-Connecting-IP") ?? "anon"}`;

const putBody = z.object({ apiKey: keySchema }).strict();
const testBody = z.object({ apiKey: keySchema.optional() }).strict();
const pickBody = z.object({ connectionId: z.union([z.string().regex(/^[A-Za-z0-9_-]{1,100}$/, "Invalid connection id."), z.null()]) }).strict();
const sourceBody = z.union([
  z.object({ source: z.literal("direct") }).strict(),
  z
    .object({
      source: z.literal("maton"),
      property: z
        .string()
        .trim()
        .min(1)
        .max(300)
        .refine((v) => v.startsWith("sc-domain:") || v.startsWith("https://") || v.startsWith("http://"), "Property must be a URL-prefix or sc-domain: property."),
    })
    .strict(),
]);

/** Test result for one listing; never includes the key, connection URLs or metadata. */
async function runTest(c: Context<AppEnv>, wid: string, apiKey: string, purpose: string): Promise<{ result: MatonTestResult; list: MatonConnection[] | null }> {
  const db = c.get("db");
  const calls = createCallRecorder(db, { workspaceId: wid, projectId: null, runId: null });
  try {
    const list = await listActiveConnections({ env: c.env, apiKey, calls, purpose });
    const used = list.filter((x) => isUsedApp(x.app));
    const detail = used.length
      ? `Key accepted. ${list.length} active connection${list.length === 1 ? "" : "s"} for the apps Okara lists.`
      : `Key accepted, but there is no active Google Sheets or Search Console connection in Maton yet. Connect them at maton.ai, then test again.`;
    return {
      result: { ok: true, detail, apps: list.map((x) => ({ app: x.app, connectionId: x.connectionId, status: x.status, createdAt: x.createdAt, used: isUsedApp(x.app) })) },
      list,
    };
  } catch (e) {
    if (e instanceof MatonApiError) {
      if (e.code === "unauthorized") return { result: { ok: false, detail: "Maton rejected the key (HTTP 401).", apps: [] }, list: null };
      if (e.code === "rate_limited") return { result: { ok: null, detail: "Maton rate-limited the test request; key not confirmed. Try again shortly.", apps: [] }, list: null };
      return { result: { ok: false, detail: e.message.slice(0, 300), apps: [] }, list: null };
    }
    if (e instanceof MatonPolicyError) return { result: { ok: false, detail: e.message, apps: [] }, list: null };
    return { result: { ok: false, detail: "Maton test failed.", apps: [] }, list: null };
  }
}

matonRoutes.get("/workspaces/:wid/maton", async (c) => {
  const user = userOf(c);
  const wid = c.req.param("wid");
  await requireWorkspaceMember(c.get("db"), user.id, wid);
  return c.json({ data: await matonWorkspaceStatus(c.get("db"), wid) });
});

matonRoutes.put("/workspaces/:wid/maton", rateLimit({ key: userKey("maton_write"), limit: 20, windowSeconds: 60 }), async (c) => {
  const user = userOf(c);
  const wid = c.req.param("wid");
  const db = c.get("db");
  await requireWorkspaceOwner(db, user.id, wid);
  const { apiKey } = parseOrThrow(putBody, await jsonBody(c));
  if (!encryptionConfigured(c.env)) throw setupRequired("Server-side encryption is not configured (TOKEN_ENCRYPTION_KEY_V1).");
  const now = iso(c.get("now"));
  const keyEnc = await encryptSecret(c.env, apiKey, matonAad(wid));
  try {
    await db.run(
      `INSERT INTO provider_credentials (id, workspace_id, provider, key_enc, key_hint, last_tested_at, last_test_ok, last_test_detail, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
       ON CONFLICT (workspace_id, provider) DO UPDATE SET
         key_enc = excluded.key_enc, key_hint = excluded.key_hint,
         last_tested_at = NULL, last_test_ok = NULL, last_test_detail = NULL, updated_at = excluded.updated_at`,
      newId("cred"),
      wid,
      MATON_CREDENTIAL,
      keyEnc,
      apiKey.slice(-4),
      now,
      now,
    );
  } catch (e) {
    if (/CHECK constraint failed/i.test(String((e as Error)?.message ?? e))) throw setupRequired(MATON_MIGRATION_PENDING);
    throw e;
  }
  // A new key may belong to another Maton account: the old listing and picks no longer apply.
  await clearMatonConnections(db, wid);
  return c.json({ data: await matonWorkspaceStatus(db, wid) });
});

matonRoutes.delete("/workspaces/:wid/maton", rateLimit({ key: userKey("maton_write"), limit: 20, windowSeconds: 60 }), async (c) => {
  const user = userOf(c);
  const wid = c.req.param("wid");
  const db = c.get("db");
  await requireWorkspaceOwner(db, user.id, wid);
  await db.run("DELETE FROM provider_credentials WHERE workspace_id = ? AND provider = ?", wid, MATON_CREDENTIAL);
  await clearMatonConnections(db, wid);
  return c.json({ data: { ok: true } });
});

matonRoutes.post("/workspaces/:wid/maton/test", rateLimit({ key: userKey("maton_test"), limit: 10, windowSeconds: 60 }), async (c) => {
  const user = userOf(c);
  const wid = c.req.param("wid");
  const db = c.get("db");
  await requireWorkspaceOwner(db, user.id, wid);
  const body = parseOrThrow(testBody, await jsonBody(c));
  if (body.apiKey) {
    // A typed, unsaved key: list its connections, persist nothing.
    return c.json({ data: (await runTest(c, wid, body.apiKey, "maton_test")).result });
  }
  if (!(await matonRow(db, wid))) throw setupRequired("No Maton key is saved for this workspace.");
  let key: string | null;
  try {
    key = await resolveMatonKey(c.env, db, wid);
  } catch {
    key = null;
  }
  const { result, list } = key
    ? await runTest(c, wid, key, "maton_test")
    : { result: { ok: false, detail: "Saved key could not be decrypted; please re-enter it.", apps: [] } as MatonTestResult, list: null };
  if (list) await saveMatonListing(db, wid, list, c.get("now"));
  await db.run(
    `UPDATE provider_credentials SET last_tested_at = ?, last_test_ok = ?, last_test_detail = ?, updated_at = ? WHERE workspace_id = ? AND provider = ?`,
    iso(c.get("now")),
    result.ok === null ? null : result.ok ? 1 : 0,
    result.detail,
    iso(c.get("now")),
    wid,
    MATON_CREDENTIAL,
  );
  return c.json({ data: result });
});

matonRoutes.put("/workspaces/:wid/maton/connections/:app", rateLimit({ key: userKey("maton_write"), limit: 20, windowSeconds: 60 }), async (c) => {
  const user = userOf(c);
  const wid = c.req.param("wid");
  const db = c.get("db");
  await requireWorkspaceOwner(db, user.id, wid);
  const app = c.req.param("app");
  if (!app || !isListedApp(app)) throw notFound("Maton app");
  const { connectionId } = parseOrThrow(pickBody, await jsonBody(c));
  if (!(await selectMatonConnection(db, wid, app, connectionId))) {
    throw badRequest("That connection is not one of this workspace's active Maton connections for the app. Test the key again to refresh the list.");
  }
  return c.json({ data: await matonWorkspaceStatus(db, wid) });
});

// ------------------------------------------------------------------ project: Search Console source

async function projectAccess(c: Context<AppEnv>): Promise<{ user: SessionUser; db: Db; row: ProjectRow; owner: boolean }> {
  const user = userOf(c);
  const db = c.get("db");
  const row = await requireProject(db, user.id, c.req.param("pid") ?? "");
  const { role } = await requireWorkspaceMember(db, user.id, row.workspace_id);
  return { user, db, row, owner: role === "owner" };
}

export async function gscMatonStatus(db: Db, p: ProjectRow, owner: boolean): Promise<GscMatonStatus> {
  const [conn, source, avail] = await Promise.all([loadGscConnection(db, p.workspace_id, p.id), loadGscSource(db, p.workspace_id, p.id), matonAvailability(db, p.workspace_id, "google-search-console")]);
  const directConnected = conn?.status === "connected" && !!conn.refresh_token_enc;
  return {
    effective: directConnected ? "direct" : source === "maton" && avail ? "maton" : null,
    source,
    directConnected,
    matonAvailable: avail !== null,
    matonConnectionLabel: avail?.label ?? null,
    property: p.gsc_property,
    canManage: owner,
  };
}

matonRoutes.get("/projects/:pid/gsc/maton", async (c) => {
  const { db, row, owner } = await projectAccess(c);
  return c.json({ data: await gscMatonStatus(db, row, owner) });
});

async function matonSites(c: Context<AppEnv>, row: ProjectRow): Promise<MatonSite[]> {
  const db = c.get("db");
  let t;
  try {
    t = await matonTransport(c.env, db, row.workspace_id, "google-search-console");
  } catch {
    throw setupRequired("The saved Maton key could not be decrypted; enter it again on the Integrations page.");
  }
  if (!t) throw setupRequired("Add a Maton key with an active Google Search Console connection (Integrations, Maton.ai card) and press Test first.");
  const calls = createCallRecorder(db, { workspaceId: row.workspace_id, projectId: row.id, runId: null });
  try {
    const json = (await gscListSites({ env: c.env, apiKey: t.apiKey, calls, purpose: "gsc_property_select" }, t.connectionId)) as {
      siteEntry?: Array<{ siteUrl?: unknown; permissionLevel?: unknown }>;
    } | null;
    return (Array.isArray(json?.siteEntry) ? json!.siteEntry : [])
      .filter((e): e is { siteUrl: string; permissionLevel: string } => typeof e?.siteUrl === "string" && typeof e?.permissionLevel === "string")
      .slice(0, 500)
      .map((e) => ({ siteUrl: e.siteUrl.slice(0, 300), permissionLevel: e.permissionLevel.slice(0, 40) }));
  } catch (e) {
    if (e instanceof MatonApiError) {
      if (e.code === "unauthorized" || e.code === "missing_connection") throw new HttpError(412, "setup_required", e.message);
      if (e.code === "rate_limited") throw new HttpError(429, "rate_limited", e.message);
      throw new HttpError(502, "gsc_error", e.message);
    }
    throw e;
  }
}

matonRoutes.get("/projects/:pid/gsc/maton/sites", rateLimit({ key: userKey("maton_sites"), limit: 20, windowSeconds: 60 }), async (c) => {
  const { db, row, owner, user } = await projectAccess(c);
  if (!owner) await requireWorkspaceOwner(db, user.id, row.workspace_id);
  return c.json({ data: await matonSites(c, row) });
});

matonRoutes.put("/projects/:pid/gsc/source", rateLimit({ key: userKey("maton_write"), limit: 20, windowSeconds: 60 }), async (c) => {
  const { db, row, owner, user } = await projectAccess(c);
  if (!owner) await requireWorkspaceOwner(db, user.id, row.workspace_id);
  if (row.is_demo === 1) throw badRequest("Demo projects cannot change their Search Console source.");
  const body = parseOrThrow(sourceBody, await jsonBody(c));
  const now = c.get("now");
  if (body.source === "direct") {
    try {
      await db.run("UPDATE projects SET gsc_source = NULL, updated_at = ? WHERE workspace_id = ? AND id = ?", iso(now), row.workspace_id, row.id);
    } catch {
      // gsc_source missing until 0018: already direct
    }
    const fresh = (await db.first<ProjectRow>("SELECT * FROM projects WHERE workspace_id = ? AND id = ?", row.workspace_id, row.id))!;
    return c.json({ data: { status: await gscMatonStatus(db, fresh, true), verification: null } });
  }
  // Only a property the Maton connection can actually see may be selected (same rule as the direct flow).
  const sites = await matonSites(c, row);
  const entry = sites.find((s) => s.siteUrl === body.property);
  if (!entry) throw badRequest("That property is not available to the Google account connected in Maton.");
  try {
    await db.run("UPDATE projects SET gsc_source = 'maton', gsc_property = ?, updated_at = ? WHERE workspace_id = ? AND id = ?", body.property, iso(now), row.workspace_id, row.id);
  } catch (e) {
    if (/no such column/i.test(String((e as Error)?.message ?? e))) throw setupRequired(MATON_MIGRATION_PENDING);
    throw e;
  }
  const check = gscEntryVerifiesHost(entry, siteHost(row.site_url));
  const updated = (await db.first<ProjectRow>("SELECT * FROM projects WHERE workspace_id = ? AND id = ?", row.workspace_id, row.id))!;
  if (check.ok) await markVerified(db, updated, "gsc", now);
  const fresh = (await db.first<ProjectRow>("SELECT * FROM projects WHERE workspace_id = ? AND id = ?", row.workspace_id, row.id))!;
  return c.json({
    data: {
      status: await gscMatonStatus(db, fresh, true),
      verification: { ...verificationStatus(fresh), check: { method: "gsc", ok: check.ok, detail: check.detail } },
    },
  });
});

