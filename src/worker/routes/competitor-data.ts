/**
 * DataForSEO credentials and competitor data (docs/api.md "Competitor data (DataForSEO)").
 *   GET    /workspaces/:wid/dataforseo                      member; DataForSeoCredentialStatus (never the login/password)
 *   PUT    /workspaces/:wid/dataforseo                      owner; body {login, password}; stored AES-GCM encrypted
 *   DELETE /workspaces/:wid/dataforseo                      owner
 *   POST   /workspaces/:wid/dataforseo/test                 member; body {login?, password?}; free GET v3/appendix/user_data
 *   GET    /projects/:pid/competitors/dataforseo            member; CompetitorDataPanel
 *   GET    /projects/:pid/competitors/dataforseo/domains/:domain   member; CompetitorDomainDetail
 *   POST   /projects/:pid/competitors/dataforseo/refresh    owner; body {domain}; 202 CompetitorRefreshResult (paid)
 *   GET    /projects/:pid/competitors/dataforseo/locations  owner; CompetitorLocationOption[] (free endpoint)
 *   PUT    /projects/:pid/competitors/dataforseo/settings   owner; body {location?: {locationCode, languageCode} | null, autoFetch?}
 * State-changing routes go through the global CSRF middleware (app.ts) and are rate-limited. Paid refreshes
 * run after the response (ctx.waitUntil; inline when no execution context exists, e.g. tests).
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app";
import type { DataForSeoCredentialStatus, DataForSeoTestResult } from "@shared/competitor-data";
import type { Db } from "../lib/db";
import { decryptSecret, encryptionConfigured, encryptSecret } from "../lib/crypto";
import { HttpError, badRequest, notFound, setupRequired, unauthorized } from "../lib/errors";
import { newId } from "../lib/ids";
import { iso } from "../lib/time";
import { requireProject, requireWorkspaceMember, requireWorkspaceOwner, type ProjectRow, type SessionUser } from "../platform/access";
import { isMissingTableError } from "../platform/custom-providers";
import {
  DATAFORSEO_CREDENTIAL,
  dataForSeoAad,
  dataForSeoRow,
  joinCredential,
  operatorDataForSeo,
  resolveDataForSeo,
  splitCredential,
} from "../platform/dataforseo-credentials";
import { rateLimit } from "../platform/rate-limit";
import { CREDENTIAL_CHARS, targetDomain, testCredentials, type DataForSeoCredentials } from "../providers/dataforseo";
import {
  DATA_SENT,
  NO_CREDENTIALS,
  apiFetchFor,
  competitorDomainDetail,
  competitorDomains,
  competitorPanel,
  enqueueFetch,
  listLocations,
  loadFetch,
  processFetch,
  projectCompetitors,
  saveSettings,
  toFetchSummary,
} from "../competitors/dataforseo";

export const competitorDataRoutes = new Hono<AppEnv>();

const LABEL = "DataForSEO (competitor data)";
const MIGRATION_PENDING = "Saving DataForSEO credentials needs database migration 0014_dataforseo_competitors.sql to be applied.";

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
  if (!r.success) {
    // Messages only; never echo input values (they may contain the password).
    throw badRequest(r.error.issues[0]?.message ?? "Invalid request.", r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  return r.data;
}

const field = (name: string) =>
  z
    .string()
    .transform((s) => s.trim())
    .pipe(
      z
        .string()
        .min(1, `${name} is required.`)
        .max(200, `${name} is too long.`)
        .regex(CREDENTIAL_CHARS, `${name} contains invalid characters.`),
    );
const loginField = field("API login").pipe(z.string().refine((s) => !s.includes(":"), "API login must not contain ':'."));
const passwordField = field("API password").pipe(z.string().min(4, "API password is too short."));
const putBody = z.object({ login: loginField, password: passwordField }).strict();
const testBody = z.object({ login: loginField.optional(), password: passwordField.optional() }).strict();

const userKey = (prefix: string) => (c: Context<AppEnv>) =>
  `${prefix}:${c.req.param("wid") ?? c.req.param("pid") ?? ""}:${c.get("user")?.id ?? c.req.header("CF-Connecting-IP") ?? "anon"}`;

/** "Credentials accepted. Balance $12.34 at test time." -> 12.34 (our own detail text, never provider text). */
export function balanceFromDetail(detail: string | null): number | null {
  const m = detail ? /Balance \$(-?\d+(?:\.\d+)?)/.exec(detail) : null;
  return m ? Number(m[1]) : null;
}

async function storageReady(db: Db, workspaceId: string): Promise<boolean> {
  try {
    await db.first("SELECT 1 FROM competitor_data_settings WHERE workspace_id = ? LIMIT 1", workspaceId);
    return true;
  } catch (e) {
    if (isMissingTableError(e)) return false;
    throw e;
  }
}

export async function dataForSeoStatus(c: Context<AppEnv>, wid: string): Promise<DataForSeoCredentialStatus> {
  const db = c.get("db");
  const row = await dataForSeoRow(db, wid);
  const operator = operatorDataForSeo(c.env) !== null;
  const source: DataForSeoCredentialStatus["source"] = row ? "workspace_key" : operator ? "operator_key" : "none";
  return {
    provider: "dataforseo",
    label: LABEL,
    source,
    keyHint: row?.key_hint ?? null,
    state: source === "none" ? "setup_required" : row && row.last_test_ok === 0 ? "error" : "ready",
    lastTestedAt: row?.last_tested_at ?? null,
    lastTestOk: row && row.last_test_ok !== null ? row.last_test_ok === 1 : null,
    lastTestDetail: row?.last_test_detail ?? null,
    lastBalanceUsd: row?.last_test_ok === 1 ? balanceFromDetail(row.last_test_detail) : null,
    dataSent: DATA_SENT,
    storageReady: await storageReady(db, wid),
  };
}

// ------------------------------------------------------------------ credentials

competitorDataRoutes.get("/workspaces/:wid/dataforseo", async (c) => {
  const user = userOf(c);
  const wid = c.req.param("wid");
  await requireWorkspaceMember(c.get("db"), user.id, wid);
  return c.json({ data: await dataForSeoStatus(c, wid) });
});

competitorDataRoutes.put("/workspaces/:wid/dataforseo", rateLimit({ key: userKey("dfs_write"), limit: 20, windowSeconds: 60 }), async (c) => {
  const user = userOf(c);
  const wid = c.req.param("wid");
  const db = c.get("db");
  await requireWorkspaceOwner(db, user.id, wid);
  const creds = parseOrThrow(putBody, await jsonBody(c));
  if (!encryptionConfigured(c.env)) throw setupRequired("Server-side encryption is not configured (TOKEN_ENCRYPTION_KEY_V1).");
  const now = iso(c.get("now"));
  const keyEnc = await encryptSecret(c.env, joinCredential(creds), dataForSeoAad(wid));
  try {
    await db.run(
      `INSERT INTO provider_credentials (id, workspace_id, provider, key_enc, key_hint, last_tested_at, last_test_ok, last_test_detail, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
       ON CONFLICT (workspace_id, provider) DO UPDATE SET
         key_enc = excluded.key_enc, key_hint = excluded.key_hint,
         last_tested_at = NULL, last_test_ok = NULL, last_test_detail = NULL, updated_at = excluded.updated_at`,
      newId("cred"),
      wid,
      DATAFORSEO_CREDENTIAL,
      keyEnc,
      creds.password.slice(-4),
      now,
      now,
    );
  } catch (e) {
    if (/CHECK constraint failed/i.test(String((e as Error)?.message ?? e))) throw setupRequired(MIGRATION_PENDING);
    throw e;
  }
  return c.json({ data: await dataForSeoStatus(c, wid) });
});

competitorDataRoutes.delete("/workspaces/:wid/dataforseo", rateLimit({ key: userKey("dfs_write"), limit: 20, windowSeconds: 60 }), async (c) => {
  const user = userOf(c);
  const wid = c.req.param("wid");
  const db = c.get("db");
  await requireWorkspaceOwner(db, user.id, wid);
  await db.run("DELETE FROM provider_credentials WHERE workspace_id = ? AND provider = ?", wid, DATAFORSEO_CREDENTIAL);
  return c.json({ data: { ok: true } });
});

competitorDataRoutes.post("/workspaces/:wid/dataforseo/test", rateLimit({ key: userKey("dfs_test"), limit: 10, windowSeconds: 60 }), async (c) => {
  const user = userOf(c);
  const wid = c.req.param("wid");
  const db = c.get("db");
  await requireWorkspaceMember(db, user.id, wid);
  const body = parseOrThrow(testBody, await jsonBody(c));
  const fetchImpl = apiFetchFor(c.env);
  if (body.login || body.password) {
    if (!body.login || !body.password) throw badRequest("Enter both the API login and the API password to test them.");
    // Typed, unsaved credentials: test them, persist nothing.
    const r: DataForSeoTestResult = await testCredentials(fetchImpl, { login: body.login, password: body.password });
    return c.json({ data: r });
  }
  // Only the workspace's own saved credentials are tested (the operator's account balance is never shown to tenants).
  const row = await dataForSeoRow(db, wid);
  if (!row) throw setupRequired("No DataForSEO credentials are saved for this workspace.");
  let creds: DataForSeoCredentials | null;
  try {
    creds = splitCredential(await decryptSecret(c.env, row.key_enc, dataForSeoAad(wid)));
  } catch {
    creds = null;
  }
  const result: DataForSeoTestResult = creds
    ? await testCredentials(fetchImpl, creds)
    : { ok: false, detail: "Saved credentials could not be decrypted; please re-enter them.", balanceUsd: null };
  await db.run(
    `UPDATE provider_credentials SET last_tested_at = ?, last_test_ok = ?, last_test_detail = ?, updated_at = ?
      WHERE workspace_id = ? AND provider = ?`,
    iso(c.get("now")),
    result.ok === null ? null : result.ok ? 1 : 0,
    result.detail,
    iso(c.get("now")),
    wid,
    DATAFORSEO_CREDENTIAL,
  );
  return c.json({ data: result });
});

// ------------------------------------------------------------------ competitor data

async function projectAccess(c: Context<AppEnv>): Promise<{ user: SessionUser; db: Db; row: ProjectRow; owner: boolean }> {
  const user = userOf(c);
  const db = c.get("db");
  const row = await requireProject(db, user.id, c.req.param("pid") ?? "");
  const { role } = await requireWorkspaceMember(db, user.id, row.workspace_id);
  return { user, db, row, owner: role === "owner" };
}

async function ownerAccess(c: Context<AppEnv>) {
  const a = await projectAccess(c);
  if (!a.owner) await requireWorkspaceOwner(a.db, a.user.id, a.row.workspace_id);
  return a;
}

/** ctx.waitUntil when the Workers execution context exists; undefined otherwise (work is awaited). */
export function backgroundScheduler(c: Context<AppEnv>): ((p: Promise<unknown>) => void) | undefined {
  try {
    const ec = c.executionCtx;
    return (p) => ec.waitUntil(p);
  } catch {
    return undefined;
  }
}

competitorDataRoutes.get("/projects/:pid/competitors/dataforseo", async (c) => {
  const { db, row, owner } = await projectAccess(c);
  return c.json({ data: await competitorPanel(c.env, db, row, owner, c.get("now")) });
});

competitorDataRoutes.get("/projects/:pid/competitors/dataforseo/domains/:domain", async (c) => {
  const { db, row } = await projectAccess(c);
  let detail;
  try {
    detail = await competitorDomainDetail(db, row, c.req.param("domain") ?? "", c.get("now"));
  } catch (e) {
    if (isMissingTableError(e)) throw setupRequired("Competitor data needs database migration 0014_dataforseo_competitors.sql to be applied.");
    throw e;
  }
  if (!detail) throw notFound("Competitor domain");
  return c.json({ data: detail });
});

const refreshBody = z.object({ domain: z.string().trim().min(1).max(253) }).strict();

competitorDataRoutes.post(
  "/projects/:pid/competitors/dataforseo/refresh",
  rateLimit({ key: userKey("dfs_refresh"), limit: 10, windowSeconds: 60 }),
  async (c) => {
    const { user, db, row } = await ownerAccess(c);
    if (row.is_demo === 1) throw badRequest("Competitor data is not fetched for demo projects.");
    const { domain: raw } = parseOrThrow(refreshBody, await jsonBody(c));
    const domain = targetDomain(raw);
    if (!competitorDomains(projectCompetitors(row)).some((d) => d.domain === domain)) throw notFound("Competitor domain");
    let resolved;
    try {
      resolved = await resolveDataForSeo(c.env, db, row.workspace_id);
    } catch {
      throw setupRequired("The saved DataForSEO credentials could not be decrypted; re-enter them on the Integrations page.");
    }
    if (!resolved) throw setupRequired(NO_CREDENTIALS);
    let r;
    try {
      r = await enqueueFetch(db, row, domain, "manual", user.id, c.get("now"));
    } catch (e) {
      if (isMissingTableError(e)) throw setupRequired("Competitor data needs database migration 0014_dataforseo_competitors.sql to be applied.");
      throw e;
    }
    if (r.kind === "capped") throw new HttpError(429, "quota_exceeded", r.message);
    if (r.kind === "existing") return c.json({ data: { fetch: toFetchSummary(r.fetch), existing: true } });
    const work = processFetch(c.env, row.workspace_id, r.fetch.id);
    const schedule = backgroundScheduler(c);
    if (schedule) schedule(work);
    else await work;
    const latest = (await loadFetch(db, row.workspace_id, r.fetch.id)) ?? r.fetch;
    return c.json({ data: { fetch: toFetchSummary(latest), existing: false } }, 202);
  },
);

competitorDataRoutes.get(
  "/projects/:pid/competitors/dataforseo/locations",
  rateLimit({ key: userKey("dfs_locations"), limit: 10, windowSeconds: 60 }),
  async (c) => {
    const { db, row } = await ownerAccess(c);
    let resolved;
    try {
      resolved = await resolveDataForSeo(c.env, db, row.workspace_id);
    } catch {
      throw setupRequired("The saved DataForSEO credentials could not be decrypted; re-enter them on the Integrations page.");
    }
    if (!resolved) throw setupRequired(NO_CREDENTIALS);
    const res = await listLocations(db, row, resolved, apiFetchFor(c.env));
    if (!res.ok) throw new HttpError(502, "provider_error", `Could not load DataForSEO locations: ${res.message}`);
    return c.json({ data: res.locations });
  },
);

const settingsBody = z
  .object({
    location: z.union([z.object({ locationCode: z.number().int().positive(), languageCode: z.string().trim().min(1).max(16) }).strict(), z.null()]).optional(),
    autoFetch: z.boolean().optional(),
  })
  .strict();

competitorDataRoutes.put(
  "/projects/:pid/competitors/dataforseo/settings",
  rateLimit({ key: userKey("dfs_settings"), limit: 20, windowSeconds: 60 }),
  async (c) => {
    const { user, db, row, owner } = await ownerAccess(c);
    const body = parseOrThrow(settingsBody, await jsonBody(c));
    const now = c.get("now");
    try {
      if (body.location) {
        // Validate against DataForSEO's own list (free), so only documented codes are ever stored.
        const resolved = await resolveDataForSeo(c.env, db, row.workspace_id).catch(() => null);
        if (!resolved) throw setupRequired(NO_CREDENTIALS);
        const res = await listLocations(db, row, resolved, apiFetchFor(c.env));
        if (!res.ok) throw new HttpError(502, "provider_error", `Could not load DataForSEO locations: ${res.message}`);
        const loc = res.locations.find((l) => l.locationCode === body.location!.locationCode);
        const lang = loc?.languages.find((l) => l.languageCode.toLowerCase() === body.location!.languageCode.toLowerCase());
        if (!loc || !lang) throw badRequest("Choose a location and language from the DataForSEO list.", { field: "location", reason: "unknown_location" });
        await saveSettings(db, row, { location: { locationCode: loc.locationCode, locationName: loc.locationName, languageCode: lang.languageCode, languageName: lang.languageName }, source: "user", autoFetch: body.autoFetch }, user.id, now);
      } else if (body.location === null || body.autoFetch !== undefined) {
        await saveSettings(db, row, { ...(body.location === null ? { location: null } : {}), autoFetch: body.autoFetch }, user.id, now);
      }
    } catch (e) {
      if (isMissingTableError(e)) throw setupRequired("Competitor data needs database migration 0014_dataforseo_competitors.sql to be applied.");
      throw e;
    }
    return c.json({ data: await competitorPanel(c.env, db, row, owner, now) });
  },
);
