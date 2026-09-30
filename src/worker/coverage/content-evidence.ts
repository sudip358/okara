/**
 * [A22] SEO · Content evidence for YOUR pages (analysable pages of the latest usable crawl).
 *
 *   depth      word count of the extracted main text; review when below THIN_WORDS for the page type
 *              (article/landing/other: 150, the SEO-CONTENT-THIN threshold; home/product/collection: 50).
 *              Word count is a rough proxy; short pages can fully satisfy intent.
 *   proof      outbound source links + HTML tables: present when either is > 0, missing when both are 0,
 *              unknown when not recorded (snapshots taken before extraction existed).
 *   freshness  last-updated date found in the HTML (meta modified time or JSON-LD dateModified);
 *              review when older than STALE_DAYS (365) or in the future; unknown when no date or unparseable.
 *   gsc        current-window impressions/clicks of the latest usable Search Console sync (page rows, else
 *              query x page rows as a lower bound); 0 when data exists but the page has no rows.
 *   priority   SEO priority formula (seo/recommend/priority.ts) with metric = the page's share of property
 *              impressions/clicks, severity and reach not applicable (content), effort medium, no Jev tier.
 *              Computed only when GSC data + property totals exist AND at least one gap is flagged
 *              (depth review, proof missing, freshness review); otherwise null with the reason in `basis`.
 *              Labels: high >= 40, medium >= 15, else low. A ranking signal, never a traffic forecast.
 * Competitor columns are not produced: Okara does not crawl competitor pages automatically ([A7]).
 */
import type { AuditCellStatus, ContentEvidenceRow, CoverageResponse, PageType } from "@shared/types";
import type { Db } from "../lib/db";
import type { ProjectRow } from "../platform/access";
import { EFFORT_FACTOR, PRIORITY_VERSION, priorityBreakdown } from "../seo/recommend/priority";
import {
  crawlAbsenceState,
  crawlCompleteness,
  crawlLabel,
  DEMO_LABEL,
  isAnalyzable,
  loadGscPageData,
  loadLatestCrawl,
  pageKey,
  type GscPageData,
  type Snap,
} from "./common";

export const THIN_WORDS: Record<PageType, number> = { article: 150, landing: 150, other: 150, home: 50, product: 50, collection: 50 };
export const STALE_DAYS = 365;
export const CONTENT_EFFORT = "medium" as const;
export const PRIORITY_CUTOFFS = { high: 40, medium: 15 } as const;

export const CONTENT_EVIDENCE_LABELS = {
  competitors: "Competitor columns appear only for competitor URLs you approve; Okara does not crawl competitors automatically.",
  depth: `Depth is the extracted main-text word count; flagged for review below ${THIN_WORDS.article} words (articles, landing, other) or ${THIN_WORDS.product} words (home, product, collection). A rough proxy, not a quality score.`,
  proof: "Proof counts outbound source links and HTML tables found in the crawled HTML.",
  freshness: `Freshness uses the last-updated date found in the page HTML (meta or JSON-LD dateModified); older than ${STALE_DAYS} days is flagged for review; no date is unknown.`,
  priority: `Priority uses the SEO priority formula (${PRIORITY_VERSION}) with the page's share of your Search Console impressions/clicks, effort ${CONTENT_EFFORT}; it is computed only for pages with a flagged gap. High >= ${PRIORITY_CUTOFFS.high}, medium >= ${PRIORITY_CUTOFFS.medium}, else low. A ranking signal, not a traffic forecast.`,
} as const;

const DAY_MS = 86_400_000;

export function depthCell(s: Pick<Snap, "wordCount" | "pageType">): ContentEvidenceRow["depth"] {
  if (s.wordCount === null || s.wordCount === undefined) return { wordCount: null, status: "unknown" };
  return { wordCount: s.wordCount, status: s.wordCount < THIN_WORDS[s.pageType] ? "review" : "ok" };
}

export function proofCell(s: Pick<Snap, "outboundCitations" | "tableCount">): ContentEvidenceRow["proof"] {
  const o = s.outboundCitations;
  const t = s.tableCount;
  let status: ContentEvidenceRow["proof"]["status"];
  if ((o ?? 0) > 0 || (t ?? 0) > 0) status = "present";
  else if (o === 0 && t === 0) status = "missing";
  else status = "unknown";
  return { outboundCitations: o, tables: t, status };
}

/** Parse ISO dates / date-times / "YYYY-MM-DD"; null when not a real date. */
export function parseVisibleDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(t)) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T00:00:00Z` : t);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function freshnessCell(lastUpdated: string | null, now: Date): ContentEvidenceRow["freshness"] {
  const d = parseVisibleDate(lastUpdated);
  if (!d) return { lastUpdated: lastUpdated ?? null, ageDays: null, status: "unknown" };
  const ageDays = Math.floor((now.getTime() - d.getTime()) / DAY_MS);
  const status: AuditCellStatus = ageDays > STALE_DAYS || ageDays < -1 ? "review" : "ok";
  return { lastUpdated: lastUpdated, ageDays, status };
}

export function priorityLabel(value: number): "high" | "medium" | "low" {
  return value >= PRIORITY_CUTOFFS.high ? "high" : value >= PRIORITY_CUTOFFS.medium ? "medium" : "low";
}

export function gapsOf(row: Pick<ContentEvidenceRow, "depth" | "proof" | "freshness">): string[] {
  const gaps: string[] = [];
  if (row.depth.status === "review") gaps.push("thin for page type");
  if (row.proof.status === "missing") gaps.push("no outbound sources or tables");
  if (row.freshness.status === "review") gaps.push(row.freshness.ageDays !== null && row.freshness.ageDays < 0 ? "last-updated date in the future" : `last updated over ${STALE_DAYS} days ago`);
  return gaps;
}

export function contentPriority(
  row: Pick<ContentEvidenceRow, "depth" | "proof" | "freshness" | "gsc">,
  totals: { impressions: number; clicks: number } | null,
): ContentEvidenceRow["priority"] {
  const gaps = gapsOf(row);
  const nil = (basis: string): ContentEvidenceRow["priority"] => ({ value: null, label: null, version: null, basis });
  if (row.gsc.impressions === null || row.gsc.clicks === null) return nil("Unavailable: no Search Console data for this project (the formula needs the page's impression or click share).");
  if (!totals || (totals.impressions <= 0 && totals.clicks <= 0)) return nil("Unavailable: Search Console property totals are missing for this window.");
  if (gaps.length === 0) return nil("Not computed: no depth, proof, or freshness gap is flagged on this page.");
  const b = priorityBreakdown(
    { impressions: row.gsc.impressions, clicks: row.gsc.clicks, totalImpressions: totals.impressions, totalClicks: totals.clicks, severity: null, reach: null, effort: CONTENT_EFFORT },
    "n/a",
  );
  if (b.priority === null || b.metric === null) return nil("Unavailable: the page's Search Console share could not be computed.");
  const share = Math.max(totals.impressions > 0 ? row.gsc.impressions / totals.impressions : 0, totals.clicks > 0 ? row.gsc.clicks / totals.clicks : 0);
  return {
    value: b.priority,
    label: priorityLabel(b.priority),
    version: PRIORITY_VERSION,
    basis: `Gaps: ${gaps.join("; ")}. Page share of property impressions/clicks ${(share * 100).toFixed(1)}% (metric ${b.metric.toFixed(2)}) x effort ${CONTENT_EFFORT} (${EFFORT_FACTOR[CONTENT_EFFORT]}); severity and reach not applicable.`,
  };
}

export function contentEvidenceRow(s: Snap, gsc: GscPageData | null, now: Date): ContentEvidenceRow {
  const depth = depthCell(s);
  const proof = proofCell(s);
  const freshness = freshnessCell(s.lastUpdated, now);
  let gscCell: ContentEvidenceRow["gsc"] = { impressions: null, clicks: null, window: null };
  if (gsc) {
    const m = gsc.pages.get(pageKey(s.url) ?? s.url);
    gscCell = { impressions: m?.impressions ?? 0, clicks: m?.clicks ?? 0, window: gsc.window };
  }
  const base = { depth, proof, freshness, gsc: gscCell };
  return { pageId: s.pageId, url: s.url, pageType: s.pageType, ...base, priority: contentPriority(base, gsc?.totals ?? null) };
}

export async function buildContentEvidence(db: Db, project: ProjectRow, now: Date): Promise<CoverageResponse<ContentEvidenceRow>> {
  const generatedAt = now.toISOString();
  const labels: string[] = [];
  if (project.is_demo) labels.push(DEMO_LABEL);
  const data = await loadLatestCrawl(db, project);
  if (typeof data === "string") {
    const { state, note } = crawlAbsenceState(project, data);
    return { state, generatedAt, rows: [], completeness: { note, covered: null, total: null }, labels: [...labels, CONTENT_EVIDENCE_LABELS.competitors] };
  }
  const gsc = await loadGscPageData(db, project.workspace_id, project.id);
  const analysable = data.snaps.filter(isAnalyzable);
  const rows = analysable.map((s) => contentEvidenceRow(s, gsc, now));
  rows.sort((a, b) => (b.priority.value ?? -1) - (a.priority.value ?? -1) || a.url.localeCompare(b.url));

  labels.push(crawlLabel(data), CONTENT_EVIDENCE_LABELS.depth, CONTENT_EVIDENCE_LABELS.proof, CONTENT_EVIDENCE_LABELS.freshness, CONTENT_EVIDENCE_LABELS.priority);
  if (!gsc) {
    labels.push("No Search Console data yet: impressions, clicks, and priority are unavailable.");
  } else {
    labels.push(
      `Search Console ${gsc.source === "csv_import" ? "(imported CSV) " : gsc.source === "demo" ? "(demo data) " : ""}current window ${gsc.window.start} to ${gsc.window.end}. Page/query slices can omit anonymized queries${gsc.truncated ? " and were truncated at the project row cap" : ""}; a page with no rows shows 0.`,
    );
    if ([...gsc.pages.values()].some((m) => m.basis === "query_page_rows")) labels.push("Page metrics are summed from query x page rows (a lower bound; anonymized queries are omitted).");
    if (!gsc.totals) labels.push("Search Console property totals are missing, so priority is unavailable.");
  }
  labels.push(CONTENT_EVIDENCE_LABELS.competitors);

  const base = crawlCompleteness(data);
  const excluded = data.snaps.length - analysable.length;
  return {
    state: project.is_demo ? "demo" : "ready",
    generatedAt,
    rows,
    completeness: {
      note: `${base.note}${excluded > 0 ? `; ${excluded} page(s) without analysable content (skipped, error, or redirect) are not listed` : ""}`,
      covered: analysable.length,
      total: data.snaps.length,
    },
    labels,
  };
}
