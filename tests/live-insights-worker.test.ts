/**
 * GET /projects/:pid/live/insights?kind= (docs/api.md "Live view: project containers"): tenant isolation and
 * input validation through the real app; each container's aggregate from seeded rows (thresholds, gainers and
 * losers, grouping, history cells, budget semantics); the labelled demo seed; and D1 limits: at least 2,000
 * Search Console rows and 500 stored answers read with every statement bounded (LIMIT) and under 100 bound
 * parameters (the shim throws above that).
 */
import { describe, expect, it } from "vitest";
import type {
  LiveBrandsInsight,
  LiveBudgetInsight,
  LiveCitedDomainsInsight,
  LiveEngineQueriesInsight,
  LiveInsight,
  LiveInsightKind,
  LiveMoversInsight,
  LivePromptHistoryInsight,
  LiveSheetsInsight,
  LiveStrikingInsight,
  LiveTechnicalInsight,
} from "@shared/types";
import type { Env } from "@worker/env";
import { insertStatement, Db } from "@worker/lib/db";
import { newId } from "@worker/lib/ids";
import { DEMO_LABEL, DEMO_ORIGIN } from "@worker/demo/fixtures";
import { seedDemoProject } from "@worker/demo/seed";
import { buildLiveInsight, LIVE_INSIGHT_KINDS } from "@worker/live/insights";
import { CITED_DOMAINS, MOVERS, PROMPT_HISTORY, STRIKING_DISTANCE } from "@worker/live/insights-lib";
import type { ProjectRow } from "@worker/platform/access";
import { D1_MAX_BOUND_PARAMS } from "./helpers/d1";
import { FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";
import { caller, ORIGIN, seedCrawl, seedFinding, seedGsc, seedRun, setup, t } from "./live-worker-seed";

type Ctx = Awaited<ReturnType<typeof setup>>;
const build = async <T extends LiveInsight>(ctx: { env: Env; db: Db; p: ProjectRow; u: { userId: string } }, kind: LiveInsightKind, now = FIXED_NOW) =>
  (await buildLiveInsight(ctx.db, ctx.p, kind, { env: ctx.env, userId: ctx.u.userId, now })) as T;

/** Records every SQL statement prepared on the env's D1 (the shim still enforces the 100-parameter limit). */
function recordSql(env: Env): string[] {
  const seen: string[] = [];
  const d1 = env.DB as unknown as { prepare: (sql: string) => unknown };
  const orig = d1.prepare.bind(d1);
  d1.prepare = (sql: string) => {
    seen.push(sql);
    return orig(sql);
  };
  return seen;
}

async function demoCtx() {
  const ctx = await setup({ DEMO_MODE: "true" });
  const demo = await seedDemoProject(ctx.env, ctx.db, ctx.u.userId, FIXED_NOW);
  return { ...ctx, p: demo };
}

// ------------------------------------------------------------------ access and input
describe("GET /projects/:pid/live/insights: access and input", () => {
  it("404s for another tenant's project for every kind; 400 for a missing or unknown kind", async () => {
    const ctx = await setup();
    const other = await seedUser(ctx.env);
    const pOther = await seedProject(ctx.env, other.workspaceId);
    const call = caller(ctx.env, ctx.u);
    for (const kind of LIVE_INSIGHT_KINDS) {
      const r = await call(`/projects/${pOther}/live/insights?kind=${kind}`);
      expect(r.status, kind).toBe(404);
      expect(r.json.error.code).toBe("not_found");
      const own = await call(`/projects/${ctx.pid}/live/insights?kind=${kind}`);
      expect(own.status, kind).toBe(200);
      expect(own.json.data.kind).toBe(kind);
    }
    expect((await call(`/projects/${ctx.pid}/live/insights`)).status).toBe(400);
    const bad = await call(`/projects/${ctx.pid}/live/insights?kind=traffic_forecast`);
    expect(bad.status).toBe(400);
    expect(bad.json.error.details).toEqual({ field: "kind" });
  });

  it("never reads another workspace's rows: a second tenant's GSC rows, answers and syncs stay invisible", async () => {
    const ctx = await setup();
    const other = await seedUser(ctx.env);
    const pOther = await seedProject(ctx.env, other.workspaceId);
    await seedGsc(ctx.db, other.workspaceId, pOther, { rows: [{ query: "brass knobs", page: `${ORIGIN}/a`, clicks: 3, impressions: 900, position: 12 }] });
    const run = await seedRun(ctx.db, other.workspaceId, pOther, "geo", "completed");
    await seedAnswers(ctx.db, other.workspaceId, pOther, run, 3);
    const striking = await build<LiveStrikingInsight>(ctx, "striking");
    expect(striking.state).toBe("setup_required");
    expect(striking.rows).toEqual([]);
    const cited = await build<LiveCitedDomainsInsight>(ctx, "cited_domains");
    expect(cited.rows).toEqual([]);
    const brands = await build<LiveBrandsInsight>(ctx, "brands");
    expect(brands.brands).toEqual([]);
  });
});

// ------------------------------------------------------------------ SEO containers
describe("SEO 10 striking distance", () => {
  it("lists current query+page rows with position 8–20 inclusive and impressions, by impressions, joined to the previous window", async () => {
    const ctx = await setup();
    const run = await seedRun(ctx.db, ctx.ws, ctx.pid, "seo", "completed");
    const page = `${ORIGIN}/p`;
    await seedGsc(ctx.db, ctx.ws, ctx.pid, {
      runId: run,
      rows: [
        { query: "below", page, clicks: 9, impressions: 900, position: 7.99 },
        { query: "edge low", page, clicks: 3, impressions: 300, position: 8 },
        { query: "middle", page, clicks: 5, impressions: 500, position: 12.4 },
        { query: "edge high", page, clicks: 1, impressions: 100, position: 20 },
        { query: "above", page, clicks: 1, impressions: 800, position: 20.01 },
        { query: "no impressions", page, clicks: 0, impressions: 0, position: 10 },
        { query: "page row", page: null, clicks: 7, impressions: 700, position: 10 },
        { query: null, page, clicks: 7, impressions: 700, position: 10 },
        { query: "device row", page, device: "MOBILE", clicks: 7, impressions: 700, position: 10 },
        { query: "middle", page, clicks: 9, impressions: 420, position: 15.2, window: "previous" },
      ],
    });
    const r = await build<LiveStrikingInsight>(ctx, "striking");
    expect(r.state).toBe("ready");
    expect(r.thresholds).toEqual({ minPosition: 8, maxPosition: 20, minImpressions: 1, maxRows: 50 });
    expect(r.rows.map((x) => x.query)).toEqual(["middle", "edge low", "edge high"]);
    expect(r.total).toBe(3);
    expect(r.rows[0]).toMatchObject({ clicks: 5, impressions: 500, ctr: 0.01, position: 12.4, previous: { clicks: 9, impressions: 420, position: 15.2 } });
    expect(r.rows[1]!.previous).toBeNull();
    expect(r.sync).toMatchObject({ runId: run, source: "api", current: { start: "2026-09-01", end: "2026-09-28" } });
  });

  it("lists at most maxRows rows but counts all rows in range; setup_required without a usable sync", async () => {
    const ctx = await setup();
    expect((await build<LiveStrikingInsight>(ctx, "striking")).state).toBe("setup_required");
    await seedGsc(ctx.db, ctx.ws, ctx.pid, { status: "failed", rows: [] });
    expect((await build<LiveStrikingInsight>(ctx, "striking")).message).toMatch(/connect Search Console/);
    await seedGsc(ctx.db, ctx.ws, ctx.pid, {
      rows: Array.from({ length: 60 }, (_, i) => ({ query: `q${String(i).padStart(2, "0")}`, page: `${ORIGIN}/p${i}`, clicks: 1, impressions: 100 + i, position: 9 })),
    });
    const r = await build<LiveStrikingInsight>(ctx, "striking");
    expect(r.rows).toHaveLength(STRIKING_DISTANCE.maxRows);
    expect(r.total).toBe(60);
    expect(r.rows[0]!.query).toBe("q59");
  });
});

describe("SEO 11 pages gaining and losing clicks", () => {
  it("ranks only pages in both windows by click difference; new and lost pages are counted; page rows win over query+page sums", async () => {
    const ctx = await setup();
    const P = (x: string) => `${ORIGIN}/${x}`;
    await seedGsc(ctx.db, ctx.ws, ctx.pid, {
      rows: [
        { page: P("up"), clicks: 50, impressions: 1000, position: 4 },
        { page: P("up"), clicks: 20, impressions: 900, position: 6, window: "previous" },
        { page: P("down"), clicks: 5, impressions: 400, position: 9 },
        { page: P("down"), clicks: 30, impressions: 500, position: 5, window: "previous" },
        { page: P("same"), clicks: 7, impressions: 70, position: 3 },
        { page: P("same"), clicks: 7, impressions: 80, position: 3, window: "previous" },
        { page: P("new"), clicks: 4, impressions: 40, position: 8 },
        { page: P("lost"), clicks: 3, impressions: 30, position: 8, window: "previous" },
        // query+page rows are ignored when the sync stored page rows
        { query: "x", page: P("up"), clicks: 999, impressions: 999, position: 1 },
      ],
    });
    const r = await build<LiveMoversInsight>(ctx, "movers");
    expect(r.basis).toBe("page_rows");
    expect(r.gainers.map((g) => [g.page, g.clickDelta])).toEqual([[P("up"), 30]]);
    expect(r.losers.map((g) => [g.page, g.clickDelta])).toEqual([[P("down"), -25]]);
    expect(r.gainers[0]).toMatchObject({ current: { clicks: 50, impressions: 1000, position: 4 }, previous: { clicks: 20, impressions: 900, position: 6 } });
    expect(r.counts).toEqual({ both: 3, unchanged: 1, newPages: 1, lostPages: 1 });
    expect(r.top).toBe(MOVERS.top);
  });

  it("falls back to query+page sums (labelled lower bound)", async () => {
    const ctx = await setup();
    await seedGsc(ctx.db, ctx.ws, ctx.pid, {
      rows: [
        { query: "a", page: `${ORIGIN}/x`, clicks: 3, impressions: 100, position: 10 },
        { query: "b", page: `${ORIGIN}/x`, clicks: 2, impressions: 100, position: 20 },
        { query: "a", page: `${ORIGIN}/x`, clicks: 1, impressions: 50, position: 9, window: "previous" },
      ],
    });
    const r = await build<LiveMoversInsight>(ctx, "movers");
    expect(r.basis).toBe("query_page_rows");
    expect(r.gainers[0]).toMatchObject({ clickDelta: 4, current: { clicks: 5, impressions: 200, position: 15 } });
    expect(r.labels.join(" ")).toMatch(/lower bound/);
  });
});

describe("SEO 12 technical issues", () => {
  it("groups the latest completed crawl's findings by severity and rule with examples; reports a newer running crawl", async () => {
    const ctx = await setup();
    const old = await seedCrawl(ctx.db, ctx.ws, ctx.pid, null, t(0));
    await seedFinding(ctx.db, ctx.ws, ctx.pid, old, { ruleId: "SEO-TITLE-MISSING", severity: "major" });
    const latest = await seedCrawl(ctx.db, ctx.ws, ctx.pid, null, t(100));
    for (let i = 0; i < 7; i++) await seedFinding(ctx.db, ctx.ws, ctx.pid, latest, { ruleId: "SEO-META-DESC-MISSING", severity: "minor", url: `${ORIGIN}/m${i}` });
    await seedFinding(ctx.db, ctx.ws, ctx.pid, latest, { ruleId: "SEO-H1-MISSING", severity: "moderate", url: `${ORIGIN}/h` });
    await seedCrawl(ctx.db, ctx.ws, ctx.pid, null, t(200), "running");
    const r = await build<LiveTechnicalInsight>(ctx, "technical");
    expect(r.crawl!.id).toBe(latest);
    expect(r.newer).toMatchObject({ status: "running" });
    expect(r.groups.map((g) => [g.severity, g.ruleId, g.count])).toEqual([
      ["moderate", "SEO-H1-MISSING", 1],
      ["minor", "SEO-META-DESC-MISSING", 7],
    ]);
    expect(r.groups[1]!.examples).toHaveLength(5);
    expect(r.groups[1]!.ruleName).not.toBe("SEO-META-DESC-MISSING");
    expect(r.bySeverity).toMatchObject({ critical: 0, major: 0, moderate: 1, minor: 7 });
    expect(r.total).toBe(8);
  });

  it("is setup_required for an unverified site", async () => {
    const ctx = await setup();
    await ctx.db.run("UPDATE projects SET verified_host = NULL WHERE id = ?", ctx.pid);
    const p = (await ctx.db.first<ProjectRow>("SELECT * FROM projects WHERE id = ?", ctx.pid))!;
    const r = await build<LiveTechnicalInsight>({ ...ctx, p }, "technical");
    expect(r.state).toBe("setup_required");
    expect(r.message).toMatch(/Verify site ownership/);
  });
});

// ------------------------------------------------------------------ GEO containers
interface AnswerSeed {
  provider?: string;
  text?: string;
  status?: string;
  at?: string;
  self?: { mentioned: number; cited: number; status?: string } | null;
  brands?: Array<{ key: string; mentioned: number; cited: number; status?: string }>;
  citations?: Array<{ url: string; title?: string | null; sourceType?: string }>;
  queries?: string[];
  promptType?: string;
}

function answerStatements(ws: string, pid: string, runId: string, a: AnswerSeed): Array<[string, ...unknown[]]> {
  const id = newId("obs");
  const S: Array<[string, ...unknown[]]> = [];
  S.push(
    insertStatement("geo_observations", {
      id, workspace_id: ws, project_id: pid, run_id: runId, prompt_id: null, prompt_text: a.text ?? "best oak table", prompt_type: a.promptType ?? "discovery",
      cohort_key: "c1", provider: a.provider ?? "gemini", model: "m", grounding_mode: "g", measurement_type: "api", status: a.status ?? "ok", grounded: 1,
      usage_json: "{}", cost_usd: null, created_at: a.at ?? t(10),
    }),
  );
  const brandRows = [...(a.self === null ? [] : [{ key: "self", ...(a.self ?? { mentioned: 0, cited: 0 }) }]), ...(a.brands ?? [])];
  if ((a.status ?? "ok") === "ok") {
    for (const b of brandRows) {
      S.push(
        insertStatement("geo_brand_observations", {
          id: newId("gbo"), workspace_id: ws, project_id: pid, observation_id: id, brand_key: b.key, is_self: b.key === "self" ? 1 : 0, mentioned: b.mentioned, cited: b.cited,
          recommendation_status: b.status ?? (b.mentioned ? "listed_neutral" : "not_mentioned"), sentiment: "not_applicable", method: "deterministic",
        }),
      );
    }
  }
  (a.citations ?? []).forEach((c, i) =>
    S.push(
      insertStatement("geo_citations", {
        id: newId("cit"), workspace_id: ws, project_id: pid, observation_id: id, url: c.url, host: new URL(c.url).hostname, title: c.title ?? null, position: i + 1,
        source_type: c.sourceType ?? "other", source_type_method: "rule",
      }),
    ),
  );
  for (const q of a.queries ?? []) {
    S.push(insertStatement("geo_search_queries", { id: newId("gsq"), workspace_id: ws, project_id: pid, observation_id: id, provider: a.provider ?? "gemini", model: "m", query: q, normalized: q.toLowerCase(), created_at: a.at ?? t(10) }));
  }
  return S;
}

async function seedAnswers(db: Db, ws: string, pid: string, runId: string, n: number, f: (i: number) => AnswerSeed = () => ({})) {
  const S: Array<[string, ...unknown[]]> = [];
  for (let i = 0; i < n; i++) S.push(...answerStatements(ws, pid, runId, f(i)));
  for (let i = 0; i < S.length; i += 400) await db.batch(S.slice(i, i + 400));
}

describe("GEO 06 engine searches", () => {
  it("groups the last 30 days by normalized query with engines, answers and last seen; marks only EXACT Search Console matches", async () => {
    const ctx = await setup();
    const run = await seedRun(ctx.db, ctx.ws, ctx.pid, "geo", "completed");
    await seedAnswers(ctx.db, ctx.ws, ctx.pid, run, 3, (i) => ({ provider: i === 2 ? "perplexity" : "gemini", queries: ["Brass Cabinet Knobs", "brass knobs online"], at: t(10 + i) }));
    await seedAnswers(ctx.db, ctx.ws, ctx.pid, run, 1, () => ({ queries: ["old search"], at: new Date(FIXED_NOW.getTime() - 31 * 86_400_000).toISOString() }));
    await seedGsc(ctx.db, ctx.ws, ctx.pid, {
      rows: [
        { query: "brass cabinet knobs", page: `${ORIGIN}/a`, clicks: 4, impressions: 300, position: 12 },
        { query: "brass cabinet knobs", page: `${ORIGIN}/b`, clicks: 1, impressions: 100, position: 14 },
        { query: "brass knobs", page: `${ORIGIN}/a`, clicks: 9, impressions: 900, position: 3 },
      ],
    });
    const r = await build<LiveEngineQueriesInsight>(ctx, "engine_queries");
    expect(r.window.days).toBe(30);
    expect(r.total).toBe(2);
    const knobs = r.rows.find((x) => x.query === "brass cabinet knobs")!;
    expect(knobs).toMatchObject({ answers: 3, engines: ["gemini", "perplexity"], lastSeen: t(12) });
    // Exact match only: summed over the two pages, impression-weighted position.
    expect(knobs.gsc).toMatchObject({ clicks: 5, impressions: 400, position: 12.5, basis: "query_page_rows" });
    expect(r.rows.find((x) => x.query === "brass knobs online")!.gsc).toBeNull();
    expect(r.rows.some((x) => x.query === "old search")).toBe(false);
    expect(r.gscSync).toMatchObject({ window: { start: "2026-09-01", end: "2026-09-28" } });
  });
});

describe("GEO 07 brands in AI answers", () => {
  it("counts n of m analysed discovery answers per engine and brand (mentioned, cited, recommended, negative)", async () => {
    const ctx = await setup();
    const run = await seedRun(ctx.db, ctx.ws, ctx.pid, "geo", "completed");
    await seedAnswers(ctx.db, ctx.ws, ctx.pid, run, 4, (i) => ({
      provider: "gemini",
      self: { mentioned: i < 2 ? 1 : 0, cited: i === 0 ? 1 : 0, status: i === 0 ? "recommended" : i === 1 ? "mentioned_negatively" : "not_mentioned" },
      brands: [{ key: "Brass Co", mentioned: 1, cited: 0, status: "recommended" }],
    }));
    await seedAnswers(ctx.db, ctx.ws, ctx.pid, run, 2, () => ({ provider: "openai_geo", self: { mentioned: 1, cited: 1, status: "listed_neutral" } }));
    // Not counted: failed answers, reputation prompts, answers older than 30 days.
    await seedAnswers(ctx.db, ctx.ws, ctx.pid, run, 1, () => ({ provider: "gemini", status: "failed" }));
    await seedAnswers(ctx.db, ctx.ws, ctx.pid, run, 1, () => ({ provider: "gemini", promptType: "reputation", self: { mentioned: 1, cited: 1 } }));
    await seedAnswers(ctx.db, ctx.ws, ctx.pid, run, 1, () => ({ provider: "gemini", self: { mentioned: 1, cited: 1 }, at: "2026-08-01T00:00:00.000Z" }));
    const r = await build<LiveBrandsInsight>(ctx, "brands");
    expect(r.engines).toEqual(["openai_geo", "gemini"]);
    expect(r.brands.map((b) => b.name)).toEqual(["Residence Example", "Brass Co"]);
    const self = r.brands[0]!;
    expect(self.isSelf).toBe(true);
    expect(self.engines.find((e) => e.provider === "gemini")).toMatchObject({ answers: 4, mentioned: 2, cited: 1, recommended: 1, negative: 1 });
    expect(self.engines.find((e) => e.provider === "openai_geo")).toMatchObject({ answers: 2, mentioned: 2, cited: 2, recommended: 0, negative: 0 });
    expect(self.total).toEqual({ answers: 6, mentioned: 4, cited: 3, recommended: 1, negative: 1 });
    expect(r.brands[1]!.total).toEqual({ answers: 4, mentioned: 4, cited: 0, recommended: 4, negative: 0 });
  });
});

describe("GEO 08 most-cited domains", () => {
  it("groups by resolved host (redirect links by bare-domain title), tags your site and competitors, keeps your row when below the cut", async () => {
    const ctx = await setup();
    const run = await seedRun(ctx.db, ctx.ws, ctx.pid, "geo", "completed");
    const redirect = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc";
    await seedAnswers(ctx.db, ctx.ws, ctx.pid, run, 3, (i) => ({
      provider: i === 0 ? "perplexity" : "gemini",
      citations: [
        { url: "https://www.reviews.example/a", sourceType: "review_site" },
        { url: "https://reviews.example/b", sourceType: "review_site" },
        { url: redirect, title: "brassco.example" },
        { url: redirect, title: "Some article title" },
      ],
    }));
    await seedAnswers(ctx.db, ctx.ws, ctx.pid, run, 1, () => ({ citations: [{ url: `${ORIGIN}/products/knob`, sourceType: "brand_page" }] }));
    const r = await build<LiveCitedDomainsInsight>(ctx, "cited_domains");
    expect(r.answersWithCitations).toBe(4);
    expect(r.unresolved).toBe(3);
    expect(r.rows[0]).toMatchObject({ host: "reviews.example", answers: 3, citations: 6, engines: ["gemini", "perplexity"], sourceTypes: ["review_site"], brand: null, rank: 1 });
    expect(r.rows.find((x) => x.host === "brassco.example")!.brand).toEqual({ key: "Brass Co", isSelf: false });
    expect(r.rows.find((x) => x.host === "shop.example.com")!.brand).toEqual({ key: "self", isSelf: true });
    expect(r.own).toBeNull();
    expect(r.limit).toBe(CITED_DOMAINS.limit);
  });
});

describe("GEO 09 prompt history", () => {
  it("shows each engine's last 8 runs oldest first, matching prompts by text across prompt-set versions", async () => {
    const ctx = await setup();
    const setId = newId("gps");
    await ctx.db.insert("geo_prompt_sets", { id: setId, workspace_id: ctx.ws, project_id: ctx.pid, version: 2, active: 1, created_at: t(0) });
    const prompts = ["Best brass knobs?", "Is brass better than bronze?"];
    for (const [i, text] of prompts.entries()) {
      await ctx.db.insert("geo_prompts", { id: newId("gp"), workspace_id: ctx.ws, project_id: ctx.pid, prompt_set_id: setId, text, prompt_type: "discovery", locale: "en-US", language: "en", approved: 1, position: i });
    }
    const runs: string[] = [];
    for (let i = 0; i < 10; i++) {
      const id = await seedRun(ctx.db, ctx.ws, ctx.pid, "geo", "completed", { created_at: t(i * 100) });
      runs.push(id);
      await seedAnswers(ctx.db, ctx.ws, ctx.pid, id, 1, () => ({ provider: "gemini", text: "best brass knobs", at: t(i * 100 + 5), self: { mentioned: 1, cited: i % 2 } }));
    }
    // Perplexity answered in two runs only: one failed, one not analysed.
    await seedAnswers(ctx.db, ctx.ws, ctx.pid, runs[3]!, 1, () => ({ provider: "perplexity", text: "Best brass knobs?", status: "failed" }));
    await seedAnswers(ctx.db, ctx.ws, ctx.pid, runs[9]!, 1, () => ({ provider: "perplexity", text: "Best brass knobs?", self: null }));
    const r = await build<LivePromptHistoryInsight>(ctx, "prompt_history");
    expect(r.maxRuns).toBe(PROMPT_HISTORY.runsPerEngine);
    expect(r.promptSet).toEqual({ version: 2, label: null });
    const gem = r.engines.find((e) => e.provider === "gemini")!;
    expect(gem.runs.map((x) => x.runId)).toEqual(runs.slice(2));
    const knobs = r.rows.find((x) => x.text === "Best brass knobs?")!;
    expect(knobs.cells.gemini).toEqual(["named", "cited", "named", "cited", "named", "cited", "named", "cited"]);
    expect(r.engines.find((e) => e.provider === "perplexity")!.runs.map((x) => x.runId)).toEqual([runs[3], runs[9]]);
    expect(knobs.cells.perplexity).toEqual(["failed", "not_analysed"]);
    expect(r.rows.find((x) => x.text === "Is brass better than bronze?")!.cells.gemini).toEqual(Array(8).fill("none"));
  });

  it("is setup_required without a prompt set", async () => {
    const ctx = await setup();
    const r = await build<LivePromptHistoryInsight>(ctx, "prompt_history");
    expect(r.state).toBe("setup_required");
    expect(r.rows).toEqual([]);
  });
});

// ------------------------------------------------------------------ sheets and budget
describe("SEO 14 / GEO 10 sheet syncs", () => {
  it("lists syncs with recent change counts; members see them without Sync now", async () => {
    const ctx = await setup();
    const syncId = newId("isync");
    const importId = newId("imp");
    await ctx.db.insert("import_syncs", {
      id: syncId, workspace_id: ctx.ws, project_id: ctx.pid, spreadsheet_id: "s1", spreadsheet_title: '<b>Plan</b>', tab: "Competitors", sheet_tab_id: 4, destination: "competitors",
      mapping_json: "{}", frequency_hours: 24, enabled: 1, next_run_at: t(9000), last_run_at: t(10), last_status: "error", last_error_code: "tab_missing", last_error: "Tab gone",
      created_at: t(0), updated_at: t(10),
    });
    await ctx.db.insert("imports", {
      id: importId, workspace_id: ctx.ws, project_id: ctx.pid, source: "sheets", source_name: "Plan", destination: "competitors", trigger: "sync", sync_id: syncId,
      status: "completed", created_at: t(5),
    });
    for (const action of ["added", "added", "removed"]) {
      await ctx.db.insert("import_changes", { id: newId("ichg"), workspace_id: ctx.ws, project_id: ctx.pid, import_id: importId, destination: "competitors", record_key: newId("k"), action, created_at: t(5) });
    }
    const r = await build<LiveSheetsInsight>(ctx, "sheets");
    expect(r.canManage).toBe(true);
    expect(r.syncs).toHaveLength(1);
    expect(r.syncs[0]).toMatchObject({ id: syncId, spreadsheetTitle: "<b>Plan</b>", lastStatus: "error", lastErrorCode: "tab_missing", enabled: true, prompts: null });
    expect(r.syncs[0]!.recent).toEqual({ days: 7, imports: 1, added: 2, updated: 0, removed: 1 });
    expect(r.syncNowPerHour).toBe(6);
    // A member (not owner) of the workspace cannot Sync now.
    const member = await seedUser(ctx.env);
    await ctx.db.insert("memberships", { workspace_id: ctx.ws, user_id: member.userId, role: "member", created_at: t(0) });
    const m = await build<LiveSheetsInsight>({ ...ctx, u: { ...ctx.u, userId: member.userId } }, "sheets");
    expect(m.canManage).toBe(false);
  });
});

describe("SEO 15 / GEO 11 budget and quotas today", () => {
  it("reads today's project counters (limits from settings when nothing was reserved) and manual runs of the quota", async () => {
    const ctx = await setup();
    const day = FIXED_NOW.toISOString().slice(0, 10);
    await ctx.db.insert("usage_counters", { scope_key: `project:${ctx.pid}`, day, resource: "usd_micros", used: 120000, limit_value: 500000 });
    await ctx.db.insert("usage_counters", { scope_key: `project:${ctx.pid}`, day: "2026-09-29", resource: "provider_calls", used: 59, limit_value: 60 });
    await seedRun(ctx.db, ctx.ws, ctx.pid, "seo", "completed", { created_at: FIXED_NOW.toISOString() });
    await seedRun(ctx.db, ctx.ws, ctx.pid, "geo", "completed", { created_at: FIXED_NOW.toISOString(), trigger: "schedule" });
    const r = await build<LiveBudgetInsight>(ctx, "budget");
    expect(r.day).toBe(day);
    expect(r.project.find((l) => l.resource === "usd_micros")).toEqual({ resource: "usd_micros", label: "Priced spend", used: 120000, limit: 500000, counted: true });
    expect(r.project.find((l) => l.resource === "provider_calls")).toMatchObject({ used: 0, limit: 60, counted: false });
    expect(r.manualRuns).toEqual({ used: 1, limit: 3 });
    // No operator key configured: no global allowance applies.
    expect(r.global).toEqual([]);
    expect(r.keys.every((k) => k.source === null)).toBe(true);
    expect(r.notes.join(" ")).toMatch(/own keys is bounded by these project limits only/);
  });

  it("shows the operator's global allowance only for resources an operator key spends", async () => {
    const ctx = await setup({ TYPESAFE_API_KEY: "op-key" } as Partial<Env>);
    const day = FIXED_NOW.toISOString().slice(0, 10);
    await ctx.db.insert("usage_counters", { scope_key: "global", day, resource: "jev_calls", used: 15, limit_value: 2000 });
    const r = await build<LiveBudgetInsight>(ctx, "budget");
    expect(r.keys.find((k) => k.provider === "typesafe")!.source).toBe("operator_key");
    expect(r.global.map((g) => g.resource)).toEqual(["provider_calls", "jev_calls"]);
    expect(r.global.find((g) => g.resource === "jev_calls")).toMatchObject({ used: 15, limit: 2000, counted: true });
    // A workspace key for Jev: the global cap no longer applies.
    await ctx.db.insert("provider_credentials", { id: newId("cred"), workspace_id: ctx.ws, provider: "typesafe", key_enc: "x", key_hint: "abcd", created_at: t(0), updated_at: t(0) });
    const own = await build<LiveBudgetInsight>(ctx, "budget");
    expect(own.keys.find((k) => k.provider === "typesafe")!.source).toBe("workspace_key");
    expect(own.global).toEqual([]);
  });
});

// ------------------------------------------------------------------ demo
describe("labelled demo seed", () => {
  it("every container has demo rows, labelled simulated", async () => {
    const ctx = await demoCtx();
    for (const kind of LIVE_INSIGHT_KINDS) {
      const r = await build<LiveInsight>(ctx, kind);
      expect(r.state, kind).toBe("demo");
      expect(r.labels[0], kind).toBe(DEMO_LABEL);
    }
    const striking = await build<LiveStrikingInsight>(ctx, "striking");
    expect(striking.rows.map((r) => r.query)).toEqual(["brass table lamp", "pet friendly sofa fabric", "oak side table", "table lamps for reading"]);
    expect(striking.rows[0]!.previous).toMatchObject({ clicks: 21, position: 10.9 });
    const movers = await build<LiveMoversInsight>(ctx, "movers");
    expect(movers.basis).toBe("query_page_rows");
    expect(movers.gainers[0]).toMatchObject({ page: `${DEMO_ORIGIN}/blog/how-to-choose-a-washable-sofa`, clickDelta: 17 });
    expect(movers.losers[0]).toMatchObject({ page: `${DEMO_ORIGIN}/collections/sofas`, clickDelta: -6 });
    const tech = await build<LiveTechnicalInsight>(ctx, "technical");
    expect(tech.total).toBe(6);
    expect(tech.groups[0]).toMatchObject({ severity: "moderate", ruleId: "ECOM-PRODUCT-OFFER-INCOMPLETE", count: 3 });
    const queries = await build<LiveEngineQueriesInsight>(ctx, "engine_queries");
    expect(queries.rows.find((q) => q.query === "oak side table")!.gsc).toMatchObject({ clicks: 22, impressions: 1340, position: 9.3 });
    expect(queries.rows.filter((q) => q.gsc).map((q) => q.query)).toEqual(["oak side table"]);
    const brands = await build<LiveBrandsInsight>(ctx, "brands");
    expect(brands.brands[0]).toMatchObject({ name: "Demo Furnishings", isSelf: true });
    expect(brands.brands[0]!.engines.find((e) => e.provider === "gemini")).toMatchObject({ answers: 5, mentioned: 3, cited: 2 });
    expect(brands.brands[0]!.engines.find((e) => e.provider === "perplexity")).toMatchObject({ answers: 4, mentioned: 0, cited: 1 });
    const cited = await build<LiveCitedDomainsInsight>(ctx, "cited_domains");
    expect(cited.rows[0]).toMatchObject({ host: "demo.example", answers: 3, brand: { key: "self", isSelf: true } });
    expect(cited.rows.find((r) => r.host === "lamp-house.example")!.brand).toEqual({ key: "Example Lamp House", isSelf: false });
    const history = await build<LivePromptHistoryInsight>(ctx, "prompt_history");
    expect(history.engines.map((e) => [e.provider, e.runs.length])).toEqual([
      ["gemini", 1],
      ["perplexity", 1],
    ]);
    expect(history.rows.map((r) => r.cells.gemini![0])).toEqual(["missing", "cited", "named", "cited", "missing"]);
    expect(history.rows.map((r) => r.cells.perplexity![0])).toEqual(["missing", "missing", "cited", "missing", "failed"]);
    const sheets = await build<LiveSheetsInsight>(ctx, "sheets");
    expect(sheets.sheets).toBe("demo");
    expect(sheets.syncs.map((s) => [s.destination, s.enabled, s.lastStatus])).toEqual([
      ["competitors", false, "ok"],
      ["geo_prompts", false, "error"],
    ]);
    expect(sheets.syncs[0]!.recent).toMatchObject({ imports: 1, added: 2 });
    expect(sheets.syncs[1]!.prompts).toMatchObject({ inSet: 2, archived: 1, approved: 2 });
    expect(sheets.syncs[1]!.prompts!.lastAskedAt).not.toBeNull();
    const budget = await build<LiveBudgetInsight>(ctx, "budget");
    expect(budget.manualRuns).toEqual({ used: 0, limit: 3 });
  });

  it("the demo competitor data reads through the existing DataForSEO panel and detail routes (no fetch)", async () => {
    const ctx = await demoCtx();
    const call = caller(ctx.env, ctx.u);
    const panel = (await call(`/projects/${ctx.p.id}/competitors/dataforseo`)).json.data;
    expect(panel.state).toBe("disabled");
    expect(panel.domains.map((d: { domain: string; snapshot: unknown }) => [d.domain, !!d.snapshot])).toEqual([
      ["sofa-sample.example", true],
      ["lamp-house.example", true],
    ]);
    const detail = (await call(`/projects/${ctx.p.id}/competitors/dataforseo/domains/sofa-sample.example`)).json.data;
    expect(detail.keywordGap[0]).toMatchObject({ keyword: "washable slipcover sofa", searchVolume: 1300, competitorPosition: 3 });
    expect(detail.snapshot.costUsd).toBeNull();
  });
});

// ------------------------------------------------------------------ D1 limits
describe("D1 limits: bounded reads over large stored data", () => {
  it(`reads ≥ 2,000 Search Console rows and ≥ 500 answers with every statement LIMITed and under ${D1_MAX_BOUND_PARAMS} parameters`, async () => {
    const ctx: Ctx = await setup();
    const { db, ws, pid } = ctx;
    const run = await seedRun(db, ws, pid, "seo", "completed");
    const syncId = newId("gsc");
    const S: Array<[string, ...unknown[]]> = [
      insertStatement("gsc_syncs", {
        id: syncId, workspace_id: ws, project_id: pid, run_id: run, source: "api", window_start: "2026-09-01", window_end: "2026-09-28",
        prev_window_start: "2026-08-04", prev_window_end: "2026-08-31", rows_fetched: 3000, row_cap: 25000, totals_json: "{}", status: "completed", synced_at: t(2),
      }),
    ];
    for (let i = 0; i < 1200; i++) {
      const page = `${ORIGIN}/p${i % 300}`;
      for (const window of ["current", "previous"] as const) {
        S.push(insertStatement("gsc_metrics", { workspace_id: ws, project_id: pid, sync_id: syncId, window, query: `query ${i}`, page, clicks: (i * (window === "current" ? 7 : 3)) % 41, impressions: 100 + (i % 97), ctr: 0.01, position: 1 + (i % 30) }));
      }
    }
    for (let i = 0; i < S.length; i += 500) await db.batch(S.slice(i, i + 500));
    const crawl = await seedCrawl(db, ws, pid, run, t(1));
    const F: Array<[string, ...unknown[]]> = [];
    for (let i = 0; i < 600; i++) F.push(insertStatement("audit_findings", { id: newId("fnd"), workspace_id: ws, project_id: pid, crawl_run_id: crawl, rule_id: `RULE-${i % 40}`, severity: "minor", url: `${ORIGIN}/f${i}`, detail: "d", created_at: t(3) }));
    await db.batch(F);
    const geoRuns: string[] = [];
    for (let r = 0; r < 12; r++) geoRuns.push(await seedRun(db, ws, pid, "geo", "completed", { created_at: t(r) }));
    const setId = newId("gps");
    await db.insert("geo_prompt_sets", { id: setId, workspace_id: ws, project_id: pid, version: 1, active: 1, created_at: t(0) });
    for (let i = 0; i < 25; i++) {
      await db.insert("geo_prompts", { id: newId("gp"), workspace_id: ws, project_id: pid, prompt_set_id: setId, text: `prompt ${i}`, prompt_type: "discovery", locale: "en-US", language: "en", approved: 1, position: i });
    }
    await seedAnswers(db, ws, pid, geoRuns[0]!, 600, (i) => ({
      provider: ["gemini", "perplexity", "openai_geo"][i % 3],
      text: `prompt ${i % 25}`,
      at: t(20 + (i % 50)),
      self: { mentioned: i % 2, cited: i % 3 === 0 ? 1 : 0 },
      brands: [{ key: "Brass Co", mentioned: i % 5 === 0 ? 1 : 0, cited: 0 }],
      citations: [{ url: `https://site${i % 120}.example/a` }, { url: `${ORIGIN}/x${i % 7}` }],
      queries: [`query ${i % 150}`, `engine search ${i}`],
    }));
    for (const r of geoRuns.slice(1)) await seedAnswers(db, ws, pid, r, 25, (i) => ({ provider: "gemini", text: `prompt ${i}`, self: { mentioned: 1, cited: 0 } }));

    const statements = recordSql(ctx.env);
    for (const kind of LIVE_INSIGHT_KINDS) {
      const r = await build<LiveInsight>(ctx, kind);
      expect(r.kind).toBe(kind);
    }
    // Shared lookups by key (membership, the workspace's credential rows, OAuth connection rows) are single rows by
    // construction; every insight statement carries a LIMIT.
    const keyed = /FROM (memberships|provider_credentials|oauth_connections|workspace_custom_providers)\b/;
    const reads = statements.filter((s) => /^\s*SELECT/i.test(s) && !keyed.test(s));
    expect(reads.length).toBeGreaterThan(20);
    for (const s of reads) expect(s, s.slice(0, 160)).toMatch(/\bLIMIT\b/i);

    const striking = await build<LiveStrikingInsight>(ctx, "striking");
    expect(striking.rows).toHaveLength(STRIKING_DISTANCE.maxRows);
    expect(striking.rows.every((x) => x.position >= 8 && x.position <= 20 && x.previous !== null)).toBe(true);
    const movers = await build<LiveMoversInsight>(ctx, "movers");
    expect(movers.counts.both).toBe(300);
    expect(movers.gainers.length).toBeLessThanOrEqual(MOVERS.top);
    const engineQueries = await build<LiveEngineQueriesInsight>(ctx, "engine_queries");
    expect(engineQueries.total).toBe(750);
    expect(engineQueries.rows).toHaveLength(50);
    expect(engineQueries.rows[0]!.gsc).not.toBeNull();
    const cited = await build<LiveCitedDomainsInsight>(ctx, "cited_domains");
    expect(cited.answersWithCitations).toBe(600);
    expect(cited.rows[0]).toMatchObject({ host: "shop.example.com", answers: 600, brand: { key: "self", isSelf: true } });
    const history = await build<LivePromptHistoryInsight>(ctx, "prompt_history");
    expect(history.engines.find((e) => e.provider === "gemini")!.runs).toHaveLength(8);
    expect(history.rows).toHaveLength(25);
    const tech = await build<LiveTechnicalInsight>(ctx, "technical");
    expect(tech.total).toBe(600);
    expect(tech.groups).toHaveLength(40);
  });
});
