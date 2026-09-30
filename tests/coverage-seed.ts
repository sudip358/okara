/** Seed helpers for the [A22] coverage tests: rows inserted directly with db.insert (no network). */
import { Hono } from "hono";
import type { PageType, Severity, SourceType } from "@shared/types";
import type { AppEnv } from "@worker/app";
import type { Env } from "@worker/env";
import { Db } from "@worker/lib/db";
import { HttpError } from "@worker/lib/errors";
import { newId } from "@worker/lib/ids";
import type { ProjectRow } from "@worker/platform/access";
import { coverageRoutes } from "@worker/routes/coverage";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";

export const HOST = "shop.example.com";
export const U = (p: string) => `https://${HOST}${p}`;
const NOW = FIXED_NOW.toISOString();
export const hoursAgo = (h: number) => new Date(FIXED_NOW.getTime() - h * 3600_000).toISOString();

/** A title inside the 30-60 character guideline. */
export const GOOD_TITLE = "Solid brass cabinet hardware made to order";

export interface PageSeed {
  path: string;
  pageType?: PageType;
  status?: number | null;
  finalPath?: string | null;
  skipped?: string | null;
  title?: string | null;
  h1?: string[];
  headings?: Array<{ level: number; text: string }>;
  jsonld?: string[];
  jsonldIssues?: Array<{ type: string; issue: string; detail?: string }>;
  words?: number | null;
  outbound?: number | null;
  tables?: number | null;
  lastUpdated?: string | null;
}

export interface FindingSeed {
  ruleId: string;
  severity: Severity;
  path: string | null;
  detail?: string;
}

/** Minimal app: coverage routes with a fixed signed-in user. */
export function makeApp(env: Env, userId: string) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", new Db(c.env.DB));
    c.set("now", FIXED_NOW);
    c.set("user", { id: userId, email: "u@example.com", name: null });
    c.set("session", null);
    await next();
  });
  app.route("/", coverageRoutes);
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    throw err;
  });
  return async (path: string) => {
    const res = await app.request(path, { method: "GET" }, env);
    return { status: res.status, json: (await res.json()) as any };
  };
}

export async function setup(projectOverrides: Record<string, unknown> = {}, envOverrides: Partial<Env> = {}) {
  const env = createTestEnv(envOverrides);
  const user = await seedUser(env);
  const projectId = await seedProject(env, user.workspaceId, projectOverrides);
  const other = await seedUser(env, { email: "other@example.com", workspaceName: "Other workspace" });
  const db = new Db(env.DB);
  return { env, db, ws: user.workspaceId, pid: projectId, user, call: makeApp(env, user.userId), callOther: makeApp(env, other.userId) };
}
export type Setup = Awaited<ReturnType<typeof setup>>;

export async function projectRow(db: Db, projectId: string): Promise<ProjectRow> {
  return (await db.first<ProjectRow>("SELECT * FROM projects WHERE id = ?", projectId))!;
}

export async function seedCrawl(
  s: Pick<Setup, "db" | "ws" | "pid">,
  pages: PageSeed[],
  findings: FindingSeed[] = [],
  opts: { status?: "completed" | "partial" | "running" | "failed"; startedAt?: string } = {},
): Promise<{ crawlId: string; pageIds: Record<string, string> }> {
  const crawlId = newId("crw");
  const startedAt = opts.startedAt ?? hoursAgo(2);
  await s.db.insert("crawl_runs", {
    id: crawlId,
    workspace_id: s.ws,
    project_id: s.pid,
    status: opts.status ?? "completed",
    pages_limit: 20,
    pages_crawled: pages.filter((p) => !p.skipped).length,
    pages_skipped: pages.filter((p) => p.skipped).length,
    notes_json: "[]",
    started_at: startedAt,
    finished_at: startedAt,
  });
  const pageIds: Record<string, string> = {};
  for (const p of pages) {
    const existing = await s.db.first<{ id: string }>("SELECT id FROM pages WHERE project_id = ? AND url = ?", s.pid, U(p.path));
    const pageId = existing?.id ?? newId("pg");
    if (!existing) {
      await s.db.insert("pages", {
        id: pageId,
        workspace_id: s.ws,
        project_id: s.pid,
        url: U(p.path),
        page_type: p.pageType ?? "other",
        page_type_method: "url_pattern",
        first_seen_at: NOW,
        last_crawled_at: NOW,
      });
    }
    pageIds[p.path] = pageId;
    const skipped = p.skipped ?? null;
    const status = p.status === undefined ? (skipped ? null : 200) : p.status;
    await s.db.insert("page_snapshots", {
      id: newId("snap"),
      workspace_id: s.ws,
      project_id: s.pid,
      page_id: pageId,
      crawl_run_id: crawlId,
      status_code: status,
      final_url: p.finalPath ? U(p.finalPath) : status === null ? null : U(p.path),
      skipped_reason: skipped,
      title: p.title === undefined ? GOOD_TITLE : p.title,
      h1_json: JSON.stringify(p.h1 ?? [`Heading for ${p.path}`]),
      headings_json: JSON.stringify(p.headings ?? [{ level: 1, text: (p.h1 ?? [`Heading for ${p.path}`])[0] ?? "" }, { level: 2, text: "Details" }]),
      canonical: U(p.path),
      jsonld_types_json: JSON.stringify(p.jsonld ?? ["BreadcrumbList"]),
      jsonld_issues_json: JSON.stringify(p.jsonldIssues ?? []),
      internal_links_json: "[]",
      word_count: p.words === undefined ? 600 : p.words,
      outbound_citations: p.outbound === undefined ? 2 : p.outbound,
      table_count: p.tables === undefined ? 0 : p.tables,
      last_updated: p.lastUpdated === undefined ? "2026-09-01T00:00:00Z" : p.lastUpdated,
      fetched_at: startedAt,
    });
  }
  for (const f of findings) {
    await s.db.insert("audit_findings", {
      id: newId("fnd"),
      workspace_id: s.ws,
      project_id: s.pid,
      crawl_run_id: crawlId,
      rule_id: f.ruleId,
      severity: f.severity,
      url: f.path === null ? null : U(f.path),
      template: null,
      detail: f.detail ?? `${f.ruleId} on ${f.path}`,
      created_at: NOW,
    });
  }
  return { crawlId, pageIds };
}

/** rows: query x page (current window, device NULL). pageRows: page-dimension rows (query NULL). */
export async function seedGsc(
  s: Pick<Setup, "db" | "ws" | "pid">,
  opts: {
    rows?: Array<{ query: string; path: string; clicks: number; impressions: number; position?: number }>;
    pageRows?: Array<{ path: string; clicks: number; impressions: number }>;
    totals?: { clicks: number; impressions: number } | null;
  },
): Promise<string> {
  const syncId = newId("gsc");
  const totals = opts.totals === undefined ? { clicks: 1000, impressions: 100000 } : opts.totals;
  await s.db.insert("gsc_syncs", {
    id: syncId,
    workspace_id: s.ws,
    project_id: s.pid,
    source: "api",
    property: "sc-domain:example.com",
    window_start: "2026-08-30",
    window_end: "2026-09-26",
    prev_window_start: "2026-08-02",
    prev_window_end: "2026-08-29",
    rows_fetched: (opts.rows?.length ?? 0) + (opts.pageRows?.length ?? 0),
    row_cap: 5000,
    truncated: 0,
    totals_json: JSON.stringify(totals ? { current: { ...totals, ctr: totals.clicks / totals.impressions, position: 12 }, previous: null } : {}),
    status: "completed",
    synced_at: hoursAgo(3),
  });
  for (const r of opts.rows ?? []) {
    await s.db.insert("gsc_metrics", {
      workspace_id: s.ws,
      project_id: s.pid,
      sync_id: syncId,
      window: "current",
      query: r.query,
      page: U(r.path),
      device: null,
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.impressions ? r.clicks / r.impressions : 0,
      position: r.position ?? 8,
    });
  }
  for (const r of opts.pageRows ?? []) {
    await s.db.insert("gsc_metrics", {
      workspace_id: s.ws,
      project_id: s.pid,
      sync_id: syncId,
      window: "current",
      query: null,
      page: U(r.path),
      device: null,
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.impressions ? r.clicks / r.impressions : 0,
      position: 8,
    });
  }
  return syncId;
}

export async function seedPromptSet(
  s: Pick<Setup, "db" | "ws" | "pid">,
  prompts: Array<{ text: string; approved?: boolean; promptType?: "discovery" | "reputation" }>,
): Promise<{ setId: string; ids: string[] }> {
  const setId = newId("gps");
  await s.db.insert("geo_prompt_sets", { id: setId, workspace_id: s.ws, project_id: s.pid, version: 1, active: 1, created_at: hoursAgo(100) });
  const ids: string[] = [];
  for (const [i, p] of prompts.entries()) {
    const id = newId("gp");
    ids.push(id);
    await s.db.insert("geo_prompts", {
      id,
      workspace_id: s.ws,
      project_id: s.pid,
      prompt_set_id: setId,
      text: p.text,
      prompt_type: p.promptType ?? "discovery",
      stage: null,
      locale: "en-US",
      language: "en",
      approved: p.approved === false ? 0 : 1,
      position: i,
    });
  }
  return { setId, ids };
}

export interface ObsSeed {
  promptId: string | null;
  promptText: string;
  provider?: string;
  cohort?: string;
  status?: "ok" | "failed" | "incomplete";
  grounded?: boolean;
  measurement?: "api" | "manual_import";
  createdAt?: string;
  citations?: Array<{ url: string; title?: string | null; sourceType?: SourceType }>;
  queries?: string[];
}

export async function seedObservation(s: Pick<Setup, "db" | "ws" | "pid">, o: ObsSeed): Promise<string> {
  const id = newId("obs");
  const provider = o.provider ?? "gemini";
  const createdAt = o.createdAt ?? hoursAgo(1);
  await s.db.insert("geo_observations", {
    id,
    workspace_id: s.ws,
    project_id: s.pid,
    prompt_id: o.promptId,
    prompt_text: o.promptText,
    prompt_type: "discovery",
    cohort_key: o.cohort ?? `${provider}-c2`,
    provider: o.measurement === "manual_import" ? "manual" : provider,
    model: `${provider}-test-model`,
    grounding_mode: o.grounded === false ? "none" : "google_search",
    measurement_type: o.measurement ?? "api",
    imported_surface: o.measurement === "manual_import" ? "ChatGPT app (manual)" : null,
    status: o.status ?? "ok",
    grounded: o.grounded === false || (o.status ?? "ok") !== "ok" ? 0 : 1,
    raw_answer: (o.status ?? "ok") === "ok" ? "Answer text (test fixture)." : null,
    usage_json: "{}",
    cost_usd: null,
    cost_is_estimate: 1,
    created_at: createdAt,
  });
  for (const [i, c] of (o.citations ?? []).entries()) {
    let host = "";
    try {
      host = new URL(c.url).hostname;
    } catch {
      host = "";
    }
    await s.db.insert("geo_citations", {
      id: newId("cit"),
      workspace_id: s.ws,
      project_id: s.pid,
      observation_id: id,
      url: c.url,
      host,
      title: c.title ?? null,
      position: i + 1,
      brand_key: null,
      source_type: c.sourceType ?? "other",
      source_type_method: "rule",
    });
  }
  for (const q of o.queries ?? []) {
    await s.db.insert("geo_search_queries", {
      id: newId("gsq"),
      workspace_id: s.ws,
      project_id: s.pid,
      observation_id: id,
      provider,
      model: `${provider}-test-model`,
      query: q,
      normalized: q.toLowerCase(),
      created_at: createdAt,
    });
  }
  return id;
}
