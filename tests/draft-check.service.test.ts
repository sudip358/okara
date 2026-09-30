/** [A23] Draft check service: items on good vs weak drafts, Jev mapping, flags, verdict, budget. */
import { describe, expect, it } from "vitest";
import type { ChecklistItem, DraftCheckResult } from "@shared/types";
import { Db } from "@worker/lib/db";
import { BudgetExceededError } from "@worker/lib/errors";
import type { DecisionAnswer, DecisionProvider, DecisionRequest, DecisionResult } from "@worker/providers/types";
import { POLICY_VERSION, questionVersion } from "@worker/runs/policy";
import {
  applyJevToItem,
  CRITICAL_ITEMS,
  decideVerdict,
  LABEL_GATE,
  runDraftCheck,
  type DraftCheckInput,
} from "@worker/draftcheck/service";
import { CLAIM_QUESTION_ID, DRAFTCHECK_QUESTION_TEMPLATES, DRAFTCHECK_QUESTIONS_REVISION, draftQuestionVersions, ITEM_QUESTIONS } from "@worker/draftcheck/jev";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";
import { projectRow } from "./checklists-seed";

/**
 * Snapshot of the draft-check question versions for DRAFTCHECK_QUESTIONS_REVISION. Changing a question's
 * wording changes its hash: bump the revision and this snapshot together.
 */
const REVISION_SNAPSHOT = "draftcheck-questions-2026-09-30.1";

const GOOD = `# Brass vs bronze cabinet pulls: which should you choose?

Brass vs bronze cabinet pulls come down to color, patina, and price: pick brass for a bright gold tone at a lower price, and bronze for a darker finish that hides fingerprints.

## How do brass and bronze cabinet pulls differ?

Brass is an alloy of copper and zinc, while bronze is mostly copper and tin. In our workshop we machine both from solid bar stock, so the difference you see comes from the metal, not a plating. Brass starts bright and warm. Bronze starts darker and browner, and it develops a deep patina over time on kitchen cabinets that get touched every day.

## Finish, patina and care

Unlacquered brass pulls darken within months where hands touch them. Bronze changes more slowly and hides fingerprints well. Clean either metal with mild soap and water, then dry it. Avoid abrasive pads on lacquered finishes. The [Copper Development Association](https://copper.org/applications/architecture/) explains how copper alloys weather indoors.

| Metal | Color | Patina | Care |
| --- | --- | --- | --- |
| Brass | Bright gold | Months | Soap and water |
| Bronze | Dark brown | Years | Soap and water |

Browse our [solid brass cabinet pulls](/collections/brass-pulls) or the [bronze cabinet pulls](/collections/bronze-pulls) to compare sizes and finishes in person.
`;

const WEAK = `In today's fast-paced world, every kitchen deserves the best. We are the #1 hardware store. Our knobs are guaranteed to last forever.

"I love these knobs, they changed my kitchen." — Jane D., Austin`;

async function setup(projectOverrides: Record<string, unknown> = {}) {
  const env = createTestEnv();
  const u = await seedUser(env);
  const pid = await seedProject(env, u.workspaceId, projectOverrides);
  const db = new Db(env.DB);
  return { env, pid, ...u, db, project: await projectRow(db, pid) };
}

function fakeProvider(answers: Record<string, DecisionAnswer | undefined> | ((req: DecisionRequest) => Record<string, DecisionAnswer | undefined>)) {
  const requests: DecisionRequest[] = [];
  const provider: DecisionProvider = {
    name: "typesafe",
    async decide(req): Promise<DecisionResult> {
      requests.push(req);
      return { provider: "typesafe", model: "jev-test", answers: typeof answers === "function" ? answers(req) : answers, usage: { inputTokens: 1, outputTokens: 1 } };
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

const GOOD_INPUT: DraftCheckInput = {
  targetQuery: "brass vs bronze cabinet pulls",
  draftText: GOOD,
  title: "Brass vs bronze cabinet pulls: finish, cost and care",
  metaDescription: "How solid brass and bronze cabinet pulls compare on color, patina, price and care, with a side-by-side table.",
};

describe("draft check: deterministic (no Jev)", () => {
  it("a good draft passes: measured items met, publish-time items unknown, no flags, labelled gate", async () => {
    const { db, project } = await setup();
    const r = await runDraftCheck(GOOD_INPUT, { db, project, decisions: null, now: FIXED_NOW });
    expect(r.state).toBe("ready");
    expect(r.jevUsed).toBe(false);
    expect(r.flags).toEqual([]);
    expect(r.verdict).toBe("pass");
    expect(r.checklist.kind).toBe("page");
    expect(r.checklist.items).toHaveLength(16);
    for (const id of [
      "page.before_write.search_intent",
      "page.before_write.topic_coverage",
      "page.while_write.answer_early",
      "page.while_write.headings",
      "page.while_write.terms_entities",
      "page.while_write.crawlable_text",
      "page.details.title",
      "page.details.meta_description",
      "page.publish_check.internal_links",
      "page.publish_check.sources",
    ]) {
      expect(item(r, id).status, id).toBe("met");
    }
    expect(item(r, "page.details.alt_text").status).toBe("not_applicable");
    for (const id of ["page.details.url", "page.publish_check.indexability", "page.publish_check.structured_data_ux"]) expect(item(r, id).status, id).toBe("unknown");
    for (const id of ["page.before_write.unique_angle", "page.before_write.first_hand"]) expect(item(r, id)).toMatchObject({ status: "manual", manual: null });
    // Target-query wording, never "GSC" for a pasted draft.
    expect(item(r, "page.before_write.search_intent").summary).toMatch(/^The target query "brass vs bronze cabinet pulls" reads as commercial investigation; the draft is evaluated as an article page/);
    expect(item(r, "page.while_write.answer_early").summary).toMatch(/target query/);
    for (const i of r.checklist.items) {
      expect(`${i.summary} ${i.caveat ?? ""}`, i.id).not.toMatch(/GSC|served HTML/);
      expect(i.completeness?.note, i.id).toMatch(/^Pasted draft parsed as markdown/);
    }
    expect(r.labels[0]).toBe(LABEL_GATE);
    expect(r.labels).toContain("A quality gate before human review — not an AI detector and not a ranking prediction.");
    expect(r.labels.join(" ")).toMatch(/Pass: no blocking item or flag found/);
    expect(r.labels.join(" ")).toMatch(/Jev \(TypeSafe\) is not configured/);
    expect(r.labels.join(" ")).not.toMatch(/AI-written|will rank|likely to be cited/i);
    expect(r.checklist.disclaimer).toMatch(/None guarantees/);
  });

  it("a weak draft fails on guarantee and testimonial flags and scores items lower", async () => {
    const { db, project } = await setup();
    const r = await runDraftCheck({ targetQuery: "how to clean brass cabinet knobs", draftText: WEAK }, { db, project, decisions: null, now: FIXED_NOW });
    expect(r.verdict).toBe("fail");
    expect(r.flags.map((f) => f.kind).sort()).toEqual(["fabricated_testimonial", "filler", "guarantee_language", "unsupported_claim"]);
    expect(r.flags.every((f) => f.method === "rule" && f.noul === null)).toBe(true);
    expect(item(r, "page.while_write.headings").status).toBe("not_met");
    expect(item(r, "page.while_write.crawlable_text").status).toBe("partial");
    expect(item(r, "page.details.title")).toMatchObject({ status: "not_met", summary: "The draft has no title." });
    expect(item(r, "page.details.meta_description").status).toBe("not_met");
    expect(item(r, "page.publish_check.internal_links").status).toBe("not_met");
    expect(item(r, "page.publish_check.sources").status).toBe("not_met");
    expect(["partial", "not_met"]).toContain(item(r, "page.while_write.answer_early").status);
    expect(r.labels.join(" ")).toMatch(/Fail: .*guarantee-language flag.*testimonial without evidence/);
  });

  it("a pasted HTML draft with noindex fails indexability (a critical item)", async () => {
    const { db, project } = await setup();
    const html = `<head><meta name="robots" content="noindex"></head><h1>Brass knobs</h1><p>Solid brass knobs for kitchen cabinets, made to order in three sizes.</p><h2>Sizes</h2><p>Small, medium, large.</p>`;
    const r = await runDraftCheck({ targetQuery: "brass knobs", draftText: html }, { db, project, decisions: null, now: FIXED_NOW });
    expect(item(r, "page.publish_check.indexability")).toMatchObject({ status: "not_met", method: "measured" });
    expect(r.verdict).toBe("fail");
    expect(r.labels.join(" ")).toMatch(/Crawlability, indexability \+ canonical" is not met/);
  });
});

describe("draft check: Jev answers mapped into items and flags", () => {
  it("one batched call: act yes -> met, act no -> not_met, flag -> partial 'Check this yourself', missing -> unchanged; claims become Jev flags", async () => {
    const { db, project, pid, workspaceId } = await setup();
    const draft = `${GOOD}\nBrass lasts longer than zinc alloy in humid bathrooms. Our finish cuts cleaning time by 20 minutes a week.\n`;
    const { provider, requests } = fakeProvider({
      item_answer_early: noul(0.93),
      item_topic_coverage: noul(0.1),
      item_unique_angle: noul(0.62),
      // item_first_hand: missing
      item_terms_entities: noul(0.85),
      claim_0: noul(0.9),
      claim_1: noul(0.15),
    });
    const r = await runDraftCheck({ ...GOOD_INPUT, draftText: draft }, { db, project, decisions: provider, now: FIXED_NOW });
    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.purpose).toBe("seo.draft_check");
    expect(Object.keys(req.questions).sort()).toEqual(["claim_0", "claim_1", "item_answer_early", "item_first_hand", "item_terms_entities", "item_topic_coverage", "item_unique_angle"]);
    for (const q of Object.values(req.questions)) {
      expect(q.type).toBe("noul");
      if (q.type === "noul") expect(q.criteria?.true && q.criteria?.false).toBeTruthy();
    }
    const state = req.state as { target_query: string; draft: { text: string; opening: string; headings: string[] }; claims: Record<string, { excerpt: string }> };
    expect(state.target_query).toBe("brass vs bronze cabinet pulls");
    expect(state.draft.text.length).toBeLessThanOrEqual(6000);
    expect(state.draft.headings[0]).toBe("h1: Brass vs bronze cabinet pulls: which should you choose?");
    expect(state.claims.claim_0!.excerpt).toBe("Brass lasts longer than zinc alloy in humid bathrooms.");

    expect(r.jevUsed).toBe(true);
    expect(item(r, "page.while_write.answer_early")).toMatchObject({ status: "met", method: "heuristic" });
    expect(item(r, "page.while_write.answer_early").summary).toMatch(/^Jev judgment on whether the opening paragraph answers the target query directly: yes \(yes-probability 0\.93\)\. Word check:/);
    expect(item(r, "page.before_write.topic_coverage")).toMatchObject({ status: "not_met", method: "heuristic" });
    const angle = item(r, "page.before_write.unique_angle");
    expect(angle).toMatchObject({ status: "partial", method: "heuristic", manual: null });
    expect(angle.summary).toBe("Check this yourself: Jev leaned yes on whether the text contains original information or a distinct angle (yes-probability 0.62).");
    expect(angle.evidence[0]).toMatchObject({ label: "Jev seo.draft.unique_angle" });
    expect(angle.caveat).toMatch(/never predicts rankings or citations/);
    const firstHand = item(r, "page.before_write.first_hand");
    expect(firstHand.status).toBe("manual");
    expect(firstHand.summary).toMatch(/Jev returned no usable answer/);
    expect(item(r, "page.while_write.terms_entities").status).toBe("met");

    expect(r.flags).toEqual([{ kind: "unsupported_claim", text: "Brass lasts longer than zinc alloy in humid bathrooms.", method: "jev", noul: 0.9 }]);
    // topic_coverage is not a critical item; the flag and the flag-tier answer make it needs_review.
    expect(r.verdict).toBe("needs_review");
    expect(r.labels.join(" ")).toMatch(/Jev \(typesafe, model jev-test\) answered 6 of 7 questions in one call/);

    const rows = await db.all<{ agent: string; candidate_key: string; question_id: string; question_version: string; policy_version: string; tier: string | null; outcome: string; reason_code: string | null; answer_json: string; run_id: string | null }>(
      "SELECT agent, candidate_key, question_id, question_version, policy_version, tier, outcome, reason_code, answer_json, run_id FROM decision_records WHERE workspace_id = ? AND project_id = ? ORDER BY question_id, rowid",
      workspaceId,
      pid,
    );
    expect(rows).toHaveLength(7);
    const versions = await draftQuestionVersions();
    for (const row of rows) {
      expect(row.agent).toBe("seo");
      expect(row.run_id).toBeNull();
      expect(row.candidate_key).toMatch(/^draftcheck:[0-9a-f]{16}$/);
      expect(row.policy_version).toBe(POLICY_VERSION);
      expect(row.question_version).toBe(versions[row.question_id]);
    }
    expect(new Set(rows.map((r) => r.candidate_key)).size).toBe(1);
    const byQ = (q: string) => rows.filter((r) => r.question_id === q);
    expect(byQ("seo.draft.answer_early")[0]).toMatchObject({ tier: "act", outcome: "selected" });
    expect(byQ("seo.draft.unique_angle")[0]).toMatchObject({ tier: "flag", outcome: "selected" });
    expect(byQ("seo.draft.first_hand")[0]).toMatchObject({ tier: "drop", outcome: "rejected", reason_code: "decision_unavailable" });
    expect(byQ(CLAIM_QUESTION_ID).map((r) => [r.tier, r.outcome, r.reason_code])).toEqual([
      ["act", "selected", null],
      ["act", "rejected", "low_fit"],
    ]);
    expect(JSON.parse(byQ(CLAIM_QUESTION_ID)[0]!.answer_json)).toMatchObject({ answer: { type: "noul", noul: 0.9 }, excerpt: "Brass lasts longer than zinc alloy in humid bathrooms.", revision: DRAFTCHECK_QUESTIONS_REVISION });
  });

  it("a confident Jev 'no' on answering early (critical) fails the draft", async () => {
    const { db, project } = await setup();
    const { provider } = fakeProvider({ item_answer_early: noul(0.05) });
    const r = await runDraftCheck(GOOD_INPUT, { db, project, decisions: provider, now: FIXED_NOW });
    expect(item(r, "page.while_write.answer_early")).toMatchObject({ status: "not_met", method: "heuristic" });
    expect(r.verdict).toBe("fail");
    expect(r.labels.join(" ")).toMatch(/"Answer the main question early" is not met/);
  });

  it("a drop-tier answer is withheld and the deterministic result stands", () => {
    const base: ChecklistItem = {
      id: "page.while_write.answer_early",
      section: "while_write",
      label: "Answer the main question early",
      status: "partial",
      method: "heuristic",
      summary: "The first paragraph contains 50% of the words in the target query.",
      evidence: [],
      completeness: null,
      guidance: "g",
      caveat: null,
      links: [],
      manual: null,
      tacticTier: null,
    };
    const out = applyJevToItem(base, { key: "answer_early", itemId: base.id, questionId: "seo.draft.answer_early", noul: 0.5, tier: "drop" }, { provider: "typesafe", model: "m", status: "answered" });
    expect(out.status).toBe("partial");
    expect(out.summary).toMatch(/withheld/);
  });

  it("budget exceeded: deterministic only, labelled, decision records carry reason 'budget'", async () => {
    const { db, project, pid, workspaceId } = await setup();
    const provider: DecisionProvider = {
      name: "typesafe",
      async decide() {
        throw new BudgetExceededError("jev_calls", "Daily jev_calls budget exhausted.");
      },
      async test() {
        return { ok: true, detail: "" };
      },
    };
    const r = await runDraftCheck(GOOD_INPUT, { db, project, decisions: provider, now: FIXED_NOW });
    expect(r.jevUsed).toBe(false);
    expect(r.verdict).toBe("pass");
    expect(item(r, "page.before_write.unique_angle").status).toBe("manual");
    expect(r.labels.join(" ")).toMatch(/Jev budget reached: this project's daily Jev call limit is used up, so this check is deterministic only\./);
    const reasons = await db.all<{ reason_code: string; outcome: string; tier: string | null }>("SELECT reason_code, outcome, tier FROM decision_records WHERE workspace_id = ? AND project_id = ?", workspaceId, pid);
    expect(reasons.length).toBe(5);
    expect(reasons.every((x) => x.reason_code === "budget" && x.outcome === "rejected" && x.tier === null)).toBe(true);
  });

  it("a provider error leaves the check deterministic and labelled", async () => {
    const { db, project } = await setup();
    const provider: DecisionProvider = {
      name: "typesafe",
      async decide() {
        throw new Error("boom");
      },
      async test() {
        return { ok: true, detail: "" };
      },
    };
    const r = await runDraftCheck(GOOD_INPUT, { db, project, decisions: provider, now: FIXED_NOW });
    expect(r.jevUsed).toBe(false);
    expect(r.labels.join(" ")).toMatch(/Jev could not be reached/);
  });

  it("question_version is the hash of each question and matches the revision snapshot", async () => {
    expect(DRAFTCHECK_QUESTIONS_REVISION).toBe(REVISION_SNAPSHOT);
    const versions = await draftQuestionVersions();
    expect(Object.keys(versions).sort()).toEqual([...Object.values(ITEM_QUESTIONS).map((q) => q.questionId), CLAIM_QUESTION_ID].sort());
    for (const [id, q] of Object.entries(DRAFTCHECK_QUESTION_TEMPLATES)) {
      expect(q.type).toBe("noul");
      expect(versions[id]).toBe(await questionVersion(q));
    }
  });
});

describe("draft check verdict rules", () => {
  const it0 = (id: string, status: ChecklistItem["status"], method: ChecklistItem["method"] = "measured") => ({ id, label: id, status, method }) as ChecklistItem;

  it("fail on a measured critical not_met or a blocking flag; needs_review on other flags or flag tier; pass otherwise", () => {
    expect(CRITICAL_ITEMS).toContain("page.publish_check.indexability");
    const ok = [it0("page.while_write.answer_early", "met")];
    expect(decideVerdict(ok, [], { jevFlagTier: false, measurable: true }).verdict).toBe("pass");
    expect(decideVerdict([it0("page.publish_check.indexability", "not_met")], [], { jevFlagTier: false, measurable: true }).verdict).toBe("fail");
    // Not critical, or manual: no fail.
    expect(decideVerdict([it0("page.details.title", "not_met")], [], { jevFlagTier: false, measurable: true }).verdict).toBe("pass");
    expect(decideVerdict([it0("page.publish_check.indexability", "unknown")], [], { jevFlagTier: false, measurable: true }).verdict).toBe("pass");
    const flag = (kind: "unsupported_claim" | "fabricated_testimonial" | "filler" | "guarantee_language") => ({ kind, text: "x", method: "rule" as const, noul: null });
    expect(decideVerdict(ok, [flag("guarantee_language")], { jevFlagTier: false, measurable: true }).verdict).toBe("fail");
    expect(decideVerdict(ok, [flag("fabricated_testimonial")], { jevFlagTier: false, measurable: true }).verdict).toBe("fail");
    expect(decideVerdict(ok, [flag("filler")], { jevFlagTier: false, measurable: true }).verdict).toBe("needs_review");
    expect(decideVerdict(ok, [flag("unsupported_claim")], { jevFlagTier: false, measurable: true }).verdict).toBe("needs_review");
    expect(decideVerdict(ok, [], { jevFlagTier: true, measurable: true }).verdict).toBe("needs_review");
    expect(decideVerdict(ok, [], { jevFlagTier: false, measurable: false }).verdict).toBe("needs_review");
  });
});
