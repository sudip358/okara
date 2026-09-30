/** [A25] Internal-link routes: run, report, user status, export, tenancy, rate limit, CSV escaping. */
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "@worker/app";
import type { LinkSuggestion, LinkSuggestionReport } from "@shared/types";
import { Db } from "@worker/lib/db";
import { CSV_COLUMNS, csvCell, linksCsv } from "@worker/links/report";
import { LINK_RUN_RATE_LIMIT, setLinkDecisionsFactory } from "@worker/routes/links";
import { createTestEnv } from "./helpers/env";
import { authHeaders, seedProject, seedUser } from "./helpers/fixtures";
import { STORE, confidentYes, fakeDecisions, seedLinkCrawl } from "./links-seed";

afterEach(() => setLinkDecisionsFactory(null));

async function setup(projectOverrides: Record<string, unknown> = {}, withCrawl = true) {
  const env = createTestEnv();
  const user = await seedUser(env);
  const projectId = await seedProject(env, user.workspaceId, projectOverrides);
  const db = new Db(env.DB);
  if (withCrawl) await seedLinkCrawl(db, user.workspaceId, projectId, STORE);
  const app = createApp();
  const H = authHeaders(user.sessionToken, user.csrfToken);
  const base = `/api/projects/${projectId}/seo/internal-links`;
  return { env, db, app, H, base, user, projectId };
}

type Json<T> = { data: T; error?: { code: string; message: string } };

describe("links routes", () => {
  it("runs, reads the latest report, updates user status, and exports CSV and JSON", async () => {
    const { env, app, H, base } = await setup();
    const fake = fakeDecisions(confidentYes);
    setLinkDecisionsFactory(async () => fake.provider);

    const empty = (await (await app.request(base, { headers: H }, env)).json()) as Json<LinkSuggestionReport>;
    expect(empty.data.state).toBe("ready");
    expect(empty.data.suggestions).toEqual([]);
    expect(empty.data.labels.join(" ")).toMatch(/No internal-link analysis yet/);

    const post = await app.request(`${base}/run`, { method: "POST", headers: H }, env);
    expect(post.status).toBe(200);
    const run = ((await post.json()) as Json<LinkSuggestionReport>).data;
    expect(run.state).toBe("ready");
    expect(run.suggestions.length).toBeGreaterThan(0);
    expect(run.suggestions[0]!.status).toBe("suggested");
    expect(run.labels).toContain("Suggestions for review. Okara never edits your pages.");
    expect(run.labels).toContain("Confidence values are Jev's reported confidence/probability, not predicted traffic.");
    expect(fake.requests.length).toBeGreaterThan(0);

    const got = ((await (await app.request(base, { headers: H }, env)).json()) as Json<LinkSuggestionReport>).data;
    expect(got.suggestions.map((s) => s.id)).toEqual(run.suggestions.map((s) => s.id));

    const id = run.suggestions[0]!.id;
    const patch = await app.request(`${base}/${id}`, { method: "PATCH", headers: H, body: JSON.stringify({ userStatus: "accepted" }) }, env);
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as Json<LinkSuggestion>).data).toMatchObject({ id, userStatus: "accepted" });
    expect((await app.request(`${base}/${id}`, { method: "PATCH", headers: H, body: JSON.stringify({ userStatus: "approved" }) }, env)).status).toBe(400);
    expect((await app.request(`${base}/lsug_missing`, { method: "PATCH", headers: H, body: JSON.stringify({ userStatus: "dismissed" }) }, env)).status).toBe(404);

    const csv = await app.request(`${base}/export?format=csv`, { headers: H }, env);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toMatch(/text\/csv/);
    expect(csv.headers.get("content-disposition")).toMatch(/attachment; filename="internal-links-shop\.example\.com-\d{4}-\d{2}-\d{2}\.csv"/);
    const lines = (await csv.text()).trimEnd().split("\r\n");
    expect(lines[0]).toBe("source_url,target_url,anchor,sentence,role,status,tier,should_exist,sentence_confidence,anchor_confidence,role_confidence");
    expect(lines).toHaveLength(run.suggestions.length + 1);
    expect(lines[1]).toContain(",deeper_detail,suggested,act,0.93,0.9,0.9,0.85");

    const json = await app.request(`${base}/export?format=json`, { headers: H }, env);
    expect(json.headers.get("content-type")).toMatch(/application\/json/);
    const body = (await json.json()) as { format: string; report: LinkSuggestionReport };
    expect(body.format).toBe("okara-internal-links");
    expect(body.report.suggestions).toHaveLength(run.suggestions.length);
    expect(body.report.suggestions[0]!.userStatus).toBe("accepted");

    expect((await app.request(`${base}/export?format=xml`, { headers: H }, env)).status).toBe(400);
  });

  it("returns setup_required without a crawl or verification and does not use the rate limit", async () => {
    const noCrawl = await setup({}, false);
    for (let i = 0; i < LINK_RUN_RATE_LIMIT.limit + 2; i++) {
      const res = await noCrawl.app.request(`${noCrawl.base}/run`, { method: "POST", headers: noCrawl.H }, noCrawl.env);
      expect(res.status).toBe(200);
      expect(((await res.json()) as Json<LinkSuggestionReport>).data.state).toBe("setup_required");
    }
    const unverified = await setup({ verified_host: null, verification_method: null, verified_at: null });
    const res = await unverified.app.request(`${unverified.base}/run`, { method: "POST", headers: unverified.H }, unverified.env);
    const data = ((await res.json()) as Json<LinkSuggestionReport>).data;
    expect(data.state).toBe("setup_required");
    expect(data.labels.join(" ")).toMatch(/Verify site ownership/);
  });

  it("rate-limits runs per project (3 per hour)", async () => {
    const { env, app, H, base } = await setup();
    setLinkDecisionsFactory(async () => null);
    for (let i = 0; i < LINK_RUN_RATE_LIMIT.limit; i++) {
      expect((await app.request(`${base}/run`, { method: "POST", headers: H }, env)).status).toBe(200);
    }
    const limited = await app.request(`${base}/run`, { method: "POST", headers: H }, env);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect(((await limited.json()) as Json<unknown>).error!.code).toBe("rate_limited");
  });

  it("hides other workspaces' projects and suggestions (404)", async () => {
    const owner = await setup();
    setLinkDecisionsFactory(async () => null);
    const run = ((await (await owner.app.request(`${owner.base}/run`, { method: "POST", headers: owner.H }, owner.env)).json()) as Json<LinkSuggestionReport>).data;
    const id = run.suggestions[0]!.id;

    const intruder = await seedUser(owner.env);
    const IH = authHeaders(intruder.sessionToken, intruder.csrfToken);
    expect((await owner.app.request(owner.base, { headers: IH }, owner.env)).status).toBe(404);
    expect((await owner.app.request(`${owner.base}/run`, { method: "POST", headers: IH }, owner.env)).status).toBe(404);
    expect((await owner.app.request(`${owner.base}/export?format=csv`, { headers: IH }, owner.env)).status).toBe(404);
    expect((await owner.app.request(`${owner.base}/${id}`, { method: "PATCH", headers: IH, body: JSON.stringify({ userStatus: "dismissed" }) }, owner.env)).status).toBe(404);

    // A suggestion id from another project cannot be patched through the intruder's own project.
    const ownProject = await seedProject(owner.env, intruder.workspaceId);
    const res = await owner.app.request(`/api/projects/${ownProject}/seo/internal-links/${id}`, { method: "PATCH", headers: IH, body: JSON.stringify({ userStatus: "dismissed" }) }, owner.env);
    expect(res.status).toBe(404);
    const row = await owner.db.first<{ user_status: string }>("SELECT user_status FROM link_suggestions WHERE id = ?", id);
    expect(row!.user_status).toBe("open");

    // Unauthenticated.
    expect((await owner.app.request(owner.base, {}, owner.env)).status).toBe(401);
  });
});

describe("links CSV", () => {
  it("escapes quotes, commas, and line breaks, and neutralises spreadsheet formulas", () => {
    expect(csvCell('He said "brass", then left')).toBe('"He said ""brass"", then left"');
    expect(csvCell("line one\nline two")).toBe('"line one\nline two"');
    expect(csvCell("=HYPERLINK(\"http://x\")")).toBe('"\'=HYPERLINK(""http://x"")"');
    expect(csvCell("+1 brass")).toBe("'+1 brass");
    expect(csvCell("@mention")).toBe("'@mention");
    expect(csvCell(0.93)).toBe("0.93");
    expect(csvCell(null)).toBe("");
    const s: LinkSuggestion = {
      id: "x",
      source: { pageId: "a", url: "https://shop.example.com/a?x=1,2", title: null },
      target: { pageId: "b", url: "https://shop.example.com/b", title: null, inlinks: 0, orphan: true },
      sentence: { index: 0, text: 'Care for "unlacquered" brass, gently.' },
      anchor: { text: "unlacquered brass" },
      role: null,
      method: "deterministic",
      decision: null,
      status: "review",
      score: 1,
      reasons: [],
      userStatus: "open",
    };
    const out = linksCsv([s]).split("\r\n");
    expect(out[0]).toBe(CSV_COLUMNS.join(","));
    expect(out[1]).toBe('"https://shop.example.com/a?x=1,2",https://shop.example.com/b,unlacquered brass,"Care for ""unlacquered"" brass, gently.",,review,,,,,');
  });
});
