/** Deploy-readiness round 2 (providers): opt-in OpenAI reasoning headroom, writer config flags, Gemini thinking-level aliases/override. */
import { describe, expect, it } from "vitest";
import {
  buildOpenAiRequest,
  OPENAI_REASONING_HEADROOM_TOKENS,
  parseOpenAiResponse,
  parseReasoningHeadroom,
  reasoningHeadroomTokens,
} from "@worker/providers/writer-openai";
import { createWriter, writerConfigStatus } from "@worker/providers/writer";
import {
  createGeminiProvider,
  GEMINI_DEFAULT_MAX_OUTPUT_TOKENS,
  geminiThinkingLevelProblem,
  resolveGeminiThinkingLevel,
  supportsThinkingLevel,
} from "@worker/providers/gemini";
import type { Budget, BudgetResource } from "@worker/runs/context";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const req = { purpose: "p", system: "s", input: {}, jsonSchema: { type: "object" }, maxOutputTokens: 1500 } as never;
const OA = { WRITER_PROVIDER: "openai_compatible", WRITER_MODEL: "m", WRITER_BASE_URL: "https://api.example.com/v1" };

/** Runs one write through createWriter and returns the sent body plus the writer_tokens reservation. */
async function writeOnce(env: Record<string, string>, reply: unknown = { choices: [{ message: { content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) {
  let sent: Record<string, unknown> = {};
  const reserved: Array<[BudgetResource, number]> = [];
  const budget = {
    reserve: async (r: BudgetResource, n: number) => {
      reserved.push([r, n]);
      return `resv-${reserved.length}`;
    },
    settle: async () => undefined,
    release: async () => undefined,
    markUnknown: async () => undefined,
  } as unknown as Budget;
  const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
    sent = JSON.parse(String(init!.body));
    return json(reply);
  }) as typeof fetch;
  const w = createWriter(env, "key", fetchImpl, { budget, sleep: async () => {} })!;
  let error: unknown = null;
  await w.write(req).catch((e) => (error = e));
  const tokens = reserved.find(([r]) => r === "writer_tokens")?.[1];
  return { sent, tokens, error };
}

describe("OpenAI-compatible writer: reasoning headroom is opt-in and symmetric with the reservation", () => {
  it("adds no headroom without WRITER_REASONING_EFFORT (non-reasoning models keep their small output caps)", async () => {
    expect(reasoningHeadroomTokens(null)).toBe(0);
    expect(buildOpenAiRequest("m", req).max_completion_tokens).toBe(1500);
    const { sent, tokens } = await writeOnce(OA);
    expect(sent.max_completion_tokens).toBe(1500);
    expect(sent).not.toHaveProperty("reasoning_effort");
    // reservation = prompt estimate + exactly what was sent as max_completion_tokens
    expect(tokens).toBeGreaterThanOrEqual(1500);
    expect(tokens! - 1500).toBeLessThan(100);
  });

  it("adds the 4000 default when WRITER_REASONING_EFFORT is set, and reserves the same total", async () => {
    expect(reasoningHeadroomTokens("low")).toBe(OPENAI_REASONING_HEADROOM_TOKENS);
    expect(buildOpenAiRequest("m", req, "low").max_completion_tokens).toBe(1500 + OPENAI_REASONING_HEADROOM_TOKENS);
    const base = await writeOnce(OA);
    const { sent, tokens } = await writeOnce({ ...OA, WRITER_REASONING_EFFORT: "low" });
    expect(sent.max_completion_tokens).toBe(1500 + OPENAI_REASONING_HEADROOM_TOKENS);
    expect(sent.reasoning_effort).toBe("low");
    expect(tokens! - base.tokens!).toBe(OPENAI_REASONING_HEADROOM_TOKENS);
  });

  it("WRITER_REASONING_HEADROOM_TOKENS overrides the default either way", async () => {
    expect(parseReasoningHeadroom("0")).toBe(0);
    expect(parseReasoningHeadroom(" 2500 ")).toBe(2500);
    expect(parseReasoningHeadroom("-1")).toBeNull();
    expect(parseReasoningHeadroom("1e3")).toBeNull();
    expect(parseReasoningHeadroom("999999999")).toBeNull();
    const base = await writeOnce(OA);
    const a = await writeOnce({ ...OA, WRITER_REASONING_EFFORT: "high", WRITER_REASONING_HEADROOM_TOKENS: "0" });
    expect(a.sent.max_completion_tokens).toBe(1500);
    expect(a.tokens).toBe(base.tokens);
    const b = await writeOnce({ ...OA, WRITER_REASONING_HEADROOM_TOKENS: "2500" });
    expect(b.sent.max_completion_tokens).toBe(4000);
    expect(b.sent).not.toHaveProperty("reasoning_effort");
    expect(b.tokens! - base.tokens!).toBe(2500);
  });

  it("the finish_reason length message names the limit sent and the right knob", async () => {
    const trunc = { choices: [{ message: { content: "{\"a\":" }, finish_reason: "length" }], usage: { prompt_tokens: 5, completion_tokens: 1500 } };
    const plain = await writeOnce(OA, trunc);
    const m1 = (plain.error as Error).message;
    expect(m1).toContain('finish_reason "length"');
    expect(m1).toContain("max_completion_tokens 1500");
    expect(m1).toContain("including 0 reasoning headroom tokens");
    expect(m1).toContain("1500 completion tokens used");
    expect(m1).toContain("set WRITER_REASONING_EFFORT");

    const withEffort = await writeOnce({ ...OA, WRITER_REASONING_EFFORT: "medium" }, trunc);
    const m2 = (withEffort.error as Error).message;
    expect(m2).toContain(`max_completion_tokens ${1500 + OPENAI_REASONING_HEADROOM_TOKENS}`);
    expect(m2).toContain("WRITER_REASONING_EFFORT=medium");
    expect(m2).toContain("WRITER_REASONING_HEADROOM_TOKENS");

    // Without limit info the message still reads correctly.
    const { failure } = parseOpenAiResponse(trunc as never, "m");
    expect(failure?.reason).toBe("truncated");
    expect(failure!.message).toContain("hit max_completion_tokens");
  });
});

describe("writerConfigStatus flags unrecognised reasoning settings", () => {
  it("an unknown WRITER_REASONING_EFFORT or headroom blocks openai_compatible with a named problem", () => {
    const s = writerConfigStatus({ ...OA, WRITER_REASONING_EFFORT: "lo" });
    expect(s.configured).toBe(false);
    expect(s.missing.join(" ")).toContain('WRITER_REASONING_EFFORT (unrecognised value "lo"');
    expect(createWriter({ ...OA, WRITER_REASONING_EFFORT: "lo" }, "k", fetch)).toBeNull();

    const h = writerConfigStatus({ ...OA, WRITER_REASONING_HEADROOM_TOKENS: "lots" });
    expect(h.configured).toBe(false);
    expect(h.missing.join(" ")).toContain("WRITER_REASONING_HEADROOM_TOKENS");
  });

  it("valid values are accepted; values are ignored (with a warning) for anthropic", () => {
    expect(writerConfigStatus({ ...OA, WRITER_REASONING_EFFORT: " High ", WRITER_REASONING_HEADROOM_TOKENS: "8000" })).toMatchObject({ configured: true, missing: [], warnings: [] });
    expect(writerConfigStatus(OA)).toMatchObject({ configured: true, missing: [], warnings: [] });
    const a = writerConfigStatus({ WRITER_PROVIDER: "anthropic", WRITER_MODEL: "m", WRITER_REASONING_EFFORT: "lo" });
    expect(a.configured).toBe(true);
    expect(a.warnings).toHaveLength(1);
  });
});

describe("Gemini thinkingLevel: documented -latest aliases and GEMINI_THINKING_LEVEL override", () => {
  const ask = async (model: string, thinkingLevel?: string) => {
    const bodies: Array<Record<string, any>> = [];
    const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init!.body)));
      return json({ candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }] });
    }) as typeof fetch;
    const p = createGeminiProvider({ apiKey: "k", model, fetchImpl, thinkingLevel });
    await p.ask("q", { locale: "en-US", language: "en" } as never);
    return { gen: bodies[0]!.generationConfig, sampling: p.samplingOptions };
  };

  it("treats gemini-flash-latest / gemini-pro-latest as Gemini 3 (thinkingLevel LOW), not older aliases", async () => {
    expect(supportsThinkingLevel("gemini-flash-latest")).toBe(true);
    expect(supportsThinkingLevel("models/gemini-pro-latest")).toBe(true);
    expect(supportsThinkingLevel("Gemini-Flash-Latest")).toBe(true);
    expect(supportsThinkingLevel("gemini-1.5-flash-latest")).toBe(false);
    expect(supportsThinkingLevel("gemini-2.5-flash")).toBe(false);
    const r = await ask("gemini-flash-latest");
    expect(r.gen).toEqual({ maxOutputTokens: GEMINI_DEFAULT_MAX_OUTPUT_TOKENS, thinkingConfig: { thinkingLevel: "LOW" } });
    expect(r.sampling).toEqual({ maxOutputTokens: GEMINI_DEFAULT_MAX_OUTPUT_TOKENS, thinkingLevel: "LOW" });
  });

  it("honours GEMINI_THINKING_LEVEL for any model id, OFF disables it, garbage falls back to the default", async () => {
    expect(resolveGeminiThinkingLevel("my-custom-alias", "high")).toBe("HIGH");
    expect(resolveGeminiThinkingLevel("gemini-3.8-flash", "OFF")).toBeNull();
    expect(resolveGeminiThinkingLevel("gemini-3.8-flash", "none")).toBeNull();
    expect(resolveGeminiThinkingLevel("gemini-3.8-flash", "turbo")).toBe("LOW");
    expect(resolveGeminiThinkingLevel("gemini-2.5-flash", "turbo")).toBeNull();
    expect(resolveGeminiThinkingLevel("gemini-2.5-flash", undefined)).toBeNull();

    const custom = await ask("some-new-alias", "MEDIUM");
    expect(custom.gen).toEqual({ maxOutputTokens: GEMINI_DEFAULT_MAX_OUTPUT_TOKENS, thinkingConfig: { thinkingLevel: "MEDIUM" } });
    expect(custom.sampling).toEqual({ maxOutputTokens: GEMINI_DEFAULT_MAX_OUTPUT_TOKENS, thinkingLevel: "MEDIUM" });
    const off = await ask("gemini-3.8-flash", "off");
    expect(off.gen).toEqual({ maxOutputTokens: GEMINI_DEFAULT_MAX_OUTPUT_TOKENS });
    expect(off.sampling).toEqual({ maxOutputTokens: GEMINI_DEFAULT_MAX_OUTPUT_TOKENS });

    expect(geminiThinkingLevelProblem(undefined)).toBeNull();
    expect(geminiThinkingLevelProblem("low")).toBeNull();
    expect(geminiThinkingLevelProblem("OFF")).toBeNull();
    expect(geminiThinkingLevelProblem("turbo")).toContain("GEMINI_THINKING_LEVEL");
  });
});
