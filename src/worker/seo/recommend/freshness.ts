/**
 * [A23] Freshness sweep: deterministic stale-year detector (STALE_YEAR_VERSION). Pure.
 *
 * A year Y (1950..2099, a whole word) in the page title, H1, or first paragraph is a dated reference when
 * Y <= current year - STALE_YEAR_MIN_AGE (2): in 2026, 2024 and earlier are flagged, 2025 and 2026 are not.
 * Not flagged:
 *  - decades ("1990s") and years glued to letters or digits (model numbers such as "X2019");
 *  - historical context: the year follows, within the same clause, one of HISTORICAL_BEFORE
 *    ("since 1998", "est. 1998", "established in 1998", "founded 1998", "© 2019", "copyright 2019",
 *    "circa 1920", "dating back to 1920", "back in 2015", "opened in 1990", "first introduced in 2001", ...)
 *    or is followed by an anniversary / history word ("1998 heritage");
 *  - future years.
 * The detector only shortlists pages; seo.outdated_information (Noul, with today's date in state) judges
 * whether the page actually presents outdated information as current.
 */
export const STALE_YEAR_VERSION = "stale-years-2026-09-30.1";
export const STALE_YEAR_MIN_AGE = 2;

export type DatedField = "title" | "h1" | "first_paragraph";

export interface DatedReference {
  year: number;
  field: DatedField;
  /** Up to ~40 characters around the year, plain text. */
  context: string;
}

const YEAR_RE = /(?<![\p{L}\p{N}])(19[5-9]\d|20\d{2})(?![\p{L}\p{N}])/gu;
/** Words that make the year historical context when they end the text right before it (same clause). */
const HISTORICAL_BEFORE =
  /(?:\bsince(?:\s+the\s+year)?|\best\.?|\bestd\.?|\bestablished(?:\s+in)?|\bfounded(?:\s+in)?|\bfounding(?:\s+year)?|\bin\s+business\s+since|\bserving(?:\s+\S+){0,3}\s+since|©|\(c\)|\bcopyright(?:\s+©)?|\bcirca|\bc\.|\bborn(?:\s+in)?|\bdating\s+(?:back\s+)?(?:to|from)|\bdates?\s+(?:back\s+)?(?:to|from)|\boriginally(?:\s+\S+){0,2}\s+in|\bback\s+in|\bopened(?:\s+its\s+doors)?\s+in|\b(?:first\s+)?(?:introduced|launched|built|made|designed)\s+in|\bheritage\s+(?:since|from)|\bhistory\s+(?:since|from)|\bsince\s+its\s+founding\s+in|\bfrom)\s*$/i;
/** Clause boundaries: ; | newline, or a sentence period that does not close an abbreviation (est., c., ca.). */
const CLAUSE_BREAK = /[;|\n]|(?<!\b(?:est|estd|c|ca|no|approx))\.(?=\s)/i;
/** Words right after the year that mark it as historical (anniversaries, "1998 heritage"). */
const HISTORICAL_AFTER = /^\s*(?:anniversary|heritage|original|vintage|-era|era\b)/i;

/** Detect dated references in a page's title, H1, and first paragraph. `today` is YYYY-MM-DD. */
export function detectStaleYears(fields: { title: string | null; h1: string | null; firstParagraph: string | null }, today: string): DatedReference[] {
  const currentYear = Number(today.slice(0, 4));
  if (!Number.isFinite(currentYear)) return [];
  const out: DatedReference[] = [];
  const scan = (text: string | null, field: DatedField) => {
    if (!text) return;
    for (const m of text.matchAll(YEAR_RE)) {
      const year = Number(m[1]);
      const at = m.index ?? 0;
      if (year > currentYear - STALE_YEAR_MIN_AGE) continue;
      const after = text.slice(at + m[0].length);
      if (/^s\b|^'s\b/i.test(after)) continue; // decade ("1990s")
      // Historical context within the same clause (abbreviation periods such as "Est." do not end it).
      const window = text.slice(Math.max(0, at - 60), at);
      const before = window.split(CLAUSE_BREAK).pop() ?? "";
      if (HISTORICAL_BEFORE.test(before) || HISTORICAL_AFTER.test(after)) continue;
      const start = Math.max(0, at - 20);
      const end = Math.min(text.length, at + m[0].length + 20);
      out.push({ year, field, context: text.slice(start, end).replace(/\s+/g, " ").trim() });
    }
  };
  scan(fields.title, "title");
  scan(fields.h1, "h1");
  scan(fields.firstParagraph, "first_paragraph");
  return out.slice(0, 10);
}
