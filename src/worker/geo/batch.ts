/**
 * runGeoBatch: run the project's active, approved buyer prompts once per enabled GEO provider and
 * persist every result (including failures) as an API-sampled observation.
 *
 * Budget accounting per call (reserve BEFORE sending):
 *   geo_prompts 1, provider_calls 1, usd_micros = versioned upper bound (rates.reservationMicros)
 *   outcome ok           -> settle counts to 1, usd to actual/estimated cost (full reservation if unknown)
 *   outcome not_sent     -> release all (the provider was certainly never contacted)
 *   outcome rejected     -> settle counts to 1, usd to 0 (definite 4xx rejection, including 429)
 *   timeout / 5xx / network / unknown -> markUnknown (keep everything reserved)
 *
 * Invariants:
 *   - Failed provider calls are stored as failed observations; they are never counted as absences
 *     (geo-analysis owns metrics) and are never replaced by another provider's answer.
 *   - Search queries are stored only when the provider exposes them; otherwise usage_json records
 *     searchQueriesExposed=false ("not exposed").
 *   - Provider citations are stored as geo_citations rows with source_type 'other' /
 *     source_type_method 'unknown' / brand_key NULL; analyzeObservation classifies them in place.
 *     host = parsed hostname, or for Gemini redirect-wrapped URIs the domain given in the title
 *     ('' when it cannot be resolved).
 *   - Calls run sequentially per provider, at most two provider lanes concurrently, no retries and no
 *     repeat sampling (one sample per prompt x provider).
 */
import type { RunContext } from "../runs/context";
import type { GeoAnswer, GeoProvider } from "../providers/types";
import { BudgetExceededError } from "../lib/errors";
import { newId } from "../lib/ids";
import { iso } from "../lib/time";
import type { Row } from "../lib/db";
import { insertStatement } from "../lib/db";
import { outcomeOf, reservationMicros, scrub, usdToMicros, type GeoCallOutcome } from "../providers/rates";
import { citationHost } from "../providers/gemini";
import { cohortKey } from "./cohort";
import { analyzeObservation } from "./analyze";

export interface GeoBatchSummary { observations: number; failed: number; grounded: number; providers: string[]; status: "completed" | "partial" | "failed" | "setup_required"; note: string }

export const RAW_ANSWER_MAX_CHARS = 20_000;
export const GEO_MAX_CONCURRENT_LANES = 2;
/** Schema default of project_limits.geo_prompts_per_run, used only if the limits row is missing. */
const DEFAULT_PROMPTS_PER_RUN = 5;

interface PromptRow {
  id: string;
  text: string;
  prompt_type: string;
  locale: string;
  language: string;
}

interface BatchState {
  stop: null | "cancelled" | "budget";
  budgetNote: string | null;
  observations: number;
  failed: number;
  incomplete: number;
  grounded: number;
}

/**
 * Normalized engine search query: lowercase, trimmed, collapsed whitespace. Also NFKC and trimmed
 * surrounding quotes/punctuation so rows match geo-analysis normalizeQuery() (analyze.ts) exactly.
 */
export function normalizeSearchQuery(q: string): string {
  return q
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s"'\u201C\u201D\u2018\u2019?!.,;:]+|[\s"'\u201C\u201D\u2018\u2019?!.,;:]+$/g, "");
}

export async function runGeoBatch(ctx: RunContext): Promise<GeoBatchSummary> {
  const { db, project } = ctx;
  const providers = ctx.geoProviders;
  const providerIds = providers.map((p) => p.id);

  if (providers.length === 0) {
    await ctx.log.event("geo_batch", "skipped", "No GEO provider is configured; add a Gemini or Perplexity key and model.");
    return summary([], "setup_required", "No GEO provider is configured. Add a Gemini or Perplexity API key and model id.");
  }

  const set = await db.first<{ id: string; version: number }>(
    "SELECT id, version FROM geo_prompt_sets WHERE workspace_id = ? AND project_id = ? AND active = 1 ORDER BY version DESC LIMIT 1",
    project.workspaceId,
    project.id,
  );
  const limits = await db.first<{ geo_prompts_per_run: number }>(
    "SELECT geo_prompts_per_run FROM project_limits WHERE workspace_id = ? AND project_id = ?",
    project.workspaceId,
    project.id,
  );
  const cap = limits?.geo_prompts_per_run ?? DEFAULT_PROMPTS_PER_RUN;
  if (cap <= 0) {
    await ctx.log.event("geo_batch", "skipped", "Project limit geo_prompts_per_run is 0.");
    return summary(providerIds, "setup_required", "Project limit geo_prompts_per_run is 0; raise it to run GEO prompts.");
  }
  const prompts = set
    ? await db.all<PromptRow>(
        "SELECT id, text, prompt_type, locale, language FROM geo_prompts WHERE workspace_id = ? AND project_id = ? AND prompt_set_id = ? AND approved = 1 ORDER BY position ASC, id ASC LIMIT ?",
        project.workspaceId,
        project.id,
        set.id,
        cap,
      )
    : [];
  if (!set || prompts.length === 0) {
    await ctx.log.event("geo_batch", "skipped", "No approved prompts in the active prompt set.");
    return summary(providerIds, "setup_required", "Approve at least one prompt");
  }

  const state: BatchState = { stop: null, budgetNote: null, observations: 0, failed: 0, incomplete: 0, grounded: 0 };

  const lane = async (provider: GeoProvider) => {
    const step = `geo_batch:${provider.id}`;
    await ctx.log.event(step, "started", `${provider.label} (${provider.model}, ${provider.groundingMode}): ${prompts.length} prompt(s).`);
    let ran = 0;
    let failed = 0;
    for (const prompt of prompts) {
      if (state.stop) break;
      if (await ctx.isCancelled()) {
        state.stop = "cancelled";
        break;
      }
      const result = await runOne(ctx, provider, prompt, set.id, set.version, state);
      if (result === "stopped") break;
      ran++;
      if (result === "failed") failed++;
    }
    const status = state.stop ? "partial" : ran > 0 && failed === ran ? "failed" : "completed";
    const reason = state.stop === "budget" ? " Stopped: budget limit reached." : state.stop === "cancelled" ? " Stopped: run cancelled." : "";
    await ctx.log.event(step, status, `${ran} of ${prompts.length} prompt(s) sampled, ${failed} failed.${reason}`);
  };

  await runPool(providers, GEO_MAX_CONCURRENT_LANES, lane);

  let status: GeoBatchSummary["status"];
  let note: string;
  const counts = `${state.observations} observation(s): ${state.grounded} grounded, ${state.failed} failed, ${state.incomplete} incomplete`;
  if (state.stop === "budget") {
    status = "partial";
    note = `Budget limit reached; stopped early. ${counts}. ${state.budgetNote ?? ""}`.trim();
  } else if (state.stop === "cancelled") {
    status = "partial";
    note = `Run cancelled; stopped early. ${counts}.`;
  } else if (state.observations > 0 && state.failed === state.observations) {
    status = "failed";
    note = `All provider calls failed. ${counts}.`;
  } else {
    status = "completed";
    note = `${counts}.`;
  }
  return { observations: state.observations, failed: state.failed, grounded: state.grounded, providers: providerIds, status, note };
}

function summary(providers: string[], status: GeoBatchSummary["status"], note: string): GeoBatchSummary {
  return { observations: 0, failed: 0, grounded: 0, providers, status, note };
}

async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

type OneResult = "ok" | "failed" | "stopped";

async function runOne(ctx: RunContext, provider: GeoProvider, prompt: PromptRow, promptSetId: string, promptSetVersion: number, state: BatchState): Promise<OneResult> {
  const reservedUsd = reservationMicros(provider.id, provider.model, ctx.clock());

  // 1. Reserve before sending.
  const held: Array<{ resource: "geo_prompts" | "provider_calls" | "usd_micros"; id: string }> = [];
  try {
    held.push({ resource: "geo_prompts", id: await ctx.budget.reserve("geo_prompts", 1) });
    held.push({ resource: "provider_calls", id: await ctx.budget.reserve("provider_calls", 1) });
    held.push({ resource: "usd_micros", id: await ctx.budget.reserve("usd_micros", reservedUsd) });
  } catch (e) {
    for (const h of held) await ctx.budget.release(h.id);
    if (e instanceof BudgetExceededError) {
      state.stop = "budget";
      state.budgetNote = `Limit: ${e.resource}.`;
      await ctx.log.event(`geo_batch:${provider.id}`, "info", `Budget limit reached (${e.resource}); no further GEO calls.`);
      return "stopped";
    }
    throw e;
  }

  // 2. Call the provider. A thrown error from an adapter is an unknown outcome.
  let answer: GeoAnswer;
  let outcome: GeoCallOutcome | null;
  try {
    answer = await provider.ask(prompt.text, { locale: prompt.locale, language: prompt.language });
    outcome = outcomeOf(answer) ?? (answer.status === "failed" ? null : "ok");
  } catch (e) {
    outcome = null;
    answer = failedAnswer(provider, `Provider adapter error: ${scrub(String((e as Error)?.message ?? e), "")}`);
  }

  // 3. Settle / release / markUnknown.
  const [gp, pc, usd] = held as [(typeof held)[0], (typeof held)[0], (typeof held)[0]];
  if (outcome === "ok") {
    await ctx.budget.settle(gp.id, 1);
    await ctx.budget.settle(pc.id, 1);
    await ctx.budget.settle(usd.id, answer.costUsd === null ? reservedUsd : usdToMicros(answer.costUsd));
  } else if (outcome === "not_sent") {
    for (const h of held) await ctx.budget.release(h.id);
  } else if (outcome === "rejected") {
    await ctx.budget.settle(gp.id, 1);
    await ctx.budget.settle(pc.id, 1);
    await ctx.budget.settle(usd.id, 0);
  } else {
    for (const h of held) await ctx.budget.markUnknown(h.id);
  }

  // 4. Record the provider call (not for calls that were certainly never sent).
  if (outcome !== "not_sent") {
    await ctx.calls.record({
      provider: provider.id,
      model: answer.model || provider.model,
      purpose: "geo_answer",
      status: outcome === "ok" ? "ok" : outcome === "timeout" ? "timeout" : outcome === "rejected" || outcome === "server_error" ? "error" : "unknown",
      requestId: answer.requestId,
      inputTokens: answer.usage.inputTokens,
      outputTokens: answer.usage.outputTokens,
      searchRequests: answer.usage.searchRequests,
      costUsd: answer.costUsd,
      costIsEstimate: answer.costIsEstimate,
      rateVersion: answer.rateVersion,
      latencyMs: answer.latencyMs,
      error: answer.error,
    });
  }

  // 5. Persist the observation, its provider citations, and exposed search queries atomically.
  const observationId = await persistObservation(ctx, provider, prompt, promptSetId, promptSetVersion, answer, outcome);
  state.observations++;
  if (answer.status === "failed") state.failed++;
  if (answer.status === "incomplete") state.incomplete++;
  if (answer.status !== "failed" && answer.grounded) state.grounded++;

  // 6. Analysis must never lose the stored observation.
  try {
    await analyzeObservation(ctx, observationId);
  } catch (e) {
    await ctx.log.event(`geo_batch:${provider.id}`, "failed", `Analysis failed for observation ${observationId}: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
  }
  return answer.status === "failed" ? "failed" : "ok";
}

function failedAnswer(provider: GeoProvider, error: string): GeoAnswer {
  return {
    provider: provider.id,
    model: provider.model,
    groundingMode: provider.groundingMode,
    status: "failed",
    grounded: false,
    text: null,
    citations: [],
    searchQueries: null,
    requestId: null,
    usage: { inputTokens: null, outputTokens: null, searchRequests: null },
    costUsd: null,
    costIsEstimate: true,
    rateVersion: null,
    error,
    latencyMs: 0,
  };
}

async function persistObservation(
  ctx: RunContext,
  provider: GeoProvider,
  prompt: PromptRow,
  promptSetId: string,
  promptSetVersion: number,
  answer: GeoAnswer,
  outcome: GeoCallOutcome | null,
): Promise<string> {
  const now = iso(ctx.clock());
  const id = newId("gobs");
  const model = answer.model || provider.model;
  const groundingMode = answer.groundingMode || provider.groundingMode;
  const samplingOptions = (provider as { samplingOptions?: Record<string, unknown> }).samplingOptions ?? null;
  const cohort = await cohortKey({ promptSetVersion, provider: provider.id, model, groundingMode, samplingOptions });
  const failed = answer.status === "failed";
  const text = failed ? null : answer.text;
  const exposedFlag = (answer as { searchQueriesExposed?: unknown }).searchQueriesExposed;
  const searchQueriesExposed = !failed && (typeof exposedFlag === "boolean" ? exposedFlag : answer.searchQueries !== null);
  const queries = !failed && answer.searchQueries ? answer.searchQueries : [];

  const usage = {
    inputTokens: answer.usage.inputTokens,
    outputTokens: answer.usage.outputTokens,
    searchRequests: answer.usage.searchRequests,
    searchQueriesExposed,
    rateVersion: answer.rateVersion,
    latencyMs: answer.latencyMs,
    outcome: outcome ?? "unknown",
    finishReason: (answer as { finishReason?: unknown }).finishReason ?? null,
    rawAnswerTruncated: text !== null && text.length > RAW_ANSWER_MAX_CHARS,
    samplingOptions,
  };

  const statements: Array<[string, ...unknown[]]> = [
    insertStatement("geo_observations", {
      id,
      workspace_id: ctx.project.workspaceId,
      project_id: ctx.project.id,
      run_id: ctx.runId,
      prompt_id: prompt.id,
      prompt_set_id: promptSetId,
      prompt_text: prompt.text,
      prompt_type: prompt.prompt_type,
      cohort_key: cohort,
      provider: provider.id,
      model,
      grounding_mode: groundingMode,
      measurement_type: "api",
      imported_surface: null,
      status: answer.status,
      grounded: !failed && answer.grounded ? 1 : 0,
      raw_answer: text === null ? null : text.slice(0, RAW_ANSWER_MAX_CHARS),
      request_id: answer.requestId,
      usage_json: JSON.stringify(usage),
      cost_usd: answer.costUsd,
      cost_is_estimate: answer.costIsEstimate ? 1 : 0,
      error: answer.error,
      created_by: null,
      created_at: now,
    } satisfies Row),
  ];

  if (!failed) {
    for (const c of answer.citations) {
      statements.push(
        insertStatement("geo_citations", {
          id: newId("gcit"),
          workspace_id: ctx.project.workspaceId,
          project_id: ctx.project.id,
          observation_id: id,
          url: c.url,
          host: citationHost(c.url, c.title) ?? "",
          title: c.title,
          position: c.position,
          brand_key: null,
          source_type: "other",
          source_type_method: "unknown",
        }),
      );
    }
    const seen = new Set<string>();
    for (const q of queries) {
      const normalized = normalizeSearchQuery(q);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      statements.push(
        insertStatement("geo_search_queries", {
          id: newId("gsq"),
          workspace_id: ctx.project.workspaceId,
          project_id: ctx.project.id,
          observation_id: id,
          provider: provider.id,
          model,
          query: q.trim(),
          normalized,
          created_at: now,
        }),
      );
    }
  }

  await ctx.db.batch(statements);
  return id;
}
