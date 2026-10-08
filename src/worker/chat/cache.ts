/**
 * Short-lived read-tool result cache for Ask Okara [A40]: the same read tool with the same normalized arguments in
 * the same chat session (same workspace, project and user) within CHAT_TOOL_CACHE_TTL_MS reuses the earlier result
 * instead of running the tool again (the model often repeats a call in a later round or a follow-up question).
 *
 *  - Never cached: actions (confirm-gated), output tools (navigate, export_csv) and errors.
 *  - "Live" tools (provider/API calls or fast-changing run status) are cached too (it avoids repeating a
 *    rate-limited live call), except when the user's message asks for fresh data (REFRESH_RE).
 *  - A confirmed action clears the session's entries (its data may have changed).
 * Memory only, per Worker isolate, bounded (CHAT_TOOL_CACHE_MAX entries, oldest dropped): reuse is guaranteed within
 * one turn and best-effort across turns. Keys are scoped by workspace, project, user and session.
 */
import type { ToolOutput } from "./tool-base";

export const CHAT_TOOL_CACHE_TTL_MS = 120_000;
export const CHAT_TOOL_CACHE_MAX = 300;

/** Read tools whose result comes from a live call or changes quickly: skipped when the user asks to refresh. */
export const LIVE_TOOLS: readonly string[] = ["search_console_live_query", "maton_data", "provider_models", "list_runs", "run_activity", "run_detail", "backlinks"];

/** The user asked for fresh data in their own message. */
export const REFRESH_RE = /\b(?:refresh|re-?run|re-?check|re-?fetch|again|latest|fresh|up[- ]to[- ]date|right now|yet|still)\b/i;

export interface CachedResult {
  content: string;
  summary: string;
  navigate: ToolOutput["navigate"];
}

const entries = new Map<string, { at: number; value: CachedResult }>();

/** Arguments with sorted keys, trimmed strings and empty values dropped. */
export function normalizeArgs(input: unknown): string {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v.trim();
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        const x = (v as Record<string, unknown>)[k];
        if (x === undefined || x === null || x === "") continue;
        out[k] = walk(x);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(input ?? {}));
}

export interface ToolCache {
  get(tool: string, input: unknown): CachedResult | null;
  set(tool: string, input: unknown, value: CachedResult): void;
}

/** Cache view for one chat session; `bypassLive` = the user asked for fresh data. */
export function sessionToolCache(scope: string, nowMs: () => number, opts: { bypassLive?: boolean } = {}): ToolCache {
  const cacheable = (tool: string) => !(opts.bypassLive && LIVE_TOOLS.includes(tool));
  const key = (tool: string, input: unknown) => `${scope}\u0000${tool}\u0000${normalizeArgs(input)}`;
  return {
    get(tool, input) {
      if (!cacheable(tool)) return null;
      const k = key(tool, input);
      const e = entries.get(k);
      if (!e) return null;
      if (nowMs() - e.at >= CHAT_TOOL_CACHE_TTL_MS) {
        entries.delete(k);
        return null;
      }
      return e.value;
    },
    set(tool, input, value) {
      if (!cacheable(tool)) return;
      const k = key(tool, input);
      entries.delete(k);
      entries.set(k, { at: nowMs(), value });
      while (entries.size > CHAT_TOOL_CACHE_MAX) entries.delete(entries.keys().next().value as string);
    },
  };
}

export const sessionCacheScope = (workspaceId: string, projectId: string, userId: string, sessionId: string) => [workspaceId, projectId, userId, sessionId].join(":");

/** Drop every entry of a session (after a confirmed action). */
export function clearSessionCache(scope: string): void {
  for (const k of [...entries.keys()]) if (k.startsWith(`${scope}\u0000`)) entries.delete(k);
}

/** Tests. */
export function resetToolCache(): void {
  entries.clear();
}
