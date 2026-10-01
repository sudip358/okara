/**
 * Draft check grown to 25 checks (2026-10-01): the measured "answer in the first 40 words" item, eight new
 * Jev Noul items asked only when their inputs exist, all in one bounded call, plus the internal-link
 * target cap raised to 15 within the unchanged Jev budget. Fake providers only.
 */
import { describe, expect, it } from "vitest";
import type { ChecklistItem, DraftCheckResult } from "@shared/types";
import { Db } from "@worker/lib/db";
import type { DecisionAnswer, DecisionProvider, DecisionRequest, DecisionResult } from "@worker/providers/types";
import { runDraftCheck, cleanFacts, type DraftCheckInput } from "@worker/draftcheck/service";
import { answerInFirstWords, DRAFT_EXTRA_ITEMS, DRAFT_EXTRA_ITEM_IDS, firstWords, MAX_PRODUCT_FACTS } from "@worker/draftcheck/items";
import { buildJevState, DRAFTCHECK_QUESTIONS_REVISION, hasInputs, ITEM_QUESTIONS, QUESTIONS_PER_CALL_MAX, type ItemQuestionKey } from "@worker/draftcheck/jev";
import { MAX_JEV_CANDIDATES } from "@worker/draftcheck/flags";
import { PAGE_ITEMS } from "@worker/checklists/items/page";
import { MAX_TARGETS_PER_SOURCE } from "@worker/links/candidates";
import { LINK_BATCH_SIZE } from "@worker/links/jev";
import { MAX_PAIRS_PER_RUN } from "@worker/links/run";
import { DEFAULT_PROJECT_LIMITS } from "@worker/runs/budget";
import { DRAFT_CHECKS, DRAFT_CHECKS_SUMMARY } from "@web/pages/draft-check/lib";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";
import { projectRow } from "./checklists-seed";

async function setup() {
  const env = createTestEnv();
  const u = await seedUser(env);
  const pid = await seedProject(env, u.workspaceId, {});
  const db = new Db(env.DB);
  return { db, pid, workspaceId: u.workspaceId, project: await projectRow(db, pid) };
}

function fakeProvider(answer: (id: string) => DecisionAnswer | undefined) {
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

const noul = (n: number): DecisionAnswer => ({ type: "noul", noul: n });
const item = (r: DraftCheckResult, id: string): ChecklistItem => {
  const i = r.checklist.items.find((x) => x.id === id);
  if (!i) throw new Error(`missing ${id}`);
  return i;
};

const DRAFT = `# Solid brass cabinet pull, 128 mm

Our solid brass cabinet pull measures 128 mm between holes and costs $24, machined in our workshop from bar stock.

## What sizes does the brass pull come in?

It comes in 96 mm, 128 mm and 160 mm hole spacing. Each size uses the same 12 mm bar.

## How do I clean unlacquered brass?

Wipe it with mild soap and water and dry it. Order a sample from our [brass pulls](/collections/brass-pulls) page.
`;

const HTML_PRODUCT = `<head><script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"Brass pull"}</script></head>
<h1>Solid brass cabinet pull</h1><p>Our solid brass cabinet pull measures 128 mm between holes and costs $24.</p>
<h2>Sizes</h2><p>Three hole spacings.</p><h2>Care</h2><p>Soap and water.</p>`;

describe("answer in the first 40 words (measured)", () => {
  it("takes the first 40 words and measures the target query's word overlap", () => {
    const long = Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ");
    expect(firstWords(long).split(" ")).toHaveLength(40);
    expect(firstWords(null)).toBe("");
    expect(answerInFirstWords("Solid brass cabinet pulls cost $24 each.", "brass cabinet pull")).toMatchObject({ status: "met", coverage: 1 });
    expect(answerInFirstWords("Solid brass knobs are popular.", "brass cabinet pull").status).toBe("partial");
    expect(answerInFirstWords("We love our customers.", "brass cabinet pull")).toMatchObject({ status: "not_met", coverage: 0 });
    // A query word after word 40 does not count.
    const late = `${Array.from({ length: 40 }, () => "filler").join(" ")} brass cabinet pull`;
    expect(answerInFirstWords(late, "brass cabinet pull")).toMatchObject({ status: "not_met", coverage: 0 });
    expect(answerInFirstWords(null, "brass").status).toBe("not_met");
    expect(answerInFirstWords("Anything at all here.", "the of and").status).toBe("unknown");
  });
});

describe("draft check items and questions", () => {
  it("has 25 checks: the 16 on-page items plus 9 draft-check items, all with distinct ids", () => {
    expect(PAGE_ITEMS).toHaveLength(16);
    expect(DRAFT_EXTRA_ITEMS).toHaveLength(9);
    expect(new Set([...PAGE_ITEMS.map((d) => d.id), ...DRAFT_EXTRA_ITEM_IDS]).size).toBe(25);
    // Every Jev item question maps to a real item; "answer in 40 words" is never a Jev question.
    const allIds = new Set([...PAGE_ITEMS.map((d) => d.id), ...DRAFT_EXTRA_ITEM_IDS]);
    for (const q of Object.values(ITEM_QUESTIONS)) expect(allIds.has(q.itemId), q.itemId).toBe(true);
    expect(Object.values(ITEM_QUESTIONS).some((q) => q.itemId === "page.while_write.answer_first_40_words")).toBe(false);
    expect(Object.values(ITEM_QUESTIONS).some((q) => q.itemId === "page.publish_check.internal_links")).toBe(false);
    expect(Object.keys(ITEM_QUESTIONS)).toHaveLength(13);
    for (const q of Object.values(ITEM_QUESTIONS)) {
      expect(q.question.type).toBe("noul");
      if (q.question.type === "noul") expect(q.question.criteria?.true && q.question.criteria?.false).toBeTruthy();
      expect(JSON.stringify(q.question)).not.toMatch(/confidence|rank(ing)? (higher|better)|will be cited|copy/i);
    }
    expect(DRAFTCHECK_QUESTIONS_REVISION).toBe("draftcheck-questions-2026-10-01.1");
    // Bounded: every item question plus the maximum excerpt questions fit one call.
    expect(Object.keys(ITEM_QUESTIONS).length + MAX_JEV_CANDIDATES).toBeLessThanOrEqual(QUESTIONS_PER_CALL_MAX);
  });

  it("asks a question only when its inputs exist (pure state check)", () => {
    const base = { targetQuery: "brass pull", title: "t", metaDescription: null, headings: [{ level: 1, text: "H" }], opening: "Opening text here.", text: "Plain words only.", wordCount: 3, claims: [] };
    const bare = buildJevState(base);
    const asked = (st: ReturnType<typeof buildJevState>) => (Object.keys(ITEM_QUESTIONS) as ItemQuestionKey[]).filter((k) => hasInputs(k, st));
    expect(asked(bare).sort()).toEqual(["answer_early", "author_credentials", "compare_table", "faq_when_useful", "first_hand", "terms_entities", "topic_coverage", "unique_angle"]);
    const full = buildJevState({
      ...base,
      headings: [{ level: 1, text: "H" }, { level: 2, text: "A?" }, { level: 2, text: "B?" }],
      text: "It costs $24.",
      fullText: true,
      pageType: "product",
      schemaTypes: ["Product"],
      productFacts: { price: "$24" },
    });
    expect(asked(full)).toHaveLength(13);
    expect(full.draft.closing).toBe("It costs $24.");
    expect(full.product_facts).toEqual({ price: "$24" });
    // A crawled page's excerpt is not the full text: no closing, so no next-step question.
    expect(buildJevState({ ...base, fullText: false }).draft.closing).toBeNull();
    // Untrusted text is sanitized: no double quotes or backticks reach the state.
    const dirty = buildJevState({ ...base, author: 'Jo "the" `pro`', productFacts: { 'fin"ish': "a`b" } });
    expect(JSON.stringify(dirty.draft.author)).not.toMatch(/`|\\"/);
    expect(Object.keys(dirty.product_facts)[0]).toBe("fin'ish");
  });

  it("cleanFacts trims, drops empties, and caps the field count", () => {
    expect(cleanFacts(undefined)).toBeNull();
    expect(cleanFacts({ " ": "x", a: " " })).toBeNull();
    expect(cleanFacts({ " price ": " $24 " })).toEqual({ price: "$24" });
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, "v"]));
    expect(Object.keys(cleanFacts(many)!)).toHaveLength(MAX_PRODUCT_FACTS);
  });
});

describe("runDraftCheck with the new items", () => {
  it("without Jev: new Jev items are manual with a measured hint; the 40-word item is measured", async () => {
    const { db, project } = await setup();
    const r = await runDraftCheck({ targetQuery: "brass cabinet pull", draftText: DRAFT }, { db, project, decisions: null, now: FIXED_NOW });
    expect(r.checklist.items).toHaveLength(25);
    expect(item(r, "page.while_write.answer_first_40_words")).toMatchObject({ status: "met", method: "heuristic" });
    expect(item(r, "page.while_write.answer_first_40_words").evidence[0]!.detail).toMatch(/^Our solid brass cabinet pull/);
    expect(item(r, "page.while_write.faq_when_useful")).toMatchObject({ status: "manual", method: "manual", manual: null });
    expect(item(r, "page.while_write.faq_when_useful").summary).toMatch(/no FAQ heading and 2 question-style headings/);
    expect(item(r, "page.while_write.headings_match_questions").summary).toMatch(/^2 of 2 subheadings are phrased as questions/);
    expect(item(r, "page.publish_check.numbers_sourced").status).toBe("manual");
    expect(item(r, "page.publish_check.product_facts").status).toBe("not_applicable");
    expect(item(r, "page.publish_check.schema_fit").status).toBe("not_applicable");
    expect(item(r, "page.while_write.clear_next_step").status).toBe("manual");
    expect(r.labels.join(" ")).toMatch(/FAQ, comparison tables, author credentials/);
    for (const i of r.checklist.items) expect(`${i.summary} ${i.guidance} ${i.caveat ?? ""}`, i.id).not.toMatch(/will rank|traffic|revenue|citab|steal|copy the/i);
  });

  it("with Jev: one call, new items mapped by tier, product facts and schema fit asked only with inputs", async () => {
    const { db, project, pid, workspaceId } = await setup();
    const { provider, requests } = fakeProvider((id) =>
      id === "item_product_facts" ? noul(0.05) : id === "item_schema_fit" ? noul(0.1) : id === "item_faq_when_useful" ? noul(0.6) : noul(0.92),
    );
    const input: DraftCheckInput = { targetQuery: "brass cabinet pull", draftText: HTML_PRODUCT, pageType: "product", productFacts: { price: "$29", "hole spacing": "128 mm" } };
    const r = await runDraftCheck(input, { db, project, decisions: provider, now: FIXED_NOW });
    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    const keys = Object.keys(req.questions);
    expect(keys).toEqual(expect.arrayContaining(["item_product_facts", "item_schema_fit", "item_numbers_sourced", "item_clear_next_step", "item_headings_match_questions"]));
    expect(keys.length).toBeLessThanOrEqual(QUESTIONS_PER_CALL_MAX);
    const state = req.state as { draft: { page_type: string; schema_types: string[]; closing: string | null }; product_facts: Record<string, string> };
    expect(state.draft.page_type).toBe("product");
    expect(state.draft.schema_types).toEqual(["Article"]);
    expect(state.product_facts).toEqual({ price: "$29", "hole spacing": "128 mm" });
    expect(state.draft.closing).toMatch(/Soap and water\.$/);

    expect(item(r, "page.publish_check.product_facts")).toMatchObject({ status: "not_met", method: "heuristic" });
    expect(item(r, "page.publish_check.product_facts").summary).toMatch(/^Jev judgment on whether the product facts in the text match the provided product fields: no \(yes-probability 0\.05\)\.$/);
    expect(item(r, "page.publish_check.schema_fit").status).toBe("not_met");
    expect(item(r, "page.while_write.faq_when_useful")).toMatchObject({ status: "partial" });
    expect(item(r, "page.while_write.faq_when_useful").summary).toMatch(/^Check this yourself: Jev leaned yes/);
    expect(item(r, "page.before_write.author_credentials").status).toBe("met");
    expect(r.verdict).toBe("needs_review"); // a flag-tier answer needs a person
    expect(r.labels.join(" ")).toMatch(/13 checklist items where their inputs exist/);

    const rows = await db.all<{ question_id: string; question_version: string | null }>("SELECT question_id, question_version FROM decision_records WHERE workspace_id = ? AND project_id = ?", workspaceId, pid);
    expect(rows.map((x) => x.question_id)).toEqual(expect.arrayContaining(["seo.draft.product_facts", "seo.draft.schema_fit", "seo.draft.clear_next_step"]));
    expect(rows.every((x) => x.question_version)).toBe(true);
  });

  it("the web page's list of checks matches the server's item ids", async () => {
    const { db, project } = await setup();
    const r = await runDraftCheck({ targetQuery: "brass cabinet pull", draftText: DRAFT }, { db, project, decisions: null, now: FIXED_NOW });
    expect(DRAFT_CHECKS.map((c) => c.id).sort()).toEqual(r.checklist.items.map((i) => i.id).sort());
    for (const c of DRAFT_CHECKS) expect(item(r, c.id).label, c.id).toBe(c.label);
    expect(DRAFT_CHECKS_SUMMARY).toMatch(/^25 checks:/);
  });
});

describe("internal links: 15 targets per source within the same Jev budget", () => {
  it("raises targets per source but keeps a run inside the default daily Jev calls", () => {
    expect(MAX_TARGETS_PER_SOURCE).toBe(15);
    expect(MAX_PAIRS_PER_RUN).toBe(400);
    const callsPerRun = Math.ceil(MAX_PAIRS_PER_RUN / LINK_BATCH_SIZE);
    expect(callsPerRun).toBe(40);
    expect(LINK_BATCH_SIZE * 4).toBeLessThanOrEqual(50); // 4 questions per pair, one call
    expect(callsPerRun).toBeLessThanOrEqual(DEFAULT_PROJECT_LIMITS.provider_calls_per_day);
  });
});
