import { it } from "vitest";
import { Db } from "@worker/lib/db";
import { seedDemoProject } from "@worker/demo/seed";
import { buildLiveSeo } from "@worker/live/seo-board";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, seedUser } from "./helpers/fixtures";

it("scratch", async () => {
  const env = createTestEnv({ DEMO_MODE: "true" });
  const u = await seedUser(env);
  const db = new Db(env.DB);
  const demo = await seedDemoProject(env, db, u.userId, FIXED_NOW);
  const run = (await db.first<{ id: string }>("SELECT id FROM agent_runs WHERE project_id = ? AND agent = 'seo'", demo.id))!;
  const r = (await buildLiveSeo(db, demo, run.id, { now: FIXED_NOW, limit: 200 }))!;
  for (const e of r.elements) console.log(e.at.slice(11, 19), e.role.padEnd(7), e.targetLabel.padEnd(36), e.element.padEnd(13), e.verdict.padEnd(7), (e.jev ? `${e.jev.tier} ${e.jev.noul ?? e.jev.choice}` : e.rule?.class), "|", e.now, "->", e.proposed, "|", e.gsc ? `${e.gsc.clicks}c ${e.gsc.position} ${e.gsc.basis}` : "-", e.recommendationId ? "rec" : "");
  for (const q of r.queries) console.log(q.queryKey, q.band, q.jev.tier, q.jev.noul, q.gsc);
  console.log(JSON.stringify({ totals: r.totals, gscSync: r.gscSync, labels: r.labels, recs: r.recommendations.map((x) => [x.targetLabel, x.issueType, x.tier, x.evidenceCount]) }, null, 1));
});
