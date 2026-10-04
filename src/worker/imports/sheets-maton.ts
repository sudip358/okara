/**
 * Google Sheets through the Maton.ai gateway (owner request 2026-10-03), and the Sheets transport resolution used by
 * Import, "Sync now" and the cron sync:
 *   1. the project's direct Google Sheets OAuth connection (imports/sheets.ts), unchanged, whenever it is connected;
 *   2. otherwise the workspace's Maton key with an active google-sheets connection (the owner's pick, else Maton's
 *      default), reading the same native endpoints (spreadsheets.get with the same fields mask, values.get with the
 *      same range and options) and parsing the same response shapes;
 *   3. otherwise null (callers report setup_required / not_connected).
 * All Maton traffic goes through platform/maton.ts (egress policy, timeouts, size caps, provider_calls metering).
 */
import type { Env } from "../env";
import type { Db } from "../lib/db";
import { createCallRecorder } from "../runs/calls";
import { MatonApiError, MatonPolicyError, sheetsGetSpreadsheet, sheetsGetValues, type MatonDeps } from "../platform/maton";
import { matonAvailability, matonTransport, type MatonTransport } from "../platform/maton-credentials";
import type { ProjectRow } from "../platform/access";
import type { SheetsConnectionStatus } from "@shared/import";
import { a1Range, createSheetsClient, parseSpreadsheet, parseValueRange, SheetsApiError, sheetsStatus, SPREADSHEET_FIELDS, type SheetsClient } from "./sheets";

export const MATON_SHEETS_PURPOSE = "import_sheets";

function toSheetsError(e: unknown): unknown {
  if (e instanceof MatonPolicyError) return new SheetsApiError(400, "api_error", e.message);
  if (!(e instanceof MatonApiError)) return e;
  const msg = e.upstreamMessage;
  switch (e.code) {
    case "unauthorized":
      return new SheetsApiError(401, "token_expired", e.message);
    case "missing_connection":
      return new SheetsApiError(400, "not_connected", e.message);
    case "not_found":
      return new SheetsApiError(404, "not_found", "Spreadsheet not found, or the Google account connected in Maton cannot open it.");
    case "forbidden":
      return new SheetsApiError(403, "forbidden", `Google Sheets refused access through Maton (403)${msg ? `: ${msg}` : ""}. Share the sheet with the Google account connected in Maton.`);
    case "bad_request":
      if (/unable to parse range/i.test(msg)) return new SheetsApiError(400, "tab_missing", "That tab was not found in the spreadsheet (renamed or deleted?).");
      return new SheetsApiError(400, "api_error", e.message);
    case "rate_limited":
      return new SheetsApiError(429, "api_error", e.message);
    default:
      return new SheetsApiError(e.status, "api_error", e.message);
  }
}

export interface MatonSheetsOptions {
  calls?: MatonDeps["calls"];
  fetchImpl?: typeof fetch;
}

/** SheetsClient over Maton with the native Sheets v4 paths and shapes. */
export function createMatonSheetsClient(env: Env, transport: MatonTransport, opts: MatonSheetsOptions = {}): SheetsClient {
  const deps: MatonDeps = { env, apiKey: transport.apiKey, calls: opts.calls ?? null, purpose: MATON_SHEETS_PURPOSE, fetchImpl: opts.fetchImpl };
  return {
    transport: { kind: "maton", label: transport.label },
    async getSpreadsheet(spreadsheetId) {
      try {
        return parseSpreadsheet(await sheetsGetSpreadsheet(deps, transport.connectionId, spreadsheetId, SPREADSHEET_FIELDS), spreadsheetId);
      } catch (e) {
        throw toSheetsError(e);
      }
    },
    async getValues(spreadsheetId, tab, dataRows) {
      try {
        return parseValueRange(await sheetsGetValues(deps, transport.connectionId, spreadsheetId, a1Range(tab, dataRows)));
      } catch (e) {
        throw toSheetsError(e);
      }
    },
  };
}

/**
 * The project's Sheets client by precedence (direct OAuth, else Maton, else null). Maton calls are recorded in
 * provider_calls against the project. A Maton key that cannot be decrypted reads as "not available".
 */
export async function resolveSheetsClient(env: Env, db: Db, project: { id: string; workspaceId: string }, opts: { fetchImpl?: typeof fetch } = {}): Promise<SheetsClient | null> {
  const direct = await createSheetsClient(env, db, project);
  if (direct) return direct;
  let t: MatonTransport | null;
  try {
    t = await matonTransport(env, db, project.workspaceId, "google-sheets");
  } catch {
    t = null;
  }
  if (!t) return null;
  const calls = createCallRecorder(db, { workspaceId: project.workspaceId, projectId: project.id, runId: null });
  return createMatonSheetsClient(env, t, { calls, fetchImpl: opts.fetchImpl });
}

/** "direct" | "maton" for a client (absent transport = direct). */
export const transportOf = (c: SheetsClient): "direct" | "maton" => c.transport?.kind ?? "direct";

/**
 * Import page connection status with the Maton fallback: the direct status when it is ready (or a demo); otherwise
 * "ready via Maton" when the workspace has a Maton key with an active google-sheets connection.
 */
export async function sheetsStatusWithMaton(env: Env, db: Db, p: ProjectRow): Promise<SheetsConnectionStatus> {
  const direct = await sheetsStatus(env, db, p);
  if (direct.state === "demo") return direct;
  const avail = await matonAvailability(db, p.workspace_id, "google-sheets");
  const maton = { available: avail !== null, label: avail?.label ?? null };
  if (direct.state === "ready" || !avail) return { ...direct, via: direct.state === "ready" ? "direct" : undefined, maton };
  return {
    ...direct,
    state: "ready",
    via: "maton",
    maton,
    notes: [
      `Connected via Maton (${avail.label}): read-only spreadsheet metadata and values through the workspace's Maton.ai key. Connecting Google Sheets directly takes precedence.`,
      ...direct.notes.slice(1),
    ],
  };
}
