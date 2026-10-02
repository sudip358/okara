/**
 * Import service: dry run, commit (one `imports` row + provenance in `import_changes`), undo of the latest import
 * per destination, history, the Import page overview, and read models used by other pages (imported links with
 * crawl verification, sheet competitor metrics, prompt reference notes). Tenancy: every query filters by
 * workspace_id + project_id of a project the caller already resolved with requireProject().
 */
import type { Competitor } from "@shared/types";
import {
  CONTEXT_DOC_MAX_CHARS,
  CONTEXT_DOC_MAX_ROWS,
  MAX_CSV_BYTES,
  MAX_IMPORT_ROWS,
  promptKey,
  type ImportCounts,
  type ImportDestination,
  type ImportedCompetitorRow,
  type ImportedLinksReport,
  type ImportedLinkStatus,
  type ImportMapping,
  type ImportOptions,
  type ImportOverview,
  type ImportPlan,
  type ImportRecordSummary,
  type ImportSyncSummary,
  type SyncErrorCode,
} from "@shared/import";
import type { Env } from "../env";
import type { Db } from "../lib/db";
import { parseJson } from "../lib/db";
import { conflict, notFound } from "../lib/errors";
import { newId } from "../lib/ids";
import { iso, utcDay } from "../lib/time";
import type { ProjectRow } from "../platform/access";
import { MAX_COMPETITORS, loadProjectRow, updateProject } from "../platform/projects";
import { getActivePromptSet, MAX_PROMPTS_PER_SET, savePromptSet, type PromptInput } from "../geo/prompts";
import { normalizeUrlKey } from "../seo/rules/registry";
import { projectCompetitors } from "../competitors/dataforseo";
import { targetDomain } from "../providers/dataforseo";
import { COMPETITOR_ADDED, clip, prepare, runBatches, type ChangeRow, type ImportCtx, type RecordRow } from "./destinations";
import type { LoadedTable } from "./source";
import { sheetsStatus } from "./sheets";

export interface ImportRow {
  id: string;
  workspace_id: string;
  project_id: string;
  source: "csv" | "sheets";
  source_name: string;
  spreadsheet_id: string | null;
  tab: string | null;
  sheet_tab_id: number | null;
  destination: ImportDestination;
  trigger: "manual" | "sync";
  sync_id: string | null;
  mapping_json: string;
  options_json: string;
  counts_json: string;
  changes_json: string;
  rows_read: number;
  status: "completed" | "undone";
  created_by: string | null;
  created_at: string;
  undone_at: string | null;
  undone_by: string | null;
}

export interface SyncRow {
  id: string;
  workspace_id: string;
  project_id: string;
  spreadsheet_id: string;
  spreadsheet_title: string;
  tab: string;
  sheet_tab_id: number | null;
  destination: ImportDestination;
  mapping_json: string;
  options_json: string;
  frequency_hours: number;
  enabled: number;
  next_run_at: string;
  running_until: string | null;
  last_run_at: string | null;
  last_status: "never" | "ok" | "error";
  last_error_code: SyncErrorCode | null;
  last_error: string | null;
  last_warning: string | null;
  last_import_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export const MAX_CHANGE_LINES = 200;
export const HISTORY_LIMIT = 30;

// ------------------------------------------------------------------ dry run + commit
export async function dryRun(ctx: ImportCtx, loaded: LoadedTable, destination: ImportDestination, mapping: ImportMapping, options: ImportOptions): Promise<ImportPlan> {
  return (await prepare(ctx, loaded, destination, mapping, options)).plan;
}

export interface CommitResult {
  plan: ImportPlan;
  import: ImportRecordSummary | null;
  changes: string[];
}

/**
 * Apply an import. Nothing to change (idempotent re-import / sync) -> no import row, `import: null`. Otherwise one
 * imports row is written first, then the destination applies, then provenance and the change log are stored; a
 * failure removes the imports row again (its changes cascade).
 */
export async function commitImport(
  ctx: ImportCtx,
  loaded: LoadedTable,
  destination: ImportDestination,
  mapping: ImportMapping,
  options: ImportOptions,
  syncId: string | null = null,
): Promise<CommitResult> {
  const prepared = await prepare(ctx, loaded, destination, mapping, options);
  if (prepared.noop) return { plan: prepared.plan, import: null, changes: [] };
  const { db, project } = ctx;
  const importId = newId("imp");
  const src = loaded.source;
  await db.insert("imports", {
    id: importId,
    workspace_id: project.workspace_id,
    project_id: project.id,
    source: src.kind,
    source_name: clip(src.name, 300),
    spreadsheet_id: src.spreadsheetId,
    tab: src.tab ? clip(src.tab, 200) : null,
    sheet_tab_id: src.sheetTabId,
    destination,
    trigger: ctx.trigger,
    sync_id: syncId,
    mapping_json: JSON.stringify(mapping),
    options_json: JSON.stringify({ ...options, excludeKeys: (options.excludeKeys ?? []).slice(0, 500) }),
    counts_json: JSON.stringify(prepared.plan.counts),
    changes_json: "[]",
    rows_read: loaded.rowsRead,
    status: "completed",
    created_by: ctx.userId,
    created_at: iso(ctx.now),
  });
  let result;
  try {
    result = await prepared.apply(importId);
  } catch (e) {
    await db.run("DELETE FROM imports WHERE id = ? AND workspace_id = ? AND project_id = ?", importId, project.workspace_id, project.id).catch(() => undefined);
    throw e;
  }
  await writeChanges(db, project, importId, destination, result.changes, ctx.now);
  const lines = result.lines.slice(0, MAX_CHANGE_LINES);
  if (result.lines.length > MAX_CHANGE_LINES) lines.push(`… and ${result.lines.length - MAX_CHANGE_LINES} more`);
  await db.run(
    "UPDATE imports SET changes_json = ? WHERE id = ? AND workspace_id = ? AND project_id = ?",
    JSON.stringify(lines),
    importId,
    project.workspace_id,
    project.id,
  );
  const row = (await loadImport(db, project, importId))!;
  return { plan: prepared.plan, import: toSummary(row, true), changes: lines };
}

async function writeChanges(db: Db, p: ProjectRow, importId: string, destination: ImportDestination, changes: ChangeRow[], now: Date) {
  const stmts: Array<[string, ...unknown[]]> = changes.map((c) => [
    "INSERT INTO import_changes (id, workspace_id, project_id, import_id, destination, record_key, action, prev_json, ref_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    newId("ichg"), p.workspace_id, p.id, importId, destination === "reference" ? "context_doc" : destination, c.key, c.action, c.prev ? JSON.stringify(c.prev) : null, c.refId ?? null, iso(now),
  ]);
  await runBatches(db, stmts);
}

export async function loadImport(db: Db, p: ProjectRow, id: string): Promise<ImportRow | null> {
  return db.first<ImportRow>("SELECT * FROM imports WHERE workspace_id = ? AND project_id = ? AND id = ?", p.workspace_id, p.id, id);
}

const recordDest = (d: ImportDestination) => (d === "reference" ? "context_doc" : d);

/** Undo is offered for the latest completed import of each destination. */
async function latestCompletedIds(db: Db, p: ProjectRow): Promise<Set<string>> {
  const rows = await db.all<{ id: string; destination: string }>(
    `SELECT i.id, i.destination FROM imports i
      WHERE i.workspace_id = ? AND i.project_id = ? AND i.status = 'completed'
        AND i.created_at = (SELECT MAX(j.created_at) FROM imports j WHERE j.workspace_id = i.workspace_id AND j.project_id = i.project_id
                             AND j.status = 'completed' AND (CASE WHEN j.destination = 'reference' THEN 'context_doc' ELSE j.destination END)
                                                         = (CASE WHEN i.destination = 'reference' THEN 'context_doc' ELSE i.destination END))`,
    p.workspace_id,
    p.id,
  );
  return new Set(rows.map((r) => r.id));
}

export function toSummary(r: ImportRow, canUndo: boolean): ImportRecordSummary {
  return {
    id: r.id,
    source: r.source,
    sourceName: r.source_name,
    tab: r.tab,
    destination: r.destination,
    trigger: r.trigger,
    counts: parseJson<Partial<ImportCounts>>(r.counts_json, {}),
    changes: parseJson<unknown[]>(r.changes_json, []).filter((x): x is string => typeof x === "string"),
    rowsRead: Number(r.rows_read),
    status: r.status,
    createdAt: r.created_at,
    undoneAt: r.undone_at,
    canUndo: canUndo && r.status === "completed",
  };
}

export async function listHistory(db: Db, p: ProjectRow): Promise<ImportRecordSummary[]> {
  const rows = await db.all<ImportRow>(
    "SELECT * FROM imports WHERE workspace_id = ? AND project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
    p.workspace_id,
    p.id,
    HISTORY_LIMIT,
  );
  const latest = await latestCompletedIds(db, p);
  return rows.map((r) => toSummary(r, latest.has(r.id)));
}

// ------------------------------------------------------------------ undo
interface ChangeDbRow {
  record_key: string;
  action: "added" | "updated" | "removed";
  prev_json: string | null;
  ref_id: string | null;
}

/**
 * Undo the latest completed import of a destination: rows it created are deleted, records it changed get their
 * previous state back, and the project-level effect is reversed (prompt set, competitors, context doc version).
 */
export async function undoImport(env: Env, db: Db, project: ProjectRow, importId: string, userId: string, now: Date): Promise<ImportRecordSummary> {
  const imp = await loadImport(db, project, importId);
  if (!imp) throw notFound("Import");
  if (imp.status !== "completed") throw conflict("This import was already undone.");
  const latest = await latestCompletedIds(db, project);
  if (!latest.has(imp.id)) throw conflict("Only the latest import of each destination can be undone. Undo the newer one first.");
  const changes = await db.all<ChangeDbRow>(
    "SELECT record_key, action, prev_json, ref_id FROM import_changes WHERE workspace_id = ? AND project_id = ? AND import_id = ?",
    project.workspace_id,
    project.id,
    imp.id,
  );
  const dest = recordDest(imp.destination);
  const lines: string[] = [];

  // Project-level effects first (they read the current state).
  if (imp.destination === "geo_prompts") lines.push(...(await undoPrompts(db, project, imp, changes, now)));
  if (imp.destination === "competitors") lines.push(...(await undoCompetitors(db, project, changes, now)));
  if (dest === "context_doc") {
    await db.run(
      "DELETE FROM context_documents WHERE workspace_id = ? AND project_id = ? AND kind = 'imported' AND import_id = ?",
      project.workspace_id,
      project.id,
      imp.id,
    );
  }

  // Records: created -> deleted; changed -> previous state restored.
  const stmts: Array<[string, ...unknown[]]> = [];
  for (const c of changes) {
    const prev = c.prev_json ? parseJson<RecordRow | null>(c.prev_json, null) : null;
    if (!prev) {
      stmts.push(["DELETE FROM import_records WHERE workspace_id = ? AND project_id = ? AND destination = ? AND record_key = ? AND first_import_id = ?", project.workspace_id, project.id, dest, c.record_key, imp.id]);
    } else {
      stmts.push([
        "UPDATE import_records SET label = ?, status = ?, data_json = ?, source_key = ?, last_import_id = ?, updated_at = ?, removed_at = ? WHERE workspace_id = ? AND project_id = ? AND destination = ? AND record_key = ?",
        prev.label, prev.status, prev.data_json, prev.source_key, prev.last_import_id, prev.updated_at, prev.removed_at, project.workspace_id, project.id, dest, c.record_key,
      ]);
    }
  }
  stmts.push(["UPDATE imports SET status = 'undone', undone_at = ?, undone_by = ? WHERE workspace_id = ? AND project_id = ? AND id = ?", iso(now), userId, project.workspace_id, project.id, imp.id]);
  await runBatches(db, stmts);
  const row = (await loadImport(db, project, imp.id))!;
  const summary = toSummary(row, false);
  if (lines.length) summary.changes = [...summary.changes, ...lines.map((l) => `Undo: ${l}`)];
  return summary;
}

async function undoPrompts(db: Db, project: ProjectRow, imp: ImportRow, changes: ChangeDbRow[], now: Date): Promise<string[]> {
  const setIds = new Set(changes.map((c) => c.ref_id).filter((x): x is string => !!x));
  const addedKeys = new Set(changes.filter((c) => c.action !== "removed" && c.ref_id).map((c) => c.record_key));
  const removed = changes.filter((c) => c.action === "removed").map((c) => parseJson<RecordRow | null>(c.prev_json ?? "", null)).filter((r): r is RecordRow => !!r);
  if (setIds.size === 0) return [];
  const active = await getActivePromptSet(db, project.workspace_id, project.id);
  const setId = [...setIds][0]!;
  if (active && active.id === setId) {
    const used = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM geo_observations WHERE workspace_id = ? AND project_id = ? AND prompt_set_id = ?", project.workspace_id, project.id, setId);
    if (Number(used?.n ?? 0) === 0) {
      // Nothing ran on the imported set yet: remove it and reactivate the previous version.
      await db.batch([
        ["DELETE FROM geo_prompt_sets WHERE workspace_id = ? AND project_id = ? AND id = ?", project.workspace_id, project.id, setId],
        [
          `UPDATE geo_prompt_sets SET active = 1 WHERE workspace_id = ? AND project_id = ? AND version = (
             SELECT MAX(version) FROM geo_prompt_sets WHERE workspace_id = ? AND project_id = ?)`,
          project.workspace_id, project.id, project.workspace_id, project.id,
        ],
      ]);
      return [`prompt set version ${active.version} removed; the previous version is active again`];
    }
  }
  // The set has answers (or was edited since): keep history, save a new version without the imported prompts.
  if (!active) return [];
  const kept: PromptInput[] = active.prompts
    .filter((p) => !addedKeys.has(promptKey(p.text)))
    .map((p) => ({ text: p.text, promptType: p.promptType, stage: p.stage, approved: p.approved }));
  const have = new Set(kept.map((p) => promptKey(p.text)));
  for (const r of removed) {
    if (kept.length >= MAX_PROMPTS_PER_SET || have.has(r.record_key)) continue;
    const data = parseJson<{ promptType?: string }>(r.data_json, {});
    kept.push({ text: r.label, promptType: data.promptType === "reputation" ? "reputation" : "discovery", stage: null, approved: false });
    have.add(r.record_key);
  }
  if (kept.length === active.prompts.length && kept.every((p, i) => p.text === active.prompts[i]!.text)) return [];
  await savePromptSet(db, project, kept, now, { label: `Undo of import ${utcDay(new Date(imp.created_at))}` });
  return ["new prompt-set version without the imported prompts (earlier versions and answers kept)"];
}

async function undoCompetitors(db: Db, project: ProjectRow, changes: ChangeDbRow[], now: Date): Promise<string[]> {
  const fresh = (await loadProjectRow(db, project.workspace_id, project.id)) ?? project;
  const list: Competitor[] = projectCompetitors(fresh).map((c) => ({ ...c, domains: [...c.domains], aliases: [...(c.aliases ?? [])] }));
  const lines: string[] = [];
  for (const c of changes) {
    const prev = c.prev_json ? parseJson<RecordRow | null>(c.prev_json, null) : null;
    if (c.ref_id === COMPETITOR_ADDED) {
      // Tracked by this import: untrack it (a competitor the import created goes when it has no domain left).
      for (let i = 0; i < list.length; i++) {
        const comp = list[i]!;
        const idx = comp.domains.findIndex((d) => targetDomain(d) === c.record_key);
        if (idx < 0) continue;
        comp.domains.splice(idx, 1);
        if (comp.domains.length === 0 && comp.name === c.record_key) {
          list.splice(i, 1);
          i--;
        }
        lines.push(`− ${c.record_key}`);
      }
    } else if (c.action === "removed" && prev?.status === "tracked") {
      if (list.some((comp) => comp.domains.some((d) => targetDomain(d) === c.record_key))) continue;
      if (list.length >= MAX_COMPETITORS) {
        lines.push(`${c.record_key} not re-added: competitor limit (${MAX_COMPETITORS}) reached`);
        continue;
      }
      list.push({ name: c.record_key, domains: [c.record_key], aliases: [] });
      lines.push(`+ ${c.record_key}`);
    }
  }
  if (lines.length) await updateProject(db, fresh, { competitors: list }, now);
  return lines;
}

// ------------------------------------------------------------------ syncs (read model)
export function toSyncSummary(r: SyncRow, lastChanges: string[] = []): ImportSyncSummary {
  return {
    id: r.id,
    spreadsheetId: r.spreadsheet_id,
    spreadsheetTitle: r.spreadsheet_title,
    tab: r.tab,
    destination: r.destination,
    frequencyHours: Number(r.frequency_hours),
    enabled: r.enabled === 1,
    nextRunAt: r.next_run_at,
    lastRunAt: r.last_run_at,
    lastStatus: r.last_status,
    lastErrorCode: r.last_error_code,
    lastError: r.last_error,
    lastWarning: r.last_warning,
    lastChanges,
  };
}

export async function listSyncs(db: Db, p: ProjectRow): Promise<ImportSyncSummary[]> {
  const rows = await db.all<SyncRow>("SELECT * FROM import_syncs WHERE workspace_id = ? AND project_id = ? ORDER BY created_at, id", p.workspace_id, p.id);
  const ids = rows.map((r) => r.last_import_id).filter((x): x is string => !!x).slice(0, 50);
  const changes = new Map<string, string[]>();
  if (ids.length) {
    const imps = await db.all<{ id: string; changes_json: string }>(
      `SELECT id, changes_json FROM imports WHERE workspace_id = ? AND project_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
      p.workspace_id,
      p.id,
      ...ids,
    );
    for (const i of imps) changes.set(i.id, parseJson<unknown[]>(i.changes_json, []).filter((x): x is string => typeof x === "string").slice(0, 30));
  }
  return rows.map((r) => toSyncSummary(r, r.last_import_id ? (changes.get(r.last_import_id) ?? []) : []));
}

/** Failing syncs for the Overview "needs attention" feed. */
export async function failingSyncs(db: Db, p: ProjectRow): Promise<ImportSyncSummary[]> {
  try {
    const rows = await db.all<SyncRow>(
      "SELECT * FROM import_syncs WHERE workspace_id = ? AND project_id = ? AND enabled = 1 AND last_status = 'error' ORDER BY updated_at DESC LIMIT 10",
      p.workspace_id,
      p.id,
    );
    return rows.map((r) => toSyncSummary(r));
  } catch {
    return []; // migration 0015 not applied yet
  }
}

// ------------------------------------------------------------------ overview
export async function importOverview(env: Env, db: Db, p: ProjectRow, canManage: boolean): Promise<ImportOverview> {
  const docs = await db.all<{ id: string; title: string | null; version: number; created_at: string; chars: number }>(
    `SELECT d.id, d.title, d.version, d.created_at, LENGTH(d.content) AS chars FROM context_documents d
      WHERE d.workspace_id = ? AND d.project_id = ? AND d.kind = 'imported'
        AND d.version = (SELECT MAX(d2.version) FROM context_documents d2 WHERE d2.workspace_id = d.workspace_id AND d2.project_id = d.project_id
                          AND d2.kind = 'imported' AND d2.doc_key = d.doc_key)
      ORDER BY d.created_at DESC LIMIT 100`,
    p.workspace_id,
    p.id,
  );
  return {
    canManage,
    sheets: await sheetsStatus(env, db, p),
    history: await listHistory(db, p),
    syncs: await listSyncs(db, p),
    documents: docs.map((d) => ({ id: d.id, title: d.title ?? "Imported document", version: Number(d.version), createdAt: d.created_at, chars: Number(d.chars) })),
    limits: { maxCsvBytes: MAX_CSV_BYTES, maxRows: MAX_IMPORT_ROWS, docMaxRows: CONTEXT_DOC_MAX_ROWS, docMaxChars: CONTEXT_DOC_MAX_CHARS },
  };
}

// ------------------------------------------------------------------ read models for other pages
async function activeRecords(db: Db, p: ProjectRow, destination: string): Promise<RecordRow[]> {
  try {
    return await db.all<RecordRow>(
      "SELECT * FROM import_records WHERE workspace_id = ? AND project_id = ? AND destination = ? ORDER BY created_at, rowid LIMIT 2000",
      p.workspace_id,
      p.id,
      destination,
    );
  } catch {
    return []; // migration 0015 not applied yet
  }
}

/** Source -> target pairs (normalized URL keys) recorded as placed per the sheet; the suggester skips them. */
export async function placedLinkPairs(db: Db, p: ProjectRow): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const r of await activeRecords(db, p, "implemented_links")) {
    if (r.status !== "placed") continue;
    const d = parseJson<{ source?: string; target?: string }>(r.data_json, {});
    if (d.source && d.target) out.set(`${normalizeUrlKey(d.source)}>${normalizeUrlKey(d.target)}`, r.created_at);
  }
  return out;
}

/** Links placed per the sheet, each checked against the latest crawl's internal links of its source page. */
export async function importedLinksReport(db: Db, p: ProjectRow): Promise<ImportedLinksReport> {
  const recs = (await activeRecords(db, p, "implemented_links")).filter((r) => r.status === "placed" || r.status === "removed_from_sheet");
  const crawl = await db.first<{ id: string; started_at: string }>(
    `SELECT id, started_at FROM crawl_runs WHERE workspace_id = ? AND project_id = ? AND status IN ('completed', 'partial')
      ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    p.workspace_id,
    p.id,
  );
  const linksBySource = new Map<string, Set<string>>();
  if (crawl && recs.length) {
    const snaps = await db.all<{ url: string; final_url: string | null; internal_links_json: string }>(
      `SELECT pg.url, s.final_url, s.internal_links_json FROM page_snapshots s JOIN pages pg ON pg.id = s.page_id AND pg.workspace_id = s.workspace_id
        WHERE s.workspace_id = ? AND s.project_id = ? AND s.crawl_run_id = ?`,
      p.workspace_id,
      p.id,
      crawl.id,
    );
    for (const s of snaps) {
      const links = new Set(parseJson<unknown[]>(s.internal_links_json, []).filter((x): x is string => typeof x === "string").map((u) => normalizeUrlKey(u)));
      linksBySource.set(normalizeUrlKey(s.url), links);
      if (s.final_url) linksBySource.set(normalizeUrlKey(s.final_url), links);
    }
  }
  const links: ImportedLinkStatus[] = recs.slice(0, 1000).map((r) => {
    const d = parseJson<{ source?: string; target?: string; anchor?: string | null; date?: string | null }>(r.data_json, {});
    const source = d.source ?? "";
    const target = d.target ?? "";
    let state: ImportedLinkStatus["crawl"] = "no_crawl";
    if (crawl) {
      const set = linksBySource.get(normalizeUrlKey(source));
      state = !set ? "source_not_crawled" : set.has(normalizeUrlKey(target)) ? "found" : "not_found";
    }
    return {
      key: r.record_key,
      sourceUrl: source,
      targetUrl: target,
      anchor: d.anchor ?? null,
      placedOn: d.date ?? null,
      status: r.status === "removed_from_sheet" ? "removed_from_sheet" : "placed",
      crawl: state,
      importedAt: r.created_at,
    };
  });
  const refs = await db.all<{ id: string; title: string | null; created_at: string }>(
    `SELECT d.id, d.title, d.created_at FROM context_documents d
      WHERE d.workspace_id = ? AND d.project_id = ? AND d.kind = 'imported' AND (LOWER(d.title) LIKE '%internal%link%' OR LOWER(d.title) LIKE '%orphan%')
        AND d.version = (SELECT MAX(d2.version) FROM context_documents d2 WHERE d2.workspace_id = d.workspace_id AND d2.project_id = d.project_id
                          AND d2.kind = 'imported' AND d2.doc_key = d.doc_key)
      ORDER BY d.created_at DESC LIMIT 10`,
    p.workspace_id,
    p.id,
  );
  return { crawlStartedAt: crawl?.started_at ?? null, links, total: recs.length, references: refs.map((r) => ({ id: r.id, title: r.title ?? "Imported reference", createdAt: r.created_at })) };
}

/** Sheet metrics per competitor domain ("from your sheet (third-party tool)"). */
export async function importedCompetitors(db: Db, p: ProjectRow): Promise<ImportedCompetitorRow[]> {
  return (await activeRecords(db, p, "competitors")).map((r) => {
    const d = parseJson<{ notes?: string | null; assignedTo?: string | null; metrics?: Record<string, string> }>(r.data_json, {});
    return {
      domain: r.record_key,
      status: (r.status as ImportedCompetitorRow["status"]) ?? "tracked",
      notes: d.notes ?? null,
      assignedTo: d.assignedTo ?? null,
      metrics: d.metrics ?? {},
      importedAt: r.updated_at,
      removedAt: r.removed_at,
    };
  });
}

/** Reference notes per prompt key ("from your sheet, not measured by Okara"). */
export async function importedPromptNotes(db: Db, p: ProjectRow): Promise<Array<{ key: string; text: string; status: string; notes: Record<string, string>; done: string | null; importedAt: string }>> {
  return (await activeRecords(db, p, "geo_prompts")).map((r) => {
    const d = parseJson<{ notes?: Record<string, string>; done?: string | null }>(r.data_json, {});
    return { key: r.record_key, text: r.label, status: r.status, notes: d.notes ?? {}, done: d.done ?? null, importedAt: r.updated_at };
  });
}

