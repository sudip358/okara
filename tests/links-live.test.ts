/**
 * [A41] Internal links Live panel, worker side: progress events emitted by the real analysis run and graph rebuild
 * (order and counts that match the stored results), run status lifecycle (running -> completed / partial / failed,
 * interrupted on read), cursor paging of GET .../internal-links/live, tenancy, bounded detail, per-run event cap and
 * retention, and a progress write failure never failing the run.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { LinkLiveEvent, LinkLiveResponse } from "@shared/link-live";
import { createApp } from "@worker/app";
import { Db } from "@worker/lib/db";
import { BudgetExceededError } from "@worker/lib/errors";
import { buildAndStoreLinkGraph } from "@worker/links/graph-store";
import { LIVE_RUNS_KEPT, LinkProgress, MAX_DETAIL_CHARS, MAX_EVENTS_PER_RUN, MAX_ITEMS_PER_EVENT, boundDetail, linkLive, pairItem } from "@worker/links/progress";
import { runLinkSuggestions } from "@worker/links/run";
import type { WritingProvider } from "@worker/providers/types";
import { setLinkDecisionsFactory, setLinkWriterFactory } from "@worker/routes/links";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, authHeaders, seedProject, seedUser } from "./helpers/fixtures";
import { STORE, confidentYes, fakeDecisions, noul, projectRow, seedLinkCrawl, type AnswerFn } from "./links-seed";

afterEach(() => {
  setLinkDecisionsFactory(null);
  setLinkWriterFactory(null);
});

async function setup() {
  const env = createTestEnv();
  const user = await seedUser(env);
  const projectId = await seedProject(env, user.workspaceId);
  const db = new Db(env.DB);
  await seedLinkCrawl(db, user.workspaceId, projectId, STORE);
  return { env, db, user, projectId, workspaceId: user.workspaceId };
}

/** A clock that advances 250 ms per call, so stored event times are ordered and distinct. */
function steppingClock(start = FIXED_NOW.getTime()) {
  let t = start;
  return () => new Date((t += 250));
}

const GOOD = "After polishing brass, browse our Cabinet Pulls to match the original shine of the metal.";
function fakeWriter(opts: { budgetOnCall?: number } = {}) {
  let calls = 0;
  const writer: WritingProvider = {
    name: "fake-writer",
    model: "writer-test-2026-10",
    async write(req) {
      calls++;
      if (opts.budgetOnCall !== undefined && calls >= opts.budgetOnCall) throw new BudgetExceededError("writer_tokens", "Project daily limit reached for writer_tokens.");
      const items = (req.input as { items: Array<{ pair_id: string; anchor: string }> }).items;
      const drafts = items.map((it, i) => ({ pair_id: it.pair_id, sentence: i === 0 ? GOOD : "Buy our Cabinet Pulls now for $25 today only.", evidence_ids: ["ev_s2", "ev_th"], insert_after: "ev_s2" }));
      return { provider: "fake-writer", model: "writer-test-2026-10", output: { drafts }, usage: { inputTokens: 10, outputTokens: 10 } };
    },
    async test() {
      return { ok: true, detail: "fake" };
    },
  };
  return writer;
}

async function allEvents(db: Db, workspaceId: string, projectId: string): Promise<{ res: LinkLiveResponse; events: LinkLiveEvent[] }> {
  const res = await linkLive(db, { id: projectId, workspace_id: workspaceId }, { after: 0, runId: null, limit: 200 }, FIXED_NOW);
  return { res, events: res.events };
}

const stagesOf = (events: LinkLiveEvent[]) => events.map((e) => `${e.stage}:${e.status}`);

describe("link live: analysis run events", () => {
  it("emits every real stage in order, with counts that match the stored run and suggestions", async () => {
    const { env, db, projectId, workspaceId } = await setup();
    // Jev keeps every pair except those pointing at the patina article (dropped).
    const answer: AnswerFn = (qid, req) => {
      const key = qid.split(".")[0]!;
      const state = (req.state as Record<string, { target: { url: string } }>)[key]!;
      if (qid.endsWith(".should_exist") && state.target.url.endsWith("/brass-patina")) return noul(0.05);
      return confidentYes(qid, req, 1);
    };
    const fake = fakeDecisions(answer);
    const r = await runLinkSuggestions(env, db, await projectRow(db, projectId), FIXED_NOW, { decisions: fake.provider, writer: fakeWriter(), batchSize: 2, progressClock: steppingClock() });
    const { res, events } = await allEvents(db, workspaceId, projectId);

    expect(res.run).toMatchObject({ kind: "analysis", status: "completed", isDemo: false });
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    const seq = stagesOf(events);
    const batches = fake.requests.length;
    expect(batches).toBeGreaterThan(1);
    expect(seq).toEqual([
      "run:started",
      "graph.load:started",
      "graph.load:completed",
      "graph.edges:completed",
      "graph.clusters:completed",
      "graph.anchors:completed",
      "graph.verify:skipped",
      "graph.save:started",
      "graph.save:completed",
      "pages:completed",
      "candidates:completed",
      "sentences:completed",
      "jev:started",
      ...Array.from({ length: batches }, () => "jev:progress"),
      "jev:completed",
      "drafts:started",
      "drafts:progress",
      "drafts:completed",
      "save:started",
      "save:completed",
      "run:completed",
    ]);
    // Times come from the progress clock, ascending.
    const times = events.map((e) => e.at);
    expect([...times].sort()).toEqual(times);

    const run = await db.first<{ summary_json: string }>("SELECT summary_json FROM link_runs WHERE project_id = ?", projectId);
    const summary = JSON.parse(run!.summary_json) as { pairsConsidered: number; pairsKept: number; clusterGapPairs: number; jev: { calls: number; asked: number; answered: number } };
    const by = (stage: string, status: string) => events.find((e) => e.stage === stage && e.status === status)!;
    expect(by("candidates", "completed").detail.n).toMatchObject({ considered: summary.pairsConsidered, clusterGapPairs: summary.clusterGapPairs });
    expect(by("sentences", "completed").detail.n).toMatchObject({ matched: summary.pairsKept });
    expect(by("jev", "started").detail.n).toMatchObject({ pairs: summary.pairsKept, batches, batchSize: 2 });

    const existing = r.suggestions.filter((s) => s.placement !== "draft_sentence");
    const kept = existing.filter((s) => s.status === "suggested").length;
    const dropped = existing.filter((s) => s.status === "rejected").length;
    expect(kept).toBeGreaterThan(0);
    expect(dropped).toBeGreaterThan(0);
    expect(by("jev", "completed").detail.n).toMatchObject({ calls: summary.jev.calls, judged: summary.jev.asked, answered: summary.jev.answered, kept, dropped, review: 0 });
    // One progress event per batch: batch k of K with the batch's pairs and their verdicts.
    const progress = events.filter((e) => e.stage === "jev" && e.status === "progress");
    progress.forEach((e, i) => expect(e.detail.n).toMatchObject({ batch: i + 1, batches }));
    const items = progress.flatMap((e) => e.detail.items ?? []);
    expect(items).toHaveLength(summary.pairsKept);
    expect(items.filter((i) => i.v === "dropped").every((i) => i.t === "/blogs/news/brass-patina")).toBe(true);
    expect(items.filter((i) => i.v === "kept")).toHaveLength(kept);
    for (const i of items) expect(i.s.startsWith("/") && i.t.startsWith("/") && typeof i.a === "string").toBe(true);
    // Candidate samples carry the computed priority, highest first.
    const cand = by("candidates", "completed").detail.items!;
    expect(cand.length).toBe(Math.min(20, summary.pairsConsidered));
    expect(cand.every((c) => c.v === "candidate" && typeof c.p === "number")).toBe(true);
    expect(cand.map((c) => c.p)).toEqual([...cand.map((c) => c.p!)].sort((a, b) => b - a));

    // Drafts: one valid, one rejected by validation (the writer's second sentence has a price).
    const drafts = r.suggestions.filter((s) => s.placement === "draft_sentence");
    expect(by("drafts", "completed").detail.n).toMatchObject({ calls: 1, drafted: drafts.filter((d) => d.status === "review").length, rejected: drafts.filter((d) => d.status === "rejected").length });
    expect(by("drafts", "progress").detail.items!.map((i) => i.v).sort()).toEqual(["draft_rejected", "drafted"]);

    // Saved = the rows stored for this run; totals stored with the run match the events.
    expect(by("save", "completed").detail.n).toMatchObject({ rows: r.suggestions.length, drafts: drafts.length });
    expect(res.run!.totals).toMatchObject({ pairsConsidered: summary.pairsConsidered, pairsMatched: summary.pairsKept, judged: summary.jev.asked, jevKept: kept, jevDropped: dropped, saved: r.suggestions.length, drafted: 1, draftRejected: 1, jevCalls: summary.jev.calls });
    expect(res.run!.totals.urls).toBe(by("graph.edges", "completed").detail.n!.urls);
    expect(res.run!.finishedAt).not.toBeNull();
  });

  it("marks Jev and drafts skipped with a reason when they are not called, and the run partial when a budget runs out", async () => {
    const a = await setup();
    await runLinkSuggestions(a.env, a.db, await projectRow(a.db, a.projectId), FIXED_NOW, { decisions: null, writer: null });
    const e1 = (await allEvents(a.db, a.workspaceId, a.projectId)).events;
    expect(e1.find((e) => e.stage === "jev")).toMatchObject({ status: "skipped", detail: { note: expect.stringMatching(/not configured/) } });
    expect(e1.find((e) => e.stage === "drafts")).toMatchObject({ status: "skipped", detail: { note: expect.stringMatching(/No writer is set up/) } });
    expect(e1[e1.length - 1]).toMatchObject({ stage: "run", status: "completed" });

    const b = await setup();
    await runLinkSuggestions(b.env, b.db, await projectRow(b.db, b.projectId), FIXED_NOW, { decisions: fakeDecisions(confidentYes, { budgetOnCall: 2 }).provider, writer: null, batchSize: 2 });
    const { res, events } = await allEvents(b.db, b.workspaceId, b.projectId);
    expect(res.run!.status).toBe("partial");
    const jevEnd = events.find((e) => e.stage === "jev" && e.status === "partial")!;
    expect(jevEnd.detail.note).toMatch(/daily Jev budget is used up/);
    const notSent = events.filter((e) => e.stage === "jev" && e.status === "progress").flatMap((e) => e.detail.items ?? []).filter((i) => i.v === "not_sent");
    expect(notSent.length).toBe(jevEnd.detail.n!.notSent);
    expect(notSent.length).toBeGreaterThan(0);
    expect(events[events.length - 1]).toMatchObject({ stage: "run", status: "partial" });
  });

  it("is 'running' while the work is in flight (the page polls during the request), then completed", async () => {
    const { env, db, projectId, workspaceId } = await setup();
    const seen: Array<{ status: string | undefined; stages: string[] }> = [];
    const fake = fakeDecisions(confidentYes);
    const decide = fake.provider.decide.bind(fake.provider);
    fake.provider.decide = async (req) => {
      const live = await linkLive(db, { id: projectId, workspace_id: workspaceId }, { after: 0, runId: null, limit: 200 }, FIXED_NOW);
      seen.push({ status: live.run?.status, stages: stagesOf(live.events) });
      return decide(req);
    };
    await runLinkSuggestions(env, db, await projectRow(db, projectId), FIXED_NOW, { decisions: fake.provider, writer: null, batchSize: 3 });
    expect(seen.length).toBeGreaterThan(1);
    // Before the first Jev call, the stored log already shows the graph, candidates and "jev:started".
    expect(seen[0]!.status).toBe("running");
    expect(seen[0]!.stages.slice(-1)).toEqual(["jev:started"]);
    expect(seen[0]!.stages).toContain("candidates:completed");
    // Before the second call, batch 1's progress event is stored (it rode with the batch's decision records).
    expect(seen[1]!.stages.filter((s) => s === "jev:progress")).toHaveLength(1);
    const end = await allEvents(db, workspaceId, projectId);
    expect(end.res.run!.status).toBe("completed");
  });

  it("records a failed run with the error note when the run throws", async () => {
    const { env, db, projectId, workspaceId } = await setup();
    let armed = false;
    const clock = () => {
      if (armed) throw new Error("clock exploded");
      return FIXED_NOW;
    };
    const writer = fakeWriter();
    const write = writer.write.bind(writer);
    writer.write = async (req) => {
      armed = true; // the next clock() call (building the suggestion rows) throws
      return write(req);
    };
    await expect(runLinkSuggestions(env, db, await projectRow(db, projectId), FIXED_NOW, { decisions: null, writer, clock })).rejects.toThrow(/clock exploded/);
    const { res, events } = await allEvents(db, workspaceId, projectId);
    expect(res.run!.status).toBe("failed");
    expect(events[events.length - 1]).toMatchObject({ stage: "run", status: "failed", detail: { note: "Run failed: clock exploded" } });
  });

  it("never fails the run when progress cannot be stored", async () => {
    const { env, db, projectId, workspaceId } = await setup();
    await db.run("DROP TABLE link_live_events");
    const r = await runLinkSuggestions(env, db, await projectRow(db, projectId), FIXED_NOW, { decisions: fakeDecisions(confidentYes).provider, writer: null });
    expect(r.state).toBe("ready");
    expect(r.suggestions.length).toBeGreaterThan(0);
    // The run row was not created (its first batch failed), so the live endpoint reports nothing rather than a broken run.
    const live = await linkLive(db, { id: projectId, workspace_id: workspaceId }, { after: 0, runId: null, limit: 200 }, FIXED_NOW);
    expect(live.run).toBeNull();
  });
});

describe("link live: graph rebuild events", () => {
  it("tracks a manual rebuild as its own run: load, edges, clusters, anchors, verify, save", async () => {
    const { db, projectId, workspaceId } = await setup();
    const project = await projectRow(db, projectId);
    const built = await buildAndStoreLinkGraph(db, project, { trigger: "manual", now: FIXED_NOW, progress: "own" });
    const { res, events } = await allEvents(db, workspaceId, projectId);
    expect(res.run).toMatchObject({ kind: "graph", status: "completed" });
    expect(stagesOf(events)).toEqual([
      "run:started",
      "graph.load:started",
      "graph.load:completed",
      "graph.edges:completed",
      "graph.clusters:completed",
      "graph.anchors:completed",
      "graph.verify:skipped",
      "graph.save:started",
      "graph.save:completed",
      "run:completed",
    ]);
    const edges = events.find((e) => e.stage === "graph.edges")!;
    expect(edges.detail.n).toMatchObject({ urls: built!.graph.nodes.length, edges: built!.graph.edges, contentEdges: built!.graph.contentEdges });
    expect(events.find((e) => e.stage === "graph.load" && e.status === "completed")!.detail.n).toMatchObject({ pages: built!.snapshots.length });
    expect(events.find((e) => e.stage === "graph.clusters")!.detail.n).toMatchObject({ hubs: built!.clusters.hubs.size, spokes: built!.clusters.spokes.size });
    expect(res.run!.totals).toMatchObject({ urls: built!.graph.nodes.length, edges: built!.graph.edges, pages: built!.snapshots.length });
    // Crawl-triggered builds are not tracked.
    await buildAndStoreLinkGraph(db, project, { trigger: "crawl", now: FIXED_NOW });
    expect((await allEvents(db, workspaceId, projectId)).res.run!.id).toBe(res.run!.id);
  });

  it("verification items carry the placed link's source and target paths and verdicts", async () => {
    const { db, projectId, workspaceId } = await setup();
    const project = await projectRow(db, projectId);
    const r = await runLinkSuggestions(createTestEnv(), db, project, FIXED_NOW, { decisions: null, writer: null });
    const s = r.suggestions[0]!;
    await db.run("UPDATE link_suggestions SET user_status = 'implemented', status_changed_at = ? WHERE id = ?", "2026-01-01T00:00:00.000Z", s.id);
    await buildAndStoreLinkGraph(db, project, { trigger: "manual", now: FIXED_NOW, progress: "own" });
    const v = (await allEvents(db, workspaceId, projectId)).events.find((e) => e.stage === "graph.verify")!;
    expect(v.status).toBe("completed");
    expect(v.detail.n).toMatchObject({ checked: 1, notFound: 1, verified: 0 });
    expect(v.detail.items).toEqual([{ s: new URL(s.source.url).pathname, t: new URL(s.target.url).pathname, v: "not_found" }]);
  });
});

describe("link live: route, paging and tenancy", () => {
  it("pages events by seq with run + after, restarts for a newer run, and validates parameters", async () => {
    const { env, user, projectId } = await setup();
    const app = createApp();
    const H = authHeaders(user.sessionToken, user.csrfToken);
    const base = `/api/projects/${projectId}/seo/internal-links`;
    const get = async (q: string) => {
      const res = await app.request(`${base}/live${q}`, { headers: H }, env);
      return { status: res.status, body: (await res.json()) as { data: LinkLiveResponse } };
    };
    const empty = await get("");
    expect(empty.status).toBe(200);
    expect(empty.body.data).toMatchObject({ run: null, events: [], nextCursor: 0, hasMore: false, pollMs: 1500 });

    expect((await app.request(`${base}/graph/rebuild`, { method: "POST", headers: H }, env)).status).toBe(200);
    const first = (await get("?limit=4")).body.data;
    expect(first.run!.kind).toBe("graph");
    expect(first.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(first).toMatchObject({ nextCursor: 4, hasMore: true });
    const collected = [...first.events];
    let cursor = first.nextCursor;
    for (let i = 0; i < 10; i++) {
      const page = (await get(`?run=${first.run!.id}&after=${cursor}&limit=4`)).body.data;
      collected.push(...page.events);
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    }
    expect(collected.map((e) => e.seq)).toEqual(Array.from({ length: first.run!.eventsStored }, (_, i) => i + 1));
    // Nothing new after the last event.
    expect((await get(`?run=${first.run!.id}&after=${cursor}`)).body.data).toMatchObject({ events: [], nextCursor: cursor, hasMore: false });
    // A cursor for another run id restarts at the latest run's first event.
    expect((await get(`?run=llive_other&after=${cursor}`)).body.data.events[0]!.seq).toBe(1);

    for (const bad of ["?after=-1", "?after=abc", "?limit=0x", "?limit=201", "?run=" + encodeURIComponent("<script>")]) {
      expect((await get(bad)).status, bad).toBe(400);
    }
  });

  it("returns 404 to non-members and 401 without a session", async () => {
    const { env, projectId } = await setup();
    const app = createApp();
    const intruder = await seedUser(env);
    const base = `/api/projects/${projectId}/seo/internal-links/live`;
    expect((await app.request(base, { headers: authHeaders(intruder.sessionToken, intruder.csrfToken) }, env)).status).toBe(404);
    expect((await app.request(base, {}, env)).status).toBe(401);
  });

  it("never returns another project's run, even in the same workspace", async () => {
    const { env, db, projectId, workspaceId } = await setup();
    const p2 = await seedProject(env, workspaceId);
    await LinkProgress.start(db, { id: p2, workspace_id: workspaceId, is_demo: 0 }, { kind: "graph", refId: null });
    expect((await linkLive(db, { id: projectId, workspace_id: workspaceId }, { after: 0, runId: null, limit: 200 }, FIXED_NOW)).run).toBeNull();
    expect((await linkLive(db, { id: p2, workspace_id: "ws_someone_else" }, { after: 0, runId: null, limit: 200 }, FIXED_NOW)).run).toBeNull();
    expect((await linkLive(db, { id: p2, workspace_id: workspaceId }, { after: 0, runId: null, limit: 200 }, FIXED_NOW)).run).not.toBeNull();
  });
});

describe("link live: bounds, retention and lifecycle", () => {
  it("bounds detail: at most 20 items, clipped strings, at most MAX_DETAIL_CHARS", () => {
    const long = "/" + "x".repeat(500);
    const items = Array.from({ length: 50 }, (_, i) => pairItem(`https://a.example${long}${i}`, `https://a.example${long}`, "kept", "anchor ".repeat(60)));
    expect(items[0]!.s.length).toBeLessThanOrEqual(160);
    expect(items[0]!.a!.length).toBeLessThanOrEqual(120);
    const json = boundDetail({ n: { a: 1 }, items, note: "n".repeat(1000) });
    expect(json.length).toBeLessThanOrEqual(MAX_DETAIL_CHARS);
    const parsed = JSON.parse(json) as { items: unknown[]; note: string };
    expect(parsed.items.length).toBeLessThanOrEqual(MAX_ITEMS_PER_EVENT);
    expect(parsed.note.length).toBeLessThanOrEqual(300);
    // Untrusted text is stored as data (plain strings), never interpreted.
    const hostile = pairItem("https://a.example/<img src=x onerror=alert(1)>", "https://a.example/t", "kept", "<script>alert(1)</script>");
    expect(hostile.a).toBe("<script>alert(1)</script>");
  });

  it("caps events per run (the final run event is always stored) and counts the dropped ones", async () => {
    const { db, projectId, workspaceId } = await setup();
    const rec = await LinkProgress.start(db, { id: projectId, workspace_id: workspaceId, is_demo: 0 }, { kind: "analysis", refId: null });
    for (let i = 0; i < MAX_EVENTS_PER_RUN + 50; i++) {
      rec.emit("jev", "progress", { n: { batch: i } });
      if (i % 100 === 0) await rec.flush();
    }
    await rec.finish("completed");
    const run = await db.first<{ events_stored: number; events_dropped: number; status: string }>("SELECT events_stored, events_dropped, status FROM link_live_runs WHERE id = ?", rec.id);
    expect(run).toMatchObject({ events_stored: MAX_EVENTS_PER_RUN + 1, events_dropped: 51, status: "completed" });
    const last = await db.first<{ stage: string; status: string }>("SELECT stage, status FROM link_live_events WHERE live_run_id = ? ORDER BY seq DESC LIMIT 1", rec.id);
    expect(last).toEqual({ stage: "run", status: "completed" });
  });

  it("keeps the latest LIVE_RUNS_KEPT runs per project with their events", async () => {
    const { db, projectId, workspaceId } = await setup();
    let t = FIXED_NOW.getTime();
    const ids: string[] = [];
    for (let i = 0; i < LIVE_RUNS_KEPT + 2; i++) {
      const rec = await LinkProgress.start(db, { id: projectId, workspace_id: workspaceId, is_demo: 0 }, { kind: "graph", refId: null, clock: () => new Date((t += 1000)) });
      await rec.finish("completed");
      ids.push(rec.id!);
    }
    const runs = await db.all<{ id: string }>("SELECT id FROM link_live_runs WHERE project_id = ? ORDER BY started_at", projectId);
    expect(runs.map((r) => r.id)).toEqual(ids.slice(-LIVE_RUNS_KEPT));
    const orphanEvents = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM link_live_events WHERE project_id = ? AND live_run_id NOT IN (${runs.map(() => "?").join(",")})`, projectId, ...runs.map((r) => r.id));
    expect(orphanEvents!.n).toBe(0);
  });

  it("reports a running run with no stored update for 10 minutes as interrupted", async () => {
    const { db, projectId, workspaceId } = await setup();
    const rec = await LinkProgress.start(db, { id: projectId, workspace_id: workspaceId, is_demo: 0 }, { kind: "analysis", refId: null, clock: () => FIXED_NOW });
    const scope = { id: projectId, workspace_id: workspaceId };
    expect((await linkLive(db, scope, { after: 0, runId: null, limit: 200 }, new Date(FIXED_NOW.getTime() + 9 * 60_000))).run!.status).toBe("running");
    expect((await linkLive(db, scope, { after: 0, runId: null, limit: 200 }, new Date(FIXED_NOW.getTime() + 11 * 60_000))).run!.status).toBe("interrupted");
    void rec;
  });
});
