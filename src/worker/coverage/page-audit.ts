/**
 * [A22] SEO · Page audit: one row per page of the latest usable crawl.
 *
 * Cells (analysable pages; skipped / non-2xx / redirected pages get status 'unknown' in every cell):
 *   title   missing  no <title> or empty
 *           review   SEO-TITLE-DUPLICATE finding on the page, or length outside the 30-60 character
 *                    guideline (a guideline only: Google truncates by pixel width and may rewrite titles)
 *           ok       otherwise
 *   h1      missing  no non-empty <h1> in the served HTML
 *           review   more than one <h1>, or a skipped heading level (same logic as SEO-H1-MULTIPLE / SEO-HEADING-SKIP)
 *           ok       otherwise
 *   schema  review   any stored JSON-LD issue (invalid JSON, Product without offers / price / currency / name),
 *                    an ecommerce product page whose JSON-LD has no Product/ProductGroup, or an article
 *                    whose JSON-LD has no Article-family type
 *           missing  no JSON-LD where a type is expected (ecommerce product pages, articles)
 *           n/a      no JSON-LD on any other page type (nothing expected)
 *           ok       JSON-LD types present with no stored issues
 *   action  update   any FACT finding of moderate, major or critical severity on the page
 *           review   only minor/advisory or heuristic findings, a heuristic cell flag (review/missing
 *                    cell without a finding), or a page that could not be analysed
 *           keep     no findings on the page and no flagged cell
 * Findings are matched to pages by URL; site-wide findings (url null) are not counted per page.
 */
import type { AuditCellStatus, CoverageResponse, PageAuditRow, SiteType } from "@shared/types";
import type { Db } from "../lib/db";
import type { ProjectRow } from "../platform/access";
import {
  clip,
  crawlAbsenceState,
  crawlCompleteness,
  crawlLabel,
  DEMO_LABEL,
  isAnalyzable,
  isSiteType,
  loadLatestCrawl,
  pageKey,
  unanalyzedReason,
  type FindingLite,
  type Snap,
} from "./common";

export const TITLE_GUIDELINE = { min: 30, max: 60 } as const;
export const PRODUCT_TYPES = ["Product", "ProductGroup"] as const;
export const ARTICLE_TYPES = ["Article", "BlogPosting", "NewsArticle", "TechArticle", "ScholarlyArticle", "Report", "LiveBlogPosting"] as const;
const UPDATE_SEVERITIES = new Set(["critical", "major", "moderate"]);

export const PAGE_AUDIT_LABELS = {
  title: `Title length guideline: ${TITLE_GUIDELINE.min}-${TITLE_GUIDELINE.max} characters. It is a guideline, not a rule: Google truncates by pixel width and may rewrite titles.`,
  schema: "Schema shows JSON-LD types found in the HTML and required-property checks only; rich results are never guaranteed. Product markup is expected on ecommerce product pages, Article markup on articles.",
  action: "Action: keep = no findings on this page; update = a fact finding of moderate or higher severity; review = only minor, advisory, or heuristic findings, a heuristic cell flag, or a page that was not analysed.",
  h1: "A missing H1 is not by itself a ranking failure; multiple H1s are valid HTML.",
} as const;

type Cell = { status: AuditCellStatus; detail: string | null };

export function titleCell(s: Snap, pageFindings: FindingLite[]): Cell {
  const title = s.title?.trim() ?? "";
  if (!title) return { status: "missing", detail: "No <title> element, or it is empty." };
  const reasons: string[] = [];
  const dup = pageFindings.find((f) => f.ruleId === "SEO-TITLE-DUPLICATE");
  if (dup) reasons.push(clip(dup.detail, 140) || "Title is shared with another crawled URL.");
  const len = [...title].length;
  if (len < TITLE_GUIDELINE.min || len > TITLE_GUIDELINE.max) {
    reasons.push(`${len} characters (guideline ${TITLE_GUIDELINE.min}-${TITLE_GUIDELINE.max}).`);
  }
  if (reasons.length) return { status: "review", detail: reasons.join(" ") };
  return { status: "ok", detail: `${len} characters: ${clip(title, 80)}` };
}

export function h1Cell(s: Snap): Cell {
  const nonEmpty = s.h1s.filter((h) => h.trim());
  if (nonEmpty.length === 0) return { status: "missing", detail: "No non-empty <h1> in the served HTML." };
  const reasons: string[] = [];
  if (s.h1s.length > 1) reasons.push(`${s.h1s.length} <h1> elements.`);
  let prev = 0;
  for (const h of s.headings) {
    if (prev > 0 && h.level > prev + 1) {
      reasons.push(`Heading level jumps from h${prev} to h${h.level}.`);
      break;
    }
    prev = h.level;
  }
  if (reasons.length) return { status: "review", detail: reasons.join(" ") };
  return { status: "ok", detail: clip(nonEmpty[0], 100) };
}

function expectedTypes(s: Snap, siteType: SiteType): { label: string; types: readonly string[] } | null {
  if (s.pageType === "product" && siteType === "ecommerce") return { label: "Product", types: PRODUCT_TYPES };
  if (s.pageType === "article") return { label: "Article", types: ARTICLE_TYPES };
  return null;
}

const ISSUE_TEXT: Record<string, string> = {
  invalid_json: "A JSON-LD block is not valid JSON.",
  missing_name: "Product has no name.",
  missing_offers: "Product has no offers.",
  offer_missing_price: "Offer has no price.",
  offer_missing_currency: "Offer has no priceCurrency.",
  aggregate_offer_missing_low_price: "AggregateOffer has no lowPrice.",
};

export function schemaCell(s: Snap, siteType: SiteType): PageAuditRow["schema"] {
  const types = s.jsonldTypes;
  const expected = expectedTypes(s, siteType);
  const reasons: string[] = [];
  if (s.jsonldIssues.length > 0) {
    reasons.push(...uniqStrings(s.jsonldIssues.map((i) => ISSUE_TEXT[i.issue] ?? clip(i.detail ?? i.issue, 120))));
  }
  if (types.length === 0) {
    if (reasons.length) return { status: "review", types, detail: reasons.join(" ") };
    if (expected) return { status: "missing", types, detail: `No JSON-LD found; ${expected.label} markup is expected on this page type.` };
    return { status: "not_applicable", types, detail: "No JSON-LD found; none is expected for this page type." };
  }
  if (expected && !types.some((t) => expected.types.includes(t))) {
    reasons.unshift(`JSON-LD present but no ${expected.label} type.`);
  }
  if (reasons.length) return { status: "review", types, detail: reasons.join(" ") };
  return { status: "ok", types, detail: null };
}

function uniqStrings(xs: string[]): string[] {
  return [...new Set(xs)];
}

export function actionFor(pageFindings: FindingLite[], cells: AuditCellStatus[], analysed: boolean): PageAuditRow["action"] {
  if (pageFindings.some((f) => f.cls === "fact" && UPDATE_SEVERITIES.has(f.severity))) return "update";
  if (pageFindings.length > 0) return "review";
  if (!analysed) return "review";
  if (cells.some((c) => c === "review" || c === "missing")) return "review";
  return "keep";
}

export function pageAuditRow(s: Snap, pageFindings: FindingLite[], siteType: SiteType): PageAuditRow {
  if (!isAnalyzable(s)) {
    const why = unanalyzedReason(s);
    return {
      pageId: s.pageId,
      url: s.url,
      pageType: s.pageType,
      title: { status: "unknown", detail: why },
      h1: { status: "unknown", detail: why },
      schema: { status: "unknown", types: [], detail: why },
      action: actionFor(pageFindings, [], false),
      findingsCount: pageFindings.length,
    };
  }
  const title = titleCell(s, pageFindings);
  const h1 = h1Cell(s);
  const schema = schemaCell(s, siteType);
  return {
    pageId: s.pageId,
    url: s.url,
    pageType: s.pageType,
    title,
    h1,
    schema,
    action: actionFor(pageFindings, [title.status, h1.status, schema.status], true),
    findingsCount: pageFindings.length,
  };
}

/** Findings grouped by pageKey of their URL. */
export function findingsByPage(findings: FindingLite[]): Map<string, FindingLite[]> {
  const out = new Map<string, FindingLite[]>();
  for (const f of findings) {
    const k = pageKey(f.url);
    if (!k) continue;
    const list = out.get(k) ?? [];
    list.push(f);
    out.set(k, list);
  }
  return out;
}

export async function buildPageAudit(db: Db, project: ProjectRow, now: Date): Promise<CoverageResponse<PageAuditRow>> {
  const generatedAt = now.toISOString();
  const labels: string[] = [];
  if (project.is_demo) labels.push(DEMO_LABEL);
  const data = await loadLatestCrawl(db, project);
  if (typeof data === "string") {
    const { state, note } = crawlAbsenceState(project, data);
    return { state, generatedAt, rows: [], completeness: { note, covered: null, total: null }, labels: [...labels, PAGE_AUDIT_LABELS.action] };
  }
  const siteType: SiteType = isSiteType(project.site_type) ? project.site_type : "other";
  const byPage = findingsByPage(data.findings);
  const rows = data.snaps.map((s) => pageAuditRow(s, byPage.get(pageKey(s.url) ?? s.url) ?? [], siteType));
  labels.push(crawlLabel(data), PAGE_AUDIT_LABELS.title, PAGE_AUDIT_LABELS.h1, PAGE_AUDIT_LABELS.schema, PAGE_AUDIT_LABELS.action);
  const siteWide = data.findings.filter((f) => !f.url).length;
  if (siteWide > 0) labels.push(`${siteWide} site-wide finding(s) are not attached to a page; see Findings.`);
  return {
    state: project.is_demo ? "demo" : "ready",
    generatedAt,
    rows,
    completeness: crawlCompleteness(data),
    labels,
  };
}
