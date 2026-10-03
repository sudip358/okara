/**
 * Partial ("section") manual runs: request validation, dependency checks and step selection
 * (shared contract in src/shared/run-scope.ts; docs/api.md "Runs"; build-kit amendment 2026-10-03).
 *
 * - `steps` are validated against the agent's work steps (short ids or "<agent>.<id>"); validate and summary
 *   always run. Steps keep run order whatever order the request lists them in.
 * - Dependencies use the latest stored data instead of re-running predecessors: seo recommend needs a stored
 *   crawl (completed/partial) or a usable Search Console sync unless crawl or gsc_sync is in the same run; geo
 *   proposals need stored API answers in the proposal window unless batch is in the same run. Missing data ->
 *   409 "Run the crawl first" style messages. Cheap setup checks (verified host for crawl, Search Console
 *   property for gsc_sync, a configured engine for batch) answer 412 setup_required before a quota slot is used.
 * - `engines` (GEO batch only) must name configured engines of the workspace (capabilityPresence).
 * Scheduled runs never carry a scope (all steps).
 */
import type { AgentKind } from "@shared/types";
import { SECTION_STEPS, normalizeStep, type RunScope, type SectionStep } from "@shared/run-scope";
import type { Env } from "../env";
import type { Db } from "../lib/db";
import { badRequest, conflict, setupRequired } from "../lib/errors";
import { iso } from "../lib/time";
import type { ProjectRow } from "../platform/access";
import { GEO_ENGINE_IDS } from "../geo/engines";
import { isCustomGeoId } from "../geo/custom-lanes";
import { PROPOSAL_WINDOW_DAYS } from "../geo/proposals";
import { latestUsableSync } from "../seo/gsc/overview";
import { capabilityPresence } from "./runtime";
import type { StepName } from "./orchestrate";

export const MAX_SCOPE_ENGINES = 20;

/**
 * Normalize a request's steps/engines into a stored scope. Returns null for a full run (no steps given, or
 * every work step listed without an engine filter). Throws 400 for unknown steps or a misplaced engine filter.
 */
export function parseRunScope(agent: AgentKind, steps: readonly string[] | undefined, engines: readonly string[] | undefined): RunScope | null {
  if (engines !== undefined && agent !== "geo") throw badRequest("engines applies to GEO runs only.");
  if (steps === undefined) {
    if (engines !== undefined) throw badRequest("engines needs steps that include \"batch\".");
    return null;
  }
  if (steps.length === 0) throw badRequest("steps must list at least one step.");
  const wanted = new Set<SectionStep>();
  for (const raw of steps) {
    const s = normalizeStep(agent, raw);
    if (!s) throw badRequest(`Unknown ${agent.toUpperCase()} step "${String(raw).slice(0, 40)}". Valid steps: ${SECTION_STEPS[agent].join(", ")}.`);
    wanted.add(s);
  }
  const ordered = (SECTION_STEPS[agent] as readonly SectionStep[]).filter((s) => wanted.has(s));
  let engineList: string[] | null = null;
  if (engines !== undefined) {
    if (!ordered.includes("batch")) throw badRequest("engines needs steps that include \"batch\".");
    if (engines.length === 0) throw badRequest("engines must list at least one engine.");
    if (engines.length > MAX_SCOPE_ENGINES) throw badRequest(`At most ${MAX_SCOPE_ENGINES} engines.`);
    engineList = Array.from(new Set(engines.map((e) => e.trim())));
    for (const e of engineList) {
      if (!(GEO_ENGINE_IDS as readonly string[]).includes(e) && !isCustomGeoId(e)) throw badRequest(`Unknown engine "${e.slice(0, 60)}".`);
    }
  }
  if (ordered.length === SECTION_STEPS[agent].length && engineList === null) return null;
  return { steps: ordered, engines: engineList };
}

/** Stored step names a run executes: validate, the scoped work steps (all when scope is null), summary. */
export function stepsForScope(agent: AgentKind, all: readonly StepName[], scope: RunScope | null): StepName[] {
  if (!scope) return [...all];
  const keep = new Set(scope.steps.map((s) => `${agent}.${s}`));
  return all.filter((s) => s.endsWith(".validate") || s.endsWith(".summary") || keep.has(s));
}

/**
 * Pre-flight for a scoped run (no provider calls, no quota used): throws 409 when a step needs stored data that
 * does not exist yet, 412 when the step's own setup is visibly missing. Full runs are not pre-checked (their
 * steps report setup_required themselves, as before).
 */
export async function checkScopeReady(env: Env, db: Db, project: ProjectRow, agent: AgentKind, scope: RunScope | null, now: Date): Promise<void> {
  if (!scope) return;
  const has = (s: SectionStep) => scope.steps.includes(s);
  const ws = project.workspace_id;
  const pid = project.id;
  if (agent === "seo") {
    if (has("crawl") && !project.verified_host) throw setupRequired("Site ownership is not verified; verify the site (Search Console, DNS or file) before running the crawl.");
    if (has("gsc_sync") && !project.gsc_property) throw setupRequired("No Search Console property selected; connect Search Console and pick a property first.");
    if (has("recommend") && !has("crawl") && !has("gsc_sync")) {
      const [crawl, sync] = await Promise.all([
        db.first<{ id: string }>("SELECT id FROM crawl_runs WHERE workspace_id = ? AND project_id = ? AND status IN ('completed', 'partial') LIMIT 1", ws, pid),
        latestUsableSync(db, ws, pid),
      ]);
      if (!crawl && !sync) throw conflict("Run the crawl first: judging and drafting use the latest stored crawl and Search Console sync, and this project has neither yet.");
    }
    return;
  }
  if (has("batch")) {
    const presence = await capabilityPresence(env, db, ws, now);
    const configured = new Set<string>([...GEO_ENGINE_IDS.filter((p) => presence[p]), ...presence.customGeoEngines]);
    if (configured.size === 0) throw setupRequired("No AI engine is configured; add a Gemini, Perplexity, OpenAI or Anthropic key and model (or a custom GEO engine) on the Integrations page.");
    for (const e of scope.engines ?? []) {
      if (!configured.has(e)) throw setupRequired(`The engine ${e} is not configured for this workspace; set it up on the Integrations page.`);
    }
  }
  if (has("proposals") && !has("batch")) {
    const since = iso(new Date(now.getTime() - PROPOSAL_WINDOW_DAYS * 86_400_000));
    const obs = await db.first<{ id: string }>(
      "SELECT id FROM geo_observations WHERE workspace_id = ? AND project_id = ? AND measurement_type = 'api' AND status = 'ok' AND created_at >= ? LIMIT 1",
      ws,
      pid,
      since,
    );
    if (!obs) throw conflict(`Ask the AI engines first: proposals use stored answers from the last ${PROPOSAL_WINDOW_DAYS} days, and there are none yet.`);
  }
}
