/**
 * Provider interfaces. Implementations live next to this file; agent modules depend only on these
 * types so they can be tested with fakes. Every real call is logged to provider_calls by the caller
 * via `CallRecorder`.
 */
import type { SourceType } from "@shared/types";

// ------------------------------------------------------------------ call accounting
export interface ProviderCallRecord {
  provider: string;
  model: string | null;
  purpose: string;
  status: "ok" | "error" | "timeout" | "unknown";
  requestId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  searchRequests?: number | null;
  /** null = unknown. Never record 0 for an unknown cost. */
  costUsd: number | null;
  costIsEstimate: boolean;
  rateVersion?: string | null;
  latencyMs?: number | null;
  error?: string | null;
}

export interface CallRecorder {
  record(call: ProviderCallRecord): Promise<void>;
}

// ------------------------------------------------------------------ decision (Jev)
/** Question definitions mirror the TypeSafe SDK shapes (see @typesafe-ai/sdk). */
export type DecisionQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: readonly [string, string, ...string[]] }
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } };

export type DecisionAnswer =
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number>; legend?: Record<string, string> }
  | { type: "noul"; noul: number };

export interface DecisionRequest {
  purpose: string;
  state: unknown;
  questions: Record<string, DecisionQuestion>;
}

export interface DecisionResult {
  provider: "typesafe" | string; // true provider name; fallback output is never labelled 'typesafe'
  model: string;
  answers: Record<string, DecisionAnswer | undefined>;
  usage: { inputTokens: number; outputTokens: number };
}

export interface DecisionProvider {
  readonly name: string;
  decide(req: DecisionRequest): Promise<DecisionResult>;
  /** Free credential check (TypeSafe: models.list()). */
  test(): Promise<{ ok: boolean; detail: string }>;
}

// ------------------------------------------------------------------ writing
export interface WritingRequest {
  /** seo_link_sentence: one drafted sentence per internal-link pair ("insert PK sentence", links/draft.ts). */
  purpose: "seo_recommendation" | "geo_proposal" | "geo_prompt_generation" | "seo_link_sentence";
  system: string;
  input: unknown; // serialized to JSON for the model
  jsonSchema: Record<string, unknown>;
  maxOutputTokens: number;
}

export interface WritingResult {
  provider: string;
  model: string;
  output: unknown; // parsed JSON; caller validates with zod
  usage: { inputTokens: number; outputTokens: number };
}

export interface WritingProvider {
  readonly name: string;
  readonly model: string;
  write(req: WritingRequest): Promise<WritingResult>;
  test(): Promise<{ ok: boolean; detail: string }>;
}

// ------------------------------------------------------------------ GEO answer engines
export interface GeoCitation {
  url: string;
  title: string | null;
  position: number | null;
}

export interface GeoAnswer {
  provider: string; // 'gemini' | 'perplexity'
  model: string; // exact model id returned or requested
  groundingMode: string; // 'google_search' | 'perplexity_web_search' | 'none'
  status: "ok" | "failed" | "incomplete";
  grounded: boolean; // true only if provider metadata proves a search happened
  text: string | null;
  citations: GeoCitation[];
  /** Search queries the engine issued, when the provider exposes them; null = not exposed. */
  searchQueries: string[] | null;
  requestId: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null; searchRequests: number | null };
  costUsd: number | null;
  costIsEstimate: boolean;
  rateVersion: string | null;
  error: string | null;
  latencyMs: number;
}

export interface GeoProvider {
  readonly id: string;
  readonly label: string; // e.g. "Gemini API with Google Search grounding"
  readonly model: string;
  readonly groundingMode: string;
  ask(prompt: string, opts: { locale: string; language: string; signal?: AbortSignal }): Promise<GeoAnswer>;
  test(): Promise<{ ok: boolean; detail: string }>;
}

// ------------------------------------------------------------------ Search Console
export interface GscRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface GscQueryRequest {
  property: string;
  startDate: string;
  endDate: string;
  dimensions: Array<"query" | "page" | "device" | "date" | "country">;
  rowLimit: number;
  startRow: number;
  dataState?: "final" | "all";
  /** Search type (API default "web"); the agent sync always uses "web". */
  type?: "web" | "image" | "video" | "news";
  /** Optional filters (documented searchanalytics.query dimensionFilterGroups; groupType "and"). Sent only when present. */
  dimensionFilterGroups?: GscDimensionFilterGroup[];
}

export type GscFilterDimension = "query" | "page" | "country" | "device";
export type GscFilterOperator = "equals" | "notEquals" | "contains" | "notContains" | "includingRegex" | "excludingRegex";
export interface GscDimensionFilterGroup {
  groupType: "and";
  filters: Array<{ dimension: GscFilterDimension; operator: GscFilterOperator; expression: string }>;
}

export interface GscProvider {
  /** How requests reach Google (absent = the project's direct OAuth connection). Set by platform/gsc-maton.ts. */
  transport?: { kind: "direct" | "maton"; label: string | null };
  listProperties(): Promise<Array<{ siteUrl: string; permissionLevel: string }>>;
  /** `metadata.first_incomplete_date` is set by Google when fresh (dataState "all") data is incomplete. */
  query(req: GscQueryRequest): Promise<{ rows: GscRow[]; responseAggregationType?: string; metadata?: { first_incomplete_date?: string; first_incomplete_hour?: string } }>;
}

// ------------------------------------------------------------------ source classification helper type
export interface SourceClassification {
  sourceType: SourceType;
  method: "rule" | "jev" | "unknown";
}
