/**
 * geo-analysis routes (docs/api.md geo rows): prompts, suggestions, results, observation detail,
 * displacements, engine search queries, manual import, and tenancy.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "@worker/app";
import type { Env } from "@worker/env";
import { Db } from "@worker/lib/db";
import { HttpError } from "@worker/lib/errors";
import { newId } from "@worker/lib/ids";
import { analyzeObservation } from "@worker/geo/analyze";
import { GEO_LABELS } from "@worker/geo/results";
import { geoRoutes } from "@worker/routes/geo";
import type { GeoObservationDetail, GeoResults, SearchQuerySummary, DisplacementSummary } from "@shared/types";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";
import { makeTestContext } from "./helpers/context";
import { fixture, seedObservation, seedPromptSet, type FixtureCase, type SeedObservationOptions } from "./fixtures/geo-analysis/seed";

/** Minimal app: geo routes with a fixed signed-in user (session/CSRF middleware belongs to platform-auth). */
function makeApp(env: Env, userId: string) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", new Db(c.env.DB));
    c.set("now", FIXED_NOW);
    c.set("user", { id: userId, email: "u@example.com", name: null });
    c.set("session", null);
    await next();
  });
  app.route("/", geoRoutes);
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as 400);
    throw err;
  });
  return async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
    return { status: res.status, json: (await res.json()) as any };
  };
}

async function setup(envOverrides: Partial<Env> = {}, projectOverrides: Record<string, unknown> = {}) {
  const env = createTestEnv(envOverrides);
  const u = await seedUser(env);
  const projectId = await seedProject(env, u.workspaceId, projectOverrides);
  const project = { id: projectId, workspaceId: u.workspaceId };
  const other = await seedUser(env, { email: "other@example.com", workspaceName: "Other workspace" });
  return { env, u, projectId, project, db: new Db(env.DB), call: makeApp(env, u.userId), callOther: makeApp(env, other.userId) };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function observe(s: Setup, c: FixtureCase, o: SeedObservationOptions = {}): Promise<string> {
  const id = await seedObservation(s.env, s.project, c, o);
  await analyzeObservation(makeTestContext(s.env, s.project), id);
  return id;
}

const GEMINI_ENV: Partial<Env> = { GEMINI_API_KEY: "test-gemini-key", GEMINI_MODEL: "gemini-test-model" };
const HOUR = 3600_000;
const at = (hoursAgo: number) => new Date(FIXED_NOW.getTime() - hoursAgo * HOUR).toISOString();

afterEach(() => {
  vi.unstubAllGlobals();
});

// ------------------------------------------------------------------ prompts
describe("geo routes: prompt sets", () => {
  it("GET with no set returns data null; PUT creates versions; brand-blind violations are a pinned 400", async () => {
    const s = await setup();
    expect(await s.call("GET", `/projects/${s.projectId}/geo/prompts`)).toEqual({ status: 200, json: { data: null } });

    const bad = await s.call("PUT", `/projects/${s.projectId}/geo/prompts`, {
      prompts: [
        { text: "Where can I buy solid brass cabinet hardware?", promptType: "discovery", stage: "specific requirement", approved: true },
        { text: "Is ResEx better than Brass Co?", promptType: "discovery", stage: null, approved: true },
      ],
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe("bad_request");
    expect(bad.json.error.details.violations).toHaveLength(1);
    const v = bad.json.error.details.violations[0];
    expect(v).toMatchObject({ index: 1, text: "Is ResEx better than Brass Co?" });
    expect([...v.matched].sort()).toEqual(["Brass Co", "ResEx"]);
    expect(await s.db.all("SELECT id FROM geo_prompt_sets WHERE project_id = ?", s.projectId)).toHaveLength(0);

    // The same text is allowed as a separately labelled reputation prompt.
    const ok = await s.call("PUT", `/projects/${s.projectId}/geo/prompts`, {
      prompts: [
        { text: "Where can I buy solid brass cabinet hardware?", promptType: "discovery", stage: "specific requirement", approved: true },
        { text: "Is ResEx better than Brass Co?", promptType: "reputation", stage: null, approved: false },
      ],
    });
    expect(ok.status).toBe(200);
    expect(ok.json.data).toMatchObject({ version: 1 });
    expect(ok.json.data.prompts.map((p: any) => [p.promptType, p.approved, p.position])).toEqual([
      ["discovery", true, 0],
      ["reputation", false, 1],
    ]);

    const second = await s.call("PUT", `/projects/${s.projectId}/geo/prompts`, { prompts: [{ text: "Best brass knobs for a kitchen", promptType: "discovery", stage: null, approved: true }] });
    expect(second.json.data.version).toBe(2);
    const active = await s.db.all<{ version: number; active: number }>("SELECT version, active FROM geo_prompt_sets WHERE project_id = ? ORDER BY version", s.projectId);
    expect(active).toEqual([{ version: 1, active: 0 }, { version: 2, active: 1 }]);
    const got = await s.call("GET", `/projects/${s.projectId}/geo/prompts`);
    expect(got.json.data.prompts.map((p: any) => p.text)).toEqual(["Best brass knobs for a kitchen"]);
  });

  it("PUT rejects invalid bodies", async () => {
    const s = await setup();
    expect((await s.call("PUT", `/projects/${s.projectId}/geo/prompts`, { prompts: [{ text: "x", promptType: "discovery", approved: true }] })).status).toBe(400);
    expect((await s.call("PUT", `/projects/${s.projectId}/geo/prompts`, { prompts: [{ text: "Valid prompt", promptType: "other", approved: true }] })).status).toBe(400);
  });

  it("generate returns 412 setup_required without a writer", async () => {
    const s = await setup();
    const r = await s.call("POST", `/projects/${s.projectId}/geo/prompts/generate`, {});
    expect(r.status).toBe(412);
    expect(r.json.error.code).toBe("setup_required");
  });

  it("generate returns brand-blind, unapproved suggestions from the configured writer and persists nothing", async () => {
    const s = await setup({ WRITER_PROVIDER: "anthropic", WRITER_MODEL: "writer-test-model", WRITER_API_KEY: "test-writer-key" });
    const requests: Array<{ url: string; body: any }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requests.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      const prompts = [
        { prompt: "What size cabinet knobs suit a shaker kitchen?", stage: "problem-aware", rationale: "Sizing question." },
        { prompt: "Is Brass Co hardware worth it?", stage: "solution comparison", rationale: "Names a competitor." },
        { prompt: "How do I care for unlacquered brass pulls?", stage: "care/usage", rationale: "Care question." },
      ];
      return new Response(
        JSON.stringify({ id: "msg_1", model: "writer-test-model", content: [{ type: "text", text: JSON.stringify({ prompts }) }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 20 } }),
        { status: 200, headers: { "content-type": "application/json", "request-id": "req_1" } },
      );
    });
    const r = await s.call("POST", `/projects/${s.projectId}/geo/prompts/generate`, {});
    expect(r.status).toBe(200);
    expect(r.json.data.suggestions).toEqual([
      { text: "What size cabinet knobs suit a shaker kitchen?", stage: "problem-aware", rationale: "Sizing question." },
      { text: "How do I care for unlacquered brass pulls?", stage: "care/usage", rationale: "Care question." },
    ]);
    expect(r.json.data.dropped).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.url).hostname).toBe("api.anthropic.com");
    // The generator input carries product facts only (brand name is not sent to the writer).
    expect(JSON.stringify(requests[0]!.body.messages)).not.toContain("Residence Example");
    expect(await s.db.all("SELECT id FROM geo_prompt_sets WHERE project_id = ?", s.projectId)).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ results
describe("geo routes: results", () => {
  it("setup_required with no approved prompts or providers; zero denominators are null, not zero", async () => {
    const s = await setup();
    const r = await s.call("GET", `/projects/${s.projectId}/geo/results`);
    expect(r.status).toBe(200);
    const data = r.json.data as GeoResults;
    expect(data.state).toBe("setup_required");
    expect(data.lanes).toEqual([]);
    expect(data.promptSetVersion).toBeNull();
    expect(data.shareOfVoice.map((x) => [x.brandKey, x.isSelf, x.ratio])).toEqual([
      ["self", true, { numerator: 0, denominator: 0, value: null }],
      ["Brass Co", false, { numerator: 0, denominator: 0, value: null }],
    ]);
    expect(data.labels).toContain(GEO_LABELS.apiSampled);
    expect(data.labels.some((l) => l.includes("approve at least one prompt"))).toBe(true);

    // Approved prompts but still no provider -> setup_required; a configured lane with no runs has null rates.
    await seedPromptSet(s.env, s.project, ["Where can I buy solid brass cabinet hardware?"]);
    expect(((await s.call("GET", `/projects/${s.projectId}/geo/results`)).json.data as GeoResults).state).toBe("setup_required");
    const s2 = await setup(GEMINI_ENV);
    await seedPromptSet(s2.env, s2.project, ["Where can I buy solid brass cabinet hardware?"]);
    const ready = (await s2.call("GET", `/projects/${s2.projectId}/geo/results`)).json.data as GeoResults;
    expect(ready.state).toBe("ready");
    expect(ready.lanes).toHaveLength(1);
    expect(ready.lanes[0]).toMatchObject({ provider: "gemini", promptsRun: 0, mentionRate: { value: null }, citationRate: { value: null }, searchQueries: { state: "not_exposed", count: 0 } });
    expect(ready.prompts[0]!.perProvider[0]).toMatchObject({ provider: "gemini", status: "not_run", observationId: null, mentioned: null });
  });

  it("lanes use the latest cohort; failed excluded from denominators; ungrounded excluded from citation rate; cohort change annotated", async () => {
    const s = await setup(GEMINI_ENV);
    const { promptIds } = await seedPromptSet(s.env, s.project, [
      "Where can I buy solid brass cabinet hardware?",
      "Best brass knobs for a kitchen",
      { text: "Is Residence Example reliable?", promptType: "reputation" },
    ]);
    const [p0, p1, rep] = promptIds as [string, string, string];
    // Older cohort A: one grounded answer citing our domain.
    await observe(s, fixture("citation_without_mention"), { cohortKey: "A", runId: null, promptId: p0, createdAt: at(72) });
    // Newer cohort B (e.g. new model id): grounded mention without citation, ungrounded mention, a failure, and a reputation answer.
    const mentionGrounded = await observe(s, fixture("mention_without_citation"), { cohortKey: "B", promptId: p0, createdAt: at(3), searchQueries: ["brass sconces bathroom"] });
    await observe(s, fixture("mention"), { cohortKey: "B", promptId: p1, createdAt: at(2) });
    await observe(s, fixture("failed"), { cohortKey: "B", promptId: p1, createdAt: at(4), status: "failed" });
    await observe(s, fixture("injection"), { cohortKey: "B", promptId: rep, promptType: "reputation", createdAt: at(2) });

    const data = (await s.call("GET", `/projects/${s.projectId}/geo/results`)).json.data as GeoResults;
    expect(data.state).toBe("ready");
    const lane = data.lanes.find((l) => l.provider === "gemini")!;
    expect(lane.cohortKey).toBe("B");
    expect(lane.label).toContain("API-sampled");
    expect(lane.model).toBe("gemini-test-model");
    expect(lane.counts).toEqual({ valid: 2, grounded: 1, failed: 1, incomplete: 0 });
    expect(lane.mentionRate).toEqual({ numerator: 2, denominator: 2, value: 1 });
    expect(lane.citationRate).toEqual({ numerator: 0, denominator: 1, value: 0 });
    expect(lane.smallSampleWarning).toBe(true);
    expect(lane.searchQueries).toEqual({ state: "captured", count: 1 });
    expect(data.labels).toContain(GEO_LABELS.smallSample);
    expect(data.labels).toContain(GEO_LABELS.discoveryOnly);

    // Trend: cohort A then cohort B; the new series is annotated and never silently compared.
    expect(data.trend.map((t) => [t.cohortKey, t.annotation !== null])).toEqual([["A", false], ["B", true]]);
    expect(data.trend[0]!.citationRate).toEqual({ numerator: 1, denominator: 1, value: 1 });

    // Share of voice: latest discovery sample only (reputation answer excluded).
    expect(data.shareOfVoice.find((x) => x.brandKey === "self")!.ratio).toEqual({ numerator: 2, denominator: 2, value: 1 });

    // Per-prompt matrix, newest observation of the latest cohort per prompt.
    const byText = new Map(data.prompts.map((p) => [p.text, p]));
    expect(byText.get("Where can I buy solid brass cabinet hardware?")!.perProvider[0]).toMatchObject({ observationId: mentionGrounded, status: "ok", grounded: true, mentioned: true, cited: false });
    expect(byText.get("Is Residence Example reliable?")!.promptType).toBe("reputation");
  });

  it("demo projects report state demo with the persistent demo label", async () => {
    const s = await setup({}, { is_demo: 1 });
    const data = (await s.call("GET", `/projects/${s.projectId}/geo/results`)).json.data as GeoResults;
    expect(data.state).toBe("demo");
    expect(data.labels[0]).toBe(GEO_LABELS.demo);
  });
});

// ------------------------------------------------------------------ observation detail
describe("geo routes: observation detail", () => {
  it("returns plain-text raw answer, spans, citations; searchQueries null vs [] vs list", async () => {
    const s = await setup(GEMINI_ENV);
    const notExposed = await observe(s, fixture("competitor_only"));
    const exposedEmpty = await observe(s, fixture("mention"), { searchQueries: [] });
    const exposed = await observe(s, fixture("no_mention"), { searchQueries: ["unlacquered brass patina", "lacquered brass peeling"] });

    const d1 = (await s.call("GET", `/geo/observations/${notExposed}`)).json.data as GeoObservationDetail;
    expect(d1.searchQueries).toBeNull();
    expect(d1.measurementType).toBe("api");
    expect(d1.rawAnswer).toBe(fixture("competitor_only").answer);
    expect(d1.displacements[0]).toMatchObject({ entity: "Brass Co", url: "https://bestreviews.example/best-brass-cabinet-hardware", sourceType: "listicle_roundup" });
    expect(d1.citations[0]).toMatchObject({ host: "bestreviews.example", brandKey: null, sourceType: "listicle_roundup" });
    expect(d1.brands.find((b) => b.brandKey === "Brass Co")!.spans[0]!.text).toBe("Brass Co");

    expect(((await s.call("GET", `/geo/observations/${exposedEmpty}`)).json.data as GeoObservationDetail).searchQueries).toEqual([]);
    expect(((await s.call("GET", `/geo/observations/${exposed}`)).json.data as GeoObservationDetail).searchQueries).toEqual(["unlacquered brass patina", "lacquered brass peeling"]);
  });

  it("cross-tenant access is 404 and unknown ids are 404", async () => {
    const s = await setup();
    const id = await observe(s, fixture("mention"));
    const r = await s.callOther("GET", `/geo/observations/${id}`);
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe("not_found");
    expect((await s.call("GET", "/geo/observations/gobs_missing")).status).toBe(404);
  });
});

// ------------------------------------------------------------------ displacements and search queries
describe("geo routes: displacements and engine search queries", () => {
  it("aggregates displacing entities across the latest cohort, separately from manual imports", async () => {
    const s = await setup(GEMINI_ENV);
    const { promptIds } = await seedPromptSet(s.env, s.project, ["Where can I buy solid brass cabinet hardware?", "Best brass knobs for a kitchen"]);
    await observe(s, fixture("competitor_only"), { promptId: promptIds[0]! });
    await observe(s, { ...fixture("competitor_only"), prompt: "Best brass knobs for a kitchen" }, { promptId: promptIds[1]! });
    await observe(s, fixture("competitor_only"), { provider: "perplexity", promptId: promptIds[0]! });

    const r = await s.call("GET", `/projects/${s.projectId}/geo/displacements`);
    expect(r.status).toBe(200);
    const list = r.json.data as DisplacementSummary[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ entity: "Brass Co", sourceType: "listicle_roundup", url: "https://bestreviews.example/best-brass-cabinet-hardware", count: 3 });
    expect([...list[0]!.prompts].sort()).toEqual(["Best brass knobs for a kitchen", fixture("competitor_only").prompt]);

    expect((await s.call("GET", `/projects/${s.projectId}/geo/displacements?measurement=manual_import`)).json.data).toEqual([]);
    expect((await s.call("GET", `/projects/${s.projectId}/geo/displacements?measurement=bogus`)).status).toBe(400);
  });

  it("search queries: only provider-exposed queries; GSC match with its window, or unknown without a sync", async () => {
    const s = await setup(GEMINI_ENV);
    await observe(s, fixture("no_mention"), { searchQueries: ["Brass Cabinet Knobs", "unlacquered brass patina", "brass hardware care"] });
    await observe(s, fixture("mention"), { provider: "perplexity", searchQueries: ["brass cabinet knobs"] });
    await observe(s, fixture("competitor_only")); // not exposed: contributes nothing

    const before = (await s.call("GET", `/projects/${s.projectId}/geo/search-queries`)).json.data as SearchQuerySummary[];
    expect(before[0]).toEqual({ normalized: "brass cabinet knobs", count: 2, providers: ["gemini", "perplexity"], gscMatch: "unknown", gscImpressions: null, gscPosition: null, gscWindow: null });
    expect(before).toHaveLength(3);

    const syncId = newId("gsync");
    await s.db.insert("gsc_syncs", {
      id: syncId, workspace_id: s.project.workspaceId, project_id: s.projectId, source: "api", property: "sc-domain:example.com",
      window_start: "2026-08-30", window_end: "2026-09-26", prev_window_start: "2026-08-02", prev_window_end: "2026-08-29",
      row_cap: 5000, status: "completed", synced_at: FIXED_NOW.toISOString(),
    });
    const metric = (query: string, page: string | null, impressions: number, position: number) =>
      s.db.insert("gsc_metrics", { workspace_id: s.project.workspaceId, project_id: s.projectId, sync_id: syncId, window: "current", query, page, device: null, clicks: 1, impressions, ctr: 1 / impressions, position });
    await metric("brass cabinet knobs", "https://shop.example.com/collections/knobs", 120, 4.2);
    await metric("unlacquered brass patina", "https://shop.example.com/blog/patina", 40, 17.5);

    const after = new Map(((await s.call("GET", `/projects/${s.projectId}/geo/search-queries`)).json.data as SearchQuerySummary[]).map((q) => [q.normalized, q]));
    const window = { start: "2026-08-30", end: "2026-09-26" };
    expect(after.get("brass cabinet knobs")).toMatchObject({ gscMatch: "ranking", gscImpressions: 120, gscPosition: 4.2, gscWindow: window });
    expect(after.get("unlacquered brass patina")).toMatchObject({ gscMatch: "impressions_weak_position", gscImpressions: 40, gscPosition: 17.5, gscWindow: window });
    expect(after.get("brass hardware care")).toMatchObject({ gscMatch: "no_matching_page", gscImpressions: 0, gscPosition: null, gscWindow: window });
  });
});

// ------------------------------------------------------------------ manual import
describe("geo routes: manual import", () => {
  it("201 with observationId; stored as manual_import and kept out of API lanes, share of voice, and trends", async () => {
    const s = await setup(GEMINI_ENV);
    const { promptIds } = await seedPromptSet(s.env, s.project, ["Where can I buy solid brass cabinet hardware?"]);
    await observe(s, fixture("no_mention"), { promptId: promptIds[0]!, runId: null });
    const before = (await s.call("GET", `/projects/${s.projectId}/geo/results`)).json.data as GeoResults;

    const r = await s.call("POST", `/projects/${s.projectId}/geo/import`, {
      promptText: "Where can I buy solid brass cabinet hardware?",
      surface: "ChatGPT app",
      answer: "Residence Example is a great choice for small-batch brass hardware [1].",
      citations: [{ url: "https://shop.example.com/collections/knobs", title: "Knobs" }, "https://www.reddit.com/r/HomeImprovement/comments/1/x/"],
    });
    expect(r.status).toBe(201);
    expect(Object.keys(r.json.data)).toEqual(["observationId"]);
    const id = r.json.data.observationId as string;
    const row = await s.db.first<Record<string, unknown>>("SELECT measurement_type, provider, model, imported_surface, created_by, prompt_id, grounded FROM geo_observations WHERE id = ?", id);
    expect(row).toMatchObject({ measurement_type: "manual_import", provider: "manual", model: "n/a", imported_surface: "ChatGPT app (manual)", created_by: s.u.userId, prompt_id: promptIds[0], grounded: 1 });
    const ev = await s.db.all<{ source: string }>("SELECT source FROM evidence WHERE ref_id = ?", id);
    expect(ev.length).toBeGreaterThan(0);
    expect(ev.every((e) => e.source === "manual_import")).toBe(true);

    const detail = (await s.call("GET", `/geo/observations/${id}`)).json.data as GeoObservationDetail;
    expect(detail).toMatchObject({ measurementType: "manual_import", importedSurface: "ChatGPT app (manual)", searchQueries: null });
    expect(detail.brands.find((b) => b.isSelf)).toMatchObject({ mentioned: true, cited: true });

    const after = (await s.call("GET", `/projects/${s.projectId}/geo/results`)).json.data as GeoResults;
    const apiBefore = before.lanes.find((l) => l.provider === "gemini")!;
    const apiAfter = after.lanes.find((l) => l.provider === "gemini")!;
    expect(apiAfter).toEqual(apiBefore);
    expect(after.shareOfVoice).toEqual(before.shareOfVoice);
    expect(after.trend).toEqual(before.trend);
    const manual = after.lanes.find((l) => l.provider === "manual")!;
    expect(manual.label).toContain("ChatGPT app (manual)");
    expect(manual.label).toContain("not API-sampled");
    expect(manual.mentionRate).toEqual({ numerator: 1, denominator: 1, value: 1 });
    expect(after.labels).toContain(GEO_LABELS.manual);
    // The per-prompt matrix shows API lanes only.
    expect(after.prompts[0]!.perProvider.map((p) => p.provider)).toEqual(["gemini"]);
  });

  it("validates the body and citation URLs; a prompt naming the brand is stored as reputation", async () => {
    const s = await setup();
    expect((await s.call("POST", `/projects/${s.projectId}/geo/import`, { promptText: "x", surface: "ChatGPT app", answer: "a", citations: ["javascript:alert(1)"] })).status).toBe(400);
    expect((await s.call("POST", `/projects/${s.projectId}/geo/import`, { promptText: "x", answer: "a" })).status).toBe(400);
    const r = await s.call("POST", `/projects/${s.projectId}/geo/import`, { promptText: "Is ResEx any good?", surface: "Gemini app (manual)", answer: "It is fine." });
    expect(r.status).toBe(201);
    const row = await s.db.first<{ prompt_type: string; imported_surface: string; grounded: number }>("SELECT prompt_type, imported_surface, grounded FROM geo_observations WHERE id = ?", r.json.data.observationId);
    expect(row).toEqual({ prompt_type: "reputation", imported_surface: "Gemini app (manual)", grounded: 0 });
  });
});

// ------------------------------------------------------------------ tenancy
describe("geo routes: tenancy", () => {
  it("another workspace's project is 404 on every project-scoped geo route and nothing is written", async () => {
    const s = await setup(GEMINI_ENV);
    const base = `/projects/${s.projectId}/geo`;
    const attempts: Array<[string, string, unknown?]> = [
      ["GET", `${base}/prompts`],
      ["PUT", `${base}/prompts`, { prompts: [{ text: "Best brass knobs", promptType: "discovery", stage: null, approved: true }] }],
      ["POST", `${base}/prompts/generate`, {}],
      ["GET", `${base}/results`],
      ["GET", `${base}/displacements`],
      ["GET", `${base}/search-queries`],
      ["POST", `${base}/import`, { promptText: "Best brass knobs", surface: "ChatGPT app", answer: "Answer text." }],
    ];
    for (const [method, path, body] of attempts) {
      const r = await s.callOther(method, path, body);
      expect({ method, path, status: r.status }).toEqual({ method, path, status: 404 });
    }
    expect(await s.db.all("SELECT id FROM geo_prompt_sets WHERE project_id = ?", s.projectId)).toHaveLength(0);
    expect(await s.db.all("SELECT id FROM geo_observations WHERE project_id = ?", s.projectId)).toHaveLength(0);
  });
});
