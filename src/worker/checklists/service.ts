/**
 * [A21] Checklist service: load project data (workspace-scoped), evaluate the registry, merge manual
 * answers, and persist manual check-offs. Only items whose evaluated method is "manual" accept a
 * check-off; measured and heuristic items are recomputed from data on every request.
 */
import type { CapabilityState, Checklist, ChecklistItem } from "@shared/types";
import type { Env } from "../env";
import type { Db } from "../lib/db";
import { badRequest, notFound } from "../lib/errors";
import { iso } from "../lib/time";
import type { ProjectRow } from "../platform/access";
import { normalizeUrlKey } from "../seo/rules/registry";
import {
  crawlAllowed,
  EMPTY_GEO,
  loadChecklistData,
  loadCrawl,
  loadDecisions,
  loadGsc,
  projectInfo,
  SNAPSHOT_COLUMNS,
  type ChecklistData,
  type SnapshotRow,
  toSnap,
} from "./data";
import type { ItemDef } from "./items/common";
import { candidateUrl, PAGE_ITEMS, type PageContext } from "./items/page";
import { assembleChecklist, evaluateItem, ITEMS_BY_KIND, type ManualState } from "./registry";
import { Signals } from "./signals";

export type ProjectChecklistKind = "seo" | "geo";

export interface ManualInput {
  checked: boolean;
  note?: string | null;
}

function projectState(d: ChecklistData): CapabilityState {
  if (d.project.isDemo) return "demo";
  if (!d.crawl && !d.gsc.sync && d.geo.observations.length === 0) return "setup_required";
  return "ready";
}

async function loadManual(db: Db, ws: string, pid: string, kind: "seo" | "geo" | "page", pageId?: string): Promise<Map<string, ManualState>> {
  const rows = await db.all<{ item_id: string; checked: number; note: string | null; updated_at: string; name: string | null; email: string | null; updated_by: string | null }>(
    `SELECT m.item_id, m.checked, m.note, m.updated_at, m.updated_by, u.name, u.email
       FROM checklist_manual m LEFT JOIN users u ON u.id = m.updated_by
      WHERE m.workspace_id = ? AND m.project_id = ? AND m.kind = ?${pageId ? " AND m.page_id = ?" : ""}`,
    ...(pageId ? [ws, pid, kind, pageId] : [ws, pid, kind]),
  );
  const prefix = pageId ? `${pageId}:` : "";
  const out = new Map<string, ManualState>();
  for (const r of rows) {
    if (prefix && !r.item_id.startsWith(prefix)) continue;
    out.set(r.item_id.slice(prefix.length), {
      checked: r.checked === 1,
      note: r.note,
      updatedAt: r.updated_at,
      updatedBy: r.name || r.email || r.updated_by,
    });
  }
  return out;
}

async function upsertManual(
  db: Db,
  row: { ws: string; pid: string; kind: "seo" | "geo" | "page"; itemId: string; pageId: string | null; checked: boolean; note: string | null; userId: string; now: Date },
): Promise<void> {
  await db.run(
    `INSERT INTO checklist_manual (workspace_id, project_id, kind, item_id, page_id, checked, note, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, kind, item_id) DO UPDATE SET
       checked = excluded.checked, note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at
     WHERE checklist_manual.workspace_id = excluded.workspace_id`,
    row.ws,
    row.pid,
    row.kind,
    row.itemId,
    row.pageId,
    row.checked ? 1 : 0,
    row.note,
    row.userId,
    iso(row.now),
  );
}

function normalizeNote(note: string | null | undefined): string | null {
  const t = (note ?? "").trim();
  return t ? t : null;
}

// ------------------------------------------------------------------ project checklists (seo | geo)
export async function getProjectChecklist(env: Env, db: Db, project: ProjectRow, kind: ProjectChecklistKind, now: Date): Promise<Checklist> {
  const data = await loadChecklistData(env, db, project, now);
  const manual = await loadManual(db, project.workspace_id, project.id, kind);
  return assembleChecklist({
    kind,
    defs: ITEMS_BY_KIND[kind],
    ctx: new Signals(data),
    manual,
    state: projectState(data),
    now,
    sources: {
      crawlRunId: data.crawl?.id ?? null,
      crawledAt: data.crawl ? (data.crawl.finishedAt ?? data.crawl.startedAt) : null,
      gscSyncedAt: data.gsc.sync?.syncedAt ?? null,
      geoObservations: data.geo.observations.length,
    },
  });
}

export async function putProjectManual(
  env: Env,
  db: Db,
  project: ProjectRow,
  kind: ProjectChecklistKind,
  itemId: string,
  input: ManualInput,
  userId: string,
  now: Date,
): Promise<ChecklistItem> {
  const def = ITEMS_BY_KIND[kind].find((d) => d.id === itemId);
  if (!def) throw notFound("Checklist item");
  const data = await loadChecklistData(env, db, project, now);
  const ctx = new Signals(data);
  const current = evaluateItem(def, ctx, undefined, kind);
  if (!current.manual) throw badRequest(manualOnlyMessage(current));
  await upsertManual(db, { ws: project.workspace_id, pid: project.id, kind, itemId, pageId: null, checked: input.checked, note: normalizeNote(input.note), userId, now });
  const manual = await loadManual(db, project.workspace_id, project.id, kind);
  return evaluateItem(def, ctx, manual.get(itemId), kind);
}

function manualOnlyMessage(item: ChecklistItem): string {
  if (item.status === "not_applicable") return "This item does not apply to this project, so it cannot be checked off.";
  return `Only manual items can be checked off; "${item.label}" is ${item.method} from project data (status: ${item.status}).`;
}

// ------------------------------------------------------------------ per-page checklist
async function loadPageContext(env: Env, db: Db, project: ProjectRow, pageId: string, now: Date): Promise<{ ctx: PageContext; data: ChecklistData; citedBy: number }> {
  const ws = project.workspace_id;
  const pid = project.id;
  const page = await db.first<{ id: string; url: string; page_type: PageContext["page"]["pageType"] }>(
    "SELECT id, url, page_type FROM pages WHERE workspace_id = ? AND project_id = ? AND id = ?",
    ws,
    pid,
    pageId,
  );
  if (!page) throw notFound("Page");
  const snapRow = crawlAllowed(project)
    ? await db.first<SnapshotRow>(
        `SELECT ${SNAPSHOT_COLUMNS}
           FROM page_snapshots s JOIN pages p ON p.id = s.page_id AND p.workspace_id = s.workspace_id
          WHERE s.workspace_id = ? AND s.project_id = ? AND s.page_id = ?
          ORDER BY s.fetched_at DESC, s.rowid DESC LIMIT 1`,
        ws,
        pid,
        page.id,
      )
    : null;
  const snap = snapRow ? toSnap(snapRow) : null;
  const [crawl, gsc, decisions] = await Promise.all([
    snap ? loadCrawl(db, ws, pid, snap.crawlRunId) : Promise.resolve({ crawl: null, snapshots: [], findings: [] }),
    loadGsc(db, ws, pid),
    loadDecisions(db, ws, pid),
  ]);
  const data: ChecklistData = {
    now,
    project: projectInfo(project),
    crawl: crawl.crawl,
    snapshots: crawl.snapshots,
    findings: crawl.findings,
    gsc,
    geo: EMPTY_GEO,
    decisions,
    pillars: null,
  };
  const sig = new Signals(data);
  const key = normalizeUrlKey(page.url);
  const intent = decisions.find((d) => {
    if (d.questionId !== "seo.intent_page_fit") return false;
    const u = candidateUrl(d.candidate);
    return !!u && normalizeUrlKey(u) === key;
  });
  const cited = await db.all<{ observation_id: string; url: string }>(
    "SELECT observation_id, url FROM geo_citations WHERE workspace_id = ? AND project_id = ? AND brand_key = 'self'",
    ws,
    pid,
  );
  const citedBy = new Set(cited.filter((c) => normalizeUrlKey(c.url) === key).map((c) => c.observation_id)).size;
  return {
    ctx: { sig, page: { id: page.id, url: page.url, pageType: page.page_type }, snap, queries: sig.queriesForPage(page.url), intent: intent ?? null },
    data,
    citedBy,
  };
}

export async function getPageChecklist(env: Env, db: Db, project: ProjectRow, pageId: string, now: Date): Promise<Checklist> {
  const { ctx, data, citedBy } = await loadPageContext(env, db, project, pageId, now);
  const manual = await loadManual(db, project.workspace_id, project.id, "page", pageId);
  const state: CapabilityState = data.project.isDemo ? "demo" : ctx.snap ? "ready" : "setup_required";
  return assembleChecklist({
    kind: "page",
    defs: PAGE_ITEMS,
    ctx,
    manual,
    state,
    now,
    sources: { crawlRunId: ctx.snap?.crawlRunId ?? null, crawledAt: ctx.snap?.fetchedAt ?? null, gscSyncedAt: data.gsc.sync?.syncedAt ?? null, geoObservations: citedBy },
    page: { id: ctx.page.id, url: ctx.page.url, pageType: ctx.page.pageType, snapshotAt: ctx.snap?.fetchedAt ?? null, topQuery: ctx.queries[0]?.query ?? null },
  });
}

export async function putPageManual(
  env: Env,
  db: Db,
  project: ProjectRow,
  pageId: string,
  itemId: string,
  input: ManualInput,
  userId: string,
  now: Date,
): Promise<ChecklistItem> {
  const def = (PAGE_ITEMS as readonly ItemDef<PageContext>[]).find((d) => d.id === itemId);
  if (!def) throw notFound("Checklist item");
  const { ctx } = await loadPageContext(env, db, project, pageId, now);
  const current = evaluateItem(def, ctx, undefined, "page");
  if (!current.manual) throw badRequest(manualOnlyMessage(current));
  await upsertManual(db, {
    ws: project.workspace_id,
    pid: project.id,
    kind: "page",
    itemId: `${pageId}:${itemId}`,
    pageId,
    checked: input.checked,
    note: normalizeNote(input.note),
    userId,
    now,
  });
  const manual = await loadManual(db, project.workspace_id, project.id, "page", pageId);
  return evaluateItem(def, ctx, manual.get(itemId), "page");
}
