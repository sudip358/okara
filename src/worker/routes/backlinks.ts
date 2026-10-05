/**
 * Backlink monitor routes (docs/api.md "Backlinks", docs/build-kit.md [A38]).
 *   GET  /projects/:pid/backlinks                 member; list (filters status/vendor/type/changed/q, sort, paging); ?format=csv
 *   GET  /projects/:pid/backlinks/summary         member; counts per status, dofollow n of m, changes 7/30 d, last/next check, job
 *   GET  /projects/:pid/backlinks/events          member; changes since ?since= (default 30 days), ?negative=1
 *   GET  /projects/:pid/backlinks/feed            member; the running (or latest) job and its latest checks (?after=, ?limit=0-50)
 *   GET  /projects/:pid/backlinks/:id             member; one backlink with its check history and events
 *   POST /projects/:pid/backlinks/check           member; {ids?} -> 202 {job, existing} (manual all: 3/day; ids: 30 rows/hour)
 *   POST /projects/:pid/backlinks/check/advance   member; {after?} -> one more lease-guarded batch of the running job + feed
 * Tenancy: requireProject() (404 for non-members) and every query filters by workspace_id. Writes pass the global CSRF
 * middleware. Owners and members may run checks, like agent runs. Untrusted page and sheet text is returned as data only.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { BACKLINK_STATUSES, MAX_RECHECK_IDS, type BacklinkFilterStatus } from "@shared/backlinks";
import type { AppEnv } from "../app";
import { HttpError, badRequest, unauthorized } from "../lib/errors";
import { requireProject, type SessionUser } from "../platform/access";
import { hitRateLimit } from "../platform/rate-limit";
import { backgroundScheduler } from "./competitor-data";
import {
  advanceBacklinkCheck,
  backlinkDetail,
  backlinkEvents,
  backlinkFeed,
  backlinkSummary,
  backlinksCsv,
  listBacklinks,
  startBacklinkCheck,
  type BacklinkSort,
  type ListQuery,
} from "../backlinks/service";

export const backlinkRoutes = new Hono<AppEnv>();

/** POST /check/advance per project per minute (the Live view calls it at most every 2 s while a job runs). */
export const ADVANCE_RATE_LIMIT = { limit: 60, windowSeconds: 60 } as const;
/** POST /check per user per minute (on top of the per-project daily / hourly caps). */
export const CHECK_RATE_LIMIT = { limit: 10, windowSeconds: 60 } as const;

function userOf(c: Context<AppEnv>): SessionUser {
  const u = c.get("user");
  if (!u) throw unauthorized();
  return u;
}

async function access(c: Context<AppEnv>) {
  const user = userOf(c);
  const db = c.get("db");
  const row = await requireProject(db, user.id, c.req.param("pid") ?? "");
  return { user, db, row };
}

async function limit(c: Context<AppEnv>, key: string, l: { limit: number; windowSeconds: number }) {
  const r = await hitRateLimit(c.get("db"), key.slice(0, 300), l.limit, l.windowSeconds, c.get("now"));
  if (!r.allowed) throw new HttpError(429, "rate_limited", "Too many requests. Try again shortly.", { retryAfterSeconds: r.retryAfterSeconds });
}

async function jsonBody<T>(c: Context<AppEnv>, schema: z.ZodType<T>, max = 8 * 1024): Promise<T> {
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

const FILTER_STATUSES = [...BACKLINK_STATUSES, "unchecked", "target_broken"] as const;
const SORTS: readonly BacklinkSort[] = ["checked", "status", "host", "vendor", "date", "da", "traffic", "changed"];

const listSchema = z.object({
  status: z.enum(FILTER_STATUSES as unknown as [BacklinkFilterStatus, ...BacklinkFilterStatus[]]).optional(),
  vendor: z.string().max(120).optional(),
  type: z.string().max(80).optional(),
  changed: z.coerce.number().int().min(1).max(365).optional(),
  q: z.string().max(100).optional(),
  inactive: z.enum(["0", "1"]).optional(),
  sort: z.enum(SORTS as unknown as [BacklinkSort, ...BacklinkSort[]]).optional(),
  dir: z.enum(["asc", "desc"]).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  format: z.enum(["json", "csv"]).optional(),
});

function listQuery(c: Context<AppEnv>): { q: ListQuery; csv: boolean } {
  const r = listSchema.safeParse(c.req.query());
  if (!r.success) throw badRequest("Invalid list parameters.", r.error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })));
  const d = r.data;
  return {
    q: {
      status: d.status ?? null,
      vendor: d.vendor || null,
      type: d.type || null,
      changedDays: d.changed ?? null,
      q: d.q || null,
      includeInactive: d.inactive === "1",
      sort: d.sort,
      dir: d.dir,
      offset: d.offset,
      limit: d.limit,
    },
    csv: d.format === "csv",
  };
}

// ------------------------------------------------------------------ reads (static paths before /:id)
backlinkRoutes.get("/projects/:pid/backlinks", async (c) => {
  const { db, row } = await access(c);
  const { q, csv } = listQuery(c);
  if (csv) {
    const body = await backlinksCsv(db, row, q, c.get("now"));
    return c.body(body, 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="backlinks-${row.id}.csv"`,
      "Cache-Control": "no-store",
    });
  }
  return c.json({ data: await listBacklinks(db, row, q, c.get("now")) });
});

backlinkRoutes.get("/projects/:pid/backlinks/summary", async (c) => {
  const { db, row } = await access(c);
  return c.json({ data: await backlinkSummary(db, row, c.get("now"), true, c.env) });
});

backlinkRoutes.get("/projects/:pid/backlinks/events", async (c) => {
  const { db, row } = await access(c);
  const since = c.req.query("since") ?? null;
  if (since && Number.isNaN(Date.parse(since))) throw badRequest("since must be an ISO date or timestamp.");
  const lim = Number(c.req.query("limit") ?? 100);
  return c.json({ data: await backlinkEvents(db, row, { since, negativeOnly: c.req.query("negative") === "1", limit: Number.isFinite(lim) ? lim : 100 }, c.get("now")) });
});

backlinkRoutes.get("/projects/:pid/backlinks/feed", async (c) => {
  const { db, row } = await access(c);
  const after = c.req.query("after") ?? null;
  if (after && Number.isNaN(Date.parse(after))) throw badRequest("after must be an ISO timestamp.");
  const lim = c.req.query("limit");
  const n = lim === undefined ? undefined : Number(lim);
  if (n !== undefined && (!Number.isInteger(n) || n < 0 || n > 50)) throw badRequest("limit must be 0-50.");
  return c.json({ data: await backlinkFeed(db, row, { after, limit: n }) });
});

backlinkRoutes.get("/projects/:pid/backlinks/:id", async (c) => {
  const { db, row } = await access(c);
  const id = c.req.param("id");
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw badRequest("Invalid backlink id.");
  return c.json({ data: await backlinkDetail(db, row, id) });
});

// ------------------------------------------------------------------ writes
const checkSchema = z
  .object({ ids: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,80}$/)).min(1).max(MAX_RECHECK_IDS).optional() })
  .strict();

backlinkRoutes.post("/projects/:pid/backlinks/check", async (c) => {
  const { db, row, user } = await access(c);
  await limit(c, `backlink_check:${row.id}:${user.id}`, CHECK_RATE_LIMIT);
  const input = await jsonBody(c, checkSchema);
  const res = await startBacklinkCheck(c.env, db, row, { userId: user.id, ids: input.ids ?? null, now: c.get("now"), schedule: backgroundScheduler(c) });
  return c.json({ data: res }, 202);
});

backlinkRoutes.post("/projects/:pid/backlinks/check/advance", async (c) => {
  const { db, row } = await access(c);
  await limit(c, `backlink_advance:${row.id}`, ADVANCE_RATE_LIMIT);
  const input = await jsonBody(c, z.object({ after: z.string().max(40).nullish() }).strict());
  if (input.after && Number.isNaN(Date.parse(input.after))) throw badRequest("after must be an ISO timestamp.");
  return c.json({ data: await advanceBacklinkCheck(c.env, db, row, { after: input.after ?? null, schedule: backgroundScheduler(c) }) });
});
