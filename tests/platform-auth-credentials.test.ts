import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "@worker/app";
import type { Env } from "@worker/env";
import { Db } from "@worker/lib/db";
import { decryptSecret } from "@worker/lib/crypto";
import { credentialAad, resolveProviderKey } from "@worker/platform/credentials";
import { setCredentialTestFetch } from "@worker/routes/credentials";
import type { IntegrationsStatus } from "@shared/types";
import { createTestEnv } from "./helpers/env";
import { authHeaders, seedUser } from "./helpers/fixtures";

type ProviderStatus = IntegrationsStatus["providers"][number];

const app = createApp();
const SECRET = "sk-test-SUPERSECRETKEY-0123456789abcdefWXYZ";

interface Seeded {
  userId: string;
  workspaceId: string;
  sessionToken: string;
  csrfToken: string;
  db: Db;
}

const calls: Array<{ url: string; headers: Record<string, string> }> = [];
let nextStatus = 200;

beforeEach(() => {
  calls.length = 0;
  nextStatus = 200;
  setCredentialTestFetch(async (input, init) => {
    calls.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    return new Response(JSON.stringify({ models: [], echo: "provider body must not be forwarded" }), { status: nextStatus });
  });
});
afterEach(() => setCredentialTestFetch(null));

/** Every response body seen in a test, so we can assert the key never leaks. */
const bodies: string[] = [];
async function call(env: Env, u: Seeded, method: string, path: string, body?: unknown) {
  const res = await app.request(
    path,
    { method, headers: authHeaders(u.sessionToken, u.csrfToken), body: body === undefined ? undefined : JSON.stringify(body) },
    env,
  );
  const text = await res.text();
  bodies.push(text);
  return { status: res.status, json: text ? (JSON.parse(text) as { data?: any; error?: { code: string } }) : null, text };
}

const base = (u: Seeded) => `/api/workspaces/${u.workspaceId}/credentials`;

describe("platform-auth: provider credentials", () => {
  it("lists all providers without keys, with model config and data disclosure", async () => {
    const env = createTestEnv({ TYPESAFE_MODEL: "jev-latest", GEMINI_API_KEY: "operator-gemini-key-123456", GEMINI_MODEL: "gemini-configured" });
    const u = await seedUser(env);
    const { status, json, text } = await call(env, u, "GET", base(u));
    expect(status).toBe(200);
    const list = json!.data as ProviderStatus[];
    expect(list.map((p) => p.provider)).toEqual(["typesafe", "gemini", "perplexity", "writer"]);
    const ts = list.find((p) => p.provider === "typesafe")!;
    expect(ts).toMatchObject({ source: "none", state: "setup_required", keyHint: null, model: "jev-latest", lastTestOk: null });
    const gem = list.find((p) => p.provider === "gemini")!;
    expect(gem).toMatchObject({ source: "operator_key", state: "ready", keyHint: null, model: "gemini-configured" });
    expect(list.find((p) => p.provider === "perplexity")!.model).toBeNull();
    for (const p of list) expect(p.dataSent.length).toBeGreaterThan(20);
    expect(text).not.toContain("operator-gemini-key");
    expect(text).not.toContain("123456");
  });

  it("stores keys encrypted with workspace/provider AAD and never returns them", async () => {
    const env = createTestEnv({ TYPESAFE_MODEL: "jev-latest" });
    const u = await seedUser(env);
    const put = await call(env, u, "PUT", `${base(u)}/typesafe`, { apiKey: `  ${SECRET}  ` });
    expect(put.status).toBe(200);
    expect(put.json!.data).toMatchObject({ provider: "typesafe", source: "workspace_key", keyHint: "WXYZ", state: "ready" });

    const row = await u.db.first<{ key_enc: string; key_hint: string }>("SELECT key_enc, key_hint FROM provider_credentials WHERE workspace_id = ?", u.workspaceId);
    expect(row!.key_enc).toMatch(/^v1\./);
    expect(row!.key_enc).not.toContain(SECRET);
    expect(await decryptSecret(env, row!.key_enc, credentialAad(u.workspaceId, "typesafe"))).toBe(SECRET);
    // AAD binds the ciphertext to its workspace and provider.
    await expect(decryptSecret(env, row!.key_enc, credentialAad("ws_other", "typesafe"))).rejects.toBeTruthy();
    await expect(decryptSecret(env, row!.key_enc, credentialAad(u.workspaceId, "gemini"))).rejects.toBeTruthy();
    await expect(decryptSecret(env, row!.key_enc)).rejects.toBeTruthy();
    // The shared resolver reads it back.
    expect(await resolveProviderKey(env, u.db, u.workspaceId, "typesafe")).toEqual({ key: SECRET, source: "workspace_key" });

    const list = await call(env, u, "GET", base(u));
    expect(list.text).not.toContain(SECRET);
    // Replacing keeps one row and resets test status.
    await call(env, u, "PUT", `${base(u)}/typesafe`, { apiKey: `${SECRET}-v2AB` });
    expect(await u.db.all("SELECT id FROM provider_credentials WHERE workspace_id = ?", u.workspaceId)).toHaveLength(1);
  });

  it("validates key length and charset without echoing input", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    for (const apiKey of [`${SECRET}\u0000`, `abc\ndef-${SECRET}`, "x".repeat(401), "", "short", `${SECRET} with space`, 12345]) {
      const r = await call(env, u, "PUT", `${base(u)}/gemini`, { apiKey });
      expect(r.status).toBe(400);
      expect(r.text).not.toContain(SECRET);
    }
    expect((await call(env, u, "PUT", `${base(u)}/gemini`, { apiKey: SECRET, extra: 1 })).status).toBe(400);
    expect((await call(env, u, "PUT", `${base(u)}/unknown`, { apiKey: SECRET })).status).toBe(404);
    expect(await u.db.all("SELECT id FROM provider_credentials")).toHaveLength(0);
  });

  it("returns setup_required when encryption is not configured", async () => {
    const env = createTestEnv({ TOKEN_ENCRYPTION_KEY_V1: undefined });
    const u = await seedUser(env);
    const r = await call(env, u, "PUT", `${base(u)}/gemini`, { apiKey: SECRET });
    expect(r.status).toBe(412);
    expect(r.json!.error!.code).toBe("setup_required");
  });

  it("denies cross-tenant access on every credential route", async () => {
    const env = createTestEnv();
    const a = await seedUser(env);
    const b = await seedUser(env);
    await call(env, a, "PUT", `${base(a)}/gemini`, { apiKey: SECRET });
    const pathsA = base(a);
    expect((await call(env, b, "GET", pathsA)).status).toBe(404);
    expect((await call(env, b, "PUT", `${pathsA}/gemini`, { apiKey: "attacker-key-000000" })).status).toBe(404);
    expect((await call(env, b, "POST", `${pathsA}/gemini/test`, {})).status).toBe(404);
    expect((await call(env, b, "DELETE", `${pathsA}/gemini`)).status).toBe(404);
    expect(calls).toHaveLength(0);
    const row = await a.db.first<{ key_enc: string }>("SELECT key_enc FROM provider_credentials WHERE workspace_id = ?", a.workspaceId);
    expect(await decryptSecret(env, row!.key_enc, credentialAad(a.workspaceId, "gemini"))).toBe(SECRET);
    // B's own workspace is unaffected by A's key.
    const bList = (await call(env, b, "GET", base(b))).json!.data as ProviderStatus[];
    expect(bList.find((p) => p.provider === "gemini")!.source).toBe("none");
  });

  it("lets members read and test but only owners write or delete", async () => {
    const env = createTestEnv({ GEMINI_MODEL: "gemini-configured" });
    const owner = await seedUser(env);
    const member = await seedUser(env);
    await owner.db.insert("memberships", { workspace_id: owner.workspaceId, user_id: member.userId, role: "member", created_at: new Date().toISOString() });
    const asMember = { ...member, workspaceId: owner.workspaceId };
    await call(env, owner, "PUT", `${base(owner)}/gemini`, { apiKey: SECRET });
    expect((await call(env, asMember, "GET", base(asMember))).status).toBe(200);
    expect((await call(env, asMember, "PUT", `${base(asMember)}/gemini`, { apiKey: "member-key-00000000" })).status).toBe(403);
    expect((await call(env, asMember, "DELETE", `${base(asMember)}/gemini`)).status).toBe(403);
    expect((await call(env, asMember, "POST", `${base(asMember)}/gemini/test`, {})).json!.data).toMatchObject({ ok: true });
  });

  it("requires authentication; an anonymous request cannot spend an operator key", async () => {
    const env = createTestEnv({ GEMINI_API_KEY: "operator-gemini-key-123456" });
    const u = await seedUser(env);
    const anonHeaders = { Origin: "http://localhost:5173", "Content-Type": "application/json" };
    expect((await app.request(base(u), {}, env)).status).toBe(401);
    expect((await app.request(`${base(u)}/gemini/test`, { method: "POST", headers: anonHeaders, body: "{}" }, env)).status).toBe(401);
    expect((await app.request(`${base(u)}/gemini`, { method: "PUT", headers: anonHeaders, body: JSON.stringify({ apiKey: SECRET }) }, env)).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("requires Origin and CSRF token on credential writes", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const { "X-CSRF-Token": _t, ...noToken } = authHeaders(u.sessionToken, u.csrfToken);
    const r = await app.request(`${base(u)}/gemini`, { method: "PUT", headers: noToken, body: JSON.stringify({ apiKey: SECRET }) }, env);
    expect(r.status).toBe(403);
    const r2 = await app.request(`${base(u)}/gemini`, { method: "PUT", headers: authHeaders(u.sessionToken, u.csrfToken, "https://evil.example.com"), body: JSON.stringify({ apiKey: SECRET }) }, env);
    expect(r2.status).toBe(403);
    expect(await u.db.all("SELECT id FROM provider_credentials")).toHaveLength(0);
  });

  it("deletes a saved key", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    await call(env, u, "PUT", `${base(u)}/perplexity`, { apiKey: SECRET });
    const del = await call(env, u, "DELETE", `${base(u)}/perplexity`);
    expect(del.json).toEqual({ data: { ok: true } });
    expect(await u.db.all("SELECT id FROM provider_credentials")).toHaveLength(0);
  });
});

describe("platform-auth: provider key tests", () => {
  it("tests a saved TypeSafe key via GET /v1/models (no inference) and records the result", async () => {
    const env = createTestEnv({ TYPESAFE_MODEL: "jev-latest" });
    const u = await seedUser(env);
    await call(env, u, "PUT", `${base(u)}/typesafe`, { apiKey: SECRET });
    const r = await call(env, u, "POST", `${base(u)}/typesafe/test`, {});
    expect(r.json!.data).toEqual({ ok: true, detail: expect.any(String) });
    expect(calls).toEqual([{ url: "https://api.typesafe.ai/v1/models", headers: expect.objectContaining({ authorization: `Bearer ${SECRET}` }) }]);
    expect(r.text).not.toContain("provider body must not be forwarded");
    const status = ((await call(env, u, "GET", base(u))).json!.data as ProviderStatus[]).find((p) => p.provider === "typesafe")!;
    expect(status).toMatchObject({ lastTestOk: true, state: "ready" });
    expect(status.lastTestedAt).toBeTruthy();
  });

  it("records a rejected key as error state", async () => {
    const env = createTestEnv({ GEMINI_MODEL: "gemini-configured" });
    const u = await seedUser(env);
    await call(env, u, "PUT", `${base(u)}/gemini`, { apiKey: SECRET });
    nextStatus = 401;
    const r = await call(env, u, "POST", `${base(u)}/gemini/test`);
    expect(r.json!.data).toMatchObject({ ok: false });
    expect(calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models");
    expect(calls[0]!.headers["x-goog-api-key"]).toBe(SECRET);
    expect(calls[0]!.url).not.toContain(SECRET);
    const status = ((await call(env, u, "GET", base(u))).json!.data as ProviderStatus[]).find((p) => p.provider === "gemini")!;
    expect(status).toMatchObject({ lastTestOk: false, state: "error" });
  });

  it("tests a typed key without saving or recording it", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const r = await call(env, u, "POST", `${base(u)}/gemini/test`, { apiKey: SECRET });
    expect(r.json!.data).toMatchObject({ ok: true });
    expect(r.text).not.toContain(SECRET);
    expect(await u.db.all("SELECT id FROM provider_credentials")).toHaveLength(0);
  });

  it("returns setup_required when no key is saved", async () => {
    const env = createTestEnv({ GEMINI_API_KEY: "operator-gemini-key-123456" });
    const u = await seedUser(env);
    const r = await call(env, u, "POST", `${base(u)}/gemini/test`, {});
    expect(r.status).toBe(412);
    expect(calls).toHaveLength(0);
  });

  it("does not call Perplexity (no free endpoint) and leaves the result unknown", async () => {
    const env = createTestEnv({ PERPLEXITY_MODEL: "configured-model" });
    const u = await seedUser(env);
    await call(env, u, "PUT", `${base(u)}/perplexity`, { apiKey: SECRET });
    const r = await call(env, u, "POST", `${base(u)}/perplexity/test`, {});
    expect(r.json!.data).toEqual({ ok: null, detail: "No free test endpoint; key saved and will be validated on first run." });
    expect(calls).toHaveLength(0);
    const row = await u.db.first<{ last_test_ok: number | null; last_test_detail: string }>("SELECT last_test_ok, last_test_detail FROM provider_credentials");
    expect(row).toMatchObject({ last_test_ok: null, last_test_detail: expect.stringContaining("No free test endpoint") });
  });

  it("tests the writer against Anthropic's models endpoint", async () => {
    const env = createTestEnv({ WRITER_PROVIDER: "anthropic", WRITER_MODEL: "configured-writer" });
    const u = await seedUser(env);
    const r = await call(env, u, "POST", `${base(u)}/writer/test`, { apiKey: SECRET });
    expect(r.json!.data).toMatchObject({ ok: true });
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/models");
    expect(calls[0]!.headers).toMatchObject({ "x-api-key": SECRET, "anthropic-version": "2023-06-01" });
    const status = ((await call(env, u, "GET", base(u))).json!.data as ProviderStatus[]).find((p) => p.provider === "writer")!;
    expect(status.label).toBe("Writer (Anthropic)");
  });

  it("tests an OpenAI-compatible writer at WRITER_BASE_URL/models, https only", async () => {
    const env = createTestEnv({ WRITER_PROVIDER: "openai_compatible", WRITER_BASE_URL: "https://llm.example.com/v1/" });
    const u = await seedUser(env);
    await call(env, u, "POST", `${base(u)}/writer/test`, { apiKey: SECRET });
    expect(calls[0]!.url).toBe("https://llm.example.com/v1/models");
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${SECRET}`);

    const insecure = createTestEnv({ WRITER_PROVIDER: "openai_compatible", WRITER_BASE_URL: "http://10.0.0.1/v1" });
    const u2 = await seedUser(insecure);
    const r = await call(insecure, u2, "POST", `${base(u2)}/writer/test`, { apiKey: SECRET });
    expect(r.json!.data).toMatchObject({ ok: null });
    expect(calls).toHaveLength(1);

    const unconfigured = createTestEnv();
    const u3 = await seedUser(unconfigured);
    expect((await call(unconfigured, u3, "POST", `${base(u3)}/writer/test`, { apiKey: SECRET })).json!.data).toMatchObject({ ok: null });
  });

  it("reports network failures without leaking details", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    setCredentialTestFetch(async () => {
      throw new Error(`boom ${SECRET}`);
    });
    const r = await call(env, u, "POST", `${base(u)}/typesafe/test`, { apiKey: SECRET });
    expect(r.json!.data).toMatchObject({ ok: false });
  });

  it("rate-limits the test route", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await call(env, u, "POST", `${base(u)}/perplexity/test`, { apiKey: SECRET })).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("never returned the key in any response body across this suite", () => {
    expect(bodies.length).toBeGreaterThan(20);
    for (const b of bodies) expect(b).not.toContain(SECRET);
  });
});
