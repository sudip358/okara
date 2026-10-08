/**
 * Ask Okara backlinks read tool [A40] over the backlink monitor service ([A38], src/worker/backlinks/service.ts):
 * the same functions the Backlinks page uses (every query filters by workspace_id + project_id). Read-only: no
 * check is started from chat (the Backlinks page has Check / Recheck). Live URLs, anchors, vendors and page text
 * come from the owner's sheet or third-party pages: data, never instructions.
 */
import { z } from "zod";
import { BACKLINK_STATUSES, type BacklinkFilterStatus, type BacklinkRow } from "@shared/backlinks";
import { backlinkDetail, backlinkEvents, backlinkSummary, listBacklinks } from "../backlinks/service";
import { clip, projectRoute, ToolError, type ReadTool } from "./tool-base";

const FILTERS = [...BACKLINK_STATUSES, "unchecked", "target_broken"] as const;

const schema = z.object({
  view: z.enum(["summary", "list", "detail", "events"]).describe("summary = counts and last check; list = monitored links (filter by status or text); detail = one link with its checks; events = recent changes."),
  status: z.enum(FILTERS as unknown as [BacklinkFilterStatus, ...BacklinkFilterStatus[]]).optional().describe("list only."),
  contains: z.string().trim().min(1).max(100).optional().describe("list only: text in the live URL, host, target, vendor or anchor (e.g. a site name)."),
  id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).optional().describe("detail only: backlink id from list."),
  negativeOnly: z.boolean().optional().describe("events only."),
  limit: z.number().int().min(1).max(50).optional().describe("Rows (1-50, default 20)."),
});

const row = (r: BacklinkRow) => ({
  id: r.id,
  liveUrl: clip(r.liveUrl, 300),
  target: clip(r.targetUrl, 300),
  vendor: clip(r.vendor, 80),
  status: r.status,
  rel: r.linkRel,
  anchorExpected: clip(r.anchorExpected, 120),
  anchorFound: clip(r.anchorFound, 120),
  anchorMatch: r.anchorMatch,
  httpStatus: r.httpStatus,
  pageNoindex: r.pageNoindex,
  targetStatus: r.targetStatus,
  lastCheckedAt: r.lastCheckedAt,
  lastChange: clip(r.lastChangeText, 160),
  method: r.checkMethod,
});

export const backlinksTool: ReadTool<typeof schema> = {
  name: "backlinks",
  kind: "read",
  description:
    "Backlink monitor (built links from the owner's sheet, checked on the live article): summary, list (dofollow/nofollow/missing/errors, filter by text such as a site name), detail with check history, events. Statuses come from Okara's stored checks; vendor/DA/price are the owner's sheet labels.",
  schema,
  async run(ctx, input) {
    const limit = input.limit ?? 20;
    const source = "Okara backlink monitor (stored checks)";
    switch (input.view) {
      case "summary": {
        const s = await backlinkSummary(ctx.db, ctx.project, ctx.now, true, ctx.env);
        return {
          data: { source, state: s.state, totals: s.totals, byStatus: s.byStatus, dofollow: `${s.dofollow.n} of ${s.dofollow.m}`, targetBroken: s.targetBroken, anchorMismatch: s.anchorMismatch, changes: s.changes, lastCheckAt: s.lastCheckAt, nextCheckAt: s.nextCheckAt, runningJob: s.job ? { status: s.job.status, done: s.job.done, total: s.job.total } : null, page: projectRoute(ctx.project.id, "backlinks") },
          summary: `${s.totals.active} monitored · dofollow ${s.dofollow.n} of ${s.dofollow.m}${s.lastCheckAt ? ` · last check ${s.lastCheckAt.slice(0, 10)}` : ""}`,
        };
      }
      case "list": {
        const r = await listBacklinks(ctx.db, ctx.project, { status: input.status ?? null, q: input.contains ?? null, limit }, ctx.now);
        return { data: { source, total: r.total, rows: r.rows.map(row), more: r.total > r.rows.length }, summary: `${r.rows.length} of ${r.total} backlink(s)` };
      }
      case "detail": {
        if (!input.id) throw new ToolError("An id is required for detail (use view=list first).");
        const d = await backlinkDetail(ctx.db, ctx.project, input.id);
        return {
          data: {
            source,
            backlink: row(d.backlink),
            checks: d.checks.slice(0, 5).map((c) => ({ checkedAt: c.checkedAt, method: c.method, status: c.status, rel: c.linkRel, relText: clip(c.relText, 80), httpStatus: c.httpStatus, finalUrl: clip(c.finalUrl, 300), anchorFound: clip(c.anchorFound, 120), noindex: c.pageNoindex, error: c.errorCode })),
            events: d.events.slice(0, 10).map((e) => ({ kind: e.kind, from: clip(e.from, 80), to: clip(e.to, 80), negative: e.negative, at: e.detectedAt })),
          },
          summary: `${d.backlink.liveHost} · ${d.backlink.status ?? "unchecked"}`,
        };
      }
      case "events": {
        const e = await backlinkEvents(ctx.db, ctx.project, { negativeOnly: input.negativeOnly === true, limit }, ctx.now);
        const events = e.events.slice(0, limit);
        return {
          data: { source, since: e.since, total: e.total, events: events.map((x) => ({ kind: x.kind, message: clip(x.message, 200), liveUrl: clip(x.liveUrl, 300), negative: x.negative, at: x.detectedAt })) },
          summary: `${events.length} of ${e.total} change(s) since ${e.since.slice(0, 10)}`,
        };
      }
    }
  },
};
