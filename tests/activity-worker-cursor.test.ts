import { describe, expect, it } from "vitest";
import type { RunActivity } from "@shared/types";
import { Db } from "@worker/lib/db";
import { newId } from "@worker/lib/ids";
import type { ProjectRow } from "@worker/platform/access";
import { buildRunActivity, currentActivityRuns, decodeCursor, encodeCursor, mergeStreams, OBS_HOLD_MS } from "@worker/runs/activity";
import { DEFAULT_PROMPTS_PER_RUN } from "@worker/geo/batch";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";

const t = (sec: number) => new Date(FIXED_NOW.getTime() - 3_600_000 + sec * 1000).toISOString();
/** Seconds before FIXED_NOW (recent, inside the observation hold window). */
const ago = (sec: number) => new Date(FIXED_NOW.getTime() - sec * 1000).toISOString();

async function setup() {
  const env = createTestEnv();
  const u = await seedUser(env);
  const pid = await seedProject(env, u.workspaceId);
  const db = new Db(env.DB);
  const p = (await db.first<ProjectRow>("SELECT * FROM projects WHERE id = ?", pid))!;
  return { db, ws: u.workspaceId, pid, p };
}

async function seedRun(db: Db, ws: string, pid: string, agent: "seo" | "geo", status: string, extra: Record<string, unknown> = {}) {
  const id = newId("run");
  await db.insert("agent_runs", {
    id, workspace_id: ws, project_id: pid, agent, trigger: "manual", idempotency_key: `k-${id}`, status,
    created_at: t(0), started_at: t(0), finished_at: status === "running" || status === "pending" ? null : t(600), ...extra,
  });
  return id;
}

async function seedPromptSet(db: Db, ws: string, pid: string, n: number) {
  const setId = newId("gps");
  await db.insert("geo_prompt_sets", { id: setId, workspace_id: ws, project_id: pid, version: 1, active: 1, created_at: t(-100) });
  const prompts: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = newId("gp");
    prompts.push(id);
    await db.insert("geo_prompts", {
      id, workspace_id: ws, project_id: pid, prompt_set_id: setId, text: `prompt ${i}`, prompt_type: "discovery", locale: "en-US", language: "en", approved: 1, position: i,
    });
  }
  return { setId, prompts };
}

async function insertObs(db: Db, ws: string, pid: string, runId: string, o: { promptId: string; setId: string; provider: string; at: string; status?: string }) {
  const id = newId("obs");
  await db.insert("geo_observations", {
    id, workspace_id: ws, project_id: pid, run_id: runId, prompt_id: o.promptId, prompt_set_id: o.setId, prompt_text: "q", prompt_type: "discovery",
    cohort_key: "c1", provider: o.provider, model: "m", grounding_mode: "g", measurement_type: "api", status: o.status ?? "ok", grounded: 1,
    request_id: null, cost_usd: null, cost_is_estimate: 1, error: null, created_at: o.at,
  });
  return id;
}

async function analyse(db: Db, ws: string, pid: string, observationId: string, self: { mentioned: 0 | 1; cited: 0 | 1 }) {
  await db.insert("geo_brand_observations", {
    id: newId("gbo"), workspace_id: ws, project_id: pid, observation_id: observationId, brand_key: "self", is_self: 1, mentioned: self.mentioned, cited: self.cited,
    recommendation_status: "unknown", sentiment: "unknown", method: "deterministic",
  });
}

function decision(ws: string, pid: string, run: string, at: string, key: string, id = newId("dec")) {
  return { id, workspace_id: ws, project_id: pid, run_id: run, agent: "seo", candidate_key: key, question_id: "seo.q", tier: "act", outcome: "selected", created_at: at };
}

async function drain(db: Db, p: ProjectRow, run: string, limit: number, cursor: string | null = null, maxPages = 50) {
  const ids: string[] = [];
  let c = cursor;
  for (let i = 0; i < maxPages; i++) {
    const a = (await buildRunActivity(db, p, run, { now: FIXED_NOW, limit, after: decodeCursor(c) }))!;
    ids.push(...a.items.map((x) => x.id));
    if (a.items.length === 0) return { ids, cursor: a.cursor };
    c = a.cursor;
  }
  throw new Error("cursor did not converge");
}

describe("activity cursor: insertion high-water per source", () => {
  it("returns rows stamped earlier than an already-returned row (out-of-order timestamps)", async () => {
    const { db, ws, pid, p } = await setup();
    const run = await seedRun(db, ws, pid, "seo", "running");
    // Jev call 1 is recorded at T1 with a fresh clock...
    await db.insert("provider_calls", {
      id: newId("call"), workspace_id: ws, project_id: pid, run_id: run, provider: "typesafe", model: "m", purpose: "seo.q", status: "ok",
      cost_usd: null, cost_is_estimate: 1, created_at: t(100),
    });
    let a = (await buildRunActivity(db, p, run, { now: FIXED_NOW }))!;
    expect(a.items.map((i) => i.kind)).toEqual(["provider_call"]);
    const c1 = a.cursor!;
    // ...then its decisions arrive stamped with the batch clock T0 < T1.
    await db.insert("decision_records", decision(ws, pid, run, t(50), "late-1"));
    await db.insert("decision_records", decision(ws, pid, run, t(51), "late-2"));
    a = (await buildRunActivity(db, p, run, { now: FIXED_NOW, after: decodeCursor(c1) }))!;
    expect(a.items.map((i) => i.title)).toEqual(["Jev act: late-1", "Jev act: late-2"]);
    // And nothing again after that.
    const a2 = (await buildRunActivity(db, p, run, { now: FIXED_NOW, after: decodeCursor(a.cursor) }))!;
    expect(a2.items).toEqual([]);
    expect(a2.cursor).toBe(a.cursor);
  });

  it("returns a later row with the same timestamp and a lexically smaller id", async () => {
    const { db, ws, pid, p } = await setup();
    const run = await seedRun(db, ws, pid, "seo", "running");
    await db.insert("decision_records", decision(ws, pid, run, t(10), "first", "dec_zzzz"));
    const a = (await buildRunActivity(db, p, run, { now: FIXED_NOW }))!;
    expect(a.items.map((i) => i.id)).toEqual(["dec:dec_zzzz"]);
    await db.insert("decision_records", decision(ws, pid, run, t(10), "second", "dec_aaaa"));
    const b = (await buildRunActivity(db, p, run, { now: FIXED_NOW, after: decodeCursor(a.cursor) }))!;
    expect(b.items.map((i) => i.id)).toEqual(["dec:dec_aaaa"]);
  });

  it("pages every row exactly once with small limits and scrambled timestamps across sources", async () => {
    const { db, ws, pid, p } = await setup();
    const run = await seedRun(db, ws, pid, "seo", "completed");
    const want: string[] = [];
    const stamps = [50, 3, 40, 3, 99, 0, 7, 7, 20, 1];
    for (let i = 0; i < stamps.length; i++) {
      const evt = newId("evt");
      await db.insert("run_events", { id: evt, workspace_id: ws, project_id: pid, run_id: run, step: "seo.x", status: "info", message: `e${i}`, created_at: t(stamps[i]!) });
      const dec = newId("dec");
      await db.insert("decision_records", decision(ws, pid, run, t(stamps[(i + 3) % stamps.length]!), `d${i}`, dec));
      want.push(`evt:${evt}`, `dec:${dec}`);
    }
    for (const limit of [1, 2, 3, 7]) {
      const { ids } = await drain(db, p, run, limit);
      expect(ids.sort()).toEqual([...want].sort());
    }
  });

  it("mergeStreams always makes progress and advances each mark over a rowid prefix", () => {
    const item = (id: string, at: string) => ({ id, at }) as any;
    // Source e: first row is late (T5), the rest early (T0); source d: first row late (T9), then T0.5.
    const r = mergeStreams(
      {
        e: [{ rid: 1, item: item("evt:a", "5") }, { rid: 2, item: item("evt:b", "0") }, { rid: 3, item: item("evt:c", "0") }],
        d: [{ rid: 10, item: item("dec:a", "9") }, { rid: 11, item: item("dec:b", "0.5") }],
      },
      { e: 0, s: 0, o: 0, d: 0, c: 0 },
      2,
    );
    expect(r.items.map((i) => i.id)).toEqual(["evt:b", "evt:a"]); // returned sorted by (at, id)
    expect(r.marks).toEqual({ e: 2, s: 0, o: 0, d: 0, c: 0 });
  });

  it("encodes as opaque base64url", () => {
    const c = encodeCursor({ e: 1, s: 2, o: 3, d: 4, c: 5 });
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("activity: engine answers arrive with their outcome", () => {
  it("holds back an unanalysed ok answer while the run is active, then sends it analysed", async () => {
    const { db, ws, pid, p } = await setup();
    const { setId, prompts } = await seedPromptSet(db, ws, pid, 3);
    const run = await seedRun(db, ws, pid, "geo", "running");
    const o1 = await insertObs(db, ws, pid, run, { promptId: prompts[0]!, setId, provider: "gemini", at: ago(10) });
    await analyse(db, ws, pid, o1, { mentioned: 1, cited: 1 });
    const o2 = await insertObs(db, ws, pid, run, { promptId: prompts[1]!, setId, provider: "gemini", at: ago(5) });
    const o3 = await insertObs(db, ws, pid, run, { promptId: prompts[2]!, setId, provider: "gemini", at: ago(4), status: "failed" });

    const a = (await buildRunActivity(db, p, run, { now: FIXED_NOW }))!;
    const answers = (x: RunActivity) => x.items.filter((i) => i.kind === "engine_answer").map((i) => [i.id, i.outcome]);
    // o2 is pending analysis: it and later observations wait (o3 is behind it in insertion order).
    expect(answers(a)).toEqual([[`obs:${o1}`, "cited"]]);
    const again = (await buildRunActivity(db, p, run, { now: FIXED_NOW, after: decodeCursor(a.cursor) }))!;
    expect(answers(again)).toEqual([]);

    await analyse(db, ws, pid, o2, { mentioned: 0, cited: 0 });
    const b = (await buildRunActivity(db, p, run, { now: FIXED_NOW, after: decodeCursor(a.cursor) }))!;
    expect(answers(b)).toEqual([[`obs:${o2}`, "missing"], [`obs:${o3}`, "failed"]]);
    // Totals never waited.
    expect(b.totals.answers).toEqual({ cited: 1, named: 0, missing: 1, failed: 1 });
  });

  it("stops holding after OBS_HOLD_MS (analysis may have failed) and once the run has ended", async () => {
    const { db, ws, pid, p } = await setup();
    const { setId, prompts } = await seedPromptSet(db, ws, pid, 1);
    const run = await seedRun(db, ws, pid, "geo", "running");
    const o = await insertObs(db, ws, pid, run, { promptId: prompts[0]!, setId, provider: "gemini", at: ago(5) });
    let a = (await buildRunActivity(db, p, run, { now: FIXED_NOW }))!;
    expect(a.items.some((i) => i.id === `obs:${o}`)).toBe(false);
    a = (await buildRunActivity(db, p, run, { now: new Date(FIXED_NOW.getTime() + OBS_HOLD_MS) }))!;
    expect(a.items.find((i) => i.id === `obs:${o}`)?.outcome).toBeNull();
    await db.run("UPDATE agent_runs SET status = 'partial', finished_at = ? WHERE id = ?", FIXED_NOW.toISOString(), run);
    a = (await buildRunActivity(db, p, run, { now: FIXED_NOW }))!;
    expect(a.items.find((i) => i.id === `obs:${o}`)?.detail).toBe("Answer stored · awaiting analysis");
  });
});

describe("activity: GEO plan and lanes", () => {
  it("uses geo/batch.ts's default cap when the project has no limits row", async () => {
    const { db, ws, pid, p } = await setup();
    await db.run("DELETE FROM project_limits WHERE project_id = ?", pid);
    await seedPromptSet(db, ws, pid, 12);
    const run = await seedRun(db, ws, pid, "geo", "running");
    const a = (await buildRunActivity(db, p, run, { now: FIXED_NOW, configuredEngines: ["gemini"] }))!;
    expect(DEFAULT_PROMPTS_PER_RUN).toBeLessThanOrEqual(5);
    expect(a.lanes[0]!.planned).toBe(DEFAULT_PROMPTS_PER_RUN);
    expect(a.queued).toHaveLength(DEFAULT_PROMPTS_PER_RUN);
  });

  it("plans nothing when the per-run cap is 0, and counts caps above 200", async () => {
    const { db, ws, pid, p } = await setup();
    await seedPromptSet(db, ws, pid, 205);
    const run = await seedRun(db, ws, pid, "geo", "running");
    await db.run("UPDATE project_limits SET geo_prompts_per_run = 0 WHERE project_id = ?", pid);
    let a = (await buildRunActivity(db, p, run, { now: FIXED_NOW, configuredEngines: ["gemini"] }))!;
    expect(a.lanes[0]!.planned).toBe(0);
    expect(a.queued).toEqual([]);
    await db.run("UPDATE project_limits SET geo_prompts_per_run = 500 WHERE project_id = ?", pid);
    a = (await buildRunActivity(db, p, run, { now: FIXED_NOW, configuredEngines: ["gemini"] }))!;
    expect(a.lanes[0]!.planned).toBe(205);
  });

  it("shows a retried lane as asking again (state assigned in event order, not latched)", async () => {
    const { db, ws, pid, p } = await setup();
    await seedPromptSet(db, ws, pid, 3);
    const run = await seedRun(db, ws, pid, "geo", "running");
    let sec = 1;
    const ev = (step: string, status: string, message = `${step} ${status}`) =>
      db.insert("run_events", { id: newId("evt"), workspace_id: ws, project_id: pid, run_id: run, step, status, message, created_at: t(sec++) });
    await ev("geo.batch", "started");
    await ev("geo_batch:gemini", "started");
    await ev("geo_batch:gemini", "failed");
    await ev("geo.batch", "partial");
    const lane = async () => (await buildRunActivity(db, p, run, { now: FIXED_NOW, configuredEngines: ["gemini"] }))!;
    let a = await lane();
    expect(a.lanes[0]!.state).toBe("done");
    // Workflow retry of the step.
    await ev("geo.batch", "started");
    await ev("geo_batch:gemini", "started");
    a = await lane();
    expect(a.lanes[0]!.state).toBe("asking");
    expect(a.queued.length).toBe(3);
    // A per-observation analysis failure does not end the lane.
    await ev("geo_batch:gemini", "failed", "Analysis failed for observation obs_x: boom");
    a = await lane();
    expect(a.lanes[0]!.state).toBe("asking");
    await ev("geo_batch:gemini", "completed");
    a = await lane();
    expect(a.lanes[0]!.state).toBe("done");
  });
});

describe("activity: misc", () => {
  it("re-sends a retried crawl's rewritten page reads even when SQLite reuses their rowids", async () => {
    const { db, ws, pid, p } = await setup();
    const run = await seedRun(db, ws, pid, "seo", "running");
    const crawlId = newId("crawl");
    await db.insert("crawl_runs", { id: crawlId, workspace_id: ws, project_id: pid, run_id: run, status: "running", pages_limit: 10, started_at: t(1) });
    const pageIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const pageId = newId("pg");
      pageIds.push(pageId);
      await db.insert("pages", { id: pageId, workspace_id: ws, project_id: pid, url: `https://shop.example.com/r${i}`, page_type: "other", page_type_method: "url_pattern", first_seen_at: t(1) });
    }
    const write = async (sec: number) => {
      const ids: string[] = [];
      for (const pageId of pageIds) {
        const id = newId("snap");
        ids.push(`snap:${id}`);
        await db.insert("page_snapshots", { id, workspace_id: ws, project_id: pid, page_id: pageId, crawl_run_id: crawlId, status_code: 200, word_count: 100, fetched_at: t(sec) });
      }
      return ids;
    };
    const first = await write(10);
    const a = await drain(db, p, run, 50);
    expect(a.ids.filter((x) => x.startsWith("snap:")).sort()).toEqual([...first].sort());

    // Step retry: the crawl deletes its snapshots, restarts the attempt, and rewrites them (rowids reused).
    await db.run("DELETE FROM page_snapshots WHERE crawl_run_id = ?", crawlId);
    await db.run("UPDATE crawl_runs SET started_at = ? WHERE id = ?", t(100), crawlId);
    const second = await write(110);
    const b = await drain(db, p, run, 50, a.cursor);
    expect(b.ids.filter((x) => x.startsWith("snap:")).sort()).toEqual([...second].sort());
    // And the reset is not repeated once taken.
    const c = await drain(db, p, run, 50, b.cursor);
    expect(c.ids).toEqual([]);
  });

  it("does not mark an unknown cost as an estimate", async () => {
    const { db, ws, pid, p } = await setup();
    const run = await seedRun(db, ws, pid, "seo", "completed");
    await db.insert("provider_calls", {
      id: newId("call"), workspace_id: ws, project_id: pid, run_id: run, provider: "typesafe", model: "m", purpose: "seo.q", status: "ok", cost_usd: null, cost_is_estimate: 1, created_at: t(1),
    });
    await db.insert("provider_calls", {
      id: newId("call"), workspace_id: ws, project_id: pid, run_id: run, provider: "typesafe", model: "m", purpose: "seo.q", status: "ok", cost_usd: 0.01, cost_is_estimate: 1, created_at: t(2),
    });
    const a = (await buildRunActivity(db, p, run, { now: FIXED_NOW }))!;
    expect(a.items.map((i) => [i.costUsd, i.costIsEstimate])).toEqual([[null, false], [0.01, true]]);
  });

  it("current lists finished runs most recent first across agents", async () => {
    const { db, ws, pid } = await setup();
    const seo = await seedRun(db, ws, pid, "seo", "completed", { finished_at: t(10) });
    const geo = await seedRun(db, ws, pid, "geo", "completed", { finished_at: t(20) });
    expect((await currentActivityRuns(db, ws, pid)).map((r) => r.id)).toEqual([geo, seo]);
  });
});
