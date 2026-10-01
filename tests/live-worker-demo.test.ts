import { describe, expect, it } from "vitest";
import type { CompetitorPageAssessment, LinkSuggestionReport, LiveGeoBoardResponse, LiveSeoBoardResponse, RunActivity } from "@shared/types";
import { DEMO_LABEL } from "@worker/demo/fixtures";
import { seedDemoProject } from "@worker/demo/seed";
import { FIXED_NOW } from "./helpers/fixtures";
import { caller, setup } from "./live-worker-seed";

async function demoSetup() {
  const ctx = await setup({ DEMO_MODE: "true" });
  const demo = await seedDemoProject(ctx.env, ctx.db, ctx.u.userId, FIXED_NOW);
  const call = caller(ctx.env, ctx.u);
  const runs = (await call(`/projects/${demo.id}/activity/current`)).json.data.runs as Array<{ id: string; agent: "seo" | "geo" }>;
  return { ...ctx, demo, call, seoRun: runs.find((r) => r.agent === "seo")!.id, geoRun: runs.find((r) => r.agent === "geo")!.id };
}

describe("live SEO feed: labelled demo replay", () => {
  it("replays a meaningful 'every SEO element' panel from the seeded demo rows", async () => {
    const { demo, call, seoRun } = await demoSetup();
    const res = await call(`/projects/${demo.id}/live/seo?runId=${seoRun}&limit=200`);
    expect(res.status).toBe(200);
    const r = res.json.data as LiveSeoBoardResponse;
    expect(r.labels[0]).toBe(DEMO_LABEL);
    expect(r.active).toBe(false);

    // Several elements of several demo pages, with every verdict.
    const pages = new Set(r.elements.map((e) => e.pagePath).filter(Boolean));
    expect(pages.size).toBeGreaterThanOrEqual(6);
    expect(new Set(r.elements.map((e) => e.element)).size).toBeGreaterThanOrEqual(8);
    for (const v of ["keep", "change", "review"] as const) expect(r.elements.some((e) => e.verdict === v), v).toBe(true);
    expect(new Set(r.elements.map((e) => e.role))).toEqual(new Set(["element", "action", "rule"]));
    // Stored values only: current values from the demo crawl, the drafted snippet of a demo recommendation,
    // measured (fictional) GSC figures with their window and basis, and stored Jev tiers and raw answers.
    expect(r.elements.find((e) => e.element === "Title" && e.pagePath === "/collections/sofas")).toMatchObject({ verdict: "keep", now: "Sofas | Demo Furnishings", proposed: null });
    expect(r.elements.find((e) => e.targetLabel === "Template: product (3 URLs)")).toMatchObject({ role: "action", element: "Schema", verdict: "change" });
    expect(r.elements.find((e) => e.targetLabel === "Template: product (3 URLs)")!.proposed).toContain('"offers"');
    expect(r.elements.filter((e) => e.gsc).every((e) => e.gsc!.basis === "query_page_rows" && e.gsc!.window.start < e.gsc!.window.end)).toBe(true);
    expect(r.elements.filter((e) => e.jev).every((e) => e.jev!.model === "demo-fixture" && (e.jev!.noul === null || e.jev!.confidence === null))).toBe(true);
    // Every verdict is consistent with the element map (no row is "Reading…" or pending: the server never sends one).
    for (const e of r.elements) expect(["keep", "change", "review"]).toContain(e.verdict);

    // Queries classified before the shortlist; recommendations; the run's demo sync; whole-run totals.
    expect(r.queries).toHaveLength(8);
    expect(r.queries.every((q) => q.gsc !== null)).toBe(true);
    expect(r.totals!.queries.relevance).toEqual({ yes: 7, no: 0, middle: 1, unanswered: 0 });
    // Query answers are 2.4 s apart (they reveal one by one in a replay, not on one frame).
    const qt = r.queries.map((q) => Date.parse(q.at));
    for (let i = 1; i < qt.length; i++) expect(Math.round((qt[i]! - qt[i - 1]!) / 100) / 10).toBe(2.4);
    expect(r.recommendations.map((x) => x.issueType).sort()).toEqual(["product_offer_missing", "weak_ctr_missing_description"]);
    expect(r.gscSync).toMatchObject({ source: "demo", status: "completed" });
    expect(r.totals!.elements.judged).toBeGreaterThan(15);
    expect(r.totals!.elements.change).toBeGreaterThan(0);
    // 11 Jev-judged candidates plus 3 reused internal link suggestions (no Jev re-ask, so not "judged").
    expect(r.totals!.pipeline).toMatchObject({ candidates: 14, judged: 11, created: 2, rejectedByReason: { low_fit: 4, budget: 8 } });
    // Reused link suggestions become "Links" rows with the suggester's stored tier and should-exist Noul.
    const links = r.elements.filter((e) => e.element === "Links");
    expect(links).toHaveLength(3);
    expect(links.every((e) => e.linkSuggestionId && e.verdict === "change" && e.jev?.questionId === "links.should_exist" && e.jev.noul !== null)).toBe(true);

    // Rows fall inside the run and in replay order; paging in small steps yields the same rows.
    const all = [...r.elements, ...r.queries, ...r.recommendations];
    expect(all.every((x) => x.at >= r.run.startedAt! && x.at <= r.run.finishedAt!)).toBe(true);
    expect(r.elements.map((e) => e.at)).toEqual(r.elements.map((e) => e.at).slice().sort());
    const paged: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 40; i++) {
      const p: LiveSeoBoardResponse = (await call(`/projects/${demo.id}/live/seo?runId=${seoRun}&limit=4${cursor ? `&after=${cursor}` : ""}`)).json.data;
      const ids = [...p.elements, ...p.queries, ...p.recommendations].map((x) => x.id);
      if (ids.length === 0) break;
      paged.push(...ids);
      cursor = p.cursor;
    }
    expect(paged.sort()).toEqual(all.map((x) => x.id).sort());
  });

  it("keeps the demo activity replay coherent: decisions after the crawl and before the proposals", async () => {
    const { demo, call, seoRun, geoRun } = await demoSetup();
    const seo = (await call(`/projects/${demo.id}/runs/${seoRun}/activity?limit=200`)).json.data as RunActivity;
    const kinds = seo.items.map((i) => i.kind);
    const lastRead = kinds.lastIndexOf("page_read");
    const firstDecision = kinds.indexOf("jev_decision");
    expect(firstDecision).toBeGreaterThan(lastRead);
    const recommendDone = seo.items.findIndex((i) => i.kind === "step" && i.detail === "seo.recommend · completed");
    expect(recommendDone).toBeGreaterThan(0);
    expect(kinds.lastIndexOf("jev_decision")).toBeLessThan(recommendDone);
    expect(seo.items.every((i) => i.at >= seo.run.startedAt! && i.at <= seo.run.finishedAt!)).toBe(true);
    // The live feed and the activity feed name the same decisions with the same ids.
    const live = (await call(`/projects/${demo.id}/live/seo?runId=${seoRun}&limit=200`)).json.data as LiveSeoBoardResponse;
    const decisionIds = new Set(seo.items.filter((i) => i.kind === "jev_decision").map((i) => i.id));
    for (const e of live.elements.filter((x) => x.id.startsWith("dec:"))) expect(decisionIds.has(e.id)).toBe(true);
    // The GEO demo run is not an SEO run.
    const mismatch = await call(`/projects/${demo.id}/live/seo?runId=${geoRun}`);
    expect(mismatch.status).toBe(400);
    expect(mismatch.json.error.details).toEqual({ reason: "agent_mismatch" });
  });

  it("stores runtime step events (started + terminal) so the rail, pending rows and lane states work in a replay", async () => {
    const { demo, call, seoRun, geoRun } = await demoSetup();
    const seo = (await call(`/projects/${demo.id}/runs/${seoRun}/activity?limit=200`)).json.data as RunActivity;
    const geo = (await call(`/projects/${demo.id}/runs/${geoRun}/activity?limit=200`)).json.data as RunActivity;
    const steps = (a: RunActivity) => a.items.filter((i) => i.kind === "step").map((i) => i.detail);
    for (const st of ["seo.validate", "seo.crawl", "seo.gsc_sync", "seo.recommend", "seo.summary"]) {
      expect(steps(seo), st).toContain(`${st} · started`);
      expect(steps(seo), st).toContain(`${st} · completed`);
    }
    for (const st of ["geo.validate", "geo.proposals", "geo.summary", "geo.batch", "geo_batch:gemini", "geo_batch:perplexity"]) expect(steps(geo), st).toContain(`${st} · started`);
    expect(steps(geo)).toContain("geo.batch · partial");
    expect(steps(geo)).toContain("geo_batch:gemini · completed");
    expect(steps(geo)).toContain("geo_batch:perplexity · partial");
    // Legacy sub-steps are notes now, never step states.
    expect(steps(seo)).toContain("decisions · info");
    expect(steps(seo).some((d) => /^(fetch_gsc|crawl|run_prompts|persist_summary) · /.test(d ?? ""))).toBe(false);
    // Rows fall inside their step: page reads inside seo.crawl, decisions inside seo.recommend, answers inside their lane.
    const at = (a: RunActivity, detail: string) => a.items.find((i) => i.detail === detail)!.at;
    const reads = seo.items.filter((i) => i.kind === "page_read");
    expect(reads.every((i) => i.at > at(seo, "seo.crawl · started") && i.at < at(seo, "seo.crawl · completed"))).toBe(true);
    const decisions = seo.items.filter((i) => i.kind === "jev_decision");
    expect(decisions.every((i) => i.at > at(seo, "seo.recommend · started") && i.at < at(seo, "seo.recommend · completed"))).toBe(true);
    const answers = geo.items.filter((i) => i.kind === "engine_answer");
    expect(answers.length).toBe(10);
    for (const a of answers) {
      expect(a.at > at(geo, `geo_batch:${a.provider} · started`)).toBe(true);
      expect(a.at < at(geo, `geo_batch:${a.provider} · ${a.provider === "gemini" ? "completed" : "partial"}`)).toBe(true);
    }
    // The GEO feed carries each answer's stored model and grounding mode.
    const g = (await call(`/projects/${demo.id}/live/geo?runId=${geoRun}&limit=200`)).json.data as LiveGeoBoardResponse;
    expect(g.answers.every((x) => x.model === "demo-fixture" && (x.groundingMode === "google_search" || x.groundingMode === "perplexity_web_search"))).toBe(true);
  });

  it("seeds approved competitor pages and an internal link run so panels 05 / 08 and GEO C are not empty", async () => {
    const { demo, call } = await demoSetup();
    const comp = (await call(`/projects/${demo.id}/geo/competitor-pages`)).json.data as { pages?: CompetitorPageAssessment[] } | CompetitorPageAssessment[];
    const pages = Array.isArray(comp) ? comp : (comp.pages ?? []);
    expect(pages.map((p) => p.host).sort()).toEqual(["lamp-house.example", "marketplace.example"]);
    expect(pages.every((p) => p.state === "assessed" && p.checks.length === 8 && p.citedIn.length > 0)).toBe(true);
    expect(new Set(pages.flatMap((p) => p.citedIn.map((c) => c.provider)))).toEqual(new Set(["gemini", "perplexity"]));
    expect(pages.find((p) => p.host === "lamp-house.example")!.verdict).toBe("adapt");
    expect(pages.every((p) => p.reasons.every((r) => r.includes(DEMO_LABEL)))).toBe(true);
    const report = (await call(`/projects/${demo.id}/seo/internal-links`)).json.data as LinkSuggestionReport;
    expect(report.suggestions.length).toBeGreaterThanOrEqual(4);
    expect(report.suggestions.filter((x) => x.status === "suggested").length).toBeGreaterThanOrEqual(3);
    expect(report.labels.some((l) => l.includes(DEMO_LABEL))).toBe(true);
  });
});
