import { describe, expect, it } from "vitest";
import type { Checklist, ChecklistItem, DraftCheckFlag, PageRow } from "@shared/types";
import {
  EMPTY_FORM,
  GATE_LABEL,
  MAX_DRAFT_CHARS,
  MAX_QUERY_CHARS,
  VERDICT_META,
  buildDraftCheckRequest,
  extraLabels,
  firstInvalidField,
  groupFlags,
  noulText,
  pageOptionLabel,
  parseValidationDetails,
  readOnlyChecklist,
  sortPages,
  validateDraftForm,
  verdictText,
  type DraftForm,
} from "@web/pages/draft-check/lib";

const form = (over: Partial<DraftForm> = {}): DraftForm => ({ ...EMPTY_FORM, ...over });

describe("draft check page: validation", () => {
  it("requires a target query and caps it at 200 characters (after trimming)", () => {
    expect(validateDraftForm(form({ draftText: "x" })).targetQuery).toMatch(/Enter/);
    expect(validateDraftForm(form({ targetQuery: "   ", draftText: "x" })).targetQuery).toBeDefined();
    expect(validateDraftForm(form({ targetQuery: "q".repeat(MAX_QUERY_CHARS), draftText: "x" })).targetQuery).toBeUndefined();
    expect(validateDraftForm(form({ targetQuery: ` ${"q".repeat(MAX_QUERY_CHARS)} `, draftText: "x" })).targetQuery).toBeUndefined();
    expect(validateDraftForm(form({ targetQuery: "q".repeat(MAX_QUERY_CHARS + 1), draftText: "x" })).targetQuery).toMatch(/201/);
  });

  it("paste mode requires non-blank draft text of at most 60,000 characters", () => {
    expect(validateDraftForm(form({ targetQuery: "q", draftText: "  \n " })).draftText).toMatch(/Paste/);
    expect(validateDraftForm(form({ targetQuery: "q", draftText: "a".repeat(MAX_DRAFT_CHARS) })).draftText).toBeUndefined();
    expect(validateDraftForm(form({ targetQuery: "q", draftText: "a".repeat(MAX_DRAFT_CHARS + 1) })).draftText).toMatch(/60,001/);
  });

  it("page mode requires a page and ignores the draft fields", () => {
    const errs = validateDraftForm(form({ mode: "page", targetQuery: "q", draftText: "" }));
    expect(errs.pageId).toBeDefined();
    expect(errs.draftText).toBeUndefined();
    expect(firstInvalidField(validateDraftForm(form({ mode: "page" })))).toBe("targetQuery");
  });
});

describe("draft check page: request building", () => {
  it("sends draftText (trimmed) and never pageId in paste mode; optional fields only when non-empty", () => {
    const r = buildDraftCheckRequest(form({ targetQuery: "  brass lamp ", draftText: "\n Body text \n", pageId: "p1", title: "  ", metaDescription: " Meta " }));
    expect(r).toEqual({ ok: true, body: { targetQuery: "brass lamp", draftText: "Body text", metaDescription: "Meta" } });
  });

  it("sends pageId and never draftText, title or meta in page mode", () => {
    const r = buildDraftCheckRequest(form({ mode: "page", targetQuery: "q", pageId: "p1", draftText: "leftover", title: "T", metaDescription: "M" }));
    expect(r).toEqual({ ok: true, body: { targetQuery: "q", pageId: "p1" } });
  });

  it("returns errors instead of a body when invalid", () => {
    const r = buildDraftCheckRequest(form({ targetQuery: "q" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors)).toEqual(["draftText"]);
  });
});

describe("draft check page: verdict, flags, labels", () => {
  it("has a label and one-line explanation for every verdict", () => {
    for (const v of ["pass", "needs_review", "fail"] as const) {
      expect(VERDICT_META[v].label.length).toBeGreaterThan(0);
      expect(VERDICT_META[v].explanation).not.toMatch(/\n/);
      expect(verdictText(v).startsWith(VERDICT_META[v].label)).toBe(true);
    }
    expect(VERDICT_META.needs_review.label).toBe("Needs review");
  });

  it("groups flags by kind in a fixed order, keeping server order and exact text", () => {
    const flags: DraftCheckFlag[] = [
      { kind: "filler", text: "In today's world", method: "rule", noul: null },
      { kind: "unsupported_claim", text: "Best lamp <b>ever</b>", method: "jev", noul: 2 },
      { kind: "filler", text: "It goes without saying", method: "rule", noul: null },
    ];
    const groups = groupFlags(flags);
    expect(groups.map((g) => g.kind)).toEqual(["unsupported_claim", "filler"]);
    expect(groups[0].label).toBe("Unsupported claim");
    expect(groups[0].flags[0].text).toBe("Best lamp <b>ever</b>");
    expect(groups[1].flags.map((f) => f.text)).toEqual(["In today's world", "It goes without saying"]);
    expect(groupFlags([])).toEqual([]);
  });

  it("shows noul exactly as given and nothing when absent", () => {
    expect(noulText(null)).toBeNull();
    expect(noulText(0)).toBe("0");
    expect(noulText(0.125)).toBe("0.125");
    expect(noulText(Number.NaN)).toBeNull();
  });

  it("drops the always-shown gate label and duplicates from server labels", () => {
    expect(extraLabels([GATE_LABEL, "Rules only: Jev not configured.", "Rules only: Jev not configured.", " "])).toEqual(["Rules only: Jev not configured."]);
  });
});

describe("draft check page: read-only checklist and pages", () => {
  const item = (id: string, manual: ChecklistItem["manual"]): ChecklistItem => ({
    id,
    section: "while_write",
    label: id,
    status: manual ? "manual" : "met",
    method: manual ? "manual" : "measured",
    summary: "",
    evidence: [],
    completeness: null,
    guidance: "",
    caveat: null,
    links: [],
    manual,
    tacticTier: null,
  });

  it("clears manual controls without changing status or other items", () => {
    const c = {
      kind: "page",
      items: [item("a", { checked: false, note: null, updatedAt: null, updatedBy: null }), item("b", null)],
    } as unknown as Checklist;
    const ro = readOnlyChecklist(c);
    expect(ro.items[0].manual).toBeNull();
    expect(ro.items[0].status).toBe("manual");
    expect(ro.items[1]).toBe(c.items[1]);
    expect(c.items[0].manual).not.toBeNull();
  });

  it("labels and sorts crawled pages with URL and page type", () => {
    const row = (id: string, url: string, over: Partial<PageRow> = {}): PageRow => ({
      id,
      url,
      pageType: "product",
      pageTypeMethod: "rule",
      lastCrawledAt: null,
      statusCode: 200,
      title: null,
      wordCount: null,
      skippedReason: null,
      ...over,
    });
    expect(pageOptionLabel(row("1", "https://x.test/p"))).toBe("https://x.test/p — Product");
    expect(pageOptionLabel(row("2", "https://x.test/", { pageType: "home", skippedReason: "noindex" }))).toBe("https://x.test/ — Home (skipped: noindex)");
    expect(sortPages([row("b", "https://x.test/b"), row("a", "https://x.test/a")]).map((p) => p.id)).toEqual(["a", "b"]);
  });
});

describe("draft check page: 400 validation details", () => {
  it("maps known fields inline and keeps the rest as general messages", () => {
    expect(parseValidationDetails({ issues: [{ path: ["targetQuery"], message: "Too long" }, { path: ["other"], message: "Bad" }] })).toEqual({
      fields: { targetQuery: "Too long" },
      general: ["Bad"],
    });
    expect(parseValidationDetails({ fieldErrors: { draftText: ["Too long"] } }).fields).toEqual({ draftText: "Too long" });
    expect(parseValidationDetails(["Provide exactly one of pageId or draftText."])).toEqual({ fields: {}, general: ["Provide exactly one of pageId or draftText."] });
    expect(parseValidationDetails({ pageId: "Unknown page" }).fields).toEqual({ pageId: "Unknown page" });
    expect(parseValidationDetails(undefined)).toEqual({ fields: {}, general: [] });
    expect(parseValidationDetails(42)).toEqual({ fields: {}, general: [] });
  });
});
