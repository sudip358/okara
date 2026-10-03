/**
 * Internal-links workbench routes: tenancy (404 for non-members on every new endpoint, 401 without a session),
 * setup_required without a verified host, the graph rebuild rate limit, cluster edits limited to the verified host,
 * bulk status updates, the graph/broken/anchors/placed reads and their parameter validation.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AnchorAuditReport, BrokenLinksReport, LinkClusterReport, LinkGraphSummary, LinkGraphUrlDetail, LinkGraphUrlPage, LinkSuggestionReport, PlacedLinksReport } from "@shared/types";
import { createApp } from "@worker/app";
import { Db } from "@worker/lib/db";
import { GRAPH_REBUILD_RATE_LIMIT, setLinkDecisionsFactory, setLinkWriterFactory } from "@worker/routes/links";
import { createTestEnv } from "./helpers/env";
import { authHeaders, seedProject, seedUser } from "./helpers/fixtures";
import { STORE, U, seedLinkCrawl } from "./links-seed";

afterEach(() => {
  setLinkDecisionsFactory(null);
  setLinkWriterFactory(null);
});

type Json<T> = { data: T; error?: { code: string; message: string } };

async function setup(projectOverrides: Record<string, unknown> = {}) {
  const env = createTestEnv();
  const user = await seedUser(env);
  const projectId = await seedProject(env, user.workspaceId, projectOverrides);
  const db = new Db(env.DB);
  await seedLinkCrawl(db, user.workspaceId, projectId, STORE);
  const app = createApp();
  const H = authHeaders(user.sessionToken, user.csrfToken);
  const base = `/api/projects/${projectId}/seo/internal-links`;
  const req = (path: string, init: RequestInit = {}, headers: Record<string, string> = H) => app.request(`${base}${path}`, { ...init, headers }, env);
  const json = async <T>(path: string, init: RequestInit = {}) => {
    const res = await req(path, init);
    expect(res.status, `${init.method ?? "GET"} ${path}`).toBe(200);
    return ((await res.json()) as Json<T>).data;
  };
  return { env, db, app, H, base, user, projectId, req, json };
}

const ENDPOINTS: Array<[string, string, unknown?]> = [
  ["GET", "/graph"],
  ["POST", "/graph/rebuild"],
  ["GET", "/graph/urls"],
  ["GET", `/graph/url?url=${encodeURIComponent(U("/"))}`],
  ["GET", "/graph/export"],
  ["GET", "/clusters"],
  ["PUT", "/clusters/hub", { url: U("/collections/pulls"), hub: true }],
  ["PUT", "/clusters/assign", { spokeUrl: U("/blogs/news/brass-care"), hubUrl: U("/collections/pulls") }],
  ["GET", "/broken"],
  ["GET", "/broken?format=csv"],
  ["GET", "/anchors"],
  ["GET", "/placed"],
  ["POST", "/bulk", { ids: ["lsug_x"], userStatus: "accepted" }],
  ["GET", "/export?format=sheet"],
];

describe("workbench routes: tenancy", () => {
  it("returns 404 to non-members and 401 without a session on every new endpoint", async () => {
    const { env, app, base, req, json } = await setup();
    await json("/graph/rebuild", { method: "POST" });
    const intruder = await seedUser(env);
    const IH = authHeaders(intruder.sessionToken, intruder.csrfToken);
    for (const [method, path, body] of ENDPOINTS) {
      const init: RequestInit = { method, ...(body ? { body: JSON.stringify(body) } : {}) };
      const res = await req(path, init, IH);
      expect(res.status, `${method} ${path} as a non-member`).toBe(404);
      const anon = await app.request(`${base}${path}`, init, env);
      // Reads: 401. Writes are refused earlier by the CSRF/origin check (403) or by the session check (401).
      if (method === "GET") expect(anon.status, `${method} ${path} without a session`).toBe(401);
      else expect([401, 403], `${method} ${path} without a session`).toContain(anon.status);
    }
  });

  it("bulk updates only the project's own suggestions and counts the rest as missing", async () => {
    const owner = await setup();
    setLinkDecisionsFactory(async () => null);
    setLinkWriterFactory(async () => null);
    const run = await owner.json<LinkSuggestionReport>("/run", { method: "POST" });
    const ids = run.suggestions.slice(0, 2).map((s) => s.id);

    const other = await seedUser(owner.env);
    const otherProject = await seedProject(owner.env, other.workspaceId);
    const OH = authHeaders(other.sessionToken, other.csrfToken);
    const cross = await owner.app.request(`/api/projects/${otherProject}/seo/internal-links/bulk`, { method: "POST", headers: OH, body: JSON.stringify({ ids, userStatus: "dismissed" }) }, owner.env);
    expect(cross.status).toBe(200);
    expect(((await cross.json()) as Json<{ updated: number; missing: number }>).data).toMatchObject({ updated: 0, missing: 2 });

    const res = await owner.json<{ updated: number; missing: number; suggestions: Array<{ id: string; userStatus: string }> }>("/bulk", { method: "POST", body: JSON.stringify({ ids: [...ids, "lsug_missing"], userStatus: "accepted" }) });
    expect(res).toMatchObject({ updated: 2, missing: 1 });
    expect(res.suggestions.map((s) => s.userStatus)).toEqual(["accepted", "accepted"]);
    const rows = await owner.db.all<{ user_status: string; status_changed_at: string | null }>(`SELECT user_status, status_changed_at FROM link_suggestions WHERE id IN (?, ?)`, ...ids);
    expect(rows.every((r) => r.user_status === "accepted" && r.status_changed_at)).toBe(true);

    expect((await owner.req("/bulk", { method: "POST", body: JSON.stringify({ ids: [], userStatus: "accepted" }) })).status).toBe(400);
    expect((await owner.req("/bulk", { method: "POST", body: JSON.stringify({ ids, userStatus: "approved" }) })).status).toBe(400);
    expect((await owner.req("/bulk", { method: "POST", body: JSON.stringify({ ids: Array.from({ length: 201 }, (_, i) => `lsug_${i}`), userStatus: "accepted" }) })).status).toBe(400);
    expect((await owner.req("/bulk", { method: "POST", body: "{not json" })).status).toBe(400);
  });
});

describe("workbench routes: reads, validation and limits", () => {
  it("is setup_required without a verified host and does not use the rebuild limit", async () => {
    const { json } = await setup({ verified_host: null, verification_method: null, verified_at: null });
    for (let i = 0; i < GRAPH_REBUILD_RATE_LIMIT.limit + 1; i++) {
      const g = await json<LinkGraphSummary>("/graph/rebuild", { method: "POST" });
      expect(g.state).toBe("setup_required");
    }
    expect((await json<AnchorAuditReport>("/anchors")).state).toBe("setup_required");
    expect((await json<BrokenLinksReport>("/broken")).state).toBe("setup_required");
  });

  it("rebuilds the graph (rate-limited) and serves the per-URL table, detail, broken links, anchors and placed links", async () => {
    const { req, json } = await setup();
    const before = await json<LinkGraphSummary>("/graph");
    expect(before.graphId).toBeNull();
    const built = await json<LinkGraphSummary>("/graph/rebuild", { method: "POST" });
    expect(built.graphId).toBeTruthy();
    expect(built.coverageLabel).toMatch(/analysed/);
    expect(built.counts!.urls).toBeGreaterThan(5);

    const page = await json<LinkGraphUrlPage>("/graph/urls?sort=url&dir=asc&limit=3");
    expect(page.rows).toHaveLength(3);
    expect(page.rows.map((r) => r.url)).toEqual([...page.rows.map((r) => r.url)].sort());
    expect(page.total).toBe(built.counts!.urls);
    const orphans = await json<LinkGraphUrlPage>("/graph/urls?filter=orphans");
    expect(orphans.rows.map((r) => r.url)).toContain(U("/blogs/news/brass-patina"));
    const search = await json<LinkGraphUrlPage>("/graph/urls?q=patina");
    expect(search.rows.length).toBeGreaterThan(0);
    expect(search.rows.every((r) => /patina/i.test(`${r.url} ${r.title ?? ""}`))).toBe(true);
    expect((await req("/graph/urls?filter=everything")).status).toBe(400);
    expect((await req("/graph/urls?sort=pagerank")).status).toBe(400);
    const clamped = await json<LinkGraphUrlPage>("/graph/urls?limit=100000&offset=-5");
    expect(clamped.limit).toBeLessThanOrEqual(200);
    expect(clamped.offset).toBe(0);

    const detail = await json<LinkGraphUrlDetail>(`/graph/url?url=${encodeURIComponent(U("/products/brass-pull"))}`);
    expect(detail.row.linksIn).toBeGreaterThan(0);
    expect(detail.inbound.map((i) => i.url)).toContain(U("/"));
    expect((await req("/graph/url")).status).toBe(400);
    expect((await req(`/graph/url?url=${encodeURIComponent(U("/nowhere"))}`)).status).toBe(404);

    const csv = await req("/graph/export");
    expect(csv.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    const text = new TextDecoder("utf-8", { ignoreBOM: true, fatal: false }).decode(new Uint8Array(await csv.arrayBuffer()));
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text.slice(1).split("\r\n")[0]).toMatch(/^URL,Title,Status,In sitemap,Indexable,Links in,Content links in,Links out/);

    const broken = await json<BrokenLinksReport>("/broken");
    expect(broken.rows.some((r) => r.targetUrl === U("/old-pulls") && r.issue === "redirect" && r.fix === `Link to ${U("/collections/pulls")}`)).toBe(true);
    expect((await req("/broken?format=xml")).status).toBe(400);
    const anchors = await json<AnchorAuditReport>("/anchors?all=1");
    expect(anchors.state).toBe("ready");
    const placed = await json<PlacedLinksReport>("/placed");
    expect(placed.counts.total).toBe(0);

    // Rate limit: the first rebuild above plus limit-1 more, then 429.
    for (let i = 1; i < GRAPH_REBUILD_RATE_LIMIT.limit; i++) expect((await req("/graph/rebuild", { method: "POST" })).status).toBe(200);
    const limited = await req("/graph/rebuild", { method: "POST" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });

  it("accepts cluster edits only for URLs on the verified host", async () => {
    const { req, json, env, app, base, H } = await setup();
    await json("/graph/rebuild", { method: "POST" });
    const hub = await json<LinkClusterReport>("/clusters/hub", { method: "PUT", body: JSON.stringify({ url: U("/blogs/news/brass-care"), hub: true }) });
    expect(hub.hubs.map((h) => h.url)).toContain(U("/blogs/news/brass-care"));
    const assigned = await json<LinkClusterReport>("/clusters/assign", { method: "PUT", body: JSON.stringify({ spokeUrl: U("/blogs/news/brass-patina"), hubUrl: U("/blogs/news/brass-care") }) });
    const careHub = assigned.hubs.find((h) => h.url === U("/blogs/news/brass-care"))!;
    expect(careHub.spokes.find((s) => s.url === U("/blogs/news/brass-patina"))).toMatchObject({ method: "owner" });
    await json("/clusters/assign", { method: "PUT", body: JSON.stringify({ spokeUrl: U("/blogs/news/brass-patina"), reset: true }) });
    await json("/clusters/hub", { method: "PUT", body: JSON.stringify({ url: U("/blogs/news/brass-care"), hub: null }) });

    expect((await req("/clusters/hub", { method: "PUT", body: JSON.stringify({ url: "https://other.example.com/x", hub: true }) })).status).toBe(400);
    expect((await req("/clusters/hub", { method: "PUT", body: JSON.stringify({ url: "javascript:alert(1)//shop.example.com", hub: true }) })).status).toBe(400);
    expect((await req("/clusters/hub", { method: "PUT", body: JSON.stringify({ url: "https://user:pw@shop.example.com/x", hub: true }) })).status).toBe(400);
    expect((await req("/clusters/hub", { method: "PUT", body: JSON.stringify({ url: U("/x"), hub: "yes" }) })).status).toBe(400);
    expect((await req("/clusters/assign", { method: "PUT", body: JSON.stringify({ spokeUrl: U("/x"), hubUrl: "https://evil.example.net/" }) })).status).toBe(400);
    expect((await req("/clusters/assign", { method: "PUT", body: JSON.stringify({ spokeUrl: U("/x"), hubUrl: U("/y"), extra: 1 }) })).status).toBe(400);
    // Writes need the CSRF token.
    const { "X-CSRF-Token": _csrf, ...noToken } = H;
    const noCsrf = await app.request(`${base}/clusters/hub`, { method: "PUT", headers: noToken, body: JSON.stringify({ url: U("/x"), hub: true }) }, env);
    expect(noCsrf.status).toBe(403);
    expect(_csrf).toBeTruthy();
  });
});
