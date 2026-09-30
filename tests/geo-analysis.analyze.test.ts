import { describe, expect, it } from "vitest";
import { Db } from "@worker/lib/db";
import { analyzeObservation } from "@worker/geo/analyze";
import { generateGeoProposals, geoClaimViolations, geoPriority } from "@worker/geo/proposals";
import type { WritingProvider } from "@worker/providers/types";
import { createTestEnv } from "./helpers/env";
import { seedProject, seedUser, FIXED_NOW } from "./helpers/fixtures";
import { makeTestContext } from "./helpers/context";
import { choice, fakeDecisions, fixture, noul, score, seedObservation, type FixtureName } from "./fixtures/geo-analysis/seed";

async function setup(projectOverrides: Record<string, unknown> = {}) {
  const env = createTestEnv();
  const u = await seedUser(env);
  const projectId = await seedProject(env, u.workspaceId, projectOverrides);
  const project = { id: projectId, workspaceId: u.workspaceId };
  const db = new Db(env.DB);
  return { env, u, project, db };
}

async function analyze(name: FixtureName, opts: { overrides?: Record<string, unknown>; ctx?: Parameters<typeof makeTestContext>[2] } = {}) {
  const s = await setup(opts.overrides);
  const id = await seedObservation(s.env, s.project, fixture(name));
  const ctx = makeTestContext(s.env, s.project, opts.ctx ?? {});
  const summary = await analyzeObservation(ctx, id);
  const brandRows = await s.db.all<Record<string, unknown>>("SELECT * FROM geo_brand_observations WHERE observation_id = ? ORDER BY is_self DESC", id);
  const citations = await s.db.all<Record<string, unknown>>("SELECT * FROM geo_citations WHERE observation_id = ? ORDER BY position", id);
  const displacements = await s.db.all<Record<string, unknown>>("SELECT * FROM geo_displacements WHERE observation_id = ?", id);
  const self = brandRows.find((b) => b.is_self === 1)!;
  const comp = brandRows.find((b) => b.is_self === 0)!;
  return { ...s, id, summary, brandRows, citations, displacements, self, comp, ctx };
}

describe("geo-analysis: analyzeObservation (deterministic, no Jev)", () => {
  it("mention: mentioned, recommended, not cited, sentiment unknown without Jev, preflight unavailable", async () => {
    const r = await analyze("mention");
    expect(r.self).toMatchObject({ mentioned: 1, cited: 0, recommendation_status: "recommended", sentiment: "unknown", list_rank: null });
    expect(String(r.self.method)).toContain("preflight unavailable");
    expect(JSON.parse(String(r.self.spans_json))[0]).toMatchObject({ text: "Residence Example" });
    expect(r.summary.tainted).toBe(false);
    expect(r.displacements).toHaveLength(0);
    const ev = await r.db.all<{ source: string; ref_id: string; tainted: number }>("SELECT source, ref_id, tainted FROM evidence WHERE ref_id = ?", r.id);
    expect(ev.length).toBeGreaterThanOrEqual(1);
    expect(ev.every((e) => e.source === "geo_observation")).toBe(true);
  });

  it("no mention: not_mentioned with sentiment not_applicable; third-party citation -> displacement", async () => {
    const r = await analyze("no_mention");
    expect(r.self).toMatchObject({ mentioned: 0, cited: 0, recommendation_status: "not_mentioned", sentiment: "not_applicable" });
    expect(r.displacements).toHaveLength(1);
    expect(r.displacements[0]).toMatchObject({ entity: "thespruce.com", source_type: "publisher" });
  });

  it("citation without mention: cited via hostname, no displacement", async () => {
    const r = await analyze("citation_without_mention");
    expect(r.self).toMatchObject({ mentioned: 0, cited: 1, sentiment: "not_applicable" });
    expect(r.citations.map((c) => [c.host, c.brand_key, c.source_type, c.source_type_method])).toEqual([
      ["shop.example.com", "self", "brand_page", "rule"],
      ["reddit.com", null, "forum_ugc", "rule"],
    ]);
    expect(r.displacements).toHaveLength(0);
  });

  it("mention without citation: mentioned, not cited", async () => {
    const r = await analyze("mention_without_citation");
    expect(r.self).toMatchObject({ mentioned: 1, cited: 0 });
    expect(r.displacements).toHaveLength(0);
  });

  it("[A1] competitor only: displacement with entity, cited listicle URL, source type, and text span", async () => {
    const r = await analyze("competitor_only");
    expect(r.self).toMatchObject({ mentioned: 0, cited: 0, recommendation_status: "not_mentioned" });
    expect(r.comp).toMatchObject({ brand_key: "Brass Co", mentioned: 1, recommendation_status: "recommended" });
    expect(r.displacements).toHaveLength(1);
    expect(r.displacements[0]).toMatchObject({
      entity: "Brass Co",
      url: "https://bestreviews.example/best-brass-cabinet-hardware",
      source_type: "listicle_roundup",
    });
    expect(String(r.displacements[0]!.span)).toContain("Brass Co is a top pick");
  });

  it("alias collision without Jev stays unresolved (not counted as a mention, no displacement)", async () => {
    const r = await analyze("alias_collision", { overrides: { competitors_json: JSON.stringify([{ name: "Brass Co", domains: ["brassco.example"], aliases: ["ResEx"] }]) } });
    expect(r.self).toMatchObject({ mentioned: 0, recommendation_status: "unknown", sentiment: "unknown" });
    expect(String(r.self.method)).toContain("unresolved");
    expect(JSON.parse(String(r.self.spans_json))[0]).toMatchObject({ ambiguous: true, adjudication: "unresolved" });
    expect(r.displacements).toHaveLength(0);
  });

  it("unordered recommendations give list_rank null; ordered list gives the real rank", async () => {
    expect((await analyze("unordered")).self.list_rank).toBeNull();
    const o = await analyze("ordered");
    expect(o.self.list_rank).toBe(2);
    expect(o.comp.list_rank).toBe(1);
  });

  it("multilingual spans map to original offsets", async () => {
    const r = await analyze("multilingual_ja", { overrides: { brand_aliases_json: JSON.stringify(["ResEx", "レジデンス"]) } });
    const text = fixture("multilingual_ja").answer!;
    const spans = JSON.parse(String(r.self.spans_json)) as Array<{ start: number; end: number; text: string }>;
    expect(spans.map((s) => s.text)).toEqual(["Residence Example", "レジデンス", "ＲｅｓＥｘ"]);
    for (const s of spans) expect(text.slice(s.start, s.end)).toBe(s.text);
    const de = await analyze("multilingual_de");
    expect(JSON.parse(String(de.self.spans_json))).toHaveLength(2);
  });

  it("brand named only in the prompt is not a mention", async () => {
    const r = await analyze("brand_only_in_prompt");
    expect(r.self).toMatchObject({ mentioned: 0, sentiment: "not_applicable" });
  });

  it("hostname vs substring: attacker hosts and unresolved redirects are never attributed", async () => {
    const r = await analyze("hostname_vs_substring");
    expect(r.self).toMatchObject({ cited: 0 });
    expect(r.citations.map((c) => [c.host, c.brand_key])).toEqual([
      ["evil-example.com.attacker.net", null],
      ["notexample.com", null],
      ["", null],
    ]);
    // The unresolved redirect citation is not a displacement entity.
    expect(r.displacements.map((d) => d.entity).sort()).toEqual(["evil-example.com.attacker.net", "notexample.com"]);
    const g = await analyze("gemini_redirect_self");
    expect(g.self).toMatchObject({ cited: 1 });
    expect(g.citations.map((c) => c.host)).toEqual(["example.com", "blog.example.com"]);
  });

  it("failed observation: nothing derived", async () => {
    const r = await analyze("failed");
    expect(r.summary.skipped).toBe("status_failed");
    expect(r.brandRows).toHaveLength(0);
  });

  it("re-analysis is idempotent (no duplicate rows)", async () => {
    const r = await analyze("competitor_only");
    await analyzeObservation(r.ctx, r.id);
    expect(await r.db.all("SELECT id FROM geo_brand_observations WHERE observation_id = ?", r.id)).toHaveLength(2);
    expect(await r.db.all("SELECT id FROM geo_displacements WHERE observation_id = ?", r.id)).toHaveLength(1);
    expect(await r.db.all("SELECT id FROM geo_citations WHERE observation_id = ?", r.id)).toHaveLength(1);
  });
});

describe("geo-analysis: analyzeObservation with Jev", () => {
  it("batches questions in one call; adjudicates collisions; sentiment from the passage; decision records", async () => {
    const decisions = fakeDecisions((key, req) => {
      if (key === "injection_risk") return noul(0.05);
      if (key.startsWith("adj_")) {
        const brand = (req.state as { spans: Record<string, { brand: string }> }).spans[key]!.brand;
        return brand === "self" ? choice("tracked_brand") : choice("different_entity_same_name");
      }
      if (key.startsWith("rec_")) return choice("listed_neutral");
      if (key.startsWith("sent_")) return choice("positive");
      return undefined;
    });
    const r = await analyze("alias_collision", {
      overrides: { competitors_json: JSON.stringify([{ name: "Brass Co", domains: ["brassco.example"], aliases: ["ResEx"] }]) },
      ctx: { decisions },
    });
    expect(decisions.requests).toHaveLength(1);
    expect(r.self).toMatchObject({ mentioned: 1, sentiment: "positive", recommendation_status: "listed_neutral" });
    expect(String(r.self.method)).toMatch(/^deterministic\+jev; preflight clean/);
    expect(r.comp).toMatchObject({ mentioned: 0 });
    const dec = await r.db.all<{ question_id: string; question_version: string; policy_version: string; tier: string; outcome: string }>(
      "SELECT question_id, question_version, policy_version, tier, outcome FROM decision_records WHERE project_id = ?",
      r.project.id,
    );
    expect(dec.map((d) => d.question_id)).toContain("evidence.injection_risk");
    expect(dec.map((d) => d.question_id)).toContain("geo.mention_adjudication");
    expect(dec.every((d) => d.question_version && d.policy_version)).toBe(true);
    // Sentiment question sees only the brand passage, never a separate full answer field.
    const q = decisions.requests[0]!.questions.sent_self!;
    expect(q.instructions).toContain("`passages.self`");
  });

  it("[A14] injection text is tainted and passage evidence is marked tainted", async () => {
    const decisions = fakeDecisions((key) => (key === "injection_risk" ? noul(0.97) : key.startsWith("sent_") ? choice("positive") : undefined));
    const r = await analyze("injection", { ctx: { decisions } });
    expect(r.summary.tainted).toBe(true);
    const ev = await r.db.all<{ tainted: number; data_json: string }>("SELECT tainted, data_json FROM evidence WHERE ref_id = ?", r.id);
    expect(ev.find((e) => JSON.parse(e.data_json).kind === "passage")!.tainted).toBe(1);
    expect(ev.find((e) => JSON.parse(e.data_json).kind === "summary")!.tainted).toBe(0);
  });

  it("[A14] unreachable Jev treats the evidence as tainted and records decision_unavailable", async () => {
    const decisions = fakeDecisions(() => undefined, { fail: new Error("timeout") });
    const r = await analyze("mention", { ctx: { decisions } });
    expect(r.summary.tainted).toBe(true);
    expect(r.summary.decisions).toBe("unreachable");
    expect(r.self).toMatchObject({ mentioned: 1, sentiment: "unknown" });
    const reasons = await r.db.all<{ reason_code: string }>("SELECT reason_code FROM decision_records WHERE project_id = ?", r.project.id);
    expect(reasons.every((x) => x.reason_code === "decision_unavailable")).toBe(true);
  });

  it("source types: Jev classifies only rule-less citations; low confidence falls back to other/unknown", async () => {
    const s = await setup();
    const id = await seedObservation(s.env, s.project, {
      prompt: "p",
      grounded: true,
      answer: "Specialist shops sell them.",
      citations: [
        { url: "https://random.example/about-brass", title: "About brass", position: 1 },
        { url: "https://other.example/page", title: "Page", position: 2 },
      ],
    });
    const decisions = fakeDecisions((key) => (key === "injection_risk" ? noul(0.01) : key === "src_0" ? choice("publisher") : key === "src_1" ? choice("forum_ugc", 0.2) : undefined));
    await analyzeObservation(makeTestContext(s.env, s.project, { decisions }), id);
    const rows = await s.db.all<{ source_type: string; source_type_method: string }>("SELECT source_type, source_type_method FROM geo_citations WHERE observation_id = ? ORDER BY position", id);
    expect(rows).toEqual([
      { source_type: "publisher", source_type_method: "jev" },
      { source_type: "other", source_type_method: "unknown" },
    ]);
  });
});

// ------------------------------------------------------------------ proposals
async function seedProposalScenario() {
  const s = await setup();
  const ctx = makeTestContext(s.env, s.project);
  const prompts = ["Where can I buy solid brass cabinet hardware?", "Best brass knobs for a kitchen"];
  for (const [i, prompt] of prompts.entries()) {
    for (const provider of ["gemini", "perplexity"]) {
      const id = await seedObservation(s.env, s.project, { ...fixture("competitor_only"), prompt }, { provider, promptId: `p${i}`, createdAt: new Date(FIXED_NOW.getTime() - 3600_000).toISOString() });
      await analyzeObservation(ctx, id);
    }
  }
  return { ...s, ctx };
}

describe("geo-analysis: generateGeoProposals", () => {
  it("creates at most two evidence-backed proposals from templates without a writer, with decision records; reruns dedupe", async () => {
    const s = await seedProposalScenario();
    const summary = await generateGeoProposals(s.ctx);
    expect(summary.created).toBe(2);
    expect(summary.candidates).toBeGreaterThanOrEqual(3);
    const recs = await s.db.all<Record<string, unknown>>("SELECT * FROM recommendations WHERE project_id = ? ORDER BY priority DESC", s.project.id);
    expect(recs).toHaveLength(2);
    for (const r of recs) {
      expect(r.agent).toBe("geo");
      expect(r.verified).toBe(0);
      expect(JSON.parse(String(r.evidence_ids_json)).length).toBeGreaterThan(0);
      expect(String(r.limitations)).toContain("API-sampled");
      expect(geoClaimViolations([r.issue, r.action, r.rationale, r.limitations].join("\n"))).toEqual([]);
      expect(r.priority_version).toMatch(/^geo-priority-/);
    }
    expect(recs.some((r) => r.issue_type === "geo_displacement" && String(r.trigger).includes("Brass Co"))).toBe(true);
    const decs = await s.db.all<{ outcome: string; reason_code: string | null }>("SELECT outcome, reason_code FROM decision_records WHERE project_id = ? AND candidate_key LIKE 'geo:%'", s.project.id);
    expect(decs.filter((d) => d.outcome === "selected")).toHaveLength(2);
    expect(decs.some((d) => d.reason_code === "daily_cap")).toBe(true);

    // Next day: previously created proposals are duplicates.
    const next = makeTestContext(s.env, s.project, { clock: () => new Date(FIXED_NOW.getTime() + 86400_000) });
    const again = await generateGeoProposals(next);
    const decs2 = await s.db.all<{ reason_code: string | null }>("SELECT reason_code FROM decision_records WHERE project_id = ? AND reason_code = 'duplicate'", s.project.id);
    expect(decs2.length).toBeGreaterThanOrEqual(2);
    expect(again.created).toBeLessThanOrEqual(1);
  });

  it("rejects low-fit candidates via Jev geo.proposal_fit and uses the score in priority", async () => {
    const s = await seedProposalScenario();
    await s.db.insert("context_documents", { id: "ctx1", workspace_id: s.project.workspaceId, project_id: s.project.id, kind: "positioning", version: 1, content: "Small-batch solid brass hardware.", facts_json: "[]", created_at: FIXED_NOW.toISOString() });
    const decisions = fakeDecisions((key) => (key === "fit_p0" ? score(0) : score(4)));
    const summary = await generateGeoProposals(makeTestContext(s.env, s.project, { decisions }));
    expect(summary.rejected).toBeGreaterThanOrEqual(1);
    const low = await s.db.all<{ reason_code: string; question_id: string; tier: string }>("SELECT reason_code, question_id, tier FROM decision_records WHERE reason_code = 'low_fit'");
    expect(low).toHaveLength(1);
    expect(low[0]).toMatchObject({ question_id: "geo.proposal_fit", tier: "act" });
    const recs = await s.db.all<{ decision_label: string; decision_score_json: string }>("SELECT decision_label, decision_score_json FROM recommendations WHERE project_id = ?", s.project.id);
    expect(recs.every((r) => r.decision_label === "act" && JSON.parse(r.decision_score_json).score === 4)).toBe(true);
  });

  it("falls back to the template and records validation_failed when the writer draft breaks the rules", async () => {
    const s = await seedProposalScenario();
    const writer: WritingProvider = {
      name: "fake",
      model: "fake-writer-1",
      async write(req) {
        const ev = (req.input as { EVIDENCE: Array<{ id: string }> }).EVIDENCE;
        return {
          provider: "fake",
          model: "fake-writer-1",
          usage: { inputTokens: 1, outputTokens: 1 },
          output: {
            agent: "geo", scope: "site", target: { kind: "site" }, trigger: "t", issue: "i",
            evidence_ids: [ev[0]!.id],
            action: "Add FAQ schema, which guarantees inclusion in AI answers.",
            rationale: "r", effort: "low", uncertainty: "low", limitations: "l", verified: true,
          },
        };
      },
      async test() {
        return { ok: true, detail: "" };
      },
    };
    const summary = await generateGeoProposals(makeTestContext(s.env, s.project, { writer }));
    expect(summary.created).toBe(2);
    const recs = await s.db.all<{ action: string; writer_provider: string | null; verified: number }>("SELECT action, writer_provider, verified FROM recommendations WHERE project_id = ?", s.project.id);
    expect(recs.every((r) => r.writer_provider === null && !/guarantee/i.test(r.action) && r.verified === 0)).toBe(true);
    const failed = await s.db.all("SELECT id FROM decision_records WHERE reason_code = 'validation_failed'");
    expect(failed.length).toBe(2);
  });

  it("priority formula is versioned and bounded", () => {
    expect(geoPriority(10, 0, null)).toBe(100);
    expect(geoPriority(2, 30, null)).toBe(15);
    expect(geoPriority(2, 0, 1)).toBe(52);
  });
});
