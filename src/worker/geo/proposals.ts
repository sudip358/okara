import type { RunContext } from "../runs/context";
export interface GeoProposalSummary { candidates: number; created: number; rejected: number; note: string }
/** STUB (geo-analysis module). */
export async function generateGeoProposals(_ctx: RunContext): Promise<GeoProposalSummary> { throw new Error("generateGeoProposals not implemented"); }
