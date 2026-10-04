/**
 * Workspace custom providers (OpenAI-compatible base URL + API key + model id) and the workspace writer
 * source. OWNED BY: platform-auth module (same rules as routes/credentials.ts).
 *   GET    /workspaces/:wid/custom-providers              member -> CustomProvidersResponse (never keys)
 *   POST   /workspaces/:wid/custom-providers              owner  -> body CustomProviderInput; saves (encrypted key) and,
 *                                                                   unless useAsWriter is false, selects it as writer;
 *                                                                   role "geo" adds a custom GEO engine lane instead
 *                                                                   (max 2; never the writer)
 *   PATCH  /workspaces/:wid/custom-providers/:id          owner  -> body {label?, baseUrl?, model?, apiKey?, keepKeyForNewHost?};
 *                                                                   a new host needs a new key, or keepKeyForNewHost: true
 *                                                                   (the owner confirmed sending the saved key there),
 *                                                                   else 400 key_required_for_new_host; a default name
 *                                                                   (the host) follows a new host; every change is
 *                                                                   recorded (migration 0012 change log)
 *   DELETE /workspaces/:wid/custom-providers/:id          owner  -> removes it and its change log (the writer reverts to the default
 *                                                                   when it was selected)
 *   POST   /workspaces/:wid/custom-providers/:id/test     member -> {ok, detail, modelListed}; GET {base}/models with the saved key,
 *                                                                   result recorded (modelListed: is the saved model in the list)
 *   POST   /workspaces/:wid/custom-providers/models       owner  -> body {baseUrl, apiKey} | {providerId}; CustomProviderModelList
 *   PUT    /workspaces/:wid/writer-source                 owner  -> body {source: "default" | "custom:<id>"} (role "writer" rows only)
 *   PUT    /workspaces/:wid/chat-model-source             owner  -> body {source: "writer" | "custom:<id>"} [A36]: Ask Okara's model;
 *                                                                   "writer" (default) = the workspace writer as before;
 *                                                                   custom = a role "chat" provider (POST role "chat",
 *                                                                   max 3, selected unless useAsChat is false)
 * Outbound requests: only the validated provider host is admitted to the guarded API fetch, 10 s timeout,
 * redirects never followed, provider bodies never echoed (only parsed model ids). Keys are decrypted only
 * server-side and never returned or logged.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { ChatModelSource, CustomProviderChange, CustomProviderModelList, CustomProviderRole, CustomProvidersResponse, WriterSource } from "@shared/types";
import type { AppEnv } from "../app";
import type { Env } from "../env";
import type { Db } from "../lib/db";
import { decryptSecret, encryptionConfigured, encryptSecret } from "../lib/crypto";
import { badRequest, conflict, notFound, setupRequired, unauthorized } from "../lib/errors";
import { newId } from "../lib/ids";
import { iso } from "../lib/time";
import { requireWorkspaceMember, requireWorkspaceOwner, type SessionUser } from "../platform/access";
import {
  MAX_CUSTOM_CHAT_PROVIDERS,
  MAX_CUSTOM_GEO_ENGINES,
  isMissingChatColumnError,
  isPreChatSchemaError,
  MAX_CUSTOM_PROVIDERS,
  isMissingRoleColumnError,
  withRoleColumns,
  cleanLabel,
  cleanModelId,
  customProviderAad,
  customProviderChangeStatement,
  fetchModelList,
  isMissingTableError,
  listCustomProviderChanges,
  listCustomProviders,
  testCustomProvider,
  toCustomProviderStatus,
  validateCustomBaseUrl,
  type CustomProviderChangeField,
  type CustomProviderRow,
  type CustomProviderTestResult,
} from "../platform/custom-providers";
import { rateLimit } from "../platform/rate-limit";
import { createApiFetch } from "../runs/runtime";
import { DATA_SENT, jsonBody, keySchema } from "./credentials";

export const CUSTOM_WRITER_DATA_SENT = `${DATA_SENT.writer} It goes only to the custom provider's base URL (host shown on the card), as an OpenAI-compatible Chat Completions request with JSON-schema output and no tools or web search.`;

export const CUSTOM_GEO_DATA_SENT =
  "Your approved GEO prompt text and locale/language only, as an OpenAI-compatible Chat Completions request with no tools, to the custom provider's base URL (host shown on the card). No site content, Search Console data, context documents, or credentials.";

export const CUSTOM_CHAT_DATA_SENT =
  "Your Ask Okara conversation (your messages and the results of the tools it runs on this project's stored data, such as Search Console, crawl, recommendation and GEO results) plus the tool definitions, as an OpenAI-compatible Chat Completions request with function tools, only to the custom provider's base URL (host shown on the card). Never API keys or credentials.";

const CHAT_MIGRATION_PENDING = "Ask Okara chat models need database migration 0019_custom_provider_chat_role.sql to be applied.";
const MIGRATION_PENDING = "Custom providers need database migration 0010_workspace_custom_providers.sql to be applied.";
const GEO_MIGRATION_PENDING = "Custom GEO engines need database migration 0011_workspace_models_custom_geo.sql to be applied.";

// ------------------------------------------------------------------ outbound fetch

let testFetch: typeof fetch | null = null;
/** Test hook: replace the platform fetch under the guarded API fetch (tests must never hit the network). */
export function setCustomProviderFetch(f: typeof fetch | null) {
  testFetch = f;
}
const platformFetch: typeof fetch = (input, init) => (testFetch ?? fetch)(input, init);
/** Guarded API fetch with only this provider's host added to the allowlist. */
const providerFetch = (env: Env, host: string) => createApiFetch(env, platformFetch, [host]);

// ------------------------------------------------------------------ helpers

function userOf(c: Context<AppEnv>): SessionUser {
  const u = c.get("user");
  if (!u) throw unauthorized();
  return u;
}

/** 400 naming the field, never echoing the value (it may be a key). */
const fieldError = (field: string, reason: string, message: string) => badRequest(message, { field, reason });

async function tableGuard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isMissingTableError(e)) throw setupRequired(MIGRATION_PENDING);
    throw e;
  }
}

function objectBody(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw badRequest("Request body must be a JSON object.");
  return raw as Record<string, unknown>;
}

function onlyKeys(o: Record<string, unknown>, allowed: string[]) {
  const extra = Object.keys(o).find((k) => !allowed.includes(k));
  if (extra !== undefined) throw badRequest(`Unknown field "${extra.slice(0, 40)}".`, { field: extra.slice(0, 40), reason: "unknown_field" });
}

function parseKey(raw: unknown): string {
  const r = keySchema.safeParse(raw);
  if (!r.success) throw fieldError("apiKey", "invalid_key", r.error.issues[0]?.message ?? "Invalid API key.");
  return r.data;
}

function parseBaseUrl(env: Env, raw: unknown): { baseUrl: string; host: string } {
  const check = validateCustomBaseUrl(raw, env.APP_ORIGIN);
  if (!check.ok) throw fieldError("baseUrl", check.reason, check.message);
  return { baseUrl: check.baseUrl, host: check.host };
}

function parseModel(raw: unknown): string {
  const model = cleanModelId(raw);
  if (!model) throw fieldError("model", "invalid_model", "Choose a model, or type a model id (1-200 characters, no control characters).");
  return model;
}

function parseLabel(raw: unknown, fallback: string): string {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "string") throw fieldError("label", "invalid_label", "Label must be text.");
  return cleanLabel(raw) ?? fallback;
}

async function responseFor(db: Db, workspaceId: string, canManage: boolean): Promise<CustomProvidersResponse> {
  const rows = await tableGuard(() => listCustomProviders(db, workspaceId));
  const changes = rows.length > 0 ? await listCustomProviderChanges(db, workspaceId) : new Map<string, CustomProviderChange[]>();
  const writer = rows.find((r) => r.is_writer === 1 && r.role !== "chat" && r.role !== "geo");
  const chat = rows.find((r) => r.is_chat === 1 && r.role === "chat");
  return {
    providers: rows.map((r) => toCustomProviderStatus(r, changes.get(r.id) ?? [])),
    writerSource: writer ? `custom:${writer.id}` : "default",
    maxProviders: MAX_CUSTOM_PROVIDERS,
    canManage,
    dataSent: CUSTOM_WRITER_DATA_SENT,
    maxGeoEngines: MAX_CUSTOM_GEO_ENGINES,
    geoDataSent: CUSTOM_GEO_DATA_SENT,
    chatSource: chat ? `custom:${chat.id}` : "writer",
    maxChatProviders: MAX_CUSTOM_CHAT_PROVIDERS,
    chatDataSent: CUSTOM_CHAT_DATA_SENT,
  };
}

async function loadRow(db: Db, workspaceId: string, id: string | undefined): Promise<CustomProviderRow & { key_enc: string }> {
  if (!id || id.length > 100) throw notFound("Custom provider");
  const row = await tableGuard(() =>
    withRoleColumns((cols) =>
      db.first<CustomProviderRow & { key_enc: string }>(
        `SELECT ${cols}, key_enc FROM workspace_custom_providers WHERE workspace_id = ? AND id = ?`,
        workspaceId,
        id,
      ),
    ),
  );
  if (!row) throw notFound("Custom provider");
  return row;
}

/** Select `id` as the workspace writer (or none). Two statements in one batch: the partial unique index allows one writer. */
async function selectWriter(db: Db, workspaceId: string, id: string | null, now: string) {
  const stmts: Array<[string, ...unknown[]]> = [
    ["UPDATE workspace_custom_providers SET is_writer = 0, updated_at = ? WHERE workspace_id = ? AND is_writer = 1", now, workspaceId],
  ];
  if (id) stmts.push(["UPDATE workspace_custom_providers SET is_writer = 1, updated_at = ? WHERE workspace_id = ? AND id = ?", now, workspaceId, id]);
  await db.batch(stmts);
}

/**
 * Select `id` (a role 'chat' row) as Ask Okara's chat model, or none (null: the workspace writer). One batch: the
 * partial unique index allows one chat model. Before migration 0019 there are no chat rows, so "none" is a no-op.
 */
async function selectChat(db: Db, workspaceId: string, id: string | null, now: string) {
  const stmts: Array<[string, ...unknown[]]> = [
    ["UPDATE workspace_custom_providers SET is_chat = 0, updated_at = ? WHERE workspace_id = ? AND is_chat = 1", now, workspaceId],
  ];
  if (id) stmts.push(["UPDATE workspace_custom_providers SET is_chat = 1, updated_at = ? WHERE workspace_id = ? AND id = ? AND role = 'chat'", now, workspaceId, id]);
  try {
    await db.batch(stmts);
  } catch (e) {
    if (!id && isMissingChatColumnError(e)) return;
    if (isMissingChatColumnError(e)) throw setupRequired(CHAT_MIGRATION_PENDING);
    throw e;
  }
}

/** Decrypt a saved key; null when it cannot be decrypted (e.g. the encryption key was rotated away). */
async function savedKey(env: Env, row: { id: string; workspace_id: string; key_enc: string }): Promise<string | null> {
  try {
    return await decryptSecret(env, row.key_enc, customProviderAad(row.workspace_id, row.id));
  } catch {
    return null;
  }
}

const userBucket = (prefix: string) => (c: Context<AppEnv>) =>
  `${prefix}:${c.req.param("wid") ?? ""}:${c.get("user")?.id ?? c.req.header("CF-Connecting-IP") ?? "anon"}`;

// ------------------------------------------------------------------ routes

export const customProviderRoutes = new Hono<AppEnv>();

customProviderRoutes.get("/workspaces/:wid/custom-providers", async (c) => {
  const user = userOf(c);
  const wid = c.req.param("wid");
  const db = c.get("db");
  const { role } = await requireWorkspaceMember(db, user.id, wid);
  return c.json({ data: await responseFor(db, wid, role === "owner") });
});

customProviderRoutes.post(
  "/workspaces/:wid/custom-providers/models",
  rateLimit({ key: userBucket("cprov_models"), limit: 10, windowSeconds: 60 }),
  async (c) => {
    const user = userOf(c);
    const wid = c.req.param("wid");
    const db = c.get("db");
    await requireWorkspaceOwner(db, user.id, wid);
    const body = objectBody(await jsonBody(c));
    let target: { baseUrl: string; host: string; key: string };
    if ("providerId" in body) {
      // Re-use a saved provider: its stored key is only ever sent to its stored host.
      onlyKeys(body, ["providerId"]);
      const row = await loadRow(db, wid, typeof body.providerId === "string" ? body.providerId : undefined);
      const check = validateCustomBaseUrl(row.base_url, c.env.APP_ORIGIN);
      if (!check.ok || check.host !== row.host) {
        return c.json({ data: { ok: false, detail: "The saved base URL is no longer accepted; re-enter it.", models: [], total: 0, truncated: false } satisfies CustomProviderModelList });
      }
      const key = await savedKey(c.env, row);
      if (key === null) {
        return c.json({ data: { ok: false, detail: "Saved key could not be decrypted; please re-enter it.", models: [], total: 0, truncated: false } satisfies CustomProviderModelList });
      }
      target = { baseUrl: check.baseUrl, host: check.host, key };
    } else {
      onlyKeys(body, ["baseUrl", "apiKey"]);
      const { baseUrl, host } = parseBaseUrl(c.env, body.baseUrl);
      target = { baseUrl, host, key: parseKey(body.apiKey) };
    }
    const result = await fetchModelList(providerFetch(c.env, target.host), target.baseUrl, target.key);
    return c.json({ data: result satisfies CustomProviderModelList });
  },
);

customProviderRoutes.post(
  "/workspaces/:wid/custom-providers",
  rateLimit({ key: userBucket("cprov_write"), limit: 20, windowSeconds: 60 }),
  async (c) => {
    const user = userOf(c);
    const wid = c.req.param("wid");
    const db = c.get("db");
    await requireWorkspaceOwner(db, user.id, wid);
    const body = objectBody(await jsonBody(c));
    onlyKeys(body, ["label", "baseUrl", "model", "apiKey", "useAsWriter", "useAsChat", "role"]);
    if (body.role !== undefined && body.role !== "writer" && body.role !== "geo" && body.role !== "chat") throw fieldError("role", "invalid", 'role must be "writer", "geo" or "chat".');
    const role: CustomProviderRole = body.role === "geo" ? "geo" : body.role === "chat" ? "chat" : "writer";
    const { baseUrl, host } = parseBaseUrl(c.env, body.baseUrl);
    const apiKey = parseKey(body.apiKey);
    const model = parseModel(body.model);
    const label = parseLabel(body.label, host);
    if (body.useAsWriter !== undefined && typeof body.useAsWriter !== "boolean") throw fieldError("useAsWriter", "invalid", "useAsWriter must be true or false.");
    if (body.useAsChat !== undefined && typeof body.useAsChat !== "boolean") throw fieldError("useAsChat", "invalid", "useAsChat must be true or false.");
    if (body.useAsChat !== undefined && role !== "chat") throw fieldError("useAsChat", "invalid", 'useAsChat applies to role "chat" only.');
    if (!encryptionConfigured(c.env)) throw setupRequired("Server-side encryption is not configured (TOKEN_ENCRYPTION_KEY_V1).");

    const id = newId("cprov");
    const now = iso(c.get("now"));
    const keyEnc = await encryptSecret(c.env, apiKey, customProviderAad(wid, id));
    const cap = role === "geo" ? MAX_CUSTOM_GEO_ENGINES : role === "chat" ? MAX_CUSTOM_CHAT_PROVIDERS : MAX_CUSTOM_PROVIDERS;
    // One statement checks the per-workspace, per-role cap and inserts, so concurrent saves cannot exceed it.
    const values = [id, wid, label, baseUrl, host, model, keyEnc, apiKey.slice(-4), now, now, wid, cap];
    let r: { changes: number };
    try {
      r = await tableGuard(() =>
        db.run(
          `INSERT INTO workspace_custom_providers (id, workspace_id, role, label, base_url, host, model, key_enc, key_hint, is_writer, created_at, updated_at)
           SELECT ?, ?, '${role}', ?, ?, ?, ?, ?, ?, 0, ?, ?
            WHERE (SELECT COUNT(*) FROM workspace_custom_providers WHERE workspace_id = ? AND role = '${role}') < ?`,
          ...values,
        ),
      );
    } catch (e) {
      // Before migration 0019 the role CHECK refuses 'chat'.
      if (role === "chat" && (isPreChatSchemaError(e) || isMissingRoleColumnError(e))) throw setupRequired(CHAT_MIGRATION_PENDING);
      if (!isMissingRoleColumnError(e)) throw e;
      // Before migration 0011 every row is a writer; GEO engines need the role column.
      if (role === "geo") throw setupRequired(GEO_MIGRATION_PENDING);
      r = await db.run(
        `INSERT INTO workspace_custom_providers (id, workspace_id, label, base_url, host, model, key_enc, key_hint, is_writer, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?
          WHERE (SELECT COUNT(*) FROM workspace_custom_providers WHERE workspace_id = ?) < ?`,
        ...values,
      );
    }
    if (r.changes !== 1) {
      throw conflict(
        role === "geo"
          ? `A workspace can have at most ${MAX_CUSTOM_GEO_ENGINES} custom GEO engines; remove one first.`
          : role === "chat"
            ? `A workspace can have at most ${MAX_CUSTOM_CHAT_PROVIDERS} Ask Okara chat models; remove one first.`
            : `A workspace can have at most ${MAX_CUSTOM_PROVIDERS} custom providers; remove one first.`,
      );
    }
    if (role === "writer" && body.useAsWriter !== false) await selectWriter(db, wid, id, now);
    if (role === "chat" && body.useAsChat !== false) await selectChat(db, wid, id, now);
    return c.json({ data: await responseFor(db, wid, true) }, 201);
  },
);

/** True when the change-log table (migration 0012) is missing; the change itself then proceeds unlogged. */
const isMissingChangeLog = (e: unknown) => /no such table:?\s*"?workspace_custom_provider_changes\b/i.test(String((e as Error)?.message ?? e));

customProviderRoutes.patch(
  "/workspaces/:wid/custom-providers/:id",
  rateLimit({ key: userBucket("cprov_write"), limit: 20, windowSeconds: 60 }),
  async (c) => {
    const user = userOf(c);
    const wid = c.req.param("wid");
    const db = c.get("db");
    await requireWorkspaceOwner(db, user.id, wid);
    const row = await loadRow(db, wid, c.req.param("id"));
    const body = objectBody(await jsonBody(c));
    onlyKeys(body, ["label", "baseUrl", "model", "apiKey", "keepKeyForNewHost"]);
    if (body.keepKeyForNewHost !== undefined && typeof body.keepKeyForNewHost !== "boolean") {
      throw fieldError("keepKeyForNewHost", "invalid", "keepKeyForNewHost must be true or false.");
    }
    const next = { baseUrl: row.base_url, host: row.host, model: row.model, label: row.label };
    if (body.baseUrl !== undefined) Object.assign(next, parseBaseUrl(c.env, body.baseUrl));
    if (body.model !== undefined) next.model = parseModel(body.model);
    if (body.label !== undefined) next.label = parseLabel(body.label, next.host);
    const apiKey = body.apiKey !== undefined ? parseKey(body.apiKey) : null;
    const hostChanged = next.host !== row.host;
    // A provider saved without a name is labelled with its host; after a move (tunnels rotate hosts) that
    // default name follows the new host instead of naming the old one. A name the owner chose is kept, and a
    // label sent unchanged (older clients resend the prefilled name) counts as no label.
    if (hostChanged && row.label === row.host && next.label === row.label) {
      next.label = next.host;
    }
    // A saved key is only sent to a new host when the owner says so (tunnel hosts change on every restart);
    // never silently. The flag is ignored when the host is unchanged or a new key is given.
    let keyKeptForNewHost = false;
    if (hostChanged && apiKey === null) {
      if (body.keepKeyForNewHost !== true) {
        throw fieldError(
          "apiKey",
          "key_required_for_new_host",
          "The new base URL is on a different host. Re-enter the API key, or confirm sending the saved key to the new host; a saved key is never sent to a new host without that confirmation.",
        );
      }
      // The AAD binds workspace and row, not the host: the kept envelope stays valid as is. Make sure it can
      // still be decrypted, so the owner is not told the key moved when it is unusable.
      if ((await savedKey(c.env, row)) === null) {
        throw fieldError("apiKey", "key_unreadable", "The saved API key could not be decrypted; re-enter it to use the new host.");
      }
      keyKeptForNewHost = true;
    }
    const now = iso(c.get("now"));
    let keyEnc = row.key_enc;
    let keyHint = row.key_hint;
    if (apiKey !== null) {
      if (!encryptionConfigured(c.env)) throw setupRequired("Server-side encryption is not configured (TOKEN_ENCRYPTION_KEY_V1).");
      keyEnc = await encryptSecret(c.env, apiKey, customProviderAad(wid, row.id));
      keyHint = apiKey.slice(-4);
    }
    const fields: CustomProviderChangeField[] = [];
    if (next.label !== row.label) fields.push("label");
    if (next.baseUrl !== row.base_url) fields.push("baseUrl");
    if (next.model !== row.model) fields.push("model");
    if (apiKey !== null) fields.push("apiKey");
    const configChanged = apiKey !== null || next.baseUrl !== row.base_url || next.model !== row.model;
    const update: [string, ...unknown[]] = [
      `UPDATE workspace_custom_providers
          SET label = ?, base_url = ?, host = ?, model = ?, key_enc = ?, key_hint = ?, updated_at = ?,
              last_tested_at = CASE WHEN ? THEN NULL ELSE last_tested_at END,
              last_test_ok = CASE WHEN ? THEN NULL ELSE last_test_ok END,
              last_test_detail = CASE WHEN ? THEN NULL ELSE last_test_detail END
        WHERE workspace_id = ? AND id = ?`,
      next.label,
      next.baseUrl,
      next.host,
      next.model,
      keyEnc,
      keyHint,
      now,
      configChanged ? 1 : 0,
      configChanged ? 1 : 0,
      configChanged ? 1 : 0,
      wid,
      row.id,
    ];
    if (fields.length === 0) {
      await db.run(...update);
    } else {
      const urlChanged = fields.includes("baseUrl");
      const change = customProviderChangeStatement(newId("cpchg"), {
        workspaceId: wid,
        providerId: row.id,
        changedBy: user.id,
        changedAt: now,
        fields,
        from: urlChanged ? { baseUrl: row.base_url, host: row.host } : null,
        to: urlChanged ? { baseUrl: next.baseUrl, host: next.host } : null,
        keyKeptForNewHost,
      });
      // One transaction: the change and its audit entry land together.
      try {
        await db.batch([update, change]);
      } catch (e) {
        if (!isMissingChangeLog(e)) throw e;
        await db.run(...update); // before migration 0012: the change still applies, unlogged
      }
    }
    return c.json({ data: await responseFor(db, wid, true) });
  },
);

customProviderRoutes.delete(
  "/workspaces/:wid/custom-providers/:id",
  rateLimit({ key: userBucket("cprov_write"), limit: 20, windowSeconds: 60 }),
  async (c) => {
    const user = userOf(c);
    const wid = c.req.param("wid");
    const db = c.get("db");
    await requireWorkspaceOwner(db, user.id, wid);
    const row = await loadRow(db, wid, c.req.param("id"));
    const remove: [string, ...unknown[]] = ["DELETE FROM workspace_custom_providers WHERE workspace_id = ? AND id = ?", wid, row.id];
    try {
      // The provider's change log goes with it (no foreign key on provider_id, see migration 0012).
      await db.batch([["DELETE FROM workspace_custom_provider_changes WHERE workspace_id = ? AND provider_id = ?", wid, row.id], remove]);
    } catch (e) {
      if (!isMissingChangeLog(e)) throw e;
      await db.run(...remove);
    }
    return c.json({ data: await responseFor(db, wid, true) });
  },
);

customProviderRoutes.post(
  "/workspaces/:wid/custom-providers/:id/test",
  rateLimit({ key: userBucket("cprov_test"), limit: 10, windowSeconds: 60 }),
  async (c) => {
    const user = userOf(c);
    const wid = c.req.param("wid");
    const db = c.get("db");
    await requireWorkspaceMember(db, user.id, wid);
    const row = await loadRow(db, wid, c.req.param("id"));
    let result: CustomProviderTestResult;
    const check = validateCustomBaseUrl(row.base_url, c.env.APP_ORIGIN);
    if (!check.ok || check.host !== row.host) result = { ok: false, detail: "The saved base URL is no longer accepted; re-enter it.", modelListed: null };
    else {
      const key = await savedKey(c.env, row);
      result =
        key === null
          ? { ok: false, detail: "Saved key could not be decrypted; please re-enter it.", modelListed: null }
          : await testCustomProvider(providerFetch(c.env, check.host), check.baseUrl, key, row.model, row.role === "geo" ? "the first GEO run" : row.role === "chat" ? "the first Ask Okara message" : "the first draft");
    }
    const now = iso(c.get("now"));
    await db.run(
      `UPDATE workspace_custom_providers SET last_tested_at = ?, last_test_ok = ?, last_test_detail = ?
        WHERE workspace_id = ? AND id = ?`,
      now,
      result.ok === null ? null : result.ok ? 1 : 0,
      result.detail,
      wid,
      row.id,
    );
    return c.json({ data: result });
  },
);

const writerSourceBody = z.object({ source: z.string().max(120) }).strict();

customProviderRoutes.put(
  "/workspaces/:wid/writer-source",
  rateLimit({ key: userBucket("cprov_write"), limit: 20, windowSeconds: 60 }),
  async (c) => {
    const user = userOf(c);
    const wid = c.req.param("wid");
    const db = c.get("db");
    await requireWorkspaceOwner(db, user.id, wid);
    const parsed = writerSourceBody.safeParse(await jsonBody(c));
    if (!parsed.success) throw fieldError("source", "invalid", 'source must be "default" or "custom:<id>".');
    const source = parsed.data.source as WriterSource;
    const now = iso(c.get("now"));
    if (source === "default") {
      await tableGuard(() => selectWriter(db, wid, null, now));
    } else if (source.startsWith("custom:")) {
      const row = await loadRow(db, wid, source.slice("custom:".length));
      // A custom GEO engine is never the writer (its key was entered for answer sampling only).
      if (row.role === "geo") throw fieldError("source", "not_writer", "This custom provider is a GEO engine, not a writer; add it as a writer to use it for drafting.");
      if (row.role === "chat") throw fieldError("source", "not_writer", "This custom provider is an Ask Okara chat model, not a writer; add it as a writer to use it for drafting.");
      await selectWriter(db, wid, row.id, now);
    } else {
      throw fieldError("source", "invalid", 'source must be "default" or "custom:<id>".');
    }
    return c.json({ data: await responseFor(db, wid, true) });
  },
);

const chatSourceBody = z.object({ source: z.string().max(120) }).strict();

/** [A36] Ask Okara's model: the workspace writer (default) or a role 'chat' custom provider. Owner only. */
customProviderRoutes.put(
  "/workspaces/:wid/chat-model-source",
  rateLimit({ key: userBucket("cprov_write"), limit: 20, windowSeconds: 60 }),
  async (c) => {
    const user = userOf(c);
    const wid = c.req.param("wid");
    const db = c.get("db");
    await requireWorkspaceOwner(db, user.id, wid);
    const parsed = chatSourceBody.safeParse(await jsonBody(c));
    if (!parsed.success) throw fieldError("source", "invalid", 'source must be "writer" or "custom:<id>".');
    const source = parsed.data.source as ChatModelSource;
    const now = iso(c.get("now"));
    if (source === "writer") {
      await tableGuard(() => selectChat(db, wid, null, now));
    } else if (source.startsWith("custom:")) {
      const row = await loadRow(db, wid, source.slice("custom:".length));
      // Only a provider added for Ask Okara (its key was entered for chat) is ever the chat model.
      if (row.role !== "chat") {
        throw fieldError("source", "not_chat", "This custom provider is not an Ask Okara chat model; add it under Integrations → Ask Okara chat model to use it for the chat.");
      }
      await selectChat(db, wid, row.id, now);
    } else {
      throw fieldError("source", "invalid", 'source must be "writer" or "custom:<id>".');
    }
    return c.json({ data: await responseFor(db, wid, true) });
  },
);
