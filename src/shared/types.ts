/**
 * API contract shared by the Worker and the React SPA. Every endpoint in docs/api.md returns one of
 * these shapes (wrapped as `{ data: T }` on success or `{ error: ApiErrorBody }` on failure).
 * Metrics always carry their numerator, denominator, window, and source so the UI never shows a
 * bare percentage.
 */
import type { RunScope } from "./run-scope";

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
/** "imported": Imported research (a sheet tab or CSV as a capped plain-text table; several per project, see docKey). */
export type ContextKind = "product" | "positioning" | "competitors" | "voice" | "pillars" | "imported";
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
  /** Imported research only: which sheet tab / CSV this document holds, and its display title. */
  docKey?: string;
  title?: string | null;
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
    /** "maton": no direct connection; Search Console is read through the workspace's Maton.ai key (project setting). */
    via?: "direct" | "maton";
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
    /**
     * Where `model` comes from: "workspace" (picked on the Integrations page), "operator" (env var),
     * "default" (TypeSafe's documented jev-latest alias), null (no model: setup_required "choose a model").
     */
    modelSource?: ModelSource | null;
    /**
     * Whether providers/rates.ts (or the TypeSafe price table) has a verified rate for `model`; false means
     * cost is recorded as unknown (null), never guessed. null when not applicable (writer, no model).
     */
    rateKnown?: boolean | null;
    /**
     * The workspace's stored model selection, also when it is not in effect (TypeSafe on the operator key);
     * null when none. Lets the owner reset it.
     */
    workspaceModel?: string | null;
    /**
     * Plain-text note about the model in effect, e.g. why a workspace-chosen model cannot run on the operator
     * key (then `state` is setup_required) or that the operator key ignores a TypeSafe selection. null when none.
     */
    modelNote?: string | null;
    dataSent: string; // disclosure: what project data goes to this provider
  }>;
}

/** Built-in providers whose model a workspace can choose (the writer has its own custom provider flow). */
export type ModelSelectableProviderId = "typesafe" | "gemini" | "perplexity" | "openai_geo" | "anthropic_geo";
export type ModelSource = "workspace" | "operator" | "default";

/** One entry of a provider's model list. `id` and `label` are untrusted provider text (plain text only). */
export interface ProviderModelOption {
  id: string;
  label: string;
}

/** POST /workspaces/:wid/credentials/:provider/models. */
export interface ProviderModelList {
  /** true: list received; false: rejected/failed; null: not confirmed (rate limited) or no list endpoint. */
  ok: boolean | null;
  detail: string;
  models: ProviderModelOption[];
  total: number;
  truncated: boolean;
  /** Which key listed the models. */
  keySource: "typed_key" | "workspace_key" | "operator_key" | null;
  /** Feature the model must support for this lane (e.g. "web search"); not verifiable from a list. */
  mustSupport: string | null;
}

// ------------------------------------------------------------------ custom (OpenAI-compatible) providers
/**
 * Which writer a workspace uses: the operator-configured default (WRITER_PROVIDER / WRITER_MODEL with the
 * workspace's or the operator's writer key), or one of the workspace's custom providers.
 */
export type WriterSource = "default" | `custom:${string}`;

/** A workspace custom provider as the API returns it. The API key is never included (only its last 4 characters). */
/** writer: a custom writer (0010); geo: a custom GEO engine lane (0011; citation rate only for answers with provider-reported sources, else mention rate only); chat: Ask Okara's own chat model (0019, [A36]). */
export type CustomProviderRole = "writer" | "geo" | "chat";

/**
 * Which model Ask Okara uses [A36]: "writer" (default; the workspace writer, exactly as before) or "custom:<id>" (a
 * custom provider with role "chat"). PUT /workspaces/:wid/chat-model-source.
 */
export type ChatModelSource = "writer" | `custom:${string}`;

export interface CustomProviderStatus {
  id: string;
  /** Absent in responses from builds before migration 0011 (then "writer"). */
  role?: CustomProviderRole;
  label: string;
  /** Normalised https base URL; `/models` and `/chat/completions` are appended to it. */
  baseUrl: string;
  host: string;
  /** Untrusted provider-defined id; render as plain text. */
  model: string;
  keyHint: string;
  /** True when this provider is the workspace's writer. */
  isWriter: boolean;
  /** True when this provider (role "chat") is Ask Okara's selected chat model. Absent before migration 0019. */
  isChat?: boolean;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  lastTestDetail: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CustomProvidersResponse {
  providers: CustomProviderStatus[];
  writerSource: WriterSource;
  maxProviders: number;
  /** Only the workspace owner can add, change, select or remove custom providers. */
  canManage: boolean;
  /** Disclosure: what data a custom writer receives. */
  dataSent: string;
  /** Most custom GEO engine lanes per workspace (rows with role "geo"; counted separately from writers). */
  maxGeoEngines?: number;
  /** Disclosure: what data a custom GEO engine receives. */
  geoDataSent?: string;
  /** [A36] Ask Okara's model source: "writer" (default) or "custom:<id>" of a role "chat" provider. */
  chatSource?: ChatModelSource;
  /** Most Ask Okara chat providers (role "chat") per workspace. */
  maxChatProviders?: number;
  /** Disclosure: what data a custom chat provider receives. */
  chatDataSent?: string;
}

/** POST /workspaces/:wid/custom-providers/models. `models` are untrusted ids (plain text). */
export interface CustomProviderModelList {
  ok: boolean | null;
  detail: string;
  models: string[];
  total: number;
  truncated: boolean;
}

export interface CustomProviderInput {
  label?: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  /** Select it as the workspace writer (default true; role "writer" only). */
  useAsWriter?: boolean;
  /** Select it as Ask Okara's chat model (default true; role "chat" only). */
  useAsChat?: boolean;
  /** "geo" adds a custom GEO engine lane, "chat" an Ask Okara chat model, instead of a writer (default "writer"). */
  role?: CustomProviderRole;
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
  /** e.g. "Imported from sheet 2026-10-02"; null for sets saved on the GEO prompts page. */
  label?: string | null;
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
  /** Partial ("section") run: the work steps it ran (src/shared/run-scope.ts); null = every step. */
  scope?: RunScope | null;
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
  /** Sheet-linked imports whose last sync failed (token expired, tab renamed/deleted, header changed...). */
  importSyncs?: Array<{ id: string; spreadsheetTitle: string; tab: string; destination: string; code: string | null; message: string | null; lastRunAt: string | null }>;
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
  /** Drafts only: the page type to evaluate the draft as (default article). */
  pageType?: PageType;
  /** Drafts only: product fields (name -> value) the text must agree with; at most 20, key <= 60, value <= 300 characters. */
  productFacts?: Record<string, string>;
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
/**
 * A workspace custom OpenAI-compatible GEO engine lane: "custom_geo:<workspace_custom_providers.id>".
 * No tool is requested. An answer whose response returns web sources (OpenAI-compatible url_citation annotations,
 * or Perplexity-style citations / search_results) is stored grounded with those sources as citations and counts
 * toward citation rate; an answer without sources is ungrounded and counts toward mention rate only.
 */
export type CustomGeoProviderId = `custom_geo:${string}`;
/** Any lane of the AI engine board: a built-in engine or a custom GEO engine. */
export type BoardLaneProviderId = GeoEngineProviderId | CustomGeoProviderId;
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
  /**
   * Built-in engine, or "custom_geo:<id>" for a custom GEO engine (grounded only for answers with
   * provider-reported sources; citationRate.denominator 0 = citation rate not measured for this lane).
   */
  provider: BoardLaneProviderId;
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
  lanes: EngineLaneSummary[]; // fixed order: openai_geo, anthropic_geo, gemini, perplexity, then custom GEO engines (custom_geo:<id>)
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
  /** Built-in engine or a custom GEO engine lane ("custom_geo:<id>", only when it has grounded answers). */
  engine: BoardLaneProviderId | null;
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
  /**
   * Presence of the attribute on the cited page (what the board's radar plots). Optional so older stored
   * assessments still parse; when absent the UI derives it from noul/tier for Jev checks, else "unknown".
   */
  status?: FactorStatus;
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
  /** Built-in engine or a custom GEO engine lane ("custom_geo:<id>", only when it has grounded answers). */
  engine: BoardLaneProviderId | null;
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

// ---------------------------------------------------------------------------
// Run activity window (live feed built only from stored rows of a run).
// ---------------------------------------------------------------------------

export type ActivityItemKind = "step" | "page_read" | "engine_answer" | "jev_decision" | "provider_call";

export interface ActivityItem {
  /** Stable, unique across kinds: "obs:<id>", "snap:<id>", "dec:<id>", "call:<id>", "evt:<id>". */
  id: string;
  /** ISO timestamp of the stored row. */
  at: string;
  kind: ActivityItemKind;
  agent: "seo" | "geo" | null;
  /** Short plain text; untrusted text clipped to 160 chars; never HTML. */
  title: string;
  detail: string | null;
  status: "ok" | "warn" | "error" | "info";
  /** gemini|perplexity|openai_geo|anthropic_geo|typesafe|writer|crawler|null */
  provider: string | null;
  latencyMs: number | null;
  /** null = unknown, never 0 for unknown. */
  costUsd: number | null;
  costIsEstimate: boolean;
  /** Page URL for page_read, else null. */
  url: string | null;
  outcome: "cited" | "named" | "missing" | "failed" | "act" | "flag" | "drop" | null;
}

export interface ActivityLane {
  provider: string;
  label: string;
  state: "queued" | "asking" | "done" | "idle";
  done: number;
  planned: number | null;
  lastLatencyMs: number | null;
}

export interface ActivityQueuedItem {
  provider: string;
  label: string;
  promptText: string;
}

export interface RunActivity {
  run: {
    id: string;
    agent: "seo" | "geo";
    status: string;
    trigger: string;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    elapsedMs: number | null;
    /** Partial ("section") run scope; null = every step. */
    scope?: RunScope | null;
  };
  /** status pending|running */
  active: boolean;
  totals: {
    /** Sum of provider_calls.cost_usd for the run; unknownCalls = rows with null cost. */
    spend: { usd: number | null; isEstimate: boolean; unknownCalls: number };
    providerCalls: number;
    pagesRead: number;
    /** crawl_runs.pages_limit when known. */
    pagesPlanned: number | null;
    answers: { cited: number; named: number; missing: number; failed: number };
    decisions: { act: number; flag: number; drop: number };
  };
  /** GEO runs only: one per configured engine. */
  lanes: ActivityLane[];
  /** GEO runs only, while active: up to 12 not-yet-observed (prompt, provider) pairs. */
  queued: ActivityQueuedItem[];
  /** Latest page_read while the crawl step is active. */
  nowReading: { url: string; at: string } | null;
  /** Ascending by (at, id); at most `limit` (default 80, max 200). */
  items: ActivityItem[];
  /** Opaque; pass as ?after= to get only newer items. */
  cursor: string | null;
}

export interface CurrentActivityResponse {
  runs: Array<{ id: string; agent: "seo" | "geo"; status: string }>;
}

// ---------------------------------------------------------------------------
// Live view (UI spec docs/live-view-design.md; endpoints docs/api.md "Live view").
// Run-scoped feeds that RunActivity does not carry as structured fields. Every row is a stored row of
// ONE run; nothing is simulated, interpolated or projected. Steps, page reads, lanes, queued pairs,
// spend and elapsed time stay in RunActivity; project-level panels reuse EngineBoardResponse,
// CompetitorPageAssessment, AnswerCoverageRow, CitationEvidenceRow, PageSkipFactors, RewritePlan,
// LinkSuggestionReport and SeoOverview as they are.
// ---------------------------------------------------------------------------

/**
 * What a judged row is about. The mapping from question ids, Choice options and audit rule ids lives in
 * ONE worker constant: `LIVE_SEO_ELEMENT_MAP` (src/worker/live/elements.ts).
 */
export type LiveSeoElement =
  | "Title"
  | "Meta"
  | "Title + meta"
  | "H1"
  | "Headings"
  | "Intro"
  | "Section"
  | "Compare table"
  | "Content"
  | "Topics"
  | "Freshness"
  | "Schema"
  | "Intent"
  | "Page"
  | "Duplicate"
  | "Links"
  | "Canonical"
  | "Indexing"
  | "Status"
  | "Sitemap"
  | "New page";

/**
 * Computed by code from the STORED tier and raw answer (or the rule class), never from Jev text.
 * Rows still to come in a replay are a client-only "pending" state; the server never sends one.
 */
export type LiveSeoVerdict = "keep" | "change" | "review";

/** Jev's stored judgment for one question: real provider fields only (Noul has no confidence field). */
export interface LiveJevJudgment {
  /** Base question id, e.g. "seo.title_matches_query"; "links.should_exist" for reused link suggestions. */
  questionId: string;
  /** Stored tier (policy at decision time); null when none was stored. */
  tier: Tier | null;
  /** Noul yes-probability; null for Choice answers or when no usable answer was stored. */
  noul: number | null;
  /** Choice answers only: the chosen option and the provider's confidence for it. */
  choice: string | null;
  confidence: number | null;
  /** True provider name ("typesafe" or the real fallback); never relabelled. */
  provider: string | null;
  model: string | null;
}

/** Measured Search Console figures for one page or query (latest usable sync, current window). */
export interface LiveGscMetrics {
  clicks: number;
  impressions: number;
  /**
   * Impression-weighted average position of the stored rows (an approximation for pages; GSC's own value
   * for a single query row); null without impressions.
   */
  position: number | null;
  window: DateWindow;
  /** page_rows = page-dimension rows; query_page_rows = sum of query+page rows (lower bound); query_rows = query rows. */
  basis: "page_rows" | "query_page_rows" | "query_rows";
}

/** Panel "Every SEO element, judged one by one": one stored judgment (Jev decision or audit rule finding). */
export interface LiveSeoElementRow {
  /** "dec:<decision_records.id>" (same id as the RunActivity jev_decision item) or "find:<audit_findings.id>". */
  id: string;
  at: string;
  /**
   * element = an element-specific question; action = the candidate's seo.action_choice (the UI shows it as
   * its own row only when the candidate has no element row); rule = an audit finding of the run's crawl.
   */
  role: "element" | "action" | "rule";
  /** decision_records.candidate_key (groups the rows of one candidate); null for rule rows. */
  candidateKey: string | null;
  /** URL path of the judged page (plain text); null for template- or site-scoped targets. */
  pagePath: string | null;
  url: string | null;
  pageId: string | null;
  /** Always set, e.g. "/products/oak-table", "Template: product pages (3 URLs)", "Site". Plain text. */
  targetLabel: string;
  element: LiveSeoElement;
  /** Base question id for jev rows; the audit rule id (e.g. "SEO-META-DESC-MISSING") for rule rows. */
  questionId: string;
  /**
   * Current stored value of the element from the page's snapshot in this run's crawl (else the latest
   * snapshot), plain text clipped to 160; null when the element has no stored value.
   */
  now: string | null;
  /** The candidate's drafted text (recommendations.suggested_snippet, clipped to 160); null until drafted or when none. */
  proposed: string | null;
  gsc: LiveGscMetrics | null;
  /** null for rule rows. */
  jev: LiveJevJudgment | null;
  rule: { ruleId: string; severity: Severity; class: "fact" | "heuristic" } | null;
  verdict: LiveSeoVerdict;
  /** How the verdict was computed, plain text, e.g. "Noul 0.12, act tier: confident no", "Rule (fact)". */
  verdictBasis: string;
  /** Decision outcome; null for rule rows. */
  outcome: "selected" | "rejected" | null;
  reasonCode: string | null;
  recommendationId: string | null;
  /** Set when the row reused an internal link suggestion (candidate kind internal_link_suggestion). */
  linkSuggestionId: string | null;
}

export type LiveQueryQuestion = "seo.query_relevance" | "seo.buyer_query" | "seo.buyer_ready" | "seo.query_intent";

/** Panel "Queries classified by Jev": one stored answer about one search query. Group rows by `queryKey`. */
export interface LiveSeoQueryRow {
  /** "dec:<decision_records.id>". */
  id: string;
  at: string;
  /** decision_records.candidate_key of the query (rows of one query share it). */
  queryKey: string;
  /** Plain text, clipped to 160 (stored answer_json.query, else parsed from the stored candidate key). */
  query: string;
  questionId: LiveQueryQuestion;
  /** Noul band under the stored tier: act -> yes/no, flag -> middle; null for Choice answers or no usable answer. */
  band: "yes" | "no" | "middle" | null;
  jev: LiveJevJudgment;
  gsc: LiveGscMetrics | null;
}

/** A recommendation created by the run (both agents). Stage and status are as stored at read time. */
export interface LiveRecommendationRow {
  /** "rec:<recommendations.id>". */
  id: string;
  recommendationId: string;
  at: string; // created_at
  agent: AgentKind;
  scope: Scope;
  issueType: string;
  /** URL path, "Template: <name> (N URLs)" or "Site". Plain text. */
  targetLabel: string;
  url: string | null;
  /** Plain text, clipped to 200. */
  action: string;
  suggestedSnippet: string | null;
  stage: RecommendationStage;
  status: RecommendationStatus;
  /** Code-computed priority and its formula version (never a Jev value). */
  priority: number;
  priorityVersion: string;
  effort: Level;
  uncertainty: Level;
  tier: Tier | null;
  evidenceCount: number;
  writer: { provider: string | null; model: string | null };
}

/** Candidates -> judged -> drafted -> approval, counted from the run's stored rows (whole run). */
export interface LivePipelineTotals {
  /** Distinct candidate keys with a decision row in this run (query-batch keys excluded). */
  candidates: number;
  /** Of those, candidates with at least one stored provider answer. */
  judged: number;
  /** Rejected candidates by stored reason_code (e.g. low_fit, duplicate, budget). */
  rejectedByReason: Record<string, number>;
  /** Recommendations created by this run, by current stage and status. */
  created: number;
  byStage: Record<RecommendationStage, number>;
  byStatus: Record<RecommendationStatus, number>;
}

/** The run's Search Console sync (gsc_syncs.run_id), latest attempt. */
export interface LiveGscSync {
  id: string;
  source: "api" | "csv_import" | "demo";
  status: "running" | "completed" | "partial" | "failed" | "no_data";
  window: DateWindow;
  previousWindow: DateWindow;
  rowsFetched: number;
  rowCap: number;
  truncated: boolean;
  syncedAt: string;
  /** Plain text, clipped to 200; null when none. */
  error: string | null;
}

export interface LiveBandCounts {
  yes: number;
  no: number;
  middle: number;
  /** Stored without a usable answer (drop tier or no answer). */
  unanswered: number;
}

/** GET /projects/:pid/live/seo?runId=&after=&limit= */
export interface LiveSeoBoardResponse {
  run: RunActivity["run"];
  active: boolean;
  /** Each list ascending by (at, id); merge pages by id. */
  elements: LiveSeoElementRow[];
  queries: LiveSeoQueryRow[];
  recommendations: LiveRecommendationRow[];
  gscSync: LiveGscSync | null;
  /**
   * Whole run, regardless of `after`; computed only on the last page of a read (a page shorter than `limit`),
   * null on full pages (keep the previous totals).
   */
  totals: {
    elements: {
      judged: number;
      keep: number;
      change: number;
      review: number;
      byElement: Partial<Record<LiveSeoElement, { keep: number; change: number; review: number }>>;
    };
    queries: { distinct: number; relevance: LiveBandCounts; buyer: LiveBandCounts; buyerReady: LiveBandCounts; intent: Record<string, number> };
    pipeline: LivePipelineTotals;
    /** True when a whole-run scan hit its cap (docs/api.md "Live view"); counts are then lower bounds. */
    truncated: boolean;
  } | null;
  /** Opaque; pass as ?after= for newer rows only. */
  cursor: string | null;
  labels: string[];
}

/** One stored engine answer of the run, with the fields the engine columns need. */
export interface LiveGeoAnswerRow {
  /** "obs:<geo_observations.id>" (same id as the RunActivity engine_answer item). */
  id: string;
  observationId: string;
  at: string;
  provider: BoardLaneProviderId;
  promptId: string | null;
  /** Plain text, clipped to 300. */
  promptText: string;
  /** Same definition as RunActivity (answerOutcome); null = stored but not analysed yet (genuinely pending). */
  outcome: "cited" | "named" | "missing" | "failed" | null;
  grounded: boolean;
  latencyMs: number | null;
  cost: CostUsd;
  /** Self brand row list_rank, only for a real ordered list. */
  position: number | null;
  sentiment: { value: Sentiment; method: string } | null;
  recommendationStatus: RecommendationStatusInAnswer | null;
  /** First non-own citation by position. */
  citedInstead: { host: string; url: string | null; sourceType: SourceType } | null;
  /** First own-site citation URL, when cited. */
  ownCitedUrl: string | null;
  citationCount: number;
  /** Engine search queries stored for this answer; null when the provider does not expose them. */
  searchQueryCount: number | null;
  /** Our best page for the prompt (coverage/answer-coverage.ts matchPrompt over the latest crawl); null when none matches. */
  matchedPage: { pageId: string | null; url: string; method: "engine_search_query" | "title_heading_overlap"; score: number } | null;
}

/** This run's answers of one engine lane, by outcome (lanes themselves come from RunActivity). */
export interface LiveGeoLaneTotals {
  provider: BoardLaneProviderId;
  cited: number;
  named: number;
  missing: number;
  /**
   * Of cited + named + missing: answers that were grounded (web sources returned). Citation rate over a custom
   * GEO engine lane uses this denominator; a custom lane with 0 shows its mention rate instead.
   */
  grounded: number;
  failed: number;
  /** Stored 'ok' answers not analysed yet. */
  pending: number;
  /** Sum of the run's observation costs for this lane; value null when any is unknown. */
  cost: CostUsd;
  /** Host most often first-cited in this lane's missing or named answers; answers = how many. */
  citedInstead: { host: string; sourceType: SourceType; answers: number } | null;
}

/** GET /projects/:pid/live/geo?runId=&after=&limit= */
export interface LiveGeoBoardResponse {
  run: RunActivity["run"];
  active: boolean;
  /** Ascending by (at, id); merge pages by id (a held answer can arrive later with its outcome, same id). */
  answers: LiveGeoAnswerRow[];
  /**
   * Prompts the run samples (same selection as geo/batch.ts: approved prompts of the run's set by position,
   * capped per run). Sent only when `after` is absent; null on later pages or when unknown.
   */
  plannedPrompts: Array<{ promptId: string; text: string }> | null;
  recommendations: LiveRecommendationRow[];
  /** Whole run, regardless of `after`; only on the last page of a read (fewer rows than `limit`), else null. */
  totals: { lanes: LiveGeoLaneTotals[]; pipeline: LivePipelineTotals; truncated: boolean } | null;
  cursor: string | null;
  labels: string[];
}

// ------------------------------------------------------------------ custom provider URL changes (appended 2026-10-01)
/**
 * One configuration change of a custom provider (PATCH /workspaces/:wid/custom-providers/:id), from the audit
 * log (migration 0012). Hosts and URLs are configuration, never secrets; no key material is ever included.
 */
export interface CustomProviderChange {
  at: string;
  /** Who changed it (name, else email); null when unknown (user removed). */
  by: string | null;
  /** What changed. */
  fields: Array<"label" | "baseUrl" | "model" | "apiKey">;
  /** Set when the base URL changed; null otherwise. */
  fromBaseUrl: string | null;
  toBaseUrl: string | null;
  fromHost: string | null;
  toHost: string | null;
  /** The host changed and the owner confirmed sending the saved key to the new host (no new key entered). */
  keyKeptForNewHost: boolean;
}

/**
 * Declaration merge (kept as an append so this file's earlier sections stay untouched): the audit trail of a
 * custom provider. Absent from builds before migration 0012.
 */
export interface CustomProviderStatus {
  /** Newest first, at most 5 configuration changes; [] when none (or before migration 0012). */
  changes?: CustomProviderChange[];
}

/**
 * PATCH /workspaces/:wid/custom-providers/:id. A base URL on a NEW host needs either a new `apiKey` or
 * `keepKeyForNewHost: true` (the owner confirmed sending the saved key to that host); otherwise 400
 * `key_required_for_new_host`. The flag is ignored when the host is unchanged or a new key is given.
 */
export interface CustomProviderPatchInput {
  label?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  keepKeyForNewHost?: boolean;
}

// ------------------------------------------------------------------ live view: answer model (appended 2026-10-01)
/** Declaration merge into LiveGeoAnswerRow: the model and grounding mode that produced this stored answer. */
export interface LiveGeoAnswerRow {
  /** geo_observations.model (plain text, clipped). */
  model: string | null;
  /** geo_observations.grounding_mode, e.g. "google_search"; null when not recorded. */
  groundingMode: string | null;
}

// ------------------------------------------------------------------ Ask Okara (chat agent; docs/api.md "Ask Okara (chat)")
/** read = a data tool; action = state-changing, runs only after the user confirms; output = a link or export prepared for the UI. */
export type ChatStepKind = "read" | "action" | "output";
export type ChatStepStatus = "ok" | "error" | "awaiting_confirmation" | "executed" | "failed" | "cancelled" | "expired";

export interface ChatStep {
  id: string;
  kind: ChatStepKind;
  /** Tool name as the model called it, e.g. "search_console_queries". */
  tool: string;
  /** Short plain-text summary of the arguments, e.g. "mode=declining, dimension=page, limit=10". */
  args: string;
  /** Short plain-text summary of the result, e.g. "10 pages · 2026-08-30..2026-09-26 vs previous 28 days". */
  result: string;
  status: ChatStepStatus;
  /** Set for kind "action": the action to confirm or cancel. */
  actionId?: string | null;
  /** Set for kind "output": an in-app route the user can open (always under /projects/<pid>/). */
  navigate?: { path: string; label: string } | null;
  /** Set for kind "output": rows for a client-side CSV download (capped server-side). */
  download?: { filename: string; columns: string[]; rows: Array<Array<string | number | null>>; truncated: boolean } | null;
}

export type ChatMessageStatus = "complete" | "running" | "awaiting_confirmation" | "stopped" | "error";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  /** User text, or the model's answer (render as sanitized markdown-lite, never raw HTML). */
  content: string;
  status: ChatMessageStatus;
  steps: ChatStep[];
  error: string | null;
  model: { provider: string; model: string } | null;
  createdAt: string;
}

export interface ChatAction {
  id: string;
  messageId: string;
  name: string;
  /** Plain-text question shown on the confirmation card, e.g. "Run the SEO agent now?". */
  title: string;
  detail: string;
  args: Record<string, unknown>;
  status: "pending" | "executing" | "executed" | "failed" | "cancelled" | "expired";
  result: string | null;
  createdAt: string;
  decidedAt: string | null;
  /**
   * [A35] Set while a credential action is pending: the confirmation card shows password inputs and, on Confirm,
   * the browser sends the values DIRECTLY to `request` (an existing credential route), then confirms the chat
   * action with only {ok, keyHint}. The values never enter the chat, the model or any chat table.
   */
  secretField?: ChatSecretField | null;
}

/** A secure-input confirmation card (see ChatAction.secretField). Values typed into it never reach the chat. */
export interface ChatSecretField {
  /** Heading, e.g. "Google Gemini API key". */
  label: string;
  fields: Array<{ name: "apiKey" | "login" | "password"; label: string }>;
  /** The existing credential route the browser calls (same origin, CSRF-protected); non-secret body fields only. */
  request: { method: "PUT" | "POST" | "PATCH"; path: string; body: Record<string, string | boolean> };
  /** The field whose last 4 characters are the key hint (as the Integrations page shows it). */
  hintFrom: "apiKey" | "password";
  note: string;
}

/** Body of POST .../actions/:aid/confirm for an action with a secretField (never the key itself). */
export interface ChatConfirmBody {
  secret?: { ok: boolean; keyHint?: string | null };
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  status: "idle" | "running" | "awaiting_confirmation";
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChatSessionDetail extends ChatSessionSummary {
  messages: ChatMessage[];
  actions: ChatAction[];
}

export interface ChatStatus {
  state: "ready" | "setup_required";
  /** The configured chat model (the workspace writer, or the chat model chosen for Ask Okara [A36]); never a default id. */
  model: { provider: string; model: string } | null;
  /** [A36] "writer": Ask Okara uses the workspace writer; "custom": its own chat model (Integrations → Ask Okara chat model). */
  source?: "writer" | "custom";
  message: string | null;
  limits: { maxMessageChars: number; maxToolRounds: number; sessionsKept: number };
}

/** POST .../messages and .../actions/:id/(confirm|cancel) response (JSON mode; the ndjson stream ends with the same object). */
export interface ChatTurnResult {
  session: ChatSessionSummary;
  /** The user message (absent for confirm/cancel) and the assistant message of this turn. */
  userMessage: ChatMessage | null;
  message: ChatMessage;
  actions: ChatAction[];
}

/**
 * [A40] Progress of a turn: "model" = waiting for the model (round n), "tools" = running these tools. The panel shows
 * "Thinking…", "Reading Search Console…"; the first text_delta of a round means "Writing answer…".
 */
export type ChatPhase = "model" | "tools";

/** One line of the ndjson stream (?stream=1). */
export type ChatStreamEvent =
  | { type: "started"; sessionId: string; userMessage: ChatMessage | null; messageId: string }
  | { type: "step"; step: ChatStep }
  | { type: "status"; text: string }
  /** [A40] Masked answer text as it is generated: append `delta` to round `round`'s text (reset: replace it). A new round
   *  replaces the previous round's text. Display only: the `done` result carries the stored answer. */
  | { type: "text_delta"; round: number; delta: string; reset?: boolean }
  /** [A40] What the turn is doing now. */
  | { type: "phase"; phase: ChatPhase; round: number; tools?: string[] }
  | { type: "done"; result: ChatTurnResult }
  | { type: "error"; code: string; message: string };

// ------------------------------------------------------------------ live view: project containers (appended 2026-10-03)
// GET /projects/:pid/live/insights?kind=<LiveInsightKind> (docs/api.md "Live view: project containers",
// docs/live-view-design.md section 17). Read-only, bounded aggregates of stored rows for the Live view's
// project-level containers (SEO 10-15, GEO 06-11). No provider call, no Jev, no budget; untrusted text
// (queries, URLs, titles, sheet names, errors) is clipped plain text.

export type LiveInsightKind =
  | "striking"
  | "movers"
  | "technical"
  | "engine_queries"
  | "brands"
  | "cited_domains"
  | "prompt_history"
  | "sheets"
  | "budget";

/** The Search Console sync an insight was read from: the latest usable sync (completed or partial). */
export interface LiveInsightSync {
  syncId: string;
  /** agent_runs id of the run that stored the sync (null for a CSV import). */
  runId: string | null;
  source: "api" | "csv_import" | "demo";
  syncedAt: string;
  current: DateWindow;
  previous: DateWindow;
  /** The sync hit its row cap: rows may be missing. */
  truncated: boolean;
}

/** A time window of stored rows (ISO instants; `to` is the request time). */
export interface LiveInsightWindow {
  from: string;
  to: string;
  days: number;
}

interface LiveInsightCommon {
  /** "demo" for demo projects (rows are the labelled demo seed); "setup_required" with `message` when the source is not set up. */
  state: CapabilityState;
  message: string | null;
  generatedAt: string;
  /** Data notes (demo label, basis, caps), plain text. */
  labels: string[];
  /** A read cap was hit: counts are lower bounds. */
  truncated: boolean;
}

/** One query+page row of the current window in striking distance. */
export interface LiveStrikingRow {
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  /** clicks / impressions of this row; null without impressions. */
  ctr: number | null;
  /** Search Console's average position of the query+page row. */
  position: number;
  /** The same query+page in the previous window, when stored. */
  previous: { clicks: number; impressions: number; position: number } | null;
}

export interface LiveStrikingInsight extends LiveInsightCommon {
  kind: "striking";
  sync: LiveInsightSync | null;
  /** src/worker/live/insights-lib.ts STRIKING_DISTANCE. */
  thresholds: { minPosition: number; maxPosition: number; minImpressions: number; maxRows: number };
  rows: LiveStrikingRow[];
  /** Query+page rows in range (all of them; `rows` lists the first maxRows by impressions). */
  total: number;
}

export interface LivePageWindowMetrics {
  clicks: number;
  impressions: number;
  /** Impression-weighted position of the stored rows (an approximation); null without impressions. */
  position: number | null;
}

export interface LivePageMover {
  page: string;
  current: LivePageWindowMetrics;
  previous: LivePageWindowMetrics;
  /** current.clicks - previous.clicks: a measured difference, not a trend. */
  clickDelta: number;
}

export interface LiveMoversInsight extends LiveInsightCommon {
  kind: "movers";
  sync: LiveInsightSync | null;
  /** page_rows = page-dimension rows; query_page_rows = sums of query+page rows (a lower bound); null without data. */
  basis: "page_rows" | "query_page_rows" | null;
  gainers: LivePageMover[];
  losers: LivePageMover[];
  /** Pages in both windows (and how many of them have no click difference), only in the current window, only in the previous one. */
  counts: { both: number; unchanged: number; newPages: number; lostPages: number };
  /** Gainers and losers listed at most. */
  top: number;
}

export interface LiveTechnicalGroup {
  severity: Severity;
  ruleId: string;
  ruleName: string;
  area: string;
  class: "fact" | "heuristic";
  count: number;
  /** First findings of the group (URL order), plain text. */
  examples: Array<{ url: string | null; template: string | null; detail: string }>;
}

export interface LiveTechnicalInsight extends LiveInsightCommon {
  kind: "technical";
  /** The latest completed or partial crawl (null when none). */
  crawl: {
    id: string;
    runId: string | null;
    status: "completed" | "partial";
    startedAt: string;
    finishedAt: string | null;
    pagesCrawled: number;
    pagesSkipped: number;
    pagesLimit: number;
  } | null;
  /** A newer crawl that is running or failed: its findings are not shown. */
  newer: { status: string; startedAt: string } | null;
  bySeverity: Record<Severity, number>;
  total: number;
  groups: LiveTechnicalGroup[];
}

export interface LiveEngineQueryRow {
  /** Normalized engine search query (plain text). */
  query: string;
  engines: string[];
  /** Distinct stored answers whose engine ran this search. */
  answers: number;
  lastSeen: string;
  /** Exact match of the normalized query in the latest usable Search Console sync (current window); null = no exact match. */
  gsc: LiveGscMetrics | null;
}

export interface LiveEngineQueriesInsight extends LiveInsightCommon {
  kind: "engine_queries";
  window: LiveInsightWindow;
  rows: LiveEngineQueryRow[];
  /** Distinct normalized queries in the window. */
  total: number;
  /** The sync the exact match was looked up in; null without a usable sync (no match attempted). */
  gscSync: { syncedAt: string; window: DateWindow } | null;
  limit: number;
}

export interface LiveBrandCounts {
  /** Analysed answers that checked this brand (the denominator m of "n of m answers"). */
  answers: number;
  mentioned: number;
  cited: number;
  recommended: number;
  negative: number;
}

export interface LiveBrandRow {
  brandKey: string;
  name: string;
  isSelf: boolean;
  engines: Array<{ provider: string } & LiveBrandCounts>;
  total: LiveBrandCounts;
}

export interface LiveBrandsInsight extends LiveInsightCommon {
  kind: "brands";
  window: LiveInsightWindow;
  engines: string[];
  brands: LiveBrandRow[];
}

export interface LiveCitedDomainRow {
  /** Resolved citation host (no "www."). */
  host: string;
  /** Distinct stored answers citing the host. */
  answers: number;
  citations: number;
  engines: string[];
  /** Source types of its citations, most frequent first. */
  sourceTypes: SourceType[];
  /** key "self" = your site; a tracked competitor's name when the host is one of its domains; null otherwise. */
  brand: { key: string; isSelf: boolean } | null;
  /** 1-based position by answers (then citations, then host). */
  rank: number;
}

export interface LiveCitedDomainsInsight extends LiveInsightCommon {
  kind: "cited_domains";
  window: LiveInsightWindow;
  rows: LiveCitedDomainRow[];
  /** Your site's row when it is cited but not among `rows`. */
  own: LiveCitedDomainRow | null;
  /** Stored answers with at least one citation (denominator of `answers`). */
  answersWithCitations: number;
  totalHosts: number;
  /** Provider redirect links whose destination is unknown (not counted as a domain). */
  unresolved: number;
  limit: number;
}

/** cited / named (mentioned, site not cited) / missing (absent) / failed call / stored but not analysed / no stored answer. */
export type LiveHistoryCell = "cited" | "named" | "missing" | "failed" | "not_analysed" | "none";

export interface LivePromptHistoryInsight extends LiveInsightCommon {
  kind: "prompt_history";
  promptSet: { version: number; label: string | null } | null;
  /** Per engine: the runs shown, oldest first (at most maxRuns runs in which that engine stored answers). */
  engines: Array<{ provider: string; runs: Array<{ runId: string; at: string }> }>;
  /** Approved prompts of the active set; cells[provider][i] belongs to engines[provider].runs[i]. */
  rows: Array<{ promptId: string; text: string; cells: Record<string, LiveHistoryCell[]> }>;
  maxRuns: number;
}

export interface LiveSheetSyncRow {
  id: string;
  spreadsheetTitle: string;
  tab: string;
  destination: "geo_prompts" | "competitors" | "implemented_links";
  enabled: boolean;
  frequencyHours: number;
  lastRunAt: string | null;
  lastStatus: "never" | "ok" | "error";
  lastErrorCode: string | null;
  lastError: string | null;
  lastWarning: string | null;
  nextRunAt: string;
  /** Changes this sync applied in the last `days` days (import_changes of its imports). */
  recent: { days: number; imports: number; added: number; updated: number; removed: number };
  /** geo_prompts syncs: what the tab feeds (import_records of this tab and the active prompt set). */
  prompts: { inSet: number; setFull: number; archived: number; approved: number; lastAskedAt: string | null } | null;
}

export interface LiveSheetsInsight extends LiveInsightCommon {
  kind: "sheets";
  /** The viewer is the workspace owner (Sync now). */
  canManage: boolean;
  /** Google Sheets connection state (SheetsConnectionStatus.state). */
  sheets: "ready" | "setup_required" | "disabled" | "error" | "demo";
  activePromptSet: { version: number; label: string | null; approved: number; prompts: number } | null;
  syncs: LiveSheetSyncRow[];
  /** "Sync now" presses allowed per sync per hour (src/worker/imports/sync.ts). */
  syncNowPerHour: number;
}

export interface LiveBudgetLine {
  resource: "usd_micros" | "provider_calls" | "jev_calls" | "writer_tokens" | "crawl_pages" | "gsc_rows" | "geo_prompts";
  label: string;
  used: number;
  limit: number;
  /** False when no counter row exists today (nothing reserved yet; the limit is today's setting). */
  counted: boolean;
}

export interface LiveBudgetInsight extends LiveInsightCommon {
  kind: "budget";
  /** UTC day (YYYY-MM-DD). */
  day: string;
  project: LiveBudgetLine[];
  /** The operator's global allowance, only for resources whose cap applies to this workspace's keys; empty when none does. */
  global: LiveBudgetLine[];
  manualRuns: { used: number; limit: number };
  /** Which key each provider uses for this workspace (no key values): workspace_key, operator_key, or null (not set up). */
  keys: Array<{ provider: string; label: string; source: "workspace_key" | "operator_key" | null }>;
  notes: string[];
}

export type LiveInsight =
  | LiveStrikingInsight
  | LiveMoversInsight
  | LiveTechnicalInsight
  | LiveEngineQueriesInsight
  | LiveBrandsInsight
  | LiveCitedDomainsInsight
  | LivePromptHistoryInsight
  | LiveSheetsInsight
  | LiveBudgetInsight;

// ------------------------------------------------------------------ internal links workbench (2026-10-03)
// Owner request 2026-10-03 ("all eight improvements"): full-site link graph from a rolling crawl, hubs and clusters,
// Search Console priority, drafted sentences, broken/redirected links, anchor audit, auto-verification, sheet export.
// API: docs/api.md "Internal links workbench". Fields added to existing interfaces use declaration merging (optional
// fields only) so the interfaces above stay unchanged for their current readers (Live view, Ask Okara).

export type LinkVerificationStatus = "pending" | "verified" | "not_found" | "source_unavailable" | "not_checked";

export interface LinkVerificationView {
  status: LinkVerificationStatus;
  /** fetched_at of the source snapshot that was checked; null when none yet. */
  checkedAt: string | null;
  matchedVia: "target" | "final_url" | "canonical" | "redirecting_url" | null;
  /** Plain text, e.g. "Verified on 2026-10-02: the source page links to the target." */
  detail: string | null;
  /** Short label: "verified on 2026-10-02", "not found in crawl of 2026-10-02", "pending next crawl". */
  label: string;
}

export interface LinkPriorityView {
  value: number;
  relevance: number;
  impact: number;
  targetFactor: number;
  sourceFactor: number;
  clusterFactor: number;
  positionBand: "top_3" | "near_top" | "striking_distance" | "beyond_20" | "none";
  target: { impressions: number | null; clicks: number | null; position: number | null; basis: "page_rows" | "query_page_rows" | null };
  source: { inlinks: number; clicks: number | null };
  /** "Search Console 2026-09-01 – 2026-09-28, stored sync 2026-09-30"; null without Search Console data. */
  gscLabel: string | null;
  /** Plain-text lines: the formula with the numbers behind this priority. */
  explanation: string[];
  version: string;
}

export interface LinkDraftView {
  /** The drafted sentence (plain text); contains the anchor exactly once. */
  text: string;
  /** Always "Draft sentence — review before publishing". */
  label: string;
  /** Evidence the writer was given (source sentences, target title/H1), cited by id. */
  evidence: Array<{ id: string; text: string }>;
  citedEvidenceIds: string[];
  validation: { ok: boolean; errors: string[]; warnings: string[] };
  /** Where to insert it: after this existing sentence of the source page (plain text), when the writer named one. */
  insertAfter: string | null;
  writer: { provider: string; model: string } | null;
}

export interface LinkSuggestion {
  /** Versioned priority (relevance x Search Console impact x cluster gap) with the numbers behind it. */
  priority?: LinkPriorityView | null;
  /** existing_sentence = "wrap existing" (link an existing sentence); draft_sentence = "insert PK sentence". */
  placement?: "existing_sentence" | "draft_sentence";
  draft?: LinkDraftView | null;
  cluster?: { hubUrl: string; hubTitle: string | null; gap: "hub_to_spoke" | "spoke_to_hub" | null } | null;
  verification?: LinkVerificationView | null;
  /** The source snapshot used (stale when older than 30 days). */
  sourceSnapshot?: { fetchedAt: string; stale: boolean } | null;
}

export interface LinkGraphSummary {
  state: CapabilityState;
  graphId: string | null;
  builtAt: string | null;
  trigger: "crawl" | "manual" | "run" | "demo" | null;
  /** "N of M sitemap URLs analysed (oldest snapshot <date>)". */
  coverageLabel: string | null;
  coverage: {
    sitemapUrls: number;
    sitemapAnalysed: number;
    pagesWithSnapshot: number;
    oldestSnapshot: string | null;
    newestSnapshot: string | null;
    stalePages: number;
    staleDays: number;
    neverCrawledSitemap: number;
    linkOnlyNodes: number;
  } | null;
  counts: {
    urls: number;
    edges: number;
    contentEdges: number;
    orphans: number;
    noContentLinks: number;
    redirects: number;
    clientErrors: number;
    serverErrors: number;
    hubs: number;
    spokes: number;
    linkedSpokes: number;
    partialSpokes: number;
    unlinkedSpokes: number;
    unassignedSpokes: number;
    anchorFlagged: number;
    verified: number;
    notFound: number;
    pending: number;
    sourceUnavailable: number;
  } | null;
  rolling: { inventoryUrls: number; neverCrawled: number; cursorOrd: number | null; passes: number; sitemapReadAt: string | null; pagesPerRun: number } | null;
  /** started_at of a crawl that finished after this graph was built (rebuild to include it). */
  newerCrawl: string | null;
  gscLabel: string | null;
  labels: string[];
  versions: Record<string, string>;
}

export type LinkGraphFilter = "all" | "orphans" | "no_content_links" | "issues" | "stale" | "not_crawled" | "hubs" | "sitemap" | "anchor_flags";
export type LinkGraphSort = "url" | "links_in" | "content_links_in" | "links_out" | "impressions" | "fetched_at";

export interface LinkGraphUrlRow {
  key: string;
  url: string;
  title: string | null;
  pageType: string | null;
  inSitemap: boolean;
  crawled: boolean;
  statusCode: number | null;
  finalUrl: string | null;
  redirectHops: number | null;
  fetchedAt: string | null;
  stale: boolean;
  indexable: boolean;
  noindex: boolean;
  canonicalUrl: string | null;
  linksIn: number;
  contentLinksIn: number;
  linksOut: number;
  contentLinksOut: number;
  orphan: boolean;
  issue: "redirect" | "client_error" | "server_error" | null;
  isHub: boolean;
  hubUrl: string | null;
  hubMethod: string | null;
  gsc: { impressions: number; clicks: number; position: number | null } | null;
  anchorFlags: string[];
}

export interface LinkGraphUrlPage {
  graphId: string | null;
  rows: LinkGraphUrlRow[];
  total: number;
  offset: number;
  limit: number;
  filter: LinkGraphFilter;
  sort: LinkGraphSort;
  dir: "asc" | "desc";
  q: string | null;
}

export interface LinkGraphUrlDetail {
  row: LinkGraphUrlRow;
  inbound: Array<{ url: string; title: string | null; anchor: string | null; kind: "content" | "image" | "breadcrumb" | "navigation"; via: "redirect" | "canonical" | null }>;
  /** Sources stored for the expanded row (capped); row.linksIn is the exact count. */
  inboundShown: number;
  outbound: Array<{ url: string; title: string | null; statusCode: number | null; issue: LinkGraphUrlRow["issue"] }>;
  redirectChain: Array<{ status: number; to: string }>;
  anchors: AnchorAuditView | null;
}

export interface AnchorAuditView {
  url: string;
  title: string | null;
  anchoredInlinks: number;
  distinctAnchors: number;
  keyword: string | null;
  keywordBasis: "search_console_query" | "h1" | "title" | null;
  exactMatchShare: number | null;
  top: Array<{ text: string; sources: number }>;
  generic: Array<{ text: string; sources: number }>;
  emptyAnchors: number;
  queryTerms: string[];
  flags: Array<"exact_match_heavy" | "repeated_anchor" | "generic_anchor" | "empty_anchor" | "no_query_terms">;
  reasons: string[];
}

export interface AnchorAuditReport {
  state: CapabilityState;
  graphId: string | null;
  builtAt: string | null;
  rows: AnchorAuditView[];
  total: number;
  thresholds: Record<string, number>;
  labels: string[];
}

export interface LinkSpokeView {
  key: string;
  url: string;
  title: string | null;
  type: "article" | "product";
  method: "owner" | "sheet" | "collection_membership" | "existing_links" | "tfidf";
  methodLabel: string;
  similarity: number | null;
  hubToSpoke: boolean;
  spokeToHub: boolean;
}

export interface LinkHubView {
  key: string;
  url: string;
  title: string | null;
  source: "collection" | "sheet" | "owner";
  sourceLabel: string;
  spokes: LinkSpokeView[];
  linked: number;
  partial: number;
  unlinked: number;
}

export interface LinkClusterReport {
  state: CapabilityState;
  graphId: string | null;
  builtAt: string | null;
  hubs: LinkHubView[];
  unassigned: Array<{ key: string; url: string; title: string | null; type: "article" | "product" }>;
  counts: { hubs: number; spokes: number; linked: number; partial: number; unlinked: number; unassigned: number };
  labels: string[];
}

export interface BrokenLinkRow {
  sourceUrl: string;
  sourceTitle: string | null;
  anchor: string | null;
  kind: "content" | "image" | "breadcrumb" | "navigation";
  targetUrl: string;
  statusCode: number | null;
  issue: "redirect" | "client_error" | "server_error";
  finalUrl: string | null;
  finalStatus: number | null;
  chain: Array<{ status: number; to: string }>;
  /** "Link to <final URL>" or "Remove or replace the link". */
  fix: string;
  targetCheckedAt: string | null;
  sourceCheckedAt: string | null;
  stale: boolean;
  /** Linked from at least this many pages (navigation/template links: fix once in the theme). */
  linkedFrom: number;
}

export interface BrokenLinksReport {
  state: CapabilityState;
  graphId: string | null;
  builtAt: string | null;
  rows: BrokenLinkRow[];
  targets: number;
  totalLinks: number;
  truncated: boolean;
  unchecked: number;
  labels: string[];
}

export interface PlacedLinkRow {
  key: string;
  sourceUrl: string;
  targetUrl: string;
  anchor: string | null;
  origins: Array<"implemented" | "accepted" | "sheet">;
  suggestionId: string | null;
  placedOn: string | null;
  method: string | null;
  hub: string | null;
  verification: LinkVerificationView;
}

export interface PlacedLinksReport {
  state: CapabilityState;
  rows: PlacedLinkRow[];
  counts: { total: number; verified: number; notFound: number; pending: number; sourceUnavailable: number; notChecked: number };
  labels: string[];
}

export interface LinkSuggestionReport {
  /** Link graph summary (coverage, counts) for the workbench header. */
  graph?: LinkGraphSummary | null;
  /** Drafted sentences ("insert PK sentence") in the latest run. */
  drafts?: { state: "ready" | "setup_required" | "partial" | "demo"; drafted: number; rejected: number; candidates: number; cap: number; label: string } | null;
  priorityVersion?: string | null;
}

export interface AttentionFeed {
  /** Links you marked implemented (or your sheet says are placed) that the latest crawl of the source page did not find. */
  linkVerification?: { notFound: number; checkedAt: string | null; examples: Array<{ sourceUrl: string; targetUrl: string }> } | null;
}

export interface AttentionFeed {
  /** Backlink monitor ([A38]): new negative changes (lost, nofollow, 404, redirected, noindex, target broken) in the last 7 days. */
  backlinkChanges?: { negative: number; since: string; examples: Array<{ backlinkId: string; liveUrl: string; targetUrl: string; message: string; detectedAt: string }> } | null;
}
