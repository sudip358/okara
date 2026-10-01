/**
 * Follow-up fixes (seo-extras): pageType and productFacts wired end to end (shared contract, strict route
 * schema for drafts only, service, web form), Jev asked only for draft-check items code left manual, and
 * the 40-word item labelled as a word-overlap heuristic. Fake providers only.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "@worker/app";
import type { ChecklistItem, DraftCheckResult } from "@shared/types";
import type { Env } from "@worker/env";
import { Db } from "@worker/lib/db";
import { HttpError } from "@worker/lib/errors";
import type { DecisionAnswer, DecisionProvider, DecisionRequest, DecisionResult } from "@worker/providers/types";
import { draftCheckRoutes, setDraftCheckDecisionsFactory } from "@worker/routes/draft-check";
import { runDraftCheck } from "@worker/draftcheck/service";
import { DRAFT_EXTRA_ITEMS } from "@worker/draftcheck/items";
import { askDraftJev } from "@worker/draftcheck/jev";
import {
  buildDraftCheckRequest,
  DRAFT_CHECKS,
  DRAFT_PAGE_TYPES,
  EMPTY_FORM,
  MAX_PRODUCT_FACTS,
  parseValidationDetails,
  validateDraftForm,
  validateFactRows,
  type DraftForm,
} from "@web/pages/draft-check/lib";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";
import { projectRow } from "./checklists-seed";

afterEach(() => setDraftCheckDecisionsFactory(null));

async function setup() {
  const env = createTestEnv();
  const u = await seedUser(env);
  const projectId = await seedProject(env, u.workspaceId, {});
  const db = new Db(env.DB);
  return { env, db, projectId, userId: u.userId, workspaceId: u.workspaceId, project: await projectRow(db, projectId) };
}

function fakeProvider(answer: (id: string) => DecisionAnswer | undefined = () => ({ type: "noul", noul: 0.99 })) {
  const requests: DecisionRequest[] = [];
  const provider: DecisionProvider = {
    name: "typesafe",
    async decide(req): Promise<DecisionResult> {
      requests.push(req);
      return { provider: "typesafe", model: "jev-test", answers: Object.fromEntries(Object.keys(req.questions).map((k) => [k, answer(k)])), usage: { inputTokens: 1, outputTokens: 1 } };
    },
    async test() {
      return { ok: true, detail: "fake" };
    },
  };
  return { provider, requests };
}

async function post(env: Env, userId: string, projectId: string, body: unknown) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", new Db(env.DB));
    c.set("now", FIXED_NOW);
    c.set("user", { id: userId, email: "u@example.com", name: null });
    c.set("session", null);
    await next();
  });
  app.route("/", draftCheckRoutes);
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as 400);
    throw err;
  });
  const res = await app.request(`/projects/${projectId}/seo/draft-check`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }, env);
  return { status: res.status, json: (await res.json()) as { data: DraftCheckResult; error?: { code: string; details?: Array<{ path: string; message: string }> } } };
}

const item = (r: DraftCheckResult, id: string): ChecklistItem => {
  const i = r.checklist.items.find((x) => x.id === id);
  if (!i) throw new Error(`missing ${id}`);
  return i;
};

const DRAFT = `# Solid brass cabinet pull

Our solid brass cabinet pull is machined in our workshop from bar stock and finished by hand.

## How do I clean unlacquered brass?

Wipe it with mild soap and water and dry it.`;

describe("POST draft-check: pageType and productFacts", () => {
  it("accepts both for pasted drafts and forwards them to the service and Jev", async () => {
    const { env, userId, projectId } = await setup();
    const fake = fakeProvider();
    setDraftCheckDecisionsFactory(async () => fake.provider);
    const r = await post(env, userId, projectId, { targetQuery: "brass cabinet pull", draftText: DRAFT, pageType: "product", productFacts: { " Material ": "Solid brass", Finish: "Unlacquered" } });
    expect(r.status).toBe(200);
    expect(r.json.data.labels.join(" ")).toMatch(/Drafts are evaluated as a product page/);
    expect(fake.requests).toHaveLength(1);
    const req = fake.requests[0]!;
    expect(Object.keys(req.questions)).toContain("item_product_facts");
    expect((req.state as { product_facts: Record<string, string> }).product_facts).toEqual({ Material: "Solid brass", Finish: "Unlacquered" });
    expect((req.state as { draft: { page_type: string } }).draft.page_type).toBe("product");
    expect(item(r.json.data, "page.publish_check.product_facts")).toMatchObject({ status: "met" });
  });

  it("without facts, a product draft reports product facts as unknown (not not_applicable)", async () => {
    const { env, userId, projectId } = await setup();
    setDraftCheckDecisionsFactory(async () => null);
    const r = await post(env, userId, projectId, { targetQuery: "brass cabinet pull", draftText: DRAFT, pageType: "product" });
    expect(r.status).toBe(200);
    expect(item(r.json.data, "page.publish_check.product_facts")).toMatchObject({ status: "unknown" });
  });

  it("rejects them for a crawled page, bad page types, too many fields, and over-long keys or values", async () => {
    const { env, userId, projectId } = await setup();
    setDraftCheckDecisionsFactory(async () => null);
    const status = async (b: Record<string, unknown>) => (await post(env, userId, projectId, { targetQuery: "q", ...b })).status;
    const facts = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, "v"]));
    const pageOnly = await post(env, userId, projectId, { targetQuery: "q", pageId: "pg_1", pageType: "product" });
    expect(pageOnly.status).toBe(400);
    expect(pageOnly.json.error?.details?.some((d) => d.path === "pageType")).toBe(true);
    expect(await status({ pageId: "pg_1", productFacts: { a: "b" } })).toBe(400);
    expect(await status({ draftText: "text", pageType: "blog" })).toBe(400);
    expect(await status({ draftText: "text", productFacts: facts(MAX_PRODUCT_FACTS + 1) })).toBe(400);
    expect(await status({ draftText: "text", productFacts: { ["k".repeat(61)]: "v" } })).toBe(400);
    expect(await status({ draftText: "text", productFacts: { k: "v".repeat(301) } })).toBe(400);
    expect(await status({ draftText: "text", productFacts: { k: "   " } })).toBe(400);
    expect(await status({ draftText: "text", productFacts: { k: 5 } })).toBe(400);
    // At the limits.
    expect(await status({ draftText: "text", pageType: "landing", productFacts: { ...facts(MAX_PRODUCT_FACTS - 1), ["k".repeat(60)]: "v".repeat(300) } })).toBe(200);
  });
});

describe("Jev is asked only for draft-check items left manual", () => {
  it("a number only in a heading leaves numbers_sourced not_applicable and unasked", async () => {
    const { db, project } = await setup();
    const fake = fakeProvider();
    const draft = `# Top 5 brass pulls\n\nBrass pulls look good on walnut cabinets and age well over time.\n\n## Care\n\nWipe them with soap and water.`;
    const r = await runDraftCheck({ targetQuery: "brass pulls", draftText: draft }, { db, project, decisions: fake.provider, now: FIXED_NOW });
    expect(fake.requests).toHaveLength(1);
    expect(Object.keys(fake.requests[0]!.questions)).not.toContain("item_numbers_sourced");
    expect(item(r, "page.publish_check.numbers_sourced")).toMatchObject({ status: "not_applicable", method: "measured" });
  });

  it("askDraftJev skips draft-check items outside the askable set but keeps per-page item questions", async () => {
    const { db, project } = await setup();
    const fake = fakeProvider();
    const input = {
      targetQuery: "brass pulls",
      title: "Brass pulls",
      metaDescription: null,
      headings: [{ level: 1, text: "Brass pulls" }, { level: 2, text: "What sizes?" }, { level: 2, text: "How to clean?" }],
      opening: "Brass pulls come in three sizes.",
      text: "Brass pulls come in 3 sizes. Wipe them with soap.",
      wordCount: 10,
      claims: [],
    };
    const deps = { decisions: fake.provider, db, workspaceId: project.workspace_id, projectId: project.id, candidateKey: "draftcheck:test", clock: () => FIXED_NOW };
    await askDraftJev(input, deps);
    const all = Object.keys(fake.requests[0]!.questions);
    expect(all).toEqual(expect.arrayContaining(["item_numbers_sourced", "item_headings_match_questions", "item_answer_early"]));
    await askDraftJev({ ...input, askableItemIds: new Set(["page.while_write.headings_match_questions"]) }, { ...deps, candidateKey: "draftcheck:test2" });
    const limited = Object.keys(fake.requests[1]!.questions);
    expect(limited).toContain("item_headings_match_questions");
    expect(limited).toContain("item_answer_early"); // per-page item: unaffected
    expect(limited).not.toContain("item_numbers_sourced");
    expect(limited).not.toContain("item_faq_when_useful");
  });
});

describe("40-word item is a labelled heuristic", () => {
  it("uses the honest label, Heuristic method, and the review note in both items.ts and lib.ts", async () => {
    const def = DRAFT_EXTRA_ITEMS.find((d) => d.id === "page.while_write.answer_first_40_words")!;
    expect(def.label).toBe("Target query words in the first 40 words");
    const web = DRAFT_CHECKS.find((c) => c.id === def.id)!;
    expect(web).toEqual({
      id: def.id,
      label: "Target query words in the first 40 words",
      method: "Heuristic",
      note: 'Word overlap with the target query; the answer itself is judged by "Answer the main question early".',
    });
    const { db, project } = await setup();
    const r = await runDraftCheck({ targetQuery: "brass cabinet pull", draftText: DRAFT }, { db, project, decisions: null, now: FIXED_NOW });
    expect(item(r, def.id)).toMatchObject({ method: "heuristic", label: "Target query words in the first 40 words" });
  });
});

describe("web form: page type and product facts", () => {
  const base: DraftForm = { ...EMPTY_FORM, targetQuery: "brass pull", draftText: "Some draft text." };

  it("validates fact rows: blank rows ignored, missing halves, lengths, duplicates, and the 20-field limit", () => {
    expect(validateFactRows([{ key: " ", value: "" }])).toEqual({ facts: null, error: null });
    expect(validateFactRows([{ key: " Material ", value: " Brass " }])).toEqual({ facts: { Material: "Brass" }, error: null });
    expect(validateFactRows([{ key: "Material", value: "" }]).error).toMatch(/Product field 1: enter a value/);
    expect(validateFactRows([{ key: "", value: "Brass" }]).error).toMatch(/Product field 1: enter a field name/);
    expect(validateFactRows([{ key: "k".repeat(61), value: "v" }]).error).toMatch(/at most 60 characters/);
    expect(validateFactRows([{ key: "k", value: "v".repeat(301) }]).error).toMatch(/at most 300 characters/);
    expect(validateFactRows([{ key: "a", value: "1" }, { key: "a", value: "2" }]).error).toMatch(/Product field 2: "a" is already listed/);
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `k${i}`, value: "v" }));
    expect(validateFactRows(rows(MAX_PRODUCT_FACTS)).error).toBeNull();
    expect(validateFactRows(rows(MAX_PRODUCT_FACTS + 1)).error).toBe("At most 20 product fields.");
  });

  it("builds pageType and productFacts into draft requests only, and reports row errors on productFacts", () => {
    const built = buildDraftCheckRequest({ ...base, pageType: "product", productFacts: [{ key: "Finish", value: "Satin" }, { key: "", value: "" }] });
    expect(built).toEqual({ ok: true, body: { targetQuery: "brass pull", draftText: "Some draft text.", pageType: "product", productFacts: { Finish: "Satin" } } });
    const plain = buildDraftCheckRequest(base);
    expect(plain.ok && plain.body).toEqual({ targetQuery: "brass pull", draftText: "Some draft text." });
    const page = buildDraftCheckRequest({ ...base, mode: "page", pageId: "pg_1", pageType: "product", productFacts: [{ key: "a", value: "b" }] });
    expect(page.ok && page.body).toEqual({ targetQuery: "brass pull", pageId: "pg_1" });
    expect(validateDraftForm({ ...base, productFacts: [{ key: "a", value: "" }] }).productFacts).toMatch(/enter a value/);
    expect(validateDraftForm({ ...base, pageType: "blog" as never }).pageType).toBeTruthy();
    expect(DRAFT_PAGE_TYPES[0]).toBe("article");
  });

  it("maps nested server paths such as productFacts.Color to the productFacts field", () => {
    const parsed = parseValidationDetails([{ path: "productFacts.Color", message: "Too long" }, { path: "pageType", message: "Invalid" }]);
    expect(parsed.fields).toEqual({ productFacts: "Too long", pageType: "Invalid" });
    expect(parsed.general).toEqual([]);
  });
});
