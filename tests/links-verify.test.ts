/**
 * Internal-links workbench, item 7: auto-verification of placed links. Expected links come from suggestions you
 * accepted or implemented and from the imported sheet's placed links; each is checked against the latest snapshot of
 * its source page: verified (target, redirecting URL, final URL, canonical variant), not found, pending (no crawl since
 * the link was placed), or source unavailable. Not-found implemented/sheet links reach the Overview attention feed.
 */
import { describe, expect, it } from "vitest";
import type { AttentionFeed, PlacedLinksReport } from "@shared/types";
import { createApp } from "@worker/app";
import { Db } from "@worker/lib/db";
import { newId } from "@worker/lib/ids";
import { buildAndStoreLinkGraph } from "@worker/links/graph-store";
import { linkVerificationAttention, placedLinksReport, updateLinkUserStatus } from "@worker/links/report";
import { parseSheetDate } from "@worker/links/verify";
import { normalizeUrlKey } from "@worker/seo/rules/registry";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, authHeaders, seedProject, seedUser } from "./helpers/fixtures";
import { U, projectRow, seedLinkCrawl, type LinkPageSeed } from "./links-seed";

describe("sheet dates", () => {
  it("parses ISO, US and day-first dates and month names; rejects impossible dates", () => {
    expect(parseSheetDate("2026-09-14")).toBe("2026-09-14T00:00:00.000Z");
    expect(parseSheetDate("9/14/2026")).toBe("2026-09-14T00:00:00.000Z");
    expect(parseSheetDate("14/9/2026")).toBe("2026-09-14T00:00:00.000Z");
    expect(parseSheetDate("9/14/26")).toBe("2026-09-14T00:00:00.000Z");
    expect(parseSheetDate("2026-02-30")).toBeNull();
    expect(parseSheetDate("13/13/2026")).toBeNull();
    expect(parseSheetDate("")).toBeNull();
    expect(parseSheetDate("soon")).toBeNull();
    expect(parseSheetDate("Sep 14, 2026")).toMatch(/^2026-09-1[34]T/); // month-name dates use the runtime's local day
  });
});

const PAGES: LinkPageSeed[] = [
  { path: "/products/brass-lamp", pageType: "product", title: "Brass Lamp", anchors: [] },
  { path: "/products/oak-lamp", pageType: "product", title: "Oak Lamp", anchors: [] },
  { path: "/guide", pageType: "article", title: "Guide", anchors: [] },
  { path: "/old-guide", status: 301, finalPath: "/guide", title: null },
  { path: "/final-page", pageType: "article", title: "Final page", anchors: [] },
  { path: "/moved", status: 301, finalPath: "/final-page", title: null },
  { path: "/blogs/news/a", pageType: "article", title: "A", anchors: [["/products/brass-lamp", "brass lamp", "c"]] },
  { path: "/blogs/news/b", pageType: "article", title: "B", anchors: [["/collections/lamps/products/oak-lamp", "oak lamp", "c"]] },
  { path: "/blogs/news/c", pageType: "article", title: "C", anchors: [["/old-guide", "the guide", "c"]] },
  { path: "/blogs/news/d", pageType: "article", title: "D", anchors: [["/final-page", "final page", "c"]] },
  { path: "/blogs/news/e", pageType: "article", title: "E", links: ["/"], anchors: [] },
  { path: "/blogs/news/f", pageType: "article", title: "F", anchors: [] },
  { path: "/blogs/news/g", status: 404, title: "Not found" },
];

async function setup() {
  const env = createTestEnv();
  const user = await seedUser(env);
  const projectId = await seedProject(env, user.workspaceId);
  const db = new Db(env.DB);
  const { pageIds } = await seedLinkCrawl(db, user.workspaceId, projectId, PAGES, { fetchedAt: FIXED_NOW.toISOString() });
  const runId = newId("lrun");
  await db.insert("link_runs", { id: runId, workspace_id: user.workspaceId, project_id: projectId, status: "completed", method_version: "test", created_at: "2026-09-20T00:00:00.000Z" });
  const suggestion = async (src: string, tgt: string, userStatus: "accepted" | "implemented", changed: string) => {
    const id = newId("lsug");
    await db.insert("link_suggestions", {
      id,
      workspace_id: user.workspaceId,
      project_id: projectId,
      link_run_id: runId,
      source_page_id: pageIds[src]!,
      target_page_id: pageIds[tgt]!,
      source_url: U(src),
      target_url: U(tgt),
      suggestion_key: `${src}|${tgt}|x`,
      anchor_text: "x",
      method: "deterministic",
      status: "review",
      score: 1,
      reasons_json: "[]",
      user_status: userStatus,
      status_changed_at: changed,
      created_at: "2026-09-20T00:00:00.000Z",
      updated_at: changed,
    });
    return id;
  };
  const sheet = async (src: string, tgt: string, date: string | null) => {
    await db.insert("import_records", {
      id: newId("irec"),
      workspace_id: user.workspaceId,
      project_id: projectId,
      destination: "implemented_links",
      record_key: `${src}>${tgt}`,
      label: `${src} -> ${tgt}`,
      status: "placed",
      data_json: JSON.stringify({ source: U(src), target: U(tgt), anchor: "sheet anchor", date, method: "wrap existing", hub: "lamps", sheetStatus: "Done" }),
      source_key: "csv:links.csv",
      first_import_id: "imp_1",
      last_import_id: "imp_1",
      created_at: "2026-09-25T00:00:00.000Z",
      updated_at: "2026-09-25T00:00:00.000Z",
    });
  };
  return { env, db, user, projectId, pageIds, suggestion, sheet };
}

type Row = { source_key: string; target_key: string; status: string; matched_via: string | null; detail: string; origins: string; expected_since: string; checked_at: string | null };
const K = (p: string) => normalizeUrlKey(U(p));

describe("auto-verify", () => {
  it("verifies placed links by target, redirecting URL, final URL and canonical; reports not found, pending and unavailable sources", async () => {
    const { env, db, user, projectId, suggestion, sheet } = await setup();
    await suggestion("/blogs/news/a", "/products/brass-lamp", "implemented", "2026-09-29T08:00:00.000Z");
    await suggestion("/blogs/news/e", "/products/brass-lamp", "accepted", "2026-09-29T08:00:00.000Z");
    const fId = await suggestion("/blogs/news/f", "/products/brass-lamp", "implemented", "2026-10-01T09:00:00.000Z");
    await sheet("/blogs/news/a", "/products/brass-lamp", "2026-09-27");
    await sheet("/blogs/news/b", "/products/oak-lamp", "9/28/2026");
    await sheet("/blogs/news/c", "/guide", "2026-09-28");
    await sheet("/blogs/news/d", "/moved", null);
    await sheet("/blogs/news/e", "/guide", "2026-09-20");
    await sheet("/blogs/news/g", "/guide", "2026-09-20");
    await sheet("/blogs/news/h", "/guide", "2026-09-20");

    const project = await projectRow(db, projectId);
    await buildAndStoreLinkGraph(db, project, { trigger: "manual", now: FIXED_NOW });
    const rows = await db.all<Row>("SELECT * FROM link_verifications WHERE project_id = ? ORDER BY source_key, target_key", projectId);
    const get = (s: string, t: string) => rows.find((r) => r.source_key === K(s) && r.target_key === K(t))!;
    expect(rows).toHaveLength(9);

    const a = get("/blogs/news/a", "/products/brass-lamp");
    expect(a).toMatchObject({ status: "verified", matched_via: "target", origins: "implemented,sheet", expected_since: "2026-09-27T00:00:00.000Z" });
    expect(a.detail).toBe("Verified on 2026-09-30: the source page links to the target.");
    expect(get("/blogs/news/b", "/products/oak-lamp")).toMatchObject({ status: "verified", matched_via: "canonical" });
    expect(get("/blogs/news/c", "/guide")).toMatchObject({ status: "verified", matched_via: "redirecting_url" });
    expect(get("/blogs/news/d", "/moved")).toMatchObject({ status: "verified", matched_via: "final_url", expected_since: "2026-09-25T00:00:00.000Z" });
    const e = get("/blogs/news/e", "/guide");
    expect(e).toMatchObject({ status: "not_found", origins: "sheet", checked_at: FIXED_NOW.toISOString() });
    expect(e.detail).toBe("Not found in the crawl of 2026-09-30: the source page does not link to the target.");
    expect(get("/blogs/news/e", "/products/brass-lamp")).toMatchObject({ status: "not_found", origins: "accepted" });
    expect(get("/blogs/news/f", "/products/brass-lamp").status).toBe("pending");
    expect(get("/blogs/news/f", "/products/brass-lamp").detail).toBe("Waiting for the next crawl of the source page (last crawled 2026-09-30, before the link was placed).");
    expect(get("/blogs/news/g", "/guide")).toMatchObject({ status: "source_unavailable", detail: "The source page returned HTTP 404 in the crawl of 2026-09-30." });
    expect(get("/blogs/news/h", "/guide")).toMatchObject({ status: "pending", detail: "Waiting for the first crawl of the source page.", checked_at: null });

    // Attention feed: implemented or sheet-placed links not found (accepted ones are not yet placed).
    const attention = await linkVerificationAttention(db, project);
    expect(attention).toMatchObject({ notFound: 1, checkedAt: FIXED_NOW.toISOString(), examples: [{ sourceUrl: K("/blogs/news/e"), targetUrl: K("/guide") }] });
    const H = authHeaders(user.sessionToken, user.csrfToken);
    const feed = (await (await createApp().request(`/api/projects/${projectId}/attention`, { headers: H }, env)).json()) as { data: AttentionFeed };
    expect(feed.data.linkVerification).toMatchObject({ notFound: 1 });

    // Placed & verified tab.
    const placed: PlacedLinksReport = await placedLinksReport(db, project);
    expect(placed.counts).toEqual({ total: 9, verified: 4, notFound: 2, pending: 2, sourceUnavailable: 1, notChecked: 0 });
    expect(placed.rows[0]!.verification.status).toBe("not_found");
    const pa = placed.rows.find((r) => r.sourceUrl === U("/blogs/news/a"))!;
    expect(pa.origins.sort()).toEqual(["implemented", "sheet"]);
    expect(pa.verification.label).toBe("verified on 2026-09-30");
    const pe = placed.rows.find((r) => r.sourceUrl === U("/blogs/news/e") && r.targetUrl === U("/guide"))!;
    expect(pe).toMatchObject({ method: "wrap existing", hub: "lamps", placedOn: "2026-09-20" });
    expect(pe.verification.label).toBe("not found in crawl of 2026-09-30");

    // The next crawl of E and F finds the links; dismissing the accepted suggestion drops its expectation.
    await seedLinkCrawl(
      db,
      user.workspaceId,
      projectId,
      [
        { path: "/blogs/news/e", pageType: "article", title: "E", anchors: [["/guide/", "the guide", "c"]] },
        { path: "/blogs/news/f", pageType: "article", title: "F", anchors: [["/products/brass-lamp", "brass lamp", "c"]] },
      ],
      { startedAt: "2026-10-02T10:00:00.000Z", fetchedAt: "2026-10-02T10:00:00.000Z" },
    );
    const accepted = await db.first<{ id: string }>("SELECT id FROM link_suggestions WHERE project_id = ? AND user_status = 'accepted'", projectId);
    await updateLinkUserStatus(db, project, accepted!.id, "dismissed", new Date("2026-10-02T11:00:00.000Z"));
    await buildAndStoreLinkGraph(db, project, { trigger: "manual", now: new Date("2026-10-02T12:00:00.000Z") });
    const after = await db.all<Row>("SELECT * FROM link_verifications WHERE project_id = ?", projectId);
    expect(after).toHaveLength(8);
    const again = (s: string, t: string) => after.find((r) => r.source_key === K(s) && r.target_key === K(t))!;
    expect(again("/blogs/news/e", "/guide")).toMatchObject({ status: "verified", detail: "Verified on 2026-10-02: the source page links to the target." });
    expect(again("/blogs/news/f", "/products/brass-lamp")).toMatchObject({ status: "verified", matched_via: "target" });
    expect(await linkVerificationAttention(db, project)).toBeNull();
    expect(fId).toBeTruthy();
  });

  it("keeps verifications per tenant", async () => {
    const a = await setup();
    await a.sheet("/blogs/news/e", "/guide", "2026-09-20");
    await buildAndStoreLinkGraph(a.db, await projectRow(a.db, a.projectId), { trigger: "manual", now: FIXED_NOW });
    const other = await seedUser(a.env);
    const otherProject = await seedProject(a.env, other.workspaceId);
    const op = await projectRow(a.db, otherProject);
    expect(await linkVerificationAttention(a.db, op)).toBeNull();
    expect((await placedLinksReport(a.db, op)).rows).toEqual([]);
    expect((await linkVerificationAttention(a.db, await projectRow(a.db, a.projectId)))!.notFound).toBe(1);
  });
});
