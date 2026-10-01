/**
 * DecisionProvider (Jev) for request-scoped routes outside an agent run, mirroring
 * runs/runtime.ts buildWriterForWorkspace: the workspace BYO key (else the operator key) through the
 * allowlisted API fetch, with calls recorded to provider_calls and budget reservations against the
 * project (provider_calls + jev_calls per attempt, see providers/typesafe.ts). The model is the workspace's
 * selection only on the workspace's own key (runs/runtime.ts does the same). Returns null when no
 * key is configured or the saved key cannot be decrypted; never a fake provider.
 */
import type { Env } from "../env";
import type { Db } from "../lib/db";
import { systemClock, type Clock } from "../lib/time";
import { resolveProviderKey, type ResolvedKey } from "../platform/credentials";
import { loadWorkspaceModels, modelForKeySource } from "../platform/provider-models";
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
  let resolved: ResolvedKey | null = null;
  try {
    resolved = await resolveProviderKey(env, db, workspaceId, "typesafe");
  } catch {
    resolved = null; // undecryptable saved key: treat as not configured
  }
  if (!resolved) return null;
  const clock = opts.clock ?? systemClock;
  const scope = { workspaceId, projectId, runId: null };
  return createTypeSafeProvider({
    apiKey: resolved.key,
    // Workspace selection > TYPESAFE_MODEL > the documented jev-latest alias (platform/provider-models.ts); on
    // the operator key the workspace's selection is ignored (operator-key spend guard, same as the runtime).
    model: modelForKeySource(env, await loadWorkspaceModels(db, workspaceId), "typesafe", resolved.source, clock()).model ?? undefined,
    fetchImpl: createApiFetch(env, opts.fetchImpl ?? fetch),
    calls: createCallRecorder(db, scope, clock),
    budget: budgetFor(createBudget(db, env, scope, clock), "typesafe"),
  });
}
