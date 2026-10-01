/**
 * Wiring of the OpenAI / Anthropic GEO lanes: runtime registration (key AND model), outbound allowlist,
 * credential resolution and budget attribution, capability presence, credentials routes, and runGeoBatch
 * running all four lanes with the same reservations. No network: every fetch is a fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@worker/geo/analyze", () => ({ analyzeObservation: vi.fn(async () => undefined) }));

import { createApp } from "@worker/app";
import type { Env } from "@worker/env";
import { Db } from "@worker/lib/db";
import { newId } from "@worker/lib/ids";
import { credentialSources, resolveProviderKey } from "@worker/platform/credentials";
import { setCredentialTestFetch } from "@worker/routes/credentials";
import { runGeoBatch } from "@worker/geo/batch";
import { createOpenAiGeoProvider } from "@worker/providers/openai-geo";
import { createAnthropicGeoProvider } from "@worker/providers/anthropic-geo";
import { reservationMicros } from "@worker/providers/rates";
import type { GeoProvider } from "@worker/providers/types";
import { budgetFor, createBudget, dailyLimit, DEFAULT_PROJECT_LIMITS, MAX_GEO_PROVIDERS, spendsOperatorKey, GLOBAL_SCOPE_KEY } from "@worker/runs/budget";
import type { Budget, BudgetResource } from "@worker/runs/context";
import { API_HOST_ALLOWLIST, buildRunContext, capabilityPresence, createApiFetch } from "@worker/runs/runtime";
import { createRun } from "@worker/runs/runs-service";
import type { IntegrationsStatus } from "@shared/types";
import { createTestEnv } from "./helpers/env";
import { authHeaders, FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";
import { makeTestContext } from "./helpers/context";

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function newRun(env: Env) {
  const u = await seedUser(env);
  const pid = await seedProject(env, u.workspaceId);
  const db = new Db(env.DB);
  const { runId } = await createRun(db, { workspaceId: u.workspaceId, projectId: pid, agent: "geo", trigger: "manual", idempotencyKey: newId("k"), createdBy: null, now: FIXED_NOW });
  return { db, runId, workspaceId: u.workspaceId, projectId: pid };
}

describe("runtime registration", () => {
  it("api.openai.com is allowlisted; other hosts still are not", async () => {
    expect(API_HOST_ALLOWLIST).toContain("api.openai.com");
    expect(API_HOST_ALLOWLIST).toContain("api.anthropic.com");
    const seen: string[] = [];
    const api = createApiFetch({}, (async (i: RequestInfo | URL) => {
      seen.push(String(i));
      return jsonResponse({});
    }) as typeof fetch);
    await api("https://api.openai.com/v1/responses", { method: "POST" });
    await expect(api("https://chatgpt.com/")).rejects.toThrow(/not an allowlisted/);
    expect(seen).toEqual(["https://api.openai.com/v1/responses"]);
  });

  it("registers each new lane only when both an operator key and a model are configured", async () => {
    const env = createTestEnv();
    const { runId } = await newRun(env);
    const f = (async () => jsonResponse({})) as typeof fetch;

    const none = await buildRunContext(env, runId, { fetchImpl: f });
    expect(none.geoProviders).toEqual([]);

    const keyOnly = await buildRunContext({ ...env, OPENAI_GEO_API_KEY: "sk-o", ANTHROPIC_GEO_API_KEY: "sk-a" }, runId, { fetchImpl: f });
    expect(keyOnly.geoProviders).toEqual([]);

    const modelOnly = await buildRunContext({ ...env, OPENAI_GEO_MODEL: "gpt-4.1", ANTHROPIC_GEO_MODEL: "claude-sonnet-5-5" }, runId, { fetchImpl: f });
    expect(modelOnly.geoProviders).toEqual([]);

    // Writer keys never stand in for the GEO lanes.
    const writerOnly = await buildRunContext({ ...env, WRITER_API_KEY: "w", WRITER_PROVIDER: "anthropic", WRITER_MODEL: "m", OPENAI_GEO_MODEL: "gpt-4.1", ANTHROPIC_GEO_MODEL: "claude-sonnet-5-5" }, runId, { fetchImpl: f });
    expect(writerOnly.geoProviders).toEqual([]);

    const all = await buildRunContext(
      { ...env, GEMINI_API_KEY: "g", GEMINI_MODEL: "gemini-3.8-flash", PERPLEXITY_API_KEY: "p", PERPLEXITY_MODEL: "perplexity/sonar", OPENAI_GEO_API_KEY: "sk-o", OPENAI_GEO_MODEL: " gpt-4.1 ", ANTHROPIC_GEO_API_KEY: "sk-a", ANTHROPIC_GEO_MODEL: "claude-sonnet-5-5" },
      runId,
      { fetchImpl: f },
    );
    expect(all.geoProviders.map((p) => [p.id, p.model])).toEqual([
      ["gemini", "gemini-3.8-flash"],
      ["perplexity", "perplexity/sonar"],
      ["openai_geo", "gpt-4.1"],
      ["anthropic_geo", "claude-sonnet-5-5"],
    ]);
  });

  it("registered lanes call their provider through ctx.apiFetch", async () => {
    const env = { ...createTestEnv(), OPENAI_GEO_API_KEY: "sk-o", OPENAI_GEO_MODEL: "gpt-4.1" };
    const { runId } = await newRun(env);
    const urls: string[] = [];
    const f = (async (i: RequestInfo | URL) => {
      urls.push(String(i));
      return jsonResponse({ id: "r", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }], usage: { input_tokens: 1, output_tokens: 1 } });
    }) as typeof fetch;
    const ctx = await buildRunContext(env, runId, { fetchImpl: f });
    const a = await ctx.geoProviders[0]!.ask("q", { locale: "en-US", language: "en" });
    expect(a.status).toBe("ok");
    expect(urls).toEqual(["https://api.openai.com/v1/responses"]);
  });

  it("capabilityPresence reports the new lanes from key + model", async () => {
    const env = createTestEnv({ OPENAI_GEO_API_KEY: "k", OPENAI_GEO_MODEL: "gpt-4.1", ANTHROPIC_GEO_API_KEY: "k" });
    const { db, workspaceId } = await newRun(env);
    const caps = await capabilityPresence(env, db, workspaceId);
    expect(caps.openai_geo).toBe(true);
    expect(caps.anthropic_geo).toBe(false); // no ANTHROPIC_GEO_MODEL
  });
});

describe("credentials and budget attribution", () => {
  it("resolves the operator keys and reports sources for the new ids", async () => {
    const env = createTestEnv({ OPENAI_GEO_API_KEY: " sk-op ", WRITER_API_KEY: "w" });
    const { db, workspaceId } = await newRun(env);
    expect(await resolveProviderKey(env, db, workspaceId, "openai_geo")).toEqual({ key: "sk-op", source: "operator_key" });
    expect(await resolveProviderKey(env, db, workspaceId, "anthropic_geo")).toBeNull();
    const src = await credentialSources(env, db, workspaceId);
    expect(src).toMatchObject({ openai_geo: "operator_key", anthropic_geo: null, writer: "operator_key" });
  });

  it("usd_micros on an operator GEO key counts against the global cap; a keyless lane does not", () => {
    expect(spendsOperatorKey("usd_micros", "openai_geo", { openai_geo: "operator_key" })).toBe(true);
    expect(spendsOperatorKey("usd_micros", "anthropic_geo", { anthropic_geo: "workspace_key" })).toBe(false);
    // Unnamed provider: any GEO engine on the operator key makes usd_micros global.
    expect(spendsOperatorKey("usd_micros", null, { gemini: "workspace_key", anthropic_geo: "operator_key" })).toBe(true);
    // Missing entries are treated as "no key", not as a key.
    expect(spendsOperatorKey("provider_calls", null, { writer: "workspace_key" })).toBe(false);
  });

  it("budgetFor(ctx.budget, 'openai_geo') reserves on the global counter when the operator key is used", async () => {
    const env = createTestEnv({ OPENAI_GEO_API_KEY: "op" });
    const { db, workspaceId, projectId } = await newRun(env);
    await db.run("UPDATE project_limits SET usd_micros_per_day = 100000000, provider_calls_per_day = 1000 WHERE project_id = ?", projectId);
    const budget = createBudget(db, env, { workspaceId, projectId, runId: null }, () => FIXED_NOW);
    const id = await budgetFor(budget, "openai_geo").reserve("usd_micros", 1234);
    const global = await db.first<{ used: number }>("SELECT used FROM usage_counters WHERE scope_key = ? AND resource = 'usd_micros'", GLOBAL_SCOPE_KEY);
    expect(global?.used).toBe(1234);
    await budget.settle(id, 1000);
    expect((await db.first<{ used: number }>("SELECT used FROM usage_counters WHERE scope_key = ? AND resource = 'usd_micros'", GLOBAL_SCOPE_KEY))?.used).toBe(1000);

    // No key for anthropic_geo -> the named-provider reservation is project-only for provider_calls.
    await budgetFor(budget, "anthropic_geo").reserve("provider_calls", 1);
    expect(await db.first("SELECT used FROM usage_counters WHERE scope_key = ? AND resource = 'provider_calls'", GLOBAL_SCOPE_KEY)).toBeNull();
  });

  it("the daily geo_prompts ceiling covers four engine lanes", () => {
    expect(MAX_GEO_PROVIDERS).toBe(4);
    expect(dailyLimit("geo_prompts", DEFAULT_PROJECT_LIMITS)).toBe(DEFAULT_PROJECT_LIMITS.geo_prompts_per_run * 4 * 4);
  });
});

// ------------------------------------------------------------------ credentials routes

const app = createApp();
type ProviderStatus = IntegrationsStatus["providers"][number];
const testCalls: Array<{ url: string; headers: Record<string, string> }> = [];

beforeEach(() => {
  testCalls.length = 0;
  setCredentialTestFetch(async (input, init) => {
    testCalls.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    return new Response("{}", { status: 200 });
  });
});
afterEach(() => setCredentialTestFetch(null));

async function call(env: Env, u: Awaited<ReturnType<typeof seedUser>>, method: string, path: string, body?: unknown) {
  const res = await app.request(path, { method, headers: authHeaders(u.sessionToken, u.csrfToken), body: body === undefined ? undefined : JSON.stringify(body) }, env);
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as { data?: any; error?: { code: string; message: string } }) : null, text };
}

describe("credentials routes for the new lanes", () => {
  it("lists openai_geo and anthropic_geo with model, source, state and disclosure; never the key", async () => {
    const env = createTestEnv({ OPENAI_GEO_API_KEY: "sk-operator-openai-geo-999", OPENAI_GEO_MODEL: "gpt-4.1", ANTHROPIC_GEO_MODEL: "claude-sonnet-5-5" });
    const u = await seedUser(env);
    const r = await call(env, u, "GET", `/api/workspaces/${u.workspaceId}/credentials`);
    expect(r.status).toBe(200);
    const list = r.json!.data as ProviderStatus[];
    const oai = list.find((p) => p.provider === "openai_geo")!;
    expect(oai).toMatchObject({ source: "operator_key", state: "ready", model: "gpt-4.1", keyHint: null });
    expect(oai.label).toContain("OpenAI");
    expect(oai.dataSent).toContain("prompt");
    const ant = list.find((p) => p.provider === "anthropic_geo")!;
    expect(ant).toMatchObject({ source: "none", state: "setup_required", model: "claude-sonnet-5-5" });
    expect(r.text).not.toContain("sk-operator-openai-geo");
  });

  it("an invalid model id keeps the lane setup_required", async () => {
    const env = createTestEnv({ OPENAI_GEO_API_KEY: "k-operator-1234", OPENAI_GEO_MODEL: "gpt 4.1/../x" });
    const u = await seedUser(env);
    const r = await call(env, u, "GET", `/api/workspaces/${u.workspaceId}/credentials`);
    expect((r.json!.data as ProviderStatus[]).find((p) => p.provider === "openai_geo")!.state).toBe("setup_required");
  });

  it("tests a typed key with a free model-list request (key only in headers)", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const o = await call(env, u, "POST", `/api/workspaces/${u.workspaceId}/credentials/openai_geo/test`, { apiKey: "sk-typed-openai-000111" });
    expect(o.status).toBe(200);
    expect(o.json!.data.ok).toBe(true);
    const a = await call(env, u, "POST", `/api/workspaces/${u.workspaceId}/credentials/anthropic_geo/test`, { apiKey: "sk-ant-typed-000222" });
    expect(a.json!.data.ok).toBe(true);
    expect(testCalls.map((c) => c.url)).toEqual(["https://api.openai.com/v1/models", "https://api.anthropic.com/v1/models"]);
    expect(testCalls[0]!.headers.authorization).toBe("Bearer sk-typed-openai-000111");
    expect(testCalls[1]!.headers["x-api-key"]).toBe("sk-ant-typed-000222");
    for (const c of testCalls) expect(c.url).not.toContain("sk-");
  });

  it("saving a workspace key reports setup_required while the provider_credentials CHECK predates the new ids", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const r = await call(env, u, "PUT", `/api/workspaces/${u.workspaceId}/credentials/openai_geo`, { apiKey: "sk-workspace-openai-geo-1" });
    // Either the migration is applied (200) or the save is refused with an explicit setup message.
    if (r.status === 200) {
      expect(r.json!.data).toMatchObject({ provider: "openai_geo", source: "workspace_key" });
    } else {
      expect(r.json!.error!.code).toBe("setup_required");
      expect(r.json!.error!.message).toContain("OPENAI_GEO_API_KEY");
    }
    expect(r.text).not.toContain("sk-workspace-openai-geo-1");
  });

  it("unknown provider ids are still 404", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const r = await call(env, u, "POST", `/api/workspaces/${u.workspaceId}/credentials/openai/test`, { apiKey: "sk-12345678" });
    expect(r.status).toBe(404);
  });
});

// ------------------------------------------------------------------ batch with four lanes

type Resv = { resource: BudgetResource; amount: number; state: string; settled?: number; provider: string };
function attributedBudget(): Budget & { list: Resv[] } {
  const list: Resv[] = [];
  const mk = (provider: string): Budget => ({
    async reserve(resource, amount) {
      list.push({ resource, amount, state: "reserved", provider });
      return String(list.length - 1);
    },
    async settle(id, amount) { Object.assign(list[Number(id)]!, { state: "settled", settled: amount }); },
    async release(id) { list[Number(id)]!.state = "released"; },
    async markUnknown(id) { list[Number(id)]!.state = "unknown"; },
  });
  return Object.assign(mk("(base)"), { list });
}

function fakeLane(id: string, model: string): GeoProvider {
  return {
    id,
    label: `${id} fake`,
    model,
    groundingMode: "fake",
    async ask() {
      return {
        provider: id, model, groundingMode: "fake", status: "ok", grounded: true, text: "t",
        citations: [{ url: "https://brassco.example/", title: null, position: 1 }], searchQueries: ["q"], requestId: `${id}-r`,
        usage: { inputTokens: 1, outputTokens: 1, searchRequests: 1 }, costUsd: 0.001, costIsEstimate: true, rateVersion: "t", error: null, latencyMs: 1,
        outcome: "ok", searchQueriesExposed: true,
      } as Awaited<ReturnType<GeoProvider["ask"]>>;
    },
    async test() { return { ok: true, detail: "" }; },
  };
}

async function seedPrompts(db: Db, workspaceId: string, projectId: string, n: number) {
  const setId = newId("gps");
  await db.insert("geo_prompt_sets", { id: setId, workspace_id: workspaceId, project_id: projectId, version: 1, active: 1, created_at: FIXED_NOW.toISOString() });
  for (let i = 0; i < n; i++) {
    await db.insert("geo_prompts", { id: newId("gp"), workspace_id: workspaceId, project_id: projectId, prompt_set_id: setId, text: `P${i}`, prompt_type: "discovery", stage: null, locale: "en-US", language: "en", approved: 1, position: i });
  }
}

describe("runGeoBatch with the new lanes", () => {
  it("runs openai_geo and anthropic_geo alongside gemini and perplexity with the same three reservations each", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    const db = new Db(env.DB);
    await seedPrompts(db, u.workspaceId, pid, 2);
    const budget = attributedBudget();
    const lanes = [fakeLane("gemini", "gemini-3.8-flash"), fakeLane("perplexity", "perplexity/sonar"), fakeLane("openai_geo", "gpt-4.1"), fakeLane("anthropic_geo", "claude-sonnet-5-5")];
    const ctx = makeTestContext(env, { id: pid, workspaceId: u.workspaceId }, { geoProviders: lanes, budget });
    const r = await runGeoBatch(ctx);
    expect(r).toMatchObject({ status: "completed", observations: 8, failed: 0, providers: ["gemini", "perplexity", "openai_geo", "anthropic_geo"] });
    for (const lane of lanes) {
      const usd = budget.list.filter((x) => x.resource === "usd_micros" && x.amount === reservationMicros(lane.id, lane.model, FIXED_NOW));
      expect(usd.length).toBeGreaterThanOrEqual(2);
    }
    expect(budget.list.filter((x) => x.resource === "geo_prompts")).toHaveLength(8);
    expect(budget.list.filter((x) => x.resource === "provider_calls")).toHaveLength(8);
    expect(budget.list.every((x) => x.state === "settled")).toBe(true);
    const rows = await db.all<{ provider: string; n: number }>("SELECT provider, COUNT(*) AS n FROM geo_observations WHERE workspace_id = ? AND project_id = ? GROUP BY provider ORDER BY provider", u.workspaceId, pid);
    expect(rows).toEqual([
      { provider: "anthropic_geo", n: 2 },
      { provider: "gemini", n: 2 },
      { provider: "openai_geo", n: 2 },
      { provider: "perplexity", n: 2 },
    ]);
  });

  it("persists real adapter answers: OpenAI url_citation citations and queries, Anthropic grounding mode and cohort", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    const db = new Db(env.DB);
    await seedPrompts(db, u.workspaceId, pid, 1);
    const openai = createOpenAiGeoProvider({
      apiKey: "sk-o",
      model: "gpt-4.1",
      now: () => FIXED_NOW,
      fetchImpl: (async () =>
        jsonResponse({
          id: "resp_1",
          model: "gpt-4.1",
          status: "completed",
          output: [
            { type: "web_search_call", id: "ws", status: "completed", action: { type: "search", queries: ["Brass  Pulls"] } },
            { type: "message", content: [{ type: "output_text", text: "Brass Co.", annotations: [{ type: "url_citation", url: "https://www.brassco.example/p", title: "Brass Co", start_index: 0, end_index: 8 }] }] },
          ],
          usage: { input_tokens: 100, output_tokens: 10 },
        })) as typeof fetch,
    });
    const anthropic = createAnthropicGeoProvider({
      apiKey: "sk-a",
      model: "claude-sonnet-5-5",
      now: () => FIXED_NOW,
      fetchImpl: (async () => jsonResponse({ id: "m", model: "claude-sonnet-5-5", stop_reason: "end_turn", content: [{ type: "text", text: "No search." }], usage: { input_tokens: 5, output_tokens: 5 } })) as typeof fetch,
    });
    const ctx = makeTestContext(env, { id: pid, workspaceId: u.workspaceId }, { geoProviders: [openai, anthropic] });
    const r = await runGeoBatch(ctx);
    expect(r).toMatchObject({ observations: 2, grounded: 1, failed: 0 });

    const o = await db.first<Record<string, any>>("SELECT * FROM geo_observations WHERE provider = 'openai_geo' AND workspace_id = ?", u.workspaceId);
    expect(o).toMatchObject({ model: "gpt-4.1", grounding_mode: "openai_web_search", grounded: 1, status: "ok", request_id: "resp_1", cost_is_estimate: 1 });
    expect(o!.cost_usd).toBeCloseTo((100 * 2 + 10 * 8) / 1e6 + 0.01, 10);
    const cites = await db.all<{ url: string; host: string; position: number }>("SELECT url, host, position FROM geo_citations WHERE observation_id = ?", o!.id);
    expect(cites).toEqual([{ url: "https://www.brassco.example/p", host: "brassco.example", position: 1 }]);
    const qs = await db.all<{ normalized: string; provider: string }>("SELECT normalized, provider FROM geo_search_queries WHERE observation_id = ?", o!.id);
    expect(qs).toEqual([{ normalized: "brass pulls", provider: "openai_geo" }]);

    const a = await db.first<Record<string, any>>("SELECT * FROM geo_observations WHERE provider = 'anthropic_geo' AND workspace_id = ?", u.workspaceId);
    expect(a).toMatchObject({ grounded: 0, status: "ok", grounding_mode: "anthropic_web_search" });
    expect(a!.cohort_key).not.toBe(o!.cohort_key);
    expect(JSON.parse(a!.usage_json)).toMatchObject({ searchQueriesExposed: true, samplingOptions: { tools: ["web_search_20250305"], maxUses: 3 } });

    expect(ctx.recordedCalls.map((c) => [c.provider, c.status, c.costIsEstimate])).toEqual(
      expect.arrayContaining([
        ["openai_geo", "ok", true],
        ["anthropic_geo", "ok", true],
      ]),
    );
  });

  it("setup_required note names the new lanes when nothing is configured", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    const r = await runGeoBatch(makeTestContext(env, { id: pid, workspaceId: u.workspaceId }, { geoProviders: [] }));
    expect(r.status).toBe("setup_required");
    expect(r.note).toContain("OPENAI_GEO_MODEL");
    expect(r.note).toContain("ANTHROPIC_GEO_MODEL");
  });
});
