/**
 * [A21] Checklist gaps + robots.txt advisor feeding the GEO agent's daily proposals.
 * Fixtures are labelled test data; robots.txt comes from a fake fetch (no network).
 */
import { describe, expect, it } from "vitest";
import { Db } from "@worker/lib/db";
import { newId } from "@worker/lib/ids";
import { checklistSignals } from "@worker/checklists/bridge";
import { GEO_CHECKLIST_PRIORITY_VERSION, geoChecklistPriority } from "@worker/geo/checklist-proposals";
import { generateGeoProposals, geoClaimViolations } from "@worker/geo/proposals";
import { isPathAllowed, parseRobots, selectGroup } from "@worker/seo/crawl/robots";
import type { RunContext } from "@worker/runs/context";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";
import { makeTestContext } from "./helpers/context";
import { crawler, projectRow, seedCrawl, seedGeo, SITE_ROBOTS, type PageSeed } from "./checklists-seed";
import { fakeSite } from "./fixtures/crawl/fake-site";
import { fakeDecisions, score } from "./fixtures/geo-analysis/seed";

const ROBOTS_URL = "https://shop.example.com/robots.txt";
const ROBOTS_OAI_BLOCKED = `User-agent: *
Disallow: /cart
Disallow: /checkout

User-agent: OAI-SearchBot
Disallow: /

User-agent: GPTBot
Disallow: /
`;

/** A tidy store: no structure/trust gaps unless a test adds them. */
const CLEAN_PAGES: PageSeed[] = [
  { path: "/", pageType: "home", title: "Residence Example home", h1: ["Residence Example"], links: ["/products/brass-pull", "/products/brass-knob"] },
  { path: "/products/brass-pull", pageType: "product", links: ["/"] },
  { path: "/products/brass-knob", pageType: "product", links: ["/"] },
];

async function setup(opts: { pages?: PageSeed[]; robots?: unknown; crawl?: boolean } = {}) {
  const env = createTestEnv();
  const u = await seedUser(env);
  const pid = await seedProject(env, u.workspaceId);
  const db = new Db(env.DB);
  if (opts.crawl !== false) await seedCrawl(db, u.workspaceId, pid, { pages: opts.pages ?? CLEAN_PAGES, robots: opts.robots });
  const project = { id: pid, workspaceId: u.workspaceId };
  return { env, db, project, ws: u.workspaceId, ctx: (o: Partial<RunContext> = {}) => makeTestContext(env, project, o) };
}

type Rec = { id: string; issue_type: string; scope: string; target_json: string; trigger: string; issue: string; action: string; rationale: string; limitations: string; suggested_snippet: string | null; priority: number; priority_version: string; evidence_ids_json: string; verified: number; dedup_key: string; decision_label: string | null };
const recs = (db: Db, pid: string) => db.all<Rec>("SELECT * FROM recommendations WHERE project_id = ? AND agent = 'geo' ORDER BY priority DESC", pid);
const decisions = (db: Db, pid: string) => db.all<{ candidate_key: string; outcome: string; reason_code: string | null; question_id: string | null }>("SELECT candidate_key, outcome, reason_code, question_id FROM decision_records WHERE project_id = ? AND agent = 'geo'", pid);
const textOf = (r: Rec) => [r.trigger, r.issue, r.action, r.rationale, r.limitations, r.suggested_snippet ?? ""].join("\n");

/** One analyzed discovery observation stored the way the GEO agent stores it (brand rows, displacement, summary evidence). */
async function seedDisplacedPrompt(
  db: Db,
  ws: string,
  pid: string,
  o: { prompt: string; provider?: string; entity: string; url: string; sourceType: string; citations?: Array<{ url: string; sourceType: string }> },
): Promise<{ obsId: string; evidenceId: string }> {
  const obsId = newId("gobs");
  const provider = o.provider ?? "gemini";
  await db.insert("geo_observations", {
    id: obsId, workspace_id: ws, project_id: pid, prompt_text: o.prompt, prompt_type: "discovery", cohort_key: `cohort-${provider}`, provider, model: "test-model",
    grounding_mode: "google_search", measurement_type: "api", status: "ok", grounded: 1, raw_answer: "Brass Co is a good pick.", created_at: new Date(FIXED_NOW.getTime() - 3600_000).toISOString(),
  });
  await db.insert("geo_brand_observations", { id: newId("gbo"), workspace_id: ws, project_id: pid, observation_id: obsId, brand_key: "self", is_self: 1, mentioned: 0, cited: 0, recommendation_status: "not_mentioned", sentiment: "not_applicable", method: "deterministic" });
  await db.insert("geo_brand_observations", { id: newId("gbo"), workspace_id: ws, project_id: pid, observation_id: obsId, brand_key: o.entity, is_self: 0, mentioned: 1, cited: 0, recommendation_status: "recommended", sentiment: "positive", method: "deterministic" });
  await db.insert("geo_displacements", { id: newId("gdp"), workspace_id: ws, project_id: pid, observation_id: obsId, entity: o.entity, url: o.url, source_type: o.sourceType, span: "Brass Co is a good pick.", created_at: FIXED_NOW.toISOString() });
  for (const [i, c] of (o.citations ?? [{ url: o.url, sourceType: o.sourceType }]).entries()) {
    await db.insert("geo_citations", { id: newId("cit"), workspace_id: ws, project_id: pid, observation_id: obsId, url: c.url, host: new URL(c.url).hostname, title: null, position: i + 1, brand_key: null, source_type: c.sourceType, source_type_method: "rule" });
  }
  const evidenceId = newId("ev");
  const data = { kind: "summary", provider, model: "test-model", grounded: true, prompt: o.prompt, displacements: [{ entity: o.entity, url: o.url, sourceType: o.sourceType }] };
  await db.insert("evidence", {
    id: evidenceId, workspace_id: ws, project_id: pid, run_id: null, source: "geo_observation", ref_id: obsId, window: null,
    text: `API-sampled answer from ${provider} (test-model) for "${o.prompt}": brand not mentioned; ${o.entity} recommended; cited ${o.url} (${o.sourceType}).`,
    data_json: JSON.stringify(data), tainted: 0, hash: evidenceId, created_at: FIXED_NOW.toISOString(),
  });
  return { obsId, evidenceId };
}

describe("agent integration: GEO checklist proposals", () => {
  it("OAI-SearchBot blocked -> GEO proposal with the advisor snippet; training crawlers keep their current rules", async () => {
    const robots = SITE_ROBOTS({ crawlers: [crawler("Googlebot", "search_engine", true), crawler("OAI-SearchBot", "answer_search", false), crawler("PerplexityBot", "answer_search", true), crawler("GPTBot", "training", false)] });
    const s = await setup({ robots });
    const site = fakeSite({ [ROBOTS_URL]: { status: 200, contentType: "text/plain", body: ROBOTS_OAI_BLOCKED } });
    const res = await generateGeoProposals(s.ctx({ crawlFetch: site.fetch }));
    expect(res.created).toBe(1);
    expect(site.urls()).toEqual([ROBOTS_URL]);
    const [r] = await recs(s.db, s.project.id);
    expect(r).toMatchObject({ issue_type: "geo_checklist:geo.access.ai_search_bots_allowed", scope: "site", priority_version: GEO_CHECKLIST_PRIORITY_VERSION, verified: 1 });
    expect(r!.priority_version).toMatch(/^geo-priority-/);
    const parsed = parseRobots(r!.suggested_snippet!);
    const oai = selectGroup(parsed, "OAI-SearchBot");
    expect(oai!.agents).toContain("oai-searchbot");
    expect(isPathAllowed(oai, "/")).toBe(true);
    expect(isPathAllowed(oai, "/cart")).toBe(false);
    expect(isPathAllowed(oai, "/checkout")).toBe(false);
    // Training policy preserved: GPTBot was blocked and stays blocked.
    expect(isPathAllowed(selectGroup(parsed, "GPTBot"), "/")).toBe(false);
    expect(r!.action).toMatch(/still blocked: GPTBot/);
    // CDN/WAF caveat and review-only wording.
    expect(r!.limitations).toMatch(/never edits your robots\.txt/);
    expect(r!.limitations).toMatch(/CDN or WAF bot protection/);
    expect(r!.action).toMatch(/CDN or WAF/);
    expect(geoClaimViolations([r!.issue, r!.action, r!.rationale, r!.limitations].join("\n"))).toEqual([]);
    const dec = await decisions(s.db, s.project.id);
    expect(dec).toContainEqual(expect.objectContaining({ candidate_key: r!.dedup_key, outcome: "selected", reason_code: null }));
    expect(r!.dedup_key).toMatch(/^geo:checklist:[0-9a-f]{24}$/);
  });

  it("training allowed today stays allowed: no training group is added", async () => {
    const robots = SITE_ROBOTS({ crawlers: [crawler("OAI-SearchBot", "answer_search", false), crawler("GPTBot", "training", true)] });
    const s = await setup({ robots });
    const body = "User-agent: *\nDisallow: /cart\n\nUser-agent: OAI-SearchBot\nDisallow: /\n";
    const site = fakeSite({ [ROBOTS_URL]: { status: 200, contentType: "text/plain", body } });
    await generateGeoProposals(s.ctx({ crawlFetch: site.fetch }));
    const [r] = await recs(s.db, s.project.id);
    const parsed = parseRobots(r!.suggested_snippet!);
    expect(parsed.groups.some((g) => g.agents.includes("gptbot"))).toBe(false);
    const gpt = selectGroup(parsed, "GPTBot"); // falls back to "*" exactly as before
    expect(isPathAllowed(gpt, "/")).toBe(true);
    expect(isPathAllowed(gpt, "/cart")).toBe(false);
    expect(r!.action).not.toMatch(/still blocked/);
  });

  it("mentions: one manual outreach list by source type, without guarantee or automation language", async () => {
    const s = await setup({ crawl: false });
    const listicle = "https://bestreviews.example/best-brass-hardware";
    await seedGeo(s.db, s.ws, s.project.id, {
      approvedPrompts: 5,
      observations: [
        { provider: "gemini", citations: [{ url: "https://www.reddit.com/r/homeimprovement/comments/abc/brass_pulls/", sourceType: "forum_ugc" }, { url: listicle, sourceType: "listicle_roundup" }] },
        { provider: "perplexity", citations: [{ url: "https://reviews.example/brass-co", sourceType: "review_site" }, { url: "https://www.youtube.com/watch?v=brass", sourceType: "other" }, { url: listicle, sourceType: "listicle_roundup" }] },
        { provider: "gemini", citations: [{ url: "https://news.example/design/brass-trend", sourceType: "publisher" }, { url: "https://market.example/item/77", sourceType: "marketplace" }] },
      ],
    });
    // The listicle wins two prompt x provider pairs -> its own geo_displacement proposal covers it.
    const obs = await s.db.all<{ id: string; provider: string }>("SELECT id, provider FROM geo_observations WHERE project_id = ? ORDER BY created_at DESC", s.project.id);
    for (const o of obs.slice(0, 2)) {
      await s.db.insert("geo_displacements", { id: newId("gdp"), workspace_id: s.ws, project_id: s.project.id, observation_id: o.id, entity: "Brass Co", url: listicle, source_type: "listicle_roundup", span: null, created_at: FIXED_NOW.toISOString() });
    }
    const res = await generateGeoProposals(s.ctx());
    const r = (await recs(s.db, s.project.id)).find((x) => x.issue_type === "geo_checklist:geo.mentions")!;
    expect(r).toBeDefined();
    expect(res.candidates).toBeGreaterThanOrEqual(2); // displacement + mentions
    const list = r.suggested_snippet!;
    expect(list).toMatch(/Forum and Reddit threads:\n- https:\/\/www\.reddit\.com\/r\/homeimprovement/);
    expect(list).toMatch(/Review sites and marketplaces:[\s\S]*https:\/\/reviews\.example\/brass-co[\s\S]*https:\/\/market\.example\/item\/77/);
    expect(list).toMatch(/YouTube videos:\n- https:\/\/www\.youtube\.com\/watch\?v=brass/);
    expect(list).toMatch(/News and publisher sites:\n- https:\/\/news\.example\/design\/brass-trend/);
    expect(list).not.toContain(listicle); // covered by the displacement proposal
    const text = textOf(r);
    expect(text).toMatch(/manual/i);
    expect(text).toMatch(/does not post, review, or contact anyone on your behalf/);
    expect(text).not.toMatch(/guarantee/i);
    expect(text).not.toMatch(/\bautomat(?:e|ed|ic|ically|ion)\b/i);
    expect(text).not.toMatch(/\b(?:write|buy|post|create|generate|add)\s+(?:a\s+)?(?:fake|fabricated)\b/i);
    expect(text).not.toMatch(/\b(?:likely|likelihood|chance|odds)\b/i);
    expect(geoClaimViolations(text)).toEqual([]);
    expect(r.verified).toBe(0);
    expect(r.scope).toBe("site");
  });

  it("structure/trust gap tied to a displaced prompt cites the checklist item and the observation", async () => {
    const guide = "/blog/brass-cabinet-hardware-guide";
    const pages: PageSeed[] = [
      ...CLEAN_PAGES.map((p) => (p.path === "/" ? { ...p, links: [...(p.links ?? []), guide] } : p)),
      { path: guide, pageType: "article", title: "Brass cabinet hardware buying guide", h1: ["Brass cabinet hardware buying guide"], author: null, links: ["/"] },
    ];
    const s = await setup({ pages });
    const { obsId, evidenceId } = await seedDisplacedPrompt(s.db, s.ws, s.project.id, {
      prompt: "Where can I buy solid brass cabinet hardware?",
      entity: "Brass Co",
      url: "https://bestreviews.example/best-brass-hardware",
      sourceType: "listicle_roundup",
      citations: [],
    });
    const res = await generateGeoProposals(s.ctx());
    const r = (await recs(s.db, s.project.id)).find((x) => x.issue_type === "geo_checklist:geo.trust.author_bio")!;
    expect(r).toBeDefined();
    expect(r.scope).toBe("page");
    expect(JSON.parse(r.target_json)).toEqual({ kind: "url", url: `https://shop.example.com${guide}` });
    expect(r.verified).toBe(1);
    expect(r.trigger).toMatch(/^Provider answers missing Residence Example/);
    expect(r.issue).toMatch(/Brass Co/);
    const ids = JSON.parse(r.evidence_ids_json) as string[];
    expect(ids).toContain(evidenceId);
    const ev = await s.db.all<{ source: string; data_json: string; text: string }>(`SELECT source, data_json, text FROM evidence WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids);
    const datas = ev.map((e) => JSON.parse(e.data_json) as Record<string, unknown>);
    expect(datas.some((d) => d.checklistItemId === "geo.trust.author_bio" && d.checklistKind === "geo" && d.status === "not_met" && d.method === "measured")).toBe(true);
    expect(datas.some((d) => d.kind === "checklist_displacement_tie" && (d.observationIds as string[]).includes(obsId))).toBe(true);
    expect(ev.some((e) => e.source === "crawl" && e.text.includes("named author absent"))).toBe(true);
    expect(geoClaimViolations(textOf(r))).toEqual([]);
    expect(res.created).toBeGreaterThanOrEqual(1);
  });

  it("a heuristic GEO gap needs Jev: rejected decision_unavailable without it, judged by geo.proposal_fit with it", async () => {
    const guide = "/blog/brass-care";
    const pages: PageSeed[] = [
      ...CLEAN_PAGES.map((p) => (p.path === "/" ? { ...p, links: [...(p.links ?? []), guide] } : p)),
      { path: guide, pageType: "article", title: "Caring for brass hardware", headings: [{ level: 1, text: "Caring for brass" }, { level: 2, text: "Cleaning" }, { level: 2, text: "Polishing" }], links: ["/"] },
    ];
    const s = await setup({ pages });
    await generateGeoProposals(s.ctx());
    const dec = await decisions(s.db, s.project.id);
    expect(dec).toEqual([expect.objectContaining({ outcome: "rejected", reason_code: "decision_unavailable", question_id: null })]);
    expect(await recs(s.db, s.project.id)).toEqual([]);

    const s2 = await setup({ pages });
    await s2.db.insert("context_documents", { id: "ctx1", workspace_id: s2.ws, project_id: s2.project.id, kind: "positioning", version: 1, content: "Small-batch solid brass hardware.", facts_json: "[]", created_at: FIXED_NOW.toISOString() });
    const jev = fakeDecisions(() => score(3));
    await generateGeoProposals(s2.ctx({ decisions: jev }));
    expect(jev.requests).toHaveLength(1);
    const [r] = await recs(s2.db, s2.project.id);
    expect(r).toMatchObject({ issue_type: "geo_checklist:geo.structure.question_headings", decision_label: "act" });
    expect((await decisions(s2.db, s2.project.id)).find((d) => d.candidate_key === r!.dedup_key)).toMatchObject({ outcome: "selected", question_id: "geo.proposal_fit" });
  });

  it("tracking gaps are never proposals", async () => {
    const s = await setup();
    await seedGeo(s.db, s.ws, s.project.id, { approvedPrompts: 3, observations: [{ provider: "gemini" }] });
    const project = await projectRow(s.db, s.project.id);
    const sig = await checklistSignals(s.env, s.db, project, FIXED_NOW, { kinds: ["geo"] });
    expect(sig.gaps.some((g) => g.section === "tracking")).toBe(true);
    await generateGeoProposals(s.ctx());
    expect((await recs(s.db, s.project.id)).some((r) => r.issue_type.startsWith("geo_checklist:geo.tracking"))).toBe(false);
    expect((await decisions(s.db, s.project.id)).length).toBe(0);
  });

  it("respects the daily cap and dedupes on reruns", async () => {
    const robots = SITE_ROBOTS({ crawlers: [crawler("OAI-SearchBot", "answer_search", false), crawler("PerplexityBot", "answer_search", false)] });
    const pages: PageSeed[] = [
      ...CLEAN_PAGES.map((p) => (p.path === "/" ? { ...p, links: [...(p.links ?? []), "/blog/a", "/blog/b"] } : p)),
      { path: "/blog/a", pageType: "article", author: null, lastUpdated: null, links: ["/"] },
      { path: "/blog/b", pageType: "article", author: null, lastUpdated: null, outbound: 0, links: ["/"] },
    ];
    const s = await setup({ pages, robots });
    const body = "User-agent: *\nDisallow: /cart\n\nUser-agent: OAI-SearchBot\nUser-agent: PerplexityBot\nDisallow: /\n";
    const site = fakeSite({ [ROBOTS_URL]: { status: 200, contentType: "text/plain", body } });
    const first = await generateGeoProposals(s.ctx({ crawlFetch: site.fetch }));
    expect(first.candidates).toBeGreaterThanOrEqual(4);
    expect(first.created).toBe(2);
    const day1 = await recs(s.db, s.project.id);
    expect(day1[0]!.issue_type).toBe("geo_checklist:geo.access.ai_search_bots_allowed");
    expect((await decisions(s.db, s.project.id)).some((d) => d.reason_code === "daily_cap")).toBe(true);

    const sameDay = await generateGeoProposals(s.ctx({ crawlFetch: site.fetch }));
    expect(sameDay.created).toBe(0);

    const next = new Date(FIXED_NOW.getTime() + 86400_000);
    await generateGeoProposals(s.ctx({ crawlFetch: site.fetch, clock: () => next }));
    const dupes = (await decisions(s.db, s.project.id)).filter((d) => d.reason_code === "duplicate");
    for (const r of day1) expect(dupes.some((d) => d.candidate_key === r.dedup_key)).toBe(true);
    const all = await recs(s.db, s.project.id);
    expect(new Set(all.map((r) => r.dedup_key)).size).toBe(all.length);
  });

  it("checklist priority is documented and bounded; no reference tier input exists", () => {
    expect(geoChecklistPriority({ severity: 1, reach: 1 }, 10, null)).toBe(100);
    expect(geoChecklistPriority({ severity: 0.25, reach: null }, 0, null)).toBe(13.3);
    expect(geoChecklistPriority({ severity: 0.5, reach: 0.5 }, 2, 1)).toBe(49.6);
  });
});
