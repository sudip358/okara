/**
 * Ask Okara "admin" ACTION tools [A33]: the state-changing things a signed-in user can do in the UI, each behind
 * the server-enforced confirmation flow (service.ts): prepare() validates and describes the change WITHOUT changing
 * state (the loop records a pending chat_actions row); execute() runs once, only after the user's own Confirm POST.
 *
 * Every execute() calls the same service function as the route it mirrors (exported from routes/*.ts), so the route's
 * tenancy (ProjectRow from requireProject), validation, rate limits (same keys, shared with the UI), quotas and role
 * rules apply unchanged: owner-only routes stay owner-only (checked in prepare AND again in execute, because the
 * role could change between proposal and confirmation).
 *
 * Deliberately NOT here (the chat answers with navigate instead): credential create/update/delete or key reveal,
 * custom provider changes, member/role changes, workspace/project delete, sign-in allowlist, OAuth connects.
 */
import { z } from "zod";
import { SYNC_FREQUENCIES } from "@shared/import";
import type { Competitor } from "@shared/types";
import { HttpError } from "../lib/errors";
import { parseJson } from "../lib/db";
import { brandBlindViolations, getActivePromptSet, MAX_PROMPT_LENGTH, MAX_PROMPTS_PER_SET, savePromptSet, type PromptInput } from "../geo/prompts";
import { putPageManual, putProjectManual } from "../checklists/service";
import { onCompetitorsChanged } from "../competitors/dataforseo";
import { MAX_BULK_IDS, updateLinkUserStatusBulk, linkSetup } from "../links/report";
import { loadSync } from "../imports/sync";
import { LIMIT_BOUNDS, putLimits, toProject, updateProject } from "../platform/projects";
import { editClusterFor, GRAPH_REBUILD_RATE_LIMIT, LINK_RUN_RATE_LIMIT, ownUrl, rebuildLinkGraphFor, runLinkAnalysisFor, type ClusterEdit } from "../routes/links";
import { patchSyncFor, runSyncNowFor } from "../routes/imports";
import { buyerQueriesFor } from "../routes/seo-overview";
import { PAGE_TYPES, setPageType } from "../routes/seo-audit";
import { cancelRunFor } from "../routes/runs";
import type { RunRow } from "../runs/runtime";
import type { ProjectRow } from "../platform/access";
import { ToolError, clip, projectRoute, requireOwnerTool, scoped, type ActionTool, type ToolContext } from "./tool-base";

/** Route HttpErrors (400/404/409/429/412) become plain tool errors (message only). */
async function viaRoute<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof HttpError) throw new ToolError(e.message);
    throw e;
  }
}
function limitedOrData<T>(r: { data: T } | { rateLimited: true; message: string; retryAfterSeconds: number }): T {
  if ("rateLimited" in r) throw new ToolError(`${r.message} (retry in about ${Math.ceil(r.retryAfterSeconds / 60)} min)`);
  return r.data;
}
async function freshProject(ctx: ToolContext): Promise<ProjectRow> {
  const [ws, pid] = scoped(ctx);
  const p = await ctx.db.first<ProjectRow>("SELECT * FROM projects WHERE workspace_id = ? AND id = ?", ws, pid);
  if (!p) throw new ToolError("This project no longer exists.");
  return p;
}

// ------------------------------------------------------------------ link_job
const linkJobSchema = z.object({ job: z.enum(["analysis", "rebuild_graph"]).describe("analysis = internal-link suggestion run (may ask Jev and the writer); rebuild_graph = deterministic link-graph rebuild (no paid call).") });

const linkJob: ActionTool<typeof linkJobSchema> = {
  name: "link_job",
  kind: "action",
  description: `Propose an internal-links job: a suggestion run (${LINK_RUN_RATE_LIMIT.limit}/hour/project; uses Jev and writer budget when configured) or a link-graph rebuild (${GRAPH_REBUILD_RATE_LIMIT.limit}/hour/project). Needs confirmation.`,
  schema: linkJobSchema,
  async prepare(ctx, input) {
    const setup = await linkSetup(ctx.db, ctx.project);
    if (setup.state === "setup_required") throw new ToolError(setup.message ?? "Internal links need a verified site and a completed crawl.");
    return input.job === "analysis"
      ? { title: "Run internal-link analysis now?", detail: `Builds link suggestions from the latest crawl. Limited to ${LINK_RUN_RATE_LIMIT.limit} runs per hour per project; uses Jev and the writer from this project's budget when configured. Okara never edits your pages.` }
      : { title: "Rebuild the internal link graph?", detail: `Recomputes the link graph from stored crawls (no paid call). Limited to ${GRAPH_REBUILD_RATE_LIMIT.limit} rebuilds per hour per project.` };
  },
  async execute(ctx, input) {
    const path = projectRoute(ctx.project.id, "internal-links");
    if (input.job === "analysis") {
      const r = limitedOrData(await viaRoute(() => runLinkAnalysisFor(ctx.env, ctx.db, ctx.project, ctx.userId, ctx.now)));
      return { data: { state: r.state, generatedAt: r.generatedAt, suggestions: r.suggestions.length, orphanPages: r.orphanPages.length }, summary: `Link analysis ${r.state} · ${r.suggestions.length} suggestion(s)`, navigate: { path, label: "Open Internal links" } };
    }
    const g = limitedOrData(await viaRoute(() => rebuildLinkGraphFor(ctx.db, ctx.project, ctx.userId, ctx.now)));
    return { data: { state: g.state, builtAt: g.builtAt, counts: g.counts }, summary: `Link graph ${g.state}${g.counts ? ` · ${g.counts.urls} URLs` : ""}`, navigate: { path, label: "Open Internal links" } };
  },
};

// ------------------------------------------------------------------ set_link_suggestion_status
const linkStatusSchema = z.object({
  ids: z.array(z.string().trim().min(1).max(80)).min(1).max(Math.min(MAX_BULK_IDS, 90)).describe("Suggestion ids from internal_link_suggestions (at most 90)."),
  userStatus: z.enum(["open", "accepted", "dismissed", "implemented"]),
});

const setLinkSuggestionStatus: ActionTool<typeof linkStatusSchema> = {
  name: "set_link_suggestion_status",
  kind: "action",
  description: "Propose marking internal-link suggestions accepted, dismissed, implemented or open again (one or many). Needs confirmation.",
  schema: linkStatusSchema,
  async prepare(ctx, input) {
    const [ws, pid] = scoped(ctx);
    const ids = [...new Set(input.ids)];
    const found = await ctx.db.all<{ id: string }>(`SELECT id FROM link_suggestions WHERE workspace_id = ? AND project_id = ? AND id IN (${ids.map(() => "?").join(",")})`, ws, pid, ...ids);
    if (found.length === 0) throw new ToolError("None of those suggestion ids belong to this project. Use internal_link_suggestions.");
    return { title: `Mark ${found.length} link suggestion${found.length === 1 ? "" : "s"} ${input.userStatus}?`, detail: `${found.length} of ${ids.length} id(s) found in this project${found.length < ids.length ? "; the rest are ignored" : ""}.` };
  },
  async execute(ctx, input) {
    const r = await viaRoute(() => updateLinkUserStatusBulk(ctx.db, ctx.project, [...new Set(input.ids)], input.userStatus, ctx.now));
    return { data: { updated: r.updated, missing: r.missing }, summary: `${r.updated} suggestion(s) ${input.userStatus}`, navigate: { path: projectRoute(ctx.project.id, "internal-links"), label: "Open Internal links" } };
  },
};

// ------------------------------------------------------------------ edit_link_cluster
const clusterSchema = z.object({
  op: z.enum(["mark_hub", "unmark_hub", "clear_hub", "assign_spoke", "unassign_spoke", "reset_spoke"]).describe("mark_hub/unmark_hub/clear_hub act on url; assign_spoke puts url under hubUrl; unassign_spoke detaches it; reset_spoke returns it to the automatic assignment."),
  url: z.string().trim().min(8).max(2048).describe("A URL on the verified site (the hub, or the spoke)."),
  hubUrl: z.string().trim().min(8).max(2048).optional().describe("assign_spoke only."),
});

function clusterEdit(input: z.infer<typeof clusterSchema>): ClusterEdit {
  switch (input.op) {
    case "mark_hub":
      return { kind: "hub", url: input.url, hub: true };
    case "unmark_hub":
      return { kind: "hub", url: input.url, hub: false };
    case "clear_hub":
      return { kind: "hub", url: input.url, hub: null };
    case "assign_spoke":
      if (!input.hubUrl) throw new ToolError("assign_spoke needs hubUrl.");
      return { kind: "assign", spokeUrl: input.url, hubUrl: input.hubUrl };
    case "unassign_spoke":
      return { kind: "assign", spokeUrl: input.url, hubUrl: null };
    case "reset_spoke":
      return { kind: "reset", spokeUrl: input.url };
  }
}

const editLinkCluster: ActionTool<typeof clusterSchema> = {
  name: "edit_link_cluster",
  kind: "action",
  description: "Propose a hub/spoke edit in the internal-links clusters (mark/unmark/clear a hub, assign/unassign/reset a spoke). URLs must be on the verified site. Needs confirmation.",
  schema: clusterSchema,
  async prepare(ctx, input) {
    const e = clusterEdit(input);
    // Same URL rule as the route (400 off the verified host), checked without touching state or the rate limit.
    await viaRoute(async () => {
      ownUrl(ctx.project, input.url);
      if (e.kind === "assign" && e.hubUrl) ownUrl(ctx.project, e.hubUrl);
    });
    const label: Record<typeof input.op, string> = {
      mark_hub: "Mark as a hub page",
      unmark_hub: "Mark as NOT a hub page",
      clear_hub: "Clear the hub override for",
      assign_spoke: "Assign spoke",
      unassign_spoke: "Detach spoke",
      reset_spoke: "Reset the automatic hub for",
    };
    return { title: `${label[input.op]}: ${clip(input.url, 120)}?`, detail: input.op === "assign_spoke" ? `Hub: ${clip(input.hubUrl, 160)}` : "Changes the cluster view only; Okara never edits your pages." };
  },
  async execute(ctx, input) {
    const r = limitedOrData(await viaRoute(() => editClusterFor(ctx.db, ctx.project, ctx.userId, ctx.now, clusterEdit(input))));
    return { data: { hubs: r.hubs?.length ?? null }, summary: `Cluster updated (${input.op})`, navigate: { path: projectRoute(ctx.project.id, "internal-links"), label: "Open Internal links" } };
  },
};

// ------------------------------------------------------------------ manage_import_sync (owner only, as the routes)
const syncSchema = z.object({
  syncId: z.string().trim().min(1).max(100).describe("Sync id from import_data view=syncs."),
  op: z.enum(["run_now", "enable", "disable", "set_frequency"]),
  frequencyHours: z.number().int().optional().describe(`set_frequency only: one of ${SYNC_FREQUENCIES.join(", ")}.`),
});

const manageImportSync: ActionTool<typeof syncSchema> = {
  name: "manage_import_sync",
  kind: "action",
  description: "Propose a Google Sheets sync change: sync now (rate-limited per sync), enable, disable or change its frequency. Workspace owner only. Needs confirmation.",
  schema: syncSchema,
  async prepare(ctx, input) {
    await requireOwnerTool(ctx, "manage sheet syncs");
    const sync = await loadSync(ctx.db, ctx.project, input.syncId);
    if (!sync) throw new ToolError("No sync with that id in this project. Use import_data view=syncs.");
    if (input.op === "set_frequency" && !(SYNC_FREQUENCIES as readonly number[]).includes(input.frequencyHours ?? -1)) throw new ToolError(`frequencyHours must be one of ${SYNC_FREQUENCIES.join(", ")}.`);
    const name = `"${clip(sync.spreadsheet_title, 80)}" / ${clip(sync.tab, 60)}`;
    const title = { run_now: `Sync ${name} now?`, enable: `Enable syncing ${name}?`, disable: `Pause syncing ${name}?`, set_frequency: `Sync ${name} every ${input.frequencyHours} hours?` }[input.op];
    return { title, detail: input.op === "run_now" ? "Reads the sheet tab once and applies the changes (rate-limited per sync)." : "Imported data is kept." };
  },
  async execute(ctx, input) {
    await requireOwnerTool(ctx, "manage sheet syncs");
    const path = projectRoute(ctx.project.id, "import");
    if (input.op === "run_now") {
      const r = await viaRoute(() => runSyncNowFor(ctx.env, ctx.db, ctx.project, input.syncId, ctx.userId, ctx.now, ctx.waitUntil));
      return { data: { status: r.outcome.status, message: clip(r.outcome.message, 200), changes: r.outcome.changes.length }, summary: `Sync ${r.outcome.status}`, navigate: { path, label: "Open Import" } };
    }
    const patch = input.op === "set_frequency" ? { frequencyHours: input.frequencyHours } : { enabled: input.op === "enable" };
    const s = await viaRoute(() => patchSyncFor(ctx.db, ctx.project, input.syncId, patch, ctx.now));
    return { data: { id: s.id, enabled: s.enabled, frequencyHours: s.frequencyHours, nextRunAt: s.nextRunAt }, summary: `Sync ${s.enabled ? "enabled" : "paused"} · every ${s.frequencyHours} h`, navigate: { path, label: "Open Import" } };
  },
};

// ------------------------------------------------------------------ update_geo_prompts
const newPrompt = z.object({
  text: z.string().trim().min(3).max(MAX_PROMPT_LENGTH),
  promptType: z.enum(["discovery", "reputation"]),
  stage: z.string().trim().max(80).optional(),
  approved: z.boolean().optional(),
});
const geoPromptsSchema = z.object({
  approve: z.array(z.string().max(100)).max(MAX_PROMPTS_PER_SET).optional().describe("Prompt ids to approve."),
  unapprove: z.array(z.string().max(100)).max(MAX_PROMPTS_PER_SET).optional(),
  remove: z.array(z.string().max(100)).max(MAX_PROMPTS_PER_SET).optional(),
  add: z.array(newPrompt).max(MAX_PROMPTS_PER_SET).optional().describe("New prompts the user gave (discovery prompts must be brand-blind)."),
});
type GeoPromptsInput = z.infer<typeof geoPromptsSchema>;

/** The next prompt set (as the GEO prompts page would PUT it), validated like the route; never saved here. */
async function nextPromptSet(ctx: ToolContext, input: GeoPromptsInput): Promise<{ prompts: PromptInput[]; changes: string[] }> {
  const [ws, pid] = scoped(ctx);
  const current = await getActivePromptSet(ctx.db, ws, pid);
  const existing = current?.prompts ?? [];
  const ids = new Set(existing.map((p) => p.id));
  for (const id of [...(input.approve ?? []), ...(input.unapprove ?? []), ...(input.remove ?? [])]) if (!ids.has(id)) throw new ToolError(`Prompt id ${clip(id, 40)} is not in the active prompt set. Use geo_data view=prompts.`);
  const approve = new Set(input.approve ?? []);
  const unapprove = new Set(input.unapprove ?? []);
  const remove = new Set(input.remove ?? []);
  const prompts: PromptInput[] = existing
    .filter((p) => !remove.has(p.id))
    .map((p) => ({ text: p.text, promptType: p.promptType, stage: p.stage, approved: approve.has(p.id) ? true : unapprove.has(p.id) ? false : p.approved }));
  for (const a of input.add ?? []) prompts.push({ text: a.text, promptType: a.promptType, stage: a.stage || null, approved: a.approved ?? false });
  if (prompts.length > MAX_PROMPTS_PER_SET) throw new ToolError(`At most ${MAX_PROMPTS_PER_SET} prompts per set.`);
  const seen = new Set<string>();
  for (const p of prompts) {
    const k = p.text.trim().toLowerCase();
    if (seen.has(k)) throw new ToolError(`Duplicate prompt text: ${clip(p.text, 80)}`);
    seen.add(k);
    if (p.promptType === "discovery") {
      const hits = [...new Set(brandBlindViolations(p.text, ctx.project).map((v) => v.matched))];
      if (hits.length) throw new ToolError(`Discovery prompts must be brand-blind; "${clip(p.text, 80)}" names ${hits.slice(0, 3).join(", ")}. Make it a reputation prompt or remove the name.`);
    }
  }
  const changes = [
    approve.size ? `approve ${approve.size}` : "",
    unapprove.size ? `unapprove ${unapprove.size}` : "",
    remove.size ? `remove ${remove.size}` : "",
    input.add?.length ? `add ${input.add.length}` : "",
  ].filter(Boolean);
  if (!changes.length) throw new ToolError("Nothing to change.");
  return { prompts, changes };
}

const updateGeoPrompts: ActionTool<typeof geoPromptsSchema> = {
  name: "update_geo_prompts",
  kind: "action",
  description: `Propose a new version of the GEO prompt set: approve/unapprove/remove prompts by id and add prompts the user gave (max ${MAX_PROMPTS_PER_SET}; discovery prompts brand-blind). Needs confirmation.`,
  schema: geoPromptsSchema,
  async prepare(ctx, input) {
    const { prompts, changes } = await nextPromptSet(ctx, input);
    const added = (input.add ?? []).map((a) => `"${clip(a.text, 80)}"`).join(", ");
    return { title: `Save GEO prompts (${changes.join(", ")})?`, detail: `Saves a new prompt set version with ${prompts.length} prompt(s), ${prompts.filter((p) => p.approved).length} approved.${added ? ` New: ${clip(added, 300)}` : ""}` };
  },
  async execute(ctx, input) {
    const { prompts } = await nextPromptSet(ctx, input);
    const set = await viaRoute(() => savePromptSet(ctx.db, ctx.project, prompts, ctx.now));
    return { data: { setId: set.id, version: set.version, prompts: set.prompts.length, approved: set.prompts.filter((p) => p.approved).length }, summary: `GEO prompt set v${set.version} saved`, navigate: { path: projectRoute(ctx.project.id, "geo/prompts"), label: "Open GEO prompts" } };
  },
};

// ------------------------------------------------------------------ update_competitors (PATCH /projects/:pid competitors)
const competitorsSchema = z.object({
  add: z.array(z.object({ name: z.string().trim().min(1).max(120), domains: z.array(z.string().trim().min(1).max(253)).max(5).optional() })).max(10).optional(),
  remove: z.array(z.string().trim().min(1).max(120)).max(20).optional().describe("Competitor names to remove (as listed)."),
});

function nextCompetitors(project: ProjectRow, input: z.infer<typeof competitorsSchema>): { before: Competitor[]; after: Competitor[] } {
  const before = parseJson<Competitor[]>(project.competitors_json, []);
  const drop = new Set((input.remove ?? []).map((n) => n.toLowerCase()));
  for (const n of drop) if (!before.some((c) => c.name.toLowerCase() === n)) throw new ToolError(`No competitor named "${clip(n, 60)}" on this project.`);
  const after: Competitor[] = before.filter((c) => !drop.has(c.name.toLowerCase()));
  for (const a of input.add ?? []) {
    if (after.some((c) => c.name.toLowerCase() === a.name.toLowerCase())) throw new ToolError(`Competitor "${clip(a.name, 60)}" already exists.`);
    after.push({ name: a.name, domains: a.domains ?? [], aliases: [] } as Competitor);
  }
  if (!input.add?.length && !drop.size) throw new ToolError("Nothing to change.");
  return { before, after };
}

const updateCompetitors: ActionTool<typeof competitorsSchema> = {
  name: "update_competitors",
  kind: "action",
  description: "Propose adding or removing tracked competitors (project settings). New domains may pull DataForSEO data automatically when the workspace enabled it (paid). Needs confirmation.",
  schema: competitorsSchema,
  async prepare(ctx, input) {
    const { after } = nextCompetitors(await freshProject(ctx), input);
    const adds = (input.add ?? []).map((a) => `${clip(a.name, 60)}${a.domains?.length ? ` (${a.domains.slice(0, 3).join(", ")})` : ""}`);
    return {
      title: `Update competitors (${[adds.length ? `add ${adds.length}` : "", input.remove?.length ? `remove ${input.remove.length}` : ""].filter(Boolean).join(", ")})?`,
      detail: `${adds.length ? `Add: ${clip(adds.join("; "), 200)}. ` : ""}${input.remove?.length ? `Remove: ${clip(input.remove.join(", "), 160)}. ` : ""}${after.length} competitor(s) after. New domains may fetch DataForSEO data (billed by DataForSEO) if auto-fetch is on.`,
    };
  },
  async execute(ctx, input) {
    const project = await freshProject(ctx);
    const { before, after } = nextCompetitors(project, input);
    const updated = await viaRoute(() => updateProject(ctx.db, project, { competitors: after as never }, ctx.now));
    await onCompetitorsChanged(ctx.env, ctx.db, updated, before, ctx.userId, ctx.now, ctx.waitUntil);
    return { data: { competitors: toProject(updated).competitors.map((c) => c.name) }, summary: `Competitors updated (${toProject(updated).competitors.length})`, navigate: { path: projectRoute(ctx.project.id, "competitors"), label: "Open Competitors" } };
  },
};

// ------------------------------------------------------------------ update_project_settings (PATCH /projects/:pid, PUT /limits)
const settingsSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  brandName: z.string().trim().min(1).max(120).optional(),
  brandAliases: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  productDescription: z.string().max(5000).optional(),
  audience: z.string().max(2000).optional(),
  voice: z.string().max(2000).optional(),
  siteType: z.enum(["ecommerce", "saas", "publisher", "local", "other"]).optional(),
  locale: z.string().trim().max(35).optional(),
  language: z.string().trim().max(35).optional(),
  scheduleEnabled: z.boolean().optional().describe("Daily scheduled agent runs on/off."),
  limits: z
    .object({
      crawlPages: z.number().int().min(LIMIT_BOUNDS.crawlPages[0]).max(LIMIT_BOUNDS.crawlPages[1]).optional(),
      gscRows: z.number().int().min(LIMIT_BOUNDS.gscRows[0]).max(LIMIT_BOUNDS.gscRows[1]).optional(),
      geoPromptsPerRun: z.number().int().min(LIMIT_BOUNDS.geoPromptsPerRun[0]).max(LIMIT_BOUNDS.geoPromptsPerRun[1]).optional(),
      providerCallsPerDay: z.number().int().min(LIMIT_BOUNDS.providerCallsPerDay[0]).max(LIMIT_BOUNDS.providerCallsPerDay[1]).optional(),
      usdPerDay: z.number().finite().min(LIMIT_BOUNDS.usdPerDay[0]).max(LIMIT_BOUNDS.usdPerDay[1]).optional(),
    })
    .strict()
    .optional()
    .describe("Per-project daily caps within the Settings page bounds."),
});

const updateProjectSettings: ActionTool<typeof settingsSchema> = {
  name: "update_project_settings",
  kind: "action",
  description: "Propose changing project settings (name, brand, aliases, description, audience, voice, site type, locale/language, daily schedule) and/or limits (crawl pages per run, GSC rows, GEO prompts per run, provider calls/day, USD/day) within the Settings bounds. Site URL changes: Settings page. Needs confirmation.",
  schema: settingsSchema,
  async prepare(ctx, input) {
    const { limits, ...fields } = input;
    const keys = Object.keys(fields).filter((k) => (fields as Record<string, unknown>)[k] !== undefined);
    const limitKeys = limits ? Object.keys(limits).filter((k) => (limits as Record<string, unknown>)[k] !== undefined) : [];
    if (!keys.length && !limitKeys.length) throw new ToolError("Nothing to change.");
    const show = (v: unknown) => (typeof v === "string" ? `"${clip(v, 60)}"` : Array.isArray(v) ? clip(v.join(", "), 80) : String(v));
    const parts = [...keys.map((k) => `${k} → ${show((fields as Record<string, unknown>)[k])}`), ...limitKeys.map((k) => `${k} → ${(limits as Record<string, unknown>)[k]}`)];
    return { title: `Change project settings (${[...keys, ...limitKeys].join(", ")})?`, detail: clip(parts.join("; "), 500) ?? "" };
  },
  async execute(ctx, input) {
    const { limits, ...fields } = input;
    const project = await freshProject(ctx);
    const changed: string[] = [];
    if (Object.values(fields).some((v) => v !== undefined)) {
      await viaRoute(() => updateProject(ctx.db, project, fields, ctx.now));
      changed.push("settings");
    }
    let newLimits: unknown = null;
    if (limits && Object.values(limits).some((v) => v !== undefined)) {
      newLimits = await viaRoute(() => putLimits(ctx.db, project.workspace_id, project.id, limits, ctx.now));
      changed.push("limits");
    }
    return { data: { updated: changed, limits: newLimits }, summary: `Updated ${changed.join(" and ")}`, navigate: { path: projectRoute(ctx.project.id, "settings"), label: "Open Settings" } };
  },
};

// ------------------------------------------------------------------ update_checklist_item
const checklistItemSchema = z.object({
  kind: z.enum(["seo", "geo", "page"]),
  pageId: z.string().trim().min(1).max(100).optional().describe("kind=page only."),
  itemId: z.string().min(3).max(120).regex(/^[a-z_]+(\.[a-z0-9_]+)+$/).describe("A manual checklist item id from checklist_status."),
  checked: z.boolean(),
  note: z.string().max(500).optional(),
});

const updateChecklistItem: ActionTool<typeof checklistItemSchema> = {
  name: "update_checklist_item",
  kind: "action",
  description: "Propose ticking or unticking a MANUAL checklist item (SEO, GEO or one page's), with an optional note. Measured items cannot be ticked. Needs confirmation.",
  schema: checklistItemSchema,
  async prepare(ctx, input) {
    if ((input.kind === "page") !== Boolean(input.pageId)) throw new ToolError("pageId is required for kind=page and only for it.");
    if (input.pageId) {
      const p = await ctx.db.first<{ id: string }>("SELECT id FROM pages WHERE id = ? AND workspace_id = ? AND project_id = ?", input.pageId, ctx.project.workspace_id, ctx.project.id);
      if (!p) throw new ToolError("No crawled page with that id in this project.");
    }
    return { title: `${input.checked ? "Tick" : "Untick"} checklist item ${input.itemId}?`, detail: `${input.kind.toUpperCase()} checklist${input.note ? ` · Note: ${clip(input.note, 160)}` : ""}` };
  },
  async execute(ctx, input) {
    const body = { checked: input.checked, note: input.note ?? null };
    const item = await viaRoute(() =>
      input.kind === "page"
        ? putPageManual(ctx.env, ctx.db, ctx.project, input.pageId!, input.itemId, body, ctx.userId, ctx.now)
        : putProjectManual(ctx.env, ctx.db, ctx.project, input.kind as "seo" | "geo", input.itemId, body, ctx.userId, ctx.now),
    );
    return { data: { id: item.id, status: item.status }, summary: `Checklist item ${item.status}`, navigate: { path: projectRoute(ctx.project.id, input.kind === "page" ? `pages/${encodeURIComponent(input.pageId!)}/checklist` : "checklists"), label: "Open checklist" } };
  },
};

// ------------------------------------------------------------------ classify_buyer_queries (POST /seo/buyer-queries)
const emptySchema = z.object({});

const classifyBuyerQueries: ActionTool<typeof emptySchema> = {
  name: "classify_buyer_queries",
  kind: "action",
  description: "Propose asking Jev to classify uncached non-brand Search Console queries as buyer intent (uses Jev budget; rate-limited per user and per project per day; POST again to continue). Needs confirmation.",
  schema: emptySchema,
  async prepare(ctx) {
    if (ctx.project.is_demo === 1) throw new ToolError("Demo projects never call Jev.");
    return { title: "Classify buyer-intent queries with Jev?", detail: "Asks Jev about Search Console queries not classified in the last 7 days. Uses this project's Jev budget; limited per minute and per day." };
  },
  async execute(ctx) {
    const r = limitedOrData(await buyerQueriesFor(ctx.env, ctx.db, ctx.project, ctx.userId, ctx.now, true));
    return { data: { state: r.state, rows: r.rows.length, completeness: r.completeness }, summary: `Buyer queries ${r.state} · ${r.rows.length} row(s)`, navigate: { path: projectRoute(ctx.project.id, "seo"), label: "Open SEO" } };
  },
};

// ------------------------------------------------------------------ set_page_type (PATCH /pages/:pageId)
const pageTypeSchema = z.object({ pageId: z.string().trim().min(1).max(100), pageType: z.enum(PAGE_TYPES) });

const setPageTypeTool: ActionTool<typeof pageTypeSchema> = {
  name: "set_page_type",
  kind: "action",
  description: "Propose correcting a crawled page's type (home, collection, product, article, landing, other). Needs confirmation.",
  schema: pageTypeSchema,
  async prepare(ctx, input) {
    const p = await ctx.db.first<{ url: string; page_type: string }>("SELECT url, page_type FROM pages WHERE id = ? AND workspace_id = ? AND project_id = ?", input.pageId, ctx.project.workspace_id, ctx.project.id);
    if (!p) throw new ToolError("No crawled page with that id in this project. Use list_pages.");
    if (p.page_type === input.pageType) throw new ToolError(`The page is already ${p.page_type}.`);
    return { title: `Set page type to ${input.pageType}?`, detail: `${clip(p.url, 200)} (now ${p.page_type})` };
  },
  async execute(ctx, input) {
    const row = await viaRoute(() => setPageType(ctx.db, ctx.project, input.pageId, input.pageType));
    return { data: { id: row.id, pageType: row.pageType }, summary: `Page type set to ${row.pageType}` };
  },
};

// ------------------------------------------------------------------ cancel_run (POST /runs/:id/cancel)
const cancelSchema = z.object({ runId: z.string().trim().min(1).max(100) });

async function loadOwnRun(ctx: ToolContext, runId: string): Promise<RunRow> {
  const [ws, pid] = scoped(ctx);
  const run = await ctx.db.first<RunRow>("SELECT * FROM agent_runs WHERE id = ? AND workspace_id = ? AND project_id = ?", runId, ws, pid);
  if (!run) throw new ToolError("No run with that id in this project. Use list_runs.");
  return run;
}

const cancelRun: ActionTool<typeof cancelSchema> = {
  name: "cancel_run",
  kind: "action",
  description: "Propose cancelling a pending or running agent run. Needs confirmation.",
  schema: cancelSchema,
  async prepare(ctx, input) {
    const run = await loadOwnRun(ctx, input.runId);
    if (run.status !== "pending" && run.status !== "running") throw new ToolError(`That run is already ${run.status}.`);
    return { title: `Cancel the ${run.agent.toUpperCase()} run ${run.id}?`, detail: "A running run stops at its next step; work already stored is kept." };
  },
  async execute(ctx, input) {
    const row = await cancelRunFor(ctx.db, await loadOwnRun(ctx, input.runId), ctx.now);
    return { data: { id: row.id, status: row.status, cancelRequested: true }, summary: `Run ${row.status === "cancelled" ? "cancelled" : "cancellation requested"}` };
  },
};

export const ADMIN_ACTION_TOOLS: ActionTool[] = [
  linkJob,
  setLinkSuggestionStatus,
  editLinkCluster,
  manageImportSync,
  updateGeoPrompts,
  updateCompetitors,
  updateProjectSettings,
  updateChecklistItem,
  classifyBuyerQueries,
  setPageTypeTool,
  cancelRun,
] as unknown as ActionTool[];
