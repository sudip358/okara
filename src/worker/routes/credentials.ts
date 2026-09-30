/**
 * Workspace provider credentials (bring-your-own keys). OWNED BY: platform-auth module.
 *   GET    /workspaces/:wid/credentials                 -> IntegrationsStatus["providers"] (never keys)
 *   PUT    /workspaces/:wid/credentials/:provider       -> owner only; body {apiKey}; stored AES-GCM encrypted
 *   POST   /workspaces/:wid/credentials/:provider/test  -> body {apiKey?}; free, non-inference test call
 *   DELETE /workspaces/:wid/credentials/:provider       -> owner only
 * Keys are decrypted only server-side, never returned, and never logged.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app";
import type { Env } from "../env";
import type { CapabilityState, IntegrationsStatus, ProviderId } from "@shared/types";
import type { Db } from "../lib/db";
import { decryptSecret, encryptionConfigured, encryptSecret } from "../lib/crypto";
import { badRequest, notFound, setupRequired, unauthorized } from "../lib/errors";
import { newId } from "../lib/ids";
import { iso } from "../lib/time";
import { requireWorkspaceMember, requireWorkspaceOwner, type SessionUser } from "../platform/access";
import { credentialAad } from "../platform/credentials";
import { rateLimit } from "../platform/rate-limit";

export type ProviderStatus = IntegrationsStatus["providers"][number];

export const PROVIDERS: readonly ProviderId[] = ["typesafe", "gemini", "perplexity", "writer"];

const OPERATOR_KEY_ENV: Record<ProviderId, keyof Env> = {
  typesafe: "TYPESAFE_API_KEY",
  gemini: "GEMINI_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
  writer: "WRITER_API_KEY",
};

const MODEL_ENV: Record<ProviderId, keyof Env> = {
  typesafe: "TYPESAFE_MODEL",
  gemini: "GEMINI_MODEL",
  perplexity: "PERPLEXITY_MODEL",
  writer: "WRITER_MODEL",
};

/** Disclosure shown next to each provider: what project data is sent to it. */
export const DATA_SENT: Record<ProviderId, string> = {
  typesafe:
    "Narrow typed decision questions with compact evidence excerpts: page URLs, titles and short text spans from your verified site, Search Console aggregates, and spans of AI answers. No credentials or Google tokens.",
  gemini:
    "Your approved GEO prompt text and locale/language. No site content, Search Console data, context documents, or credentials.",
  perplexity:
    "Your approved GEO prompt text and locale/language. No site content, Search Console data, context documents, or credentials.",
  writer:
    "Stored evidence for the recommendation being drafted (page excerpts, metrics, AI-answer spans), your confirmed context documents (product, positioning, competitors, voice), and brand and competitor names. No credentials, Google tokens, or raw Search Console exports.",
};

function envStr(env: Env, key: keyof Env): string | null {
  const v = env[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function writerProvider(env: Env): "anthropic" | "openai_compatible" | null {
  const v = envStr(env, "WRITER_PROVIDER");
  return v === "anthropic" || v === "openai_compatible" ? v : null;
}

function providerLabel(env: Env, provider: ProviderId): string {
  switch (provider) {
    case "typesafe":
      return "TypeSafe (Jev decisions)";
    case "gemini":
      return "Google Gemini";
    case "perplexity":
      return "Perplexity";
    case "writer": {
      const wp = writerProvider(env);
      return wp === "anthropic" ? "Writer (Anthropic)" : wp === "openai_compatible" ? "Writer (OpenAI-compatible)" : "Writer";
    }
  }
}

interface CredentialRow {
  provider: ProviderId;
  key_hint: string;
  last_tested_at: string | null;
  last_test_ok: number | null;
  last_test_detail: string | null;
}

/** Status of every provider for a workspace. Exported for routes/integrations.ts. Never includes keys. */
export async function listProviderStatuses(env: Env, db: Db, workspaceId: string): Promise<ProviderStatus[]> {
  const rows = await db.all<CredentialRow>(
    "SELECT provider, key_hint, last_tested_at, last_test_ok, last_test_detail FROM provider_credentials WHERE workspace_id = ?",
    workspaceId,
  );
  const byProvider = new Map(rows.map((r) => [r.provider, r]));
  return PROVIDERS.map((p) => statusFor(env, p, byProvider.get(p) ?? null));
}

function statusFor(env: Env, provider: ProviderId, row: CredentialRow | null): ProviderStatus {
  const operatorKey = envStr(env, OPERATOR_KEY_ENV[provider]);
  const source: ProviderStatus["source"] = row ? "workspace_key" : operatorKey ? "operator_key" : "none";
  const model = envStr(env, MODEL_ENV[provider]);
  const configured = model !== null && (provider !== "writer" || writerProvider(env) !== null);
  let state: CapabilityState;
  if (source === "none" || !configured) state = "setup_required";
  else if (row && row.last_test_ok === 0) state = "error";
  else state = "ready";
  return {
    provider,
    label: providerLabel(env, provider),
    source,
    keyHint: row?.key_hint ?? null,
    state,
    lastTestedAt: row?.last_tested_at ?? null,
    lastTestOk: row && row.last_test_ok !== null ? row.last_test_ok === 1 : null,
    lastTestDetail: row?.last_test_detail ?? null,
    model,
    dataSent: DATA_SENT[provider],
  };
}

// ------------------------------------------------------------------ provider test calls

let testFetch: typeof fetch | null = null;
/** Test hook: replace the outbound fetch used for key tests (tests must never hit the network). */
export function setCredentialTestFetch(f: typeof fetch | null) {
  testFetch = f;
}
const outboundFetch: typeof fetch = (input, init) => (testFetch ?? fetch)(input, init);

export interface KeyTestResult {
  ok: boolean | null;
  detail: string;
}

const NO_FREE_ENDPOINT = "No free test endpoint; key saved and will be validated on first run.";

/** Free, non-inference request per provider. The key goes only in a request header, never in the URL. */
export async function testProviderKey(env: Env, provider: ProviderId, apiKey: string): Promise<KeyTestResult> {
  let url: string;
  let headers: Record<string, string>;
  switch (provider) {
    case "typesafe":
      url = "https://api.typesafe.ai/v1/models";
      headers = { Authorization: `Bearer ${apiKey}` };
      break;
    case "gemini":
      url = "https://generativelanguage.googleapis.com/v1beta/models";
      headers = { "x-goog-api-key": apiKey };
      break;
    case "perplexity":
      return { ok: null, detail: NO_FREE_ENDPOINT };
    case "writer": {
      const wp = writerProvider(env);
      if (wp === "anthropic") {
        url = "https://api.anthropic.com/v1/models";
        headers = { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
      } else if (wp === "openai_compatible") {
        const base = envStr(env, "WRITER_BASE_URL");
        let parsed: URL | null = null;
        try {
          parsed = base ? new URL(base) : null;
        } catch {
          parsed = null;
        }
        if (!parsed || parsed.protocol !== "https:" || parsed.username || parsed.password) {
          return { ok: null, detail: "Writer base URL is not configured (WRITER_BASE_URL must be an https URL)." };
        }
        url = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}/models`;
        headers = { Authorization: `Bearer ${apiKey}` };
      } else {
        return { ok: null, detail: "Writer provider is not configured (set WRITER_PROVIDER to anthropic or openai_compatible)." };
      }
      break;
    }
  }
  let res: Response;
  try {
    res = await outboundFetch(url, {
      method: "GET",
      headers: { ...headers, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, detail: "Could not reach the provider (network error or timeout)." };
  }
  // Never echo the provider's response body: it is untrusted and could reflect request data.
  await res.body?.cancel().catch(() => undefined);
  if (res.ok) return { ok: true, detail: "Key accepted (model list request succeeded)." };
  if (res.status === 401 || res.status === 403) return { ok: false, detail: `Key rejected by provider (HTTP ${res.status}).` };
  if (res.status === 429) return { ok: null, detail: "Provider rate-limited the test request; key not confirmed. Try again later." };
  return { ok: false, detail: `Provider returned HTTP ${res.status}.` };
}

// ------------------------------------------------------------------ routes

export const credentialRoutes = new Hono<AppEnv>();

const keySchema = z
  .string()
  .transform((s) => s.trim())
  .pipe(
    z
      .string()
      .min(8, "API key is too short.")
      .max(400, "API key is too long.")
      .regex(/^[\x21-\x7e]+$/, "API key contains invalid characters."),
  );
const putBody = z.object({ apiKey: keySchema }).strict();
const testBody = z.object({ apiKey: keySchema.optional() }).strict();

function userOf(c: Context<AppEnv>): SessionUser {
  const u = c.get("user");
  if (!u) throw unauthorized();
  return u;
}

function providerParam(c: Context<AppEnv>): ProviderId {
  const p = c.req.param("provider");
  if (!p || !(PROVIDERS as readonly string[]).includes(p)) throw notFound("Provider");
  return p as ProviderId;
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
    // Report messages only; never echo input values (they may contain the key).
    throw badRequest(r.error.issues[0]?.message ?? "Invalid request.", r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  return r.data;
}

async function rowFor(db: Db, workspaceId: string, provider: ProviderId) {
  return db.first<CredentialRow & { key_enc: string }>(
    "SELECT provider, key_enc, key_hint, last_tested_at, last_test_ok, last_test_detail FROM provider_credentials WHERE workspace_id = ? AND provider = ?",
    workspaceId,
    provider,
  );
}

const workspaceUserKey = (c: Context<AppEnv>) => `cred_test:${c.req.param("wid") ?? ""}:${c.get("user")?.id ?? c.req.header("CF-Connecting-IP") ?? "anon"}`;
const workspaceWriteKey = (c: Context<AppEnv>) => `cred_write:${c.req.param("wid") ?? ""}:${c.get("user")?.id ?? c.req.header("CF-Connecting-IP") ?? "anon"}`;

credentialRoutes.get("/workspaces/:wid/credentials", async (c) => {
  const user = userOf(c);
  const wid = c.req.param("wid");
  const db = c.get("db");
  await requireWorkspaceMember(db, user.id, wid);
  return c.json({ data: await listProviderStatuses(c.env, db, wid) });
});

credentialRoutes.put(
  "/workspaces/:wid/credentials/:provider",
  rateLimit({ key: workspaceWriteKey, limit: 20, windowSeconds: 60 }),
  async (c) => {
    const user = userOf(c);
    const wid = c.req.param("wid");
    const db = c.get("db");
    await requireWorkspaceOwner(db, user.id, wid);
    const provider = providerParam(c);
    const { apiKey } = parseOrThrow(putBody, await jsonBody(c));
    if (!encryptionConfigured(c.env)) throw setupRequired("Server-side encryption is not configured (TOKEN_ENCRYPTION_KEY_V1).");
    const now = iso(c.get("now"));
    const keyEnc = await encryptSecret(c.env, apiKey, credentialAad(wid, provider));
    const hint = apiKey.slice(-4);
    await db.run(
      `INSERT INTO provider_credentials (id, workspace_id, provider, key_enc, key_hint, last_tested_at, last_test_ok, last_test_detail, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
       ON CONFLICT (workspace_id, provider) DO UPDATE SET
         key_enc = excluded.key_enc, key_hint = excluded.key_hint,
         last_tested_at = NULL, last_test_ok = NULL, last_test_detail = NULL, updated_at = excluded.updated_at`,
      newId("cred"),
      wid,
      provider,
      keyEnc,
      hint,
      now,
      now,
    );
    const row = await rowFor(db, wid, provider);
    return c.json({ data: statusFor(c.env, provider, row) });
  },
);

credentialRoutes.delete(
  "/workspaces/:wid/credentials/:provider",
  rateLimit({ key: workspaceWriteKey, limit: 20, windowSeconds: 60 }),
  async (c) => {
    const user = userOf(c);
    const wid = c.req.param("wid");
    const db = c.get("db");
    await requireWorkspaceOwner(db, user.id, wid);
    const provider = providerParam(c);
    await db.run("DELETE FROM provider_credentials WHERE workspace_id = ? AND provider = ?", wid, provider);
    return c.json({ data: { ok: true } });
  },
);

credentialRoutes.post(
  "/workspaces/:wid/credentials/:provider/test",
  rateLimit({ key: workspaceUserKey, limit: 10, windowSeconds: 60 }),
  async (c) => {
    const user = userOf(c);
    const wid = c.req.param("wid");
    const db = c.get("db");
    await requireWorkspaceMember(db, user.id, wid);
    const provider = providerParam(c);
    const { apiKey } = parseOrThrow(testBody, await jsonBody(c));

    if (apiKey) {
      // A typed, unsaved key: test it but persist nothing.
      return c.json({ data: await testProviderKey(c.env, provider, apiKey) });
    }

    const row = await rowFor(db, wid, provider);
    if (!row) throw setupRequired(`No workspace key is saved for ${providerLabel(c.env, provider)}.`);
    let saved: string;
    try {
      saved = await decryptSecret(c.env, row.key_enc, credentialAad(wid, provider));
    } catch {
      const result: KeyTestResult = { ok: false, detail: "Saved key could not be decrypted; please re-enter it." };
      await recordTest(db, wid, provider, result, c.get("now"));
      return c.json({ data: result });
    }
    const result = await testProviderKey(c.env, provider, saved);
    await recordTest(db, wid, provider, result, c.get("now"));
    return c.json({ data: result });
  },
);

async function recordTest(db: Db, workspaceId: string, provider: ProviderId, result: KeyTestResult, now: Date) {
  await db.run(
    `UPDATE provider_credentials SET last_tested_at = ?, last_test_ok = ?, last_test_detail = ?, updated_at = ?
      WHERE workspace_id = ? AND provider = ?`,
    iso(now),
    result.ok === null ? null : result.ok ? 1 : 0,
    result.detail,
    iso(now),
    workspaceId,
    provider,
  );
}
