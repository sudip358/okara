/**
 * [A25] Title suggestions keep the page's top Search Console query (writer rule + validator check), the
 * "remove" page action is never auto-verified in writer drafts, and [A23] Jev cost estimates use only the
 * official TypeSafe price (docs.typesafe.ai/models).
 */
import { describe, expect, it } from "vitest";
import type { ProviderCallRecord, WritingRequest } from "@worker/providers/types";
import { createTypeSafeProvider, estimateJevCost, JEV_PRICING_SOURCE, JEV_RATE_VERSION } from "@worker/providers/typesafe";
import { SEO_WRITER_SYSTEM, WRITER_PROMPTS_VERSION } from "@worker/writing/prompts";
import { suggestedTitles, titleTerms, validateDraft } from "@worker/writing/validate";
import { draftWithWriter, titleQueryFor } from "@worker/seo/recommend/draft";
import { unlimitedBudget } from "./helpers/context";
import { fakeWriter, goodWriter, U } from "./fixtures/gsc/site";
import { scenario } from "./fixtures/gsc/scenario";
import { candidatesOf } from "./seo-jev.fixtures";

const EV = [{ id: "ev_1", text: 'GSC 2026-08-31..2026-09-27: query "brass cabinet knob" on /products/brass-knob: 2,000 impressions, 10 clicks.' }];

describe("validator: suggested titles keep the top query terms", () => {
  it("rejects a suggested title that drops a query term; plural, case, accents, and order are free", () => {
    const ok = validateDraft(["Rewrite the snippet [ev_1].", "Title: Solid Brass Cabinet Knobs | ResEx"], ["ev_1"], EV, { titleQuery: "brass cabinet knob" });
    expect(ok.ok).toBe(true);
    const reordered = validateDraft(["Suggested title: Cabinet Knob in Brass"], ["ev_1"], EV, { titleQuery: "Brass Cabinet Knobs" });
    expect(reordered.ok).toBe(true);
    const bad = validateDraft(["Title: Solid Brass Knob | ResEx"], ["ev_1"], EV, { titleQuery: "brass cabinet knob" });
    expect(bad.ok).toBe(false);
    expect(bad.errors.join(" ")).toMatch(/drops terms of the page's top Search Console query "brass cabinet knob": cabinet/);
    expect(validateDraft(["<title>Brass Knob</title>"], ["ev_1"], EV, { titleQuery: "brass cabinet knob" }).ok).toBe(false);
    expect(validateDraft(['Use the new title "Brass Knob" [ev_1].'], ["ev_1"], EV, { titleQuery: "brass cabinet knob" }).ok).toBe(false);
    // Stopwords and generic modifiers ("best", "buy", "near me") need not be repeated.
    expect(validateDraft(["Title: Brass Cabinet Knobs"], ["ev_1"], EV, { titleQuery: "best brass cabinet knob to buy" }).ok).toBe(true);
  });

  it("is additive: no titleQuery, no title check; evidence quotes of the current title are not suggestions", () => {
    expect(validateDraft(["Title: Brass Knob"], ["ev_1"], EV).ok).toBe(true);
    expect(suggestedTitles('Crawled page: title "Solid Brass Cabinet Knob | ResEx"; H1 "Knob".')).toEqual([]);
    expect(suggestedTitles("Title: A\n- New title: B\n<title>C</title>")).toEqual(["A", "B", "C"]);
    // Quoting the current title from the cited evidence is not a suggestion.
    const current = [{ id: "ev_2", text: 'Crawled page: title "Knob Store" (current).' }];
    expect(validateDraft(["Title: Knob Store [ev_2]."], ["ev_2"], current, { titleQuery: "brass cabinet knob" }).ok).toBe(true);
    expect(validateDraft(["Title: Knob Shop [ev_2]."], ["ev_2"], current, { titleQuery: "brass cabinet knob" }).ok).toBe(false);
    expect([...titleTerms("Résumé Knobs & Pulls")]).toEqual(["resume", "knob", "pull"]);
  });

  it("the SEO writer prompt carries the rule; the writer path passes the top query and rejects a title that drops it", async () => {
    expect(WRITER_PROMPTS_VERSION).toBe("writer-prompts-2026-09-30.2");
    expect(SEO_WRITER_SYSTEM).toMatch(/keep every word of TARGET\.top_query/);
    expect(SEO_WRITER_SYSTEM).toMatch(/DECISION\.page_action is "remove"/);

    const s = await scenario({ findings: [] });
    const { candidates } = await candidatesOf(s);
    const c = candidates.find((x) => x.kind === "weak_ctr" && x.target.url === U.knob)!;
    expect(titleQueryFor({ candidate: c, action: "rewrite_title_meta" })).toBe("brass cabinet knob");
    expect(titleQueryFor({ candidate: c, action: "add_section" })).toBeNull();
    const withTitle = (title: string) => (req: WritingRequest) => ({ ...(goodWriter(req) as object), suggested_snippet: `Title: ${title}` });
    const evidence = c.evidence.map((spec, i) => ({ id: `ev_w${i}`, spec }));
    const input = { candidate: c, action: "rewrite_title_meta" as const, tier: "act" as const, intent: null, severityScore: null, evidence, contextDocs: [] };

    const bad = fakeWriter(withTitle("Solid Brass Knob | ResEx"));
    const r1 = await draftWithWriter(s.ctx({ writer: bad }), input);
    expect((bad.requests[0]!.input as { TARGET: { top_query: string } }).TARGET.top_query).toBe("brass cabinet knob");
    expect(r1).toMatchObject({ ok: false, reason: "validation_failed" });

    const good = fakeWriter(withTitle("Solid Brass Cabinet Knob | ResEx"));
    const r2 = await draftWithWriter(s.ctx({ writer: good }), input);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.draft.suggestedSnippet).toBe("Title: Solid Brass Cabinet Knob | ResEx");
  });

  it("a writer draft for a 'remove' page action is never verified and always says human review", async () => {
    const s = await scenario({ findings: [] });
    const { candidates } = await candidatesOf(s);
    const c = candidates.find((x) => x.kind === "declining")!;
    const writer = fakeWriter(goodWriter);
    const r = await draftWithWriter(s.ctx({ writer }), { candidate: c, action: "add_section", tier: "flag", intent: null, severityScore: null, evidence: c.evidence.map((spec, i) => ({ id: `ev_r${i}`, spec })), contextDocs: [], pageAction: "remove" });
    expect((writer.requests[0]!.input as { DECISION: { page_action: string }; REQUIRED_FIELDS: { verified_max: boolean } }).DECISION.page_action).toBe("remove");
    expect((writer.requests[0]!.input as { REQUIRED_FIELDS: { verified_max: boolean } }).REQUIRED_FIELDS.verified_max).toBe(false);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.draft.verified).toBe(false);
      expect(r.draft.action).toMatch(/Removing a page needs human review/);
      expect(r.draft.uncertainty).toBe("high");
    }
  });
});

describe("Jev cost estimate (official TypeSafe price)", () => {
  it("prices only the resolved model on docs.typesafe.ai/models: $0.042 per 1M input tokens, output free", () => {
    expect(JEV_PRICING_SOURCE).toBe("https://docs.typesafe.ai/models");
    expect(estimateJevCost("jev-1.13.0", 1_000_000, 5000)).toEqual({ costUsd: 0.042, costIsEstimate: true, rateVersion: JEV_RATE_VERSION });
    expect(estimateJevCost("jev-1.13.0", 321, 9).costUsd).toBeCloseTo(321 * 0.042e-6, 12);
    expect(estimateJevCost("jev-latest", 1000, 1)).toEqual({ costUsd: null, costIsEstimate: true, rateVersion: null }); // aliases move
    expect(estimateJevCost("jev-2027-01-01", 1000, 1).costUsd).toBeNull();
  });

  it("the adapter records a labelled estimate on success and null (unknown, never $0) on failure", async () => {
    let n = 0;
    const f = (async () => {
      n++;
      if (n === 1) return new Response(JSON.stringify({ model: "jev-1.13.0", answers: { q: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 10_000, output_tokens: 4 } }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ error: "bad" }), { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const calls: ProviderCallRecord[] = [];
    const p = createTypeSafeProvider({ apiKey: "k", fetchImpl: f, calls: { async record(c) { calls.push(c); } }, budget: unlimitedBudget(), maxRetries: 0 });
    await p.decide({ purpose: "t", state: { query: "x" }, questions: { q: { type: "noul", instructions: "Is `query` ok?" } } });
    expect(calls[0]).toMatchObject({ status: "ok", model: "jev-1.13.0", costIsEstimate: true, rateVersion: JEV_RATE_VERSION });
    expect(calls[0]!.costUsd).toBeCloseTo(0.00042, 12);
    await expect(p.decide({ purpose: "t", state: { query: "x" }, questions: { q: { type: "noul", instructions: "Is `query` ok?" } } })).rejects.toBeDefined();
    expect(calls[1]).toMatchObject({ status: "error", costUsd: null });
  });
});
