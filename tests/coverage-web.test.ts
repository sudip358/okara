/** [A22] Coverage web tables: untrusted text stays plain text; only external http(s) URLs become safe links; no projections. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FILES = [
  "src/web/pages/seo/components/PageAuditTable.tsx",
  "src/web/pages/seo/components/ContentEvidenceTable.tsx",
  "src/web/pages/geo/components/AnswerCoverageTable.tsx",
  "src/web/pages/geo/components/CitationEvidenceTable.tsx",
];
const src = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

describe("coverage web tables", () => {
  it("never inject HTML and never render projections", () => {
    for (const f of FILES) {
      const s = src(f);
      expect(s, f).not.toContain("dangerouslySetInnerHTML");
      expect(s, f).not.toMatch(/innerHTML|projected|forecast(ed)? (traffic|clicks|citations)/i);
    }
  });

  it("links only external http(s) URLs, with rel=noopener noreferrer nofollow", () => {
    const s = src(FILES[0]!);
    expect(s).toContain('rel="noopener noreferrer nofollow"');
    expect(s).toMatch(/u\.protocol !== "https:" && u\.protocol !== "http:"/);
    for (const f of FILES) {
      const hrefs = src(f).match(/href=\{[^}]+\}/g) ?? [];
      // The single link site is UrlText, which checks the host is external first.
      expect(hrefs.every((h) => h === "href={url}"), f).toBe(true);
    }
  });
});
