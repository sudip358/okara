import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
// Import the app module first (route modules reference AppEnv from app.ts).
import { createApp, type AppEnv } from "@worker/app";
import { Db } from "@worker/lib/db";
import { HttpError } from "@worker/lib/errors";
import { robotsRoutes, setRobotsAdvisorFetch, CURRENT_ROBOTS_DISPLAY_BYTES } from "@worker/routes/robots";
import { isPathAllowed, parseRobots, selectGroup } from "@worker/seo/crawl/robots";
import type { Env } from "@worker/env";
import type { RobotsSuggestion } from "@shared/types";
import { createTestEnv } from "./helpers/env";
import { authHeaders, FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";
import { fakeSite, redirect, type FakeRoute } from "./fixtures/crawl/fake-site";

const H = "shop.example.com";
const ROBOTS_URL = `https://${H}/robots.txt`;
const SHOPIFY_LIKE = `# we use Shopify as our ecommerce platform
User-agent: *
Disallow: /cart
Disallow: /checkout
Disallow: /account
Disallow: /search
Sitemap: https://${H}/sitemap.xml
`;

afterEach(() => setRobotsAdvisorFetch(null));

async function setup(projectOverrides: Record<string, unknown> = {}) {
  const env = createTestEnv({ APP_ORIGIN: "https://app.okara.example" });
  const { workspaceId, userId, sessionToken, csrfToken } = await seedUser(env);
  const projectId = await seedProject(env, workspaceId, projectOverrides);
  return { env, workspaceId, userId, projectId, sessionToken, csrfToken };
}

/** Route under test with a fixed clock (rate-limit windows are deterministic). */
function testApp(env: Env, userId: string | null) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", new Db(env.DB));
    c.set("now", FIXED_NOW);
    c.set("user", userId ? { id: userId, email: "u@example.com", name: null } : null);
    c.set("session", null);
    await next();
  });
  app.route("/", robotsRoutes);
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    throw err;
  });
  return (path: string) => app.request(path, {}, env);
}

function site(route: FakeRoute) {
  const s = fakeSite({ [ROBOTS_URL]: route });
  setRobotsAdvisorFetch(s.fetch);
  return s;
}

async function get(env: Env, userId: string | null, projectId: string, query = "") {
  const res = await testApp(env, userId)(`/projects/${projectId}/seo/robots-suggestion${query}`);
  return { res, body: (await res.json()) as { data: RobotsSuggestion; error?: { code: string } } };
}

describe("robots advisor route", () => {
  it("verified project: fetches robots.txt through the guard with the crawler UA and returns a suggestion", async () => {
    const { env, userId, projectId } = await setup();
    const s = site({ status: 200, contentType: "text/plain", body: SHOPIFY_LIKE });
    const { res, body } = await get(env, userId, projectId);
    expect(res.status).toBe(200);
    const d = body.data;
    expect(d.state).toBe("ready");
    expect(d.fetchedAt).toBe(FIXED_NOW.toISOString());
    expect(d.currentRobotsTxt).toBe(SHOPIFY_LIKE);
    expect(d.policy).toEqual({ allowTraining: true });
    expect(s.urls()).toEqual([ROBOTS_URL]);
    expect(s.calls[0]!.init?.redirect).toBe("manual");
    expect(new Headers(s.calls[0]!.init?.headers).get("user-agent")).toBe("OkaraBot/0.1 (+https://app.okara.example/bot)");
    const parsed = parseRobots(d.suggestedRobotsTxt!);
    for (const t of ["Googlebot", "OAI-SearchBot", "PerplexityBot"]) {
      expect(isPathAllowed(selectGroup(parsed, t), "/")).toBe(true);
      expect(isPathAllowed(selectGroup(parsed, t), "/cart")).toBe(false);
      expect(isPathAllowed(selectGroup(parsed, t), "/checkout")).toBe(false);
    }
    expect(d.preservedRules).toContain("Disallow: /cart");
    expect(d.warnings.join(" ")).toMatch(/robots\.txt\.liquid/);
  });

  it("allowTraining=false blocks training tokens; an invalid value is a 400", async () => {
    const { env, userId, projectId } = await setup();
    site({ status: 200, contentType: "text/plain", body: SHOPIFY_LIKE });
    const { body } = await get(env, userId, projectId, "?allowTraining=false");
    expect(body.data.policy).toEqual({ allowTraining: false });
    expect(isPathAllowed(selectGroup(parseRobots(body.data.suggestedRobotsTxt!), "GPTBot"), "/")).toBe(false);
    expect(body.data.changes.find((c) => c.token === "GPTBot")!.after).toBe("blocked");
    const bad = await get(env, userId, projectId, "?allowTraining=maybe");
    expect(bad.res.status).toBe(400);
  });

  it("unverified project: setup_required and nothing is fetched", async () => {
    const { env, userId, projectId } = await setup({ verified_host: null, verification_method: null, verified_at: null });
    const s = site({ status: 200, contentType: "text/plain", body: SHOPIFY_LIKE });
    const { res, body } = await get(env, userId, projectId);
    expect(res.status).toBe(200);
    expect(body.data.state).toBe("setup_required");
    expect(body.data.suggestedRobotsTxt).toBeNull();
    expect(body.data.currentRobotsTxt).toBeNull();
    expect(s.calls).toHaveLength(0);
  });

  it("demo project: labelled demo robots.txt resembling a Shopify default; nothing is fetched", async () => {
    const { env, userId, projectId } = await setup({ verified_host: null, verification_method: null, verified_at: null, is_demo: 1 });
    const s = site({ status: 200, contentType: "text/plain", body: SHOPIFY_LIKE });
    const { body } = await get(env, userId, projectId);
    const d = body.data;
    expect(d.state).toBe("demo");
    expect(d.fetchedAt).toBeNull();
    expect(d.currentRobotsTxt).toMatch(/^# Demo data - simulated run/);
    expect(d.warnings[0]).toMatch(/^Demo data - simulated run/);
    const parsed = parseRobots(d.suggestedRobotsTxt!);
    for (const p of ["/cart", "/checkout", "/account", "/search"]) expect(isPathAllowed(selectGroup(parsed, "Googlebot"), p)).toBe(false);
    expect(s.calls).toHaveLength(0);
  });

  it("enforces tenancy: another workspace's user gets 404 (no fetch); anonymous gets 401", async () => {
    const { env, projectId } = await setup();
    const other = await seedUser(env);
    const s = site({ status: 200, contentType: "text/plain", body: SHOPIFY_LIKE });
    expect((await get(env, other.userId, projectId)).res.status).toBe(404);
    expect((await get(env, null, projectId)).res.status).toBe(401);
    expect(s.calls).toHaveLength(0);
  });

  it("is mounted in the real app stack behind the session", async () => {
    const { env, projectId, sessionToken, csrfToken } = await setup();
    const s = site({ status: 404, contentType: "text/plain", body: "" });
    const app = createApp();
    const ok = await app.request(`/api/projects/${projectId}/seo/robots-suggestion`, { headers: authHeaders(sessionToken, csrfToken) }, env);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { data: RobotsSuggestion }).data.state).toBe("ready");
    const other = await seedUser(env);
    const cross = await app.request(`/api/projects/${projectId}/seo/robots-suggestion`, { headers: authHeaders(other.sessionToken, other.csrfToken) }, env);
    expect(cross.status).toBe(404);
    expect((await app.request(`/api/projects/${projectId}/seo/robots-suggestion`, {}, env)).status).toBe(401);
    expect(s.calls).toHaveLength(1);
  });

  it("robots.txt 404 -> suggestion with named groups only and a note", async () => {
    const { env, userId, projectId } = await setup();
    site({ status: 404, contentType: "text/html", body: "<html>nope</html>" });
    const { body } = await get(env, userId, projectId);
    const d = body.data;
    expect(d.state).toBe("ready");
    expect(d.currentRobotsTxt).toBeNull();
    expect(d.preservedRules).toEqual([]);
    expect(d.changes.every((c) => c.before === "no_group")).toBe(true);
    expect(d.notes.join(" ")).toMatch(/No robots\.txt was found/);
    expect(d.notes.join(" ")).toMatch(/returned 404/);
    expect(d.suggestedRobotsTxt).toMatch(/User-agent: Googlebot/);
  });

  it("robots.txt 5xx -> error state without a suggestion", async () => {
    const { env, userId, projectId } = await setup();
    site({ status: 503, contentType: "text/plain", body: "" });
    const { body } = await get(env, userId, projectId);
    expect(body.data.state).toBe("error");
    expect(body.data.suggestedRobotsTxt).toBeNull();
    expect(body.data.warnings[0]).toMatch(/returned 503/);
  });

  it("uses the SSRF guard: an off-host redirect is refused and never followed", async () => {
    const { env, userId, projectId } = await setup();
    const s = fakeSite({
      [ROBOTS_URL]: redirect("https://169.254.169.254/latest/meta-data/"),
      "https://169.254.169.254/latest/meta-data/": { status: 200, contentType: "text/plain", body: "secret" },
    });
    setRobotsAdvisorFetch(s.fetch);
    const { body } = await get(env, userId, projectId);
    expect(body.data.state).toBe("error");
    expect(body.data.suggestedRobotsTxt).toBeNull();
    expect(body.data.warnings[0]).toMatch(/redirected off the verified host/);
    expect(s.urls()).toEqual([ROBOTS_URL]);

    const s2 = fakeSite({ [ROBOTS_URL]: redirect("https://evil.example.org/robots.txt") });
    setRobotsAdvisorFetch(s2.fetch);
    expect((await get(env, userId, projectId)).body.data.state).toBe("error");
    expect(s2.urls()).toEqual([ROBOTS_URL]);
  });

  it("follows a same-host redirect", async () => {
    const { env, userId, projectId } = await setup();
    const s = fakeSite({
      [ROBOTS_URL]: redirect("/robots-live.txt"),
      [`https://${H}/robots-live.txt`]: { status: 200, contentType: "text/plain", body: SHOPIFY_LIKE },
    });
    setRobotsAdvisorFetch(s.fetch);
    expect((await get(env, userId, projectId)).body.data.state).toBe("ready");
    expect(s.urls()).toEqual([ROBOTS_URL, `https://${H}/robots-live.txt`]);
  });

  it("caps the displayed robots.txt at 32 KB; refuses to suggest from a truncated (>512 KB) file", async () => {
    const { env, userId, projectId } = await setup();
    const filler = Array.from({ length: 2000 }, (_, i) => `Disallow: /private-${i}/`).join("\n");
    site({ status: 200, contentType: "text/plain", body: `${SHOPIFY_LIKE}${filler}\n` });
    const big = (await get(env, userId, projectId)).body.data;
    expect(big.state).toBe("ready");
    expect(new TextEncoder().encode(big.currentRobotsTxt!).byteLength).toBeLessThanOrEqual(CURRENT_ROBOTS_DISPLAY_BYTES);
    expect(big.notes.join(" ")).toMatch(/first 32 KB/);
    expect(isPathAllowed(selectGroup(parseRobots(big.suggestedRobotsTxt!), "Googlebot"), "/private-1999/")).toBe(false);

    site({ status: 200, contentType: "text/plain", body: "User-agent: *\n" + "Disallow: /x\n".repeat(50_000) });
    const huge = (await get(env, userId, projectId)).body.data;
    expect(huge.state).toBe("error");
    expect(huge.suggestedRobotsTxt).toBeNull();
    expect(huge.warnings[0]).toMatch(/larger than 512 KB/);
  });

  it("rate-limits live fetches per user and project", async () => {
    const { env, userId, projectId } = await setup();
    const s = site({ status: 200, contentType: "text/plain", body: SHOPIFY_LIKE });
    for (let i = 0; i < 10; i++) expect((await get(env, userId, projectId)).res.status).toBe(200);
    const limited = await get(env, userId, projectId);
    expect(limited.res.status).toBe(429);
    expect(limited.res.headers.get("Retry-After")).toBeTruthy();
    expect(s.calls).toHaveLength(10);
  });
});
