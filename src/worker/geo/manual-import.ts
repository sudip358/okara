/**
 * Manual raw-answer import (a clearly separate measurement type). A user pastes an answer they saw
 * in a consumer surface (e.g. "ChatGPT app") with the citations shown there. It is stored with
 * measurement_type 'manual_import', provider 'manual', model 'n/a', its own cohort per surface, and
 * provenance (imported_surface, created_by). It is never merged into API-sampled lanes or metrics.
 *
 * grounded = citations were provided (the surface displayed sources); this is the user's report,
 * not provider metadata, and is labelled as such everywhere it is shown.
 *
 * Analysis runs immediately with deterministic detection only (routes have no Jev context), so the
 * preflight is recorded as "unavailable" and sentiment is 'unknown' unless re-analyzed in a run.
 */
import { z } from "zod";
import type { Env } from "../env";
import type { Db } from "../lib/db";
import { hashJson } from "../lib/hash";
import { newId } from "../lib/ids";
import { iso } from "../lib/time";
import { BudgetExceededError } from "../lib/errors";
import type { RunContext } from "../runs/context";
import { analyzeObservation, type AnalyzeSummary } from "./analyze";
import { brandBlindViolations, type ProjectForPrompts } from "./prompts";

export const MANUAL_ANSWER_MAX = 20_000;

const citationSchema = z.union([
  z.string().max(2000),
  z.object({ url: z.string().max(2000), title: z.string().max(500).nullish() }),
]);

export const manualImportSchema = z.object({
  promptText: z.string().trim().min(1).max(2000),
  surface: z.string().trim().min(1).max(100),
  answer: z.string().min(1).max(MANUAL_ANSWER_MAX),
  citations: z.array(citationSchema).max(50).default([]),
  promptType: z.enum(["discovery", "reputation"]).optional(),
});

export type ManualImportInput = z.infer<typeof manualImportSchema>;

export function normalizeManualCitations(list: ManualImportInput["citations"]): { ok: Array<{ url: string; title: string | null }>; invalid: string[] } {
  const ok: Array<{ url: string; title: string | null }> = [];
  const invalid: string[] = [];
  for (const c of list) {
    const url = typeof c === "string" ? c.trim() : c.url.trim();
    const title = typeof c === "string" ? null : (c.title ?? null);
    try {
      const u = new URL(url);
      if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password) throw new Error("scheme");
      ok.push({ url: u.toString(), title });
    } catch {
      invalid.push(url.slice(0, 200));
    }
  }
  return { ok, invalid };
}

/** "(manual)" is always part of the stored surface label so it can never read as an API lane. */
export function manualSurfaceLabel(surface: string): string {
  const s = surface.trim().replace(/\s+/g, " ");
  return /\bmanual\b/i.test(s) ? s : `${s} (manual)`;
}

/** A minimal, provider-free RunContext for request-scoped analysis (no Jev, no writer, no network). */
export function requestScopedContext(env: Env, db: Db, project: { id: string; workspaceId: string }, now: Date): RunContext {
  const blocked: typeof fetch = async () => {
    throw new Error("Network access is not available in request-scoped analysis.");
  };
  return {
    env,
    db,
    clock: () => now,
    project,
    runId: null,
    log: { async event() {} },
    budget: {
      async reserve(resource) {
        throw new BudgetExceededError(resource, "No budget in request-scoped analysis.");
      },
      async settle() {},
      async release() {},
      async markUnknown() {},
    },
    calls: { async record() {} },
    apiFetch: blocked,
    crawlFetch: blocked,
    decisions: null,
    writer: null,
    geoProviders: [],
    gsc: null,
    async isCancelled() {
      return false;
    },
  };
}

export interface ManualImportResult {
  observationId: string;
  promptType: "discovery" | "reputation";
  importedSurface: string;
  grounded: boolean;
  analysis: AnalyzeSummary;
  invalidCitations: string[];
}

export async function importManualObservation(
  env: Env,
  db: Db,
  project: ProjectForPrompts,
  userId: string,
  input: ManualImportInput,
  now: Date,
): Promise<ManualImportResult> {
  const { ok: citations, invalid } = normalizeManualCitations(input.citations);
  // A prompt that names a tracked brand is a reputation prompt unless the user said otherwise.
  const promptType = input.promptType ?? (brandBlindViolations(input.promptText, project).length > 0 ? "reputation" : "discovery");
  const surface = manualSurfaceLabel(input.surface);
  const cohortKey = `manual:${(await hashJson({ surface: surface.toLowerCase() })).slice(0, 16)}`;
  const matched = await db.first<{ id: string; prompt_set_id: string }>(
    `SELECT p.id, p.prompt_set_id FROM geo_prompts p JOIN geo_prompt_sets s ON s.id = p.prompt_set_id AND s.active = 1
      WHERE p.workspace_id = ? AND p.project_id = ? AND lower(trim(p.text)) = lower(trim(?)) LIMIT 1`,
    project.workspace_id,
    project.id,
    input.promptText,
  );
  const id = newId("gobs");
  await db.insert("geo_observations", {
    id,
    workspace_id: project.workspace_id,
    project_id: project.id,
    run_id: null,
    prompt_id: matched?.id ?? null,
    prompt_set_id: matched?.prompt_set_id ?? null,
    prompt_text: input.promptText,
    prompt_type: promptType,
    cohort_key: cohortKey,
    provider: "manual",
    model: "n/a",
    grounding_mode: citations.length > 0 ? "manual_citations" : "none",
    measurement_type: "manual_import",
    imported_surface: surface,
    status: "ok",
    grounded: citations.length > 0 ? 1 : 0,
    raw_answer: input.answer.slice(0, MANUAL_ANSWER_MAX),
    request_id: null,
    usage_json: JSON.stringify({ citations: citations.map((c, i) => ({ url: c.url, title: c.title, position: i + 1 })), provenance: "manual_import" }),
    cost_usd: null,
    cost_is_estimate: 1,
    error: null,
    created_by: userId,
    created_at: iso(now),
  });
  const ctx = requestScopedContext(env, db, { id: project.id, workspaceId: project.workspace_id }, now);
  const analysis = await analyzeObservation(ctx, id);
  return { observationId: id, promptType, importedSurface: surface, grounded: citations.length > 0, analysis, invalidCitations: invalid };
}
