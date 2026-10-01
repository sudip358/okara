/**
 * Follow-up fixes for rewrite plans (GET /projects/:pid/geo/rewrite-plans) and skip-factor evidence:
 *  - our page evidence is loaded in batched queries and inlinks are computed once per crawl run, so the
 *    number of D1 queries does not grow with the number of plans (50 plans);
 *  - the engine of an 'adapt' cited page comes from one chunked lookup that joins on project_id and
 *    matches canonical URLs (uppercase host / fragment in the stored citation still match), API only.
 */
import { describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { Db } from "@worker/lib/db";
import { newId } from "@worker/lib/ids";
import { buildRewritePlans, MAX_PLANS } from "@worker/geo/rewrite-plan";
import { computeInlinkMap, inlinkCount, loadOurPageEvidence, loadOurPagesEvidence } from "@worker/geo/skip-factors";
import { FIXED_NOW, seedProject } from "./helpers/fixtures";
import { hoursAgo, projectRow, seedCrawl, seedObservation, setup, U, type Setup } from "./coverage-seed";

function countingDb(raw: D1Database): { db: Db; count: () => number; reset: () => void } {
  let n = 0;
  const proxy = new Proxy(raw as object, {
    get(t, p) {
      const v = (t as Record<string | symbol, unknown>)[p];
      if (p === "prepare") {
        return (sql: string) => {
          n++;
          return (v as (s: string) => unknown).call(t, sql);
        };
      }
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  }) as D1Database;
  return { db: new Db(proxy), count: () => n, reset: () => (n = 0) };
}

async function seedRec(s: Setup, url: string) {
  const id = newId("rec");
  await s.db.insert("recommendations", {
    id, workspace_id: s.ws, project_id: s.pid, agent: "geo", scope: "page", target_json: JSON.stringify({ kind: "url", url }), issue_type: "geo_gap", trigger: "t", issue: "i",
    action: "a", rationale: "r", effort: "low", uncertainty: "low", limitations: "l", verified: 0, priority: 2, priority_version: "v",
    evidence_ids_json: "[]", dedup_key: id, status: "open", created_at: hoursAgo(1), updated_at: hoursAgo(1),
  });
}

async function seedAdapt(s: Setup, id: string, url: string, host: string, our: { pageId: string; url: string }) {
  await s.db.insert("competitor_pages", {
    id, workspace_id: s.ws, project_id: s.pid, url, host, approved_by: s.user.userId, approved_at: hoursAgo(1), fetched_at: hoursAgo(1),
    status: "assessed", verdict: "adapt", verdict_version: "competitor-verdict.v1",
    extraction_json: JSON.stringify({ question: "Where to buy brass knobs", ourPage: our }), created_at: hoursAgo(1), updated_at: hoursAgo(1),
  });
}

/** n pages, each with an open GEO rec and an adapt cited page on its own host (cited by an API answer). */
async function seedPlans(n: number) {
  const s = await setup();
  const paths = Array.from({ length: n }, (_, i) => `/p${i}`);
  const { pageIds, crawlId } = await seedCrawl(s, paths.map((path) => ({ path })));
  // Every other page links to /p0 (plus a self link on /p0, which must not count).
  for (const p of paths) await s.db.run("UPDATE page_snapshots SET internal_links_json = ? WHERE page_id = ? AND crawl_run_id = ?", JSON.stringify([U("/p0"), U(p)]), pageIds[p], crawlId);
  for (const [i, p] of paths.entries()) {
    await seedRec(s, U(p));
    await seedAdapt(s, `cmp_${i}`, `https://cmp${i}.example/best`, `cmp${i}.example`, { pageId: pageIds[p]!, url: U(p) });
    await seedObservation(s, { promptId: null, promptText: `q${i}`, provider: "perplexity", citations: [{ url: `https://CMP${i}.example/best#reviews` }] });
  }
  return { s, pageIds, crawlId };
}

describe("rewrite plans: bounded queries", () => {
  it("50 plans use the same, small number of D1 queries as 10 plans", async () => {
    const counts: number[] = [];
    for (const n of [10, MAX_PLANS]) {
      const { s } = await seedPlans(n);
      const c = countingDb(s.env.DB);
      const project = await projectRow(s.db, s.pid);
      const r = await buildRewritePlans(c.db, project, FIXED_NOW);
      expect(r.plans).toHaveLength(n);
      for (const p of r.plans) expect(p.engine).toBe("perplexity");
      counts.push(c.count());
    }
    expect(counts[1]).toBe(counts[0]);
    expect(counts[1]).toBeLessThanOrEqual(30);
  });

  it("inlinks are counted from the whole crawl run once, excluding self links", async () => {
    const { s, pageIds, crawlId } = await seedPlans(5);
    const project = await projectRow(s.db, s.pid);
    const map = await computeInlinkMap(s.db, project, crawlId);
    expect(inlinkCount(map, pageIds["/p0"]!, U("/p0"))).toBe(4);
    expect(inlinkCount(map, pageIds["/p1"]!, U("/p1"))).toBe(0);

    const batch = await loadOurPagesEvidence(s.db, project, Object.values(pageIds));
    expect(batch.get(pageIds["/p0"]!)!.evidence!.inlinks).toBe(4);
    expect(batch.get(pageIds["/p3"]!)!.evidence!.inlinks).toBe(0);
    const single = await loadOurPageEvidence(s.db, project, pageIds["/p0"]!);
    expect(single!.evidence!.inlinks).toBe(4);

    const r = await buildRewritePlans(s.db, project, FIXED_NOW);
    const p0 = r.plans.find((p) => p.pageId === pageIds["/p0"])!;
    expect(p0.items.find((i) => i.key === "internal_links")).toMatchObject({ status: "done" });
    const p1 = r.plans.find((p) => p.pageId === pageIds["/p1"])!;
    expect(p1.items.find((i) => i.key === "internal_links")).toMatchObject({ status: "todo" });
  });

  it("evidence uses the latest snapshot per page and ignores pages of other projects", async () => {
    const s = await setup();
    const { pageIds } = await seedCrawl(s, [{ path: "/a", words: 100 }], [], { startedAt: hoursAgo(10) });
    await seedCrawl(s, [{ path: "/a", words: 900 }], [], { startedAt: hoursAgo(2) });
    const project = await projectRow(s.db, s.pid);
    const ev = await loadOurPagesEvidence(s.db, project, [pageIds["/a"]!, "pg_missing"]);
    expect(ev.get(pageIds["/a"]!)!.evidence!.wordCount).toBe(900);
    expect(ev.has("pg_missing")).toBe(false);
    const otherPid = await seedProject(s.env, s.ws);
    expect((await loadOurPagesEvidence(s.db, { id: otherPid, workspace_id: s.ws }, [pageIds["/a"]!])).size).toBe(0);
  });
});

describe("rewrite plans: adapt engine lookup", () => {
  it("matches canonical URLs within the project, from API answers only", async () => {
    const s = await setup();
    const { pageIds } = await seedCrawl(s, [{ path: "/a" }, { path: "/b" }]);
    await seedAdapt(s, "cmp_a", "https://cmp.example/best", "cmp.example", { pageId: pageIds["/a"]!, url: U("/a") });
    await seedAdapt(s, "cmp_b", "https://manual.example/x", "manual.example", { pageId: pageIds["/b"]!, url: U("/b") });
    // API answer citing the page with an uppercase host and a fragment (same canonical URL).
    await seedObservation(s, { promptId: null, promptText: "q", provider: "gemini", createdAt: hoursAgo(5), citations: [{ url: "https://CMP.example/best#top" }] });
    // Newer answer in ANOTHER project of the same workspace: must not leak.
    const otherPid = await seedProject(s.env, s.ws);
    await seedObservation({ db: s.db, ws: s.ws, pid: otherPid }, { promptId: null, promptText: "q", provider: "perplexity", createdAt: hoursAgo(1), citations: [{ url: "https://cmp.example/best" }] });
    // Manual import citing the second page: not an engine.
    await seedObservation(s, { promptId: null, promptText: "q", measurement: "manual_import", citations: [{ url: "https://manual.example/x" }] });

    const r = await buildRewritePlans(s.db, await projectRow(s.db, s.pid), FIXED_NOW);
    const by = new Map(r.plans.map((p) => [p.competitorAssessmentId, p]));
    expect(by.get("cmp_a")!.engine).toBe("gemini");
    expect(by.get("cmp_b")!.engine).toBeNull();
  });
});
