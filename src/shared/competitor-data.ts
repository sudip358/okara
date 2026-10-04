/**
 * DataForSEO competitor data (docs/api.md "Competitor data (DataForSEO)", docs/provider-contracts.md
 * "DataForSEO Labs"). Kept in its own module (not types.ts) so concurrent edits of the main contract file
 * do not collide. Every number here is a DataForSEO third-party estimate, never Search Console data.
 * Keywords, URLs and error texts are untrusted provider text: render as plain text only.
 */
import type { CapabilityState } from "./types";

/** Credential state of the DataForSEO integration for a workspace (never includes the login or password). */
export interface DataForSeoCredentialStatus {
  provider: "dataforseo";
  label: string;
  /** workspace_key = saved for this workspace; operator_key = DATAFORSEO_LOGIN/DATAFORSEO_PASSWORD; none. */
  source: "workspace_key" | "operator_key" | "none";
  /** Last 4 characters of the saved API password (never the login). */
  keyHint: string | null;
  state: CapabilityState;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  lastTestDetail: string | null;
  /** Account balance (USD) from the last successful test of the saved workspace credentials, if any. */
  lastBalanceUsd: number | null;
  dataSent: string;
  /** False until migration 0013 is applied (workspace credentials cannot be stored yet). */
  storageReady: boolean;
}

/** POST /workspaces/:wid/dataforseo/test (GET v3/appendix/user_data, free). */
export interface DataForSeoTestResult {
  ok: boolean | null;
  detail: string;
  /** tasks[0].result[0].money.balance (USD) when the test succeeded; null otherwise. */
  balanceUsd: number | null;
}

export type CompetitorDataEndpoint = "ranked_keywords" | "domain_intersection" | "relevant_pages";

export type CompetitorFetchStatus = "queued" | "running" | "completed" | "partial" | "failed" | "setup_required";

export interface CompetitorFetchSummary {
  id: string;
  status: CompetitorFetchStatus;
  trigger: "competitor_added" | "manual";
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Sum of the costs DataForSEO returned for this refresh (USD); null when any call's cost is unknown. */
  costUsd: number | null;
  /** Plain-text reason for failed / partial / setup_required. */
  error: string | null;
}

/** Rank buckets as returned by DataForSEO (metrics.organic.pos_*). */
export interface CompetitorRankBuckets {
  pos_1: number;
  pos_2_3: number;
  pos_4_10: number;
  pos_11_20: number;
  pos_21_30: number;
  pos_31_40: number;
  pos_41_50: number;
  pos_51_60: number;
  pos_61_70: number;
  pos_71_80: number;
  pos_81_90: number;
  pos_91_100: number;
}

export interface CompetitorOverview {
  /** metrics.organic.count: organic SERPs containing the domain (DataForSEO estimate). */
  organicKeywords: number | null;
  /** metrics.organic.etv: estimated monthly organic traffic (DataForSEO estimate). */
  organicEtv: number | null;
  /** metrics.organic.estimated_paid_traffic_cost (USD/month, DataForSEO estimate). */
  estimatedPaidTrafficCost: number | null;
  buckets: CompetitorRankBuckets | null;
  isNew: number | null;
  isUp: number | null;
  isDown: number | null;
  isLost: number | null;
  /** result.total_count of the ranked_keywords task. */
  totalCount: number | null;
}

export interface CompetitorKeywordRow {
  keyword: string;
  /** ranked_serp_element.serp_item.rank_group */
  position: number | null;
  searchVolume: number | null;
  url: string | null;
  etv: number | null;
}

export interface CompetitorGapRow {
  keyword: string;
  searchVolume: number | null;
  /** first_domain_serp_element.rank_group (the competitor's position). */
  competitorPosition: number | null;
  competitorUrl: string | null;
  etv: number | null;
  keywordDifficulty: number | null;
  cpc: number | null;
}

export interface CompetitorPageRow {
  url: string;
  etv: number | null;
  /** metrics.organic.count for the page. */
  keywords: number | null;
  top3: number | null;
}

export interface CompetitorEndpointMeta {
  endpoint: CompetitorDataEndpoint;
  status: "ok" | "error";
  fetchedAt: string;
  /** Cost DataForSEO returned for this task (USD); null when unknown. */
  costUsd: number | null;
  totalCount: number | null;
  itemCount: number;
  error: string | null;
}

export interface CompetitorLocation {
  locationCode: number;
  locationName: string;
  languageCode: string;
  languageName: string;
}

/** One competitor domain on the panel (summary; tables come from the detail route). */
export interface CompetitorDomainSummary {
  competitorName: string;
  domain: string;
  latestFetch: CompetitorFetchSummary | null;
  /** Latest snapshot with data (completed or partial), or null. */
  snapshot: {
    fetchId: string;
    fetchedAt: string;
    location: CompetitorLocation | null;
    costUsd: number | null;
    overview: CompetitorOverview | null;
    endpoints: CompetitorEndpointMeta[];
  } | null;
  refreshesToday: number;
  /**
   * [A39] The domain was added while today's per-project refresh cap was used up: it waits in the backlog and the
   * cron fetches it on a later UTC day (in the order added). Absent on older responses.
   */
  waiting?: boolean;
}

export interface CompetitorDomainDetail extends CompetitorDomainSummary {
  topKeywords: CompetitorKeywordRow[];
  keywordGap: CompetitorGapRow[];
  /** The project's own domain used as target2 of the keyword gap. */
  ownDomain: string;
  topPages: CompetitorPageRow[];
}

/** GET /projects/:pid/competitors/dataforseo */
export interface CompetitorDataPanel {
  state: CapabilityState;
  /** Plain-text explanation for setup_required / error states. */
  message: string | null;
  credentialSource: DataForSeoCredentialStatus["source"];
  /** The current user is the workspace owner (refresh, settings). */
  canManage: boolean;
  location: CompetitorLocation | null;
  /** How the location was chosen: from the project locale (auto) or by the owner (user); null = not resolved yet. */
  locationSource: "auto" | "user" | null;
  /** Pull data automatically when a competitor domain is added. */
  autoFetch: boolean;
  caps: {
    refreshesPerDomainPerDay: number;
    fetchesPerProjectPerDay: number;
    fetchesToday: number;
    keepSnapshotsPerDomain: number;
    /** [A39] New competitor domains waiting for a later day's cap (auto-fetch backlog). */
    waitingDomains?: number;
  };
  pricing: {
    /** Published DataForSEO Labs price used for the reservation ceiling (docs/provider-contracts.md). */
    perTaskUsd: number;
    perItemUsd: number;
    /** Upper bound for one refresh of one domain (3 tasks, item limits below). */
    maxRefreshUsd: number;
    readOn: string;
    sourceUrl: string;
  };
  limits: { topKeywords: number; keywordGap: number; topPages: number };
  ownDomain: string;
  domains: CompetitorDomainSummary[];
}

/** GET /projects/:pid/competitors/dataforseo/locations (free DataForSEO Labs locations_and_languages). */
export interface CompetitorLocationOption {
  locationCode: number;
  locationName: string;
  countryIsoCode: string | null;
  languages: Array<{ languageCode: string; languageName: string }>;
}

/** POST /projects/:pid/competitors/dataforseo/refresh response. */
export interface CompetitorRefreshResult {
  fetch: CompetitorFetchSummary;
  /** True when an already queued/running refresh was returned instead of a new one. */
  existing: boolean;
}
