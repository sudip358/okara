import type { RunContext } from "../../runs/context";
export interface RecommendSummary { candidates: number; created: number; rejected: number; note: string }
/** STUB (seo-analysis module): shortlist -> Jev -> priority -> writer -> validate -> save (0-2/day). */
export async function generateSeoRecommendations(_ctx: RunContext): Promise<RecommendSummary> { throw new Error("generateSeoRecommendations not implemented"); }
