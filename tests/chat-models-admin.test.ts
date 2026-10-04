/**
 * Ask Okara models, credentials and owner admin tools [A35] (owner requests 2026-10-04): `models` lists every
 * integrated model without secrets; `manage_models` / `manage_credentials` / `admin_settings` are confirm-gated,
 * owner-only and run through the existing routes (validation, SSRF rules, keepKeyForNewHost, rate limits); keys
 * only ever travel browser -> credential route (secure field), never through the model, tool input, chat
 * messages, steps or chat_actions rows; pasted keys are masked; key-like tool input is refused.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { AppEnv } from "@worker/app";
import { Db } from "@worker/lib/db";
import { HttpError } from "@worker/lib/errors";
import { newId } from "@worker/lib/ids";
import { decryptSecret, encryptSecret } from "@worker/lib/crypto";
import type { Env } from "@worker/env";
import type { ChatAction, ChatSessionSummary, ChatTurnResult } from "@shared/types";
import { chatRoutes, setChatRouteHooks } from "@worker/routes/chat";
import { credentialRoutes, setCredentialTestFetch } from "@worker/routes/credentials";
import { customProviderRoutes, setCustomProviderFetch } from "@worker/routes/custom-providers";
import { competitorDataRoutes } from "@worker/routes/competitor-data";
import { matonRoutes } from "@worker/routes/maton";
import { setChatModelResolver } from "@worker/chat/model";
import { buildSystemPrompt } from "@worker/chat/prompt";
import { getTool, isActionTool, resultForModel, type ToolContext } from "@worker/chat/tools";
import { KEY_PLACEHOLDER, keyLikeIn, looksLikeSecret, redactSecrets } from "@worker/chat/secrets";
import { secretFieldFor } from "@worker/chat/secret-fields";
import type { ChatModel, RoundRequest, RoundResult } from "@worker/chat/types";
import { customProviderAad } from "@worker/platform/custom-providers";
import { credentialAad } from "@worker/platform/credentials";
import { hitRateLimit } from "@worker/platform/rate-limit";
import { secretKeyHint, secretRequestAllowed, secretRequestBody } from "@web/components/chat/lib";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";
import { projectRow } from "./links-seed";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyData = any;

const ANTHROPIC_ENV: Partial<Env> = { WRITER_PROVIDER: "anthropic", WRITER_MODEL: "configured-chat-model", WRITER_API_KEY: "sk-test-anthropic-0123456789" };

const SECRET = {
  gemini: "AIzaSyGeminiSECRETkey0042ZQ1abcdefghijk",
  writer: "cp-SECRETwriterkey-0042ZQ%2",
  geo: "cp-SECRETgeokey-0042ZQ^3",
  dfsPassword: "dfsSECRETpassword-ZQ&3",
  maton: "maton-SECRETkey-0042ZQ~5",
  refresh: "1//SECRETrefreshtoken-ZQ*4",
};
/** Keys typed in the secure field during the tests. */
const NEW_KEY = "sk-proj-NEWsecretKEY0042abcdEFGH9876wxyz";
const NEW_KEY_2 = "or-NEWtunnelKEY-77ZZqq11";

let customFetches: string[] = [];
let credFetches: string[] = [];
const okModels = () => Response.json({ object: "list", data: [{ id: "meta/llama-3.3-70b" }, { id: "deepseek/deepseek-chat" }] });
const geminiModels = () => Response.json({ models: [{ name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", supportedGenerationMethods: ["generateContent"] }, { name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] }] });

beforeEach(() => {
  customFetches = [];
  credFetches = [];
  setCustomProviderFetch((async (input: RequestInfo | URL) => {
    customFetches.push(String(input instanceof Request ? input.url : input));
    return okModels();
  }) as typeof fetch);
  setCredentialTestFetch((async (input: RequestInfo | URL) => {
    credFetches.push(String(input instanceof Request ? input.url : input));
    return geminiModels();
  }) as typeof fetch);
});
afterEach(() => {
  setChatModelResolver(null);
  setChatRouteHooks({});
  setCustomProviderFetch(null);
  setCredentialTestFetch(null);
});

// ------------------------------------------------------------------ world
async function world() {
  const env = createTestEnv(ANTHROPIC_ENV);
  const owner = await seedUser(env);
  const ws = owner.workspaceId;
  const pid = await seedProject(env, ws);
  const demoPid = await seedProject(env, ws, { name: "Demo shop", is_demo: 1 });
  const db = new Db(env.DB);
  const now = FIXED_NOW.toISOString();
  const memberId = newId("usr");
  await db.insert("users", { id: memberId, google_sub: `sub-${memberId}`, email: `${memberId}@example.com`, name: "Morgan Member", created_at: now });
  await db.insert("memberships", { workspace_id: ws, user_id: memberId, role: "member", created_at: now });

  const geminiEnc = await encryptSecret(env, SECRET.gemini, credentialAad(ws, "gemini"));
  await db.insert("provider_credentials", { id: newId("cred"), workspace_id: ws, provider: "gemini", key_enc: geminiEnc, key_hint: SECRET.gemini.slice(-4), last_tested_at: now, last_test_ok: 1, last_test_detail: "Key accepted.", created_at: now, updated_at: now });
  const dfsEnc = await encryptSecret(env, `login@agency.example\n${SECRET.dfsPassword}`, `provider_credentials:${ws}:dataforseo`);
  await db.insert("provider_credentials", { id: newId("cred"), workspace_id: ws, provider: "dataforseo", key_enc: dfsEnc, key_hint: SECRET.dfsPassword.slice(-4), created_at: now, updated_at: now });
  const matonEnc = await encryptSecret(env, SECRET.maton, `provider_credentials:${ws}:maton`);
  await db.insert("provider_credentials", { id: newId("cred"), workspace_id: ws, provider: "maton", key_enc: matonEnc, key_hint: SECRET.maton.slice(-4), created_at: now, updated_at: now });
  const writerId = newId("cprov");
  const writerEnc = await encryptSecret(env, SECRET.writer, customProviderAad(ws, writerId));
  await db.insert("workspace_custom_providers", { id: writerId, workspace_id: ws, role: "writer", label: "My writer", base_url: "https://writer.customllm.com/v1", host: "writer.customllm.com", model: "meta/llama-3.3-70b", key_enc: writerEnc, key_hint: SECRET.writer.slice(-4), is_writer: 1, created_at: now, updated_at: now });
  const geoId = newId("cprov");
  const geoEnc = await encryptSecret(env, SECRET.geo, customProviderAad(ws, geoId));
  await db.insert("workspace_custom_providers", { id: geoId, workspace_id: ws, role: "geo", label: "Local engine", base_url: "https://llm.customllm.net/v1", host: "llm.customllm.net", model: "custom-geo-1", key_enc: geoEnc, key_hint: SECRET.geo.slice(-4), is_writer: 0, created_at: now, updated_at: now });
  const refreshEnc = await encryptSecret(env, SECRET.refresh, `oauth_connections:${pid}`);
  await db.insert("oauth_connections", { id: newId("oac"), workspace_id: ws, project_id: pid, user_id: owner.userId, provider: "google_gsc", scopes: "https://www.googleapis.com/auth/webmasters.readonly", refresh_token_enc: refreshEnc, status: "connected", created_at: now, updated_at: now });
  const encrypted = [geminiEnc, dfsEnc, matonEnc, writerEnc, geoEnc, refreshEnc];
  return { env, db, ws, pid, demoPid, owner, memberId, writerId, geoId, encrypted };
}
type World = Awaited<ReturnType<typeof world>>;

async function ctxFor(w: World, pid: string, userId: string): Promise<ToolContext> {
  return { env: w.env, db: w.db, project: await projectRow(w.db, pid), userId, now: FIXED_NOW };
}
async function read(ctx: ToolContext, name: string, input: unknown): Promise<{ data: AnyData; summary: string }> {
  const t = getTool(name)!;
  if (isActionTool(t)) throw new Error(`${name} is an action`);
  return t.run(ctx, t.schema.parse(input)) as Promise<{ data: AnyData; summary: string }>;
}
function action(name: string) {
  const t = getTool(name)!;
  if (!isActionTool(t)) throw new Error(`${name} is not an action`);
  return { prepare: (ctx: ToolContext, input: unknown) => t.prepare(ctx, t.schema.parse(input)), execute: (ctx: ToolContext, input: unknown) => t.execute(ctx, t.schema.parse(input), { proposedAt: FIXED_NOW.toISOString(), secret: null }) as Promise<{ data: AnyData; summary: string }> };
}

// ------------------------------------------------------------------ chat + real routes, as one signed-in user
const seenRequests: RoundRequest[] = [];
function fakeModel(script: Array<{ tool?: { name: string; input: Record<string, unknown> }; text: string }>): ChatModel {
  let i = 0;
  return {
    provider: "anthropic",
    model: "fake-models",
    async round(req): Promise<RoundResult> {
      seenRequests.push(JSON.parse(JSON.stringify(req)) as RoundRequest);
      const step = script[Math.min(i++, script.length - 1)]!;
      return step.tool
        ? { raw: [{ type: "tool_use", id: `call_${i}`, name: step.tool.name, input: step.tool.input }], text: step.text, toolCalls: [{ id: `call_${i}`, name: step.tool.name, input: step.tool.input }], stop: "tool_use", usage: { inputTokens: 10, outputTokens: 5 } }
        : { raw: [{ type: "text", text: step.text }], text: step.text, toolCalls: [], stop: "end", usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
}

function testApp(env: Env, userId: string) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", new Db(env.DB));
    c.set("now", FIXED_NOW);
    c.set("user", { id: userId, email: "u@example.com", name: null });
    c.set("session", null);
    await next();
  });
  for (const r of [chatRoutes, credentialRoutes, customProviderRoutes, competitorDataRoutes, matonRoutes]) app.route("/", r);
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    throw err;
  });
  return app;
}
async function call<T>(env: Env, userId: string, method: string, path: string, body?: unknown) {
  const res = await testApp(env, userId).request(path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } }, env);
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as { data: T; error?: { code: string; message: string } } };
}

async function send(w: World, userId: string, content: string, script: Parameters<typeof fakeModel>[0], pid = w.pid) {
  const model = fakeModel(script);
  setChatModelResolver(async () => ({ status: "ready", model }));
  const s = await call<ChatSessionSummary>(w.env, userId, "POST", `/projects/${pid}/chat/sessions`);
  const sid = s.body.data.id;
  const r = await call<ChatTurnResult>(w.env, userId, "POST", `/projects/${pid}/chat/sessions/${sid}/messages`, { content });
  return { sid, r, aid: r.body.data.actions?.[0]?.id ?? null, action: (r.body.data.actions?.[0] ?? null) as ChatAction | null };
}
const propose = (w: World, userId: string, name: string, input: Record<string, unknown>, pid = w.pid) => send(w, userId, `please ${name}`, [{ tool: { name, input }, text: "Proposing." }, { text: "Done." }], pid);
const decide = (w: World, userId: string, sid: string, aid: string, body?: unknown, pid = w.pid) => call<ChatTurnResult>(w.env, userId, "POST", `/projects/${pid}/chat/sessions/${sid}/actions/${aid}/confirm`, body);

/** Every chat-table row (messages incl. steps, actions incl. args/results, sessions incl. paused transcripts). */
async function chatRows(db: Db): Promise<string> {
  const out: string[] = [];
  for (const t of ["chat_sessions", "chat_messages", "chat_actions"]) out.push(JSON.stringify(await db.all(`SELECT * FROM ${t}`)));
  return out.join("\n");
}

// ------------------------------------------------------------------ models (read)
describe("models: every integrated model, no secrets", () => {
  it("lists writer, custom providers, engines, DataForSEO, Maton and Google without keys, encrypted values or tokens anywhere", async () => {
    const w = await world();
    const ctx = await ctxFor(w, w.pid, w.owner.userId);
    const m = await read(ctx, "models", {});
    expect(m.data.writer).toMatchObject({ source: `custom:${w.writerId}`, active: { kind: "custom", host: "writer.customllm.com", model: "meta/llama-3.3-70b" } });
    expect(m.data.customProviders.map((p: AnyData) => [p.id, p.role, p.host, p.model, p.isWriter])).toEqual(
      expect.arrayContaining([
        [w.writerId, "writer", "writer.customllm.com", "meta/llama-3.3-70b", true],
        [w.geoId, "geo", "llm.customllm.net", "custom-geo-1", false],
      ]),
    );
    expect(m.data.engines.find((e: AnyData) => e.provider === "gemini")).toMatchObject({ configured: true, keySource: "workspace_key", lastTestOk: true });
    expect(m.data.engines.find((e: AnyData) => e.provider === "typesafe")).toMatchObject({ modelSelectable: false });
    expect(m.data.dataForSeo).toMatchObject({ configured: true, keySource: "workspace_key" });
    expect(m.data.maton).toMatchObject({ configured: true });
    expect(m.data.google.searchConsole.state).toBe("ready");

    // Members see the same status view (the Integrations page is member-readable).
    expect((await read(await ctxFor(w, w.pid, w.memberId), "models", {})).data.customProviders).toHaveLength(2);

    // Through the chat: tool output, steps, messages and session rows carry no secret.
    const { r } = await send(w, w.owner.userId, "which models are integrated?", [{ tool: { name: "models", input: {} }, text: "" }, { text: "Here they are." }]);
    expect(r.body.data.message.status).toBe("complete");
    const toolResult = JSON.stringify(seenRequests.at(-1)!.turn);
    const all = [resultForModel(m.data), m.summary, toolResult, await chatRows(w.db)].join("\n");
    for (const s of [...Object.values(SECRET), ...w.encrypted, ...Object.values(SECRET).map((x) => x.slice(-4))]) expect(all, `leaked ${s.slice(0, 10)}…`).not.toContain(s);
    expect(all).not.toMatch(/key_enc|keyHint|key_hint|refresh_token/);
    expect(all).toContain("writer.customllm.com");
  });
});

// ------------------------------------------------------------------ manage_models through confirm
describe("manage_models: confirm-gated, through the existing routes", () => {
  it("writer switch: pending changes nothing; confirm switches to the default, then back to the custom writer", async () => {
    const w = await world();
    const p = await propose(w, w.owner.userId, "manage_models", { op: "set_writer", source: "default" });
    expect(p.action).toMatchObject({ name: "manage_models", status: "pending", secretField: null });
    expect(await w.db.first("SELECT is_writer FROM workspace_custom_providers WHERE id = ?", w.writerId)).toEqual({ is_writer: 1 });
    const c = await decide(w, w.owner.userId, p.sid, p.aid!);
    expect(c.body.data.actions[0]).toMatchObject({ status: "executed", result: "Writer source: default" });
    expect(await w.db.first("SELECT is_writer FROM workspace_custom_providers WHERE id = ?", w.writerId)).toEqual({ is_writer: 0 });

    const back = await propose(w, w.owner.userId, "manage_models", { op: "set_writer", source: `custom:${w.writerId}` });
    await decide(w, w.owner.userId, back.sid, back.aid!);
    expect(await w.db.first("SELECT is_writer FROM workspace_custom_providers WHERE id = ?", w.writerId)).toEqual({ is_writer: 1 });
    // A GEO engine is never the writer (route rule, also checked at proposal).
    await expect(action("manage_models").prepare(await ctxFor(w, w.pid, w.owner.userId), { op: "set_writer", source: `custom:${w.geoId}` })).rejects.toThrow(/GEO engine, not a writer/);
  });

  it("model change: must be in the provider's live list (Fetch models route); confirm applies it", async () => {
    const w = await world();
    const ctx = await ctxFor(w, w.pid, w.owner.userId);
    await expect(action("manage_models").prepare(ctx, { op: "set_custom_model", providerId: w.writerId, model: "made-up/model-9" })).rejects.toThrow(/not in the provider's model list/);
    expect(customFetches.every((u) => u.startsWith("https://writer.customllm.com/v1/models"))).toBe(true);
    const p = await propose(w, w.owner.userId, "manage_models", { op: "set_custom_model", providerId: w.writerId, model: "deepseek/deepseek-chat" });
    expect(p.action!.detail).toMatch(/Listed by the provider/);
    expect(await w.db.first("SELECT model FROM workspace_custom_providers WHERE id = ?", w.writerId)).toEqual({ model: "meta/llama-3.3-70b" });
    await decide(w, w.owner.userId, p.sid, p.aid!);
    expect(await w.db.first("SELECT model, key_enc FROM workspace_custom_providers WHERE id = ?", w.writerId)).toMatchObject({ model: "deepseek/deepseek-chat" });
  });

  it("built-in engine model: listed id via the credentials models route, saved in workspace_provider_models; null resets", async () => {
    const w = await world();
    const ctx = await ctxFor(w, w.pid, w.owner.userId);
    await expect(action("manage_models").prepare(ctx, { op: "set_engine_model", engine: "gemini", model: "gemini-9-ultra" })).rejects.toThrow(/not in the provider's model list/);
    const p = await propose(w, w.owner.userId, "manage_models", { op: "set_engine_model", engine: "gemini", model: "gemini-2.5-pro" });
    await decide(w, w.owner.userId, p.sid, p.aid!);
    expect(await w.db.first("SELECT model FROM workspace_provider_models WHERE workspace_id = ? AND provider = 'gemini'", w.ws)).toEqual({ model: "gemini-2.5-pro" });
    expect((await read(ctx, "models", {})).data.engines.find((e: AnyData) => e.provider === "gemini")).toMatchObject({ model: "gemini-2.5-pro", workspaceModel: "gemini-2.5-pro" });
    expect(credFetches[0]).toMatch(/^https:\/\/generativelanguage\.googleapis\.com\//);
    await action("manage_models").execute(ctx, { op: "set_engine_model", engine: "gemini", model: null });
    expect(await w.db.first("SELECT model FROM workspace_provider_models WHERE workspace_id = ? AND provider = 'gemini'", w.ws)).toBeNull();
    // provider_models read (live Fetch models): owner only.
    expect((await read(ctx, "provider_models", { target: "gemini" })).data.models).toEqual(["gemini-2.5-flash", "gemini-2.5-pro"]);
    await expect(read(await ctxFor(w, w.pid, w.memberId), "provider_models", { target: "gemini" })).rejects.toThrow(/Only the workspace owner/);
  });

  it("base URL change keeping the saved key (keepKeyForNewHost): host moves, key envelope unchanged, change logged", async () => {
    const w = await world();
    const before = await w.db.first<{ key_enc: string }>("SELECT key_enc FROM workspace_custom_providers WHERE id = ?", w.writerId);
    const p = await propose(w, w.owner.userId, "manage_models", { op: "update_base_url", providerId: w.writerId, baseUrl: "https://new-tunnel.example.net/v1", keepSavedKey: true });
    expect(p.action).toMatchObject({ status: "pending", secretField: null });
    expect(p.action!.detail).toMatch(/sends the SAVED API key to new-tunnel\.example\.net/);
    await decide(w, w.owner.userId, p.sid, p.aid!);
    const row = await w.db.first<{ host: string; key_enc: string }>("SELECT host, key_enc FROM workspace_custom_providers WHERE id = ?", w.writerId);
    expect(row).toEqual({ host: "new-tunnel.example.net", key_enc: before!.key_enc });
    expect(await w.db.first("SELECT key_kept_for_new_host FROM workspace_custom_provider_changes WHERE provider_id = ?", w.writerId)).toEqual({ key_kept_for_new_host: 1 });
    // Same host without keepSavedKey: nothing to type, the model is told to keep the key.
    await expect(action("manage_models").prepare(await ctxFor(w, w.pid, w.owner.userId), { op: "update_base_url", providerId: w.writerId, baseUrl: "https://new-tunnel.example.net/api/v1" })).rejects.toThrow(/keepSavedKey: true/);
  });

  it("base URL change with a new key: the secure field PATCHes the real route, the chat confirms with {ok, keyHint} only", async () => {
    const w = await world();
    const p = await propose(w, w.owner.userId, "manage_models", { op: "update_base_url", providerId: w.geoId, baseUrl: "https://other-host.example.org/v1" });
    const f = p.action!.secretField!;
    expect(f.request).toEqual({ method: "PATCH", path: `/workspaces/${w.ws}/custom-providers/${w.geoId}`, body: { baseUrl: "https://other-host.example.org/v1" } });
    expect(secretRequestAllowed(f)).toBe(true);
    // Browser: PATCH the route directly with the typed key.
    const saved = await call(w.env, w.owner.userId, f.request.method, f.request.path, secretRequestBody(f, { apiKey: ` ${NEW_KEY_2} ` }));
    expect(saved.status).toBe(200);
    const c = await decide(w, w.owner.userId, p.sid, p.aid!, { secret: { ok: true, keyHint: secretKeyHint(f, { apiKey: NEW_KEY_2 }) } });
    expect(c.body.data.actions[0]).toMatchObject({ status: "executed", result: `Base URL → other-host.example.org with a new key (…${NEW_KEY_2.slice(-4)})`, secretField: null });
    const row = await w.db.first<{ host: string; key_enc: string }>("SELECT host, key_enc FROM workspace_custom_providers WHERE id = ?", w.geoId);
    expect(row!.host).toBe("other-host.example.org");
    expect(await decryptSecret(w.env, row!.key_enc, customProviderAad(w.ws, w.geoId))).toBe(NEW_KEY_2);
    expect(await chatRows(w.db)).not.toContain(NEW_KEY_2);
  });

  it("add provider: key typed in the secure field, posted to POST /custom-providers, stored encrypted, never in chat tables", async () => {
    const w = await world();
    await w.db.run("DELETE FROM workspace_custom_providers WHERE id = ?", w.geoId);
    const p = await propose(w, w.owner.userId, "manage_models", { op: "add_provider", role: "geo", label: "OpenRouter GEO", baseUrl: "https://openrouter.ai/api/v1", model: "deepseek/deepseek-chat" });
    expect(p.r.body.data.message.status).toBe("awaiting_confirmation");
    const f = p.action!.secretField!;
    expect(f).toMatchObject({ fields: [{ name: "apiKey" }], hintFrom: "apiKey", request: { method: "POST", path: `/workspaces/${w.ws}/custom-providers`, body: { baseUrl: "https://openrouter.ai/api/v1", model: "deepseek/deepseek-chat", label: "OpenRouter GEO", role: "geo" } } });
    expect(Object.keys(f.request.body)).not.toContain("apiKey");
    expect(await w.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM workspace_custom_providers WHERE workspace_id = ?", w.ws)).toEqual({ n: 1 });

    // Confirming without the secure field, or with a key in the confirm body, is refused (nothing runs).
    expect((await decide(w, w.owner.userId, p.sid, p.aid!)).body.error).toMatchObject({ code: "secret_required" });
    const leaky = await decide(w, w.owner.userId, p.sid, p.aid!, { secret: { ok: true, keyHint: "wxyz" }, apiKey: NEW_KEY });
    expect(leaky.status).toBe(400);
    expect(JSON.stringify(leaky.body)).not.toContain(NEW_KEY);
    expect((await decide(w, w.owner.userId, p.sid, p.aid!, { secret: { ok: true, keyHint: NEW_KEY } })).status).toBe(400); // hint is 4 chars max

    // Browser posts the key to the real route, then confirms with the hint.
    const created = await call<AnyData>(w.env, w.owner.userId, f.request.method, f.request.path, secretRequestBody(f, { apiKey: NEW_KEY }));
    expect(created.status).toBe(201);
    const c = await decide(w, w.owner.userId, p.sid, p.aid!, { secret: { ok: true, keyHint: NEW_KEY.slice(-4) } });
    expect(c.body.data.actions[0]!.status).toBe("executed");
    expect(c.body.data.actions[0]!.result).toMatch(/Added OpenRouter GEO \(openrouter\.ai, key …wxyz\)/);
    const row = await w.db.first<{ id: string; role: string; key_enc: string; key_hint: string }>("SELECT id, role, key_enc, key_hint FROM workspace_custom_providers WHERE workspace_id = ? AND host = 'openrouter.ai'", w.ws);
    expect(row).toMatchObject({ role: "geo", key_hint: "wxyz" });
    expect(row!.key_enc).not.toContain(NEW_KEY);
    expect(await decryptSecret(w.env, row!.key_enc, customProviderAad(w.ws, row!.id))).toBe(NEW_KEY);
    const rows = await chatRows(w.db);
    expect(rows).not.toContain(NEW_KEY);
    expect(rows).not.toContain(row!.key_enc);
    // The model only got {ok, executed, data} without any key.
    expect(JSON.stringify(seenRequests)).not.toContain(NEW_KEY);
  });

  it("a confirm whose hint does not match a saved key fails without changing anything", async () => {
    const w = await world();
    const p = await propose(w, w.owner.userId, "manage_credentials", { op: "set_key", target: "perplexity" });
    expect(p.action!.secretField).toMatchObject({ request: { method: "PUT", path: `/workspaces/${w.ws}/credentials/perplexity`, body: {} } });
    const c = await decide(w, w.owner.userId, p.sid, p.aid!, { secret: { ok: true, keyHint: "zzzz" } });
    expect(c.body.data.actions[0]).toMatchObject({ status: "failed" });
    expect(c.body.data.actions[0]!.result).toMatch(/Could not confirm/);
    expect(await w.db.first("SELECT 1 AS n FROM provider_credentials WHERE workspace_id = ? AND provider = 'perplexity'", w.ws)).toBeNull();
  });
});

// ------------------------------------------------------------------ manage_credentials
describe("manage_credentials", () => {
  it("set_key for built-ins / DataForSEO / Maton uses the secure field; remove_key and test run through the routes", async () => {
    const w = await world();
    const ws = w.ws;
    const fields = (target: string) => secretFieldFor("manage_credentials", { op: "set_key", target }, ws);
    expect(fields("dataforseo")).toMatchObject({ fields: [{ name: "login" }, { name: "password" }], hintFrom: "password", request: { method: "PUT", path: `/workspaces/${ws}/dataforseo` } });
    expect(fields("maton")!.request.path).toBe(`/workspaces/${ws}/maton`);
    expect(fields(`custom:${w.writerId}`)!.request).toMatchObject({ method: "PATCH", path: `/workspaces/${ws}/custom-providers/${w.writerId}` });
    expect(secretFieldFor("manage_credentials", { op: "remove_key", target: "gemini" }, ws)).toBeNull();

    // Gemini key replaced via the secure field (the real PUT route), then tested, then removed.
    const p = await propose(w, w.owner.userId, "manage_credentials", { op: "set_key", target: "gemini" });
    const f = p.action!.secretField!;
    expect((await call(w.env, w.owner.userId, f.request.method, f.request.path, secretRequestBody(f, { apiKey: NEW_KEY }))).status).toBe(200);
    const c = await decide(w, w.owner.userId, p.sid, p.aid!, { secret: { ok: true, keyHint: secretKeyHint(f, { apiKey: NEW_KEY }) } });
    expect(c.body.data.actions[0]).toMatchObject({ status: "executed", result: "Key saved for Google Gemini (…wxyz)" });
    const cred = await w.db.first<{ key_enc: string }>("SELECT key_enc FROM provider_credentials WHERE workspace_id = ? AND provider = 'gemini'", ws);
    expect(await decryptSecret(w.env, cred!.key_enc, credentialAad(ws, "gemini"))).toBe(NEW_KEY);
    expect(await chatRows(w.db)).not.toContain(NEW_KEY);

    const t = await propose(w, w.owner.userId, "manage_credentials", { op: "test", target: "gemini" });
    const tc = await decide(w, w.owner.userId, t.sid, t.aid!);
    expect(tc.body.data.actions[0]!.result).toMatch(/Test Google Gemini: ok/);
    expect(await w.db.first("SELECT last_test_ok FROM provider_credentials WHERE workspace_id = ? AND provider = 'gemini'", ws)).toEqual({ last_test_ok: 1 });

    const r = await propose(w, w.owner.userId, "manage_credentials", { op: "remove_key", target: "gemini" });
    await decide(w, w.owner.userId, r.sid, r.aid!);
    expect(await w.db.first("SELECT 1 AS n FROM provider_credentials WHERE workspace_id = ? AND provider = 'gemini'", ws)).toBeNull();
    await expect(action("manage_credentials").prepare(await ctxFor(w, w.pid, w.owner.userId), { op: "remove_key", target: "gemini" })).rejects.toThrow(/No workspace key is saved/);
  });

  it("schemas take no key field; key-like tool input is refused before anything is recorded", async () => {
    const w = await world();
    for (const [name, input] of [
      ["manage_credentials", { op: "set_key", target: "gemini", apiKey: NEW_KEY }],
      ["manage_models", { op: "add_provider", baseUrl: "https://openrouter.ai/api/v1", model: "x/y", apiKey: NEW_KEY }],
      ["manage_models", { op: "update_base_url", providerId: w.writerId, baseUrl: "https://a.example.com/v1", key: NEW_KEY }],
      ["admin_settings", { op: "maton_connection", app: "google-sheets", connectionId: null, password: "hunter22x" }],
    ] as const) {
      expect(getTool(name)!.schema.safeParse(input).success, name).toBe(false);
      expect(keyLikeIn(input).length, name).toBeGreaterThan(0);
    }
    // The model tries to smuggle a key (as a field, and inside a label): refused, no pending action, nothing stored.
    for (const input of [
      { op: "set_key", target: "gemini", apiKey: NEW_KEY },
      { op: "add_provider", baseUrl: "https://openrouter.ai/api/v1", model: "x/y", label: `key ${NEW_KEY}` },
    ]) {
      const name = "op" in input && input.op === "set_key" ? "manage_credentials" : "manage_models";
      const p = await propose(w, w.owner.userId, name, input);
      expect(p.r.body.data.actions).toHaveLength(0);
      expect(p.r.body.data.message.steps[0]).toMatchObject({ status: "error", args: "[withheld: looked like a secret]" });
      const toolResult = seenRequests.at(-1)!.turn.find((t) => t.role === "tool_results");
      expect(JSON.stringify(toolResult)).toMatch(/secure field/);
      expect(JSON.stringify(seenRequests.at(-1))).not.toContain(NEW_KEY); // the replayed assistant round is scrubbed
      expect(await chatRows(w.db)).not.toContain(NEW_KEY);
    }
    // Ordinary ids and model names are not mistaken for keys.
    expect(keyLikeIn({ op: "set_custom_model", providerId: w.writerId, model: "claude-opus-4-20250514" })).toEqual([]);
    expect(keyLikeIn({ view: "sheet_values", spreadsheet: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde" })).toEqual([]);
    expect(looksLikeSecret("Open https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789XyZ/edit")).toBe(false);
  });

  it("a user message containing a key is stored masked and the model sees the placeholder", async () => {
    const w = await world();
    const { r } = await send(w, w.owner.userId, `here is my gemini key ${SECRET.gemini} please save it`, [{ text: "I removed it; use the secure field." }]);
    expect(r.body.data.userMessage!.content).toBe(`here is my gemini key ${KEY_PLACEHOLDER} please save it`);
    const stored = await w.db.first<{ content: string }>("SELECT content FROM chat_messages WHERE role = 'user'");
    expect(stored!.content).toContain(KEY_PLACEHOLDER);
    expect(await chatRows(w.db)).not.toContain(SECRET.gemini);
    expect(JSON.stringify(seenRequests.at(-1)!.turn)).toContain(KEY_PLACEHOLDER);
    expect(JSON.stringify(seenRequests)).not.toContain(SECRET.gemini);
    // Session title (first message) is built from the masked text too.
    expect(JSON.stringify(await w.db.all("SELECT title FROM chat_sessions"))).not.toContain(SECRET.gemini);
    // Other shapes.
    expect(redactSecrets("my password is S3cret-pa55word").text).toBe(`my password is ${KEY_PLACEHOLDER}`);
    expect(redactSecrets("token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234").count).toBe(1);
    expect(redactSecrets("use model gemini-2.5-flash and the key is configured").count).toBe(0);
  });
});

// ------------------------------------------------------------------ roles, SSRF, demo, admin settings, limits
describe("roles, validation, demo projects and admin settings", () => {
  it("members are refused at proposal (no pending action) and the route refuses at execution if the role changed", async () => {
    const w = await world();
    const member = await ctxFor(w, w.pid, w.memberId);
    for (const [name, input] of [
      ["manage_credentials", { op: "set_key", target: "gemini" }],
      ["manage_credentials", { op: "remove_key", target: "gemini" }],
      ["manage_models", { op: "set_writer", source: "default" }],
      ["manage_models", { op: "add_provider", baseUrl: "https://openrouter.ai/api/v1", model: "x/y" }],
      ["admin_settings", { op: "maton_connection", app: "google-sheets", connectionId: null }],
    ] as const) {
      await expect(action(name).prepare(member, input), name).rejects.toThrow(/Only the workspace owner/);
    }
    const p = await propose(w, w.memberId, "manage_credentials", { op: "set_key", target: "gemini" });
    expect(p.r.body.data.actions).toHaveLength(0);
    // Owner proposes, is demoted before confirming: refused (tool re-check, and the route's own owner check).
    const o = await propose(w, w.owner.userId, "manage_models", { op: "set_writer", source: "default" });
    await w.db.run("UPDATE memberships SET role = 'member' WHERE user_id = ?", w.owner.userId);
    const c = await decide(w, w.owner.userId, o.sid, o.aid!);
    expect(c.body.data.actions[0]).toMatchObject({ status: "failed" });
    expect(await w.db.first("SELECT is_writer FROM workspace_custom_providers WHERE id = ?", w.writerId)).toEqual({ is_writer: 1 });
  });

  it("SSRF-invalid base URLs are refused with the route's validator (validateCustomBaseUrl)", async () => {
    const w = await world();
    const ctx = await ctxFor(w, w.pid, w.owner.userId);
    for (const baseUrl of ["https://127.0.0.1/v1", "http://api.example.com/v1", "https://localhost/v1", "https://llm.internal/v1", "https://api.example.com:8443/v1", "https://user:pw@api.example.com/v1", "http://localhost:5173/api"]) {
      await expect(action("manage_models").prepare(ctx, { op: "add_provider", baseUrl, model: "x/y" }), baseUrl).rejects.toThrow(/Base URL refused/);
      await expect(action("manage_models").prepare(ctx, { op: "update_base_url", providerId: w.writerId, baseUrl, keepSavedKey: true }), baseUrl).rejects.toThrow(/Base URL refused/);
    }
    expect(customFetches).toEqual([]);
  });

  it("demo project: workspace-level model/credential tools behave as the routes; the Search Console source is refused", async () => {
    const w = await world();
    const ctx = await ctxFor(w, w.demoPid, w.owner.userId);
    expect((await read(ctx, "models", {})).data.customProviders).toHaveLength(2);
    expect((await action("manage_credentials").prepare(ctx, { op: "set_key", target: "openai_geo" })).title).toMatch(/OpenAI/);
    await expect(action("admin_settings").prepare(ctx, { op: "gsc_source", source: "direct" })).rejects.toThrow(/Demo projects cannot change their Search Console source/);
    // Even if proposed, the route refuses at execution.
    await expect(action("admin_settings").execute(ctx, { op: "gsc_source", source: "direct" })).rejects.toThrow(/Demo projects cannot change/);
  });

  it("admin_settings: context document (facts kept), DataForSEO auto-fetch, Maton connection and decision feedback via the routes", async () => {
    const w = await world();
    const ctx = await ctxFor(w, w.pid, w.owner.userId);
    await w.db.insert("context_documents", { id: newId("ctx"), workspace_id: w.ws, project_id: w.pid, kind: "voice", doc_key: "voice", title: "Voice", version: 1, content: "Old voice", facts_json: JSON.stringify([{ id: "f1", text: "Warm, plain words", confirmed: true, source: "user" }]), created_by: w.owner.userId, created_at: FIXED_NOW.toISOString() }).catch(() => undefined);
    const p = await propose(w, w.owner.userId, "admin_settings", { op: "context_doc", kind: "voice", content: "Confident, warm and plain." });
    expect(p.action!.detail).toMatch(/fact\(s\) kept/);
    const c = await decide(w, w.owner.userId, p.sid, p.aid!);
    expect(c.body.data.actions[0]).toMatchObject({ status: "executed" });
    const ctxDoc = (await read(ctx, "project_admin", { view: "context" })).data;
    expect(JSON.stringify(ctxDoc)).toContain("Confident, warm and plain.");

    await action("admin_settings").execute(ctx, { op: "dataforseo_settings", autoFetch: false });
    expect(await w.db.first("SELECT auto_fetch FROM competitor_data_settings WHERE project_id = ?", w.pid)).toEqual({ auto_fetch: 0 });

    await expect(action("admin_settings").execute(ctx, { op: "maton_connection", app: "google-sheets", connectionId: "conn_missing" })).rejects.toThrow(/not one of this workspace's active Maton connections/);
    await expect(action("admin_settings").prepare(ctx, { op: "decision_feedback", decisionId: "dec_missing", humanAnswer: "yes" })).rejects.toThrow(/No Jev decision/);
  });

  it("route rate limits are shared with the Integrations page", async () => {
    const w = await world();
    for (let i = 0; i < 20; i++) await hitRateLimit(w.db, `cprov_write:${w.ws}:${w.owner.userId}`, 20, 60, FIXED_NOW);
    const p = await propose(w, w.owner.userId, "manage_models", { op: "set_writer", source: "default" });
    const c = await decide(w, w.owner.userId, p.sid, p.aid!);
    expect(c.body.data.actions[0]).toMatchObject({ status: "failed" });
    expect(c.body.data.actions[0]!.result).toMatch(/Too many requests.*rate limit shared/);
    expect(await w.db.first("SELECT is_writer FROM workspace_custom_providers WHERE id = ?", w.writerId)).toEqual({ is_writer: 1 });
  });

  it("the prompt describes the new tools and forbids asking for keys in chat", async () => {
    const w = await world();
    const prompt = buildSystemPrompt(await projectRow(w.db, w.pid), "2026-10-04");
    for (const name of ["models", "provider_models", "integration_options", "manage_models", "manage_credentials", "admin_settings"]) expect(prompt).toContain(name);
    expect(prompt).toMatch(/NEVER ask the user to paste a key/);
    expect(prompt).toContain(KEY_PLACEHOLDER);
  });
});

// ------------------------------------------------------------------ web: secure-field card
describe("web secure-field card", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type FC = (props: any) => ReactElement | null;
  const load = async <T,>(rel: string): Promise<T> => (await import(/* @vite-ignore */ rel)) as T;

  it("only credential routes are allowed; the request body never pre-carries a secret", () => {
    const ok = secretFieldFor("manage_credentials", { op: "set_key", target: "gemini" }, "ws_abc")!;
    expect(secretRequestAllowed(ok)).toBe(true);
    expect(secretRequestAllowed({ ...ok, request: { ...ok.request, path: "/projects/p1/chat/sessions" } })).toBe(false);
    expect(secretRequestAllowed({ ...ok, request: { ...ok.request, path: "https://evil.example/collect" } })).toBe(false);
    expect(secretRequestAllowed({ ...ok, request: { ...ok.request, method: "POST" } })).toBe(false);
    expect(secretRequestAllowed({ ...ok, request: { ...ok.request, body: { apiKey: "x" } } })).toBe(false);
    expect(secretRequestBody(ok, { apiKey: "  abcd1234XYZ  " })).toEqual({ apiKey: "abcd1234XYZ" });
    expect(secretKeyHint(ok, { apiKey: " abcd1234XYZ " })).toBe("4XYZ");
  });

  it("renders password inputs with autocomplete off and no value; settled actions show the result hint", async () => {
    const panel = await load<Record<"AssistantMessage", FC>>("../src/web/components/chat/ChatPanel.tsx");
    const secretField = secretFieldFor("manage_credentials", { op: "set_key", target: "dataforseo" }, "ws_abc")!;
    const a: ChatAction = { id: "a1", messageId: "m1", name: "manage_credentials", title: "Set the DataForSEO API login and password?", detail: "Type it below.", args: { op: "set_key", target: "dataforseo" }, status: "pending", result: null, createdAt: "", decidedAt: null, secretField };
    const message = { id: "m1", role: "assistant", content: "", status: "awaiting_confirmation", steps: [{ id: "s1", kind: "action", tool: "manage_credentials", args: "", result: "", status: "awaiting_confirmation", actionId: "a1" }], error: null, model: null, createdAt: "" };
    const html = renderToStaticMarkup(h(MemoryRouter, null, h(panel.AssistantMessage, { message, actions: [a], projectId: "p1", busy: false, onDecide: () => {}, onNavigate: () => {} })));
    expect(html.match(/type="password"/g)).toHaveLength(2);
    expect(html.match(/autoComplete="off"/g)!.length).toBeGreaterThanOrEqual(3); // form + both inputs
    expect(html).not.toMatch(/value="/);
    expect(html).toContain("Save securely and confirm");
    expect(html).not.toContain(">Confirm<");
    const done = renderToStaticMarkup(h(MemoryRouter, null, h(panel.AssistantMessage, { message: { ...message, status: "complete" }, actions: [{ ...a, status: "executed", secretField: null, result: "Key saved for DataForSEO (…ZQ&3)" }], projectId: "p1", busy: false, onDecide: () => {}, onNavigate: () => {} })));
    expect(done).not.toContain('type="password"');
    expect(done).toContain("Key saved for DataForSEO (…ZQ&amp;3)");
  });
});
