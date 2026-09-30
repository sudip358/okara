/**
 * Provider credential resolution. Workspace BYO keys (encrypted in provider_credentials) take
 * precedence over operator keys from Env. Keys are decrypted only server-side, only when needed,
 * and never logged or returned to the browser.
 */
import type { Env } from "../env";
import type { Db } from "../lib/db";
import { decryptSecret } from "../lib/crypto";
import type { ProviderId } from "@shared/types";

export interface ResolvedKey {
  key: string;
  source: "workspace_key" | "operator_key";
}

const OPERATOR_ENV: Record<ProviderId, keyof Env> = {
  typesafe: "TYPESAFE_API_KEY",
  gemini: "GEMINI_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
  writer: "WRITER_API_KEY",
};

export const credentialAad = (workspaceId: string, provider: ProviderId) => `provider_credentials:${workspaceId}:${provider}`;

export async function resolveProviderKey(env: Env, db: Db, workspaceId: string, provider: ProviderId): Promise<ResolvedKey | null> {
  const row = await db.first<{ key_enc: string }>(
    "SELECT key_enc FROM provider_credentials WHERE workspace_id = ? AND provider = ?",
    workspaceId,
    provider,
  );
  if (row) {
    return { key: await decryptSecret(env, row.key_enc, credentialAad(workspaceId, provider)), source: "workspace_key" };
  }
  const op = env[OPERATOR_ENV[provider]];
  if (typeof op === "string" && op.trim()) return { key: op.trim(), source: "operator_key" };
  return null;
}

export type CredentialSource = ResolvedKey["source"];

/**
 * Which credential each provider would use for this workspace, mirroring resolveProviderKey's
 * precedence (saved workspace key, then operator key) without decrypting anything. null = no key.
 * Budgets use this to apply the global (operator) daily caps only to operator-key spend.
 */
export async function credentialSources(env: Env, db: Db, workspaceId: string): Promise<Record<ProviderId, CredentialSource | null>> {
  const rows = await db.all<{ provider: ProviderId }>("SELECT provider FROM provider_credentials WHERE workspace_id = ?", workspaceId);
  const saved = new Set(rows.map((r) => r.provider));
  const out = {} as Record<ProviderId, CredentialSource | null>;
  for (const provider of Object.keys(OPERATOR_ENV) as ProviderId[]) {
    const op = env[OPERATOR_ENV[provider]];
    out[provider] = saved.has(provider) ? "workspace_key" : typeof op === "string" && op.trim() ? "operator_key" : null;
  }
  return out;
}
