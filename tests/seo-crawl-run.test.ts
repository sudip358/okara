import { describe, expect, it } from "vitest";
import { Hono } from "hono";
// Import the app module first: routes/seo-audit imports requireUser from app.ts (circular at module level).
import { createApp, type AppEnv } from "@worker/app";
import { Db } from "@worker/lib/db";
import { HttpError } from "@worker/lib/errors";
import { runCrawl, runCrawlWith } from "@worker/seo/crawl/run";
import { seoCrawlRoutes } from "@worker/routes/seo-audit";
import type { PageRow, SeoAudit } from "@shared/types";
import { createTestEnv } from "./helpers/env";
import { authHeaders, seedProject, seedUser } from "./helpers/fixtures";
import { makeTestContext, unlimitedBudget } from "./helpers/context";
import { fakeSite, fixture, html, redirect, type FakeRoute } from "./fixtures/crawl/fake-site";

const H = "shop.example.com";
const U = (p: string) => `https://${H}${p}`;

const HOME = `<!doctype html><html><head><title>Residence Example</title><meta name="description" content="Brass hardware.">
<link rel="canonical" href="https://${H}/"></head><body><nav><a href="/collections/pulls">Pulls</a></nav>
<main><h1>Residence Example</h1><p>Solid brass cabinet hardware and lighting, made to order in small batches for homes.</p>
<a href="/products/brass-pull">Brass pull</a> <a href="/gone">Old page</a> <a href="/old-about">About</a> <a href="/private/secret">Secret</a>
<a href="/app">App</a> <a href="https://elsewhere.example.org/">Elsewhere</a> <a href="/image.jpg">img</a></main></body></html>`;

const COLLECTION = `<html><head><title>Pulls</title><meta name="description" content="All pulls."><link rel="canonical" href="https://${H}/collections/pulls"></head>
<body><main><h1>Pulls</h1><div class="grid"><a href="/products/brass-pull">Brass pull</a></div></main></body></html>`;

const ABOUT = `<html><head><title>About</title><meta name="description" content="About us."><link rel="canonical" href="https://${H}/pages/about"></head>
<body><main><h1>About us</h1><p>${"We make hardware by hand in our workshop every day. ".repeat(30)}</p></main></body></html>`;

function sixPageSite(extra: Record<string, FakeRoute> = {}) {
  return fakeSite({
    [U("/robots.txt")]: { status: 200, contentType: "text/plain", body: `User-agent: *\nDisallow: /private/\n\nSitemap: ${U("/sitemap.xml")}\n` },
    [U("/sitemap.xml")]: {
      status: 200,
      contentType: "application/xml",
      body: `<urlset><url><loc>${U("/")}</loc></url><url><loc>${U("/collections/pulls")}</loc></url><url><loc>${U("/private/secret")}</loc></url><url><loc>${U("/blogs/news/how-to-choose")}</loc></url><url><loc>https://169.254.169.254/latest</loc></url></urlset>`,
    },
    [U("/llms.txt")]: { status: 200, contentType: "text/plain", body: "# Residence Example\n> Brass hardware\n" },
    [U("/")]: html(HOME),
    [U("/products/brass-pull")]: html(fixture("product-graph.html")),
    [U("/collections/pulls")]: html(COLLECTION),
    [U("/blogs/news/how-to-choose")]: html(fixture("article-array.html")),
    [U("/app")]: html(fixture("js-app.html")),
    [U("/old-about")]: redirect("/pages/about"),
    [U("/pages/about")]: html(ABOUT),
    [U("/gone")]: { status: 404, contentType: "text/html", body: "<html><body>gone</body></html>" },
    [U("/pages/care")]: html(ABOUT.replace(/About/g, "Care").replace("/pages/about", "/pages/care")),
    [U("/products/brass-knob?variant=123")]: html(fixture("product-graph.html").replace('href="/products/brass-pull"', 'href="/products/brass-knob?variant=123"')),
    ...extra,
  });
}

async function setup(projectOverrides: Record<string, unknown> = {}) {
  const env = createTestEnv({ APP_ORIGIN: "https://app.okara.example" });
  const { workspaceId, userId } = await seedUser(env);
  const projectId = await seedProject(env, workspaceId, projectOverrides);
  const db = new Db(env.DB);
  return { env, db, workspaceId, userId, projectId };
}

describe("seo-crawl runCrawl end-to-end", () => {
  it("crawls a fake site: robots disallow, sitemap, redirects, JS page skipped, findings, compact evidence", async () => {
    const { env, db, workspaceId, projectId } = await setup();
    const site = sixPageSite();
    const budget = unlimitedBudget();
    const ctx = makeTestContext(env, { id: projectId, workspaceId }, { crawlFetch: site.fetch, budget });
    const summary = await runCrawl(ctx);

    expect(summary.status).toBe("completed");
    expect(summary.crawlRunId).toBeTruthy();
    // Never fetched: robots-disallowed page, off-host links, metadata sitemap entry, non-HTML assets.
    const fetched = site.urls();
    expect(fetched).not.toContain(U("/private/secret"));
    expect(fetched.every((u) => new URL(u).hostname === H)).toBe(true);
    expect(fetched).not.toContain(U("/image.jpg"));
    // Same UA token for robots and fetch; redirect manual everywhere.
    for (const c of site.calls) {
      expect(new Headers(c.init?.headers).get("user-agent")).toBe("OkaraBot/0.1 (+https://app.okara.example/bot)");
      expect(c.init?.redirect).toBe("manual");
    }

    const snaps = await db.all<Record<string, unknown>>(
      "SELECT p.url, p.page_type, p.page_type_method, s.* FROM page_snapshots s JOIN pages p ON p.id = s.page_id WHERE s.crawl_run_id = ?",
      summary.crawlRunId,
    );
    const byUrl = new Map(snaps.map((s) => [s.url as string, s]));
    expect(byUrl.get(U("/private/secret"))).toMatchObject({ skipped_reason: "robots_disallowed", status_code: null });
    expect(byUrl.get(U("/app"))).toMatchObject({ skipped_reason: "js_rendered", status_code: 200 });
    expect(byUrl.get(U("/gone"))).toMatchObject({ status_code: 404, skipped_reason: null });
    expect(byUrl.get(U("/old-about"))).toMatchObject({ status_code: 301, final_url: U("/pages/about") });
    expect(byUrl.get(U("/pages/about"))).toMatchObject({ status_code: 200, title: "About" });
    expect(byUrl.get(U("/products/brass-pull"))).toMatchObject({ page_type: "product", page_type_method: "jsonld", author: "Jane Maker", table_count: 1 });
    expect(byUrl.get(U("/collections/pulls"))).toMatchObject({ page_type: "collection", page_type_method: "url_pattern" });
    expect(byUrl.get(U("/"))).toMatchObject({ page_type: "home" });
    // Compact evidence only: no raw HTML stored anywhere in the snapshot.
    for (const s of snaps) {
      for (const v of Object.values(s)) if (typeof v === "string") expect(v).not.toMatch(/<html|<script|<body/i);
      expect(((s.main_text_excerpt as string | null) ?? "").length).toBeLessThanOrEqual(2000);
    }

    const findings = await db.all<{ rule_id: string; url: string | null }>("SELECT rule_id, url FROM audit_findings WHERE crawl_run_id = ? AND workspace_id = ?", summary.crawlRunId, workspaceId);
    const has = (rule: string, url?: string) => findings.some((f) => f.rule_id === rule && (url === undefined || f.url === url));
    expect(has("SEO-STATUS-4XX", U("/gone"))).toBe(true);
    expect(has("SEO-LINK-BROKEN-INTERNAL", U("/"))).toBe(true);
    expect(has("ECOM-COLLECTION-NO-INTRO", U("/collections/pulls"))).toBe(true);
    expect(has("ECOM-VARIANT-NO-CANONICAL", U("/products/brass-knob?variant=123"))).toBe(true);
    expect(has("SEO-ROBOTS-SITEMAP-CONFLICT", U("/private/secret"))).toBe(true);
    expect(has("SEO-TITLE-MISSING", U("/app"))).toBe(false); // skipped pages are not audited
    expect(summary.findings).toBe(findings.length);

    const run = await db.first<{ status: string; pages_crawled: number; pages_skipped: number; robots_json: string; notes_json: string }>(
      "SELECT status, pages_crawled, pages_skipped, robots_json, notes_json FROM crawl_runs WHERE id = ?",
      summary.crawlRunId,
    );
    expect(run!.status).toBe("completed");
    expect(run!.pages_skipped).toBe(2);
    expect(summary.pagesSkipped).toBe(2);
    expect(summary.note).toMatch(/pages crawled; 2 skipped: .*robots_disallowed \(1\)/);
    expect(summary.note).toMatch(/js_rendered \(1\)/);
    const robotsJson = JSON.parse(run!.robots_json);
    expect(robotsJson.robots.status).toBe("ok");
    expect(robotsJson.aiCrawlerAccess.llmsTxt.present).toBe(true);
    expect(robotsJson.sitemap.refused.map((r: { url: string }) => r.url)).toContain("https://169.254.169.254/latest");

    expect(budget.reservations[0]).toMatchObject({ resource: "crawl_pages", amount: 20, state: "settled" });
    expect(ctx.events.some((e) => e.step === "crawl" && e.status === "completed")).toBe(true);
  });

  it("reuses extraction for unchanged content on a re-crawl and keeps user page-type corrections", async () => {
    const { env, db, workspaceId, projectId } = await setup();
    const ctx = makeTestContext(env, { id: projectId, workspaceId }, { crawlFetch: sixPageSite().fetch });
    await runCrawl(ctx);
    await db.run("UPDATE pages SET page_type = 'landing', page_type_method = 'user' WHERE url = ? AND workspace_id = ?", U("/collections/pulls"), workspaceId);
    const second = await runCrawl(makeTestContext(env, { id: projectId, workspaceId }, { crawlFetch: sixPageSite().fetch }));
    const notes = JSON.parse((await db.first<{ notes_json: string }>("SELECT notes_json FROM crawl_runs WHERE id = ?", second.crawlRunId))!.notes_json) as string[];
    expect(notes.some((n) => /unchanged since the previous crawl/.test(n))).toBe(true);
    const page = await db.first<{ page_type: string; page_type_method: string }>("SELECT page_type, page_type_method FROM pages WHERE url = ?", U("/collections/pulls"));
    expect(page).toEqual({ page_type: "landing", page_type_method: "user" });
    // Snapshots were still recorded for the second run.
    const count = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM page_snapshots WHERE crawl_run_id = ?", second.crawlRunId);
    expect(count!.n).toBeGreaterThan(5);
  });

  it("returns setup_required without any fetch when the host is not verified", async () => {
    const { env, db, workspaceId, projectId } = await setup({ verified_host: null, verification_method: null, verified_at: null });
    const site = sixPageSite();
    const ctx = makeTestContext(env, { id: projectId, workspaceId }, { crawlFetch: site.fetch });
    const summary = await runCrawl(ctx);
    expect(summary.status).toBe("setup_required");
    expect(summary.crawlRunId).toBeNull();
    expect(site.calls).toHaveLength(0);
    expect(await db.first("SELECT id FROM crawl_runs WHERE project_id = ?", projectId)).toBeNull();
  });

  it("stops crawling when the run is cancelled", async () => {
    const { env, workspaceId, projectId } = await setup();
    const site = sixPageSite();
    let checks = 0;
    const ctx = makeTestContext(env, { id: projectId, workspaceId }, { crawlFetch: site.fetch, isCancelled: async () => ++checks > 1 });
    const summary = await runCrawl(ctx);
    expect(summary.status).toBe("partial");
    const pageFetches = site.urls().filter((u) => !/robots\.txt|sitemap|llms\.txt/.test(u));
    expect(pageFetches.length).toBeLessThanOrEqual(2);
    expect(summary.pagesCrawled).toBeLessThanOrEqual(2);
  });

  it("respects the project crawl_pages limit and honours crawl-delay", async () => {
    const { env, db, workspaceId, projectId } = await setup();
    await db.run("UPDATE project_limits SET crawl_pages = 3 WHERE project_id = ?", projectId);
    const site = sixPageSite({ [U("/robots.txt")]: { status: 200, contentType: "text/plain", body: "User-agent: OkaraBot\nCrawl-delay: 2\nDisallow: /private/\n\nUser-agent: *\nDisallow: /\n" } });
    const sleeps: number[] = [];
    const ctx = makeTestContext(env, { id: projectId, workspaceId }, { crawlFetch: site.fetch });
    const summary = await runCrawlWith(ctx, { sleep: async (ms) => void sleeps.push(ms), now: () => 0 });
    const pageFetches = site.urls().filter((u) => !/robots\.txt|sitemap|llms\.txt/.test(u));
    expect(pageFetches.length).toBe(3);
    expect(summary.note).toMatch(/page limit 3 reached/);
    expect(sleeps).toEqual([2000, 4000]); // spaced by the crawl-delay (fake clock stays at 0)
    // The specific OkaraBot group applies, not "*" (which disallows everything).
    expect(summary.pagesCrawled).toBeGreaterThan(0);
  });

  it("disallows everything when robots.txt returns 5xx", async () => {
    const { env, workspaceId, projectId } = await setup();
    const site = sixPageSite({ [U("/robots.txt")]: { status: 503, contentType: "text/plain", body: "" } });
    const summary = await runCrawl(makeTestContext(env, { id: projectId, workspaceId }, { crawlFetch: site.fetch }));
    expect(summary.status).toBe("partial");
    expect(summary.pagesCrawled).toBe(0);
    expect(site.urls().filter((u) => !/robots\.txt|llms\.txt/.test(u))).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------ routes

function testApp(env: ReturnType<typeof createTestEnv>, userId: string | null) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", new Db(env.DB));
    c.set("now", new Date());
    c.set("user", userId ? { id: userId, email: "u@example.com", name: null } : null);
    c.set("session", null);
    await next();
  });
  app.route("/", seoCrawlRoutes);
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    throw err;
  });
  return (path: string, init?: RequestInit) => app.request(path, init, env);
}

describe("seo-crawl routes", () => {
  it("GET /seo/audit returns setup_required for an unverified project", async () => {
    const { env, userId, projectId } = await setup({ verified_host: null, verification_method: null, verified_at: null });
    const res = await testApp(env, userId)(`/projects/${projectId}/seo/audit`);
    const body = (await res.json()) as { data: SeoAudit };
    expect(body.data.state).toBe("setup_required");
    expect(body.data.findings).toEqual([]);
    expect(body.data.limitations).toContain("No Core Web Vitals, JS rendering, or index-status data source connected.");
  });

  it("GET /seo/audit returns findings with rule metadata, completeness, skipped list, and AI crawler access", async () => {
    const { env, workspaceId, userId, projectId } = await setup();
    await runCrawl(makeTestContext(env, { id: projectId, workspaceId }, { crawlFetch: sixPageSite().fetch }));
    const res = await testApp(env, userId)(`/projects/${projectId}/seo/audit`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: SeoAudit };
    expect(data.state).toBe("ready");
    expect(data.completeness.note).toMatch(/of \d+ pages crawled; 2 skipped/);
    expect(data.skipped).toEqual(expect.arrayContaining([{ url: U("/app"), reason: "js_rendered" }, { url: U("/private/secret"), reason: "robots_disallowed" }]));
    const f = data.findings.find((x) => x.ruleId === "SEO-STATUS-4XX")!;
    expect(f).toMatchObject({ ruleName: "Client error status", class: "fact", severity: "major", url: U("/gone") });
    expect(f.applicability.length).toBeGreaterThan(10);
    expect(data.findings[0]!.severity).toBe("major"); // sorted by severity (no critical here)
    expect(data.aiCrawlerAccess?.crawlers.length).toBeGreaterThan(0);
    expect(data.limitations[0]).toBe("No Core Web Vitals, JS rendering, or index-status data source connected.");
  });

  it("GET /pages lists pages and PATCH corrects the page type (user method)", async () => {
    const { env, workspaceId, userId, projectId } = await setup();
    await runCrawl(makeTestContext(env, { id: projectId, workspaceId }, { crawlFetch: sixPageSite().fetch }));
    const req = testApp(env, userId);
    const list = ((await (await req(`/projects/${projectId}/pages`)).json()) as { data: PageRow[] }).data;
    const product = list.find((p) => p.url === U("/products/brass-pull"))!;
    expect(product).toMatchObject({ pageType: "product", pageTypeMethod: "jsonld", statusCode: 200 });
    expect(list.find((p) => p.url === U("/app"))!.skippedReason).toBe("js_rendered");

    const patched = await req(`/projects/${projectId}/pages/${product.id}`, { method: "PATCH", body: JSON.stringify({ pageType: "landing" }), headers: { "content-type": "application/json" } });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { data: PageRow }).data).toMatchObject({ id: product.id, pageType: "landing", pageTypeMethod: "user" });

    const bad = await req(`/projects/${projectId}/pages/${product.id}`, { method: "PATCH", body: JSON.stringify({ pageType: "blog" }), headers: { "content-type": "application/json" } });
    expect(bad.status).toBe(400);
    const missing = await req(`/projects/${projectId}/pages/pg_nope`, { method: "PATCH", body: JSON.stringify({ pageType: "other" }), headers: { "content-type": "application/json" } });
    expect(missing.status).toBe(404);
  });

  it("is mounted in the real app stack (session + CSRF)", async () => {
    const { env, projectId } = await setup();
    const env2 = env;
    const a = await seedUser(env2);
    const app = createApp();
    // Not a member of the project's workspace -> 404; the route exists and is session-protected.
    const res = await app.request(`/api/projects/${projectId}/seo/audit`, { headers: authHeaders(a.sessionToken, a.csrfToken) }, env2);
    expect(res.status).toBe(404);
    const anon = await app.request(`/api/projects/${projectId}/seo/audit`, {}, env2);
    expect(anon.status).toBe(401);
  });

  it("enforces tenancy: another workspace's user gets 404 and unauthenticated gets 401", async () => {
    const { env, projectId } = await setup();
    const other = await seedUser(env);
    expect((await testApp(env, other.userId)(`/projects/${projectId}/seo/audit`)).status).toBe(404);
    expect((await testApp(env, other.userId)(`/projects/${projectId}/pages`)).status).toBe(404);
    expect((await testApp(env, null)(`/projects/${projectId}/pages`)).status).toBe(401);
  });
});
