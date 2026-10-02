# Resources

Every external reference used while specifying and building this product, with what we took from each and where it landed. Keep it current: add a row whenever a new reference informs the spec or the code, and re-review this list before each milestone.

- **Status:** Adopted = in the spec and/or code. Partly = some ideas taken, others rejected. Rejected = reviewed, nothing taken. Unreachable = couldn't be read.
- **Where:** amendment tags (`[A1]`–`[A25]`) refer to [`docs/build-kit.md`](docs/build-kit.md) section 1; section numbers refer to that file too.
- Last updated: 2026-10-02.

---

## 1. Reference products and demos

| Resource | Type | What it showed | What we took | Rejected / caveats | Where | Status |
|---|---|---|---|---|---|---|
| [Okara](https://okara.ai) | Product site | "AI CMO" with 10+ agents, 5 strategy docs, auto-publishing, 20+ integrations | Shared, versioned context documents read before decisions | Auto-publishing; unbenchmarked customer and ROI claims | §3.1, onboarding | Partly |
| [Okara on X: "We ran all 6 Okara agents on Jev"](https://x.com/askokara/status/2102319722671047139) (2026-09-22) | 19.6 s demo video | CMO decision feed, agent cards, SEO/GEO proposal cards with fit scores | Proposal card anatomy `[A2]`, decision log incl. skips `[A3]`, "cited instead" `[A1]` | Citation rate that didn't match its own counts; instant "indexed #8" outcomes; unsourced Vol/KD; "30x faster" | §3.1 | Partly |
| [Ryze AI (Ira Bodnar) on X: "Jev dropped the price of SEO/GEO fixes by 90%"](https://x.com/irabukht/status/2101090579127951694) (2026-09-18) | 6 s demo video, labelled "Simulated run" | Per-engine lanes (model, grounding, cost), our-page vs cited-page analysis, pages rewritten | Engine lanes `[A8]`, engine search-query capture `[A6]`, side-by-side diagnostic `[A7]`, template-level fixes `[A9]`, product-fact guardrail `[A10]` | Single "citability /10" score; projected revenue `[A11]`; implausibly low cost per grounded prompt | §3.2 | Partly |
| Okara dashboard screenshot (provided in chat; layout reference only) | Image | Status log, context panel, SEO/GEO tabs, funnel, needs-attention feed, chat | Overview layout `[A12]` | Links tab (no backlink source); AI chat (deferred) | §3.3 | Adopted |
| "Jev × SEO + GEO" (Rankie concept; provided in chat) | Image, labelled "illustrative data, not a live Jev run" | Page audit, competitor gaps, answer coverage, citation evidence panels | Coverage views `[A22]` | Treated as a mockup, not evidence of Jev speed | `[A22]` | Adopted |
| "Jev killed 7 more SEO/GEO workflows" (X post text + 3 s video provided in chat; video labelled "Simulated run") | Same 4-panel mockup as the Rankie concept, plus 7 claimed workflows | Confirms coverage of element keep/change, answer coverage, buyer-query sorting, link map, draft gate. Candidates: competitor-page assessment on user-approved URLs, buyer sorting over the full GSC export, 15 link candidates per page, more draft checks | Per-page "citation chance" and "after" % (predictions, no evidence); Google/ChatGPT rank without a SERP source; projected click gains; "steal" framing (we adapt, never copy) | `[A22]`, `[A23]`, `[A25]` | Partly |

## 2. Okara graphics (provided in chat as images)

| Resource | What we took | Rejected / caveats | Where | Status |
|---|---|---|---|---|
| "The only GEO checklist you'll need" (Access, Content, Structure, Mentions, Trust, Tracking) | GEO readiness checklist (36 items, measured/heuristic/manual labels) | IndexNow isn't used by Google; "re-run in ChatGPT/Claude/Gemini" is API-sampled here; no automated outreach | `[A21]` | Adopted |
| "The only SEO checklist you'll need" (Technical, On-page, Quick wins, Content, Links) | SEO readiness checklist (40 items) | Items needing unconnected data (GA4, CWV, volume/KD, backlinks, PAA) shown as not connected; no Google scraping | `[A21]` | Adopted |
| "SEO tactics, ranked by impact" (S–D tier list) | Tier badge and ordering within checklist sections, labelled as external opinion | Never used in recommendation priority; project data overrides it | `[A21]` | Partly |
| "The AI crawler cheat sheet" (search/answer bots vs training bots) | Crawler purposes, added Googlebot, Bingbot, Applebot, ChatGPT-User, Applebot-Extended, CCBot; robots.txt advisor | Its paste-in snippet would drop existing `*` disallows (RFC 9309 group selection); the advisor preserves them | `[A19]` | Adopted |
| "On-page SEO checklist" (16 items in 4 phases) | Per-page checklist | Core Web Vitals not connected | `[A21]` | Adopted |
| "The Search Demand Curve" (fat head, chunky middle, long tail) | First-party demand curve from GSC impressions | Not market search volume; no volume/KD without a keyword data source | SEO agent, overview | Adopted |

## 3. Articles and posts about Jev for SEO

| Resource | What we took | Rejected / caveats | Where | Status |
|---|---|---|---|---|
| [Prefer: "JEV for SEO: 10 SEO Workflows You Can Actually Use"](https://www.linkedin.com/pulse/jev-seo-10-workflows-you-can-actually-use-tryprefer-71pff/) (2026-09-22) | Redirect map tool; thin-content, page-action, schema-match, title/meta-alignment, topic-coverage questions | "Thousands of pages much faster" (unbenchmarked) | `[A23]` | Partly |
| "JEV for SEO: The AI That Can't Write, Only Decide" (LinkedIn post text pasted in chat; 6 use cases) | Freshness sweeps, answer clarity (AEO), anchor text for link suggestions | Google Page 1 composition needs an opt-in SERP provider | `[A23]` | Partly |
| [Screpy: "How to Classify Search Intent With TypeSafe AI's Jev"](https://screpy.com/blog/typesafe-jev-keyword-search-intent/) (2026-09-20) | Brand terms + locale in intent state; `mixed` intent option; brand / non-brand split | Its thresholds (0.60 / 0.85) are unvalidated; live SERP checks need a SERP provider | `[A23]` | Partly |
| [madewithjev.com: "Jev for SEO and GEO"](https://madewithjev.com/jev-for-seo) (16 workflows) | Draft/page quality check; query relevance filter; buyer-query view; Milestone 6 ideas (digests, analytics connectors, MCP server) | Citation-likelihood predictions; community per-decision prices (only official pricing is used) | `[A23]`, `[A24]` | Partly |
| [ian.is internal links tool](https://ian.is/tool/internal-links) | Internal link suggester design: TF-IDF terms, 8 targets per source, 4 sentences, anchor phrases, 4 Jev questions, role labels | Nothing rejected; we add GSC weighting and existing-link dedup | `[A25]` | Adopted |
| [ian.is](https://ian.is) and [ian.is/tools](https://ian.is/tools) (10 SEO tools, $1 reports) | Seasonality-aware content decay (YoY) with likely-cause classification, sitemap health rules, translation opportunities, cannibalisation by alternating ranking URLs, titles that preserve primary queries | Competitor content gaps need keyword data (not connected); pSEO ideas need search volume (deferred) | `[A25]` | Partly |
| [LinkedIn profile: mert-d-582b8a5a](https://www.linkedin.com/in/mert-d-582b8a5a/) | Nothing (LinkedIn blocked automated access, HTTP 999) | Ask the owner what to take from it | — | Unreachable |

## 4. Open-source Jev integrations (code reviewed)

| Resource | What we took | Rejected / caveats | Where | Status |
|---|---|---|---|---|
| [AkashPriyadarshii/jev-seo](https://github.com/AkashPriyadarshii/jev-seo) (MIT, Rust CLI + MCP) | Confirmed REST contract; Act/Flag/Drop tiers; escape options; question versioning; injection preflight; rule registry; output validator; AI-crawler check | LLM as security gate; predicted citation likelihood; substring citation matching; parsing Perplexity `citations`; DuckDuckGo scraping; GSC window ending today; non-atomic budgets | §3.4, `[A13]`–`[A20]` | Partly |
| [epergaboni/jevseo](https://github.com/epergaboni/jevseo) (MIT, Next.js) | `@typesafe-ai/sdk` usage; rubric-writing rules; gates; overlap detection; "Disagree" feedback | Hostname-only SSRF denylist; blind SSRF via robots/sitemaps; keys in localStorage; no tenancy; "opportunity" shown as projection | §3.4, `[A13]`–`[A20]` | Partly |

## 5. Official documentation (authoritative contracts)

### TypeSafe Jev
- Docs: https://docs.typesafe.ai · index: https://docs.typesafe.ai/llms.txt
- Models and pricing: https://docs.typesafe.ai/models (read 2026-09-30): `jev-1.13.0` at $0.042 per million input tokens, output tokens free; `jev-latest` and `jev-preview` both point to `jev-1.13.0`. Used for labelled cost estimates in `providers/typesafe.ts` (`JEV_RATE_VERSION`).
- Primitives: https://docs.typesafe.ai/primitives · Confidence: https://docs.typesafe.ai/confidence
- Patterns: https://docs.typesafe.ai/patterns/confidence-routing · https://docs.typesafe.ai/patterns/composite-scoring
- Cookbook: https://docs.typesafe.ai/cookbooks/citation_check
- SDK: `@typesafe-ai/sdk` (npm, v0.6.0 used)
- Third-party coverage (context only): https://www.marktechpost.com/2026/09/19/typesafe-ai-releases-jev/ · https://jevmodel.org/api/

### GEO providers
- Gemini grounding with Google Search: https://ai.google.dev/gemini-api/docs/google-search · API reference: https://ai.google.dev/api/generate-content · Pricing: https://ai.google.dev/gemini-api/docs/pricing
- Perplexity: https://docs.perplexity.ai · Agent API spec: https://docs.perplexity.ai/openapi.json · Web search tool: https://docs.perplexity.ai/docs/agent-api/tools/web-search · Pricing: https://docs.perplexity.ai/docs/getting-started/pricing (Sonar Chat Completions ended 2026-09-27)
- OpenAI web search: https://platform.openai.com/docs/guides/tools-web-search
- Anthropic web search tool: https://docs.claude.com/en/docs/agents-and-tools/tool-use/web-search-tool

### Writer (Claude API)
- Messages API and structured outputs (`output_config.format`); current models reject forced `tool_choice`. Verified via the Claude API skill; SDK `@anthropic-ai/sdk`.

### Google Search Console and identity
- https://developers.google.com/webmaster-tools/v1/searchanalytics/query
- https://developers.google.com/webmaster-tools/v1/how-tos/all-your-data
- https://developers.google.com/webmaster-tools/limits
- https://developers.google.com/identity/openid-connect/openid-connect
- https://developers.google.com/identity/protocols/oauth2/web-server

### Crawlers and robots
- Google crawlers (Googlebot, Google-Extended): https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers
- Google robots.txt: https://developers.google.com/search/docs/crawling-indexing/robots/robots_txt
- RFC 9309 (Robots Exclusion Protocol): https://www.rfc-editor.org/rfc/rfc9309
- OpenAI bots: https://developers.openai.com/api/docs/bots
- Anthropic bots: Anthropic support article 8896518 (support.claude.com)
- Perplexity bots: https://docs.perplexity.ai/guides/bots
- Bingbot: https://blogs.bing.com/webmaster/2012/05/03/to-crawl-or-not-to-crawl-that-is-bingbots-question/
- Applebot / Applebot-Extended: https://support.apple.com/en-us/119829
- CCBot: https://commoncrawl.org/ccbot
- IndexNow (Bing and participating engines; not Google): https://www.indexnow.org/documentation

### Search guidance and structured data
- Product structured data: https://developers.google.com/search/docs/appearance/structured-data/product
- Helpful, people-first content: https://developers.google.com/search/docs/fundamentals/creating-helpful-content

### Competitor data (DataForSEO)
- Auth (HTTP Basic, API login + API password): https://docs.dataforseo.com/v3/auth/ (read 2026-10-02). Free credential test with account balance (`money.balance`): https://docs.dataforseo.com/v3/appendix/user_data/ · Status codes: https://docs.dataforseo.com/v3/appendix/errors/
- DataForSEO Labs Google, Live: [ranked_keywords](https://docs.dataforseo.com/v3/dataforseo_labs/google/ranked_keywords/live/) (overview metrics + top keywords), [domain_intersection](https://docs.dataforseo.com/v3/dataforseo_labs/google/domain_intersection/live/) (keyword gap, `intersections: false`), [relevant_pages](https://docs.dataforseo.com/v3/dataforseo_labs/google/relevant_pages/live/) (top pages), [locations_and_languages](https://docs.dataforseo.com/v3/dataforseo_labs/locations_and_languages/) (free). Reviewed and not used: [domain_rank_overview](https://docs.dataforseo.com/v3/dataforseo_labs/google/domain_rank_overview/live/) (its metrics are already in ranked_keywords' `metrics.organic`). Request/response fields, example responses (test fixtures) and cost semantics in docs/provider-contracts.md "DataForSEO Labs".
- Pricing: https://dataforseo.com/pricing/dataforseo-labs/dataforseo-google-api (read 2026-10-02): $0.012 per task + $0.00012 per item ("All other endpoints"); reservation ceiling only, the recorded cost is the response `cost`. Where: `src/worker/providers/dataforseo.ts`, `src/worker/competitors/dataforseo.ts`, `[A26]`. Status: Adopted.

### Platform, libraries, security
- Cloudflare: https://developers.cloudflare.com/workers/ · /workers/platform/limits/ · /workers/static-assets/ · /workers/configuration/cron-triggers/ · /workers/runtime-apis/html-rewriter/ · /workers/runtime-apis/web-crypto/ · /d1/ · /workflows/ · /workflows/reference/limits/
- Hono: https://hono.dev/docs/ · Drizzle + D1: https://orm.drizzle.team/docs/get-started/d1-new · Zod: https://zod.dev
- OWASP SSRF prevention: https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html

## 6. Open questions to revisit

- Jev cost: estimates are recorded per call but not yet reserved against the daily dollar budget (call caps still apply). Decide whether to add them.
- Milestone 6 `[A24]`: decide on Slack/email digests, analytics connectors (GA4, Shopify, PostHog), and an MCP server.
- SERP data provider: needed for Google Page 1 composition, "People also ask", and SERP feature checks. Opt-in only; never scrape.
- Keyword data source: needed for search volume and keyword difficulty. Competitor domains now have DataForSEO Labs estimates (`[A26]`); the project's own pages and the SEO agent still have none. Decide whether gap keywords become SEO-agent evidence (needs an `external_estimate` evidence source).
- LinkedIn profile (mert-d): clarify what to take from it.
