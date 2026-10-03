/**
 * Demo data behind the Live view internal-link containers (docs/live-view-design.md section 18): the demo seed's
 * link graph feeds 16-19, and its two fictional "accepted" suggestions (labelled demo fixtures, not reused by the demo
 * SEO run) give container 20 rows: one checked against the demo crawl (not found), one waiting for the next crawl.
 * The demo has no failing or redirecting link targets, so 17 shows its empty state.
 */
import { describe, expect, it } from "vitest";
import { DEMO_LINK_SUGGESTIONS } from "@worker/demo/fixtures";
import { seedDemoProject } from "@worker/demo/seed";
import { Db } from "@worker/lib/db";
import { anchorReport, brokenLinks, clusterReport, graphSummary } from "@worker/links/graph-read";
import { linkVerificationAttention, placedLinksReport } from "@worker/links/report";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, seedUser } from "./helpers/fixtures";

describe("demo data for the link containers", () => {
  it("every container has stored demo data or an honest empty state", async () => {
    const env = createTestEnv({ DEMO_MODE: "true", ENVIRONMENT: "development" });
    const { userId } = await seedUser(env);
    const db = new Db(env.DB);
    const project = await seedDemoProject(env, db, userId, FIXED_NOW);

    const g = await graphSummary(db, project, FIXED_NOW);
    expect(g.state).toBe("demo");
    expect(g.trigger).toBe("demo");
    expect(g.coverage).toMatchObject({ sitemapUrls: 8, sitemapAnalysed: 8 });
    expect(g.counts!.orphans).toBeGreaterThan(0);

    const broken = await brokenLinks(db, project, FIXED_NOW);
    expect(broken.state).toBe("demo");
    expect(broken.rows).toEqual([]);

    const clusters = await clusterReport(db, project);
    expect(clusters.hubs.length).toBeGreaterThan(0);
    expect(clusters.counts.partial + clusters.counts.unlinked).toBeGreaterThan(0);

    const anchors = await anchorReport(db, project);
    expect(anchors.rows.length).toBeGreaterThan(0);

    // The fictional accepted suggestions are never ones the demo SEO run reused (it only reuses open suggestions).
    expect(DEMO_LINK_SUGGESTIONS.filter((l) => l.accepted).every((l) => !l.reused)).toBe(true);
    const placed = await placedLinksReport(db, project);
    expect(placed.state).toBe("demo");
    expect(placed.counts).toMatchObject({ total: 2, notFound: 1, pending: 1, verified: 0 });
    const nf = placed.rows.find((r) => r.verification.status === "not_found")!;
    expect(nf.sourceUrl).toBe("https://demo.example/collections/sofas");
    expect(nf.verification.label).toMatch(/^not found in crawl of \d{4}-\d{2}-\d{2}$/);
    expect(placed.rows.every((r) => r.origins.join() === "accepted")).toBe(true);
    // Accepted-only links are not flagged on the Overview (only implemented or sheet-placed ones are).
    expect(await linkVerificationAttention(db, project)).toBeNull();
  });
});
