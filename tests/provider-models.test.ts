/**
 * Workspace model selection for the built-in providers and custom GEO engine lanes:
 *   - model-list parsing per provider with fixtures shaped like the official list responses;
 *   - listProviderModels transport (documented URLs and auth headers, redirect manual, timeout, failures,
 *     body and key never echoed);
 *   - POST /credentials/:provider/models and PUT /credentials/:provider/model (owner only, CSRF, tenancy,
 *     key sources, validation, the key never echoed);
 *   - resolution order workspace > env > none, and the runtime / presence using the selected model;
 *   - custom GEO engines: role "geo" rows (max 2, never the writer), runtime lane with its own host-only
 *     fetch, observations stored ungrounded with cost unknown and no usd reservation, mention rate only (never
 *     citation rate) in metrics, results, board and activity labels;
 *   - migration 0011 on the D1 shim and the export without secrets.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "@worker/app";
import type { Env } from "@worker/env";
import { Db } from "@worker/lib/db";
import { encryptSecret } from "@worker/lib/crypto";
import { credentialAad } from "@worker/platform/credentials";
import {
  MUST_SUPPORT,
  TYPESAFE_MODEL_NOT_SELECTABLE,
  listProviderModels,
  loadWorkspaceModels,
  modelForKeySource,
  normalizeModelId,
  operatorKeyModelRefusal,
  parseProviderModelList,
  rateKnownFor,
  resolveAllModels,
  resolveModel,
} from "@worker/platform/provider-models";
import { buildDecisionsForWorkspace } from "@worker/redirects/decisions";
import { exportProject } from "@worker/platform/export";
import { setCredentialTestFetch } from "@worker/routes/credentials";
import { setCustomProviderFetch } from "@worker/routes/custom-providers";
import { OutboundBlockedError, buildRunContext, capabilityPresence } from "@worker/runs/runtime";
import { createRun } from "@worker/runs/runs-service";
import { runGeoBatch } from "@worker/geo/batch";
import { citationRate, mentionRate, type MetricObservation } from "@worker/geo/metrics";
import { CUSTOM_GEO_GROUNDING_MODE, CUSTOM_GEO_NOTE, customGeoLaneLabel, isCustomGeoId } from "@worker/geo/custom-lanes";
import { createCustomGeoProvider, parseCustomGeoResponse } from "@worker/providers/custom-geo";
import { budgetFor, createBudget } from "@worker/runs/budget";
import { buildRunActivity } from "@worker/runs/activity";
import type { ProjectRow } from "@worker/platform/access";
import type { CustomProvidersResponse, EngineBoardResponse, GeoResults, IntegrationsStatus, ProviderModelList } from "@shared/types";
import { analyzeObservation } from "@worker/geo/analyze";
import { generateGeoProposals } from "@worker/geo/proposals";
import { createTestEnv } from "./helpers/env";
import { makeTestContext } from "./helpers/context";
import { FIXED_NOW, authHeaders, seedProject, seedUser } from "./helpers/fixtures";
import { fixture, seedObservation, seedPromptSet } from "./fixtures/geo-analysis/seed";

type ProviderStatus = IntegrationsStatus["providers"][number];
const app = createApp();
const KEY = "sk-test-WORKSPACEKEY-0123456789abcdef";
const OP_KEY = "op-test-OPERATORKEY-9876543210fedcba";
const TYPED = "sk-typed-TYPEDKEY-abcdefabcdef0123";

// ------------------------------------------------------------------ fake fetch
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

// Fixtures shaped like the official list responses (docs/provider-contracts.md "Workspace model selection").
const GEMINI_LIST = {
  models: [
    { name: "models/gemini-3.8-flash", baseModelId: "gemini-3.8-flash", displayName: "Gemini 3.8 Flash", supportedGenerationMethods: ["generateContent", "countTokens"] },
    { name: "models/text-embedding-005", displayName: "Text Embedding", supportedGenerationMethods: ["embedContent"] },
    { name: "models/gemini-3-pro-preview", displayName: "Gemini 3 Pro Preview", supportedGenerationMethods: ["generateContent"] },
    { name: "models/bad id with spaces", displayName: "Bad", supportedGenerationMethods: ["generateContent"] },
  ],
  nextPageToken: "",
};
const OPENAI_LIST = {
  object: "list",
  data: [
    { id: "gpt-5.5", object: "model", created: 1700000000, owned_by: "openai" },
    { id: "gpt-4.1-mini", object: "model", created: 1700000000, owned_by: "openai" },
    { id: "gpt-5.5", object: "model", created: 1700000000, owned_by: "openai" },
    { id: "evil\u0000id", object: "model", created: 1, owned_by: "x" },
  ],
};
const ANTHROPIC_LIST = {
  data: [
    { type: "model", id: "claude-opus-5", display_name: "Claude Opus 5", created_at: "2026-07-24T00:00:00Z" },
    { type: "model", id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5", created_at: "2026-05-01T00:00:00Z" },
  ],
  has_more: true,
  first_id: "claude-opus-5",
  last_id: "claude-sonnet-5-5",
};
const PERPLEXITY_LIST = {
  object: "list",
  data: [
    { id: "perplexity/sonar", object: "model", created: 1, owned_by: "perplexity" },
    { id: "openai/gpt-5.5", object: "model", created: 1, owned_by: "openai" },
    { id: "sonar-without-prefix", object: "model", created: 1, owned_by: "perplexity" },
  ],
};
const TYPESAFE_LIST = {
  models: [
    { name: "jev-latest", description: "Latest Jev", release_date: "2026-09-01" },
    { name: "jev-1.13.0", description: "Jev 1.13.0", release_date: "2026-09-01" },
  ],
};

const listFor = (url: string): unknown =>
  url.startsWith("https://generativelanguage.googleapis.com/")
    ? GEMINI_LIST
    : url.startsWith("https://api.openai.com/")
      ? OPENAI_LIST
      : url.startsWith("https://api.anthropic.com/")
        ? ANTHROPIC_LIST
        : url.startsWith("https://api.perplexity.ai/")
          ? PERPLEXITY_LIST
          : TYPESAFE_LIST;

beforeEach(() => {
  seen.length = 0;
  handler = (url) => Response.json(listFor(url));
  setCredentialTestFetch(fakeFetch());
  setCustomProviderFetch(fakeFetch());
});
afterEach(() => {
  setCredentialTestFetch(null);
  setCustomProviderFetch(null);
});

const bodies: string[] = [];
async function call(env: Env, u: { sessionToken: string; csrfToken: string }, method: string, path: string, body?: unknown, headers?: Record<string, string>) {
  const res = await app.request(
    `/api${path}`,
    { method, headers: { ...authHeaders(u.sessionToken, u.csrfToken), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) },
    env,
  );
  const text = await res.text();
  bodies.push(text);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, json: text ? (JSON.parse(text) as { data?: any; error?: { code: string; message: string; details?: any } }) : null, text };
}

async function saveKey(env: Env, db: Db, workspaceId: string, provider: string, key = KEY) {
  await db.insert("provider_credentials", {
    id: `cred_${provider}_${workspaceId}`,
    workspace_id: workspaceId,
    provider,
    key_enc: await encryptSecret(env, key, credentialAad(workspaceId, provider as never)),
    key_hint: key.slice(-4),
    created_at: FIXED_NOW.toISOString(),
    updated_at: FIXED_NOW.toISOString(),
  });
}

// ------------------------------------------------------------------ parsing
describe("model-list parsing per provider (official response shapes)", () => {
  it("Gemini: only generateContent models, 'models/' prefix removed, display name as label, invalid ids dropped", () => {
    const r = parseProviderModelList("gemini", GEMINI_LIST);
    expect(r.recognized).toBe(true);
    expect(r.options).toEqual([
      { id: "gemini-3-pro-preview", label: "Gemini 3 Pro Preview (gemini-3-pro-preview)" },
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash (gemini-3.8-flash)" },
    ]);
    expect(r.more).toBe(false);
    expect(parseProviderModelList("gemini", { ...GEMINI_LIST, nextPageToken: "tok" }).more).toBe(true);
  });

  it("OpenAI: data[].id, deduped and sorted; control characters dropped", () => {
    const r = parseProviderModelList("openai_geo", OPENAI_LIST);
    expect(r.options.map((o) => o.id)).toEqual(["gpt-4.1-mini", "gpt-5.5"]);
    expect(r.total).toBe(2);
  });

  it("Anthropic: data[].id with display_name; has_more reported", () => {
    const r = parseProviderModelList("anthropic_geo", ANTHROPIC_LIST);
    expect(r.options).toEqual([
      { id: "claude-opus-5", label: "Claude Opus 5 (claude-opus-5)" },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (claude-sonnet-5-5)" },
    ]);
    expect(r.more).toBe(true);
  });

  it("Perplexity: Agent API ids in provider/model format only", () => {
    expect(parseProviderModelList("perplexity", PERPLEXITY_LIST).options.map((o) => o.id)).toEqual(["openai/gpt-5.5", "perplexity/sonar"]);
  });

  it("TypeSafe: models[].name", () => {
    expect(parseProviderModelList("typesafe", TYPESAFE_LIST).options.map((o) => o.id)).toEqual(["jev-1.13.0", "jev-latest"]);
  });

  it("anything else is not a model list; long or hostile ids never pass", () => {
    expect(parseProviderModelList("openai_geo", { error: { message: "x" } }).recognized).toBe(false);
    expect(parseProviderModelList("gemini", { data: [] }).recognized).toBe(false);
    expect(parseProviderModelList("openai_geo", [{ id: "a" }]).recognized).toBe(false);
    const long = "a".repeat(201);
    expect(parseProviderModelList("openai_geo", { data: [{ id: long }, { id: "<script>" }, { id: "ok-1" }] }).options.map((o) => o.id)).toEqual(["ok-1"]);
    const many = { data: Array.from({ length: 700 }, (_, i) => ({ id: `m-${String(i).padStart(3, "0")}` })) };
    const capped = parseProviderModelList("openai_geo", many);
    expect(capped.options).toHaveLength(500);
    expect(capped.truncated).toBe(true);
    expect(capped.total).toBe(700);
  });

  it("normalizeModelId validates per provider", () => {
    expect(normalizeModelId("gemini", "models/gemini-3.8-flash")).toBe("gemini-3.8-flash");
    expect(normalizeModelId("gemini", "gemini/../x")).toBeNull();
    expect(normalizeModelId("perplexity", "sonar")).toBeNull();
    expect(normalizeModelId("perplexity", " perplexity/sonar ")).toBe("perplexity/sonar");
    expect(normalizeModelId("openai_geo", "gpt 5")).toBeNull();
    expect(normalizeModelId("anthropic_geo", "claude-opus-5")).toBe("claude-opus-5");
    expect(normalizeModelId("typesafe", "jev-1.13.0")).toBe("jev-1.13.0");
    expect(normalizeModelId("typesafe", "")).toBeNull();
    expect(normalizeModelId("openai_geo", 42)).toBeNull();
  });
});

describe("listProviderModels transport", () => {
  const cases: Array<[Parameters<typeof listProviderModels>[0], string, Record<string, string>]> = [
    ["gemini", "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", { "x-goog-api-key": KEY }],
    ["openai_geo", "https://api.openai.com/v1/models", { authorization: `Bearer ${KEY}` }],
    ["anthropic_geo", "https://api.anthropic.com/v1/models?limit=1000", { "x-api-key": KEY, "anthropic-version": "2023-06-01" }],
    ["perplexity", "https://api.perplexity.ai/v1/models", { authorization: `Bearer ${KEY}` }],
    ["typesafe", "https://api.typesafe.ai/v1/models", { authorization: `Bearer ${KEY}` }],
  ];
  for (const [provider, url, headers] of cases) {
    it(`${provider}: GET ${url} with the key in a header only, redirect manual, a timeout signal`, async () => {
      const r = await listProviderModels(provider, KEY, fakeFetch());
      expect(r.ok).toBe(true);
      expect(r.models.length).toBeGreaterThan(0);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ url, method: "GET", redirect: "manual", hasSignal: true });
      expect(seen[0]!.headers).toMatchObject(headers);
      expect(seen[0]!.url).not.toContain(KEY);
      expect(JSON.stringify(r)).not.toContain(KEY);
    });
  }

  it("reports failures without echoing the provider body", async () => {
    const leak = `{"error":"bad key ${KEY}"}`;
    const run = async (h: Handler) => {
      handler = h;
      return listProviderModels("openai_geo", KEY, fakeFetch());
    };
    expect(await run(() => new Response(leak, { status: 401 }))).toMatchObject({ ok: false, detail: "Key rejected by OpenAI (HTTP 401).", models: [] });
    expect(await run(() => new Response(leak, { status: 429 }))).toMatchObject({ ok: null });
    expect(await run(() => new Response(null, { status: 302, headers: { Location: "https://evil.example" } }))).toMatchObject({ ok: false, detail: expect.stringMatching(/redirect.*not followed/) });
    expect(await run(() => new Response(leak, { status: 500 }))).toMatchObject({ ok: false, detail: expect.stringMatching(/HTTP 500/) });
    expect(await run(() => new Response("<html>", { status: 200 }))).toMatchObject({ ok: false });
    expect(await run(() => Response.json({ error: { message: KEY } }))).toMatchObject({ ok: false, detail: expect.stringMatching(/documented shape/) });
    expect(
      await run(() => {
        throw new Error(`boom ${KEY}`);
      }),
    ).toMatchObject({ ok: false, detail: "Could not reach OpenAI (network error or timeout)." });
    expect(JSON.stringify(bodies)).not.toContain(KEY);
  });
});

// ------------------------------------------------------------------ resolution
describe("model resolution: workspace > env > none", () => {
  it("prefers the workspace selection, then the env var, then nothing (TypeSafe: the documented alias)", () => {
    expect(resolveModel({ GEMINI_MODEL: "gemini-env" }, { gemini: "gemini-ws" }, "gemini")).toEqual({ model: "gemini-ws", source: "workspace" });
    expect(resolveModel({ GEMINI_MODEL: " gemini-env " }, {}, "gemini")).toEqual({ model: "gemini-env", source: "operator" });
    expect(resolveModel({}, {}, "gemini")).toEqual({ model: null, source: null });
    expect(resolveModel({}, {}, "typesafe")).toEqual({ model: "jev-latest", source: "default" });
    expect(resolveModel({ TYPESAFE_MODEL: "jev-1.13.0" }, {}, "typesafe")).toEqual({ model: "jev-1.13.0", source: "operator" });
    // TypeSafe is never workspace-selectable: a selection in the map is ignored.
    expect(resolveModel({}, { typesafe: "jev-1.13.0" }, "typesafe")).toEqual({ model: "jev-latest", source: "default" });
    expect(resolveModel({ TYPESAFE_MODEL: "jev-pin" }, { typesafe: "jev-1.13.0" }, "typesafe")).toEqual({ model: "jev-pin", source: "operator" });
    // An invalid stored id is skipped, never used.
    expect(resolveModel({ PERPLEXITY_MODEL: "perplexity/sonar" }, { perplexity: "not valid" }, "perplexity")).toEqual({ model: "perplexity/sonar", source: "operator" });
    const all = resolveAllModels({}, { openai_geo: "gpt-5.5" });
    expect(all.openai_geo).toEqual({ model: "gpt-5.5", source: "workspace" });
    expect(all.anthropic_geo.model).toBeNull();
  });

  it("rateKnownFor reports a missing rate as false (cost unknown), never a guess", () => {
    expect(rateKnownFor("openai_geo", "an-unpriced-model-xyz")).toBe(false);
    expect(rateKnownFor("typesafe", "jev-latest")).toBeNull();
    expect(rateKnownFor("gemini", null)).toBeNull();
  });
});

// ------------------------------------------------------------------ routes
describe("POST /workspaces/:wid/credentials/:provider/models", () => {
  const path = (wid: string, p: string) => `/workspaces/${wid}/credentials/${p}/models`;

  it("lists with the saved workspace key; result carries keySource and the feature note, never the key", async () => {
    const env = createTestEnv({ OPENAI_GEO_API_KEY: OP_KEY });
    const u = await seedUser(env);
    await saveKey(env, u.db, u.workspaceId, "openai_geo");
    const r = await call(env, u, "POST", path(u.workspaceId, "openai_geo"), {});
    expect(r.status).toBe(200);
    const d = r.json!.data as ProviderModelList;
    expect(d).toMatchObject({ ok: true, keySource: "workspace_key", mustSupport: MUST_SUPPORT.openai_geo, total: 2 });
    expect(d.models.map((m) => m.id)).toEqual(["gpt-4.1-mini", "gpt-5.5"]);
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(r.text).not.toContain(KEY);
    expect(r.text).not.toContain(OP_KEY);
  });

  it("falls back to the operator key, and uses a typed key when given", async () => {
    const env = createTestEnv({ GEMINI_API_KEY: OP_KEY });
    const u = await seedUser(env);
    const op = await call(env, u, "POST", path(u.workspaceId, "gemini"), {});
    expect(op.json!.data).toMatchObject({ ok: true, keySource: "operator_key" });
    expect(seen[0]!.headers["x-goog-api-key"]).toBe(OP_KEY);
    const typed = await call(env, u, "POST", path(u.workspaceId, "gemini"), { apiKey: TYPED });
    expect(typed.json!.data).toMatchObject({ ok: true, keySource: "typed_key" });
    expect(seen[1]!.headers["x-goog-api-key"]).toBe(TYPED);
    expect(op.text + typed.text).not.toMatch(new RegExp(`${OP_KEY}|${TYPED}`));
  });

  it("with the operator key only priced models are listed: no fine-tuned or org-owned OpenAI models; the workspace key lists them all", async () => {
    const list = {
      object: "list",
      data: [
        { id: "gpt-5.5", object: "model", created: 1, owned_by: "openai" },
        { id: "gpt-4.1-mini", object: "model", created: 1, owned_by: "system" },
        { id: "gpt-unpriced-new", object: "model", created: 1, owned_by: "openai" },
        { id: "ft:gpt-4o-mini-2024-07-18:acme-operator-corp:secret-pricing-bot:AbC123", object: "model", created: 1, owned_by: "org-acmeoperator" },
        { id: "gpt-5", object: "model", created: 1, owned_by: "user-abc123" },
      ],
    };
    handler = () => Response.json(list);
    const env = createTestEnv({ OPENAI_GEO_API_KEY: OP_KEY });
    const u = await seedUser(env);
    const op = await call(env, u, "POST", path(u.workspaceId, "openai_geo"), {});
    const d = op.json!.data as ProviderModelList;
    expect(d).toMatchObject({ ok: true, keySource: "operator_key", total: 2 });
    expect(d.models.map((m) => m.id)).toEqual(["gpt-4.1-mini", "gpt-5.5"]);
    expect(d.detail).toContain("Only models with a verified price are listed with the operator key; add your own key to see all models.");
    expect(op.text).not.toContain("acme-operator-corp");
    expect(op.text).not.toContain("ft:");
    // The workspace's own key lists everything its account offers.
    await saveKey(env, u.db, u.workspaceId, "openai_geo");
    const own = (await call(env, u, "POST", path(u.workspaceId, "openai_geo"), {})).json!.data as ProviderModelList;
    expect(own.keySource).toBe("workspace_key");
    expect(own.models.map((m) => m.id)).toContain("ft:gpt-4o-mini-2024-07-18:acme-operator-corp:secret-pricing-bot:AbC123");
    expect(own.models).toHaveLength(5);
    expect(own.detail).not.toContain("verified price");
    // Pure parser: same rule.
    expect(parseProviderModelList("openai_geo", list, { operatorKey: true }).filtered).toBe(3);
    expect(parseProviderModelList("gemini", GEMINI_LIST, { operatorKey: true, at: FIXED_NOW }).options.map((o) => o.id)).toEqual(["gemini-3.8-flash"]);
    expect(parseProviderModelList("anthropic_geo", ANTHROPIC_LIST, { operatorKey: true }).options.map((o) => o.id)).toEqual(["claude-opus-5", "claude-sonnet-5-5"]);
  });

  it("TypeSafe models are never listed (400 model_not_selectable) whatever the key source; nothing is fetched", async () => {
    const env = createTestEnv({ TYPESAFE_API_KEY: OP_KEY, TYPESAFE_MODEL: "jev-1.13.0" });
    const u = await seedUser(env);
    const op = await call(env, u, "POST", path(u.workspaceId, "typesafe"), {});
    expect(op.status).toBe(400);
    expect(op.json!.error).toMatchObject({ message: TYPESAFE_MODEL_NOT_SELECTABLE, details: { field: "provider", reason: "model_not_selectable" } });
    const typed = await call(env, u, "POST", path(u.workspaceId, "typesafe"), { apiKey: TYPED });
    expect(typed.status).toBe(400);
    await saveKey(env, u.db, u.workspaceId, "typesafe");
    expect((await call(env, u, "POST", path(u.workspaceId, "typesafe"), {})).status).toBe(400);
    expect(seen).toHaveLength(0);
    expect(op.text + typed.text).not.toMatch(new RegExp(`${OP_KEY}|${TYPED}|${KEY}`));
  });

  it("no key at all is setup_required; the writer has no model route; unknown providers 404", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    expect((await call(env, u, "POST", path(u.workspaceId, "anthropic_geo"), {})).status).toBe(412);
    expect((await call(env, u, "POST", path(u.workspaceId, "writer"), {})).status).toBe(404);
    expect((await call(env, u, "POST", path(u.workspaceId, "nope"), {})).status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  it("owner only, CSRF required, other workspaces not disclosed; a bad typed key is refused without echo", async () => {
    const env = createTestEnv({ OPENAI_GEO_API_KEY: OP_KEY });
    const owner = await seedUser(env);
    const other = await seedUser(env);
    const member = await seedUser(env);
    await member.db.insert("memberships", { workspace_id: owner.workspaceId, user_id: member.userId, role: "member", created_at: FIXED_NOW.toISOString() });
    expect((await call(env, member, "POST", path(owner.workspaceId, "openai_geo"), {})).status).toBe(403);
    expect((await call(env, other, "POST", path(owner.workspaceId, "openai_geo"), {})).status).toBe(404); // not a member: not disclosed
    expect((await call(env, owner, "POST", path(owner.workspaceId, "openai_geo"), {}, { "X-CSRF-Token": "wrong" })).status).toBe(403);
    const bad = await call(env, owner, "POST", path(owner.workspaceId, "openai_geo"), { apiKey: "short\u0001key-with-control" });
    expect(bad.status).toBe(400);
    expect(bad.text).not.toContain("short");
    expect(seen).toHaveLength(0);
  });
});

describe("PUT /workspaces/:wid/credentials/:provider/model", () => {
  const path = (wid: string, p: string) => `/workspaces/${wid}/credentials/${p}/model`;

  it("saves the workspace's model, which then wins over the env var; null reverts to the operator default", async () => {
    const env = createTestEnv({ OPENAI_GEO_API_KEY: OP_KEY, OPENAI_GEO_MODEL: "gpt-4.1-mini" });
    const u = await seedUser(env);
    // A priced model may run on the operator key.
    const r = await call(env, u, "PUT", path(u.workspaceId, "openai_geo"), { model: "gpt-5.5" });
    expect(r.status).toBe(200);
    expect(r.json!.data as ProviderStatus).toMatchObject({ provider: "openai_geo", model: "gpt-5.5", modelSource: "workspace", workspaceModel: "gpt-5.5", state: "ready", rateKnown: true, modelNote: null });
    const list = (await call(env, u, "GET", `/workspaces/${u.workspaceId}/credentials`)).json!.data as ProviderStatus[];
    expect(list.find((p) => p.provider === "openai_geo")).toMatchObject({ model: "gpt-5.5", modelSource: "workspace" });
    const back = await call(env, u, "PUT", path(u.workspaceId, "openai_geo"), { model: null });
    expect(back.json!.data).toMatchObject({ model: "gpt-4.1-mini", modelSource: "operator", workspaceModel: null });
    expect(await u.db.all("SELECT * FROM workspace_provider_models WHERE workspace_id = ?", u.workspaceId)).toHaveLength(0);
  });

  it("operator key: an unpriced model is refused (400 operator_key_unpriced, value never echoed); the operator's own model and a BYO key are fine", async () => {
    const env = createTestEnv({ OPENAI_GEO_API_KEY: OP_KEY, OPENAI_GEO_MODEL: "gpt-operator-unpriced" });
    const u = await seedUser(env);
    const refused = await call(env, u, "PUT", path(u.workspaceId, "openai_geo"), { model: "gpt-unpriced-test" });
    expect(refused.status).toBe(400);
    expect(refused.json!.error).toMatchObject({ message: "Add your own API key to use a model without a verified price.", details: { field: "model", reason: "operator_key_unpriced" } });
    expect(refused.text).not.toContain("gpt-unpriced-test");
    expect(await u.db.all("SELECT * FROM workspace_provider_models WHERE workspace_id = ?", u.workspaceId)).toHaveLength(0);
    // The operator configured this unpriced model itself: choosing it changes nothing about who pays.
    expect((await call(env, u, "PUT", path(u.workspaceId, "openai_geo"), { model: "gpt-operator-unpriced" })).status).toBe(200);
    // With the workspace's own key any valid id may be chosen; its cost is unknown, never guessed.
    await saveKey(env, u.db, u.workspaceId, "openai_geo");
    const byo = await call(env, u, "PUT", path(u.workspaceId, "openai_geo"), { model: "gpt-unpriced-test" });
    expect(byo.status).toBe(200);
    expect(byo.json!.data).toMatchObject({ source: "workspace_key", model: "gpt-unpriced-test", state: "ready", rateKnown: false, modelNote: null });
    // No key at all: the choice is stored (the guard applies when a key exists).
    const env2 = createTestEnv();
    const u2 = await seedUser(env2);
    expect((await call(env2, u2, "PUT", path(u2.workspaceId, "anthropic_geo"), { model: "claude-unpriced-x" })).status).toBe(200);
  });

  it("TypeSafe: a model selection is refused for every key source (400 model_not_selectable); nothing is stored", async () => {
    const env = createTestEnv({ TYPESAFE_API_KEY: OP_KEY, TYPESAFE_MODEL: "jev-operator-pin" });
    const u = await seedUser(env);
    const expectRefused = async (body: unknown) => {
      const r = await call(env, u, "PUT", path(u.workspaceId, "typesafe"), body);
      expect(r.status).toBe(400);
      expect(r.json!.error).toMatchObject({ message: TYPESAFE_MODEL_NOT_SELECTABLE, details: { field: "provider", reason: "model_not_selectable" } });
      expect(r.text).not.toContain("jev-1.13.0");
    };
    // Operator key: even the operator's own model or the documented alias.
    await expectRefused({ model: "jev-1.13.0" });
    await expectRefused({ model: "jev-operator-pin" });
    await expectRefused({ model: "jev-latest" });
    await expectRefused({ model: null });
    // The workspace's own key: still refused.
    await saveKey(env, u.db, u.workspaceId, "typesafe");
    await expectRefused({ model: "jev-1.13.0" });
    // No key at all: refused too.
    const env2 = createTestEnv();
    const u2 = await seedUser(env2);
    const none = await call(env2, u2, "PUT", path(u2.workspaceId, "typesafe"), { model: "jev-1.13.0" });
    expect(none.status).toBe(400);
    expect(none.json!.error!.details).toMatchObject({ reason: "model_not_selectable" });
    expect(await u.db.all("SELECT * FROM workspace_provider_models WHERE workspace_id IN (?, ?)", u.workspaceId, u2.workspaceId)).toHaveLength(0);
    // The card keeps reporting the operator's model, as before the picker existed.
    const ts = ((await call(env, u, "GET", `/workspaces/${u.workspaceId}/credentials`)).json!.data as ProviderStatus[]).find((p) => p.provider === "typesafe")!;
    expect(ts).toMatchObject({ source: "workspace_key", model: "jev-operator-pin", modelSource: "operator", workspaceModel: null, modelNote: null, state: "ready" });
    // Only owners reach the check (a member still gets 403, a stranger 404).
    const member = await seedUser(env);
    await member.db.insert("memberships", { workspace_id: u.workspaceId, user_id: member.userId, role: "member", created_at: FIXED_NOW.toISOString() });
    expect((await call(env, member, "PUT", path(u.workspaceId, "typesafe"), { model: "jev-1.13.0" })).status).toBe(403);
    const stranger = await seedUser(env);
    expect((await call(env, stranger, "PUT", path(u.workspaceId, "typesafe"), { model: "jev-1.13.0" })).status).toBe(404);
  });

  it("no env model and no selection is setup_required (choose a model); choosing one makes the engine ready", async () => {
    const env = createTestEnv({ ANTHROPIC_GEO_API_KEY: OP_KEY });
    const u = await seedUser(env);
    const before = ((await call(env, u, "GET", `/workspaces/${u.workspaceId}/credentials`)).json!.data as ProviderStatus[]).find((p) => p.provider === "anthropic_geo")!;
    expect(before).toMatchObject({ model: null, modelSource: null, state: "setup_required" });
    expect((await capabilityPresence(env, u.db, u.workspaceId)).anthropic_geo).toBe(false);
    await call(env, u, "PUT", path(u.workspaceId, "anthropic_geo"), { model: "claude-opus-5" });
    expect((await capabilityPresence(env, u.db, u.workspaceId)).anthropic_geo).toBe(true);
  });

  it("invalid ids are refused naming the field, never echoing the value; owner only; tenant-scoped", async () => {
    const env = createTestEnv();
    const owner = await seedUser(env);
    const other = await seedUser(env);
    const bad = await call(env, owner, "PUT", path(owner.workspaceId, "perplexity"), { model: "no-prefix<script>" });
    expect(bad.status).toBe(400);
    expect(bad.json!.error!.details).toMatchObject({ field: "model" });
    expect(bad.text).not.toContain("<script>");
    expect((await call(env, owner, "PUT", path(owner.workspaceId, "perplexity"), { model: "x", extra: 1 })).status).toBe(400);
    expect((await call(env, owner, "PUT", path(owner.workspaceId, "writer"), { model: "x" })).status).toBe(404);
    expect((await call(env, other, "PUT", path(owner.workspaceId, "perplexity"), { model: "perplexity/sonar" })).status).toBe(404);
    await call(env, owner, "PUT", path(owner.workspaceId, "perplexity"), { model: "perplexity/sonar" });
    // The other workspace never sees it.
    const theirs = ((await call(env, other, "GET", `/workspaces/${other.workspaceId}/credentials`)).json!.data as ProviderStatus[]).find((p) => p.provider === "perplexity")!;
    expect(theirs.model).toBeNull();
  });
});

// ------------------------------------------------------------------ runtime uses the selected model
async function geoRun(env: Env, db: Db, workspaceId: string, pid: string, key = "k") {
  const { runId } = await createRun(db, { workspaceId, projectId: pid, agent: "geo", trigger: "manual", idempotencyKey: key, createdBy: null, now: FIXED_NOW });
  return runId;
}

const selectModel = (db: Db, workspaceId: string, provider: string, model: string) =>
  db.insert("workspace_provider_models", { workspace_id: workspaceId, provider, model, updated_at: "t" });

const DECISION_QUESTIONS = { relevance: { type: "noul" as const, instructions: "Is `query` a good match for `page`?" } };
/** Fake TypeSafe systemOne endpoint that echoes the requested model. */
const typesafeHandler: Handler = (url, init) => {
  if (url === "https://api.typesafe.ai/v1/systemone") {
    const body = JSON.parse(String(init?.body)) as { model: string };
    return Response.json({ model: body.model, answers: { relevance: { type: "noul", noul: 0.7 } }, usage: { input_tokens: 10, output_tokens: 1 } });
  }
  return Response.json(listFor(url));
};
const sentModel = () => JSON.parse(seen.filter((x) => x.url === "https://api.typesafe.ai/v1/systemone").at(-1)!.body!).model as string;

describe("runtime uses the workspace's model", () => {
  it("builds each engine with the selected model (workspace > env) and none without a model", async () => {
    const env = createTestEnv({ GEMINI_API_KEY: OP_KEY, GEMINI_MODEL: "gemini-env-model", OPENAI_GEO_API_KEY: OP_KEY, ANTHROPIC_GEO_API_KEY: OP_KEY, TYPESAFE_API_KEY: OP_KEY });
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    await selectModel(u.db, u.workspaceId, "openai_geo", "gpt-5.5");
    await selectModel(u.db, u.workspaceId, "gemini", "gemini-3.8-flash");
    const ctx = await buildRunContext(env, await geoRun(env, u.db, u.workspaceId, pid), { fetchImpl: fakeFetch(), clock: () => FIXED_NOW });
    const byId = Object.fromEntries(ctx.geoProviders.map((p) => [p.id, p.model]));
    expect(byId).toEqual({ gemini: "gemini-3.8-flash", openai_geo: "gpt-5.5" }); // anthropic_geo: key but no model -> no lane
  });

  it("every engine sends the workspace's model; TypeSafe ignores a stored selection even on the workspace's own key", async () => {
    const env = createTestEnv({ PERPLEXITY_API_KEY: OP_KEY, ANTHROPIC_GEO_API_KEY: OP_KEY, PERPLEXITY_MODEL: "perplexity/other-env" });
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    await saveKey(env, u.db, u.workspaceId, "typesafe");
    await selectModel(u.db, u.workspaceId, "typesafe", "jev-1.13.0");
    await selectModel(u.db, u.workspaceId, "perplexity", "perplexity/sonar");
    await selectModel(u.db, u.workspaceId, "anthropic_geo", "claude-opus-5");
    handler = typesafeHandler;
    const ctx = await buildRunContext(env, await geoRun(env, u.db, u.workspaceId, pid), { fetchImpl: fakeFetch(), clock: () => FIXED_NOW });
    expect(Object.fromEntries(ctx.geoProviders.map((p) => [p.id, p.model]))).toEqual({ perplexity: "perplexity/sonar", anthropic_geo: "claude-opus-5" });
    // A TypeSafe row stored while the picker briefly existed is harmless: the documented alias is used.
    const r = await ctx.decisions!.decide({ purpose: "test", state: { query: "q", page: { title: "t" } }, questions: DECISION_QUESTIONS });
    expect(r.model).toBe("jev-latest");
    expect(sentModel()).toBe("jev-latest");
    const d = await buildDecisionsForWorkspace(env, u.db, u.workspaceId, pid, { fetchImpl: fakeFetch(), clock: () => FIXED_NOW });
    await d!.decide({ purpose: "test", state: "s", questions: DECISION_QUESTIONS });
    expect(sentModel()).toBe("jev-latest");
    expect(seen.find((x) => x.url === "https://api.typesafe.ai/v1/systemone")!.headers.authorization).toBe(`Bearer ${KEY}`);
    // With TYPESAFE_MODEL set, that model runs (workspace key, stored selection still ignored).
    const env2 = createTestEnv({ TYPESAFE_MODEL: "jev-operator-pin" });
    const d2 = await buildDecisionsForWorkspace(env2, u.db, u.workspaceId, pid, { fetchImpl: fakeFetch(), clock: () => FIXED_NOW });
    await d2!.decide({ purpose: "test", state: "s", questions: DECISION_QUESTIONS });
    expect(sentModel()).toBe("jev-operator-pin");
    // The stored row is left in place (harmless): never loaded, and the card does not report it.
    expect(await loadWorkspaceModels(u.db, u.workspaceId)).toEqual({ perplexity: "perplexity/sonar", anthropic_geo: "claude-opus-5" });
    expect(await u.db.all("SELECT model FROM workspace_provider_models WHERE workspace_id = ? AND provider = 'typesafe'", u.workspaceId)).toEqual([{ model: "jev-1.13.0" }]);
    const ts = ((await call(env, u, "GET", `/workspaces/${u.workspaceId}/credentials`)).json!.data as ProviderStatus[]).find((p) => p.provider === "typesafe")!;
    expect(ts).toMatchObject({ source: "workspace_key", model: "jev-latest", modelSource: "default", workspaceModel: null, modelNote: null });
  });

  it("TypeSafe on the operator key also ignores a stored selection (TYPESAFE_MODEL, else jev-latest)", async () => {
    const env = createTestEnv({ TYPESAFE_API_KEY: OP_KEY });
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    await selectModel(u.db, u.workspaceId, "typesafe", "jev-1.13.0");
    handler = typesafeHandler;
    const ctx = await buildRunContext(env, await geoRun(env, u.db, u.workspaceId, pid), { fetchImpl: fakeFetch() });
    await ctx.decisions!.decide({ purpose: "test", state: "s", questions: DECISION_QUESTIONS });
    expect(sentModel()).toBe("jev-latest");
    const env2 = createTestEnv({ TYPESAFE_API_KEY: OP_KEY, TYPESAFE_MODEL: "jev-operator-pin" });
    const u2 = await seedUser(env2);
    const pid2 = await seedProject(env2, u2.workspaceId);
    await selectModel(u2.db, u2.workspaceId, "typesafe", "jev-1.13.0");
    const d = await buildDecisionsForWorkspace(env2, u2.db, u2.workspaceId, pid2, { fetchImpl: fakeFetch() });
    await d!.decide({ purpose: "test", state: "s", questions: DECISION_QUESTIONS });
    expect(sentModel()).toBe("jev-operator-pin");
    // The card shows the operator's model and no selection, exactly as before the picker existed.
    const ts = ((await call(env2, u2, "GET", `/workspaces/${u2.workspaceId}/credentials`)).json!.data as ProviderStatus[]).find((p) => p.provider === "typesafe")!;
    expect(ts).toMatchObject({ source: "operator_key", model: "jev-operator-pin", modelSource: "operator", workspaceModel: null, modelNote: null, state: "ready" });
  });

  it("operator key + a workspace model without a verified price: no lane, a run event, setup_required everywhere; a BYO key builds the lane", async () => {
    const env = createTestEnv({ OPENAI_GEO_API_KEY: OP_KEY, GEMINI_API_KEY: OP_KEY });
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    // Stored before the guard existed (or while a BYO key was saved): the PUT route would refuse it now.
    await selectModel(u.db, u.workspaceId, "openai_geo", "gpt-unpriced-test");
    await selectModel(u.db, u.workspaceId, "gemini", "gemini-3.8-flash");
    const message = "OpenAI model gpt-unpriced-test has no verified price and this workspace uses the operator key; add your own OpenAI key to use it.";
    const runId = await geoRun(env, u.db, u.workspaceId, pid);
    const ctx = await buildRunContext(env, runId, { fetchImpl: fakeFetch(), clock: () => FIXED_NOW });
    expect(ctx.geoProviders.map((p) => p.id)).toEqual(["gemini"]);
    const ev = await u.db.all<{ step: string; status: string; message: string }>("SELECT step, status, message FROM run_events WHERE run_id = ?", runId);
    expect(ev).toContainEqual({ step: "runtime", status: "info", message });
    // Integrations card, presence and the board agree with the runtime.
    const card = ((await call(env, u, "GET", `/workspaces/${u.workspaceId}/credentials`)).json!.data as ProviderStatus[]).find((p) => p.provider === "openai_geo")!;
    expect(card).toMatchObject({ source: "operator_key", model: "gpt-unpriced-test", modelSource: "workspace", state: "setup_required", rateKnown: false, modelNote: message });
    const presence = await capabilityPresence(env, u.db, u.workspaceId, FIXED_NOW);
    expect(presence).toMatchObject({ openai_geo: false, gemini: true, modelBlocked: { openai_geo: message } });
    const board = (await call(env, u, "GET", `/projects/${pid}/geo/board`)).json!.data as EngineBoardResponse;
    expect(board.lanes.find((l) => l.provider === "openai_geo")).toMatchObject({ state: "setup_required", stateDetail: message });

    // The workspace's own key: the same model runs (cost unknown, recorded as null).
    await saveKey(env, u.db, u.workspaceId, "openai_geo");
    const ctx2 = await buildRunContext(env, await geoRun(env, u.db, u.workspaceId, pid, "k2"), { fetchImpl: fakeFetch(), clock: () => FIXED_NOW });
    expect(Object.fromEntries(ctx2.geoProviders.map((p) => [p.id, p.model]))).toEqual({ gemini: "gemini-3.8-flash", openai_geo: "gpt-unpriced-test" });
    const byo = ((await call(env, u, "GET", `/workspaces/${u.workspaceId}/credentials`)).json!.data as ProviderStatus[]).find((p) => p.provider === "openai_geo")!;
    expect(byo).toMatchObject({ source: "workspace_key", state: "ready", modelNote: null });
    expect((await capabilityPresence(env, u.db, u.workspaceId, FIXED_NOW)).modelBlocked).toEqual({});
  });

  it("modelForKeySource: the guard in one place", () => {
    const env = { GEMINI_MODEL: "gemini-env-unpriced" };
    expect(modelForKeySource(env, { gemini: "gemini-unpriced-x" }, "gemini", "workspace_key", FIXED_NOW)).toMatchObject({ model: "gemini-unpriced-x", blocked: null });
    expect(modelForKeySource(env, { gemini: "gemini-unpriced-x" }, "gemini", null, FIXED_NOW).blocked).toBeNull();
    expect(modelForKeySource(env, { gemini: "gemini-unpriced-x" }, "gemini", "operator_key", FIXED_NOW).blocked).toMatch(/^Gemini model gemini-unpriced-x has no verified price/);
    expect(modelForKeySource(env, { gemini: "gemini-3.8-flash" }, "gemini", "operator_key", FIXED_NOW).blocked).toBeNull();
    expect(modelForKeySource(env, { gemini: "gemini-env-unpriced" }, "gemini", "operator_key", FIXED_NOW).blocked).toBeNull(); // the operator's own choice
    expect(modelForKeySource(env, {}, "gemini", "operator_key", FIXED_NOW)).toMatchObject({ model: "gemini-env-unpriced", source: "operator", blocked: null });
    for (const keySource of ["operator_key", "workspace_key", null] as const) {
      expect(modelForKeySource({}, { typesafe: "jev-1.13.0" }, "typesafe", keySource)).toEqual({ model: "jev-latest", source: "default", blocked: null });
    }
    expect(operatorKeyModelRefusal({}, "perplexity", "perplexity/sonar")).toBeNull();
    expect(operatorKeyModelRefusal({}, "perplexity", "perplexity/sonar-pro")).toMatchObject({ reason: "operator_key_unpriced" });
  });
});

// ------------------------------------------------------------------ custom GEO engines
const BASE = "https://llm.example.com/v1";
const CUSTOM_KEY = "sk-or-v1-CUSTOMGEOKEY-0123456789abcdefWXYZ";

async function addGeo(env: Env, u: { workspaceId: string; sessionToken: string; csrfToken: string }, over: Record<string, unknown> = {}) {
  return call(env, u, "POST", `/workspaces/${u.workspaceId}/custom-providers`, { baseUrl: BASE, apiKey: CUSTOM_KEY, model: "meta/llama-3.3-70b", role: "geo", ...over });
}

describe("custom GEO engines (role geo)", () => {
  it("adds up to 2 per workspace, separate from writers; never selected as writer", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const a = await addGeo(env, u);
    expect(a.status).toBe(201);
    const data = a.json!.data as CustomProvidersResponse;
    expect(data.providers[0]).toMatchObject({ role: "geo", isWriter: false, host: "llm.example.com", keyHint: "WXYZ" });
    expect(data.writerSource).toBe("default");
    expect(data.maxGeoEngines).toBe(2);
    expect(data.geoDataSent).toMatch(/no tools/);
    expect((await addGeo(env, u, { label: "Second" })).status).toBe(201);
    const third = await addGeo(env, u, { label: "Third" });
    expect(third.status).toBe(409);
    expect(third.json!.error!.message).toMatch(/at most 2 custom GEO engines/);
    // Writers keep their own cap.
    expect((await call(env, u, "POST", `/workspaces/${u.workspaceId}/custom-providers`, { baseUrl: BASE, apiKey: CUSTOM_KEY, model: "w" })).status).toBe(201);
    const geoId = data.providers[0]!.id;
    const sel = await call(env, u, "PUT", `/workspaces/${u.workspaceId}/writer-source`, { source: `custom:${geoId}` });
    expect(sel.status).toBe(400);
    expect(sel.json!.error!.details).toMatchObject({ field: "source", reason: "not_writer" });
    expect(JSON.stringify(bodies)).not.toContain(CUSTOM_KEY);
  });

  it("runs as an ungrounded lane: own host-only fetch, no tools, cost unknown, no usd reservation, mention rate only", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    const geo = (await addGeo(env, u)).json!.data as CustomProvidersResponse;
    const rowId = geo.providers[0]!.id;
    // An approved prompt.
    await u.db.insert("geo_prompt_sets", { id: "gps_1", workspace_id: u.workspaceId, project_id: pid, version: 1, active: 1, created_at: FIXED_NOW.toISOString() });
    await u.db.insert("geo_prompts", { id: "gp_1", workspace_id: u.workspaceId, project_id: pid, prompt_set_id: "gps_1", text: "Best brass cabinet knobs?", prompt_type: "discovery", stage: null, locale: "en-US", language: "en", approved: 1, position: 0 });
    handler = (url) => {
      if (url === `${BASE}/chat/completions`) {
        return Response.json({
          id: "chatcmpl-1",
          model: "meta/llama-3.3-70b",
          choices: [{ message: { content: "Residence Example sells solid brass knobs (see https://shop.example.com/knobs)." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 20, completion_tokens: 15 },
        });
      }
      return new Response("unexpected", { status: 500 });
    };
    const runId = await geoRun(env, u.db, u.workspaceId, pid);
    const ctx = await buildRunContext(env, runId, { fetchImpl: fakeFetch() });
    const lane = ctx.geoProviders.find((p) => isCustomGeoId(p.id))!;
    expect(lane).toMatchObject({ id: `custom_geo:${rowId}`, model: "meta/llama-3.3-70b", groundingMode: CUSTOM_GEO_GROUNDING_MODE });
    expect(lane.label).toBe(customGeoLaneLabel("llm.example.com", "llm.example.com"));
    expect(lane.label).toContain(CUSTOM_GEO_NOTE);
    // The shared provider fetch does not admit the custom host (only the lane's own fetch does).
    await expect(ctx.apiFetch(`${BASE}/chat/completions`)).rejects.toBeInstanceOf(OutboundBlockedError);

    const r = await runGeoBatch(ctx);
    expect(r).toMatchObject({ observations: 1, failed: 0, grounded: 0 });
    const req = seen.find((s) => s.url === `${BASE}/chat/completions`)!;
    expect(req.method).toBe("POST");
    expect(req.headers.authorization).toBe(`Bearer ${CUSTOM_KEY}`);
    const sent = JSON.parse(req.body!);
    expect(sent.tools).toBeUndefined();
    expect(sent.model).toBe("meta/llama-3.3-70b");
    expect(JSON.stringify(sent)).not.toContain("Residence Example"); // brand-blind

    const obs = await u.db.first<Record<string, unknown>>("SELECT * FROM geo_observations WHERE workspace_id = ? AND project_id = ?", u.workspaceId, pid);
    expect(obs).toMatchObject({ provider: `custom_geo:${rowId}`, grounded: 0, grounding_mode: "none (custom provider)", cost_usd: null, status: "ok" });
    expect(await u.db.all("SELECT * FROM geo_citations WHERE observation_id = ?", obs!.id)).toHaveLength(0);
    const self = await u.db.first<{ mentioned: number; cited: number }>("SELECT mentioned, cited FROM geo_brand_observations WHERE observation_id = ? AND is_self = 1", obs!.id);
    expect(self).toEqual({ mentioned: 1, cited: 0 });
    const calls = await u.db.all<{ provider: string; cost_usd: number | null }>("SELECT provider, cost_usd FROM provider_calls WHERE run_id = ?", runId);
    expect(calls).toEqual([{ provider: `custom_geo:${rowId}`, cost_usd: null }]);
    const resv = await u.db.all<{ resource: string; scope_key: string }>("SELECT resource, scope_key FROM usage_reservations WHERE run_id = ? ORDER BY resource", runId);
    expect(resv.map((x) => x.resource)).toEqual(["geo_prompts", "provider_calls"]); // no usd_micros; no global (operator) rows
    expect(resv.every((x) => x.scope_key.startsWith("project:"))).toBe(true);

    // Results: the custom lane counts toward mention rate; its citation rate is unavailable.
    const results = (await call(env, u, "GET", `/projects/${pid}/geo/results`)).json!.data as GeoResults;
    const cl = results.lanes.find((l) => l.provider === `custom_geo:${rowId}`)!;
    expect(cl.label).toContain(CUSTOM_GEO_NOTE);
    expect(cl.state).toBe("ready");
    expect(cl.mentionRate).toEqual({ numerator: 1, denominator: 1, value: 1 });
    expect(cl.citationRate).toEqual({ numerator: 0, denominator: 0, value: null });
    expect(results.labels.join(" ")).toContain("mention rate and share of voice only");

    // Board: an extra lane after the four built-ins, labelled; citation rate unavailable.
    const board = (await call(env, u, "GET", `/projects/${pid}/geo/board`)).json!.data as EngineBoardResponse;
    expect(board.lanes.map((l) => l.provider)).toEqual(["openai_geo", "anthropic_geo", "gemini", "perplexity", `custom_geo:${rowId}`]);
    const bl = board.lanes[4]!;
    expect(bl).toMatchObject({ state: "ready", answersCitingUs: 0, model: "meta/llama-3.3-70b" });
    expect(bl.label).toContain(CUSTOM_GEO_NOTE);
    expect(bl.citationRate.value).toBeNull();
    expect(bl.mentionRate.numerator).toBe(1);
    expect(bl.costUsd).toEqual({ value: null, isEstimate: true });
    expect(board.labels.join(" ")).toContain("count toward mention rate only");

    // Activity window: the lane and its answer carry the label.
    const project = (await u.db.first<ProjectRow>("SELECT * FROM projects WHERE id = ?", pid))!;
    const activity = (await buildRunActivity(u.db, project, runId, { now: FIXED_NOW }))!;
    expect(activity.lanes.map((l) => [l.provider, l.label])).toEqual([[`custom_geo:${rowId}`, lane.label]]);
    const answer = activity.items.find((i) => i.kind === "engine_answer")!;
    expect(answer.title).toMatch(/^Custom engine answered/);
    expect(answer.detail).toContain(CUSTOM_GEO_NOTE);
  });

  it("an unusable custom GEO engine is skipped with a run note, never faked", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    await u.db.insert("workspace_custom_providers", {
      id: "cprov_bad",
      workspace_id: u.workspaceId,
      role: "geo",
      label: "x",
      base_url: BASE,
      host: "llm.example.com",
      model: "m",
      key_enc: "v1.not.decryptable",
      key_hint: "abcd",
      is_writer: 0,
      created_at: "t",
      updated_at: "t",
    });
    const runId = await geoRun(env, u.db, u.workspaceId, pid);
    const ctx = await buildRunContext(env, runId, { fetchImpl: fakeFetch() });
    expect(ctx.geoProviders).toHaveLength(0);
    const ev = await u.db.all<{ message: string }>("SELECT message FROM run_events WHERE run_id = ?", runId);
    expect(ev.map((e) => e.message).join(" ")).toMatch(/custom GEO engine llm\.example\.com cannot be used/);
  });

  it("budget attribution: a custom lane is the tenant's own key (no global operator caps)", async () => {
    const env = createTestEnv({ GLOBAL_PROVIDER_CALLS_PER_DAY: "0", GEMINI_API_KEY: OP_KEY });
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    const budget = createBudget(new Db(env.DB), env, { workspaceId: u.workspaceId, projectId: pid, runId: null }, () => FIXED_NOW);
    // The operator-key provider hits the (zero) global cap; the custom lane does not.
    await expect(budgetFor(budget, "gemini").reserve("provider_calls", 1)).rejects.toThrow();
    await expect(budgetFor(budget, "custom_geo:cprov_x").reserve("provider_calls", 1)).resolves.toBeTypeOf("string");
  });
});

describe("custom GEO adapter and metrics", () => {
  it("parses Chat Completions answers: length -> incomplete, empty -> failed", () => {
    expect(parseCustomGeoResponse({ choices: [{ message: { content: "Hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2 } })).toMatchObject({ status: "ok", text: "Hi", usage: { inputTokens: 1, outputTokens: 2 } });
    expect(parseCustomGeoResponse({ choices: [{ message: { content: "Hi" }, finish_reason: "length" }] }).status).toBe("incomplete");
    expect(parseCustomGeoResponse({ choices: [{ message: { content: "" } }] }).status).toBe("failed");
    expect(parseCustomGeoResponse({}).status).toBe("failed");
  });

  it("HTTP errors are stored by status only (the provider body and key are never stored)", async () => {
    const p = createCustomGeoProvider({
      id: "custom_geo:c1",
      label: "x",
      model: "m",
      baseUrl: BASE,
      apiKey: CUSTOM_KEY,
      fetchImpl: (async () => new Response(`{"error":"bad ${CUSTOM_KEY}"}`, { status: 401 })) as typeof fetch,
    });
    const a = await p.ask("q", { locale: "en-US", language: "en" });
    expect(a).toMatchObject({ status: "failed", outcome: "rejected", error: "Custom provider returned HTTP 401.", grounded: false, costUsd: null, citations: [] });
    expect(JSON.stringify(a)).not.toContain(CUSTOM_KEY);
  });

  it("records the configured model and a bounded request id, whatever the host reports", async () => {
    const hostile = { id: "r".repeat(50_000), model: `${"x".repeat(100_000)}\u0000`, choices: [{ message: { content: "Answer" }, finish_reason: "stop" }] };
    const p = createCustomGeoProvider({ id: "custom_geo:c1", label: "x", model: "meta/llama-3.3-70b", baseUrl: BASE, apiKey: CUSTOM_KEY, fetchImpl: (async () => Response.json(hostile)) as typeof fetch });
    const a = await p.ask("q", { locale: "en-US", language: "en" });
    expect(a).toMatchObject({ status: "ok", model: "meta/llama-3.3-70b", requestId: null, text: "Answer" });
    // A router that reports another (or a varying) model still lands in the configured model's cohort.
    const routed = createCustomGeoProvider({
      id: "custom_geo:c1",
      label: "x",
      model: "meta/llama-3.3-70b",
      baseUrl: BASE,
      apiKey: CUSTOM_KEY,
      fetchImpl: (async () => Response.json({ id: "chatcmpl-ok", model: "router/other", choices: [{ message: { content: "A" }, finish_reason: "stop" }] })) as typeof fetch,
    });
    expect(await routed.ask("q", { locale: "en-US", language: "en" })).toMatchObject({ model: "meta/llama-3.3-70b", requestId: "chatcmpl-ok" });
    expect(parseCustomGeoResponse({ id: "a\u0001b", model: "m".repeat(201), choices: [{ message: { content: "x" }, finish_reason: "s".repeat(300) }] })).toMatchObject({ requestId: null, model: null, finishReason: null });
  });

  it("stored observations, calls and cohort use the configured model even when the host varies it", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    await addGeo(env, u);
    await u.db.insert("geo_prompt_sets", { id: "gps_1", workspace_id: u.workspaceId, project_id: pid, version: 1, active: 1, created_at: FIXED_NOW.toISOString() });
    for (const [i, text] of ["Best brass knobs?", "Where to buy brass pulls?", "Brass vs steel hardware?"].entries()) {
      await u.db.insert("geo_prompts", { id: `gp_${i}`, workspace_id: u.workspaceId, project_id: pid, prompt_set_id: "gps_1", text, prompt_type: "discovery", stage: null, locale: "en-US", language: "en", approved: 1, position: i });
    }
    let n = 0;
    handler = () => {
      n++;
      if (n === 2) return new Response("overloaded", { status: 503 }); // a failed answer uses the configured id too
      return Response.json({ id: `x${"y".repeat(10_000)}`, model: n === 1 ? "x".repeat(10_000) : "router/other", choices: [{ message: { content: "Some answer." }, finish_reason: "stop" }] });
    };
    const runId = await geoRun(env, u.db, u.workspaceId, pid);
    await runGeoBatch(await buildRunContext(env, runId, { fetchImpl: fakeFetch() }));
    const obs = await u.db.all<{ model: string; cohort_key: string; request_id: string | null; status: string }>("SELECT model, cohort_key, request_id, status FROM geo_observations WHERE run_id = ?", runId);
    expect(obs).toHaveLength(3);
    expect(obs.map((o) => o.status).sort()).toEqual(["failed", "ok", "ok"]);
    expect(new Set(obs.map((o) => o.model))).toEqual(new Set(["meta/llama-3.3-70b"]));
    expect(new Set(obs.map((o) => o.cohort_key)).size).toBe(1);
    expect(obs.every((o) => o.request_id === null)).toBe(true);
    const calls = await u.db.all<{ model: string; request_id: string | null }>("SELECT model, request_id FROM provider_calls WHERE run_id = ?", runId);
    expect(calls.every((c) => c.model === "meta/llama-3.3-70b" && c.request_id === null)).toBe(true);
  });

  it("metrics: an ungrounded observation that cites the brand still never enters citation rate", () => {
    const o = (id: string, grounded: boolean, cited: boolean): MetricObservation => ({
      id,
      cohortKey: "c",
      provider: "custom_geo:c1",
      promptId: id,
      promptType: "discovery",
      measurementType: "api",
      status: "ok",
      grounded,
      runId: "r",
      createdAt: "t",
      brands: [{ brandKey: "self", isSelf: true, mentioned: true, cited }],
    });
    const obs = [o("a", false, true), o("b", false, false)];
    expect(citationRate(obs)).toEqual({ numerator: 0, denominator: 0, value: null });
    expect(mentionRate(obs)).toEqual({ numerator: 2, denominator: 2, value: 1 });
  });
});

describe("custom GEO lanes never create GEO proposals", () => {
  async function scenario(providers: [string, string]) {
    const env = createTestEnv();
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    const project = { id: pid, workspaceId: u.workspaceId };
    const ctx = makeTestContext(env, project);
    const prompts = ["Where can I buy solid brass cabinet hardware?", "Best brass knobs for a kitchen"];
    const { promptIds } = await seedPromptSet(env, project, prompts);
    // Same displacing entity (Brass Co) in every answer: 2 prompts x 2 lanes meets the recurring minimum.
    for (const [i, prompt] of prompts.entries()) {
      for (const provider of providers) {
        const id = await seedObservation(env, project, { ...fixture("competitor_only"), prompt, grounded: false, citations: [] }, { provider, model: "m-1", promptId: promptIds[i]!, createdAt: new Date(FIXED_NOW.getTime() - 3600_000).toISOString() });
        await analyzeObservation(ctx, id);
      }
    }
    const disps = await u.db.all<{ entity: string }>("SELECT entity FROM geo_displacements WHERE project_id = ?", pid);
    const summary = await generateGeoProposals(ctx);
    const recs = await u.db.all<{ issue_type: string; limitations: string; trigger: string }>("SELECT issue_type, limitations, trigger FROM recommendations WHERE project_id = ?", pid);
    return { disps, summary, recs };
  }

  it("built-in lanes with a recurring displacing entity propose; the same answers from two custom lanes do not", async () => {
    const builtIn = await scenario(["gemini", "perplexity"]);
    expect(builtIn.disps.length).toBeGreaterThanOrEqual(4);
    expect(builtIn.recs.some((r) => r.issue_type === "geo_displacement")).toBe(true);

    const custom = await scenario(["custom_geo:cprov_a", "custom_geo:cprov_b"]);
    expect(custom.disps.length).toBeGreaterThanOrEqual(4); // analysed (mention rate), but never a proposal input
    expect(custom.summary.candidates).toBe(0);
    expect(custom.recs).toEqual([]);
    expect(JSON.stringify(custom.recs)).not.toContain("custom_geo:");
  });
});

// ------------------------------------------------------------------ storage
describe("migration 0011 and export", () => {
  it("creates workspace_provider_models (provider CHECK, cascade) and the role column (default writer)", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const cols = await u.db.all<{ name: string }>("SELECT name FROM pragma_table_info('workspace_provider_models')");
    expect(cols.map((c) => c.name)).toEqual(["workspace_id", "provider", "model", "updated_by", "updated_at"]);
    await u.db.insert("workspace_provider_models", { workspace_id: u.workspaceId, provider: "gemini", model: "g", updated_at: "t" });
    await expect(u.db.insert("workspace_provider_models", { workspace_id: u.workspaceId, provider: "writer", model: "w", updated_at: "t" })).rejects.toThrow(/CHECK/);
    await expect(u.db.insert("workspace_provider_models", { workspace_id: u.workspaceId, provider: "gemini", model: "g2", updated_at: "t" })).rejects.toThrow(/UNIQUE|PRIMARY/);
    await expect(u.db.insert("workspace_provider_models", { workspace_id: "ws_missing", provider: "gemini", model: "g", updated_at: "t" })).rejects.toThrow(/FOREIGN KEY/);
    const row = { workspace_id: u.workspaceId, label: "x", base_url: BASE, host: "llm.example.com", model: "m", key_enc: "v1.a.b", key_hint: "abcd", created_at: "t", updated_at: "t" };
    await u.db.insert("workspace_custom_providers", { id: "c1", ...row });
    expect(await u.db.first("SELECT role FROM workspace_custom_providers WHERE id = 'c1'")).toEqual({ role: "writer" });
    await expect(u.db.insert("workspace_custom_providers", { id: "c2", ...row, role: "other" })).rejects.toThrow(/CHECK/);
    await u.db.run("DELETE FROM workspaces WHERE id = ?", u.workspaceId);
    expect(await u.db.all("SELECT * FROM workspace_provider_models")).toHaveLength(0);
  });

  it("export includes model selections and custom GEO engines without key material", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    await call(env, u, "PUT", `/workspaces/${u.workspaceId}/credentials/openai_geo/model`, { model: "gpt-5.5" });
    await addGeo(env, u);
    const out = await exportProject(u.db, u.workspaceId, pid, FIXED_NOW);
    expect(out.tables.workspace_provider_models).toEqual([{ provider: "openai_geo", model: "gpt-5.5", updated_at: expect.any(String) }]);
    expect(out.tables.workspace_custom_providers).toHaveLength(1);
    expect(out.tables.workspace_custom_providers![0]).toMatchObject({ role: "geo", host: "llm.example.com" });
    const json = JSON.stringify(out);
    expect(json).not.toContain("key_enc");
    expect(json).not.toContain("key_hint");
    expect(json).not.toContain(CUSTOM_KEY);
    expect(json).not.toContain("WXYZ");
  });
});
