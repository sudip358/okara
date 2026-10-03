/**
 * Loads the LATEST SNAPSHOT OF EVERY PAGE across crawls (internal-links workbench, item 1), not only the latest
 * crawl: for each page, its newest snapshot from a completed or partial crawl run (plus, optionally, the crawl that
 * is still writing, so the crawl step can build the graph before finalizing). Keyset-paged by page id
 * (GRAPH_LOAD_PAGE rows per query), bounded by MAX_GRAPH_PAGES, tenant-scoped (workspace_id + project_id on every
 * table). Compact evidence only; page text is untrusted evidence, never instructions.
 */
import type { Db } from "../lib/db";
import { parseJson } from "../lib/db";
import type { LinkAnchor } from "../seo/crawl/extract";
import { linkContextSentences } from "../seo/crawl/extract";

/** Pages read per query (each row carries its snapshot's link lists, roughly 10–40 KB). */
export const GRAPH_LOAD_PAGE = 200;
/** Pages with a snapshot considered per graph (bounded; the inventory itself is capped at 10,000 URLs). */
export const MAX_GRAPH_PAGES = 10_000;

export interface SnapshotRecord {
  pageId: string;
  url: string;
  pageType: string;
  snapshotId: string;
  crawlRunId: string;
  fetchedAt: string;
  statusCode: number | null;
  finalUrl: string | null;
  skippedReason: string | null;
  redirectChain: Array<{ status: number; to: string }> | null;
  title: string | null;
  h1s: string[];
  /** Headings other than H1 (text only). */
  headings: string[];
  canonical: string | null;
  robotsMeta: string | null;
  internalLinks: string[];
  /** null = snapshot taken before anchors were recorded. */
  linkAnchors: LinkAnchor[] | null;
  /** Text columns (only when loaded with `text: true`). */
  sentences: string[];
  sentenceSource: "crawl" | "excerpt" | "none";
  genericAnchors: Array<{ href: string; text: string }>;
}

interface Row {
  page_id: string;
  url: string;
  page_type: string;
  snapshot_id: string;
  crawl_run_id: string;
  fetched_at: string;
  status_code: number | null;
  final_url: string | null;
  skipped_reason: string | null;
  redirect_chain_json: string | null;
  title: string | null;
  h1_json: string;
  headings_json: string;
  canonical: string | null;
  robots_meta: string | null;
  internal_links_json: string;
  link_anchors_json: string | null;
  link_context_json?: string | null;
  main_text_excerpt?: string | null;
  first_paragraph?: string | null;
  generic_anchors_json?: string | null;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function parseLinkAnchors(raw: string | null | undefined): LinkAnchor[] | null {
  if (raw === null || raw === undefined) return null;
  const v = parseJson<unknown[]>(raw, []);
  const out: LinkAnchor[] = [];
  for (const e of v) {
    if (!Array.isArray(e) || typeof e[0] !== "string") continue;
    const kind = e[2] === "b" || e[2] === "i" ? e[2] : "c";
    out.push([e[0], typeof e[1] === "string" ? e[1] : "", kind]);
  }
  return out;
}

function toRecord(r: Row, text: boolean): SnapshotRecord {
  const headings = parseJson<unknown[]>(r.headings_json, [])
    .filter((h): h is { level: number; text: string } => !!h && typeof h === "object" && typeof (h as { text?: unknown }).text === "string")
    .filter((h) => h.level !== 1)
    .map((h) => h.text);
  let sentences: string[] = [];
  let sentenceSource: SnapshotRecord["sentenceSource"] = "none";
  let genericAnchors: SnapshotRecord["genericAnchors"] = [];
  if (text) {
    sentences = strings(parseJson<unknown>(r.link_context_json ?? "[]", []));
    sentenceSource = sentences.length ? "crawl" : "none";
    if (sentences.length === 0) {
      // Older snapshots (or seeded demo data) have no stored sentences: split the stored excerpt instead.
      const fallback = linkContextSentences([r.first_paragraph ?? "", r.main_text_excerpt ?? ""].filter(Boolean));
      if (fallback.length) {
        sentences = fallback;
        sentenceSource = "excerpt";
      }
    }
    genericAnchors = parseJson<unknown[]>(r.generic_anchors_json ?? "[]", []).filter(
      (g): g is { href: string; text: string } => !!g && typeof g === "object" && typeof (g as { href?: unknown }).href === "string" && typeof (g as { text?: unknown }).text === "string",
    );
  }
  const chain = parseJson<unknown[] | null>(r.redirect_chain_json, null);
  return {
    pageId: r.page_id,
    url: r.url,
    pageType: r.page_type,
    snapshotId: r.snapshot_id,
    crawlRunId: r.crawl_run_id,
    fetchedAt: r.fetched_at,
    statusCode: r.status_code === null || r.status_code === undefined ? null : Number(r.status_code),
    finalUrl: r.final_url,
    skippedReason: r.skipped_reason,
    redirectChain: Array.isArray(chain)
      ? chain
          .filter((h): h is { status: number; to: string } => !!h && typeof h === "object" && typeof (h as { to?: unknown }).to === "string")
          .map((h) => ({ status: Number(h.status), to: h.to }))
          .slice(0, 10)
      : null,
    title: r.title,
    h1s: strings(parseJson<unknown>(r.h1_json, [])),
    headings,
    canonical: r.canonical,
    robotsMeta: r.robots_meta,
    internalLinks: strings(parseJson<unknown>(r.internal_links_json, [])),
    linkAnchors: parseLinkAnchors(r.link_anchors_json),
    sentences,
    sentenceSource,
    genericAnchors,
  };
}

export interface LatestSnapshots {
  rows: SnapshotRecord[];
  /** More pages than MAX_GRAPH_PAGES have snapshots; the rest were not loaded. */
  truncated: boolean;
}

/**
 * Latest usable snapshot per page. `includeCrawlRunId` also admits that crawl run's snapshots while it is still
 * 'running' (the crawl step builds the graph before it finalizes the run).
 */
export async function loadLatestSnapshots(
  db: Db,
  project: { id: string; workspace_id: string },
  opts: { includeCrawlRunId?: string | null; text?: boolean; maxPages?: number } = {},
): Promise<LatestSnapshots> {
  const text = opts.text === true;
  const max = Math.max(1, Math.min(MAX_GRAPH_PAGES, Math.floor(opts.maxPages ?? MAX_GRAPH_PAGES)));
  const cols = [
    "p.id AS page_id",
    "p.url",
    "p.page_type",
    "s.id AS snapshot_id",
    "s.crawl_run_id",
    "s.fetched_at",
    "s.status_code",
    "s.final_url",
    "s.skipped_reason",
    "s.redirect_chain_json",
    "s.title",
    "s.h1_json",
    "s.headings_json",
    "s.canonical",
    "s.robots_meta",
    "s.internal_links_json",
    "s.link_anchors_json",
    ...(text ? ["s.link_context_json", "s.main_text_excerpt", "s.first_paragraph", "s.generic_anchors_json"] : []),
  ].join(", ");
  const rows: SnapshotRecord[] = [];
  let after = "";
  let truncated = false;
  for (;;) {
    const limit = Math.min(GRAPH_LOAD_PAGE, max - rows.length + 1);
    const batch = await db.all<Row>(
      `SELECT ${cols}
         FROM pages p
         JOIN page_snapshots s ON s.id = (
              SELECT s2.id FROM page_snapshots s2
                JOIN crawl_runs c ON c.id = s2.crawl_run_id AND c.workspace_id = s2.workspace_id
               WHERE s2.page_id = p.id AND s2.workspace_id = p.workspace_id AND s2.project_id = p.project_id
                 AND (c.status IN ('completed', 'partial') OR c.id = ?)
               ORDER BY s2.fetched_at DESC, s2.rowid DESC LIMIT 1)
        WHERE p.workspace_id = ? AND p.project_id = ? AND p.url > ?
        ORDER BY p.url LIMIT ?`,
      opts.includeCrawlRunId ?? "",
      project.workspace_id,
      project.id,
      after,
      limit,
    );
    for (const r of batch) {
      if (rows.length >= max) {
        truncated = true;
        break;
      }
      rows.push(toRecord(r, text));
    }
    if (truncated || batch.length < limit) break;
    // Keyset on url: pages are unique by (project_id, url), so the UNIQUE index serves the filter and the order.
    after = batch[batch.length - 1]!.url;
  }
  return { rows, truncated };
}
