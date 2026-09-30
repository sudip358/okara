/** Smoke test through the real createApp() stack (session loading, CSRF, security headers). */
import { describe, expect, it } from "vitest";
import { createApp } from "@worker/app";
import type { Project } from "@shared/types";
import { createTestEnv } from "./helpers/env";
import { authHeaders, seedUser } from "./helpers/fixtures";

const input = {
  name: "Shop",
  siteUrl: "https://shop.example.com",
  siteType: "ecommerce",
  brandName: "Residence Example",
  brandAliases: [],
  competitors: [],
  productDescription: "",
  audience: "",
  locale: "en-US",
  language: "en",
  voice: "",
};

describe("platform-projects via createApp", () => {
  it("creates a project with CSRF, isolates tenants, and hides demo seed in production", async () => {
    const env = createTestEnv();
    const app = createApp();
    const a = await seedUser(env);
    const b = await seedUser(env);
    const created = await app.request(`/api/workspaces/${a.workspaceId}/projects`, { method: "POST", headers: authHeaders(a.sessionToken, a.csrfToken), body: JSON.stringify(input) }, env);
    expect(created.status).toBe(201);
    const p = ((await created.json()) as { data: Project }).data;

    const noCsrf = await app.request(`/api/projects/${p.id}`, { method: "PATCH", headers: { ...authHeaders(a.sessionToken, a.csrfToken), "X-CSRF-Token": "wrong" }, body: JSON.stringify({ name: "x" }) }, env);
    expect(noCsrf.status).toBe(403);

    for (const [method, path] of [["GET", `/api/projects/${p.id}`], ["GET", `/api/projects/${p.id}/export`], ["DELETE", `/api/projects/${p.id}`]] as const) {
      const res = await app.request(path, { method, headers: authHeaders(b.sessionToken, b.csrfToken) }, env);
      expect(res.status, `${method} ${path}`).toBe(404);
    }

    // Production needs an https APP_ORIGIN (matching Origin) and a sign-in allowlist, so the session and
    // CSRF checks pass and the demo route itself is what refuses.
    const prodOrigin = "https://app.example.com";
    const prod = createTestEnv({ ENVIRONMENT: "production", DEMO_MODE: "true", APP_ORIGIN: prodOrigin, ALLOWED_EMAIL_DOMAINS: "example.com" });
    const u = await seedUser(prod);
    const me = await app.request(`${prodOrigin}/api/me`, { headers: { Cookie: `__Host-okara_session=${u.sessionToken}` } }, prod);
    expect(me.status).toBe(200);
    const demo = await app.request(`${prodOrigin}/api/demo/seed`, { method: "POST", headers: { ...authHeaders(u.sessionToken, u.csrfToken, prodOrigin), Cookie: `__Host-okara_session=${u.sessionToken}` } }, prod);
    expect(demo.status).toBe(404);
  });
});
