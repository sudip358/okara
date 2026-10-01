# API contract

All routes are under `/api`. JSON bodies. Success: `{ "data": T }`. Failure: `{ "error": { code, message, details? } }`.
Types referenced below are in `src/shared/types.ts`. State-changing requests require the session cookie, a
same-origin `Origin` header, and `X-CSRF-Token` (value from `GET /api/me`). Every project-scoped route resolves
access with `requireProject(db, user.id, projectId)`; every workspace-scoped route with `requireWorkspaceMember`.

| Method | Path | Owner module | Returns |
|---|---|---|---|
| GET | /health | foundation | `{ok:true}` |
| GET | /auth/login?returnTo= | platform-auth | 302 to Google (state, nonce, PKCE); in production with no allowlist, 302 to `/?authError=signup_closed` |
| GET | /auth/callback | platform-auth | 302 to app; creates user/workspace on first login. Failures redirect to `/?authError=<code>` (see below) |
| POST | /auth/logout | platform-auth | `{ok:true}` |
| GET | /me | platform-auth | `Me` |
| POST | /auth/dev-login | platform-auth | local-only demo bypass (DEV_AUTH_BYPASS=true AND ENVIRONMENT=development AND localhost) |
| GET | /workspaces/:wid/credentials | platform-auth | `IntegrationsStatus["providers"]` (no keys) |
| PUT | /workspaces/:wid/credentials/:provider | platform-auth | body `{apiKey}`; `:provider` is `typesafe`, `gemini`, `perplexity`, `openai_geo`, `anthropic_geo` or `writer` (migration 0008 widens the CHECK); stores encrypted; returns provider status |
| POST | /workspaces/:wid/credentials/:provider/test | platform-auth | body `{apiKey?}` (tests the typed key if given, else saved); `{ok, detail}` |
| DELETE | /workspaces/:wid/credentials/:provider | platform-auth | `{ok:true}` |
| GET | /workspaces/:wid/projects | platform-projects | `Project[]` |
| POST | /workspaces/:wid/projects | platform-projects | body `ProjectInput`; `Project` |
| GET | /projects/:pid | platform-projects | `Project` |
| PATCH | /projects/:pid | platform-projects | partial `ProjectInput` + `scheduleEnabled`; `Project` |
| DELETE | /projects/:pid | platform-projects | deletes tenant data and the stored GSC token; `{ok:true, gscRevoked:false}` (`gscRevoked` is always false: no remote revoke at Google, see below) |
| GET | /projects/:pid/export | platform-projects | JSON download of all project data, no secrets |
| GET | /projects/:pid/context | platform-projects | `ContextDocument[]` (latest version per kind) |
| PUT | /projects/:pid/context/:kind | platform-projects | body `{content, facts}`; new version; `ContextDocument` |
| GET | /projects/:pid/verification | platform-projects | `VerificationStatus` |
| POST | /projects/:pid/verification/check | platform-projects | body `{method:'dns'|'file'|'gsc'}`; `VerificationStatus` (rate-limited per user and project) |
| GET | /projects/:pid/limits | platform-projects | `UsageSummary["limits"]` |
| PUT | /projects/:pid/limits | platform-projects | bounded update |
| GET | /projects/:pid/integrations | platform-projects | `IntegrationsStatus` |
| GET | /projects/:pid/gsc/connect | platform-projects | 302 to Google consent (webmasters.readonly, offline) |
| GET | /gsc/callback | platform-projects | 302 back to integrations page |
| GET | /projects/:pid/gsc/properties | platform-projects | `{siteUrl, permissionLevel}[]` |
| PUT | /projects/:pid/gsc/property | platform-projects | body `{property}`; also verifies ownership via GSC |
| DELETE | /projects/:pid/gsc | platform-projects | deletes the stored token (no remote revoke); `{ok:true, revoked:false}` (`revoked` is always false) |
| GET | /projects/:pid/seo/overview | seo-analysis | `SeoOverview` |
| POST | /projects/:pid/seo/import-csv | seo-analysis | body `{csv, window:'current'|'previous', start, end}`; labelled `csv_import` |
| GET | /projects/:pid/seo/audit | seo-crawl | `SeoAudit` |
| GET | /projects/:pid/seo/robots-suggestion?allowTraining=true|false | robots-advisor | `RobotsSuggestion` (fetches live robots.txt of the verified host through the SSRF guard; rate-limited) |
| GET | /projects/:pid/seo/page-audit | coverage | `CoverageResponse<PageAuditRow>` |
| GET | /projects/:pid/seo/content-evidence | coverage | `CoverageResponse<ContentEvidenceRow>` |
| GET | /projects/:pid/geo/answer-coverage | coverage | `CoverageResponse<AnswerCoverageRow>` |
| GET | /projects/:pid/geo/citation-evidence | coverage | `CoverageResponse<CitationEvidenceRow>` |
| POST | /projects/:pid/seo/redirect-map | redirects | body `RedirectMapRequest` → `RedirectMapResult` [A23] (user-triggered; budgeted; rate-limited) |
| POST | /projects/:pid/seo/internal-links/run | links | user-triggered run on the latest crawl (budgeted, rate-limited) → `LinkSuggestionReport` [A25] |
| GET | /projects/:pid/seo/internal-links | links | latest `LinkSuggestionReport` |
| PATCH | /projects/:pid/seo/internal-links/:id | links | body `{userStatus}` → `LinkSuggestion` |
| GET | /projects/:pid/seo/internal-links/export?format=csv\|json | links | download of current suggestions |
| GET | /projects/:pid/seo/buyer-queries | seo-jev | `CoverageResponse<BuyerQueryRow>` (non-brand, transactional/commercial intent) from the 7-day decision cache only; never calls Jev |
| POST | /projects/:pid/seo/buyer-queries | seo-jev | same response; asks Jev for queries without a cached answer (user-triggered; budgeted; rate-limited). Scope: all non-brand queries with impressions, by impressions, up to the `BUYER_QUERIES_MAX` cap (default 5,000); `completeness.total` is the in-scope count and `completeness.covered` the classified count. One POST classifies at most 200 queries (8 Jev calls); POST again to continue from the 7-day cache. At most 3 classify POSTs per project per day (only counted when Jev is configured), then `429 rate_limited` with `Retry-After` |
| GET | /projects/:pid/seo/translation-opportunities | seo-jev | `CoverageResponse<TranslationOpportunityRow>` |
| POST | /projects/:pid/seo/draft-check | draft-check | body `DraftCheckRequest` → `DraftCheckResult` (rate-limited, budgeted). Pasted drafts only: optional `pageType` (`PageType`; default article) and `productFacts` (at most 20 fields; key 1–60, value 1–300 characters after trimming); sending either with `pageId` is a 400 |
| GET | /projects/:pid/pages | seo-crawl | `PageRow[]` |
| PATCH | /projects/:pid/pages/:pageId | seo-crawl | body `{pageType}` (user correction) |
| GET | /projects/:pid/recommendations?agent=&status= | runtime | `Recommendation[]` |
| GET | /recommendations/:id | runtime | `RecommendationDetail` |
| PATCH | /recommendations/:id | runtime | body `{status?, action?, suggestedSnippet?, note?}` |
| POST | /decisions/:id/feedback | runtime | body `{humanAnswer, reason?}` [A18] |
| GET | /projects/:pid/attention | runtime | `AttentionFeed` |
| GET | /projects/:pid/runs | runtime | `RunSummary[]` |
| GET | /runs/:id | runtime | `RunDetail` |
| POST | /projects/:pid/runs | runtime | body `{agent}`; manual run (quota-limited) → `RunSummary` |
| POST | /runs/:id/cancel | runtime | `RunSummary` |
| GET | /projects/:pid/usage | runtime | `UsageSummary` |
| GET | /projects/:pid/runs/:runId/activity?after=&limit= | runtime | `RunActivity` (live activity window; see "Run activity") |
| GET | /projects/:pid/activity/current | runtime | `{runs: [{id, agent, status}]}` |
| GET | /projects/:pid/geo/prompts | geo-analysis | `GeoPromptSet` (active) |
| PUT | /projects/:pid/geo/prompts | geo-analysis | body `{prompts:[{text,promptType,stage,approved}]}`; new version |
| POST | /projects/:pid/geo/prompts/generate | geo-analysis | writer-generated brand-blind suggestions (unapproved) |
| GET | /projects/:pid/geo/results | geo-analysis | `GeoResults` |
| GET | /geo/observations/:id | geo-analysis | `GeoObservationDetail` |
| GET | /projects/:pid/geo/displacements | geo-analysis | `DisplacementSummary[]` |
| GET | /projects/:pid/geo/search-queries | geo-analysis | `SearchQuerySummary[]` |
| POST | /projects/:pid/geo/import | geo-analysis | body `{promptText, surface, answer, citations[]}` manual import |
| GET | /projects/:pid/geo/board | geo-analysis | `EngineBoardResponse` (AI engines board; read-only, never calls a provider) |
| GET | /projects/:pid/geo/pages/:pageId/skip-factors?promptId=&engine= | geo-analysis | `PageSkipFactors` (measured from the latest crawl; never calls Jev) |
| POST | /projects/:pid/geo/competitor-pages | geo-analysis | body `CompetitorPageApprovalRequest` `{url}`; 202 `CompetitorPageAssessment` (read within the request: state `assessed`, `blocked` or `failed`; 200 when a recent assessment is reused) [A7] (CSRF; rate-limited; budgeted) |
| GET | /projects/:pid/geo/competitor-pages | geo-analysis | `CompetitorPageAssessment[]` (newest first) |
| GET | /projects/:pid/geo/rewrite-plans | geo-analysis | `RewritePlansResponse` (manual plans; no publishing) |
| GET | /projects/:pid/checklists/:kind | checklists | `Checklist` for kind `seo` or `geo` [A21] |
| GET | /projects/:pid/pages/:pageId/checklist | checklists | `Checklist` kind `page` (on-page checklist for one URL) [A21] |
| PUT | /projects/:pid/pages/:pageId/checklist/:itemId | checklists | body `{checked, note?}` for manual items on that page |
| PUT | /projects/:pid/checklists/:kind/:itemId | checklists | body `{checked, note?}` for manual items; returns `ChecklistItem` |
| POST | /demo/seed | platform-projects | DEMO_MODE only, never production: creates a labelled demo project with fixture data |

## Sign-in errors

`GET /auth/login` and `GET /auth/callback` report failures by redirecting to `/?authError=<code>`. The sign-in
allowlist codes are:

- `signup_closed`: production with neither `ALLOWED_EMAILS` nor `ALLOWED_EMAIL_DOMAINS` set. Nobody can sign in;
  `/auth/login` redirects here without contacting Google.
- `not_allowed`: the verified Google email is outside the allowlist. An existing session whose email is later
  removed from the allowlist is rejected with 401 on its next request.

Other codes (`invalid_state`, `expired_state`, `state_mismatch`, ...) mean the OAuth round trip failed and the
user should start sign-in again.

## Google token deletion (amends docs/build-kit.md, authentication and acceptance criteria)

`DELETE /projects/:pid` and `DELETE /projects/:pid/gsc` delete the locally stored Search Console token only.
They do not call Google's revoke endpoint: a revoke ends the grant for the whole Google account, which would
disconnect every other project connected with that account. `gscRevoked` and `revoked` stay in the responses for
compatibility and are always `false`. To revoke access at Google, the user removes the app at
myaccount.google.com.

## AI engine board (reference: Ryze "Jev for SEO/GEO" board; UI spec docs/geo-board-design.md)

All five routes resolve the project with `requireProject()` and filter every query by `workspace_id` and
`project_id`. Nothing on these routes projects traffic, conversions, revenue, rankings, or citation
probability [A11]; there is no aggregate "citability" score.

### GET /projects/:pid/geo/board → `EngineBoardResponse`
- One `EngineLaneSummary` per engine, fixed order `openai_geo`, `anthropic_geo`, `gemini`, `perplexity`.
  A lane is always present: `setup_required` (no key or no model env: `OPENAI_GEO_MODEL`,
  `ANTHROPIC_GEO_MODEL`, `GEMINI_MODEL`, `PERPLEXITY_MODEL`), `disabled`, `error` (e.g. Anthropic org
  setting "web search is not enabled"), `ready`, or `demo`. All four lanes are implemented
  (`src/worker/providers/openai-geo.ts`, `anthropic-geo.ts`, `gemini.ts`, `perplexity.ts`); an unconfigured
  lane's `stateDetail` names the missing key or model env, with zero counts, never sample data.
- Computed from the latest cohort per engine (`geo_observations` with `measurement_type = 'api'`, same
  `cohort_key`), exactly like `GeoResults.lanes`: `citationRate` = valid answers with an own-site
  citation / valid answers; `mentionRate` likewise; `answersCitingUs` = `citationRate.numerator`;
  `answersSkippingUs` = valid answers with neither mention nor own-site citation; `citedInstead.host` = the
  host most often cited in skipping answers, `share` = those answers / `answersSkippingUs`.
- `costUsd` sums `geo_observations.cost_usd` for the cohort; `value` is null if any observation's cost is
  unknown and `isEstimate` is true if any is an estimate. `searchQueries` counts `geo_search_queries`.
- `feed`: latest observation per approved prompt, newest first, at most 50 per lane; prompts without one are
  `not_run`, and the feed is empty while the lane has never produced an observation. `latencyMs` comes from
  `provider_calls.latency_ms` joined on `request_id` (null when not linked). Manual imports never appear.
- Queries that fan out over prompts or observations are chunked to stay under D1's 100 bound parameters.

### GET /projects/:pid/geo/pages/:pageId/skip-factors?promptId=&engine= → `PageSkipFactors`
- `pageId` must belong to the project (404 otherwise). `promptId` optional (must be an approved prompt of the
  project); `engine` optional (`GeoEngineProviderId`).
- Factors come from the latest `page_snapshots` row: `answer_first` (heuristic: word index of the first
  sentence sharing the prompt's content tokens, "answer at word N"; without a prompt, first paragraph
  length), `faq_schema` (FAQPage JSON-LD types; measured), `author` (byline/author markup; measured),
  `freshness` (visible last-updated date and age in days; measured), `sources_cited` (outbound citation
  count; measured), `entity_facts` (heuristic: count of numeric/spec facts and Product/Organization
  JSON-LD properties), `compare_table` (table count; measured), `internal_links` (internal links in from
  the latest crawl; measured). No crawl → `state: "ready"` with every factor `unknown` and `basis`
  "No crawl yet"; a page skipped by the crawler carries its `skipped_reason` in `basis`. `citedPage` is filled only from an `assessed` competitor assessment for the
  `citedInsteadHost` URL.
- Read-only: never calls Jev or fetches a page. No budget.

### POST /projects/:pid/geo/competitor-pages → 202 `CompetitorPageAssessment`
- Requires session, same-origin `Origin`, `X-CSRF-Token`. Body `{url}` (max 2,048 chars, http or https, no credentials, default port; IP-literal and local hosts refused).
- 400 `bad_request` (details `{reason: "url_not_cited"}`) unless the canonicalized URL equals a `geo_citations.url` stored for this project
  (`workspace_id` + `project_id`) on an API-sampled answer (`measurement_type = 'api'`); a URL cited only in a
  manual import (pasted text) is never approvable, and `citedIn` lists API answers only. Approval is per URL, never per domain [A7]. The host must not be the
  project's verified host (use the crawl for own pages).
- Rate limit: `COMPETITOR_PAGE_RATE_LIMIT` 10 approvals per project per hour (`hitRateLimit` key
  `competitor_page:<projectId>`), 429 with `Retry-After` when exceeded. Re-approving a URL assessed in the
  last 7 days returns the existing assessment (200) without a new fetch.
- Budget: reserves 1 `crawl_pages` unit before any external call (released when robots.txt blocks the page, so
  the page itself was never requested) and, when TypeSafe is configured, at most 2 Jev calls, each reserving
  `jev_calls` + `provider_calls` per attempt inside the TypeSafe provider: the `evidence.injection_risk`
  screen first, then the `answer_first` and `entity` Noul questions asked together;
  429 `budget_exceeded` (same mapping as `routes/geo.ts`) when the reservation fails. Measured checks
  (`depth`, `proof`, `schema`, `freshness`, `author`, `faq`) never call Jev.
- Demo projects: 400 `bad_request` (details `{reason: "demo_project"}`); they never fetch or call Jev. Body over
  8 KiB: 413 `payload_too_large`. Other 400 reasons: `invalid_url`, `blocked_url`, `own_site`, `redirect_wrapper`.
- Fetch: one GET through the SSRF guard with the allowlist set to that single host, robots.txt respected,
  redirects only to the same host or its `www.` twin, the crawler's size/time caps. robots.txt is per host
  (RFC 9309): every redirect hop is checked against its host's robots.txt before it is requested (the twin's
  file is fetched once); a disallowed hop gives `blocked` with stateDetail "robots.txt of <host> disallows the
  redirect target" and the target is never requested; only compact evidence is stored (no full text).
  Page text is untrusted evidence: it goes to Jev as `state`, never as instructions, and is screened with
  `evidence.injection_risk`.
- States: `queued` → `fetching` → `assessed` | `blocked` (robots, 401/403, login redirect, non-HTML) |
  `failed`. Each check carries `status` (`present` | `partial` | `missing` | `unknown`): the presence on their
  page used by the verdict (Jev checks are `unknown` when Jev did not answer). Without TypeSafe the measured checks still run, the Jev checks return `noul: null, tier: null`,
  the state is `assessed`, and `stateDetail` says "Jev not configured: 2 checks not run"; the injection screen is skipped and the reasons list uses measured facts only.
- `verdict` is computed by code (versioned rule `competitor-verdict.v1`): `review` if the injection screen
  flagged the page or was unavailable (a screen error or budget stop fails closed: the evidence is treated
  as untrusted, the Noul checks are not asked, and stateDetail says "Injection screen unavailable; evidence
  treated as untrusted"), any Jev check is tier `flag`, or the fetch was partial; `adapt` if 2+ checks are
  present on their page and missing on our matched page; else `skip`. Our matched page is the answer-coverage
  match for the prompt that cited the URL; when no page of ours matches (or it has no usable crawl) every
  check of ours is `unknown`, so there are no gaps and the verdict is never `adapt` (stateDetail: "No page on
  your site matches this question; compared against no page"). "Adapt" means adapting structure; the UI
  never offers to copy their text.

### GET /projects/:pid/geo/competitor-pages → `CompetitorPageAssessment[]`
Newest first, at most 100.

### GET /projects/:pid/geo/rewrite-plans → `RewritePlansResponse`
- One plan per page that has an open or approved GEO recommendation or an `adapt` competitor assessment.
  Items are measured from the latest crawl where possible (`faq`, `compare_table`, `internal_links`,
  `answer_first`, `author`, `schema`) and manual otherwise (`read_winning_page`, `map_question`,
  `indexnow`; status `unknown` with evidence "Check this yourself" until a write endpoint is specified). `indexnow` is always `optional: true`,
  labelled "Bing and participating engines, not Google".
- `gsc` is the measured last finalized 28-day window for that page (null without GSC); `aiCitations` counts
  stored answers citing the page in the same window. No projected values. `publishing` is always `"manual"`.
- `engine` is the provider of the newest API-sampled answer of this project citing the `adapt` page
  (canonical URL match; manual imports excluded), null when none.
- Read-only; no Jev, no budget. Page evidence is loaded in batched queries and internal links in are
  computed once per crawl run, so the query count does not grow with the number of plans (at most 50).

### GEO engine provider ids (`openai_geo`, `anthropic_geo`): wired
Both lanes are wired end to end. `migrations/0008_provider_credentials_geo_engines.sql` rebuilds
`provider_credentials` with the CHECK widened to the six credential providers, so workspace keys for both
lanes can be saved through `PUT /workspaces/:wid/credentials/:provider`. The shared engine list is
`src/worker/geo/engines.ts` `GEO_ENGINE_IDS`; the GEO agent is `ready` when any engine there is configured
(`routes/recommendations.ts`), and `GeoResults` lanes and the checklist provider list use the same list.
`decide.ts` `SELF_ACCOUNTING_PROVIDERS` lists Jev decision providers only; GEO engines are accounted by
`geo/batch.ts`. Demo seed data has no rows for the new lanes.

## Run activity (live activity window; types in `src/shared/types.ts`)

Read-only views over the stored rows of ONE run, so the UI can show an agent working in real time and replay
a finished run. Nothing is simulated: every item is a row the run wrote. Both routes resolve the project with
`requireProject()`; every query filters `workspace_id`, `project_id` and `run_id`, has a `LIMIT`, and keeps
dynamic `IN` lists under D1's 100 bound parameters. No provider call, no Jev, no budget. Builder:
`src/worker/runs/activity.ts`; routes: `src/worker/routes/activity.ts`.

### GET /projects/:pid/runs/:runId/activity?after=<cursor>&limit=<n> → `RunActivity`
- 404 unless the run belongs to this project and workspace. `limit` defaults to 80, max 200; a malformed
  `after` is 400.
- `items` (each page ascending by `(at, id)`; merge pages by `id`), one per stored row:
  | kind | source | id | at | notes |
  |---|---|---|---|---|
  | `step` | `run_events` | `evt:<id>` | `created_at` | title = stored message; `provider` set for `geo_batch:<engine>` steps |
  | `page_read` | `page_snapshots` via `crawl_runs.run_id` + `pages` | `snap:<id>` | `fetched_at` | detail `"200 · 1,240 words"` or `"Skipped: <reason>"`; `url` = page URL |
  | `engine_answer` | `geo_observations` (+ `geo_brand_observations`, `geo_citations`) | `obs:<id>` | `created_at` | `outcome` cited/named/missing/failed; `latencyMs` from the `geo_answer` provider call joined on `request_id`; `costUsd` from the observation |
  | `jev_decision` | `decision_records` | `dec:<id>` | `created_at` | `outcome` = stored tier (act/flag/drop; null for n/a); detail `tier · question_id [· rejected (reason)]` |
  | `provider_call` | `provider_calls` | `call:<id>` | `created_at` | every call except `geo_answer%` (those are the engine answers, not listed twice) |
- Answer outcome uses the AI engine board's definition (`answerOutcome`): `cited` = own-site citation
  (self brand row `cited`), `named` = brand mentioned without own-site citation, `missing` = neither; failed
  and incomplete answers are `failed` (never absences); an `ok` answer not yet analysed has outcome `null`
  ("awaiting analysis") and is not counted. While the run is active, an `ok` answer that is not analysed yet
  is held back (for at most 120 s after its `created_at`) and so is every later observation, so answers
  normally arrive once, with their outcome; a held answer that is later sent with a changed outcome keeps
  its `id`, so clients replace by `id`. "Cited instead" is the first non-own-site citation host.
- Untrusted text (prompts, messages, errors, URLs) is plain text clipped to 160 characters; render as text.
- `costUsd` is null when the cost is unknown; `costIsEstimate` is true only for a known, estimated cost.
- Cursor: opaque (base64url JSON); clients must not parse it. Writers stamp rows with times taken before
  the insert (snapshot batches, per-batch Jev clocks, concurrent GEO lanes), so timestamps are not insertion
  order; the cursor therefore holds one insertion high-water mark (SQLite `rowid`) per source (run events,
  snapshots, observations, decisions, provider calls). Each source selects rows with `rowid` above its mark,
  in `rowid` order, limited; the sources are merged by repeatedly taking the head with the smallest
  `(at, id)` until `limit`, so each mark advances exactly over the rows returned and the rest come on the
  next poll. A row stamped earlier than one already returned is still delivered; an item can therefore be
  older than items of a previous page. With no new items the request's cursor is echoed (null when none was
  given). Without `after`, items start at the beginning of the run, so a client pages forward until `items`
  is empty and then polls. A malformed cursor is 400.
- `totals` always cover the whole run regardless of `after`:
  `spend.usd` = sum of `provider_calls.cost_usd` of the run; null when the run has calls but none is priced
  (unknown is never $0); 0 only when the run made no calls. `unknownCalls` = calls with null cost;
  `isEstimate` = any priced call is an estimate. `pagesRead` = snapshots without `skipped_reason`;
  `pagesPlanned` = `crawl_runs.pages_limit` (null without a crawl). `answers` and `decisions` count by
  outcome / tier. No aggregated score, no projections, no rate such as prompts per second.
- `lanes` (GEO runs only): one per engine that answered or logged a `geo_batch:<engine>` step in this run,
  plus, while the run is active, each engine configured now (presence only); board order. `state`: `done`
  (lane step finished, or the run ended with answers), `asking` (lane started or has answers, run active),
  `queued` (run active, lane not started), `idle` (otherwise). `done` = answers stored; `planned` = approved
  prompts of the run's prompt set (the set its answers came from; the active set before any answer), capped
  by `project_limits.geo_prompts_per_run` (or, without a limits row, `geo/batch.ts` `DEFAULT_PROMPTS_PER_RUN`)
  like `geo/batch.ts`; 0 when the cap is 0 or less (nothing is sampled); null when unknown. Lane step events
  are applied in order, so a retried step that logs `started` again reads as `asking`; the per-observation
  "Analysis failed" event does not end a lane. `lastLatencyMs` from the lane's latest linked call.
- `queued` (GEO runs, while active): up to 12 not-yet-observed (prompt, engine) pairs, asking lanes first.
- `nowReading`: latest stored page read; snapshots are written in batches of up to 10, so it can trail the
  crawler by up to that many pages. Set while the run is active and its crawl (`crawl_runs.status`) is
  `running`; null otherwise.
- Crawl retries: a retried crawl step deletes and rewrites its page reads (SQLite may reuse their rowids), so the cursor records the crawl attempt (`crawl_runs.started_at`) and restarts the page-read mark when it changes; page reads from the abandoned attempt can remain in the client's feed although they are no longer stored.
- `run.elapsedMs` = `finished_at` (or now, while active) − `started_at`; null before start.

### GET /projects/:pid/activity/current → `{runs: Array<{id, agent, status}>}`
Active runs (`pending`/`running`) of the project, newest first (max 10); when none, the most recent finished
run of each agent, ordered by `COALESCE(finished_at, created_at)` descending across agents, so the window can
replay the latest one. Demo projects return their two demo runs (labelled simulated;
demo rows carry the run id and a time spread so the replay reads in order, with costs and latencies null).
