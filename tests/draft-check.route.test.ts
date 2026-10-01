/** [A23] POST /projects/:pid/seo/draft-check: validation, tenancy, pageId path, demo, rate limit, budget. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
// Import the app module first (route modules reference AppEnv from app.ts).
import { createApp, type AppEnv } from "@worker/app";
import { Db } from "@worker/lib/db";
import { HttpError } from "@worker/lib/errors";
import { seedDemoProject } from "@worker/demo/seed";
import type { Env } from "@worker/env";
import type { DecisionProvider } from "@worker/providers/types";
import { buildDecisionsForWorkspace } from "@worker/redirects/decisions";
import { DRAFT_CHECK_RATE_LIMIT, draftCheckRoutes, setDraftCheckDecisionsFactory } from "@worker/routes/draft-check";
import type { DraftCheckResult } from "@shared/types";
import { createTestEnv } from "./helpers/env";
import { authHeaders, FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";
import { seedCrawl, U } from "./checklists-seed";

afterEach(() => setDraftCheckDecisionsFactory(null));

async function setup(projectOverrides: Record<string, unknown> = {}, envOverrides: Partial<Env> = {}) {
  const env = createTestEnv(envOverrides);
  const u = await seedUser(env);
  const projectId = await seedProject(env, u.workspaceId, projectOverrides);
  return { env, projectId, ...u };
}

function testApp(env: Env, userId: string | null) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", new Db(env.DB));
    c.set("now", FIXED_NOW);
    c.set("user", userId ? { id: userId, email: "u@example.com", name: null } : null);
    c.set("session", null);
    await next();
  });
  app.route("/", draftCheckRoutes);
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as 400);
    throw err;
  });
  return app;
}

async function post(env: Env, userId: string | null, projectId: string, body: unknown, raw?: string) {
  const res = await testApp(env, userId).request(`/projects/${projectId}/seo/draft-check`, { method: "POST", body: raw ?? JSON.stringify(body), headers: { "Content-Type": "application/json" } }, env);
  return { res, body: (await res.json()) as { data: DraftCheckResult; error?: { code: string; message: string } } };
}

const DRAFT = "# How to clean brass knobs\n\nClean brass knobs with warm soapy water and a soft cloth, then dry them fully to prevent spots.\n\n## Polishing\n\nPolish unlacquered brass twice a year.";

describe("POST /projects/:pid/seo/draft-check", () => {
  it("returns the DraftCheckResult contract for a pasted draft", async () => {
    const { env, userId, projectId } = await setup();
    setDraftCheckDecisionsFactory(async () => null);
    const { res, body } = await post(env, userId, projectId, { targetQuery: "how to clean brass knobs", draftText: DRAFT });
    expect(res.status).toBe(200);
    expect(Object.keys(body.data).sort()).toEqual(["checklist", "flags", "jevUsed", "labels", "state", "verdict"]);
    expect(body.data.state).toBe("ready");
    expect(["pass", "needs_review", "fail"]).toContain(body.data.verdict);
    expect(body.data.checklist.items).toHaveLength(25);
    expect(body.data.jevUsed).toBe(false);
    expect(body.data.labels[0]).toBe("A quality gate before human review — not an AI detector and not a ranking prediction.");
  });

  it("validates the body: exactly one of pageId|draftText, sizes, and target query", async () => {
    const { env, userId, projectId, workspaceId } = await setup();
    setDraftCheckDecisionsFactory(async () => null);
    const bad = async (b: unknown) => (await post(env, userId, projectId, b)).res.status;
    expect(await bad({ targetQuery: "q" })).toBe(400);
    expect(await bad({ targetQuery: "q", draftText: "x", pageId: "pg_1" })).toBe(400);
    expect(await bad({ targetQuery: "", draftText: "some text" })).toBe(400);
    expect(await bad({ targetQuery: "q".repeat(201), draftText: "some text" })).toBe(400);
    expect(await bad({ targetQuery: "q", draftText: "   " })).toBe(400);
    expect(await bad({ targetQuery: "q", draftText: "x".repeat(60_001) })).toBe(400);
    expect(await bad({ targetQuery: "q", draftText: "text", title: "t".repeat(301) })).toBe(400);
    expect(await bad({ targetQuery: "q", draftText: "text", metaDescription: "m".repeat(1001) })).toBe(400);
    expect(await bad({ targetQuery: "q", draftText: "text", extra: 1 })).toBe(400);
    expect((await post(env, userId, projectId, null, "{not json")).res.status).toBe(400);
    // At the limits (a fresh project: every request above counts towards the rate limit).
    const fresh = await seedProject(env, workspaceId);
    expect((await post(env, userId, fresh, { targetQuery: "q".repeat(200), draftText: "x".repeat(60_000), metaDescription: "m".repeat(1000), title: "t".repeat(300) })).res.status).toBe(200);
  });

  it("pageId path: evaluates the latest snapshot against the target query (noindex fails indexability)", async () => {
    const { env, userId, projectId, workspaceId } = await setup();
    const db = new Db(env.DB);
    const { pageIds } = await seedCrawl(db, workspaceId, projectId, {
      pages: [
        { path: "/", pageType: "home" },
        {
          path: "/blog/clean-brass",
          pageType: "article",
          title: "How to clean brass cabinet knobs without damage",
          firstParagraph: "Clean brass cabinet knobs with warm soapy water and a soft cloth, then dry them.",
          excerpt: "Clean brass cabinet knobs with warm soapy water and a soft cloth, then dry them. We are the #1 brass care experts.",
          robotsMeta: "noindex, follow",
          links: ["/"],
        },
      ],
    });
    const factory = vi.fn(async () => null);
    setDraftCheckDecisionsFactory(factory);
    const { res, body } = await post(env, userId, projectId, { targetQuery: "how to clean brass cabinet knobs", pageId: pageIds["/blog/clean-brass"] });
    expect(res.status).toBe(200);
    const d = body.data;
    expect(d.state).toBe("ready");
    expect(d.checklist.page).toMatchObject({ id: pageIds["/blog/clean-brass"], url: U("/blog/clean-brass"), pageType: "article", topQuery: "how to clean brass cabinet knobs" });
    const idx = d.checklist.items.find((i) => i.id === "page.publish_check.indexability")!;
    expect(idx.status).toBe("not_met");
    expect(idx.summary).toMatch(/noindex/);
    expect(d.checklist.items.find((i) => i.id === "page.while_write.answer_early")!.status).toBe("met");
    expect(d.flags).toEqual([{ kind: "unsupported_claim", text: "We are the #1 brass care experts.", method: "rule", noul: null }]);
    expect(d.verdict).toBe("fail");
    expect(d.labels.join(" ")).toMatch(/Crawled page https:\/\/shop\.example\.com\/blog\/clean-brass, snapshot from/);
    expect(d.checklist.sources.crawlRunId).toBeTruthy();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("pageId without a snapshot (unverified site): setup_required, needs_review, Jev not asked", async () => {
    const { env, userId, projectId, workspaceId } = await setup();
    const db = new Db(env.DB);
    const { pageIds } = await seedCrawl(db, workspaceId, projectId, { pages: [{ path: "/a" }] });
    await db.run("UPDATE projects SET verified_host = NULL, verified_at = NULL WHERE id = ?", projectId);
    const decide = vi.fn();
    setDraftCheckDecisionsFactory(async () => ({ name: "typesafe", decide, test: async () => ({ ok: true, detail: "" }) }) as unknown as DecisionProvider);
    const { body } = await post(env, userId, projectId, { targetQuery: "brass", pageId: pageIds["/a"] });
    expect(body.data.state).toBe("setup_required");
    expect(body.data.verdict).toBe("needs_review");
    expect(body.data.flags).toEqual([]);
    expect(decide).not.toHaveBeenCalled();
    expect(body.data.labels.join(" ")).toMatch(/Verify site ownership/);
  });

  it("cross-tenant: another workspace's project, or a page of another project, is 404", async () => {
    const a = await setup();
    const env = a.env;
    const b = await seedUser(env);
    const otherProject = await seedProject(env, b.workspaceId);
    const db = new Db(env.DB);
    const { pageIds } = await seedCrawl(db, b.workspaceId, otherProject, { pages: [{ path: "/secret" }] });
    setDraftCheckDecisionsFactory(async () => null);
    expect((await post(env, a.userId, otherProject, { targetQuery: "q", draftText: DRAFT })).res.status).toBe(404);
    const r = await post(env, a.userId, a.projectId, { targetQuery: "q", pageId: pageIds["/secret"] });
    expect(r.res.status).toBe(404);
    expect(r.body.error?.code).toBe("not_found");
    expect((await post(env, null, a.projectId, { targetQuery: "q", draftText: DRAFT })).res.status).toBe(401);
  });

  it("demo project: a demo page is checked with state demo and Jev never called", async () => {
    const env = createTestEnv({ DEMO_MODE: "true" });
    const u = await seedUser(env);
    const db = new Db(env.DB);
    const demo = await seedDemoProject(env, db, u.userId, FIXED_NOW);
    const page = await db.first<{ id: string; url: string }>("SELECT id, url FROM pages WHERE project_id = ? AND workspace_id = ? ORDER BY url LIMIT 1", demo.id, demo.workspace_id);
    const factory = vi.fn(async () => null);
    setDraftCheckDecisionsFactory(factory);
    const { res, body } = await post(env, u.userId, demo.id, { targetQuery: "linen sofa", pageId: page!.id });
    expect(res.status).toBe(200);
    expect(body.data.state).toBe("demo");
    expect(body.data.checklist.state).toBe("demo");
    expect(body.data.jevUsed).toBe(false);
    expect(factory).not.toHaveBeenCalled();
    expect(body.data.labels.join(" ")).toMatch(/Demo data - simulated run: Jev is not called/);
  });

  it(`rate limit: ${DRAFT_CHECK_RATE_LIMIT.limit} requests per minute per user and project, then 429 with Retry-After`, async () => {
    const { env, userId, projectId } = await setup();
    setDraftCheckDecisionsFactory(async () => null);
    for (let i = 0; i < DRAFT_CHECK_RATE_LIMIT.limit; i++) {
      expect((await post(env, userId, projectId, { targetQuery: "q", draftText: DRAFT })).res.status).toBe(200);
    }
    const { res, body } = await post(env, userId, projectId, { targetQuery: "q", draftText: DRAFT });
    expect(res.status).toBe(429);
    expect(body.error?.code).toBe("rate_limited");
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("real TypeSafe adapter: one call when the budget allows; deterministic with a label once it is used up", async () => {
    const { env, userId, projectId, workspaceId, db } = await setup({}, { TYPESAFE_API_KEY: "ts-test-key" });
    await db.run("UPDATE project_limits SET provider_calls_per_day = 3 WHERE project_id = ?", projectId);
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      const req = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
      const answers = Object.fromEntries(Object.keys(req.questions).map((k) => [k, { type: "noul", noul: 0.9 }]));
      return new Response(JSON.stringify({ model: "jev-2026-09-15", answers, usage: { input_tokens: 100, output_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    setDraftCheckDecisionsFactory((e, d, ws, pid) => buildDecisionsForWorkspace(e, d, ws, pid, { fetchImpl }));

    const first = await post(env, userId, projectId, { targetQuery: "how to clean brass knobs", draftText: DRAFT });
    expect(first.res.status).toBe(200);
    expect(seen).toEqual(["https://api.typesafe.ai/v1/systemone"]);
    expect(first.body.data.jevUsed).toBe(true);
    expect(first.body.data.checklist.items.find((i) => i.id === "page.before_write.first_hand")!.status).toBe("met");

    // The first call reserved 3 jev_calls (1 + 2 retries) and settled to 1; use up the rest of the daily budget.
    await db.run("UPDATE usage_counters SET used = limit_value WHERE scope_key = ? AND resource = 'jev_calls'", `project:${projectId}`);
    const second = await post(env, userId, projectId, { targetQuery: "how to clean brass knobs", draftText: DRAFT });
    expect(second.res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(second.body.data.jevUsed).toBe(false);
    expect(second.body.data.labels.join(" ")).toMatch(/Jev budget reached/);
    expect(second.body.data.checklist.items.find((i) => i.id === "page.before_write.first_hand")!.status).toBe("manual");

    const calls = await db.all<{ provider: string; purpose: string; status: string; run_id: string | null }>("SELECT provider, purpose, status, run_id FROM provider_calls WHERE workspace_id = ?", workspaceId);
    expect(calls).toEqual([{ provider: "typesafe", purpose: "seo.draft_check", status: "ok", run_id: null }]);
  });

  it("is mounted on the real app behind session + CSRF", async () => {
    const { env, projectId, sessionToken, csrfToken } = await setup();
    setDraftCheckDecisionsFactory(async () => null);
    const app = createApp();
    const ok = await app.request(`/api/projects/${projectId}/seo/draft-check`, { method: "POST", headers: authHeaders(sessionToken, csrfToken), body: JSON.stringify({ targetQuery: "brass", draftText: DRAFT }) }, env);
    expect(ok.status).toBe(200);
    const noCsrf = await app.request(`/api/projects/${projectId}/seo/draft-check`, { method: "POST", headers: { ...authHeaders(sessionToken, csrfToken), "X-CSRF-Token": "wrong" }, body: JSON.stringify({ targetQuery: "brass", draftText: DRAFT }) }, env);
    expect(noCsrf.status).toBe(403);
  });
});
