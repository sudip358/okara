/**
 * Workspace custom providers (OpenAI-compatible base URL + key + model) as the workspace writer:
 * base URL validation table, model-list parsing, routes (fetch models, save, test, change model, writer
 * source, remove), tenancy and roles, keys never returned, per-workspace allowlist, writer drafting through
 * the custom provider with a fake fetch (workspace-key budget attribution, cost unknown), no fallback when the
 * selected custom writer is unusable, migration on the D1 shim, export without key material.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "@worker/app";
import type { Env } from "@worker/env";
import { Db } from "@worker/lib/db";
import { decryptSecret, encryptSecret } from "@worker/lib/crypto";
import { credentialSources } from "@worker/platform/credentials";
import {
  MAX_CUSTOM_PROVIDERS,
  CUSTOM_PROVIDER_CHANGES_SHOWN,
  EMBEDDED_IPV4_MESSAGE,
  isNgrokTunnelHost,
  customProviderAad,
  extractModelIds,
  fetchModelList,
  listCustomProviders,
  resolveCustomProviderRow,
  resolveCustomWriter,
  validateCustomBaseUrl,
  type BaseUrlRejectReason,
} from "@worker/platform/custom-providers";
import { setCustomProviderFetch } from "@worker/routes/custom-providers";
import {
  OutboundBlockedError,
  allowedApiHosts,
  buildRunContext,
  buildWriterForWorkspace,
  capabilityPresence,
  createApiFetch,
  writerStatusForWorkspace,
} from "@worker/runs/runtime";
import { createRun } from "@worker/runs/runs-service";
import { redact } from "@worker/runs/calls";
import { draftWithWriter } from "@worker/seo/recommend/draft";
import { generateSeoRecommendations } from "@worker/seo/recommend/generate";
import { CUSTOM_WRITER_MAX_RESPONSE_BYTES } from "@worker/providers/writer";
import type { WritingRequest } from "@worker/providers/types";
import type { CustomProviderModelList, CustomProvidersResponse } from "@shared/types";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, authHeaders, seedProject, seedUser } from "./helpers/fixtures";
import { fakeDecisions } from "./fixtures/gsc/site";
import { scenario } from "./fixtures/gsc/scenario";
import { candidatesOf } from "./seo-jev.fixtures";

const app = createApp();
const SECRET = "sk-or-v1-CUSTOMSECRETKEY-0123456789abcdefQRST";
const BASE = "https://llm.example.com/v1";

interface Seeded {
  userId: string;
  workspaceId: string;
  sessionToken: string;
  csrfToken: string;
  db: Db;
}

// ------------------------------------------------------------------ fake provider
interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  redirect: string | undefined;
  hasSignal: boolean;
  body: string | null;
}
const seen: Seen[] = [];
type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;
let handler: Handler;
const okModels = () => Response.json({ object: "list", data: [{ id: "meta/llama-3.3-70b" }, { id: "deepseek/deepseek-chat" }, { id: "meta/llama-3.3-70b" }] });

function fakeFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    seen.push({
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      redirect: init?.redirect,
      hasSignal: init?.signal instanceof AbortSignal,
      body: typeof init?.body === "string" ? init.body : null,
    });
    return handler(url, init);
  }) as typeof fetch;
}

beforeEach(() => {
  seen.length = 0;
  handler = () => okModels();
  setCustomProviderFetch(fakeFetch());
});
afterEach(() => {
  setCustomProviderFetch(null);
  vi.unstubAllGlobals();
});

/** Every response body seen in a test, so we can assert the key never leaks. */
const bodies: string[] = [];
async function call(env: Env, u: Seeded, method: string, path: string, body?: unknown) {
  const res = await app.request(
    `/api${path}`,
    { method, headers: authHeaders(u.sessionToken, u.csrfToken), body: body === undefined ? undefined : JSON.stringify(body) },
    env,
  );
  const text = await res.text();
  bodies.push(text);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, json: text ? (JSON.parse(text) as { data?: any; error?: { code: string; message: string; details?: any } }) : null, text };
}

const cp = (u: Seeded) => `/workspaces/${u.workspaceId}/custom-providers`;

async function addProvider(env: Env, u: Seeded, over: Record<string, unknown> = {}) {
  const r = await call(env, u, "POST", cp(u), { baseUrl: BASE, apiKey: SECRET, model: "meta/llama-3.3-70b", ...over });
  expect(r.status).toBe(201);
  return r.json!.data as CustomProvidersResponse;
}

/** Adds `user` to `workspaceId` as a non-owner member. */
async function addMember(db: Db, workspaceId: string, userId: string) {
  await db.insert("memberships", { workspace_id: workspaceId, user_id: userId, role: "member", created_at: FIXED_NOW.toISOString() });
}

// ------------------------------------------------------------------ base URL validation
describe("custom provider base URL validation", () => {
  const accept: Array<[string, string, string]> = [
    ["https://openrouter.ai/api/v1", "https://openrouter.ai/api/v1", "openrouter.ai"],
    ["  https://API.Groq.com/openai/v1/  ", "https://api.groq.com/openai/v1", "api.groq.com"],
    ["https://api.together.xyz/v1/chat/completions", "https://api.together.xyz/v1", "api.together.xyz"],
    ["https://api.mistral.ai/v1/models", "https://api.mistral.ai/v1", "api.mistral.ai"],
    ["https://api.example.com:443/v1", "https://api.example.com/v1", "api.example.com"],
    ["https://gateway.example.co.uk", "https://gateway.example.co.uk", "gateway.example.co.uk"],
    ["https://llm.example.com./v1", "https://llm.example.com/v1", "llm.example.com"],
    ["https://bücher.example.com/v1", "https://xn--bcher-kva.example.com/v1", "xn--bcher-kva.example.com"], // IDN -> punycode
    ["https://xn--bcher-kva.example.com", "https://xn--bcher-kva.example.com", "xn--bcher-kva.example.com"],
    ["https://llm.example.xn--p1ai/v1", "https://llm.example.xn--p1ai/v1", "llm.example.xn--p1ai"],
    // Digits and dashes are fine unless the name spells an IPv4 address.
    ["https://us-east-1.gateway.example.com/v1", "https://us-east-1.gateway.example.com/v1", "us-east-1.gateway.example.com"],
    ["https://llm-3-70b.example.com/v1", "https://llm-3-70b.example.com/v1", "llm-3-70b.example.com"],
    ["https://v1.2.3.example.com/v1", "https://v1.2.3.example.com/v1", "v1.2.3.example.com"],
    ["https://svc.example.com/v1", "https://svc.example.com/v1", "svc.example.com"], // "svc" as a label, not the suffix
    // Tunnel hosts that change on every restart (owner request: "the custom base URL keeps on changing").
    ["https://abc-def-123.trycloudflare.com/v1", "https://abc-def-123.trycloudflare.com/v1", "abc-def-123.trycloudflare.com"],
    ["https://1a2b-34-56.ngrok-free.app/v1", "https://1a2b-34-56.ngrok-free.app/v1", "1a2b-34-56.ngrok-free.app"],
    ["https://my-gpu.loca.lt/v1", "https://my-gpu.loca.lt/v1", "my-gpu.loca.lt"],
  ];
  it.each(accept)("accepts %s", (raw, baseUrl, host) => {
    expect(validateCustomBaseUrl(raw, "https://okara.example.com")).toEqual({ ok: true, baseUrl, host });
  });

  const rejects: Array<[unknown, BaseUrlRejectReason]> = [
    ["", "invalid_url"],
    [123, "invalid_url"],
    ["not a url", "invalid_url"],
    ["https://api.example.com/v1 x", "invalid_url"],
    ["https://" + "a".repeat(300) + ".com", "too_long"],
    ["http://api.example.com/v1", "not_https"],
    ["ftp://api.example.com", "not_https"],
    ["javascript:alert(1)", "not_https"],
    ["https://user:pw@api.example.com/v1", "credentials"],
    ["https://user@api.example.com/v1", "credentials"],
    ["https://api.example.com:8443/v1", "port"],
    ["https://api.example.com:80/v1", "port"],
    ["https://api.example.com/v1?key=abc", "query"],
    ["https://api.example.com/v1#frag", "query"],
    ["https://127.0.0.1/v1", "ip_literal"],
    ["https://8.8.8.8/v1", "ip_literal"], // public IPs are refused too: providers are addressed by name
    ["https://169.254.169.254/latest", "ip_literal"],
    ["https://2130706433/", "ip_literal"], // decimal 127.0.0.1
    ["https://0x7f.1/", "ip_literal"], // hex/short form
    ["https://017700000001/", "ip_literal"], // octal
    ["https://[::1]/v1", "ip_literal"],
    ["https://[2606:4700:4700::1111]/", "ip_literal"],
    ["https://[::ffff:169.254.169.254]/", "ip_literal"],
    ["https://[fd00::1]/", "ip_literal"],
    ["https://localhost/v1", "local_host"],
    ["https://localhost.localdomain/v1", "local_host"],
    ["https://api.localhost/v1", "local_host"],
    ["https://ollama.local/v1", "local_host"],
    ["https://llm.internal/v1", "local_host"],
    ["https://router.lan/v1", "local_host"],
    ["https://nas.home.arpa/v1", "local_host"],
    ["https://myserver/v1", "local_host"],
    ["https://api.test/v1", "local_host"],
    ["https://foo.example/v1", "local_host"],
    ["https://hidden.onion/v1", "local_host"],
    ["https://1.0.0.127.in-addr.arpa/", "local_host"],
    // Wildcard-DNS services that resolve to loopback or to the IP spelled in the name.
    ["https://127.0.0.1.nip.io/v1", "local_host"],
    ["https://10-0-0-1.sslip.io/v1", "local_host"],
    ["https://169.254.169.254.xip.io/", "local_host"],
    ["https://localtest.me/v1", "local_host"],
    ["https://api.lvh.me/v1", "local_host"],
    ["https://app.vcap.me/v1", "local_host"],
    ["https://x.localhost.direct/v1", "local_host"],
    ["https://anything.nip.io/v1", "local_host"],
    // Any other name that spells an IPv4 address (a private wildcard-DNS zone does the same).
    ["https://127.0.0.1.example.com/v1", "local_host"],
    ["https://api.10-0-0-1.example.com/v1", "local_host"],
    ["https://192-168-1-10-gw.example.com/v1", "local_host"],
    // Cluster-internal service discovery names (pseudo-TLDs, not public suffixes).
    ["https://kubernetes.default.svc/v1", "local_host"],
    ["https://llm.default.svc.cluster/v1", "local_host"],
    ["https://vault.service.consul/v1", "local_host"],
    ["https://foo.consul/v1", "local_host"],
    ["https://host.docker/v1", "local_host"],
    ["https://api.kube/v1", "local_host"],
    ["https://api.k8s/v1", "local_host"],
    ["https://under_score.example.com/v1", "not_public_host"],
    ["https://api.example.c0m/v1", "not_public_host"],
    ["https://okara.workers.dev/api", "own_origin"],
  ];
  it.each(rejects)("rejects %s (%s)", (raw, reason) => {
    const r = validateCustomBaseUrl(raw, "https://okara.workers.dev");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe(reason);
      expect(r.message.length).toBeGreaterThan(10);
    }
  });
});

// ------------------------------------------------------------------ model list parsing
describe("model list parsing", () => {
  it("accepts {data:[{id}]}, {models:[{name|id}]} and bare arrays; dedupes and sorts", () => {
    expect(extractModelIds({ data: [{ id: "b-model" }, { id: "A-model" }, { id: "b-model" }, { id: 5 }, null] })).toEqual({ ids: ["A-model", "b-model"], total: 2, truncated: false, recognized: true });
    expect(extractModelIds({ models: [{ name: "llama3:latest" }, { id: "qwen2" }, { model: "phi" }] }).ids).toEqual(["llama3:latest", "phi", "qwen2"]);
    expect(extractModelIds([{ id: "together/x" }, "plain-id"]).ids).toEqual(["plain-id", "together/x"]);
    expect(extractModelIds({ unexpected: true }).ids).toEqual([]);
    expect(extractModelIds("nope").ids).toEqual([]);
    // Only a list shape is a model list; an empty list is still recognised.
    expect(extractModelIds({ data: [] })).toMatchObject({ ids: [], recognized: true });
    expect(extractModelIds({ models: [] }).recognized).toBe(true);
    expect(extractModelIds([]).recognized).toBe(true);
    for (const notAList of [{ unexpected: true }, { error: { message: "x" } }, { data: "x" }, "nope", null, 42]) {
      expect(extractModelIds(notAList)).toMatchObject({ ids: [], recognized: false });
    }
  });

  it("caps at 500, drops ids over 200 characters or with control characters, keeps markup as plain strings", () => {
    const many = Array.from({ length: 650 }, (_, i) => ({ id: `m-${String(i).padStart(4, "0")}` }));
    const r = extractModelIds({ data: [...many, { id: "x".repeat(201) }, { id: "bad\u0000id" }, { id: "  spaced  " }, { id: "<img src=x onerror=alert(1)>" }] });
    expect(r.ids).toHaveLength(500);
    expect(r.total).toBe(652);
    expect(r.truncated).toBe(true);
    expect(r.ids.every((id) => id.length <= 200)).toBe(true);
    const small = extractModelIds({ data: [{ id: "x".repeat(201) }, { id: "bad\u0000id" }, { id: "  spaced  " }, { id: "<img src=x onerror=alert(1)>" }] });
    expect(small.ids).toEqual(["<img src=x onerror=alert(1)>", "spaced"]);
  });

  it("maps every outcome without echoing the provider body", async () => {
    const run = async (h: Handler) => {
      handler = h;
      return fetchModelList(fakeFetch(), BASE, SECRET);
    };
    const leak = "provider body must not be forwarded";
    expect(await run(() => okModels())).toMatchObject({
      ok: true,
      models: ["deepseek/deepseek-chat", "meta/llama-3.3-70b"],
      total: 2,
      detail: "Model list received (2 models); the key was not rejected.",
    });
    expect(await run(() => new Response(leak, { status: 401 }))).toMatchObject({ ok: false, detail: "Key rejected by provider (HTTP 401).", models: [] });
    expect(await run(() => new Response(leak, { status: 403 }))).toMatchObject({ ok: false, detail: "Key rejected by provider (HTTP 403)." });
    expect((await run(() => new Response(leak, { status: 429 }))).ok).toBeNull();
    expect(await run(() => new Response(leak, { status: 500 }))).toMatchObject({ ok: false, detail: "Provider returned HTTP 500." });
    expect((await run(() => new Response(leak, { status: 404 }))).detail).toMatch(/HTTP 404/);
    const redirect = await run(() => new Response(null, { status: 302, headers: { location: "https://169.254.169.254/" } }));
    expect(redirect).toMatchObject({ ok: false });
    expect(redirect.detail).toMatch(/redirect \(HTTP 302\); not followed/);
    expect(await run(() => Promise.reject(new TypeError("fetch failed")))).toMatchObject({ ok: false, detail: "Could not reach the provider (network error or timeout)." });
    // A 200 that is not a model list (base URL without /v1 serving a web page; a gateway's 200 {error}) fails:
    // nothing about the key or the endpoint was confirmed.
    const notAList = /HTTP 200, but the response is not an OpenAI-style model list\. Check the base URL \(it usually ends in \/v1/;
    for (const h of [() => new Response("<html>" + leak), () => Response.json({ error: { message: leak } }), () => Response.json({ unexpected: true }), () => new Response("")]) {
      const r = await run(h);
      expect(r).toMatchObject({ ok: false, models: [], detail: expect.stringMatching(notAList) });
      expect(r.detail).not.toContain(leak);
    }
    expect(await run(() => Response.json({ data: [] }))).toMatchObject({ ok: true, models: [], detail: expect.stringMatching(/no model ids; the key was not rejected/) });
    expect(await run(() => new Response("{}", { headers: { "content-length": String(64 * 1024 * 1024) } }))).toMatchObject({ ok: true, models: [], detail: expect.stringMatching(/too large/) });
    // Success never claims the key was validated.
    const truncated = await run(() => Response.json({ data: Array.from({ length: 501 }, (_, i) => ({ id: `m-${i}` })) }));
    expect(truncated.detail).toBe("Model list received (501 models, showing the first 500); the key was not rejected.");
    for (const r of seen) {
      expect(r.url).toBe(`${BASE}/models`);
      expect(r.headers.authorization).toBe(`Bearer ${SECRET}`);
      expect(r.redirect).toBe("manual");
      expect(r.hasSignal).toBe(true);
    }
  });
});

// ------------------------------------------------------------------ routes
describe("custom provider routes", () => {
  it("fetches models with a typed key, saves encrypted, selects it as writer, and never returns the key", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const models = await call(env, u, "POST", `${cp(u)}/models`, { baseUrl: "https://llm.example.com/v1/chat/completions", apiKey: SECRET });
    expect(models.status).toBe(200);
    expect(models.json!.data as CustomProviderModelList).toMatchObject({ ok: true, models: ["deepseek/deepseek-chat", "meta/llama-3.3-70b"], total: 2, truncated: false });
    expect(seen[0]!.url).toBe("https://llm.example.com/v1/models");

    const before = await call(env, u, "GET", cp(u));
    expect(before.json!.data).toMatchObject({ providers: [], writerSource: "default", maxProviders: MAX_CUSTOM_PROVIDERS, canManage: true });

    const saved = await addProvider(env, u, { label: "  My   gateway " });
    const p = saved.providers[0]!;
    expect(saved.writerSource).toBe(`custom:${p.id}`);
    expect(p).toMatchObject({ label: "My gateway", baseUrl: BASE, host: "llm.example.com", model: "meta/llama-3.3-70b", keyHint: "QRST", isWriter: true, lastTestOk: null });
    expect(saved.dataSent).toMatch(/custom provider's base URL/);

    const row = (await u.db.first<{ key_enc: string }>("SELECT key_enc FROM workspace_custom_providers WHERE workspace_id = ?", u.workspaceId))!;
    expect(row.key_enc).toMatch(/^v1\./);
    expect(await decryptSecret(env, row.key_enc, customProviderAad(u.workspaceId, p.id))).toBe(SECRET);
    await expect(decryptSecret(env, row.key_enc, customProviderAad("ws_other", p.id))).rejects.toBeTruthy();

    // Change model: re-fetch with the stored key (sent only to the stored host), then PATCH the model.
    seen.length = 0;
    const refetch = await call(env, u, "POST", `${cp(u)}/models`, { providerId: p.id });
    expect(refetch.json!.data.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`${BASE}/models`);
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${SECRET}`);
    const patched = await call(env, u, "PATCH", `${cp(u)}/${p.id}`, { model: "deepseek/deepseek-chat" });
    expect(patched.status).toBe(200);
    expect(patched.json!.data.providers[0]).toMatchObject({ model: "deepseek/deepseek-chat", isWriter: true });

    for (const b of bodies) {
      expect(b).not.toContain(SECRET);
      expect(b).not.toContain(row.key_enc);
    }
  });

  it("reports invalid input inline by field, never echoing it, and makes no request", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const bad = await call(env, u, "POST", `${cp(u)}/models`, { baseUrl: "https://127.0.0.1/v1", apiKey: SECRET });
    expect(bad.status).toBe(400);
    expect(bad.json!.error!.details).toEqual({ field: "baseUrl", reason: "ip_literal" });
    const http = await call(env, u, "POST", cp(u), { baseUrl: "http://llm.example.com/v1", apiKey: SECRET, model: "m" });
    expect(http.json!.error!.details).toEqual({ field: "baseUrl", reason: "not_https" });
    const key = await call(env, u, "POST", cp(u), { baseUrl: BASE, apiKey: `${SECRET} with space`, model: "m" });
    expect(key.json!.error!.details).toMatchObject({ field: "apiKey" });
    const model = await call(env, u, "POST", cp(u), { baseUrl: BASE, apiKey: SECRET, model: "  " });
    expect(model.json!.error!.details).toMatchObject({ field: "model" });
    const extra = await call(env, u, "POST", cp(u), { baseUrl: BASE, apiKey: SECRET, model: "m", extra: 1 });
    expect(extra.status).toBe(400);
    const mixed = await call(env, u, "POST", `${cp(u)}/models`, { providerId: "x", apiKey: SECRET });
    expect(mixed.status).toBe(400);
    expect(seen).toHaveLength(0);
    for (const b of bodies) expect(b).not.toContain(SECRET);
    expect(await u.db.all("SELECT id FROM workspace_custom_providers")).toHaveLength(0);
  });

  it("test button records the outcome for each provider answer", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const p = (await addProvider(env, u)).providers[0]!;
    const cases: Array<[Handler, boolean | null, RegExp]> = [
      [
        () => okModels(),
        true,
        /^Model list request succeeded; the key was not rejected \(some providers list models without checking the key, so the first draft is the final check\)\. The saved model is listed\.$/,
      ],
      [() => new Response("<!doctype html><title>Models</title>"), false, /not an OpenAI-style model list/],
      [() => Response.json({ error: { message: "x" } }), false, /not an OpenAI-style model list/],
      [() => Response.json({ data: [{ id: "other" }] }), true, /not in the provider's model list/],
      [() => new Response("x", { status: 401 }), false, /Key rejected by provider \(HTTP 401\)/],
      [() => new Response("x", { status: 429 }), null, /rate-limited/],
      [() => new Response("x", { status: 503 }), false, /HTTP 503/],
      [() => new Response(null, { status: 307, headers: { location: "https://elsewhere.example.com/" } }), false, /redirect \(HTTP 307\); not followed/],
      [() => Promise.reject(new Error("boom")), false, /network error or timeout/],
    ];
    for (const [h, ok, detail] of cases) {
      handler = h;
      const r = await call(env, u, "POST", `${cp(u)}/${p.id}/test`, {});
      expect(r.status).toBe(200);
      expect(r.json!.data.ok).toBe(ok);
      expect(r.json!.data.detail).toMatch(detail);
      const row = (await u.db.first<{ last_test_ok: number | null; last_test_detail: string; last_tested_at: string }>(
        "SELECT last_test_ok, last_test_detail, last_tested_at FROM workspace_custom_providers WHERE id = ?",
        p.id,
      ))!;
      expect(row.last_test_ok).toBe(ok === null ? null : ok ? 1 : 0);
      expect(row.last_test_detail).toMatch(detail);
      expect(row.last_tested_at).toBeTruthy();
    }
    expect(seen.every((s) => s.url === `${BASE}/models` && s.redirect === "manual")).toBe(true);
    for (const b of bodies) expect(b).not.toContain(SECRET);
  });

  it("caps providers per workspace, guards host changes, and switches the writer source", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const first = (await addProvider(env, u)).providers[0]!;
    for (let i = 1; i < MAX_CUSTOM_PROVIDERS; i++) await addProvider(env, u, { baseUrl: `https://gw${i}.example.com/v1`, useAsWriter: false });
    const sixth = await call(env, u, "POST", cp(u), { baseUrl: "https://six.example.com/v1", apiKey: SECRET, model: "m" });
    expect(sixth.status).toBe(409);
    const list = (await call(env, u, "GET", cp(u))).json!.data as CustomProvidersResponse;
    expect(list.providers).toHaveLength(MAX_CUSTOM_PROVIDERS);
    expect(list.writerSource).toBe(`custom:${first.id}`);
    expect(list.providers.filter((p) => p.isWriter)).toHaveLength(1);

    // A saved key is only ever sent to the host it was saved for.
    const moved = await call(env, u, "PATCH", `${cp(u)}/${first.id}`, { baseUrl: "https://attacker.example.net/v1" });
    expect(moved.status).toBe(400);
    expect(moved.json!.error!.details).toMatchObject({ field: "apiKey", reason: "key_required_for_new_host" });
    const samePath = await call(env, u, "PATCH", `${cp(u)}/${first.id}`, { baseUrl: "https://llm.example.com/v2" });
    expect(samePath.json!.data.providers[0]).toMatchObject({ baseUrl: "https://llm.example.com/v2", host: "llm.example.com" });
    const rekeyed = await call(env, u, "PATCH", `${cp(u)}/${first.id}`, { baseUrl: "https://new.example.net/v1", apiKey: `${SECRET}-NEW9` });
    expect(rekeyed.json!.data.providers[0]).toMatchObject({ host: "new.example.net", keyHint: "NEW9" });

    const second = list.providers[1]!;
    const sw = await call(env, u, "PUT", `/workspaces/${u.workspaceId}/writer-source`, { source: `custom:${second.id}` });
    expect(sw.json!.data.writerSource).toBe(`custom:${second.id}`);
    expect((sw.json!.data as CustomProvidersResponse).providers.filter((p) => p.isWriter).map((p) => p.id)).toEqual([second.id]);
    const def = await call(env, u, "PUT", `/workspaces/${u.workspaceId}/writer-source`, { source: "default" });
    expect(def.json!.data.writerSource).toBe("default");
    expect((await call(env, u, "PUT", `/workspaces/${u.workspaceId}/writer-source`, { source: "anthropic" })).status).toBe(400);
    expect((await call(env, u, "PUT", `/workspaces/${u.workspaceId}/writer-source`, { source: "custom:nope" })).status).toBe(404);

    // Removing the selected writer reverts to the default writer.
    await call(env, u, "PUT", `/workspaces/${u.workspaceId}/writer-source`, { source: `custom:${second.id}` });
    const del = await call(env, u, "DELETE", `${cp(u)}/${second.id}`);
    expect(del.json!.data).toMatchObject({ writerSource: "default" });
    expect(del.json!.data.providers).toHaveLength(MAX_CUSTOM_PROVIDERS - 1);
  });

  it("denies other workspaces on every route and limits members to read and test", async () => {
    const env = createTestEnv();
    const a = await seedUser(env);
    const b = await seedUser(env);
    const p = (await addProvider(env, a)).providers[0]!;
    // b is not a member of a's workspace: 404 everywhere, nothing fetched or changed.
    seen.length = 0;
    const foreign: Array<[string, string, unknown?]> = [
      ["GET", cp(a)],
      ["POST", cp(a), { baseUrl: BASE, apiKey: SECRET, model: "m" }],
      ["PATCH", `${cp(a)}/${p.id}`, { model: "x" }],
      ["DELETE", `${cp(a)}/${p.id}`],
      ["POST", `${cp(a)}/${p.id}/test`, {}],
      ["POST", `${cp(a)}/models`, { providerId: p.id }],
      ["PUT", `/workspaces/${a.workspaceId}/writer-source`, { source: "default" }],
    ];
    for (const [m, path, body] of foreign) expect((await call(env, b, m, path, body)).status, `${m} ${path}`).toBe(404);
    // b's own workspace cannot address a's provider id either.
    for (const [m, path, body] of [
      ["PATCH", `${cp(b)}/${p.id}`, { model: "x" }],
      ["DELETE", `${cp(b)}/${p.id}`],
      ["POST", `${cp(b)}/${p.id}/test`, {}],
      ["POST", `${cp(b)}/models`, { providerId: p.id }],
      ["PUT", `/workspaces/${b.workspaceId}/writer-source`, { source: `custom:${p.id}` }],
    ] as Array<[string, string, unknown?]>) {
      expect((await call(env, b, m, path, body)).status, `${m} ${path}`).toBe(404);
    }
    expect(seen).toHaveLength(0);
    expect(await resolveCustomWriter(env, b.db, b.workspaceId)).toEqual({ status: "none" });

    // A member (not owner) of a's workspace can read and test, but not change anything or fetch models.
    await addMember(a.db, a.workspaceId, b.userId);
    const read = await call(env, b, "GET", cp(a));
    expect(read.status).toBe(200);
    expect(read.json!.data).toMatchObject({ canManage: false });
    expect((await call(env, b, "POST", `${cp(a)}/${p.id}/test`, {})).status).toBe(200);
    for (const [m, path, body] of [
      ["POST", cp(a), { baseUrl: BASE, apiKey: SECRET, model: "m" }],
      ["PATCH", `${cp(a)}/${p.id}`, { model: "x" }],
      ["DELETE", `${cp(a)}/${p.id}`],
      ["POST", `${cp(a)}/models`, { providerId: p.id }],
      ["PUT", `/workspaces/${a.workspaceId}/writer-source`, { source: "default" }],
    ] as Array<[string, string, unknown?]>) {
      expect((await call(env, b, m, path, body)).status, `${m} ${path}`).toBe(403);
    }
    for (const t of bodies) expect(t).not.toContain(SECRET);
  });

  it("requires a signed-in, CSRF-valid request", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const anon = await app.request(`/api${cp(u)}`, {}, env);
    expect(anon.status).toBe(401);
    const noCsrf = await app.request(
      `/api${cp(u)}`,
      { method: "POST", headers: { ...authHeaders(u.sessionToken, u.csrfToken), "X-CSRF-Token": "wrong" }, body: JSON.stringify({ baseUrl: BASE, apiKey: SECRET, model: "m" }) },
      env,
    );
    expect(noCsrf.status).toBe(403);
    expect(await u.db.all("SELECT id FROM workspace_custom_providers")).toHaveLength(0);
  });

  it("returns setup_required when encryption is not configured", async () => {
    const env = createTestEnv({ TOKEN_ENCRYPTION_KEY_V1: undefined });
    const u = await seedUser(env);
    const r = await call(env, u, "POST", cp(u), { baseUrl: BASE, apiKey: SECRET, model: "m" });
    expect(r.status).toBe(412);
    expect(r.json!.error!.code).toBe("setup_required");
  });
});

// ------------------------------------------------------------------ allowlist
describe("per-workspace outbound allowlist", () => {
  it("createApiFetch admits only the given custom hosts, re-validated", async () => {
    const f = fakeFetch();
    const api = createApiFetch({}, f, ["llm.example.com", "127.0.0.1", "localhost", "evil.local", "Bad Host"]);
    await api("https://llm.example.com/v1/models");
    await expect(api("https://other.example.com/v1/models")).rejects.toBeInstanceOf(OutboundBlockedError);
    await expect(api("https://127.0.0.1/v1")).rejects.toBeInstanceOf(OutboundBlockedError);
    await expect(api("https://localhost/v1")).rejects.toBeInstanceOf(OutboundBlockedError);
    await expect(api("https://evil.local/v1")).rejects.toBeInstanceOf(OutboundBlockedError);
    await expect(api("http://llm.example.com/v1")).rejects.toBeInstanceOf(OutboundBlockedError);
    await expect(api("https://llm.example.com:8443/v1")).rejects.toBeInstanceOf(OutboundBlockedError);
    expect(seen.map((s) => s.url)).toEqual(["https://llm.example.com/v1/models"]);
    expect(seen[0]!.redirect).toBe("manual");
    expect(allowedApiHosts({}).has("llm.example.com")).toBe(false);
  });

  it("a run admits only its own workspace's custom writer host", async () => {
    const env = createTestEnv();
    const a = await seedUser(env);
    const b = await seedUser(env);
    await addProvider(env, a);
    await addProvider(env, b, { baseUrl: "https://b-gateway.example.org/v1" });
    // A saved but unselected provider of b is not admitted either.
    await addProvider(env, b, { baseUrl: "https://b-unused.example.org/v1", useAsWriter: false });
    const run = async (u: Seeded) => {
      const pid = await seedProject(env, u.workspaceId);
      const { runId } = await createRun(u.db, { workspaceId: u.workspaceId, projectId: pid, agent: "seo", trigger: "manual", idempotencyKey: `k-${pid}`, createdBy: null, now: FIXED_NOW });
      return buildRunContext(env, runId, { fetchImpl: fakeFetch() });
    };
    const ctxA = await run(a);
    const ctxB = await run(b);
    await ctxA.apiFetch("https://llm.example.com/v1/models");
    await expect(ctxA.apiFetch("https://b-gateway.example.org/v1/models")).rejects.toBeInstanceOf(OutboundBlockedError);
    await ctxB.apiFetch("https://b-gateway.example.org/v1/models");
    await expect(ctxB.apiFetch("https://llm.example.com/v1/models")).rejects.toBeInstanceOf(OutboundBlockedError);
    await expect(ctxB.apiFetch("https://b-unused.example.org/v1/models")).rejects.toBeInstanceOf(OutboundBlockedError);
  });
});

// ------------------------------------------------------------------ writer
const chatReply = (content: unknown, extra: Record<string, unknown> = {}) =>
  Response.json(
    { id: "chatcmpl-1", model: "meta/llama-3.3-70b", choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: 120, completion_tokens: 30 }, ...extra },
    { headers: { "x-request-id": "req_custom_1" } },
  );

describe("custom provider as the workspace writer", () => {
  it("drafts through the custom provider (json_schema), attributes writer_tokens to the workspace key, records cost as unknown", async () => {
    // The operator default writer is configured too; the selected custom writer must win.
    const env = createTestEnv({ WRITER_PROVIDER: "anthropic", WRITER_MODEL: "operator-model", WRITER_API_KEY: "operator-writer-key" });
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    await addProvider(env, u);
    handler = (url) => (url.endsWith("/chat/completions") ? chatReply({ title: "Draft" }, { usage: { prompt_tokens: 120, completion_tokens: 30, cost: 0.5 } }) : okModels());

    const { runId } = await createRun(u.db, { workspaceId: u.workspaceId, projectId: pid, agent: "seo", trigger: "manual", idempotencyKey: "kw", createdBy: null, now: FIXED_NOW });
    const ctx = await buildRunContext(env, runId, { fetchImpl: fakeFetch() });
    expect(ctx.writer).not.toBeNull();
    expect(ctx.writer!.name).toBe("openai_compatible");
    expect(ctx.writer!.model).toBe("meta/llama-3.3-70b");
    seen.length = 0;
    const res = await ctx.writer!.write({ purpose: "seo_recommendation", system: "Draft only from evidence.", input: { evidence: ["e1"] }, jsonSchema: { type: "object" }, maxOutputTokens: 800 });
    expect(res.output).toEqual({ title: "Draft" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`${BASE}/chat/completions`);
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(seen[0]!.redirect).toBe("manual");
    const sent = JSON.parse(seen[0]!.body!) as Record<string, any>;
    expect(sent.model).toBe("meta/llama-3.3-70b");
    expect(sent.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "seo_recommendation", strict: false } });
    expect(sent.max_completion_tokens).toBe(800);
    expect(sent).not.toHaveProperty("reasoning_effort");
    expect(sent).not.toHaveProperty("tools");

    const call = (await u.db.first<{ provider: string; model: string; cost_usd: number | null; status: string; request_id: string }>(
      "SELECT provider, model, cost_usd, status, request_id FROM provider_calls WHERE workspace_id = ? AND run_id = ?",
      u.workspaceId,
      runId,
    ))!;
    expect(call).toMatchObject({ provider: "openai_compatible", model: "meta/llama-3.3-70b", cost_usd: null, status: "ok", request_id: "req_custom_1" });
    // Workspace key: project counters only, never the global operator-key caps.
    const counters = await u.db.all<{ scope_key: string; resource: string; used: number }>("SELECT scope_key, resource, used FROM usage_counters WHERE resource IN ('writer_tokens', 'provider_calls')");
    expect(counters.filter((c) => c.scope_key === "global")).toEqual([]);
    expect(counters.find((c) => c.resource === "writer_tokens" && c.scope_key === `project:${pid}`)?.used).toBe(150);
    expect((await credentialSources(env, u.db, u.workspaceId)).writer).toBe("workspace_key");

    // Request-scoped writer (prompt generation) uses it too.
    const w = await buildWriterForWorkspace(env, u.db, u.workspaceId, { projectId: pid, fetchImpl: fakeFetch() });
    expect(w?.model).toBe("meta/llama-3.3-70b");
  });

  it("the operator default writer still counts against the global caps (contrast)", async () => {
    const env = createTestEnv({ WRITER_PROVIDER: "openai_compatible", WRITER_MODEL: "op-model", WRITER_BASE_URL: "https://op-llm.example.com/v1", WRITER_API_KEY: "operator-writer-key" });
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    handler = () => chatReply({ ok: true });
    const { runId } = await createRun(u.db, { workspaceId: u.workspaceId, projectId: pid, agent: "seo", trigger: "manual", idempotencyKey: "kop", createdBy: null, now: FIXED_NOW });
    const ctx = await buildRunContext(env, runId, { fetchImpl: fakeFetch() });
    await ctx.writer!.write({ purpose: "seo_recommendation", system: "s", input: {}, jsonSchema: { type: "object" }, maxOutputTokens: 100 });
    expect(seen[0]!.url).toBe("https://op-llm.example.com/v1/chat/completions");
    expect(await u.db.first("SELECT used FROM usage_counters WHERE scope_key = 'global' AND resource = 'writer_tokens'")).not.toBeNull();
  });

  it("a selected but unusable custom writer leaves no writer (no fallback to the default) and says why", async () => {
    const env = createTestEnv({ WRITER_PROVIDER: "anthropic", WRITER_MODEL: "operator-model", WRITER_API_KEY: "operator-writer-key" });
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    const p = (await addProvider(env, u)).providers[0]!;
    // Ciphertext bound to another row (AAD mismatch): decryption fails.
    const foreign = await encryptSecret(env, SECRET, customProviderAad(u.workspaceId, "cprov_other"));
    await u.db.run("UPDATE workspace_custom_providers SET key_enc = ? WHERE id = ?", foreign, p.id);
    const { runId } = await createRun(u.db, { workspaceId: u.workspaceId, projectId: pid, agent: "seo", trigger: "manual", idempotencyKey: "ku", createdBy: null, now: FIXED_NOW });
    const ctx = await buildRunContext(env, runId, { fetchImpl: fakeFetch() });
    expect(ctx.writer).toBeNull();
    const evt = await u.db.first<{ message: string }>("SELECT message FROM run_events WHERE run_id = ? AND step = 'runtime'", runId);
    expect(evt!.message).toMatch(/custom writer \(llm\.example\.com\) is selected but cannot be used/);
    expect(evt!.message).not.toContain(SECRET);
    expect(await buildWriterForWorkspace(env, u.db, u.workspaceId)).toBeNull();
    // Presence still reports the custom writer as the workspace's writer (no decryption in presence checks).
    expect((await writerStatusForWorkspace(env, u.db, u.workspaceId)).source).toBe("custom");
  });

  it("writer status and capability presence follow the writer source", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    expect(await writerStatusForWorkspace(env, u.db, u.workspaceId)).toMatchObject({ source: "default", configured: false });
    expect((await capabilityPresence(env, u.db, u.workspaceId)).writer).toBe(false);
    const p = (await addProvider(env, u)).providers[0]!;
    expect(await writerStatusForWorkspace(env, u.db, u.workspaceId)).toEqual({ source: "custom", configured: true, missing: [], custom: { id: p.id, host: "llm.example.com", model: "meta/llama-3.3-70b" } });
    expect((await capabilityPresence(env, u.db, u.workspaceId)).writer).toBe(true);
    await call(env, u, "PUT", `/workspaces/${u.workspaceId}/writer-source`, { source: "default" });
    expect((await writerStatusForWorkspace(env, u.db, u.workspaceId)).source).toBe("default");
    expect((await credentialSources(env, u.db, u.workspaceId)).writer).toBeNull();
  });

  it("GEO prompt suggestions use the custom writer", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    // Without any writer: setup_required.
    const none = await call(env, u, "POST", `/projects/${pid}/geo/prompts/generate`, {});
    expect(none.status).toBe(412);
    await addProvider(env, u);
    // Request-scoped writers use the platform fetch (behind the guarded API fetch): stub it.
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      return chatReply({ prompts: [{ prompt: "What size cabinet knobs suit a shaker kitchen?", stage: "problem-aware", rationale: "Sizing question." }] });
    });
    const r = await call(env, u, "POST", `/projects/${pid}/geo/prompts/generate`, {});
    expect(r.status).toBe(200);
    expect(r.json!.data.suggestions).toEqual([{ text: "What size cabinet knobs suit a shaker kitchen?", stage: "problem-aware", rationale: "Sizing question." }]);
    expect(r.json!.data.writer).toMatchObject({ model: "meta/llama-3.3-70b" });
    expect(urls).toEqual([`${BASE}/chat/completions`]);
  });
});

// ------------------------------------------------------------------ untrusted hosts: response size and key echo
const ENGINE_QUERIES = ["brass cabinet knob", "how to clean unlacquered brass", "outdoor brass lantern price"];
const draftRequest: WritingRequest = { purpose: "seo_recommendation", system: "Draft only from evidence.", input: { evidence: ["e1"] }, jsonSchema: { type: "object" }, maxOutputTokens: 800 };

describe("custom writer against a hostile or broken host", () => {
  it("caps the draft response body: a streamed 3 MiB answer fails after one attempt, without a retry, and is not read to the end", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    await addProvider(env, u);
    let pulled = 0;
    let cancelled = false;
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    const big = 3 * 1024 * 1024;
    handler = (url) =>
      url.endsWith("/chat/completions")
        ? new Response(
            new ReadableStream<Uint8Array>({
              pull(c) {
                if (pulled >= big) return c.close();
                c.enqueue(chunk);
                pulled += chunk.byteLength;
              },
              cancel() {
                cancelled = true;
              },
            }),
            { status: 200, headers: { "x-request-id": "req_big" } },
          )
        : okModels();
    const { runId } = await createRun(u.db, { workspaceId: u.workspaceId, projectId: pid, agent: "seo", trigger: "manual", idempotencyKey: "kbig", createdBy: null, now: FIXED_NOW });
    const ctx = await buildRunContext(env, runId, { fetchImpl: fakeFetch() });
    seen.length = 0;
    expect(CUSTOM_WRITER_MAX_RESPONSE_BYTES).toBe(2 * 1024 * 1024);
    await expect(ctx.writer!.write(draftRequest)).rejects.toThrow(`Response exceeded ${CUSTOM_WRITER_MAX_RESPONSE_BYTES} bytes.`);
    expect(seen.filter((r) => r.url.endsWith("/chat/completions"))).toHaveLength(1); // exactly one attempt
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(big);
    const rows = await u.db.all<{ status: string; error: string | null; request_id: string | null; cost_usd: number | null }>(
      "SELECT status, error, request_id, cost_usd FROM provider_calls WHERE workspace_id = ? AND run_id = ?",
      u.workspaceId,
      runId,
    );
    // A 2xx was processed (and may be billed) but its usage is unreadable: outcome unknown, reservation kept.
    expect(rows).toEqual([{ status: "unknown", error: `Response exceeded ${CUSTOM_WRITER_MAX_RESPONSE_BYTES} bytes.`, request_id: "req_big", cost_usd: null }]);

    // A declared Content-Length over the cap is refused without reading; an oversized error body is not retried either.
    seen.length = 0;
    handler = () => new Response("{}", { headers: { "content-length": String(64 * 1024 * 1024) } });
    await expect(ctx.writer!.write(draftRequest)).rejects.toThrow(/Response exceeded/);
    handler = () => new Response("x".repeat(CUSTOM_WRITER_MAX_RESPONSE_BYTES + 1), { status: 503 });
    await expect(ctx.writer!.write(draftRequest)).rejects.toThrow(/Response exceeded/);
    expect(seen).toHaveLength(2);
  });

  it("an error body echoing the key in a format redact() misses never reaches provider_calls, run events or draft errors", async () => {
    const GSK = "gsk_live0123456789abcdefSECRETxyzWXYZ";
    const echo = JSON.stringify({ error: { message: `API key ${GSK} is invalid`, hint: `key=${encodeURIComponent(GSK)}` } });
    expect(redact(echo)).toContain(GSK); // the generic patterns alone would keep it

    const s = await scenario({ engineQueries: ENGINE_QUERIES });
    const db = new Db(s.env.DB);
    const id = "cprov_echo";
    await db.insert("workspace_custom_providers", {
      id,
      workspace_id: s.workspaceId,
      label: "Echoing gateway",
      base_url: BASE,
      host: "llm.example.com",
      model: "meta/llama-3.3-70b",
      key_enc: await encryptSecret(s.env, GSK, customProviderAad(s.workspaceId, id)),
      key_hint: "WXYZ",
      is_writer: 1,
      created_at: FIXED_NOW.toISOString(),
      updated_at: FIXED_NOW.toISOString(),
    });
    handler = (url) => (url.endsWith("/chat/completions") ? new Response(echo, { status: 401, headers: { "content-type": "application/json" } }) : okModels());
    const { runId } = await createRun(db, { workspaceId: s.workspaceId, projectId: s.projectId, agent: "seo", trigger: "manual", idempotencyKey: "kecho", createdBy: null, now: FIXED_NOW });
    const ctx = { ...(await buildRunContext(s.env, runId, { fetchImpl: fakeFetch(), clock: () => FIXED_NOW })), decisions: fakeDecisions() };
    expect(ctx.writer?.model).toBe("meta/llama-3.3-70b");

    // The draft path: the writer error comes back as the draft's errors.
    const { candidates } = await candidatesOf(s);
    const c = candidates.find((x) => x.kind === "weak_ctr")!;
    const draft = await draftWithWriter(ctx, { candidate: c, action: "rewrite_title_meta", tier: "act", intent: null, severityScore: null, evidence: c.evidence.map((spec, i) => ({ id: `ev_e${i}`, spec })), contextDocs: [] });
    expect(draft).toMatchObject({ ok: false, reason: "writer_failed" });
    if (!draft.ok) {
      expect(draft.errors.join(" ")).toMatch(/HTTP 401/);
      expect(draft.errors.join(" ")).toContain("[redacted]");
    }

    // The whole run step: drafts fall back to the template and the writer error is logged as a run event.
    await generateSeoRecommendations(ctx);
    expect(seen.filter((r) => r.url.endsWith("/chat/completions")).length).toBeGreaterThan(1);
    const calls = await db.all<{ error: string | null }>("SELECT error FROM provider_calls WHERE workspace_id = ? AND run_id = ?", s.workspaceId, runId);
    expect(calls.some((r) => /HTTP 401: .*API key \[redacted\] is invalid/.test(r.error ?? ""))).toBe(true);
    const events = await db.all<{ message: string }>("SELECT message FROM run_events WHERE run_id = ?", runId);
    expect(events.some((e) => /Writer unavailable .*HTTP 401/.test(e.message))).toBe(true);

    const everything = [JSON.stringify(draft), ...calls.map((r) => r.error ?? ""), ...events.map((e) => e.message)].join("\n");
    for (const form of [GSK, encodeURIComponent(GSK), "gsk_live0123"]) expect(everything).not.toContain(form);
  });
});

// ------------------------------------------------------------------ storage
describe("migration 0010 and export", () => {
  it("applies on the D1 shim: one writer per workspace, cascade with the workspace", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const cols = await u.db.all<{ name: string }>("SELECT name FROM pragma_table_info('workspace_custom_providers')");
    expect(cols.map((c) => c.name)).toEqual([
      "id",
      "workspace_id",
      "label",
      "base_url",
      "host",
      "model",
      "key_enc",
      "key_hint",
      "is_writer",
      "last_tested_at",
      "last_test_ok",
      "last_test_detail",
      "created_at",
      "updated_at",
      "role", // migration 0011 (custom GEO engines); existing rows default to 'writer'
      "is_chat", // migration 0019 (Ask Okara chat model, [A36]); existing rows 0
    ]);
    const row = (id: string, isWriter: number) => ({
      id,
      workspace_id: u.workspaceId,
      label: "x",
      base_url: BASE,
      host: "llm.example.com",
      model: "m",
      key_enc: "v1.a.b",
      key_hint: "abcd",
      is_writer: isWriter,
      created_at: "t",
      updated_at: "t",
    });
    await u.db.insert("workspace_custom_providers", row("c1", 1));
    await u.db.insert("workspace_custom_providers", row("c2", 0));
    await expect(u.db.insert("workspace_custom_providers", row("c3", 1))).rejects.toThrow(/UNIQUE/);
    await expect(u.db.insert("workspace_custom_providers", { ...row("c4", 0), workspace_id: "ws_missing" })).rejects.toThrow(/FOREIGN KEY/);
    await u.db.run("DELETE FROM workspaces WHERE id = ?", u.workspaceId);
    expect(await u.db.all("SELECT id FROM workspace_custom_providers")).toHaveLength(0);
  });

  it("before migration 0010 is applied: the routes say setup_required and the default writer keeps working", async () => {
    const env = createTestEnv({ WRITER_PROVIDER: "anthropic", WRITER_MODEL: "operator-model", WRITER_API_KEY: "operator-writer-key" });
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    await u.db.run("DROP TABLE workspace_custom_providers");
    for (const [m, path, body] of [
      ["GET", cp(u)],
      ["POST", cp(u), { baseUrl: BASE, apiKey: SECRET, model: "m" }],
      ["POST", `${cp(u)}/models`, { providerId: "cprov_x" }],
      ["PUT", `/workspaces/${u.workspaceId}/writer-source`, { source: "default" }],
    ] as Array<[string, string, unknown?]>) {
      const r = await call(env, u, m, path, body);
      expect(r.status, `${m} ${path}`).toBe(412);
      expect(r.json!.error!.message).toMatch(/migration 0010/);
    }
    const { runId } = await createRun(u.db, { workspaceId: u.workspaceId, projectId: pid, agent: "seo", trigger: "manual", idempotencyKey: "km", createdBy: null, now: FIXED_NOW });
    const ctx = await buildRunContext(env, runId, { fetchImpl: fakeFetch() });
    expect(ctx.writer?.model).toBe("operator-model");
    expect(await writerStatusForWorkspace(env, u.db, u.workspaceId)).toMatchObject({ source: "default", configured: true });
    expect((await credentialSources(env, u.db, u.workspaceId)).writer).toBe("operator_key");
    const res = await app.request(`/api/projects/${pid}/export`, { headers: authHeaders(u.sessionToken, u.csrfToken) }, env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { tables: Record<string, unknown[]> } }).data.tables.workspace_custom_providers).toEqual([]);
  });

  it("before migration 0011 (no role column): writers keep working, GEO engines are setup_required", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    // Rebuild the table exactly as migration 0010 created it (no role column, no role index).
    await u.db.run("DROP INDEX idx_custom_providers_role");
    await u.db.run(
      `CREATE TABLE wcp_0010 AS SELECT id, workspace_id, label, base_url, host, model, key_enc, key_hint, is_writer, last_tested_at, last_test_ok, last_test_detail, created_at, updated_at FROM workspace_custom_providers`,
    );
    await u.db.run("DROP TABLE workspace_custom_providers");
    await u.db.run("ALTER TABLE wcp_0010 RENAME TO workspace_custom_providers");
    expect((await u.db.all<{ name: string }>("SELECT name FROM pragma_table_info('workspace_custom_providers')")).map((c) => c.name)).not.toContain("role");
    // The INSERT error is "table ... has no column named role" (not "no such column"): the fallback must catch both.
    await expect(u.db.run("INSERT INTO workspace_custom_providers (id, role) VALUES ('x', 'geo')")).rejects.toThrow(/has no column named role/);

    const created = await call(env, u, "POST", cp(u), { baseUrl: BASE, apiKey: SECRET, model: "meta/llama-3.3-70b" });
    expect(created.status).toBe(201);
    const data = created.json!.data as CustomProvidersResponse;
    expect(data.providers).toHaveLength(1);
    expect(data.providers[0]).toMatchObject({ role: "writer", isWriter: true });
    const geo = await call(env, u, "POST", cp(u), { baseUrl: BASE, apiKey: SECRET, model: "m", role: "geo" });
    expect(geo.status).toBe(412);
    expect(geo.json!.error).toMatchObject({ code: "setup_required", message: expect.stringMatching(/migration 0011/) });
    const list = await call(env, u, "GET", cp(u));
    expect(list.status).toBe(200);
    expect((list.json!.data as CustomProvidersResponse).providers.map((p) => p.role)).toEqual(["writer"]);
    const id = data.providers[0]!.id;
    const back = await call(env, u, "PUT", `/workspaces/${u.workspaceId}/writer-source`, { source: "default" });
    expect(back.status).toBe(200);
    expect((back.json!.data as CustomProvidersResponse).writerSource).toBe("default");
    const again = await call(env, u, "PUT", `/workspaces/${u.workspaceId}/writer-source`, { source: `custom:${id}` });
    expect((again.json!.data as CustomProvidersResponse).writerSource).toBe(`custom:${id}`);
    expect((await call(env, u, "PATCH", `${cp(u)}/${id}`, { model: "deepseek/deepseek-chat" })).status).toBe(200);
    // Runs: the custom writer is used, no GEO engine lanes exist.
    const { runId } = await createRun(u.db, { workspaceId: u.workspaceId, projectId: pid, agent: "seo", trigger: "manual", idempotencyKey: "k0011", createdBy: null, now: FIXED_NOW });
    const ctx = await buildRunContext(env, runId, { fetchImpl: fakeFetch() });
    expect(ctx.writer?.model).toBe("deepseek/deepseek-chat");
    expect(ctx.geoProviders).toHaveLength(0);
    expect((await capabilityPresence(env, u.db, u.workspaceId)).customGeoEngines).toEqual([]);
    expect(JSON.stringify(bodies)).not.toContain(SECRET);
  });

  it("project export includes the workspace's custom providers without key material", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    await addProvider(env, u);
    const keyEnc = (await u.db.first<{ key_enc: string }>("SELECT key_enc FROM workspace_custom_providers"))!.key_enc;
    const res = await app.request(`/api/projects/${pid}/export`, { headers: authHeaders(u.sessionToken, u.csrfToken) }, env);
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const secret of [SECRET, keyEnc, "key_enc", "key_hint", "QRST"]) expect(text).not.toContain(secret);
    const body = JSON.parse(text) as { data: { tables: Record<string, Array<Record<string, unknown>>> } };
    expect(body.data.tables.workspace_custom_providers).toHaveLength(1);
    expect(body.data.tables.workspace_custom_providers![0]).toMatchObject({ base_url: BASE, host: "llm.example.com", model: "meta/llama-3.3-70b", is_writer: 1 });
  });
});

// ------------------------------------------------------------------ tunnel hosts: base URL changes without re-entering the key
const TUNNEL = "https://abc-def-123.trycloudflare.com/v1";
const TUNNEL_HOST = "abc-def-123.trycloudflare.com";

describe("tunnel hostnames (owner request: the base URL keeps changing)", () => {
  it("trycloudflare, ngrok-free and loca.lt names validate; IP literals and local names still fail", () => {
    for (const [raw, host] of [
      ["https://abc-def-123.trycloudflare.com", "abc-def-123.trycloudflare.com"],
      ["https://abc-def-123.trycloudflare.com/v1/", "abc-def-123.trycloudflare.com"],
      ["https://1a2b-34-56.ngrok-free.app/v1", "1a2b-34-56.ngrok-free.app"],
      ["https://my-gpu.loca.lt/v1/chat/completions", "my-gpu.loca.lt"],
    ] as const) {
      expect(validateCustomBaseUrl(raw, "https://okara.workers.dev"), raw).toMatchObject({ ok: true, host });
    }
    for (const [raw, reason] of [
      ["https://127.0.0.1/v1", "ip_literal"],
      ["https://10.0.0.5/v1", "ip_literal"],
      ["https://192.168.1.20/v1", "ip_literal"],
      ["https://[::1]/v1", "ip_literal"],
      ["https://localhost/v1", "local_host"],
      ["https://gpu.localhost/v1", "local_host"],
      ["https://my-gpu.local/v1", "local_host"],
      // A tunnel name that spells an IPv4 address is refused like any other (wildcard-DNS convention).
      ["https://127-0-0-1.trycloudflare.com/v1", "local_host"],
      ["http://abc-def-123.trycloudflare.com/v1", "not_https"],
      ["https://my-gpu.loca.lt:8443/v1", "port"],
    ] as const) {
      const r = validateCustomBaseUrl(raw, "https://okara.workers.dev");
      expect(r.ok, raw).toBe(false);
      if (!r.ok) expect(r.reason, raw).toBe(reason);
    }
  });

  it("ngrok names with an embedded IPv4 address are allowed (ngrok DNS resolves them to ngrok's edge), other wildcard-DNS names are not", () => {
    const origin = "https://okara.workers.dev";
    for (const u of ["https://7c3e-103-21-58-191.ngrok-free.app/v1", "https://abcd-127-0-0-1.ngrok-free.dev/v1", "https://9f1e-10-0-0-5.ngrok.app/v1", "https://1a2b-34-56.ngrok-free.app/v1"]) {
      expect(validateCustomBaseUrl(u, origin)).toMatchObject({ ok: true });
    }
    // Only one label directly under an ngrok domain; deeper names and look-alike domains keep the rule.
    for (const u of ["https://127-0-0-1.evil.ngrok-free.app/v1", "https://127-0-0-1.ngrok-free.app.evil.com/v1", "https://127.0.0.1.nip.io/v1", "https://10-0-0-1.sslip.io/v1", "https://127-0-0-1.trycloudflare.com/v1"]) {
      expect(validateCustomBaseUrl(u, origin)).toMatchObject({ ok: false, reason: "local_host" });
    }
    expect(isNgrokTunnelHost("7c3e-103-21-58-191.ngrok-free.app")).toBe(true);
    expect(isNgrokTunnelHost("ngrok-free.app")).toBe(false);
    expect(isNgrokTunnelHost("a.b.ngrok.io")).toBe(false);
  });
});

describe("PATCH base URL to a new host: keepKeyForNewHost", () => {
  const rowOf = (u: Seeded, id: string) =>
    u.db.first<{ base_url: string; host: string; key_enc: string; key_hint: string; updated_at: string }>(
      "SELECT base_url, host, key_enc, key_hint, updated_at FROM workspace_custom_providers WHERE workspace_id = ? AND id = ?",
      u.workspaceId,
      id,
    );
  const changeRows = (u: Seeded) => u.db.all<Record<string, unknown>>("SELECT * FROM workspace_custom_provider_changes WHERE workspace_id = ? ORDER BY rowid", u.workspaceId);

  it("without the flag and without a new key a host change is 400 key_required_for_new_host and nothing changes", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const p = (await addProvider(env, u)).providers[0]!;
    const before = await rowOf(u, p.id);
    for (const body of [{ baseUrl: TUNNEL }, { baseUrl: TUNNEL, keepKeyForNewHost: false }, { baseUrl: TUNNEL, model: "deepseek/deepseek-chat" }]) {
      const r = await call(env, u, "PATCH", `${cp(u)}/${p.id}`, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json!.error).toMatchObject({ code: "bad_request", details: { field: "apiKey", reason: "key_required_for_new_host" } });
      expect(r.json!.error!.message).toMatch(/confirm sending the saved key to the new host/);
    }
    const bad = await call(env, u, "PATCH", `${cp(u)}/${p.id}`, { baseUrl: TUNNEL, keepKeyForNewHost: "yes" });
    expect(bad.status).toBe(400);
    expect(bad.json!.error!.details).toMatchObject({ field: "keepKeyForNewHost", reason: "invalid" });
    expect(await rowOf(u, p.id)).toEqual(before);
    expect(await changeRows(u)).toEqual([]);
    expect(seen).toHaveLength(0);
    for (const t of bodies) expect(t).not.toContain(SECRET);
  });

  it("with keepKeyForNewHost the saved key stays bound to the row (same envelope, still decrypts) and is used on the new host", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const p = (await addProvider(env, u)).providers[0]!;
    const before = (await rowOf(u, p.id))!;
    await call(env, u, "POST", `${cp(u)}/${p.id}/test`, {}); // a recorded test result is reset by the move
    const r = await call(env, u, "PATCH", `${cp(u)}/${p.id}`, { baseUrl: TUNNEL, keepKeyForNewHost: true });
    expect(r.status).toBe(200);
    const moved = (r.json!.data as CustomProvidersResponse).providers[0]!;
    // Saved without a name, so its default name (the host) follows the new host.
    expect(moved).toMatchObject({ label: TUNNEL_HOST, baseUrl: TUNNEL, host: TUNNEL_HOST, keyHint: "QRST", isWriter: true, lastTestOk: null, lastTestedAt: null });
    expect(moved.changes).toEqual([
      { at: expect.any(String), by: "Test User", fields: ["label", "baseUrl"], fromBaseUrl: BASE, toBaseUrl: TUNNEL, fromHost: "llm.example.com", toHost: TUNNEL_HOST, keyKeptForNewHost: true },
    ]);
    // The AAD binds workspace and row only (not the host): the envelope is kept as is and still decrypts.
    const after = (await rowOf(u, p.id))!;
    expect(after.key_enc).toBe(before.key_enc);
    expect(await decryptSecret(env, after.key_enc, customProviderAad(u.workspaceId, p.id))).toBe(SECRET);
    // The audit row names who and when, without key material.
    const log = await changeRows(u);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ provider_id: p.id, changed_by: u.userId, fields: "label,base_url", old_host: "llm.example.com", new_host: TUNNEL_HOST, key_kept_for_new_host: 1 });
    expect(JSON.stringify(log)).not.toContain(SECRET);
    expect(JSON.stringify(log)).not.toContain(before.key_enc);

    // Test and Fetch models now reach the new host with the same key; the old host is never contacted.
    seen.length = 0;
    expect((await call(env, u, "POST", `${cp(u)}/${p.id}/test`, {})).json!.data).toMatchObject({ ok: true });
    expect((await call(env, u, "POST", `${cp(u)}/models`, { providerId: p.id })).json!.data).toMatchObject({ ok: true, models: ["deepseek/deepseek-chat", "meta/llama-3.3-70b"] });
    expect(seen.map((x) => x.url)).toEqual([`${TUNNEL}/models`, `${TUNNEL}/models`]);
    for (const x of seen) expect(x.headers.authorization).toBe(`Bearer ${SECRET}`);
    for (const t of bodies) expect(t).not.toContain(SECRET);
  });

  it("Test reports whether the saved model is listed on the new host (the UI then offers Change model)", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const p = (await addProvider(env, u)).providers[0]!;
    const test = async () => (await call(env, u, "POST", `${cp(u)}/${p.id}/test`, {})).json!.data as { ok: boolean | null; detail: string; modelListed: boolean | null };
    expect(await test()).toMatchObject({ ok: true, modelListed: true });
    await call(env, u, "PATCH", `${cp(u)}/${p.id}`, { baseUrl: TUNNEL, keepKeyForNewHost: true });
    // The machine behind the new tunnel serves other models.
    handler = (url) => (url === `${TUNNEL}/models` ? Response.json({ data: [{ id: "qwen/qwen3-32b" }] }) : new Response("unexpected", { status: 500 }));
    expect(await test()).toMatchObject({ ok: true, modelListed: false, detail: expect.stringMatching(/not in the provider's model list/) });
    // A truncated or empty list, or a failure, is "unknown" (never a false alarm).
    handler = () => Response.json({ data: [] });
    expect(await test()).toMatchObject({ ok: true, modelListed: null });
    handler = () => new Response("nope", { status: 401 });
    expect(await test()).toMatchObject({ ok: false, modelListed: null });
  });

  it("the writer drafts through the new host with the same key; the old host is no longer admitted", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    const p = (await addProvider(env, u)).providers[0]!;
    expect((await call(env, u, "PATCH", `${cp(u)}/${p.id}`, { baseUrl: TUNNEL, keepKeyForNewHost: true })).status).toBe(200);
    handler = (url) => (url.endsWith("/chat/completions") ? chatReply({ title: "Draft from the tunnel" }) : okModels());
    const { runId } = await createRun(u.db, { workspaceId: u.workspaceId, projectId: pid, agent: "seo", trigger: "manual", idempotencyKey: "ktun", createdBy: null, now: FIXED_NOW });
    const ctx = await buildRunContext(env, runId, { fetchImpl: fakeFetch() });
    seen.length = 0;
    const res = await ctx.writer!.write({ purpose: "seo_recommendation", system: "Draft only from evidence.", input: { evidence: ["e1"] }, jsonSchema: { type: "object" }, maxOutputTokens: 400 });
    expect(res.output).toEqual({ title: "Draft from the tunnel" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`${TUNNEL}/chat/completions`);
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${SECRET}`);
    await expect(ctx.apiFetch(`${BASE}/models`)).rejects.toBeInstanceOf(OutboundBlockedError);
    // Request-scoped writer too.
    const w = await buildWriterForWorkspace(env, u.db, u.workspaceId, { projectId: pid, fetchImpl: fakeFetch() });
    seen.length = 0;
    await w!.write({ purpose: "seo_recommendation", system: "s", input: {}, jsonSchema: { type: "object" }, maxOutputTokens: 100 });
    expect(seen[0]).toMatchObject({ url: `${TUNNEL}/chat/completions`, headers: expect.objectContaining({ authorization: `Bearer ${SECRET}` }) });
  });

  it("a custom GEO engine keeps its key across a host change too", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const added = await call(env, u, "POST", cp(u), { baseUrl: BASE, apiKey: SECRET, model: "meta/llama-3.3-70b", role: "geo" });
    expect(added.status).toBe(201);
    const g = (added.json!.data as CustomProvidersResponse).providers.find((x) => x.role === "geo")!;
    expect((await call(env, u, "PATCH", `${cp(u)}/${g.id}`, { baseUrl: "https://my-gpu.loca.lt/v1" })).json!.error!.details).toMatchObject({ reason: "key_required_for_new_host" });
    const r = await call(env, u, "PATCH", `${cp(u)}/${g.id}`, { baseUrl: "https://my-gpu.loca.lt/v1", keepKeyForNewHost: true });
    expect(r.status).toBe(200);
    expect((r.json!.data as CustomProvidersResponse).providers.find((x) => x.id === g.id)).toMatchObject({ role: "geo", host: "my-gpu.loca.lt", isWriter: false, keyHint: "QRST" });
    const row = (await listCustomProviders(u.db, u.workspaceId)).find((x) => x.id === g.id)!;
    expect(await resolveCustomProviderRow(env, u.db, u.workspaceId, row)).toMatchObject({
      status: "ready",
      provider: { baseUrl: "https://my-gpu.loca.lt/v1", host: "my-gpu.loca.lt", key: SECRET },
    });
  });

  it("a new key wins over the flag; same-host and no-op changes need neither; the log keeps the newest 5, newest first", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const p = (await addProvider(env, u)).providers[0]!;
    const NEW_KEY = `${SECRET}-NEW9`;
    const ngrok = await call(env, u, "PATCH", `${cp(u)}/${p.id}`, { baseUrl: "https://1a2b-34-56.ngrok-free.app/v1", apiKey: NEW_KEY, keepKeyForNewHost: true });
    expect(ngrok.status).toBe(200);
    expect((ngrok.json!.data as CustomProvidersResponse).providers[0]).toMatchObject({ host: "1a2b-34-56.ngrok-free.app", keyHint: "NEW9" });
    expect((ngrok.json!.data as CustomProvidersResponse).providers[0]!.changes![0]).toMatchObject({ fields: ["label", "baseUrl", "apiKey"], keyKeptForNewHost: false });
    const enc = (await rowOf(u, p.id))!.key_enc;
    expect(await decryptSecret(env, enc, customProviderAad(u.workspaceId, p.id))).toBe(NEW_KEY);
    // Same host, other path: no key, no flag needed. The flag on an unchanged host is ignored.
    expect((await call(env, u, "PATCH", `${cp(u)}/${p.id}`, { baseUrl: "https://1a2b-34-56.ngrok-free.app/api/v1" })).status).toBe(200);
    expect((await call(env, u, "PATCH", `${cp(u)}/${p.id}`, { model: "deepseek/deepseek-chat", keepKeyForNewHost: true })).status).toBe(200);
    // A no-op PATCH records nothing.
    expect((await call(env, u, "PATCH", `${cp(u)}/${p.id}`, { model: "deepseek/deepseek-chat" })).status).toBe(200);
    expect(await changeRows(u)).toHaveLength(3);
    // Rotate through tunnels: the response carries only the newest CUSTOM_PROVIDER_CHANGES_SHOWN entries.
    for (const host of ["a-1.trycloudflare.com", "b-2.trycloudflare.com", "my-gpu.loca.lt", "c-3.trycloudflare.com"]) {
      expect((await call(env, u, "PATCH", `${cp(u)}/${p.id}`, { baseUrl: `https://${host}/v1`, keepKeyForNewHost: true })).status).toBe(200);
    }
    const list = (await call(env, u, "GET", cp(u))).json!.data as CustomProvidersResponse;
    const changes = list.providers[0]!.changes!;
    expect(changes).toHaveLength(CUSTOM_PROVIDER_CHANGES_SHOWN);
    expect(changes.map((c) => c.toHost)).toEqual(["c-3.trycloudflare.com", "my-gpu.loca.lt", "b-2.trycloudflare.com", "a-1.trycloudflare.com", null]);
    expect(changes[4]).toMatchObject({ fields: ["model"], fromHost: null, keyKeptForNewHost: false });
    expect(await changeRows(u)).toHaveLength(7);
    for (const t of bodies) expect(t).not.toContain(NEW_KEY);
  });

  it("a saved key that cannot be decrypted is not moved (key_unreadable); a new key fixes it", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const p = (await addProvider(env, u)).providers[0]!;
    const foreign = await encryptSecret(env, SECRET, customProviderAad(u.workspaceId, "cprov_other"));
    await u.db.run("UPDATE workspace_custom_providers SET key_enc = ? WHERE id = ?", foreign, p.id);
    const r = await call(env, u, "PATCH", `${cp(u)}/${p.id}`, { baseUrl: TUNNEL, keepKeyForNewHost: true });
    expect(r.status).toBe(400);
    expect(r.json!.error!.details).toMatchObject({ field: "apiKey", reason: "key_unreadable" });
    expect((await rowOf(u, p.id))!.host).toBe("llm.example.com");
    expect((await call(env, u, "PATCH", `${cp(u)}/${p.id}`, { baseUrl: TUNNEL, apiKey: SECRET })).status).toBe(200);
  });

  it("other workspaces cannot PATCH (with or without the flag); members cannot; members can read the change log", async () => {
    const env = createTestEnv();
    const a = await seedUser(env);
    const b = await seedUser(env);
    const p = (await addProvider(env, a)).providers[0]!;
    const before = await rowOf(a, p.id);
    for (const body of [{ baseUrl: TUNNEL, keepKeyForNewHost: true }, { baseUrl: TUNNEL, apiKey: "sk-attacker-key-0000" }]) {
      expect((await call(env, b, "PATCH", `${cp(a)}/${p.id}`, body)).status).toBe(404);
      expect((await call(env, b, "PATCH", `${cp(b)}/${p.id}`, body)).status).toBe(404);
    }
    await addMember(a.db, a.workspaceId, b.userId);
    expect((await call(env, b, "PATCH", `${cp(a)}/${p.id}`, { baseUrl: TUNNEL, keepKeyForNewHost: true })).status).toBe(403);
    expect(await rowOf(a, p.id)).toEqual(before);
    expect(await changeRows(a)).toEqual([]);
    expect(seen).toHaveLength(0);
    // The owner moves it; the member sees when and by whom (never the key).
    await call(env, a, "PATCH", `${cp(a)}/${p.id}`, { baseUrl: TUNNEL, keepKeyForNewHost: true });
    const read = await call(env, b, "GET", cp(a));
    expect((read.json!.data as CustomProvidersResponse).providers[0]!.changes![0]).toMatchObject({ by: "Test User", toHost: TUNNEL_HOST, keyKeptForNewHost: true });
    expect(read.text).not.toContain(SECRET);
    // b's own workspace shows no change log of a's provider.
    expect((await call(env, b, "GET", cp(b))).json!.data.providers).toEqual([]);
  });

  it("DELETE removes the change log with the provider; export carries the log without secrets; before migration 0012 PATCH still works", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    const p = (await addProvider(env, u)).providers[0]!;
    await call(env, u, "PATCH", `${cp(u)}/${p.id}`, { baseUrl: TUNNEL, keepKeyForNewHost: true });
    const res = await app.request(`/api/projects/${pid}/export`, { headers: authHeaders(u.sessionToken, u.csrfToken) }, env);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    const exported = (JSON.parse(text) as { data: { tables: Record<string, Array<Record<string, unknown>>> } }).data.tables.workspace_custom_provider_changes!;
    expect(exported).toEqual([expect.objectContaining({ provider_id: p.id, old_host: "llm.example.com", new_host: TUNNEL_HOST, key_kept_for_new_host: 1 })]);
    expect((await call(env, u, "DELETE", `${cp(u)}/${p.id}`)).status).toBe(200);
    expect(await changeRows(u)).toEqual([]);

    // Code deployed before migration 0012: the change applies, unlogged; GET has no changes.
    const q = (await addProvider(env, u)).providers[0]!;
    await u.db.run("DROP TABLE workspace_custom_provider_changes");
    const r = await call(env, u, "PATCH", `${cp(u)}/${q.id}`, { baseUrl: TUNNEL, keepKeyForNewHost: true });
    expect(r.status).toBe(200);
    expect((r.json!.data as CustomProvidersResponse).providers[0]).toMatchObject({ host: TUNNEL_HOST, changes: [] });
    expect((await call(env, u, "DELETE", `${cp(u)}/${q.id}`)).status).toBe(200);
  });

  it("the SSRF base URL rules still apply with keepKeyForNewHost (no bypass via quick update): 400 baseUrl, nothing stored, nothing fetched", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const p = (await addProvider(env, u)).providers[0]!;
    const before = await rowOf(u, p.id);
    seen.length = 0;
    for (const [baseUrl, reason] of [
      ["https://127.0.0.1/v1", "ip_literal"],
      ["https://[::1]/v1", "ip_literal"],
      ["https://localhost/v1", "local_host"],
      ["https://my-gpu.local/v1", "local_host"],
      ["https://127-0-0-1.trycloudflare.com/v1", "local_host"],
      ["https://7c3e-103-21-58-191.sslip.io/v1", "local_host"],
      ["http://abc-def-123.trycloudflare.com/v1", "not_https"],
      ["https://u:p@abc-def-123.trycloudflare.com/v1", "credentials"],
      ["https://abc.nip.io/v1", "local_host"],
      ["https://my-gpu.loca.lt:8443/v1", "port"],
    ] as const) {
      const r = await call(env, u, "PATCH", `${cp(u)}/${p.id}`, { baseUrl, keepKeyForNewHost: true });
      expect(r.status, baseUrl).toBe(400);
      expect(r.json!.error!.details, baseUrl).toEqual({ field: "baseUrl", reason });
      expect(r.text).not.toContain(SECRET);
    }
    // Other fields in the same body do not get through either.
    const mixed = await call(env, u, "PATCH", `${cp(u)}/${p.id}`, { baseUrl: "https://127.0.0.1/v1", keepKeyForNewHost: true, model: "deepseek/deepseek-chat", label: "Moved" });
    expect(mixed.json!.error!.details).toEqual({ field: "baseUrl", reason: "ip_literal" });
    expect(await rowOf(u, p.id)).toEqual(before);
    expect(await changeRows(u)).toEqual([]);
    expect(seen).toHaveLength(0);
  });

  it("own_origin is refused with keepKeyForNewHost too", async () => {
    const ORIGIN = "https://okara-app.workers.dev";
    const env = createTestEnv({ APP_ORIGIN: ORIGIN });
    const u = await seedUser(env);
    const send = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(`/api${path}`, { method, headers: authHeaders(u.sessionToken, u.csrfToken, ORIGIN), body: body === undefined ? undefined : JSON.stringify(body) }, env);
      const text = await res.text();
      return { status: res.status, json: JSON.parse(text) as { data?: CustomProvidersResponse; error?: { details?: unknown } } };
    };
    const added = await send("POST", cp(u), { baseUrl: BASE, apiKey: SECRET, model: "meta/llama-3.3-70b" });
    expect(added.status).toBe(201);
    const p = added.json.data!.providers[0]!;
    const before = await rowOf(u, p.id);
    seen.length = 0;
    const r = await send("PATCH", `${cp(u)}/${p.id}`, { baseUrl: `${ORIGIN}/api/v1`, keepKeyForNewHost: true });
    expect(r.status).toBe(400);
    expect(r.json.error!.details).toEqual({ field: "baseUrl", reason: "own_origin" });
    expect(await rowOf(u, p.id)).toEqual(before);
    expect(await changeRows(u)).toEqual([]);
    expect(seen).toHaveLength(0);
  });

  it("a run reads URL and key together: a stale row never pairs the old host with a new key", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const p = (await addProvider(env, u)).providers[0]!;
    // The row a run read earlier (buildRunContext lists GEO rows / the writer row before decrypting keys).
    const stale = (await listCustomProviders(u.db, u.workspaceId)).find((x) => x.id === p.id)!;
    expect(stale).toMatchObject({ base_url: BASE, host: "llm.example.com" });
    // Meanwhile the owner moves the provider to a tunnel with a key typed for the tunnel.
    const NEW_KEY = `${SECRET}-TUN1`;
    expect((await call(env, u, "PATCH", `${cp(u)}/${p.id}`, { baseUrl: TUNNEL, apiKey: NEW_KEY })).status).toBe(200);
    const use = await resolveCustomProviderRow(env, u.db, u.workspaceId, stale);
    expect(use).not.toMatchObject({ provider: { host: "llm.example.com", key: NEW_KEY } });
    expect(use).toEqual({
      status: "ready",
      provider: { id: p.id, label: TUNNEL_HOST, baseUrl: TUNNEL, host: TUNNEL_HOST, model: "meta/llama-3.3-70b", key: NEW_KEY },
    });
    // The stored values are validated as read, never the stale ones: a stored URL that no longer validates is
    // unusable even when the stale row's URL was fine.
    await u.db.run("UPDATE workspace_custom_providers SET base_url = ?, host = ? WHERE id = ?", "https://127.0.0.1/v1", "127.0.0.1", p.id);
    expect(await resolveCustomProviderRow(env, u.db, u.workspaceId, stale)).toMatchObject({ status: "unusable", host: "127.0.0.1" });
    await u.db.run("UPDATE workspace_custom_providers SET base_url = ? WHERE id = ?", TUNNEL, p.id);
    expect(await resolveCustomProviderRow(env, u.db, u.workspaceId, stale)).toMatchObject({ status: "unusable", detail: expect.stringMatching(/host mismatch/) });
    // A row removed in between resolves to nothing; another workspace's id never resolves.
    expect(await resolveCustomProviderRow(env, u.db, "ws_other", stale)).toBeNull();
    expect((await call(env, u, "DELETE", `${cp(u)}/${p.id}`)).status).toBe(200);
    expect(await resolveCustomProviderRow(env, u.db, u.workspaceId, stale)).toBeNull();
  });

  it("a default name (the host) follows a new host; a chosen name is kept", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const provider = async (id: string) => ((await call(env, u, "GET", cp(u))).json!.data as CustomProvidersResponse).providers.find((x) => x.id === id)!;
    // Saved without a name: labelled with its host.
    const d = (await addProvider(env, u)).providers[0]!;
    expect(d.label).toBe("llm.example.com");
    expect((await call(env, u, "PATCH", `${cp(u)}/${d.id}`, { baseUrl: TUNNEL, keepKeyForNewHost: true })).status).toBe(200);
    expect(await provider(d.id)).toMatchObject({ label: TUNNEL_HOST, host: TUNNEL_HOST });
    expect((await provider(d.id)).changes![0]).toMatchObject({ fields: ["label", "baseUrl"], fromHost: "llm.example.com", toHost: TUNNEL_HOST, keyKeptForNewHost: true });
    // An older client resending the prefilled (default) name: it still follows the host.
    expect((await call(env, u, "PATCH", `${cp(u)}/${d.id}`, { baseUrl: "https://my-gpu.loca.lt/v1", label: TUNNEL_HOST, keepKeyForNewHost: true })).status).toBe(200);
    expect((await provider(d.id)).label).toBe("my-gpu.loca.lt");
    // Same host (another path): the name stays.
    expect((await call(env, u, "PATCH", `${cp(u)}/${d.id}`, { baseUrl: "https://my-gpu.loca.lt/api/v1" })).status).toBe(200);
    expect((await provider(d.id)).label).toBe("my-gpu.loca.lt");
    // A name sent with the move wins.
    expect((await call(env, u, "PATCH", `${cp(u)}/${d.id}`, { baseUrl: TUNNEL, label: "GPU box", keepKeyForNewHost: true })).status).toBe(200);
    expect((await provider(d.id)).label).toBe("GPU box");

    // A chosen name is kept across moves.
    const named = await addProvider(env, u, { label: "My gateway", useAsWriter: false });
    const n = named.providers.find((x) => x.label === "My gateway")!;
    expect((await call(env, u, "PATCH", `${cp(u)}/${n.id}`, { baseUrl: "https://b-2.trycloudflare.com/v1", keepKeyForNewHost: true })).status).toBe(200);
    expect(await provider(n.id)).toMatchObject({ label: "My gateway", host: "b-2.trycloudflare.com" });
    expect((await provider(n.id)).changes![0]!.fields).toEqual(["baseUrl"]);

    // GEO lanes too (the lane name on boards comes from the label).
    const geo = await call(env, u, "POST", cp(u), { baseUrl: BASE, apiKey: SECRET, model: "meta/llama-3.3-70b", role: "geo" });
    const g = (geo.json!.data as CustomProvidersResponse).providers.find((x) => x.role === "geo")!;
    expect(g.label).toBe("llm.example.com");
    expect((await call(env, u, "PATCH", `${cp(u)}/${g.id}`, { baseUrl: "https://c-3.trycloudflare.com/v1", keepKeyForNewHost: true })).status).toBe(200);
    expect((await provider(g.id)).label).toBe("c-3.trycloudflare.com");
  });
});
