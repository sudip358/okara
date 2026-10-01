/**
 * OpenAI (Responses + web_search) and Anthropic (Messages + web_search_20250305) GEO adapters and their rates.
 * No network: fetch is injected; response bodies are CONSTRUCTED from the documented shapes in
 * docs/provider-contracts.md.
 */
import { describe, expect, it } from "vitest";
import { createOpenAiGeoProvider, openaiGeoConfigured, parseOpenAiGeoResponse } from "@worker/providers/openai-geo";
import { ANTHROPIC_GEO_MAX_USES, anthropicGeoConfigured, createAnthropicGeoProvider, parseAnthropicGeoMessages } from "@worker/providers/anthropic-geo";
import { estimateCost, findRate, RATE_VERSION, reservationMicros, UNKNOWN_RATE_RESERVE_USD_MICROS, usdToMicros } from "@worker/providers/rates";

const OAI_KEY = "sk-oai-TEST-secret-key-0001";
const ANT_KEY = "sk-ant-TEST-secret-key-0002";
const opts = { locale: "en-US", language: "en" };
const NOW = () => new Date("2026-09-30T12:00:00Z");

interface Captured { url: string; init: RequestInit }
function seqFetch(responses: Array<{ body: unknown; status?: number; headers?: Record<string, string> } | Error>, captured: Captured[] = []): typeof fetch {
  let i = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({ url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, init: init ?? {} });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "Content-Type": "application/json", ...(r.headers ?? {}) } });
  }) as typeof fetch;
}
const bodyOf = (c: Captured) => JSON.parse(String(c.init.body)) as Record<string, any>;
const headerOf = (c: Captured, name: string) => new Headers(c.init.headers).get(name);

// ------------------------------------------------------------------ OpenAI fixtures (constructed)

const oaiGrounded = {
  id: "resp_abc123",
  object: "response",
  model: "gpt-4.1-2025-04-14",
  status: "completed",
  output: [
    { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", queries: ["best solid brass cabinet pulls", "brass cabinet pulls brands"], sources: [{ type: "url", url: "https://consulted-only.example/x" }] } },
    { type: "web_search_call", id: "ws_2", status: "completed", action: { type: "open_page", url: "https://designroundup.example/best" } },
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: "Top picks include Brass Co and Rival Hardware.",
          annotations: [
            { type: "url_citation", start_index: 0, end_index: 10, url: "https://www.designroundup.example/best", title: "Best pulls 2026" },
            { type: "url_citation", start_index: 11, end_index: 20, url: "https://brassco.example/pulls", title: "Brass Co" },
            { type: "url_citation", start_index: 21, end_index: 30, url: "https://www.designroundup.example/best", title: "dup" },
          ],
        },
      ],
    },
  ],
  usage: { input_tokens: 2000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 500, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2500 },
};

const oaiNoSearch = {
  id: "resp_nosearch",
  model: "gpt-4.1",
  status: "completed",
  output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "From memory: Brass Co.", annotations: [] }] }],
  usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
};

describe("OpenAI GEO adapter", () => {
  it("sends the documented request with the key only in the Authorization header", async () => {
    const cap: Captured[] = [];
    const p = createOpenAiGeoProvider({ apiKey: OAI_KEY, model: "gpt-4.1", fetchImpl: seqFetch([{ body: oaiGrounded }], cap), now: NOW });
    await p.ask("What are the best solid brass cabinet pulls?", opts);
    expect(cap).toHaveLength(1);
    expect(cap[0]!.url).toBe("https://api.openai.com/v1/responses");
    expect(cap[0]!.url).not.toContain(OAI_KEY);
    expect(headerOf(cap[0]!, "authorization")).toBe(`Bearer ${OAI_KEY}`);
    const body = bodyOf(cap[0]!);
    expect(body).toMatchObject({
      model: "gpt-4.1",
      input: "What are the best solid brass cabinet pulls?",
      tools: [{ type: "web_search" }],
      tool_choice: "auto",
      include: ["web_search_call.action.sources"],
      max_output_tokens: 8192,
    });
    expect(body.instructions).toContain("en-US");
    expect(p.samplingOptions).toEqual({ maxOutputTokens: 8192, tools: ["web_search"], toolChoice: "auto" });
    expect(p.id).toBe("openai_geo");
  });

  it("grounded answer: citations from url_citation only (deduped), queries from search actions, billed search calls, estimated cost", async () => {
    const p = createOpenAiGeoProvider({ apiKey: OAI_KEY, model: "gpt-4.1", fetchImpl: seqFetch([{ body: oaiGrounded }]), now: NOW });
    const a = await p.ask("q", opts);
    expect(a).toMatchObject({ status: "ok", outcome: "ok", grounded: true, provider: "openai_geo", model: "gpt-4.1-2025-04-14", groundingMode: "openai_web_search", requestId: "resp_abc123", costIsEstimate: true, rateVersion: RATE_VERSION, error: null });
    expect(a.citations).toEqual([
      { url: "https://www.designroundup.example/best", title: "Best pulls 2026", position: 1 },
      { url: "https://brassco.example/pulls", title: "Brass Co", position: 2 },
    ]);
    // Consulted sources are never citations.
    expect(a.citations.map((c) => c.url)).not.toContain("https://consulted-only.example/x");
    expect(a.searchQueries).toEqual(["best solid brass cabinet pulls", "brass cabinet pulls brands"]);
    expect(a.searchQueriesExposed).toBe(true);
    // Only the "search" action is a billable call; open_page is not.
    expect(a.usage).toEqual({ inputTokens: 2000, outputTokens: 500, searchRequests: 1 });
    // gpt-4.1: $2 in / $8 out per MTok + $10 / 1k calls, priced for the configured id.
    expect(a.costUsd).toBeCloseTo((2000 * 2 + 500 * 8) / 1e6 + 0.01, 10);
  });

  it("an answer without a search call is stored ungrounded, never relabelled", async () => {
    const p = createOpenAiGeoProvider({ apiKey: OAI_KEY, model: "gpt-4.1", fetchImpl: seqFetch([{ body: oaiNoSearch }]), now: NOW });
    const a = await p.ask("q", opts);
    expect(a).toMatchObject({ status: "ok", grounded: false, searchQueries: [], searchQueriesExposed: true, citations: [] });
    expect(a.usage.searchRequests).toBe(0);
    expect(a.costUsd).toBeCloseTo((100 * 2 + 50 * 8) / 1e6, 12);
  });

  it("a failed search call does not ground the answer; queries missing on search actions are 'not exposed'", () => {
    const parsed = parseOpenAiGeoResponse({
      status: "completed",
      output: [
        { type: "web_search_call", id: "ws_x", status: "failed", action: { type: "search" } },
        { type: "message", content: [{ type: "output_text", text: "hi", annotations: [] }] },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    expect(parsed.grounded).toBe(false);
    expect(parsed.searchQueriesExposed).toBe(false);
    expect(parsed.searchQueries).toBeNull();
    expect(parsed.usage.searchRequests).toBe(1);
  });

  it("uses action.query when queries[] is absent; a web_search_call without action makes the search count (and cost) unknown", async () => {
    const one = parseOpenAiGeoResponse({ status: "completed", output: [{ type: "web_search_call", status: "completed", action: { type: "search", query: "brass pulls" } }, { type: "message", content: [{ type: "output_text", text: "t" }] }] });
    expect(one.searchQueries).toEqual(["brass pulls"]);
    expect(one.grounded).toBe(true);

    const body = { status: "completed", output: [{ type: "web_search_call", status: "completed" }, { type: "message", content: [{ type: "output_text", text: "t" }] }], usage: { input_tokens: 10, output_tokens: 10 } };
    const p = createOpenAiGeoProvider({ apiKey: OAI_KEY, model: "gpt-4.1", fetchImpl: seqFetch([{ body }]), now: NOW });
    const a = await p.ask("q", opts);
    expect(a.usage.searchRequests).toBeNull();
    expect(a.costUsd).toBeNull();
    expect(a.grounded).toBe(false);
  });

  it("maps response status: incomplete (with reason), failed (with message), completed without text", async () => {
    const inc = parseOpenAiGeoResponse({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "message", content: [{ type: "output_text", text: "partial" }] }] });
    expect(inc).toMatchObject({ status: "incomplete", finishReason: "max_output_tokens" });
    expect(inc.error).toContain("max_output_tokens");
    const failed = parseOpenAiGeoResponse({ status: "failed", error: { message: "server exploded" }, output: [] });
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("server exploded");
    const empty = parseOpenAiGeoResponse({ status: "completed", output: [] });
    expect(empty.status).toBe("incomplete");
  });

  it("unknown model -> cost null (never 0), rateVersion null", async () => {
    const p = createOpenAiGeoProvider({ apiKey: OAI_KEY, model: "gpt-unlisted-9", fetchImpl: seqFetch([{ body: oaiGrounded }]), now: NOW });
    const a = await p.ask("q", opts);
    expect(a.costUsd).toBeNull();
    expect(a.rateVersion).toBeNull();
    expect(a.costIsEstimate).toBe(true);
  });

  it("HTTP errors: 4xx rejected, 5xx server_error, network, and timeout; the key is scrubbed", async () => {
    const r429 = await createOpenAiGeoProvider({ apiKey: OAI_KEY, model: "gpt-4.1", fetchImpl: seqFetch([{ body: { error: { type: "rate_limit", message: `slow down ${OAI_KEY}` } }, status: 429 }]) }).ask("q", opts);
    expect(r429).toMatchObject({ status: "failed", outcome: "rejected", costUsd: null });
    expect(r429.error).toContain("429");
    expect(r429.error).not.toContain(OAI_KEY);
    const r500 = await createOpenAiGeoProvider({ apiKey: OAI_KEY, model: "gpt-4.1", fetchImpl: seqFetch([{ body: {}, status: 503 }]) }).ask("q", opts);
    expect(r500).toMatchObject({ status: "failed", outcome: "server_error" });
    const net = await createOpenAiGeoProvider({ apiKey: OAI_KEY, model: "gpt-4.1", fetchImpl: seqFetch([new TypeError("fetch failed")]) }).ask("q", opts);
    expect(net).toMatchObject({ status: "failed", outcome: "network" });
    const hang: typeof fetch = ((_: unknown, init?: RequestInit) =>
      new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }))))) as typeof fetch;
    const to = await createOpenAiGeoProvider({ apiKey: OAI_KEY, model: "gpt-4.1", fetchImpl: hang, timeoutMs: 20 }).ask("q", opts);
    expect(to).toMatchObject({ status: "failed", outcome: "timeout" });
  });

  it("missing key/model -> not_sent without any request", async () => {
    const cap: Captured[] = [];
    const a = await createOpenAiGeoProvider({ apiKey: "", model: "gpt-4.1", fetchImpl: seqFetch([{ body: {} }], cap) }).ask("q", opts);
    expect(a).toMatchObject({ status: "failed", outcome: "not_sent" });
    expect(cap).toHaveLength(0);
    expect(openaiGeoConfigured({ OPENAI_GEO_API_KEY: "k", OPENAI_GEO_MODEL: "gpt-4.1" })).toBe(true);
    expect(openaiGeoConfigured({ OPENAI_GEO_API_KEY: "k", OPENAI_GEO_MODEL: "" })).toBe(false);
    expect(openaiGeoConfigured({ OPENAI_GEO_API_KEY: "", OPENAI_GEO_MODEL: "gpt-4.1" })).toBe(false);
    expect(openaiGeoConfigured({ OPENAI_GEO_MODEL: "gpt 4/../x" }, "k")).toBe(false);
  });

  it("test() checks GET /v1/models/{model} without inference", async () => {
    const cap: Captured[] = [];
    const ok = await createOpenAiGeoProvider({ apiKey: OAI_KEY, model: "gpt-4.1", fetchImpl: seqFetch([{ body: { id: "gpt-4.1" } }], cap) }).test();
    expect(ok.ok).toBe(true);
    expect(cap[0]!.url).toBe("https://api.openai.com/v1/models/gpt-4.1");
    expect(cap[0]!.init.method).toBe("GET");
    const missing = await createOpenAiGeoProvider({ apiKey: OAI_KEY, model: "gpt-4.1", fetchImpl: seqFetch([{ body: {}, status: 404 }]) }).test();
    expect(missing.ok).toBe(false);
  });
});

// ------------------------------------------------------------------ Anthropic fixtures (constructed)

const antGrounded = {
  id: "msg_01",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5-5",
  stop_reason: "end_turn",
  content: [
    { type: "text", text: "Let me search." },
    { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "best solid brass cabinet pulls" } },
    {
      type: "web_search_tool_result",
      tool_use_id: "srvtoolu_1",
      content: [
        { type: "web_search_result", url: "https://designroundup.example/best", title: "Best pulls", encrypted_content: "ENC1", page_age: "2 days" },
        { type: "web_search_result", url: "https://uncited.example/", title: "Uncited", encrypted_content: "ENC2", page_age: null },
      ],
    },
    {
      type: "text",
      text: "Brass Co is a popular choice.",
      citations: [{ type: "web_search_result_location", url: "https://designroundup.example/best", title: "Best pulls", encrypted_index: "IDX", cited_text: "Brass Co makes..." }],
    },
  ],
  usage: { input_tokens: 3000, output_tokens: 400, server_tool_use: { web_search_requests: 1 } },
};

describe("Anthropic GEO adapter", () => {
  it("sends model, max_tokens, messages and web_search_20250305 with max_uses via the SDK (x-api-key, no retries)", async () => {
    const cap: Captured[] = [];
    const p = createAnthropicGeoProvider({ apiKey: ANT_KEY, model: "claude-sonnet-5-5", fetchImpl: seqFetch([{ body: antGrounded, headers: { "request-id": "req_ant_1" } }], cap), now: NOW });
    const a = await p.ask("What are the best solid brass cabinet pulls?", opts);
    expect(cap).toHaveLength(1);
    expect(cap[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(headerOf(cap[0]!, "x-api-key")).toBe(ANT_KEY);
    expect(headerOf(cap[0]!, "anthropic-version")).toBe("2023-06-01");
    expect(headerOf(cap[0]!, "anthropic-beta")).toBeNull();
    const body = bodyOf(cap[0]!);
    expect(body).toMatchObject({
      model: "claude-sonnet-5-5",
      max_tokens: 8192,
      messages: [{ role: "user", content: "What are the best solid brass cabinet pulls?" }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: ANTHROPIC_GEO_MAX_USES }],
    });
    expect(String(body.system)).toContain("en-US");
    expect(a.requestId).toBe("req_ant_1");
  });

  it("grounded answer: citations only from web_search_result_location, queries from server_tool_use, cost estimate", async () => {
    const p = createAnthropicGeoProvider({ apiKey: ANT_KEY, model: "claude-sonnet-5-5", fetchImpl: seqFetch([{ body: antGrounded }]), now: NOW });
    const a = await p.ask("q", opts);
    expect(a).toMatchObject({ status: "ok", outcome: "ok", grounded: true, provider: "anthropic_geo", groundingMode: "anthropic_web_search", costIsEstimate: true, rateVersion: RATE_VERSION, error: null });
    expect(a.text).toBe("Let me search.Brass Co is a popular choice.");
    expect(a.citations).toEqual([{ url: "https://designroundup.example/best", title: "Best pulls", position: 1 }]);
    expect(a.searchQueries).toEqual(["best solid brass cabinet pulls"]);
    expect(a.usage).toEqual({ inputTokens: 3000, outputTokens: 400, searchRequests: 1 });
    // claude-sonnet-5-5: $2 in / $10 out per MTok + $10 per 1,000 searches.
    expect(a.costUsd).toBeCloseTo((3000 * 2 + 400 * 10) / 1e6 + 0.01, 10);
    // Encrypted fields are never carried.
    expect(JSON.stringify(a)).not.toContain("ENC1");
    expect(JSON.stringify(a)).not.toContain("IDX");
  });

  it("search errors (HTTP 200, error inside the block) leave the answer ungrounded and name the error code", () => {
    const parsed = parseAnthropicGeoMessages([
      {
        model: "claude-sonnet-5-5",
        stop_reason: "end_turn",
        content: [
          { type: "server_tool_use", id: "srvtoolu_e", name: "web_search", input: { query: "q1" } },
          { type: "web_search_tool_result", tool_use_id: "srvtoolu_e", content: { type: "web_search_tool_result_error", error_code: "too_many_requests" } },
          { type: "text", text: "I could not search." },
        ],
        usage: { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 0 } },
      },
    ]);
    expect(parsed).toMatchObject({ status: "ok", grounded: false, searchQueries: ["q1"] });
    expect(parsed.error).toContain("too_many_requests");
    expect(parsed.usage.searchRequests).toBe(0);
  });

  it("requires web_search_requests >= 1 for grounding; missing counter with a search block -> unknown count and null cost", async () => {
    const noCounter = { ...antGrounded, usage: { input_tokens: 10, output_tokens: 10 } };
    const p = createAnthropicGeoProvider({ apiKey: ANT_KEY, model: "claude-sonnet-5-5", fetchImpl: seqFetch([{ body: noCounter }]), now: NOW });
    const a = await p.ask("q", opts);
    expect(a.grounded).toBe(false);
    expect(a.usage.searchRequests).toBeNull();
    expect(a.costUsd).toBeNull();
    // A plain answer without any search: 0 searches, priced.
    const plain = { id: "m", model: "claude-sonnet-5-5", stop_reason: "end_turn", content: [{ type: "text", text: "hello" }], usage: { input_tokens: 10, output_tokens: 10 } };
    const b = await createAnthropicGeoProvider({ apiKey: ANT_KEY, model: "claude-sonnet-5-5", fetchImpl: seqFetch([{ body: plain }]), now: NOW }).ask("q", opts);
    expect(b).toMatchObject({ grounded: false, searchQueries: [], searchQueriesExposed: true });
    expect(b.usage.searchRequests).toBe(0);
    expect(b.costUsd).toBeCloseTo((10 * 2 + 10 * 10) / 1e6, 12);
  });

  it("pause_turn is continued once with the assistant content sent back; usage is summed", async () => {
    const paused = {
      id: "msg_p",
      model: "claude-sonnet-5-5",
      stop_reason: "pause_turn",
      content: [
        { type: "server_tool_use", id: "srvtoolu_p", name: "web_search", input: { query: "pulls" } },
        { type: "web_search_tool_result", tool_use_id: "srvtoolu_p", content: [{ type: "web_search_result", url: "https://a.example/", title: "A", encrypted_content: "E" }] },
      ],
      usage: { input_tokens: 100, output_tokens: 10, server_tool_use: { web_search_requests: 1 } },
    };
    const done = { id: "msg_d", model: "claude-sonnet-5-5", stop_reason: "end_turn", content: [{ type: "text", text: "Answer", citations: [{ type: "web_search_result_location", url: "https://a.example/", title: "A", encrypted_index: "i", cited_text: "x" }] }], usage: { input_tokens: 200, output_tokens: 20 } };
    const cap: Captured[] = [];
    const a = await createAnthropicGeoProvider({ apiKey: ANT_KEY, model: "claude-sonnet-5-5", fetchImpl: seqFetch([{ body: paused }, { body: done }], cap), now: NOW }).ask("q", opts);
    expect(cap).toHaveLength(2);
    const second = bodyOf(cap[1]!);
    expect(second.messages).toHaveLength(2);
    expect(second.messages[1]).toEqual({ role: "assistant", content: paused.content });
    expect(a).toMatchObject({ status: "ok", grounded: true, text: "Answer", usage: { inputTokens: 300, outputTokens: 30, searchRequests: 1 } });
    expect(a.citations).toHaveLength(1);
  });

  it("a second pause_turn is not continued again: incomplete", async () => {
    const paused = { id: "p", model: "claude-sonnet-5-5", stop_reason: "pause_turn", content: [], usage: { input_tokens: 1, output_tokens: 1 } };
    const cap: Captured[] = [];
    const a = await createAnthropicGeoProvider({ apiKey: ANT_KEY, model: "claude-sonnet-5-5", fetchImpl: seqFetch([{ body: paused }], cap), now: NOW }).ask("q", opts);
    expect(cap).toHaveLength(2);
    expect(a.status).toBe("incomplete");
    expect(a.error).toContain("pause_turn");
  });

  it("stop reasons: refusal -> failed, max_tokens -> incomplete", () => {
    expect(parseAnthropicGeoMessages([{ stop_reason: "refusal", content: [], usage: { input_tokens: 1, output_tokens: 0 } }]).status).toBe("failed");
    expect(parseAnthropicGeoMessages([{ stop_reason: "max_tokens", content: [{ type: "text", text: "part" }], usage: { input_tokens: 1, output_tokens: 1 } }]).status).toBe("incomplete");
  });

  it("maps SDK errors: 400 (web search disabled) and 429 rejected, 5xx/529 server_error, connection network; no SDK retries", async () => {
    const cap: Captured[] = [];
    const disabled = await createAnthropicGeoProvider({
      apiKey: ANT_KEY,
      model: "claude-sonnet-5-5",
      fetchImpl: seqFetch([{ body: { type: "error", error: { type: "invalid_request_error", message: "web search is not enabled for this organization" } }, status: 400 }], cap),
    }).ask("q", opts);
    expect(disabled).toMatchObject({ status: "failed", outcome: "rejected" });
    expect(disabled.error).toContain("400");
    expect(cap).toHaveLength(1);

    const cap429: Captured[] = [];
    const limited = await createAnthropicGeoProvider({ apiKey: ANT_KEY, model: "claude-sonnet-5-5", fetchImpl: seqFetch([{ body: { type: "error", error: { type: "rate_limit_error", message: "slow" } }, status: 429 }], cap429) }).ask("q", opts);
    expect(limited.outcome).toBe("rejected");
    expect(cap429).toHaveLength(1); // maxRetries 0

    const over = await createAnthropicGeoProvider({ apiKey: ANT_KEY, model: "claude-sonnet-5-5", fetchImpl: seqFetch([{ body: { type: "error", error: { type: "overloaded_error", message: "busy" } }, status: 529 }]) }).ask("q", opts);
    expect(over.outcome).toBe("server_error");

    const net = await createAnthropicGeoProvider({ apiKey: ANT_KEY, model: "claude-sonnet-5-5", fetchImpl: seqFetch([new TypeError(`boom ${ANT_KEY}`)]) }).ask("q", opts);
    expect(net.outcome).toBe("network");
    expect(net.error).not.toContain(ANT_KEY);
  });

  it("times out after timeoutMs (outcome timeout)", async () => {
    const hang: typeof fetch = ((_: unknown, init?: RequestInit) =>
      new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as typeof fetch;
    const a = await createAnthropicGeoProvider({ apiKey: ANT_KEY, model: "claude-sonnet-5-5", fetchImpl: hang, timeoutMs: 30 }).ask("q", opts);
    expect(a).toMatchObject({ status: "failed", outcome: "timeout" });
  });

  it("a failed continuation keeps the first (billed) response: incomplete, outcome ok, cost unknown", async () => {
    const paused = { id: "p", model: "claude-sonnet-5-5", stop_reason: "pause_turn", content: [{ type: "text", text: "partial" }], usage: { input_tokens: 1, output_tokens: 1 } };
    const a = await createAnthropicGeoProvider({ apiKey: ANT_KEY, model: "claude-sonnet-5-5", fetchImpl: seqFetch([{ body: paused }, { body: { type: "error", error: { type: "api_error", message: "x" } }, status: 500 }]) }).ask("q", opts);
    expect(a).toMatchObject({ status: "incomplete", outcome: "ok", costUsd: null, text: "partial" });
  });

  it("missing key/model -> not_sent; configured() requires key and ANTHROPIC_GEO_MODEL", async () => {
    const cap: Captured[] = [];
    const a = await createAnthropicGeoProvider({ apiKey: ANT_KEY, model: "", fetchImpl: seqFetch([{ body: {} }], cap) }).ask("q", opts);
    expect(a).toMatchObject({ outcome: "not_sent", status: "failed" });
    expect(cap).toHaveLength(0);
    expect(anthropicGeoConfigured({ ANTHROPIC_GEO_API_KEY: "k", ANTHROPIC_GEO_MODEL: "claude-sonnet-5-5" })).toBe(true);
    expect(anthropicGeoConfigured({ ANTHROPIC_GEO_API_KEY: "k" })).toBe(false);
    expect(anthropicGeoConfigured({ ANTHROPIC_GEO_MODEL: "claude-sonnet-5-5" }, null)).toBe(false);
  });

  it("test() uses GET /v1/models/{model}", async () => {
    const cap: Captured[] = [];
    const r = await createAnthropicGeoProvider({ apiKey: ANT_KEY, model: "claude-sonnet-5-5", fetchImpl: seqFetch([{ body: { id: "claude-sonnet-5-5" } }], cap) }).test();
    expect(r.ok).toBe(true);
    expect(cap[0]!.url).toBe("https://api.anthropic.com/v1/models/claude-sonnet-5-5");
  });
});

// ------------------------------------------------------------------ rates

describe("GEO engine rates", () => {
  const at = new Date("2026-09-30T00:00:00Z");
  it("has rate entries only for verified ids; unknown ids reserve the guard amount and cost null", () => {
    expect(findRate("openai_geo", "gpt-5.5", at)).not.toBeNull();
    expect(findRate("anthropic_geo", "claude-opus-5-5", at)).not.toBeNull();
    expect(findRate("openai_geo", "gpt-9", at)).toBeNull();
    expect(reservationMicros("openai_geo", "gpt-9", at)).toBe(UNKNOWN_RATE_RESERVE_USD_MICROS);
    expect(estimateCost("anthropic_geo", "claude-x", { inputTokens: 1, outputTokens: 1, searchRequests: 1 }, { at }).costUsd).toBeNull();
  });

  it("gpt-4.1-mini adds the fixed 8,000-token search content block per call", () => {
    const e = estimateCost("openai_geo", "gpt-4.1-mini", { inputTokens: 1000, outputTokens: 100, searchRequests: 2 }, { at });
    expect(e.costUsd).toBeCloseTo((1000 * 0.4 + 100 * 1.6 + 2 * 8000 * 0.4) / 1e6 + 0.02, 10);
  });

  it("gpt-5.5 above the verified 272K input tier is unknown", () => {
    expect(estimateCost("openai_geo", "gpt-5.5", { inputTokens: 300_000, outputTokens: 1, searchRequests: 0 }, { at }).costUsd).toBeNull();
    expect(estimateCost("openai_geo", "gpt-5.5", { inputTokens: 1_000_000 / 5, outputTokens: 0, searchRequests: 0 }, { at }).costUsd).toBeCloseTo(1.0, 8);
  });

  it("reservations cover the envelope with the search bound", () => {
    // claude-opus-5-5: 8,000 in x $4 + 8,192 out x $20 per MTok + 6 searches x $0.01
    expect(reservationMicros("anthropic_geo", "claude-opus-5-5", at)).toBe(usdToMicros((8000 * 4 + 8192 * 20) / 1e6 + 0.06));
    // gpt-5: 8,000 x $1.25 + 8,192 x $10 per MTok + 5 calls x $0.01
    expect(reservationMicros("openai_geo", "gpt-5", at)).toBe(usdToMicros((8000 * 1.25 + 8192 * 10) / 1e6 + 0.05));
  });

  it("unknown token usage -> cost null", () => {
    expect(estimateCost("openai_geo", "gpt-4.1", { inputTokens: null, outputTokens: 1, searchRequests: 0 }, { at }).costUsd).toBeNull();
  });
});
