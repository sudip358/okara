/**
 * [A25] Reading stored internal-link runs: the latest LinkSuggestionReport, user-status updates, CSV/JSON
 * export, and the top open suggestions for the SEO agent. Every query filters by workspace_id and
 * project_id. Sentences and anchors are untrusted crawled text: returned as plain strings only.
 */
import type { CapabilityState, Completeness, LinkRole, LinkSuggestion, LinkSuggestionReport, Tier } from "@shared/types";
import { DEMO_LABEL } from "../demo/fixtures";
import type { Db } from "../lib/db";
import { parseJson } from "../lib/db";
import { notFound } from "../lib/errors";
import { iso } from "../lib/time";
import type { ProjectRow } from "../platform/access";
import { siteHost } from "../platform/projects";

export const LABEL_REVIEW_ONLY = "Suggestions for review. Okara never edits your pages.";
export const LABEL_CONFIDENCE = "Confidence values are Jev's reported confidence/probability, not predicted traffic.";

export type LinkUserStatus = LinkSuggestion["userStatus"];
export const USER_STATUSES: readonly LinkUserStatus[] = ["open", "accepted", "dismissed", "implemented"];

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

export function toLinkSuggestion(r: LinkSuggestionRow): LinkSuggestion {
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

export async function loadRunSuggestions(db: Db, run: LinkRunRow): Promise<LinkSuggestion[]> {
  const rows = await db.all<LinkSuggestionRow>(
    `SELECT * FROM link_suggestions WHERE workspace_id = ? AND project_id = ? AND link_run_id = ?
      ORDER BY ${STATUS_ORDER}, score DESC, source_url, target_url`,
    run.workspace_id,
    run.project_id,
    run.id,
  );
  return rows.map(toLinkSuggestion);
}

export async function getLinkReport(db: Db, project: ProjectRow): Promise<LinkSuggestionReport> {
  const isDemo = project.is_demo === 1;
  const setup = await linkSetup(db, project);
  const run = await latestLinkRun(db, project.workspace_id, project.id);
  if (!run) {
    if (setup.state === "setup_required") return emptyReport("setup_required", null, [setup.message ?? "Setup required."], isDemo);
    return emptyReport(setup.state, null, ["No internal-link analysis yet. Press Run to analyse the latest crawl."], isDemo);
  }
  const summary = parseJson<Partial<LinkRunSummary>>(run.summary_json, {});
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
    suggestions: await loadRunSuggestions(db, run),
    genericAnchors: Array.isArray(summary.genericAnchors) ? summary.genericAnchors : [],
    completeness: summary.completeness ?? null,
    labels,
  };
}

// ------------------------------------------------------------------------------------ user status

export async function updateLinkUserStatus(db: Db, project: ProjectRow, id: string, userStatus: LinkUserStatus, now: Date): Promise<LinkSuggestion> {
  const res = await db.run(
    "UPDATE link_suggestions SET user_status = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND project_id = ?",
    userStatus,
    iso(now),
    id,
    project.workspace_id,
    project.id,
  );
  if (res.changes !== 1) throw notFound("Suggestion");
  const row = await db.first<LinkSuggestionRow>("SELECT * FROM link_suggestions WHERE id = ? AND workspace_id = ? AND project_id = ?", id, project.workspace_id, project.id);
  if (!row) throw notFound("Suggestion");
  return toLinkSuggestion(row);
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

/**
 * One CSV cell (RFC 4180): quoted when it contains a comma, quote, CR, or LF; quotes doubled. Text cells
 * that a spreadsheet would treat as a formula (leading =, +, -, @, tab, CR) are prefixed with a single
 * quote, because sentences are untrusted crawled text.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  let s = value;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

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

export interface LinkExport {
  body: string;
  contentType: string;
  filename: string;
}

export async function exportLinks(db: Db, project: ProjectRow, format: "csv" | "json", now: Date): Promise<LinkExport> {
  const report = await getLinkReport(db, project);
  const host = (project.verified_host ?? siteHost(project.site_url)).replace(/[^a-z0-9.-]/gi, "_");
  const stamp = iso(now).slice(0, 10);
  if (format === "csv") {
    return { body: linksCsv(report.suggestions), contentType: "text/csv; charset=utf-8", filename: `internal-links-${host}-${stamp}.csv` };
  }
  const body = JSON.stringify(
    {
      format: "okara-internal-links",
      version: 1,
      exportedAt: iso(now),
      project: { id: project.id, siteUrl: project.site_url },
      report,
    },
    null,
    2,
  );
  return { body, contentType: "application/json; charset=utf-8", filename: `internal-links-${host}-${stamp}.json` };
}

// ------------------------------------------------------------------------------------ SEO agent feed

/**
 * The highest-scoring open suggestions of the latest run that Jev (or policy) marked 'suggested', for
 * the SEO agent's internal-link recommendations. Not wired into the agent here.
 */
export async function topLinkSuggestionsForAgent(db: Db, workspaceId: string, projectId: string, limit: number): Promise<LinkSuggestion[]> {
  const run = await latestLinkRun(db, workspaceId, projectId);
  if (!run) return [];
  const n = Math.max(0, Math.min(100, Math.floor(limit)));
  if (n === 0) return [];
  const rows = await db.all<LinkSuggestionRow>(
    `SELECT * FROM link_suggestions
      WHERE workspace_id = ? AND project_id = ? AND link_run_id = ? AND status = 'suggested' AND user_status = 'open'
      ORDER BY score DESC, source_url, target_url LIMIT ?`,
    workspaceId,
    projectId,
    run.id,
    n,
  );
  return rows.map(toLinkSuggestion);
}
