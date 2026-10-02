import { describe, expect, it } from "vitest";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";
import { unlimitedBudget } from "./helpers/context";
import { Db } from "@worker/lib/db";
import type { ProviderCallRecord } from "@worker/providers/types";
import { createTypeSafeProvider, mapAnswer } from "@worker/providers/typesafe";
import { createWriter, writerConfigStatus } from "@worker/providers/writer";
import { buildAnthropicRequest } from "@worker/providers/writer-anthropic";
import { buildOpenAiRequest } from "@worker/providers/writer-openai";
import { WriterOutputError } from "@worker/writing/metering";
import { RECOMMENDATION_V1_JSON_SCHEMA } from "@worker/writing/schemas";
import { SEO_WRITER_SYSTEM } from "@worker/writing/prompts";
import { API_HOST_ALLOWLIST, buildRunContext, buildWriterForWorkspace, createApiFetch, OutboundBlockedError } from "@worker/runs/runtime";
import { createRun } from "@worker/runs/runs-service";

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;
function fakeFetch(handlers: Handler[]) {
  const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
  let i = 0;
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    seen.push({ url, init });
    const h = handlers[Math.min(i++, handlers.length - 1)]!;
    return h(url, init);
  }) as typeof fetch;
  return { f, seen };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function recorder() {
  const calls: ProviderCallRecord[] = [];
  return { calls, rec: { async record(c: ProviderCallRecord) { calls.push(c); } } };
}

const QUESTIONS = {
  relevance: { type: "noul" as const, instructions: "Is `query` a good match for `page`?" },
  intent_fit: { type: "choice" as const, instructions: "Does `page` serve the intent?", criteria: { fits: "Fits.", mismatch: "Mismatch.", insufficient_context: "Not enough context." } },
  severity: { type: "score" as const, instructions: "How severe?", criteria: ["Cosmetic.", "Minor.", "Critical."] as const },
};

describe("TypeSafe adapter", () => {
  it("makes one systemOne call and maps Noul without any confidence field", async () => {
    const { f, seen } = fakeFetch([
      () =>
        json(
          {
            model: "jev-2026-09-15",
            answers: {
              relevance: { type: "noul", noul: 0.87, confidence: 0.99 },
              intent_fit: { type: "choice", choice: "fits", confidence: 0.91, probabilities: { fits: 0.91, mismatch: 0.06, insufficient_context: 0.03 } },
              severity: { type: "score", score: 1.2, confidence: 0.7, probabilities: { "0": 0.1, "1": 0.6, "2": 0.3 }, legend: { "0": "Cosmetic.", "1": "Minor.", "2": "Critical." } },
            },
            usage: { input_tokens: 321, output_tokens: 9 },
          },
          200,
          { "x-typesafe-request-id": "req_abc" },
        ),
    ]);
    const { calls, rec } = recorder();
    const budget = unlimitedBudget();
    const p = createTypeSafeProvider({ apiKey: "ts-key", model: "", fetchImpl: f, calls: rec, budget });
    const r = await p.decide({ purpose: "seo.page", state: { query: "brass knobs", page: { title: "Knobs" } }, questions: QUESTIONS });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    const body = JSON.parse(String(seen[0]!.init?.body));
    expect(body.model).toBe("jev-latest");
    expect(Object.keys(body.questions)).toEqual(["relevance", "intent_fit", "severity"]);
    expect(new Headers(seen[0]!.init?.headers).get("authorization")).toBe("Bearer ts-key");

    expect(r.provider).toBe("typesafe");
    expect(r.model).toBe("jev-2026-09-15");
    expect(r.answers.relevance).toEqual({ type: "noul", noul: 0.87 });
    expect(r.answers.relevance).not.toHaveProperty("confidence");
    expect(r.answers.intent_fit).toMatchObject({ type: "choice", choice: "fits", confidence: 0.91 });
    expect(r.answers.severity).toMatchObject({ type: "score", score: 1.2, confidence: 0.7 });
    expect(r.usage).toEqual({ inputTokens: 321, outputTokens: 9 });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ provider: "typesafe", model: "jev-2026-09-15", status: "ok", requestId: "req_abc", inputTokens: 321, outputTokens: 9, costUsd: null });
    expect(budget.reservations.map((x) => `${x.resource}:${x.state}`)).toEqual(["provider_calls:settled", "jev_calls:settled"]);
  });

  it("retries 5xx, records every attempt, and drops malformed answers", async () => {
    const { f, seen } = fakeFetch([
      () => json({ error: "overloaded" }, 503),
      () => json({ model: "jev-x", answers: { relevance: { type: "noul", noul: 1.7 }, intent_fit: { type: "choice", choice: "made_up", confidence: 0.9, probabilities: {} } }, usage: { input_tokens: 1, output_tokens: 1 } }),
    ]);
    const { calls, rec } = recorder();
    const p = createTypeSafeProvider({ apiKey: "k", fetchImpl: f, calls: rec, backoffInitialMs: 1 });
    const r = await p.decide({ purpose: "p", state: "s", questions: QUESTIONS });
    expect(seen).toHaveLength(2);
    expect(calls.map((c) => c.status)).toEqual(["error", "ok"]);
    expect(r.answers.relevance).toBeUndefined();
    expect(r.answers.intent_fit).toBeUndefined();
    expect(r.answers.severity).toBeUndefined();
  });

  it("does not retry 4xx and throws", async () => {
    const { f, seen } = fakeFetch([() => json({ error: "bad key" }, 401)]);
    const { calls, rec } = recorder();
    const p = createTypeSafeProvider({ apiKey: "k", fetchImpl: f, calls: rec, backoffInitialMs: 1 });
    await expect(p.decide({ purpose: "p", state: "s", questions: QUESTIONS })).rejects.toBeTruthy();
    expect(seen).toHaveLength(1);
    expect(calls[0]).toMatchObject({ status: "error", costUsd: null });
  });

  it("a timeout is recorded as 'timeout' with unknown cost and still counted against the budget", async () => {
    const hang = (async (_u: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      })) as typeof fetch;
    const { calls, rec } = recorder();
    const budget = unlimitedBudget();
    const p = createTypeSafeProvider({ apiKey: "k", fetchImpl: hang, calls: rec, budget, timeoutMs: 20, maxRetries: 0 });
    await expect(p.decide({ purpose: "p", state: "s", questions: QUESTIONS })).rejects.toBeTruthy();
    expect(calls).toEqual([expect.objectContaining({ provider: "typesafe", status: "timeout", costUsd: null })]);
    expect(budget.reservations.map((x) => `${x.resource}:${x.state}`)).toEqual(["provider_calls:settled", "jev_calls:settled"]);
  });

  it("test() uses models.list()", async () => {
    const { f, seen } = fakeFetch([() => json({ models: [{ name: "jev-latest", description: "", release_date: "2026-09-19" }] })]);
    const r = await createTypeSafeProvider({ apiKey: "k", fetchImpl: f }).test();
    expect(r.ok).toBe(true);
    expect(seen[0]!.url).toBe("https://api.typesafe.ai/v1/models");
  });

  it("mapAnswer never invents a confidence for noul", () => {
    expect(mapAnswer({ type: "noul", instructions: "q" }, { noul: 0.4 })).toEqual({ type: "noul", noul: 0.4 });
    expect(mapAnswer({ type: "choice", instructions: "q", criteria: { a: "A" } }, { type: "noul", noul: 0.4 })).toBeUndefined();
  });
});

describe("writers", () => {
  const req = { purpose: "seo_recommendation" as const, system: SEO_WRITER_SYSTEM, input: { EVIDENCE: [{ id: "ev_1" }] }, jsonSchema: RECOMMENDATION_V1_JSON_SCHEMA as unknown as Record<string, unknown>, maxOutputTokens: 1500 };

  it("factory returns null when WRITER_MODEL / WRITER_PROVIDER / key / base URL are missing", () => {
    const f = fakeFetch([]).f;
    expect(createWriter({ WRITER_PROVIDER: "anthropic" }, "k", f)).toBeNull();
    expect(createWriter({ WRITER_MODEL: "m" }, "k", f)).toBeNull();
    expect(createWriter({ WRITER_PROVIDER: "anthropic", WRITER_MODEL: "m" }, null, f)).toBeNull();
    expect(createWriter({ WRITER_PROVIDER: "openai_compatible", WRITER_MODEL: "m" }, "k", f)).toBeNull();
    expect(writerConfigStatus({ WRITER_PROVIDER: "openai_compatible", WRITER_MODEL: "m", WRITER_BASE_URL: "http://x" }).missing).toContain("WRITER_BASE_URL (must be https)");
    expect(createWriter({ WRITER_PROVIDER: "anthropic", WRITER_MODEL: "m" }, "k", f)?.name).toBe("anthropic");
  });

  it("Anthropic: structured output, no tools, headers, usage and request id recorded", async () => {
    const out = { agent: "seo", verified: true };
    const { f, seen } = fakeFetch([
      () =>
        json(
          { id: "msg_1", model: "configured-model", content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify(out) }], stop_reason: "end_turn", usage: { input_tokens: 800, output_tokens: 200 } },
          200,
          { "request-id": "req_ant" },
        ),
    ]);
    const { calls, rec } = recorder();
    const budget = unlimitedBudget();
    const w = createWriter({ WRITER_PROVIDER: "anthropic", WRITER_MODEL: "configured-model" }, "ant-key", f, { calls: rec, budget })!;
    const r = await w.write(req);
    expect(r).toMatchObject({ provider: "anthropic", model: "configured-model", output: out, usage: { inputTokens: 800, outputTokens: 200 } });
    expect(seen[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    const h = new Headers(seen[0]!.init?.headers);
    expect(h.get("x-api-key")).toBe("ant-key");
    expect(h.get("anthropic-version")).toBe("2023-06-01");
    const body = JSON.parse(String(seen[0]!.init?.body));
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body.output_config.format.type).toBe("json_schema");
    expect(JSON.stringify(body.output_config.format.schema)).not.toContain("maxLength");
    expect(body.max_tokens).toBe(1500);
    expect(calls).toEqual([expect.objectContaining({ provider: "anthropic", status: "ok", requestId: "req_ant", inputTokens: 800, outputTokens: 200, costUsd: null })]);
    expect(budget.reservations.map((x) => `${x.resource}:${x.state}`)).toEqual(["provider_calls:settled", "writer_tokens:settled"]);
  });

  it("Anthropic: refusal and truncation are errors, still recorded", async () => {
    const { f } = fakeFetch([() => json({ model: "m", content: [], stop_reason: "refusal", usage: { input_tokens: 5, output_tokens: 0 } })]);
    const { calls, rec } = recorder();
    const w = createWriter({ WRITER_PROVIDER: "anthropic", WRITER_MODEL: "m" }, "k", f, { calls: rec })!;
    await expect(w.write(req)).rejects.toBeInstanceOf(WriterOutputError);
    expect(calls[0]).toMatchObject({ status: "error", inputTokens: 5 });
  });

  it("Anthropic (SDK): retries 429 through our metering loop, never retries 400", async () => {
    const ok = { model: "m", content: [{ type: "text", text: '{"ok":true}' }], stop_reason: "end_turn", usage: { input_tokens: 9, output_tokens: 3 } };
    const { f, seen } = fakeFetch([() => json({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }, 429, { "request-id": "req_429" }), () => json(ok, 200, { "request-id": "req_ok" })]);
    const { calls, rec } = recorder();
    const w = createWriter({ WRITER_PROVIDER: "anthropic", WRITER_MODEL: "m" }, "k", f, { calls: rec, sleep: async () => {} })!;
    await expect(w.write(req)).resolves.toMatchObject({ output: { ok: true } });
    expect(seen).toHaveLength(2); // SDK retries disabled; exactly our two attempts
    expect(calls.map((c) => c.status)).toEqual(["error", "ok"]);
    expect(calls[0]).toMatchObject({ requestId: "req_429" });

    const bad = fakeFetch([() => json({ type: "error", error: { type: "invalid_request_error", message: "bad" } }, 400)]);
    const r2 = recorder();
    const w2 = createWriter({ WRITER_PROVIDER: "anthropic", WRITER_MODEL: "m" }, "k", bad.f, { calls: r2.rec, sleep: async () => {} })!;
    await expect(w2.write(req)).rejects.toBeTruthy();
    expect(bad.seen).toHaveLength(1);
    expect(JSON.stringify(r2.calls)).not.toContain("k\"");
  });

  it("OpenAI-compatible: json_schema response_format, retries 429 then succeeds", async () => {
    const { f, seen } = fakeFetch([
      () => json({ error: { message: "rate limited" } }, 429),
      () => json({ id: "c1", model: "m-2026", choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 7 } }, 200, { "x-request-id": "req_oa" }),
    ]);
    const { calls, rec } = recorder();
    const w = createWriter({ WRITER_PROVIDER: "openai_compatible", WRITER_MODEL: "m", WRITER_BASE_URL: "https://llm.example.com/v1/" }, "oa-key", f, { calls: rec, sleep: async () => {} })!;
    const r = await w.write(req);
    expect(r).toMatchObject({ provider: "openai_compatible", model: "m-2026", output: { ok: true } });
    expect(seen.map((s) => s.url)).toEqual(["https://llm.example.com/v1/chat/completions", "https://llm.example.com/v1/chat/completions"]);
    const body = JSON.parse(String(seen[0]!.init?.body));
    expect(body.response_format.type).toBe("json_schema");
    expect(body).not.toHaveProperty("tools");
    expect(new Headers(seen[0]!.init?.headers).get("authorization")).toBe("Bearer oa-key");
    expect(calls.map((c) => c.status)).toEqual(["error", "ok"]);
  });

  it("request builders put the untrusted input only in the user message", () => {
    const a = buildAnthropicRequest("m", req);
    expect(a.system).toBe(SEO_WRITER_SYSTEM);
    const o = buildOpenAiRequest("m", req) as { messages: Array<{ role: string }> };
    expect(o.messages.map((m) => m.role)).toEqual(["system", "user"]);
  });
});

describe("runtime", () => {
  it("apiFetch rejects non-allowlisted hosts, http, credentials, and odd ports", async () => {
    const { f, seen } = fakeFetch([() => json({})]);
    const api = createApiFetch({ WRITER_BASE_URL: "https://llm.example.com/v1" }, f);
    await expect(api("https://evil.example.com/x")).rejects.toBeInstanceOf(OutboundBlockedError);
    await expect(api("http://api.typesafe.ai/v1/models")).rejects.toBeInstanceOf(OutboundBlockedError);
    await expect(api("https://user:pw@api.typesafe.ai/")).rejects.toBeInstanceOf(OutboundBlockedError);
    await expect(api("https://api.typesafe.ai:8443/")).rejects.toBeInstanceOf(OutboundBlockedError);
    await expect(api("https://169.254.169.254/latest")).rejects.toBeInstanceOf(OutboundBlockedError);
    await expect(api("https://cloudflare-dns.com/dns-query")).rejects.toBeInstanceOf(OutboundBlockedError);
    await expect(api("https://shop.example.com/")).rejects.toBeInstanceOf(OutboundBlockedError); // crawling never uses apiFetch
    expect(seen).toHaveLength(0);
    for (const host of API_HOST_ALLOWLIST) {
      expect(["api.typesafe.ai", "generativelanguage.googleapis.com", "api.perplexity.ai", "api.anthropic.com", "api.openai.com", "oauth2.googleapis.com", "www.googleapis.com", "searchconsole.googleapis.com", "api.dataforseo.com"]).toContain(host);
    }
    await api("https://api.typesafe.ai/v1/models");
    await api("https://llm.example.com/v1/chat/completions");
    expect(seen).toHaveLength(2);
    expect(seen[0]!.init?.redirect).toBe("manual");
  });

  it("buildRunContext leaves providers null without credentials and builds them when configured", async () => {
    const bare = createTestEnv();
    const u = await seedUser(bare);
    const pid = await seedProject(bare, u.workspaceId);
    const db = new Db(bare.DB);
    const { runId } = await createRun(db, { workspaceId: u.workspaceId, projectId: pid, agent: "seo", trigger: "manual", idempotencyKey: "k1", createdBy: null, now: FIXED_NOW });
    const ctx = await buildRunContext(bare, runId, { fetchImpl: fakeFetch([]).f });
    expect(ctx.decisions).toBeNull();
    expect(ctx.writer).toBeNull();
    expect(ctx.geoProviders).toEqual([]);
    expect(ctx.gsc).toBeNull();
    expect(await ctx.isCancelled()).toBe(false);
    await ctx.log.event("seo.crawl", "info", "hello");
    expect((await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?", runId))?.n).toBe(1);

    const configured = { ...bare, TYPESAFE_API_KEY: "t", WRITER_API_KEY: "w", WRITER_PROVIDER: "anthropic", WRITER_MODEL: "m", GEMINI_API_KEY: "g", GEMINI_MODEL: "gemini-test", PERPLEXITY_API_KEY: "p", PERPLEXITY_MODEL: "perplexity/sonar" };
    const ctx2 = await buildRunContext(configured, runId, { fetchImpl: fakeFetch([]).f });
    expect(ctx2.decisions?.name).toBe("typesafe");
    expect(ctx2.writer?.model).toBe("m");
    expect(ctx2.geoProviders.map((g) => g.id)).toEqual(["gemini", "perplexity"]);
    await db.run("UPDATE agent_runs SET cancel_requested = 1 WHERE id = ?", runId);
    expect(await ctx2.isCancelled()).toBe(true);
  });

  it("crawlFetch is the injected platform fetch, called without a receiver", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    const { runId } = await createRun(new Db(env.DB), { workspaceId: u.workspaceId, projectId: pid, agent: "seo", trigger: "manual", idempotencyKey: "kc", createdBy: null, now: FIXED_NOW });
    const receivers: unknown[] = [];
    const platformFetch = function (this: unknown) {
      receivers.push(this);
      return Promise.resolve(new Response("ok"));
    } as unknown as typeof fetch;
    const ctx = await buildRunContext(env, runId, { fetchImpl: fakeFetch([]).f, crawlFetchImpl: platformFetch });
    await ctx.crawlFetch("https://shop.example.com/");
    expect(receivers).toEqual([undefined]);
    // apiFetch never reaches crawl targets.
    await expect(ctx.apiFetch("https://shop.example.com/")).rejects.toBeInstanceOf(OutboundBlockedError);
  });

  it("buildWriterForWorkspace returns null without a key or model", async () => {
    const env = createTestEnv({ WRITER_PROVIDER: "anthropic" });
    const u = await seedUser(env);
    expect(await buildWriterForWorkspace(env, new Db(env.DB), u.workspaceId)).toBeNull();
    const env2 = { ...env, WRITER_API_KEY: "k" };
    expect(await buildWriterForWorkspace(env2, new Db(env.DB), u.workspaceId)).toBeNull(); // WRITER_MODEL missing
  });
});
