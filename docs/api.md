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
| POST | /workspaces/:wid/credentials/:provider/models | platform-auth | owner; body `{apiKey?}`; `ProviderModelList` from the provider's documented list endpoint (see "Workspace model selection"); `:provider` is `typesafe`, `gemini`, `perplexity`, `openai_geo` or `anthropic_geo` |
| PUT | /workspaces/:wid/credentials/:provider/model | platform-auth | owner; body `{model: string \| null}`; the workspace's model for that provider (`null` = back to the operator default); returns provider status |
| GET | /workspaces/:wid/custom-providers | platform-auth | `CustomProvidersResponse` (member; never keys, only `keyHint`). See "Custom providers" |
| POST | /workspaces/:wid/custom-providers | platform-auth | owner; body `CustomProviderInput` `{label?, baseUrl, model, apiKey, useAsWriter?}`; 201 `CustomProvidersResponse`; 409 over 5 per workspace |
| PATCH | /workspaces/:wid/custom-providers/:id | platform-auth | owner; body `{label?, baseUrl?, model?, apiKey?}` (key optional = keep; required when the host changes); `CustomProvidersResponse` |
| DELETE | /workspaces/:wid/custom-providers/:id | platform-auth | owner; `CustomProvidersResponse` (the writer reverts to the default when it was selected) |
| POST | /workspaces/:wid/custom-providers/:id/test | platform-auth | member; `GET {base}/models` with the saved key; `{ok, detail}` (recorded as last test) |
| POST | /workspaces/:wid/custom-providers/models | platform-auth | owner; body `{baseUrl, apiKey}` or `{providerId}`; `CustomProviderModelList` |
| PUT | /workspaces/:wid/writer-source | platform-auth | owner; body `{source: "default" \| "custom:<id>"}`; `CustomProvidersResponse` |
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
| GET | /projects/:pid/live/seo?runId=&after=&limit= | runtime | `LiveSeoBoardResponse` (Live view SEO feed; see "Live view") |
| GET | /projects/:pid/live/geo?runId=&after=&limit= | runtime | `LiveGeoBoardResponse` (Live view GEO feed; see "Live view") |
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

## Custom providers (OpenAI-compatible writer)

(Rows with `role: "geo"` are custom GEO engines; see "Custom GEO engines" below. Everything here also applies
to them except writer selection.)

Routes: `src/worker/routes/custom-providers.ts`; rules: `src/worker/platform/custom-providers.ts`; table
`workspace_custom_providers` (migration 0010); types `CustomProviderStatus`, `CustomProvidersResponse`,
`CustomProviderModelList`, `CustomProviderInput`, `WriterSource` in `src/shared/types.ts`. Contract:
docs/provider-contracts.md, "Custom OpenAI-compatible provider".

- A workspace owner adds a provider with a base URL, an API key and a model id, at most 5 per workspace
  (enforced in the INSERT itself). Saving (`useAsWriter` defaults to true) makes it the workspace writer;
  `PUT /workspaces/:wid/writer-source` switches between `"default"` (the operator-configured writer:
  `WRITER_PROVIDER` / `WRITER_MODEL` with the workspace or operator writer key) and `"custom:<id>"`. One
  writer per workspace (partial unique index); deleting the selected provider reverts to the default.
- Base URL (400 `bad_request`, `details: {field: "baseUrl", reason}`): https only (`not_https`), no user
  name or password (`credentials`), default port only (`port`), no query or fragment (`query`), no IP literal
  of any form, v4 or v6, public or not (`ip_literal`), a public hostname: a dot, LDH labels, an alphabetic or
  `xn--` TLD, not `localhost`, `.local`, `.localdomain`, `.internal`, `.lan`, `.home.arpa`, `.intranet`,
  `.corp`, `.home`, `.private`, `.test`, `.example`, `.invalid`, `.onion`, `.alt`, `.arpa`, cluster
  service-discovery suffixes (`.svc`, `.cluster`, `.consul`, `.docker`, `.kube`, `.k8s`), loopback
  wildcard-DNS services (`nip.io`, `sslip.io`, `xip.io`, `localtest.me`, `lvh.me`, `vcap.me`,
  `localhost.direct`), and no name that spells an IPv4 address in four dot- or dash-separated groups
  (`127.0.0.1.example.com`, `10-0-0-1.example.com`) (`local_host`, `not_public_host`), never the
  `APP_ORIGIN` host (`own_origin`), at most 300 characters (`too_long`). Names are not resolved; a public
  name pointing at a private address is covered by Workers egress (see docs/provider-contracts.md).
  Normalised: lowercase punycode host (IDN accepted), trailing slashes and a pasted `/chat/completions`,
  `/completions` or `/models` suffix removed. Re-validated before every use.
- Other 400s name their field: `apiKey` (8-400 printable ASCII; `key_required` when a PATCH changes the
  host without a new key: a saved key is only ever sent to the host it was saved for), `model` (1-200
  characters, no control characters), `label` (optional, up to 60 characters; defaults to the host). Input
  values are never echoed. Unknown fields are 400. 412 `setup_required` without `TOKEN_ENCRYPTION_KEY_V1` or
  before migration 0010 is applied.
- `POST .../models` fetches `GET {baseUrl}/models` server-side with `Authorization: Bearer <key>`, 10 s
  timeout (headers and body), `redirect: "manual"`, through the guarded API fetch with only that host added;
  body read capped at 8 MiB. Returns `{ok, detail, models, total, truncated}`: `ok` true (model list received;
  the key was not rejected, which is not proof it works: some providers list models without checking the
  key), false (rejected 401/403, HTTP n, redirect not followed, network error or timeout, or a 2xx answer
  that is not a model list, e.g. an HTML page because the base URL lacks `/v1`) or null (429, not
  confirmed).
  Accepted shapes: `{data: [{id}]}`, `{models: [{id | name}]}`, a bare array of objects or strings; ids are
  deduped, sorted case-insensitively, capped at 500 (`truncated`), and ids over 200 characters or with control
  characters are dropped. A recognised but empty list, or one too large to read (`models: []`, `ok` true),
  means "type a model id". The
  provider's body is never echoed; model ids are untrusted plain text. With `{providerId}` the stored key is
  decrypted and sent only to the stored host. Rate limit 10 per minute per user and workspace.
- `POST .../:id/test` has the same outcomes, records `last_tested_*`, and notes whether the saved model is
  listed. Members may test; every write and the model fetch are owner-only. Every route checks
  `requireWorkspaceMember` / `requireWorkspaceOwner` and filters by `workspace_id`; another workspace's id is
  404.
- Runs and request-scoped writers (`runs/runtime.ts` `buildRunContext`, `buildWriterForWorkspace`): a selected,
  valid custom provider replaces the default writer, and its host (only the selected provider's host, only for
  that workspace) joins the run's `apiFetch` allowlist. A selected provider that cannot be used (stored URL
  no longer valid, key not decryptable) leaves the workspace without a writer (`setup_required`, a
  `runtime` run event), never a silent fallback to the default writer.
- Budget: `writer_tokens` and `provider_calls` are attributed to the workspace's own key (project limits
  only, never the `GLOBAL_*` operator caps). Cost is recorded as unknown (`cost_usd` NULL).
- Untrusted host: a draft response body over 2 MiB is cancelled and fails the attempt without a retry
  (`Response exceeded 2097152 bytes.`), and the key is scrubbed from every stored error message
  (`provider_calls.error`, run events, draft errors) even when the provider echoes it in a format the
  generic redaction does not know.
- Export: `GET /projects/:pid/export` includes `tables.workspace_custom_providers` (id, label, base URL, host,
  model, writer flag, last test, timestamps); `key_enc` and `key_hint` are never selected. Rows are deleted
  with their workspace (`ON DELETE CASCADE`).

## Workspace model selection (built-in providers)

Routes: `src/worker/routes/credentials.ts`; rules: `src/worker/platform/provider-models.ts`; table
`workspace_provider_models` (migration 0011); types `ModelSelectableProviderId`, `ModelSource`,
`ProviderModelOption`, `ProviderModelList` in `src/shared/types.ts`. Contract: docs/provider-contracts.md
"Workspace model selection".

- Providers: `typesafe`, `gemini`, `perplexity`, `openai_geo`, `anthropic_geo` (not `writer`: 404; the writer
  has the custom provider flow below). Unknown providers 404.
- Resolution (runtime `buildRunContext`, `buildDecisionsForWorkspace`, `capabilityPresence`, provider
  statuses): workspace selection > the operator env var (`TYPESAFE_MODEL`, `GEMINI_MODEL`, `PERPLEXITY_MODEL`,
  `OPENAI_GEO_MODEL`, `ANTHROPIC_GEO_MODEL`) > none = `setup_required` ("choose a model"); TypeSafe falls
  back to its documented `jev-latest` alias. `GET /workspaces/:wid/credentials` rows add `modelSource`
  (`"workspace" | "operator" | "default" | null`), `rateKnown` (false = no verified rate in
  `providers/rates.ts`, cost recorded as unknown; null for TypeSafe, the writer, or no model),
  `workspaceModel` (the stored selection, also when it is not in effect; null when none) and `modelNote`
  (plain text, see the operator-key guard; null when none).
- Operator-key spend guard (`modelForKeySource`): when the workspace has no key of its own for the provider
  and the operator key is used, a workspace-chosen GEO engine model must have a verified rate in
  `providers/rates.ts` (or equal the operator's env model). Otherwise the runtime builds no lane and logs a
  `runtime` run event, and the provider row shows `state: "setup_required"` with `modelNote` "<Vendor> model
  <id> has no verified price and this workspace uses the operator key; add your own <Vendor> key to use it."
  (the same text is the board lane's `stateDetail`; `capabilityPresence` reports the engine as not
  configured). A workspace-chosen TypeSafe model is ignored on the operator key (`TYPESAFE_MODEL`, else
  `jev-latest`; `modelNote` says so). Reason: an unpriced call reserves and settles only the flat
  unknown-rate amount, so the operator's `GLOBAL_USD_MICROS_PER_DAY` would undercount (docs/limits-and-costs.md).
- `POST .../credentials/:provider/models` (owner, CSRF, 10 per minute per user and workspace): key = the typed
  `apiKey` (8-400 printable ASCII; never stored), else the saved workspace key (decrypted server-side), else
  the operator key; none = 412 `setup_required`. GET of the documented list endpoint through the guarded API
  fetch (allowlisted hosts only), `redirect: "manual"` (a 3xx is reported, not followed), 10 s timeout
  covering the body, body capped at 8 MiB. Returns `{ok, detail, models: [{id, label}], total, truncated,
  keySource, mustSupport}`: `ok` true (list received), false (401/403 rejected, HTTP n, redirect, network
  error, not the documented shape) or null (429, unreadable or oversized list). Ids are validated per
  provider (Gemini drops the `models/` prefix and lists only `generateContent` models; Perplexity ids are
  `provider/model`), at most 200 characters, no control characters, deduped, sorted, capped at 500;
  `truncated` is also set when the provider reports more pages. Provider bodies and keys are never echoed;
  ids and labels are untrusted plain text. `mustSupport` names the feature the lane needs (for example "the
  Responses API web_search tool"); it is not verifiable from a list, so the UI says "Must support <feature>;
  the Test run will tell you". With `keySource: "operator_key"` only ids a workspace may run on that key are
  returned (verified rate; for OpenAI no `ft:` models and only `owned_by` `openai`, `system` or
  `openai-internal`), and `detail` adds "Only models with a verified price are listed with the operator key;
  add your own key to see all models." when anything was left out. TypeSafe is not listed with the operator
  key (`ok: null`, no request is made). Perplexity's list endpoint needs no authentication, so a successful
  list does not prove a Perplexity key works.
- `PUT .../credentials/:provider/model` (owner, CSRF): `{model}` validated per provider (400 `bad_request`,
  `details: {field: "model", reason: "invalid_model"}`, value never echoed; unknown fields 400); `null` deletes
  the selection. Without a saved workspace key, while the operator key is set: a GEO engine model without a
  verified rate is 400 "Add your own API key to use a model without a verified price." (`details: {field:
  "model", reason: "operator_key_unpriced"}`) unless it is the operator's env model, and a TypeSafe model is
  400 (`reason: "operator_key_model"`) unless it is the operator's model. 412 before migration 0011. Returns
  the provider status. Another workspace's id is 404 (non-members) or 403 (members who are not the owner).
- A model change changes the cohort key (prompt-set version, provider, model, grounding, sampling options),
  so trend series split by model and are never compared across models.
- Export: `tables.workspace_provider_models` (`provider`, `model`, `updated_at`). Rows cascade with the
  workspace.

## Custom GEO engines (custom OpenAI-compatible providers with role `geo`)

The custom provider routes below also manage custom GEO engines: `POST /workspaces/:wid/custom-providers` with
`role: "geo"` (`useAsWriter` is ignored). Migration 0011 adds `workspace_custom_providers.role`
(`'writer'` default for existing rows, or `'geo'`).

- At most 2 GEO engines per workspace (409 `conflict`), counted separately from the 5 writer providers; a
  GEO row is never the writer (`PUT .../writer-source` with a GEO row is 400, `details: {field: "source",
  reason: "not_writer"}`). PATCH (label, base URL, model, key), DELETE, test and Fetch models work as for
  writers. `GET .../custom-providers` returns every row with `role`, plus `maxGeoEngines` and `geoDataSent`.
  412 `setup_required` when a GEO engine is added before migration 0011.
- Runs: each valid GEO row becomes a lane with provider id `custom_geo:<id>` and its own guarded fetch that
  admits only its host (the shared `ctx.apiFetch` does not). The prompt (plus the neutral locale instruction)
  goes to `{base}/chat/completions` with `max_completion_tokens` 4096 and no tools; response body capped at
  2 MiB; HTTP errors are stored by status only. Observations: `grounded = 0`, `grounding_mode`
  `none (custom provider)`, no citations, no search queries (`searchQueriesExposed: false`), `cost_usd` NULL,
  `model` = the configured model id (never the host-reported one, so the cohort is fixed by the owner's
  selection), `request_id` only when at most 200 characters without control characters (else NULL).
  A row that cannot be used (base URL no longer valid, key not decryptable) is skipped with a `runtime` run
  event, never faked.
- Budgets: `geo_prompts` and `provider_calls` per prompt like every engine, inside `geo_prompts_per_run`;
  attributed to the tenant's own key (project limits only, never the `GLOBAL_*` operator caps); no
  `usd_micros` reservation (unknown price). `MAX_GEO_PROVIDERS` (daily `geo_prompts` ceiling) is 6: four
  built-in engines plus two custom.
- Metrics: mention rate and tracked-brand share of voice only. `citationRate` counts grounded responses only
  (`geo/metrics.ts`), so a custom lane's citation rate is always unavailable (denominator 0).
- Labels: `GeoResults` lanes (label `<name> (<host>) · Custom · no web search proof · mention rate only`, plus
  a disclosure in `labels`), `EngineBoardResponse` (custom lanes after the four built-in lanes, same label, a
  disclosure in `labels`; a removed engine with history shows as setup_required "removed"), and the run
  activity window (lane label, answer detail suffix, title "Custom engine answered ..."). On the board a
  custom lane shows its prompt feed, mention rate and "Citation rate: not measured (no web search proof)"
  only; it never requests `/geo/pages/:id/skip-factors` (which accepts the four built-in engines only) and
  shows no cited pages or rewrite plans. Its "API-sampled" tooltip says "without web search".
- Proposals: custom lanes are not inputs to GEO recommendations (`geo/proposals.ts`); their answers count
  toward mention rate only.

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

## Live view (UI spec docs/live-view-design.md; types in `src/shared/types.ts`, section "Live view")

Two read-only, run-scoped feeds. The Live view needs them for structured fields that `RunActivity` does
not carry.

**Not repeated here:** steps, page reads, provider calls, lanes, queued pairs, spend and elapsed time all
stay in `GET /runs/:runId/activity`, which is the view's 2 s heartbeat.

**What both routes share:**
- **Access:** both resolve the project with `requireProject()`. Every query filters `workspace_id` and
  `project_id`, plus `run_id` or the run's crawl attempt, and every query has a `LIMIT`.
- **Bound parameters:** dynamic `IN` lists use `inChunks`, 90 values per statement, so every statement
  stays under D1's 100 bound parameters.
- **No side effects:** no provider call, no Jev, no budget.
- **Untrusted text:** titles, snippets, prompts, queries, URLs and errors are clipped plain text. Render
  them as text.
- **Unknown cost** is null, never $0.

**Implementation files:**
- Builders: `src/worker/live/seo.ts`, `src/worker/live/geo.ts`.
- Element map: `src/worker/live/elements.ts` (`LIVE_SEO_ELEMENT_MAP`).
- Routes: `src/worker/routes/live.ts`, mounted with one line in `app.ts`.

**Parameters (both routes):**
- `runId` is required: 400 `bad_request` (`details: {field: "runId"}`) when missing.
- 404 `not_found` unless the run belongs to this project and workspace (another tenant's run is 404,
  never 403).
- 400 `bad_request` (`details: {reason: "agent_mismatch"}`) when the run's agent is not the route's agent.
- `limit` defaults to 100 and is capped at 200; a non-positive or non-integer value is 400.
- `after` is the opaque cursor from the previous response. A malformed cursor, or one from the other
  route, is 400.

**Cursor:**
- The cursor is base64url JSON holding one insertion high-water mark (SQLite `rowid`) per source, the
  same approach as "Run activity". Writers stamp rows with times taken before the insert, so `at` is not
  insertion order.
- Each source selects rows with `rowid` above its mark, in `rowid` order, with a `LIMIT`. The sources are
  merged by repeatedly taking the head with the smallest `(at, id)` until `limit`, so each mark advances
  exactly over the rows read.
- Rows read but not shown, such as a decision for a question with no element, still advance their mark.
- Each list in the response is ascending by `(at, id)`. Clients merge pages by `id`: an item can be older
  than items of a previous page.
- With nothing new, the request's cursor is echoed (null when none was given). Without `after`, rows start
  at the beginning of the run, so a client pages forward until the lists are empty, then polls.

**Totals:**
- `totals` always cover the whole run, regardless of `after`.
- They are computed with grouped queries, never by loading every row. For example, element verdicts group
  by `question_id`, `tier`, and the band or option taken with
  `COALESCE(json_extract(answer_json,'$.answer.noul'), json_extract(answer_json,'$.noul'))` and the
  `$.answer.choice` / `$.choice` equivalents.
- Each grouped query is limited to 500 groups. `totals.truncated` is true when any cap was hit; counts are
  then lower bounds.

**Polling:**
- No rate limit. The UI fetches a feed only after the heartbeat reports new rows of that kind, or every 6 s
  while the run is active, and never while the tab is hidden.
- Demo projects return their seeded demo runs' rows, with `labels` including "Demo data - simulated run".

### GET /projects/:pid/live/seo?runId=&after=&limit= → `LiveSeoBoardResponse`

Sources and cursor keys `{d, f, r, k?}`:

| List | Source (key) | id | at | Notes |
|---|---|---|---|---|
| `elements` (role element/action) | `decision_records` of the run (`d`) | `dec:<id>` | `created_at` | Ids are the same as the `jev_decision` activity items. Element and verdict come from `LIVE_SEO_ELEMENT_MAP` using the STORED `tier` and raw `answer_json` (code, never Jev text). Question-less rows whose `answer_json.kind` is `internal_link_suggestion` become `Links` rows with the suggester's stored tier and Noul and `linkSuggestionId`. Rows of non-element questions are skipped |
| `queries` | same rows (`d`) | `dec:<id>` | `created_at` | Questions `seo.query_relevance`, `seo.buyer_query`, `seo.buyer_ready`, `seo.query_intent`. `query` from `answer_json.query`, else the readable candidate key; a row with no recoverable query text is skipped. `band`: act → yes/no (noul ≥ 0.5), flag → middle, else null |
| `elements` (role rule) | `audit_findings` of the run's crawl attempt (`f`, plus `k` = `crawl_runs.started_at` as in "Run activity", so a retried crawl restarts the mark) | `find:<id>` | `created_at` | Rules mapped in `LIVE_SEO_ELEMENT_MAP.rules`; class fact → change, heuristic → review; unmapped rules skipped |
| `recommendations` | `recommendations` of the run (`r`) | `rec:<id>` | `created_at` | Stage and status as stored at read time (`totals.pipeline` carries current counts) |

- **Row enrichment:** one batched query per kind for the rows of the page only.
  - **Target:** the candidate's recommendation (`recommendations.dedup_key = decision_records.candidate_key`,
    same run), via `target_json`. Fallback: the first http(s) segment of the readable candidate key in
    `answer_json.candidate`. Fallback: the finding's `url` or `template`.
  - **`pageId`:** `pages` by normalized URL.
  - **`now`:** the element's value in the page's snapshot from this run's crawl (else the latest
    snapshot): title, meta description, first H1, first paragraph, JSON-LD types, word count,
    last updated, canonical, robots meta, status code. Clipped to 160.
  - **`proposed`:** `suggested_snippet` of the candidate's recommendation, clipped to 160.
  - **`gsc` (elements):** page metrics from the latest usable sync's current window (`pageMetrics`;
    `basis` page_rows, or query_page_rows as a lower bound).
  - **`gsc` (queries):** query rows of the same window.
  - **`jev`:** carries only stored fields: `noul` for Noul, and `choice`/`confidence` for Choice. A
    Noul never has a confidence.
- **`gscSync`:** the newest `gsc_syncs` row with `run_id` = the run (error clipped to 200). It is null
  when the run did not sync; the UI then uses `GET /seo/overview` for charts.
- **`totals`:**
  - **`elements`:** counts verdicts over element and rule rows. Action rows count only for candidates
    with no element-question row in the run (`candidate_key NOT IN (…)` subquery).
  - **`queries`:** distinct query keys and band counts per question; `intent` counts per Choice option.
  - **`pipeline`:** `candidates` and `judged` are distinct `candidate_key`s with decisions in the run,
    excluding query-batch keys; `judged` is those with a non-null `provider`. `rejectedByReason` counts
    distinct rejected candidates by `reason_code`. `created`, `byStage` and `byStatus` count the run's
    recommendations.

### GET /projects/:pid/live/geo?runId=&after=&limit= → `LiveGeoBoardResponse`

Sources and cursor keys `{o, r}`:

| List | Source (key) | id | at | Notes |
|---|---|---|---|---|
| `answers` | `geo_observations` of the run with `measurement_type = 'api'` (`o`) | `obs:<id>` | `created_at` | Ids are the same as the `engine_answer` activity items. `outcome` uses `answerOutcome` (AI engine board definition). While the run is active, an `ok` answer not yet analysed holds back the source for at most 120 s (`OBS_HOLD_MS`), exactly as "Run activity"; after that it is sent with `outcome: null` and re-sent with the same `id` once analysed |
| `recommendations` | `recommendations` of the run (`r`) | `rec:<id>` | `created_at` | As for SEO (agent `geo`) |

- **Answer enrichment:** batched over the page's observation ids.
  - **From the self brand row** (`geo_brand_observations`, `is_self = 1`): `position` (`list_rank`, only
    in a real list), `sentiment` with its stored `method`, and `recommendationStatus`.
  - **From `geo_citations`** (ordered by `position`, resolved with `resolveCitation`): `citedInstead` is
    the first non-own citation, `ownCitedUrl` the first own one, and `citationCount` the total.
  - **`searchQueryCount`:** from `geo_search_queries`; null when the provider does not expose them
    (`usage_json`).
  - **`latencyMs`:** the `geo_answer%` provider call joined on `request_id`.
  - **`cost`:** the observation's `cost_usd` and `cost_is_estimate`.
  - **`matchedPage`:** `coverage/answer-coverage.ts` `matchPrompt` over the latest crawl's pages, using
    the answer's own engine search queries and the latest GSC page data. It is computed at most once per
    request, and only when the page has at least one answer.
- **`plannedPrompts`:** only when `after` is absent. It uses the same selection as `geo/batch.ts` and the
  activity lanes: approved prompts of the run's prompt set (the active set before any answer), ordered by
  position, capped by `project_limits.geo_prompts_per_run` (or `DEFAULT_PROMPTS_PER_RUN`), at most 200.
  It is null on later pages or when unknown.
- **`totals.lanes`:** one entry per provider with answers in the run. Lanes without answers come from
  `RunActivity.lanes`.
  - `cited`, `named`, `missing`, `failed` and `pending` (stored `ok` answers not yet analysed) are
    counted over all the run's answers (cap 2,000, as in "Run activity").
  - `cost` follows `laneCost`: value null when any cost is unknown, `isEstimate` when any is estimated.
  - `citedInstead` is the host most often first-cited among the lane's `missing` and `named` answers,
    with that answer count.
- **`totals.pipeline`:** as for SEO, over the run's GEO decisions and recommendations.
- **Not shown:** a per-run citation rate. The UI derives it from the lane counts and always shows the
  numerator and denominator. There is no score, projection, or prompts-per-second rate.
