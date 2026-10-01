import { describe, expect, it } from "vitest";
import type { LiveSeoBoardResponse } from "@shared/types";
import { insertStatement } from "@worker/lib/db";
import { newId } from "@worker/lib/ids";
import { buildLiveSeo, decodeLiveSeoCursor } from "@worker/live/seo-board";
import { QUESTION } from "@worker/seo/questions";
import { D1_MAX_BOUND_PARAMS } from "./helpers/d1";
import { FIXED_NOW } from "./helpers/fixtures";
import { caller, ORIGIN, seedCrawl, seedRun, setup, t } from "./live-worker-seed";

const N = 300;

describe("live SEO feed: D1 limits", () => {
  it(`pages ${N} element decisions (+ actions, links, findings, queries, recommendations) under ${D1_MAX_BOUND_PARAMS} bound parameters per statement`, async () => {
    const ctx = await setup();
    const { db, ws, pid } = ctx;
    const run = await seedRun(db, ws, pid, "seo", "completed");
    const crawl = await seedCrawl(db, ws, pid, run, t(1));
    const S: Array<[string, ...unknown[]]> = [];
    const ins = (table: string, row: Record<string, unknown>) => S.push(insertStatement(table, row));
    const syncId = newId("gsc");
    ins("gsc_syncs", {
      id: syncId, workspace_id: ws, project_id: pid, run_id: run, source: "api", window_start: "2026-09-01", window_end: "2026-09-28",
      prev_window_start: "2026-08-04", prev_window_end: "2026-08-31", rows_fetched: N * 3, row_cap: 25000, totals_json: "{}", status: "completed", synced_at: t(2),
    });
    const linkRun = newId("lr");
    ins("link_runs", { id: linkRun, workspace_id: ws, project_id: pid, crawl_run_id: crawl, status: "completed", method_version: "m", created_at: t(1) });
    for (let i = 0; i < N; i++) {
      const url = `${ORIGIN}/products/p${i}`;
      const pageId = newId("pg");
      ins("pages", { id: pageId, workspace_id: ws, project_id: pid, url, page_type: "product", page_type_method: "url_pattern", first_seen_at: t(0) });
      ins("page_snapshots", {
        id: newId("snap"), workspace_id: ws, project_id: pid, page_id: pageId, crawl_run_id: crawl, status_code: 200, title: `Product ${i}`, fetched_at: t(2),
      });
      const key = `seo:weak_ctr:${i}`;
      const readable = `weak_ctr:${url}`;
      const at = t(10 + (i % 37)); // scrambled stamps
      ins("decision_records", {
        id: newId("dec"), workspace_id: ws, project_id: pid, run_id: run, agent: "seo", candidate_key: key, question_id: QUESTION.titleMatchesQuery,
        provider: "typesafe", model: "m", answer_json: JSON.stringify({ answer: { type: "noul", noul: i % 2 ? 0.1 : 0.9 }, candidate: readable, questionTier: "act" }),
        tier: "act", outcome: "selected", created_at: at,
      });
      ins("decision_records", {
        id: newId("dec"), workspace_id: ws, project_id: pid, run_id: run, agent: "seo", candidate_key: key, question_id: QUESTION.actionChoice,
        provider: "typesafe", model: "m", answer_json: JSON.stringify({ answer: { type: "choice", choice: "rewrite_title_meta", confidence: 0.9 }, candidate: readable, questionTier: "act" }),
        tier: "act", outcome: "selected", created_at: at,
      });
      ins("recommendations", {
        id: newId("rec"), workspace_id: ws, project_id: pid, run_id: run, agent: "seo", scope: "page", target_json: JSON.stringify({ kind: "url", url }),
        issue_type: "weak_ctr", trigger: "t", issue: "i", action: "a", suggested_snippet: `New title ${i}`, rationale: "r", effort: "low", uncertainty: "low",
        limitations: "l", verified: 1, priority: 0.5, priority_version: "v", evidence_ids_json: "[]", dedup_key: key, status: "open", created_at: t(40 + (i % 11)), updated_at: t(40),
      });
      ins("gsc_metrics", { workspace_id: ws, project_id: pid, sync_id: syncId, window: "current", query: null, page: url, clicks: i, impressions: 100 + i, ctr: 0.01, position: 5 });
      ins("gsc_metrics", { workspace_id: ws, project_id: pid, sync_id: syncId, window: "current", query: `query ${i}`, page: null, clicks: 1, impressions: 10, ctr: 0.1, position: 3 });
      ins("decision_records", {
        id: newId("dec"), workspace_id: ws, project_id: pid, run_id: run, agent: "seo", candidate_key: `qrel:query ${i}`, question_id: QUESTION.queryRelevance,
        provider: "typesafe", model: "m", answer_json: JSON.stringify({ answer: { type: "noul", noul: 0.9 }, query: `query ${i}`, questionTier: "act" }),
        tier: "act", outcome: "selected", created_at: t(5 + (i % 13)),
      });
      ins("audit_findings", {
        id: newId("fnd"), workspace_id: ws, project_id: pid, crawl_run_id: crawl, rule_id: "SEO-META-DESC-MISSING", severity: "minor", url, detail: "d", created_at: t(3),
      });
      const ls = newId("ls");
      ins("link_suggestions", {
        id: ls, workspace_id: ws, project_id: pid, link_run_id: linkRun, source_page_id: pageId, target_page_id: pageId, source_url: url, target_url: url,
        target_inlinks: i, suggestion_key: `k${i}`, method: "jev", tier: "act", should_exist: 0.9, status: "suggested", score: 0.5, created_at: t(1), updated_at: t(1),
      });
      ins("decision_records", {
        id: newId("dec"), workspace_id: ws, project_id: pid, run_id: run, agent: "seo", candidate_key: `seo:internal_link:${i}`, question_id: null,
        answer_json: JSON.stringify({ candidate: `internal_link_suggestion:${url}|${url}`, kind: "internal_link", linkSuggestionId: ls, suggestionTier: "act", shouldExist: 0.9 }),
        tier: "act", outcome: "rejected", reason_code: "budget", created_at: t(60 + (i % 7)),
      });
    }
    await db.batch(S);

    // Every statement the feed runs goes through the D1 shim, which throws above 100 bound parameters.
    const seen = new Map<string, LiveSeoBoardResponse["elements"][number]>();
    const queryIds = new Set<string>();
    const recIds = new Set<string>();
    let cursor: string | null = null;
    let last: LiveSeoBoardResponse | null = null;
    for (let i = 0; i < 50; i++) {
      const r: LiveSeoBoardResponse = (await buildLiveSeo(db, ctx.p, run, { now: FIXED_NOW, limit: 200, after: decodeLiveSeoCursor(cursor) }))!;
      const n = r.elements.length + r.queries.length + r.recommendations.length;
      expect(n).toBeLessThanOrEqual(200);
      for (const e of r.elements) {
        expect(seen.has(e.id)).toBe(false);
        seen.set(e.id, e);
      }
      r.queries.forEach((q) => queryIds.add(q.id));
      r.recommendations.forEach((x) => recIds.add(x.id));
      last = r;
      if (n === 0) break;
      cursor = r.cursor;
    }
    // 300 title + 300 action + 300 link + 300 rule rows; 300 queries; 300 recommendations.
    expect(seen.size).toBe(4 * N);
    expect(queryIds.size).toBe(N);
    expect(recIds.size).toBe(N);
    const all = [...seen.values()];
    // Chunked enrichment reached every row (pages, snapshots, recommendations, GSC, link suggestions).
    expect(all.filter((e) => e.role === "element" && e.element === "Title").every((e) => e.now?.startsWith("Product ") && e.gsc?.basis === "page_rows" && e.pageId)).toBe(true);
    expect(all.filter((e) => e.element === "Title" && e.verdict === "change").every((e) => e.proposed?.startsWith("New title "))).toBe(true);
    expect(all.filter((e) => e.element === "Links").every((e) => e.linkSuggestionId && e.now?.includes("internal link"))).toBe(true);
    expect(all.filter((e) => e.role === "action").every((e) => e.recommendationId && e.proposed?.startsWith("New title "))).toBe(true);
    // Totals: action rows of candidates with an element row are not counted.
    expect(last!.totals!.elements).toMatchObject({ judged: 3 * N, keep: N / 2, change: N / 2 + N + N, review: 0 });
    expect(last!.totals!.queries).toMatchObject({ distinct: N, relevance: { yes: N, no: 0, middle: 0, unanswered: 0 } });
    expect(last!.totals!.pipeline).toMatchObject({ candidates: 2 * N, judged: N, rejectedByReason: { budget: N }, created: N });
  });

  it("serves a 200-row page through the mounted route", async () => {
    const ctx = await setup();
    const run = await seedRun(ctx.db, ctx.ws, ctx.pid, "seo", "completed");
    const S: Array<[string, ...unknown[]]> = [];
    for (let i = 0; i < 250; i++) {
      S.push(
        insertStatement("decision_records", {
          id: newId("dec"), workspace_id: ctx.ws, project_id: ctx.pid, run_id: run, agent: "seo", candidate_key: `seo:k:${i}`, question_id: QUESTION.metaMatchesQuery,
          provider: "typesafe", answer_json: JSON.stringify({ answer: { type: "noul", noul: 0.5 }, candidate: `weak_ctr:${ORIGIN}/p${i}`, questionTier: "flag" }),
          tier: "flag", outcome: "selected", created_at: t(i),
        }),
      );
    }
    await ctx.db.batch(S);
    const call = caller(ctx.env, ctx.u);
    const a = await call(`/projects/${ctx.pid}/live/seo?runId=${run}&limit=500`);
    expect(a.status).toBe(200);
    expect(a.json.data.elements).toHaveLength(200);
    const b = await call(`/projects/${ctx.pid}/live/seo?runId=${run}&after=${a.json.data.cursor}`);
    expect(b.json.data.elements).toHaveLength(50);
    expect(b.json.data.totals.elements).toMatchObject({ judged: 250, review: 250 });
  });
});
