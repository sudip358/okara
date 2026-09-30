/** Seed helpers for the checklist tests: crawl rows, GSC rows, and GEO observations inserted directly. */
import type { PageType } from "@shared/types";
import { Db } from "@worker/lib/db";
import { newId } from "@worker/lib/ids";
import type { ProjectRow } from "@worker/platform/access";
import { FIXED_NOW } from "./helpers/fixtures";

export const HOST = "shop.example.com";
export const U = (p: string) => `https://${HOST}${p}`;
const now = FIXED_NOW.toISOString();

export interface PageSeed {
  path: string;
  pageType?: PageType;
  status?: number | null;
  finalPath?: string | null;
  skipped?: string | null;
  title?: string | null;
  meta?: string | null;
  h1?: string[];
  headings?: Array<{ level: number; text: string }>;
  canonical?: string | null;
  robotsMeta?: string | null;
  jsonld?: string[];
  jsonldIssues?: Array<{ type: string; issue: string; detail?: string }>;
  links?: string[];
  words?: number | null;
  firstParagraph?: string | null;
  excerpt?: string | null;
  author?: string | null;
  lastUpdated?: string | null;
  outbound?: number | null;
  tables?: number | null;
  images?: number | null;
  imagesMissingAlt?: number | null;
  viewport?: string | null;
  breadcrumbNav?: boolean | null;
  genericAnchors?: Array<{ href: string; text: string }> | null;
}

export const SITE_ROBOTS = (over: { crawlers?: unknown[]; sitemaps?: string[]; fetched?: string[]; urlCount?: number; status?: string } = {}) => ({
  robots: { status: over.status ?? "ok", httpStatus: 200, note: "robots.txt fetched", userAgent: "OkaraBot/0.1", matchedGroupAgents: ["*"], crawlDelay: null, sitemaps: over.sitemaps ?? [U("/sitemap.xml")] },
  sitemap: { fetched: over.fetched ?? [U("/sitemap.xml")], urlCount: over.urlCount ?? 12, refused: [] },
  aiCrawlerAccess: {
    llmsTxt: { present: false, notes: [] },
    crawlers: over.crawlers ?? [
      crawler("Googlebot", "search_engine", true),
      crawler("Bingbot", "search_engine", true),
      crawler("OAI-SearchBot", "answer_search", true),
      crawler("Claude-SearchBot", "answer_search", true),
      crawler("PerplexityBot", "answer_search", true),
      crawler("ChatGPT-User", "user_fetch", true),
      crawler("GPTBot", "training", true),
    ],
    advisory: [],
  },
  rulesetVersion: "test",
});

export function crawler(token: string, purpose: string, allowed: boolean | null) {
  return { token, vendor: "Vendor", purpose, allowed, sourceUrl: `https://vendor.example/docs/${token}` };
}

function defaultsFor(p: PageSeed): Required<Omit<PageSeed, "path">> {
  const type = p.pageType ?? "other";
  const jsonld = type === "product" ? ["Product", "BreadcrumbList"] : type === "article" ? ["BlogPosting", "BreadcrumbList"] : type === "home" ? ["Organization", "WebSite"] : type === "collection" ? ["CollectionPage", "BreadcrumbList"] : ["BreadcrumbList"];
  return {
    pageType: type,
    status: 200,
    finalPath: null,
    skipped: null,
    title: `Solid brass cabinet hardware made to order - page ${p.path}`.slice(0, 58), // 51-58 chars
    meta: `Unique description for ${p.path} that explains what the page offers to readers.`,
    h1: [`Heading ${p.path}`],
    headings: [
      { level: 1, text: `Heading ${p.path}` },
      { level: 2, text: "How do you install a brass pull?" },
      { level: 2, text: "Finishes" },
    ],
    canonical: U(p.path),
    robotsMeta: null,
    jsonld,
    jsonldIssues: [],
    links: [],
    words: 600,
    firstParagraph: "Solid brass cabinet pulls made to order for kitchens and bathrooms.",
    excerpt: "Solid brass cabinet pulls made to order for kitchens and bathrooms. Finishes include unlacquered brass.",
    author: type === "article" ? "Jane Maker" : null,
    lastUpdated: type === "article" ? "2026-08-01T00:00:00Z" : null,
    outbound: type === "article" ? 3 : 0,
    tables: 0,
    images: 2,
    imagesMissingAlt: 0,
    viewport: "width=device-width, initial-scale=1",
    breadcrumbNav: type !== "home",
    genericAnchors: [],
  };
}

export async function projectRow(db: Db, projectId: string): Promise<ProjectRow> {
  return (await db.first<ProjectRow>("SELECT * FROM projects WHERE id = ?", projectId))!;
}

export async function seedCrawl(
  db: Db,
  ws: string,
  pid: string,
  opts: { pages: PageSeed[]; findings?: Array<{ ruleId: string; path: string | null; detail?: string }>; robots?: unknown; notes?: string[]; startedAt?: string },
): Promise<{ crawlId: string; pageIds: Record<string, string> }> {
  const crawlId = newId("crw");
  await db.insert("crawl_runs", {
    id: crawlId,
    workspace_id: ws,
    project_id: pid,
    status: "completed",
    pages_limit: 20,
    pages_crawled: opts.pages.filter((p) => !p.skipped).length,
    pages_skipped: opts.pages.filter((p) => p.skipped).length,
    robots_json: JSON.stringify(opts.robots ?? SITE_ROBOTS()),
    notes_json: JSON.stringify(opts.notes ?? []),
    started_at: opts.startedAt ?? now,
    finished_at: opts.startedAt ?? now,
  });
  const pageIds: Record<string, string> = {};
  let i = 0;
  for (const seed of opts.pages) {
    const p = { ...defaultsFor(seed), ...seed };
    const existing = await db.first<{ id: string }>("SELECT id FROM pages WHERE project_id = ? AND url = ?", pid, U(seed.path));
    const pageId = existing?.id ?? newId("pg");
    if (!existing) {
      await db.insert("pages", { id: pageId, workspace_id: ws, project_id: pid, url: U(seed.path), page_type: p.pageType, page_type_method: "url_pattern", first_seen_at: now, last_crawled_at: now });
    }
    pageIds[seed.path] = pageId;
    const fetched = new Date(new Date(opts.startedAt ?? now).getTime() + i++ * 1000).toISOString();
    await db.insert("page_snapshots", {
      id: newId("snap"),
      workspace_id: ws,
      project_id: pid,
      page_id: pageId,
      crawl_run_id: crawlId,
      status_code: p.status,
      final_url: p.finalPath ? U(p.finalPath) : p.status === null ? null : U(seed.path),
      skipped_reason: p.skipped,
      title: p.title,
      meta_description: p.meta,
      h1_json: JSON.stringify(p.h1),
      headings_json: JSON.stringify(p.headings),
      canonical: p.canonical,
      robots_meta: p.robotsMeta,
      jsonld_types_json: JSON.stringify(p.jsonld),
      jsonld_issues_json: JSON.stringify(p.jsonldIssues),
      internal_links_json: JSON.stringify(p.links.map((l) => (l.startsWith("http") ? l : U(l)))),
      word_count: p.words,
      main_text_excerpt: p.excerpt,
      first_paragraph: p.firstParagraph,
      author: p.author,
      last_updated: p.lastUpdated,
      outbound_citations: p.outbound,
      table_count: p.tables,
      images_total: p.images,
      images_missing_alt: p.imagesMissingAlt,
      viewport_meta: p.viewport,
      breadcrumb_nav: p.breadcrumbNav === null ? null : p.breadcrumbNav ? 1 : 0,
      generic_anchors_json: p.genericAnchors === null ? null : JSON.stringify(p.genericAnchors),
      fetched_at: fetched,
    });
  }
  for (const f of opts.findings ?? []) {
    await db.insert("audit_findings", {
      id: newId("fnd"),
      workspace_id: ws,
      project_id: pid,
      crawl_run_id: crawlId,
      rule_id: f.ruleId,
      severity: "moderate",
      url: f.path === null ? null : U(f.path),
      template: null,
      detail: f.detail ?? `${f.ruleId} on ${f.path}`,
      created_at: now,
    });
  }
  return { crawlId, pageIds };
}

/** rows: [query, path, window, clicks, impressions, position] */
export async function seedGsc(db: Db, ws: string, pid: string, rows: Array<[string | null, string | null, "current" | "previous", number, number, number]>, source: "api" | "csv_import" = "api") {
  const syncId = newId("gsc");
  await db.insert("gsc_syncs", {
    id: syncId,
    workspace_id: ws,
    project_id: pid,
    source,
    property: "sc-domain:example.com",
    window_start: "2026-08-30",
    window_end: "2026-09-26",
    prev_window_start: "2026-08-02",
    prev_window_end: "2026-08-29",
    rows_fetched: rows.length,
    row_cap: 5000,
    truncated: 0,
    status: "completed",
    synced_at: now,
  });
  for (const [query, path, window, clicks, impressions, position] of rows) {
    await db.insert("gsc_metrics", {
      workspace_id: ws,
      project_id: pid,
      sync_id: syncId,
      window,
      query,
      page: path === null ? null : U(path),
      device: null,
      clicks,
      impressions,
      ctr: impressions ? clicks / impressions : 0,
      position,
    });
  }
  return syncId;
}

export interface ObsSeed {
  provider?: string;
  status?: "ok" | "failed";
  measurement?: "api" | "manual_import";
  citations?: Array<{ url: string; sourceType: string; brandKey?: string | null; title?: string }>;
  selfMentioned?: boolean;
  selfCited?: boolean;
  competitor?: { name: string; mentioned: boolean; cited: boolean };
  displacement?: { entity: string; url: string; sourceType: string };
  searchQueries?: string[];
}

export async function seedGeo(db: Db, ws: string, pid: string, opts: { approvedPrompts?: number; totalPrompts?: number; observations?: ObsSeed[] }) {
  const setId = newId("gps");
  await db.insert("geo_prompt_sets", { id: setId, workspace_id: ws, project_id: pid, version: 1, active: 1, created_at: now });
  const total = opts.totalPrompts ?? opts.approvedPrompts ?? 0;
  for (let i = 0; i < total; i++) {
    await db.insert("geo_prompts", {
      id: newId("gp"),
      workspace_id: ws,
      project_id: pid,
      prompt_set_id: setId,
      text: `Prompt ${i}`,
      prompt_type: "discovery",
      locale: "en-US",
      language: "en",
      approved: i < (opts.approvedPrompts ?? 0) ? 1 : 0,
      position: i,
    });
  }
  let k = 0;
  for (const o of opts.observations ?? []) {
    const obsId = newId("obs");
    await db.insert("geo_observations", {
      id: obsId,
      workspace_id: ws,
      project_id: pid,
      prompt_text: "Prompt",
      prompt_type: "discovery",
      cohort_key: "cohort",
      provider: o.provider ?? "gemini",
      model: "test-model",
      grounding_mode: "google_search",
      measurement_type: o.measurement ?? "api",
      status: o.status ?? "ok",
      grounded: (o.citations ?? []).length > 0 ? 1 : 0,
      raw_answer: "answer",
      created_at: new Date(FIXED_NOW.getTime() - k++ * 60_000).toISOString(),
    });
    for (const [i, c] of (o.citations ?? []).entries()) {
      await db.insert("geo_citations", {
        id: newId("cit"),
        workspace_id: ws,
        project_id: pid,
        observation_id: obsId,
        url: c.url,
        host: new URL(c.url).hostname,
        title: c.title ?? null,
        position: i + 1,
        brand_key: c.brandKey ?? null,
        source_type: c.sourceType,
        source_type_method: "rule",
      });
    }
    await db.insert("geo_brand_observations", {
      id: newId("gbo"),
      workspace_id: ws,
      project_id: pid,
      observation_id: obsId,
      brand_key: "self",
      is_self: 1,
      mentioned: o.selfMentioned ? 1 : 0,
      cited: o.selfCited ? 1 : 0,
      recommendation_status: o.selfMentioned ? "recommended" : "not_mentioned",
      sentiment: o.selfMentioned ? "positive" : "not_applicable",
      method: "deterministic",
    });
    if (o.competitor) {
      await db.insert("geo_brand_observations", {
        id: newId("gbo"),
        workspace_id: ws,
        project_id: pid,
        observation_id: obsId,
        brand_key: o.competitor.name,
        is_self: 0,
        mentioned: o.competitor.mentioned ? 1 : 0,
        cited: o.competitor.cited ? 1 : 0,
        recommendation_status: o.competitor.mentioned ? "recommended" : "not_mentioned",
        sentiment: o.competitor.mentioned ? "positive" : "not_applicable",
        method: "deterministic",
      });
    }
    if (o.displacement) {
      await db.insert("geo_displacements", { id: newId("gdp"), workspace_id: ws, project_id: pid, observation_id: obsId, entity: o.displacement.entity, url: o.displacement.url, source_type: o.displacement.sourceType, span: null, created_at: now });
    }
    for (const q of o.searchQueries ?? []) {
      await db.insert("geo_search_queries", { id: newId("gsq"), workspace_id: ws, project_id: pid, observation_id: obsId, provider: o.provider ?? "gemini", model: "test-model", query: q, normalized: q.toLowerCase(), created_at: now });
    }
  }
  return setId;
}
