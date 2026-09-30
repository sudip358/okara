/** Test scenario builder for the seo-analysis module: seeded tenant, crawl, GSC sync via the fake provider. */
import type { Env } from "@worker/env";
import type { RunContext } from "@worker/runs/context";
import { syncGsc } from "@worker/seo/gsc/sync";
import { createTestEnv } from "../../helpers/env";
import { makeTestContext } from "../../helpers/context";
import { seedProject, seedUser } from "../../helpers/fixtures";
import { DEFAULT_GSC_DATA, fakeGsc, seedCrawl, seedEngineQueries, seedPillars, type FakeGscData, type SeedOptions } from "./site";

export interface ScenarioOptions extends SeedOptions {
  /** false = no crawl seeded. */
  crawl?: boolean;
  /** null = no GSC sync. */
  gsc?: FakeGscData | null;
  engineQueries?: string[];
  pillars?: string | null;
  project?: Record<string, unknown>;
}

export interface Scenario {
  env: Env;
  userId: string;
  workspaceId: string;
  projectId: string;
  project: { id: string; workspaceId: string };
  ctx: (overrides?: Partial<RunContext>) => ReturnType<typeof makeTestContext>;
}

export async function scenario(opts: ScenarioOptions = {}): Promise<Scenario> {
  const env = createTestEnv();
  const u = await seedUser(env);
  const projectId = await seedProject(env, u.workspaceId, opts.project ?? {});
  const project = { id: projectId, workspaceId: u.workspaceId };
  if (opts.crawl !== false) await seedCrawl(env, u.workspaceId, projectId, opts);
  const data = opts.gsc === undefined ? DEFAULT_GSC_DATA : opts.gsc;
  if (data) {
    const summary = await syncGsc(makeTestContext(env, project, { gsc: fakeGsc(data) }));
    if (summary.status !== "completed" && summary.status !== "no_data") throw new Error(`fixture sync failed: ${summary.status} ${summary.note}`);
  }
  if (opts.engineQueries?.length) await seedEngineQueries(env, u.workspaceId, projectId, opts.engineQueries);
  if (opts.pillars) await seedPillars(env, u.workspaceId, projectId, opts.pillars);
  return {
    env,
    userId: u.userId,
    workspaceId: u.workspaceId,
    projectId,
    project,
    ctx: (overrides = {}) => makeTestContext(env, project, overrides),
  };
}
