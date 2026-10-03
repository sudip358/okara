/**
 * Hubs and clusters (internal-links workbench 2026-10-03, item 2). Pure over the link graph (graph.ts).
 *
 * Hubs (CLUSTERS_VERSION):
 *   - collection: a collection page by URL pattern /collections/<handle> (one path segment after /collections),
 *     analysable (HTTP 2xx, not redirected);
 *   - sheet: /collections/<handle> named in the Hub column of links imported from the owner's sheet;
 *   - owner: any page the owner marked as a hub. An owner "not a hub" mark removes a detected hub.
 * Spokes: indexable blog articles (/blogs/<blog>/<article>, or page type article) and products (/products/<p>, or
 * page type product). Each spoke gets at most one hub; the method is stored per assignment, in this order:
 *   1. owner                  the owner's reassignment (or "no hub");
 *   2. sheet                  the imported sheet's Hub column for that source article;
 *   3. collection_membership  products listed on a collection page (a content link from the hub to the product, or to a
 *                             collection-scoped / variant URL of it); several -> the most similar hub;
 *   4. existing_links         content or breadcrumb links between the spoke and a hub (either direction); the hub with the
 *                             most links wins, ties by similarity;
 *   5. tfidf                  the hub whose title/H1/heading terms are most similar (cosine of TF-IDF weights,
 *                             terms.ts) when the similarity is at least MIN_SIMILARITY;
 *   otherwise unassigned.
 * Gaps per spoke: hub -> spoke (the hub links to the spoke, directly or through its redirect/canonical variants; true
 * by definition for collection_membership) and spoke -> hub (content or breadcrumb link from the spoke). Linked = both,
 * partial = one, unlinked = neither. Suggestions that add a missing link get the cluster-gap priority boost.
 */
import { computeDefiningTerms, type DefiningTerm } from "./terms";
import type { GraphNode, LinkGraph } from "./graph";

export const CLUSTERS_VERSION = "links-clusters-2026-10-03.1";
export const MIN_SIMILARITY = 0.15;

export type HubSource = "collection" | "sheet" | "owner";
export type AssignMethod = "owner" | "sheet" | "collection_membership" | "existing_links" | "tfidf";

export interface ClusterOverrides {
  /** page key -> true (mark as hub) | false (not a hub). */
  hubs: ReadonlyMap<string, boolean>;
  /** spoke key -> hub key, or "" for "no hub". */
  assign: ReadonlyMap<string, string>;
}

export interface SheetHubHint {
  /** Source article key. */
  spokeKey: string;
  /** Collection handle from the sheet's Hub column. */
  handle: string;
}

export interface SpokeAssignment {
  spoke: number;
  hub: number | null;
  method: AssignMethod | null;
  similarity: number | null;
  hubToSpoke: boolean;
  spokeToHub: boolean;
}

export interface ClusterModel {
  hubs: Map<number, HubSource>;
  spokes: Map<number, SpokeAssignment>;
  /** Hub key -> hub node id. */
  hubByKey: Map<string, number>;
}

const COLLECTION_RE = /^\/collections\/([^/]+)\/?$/i;
const ARTICLE_RE = /^\/blogs\/[^/]+\/[^/]+\/?$/i;
const PRODUCT_RE = /^\/products\/[^/]+\/?$/i;

export function collectionHandle(url: string): string | null {
  try {
    const m = COLLECTION_RE.exec(new URL(url).pathname);
    return m ? decodeURIComponent(m[1]!).toLowerCase() : null;
  } catch {
    return null;
  }
}

export function spokeType(n: Pick<GraphNode, "url" | "pageType">): "article" | "product" | null {
  let path = "";
  try {
    path = new URL(n.url).pathname;
  } catch {
    return null;
  }
  if (ARTICLE_RE.test(path) || n.pageType === "article") return "article";
  if (PRODUCT_RE.test(path) || n.pageType === "product") return "product";
  return null;
}

/** Cosine similarity of two defining-term lists (weights 0..1). */
export function termCosine(a: readonly DefiningTerm[], b: readonly DefiningTerm[]): number {
  if (!a.length || !b.length) return 0;
  const wb = new Map(b.map((t) => [t.term, t.weight]));
  let dot = 0;
  for (const t of a) dot += t.weight * (wb.get(t.term) ?? 0);
  const na = Math.sqrt(a.reduce((s, t) => s + t.weight * t.weight, 0));
  const nb = Math.sqrt(b.reduce((s, t) => s + t.weight * t.weight, 0));
  return na > 0 && nb > 0 ? Math.round((dot / (na * nb)) * 10_000) / 10_000 : 0;
}

/** Ids a node reaches (directly, or through each target's redirect/canonical credit). */
function reach(graph: LinkGraph, from: GraphNode, contentOnly: boolean): Set<number> {
  const out = new Set<number>();
  for (const tid of contentOnly ? from.outContent : from.outAll) {
    out.add(tid);
    const t = graph.nodes[tid]!;
    for (const k of [t.finalKey, t.canonicalKey]) {
      const n = k ? graph.byKey.get(k) : undefined;
      if (n) out.add(n.id);
    }
  }
  return out;
}

export function buildClusters(graph: LinkGraph, opts: { overrides?: ClusterOverrides; sheetHubs?: readonly SheetHubHint[]; extraStop?: ReadonlySet<string> } = {}): ClusterModel {
  const overrides = opts.overrides ?? { hubs: new Map(), assign: new Map() };
  const hubs = new Map<number, HubSource>();
  // 1. Hubs.
  for (const n of graph.nodes) {
    if (!n.analyzable) continue;
    if (collectionHandle(n.url)) hubs.set(n.id, "collection");
  }
  const handleToHub = new Map<string, number>();
  for (const n of graph.nodes) {
    const h = collectionHandle(n.url);
    if (h && n.snap && !n.issue) handleToHub.set(h, n.id);
  }
  for (const s of opts.sheetHubs ?? []) {
    const id = handleToHub.get(s.handle.toLowerCase());
    if (id !== undefined && !hubs.has(id)) hubs.set(id, "sheet");
  }
  for (const [key, isHub] of overrides.hubs) {
    const n = graph.byKey.get(key);
    if (!n) continue;
    if (isHub) hubs.set(n.id, "owner");
    else hubs.delete(n.id);
  }
  const hubByKey = new Map<string, number>();
  for (const id of hubs.keys()) hubByKey.set(graph.nodes[id]!.key, id);

  // 2. Spokes and term vectors (title, H1 and headings only: the same for every build, sentences not needed).
  const spokeIds = graph.nodes.filter((n) => n.indexable && !hubs.has(n.id) && spokeType(n) !== null).map((n) => n.id);
  const docs = [...hubs.keys(), ...spokeIds].map((id) => {
    const n = graph.nodes[id]!;
    return { id: String(id), title: n.title, h1s: n.h1 ? [n.h1] : [], headings: n.headings.slice(0, 20), sentences: [] as string[] };
  });
  const terms = computeDefiningTerms(docs, { extraStop: opts.extraStop });
  const termsOf = (id: number) => terms.get(String(id)) ?? [];
  const hubList = [...hubs.keys()];
  const reachContent = new Map<number, Set<number>>();
  const reachOf = (id: number) => {
    let r = reachContent.get(id);
    if (!r) {
      r = reach(graph, graph.nodes[id]!, true);
      reachContent.set(id, r);
    }
    return r;
  };
  const sheetBySpoke = new Map<string, string>();
  for (const s of opts.sheetHubs ?? []) if (!sheetBySpoke.has(s.spokeKey)) sheetBySpoke.set(s.spokeKey, s.handle.toLowerCase());

  const spokes = new Map<number, SpokeAssignment>();
  for (const sid of spokeIds) {
    const n = graph.nodes[sid]!;
    const type = spokeType(n);
    const sim = (hid: number) => termCosine(termsOf(sid), termsOf(hid));
    let hub: number | null = null;
    let method: AssignMethod | null = null;
    let similarity: number | null = null;
    const owner = overrides.assign.get(n.key);
    if (owner !== undefined) {
      method = "owner";
      hub = owner === "" ? null : (hubByKey.get(owner) ?? null);
      if (owner !== "" && hub === null) {
        // The owner's hub is not a hub (any more): treat the page as a hub for this assignment.
        const h = graph.byKey.get(owner);
        if (h) {
          hubs.set(h.id, "owner");
          hubByKey.set(h.key, h.id);
          hub = h.id;
        }
      }
    }
    if (method === null) {
      const handle = sheetBySpoke.get(n.key);
      const hid = handle ? handleToHub.get(handle) : undefined;
      if (hid !== undefined && hubs.has(hid)) {
        hub = hid;
        method = "sheet";
      }
    }
    if (method === null && type === "product") {
      const listing = hubList.filter((hid) => reachOf(hid).has(sid));
      if (listing.length) {
        const best = listing.map((hid) => ({ hid, s: sim(hid) })).sort((a, b) => b.s - a.s || a.hid - b.hid)[0]!;
        hub = best.hid;
        method = "collection_membership";
        similarity = best.s;
      }
    }
    if (method === null) {
      const mine = reachOf(sid);
      const counts = hubList
        .map((hid) => ({ hid, n: (mine.has(hid) ? 1 : 0) + (reachOf(hid).has(sid) ? 1 : 0) }))
        .filter((c) => c.n > 0);
      if (counts.length) {
        const best = counts.map((c) => ({ ...c, s: sim(c.hid) })).sort((a, b) => b.n - a.n || b.s - a.s || a.hid - b.hid)[0]!;
        hub = best.hid;
        method = "existing_links";
        similarity = best.s;
      }
    }
    if (method === null && hubList.length) {
      const best = hubList.map((hid) => ({ hid, s: sim(hid) })).sort((a, b) => b.s - a.s || a.hid - b.hid)[0]!;
      if (best.s >= MIN_SIMILARITY) {
        hub = best.hid;
        method = "tfidf";
        similarity = best.s;
      }
    }
    if (hub !== null && similarity === null) similarity = sim(hub);
    const hubToSpoke = hub !== null && (method === "collection_membership" || reachOf(hub).has(sid));
    const spokeToHub = hub !== null && reachOf(sid).has(hub);
    spokes.set(sid, { spoke: sid, hub, method, similarity, hubToSpoke, spokeToHub });
  }
  return { hubs, spokes, hubByKey };
}

/** The gap a source -> target link would close: "hub_to_spoke", "spoke_to_hub", or null. */
export function clusterGapFor(model: ClusterModel, source: number, target: number): "hub_to_spoke" | "spoke_to_hub" | null {
  const t = model.spokes.get(target);
  if (t && t.hub === source && !t.hubToSpoke) return "hub_to_spoke";
  const s = model.spokes.get(source);
  if (s && s.hub === target && !s.spokeToHub) return "spoke_to_hub";
  return null;
}

export const ASSIGN_METHOD_LABEL: Record<AssignMethod, string> = {
  owner: "Set by you",
  sheet: "From your sheet (Hub column)",
  collection_membership: "Listed on the collection page",
  existing_links: "Existing links",
  tfidf: "Term overlap (TF-IDF)",
};

export const HUB_SOURCE_LABEL: Record<HubSource, string> = {
  collection: "Collection (URL pattern)",
  sheet: "Hub in your sheet",
  owner: "Marked by you",
};
