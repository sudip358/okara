/**
 * DataForSEO credentials (API login + API password, HTTP Basic). Stored per workspace in
 * provider_credentials with provider 'dataforseo' (migration 0013 widens the CHECK): key_enc is the
 * AES-GCM-encrypted "login:password" string (the exact Basic credential; RFC 7617 forbids ':' in the
 * login), key_hint the last 4 characters of the password. Operator fallback: DATAFORSEO_LOGIN +
 * DATAFORSEO_PASSWORD (both required). Precedence: workspace credentials, then operator credentials.
 * Nothing here is ever returned to the browser or logged; decryption happens only right before a call.
 */
import type { Env } from "../env";
import type { Db } from "../lib/db";
import { decryptSecret } from "../lib/crypto";
import type { DataForSeoCredentials } from "../providers/dataforseo";

export const DATAFORSEO_CREDENTIAL = "dataforseo" as const;
export const dataForSeoAad = (workspaceId: string) => `provider_credentials:${workspaceId}:${DATAFORSEO_CREDENTIAL}`;

export type DataForSeoSource = "workspace_key" | "operator_key";

export interface ResolvedDataForSeo {
  creds: DataForSeoCredentials;
  source: DataForSeoSource;
}

/** "login:password" -> credentials (split on the first ':'); null when malformed. */
export function splitCredential(secret: string): DataForSeoCredentials | null {
  const i = secret.indexOf(":");
  if (i <= 0 || i === secret.length - 1) return null;
  return { login: secret.slice(0, i), password: secret.slice(i + 1) };
}

export function joinCredential(c: DataForSeoCredentials): string {
  return `${c.login}:${c.password}`;
}

export function operatorDataForSeo(env: Pick<Env, "DATAFORSEO_LOGIN" | "DATAFORSEO_PASSWORD">): DataForSeoCredentials | null {
  const login = env.DATAFORSEO_LOGIN?.trim();
  const password = env.DATAFORSEO_PASSWORD?.trim();
  if (!login || !password || login.includes(":")) return null;
  return { login, password };
}

/** Saved workspace row (no decryption), or null. A missing table/CHECK (migration pending) reads as none. */
export async function dataForSeoRow(db: Db, workspaceId: string) {
  return db.first<{ key_enc: string; key_hint: string; last_tested_at: string | null; last_test_ok: number | null; last_test_detail: string | null }>(
    "SELECT key_enc, key_hint, last_tested_at, last_test_ok, last_test_detail FROM provider_credentials WHERE workspace_id = ? AND provider = ?",
    workspaceId,
    DATAFORSEO_CREDENTIAL,
  );
}

/** Which credentials would be used, without decrypting anything. */
export async function dataForSeoSource(env: Env, db: Db, workspaceId: string): Promise<DataForSeoSource | null> {
  if (await dataForSeoRow(db, workspaceId)) return "workspace_key";
  return operatorDataForSeo(env) ? "operator_key" : null;
}

/**
 * Credentials for a call: the workspace's saved credentials, else the operator's. Throws when the saved
 * credentials cannot be decrypted (the caller reports it; never falls back to the operator silently).
 */
export async function resolveDataForSeo(env: Env, db: Db, workspaceId: string): Promise<ResolvedDataForSeo | null> {
  const row = await dataForSeoRow(db, workspaceId);
  if (row) {
    const creds = splitCredential(await decryptSecret(env, row.key_enc, dataForSeoAad(workspaceId)));
    if (!creds) throw new Error("Saved DataForSEO credentials are malformed.");
    return { creds, source: "workspace_key" };
  }
  const op = operatorDataForSeo(env);
  return op ? { creds: op, source: "operator_key" } : null;
}
