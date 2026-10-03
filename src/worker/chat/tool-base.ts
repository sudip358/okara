/**
 * Ask Okara tool building blocks shared by every tool module (tools.ts, tools-gsc.ts, tools-dataforseo.ts):
 * the tool shapes, the per-request context, the safe error type and small formatting helpers. Kept separate so
 * the tool modules can import it without an import cycle through the registry in tools.ts.
 */
import type { z } from "zod";
import type { ChatStepKind } from "@shared/types";
import type { Env } from "../env";
import type { Db } from "../lib/db";
import type { ProjectRow } from "../platform/access";
import type { DecisionProvider } from "../providers/types";
import type { Budget } from "../runs/context";
import type { RunRouteDeps } from "../routes/runs";

/** Max characters of any single untrusted string (titles, answers, evidence) inside a result. */
export const TOOL_TEXT_MAX = 300;

// ------------------------------------------------------------------ context
export interface ChatToolHooks {
  /** Manual-run start (tests). */
  runDeps?: RunRouteDeps;
  /** Competitor approval dependencies (tests). */
  competitorFetch?: typeof fetch;
  competitorDecisions?: (env: Env, db: Db, workspaceId: string, projectId: string) => Promise<DecisionProvider | null>;
  competitorBudget?: (env: Env, db: Db, workspaceId: string, projectId: string) => Budget;
  /** Base fetch behind the provider allowlist for the live Search Console query (tests). */
  gscFetch?: typeof fetch;
  /** Base fetch behind the provider allowlist for DataForSEO calls made from chat (tests). */
  dataforseoFetch?: typeof fetch;
}

export interface ToolContext {
  env: Env;
  db: Db;
  project: ProjectRow;
  userId: string;
  now: Date;
  waitUntil?: (p: Promise<unknown>) => void;
  hooks?: ChatToolHooks;
}

/** A tool failure the model (and the user) may see; never contains secrets. */
export class ToolError extends Error {}

export interface ToolOutput {
  /** JSON handed to the model (capped). */
  data: unknown;
  /** One-line plain-text summary for the step list. */
  summary: string;
  navigate?: { path: string; label: string } | null;
  download?: { filename: string; columns: string[]; rows: Array<Array<string | number | null>>; truncated: boolean } | null;
}

interface ToolBase<S extends z.ZodType> {
  name: string;
  description: string;
  kind: ChatStepKind;
  schema: S;
}
export interface ReadTool<S extends z.ZodType = z.ZodType> extends ToolBase<S> {
  kind: "read" | "output";
  run(ctx: ToolContext, input: z.infer<S>): Promise<ToolOutput>;
}
export interface ActionTool<S extends z.ZodType = z.ZodType> extends ToolBase<S> {
  kind: "action";
  /** Validate and describe; throws ToolError when the action cannot be proposed. Never changes state. */
  prepare(ctx: ToolContext, input: z.infer<S>): Promise<{ title: string; detail: string }>;
  /** Runs only after the user confirmed (service.ts). */
  execute(ctx: ToolContext, input: z.infer<S>): Promise<ToolOutput>;
}
export type ChatTool = ReadTool | ActionTool;

// ------------------------------------------------------------------ helpers
export const clip = (v: unknown, max = TOOL_TEXT_MAX): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
export const ratioValue = (r: { numerator: number; denominator: number; value: number | null } | null | undefined) =>
  r ? { value: r.value === null ? null : Math.round(r.value * 1000) / 1000, of: `${r.numerator}/${r.denominator}` } : null;
export const pct = (cur: number, prev: number) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);
export const round1 = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 10) / 10 : null);
/** CTR as a 0..1 value rounded to 4 places, null without impressions. */
export const ctrOf = (clicks: number, impressions: number) => (impressions > 0 ? Math.round((clicks / impressions) * 10000) / 10000 : null);
export const projectRoute = (projectId: string, sub = "") => `/projects/${encodeURIComponent(projectId)}${sub ? `/${sub}` : ""}`;

export function scoped(ctx: ToolContext): [string, string] {
  return [ctx.project.workspace_id, ctx.project.id];
}

// ------------------------------------------------------------------ admin-tool helpers (tools-admin*.ts)
/**
 * Keys that are never handed to the model, whatever service returned them (defence in depth; the admin tools also
 * pick fields by hand): encrypted columns, key hints, tokens, secrets, passwords, OAuth state and verifiers.
 */
export const SECRET_KEY_RE = /(key_?enc|_enc$|keyhint|key_?hint|api_?key|secret|password|passwd|token$|token_|tokens?_?enc|refresh_?token|access_?token|csrf|cookie|authorization|verifier|session_?id|state_?hash|dnsrecord|filecheck)/i;

/**
 * Deep copy of a service result for the model: drops secret-looking keys, clips every string (control characters
 * removed) to `maxStr`, cuts arrays to `maxItems` (recording the original length in `<key>Total`), and stops at
 * `depth`. Untrusted text stays a JSON string value: data, never instructions.
 */
export function compact(value: unknown, opts: { maxStr?: number; maxItems?: number; depth?: number } = {}): unknown {
  const maxStr = opts.maxStr ?? TOOL_TEXT_MAX;
  const maxItems = opts.maxItems ?? 25;
  const walk = (v: unknown, depth: number): unknown => {
    if (v === null || v === undefined) return v ?? null;
    if (typeof v === "string") return clip(v, maxStr);
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "boolean") return v;
    if (depth <= 0) return Array.isArray(v) ? `[${v.length} item(s)]` : "[…]";
    if (Array.isArray(v)) return v.slice(0, maxItems).map((x) => walk(x, depth - 1));
    if (typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (SECRET_KEY_RE.test(k)) continue;
        out[k] = walk(x, depth - 1);
        if (Array.isArray(x) && x.length > maxItems) out[`${k}Total`] = x.length;
      }
      return out;
    }
    return null;
  };
  return walk(value, opts.depth ?? 7);
}

/** The signed-in user's role in the project's workspace (membership re-checked on every call). */
export async function memberRole(ctx: ToolContext): Promise<"owner" | "member"> {
  const m = await ctx.db.first<{ role: "owner" | "member" }>("SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?", ctx.project.workspace_id, ctx.userId);
  if (!m) throw new ToolError("You are no longer a member of this workspace.");
  return m.role;
}

/** Owner-only actions: the same rule as the route (requireWorkspaceOwner); members get a plain explanation. */
export async function requireOwnerTool(ctx: ToolContext, what: string): Promise<void> {
  if ((await memberRole(ctx)) !== "owner") throw new ToolError(`Only the workspace owner can ${what}.`);
}
