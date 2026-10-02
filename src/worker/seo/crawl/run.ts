/**
 * seo-crawl entry point: crawl the verified host within limits, extract compact evidence, classify
 * page types, run the rule registry and the AI crawler access check, and persist everything to D1.
 *
 * Safety: every request (robots.txt, sitemaps, pages, llms.txt) goes through guardedFetch over
 * ctx.crawlFetch; robots.txt is honoured for our own product token (the same token as the fetch UA),
 * including Crawl-delay. Only compact evidence is stored, never full HTML.
 */
import type { PageType, SiteType } from "@shared/types";
import type { RunContext } from "../../runs/context";
import { BudgetExceededError } from "../../lib/errors";
import { newId } from "../../lib/ids";
import { sha256Hex } from "../../lib/hash";
import { iso } from "../../lib/time";
import { insertStatement, parseJson } from "../../lib/db";
import { assertCrawlableUrl, CrawlFetchError, guardedFetch, type CrawlFetchErrorCode } from "../ssrf";
import { CRAWLER_UA_TOKEN, crawlerUserAgent, fetchRobots, robotsAllows, robotsCrawlDelay, selectGroup, type RobotsState } from "./robots";
import { collectSitemapUrls, SITEMAP_MAX_URLS, type SitemapResult } from "./sitemap";
import { extractPage, LINK_CONTEXT_MIN_WORDS, type ExtractedPage, type JsonLdIssue } from "./extract";
import { classifyPageType } from "./page-type";
import { normalizeUrlKey, runRules, RULESET_VERSION, type RuleSnapshot } from "../rules/registry";
import { checkLlmsTxt, evaluateAiCrawlerAccess } from "../rules/ai-crawlers";

export interface CrawlSummary { crawlRunId: string | null; pagesCrawled: number; pagesSkipped: number; findings: number; status: "completed" | "partial" | "failed" | "setup_required"; note: string }

export interface CrawlOptions {
  concurrency?: number;
  pageMaxBytes?: number;
  pageTimeoutMs?: number;
  /** Wall-clock budget for politeness waits; large crawl-delays reduce the page count instead of being ignored. */
  maxCrawlSeconds?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /**
   * Wall-clock budget for the whole crawl, below the 10-minute crawl step timeout (workflow.ts) so the
   * crawl can still finish its rules and writes: past it no new page is fetched and the crawl is 'partial'.
   */
  deadlineMs?: number;
}

export const DEFAULT_CRAWL_PAGES = 20;
export const MAX_CRAWL_PAGES = 500;
const MAX_SKIP_RECORDS = 50;
/** Default crawl wall-clock budget: 7.5 minutes of the 10-minute step timeout. */
export const CRAWL_DEADLINE_MS = 450_000;
/** Cancellation is checked every loop turn for the first pages, then once per this many dispatched pages. */
const CANCEL_CHECK_EVERY = 10;
/** page_snapshots rows are written in D1 batches of this size (one round trip per batch). */
const SNAPSHOT_BATCH = 10;
const QUEUE_CAP = 1000;
const NON_HTML_EXT = /\.(jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|pdf|zip|gz|tgz|rar|7z|mp4|m4v|mov|webm|mp3|wav|ogg|css|js|mjs|json|xml|txt|csv|xlsx?|docx?|pptx?|woff2?|ttf|otf|eot)$/i;

type SkipReason = "robots_disallowed" | "non_html" | "too_large" | "too_complex" | "timeout" | "js_rendered" | "redirect_offsite" | "error";

function skipReasonFor(code: CrawlFetchErrorCode): SkipReason {
  switch (code) {
    case "non_html":
    case "too_large":
    case "timeout":
    case "redirect_offsite":
      return code;
    default:
      return "error";
  }
}

export function completenessNote(crawled: number, skippedByReason: Record<string, number>, limit: number | null, limitReached = false): string {
  const skipped = Object.values(skippedByReason).reduce((a, b) => a + b, 0);
  const total = crawled + skipped;
  let note = `${crawled} of ${total} pages crawled`;
  if (skipped > 0) {
    const parts = Object.entries(skippedByReason)
      .filter(([, n]) => n > 0)
      .map(([r, n]) => `${r} (${n})`);
    note += `; ${skipped} skipped: ${parts.join(", ")}`;
  }
  if (limit !== null && limitReached) note += `; page limit ${limit} reached`;
  return note;
}

export async function runCrawl(ctx: RunContext): Promise<CrawlSummary> {
  return runCrawlWith(ctx, {});
}

export async function runCrawlWith(ctx: RunContext, opts: CrawlOptions): Promise<CrawlSummary> {
  const { db, project } = ctx;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const deadline = now() + (opts.deadlineMs ?? CRAWL_DEADLINE_MS);

  const proj = await db.first<{ id: string; workspace_id: string; site_type: SiteType; verified_host: string | null }>(
    "SELECT id, workspace_id, site_type, verified_host FROM projects WHERE id = ? AND workspace_id = ?",
    project.id,
    project.workspaceId,
  );
  if (!proj) {
    await ctx.log.event("crawl", "failed", "Project not found.");
    return { crawlRunId: null, pagesCrawled: 0, pagesSkipped: 0, findings: 0, status: "failed", note: "Project not found." };
  }
  if (!proj.verified_host) {
    const note = "Site ownership is not verified; crawling is disabled until verification (GSC, DNS, or file).";
    await ctx.log.event("crawl", "skipped", note);
    return { crawlRunId: null, pagesCrawled: 0, pagesSkipped: 0, findings: 0, status: "setup_required", note };
  }
  const host = proj.verified_host;
  try {
    assertCrawlableUrl(`https://${host}/`, host);
  } catch (e) {
    const note = `Verified host cannot be crawled safely: ${(e as Error).message}`;
    await ctx.log.event("crawl", "failed", note);
    return { crawlRunId: null, pagesCrawled: 0, pagesSkipped: 0, findings: 0, status: "failed", note };
  }

  const limitRow = await db.first<{ crawl_pages: number }>("SELECT crawl_pages FROM project_limits WHERE project_id = ? AND workspace_id = ?", project.id, project.workspaceId);
  let pageLimit = Math.max(1, Math.min(MAX_CRAWL_PAGES, Number(limitRow?.crawl_pages ?? DEFAULT_CRAWL_PAGES) || DEFAULT_CRAWL_PAGES));

  // A Workflow step retry re-runs this function under the same run id. Reuse that run's crawl_runs row
  // (and its still-reserved page reservation) instead of creating a second row and reserving again.
  const prior = ctx.runId
    ? await db.first<{ id: string; status: string; pages_crawled: number; pages_skipped: number; notes_json: string }>(
        "SELECT id, status, pages_crawled, pages_skipped, notes_json FROM crawl_runs WHERE run_id = ? AND project_id = ? AND workspace_id = ? ORDER BY started_at DESC LIMIT 1",
        ctx.runId,
        project.id,
        project.workspaceId,
      )
    : null;
  // The page reservation an earlier attempt of this run left 'reserved'. Looked up whenever there is a
  // run id, not only when a crawl_runs row exists: reserve() runs before the row is inserted, so an
  // attempt that died in between left a reservation but no row.
  const held = ctx.runId
    ? await db.first<{ id: string; amount: number }>(
        `SELECT id, amount FROM usage_reservations
          WHERE run_id = ? AND project_id = ? AND workspace_id = ? AND resource = 'crawl_pages' AND status = 'reserved' AND id NOT LIKE '%\\_g' ESCAPE '\\'
          ORDER BY created_at DESC LIMIT 1`,
        ctx.runId,
        project.id,
        project.workspaceId,
      )
    : null;
  if (prior && (prior.status === "completed" || prior.status === "partial")) {
    // The crawl already finished (the step failed afterwards): return its stored result, crawl nothing.
    // If the attempt died between recording the result and settling, settle the reservation now.
    if (held) {
      const used = Math.min(Number(held.amount), Number(prior.pages_crawled) + Number(prior.pages_skipped));
      await ctx.budget.settle(held.id, used).catch(() => undefined);
    }
    const n = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM audit_findings WHERE crawl_run_id = ? AND workspace_id = ?", prior.id, project.workspaceId);
    const note = parseJson<string[]>(prior.notes_json, [])[0] ?? "";
    return { crawlRunId: prior.id, pagesCrawled: prior.pages_crawled, pagesSkipped: prior.pages_skipped, findings: Number(n?.n ?? 0), status: prior.status, note };
  }

  let reservation: string | null = null;
  // On reuse, the settle amount also covers what the interrupted attempt fetched (see settleAmount).
  let reusedAmount: number | null = null;
  let priorFetched = 0;
  if (held) {
    reservation = held.id;
    reusedAmount = Number(held.amount);
    pageLimit = Math.max(1, Math.min(pageLimit, reusedAmount));
    if (prior) {
      // Pages the interrupted attempt fetched (recorded snapshots; its evidence is deleted below).
      const f = await db.first<{ n: number }>(
        "SELECT COUNT(*) AS n FROM page_snapshots WHERE crawl_run_id = ? AND workspace_id = ? AND (status_code IS NOT NULL OR skipped_reason = 'error')",
        prior.id,
        project.workspaceId,
      );
      priorFetched = Number(f?.n ?? 0);
    }
  }
  // What a reused reservation is settled at. If the interrupted attempt had created its crawl_runs row it
  // may have fetched pages (some still in flight, with no snapshot): at least the full amount, more if
  // both attempts together fetched more. With no row it died before crawling, so only this attempt counts.
  const priorMayHaveFetched = prior !== null;
  const settleAmount = (fetches: number) =>
    reusedAmount === null || !priorMayHaveFetched ? fetches : Math.max(reusedAmount, fetches + priorFetched);
  if (reservation === null) {
    try {
      reservation = await ctx.budget.reserve("crawl_pages", pageLimit);
    } catch (e) {
      if (e instanceof BudgetExceededError) {
        const note = `Crawl page budget exhausted: ${e.message}`;
        if (prior) await markFailed(ctx, prior.id, note).catch(() => undefined);
        await ctx.log.event("crawl", "skipped", note);
        return { crawlRunId: null, pagesCrawled: 0, pagesSkipped: 0, findings: 0, status: "failed", note };
      }
      throw e;
    }
  }

  const crawlRunId = prior?.id ?? newId("crw");
  const startedAt = iso(ctx.clock());
  if (prior) {
    // Evidence from the interrupted attempt is incomplete; this attempt rewrites it under the same row.
    await db.batch([
      ["DELETE FROM audit_findings WHERE crawl_run_id = ? AND workspace_id = ?", crawlRunId, project.workspaceId],
      ["DELETE FROM page_snapshots WHERE crawl_run_id = ? AND workspace_id = ?", crawlRunId, project.workspaceId],
      [
        "UPDATE crawl_runs SET status = 'running', pages_limit = ?, pages_crawled = 0, pages_skipped = 0, notes_json = '[]', started_at = ?, finished_at = NULL WHERE id = ? AND workspace_id = ?",
        pageLimit,
        startedAt,
        crawlRunId,
        project.workspaceId,
      ],
    ]);
  } else {
    await db.insert("crawl_runs", {
      id: crawlRunId,
      workspace_id: project.workspaceId,
      project_id: project.id,
      run_id: ctx.runId,
      status: "running",
      pages_limit: pageLimit,
      started_at: startedAt,
    });
  }
  await ctx.log.event("crawl", "started", `Crawling https://${host}/ (limit ${pageLimit} pages).`);

  let fetches = 0;
  try {
    const ua = crawlerUserAgent(ctx.env.APP_ORIGIN);
    const notes: string[] = [];

    // ---- robots.txt
    const robots = await fetchRobots(ctx.crawlFetch, host, ua, { timeoutMs: opts.pageTimeoutMs });
    notes.push(robots.note);
    const delaySec = robotsCrawlDelay(robots, CRAWLER_UA_TOKEN);
    const maxSeconds = opts.maxCrawlSeconds ?? 240;
    if (delaySec && delaySec > 0) {
      const fit = Math.max(1, Math.floor(maxSeconds / delaySec) + 1);
      if (fit < pageLimit) {
        notes.push(`Crawl-delay ${delaySec}s honoured; page count reduced from ${pageLimit} to ${fit} to fit the crawl time budget.`);
        pageLimit = fit;
      } else notes.push(`Crawl-delay ${delaySec}s honoured.`);
    }
    await ctx.log.event("crawl", "info", robots.note);

    // ---- sitemaps
    // Sitemap lines may be relative (Shopify serves "Sitemap: /sitemap.xml"): resolve against the robots.txt URL.
    const declaredSitemaps = robots.parsed.sitemaps
      .map((s) => {
        try {
          return new URL(s, `https://${host}/robots.txt`).href;
        } catch {
          return null;
        }
      })
      .filter((s): s is string => s !== null);
    const sitemapCandidates = declaredSitemaps.length > 0 ? declaredSitemaps : [`https://${host}/sitemap.xml`];
    const sitemap =
      robots.status === "unreachable"
        ? { urls: [] as string[], source: new Map<string, string>(), entries: [] as SitemapResult["entries"], fetched: [] as string[], refused: [] as SitemapResult["refused"], notes: ["Sitemaps not read because robots.txt disallows all."] }
        : await collectSitemapUrls(ctx.crawlFetch, { verifiedHost: host, sitemapUrls: sitemapCandidates, userAgent: ua, timeoutMs: opts.pageTimeoutMs });
    notes.push(...sitemap.notes);
    if (sitemap.refused.length) notes.push(`${sitemap.refused.length} sitemap entr${sitemap.refused.length === 1 ? "y" : "ies"} refused by the SSRF/host guard.`);
    await ctx.log.event("crawl", "info", `Sitemaps: ${sitemap.fetched.length} read, ${sitemap.urls.length} URLs, ${sitemap.refused.length} refused.`);

    // ---- queue
    const seen = new Set<string>();
    const primary: string[] = [];
    const secondary: string[] = []; // query-string URLs: crawled only after clean URLs
    const enqueue = (raw: string) => {
      if (seen.size >= QUEUE_CAP) return;
      let u: URL;
      try {
        u = assertCrawlableUrl(raw, host);
      } catch {
        return;
      }
      if (NON_HTML_EXT.test(u.pathname)) return;
      const key = normalizeUrlKey(u.toString());
      if (seen.has(key)) return;
      seen.add(key);
      (u.search ? secondary : primary).push(u.toString());
    };
    enqueue(`https://${host}/`);
    sitemap.urls.forEach(enqueue);

    const snapshots: RuleSnapshot[] = [];
    const skipCounts: Record<string, number> = {};
    let skipRecords = 0;
    let crawled = 0;
    let cancelled = false;
    let nextSlot = 0;
    const delayMs = (delaySec ?? 0) * 1000;
    const concurrency = delayMs > 0 ? 1 : Math.max(1, Math.min(opts.concurrency ?? 2, 4));

    const politeness = async () => {
      if (delayMs <= 0) return;
      const t = now();
      const wait = Math.max(0, nextSlot - t);
      nextSlot = Math.max(t, nextSlot) + delayMs;
      if (wait > 0) await sleep(wait);
    };

    // One round trip: RETURNING gives the row's id and effective page type (user corrections kept).
    const upsertPage = async (url: string, cls: { pageType: PageType; method: string }, crawledAt: string | null) => {
      const row = await db.first<{ id: string; page_type: PageType }>(
        `INSERT INTO pages (id, workspace_id, project_id, url, page_type, page_type_method, first_seen_at, last_crawled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, url) DO UPDATE SET
           last_crawled_at = COALESCE(excluded.last_crawled_at, pages.last_crawled_at),
           page_type = CASE WHEN pages.page_type_method = 'user' THEN pages.page_type ELSE excluded.page_type END,
           page_type_method = CASE WHEN pages.page_type_method = 'user' THEN 'user' ELSE excluded.page_type_method END
         RETURNING id, page_type`,
        newId("pg"),
        project.workspaceId,
        project.id,
        url,
        cls.pageType,
        cls.method,
        iso(ctx.clock()),
        crawledAt,
      );
      return row!;
    };

    // Snapshots are buffered and written in batches. Safe: a URL is recorded at most once per crawl, and
    // previousExtraction only reads snapshots of earlier crawls.
    const pendingSnapshots: Array<[string, ...unknown[]]> = [];
    const flushSnapshots = async () => {
      if (pendingSnapshots.length > 0) await db.batch(pendingSnapshots.splice(0));
    };

    const record = async (
      url: string,
      data: {
        statusCode: number | null;
        finalUrl: string | null;
        skippedReason: SkipReason | null;
        contentHash?: string | null;
        textHash?: string | null;
        extracted?: ExtractedPage | null;
        robotsMeta?: string | null;
        fetched: boolean;
      },
    ) => {
      const x = data.extracted ?? null;
      const cls = classifyPageType({ url, jsonLdTypes: x?.jsonLdTypes, sitemapFile: sitemap.source.get(url) ?? null });
      const fetchedAt = iso(ctx.clock());
      const pageRow = await upsertPage(url, cls, data.fetched ? fetchedAt : null);
      pendingSnapshots.push(insertStatement("page_snapshots", {
        id: newId("snap"),
        workspace_id: project.workspaceId,
        project_id: project.id,
        page_id: pageRow.id,
        crawl_run_id: crawlRunId,
        status_code: data.statusCode,
        final_url: data.finalUrl,
        content_hash: data.contentHash ?? null,
        skipped_reason: data.skippedReason,
        title: x?.title ?? null,
        meta_description: x?.metaDescription ?? null,
        h1_json: JSON.stringify(x?.h1s ?? []),
        headings_json: JSON.stringify(x?.headings ?? []),
        canonical: x?.canonical ?? null,
        robots_meta: data.robotsMeta ?? null,
        jsonld_types_json: JSON.stringify(x?.jsonLdTypes ?? []),
        jsonld_issues_json: JSON.stringify(x?.jsonLdIssues ?? []),
        internal_links_json: JSON.stringify(x?.internalLinks ?? []),
        word_count: x ? x.wordCount : null,
        main_text_excerpt: x?.excerpt ?? null,
        first_paragraph: x?.firstParagraph ?? null,
        author: x?.author ?? null,
        last_updated: x?.lastUpdated ?? null,
        outbound_citations: x ? x.outboundCitations : null,
        table_count: x ? x.tableCount : null,
        images_total: x ? x.imagesTotal : null,
        images_missing_alt: x ? x.imagesMissingAlt : null,
        viewport_meta: x?.viewport ?? null,
        breadcrumb_nav: x ? (x.hasBreadcrumbNav ? 1 : 0) : null,
        generic_anchors_json: x ? JSON.stringify(x.genericAnchors) : null,
        link_context_json: JSON.stringify(x?.linkContext ?? []),
        fetched_at: fetchedAt,
      }));
      if (pendingSnapshots.length >= SNAPSHOT_BATCH) await flushSnapshots();
      if (data.skippedReason) skipCounts[data.skippedReason] = (skipCounts[data.skippedReason] ?? 0) + 1;
      else crawled++;
      snapshots.push({
        url,
        finalUrl: data.finalUrl,
        statusCode: data.statusCode,
        pageType: pageRow.page_type,
        skippedReason: data.skippedReason,
        title: x?.title ?? null,
        metaDescription: x?.metaDescription ?? null,
        h1s: x?.h1s ?? [],
        headings: x?.headings ?? [],
        canonical: x?.canonical ?? null,
        robotsMeta: data.robotsMeta ?? null,
        jsonLdTypes: x?.jsonLdTypes ?? [],
        jsonLdIssues: x?.jsonLdIssues ?? [],
        internalLinks: x?.internalLinks ?? [],
        wordCount: x ? x.wordCount : null,
        firstParagraph: x?.firstParagraph ?? null,
        contentHash: data.contentHash ?? null,
        textHash: data.textHash ?? null,
      });
    };

    /** Reuse the latest extraction when the body is byte-identical to a previous snapshot. */
    const previousExtraction = async (url: string, contentHash: string): Promise<ExtractedPage | null> => {
      const row = await db.first<Record<string, unknown>>(
        `SELECT s.* FROM page_snapshots s JOIN pages p ON p.id = s.page_id
          WHERE p.project_id = ? AND p.workspace_id = ? AND s.workspace_id = ? AND p.url = ?
            AND s.content_hash = ? AND s.skipped_reason IS NULL AND s.status_code BETWEEN 200 AND 299
          ORDER BY s.fetched_at DESC LIMIT 1`,
        project.id,
        project.workspaceId,
        project.workspaceId,
        url,
        contentHash,
      );
      // Snapshots taken before the [A21] extraction fields existed are re-extracted instead of reused.
      if (!row || row.images_total === null || row.images_total === undefined) return null;
      // [A25] Snapshots without link-context sentences (taken before they were extracted) are re-extracted
      // when the page has enough words to contain a sentence; a page with no qualifying sentence is cheap
      // to re-parse.
      const linkContext = parseJson<unknown[]>(row.link_context_json, []).filter((s): s is string => typeof s === "string");
      if (linkContext.length === 0 && Number(row.word_count ?? 0) >= LINK_CONTEXT_MIN_WORDS) return null;
      return {
        title: (row.title as string | null) ?? null,
        metaDescription: (row.meta_description as string | null) ?? null,
        // Stored robots_meta may include the X-Robots-Tag header; it is re-read from the fresh response.
        metaRobots: ((row.robots_meta as string | null) ?? "").replace(/(^|, )x-robots-tag:.*$/, "") || null,
        canonical: (row.canonical as string | null) ?? null,
        h1s: parseJson<string[]>(row.h1_json, []),
        headings: parseJson<Array<{ level: number; text: string }>>(row.headings_json, []),
        internalLinks: parseJson<string[]>(row.internal_links_json, []),
        jsonLdTypes: parseJson<string[]>(row.jsonld_types_json, []),
        jsonLdIssues: parseJson<JsonLdIssue[]>(row.jsonld_issues_json, []),
        hasProductOffer: false,
        wordCount: Number(row.word_count ?? 0),
        excerpt: (row.main_text_excerpt as string | null) ?? "",
        firstParagraph: (row.first_paragraph as string | null) ?? null,
        author: (row.author as string | null) ?? null,
        lastUpdated: (row.last_updated as string | null) ?? null,
        outboundCitations: Number(row.outbound_citations ?? 0),
        tableCount: Number(row.table_count ?? 0),
        hasAppRoot: false,
        jsRendered: false,
        imagesTotal: Number(row.images_total ?? 0),
        imagesMissingAlt: Number(row.images_missing_alt ?? 0),
        viewport: (row.viewport_meta as string | null) ?? null,
        hasBreadcrumbNav: Number(row.breadcrumb_nav ?? 0) === 1,
        genericAnchors: parseJson<Array<{ href: string; text: string }>>(row.generic_anchors_json, []),
        linkContext,
      };
    };

    let reused = 0;
    const processUrl = async (url: string) => {
      await politeness();
      let res;
      try {
        res = await guardedFetch(ctx.crawlFetch, url, {
          verifiedHost: host,
          maxBytes: opts.pageMaxBytes ?? 2 * 1024 * 1024,
          timeoutMs: opts.pageTimeoutMs ?? 12_000,
          maxRedirects: 5,
          kind: "html",
          // Large storefront pages (often over 2 MB of inline JSON/CSS) are analysed from their first 2 MB,
          // which holds the head and main content, instead of being skipped as too_large.
          truncateAtCap: true,
          userAgent: ua,
        });
      } catch (e) {
        const code: CrawlFetchErrorCode = e instanceof CrawlFetchError ? e.code : "error";
        await record(url, { statusCode: null, finalUrl: null, skippedReason: skipReasonFor(code), fetched: true });
        return;
      }
      const finalUrl = res.finalUrl;
      const redirected = res.redirects.length > 0;
      if (redirected) {
        // Record the redirect itself; analyse the target as its own URL if not already seen.
        await record(url, { statusCode: res.redirects[0]!.status, finalUrl, skippedReason: null, fetched: true });
        const key = normalizeUrlKey(finalUrl);
        if (seen.has(key) && normalizeUrlKey(url) !== key) return;
        seen.add(key);
        if (!robotsAllows(robots, CRAWLER_UA_TOKEN, finalUrl)) {
          await record(finalUrl, { statusCode: null, finalUrl: null, skippedReason: "robots_disallowed", fetched: false });
          return;
        }
      }
      const target = finalUrl;
      if (res.status < 200 || res.status >= 300) {
        await record(target, { statusCode: res.status, finalUrl: target, skippedReason: null, fetched: true });
        return;
      }
      const contentHash = await sha256Hex(res.body);
      let extracted = await previousExtraction(target, contentHash);
      if (extracted) reused++;
      else extracted = extractPage(res.body, target);
      if (extracted.tooComplex) {
        // Markup nested past the parser budget: skipped rather than analysed from partial evidence.
        await record(target, { statusCode: res.status, finalUrl: target, skippedReason: "too_complex", contentHash, fetched: true });
        return;
      }
      const headerRobots = res.headers.get("x-robots-tag");
      const robotsMeta = [extracted.metaRobots, headerRobots ? `x-robots-tag: ${headerRobots.toLowerCase()}` : null].filter(Boolean).join(", ") || null;
      const textHash = await sha256Hex(`${extracted.excerpt}|${extracted.wordCount}`);
      await record(target, {
        statusCode: res.status,
        finalUrl: target,
        skippedReason: extracted.jsRendered ? "js_rendered" : null,
        contentHash,
        textHash,
        extracted,
        robotsMeta,
        fetched: true,
      });
      for (const link of extracted.internalLinks) enqueue(link);
    };

    const nextUrl = () => primary.shift() ?? secondary.shift();
    const active = new Set<Promise<void>>();
    let limitReached = false;
    let deadlineReached = false;
    let lastCancelCheck = -CANCEL_CHECK_EVERY;
    for (;;) {
      // isCancelled is a D1 read: check every turn for small crawls, then every CANCEL_CHECK_EVERY pages.
      if (fetches < CANCEL_CHECK_EVERY || fetches - lastCancelCheck >= CANCEL_CHECK_EVERY) {
        lastCancelCheck = fetches;
        if (await ctx.isCancelled()) {
          cancelled = true;
          break;
        }
      }
      while (active.size < concurrency) {
        if (fetches >= pageLimit) {
          if (primary.length || secondary.length) limitReached = true;
          break;
        }
        if (now() >= deadline) {
          if (primary.length || secondary.length) deadlineReached = true;
          break;
        }
        const url = nextUrl();
        if (!url) break;
        if (!robotsAllows(robots, CRAWLER_UA_TOKEN, url)) {
          if (skipRecords < MAX_SKIP_RECORDS) {
            skipRecords++;
            await record(url, { statusCode: null, finalUrl: null, skippedReason: "robots_disallowed", fetched: false });
          }
          continue;
        }
        fetches++;
        const p: Promise<void> = processUrl(url)
          .catch(async (e) => {
            await record(url, { statusCode: null, finalUrl: null, skippedReason: "error", fetched: true }).catch(() => undefined);
            notes.push(`Error on ${url}: ${(e as Error).message.slice(0, 200)}`);
          })
          .finally(() => active.delete(p));
        active.add(p);
      }
      if (active.size === 0) break;
      await Promise.race(active);
    }
    await Promise.all(active);
    await flushSnapshots();
    if (cancelled) notes.push("Crawl cancelled; stopped before completing the queue.");
    if (deadlineReached) notes.push(`Crawl time budget (${Math.round((opts.deadlineMs ?? CRAWL_DEADLINE_MS) / 1000)} s) reached; stopped before completing the queue.`);
    if (reused > 0) notes.push(`${reused} page(s) unchanged since the previous crawl (same content hash); extraction reused.`);

    // ---- AI crawler access + rules
    const llms = await checkLlmsTxt(ctx.crawlFetch, host, ua);
    const aiCrawlerAccess = evaluateAiCrawlerAccess(robots, llms, `https://${host}/`);
    const findings = runRules({
      siteType: proj.site_type,
      verifiedHost: host,
      snapshots,
      sitemapUrls: sitemap.urls,
      sitemapEntries: sitemap.entries,
      sitemapRefused: sitemap.refused,
      now: ctx.clock(),
      robots,
      aiCrawlerAccess,
    });
    const createdAt = iso(ctx.clock());
    const stmts = findings.map((f) =>
      insertStatement("audit_findings", {
        id: newId("fnd"),
        workspace_id: project.workspaceId,
        project_id: project.id,
        crawl_run_id: crawlRunId,
        rule_id: f.ruleId,
        severity: f.severity,
        url: f.url,
        template: f.template,
        detail: f.detail.slice(0, 1000),
        evidence_json: JSON.stringify({ ...f.evidence, pageType: f.pageType, rulesetVersion: RULESET_VERSION }),
        created_at: createdAt,
      }),
    );
    for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));

    const skipped = Object.values(skipCounts).reduce((a, b) => a + b, 0);
    const note = completenessNote(crawled, skipCounts, pageLimit, limitReached) + (deadlineReached ? "; crawl time budget reached" : "");
    notes.unshift(note);
    const status: CrawlSummary["status"] = cancelled || deadlineReached || robots.status === "unreachable" ? "partial" : "completed";
    const robotsJson = {
      robots: {
        status: robots.status,
        httpStatus: robots.httpStatus,
        note: robots.note,
        userAgent: ua,
        matchedGroupAgents: selectGroup(robots.parsed, CRAWLER_UA_TOKEN)?.agents ?? [],
        crawlDelay: delaySec,
        sitemaps: robots.parsed.sitemaps.slice(0, 10),
      },
      // entries: [{url, lastmod|null}] for the sitemap health rules (at most SITEMAP_MAX_URLS, same order as read).
      sitemap: { fetched: sitemap.fetched, urlCount: sitemap.urls.length, refused: sitemap.refused.slice(0, 20), entries: sitemap.entries.slice(0, SITEMAP_MAX_URLS) },
      aiCrawlerAccess,
      rulesetVersion: RULESET_VERSION,
    };
    await db.run(
      "UPDATE crawl_runs SET status = ?, pages_crawled = ?, pages_skipped = ?, robots_json = ?, notes_json = ?, finished_at = ? WHERE id = ? AND workspace_id = ?",
      status,
      crawled,
      skipped,
      JSON.stringify(robotsJson),
      JSON.stringify(notes.slice(0, 50)),
      iso(ctx.clock()),
      crawlRunId,
      project.workspaceId,
    );
    await ctx.budget.settle(reservation, settleAmount(fetches));
    await ctx.log.event("crawl", status === "completed" ? "completed" : "partial", `${note}; ${findings.length} findings.`);
    return { crawlRunId, pagesCrawled: crawled, pagesSkipped: skipped, findings: findings.length, status, note };
  } catch (e) {
    // Best effort: cleanup may fail for the same reason the crawl did (e.g. the subrequest cap); the
    // original error is what gets reported.
    const msg = e instanceof Error ? e.message.slice(0, 300) : "unknown error";
    await markFailed(ctx, crawlRunId, `Crawl failed: ${msg}`).catch(() => undefined);
    // Requests may have been sent: keep what was used counted.
    await ctx.budget.settle(reservation, settleAmount(fetches)).catch(() => undefined);
    await ctx.log.event("crawl", "failed", `Crawl failed: ${msg}`).catch(() => undefined);
    return { crawlRunId, pagesCrawled: 0, pagesSkipped: 0, findings: 0, status: "failed", note: `Crawl failed: ${msg}` };
  }
}

async function markFailed(ctx: RunContext, crawlRunId: string, note: string): Promise<void> {
  await ctx.db.run(
    "UPDATE crawl_runs SET status = 'failed', notes_json = ?, finished_at = ? WHERE id = ? AND workspace_id = ?",
    JSON.stringify([note]),
    iso(ctx.clock()),
    crawlRunId,
    ctx.project.workspaceId,
  );
}
