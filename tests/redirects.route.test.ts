import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
// Import the app module first (route modules reference AppEnv from app.ts).
import { createApp, type AppEnv } from "@worker/app";
import { Db } from "@worker/lib/db";
import { HttpError } from "@worker/lib/errors";
import { newId } from "@worker/lib/ids";
import { seedDemoProject } from "@worker/demo/seed";
import type { Env } from "@worker/env";
import type { DecisionAnswer, DecisionProvider, DecisionRequest, DecisionResult } from "@worker/providers/types";
import { buildDecisionsForWorkspace } from "@worker/redirects/decisions";
import { LABEL_REVIEW_ONLY, LABEL_UNCERTAIN } from "@worker/redirects/service";
import { MAX_REDIRECT_BODY_BYTES, redirectRoutes, REDIRECT_MAP_RATE_LIMIT, setRedirectDecisionsFactory } from "@worker/routes/redirects";
import type { RedirectMapResult } from "@shared/types";
import { createTestEnv } from "./helpers/env";
import { authHeaders, FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";

const H = "shop.example.com";

afterEach(() => setRedirectDecisionsFactory(null));

async function setup(projectOverrides: Record<string, unknown> = {}, envOverrides: Partial<Env> = {}) {
  const env = createTestEnv(envOverrides);
  const u = await seedUser(env);
  const projectId = await seedProject(env, u.workspaceId, projectOverrides);
  return { env, projectId, ...u };
}

interface SeedPage {
  path: string;
  status?: number;
  title?: string | null;
  h1?: string[];
  finalUrl?: string;
  skipped?: string | null;
}

async function seedCrawl(env: Env, workspaceId: string, projectId: string, pages: SeedPage[], status = "completed") {
  const db = new Db(env.DB);
  const crawlId = newId("crawl");
  const at = FIXED_NOW.toISOString();
  await db.insert("crawl_runs", { id: crawlId, workspace_id: workspaceId, project_id: projectId, status, pages_limit: 20, pages_crawled: pages.length, started_at: at, finished_at: at });
  for (const p of pages) {
    const pageId = newId("pg");
    const url = `https://${H}${p.path}`;
    await db.insert("pages", { id: pageId, workspace_id: workspaceId, project_id: projectId, url, page_type: "other", page_type_method: "url_pattern", first_seen_at: at, last_crawled_at: at });
    await db.insert("page_snapshots", {
      id: newId("snap"),
      workspace_id: workspaceId,
      project_id: projectId,
      page_id: pageId,
      crawl_run_id: crawlId,
      status_code: p.status ?? 200,
      final_url: p.finalUrl ?? url,
      skipped_reason: p.skipped ?? null,
      title: p.title ?? null,
      h1_json: JSON.stringify(p.h1 ?? []),
      fetched_at: at,
    });
  }
  return crawlId;
}

/** Route under test with a fixed clock and a signed-in user (null = anonymous). */
function testApp(env: Env, userId: string | null) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", new Db(env.DB));
    c.set("now", FIXED_NOW);
    c.set("user", userId ? { id: userId, email: "u@example.com", name: null } : null);
    c.set("session", null);
    await next();
  });
  app.route("/", redirectRoutes);
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as 400);
    throw err;
  });
  return app;
}

async function post(env: Env, userId: string | null, projectId: string, body: unknown, raw?: string) {
  const res = await testApp(env, userId).request(`/projects/${projectId}/seo/redirect-map`, { method: "POST", body: raw ?? JSON.stringify(body), headers: { "Content-Type": "application/json" } }, env);
  return { res, body: (await res.json()) as { data: RedirectMapResult; error?: { code: string; message: string; details?: unknown } } };
}

function choice(c: string, confidence: number): DecisionAnswer {
  return { type: "choice", choice: c, confidence, probabilities: { [c]: confidence, none: Math.max(0, 1 - confidence) } };
}

function fakeProvider(answer: (key: string, req: DecisionRequest) => DecisionAnswer | undefined) {
  const requests: DecisionRequest[] = [];
  const provider: DecisionProvider = {
    name: "typesafe",
    async decide(req): Promise<DecisionResult> {
      requests.push(req);
      const answers: Record<string, DecisionAnswer | undefined> = {};
      for (const k of Object.keys(req.questions)) answers[k] = answer(k, req);
      return { provider: "typesafe", model: "jev-test", answers, usage: { inputTokens: 1, outputTokens: 1 } };
    },
    async test() {
      return { ok: true, detail: "fake" };
    },
  };
  return { provider, requests };
}

const CRAWL: SeedPage[] = [
  { path: "/", title: "Shop Example | Brass hardware" },
  { path: "/products/brass-cabinet-knob", title: "Brass Cabinet Knob | Shop Example", h1: ["Brass Cabinet Knob"] },
  { path: "/products/brass-drawer-pull", title: "Brass Drawer Pull | Shop Example", h1: ["Brass Drawer Pull"] },
  { path: "/collections/cabinet-hardware", title: "Cabinet Hardware | Shop Example" },
  { path: "/pages/about", title: "About | Shop Example" },
  { path: "/products/retired-thing", status: 404, title: "Not found" },
  { path: "/products/moved", status: 200, finalUrl: "https://elsewhere.example/moved" },
];

describe("POST /projects/:pid/seo/redirect-map", () => {
  it("setup_required when there is no crawl and no newUrls", async () => {
    const { env, userId, projectId } = await setup();
    const { res, body } = await post(env, userId, projectId, { oldUrls: ["/old-page"] });
    expect(res.status).toBe(200);
    expect(body.data.state).toBe("setup_required");
    expect(body.data.rows).toEqual([]);
    expect(body.data.shopifyCsv).toBe("Redirect from,Redirect to\n");
    expect(body.data.labels.slice(0, 2)).toEqual([LABEL_REVIEW_ONLY, LABEL_UNCERTAIN]);
    expect(body.data.labels.join(" ")).toMatch(/No crawl yet/);
  });

  it("setup_required for an unverified project", async () => {
    const { env, userId, projectId } = await setup({ verified_host: null, verified_at: null, verification_method: null });
    const { body } = await post(env, userId, projectId, { oldUrls: ["/old-page"], newUrls: ["/new-page"] });
    expect(body.data.state).toBe("setup_required");
    expect(body.data.rows).toEqual([]);
  });

  it("without Jev: latest crawl 2xx URLs; exact/slug matches are auto (confidence null); the rest is review with a shortlist", async () => {
    const { env, userId, projectId, workspaceId } = await setup();
    await seedCrawl(env, workspaceId, projectId, CRAWL);
    const factory = vi.fn(async () => null);
    setRedirectDecisionsFactory(factory);
    const { res, body } = await post(env, userId, projectId, {
      oldUrls: [
        "https://shop.example.com/collections/knobs/products/brass-cabinet-knob",
        "/shop/brass-drawer-pulls.html",
        "/old/brass-knobs-and-pulls",
        "/products/brass-cabinet-knob",
      ],
    });
    expect(res.status).toBe(200);
    expect(factory).toHaveBeenCalledTimes(1);
    const d = body.data;
    expect(d.state).toBe("ready");
    expect(d.rows[0]).toMatchObject({ from: "/collections/knobs/products/brass-cabinet-knob", to: `https://${H}/products/brass-cabinet-knob`, method: "exact_path", confidence: null, tier: null, status: "auto" });
    expect(d.rows[1]).toMatchObject({ from: "/shop/brass-drawer-pulls.html", to: `https://${H}/products/brass-drawer-pull`, method: "normalized_slug", confidence: null, status: "auto" });
    expect(d.rows[2]).toMatchObject({ from: "/old/brass-knobs-and-pulls", to: null, method: "none", confidence: null, tier: null, status: "review" });
    const shortlistUrls = d.rows[2]!.candidates.map((c) => c.url);
    expect(shortlistUrls.length).toBeGreaterThan(0);
    expect(shortlistUrls.length).toBeLessThanOrEqual(5);
    expect(shortlistUrls).toContain(`https://${H}/products/brass-cabinet-knob`);
    // 404 pages and pages that redirected off the host are never candidates.
    expect(shortlistUrls).not.toContain(`https://${H}/products/retired-thing`);
    expect(shortlistUrls.some((u) => u.includes("elsewhere.example"))).toBe(false);
    // Same path on the new site: auto, but no CSV row (it would loop).
    expect(d.rows[3]).toMatchObject({ method: "exact_path", status: "auto" });
    expect(d.rows[3]!.note).toMatch(/no redirect row is exported/);
    expect(d.counts).toEqual({ auto: 3, review: 1, noMatch: 0 });
    expect(d.shopifyCsv).toBe(
      "Redirect from,Redirect to\n/collections/knobs/products/brass-cabinet-knob,/products/brass-cabinet-knob\n/shop/brass-drawer-pulls.html,/products/brass-drawer-pull\n",
    );
    expect(d.labels.slice(0, 2)).toEqual([LABEL_REVIEW_ONLY, LABEL_UNCERTAIN]);
    expect(d.labels.join(" ")).toMatch(/not configured/);
  });

  it("with Jev: act -> auto with confidence (and in the CSV); flag -> review; none (even at act) -> no_match", async () => {
    const { env, userId, projectId, workspaceId, db } = await setup();
    await seedCrawl(env, workspaceId, projectId, CRAWL);
    const { provider, requests } = fakeProvider((key) => (key === "old_0" ? choice("c0", 0.92) : key === "old_1" ? choice("c0", 0.55) : choice("none", 0.96)));
    setRedirectDecisionsFactory(async () => provider);
    const { body } = await post(env, userId, projectId, { oldUrls: ["/old/brass-cabinet-knobs-sale", "/old/brass-pulls-sale", "/old/cabinet-gift-set"] });
    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0]!.questions)).toEqual(["old_0", "old_1", "old_2"]);
    const d = body.data;
    expect(d.rows[0]).toMatchObject({ method: "jev", status: "auto", tier: "act", confidence: 0.92 });
    expect(d.rows[0]!.to).toBe(d.rows[0]!.candidates[0]!.url);
    expect(d.rows[1]).toMatchObject({ method: "jev", status: "review", tier: "flag", confidence: 0.55 });
    expect(d.rows[1]!.note).toContain("Check this yourself");
    expect(d.rows[2]).toMatchObject({ method: "jev", status: "no_match", to: null, tier: "act" });
    expect(d.counts).toEqual({ auto: 1, review: 1, noMatch: 1 });
    expect(d.shopifyCsv.trim().split("\n")).toEqual(["Redirect from,Redirect to", `/old/brass-cabinet-knobs-sale,${new URL(d.rows[0]!.to!).pathname}`]);
    expect(d.labels.join(" ")).toMatch(/Jev \(typesafe, model jev-test\) answered 3 of 3/);
    const recs = await db.all<{ candidate_key: string }>("SELECT candidate_key FROM decision_records WHERE workspace_id = ? AND project_id = ? ORDER BY candidate_key", workspaceId, projectId);
    expect(recs.map((r) => r.candidate_key)).toEqual(["redirect:/old/brass-cabinet-knobs-sale", "redirect:/old/brass-pulls-sale", "redirect:/old/cabinet-gift-set"]);
  });

  it("useJev=false skips Jev entirely (deterministic only, the rest is review)", async () => {
    const { env, userId, projectId, workspaceId } = await setup();
    await seedCrawl(env, workspaceId, projectId, CRAWL);
    const factory = vi.fn(async () => fakeProvider(() => choice("c0", 0.99)).provider);
    setRedirectDecisionsFactory(factory);
    const { body } = await post(env, userId, projectId, { oldUrls: ["/old/brass-knobs-sale"], useJev: false });
    expect(factory).not.toHaveBeenCalled();
    expect(body.data.rows[0]).toMatchObject({ status: "review", method: "none", confidence: null });
    expect(body.data.rows[0]!.candidates.length).toBeGreaterThan(0);
    expect(body.data.labels.join(" ")).toMatch(/turned off/);
  });

  it("provided newUrls: cross-host and non-http(s) new URLs are rejected (ignored, labelled); all rejected -> 400", async () => {
    const { env, userId, projectId } = await setup();
    setRedirectDecisionsFactory(async () => null);
    const { body } = await post(env, userId, projectId, {
      oldUrls: ["/old/linen-sofa"],
      newUrls: ["https://evil.example/products/linen-sofa", "javascript:alert(1)", "https://www.shop.example.com/products/linen-sofa-x", "/products/linen-sofa"],
    });
    expect(body.data.state).toBe("ready");
    expect(body.data.rows[0]).toMatchObject({ to: `https://${H}/products/linen-sofa`, method: "normalized_slug", status: "auto", candidates: [] });
    expect(JSON.stringify(body.data.rows)).not.toContain("evil.example");
    expect(JSON.stringify(body.data.rows)).not.toContain("www.shop.example.com");
    expect(body.data.shopifyCsv).toBe("Redirect from,Redirect to\n/old/linen-sofa,/products/linen-sofa\n");
    expect(body.data.labels.join(" ")).toMatch(/1 provided; 3 ignored/);

    const all = await post(env, userId, projectId, { oldUrls: ["/old"], newUrls: ["https://evil.example/x"] });
    expect(all.res.status).toBe(400);
    expect(all.body.error?.code).toBe("bad_request");
  });

  it("old entries that are not paths/URLs on the project host become error rows (no_match, never exported)", async () => {
    const { env, userId, projectId } = await setup();
    setRedirectDecisionsFactory(async () => null);
    const { body } = await post(env, userId, projectId, {
      oldUrls: ["javascript:alert(1)", "https://other.example/old", "https://www.shop.example.com/old-sofa", "/old-sofa?ref=x", ""],
      newUrls: ["/products/old-sofa"],
    });
    const rows = body.data.rows;
    expect(rows).toHaveLength(4); // blank line skipped
    expect(rows[0]).toMatchObject({ from: "javascript:alert(1)", to: null, status: "no_match", method: "none" });
    expect(rows[0]!.note).toMatch(/^Not processed: Only http\(s\)/);
    expect(rows[1]).toMatchObject({ status: "no_match" });
    expect(rows[1]!.note).toMatch(/Not processed: Not on shop\.example\.com/);
    expect(rows[2]).toMatchObject({ from: "/old-sofa", status: "auto", method: "normalized_slug" });
    expect(rows[3]).toMatchObject({ from: "/old-sofa", status: "no_match" });
    expect(rows[3]!.note).toMatch(/Duplicate of entry 3/);
    expect(body.data.shopifyCsv).toBe("Redirect from,Redirect to\n/old-sofa,/products/old-sofa\n");
  });

  it("CSV is paths only and properly escaped", async () => {
    const { env, userId, projectId } = await setup();
    setRedirectDecisionsFactory(async () => null);
    const { body } = await post(env, userId, projectId, {
      oldUrls: ['https://shop.example.com/sale/red,blue-"lamp"-set'],
      newUrls: ["https://shop.example.com/products/red-blue-lamp-set?variant=2"],
    });
    expect(body.data.rows[0]).toMatchObject({ status: "auto", method: "normalized_slug" });
    const lines = body.data.shopifyCsv.split("\n");
    expect(lines[0]).toBe("Redirect from,Redirect to");
    expect(lines[1]).toBe('"/sale/red,blue-%22lamp%22-set",/products/red-blue-lamp-set?variant=2');
    expect(body.data.shopifyCsv).not.toContain("https://");
  });

  it("demo project: runs on the demo crawl URLs, state demo, Jev never called", async () => {
    const env = createTestEnv({ DEMO_MODE: "true" });
    const u = await seedUser(env);
    const db = new Db(env.DB);
    const demo = await seedDemoProject(env, db, u.userId, FIXED_NOW);
    const factory = vi.fn(async () => fakeProvider(() => choice("c0", 0.99)).provider);
    setRedirectDecisionsFactory(factory);
    const { body } = await post(env, u.userId, demo.id, { oldUrls: ["/shop/linen-slipcover-sofa.html", "/old/washable-sofas-guide"] });
    expect(factory).not.toHaveBeenCalled();
    expect(body.data.state).toBe("demo");
    expect(body.data.rows[0]).toMatchObject({ to: "https://demo.example/products/linen-slipcover-sofa", method: "normalized_slug", status: "auto" });
    expect(body.data.rows[1]).toMatchObject({ status: "review", method: "none" });
    expect(body.data.rows[1]!.candidates.every((c) => c.url.startsWith("https://demo.example/"))).toBe(true);
    expect(body.data.labels.join(" ")).toMatch(/Demo data - simulated run/);
  });

  it("cross-tenant access is 404 and runs nothing", async () => {
    const a = await setup();
    const b = await seedUser(a.env, { workspaceName: "Other" });
    const factory = vi.fn(async () => null);
    setRedirectDecisionsFactory(factory);
    const { res, body } = await post(a.env, b.userId, a.projectId, { oldUrls: ["/x"], newUrls: ["/y"] });
    expect(res.status).toBe(404);
    expect(body.error?.code).toBe("not_found");
    expect(factory).not.toHaveBeenCalled();
    const anon = await post(a.env, null, a.projectId, { oldUrls: ["/x"] });
    expect(anon.res.status).toBe(401);
  });

  it("rate limit: 5 requests per minute per user and project, then 429 with Retry-After", async () => {
    const { env, userId, projectId } = await setup();
    setRedirectDecisionsFactory(async () => null);
    for (let i = 0; i < REDIRECT_MAP_RATE_LIMIT.limit; i++) {
      const { res } = await post(env, userId, projectId, { oldUrls: ["/a"], newUrls: ["/b"] });
      expect(res.status).toBe(200);
    }
    const { res, body } = await post(env, userId, projectId, { oldUrls: ["/a"], newUrls: ["/b"] });
    expect(res.status).toBe(429);
    expect(body.error?.code).toBe("rate_limited");
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("validates the body: 1..500 old URLs, <= 2,048 chars each, strict keys, and a size cap", async () => {
    const { env, userId, workspaceId } = await setup();
    setRedirectDecisionsFactory(async () => null);
    // A fresh project per case keeps each request inside its own rate-limit window.
    const expectStatus = async (status: number, body: unknown, raw?: string) => {
      const pid = await seedProject(env, workspaceId);
      const r = await post(env, userId, pid, body, raw);
      expect(r.res.status).toBe(status);
      return r;
    };
    await expectStatus(400, { oldUrls: Array.from({ length: 501 }, (_, i) => `/p${i}`) });
    await expectStatus(400, { oldUrls: [] });
    await expectStatus(400, { oldUrls: [`/${"a".repeat(2048)}`] });
    await expectStatus(400, { oldUrls: ["/a"], sneaky: true });
    await expectStatus(400, { oldUrls: ["/a"], newUrls: Array.from({ length: 5001 }, (_, i) => `/n${i}`) });
    await expectStatus(400, { oldUrls: ["/a"], useJev: "yes" });
    await expectStatus(400, { oldUrls: ["  ", ""], newUrls: ["/b"] });
    await expectStatus(400, null, "{not json");
    await expectStatus(413, null, JSON.stringify({ oldUrls: ["/a"], newUrls: ["/b".padEnd(MAX_REDIRECT_BODY_BYTES, "x")] }));
    await expectStatus(200, { oldUrls: Array.from({ length: 500 }, (_, i) => `/p${i}`), newUrls: ["/b"] });
  });

  it("real TypeSafe adapter + project budget: 45 unresolved -> 2 calls, then the budget stops Jev and the rest is review", async () => {
    const { env, userId, projectId, workspaceId, db } = await setup({}, { TYPESAFE_API_KEY: "ts-test-key" });
    await db.run("UPDATE project_limits SET provider_calls_per_day = 4 WHERE project_id = ?", projectId);
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      seen.push(url);
      const req = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
      const answers = Object.fromEntries(Object.keys(req.questions).map((k) => [k, { type: "choice", choice: "c0", confidence: 0.9, probabilities: { c0: 0.9, none: 0.1 } }]));
      return new Response(JSON.stringify({ model: "jev-2026-09-15", answers, usage: { input_tokens: 100, output_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    setRedirectDecisionsFactory((e, d, ws, pid) => buildDecisionsForWorkspace(e, d, ws, pid, { fetchImpl }));

    const oldUrls = Array.from({ length: 45 }, (_, i) => `/legacy/brass-knob-${i + 1}`);
    const { res, body } = await post(env, userId, projectId, { oldUrls, newUrls: ["/products/brass-knob-large", "/products/brass-knob-small"] });
    expect(res.status).toBe(200);
    expect(seen).toEqual(["https://api.typesafe.ai/v1/systemone", "https://api.typesafe.ai/v1/systemone"]);
    const rows = body.data.rows;
    expect(rows.slice(0, 40).every((r) => r.status === "auto" && r.method === "jev" && r.confidence === 0.9)).toBe(true);
    expect(rows.slice(40).every((r) => r.status === "review" && /daily Jev budget/.test(r.note ?? ""))).toBe(true);
    expect(body.data.counts).toEqual({ auto: 40, review: 5, noMatch: 0 });
    expect(body.data.labels.join(" ")).toMatch(/Jev budget reached/);

    const calls = await db.all<{ provider: string; purpose: string; status: string; project_id: string; run_id: string | null }>(
      "SELECT provider, purpose, status, project_id, run_id FROM provider_calls WHERE workspace_id = ?",
      workspaceId,
    );
    expect(calls).toEqual([
      { provider: "typesafe", purpose: "seo.redirect_map", status: "ok", project_id: projectId, run_id: null },
      { provider: "typesafe", purpose: "seo.redirect_map", status: "ok", project_id: projectId, run_id: null },
    ]);
    const jev = await db.first<{ used: number }>("SELECT used FROM usage_counters WHERE scope_key = ? AND resource = 'jev_calls'", `project:${projectId}`);
    expect(jev?.used).toBe(2);
  });

  it("is mounted on the real app behind session + CSRF", async () => {
    const { env, projectId, sessionToken, csrfToken } = await setup({}, { APP_ORIGIN: "http://localhost:5173" });
    setRedirectDecisionsFactory(async () => null);
    const app = createApp();
    const ok = await app.request(`/api/projects/${projectId}/seo/redirect-map`, { method: "POST", headers: authHeaders(sessionToken, csrfToken), body: JSON.stringify({ oldUrls: ["/a"], newUrls: ["/a-b"] }) }, env);
    expect(ok.status).toBe(200);
    const noCsrf = await app.request(`/api/projects/${projectId}/seo/redirect-map`, { method: "POST", headers: { ...authHeaders(sessionToken, csrfToken), "X-CSRF-Token": "wrong" }, body: JSON.stringify({ oldUrls: ["/a"] }) }, env);
    expect(noCsrf.status).toBe(403);
  });
});
