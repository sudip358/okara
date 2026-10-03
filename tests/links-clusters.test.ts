/**
 * Internal-links workbench, item 2: hubs (collections by URL pattern, pages the owner marks), spokes (articles and
 * products) assigned by owner / sheet Hub column / collection membership / existing links / TF-IDF, the missing
 * hub -> spoke and spoke -> hub links, owner overrides applied at read time, and the cluster-gap boost on suggestions.
 */
import { describe, expect, it } from "vitest";
import { Db } from "@worker/lib/db";
import { newId } from "@worker/lib/ids";
import { clusterGapFor, collectionHandle, spokeType, termCosine } from "@worker/links/clusters";
import { clusterReport } from "@worker/links/graph-read";
import { buildAndStoreLinkGraph, computeGraph, setHubOverride, setSpokeAssignment, sheetHubHandle } from "@worker/links/graph-store";
import { runLinkSuggestions } from "@worker/links/run";
import { CLUSTER_GAP_BOOST } from "@worker/links/priority";
import { normalizeUrlKey } from "@worker/seo/rules/registry";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";
import { U, projectRow, seedLinkCrawl, type LinkPageSeed } from "./links-seed";

async function setup() {
  const env = createTestEnv();
  const { workspaceId, userId } = await seedUser(env);
  const projectId = await seedProject(env, workspaceId);
  const db = new Db(env.DB);
  return { env, db, workspaceId, userId, projectId };
}

const PAGES: LinkPageSeed[] = [
  { path: "/", pageType: "home", title: "Home", links: ["/collections/chandeliers", "/collections/sconces"] },
  {
    path: "/collections/chandeliers",
    pageType: "collection",
    title: "Crystal Chandeliers | Shop",
    h1: ["Crystal Chandeliers"],
    links: ["/collections/chandeliers/products/crystal-chandelier"],
    anchors: [["/collections/chandeliers/products/crystal-chandelier", "Crystal chandelier", "c"]],
    sentences: ["Our crystal chandeliers bring sparkle to dining rooms and entryways."],
  },
  {
    path: "/collections/sconces",
    pageType: "collection",
    title: "Wall Sconces | Shop",
    h1: ["Wall Sconces"],
    headings: [{ level: 2, text: "Wall sconce height and placement" }],
    links: ["/products/brass-sconce"],
    anchors: [["/products/brass-sconce", "Brass sconce", "c"]],
    sentences: ["Wall sconces add layered light to hallways and bathrooms."],
  },
  { path: "/products/crystal-chandelier", pageType: "product", title: "Crystal Chandelier", h1: ["Crystal Chandelier"], links: [], anchors: [] },
  {
    path: "/products/brass-sconce",
    pageType: "product",
    title: "Brass Wall Sconce",
    h1: ["Brass Wall Sconce"],
    links: ["/collections/sconces"],
    anchors: [["/collections/sconces", "Wall Sconces", "b"]],
  },
  {
    path: "/blogs/news/chandelier-size-guide",
    pageType: "article",
    title: "Chandelier Size Guide",
    h1: ["How to choose a chandelier size"],
    links: ["/collections/chandeliers"],
    anchors: [["/collections/chandeliers", "crystal chandeliers", "c"]],
    sentences: ["Measure the room before you choose crystal chandeliers for a dining room.", "A chandelier should be about half the width of the table below it."],
  },
  {
    path: "/blogs/news/sconce-height",
    pageType: "article",
    title: "How high to hang wall sconces",
    h1: ["How high to hang wall sconces"],
    headings: [{ level: 2, text: "Wall sconce height in hallways" }],
    links: [],
    anchors: [],
    sentences: ["Hang wall sconces about five and a half feet above the floor in most hallways."],
  },
  { path: "/blogs/news/pendant-ideas", pageType: "article", title: "Pendant lighting ideas", h1: ["Pendant lighting ideas"], links: [], anchors: [], sentences: ["Pendants work well over kitchen islands and dining tables."] },
  { path: "/blogs/news/guide-x", pageType: "article", title: "Lighting basics", h1: ["Lighting basics"], links: [], anchors: [], sentences: ["Good lighting plans mix ambient, task and accent light in every room."] },
  { path: "/pages/lighting-guide", pageType: "landing", title: "Lighting guide", h1: ["Lighting guide"], links: [], anchors: [] },
];

async function seedSheetHub(db: Db, workspaceId: string, projectId: string, source: string, hub: string) {
  const id = newId("imp");
  await db.insert("import_records", {
    id: newId("irec"),
    workspace_id: workspaceId,
    project_id: projectId,
    destination: "implemented_links",
    record_key: `${source}>x`,
    label: "sheet row",
    status: "placed",
    data_json: JSON.stringify({ source: U(source), target: U("/collections/chandeliers"), anchor: "chandeliers", date: "2026-09-01", method: "wrap existing", hub }),
    source_key: "csv:Blog Hub Drops",
    first_import_id: id,
    last_import_id: id,
    created_at: FIXED_NOW.toISOString(),
    updated_at: FIXED_NOW.toISOString(),
  });
}

const key = (p: string) => normalizeUrlKey(U(p));

describe("clusters: helpers", () => {
  it("recognizes collection handles, spoke types, sheet hub cells, and term similarity", () => {
    expect(collectionHandle(U("/collections/Wall-Sconces"))).toBe("wall-sconces");
    expect(collectionHandle(U("/collections/a/b"))).toBeNull();
    expect(collectionHandle(U("/products/x"))).toBeNull();
    expect(spokeType({ url: U("/blogs/news/x"), pageType: "other" })).toBe("article");
    expect(spokeType({ url: U("/products/x"), pageType: "other" })).toBe("product");
    expect(spokeType({ url: U("/pages/x"), pageType: "landing" })).toBeNull();
    expect(sheetHubHandle("Chandeliers")).toBe("chandeliers");
    expect(sheetHubHandle("/collections/chandeliers")).toBe("chandeliers");
    expect(sheetHubHandle("https://shop.example.com/collections/sconces")).toBe("sconces");
    expect(sheetHubHandle("not a <handle>")).toBeNull();
    const t = (term: string, weight: number) => ({ term, label: term, score: weight, weight });
    expect(termCosine([t("sconce", 1)], [t("sconce", 1)])).toBe(1);
    expect(termCosine([t("sconce", 1)], [t("chandelier", 1)])).toBe(0);
  });
});

describe("clusters: hubs, spokes and gaps", () => {
  it("assigns each spoke with a labelled method and finds the missing links", async () => {
    const { db, workspaceId, userId, projectId } = await setup();
    await seedLinkCrawl(db, workspaceId, projectId, PAGES);
    await seedSheetHub(db, workspaceId, projectId, "/blogs/news/pendant-ideas", "chandeliers");
    const project = await projectRow(db, projectId);
    await setHubOverride(db, project, U("/pages/lighting-guide"), true, userId, FIXED_NOW);
    await setSpokeAssignment(db, project, U("/blogs/news/guide-x"), U("/pages/lighting-guide"), userId, FIXED_NOW);

    const g = (await computeGraph(db, project, { now: FIXED_NOW }))!;
    const id = (p: string) => g.graph.byKey.get(key(p))!.id;
    const spoke = (p: string) => g.clusters.spokes.get(id(p))!;
    const hubKey = (p: string) => g.graph.nodes[spoke(p).hub!]!.key;
    expect([...g.clusters.hubs.entries()].map(([i, src]) => [g.graph.nodes[i]!.key, src]).sort()).toEqual(
      [
        [key("/collections/chandeliers"), "collection"],
        [key("/collections/sconces"), "collection"],
        [key("/pages/lighting-guide"), "owner"],
      ].sort(),
    );
    expect(spoke("/products/crystal-chandelier")).toMatchObject({ method: "collection_membership", hubToSpoke: true, spokeToHub: false });
    expect(hubKey("/products/crystal-chandelier")).toBe(key("/collections/chandeliers"));
    expect(spoke("/products/brass-sconce")).toMatchObject({ method: "collection_membership", hubToSpoke: true, spokeToHub: true });
    expect(spoke("/blogs/news/chandelier-size-guide")).toMatchObject({ method: "existing_links", hubToSpoke: false, spokeToHub: true });
    expect(spoke("/blogs/news/sconce-height")).toMatchObject({ method: "tfidf", hubToSpoke: false, spokeToHub: false });
    expect(hubKey("/blogs/news/sconce-height")).toBe(key("/collections/sconces"));
    expect(spoke("/blogs/news/sconce-height").similarity!).toBeGreaterThanOrEqual(0.15);
    expect(spoke("/blogs/news/pendant-ideas")).toMatchObject({ method: "sheet" });
    expect(hubKey("/blogs/news/pendant-ideas")).toBe(key("/collections/chandeliers"));
    expect(spoke("/blogs/news/guide-x")).toMatchObject({ method: "owner" });
    expect(hubKey("/blogs/news/guide-x")).toBe(key("/pages/lighting-guide"));

    expect(clusterGapFor(g.clusters, id("/collections/chandeliers"), id("/blogs/news/chandelier-size-guide"))).toBe("hub_to_spoke");
    expect(clusterGapFor(g.clusters, id("/products/crystal-chandelier"), id("/collections/chandeliers"))).toBe("spoke_to_hub");
    expect(clusterGapFor(g.clusters, id("/products/brass-sconce"), id("/collections/sconces"))).toBeNull();
    expect(clusterGapFor(g.clusters, id("/"), id("/products/brass-sconce"))).toBeNull();
  });

  it("serves the cluster view and applies owner reassignments and hub changes at read time", async () => {
    const { db, workspaceId, userId, projectId } = await setup();
    await seedLinkCrawl(db, workspaceId, projectId, PAGES);
    const project = await projectRow(db, projectId);
    await buildAndStoreLinkGraph(db, project, { trigger: "manual", now: FIXED_NOW });
    const r = await clusterReport(db, project);
    const hub = (p: string) => r.hubs.find((h) => h.url === U(p))!;
    expect(hub("/collections/chandeliers").spokes.map((s) => [new URL(s.url).pathname, s.method, s.hubToSpoke, s.spokeToHub])).toEqual(
      expect.arrayContaining([
        ["/products/crystal-chandelier", "collection_membership", true, false],
        ["/blogs/news/chandelier-size-guide", "existing_links", false, true],
      ]),
    );
    expect(hub("/collections/sconces")).toMatchObject({ linked: 1, unlinked: 1 });
    expect(r.counts.unassigned).toBeGreaterThanOrEqual(1);
    expect(r.labels.join(" ")).toMatch(/TF-IDF/);

    // Reassign the sconce article to the chandeliers hub (stored, applied without a rebuild).
    await setSpokeAssignment(db, project, U("/blogs/news/sconce-height"), U("/collections/chandeliers"), userId, FIXED_NOW);
    const r2 = await clusterReport(db, project);
    const moved = r2.hubs.find((h) => h.url === U("/collections/chandeliers"))!.spokes.find((s) => s.url === U("/blogs/news/sconce-height"))!;
    expect(moved).toMatchObject({ method: "owner", methodLabel: "Set by you", hubToSpoke: false, spokeToHub: false });
    expect(r2.labels.join(" ")).toMatch(/Your hub changes are applied/);
    // Unmark the sconces hub: its remaining spoke waits for a rebuild (unassigned now).
    await setHubOverride(db, project, U("/collections/sconces"), false, userId, FIXED_NOW);
    const r3 = await clusterReport(db, project);
    expect(r3.hubs.some((h) => h.url === U("/collections/sconces"))).toBe(false);
    expect(r3.unassigned.map((u) => u.url)).toContain(U("/products/brass-sconce"));
    // Reset the reassignment and the hub flag: back to the automatic result after a rebuild.
    await setSpokeAssignment(db, project, U("/blogs/news/sconce-height"), undefined, userId, FIXED_NOW);
    await setHubOverride(db, project, U("/collections/sconces"), null, userId, FIXED_NOW);
    await buildAndStoreLinkGraph(db, project, { trigger: "manual", now: new Date(FIXED_NOW.getTime() + 1000) });
    const r4 = await clusterReport(db, project);
    expect(r4.hubs.find((h) => h.url === U("/collections/sconces"))!.spokes.map((s) => s.url)).toEqual(expect.arrayContaining([U("/blogs/news/sconce-height")]));
  });

  it("boosts suggestions that close a cluster gap and labels them", async () => {
    const { env, db, workspaceId, projectId } = await setup();
    await seedLinkCrawl(db, workspaceId, projectId, PAGES);
    const r = await runLinkSuggestions(env, db, await projectRow(db, projectId), FIXED_NOW, { decisions: null, writer: null });
    const gap = r.suggestions.find((s) => s.source.url === U("/collections/chandeliers") && s.target.url === U("/blogs/news/chandelier-size-guide"));
    expect(gap).toBeTruthy();
    expect(gap!.cluster).toMatchObject({ hubUrl: key("/collections/chandeliers"), gap: "hub_to_spoke" });
    expect(gap!.priority!.clusterFactor).toBe(CLUSTER_GAP_BOOST);
    expect(gap!.reasons.join(" ")).toMatch(/Closes a cluster gap: this hub page does not link to this spoke yet/);
    expect(gap!.anchor!.text.toLowerCase()).toContain("chandelier");
    // Pairs needing a new sentence (no sentence mentions the target) are counted for drafting, which needs a writer.
    expect(r.drafts).toMatchObject({ state: "setup_required" });
    expect(r.drafts!.candidates).toBeGreaterThan(0);
  });
});
