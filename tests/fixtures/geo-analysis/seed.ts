/** Test seeding for geo-analysis: observations stored the way geo/batch.ts stores them. */
import { Db } from "@worker/lib/db";
import { newId } from "@worker/lib/ids";
import type { Env } from "@worker/env";
import type { DecisionAnswer, DecisionProvider, DecisionRequest } from "@worker/providers/types";
import answers from "./answers.json";
import { FIXED_NOW } from "../../helpers/fixtures";

export type FixtureName = Exclude<keyof typeof answers, "_note">;

export interface FixtureCase {
  prompt: string;
  grounded: boolean;
  answer: string | null;
  status?: string;
  citations: Array<{ url: string; title: string | null; position: number | null }>;
}

export function fixture(name: FixtureName): FixtureCase {
  return answers[name] as FixtureCase;
}

export interface SeedObservationOptions {
  provider?: string;
  model?: string;
  cohortKey?: string;
  promptType?: "discovery" | "reputation";
  promptId?: string | null;
  runId?: string | null;
  createdAt?: string;
  searchQueries?: string[] | null;
  status?: "ok" | "failed" | "incomplete";
  costUsd?: number | null;
}

export async function seedObservation(env: Env, project: { id: string; workspaceId: string }, c: FixtureCase, o: SeedObservationOptions = {}): Promise<string> {
  const db = new Db(env.DB);
  const id = newId("gobs");
  const status = o.status ?? ((c.status as "ok" | "failed" | undefined) ?? "ok");
  const provider = o.provider ?? "gemini";
  const model = o.model ?? "gemini-test-model";
  const exposed = o.searchQueries !== undefined && o.searchQueries !== null;
  await db.insert("geo_observations", {
    id,
    workspace_id: project.workspaceId,
    project_id: project.id,
    run_id: o.runId ?? null,
    prompt_id: o.promptId ?? null,
    prompt_set_id: null,
    prompt_text: c.prompt,
    prompt_type: o.promptType ?? "discovery",
    cohort_key: o.cohortKey ?? `cohort-${provider}-1`,
    provider,
    model,
    grounding_mode: provider === "gemini" ? "google_search" : "sonar_web",
    measurement_type: "api",
    imported_surface: null,
    status,
    grounded: status === "ok" && c.grounded ? 1 : 0,
    raw_answer: status === "failed" ? null : c.answer,
    request_id: "req-test",
    usage_json: JSON.stringify({ searchQueriesExposed: status !== "failed" && exposed }),
    cost_usd: o.costUsd === undefined ? 0.01 : o.costUsd,
    cost_is_estimate: 1,
    error: status === "failed" ? "HTTP 500" : null,
    created_by: null,
    created_at: o.createdAt ?? FIXED_NOW.toISOString(),
  });
  if (status !== "failed") {
    for (const cit of c.citations) {
      await db.insert("geo_citations", {
        id: newId("gcit"),
        workspace_id: project.workspaceId,
        project_id: project.id,
        observation_id: id,
        url: cit.url,
        host: "",
        title: cit.title,
        position: cit.position,
        brand_key: null,
        source_type: "other",
        source_type_method: "unknown",
      });
    }
    for (const q of o.searchQueries ?? []) {
      await db.insert("geo_search_queries", {
        id: newId("gsq"),
        workspace_id: project.workspaceId,
        project_id: project.id,
        observation_id: id,
        provider,
        model,
        query: q,
        normalized: q.toLowerCase(),
        created_at: FIXED_NOW.toISOString(),
      });
    }
  }
  return id;
}

/**
 * Fake Jev: answers every question with `pick(questionKey, request)`; undefined answers are dropped.
 * Records requests for assertions.
 */
export function fakeDecisions(pick: (key: string, req: DecisionRequest) => DecisionAnswer | undefined, opts: { fail?: Error } = {}): DecisionProvider & { requests: DecisionRequest[] } {
  const requests: DecisionRequest[] = [];
  return {
    name: "typesafe",
    requests,
    async decide(req) {
      requests.push(req);
      if (opts.fail) throw opts.fail;
      const answers: Record<string, DecisionAnswer | undefined> = {};
      for (const k of Object.keys(req.questions)) answers[k] = pick(k, req);
      return { provider: "typesafe", model: "jev-test-1", answers, usage: { inputTokens: 1, outputTokens: 1 } };
    },
    async test() {
      return { ok: true, detail: "fake" };
    },
  };
}

export const choice = (c: string, confidence = 0.9): DecisionAnswer => ({ type: "choice", choice: c, confidence, probabilities: { [c]: confidence } });
export const noul = (v: number): DecisionAnswer => ({ type: "noul", noul: v });
export const score = (s: number, confidence = 0.9): DecisionAnswer => ({ type: "score", score: s, confidence, probabilities: { [String(s)]: confidence } });
