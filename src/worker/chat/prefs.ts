/**
 * Per-endpoint chat model facts [A40] (migrations/0023_chat_speed.sql): whether an OpenAI-compatible model endpoint
 * needs the text-tools fallback and whether it rejects streaming, remembered per (workspace, provider host, model)
 * for CHAT_MODEL_PREF_TTL_MS so later turns start in the right mode (no empty native round, no rejected stream
 * attempt). After the TTL the endpoint is probed again. Failures to read or write are ignored (defaults apply).
 */
import type { Db } from "../lib/db";
import type { Clock } from "../lib/time";

export const CHAT_MODEL_PREF_TTL_MS = 24 * 60 * 60 * 1000;

export interface ModelPrefs {
  textTools: boolean;
  noStream: boolean;
}

export interface ModelPrefStore {
  load(): Promise<ModelPrefs>;
  /** Remember the given facts (true only) for the TTL. */
  save(p: Partial<ModelPrefs>): Promise<void>;
}

export function chatModelPrefStore(db: Db, workspaceId: string, host: string, model: string, clock: Clock = () => new Date()): ModelPrefStore {
  const h = host.toLowerCase().slice(0, 253);
  const m = model.slice(0, 200);
  return {
    async load() {
      try {
        const r = await db.first<{ text_tools_until: string | null; no_stream_until: string | null }>(
          "SELECT text_tools_until, no_stream_until FROM chat_model_prefs WHERE workspace_id = ? AND host = ? AND model = ?",
          workspaceId,
          h,
          m,
        );
        const now = clock().toISOString();
        return { textTools: Boolean(r?.text_tools_until && r.text_tools_until > now), noStream: Boolean(r?.no_stream_until && r.no_stream_until > now) };
      } catch {
        return { textTools: false, noStream: false };
      }
    },
    async save(p) {
      if (!p.textTools && !p.noStream) return;
      const now = clock();
      const until = new Date(now.getTime() + CHAT_MODEL_PREF_TTL_MS).toISOString();
      try {
        await db.run(
          `INSERT INTO chat_model_prefs (workspace_id, host, model, text_tools_until, no_stream_until, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (workspace_id, host, model) DO UPDATE SET
             text_tools_until = COALESCE(excluded.text_tools_until, chat_model_prefs.text_tools_until),
             no_stream_until = COALESCE(excluded.no_stream_until, chat_model_prefs.no_stream_until),
             updated_at = excluded.updated_at`,
          workspaceId,
          h,
          m,
          p.textTools ? until : null,
          p.noStream ? until : null,
          now.toISOString(),
        );
      } catch {
        // best effort: the endpoint is probed again next turn
      }
    },
  };
}
