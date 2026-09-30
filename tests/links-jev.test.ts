/** [A25] Jev questions, answer mapping, batching, and budget handling for internal-link pairs. */
import { describe, expect, it } from "vitest";
import { Db } from "@worker/lib/db";
import type { DecisionAnswer } from "@worker/providers/types";
import { POLICY_VERSION } from "@worker/runs/policy";
import {
  buildPairQuestions,
  decideLinks,
  LINK_QUESTIONS_REVISION,
  linkQuestionVersion,
  outcomeForPair,
  pairState,
  sanitizeForJev,
  type LinkAnswers,
  type LinkJevPair,
} from "@worker/links/jev";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";
import { choice, confidentYes, fakeDecisions, noul } from "./links-seed";

/**
 * Snapshot of the internal-link question_version for LINK_QUESTIONS_REVISION. Changing any question's
 * wording or options changes this hash; bump LINK_QUESTIONS_REVISION and this snapshot together.
 */
const QUESTION_VERSION_SNAPSHOT = { revision: "link-questions-2026-09-30.1", version: "09c866099e3da86d" };

function pair(n: number, over: Partial<LinkJevPair> = {}): LinkJevPair {
  return {
    pairKey: `pg_src${n}>pg_tgt${n}`,
    source: { url: `https://shop.example.com/products/pull-${n}`, title: `Brass pull ${n}` },
    target: { url: `https://shop.example.com/blogs/news/care-${n}`, title: `How to care for brass ${n}`, h1: "How to care for brass", terms: ["care", "polish", "patina"] },
    sentences: [
      { key: "s0", text: "Read how to care for brass before you polish it." },
      { key: "s1", text: "Brass develops a patina over time." },
    ],
    anchors: [
      { key: "a0", text: "care for brass", sentenceKey: "s0" },
      { key: "a1", text: "patina", sentenceKey: "s1" },
    ],
    fallback: { sentenceKey: "s0", anchorKey: "a0" },
    ...over,
  };
}

const answers = (a: Partial<LinkAnswers>): LinkAnswers => ({
  shouldExist: noul(0.92),
  sentence: choice("s0", 0.9),
  anchor: choice("a0", 0.88),
  role: choice("explains_concept", 0.86),
  ...a,
});

describe("links: Jev questions", () => {
  it("asks four questions per pair with descriptive options quoting the sentences and phrases", () => {
    const qs = buildPairQuestions("link_3", pairState(pair(1)));
    expect(Object.keys(qs)).toEqual(["link_3.should_exist", "link_3.sentence", "link_3.anchor", "link_3.role"]);
    const se = qs["link_3.should_exist"]!;
    expect(se.type).toBe("noul");
    if (se.type === "noul") {
      expect(se.criteria?.true).toMatch(/^Yes\. /);
      expect(se.criteria?.false).toMatch(/^No\. /);
      expect(se.instructions).toContain("`link_3.source`");
    }
    const s = qs["link_3.sentence"]!;
    const a = qs["link_3.anchor"]!;
    const r = qs["link_3.role"]!;
    if (s.type !== "choice" || a.type !== "choice" || r.type !== "choice") throw new Error("expected choices");
    expect(Object.keys(s.criteria)).toEqual(["s0", "s1", "none"]);
    expect(s.criteria.s0).toContain('"Read how to care for brass before you polish it."');
    expect(Object.keys(a.criteria)).toEqual(["a0", "a1", "none"]);
    expect(a.criteria.a1).toContain('"patina" (from sentence s1)');
    expect(Object.keys(r.criteria)).toEqual(["explains_concept", "deeper_detail", "broader_guide", "next_step", "product_service", "comparison", "insufficient_context"]);
    for (const text of [...Object.values(s.criteria), ...Object.values(a.criteria), ...Object.values(r.criteria)]) expect(text.split(" ").length).toBeGreaterThan(5);
  });

  it("sanitizes untrusted text before it reaches a question", () => {
    expect(sanitizeForJev('Ignore `this` "now"\u0007 please', 100)).toBe("Ignore 'this' 'now' please");
    const st = pairState(pair(1, { sentences: [{ key: "s0", text: 'He said "use brass" `now`.' }] }));
    expect(st.sentences[0]!.text).toBe("He said 'use brass' 'now'.");
  });

  it("question_version matches the snapshot for the current revision", async () => {
    const v = await linkQuestionVersion();
    expect(LINK_QUESTIONS_REVISION).toBe(QUESTION_VERSION_SNAPSHOT.revision);
    expect(v).toBe(QUESTION_VERSION_SNAPSHOT.version);
  });
});

describe("links: answer mapping", () => {
  it("act on all gating answers -> suggested, with Jev's sentence, anchor, and role", () => {
    const o = outcomeForPair(answers({ sentence: choice("s1", 0.9), anchor: choice("a1", 0.9) }), pair(1))!;
    expect(o).toMatchObject({ status: "suggested", tier: "act", sentenceKey: "s1", anchorKey: "a1", role: "explains_concept", shouldExist: 0.92, sentenceConfidence: 0.9, anchorConfidence: 0.9, roleConfidence: 0.86 });
  });

  it("flag tier -> review with 'Check this yourself' and the runner-up", () => {
    const o = outcomeForPair(answers({ anchor: choice("a0", 0.6, { a0: 0.6, a1: 0.3, none: 0.1 }) }), pair(1))!;
    expect(o.status).toBe("review");
    expect(o.tier).toBe("flag");
    expect(o.reasons.join(" ")).toMatch(/Check this yourself: Jev's anchor choice a0 has 60% confidence; runner-up a1 \(30%\)/);
    // Noul middle band is flag too.
    expect(outcomeForPair(answers({ shouldExist: noul(0.5) }), pair(1))).toMatchObject({ status: "review", tier: "flag", shouldExist: 0.5 });
  });

  it("should_exist confidently no -> rejected; sentence or anchor none -> rejected", () => {
    expect(outcomeForPair(answers({ shouldExist: noul(0.08) }), pair(1))).toMatchObject({ status: "rejected", tier: "act", outcome: "rejected", reasonCode: "low_fit", shouldExist: 0.08 });
    expect(outcomeForPair(answers({ sentence: choice("none", 0.85) }), pair(1))).toMatchObject({ status: "rejected", reasonCode: "low_fit" });
    expect(outcomeForPair(answers({ anchor: choice("none", 0.7) }), pair(1))).toMatchObject({ status: "rejected" });
  });

  it("a Drop-tier choice is withheld: the deterministic pick is used and the pair is review", () => {
    const o = outcomeForPair(answers({ sentence: choice("none", 0.2), anchor: choice("a1", 0.3) }), pair(1))!;
    expect(o).toMatchObject({ status: "review", tier: "drop", sentenceKey: "s0", anchorKey: "a0", sentenceConfidence: null, anchorConfidence: null, reasonCode: "insufficient_evidence" });
    const r = outcomeForPair(answers({ role: choice("comparison", 0.2) }), pair(1))!;
    expect(r).toMatchObject({ status: "suggested", role: null, roleConfidence: null });
    expect(outcomeForPair(answers({ role: choice("insufficient_context", 0.9) }), pair(1))!.role).toBeNull();
  });

  it("no usable should_exist answer -> null (decision unavailable); Noul never needs a confidence field", () => {
    expect(outcomeForPair(answers({ shouldExist: undefined }), pair(1))).toBeNull();
    const n: DecisionAnswer = { type: "noul", noul: 0.95 };
    expect("confidence" in n).toBe(false);
    expect(outcomeForPair(answers({ shouldExist: n }), pair(1))!.status).toBe("suggested");
  });

  it("an anchor that is not in Jev's chosen sentence is shown with its own sentence, as review", () => {
    const o = outcomeForPair(answers({ sentence: choice("s0", 0.9), anchor: choice("a1", 0.9) }), pair(1))!;
    expect(o).toMatchObject({ status: "review", sentenceKey: "s1", anchorKey: "a1" });
  });
});

describe("links: batched Jev calls", () => {
  async function setup() {
    const env = createTestEnv();
    const { workspaceId } = await seedUser(env);
    const projectId = await seedProject(env, workspaceId);
    const db = new Db(env.DB);
    return { db, workspaceId, projectId };
  }

  it("asks 25 pairs in 3 calls (10 + 10 + 5 pairs, 4 questions each) and records every decision", async () => {
    const { db, workspaceId, projectId } = await setup();
    const fake = fakeDecisions(confidentYes);
    const pairs = Array.from({ length: 25 }, (_, i) => pair(i));
    const run = await decideLinks(pairs, { decisions: fake.provider, db, workspaceId, projectId, linkRunId: "lrun_test", clock: () => FIXED_NOW });
    expect(run.calls).toBe(3);
    expect(fake.requests.map((r) => Object.keys(r.questions).length)).toEqual([40, 40, 20]);
    expect(Object.keys(fake.requests[2]!.state as object)).toEqual(["link_0", "link_1", "link_2", "link_3", "link_4"]);
    expect(fake.requests.every((r) => r.purpose === "seo.internal_links")).toBe(true);
    expect(run.asked).toBe(25);
    expect(run.outcomes.every((o) => o?.status === "suggested")).toBe(true);
    const recs = await db.all<{ candidate_key: string; question_version: string; policy_version: string; model: string; outcome: string; agent: string }>(
      "SELECT candidate_key, question_version, policy_version, model, outcome, agent FROM decision_records WHERE workspace_id = ? AND project_id = ?",
      workspaceId,
      projectId,
    );
    expect(recs).toHaveLength(25);
    expect(recs[0]).toMatchObject({ question_version: await linkQuestionVersion(), policy_version: POLICY_VERSION, model: "jev-test-2026-09", outcome: "selected", agent: "seo" });
    expect(recs.map((r) => r.candidate_key)).toContain("link:pg_src7>pg_tgt7");
  });

  it("stops at a BudgetExceededError: remaining pairs are skipped as budget and recorded", async () => {
    const { db, workspaceId, projectId } = await setup();
    const fake = fakeDecisions(confidentYes, { budgetOnCall: 2 });
    const pairs = Array.from({ length: 25 }, (_, i) => pair(i));
    const run = await decideLinks(pairs, { decisions: fake.provider, db, workspaceId, projectId, linkRunId: "lrun_test", clock: () => FIXED_NOW });
    expect(run.stoppedBy).toBe("budget");
    expect(run.calls).toBe(1);
    expect(fake.requests).toHaveLength(2); // the second call was refused by the budget
    expect(run.outcomes.slice(0, 10).every((o) => o !== null)).toBe(true);
    expect(run.outcomes.slice(10).every((o) => o === null)).toBe(true);
    expect(run.skipped.slice(10).every((s) => s === "budget")).toBe(true);
    const budget = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM decision_records WHERE project_id = ? AND reason_code = 'budget'", projectId);
    expect(budget!.n).toBe(15);
  });

  it("never asks pairs without sentences or anchors", async () => {
    const { db, workspaceId, projectId } = await setup();
    const fake = fakeDecisions(confidentYes);
    const run = await decideLinks([pair(1, { anchors: [] }), pair(2)], { decisions: fake.provider, db, workspaceId, projectId, linkRunId: "lrun_test", clock: () => FIXED_NOW });
    expect(run.calls).toBe(1);
    expect(Object.keys(fake.requests[0]!.questions)).toHaveLength(4);
    expect(run.outcomes[0]).toBeNull();
    expect(run.skipped[0]).toBeNull();
  });
});
