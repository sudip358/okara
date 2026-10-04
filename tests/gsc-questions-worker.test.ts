/**
 * [A37] GEO prompts from Search Console question queries, worker side: the versioned question rules (positive and
 * negative examples), prompt text (verbatim, light normalization), brand exclusion and brand-blind typing, near-
 * duplicate merging, existing / removed-earlier prompt exclusion, ranking, evidence fields and caps; the routes
 * (tenancy 404, member read, setup_required without a sync, POST adds UNAPPROVED prompts with Search Console
 * provenance and respects the set cap, duplicates and stale sets); D1 limits with 5,000 stored query rows.
 */
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "@worker/app";
import type { Env } from "@worker/env";
import { Db, insertStatement } from "@worker/lib/db";
import { HttpError } from "@worker/lib/errors";
import { newId } from "@worker/lib/ids";
import { geoRoutes } from "@worker/routes/geo";
import {
  GSC_QUESTION_CANDIDATE_CAP,
  GSC_QUESTION_RULES_VERSION,
  addGscQuestionPrompts,
  buildGscQuestions,
  matchQuestionRules,
  promptTextFromQuery,
  selectQuestionCandidates,
  tokenSetKey,
  type AggregatedQuery,
} from "@worker/geo/gsc-questions";
import type { GscQuestionsResponse } from "@shared/gsc-questions";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";

function makeApp(env: Env, userId: string) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", new Db(c.env.DB));
    c.set("now", FIXED_NOW);
    c.set("user", { id: userId, email: "u@example.com", name: null });
    c.set("session", null);
    await next();
  });
  app.route("/", geoRoutes);
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as 400);
    throw err;
  });
  return async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
    return { status: res.status, json: (await res.json()) as any };
  };
}

async function setup(projectOverrides: Record<string, unknown> = {}) {
  const env = createTestEnv();
  const u = await seedUser(env);
  const projectId = await seedProject(env, u.workspaceId, projectOverrides);
  const other = await seedUser(env, { email: "other@example.com", workspaceName: "Other workspace" });
  const db = new Db(env.DB);
  return { env, u, projectId, db, call: makeApp(env, u.userId), callOther: makeApp(env, other.userId), otherUserId: other.userId };
}
type Setup = Awaited<ReturnType<typeof setup>>;

type Row = [query: string, page: string | null, clicks: number, impressions: number, position: number, window?: "current" | "previous"];
const PAGE = (p: string) => `https://shop.example.com${p}`;

async function seedSync(s: Setup, rows: Row[], o: { source?: "api" | "csv_import" | "demo"; status?: string; syncedAt?: string } = {}): Promise<string> {
  const syncId = newId("gsync");
  await s.db.insert("gsc_syncs", {
    id: syncId, workspace_id: s.u.workspaceId, project_id: s.projectId, source: o.source ?? "api", property: "sc-domain:example.com",
    window_start: "2026-08-30", window_end: "2026-09-26", prev_window_start: "2026-08-02", prev_window_end: "2026-08-29",
    row_cap: 25000, status: o.status ?? "completed", synced_at: o.syncedAt ?? FIXED_NOW.toISOString(),
  });
  const stmts = rows.map(([query, page, clicks, impressions, position, window]) =>
    insertStatement("gsc_metrics", { workspace_id: s.u.workspaceId, project_id: s.projectId, sync_id: syncId, window: window ?? "current", query, page, device: null, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position }),
  );
  for (let i = 0; i < stmts.length; i += 200) await s.db.batch(stmts.slice(i, i + 200));
  return syncId;
}

const ROWS: Row[] = [
  ["what is unlacquered brass", PAGE("/blogs/guide/unlacquered-brass"), 30, 900, 6.5],
  ["can lights for kitchen", PAGE("/collections/can-lights"), 50, 1000, 3.1], // a product, not a question
  ["how to clean brass cabinet knobs", PAGE("/blogs/care/clean-brass"), 12, 300, 8],
  ["how to clean brass cabinet knobs", PAGE("/collections/knobs"), 2, 100, 12], // same query, second page
  ["how to clean the brass cabinet knobs", PAGE("/blogs/care/clean-brass"), 1, 50, 9], // near-duplicate
  ["best brass pulls for kitchen", PAGE("/collections/pulls"), 9, 200, 11.2],
  ["residence example knobs review", PAGE("/"), 40, 700, 1.2], // self brand
  ["brass co vs rejuvenation hardware", PAGE("/pages/compare"), 3, 150, 14], // names a competitor -> reputation
  ["brass cabinet knobs", PAGE("/collections/knobs"), 80, 2000, 4], // not a question
  ["best knobs", PAGE("/collections/knobs"), 5, 120, 9], // 2 words
  ["site:shop.example.com how to", null, 0, 40, 1], // operator
  ["does brass tarnish outdoors", PAGE("/blogs/care/tarnish"), 4, 80, 7], // already in the set
  ["why does brass tarnish so fast", PAGE("/blogs/care/tarnish"), 4, 500, 7, "previous"], // previous window only
  ["difference between brass and bronze", PAGE("/blogs/guide/brass-vs-bronze"), 6, 120, 9.4],
];

// ------------------------------------------------------------------ rules (pure)
describe("question rules", () => {
  it("matches question words and AI-style asks (positive examples)", () => {
    const cases: Array<[string, string, boolean]> = [
      ["how to clean brass knobs", "wh_start", true],
      ["what finish is unlacquered brass", "wh_start", true],
      ["which brass is best for bathrooms", "wh_start", true],
      ["brass knobs how to clean", "wh_word", false],
      ["does brass tarnish outdoors", "aux_start", true],
      ["is brass better than nickel", "aux_start", true],
      ["should i lacquer brass", "aux_start", true],
      ["can i paint brass hardware", "aux_start", true],
      ["best brass cabinet pulls", "best", false],
      ["top 10 brass finishes", "top", false],
      ["brass hardware top 5 brands", "top", false],
      ["brass vs bronze hardware", "vs", false],
      ["brass vs. bronze hardware", "vs", false],
      ["brass pulls versus knobs", "vs", false],
      ["difference between brass and bronze", "difference_between", false],
      ["brass kitchen hardware ideas", "ideas", false],
      ["brass hardware buying guide", "guide", false],
      ["unlacquered brass knobs reviews", "review", false],
      ["alternatives to brass hardware", "alternatives", false],
      ["alternative to brass hardware", "alternatives", false],
      ["compare brass and nickel pulls", "compare", false],
      ["brass and nickel comparison", "compare", false],
    ];
    for (const [q, rule, interrogative] of cases) {
      const m = matchQuestionRules(q);
      expect(m.rules, q).toContain(rule);
      expect(m.interrogative, q).toBe(interrogative);
    }
  });
  it("leaves products and look-alikes out (negative examples)", () => {
    for (const q of ["brass cabinet knobs", "can lights for kitchen", "can opener brass", "kitchen vanity top brass", "whatever brass knobs", "bestseller brass knobs", "toppers for cabinets", "versatile brass hooks", "guidebook brass"]) {
      expect(matchQuestionRules(q).rules, q).toEqual([]);
    }
  });
  it("keeps the query as typed: trim, collapse spaces, capitalize, '?' for interrogatives only", () => {
    expect(promptTextFromQuery("  how to   clean brass ", true)).toBe("How to clean brass?");
    expect(promptTextFromQuery("does brass tarnish?", true)).toBe("Does brass tarnish?");
    expect(promptTextFromQuery("best brass knobs for kitchen", false)).toBe("Best brass knobs for kitchen");
    expect(promptTextFromQuery("what is brass.", true)).toBe("What is brass?");
  });
  it("near-duplicate key: sorted unique words without a / an / the", () => {
    expect(tokenSetKey("how to clean the brass knobs")).toBe(tokenSetKey("How to clean brass knobs?"));
    expect(tokenSetKey("brass knobs clean how to")).toBe(tokenSetKey("how to clean brass knobs"));
    expect(tokenSetKey("how to clean brass pulls")).not.toBe(tokenSetKey("how to clean brass knobs"));
  });
  it("selection: min words, brand, existing prompts, removed earlier, ranking and cap (pure)", () => {
    const q = (query: string, impressions: number, clicks = 0): AggregatedQuery => ({ query, key: query, clicks, impressions, position: 5, landingPage: null });
    const base = {
      includeBrand: false,
      isSelfBrand: (x: string) => x.includes("acme"),
      namesTrackedBrand: (t: string) => /rival/i.test(t),
      existingKeys: new Set(["how to oil a door", tokenSetKey("why is the sky blue")]),
      removedKeys: new Set(["what is a hinge"]),
      evidenceBase: { source: "gsc" as const, window: { start: "2026-08-30", end: "2026-09-26" }, syncId: "s1", syncedAt: "2026-09-30T00:00:00.000Z", syncSource: "api" as const },
      cap: 2,
    };
    const sel = selectQuestionCandidates(
      [q("best acme hinges ever", 999), q("how to oil a door", 800), q("sky why is blue", 700), q("what is a hinge", 600), q("best hinges", 500), q("best rival hinges list", 300), q("best brass hinges list", 300, 9), q("how to fix a hinge", 400), q("zero impressions how to", 0)],
      base,
    );
    expect(sel.candidates.map((c) => c.text)).toEqual(["How to fix a hinge?", "Best brass hinges list"]);
    expect(sel.counts).toMatchObject({ brandExcluded: 1, alreadyInSet: 2, removedEarlier: 1, eligible: 3 });
    const all = selectQuestionCandidates([q("best rival hinges list", 300)], { ...base, cap: Infinity });
    expect(all.candidates[0]!.promptType).toBe("reputation");
    expect(selectQuestionCandidates([q("best acme hinges ever", 1)], { ...base, includeBrand: true }).candidates).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ GET
describe("GET /geo/prompts/from-gsc", () => {
  it("setup_required without a stored sync (and POST answers 412); tenancy is a 404", async () => {
    const s = await setup();
    const res = await s.call("GET", `/projects/${s.projectId}/geo/prompts/from-gsc`);
    expect(res.status).toBe(200);
    const d = res.json.data as GscQuestionsResponse;
    expect(d.state).toBe("setup_required");
    expect(d.candidates).toEqual([]);
    expect(d.message).toMatch(/Integrations/);
    const post = await s.call("POST", `/projects/${s.projectId}/geo/prompts/from-gsc`, { queries: ["how to clean brass cabinet knobs"] });
    expect(post.status).toBe(412);
    expect(post.json.error.code).toBe("setup_required");
    expect((await s.callOther("GET", `/projects/${s.projectId}/geo/prompts/from-gsc`)).status).toBe(404);
    expect((await s.callOther("POST", `/projects/${s.projectId}/geo/prompts/from-gsc`, { queries: ["x y z"] })).status).toBe(404);
  });

  it("question queries from the latest usable sync: brand out, near-duplicates merged, existing prompts out, ranked, with evidence", async () => {
    const s = await setup();
    const put = await s.call("PUT", `/projects/${s.projectId}/geo/prompts`, { prompts: [{ text: "Does brass tarnish outdoors?", promptType: "discovery", stage: null, approved: true }] });
    expect(put.status).toBe(200);
    // An older sync and a newer failed one are ignored; the newest completed/partial sync is used.
    await seedSync(s, [["how to polish brass old sync", null, 1, 999, 3]], { syncedAt: "2026-09-01T00:00:00.000Z" });
    const syncId = await seedSync(s, ROWS);
    await s.db.insert("gsc_syncs", {
      id: newId("gsync"), workspace_id: s.u.workspaceId, project_id: s.projectId, source: "api", window_start: "2026-08-31", window_end: "2026-09-27",
      prev_window_start: "2026-08-03", prev_window_end: "2026-08-30", row_cap: 25000, status: "failed", synced_at: "2026-09-30T13:00:00.000Z",
    });

    const res = await s.call("GET", `/projects/${s.projectId}/geo/prompts/from-gsc`);
    expect(res.status).toBe(200);
    const d = res.json.data as GscQuestionsResponse;
    expect(d.state).toBe("ready");
    expect(d.methodVersion).toBe(GSC_QUESTION_RULES_VERSION);
    expect(d.sync).toMatchObject({ id: syncId, source: "api", window: { start: "2026-08-30", end: "2026-09-26" } });
    expect(d.labels[0]).toBe("Search Console, stored sync 2026-09-30, window 2026-08-30..2026-09-26");
    expect(d.candidates.map((c) => c.text)).toEqual([
      "What is unlacquered brass?",
      "How to clean brass cabinet knobs?",
      "Best brass pulls for kitchen",
      "Brass co vs rejuvenation hardware",
      "Difference between brass and bronze",
    ]);
    const clean = d.candidates[1]!;
    expect(clean.evidence).toEqual({
      source: "gsc", query: "how to clean brass cabinet knobs", impressions: 400, clicks: 14, position: 9, landingPage: PAGE("/blogs/care/clean-brass"),
      window: { start: "2026-08-30", end: "2026-09-26" }, syncId, syncedAt: FIXED_NOW.toISOString(), syncSource: "api",
    });
    expect(clean.variants).toEqual([{ query: "how to clean the brass cabinet knobs", impressions: 50 }]);
    expect(clean.rules).toEqual(["wh_start"]);
    expect(clean.key).toBe("how to clean brass cabinet knobs");
    expect(d.candidates[3]!.promptType).toBe("reputation");
    expect(d.candidates.filter((c) => c.promptType === "discovery")).toHaveLength(4);
    expect(d.counts).toMatchObject({ brandExcluded: 1, alreadyInSet: 1, mergedDuplicates: 1, eligible: 5, removedEarlier: 0 });
    expect(d.promptSet).toMatchObject({ size: 1, room: 24, max: 25 });
    expect(d.labels.join(" ")).toContain("1 brand query left out");

    const withBrand = (await s.call("GET", `/projects/${s.projectId}/geo/prompts/from-gsc?includeBrand=1`)).json.data as GscQuestionsResponse;
    const brand = withBrand.candidates.find((c) => c.evidence.query === "residence example knobs review")!;
    expect(brand.promptType).toBe("reputation");
    expect(withBrand.includeBrand).toBe(true);
    expect((await s.call("GET", `/projects/${s.projectId}/geo/prompts/from-gsc?includeBrand=maybe`)).status).toBe(400);
  });

  it("a workspace member (not owner) can read; CSV imports have no position; non-English projects are disabled", async () => {
    const s = await setup();
    const now = FIXED_NOW.toISOString();
    await s.db.insert("memberships", { workspace_id: s.u.workspaceId, user_id: s.otherUserId, role: "member", created_at: now });
    await seedSync(s, [["how to clean brass cabinet knobs", null, 3, 90, 0]], { source: "csv_import" });
    const d = (await s.callOther("GET", `/projects/${s.projectId}/geo/prompts/from-gsc`)).json.data as GscQuestionsResponse;
    expect(d.state).toBe("ready");
    expect(d.candidates[0]!.evidence).toMatchObject({ position: null, landingPage: null, syncSource: "csv_import" });
    expect(d.labels[0]).toContain("(CSV import)");

    const fr = await setup({ language: "fr", locale: "fr-FR" });
    await seedSync(fr, [["comment nettoyer le laiton", null, 1, 10, 3]]);
    const off = (await fr.call("GET", `/projects/${fr.projectId}/geo/prompts/from-gsc`)).json.data as GscQuestionsResponse;
    expect(off.state).toBe("disabled");
    expect(off.candidates).toEqual([]);
    expect(off.message).toMatch(/English/);
  });

  it("caps candidates at 50 and reads 5,000 stored rows within D1 limits", async () => {
    const s = await setup();
    const rows: Row[] = [];
    for (let i = 0; i < 5000; i++) {
      // 80 distinct question queries (each on several pages) among non-question rows.
      if (i < 400) rows.push([`how to style brass item ${Math.floor(i / 5)}`, PAGE(`/p/${i % 5}`), 1, 10 + Math.floor(i / 5), 8]);
      else rows.push([`brass cabinet knob sku ${i}`, PAGE(`/products/${i}`), 0, 5, 20]);
    }
    await seedSync(s, rows);
    const d = (await s.call("GET", `/projects/${s.projectId}/geo/prompts/from-gsc`)).json.data as GscQuestionsResponse;
    expect(d.counts.rowsRead).toBe(5000);
    expect(d.counts.eligible).toBe(80);
    expect(d.candidates).toHaveLength(GSC_QUESTION_CANDIDATE_CAP);
    expect(d.candidates[0]!.evidence).toMatchObject({ query: "how to style brass item 79", impressions: 5 * 89 });
    const imps = d.candidates.map((c) => c.evidence.impressions);
    expect(imps).toEqual(imps.slice().sort((a, b) => b - a));
    // Adding still validates against every eligible candidate (not only the 50 shown).
    const add = await s.call("POST", `/projects/${s.projectId}/geo/prompts/from-gsc`, { queries: ["how to style brass item 0"] });
    expect(add.status).toBe(201);
  });
});

// ------------------------------------------------------------------ POST
describe("POST /geo/prompts/from-gsc", () => {
  it("adds UNAPPROVED prompts in a new version labelled from Search Console, with stored provenance", async () => {
    const s = await setup();
    const syncId = await seedSync(s, ROWS);
    const before = (await s.call("GET", `/projects/${s.projectId}/geo/prompts/from-gsc`)).json.data as GscQuestionsResponse;
    expect(before.promptSet).toBeNull();
    const res = await s.call("POST", `/projects/${s.projectId}/geo/prompts/from-gsc`, {
      queries: ["how to clean brass cabinet knobs", "brass co vs rejuvenation hardware", "how to clean brass cabinet knobs", "brass cabinet knobs"],
      setId: null,
    });
    expect(res.status).toBe(201);
    const r = res.json.data;
    expect(r.set.version).toBe(1);
    expect(r.set.label).toBe("Added from Search Console 2026-09-30");
    expect(r.set.prompts.map((p: any) => [p.text, p.promptType, p.approved])).toEqual([
      ["How to clean brass cabinet knobs?", "discovery", false],
      ["Brass co vs rejuvenation hardware", "reputation", false],
    ]);
    expect(r.skipped.map((x: any) => x.reason)).toEqual(["duplicate of another selected query", expect.stringContaining("not a question query")]);
    expect(r.added[0].evidence).toMatchObject({ source: "gsc", syncId, impressions: 400 });

    const recs = await s.db.all<{ destination: string; record_key: string; status: string; source_key: string; data_json: string }>(
      "SELECT destination, record_key, status, source_key, data_json FROM import_records WHERE project_id = ? ORDER BY record_key",
      s.projectId,
    );
    expect(recs.map((x) => [x.destination, x.record_key, x.status, x.source_key])).toEqual([
      ["gsc_prompts", "brass co vs rejuvenation hardware", "in_set", `gsc:${syncId}`],
      ["gsc_prompts", "how to clean brass cabinet knobs", "in_set", `gsc:${syncId}`],
    ]);
    expect(JSON.parse(recs[1]!.data_json)).toMatchObject({ evidence: { query: "how to clean brass cabinet knobs", landingPage: PAGE("/blogs/care/clean-brass") }, methodVersion: GSC_QUESTION_RULES_VERSION });

    const after = (await s.call("GET", `/projects/${s.projectId}/geo/prompts/from-gsc`)).json.data as GscQuestionsResponse;
    expect(after.candidates.map((c) => c.evidence.query)).not.toContain("how to clean brass cabinet knobs");
    expect(after.counts.alreadyInSet).toBe(2);
    expect(after.added.map((a) => a.text).sort()).toEqual(["Brass co vs rejuvenation hardware", "How to clean brass cabinet knobs?"]);
    expect(after.added[0]!.evidence?.syncId).toBe(syncId);

    // Again: already in the set -> nothing to add (400) and no new version.
    const again = await s.call("POST", `/projects/${s.projectId}/geo/prompts/from-gsc`, { queries: ["how to clean brass cabinet knobs"], setId: r.set.id });
    expect(again.status).toBe(400);
    expect(again.json.error.details.skipped[0].reason).toBe("already in the prompt set");
    expect((await s.db.all("SELECT id FROM geo_prompt_sets WHERE project_id = ?", s.projectId)).length).toBe(1);

    // Stale set id -> 409.
    expect((await s.call("POST", `/projects/${s.projectId}/geo/prompts/from-gsc`, { queries: ["what is unlacquered brass"], setId: "gps_stale" })).status).toBe(409);
    expect((await s.call("POST", `/projects/${s.projectId}/geo/prompts/from-gsc`, { queries: ["what is unlacquered brass"], setId: null })).status).toBe(409);

    // Removed by the owner afterwards -> not suggested again.
    const put = await s.call("PUT", `/projects/${s.projectId}/geo/prompts`, { prompts: [{ text: "Brass co vs rejuvenation hardware", promptType: "reputation", stage: null, approved: true }] });
    expect(put.status).toBe(200);
    const removed = (await s.call("GET", `/projects/${s.projectId}/geo/prompts/from-gsc`)).json.data as GscQuestionsResponse;
    expect(removed.counts.removedEarlier).toBe(1);
    expect(removed.candidates.map((c) => c.evidence.query)).not.toContain("how to clean brass cabinet knobs");
    expect(removed.added.map((a) => a.text)).toEqual(["Brass co vs rejuvenation hardware"]);
  });

  it("respects the 25-prompt set cap and the request cap", async () => {
    const s = await setup();
    await seedSync(s, ROWS);
    const prompts = Array.from({ length: 24 }, (_, i) => ({ text: `Which brass finish suits room ${i}?`, promptType: "discovery", stage: null, approved: true }));
    const put = await s.call("PUT", `/projects/${s.projectId}/geo/prompts`, { prompts });
    expect(put.status).toBe(200);
    const full = await s.call("POST", `/projects/${s.projectId}/geo/prompts/from-gsc`, { queries: ["what is unlacquered brass", "best brass pulls for kitchen"], setId: put.json.data.id });
    expect(full.status).toBe(400);
    expect(full.json.error.details).toMatchObject({ room: 1, requested: 2, max: 25 });
    const one = await s.call("POST", `/projects/${s.projectId}/geo/prompts/from-gsc`, { queries: ["what is unlacquered brass"], setId: put.json.data.id });
    expect(one.status).toBe(201);
    expect(one.json.data.set.prompts).toHaveLength(25);
    expect(one.json.data.set.prompts.slice(0, 24).every((p: any) => p.approved)).toBe(true); // existing approvals kept
    expect(one.json.data.set.prompts[24]).toMatchObject({ text: "What is unlacquered brass?", approved: false });
    const d = (await s.call("GET", `/projects/${s.projectId}/geo/prompts/from-gsc`)).json.data as GscQuestionsResponse;
    expect(d.promptSet).toMatchObject({ size: 25, room: 0 });

    const tooMany = await s.call("POST", `/projects/${s.projectId}/geo/prompts/from-gsc`, { queries: Array.from({ length: 26 }, (_, i) => `how to q ${i}`) });
    expect(tooMany.status).toBe(400);
    expect((await s.call("POST", `/projects/${s.projectId}/geo/prompts/from-gsc`, { queries: [] })).status).toBe(400);
  });

  it("service functions are callable directly (for a later Ask Okara tool)", async () => {
    const s = await setup();
    await seedSync(s, ROWS);
    const project = (await s.db.first<any>("SELECT * FROM projects WHERE id = ?", s.projectId))!;
    const built = await buildGscQuestions(s.db, project, { cap: 2 });
    expect(built.candidates).toHaveLength(2);
    const res = await addGscQuestionPrompts(s.db, project, { queries: [built.candidates[0]!.key] }, FIXED_NOW);
    expect(res.added).toHaveLength(1);
    expect(res.set.prompts[0]!.approved).toBe(false);
  });
});
