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
    /** Includes the API GEO engine lanes (openai_geo, anthropic_geo). */
    provider: ProviderIdWithGeoEngines;
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
  /** First-party demand curve from GSC impressions (not market search volume). null when no query data. */
  demandCurve?: DemandCurve | null;
  /** Brand vs non-brand split of current-window query data (deterministic alias matching). [A23] */
  brandSplit?: {
    method: string;
    brand: { queries: number; clicks: number; impressions: number; ctr: Ratio };
    nonBrand: { queries: number; clicks: number; impressions: number; ctr: Ratio };
  } | null;
}

export type DemandSegment = "head" | "middle" | "long_tail";

/**
 * The site's own query demand curve: queries ranked by GSC impressions in the current window.
 * Segments are cut by cumulative share of impressions (versioned method), so they describe where
 * this site is already visible, not total market demand. Search volume and difficulty need a separate,
 * explicitly enabled keyword data source.
 */
export interface DemandCurve {
  source: "api" | "csv_import" | "demo";
  window: DateWindow | null;
  basis: "first_party_impressions";
  methodVersion: string;
  segmentation: string; // e.g. "Head: top queries up to 50% of impressions; middle: next 30%; long tail: remaining 20%"
  totalQueries: number;
  truncated: boolean;
  segments: Array<{
    segment: DemandSegment;
    queryCount: number;
    impressions: number;
    clicks: number;
    ctr: Ratio;
    shareOfImpressions: Ratio;
    medianWords: number | null;
    strongIntentShare: Ratio; // queries with commercial/transactional modifiers (heuristic list, versioned)
    examples: string[]; // up to 5 queries, plain text
  }>;
  points: Array<{ rank: number; impressions: number }>; // downsampled, <= 200 points, for a log-scale chart
  note: string;
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

/**
 * search_engine: classic search crawlers whose index also feeds AI features (e.g. Googlebot, Bingbot).
 * answer_search: AI answer/search crawlers (e.g. OAI-SearchBot, Claude-SearchBot, PerplexityBot).
 * user_fetch: fetches made on a user's request (e.g. ChatGPT-User); vendors may not apply robots.txt to these.
 * training: model-training crawlers or opt-out tokens (e.g. GPTBot, ClaudeBot, Google-Extended). Blocking is a business choice.
 */
export type CrawlerPurpose = "search_engine" | "answer_search" | "user_fetch" | "training";

export interface AiCrawlerAccess {
  llmsTxt: { present: boolean; notes: string[] };
  crawlers: Array<{ token: string; vendor: string; purpose: CrawlerPurpose; allowed: boolean | null; sourceUrl: string; note?: string | null }>;
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
  gscWindow?: DateWindow | null;
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

// ------------------------------------------------------------------ SEO and GEO readiness checklists [A21]
export type ChecklistKind = "seo" | "geo" | "page";
export type ChecklistSection =
  // SEO
  | "technical" | "on_page" | "quick_wins" | "seo_content" | "links"
  // GEO
  | "access" | "content" | "structure" | "mentions" | "trust" | "tracking"
  // Page (on-page checklist for one URL)
  | "before_write" | "while_write" | "details" | "publish_check";
/**
 * met / not_met / partial: measured from stored data (crawl, GSC, GEO observations, decisions).
 * manual: cannot be measured; the user confirms it (checked + note).
 * not_connected: needs a data source that is not connected (analytics, keyword/backlink/SERP data, CWV field data).
 * not_applicable: does not apply to this site type. unknown: no data yet (e.g. no crawl).
 */
export type ChecklistStatus = "met" | "not_met" | "partial" | "manual" | "not_connected" | "not_applicable" | "unknown";

export interface ChecklistItem {
  id: string; // stable, e.g. "geo.access.ai_search_bots_allowed", "seo.technical.canonical_tags"
  section: ChecklistSection;
  label: string;
  status: ChecklistStatus;
  method: "measured" | "heuristic" | "manual";
  summary: string; // what was checked, with counts, e.g. "3 of 4 AI search crawlers allowed"
  evidence: Array<{ label: string; url?: string | null; detail?: string | null }>;
  completeness: Completeness | null;
  guidance: string; // what to do; never promises rankings or citations
  caveat: string | null; // e.g. "IndexNow is used by Bing and other participating engines, not Google."
  links: Array<{ label: string; to: string }>; // in-app deep links, e.g. SEO audit, GEO results
  manual: { checked: boolean; note: string | null; updatedAt: string | null; updatedBy: string | null } | null;
  /**
   * Reference tier from Okara's "SEO tactics, ranked by impact" graphic (S highest .. D lowest). An external
   * opinion used only for ordering and display, labelled as such; never a measured impact or a promise.
   */
  tacticTier: "S" | "A" | "B" | "C" | "D" | null;
}

export interface Checklist {
  kind: ChecklistKind;
  /** Set for kind "page": the page being checked. */
  page?: { id: string; url: string; pageType: PageType; snapshotAt: string | null; topQuery: string | null } | null;
  state: CapabilityState;
  checklistVersion: string;
  generatedAt: string;
  sources: { crawlRunId: string | null; crawledAt: string | null; gscSyncedAt: string | null; geoObservations: number };
  counts: Record<ChecklistStatus, number>;
  items: ChecklistItem[];
  disclaimer: string; // "Practices, not guarantees..."
}

// ------------------------------------------------------------------ robots.txt advisor [A19]
export interface RobotsSuggestion {
  state: CapabilityState;
  fetchedAt: string | null;
  currentRobotsTxt: string | null; // plain text, capped; render as text only
  policy: { allowTraining: boolean };
  /** Groups to add or replace. Existing rules for "*" are copied into every named group (RFC 9309 group selection). */
  suggestedRobotsTxt: string | null;
  preservedRules: string[]; // rules carried over from the current "*" group
  changes: Array<{ token: string; purpose: CrawlerPurpose; before: "allowed" | "blocked" | "partial" | "no_group"; after: "allowed" | "blocked" | "unchanged" }>;
  warnings: string[]; // e.g. platform-managed robots (Shopify robots.txt.liquid), CDN/WAF bot blocking overrides robots.txt
  notes: string[];
}

// ------------------------------------------------------------------ coverage views (reference: "Jev × SEO + GEO" 4-panel concept)
export type AuditCellStatus = "ok" | "review" | "missing" | "not_applicable" | "unknown";

/** SEO · Page audit: one row per crawled page, derived from the latest snapshot + findings. */
export interface PageAuditRow {
  pageId: string;
  url: string;
  pageType: PageType;
  title: { status: AuditCellStatus; detail: string | null };
  h1: { status: AuditCellStatus; detail: string | null };
  schema: { status: AuditCellStatus; types: string[]; detail: string | null };
  action: "keep" | "update" | "review"; // keep = no open findings on this page
  findingsCount: number;
}

/** SEO · Content evidence: depth / proof / freshness of YOUR pages (competitor pages only when user-approved). */
export interface ContentEvidenceRow {
  pageId: string;
  url: string;
  pageType: PageType;
  depth: { wordCount: number | null; status: AuditCellStatus };
  proof: { outboundCitations: number | null; tables: number | null; status: "present" | "missing" | "unknown" };
  freshness: { lastUpdated: string | null; ageDays: number | null; status: AuditCellStatus };
  gsc: { impressions: number | null; clicks: number | null; window: DateWindow | null };
  priority: { value: number | null; label: "high" | "medium" | "low" | null; version: string | null; basis: string };
}

/** GEO · Answer coverage: approved prompts mapped to your best page and to who got cited. */
export interface AnswerCoverageRow {
  promptId: string;
  text: string;
  promptType: "discovery" | "reputation";
  matchedPage: { url: string; method: "engine_search_query" | "title_heading_overlap"; score: number } | null;
  aiSource: "your_site" | "other_site" | "none" | "not_run";
  topOtherSource: { host: string; sourceType: SourceType; url: string | null } | null;
  gap: "covered" | "improve" | "create_page" | "check";
  providersRun: number;
  basis: string; // how the match and gap were determined
}

/** GEO · Citation evidence: per page of your site, how AI answers cited it. */
export interface CitationEvidenceRow {
  url: string;
  pageId: string | null;
  citedCount: number;
  citedInPrompts: string[];
  providers: string[];
  lastCitedAt: string | null;
  citedAlongside: Array<{ host: string; sourceType: SourceType }>;
  nextStep: "compare" | "add_proof" | "none";
  reason: string;
}

export interface CoverageResponse<T> {
  state: CapabilityState;
  generatedAt: string;
  rows: T[];
  completeness: Completeness | null;
  labels: string[];
}

// ------------------------------------------------------------------ redirect map tool [A23]
export interface RedirectMapRequest {
  oldUrls: string[]; // max 500 per request
  /** New URLs to map onto; when omitted, the latest crawl's 2xx URLs are used. */
  newUrls?: string[];
  useJev?: boolean; // default true when TypeSafe is configured
}

export interface RedirectMapRow {
  from: string;
  to: string | null;
  method: "exact_path" | "normalized_slug" | "jev" | "none";
  confidence: number | null; // Jev Choice confidence only; null for deterministic matches
  tier: Tier | null;
  status: "auto" | "review" | "no_match"; // auto = exact/normalized or Jev act tier; review = flag tier or ambiguous; no_match = none chosen
  candidates: Array<{ url: string; score: number }>; // deterministic shortlist shown to the reviewer
  note: string | null;
}

export interface RedirectMapResult {
  state: CapabilityState;
  generatedAt: string;
  rows: RedirectMapRow[];
  counts: { auto: number; review: number; noMatch: number };
  /** Shopify URL Redirects import format: "Redirect from,Redirect to" (paths, not absolute URLs). */
  shopifyCsv: string;
  labels: string[];
}

// ------------------------------------------------------------------ internal link suggester [A25]
export type LinkRole = "explains_concept" | "deeper_detail" | "broader_guide" | "next_step" | "product_service" | "comparison";

export interface LinkSuggestion {
  id: string;
  source: { pageId: string; url: string; title: string | null };
  target: { pageId: string; url: string; title: string | null; inlinks: number; orphan: boolean };
  sentence: { index: number; text: string } | null; // plain text from the source page
  anchor: { text: string } | null;
  role: LinkRole | null;
  method: "jev" | "deterministic";
  /** Real provider fields only: noul for "should exist", confidence for the Choice answers. */
  decision: {
    tier: Tier | null;
    shouldExist: number | null; // Noul
    sentenceConfidence: number | null;
    anchorConfidence: number | null;
    roleConfidence: number | null;
    provider: string | null;
    model: string | null;
  } | null;
  status: "suggested" | "review" | "rejected";
  score: number; // deterministic candidate score (documented formula), not a Jev value
  reasons: string[];
  userStatus: "open" | "accepted" | "dismissed" | "implemented";
}

export interface LinkSuggestionReport {
  state: CapabilityState;
  generatedAt: string | null;
  crawlRunId: string | null;
  pagesAnalysed: number;
  orphanPages: Array<{ pageId: string; url: string }>;
  suggestions: LinkSuggestion[];
  genericAnchors: Array<{ sourceUrl: string; targetUrl: string; anchor: string }>;
  completeness: Completeness | null;
  labels: string[];
}

// ------------------------------------------------------------------ SEO views from [A23]/[A25]
export interface BuyerQueryRow {
  query: string;
  intent: "transactional" | "commercial_investigation";
  intentTier: Tier;
  impressions: number;
  clicks: number;
  position: number | null;
  topPage: string | null;
  segment: DemandSegment | null;
}

export interface TranslationOpportunityRow {
  country: string; // ISO 3166-1 alpha-3 as returned by GSC
  impressions: number;
  clicks: number;
  shareOfImpressions: Ratio;
  topPages: string[];
  servedLanguage: boolean | null; // hreflang/lang for that market detected on crawled pages; null = unknown
  note: string;
}

// ------------------------------------------------------------------ draft / page quality check [A23]
export interface DraftCheckRequest {
  targetQuery: string;
  /** Either an existing crawled page or pasted draft text. */
  pageId?: string;
  draftText?: string; // max 60,000 chars
  title?: string;
  metaDescription?: string;
}

export interface DraftCheckFlag {
  kind: "unsupported_claim" | "fabricated_testimonial" | "filler" | "guarantee_language";
  text: string; // exact excerpt, plain text
  method: "rule" | "jev";
  noul: number | null;
}

export interface DraftCheckResult {
  state: CapabilityState;
  verdict: "pass" | "fail" | "needs_review";
  checklist: Checklist; // kind "page" items evaluated against the draft
  flags: DraftCheckFlag[];
  jevUsed: boolean;
  labels: string[];
}

// ------------------------------------------------------------------ AI engine board [A6-A8, A11] (docs/geo-board-design.md)
/**
 * Provider ids of the two additional API-sampled GEO engines. Contracts: docs/provider-contracts.md
 * ("OpenAI Responses API web search — GEO", "Anthropic Messages web search — GEO"). They are kept out of
 * `ProviderId` until the credential store, budget, runtime, and migration change land together (see the
 * switch-site list in docs/api.md "AI engine board"): `ProviderId` is the key type of several exhaustive
 * Record maps and the `provider_credentials.provider` CHECK constraint. "writer" stays a separate id even
 * when the writer and a GEO engine use the same vendor.
 */
export type GeoEngineApiProviderId = "openai_geo" | "anthropic_geo";
/** Every API-sampled GEO engine lane. Manual imports are not an engine lane. */
export type GeoEngineProviderId = "gemini" | "perplexity" | GeoEngineApiProviderId;
/** ProviderId after the GEO engine additions; the builder replaces ProviderId with this union. */
export type ProviderIdWithGeoEngines = ProviderId | GeoEngineApiProviderId;

/** A value with an explicit money basis: actual as returned by the provider, or an estimate from versioned rates. */
export interface CostUsd {
  /** null = unknown (no usage or no configured rate); never rendered as $0. */
  value: number | null;
  isEstimate: boolean;
}

export type EngineFeedStatus = "missing" | "named" | "cited" | "not_run";

/** One prompt card in an engine lane's feed (latest observation for that prompt and engine). */
export interface EngineFeedItem {
  promptId: string;
  promptText: string; // plain text
  observationId: string | null; // null when status is not_run
  /**
   * missing: brand neither mentioned nor cited; named: mentioned but no own-site citation;
   * cited: an own-site URL was cited; not_run: no valid observation for this prompt in the cohort.
   */
  status: EngineFeedStatus;
  /** Rank in a real ordered list in the answer (geo_brand_observations.list_rank); null when there was no list. */
  position: number | null;
  sentiment: { value: Sentiment; method: string } | null; // method as stored, e.g. "deterministic+jev"
  /** Provider-call latency when the call is linked by request id; null when not recorded. */
  latencyMs: number | null;
  grounded: boolean;
  citedInstead: { host: string; url: string | null; sourceType: SourceType } | null;
  observedAt: string | null;
}

/** One engine column of the board. Every rate carries its numerator and denominator. */
export interface EngineLaneSummary {
  provider: GeoEngineProviderId;
  label: string; // e.g. "OpenAI Responses API · web_search (API-sampled)"
  model: string | null; // exact model id from configuration / the response; never a default
  groundingMode: string | null; // e.g. "web_search", "web_search_20250305", "google_search"
  state: CapabilityState;
  /** Why the lane is not ready (e.g. "Set OPENAI_GEO_MODEL and an OpenAI key"); null when ready. */
  stateDetail: string | null;
  cohortKey: string | null;
  promptsRun: number;
  counts: { valid: number; grounded: number; failed: number; incomplete: number };
  citationRate: Ratio; // valid answers citing an own-site URL / valid answers
  mentionRate: Ratio; // valid answers mentioning the brand / valid answers
  answersCitingUs: number; // = citationRate.numerator
  answersSkippingUs: number; // valid answers with neither mention nor own-site citation
  /** Host cited most often in answers that skip us; share = answers citing that host / answersSkippingUs. */
  citedInstead: { host: string; share: Ratio } | null;
  searchQueries: { state: "captured" | "not_exposed"; count: number };
  costUsd: CostUsd;
  lastRunAt: string | null;
  smallSampleWarning: boolean;
  feed: EngineFeedItem[]; // newest first, capped (see docs/api.md)
}

export interface EngineBoardResponse {
  state: CapabilityState;
  promptSetVersion: number | null;
  generatedAt: string;
  lanes: EngineLaneSummary[]; // fixed order: openai_geo, anthropic_geo, gemini, perplexity
  /** Mandatory disclosures, e.g. "API-sampled answers; not consumer-app answers". */
  labels: string[];
}

// ------------------------------------------------------------------ why an engine skips our page [A7]
export type SkipFactorKey =
  | "answer_first"
  | "faq_schema"
  | "author"
  | "freshness"
  | "sources_cited"
  | "entity_facts"
  | "compare_table"
  | "internal_links";
export type FactorStatus = "present" | "partial" | "missing" | "unknown";

export interface SkipFactor {
  key: SkipFactorKey;
  label: string;
  status: FactorStatus;
  /** Observable fact, e.g. "answer at word 180", "FAQPage JSON-LD absent", "3 outbound source links". */
  measured: string;
  value: number | null; // the raw measured number behind `measured` when there is one
  method: "measured" | "heuristic";
  /** Same attribute on the cited page when the user approved it [A7]; null otherwise. */
  citedPage: { status: FactorStatus; measured: string; value: number | null } | null;
}

/** Observable attributes of one of our pages, optionally for one prompt and engine. No aggregate score. */
export interface PageSkipFactors {
  state: CapabilityState;
  page: { pageId: string; url: string; snapshotAt: string | null; wordCount: number | null };
  promptId: string | null;
  promptText: string | null;
  engine: GeoEngineProviderId | null;
  /** Host cited in place of us for this prompt/engine (latest cohort), null when none or not asked. */
  citedInsteadHost: string | null;
  /** Approved competitor assessment used for the citedPage column, when one exists. */
  competitorAssessmentId: string | null;
  factors: SkipFactor[];
  /** How the page and cited source were chosen, e.g. "best page by engine search query match". */
  basis: string;
  labels: string[]; // e.g. "Measured from crawl", "Correlational, not causal"
}

// ------------------------------------------------------------------ competitor pages read for why an engine cites them [A7]
export type CompetitorCheckKey = "answer_first" | "depth" | "proof" | "schema" | "freshness" | "author" | "entity" | "faq";

export interface CompetitorCheck {
  key: CompetitorCheckKey;
  label: string;
  /** Jev Noul yes-probability for method "jev"; null for measured checks. Noul has no confidence field. */
  noul: number | null;
  /** Tier from runs/policy.ts for jev checks; null for measured checks. */
  tier: "act" | "flag" | "drop" | null;
  method: "jev" | "measured";
  /** Measured value or observable fact, e.g. "1,709 words", "FAQPage, Product". */
  detail: string | null;
}

export type CompetitorAssessmentState = "queued" | "fetching" | "assessed" | "blocked" | "failed";

export interface CompetitorPageAssessment {
  id: string;
  url: string;
  host: string;
  approvedAt: string;
  approvedBy: string; // users.id
  fetchedAt: string | null;
  sourceType: SourceType; // from geo_citations for that URL
  /** Prompts and engines whose stored answers cited this URL. */
  citedIn: Array<{ promptId: string | null; promptText: string; provider: string; observationId: string }>;
  checks: CompetitorCheck[];
  /** Short observable facts only (plain text), e.g. "Answer in first 40 words", "Updated 20 days ago". */
  reasons: string[];
  /** adapt = worth adapting the structure (never copying text); skip = nothing to adapt; review = human check. */
  verdict: "adapt" | "skip" | "review" | null;
  state: CompetitorAssessmentState;
  /** e.g. "robots.txt disallows", "401 login wall", "non-HTML". */
  stateDetail: string | null;
}

export interface CompetitorPageApprovalRequest {
  url: string; // must equal a URL stored in geo_citations for this project
}

// ------------------------------------------------------------------ rewrite plans (manual; never auto-published)
export type RewritePlanItemKey =
  | "read_winning_page"
  | "map_question"
  | "faq"
  | "compare_table"
  | "internal_links"
  | "answer_first"
  | "author"
  | "schema"
  | "indexnow";

export interface RewritePlanItem {
  key: RewritePlanItemKey;
  label: string; // indexnow: "Submit to IndexNow (Bing and participating engines, not Google) · optional"
  status: "done" | "todo" | "not_applicable" | "unknown";
  evidence: string | null; // plain text, e.g. "FAQPage JSON-LD present in crawl of 2026-09-29"
  method: "measured" | "manual";
  optional: boolean; // true for indexnow
}

export interface RewritePlan {
  pageId: string;
  url: string;
  question: string; // the prompt text this page should answer
  promptId: string | null;
  engine: GeoEngineProviderId | null;
  competitorAssessmentId: string | null;
  items: RewritePlanItem[];
  /** Measured GSC for the page (never projected); null when GSC is not connected. */
  gsc: { clicks: number; impressions: number; window: DateWindow } | null;
  /** Answers citing this page in stored observations within the window; null when no GEO data. */
  aiCitations: { count: number; window: DateWindow } | null;
  recommendationId: string | null;
  publishing: "manual";
}

export interface RewritePlansResponse {
  state: CapabilityState;
  generatedAt: string;
  plans: RewritePlan[];
  labels: string[];
}
