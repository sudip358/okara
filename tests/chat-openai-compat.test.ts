/** Ask Okara over OpenAI-compatible servers that deviate from the reference response shape. Synthetic bodies. */
import { describe, expect, it } from "vitest";
import { contentText, createOpenAiChatModel, describeEmptyResponse, extractTextToolCalls, parseOpenAiChatResponse } from "@worker/chat/model-openai";
import { ChatModelError } from "@worker/chat/types";

describe("parseOpenAiChatResponse tolerates compatible-server variants", () => {
  it("synthesizes an id when a tool call has none, and accepts object arguments", () => {
    const r = parseOpenAiChatResponse({ choices: [{ message: { content: null, tool_calls: [{ function: { name: "search_console_queries", arguments: { limit: 5 } } }] }, finish_reason: "tool_calls" }] });
    expect(r.stop).toBe("tool_use");
    expect(r.toolCalls).toEqual([{ id: "call_okara_0", name: "search_console_queries", input: { limit: 5 } }]);
    expect(r.raw).toEqual({ role: "assistant", content: null, tool_calls: [{ id: "call_okara_0", type: "function", function: { name: "search_console_queries", arguments: '{"limit":5}' } }] });
  });

  it("reads a legacy function_call", () => {
    const r = parseOpenAiChatResponse({ choices: [{ message: { function_call: { name: "project_overview", arguments: "{}" } }, finish_reason: "function_call" }] });
    expect(r.toolCalls.map((c) => c.name)).toEqual(["project_overview"]);
  });

  it("joins content-part arrays", () => {
    expect(contentText([{ type: "text", text: "Clicks fell " }, { type: "text", text: "12%." }])).toBe("Clicks fell 12%.");
    const r = parseOpenAiChatResponse({ choices: [{ message: { content: [{ type: "output_text", text: "Done." }] }, finish_reason: "stop" }] });
    expect(r.text).toBe("Done.");
    expect(r.stop).toBe("end");
  });

  it("takes <tool_call> blocks from the text only when well formed, and removes them from the visible answer", () => {
    const t = extractTextToolCalls('Checking.\n<tool_call>{"name": "search_console_compare", "arguments": {"dimension": "query"}}</tool_call>');
    expect(t.calls).toEqual([{ name: "search_console_compare", arguments: '{"dimension":"query"}' }]);
    expect(t.text).toBe("Checking.");
    expect(extractTextToolCalls("<tool_call>not json</tool_call>").calls).toEqual([]);
    const r = parseOpenAiChatResponse({ choices: [{ message: { content: '<tool_call>{"name":"x","arguments":"{}"}</tool_call>' }, finish_reason: "stop" }] });
    expect(r.stop).toBe("tool_use");
    expect(r.toolCalls[0]).toMatchObject({ id: "call_okara_0", name: "x" });
  });

  it("keeps real ids from standard responses", () => {
    const r = parseOpenAiChatResponse({ choices: [{ message: { content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "a", arguments: "{}" } }] }, finish_reason: "tool_calls" }] });
    expect(r.toolCalls[0]!.id).toBe("call_1");
  });
});

describe("empty answers are explained instead of 'I could not produce an answer'", () => {
  it("describes field names only, never values", () => {
    expect(describeEmptyResponse({ choices: [{ message: { role: "assistant", content: "", reasoning_content: "secret thoughts" } as never, finish_reason: "stop" }] })).toBe(
      "finish_reason stop; message fields: content, reasoning_content",
    );
    expect(describeEmptyResponse({})).toBe("no choices in the response");
  });

  it("the model throws a ChatModelError naming the model and the fix", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "", reasoning_content: "x" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const model = createOpenAiChatModel({ apiKey: "k", model: "demo-model", baseUrl: "https://llm.example.com/v1", fetchImpl, maxRetries: 0 });
    const err = await model.round({ system: "s", history: [], turn: [{ role: "user", text: "hi" }], tools: [], timeoutMs: 10_000 }).catch((e) => e);
    expect(err).toBeInstanceOf(ChatModelError);
    expect((err as ChatModelError).reason).toBe("invalid_response");
    expect((err as Error).message).toContain("demo-model answered with neither text nor a tool call (finish_reason stop; message fields: content, reasoning_content)");
    expect((err as Error).message).not.toContain("x\"");
  });
});
