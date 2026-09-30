/** [A25] Pure helpers behind the internal-links page (anchor highlighting by string splitting, filters). */
import { describe, expect, it } from "vitest";
import type { LinkSuggestion } from "@shared/types";
import { DEFAULT_FILTERS, extraLabels, filterSuggestions, jevNotices, LINK_LABEL_CONFIDENCE, LINK_LABEL_REVIEW, safeHref, splitAnchor } from "@web/pages/links/lib";
import { LABEL_CONFIDENCE, LABEL_REVIEW_ONLY } from "@worker/links/report";

const s = (over: Partial<LinkSuggestion>): LinkSuggestion => ({
  id: "x",
  source: { pageId: "a", url: "https://shop.example.com/a", title: null },
  target: { pageId: "b", url: "https://shop.example.com/b", title: null, inlinks: 0, orphan: true },
  sentence: null,
  anchor: null,
  role: null,
  method: "deterministic",
  decision: null,
  status: "review",
  score: 1,
  reasons: [],
  userStatus: "open",
  ...over,
});

describe("links web helpers", () => {
  it("splits the sentence around the anchor, case-insensitively, keeping markup-looking text as plain text", () => {
    expect(splitAnchor("Read how to <b>Care for Brass</b> first.", "care for brass")).toEqual({ before: "Read how to <b>", match: "Care for Brass", after: "</b> first." });
    expect(splitAnchor("No anchor here.", "brass")).toBeNull();
    expect(splitAnchor("Anything", null)).toBeNull();
  });

  it("filters by status (default hides rejected), role, target, and user status", () => {
    const list = [
      s({ id: "1", status: "suggested", role: "comparison" }),
      s({ id: "2", status: "review" }),
      s({ id: "3", status: "rejected" }),
      s({ id: "4", status: "suggested", target: { pageId: "c", url: "https://shop.example.com/c", title: null, inlinks: 2, orphan: false }, userStatus: "accepted" }),
    ];
    expect(filterSuggestions(list, DEFAULT_FILTERS).map((x) => x.id)).toEqual(["1", "2", "4"]);
    expect(filterSuggestions(list, { ...DEFAULT_FILTERS, status: "rejected" }).map((x) => x.id)).toEqual(["3"]);
    expect(filterSuggestions(list, { ...DEFAULT_FILTERS, role: "comparison" }).map((x) => x.id)).toEqual(["1"]);
    expect(filterSuggestions(list, { ...DEFAULT_FILTERS, role: "none", status: "all" }).map((x) => x.id)).toEqual(["2", "3", "4"]);
    expect(filterSuggestions(list, { ...DEFAULT_FILTERS, target: "https://shop.example.com/c" }).map((x) => x.id)).toEqual(["4"]);
    expect(filterSuggestions(list, { ...DEFAULT_FILTERS, user: "accepted" }).map((x) => x.id)).toEqual(["4"]);
  });

  it("uses the same prominent labels as the API and links only http(s) URLs", () => {
    expect(LINK_LABEL_REVIEW).toBe(LABEL_REVIEW_ONLY);
    expect(LINK_LABEL_CONFIDENCE).toBe(LABEL_CONFIDENCE);
    expect(extraLabels([LABEL_REVIEW_ONLY, "Method note", LABEL_CONFIDENCE])).toEqual(["Method note"]);
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("https://shop.example.com/a")).toBe("https://shop.example.com/a");
  });

  it("finds the Jev budget / availability notices written by the run", () => {
    const n = jevNotices(["Jev budget reached: the project's daily Jev call limit was used up, so 3 pairs are deterministic suggestions marked review.", "Other"]);
    expect(n.budget).toMatch(/^Jev budget reached/);
    expect(n.unavailable).toBeNull();
    expect(jevNotices(["Jev (TypeSafe) is not configured for this workspace: suggestions are deterministic."]).notConfigured).toBeTruthy();
  });
});
