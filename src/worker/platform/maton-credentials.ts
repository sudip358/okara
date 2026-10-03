/**
 * The workspace's Maton.ai API key and connection choices (migration 0018).
 *   - Key: provider_credentials row with provider 'maton' (AES-GCM, AAD bound to the workspace; key_hint = last 4
 *     characters). There is no operator fallback: a Maton key reaches the owner's own connected apps, so only a
 *     key the workspace owner pasted is ever used.
 *   - Connections: maton_connections caches the ACTIVE connections of the apps Okara lists, as returned by the last
 *     key test, plus the owner's pick per app (selected = 1, sent as Maton-Connection). No pick = Maton's default
 *     (oldest active) connection.
 * Transport resolution (matonTransport): a key AND at least one cached active connection for the app; otherwise
 * null (callers report setup_required). Nothing here calls Maton (platform/maton.ts does).
 */
import type { Env } from "../env";
import type { Db } from "../lib/db";
import { decryptSecret } from "../lib/crypto";
import { iso } from "../lib/time";
import type { MatonAppId, MatonAppStatus, MatonStatus } from "@shared/maton";
import { MATON_WARNING } from "@shared/maton";
import { isMissingTableError } from "./custom-providers";
import { MATON_LISTED_APPS, MATON_USED_APPS, type MatonConnection, type MatonDeps, type MatonUsedApp } from "./maton";

export const MATON_CREDENTIAL = "maton" as const;
export const matonAad = (workspaceId: string) => `provider_credentials:${workspaceId}:${MATON_CREDENTIAL}`;
export const MATON_LABEL = "Maton.ai (API gateway)";
export const MATON_MIGRATION_PENDING = "Saving a Maton key needs database migration 0018_maton_gateway.sql to be applied.";

export const MATON_APP_LABEL: Record<MatonAppId, string> = {
  "google-sheets": "Google Sheets",
  "google-search-console": "Google Search Console",
  "google-analytics-data": "Google Analytics Data",
};

const APP_NOTE: Record<MatonAppId, string> = {
  "google-sheets": "Used for Import and live sync when the project has no direct Google Sheets connection (read-only: spreadsheet metadata and values).",
  "google-search-console": "Used for Search Console sync when a project picks Maton as its Search Console source and has no direct connection (read-only: sites list and Search Analytics queries).",
  "google-analytics-data": "Available, not used yet. Okara makes no Google Analytics requests.",
};

export interface MatonKeyRow {
  key_enc: string;
  key_hint: string;
  last_tested_at: string | null;
  last_test_ok: number | null;
  last_test_detail: string | null;
}

export async function matonRow(db: Db, workspaceId: string): Promise<MatonKeyRow | null> {
  return db.first<MatonKeyRow>(
    "SELECT key_enc, key_hint, last_tested_at, last_test_ok, last_test_detail FROM provider_credentials WHERE workspace_id = ? AND provider = ?",
    workspaceId,
    MATON_CREDENTIAL,
  );
}

/** The decrypted key, or null when none is saved. Throws when the saved key cannot be decrypted. */
export async function resolveMatonKey(env: Env, db: Db, workspaceId: string): Promise<string | null> {
  const row = await matonRow(db, workspaceId);
  if (!row) return null;
  return decryptSecret(env, row.key_enc, matonAad(workspaceId));
}

export interface ConnectionRow {
  app: MatonAppId;
  connection_id: string;
  status: string;
  creation_time: string | null;
  selected: number;
  listed_at: string;
}

/** Cached connections (missing table = none). */
export async function loadMatonConnections(db: Db, workspaceId: string): Promise<ConnectionRow[]> {
  try {
    return await db.all<ConnectionRow>(
      "SELECT app, connection_id, status, creation_time, selected, listed_at FROM maton_connections WHERE workspace_id = ? ORDER BY app, creation_time, connection_id",
      workspaceId,
    );
  } catch (e) {
    if (isMissingTableError(e)) return [];
    throw e;
  }
}

/** Replace the cached listing; keeps a selection while its connection is still listed. */
export async function saveMatonListing(db: Db, workspaceId: string, connections: MatonConnection[], now: Date): Promise<void> {
  const prev = await loadMatonConnections(db, workspaceId);
  const selected = new Set(prev.filter((r) => r.selected === 1).map((r) => `${r.app}|${r.connection_id}`));
  const stmts: Array<[string, ...unknown[]]> = [["DELETE FROM maton_connections WHERE workspace_id = ?", workspaceId]];
  for (const c of connections.slice(0, 60)) {
    stmts.push([
      "INSERT OR REPLACE INTO maton_connections (workspace_id, app, connection_id, status, creation_time, selected, listed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      workspaceId,
      c.app,
      c.connectionId,
      c.status,
      c.createdAt,
      selected.has(`${c.app}|${c.connectionId}`) ? 1 : 0,
      iso(now),
    ]);
  }
  await db.batch(stmts);
}

export async function clearMatonConnections(db: Db, workspaceId: string): Promise<void> {
  try {
    await db.run("DELETE FROM maton_connections WHERE workspace_id = ?", workspaceId);
  } catch (e) {
    if (!isMissingTableError(e)) throw e;
  }
}

/** Pick (or clear, null) the connection used for an app. Returns false when the id is not a listed active connection. */
export async function selectMatonConnection(db: Db, workspaceId: string, app: MatonUsedApp, connectionId: string | null): Promise<boolean> {
  if (connectionId !== null) {
    const row = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM maton_connections WHERE workspace_id = ? AND app = ? AND connection_id = ? AND status = 'ACTIVE'",
      workspaceId,
      app,
      connectionId,
    );
    if (!row || row.n === 0) return false;
  }
  await db.batch([
    ["UPDATE maton_connections SET selected = 0 WHERE workspace_id = ? AND app = ?", workspaceId, app],
    ...(connectionId !== null
      ? ([["UPDATE maton_connections SET selected = 1 WHERE workspace_id = ? AND app = ? AND connection_id = ?", workspaceId, app, connectionId]] as Array<[string, ...unknown[]]>)
      : []),
  ]);
  return true;
}

/** "connection 1a2b3c4d (added 2026-01-02)" — Maton documents no account label, so the id and date identify it. */
export function connectionLabel(connectionId: string, createdAt: string | null): string {
  const date = createdAt && /^\d{4}-\d{2}-\d{2}/.test(createdAt) ? createdAt.slice(0, 10) : null;
  return `connection ${connectionId.slice(0, 8)}${date ? ` (added ${date})` : ""}`;
}

export interface MatonTransport {
  apiKey: string;
  /** Sent as Maton-Connection; null = Maton's default (oldest active) connection. */
  connectionId: string | null;
  label: string;
}

/** Which connection an app would use, from the cache (no decryption). null = not available. */
export function pickConnection(rows: ConnectionRow[], app: MatonUsedApp): { connectionId: string | null; label: string } | null {
  const active = rows.filter((r) => r.app === app && r.status === "ACTIVE");
  if (active.length === 0) return null;
  const sel = active.find((r) => r.selected === 1);
  if (sel) return { connectionId: sel.connection_id, label: connectionLabel(sel.connection_id, sel.creation_time) };
  if (active.length === 1) return { connectionId: null, label: connectionLabel(active[0]!.connection_id, active[0]!.creation_time) };
  // Several and no pick: Maton's documented default is the oldest active connection.
  const oldest = [...active].sort((a, b) => (a.creation_time ?? "").localeCompare(b.creation_time ?? ""))[0]!;
  return { connectionId: null, label: `${connectionLabel(oldest.connection_id, oldest.creation_time)}, Maton's default` };
}

/** Whether the workspace can use Maton for an app (key saved + an active cached connection), without decrypting. */
export async function matonAvailability(db: Db, workspaceId: string, app: MatonUsedApp): Promise<{ label: string } | null> {
  let row: MatonKeyRow | null;
  try {
    row = await matonRow(db, workspaceId);
  } catch {
    return null;
  }
  if (!row) return null;
  const pick = pickConnection(await loadMatonConnections(db, workspaceId), app);
  return pick ? { label: pick.label } : null;
}

/** Key + connection for an app, or null. Throws when the saved key cannot be decrypted. */
export async function matonTransport(env: Env, db: Db, workspaceId: string, app: MatonUsedApp): Promise<MatonTransport | null> {
  let row: MatonKeyRow | null;
  try {
    row = await matonRow(db, workspaceId);
  } catch {
    return null;
  }
  if (!row) return null;
  const pick = pickConnection(await loadMatonConnections(db, workspaceId), app);
  if (!pick) return null;
  const apiKey = await decryptSecret(env, row.key_enc, matonAad(workspaceId));
  return { apiKey, ...pick };
}

export function matonDeps(env: Env, t: { apiKey: string }, purpose: string, extra: Partial<MatonDeps> = {}): MatonDeps {
  return { env, apiKey: t.apiKey, purpose, ...extra };
}

async function storageReady(db: Db, workspaceId: string): Promise<boolean> {
  try {
    await db.first("SELECT 1 FROM maton_connections WHERE workspace_id = ? LIMIT 1", workspaceId);
    return true;
  } catch (e) {
    if (isMissingTableError(e)) return false;
    throw e;
  }
}

/** Status for the Integrations card. Never includes the key (last 4 characters only). */
export async function matonStatus(db: Db, workspaceId: string): Promise<MatonStatus> {
  const [row, rows, ready] = await Promise.all([matonRow(db, workspaceId), loadMatonConnections(db, workspaceId), storageReady(db, workspaceId)]);
  const apps: MatonAppStatus[] = MATON_LISTED_APPS.map((app) => {
    const mine = rows.filter((r) => r.app === app);
    const used = (MATON_USED_APPS as readonly string[]).includes(app);
    const sel = mine.find((r) => r.selected === 1);
    return {
      app,
      label: MATON_APP_LABEL[app],
      usedByOkara: used,
      connections: mine.map((r) => ({ connectionId: r.connection_id, status: r.status, createdAt: r.creation_time, selected: r.selected === 1 })),
      selectedConnectionId: sel?.connection_id ?? null,
      note: APP_NOTE[app],
    };
  });
  const usable = rows.some((r) => r.status === "ACTIVE" && (MATON_USED_APPS as readonly string[]).includes(r.app));
  return {
    provider: "maton",
    label: MATON_LABEL,
    state: !row ? "setup_required" : row.last_test_ok === 0 ? "error" : usable ? "ready" : "setup_required",
    configured: row !== null,
    keyHint: row?.key_hint ?? null,
    lastTestedAt: row?.last_tested_at ?? null,
    lastTestOk: row && row.last_test_ok !== null ? row.last_test_ok === 1 : null,
    lastTestDetail: row?.last_test_detail ?? null,
    listedAt: rows[0]?.listed_at ?? null,
    apps,
    warning: MATON_WARNING,
    storageReady: ready,
  };
}
