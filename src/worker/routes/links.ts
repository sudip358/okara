/**
 * Internal link suggester [A25] and the internal-links workbench (2026-10-03). OWNED BY: internal-links module.
 *   POST  /projects/:pid/seo/internal-links/run              -> LinkSuggestionReport (user-triggered run; graph + Jev + drafts)
 *   GET   /projects/:pid/seo/internal-links                  -> latest LinkSuggestionReport (with the graph summary)
 *   PATCH /projects/:pid/seo/internal-links/:id              body {userStatus} -> LinkSuggestion
 *   POST  /projects/:pid/seo/internal-links/bulk             body {ids[], userStatus} -> {updated, missing, suggestions}
 *   GET   /projects/:pid/seo/internal-links/export?format=csv|json|sheet&ids=&userStatus=&status=&placement=
 *   GET   /projects/:pid/seo/internal-links/graph            -> LinkGraphSummary
 *   POST  /projects/:pid/seo/internal-links/graph/rebuild    -> LinkGraphSummary (deterministic, no paid call; rate-limited)
 *   GET   /projects/:pid/seo/internal-links/graph/urls?filter=&sort=&dir=&q=&offset=&limit= -> LinkGraphUrlPage
 *   GET   /projects/:pid/seo/internal-links/graph/url?url=   -> LinkGraphUrlDetail
 *   GET   /projects/:pid/seo/internal-links/graph/export     -> per-URL CSV (UTF-8 with BOM)
 *   GET   /projects/:pid/seo/internal-links/clusters         -> LinkClusterReport
 *   PUT   /projects/:pid/seo/internal-links/clusters/hub     body {url, hub: true|false|null} (mark / unmark / clear)
 *   PUT   /projects/:pid/seo/internal-links/clusters/assign  body {spokeUrl, hubUrl: string|null} or {spokeUrl, reset: true}
 *   GET   /projects/:pid/seo/internal-links/broken[?format=csv] -> BrokenLinksReport | CSV
 *   GET   /projects/:pid/seo/internal-links/anchors[?all=1]  -> AnchorAuditReport
 *   GET   /projects/:pid/seo/internal-links/placed           -> PlacedLinksReport
 *
 * - Tenancy: requireUser + requireProject (404 for non-members); every query filters by workspace_id.
 * - Run: setup_required (unverified host or no crawl) returns the report without using the rate limit;
 *   otherwise LINK_RUN_RATE_LIMIT per project, then the run. Jev is used when TypeSafe is configured
 *   for the workspace (calls recorded in provider_calls and reserved against the project's daily
 *   provider_calls/jev_calls budget); the workspace writer drafts sentences (provider_calls + writer_tokens);
 *   demo projects call neither.
 * - Writes (status, bulk, cluster overrides, rebuild) pass the global CSRF middleware; URLs in cluster edits must be
 *   on the project's verified host.
 * - Okara never edits pages: everything returned is a suggestion for the user to apply.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { LinkClusterReport, LinkGraphFilter, LinkGraphSort, LinkGraphSummary, LinkSuggestionReport } from "@shared/types";
import type { AppEnv } from "../app";
import type { Env } from "../env";
import type { Db } from "../lib/db";
import { badRequest } from "../lib/errors";
import { requireProject, type ProjectRow } from "../platform/access";
import { hitRateLimit } from "../platform/rate-limit";
import { requireUser } from "../platform/require-user";
import type { DecisionProvider, WritingProvider } from "../providers/types";
import { buildDecisionsForWorkspace } from "../redirects/decisions";
import { buildWriterForWorkspace } from "../runs/runtime";
import { normalizeHost } from "../seo/ssrf";
import {
  emptyReport,
  exportLinks,
  getLinkReport,
  linkSetup,
  MAX_BULK_IDS,
  placedLinksReport,
  updateLinkUserStatus,
  updateLinkUserStatusBulk,
  USER_STATUSES,
  type ExportFilter,
  type LinkUserStatus,
} from "../links/report";
import { anchorReport, brokenLinks, brokenLinksCsv, clusterReport, GRAPH_FILTERS, GRAPH_SORTS, graphCsv, graphSummary, graphUrlDetail, graphUrls } from "../links/graph-read";
import { buildAndStoreLinkGraph, graphHost, setHubOverride, setSpokeAssignment } from "../links/graph-store";
import { runLinkSuggestions } from "../links/run";

export const linkRoutes = new Hono<AppEnv>();

export const LINK_RUN_RATE_LIMIT = { limit: 3, windowSeconds: 60 * 60 } as const;
export const GRAPH_REBUILD_RATE_LIMIT = { limit: 6, windowSeconds: 60 * 60 } as const;
export const CLUSTER_EDIT_RATE_LIMIT = { limit: 120, windowSeconds: 60 * 60 } as const;

type DecisionsFactory = (env: Env, db: Db, workspaceId: string, projectId: string) => Promise<DecisionProvider | null>;
const defaultFactory: DecisionsFactory = (env, db, workspaceId, projectId) => buildDecisionsForWorkspace(env, db, workspaceId, projectId);
let decisionsFactory: DecisionsFactory = defaultFactory;

type WriterFactory = (env: Env, db: Db, workspaceId: string, projectId: string) => Promise<WritingProvider | null>;
const defaultWriterFactory: WriterFactory = (env, db, workspaceId, projectId) => buildWriterForWorkspace(env, db, workspaceId, { projectId });
let writerFactory: WriterFactory = defaultWriterFactory;

/** Test hook: inject the DecisionProvider factory. Pass null to restore the real one. */
export function setLinkDecisionsFactory(f: DecisionsFactory | null): void {
  decisionsFactory = f ?? defaultFactory;
}

/** Test hook: inject the writer factory (drafted sentences). Pass null to restore the real one. */
export function setLinkWriterFactory(f: WriterFactory | null): void {
  writerFactory = f ?? defaultWriterFactory;
}

const statusEnum = z.enum(["open", "accepted", "dismissed", "implemented"]);
const patchSchema = z.object({ userStatus: statusEnum }).strict();
const bulkSchema = z.object({ ids: z.array(z.string().min(1).max(80)).min(1).max(MAX_BULK_IDS), userStatus: statusEnum }).strict();
const urlField = z.string().min(8).max(2048);
const hubSchema = z.object({ url: urlField, hub: z.boolean().nullable() }).strict();
const assignSchema = z.union([z.object({ spokeUrl: urlField, hubUrl: urlField.nullable() }).strict(), z.object({ spokeUrl: urlField, reset: z.literal(true) }).strict()]);

async function body(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw badRequest("Request body must be JSON.");
  }
}

/** A URL on the project's verified host (http/https), or a 400. */
export function ownUrl(project: ProjectRow, raw: string): string {
  const host = graphHost(project);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw badRequest("Send an absolute URL.");
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password) throw badRequest("Send an http(s) URL without credentials.");
  if (!host || normalizeHost(u.hostname) !== normalizeHost(host)) throw badRequest(`The URL must be on your verified site${host ? ` (${host})` : ""}.`);
  u.hash = "";
  return u.toString();
}

const download = (c: { body: (b: string, s: number, h: Record<string, string>) => Response }, out: { body: string; contentType: string; filename: string }) =>
  c.body(out.body, 200, { "Content-Type": out.contentType, "Content-Disposition": `attachment; filename="${out.filename}"`, "Cache-Control": "no-store" });

const fileStamp = (project: ProjectRow, now: Date) => `${(graphHost(project) ?? "site").replace(/[^a-z0-9.-]/gi, "_")}-${now.toISOString().slice(0, 10)}`;

linkRoutes.post("/projects/:pid/seo/internal-links/run", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  const r = await runLinkAnalysisFor(c.env, db, project, user.id, c.get("now"));
  if ("rateLimited" in r) return denial(c, r);
  return c.json({ data: r.data });
});

export type Limited<T> = { data: T } | { rateLimited: true; message: string; retryAfterSeconds: number };

function denial(c: { json: (b: unknown, s: number, h?: Record<string, string>) => Response }, r: { message: string; retryAfterSeconds: number }): Response {
  return c.json({ error: { code: "rate_limited", message: r.message } }, 429, { "Retry-After": String(r.retryAfterSeconds) });
}

async function limitFor(db: Db, key: string, rl: { limit: number; windowSeconds: number }, now: Date, what: string): Promise<{ rateLimited: true; message: string; retryAfterSeconds: number } | null> {
  const r = await hitRateLimit(db, key, rl.limit, rl.windowSeconds, now);
  if (r.allowed) return null;
  return { rateLimited: true, message: `${what} are limited to ${rl.limit} per hour per project. Try again later.`, retryAfterSeconds: r.retryAfterSeconds };
}

/**
 * Internal-link analysis run (route POST /internal-links/run and Ask Okara's confirmed link_job analysis):
 * setup_required report without using the rate limit; otherwise LINK_RUN_RATE_LIMIT per project, Jev + writer
 * from the workspace (none for demo projects).
 */
export async function runLinkAnalysisFor(env: Env, db: Db, project: ProjectRow, userId: string, now: Date): Promise<Limited<LinkSuggestionReport>> {
  const setup = await linkSetup(db, project);
  if (setup.state === "setup_required") {
    return { data: emptyReport("setup_required", null, [setup.message ?? "Setup required."], project.is_demo === 1) };
  }
  const denied = await limitFor(db, `internal_links_run:${project.id}`, LINK_RUN_RATE_LIMIT, now, "Internal-link runs");
  if (denied) return denied;
  const demo = project.is_demo === 1;
  const decisions = demo ? null : await decisionsFactory(env, db, project.workspace_id, project.id);
  const writer = demo ? null : await writerFactory(env, db, project.workspace_id, project.id);
  return { data: await runLinkSuggestions(env, db, project, now, { decisions, writer, userId }) };
}

/** Deterministic link-graph rebuild (route POST /graph/rebuild and Ask Okara): GRAPH_REBUILD_RATE_LIMIT per project. */
export async function rebuildLinkGraphFor(db: Db, project: ProjectRow, userId: string, now: Date): Promise<Limited<LinkGraphSummary>> {
  const setup = await linkSetup(db, project);
  if (setup.state === "setup_required") return { data: await graphSummary(db, project, now) };
  const denied = await limitFor(db, `link_graph_rebuild:${project.id}`, GRAPH_REBUILD_RATE_LIMIT, now, "Link graph rebuilds");
  if (denied) return denied;
  await buildAndStoreLinkGraph(db, project, { trigger: "manual", now, userId, throwOnBusy: true });
  return { data: await graphSummary(db, project, now) };
}

export type ClusterEdit = { kind: "hub"; url: string; hub: boolean | null } | { kind: "assign"; spokeUrl: string; hubUrl: string | null } | { kind: "reset"; spokeUrl: string };

/**
 * Hub mark/unmark/clear and spoke assign/reset (routes PUT /clusters/hub|assign and Ask Okara): URLs must be on the
 * verified host (400 otherwise); CLUSTER_EDIT_RATE_LIMIT per project.
 */
export async function editClusterFor(db: Db, project: ProjectRow, userId: string, now: Date, edit: ClusterEdit): Promise<Limited<LinkClusterReport>> {
  const denied = await limitFor(db, `link_cluster_edit:${project.id}`, CLUSTER_EDIT_RATE_LIMIT, now, "Cluster edits");
  if (denied) return denied;
  if (edit.kind === "hub") await setHubOverride(db, project, ownUrl(project, edit.url), edit.hub, userId, now);
  else {
    const spoke = ownUrl(project, edit.spokeUrl);
    const hub = edit.kind === "reset" ? undefined : edit.hubUrl === null ? null : ownUrl(project, edit.hubUrl);
    await setSpokeAssignment(db, project, spoke, hub, userId, now);
  }
  return { data: await clusterReport(db, project) };
}

linkRoutes.get("/projects/:pid/seo/internal-links", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  return c.json({ data: await getLinkReport(db, project, c.get("now")) });
});

function listParam<T extends string>(raw: string | undefined, allowed: readonly T[], what: string): T[] {
  if (!raw) return [];
  const out = raw.split(",").map((x) => x.trim()).filter(Boolean);
  for (const x of out) if (!allowed.includes(x as T)) throw badRequest(`${what} must be one of: ${allowed.join(", ")}.`);
  return out as T[];
}

linkRoutes.get("/projects/:pid/seo/internal-links/export", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  const format = c.req.query("format") ?? "csv";
  if (format !== "csv" && format !== "json" && format !== "sheet") throw badRequest("format must be csv, json, or sheet.");
  const ids = (c.req.query("ids") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (ids.length > 500) throw badRequest("At most 500 ids per export.");
  const placement = c.req.query("placement");
  if (placement && placement !== "existing_sentence" && placement !== "draft_sentence") throw badRequest("placement must be existing_sentence or draft_sentence.");
  const filter: ExportFilter = {
    ids,
    userStatuses: listParam<LinkUserStatus>(c.req.query("userStatus"), USER_STATUSES, "userStatus"),
    statuses: listParam(c.req.query("status"), ["suggested", "review", "rejected"] as const, "status"),
    placement: (placement as ExportFilter["placement"]) ?? null,
  };
  return download(c, await exportLinks(db, project, format, c.get("now"), filter));
});

linkRoutes.post("/projects/:pid/seo/internal-links/bulk", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  const parsed = bulkSchema.safeParse(await body(c));
  if (!parsed.success) throw badRequest(`Send {ids: 1–${MAX_BULK_IDS} suggestion ids, userStatus: ${USER_STATUSES.join(" | ")}}.`);
  return c.json({ data: await updateLinkUserStatusBulk(db, project, parsed.data.ids, parsed.data.userStatus, c.get("now")) });
});

// ------------------------------------------------------------------------------------ link graph

linkRoutes.get("/projects/:pid/seo/internal-links/graph", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  return c.json({ data: await graphSummary(db, project, c.get("now")) });
});

linkRoutes.post("/projects/:pid/seo/internal-links/graph/rebuild", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  const r = await rebuildLinkGraphFor(db, project, user.id, c.get("now"));
  if ("rateLimited" in r) return denial(c, r);
  return c.json({ data: r.data });
});

linkRoutes.get("/projects/:pid/seo/internal-links/graph/urls", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  const filter = c.req.query("filter") ?? "all";
  const sort = c.req.query("sort") ?? "links_in";
  if (!GRAPH_FILTERS.includes(filter as LinkGraphFilter)) throw badRequest(`filter must be one of: ${GRAPH_FILTERS.join(", ")}.`);
  if (!GRAPH_SORTS.includes(sort as LinkGraphSort)) throw badRequest(`sort must be one of: ${GRAPH_SORTS.join(", ")}.`);
  const dir = c.req.query("dir") === "asc" ? "asc" : "desc";
  const num = (v: string | undefined, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const data = await graphUrls(
    db,
    project,
    { filter: filter as LinkGraphFilter, sort: sort as LinkGraphSort, dir, q: c.req.query("q") ?? null, offset: num(c.req.query("offset"), 0), limit: num(c.req.query("limit"), 50) },
    c.get("now"),
  );
  return c.json({ data });
});

linkRoutes.get("/projects/:pid/seo/internal-links/graph/url", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  const url = c.req.query("url");
  if (!url || url.length > 2048) throw badRequest("Send ?url= (an absolute URL).");
  return c.json({ data: await graphUrlDetail(db, project, url, c.get("now")) });
});

linkRoutes.get("/projects/:pid/seo/internal-links/graph/export", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  const now = c.get("now");
  return download(c, { body: await graphCsv(db, project, now), contentType: "text/csv; charset=utf-8", filename: `link-graph-${fileStamp(project, now)}.csv` });
});

// ------------------------------------------------------------------------------------ clusters

linkRoutes.get("/projects/:pid/seo/internal-links/clusters", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  return c.json({ data: await clusterReport(db, project) });
});

linkRoutes.put("/projects/:pid/seo/internal-links/clusters/hub", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  const parsed = hubSchema.safeParse(await body(c));
  if (!parsed.success) throw badRequest("Send {url, hub: true | false | null}.");
  const r = await editClusterFor(db, project, user.id, c.get("now"), { kind: "hub", url: parsed.data.url, hub: parsed.data.hub });
  if ("rateLimited" in r) return denial(c, r);
  return c.json({ data: r.data });
});

linkRoutes.put("/projects/:pid/seo/internal-links/clusters/assign", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  const parsed = assignSchema.safeParse(await body(c));
  if (!parsed.success) throw badRequest("Send {spokeUrl, hubUrl: url | null} or {spokeUrl, reset: true}.");
  const edit: ClusterEdit = "reset" in parsed.data ? { kind: "reset", spokeUrl: parsed.data.spokeUrl } : { kind: "assign", spokeUrl: parsed.data.spokeUrl, hubUrl: parsed.data.hubUrl };
  const r = await editClusterFor(db, project, user.id, c.get("now"), edit);
  if ("rateLimited" in r) return denial(c, r);
  return c.json({ data: r.data });
});

// ------------------------------------------------------------------------------------ broken links, anchors, placed

linkRoutes.get("/projects/:pid/seo/internal-links/broken", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  const now = c.get("now");
  const format = c.req.query("format");
  if (format && format !== "csv" && format !== "json") throw badRequest("format must be csv or json.");
  if (format === "csv") return download(c, { body: await brokenLinksCsv(db, project, now), contentType: "text/csv; charset=utf-8", filename: `broken-links-${fileStamp(project, now)}.csv` });
  return c.json({ data: await brokenLinks(db, project, now) });
});

linkRoutes.get("/projects/:pid/seo/internal-links/anchors", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  return c.json({ data: await anchorReport(db, project, { flaggedOnly: c.req.query("all") !== "1" }) });
});

linkRoutes.get("/projects/:pid/seo/internal-links/placed", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  return c.json({ data: await placedLinksReport(db, project) });
});

linkRoutes.patch("/projects/:pid/seo/internal-links/:id", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  const parsed = patchSchema.safeParse(await body(c));
  if (!parsed.success) throw badRequest(`userStatus must be one of: ${USER_STATUSES.join(", ")}.`);
  const data = await updateLinkUserStatus(db, project, c.req.param("id"), parsed.data.userStatus, c.get("now"));
  return c.json({ data });
});
