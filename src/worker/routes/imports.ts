/**
 * Import (Google Sheets / CSV) routes. docs/api.md "Import (Google Sheets / CSV)".
 *   GET    /projects/:pid/import                         member; ImportOverview (connection, history, syncs, documents)
 *   GET    /projects/:pid/import/links                   member; ImportedLinksReport (placed per sheet + crawl check)
 *   GET    /projects/:pid/import/records/:destination    member; sheet reference rows (competitors | geo_prompts)
 *   GET    /projects/:pid/import/sheets/connect          owner; redirect to Google consent (spreadsheets.readonly only)
 *   DELETE /projects/:pid/import/sheets                  owner; delete the stored Sheets token (local only)
 *   POST   /projects/:pid/import/sheets/tabs             owner; {spreadsheet: url|id} -> SheetTabsResult
 *   POST   /projects/:pid/import/sheets/preview          owner; {spreadsheetId, tabs[]} -> TabPreview[] (first 20 rows)
 *   POST   /projects/:pid/import/dry-run                 owner; {source, destination, mapping, options} -> ImportPlan
 *   POST   /projects/:pid/import/commit                  owner; same + keepInSync? -> CommitResult (+ sync)
 *   POST   /projects/:pid/import/:importId/undo          owner; undo the latest import of its destination
 *   PATCH  /projects/:pid/import/syncs/:syncId           owner; {enabled?, frequencyHours?}
 *   POST   /projects/:pid/import/syncs/:syncId/run       owner; Sync now (rate-limited)
 *   DELETE /projects/:pid/import/syncs/:syncId           owner; stop syncing (imported data is kept)
 * Writes pass the global CSRF middleware (app.ts); reads/writes resolve the project with requireProject() and every
 * query filters by workspace_id. Untrusted cell text is returned as data only (the UI renders plain text).
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  IMPORT_DESTINATIONS,
  MAX_CSV_BYTES,
  PREVIEW_ROWS,
  SYNCABLE_DESTINATIONS,
  SYNC_FREQUENCIES,
  extractSpreadsheetId,
  suggestDestination,
  toTable,
  type ImportDestination,
  type ImportMapping,
  type ImportOptions,
  type ImportSourceInput,
  type TabPreview,
} from "@shared/import";
import type { AppEnv } from "../app";
import type { Env } from "../env";
import type { ImportSyncSummary } from "@shared/import";
import type { Db } from "../lib/db";
import { HttpError, badRequest, notFound, unauthorized } from "../lib/errors";
import { requireProject, requireWorkspaceMember, requireWorkspaceOwner, type ProjectRow, type SessionUser } from "../platform/access";
import { gscOAuthConfigured } from "../platform/gsc-oauth";
import { hitRateLimit } from "../platform/rate-limit";
import { backgroundScheduler } from "./competitor-data";
import type { ImportCtx } from "../imports/destinations";
import {
  commitImport,
  dryRun,
  importOverview,
  importedCompetitors,
  importedLinksReport,
  importedPromptNotes,
  listSyncs,
  undoImport,
} from "../imports/service";
import { disconnectSheets, importPath, startSheetsConnect, type SheetsClient } from "../imports/sheets";
import { loadTable, sheetsClientFor, sheetsHttpError, type SourceDeps } from "../imports/source";
import { loadSync, runSync, SYNC_NOW_PER_HOUR, toSyncSummary, upsertSync, validFrequency } from "../imports/sync";

export const importRoutes = new Hono<AppEnv>();

/** Test hook: inject the Sheets client used by the routes (null = not connected; undefined = real client). */
let sheetsOverride: SheetsClient | null | undefined;
export function setImportSheetsClient(c: SheetsClient | null | undefined) {
  sheetsOverride = c;
}
const sourceDeps = (): SourceDeps => (sheetsOverride === undefined ? {} : { sheets: sheetsOverride });

export const IMPORT_RATE_LIMITS = {
  sheetsRead: { limit: 30, windowSeconds: 60 },
  dryRun: { limit: 30, windowSeconds: 60 },
  commit: { limit: 10, windowSeconds: 60 },
} as const;
/** JSON body cap for dry-run/commit (a 10 MB CSV as a JSON string, escaped). */
export const IMPORT_MAX_BODY_BYTES = MAX_CSV_BYTES * 2 + 64 * 1024;

function userOf(c: Context<AppEnv>): SessionUser {
  const u = c.get("user");
  if (!u) throw unauthorized();
  return u;
}

async function access(c: Context<AppEnv>): Promise<{ user: SessionUser; db: Db; row: ProjectRow; owner: boolean }> {
  const user = userOf(c);
  const db = c.get("db");
  const row = await requireProject(db, user.id, c.req.param("pid") ?? "");
  const { role } = await requireWorkspaceMember(db, user.id, row.workspace_id);
  return { user, db, row, owner: role === "owner" };
}

async function ownerAccess(c: Context<AppEnv>) {
  const a = await access(c);
  if (!a.owner) await requireWorkspaceOwner(a.db, a.user.id, a.row.workspace_id);
  return a;
}

async function limit(c: Context<AppEnv>, key: string, l: { limit: number; windowSeconds: number }) {
  const r = await hitRateLimit(c.get("db"), key.slice(0, 300), l.limit, l.windowSeconds, c.get("now"));
  if (!r.allowed) throw new HttpError(429, "rate_limited", "Too many import requests. Try again shortly.", { retryAfterSeconds: r.retryAfterSeconds });
}

async function body<T>(c: Context<AppEnv>, schema: z.ZodType<T>, max = 16 * 1024): Promise<T> {
  const declared = Number(c.req.header("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > max) throw new HttpError(413, "payload_too_large", "Request body is too large.");
  const text = await c.req.text();
  if (text.length > max) throw new HttpError(413, "payload_too_large", "Request body is too large.");
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw badRequest("Request body must be JSON.");
  }
  const r = schema.safeParse(json);
  if (!r.success) throw badRequest("Invalid request body.", r.error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })));
  return r.data;
}

// ------------------------------------------------------------------ schemas
const col = z.string().trim().min(1).max(200);
const optCol = col.nullish().transform((v) => v ?? null);
const promptsMapping = z.object({ question: col, done: optCol, notes: z.array(col).max(50).optional() }).strict();
const competitorsMapping = z.object({ domain: col, notes: optCol, assignedTo: optCol, metrics: z.array(col).max(50).optional() }).strict();
const linksMapping = z.object({ source: col, target: col, anchor: optCol, date: optCol, method: optCol, hub: optCol, status: optCol }).strict();
const backlinksMapping = z
  .object({ liveUrl: col, target: col, anchor: optCol, target2: optCol, anchor2: optCol, vendor: optCol, type: optCol, date: optCol, da: optCol, traffic: optCol, price: optCol })
  .strict();
const docMapping = z.object({ columns: z.array(col).max(100).optional(), sortBy: optCol, title: z.string().trim().max(120).nullish() }).strict();

const sourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("csv"), name: z.string().max(200).default("Pasted cells"), text: z.string().min(1).max(MAX_CSV_BYTES) }).strict(),
  z.object({ kind: z.literal("sheets"), spreadsheetId: z.string().regex(/^[a-zA-Z0-9_-]{20,100}$/, "Invalid spreadsheet id."), tab: z.string().min(1).max(200) }).strict(),
]);
const optionsSchema = z
  .object({
    approvePrompts: z.boolean().optional(),
    addCompetitors: z.array(z.string().trim().min(1).max(120)).max(10).optional(),
    excludeKeys: z.array(z.string().max(1200)).max(5000).optional(),
    fetchCompetitorData: z.boolean().optional(),
    acceptDomainFixes: z.array(z.string().trim().min(1).max(253)).max(500).optional(),
  })
  .strict()
  .default({});

const importBody = z
  .object({
    source: sourceSchema,
    destination: z.enum(IMPORT_DESTINATIONS as unknown as [ImportDestination, ...ImportDestination[]]),
    mapping: z.unknown(),
    options: optionsSchema,
    keepInSync: z.object({ frequencyHours: z.number().int() }).strict().nullish(),
  })
  .strict();

function parseMapping(destination: ImportDestination, raw: unknown): ImportMapping {
  const schema =
    destination === "geo_prompts"
      ? promptsMapping
      : destination === "competitors"
        ? competitorsMapping
        : destination === "implemented_links"
          ? linksMapping
          : destination === "backlinks"
            ? backlinksMapping
            : docMapping;
  const r = (schema as z.ZodType<ImportMapping>).safeParse(raw ?? {});
  if (!r.success) throw badRequest("Invalid column mapping.", r.error.issues.slice(0, 10).map((i) => ({ path: `mapping.${i.path.join(".")}`, message: i.message })));
  return r.data;
}

function ctxFor(c: Context<AppEnv>, row: ProjectRow, user: SessionUser): ImportCtx {
  return { env: c.env, db: c.get("db"), project: row, now: c.get("now"), userId: user.id, trigger: "manual", removeMissing: false, schedule: backgroundScheduler(c) };
}

// ------------------------------------------------------------------ reads
importRoutes.get("/projects/:pid/import", async (c) => {
  const { db, row, owner } = await access(c);
  return c.json({ data: await importOverview(c.env, db, row, owner) });
});

importRoutes.get("/projects/:pid/import/links", async (c) => {
  const { db, row } = await access(c);
  return c.json({ data: await importedLinksReport(db, row) });
});

importRoutes.get("/projects/:pid/import/records/:destination", async (c) => {
  const { db, row } = await access(c);
  const d = c.req.param("destination");
  if (d === "competitors") return c.json({ data: await importedCompetitors(db, row) });
  if (d === "geo_prompts") return c.json({ data: await importedPromptNotes(db, row) });
  throw badRequest("destination must be competitors or geo_prompts.");
});

// ------------------------------------------------------------------ Sheets connection
importRoutes.get("/projects/:pid/import/sheets/connect", async (c) => {
  const { db, row, user } = await ownerAccess(c);
  const session = c.get("session");
  if (!session) throw unauthorized();
  if (row.is_demo === 1) return c.redirect(`${importPath(row.id)}?sheetsError=demo_project`, 302);
  if (!gscOAuthConfigured(c.env)) return c.redirect(`${importPath(row.id)}?sheetsError=setup_required`, 302);
  const url = await startSheetsConnect(c.env, db, { user, sessionId: session.id, workspaceId: row.workspace_id, projectId: row.id, now: c.get("now") });
  c.header("Cache-Control", "no-store");
  return c.redirect(url, 302);
});

importRoutes.delete("/projects/:pid/import/sheets", async (c) => {
  const { db, row } = await ownerAccess(c);
  await disconnectSheets(db, row.workspace_id, row.id);
  return c.json({ data: { ok: true } });
});

importRoutes.post("/projects/:pid/import/sheets/tabs", async (c) => {
  const { db, row, user } = await ownerAccess(c);
  await limit(c, `import_sheets:${row.id}:${user.id}`, IMPORT_RATE_LIMITS.sheetsRead);
  const { spreadsheet } = await body(c, z.object({ spreadsheet: z.string().trim().min(1).max(2048) }).strict());
  const id = extractSpreadsheetId(spreadsheet);
  if (!id) throw badRequest("Paste a Google Sheets link (https://docs.google.com/spreadsheets/d/...) or a spreadsheet id.");
  const client = await sheetsClientFor(c.env, db, row, sourceDeps());
  try {
    return c.json({ data: await client.getSpreadsheet(id) });
  } catch (e) {
    throw sheetsHttpError(e);
  }
});

importRoutes.post("/projects/:pid/import/sheets/preview", async (c) => {
  const { db, row, user } = await ownerAccess(c);
  await limit(c, `import_sheets:${row.id}:${user.id}`, IMPORT_RATE_LIMITS.sheetsRead);
  const input = await body(c, z.object({ spreadsheetId: z.string().regex(/^[a-zA-Z0-9_-]{20,100}$/), tabs: z.array(z.string().min(1).max(200)).min(1).max(10) }).strict());
  const client = await sheetsClientFor(c.env, db, row, sourceDeps());
  const out: TabPreview[] = [];
  try {
    for (const tab of input.tabs) {
      const values = await client.getValues(input.spreadsheetId, tab, PREVIEW_ROWS);
      const t = toTable(values);
      out.push({ tab, headers: t.headers, rows: t.rows.slice(0, PREVIEW_ROWS), rowsRead: t.rows.length, suggestion: suggestDestination(tab, t.headers) });
    }
  } catch (e) {
    throw sheetsHttpError(e);
  }
  return c.json({ data: out });
});

// ------------------------------------------------------------------ dry run + commit
importRoutes.post("/projects/:pid/import/dry-run", async (c) => {
  const { db, row, user } = await ownerAccess(c);
  await limit(c, `import_dry:${row.id}:${user.id}`, IMPORT_RATE_LIMITS.dryRun);
  const input = await body(c, importBody, IMPORT_MAX_BODY_BYTES);
  const mapping = parseMapping(input.destination, input.mapping);
  const loaded = await loadTable(c.env, db, row, input.source as ImportSourceInput, input.destination, sourceDeps());
  return c.json({ data: await dryRun(ctxFor(c, row, user), loaded, input.destination, mapping, input.options as ImportOptions) });
});

importRoutes.post("/projects/:pid/import/commit", async (c) => {
  const { db, row, user } = await ownerAccess(c);
  if (row.is_demo === 1) throw badRequest("Demo projects cannot import data.");
  await limit(c, `import_commit:${row.id}:${user.id}`, IMPORT_RATE_LIMITS.commit);
  const input = await body(c, importBody, IMPORT_MAX_BODY_BYTES);
  const mapping = parseMapping(input.destination, input.mapping);
  const options = input.options as ImportOptions;
  if (input.keepInSync) {
    if (input.source.kind !== "sheets") throw badRequest("Keep in sync needs the Google Sheets source (a CSV is a one-time copy).");
    if (!SYNCABLE_DESTINATIONS.includes(input.destination)) throw badRequest("Keep in sync is available for competitors, GEO prompts, placed links and backlinks.");
    if (!validFrequency(input.keepInSync.frequencyHours)) throw badRequest(`frequencyHours must be one of ${SYNC_FREQUENCIES.join(", ")}.`);
  }
  const loaded = await loadTable(c.env, db, row, input.source as ImportSourceInput, input.destination, sourceDeps());
  const result = await commitImport(ctxFor(c, row, user), loaded, input.destination, mapping, options);
  let sync = null;
  if (input.keepInSync && loaded.source.kind === "sheets" && loaded.source.spreadsheetId) {
    const s = await upsertSync(db, row, {
      spreadsheetId: loaded.source.spreadsheetId,
      spreadsheetTitle: loaded.source.name,
      tab: loaded.source.tab ?? input.source.kind,
      sheetTabId: loaded.source.sheetTabId,
      destination: input.destination,
      mapping,
      options,
      frequencyHours: input.keepInSync.frequencyHours,
      userId: user.id,
      now: c.get("now"),
      lastImportId: result.import?.id ?? null,
    });
    sync = toSyncSummary(s, result.changes);
  }
  return c.json({ data: { ...result, sync } }, result.import ? 201 : 200);
});

importRoutes.post("/projects/:pid/import/:importId/undo", async (c) => {
  const { db, row, user } = await ownerAccess(c);
  await limit(c, `import_commit:${row.id}:${user.id}`, IMPORT_RATE_LIMITS.commit);
  return c.json({ data: await undoImport(c.env, db, row, c.req.param("importId") ?? "", user.id, c.get("now")) });
});

// ------------------------------------------------------------------ syncs
importRoutes.patch("/projects/:pid/import/syncs/:syncId", async (c) => {
  const { db, row } = await ownerAccess(c);
  const input = await body(c, z.object({ enabled: z.boolean().optional(), frequencyHours: z.number().int().optional() }).strict());
  return c.json({ data: await patchSyncFor(db, row, c.req.param("syncId") ?? "", input, c.get("now")) });
});

/** Enable/disable a sync or change its frequency (route PATCH and Ask Okara). Caller enforces owner. 404 outside the project. */
export async function patchSyncFor(db: Db, row: ProjectRow, syncId: string, input: { enabled?: boolean; frequencyHours?: number }, now: Date): Promise<ImportSyncSummary> {
  const sync = await loadSync(db, row, syncId);
  if (!sync) throw notFound("Sync");
  if (input.frequencyHours !== undefined && !validFrequency(input.frequencyHours)) throw badRequest(`frequencyHours must be one of ${SYNC_FREQUENCIES.join(", ")}.`);
  const freq = input.frequencyHours ?? sync.frequency_hours;
  const enabled = input.enabled ?? sync.enabled === 1;
  await db.run(
    "UPDATE import_syncs SET enabled = ?, frequency_hours = ?, next_run_at = ?, updated_at = ? WHERE workspace_id = ? AND project_id = ? AND id = ?",
    enabled ? 1 : 0,
    freq,
    new Date(now.getTime() + freq * 3600_000).toISOString(),
    now.toISOString(),
    row.workspace_id,
    row.id,
    sync.id,
  );
  return (await listSyncs(db, row)).find((s) => s.id === sync.id)!;
}

importRoutes.post("/projects/:pid/import/syncs/:syncId/run", async (c) => {
  const { db, row, user } = await ownerAccess(c);
  return c.json({ data: await runSyncNowFor(c.env, db, row, c.req.param("syncId") ?? "", user.id, c.get("now"), backgroundScheduler(c)) });
});

/** Sync now (route POST .../run and Ask Okara): SYNC_NOW_PER_HOUR per sync (429). Caller enforces owner. */
export async function runSyncNowFor(env: Env, db: Db, row: ProjectRow, syncId: string, userId: string, now: Date, schedule?: (p: Promise<unknown>) => void) {
  const sync = await loadSync(db, row, syncId);
  if (!sync) throw notFound("Sync");
  const r = await hitRateLimit(db, `import_sync_now:${sync.id}`.slice(0, 300), SYNC_NOW_PER_HOUR, 3600, now);
  if (!r.allowed) throw new HttpError(429, "rate_limited", "Too many import requests. Try again shortly.", { retryAfterSeconds: r.retryAfterSeconds });
  const outcome = await runSync(env, db, sync, now, userId, { ...sourceDeps(), schedule });
  const fresh = (await listSyncs(db, row)).find((s) => s.id === sync.id)!;
  return { outcome: { status: outcome.status, code: outcome.code, message: outcome.message, warning: outcome.warning, changes: outcome.result?.changes ?? [], import: outcome.result?.import ?? null }, sync: fresh };
}

importRoutes.delete("/projects/:pid/import/syncs/:syncId", async (c) => {
  const { db, row } = await ownerAccess(c);
  const res = await db.run("DELETE FROM import_syncs WHERE workspace_id = ? AND project_id = ? AND id = ?", row.workspace_id, row.id, c.req.param("syncId") ?? "");
  if (res.changes !== 1) throw notFound("Sync");
  return c.json({ data: { ok: true } });
});
