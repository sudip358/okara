/** Change detection between two checks of a backlink: every transition the owner asked to see, incl. recovered. */
import { describe, expect, it } from "vitest";
import { diffChecks, targetState, type CheckSnapshot } from "@worker/backlinks/events";

const snap = (o: Partial<CheckSnapshot> = {}): CheckSnapshot => ({
  status: "dofollow",
  linkRel: "dofollow",
  httpStatus: 200,
  finalUrl: null,
  anchorFound: "brass pulls",
  pageNoindex: false,
  targetStatus: 200,
  targetError: null,
  canonicalUrl: null,
  linkMatch: "target",
  linkHref: "https://shop.example.com/collections/pulls",
  statusReason: null,
  ...o,
});
const kinds = (prev: Partial<CheckSnapshot> | null, next: Partial<CheckSnapshot>) => diffChecks(prev ? snap(prev) : null, snap(next));

describe("diffChecks", () => {
  it("first check is the baseline (no events)", () => {
    expect(kinds(null, { status: "missing" })).toEqual([]);
  });

  it("unchanged check: no events", () => {
    expect(kinds({}, {})).toEqual([]);
  });

  it("dofollow -> nofollow is a negative rel change; nofollow -> dofollow is positive", () => {
    const [e] = kinds({}, { status: "nofollow", linkRel: "nofollow" });
    expect(e).toMatchObject({ kind: "rel_changed", from: "dofollow", to: "nofollow", message: "dofollow → nofollow", negative: true });
    expect(kinds({ status: "nofollow" }, { status: "dofollow" })[0]).toMatchObject({ kind: "rel_changed", negative: false });
    expect(kinds({}, { status: "sponsored" })[0]).toMatchObject({ message: "dofollow → sponsored", negative: true });
  });

  it("link removed / restored", () => {
    expect(kinds({}, { status: "missing", anchorFound: null })[0]).toMatchObject({ kind: "link_removed", negative: true });
    expect(kinds({ status: "missing", anchorFound: null }, { status: "dofollow" })[0]).toMatchObject({ kind: "link_restored", message: "Link restored (now dofollow)", negative: false });
  });

  it("page now 404", () => {
    expect(kinds({}, { status: "page_error", httpStatus: 404, anchorFound: null })[0]).toMatchObject({ kind: "page_error", message: "Page now 404", negative: true });
  });

  it("redirected to <url>, and a changed redirect target", () => {
    expect(kinds({}, { status: "redirected", finalUrl: "https://x.example.org/new" })[0]).toMatchObject({ kind: "redirected", message: "Redirected to https://x.example.org/new", negative: true });
    expect(kinds({ status: "redirected", finalUrl: "https://a.example.org/" }, { status: "redirected", finalUrl: "https://b.example.org/" })[0]).toMatchObject({ kind: "redirected", negative: false });
  });

  it("robots blocked and fetch failures are not counted as losses", () => {
    expect(kinds({}, { status: "robots_blocked" })[0]).toMatchObject({ kind: "robots_blocked", negative: false });
    expect(kinds({}, { status: "fetch_failed", statusReason: "timeout" })[0]).toMatchObject({ kind: "fetch_failed", negative: false });
  });

  it("recovered: from an error state back to a live link", () => {
    for (const from of ["page_error", "redirected", "fetch_failed", "robots_blocked"] as const) {
      expect(kinds({ status: from }, { status: "dofollow" })[0]).toMatchObject({ kind: "recovered", message: "Recovered: page OK again, link dofollow", negative: false });
    }
  });

  it("noindex added / removed", () => {
    expect(kinds({}, { pageNoindex: true }).map((e) => e.kind)).toEqual(["noindex_added"]);
    expect(kinds({ pageNoindex: true }, {}).map((e) => e.kind)).toEqual(["noindex_removed"]);
  });

  it("anchor changed (case and spacing differences ignored)", () => {
    expect(kinds({}, { anchorFound: "Brass  PULLS" })).toEqual([]);
    expect(kinds({}, { anchorFound: "click here" })[0]).toMatchObject({ kind: "anchor_changed", message: 'Anchor changed: "brass pulls" → "click here"' });
  });

  it("target now 404, and back", () => {
    expect(kinds({}, { targetStatus: 404 })[0]).toMatchObject({ kind: "target_broken", message: "Target now 404", negative: true });
    expect(kinds({ targetStatus: 404 }, {})[0]).toMatchObject({ kind: "target_recovered", message: "Target back to 200" });
    expect(targetState(null, "not_checked")).toBe("unknown");
    expect(targetState(null, "timeout")).toBe("broken");
  });

  it("link moved to another page of our site", () => {
    expect(kinds({}, { linkMatch: "host", linkHref: "https://shop.example.com/" })[0]).toMatchObject({ kind: "target_moved", negative: true });
  });
});
