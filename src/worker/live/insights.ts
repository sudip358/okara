/**
 * Live view project containers (docs/live-view-design.md section 17; docs/api.md "Live view: project
 * containers"): GET /projects/:pid/live/insights?kind=<kind>. One read-only, bounded aggregate per container
 * that no existing endpoint returns. Builders: insights-seo.ts (striking, movers, technical), insights-geo.ts
 * (engine_queries, brands, cited_domains, prompt_history) and this file (sheets, budget). No provider call, no
 * Jev, no budget reservation; the project is resolved with requireProject() by the route and every statement
 * filters workspace_id (and project_id or the project's scope key) with a LIMIT.
 */
import type { LiveBudgetInsight, LiveBudgetLine, LiveInsight, LiveInsightKind, LiveSheetSyncRow, LiveSheetsInsight } from "@shared/types";
import { promptKey } from "@shared/import";
import { MANUAL_RUNS_PER_DAY } from "@shared/run-scope";
import type { Env } from "../env";
import type { Db } from "../lib/db";
import { badRequest } from "../lib/errors";
import { utcDay } from "../lib/time";
import type { ProjectRow } from "../platform/access";
import { requireWorkspaceMember } from "../platform/access";
import { credentialSources, type CredentialProviderId } from "../platform/credentials";
import { dataForSeoSource } from "../platform/dataforseo-credentials";
import { isMissingTableError } from "../platform/custom-providers";
import { clip, DEMO_LABEL, uniq } from "../coverage/common";
import { sheetsStatus } from "../imports/sheets";
import { sheetSourceKey } from "../imports/source";
import { SYNC_NOW_PER_HOUR } from "../imports/sync";
import { dailyLimit, DEFAULT_PROJECT_LIMITS, GLOBAL_SCOPE_KEY, globalDailyLimit, projectScopeKey, type ProjectLimitsRow } from "../runs/budget";
import type { BudgetResource } from "../runs/context";
import { buildBrands, buildCitedDomains, buildEngineQueries, buildPromptHistory } from "./insights-geo";
import { SHEETS } from "./insights-lib";
import { buildMovers, buildStriking, buildTechnical } from "./insights-seo";

export const LIVE_INSIGHT_KINDS: readonly LiveInsightKind[] = ["striking", "movers", "technical", "engine_queries", "brands", "cited_domains", "prompt_history", "sheets", "budget"];

/** 400 unless `raw` is one of LIVE_INSIGHT_KINDS. */
export function parseInsightKind(raw: string | null | undefined): LiveInsightKind {
  const k = (raw ?? "").trim();
  if (!(LIVE_INSIGHT_KINDS as readonly string[]).includes(k)) throw badRequest(`kind must be one of ${LIVE_INSIGHT_KINDS.join(", ")}.`, { field: "kind" });
  return k as LiveInsightKind;
}

export interface InsightOptions {
  env: Env;
  userId: string;
  now: Date;
}

export async function buildLiveInsight(db: Db, p: ProjectRow, kind: LiveInsightKind, o: InsightOptions): Promise<LiveInsight> {
  switch (kind) {
    case "striking":
      return buildStriking(db, p, o.now);
    case "movers":
      return buildMovers(db, p, o.now);
    case "technical":
      return buildTechnical(db, p, o.now);
    case "engine_queries":
      return buildEngineQueries(db, p, o.now);
    case "brands":
      return buildBrands(db, p, o.now);
    case "cited_domains":
      return buildCitedDomains(db, p, o.now);
    case "prompt_history":
      return buildPromptHistory(db, p, o.now);
    case "sheets":
      return buildSheets(db, p, o);
    case "budget":
      return buildBudget(db, p, o);
  }
}

// ------------------------------------------------------------------ SEO 14 / GEO 10 sheet syncs

interface SyncRaw {
  id: string;
  spreadsheet_id: string;
  spreadsheet_title: string;
  tab: string;
  sheet_tab_id: number | null;
  destination: LiveSheetSyncRow["destination"];
  frequency_hours: number;
  enabled: number;
  next_run_at: string;
  last_run_at: string | null;
  last_status: LiveSheetSyncRow["lastStatus"];
  last_error_code: string | null;
  last_error: string | null;
  last_warning: string | null;
}

/**
 * Sheet-linked imports kept in sync (import_syncs) with the changes their imports applied in the last
 * SHEETS.recentDays days (import_changes), and for GEO-prompt tabs what they feed: their questions by record
 * status, how many of them are approved in the active prompt set, and when one was last asked.
 */
export async function buildSheets(db: Db, p: ProjectRow, o: InsightOptions): Promise<LiveSheetsInsight> {
  const ws = p.workspace_id;
  const { role } = await requireWorkspaceMember(db, o.userId, ws);
  const base = {
    kind: "sheets" as const,
    generatedAt: o.now.toISOString(),
    canManage: role === "owner",
    syncNowPerHour: SYNC_NOW_PER_HOUR,
    truncated: false,
  };
  let rows: SyncRaw[];
  try {
    rows = await db.all<SyncRaw>(
      `SELECT id, spreadsheet_id, spreadsheet_title, tab, sheet_tab_id, destination, frequency_hours, enabled, next_run_at, last_run_at, last_status,
              last_error_code, last_error, last_warning
         FROM import_syncs WHERE workspace_id = ? AND project_id = ? ORDER BY created_at, id LIMIT ?`,
      ws,
      p.id,
      SHEETS.syncs + 1,
    );
  } catch (e) {
    if (!isMissingTableError(e)) throw e;
    return { ...base, state: "setup_required", message: "Sheet syncs need database migration 0015_sheet_imports.sql to be applied.", labels: [], sheets: "disabled", activePromptSet: null, syncs: [] };
  }
  const truncated = rows.length > SHEETS.syncs;
  rows = rows.slice(0, SHEETS.syncs);
  const since = new Date(o.now.getTime() - SHEETS.recentDays * 86_400_000).toISOString();
  const [changes, imports, sheets, set] = await Promise.all([
    db.all<{ sync_id: string; action: "added" | "updated" | "removed"; n: number }>(
      `SELECT i.sync_id AS sync_id, ch.action AS action, COUNT(*) AS n
         FROM imports i JOIN import_changes ch ON ch.import_id = i.id AND ch.workspace_id = i.workspace_id AND ch.project_id = i.project_id
        WHERE i.workspace_id = ? AND i.project_id = ? AND i.sync_id IS NOT NULL AND i.status = 'completed' AND i.created_at >= ?
        GROUP BY i.sync_id, ch.action LIMIT 500`,
      ws,
      p.id,
      since,
    ),
    db.all<{ sync_id: string; n: number }>(
      `SELECT sync_id, COUNT(*) AS n FROM imports WHERE workspace_id = ? AND project_id = ? AND sync_id IS NOT NULL AND status = 'completed' AND created_at >= ?
        GROUP BY sync_id LIMIT 200`,
      ws,
      p.id,
      since,
    ),
    sheetsStatus(o.env, db, p),
    db.first<{ id: string; version: number; label: string | null }>(
      "SELECT id, version, label FROM geo_prompt_sets WHERE workspace_id = ? AND project_id = ? AND active = 1 ORDER BY version DESC LIMIT 1",
      ws,
      p.id,
    ),
  ]);
  const active = set
    ? await db.all<{ id: string; text: string; approved: number }>(
        "SELECT id, text, approved FROM geo_prompts WHERE workspace_id = ? AND project_id = ? AND prompt_set_id = ? ORDER BY position LIMIT 100",
        ws,
        p.id,
        set.id,
      )
    : [];

  // GEO-prompt tabs: records of each tab (by its source key) and the active prompts they put in the set.
  const promptSyncs = rows.filter((r) => r.destination === "geo_prompts");
  const keyOf = (r: SyncRaw) => sheetSourceKey(r.spreadsheet_id, r.sheet_tab_id, r.tab);
  const sourceKeys = uniq(promptSyncs.map(keyOf)).slice(0, 45);
  const recordCounts = new Map<string, { in_set: number; set_full: number; archived: number }>();
  const inSetKeys = new Map<string, Set<string>>();
  if (sourceKeys.length > 0) {
    const ph = sourceKeys.map(() => "?").join(", ");
    const [byStatus, inSet] = await Promise.all([
      db.all<{ source_key: string; status: string; n: number }>(
        `SELECT source_key, status, COUNT(*) AS n FROM import_records WHERE workspace_id = ? AND project_id = ? AND destination = 'geo_prompts' AND source_key IN (${ph})
          GROUP BY source_key, status LIMIT 500`,
        ws,
        p.id,
        ...sourceKeys,
      ),
      db.all<{ source_key: string; record_key: string }>(
        `SELECT source_key, record_key FROM import_records WHERE workspace_id = ? AND project_id = ? AND destination = 'geo_prompts' AND status = 'in_set' AND source_key IN (${ph})
          LIMIT 2000`,
        ws,
        p.id,
        ...sourceKeys,
      ),
    ]);
    for (const r of byStatus) {
      const c = recordCounts.get(r.source_key) ?? { in_set: 0, set_full: 0, archived: 0 };
      if (r.status === "in_set" || r.status === "set_full" || r.status === "archived") c[r.status] += Number(r.n);
      recordCounts.set(r.source_key, c);
    }
    for (const r of inSet) {
      if (!inSetKeys.has(r.source_key)) inSetKeys.set(r.source_key, new Set());
      inSetKeys.get(r.source_key)!.add(r.record_key);
    }
  }
  // Last asked: the newest stored API answer to any version of a prompt with the same text (≤ 100 active texts).
  const fedTexts = uniq(active.filter((a) => [...inSetKeys.values()].some((s) => s.has(promptKey(a.text)))).map((a) => a.text)).slice(0, 90);
  const lastAsked = new Map<string, string>();
  if (fedTexts.length > 0) {
    const asked = await db.all<{ text: string; last: string }>(
      `SELECT gp.text AS text, MAX(o.created_at) AS last
         FROM geo_prompts gp JOIN geo_observations o ON o.prompt_id = gp.id AND o.workspace_id = gp.workspace_id AND o.project_id = gp.project_id
        WHERE gp.workspace_id = ? AND gp.project_id = ? AND o.measurement_type = 'api' AND gp.text IN (${fedTexts.map(() => "?").join(", ")})
        GROUP BY gp.text LIMIT 100`,
      ws,
      p.id,
      ...fedTexts,
    );
    for (const a of asked) lastAsked.set(promptKey(a.text), a.last);
  }

  const changeMap = new Map<string, { added: number; updated: number; removed: number }>();
  for (const c of changes) {
    const m = changeMap.get(c.sync_id) ?? { added: 0, updated: 0, removed: 0 };
    if (c.action === "added" || c.action === "updated" || c.action === "removed") m[c.action] += Number(c.n);
    changeMap.set(c.sync_id, m);
  }
  const importCount = new Map(imports.map((i) => [i.sync_id, Number(i.n)]));
  const syncs: LiveSheetSyncRow[] = rows.map((r) => {
    let prompts: LiveSheetSyncRow["prompts"] = null;
    if (r.destination === "geo_prompts") {
      const key = keyOf(r);
      const c = recordCounts.get(key) ?? { in_set: 0, set_full: 0, archived: 0 };
      const keys = inSetKeys.get(key) ?? new Set<string>();
      const fed = active.filter((a) => keys.has(promptKey(a.text)));
      const asked = fed.map((a) => lastAsked.get(promptKey(a.text))).filter((x): x is string => !!x).sort();
      prompts = { inSet: c.in_set, setFull: c.set_full, archived: c.archived, approved: fed.filter((a) => a.approved === 1).length, lastAskedAt: asked[asked.length - 1] ?? null };
    }
    return {
      id: r.id,
      spreadsheetTitle: clip(r.spreadsheet_title, 200),
      tab: clip(r.tab, 120),
      destination: r.destination,
      enabled: Number(r.enabled) === 1,
      frequencyHours: Number(r.frequency_hours),
      lastRunAt: r.last_run_at,
      lastStatus: r.last_status,
      lastErrorCode: r.last_error_code,
      lastError: r.last_error ? clip(r.last_error, 300) : null,
      lastWarning: r.last_warning ? clip(r.last_warning, 300) : null,
      nextRunAt: r.next_run_at,
      recent: { days: SHEETS.recentDays, imports: importCount.get(r.id) ?? 0, ...(changeMap.get(r.id) ?? { added: 0, updated: 0, removed: 0 }) },
      prompts,
    };
  });
  const labels = [...(p.is_demo === 1 ? [DEMO_LABEL] : []), "Sheet cells are your data, shown as plain text; Okara does not measure them."];
  if (truncated) labels.push(`Only the first ${SHEETS.syncs} syncs are listed.`);
  return {
    ...base,
    state: p.is_demo === 1 ? "demo" : "ready",
    message: null,
    labels,
    truncated,
    sheets: sheets.state,
    activePromptSet: set
      ? { version: Number(set.version), label: set.label ? clip(set.label, 120) : null, approved: active.filter((a) => a.approved === 1).length, prompts: active.length }
      : null,
    syncs,
  };
}

// ------------------------------------------------------------------ SEO 15 / GEO 11 budget and quotas today

const RESOURCES: Array<{ resource: LiveBudgetLine["resource"]; label: string }> = [
  { resource: "usd_micros", label: "Priced spend" },
  { resource: "provider_calls", label: "Provider calls" },
  { resource: "jev_calls", label: "Jev calls" },
  { resource: "writer_tokens", label: "Writer tokens" },
  { resource: "crawl_pages", label: "Crawl pages" },
  { resource: "gsc_rows", label: "Search Console rows" },
  { resource: "geo_prompts", label: "GEO prompt answers" },
];

/**
 * Providers whose key can spend each globally capped resource: runs/budget.ts RESOURCE_PROVIDERS (keep in sync).
 * The global cap applies to this workspace for a resource when one of them uses the operator's key.
 */
const GLOBAL_SPENDERS: Partial<Record<LiveBudgetLine["resource"], readonly CredentialProviderId[]>> = {
  usd_micros: ["gemini", "perplexity", "openai_geo", "anthropic_geo"],
  jev_calls: ["typesafe"],
  provider_calls: ["typesafe", "writer", "gemini", "perplexity", "openai_geo", "anthropic_geo"],
  writer_tokens: ["writer"],
};

const KEY_LABELS: Array<{ provider: CredentialProviderId | "dataforseo"; label: string }> = [
  { provider: "typesafe", label: "Jev (TypeSafe)" },
  { provider: "writer", label: "Writer" },
  { provider: "openai_geo", label: "OpenAI (GEO engine)" },
  { provider: "anthropic_geo", label: "Anthropic (GEO engine)" },
  { provider: "gemini", label: "Gemini (GEO engine)" },
  { provider: "perplexity", label: "Perplexity (GEO engine)" },
  { provider: "dataforseo", label: "DataForSEO (competitor data)" },
];

/** Same semantics as runs/budget.ts: these resources also count against the operator's global caps when spent on an operator key. */
export const BUDGET_KEY_NOTE =
  "Spend on your workspace's own keys is bounded by these project limits only. Spend on the operator's keys (priced spend, provider calls, Jev calls, writer tokens) also counts against the operator's global daily allowance, shared by every project that uses those keys.";

/**
 * Today's (UTC) usage counters of the project and, for resources whose global cap applies to this workspace's
 * keys (an operator key of a provider that spends the resource; DataForSEO on the operator's credentials), the operator's global
 * counters; manual runs used of MANUAL_RUNS_PER_DAY (counted as the run quota counts them); which key each
 * provider uses (never the key).
 */
export async function buildBudget(db: Db, p: ProjectRow, o: InsightOptions): Promise<LiveBudgetInsight> {
  const ws = p.workspace_id;
  const day = utcDay(o.now);
  const [limitsRow, counters, manual, sources, dfs] = await Promise.all([
    db.first<ProjectLimitsRow>(
      "SELECT crawl_pages, gsc_rows, geo_prompts_per_run, provider_calls_per_day, usd_micros_per_day FROM project_limits WHERE workspace_id = ? AND project_id = ? LIMIT 1",
      ws,
      p.id,
    ),
    db.all<{ scope_key: string; resource: string; used: number; limit_value: number }>(
      "SELECT scope_key, resource, used, limit_value FROM usage_counters WHERE scope_key IN (?, ?) AND day = ? LIMIT 50",
      projectScopeKey(p.id),
      GLOBAL_SCOPE_KEY,
      day,
    ),
    db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM agent_runs WHERE workspace_id = ? AND project_id = ? AND trigger = 'manual' AND substr(created_at, 1, 10) = ? LIMIT 1",
      ws,
      p.id,
      day,
    ),
    credentialSources(o.env, db, ws),
    dataForSeoSource(o.env, db, ws).catch(() => null),
  ]);
  const limits = limitsRow ?? DEFAULT_PROJECT_LIMITS;
  const counter = (scope: string, resource: string) => counters.find((c) => c.scope_key === scope && c.resource === resource);
  const project: LiveBudgetLine[] = RESOURCES.map(({ resource, label }) => {
    const c = counter(projectScopeKey(p.id), resource);
    return { resource, label, used: Number(c?.used ?? 0), limit: Number(c?.limit_value ?? dailyLimit(resource as BudgetResource, limits)), counted: !!c };
  });
  const global: LiveBudgetLine[] = [];
  for (const { resource, label } of RESOURCES) {
    const cap = globalDailyLimit(resource as BudgetResource, o.env);
    if (cap === null) continue;
    // DataForSEO on the operator's credentials reserves provider calls and spend against the global caps (OPERATOR_KEY_SPEND).
    const viaDataForSeo = dfs === "operator_key" && (resource === "usd_micros" || resource === "provider_calls");
    const viaOperatorKey = (GLOBAL_SPENDERS[resource] ?? []).some((pr) => sources[pr] === "operator_key");
    if (!viaOperatorKey && !viaDataForSeo) continue;
    const c = counter(GLOBAL_SCOPE_KEY, resource);
    global.push({ resource, label, used: Number(c?.used ?? 0), limit: Number(c?.limit_value ?? cap), counted: !!c });
  }
  const keys = KEY_LABELS.map(({ provider, label }) => ({ provider, label, source: provider === "dataforseo" ? dfs : (sources[provider] ?? null) }));
  const notes = [
    `Counters for ${day} (UTC). Each provider call reserves its amount before it runs and is settled to the actual or estimated amount afterwards; a call whose outcome is unknown stays counted.`,
    BUDGET_KEY_NOTE,
    "Priced spend counts calls with a returned or configured price; calls without a price are bounded by the call and token caps only.",
    `Manual runs: ${MANUAL_RUNS_PER_DAY} per project per UTC day (a partial run counts as one; scheduled runs are not counted).`,
  ];
  if (global.length === 0) notes.push("Your workspace uses its own keys (or none) for every capped resource: only the project limits apply.");
  return {
    kind: "budget",
    state: p.is_demo === 1 ? "demo" : "ready",
    message: null,
    generatedAt: o.now.toISOString(),
    labels: p.is_demo === 1 ? [DEMO_LABEL] : [],
    truncated: false,
    day,
    project,
    global,
    manualRuns: { used: Number(manual?.n ?? 0), limit: MANUAL_RUNS_PER_DAY },
    keys,
    notes,
  };
}
