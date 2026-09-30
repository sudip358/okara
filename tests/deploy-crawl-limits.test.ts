/**
 * Deploy readiness: the crawl step stays inside Workers/Workflows resource limits (H2, L7).
 * - D1 round trips per page are bounded (every D1 call is a subrequest).
 * - A wall-clock deadline below the step timeout stops the crawl as 'partial'.
 * - A retried step reuses its crawl_runs row and page reservation.
 * - The failure path is best effort and never masks the original error.
 * - Pathological markup is skipped as too_complex instead of burning the step's CPU.
 */
import { describe, expect, it } from "vitest";
import { Db } from "@worker/lib/db";
import type { Env } from "@worker/env";
import { runCrawlWith } from "@worker/seo/crawl/run";
import { CAPS, extractPage } from "@worker/seo/crawl/extract";
import { createBudget } from "@worker/runs/budget";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";
import { makeTestContext } from "./helpers/context";
import { fakeSite, fixture, html, type FakeRoute } from "./fixtures/crawl/fake-site";

const H = "shop.example.com";
const U = (p: string) => `https://${H}${p}`;

/** Wrap a D1 binding so every executed statement (and each batch) counts as one round trip. */
function countingD1(raw: D1Database, onQuery: () => void): D1Database {
  const wrapStmt = (st: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(st, {
      get(t, p) {
        if (p === "bind") return (...a: unknown[]) => wrapStmt(t.bind(...a));
        const v = (t as unknown as Record<string | symbol, unknown>)[p];
        if (typeof v !== "function") return v;
        if (p === "first" || p === "all" || p === "run" || p === "raw")
          return (...x: unknown[]) => {
            onQuery();
            return (v as (...y: unknown[]) => unknown).apply(t, x);
          };
        return (v as (...y: unknown[]) => unknown).bind(t);
      },
    });
  return new Proxy(raw, {
    get(t, p) {
      if (p === "prepare") return (sql: string) => wrapStmt(t.prepare(sql));
      if (p === "batch")
        return (s: D1PreparedStatement[]) => {
          onQuery();
          return t.batch(s);
        };
      const v = (t as unknown as Record<string | symbol, unknown>)[p];
      return typeof v === "function" ? (v as (...y: unknown[]) => unknown).bind(t) : v;
    },
  });
}

async function setup(crawlPages?: number) {
  const env = createTestEnv({ APP_ORIGIN: "https://app.okara.example" });
  const { workspaceId } = await seedUser(env);
  const projectId = await seedProject(env, workspaceId, { verified_host: H });
  const db = new Db(env.DB);
  if (crawlPages) await db.run("UPDATE project_limits SET crawl_pages = ? WHERE project_id = ?", crawlPages, projectId);
  return { env, db, workspaceId, projectId };
}

function bigSite(pages: number, pageBody?: (i: number) => string) {
  const routes: Record<string, FakeRoute> = {
    [U("/robots.txt")]: { status: 200, contentType: "text/plain", body: `User-agent: *\nAllow: /\nSitemap: ${U("/sitemap.xml")}\n` },
    [U("/sitemap.xml")]: {
      status: 200,
      contentType: "application/xml",
      body: `<urlset>${Array.from({ length: pages }, (_, i) => `<url><loc>${U(`/p/${i}`)}</loc></url>`).join("")}</urlset>`,
    },
  };
  const body =
    pageBody ??
    ((i: number) =>
      `<html><head><title>Page ${i}</title><meta name="description" content="d${i}"></head><body><main><h1>Page ${i}</h1><p>${"Brass hardware words for the page content here. ".repeat(40)}</p>${Array.from({ length: 20 }, (_, j) => `<a href="/p/${(i + j) % pages}">Link ${j}</a>`).join(" ")}</main></body></html>`);
  routes[U("/")] = html(body(9999));
  for (let i = 0; i < pages; i++) routes[U(`/p/${i}`)] = html(body(i));
  return fakeSite(routes);
}

async function seedRun(db: Db, workspaceId: string, projectId: string): Promise<string> {
  const runId = "run_retry_1";
  await db.insert("agent_runs", { id: runId, workspace_id: workspaceId, project_id: projectId, agent: "seo", trigger: "manual", idempotency_key: `k:${runId}`, status: "running", created_at: FIXED_NOW.toISOString() });
  return runId;
}

describe("crawl D1 round trips (H2)", () => {
  it("a 200-page crawl costs at most 3 D1 queries per page on average", async () => {
    const { env, workspaceId, projectId } = await setup(200);
    let queries = 0;
    const counted: Env = { ...env, DB: countingD1(env.DB, () => queries++) };
    const db = new Db(counted.DB);
    const site = bigSite(250);
    // In production isCancelled is a D1 read of agent_runs.
    const ctx = makeTestContext(counted, { id: projectId, workspaceId }, { db, crawlFetch: site.fetch, isCancelled: async () => (await db.first("SELECT 1 AS one"), false) });
    const summary = await runCrawlWith(ctx, {});
    expect(summary.status).toBe("completed");
    expect(summary.pagesCrawled).toBe(200);
    const perPage = queries / 200;
    // Before: upsert + SELECT + previousExtraction + snapshot INSERT + isCancelled every turn (~5.1/page).
    expect(perPage).toBeLessThanOrEqual(3);
    // Page fetches + D1 queries + robots/sitemap/llms stay far below the configured subrequest cap.
    expect(queries + site.calls.length).toBeLessThan(1000);
    // Every page still has its snapshot (batched writes are flushed).
    const n = await new Db(env.DB).first<{ n: number }>("SELECT COUNT(*) AS n FROM page_snapshots WHERE crawl_run_id = ?", summary.crawlRunId);
    expect(n!.n).toBe(200);
  });

  it("keeps user page-type corrections with the single-statement upsert", async () => {
    const { env, db, workspaceId, projectId } = await setup(5);
    await runCrawlWith(makeTestContext(env, { id: projectId, workspaceId }, { crawlFetch: bigSite(4).fetch }), {});
    await db.run("UPDATE pages SET page_type = 'landing', page_type_method = 'user' WHERE url = ?", U("/p/1"));
    const second = await runCrawlWith(makeTestContext(env, { id: projectId, workspaceId }, { crawlFetch: bigSite(4).fetch }), {});
    const row = await db.first<{ page_type: string; n: number }>(
      "SELECT p.page_type, (SELECT COUNT(*) FROM pages WHERE url = ?) AS n FROM pages p JOIN page_snapshots s ON s.page_id = p.id WHERE p.url = ? AND s.crawl_run_id = ?",
      U("/p/1"),
      U("/p/1"),
      second.crawlRunId,
    );
    expect(row).toEqual({ page_type: "landing", n: 1 });
  });
});

describe("crawl wall-clock deadline (H2)", () => {
  it("stops enqueuing at the deadline and records the crawl as partial with a note", async () => {
    const { env, db, workspaceId, projectId } = await setup(50);
    const site = bigSite(40);
    let t = 0;
    const ctx = makeTestContext(env, { id: projectId, workspaceId }, { crawlFetch: site.fetch });
    // Each clock read advances one second; the budget allows about ten reads.
    const summary = await runCrawlWith(ctx, { now: () => (t += 1000), deadlineMs: 10_000 });
    expect(summary.status).toBe("partial");
    expect(summary.note).toMatch(/crawl time budget reached/);
    const pageFetches = site.urls().filter((u) => /\/p\/|\/$/.test(new URL(u).pathname));
    expect(pageFetches.length).toBeLessThan(20);
    const run = await db.first<{ status: string; notes_json: string }>("SELECT status, notes_json FROM crawl_runs WHERE id = ?", summary.crawlRunId);
    expect(run!.status).toBe("partial");
    expect(JSON.parse(run!.notes_json).some((n: string) => /time budget/.test(n))).toBe(true);
  });
});

describe("crawl step retries (H2)", () => {
  it("a retried step reuses the run's crawl_runs row and its page reservation", async () => {
    const { env, db, workspaceId, projectId } = await setup(10);
    const runId = await seedRun(db, workspaceId, projectId);
    const budget = () => createBudget(db, env, { workspaceId, projectId, runId }, () => FIXED_NOW);

    // Attempt 1 dies right after creating its row (as if the invocation were torn down).
    const dying = makeTestContext(env, { id: projectId, workspaceId }, {
      runId,
      budget: budget(),
      crawlFetch: bigSite(8).fetch,
      log: {
        async event(_step, status) {
          if (status === "started") throw new Error("Too many subrequests.");
        },
      },
    });
    await expect(runCrawlWith(dying, {})).rejects.toThrow(/Too many subrequests/);

    // Attempt 2 (Workflows retry): same run id.
    const site = bigSite(8);
    const retry = await runCrawlWith(makeTestContext(env, { id: projectId, workspaceId }, { runId, budget: budget(), crawlFetch: site.fetch }), {});
    expect(retry.status).toBe("completed");

    const runs = await db.all<{ id: string; status: string }>("SELECT id, status FROM crawl_runs WHERE run_id = ?", runId);
    expect(runs).toEqual([{ id: retry.crawlRunId, status: "completed" }]);
    const resv = await db.all<{ status: string; settled_amount: number }>("SELECT status, settled_amount FROM usage_reservations WHERE run_id = ? AND resource = 'crawl_pages'", runId);
    expect(resv).toHaveLength(1);
    expect(resv[0]!.status).toBe("settled");
    const used = await db.first<{ used: number }>("SELECT used FROM usage_counters WHERE scope_key = ? AND resource = 'crawl_pages'", `project:${projectId}`);
    expect(used!.used).toBe(resv[0]!.settled_amount);

    // Attempt 3 after the crawl finished: stored result, nothing fetched or reserved.
    const again = bigSite(8);
    const third = await runCrawlWith(makeTestContext(env, { id: projectId, workspaceId }, { runId, budget: budget(), crawlFetch: again.fetch }), {});
    expect(third).toMatchObject({ crawlRunId: retry.crawlRunId, status: "completed", pagesCrawled: retry.pagesCrawled, findings: retry.findings, note: retry.note });
    expect(again.calls).toHaveLength(0);
    expect(await db.all("SELECT id FROM usage_reservations WHERE run_id = ?", runId)).toHaveLength(1);
  });

  it("the failure path is best effort: cleanup errors do not mask the original error", async () => {
    const { env, workspaceId, projectId } = await setup(30);
    let queries = 0;
    let exhausted = false;
    const failing: Env = {
      ...env,
      DB: countingD1(env.DB, () => {
        if (++queries > 25) {
          exhausted = true;
          throw new Error("Too many subrequests.");
        }
      }),
    };
    const ctx = makeTestContext(failing, { id: projectId, workspaceId }, {
      crawlFetch: bigSite(30).fetch,
      log: {
        async event() {
          if (exhausted) throw new Error("Too many subrequests.");
        },
      },
    });
    const summary = await runCrawlWith(ctx, {});
    expect(summary.status).toBe("failed");
    expect(summary.note).toMatch(/Too many subrequests/);
  });
});

describe("extraction complexity budget (L7)", () => {
  it("bails out quickly on pathological unclosed markup", () => {
    const evil = "<html><body>" + "<div><p>text <a href='/x'>a".repeat(80_000); // ~2 MB, never closed
    const t = performance.now();
    const x = extractPage(evil, U("/evil"));
    expect(performance.now() - t).toBeLessThan(1000);
    expect(x.tooComplex).toBe(true);
  });

  it("leaves normal and moderately nested pages unchanged", () => {
    for (const f of ["product-graph.html", "article-array.html", "js-app.html"]) {
      expect(extractPage(fixture(f), U("/x"))).not.toHaveProperty("tooComplex");
    }
    const depth = CAPS.maxDepth - 10;
    const nested = `<html><body><main>${"<div>".repeat(depth)}<p>Deep brass hardware sentence content here.</p>${"</div>".repeat(depth)}</main></body></html>`;
    const x = extractPage(nested, U("/deep"));
    expect(x).not.toHaveProperty("tooComplex");
    expect(x.firstParagraph).toBe("Deep brass hardware sentence content here.");
  });

  it("the crawler records a too-complex page as skipped", async () => {
    const { env, db, workspaceId, projectId } = await setup(5);
    const site = bigSite(3, (i) => (i === 1 ? "<html><body>" + "<div><b>x ".repeat(5000) : `<html><head><title>P${i}</title></head><body><main><p>Words here ${i}.</p><a href="/p/1">one</a></main></body></html>`));
    const summary = await runCrawlWith(makeTestContext(env, { id: projectId, workspaceId }, { crawlFetch: site.fetch }), {});
    expect(summary.note).toMatch(/too_complex \(1\)/);
    const snap = await db.first<{ skipped_reason: string; title: string | null }>(
      "SELECT s.skipped_reason, s.title FROM page_snapshots s JOIN pages p ON p.id = s.page_id WHERE p.url = ? AND s.crawl_run_id = ?",
      U("/p/1"),
      summary.crawlRunId,
    );
    expect(snap).toEqual({ skipped_reason: "too_complex", title: null });
  });
});
