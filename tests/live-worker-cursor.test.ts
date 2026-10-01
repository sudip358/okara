import { describe, expect, it } from "vitest";
import { HttpError } from "@worker/lib/errors";
import { compareAtId, decodeLiveCursor, encodeLiveCursor, mergeMarked, parseLiveLimit } from "@worker/live/cursor";
import { buildLiveSeo, decodeLiveSeoCursor, encodeLiveSeoCursor } from "@worker/live/seo-board";
import { QUESTION } from "@worker/seo/questions";
import { FIXED_NOW } from "./helpers/fixtures";
import { choice, noul, seedCrawl, seedDecision, seedFinding, seedRec, seedRun, setup, t } from "./live-worker-seed";

type Ctx = Awaited<ReturnType<typeof setup>>;

async function page(ctx: Ctx, run: string, after: string | null, limit = 100) {
  const r = (await buildLiveSeo(ctx.db, ctx.p, run, { now: FIXED_NOW, limit, after: decodeLiveSeoCursor(after) }))!;
  const ids = [...r.elements, ...r.queries, ...r.recommendations].map((x) => x.id);
  return { r, ids };
}

/**
 * Pages forward the way the web client does (src/web/pages/live/data.ts): stop on a page shorter than the
 * limit or when the cursor did not move; fails when the cursor does not converge.
 */
async function drain(ctx: Ctx, run: string, limit: number, start: string | null = null) {
  const ids: string[] = [];
  let c = start;
  for (let i = 0; i < 200; i++) {
    const { r, ids: got } = await page(ctx, run, c, limit);
    expect(got.length).toBeLessThanOrEqual(limit);
    ids.push(...got);
    if (got.length < limit || r.cursor === c) return { ids, cursor: r.cursor };
    c = r.cursor;
  }
  throw new Error("cursor did not converge");
}

describe("live cursor encoding", () => {
  it("round-trips, is opaque base64url, and rejects garbage and other feeds' cursors", () => {
    const c = { d: 3, f: 0, r: 12, k: 1759230000000 };
    const enc = encodeLiveSeoCursor(c);
    expect(enc).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeLiveSeoCursor(enc)).toEqual(c);
    expect(decodeLiveSeoCursor(encodeLiveSeoCursor({ d: 1, f: 2, r: 3 }))).toEqual({ d: 1, f: 2, r: 3 });
    expect(decodeLiveSeoCursor(null)).toBeNull();
    expect(decodeLiveSeoCursor("")).toBeNull();
    const b64u = (v: unknown) => btoa(JSON.stringify(v)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    for (const bad of [
      "!!!",
      b64u({ d: 1, f: 0 }), // missing key
      b64u({ d: 1, f: 0, r: 0, x: 1 }), // unknown key
      b64u({ o: 1, r: 0 }), // the GEO feed's keys
      b64u({ e: 1, s: 0, o: 0, d: 0, c: 0 }), // the activity feed's keys
      b64u({ d: -1, f: 0, r: 0 }),
      b64u({ d: 1.5, f: 0, r: 0 }),
      b64u({ d: "1", f: 0, r: 0 }),
      b64u([1, 2, 3]),
      "A".repeat(500),
    ]) {
      expect(() => decodeLiveSeoCursor(bad), bad).toThrow(HttpError);
    }
    expect(decodeLiveCursor(encodeLiveCursor({ o: 1, r: 2 }), ["o", "r"] as const)).toEqual({ o: 1, r: 2 });
  });

  it("parses limits: default 100, capped at 200, positive integers only", () => {
    expect(parseLiveLimit(undefined)).toBe(100);
    expect(parseLiveLimit("5")).toBe(5);
    expect(parseLiveLimit("5000")).toBe(200);
    for (const bad of ["0", "-1", "1.5", "abc"]) expect(() => parseLiveLimit(bad), bad).toThrow(HttpError);
  });

  it("mergeMarked takes the smallest (at, id) head, advances marks over a rowid prefix, and skips hidden rows without counting them", () => {
    const e = (rid: number, at: string, id: string, shown = true) => ({ rid, at, id, payload: shown ? id : null });
    const m = mergeMarked<"d" | "f", string>(
      {
        d: [e(1, "5", "dec:a"), e(2, "0", "dec:b"), e(3, "0", "dec:c")],
        f: [e(10, "1", "find:a", false), e(11, "9", "find:b")],
      },
      { d: 0, f: 0 },
      2,
    );
    // Heads: d@5 vs f@1 (hidden, consumed) -> f@9 vs d@5 -> d:a, then d@0 -> d:b; limit reached.
    expect(m.taken.map((x) => x.entry.id)).toEqual(["dec:a", "dec:b"]);
    expect(m.marks).toEqual({ d: 2, f: 10 });
    expect(m.exhausted).toBe(false);
    expect([{ at: "1", id: "b" }, { at: "1", id: "a" }, { at: "0", id: "z" }].sort(compareAtId).map((x) => x.id)).toEqual(["z", "a", "b"]);
  });
});

describe("live SEO feed paging: per-source insertion high-water marks", () => {
  it("returns rows stamped earlier than an already-returned row (out-of-order timestamps)", async () => {
    const ctx = await setup();
    const run = await seedRun(ctx.db, ctx.ws, ctx.pid, "seo", "running", { finished_at: null });
    await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { questionId: QUESTION.titleMatchesQuery, answer: noul(0.9), at: t(100), id: "dec_first" });
    const a = await page(ctx, run, null);
    expect(a.ids).toEqual(["dec:dec_first"]);
    // A later batch arrives stamped with an earlier per-batch clock, plus a finding and a recommendation.
    await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { questionId: QUESTION.metaMatchesQuery, answer: noul(0.1), at: t(50), id: "dec_late1" });
    await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { questionId: QUESTION.metaMatchesQuery, answer: noul(0.1), at: t(51), id: "dec_late2" });
    const crawl = await seedCrawl(ctx.db, ctx.ws, ctx.pid, run, t(1));
    await seedFinding(ctx.db, ctx.ws, ctx.pid, crawl, { ruleId: "SEO-TITLE-MISSING", at: t(2), id: "fnd_early" });
    await seedRec(ctx.db, ctx.ws, ctx.pid, run, { dedupKey: "k", target: { kind: "site" }, at: t(3), id: "rec_early" });
    const b = await page(ctx, run, a.r.cursor);
    expect(b.ids.sort()).toEqual(["dec:dec_late1", "dec:dec_late2", "find:fnd_early", "rec:rec_early"]);
    expect(b.r.elements.map((x) => x.id)).toEqual(["find:fnd_early", "dec:dec_late1", "dec:dec_late2"]); // each list ascending by (at, id)
    // Nothing new: the cursor is echoed.
    const c = await page(ctx, run, b.r.cursor);
    expect(c.ids).toEqual([]);
    expect(c.r.cursor).toBe(b.r.cursor);
    // Totals always cover the whole run.
    expect(c.r.totals!.elements.judged).toBe(4);
  });

  it("returns a later row with the same timestamp and a lexically smaller id", async () => {
    const ctx = await setup();
    const run = await seedRun(ctx.db, ctx.ws, ctx.pid, "seo", "running", { finished_at: null });
    await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { questionId: QUESTION.titleMatchesQuery, answer: noul(0.9), at: t(10), id: "dec_zzzz" });
    const a = await page(ctx, run, null);
    await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { questionId: QUESTION.titleMatchesQuery, answer: noul(0.9), at: t(10), id: "dec_aaaa" });
    expect((await page(ctx, run, a.r.cursor)).ids).toEqual(["dec:dec_aaaa"]);
  });

  it("pages every row of every source exactly once with small limits and scrambled timestamps", async () => {
    const ctx = await setup();
    const run = await seedRun(ctx.db, ctx.ws, ctx.pid, "seo", "completed");
    const crawl = await seedCrawl(ctx.db, ctx.ws, ctx.pid, run, t(1));
    const want: string[] = [];
    const stamps = [50, 3, 40, 3, 99, 0, 7, 7, 20, 1, 64, 2];
    for (let i = 0; i < stamps.length; i++) {
      const s = (k: number) => t(stamps[(i + k) % stamps.length]!);
      want.push(`dec:${await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { questionId: QUESTION.titleMatchesQuery, answer: noul(0.9), at: s(0) })}`);
      want.push(`dec:${await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { candidateKey: `qrel:q${i}`, readable: null, questionId: QUESTION.queryRelevance, answer: noul(0.9), extra: { query: `q${i}` }, at: s(5) })}`);
      want.push(`find:${await seedFinding(ctx.db, ctx.ws, ctx.pid, crawl, { ruleId: "SEO-H1-MISSING", at: s(3) })}`);
      want.push(`rec:${await seedRec(ctx.db, ctx.ws, ctx.pid, run, { dedupKey: `k${i}`, target: { kind: "site" }, at: s(7) })}`);
      // Hidden rows interleaved (non-element question; in-candidate intent without stored query text).
      await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { questionId: QUESTION.issueSeverity, answer: choice("2", 0.9), at: s(1) });
      await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { questionId: QUESTION.queryIntent, answer: choice("transactional", 0.9), at: s(2) });
      await seedFinding(ctx.db, ctx.ws, ctx.pid, crawl, { ruleId: "AI-SEARCH-CRAWLER-BLOCKED", at: s(4) });
      // Read by the SQL but hidden in code (whitespace-only query text): must not shorten a page early.
      await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { questionId: QUESTION.queryRelevance, readable: null, answer: noul(0.9), extra: { query: "\t" }, at: s(6) });
    }
    for (const limit of [1, 2, 3, 7, 200]) {
      const { ids, cursor } = await drain(ctx, run, limit);
      expect(new Set(ids).size, `limit ${limit}: no duplicates`).toBe(ids.length);
      expect([...ids].sort(), `limit ${limit}: nothing missed`).toEqual([...want].sort());
      expect(cursor).not.toBeNull();
    }
  });

  it("never reads intent answers without stored query text, and reads past hidden rows in the same request", async () => {
    const ctx = await setup();
    const run = await seedRun(ctx.db, ctx.ws, ctx.pid, "seo", "completed");
    // In-candidate intent answers have no stored query text: excluded by the SQL, so they never fill a page.
    for (let i = 0; i < 250; i++) {
      await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { questionId: QUESTION.queryIntent, answer: choice("transactional", 0.9), at: t(i) });
    }
    const first = await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { questionId: QUESTION.titleMatchesQuery, answer: noul(0.9), at: t(300) });
    const a = await page(ctx, run, null, 20);
    expect(a.ids).toEqual([`dec:${first}`]);
    // They still count in the totals (Jev classified those queries' intent).
    expect(a.r.totals!.queries.intent).toEqual({ transactional: 250 });

    // Rows that pass the SQL but are hidden in code (whitespace-only query text) advance the mark; a read of
    // hidden rows only is followed by the next read in the same request.
    for (let i = 0; i < 250; i++) {
      await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { questionId: QUESTION.queryRelevance, readable: null, answer: noul(0.9), extra: { query: "\t" }, at: t(400 + i) });
    }
    const second = await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { questionId: QUESTION.titleMatchesQuery, answer: noul(0.9), at: t(700) });
    const b = await page(ctx, run, a.r.cursor, 100); // reads 100 + 100 + 51 rows
    expect(b.ids).toEqual([`dec:${second}`]);
    // Reads continue until the page is full or every source is drained: a page shorter than the limit means
    // nothing more is stored right now.
    const third = await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { questionId: QUESTION.titleMatchesQuery, answer: noul(0.9), at: t(900) });
    for (let i = 0; i < 60; i++) {
      await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { questionId: QUESTION.queryRelevance, readable: null, answer: noul(0.9), extra: { query: "\t" }, at: t(901 + i) });
    }
    const fourth = await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { questionId: QUESTION.titleMatchesQuery, answer: noul(0.9), at: t(1000) });
    const c = await page(ctx, run, b.r.cursor, 20);
    expect(c.ids).toEqual([`dec:${third}`, `dec:${fourth}`]);
    // At most 5 reads per request: a run of more hidden rows than that yields an empty page whose cursor moves on.
    for (let i = 0; i < 150; i++) {
      await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { questionId: QUESTION.queryRelevance, readable: null, answer: noul(0.9), extra: { query: "\t" }, at: t(1100 + i) });
    }
    const fifth = await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { questionId: QUESTION.titleMatchesQuery, answer: noul(0.9), at: t(1300) });
    const d = await page(ctx, run, c.r.cursor, 20);
    expect(d.ids).toEqual([]);
    expect(d.r.cursor).not.toBe(c.r.cursor);
    const e = await page(ctx, run, d.r.cursor, 20);
    expect(e.ids).toEqual([`dec:${fifth}`]);
    expect((await page(ctx, run, e.r.cursor, 20)).r.cursor).toBe(e.r.cursor);
  });

  it("restarts the finding mark when a retried crawl rewrote its findings (rowids reused)", async () => {
    const ctx = await setup();
    const run = await seedRun(ctx.db, ctx.ws, ctx.pid, "seo", "running", { finished_at: null });
    const crawl = await seedCrawl(ctx.db, ctx.ws, ctx.pid, run, t(1), "running");
    await seedFinding(ctx.db, ctx.ws, ctx.pid, crawl, { ruleId: "SEO-TITLE-MISSING", id: "fnd_a1" });
    await seedFinding(ctx.db, ctx.ws, ctx.pid, crawl, { ruleId: "SEO-TITLE-MISSING", id: "fnd_a2" });
    const a = await page(ctx, run, null);
    expect(a.ids.sort()).toEqual(["find:fnd_a1", "find:fnd_a2"]);
    // The crawl step is retried: its findings are deleted and rewritten (SQLite reuses the freed rowids).
    await ctx.db.run("DELETE FROM audit_findings WHERE crawl_run_id = ?", crawl);
    await ctx.db.run("UPDATE crawl_runs SET started_at = ? WHERE id = ?", t(200), crawl);
    await seedFinding(ctx.db, ctx.ws, ctx.pid, crawl, { ruleId: "SEO-H1-MISSING", id: "fnd_b1", at: t(201) });
    const reused = await ctx.db.first<{ rid: number }>("SELECT rowid AS rid FROM audit_findings WHERE id = 'fnd_b1'");
    expect(reused!.rid).toBeLessThanOrEqual(decodeLiveSeoCursor(a.r.cursor)!.f); // would be missed by a plain mark
    const b = await page(ctx, run, a.r.cursor);
    expect(b.ids).toEqual(["find:fnd_b1"]);
    const c = await page(ctx, run, b.r.cursor);
    expect(c.ids).toEqual([]);
    expect(c.r.cursor).toBe(b.r.cursor);
  });

  it("returns a null cursor for an empty run without `after`, and echoes the given cursor", async () => {
    const ctx = await setup();
    const run = await seedRun(ctx.db, ctx.ws, ctx.pid, "seo", "pending", { started_at: null, finished_at: null });
    const a = await page(ctx, run, null);
    expect(a.r.cursor).toBeNull();
    expect(a.r.active).toBe(true);
    expect(a.r.run).toMatchObject({ id: run, agent: "seo", status: "pending", startedAt: null, elapsedMs: null });
    const given = encodeLiveSeoCursor({ d: 0, f: 0, r: 0 });
    expect((await page(ctx, run, given)).r.cursor).toBe(given);
    // Rows of another run of the same project never appear.
    const other = await seedRun(ctx.db, ctx.ws, ctx.pid, "seo", "completed");
    await seedDecision(ctx.db, ctx.ws, ctx.pid, other, { questionId: QUESTION.titleMatchesQuery, answer: noul(0.9) });
    await seedRec(ctx.db, ctx.ws, ctx.pid, other, { dedupKey: "x", target: { kind: "site" } });
    expect((await page(ctx, run, null)).ids).toEqual([]);
    expect((await page(ctx, run, null)).r.totals!.elements.judged).toBe(0);
  });
});
