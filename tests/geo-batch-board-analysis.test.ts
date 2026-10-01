/**
 * AI engine board analysis: GET /projects/:pid/geo/board (EngineBoardResponse), skip factors measured
 * from the crawl (PageSkipFactors), and manual rewrite plans (RewritePlansResponse). Stored data only;
 * nothing here calls a provider.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "@worker/app";
import type { Env } from "@worker/env";
import { Db } from "@worker/lib/db";
import { HttpError } from "@worker/lib/errors";
import { newId } from "@worker/lib/ids";
import { analyzeObservation } from "@worker/geo/analyze";
import { BOARD_LANES, FEED_LIMIT, laneCost } from "@worker/geo/board";
import { answerPosition, countNumericFacts, evaluateFactors, FACTOR_ORDER, type PageEvidence } from "@worker/geo/skip-factors";
import { INDEXNOW_LABEL } from "@worker/geo/rewrite-plan";
import { geoBoardRoutes, setGeoBoardHooks } from "@worker/routes/geo-board";
import type { EngineBoardResponse, EngineLaneSummary, PageSkipFactors, RewritePlansResponse } from "@shared/types";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";
import { makeTestContext } from "./helpers/context";
import { fixture, seedObservation, seedPromptSet, type FixtureCase, type SeedObservationOptions } from "./fixtures/geo-analysis/seed";
import { hoursAgo, seedCrawl, seedGsc, U } from "./coverage-seed";

const GEMINI_ENV: Partial<Env> = { GEMINI_API_KEY: "test-gemini-key", GEMINI_MODEL: "gemini-test-model" };

function makeApp(env: Env, userId: string) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", new Db(c.env.DB));
    c.set("now", FIXED_NOW);
    c.set("user", { id: userId, email: "u@example.com", name: null });
    c.set("session", null);
    await next();
  });
  app.route("/", geoBoardRoutes);
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as 400);
    throw err;
  });
  return async (path: string) => {
    const res = await app.request(path, { method: "GET" }, env);
    return { status: res.status, json: (await res.json()) as any };
  };
}

async function setup(envOverrides: Partial<Env> = {}, projectOverrides: Record<string, unknown> = {}) {
  const env = createTestEnv(envOverrides);
  const u = await seedUser(env);
  const projectId = await seedProject(env, u.workspaceId, projectOverrides);
  const project = { id: projectId, workspaceId: u.workspaceId };
  const other = await seedUser(env, { email: "other@example.com", workspaceName: "Other workspace" });
  const db = new Db(env.DB);
  return { env, u, ws: u.workspaceId, pid: projectId, project, db, call: makeApp(env, u.userId), callOther: makeApp(env, other.userId) };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function observe(s: Setup, c: FixtureCase, o: SeedObservationOptions = {}): Promise<string> {
  const id = await seedObservation(s.env, s.project, c, o);
  await analyzeObservation(makeTestContext(s.env, s.project), id);
  return id;
}

const lane = (b: EngineBoardResponse, p: string): EngineLaneSummary => b.lanes.find((l) => l.provider === p)!;

afterEach(() => setGeoBoardHooks({}));

// ------------------------------------------------------------------ board
describe("GET /projects/:pid/geo/board", () => {
  it("always returns the four lanes in fixed order; unconfigured engines are setup_required, never sample data", async () => {
    const s = await setup();
    const r = await s.call(`/projects/${s.pid}/geo/board`);
    expect(r.status).toBe(200);
    const b = r.json.data as EngineBoardResponse;
    expect(b.lanes.map((l) => l.provider)).toEqual(["openai_geo", "anthropic_geo", "gemini", "perplexity"]);
    expect(b.state).toBe("setup_required");
    for (const l of b.lanes) {
      expect(l).toMatchObject({ state: "setup_required", model: null, promptsRun: 0, answersCitingUs: 0, answersSkippingUs: 0, citedInstead: null, feed: [], costUsd: { value: null, isEstimate: true } });
      expect(l.citationRate).toEqual({ numerator: 0, denominator: 0, value: null });
    }
    expect(lane(b, "openai_geo").stateDetail).toBe("Set OPENAI_GEO_MODEL and an OpenAI API key");
    expect(lane(b, "perplexity").stateDetail).toBe("Set PERPLEXITY_MODEL and a Perplexity API key");
    expect(b.labels.join(" ")).toContain("API-sampled answers; not consumer-app answers");
    expect(b.labels).toContain("Setup required: approve at least one prompt.");
    expect(JSON.stringify(b)).not.toMatch(/traffic forecast|revenue\b.*\d|citability/i);
  });

  it("a configured engine that never ran is ready with an empty feed of not_run prompts and the configured model", async () => {
    const s = await setup({ OPENAI_GEO_API_KEY: "sk-test", OPENAI_GEO_MODEL: "gpt-4.1-mini" });
    await seedPromptSet(s.env, s.project, ["Where can I buy brass knobs?"]);
    const b = (await s.call(`/projects/${s.pid}/geo/board`)).json.data as EngineBoardResponse;
    expect(b.state).toBe("ready");
    const l = lane(b, "openai_geo");
    expect(l).toMatchObject({ state: "ready", stateDetail: null, model: "gpt-4.1-mini", cohortKey: null, lastRunAt: null, counts: { valid: 0, grounded: 0, failed: 0, incomplete: 0 } });
    expect(l.feed.map((f) => [f.status, f.observationId, f.position, f.sentiment])).toEqual([["not_run", null, null, null]]);
    expect(lane(b, "anthropic_geo").state).toBe("setup_required");
  });

  it("computes one lane from the latest cohort only: rates, skipping answers, cited-instead host, feed, cost, latency", async () => {
    const s = await setup(GEMINI_ENV);
    const prompts = ["named", "cited", "competitor", "spruce", "ordered", "never"];
    const { promptIds } = await seedPromptSet(s.env, s.project, [
      fixture("mention").prompt,
      fixture("citation_without_mention").prompt,
      "Where can I find solid brass cabinet hardware that is small-batch?",
      fixture("no_mention").prompt,
      fixture("ordered").prompt,
      "Brass hinge suppliers for antique doors",
    ]);
    const pid = (k: string) => promptIds[prompts.indexOf(k)]!;
    // Older cohort: must not leak into the lane.
    await observe(s, fixture("citation_without_mention"), { promptId: pid("cited"), cohortKey: "cohort-gemini-0", createdAt: hoursAgo(48), runId: null });
    await observe(s, fixture("mention"), { promptId: pid("named"), createdAt: hoursAgo(5) });
    await observe(s, fixture("citation_without_mention"), { promptId: pid("cited"), createdAt: hoursAgo(4) });
    await observe(s, { ...fixture("competitor_only"), prompt: "Where can I find solid brass cabinet hardware that is small-batch?" }, { promptId: pid("competitor"), createdAt: hoursAgo(3) });
    await observe(s, fixture("no_mention"), { promptId: pid("spruce"), createdAt: hoursAgo(2), searchQueries: ["unlacquered brass"] });
    await observe(s, fixture("ordered"), { promptId: pid("ordered"), createdAt: hoursAgo(1) });
    // A failed answer in the same cohort counts as failed, not as an absence.
    await observe(s, fixture("failed"), { promptId: null, status: "failed", createdAt: hoursAgo(6) });
    await s.db.insert("provider_calls", {
      id: newId("call"), workspace_id: s.ws, project_id: s.pid, run_id: null, provider: "gemini", model: "gemini-test-model", purpose: "geo.observe",
      status: "ok", request_id: "req-test", latency_ms: 1234, cost_is_estimate: 1, created_at: hoursAgo(1),
    });

    const b = (await s.call(`/projects/${s.pid}/geo/board`)).json.data as EngineBoardResponse;
    const l = lane(b, "gemini");
    expect(l.state).toBe("ready");
    expect(l.cohortKey).toBe("cohort-gemini-1");
    expect(l.model).toBe("gemini-test-model");
    expect(l.groundingMode).toBe("google_search");
    expect(l.counts).toEqual({ valid: 5, grounded: 3, failed: 1, incomplete: 0 });
    expect(l.citationRate).toEqual({ numerator: 1, denominator: 3, value: 1 / 3 });
    expect(l.answersCitingUs).toBe(1);
    expect(l.mentionRate.denominator).toBe(5);
    expect(l.answersSkippingUs).toBe(2); // competitor + spruce
    expect(l.citedInstead).toEqual({ host: "bestreviews.example", share: { numerator: 1, denominator: 2, value: 0.5 } });
    expect(l.searchQueries).toEqual({ state: "captured", count: 1 });
    expect(l.costUsd.isEstimate).toBe(true);
    expect(l.costUsd.value).toBeCloseTo(0.06, 10);
    expect(l.lastRunAt).toBe(hoursAgo(1));
    expect(l.smallSampleWarning).toBe(true);
    expect(b.labels.some((x) => x.startsWith("Small sample"))).toBe(true);

    const feed = new Map(l.feed.map((f) => [f.promptId, f]));
    expect(l.feed.map((f) => f.observedAt)).toEqual([...l.feed.map((f) => f.observedAt)].sort((a, b2) => (a === null ? 1 : b2 === null ? -1 : a < b2 ? 1 : -1)));
    expect(l.feed.at(-1)).toMatchObject({ promptId: pid("never"), status: "not_run", observationId: null });
    expect(feed.get(pid("named"))).toMatchObject({ status: "named", citedInstead: null, latencyMs: 1234 });
    expect(feed.get(pid("cited"))).toMatchObject({ status: "cited", citedInstead: null, grounded: true });
    expect(feed.get(pid("competitor"))).toMatchObject({ status: "missing", sentiment: null, position: null, citedInstead: { host: "bestreviews.example", url: "https://bestreviews.example/best-brass-cabinet-hardware" } });
    expect(feed.get(pid("ordered"))).toMatchObject({ status: "named", position: 2 });
    // Sentiment only when the brand was mentioned and a sentiment was measured.
    for (const f of l.feed) if (f.status === "missing" || f.status === "not_run") expect(f.sentiment).toBeNull();

    // Other lanes stay untouched.
    expect(lane(b, "perplexity")).toMatchObject({ state: "setup_required", feed: [] });
  });

  it("unknown cost is null (never $0); a latest run where every answer failed puts the lane in error", async () => {
    const s = await setup(GEMINI_ENV);
    const { promptIds } = await seedPromptSet(s.env, s.project, [fixture("mention").prompt]);
    await observe(s, fixture("mention"), { promptId: promptIds[0]!, costUsd: null, runId: null, createdAt: hoursAgo(30) });
    let b = (await s.call(`/projects/${s.pid}/geo/board`)).json.data as EngineBoardResponse;
    expect(lane(b, "gemini").costUsd).toEqual({ value: null, isEstimate: true });

    await observe(s, fixture("failed"), { promptId: promptIds[0]!, status: "failed", createdAt: hoursAgo(1) });
    b = (await s.call(`/projects/${s.pid}/geo/board`)).json.data as EngineBoardResponse;
    expect(lane(b, "gemini").state).toBe("error");
    expect(lane(b, "gemini").stateDetail).toBe("Latest run failed: HTTP 500");

    expect(laneCost([])).toEqual({ value: null, isEstimate: true });
    expect(laneCost([{ cost_usd: 0.5, cost_is_estimate: 0 }])).toEqual({ value: 0.5, isEstimate: false });
  });

  it("stays under the 100-parameter limit with many observations, caps the feed, and excludes manual imports", async () => {
    const s = await setup(GEMINI_ENV);
    const texts = Array.from({ length: FEED_LIMIT + 10 }, (_, i) => `Where can I buy solid brass knob model ${i}?`);
    const { promptIds } = await seedPromptSet(s.env, s.project, texts);
    for (const [i, id] of promptIds.entries()) {
      await observe(s, { ...fixture("mention"), prompt: texts[i]! }, { promptId: id, createdAt: hoursAgo(100 - i) });
    }
    await s.db.run("UPDATE geo_observations SET measurement_type = 'manual_import', imported_surface = 'chatgpt_app' WHERE id = (SELECT id FROM geo_observations ORDER BY created_at DESC LIMIT 1)");
    const b = (await s.call(`/projects/${s.pid}/geo/board`)).json.data as EngineBoardResponse;
    const l = lane(b, "gemini");
    expect(l.counts.valid).toBe(FEED_LIMIT + 9);
    expect(l.feed).toHaveLength(FEED_LIMIT);
    expect(l.smallSampleWarning).toBe(false);
  });

  it("demo projects are labelled demo; other workspaces get 404", async () => {
    const s = await setup({}, { is_demo: 1 });
    const b = (await s.call(`/projects/${s.pid}/geo/board`)).json.data as EngineBoardResponse;
    expect(b.state).toBe("demo");
    expect(b.lanes.every((l) => l.state === "demo")).toBe(true);
    expect((await s.callOther(`/projects/${s.pid}/geo/board`)).status).toBe(404);
    expect(BOARD_LANES).toHaveLength(4);
  });
});

// ------------------------------------------------------------------ skip factors
const EVIDENCE: PageEvidence = {
  wordCount: 900,
  firstParagraph: "Our brass knobs are cast in small batches.",
  excerpt:
    "Our brass knobs are cast in small batches. We have made hardware since 1999. The best solid brass cabinet hardware that is not mass-produced is cast by hand. Each knob is 38 mm wide, weighs 85 g and costs $24.",
  headings: [{ level: 1, text: "Brass knobs" }, { level: 2, text: "What sizes are there?" }, { level: 2, text: "How do I clean brass?" }],
  jsonldTypes: ["Product", "BreadcrumbList"],
  author: null,
  lastUpdated: "2026-03-01",
  outboundCitations: 1,
  tableCount: 0,
  inlinks: 4,
};

describe("skip factors: pure measurements", () => {
  it("finds the first sentence sharing the question's content terms", () => {
    const p = answerPosition(EVIDENCE.excerpt, new Set(["solid", "brass", "cabinet", "hardware", "mass-produced"]));
    expect(p.word).toBe(18);
    expect(p.sentence).toContain("best solid brass cabinet hardware");
    expect(answerPosition(null, new Set(["x"]))).toEqual({ word: null, scanned: 0, sentence: null });
  });

  it("counts numeric/spec facts heuristically", () => {
    expect(countNumericFacts("Each knob is 38 mm wide, weighs 85 g and costs $24. Model XR500 is 10% heavier.")).toBe(5);
    expect(countNumericFacts("Lovely and timeless.")).toBe(0);
  });

  it("evaluates every factor with an observable measurement and no aggregate score", () => {
    const f = evaluateFactors(EVIDENCE, "Where can I buy solid brass cabinet hardware that isn't mass-produced?", new Set(["residence", "example"]), FIXED_NOW, "2026-09-29T00:00:00Z");
    expect(f.map((x) => x.key)).toEqual(FACTOR_ORDER);
    const by = new Map(f.map((x) => [x.key, x]));
    expect(by.get("answer_first")).toMatchObject({ status: "present", method: "heuristic", value: 18, measured: "Answer at word 18" });
    expect(by.get("faq_schema")).toMatchObject({ status: "partial", measured: "2 question headings; FAQPage JSON-LD absent" });
    expect(by.get("author")).toMatchObject({ status: "missing", method: "measured" });
    expect(by.get("freshness")).toMatchObject({ status: "partial", value: 213 });
    expect(by.get("sources_cited")).toMatchObject({ status: "partial", measured: "1 outbound source link" });
    expect(by.get("entity_facts")).toMatchObject({ status: "present", method: "heuristic" });
    expect(by.get("compare_table")).toMatchObject({ status: "missing", measured: "No HTML table" });
    expect(by.get("internal_links")).toMatchObject({ status: "present", value: 4 });
    expect(f.some((x) => "score" in x)).toBe(false);

    const unknownish = evaluateFactors({ ...EVIDENCE, excerpt: null, firstParagraph: null, outboundCitations: null, tableCount: null, inlinks: null, jsonldTypes: [] }, null, new Set(), FIXED_NOW, null);
    const u = new Map(unknownish.map((x) => [x.key, x]));
    expect(u.get("answer_first")).toMatchObject({ status: "unknown", measured: "First paragraph: not collected" });
    expect(u.get("sources_cited")!.status).toBe("unknown");
    expect(u.get("compare_table")!.status).toBe("unknown");
    expect(u.get("internal_links")!.status).toBe("unknown");
  });
});

describe("GET /projects/:pid/geo/pages/:pageId/skip-factors", () => {
  it("measures the latest snapshot, counts internal links in, names the cited-instead host, and fills the cited column from an assessed competitor page", async () => {
    const s = await setup(GEMINI_ENV);
    const { crawlId, pageIds } = await seedCrawl(s, [
      { path: "/knobs", jsonld: ["FAQPage", "Product"], tables: 2, outbound: 5, lastUpdated: "2026-09-10T00:00:00Z" },
      { path: "/a" },
      { path: "/b" },
    ]);
    await s.db.run("UPDATE page_snapshots SET author = 'Jane Doe', main_text_excerpt = ?, first_paragraph = ? WHERE page_id = ? AND crawl_run_id = ?",
      "Solid brass cabinet knobs that are not mass-produced are cast in small runs here. Each is 38 mm.", "Solid brass cabinet knobs that are not mass-produced are cast in small runs here.", pageIds["/knobs"], crawlId);
    await s.db.run("UPDATE page_snapshots SET internal_links_json = ? WHERE page_id IN (?, ?)", JSON.stringify([U("/knobs"), U("/a")]), pageIds["/a"], pageIds["/b"]);

    const prompt = fixture("competitor_only").prompt;
    const { promptIds } = await seedPromptSet(s.env, s.project, [prompt]);
    await observe(s, fixture("competitor_only"), { promptId: promptIds[0]! });

    const path = `/projects/${s.pid}/geo/pages/${pageIds["/knobs"]}/skip-factors`;
    const base = (await s.call(path)).json.data as PageSkipFactors;
    expect(base).toMatchObject({ state: "ready", promptId: null, engine: null, citedInsteadHost: null, competitorAssessmentId: null });
    expect(base.page).toMatchObject({ pageId: pageIds["/knobs"], url: U("/knobs"), wordCount: 600 });
    const by = new Map(base.factors.map((f) => [f.key, f]));
    expect(by.get("faq_schema")!.status).toBe("present");
    expect(by.get("author")!.measured).toBe("Byline: Jane Doe");
    expect(by.get("compare_table")).toMatchObject({ status: "present", value: 2 });
    expect(by.get("sources_cited")!.status).toBe("present");
    expect(by.get("internal_links")!.value).toBe(2);
    expect(by.get("internal_links")!.status).toBe("partial");
    expect(base.labels).toContain("Measured from crawl");
    for (const f of base.factors) expect(f.citedPage).toBeNull();

    // With a prompt + engine: the cited-instead host; then an assessed competitor page fills citedPage.
    const q = `${path}?promptId=${promptIds[0]}&engine=gemini`;
    const withPrompt = (await s.call(q)).json.data as PageSkipFactors;
    expect(withPrompt).toMatchObject({ promptText: prompt, engine: "gemini", citedInsteadHost: "bestreviews.example" });
    expect(withPrompt.basis).toContain("Approve reading the cited page");

    await s.db.insert("competitor_pages", {
      id: "cmp_1", workspace_id: s.ws, project_id: s.pid, url: "https://bestreviews.example/best-brass-cabinet-hardware", host: "bestreviews.example",
      approved_by: s.u.userId, approved_at: hoursAgo(1), fetched_at: hoursAgo(1), status: "assessed",
      extraction_json: JSON.stringify({ question: prompt, factors: { author: { status: "present", measured: "Byline: X", value: null }, faq_schema: { status: "present", measured: "FAQPage JSON-LD present", value: 0 } } }),
      created_at: hoursAgo(1), updated_at: hoursAgo(1),
    });
    const withCited = (await s.call(q)).json.data as PageSkipFactors;
    expect(withCited.competitorAssessmentId).toBe("cmp_1");
    const c = new Map(withCited.factors.map((f) => [f.key, f.citedPage]));
    expect(c.get("author")).toEqual({ status: "present", measured: "Byline: X", value: null });
    expect(c.get("compare_table")).toBeNull();

    // Perplexity has no answers for this prompt: no cited-instead host.
    expect(((await s.call(`${path}?promptId=${promptIds[0]}&engine=perplexity`)).json.data as PageSkipFactors).citedInsteadHost).toBeNull();
  });

  it("no crawl -> every factor unknown; skipped pages carry the reason; bad params are 400; foreign pages 404", async () => {
    const s = await setup();
    await s.db.insert("pages", { id: "pg_x", workspace_id: s.ws, project_id: s.pid, url: U("/x"), page_type: "other", page_type_method: "url_pattern", first_seen_at: hoursAgo(1), last_crawled_at: hoursAgo(1) });
    const none = (await s.call(`/projects/${s.pid}/geo/pages/pg_x/skip-factors`)).json.data as PageSkipFactors;
    expect(none.basis).toBe("No crawl yet");
    expect(none.factors.every((f) => f.status === "unknown")).toBe(true);

    const { pageIds } = await seedCrawl(s, [{ path: "/skipped", skipped: "robots.txt disallows" }]);
    const sk = (await s.call(`/projects/${s.pid}/geo/pages/${pageIds["/skipped"]}/skip-factors`)).json.data as PageSkipFactors;
    expect(sk.basis).toBe("Skipped by the crawler: robots.txt disallows");

    expect((await s.call(`/projects/${s.pid}/geo/pages/pg_x/skip-factors?engine=chatgpt_app`)).status).toBe(400);
    const badPrompt = await s.call(`/projects/${s.pid}/geo/pages/pg_x/skip-factors?promptId=gpr_nope`);
    expect(badPrompt.status).toBe(400);
    expect(badPrompt.json.error.details).toEqual({ reason: "prompt_not_approved" });
    expect((await s.call(`/projects/${s.pid}/geo/pages/pg_nope/skip-factors`)).status).toBe(404);
    expect((await s.callOther(`/projects/${s.pid}/geo/pages/pg_x/skip-factors`)).status).toBe(404);
  });
});

// ------------------------------------------------------------------ rewrite plans
describe("GET /projects/:pid/geo/rewrite-plans", () => {
  async function seedRec(s: Setup, target: unknown, status = "open", agent = "geo") {
    const id = newId("rec");
    await s.db.insert("recommendations", {
      id, workspace_id: s.ws, project_id: s.pid, agent, scope: "page", target_json: JSON.stringify(target), issue_type: "geo_gap", trigger: "t", issue: "i",
      action: "a", rationale: "r", effort: "low", uncertainty: "low", limitations: "l", verified: 0, priority: 2, priority_version: "v",
      evidence_ids_json: "[]", dedup_key: id, status, created_at: hoursAgo(1), updated_at: hoursAgo(1),
    });
    return id;
  }

  it("is empty (ready) without open GEO recommendations or adapt verdicts", async () => {
    const s = await setup();
    await seedCrawl(s, [{ path: "/knobs" }]);
    await seedRec(s, { kind: "url", url: U("/knobs") }, "dismissed");
    await seedRec(s, { kind: "url", url: U("/knobs") }, "open", "seo");
    const r = (await s.call(`/projects/${s.pid}/geo/rewrite-plans`)).json.data as RewritePlansResponse;
    expect(r).toMatchObject({ state: "ready", plans: [] });
  });

  it("builds a manual plan ticked from the latest crawl, with optional IndexNow and measured GSC only", async () => {
    const s = await setup(GEMINI_ENV);
    const { pageIds, crawlId } = await seedCrawl(s, [
      { path: "/knobs", jsonld: ["FAQPage"], tables: 0 },
      { path: "/other" },
    ]);
    await s.db.run("UPDATE page_snapshots SET author = 'Jane' WHERE page_id = ? AND crawl_run_id = ?", pageIds["/knobs"], crawlId);
    const recId = await seedRec(s, { kind: "url", url: U("/knobs") });
    await seedGsc(s, { pageRows: [{ path: "/knobs", clicks: 12, impressions: 400 }] });

    const r = (await s.call(`/projects/${s.pid}/geo/rewrite-plans`)).json.data as RewritePlansResponse;
    expect(r.state).toBe("ready");
    expect(r.plans).toHaveLength(1);
    const p = r.plans[0]!;
    expect(p).toMatchObject({ pageId: pageIds["/knobs"], url: U("/knobs"), recommendationId: recId, publishing: "manual", competitorAssessmentId: null });
    expect(p.gsc).toEqual({ clicks: 12, impressions: 400, window: { start: "2026-08-30", end: "2026-09-26" } });
    expect(p.aiCitations).toBeNull(); // no GEO data at all
    const items = new Map(p.items.map((i) => [i.key, i]));
    expect(items.get("faq")).toMatchObject({ status: "done", method: "measured" });
    expect(items.get("faq")!.evidence).toContain("FAQPage JSON-LD present");
    expect(items.get("compare_table")).toMatchObject({ status: "todo" });
    expect(items.get("author")).toMatchObject({ status: "done" });
    expect(items.get("schema")).toMatchObject({ status: "done" });
    expect(items.get("read_winning_page")).toMatchObject({ status: "not_applicable", method: "manual" });
    expect(items.get("indexnow")).toEqual({ key: "indexnow", label: INDEXNOW_LABEL, status: "unknown", evidence: "Check this yourself", method: "manual", optional: true });
    expect(INDEXNOW_LABEL).toContain("not Google");
    expect(p.items.filter((i) => i.optional).map((i) => i.key)).toEqual(["indexnow"]);
    expect(r.labels.join(" ")).toContain("never copy their text");
  });

  it("an adapt competitor assessment makes a plan for our matched page; AI citations are counted in the window", async () => {
    const s = await setup(GEMINI_ENV);
    const { pageIds } = await seedCrawl(s, [{ path: "/products/brass-switch-plate" }]);
    const { promptIds } = await seedPromptSet(s.env, s.project, [fixture("citation_without_mention").prompt]);
    await observe(s, fixture("citation_without_mention"), { promptId: promptIds[0]!, createdAt: hoursAgo(24) });
    await s.db.insert("competitor_pages", {
      id: "cmp_a", workspace_id: s.ws, project_id: s.pid, url: "https://www.reddit.com/r/HomeImprovement/comments/abc/brass_switch_plates/", host: "reddit.com",
      approved_by: s.u.userId, approved_at: hoursAgo(1), fetched_at: hoursAgo(1), status: "assessed", verdict: "adapt", verdict_version: "competitor-verdict.v1",
      extraction_json: JSON.stringify({ question: "Best places to buy custom brass light switch plates", ourPage: { pageId: pageIds["/products/brass-switch-plate"], url: U("/products/brass-switch-plate") } }),
      created_at: hoursAgo(1), updated_at: hoursAgo(1),
    });
    const r = (await s.call(`/projects/${s.pid}/geo/rewrite-plans`)).json.data as RewritePlansResponse;
    expect(r.plans).toHaveLength(1);
    const p = r.plans[0]!;
    expect(p).toMatchObject({ competitorAssessmentId: "cmp_a", engine: "gemini", recommendationId: null, gsc: null });
    expect(p.aiCitations?.count).toBe(1);
    expect(p.items.find((i) => i.key === "read_winning_page")).toMatchObject({ status: "unknown", evidence: expect.stringContaining("reddit.com") });
    expect(r.labels).toContain("Search Console not connected: no clicks or impressions shown.");
  });

  it("other workspaces get 404", async () => {
    const s = await setup();
    expect((await s.callOther(`/projects/${s.pid}/geo/rewrite-plans`)).status).toBe(404);
    expect((await s.callOther(`/projects/${s.pid}/geo/pages/x/skip-factors`)).status).toBe(404);
  });
});
