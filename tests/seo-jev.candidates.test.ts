/**
 * [A23] Each new Jev question's candidate path through the real decision code with a fake
 * DecisionProvider (Act / Flag / Drop), plus the deterministic prefilters (stale years, schema/price),
 * mixed intent routed to review, and the query relevance pre-filter with its cache.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Db } from "@worker/lib/db";
import type { GscRow } from "@worker/providers/types";
import { QUESTION } from "@worker/seo/questions";
import { buildCandidates, type Candidate } from "@worker/seo/recommend/candidates";
import { evaluateContent, evaluateGate, evaluateTechnical } from "@worker/seo/recommend/decide";
import { draftDeterministic, REMOVE_REVIEW_TEXT } from "@worker/seo/recommend/draft";
import { detectStaleYears } from "@worker/seo/recommend/freshness";
import { generateSeoRecommendations } from "@worker/seo/recommend/generate";
import { loadCandidateInputs } from "@worker/seo/recommend/inputs";
import { computePriority, type PriorityInputs } from "@worker/seo/recommend/priority";
import { prejudgeQueryRelevance } from "@worker/seo/recommend/relevance";
import { offerPriceCheck, schemaConflicts } from "@worker/seo/recommend/schema-match";
import { choice, DEFAULT_GSC_DATA, fakeDecisions, noul, QP_CURRENT, QP_PREVIOUS, U } from "./fixtures/gsc/site";
import { scenario } from "./fixtures/gsc/scenario";
import { answers, candidatesOf, judgeWith, patchSnapshot } from "./seo-jev.fixtures";

const row = (keys: string[], clicks: number, impressions: number, position: number): GscRow => ({ keys, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position });
const kind = (cs: Candidate[], k: Candidate["kind"], url?: string) => cs.find((c) => c.kind === k && (!url || c.target.url === url))!;
const draftOf = (c: Candidate, action: Parameters<typeof draftDeterministic>[0]["action"], tier: "act" | "flag", pageAction: "remove" | null = null) =>
  draftDeterministic({ candidate: c, action, tier, intent: null, severityScore: null, evidence: c.evidence.map((spec, i) => ({ id: `ev_t${i}`, spec })), contextDocs: [], pageAction });

// ------------------------------------------------------------------ thin content
describe("seo.thin_content confirms SEO-CONTENT-THIN", () => {
  const THIN = { rule: "SEO-CONTENT-THIN", severity: "minor", url: U.guide, detail: "Main content has about 40 words (threshold 150).", evidence: { wordCount: 40, pageType: "article" } };

  async function thinCase() {
    const s = await scenario({ findings: [THIN] });
    await patchSnapshot(s, U.guide, { word_count: 40 });
    const { candidates } = await candidatesOf(s);
    return { s, c: candidates.find((c) => c.issueType === "technical:SEO-CONTENT-THIN")! };
  }

  it("asks the thin question (with word count) alongside severity and page action", async () => {
    const { s, c } = await thinCase();
    const { request } = await judgeWith(s, c, answers({ [QUESTION.thinContent]: noul(0.92) }));
    expect(Object.keys(request!.questions).sort()).toEqual([QUESTION.issueSeverity, QUESTION.pageAction, `${QUESTION.thinContent}#e1`].sort());
    expect((request!.state as { thin_pages: { e1: { word_count: number; url: string } } }).thin_pages.e1).toMatchObject({ word_count: 40, url: U.guide });
  });

  it("act yes -> selected; confident no -> rejected low_fit; middle -> Flag; missing -> deterministic finding kept", async () => {
    const { s, c } = await thinCase();
    const yes = evaluateTechnical(c, (await judgeWith(s, c, answers({ [QUESTION.thinContent]: noul(0.92) }))).judgment);
    expect(yes).toMatchObject({ outcome: "selected", tier: "act" });
    const no = evaluateTechnical(c, (await judgeWith(s, c, answers({ [QUESTION.thinContent]: noul(0.08) }))).judgment);
    expect(no).toMatchObject({ outcome: "rejected", reasonCode: "low_fit" });
    const mid = evaluateTechnical(c, (await judgeWith(s, c, answers({ [QUESTION.thinContent]: noul(0.5) }))).judgment);
    expect(mid).toMatchObject({ outcome: "selected", tier: "flag" });
    const drop = evaluateTechnical(c, (await judgeWith(s, c, answers({ [QUESTION.thinContent]: undefined }))).judgment);
    expect(drop.outcome).toBe("selected");
    expect(drop.warnings.join(" ")).toMatch(/Thin-content confirmation unavailable/);
  });

  it("page action keep rejects; remove is unverified with human-review wording", async () => {
    const { s, c } = await thinCase();
    const keep = evaluateTechnical(c, (await judgeWith(s, c, answers({ [QUESTION.thinContent]: noul(0.9), [QUESTION.pageAction]: choice("keep", 0.9) }))).judgment);
    expect(keep).toMatchObject({ outcome: "rejected", reasonCode: "low_fit" });
    const rm = evaluateTechnical(c, (await judgeWith(s, c, answers({ [QUESTION.thinContent]: noul(0.9), [QUESTION.pageAction]: choice("remove", 0.9) }))).judgment);
    expect(rm).toMatchObject({ outcome: "selected", tier: "flag", pageAction: "remove" });
    const d = draftOf(c, rm.action, "flag", "remove");
    expect(d.ok && d.draft.verified).toBe(false);
    expect(d.ok && d.draft.action).toContain(REMOVE_REVIEW_TEXT);
    expect(d.ok && d.draft.effort).toBe("high");
  });

  it("a site-scope thin group asks one keyed question per example page (up to 3)", async () => {
    const findings = [U.guide, U.sconces, U.home, U.hardware].map((url) => ({ ...THIN, url, evidence: { wordCount: 40, pageType: "other" } }));
    const s = await scenario({ findings });
    const { candidates } = await candidatesOf(s);
    const c = candidates.find((x) => x.issueType === "technical:SEO-CONTENT-THIN")!;
    expect(c.scope).toBe("site");
    const { request } = await judgeWith(s, c, answers({}));
    expect(Object.keys(request!.questions).filter((k) => k.startsWith(QUESTION.thinContent))).toEqual(["e1", "e2", "e3"].map((k) => `${QUESTION.thinContent}#${k}`));
  });

  it("end to end: a confident 'not thin' produces no recommendation and is logged with its question id", async () => {
    const { s } = await thinCase();
    const ctx = s.ctx({ decisions: fakeDecisions(answers({ [QUESTION.thinContent]: noul(0.05) })) });
    await generateSeoRecommendations(ctx, { candidateConfig: { minImpressions: 1e9, internalLinkMinImpressions: 1e9, decliningMinPrevClicks: 1e9, coverageGapMinQueryImpressions: 1e9, maxEngineQueries: 0, maxDuplicatePairs: 0 } });
    const recs = await ctx.db.all<{ issue_type: string }>("SELECT issue_type FROM recommendations WHERE project_id = ?", s.projectId);
    expect(recs.some((r) => r.issue_type === "technical:SEO-CONTENT-THIN")).toBe(false);
    const dec = await ctx.db.all<{ question_id: string; answer_json: string; outcome: string; reason_code: string }>("SELECT question_id, answer_json, outcome, reason_code FROM decision_records WHERE project_id = ? AND question_id = ?", s.projectId, QUESTION.thinContent);
    expect(dec).toHaveLength(1);
    expect(dec[0]).toMatchObject({ outcome: "rejected", reason_code: "low_fit" });
    expect(JSON.parse(dec[0]!.answer_json)).toMatchObject({ key: `${QUESTION.thinContent}#e1`, answer: { type: "noul", noul: 0.05 } });
  });
});

// ------------------------------------------------------------------ page action (declining)
describe("seo.page_action on declining pages", () => {
  it("keep rejects, merge consolidates, remove is unverified and routed to review", async () => {
    const s = await scenario({ findings: [] });
    const { candidates } = await candidatesOf(s);
    const c = kind(candidates, "declining");
    const { request } = await judgeWith(s, c, answers({}));
    expect(Object.keys(request!.questions)).toContain(QUESTION.pageAction);
    const ev = async (a: ReturnType<typeof choice>) => evaluateContent(c, (await judgeWith(s, c, answers({ [QUESTION.pageAction]: a }))).judgment);
    expect(await ev(choice("keep", 0.9))).toMatchObject({ outcome: "rejected", reasonCode: "low_fit" });
    expect(await ev(choice("merge", 0.9))).toMatchObject({ outcome: "selected", action: "consolidate_duplicate" });
    expect(await ev(choice("update", 0.9))).toMatchObject({ outcome: "selected", action: "add_section", pageAction: "update" });
    const rm = await ev(choice("remove", 0.9));
    expect(rm).toMatchObject({ outcome: "selected", tier: "flag", pageAction: "remove" });
    const d = draftOf(c, rm.action, "flag", "remove");
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.draft.verified).toBe(false);
      expect(d.draft.uncertainty).toBe("high");
      expect(d.draft.action).toMatch(/Removing a page needs human review/);
    }
  });
});

// ------------------------------------------------------------------ schema-content match
describe("seo.schema_content_match + deterministic checks", () => {
  it("deterministic conflicts and the Offer-price check (skipped when a side is unavailable)", () => {
    expect(schemaConflicts({ pageType: "article", jsonLdTypes: ["Article", "Product"], headings: [], h1: "Guide" })).toEqual(["product_on_article"]);
    expect(schemaConflicts({ pageType: "product", jsonLdTypes: ["BlogPosting"], headings: [], h1: "Knob" })).toEqual(["article_on_product"]);
    expect(schemaConflicts({ pageType: "landing", jsonLdTypes: ["FAQPage"], headings: ["Shipping"], h1: "Help" })).toEqual(["faq_without_questions"]);
    expect(schemaConflicts({ pageType: "landing", jsonLdTypes: ["FAQPage"], headings: ["How long does shipping take?"], h1: "Help" })).toEqual([]);
    expect(offerPriceCheck([129], "Solid brass knob, now $129.00 with free shipping.").status).toBe("match");
    expect(offerPriceCheck([129], "Solid brass knob, now $99.00.")).toMatchObject({ status: "mismatch", visiblePrices: [99] });
    expect(offerPriceCheck([1299], "Price: 1.299,00 €").status).toBe("match");
    expect(offerPriceCheck(null, "$99").status).toBe("skipped");
    expect(offerPriceCheck([129], "No price shown here.").status).toBe("skipped");
  });

  it("confident mismatch -> fix_structured_data (Act); confident match -> low_fit; middle -> Flag; missing -> insufficient evidence", async () => {
    const s = await scenario({ findings: [] });
    await patchSnapshot(s, U.guide, { jsonld_types_json: JSON.stringify(["Article", "Product"]) });
    const { candidates } = await candidatesOf(s);
    const c = kind(candidates, "schema_mismatch");
    expect(c).toMatchObject({ target: { url: U.guide }, severity: "moderate", jevDependent: true });
    expect(c.priority.severity).toBeGreaterThan(0);
    const { request } = await judgeWith(s, c, answers({}));
    expect(Object.keys(request!.questions)).toEqual([QUESTION.schemaContentMatch]);
    expect((request!.state as { page: { structured_data_types: string[] } }).page.structured_data_types).toEqual(["Article", "Product"]);
    const ev = async (v: number | undefined) => evaluateGate(c, (await judgeWith(s, c, answers({ [QUESTION.schemaContentMatch]: v === undefined ? undefined : noul(v) }))).judgment);
    expect(await ev(0.1)).toMatchObject({ outcome: "selected", tier: "act", action: "fix_structured_data", decisionFields: { question: QUESTION.schemaContentMatch, noul: 0.1 } });
    expect(await ev(0.95)).toMatchObject({ outcome: "rejected", reasonCode: "low_fit" });
    expect(await ev(0.5)).toMatchObject({ outcome: "selected", tier: "flag" });
    expect(await ev(undefined)).toMatchObject({ outcome: "rejected", reasonCode: "insufficient_evidence", tier: "drop" });
    const d = draftOf(c, "fix_structured_data", "act");
    expect(d.ok && d.draft.action).toMatch(/Product or Offer markup on a page classified as an article/);
  });
});

// ------------------------------------------------------------------ title / meta vs top query (weak CTR)
describe("seo.title_matches_query / seo.meta_matches_query strengthen weak-CTR candidates", () => {
  it("asks both with the top query; a confident 'no' makes the action rewrite_title_meta", async () => {
    const s = await scenario({ findings: [] });
    const { candidates } = await candidatesOf(s);
    const c = kind(candidates, "weak_ctr", U.knob);
    const { request, judgment } = await judgeWith(s, c, answers({ [QUESTION.titleMatchesQuery]: noul(0.1), [QUESTION.actionChoice]: choice("add_section", 0.9) }));
    expect(Object.keys(request!.questions)).toEqual(expect.arrayContaining([QUESTION.titleMatchesQuery, QUESTION.metaMatchesQuery]));
    expect((request!.state as { top_query: string }).top_query).toBe("brass cabinet knob");
    expect(evaluateContent(c, judgment)).toMatchObject({ outcome: "selected", action: "rewrite_title_meta" });

    // no_action from action_choice: the confident title "no" still carries the candidate (headline = that Noul).
    const rescued = evaluateContent(c, (await judgeWith(s, c, answers({ [QUESTION.titleMatchesQuery]: noul(0.1), [QUESTION.actionChoice]: choice("no_action", 0.9) }))).judgment);
    expect(rescued).toMatchObject({ outcome: "selected", action: "rewrite_title_meta", tier: "act", decisionFields: { question: QUESTION.titleMatchesQuery, noul: 0.1 } });

    // Both confidently match: a title rewrite is shown as Check this yourself.
    const aligned = evaluateContent(c, (await judgeWith(s, c, answers({ [QUESTION.titleMatchesQuery]: noul(0.95), [QUESTION.metaMatchesQuery]: noul(0.9) }))).judgment);
    expect(aligned).toMatchObject({ outcome: "selected", action: "rewrite_title_meta", tier: "flag" });

    // Middle band / missing answers change nothing.
    expect(evaluateContent(c, (await judgeWith(s, c, answers({ [QUESTION.titleMatchesQuery]: noul(0.5), [QUESTION.metaMatchesQuery]: undefined }))).judgment)).toMatchObject({ outcome: "selected", tier: "act" });
  });

  it("omits the meta question when the page has no meta description", async () => {
    const s = await scenario({ findings: [] });
    await patchSnapshot(s, U.knob, { meta_description: null });
    const { candidates } = await candidatesOf(s);
    const { request } = await judgeWith(s, kind(candidates, "weak_ctr", U.knob), answers({}));
    expect(Object.keys(request!.questions)).toContain(QUESTION.titleMatchesQuery);
    expect(Object.keys(request!.questions)).not.toContain(QUESTION.metaMatchesQuery);
  });
});

// ------------------------------------------------------------------ topic coverage
describe("seo.covers_topic (one Noul per topic) on coverage gaps", () => {
  it("GSC gap queries and matched engine queries become topics; aggregation drives the outcome", async () => {
    const s = await scenario({ findings: [], engineQueries: ["solid brass cabinet knob care"] });
    const { candidates } = await candidatesOf(s);
    const c = kind(candidates, "coverage_gap", U.knob);
    expect(c.coverageQueries).toEqual(["how to clean unlacquered brass", "solid brass cabinet knob care"]);
    const { request } = await judgeWith(s, c, answers({}));
    expect(Object.keys(request!.questions).filter((k) => k.startsWith(QUESTION.coversTopic))).toEqual([`${QUESTION.coversTopic}#t1`, `${QUESTION.coversTopic}#t2`]);
    expect((request!.state as { topics: Record<string, string> }).topics).toEqual({ t1: "how to clean unlacquered brass", t2: "solid brass cabinet knob care" });

    const ev = async (t1: number | undefined, t2: number | undefined, action = choice("add_section", 0.9)) =>
      evaluateContent(c, (await judgeWith(s, c, answers({ [`${QUESTION.coversTopic}#t1`]: t1 === undefined ? undefined : noul(t1), [`${QUESTION.coversTopic}#t2`]: t2 === undefined ? undefined : noul(t2), [QUESTION.actionChoice]: action }))).judgment);
    expect(await ev(0.95, 0.9)).toMatchObject({ outcome: "rejected", reasonCode: "low_fit" }); // covered
    expect(await ev(0.05, 0.9)).toMatchObject({ outcome: "selected", tier: "act" }); // partial
    expect(await ev(0.05, 0.1, choice("no_action", 0.9))).toMatchObject({ outcome: "selected", action: "add_section", decisionFields: { question: QUESTION.coversTopic, noul: 0.05 } }); // missing
    expect(await ev(0.5, 0.6)).toMatchObject({ outcome: "selected", tier: "flag" }); // uncertain
    expect(await ev(undefined, undefined)).toMatchObject({ outcome: "selected", tier: "act" }); // no answers: action_choice decides
  });
});

// ------------------------------------------------------------------ freshness
describe("freshness: stale-year detector + seo.outdated_information", () => {
  it("detects stale years in title / H1 / first paragraph and excludes historical context", () => {
    const today = "2026-09-30";
    const years = (title: string | null, first: string | null = null) => detectStaleYears({ title, h1: null, firstParagraph: first }, today).map((r) => r.year);
    expect(years("Best Brass Knobs of 2024")).toEqual([2024]);
    expect(years("Brass Knob Trends 2025")).toEqual([]); // not two years old yet
    expect(years(null, "Since 1998 we have made brass hardware.")).toEqual([]);
    expect(years(null, "Est. 1987. Family owned.")).toEqual([]);
    expect(years(null, "Established in 2001 in Ohio.")).toEqual([]);
    expect(years(null, "© 2019 Residence Example")).toEqual([]);
    expect(years(null, "Founded 2003, we ship worldwide.")).toEqual([]);
    expect(years(null, "Popular in the 1990s and back again.")).toEqual([]);
    expect(years("Model X2019 cabinet knob")).toEqual([]);
    expect(years(null, "Since 1998 we have polished brass. Prices below were checked in 2022.")).toEqual([2022]);
    const refs = detectStaleYears({ title: "Guide (2021)", h1: "Updated for 2023", firstParagraph: null }, today);
    expect(refs.map((r) => [r.year, r.field])).toEqual([
      [2021, "title"],
      [2023, "h1"],
    ]);
  });

  it("Act yes -> selected with code-owned text; no -> low_fit; middle -> Flag; today's date is in state", async () => {
    const s = await scenario({ findings: [] });
    await patchSnapshot(s, U.guide, { title: "How to Clean Unlacquered Brass (2021 Guide)", first_paragraph: "Since 1998 we have polished brass. Prices below were checked in 2022." });
    const { candidates } = await candidatesOf(s);
    const c = kind(candidates, "freshness", U.guide);
    expect(c.metrics.years).toBe("2021, 2022");
    const { request } = await judgeWith(s, c, answers({}));
    expect(Object.keys(request!.questions)).toEqual([QUESTION.outdatedInformation]);
    expect(request!.state).toMatchObject({ today: "2026-09-30" });
    expect((request!.state as { page: { dated_references: string[] } }).page.dated_references.join(" ")).toMatch(/2021.*2022/);
    const ev = async (v: number) => evaluateGate(c, (await judgeWith(s, c, answers({ [QUESTION.outdatedInformation]: noul(v) }))).judgment);
    expect(await ev(0.9)).toMatchObject({ outcome: "selected", tier: "act" });
    expect(await ev(0.1)).toMatchObject({ outcome: "rejected", reasonCode: "low_fit" });
    expect(await ev(0.55)).toMatchObject({ outcome: "selected", tier: "flag" });
    const d = draftOf(c, null, "act");
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.draft.action).toMatch(/Review the dated references on .*\(2021, 2022\)/);
  });

  it("end to end: the saved recommendation shows the Noul under its real field name", async () => {
    const s = await scenario({ findings: [], gsc: null });
    await patchSnapshot(s, U.guide, { title: "How to Clean Unlacquered Brass (2021 Guide)" });
    const ctx = s.ctx({ decisions: fakeDecisions(answers({ [QUESTION.outdatedInformation]: noul(0.9), [QUESTION.pageOverlap]: noul(0.05) })) });
    await generateSeoRecommendations(ctx, { maxJudged: 20 });
    const r = await ctx.db.first<{ issue_type: string; decision_label: string; decision_score_json: string }>("SELECT issue_type, decision_label, decision_score_json FROM recommendations WHERE project_id = ? AND issue_type = 'freshness_outdated'", s.projectId);
    expect(r).toMatchObject({ decision_label: "act" });
    expect(JSON.parse(r!.decision_score_json)).toEqual({ question: QUESTION.outdatedInformation, noul: 0.9 });
  });
});

// ------------------------------------------------------------------ answer clarity (AEO)
describe("seo.answer_is_direct on question-like top queries", () => {
  it("confident 'no' -> improve_intro_answer (Act); 'yes' -> low_fit; middle -> Flag", async () => {
    const data = { ...DEFAULT_GSC_DATA, qp: { current: [...QP_CURRENT, row(["how to clean unlacquered brass", U.guide], 20, 800, 6)], previous: QP_PREVIOUS } };
    const s = await scenario({ findings: [], gsc: data });
    await patchSnapshot(s, U.guide, { first_paragraph: "Brass has been used for centuries in homes around the world." });
    const { candidates } = await candidatesOf(s);
    const c = kind(candidates, "answer_clarity", U.guide);
    expect(c.query).toBe("how to clean unlacquered brass");
    const { request } = await judgeWith(s, c, answers({}));
    expect(Object.keys(request!.questions)).toEqual([QUESTION.answerIsDirect]);
    expect(request!.state).toMatchObject({ top_query: "how to clean unlacquered brass", page: { opening: "Brass has been used for centuries in homes around the world." } });
    const ev = async (v: number) => evaluateGate(c, (await judgeWith(s, c, answers({ [QUESTION.answerIsDirect]: noul(v) }))).judgment);
    expect(await ev(0.1)).toMatchObject({ outcome: "selected", tier: "act", action: "improve_intro_answer" });
    expect(await ev(0.9)).toMatchObject({ outcome: "rejected", reasonCode: "low_fit" });
    expect(await ev(0.4)).toMatchObject({ outcome: "selected", tier: "flag" });
  });
});

// ------------------------------------------------------------------ mixed intent
describe("seo.query_intent `mixed` is routed to review", () => {
  it("caps the tier at Flag, never gates intent/page fit, and the intent state carries brand terms, country, language", async () => {
    const s = await scenario({ findings: [] });
    const { candidates } = await candidatesOf(s);
    const c = candidates.find((x) => x.kind === "striking_distance" && x.query === "cabinet hardware")!;
    const { request, judgment } = await judgeWith(s, c, answers({ [QUESTION.queryIntent]: choice("mixed", 0.9), [QUESTION.intentPageFit]: choice("mismatch", 0.95) }));
    expect(request!.state).toMatchObject({ country: "US", language: "en", brand_terms: { self: ["residence example", "resex"], competitors: ["brass co"] } });
    const ev = evaluateContent(c, judgment);
    expect(ev).toMatchObject({ outcome: "selected", tier: "flag", intent: "mixed" });
    expect(ev.warnings.join(" ")).toMatch(/mixed; routed to human review/);
    // A decisive intent with a confident mismatch still rejects (unchanged behaviour).
    const decisive = evaluateContent(c, (await judgeWith(s, c, answers({ [QUESTION.intentPageFit]: choice("mismatch", 0.95) }))).judgment);
    expect(decisive).toMatchObject({ outcome: "rejected", reasonCode: "low_fit" });
  });
});

// ------------------------------------------------------------------ query relevance pre-filter
describe("seo.query_relevance pre-filter", () => {
  const relevance = answers({
    [QUESTION.queryRelevance]: (req, id) => {
      const q = (req.state as { queries: Record<string, string> }).queries[id.split("#q")[1] ? `q${id.split("#q")[1]}` : ""];
      return q === "wall sconces" ? noul(0.05) : q === "brass sconces" ? noul(0.5) : noul(0.95);
    },
  });

  it("drops confident 'no' queries from candidates, flags the middle band, and caches for 7 days", async () => {
    const s = await scenario({ findings: [] });
    const inputs = await loadCandidateInputs(s.ctx());
    const jev = fakeDecisions(relevance);
    const rel = await prejudgeQueryRelevance(s.ctx({ decisions: jev }), inputs);
    expect(jev.requests).toHaveLength(1);
    expect(Object.keys(jev.requests[0]!.questions).length).toBeLessThanOrEqual(50);
    expect(jev.requests[0]!.state).toMatchObject({ business: { name: "Residence Example", products: "Solid brass cabinet hardware and lighting." } });
    expect([...rel.filter!.dropped]).toEqual(["wall sconces"]);
    expect([...rel.filter!.flagged]).toEqual(["brass sconces"]);

    const filtered = buildCandidates({ ...inputs, queryFilter: rel.filter });
    expect(filtered.some((c) => c.query === "wall sconces")).toBe(false);
    const flagged = filtered.find((c) => c.kind === "striking_distance" && c.query === "brass sconces")!;
    expect(flagged.tierCap).toBe("flag");
    expect(evaluateContent(flagged, (await judgeWith(s, flagged, answers({}))).judgment)).toMatchObject({ outcome: "selected", tier: "flag" });
    expect(buildCandidates(inputs).some((c) => c.query === "wall sconces")).toBe(true); // without the filter it is a candidate

    // Decision records: one per query, the dropped one rejected low_fit.
    const db = new Db(s.env.DB);
    const rows = await db.all<{ candidate_key: string; outcome: string; reason_code: string | null; question_version: string }>(
      "SELECT candidate_key, outcome, reason_code, question_version FROM decision_records WHERE project_id = ? AND question_id = ?",
      s.projectId,
      QUESTION.queryRelevance,
    );
    expect(rows.find((r) => r.candidate_key === "qrel:wall sconces")).toMatchObject({ outcome: "rejected", reason_code: "low_fit" });

    // Second run: everything from the cache, no new call, same result.
    const jev2 = fakeDecisions(relevance);
    const again = await prejudgeQueryRelevance(s.ctx({ decisions: jev2 }), inputs);
    expect(jev2.requests).toHaveLength(0);
    expect(again.cached).toBe(rows.length);
    expect([...again.filter!.dropped]).toEqual(["wall sconces"]);

    // Eight days later the cache has expired.
    const jev3 = fakeDecisions(relevance);
    await prejudgeQueryRelevance(s.ctx({ decisions: jev3, clock: () => new Date("2026-10-08T12:00:00Z") }), inputs);
    expect(jev3.requests).toHaveLength(1);
  });

  it("without Jev nothing is filtered", async () => {
    const s = await scenario({ findings: [] });
    const inputs = await loadCandidateInputs(s.ctx());
    expect((await prejudgeQueryRelevance(s.ctx(), inputs)).filter).toBeNull();
  });
});

// ------------------------------------------------------------------ priority
describe("priority is unchanged; reference tiers are never used", () => {
  it("new kinds use the existing formula inputs only", async () => {
    const s = await scenario({ findings: [] });
    await patchSnapshot(s, U.guide, { title: "Guide (2021)", jsonld_types_json: JSON.stringify(["Product"]) });
    const { candidates } = await candidatesOf(s);
    const keys: Array<keyof PriorityInputs> = ["impressions", "clicks", "totalImpressions", "totalClicks", "severity", "reach", "effort"];
    for (const c of candidates) expect(Object.keys(c.priority).sort()).toEqual([...keys].sort());
    expect(candidates.some((c) => c.kind === "freshness")).toBe(true);
    expect(candidates.some((c) => c.kind === "schema_mismatch")).toBe(true);
    for (const f of ["priority.ts", "candidates.ts", "decide.ts", "generate.ts"]) {
      expect(readFileSync(`src/worker/seo/recommend/${f}`, "utf8")).not.toMatch(/tacticTier/);
    }
    const i: PriorityInputs = { impressions: 100, clicks: 5, totalImpressions: 1000, totalClicks: 50, severity: null, reach: null, effort: "medium" };
    expect(computePriority(i, "act")).toBe(Math.round(100 * Math.sqrt(0.1) * 0.85 * 100) / 100);
  });
});

// ------------------------------------------------------------------ sitemap health rules
describe("sitemap-health rules map to an explicit action and quote the finding's fix", () => {
  it("all six rules -> fix_canonical_or_indexing; grouped findings become one site candidate", async () => {
    const { defaultTechnicalAction, findingFixText, sitemapActionText } = await import("@worker/seo/recommend/candidates");
    for (const id of ["SEO-SITEMAP-URL-ERROR", "SEO-SITEMAP-URL-REDIRECT", "SEO-SITEMAP-URL-NOINDEX", "SEO-SITEMAP-URL-NONCANONICAL", "SEO-SITEMAP-LASTMOD-INVALID", "SEO-SITEMAP-OFFHOST"]) {
      expect(defaultTechnicalAction(id), id).toBe("fix_canonical_or_indexing");
    }
    expect(findingFixText("Listed in the sitemap but returned HTTP 404. Fix: Remove this URL from the sitemap or fix the 404.")).toBe("Remove this URL from the sitemap or fix the 404");
    expect(sitemapActionText("SEO-TITLE-MISSING", "x", 1, null)).toBeNull();
    const findings = [U.guide, U.sconces, U.hardware].map((url) => ({ rule: "SEO-SITEMAP-URL-ERROR", severity: "major", url, detail: "Listed in the sitemap but returned HTTP 404. Fix: Remove this URL from the sitemap or fix the 404.", evidence: { status: 404 } }));
    const s = await scenario({ findings });
    const { candidates } = await candidatesOf(s);
    const c = candidates.find((x) => x.issueType === "technical:SEO-SITEMAP-URL-ERROR")!;
    expect(c).toMatchObject({ scope: "site", defaultAction: "fix_canonical_or_indexing" });
    expect(c.actionText).toMatch(/^Correct the 3 sitemap entries reported by SEO-SITEMAP-URL-ERROR for the site.*\(for example .*: Remove this URL from the sitemap or fix the 404\); \[confirm: where your platform generates the sitemap\]\.$/);
    const d = draftOf(c, c.defaultAction, "act");
    expect(d.ok, d.ok ? "" : d.errors.join("; ")).toBe(true);
  });
});
