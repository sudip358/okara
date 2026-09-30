/**
 * Loads everything the candidate builder needs, tenant-scoped, as plain data (no further I/O after
 * this). The crawler (seo-crawl module) writes pages/page_snapshots/audit_findings; the GEO agent
 * writes geo_search_queries; the internal-link suggester writes link_suggestions; this module only
 * reads them.
 *
 * [A23]/[A25] additions: brand terms (self + competitor, gsc/brand.ts), the sync's extra slices
 * (YoY pages, query+page weeks, countries), per-page JSON-LD types, word count, content hashes of the
 * last two snapshots (content-change cause for decay), today's date (freshness), and the top act-tier
 * internal link suggestions. `queryFilter` is filled by generate.ts after the query relevance pre-pass.
 */
import type { DateWindow, PageType, Severity } from "@shared/types";
import { parseJson } from "../../lib/db";
import { addDays, utcDay } from "../../lib/time";
import type { RunContext } from "../../runs/context";
import type { LinkSuggestion } from "@shared/types";
import { topLinkSuggestionsForAgent } from "../../links/report";
import { parseTotalsJson, toWindowTotals, type SliceRow, type WindowTotals } from "../gsc/aggregate";
import { brandTermsFrom, type BrandTerms } from "../gsc/brand";
import { localeCountryAlpha2 } from "../gsc/countries";
import { latestUsableSync } from "../gsc/overview";
import type { ExtrasJson } from "../gsc/slices";
import { looksLikeInstructions, normalizeUrl, resolveUrl, tokens } from "./text";

const PAGE_TYPES: ReadonlySet<PageType> = new Set(["home", "collection", "product", "article", "landing", "other"]);

export interface PageInfo {
  pageId: string;
  snapshotId: string;
  url: string;
  norm: string;
  pageType: PageType;
  title: string | null;
  metaDescription: string | null;
  h1: string | null;
  headings: string[];
  excerpt: string | null;
  internalLinks: string[];
  fetchedAt: string;
  /** [A14] deterministic pre-screen: instruction-like text found in title/headings/excerpt. */
  tainted: boolean;
  /** First paragraph as extracted by the crawler (null when not extracted). */
  firstParagraph?: string | null;
  /** JSON-LD @type values found on the page. */
  jsonLdTypes?: string[];
  wordCount?: number | null;
  /** Content hash of this snapshot and of the page's previous snapshot (another crawl), when both exist. */
  contentHash?: string | null;
  previousContentHash?: string | null;
  previousFetchedAt?: string | null;
}

export interface FindingInfo {
  id: string;
  ruleId: string;
  severity: Severity;
  url: string | null;
  template: string | null;
  detail: string;
  /** Page type recorded by the crawler (evidence_json.pageType), when present. */
  pageType: PageType | null;
  /** URLs of this page type sharing the issue, as counted by the crawler (evidence_json.templateAffectedUrls). */
  templateAffectedUrls: number | null;
}

export interface EngineQueryGroup {
  normalized: string;
  example: string;
  count: number;
  providers: string[];
  models: string[];
  observationIds: string[];
}

/** [A23] Query relevance pre-filter results (keys: gsc/demand normalizeDemandQuery). */
export interface QueryFilter {
  /** Confident "not about this business": excluded from candidate generation. */
  dropped: Set<string>;
  /** Middle band: candidates built on these queries are capped at Flag ("Check this yourself"). */
  flagged: Set<string>;
  version: string;
}

export interface CandidateInputs {
  /** brandTokens: title tokens of the brand name and aliases (excluded from duplicate-title overlap). */
  project: {
    id: string;
    siteType: string;
    locale: string;
    language: string;
    brandTokens: string[];
    /** [A23] Normalized self/competitor brand terms (gsc/brand.ts). */
    brandTerms?: BrandTerms;
    brandName?: string;
    productDescription?: string;
    audience?: string;
    /** ISO alpha-2 region from the locale ("en-US" -> "US"), null when absent. */
    country?: string | null;
  };
  sync: {
    id: string;
    source: "api" | "csv_import" | "demo";
    current: DateWindow;
    previous: DateWindow;
    totals: { current: WindowTotals | null; previous: WindowTotals | null };
    truncated: boolean;
    /** [A23]/[A25] extra slices (API syncs). */
    extras?: ExtrasJson | null;
  } | null;
  /** Today (YYYY-MM-DD, UTC) for freshness checks. */
  today?: string;
  /** [A25] Top open internal link suggestions of the latest suggester run (act tier used). */
  linkSuggestions?: LinkSuggestion[];
  /** [A23] Set by generate.ts after the query relevance pre-filter. */
  queryFilter?: QueryFilter | null;
  rows: SliceRow[];
  crawl: { id: string; day: string; crawledCount: number } | null;
  pages: PageInfo[];
  findings: FindingInfo[];
  engineQueries: EngineQueryGroup[];
  pillars: { names: string[]; docId: string; version: number } | null;
}

/** Engine search queries older than this are ignored. */
export const ENGINE_QUERY_LOOKBACK_DAYS = 30;
/** Internal link suggestions read per run (only act-tier ones become candidates). */
export const LINK_SUGGESTIONS_FOR_AGENT = 20;

export async function loadCandidateInputs(ctx: RunContext): Promise<CandidateInputs> {
  const ws = ctx.project.workspaceId;
  const pid = ctx.project.id;
  const project = await ctx.db.first<{
    site_type: string;
    locale: string;
    language: string;
    brand_name: string;
    brand_aliases_json: string;
    competitors_json: string | null;
    product_description: string | null;
    audience: string | null;
  }>(
    "SELECT site_type, locale, language, brand_name, brand_aliases_json, competitors_json, product_description, audience FROM projects WHERE id = ? AND workspace_id = ?",
    pid,
    ws,
  );

  const syncRow = await latestUsableSync(ctx.db, ws, pid);
  let sync: CandidateInputs["sync"] = null;
  let rows: SliceRow[] = [];
  if (syncRow) {
    const t = parseTotalsJson(syncRow.totals_json);
    sync = {
      id: syncRow.id,
      source: syncRow.source,
      current: { start: syncRow.window_start, end: syncRow.window_end },
      previous: { start: syncRow.prev_window_start, end: syncRow.prev_window_end },
      totals: { current: toWindowTotals(t.current), previous: toWindowTotals(t.previous) },
      truncated: syncRow.truncated === 1,
      extras: t.extras ?? null,
    };
    rows = await ctx.db.all<SliceRow>(
      "SELECT window, query, page, clicks, impressions, ctr, position FROM gsc_metrics WHERE workspace_id = ? AND project_id = ? AND sync_id = ?",
      ws,
      pid,
      syncRow.id,
    );
  }

  const crawlRow = await ctx.db.first<{ id: string; started_at: string; finished_at: string | null }>(
    `SELECT id, started_at, finished_at FROM crawl_runs WHERE workspace_id = ? AND project_id = ? AND status IN ('completed', 'partial')
      ORDER BY started_at DESC LIMIT 1`,
    ws,
    pid,
  );
  let pages: PageInfo[] = [];
  let findings: FindingInfo[] = [];
  let crawl: CandidateInputs["crawl"] = null;
  if (crawlRow) {
    const snaps = await ctx.db.all<{
      id: string;
      page_id: string;
      url: string;
      page_type: PageType;
      final_url: string | null;
      status_code: number | null;
      skipped_reason: string | null;
      title: string | null;
      meta_description: string | null;
      h1_json: string;
      headings_json: string;
      internal_links_json: string;
      main_text_excerpt: string | null;
      first_paragraph: string | null;
      fetched_at: string;
      jsonld_types_json: string | null;
      word_count: number | null;
      content_hash: string | null;
    }>(
      `SELECT s.id, s.page_id, p.url, p.page_type, s.final_url, s.status_code, s.skipped_reason, s.title, s.meta_description,
              s.h1_json, s.headings_json, s.internal_links_json, s.main_text_excerpt, s.first_paragraph, s.fetched_at,
              s.jsonld_types_json, s.word_count, s.content_hash
         FROM page_snapshots s JOIN pages p ON p.id = s.page_id AND p.workspace_id = s.workspace_id
        WHERE s.workspace_id = ? AND s.project_id = ? AND s.crawl_run_id = ?`,
      ws,
      pid,
      crawlRow.id,
    );
    for (const s of snaps) {
      // Only analyzable pages (2xx, not skipped, not redirected elsewhere) are content candidates.
      if (s.skipped_reason || s.status_code === null || s.status_code < 200 || s.status_code >= 300) continue;
      if (s.final_url && normalizeUrl(s.final_url) !== normalizeUrl(s.url)) continue;
      const h1List = parseJson<unknown[]>(s.h1_json, []).map(textOf).filter(Boolean) as string[];
      const headings = parseJson<unknown[]>(s.headings_json, []).map(textOf).filter(Boolean).slice(0, 40) as string[];
      const links = parseJson<unknown[]>(s.internal_links_json, [])
        .map((l) => (typeof l === "string" ? l : l && typeof l === "object" ? ((l as { url?: string; href?: string }).url ?? (l as { href?: string }).href ?? null) : null))
        .filter((x): x is string => typeof x === "string")
        .map((href) => resolveUrl(href, s.url))
        .filter((x): x is string => x !== null);
      const excerpt = s.first_paragraph || s.main_text_excerpt;
      pages.push({
        pageId: s.page_id,
        snapshotId: s.id,
        url: s.url,
        norm: normalizeUrl(s.url),
        pageType: s.page_type,
        title: s.title,
        metaDescription: s.meta_description,
        h1: h1List[0] ?? null,
        headings,
        excerpt: excerpt ? excerpt.slice(0, 6000) : null,
        internalLinks: [...new Set(links)],
        fetchedAt: s.fetched_at,
        tainted: [s.title, s.meta_description, ...h1List, ...headings, s.main_text_excerpt, s.first_paragraph].some(looksLikeInstructions),
        firstParagraph: s.first_paragraph,
        jsonLdTypes: parseJson<unknown[]>(s.jsonld_types_json ?? "[]", []).filter((t): t is string => typeof t === "string").slice(0, 30),
        wordCount: s.word_count,
        contentHash: s.content_hash,
        previousContentHash: null,
        previousFetchedAt: null,
      });
    }
    // Previous snapshot (another crawl) of each page: the content-change cause for decaying pages.
    if (pages.length) {
      const prev = await ctx.db.all<{ page_id: string; content_hash: string | null; fetched_at: string }>(
        `SELECT page_id, content_hash, fetched_at FROM page_snapshots
          WHERE workspace_id = ? AND project_id = ? AND crawl_run_id != ? AND content_hash IS NOT NULL AND skipped_reason IS NULL
          ORDER BY fetched_at DESC LIMIT 5000`,
        ws,
        pid,
        crawlRow.id,
      );
      const byPage = new Map<string, { content_hash: string | null; fetched_at: string }>();
      for (const r of prev) if (!byPage.has(r.page_id)) byPage.set(r.page_id, r);
      for (const p of pages) {
        const r = byPage.get(p.pageId);
        if (r && r.fetched_at < p.fetchedAt) {
          p.previousContentHash = r.content_hash;
          p.previousFetchedAt = r.fetched_at;
        }
      }
    }
    findings = (
      await ctx.db.all<{ id: string; rule_id: string; severity: Severity; url: string | null; template: string | null; detail: string; evidence_json: string }>(
        "SELECT id, rule_id, severity, url, template, detail, evidence_json FROM audit_findings WHERE workspace_id = ? AND project_id = ? AND crawl_run_id = ?",
        ws,
        pid,
        crawlRow.id,
      )
    ).map((f) => {
      const ev = parseJson<Record<string, unknown>>(f.evidence_json, {});
      const pageType = typeof ev.pageType === "string" && PAGE_TYPES.has(ev.pageType as PageType) ? (ev.pageType as PageType) : null;
      const n = typeof ev.templateAffectedUrls === "number" && Number.isFinite(ev.templateAffectedUrls) ? ev.templateAffectedUrls : null;
      return { id: f.id, ruleId: f.rule_id, severity: f.severity, url: f.url, template: f.template, detail: f.detail, pageType, templateAffectedUrls: n };
    });
    crawl = { id: crawlRow.id, day: (crawlRow.finished_at ?? crawlRow.started_at).slice(0, 10), crawledCount: pages.length };
  }

  const since = `${addDays(utcDay(ctx.clock()), -ENGINE_QUERY_LOOKBACK_DAYS)}T00:00:00.000Z`;
  const sq = await ctx.db.all<{ normalized: string; query: string; provider: string; model: string; observation_id: string }>(
    `SELECT normalized, query, provider, model, observation_id FROM geo_search_queries
      WHERE workspace_id = ? AND project_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 2000`,
    ws,
    pid,
    since,
  );
  const groups = new Map<string, EngineQueryGroup>();
  for (const r of sq) {
    const key = r.normalized.trim();
    if (!key) continue;
    const g = groups.get(key) ?? { normalized: key, example: r.query, count: 0, providers: [], models: [], observationIds: [] };
    g.count++;
    if (!g.providers.includes(r.provider)) g.providers.push(r.provider);
    if (!g.models.includes(r.model)) g.models.push(r.model);
    if (g.observationIds.length < 5 && !g.observationIds.includes(r.observation_id)) g.observationIds.push(r.observation_id);
    groups.set(key, g);
  }

  const pillarDoc = await ctx.db.first<{ id: string; version: number; content: string; facts_json: string }>(
    `SELECT id, version, content, facts_json FROM context_documents WHERE workspace_id = ? AND project_id = ? AND kind = 'pillars'
      ORDER BY version DESC LIMIT 1`,
    ws,
    pid,
  );
  const pillarNames = pillarDoc ? parsePillars(pillarDoc.content) : [];

  const aliases = project ? parseJson<unknown[]>(project.brand_aliases_json, []).filter((a): a is string => typeof a === "string") : [];
  const brandTokens = project ? [...new Set([project.brand_name, ...aliases].flatMap((b) => tokens(b)))] : [];
  const competitors = project
    ? parseJson<unknown[]>(project.competitors_json ?? "[]", [])
        .filter((c): c is { name?: unknown; aliases?: unknown } => !!c && typeof c === "object")
        .map((c) => ({ name: typeof c.name === "string" ? c.name : null, aliases: Array.isArray(c.aliases) ? c.aliases.filter((a): a is string => typeof a === "string") : [] }))
    : [];
  const brandTerms = brandTermsFrom({ brandName: project?.brand_name ?? null, brandAliases: aliases, competitors });

  // [A25] Internal link suggestions (never fatal: the suggester may not have run).
  let linkSuggestions: LinkSuggestion[] = [];
  try {
    linkSuggestions = await topLinkSuggestionsForAgent(ctx.db, ws, pid, LINK_SUGGESTIONS_FOR_AGENT);
  } catch {
    linkSuggestions = [];
  }

  const locale = project?.locale ?? "en-US";
  return {
    project: {
      id: pid,
      siteType: project?.site_type ?? "other",
      locale,
      language: project?.language ?? "en",
      brandTokens,
      brandTerms,
      brandName: project?.brand_name ?? "",
      productDescription: project?.product_description ?? "",
      audience: project?.audience ?? "",
      country: localeCountryAlpha2(locale),
    },
    today: utcDay(ctx.clock()),
    linkSuggestions,
    queryFilter: null,
    sync,
    rows,
    crawl,
    pages,
    findings,
    engineQueries: [...groups.values()].sort((a, b) => b.count - a.count),
    pillars: pillarDoc && pillarNames.length ? { names: pillarNames, docId: pillarDoc.id, version: pillarDoc.version } : null,
  };
}

function textOf(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (v && typeof v === "object" && typeof (v as { text?: unknown }).text === "string") return ((v as { text: string }).text).trim() || null;
  return null;
}

/** Pillar names from the pillars document: one per non-empty line, bullets/numbering stripped. */
export function parsePillars(content: string): string[] {
  return [
    ...new Set(
      content
        .split(/\r?\n/)
        .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(/^#+\s*/, "").split(/[:—–]/)[0]!.trim())
        .filter((l) => l.length > 1 && l.length <= 60),
    ),
  ].slice(0, 12);
}
