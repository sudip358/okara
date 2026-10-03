/**
 * Internal-links workbench, item 6: anchor text audit over content links (navigation and breadcrumb links excluded):
 * distinct anchors, exact-match share against the top Search Console query (or the H1 without Search Console),
 * repeated identical anchors, generic and empty anchors, anchors without the page's query terms; documented thresholds;
 * new suggestions avoid an anchor that would worsen over-repetition.
 */
import { describe, expect, it } from "vitest";
import { Db } from "@worker/lib/db";
import { ANCHOR_AUDIT_VERSION, ANCHOR_THRESHOLDS, auditAllAnchors, worsensRepetition } from "@worker/links/anchor-audit";
import { anchorReport } from "@worker/links/graph-read";
import { buildAndStoreLinkGraph } from "@worker/links/graph-store";
import { runLinkSuggestions } from "@worker/links/run";
import { normalizeUrlKey } from "@worker/seo/rules/registry";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";
import { U, projectRow, seedGscImpressions, seedLinkCrawl, type LinkPageSeed } from "./links-seed";

const T = "/collections/chandeliers";
const LAMP = "/products/oak-lamp";
const GUIDE = "/blogs/news/lamp-care";

function site(): LinkPageSeed[] {
  const pages: LinkPageSeed[] = [
    {
      path: T,
      pageType: "collection",
      title: "Brass Chandeliers | Shop",
      h1: ["Brass Chandeliers"],
      sentences: ["Our brass chandeliers are hand finished in the workshop.", "Each chandelier hangs from a solid brass chain and ceiling canopy."],
      anchors: [],
    },
    { path: LAMP, pageType: "product", title: "Oak Table Lamp", h1: ["Oak Table Lamp"], sentences: ["An oak table lamp with a linen shade."], anchors: [] },
    { path: GUIDE, pageType: "article", title: "Lamp care guide", h1: ["Lamp care guide"], sentences: ["Dust the shade weekly and tighten the bulb holder."], anchors: [] },
    // A product page with a breadcrumb back to the collection: excluded from the audit.
    { path: "/products/crystal-chandelier", pageType: "product", title: "Crystal Chandelier", sentences: ["A crystal chandelier for a dining room."], anchors: [[T, "Chandeliers", "b"]] },
  ];
  for (let i = 1; i <= 12; i++) {
    const anchors: Array<[string, string, "c" | "i" | "b"]> = [];
    // 10 exact-match anchors, one generic, one empty.
    anchors.push([T, i <= 10 ? "brass chandeliers" : i === 11 ? "click here" : "", "c"]);
    if (i <= 3) anchors.push([LAMP, ["our wooden light", "a bedside light", "the wood fixture"][i - 1]!, "c"]);
    if (i <= 2) anchors.push([GUIDE, "lamp care guide", "c"]);
    if (i === 3) anchors.push([GUIDE, "caring for lamps", "c"]);
    pages.push({ path: `/blogs/news/notes-${i}`, pageType: "article", title: `Workshop notes ${i}`, sentences: [`Workshop notes number ${i} about finishing wood.`], anchors });
  }
  return pages;
}

async function setup() {
  const env = createTestEnv();
  const { workspaceId } = await seedUser(env);
  const projectId = await seedProject(env, workspaceId);
  const db = new Db(env.DB);
  await seedLinkCrawl(db, workspaceId, projectId, site());
  await seedGscImpressions(db, workspaceId, projectId, [
    { path: T, impressions: 900, query: "brass chandeliers" },
    { path: T, impressions: 300, query: "brass chandelier" },
    { path: LAMP, impressions: 400, query: "oak table lamp" },
  ]);
  return { env, db, workspaceId, projectId, project: await projectRow(db, projectId) };
}

describe("anchor audit", () => {
  it("flags exact-match heavy, repeated, generic and empty anchors with the threshold crossed", async () => {
    const { db, project } = await setup();
    const built = (await buildAndStoreLinkGraph(db, project, { trigger: "manual", now: FIXED_NOW }))!;
    const audits = auditAllAnchors(built.graph);
    const node = (p: string) => built.graph.byKey.get(normalizeUrlKey(U(p)))!;

    const t = audits.get(node(T).id)!;
    expect(t.keyword).toBe("brass chandeliers");
    expect(t.keywordBasis).toBe("search_console_query");
    expect(t.anchoredInlinks).toBe(11); // the empty anchor and the breadcrumb are not anchored content links
    expect(t.distinctAnchors).toBe(2);
    expect(t.exactMatchSources).toBe(10);
    expect(t.exactMatchShare).toBeCloseTo(10 / 11, 3);
    expect(t.emptyAnchors).toBe(1);
    expect(t.top.map((a) => a.text)).toEqual(["brass chandeliers", "click here"]);
    expect(t.flags).toEqual(["exact_match_heavy", "repeated_anchor", "generic_anchor", "empty_anchor"]);
    expect(t.reasons[0]).toBe('91% of 11 anchored links use the exact-match anchor "brass chandeliers" (threshold: more than 50% with at least 5 links).');
    expect(t.reasons[1]).toBe('"brass chandeliers" is used by 10 of 11 anchored links (threshold: at least 10 sources and 60%).');
    expect(t.reasons[2]).toBe('Generic anchor text: "click here" (1).');
    expect(t.reasons[3]).toBe("1 content link has no anchor text (no text, image alt, or aria-label).");
    expect(t.flags).not.toContain("no_query_terms");

    const lamp = audits.get(node(LAMP).id)!;
    expect(lamp.anchoredInlinks).toBe(3);
    expect(lamp.queryTerms.length).toBeGreaterThan(0);
    expect(lamp.flags).toEqual(["no_query_terms"]);
    expect(lamp.reasons[0]).toMatch(/None of the 3 anchor texts contains a term of the page's top Search Console queries \("oak table lamp"\)/);

    const guide = audits.get(node(GUIDE).id)!;
    expect(guide.keywordBasis).toBe("h1");
    expect(guide.keyword).toBe("Lamp care guide");
    expect(guide.exactMatchSources).toBe(2);
    expect(guide.flags).toEqual([]); // 3 anchored links: below the exact-match minimum of 5

    // A breadcrumb-only target is not audited.
    expect(audits.has(node("/products/crystal-chandelier").id)).toBe(false);
  });

  it("documents the thresholds, and says when one more identical anchor would worsen repetition", async () => {
    expect(ANCHOR_THRESHOLDS).toEqual({ MIN_ANCHORED_INLINKS: 3, EXACT_MATCH_SHARE: 0.5, EXACT_MATCH_MIN_INLINKS: 5, REPEATED_MIN_SOURCES: 10, REPEATED_SHARE: 0.6 });
    const { db, project } = await setup();
    const built = (await buildAndStoreLinkGraph(db, project, { trigger: "manual", now: FIXED_NOW }))!;
    const audits = auditAllAnchors(built.graph);
    const id = (p: string) => built.graph.byKey.get(normalizeUrlKey(U(p)))!.id;
    expect(worsensRepetition(audits.get(id(T)), "Brass Chandeliers")).toBe(true);
    expect(worsensRepetition(audits.get(id(T)), "hand-finished chandeliers")).toBe(false);
    expect(worsensRepetition(audits.get(id(GUIDE)), "lamp care guide")).toBe(false); // 4 links after: under the minimum
    expect(worsensRepetition(null, "anything")).toBe(false);

    const report = await anchorReport(db, project);
    expect(report.state).toBe("ready");
    expect(report.thresholds).toMatchObject({ EXACT_MATCH_SHARE: 0.5, REPEATED_MIN_SOURCES: 10 });
    expect(report.labels.join(" ")).toContain(ANCHOR_AUDIT_VERSION);
    const urls = report.rows.map((r) => r.url);
    expect(urls).toContain(U(T));
    expect(urls).toContain(U(LAMP));
    expect(urls).not.toContain(U(GUIDE)); // flagged rows only by default
    const all = await anchorReport(db, project, { flaggedOnly: false });
    expect(all.rows.map((r) => r.url)).toContain(U(GUIDE));
  });

  it("new suggestions avoid the over-used anchor and say so", async () => {
    const { env, db, workspaceId, projectId } = await setup();
    await seedLinkCrawl(db, workspaceId, projectId, [
      {
        path: "/blogs/news/dining-lighting",
        pageType: "article",
        title: "Dining room lighting",
        h1: ["Dining room lighting"],
        sentences: ["A pair of hand finished brass chandeliers over the dining table gives soft, even light."],
        anchors: [],
      },
    ]);
    const r = await runLinkSuggestions(env, db, await projectRow(db, projectId), FIXED_NOW, { decisions: null, writer: null });
    const s = r.suggestions.find((x) => x.source.url === U("/blogs/news/dining-lighting") && x.target.url === U(T));
    expect(s).toBeTruthy();
    expect(s!.anchor!.text.toLowerCase()).not.toBe("brass chandeliers");
    expect(s!.reasons.join(" ")).toMatch(/anchor option.* already over-used for this target \(anchor audit\)|Every anchor option is already common for this target/);
  });
});
