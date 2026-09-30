/** [A21] Per-page on-page checklist: measured per URL, manual items per page, tenancy. */
import { describe, expect, it } from "vitest";
import { createApp } from "@worker/app";
import type { Checklist, ChecklistItem } from "@shared/types";
import { Db } from "@worker/lib/db";
import { getPageChecklist } from "@worker/checklists/service";
import { candidateUrl } from "@worker/checklists/items/page";
import { newId } from "@worker/lib/ids";
import { createTestEnv } from "./helpers/env";
import { authHeaders, FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";
import { projectRow, seedCrawl, seedGsc, U, type PageSeed } from "./checklists-seed";

const ARTICLE = "/blog/brass-vs-bronze-pulls";
const SITE: PageSeed[] = [
  { path: "/", pageType: "home", links: ["/collections/pulls", ARTICLE, "/app"] },
  { path: "/collections/pulls", pageType: "collection", links: ["/", ARTICLE] },
  {
    path: ARTICLE,
    pageType: "article",
    title: "Brass vs bronze cabinet pulls: finish, cost and care guide",
    meta: "How solid brass and bronze cabinet pulls compare on finish, durability, cost and care, with a table of real measurements.",
    firstParagraph: "Brass and bronze cabinet pulls differ mainly in color, patina, and price.",
    excerpt: "Brass and bronze cabinet pulls differ mainly in color, patina, and price. Bronze darkens faster. Care for brass with mild soap.",
    tables: 1,
    links: ["/", "/collections/pulls"],
  },
  { path: "/app", pageType: "other", skipped: "js_rendered", words: 4, h1: [], headings: [], images: 0, title: "Loading…", meta: null },
];

async function setup() {
  const env = createTestEnv();
  const a = await seedUser(env);
  const db = new Db(env.DB);
  const pid = await seedProject(env, a.workspaceId);
  const { pageIds } = await seedCrawl(db, a.workspaceId, pid, { pages: SITE });
  await seedGsc(db, a.workspaceId, pid, [
    ["brass vs bronze cabinet pulls", ARTICLE, "current", 60, 1200, 4.2],
    ["bronze pull care", ARTICLE, "current", 10, 300, 8.1],
    ["brass pulls", "/collections/pulls", "current", 50, 1000, 3.0],
  ]);
  return { env, db, a, pid, pageIds };
}

const item = (c: Checklist, id: string): ChecklistItem => {
  const i = c.items.find((x) => x.id === id);
  if (!i) throw new Error(`missing ${id}`);
  return i;
};

describe("per-page checklist", () => {
  it("a good article is mostly met, in the reference's numbered order", async () => {
    const { env, db, pid, pageIds } = await setup();
    const c = await getPageChecklist(env, db, await projectRow(db, pid), pageIds[ARTICLE]!, FIXED_NOW);
    expect(c.kind).toBe("page");
    expect(c.state).toBe("ready");
    expect(c.page).toMatchObject({ id: pageIds[ARTICLE], url: U(ARTICLE), pageType: "article", topQuery: "brass vs bronze cabinet pulls" });
    expect(c.items).toHaveLength(16);
    expect(c.items.map((i) => i.section)).toEqual([
      ...Array(4).fill("before_write"),
      ...Array(4).fill("while_write"),
      ...Array(4).fill("details"),
      ...Array(4).fill("publish_check"),
    ]);
    expect(c.items[0]?.id).toBe("page.before_write.search_intent");
    for (const id of [
      "page.before_write.topic_coverage",
      "page.while_write.answer_early",
      "page.while_write.headings",
      "page.while_write.crawlable_text",
      "page.details.title",
      "page.details.meta_description",
      "page.details.url",
      "page.details.alt_text",
      "page.publish_check.internal_links",
      "page.publish_check.sources",
      "page.publish_check.indexability",
    ]) {
      expect(item(c, id).status, id).toBe("met");
    }
    // Heuristic intent: "vs" query on an article page.
    expect(item(c, "page.before_write.search_intent")).toMatchObject({ status: "met", method: "heuristic" });
    expect(item(c, "page.before_write.unique_angle").status).toBe("manual");
    // CWV never verifiable here, so this item is at most partial.
    const ux = item(c, "page.publish_check.structured_data_ux");
    expect(ux.status).toBe("partial");
    expect(ux.summary).toMatch(/Core Web Vitals: not connected/);
    expect(item(c, "page.while_write.terms_entities").caveat).toMatch(/Never add terms unnaturally/);
    expect(c.counts.met).toBeGreaterThanOrEqual(12);
    expect(c.disclaimer).toMatch(/None guarantees/);
    for (const i of c.items) expect(i.tacticTier).toBeNull();
  });

  it("uses a Jev intent-fit decision for the page when present, flagged as 'Check this yourself'", async () => {
    const { env, db, a, pid, pageIds } = await setup();
    await db.insert("decision_records", {
      id: newId("dec"),
      workspace_id: a.workspaceId,
      project_id: pid,
      agent: "seo",
      candidate_key: "seo:x:abc",
      question_id: "seo.intent_page_fit",
      question_version: "v1",
      policy_version: "p1",
      provider: "typesafe",
      model: "jev-test",
      answer_json: JSON.stringify({ answer: { type: "choice", choice: "partial_fit", confidence: 0.61, probabilities: { partial_fit: 0.61, fits: 0.3, mismatch: 0.09 } }, candidate: `striking_distance:bronze pull care|${U(ARTICLE)}`, questionTier: "flag" }),
      tier: "flag",
      outcome: "selected",
      created_at: FIXED_NOW.toISOString(),
    });
    const c = await getPageChecklist(env, db, await projectRow(db, pid), pageIds[ARTICLE]!, FIXED_NOW);
    const intent = item(c, "page.before_write.search_intent");
    expect(intent.status).toBe("partial");
    expect(intent.summary).toMatch(/Check this yourself; runner-up: fits/);
    expect(candidateUrl(`weak_ctr:${U("/a")}`)).toBe(U("/a"));
    expect(candidateUrl("duplicate:abc")).toBeNull();
  });

  it("a thin JS-rendered page fails crawlable text and headings", async () => {
    const { env, db, pid, pageIds } = await setup();
    const c = await getPageChecklist(env, db, await projectRow(db, pid), pageIds["/app"]!, FIXED_NOW);
    expect(item(c, "page.while_write.crawlable_text").status).toBe("not_met");
    expect(item(c, "page.while_write.headings").status).toBe("not_met");
    expect(item(c, "page.details.meta_description").status).toBe("not_met");
    expect(item(c, "page.before_write.topic_coverage").status).toBe("manual"); // no GSC queries -> manual
  });

  it("persists manual answers per page, rejects measured items, and isolates projects and tenants", async () => {
    const { env, a, pid, pageIds } = await setup();
    const app = createApp();
    const H = authHeaders(a.sessionToken, a.csrfToken);
    const base = (pageId: string, project = pid) => `/api/projects/${project}/pages/${pageId}/checklist`;
    const art = pageIds[ARTICLE]!;

    const put = await app.request(`${base(art)}/page.before_write.unique_angle`, { method: "PUT", headers: H, body: JSON.stringify({ checked: true, note: "Our own finish tests" }) }, env);
    expect(put.status).toBe(200);
    expect(((await put.json()) as { data: ChecklistItem }).data.manual).toMatchObject({ checked: true, note: "Our own finish tests", updatedBy: "Test User" });
    const get = await app.request(base(art), { headers: H }, env);
    const c = ((await get.json()) as { data: Checklist }).data;
    expect(item(c, "page.before_write.unique_angle").manual?.checked).toBe(true);
    // Another page of the same project does not inherit the answer.
    const other = ((await (await app.request(base(pageIds["/collections/pulls"]!), { headers: H }, env)).json()) as { data: Checklist }).data;
    expect(item(other, "page.before_write.unique_angle").manual?.checked).toBe(false);

    expect((await app.request(`${base(art)}/page.details.title`, { method: "PUT", headers: H, body: JSON.stringify({ checked: true }) }, env)).status).toBe(400);
    expect((await app.request(`${base(art)}/page.details.nope`, { method: "PUT", headers: H, body: JSON.stringify({ checked: true }) }, env)).status).toBe(404);
    expect((await app.request(base("pg_missing"), { headers: H }, env)).status).toBe(404);

    // A page of another project in the same workspace is not reachable through this project.
    const pid2 = await seedProject(env, a.workspaceId);
    expect((await app.request(base(art, pid2), { headers: H }, env)).status).toBe(404);

    // Another tenant.
    const b = await seedUser(env);
    const HB = authHeaders(b.sessionToken, b.csrfToken);
    expect((await app.request(base(art), { headers: HB }, env)).status).toBe(404);
    expect((await app.request(`${base(art)}/page.before_write.unique_angle`, { method: "PUT", headers: HB, body: JSON.stringify({ checked: true }) }, env)).status).toBe(404);
  });
});
