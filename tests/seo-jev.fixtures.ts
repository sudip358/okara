/**
 * Helpers for the [A23]/[A25] SEO Jev tests (labelled fixtures, not live data). Builds on the
 * seo-analysis fixture in tests/fixtures/gsc/site.ts.
 */
import { Db } from "@worker/lib/db";
import type { DecisionAnswer, DecisionRequest } from "@worker/providers/types";
import { baseQuestionId } from "@worker/seo/questions";
import { buildCandidates, type Candidate, type CandidateConfig } from "@worker/seo/recommend/candidates";
import { judgeCandidate } from "@worker/seo/recommend/decide";
import { loadCandidateInputs } from "@worker/seo/recommend/inputs";
import { approveAll, fakeDecisions, type AnswerFn } from "./fixtures/gsc/site";
import type { Scenario } from "./fixtures/gsc/scenario";

export type Override = DecisionAnswer | undefined | ((req: DecisionRequest, id: string) => DecisionAnswer | undefined);

/** approveAll, with per-question overrides keyed by full id ("seo.covers_topic#t1") or base id. */
export function answers(overrides: Record<string, Override>): AnswerFn {
  return (id, req) => {
    const o = id in overrides ? overrides[id] : overrides[baseQuestionId(id)];
    if (o === undefined && !(id in overrides) && !(baseQuestionId(id) in overrides)) return approveAll(id, req);
    return typeof o === "function" ? o(req, id) : o;
  };
}

/** Update the latest snapshot of a crawled URL. */
export async function patchSnapshot(s: Scenario, url: string, fields: Record<string, unknown>): Promise<void> {
  const db = new Db(s.env.DB);
  const sets = Object.keys(fields).map((k) => `${k} = ?`).join(", ");
  await db.run(`UPDATE page_snapshots SET ${sets} WHERE final_url = ?`, ...Object.values(fields), url);
}

export async function candidatesOf(s: Scenario, config: Partial<CandidateConfig> = {}) {
  const inputs = await loadCandidateInputs(s.ctx());
  return { inputs, candidates: buildCandidates(inputs, config) };
}

/** Judge one candidate through the real decision path with a fake Jev. */
export async function judgeWith(s: Scenario, c: Candidate, fn: AnswerFn) {
  const inputs = await loadCandidateInputs(s.ctx());
  const jev = fakeDecisions(fn);
  const judgment = await judgeCandidate(s.ctx({ decisions: jev }), c, inputs, ["ev_1"]);
  return { judgment, request: jev.requests[0] ?? null, jev };
}
