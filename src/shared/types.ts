/**
 * API contract shared by the Worker and the React SPA. Every endpoint in docs/api.md returns one of
 * these shapes (wrapped as `{ data: T }` on success or `{ error: ApiErrorBody }` on failure).
 * Metrics always carry their numerator, denominator, window, and source so the UI never shows a
 * bare percentage.
 */

// ------------------------------------------------------------------ enums
export type SiteType = "ecommerce" | "saas" | "publisher" | "local" | "other";
export type AgentKind = "seo" | "geo";
export type RunStatus =
  | "pending"
  | "running"
  | "partial"
  | "completed"
  | "failed"
  | "rate_limited"
  | "cancelled"
  | "setup_required";
export type RecommendationStatus = "open" | "approved" | "dismissed" | "implemented";
export type RecommendationStage = "collected" | "judged" | "drafted" | "awaiting_approval" | "marked_implemented";
export type Scope = "page" | "template" | "site";
export type Level = "low" | "medium" | "high";
export type Tier = "act" | "flag" | "drop" | "n/a";
export type PageType = "home" | "collection" | "product" | "article" | "landing" | "other";
export type Severity = "critical" | "major" | "moderate" | "minor" | "advisory";
export type EvidenceSource = "gsc" | "crawl" | "context_doc" | "geo_observation" | "manual_import" | "rule";
export type SourceType = "brand_page" | "listicle_roundup" | "review_site" | "forum_ugc" | "publisher" | "marketplace" | "other";
export type Sentiment = "positive" | "neutral" | "negative" | "mixed" | "unknown" | "not_applicable";
export type RecommendationStatusInAnswer = "recommended" | "listed_neutral" | "mentioned_negatively" | "not_mentioned" | "unknown";
export type ContextKind = "product" | "positioning" | "competitors" | "voice" | "pillars";
export type ProviderId = "typesafe" | "gemini" | "perplexity" | "writer";
export type CapabilityState = "ready" | "setup_required" | "disabled" | "error" | "demo";

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}
export type ApiResponse<T> = { data: T } | { error: ApiErrorBody };

// ------------------------------------------------------------------ identity
export interface Me {
  user: { id: string; email: string; name: string | null };
  workspaces: Array<{ id: string; name: string; role: "owner" | "member" }>;
  csrfToken: string;
  demoModeAvailable: boolean;
  environment: string;
}

// ------------------------------------------------------------------ projects
export interface Competitor {
  name: string;
  domains: string[];
  aliases: string[];
}

export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  siteUrl: string;
  siteType: SiteType;
  brandName: string;
  brandAliases: string[];
  competitors: Competitor[];
  productDescription: string;
  audience: string;
  locale: string;
  language: string;
  voice: string;
  verifiedHost: string | null;
  verificationMethod: "gsc" | "dns" | "file" | null;
  verifiedAt: string | null;
  gscProperty: string | null;
  scheduleEnabled: boolean;
  isDemo: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectInput {
  name: string;
  siteUrl: string;
  siteType: SiteType;
  brandName: string;
  brandAliases: string[];
  competitors: Competitor[];
  productDescription: string;
  audience: string;
  locale: string;
  language: string;
  voice: string;
}

export interface ContextFact {
  id: string;
  text: string;
  confirmed: boolean;
  source: string; // e.g. 'user', 'crawl:<snapshot id>'
}

export interface ContextDocument {
  id: string;
  kind: ContextKind;
  version: number;
  content: string;
  facts: ContextFact[];
  unconfirmedCount: number;
  createdAt: string;
  usedByRecommendationCount: number;
}

export interface VerificationStatus {
  verified: boolean;
  method: "gsc" | "dns" | "file" | null;
  verifiedHost: string | null;
  /** Instructions for DNS/file verification when not verified. */
  dnsRecord: { name: string; type: "TXT"; value: string } | null;
  fileCheck: { url: string; content: string } | null;
}

// ------------------------------------------------------------------ integrations
export interface IntegrationsStatus {
  gsc: {
    state: CapabilityState;
    property: string | null;
    connectedAt: string | null;
    lastError: string | null;
  };
  providers: Array<{
    provider: ProviderId;
    label: string;
    source: "workspace_key" | "operator_key" | "none";
    keyHint: string | null;
    state: CapabilityState;
    lastTestedAt: string | null;
    lastTestOk: boolean | null;
    lastTestDetail: string | null;
    model: string | null;
    dataSent: string; // disclosure: what project data goes to this provider
  }>;
}

// ------------------------------------------------------------------ metrics primitives
export interface Ratio {
  numerator: number;
  denominator: number;
  /** null when denominator is 0: unavailable, not zero. */
  value: number | null;
}

export interface Completeness {
  note: string; // e.g. "20 of 20 pages crawled; 3 skipped: JS-rendered"
  covered: number | null;
  total: number | null;
}

export interface DateWindow {
  start: string; // YYYY-MM-DD inclusive
  end: string;
}

// ------------------------------------------------------------------ SEO
export interface SeoOverview {
  state: CapabilityState;
  source: "api" | "csv_import" | "demo" | null;
  property: string | null;
  syncedAt: string | null;
  current: DateWindow | null;
  previous: DateWindow | null;
  totals: {
    current: { clicks: number; impressions: number; ctr: Ratio; position: number | null } | null;
    previous: { clicks: number; impressions: number; ctr: Ratio; position: number | null } | null;
  };
  daily: Array<{ date: string; clicks: number; impressions: number }>;
  annotations: Array<{ date: string; label: string }>;
  truncated: boolean;
  completeness: Completeness;
  visitsRevenue: { state: "not_connected" };
  limitations: string[];
}

export interface AuditFinding {
  id: string;
  ruleId: string;
  ruleName: string;
  area: string;
  class: "fact" | "heuristic";
  severity: Severity;
  url: string | null;
  template: string | null;
  detail: string;
  applicability: string;
}

export interface SeoAudit {
  state: CapabilityState;
  crawlRunId: string | null;
  crawledAt: string | null;
  completeness: Completeness;
  skipped: Array<{ url: string; reason: string }>;
  findings: AuditFinding[];
  aiCrawlerAccess: AiCrawlerAccess | null;
  limitations: string[];
}

export interface AiCrawlerAccess {
  llmsTxt: { present: boolean; notes: string[] };
  crawlers: Array<{ token: string; vendor: string; purpose: "answer_search" | "training"; allowed: boolean | null; sourceUrl: string }>;
  advisory: string[];
}

export interface PageRow {
  id: string;
  url: string;
  pageType: PageType;
  pageTypeMethod: string;
  lastCrawledAt: string | null;
  statusCode: number | null;
  title: string | null;
  wordCount: number | null;
  skippedReason: string | null;
}

// ------------------------------------------------------------------ recommendations
export interface EvidenceBullet {
  evidenceId: string;
  source: EvidenceSource;
  text: string;
}

export interface EvidenceItem {
  id: string;
  source: EvidenceSource;
  refId: string | null;
  window: string | null;
  text: string;
  data: unknown;
  tainted: boolean;
  createdAt: string;
}

export interface Recommendation {
  id: string;
  projectId: string;
  agent: AgentKind;
  scope: Scope;
  target: { kind: "url" | "template" | "site"; url?: string; template?: string; affectedUrlCount?: number; exampleUrls?: string[] };
  issueType: string;
  trigger: string;
  issue: string;
  action: string;
  suggestedSnippet: string | null;
  rationale: string;
  effort: Level;
  uncertainty: Level;
  limitations: string;
  verified: boolean;
  priority: number;
  priorityVersion: string;
  decision: { tier: Tier | null; fields: Record<string, number | string> | null; provider: string | null } ;
  evidenceBullets: EvidenceBullet[];
  confirmPlaceholders: string[];
  status: RecommendationStatus;
  stage: RecommendationStage;
  writer: { provider: string | null; model: string | null };
  isDemo: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RecommendationDetail extends Recommendation {
  evidence: EvidenceItem[];
  decisions: DecisionRecord[];
  events: Array<{ event: string; note: string | null; userId: string | null; createdAt: string }>;
}

export interface DecisionRecord {
  id: string;
  runId: string | null;
  agent: AgentKind;
  candidateKey: string;
  questionId: string | null;
  questionVersion: string | null;
  policyVersion: string | null;
  provider: string | null;
  model: string | null;
  answer: unknown;
  tier: Tier | null;
  outcome: "selected" | "rejected";
  reasonCode: string | null;
  createdAt: string;
}

// ------------------------------------------------------------------ GEO
export interface GeoPrompt {
  id: string;
  text: string;
  promptType: "discovery" | "reputation";
  stage: string | null;
  locale: string;
  language: string;
  approved: boolean;
  position: number;
}

export interface GeoPromptSet {
  id: string;
  version: number;
  prompts: GeoPrompt[];
  createdAt: string;
}

export interface GeoLane {
  provider: string;
  label: string; // e.g. "Gemini API (API-sampled)"
  model: string | null;
  groundingMode: string | null;
  state: CapabilityState;
  cohortKey: string | null;
  promptsRun: number;
  counts: { valid: number; grounded: number; failed: number; incomplete: number };
  mentionRate: Ratio;
  citationRate: Ratio;
  topCitedInstead: { entity: string; sourceType: SourceType; count: number } | null;
  searchQueries: { state: "captured" | "not_exposed"; count: number };
  cost: { usd: number | null; isEstimate: boolean };
  smallSampleWarning: boolean;
}

export interface GeoResults {
  state: CapabilityState;
  promptSetVersion: number | null;
  lanes: GeoLane[];
  shareOfVoice: Array<{ brandKey: string; isSelf: boolean; ratio: Ratio }>;
  trend: Array<{ cohortKey: string; runAt: string; mentionRate: Ratio; citationRate: Ratio; annotation: string | null }>;
  prompts: Array<{
    promptId: string;
    text: string;
    promptType: "discovery" | "reputation";
    perProvider: Array<{
      provider: string;
      observationId: string | null;
      status: "ok" | "failed" | "incomplete" | "not_run";
      grounded: boolean;
      mentioned: boolean | null;
      cited: boolean | null;
      sentiment: Sentiment | null;
      listRank: number | null;
      citedInstead: { entity: string; sourceType: SourceType; url: string | null } | null;
    }>;
  }>;
  labels: string[]; // mandatory disclosure strings, e.g. "API-sampled visibility; not consumer-app answers"
}

export interface GeoObservationDetail {
  id: string;
  promptText: string;
  promptType: "discovery" | "reputation";
  provider: string;
  model: string;
  groundingMode: string;
  measurementType: "api" | "manual_import";
  importedSurface: string | null;
  status: "ok" | "failed" | "incomplete";
  grounded: boolean;
  rawAnswer: string | null; // render as plain text only
  requestId: string | null;
  cost: { usd: number | null; isEstimate: boolean };
  brands: Array<{
    brandKey: string;
    isSelf: boolean;
    mentioned: boolean;
    cited: boolean;
    recommendationStatus: RecommendationStatusInAnswer;
    listRank: number | null;
    sentiment: Sentiment;
    spans: Array<{ start: number; end: number; text: string }>;
    method: string;
  }>;
  citations: Array<{ url: string; host: string; title: string | null; position: number | null; brandKey: string | null; sourceType: SourceType }>;
  searchQueries: string[] | null; // null = not exposed by provider
  displacements: Array<{ entity: string; url: string | null; sourceType: string; span: string | null }>;
  createdAt: string;
}

export interface DisplacementSummary {
  entity: string;
  sourceType: SourceType;
  url: string | null;
  count: number;
  prompts: string[];
}

export interface SearchQuerySummary {
  normalized: string;
  count: number;
  providers: string[];
  gscMatch: "ranking" | "impressions_weak_position" | "no_matching_page" | "unknown";
  gscImpressions: number | null;
  gscPosition: number | null;
}

// ------------------------------------------------------------------ runs, usage
export interface RunSummary {
  id: string;
  agent: AgentKind;
  trigger: "schedule" | "manual" | "demo";
  status: RunStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  summary: Record<string, unknown>;
}

export interface RunEvent {
  id: string;
  runId: string;
  agent?: AgentKind;
  step: string;
  status: "started" | "completed" | "skipped" | "failed" | "partial" | "info";
  message: string;
  createdAt: string;
}

export interface RunDetail extends RunSummary {
  events: RunEvent[];
  decisions: DecisionRecord[];
}

export interface UsageSummary {
  day: string;
  limits: {
    crawlPages: number;
    gscRows: number;
    geoPromptsPerRun: number;
    providerCallsPerDay: number;
    usdPerDay: number;
  };
  used: { providerCalls: number; usdActual: number | null; usdEstimated: number | null; usdUnknownCalls: number };
  calls: Array<{
    provider: string;
    model: string | null;
    purpose: string;
    status: string;
    costUsd: number | null;
    costIsEstimate: boolean;
    createdAt: string;
  }>;
  notes: string[];
}

export interface AttentionFeed {
  agents: Array<{
    agent: AgentKind;
    newToday: number; // 0..2
    openApprovals: number;
    lastRun: RunSummary | null;
    state: CapabilityState;
    zeroStateMessage: string | null;
  }>;
  recentEvents: RunEvent[];
}
