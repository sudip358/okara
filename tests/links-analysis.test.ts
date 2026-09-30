/** [A25] Deterministic analysis: TF-IDF terms, candidate targets, sentences, anchors. */
import { describe, expect, it } from "vitest";
import { anchorCandidates, deterministicPick, isGenericAnchor, MAX_ANCHORS_PER_PAIR } from "@worker/links/anchors";
import { candidateTargets, gscBoost, MAX_TARGETS_PER_SOURCE, ORPHAN_BOOST, type LinkPage } from "@worker/links/candidates";
import { rankSentences } from "@worker/links/sentences";
import { brandStopwords, computeDefiningTerms, stem, termStems, TOP_TERMS, type DefiningTerm } from "@worker/links/terms";

describe("links: TF-IDF defining terms", () => {
  it("stems plurals and drops stopwords, numbers, short tokens, and brand words", () => {
    expect(["sofas", "boxes", "batteries", "glasses", "benches", "brass", "status", "series", "sizes", "oxidizes", "buzzes"].map(stem)).toEqual([
      "sofa", "box", "battery", "glass", "bench", "brass", "status", "series", "size", "oxidize", "buzz",
    ]);
    const brand = brandStopwords("Residence Example", ["ResEx"]);
    expect(termStems("The 3 Residence brass pulls are here and ResEx polishes them in 2026", brand)).toEqual(["brass", "pull", "polish"]);
  });

  it("weights title x3, H1 x3, headings x2, sentences x1 and keeps the top 12 by tf x idf", () => {
    const docs = [
      { id: "a", title: "Brass hinges", h1s: [], headings: [], sentences: ["Cabinet cabinet cabinet doors swing on hinges."] },
      { id: "b", title: "Oak tables", h1s: ["Oak side tables"], headings: ["Finishes"], sentences: ["Tables need coasters."] },
      { id: "c", title: "Lamps", h1s: [], headings: [], sentences: ["Brass lamps with linen shades."] },
    ];
    const terms = computeDefiningTerms(docs);
    const a = terms.get("a")!;
    // "hinge": title x3 + sentence x1 = 4, df 1; "cabinet": 3 sentence mentions, df 1; "brass": title x3 but df 2 (lower idf).
    expect(a[0]!.term).toBe("hinge");
    expect(a[0]!.weight).toBe(1);
    const byTerm = new Map(a.map((t) => [t.term, t]));
    expect(byTerm.get("cabinet")!.score).toBeLessThan(byTerm.get("hinge")!.score);
    expect(byTerm.get("brass")!.score).toBeLessThan(byTerm.get("hinge")!.score);
    // b: "table" appears in title (x3), H1 (x3), and a sentence (x1) = 7; "finish" only in a heading (x2).
    const b = terms.get("b")!;
    expect(b[0]).toMatchObject({ term: "table", label: "tables" });
    expect(b.find((t) => t.term === "finish")!.score).toBeCloseTo((2 * (Math.log(4 / 2) + 1)), 4);

    const long = computeDefiningTerms([{ id: "x", title: null, h1s: [], headings: [], sentences: [Array.from({ length: 30 }, (_, i) => `term${String.fromCharCode(97 + (i % 26))}${i}`).join(" ")] }]);
    expect(long.get("x")).toHaveLength(TOP_TERMS);
  });

  it("treats vocabulary on more than 80% of pages (5+ pages) as site-wide, not defining", () => {
    const docs = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, title: `Brass item${"abcde"[i]}`, h1s: [], headings: [], sentences: [] }));
    const terms = computeDefiningTerms(docs);
    for (const t of terms.values()) expect(t.map((x) => x.term)).not.toContain("brass");
  });
});

// ------------------------------------------------------------------------------------------ candidates

const H = "shop.example.com";
const url = (p: string) => (p.startsWith("http") ? p : `https://${H}${p}`);

function page(id: string, path: string, over: Partial<LinkPage> = {}): LinkPage {
  return {
    pageId: id,
    url: url(path),
    pageType: "article",
    statusCode: 200,
    finalUrl: url(path),
    skippedReason: null,
    robotsMeta: null,
    canonical: url(path),
    title: null,
    h1s: [],
    headings: [],
    sentences: [],
    internalLinks: [],
    gscImpressions: null,
    ...over,
  };
}

const term = (t: string, weight = 1): DefiningTerm => ({ term: t, label: t, score: weight, weight });

function input(pages: LinkPage[], terms: Record<string, DefiningTerm[]>, stems: Record<string, string[]>) {
  return {
    pages,
    terms: new Map(Object.entries(terms)),
    sentenceStems: new Map(Object.entries(stems).map(([k, v]) => [k, new Set(v)])),
    host: H,
  };
}

describe("links: candidate targets", () => {
  it("excludes self, existing links (incl. via redirects), non-2xx, noindex, redirecting, non-canonical, and off-host targets", () => {
    const pages = [
      page("src", "/blog/source", { sentences: ["x"], internalLinks: [url("/linked/"), url("/old")] }),
      page("linked", "/linked"),
      page("redir-target", "/new"),
      page("old", "/old", { statusCode: 301, finalUrl: url("/new") }),
      page("gone", "/gone", { statusCode: 404, finalUrl: url("/gone") }),
      page("noidx", "/noidx", { robotsMeta: "noindex, follow" }),
      page("xrobots", "/xrobots", { robotsMeta: "x-robots-tag: noindex" }),
      page("variant", "/variant?x=1", { canonical: url("/canonical-page") }),
      page("js", "/js", { skippedReason: "js_rendered" }),
      page("offsite", "https://other.example.com/page"),
      page("ok", "/ok"),
    ];
    const terms: Record<string, DefiningTerm[]> = {};
    for (const p of pages) terms[p.pageId] = [term("patina")];
    const out = candidateTargets(input(pages, terms, { src: ["patina"] }));
    expect(out.get("src")!.map((c) => c.targetPageId)).toEqual(["ok"]);
  });

  it("prioritises orphan and low-inlink targets and applies the GSC boost; keeps the top 8 per source", () => {
    const pages = [
      page("src", "/src", { sentences: ["x"] }),
      page("hub", "/hub", { internalLinks: [url("/popular"), url("/one-link")] }),
      page("hub2", "/hub2", { internalLinks: [url("/popular")] }),
      page("orphan", "/orphan"),
      page("popular", "/popular"),
      page("one-link", "/one-link"),
      page("home", "/", { pageType: "home" }),
    ];
    const terms: Record<string, DefiningTerm[]> = { src: [term("zzz")], hub: [term("zzz")], hub2: [term("zzz")], orphan: [term("brass")], popular: [term("brass")], "one-link": [term("brass")], home: [term("brass")] };
    const list = candidateTargets(input(pages, terms, { src: ["brass"] })).get("src")!;
    expect(list.map((c) => c.targetPageId)).toEqual(["orphan", "one-link", "home", "popular"]);
    expect(list[0]).toMatchObject({ orphan: true, inlinks: 0, linkBoost: ORPHAN_BOOST, score: 1.5 });
    expect(list[1]).toMatchObject({ orphan: false, inlinks: 1, linkBoost: 1.25 });
    expect(list.find((c) => c.targetPageId === "home")).toMatchObject({ orphan: false, linkBoost: 1 });

    // GSC impressions boost: 1 + min(0.5, log10(1 + impressions) / 10).
    expect(gscBoost(null)).toBe(1);
    expect(gscBoost(0)).toBe(1);
    expect(gscBoost(999)).toBeCloseTo(1.3, 4);
    expect(gscBoost(1e9)).toBe(1.5);
    const withGsc = pages.map((p) => (p.pageId === "popular" ? { ...p, gscImpressions: 1e6 } : { ...p, gscImpressions: 0 }));
    const boosted = candidateTargets(input(withGsc, terms, { src: ["brass"] })).get("src")!;
    expect(boosted.find((c) => c.targetPageId === "popular")!.score).toBeCloseTo(1.5, 4);

    const many = [page("s", "/s", { sentences: ["x"] }), ...Array.from({ length: 12 }, (_, i) => page(`t${i}`, `/t${i}`))];
    const manyTerms: Record<string, DefiningTerm[]> = { s: [term("other")] };
    for (let i = 0; i < 12; i++) manyTerms[`t${i}`] = [term("brass", 0.5 + i / 100)];
    expect(candidateTargets(input(many, manyTerms, { s: ["brass"] })).get("s")).toHaveLength(MAX_TARGETS_PER_SOURCE);
  });

  it("needs an overlap weight of at least 0.5 and a source with sentences", () => {
    const pages = [page("src", "/src", { sentences: ["x"] }), page("t", "/t"), page("nosent", "/nosent")];
    const out = candidateTargets(input(pages, { src: [term("a")], t: [term("brass", 0.4)], nosent: [term("brass")] }, { src: ["brass"] }));
    expect(out.get("src")!.map((c) => c.targetPageId)).toEqual(["nosent"]);
    expect(out.has("nosent")).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------ sentences + anchors

describe("links: sentences and anchors", () => {
  const targetTerms = [term("patina", 1), term("unlacquered", 0.6), term("oxidize", 0.4)];
  const sentences = [
    "Our shop sells cabinet pulls in many sizes and finishes.",
    "Unlacquered brass develops a patina as it oxidizes over time.",
    "A patina can be removed with polish if you prefer shine.",
    "Unlacquered pulls are popular with many of our customers.",
    "Patina is sometimes called click here in forums, oddly enough.",
    "Brass patina forms faster in humid kitchens near sinks.",
  ];
  const stems = sentences.map((s) => new Set(termStems(s)));

  it("ranks up to 4 sentences by target-term hits, then weight, then position", () => {
    const ranked = rankSentences(sentences, stems, targetTerms);
    expect(ranked.map((r) => [r.key, r.index, r.hits])).toEqual([
      ["s0", 1, 3],
      ["s1", 2, 1],
      ["s2", 4, 1],
      ["s3", 5, 1],
    ]);
  });

  it("proposes up to 5 non-generic phrases containing target terms, preferring title/H1 wording", () => {
    const ranked = rankSentences(sentences, stems, targetTerms);
    const anchors = anchorCandidates(ranked, { terms: targetTerms, title: "What is brass patina? | Shop", h1s: ["Unlacquered brass patina"] });
    expect(anchors.length).toBeLessThanOrEqual(MAX_ANCHORS_PER_PAIR);
    expect(anchors.map((a) => a.key)).toEqual(anchors.map((_, i) => `a${i}`));
    expect(anchors[0]!.text).toBe("Brass patina");
    expect(anchors[0]!.inTitle).toBe(true);
    for (const a of anchors) {
      expect(isGenericAnchor(a.text)).toBe(false);
      expect(a.text.split(/\s+/).length).toBeLessThanOrEqual(5);
      expect(sentences[a.sentenceIndex]!.toLowerCase()).toContain(a.text.toLowerCase());
    }
    expect(anchors.map((a) => a.text.toLowerCase())).not.toContain("click here");
    const pick = deterministicPick(ranked, anchors)!;
    expect(pick.sentence.key).toBe("s0");
    expect(pick.anchor.sentenceKey).toBe("s0");
  });

  it("rejects generic anchors", () => {
    for (const g of ["click here", "Read more", "here", "this page", "Learn more", "Learn more »", "this article", "read more about", "More", "view details", "this"]) {
      expect(isGenericAnchor(g)).toBe(true);
    }
    for (const ok of ["brass patina", "how to clean brass", "Solid Brass Cabinet Pull"]) expect(isGenericAnchor(ok)).toBe(false);
    const only = rankSentences(["For details click here or read more about this page today."], [new Set(termStems("For details click here or read more about this page today."))], [term("click"), term("page"), term("details")]);
    expect(anchorCandidates(only, { terms: [term("click"), term("page"), term("details")], title: null, h1s: [] })).toEqual([]);
  });
});
