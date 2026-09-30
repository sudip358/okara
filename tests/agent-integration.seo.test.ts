/**
 * [A21] Checklist gaps + robots.txt advisor feeding the SEO agent's daily recommendations.
 * Fixtures are labelled test data; robots.txt comes from a fake fetch (no network).
 */
import { describe, expect, it } from "vitest";
import { Db } from "@worker/lib/db";
import { checklistSignals, COVERED_BY_RULES } from "@worker/checklists/bridge";
import { SEO_ITEMS } from "@worker/checklists/items/seo";
import { isPathAllowed, parseRobots, selectGroup } from "@worker/seo/crawl/robots";
import { buildCandidates } from "@worker/seo/recommend/candidates";
import { buildSeoChecklistCandidates, checklistCandidatesFromGaps } from "@worker/seo/recommend/checklist-candidates";
import { dedupKeyFor, generateSeoRecommendations } from "@worker/seo/recommend/generate";
import { loadCandidateInputs } from "@worker/seo/recommend/inputs";
import { computePriority, PRIORITY_VERSION } from "@worker/seo/recommend/priority";
import { DAILY_CAP } from "@worker/recommendations/store";
import type { RunContext } from "@worker/runs/context";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";
import { makeTestContext } from "./helpers/context";
import { crawler, projectRow, seedCrawl, seedGsc, SITE_ROBOTS, type PageSeed } from "./checklists-seed";
import { fakeSite } from "./fixtures/crawl/fake-site";
import { fakeDecisions } from "./fixtures/gsc/site";

const ROBOTS_URL = "https://shop.example.com/robots.txt";
const ROBOTS_GOOGLEBOT_BLOCKED = `User-agent: *
Disallow: /cart
Disallow: /checkout

User-agent: Googlebot
Disallow: /

User-agent: GPTBot
Disallow: /
`;

const PRODUCTS = ["/products/brass-pull", "/products/brass-knob", "/products/brass-hook", "/products/brass-hinge", "/products/brass-latch"];

/** Home links to every page (no orphans); products carry Product JSON-LD without BreadcrumbList and no breadcrumb markup. */
function breadcrumbSite(extra: PageSeed[] = []): PageSeed[] {
  const paths = [...PRODUCTS, ...extra.map((p) => p.path)];
  return [
    { path: "/", pageType: "home", links: paths },
    ...PRODUCTS.map((path): PageSeed => ({ path, pageType: "product", jsonld: ["Product"], breadcrumbNav: false, links: ["/"] })),
    ...extra,
  ];
}

async function setup(opts: { pages: PageSeed[]; robots?: unknown; findings?: Array<{ ruleId: string; path: string | null; detail?: string }>; gsc?: Parameters<typeof seedGsc>[3] }) {
  const env = createTestEnv();
  const u = await seedUser(env);
  const pid = await seedProject(env, u.workspaceId);
  const db = new Db(env.DB);
  await seedCrawl(db, u.workspaceId, pid, { pages: opts.pages, robots: opts.robots, findings: opts.findings });
  if (opts.gsc) await seedGsc(db, u.workspaceId, pid, opts.gsc);
  const project = { id: pid, workspaceId: u.workspaceId };
  return { env, db, project, ctx: (o: Partial<RunContext> = {}) => makeTestContext(env, project, o) };
}

const recs = (db: Db, pid: string) =>
  db.all<{ id: string; issue_type: string; scope: string; target_json: string; action: string; limitations: string; suggested_snippet: string | null; priority: number; priority_version: string; evidence_ids_json: string; evidence_bullets_json: string; confirm_placeholders_json: string; dedup_key: string; decision_label: string | null; writer_provider: string | null }>(
    "SELECT * FROM recommendations WHERE project_id = ? ORDER BY priority DESC",
    pid,
  );
const decisions = (db: Db, pid: string) => db.all<{ candidate_key: string; outcome: string; reason_code: string | null; question_id: string | null }>("SELECT candidate_key, outcome, reason_code, question_id FROM decision_records WHERE project_id = ?", pid);

describe("agent integration: SEO checklist candidates", () => {
  it("missing breadcrumbs on 5 product pages -> one template-scope checklist candidate with checklist evidence", async () => {
    const s = await setup({ pages: breadcrumbSite() });
    const ctx = s.ctx();
    const inputs = await loadCandidateInputs(ctx);
    const res = await buildSeoChecklistCandidates(ctx, inputs, buildCandidates(inputs));
    expect(res.signals!.extraction).toBe("current");
    expect(res.candidates).toHaveLength(1);
    const c = res.candidates[0]!;
    expect(c).toMatchObject({ kind: "checklist", issueType: "checklist:seo.technical.breadcrumbs", scope: "template", jevDependent: false, severity: "moderate" });
    expect(c.target).toMatchObject({ kind: "template", template: "product template", affectedUrlCount: 5 });
    expect(c.target.exampleUrls).toHaveLength(3);
    const ev = c.evidence[0]!;
    expect(ev.source).toBe("crawl");
    expect(ev.text).toMatch(/^Checklist: Add breadcrumbs — /);
    expect(ev.data).toMatchObject({ checklistItemId: "seo.technical.breadcrumbs", checklistKind: "seo", checklistVersion: expect.stringMatching(/^checklists-/), status: "not_met", method: "measured" });
    expect((ev.data as { urls: string[] }).urls).toHaveLength(5);
    expect(await dedupKeyFor(s.project.id, c)).toMatch(/^seo:checklist:[0-9a-f]{24}$/);

    // End to end without Jev: deterministic, saved as one template recommendation citing the checklist evidence.
    const run = await generateSeoRecommendations(ctx);
    expect(run.created).toBe(1);
    const [r] = await recs(s.db, s.project.id);
    expect(r).toMatchObject({ issue_type: "checklist:seo.technical.breadcrumbs", scope: "template", priority_version: PRIORITY_VERSION, decision_label: null, writer_provider: null });
    expect(r!.action).toMatch(/BreadcrumbList/);
    expect(r!.action).toMatch(/Make the change once in the shared template/);
    expect(JSON.parse(r!.confirm_placeholders_json).length).toBeGreaterThan(0);
    const bullets = JSON.parse(r!.evidence_bullets_json) as Array<{ evidenceId: string; text: string }>;
    expect(bullets[0]!.text).toMatch(/^Checklist: Add breadcrumbs — /);
    const stored = await s.db.first<{ data_json: string }>("SELECT data_json FROM evidence WHERE id = ?", bullets[0]!.evidenceId);
    expect(JSON.parse(stored!.data_json)).toMatchObject({ checklistItemId: "seo.technical.breadcrumbs", checklistKind: "seo", status: "not_met", method: "measured" });
  });

  it("noindex is covered by the rule-based candidate: no checklist duplicate", async () => {
    const s = await setup({
      pages: breadcrumbSite().map((p) =>
        p.pageType !== "product" ? p : p.path === PRODUCTS[0] ? { ...p, robotsMeta: "noindex", jsonld: ["Product", "BreadcrumbList"], breadcrumbNav: true } : { ...p, jsonld: ["Product", "BreadcrumbList"], breadcrumbNav: true },
      ),
      findings: [{ ruleId: "SEO-NOINDEX", path: PRODUCTS[0]!, detail: "The page declares noindex." }],
    });
    const ctx = s.ctx();
    const project = await projectRow(s.db, s.project.id);
    const sig = await checklistSignals(s.env, s.db, project, FIXED_NOW, { kinds: ["seo", "geo", "page"] });
    const robotsItem = sig.items.seo.find((i) => i.id === "seo.technical.robots_noindex")!;
    expect(robotsItem.status).toBe("not_met");
    expect(COVERED_BY_RULES["seo.technical.robots_noindex"]!.rules).toContain("SEO-NOINDEX");
    expect(sig.excluded).toContainEqual({ kind: "seo", itemId: "seo.technical.robots_noindex", reason: "covered_by_rules" });
    expect(sig.excluded).toContainEqual({ kind: "geo", itemId: "geo.access.noindex_canonical", reason: "covered_by_rules" });
    expect(sig.gaps.some((g) => /noindex|indexability/.test(g.itemId))).toBe(false);

    const inputs = await loadCandidateInputs(ctx);
    const rules = buildCandidates(inputs);
    expect(rules.some((c) => c.issueType === "technical:SEO-NOINDEX")).toBe(true);
    const cl = await buildSeoChecklistCandidates(ctx, inputs, rules);
    expect(cl.candidates).toEqual([]);
  });

  it("manual and not_connected items never produce gaps or candidates", async () => {
    const s = await setup({ pages: breadcrumbSite(), gsc: [["brass pulls", PRODUCTS[0]!, "current", 5, 400, 8]] });
    const project = await projectRow(s.db, s.project.id);
    const sig = await checklistSignals(s.env, s.db, project, FIXED_NOW, { kinds: ["seo", "geo", "page"] });
    const evaluated = (g: (typeof sig.gaps)[number]) =>
      g.kind === "page" ? sig.items.pages.find((p) => p.pageId === g.pageId)!.items.find((i) => i.id === g.itemId)! : sig.items[g.kind].find((i) => i.id === g.itemId)!;
    for (const g of sig.gaps) {
      const item = evaluated(g);
      expect(["not_met", "partial"]).toContain(item.status);
      expect(["measured", "heuristic"]).toContain(item.method);
    }
    const all = [...sig.items.seo, ...sig.items.geo, ...sig.items.pages.flatMap((p) => p.items)];
    const manualOrNc = all.filter((i) => i.method === "manual" || i.status === "manual" || i.status === "not_connected");
    expect(manualOrNc.some((i) => i.status === "manual")).toBe(true);
    expect(manualOrNc.some((i) => i.status === "not_connected")).toBe(true);
    const manualIds = new Set(manualOrNc.map((i) => i.id));
    expect(sig.gaps.filter((g) => g.kind !== "page" && manualIds.has(g.itemId))).toEqual([]);
    const inputs = await loadCandidateInputs(s.ctx());
    for (const c of checklistCandidatesFromGaps(sig.gaps, inputs)) expect(manualIds.has(c.checklist!.itemId)).toBe(false);
    // Explicit examples from the reference checklists.
    for (const id of ["seo.technical.core_web_vitals", "seo.content.volume_kd", "geo.access.cdn_not_blocking", "geo.tracking.ai_referrals", "page.before_write.unique_angle"]) {
      expect(sig.gaps.some((g) => g.itemId === id)).toBe(false);
    }
  });

  it("a heuristic content gap without Jev is rejected decision_unavailable; with Jev it is judged", async () => {
    const pages: PageSeed[] = breadcrumbSite().map((p) =>
      p.path === PRODUCTS[0] ? { ...p, jsonld: ["Product", "BreadcrumbList"], breadcrumbNav: true, firstParagraph: "Handmade in small batches." } : p.pageType === "product" ? { ...p, jsonld: ["Product", "BreadcrumbList"], breadcrumbNav: true } : p,
    );
    const s = await setup({ pages, gsc: [["unlacquered brass drawer pull", PRODUCTS[0]!, "current", 4, 400, 7]] });
    const ctx = s.ctx({ decisions: null });
    const inputs = await loadCandidateInputs(ctx);
    const cl = await buildSeoChecklistCandidates(ctx, inputs, buildCandidates(inputs));
    const heuristic = cl.candidates.find((c) => c.checklist!.itemId === "seo.on_page.answer_first_lines")!;
    expect(heuristic).toMatchObject({ jevDependent: true, scope: "page", query: "unlacquered brass drawer pull" });
    expect(heuristic.checklist!.method).toBe("heuristic");

    const res = await generateSeoRecommendations(ctx);
    const key = await dedupKeyFor(s.project.id, heuristic);
    const dec = (await decisions(s.db, s.project.id)).filter((d) => d.candidate_key === key);
    expect(dec).toEqual([expect.objectContaining({ outcome: "rejected", reason_code: "decision_unavailable" })]);
    expect((await recs(s.db, s.project.id)).some((r) => r.issue_type === "checklist:seo.on_page.answer_first_lines")).toBe(false);
    expect(res.created).toBe(0);

    // With Jev: seo.action_choice is asked for the checklist candidate like other content candidates.
    const s2 = await setup({ pages, gsc: [["unlacquered brass drawer pull", PRODUCTS[0]!, "current", 4, 400, 7]] });
    const jev = fakeDecisions();
    // Other GSC/duplicate candidate kinds are switched off so the checklist candidate is the only content candidate.
    const ONLY_CHECKLIST = { minImpressions: 1e9, internalLinkMinImpressions: 1e9, decliningMinPrevClicks: 1e9, coverageGapMinQueryImpressions: 1e9, maxEngineQueries: 0, maxDuplicatePairs: 0 };
    await generateSeoRecommendations(s2.ctx({ decisions: jev }), { candidateConfig: ONLY_CHECKLIST });
    const req = jev.requests.find((r) => (r.state as { issue?: { type?: string } }).issue?.type === "checklist:seo.on_page.answer_first_lines")!;
    expect(Object.keys(req.questions)).toContain("seo.action_choice");
    const r = (await recs(s2.db, s2.project.id)).find((x) => x.issue_type === "checklist:seo.on_page.answer_first_lines");
    expect(r).toMatchObject({ scope: "page", decision_label: "act" });
    expect(JSON.parse(r!.target_json)).toEqual({ kind: "url", url: "https://shop.example.com/products/brass-pull" });
  });

  it("Googlebot blocked -> critical SEO recommendation with the advisor snippet that keeps /cart disallowed", async () => {
    const robots = SITE_ROBOTS({
      crawlers: [crawler("Googlebot", "search_engine", false), crawler("Bingbot", "search_engine", true), crawler("OAI-SearchBot", "answer_search", true), crawler("GPTBot", "training", false)],
    });
    const s = await setup({
      pages: breadcrumbSite().map((p) => (p.pageType === "product" ? { ...p, jsonld: ["Product", "BreadcrumbList"], breadcrumbNav: true } : p)),
      robots,
      findings: [{ ruleId: "AI-SEARCH-CRAWLER-BLOCKED", path: null, detail: "Googlebot (Google) is disallowed for the site root by robots.txt." }],
    });
    const site = fakeSite({ [ROBOTS_URL]: { status: 200, contentType: "text/plain", body: ROBOTS_GOOGLEBOT_BLOCKED } });
    const ctx = s.ctx({ crawlFetch: site.fetch });
    const res = await generateSeoRecommendations(ctx);
    expect(res.created).toBe(1);
    expect(site.urls()).toEqual([ROBOTS_URL]);
    expect(site.calls[0]!.init?.redirect).toBe("manual");
    const [r] = await recs(s.db, s.project.id);
    expect(r).toMatchObject({ issue_type: "checklist:robots_search_engine_blocked", scope: "site", writer_provider: null });
    // Critical, site-wide, low effort: the formula's maximum (no tier or reference input).
    expect(r!.priority).toBe(computePriority({ impressions: null, clicks: null, totalImpressions: null, totalClicks: null, severity: 1, reach: 1, effort: "low" }, "n/a"));
    expect(r!.priority).toBe(100);
    const parsed = parseRobots(r!.suggested_snippet!);
    const g = selectGroup(parsed, "Googlebot");
    expect(g!.agents).toContain("googlebot");
    expect(isPathAllowed(g, "/")).toBe(true);
    expect(isPathAllowed(g, "/products/brass-pull")).toBe(true);
    expect(isPathAllowed(g, "/cart")).toBe(false);
    expect(isPathAllowed(g, "/checkout")).toBe(false);
    // Training policy preserved (GPTBot stays blocked); "*" unchanged.
    expect(isPathAllowed(selectGroup(parsed, "GPTBot"), "/")).toBe(false);
    expect(isPathAllowed(selectGroup(parsed, "SomeOtherBot"), "/cart")).toBe(false);
    expect(r!.limitations).toMatch(/Okara never edits your robots\.txt/);
    expect(r!.limitations).toMatch(/Disallow: \/cart/);
    expect(r!.action).toMatch(/never edits your robots\.txt/);
    const evIds = JSON.parse(r!.evidence_ids_json) as string[];
    const ev = await s.db.all<{ source: string; text: string; data_json: string }>(`SELECT source, text, data_json FROM evidence WHERE id IN (${evIds.map(() => "?").join(",")})`, ...evIds);
    expect(ev.some((e) => e.text.includes("AI-SEARCH-CRAWLER-BLOCKED"))).toBe(true);
    expect(ev.some((e) => JSON.parse(e.data_json).checklistItemId === "seo.technical.robots_noindex")).toBe(true);
    expect(ev.some((e) => e.text.startsWith("robots.txt re-read from https://shop.example.com/robots.txt"))).toBe(true);
  });

  it("robots.txt re-read failure -> no snippet and a [confirm: current robots.txt] placeholder", async () => {
    const robots = SITE_ROBOTS({ crawlers: [crawler("Googlebot", "search_engine", false), crawler("Bingbot", "search_engine", false)] });
    const s = await setup({ pages: breadcrumbSite().map((p) => (p.pageType === "product" ? { ...p, jsonld: ["Product", "BreadcrumbList"], breadcrumbNav: true } : p)), robots });
    const ctx = s.ctx(); // default crawlFetch throws: network disabled
    const res = await generateSeoRecommendations(ctx);
    expect(res.created).toBe(1);
    const [r] = await recs(s.db, s.project.id);
    expect(r!.issue_type).toBe("checklist:robots_search_engine_blocked");
    expect(r!.suggested_snippet).toBeNull();
    expect(JSON.parse(r!.confirm_placeholders_json)).toContain("current robots.txt");
    expect(r!.action).toMatch(/Googlebot, Bingbot/);
    expect(r!.limitations).toMatch(/never edits your robots\.txt/);
  });

  it("a fresh robots.txt that no longer blocks the search engine produces no robots recommendation", async () => {
    const robots = SITE_ROBOTS({ crawlers: [crawler("Googlebot", "search_engine", false)] });
    const s = await setup({ pages: breadcrumbSite().map((p) => (p.pageType === "product" ? { ...p, jsonld: ["Product", "BreadcrumbList"], breadcrumbNav: true } : p)), robots });
    const site = fakeSite({ [ROBOTS_URL]: { status: 200, contentType: "text/plain", body: "User-agent: *\nDisallow: /cart\n" } });
    const inputs = await loadCandidateInputs(s.ctx());
    const cl = await buildSeoChecklistCandidates(s.ctx({ crawlFetch: site.fetch }), inputs, []);
    expect(cl.candidates).toEqual([]);
    expect(cl.notes.some((n) => /no longer blocks/.test(n))).toBe(true);
  });

  it("the reference tier (tacticTier) never changes priority", async () => {
    const s = await setup({ pages: breadcrumbSite() });
    const project = await projectRow(s.db, s.project.id);
    const inputs = await loadCandidateInputs(s.ctx());
    const def = SEO_ITEMS.find((d) => d.id === "seo.technical.breadcrumbs") as { tier: string | null };
    const original = def.tier;
    const run = async (tier: "S" | "D" | null) => {
      def.tier = tier;
      const sig = await checklistSignals(s.env, s.db, project, FIXED_NOW, { kinds: ["seo"] });
      expect(sig.items.seo.find((i) => i.id === "seo.technical.breadcrumbs")!.tacticTier).toBe(tier);
      const [c] = checklistCandidatesFromGaps(sig.gaps, inputs);
      return { inputs: c!.priority, priority: computePriority(c!.priority, "n/a") };
    };
    try {
      const a = await run("S");
      const b = await run("D");
      const n = await run(null);
      expect(a).toEqual(b);
      expect(a).toEqual(n);
    } finally {
      def.tier = original;
    }
  });

  it("the daily cap is still two, and reruns dedupe checklist recommendations", async () => {
    const robots = SITE_ROBOTS({ crawlers: [crawler("Googlebot", "search_engine", false)] });
    const pages = breadcrumbSite([
      { path: "/blog/care", pageType: "article", jsonld: ["BreadcrumbList"], links: ["/"] }, // no Article schema
      { path: "/pages/story", pageType: "landing", images: 4, imagesMissingAlt: 3, links: ["/"] },
    ]);
    const s = await setup({ pages, robots });
    const site = fakeSite({ [ROBOTS_URL]: { status: 200, contentType: "text/plain", body: ROBOTS_GOOGLEBOT_BLOCKED } });
    const first = await generateSeoRecommendations(s.ctx({ crawlFetch: site.fetch }));
    expect(DAILY_CAP).toBe(2);
    expect(first.created).toBe(2);
    expect(first.candidates).toBeGreaterThanOrEqual(4);
    const day1 = await recs(s.db, s.project.id);
    expect(day1.map((r) => r.issue_type)[0]).toBe("checklist:robots_search_engine_blocked");
    expect((await decisions(s.db, s.project.id)).some((d) => d.reason_code === "budget")).toBe(true);

    const again = await generateSeoRecommendations(s.ctx({ crawlFetch: site.fetch }));
    expect(again.created).toBe(0);
    expect(again.note).toMatch(/Daily limit reached/);

    // Next day: the two saved ones are duplicates, the rest may fill the new day's slots, never twice.
    const next = new Date(FIXED_NOW.getTime() + 86400_000);
    const day2 = await generateSeoRecommendations(s.ctx({ crawlFetch: site.fetch, clock: () => next }));
    const dupes = (await decisions(s.db, s.project.id)).filter((d) => d.reason_code === "duplicate");
    for (const r of day1) expect(dupes.some((d) => d.candidate_key === r.dedup_key)).toBe(true);
    const all = await recs(s.db, s.project.id);
    expect(new Set(all.map((r) => r.dedup_key)).size).toBe(all.length);
    expect(day2.created).toBeLessThanOrEqual(2);

    const day3 = await generateSeoRecommendations(s.ctx({ crawlFetch: site.fetch, clock: () => new Date(next.getTime() + 86400_000) }));
    const final = await recs(s.db, s.project.id);
    expect(new Set(final.map((r) => r.dedup_key)).size).toBe(final.length);
    expect(final.length).toBe(day1.length + day2.created + day3.created);
  });

  it("snapshots from before the checklist extraction do not feed checklist candidates", async () => {
    const s = await setup({ pages: breadcrumbSite().map((p) => ({ ...p, images: null, imagesMissingAlt: null, viewport: null, breadcrumbNav: null, genericAnchors: null })) });
    const project = await projectRow(s.db, s.project.id);
    const sig = await checklistSignals(s.env, s.db, project, FIXED_NOW, { kinds: ["seo", "page"] });
    expect(sig.extraction).toBe("legacy");
    expect(sig.gaps.filter((g) => g.source === "crawl")).toEqual([]);
    expect(sig.excluded.some((x) => x.reason === "stale_extraction")).toBe(true);
  });
});
