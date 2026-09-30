import type { RunContext } from "../runs/context";
export interface GeoBatchSummary { observations: number; failed: number; grounded: number; providers: string[]; status: "completed" | "partial" | "failed" | "setup_required"; note: string }
/** STUB (geo-providers module). */
export async function runGeoBatch(_ctx: RunContext): Promise<GeoBatchSummary> { throw new Error("runGeoBatch not implemented"); }
