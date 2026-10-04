/**
 * Ask Okara owner admin tools [A35] ("add chat agent all the admin permission"): the remaining Integrations /
 * Settings writes that need no browser redirect, each confirm-gated and workspace-owner only in chat (checked at
 * proposal and again at execution), executed through the existing route in-process (route-bridge.ts) so the
 * route's own role check, validation, demo-project rules and rate limits apply unchanged.
 *
 *  - `integration_options` (read): the choices those writes need (Search Console properties of the direct
 *    connection or of Maton, Maton connections per app, DataForSEO locations).
 *  - `admin_settings` (action): context document edit, DataForSEO location / auto-fetch, verification re-check,
 *    Jev decision feedback, Search Console source (direct | maton + property), Search Console property (direct
 *    OAuth connection), Maton connection per app.
 *
 * Still navigate-only: Google OAuth connects (browser redirect), workspace/project delete, members and roles,
 * the sign-in allowlist (environment variable).
 */
import { z } from "zod";
import type { MatonStatus } from "@shared/maton";
import { contextKindSchema, listLatestContext } from "../platform/projects";
import { callRoute } from "./route-bridge";
import { ToolError, clip, compact, projectRoute, requireOwnerTool, scoped, type ActionTool, type ReadTool, type ToolContext } from "./tool-base";

const pid = (ctx: ToolContext) => `/projects/${encodeURIComponent(ctx.project.id)}`;
const wsPath = (ctx: ToolContext) => `/workspaces/${encodeURIComponent(scoped(ctx)[0])}`;
const PROPERTY = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((v) => v.startsWith("sc-domain:") || v.startsWith("https://") || v.startsWith("http://"), "Property must be a URL-prefix or sc-domain: property.");
const MATON_APPS = ["google-sheets", "google-search-console", "google-analytics-data", "google-analytics-admin"] as const;

// ------------------------------------------------------------------ integration_options (read)
const optionsSchema = z
  .object({
    view: z.enum(["gsc_properties", "maton_gsc_sites", "maton_connections", "dataforseo_locations"]),
    contains: z.string().trim().min(1).max(80).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export const integrationOptions: ReadTool<typeof optionsSchema> = {
  name: "integration_options",
  kind: "read",
  description: "Choices for admin_settings: gsc_properties (direct Google connection), maton_gsc_sites, maton_connections (ids per app), dataforseo_locations (codes + languages).",
  schema: optionsSchema,
  async run(ctx, input) {
    const limit = input.limit ?? 30;
    const q = input.contains?.toLowerCase();
    const has = (s: string) => !q || s.toLowerCase().includes(q);
    switch (input.view) {
      case "gsc_properties":
      case "maton_gsc_sites": {
        const path = input.view === "gsc_properties" ? `${pid(ctx)}/gsc/properties` : `${pid(ctx)}/gsc/maton/sites`;
        const rows = (await callRoute<Array<{ siteUrl: string; permissionLevel: string }>>(ctx, "GET", path)).filter((s) => has(s.siteUrl));
        return { data: { view: input.view, properties: rows.slice(0, limit).map((s) => ({ siteUrl: clip(s.siteUrl, 300), permissionLevel: s.permissionLevel })), total: rows.length, current: ctx.project.gsc_property }, summary: `${rows.length} Search Console propert${rows.length === 1 ? "y" : "ies"}` };
      }
      case "maton_connections": {
        const s = await callRoute<MatonStatus>(ctx, "GET", `${wsPath(ctx)}/maton`);
        return {
          data: compact({ view: input.view, configured: s.configured, listedAt: s.listedAt, apps: s.apps.map((a) => ({ app: a.app, label: a.label, usedByOkara: a.usedByOkara, selectedConnectionId: a.selectedConnectionId, connections: a.connections.map((c) => ({ connectionId: c.connectionId, status: c.status, createdAt: c.createdAt, selected: c.selected })) })), note: "Press Test on the Maton card (or manage_credentials op test target maton) to refresh the list." }, { maxItems: 20 }),
          summary: `Maton: ${s.apps.reduce((n, a) => n + a.connections.length, 0)} connection(s)`,
        };
      }
      case "dataforseo_locations": {
        const rows = (await callRoute<Array<{ locationCode: number; locationName: string; languages: Array<{ languageCode: string; languageName: string }> }>>(ctx, "GET", `${pid(ctx)}/competitors/dataforseo/locations`)).filter((l) => has(l.locationName));
        return {
          data: { view: input.view, locations: rows.slice(0, limit).map((l) => ({ locationCode: l.locationCode, locationName: clip(l.locationName, 100), languages: l.languages.slice(0, 10).map((x) => ({ languageCode: x.languageCode, languageName: x.languageName })) })), total: rows.length },
          summary: `${rows.length} DataForSEO location(s)`,
        };
      }
    }
  },
};

// ------------------------------------------------------------------ admin_settings (action, owner)
const factSchema = z.object({ text: z.string().trim().min(1).max(1000), confirmed: z.boolean() }).strict();
const settingsSchema = z
  .object({
    op: z.enum(["context_doc", "dataforseo_settings", "verification_check", "decision_feedback", "gsc_source", "gsc_property", "maton_connection"]),
    kind: contextKindSchema.optional(),
    content: z.string().max(20000).optional(),
    facts: z.array(factSchema).max(100).optional(),
    location: z.union([z.object({ locationCode: z.number().int().positive(), languageCode: z.string().trim().min(1).max(16) }).strict(), z.null()]).optional(),
    autoFetch: z.boolean().optional(),
    method: z.enum(["dns", "file", "gsc"]).optional(),
    decisionId: z.string().trim().min(1).max(100).optional(),
    humanAnswer: z.string().trim().min(1).max(200).optional(),
    reason: z.string().max(1000).optional(),
    source: z.enum(["direct", "maton"]).optional(),
    property: PROPERTY.optional(),
    app: z.enum(MATON_APPS).optional(),
    connectionId: z.union([z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), z.null()]).optional(),
  })
  .strict();
type SettingsInput = z.infer<typeof settingsSchema>;

function req<T>(v: T | undefined, msg: string): T {
  if (v === undefined) throw new ToolError(msg);
  return v;
}

async function currentFacts(ctx: ToolContext, kind: string) {
  const [ws, p] = scoped(ctx);
  const doc = (await listLatestContext(ctx.db, ws, p)).find((d) => d.kind === kind);
  return { doc, facts: (doc?.facts ?? []).map((f) => ({ id: f.id, text: f.text, confirmed: f.confirmed, source: f.source })) };
}

async function describe(ctx: ToolContext, input: SettingsInput): Promise<{ title: string; detail: string }> {
  switch (input.op) {
    case "context_doc": {
      const kind = req(input.kind, "context_doc needs kind.");
      const content = req(input.content, "context_doc needs the full new content.");
      const { doc, facts } = await currentFacts(ctx, kind);
      return { title: `Save a new version of the ${kind} context document?`, detail: `${content.length} characters (was ${doc?.content.length ?? 0}); ${input.facts ? `${input.facts.length} fact(s) replace the current ${facts.length}` : `${facts.length} current fact(s) kept`}. Writers draft from confirmed context. Starts: "${clip(content, 160)}"` };
    }
    case "dataforseo_settings": {
      if (input.location === undefined && input.autoFetch === undefined) throw new ToolError("dataforseo_settings needs location and/or autoFetch.");
      const loc = input.location === null ? "clear the location (use the project default)" : input.location ? `location ${input.location.locationCode} / ${input.location.languageCode} (checked against DataForSEO's list)` : "";
      return { title: "Change DataForSEO competitor-data settings?", detail: [loc, input.autoFetch !== undefined ? `auto-fetch ${input.autoFetch ? "on (new competitor domains are fetched, billed by DataForSEO)" : "off"}` : ""].filter(Boolean).join("; ") };
    }
    case "verification_check": {
      const method = req(input.method, "verification_check needs method dns, file or gsc.");
      return { title: `Re-check site ownership (${method})?`, detail: method === "gsc" ? "Checks the Search Console property's permission for the site host." : `Looks for the verification ${method === "dns" ? "TXT record" : "file"} on the site host (outbound check, rate-limited).` };
    }
    case "decision_feedback": {
      const id = req(input.decisionId, "decision_feedback needs decisionId (from run_detail).");
      const [ws, p] = scoped(ctx);
      const d = await ctx.db.first<{ id: string }>("SELECT id FROM decision_records WHERE id = ? AND workspace_id = ? AND project_id = ?", id, ws, p);
      if (!d) throw new ToolError("No Jev decision with that id in this project. Use run_detail.");
      return { title: `Record your feedback on decision ${clip(id, 40)}?`, detail: `Your answer: "${clip(req(input.humanAnswer, "decision_feedback needs humanAnswer."), 120)}"${input.reason ? ` · Reason: ${clip(input.reason, 160)}` : ""}. Used for evaluation only.` };
    }
    case "gsc_source": {
      const source = req(input.source, "gsc_source needs source direct or maton.");
      if (ctx.project.is_demo === 1) throw new ToolError("Demo projects cannot change their Search Console source.");
      if (source === "maton" && !input.property) throw new ToolError("gsc_source maton needs property (from integration_options view maton_gsc_sites).");
      return { title: source === "direct" ? "Use the direct Google connection for Search Console?" : `Read Search Console through Maton (${clip(input.property, 120)})?`, detail: source === "maton" ? "Only a property the Maton connection can see is accepted; a matching property also verifies site ownership. The direct connection still wins whenever it is connected." : "The project's sync uses the direct Google OAuth connection." };
    }
    case "gsc_property": {
      const property = req(input.property, "gsc_property needs property (from integration_options view gsc_properties).");
      return { title: `Use Search Console property ${clip(property, 120)}?`, detail: "Only a property the connected Google account can see is accepted; a matching property also verifies site ownership." };
    }
    case "maton_connection": {
      const app = req(input.app, "maton_connection needs app.");
      if (input.connectionId === undefined) throw new ToolError("maton_connection needs connectionId (or null for Maton's default).");
      return { title: `Use Maton connection ${input.connectionId ?? "default"} for ${app}?`, detail: "Okara sends this connection with every request for that app. It must be one of the active connections listed by the last Maton test." };
    }
  }
}

export const adminSettings: ActionTool<typeof settingsSchema> = {
  name: "admin_settings",
  kind: "action",
  description:
    "Propose an owner admin change (confirm): context_doc(kind, full content, facts? kept if omitted); dataforseo_settings(location {locationCode, languageCode}|null, autoFetch); verification_check(method); decision_feedback(decisionId, humanAnswer, reason?); gsc_source(direct|maton + property); gsc_property(property); maton_connection(app, connectionId|null).",
  schema: settingsSchema,
  async prepare(ctx, input) {
    await requireOwnerTool(ctx, "change integration and project admin settings");
    return describe(ctx, input);
  },
  async execute(ctx, input) {
    await requireOwnerTool(ctx, "change integration and project admin settings");
    const integrations = { path: projectRoute(ctx.project.id, "integrations"), label: "Open Integrations" };
    switch (input.op) {
      case "context_doc": {
        const { facts } = await currentFacts(ctx, input.kind!);
        const body = { content: input.content!, facts: input.facts ?? facts };
        const d = await callRoute<{ id: string; version: number; kind: string }>(ctx, "PUT", `${pid(ctx)}/context/${input.kind}`, body);
        return { data: { kind: d.kind, version: d.version, facts: body.facts.length }, summary: `Context ${d.kind} saved (v${d.version})`, navigate: { path: projectRoute(ctx.project.id, "settings"), label: "Open Settings" } };
      }
      case "dataforseo_settings": {
        await callRoute(ctx, "PUT", `${pid(ctx)}/competitors/dataforseo/settings`, { ...(input.location !== undefined ? { location: input.location } : {}), ...(input.autoFetch !== undefined ? { autoFetch: input.autoFetch } : {}) });
        return { data: { location: input.location ?? null, autoFetch: input.autoFetch ?? null }, summary: "DataForSEO settings saved", navigate: { path: projectRoute(ctx.project.id, "competitors"), label: "Open Competitors" } };
      }
      case "verification_check": {
        const r = await callRoute<{ verified: boolean; verifiedHost: string | null; check: { method: string; ok: boolean; detail: string } }>(ctx, "POST", `${pid(ctx)}/verification/check`, { method: input.method });
        return { data: { verified: r.verified, verifiedHost: r.verifiedHost, check: { method: r.check.method, ok: r.check.ok, detail: clip(r.check.detail, 300) } }, summary: `Verification ${input.method}: ${r.check.ok ? "verified" : "not verified"}`, navigate: { path: projectRoute(ctx.project.id, "settings"), label: "Open Settings" } };
      }
      case "decision_feedback": {
        await callRoute(ctx, "POST", `/decisions/${encodeURIComponent(input.decisionId!)}/feedback`, { humanAnswer: input.humanAnswer, ...(input.reason ? { reason: input.reason } : {}) });
        return { data: { recorded: true }, summary: "Feedback recorded" };
      }
      case "gsc_source": {
        const r = await callRoute<{ status: { effective: string | null; source: string; property: string | null } }>(ctx, "PUT", `${pid(ctx)}/gsc/source`, input.source === "maton" ? { source: "maton", property: input.property } : { source: "direct" });
        return { data: { effective: r.status.effective, source: r.status.source, property: r.status.property }, summary: `Search Console source: ${r.status.source}`, navigate: integrations };
      }
      case "gsc_property": {
        const r = await callRoute<{ property: string; verification: { verified: boolean } }>(ctx, "PUT", `${pid(ctx)}/gsc/property`, { property: input.property });
        return { data: { property: r.property, verified: r.verification.verified }, summary: `Search Console property: ${clip(r.property, 100)}`, navigate: integrations };
      }
      case "maton_connection": {
        await callRoute(ctx, "PUT", `${wsPath(ctx)}/maton/connections/${input.app}`, { connectionId: input.connectionId ?? null });
        return { data: { app: input.app, connectionId: input.connectionId ?? null }, summary: `Maton ${input.app}: ${input.connectionId ?? "default"} connection`, navigate: integrations };
      }
    }
  },
};

export const ADMIN_SETTINGS_READ_TOOLS = [integrationOptions];
export const ADMIN_SETTINGS_ACTION_TOOLS = [adminSettings] as unknown as ActionTool[];
