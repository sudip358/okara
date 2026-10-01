import { describe, expect, it } from "vitest";
import type { LiveSeoBoardResponse, LiveSeoElementRow } from "@shared/types";
import { HttpError } from "@worker/lib/errors";
import { buildLiveSeo, decidedActionElement, decodeLiveSeoCursor, encodeLiveSeoCursor } from "@worker/live/seo-board";
import { encodeCursor } from "@worker/runs/activity";
import { QUESTION } from "@worker/seo/questions";
import { FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";
import {
  caller,
  choice,
  noul,
  ORIGIN,
  seedCrawl,
  seedDecision,
  seedFinding,
  seedGsc,
  seedPage,
  seedRec,
  seedRun,
  setup,
  t,
} from "./live-worker-seed";

const build = async (ctx: Awaited<ReturnType<typeof setup>>, run: string, limit = 200) => (await buildLiveSeo(ctx.db, ctx.p, run, { now: FIXED_NOW, limit }))!;
const byId = (r: LiveSeoBoardResponse) => new Map(r.elements.map((e) => [e.id, e]));

describe("GET /projects/:pid/live/seo: access and input", () => {
  it("404s for another workspace's run and for a run of another project; never 403", async () => {
    const ctx = await setup();
    const other = await seedUser(ctx.env);
    const pOther = await seedProject(ctx.env, other.workspaceId);
    const pSibling = await seedProject(ctx.env, ctx.ws);
    const runOther = await seedRun(ctx.db, other.workspaceId, pOther, "seo", "completed");
    const runSibling = await seedRun(ctx.db, ctx.ws, pSibling, "seo", "completed");
    const mine = await seedRun(ctx.db, ctx.ws, ctx.pid, "seo", "completed");
    // The other tenant's rows exist and must never leak.
    await seedDecision(ctx.db, other.workspaceId, pOther, runOther, { questionId: QUESTION.titleMatchesQuery, answer: noul(0.9) });
    const call = caller(ctx.env, ctx.u);
    expect((await call(`/projects/${pOther}/live/seo?runId=${runOther}`)).status).toBe(404); // not a member
    expect((await call(`/projects/${ctx.pid}/live/seo?runId=${runOther}`)).status).toBe(404); // other workspace's run
    expect((await call(`/projects/${ctx.pid}/live/seo?runId=${runSibling}`)).status).toBe(404); // sibling project's run
    const ok = await call(`/projects/${ctx.pid}/live/seo?runId=${mine}`);
    expect(ok.status).toBe(200);
    expect(ok.json.data.elements).toEqual([]);
    expect(ok.json.data.cursor).toBeNull();
    const sib = await call(`/projects/${pSibling}/live/seo?runId=${runSibling}`);
    expect(sib.status).toBe(200);
  });

  it("400s on a missing runId, a GEO run, a bad limit, and a malformed or foreign cursor", async () => {
    const ctx = await setup();
    const seo = await seedRun(ctx.db, ctx.ws, ctx.pid, "seo", "completed");
    const geo = await seedRun(ctx.db, ctx.ws, ctx.pid, "geo", "completed");
    const call = caller(ctx.env, ctx.u);
    const missing = await call(`/projects/${ctx.pid}/live/seo`);
    expect(missing.status).toBe(400);
    expect(missing.json.error.details).toEqual({ field: "runId" });
    const mismatch = await call(`/projects/${ctx.pid}/live/seo?runId=${geo}`);
    expect(mismatch.status).toBe(400);
    expect(mismatch.json.error.details).toEqual({ reason: "agent_mismatch" });
    expect((await call(`/projects/${ctx.pid}/live/seo?runId=${seo}&limit=0`)).status).toBe(400);
    expect((await call(`/projects/${ctx.pid}/live/seo?runId=${seo}&limit=1.5`)).status).toBe(400);
    expect((await call(`/projects/${ctx.pid}/live/seo?runId=${seo}&limit=9999`)).status).toBe(200); // capped, not rejected
    expect((await call(`/projects/${ctx.pid}/live/seo?runId=${seo}&after=bogus!`)).status).toBe(400);
    // An activity-feed cursor (different keys) is not accepted here.
    const activityCursor = encodeCursor({ e: 1, s: 0, o: 0, d: 0, c: 0 });
    expect((await call(`/projects/${ctx.pid}/live/seo?runId=${seo}&after=${activityCursor}`)).status).toBe(400);
    expect((await call(`/projects/${ctx.pid}/live/seo?runId=${seo}&after=${encodeLiveSeoCursor({ d: 0, f: 0, r: 0 })}`)).status).toBe(200);
    // Unknown run id: 404.
    expect((await call(`/projects/${ctx.pid}/live/seo?runId=run_nope`)).status).toBe(404);
    await expect(buildLiveSeo(ctx.db, ctx.p, geo, { now: FIXED_NOW })).rejects.toBeInstanceOf(HttpError);
  });
});

describe("verdicts: stored tier + raw answer + per-question polarity (code, never Jev text)", () => {
  // [question, stored answer, tier, element, verdict]
  const CASES: Array<[string, unknown, string | null, string, "keep" | "change" | "review", string?]> = [
    [QUESTION.titleMatchesQuery, noul(0.92), "act", "Title", "keep"],
    [QUESTION.titleMatchesQuery, noul(0.08), "act", "Title", "change"],
    [QUESTION.titleMatchesQuery, noul(0.55), "flag", "Title", "review"],
    [QUESTION.titleMatchesQuery, null, "drop", "Title", "review"],
    [QUESTION.titleMatchesQuery, noul(0.9), "n/a", "Title", "review"],
    [QUESTION.metaMatchesQuery, noul(0.9), "act", "Meta", "keep"],
    [QUESTION.metaMatchesQuery, noul(0.1), "act", "Meta", "change"],
    [QUESTION.answerIsDirect, noul(0.1), "act", "Intro", "change"],
    [QUESTION.answerIsDirect, noul(0.95), "act", "Intro", "keep"],
    [QUESTION.schemaContentMatch, noul(0.95), "act", "Schema", "keep"],
    [QUESTION.schemaContentMatch, noul(0.05), "act", "Schema", "change"],
    [QUESTION.coversTopic, noul(0.1), "act", "Topics", "change", "seo.covers_topic#t1"],
    [QUESTION.coversTopic, noul(0.9), "act", "Topics", "keep", "seo.covers_topic#t2"],
    // Inverted polarity: a confident yes means something must change.
    [QUESTION.outdatedInformation, noul(0.9), "act", "Freshness", "change"],
    [QUESTION.outdatedInformation, noul(0.05), "act", "Freshness", "keep"],
    [QUESTION.thinContent, noul(0.9), "act", "Content", "change", "seo.thin_content#e1"],
    [QUESTION.thinContent, noul(0.1), "act", "Content", "keep", "seo.thin_content#e2"],
    [QUESTION.pageOverlap, noul(0.9), "act", "Duplicate", "change"],
    [QUESTION.pageOverlap, noul(0.1), "act", "Duplicate", "keep"],
    [QUESTION.pageOverlap, noul(0.5), "drop", "Duplicate", "review"],
    // Choice: option -> verdict; flag/drop never become keep or change.
    [QUESTION.intentPageFit, choice("fits", 0.9), "act", "Intent", "keep"],
    [QUESTION.intentPageFit, choice("mismatch", 0.9), "act", "Intent", "change"],
    [QUESTION.intentPageFit, choice("partial_fit", 0.9), "act", "Intent", "review"],
    [QUESTION.intentPageFit, choice("fits", 0.6), "flag", "Intent", "review"],
    [QUESTION.pageAction, choice("keep", 0.85), "act", "Page", "keep"],
    [QUESTION.pageAction, choice("update", 0.85), "act", "Page", "change"],
    [QUESTION.pageAction, choice("merge", 0.85), "act", "Page", "change"],
    [QUESTION.pageAction, choice("insufficient_context", 0.85), "act", "Page", "review"],
    [QUESTION.actionChoice, choice("rewrite_title_meta", 0.9), "act", "Title + meta", "change"],
    [QUESTION.actionChoice, choice("add_comparison_or_spec_table", 0.9), "act", "Compare table", "change"],
    [QUESTION.actionChoice, choice("fix_canonical_or_indexing", 0.9), "act", "Canonical", "change"],
    [QUESTION.actionChoice, choice("no_action", 0.9), "act", "Page", "keep"],
    [QUESTION.actionChoice, choice("something_new", 0.9), "act", "Page", "review"],
    [QUESTION.actionChoice, choice("add_section", 0.3), "drop", "Section", "review"],
  ];

  it("maps every element question to its documented element and verdict, and totals match the rows", async () => {
    const ctx = await setup();
    const run = await seedRun(ctx.db, ctx.ws, ctx.pid, "seo", "completed");
    const ids: string[] = [];
    for (const [q, answer, tier, , , key] of CASES) {
      // One candidate per row, so every action row is shown on its own (no element row shares its key).
      ids.push(await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { questionId: q, answer, tier, extra: key ? { key } : {} }));
    }
    // Rows that are never element rows: non-element questions stay out of the list (pipeline only).
    await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { questionId: QUESTION.issueSeverity, answer: choice("2", 0.9) });
    await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { questionId: QUESTION.queryPageRelevance, answer: noul(0.9) });
    await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { questionId: QUESTION.pillarFit, answer: noul(0.9) });
    await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { questionId: null, extra: { kind: "technical" } });

    const r = await build(ctx, run);
    const rows = byId(r);
    expect(r.elements).toHaveLength(CASES.length);
    CASES.forEach(([q, , tier, element, verdict], i) => {
      const row = rows.get(`dec:${ids[i]}`)!;
      expect(row, `${q} ${JSON.stringify(CASES[i]![1])} ${tier}`).toMatchObject({ element, verdict, questionId: q });
      expect(row.role).toBe(q === QUESTION.actionChoice ? "action" : "element");
      expect(row.jev?.tier).toBe(tier);
      expect(row.rule).toBeNull();
    });
    // Noul never carries a confidence; Choice carries the provider's confidence for the chosen option.
    const title = rows.get(`dec:${ids[0]}`)!;
    expect(title.jev).toEqual({ questionId: QUESTION.titleMatchesQuery, tier: "act", noul: 0.92, choice: null, confidence: null, provider: "typesafe", model: "jev-test" });
    expect(title.verdictBasis).toBe("Noul 0.92, act tier: confident yes");
    const fits = r.elements.find((e) => e.questionId === QUESTION.intentPageFit && e.verdict === "keep")!;
    expect(fits.jev).toMatchObject({ noul: null, choice: "fits", confidence: 0.9 });

    // Totals are grouped SQL, never a row scan; they must agree with the rows one by one.
    const count = (v: string) => r.elements.filter((e) => e.verdict === v).length;
    expect(r.totals!.elements).toMatchObject({ judged: CASES.length, keep: count("keep"), change: count("change"), review: count("review") });
    for (const el of new Set(r.elements.map((e) => e.element))) {
      const of = r.elements.filter((e) => e.element === el);
      expect(r.totals!.elements.byElement[el], el).toEqual({
        keep: of.filter((e) => e.verdict === "keep").length,
        change: of.filter((e) => e.verdict === "change").length,
        review: of.filter((e) => e.verdict === "review").length,
      });
    }
    expect(r.totals!.truncated).toBe(false);
  });

  it("reads bare demo-format answers the same way as wrapped ones", async () => {
    const ctx = await setup();
    const run = await seedRun(ctx.db, ctx.ws, ctx.pid, "seo", "completed");
    const bare = await seedDecision(ctx.db, ctx.ws, ctx.pid, run, {
      questionId: QUESTION.actionChoice, tier: "act", candidateKey: "template:product:offer",
      rawAnswerJson: JSON.stringify({ type: "choice", choice: "add_offer_markup", confidence: 0.86, probabilities: { add_offer_markup: 0.86 } }),
    });
    const malformed = await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { questionId: QUESTION.titleMatchesQuery, tier: "act", rawAnswerJson: "{not json" });
    const r = await build(ctx, run);
    expect(byId(r).get(`dec:${bare}`)).toMatchObject({ element: "Schema", verdict: "change", targetLabel: "Candidate template:product:offer" });
    // A malformed stored answer is unusable: review, and the grouped totals do not fail on it.
    expect(byId(r).get(`dec:${malformed}`)).toMatchObject({ element: "Title", verdict: "review" });
    expect(r.totals!.elements).toMatchObject({ judged: 2, change: 1, review: 1 });
  });

  it("counts an action row in the totals only when its candidate has no element row", async () => {
    const ctx = await setup();
    const run = await seedRun(ctx.db, ctx.ws, ctx.pid, "seo", "completed");
    await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { candidateKey: "A", questionId: QUESTION.titleMatchesQuery, answer: noul(0.1) });
    await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { candidateKey: "A", questionId: QUESTION.actionChoice, answer: choice("rewrite_title_meta", 0.9) });
    await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { candidateKey: "B", questionId: QUESTION.actionChoice, answer: choice("add_section", 0.9) });
    // Another run's element row for B must not hide B's action row in this run.
    const other = await seedRun(ctx.db, ctx.ws, ctx.pid, "seo", "completed");
    await seedDecision(ctx.db, ctx.ws, ctx.pid, other, { candidateKey: "B", questionId: QUESTION.titleMatchesQuery, answer: noul(0.9) });
    const r = await build(ctx, run);
    expect(r.elements.map((e) => e.role).sort()).toEqual(["action", "action", "element"]);
    expect(r.totals!.elements).toMatchObject({ judged: 2, change: 2, keep: 0 });
    expect(r.totals!.elements.byElement).toEqual({ Title: { keep: 0, change: 1, review: 0 }, Section: { keep: 0, change: 1, review: 0 } });
  });

  it("turns reused link suggestions and rule findings into rows, and skips unmapped rules", async () => {
    const ctx = await setup();
    const run = await seedRun(ctx.db, ctx.ws, ctx.pid, "seo", "completed");
    const crawl = await seedCrawl(ctx.db, ctx.ws, ctx.pid, run);
    const src = await seedPage(ctx.db, ctx.ws, ctx.pid, crawl, `${ORIGIN}/guide`, { title: "Guide" }, "article");
    const tgt = await seedPage(ctx.db, ctx.ws, ctx.pid, crawl, `${ORIGIN}/products/pull`, { title: "Pull" });
    const lrun = "lr_1";
    await ctx.db.insert("link_runs", { id: lrun, workspace_id: ctx.ws, project_id: ctx.pid, crawl_run_id: crawl, status: "completed", method_version: "m", created_at: t(1) });
    await ctx.db.insert("link_suggestions", {
      id: "ls_1", workspace_id: ctx.ws, project_id: ctx.pid, link_run_id: lrun, source_page_id: src, target_page_id: tgt, source_url: `${ORIGIN}/guide`,
      target_url: `${ORIGIN}/products/pull`, target_inlinks: 1, suggestion_key: "k", method: "jev", tier: "act", should_exist: 0.91, provider: "typesafe",
      model: "links-model", status: "suggested", score: 0.7, created_at: t(1), updated_at: t(1),
    });
    // The real candidate kind stored by recommend/generate.ts for suggestion candidates is "internal_link".
    const link = await seedDecision(ctx.db, ctx.ws, ctx.pid, run, {
      questionId: null, provider: null, model: null, tier: "act", readable: `internal_link_suggestion:${ORIGIN}/guide|${ORIGIN}/products/pull`,
      extra: { kind: "internal_link", linkSuggestionId: "ls_1", suggestionTier: "act", shouldExist: 0.91 },
    });
    const linkFlag = await seedDecision(ctx.db, ctx.ws, ctx.pid, run, {
      questionId: null, provider: null, model: null, tier: "flag", readable: `internal_link_suggestion:${ORIGIN}/guide|${ORIGIN}/x`,
      extra: { kind: "internal_link", linkSuggestionId: "ls_missing", suggestionTier: "flag", shouldExist: 0.6 },
    });
    const fact = await seedFinding(ctx.db, ctx.ws, ctx.pid, crawl, { ruleId: "SEO-META-DESC-MISSING", severity: "minor", url: `${ORIGIN}/guide` });
    const heur = await seedFinding(ctx.db, ctx.ws, ctx.pid, crawl, { ruleId: "SEO-H1-MULTIPLE", severity: "minor", url: null, template: "product template" });
    await seedFinding(ctx.db, ctx.ws, ctx.pid, crawl, { ruleId: "AI-SEARCH-CRAWLER-BLOCKED", severity: "major" });
    // A finding of another crawl (not this run's) is not a row of this run.
    const otherCrawl = await seedCrawl(ctx.db, ctx.ws, ctx.pid, null, t(0));
    await seedFinding(ctx.db, ctx.ws, ctx.pid, otherCrawl, { ruleId: "SEO-TITLE-MISSING" });

    const r = await build(ctx, run);
    const rows = byId(r);
    expect(r.elements).toHaveLength(4);
    expect(rows.get(`dec:${link}`)).toMatchObject({
      element: "Links", verdict: "change", questionId: "links.should_exist", linkSuggestionId: "ls_1", pagePath: "/guide",
      now: "/products/pull has 1 internal link in",
      jev: { questionId: "links.should_exist", tier: "act", noul: 0.91, choice: null, confidence: null, provider: "typesafe", model: "links-model" },
    });
    expect(rows.get(`dec:${linkFlag}`)).toMatchObject({ element: "Links", verdict: "review", now: null });
    expect(rows.get(`find:${fact}`)).toMatchObject({
      role: "rule", element: "Meta", verdict: "change", questionId: "SEO-META-DESC-MISSING", jev: null, outcome: null, candidateKey: null,
      rule: { ruleId: "SEO-META-DESC-MISSING", severity: "minor", class: "fact" }, verdictBasis: "Rule (fact)", pagePath: "/guide",
    });
    expect(rows.get(`find:${heur}`)).toMatchObject({ element: "H1", verdict: "review", targetLabel: "Template: product template", url: null, pagePath: null });
    expect(r.totals!.elements).toMatchObject({ judged: 4, change: 2, review: 2 });
  });
});

describe("row values come from stored rows only", () => {
  it("fills now from this run's snapshot, proposed from the drafted snippet, and GSC with its window and basis", async () => {
    const ctx = await setup();
    const run = await seedRun(ctx.db, ctx.ws, ctx.pid, "seo", "completed");
    const older = await seedCrawl(ctx.db, ctx.ws, ctx.pid, null, t(-500));
    const crawl = await seedCrawl(ctx.db, ctx.ws, ctx.pid, run, t(1));
    const later = await seedCrawl(ctx.db, ctx.ws, ctx.pid, null, t(2000));
    const url = `${ORIGIN}/products/oak`;
    await seedPage(ctx.db, ctx.ws, ctx.pid, older, url, { title: "Old title", fetched_at: t(-500) });
    await seedPage(ctx.db, ctx.ws, ctx.pid, crawl, url, { title: "Oak table | Shop", meta_description: "Solid oak.", first_paragraph: "  Solid   oak table. ", jsonld_types: ["Product", "Offer"], word_count: 1240, fetched_at: t(2) });
    // A later crawl's snapshot exists, but the run's own crawl wins.
    await seedPage(ctx.db, ctx.ws, ctx.pid, later, url, { title: "Newer title", fetched_at: t(2000) });
    // A page only in an older crawl: its latest non-skipped snapshot is used.
    const old = `${ORIGIN}/collections/old`;
    await seedPage(ctx.db, ctx.ws, ctx.pid, older, old, { title: "Old collection", fetched_at: t(-500) }, "collection");
    await seedPage(ctx.db, ctx.ws, ctx.pid, later, old, { skipped_reason: "timeout", fetched_at: t(2000) }, "collection");

    const key = "seo:weak_ctr:abc";
    const recId = await seedRec(ctx.db, ctx.ws, ctx.pid, run, { dedupKey: key, target: { kind: "url", url }, snippet: "Oak Side Table – Solid Oak | Shop" });
    const readable = `weak_ctr:${url}`;
    const titleChange = await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { candidateKey: key, readable, questionId: QUESTION.titleMatchesQuery, answer: noul(0.1) });
    const metaKeep = await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { candidateKey: key, readable, questionId: QUESTION.metaMatchesQuery, answer: noul(0.9) });
    const action = await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { candidateKey: key, readable, questionId: QUESTION.actionChoice, answer: choice("rewrite_title_meta", 0.9) });
    // Same candidate, element outside the action's family: no snippet on it.
    const schema = await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { candidateKey: key, readable, questionId: QUESTION.schemaContentMatch, answer: noul(0.1) });
    // A candidate without a recommendation: target from the readable key, no proposed.
    const intro = await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { readable: `answer_clarity:${old}/`, questionId: QUESTION.answerIsDirect, answer: noul(0.1) });
    const wordCount = await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { readable: `technical:SEO-CONTENT-THIN|${url}`, questionId: QUESTION.thinContent, answer: noul(0.9), extra: { key: "seo.thin_content#e1" } });
    const oldTitle = await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { readable: `weak_ctr:${old}`, questionId: QUESTION.titleMatchesQuery, answer: noul(0.1) });
    const intent = await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { readable: `query_page_mismatch:oak|${old}`, questionId: QUESTION.intentPageFit, answer: choice("mismatch", 0.9) });
    // Template and site targets from the recommendation.
    await seedRec(ctx.db, ctx.ws, ctx.pid, run, { dedupKey: "tpl", target: { kind: "template", template: "product", affectedUrlCount: 3 }, snippet: '"offers": {}' });
    const tpl = await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { candidateKey: "tpl", readable: "technical:ECOM|product", questionId: QUESTION.actionChoice, answer: choice("fix_structured_data", 0.9) });
    await seedRec(ctx.db, ctx.ws, ctx.pid, run, { dedupKey: "site", target: { kind: "site" } });
    const site = await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { candidateKey: "site", readable: "checklist:robots|site", questionId: QUESTION.actionChoice, answer: choice("fix_canonical_or_indexing", 0.9) });

    // GSC: an older sync (ignored), and the latest usable one with page rows for /products/oak (www + trailing slash
    // spelling) and only query+page rows for /collections/old. A failed newer sync is not usable.
    await seedGsc(ctx.db, ctx.ws, ctx.pid, { syncedAt: t(-1000), rows: [{ page: url, clicks: 999, impressions: 9999, position: 1 }] });
    await seedGsc(ctx.db, ctx.ws, ctx.pid, {
      runId: run, syncedAt: t(3), rows: [
        { page: "https://www.shop.example.com/products/oak/", clicks: 30, impressions: 1000, position: 8 },
        { query: "oak table", page: url, clicks: 10, impressions: 500, position: 4 },
        { query: "oak", page: old, clicks: 3, impressions: 100, position: 10 },
        { query: "old", page: old, clicks: 1, impressions: 300, position: 20 },
        { page: url, clicks: 5, impressions: 50, position: 3, device: "MOBILE" },
        { page: url, clicks: 500, impressions: 5000, position: 2, window: "previous" },
      ],
    });
    await seedGsc(ctx.db, ctx.ws, ctx.pid, { syncedAt: t(100), status: "failed", error: "quota", rows: [] });

    const r = await build(ctx, run);
    const rows = byId(r);
    const gscOak = { clicks: 30, impressions: 1000, position: 8, window: { start: "2026-09-01", end: "2026-09-28" }, basis: "page_rows" };
    expect(rows.get(`dec:${titleChange}`)).toMatchObject({
      element: "Title", verdict: "change", now: "Oak table | Shop", proposed: "Oak Side Table – Solid Oak | Shop", pagePath: "/products/oak", url,
      targetLabel: "/products/oak", recommendationId: recId, gsc: gscOak, outcome: "selected",
    });
    expect(rows.get(`dec:${titleChange}`)!.pageId).toBeTruthy();
    // Keep rows never show a proposal; the action row does; an element outside the action's family does not.
    expect(rows.get(`dec:${metaKeep}`)).toMatchObject({ element: "Meta", verdict: "keep", now: "Solid oak.", proposed: null });
    expect(rows.get(`dec:${action}`)).toMatchObject({ role: "action", element: "Title + meta", now: "Title: Oak table | Shop · Meta: Solid oak.", proposed: "Oak Side Table – Solid Oak | Shop" });
    expect(rows.get(`dec:${schema}`)).toMatchObject({ element: "Schema", verdict: "change", now: "Product, Offer", proposed: null });
    expect(rows.get(`dec:${intro}`)).toMatchObject({
      element: "Intro", targetLabel: "/collections/old/", now: null, proposed: null, recommendationId: null,
      gsc: { clicks: 4, impressions: 400, position: 17.5, basis: "query_page_rows" },
    });
    expect(rows.get(`dec:${wordCount}`)).toMatchObject({ element: "Content", now: "1,240 words" });
    // Not in the run's crawl: the page's latest non-skipped snapshot (the later read was skipped).
    expect(rows.get(`dec:${oldTitle}`)).toMatchObject({ element: "Title", now: "Old collection" });
    expect(rows.get(`dec:${intent}`)).toMatchObject({ element: "Intent", verdict: "change", now: "collection page" });
    expect(rows.get(`dec:${tpl}`)).toMatchObject({ targetLabel: "Template: product (3 URLs)", url: null, pagePath: null, pageId: null, now: null, gsc: null, proposed: '"offers": {}' });
    expect(rows.get(`dec:${site}`)).toMatchObject({ targetLabel: "Site", url: null, proposed: null });
    expect(r.labels.some((l) => l.startsWith("Search Console: latest usable sync, 2026-09-01 to 2026-09-28"))).toBe(true);
    // The run's own sync row.
    expect(r.gscSync).toMatchObject({ source: "api", status: "completed", window: { start: "2026-09-01", end: "2026-09-28" }, previousWindow: { start: "2026-08-04", end: "2026-08-31" }, truncated: false, error: null });
    // Recommendations created by the run.
    expect(r.recommendations.map((x) => x.targetLabel).sort()).toEqual(["/products/oak", "Site", "Template: product (3 URLs)"]);
    expect(r.recommendations.find((x) => x.recommendationId === recId)).toMatchObject({
      id: `rec:${recId}`, agent: "seo", scope: "page", url, priority: 0.5, priorityVersion: "priority-v3", tier: "act", evidenceCount: 2, writer: { provider: "writer", model: "w-1" },
    });
  });

  it("shows no Search Console figures without a usable sync and says nothing about it", async () => {
    const ctx = await setup();
    const run = await seedRun(ctx.db, ctx.ws, ctx.pid, "seo", "completed");
    await seedGsc(ctx.db, ctx.ws, ctx.pid, { runId: run, status: "failed", error: "x".repeat(500), rows: [] });
    await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { questionId: QUESTION.titleMatchesQuery, answer: noul(0.9) });
    const r = await build(ctx, run);
    expect(r.elements[0]!.gsc).toBeNull();
    expect(r.labels.some((l) => l.startsWith("Search Console"))).toBe(false);
    expect(r.gscSync).toMatchObject({ status: "failed" });
    expect(r.gscSync!.error!.length).toBeLessThanOrEqual(200);
  });

  it("lists query answers with their stored text, band and GSC figures; intent answers without stored text are counted only", async () => {
    const ctx = await setup();
    const run = await seedRun(ctx.db, ctx.ws, ctx.pid, "seo", "running", { finished_at: null });
    const rel = (q: string, n: number, tier: string) =>
      seedDecision(ctx.db, ctx.ws, ctx.pid, run, { candidateKey: `qrel:${q.toLowerCase()}`, readable: null, questionId: QUESTION.queryRelevance, answer: noul(n), tier, extra: { query: q } });
    const yes = await rel("Oak Table", 0.95, "act");
    const no = await rel("free wallpaper", 0.05, "act");
    const mid = await rel("brass", 0.5, "flag");
    await rel("dropped one", 0.5, "drop");
    // In-candidate intent answer: the readable key holds a token bag, not the typed query -> not listed.
    await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { readable: `striking_distance:oak table|${ORIGIN}/p`, questionId: QUESTION.queryIntent, answer: choice("transactional", 0.9) });
    await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { readable: `striking_distance:brass|${ORIGIN}/p`, questionId: QUESTION.queryIntent, answer: choice("informational", 0.6), tier: "flag" });
    await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { readable: `striking_distance:x|${ORIGIN}/p`, questionId: QUESTION.queryIntent, answer: choice("navigational", 0.3), tier: "drop" });
    const intentWithText = await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { readable: null, questionId: QUESTION.queryIntent, answer: choice("transactional", 0.88), extra: { query: "oak table" } });
    await seedGsc(ctx.db, ctx.ws, ctx.pid, {
      rows: [
        { query: "oak table", clicks: 12, impressions: 400, position: 5.5 },
        { query: "oak table", page: `${ORIGIN}/p`, clicks: 10, impressions: 300, position: 5 },
        { query: "brass", page: `${ORIGIN}/p`, clicks: 2, impressions: 100, position: 9 },
      ],
    });
    const r = await build(ctx, run);
    expect(r.active).toBe(true);
    expect(r.queries.map((q) => q.id).sort()).toEqual([yes, no, mid, intentWithText].map((x) => `dec:${x}`).concat(r.queries.filter((q) => q.query === "dropped one").map((q) => q.id)).sort());
    const q = new Map(r.queries.map((x) => [x.id, x]));
    expect(q.get(`dec:${yes}`)).toMatchObject({
      query: "Oak Table", queryKey: "oak table", band: "yes", questionId: QUESTION.queryRelevance,
      jev: { tier: "act", noul: 0.95, confidence: null }, gsc: { clicks: 12, impressions: 400, position: 5.5, basis: "query_rows" },
    });
    expect(q.get(`dec:${no}`)).toMatchObject({ band: "no", gsc: null });
    expect(q.get(`dec:${mid}`)).toMatchObject({ band: "middle", gsc: { clicks: 2, basis: "query_page_rows" } });
    expect(q.get(`dec:${intentWithText}`)).toMatchObject({ band: null, queryKey: "oak table", jev: { choice: "transactional", confidence: 0.88 } });
    expect(r.queries.find((x) => x.query === "dropped one")).toMatchObject({ band: null });
    expect(r.totals!.queries).toMatchObject({
      relevance: { yes: 1, no: 1, middle: 1, unanswered: 1 },
      buyer: { yes: 0, no: 0, middle: 0, unanswered: 0 },
      intent: { transactional: 2, informational: 1 },
    });
    // Distinct queries with stored text: oak table, free wallpaper, brass, dropped one.
    expect(r.totals!.queries.distinct).toBe(4);
  });

  it("counts the pipeline from the run's decisions and recommendations, excluding query-batch keys", async () => {
    const ctx = await setup();
    const run = await seedRun(ctx.db, ctx.ws, ctx.pid, "seo", "completed");
    await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { candidateKey: "A", questionId: QUESTION.titleMatchesQuery, answer: noul(0.1) });
    await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { candidateKey: "A", questionId: QUESTION.actionChoice, answer: choice("rewrite_title_meta", 0.9) });
    await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { candidateKey: "B", questionId: QUESTION.titleMatchesQuery, answer: noul(0.9), outcome: "rejected", reason: "low_fit" });
    await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { candidateKey: "B", questionId: QUESTION.actionChoice, answer: choice("no_action", 0.9), outcome: "rejected", reason: "low_fit" });
    await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { candidateKey: "C", questionId: null, provider: null, outcome: "rejected", reason: "budget" });
    await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { candidateKey: "D", questionId: null, provider: null, outcome: "rejected", reason: null });
    await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { candidateKey: "qrel:oak", questionId: QUESTION.queryRelevance, answer: noul(0.1), outcome: "rejected", reason: "low_fit", extra: { query: "oak" } });
    await seedRec(ctx.db, ctx.ws, ctx.pid, run, { dedupKey: "A", target: { kind: "url", url: `${ORIGIN}/a` } });
    await seedRec(ctx.db, ctx.ws, ctx.pid, run, { dedupKey: "Z", target: { kind: "site" }, status: "implemented", stage: "marked_implemented" });
    await seedRec(ctx.db, ctx.ws, ctx.pid, null, { dedupKey: "Y", target: { kind: "site" } }); // not this run
    const r = await build(ctx, run);
    expect(r.totals!.pipeline).toEqual({
      candidates: 4,
      judged: 2,
      rejectedByReason: { low_fit: 1, budget: 1, unspecified: 1 },
      created: 2,
      byStage: { collected: 0, judged: 0, drafted: 0, awaiting_approval: 1, marked_implemented: 1 },
      byStatus: { open: 1, approved: 0, dismissed: 0, implemented: 1 },
    });
  });

  it("labels rule-only runs and keeps untrusted text as clipped plain text", async () => {
    const ctx = await setup();
    const run = await seedRun(ctx.db, ctx.ws, ctx.pid, "seo", "completed");
    const crawl = await seedCrawl(ctx.db, ctx.ws, ctx.pid, run);
    const url = `${ORIGIN}/x`;
    await seedPage(ctx.db, ctx.ws, ctx.pid, crawl, url, { title: `<script>alert(1)</script>${"a".repeat(400)}` });
    await seedFinding(ctx.db, ctx.ws, ctx.pid, crawl, { ruleId: "SEO-TITLE-DUPLICATE", url });
    const r = await build(ctx, run);
    const row = r.elements[0] as LiveSeoElementRow;
    expect(row.now!.startsWith("<script>alert(1)</script>")).toBe(true); // plain text; the UI renders it as text
    expect(row.now!.length).toBeLessThanOrEqual(160);
    expect(r.labels).toContain("No Jev answers were stored in this run: rule findings only.");
    expect(r.labels.some((l) => l.startsWith("Demo data"))).toBe(false);
  });
});

describe("drafted snippet placement follows the DECIDED action (seo/recommend/decide.ts)", () => {
  const row = (question_id: string, answer: unknown, tier: string) => ({ candidate_key: "k", question_id, tier, answer_json: JSON.stringify({ answer, candidate: "weak_ctr:x", questionTier: tier }) });
  it("decidedActionElement: drop / n/a action choices are not answers; act misaligned title/meta -> Title + meta; act merge -> Duplicate; unknown -> null", () => {
    expect(decidedActionElement([row(QUESTION.actionChoice, choice("add_section", 0.9), "act")])).toBe("Section");
    expect(decidedActionElement([row(QUESTION.actionChoice, choice("add_section", 0.6), "flag")])).toBe("Section");
    expect(decidedActionElement([row(QUESTION.actionChoice, choice("improve_intro_answer", 0.3), "drop")])).toBeNull();
    expect(decidedActionElement([row(QUESTION.actionChoice, choice("improve_intro_answer", 0.3), "n/a")])).toBeNull();
    // weak_ctr override: a confident "no" on the title or meta match makes it rewrite_title_meta.
    expect(decidedActionElement([row(QUESTION.actionChoice, choice("improve_intro_answer", 0.6), "flag"), row(QUESTION.titleMatchesQuery, noul(0.1), "act")])).toBe("Title + meta");
    expect(decidedActionElement([row(QUESTION.actionChoice, choice("improve_intro_answer", 0.6), "flag"), row(QUESTION.metaMatchesQuery, noul(0.4), "flag")])).toBe("Intro");
    expect(decidedActionElement([row(QUESTION.actionChoice, choice("no_action", 0.9), "act"), row(QUESTION.titleMatchesQuery, noul(0.05), "act")])).toBe("Title + meta");
    // page_action merge (act) -> consolidate_duplicate, whatever the action choice said.
    expect(decidedActionElement([row(QUESTION.actionChoice, choice("add_section", 0.9), "act"), row(QUESTION.pageAction, choice("merge", 0.9), "act")])).toBe("Duplicate");
    // No usable action and no override: a candidate default action cannot be told from the rows.
    expect(decidedActionElement([row(QUESTION.pageAction, choice("update", 0.9), "act")])).toBeNull();
    expect(decidedActionElement([row(QUESTION.actionChoice, choice("no_action", 0.9), "act")])).toBeNull();
  });

  it("a title draft is never shown as a new intro: drop-tier action row and misaligned (act) title row", async () => {
    const ctx = await setup();
    const run = await seedRun(ctx.db, ctx.ws, ctx.pid, "seo", "completed");
    const crawl = await seedCrawl(ctx.db, ctx.ws, ctx.pid, run, t(1));
    const url = `${ORIGIN}/products/oak`;
    await seedPage(ctx.db, ctx.ws, ctx.pid, crawl, url, { title: "Oak table | Shop", first_paragraph: "Solid oak." });
    const key = "seo:weak_ctr:drop";
    await seedRec(ctx.db, ctx.ws, ctx.pid, run, { dedupKey: key, target: { kind: "url", url }, snippet: "NEW TITLE | Shop" });
    const readable = `weak_ctr:${url}`;
    const title = await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { candidateKey: key, readable, questionId: QUESTION.titleMatchesQuery, answer: noul(0.1) });
    const action = await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { candidateKey: key, readable, questionId: QUESTION.actionChoice, answer: choice("improve_intro_answer", 0.3), tier: "drop" });
    const intro = await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { candidateKey: key, readable, questionId: QUESTION.answerIsDirect, answer: noul(0.1) });
    const rows = byId(await build(ctx, run));
    expect(rows.get(`dec:${title}`)).toMatchObject({ element: "Title", verdict: "change", proposed: "NEW TITLE | Shop" });
    expect(rows.get(`dec:${action}`)).toMatchObject({ role: "action", element: "Intro", proposed: null });
    expect(rows.get(`dec:${intro}`)).toMatchObject({ element: "Intro", verdict: "change", proposed: null });
  });

  it("no snippet anywhere when the decided action is unknown; a merge shows it on Duplicate rows only", async () => {
    const ctx = await setup();
    const run = await seedRun(ctx.db, ctx.ws, ctx.pid, "seo", "completed");
    const url = `${ORIGIN}/blog/a`;
    const k1 = "seo:declining:a";
    await seedRec(ctx.db, ctx.ws, ctx.pid, run, { dedupKey: k1, target: { kind: "url", url }, snippet: "Draft intro" });
    const pa = await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { candidateKey: k1, readable: `declining:${url}`, questionId: QUESTION.pageAction, answer: choice("update", 0.9) });
    const k2 = "seo:declining:b";
    await seedRec(ctx.db, ctx.ws, ctx.pid, run, { dedupKey: k2, target: { kind: "url", url: `${ORIGIN}/blog/b` }, snippet: "Merge note" });
    const merge = await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { candidateKey: k2, readable: `declining:${ORIGIN}/blog/b`, questionId: QUESTION.pageAction, answer: choice("merge", 0.9) });
    const overlap = await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { candidateKey: k2, readable: `declining:${ORIGIN}/blog/b`, questionId: `${QUESTION.pageOverlap}`, answer: noul(0.9), extra: { key: `${QUESTION.pageOverlap}#x` } });
    const rows = byId(await build(ctx, run));
    expect(rows.get(`dec:${pa}`)).toMatchObject({ element: "Page", verdict: "change", proposed: null });
    expect(rows.get(`dec:${merge}`)).toMatchObject({ element: "Page", proposed: null });
    expect(rows.get(`dec:${overlap}`)).toMatchObject({ element: "Duplicate", verdict: "change", proposed: "Merge note" });
  });
});

describe("whole-run totals only on the last page of a read", () => {
  it("a full page returns totals null (and no sync row); the short last page returns them", async () => {
    const ctx = await setup();
    const run = await seedRun(ctx.db, ctx.ws, ctx.pid, "seo", "completed");
    await seedGsc(ctx.db, ctx.ws, ctx.pid, { runId: run, rows: [] });
    for (let i = 0; i < 3; i++) await seedDecision(ctx.db, ctx.ws, ctx.pid, run, { candidateKey: `c${i}`, questionId: QUESTION.titleMatchesQuery, answer: noul(0.9), at: t(10 + i) });
    const first = (await buildLiveSeo(ctx.db, ctx.p, run, { now: FIXED_NOW, limit: 2 }))!;
    expect(first.elements).toHaveLength(2);
    expect(first.totals).toBeNull();
    expect(first.gscSync).toBeNull();
    const last = (await buildLiveSeo(ctx.db, ctx.p, run, { now: FIXED_NOW, limit: 2, after: decodeLiveSeoCursor(first.cursor) }))!;
    expect(last.elements).toHaveLength(1);
    expect(last.totals!.elements.judged).toBe(3);
    expect(last.gscSync).not.toBeNull();
  });
});
