import { describe, expect, it } from "vitest";
import { buildCandidates, CANDIDATE_RULES_VERSION, positionBucket, type Candidate } from "@worker/seo/recommend/candidates";
import { draftDeterministic } from "@worker/seo/recommend/draft";
import { loadCandidateInputs } from "@worker/seo/recommend/inputs";
import { computePriority, EFFORT_FACTOR, metricSignal, PRIORITY_VERSION, priorityBreakdown, severityFromScore, SEVERITY_WEIGHT, type PriorityInputs } from "@worker/seo/recommend/priority";
import { ORIGIN, PRODUCT_ITEMS, U } from "./fixtures/gsc/site";
import { scenario } from "./fixtures/gsc/scenario";

const ENGINE_QUERIES = ["brass cabinet knob", "how to clean unlacquered brass", "outdoor brass lantern price"];

async function fixtureCandidates(opts: Parameters<typeof scenario>[0] = {}) {
  const s = await scenario({ engineQueries: ENGINE_QUERIES, ...opts });
  const inputs = await loadCandidateInputs(s.ctx());
  return { s, inputs, candidates: buildCandidates(inputs) };
}

const byKind = (cs: Candidate[], kind: Candidate["kind"]) => cs.filter((c) => c.kind === kind);

describe("candidate shortlist (" + CANDIDATE_RULES_VERSION + ")", () => {
  it("every candidate kind fires on the labelled fixture", async () => {
    const { candidates } = await fixtureCandidates();
    const kinds = new Set(candidates.map((c) => c.kind));
    expect([...kinds].sort()).toEqual(
      ["coverage_gap", "declining", "duplicate", "engine_query", "internal_link", "query_page_mismatch", "striking_distance", "technical", "weak_ctr"].sort(),
    );
    // Only technical candidates are deterministic; everything else needs Jev.
    for (const c of candidates) expect(c.jevDependent).toBe(c.kind !== "technical");
  });

  it("weak_ctr compares CTR with the median of the same position bucket", async () => {
    const { candidates } = await fixtureCandidates();
    const weak = byKind(candidates, "weak_ctr");
    expect(weak.map((c) => c.target.url)).toEqual([U.knob, U.knobLarge]);
    expect(weak[0]!.metrics).toMatchObject({ bucket: "4-10", bucketMedianCtr: 0.05, impressions: 2000, clicks: 10 });
    expect(weak[0]!.defaultAction).toBe("rewrite_title_meta");
    expect(positionBucket(3.4)).toBe("1-3");
    expect(positionBucket(20.4)).toBe("11-20");
    expect(positionBucket(25)).toBeNull();
  });

  it("striking_distance covers positions 4-20 and skips queries already flagged as weak CTR on the same page", async () => {
    const { candidates } = await fixtureCandidates();
    const sd = byKind(candidates, "striking_distance");
    expect(sd.map((c) => c.query)).toEqual(["cabinet hardware", "wall sconces", "brass sconces", "how to clean unlacquered brass"]);
    expect(sd.every((c) => Number(c.metrics.position) >= 4 && Number(c.metrics.position) <= 20)).toBe(true);
  });

  it("declining needs >= 30% click drop with >= 20 previous clicks", async () => {
    const { candidates } = await fixtureCandidates();
    const d = byKind(candidates, "declining");
    expect(d).toHaveLength(1);
    expect(d[0]!.target.url).toBe(U.hardware);
    expect(d[0]!.metrics).toMatchObject({ previousClicks: 200, clicks: 100, drop: 0.5 });
    // Knob went 14 -> 13 (below the 20-click minimum); sconces grew.
  });

  it("query_page_mismatch, coverage_gap and internal_link fire on the documented evidence", async () => {
    const { candidates } = await fixtureCandidates();
    const mm = byKind(candidates, "query_page_mismatch")[0]!;
    expect(mm.query).toBe("how to clean unlacquered brass");
    expect(mm.target).toMatchObject({ url: U.guide, exampleUrls: [U.guide, U.knob] });
    const gap = byKind(candidates, "coverage_gap")[0]!;
    expect(gap).toMatchObject({ query: "how to clean unlacquered brass", target: { url: U.knob } });
    const links = byKind(candidates, "internal_link");
    expect(links.map((c) => [c.target.url, c.metrics.inlinks])).toEqual([
      [U.knob, 1],
      [U.sconces, 0],
    ]);
  });

  it("[A6] engine search queries map to reinforce / improve / no_matching_page (human review)", async () => {
    const { candidates } = await fixtureCandidates();
    const eq = byKind(candidates, "engine_query");
    const m = Object.fromEntries(eq.map((c) => [c.query, c]));
    expect(m["brass cabinet knob"]!.engineMatch).toBe("reinforce");
    expect(m["how to clean unlacquered brass"]!.engineMatch).toBe("improve");
    const none = m["outdoor brass lantern price"]!;
    expect(none.engineMatch).toBe("no_matching_page");
    expect(none).toMatchObject({ scope: "site", reviewRequired: true, verified: false, defaultAction: "new_page_candidate" });
    expect(none.evidence[0]!.source).toBe("geo_observation");
    expect(none.evidence[0]!.text).toMatch(/API-sampled/);
  });

  it("[A9] ten product URLs sharing one issue produce ONE template candidate with 3 example URLs", async () => {
    const { candidates } = await fixtureCandidates();
    const offer = candidates.filter((c) => c.issueType === "technical:ECOM-PRODUCT-OFFER-INCOMPLETE");
    expect(offer).toHaveLength(1);
    const t = offer[0]!;
    expect(t.scope).toBe("template");
    expect(t.jevDependent).toBe(false);
    expect(t.target).toEqual({ kind: "template", template: "product template", affectedUrlCount: 10, exampleUrls: PRODUCT_ITEMS.slice(0, 3).map((p) => p.url) });
    expect(t.trigger).toBe("Template issue on 10 URLs");
    expect(t.evidence[0]!.text).toMatch(/affects 10 of 16 crawled URLs of type product/);
    expect((t.evidence[0]!.data as { templateAffectedUrls: number }).templateAffectedUrls).toBe(10);
    expect(t.evidence.filter((e) => e.source === "crawl")).toHaveLength(3);
    // The single-page finding stays page scope; the advisory site-level finding is below the minimum severity.
    expect(candidates.find((c) => c.issueType === "technical:SEO-META-DESC-MISSING")).toMatchObject({ scope: "page", target: { kind: "url", url: U.sconces } });
    expect(candidates.some((c) => c.issueType === "technical:AI-SEARCH-CRAWLER-BLOCKED")).toBe(false);
  });

  it("a non-templateable rule on several URLs becomes one site-scope candidate, not a template claim", async () => {
    const findings = PRODUCT_ITEMS.slice(0, 4).map((p) => ({ rule: "SEO-STATUS-4XX", severity: "major", url: p.url, template: null, detail: "The URL returned HTTP 404.", evidence: { pageType: "product" } }));
    const { candidates } = await fixtureCandidates({ findings });
    const tech = byKind(candidates, "technical");
    expect(tech).toHaveLength(1);
    expect(tech[0]).toMatchObject({ scope: "site", target: { kind: "site", affectedUrlCount: 4 } });
  });

  it("fewer URLs than the template minimum stay page-scope candidates", async () => {
    const findings = PRODUCT_ITEMS.slice(0, 2).map((p) => ({ rule: "ECOM-PRODUCT-OFFER-INCOMPLETE", severity: "moderate", url: p.url, template: null, detail: "Product JSON-LD: Offer has no price." }));
    const { candidates } = await fixtureCandidates({ findings });
    expect(byKind(candidates, "technical").map((c) => c.scope)).toEqual(["page", "page"]);
  });

  it("[A15] duplicate pairs: title overlap (brand tokens excluded) or shared GSC queries", async () => {
    const { candidates, inputs } = await fixtureCandidates();
    const dups = byKind(candidates, "duplicate");
    expect(dups).toHaveLength(1);
    expect(dups[0]!.target.exampleUrls).toEqual([U.knob, U.knobLarge]);
    expect(dups[0]!.sharedQueries).toEqual(["brass cabinet knob"]);
    expect(inputs.project.brandTokens).toEqual(expect.arrayContaining(["residence", "example", "resex"]));

    // Pages that share only the brand suffix are not candidates.
    const pages = [
      { url: `${ORIGIN}/pages/a`, type: "landing" as const, title: "Door Stops | Residence Example", h1: "Door Stops", headings: [], excerpt: "Door stops.", links: [] },
      { url: `${ORIGIN}/pages/b`, type: "landing" as const, title: "Wall Hooks | Residence Example", h1: "Wall Hooks", headings: [], excerpt: "Hooks.", links: [] },
      { url: `${ORIGIN}/pages/c`, type: "landing" as const, title: "Brass Wall Hooks Set | Residence Example", h1: "Brass Wall Hooks", headings: [], excerpt: "Hooks.", links: [] },
    ];
    const other = await fixtureCandidates({ pages, findings: [], gsc: null });
    const pairs = byKind(other.candidates, "duplicate").map((c) => c.target.exampleUrls!.slice().sort());
    expect(pairs).toEqual([[`${ORIGIN}/pages/b`, `${ORIGIN}/pages/c`]]);
  });

  it("caps duplicate pairs at 40", async () => {
    const pages = Array.from({ length: 12 }, (_, i) => ({
      url: `${ORIGIN}/pages/brass-hook-${i}`,
      type: "landing" as const,
      title: `Brass Wall Hook Style ${i}`,
      h1: "Brass Wall Hook",
      headings: [],
      excerpt: "Hook.",
      links: [],
    }));
    const { candidates } = await fixtureCandidates({ pages, findings: [], gsc: null });
    expect(byKind(candidates, "duplicate")).toHaveLength(40); // 66 possible pairs
  });

  it("tags query candidates with their demand segment (first-party impressions, not market volume)", async () => {
    const { candidates } = await fixtureCandidates();
    const sconces = byKind(candidates, "striking_distance").find((c) => c.query === "brass sconces")!;
    expect(sconces.demand).toMatchObject({ query: "brass sconces", segment: "long_tail", strongIntent: false });
    expect(sconces.metrics.demandSegment).toBe("long_tail");
    const gscEv = sconces.evidence.find((e) => e.source === "gsc")!;
    expect(gscEv.text).toMatch(/"brass sconces" is a long-tail query in this site's own Search Console impressions, not market search volume\./);
    expect((gscEv.data as { demand: { segment: string } }).demand.segment).toBe("long_tail");
    expect(byKind(candidates, "weak_ctr")[0]!.demand?.segment).toBe("head");
    expect(byKind(candidates, "declining")[0]!.demand).toBeNull();
  });

  it("only analyzable pages (2xx, not redirected) are content candidates", async () => {
    const s = await scenario({ gsc: null, findings: [] });
    const db = s.ctx().db;
    await db.run("UPDATE page_snapshots SET status_code = 404 WHERE final_url = ?", U.guide);
    await db.run("UPDATE page_snapshots SET final_url = ? WHERE final_url = ?", U.hardware, U.sconces);
    const inputs = await loadCandidateInputs(s.ctx());
    const urls = inputs.pages.map((p) => p.url);
    expect(urls).not.toContain(U.guide);
    expect(urls).not.toContain(U.sconces);
    expect(urls).toContain(U.knob);
  });

  it("candidate building is pure: same inputs, same candidates", async () => {
    const { inputs } = await fixtureCandidates();
    expect(JSON.stringify(buildCandidates(inputs))).toBe(JSON.stringify(buildCandidates(inputs)));
  });

  it("every candidate kind's deterministic draft passes the [A10]/[A17] validator (no invented numbers)", async () => {
    const { candidates } = await fixtureCandidates();
    for (const c of candidates) {
      const evidence = c.evidence.map((spec, i) => ({ id: `ev_${c.kind.replace(/_/g, "")}${i}`, spec }));
      const res = draftDeterministic({ candidate: c, action: c.defaultAction, tier: c.jevDependent ? "act" : "n/a", intent: null, severityScore: null, evidence, contextDocs: [] });
      expect(res.ok, `${c.key}: ${res.ok ? "" : res.errors.join("; ")}`).toBe(true);
      if (!res.ok) continue;
      expect(res.draft.evidenceBullets.length).toBeGreaterThanOrEqual(2);
      expect(res.draft.evidenceBullets.length).toBeLessThanOrEqual(4);
      expect(res.draft.confirmPlaceholders.length).toBeGreaterThan(0);
      expect(res.draft.action).toMatch(/\[ev_/);
      if (c.demand) expect(res.draft.rationale).toMatch(/is a (head|middle|long-tail) query/);
    }
  });
});

describe("priority formula (" + PRIORITY_VERSION + ")", () => {
  const base: PriorityInputs = { impressions: null, clicks: null, totalImpressions: 50000, totalClicks: 300, severity: null, reach: null, effort: "low" };

  it("metric signal = sqrt(max(impression share, click share))", () => {
    expect(metricSignal({ impressions: 500, clicks: 3, totalImpressions: 50000, totalClicks: 300 })).toBeCloseTo(0.1, 12); // both 1%
    expect(metricSignal({ impressions: 500, clicks: 75, totalImpressions: 50000, totalClicks: 300 })).toBeCloseTo(0.5, 12); // clicks 25%
    expect(metricSignal({ impressions: null, clicks: null, totalImpressions: 50000, totalClicks: 300 })).toBeNull();
    expect(metricSignal({ impressions: 10, clicks: 1, totalImpressions: 0, totalClicks: 0 })).toBeNull();
  });

  it("missing components are dropped and the weights renormalized, never defaulted", () => {
    const onlySeverity = priorityBreakdown({ ...base, severity: 0.5 }, "n/a");
    expect(onlySeverity.base).toBeCloseTo(0.5, 12);
    expect(onlySeverity.metric).toBeNull();
    expect(onlySeverity.priority).toBe(50);
    expect(priorityBreakdown(base, "n/a").priority).toBe(0);
    // metric 0.1 (w .45) + severity 0.5 (w .35) + reach 1 (w .2) = (0.045 + 0.175 + 0.2) / 1
    expect(computePriority({ ...base, impressions: 500, clicks: 3, severity: 0.5, reach: 1 }, "act")).toBe(42);
  });

  it("effort and tier multipliers; drop is excluded", () => {
    const i = { ...base, severity: 1 };
    expect(computePriority(i, "act")).toBe(100);
    expect(computePriority({ ...i, effort: "medium" }, "act")).toBe(100 * EFFORT_FACTOR.medium);
    expect(computePriority({ ...i, effort: "high" }, "act")).toBe(70);
    expect(computePriority(i, "flag")).toBe(70);
    expect(computePriority(i, "n/a")).toBe(100);
    expect(computePriority(i, null)).toBe(100);
    expect(computePriority(i, "drop")).toBeNull();
  });

  it("[A16] with equal severity, a site-wide issue outranks a single-page one", () => {
    const sev = SEVERITY_WEIGHT.minor;
    const siteWide = computePriority({ ...base, severity: sev, reach: 20 / 20, effort: "medium" }, "n/a")!;
    const onePage = computePriority({ ...base, severity: sev, reach: 1 / 20, effort: "medium" }, "n/a")!;
    expect(siteWide).toBeGreaterThan(onePage);
  });

  it("a critical issue outranks a cosmetic one even at lower reach", () => {
    const critical = computePriority({ ...base, severity: SEVERITY_WEIGHT.critical, reach: 1 / 20 }, "n/a")!;
    const cosmetic = computePriority({ ...base, severity: SEVERITY_WEIGHT.advisory, reach: 1 }, "n/a")!;
    expect(critical).toBeGreaterThan(cosmetic);
  });

  it("maps seo.issue_severity levels (0-4) to 0..1", () => {
    expect(severityFromScore(0)).toBe(0);
    expect(severityFromScore(2)).toBe(0.5);
    expect(severityFromScore(4)).toBe(1);
    expect(severityFromScore(9)).toBe(1);
  });
});
