/**
 * DecisionProvider (Jev) for request-scoped routes outside an agent run, mirroring
 * runs/runtime.ts buildWriterForWorkspace: the workspace BYO key (else the operator key) through the
 * allowlisted API fetch, with calls recorded to provider_calls and budget reservations against the
 * project (provider_calls + jev_calls per attempt, see providers/typesafe.ts). Returns null when no
 * key is configured or the saved key cannot be decrypted; never a fake provider.
 */
import type { Env } from "../env";
import type { Db } from "../lib/db";
import { systemClock, type Clock } from "../lib/time";
import { resolveProviderKey } from "../platform/credentials";
import { createTypeSafeProvider } from "../providers/typesafe";
import type { DecisionProvider } from "../providers/types";
import { budgetFor, createBudget } from "../runs/budget";
import { createCallRecorder } from "../runs/calls";
import { createApiFetch } from "../runs/runtime";

export async function buildDecisionsForWorkspace(
  env: Env,
  db: Db,
  workspaceId: string,
  projectId: string,
  opts: { fetchImpl?: typeof fetch; clock?: Clock } = {},
): Promise<DecisionProvider | null> {
  let key: string | null = null;
  try {
    key = (await resolveProviderKey(env, db, workspaceId, "typesafe"))?.key ?? null;
  } catch {
    key = null; // undecryptable saved key: treat as not configured
  }
  if (!key) return null;
  const clock = opts.clock ?? systemClock;
  const scope = { workspaceId, projectId, runId: null };
  return createTypeSafeProvider({
    apiKey: key,
    model: env.TYPESAFE_MODEL,
    fetchImpl: createApiFetch(env, opts.fetchImpl ?? fetch),
    calls: createCallRecorder(db, scope, clock),
    budget: budgetFor(createBudget(db, env, scope, clock), "typesafe"),
  });
}
