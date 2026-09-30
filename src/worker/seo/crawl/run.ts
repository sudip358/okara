import type { RunContext } from "../../runs/context";
export interface CrawlSummary { crawlRunId: string | null; pagesCrawled: number; pagesSkipped: number; findings: number; status: "completed" | "partial" | "failed" | "setup_required"; note: string }
/** STUB (seo-crawl module): crawl the verified host within limits, extract, classify, run rules. */
export async function runCrawl(_ctx: RunContext): Promise<CrawlSummary> { throw new Error("runCrawl not implemented"); }
