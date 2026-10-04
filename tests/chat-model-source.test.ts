/**
 * [A36] Ask Okara's own chat model (owner request 2026-10-04: "add separate system to add model for agent chatbot"):
 * migration 0019 (role 'chat' + is_chat, table rebuilt with every existing row preserved), routes (POST role chat,
 * PUT chat-model-source; owner only, tenancy, SSRF validation, no key in any response), resolution (default =
 * writer, unchanged; a selected chat provider gets the request with ITS base URL, key and model; selected but
 * unusable -> setup_required, never a fallback; the writer is unaffected), chat tool ops, and the web card markup.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "@worker/app";
import type { Env } from "@worker/env";
import { Db } from "@worker/lib/db";
import { encryptSecret } from "@worker/lib/crypto";
import { newId } from "@worker/lib/ids";
import { customProviderAad, resolveCustomWriter } from "@worker/platform/custom-providers";
import { setCustomProviderFetch } from "@worker/routes/custom-providers";
import { chatModelStatus, resolveChatModel } from "@worker/chat/model";
import { getTool, isActionTool, type ToolContext } from "@worker/chat/tools";
import { secretFieldFor } from "@worker/chat/secret-fields";
import { secretRequestAllowed } from "@web/components/chat/lib";
import { activeChatProvider, chatProviders, newProviderBody, writerModelLabel } from "@web/pages/integrations/custom-writer-lib";
import type { CustomProviderStatus, CustomProvidersResponse, IntegrationsStatus } from "@shared/types";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, authHeaders, seedProject, seedUser } from "./helpers/fixtures";
import { projectRow } from "./links-seed";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyData = any;

const app = createApp();
const WRITER_KEY = "sk-writer-SECRETkey-0042abcdWRTR";
const CHAT_KEY = "sk-chat-SECRETkey-0042abcdCHAT";
const WRITER_BASE = "https://grok.example-gateway.com/v1";
const CHAT_BASE = "https://chat.toolmodels.com/v1";

let seenFetch: Array<{ url: string; auth: string | null; body: string | null }> = [];
const okModels = () => Response.json({ object: "list", data: [{ id: "tool-model-1" }, { id: "tool-model-2" }] });
beforeEach(() => {
  seenFetch = [];
  setCustomProviderFetch((async (input: RequestInfo | URL, init?: RequestInit) => {
    seenFetch.push({ url: String(input instanceof Request ? input.url : input), auth: new Headers(init?.headers).get("authorization"), body: null });
    return okModels();
  }) as typeof fetch);
});
afterEach(() => setCustomProviderFetch(null));

type Seeded = Awaited<ReturnType<typeof seedUser>>;
const bodies: string[] = [];
async function call(env: Env, u: Seeded, method: string, path: string, body?: unknown) {
  const res = await app.request(`/api${path}`, { method, headers: authHeaders(u.sessionToken, u.csrfToken), body: body === undefined ? undefined : JSON.stringify(body) }, env);
  const text = await res.text();
  bodies.push(text);
  return { status: res.status, json: (text ? JSON.parse(text) : null) as { data?: AnyData; error?: { code: string; message: string; details?: AnyData } } };
}
const cp = (u: Seeded) => `/workspaces/${u.workspaceId}/custom-providers`;
const chatSourcePath = (u: Seeded) => `/workspaces/${u.workspaceId}/chat-model-source`;

async function seedCustomWriter(env: Env, u: Seeded) {
  const id = newId("cprov");
  const now = FIXED_NOW.toISOString();
  await u.db.insert("workspace_custom_providers", {
    id,
    workspace_id: u.workspaceId,
    role: "writer",
    label: "Grok gateway",
    base_url: WRITER_BASE,
    host: "grok.example-gateway.com",
    model: "grok-4.7-fast",
    key_enc: await encryptSecret(env, WRITER_KEY, customProviderAad(u.workspaceId, id)),
    key_hint: WRITER_KEY.slice(-4),
    is_writer: 1,
    created_at: now,
    updated_at: now,
  });
  return id;
}

async function addChat(env: Env, u: Seeded, over: Record<string, unknown> = {}) {
  const r = await call(env, u, "POST", cp(u), { baseUrl: CHAT_BASE, apiKey: CHAT_KEY, model: "tool-model-1", role: "chat", ...over });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json!.data as CustomProvidersResponse;
}

async function addMember(env: Env, workspaceId: string) {
  const member = await seedUser(env);
  await member.db.insert("memberships", { workspace_id: workspaceId, user_id: member.userId, role: "member", created_at: FIXED_NOW.toISOString() });
  return member;
}

/** Fake OpenAI-compatible server for chat rounds: records URL, auth and body. */
function chatServer() {
  const seen: Array<{ url: string; auth: string | null; body: AnyData }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input instanceof Request ? input.url : input), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body ?? "{}")) });
    return Response.json({ choices: [{ message: { role: "assistant", content: "Hello from the model." }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 4 } });
  }) as typeof fetch;
  return { seen, fetchImpl };
}
const round = { system: "s", history: [], turn: [{ role: "user" as const, text: "hi" }], tools: [], timeoutMs: 10_000 };

// ------------------------------------------------------------------ migration 0019
describe("migration 0019 (role 'chat', is_chat)", () => {
  it("rebuilds workspace_custom_providers preserving every existing row, then enforces one chat model per workspace", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    const dir = join(process.cwd(), "migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    expect(files).toContain("0019_custom_provider_chat_role.sql");
    for (const f of files.filter((f) => f < "0019")) db.exec(readFileSync(join(dir, f), "utf8"));
    db.exec("INSERT INTO workspaces (id, name, created_at) VALUES ('ws1', 'W', 't'), ('ws2', 'W2', 't')");
    const ins = db.prepare(
      `INSERT INTO workspace_custom_providers (id, workspace_id, label, base_url, host, model, key_enc, key_hint, is_writer, last_tested_at, last_test_ok, last_test_detail, created_at, updated_at, role)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    ins.run("c1", "ws1", "Writer", "https://a.example.com/v1", "a.example.com", "m1", "v1.env.1", "AAAA", 1, "2026-10-01", 1, "ok", "2026-09-01", "2026-09-02", "writer");
    ins.run("c2", "ws1", "Geo", "https://b.example.com/v1", "b.example.com", "m2", "v1.env.2", "BBBB", 0, null, null, null, "2026-09-03", "2026-09-04", "geo");
    ins.run("c3", "ws2", "Other", "https://c.example.com/v1", "c.example.com", "m3", "v1.env.3", "CCCC", 0, "2026-10-02", 0, "Key rejected", "2026-09-05", "2026-09-06", "writer");
    const before = db.prepare("SELECT * FROM workspace_custom_providers ORDER BY id").all();
    expect(() => ins.run("cx", "ws1", "Chat", "https://d.example.com/v1", "d.example.com", "m", "e", "DDDD", 0, null, null, null, "t", "t", "chat")).toThrow(/CHECK/);

    db.exec(readFileSync(join(dir, "0019_custom_provider_chat_role.sql"), "utf8"));
    const after = db.prepare("SELECT * FROM workspace_custom_providers ORDER BY id").all() as Array<Record<string, unknown>>;
    expect(after.map(({ is_chat, ...rest }) => ({ ...rest }))).toEqual(before.map((r) => ({ ...(r as object) })));
    expect(after.every((r) => r.is_chat === 0)).toBe(true);
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'workspace_custom_providers' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    expect(indexes).toEqual(["idx_custom_providers_one_chat", "idx_custom_providers_one_writer", "idx_custom_providers_role", "idx_custom_providers_workspace"]);

    const insChat = db.prepare(
      "INSERT INTO workspace_custom_providers (id, workspace_id, label, base_url, host, model, key_enc, key_hint, created_at, updated_at, role, is_chat) VALUES (?, ?, 'Chat', 'https://d.example.com/v1', 'd.example.com', 'm', 'e', 'DDDD', 't', 't', 'chat', ?)",
    );
    insChat.run("k1", "ws1", 1);
    expect(() => insChat.run("k2", "ws1", 1)).toThrow(/UNIQUE/);
    insChat.run("k3", "ws2", 1); // one per workspace
    expect(() => insChat.run("k4", "ws1", 2)).toThrow(/CHECK/);
    expect(() => insChat.run("k5", "ws_missing", 0)).toThrow(/FOREIGN KEY/);
    db.exec("DELETE FROM workspaces WHERE id = 'ws1'");
    expect((db.prepare("SELECT id FROM workspace_custom_providers ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id)).toEqual(["c3", "k3"]);
  });
});

// ------------------------------------------------------------------ routes
describe("chat model routes", () => {
  it("default chat source is the writer; adding a role chat provider selects it without touching the writer; no key in any response", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const writerId = await seedCustomWriter(env, u);
    const list = await call(env, u, "GET", cp(u));
    expect(list.json!.data).toMatchObject({ chatSource: "writer", writerSource: `custom:${writerId}`, maxChatProviders: 3 });
    expect(list.json!.data.chatDataSent).toMatch(/function tools/);

    const data = await addChat(env, u, { label: "Tools model" });
    const chat = chatProviders(data)[0]!;
    expect(chat).toMatchObject({ role: "chat", isChat: true, isWriter: false, host: "chat.toolmodels.com", model: "tool-model-1", keyHint: CHAT_KEY.slice(-4) });
    expect(data.chatSource).toBe(`custom:${chat.id}`);
    expect(data.writerSource).toBe(`custom:${writerId}`); // writer unchanged
    expect(await u.db.first("SELECT is_writer, is_chat FROM workspace_custom_providers WHERE id = ?", writerId)).toEqual({ is_writer: 1, is_chat: 0 });

    // A second chat model saved without selecting it; then switching between them and back to the writer.
    const second = await addChat(env, u, { model: "tool-model-2", useAsChat: false });
    const other = chatProviders(second).find((p) => p.model === "tool-model-2")!;
    expect(second.chatSource).toBe(`custom:${chat.id}`);
    const sw = await call(env, u, "PUT", chatSourcePath(u), { source: `custom:${other.id}` });
    expect(sw.status).toBe(200);
    expect(sw.json!.data.chatSource).toBe(`custom:${other.id}`);
    expect(activeChatProvider(sw.json!.data)!.id).toBe(other.id);
    const back = await call(env, u, "PUT", chatSourcePath(u), { source: "writer" });
    expect(back.json!.data.chatSource).toBe("writer");
    expect(back.json!.data.writerSource).toBe(`custom:${writerId}`);

    // Test and Fetch models of a chat provider use its own host and key.
    seenFetch = [];
    const t = await call(env, u, "POST", `${cp(u)}/${chat.id}/test`, {});
    expect(t.json!.data).toMatchObject({ ok: true, modelListed: true });
    expect(t.json!.data.detail).toMatch(/first Ask Okara message/);
    expect(seenFetch).toEqual([{ url: `${CHAT_BASE}/models`, auth: `Bearer ${CHAT_KEY}`, body: null }]);

    // Deleting the selected chat model returns the chat to the writer.
    await call(env, u, "PUT", chatSourcePath(u), { source: `custom:${chat.id}` });
    const del = await call(env, u, "DELETE", `${cp(u)}/${chat.id}`);
    expect(del.json!.data.chatSource).toBe("writer");

    for (const b of bodies) {
      expect(b).not.toContain(CHAT_KEY);
      expect(b).not.toContain(WRITER_KEY);
      expect(b).not.toContain("key_enc");
    }
  });

  it("roles stay separate: a chat row is never the writer, a writer/geo row is never the chat model; caps; bad input", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const writerId = await seedCustomWriter(env, u);
    const data = await addChat(env, u);
    const chatId = chatProviders(data)[0]!.id;
    const asWriter = await call(env, u, "PUT", `/workspaces/${u.workspaceId}/writer-source`, { source: `custom:${chatId}` });
    expect(asWriter.status).toBe(400);
    expect(asWriter.json!.error!.details).toMatchObject({ field: "source", reason: "not_writer" });
    const asChat = await call(env, u, "PUT", chatSourcePath(u), { source: `custom:${writerId}` });
    expect(asChat.status).toBe(400);
    expect(asChat.json!.error!.details).toMatchObject({ field: "source", reason: "not_chat" });
    for (const source of ["default", "custom:", "anthropic", "builtin:anthropic"]) {
      expect((await call(env, u, "PUT", chatSourcePath(u), { source })).status, source).not.toBe(200);
    }
    expect((await call(env, u, "PUT", chatSourcePath(u), { source: "custom:cprov_missing" })).status).toBe(404);
    expect((await call(env, u, "POST", cp(u), { baseUrl: CHAT_BASE, apiKey: CHAT_KEY, model: "m", useAsChat: true })).status).toBe(400); // writer role
    await addChat(env, u, { model: "tool-model-2" });
    await addChat(env, u, { model: "tool-model-3" });
    const capped = await call(env, u, "POST", cp(u), { baseUrl: CHAT_BASE, apiKey: CHAT_KEY, model: "x", role: "chat" });
    expect(capped.status).toBe(409);
    expect(capped.json!.error!.message).toMatch(/at most 3 Ask Okara chat models/);
    // Writer count is separate from chat rows.
    expect((await call(env, u, "POST", cp(u), { baseUrl: WRITER_BASE, apiKey: WRITER_KEY, model: "w2", useAsWriter: false })).status).toBe(201);
  });

  it("refuses SSRF-unsafe base URLs for chat providers (POST, PATCH, Fetch models), never contacting them", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    for (const baseUrl of ["http://chat.toolmodels.com/v1", "https://127.0.0.1/v1", "https://169.254.169.254.nip.io/v1", "https://llm.internal/v1", "https://localhost:8443/v1", "http://localhost:5173/api"]) {
      const r = await call(env, u, "POST", cp(u), { baseUrl, apiKey: CHAT_KEY, model: "m", role: "chat" });
      expect(r.status, baseUrl).toBe(400);
      expect(r.json!.error!.details).toMatchObject({ field: "baseUrl" });
      const m = await call(env, u, "POST", `${cp(u)}/models`, { baseUrl, apiKey: CHAT_KEY });
      expect(m.status, baseUrl).toBe(400);
    }
    const data = await addChat(env, u);
    const id = chatProviders(data)[0]!.id;
    expect((await call(env, u, "PATCH", `${cp(u)}/${id}`, { baseUrl: "https://10-0-0-1.sslip.io/v1" })).status).toBe(400);
    // A new host needs a new key or the explicit keepKeyForNewHost confirmation (tunnels), as for writers.
    const moved = await call(env, u, "PATCH", `${cp(u)}/${id}`, { baseUrl: "https://abc-def.trycloudflare.com/v1" });
    expect(moved.json!.error!.details).toMatchObject({ reason: "key_required_for_new_host" });
    expect((await call(env, u, "PATCH", `${cp(u)}/${id}`, { baseUrl: "https://abc-def.trycloudflare.com/v1", keepKeyForNewHost: true })).status).toBe(200);
    expect(seenFetch.every((f) => f.url.startsWith(CHAT_BASE) || f.url.startsWith("https://abc-def.trycloudflare.com/"))).toBe(true);
  });

  it("owner only; members can read and test; another workspace cannot see or select it", async () => {
    const env = createTestEnv();
    const owner = await seedUser(env);
    const member = await addMember(env, owner.workspaceId);
    const outsider = await seedUser(env);
    const data = await addChat(env, owner);
    const id = chatProviders(data)[0]!.id;
    const asMember = { ...member, workspaceId: owner.workspaceId };
    expect((await call(env, asMember, "POST", cp(asMember), { baseUrl: CHAT_BASE, apiKey: CHAT_KEY, model: "m", role: "chat" })).status).toBe(403);
    expect((await call(env, asMember, "PUT", chatSourcePath(asMember), { source: "writer" })).status).toBe(403);
    expect((await call(env, asMember, "DELETE", `${cp(asMember)}/${id}`)).status).toBe(403);
    const seen = await call(env, asMember, "GET", cp(asMember));
    expect(seen.json!.data).toMatchObject({ canManage: false, chatSource: `custom:${id}` });
    expect((await call(env, asMember, "POST", `${cp(asMember)}/${id}/test`, {})).status).toBe(200);
    // Outsider: not a member of the owner's workspace; its own workspace cannot reference the row.
    const asOutsider = { ...outsider, workspaceId: owner.workspaceId };
    expect((await call(env, asOutsider, "GET", cp(asOutsider))).status).toBe(404); // non-members: not found
    expect((await call(env, asOutsider, "PUT", chatSourcePath(asOutsider), { source: "writer" })).status).toBe(404);
    const cross = await call(env, outsider, "PUT", chatSourcePath(outsider), { source: `custom:${id}` });
    expect(cross.status).toBe(404);
    expect(await chatModelStatus(env, outsider.db, outsider.workspaceId)).toMatchObject({ source: "writer" });
  });
});

// ------------------------------------------------------------------ resolution
describe("resolveChatModel / chatModelStatus with a chat model source", () => {
  it("source writer (default): unchanged, the custom writer answers the chat", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    await seedCustomWriter(env, u);
    const server = chatServer();
    const r = await resolveChatModel(env, u.db, u.workspaceId, pid, { fetchImpl: server.fetchImpl, clock: () => FIXED_NOW });
    expect(r.status).toBe("ready");
    if (r.status !== "ready") return;
    expect(r.model.model).toBe("grok-4.7-fast");
    await r.model.round(round);
    expect(server.seen[0]).toMatchObject({ url: `${WRITER_BASE}/chat/completions`, auth: `Bearer ${WRITER_KEY}`, body: { model: "grok-4.7-fast" } });
    expect(await chatModelStatus(env, u.db, u.workspaceId)).toEqual({ ready: true, provider: "openai_compatible", model: "grok-4.7-fast", message: null, source: "writer", host: "grok.example-gateway.com" });
  });

  it("source custom: the request goes to the chat provider's base URL with its key and model, not the writer's; the writer is unaffected", async () => {
    const env = createTestEnv({ WRITER_PROVIDER: "anthropic", WRITER_MODEL: "operator-writer", WRITER_API_KEY: "op-writer-key" });
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    await seedCustomWriter(env, u);
    await addChat(env, u);
    const server = chatServer();
    const r = await resolveChatModel(env, u.db, u.workspaceId, pid, { fetchImpl: server.fetchImpl, clock: () => FIXED_NOW });
    expect(r.status).toBe("ready");
    if (r.status !== "ready") return;
    expect(r.model).toMatchObject({ model: "tool-model-1" });
    const out = await r.model.round({ ...round, tools: [{ name: "project_overview", description: "x", parameters: { type: "object", properties: {} } }] });
    expect(out.text).toBe("Hello from the model.");
    expect(server.seen).toHaveLength(1);
    expect(server.seen[0]!.url).toBe(`${CHAT_BASE}/chat/completions`);
    expect(server.seen[0]!.auth).toBe(`Bearer ${CHAT_KEY}`);
    expect(server.seen[0]!.body.model).toBe("tool-model-1");
    expect(server.seen[0]!.body.tools[0].function.name).toBe("project_overview");
    // Metered against the workspace (own key, cost unknown).
    const callRow = await u.db.first<{ model: string; project_id: string; status: string; cost_usd: number | null; input_tokens: number }>(
      "SELECT model, project_id, status, cost_usd, input_tokens FROM provider_calls WHERE workspace_id = ? ORDER BY rowid DESC LIMIT 1",
      u.workspaceId,
    );
    expect(callRow).toMatchObject({ model: "tool-model-1", project_id: pid, status: "ok", input_tokens: 12 });
    expect(callRow!.cost_usd).toBeNull();
    // Writer unaffected.
    const writer = await resolveCustomWriter(env, u.db, u.workspaceId);
    expect(writer.status === "ready" && writer.provider.model).toBe("grok-4.7-fast");
    expect(await chatModelStatus(env, u.db, u.workspaceId)).toEqual({ ready: true, provider: "openai_compatible", model: "tool-model-1", message: null, source: "custom", host: "chat.toolmodels.com" });
  });

  it("a selected but unusable chat provider is setup_required with the reason, never a fallback to the writer", async () => {
    const env = createTestEnv({ WRITER_PROVIDER: "anthropic", WRITER_MODEL: "operator-writer", WRITER_API_KEY: "op-writer-key" });
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    const data = await addChat(env, u);
    const id = chatProviders(data)[0]!.id;
    const server = chatServer();
    // Key cannot be decrypted.
    await u.db.run("UPDATE workspace_custom_providers SET key_enc = 'v1.broken.envelope' WHERE id = ?", id);
    const r1 = await resolveChatModel(env, u.db, u.workspaceId, pid, { fetchImpl: server.fetchImpl });
    expect(r1).toMatchObject({ status: "setup_required", provider: "openai_compatible", model: "tool-model-1" });
    expect(r1.status === "setup_required" && r1.message).toMatch(/chat\.toolmodels\.com.*could not be decrypted/);
    // Stored base URL no longer validates.
    await u.db.run("UPDATE workspace_custom_providers SET base_url = 'https://127.0.0.1/v1', host = '127.0.0.1' WHERE id = ?", id);
    const r2 = await resolveChatModel(env, u.db, u.workspaceId, pid, { fetchImpl: server.fetchImpl });
    expect(r2.status).toBe("setup_required");
    expect(server.seen).toHaveLength(0);
    expect(await chatModelStatus(env, u.db, u.workspaceId)).toMatchObject({ ready: false, source: "custom", message: expect.stringMatching(/Ask Okara chat model/) });
    // Switching back to the writer is explicit and works.
    await call(env, u, "PUT", chatSourcePath(u), { source: "writer" });
    expect(await chatModelStatus(env, u.db, u.workspaceId)).toMatchObject({ ready: true, source: "writer", model: "operator-writer" });
  });

  it("GET chat/status reports the chat model source", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    await addChat(env, u);
    const st = await call(env, u, "GET", `/projects/${pid}/chat/status`);
    expect(st.json!.data).toMatchObject({ state: "ready", source: "custom", model: { provider: "openai_compatible", model: "tool-model-1" } });
  });
});

// ------------------------------------------------------------------ chat tools
async function ctxFor(env: Env, db: Db, pid: string, userId: string): Promise<ToolContext> {
  return { env, db, project: await projectRow(db, pid), userId, now: FIXED_NOW };
}
function action(name: string) {
  const t = getTool(name)!;
  if (!isActionTool(t)) throw new Error(`${name} is not an action`);
  return {
    parse: (input: unknown) => t.schema.safeParse(input),
    prepare: (ctx: ToolContext, input: unknown) => t.prepare(ctx, t.schema.parse(input)),
    execute: (ctx: ToolContext, input: unknown) => t.execute(ctx, t.schema.parse(input), { proposedAt: FIXED_NOW.toISOString(), secret: null }) as Promise<{ data: AnyData; summary: string }>,
  };
}

describe("Ask Okara tools: chat model", () => {
  it("models shows the chat model; set_chat_source and add_provider role chat work through the routes", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    const writerId = await seedCustomWriter(env, u);
    const ctx = await ctxFor(env, u.db, pid, u.userId);
    const models = getTool("models")!;
    if (isActionTool(models)) throw new Error("models is a read tool");
    const v1 = (await models.run(ctx, {})) as { data: AnyData };
    expect(v1.data.askOkara).toMatchObject({ source: "writer", model: "grok-4.7-fast" });

    const data = await addChat(env, u);
    const chatId = chatProviders(data)[0]!.id;
    const v2 = (await models.run(ctx, {})) as { data: AnyData; summary: string };
    expect(v2.data.askOkara).toMatchObject({ source: `custom:${chatId}`, model: "tool-model-1", host: "chat.toolmodels.com" });
    expect(v2.data.customProviders.find((p: AnyData) => p.id === chatId)).toMatchObject({ role: "chat", isChat: true });
    expect(JSON.stringify(v2)).not.toContain(CHAT_KEY);

    const mm = action("manage_models");
    // set_chat_source
    expect((await mm.prepare(ctx, { op: "set_chat_source", source: "writer" })).title).toMatch(/writer model for Ask Okara/);
    await expect(mm.prepare(ctx, { op: "set_chat_source", source: `custom:${writerId}` })).rejects.toThrow(/not an Ask Okara chat model/);
    await expect(mm.prepare(ctx, { op: "set_chat_source", source: "default" })).rejects.toThrow(/writer/);
    await expect(mm.prepare(ctx, { op: "set_writer", source: `custom:${chatId}` })).rejects.toThrow(/chat model, not a writer/);
    const r = await mm.execute(ctx, { op: "set_chat_source", source: "writer" });
    expect(r.data).toEqual({ chatSource: "writer" });
    const r2 = await mm.execute(ctx, { op: "set_chat_source", source: `custom:${chatId}` });
    expect(r2.data).toEqual({ chatSource: `custom:${chatId}` });
    // set_custom_model on a chat provider (checked against its live list)
    const p = await mm.prepare(ctx, { op: "set_custom_model", providerId: chatId, model: "tool-model-2" });
    expect(p.detail).toMatch(/Listed by the provider/);
    await mm.execute(ctx, { op: "set_custom_model", providerId: chatId, model: "tool-model-2" });
    expect(await chatModelStatus(env, u.db, u.workspaceId)).toMatchObject({ model: "tool-model-2", source: "custom" });
    // remove_provider explains the effect
    expect((await mm.prepare(ctx, { op: "remove_provider", providerId: chatId })).detail).toMatch(/back to the writer model/);

    // add_provider role chat: the key goes only through the secure field to the real route.
    const add = { op: "add_provider", role: "chat", baseUrl: "https://openrouter.ai/api/v1", model: "tool-model-1", label: "OR tools" };
    const prep = await mm.prepare(ctx, add);
    expect(prep.title).toMatch(/Ask Okara chat model/);
    expect(prep.detail).toMatch(/tool calling/);
    const field = secretFieldFor("manage_models", add, u.workspaceId)!;
    expect(field.label).toMatch(/Ask Okara chat model/);
    expect(field.request).toEqual({ method: "POST", path: `/workspaces/${u.workspaceId}/custom-providers`, body: { baseUrl: "https://openrouter.ai/api/v1", model: "tool-model-1", label: "OR tools", role: "chat", useAsChat: true } });
    expect(secretRequestAllowed(field)).toBe(true);
    expect(mm.parse({ ...add, apiKey: CHAT_KEY }).success).toBe(false);
    await expect(mm.prepare(ctx, { ...add, role: "writer", useAsChat: true })).rejects.toThrow(/role chat only/);
  });

  it("a member cannot change the chat model through the chat", async () => {
    const env = createTestEnv();
    const owner = await seedUser(env);
    const pid = await seedProject(env, owner.workspaceId);
    const member = await addMember(env, owner.workspaceId);
    const ctx = await ctxFor(env, owner.db, pid, member.userId);
    await expect(action("manage_models").prepare(ctx, { op: "set_chat_source", source: "writer" })).rejects.toThrow(/owner/i);
  });
});

// ------------------------------------------------------------------ web
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FC = (props: any) => ReactElement | null;
const load = async <T,>(rel: string): Promise<T> => (await import(/* @vite-ignore */ rel)) as T;
const chatUi = await load<Record<"ChatModelCard", FC>>("../src/web/pages/integrations/ChatModel.tsx");
const writerUi = await load<Record<"SavedProviderItem" | "CustomProviderForm", FC>>("../src/web/pages/integrations/CustomWriter.tsx");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const buttons = (html: string) => [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) => text(m[1]!).trim());
const chatRow = (over: Partial<CustomProviderStatus> = {}): CustomProviderStatus => ({
  id: "cprov_c",
  role: "chat",
  label: "Tools model",
  baseUrl: CHAT_BASE,
  host: "chat.toolmodels.com",
  model: "tool-model-1",
  keyHint: "CHAT",
  isWriter: false,
  isChat: true,
  lastTestedAt: null,
  lastTestOk: null,
  lastTestDetail: null,
  createdAt: "2026-10-04T12:00:00.000Z",
  updatedAt: "2026-10-04T12:00:00.000Z",
  ...over,
});
const noop = () => {};

describe("Ask Okara chat model card (web)", () => {
  it("renders the anchor, the two choices and the tool-calling hint", () => {
    const writer: IntegrationsStatus["providers"][number] = {
      provider: "writer",
      label: "Writer (Anthropic)",
      source: "operator_key",
      keyHint: null,
      state: "ready",
      lastTestedAt: null,
      lastTestOk: null,
      lastTestDetail: null,
      model: "claude-test",
      dataSent: "Stored evidence.",
    };
    const html = renderToStaticMarkup(h(MemoryRouter, null, h(chatUi.ChatModelCard, { workspaceId: "ws1", writer })));
    expect(html).toContain('id="ask-okara-model"');
    const t = text(html);
    expect(t).toContain("Ask Okara chat model");
    expect(t).toContain("Same as writer (current: claude-test )");
    expect(t).toContain("Custom chat model");
    expect(t).toMatch(/supports tool calling/);
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html).toMatch(/checked="" value="writer"/);
    expect(html).toMatch(/dark:/);
  });

  it("saved chat model: Ask Okara badge, Test / Change model / Quick update URL / Remove; Use for Ask Okara when not selected", () => {
    const active = renderToStaticMarkup(h(writerUi.SavedProviderItem, { workspaceId: "ws1", p: chatRow(), canManage: true, apply: noop, reload: noop, onEdit: noop }));
    expect(text(active)).toContain("Ask Okara model");
    expect(buttons(active)).toEqual(["Test", "Change model", "Quick update URL", "Edit URL or key", "Remove"]);
    const idle = renderToStaticMarkup(h(writerUi.SavedProviderItem, { workspaceId: "ws1", p: chatRow({ isChat: false }), canManage: true, apply: noop, reload: noop, onEdit: noop }));
    expect(buttons(idle)).toContain("Use for Ask Okara");
    expect(buttons(idle)).not.toContain("Use as writer");
    const hostile = renderToStaticMarkup(h(writerUi.SavedProviderItem, { workspaceId: "ws1", p: chatRow({ model: "<img src=x onerror=alert(1)>" }), canManage: false, apply: noop, reload: noop, onEdit: noop }));
    expect(hostile).not.toContain("<img");
    expect(buttons(hostile)).toEqual(["Test"]);
  });

  it("add form for role chat: password key field, Fetch models, Save & test", () => {
    const html = renderToStaticMarkup(h(writerUi.CustomProviderForm, { workspaceId: "ws1", role: "chat", initial: null, onSaved: noop }));
    expect(text(html)).toContain("Custom chat model (OpenAI-compatible)");
    expect(html).toMatch(/type="password"/);
    expect(buttons(html)).toEqual(["Fetch models", "Save & test"]);
  });

  it("helpers: chat body, active chat provider, writer label", () => {
    expect(newProviderBody({ role: "chat", baseUrl: ` ${CHAT_BASE} `, apiKey: " k ", model: "m", label: "" })).toEqual({ baseUrl: CHAT_BASE, apiKey: "k", model: "m", role: "chat", useAsChat: true });
    const resp = { providers: [chatRow({ isChat: false, id: "a" }), chatRow({ id: "b" }), { ...chatRow({ id: "w", role: "writer", isChat: false, isWriter: true, model: "grok-4.7-fast", host: "grok.example-gateway.com" }) }] } as unknown as CustomProvidersResponse;
    expect(chatProviders(resp).map((p) => p.id)).toEqual(["a", "b"]);
    expect(activeChatProvider(resp)!.id).toBe("b");
    expect(writerModelLabel(resp, "claude-test")).toBe("grok-4.7-fast (grok.example-gateway.com)");
    expect(writerModelLabel({ providers: [] } as unknown as CustomProvidersResponse, "claude-test")).toBe("claude-test");
  });
});
