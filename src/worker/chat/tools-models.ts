/**
 * Ask Okara model and credential tools [A35] (owner request 2026-10-04: "allow chat agent to add new model or custom
 * base url and new model, show all integrated models").
 *
 *  - `models` (read, any member): every integrated model in one view: the writer (default operator writer or a
 *    custom writer), custom providers (writer / GEO lanes), built-in engines (configured?, key source, selected
 *    model), DataForSEO, Maton apps, Search Console / Sheets connections. Never a key, key hint or token.
 *  - `provider_models` (read, owner): live "Fetch models" through the existing routes (same rate limits).
 *  - `manage_models` / `manage_credentials` (actions, confirm-gated): every change goes through the existing route
 *    in-process (route-bridge.ts): owner check, validation (validateCustomBaseUrl SSRF rules, keepKeyForNewHost,
 *    model id formats, operator-key spend guard), rate limits.
 *
 * Secrets: no schema here has a key field (all `.strict()`, so `apiKey` is rejected), the loop refuses key-like
 * argument values (secrets.ts), and an action that needs a key gets a secure field on its confirmation card
 * (secret-fields.ts): the browser sends the key to the credential route itself and confirms with {ok, keyHint};
 * execute() then only verifies that the route stored a key with that hint after the proposal.
 */
import { z } from "zod";
import type { CustomProviderModelList, ProviderModelList } from "@shared/types";
import { listCustomProviders, cleanModelId, validateCustomBaseUrl, MAX_CUSTOM_GEO_ENGINES, MAX_CUSTOM_PROVIDERS, type CustomProviderRow, type CustomProviderTestResult } from "../platform/custom-providers";
import { dataForSeoRow, operatorDataForSeo } from "../platform/dataforseo-credentials";
import { matonWorkspaceStatus, MATON_CREDENTIAL } from "../platform/maton-credentials";
import { normalizeModelId, MODEL_ID_FORMAT } from "../platform/provider-models";
import { writerConfigStatus } from "../providers/writer";
import { listProviderStatuses } from "../routes/credentials";
import { gscStatus } from "../routes/integrations";
import { gscMatonStatus } from "../routes/maton";
import { sheetsStatus } from "../imports/sheets";
import { chatModelStatus } from "./model";
import { callRoute, RouteError } from "./route-bridge";
import { CREDENTIAL_TARGET_RE, TARGET_LABEL } from "./secret-fields";
import { ToolError, clip, compact, projectRoute, requireOwnerTool, scoped, type ActionTool, type ExecuteExtra, type ReadTool, type ToolContext } from "./tool-base";

const ENGINES = ["gemini", "perplexity", "openai_geo", "anthropic_geo"] as const;
type Engine = (typeof ENGINES)[number];
const PROVIDER_ID = z.string().trim().regex(/^[a-z0-9_]{1,100}$/, "Use a custom provider id from the models tool.");
const integrations = (ctx: ToolContext) => ({ path: projectRoute(ctx.project.id, "integrations"), label: "Open Integrations" });

const hostOf = (url: string | null | undefined): string | null => {
  try {
    return url ? new URL(url).hostname : null;
  } catch {
    return null;
  }
};

async function customRows(ctx: ToolContext): Promise<CustomProviderRow[]> {
  try {
    return await listCustomProviders(ctx.db, scoped(ctx)[0]);
  } catch {
    return []; // migration not applied: none
  }
}

async function customRow(ctx: ToolContext, id: string): Promise<CustomProviderRow> {
  const row = (await customRows(ctx)).find((r) => r.id === id);
  if (!row) throw new ToolError("No custom provider with that id in this workspace. Use the models tool.");
  return row;
}

const ws = (ctx: ToolContext) => `/workspaces/${encodeURIComponent(scoped(ctx)[0])}`;

// ------------------------------------------------------------------ models (read)
async function modelsView(ctx: ToolContext) {
  const [wid] = scoped(ctx);
  const [providers, custom, chat, gsc, dfs, maton] = await Promise.all([
    listProviderStatuses(ctx.env, ctx.db, wid, ctx.now),
    customRows(ctx),
    chatModelStatus(ctx.env, ctx.db, wid),
    gscStatus(ctx.env, ctx.db, ctx.project),
    dataForSeoRow(ctx.db, wid).catch(() => null),
    matonWorkspaceStatus(ctx.db, wid).catch(() => null),
  ]);
  const gscSource = await gscMatonStatus(ctx.db, ctx.project, false).catch(() => null);
  const sheets = await sheetsStatus(ctx.env, ctx.db, ctx.project).catch(() => null);
  const env = writerConfigStatus(ctx.env);
  const writerKey = providers.find((p) => p.provider === "writer");
  const customWriter = custom.find((r) => r.is_writer === 1);
  const lastTest = (r: { last_tested_at: string | null; last_test_ok: number | null; last_test_detail: string | null }) => ({
    lastTestedAt: r.last_tested_at,
    lastTestOk: r.last_test_ok === null ? null : r.last_test_ok === 1,
    lastTestDetail: clip(r.last_test_detail, 160),
  });
  return {
    writer: {
      source: customWriter ? `custom:${customWriter.id}` : "default",
      active: customWriter
        ? { kind: "custom", id: customWriter.id, label: clip(customWriter.label, 60), host: customWriter.host, model: clip(customWriter.model, 120) }
        : {
            kind: "default (operator writer)",
            provider: env.provider,
            model: env.model,
            host: env.provider === "anthropic" ? "api.anthropic.com" : hostOf(ctx.env.WRITER_BASE_URL),
            keySource: writerKey?.source ?? "none",
            configured: env.configured && (writerKey?.source ?? "none") !== "none",
            missing: env.missing.slice(0, 5),
          },
      askOkara: { ready: chat.ready, provider: chat.provider, model: chat.model, note: "Ask Okara uses the workspace writer." },
    },
    customProviders: custom.map((r) => ({ id: r.id, role: r.role ?? "writer", label: clip(r.label, 60), host: r.host, baseUrl: clip(r.base_url, 200), model: clip(r.model, 120), isWriter: r.is_writer === 1, ...lastTest(r) })),
    limits: { customWriters: MAX_CUSTOM_PROVIDERS, customGeoEngines: MAX_CUSTOM_GEO_ENGINES },
    engines: providers
      .filter((p) => p.provider !== "writer")
      .map((p) => ({
        provider: p.provider,
        label: p.label,
        configured: p.source !== "none",
        keySource: p.source,
        state: p.state,
        model: p.model,
        modelSource: p.modelSource ?? null,
        workspaceModel: p.workspaceModel ?? null,
        modelNote: clip(p.modelNote ?? null, 200),
        modelSelectable: p.provider !== "typesafe",
        lastTestedAt: p.lastTestedAt,
        lastTestOk: p.lastTestOk,
      })),
    dataForSeo: {
      configured: Boolean(dfs) || operatorDataForSeo(ctx.env) !== null,
      keySource: dfs ? "workspace_key" : operatorDataForSeo(ctx.env) ? "operator_key" : "none",
      lastTestedAt: dfs?.last_tested_at ?? null,
      lastTestOk: dfs && dfs.last_test_ok !== null ? dfs.last_test_ok === 1 : null,
    },
    maton: maton
      ? {
          configured: maton.configured,
          state: maton.state,
          lastTestedAt: maton.lastTestedAt,
          lastTestOk: maton.lastTestOk,
          apps: maton.apps.map((a) => ({ app: a.app, label: a.label, usedByOkara: a.usedByOkara, connections: a.connections.length, selectedConnectionId: a.selectedConnectionId })),
        }
      : { configured: false },
    google: {
      searchConsole: { state: gsc.state, property: gsc.property, connectedAt: gsc.connectedAt, source: gscSource?.source ?? "direct", effective: gscSource?.effective ?? null, matonAvailable: gscSource?.matonAvailable ?? false },
      sheets: sheets ? { state: sheets.state, connectedAt: sheets.connectedAt } : null,
    },
    note: "Keys are never shown. Changes: manage_models (writer source, models, base URLs, custom providers) and manage_credentials (keys, via the secure field on the confirmation card). Owner only.",
  };
}

const modelsSchema = z.object({}).strict();

export const modelsTool: ReadTool<typeof modelsSchema> = {
  name: "models",
  kind: "read",
  description:
    "Every integrated model, no keys: writer (default or custom; Ask Okara uses it), custom providers (ids, host, model, role), built-in engines (key source, model), DataForSEO, Maton, Search Console/Sheets.",
  schema: modelsSchema,
  async run(ctx) {
    const data = await modelsView(ctx);
    return { data: compact(data, { maxItems: 20, maxStr: 300 }), summary: `Models: writer ${data.writer.source}, ${data.customProviders.length} custom provider(s), ${data.engines.filter((e) => e.configured).length} engine(s) configured`, navigate: integrations(ctx) };
  },
};

// ------------------------------------------------------------------ provider_models (read, owner)
const providerModelsSchema = z
  .object({
    target: z.string().trim().regex(/^(gemini|perplexity|openai_geo|anthropic_geo|custom:[a-z0-9_]{1,100})$/).describe("engine or custom:<id>"),
    contains: z.string().trim().min(1).max(60).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

/** Live model list through the existing Fetch models routes (owner; 10/min per user, shared with the UI). */
export async function fetchModelIds(ctx: ToolContext, target: string): Promise<{ ok: boolean | null; detail: string; ids: string[]; total: number; truncated: boolean; keySource?: string | null; mustSupport?: string | null }> {
  if (target.startsWith("custom:")) {
    const r = await callRoute<CustomProviderModelList>(ctx, "POST", `${ws(ctx)}/custom-providers/models`, { providerId: target.slice(7) });
    return { ok: r.ok, detail: r.detail, ids: r.models, total: r.total, truncated: r.truncated };
  }
  const r = await callRoute<ProviderModelList>(ctx, "POST", `${ws(ctx)}/credentials/${encodeURIComponent(target)}/models`, {});
  return { ok: r.ok, detail: r.detail, ids: r.models.map((m) => m.id), total: r.total, truncated: r.truncated, keySource: r.keySource, mustSupport: r.mustSupport };
}

export const providerModelsTool: ReadTool<typeof providerModelsSchema> = {
  name: "provider_models",
  kind: "read",
  description: "LIVE Fetch models (owner, rate-limited): model ids a saved custom provider or built-in engine lists. Use before changing a model.",
  schema: providerModelsSchema,
  async run(ctx, input) {
    await requireOwnerTool(ctx, "fetch provider model lists");
    if (input.target.startsWith("custom:")) await customRow(ctx, input.target.slice(7));
    const r = await fetchModelIds(ctx, input.target);
    const q = input.contains?.toLowerCase();
    const ids = (q ? r.ids.filter((m) => m.toLowerCase().includes(q)) : r.ids).slice(0, input.limit ?? 50).map((m) => clip(m, 120));
    return {
      data: { target: input.target, ok: r.ok, detail: clip(r.detail, 300), models: ids, matched: q ? r.ids.filter((m) => m.toLowerCase().includes(q)).length : r.ids.length, total: r.total, truncated: r.truncated, keySource: r.keySource ?? null, mustSupport: r.mustSupport ?? null, note: "Model ids are provider-defined text." },
      summary: `${input.target}: ${r.ok === true ? `${r.total} model(s)` : clip(r.detail, 120)}`,
    };
  },
};

// ------------------------------------------------------------------ manage_models (action)
const manageModelsSchema = z
  .object({
    op: z.enum(["set_writer", "set_custom_model", "set_engine_model", "update_base_url", "add_provider", "remove_provider", "test_provider"]),
    source: z.string().trim().regex(/^(default|custom:[a-z0-9_]{1,100})$/).optional().describe("set_writer: default | custom:<id>"),
    providerId: PROVIDER_ID.optional(),
    engine: z.enum(ENGINES).optional(),
    model: z.union([z.string().trim().min(1).max(200), z.null()]).optional(),
    baseUrl: z.string().trim().min(8).max(500).optional().describe("OpenAI-compatible https base URL"),
    keepSavedKey: z.boolean().optional().describe("true = send the saved key to the new host; else a new key via the secure field"),
    label: z.string().trim().min(1).max(80).optional(),
    role: z.enum(["writer", "geo"]).optional(),
    useAsWriter: z.boolean().optional(),
  })
  .strict();
type ManageModelsInput = z.infer<typeof manageModelsSchema>;

function need<T>(v: T | undefined | null, msg: string): T {
  if (v === undefined || v === null || v === "") throw new ToolError(msg);
  return v;
}

function baseUrlCheck(ctx: ToolContext, raw: string) {
  const check = validateCustomBaseUrl(raw, ctx.env.APP_ORIGIN);
  if (!check.ok) throw new ToolError(`Base URL refused: ${check.message}`);
  return check;
}

/** Model must be in the provider's live list when the list is complete (as the picker shows it). */
async function checkListed(ctx: ToolContext, target: string, model: string): Promise<string> {
  let r;
  try {
    r = await fetchModelIds(ctx, target);
  } catch (e) {
    if (e instanceof RouteError && e.status === 429) throw e;
    return `Could not verify against the provider's model list (${e instanceof Error ? clip(e.message, 120) : "error"}).`;
  }
  if (r.ok === true && !r.truncated && !r.ids.includes(model)) {
    const near = r.ids.filter((m) => m.toLowerCase().includes(model.toLowerCase().split(/[\/:]/).pop()!.slice(0, 8))).slice(0, 5);
    throw new ToolError(`"${clip(model, 80)}" is not in the provider's model list (${r.total} models)${near.length ? `; similar: ${near.join(", ")}` : ""}. Use provider_models to pick an exact id.`);
  }
  return r.ok === true ? `Listed by the provider (${r.total} models).` : `Model list not confirmed: ${clip(r.detail, 120)}`;
}

async function verifySecret(ctx: ToolContext, extra: ExecuteExtra | undefined, find: (hint: string) => Promise<boolean>, what: string): Promise<string> {
  const s = extra?.secret;
  if (!s) throw new ToolError(`No key was entered in the secure field, so nothing was saved for ${what}.`);
  if (!s.ok || !s.keyHint) throw new ToolError(`The secure save for ${what} did not succeed; nothing was changed by the chat.`);
  if (!(await find(s.keyHint))) throw new ToolError(`Could not confirm that a key ending ${s.keyHint} was saved for ${what} after this proposal. Check Integrations.`);
  return s.keyHint;
}

export const manageModels: ActionTool<typeof manageModelsSchema> = {
  name: "manage_models",
  kind: "action",
  description:
    "Propose a model change (owner, confirm): set_writer(source); set_custom_model(providerId, model); set_engine_model(engine, model|null=default); update_base_url(providerId, baseUrl, keepSavedKey, model?); add_provider(role writer|geo, baseUrl, model, label?, useAsWriter?); remove_provider; test_provider. Keys only via the card's secure field.",
  schema: manageModelsSchema,
  async prepare(ctx, input) {
    if (input.op !== "test_provider") await requireOwnerTool(ctx, "change models and providers");
    switch (input.op) {
      case "set_writer": {
        const source = need(input.source, "set_writer needs source: default or custom:<id>.");
        if (source === "default") {
          const env = writerConfigStatus(ctx.env);
          return { title: "Use the default writer?", detail: `Drafts and Ask Okara will use the operator writer${env.model ? ` (${env.provider}, ${env.model})` : ""}. Custom providers are kept. This chat continues with the new writer on your next message.` };
        }
        const row = await customRow(ctx, source.slice(7));
        if (row.role === "geo") throw new ToolError("That custom provider is a GEO engine, not a writer; add it as a writer to use it for drafting.");
        return { title: `Use ${clip(row.label, 60)} as the writer?`, detail: `Drafts and Ask Okara will use ${row.host} with model ${clip(row.model, 100)}. This chat continues with the new writer on your next message.` };
      }
      case "set_custom_model": {
        const row = await customRow(ctx, need(input.providerId, "set_custom_model needs providerId."));
        const model = cleanModelId(need(input.model, "set_custom_model needs model."));
        if (!model) throw new ToolError("Invalid model id (1-200 characters, no control characters).");
        if (model === row.model) throw new ToolError(`${clip(row.label, 60)} already uses ${clip(model, 80)}.`);
        const note = await checkListed(ctx, `custom:${row.id}`, model);
        return { title: `Change ${clip(row.label, 60)} to model ${clip(model, 80)}?`, detail: `Now ${clip(row.model, 80)} on ${row.host}. ${note} The saved key and base URL stay.` };
      }
      case "set_engine_model": {
        const engine = need(input.engine, "set_engine_model needs engine.") as Engine;
        if (input.model === undefined) throw new ToolError("set_engine_model needs model (an id, or null for the operator default).");
        if (input.model === null) return { title: `Reset the ${TARGET_LABEL[engine]} model to the default?`, detail: "The workspace selection is removed; the operator's configured model is used." };
        const model = normalizeModelId(engine, input.model);
        if (!model) throw new ToolError(`Invalid model id for ${TARGET_LABEL[engine]}: ${MODEL_ID_FORMAT[engine]}.`);
        const note = await checkListed(ctx, engine, model);
        return { title: `Use ${clip(model, 80)} for ${TARGET_LABEL[engine]}?`, detail: `${note} The operator-key spend guard applies (a model without a verified price needs your own key).` };
      }
      case "update_base_url": {
        const row = await customRow(ctx, need(input.providerId, "update_base_url needs providerId."));
        const check = baseUrlCheck(ctx, need(input.baseUrl, "update_base_url needs baseUrl."));
        if (input.model !== undefined && (input.model === null || !cleanModelId(input.model))) throw new ToolError("Invalid model id.");
        const hostChanged = check.host !== row.host;
        if (!hostChanged && check.baseUrl === row.base_url && input.model === undefined) throw new ToolError("That is already the saved base URL.");
        if (!hostChanged && input.keepSavedKey !== true) throw new ToolError("The host is unchanged, so the saved key stays: propose again with keepSavedKey: true.");
        const modelPart = input.model ? ` Model → ${clip(input.model, 80)}.` : "";
        if (input.keepSavedKey === true) {
          return {
            title: `Move ${clip(row.label, 60)} to ${check.baseUrl}?`,
            detail: hostChanged ? `New host ${check.host} (was ${row.host}). Confirming sends the SAVED API key to ${check.host} from now on.${modelPart}` : `Same host ${check.host}; the saved key stays.${modelPart}`,
          };
        }
        return { title: `Move ${clip(row.label, 60)} to ${check.baseUrl} with a new key?`, detail: `New host ${check.host} (was ${row.host}). Type the new API key in the secure field below; it is sent straight to Okara's server, never to the chat.${modelPart}` };
      }
      case "add_provider": {
        const role = input.role ?? "writer";
        const check = baseUrlCheck(ctx, need(input.baseUrl, "add_provider needs baseUrl."));
        const model = cleanModelId(need(input.model, "add_provider needs model."));
        if (!model) throw new ToolError("Invalid model id (1-200 characters, no control characters).");
        const count = (await customRows(ctx)).filter((r) => (r.role ?? "writer") === role).length;
        const cap = role === "geo" ? MAX_CUSTOM_GEO_ENGINES : MAX_CUSTOM_PROVIDERS;
        if (count >= cap) throw new ToolError(`This workspace already has ${count} custom ${role === "geo" ? "GEO engines" : "providers"} (max ${cap}); remove one first.`);
        return {
          title: `Add ${clip(input.label ?? check.host, 60)} as a custom ${role === "geo" ? "GEO engine" : "writer"}?`,
          detail: `${check.baseUrl} · model ${clip(model, 80)}${role === "writer" ? (input.useAsWriter === false ? " · not selected as the writer" : " · becomes the writer (drafts and Ask Okara)") : ""}. Type its API key in the secure field below; it goes straight to Okara's server, never to the chat.`,
        };
      }
      case "remove_provider": {
        const row = await customRow(ctx, need(input.providerId, "remove_provider needs providerId."));
        return { title: `Remove custom provider ${clip(row.label, 60)}?`, detail: `${row.host} · ${clip(row.model, 80)}. Its saved key is deleted.${row.is_writer === 1 ? " It is the current writer: the writer reverts to the default." : ""}` };
      }
      case "test_provider": {
        const row = await customRow(ctx, need(input.providerId, "test_provider needs providerId."));
        return { title: `Test ${clip(row.label, 60)} now?`, detail: `Lists models at ${row.host} with the saved key (no inference call) and records the result.` };
      }
    }
  },
  async execute(ctx, input, extra) {
    const nav = integrations(ctx);
    const base = ws(ctx);
    if (input.op !== "test_provider") await requireOwnerTool(ctx, "change models and providers");
    switch (input.op) {
      case "set_writer": {
        const r = await callRoute<{ writerSource: string }>(ctx, "PUT", `${base}/writer-source`, { source: input.source });
        return { data: { writerSource: r.writerSource }, summary: `Writer source: ${r.writerSource}`, navigate: nav };
      }
      case "set_custom_model": {
        await callRoute(ctx, "PATCH", `${base}/custom-providers/${encodeURIComponent(input.providerId!)}`, { model: input.model });
        const row = await customRow(ctx, input.providerId!);
        return { data: { providerId: row.id, model: row.model, host: row.host }, summary: `Model set to ${clip(row.model, 80)}`, navigate: nav };
      }
      case "set_engine_model": {
        const s = await callRoute<{ model: string | null; modelSource: string | null; state: string; modelNote: string | null }>(ctx, "PUT", `${base}/credentials/${input.engine}/model`, { model: input.model ?? null });
        return { data: { engine: input.engine, model: s.model, modelSource: s.modelSource, state: s.state, modelNote: clip(s.modelNote, 200) }, summary: `${TARGET_LABEL[input.engine!]} model: ${s.model ?? "default"}`, navigate: nav };
      }
      case "update_base_url": {
        const check = baseUrlCheck(ctx, input.baseUrl!);
        if (input.keepSavedKey === true) {
          await callRoute(ctx, "PATCH", `${base}/custom-providers/${encodeURIComponent(input.providerId!)}`, { baseUrl: check.baseUrl, keepKeyForNewHost: true, ...(input.model ? { model: input.model } : {}) });
          const row = await customRow(ctx, input.providerId!);
          return { data: { providerId: row.id, baseUrl: row.base_url, host: row.host, model: row.model, keyKept: true }, summary: `Base URL → ${row.host} (saved key kept)`, navigate: nav };
        }
        const hint = await verifySecret(
          ctx,
          extra,
          async (h) => Boolean(await ctx.db.first("SELECT 1 FROM workspace_custom_providers WHERE workspace_id = ? AND id = ? AND base_url = ? AND key_hint = ? AND updated_at >= ?", scoped(ctx)[0], input.providerId, check.baseUrl, h, extra!.proposedAt)),
          "the new base URL",
        );
        const row = await customRow(ctx, input.providerId!);
        return { data: { providerId: row.id, baseUrl: row.base_url, host: row.host, model: row.model, newKeySaved: true }, summary: `Base URL → ${row.host} with a new key (…${hint})`, navigate: nav };
      }
      case "add_provider": {
        const check = baseUrlCheck(ctx, input.baseUrl!);
        const model = cleanModelId(input.model);
        let id: string | null = null;
        const hint = await verifySecret(
          ctx,
          extra,
          async (h) => {
            const r = await ctx.db.first<{ id: string }>(
              "SELECT id FROM workspace_custom_providers WHERE workspace_id = ? AND host = ? AND base_url = ? AND model = ? AND key_hint = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1",
              scoped(ctx)[0],
              check.host,
              check.baseUrl,
              model,
              h,
              extra!.proposedAt,
            );
            id = r?.id ?? null;
            return id !== null;
          },
          "the new custom provider",
        );
        const row = await customRow(ctx, id!);
        return { data: { providerId: row.id, role: row.role ?? "writer", label: row.label, host: row.host, model: row.model, isWriter: row.is_writer === 1 }, summary: `Added ${clip(row.label, 60)} (${row.host}, key …${hint})`, navigate: nav };
      }
      case "remove_provider": {
        await callRoute(ctx, "DELETE", `${base}/custom-providers/${encodeURIComponent(input.providerId!)}`);
        return { data: { removed: input.providerId }, summary: "Custom provider removed", navigate: nav };
      }
      case "test_provider": {
        const r = await callRoute<CustomProviderTestResult>(ctx, "POST", `${base}/custom-providers/${encodeURIComponent(input.providerId!)}/test`, {});
        return { data: { ok: r.ok, detail: clip(r.detail, 300), modelListed: r.modelListed }, summary: `Test: ${r.ok === true ? "ok" : r.ok === false ? "failed" : "not confirmed"} · ${clip(r.detail, 120)}`, navigate: nav };
      }
    }
  },
};

// ------------------------------------------------------------------ manage_credentials (action)
const manageCredentialsSchema = z
  .object({
    op: z.enum(["set_key", "remove_key", "test"]),
    target: z
      .string()
      .trim()
      .regex(CREDENTIAL_TARGET_RE)
      .describe("built-in provider, writer, dataforseo, maton or custom:<id>"),
  })
  .strict();

const credentialPath = (ctx: ToolContext, target: string) =>
  target === "dataforseo" ? `${ws(ctx)}/dataforseo` : target === "maton" ? `${ws(ctx)}/maton` : `${ws(ctx)}/credentials/${encodeURIComponent(target)}`;
const credentialRowName = (target: string) => (target === "maton" ? MATON_CREDENTIAL : target);
const labelOf = (target: string) => TARGET_LABEL[target] ?? target;

export const manageCredentials: ActionTool<typeof manageCredentialsSchema> = {
  name: "manage_credentials",
  kind: "action",
  description:
    "Propose a credential change (owner, confirm): set_key (the card shows a secure field; the key never passes through chat), remove_key, test.",
  schema: manageCredentialsSchema,
  async prepare(ctx, input) {
    const t = input.target;
    // Test routes for built-in providers, DataForSEO and custom providers are member routes; Maton's is owner-only.
    if (input.op !== "test" || t === "maton") await requireOwnerTool(ctx, "change API keys");
    const custom = t.startsWith("custom:") ? await customRow(ctx, t.slice(7)) : null;
    const name = custom ? `custom provider ${clip(custom.label, 60)} (${custom.host})` : labelOf(t);
    if (input.op === "set_key") {
      const what = t === "dataforseo" ? "API login and password" : "API key";
      return { title: `Set the ${name} ${what}?`, detail: `Type the ${what} in the secure field below. It is sent straight to Okara's server (encrypted at rest) and never enters the chat or the model.${custom ? ` Only ${custom.host} will receive it.` : ""}` };
    }
    if (input.op === "remove_key") {
      if (custom) throw new ToolError("A custom provider's key cannot be removed on its own: remove the provider with manage_models op remove_provider.");
      const row = await ctx.db.first("SELECT 1 AS n FROM provider_credentials WHERE workspace_id = ? AND provider = ?", scoped(ctx)[0], credentialRowName(t));
      if (!row) throw new ToolError(`No workspace key is saved for ${name}.`);
      return { title: `Remove the ${name} workspace key?`, detail: `${t === "maton" ? "The cached Maton connection list and picks are cleared too. " : ""}If the operator configured a key, it is used instead; otherwise ${name} needs setup again.` };
    }
    if (!custom && !(await ctx.db.first("SELECT 1 AS n FROM provider_credentials WHERE workspace_id = ? AND provider = ?", scoped(ctx)[0], credentialRowName(t)))) {
      throw new ToolError(`No workspace key is saved for ${name}; only a saved workspace key can be tested.`);
    }
    return { title: `Test the saved ${name} key?`, detail: "A free, non-inference request; the result is recorded on the Integrations page." };
  },
  async execute(ctx, input, extra) {
    const t = input.target;
    const nav = integrations(ctx);
    if (input.op !== "test" || t === "maton") await requireOwnerTool(ctx, "change API keys");
    const [wid] = scoped(ctx);
    if (input.op === "set_key") {
      const hint = await verifySecret(
        ctx,
        extra,
        async (h) =>
          t.startsWith("custom:")
            ? Boolean(await ctx.db.first("SELECT 1 FROM workspace_custom_providers WHERE workspace_id = ? AND id = ? AND key_hint = ? AND updated_at >= ?", wid, t.slice(7), h, extra!.proposedAt))
            : Boolean(await ctx.db.first("SELECT 1 FROM provider_credentials WHERE workspace_id = ? AND provider = ? AND key_hint = ? AND updated_at >= ?", wid, credentialRowName(t), h, extra!.proposedAt)),
        labelOf(t),
      );
      return { data: { target: t, saved: true, next: "Offer a test (manage_credentials op test)." }, summary: `Key saved for ${labelOf(t)} (…${hint})`, navigate: nav };
    }
    if (input.op === "remove_key") {
      await callRoute(ctx, "DELETE", credentialPath(ctx, t));
      return { data: { target: t, removed: true }, summary: `Removed the ${labelOf(t)} workspace key`, navigate: nav };
    }
    if (t.startsWith("custom:")) {
      const r = await callRoute<CustomProviderTestResult>(ctx, "POST", `${ws(ctx)}/custom-providers/${encodeURIComponent(t.slice(7))}/test`, {});
      return { data: { ok: r.ok, detail: clip(r.detail, 300), modelListed: r.modelListed }, summary: `Test: ${r.ok === true ? "ok" : r.ok === false ? "failed" : "not confirmed"}`, navigate: nav };
    }
    const r = await callRoute<{ ok: boolean | null; detail: string; apps?: unknown[] }>(ctx, "POST", `${credentialPath(ctx, t)}/test`, {});
    return {
      data: compact({ target: t, ok: r.ok, detail: r.detail, apps: t === "maton" ? r.apps : undefined }, { maxItems: 20 }),
      summary: `Test ${labelOf(t)}: ${r.ok === true ? "ok" : r.ok === false ? "failed" : "not confirmed"} · ${clip(r.detail, 120)}`,
      navigate: nav,
    };
  },
};

export const MODEL_CHAT_TOOLS = [modelsTool, providerModelsTool];
export const MODEL_ACTION_TOOLS = [manageModels, manageCredentials] as unknown as ActionTool[];
