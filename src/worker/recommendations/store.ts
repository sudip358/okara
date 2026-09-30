/**
 * Recommendation persistence with dedup and the 0-2 per day cap. Both agents write through here.
 * Reruns never overwrite status: dismissed/approved/implemented rows persist and block duplicates [A18].
 */
import type { AgentKind, EvidenceBullet, Level, Scope, Tier } from "@shared/types";
import { newId } from "../lib/ids";
import { iso, utcDay } from "../lib/time";
import type { RunContext } from "../runs/context";

export const DAILY_CAP = 2;
/** Dismissed or recently implemented items block the same dedup key for this many days. */
export const DEDUP_BLOCK_DAYS = 30;

export interface RecommendationDraft {
  agent: AgentKind;
  scope: Scope;
  target: { kind: "url" | "template" | "site"; url?: string; template?: string; affectedUrlCount?: number; exampleUrls?: string[] };
  issueType: string;
  trigger: string;
  issue: string;
  action: string;
  suggestedSnippet?: string | null;
  rationale: string;
  effort: Level;
  uncertainty: Level;
  limitations: string;
  verified: boolean;
  priority: number;
  priorityVersion: string;
  decisionTier: Tier | null;
  decisionFields: Record<string, number | string> | null;
  evidenceIds: string[];
  evidenceBullets: EvidenceBullet[];
  confirmPlaceholders: string[];
  /** project + url/template + issue type + evidence hash */
  dedupKey: string;
  writerProvider: string | null;
  writerModel: string | null;
}

/** True if an equivalent recommendation is open, or was dismissed/implemented recently. */
export async function isDuplicate(ctx: RunContext, dedupKey: string): Promise<boolean> {
  const since = new Date(ctx.clock().getTime() - DEDUP_BLOCK_DAYS * 86400_000);
  const row = await ctx.db.first(
    `SELECT id FROM recommendations
      WHERE workspace_id = ? AND project_id = ? AND dedup_key = ?
        AND (status IN ('open', 'approved') OR updated_at >= ?)
      LIMIT 1`,
    ctx.project.workspaceId,
    ctx.project.id,
    dedupKey,
    iso(since),
  );
  return row !== null;
}

/** How many new recommendations this agent may still emit today (0..DAILY_CAP). */
export async function remainingToday(ctx: RunContext, agent: AgentKind): Promise<number> {
  const day = utcDay(ctx.clock());
  const row = await ctx.db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM recommendations
      WHERE workspace_id = ? AND project_id = ? AND agent = ? AND substr(created_at, 1, 10) = ?`,
    ctx.project.workspaceId,
    ctx.project.id,
    agent,
    day,
  );
  return Math.max(0, DAILY_CAP - (row?.n ?? 0));
}

export async function saveRecommendation(ctx: RunContext, d: RecommendationDraft, isDemo = false): Promise<string> {
  const id = newId("rec");
  const now = iso(ctx.clock());
  await ctx.db.batch([
    [
      `INSERT INTO recommendations (id, workspace_id, project_id, run_id, agent, scope, target_json, issue_type, trigger, issue, action,
         suggested_snippet, rationale, effort, uncertainty, limitations, verified, priority, priority_version, decision_label,
         decision_score_json, evidence_ids_json, evidence_bullets_json, confirm_placeholders_json, dedup_key, status, stage,
         writer_provider, writer_model, is_demo, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'open', 'awaiting_approval', ?,?,?,?,?)`,
      id, ctx.project.workspaceId, ctx.project.id, ctx.runId, d.agent, d.scope, JSON.stringify(d.target), d.issueType, d.trigger,
      d.issue, d.action, d.suggestedSnippet ?? null, d.rationale, d.effort, d.uncertainty, d.limitations, d.verified ? 1 : 0,
      d.priority, d.priorityVersion, d.decisionTier, d.decisionFields ? JSON.stringify(d.decisionFields) : null,
      JSON.stringify(d.evidenceIds), JSON.stringify(d.evidenceBullets), JSON.stringify(d.confirmPlaceholders), d.dedupKey,
      d.writerProvider, d.writerModel, isDemo ? 1 : 0, now, now,
    ],
    [
      "INSERT INTO recommendation_events (id, workspace_id, project_id, recommendation_id, user_id, event, note, created_at) VALUES (?,?,?,?,?,?,?,?)",
      newId("rev"), ctx.project.workspaceId, ctx.project.id, id, null, "created", null, now,
    ],
  ]);
  return id;
}
