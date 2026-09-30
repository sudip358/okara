/** Evidence rows: the only things recommendations may cite. Text is capped and treated as untrusted. */
import type { EvidenceSource } from "@shared/types";
import { hashJson } from "../lib/hash";
import { newId } from "../lib/ids";
import { iso } from "../lib/time";
import type { RunContext } from "../runs/context";

export const EVIDENCE_TEXT_MAX = 600;

export interface EvidenceInput {
  source: EvidenceSource;
  refId?: string | null;
  window?: string | null;
  text: string;
  data?: unknown;
  tainted?: boolean;
}

export async function createEvidence(ctx: RunContext, input: EvidenceInput): Promise<string> {
  const id = newId("ev");
  const text = input.text.slice(0, EVIDENCE_TEXT_MAX);
  const hash = await hashJson({ s: input.source, r: input.refId ?? null, w: input.window ?? null, t: text, d: input.data ?? null });
  await ctx.db.insert("evidence", {
    id,
    workspace_id: ctx.project.workspaceId,
    project_id: ctx.project.id,
    run_id: ctx.runId,
    source: input.source,
    ref_id: input.refId ?? null,
    window: input.window ?? null,
    text,
    data_json: input.data ?? {},
    tainted: input.tainted ? 1 : 0,
    hash,
    created_at: iso(ctx.clock()),
  });
  return id;
}

export interface EvidenceRow {
  id: string;
  source: EvidenceSource;
  ref_id: string | null;
  window: string | null;
  text: string;
  data_json: string;
  tainted: number;
  hash: string;
}

export async function loadEvidence(ctx: RunContext, ids: string[]): Promise<EvidenceRow[]> {
  if (ids.length === 0) return [];
  return ctx.db.all<EvidenceRow>(
    `SELECT id, source, ref_id, window, text, data_json, tainted, hash FROM evidence
      WHERE workspace_id = ? AND project_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
    ctx.project.workspaceId,
    ctx.project.id,
    ...ids,
  );
}
