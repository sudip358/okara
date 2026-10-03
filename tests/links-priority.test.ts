/**
 * Internal-links workbench, item 3: priority = relevance x Search Console impact x cluster gap (versioned, code-owned).
 * Pure formula checks plus a run over seeded Search Console page rows: suggestions sorted by priority, the numbers and
 * the stored-sync label shown with every priority, and no search-volume claim.
 */
import { describe, expect, it } from "vitest";
import { Db } from "@worker/lib/db";
import { newId } from "@worker/lib/ids";
import { CLUSTER_GAP_BOOST, LINK_PRIORITY_VERSION, POSITION_FACTOR, SOURCE_CAP, computePriority, explainPriority, positionBand, type PriorityInput } from "@worker/links/priority";
import { runLinkSuggestions } from "@worker/links/run";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";
import { STORE, U, projectRow, seedLinkCrawl } from "./links-seed";

const base: PriorityInput = { relevance: 2, target: null, source: null, sourceInlinks: 0, hasGsc: false, clusterGap: null };
const metric = (impressions: number, position: number | null, clicks = 0) => ({ impressions, clicks, position, basis: "page_rows" as const });

describe("priority formula", () => {
  it("is neutral without Search Console data and never reports impressions", () => {
    const b = computePriority(base);
    expect(b.version).toBe(LINK_PRIORITY_VERSION);
    expect(b.impressionFactor).toBe(1);
    expect(b.positionFactor).toBe(1);
    expect(b.clickFactor).toBe(1);
    expect(b.inlinkFactor).toBe(1);
    expect(b.value).toBe(2);
    expect(b.target).toEqual({ impressions: null, clicks: null, position: null, basis: null });
    const lines = explainPriority(b, null);
    expect(lines[0]).toBe(`Priority 2.00 = relevance 2.00 × impact 1.00 (formula ${LINK_PRIORITY_VERSION}).`);
    expect(lines.join(" ")).toMatch(/no Search Console data \(neutral ×1\)/);
    expect(lines.join(" ")).not.toMatch(/search volume/i);
  });

  it("boosts striking distance (8–20) most, positions 1–3 least, and caps impressions and source factors", () => {
    expect(positionBand(1)).toBe("top_3");
    expect(positionBand(3)).toBe("top_3");
    expect(positionBand(3.4)).toBe("near_top");
    expect(positionBand(8)).toBe("striking_distance");
    expect(positionBand(20)).toBe("striking_distance");
    expect(positionBand(20.5)).toBe("beyond_20");
    expect(positionBand(null)).toBe("none");
    expect(positionBand(0)).toBe("none");
    expect(POSITION_FACTOR.striking_distance).toBeGreaterThan(POSITION_FACTOR.near_top);
    expect(POSITION_FACTOR.near_top).toBeGreaterThan(POSITION_FACTOR.top_3);
    expect(POSITION_FACTOR.top_3).toBeGreaterThan(POSITION_FACTOR.none);

    const striking = computePriority({ ...base, hasGsc: true, target: metric(100, 12) });
    // 1 + log10(101)/4 = 1.5011; x1.5 position.
    expect(striking.impressionFactor).toBeCloseTo(1.5011, 4);
    expect(striking.positionFactor).toBe(1.5);
    expect(striking.targetFactor).toBeCloseTo(2.2516, 3);
    expect(striking.value).toBeCloseTo(2 * 2.2516, 2);

    const top = computePriority({ ...base, hasGsc: true, target: metric(100, 2) });
    expect(top.positionBand).toBe("top_3");
    expect(top.value).toBeLessThan(striking.value);

    // Impressions saturate at x2 (10,000+); zero impressions keep both target factors at 1.
    expect(computePriority({ ...base, hasGsc: true, target: metric(10_000, 30) }).impressionFactor).toBe(2);
    expect(computePriority({ ...base, hasGsc: true, target: metric(5_000_000, 30) }).impressionFactor).toBe(2);
    const zero = computePriority({ ...base, hasGsc: true, target: metric(0, 12) });
    expect(zero.impressionFactor).toBe(1);
    expect(zero.positionBand).toBe("none");
    expect(zero.target.impressions).toBe(0);

    // Source: inlinks x clicks, capped.
    const src = computePriority({ ...base, hasGsc: true, source: metric(0, null, 1_000_000), sourceInlinks: 1_000_000 });
    expect(src.inlinkFactor).toBe(1.5);
    expect(src.clickFactor).toBe(1.4);
    expect(src.sourceFactor).toBe(SOURCE_CAP);
    const mid = computePriority({ ...base, sourceInlinks: 9 });
    expect(mid.inlinkFactor).toBe(1.25); // 1 + log10(10)/4

    // Cluster gap boost.
    const gap = computePriority({ ...base, clusterGap: "hub_to_spoke" });
    expect(gap.clusterFactor).toBe(CLUSTER_GAP_BOOST);
    expect(gap.value).toBe(2 * CLUSTER_GAP_BOOST);
    expect(explainPriority(gap, null)[0]).toMatch(/× cluster gap 1\.3/);

    // Bad relevance never produces NaN.
    expect(computePriority({ ...base, relevance: Number.NaN }).value).toBe(0);
  });

  it("explains the numbers with the stored sync window, and says impressions are not search volume", () => {
    const b = computePriority({ ...base, hasGsc: true, target: { impressions: 1234, clicks: 5, position: 11.26, basis: "query_page_rows" }, source: metric(0, null, 9), sourceInlinks: 4 });
    const lines = explainPriority(b, "Search Console 2026-09-01 – 2026-09-28, stored sync 2026-09-30");
    expect(lines[1]).toBe("Target: 1,234 impressions, 5 clicks, average position 11.3 (striking distance 8–20; ×1.77 impressions, ×1.5 position); summed from query rows (lower bound).");
    // (1 + log10(5)/4) x (1 + log10(10)/5) = 1.1747 x 1.2
    expect(lines[2]).toBe("Source: 4 inlinks in the link graph, 9 clicks (×1.41).");
    expect(lines[3]).toBe("Search Console figures: Search Console 2026-09-01 – 2026-09-28, stored sync 2026-09-30. These are your Search Console impressions, not search volume.");
  });
});

async function seedGscPages(db: Db, ws: string, pid: string, rows: Array<{ path: string; impressions: number; clicks?: number; position: number }>) {
  const syncId = newId("gsc");
  await db.insert("gsc_syncs", {
    id: syncId,
    workspace_id: ws,
    project_id: pid,
    source: "api",
    property: "sc-domain:example.com",
    window_start: "2026-09-01",
    window_end: "2026-09-28",
    prev_window_start: "2026-08-04",
    prev_window_end: "2026-08-31",
    row_cap: 5000,
    status: "completed",
    synced_at: "2026-09-30T06:00:00.000Z",
  });
  for (const r of rows) {
    await db.insert("gsc_metrics", {
      workspace_id: ws,
      project_id: pid,
      sync_id: syncId,
      window: "current",
      query: null,
      page: U(r.path),
      device: null,
      clicks: r.clicks ?? 0,
      impressions: r.impressions,
      ctr: (r.clicks ?? 0) / Math.max(1, r.impressions),
      position: r.position,
    });
  }
}

describe("priority in a run", () => {
  it("sorts suggestions by priority and shows the Search Console numbers behind each one", async () => {
    const env = createTestEnv();
    const { workspaceId } = await seedUser(env);
    const projectId = await seedProject(env, workspaceId);
    const db = new Db(env.DB);
    await seedLinkCrawl(db, workspaceId, projectId, STORE);
    await seedGscPages(db, workspaceId, projectId, [
      { path: "/blogs/news/brass-patina", impressions: 4000, clicks: 30, position: 12.4 },
      { path: "/blogs/news/brass-care", impressions: 4000, clicks: 400, position: 1.8 },
      { path: "/products/brass-pull", impressions: 50, clicks: 2, position: 35 },
    ]);
    const r = await runLinkSuggestions(env, db, await projectRow(db, projectId), FIXED_NOW, { decisions: null, writer: null });
    expect(r.state).toBe("ready");
    expect(r.priorityVersion).toBe(LINK_PRIORITY_VERSION);
    const withPriority = r.suggestions.filter((s) => s.priority);
    expect(withPriority.length).toBe(r.suggestions.length);
    expect(r.suggestions.length).toBeGreaterThan(1);
    // Same status (all review without Jev): strictly by priority, descending.
    const values = r.suggestions.map((s) => s.priority!.value);
    expect(values).toEqual([...values].sort((a, b) => b - a));

    const patina = r.suggestions.find((s) => s.target.url === U("/blogs/news/brass-patina"))!;
    expect(patina).toBeTruthy();
    expect(patina.priority!.positionBand).toBe("striking_distance");
    expect(patina.priority!.target).toMatchObject({ impressions: 4000, clicks: 30, position: 12.4, basis: "page_rows" });
    expect(patina.priority!.gscLabel).toBe("Search Console 2026-09-01 – 2026-09-28, stored sync 2026-09-30");
    expect(patina.priority!.explanation.join(" ")).toMatch(/not search volume/);
    expect(patina.priority!.value).toBeCloseTo(patina.priority!.relevance * patina.priority!.impact * patina.priority!.clusterFactor, 2);

    const care = r.suggestions.find((s) => s.target.url === U("/blogs/news/brass-care"));
    if (care) {
      expect(care.priority!.positionBand).toBe("top_3");
      expect(care.priority!.targetFactor).toBeLessThan(patina.priority!.targetFactor);
    }
    const run = await db.first<{ notes_json: string }>("SELECT notes_json FROM link_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1", projectId);
    expect(run!.notes_json).toMatch(/Priority \(links-priority-2026-10-03\.1\)/);
    expect(run!.notes_json).toMatch(/stored sync 2026-09-30/);
  });

  it("keeps impact neutral without Search Console data and says so", async () => {
    const env = createTestEnv();
    const { workspaceId } = await seedUser(env);
    const projectId = await seedProject(env, workspaceId);
    const db = new Db(env.DB);
    await seedLinkCrawl(db, workspaceId, projectId, STORE);
    const r = await runLinkSuggestions(env, db, await projectRow(db, projectId), FIXED_NOW, { decisions: null, writer: null });
    expect(r.suggestions.length).toBeGreaterThan(0);
    for (const s of r.suggestions) {
      expect(s.priority!.gscLabel).toBeNull();
      expect(s.priority!.target.impressions).toBeNull();
      expect(s.priority!.targetFactor).toBe(1);
      expect(s.priority!.explanation.join(" ")).toMatch(/no Search Console data/);
    }
  });
});
