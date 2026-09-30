/**
 * Cohort key for GEO trend comparability. Two observations are comparable only when every input here
 * matches: prompt-set version, provider, exact model id, grounding mode, and sampling options.
 * A change to any of them starts a new series (annotated by geo-analysis).
 */
import { hashJson } from "../lib/hash";

export interface CohortInput {
  promptSetVersion: number;
  provider: string;
  model: string;
  groundingMode: string;
  /** Provider request options that can change answers (e.g. maxOutputTokens, tools). null = none. */
  samplingOptions: Record<string, unknown> | null;
}

/** First 16 hex chars of sha256(stable JSON of the cohort inputs). */
export async function cohortKey(input: CohortInput): Promise<string> {
  const hex = await hashJson({
    promptSetVersion: input.promptSetVersion,
    provider: input.provider,
    model: input.model,
    groundingMode: input.groundingMode,
    samplingOptions: input.samplingOptions ?? null,
  });
  return hex.slice(0, 16);
}
