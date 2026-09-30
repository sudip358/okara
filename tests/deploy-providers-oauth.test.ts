import { describe, expect, it } from "vitest";
import { encryptSecret } from "@worker/lib/crypto";
import { newId } from "@worker/lib/ids";
import { appOrigin, appRedirectUri } from "@worker/platform/security";
import { disconnectGsc, gscOAuthConfigured, gscRedirectUri, gscTokenAad, handleGscCallback, revokeGscToken, startGscConnect } from "@worker/platform/gsc-oauth";
import { clearGscTokenCache, createGscProvider } from "@worker/platform/gsc-client";
import { createGeminiProvider, GEMINI_DEFAULT_MAX_OUTPUT_TOKENS, parseGeminiResponse, supportsThinkingLevel } from "@worker/providers/gemini";
import { RESERVATION_ENVELOPE } from "@worker/providers/rates";
import { buildOpenAiRequest, OPENAI_REASONING_HEADROOM_TOKENS, parseOpenAiResponse, parseReasoningEffort } from "@worker/providers/writer-openai";
import { createWriter } from "@worker/providers/writer";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";

type Call = { url: string; init: RequestInit };
function recorder(handler: (url: string) => Response) {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    return handler(url);
  }) as typeof fetch;
  return { calls, fn };
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

// ------------------------------------------------------------------ L2 / L3: APP_ORIGIN

describe("appOrigin (L2)", () => {
  it("rejects the wrangler placeholder and non-https origins outside development/test", () => {
    expect(appOrigin(createTestEnv({ ENVIRONMENT: "production", APP_ORIGIN: "https://REPLACE_WITH_APP_ORIGIN" }))).toBeNull();
    expect(appOrigin(createTestEnv({ ENVIRONMENT: "production", APP_ORIGIN: "http://app.example.com" }))).toBeNull();
    expect(appOrigin(createTestEnv({ ENVIRONMENT: "staging", APP_ORIGIN: "http://app.example.com" }))).toBeNull();
    expect(appOrigin(createTestEnv({ ENVIRONMENT: "production", APP_ORIGIN: "" }))).toBeNull();
    expect(appOrigin(createTestEnv({ ENVIRONMENT: "production", APP_ORIGIN: "https://App.Example.com/" }))).toBe("https://app.example.com");
    expect(appOrigin(createTestEnv({ ENVIRONMENT: "development", APP_ORIGIN: "http://localhost:5173" }))).toBe("http://localhost:5173");
  });

  it("placeholder origin makes GSC OAuth setup_required", async () => {
    const env = createTestEnv({ ENVIRONMENT: "production", APP_ORIGIN: "https://REPLACE_WITH_APP_ORIGIN" });
    expect(gscOAuthConfigured(env)).toBe(false);
  });
});

describe("redirect URIs (L3)", () => {
  it("login and GSC redirect URIs share the normalised appOrigin", () => {
    const env = createTestEnv({ ENVIRONMENT: "production", APP_ORIGIN: "https://App.Example.com:443/some/path/" });
    expect(gscRedirectUri(env)).toBe("https://app.example.com/api/gsc/callback");
    expect(appRedirectUri(env, "/api/auth/callback")).toBe("https://app.example.com/api/auth/callback");
    expect(gscRedirectUri(createTestEnv({ ENVIRONMENT: "production", APP_ORIGIN: "http://x.example" }))).toBeNull();
  });
});

// ------------------------------------------------------------------ H5 / L11: GSC OAuth

async function setupConnection(refreshToken = "rt-1") {
  const env = createTestEnv();
  const u = await seedUser(env);
  const projectId = await seedProject(env, u.workspaceId);
  await u.db.insert("oauth_connections", {
    id: newId("oac"), workspace_id: u.workspaceId, project_id: projectId, user_id: u.userId, provider: "google_gsc",
    scopes: "https://www.googleapis.com/auth/webmasters.readonly", refresh_token_enc: await encryptSecret(env, refreshToken, gscTokenAad(projectId)),
    status: "connected", created_at: "2026-09-30T00:00:00Z", updated_at: "2026-09-30T00:00:00Z",
  });
  return { env, u, projectId };
}

describe("GSC disconnect (H5)", () => {
  it("deletes only the local token and never calls Google's revoke endpoint", async () => {
    const { env, u, projectId } = await setupConnection();
    const f = recorder(() => new Response("", { status: 200 }));
    const out = await disconnectGsc(env, u.db, u.workspaceId, projectId, f.fn, FIXED_NOW);
    expect(out).toEqual({ revoked: false });
    expect(f.calls).toHaveLength(0);
    expect(await u.db.first("SELECT id FROM oauth_connections WHERE project_id = ?", projectId)).toBeNull();
    const p = await u.db.first<{ gsc_property: string | null }>("SELECT gsc_property FROM projects WHERE id = ?", projectId);
    expect(p?.gsc_property).toBeNull();
  });

  it("revokeGscToken (project delete path) makes no network call", async () => {
    const { env, u, projectId } = await setupConnection();
    const f = recorder(() => new Response("", { status: 200 }));
    expect(await revokeGscToken(env, u.db, u.workspaceId, projectId, f.fn)).toBe(false);
    expect(f.calls).toHaveLength(0);
  });
});

describe("GSC token endpoint timeouts (L11)", () => {
  it("refresh sends an AbortSignal", async () => {
    const { env, u, projectId } = await setupConnection();
    clearGscTokenCache();
    const f = recorder((url) => (url.includes("oauth2") ? json({ access_token: "at", expires_in: 3600 }) : json({ siteEntry: [] })));
    const gsc = await createGscProvider(env, u.db, { id: projectId, workspaceId: u.workspaceId }, f.fn, () => FIXED_NOW);
    await gsc!.listProperties();
    const tokenCall = f.calls.find((c) => c.url === "https://oauth2.googleapis.com/token")!;
    expect(tokenCall.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("code exchange sends an AbortSignal", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const projectId = await seedProject(env, u.workspaceId);
    const user = { id: u.userId, email: "x@example.com", name: null };
    const url = new URL(await startGscConnect(env, u.db, { user, sessionId: u.sessionId, workspaceId: u.workspaceId, projectId, now: FIXED_NOW }));
    const f = recorder(() => json({ access_token: "at", refresh_token: "rt", scope: "https://www.googleapis.com/auth/webmasters.readonly" }));
    const res = await handleGscCallback(env, u.db, {
      query: new URLSearchParams({ state: url.searchParams.get("state")!, code: "c" }),
      user, sessionId: u.sessionId, now: FIXED_NOW, fetchImpl: f.fn,
    });
    expect(res.ok).toBe(true);
    expect(f.calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });
});

// ------------------------------------------------------------------ H7: Gemini thinking

describe("Gemini thinking budget (H7)", () => {
  it("sends thinkingLevel LOW only to Gemini 3+ ids and raises maxOutputTokens to the reservation envelope", async () => {
    expect(GEMINI_DEFAULT_MAX_OUTPUT_TOKENS).toBe(RESERVATION_ENVELOPE.outputTokens);
    expect(supportsThinkingLevel("gemini-3.8-flash")).toBe(true);
    expect(supportsThinkingLevel("models/gemini-3-pro-preview")).toBe(true);
    expect(supportsThinkingLevel("gemini-2.5-pro")).toBe(false);
    expect(supportsThinkingLevel("gemini-30x")).toBe(false);

    const bodies: Array<Record<string, any>> = [];
    const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init!.body)));
      return json({ candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }] });
    }) as typeof fetch;
    await createGeminiProvider({ apiKey: "k", model: "gemini-3.8-flash", fetchImpl }).ask("q", { locale: "en-US", language: "en" } as never);
    await createGeminiProvider({ apiKey: "k", model: "gemini-2.5-flash", fetchImpl }).ask("q", { locale: "en-US", language: "en" } as never);
    expect(bodies[0]!.generationConfig).toEqual({ maxOutputTokens: RESERVATION_ENVELOPE.outputTokens, thinkingConfig: { thinkingLevel: "LOW" } });
    expect(bodies[1]!.generationConfig).toEqual({ maxOutputTokens: RESERVATION_ENVELOPE.outputTokens });
  });

  it("records MAX_TOKENS distinctly, including when thinking consumed the whole budget", () => {
    const p = parseGeminiResponse({
      candidates: [{ content: { parts: [{ text: "thinking...", thought: true }] }, finishReason: "MAX_TOKENS" }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0, thoughtsTokenCount: 8192 },
    });
    expect(p.status).toBe("incomplete");
    expect(p.finishReason).toBe("MAX_TOKENS");
    expect(p.error).toContain("output token limit");
    expect(p.error).toContain("8192 thinking tokens");
    expect(p.error).toContain("empty");
  });
});

// ------------------------------------------------------------------ L15: OpenAI-compatible writer

describe("OpenAI-compatible writer headroom (L15)", () => {
  const req = { purpose: "p", system: "s", input: {}, jsonSchema: { type: "object" }, maxOutputTokens: 1500 } as never;

  it("adds reasoning headroom and sends reasoning_effort only when configured", () => {
    const body = buildOpenAiRequest("m", req);
    expect(body.max_completion_tokens).toBe(1500 + OPENAI_REASONING_HEADROOM_TOKENS);
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(buildOpenAiRequest("m", req, "low").reasoning_effort).toBe("low");
    expect(parseReasoningEffort(" LOW ")).toBe("low");
    expect(parseReasoningEffort("turbo")).toBeNull();
    expect(parseReasoningEffort(undefined)).toBeNull();
  });

  it("createWriter passes WRITER_REASONING_EFFORT through", async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      sent = JSON.parse(String(init!.body));
      return json({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }) as typeof fetch;
    const w = createWriter(
      { WRITER_PROVIDER: "openai_compatible", WRITER_MODEL: "m", WRITER_BASE_URL: "https://api.example.com/v1", WRITER_REASONING_EFFORT: "minimal" },
      "key", fetchImpl,
    )!;
    await w.write(req);
    expect(sent.reasoning_effort).toBe("minimal");
  });

  it("surfaces finish_reason length clearly", () => {
    const { failure } = parseOpenAiResponse({ choices: [{ message: { content: "{\"a\":" }, finish_reason: "length" }], usage: { prompt_tokens: 5, completion_tokens: 5500 } }, "m");
    expect(failure?.reason).toBe("truncated");
    expect(failure!.message).toContain('finish_reason "length"');
    expect(failure!.message).toContain("5500 completion tokens");
  });
});
