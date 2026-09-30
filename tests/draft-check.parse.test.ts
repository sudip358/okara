/** [A23] Draft check: draft parsing (markdown and HTML) and the deterministic flag scan. */
import { describe, expect, it } from "vitest";
import { looksLikeHtml, parseDraft } from "@worker/draftcheck/parse";
import { FILLER_PHRASES, scanFlags } from "@worker/draftcheck/flags";

const BASE = "https://shop.example.com/draft-preview";

const MD = `# Brass vs bronze cabinet pulls

Brass and bronze cabinet pulls differ mainly in color, patina, and price: brass is brighter and cheaper.

## How do the finishes age?

Unlacquered brass darkens within months. See our [care guide](/pages/brass-care) and the [bronze collection](https://www.shop.example.com/collections/bronze).
Independent tests are summarised by [the Copper Development Association](https://copper.org/applications/architecture/).

Setext heading
--------------

| Metal | Patina speed | Price |
| --- | --- | --- |
| Brass | Months | $ |
| Bronze | Weeks | $$ |

- Easy to clean
- [Read more](/blogs/news/brass)

![Unlacquered brass pull on oak](/img/pull.jpg)
![](/img/decorative.jpg)

\`\`\`
# not a heading inside code
\`\`\`

Visit https://example.org/standards for the standard.
`;

describe("draft parsing: markdown", () => {
  const doc = parseDraft(MD, BASE);

  it("reads ATX and setext headings, but not '#' lines inside code fences", () => {
    expect(doc.format).toBe("markdown");
    expect(doc.headings).toEqual([
      { level: 1, text: "Brass vs bronze cabinet pulls" },
      { level: 2, text: "How do the finishes age?" },
      { level: 2, text: "Setext heading" },
    ]);
    expect(doc.h1s).toEqual(["Brass vs bronze cabinet pulls"]);
  });

  it("takes the first prose paragraph (3+ words) as the opening", () => {
    expect(doc.firstParagraph).toBe("Brass and bronze cabinet pulls differ mainly in color, patina, and price: brass is brighter and cheaper.");
  });

  it("counts markdown pipe tables and keeps their cells as text", () => {
    expect(doc.tableCount).toBe(1);
    expect(doc.text).toContain("Bronze | Weeks | $$");
  });

  it("splits links into internal (relative or same host, with or without www) and outbound, with generic anchors", () => {
    expect(doc.internalLinks).toEqual([
      "https://shop.example.com/pages/brass-care",
      "https://www.shop.example.com/collections/bronze",
      "https://shop.example.com/blogs/news/brass",
    ]);
    expect(doc.outboundLinks).toEqual(["https://copper.org/applications/architecture/", "https://example.org/standards"]);
    expect(doc.genericAnchors).toEqual([{ href: "https://shop.example.com/blogs/news/brass", text: "Read more" }]);
    // Link syntax is removed from the text; the link text stays.
    expect(doc.text).toContain("See our care guide and the bronze collection.");
    expect(doc.text).not.toContain("](");
  });

  it("counts images and images without alt text", () => {
    expect(doc.imagesTotal).toBe(2);
    expect(doc.imagesMissingAlt).toBe(1);
  });

  it("marks blocks with links or URLs as sourced and counts words", () => {
    const withLink = doc.blocks.find((b) => b.text.startsWith("Unlacquered brass"));
    expect(withLink?.hasSource).toBe(true);
    expect(doc.blocks.find((b) => b.text.startsWith("Brass and bronze"))?.hasSource).toBe(false);
    expect(doc.wordCount).toBeGreaterThan(60);
  });

  it("plain text without markdown: no headings, first paragraph is the first block", () => {
    const d = parseDraft("How to clean brass knobs\n\nUse warm soapy water and a soft cloth, then dry the knob fully.\n\nPolish twice a year.", BASE);
    expect(d.headings).toEqual([]);
    expect(d.firstParagraph).toBe("How to clean brass knobs");
    expect(d.tableCount).toBe(0);
    expect(d.links).toEqual([]);
  });

  it("reference-style links resolve against their definitions", () => {
    const d = parseDraft("Read the [installation guide][guide] first.\n\n[guide]: https://shop.example.com/pages/install", BASE);
    expect(d.internalLinks).toEqual(["https://shop.example.com/pages/install"]);
    expect(d.text).not.toContain("[guide]:");
  });
});

describe("draft parsing: HTML", () => {
  const HTML = `<h1>Brass knobs</h1><p>Solid brass knobs for kitchen cabinets, made to order.</p>
<h2>Finishes</h2><p>Unlacquered brass <a href="https://copper.org/x">ages naturally</a>. <a href="/collections/knobs">click here</a></p>
<table><tr><td>Size</td><td>1.25 in</td></tr></table><img src="/a.jpg"><meta name="robots" content="noindex">`;

  it("detects HTML and uses the crawler extractor for headings, opening, tables, and links", () => {
    expect(looksLikeHtml(HTML)).toBe(true);
    expect(looksLikeHtml("A plain draft with a < b comparison.")).toBe(false);
    const d = parseDraft(HTML, BASE);
    expect(d.format).toBe("html");
    expect(d.h1s).toEqual(["Brass knobs"]);
    expect(d.headings.map((h) => h.level)).toEqual([1, 2]);
    expect(d.firstParagraph).toBe("Solid brass knobs for kitchen cabinets, made to order.");
    expect(d.tableCount).toBe(1);
    expect(d.internalLinks).toEqual(["https://shop.example.com/collections/knobs"]);
    expect(d.outboundLinks).toEqual(["https://copper.org/x"]);
    expect(d.genericAnchors.map((g) => g.text)).toEqual(["click here"]);
    expect(d.imagesTotal).toBe(1);
    expect(d.imagesMissingAlt).toBe(1);
    expect(d.html?.robotsMeta).toMatch(/noindex/);
    expect(d.blocks.find((b) => b.text.startsWith("Unlacquered"))?.hasSource).toBe(true);
  });
});

describe("draft flags (deterministic)", () => {
  const scan = (text: string) => scanFlags(parseDraft(text, BASE).blocks);
  const kinds = (text: string) => scan(text).flags.map((f) => f.kind);

  it("guarantee language reuses the writing validator; negated wording is not flagged", () => {
    const s = scan("Our polish is guaranteed to remove tarnish. This page will rank first on Google.");
    expect(s.flags.filter((f) => f.kind === "guarantee_language").map((f) => f.text)).toEqual([
      "Our polish is guaranteed to remove tarnish.",
      "This page will rank first on Google.",
    ]);
    expect(kinds("Search engines do not guarantee rich results.")).toEqual([]);
    expect(kinds("A risk-free way to refresh your kitchen.")).toEqual(["guarantee_language"]);
  });

  it("a commercial policy guarantee is an unsupported claim to confirm, not an outcome promise", () => {
    expect(kinds("Every order includes a 30-day money-back guarantee.")).toEqual(["unsupported_claim"]);
  });

  it("testimonials: quoted first-person praise with an attribution and no source", () => {
    const s = scan(`> "I love these pulls, they transformed my kitchen."\n> — Sarah K., interior designer`);
    expect(s.flags).toEqual([
      { kind: "fabricated_testimonial", text: "\"I love these pulls, they transformed my kitchen.\" — Sarah K., interior designer", method: "rule", noul: null },
    ]);
    expect(kinds(`“We highly recommend this finish,” says Mark Lee, owner of Lee Builds.`)).toContain("fabricated_testimonial");
    // Linked to where it was published: attributable evidence, not flagged.
    expect(kinds(`"I love these pulls," said Sarah K. in her [review](https://reviews.example/sarah).`)).not.toContain("fabricated_testimonial");
    // A quotation without first-person praise or attribution is not a testimonial.
    expect(kinds(`The label reads "solid brass, unlacquered".`)).toEqual([]);
  });

  it("filler phrases from the fixed list", () => {
    expect(FILLER_PHRASES).toContain("in today's fast-paced world");
    const s = scan("In today’s fast-paced world, kitchens matter. It goes without saying that brass is warm. Brass is warm.");
    expect(s.flags.filter((f) => f.kind === "filler").map((f) => f.text)).toEqual(["In today’s fast-paced world, kitchens matter.", "It goes without saying that brass is warm."]);
  });

  it("unsupported superlatives and statistics are flagged; sourced ones are not (no false positive)", () => {
    expect(kinds("We are the #1 hardware store.")).toEqual(["unsupported_claim"]);
    expect(kinds("The best in the world at brass casting.")).toEqual(["unsupported_claim"]);
    expect(kinds("73% of homeowners prefer brass hardware.")).toEqual(["unsupported_claim"]);
    expect(kinds("Studies show brass kills bacteria.")).toEqual(["unsupported_claim"]);
    expect(kinds("Our knobs are UL listed.")).toEqual(["unsupported_claim"]);
    // Sourced: a link, a citation marker, a Source: note, or a named attribution.
    expect(kinds("73% of homeowners prefer brass hardware ([2025 survey](https://survey.example/brass)).")).toEqual([]);
    expect(kinds("Studies show copper alloys reduce surface bacteria [1].")).toEqual([]);
    expect(kinds("73% of homeowners prefer brass hardware (Source: Houzz 2025 kitchen study).")).toEqual([]);
    expect(kinds("According to the Copper Development Association, studies show brass surfaces kill bacteria.")).toEqual([]);
    // Plain specifications are not claims.
    expect(kinds("The knob is 1.25 inches wide and weighs 60 grams.")).toEqual([]);
  });

  it("a guarantee sentence is not double-flagged as a claim; code blocks are not scanned", () => {
    expect(kinds("We guarantee a #1 ranking on Google.")).toEqual(["guarantee_language"]);
    expect(kinds("```\nWe guarantee results\n```")).toEqual([]);
  });

  it("returns unsourced claim-like sentences that no rule flagged as Jev candidates", () => {
    const s = scan("Brass lasts longer than zinc alloy in humid rooms. Our finish cuts cleaning time by 50 minutes a week. The knob is round.");
    expect(s.flags).toEqual([]);
    expect(s.jevCandidates).toEqual(["Brass lasts longer than zinc alloy in humid rooms.", "Our finish cuts cleaning time by 50 minutes a week."]);
    expect(s.sentences).toBe(3);
  });
});
