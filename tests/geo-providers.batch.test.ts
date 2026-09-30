/**
 * geo-providers: runGeoBatch against the D1 shim. analyzeObservation (geo-analysis module) is mocked.
 * No network: providers are fakes or real adapters with injected fetch fakes and CONSTRUCTED fixtures.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@worker/geo/analyze", () => ({ analyzeObservation: vi.fn(async () => undefined) }));

import { analyzeObservation } from "@worker/geo/analyze";
import { runGeoBatch, RAW_ANSWER_MAX_CHARS } from "@worker/geo/batch";
import { cohortKey } from "@worker/geo/cohort";
import { createGeminiProvider } from "@worker/providers/gemini";
import { createPerplexityProvider } from "@worker/providers/perplexity";
import { reservationMicros, UNKNOWN_RATE_RESERVE_USD_MICROS, type GeoAnswerWithOutcome, type GeoCallOutcome } from "@worker/providers/rates";
import type { GeoProvider } from "@worker/providers/types";
import type { Budget, BudgetResource } from "@worker/runs/context";
import { BudgetExceededError } from "@worker/lib/errors";
import { Db } from "@worker/lib/db";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";
import { makeTestContext } from "./helpers/context";

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(process.cwd(), "tests/fixtures/geo", name), "utf8"));
const jsonFetch = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as typeof fetch;

// ------------------------------------------------------------------ helpers

type Resv = { resource: BudgetResource; amount: number; state: "reserved" | "settled" | "released" | "unknown"; settled?: number };
function recordingBudget(failWhen?: (resource: BudgetResource, index: number) => boolean): Budget & { list: Resv[] } {
  const list: Resv[] = [];
  let n = 0;
  return {
    list,
    async reserve(resource, amount) {
      if (failWhen?.(resource, n++)) throw new BudgetExceededError(resource, `${resource} limit reached`);
      list.push({ resource, amount, state: "reserved" });
      return String(list.length - 1);
    },
    async settle(id, amount) { Object.assign(list[Number(id)]!, { state: "settled", settled: amount }); },
    async release(id) { list[Number(id)]!.state = "released"; },
    async markUnknown(id) { list[Number(id)]!.state = "unknown"; },
  };
}

type Step = Partial<GeoAnswerWithOutcome> | Error;
function fakeProvider(id: string, steps: Step[] = [], seen: string[] = []): GeoProvider {
  let i = 0;
  return {
    id,
    label: `${id} fake`,
    model: `${id}-model-x`,
    groundingMode: "fake_search",
    async ask(prompt) {
      seen.push(prompt);
      const step = steps[i++] ?? {};
      if (step instanceof Error) throw step;
      const answer: GeoAnswerWithOutcome = {
        provider: id,
        model: `${id}-model-x`,
        groundingMode: "fake_search",
        status: "ok",
        grounded: true,
        text: `answer to ${prompt}`,
        citations: [{ url: "https://brassco.example/p", title: "Brass Co", position: 1 }],
        searchQueries: ["Some  Query "],
        searchQueriesExposed: true,
        requestId: `req-${id}-${i}`,
        usage: { inputTokens: 10, outputTokens: 20, searchRequests: 1 },
        costUsd: 0.002,
        costIsEstimate: true,
        rateVersion: "test",
        error: null,
        latencyMs: 5,
        outcome: "ok",
        ...step,
      };
      return answer;
    },
    async test() { return { ok: true, detail: "fake" }; },
  };
}

async function seedPromptSet(db: Db, workspaceId: string, projectId: string, version: number, active: boolean, prompts: Array<{ text: string; approved: boolean; position: number; type?: string }>) {
  const setId = `gps_${version}_${Math.random().toString(36).slice(2, 8)}`;
  await db.insert("geo_prompt_sets", { id: setId, workspace_id: workspaceId, project_id: projectId, version, active: active ? 1 : 0, created_at: FIXED_NOW.toISOString() });
  for (const p of prompts) {
    await db.insert("geo_prompts", {
      id: `gp_${Math.random().toString(36).slice(2, 10)}`,
      workspace_id: workspaceId,
      project_id: projectId,
      prompt_set_id: setId,
      text: p.text,
      prompt_type: p.type ?? "discovery",
      stage: null,
      locale: "en-US",
      language: "en",
      approved: p.approved ? 1 : 0,
      position: p.position,
    });
  }
  return setId;
}

async function setup(prompts: Array<{ text: string; approved: boolean; position: number; type?: string }> = [{ text: "P1", approved: true, position: 1 }]) {
  const env = createTestEnv();
  const u = await seedUser(env);
  const projectId = await seedProject(env, u.workspaceId);
  const db = new Db(env.DB);
  const setId = await seedPromptSet(db, u.workspaceId, projectId, 1, true, prompts);
  return { env, db, workspaceId: u.workspaceId, projectId, setId };
}

beforeEach(() => {
  vi.mocked(analyzeObservation).mockReset();
  vi.mocked(analyzeObservation).mockResolvedValue(undefined as never);
});

// ------------------------------------------------------------------ tests

describe("runGeoBatch setup states", () => {
  it("setup_required when no GEO provider is configured", async () => {
    const s = await setup();
    const ctx = makeTestContext(s.env, { id: s.projectId, workspaceId: s.workspaceId }, { geoProviders: [] });
    const r = await runGeoBatch(ctx);
    expect(r.status).toBe("setup_required");
    expect(r.observations).toBe(0);
  });

  it("setup_required 'Approve at least one prompt' when nothing is approved", async () => {
    const s = await setup([{ text: "P1", approved: false, position: 1 }]);
    const seen: string[] = [];
    const ctx = makeTestContext(s.env, { id: s.projectId, workspaceId: s.workspaceId }, { geoProviders: [fakeProvider("gemini", [], seen)] });
    const r = await runGeoBatch(ctx);
    expect(r).toMatchObject({ status: "setup_required", note: "Approve at least one prompt" });
    expect(seen).toEqual([]);
  });
});

describe("runGeoBatch execution", () => {
  it("runs only approved prompts of the latest active set, in order, capped by geo_prompts_per_run", async () => {
    const s = await setup([
      { text: "unapproved", approved: false, position: 0 },
      { text: "A", approved: true, position: 1 },
      { text: "C", approved: true, position: 3 },
      { text: "B", approved: true, position: 2 },
    ]);
    await seedPromptSet(s.db, s.workspaceId, s.projectId, 5, false, [{ text: "inactive newer set", approved: true, position: 1 }]);
    await s.db.run("UPDATE project_limits SET geo_prompts_per_run = 2 WHERE project_id = ?", s.projectId);
    const seen: string[] = [];
    const ctx = makeTestContext(s.env, { id: s.projectId, workspaceId: s.workspaceId }, { geoProviders: [fakeProvider("gemini", [], seen)] });
    const r = await runGeoBatch(ctx);
    expect(seen).toEqual(["A", "B"]);
    expect(r).toMatchObject({ status: "completed", observations: 2, failed: 0, grounded: 2, providers: ["gemini"] });
  });

  it("persists a grounded Gemini observation with citations, normalized queries, cohort key, call record, settled budget", async () => {
    const s = await setup([{ text: "best brass pulls?", approved: true, position: 1, type: "discovery" }]);
    const gemini = createGeminiProvider({ apiKey: "k-secret", model: "gemini-3.8-flash", fetchImpl: jsonFetch(fixture("gemini-grounded.json")), now: () => FIXED_NOW });
    const budget = recordingBudget();
    const ctx = makeTestContext(s.env, { id: s.projectId, workspaceId: s.workspaceId }, { geoProviders: [gemini], budget, runId: null });
    const r = await runGeoBatch(ctx);
    expect(r).toMatchObject({ status: "completed", observations: 1, grounded: 1, failed: 0 });

    const obs = await s.db.first<Record<string, unknown>>("SELECT * FROM geo_observations WHERE project_id = ?", s.projectId);
    expect(obs).toMatchObject({
      workspace_id: s.workspaceId,
      prompt_set_id: s.setId,
      prompt_text: "best brass pulls?",
      prompt_type: "discovery",
      provider: "gemini",
      model: "gemini-3.8-flash",
      grounding_mode: "google_search",
      measurement_type: "api",
      status: "ok",
      grounded: 1,
      request_id: "resp-gemini-grounded-001",
      cost_is_estimate: 1,
    });
    expect(obs!.cohort_key).toBe(await cohortKey({ promptSetVersion: 1, provider: "gemini", model: "gemini-3.8-flash", groundingMode: "google_search", samplingOptions: { maxOutputTokens: 4096 } }));
    const usage = JSON.parse(String(obs!.usage_json));
    expect(usage).toMatchObject({ inputTokens: 21, outputTokens: 300, searchRequests: 2, searchQueriesExposed: true, outcome: "ok", finishReason: "STOP" });

    const cites = await s.db.all<Record<string, unknown>>("SELECT url, host, title, position, source_type, source_type_method, brand_key FROM geo_citations WHERE observation_id = ? ORDER BY position", obs!.id);
    expect(cites).toEqual([
      { url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbCdEf123", host: "brassco.example", title: "brassco.example", position: 1, source_type: "other", source_type_method: "unknown", brand_key: null },
      { url: "https://www.designroundup.example/best-cabinet-pulls", host: "designroundup.example", title: "The 12 best cabinet pulls of 2026", position: 2, source_type: "other", source_type_method: "unknown", brand_key: null },
    ]);
    const qs = await s.db.all<{ query: string; normalized: string; provider: string; model: string }>("SELECT query, normalized, provider, model FROM geo_search_queries WHERE observation_id = ? ORDER BY normalized", obs!.id);
    expect(qs).toEqual([
      { query: "best solid brass cabinet pulls", normalized: "best solid brass cabinet pulls", provider: "gemini", model: "gemini-3.8-flash" },
      { query: "solid brass   cabinet hardware brands", normalized: "solid brass cabinet hardware brands", provider: "gemini", model: "gemini-3.8-flash" },
    ]);

    expect(ctx.recordedCalls).toHaveLength(1);
    expect(ctx.recordedCalls[0]).toMatchObject({ provider: "gemini", model: "gemini-3.8-flash", purpose: "geo_answer", status: "ok", requestId: "resp-gemini-grounded-001", costIsEstimate: true });
    expect(JSON.stringify(ctx.recordedCalls)).not.toContain("k-secret");

    const micros = Math.ceil((obs!.cost_usd as number) * 1e6 - 1e-6);
    expect(budget.list).toEqual([
      { resource: "geo_prompts", amount: 1, state: "settled", settled: 1 },
      { resource: "provider_calls", amount: 1, state: "settled", settled: 1 },
      { resource: "usd_micros", amount: reservationMicros("gemini", "gemini-3.8-flash", FIXED_NOW), state: "settled", settled: micros },
    ]);
    expect(analyzeObservation).toHaveBeenCalledWith(ctx, obs!.id);
  });

  it("stores no search queries when the provider does not expose them ('not exposed')", async () => {
    const s = await setup();
    const pplx = createPerplexityProvider({ apiKey: "k", model: "perplexity/sonar", fetchImpl: jsonFetch(fixture("perplexity-legacy-citations.json")) });
    const ctx = makeTestContext(s.env, { id: s.projectId, workspaceId: s.workspaceId }, { geoProviders: [pplx] });
    const r = await runGeoBatch(ctx);
    expect(r).toMatchObject({ observations: 1, grounded: 0 });
    const obs = await s.db.first<Record<string, unknown>>("SELECT * FROM geo_observations WHERE project_id = ?", s.projectId);
    expect(obs!.grounded).toBe(0);
    expect(obs!.cost_usd).toBeNull();
    expect(JSON.parse(String(obs!.usage_json)).searchQueriesExposed).toBe(false);
    expect(await s.db.all("SELECT * FROM geo_search_queries WHERE observation_id = ?", obs!.id)).toEqual([]);
    expect(await s.db.all("SELECT * FROM geo_citations WHERE observation_id = ?", obs!.id)).toEqual([]);
    expect(ctx.recordedCalls[0]!.costUsd).toBeNull();
  });

  it("budget transitions: ok(unknown cost) settles full, rejected settles 0, timeout/5xx/throw keep reserved, not_sent releases", async () => {
    const prompts = ["ok", "rejected", "timeout", "server", "notsent", "throws"].map((t, i) => ({ text: t, approved: true, position: i }));
    const s = await setup(prompts);
    await s.db.run("UPDATE project_limits SET geo_prompts_per_run = 10 WHERE project_id = ?", s.projectId);
    const failed = (outcome: GeoCallOutcome): Partial<GeoAnswerWithOutcome> => ({ status: "failed", outcome, grounded: false, text: null, citations: [], searchQueries: null, searchQueriesExposed: false, costUsd: null, error: `x ${outcome}` });
    const provider = fakeProvider("fakeprov", [{ costUsd: null }, failed("rejected"), failed("timeout"), failed("server_error"), failed("not_sent"), new Error("boom")]);
    const budget = recordingBudget();
    const ctx = makeTestContext(s.env, { id: s.projectId, workspaceId: s.workspaceId }, { geoProviders: [provider], budget });
    const r = await runGeoBatch(ctx);
    expect(r).toMatchObject({ observations: 6, failed: 5, status: "completed" });

    const byCall = (k: number) => budget.list.slice(k * 3, k * 3 + 3).map((x) => `${x.state}:${x.settled ?? "-"}`);
    expect(budget.list[2]!.amount).toBe(UNKNOWN_RATE_RESERVE_USD_MICROS);
    expect(byCall(0)).toEqual(["settled:1", "settled:1", `settled:${UNKNOWN_RATE_RESERVE_USD_MICROS}`]);
    expect(byCall(1)).toEqual(["settled:1", "settled:1", "settled:0"]);
    expect(byCall(2)).toEqual(["unknown:-", "unknown:-", "unknown:-"]);
    expect(byCall(3)).toEqual(["unknown:-", "unknown:-", "unknown:-"]);
    expect(byCall(4)).toEqual(["released:-", "released:-", "released:-"]);
    expect(byCall(5)).toEqual(["unknown:-", "unknown:-", "unknown:-"]);

    // not_sent is not a provider call; the others are recorded with null cost when unknown
    expect(ctx.recordedCalls.map((c) => c.status)).toEqual(["ok", "error", "timeout", "error", "unknown"]);
    expect(ctx.recordedCalls.every((c) => c.costUsd === null)).toBe(true);
  });

  it("a failed provider call is stored as a failed observation and never replaced by another provider", async () => {
    const s = await setup();
    const failing = fakeProvider("gemini", [{ status: "failed", outcome: "rejected", grounded: true, text: "should not be stored", citations: [{ url: "https://x.example", title: null, position: 1 }], searchQueries: ["q"], costUsd: null, error: "Gemini HTTP 429" }]);
    const ok = fakeProvider("perplexity");
    const ctx = makeTestContext(s.env, { id: s.projectId, workspaceId: s.workspaceId }, { geoProviders: [failing, ok] });
    const r = await runGeoBatch(ctx);
    expect(r).toMatchObject({ status: "completed", observations: 2, failed: 1, grounded: 1 });
    const rows = await s.db.all<Record<string, unknown>>("SELECT id, provider, status, grounded, raw_answer, error FROM geo_observations ORDER BY provider");
    expect(rows.map((x) => [x.provider, x.status, x.grounded, x.raw_answer])).toEqual([
      ["gemini", "failed", 0, null],
      ["perplexity", "ok", 1, "answer to P1"],
    ]);
    const failedId = rows[0]!.id;
    expect(await s.db.all("SELECT * FROM geo_citations WHERE observation_id = ?", failedId)).toEqual([]);
    expect(await s.db.all("SELECT * FROM geo_search_queries WHERE observation_id = ?", failedId)).toEqual([]);
  });

  it("all calls failed -> status failed", async () => {
    const s = await setup();
    const ctx = makeTestContext(s.env, { id: s.projectId, workspaceId: s.workspaceId }, { geoProviders: [fakeProvider("gemini", [new Error("down")])] });
    expect((await runGeoBatch(ctx)).status).toBe("failed");
  });

  it("stops on cancellation between calls -> partial", async () => {
    const s = await setup([1, 2, 3].map((n) => ({ text: `P${n}`, approved: true, position: n })));
    const seen: string[] = [];
    let checks = 0;
    const ctx = makeTestContext(s.env, { id: s.projectId, workspaceId: s.workspaceId }, {
      geoProviders: [fakeProvider("gemini", [], seen)],
      isCancelled: async () => ++checks > 1,
    });
    const r = await runGeoBatch(ctx);
    expect(seen).toEqual(["P1"]);
    expect(r).toMatchObject({ status: "partial", observations: 1 });
    expect(r.note).toMatch(/cancel/i);
  });

  it("BudgetExceededError stops the batch -> partial; partial reservations are released", async () => {
    const s = await setup([1, 2, 3].map((n) => ({ text: `P${n}`, approved: true, position: n })));
    const seen: string[] = [];
    // reservation index 4 (0-based) = 2nd call's provider_calls
    const budget = recordingBudget((_r, index) => index === 4);
    const ctx = makeTestContext(s.env, { id: s.projectId, workspaceId: s.workspaceId }, { geoProviders: [fakeProvider("gemini", [], seen)], budget });
    const r = await runGeoBatch(ctx);
    expect(seen).toEqual(["P1"]);
    expect(r).toMatchObject({ status: "partial", observations: 1 });
    expect(r.note).toMatch(/budget/i);
    expect(budget.list.map((x) => `${x.resource}:${x.state}`)).toEqual(["geo_prompts:settled", "provider_calls:settled", "usd_micros:settled", "geo_prompts:released"]);
    expect(ctx.events.some((e) => e.step === "geo_batch:gemini" && e.status === "partial")).toBe(true);
  });

  it("an analysis failure does not drop the observation", async () => {
    const s = await setup();
    vi.mocked(analyzeObservation).mockRejectedValueOnce(new Error("analysis exploded"));
    const ctx = makeTestContext(s.env, { id: s.projectId, workspaceId: s.workspaceId }, { geoProviders: [fakeProvider("gemini")] });
    const r = await runGeoBatch(ctx);
    expect(r).toMatchObject({ status: "completed", observations: 1 });
    expect(await s.db.all("SELECT id FROM geo_observations")).toHaveLength(1);
    expect(ctx.events.some((e) => e.status === "failed" && e.message.includes("analysis exploded"))).toBe(true);
  });

  it("caps raw_answer at 20,000 characters", async () => {
    const s = await setup();
    const long = "x".repeat(RAW_ANSWER_MAX_CHARS + 500);
    const ctx = makeTestContext(s.env, { id: s.projectId, workspaceId: s.workspaceId }, { geoProviders: [fakeProvider("gemini", [{ text: long }])] });
    await runGeoBatch(ctx);
    const obs = await s.db.first<{ raw_answer: string; usage_json: string }>("SELECT raw_answer, usage_json FROM geo_observations");
    expect(obs!.raw_answer.length).toBe(RAW_ANSWER_MAX_CHARS);
    expect(JSON.parse(obs!.usage_json).rawAnswerTruncated).toBe(true);
  });
});
