/** Fixtures for the AI engines board tests (contract types only; no live data). */
import type { CompetitorPageAssessment, EngineBoardResponse, EngineLaneSummary, PageSkipFactors, RewritePlan } from "../src/shared/types";

export function readyLane(over: Partial<EngineLaneSummary> = {}): EngineLaneSummary {
  return {
    provider: "gemini",
    label: "Gemini API · google_search (API-sampled)",
    model: "gemini-test-model",
    groundingMode: "google_search",
    state: "ready",
    stateDetail: null,
    cohortKey: "cohort-1",
    promptsRun: 523,
    counts: { valid: 523, grounded: 500, failed: 2, incomplete: 0 },
    citationRate: { numerator: 109, denominator: 523, value: 109 / 523 },
    mentionRate: { numerator: 140, denominator: 523, value: 140 / 523 },
    answersCitingUs: 109,
    answersSkippingUs: 380,
    citedInstead: { host: "rival.example", share: { numerator: 80, denominator: 380, value: 80 / 380 } },
    searchQueries: { state: "captured", count: 38 },
    costUsd: { value: 0.307, isEstimate: true },
    lastRunAt: "2026-09-30T10:00:00Z",
    smallSampleWarning: false,
    feed: [
      {
        promptId: "p1",
        promptText: "Best widget vendors <script>alert(1)</script>",
        observationId: "o1",
        status: "missing",
        position: null,
        sentiment: null,
        latencyMs: 377,
        grounded: true,
        citedInstead: { host: "rival.example", url: "https://rival.example/best-widgets/", sourceType: "listicle_roundup" },
        observedAt: "2026-09-30T10:00:00Z",
      },
      {
        promptId: "p2",
        promptText: "Widget A vs Widget B",
        observationId: "o2",
        status: "named",
        position: 2,
        sentiment: { value: "positive", method: "deterministic+jev" },
        latencyMs: null,
        grounded: true,
        citedInstead: null,
        observedAt: "2026-09-30T09:00:00Z",
      },
      {
        promptId: "p3",
        promptText: "Where to buy widgets",
        observationId: "o3",
        status: "cited",
        position: null,
        sentiment: null,
        latencyMs: 1250,
        grounded: true,
        citedInstead: null,
        observedAt: "2026-09-30T08:00:00Z",
      },
      {
        promptId: "p4",
        promptText: "Unrun prompt",
        observationId: null,
        status: "not_run",
        position: null,
        sentiment: null,
        latencyMs: null,
        grounded: false,
        citedInstead: null,
        observedAt: null,
      },
    ],
    ...over,
  };
}

export function setupLane(provider: EngineLaneSummary["provider"] = "openai_geo"): EngineLaneSummary {
  return {
    ...readyLane(),
    provider,
    label: "OpenAI Responses API · web_search (API-sampled)",
    model: null,
    groundingMode: null,
    state: "setup_required",
    stateDetail: "Not implemented yet",
    cohortKey: null,
    promptsRun: 0,
    counts: { valid: 0, grounded: 0, failed: 0, incomplete: 0 },
    citationRate: { numerator: 0, denominator: 0, value: null },
    mentionRate: { numerator: 0, denominator: 0, value: null },
    answersCitingUs: 0,
    answersSkippingUs: 0,
    citedInstead: null,
    searchQueries: { state: "not_exposed", count: 0 },
    costUsd: { value: null, isEstimate: false },
    lastRunAt: null,
    feed: [],
  };
}

export function board(): EngineBoardResponse {
  return {
    state: "ready",
    promptSetVersion: 3,
    generatedAt: "2026-09-30T12:00:00Z",
    lanes: [setupLane("openai_geo"), setupLane("anthropic_geo"), readyLane(), readyLane({ provider: "perplexity", costUsd: { value: 0.1, isEstimate: false } })],
    labels: ["API-sampled answers; not consumer-app answers", "Measured, not projected"],
  };
}

export function assessment(over: Partial<CompetitorPageAssessment> = {}): CompetitorPageAssessment {
  return {
    id: "ca1",
    url: "https://other.example/guide",
    host: "other.example",
    approvedAt: "2026-09-30T10:00:00Z",
    approvedBy: "u1",
    fetchedAt: "2026-09-30T10:01:00Z",
    sourceType: "publisher",
    citedIn: [{ promptId: "p1", promptText: "Best widget vendors", provider: "gemini", observationId: "o1" }],
    checks: [
      { key: "answer_first", label: "Answer first", noul: 0.91, tier: "act", method: "jev", detail: "answer at word 30" },
      { key: "depth", label: "Depth", noul: null, tier: null, method: "measured", detail: "1,709 words", status: "present" },
      { key: "proof", label: "Sources cited", noul: null, tier: null, method: "measured", detail: "4 outbound source links", status: "present" },
      { key: "schema", label: "Schema", noul: null, tier: null, method: "measured", detail: "FAQPage, Product", status: "present" },
      { key: "freshness", label: "Freshness", noul: null, tier: null, method: "measured", detail: "Updated 20 days ago", status: "present" },
      { key: "author", label: "Author", noul: null, tier: null, method: "measured", detail: "No author or byline markup found", status: "missing" },
      { key: "entity", label: "Entity facts", noul: 0.55, tier: "flag", method: "jev", detail: "12 numeric facts" },
      { key: "faq", label: "FAQ", noul: null, tier: null, method: "measured", detail: "FAQPage JSON-LD present", status: "partial" },
    ],
    reasons: ["Answer in first 40 words", "Updated 20 days ago <b>bold</b>"],
    verdict: "adapt",
    state: "assessed",
    stateDetail: null,
    ...over,
  };
}

export function plan(over: Partial<RewritePlan> = {}): RewritePlan {
  return {
    pageId: "pg1",
    url: "https://shop.example/widgets/",
    question: "Best widget vendors",
    promptId: "p1",
    engine: "gemini",
    competitorAssessmentId: "ca1",
    items: [
      { key: "read_winning_page", label: "Read the winning page", status: "unknown", evidence: "Check this yourself", method: "manual", optional: false },
      { key: "faq", label: "FAQ", status: "done", evidence: "FAQPage JSON-LD present in crawl of 2026-09-29", method: "measured", optional: false },
      { key: "compare_table", label: "Compare table", status: "todo", evidence: "0 tables", method: "measured", optional: false },
      { key: "indexnow", label: "IndexNow", status: "unknown", evidence: null, method: "manual", optional: true },
    ],
    gsc: { clicks: 12, impressions: 1268, window: { start: "2026-09-01", end: "2026-09-28" } },
    aiCitations: { count: 3, window: { start: "2026-09-01", end: "2026-09-28" } },
    recommendationId: "rec1",
    publishing: "manual",
    ...over,
  };
}

export function skipFactors(): PageSkipFactors {
  return {
    state: "ready",
    page: { pageId: "pg1", url: "https://shop.example/widgets/", snapshotAt: "2026-09-29T00:00:00Z", wordCount: 540 },
    promptId: "p1",
    promptText: "Best widget vendors",
    engine: "gemini",
    citedInsteadHost: "rival.example",
    competitorAssessmentId: null,
    factors: [
      { key: "answer_first", label: "Answer first", status: "missing", measured: "answer at word 180", value: 180, method: "heuristic", citedPage: { status: "present", measured: "answer at word 30", value: 30 } },
      { key: "faq_schema", label: "FAQ schema", status: "missing", measured: "FAQPage JSON-LD absent", value: null, method: "measured", citedPage: null },
    ],
    basis: "best page by engine search query match",
    labels: ["Measured from crawl", "Correlational, not causal"],
  };
}
