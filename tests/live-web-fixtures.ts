/** Contract fixtures for the Live view web tests (types only; no live data, no fetch). Hostile strings included. */
import type {
  ActivityItem,
  AnswerCoverageRow,
  CitationEvidenceRow,
  LinkSuggestionReport,
  LiveGeoAnswerRow,
  LiveGeoBoardResponse,
  LiveRecommendationRow,
  LiveSeoBoardResponse,
  LiveSeoElementRow,
  LiveSeoQueryRow,
  RunActivity,
  SeoOverview,
} from "../src/shared/types";

export const HOSTILE = '<script>alert("x")</script><img src=x onerror=alert(1)>';
const T0 = Date.parse("2026-09-29T14:02:00.000Z");
export const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

export function item(over: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id: "evt:1",
    at: at(0),
    kind: "step",
    agent: "seo",
    title: "Crawl started",
    detail: "seo.crawl · started",
    status: "info",
    provider: null,
    latencyMs: null,
    costUsd: null,
    costIsEstimate: false,
    url: null,
    outcome: null,
    ...over,
  };
}

export const step = (id: string, sec: number, name: string, status: string, title = `${name} ${status}`): ActivityItem =>
  item({ id, at: at(sec), kind: "step", title, detail: `${name} · ${status}`, status: status === "failed" ? "error" : status === "completed" ? "ok" : "info" });

export const read = (id: string, sec: number, url: string, detail = "200 · 1,240 words"): ActivityItem =>
  item({ id, at: at(sec), kind: "page_read", title: `Read ${url}`, detail, status: detail.startsWith("Skipped") ? "warn" : "ok", provider: "crawler", url });

export const call = (id: string, sec: number, costUsd: number | null, latencyMs: number | null = 820): ActivityItem =>
  item({ id, at: at(sec), kind: "provider_call", title: "typesafe call · question", detail: "ok · typesafe-model", status: "ok", provider: "typesafe", latencyMs, costUsd, costIsEstimate: true });

export function run(over: Partial<RunActivity["run"]> = {}): RunActivity["run"] {
  return {
    id: "run1",
    agent: "seo",
    status: "completed",
    trigger: "manual",
    createdAt: at(0),
    startedAt: at(0),
    finishedAt: at(432),
    elapsedMs: 432_000,
    ...over,
  };
}

export function activity(over: Partial<RunActivity> = {}): RunActivity {
  const items = [
    step("evt:1", 0, "seo.validate", "started"),
    step("evt:2", 1, "seo.validate", "completed"),
    step("evt:3", 2, "seo.crawl", "started"),
    read("snap:1", 5, "https://shop.example/products/oak-table"),
    read("snap:2", 6, "https://shop.example/blog/care", "Skipped: robots_disallowed"),
    step("evt:4", 40, "seo.crawl", "completed"),
    step("evt:5", 41, "seo.gsc_sync", "started"),
    step("evt:6", 50, "seo.gsc_sync", "completed"),
    step("evt:7", 51, "seo.recommend", "started"),
    call("call:1", 60, 0.002),
    call("call:2", 61, 0.003),
    step("evt:8", 400, "seo.recommend", "completed"),
  ];
  return {
    run: run(),
    active: false,
    totals: {
      spend: { usd: 0.07, isEstimate: true, unknownCalls: 0 },
      providerCalls: 2,
      pagesRead: 38,
      pagesPlanned: 50,
      answers: { cited: 0, named: 0, missing: 0, failed: 0 },
      decisions: { act: 23, flag: 4, drop: 2 },
    },
    lanes: [],
    queued: [],
    nowReading: null,
    items,
    cursor: "c1",
    ...over,
  };
}

export function element(over: Partial<LiveSeoElementRow> = {}): LiveSeoElementRow {
  return {
    id: "dec:1",
    at: at(70),
    role: "element",
    candidateKey: "cand:oak",
    pagePath: "/products/oak-table",
    url: "https://shop.example/products/oak-table",
    pageId: "pg1",
    targetLabel: "/products/oak-table",
    element: "Title",
    questionId: "seo.title_matches_query",
    now: "Oak Table | Shop",
    proposed: "Solid Oak Dining Table, 6 Seats",
    gsc: { clicks: 310, impressions: 9100, position: 11.24, window: { start: "2026-09-01", end: "2026-09-28" }, basis: "page_rows" },
    jev: { questionId: "seo.title_matches_query", tier: "act", noul: 0.08, choice: null, confidence: null, provider: "typesafe", model: "typesafe-model" },
    rule: null,
    verdict: "change",
    verdictBasis: "Noul 0.08, act tier: confident no",
    outcome: "selected",
    reasonCode: null,
    recommendationId: "rec1",
    linkSuggestionId: null,
    ...over,
  };
}

export function query(over: Partial<LiveSeoQueryRow> = {}): LiveSeoQueryRow {
  return {
    id: "dec:q1",
    at: at(55),
    queryKey: "q:oak table",
    query: "oak dining table",
    questionId: "seo.query_relevance",
    band: "yes",
    jev: { questionId: "seo.query_relevance", tier: "act", noul: 0.92, choice: null, confidence: null, provider: "typesafe", model: "typesafe-model" },
    gsc: { clicks: 40, impressions: 1200, position: 7.1, window: { start: "2026-09-01", end: "2026-09-28" }, basis: "query_rows" },
    ...over,
  };
}

export function rec(over: Partial<LiveRecommendationRow> = {}): LiveRecommendationRow {
  return {
    id: "rec:rec1",
    recommendationId: "rec1",
    at: at(300),
    agent: "seo",
    scope: "page",
    issueType: "title_mismatch",
    targetLabel: "/products/oak-table",
    url: "https://shop.example/products/oak-table",
    action: `Rewrite the title to match the query ${HOSTILE}`,
    suggestedSnippet: "Solid Oak Dining Table, 6 Seats",
    stage: "awaiting_approval",
    status: "open",
    priority: 0.62,
    priorityVersion: "priority-v3",
    effort: "low",
    uncertainty: "medium",
    tier: "act",
    evidenceCount: 3,
    writer: { provider: "writer", model: "writer-model" },
    ...over,
  };
}

export function seoFeed(over: Partial<LiveSeoBoardResponse> = {}): LiveSeoBoardResponse {
  return {
    run: run(),
    active: false,
    elements: [
      element(),
      element({ id: "dec:2", at: at(80), element: "Meta", questionId: "seo.meta_matches_query", now: HOSTILE, proposed: null, verdict: "keep", jev: { questionId: "seo.meta_matches_query", tier: "act", noul: 0.92, choice: null, confidence: null, provider: "typesafe", model: "m" }, recommendationId: null }),
      element({ id: "dec:3", at: at(90), role: "action", element: "Title + meta", questionId: "seo.action_choice", jev: { questionId: "seo.action_choice", tier: "act", noul: null, choice: "rewrite_title_meta", confidence: 0.87, provider: "typesafe", model: "m" } }),
      element({ id: "find:1", at: at(30), role: "rule", candidateKey: null, element: "H1", questionId: "SEO-H1-MISSING", now: null, proposed: null, gsc: null, jev: null, rule: { ruleId: "SEO-H1-MISSING", severity: "major", class: "fact" }, verdict: "change", verdictBasis: "Rule (fact)", outcome: null, recommendationId: null }),
      element({ id: "dec:4", at: at(95), candidateKey: "cand:care", pagePath: "/blog/care", targetLabel: "/blog/care", element: "Intro", questionId: "seo.answer_is_direct", now: "Welcome to our blog", proposed: null, verdict: "review", jev: { questionId: "seo.answer_is_direct", tier: "flag", noul: 0.55, choice: null, confidence: null, provider: "typesafe", model: "m" }, recommendationId: null }),
    ],
    queries: [query(), query({ id: "dec:q2", at: at(56), questionId: "seo.query_intent", band: null, jev: { questionId: "seo.query_intent", tier: "act", noul: null, choice: "transactional", confidence: 0.88, provider: "typesafe", model: "m" } }), query({ id: "dec:q3", at: at(57), queryKey: "q:x", query: HOSTILE, band: "no", jev: { questionId: "seo.query_relevance", tier: "act", noul: 0.1, choice: null, confidence: null, provider: "typesafe", model: "m" } })],
    recommendations: [rec()],
    gscSync: {
      id: "gs1",
      source: "api",
      status: "completed",
      window: { start: "2026-09-01", end: "2026-09-28" },
      previousWindow: { start: "2026-08-04", end: "2026-08-31" },
      rowsFetched: 4812,
      rowCap: 25000,
      truncated: false,
      syncedAt: at(50),
      error: null,
    },
    totals: {
      elements: { judged: 3910, keep: 2400, change: 1284, review: 226, byElement: {} },
      queries: {
        distinct: 260,
        relevance: { yes: 214, no: 30, middle: 10, unanswered: 6 },
        buyer: { yes: 0, no: 0, middle: 0, unanswered: 0 },
        buyerReady: { yes: 0, no: 0, middle: 0, unanswered: 0 },
        intent: { transactional: 120 },
      },
      pipeline: {
        candidates: 120,
        judged: 110,
        rejectedByReason: { low_fit: 12, duplicate: 3 },
        created: 9,
        byStage: { collected: 0, judged: 0, drafted: 2, awaiting_approval: 7, marked_implemented: 0 },
        byStatus: { open: 8, approved: 0, dismissed: 0, implemented: 1 },
      },
      truncated: false,
    },
    cursor: "f1",
    labels: [],
    ...over,
  };
}

export function answer(over: Partial<LiveGeoAnswerRow> = {}): LiveGeoAnswerRow {
  return {
    id: "obs:1",
    observationId: "o1",
    at: at(20),
    provider: "gemini",
    promptId: "p1",
    promptText: "best washable sofa",
    model: "gemini-run-model",
    groundingMode: "google_search",
    outcome: "missing",
    grounded: true,
    latencyMs: 377,
    cost: { value: 0.0012, isEstimate: true },
    position: null,
    sentiment: { value: "neutral", method: "deterministic+jev" },
    recommendationStatus: null,
    citedInstead: { host: "reviews.example", url: "https://reviews.example/sofas", sourceType: "review_site" },
    ownCitedUrl: null,
    citationCount: 4,
    searchQueryCount: 2,
    matchedPage: { pageId: "pg1", url: "https://shop.example/sofas/washable", method: "engine_search_query", score: 0.46 },
    ...over,
  };
}

export function geoFeed(over: Partial<LiveGeoBoardResponse> = {}): LiveGeoBoardResponse {
  return {
    run: run({ agent: "geo" }),
    active: false,
    answers: [
      answer(),
      answer({ id: "obs:2", observationId: "o2", at: at(25), promptId: "p2", promptText: HOSTILE, outcome: "cited", citedInstead: null, ownCitedUrl: "https://shop.example/sofas", position: 2 }),
      answer({ id: "obs:3", observationId: "o3", at: at(30), provider: "openai_geo", outcome: "named", latencyMs: 820, model: "gpt-run-model", groundingMode: "web_search" }),
    ],
    plannedPrompts: [
      { promptId: "p1", text: "best washable sofa" },
      { promptId: "p2", text: HOSTILE },
      { promptId: "p3", text: "sofa for small flat" },
    ],
    recommendations: [],
    totals: {
      lanes: [
        { provider: "gemini", cited: 23, named: 10, missing: 65, grounded: 98, failed: 1, pending: 0, cost: { value: 0.162, isEstimate: true }, citedInstead: { host: "reviews.example", sourceType: "review_site", answers: 31 } },
        { provider: "openai_geo", cited: 1, named: 1, missing: 0, grounded: 2, failed: 0, pending: 0, cost: { value: null, isEstimate: false }, citedInstead: null },
      ],
      pipeline: { candidates: 0, judged: 0, rejectedByReason: {}, created: 0, byStage: { collected: 0, judged: 0, drafted: 0, awaiting_approval: 0, marked_implemented: 0 }, byStatus: { open: 0, approved: 0, dismissed: 0, implemented: 0 } },
      truncated: false,
    },
    cursor: "g1",
    labels: ["API-sampled answers; not consumer-app answers"],
    ...over,
  };
}

export function coverageRow(over: Partial<AnswerCoverageRow> = {}): AnswerCoverageRow {
  return {
    promptId: "p1",
    text: "best washable sofa",
    promptType: "discovery",
    matchedPage: { url: "https://shop.example/sofas/washable", method: "engine_search_query", score: 0.46 },
    aiSource: "other_site",
    topOtherSource: { host: "reviews.example", sourceType: "review_site", url: null },
    gap: "improve",
    providersRun: 3,
    basis: "best page by engine search query match",
    ...over,
  };
}

export function evidenceRow(over: Partial<CitationEvidenceRow> = {}): CitationEvidenceRow {
  return {
    url: "https://shop.example/sofas",
    pageId: "pg2",
    citedCount: 4,
    citedInPrompts: ["p2"],
    providers: ["gemini", "openai_geo"],
    lastCitedAt: at(25),
    citedAlongside: [{ host: "reviews.example", sourceType: "review_site" }],
    nextStep: "none",
    reason: "",
    ...over,
  };
}

export function linkReport(): LinkSuggestionReport {
  return {
    state: "ready",
    generatedAt: "2026-09-27T10:00:00Z",
    crawlRunId: "cr1",
    pagesAnalysed: 40,
    orphanPages: [{ pageId: "pg9", url: "https://shop.example/guides/oak" }],
    suggestions: [
      {
        id: "ls1",
        source: { pageId: "pg3", url: "https://shop.example/blog/care", title: null },
        target: { pageId: "pg9", url: "https://shop.example/guides/oak", title: null, inlinks: 0, orphan: true },
        sentence: { index: 2, text: `Oil the oak twice a year ${HOSTILE}` },
        anchor: { text: "Oil the oak" },
        role: "deeper_detail",
        method: "jev",
        decision: { tier: "act", shouldExist: 0.91, sentenceConfidence: 0.8, anchorConfidence: 0.7, roleConfidence: 0.6, provider: "typesafe", model: "m" },
        status: "suggested",
        score: 0.7,
        reasons: [],
        userStatus: "open",
      },
    ],
    genericAnchors: [],
    completeness: null,
    labels: [],
  };
}

export function overview(): SeoOverview {
  return {
    state: "ready",
    source: "api",
    property: "sc-domain:shop.example",
    syncedAt: at(50),
    current: { start: "2026-09-01", end: "2026-09-28" },
    previous: { start: "2026-08-04", end: "2026-08-31" },
    totals: {
      current: { clicks: 12480, impressions: 300000, ctr: { numerator: 12480, denominator: 300000, value: 0.0416 }, position: 14.2 },
      previous: { clicks: 11000, impressions: 280000, ctr: { numerator: 11000, denominator: 280000, value: 0.039 }, position: 15.1 },
    },
    daily: [
      { date: "2026-09-01", clicks: 400, impressions: 10000 },
      { date: "2026-09-02", clicks: 420, impressions: 10100 },
    ],
    annotations: [],
    truncated: false,
    completeness: { note: "28 of 28 days", covered: 28, total: 28 },
    visitsRevenue: { state: "not_connected" },
    limitations: [],
    demandCurve: null,
    brandSplit: null,
  };
}
