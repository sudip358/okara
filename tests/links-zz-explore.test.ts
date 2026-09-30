import { it } from "vitest";
import { Db } from "@worker/lib/db";
import { runLinkSuggestions } from "@worker/links/run";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";
import { STORE, projectRow, seedLinkCrawl, seedGscImpressions } from "./links-seed";

it("explore", async () => {
  const env = createTestEnv();
  const { workspaceId } = await seedUser(env);
  const pid = await seedProject(env, workspaceId);
  const db = new Db(env.DB);
  await seedLinkCrawl(db, workspaceId, pid, STORE);
  await seedGscImpressions(db, workspaceId, pid, [{ path: "/blogs/news/brass-care", impressions: 1200 }]);
  const r = await runLinkSuggestions(env, db, await projectRow(db, pid), FIXED_NOW, { decisions: null });
  console.log(JSON.stringify({ ...r, suggestions: r.suggestions.map((s) => ({ src: s.source.url, tgt: s.target.url, sent: s.sentence?.text, anchor: s.anchor?.text, score: s.score, status: s.status, reasons: s.reasons })) }, null, 1));
});
