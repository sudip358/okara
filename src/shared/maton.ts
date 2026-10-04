/**
 * Maton.ai API gateway (workspace key) shapes shared by the Worker and the SPA. See docs/api.md "Maton.ai".
 * The key itself is never part of any response: only the last 4 characters (keyHint).
 */
import type { CapabilityState } from "./types";

export type MatonAppId = "google-sheets" | "google-search-console" | "google-analytics-data" | "google-analytics-admin";

export const MATON_WARNING =
  "This key can reach every app you connected in Maton. Okara only makes read-only Google Sheets, Search Console and Google Analytics report requests and refuses everything else.";

export interface MatonConnectionSummary {
  connectionId: string;
  status: string;
  /** Maton's creation_time (no account e-mail or label is documented by Maton). */
  createdAt: string | null;
  /** The owner's pick for this app (sent as the Maton-Connection header). */
  selected: boolean;
}

export interface MatonAppStatus {
  app: MatonAppId;
  label: string;
  /** false for the Google Analytics apps ("available, not used yet" by Okara's own features). */
  usedByOkara: boolean;
  connections: MatonConnectionSummary[];
  /** The connection Okara sends; null = Maton's default (oldest active) connection, or none. */
  selectedConnectionId: string | null;
  note: string;
}

export interface MatonStatus {
  provider: "maton";
  label: string;
  state: CapabilityState;
  configured: boolean;
  keyHint: string | null;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  lastTestDetail: string | null;
  /** When the connection list below was fetched (by the last successful test). */
  listedAt: string | null;
  apps: MatonAppStatus[];
  warning: string;
  /** false until migration 0018 is applied. */
  storageReady: boolean;
}

export interface MatonTestResult {
  ok: boolean | null;
  detail: string;
  /** Only the apps Okara lists; never connection URLs or metadata. */
  apps: Array<{ app: MatonAppId; connectionId: string; status: string; createdAt: string | null; used: boolean }>;
}

/** Project setting "Search Console source" (Integrations page). */
export interface GscMatonStatus {
  /** What the project's sync uses now: direct OAuth wins whenever it is connected. */
  effective: "direct" | "maton" | null;
  /** Stored choice: 'direct' (default) or 'maton'. */
  source: "direct" | "maton";
  directConnected: boolean;
  /** The workspace has a Maton key with an active google-search-console connection. */
  matonAvailable: boolean;
  matonConnectionLabel: string | null;
  property: string | null;
  canManage: boolean;
}

export interface MatonSite {
  siteUrl: string;
  permissionLevel: string;
}
