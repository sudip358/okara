/**
 * [A25] Reading stored internal-link runs: the latest LinkSuggestionReport, user-status updates (single and bulk),
 * CSV/JSON/sheet-format export, placed-and-verified links, and the top open suggestions for the SEO agent. Every query
 * filters by workspace_id and project_id. Sentences, drafts and anchors are untrusted crawled or drafted text:
 * returned as plain strings only.
 *
 * Workbench additions (2026-10-03): suggestions carry their versioned priority with the numbers behind it, placement
 * ("wrap existing" vs a drafted "insert PK sentence"), the cluster (hub, gap), the source snapshot date, and, for
 * accepted/implemented links, the auto-verification status. Default order: status (suggested, review, rejected), then
 * priority, then the legacy score.
 */
import type {
  CapabilityState,
  Completeness,
  LinkDraftView,
  LinkPriorityView,
  LinkRole,
  LinkSuggestion,
  LinkSuggestionReport,
  LinkVerificationView,
  PlacedLinkRow,
  PlacedLinksReport,
  Tier,
} from "@shared/types";
import { DEMO_LABEL } from "../demo/fixtures";
import type { Db } from "../lib/db";
import { parseJson } from "../lib/db";
import { badRequest, notFound } from "../lib/errors";
import { iso } from "../lib/time";
import type { ProjectRow } from "../platform/access";
import { siteHost } from "../platform/projects";
import { normalizeUrlKey } from "../seo/rules/registry";
import { collectionHandle } from "./clusters";
import { BOM, csvCell, csvLine } from "./csv";
import { STALE_DAYS } from "./graph";
import { graphSummary, latestGraph, verificationView } from "./graph-read";
import { chunks, IN_CHUNK, placeholders } from "./sql";
import { loadVerifications, type StoredVerification } from "./verify";

export { csvCell };

export const LABEL_REVIEW_ONLY = "Suggestions for review. Okara never edits your pages.";
export const LABEL_CONFIDENCE = "Confidence values are Jev's reported confidence/probability, not predicted traffic.";

export type LinkUserStatus = LinkSuggestion["userStatus"];
export const USER_STATUSES: readonly LinkUserStatus[] = ["open", "accepted", "dismissed", "implemented"];
/** Suggestions changed per bulk request. */
export const MAX_BULK_IDS = 200;

export interface LinkSuggestionRow {
  id: string;
  workspace_id: string;
  project_id: string;
  link_run_id: string;
  source_page_id: string;
  target_page_id: string;
  source_url: string;
  source_title: string | null;
  target_url: string;
  target_title: string | null;
  target_inlinks: number;
  target_orphan: number;
  suggestion_key: string;
  sentence_index: number | null;
  sentence_text: string | null;
  anchor_text: string | null;
  role: LinkRole | null;
  method: "jev" | "deterministic";
  tier: Tier | null;
  should_exist: number | null;
  sentence_confidence: number | null;
  anchor_confidence: number | null;
  role_confidence: number | null;
  provider: string | null;
  model: string | null;
  question_version: string | null;
  policy_version: string | null;
  decision_record_id: string | null;
  status: "suggested" | "review" | "rejected";
  score: number;
  reasons_json: string;
  user_status: LinkUserStatus;
  created_at: string;
  updated_at: string;
  /** Workbench (migration 0017). Optional for rows written before it. */
  priority?: number | null;
  priority_json?: string | null;
  placement?: "existing_sentence" | "draft_sentence";
  draft_json?: string | null;
  hub_key?: string | null;
  cluster_gap?: "hub_to_spoke" | "spoke_to_hub" | null;
  source_fetched_at?: string | null;
  status_changed_at?: string | null;
}

export interface LinkRunRow {
  id: string;
  workspace_id: string;
  project_id: string;
  crawl_run_id: string | null;
  status: "running" | "completed" | "partial" | "failed";
  is_demo: number;
  pages_analysed: number;
  pages_eligible: number;
  provider: string | null;
  model: string | null;
  method_version: string;
  summary_json: string;
  notes_json: string;
  created_by: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface LinkRunSummary {
  orphanPages: Array<{ pageId: string; url: string }>;
  genericAnchors: Array<{ sourceUrl: string; targetUrl: string; anchor: string }>;
  completeness: Completeness | null;
}

export interface SuggestionContext {
  verifications?: ReadonlyMap<string, StoredVerification>;
  hubTitles?: ReadonlyMap<string, string | null>;
  now?: Date;
}

const pairKeyOf = (source: string, target: string) => `${normalizeUrlKey(source)}>${normalizeUrlKey(target)}`;

function priorityView(raw: string | null | undefined): LinkPriorityView | null {
  const p = parseJson<Partial<LinkPriorityView> & { value?: number }>(raw ?? "", {});
  if (typeof p.value !== "number") return null;
  return {
    value: p.value,
    relevance: Number(p.relevance ?? 0),
    impact: Number(p.impact ?? 1),
    targetFactor: Number(p.targetFactor ?? 1),
    sourceFactor: Number(p.sourceFactor ?? 1),
    clusterFactor: Number(p.clusterFactor ?? 1),
    positionBand: p.positionBand ?? "none",
    target: p.target ?? { impressions: null, clicks: null, position: null, basis: null },
    source: p.source ?? { inlinks: 0, clicks: null },
    gscLabel: p.gscLabel ?? null,
    explanation: Array.isArray(p.explanation) ? p.explanation.filter((x): x is string => typeof x === "string") : [],
    version: typeof p.version === "string" ? p.version : "",
  };
}

function draftView(raw: string | null | undefined): LinkDraftView | null {
  const d = parseJson<Partial<LinkDraftView> & { text?: string }>(raw ?? "", {});
  if (typeof d.text !== "string") return null;
  return {
    text: d.text,
    label: d.label ?? "Draft sentence — review before publishing",
    evidence: Array.isArray(d.evidence) ? d.evidence.filter((e): e is { id: string; text: string } => !!e && typeof e.id === "string" && typeof e.text === "string") : [],
    citedEvidenceIds: Array.isArray(d.citedEvidenceIds) ? d.citedEvidenceIds.filter((x): x is string => typeof x === "string") : [],
    validation: {
      ok: d.validation?.ok === true,
      errors: Array.isArray(d.validation?.errors) ? d.validation!.errors.filter((x): x is string => typeof x === "string") : [],
      warnings: Array.isArray(d.validation?.warnings) ? d.validation!.warnings.filter((x): x is string => typeof x === "string") : [],
    },
    insertAfter: typeof d.insertAfter === "string" ? d.insertAfter : null,
    writer: d.writer && typeof d.writer.provider === "string" ? { provider: d.writer.provider, model: String(d.writer.model ?? "") } : null,
  };
}

export function toLinkSuggestion(r: LinkSuggestionRow, ctx: SuggestionContext = {}): LinkSuggestion {
  const placed = r.user_status === "accepted" || r.user_status === "implemented";
  let verification: LinkVerificationView | null = null;
  if (placed && ctx.verifications) verification = verificationView(ctx.verifications.get(pairKeyOf(r.source_url, r.target_url)));
  const staleBefore = (ctx.now ?? new Date()).getTime() - STALE_DAYS * 86_400_000;
  return {
    id: r.id,
    source: { pageId: r.source_page_id, url: r.source_url, title: r.source_title },
    target: { pageId: r.target_page_id, url: r.target_url, title: r.target_title, inlinks: Number(r.target_inlinks), orphan: Number(r.target_orphan) === 1 },
    sentence: r.sentence_text !== null && r.sentence_index !== null ? { index: Number(r.sentence_index), text: r.sentence_text } : null,
    anchor: r.anchor_text ? { text: r.anchor_text } : null,
    role: r.role,
    method: r.method,
    decision:
      r.method === "jev"
        ? {
            tier: r.tier,
            shouldExist: r.should_exist,
            sentenceConfidence: r.sentence_confidence,
            anchorConfidence: r.anchor_confidence,
            roleConfidence: r.role_confidence,
            provider: r.provider,
            model: r.model,
          }
        : null,
    status: r.status,
    score: Number(r.score),
    reasons: parseJson<unknown[]>(r.reasons_json, []).filter((x): x is string => typeof x === "string"),
    userStatus: r.user_status,
    priority: priorityView(r.priority_json),
    placement: r.placement === "draft_sentence" ? "draft_sentence" : "existing_sentence",
    draft: r.placement === "draft_sentence" ? draftView(r.draft_json) : null,
    cluster: r.hub_key ? { hubUrl: r.hub_key, hubTitle: ctx.hubTitles?.get(r.hub_key) ?? null, gap: r.cluster_gap ?? null } : null,
    verification,
    sourceSnapshot: r.source_fetched_at ? { fetchedAt: r.source_fetched_at, stale: Date.parse(r.source_fetched_at) < staleBefore } : null,
  };
}

// ------------------------------------------------------------------------------------ setup

export interface LinkSetup {
  state: "ready" | "demo" | "setup_required";
  host: string | null;
  crawl: { id: string; startedAt: string; status: string } | null;
  message: string | null;
}

/** Host + latest usable crawl, or why the suggester cannot run yet. Demo projects use the demo crawl. */
export async function linkSetup(db: Db, project: ProjectRow): Promise<LinkSetup> {
  const isDemo = project.is_demo === 1;
  const host = isDemo ? siteHost(project.site_url) : project.verified_host;
  if (!host) {
    return {
      state: "setup_required",
      host: null,
      crawl: null,
      message: "Verify site ownership (Search Console, DNS, or file) first. Internal-link suggestions are built only from a crawl of your verified site.",
    };
  }
  const crawl = await db.first<{ id: string; started_at: string; status: string }>(
    `SELECT id, started_at, status FROM crawl_runs
      WHERE workspace_id = ? AND project_id = ? AND status IN ('completed', 'partial')
      ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    project.workspace_id,
    project.id,
  );
  if (!crawl) {
    return { state: "setup_required", host, crawl: null, message: `No crawl yet. Run the SEO agent to crawl ${host} first; suggestions use the latest crawl.` };
  }
  return { state: isDemo ? "demo" : "ready", host, crawl: { id: crawl.id, startedAt: crawl.started_at, status: crawl.status }, message: null };
}

export function baseLabels(isDemo: boolean): string[] {
  const labels = [LABEL_REVIEW_ONLY, LABEL_CONFIDENCE];
  if (isDemo) labels.push(`${DEMO_LABEL}: suggestions come from the fictional demo crawl; Jev is not called.`);
  return labels;
}

export function emptyReport(state: CapabilityState, now: Date | null, extra: string[], isDemo = false): LinkSuggestionReport {
  return {
    state,
    generatedAt: now ? iso(now) : null,
    crawlRunId: null,
    pagesAnalysed: 0,
    orphanPages: [],
    suggestions: [],
    genericAnchors: [],
    completeness: null,
    labels: [...baseLabels(isDemo), ...extra],
  };
}

// ------------------------------------------------------------------------------------ latest report

export async function latestLinkRun(db: Db, workspaceId: string, projectId: string): Promise<LinkRunRow | null> {
  return db.first<LinkRunRow>(
    `SELECT * FROM link_runs WHERE workspace_id = ? AND project_id = ? AND status IN ('completed', 'partial')
      ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    workspaceId,
    projectId,
  );
}

const STATUS_ORDER = `CASE status WHEN 'suggested' THEN 0 WHEN 'review' THEN 1 ELSE 2 END`;
/** Report order: status, then priority (rows from before the workbench have none), then the legacy score. */
export const SUGGESTION_ORDER = `${STATUS_ORDER}, (priority IS NULL), priority DESC, score DESC, source_url, target_url`;

/** Titles of hub pages (latest link graph) for the suggestions' cluster labels. */
async function hubTitles(db: Db, project: Pick<ProjectRow, "id" | "workspace_id">, keys: readonly string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const unique = [...new Set(keys.filter(Boolean))];
  if (!unique.length) return out;
  const g = await latestGraph(db, project);
  if (!g) return out;
  for (const part of chunks(unique.slice(0, 900), IN_CHUNK)) {
    const rows = await db.all<{ url_key: string; title: string | null }>(
      `SELECT url_key, title FROM link_graph_urls WHERE workspace_id = ? AND project_id = ? AND graph_id = ? AND url_key IN (${placeholders(part.length)})`,
      project.workspace_id,
      project.id,
      g.id,
      ...part,
    );
    for (const r of rows) out.set(r.url_key, r.title);
  }
  return out;
}

async function contextFor(db: Db, project: Pick<ProjectRow, "id" | "workspace_id">, rows: readonly LinkSuggestionRow[], now: Date): Promise<SuggestionContext> {
  const needsVerify = rows.some((r) => r.user_status === "accepted" || r.user_status === "implemented");
  return {
    verifications: needsVerify ? await loadVerifications(db, project) : new Map(),
    hubTitles: await hubTitles(db, project, rows.map((r) => r.hub_key ?? "")),
    now,
  };
}

export async function loadRunSuggestions(db: Db, run: LinkRunRow, now: Date = new Date()): Promise<LinkSuggestion[]> {
  const rows = await db.all<LinkSuggestionRow>(
    `SELECT * FROM link_suggestions WHERE workspace_id = ? AND project_id = ? AND link_run_id = ?
      ORDER BY ${SUGGESTION_ORDER}`,
    run.workspace_id,
    run.project_id,
    run.id,
  );
  const ctx = await contextFor(db, { id: run.project_id, workspace_id: run.workspace_id }, rows, now);
  return rows.map((r) => toLinkSuggestion(r, ctx));
}

export async function getLinkReport(db: Db, project: ProjectRow, now: Date = new Date()): Promise<LinkSuggestionReport> {
  const isDemo = project.is_demo === 1;
  const setup = await linkSetup(db, project);
  const run = await latestLinkRun(db, project.workspace_id, project.id);
  const graph = await graphSummary(db, project, now).catch(() => null);
  if (!run) {
    const r = setup.state === "setup_required" ? emptyReport("setup_required", null, [setup.message ?? "Setup required."], isDemo) : emptyReport(setup.state, null, ["No internal-link analysis yet. Press Run to analyse the latest crawl."], isDemo);
    return { ...r, graph, drafts: null, priorityVersion: null };
  }
  const summary = parseJson<Partial<LinkRunSummary> & { drafts?: LinkSuggestionReport["drafts"]; priorityVersion?: string }>(run.summary_json, {});
  const labels = [...baseLabels(run.is_demo === 1), ...parseJson<unknown[]>(run.notes_json, []).filter((x): x is string => typeof x === "string")];
  if (setup.crawl && run.crawl_run_id && setup.crawl.id !== run.crawl_run_id) {
    labels.push(`A newer crawl (started ${setup.crawl.startedAt}) exists; run again to refresh these suggestions.`);
  }
  if (setup.state === "setup_required" && setup.message) labels.push(setup.message);
  return {
    state: run.is_demo === 1 ? "demo" : "ready",
    generatedAt: run.finished_at ?? run.created_at,
    crawlRunId: run.crawl_run_id,
    pagesAnalysed: Number(run.pages_analysed),
    orphanPages: Array.isArray(summary.orphanPages) ? summary.orphanPages : [],
    suggestions: await loadRunSuggestions(db, run, now),
    genericAnchors: Array.isArray(summary.genericAnchors) ? summary.genericAnchors : [],
    completeness: summary.completeness ?? null,
    labels,
    graph,
    drafts: summary.drafts ?? null,
    priorityVersion: summary.priorityVersion ?? null,
  };
}

// ------------------------------------------------------------------------------------ user status

export async function updateLinkUserStatus(db: Db, project: ProjectRow, id: string, userStatus: LinkUserStatus, now: Date): Promise<LinkSuggestion> {
  const res = await db.run(
    "UPDATE link_suggestions SET user_status = ?, updated_at = ?, status_changed_at = ? WHERE id = ? AND workspace_id = ? AND project_id = ?",
    userStatus,
    iso(now),
    iso(now),
    id,
    project.workspace_id,
    project.id,
  );
  if (res.changes !== 1) throw notFound("Suggestion");
  const row = await db.first<LinkSuggestionRow>("SELECT * FROM link_suggestions WHERE id = ? AND workspace_id = ? AND project_id = ?", id, project.workspace_id, project.id);
  if (!row) throw notFound("Suggestion");
  return toLinkSuggestion(row, await contextFor(db, project, [row], now));
}

/** Bulk accept / dismiss / implement / reopen (at most MAX_BULK_IDS ids; unknown ids are ignored and counted). */
export async function updateLinkUserStatusBulk(db: Db, project: ProjectRow, ids: readonly string[], userStatus: LinkUserStatus, now: Date): Promise<{ updated: number; missing: number; suggestions: LinkSuggestion[] }> {
  const unique = [...new Set(ids)];
  if (unique.length === 0 || unique.length > MAX_BULK_IDS) throw badRequest(`Send 1 to ${MAX_BULK_IDS} suggestion ids.`);
  let updated = 0;
  const rows: LinkSuggestionRow[] = [];
  for (const part of chunks(unique, IN_CHUNK)) {
    const r = await db.run(
      `UPDATE link_suggestions SET user_status = ?, updated_at = ?, status_changed_at = ? WHERE workspace_id = ? AND project_id = ? AND id IN (${placeholders(part.length)})`,
      userStatus,
      iso(now),
      iso(now),
      project.workspace_id,
      project.id,
      ...part,
    );
    updated += r.changes;
    rows.push(
      ...(await db.all<LinkSuggestionRow>(`SELECT * FROM link_suggestions WHERE workspace_id = ? AND project_id = ? AND id IN (${placeholders(part.length)})`, project.workspace_id, project.id, ...part)),
    );
  }
  const ctx = await contextFor(db, project, rows, now);
  return { updated, missing: unique.length - updated, suggestions: rows.map((r) => toLinkSuggestion(r, ctx)) };
}

// ------------------------------------------------------------------------------------ export

export const CSV_COLUMNS = [
  "source_url",
  "target_url",
  "anchor",
  "sentence",
  "role",
  "status",
  "tier",
  "should_exist",
  "sentence_confidence",
  "anchor_confidence",
  "role_confidence",
] as const;

export function linksCsv(suggestions: readonly LinkSuggestion[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const s of suggestions) {
    const d = s.decision;
    lines.push(
      [
        csvCell(s.source.url),
        csvCell(s.target.url),
        csvCell(s.anchor?.text ?? null),
        csvCell(s.sentence?.text ?? null),
        csvCell(s.role),
        csvCell(s.status),
        csvCell(d?.tier ?? null),
        csvCell(d?.shouldExist ?? null),
        csvCell(d?.sentenceConfidence ?? null),
        csvCell(d?.anchorConfidence ?? null),
        csvCell(d?.roleConfidence ?? null),
      ].join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** The owner's tracking sheet columns, exactly (Blog Hub Drops). */
export const SHEET_COLUMNS = ["Date", "Source Article URL", "Target URL", "Anchor", "Method", "Hub", "Status"] as const;
export const SHEET_METHOD = { existing_sentence: "wrap existing", draft_sentence: "insert PK sentence" } as const;

/** "chandeliers" for a /collections/chandeliers hub; the URL path for other hubs; "" without a hub. */
export function sheetHub(hubUrl: string | null | undefined): string {
  if (!hubUrl) return "";
  const h = collectionHandle(hubUrl);
  if (h) return h;
  try {
    return new URL(hubUrl).pathname;
  } catch {
    return hubUrl;
  }
}

const USER_STATUS_TEXT: Record<LinkUserStatus, string> = { open: "Suggested", accepted: "Accepted", implemented: "Implemented", dismissed: "Dismissed" };

/** Status cell: the owner's decision, with the auto-verification when there is one. */
export function sheetStatus(s: LinkSuggestion): string {
  if (s.userStatus === "open") return s.status === "suggested" ? "Suggested" : s.status === "review" ? "Review" : "Rejected";
  const base = USER_STATUS_TEXT[s.userStatus];
  const v = s.verification;
  if (!v || v.status === "not_checked") return base;
  if (v.status === "verified") return `${base} · verified ${(v.checkedAt ?? "").slice(0, 10)}`;
  if (v.status === "not_found") return `${base} · not found in crawl ${(v.checkedAt ?? "").slice(0, 10)}`;
  if (v.status === "source_unavailable") return `${base} · source unavailable ${(v.checkedAt ?? "").slice(0, 10)}`;
  return `${base} · pending crawl`;
}

export interface SheetRowSource extends LinkSuggestion {
  /** created_at / status_changed_at of the row (Date column). */
  dateIso: string;
}

/** CSV in the owner's sheet format: exact headers, UTF-8 with BOM, RFC 4180 quoting, formula-safe cells. */
export function sheetCsv(rows: ReadonlyArray<SheetRowSource>): string {
  const lines = [csvLine([...SHEET_COLUMNS])];
  for (const s of rows) {
    lines.push(
      csvLine([
        s.dateIso.slice(0, 10),
        s.source.url,
        s.target.url,
        s.anchor?.text ?? "",
        SHEET_METHOD[s.placement === "draft_sentence" ? "draft_sentence" : "existing_sentence"],
        sheetHub(s.cluster?.hubUrl),
        sheetStatus(s),
      ]),
    );
  }
  return `${BOM}${lines.join("\r\n")}\r\n`;
}

export interface LinkExport {
  body: string;
  contentType: string;
  filename: string;
}

export interface ExportFilter {
  ids?: readonly string[];
  userStatuses?: readonly LinkUserStatus[];
  statuses?: ReadonlyArray<LinkSuggestion["status"]>;
  placement?: "existing_sentence" | "draft_sentence" | null;
}

/**
 * Rows for an export: the latest run's suggestions plus accepted/implemented/dismissed rows kept from earlier runs,
 * filtered. Sheet format default (no filter): everything but dismissed and rejected rows.
 */
async function exportRows(db: Db, project: ProjectRow, filter: ExportFilter, sheetDefaults: boolean, now: Date): Promise<SheetRowSource[]> {
  const run = await latestLinkRun(db, project.workspace_id, project.id);
  const where: string[] = ["workspace_id = ? AND project_id = ?"];
  const params: unknown[] = [project.workspace_id, project.id];
  if (run) {
    where.push("(link_run_id = ? OR user_status != 'open')");
    params.push(run.id);
  } else where.push("user_status != 'open'");
  let rows = await db.all<LinkSuggestionRow>(`SELECT * FROM link_suggestions WHERE ${where.join(" AND ")} ORDER BY ${SUGGESTION_ORDER} LIMIT 5000`, ...params);
  const ids = filter.ids?.length ? new Set(filter.ids) : null;
  rows = rows.filter((r) => {
    if (ids && !ids.has(r.id)) return false;
    if (filter.userStatuses?.length && !filter.userStatuses.includes(r.user_status)) return false;
    if (filter.statuses?.length && !filter.statuses.includes(r.status)) return false;
    if (filter.placement && (r.placement ?? "existing_sentence") !== filter.placement) return false;
    if (sheetDefaults && !ids && !filter.userStatuses?.length && !filter.statuses?.length && (r.user_status === "dismissed" || r.status === "rejected")) return false;
    return true;
  });
  const ctx = await contextFor(db, project, rows, now);
  return rows.map((r) => ({ ...toLinkSuggestion(r, ctx), dateIso: r.user_status === "open" ? r.created_at : (r.status_changed_at ?? r.updated_at) }));
}

export async function exportLinks(db: Db, project: ProjectRow, format: "csv" | "json" | "sheet", now: Date, filter: ExportFilter = {}): Promise<LinkExport> {
  const host = (project.verified_host ?? siteHost(project.site_url)).replace(/[^a-z0-9.-]/gi, "_");
  const stamp = iso(now).slice(0, 10);
  if (format === "sheet") {
    const rows = await exportRows(db, project, filter, true, now);
    return { body: sheetCsv(rows), contentType: "text/csv; charset=utf-8", filename: `internal-links-sheet-${host}-${stamp}.csv` };
  }
  const report = await getLinkReport(db, project, now);
  const filtered = filter.ids?.length || filter.userStatuses?.length || filter.statuses?.length || filter.placement;
  const suggestions = filtered ? await exportRows(db, project, filter, false, now) : report.suggestions;
  if (format === "csv") {
    return { body: linksCsv(suggestions), contentType: "text/csv; charset=utf-8", filename: `internal-links-${host}-${stamp}.csv` };
  }
  const body = JSON.stringify(
    {
      format: "okara-internal-links",
      version: 1,
      exportedAt: iso(now),
      project: { id: project.id, siteUrl: project.site_url },
      report: { ...report, suggestions },
    },
    null,
    2,
  );
  return { body, contentType: "application/json; charset=utf-8", filename: `internal-links-${host}-${stamp}.json` };
}

// ------------------------------------------------------------------------------------ placed and verified

/**
 * Links you accepted or marked implemented, and links your imported sheet says are placed, each with its
 * auto-verification status (verify.ts; refreshed with every link graph build).
 */
export async function placedLinksReport(db: Db, project: ProjectRow): Promise<PlacedLinksReport> {
  const verifications = await loadVerifications(db, project);
  const out = new Map<string, PlacedLinkRow>();
  const sugg = await db.all<LinkSuggestionRow>(
    `SELECT * FROM link_suggestions WHERE workspace_id = ? AND project_id = ? AND user_status IN ('accepted', 'implemented')
      ORDER BY COALESCE(status_changed_at, updated_at) DESC LIMIT 2000`,
    project.workspace_id,
    project.id,
  );
  for (const r of sugg) {
    const k = pairKeyOf(r.source_url, r.target_url);
    const existing = out.get(k);
    const origin = r.user_status as "accepted" | "implemented";
    if (existing) {
      if (!existing.origins.includes(origin)) existing.origins.push(origin);
      continue;
    }
    out.set(k, {
      key: k,
      sourceUrl: r.source_url,
      targetUrl: r.target_url,
      anchor: r.anchor_text,
      origins: [origin],
      suggestionId: r.id,
      placedOn: (r.status_changed_at ?? r.updated_at).slice(0, 10),
      method: SHEET_METHOD[r.placement === "draft_sentence" ? "draft_sentence" : "existing_sentence"],
      hub: sheetHub(r.hub_key) || null,
      verification: verificationView(verifications.get(k)),
    });
  }
  let sheet: Array<{ data_json: string; created_at: string }> = [];
  try {
    sheet = await db.all<{ data_json: string; created_at: string }>(
      `SELECT data_json, created_at FROM import_records WHERE workspace_id = ? AND project_id = ? AND destination = 'implemented_links' AND status = 'placed'
        ORDER BY created_at DESC LIMIT 2000`,
      project.workspace_id,
      project.id,
    );
  } catch {
    sheet = [];
  }
  for (const r of sheet) {
    const d = parseJson<{ source?: string; target?: string; anchor?: string | null; date?: string | null; method?: string | null; hub?: string | null }>(r.data_json, {});
    if (!d.source || !d.target) continue;
    const k = pairKeyOf(d.source, d.target);
    const existing = out.get(k);
    if (existing) {
      if (!existing.origins.includes("sheet")) existing.origins.push("sheet");
      existing.method ??= d.method ?? null;
      existing.hub ??= d.hub ?? null;
      continue;
    }
    out.set(k, {
      key: k,
      sourceUrl: d.source,
      targetUrl: d.target,
      anchor: d.anchor ?? null,
      origins: ["sheet"],
      suggestionId: null,
      placedOn: d.date ?? r.created_at.slice(0, 10),
      method: d.method ?? null,
      hub: d.hub ?? null,
      verification: verificationView(verifications.get(k)),
    });
  }
  const rows = [...out.values()];
  const order: Record<string, number> = { not_found: 0, source_unavailable: 1, pending: 2, not_checked: 3, verified: 4 };
  rows.sort((a, b) => (order[a.verification.status] ?? 9) - (order[b.verification.status] ?? 9) || (a.sourceUrl < b.sourceUrl ? -1 : 1));
  const counts = { total: rows.length, verified: 0, notFound: 0, pending: 0, sourceUnavailable: 0, notChecked: 0 };
  for (const r of rows) {
    const s = r.verification.status;
    if (s === "verified") counts.verified++;
    else if (s === "not_found") counts.notFound++;
    else if (s === "pending") counts.pending++;
    else if (s === "source_unavailable") counts.sourceUnavailable++;
    else counts.notChecked++;
  }
  const state: CapabilityState = project.is_demo === 1 ? "demo" : project.verified_host ? "ready" : "setup_required";
  return {
    state,
    rows,
    counts,
    labels: [
      "Checked after each crawl against the latest snapshot of the source page taken after the link was accepted, implemented, or placed (sheet Date): a link counts when its href resolves to the target, its final URL after a redirect, or a canonical variant.",
      "Pending = the source page has not been crawled since; the rolling crawl reaches every page over successive runs.",
    ],
  };
}

/** Overview attention feed: implemented (or sheet-placed) links the latest crawl of their source page did not find. */
export async function linkVerificationAttention(db: Db, project: Pick<ProjectRow, "id" | "workspace_id">): Promise<{ notFound: number; checkedAt: string | null; examples: Array<{ sourceUrl: string; targetUrl: string }> } | null> {
  let rows: Array<{ source_key: string; target_key: string; checked_at: string | null }> = [];
  try {
    rows = await db.all(
      `SELECT source_key, target_key, checked_at FROM link_verifications
        WHERE workspace_id = ? AND project_id = ? AND status = 'not_found' AND (origins LIKE '%implemented%' OR origins LIKE '%sheet%')
        ORDER BY checked_at DESC LIMIT 200`,
      project.workspace_id,
      project.id,
    );
  } catch {
    return null;
  }
  if (!rows.length) return null;
  return { notFound: rows.length, checkedAt: rows[0]!.checked_at, examples: rows.slice(0, 3).map((r) => ({ sourceUrl: r.source_key, targetUrl: r.target_key })) };
}

// ------------------------------------------------------------------------------------ SEO agent feed

/**
 * The highest-priority open suggestions of the latest run that Jev (or policy) marked 'suggested', for the SEO
 * agent's internal-link recommendations (seo/recommend/inputs.ts). Cluster-gap suggestions rank higher through their
 * priority boost. Drafted sentences are never 'suggested' (always review), so they are never fed to the agent.
 */
export async function topLinkSuggestionsForAgent(db: Db, workspaceId: string, projectId: string, limit: number): Promise<LinkSuggestion[]> {
  const run = await latestLinkRun(db, workspaceId, projectId);
  if (!run) return [];
  const n = Math.max(0, Math.min(100, Math.floor(limit)));
  if (n === 0) return [];
  const rows = await db.all<LinkSuggestionRow>(
    `SELECT * FROM link_suggestions
      WHERE workspace_id = ? AND project_id = ? AND link_run_id = ? AND status = 'suggested' AND user_status = 'open'
      ORDER BY (priority IS NULL), priority DESC, score DESC, source_url, target_url LIMIT ?`,
    workspaceId,
    projectId,
    run.id,
    n,
  );
  return rows.map((r) => toLinkSuggestion(r));
}
