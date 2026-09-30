import type { RunContext } from "../../runs/context";
export interface GscSyncSummary { syncId: string | null; rows: number; truncated: boolean; status: "completed" | "partial" | "failed" | "no_data" | "setup_required"; note: string }
/** STUB (seo-analysis module): import finalized current + previous 28-day windows. */
export async function syncGsc(_ctx: RunContext): Promise<GscSyncSummary> { throw new Error("syncGsc not implemented"); }
