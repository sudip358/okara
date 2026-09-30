/**
 * geo-providers: Gemini / Perplexity adapters, rates, cohort keys. No network: fetch is injected.
 * Fixtures in tests/fixtures/geo are CONSTRUCTED from documented response shapes (see their _fixture notes).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createGeminiProvider, geminiConfigured, citationHost, parseGeminiResponse } from "@worker/providers/gemini";
import { createPerplexityProvider, perplexityConfigured } from "@worker/providers/perplexity";
import { estimateCost, reservationMicros, resolveCost, RATE_VERSION, UNKNOWN_RATE_RESERVE_USD_MICROS } from "@worker/providers/rates";
import { cohortKey } from "@worker/geo/cohort";

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(process.cwd(), "tests/fixtures/geo", name), "utf8"));

const GEMINI_KEY = "AIzaTEST-gemini-secret-key-123";
const PPLX_KEY = "pplx-TEST-secret-key-456";

interface Captured { url: string; init: RequestInit }
function jsonFetch(body: unknown, status = 200, captured: Captured[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

const opts = { locale: "en-US", language: "en" };

describe("Gemini adapter (generateContent + googleSearch)", () => {
  it("builds a brand-neutral grounded request with the key only in the header", async () => {
    const captured: Captured[] = [];
    const p = createGeminiProvider({ apiKey: GEMINI_KEY, model: "gemini-3.8-flash", fetchImpl: jsonFetch(fixture("gemini-grounded.json"), 200, captured) });
    await p.ask("What are the best solid brass cabinet pulls?", opts);
    expect(captured).toHaveLength(1);
    const { url, init } = captured[0]!;
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
    expect(url).not.toContain(GEMINI_KEY);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe(GEMINI_KEY);
    const body = JSON.parse(String(init.body));
    expect(body.tools).toEqual([{ googleSearch: {} }]);
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "What are the best solid brass cabinet pulls?" }] }]);
    expect(body.systemInstruction.parts[0].text).toBe('Answer as you normally would for a user in en-US, writing in language "en".');
    expect(JSON.stringify(body)).not.toMatch(/Residence|ResEx/);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("parses a grounded response: text without thoughts, citations, queries, usage, request id", async () => {
    const p = createGeminiProvider({ apiKey: GEMINI_KEY, model: "gemini-3.8-flash", fetchImpl: jsonFetch(fixture("gemini-grounded.json")), now: () => new Date("2026-09-30T12:00:00Z") });
    const a = await p.ask("q", opts);
    expect(a.status).toBe("ok");
    expect(a.outcome).toBe("ok");
    expect(a.grounded).toBe(true);
    expect(a.text).toBe("Popular options for solid brass cabinet pulls include Brass Co, known for heavy forged pulls, and several boutique makers listed in design roundups.");
    expect(a.text).not.toContain("Planning");
    expect(a.citations).toEqual([
      { url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbCdEf123", title: "brassco.example", position: 1 },
      { url: "https://www.designroundup.example/best-cabinet-pulls", title: "The 12 best cabinet pulls of 2026", position: 2 },
    ]);
    // empty-string queries dropped, others trimmed
    expect(a.searchQueries).toEqual(["best solid brass cabinet pulls", "solid brass   cabinet hardware brands"]);
    expect(a.searchQueriesExposed).toBe(true);
    expect(a.requestId).toBe("resp-gemini-grounded-001");
    expect(a.usage).toEqual({ inputTokens: 21, outputTokens: 300, searchRequests: 2 });
    // 21*0.75/1e6 + 300*3.75/1e6 + 2*0.014
    expect(a.costUsd).toBeCloseTo(0.00001575 + 0.001125 + 0.028, 8);
    expect(a.costIsEstimate).toBe(true);
    expect(a.rateVersion).toBe(RATE_VERSION);
  });

  it("derives the citation host from the title for redirect-wrapped URIs", () => {
    expect(citationHost("https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC", "brassco.example")).toBe("brassco.example");
    expect(citationHost("https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC", "Some page title")).toBeNull();
    expect(citationHost("https://www.designroundup.example/x", "Anything")).toBe("designroundup.example");
  });

  it("without groundingMetadata: not grounded, searchQueries null (not exposed), no search fee", async () => {
    const p = createGeminiProvider({ apiKey: GEMINI_KEY, model: "gemini-3.8-flash", fetchImpl: jsonFetch(fixture("gemini-ungrounded.json")) });
    const a = await p.ask("q", opts);
    expect(a.status).toBe("ok");
    expect(a.grounded).toBe(false);
    expect(a.citations).toEqual([]);
    expect(a.searchQueries).toBeNull();
    expect(a.searchQueriesExposed).toBe(false);
    expect(a.usage.searchRequests).toBe(0);
  });

  it("drops empty-string webSearchQueries; metadata with only empty queries is not grounded", () => {
    const p = parseGeminiResponse(fixture("gemini-empty-queries.json"));
    expect(p.grounded).toBe(false);
    expect(p.searchQueries).toEqual([]);
    expect(p.usage.searchRequests).toBe(0);
  });

  it("finishReason MAX_TOKENS -> incomplete (keeps partial text and grounding)", async () => {
    const p = createGeminiProvider({ apiKey: GEMINI_KEY, model: "gemini-3.8-flash", fetchImpl: jsonFetch(fixture("gemini-max-tokens.json")) });
    const a = await p.ask("q", opts);
    expect(a.status).toBe("incomplete");
    expect(a.error).toContain("MAX_TOKENS");
    expect(a.grounded).toBe(true);
  });

  it.each([
    [429, "rejected"],
    [500, "server_error"],
  ] as const)("HTTP %i -> failed/%s without leaking the key", async (status, outcome) => {
    const errBody = { error: { code: status, status: status === 429 ? "RESOURCE_EXHAUSTED" : "INTERNAL", message: `Problem for key=${GEMINI_KEY}; header ${GEMINI_KEY}` } };
    const p = createGeminiProvider({ apiKey: GEMINI_KEY, model: "gemini-3.8-flash", fetchImpl: jsonFetch(errBody, status) });
    const a = await p.ask("q", opts);
    expect(a.status).toBe("failed");
    expect(a.outcome).toBe(outcome);
    expect(a.error).toContain(`HTTP ${status}`);
    expect(a.error).not.toContain(GEMINI_KEY);
    expect(JSON.stringify(a)).not.toContain(GEMINI_KEY);
    expect(a.costUsd).toBeNull();
    expect(a.grounded).toBe(false);
  });

  it("times out via AbortSignal -> failed/timeout", async () => {
    const hanging = ((_: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as typeof fetch;
    const p = createGeminiProvider({ apiKey: GEMINI_KEY, model: "gemini-3.8-flash", fetchImpl: hanging, timeoutMs: 20 });
    const a = await p.ask("q", opts);
    expect(a.status).toBe("failed");
    expect(a.outcome).toBe("timeout");
  });

  it("model comes only from config; empty model -> setup required, never sent", async () => {
    expect(geminiConfigured({ GEMINI_API_KEY: "k", GEMINI_MODEL: "" })).toBe(false);
    expect(geminiConfigured({ GEMINI_API_KEY: "k", GEMINI_MODEL: undefined })).toBe(false);
    expect(geminiConfigured({ GEMINI_API_KEY: "", GEMINI_MODEL: "gemini-3.8-flash" })).toBe(false);
    expect(geminiConfigured({ GEMINI_API_KEY: "k", GEMINI_MODEL: "gemini-3.8-flash" })).toBe(true);
    expect(geminiConfigured({ GEMINI_API_KEY: "k", GEMINI_MODEL: "../../evil?x=" })).toBe(false);
    let called = false;
    const p = createGeminiProvider({ apiKey: GEMINI_KEY, model: "", fetchImpl: (async () => { called = true; return new Response("{}"); }) as typeof fetch });
    const a = await p.ask("q", opts);
    expect(called).toBe(false);
    expect(a.outcome).toBe("not_sent");
  });
});

describe("Perplexity adapter (Agent API + web_search)", () => {
  it("builds the documented Agent API request", async () => {
    const captured: Captured[] = [];
    const p = createPerplexityProvider({ apiKey: PPLX_KEY, model: "perplexity/sonar", fetchImpl: jsonFetch(fixture("perplexity-search-results.json"), 200, captured) });
    await p.ask("What are the best solid brass cabinet pulls?", opts);
    const { url, init } = captured[0]!;
    expect(url).toBe("https://api.perplexity.ai/v1/agent");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${PPLX_KEY}`);
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: "perplexity/sonar", input: "What are the best solid brass cabinet pulls?", tools: [{ type: "web_search" }], language_preference: "en" });
    expect(body.messages).toBeUndefined();
  });

  it("search_results -> grounded citations (deduped), exposed queries, actual cost", async () => {
    const p = createPerplexityProvider({ apiKey: PPLX_KEY, model: "perplexity/sonar", fetchImpl: jsonFetch(fixture("perplexity-search-results.json")) });
    const a = await p.ask("q", opts);
    expect(a.status).toBe("ok");
    expect(a.grounded).toBe(true);
    expect(a.citations).toEqual([
      { url: "https://www.designroundup.example/best-cabinet-pulls", title: "The 12 best cabinet pulls of 2026", position: 1 },
      { url: "https://brassco.example/pulls", title: "Brass Co | Forged brass pulls", position: 2 },
    ]);
    expect(a.searchQueries).toEqual(["best solid brass cabinet pulls", "Solid  Brass cabinet pulls review"]);
    expect(a.searchQueriesExposed).toBe(true);
    expect(a.requestId).toBe("resp_pplx_0001");
    expect(a.usage).toEqual({ inputTokens: 1450, outputTokens: 210, searchRequests: 1 });
    expect(a.costUsd).toBeCloseTo(0.0033875, 8);
    expect(a.costIsEstimate).toBe(false);
    expect(a.text).toContain("Brass Co");
  });

  it("legacy top-level `citations` only -> NOT parsed; grounded false; queries not exposed", async () => {
    const p = createPerplexityProvider({ apiKey: PPLX_KEY, model: "perplexity/sonar", fetchImpl: jsonFetch(fixture("perplexity-legacy-citations.json")) });
    const a = await p.ask("q", opts);
    expect(a.status).toBe("ok");
    expect(a.grounded).toBe(false);
    expect(a.citations).toEqual([]);
    expect(a.searchQueries).toBeNull();
    expect(a.searchQueriesExposed).toBe(false);
    // no cost field and no tool_calls_details -> search count unknown -> cost unknown (null, not 0)
    expect(a.costUsd).toBeNull();
    expect(a.costIsEstimate).toBe(true);
  });

  it("HTTP 401 -> failed without leaking the key", async () => {
    const p = createPerplexityProvider({ apiKey: PPLX_KEY, model: "perplexity/sonar", fetchImpl: jsonFetch({ error: { message: `Invalid key Bearer ${PPLX_KEY}`, type: "invalid_api_key" } }, 401) });
    const a = await p.ask("q", opts);
    expect(a.status).toBe("failed");
    expect(a.outcome).toBe("rejected");
    expect(JSON.stringify(a)).not.toContain(PPLX_KEY);
  });

  it("status incomplete -> incomplete", async () => {
    const body = { ...(fixture("perplexity-search-results.json") as object), status: "incomplete" };
    const p = createPerplexityProvider({ apiKey: PPLX_KEY, model: "perplexity/sonar", fetchImpl: jsonFetch(body) });
    expect((await p.ask("q", opts)).status).toBe("incomplete");
  });

  it("configured only with key and provider/model id", () => {
    expect(perplexityConfigured({ PERPLEXITY_API_KEY: "k", PERPLEXITY_MODEL: "" })).toBe(false);
    expect(perplexityConfigured({ PERPLEXITY_API_KEY: "k", PERPLEXITY_MODEL: "sonar" })).toBe(false);
    expect(perplexityConfigured({ PERPLEXITY_API_KEY: "k", PERPLEXITY_MODEL: "perplexity/sonar" })).toBe(true);
  });
});

describe("rates", () => {
  const at = new Date("2026-09-30T12:00:00Z");
  it("unknown model -> costUsd null (never 0), estimate flag set", () => {
    const e = estimateCost("gemini", "gemini-9-ultra", { inputTokens: 100, outputTokens: 100, searchRequests: 1 }, { at });
    expect(e).toEqual({ costUsd: null, costIsEstimate: true, rateVersion: null });
    expect(estimateCost("perplexity", "openai/gpt-6-luna", { inputTokens: 1, outputTokens: 1, searchRequests: 1 }, { at }).costUsd).toBeNull();
    expect(reservationMicros("gemini", "gemini-9-ultra", at)).toBe(UNKNOWN_RATE_RESERVE_USD_MICROS);
  });

  it("unknown usage component -> null", () => {
    expect(estimateCost("gemini", "gemini-3.8-flash", { inputTokens: null, outputTokens: 10, searchRequests: 0 }, { at }).costUsd).toBeNull();
    expect(estimateCost("perplexity", "perplexity/sonar", { inputTokens: 10, outputTokens: 10, searchRequests: null }, { at }).costUsd).toBeNull();
  });

  it("applies dated promotional rates and 2.5 per-grounded-prompt billing", () => {
    const u = { inputTokens: 1_000_000, outputTokens: 1_000_000, searchRequests: 0 };
    expect(estimateCost("gemini", "gemini-3.8-flash", u, { at }).costUsd).toBeCloseTo(4.5, 6);
    expect(estimateCost("gemini", "gemini-3.8-flash", u, { at: new Date("2027-01-02T00:00:00Z") }).costUsd).toBeCloseTo(9.0, 6);
    expect(estimateCost("gemini", "models/gemini-2.5-flash", { inputTokens: 0, outputTokens: 0, searchRequests: 3 }, { grounded: true, at }).costUsd).toBeCloseTo(0.035, 8);
    expect(estimateCost("gemini", "gemini-2.5-flash", { inputTokens: 0, outputTokens: 0, searchRequests: 0 }, { grounded: false, at }).costUsd).toBe(0);
  });

  it("actual provider cost wins and is not an estimate", () => {
    expect(resolveCost("perplexity", "unknown/model", { inputTokens: null, outputTokens: null, searchRequests: null }, 0.01)).toEqual({ costUsd: 0.01, costIsEstimate: false, rateVersion: null });
  });
});

describe("cohortKey", () => {
  it("is 16 hex chars, stable across key order, and changes with model/config", async () => {
    const a = await cohortKey({ promptSetVersion: 1, provider: "gemini", model: "gemini-3.8-flash", groundingMode: "google_search", samplingOptions: { maxOutputTokens: 4096 } });
    const b = await cohortKey({ samplingOptions: { maxOutputTokens: 4096 }, groundingMode: "google_search", model: "gemini-3.8-flash", provider: "gemini", promptSetVersion: 1 });
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(b).toBe(a);
    expect(await cohortKey({ promptSetVersion: 1, provider: "gemini", model: "gemini-3.7-flash", groundingMode: "google_search", samplingOptions: { maxOutputTokens: 4096 } })).not.toBe(a);
    expect(await cohortKey({ promptSetVersion: 2, provider: "gemini", model: "gemini-3.8-flash", groundingMode: "google_search", samplingOptions: { maxOutputTokens: 4096 } })).not.toBe(a);
    expect(await cohortKey({ promptSetVersion: 1, provider: "gemini", model: "gemini-3.8-flash", groundingMode: "google_search", samplingOptions: { maxOutputTokens: 2048 } })).not.toBe(a);
  });
});

describe("search query normalization", () => {
  it("lowercases, trims, collapses whitespace (and matches geo-analysis punctuation/NFKC rules)", async () => {
    const { normalizeSearchQuery } = await import("@worker/geo/batch");
    expect(normalizeSearchQuery("  Best   Solid\tBrass PULLS ")).toBe("best solid brass pulls");
    expect(normalizeSearchQuery("“brass pulls?”")).toBe("brass pulls");
    expect(normalizeSearchQuery("ｂｒａｓｓ")).toBe("brass");
  });
});
