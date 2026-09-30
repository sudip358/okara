/**
 * seo-crawl routes: SEO audit (latest crawl), crawled pages, and page-type corrections.
 *   GET   /projects/:pid/seo/audit        -> SeoAudit
 *   GET   /projects/:pid/pages            -> PageRow[]
 *   PATCH /projects/:pid/pages/:pageId    -> PageRow   body {pageType}
 * Every query is scoped by the workspace resolved through requireProject().
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AiCrawlerAccess, AuditFinding, CapabilityState, PageRow, SeoAudit, Severity } from "@shared/types";
import type { AppEnv } from "../app";
import { requireUser } from "../platform/require-user";
import { requireProject } from "../platform/access";
import { badRequest, notFound } from "../lib/errors";
import { parseJson } from "../lib/db";
import { getRule } from "../seo/rules/registry";
import { completenessNote } from "../seo/crawl/run";

export const seoCrawlRoutes = new Hono<AppEnv>();

export const AUDIT_LIMITATIONS = [
  "No Core Web Vitals, JS rendering, or index-status data source connected.",
  "Only server-delivered HTML is analysed; content rendered by JavaScript is not seen (such pages are skipped as js_rendered).",
  "Sitemap presence is not proof of indexing.",
  "Broken-link checks cover only URLs fetched in this crawl.",
  "Structured-data checks report eligibility requirements only; rich results are never guaranteed.",
];

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, major: 1, moderate: 2, minor: 3, advisory: 4 };

const PAGE_TYPES = ["home", "collection", "product", "article", "landing", "other"] as const;
const patchPageSchema = z.object({ pageType: z.enum(PAGE_TYPES) }).strict();

interface PageJoinRow {
  id: string;
  url: string;
  page_type: PageRow["pageType"];
  page_type_method: string;
  last_crawled_at: string | null;
  status_code: number | null;
  title: string | null;
  word_count: number | null;
  skipped_reason: string | null;
}

const toPageRow = (r: PageJoinRow): PageRow => ({
  id: r.id,
  url: r.url,
  pageType: r.page_type,
  pageTypeMethod: r.page_type_method,
  lastCrawledAt: r.last_crawled_at,
  statusCode: r.status_code,
  title: r.title,
  wordCount: r.word_count,
  skippedReason: r.skipped_reason,
});

const PAGE_SELECT = `
  SELECT p.id, p.url, p.page_type, p.page_type_method, p.last_crawled_at,
         s.status_code, s.title, s.word_count, s.skipped_reason
    FROM pages p
    LEFT JOIN page_snapshots s ON s.id = (
      SELECT s2.id FROM page_snapshots s2
       WHERE s2.page_id = p.id AND s2.workspace_id = p.workspace_id
       ORDER BY s2.fetched_at DESC, s2.rowid DESC LIMIT 1)
   WHERE p.workspace_id = ? AND p.project_id = ?`;

seoCrawlRoutes.get("/projects/:pid/seo/audit", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  const ws = project.workspace_id;

  const empty = (state: CapabilityState, note: string): SeoAudit => ({
    state,
    crawlRunId: null,
    crawledAt: null,
    completeness: { note, covered: null, total: null },
    skipped: [],
    findings: [],
    aiCrawlerAccess: null,
    limitations: AUDIT_LIMITATIONS,
  });

  // Demo projects are deliberately unverified but carry seeded crawl data: show it, labelled 'demo'.
  if (!project.verified_host && !project.is_demo) {
    return c.json({ data: empty("setup_required", "Verify site ownership (GSC, DNS, or file) before crawling. No audit findings are produced for unverified sites.") });
  }

  const run = await db.first<{
    id: string;
    status: string;
    pages_limit: number;
    pages_crawled: number;
    pages_skipped: number;
    robots_json: string | null;
    notes_json: string;
    started_at: string;
    finished_at: string | null;
  }>(
    `SELECT id, status, pages_limit, pages_crawled, pages_skipped, robots_json, notes_json, started_at, finished_at
       FROM crawl_runs WHERE workspace_id = ? AND project_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    ws,
    project.id,
  );
  const baseState: CapabilityState = project.is_demo ? "demo" : "ready";
  if (!run) return c.json({ data: empty(baseState, "No crawl has run yet.") });

  const skippedRows = await db.all<{ url: string; skipped_reason: string }>(
    `SELECT p.url, s.skipped_reason FROM page_snapshots s JOIN pages p ON p.id = s.page_id
      WHERE s.workspace_id = ? AND s.project_id = ? AND s.crawl_run_id = ? AND s.skipped_reason IS NOT NULL
      ORDER BY s.fetched_at, s.rowid`,
    ws,
    project.id,
    run.id,
  );
  const byReason: Record<string, number> = {};
  for (const r of skippedRows) byReason[r.skipped_reason] = (byReason[r.skipped_reason] ?? 0) + 1;

  const findingRows = await db.all<{ id: string; rule_id: string; severity: Severity; url: string | null; template: string | null; detail: string }>(
    `SELECT id, rule_id, severity, url, template, detail FROM audit_findings
      WHERE workspace_id = ? AND project_id = ? AND crawl_run_id = ?`,
    ws,
    project.id,
    run.id,
  );
  const findings: AuditFinding[] = findingRows
    .map((f) => {
      const rule = getRule(f.rule_id);
      return {
        id: f.id,
        ruleId: f.rule_id,
        ruleName: rule?.name ?? f.rule_id,
        area: rule?.area ?? "unknown",
        class: rule?.class ?? "heuristic",
        severity: f.severity,
        url: f.url,
        template: f.template,
        detail: f.detail,
        applicability: rule?.applicability ?? "Rule no longer registered; shown from a previous ruleset version.",
      };
    })
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.ruleId.localeCompare(b.ruleId) || (a.url ?? "").localeCompare(b.url ?? ""));

  const robots = parseJson<{ aiCrawlerAccess?: AiCrawlerAccess } | null>(run.robots_json, null);
  const runNotes = parseJson<string[]>(run.notes_json, []);
  const running = run.status === "running";
  const note = running
    ? "Crawl in progress."
    : completenessNote(run.pages_crawled, byReason, run.pages_limit, false) +
      (run.pages_skipped > skippedRows.length ? `; ${run.pages_skipped - skippedRows.length} skip records not shown` : "");

  const audit: SeoAudit = {
    state: run.status === "failed" ? "error" : baseState,
    crawlRunId: run.id,
    crawledAt: run.finished_at ?? run.started_at,
    completeness: { note, covered: run.pages_crawled, total: run.pages_crawled + run.pages_skipped },
    skipped: skippedRows.map((r) => ({ url: r.url, reason: r.skipped_reason })),
    findings,
    aiCrawlerAccess: robots?.aiCrawlerAccess ?? null,
    limitations: [...AUDIT_LIMITATIONS, ...runNotes.slice(run.status === "failed" ? 0 : 1, 20)],
  };
  return c.json({ data: audit });
});

seoCrawlRoutes.get("/projects/:pid/pages", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  const rows = await db.all<PageJoinRow>(`${PAGE_SELECT} ORDER BY p.url LIMIT 2000`, project.workspace_id, project.id);
  return c.json({ data: rows.map(toPageRow) });
});

seoCrawlRoutes.patch("/projects/:pid/pages/:pageId", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("Body must be JSON.");
  }
  const parsed = patchPageSchema.safeParse(body);
  if (!parsed.success) throw badRequest("Invalid page type.", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const { changes } = await db.run(
    "UPDATE pages SET page_type = ?, page_type_method = 'user' WHERE id = ? AND project_id = ? AND workspace_id = ?",
    parsed.data.pageType,
    c.req.param("pageId"),
    project.id,
    project.workspace_id,
  );
  if (changes === 0) throw notFound("Page");
  const row = await db.first<PageJoinRow>(`${PAGE_SELECT} AND p.id = ?`, project.workspace_id, project.id, c.req.param("pageId"));
  return c.json({ data: toPageRow(row!) });
});
