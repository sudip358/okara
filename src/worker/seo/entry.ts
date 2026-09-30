/**
 * SEO agent step entry points (contracts). Implementations:
 *   runCrawl                   -> seo-crawl module   (src/worker/seo/crawl/*)
 *   syncGsc                    -> seo-analysis module (src/worker/seo/gsc/*)
 *   generateSeoRecommendations -> seo-analysis module (src/worker/seo/recommend/*)
 * Each returns a compact summary persisted into agent_runs.summary_json.
 */
export { runCrawl } from "./crawl/run";
export { syncGsc } from "./gsc/sync";
export { generateSeoRecommendations } from "./recommend/generate";
