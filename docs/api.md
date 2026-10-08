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
| POST | /workspaces/:wid/credentials/:provider/models | platform-auth | owner; body `{apiKey?}`; `ProviderModelList` from the provider's documented list endpoint (see "Workspace model selection"); `:provider` is `gemini`, `perplexity`, `openai_geo` or `anthropic_geo` (`typesafe`: 400 `model_not_selectable`) |
| PUT | /workspaces/:wid/credentials/:provider/model | platform-auth | owner; body `{model: string \| null}`; the workspace's model for that provider (`null` = back to the operator default); returns provider status; `typesafe`: 400 `model_not_selectable` |
| GET | /workspaces/:wid/custom-providers | platform-auth | `CustomProvidersResponse` (member; never keys, only `keyHint`). See "Custom providers" |
| POST | /workspaces/:wid/custom-providers | platform-auth | owner; body `CustomProviderInput` `{label?, baseUrl, model, apiKey, useAsWriter?, useAsChat?, role?}`; 201 `CustomProvidersResponse`; 409 over 5 writers / 2 GEO engines / 3 chat models per workspace |
| PATCH | /workspaces/:wid/custom-providers/:id | platform-auth | owner; body `CustomProviderPatchInput` `{label?, baseUrl?, model?, apiKey?, keepKeyForNewHost?}` (key optional = keep; a base URL on a new host needs a new `apiKey` or `keepKeyForNewHost: true`, else 400 `key_required_for_new_host`); every change is logged (see "Base URL changes"); `CustomProvidersResponse` |
| DELETE | /workspaces/:wid/custom-providers/:id | platform-auth | owner; `CustomProvidersResponse` (the writer reverts to the default when it was selected; its change log is removed too) |
| POST | /workspaces/:wid/custom-providers/:id/test | platform-auth | member; `GET {base}/models` with the saved key; `{ok, detail, modelListed}` (recorded as last test) |
| POST | /workspaces/:wid/custom-providers/models | platform-auth | owner; body `{baseUrl, apiKey}` or `{providerId}`; `CustomProviderModelList` |
| PUT | /workspaces/:wid/writer-source | platform-auth | owner; body `{source: "default" \| "custom:<id>"}` (role `writer` rows only); `CustomProvidersResponse` |
| PUT | /workspaces/:wid/chat-model-source | platform-auth | owner; body `{source: "writer" \| "custom:<id>"}` (role `chat` rows only; [A36]); `CustomProvidersResponse`. See "Ask Okara chat model" |
| GET | /workspaces/:wid/dataforseo | competitor-data | member; `DataForSeoCredentialStatus` (`src/shared/competitor-data.ts`; never the login or password, only the password's last 4). See "Competitor data (DataForSEO)" |
| PUT | /workspaces/:wid/dataforseo | competitor-data | owner; body `{login, password}` (API login/password, 1–200 printable ASCII, login without `:`); stored AES-GCM encrypted (migration 0014); status |
| DELETE | /workspaces/:wid/dataforseo | competitor-data | owner; `{ok:true}` |
| POST | /workspaces/:wid/dataforseo/test | competitor-data | member; body `{login?, password?}` (typed pair, else the saved workspace credentials; never the operator's: 412); free `GET v3/appendix/user_data`; `DataForSeoTestResult` `{ok, detail, balanceUsd}` |
| GET | /workspaces/:wid/projects | platform-projects | `Project[]` |
| POST | /workspaces/:wid/projects | platform-projects | body `ProjectInput` (≤ 60 competitors, `MAX_COMPETITORS` in `src/shared/competitors.ts`; ≤ 5 domains and 10 aliases each; domains cleaned: hostname, lowercase, no `www.`, no path) [A39]; `Project` |
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
| GET | /projects/:pid/seo/internal-links/export?format=csv\|json\|sheet&ids=&userStatus=&status=&placement= | links | download of current suggestions; `sheet` = the owner's tracking-sheet columns (see "Internal links workbench") |
| POST | /projects/:pid/seo/internal-links/bulk | links | body `{ids (1–200), userStatus}` → `{updated, missing, suggestions}` |
| GET | /projects/:pid/seo/internal-links/graph | links | `LinkGraphSummary` (coverage, counts, rolling crawl) |
| POST | /projects/:pid/seo/internal-links/graph/rebuild | links | `LinkGraphSummary`; deterministic rebuild (no provider call), 6 per project per hour |
| GET | /projects/:pid/seo/internal-links/graph/urls?filter=&sort=&dir=&q=&offset=&limit= | links | `LinkGraphUrlPage` (per-URL link table) |
| GET | /projects/:pid/seo/internal-links/graph/url?url= | links | `LinkGraphUrlDetail` (inbound sources with anchors, outbound targets, redirect chain, anchor audit) |
| GET | /projects/:pid/seo/internal-links/graph/export | links | per-URL CSV (UTF-8 with BOM) |
| GET | /projects/:pid/seo/internal-links/clusters | links | `LinkClusterReport` |
| PUT | /projects/:pid/seo/internal-links/clusters/hub | links | body `{url, hub: true\|false\|null}` → `LinkClusterReport` |
| PUT | /projects/:pid/seo/internal-links/clusters/assign | links | body `{spokeUrl, hubUrl: url\|null}` or `{spokeUrl, reset: true}` → `LinkClusterReport` |
| GET | /projects/:pid/seo/internal-links/broken[?format=csv] | links | `BrokenLinksReport` or CSV (UTF-8 with BOM) |
| GET | /projects/:pid/seo/internal-links/anchors[?all=1] | links | `AnchorAuditReport` |
| GET | /projects/:pid/seo/internal-links/placed | links | `PlacedLinksReport` (accepted/implemented and sheet-placed links with auto-verification) |
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
| POST | /projects/:pid/runs | runtime | body `{agent, steps?, engines?}`; manual run, all steps or a partial ("section") run (quota-limited; see "Partial (section) runs") → `RunSummary` |
| POST | /runs/:id/cancel | runtime | `RunSummary` |
| GET | /projects/:pid/usage | runtime | `UsageSummary` |
| GET | /projects/:pid/runs/:runId/activity?after=&limit= | runtime | `RunActivity` (live activity window; see "Run activity") |
| GET | /projects/:pid/activity/current | runtime | `{runs: [{id, agent, status}]}` |
| GET | /projects/:pid/live/seo?runId=&after=&limit= | runtime | `LiveSeoBoardResponse` (Live view SEO feed; see "Live view") |
| GET | /projects/:pid/live/geo?runId=&after=&limit= | runtime | `LiveGeoBoardResponse` (Live view GEO feed; see "Live view") |
| GET | /projects/:pid/live/insights?kind= | live-containers | `LiveInsight` (one read-only project aggregate per Live view container; see "Live view: project containers") |
| GET | /projects/:pid/geo/prompts | geo-analysis | `GeoPromptSet` (active) |
| PUT | /projects/:pid/geo/prompts | geo-analysis | body `{prompts:[{text,promptType,stage,approved}]}`; new version |
| POST | /projects/:pid/geo/prompts/generate | geo-analysis | writer-generated brand-blind suggestions (unapproved) |
| GET | /projects/:pid/geo/prompts/from-gsc | geo-analysis | member; read-only, no provider call; `?includeBrand=1`; `GscQuestionsResponse` (question-style queries from the stored Search Console sync, [A37]). See "GEO prompts from Search Console" |
| POST | /projects/:pid/geo/prompts/from-gsc | geo-analysis | member (same as PUT /geo/prompts); body `{queries: string[1..25], setId?: string \| null, includeBrand?}`; 201 `GscQuestionsAddResult` `{set, added, skipped}`; adds UNAPPROVED prompts in a new version |
| GET | /projects/:pid/geo/results | geo-analysis | `GeoResults` |
| GET | /geo/observations/:id | geo-analysis | `GeoObservationDetail` |
| GET | /projects/:pid/geo/displacements | geo-analysis | `DisplacementSummary[]` |
| GET | /projects/:pid/geo/search-queries | geo-analysis | `SearchQuerySummary[]` |
| POST | /projects/:pid/geo/import | geo-analysis | body `{promptText, surface, answer, citations[]}` manual import |
| GET | /projects/:pid/geo/board | geo-analysis | `EngineBoardResponse` (AI engines board; read-only, never calls a provider) |
| GET | /projects/:pid/geo/pages/:pageId/skip-factors?promptId=&engine= | geo-analysis | `PageSkipFactors` (measured from the latest crawl; never calls Jev) |
| POST | /projects/:pid/geo/competitor-pages | geo-analysis | body `CompetitorPageApprovalRequest` `{url}`; 202 `CompetitorPageAssessment` (read within the request: state `assessed`, `blocked` or `failed`; 200 when a recent assessment is reused) [A7] (CSRF; rate-limited; budgeted) |
| GET | /projects/:pid/geo/competitor-pages | geo-analysis | `CompetitorPageAssessment[]` (newest first) |
| GET | /projects/:pid/competitors/dataforseo | competitor-data | member; `CompetitorDataPanel` (state, location, caps incl. `waitingDomains`, published-price ceiling, per competitor domain: latest refresh + overview + `waiting`) |
| GET | /projects/:pid/competitors/dataforseo/domains/:domain | competitor-data | member; `CompetitorDomainDetail` (top keywords, keyword gap, top pages of the latest refresh); 404 when the domain is not a current competitor |
| POST | /projects/:pid/competitors/dataforseo/refresh | competitor-data | owner; body `{domain}`; 202 `CompetitorRefreshResult` (queued, run after the response); 200 `{existing:true}` when one is already queued/running; 412 `setup_required` without credentials; 429 `quota_exceeded` over the daily caps (CSRF; rate-limited 10/min; budgeted; paid) |
| GET | /projects/:pid/competitors/dataforseo/locations | competitor-data | owner; `CompetitorLocationOption[]` from the free Labs `locations_and_languages` (rate-limited) |
| PUT | /projects/:pid/competitors/dataforseo/settings | competitor-data | owner; body `{location?: {locationCode, languageCode} \| null, autoFetch?: boolean}` (location validated against DataForSEO's list; `null` = back to the project locale); `CompetitorDataPanel` |
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
- Other 400s name their field: `apiKey` (8-400 printable ASCII; `key_required_for_new_host` and
  `key_unreadable`, see "Base URL changes" below), `keepKeyForNewHost` (`invalid` unless a boolean), `model` (1-200
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
  listed: `modelListed` true (listed), false (not in a complete, non-empty list: the UI offers "Change model")
  or null (unknown: no list, an empty or truncated list, or a failed request). Members may test; every write
  and the model fetch are owner-only. Every route checks
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
  with their workspace (`ON DELETE CASCADE`). It also includes `tables.workspace_custom_provider_changes`
  (provider id, `changed_at`, `changed_by` user id, `fields`, old/new base URL and host,
  `key_kept_for_new_host`; never key material).

### Base URL changes (tunnels) and the change log

Added 2026-10-01 (owner request: "the custom base URL keeps on changing", for tunnels such as
`*.trycloudflare.com`, `*.ngrok-free.app`, `*.loca.lt`). Same rules for writer and GEO rows.

- `PATCH .../custom-providers/:id` with a `baseUrl` on the same host (another path) keeps the saved key; no
  flag needed.
- A `baseUrl` on a NEW host with a new `apiKey`: the new key is encrypted and stored (`keepKeyForNewHost` is
  ignored).
- A `baseUrl` on a NEW host without a new key: 400 `bad_request`, `details: {field: "apiKey", reason:
  "key_required_for_new_host"}`, nothing changes, unless the body has `keepKeyForNewHost: true` (the owner
  ticked "Send my saved key to <new host>"). Then the saved key is kept for the new host: the envelope's
  AES-GCM AAD is `workspace_custom_providers:<workspace_id>:<id>` (workspace and row, not the host), so the
  stored `key_enc` stays valid and bound to the row without re-encryption. The server first checks that the
  saved key still decrypts (else 400 `reason: "key_unreadable"`, re-enter it). A saved key is never sent to a
  new host without this explicit flag.
- `keepKeyForNewHost` on an unchanged host is ignored. Any base URL, model or key change resets
  `last_tested_*`; the UI then re-runs Test and offers "Change model" when `modelListed` is false.
- Change log (migration 0012, `workspace_custom_provider_changes`): every PATCH that changes something writes
  one row in the same batch as the update: `changed_at`, `changed_by` (the owner's user id), `fields`
  (`label`, `base_url`, `model`, `api_key`), old/new base URL and host (when the base URL changed) and
  `key_kept_for_new_host`. No key material. `CustomProviderStatus.changes` (GET and every write response) lists
  the newest 5 per provider, newest first: `{at, by (name, else email; null when the user is gone), fields
  (label | baseUrl | model | apiKey), fromBaseUrl, toBaseUrl, fromHost, toHost, keyKeptForNewHost}`. Members
  see it too. Before migration 0012 the PATCH still applies (unlogged) and `changes` is `[]`. DELETE removes
  the provider's log rows in the same batch; rows also go with their workspace.
- Tunnel names validate like any other public hostname (`abc-def-123.trycloudflare.com`,
  `1a2b-34-56.ngrok-free.app`, `my-gpu.loca.lt`); IP literals, `localhost`/`.local` names and names that spell
  an IPv4 address in four groups (for example `127-0-0-1.trycloudflare.com`, or ngrok's random names for IPv4
  clients such as `7c3e-103-21-58-191.ngrok-free.app`) are still refused; that error message suggests a tunnel
  URL without an embedded IP (an ngrok static domain, a `trycloudflare.com` URL). The same base URL rules apply
  with `keepKeyForNewHost: true` (400 `details.field: "baseUrl"`, nothing stored, nothing fetched).
- A provider saved without a name is labelled with its host. When the host changes and the label is still the
  old host (no `label` in the body, or the same label sent back), the label follows the new host and the change
  log lists `label`; a chosen name is kept. The web form sends `label` only when the owner changed it.
- Claimable tunnel names: runs and Test send the saved key to the saved host automatically. A tunnel name that
  someone else can claim when your tunnel is down (e.g. a chosen `*.loca.lt` subdomain) will receive the saved
  key on the next run or Test; prefer random or reserved names (Cloudflare quick tunnel, an ngrok reserved
  domain), and when you stop the tunnel, update the URL, remove the provider, or rotate the key.
- Runs read a custom provider's base URL, host, model and key in one statement right before use, so a PATCH
  that lands while a run starts never pairs the old host with a new key.
- Other workspaces get 404, members 403; the key is never echoed.

## Workspace model selection (built-in providers)

Routes: `src/worker/routes/credentials.ts`; rules: `src/worker/platform/provider-models.ts`; table
`workspace_provider_models` (migration 0011); types `ModelSelectableProviderId`, `ModelSource`,
`ProviderModelOption`, `ProviderModelList` in `src/shared/types.ts`. Contract: docs/provider-contracts.md
"Workspace model selection".

- Providers: `gemini`, `perplexity`, `openai_geo`, `anthropic_geo` (not `writer`: 404; the writer has the
  custom provider flow below). Unknown providers 404.
- TypeSafe (Jev) is not workspace-selectable (owner decision 2026-10-01, "TypeSafe will perform as it is"):
  both model routes answer 400 `bad_request` "TypeSafe (Jev) always uses the operator's model
  (TYPESAFE_MODEL, else the documented jev-latest alias); a TypeSafe model cannot be chosen per workspace."
  (`details: {field: "provider", reason: "model_not_selectable"}`) for every key source (operator key, the
  workspace's own key, a typed key, no key), after the owner check (members 403, non-members 404), and
  nothing is fetched or stored. The runtime (`buildRunContext`, `buildDecisionsForWorkspace`) always passes
  `TYPESAFE_MODEL` (else `jev-latest`), whichever key is used; a `typesafe` row left in
  `workspace_provider_models` by the short-lived picker is ignored (never loaded, never reported as
  `workspaceModel`) and is harmless. The TypeSafe card shows its model in the summary line as before, with
  no model row.
- Resolution (runtime `buildRunContext`, `capabilityPresence`, provider statuses): workspace selection > the
  operator env var (`GEMINI_MODEL`, `PERPLEXITY_MODEL`, `OPENAI_GEO_MODEL`, `ANTHROPIC_GEO_MODEL`) > none =
  `setup_required` ("choose a model"); TypeSafe: `TYPESAFE_MODEL` > its documented `jev-latest` alias
  (`modelSource` `"operator"` or `"default"`). `GET /workspaces/:wid/credentials` rows add `modelSource`
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
  configured). Reason: an unpriced call reserves and settles only the flat
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
  add your own key to see all models." when anything was left out. Perplexity's list endpoint needs no authentication, so a successful
  list does not prove a Perplexity key works.
- `PUT .../credentials/:provider/model` (owner, CSRF): `{model}` validated per provider (400 `bad_request`,
  `details: {field: "model", reason: "invalid_model"}`, value never echoed; unknown fields 400); `null` deletes
  the selection. Without a saved workspace key, while the operator key is set: a GEO engine model without a
  verified rate is 400 "Add your own API key to use a model without a verified price." (`details: {field:
  "model", reason: "operator_key_unpriced"}`) unless it is the operator's env model. 412 before migration 0011. Returns
  the provider status. Another workspace's id is 404 (non-members) or 403 (members who are not the owner).
- A model change changes the cohort key (prompt-set version, provider, model, grounding, sampling options),
  so trend series split by model and are never compared across models.
- Export: `tables.workspace_provider_models` (`provider`, `model`, `updated_at`). Rows cascade with the
  workspace.

## Ask Okara chat model (custom OpenAI-compatible providers with role `chat`) [A36]

Ask Okara has its own model setting, independent of the writer (owner request 2026-10-04). Migration 0019 rebuilds
`workspace_custom_providers` (every existing row kept as is) so `role` may also be `'chat'`, and adds `is_chat`
(1 = the selected chat model; at most one per workspace, partial unique index).

- Chat model source: `"writer"` (default; no selected chat row) = Ask Okara uses the workspace writer exactly as
  before (custom writer, else `WRITER_PROVIDER` / `WRITER_MODEL` with the workspace or operator writer key);
  `"custom:<id>"` = a role `chat` provider answers the chat. `GET .../custom-providers` returns `chatSource`,
  `maxChatProviders` (3), `chatDataSent` and, per row, `isChat`.
- Add: `POST /workspaces/:wid/custom-providers` with `role: "chat"` (base URL, key, model; same validation as
  writers: `validateCustomBaseUrl` SSRF rules, key stored AES-GCM encrypted, only `keyHint` returned). It becomes the
  chat model unless `useAsChat: false` (`useAsChat` with another role: 400). At most 3 chat rows (409), counted
  separately from writers and GEO engines. PATCH (label, base URL with `keepKeyForNewHost` on a new host, model,
  key), DELETE (the chat returns to the writer model when the deleted row was selected), test (`detail` names "the
  first Ask Okara message" as the final check) and Fetch models work as for writers. 412 `setup_required` before
  migration 0019.
- Select: `PUT /workspaces/:wid/chat-model-source` `{source}` (owner; members 403, non-members 404). A row of another
  role is 400 `details: {field: "source", reason: "not_chat"}`; a chat row given to `PUT .../writer-source` is 400
  `not_writer`. The writer is never changed by the chat source and vice versa.
- Resolution (`src/worker/chat/model.ts`): a selected chat row is re-read and re-validated before every turn
  (`resolveCustomProviderRow`: URL, host, model and key in one statement); requests go only to its host
  (`{base}/chat/completions` with function tools; the text-tools fallback applies) with its key and saved model id.
  Selected but unusable (URL no longer accepted, model invalid, key not decryptable) -> `setup_required` with the
  reason; never a fallback to the writer. Spend: a workspace key, so the workspace's own writer-token budget view and
  `provider_calls` (`purpose` chat.turn, cost unknown), as for a custom writer.
- `GET /projects/:pid/chat/status` adds `source: "writer" | "custom"`. The chat panel header reads
  "Model: <id> (writer | chat model) · change in Integrations" and links to `#ask-okara-model`.
- Not built: a `builtin:<anthropic|openai>` source. The workspace's Anthropic / OpenAI keys are GEO-engine keys
  (`anthropic_geo`, `openai_geo`) whose disclosed data use is "approved GEO prompt text only" and whose budgets and
  models are GEO lanes; reusing them for the chat would send project data under a different consent. Owners can
  add the same vendor as a chat model with its OpenAI-compatible base URL instead.

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
  2 MiB; HTTP errors are stored by status only. No tool or plugin is ever requested (the owner picks a
  model/provider that searches by itself, e.g. an OpenRouter `:online` model). Sources (amendment
  2026-10-02): when the response returns at least one valid web source in a documented OpenAI-compatible
  shape (`choices[0].message.annotations[]` with `type: "url_citation"` and `url_citation.{url, title}`, or
  Perplexity-style top-level `citations: string[]` / `search_results: [{url, title}]`; see
  docs/provider-contracts.md), the observation is `grounded = 1`, `grounding_mode`
  `custom (provider-reported sources)`, with those sources as `geo_citations` (http/https only, no
  credentials, at most 2,048 characters, no control characters; titles plain text at most 300 characters;
  deduplicated by URL keeping the first position; at most 50; position = order of first appearance).
  Otherwise: `grounded = 0`, `grounding_mode` `none (custom provider)`, no citations. Always: no search
  queries (`searchQueriesExposed: false`), `cost_usd` NULL,
  `model` = the configured model id (never the host-reported one, so the cohort is fixed by the owner's
  selection), `request_id` only when at most 200 characters without control characters (else NULL).
  A row that cannot be used (base URL no longer valid, key not decryptable) is skipped with a `runtime` run
  event, never faked.
- Budgets: `geo_prompts` and `provider_calls` per prompt like every engine, inside `geo_prompts_per_run`;
  attributed to the tenant's own key (project limits only, never the `GLOBAL_*` operator caps); no
  `usd_micros` reservation (unknown price). `MAX_GEO_PROVIDERS` (daily `geo_prompts` ceiling) is 6: four
  built-in engines plus two custom.
- Cohort: the cohort key of a custom lane uses the lane's fixed grounding mode
  (`custom (sources only when the provider returns them)`), not each answer's, so answers with and without
  sources from one model stay in one series; a model change still starts a new series. (Series recorded
  before 2026-10-02 used `none (custom provider)` and stay separate.)
- Metrics: `citationRate` counts grounded responses only (`geo/metrics.ts`), so a custom lane's citation rate
  is measured over its answers with provider-reported sources, and is unavailable (denominator 0) when none
  returned sources; mention rate and tracked-brand share of voice count every valid answer.
- Labels: lane/engine note "Custom · citations count only when the provider returns sources"; per answer or
  cohort "provider-reported sources" or "no sources returned · mention rate only". `GeoResults` lanes (label
  `<name> (<host>) · Custom · citations count only when the provider returns sources`, plus a disclosure in
  `labels`), `EngineBoardResponse` (custom lanes after the four built-in lanes, same label, a disclosure in
  `labels`; a removed engine with history shows as setup_required "removed"), and the run activity window
  (lane label; answer detail suffix "provider-reported sources" or "no sources returned · mention rate only";
  title "Custom engine answered ..."). On the board a custom lane whose latest cohort has grounded answers
  (`citationRate.denominator > 0`) shows the citation gauge, stats, cited pages, skip factors and rewrite plans
  like any engine, plus "provider-reported sources in X of Y valid answers"; without any it shows its prompt
  feed, mention rate and "Citation rate: not measured (no sources returned)" only, and never requests skip
  factors. `/geo/pages/:id/skip-factors` accepts `engine=custom_geo:<id>`; rewrite plans carry the custom
  lane id as `engine` when their competitor page was cited by it.
- Live view: `LiveGeoLaneTotals.grounded` counts valid answers (cited + named + missing) that were grounded;
  a custom lane's gauge is citation rate `cited / grounded` when `grounded > 0`, else mention rate.
- Proposals: custom-lane answers with provider-reported sources (`grounded = 1`) are inputs to GEO
  recommendations like any grounded answer; answers without sources are not (`geo/proposals.ts`).
- Competitor pages: only stored citations can be approved, and a custom lane stores citations only for
  grounded answers.

## GEO prompts from Search Console (amends docs/build-kit.md [A37], 2026-10-04; types in `src/shared/gsc-questions.ts`)

A deterministic, free prompt source next to manual entry, `POST /geo/prompts/generate` (writer, paid) and the sheet
import: question-style queries people already typed into Google for the site, read from the project's STORED Search
Console sync (`src/worker/geo/gsc-questions.ts`, `GSC_QUESTION_RULES_VERSION` = `gsc-questions-en-2026-10-04.1`). No
provider call, no Jev, no writer; prompts are the queries as typed.

`GET /projects/:pid/geo/prompts/from-gsc` (any member; `?includeBrand=1` keeps self-brand queries; other values 400):

- Source: the latest usable sync (`completed` or `partial`), current-window query rows read in keyset pages of 2,000
  (at most 50,000 rows; every statement binds 5 parameters). Rows are summed per `normalizeDemandQuery`; position =
  impression-weighted mean (approximation; `null` for CSV imports); landing page = the page with the most impressions
  for the query (`null` without page rows).
- Rules (English only; other project languages → `state: "disabled"`): at least 3 words and one of `wh_start`
  (how / what / which / why / where / when / who first), `wh_word` (one of them later), `aux_start` (does / do / is /
  are / should first, or "can" + pronoun / determiner), `best`, `top` (first word or followed by a number), `vs`
  (vs / versus), `difference_between`, `ideas`, `guide`, `review` (review / reviews), `alternatives` (alternatives,
  "alternative to"), `compare` (compare / comparison). Search operators / URLs and texts over 500 characters are
  skipped.
- Self-brand queries (seo/gsc/brand.ts) are left out unless `includeBrand`; any query naming a tracked brand, alias,
  competitor or domain (the prompt sets' brand-blind rule) is a `reputation` candidate, else `discovery`.
- Near-duplicates (same sorted word set without a / an / the) merge into the highest-impression query (`variants`).
- Excluded: queries already in the active set (prompt key or word set) and queries added from Search Console earlier
  and then removed from the set by the owner (`counts.removedEarlier`; never re-suggested).
- Ranked by impressions, clicks, query; `candidates` capped at 50 (`counts.eligible` = all after exclusions).
- Prompt text: trimmed, spaces collapsed, first letter capitalized, "?" for `wh_start` / `aux_start`.
- Response: `state` (`ready` | `setup_required` (no usable sync; message points to Integrations) | `disabled` |
  `demo`), `message`, `methodVersion`, `sync{id, source, syncedAt, window, status, truncated}`, `labels` (first:
  "Search Console, stored sync <date>, window <start>..<end>"), `candidates[{key, text, promptType, rules, evidence,
  variants}]` (`evidence{source: "gsc", query, impressions, clicks, position, landingPage, window, syncId, syncedAt,
  syncSource}`), `counts{rowsRead, queries, questionQueries, brandExcluded, alreadyInSet, removedEarlier,
  mergedDuplicates, eligible}`, `cap`, `includeBrand`, `promptSet{id, version, size, room, max}` or null, `added`
  (prompts of the active set that came from Search Console, with their evidence).

`POST /projects/:pid/geo/prompts/from-gsc` (any member, like `PUT /geo/prompts`): body `{queries, setId?, includeBrand?}`.
`queries` are candidate keys (or the queries); they are matched against a fresh computation over ALL eligible
candidates, never trusted as text. 412 `setup_required` without a usable sync; 400 for a disabled language, an empty
or > 25 list, when none can be added (`details.skipped[{query, reason}]`: already in the set, not a question query,
duplicate) or when the set would exceed 25 prompts (`details{room, requested, max}`); 409 when `setId` is not the
active set (null = "no set yet"). Accepted queries are appended to the active set's prompts (kept with their approval
state) as UNAPPROVED prompts via `savePromptSet` (brand-blind check, duplicates, 25 cap) in a new version labelled
"Added from Search Console <date>". `geo_prompts` has no source column, so provenance is stored like imported
prompts, without a migration: `import_records` rows with `destination = 'gsc_prompts'` (sheet imports use
`geo_prompts`), `record_key` = prompt key, `status 'in_set'`, `source_key 'gsc:<syncId>'`, `data_json`
`{evidence, promptType, rules, methodVersion, setVersion}`. 201 `{set, added[{text, promptType, evidence}], skipped}`.

UI: GEO prompts page card "From Search Console" (count "N new question queries from Search Console" and the stored
sync, then a table with checkboxes, impressions, clicks, position, landing page; "Add selected as prompts", disabled
while the page has unsaved edits; setup state links to Integrations); each prompt added this way shows a "From Search
Console" note. Live GEO 12 "Question queries from Search Console" lists the top 8 with "↗ Review on GEO prompts"
(no run button; refetched when the shown run's `seo.gsc_sync` ends). Service functions `buildGscQuestions` and
`addGscQuestionPrompts` are exported for a later Ask Okara tool (not wired yet).

## Competitor data (DataForSEO)

Owner request (2026-10-02): adding a competitor pulls data from the DataForSEO API. Provider contract:
docs/provider-contracts.md "DataForSEO Labs". Types: `src/shared/competitor-data.ts`. Code:
`src/worker/competitors/dataforseo.ts`, `src/worker/routes/competitor-data.ts`, migration
`0014_dataforseo_competitors.sql`.

- **What is fetched** per competitor domain (one "refresh" = 3 paid DataForSEO Labs Live tasks):
  `ranked_keywords` (overview: organic keyword count, estimated organic traffic (ETV), estimated traffic value,
  rank buckets; plus the top 100 keywords by search volume with position, volume, URL), `domain_intersection`
  with `intersections:false` (top 100 keywords the competitor ranks for and the project's domain does not),
  `relevant_pages` (top 20 pages by estimated organic traffic). All are third-party estimates, labelled
  "DataForSEO estimate · <location> · fetched <date> · cost $x"; never Search Console data.
- **Trigger on competitor add:** `POST /workspaces/:wid/projects`, `PATCH /projects/:pid` (when `competitors`
  changes), Ask Okara `update_competitors` and a competitors import or sync (when its option "Fetch DataForSEO
  data for new competitors" is on, see "Import") queue a refresh for every newly added competitor domain
  (normalized: no scheme, no leading `www.`) when DataForSEO credentials exist (workspace, else operator) and the
  project's auto-pull is on (default on; `PUT .../settings {autoFetch:false}`). Demo projects never fetch. The save
  itself never fails because of DataForSEO.
- **Many new domains at once ([A39], up to 60 competitors):** new domains are queued in the order given (sheet row
  order for imports) up to what today's per-project cap (10) still allows; the rest are **deferred, never dropped**:
  they wait in `competitor_fetch_backlog` (migration `0021_competitor_fetch_backlog.sql`) and the cron moves them
  into the queue as the next UTC days' caps allow (up to 5 projects per tick; a domain at its own per-domain cap
  waits for the next day). A waiting domain is dropped from the backlog when it is no longer a tracked competitor;
  the whole project backlog is cleared (nothing called) when auto-pull is off, the project is a demo, or DataForSEO
  credentials are missing at drain time. `CompetitorDataPanel.caps.waitingDomains` and
  `CompetitorDomainSummary.waiting` show it ("Waiting (daily cap)"). Spend therefore stays at most 10 refreshes
  (≤ 10 × $0.0624 published-price ceiling) per project per UTC day, under the per-project budget as before.
- **Scheduling (Workers-safe):** the request only inserts `competitor_fetches` rows (`queued`); the work runs
  after the response in `ctx.waitUntil` (at most 2 domains per request = 6 parallel subrequests, each with a 25 s
  timeout, so it fits the post-response `waitUntil` window). The cron tick (every 15 min) first moves deferred
  domains from the backlog into the queue (see above), then processes up to 4 refreshes still queued after 60 s
  (or promoted by this tick) and marks refreshes `running` for over 10 min as failed (their stranded
  reservations are marked `unknown`, i.e. stay counted, by the existing stale-reservation sweep after 1 h). Without an execution context
  (tests, dev) the work is awaited in the request. The panel polls while a refresh is queued/running.
- **Caps:** at most 1 queued/running refresh per (project, domain) (partial unique index); 2 refreshes per
  domain and 10 per project per UTC day (`setup_required` attempts do not count), enforced in one conditional
  INSERT; refresh route rate-limited to 10/min per user.
- **Budget:** before any call, each task reserves `provider_calls` 1 and `usd_micros` = the published-price
  ceiling (`maxTaskCostUsd`), all three or none (a refused reservation releases the others; the refresh fails
  with "this project's daily limit" or "the operator's global daily allowance"). On the operator's credentials
  the `GLOBAL_*` caps apply too (`budgetForKeySource` → `OPERATOR_KEY_SPEND`); on workspace credentials only the
  project limits. After the call `usd_micros` is settled to the `cost` DataForSEO returned; a call whose cost
  is unknown (timeout, unreadable body) keeps the full reservation (`unknown`); a blocked request releases it.
- **provider_calls:** one row per HTTP attempt, `provider = 'dataforseo'`, `model = labs/google/<endpoint>` or
  `labs/locations_and_languages`, `purpose = competitor_data`, `request_id` = DataForSEO task id, `cost_usd` =
  response cost (actual, `cost_is_estimate = 0`), NULL when unknown. Credential tests (free) are not recorded.
- **Storage/retention:** `competitor_snapshots` holds one row per endpoint per refresh with the parsed, bounded
  `data_json` (no raw responses); the snapshots of the newest 3 completed/partial refreshes per (project,
  domain) are kept, older ones and those of domains that are no longer competitors are deleted after each
  refresh (found per domain and deleted in chunks, so 60 competitors × 5 domains stay under D1's 100 bound
  parameters; the panel reads the refresh log and snapshots in chunks of 90 domains / fetch ids); the refresh log
  keeps the newest 10 rows per domain. All four tables (with the backlog) carry `workspace_id` and
  `project_id`; every query filters by both; they are included in the project export and cascade on project
  delete.
- **States:** `setup_required` (no credentials → "Add DataForSEO API credentials…"; locale not mappable →
  "Choose a location and language…"; migration 0014 pending), `disabled` (demo project), `ready`. A refresh
  ends `completed`, `partial` (some tasks failed; their errors are shown per table), `failed` or
  `setup_required`.
- **Not done on purpose:** no "add to GEO prompts" or "check in Search Console" links on gap keywords (no
  per-keyword feature exists for either), and the gap is not yet SEO-agent evidence: the `evidence.source` CHECK
  has no third-party source and no existing candidate kind takes an external keyword list without Search
  Console support. TODO (needs an owner decision): an `external_estimate` evidence source plus a candidate kind
  that pairs a gap keyword with a crawled page, labelled as a third-party estimate.

## Import (Google Sheets / CSV) (amends docs/build-kit.md [A28], 2026-10-02)

Types: `src/shared/import.ts`. Code: `src/worker/imports/{sheets,source,destinations,service,sync}.ts`,
`src/worker/routes/imports.ts`, web `src/web/pages/import/*`. Migration `0015_sheet_imports.sql`. Provider contract:
docs/provider-contracts.md "Google Sheets API v4".

| Method | Path | Who | Body → Response |
|---|---|---|---|
| GET | `/projects/:pid/import` | member | `ImportOverview` {canManage, sheets: SheetsConnectionStatus, history (30), syncs, documents, limits} |
| GET | `/projects/:pid/import/links` | member | `ImportedLinksReport` (links placed per sheet + latest-crawl check, imported internal-link reference tables) |
| GET | `/projects/:pid/import/records/competitors` | member | `ImportedCompetitorRow[]` (sheet metrics per domain, status tracked / not_tracked_limit / removed_from_sheet) |
| GET | `/projects/:pid/import/records/geo_prompts` | member | reference notes per imported question |
| GET | `/projects/:pid/import/sheets/connect` | owner | 302 to Google consent (`spreadsheets.readonly` only); callback is `GET /gsc/callback` (dispatch by state purpose) → `/projects/:pid/import?sheets=connected` or `?sheetsError=<code>` |
| DELETE | `/projects/:pid/import/sheets` | owner | `{ok}`; deletes the stored Sheets token (no remote revoke) |
| POST | `/projects/:pid/import/sheets/tabs` | owner | `{spreadsheet: url or id}` → `SheetTabsResult` {spreadsheetId, title, tabs[{sheetId,title,index,rowCount,columnCount}]} |
| POST | `/projects/:pid/import/sheets/preview` | owner | `{spreadsheetId, tabs: string[≤10]}` → `TabPreview[]` {tab, headers, rows (≤20), suggestion {destination, mapping, reason}} |
| POST | `/projects/:pid/import/dry-run` | owner | `{source, destination, mapping, options}` → `ImportPlan` (no writes) |
| POST | `/projects/:pid/import/commit` | owner | same + `keepInSync?: {frequencyHours: 6/12/24}` → 201 `{plan, import, changes, sync}`; 200 with `import: null` when nothing changed |
| POST | `/projects/:pid/import/:importId/undo` | owner | `ImportRecordSummary` (status undone); 409 unless it is the latest completed import of its destination |
| PATCH | `/projects/:pid/import/syncs/:syncId` | owner | `{enabled?, frequencyHours?}` → `ImportSyncSummary` |
| POST | `/projects/:pid/import/syncs/:syncId/run` | owner | Sync now → `{outcome {status ok/error/busy, code, message, warning, changes, import}, sync}` (6 per sync per hour) |
| DELETE | `/projects/:pid/import/syncs/:syncId` | owner | `{ok}`; stops syncing, imported data stays |

- **Source:** `{kind:"csv", name, text}` (≤ 10 MB of text, ≤ 100,000 rows, ≤ 100 columns, cells clipped at 2,000
  characters; comma/tab/semicolon detected; BOMs removed; the browser decodes UTF-8/UTF-16 files) or
  `{kind:"sheets", spreadsheetId, tab}` (needs the Sheets connection; 412 `setup_required` otherwise; rows read: 5,000
  for prompts/competitors/links, 20,000 for documents, cap stated in the plan).
- **Destinations and mappings** (column names from the header row; unknown column → 400 `header_changed`):
  `geo_prompts {question, done?, notes?[]}` + options `{approvePrompts?, addCompetitors?[]}`;
  `competitors {domain, notes?, assignedTo?, metrics?[]}` + options `{fetchCompetitorData?: boolean,
  acceptDomainFixes?: string[≤500]}` ([A39], both kept for later syncs); `implemented_links {source, target, anchor?, date?,
  method?, hub?, status?}` (absolute URLs or `/paths` on the verified host); `backlinks {liveUrl, target, anchor?,
  target2?, anchor2?, vendor?, type?, date?, da?, traffic?, price?}` ([A38], see "Backlinks"); `context_doc` / `reference
  {columns?[], sortBy?, title?}`. `options.excludeKeys[]`: record keys unchecked in the dry run (also excluded on
  later syncs).
- **Auto-mapping** (`suggestDestination`): `Live URL` + `Target` (the Built Links tab) → backlinks; `Question` → GEO prompts; `Competing Domains` → competitors;
  `Source … URL` + `Target URL` → placed links; tab names like Titles/H1/Meta/30x/40x/Indexed and internal-link
  or orphan tabs → reference; anything else → imported research document.
- **ImportPlan:** `counts {add, update, unchanged, skip, remove, not_added}`, `summary[]` (e.g. "42 prompts new, 3
  skipped" + "3 skipped: duplicate question in the sheet"), `notes[]`, `items[]` (≤ 300, changes first, each with
  row number and reason), `suggestedCompetitors` for prompts; for competitors ([A39]) `competitorFetch`
  (`CompetitorFetchPlan {newDomains, perDomainUsd, maxUsd, perDay, days, estimate, defaultOn, selected, willFetch,
  state ready/setup_required/auto_fetch_off/disabled, message}`) and `domainFixes[{key, from, to, row, accepted}]`.
- **Competitors import ([A39], owner request 2026-10-04 "add competitors data from sheet"):** up to 60 tracked
  competitors (`MAX_COMPETITORS`, shared by worker and web). Each domain cell is cleaned
  (`cleanCompetitorDomain`, `src/shared/competitors.ts`): URL → hostname; `http(s)` only, no credentials or port;
  lowercase; trailing dot and a leading `www.` removed; a path / query is dropped and the row is noted "from a page
  URL"; IP literals, local names (`localhost`, `.local`, `.internal` ...) and invalid labels are skipped with the
  reason; duplicates are found after cleaning ("duplicate of row N"); the project's own domain (or a sub/parent
  domain of it) is skipped. A host starting with `ww.` or `wwww.` is a likely typo: the row is skipped with
  "possible typo: did you mean X?" and listed in `domainFixes` until the owner accepts the fix
  (`options.acceptDomainFixes` = the typo host); it is never corrected silently. A subdomain of another listed
  domain (in the sheet, after accepted fixes, or already tracked) is added to that domain's competitor as an extra
  domain ("merged into X", at most 5 domains per competitor) instead of becoming a competitor. New competitors are
  appended in sheet order until 60; the rest are `not_added` with their sheet metrics kept. DataForSEO: the dry run
  shows "N new competitor domains → up to N × $0.0624 DataForSEO (≈$X), fetched at most 10 per day" (published-price
  ceiling `maxRefreshCostUsd`); the option `fetchCompetitorData` defaults to on for ≤ 10 new domains and off above
  (the owner can tick it); when it is on the new domains are queued in sheet order and the daily cap defers the
  rest to later days (see "Competitor data (DataForSEO)"); without credentials nothing is queued (state
  `setup_required`). A manual import never removes competitors; a sync untracks domains removed from the sheet (as
  before).
- **Idempotency and provenance:** `import_records` keeps one row per (project, destination, normalized key) with the
  sheet's values; `imports` one row per applied import (manual or sync) with counts and a change log
  (`+ lumens.com`, `− 1800lighting.com`); `import_changes` the previous state of each record changed (undo).
- **Sync:** `import_syncs` (destinations competitors, geo_prompts, implemented_links, backlinks; Sheets source only). The cron
  (every 15 min) runs up to 3 due syncs per tick with a 10-minute lease. Error codes: `token_expired`,
  `not_connected`, `tab_missing`, `header_changed`, `forbidden`, `not_found`, `api_error`, `apply_error`; failing
  syncs appear in `GET /projects/:pid/attention` as `importSyncs[]` (additive field) and on the Import page.
- **Other surfaces:** `GET /projects/:pid/context` now also returns `kind: "imported"` documents (`docKey`,
  `title`); `GeoPromptSet.label`; the link suggester marks pairs placed per the sheet `implemented`; Ask Okara has an
  `imported_research` read tool and a `navigate` view `import`; the project export includes the four import tables.
- **Limits:** dry run 30/min, commit and undo 10/min, Sheets reads 30/min per user and project.

## Backlinks (backlink monitor; amends docs/build-kit.md [A38], 2026-10-04; types in `src/shared/backlinks.ts`)

Code: `src/worker/backlinks/{html,check,events,store,jobs,service}.ts`, `src/worker/routes/backlinks.ts`, the `backlinks`
import destination in `src/worker/imports/destinations.ts`, `publicExternalFetch` / `assertPublicExternalUrl` in
`src/worker/seo/ssrf.ts`. Web: `src/web/pages/backlinks/**`, `src/web/pages/live/backlinks/**`. Migration
`0020_backlink_monitor.sql` (tables `backlinks`, `backlink_jobs`, `backlink_job_cache`, `backlink_checks`,
`backlink_events`; `imports` / `import_syncs` rebuilt to accept the `backlinks` destination) and
`0022_backlink_browser_recheck.sql` (browser fallback: `backlink_checks.method`, `backlinks.check_method` /
`browser_*`, tables `browser_usage`, `browser_lease`; `src/worker/backlinks/browser.ts`).

| Method | Path | Who | Body / query → Response |
|---|---|---|---|
| GET | `/projects/:pid/backlinks` | member | `?status=<BacklinkStatus or unchecked or target_broken>&vendor=&type=&changed=<days 1-365>&q=&inactive=1&sort=checked/status/host/vendor/date/da/traffic/changed&dir=asc/desc&offset=&limit=≤100` → `BacklinkListResponse` {rows, total, offset, limit, vendors, types, labels}; `&format=csv` → `text/csv` attachment (all matching rows, ≤ 2,000; cells starting with `= + - @` are prefixed with `'`) |
| GET | `/projects/:pid/backlinks/summary` | member | `BacklinkSummary` {state ready/empty/demo, totals {active, inactive, checked, unchecked}, byStatus, dofollow {n, m} (m = checked pages read: found or missing), targetBroken, anchorMismatch, changes {last7, last30, negative7, negative30}, lastCheckAt, nextCheckAt (weekly; null when scheduled runs are off), job (running), lastJob, limits, browser `BrowserSummary` {available, unavailableReason, waiting, unavailable, failed, usedMs (today, UTC, whole account), capMs, deferred, deferredUntil}, canRun, verified, labels} |
| GET | `/projects/:pid/backlinks/events` | member | `?since=<ISO>` (default 30 days) `&negative=1&limit=≤200` → `BacklinkEventsResponse` {events (with liveUrl, targetUrl), since, total} |
| GET | `/projects/:pid/backlinks/feed` | member | `?after=<ISO>&limit=0-50` → `BacklinkFeed` {job (running, else latest), items: latest checks of that job} |
| GET | `/projects/:pid/backlinks/:id` | member | `BacklinkDetail` {backlink, checks (latest 10, with redirect chain, robots, meta robots, X-Robots-Tag, canonical, links found), events (latest 50)}; 404 outside the project |
| POST | `/projects/:pid/backlinks/check` | member | `{}` = every active backlink (manual, 3 per project per UTC day) or `{ids: string[1-30]}` = recheck (30 rows per project per hour) → 202 `StartBacklinkCheckResult` {job, existing}; a running full check is returned (`existing: true`); a running recheck → 409; no backlinks → 409; demo → 409 `demo_project`; over a limit → 429 with the remaining count; unknown ids → 404 |
| POST | `/projects/:pid/backlinks/check/advance` | member | `{after?: ISO}` → `BacklinkFeed`; runs one more lease-guarded batch of the project's running job (rechecks first) in `ctx.waitUntil`; when that invocation did no plain work, one browser re-check of the project's oldest pending row instead (see "Browser re-checks"); 60 per project per minute |

- **Statuses** (`BacklinkStatus`): `dofollow`, `nofollow`, `sponsored`, `ugc` (the matching link's rel; sponsored >
  ugc > nofollow when several; any followable matching link wins; page-level meta robots / X-Robots-Tag nofollow ⇒
  `nofollow`, reason "Page-level nofollow (…)"), `missing` (page read, no link to our site), `page_error` (4xx/5xx),
  `redirected` (the article's final URL differs after normalization; `linkRel` is the link class on the final page),
  `robots_blocked` (robots.txt of the article's host, or of a redirect hop's host, disallows OkaraBot or is
  unreachable; the page is not requested), `fetch_failed` (timeout, network, blocked URL, refused redirect hop,
  non-HTML, more than 5 redirects, or a page needing more than 20 requests). A link to another URL of our site counts
  as found with "Links to … not to the target URL" in the reason. Target check: `targetStatus` (final HTTP status on
  the verified host) or `targetError` (`not_checked` when the site is not verified, `robots_blocked`, or a fetch error
  code).
- **Events** (`BacklinkEventKind`, code-computed against the previous check; the first check is the baseline):
  `rel_changed` ("dofollow → nofollow"), `link_removed`, `link_restored`, `page_error` ("Page now 404"),
  `redirected` ("Redirected to <url>"), `robots_blocked`, `fetch_failed`, `recovered`, `noindex_added`,
  `noindex_removed`, `anchor_changed`, `target_moved`, `target_broken` ("Target now 404"), `target_recovered`,
  `canonical_changed`. `negative: true` for losses; `GET /projects/:pid/attention` gains `backlinkChanges`
  {negative, since, examples (≤ 3)} for the last 7 days (additive field).
- **Batches:** ≤ 8 backlinks and ≤ 20 external requests per invocation (robots.txt, redirect hops and target checks
  included), 90 s lease, robots verdicts / target results / per-host pacing cached per job (`backlink_job_cache`).
  The 15-minute cron schedules the weekly check (projects with scheduled runs on, not demo, with active backlinks, no
  full check created in the last 7 days; 3 projects per tick) and processes one batch per tick; jobs without progress
  for 3 days are failed.
- **Browser re-checks** (Cloudflare Browser Run fallback, 2026-10-05): a plain result `missing`, `page_error` 403 / 429
  / 503 or `fetch_failed` (not `blocked_url` / `redirect_offsite`) sets `BacklinkRow.browserState = "pending"` (the
  plain check is stored; its events wait). One page per invocation (advance with no plain work; the cron after its
  batch) is rendered in the headless browser (binding `BROWSER`, `@cloudflare/puppeteer`): URL validated before
  launch, every request intercepted (public http(s) hosts only; images / media / fonts aborted), 20 s navigation, then
  the rendered DOM is classified with the plain checker's rules. The browser check (`BacklinkCheckView.method` /
  `BacklinkFeedItem.method = "browser"`) supersedes the plain result (`BacklinkRow.checkMethod = "browser"`); events
  are computed on the final result. Browser could not load the page → `browserState: "failed"`, plain result kept. No
  binding / cap 0 / Browser Run refusing 3 launches → `browserState: "unavailable"` with `browserReason`, plain result
  kept. Budget: browser wall time per UTC day (whole account) capped at `BACKLINK_BROWSER_MS_PER_DAY` (default 480,000
  ms = 8 min; Workers Free includes 10 min/day); over it, rows wait until the next UTC day (`browser.deferred`). One
  browser at a time, ≥ 20 s between launches.
- **Ask Okara:** no chat tool yet; `listBacklinks`, `backlinkSummary`, `backlinkEvents`, `startBacklinkCheck` in
  `src/worker/backlinks/service.ts` are the functions a tool should call.

## Maton.ai API gateway (amends docs/build-kit.md [A34], 2026-10-03; types in `src/shared/maton.ts`)

A workspace owner can paste a [Maton.ai](https://maton.ai) API key. Okara then reads Google Sheets (Import, Sync now,
cron sync) and Search Console (gsc_sync, ownership check) **through Maton** when the project has no direct Google
connection, with no Google Cloud setup. Direct Google OAuth always wins when it is connected. The key is stored
AES-GCM encrypted (`provider_credentials.provider = 'maton'`), never returned (only `keyHint`, the last 4
characters), and used only by `src/worker/platform/maton.ts`, whose egress policy admits only the read-only requests
listed in docs/provider-contracts.md "Maton.ai API gateway" and refuses everything else before any fetch. Every Maton
request is recorded in `provider_calls` (provider `maton`, cost 0). Migration `0018_maton_gateway.sql`.

| Method | Path | Who | Body / result |
|---|---|---|---|
| GET | `/workspaces/:wid/maton` | member | `MatonStatus` (state, keyHint, last test, per-app cached ACTIVE connections and the owner's pick, warning text). No network call |
| PUT | `/workspaces/:wid/maton` | owner | `{apiKey}` (8-400 printable ASCII) → `MatonStatus`. Clears the cached connection list (test again). 412 `setup_required` when encryption is not configured or migration 0018 is pending |
| DELETE | `/workspaces/:wid/maton` | owner | `{ok: true}`; deletes the key and the cached connections |
| POST | `/workspaces/:wid/maton/test` | owner | `{apiKey?}` → `MatonTestResult {ok, detail, apps: [{app, connectionId, status, createdAt, used}]}`. One `GET https://ctrl.maton.ai/connections?status=ACTIVE`; only `google-sheets`, `google-search-console` (used), `google-analytics-data`, `google-analytics-admin` ("available, not used yet") are returned; other apps, connection URLs and metadata are dropped. A typed key is tested without saving; a saved-key test stores the list and the result. 412 when no key is saved |
| PUT | `/workspaces/:wid/maton/connections/:app` | owner | `{connectionId: string \| null}` → `MatonStatus`. Picks the connection sent as `Maton-Connection` (null = Maton's default, the oldest active connection). 400 when the id is not a listed active connection of that app; 404 for other apps |
| GET | `/projects/:pid/gsc/maton` | member | `GscMatonStatus {effective: 'direct'\|'maton'\|null, source, directConnected, matonAvailable, matonConnectionLabel, property, canManage}` |
| GET | `/projects/:pid/gsc/maton/sites` | owner | `[{siteUrl, permissionLevel}]` through Maton (`GET .../webmasters/v3/sites`). 412 without a key/connection |
| PUT | `/projects/:pid/gsc/source` | owner | `{source: "direct"}` or `{source: "maton", property}` → `{status: GscMatonStatus, verification}`. A Maton property must be in Maton's sites list (400 otherwise); it sets `projects.gsc_source = 'maton'` and `gsc_property`, and verifies ownership like `PUT /gsc/property`. `direct` clears the Maton choice |

Changes to existing responses (all optional fields):
- `IntegrationsStatus.gsc.via = "maton"` (state `ready`, `connectedAt` null) when the project reads Search Console
  through Maton.
- `SheetsConnectionStatus.via` (`direct` | `maton`) and `.maton {available, label}` on `GET /projects/:pid/import`; with
  no direct connection and a Maton google-sheets connection the state is `ready` via Maton.
- `ImportRecordSummary.transport` and `ImportSyncSummary.lastTransport` (`direct` | `maton`): which transport read the
  sheet (`imports.transport`, `import_syncs.last_transport`).
- The 412 messages of the Sheets routes and the sync's `not_connected` error mention the Maton option.

Transport precedence (Sheets and Search Console): direct OAuth connected → direct; else Maton (Sheets: whenever the
workspace has a key with an active google-sheets connection; Search Console: only when the project's source is
`maton`); else `setup_required` (gsc_sync `setup_required`, Import 412, sync `not_connected`). Errors through Maton map
to the same codes as direct (401 → `token_expired`/setup_required "Update the key", 400 missing connection →
`not_connected`, 404, 403, "Unable to parse range" → `tab_missing`, 429).

Reusable Worker helpers for Ask Okara (no route; `src/worker/platform/maton.ts`, each tenant-scoped by `workspaceId`,
returning `MatonResult<T> {data, source: "Maton (<connection>), fetched <ts>", connectionLabel, fetchedAt, truncated}`
and throwing `MatonSetupRequiredError` (code `setup_required`) without a key or connection): `matonStatus`,
`readSheetTabs`, `readSheetValues` (≤ 5,000 rows, 100 columns, 500 characters per cell), `gscSites`, `gscQuery`
(rowLimit ≤ 25,000), `gaListProperties` (GA4 accountSummaries), `gaRunReport` (GA4 runReport; documented request fields
only, limit ≤ 10,000; values returned as Google's strings).

## Internal links workbench (amends docs/build-kit.md [A25]; [A30], 2026-10-03)

Owner request 2026-10-03 ("all eight improvements"). Types: `src/shared/types.ts`, section "internal links workbench
(2026-10-03)" (new fields on `LinkSuggestion`, `LinkSuggestionReport` and `AttentionFeed` are optional). Code:
`src/worker/seo/crawl/rolling.ts`, `src/worker/links/{graph,graph-load,graph-store,graph-read,clusters,priority,draft,anchor-audit,verify,gsc}.ts`,
routes `src/worker/routes/links.ts`, UI `src/web/pages/links/*`. Migration 0017. Everything is project-scoped through
`requireProject` (404 for non-members) and every query filters by `workspace_id`; writes need the CSRF token.
Okara never edits pages: everything is a suggestion for the owner to apply.

The Internal links page has six tabs (`?tab=suggestions|clusters|graph|broken|anchors|placed`) under a coverage line
("N of M sitemap URLs analysed (oldest snapshot <date>)"), a "Rebuild graph" button and "Run analysis".

### Link graph (items 1 and 5)

- **Rolling crawl** (`rolling-crawl-2026-10-03.1`). Each SEO crawl takes the next batch of known URLs within the
  existing per-run page cap (`project_limits.crawl_pages`; no new budget): the home page, then never-crawled URLs
  (Search Console impressions from the latest stored sync first, sitemap before link-discovered URLs, round-robin from
  the stored cursor), then the oldest snapshots. The inventory (`crawl_inventory`) holds sitemap URLs (up to 25
  sitemap files and 10,000 URLs per project; language-version sitemaps such as `/da/sitemap_products_1.xml` are left out
  when the same sitemap is listed without the language folder, and the crawl notes say so), up to 1,000 newly discovered
  link targets per crawl, and the home page;
  a sitemap that could not be read or was truncated never marks URLs as removed. Crawling stays on the verified host
  through the SSRF guard. Retention (bounded, per crawl): every snapshot of the 7 latest crawls is kept; outside them
  each page keeps its latest snapshot in full and its previous one compacted; older ones are deleted (at most 2,000
  rows changed per crawl).
- **Graph** (`links-graph-2026-10-03.1`): the union of the latest snapshot of every page (completed/partial crawls),
  rebuilt after every crawl, on `POST .../graph/rebuild` (6 per project per hour; 409 while another build runs) and
  inside every suggestion run. Deterministic: no provider call, no budget. Stored as one `link_graphs` row plus one
  `link_graph_urls` row per URL (only the latest ready graph is kept). Links are counted per distinct source page;
  `contentLinksIn` counts links in body text (content, image alt, breadcrumb); navigation, header, footer and sidebar
  links (and snapshots taken before anchors were stored) count only in `linksIn`. A link to a URL that redirects also
  counts for its final URL; a link to a non-canonical URL also counts for its canonical (uncrawled Shopify
  `/collections/<c>/products/<p>` and `/products/<p>?…` URLs are assumed canonical to `/products/<p>`, labelled
  "via canonical"). Snapshots older than 30 days are `stale`. **Orphans** are indexable sitemap pages (not the home
  page) with 0 links in across the whole graph; without any sitemap inventory, indexable crawled pages. The coverage
  line states how much of the sitemap was analysed, so a page that looks orphaned may still be linked from a page not
  crawled yet.
- `GET .../graph/urls`: `filter` = `all | orphans | no_content_links | issues | stale | not_crawled | hubs | sitemap |
  anchor_flags`, `sort` = `url | links_in | content_links_in | links_out | impressions | fetched_at`, `dir` = `asc |
  desc`, `q` (URL or title contains), `offset` (≤ 20,000), `limit` (1–200, default 50). Unknown filter/sort: 400.
  `GET .../graph/url?url=` (404 when the URL is not in the graph) adds the inbound sources (at most 50 stored per URL,
  200 for redirect/error targets; `row.linksIn` is the exact count) with anchor, kind (`content | image | breadcrumb |
  navigation`) and `via` (`redirect | canonical`), the outbound content targets, the redirect chain and the anchor
  audit. `GET .../graph/export`: every URL as CSV (UTF-8 BOM): URL, Title, Status, In sitemap, Indexable, Links in,
  Content links in, Links out, Content links out, Orphan, Inbound sources (anchors), Outbound targets, Hub, Hub method,
  Last crawled, Stale, Impressions, Clicks, Avg position.
- **Broken and redirected links** (`GET .../broken`, CSV with `?format=csv`): one row per (source, target) for
  targets whose latest snapshot redirected (3xx or a different final URL, every hop in `chain`, `finalUrl`,
  `finalStatus`) or returned 4xx/5xx; `fix` is "Link to <final URL>" (or "Remove or replace the link"; a redirect to an
  error says so). Fetch errors and timeouts are never claimed broken; linked URLs not crawled yet are counted in
  `unchecked`. At most 2,000 rows (6,000 in the CSV), `truncated` says when sources were cut. The SEO agent's
  broken-internal-link rule also uses earlier crawls' statuses ("N checked in an earlier crawl").

### Hubs and clusters (item 2, `links-clusters-2026-10-03.1`)

Hubs: collection pages (`/collections/<handle>`), collections named in the Hub column of the imported sheet, and
pages the owner marks (`PUT .../clusters/hub {url, hub: true}`; `false` removes a detected hub; `null` clears the
mark). Spokes (indexable articles and products) get at most one hub, with the method stored and shown: `owner`
(`PUT .../clusters/assign`), `sheet`, `collection_membership` (listed on the collection page), `existing_links`, or
`tfidf` (cosine of title/H1/heading TF-IDF terms ≥ 0.15); otherwise unassigned. Each spoke shows whether the hub
links to it and whether it links back (linked / partly linked / unlinked counts). Cluster edits accept only URLs on
the verified host (400 otherwise), 120 edits per project per hour, and apply at read time. Suggestions that add a
missing hub → spoke or spoke → hub link are badged "Cluster gap" and get the ×1.3 priority boost.

### Priority (item 3, `links-priority-2026-10-03.1`)

`priority = relevance × impact × cluster` (code-owned, never asked of Jev; suggestions are sorted by it):

- relevance: the candidate's term-overlap score with the orphan (×1.5) / single-inlink (×1.25) boost;
- impact = target × source. Target = impressionFactor × positionFactor, from the target's Search Console page row
  (latest stored sync, current window; summed query rows when no page row exists, labelled a lower bound):
  impressionFactor = 1 + min(1, log10(1 + impressions) / 4); positionFactor = 1.5 for average position 8–20
  (striking distance), 1.2 for 3–8, 1.05 for 1–3, 1.1 beyond 20, 1 without impressions. Source = min(2, inlinkFactor ×
  clickFactor) with inlinkFactor = 1 + min(0.5, log10(1 + source inlinks in the graph) / 4) and clickFactor = 1 +
  min(0.4, log10(1 + source clicks) / 5). Without Search Console data every Search Console factor is 1 (stated).
- cluster = 1.3 when the link closes a cluster gap, else 1.

`LinkSuggestion.priority` carries every factor, the impressions, clicks and position behind them, the source label
("Search Console <window>, stored sync <date>") and plain-text explanation lines ("These are your Search Console
impressions, not search volume."). No search volume is used or shown.

### Drafted sentences, "insert PK sentence" (item 4, `links-draft-2026-10-03.1`)

For the highest-priority pairs whose source page has no sentence mentioning the target (and topical pairs with no
fitting sentence), the workspace writer drafts one sentence containing the anchor, from evidence only: the source
page's title, H1 and stored sentences and the target's title/H1, each passed as an evidence id (untrusted text,
sanitized; the prompt says never to follow instructions in it; no tools). Validation: one plain-text sentence of 8–40
words (≤ 240 characters, ending with . ! or ?), the anchor exactly once (whole words), cited evidence ids that exist,
`writing/validate.ts` (numbers, dates, certification/spec terms, promises must be in the evidence), the draft-check flag
scan (unsupported claims, testimonials, guarantees, filler), no price/offer wording or claim words (best, leading,
perfect, proven...) absent from the evidence, no capitalized name absent from the evidence, and at most 3 content
words found in no evidence. Failures are stored as `rejected` with the reasons. Stored rows: `placement:
"draft_sentence"`, `sentence: null`, `draft` with the text, the label "Draft sentence — review before publishing",
the evidence, cited ids, validation and where to insert it. At most 20 drafts per run, 5 pairs per writer call; each
call reserves `provider_calls` + `writer_tokens` (project limits; operator global caps on operator keys); a budget
refusal stops drafting (`drafts.state: "partial"`, run `partial`). No writer → `drafts.state: "setup_required"` (no
draft is simulated). Demo projects never call the writer (`"demo"`). Drafts are never `suggested`, so they never reach
the SEO agent.

### Anchor audit (item 6, `links-anchor-audit-2026-10-03.1`)

`GET .../anchors` (flagged targets; `?all=1` every audited target; at most 500 rows). Content links only, one count
per (source, anchor). Keyword = the target's top non-brand Search Console query, else its H1, else its title (basis
returned). Flags, engineering defaults returned as `thresholds`: `exact_match_heavy` (more than 50% of anchored links
use the exact keyword, with at least 5), `repeated_anchor` (one anchor from at least 10 sources and at least 60%),
`generic_anchor` ("click here", "read more"...), `empty_anchor` (no text, alt or aria-label), `no_query_terms` (at
least 3 anchored links and none contains a term of the page's top Search Console queries). New suggestions skip an
anchor option that would keep or push a target over a repetition threshold (the reason says so).

### Auto-verification (item 7, `links-verify-2026-10-03.1`)

Expected links: suggestions you accepted or implemented (since = when you set the status) and links your imported
sheet lists as placed (since = the sheet Date cell, else the import time). On every graph build each is checked
against the latest snapshot of its source page: `verified` (a link resolves to the target, a URL redirecting to it, its
final URL, or a canonical variant; "verified on <date>"), `not_found` ("not found in crawl of <date>"), `pending` (the
source was not crawled since the link was placed), `source_unavailable` (the source page errored, redirected or was
skipped). `LinkSuggestion.verification` and `GET .../placed` (`PlacedLinksReport`) show them; `GET
/projects/:pid/attention` adds `linkVerification {notFound, checkedAt, examples}` for implemented or sheet-placed links
not found (accepted-only links are not flagged).

### Export in the owner's sheet format (item 8)

`GET .../export?format=sheet` returns `text/csv; charset=utf-8` with a UTF-8 BOM and CRLF lines, headers exactly
`Date,Source Article URL,Target URL,Anchor,Method,Hub,Status`: Date = the day the suggestion was made or its status set;
Method `wrap existing` (existing sentence) or `insert PK sentence` (drafted sentence); Hub = the cluster's collection
handle (else the hub's path); Status = Suggested / Review / Rejected, or Accepted / Implemented / Dismissed plus the
verification ("Implemented · verified 2026-10-02"). Cells are RFC 4180 quoted and formula-safe (`=`, `+`, `-`, `@`
prefixed with `'`). Filters: `ids` (comma-separated, at most 500: the selection), `userStatus`, `status`, `placement`;
without filters the sheet export leaves out dismissed and rejected rows. `format=csv` keeps its previous columns.
`POST .../bulk` sets one status on up to 200 suggestions (ids of other projects count as `missing`).

### SEO agent

Cluster gaps reach the SEO agent through the existing `internal_link` recommendation kind: the agent takes the
highest-priority act-tier suggestions (the cluster boost ranks gaps higher) and the evidence names the gap and the hub.
Broken links reach it through the existing technical rule SEO-LINK-BROKEN-INTERNAL, which now also uses statuses from
earlier crawls. Redirected links are not fed to the agent (a redirect is not an error, and one template link would
fill the 0–2/day cap); they stay on the Broken links tab.

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
  project); `engine` optional (`GeoEngineProviderId`, or a custom GEO engine lane id `custom_geo:<id>`, at most
  120 characters).
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

## Partial (section) runs

Owner request 2026-10-03 ("a separate button for each section to run that section, and one common button to
run all"). `POST /projects/:pid/runs` takes optional `steps` and `engines` (unknown keys → 400):

```json
{ "agent": "seo", "steps": ["crawl"] }
{ "agent": "geo", "steps": ["batch"], "engines": ["gemini"] }
```

- **Step ids** (short form; `"seo.crawl"` is also accepted): SEO `crawl`, `gsc_sync`, `recommend` (Jev query
  relevance, judging and drafting); GEO `batch` (ask the engines and analyse each answer), `proposals`.
  `validate` and `summary` always run and cannot be listed. Steps run in agent order whatever the request
  order. Listing every step without `engines` is a plain full run (no scope stored).
- **engines** (GEO, only with `batch`): built-in engine ids (`gemini`, `perplexity`, `openai_geo`,
  `anthropic_geo`) or `custom_geo:<id>`; each must be configured for the workspace (`capabilityPresence`),
  else 412. The run builds only those GEO lanes.
- **Dependencies use stored data, never re-run predecessors.** `recommend` without `crawl`/`gsc_sync` in the
  same run needs a stored crawl (`crawl_runs` completed/partial) or a usable Search Console sync, else
  **409** "Run the crawl first: …". `proposals` without `batch` needs stored API answers from the last 30 days
  (`PROPOSAL_WINDOW_DAYS`), else **409** "Ask the AI engines first: …".
- **Setup pre-checks (412 `setup_required`)**: `crawl` without a verified host, `gsc_sync` without a Search
  Console property, `batch` with no configured engine. Full runs are not pre-checked (their steps report
  `setup_required` as before).
- **Quota (decision):** a partial run is one manual run in the same cap, `MANUAL_RUNS_PER_DAY` = 3 per project
  per UTC day (`src/shared/run-scope.ts`), shared with full manual runs and Ask Okara's `run_agent_now`.
  Refused requests (400/409/412, or 409 because the agent is locked) use no quota. Scheduled runs are never
  counted and never carry a scope (all steps).
- **Locks:** unchanged, one run per project + agent; a partial run holds the agent's lock like a full run
  (a second SEO section while one runs → 409 "already in progress"; the SEO and GEO agents run in parallel).
- **Idempotency:** the key includes the scope (`<pid>:<agent>:manual:<steps>[@<engines>]:<minute>`), so a
  double submit of the same section returns the same run (200).
- **Budgets:** unchanged; every provider call still reserves the project's and operator's daily caps.
- **Storage and display:** `agent_runs.scope_json` (migration `0016_run_scope.sql`; NULL = all steps),
  `{steps, engines}`. `RunSummary.scope` and `RunActivity.run.scope` return it (null for full runs); the
  `<agent>.run started` event says e.g. "Partial run: crawl only". Runs, Run detail, the Activity window and
  the Live view show that label (`scopeLabel`). An activity of a run limited to some engines lists only those
  lanes.
- Ask Okara's `run_agent_now` takes optional `steps` (no `engines`), with the same validation and pre-checks
  in its confirmation step.

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
- Builders: `src/worker/live/seo-board.ts` (`buildLiveSeo`), `src/worker/live/geo-board.ts` (`buildLiveGeo`).
- Cursor and merge: `src/worker/live/cursor.ts`. Batched lookups (pages, snapshots, Search Console, link
  suggestions): `src/worker/live/lookups.ts`.
- Element map: `src/worker/live/elements.ts` (`LIVE_SEO_ELEMENT_MAP`).
- Routes: `src/worker/routes/live.ts`, mounted with one line in `app.ts`.
- Tests: `tests/live-elements.test.ts`, `tests/live-worker-*.test.ts`.

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
- The source queries read only rows that become list rows (for example, decisions of non-element questions
  and rules without an element are never read). Should a read row still be hidden (a whitespace-only stored
  query), it advances its mark and reading continues in the same request until the page is full or every
  source is drained (at most 5 reads). So a page shorter than `limit` means nothing more is stored right now;
  the one exception is a run of more hidden rows than 5 reads cover, which returns a short page whose
  cursor still moves on. GEO answers are only shortened by the hold below, while the run is active.
- The `limit` counts the rows of all lists together.
- Each list in the response is ascending by `(at, id)`. Clients merge pages by `id`: an item can be older
  than items of a previous page.
- With nothing new, the request's cursor is echoed (null when none was given). Without `after`, rows start
  at the beginning of the run, so a client pages forward until the lists are empty, then polls.

**Totals:**
- `totals` always cover the whole run, regardless of `after`.
- They are computed only on the **last page of a read**: a page with fewer rows than `limit`. A full page
  returns `totals: null` (more rows follow right away; keep the previous totals), so a client paging in a
  long run does not rescan the whole run per page. The SEO feed's `gscSync` follows the same rule.
- `labels` carry their complete set (with current counts) on the page that carries totals; other pages
  may carry only part of it.
- They are computed with grouped queries, never by loading every row. For example, element verdicts group
  by `question_id`, `tier`, the stored answer type, the Noul side (`noul >= 0.5`) and the Choice option,
  read from `answer_json` the same way as the rows (a top-level string `type` is a bare answer, else
  `$.answer`; malformed JSON is treated as no answer). Code then applies the element map to each group, so
  totals and rows always agree.
- Each grouped query is limited to 500 groups. `totals.truncated` is true when any cap was hit; counts are
  then lower bounds.

**Polling:**
- No rate limit. The UI fetches a feed only after the heartbeat reports new rows of that kind, or every 6 s
  while the run is active, and never while the tab is hidden.
- Demo projects return their seeded demo runs' rows, with `labels` including "Demo data - simulated run".
  The demo SEO run seeds Jev element judgments for 6 demo pages (title, meta, intro, schema, freshness,
  topics, page action and action choice, in the runtime `answer_json` format with policy tiers) and query
  relevance answers for its 8 Search Console queries (2.4 s apart), so the labelled replay fills "Every SEO
  element, judged one by one" and "Queries classified by Jev" (`src/worker/demo/fixtures.ts`
  `DEMO_SEO_JUDGMENTS`, `DEMO_QUERY_RELEVANCE`). Its step events use the runtime step names with a
  `started` and a terminal event each (`seo.validate`, `seo.crawl`, `seo.gsc_sync`, `seo.recommend`,
  `seo.summary`; `geo.validate`, `geo.batch`, `geo_batch:<engine>` per demo lane, `geo.proposals`,
  `geo.summary`), and the former orchestrator sub-steps are `info` notes, so the run rail, pending rows and
  lane states replay as in a real run. The demo also seeds a fictional internal link run whose act-tier
  suggestions the SEO run reuses ("Links" rows, `DEMO_LINK_SUGGESTIONS`) and two fictional approved
  competitor-page assessments of URLs its answers cite (`DEMO_COMPETITOR_PAGES`, approved after the GEO run).

### GET /projects/:pid/live/seo?runId=&after=&limit= → `LiveSeoBoardResponse`

Builder `src/worker/live/seo-board.ts`. Sources and cursor keys `{d, f, r, k?}`:

| List | Source (key) | id | at | Notes |
|---|---|---|---|---|
| `elements` (role element/action) | `decision_records` of the run (`d`) | `dec:<id>` | `created_at` | Ids are the same as the `jev_decision` activity items. Questions mapped in `LIVE_SEO_ELEMENT_MAP` only; element and verdict from the STORED `tier` and raw `answer_json` (code, never Jev text). Question-less rows that reused an internal link suggestion (`answer_json.linkSuggestionId` set and `answer_json.kind` `internal_link`, the kind recommend/generate.ts stores, or `internal_link_suggestion`) become `Links` rows with the suggester's stored tier and Noul (`links.should_exist`) |
| `queries` | same rows (`d`) | `dec:<id>` | `created_at` | Questions `seo.query_relevance`, `seo.buyer_query`, `seo.buyer_ready`, `seo.query_intent`, listed only with the query text the row stores (`answer_json.query`, written by the query batches). Readable candidate keys hold a token bag (`text.ts queryKey`: sorted words without stopwords), not the typed query, so an in-candidate `seo.query_intent` answer is not listed; it is still counted in `totals.queries.intent`. `queryKey` is the normalized query (`normalizeDemandQuery`), so the rows of one query share it. `band`: act → yes/no (noul ≥ 0.5), flag → middle, else null |
| `elements` (role rule) | `audit_findings` of the run's crawl attempt (`f`, plus `k` = `crawl_runs.started_at` as in "Run activity", so a retried crawl restarts the mark) | `find:<id>` | `created_at` | Rules mapped in `LIVE_SEO_ELEMENT_MAP.rules`; class (rule registry) fact → change, heuristic → review; unmapped rules (for example `AI-SEARCH-CRAWLER-BLOCKED`) are not read |
| `recommendations` | `recommendations` of the run (`r`) | `rec:<id>` | `created_at` | Stage and status as stored at read time (`totals.pipeline` carries current counts). `action` clipped to 200, `suggestedSnippet` to 400 |

**Verdicts** (`src/worker/live/elements.ts`; keep = the stored answer says the element needs no change):

| Question | Keep when | Change when | Review |
|---|---|---|---|
| `seo.title_matches_query`, `seo.meta_matches_query`, `seo.answer_is_direct`, `seo.schema_content_match`, `seo.covers_topic#t<n>` | act tier, noul ≥ 0.5 | act tier, noul < 0.5 | flag, drop, n/a or no usable answer |
| `seo.outdated_information`, `seo.thin_content#e<n>`, `seo.page_overlap#<k>` (inverted) | act tier, noul < 0.5 | act tier, noul ≥ 0.5 | same |
| `seo.intent_page_fit` (Choice) | act, `fits` | act, `mismatch` | `partial_fit`, `insufficient_context`, flag, drop |
| `seo.page_action` (Choice) | act, `keep` | act, `update` / `merge` / `remove` | `insufficient_context`, flag, drop |
| `seo.action_choice` (Choice, role action; element by option) | act, `no_action` (demo fixture `none`) | act, any other mapped option | unmapped option, flag, drop |
| Reused link suggestion | never | suggester tier act | any other tier |
| Rule finding | never | class fact | class heuristic |

- A flag or drop tier, an n/a tier, or a missing or malformed answer is never keep or change.
- The decision **outcome** (selected, or rejected with `budget`, `duplicate`, `low_fit`, …) is a pipeline
  result about the candidate, not a judgment of the element, so it never changes the verdict.
- **Pending:** the server never sends a pending verdict. A candidate that is not judged yet has no stored
  row, so it has no row here. Replay pending states and the live "waiting for the next stored judgment"
  placeholders are client-side only.

**Row enrichment** (batched over the page's rows only; `src/worker/live/lookups.ts`):
- **Target** (first match wins): the candidate's recommendation (`recommendations.dedup_key =
  decision_records.candidate_key`, same run) via `target_json`: a URL gives its path; a template gives
  "Template: <name> (N URLs)"; a site gives "Site". Next, the first http(s) segment of the readable
  candidate key in `answer_json.candidate`. For rule rows, the finding's `url`, else "Template: <template>",
  else "Site". Otherwise "Candidate <readable key>" (the stored key).
- **`pageId`:** `pages` matched by URL (the stored spelling, with or without `www.` and a trailing slash,
  compared by page key).
- **`now`:** the element's value in the page's snapshot from this run's crawl, else the page's latest
  snapshot that was not skipped. Plain text clipped to 160:

  | Element | Value |
  |---|---|
  | Title | `title` |
  | Meta | `meta_description` |
  | Title + meta | "Title: <title> · Meta: <meta or none>" |
  | H1 | first `h1_json` entry |
  | Headings | first 3 `headings_json` texts, joined with " · " |
  | Intro | `first_paragraph` |
  | Schema | `jsonld_types_json`, joined ("Product, Offer") |
  | Content | "1,240 words" |
  | Freshness | "Updated 2025-03-02" (`last_updated`) |
  | Canonical | `canonical` |
  | Indexing | `robots_meta` |
  | Status | "HTTP 404" |
  | Intent | "<page type> page" |
  | Links | "<target path> has N internal links in" (`link_suggestions.target_inlinks`) |
  | others | null |

- **`proposed`:** the candidate recommendation's `suggested_snippet` (clipped to 160). It is never set on
  a keep row or a rule row. It is set only on rows of the element family ("Title + meta" covers Title and
  Meta) of the candidate's **decided** action, which `decidedActionElement` derives from the stored rows
  the way `seo/recommend/decide.ts` decides:
  - `seo.action_choice` counts only at act or flag tier (a drop or n/a tier is not an answer);
  - an act-tier "no" on `seo.title_matches_query` or `seo.meta_matches_query` makes it rewrite_title_meta
    ("Title + meta");
  - an act-tier `seo.page_action` merge makes it consolidate_duplicate ("Duplicate").

  When the decided action cannot be told from the stored rows (for example a candidate default action),
  no row gets the snippet. A drop-tier action row never gets it. So a title draft is never shown as a
  new intro, nor a meta-description draft as a new title.
- **`gsc`:** current window of the latest usable sync (completed or partial), device rows excluded.
  - Pages: the page's page-dimension rows (`basis` page_rows) when the sync stored any for it, else the
    sum of its query+page rows (`query_page_rows`, a lower bound: anonymized queries are omitted).
  - Queries: query-dimension rows (`query_rows`), else the sum of the query's query+page rows
    (`query_page_rows`).
  - `position` is the impression-weighted average of the stored rows (an approximation), rounded to 0.01;
    null without impressions. Grouped in SQL, so the read is bounded by the page's URLs and queries.
- **`jev`:** stored fields only: `noul` for Noul, `choice`/`confidence` for Choice, the stored `tier`,
  `provider` and `model` (for Links rows, the link suggestion's provider and model). A Noul never has a
  confidence.

**Other fields:**
- **`gscSync`:** the newest `gsc_syncs` row with `run_id` = the run (error clipped to 200). It is null
  when the run did not sync (or on a full page, see "Totals"); the UI then uses `GET /seo/overview` for
  charts.
- **`labels`:** "Demo data - simulated run" for demo projects; a note that verdicts are code over stored
  answers; the Search Console window when any row carries figures; "No Jev answers were stored in this
  run: rule findings only." for a finished run without provider answers (the web panel uses the same
  wording); the lower-bound note when `totals.truncated`.
- **`totals`:**
  - **`elements`:** counts verdicts over element, action, Links and rule rows. Action rows count only
    for candidates with no element-question row in the run (`candidate_key IN (…)` subquery), matching
    the UI rule that hides such action rows.
  - **`queries`:** `distinct` = distinct normalized queries with stored text (query-batch keys
    `qrel:` / `buyer:` without the prefix, else `answer_json.query`). Band counts per question
    (`unanswered` = drop tier or no usable answer). `intent` counts per stored option at act or flag tier.
  - **`pipeline`:** `candidates` and `judged` are distinct `candidate_key`s with decisions in the run,
    excluding the query-batch keys `qrel:` and `buyer:`; `judged` is those with a non-null `provider`.
    `rejectedByReason` counts distinct rejected candidates by `reason_code` ("unspecified" when none).
    `created`, `byStage` and `byStatus` count the run's recommendations (every stage and status key is
    present).

### GET /projects/:pid/live/geo?runId=&after=&limit= → `LiveGeoBoardResponse`

Builder `src/worker/live/geo-board.ts`. Sources and cursor keys `{o, r, p?}`:

| List | Source (key) | id | at | Notes |
|---|---|---|---|---|
| `answers` | `geo_observations` of the run with `measurement_type = 'api'` (`o`) | `obs:<id>` | `created_at` | Ids are the same as the `engine_answer` activity items. `outcome` uses `answerOutcome` (AI engine board definition). While the run is active, an `ok` answer not yet analysed holds back the source for at most 120 s (`OBS_HOLD_MS`), exactly as "Run activity"; after that (or once the run has ended) it is sent with `outcome: null`. Its rowid is kept in the cursor (`p`, at most 20) and it is re-sent with the same `id` once its analysis is stored (or it is no longer `ok`) |
| `recommendations` | `recommendations` of the run (`r`) | `rec:<id>` | `created_at` | As for SEO (agent `geo`) |

- **Answer enrichment:** batched over the page's observation ids (chunks of 90).
  - **From the self brand row** (`geo_brand_observations`, `is_self = 1`): `position` (`list_rank`, only
    stored for a real ordered list), `sentiment` with its stored `method` (null when the brand was not
    mentioned: `not_applicable`), and `recommendationStatus`.
  - **From `geo_citations`** (ordered by `position`, resolved with `resolveCitation`, so wrapped redirect
    URLs and `www.` count as the real host): `citedInstead` is the first non-own citation (any outcome),
    `ownCitedUrl` the first own one, and `citationCount` the total.
  - **`searchQueryCount`:** the answer's stored `geo_search_queries`; 0 when the provider exposes them
    (`usage_json.searchQueriesExposed` or a `searchQueries` list, the board's rule) and there were none;
    null when not exposed.
  - **`latencyMs`:** the `geo_answer%` provider call of the run joined on `request_id`.
  - **`cost`:** the observation's `cost_usd` (null = unknown, never $0) and `cost_is_estimate`.
  - **`model`, `groundingMode`:** the stored `geo_observations.model` and `grounding_mode` of this answer
    (the lane header of a replayed run shows the run's model, not the latest configuration).
  - **`matchedPage`:** `coverage/answer-coverage.ts` `matchPrompt` with the answer's own engine search
    queries, over the latest completed crawl of a verified site (titles/H1s of up to 2,000 pages) and the
    latest usable sync's query+page rows for those queries. Loaded once per request, only when the page
    has answers; null for failed answers and when nothing matches.
- **`plannedPrompts`:** only when `after` is absent. It uses the same selection as `geo/batch.ts` and the
  activity lanes: approved prompts of the run's prompt set (the active set while an active run has no
  answer yet), ordered by position, capped by `project_limits.geo_prompts_per_run` (or
  `DEFAULT_PROMPTS_PER_RUN`), at most 200; `[]` when the cap is 0 or less. It is null on later pages or
  when unknown. It reads the CURRENT approvals and cap, so for a finished run the UI lists the prompts the
  run actually answered as well (a prompt unapproved since still shows its stored answers), and a planned
  prompt with no stored answer reads "no stored answer", not "not run".
- **`totals.lanes`:** one entry per provider with answers in the run (board order, then custom lanes).
  Lanes without answers come from `RunActivity.lanes`.
  - `cited`, `named`, `missing`, `failed` and `pending` (stored `ok` answers not yet analysed) are
    counted over the run's answers (cap 2,000, as in "Run activity").
  - `cost` follows `laneCost`: value null when any cost is unknown, `isEstimate` when any is estimated.
  - `citedInstead` is the host most often first-cited (first non-own citation) among the lane's `missing`
    and `named` answers, with that answer count (ties: host name order). Citation rows read for it are
    capped at 20,000.
- **`totals.pipeline`:** as for SEO, over the run's GEO decisions and recommendations.
- **`totals.truncated`:** true when the answer or citation cap was hit, or a pipeline group cap.
- **`labels`:** "Demo data - simulated run" for demo projects; "API-sampled answers; consumer apps may
  answer differently."; the outcome definitions; the best-page heuristic note when any answer has a
  matched page; when any lane has stored answers without an outcome: "N stored answer(s) are awaiting
  analysis…" while the run is active, else "N stored answer(s) were not analysed; their outcome is not
  counted." (analysis only runs inside the run, so it will not come later); the custom engine note when a
  custom lane answered; the lower-bound note when truncated.
- **Not shown:** a per-run citation rate. The UI derives it from the lane counts and always shows the
  numerator and denominator. There is no score, projection, or prompts-per-second rate.

## Live view: project containers (amends docs/build-kit.md [A31], 2026-10-03; UI docs/live-view-design.md section 17; types in `src/shared/types.ts`, section "live view: project containers")

### GET /projects/:pid/live/insights?kind=<kind> → `{data: LiveInsight}`

One read-only aggregate of the project's latest STORED data per container, for aggregates no existing endpoint
returns. No provider call, no Jev, no budget reservation, no write. The project is resolved with
`requireProject()` (404 for another tenant's project, as for every project route); every statement on tenant
rows filters `workspace_id` and `project_id`, has a `LIMIT`, and binds fewer than 100 values (D1's limit; IN
lists are chunked). `usage_counters` has no workspace column: the budget reads it by the resolved project's
scope key and the operator's `global` key (aggregate used/limit only, returned only for resources this
workspace spends on an operator key, i.e. where that global cap can refuse its calls).
`kind` missing or unknown → 400 `{field: "kind"}`. Builders: `src/worker/live/insights.ts` (dispatcher, sheets,
budget), `insights-seo.ts`, `insights-geo.ts`; pure grouping and the thresholds in `insights-lib.ts`.

Every response has `kind`, `state` (`ready` | `demo` | `setup_required`), `message` (plain text, set with
`setup_required`), `generatedAt`, `labels` (data notes; "Demo data - simulated run" first for demo projects)
and `truncated` (a cap was hit; counts are lower bounds and a label says so).

| kind | Container | Source (stored rows only) | Main fields |
|---|---|---|---|
| `striking` | SEO 10 | latest usable `gsc_syncs` (completed or partial, newest `synced_at`); its `gsc_metrics` current-window query+page rows (device rows excluded) with `position` in [8, 20] and `impressions` ≥ 1, ordered by impressions desc, query, page, top 50; the same query+page (exact strings) of the previous window, looked up in chunks of 45 pairs | `sync` (id, runId, source, syncedAt, current/previous windows, truncated), `thresholds`, `rows[{query, page, clicks, impressions, ctr, position, previous}]`, `total` (rows in range). No sync → `setup_required`. A CSV-import sync has no query+page rows (label) |
| `movers` | SEO 11 | the same sync; per page and window: SUM of clicks/impressions, impression-weighted position, grouped in SQL (page rows when the sync stored any, else query+page rows, `basis` says which; the latter is a lower bound), at most 5,000 pages by clicks | `basis`, `gainers` / `losers` (top 8 by measured click difference, pages present in BOTH windows only; `current`, `previous`, `clickDelta`), `counts{both, unchanged, newPages, lostPages}`, `top` |
| `technical` | SEO 12 | latest `crawl_runs` with status completed/partial; its `audit_findings` grouped by (severity, rule_id) (at most 500 groups) with the first 5 examples per group (`ROW_NUMBER`), rule name/area/class from the rule registry; a newer running/failed crawl | `crawl` (id, runId, status, startedAt, finishedAt, pagesCrawled, pagesSkipped, pagesLimit), `newer`, `bySeverity`, `total`, `groups[{severity, ruleId, ruleName, area, class, count, examples[{url, template, detail}]}]`. Unverified non-demo project → `setup_required` (the crawler only reads verified hosts) |
| `engine_queries` | GEO 06 | `geo_search_queries` joined to API `geo_observations` stored in the last 30 days, grouped by stored `normalized` (COUNT DISTINCT answers, MAX time, providers), top 50, merged again with `normalizeQuery`; each query looked up EXACTLY (`normalizeDemandQuery`) in the latest usable sync's current window (`live/lookups.ts` `loadGscMetrics`, the Live feed's lookup) | `window{from, to, days}`, `rows[{query, engines, answers, lastSeen, gsc}]` (`gsc`: `{clicks, impressions, position, basis}` or null), `total` (distinct stored queries), `gscSync{syncedAt, window}` or null, `limit` |
| `brands` | GEO 07 | `geo_brand_observations` of analysed (`ok`) API answers to discovery prompts in the last 30 days; one brand row per answer (MAX per answer, then SUM per provider and brand; at most 500 groups) | `window`, `engines`, `brands[{brandKey, name, isSelf, engines[{provider, answers, mentioned, cited, recommended, negative}], total}]` (your brand first); all counts are "n of m answers that checked the brand" |
| `cited_domains` | GEO 08 | `geo_citations` of `ok` API answers in the last 30 days (newest answers first, at most 20,000 rows), host resolved as the Live feed does (wrapped redirect links by their bare-domain title, `www.` folded; unresolved counted), tagged with `projectBrands` (self / tracked competitor by configured domains) | `window`, `rows[{host, answers, engines, sourceType, tag}]` (top 25 by answers), `own` (your host's row even when outside the top 25, else null), `answersWithCitations`, `totalHosts`, `unresolved`, `limit` |
| `prompt_history` | GEO 09 | active `geo_prompt_sets` and its approved `geo_prompts` (≤ 100); the project's newest 40 GEO `agent_runs`; their API `geo_observations` (≤ 6,000, newest first) with the self brand row; outcome per answer as the AI engine board defines it (cited / named / missing / failed / not analysed) | `promptSet{version, label}`, `engines[{provider, runs[{runId, at}]}]` (each engine's last ≤ 8 runs with stored answers, oldest first), `rows[{promptId, text, cells[engine][run]}]` (`cited` \| `named` \| `missing` \| `failed` \| `not_analysed` \| `none`), `maxRuns`. No prompt set → `setup_required` |
| `sheets` | SEO 14, GEO 10 | `import_syncs` of the project (≤ 50); per sync, completed sync imports and their `import_changes` by action in the last 7 days; for GEO-prompt tabs, `import_records` by status (by the tab's source key) and the active set's prompts they put in it, with the newest stored API answer to the same prompt text | `canManage` (workspace owner), `sheets` (Google Sheets connection state), `activePromptSet`, `syncNowPerHour`, `syncs[{id, spreadsheetTitle, tab, destination, enabled, frequencyHours, lastRunAt, lastStatus, lastErrorCode, lastError, lastWarning, nextRunAt, recent{days, imports, added, updated, removed}, prompts}]`. Migration 0015 missing → `setup_required` |
| `budget` | SEO 15, GEO 11 | `project_limits`, today's (UTC) `usage_counters` for the project scope key and the global scope key, today's manual `agent_runs`, `credentialSources` + `dataForSeoSource` (which key each provider uses) | `day`, `project[{resource, label, used, limit, counted}]` (priced spend in micro-USD, provider calls, Jev calls, writer tokens, crawl pages, Search Console rows, GEO prompt answers; `limit` from the counter row, else the project limit), `global` (only resources this workspace spends on an operator key, as `runs/budget.ts` charges them; DataForSEO on the operator's credentials adds spend and provider calls), `manualRuns{used, limit: 3}`, `keys[{provider, label, source}]`, `notes` |

Thresholds and caps are exported constants in `src/worker/live/insights-lib.ts` (`STRIKING_DISTANCE`, `MOVERS`,
`TECHNICAL`, `INSIGHT_WINDOW_DAYS`, `ENGINE_QUERIES_LIMIT`, `CITED_DOMAINS`, `PROMPT_HISTORY`, `SHEETS`).
Untrusted strings (queries, URLs, sheet titles, tabs and error text, brand keys) are clipped and returned as
plain data; the UI renders them as text. SEO 13 (competitor keyword gap) needs no new endpoint: it reads
`GET /projects/:pid/competitors/dataforseo` and `GET /projects/:pid/competitors/dataforseo/domains/:domain`
and its button calls `POST /projects/:pid/competitors/dataforseo/refresh {domain}`; the sheet buttons call
`POST /projects/:pid/import/syncs/:syncId/run` (both unchanged; see "Competitor data (DataForSEO)" and "Import").
Tests: `tests/live-insights-worker.test.ts` (tenancy, thresholds, demo, bounded statements on ≥ 2,000 Search
Console rows and ≥ 500 answers), `tests/live-insights-lib.test.ts`.

## Ask Okara (chat) (amends docs/build-kit.md, 2026-10-02; types in `src/shared/types.ts`, section "Ask Okara")

An in-app agent docked on the right of every project page. It answers questions about one project's stored
data by calling internal tools and can propose actions that run only after the user confirms. Code:
`src/worker/chat/*`, `src/worker/routes/chat.ts`, `src/web/components/chat/*`. Schema: migration
`0013_chat.sql` (`chat_sessions`, `chat_messages`, `chat_actions`).

Auth and tenancy: every route is `requireUser` + `requireProject` (404 for non-members); sessions are private to
the user who created them (another member gets 404). Tools run with that user's permissions, for that project
only; every query filters by `workspace_id` + `project_id`. POSTs go through the app-wide CSRF middleware.

| Method | Path | Response |
|---|---|---|
| GET | `/projects/:pid/chat/status` | `ChatStatus` (`state` ready / setup_required, configured model, limits) |
| GET | `/projects/:pid/chat/sessions` | `ChatSessionSummary[]` (history, newest first, at most 50) |
| POST | `/projects/:pid/chat/sessions` | 201 `ChatSessionSummary` (prunes this user's sessions in the project to the newest 50) |
| GET | `/projects/:pid/chat/sessions/:sid` | `ChatSessionDetail` (messages with steps, actions) |
| DELETE | `/projects/:pid/chat/sessions/:sid` | `{deleted: true}`; 409 `chat_busy` while a turn runs |
| POST | `/projects/:pid/chat/sessions/:sid/messages` body `{content}` (1-4,000 characters) | `ChatTurnResult`; `?stream=1` streams ndjson `ChatStreamEvent` lines (`started`, `phase`, `step`, `text_delta`, `status`, `done` with the same `ChatTurnResult`, or `error`; see "Speed" below) |
| POST | `/projects/:pid/chat/sessions/:sid/actions/:aid/confirm` | body empty, or `{secret: {ok, keyHint}}` for a secure-field action ([A35]; nothing else accepted). `ChatTurnResult` (`?stream=1` likewise): executes the pending action once, then the agent continues |
| POST | `/projects/:pid/chat/sessions/:sid/actions/:aid/cancel` | `ChatTurnResult`: the action is cancelled and the agent is told so |

Errors before a turn starts are JSON: 400 (empty/oversized message), 404, 409 `chat_busy` (a turn is running in
this chat) or `chat_full` (200 messages; start a new chat), 412 `setup_required` (no usable chat model; nothing
is stored), 413, 429 `rate_limited` (per user: 20 messages, 30 confirm/cancel, 30 new chats per 10 minutes).
Failures inside a turn (budget exhausted, provider error, refusal) end the assistant message with
`status: "error"` and a safe `error` text; the session lease is always released.

**Model.** The workspace writer, when it can call tools: a selected workspace custom writer (OpenAI-compatible
`POST {base}/chat/completions` with `tools: [{type:"function", function:{name, description, parameters}}]`,
`tool_calls`, `role: "tool"` results; https://platform.openai.com/docs/api-reference/chat/create), else the
operator writer (`WRITER_PROVIDER=anthropic`: Messages API client tools through `@anthropic-ai/sdk`,
`tool_use` / `tool_result` blocks, https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview; or
`openai_compatible` as above). The model id comes only from `WRITER_MODEL` or the custom writer; there is no
default. No `tool_choice` (auto) and no `thinking` parameter are sent. Missing configuration or key ->
`setup_required` with the reason and a link to Integrations. A custom writer's host alone joins that request's
API allowlist; the response body is capped (2 MiB) and its key scrubbed from stored errors.

**Loop.** At most 8 model rounds and 120 s per turn (then the answer says it stopped); one model round = one
metered call (`provider_calls` + `writer_tokens` reserved before sending, settled to reported usage, recorded
with purpose `chat.turn`, cost unknown/NULL; operator global caps apply when the writer runs on the operator
key). Output cap per round: 6,000 tokens. Earlier turns are replayed as text only (user text + answer text, at
most 12 messages / 24,000 characters); inside a turn the provider transcript is append-only (assistant content,
including thinking blocks, replayed verbatim; every tool call answered in call order in one results message).

**Tools** (arguments validated with zod; result JSON capped at 12,000 characters, untrusted strings at 300):
read - `get_overview`, `search_console_queries` (top/declining/rising queries or pages, current vs previous
window, contains filter, limit <= 50), `list_pages`, `page_details`, `list_recommendations`,
`get_recommendation`, `geo_results`, `list_competitors`, `list_runs`, `run_activity`, `checklist_status`,
`internal_link_suggestions`, `draft_check` (deterministic checks only; no Jev from chat; text <= 20,000
characters); action (confirmation required) - `run_agent_now` (same quota/lock rules as `POST
/projects/:pid/runs`), `update_recommendation_status` (approved | dismissed; same transitions as PATCH),
`approve_competitor_page` (only a URL stored as a citation for this project; same rules as `POST
/projects/:pid/geo/competitor-pages`); output - `navigate` (an in-app route under `/projects/:pid/`; ids are
checked against the project) and `export_csv` (up to 500 rows returned to the UI as a step `download`; the
model receives only the count and columns; the CSV is built client-side with formula cells neutralised). No tool
fetches a URL the model chooses.

**Search Console and DataForSEO tools (amends docs/build-kit.md [A27], 2026-10-03; code
`src/worker/chat/tools-gsc.ts`, `src/worker/chat/tools-dataforseo.ts`).** Every result names its source and
window: Search Console results carry `dataSource` "Google Search Console (first-party, measured), stored sync of
<date> (API|CSV import)" or "..., live API call"; DataForSEO results carry "DataForSEO Labs (third-party estimate,
not measured)" plus fetched date, location and the DataForSEO-reported cost.

| Tool | Kind | Data source | Notes |
|---|---|---|---|
| `search_console_queries` | read | stored sync | unchanged arguments; now returns `dataSource` |
| `search_console_pages` | read | stored sync | same as `search_console_queries` with `dimension=page` (page slice when stored) |
| `search_console_trend` | read | stored sync (`gsc_daily`, `totals_json`) | daily clicks/impressions/CTR of the current window (finalized days only) + Google's property totals (incl. average position) for both windows; daily position is not stored |
| `search_console_compare` | read | stored sync | per query or page, current vs previous 28 days: `lost` (prev > 0, now 0), `declined`, `gained` (prev 0), `improved`, each with count, total change and top rows (<= 25); optional `segment` brand / non_brand (queries), `contains`, `metric` clicks / impressions |
| `search_console_brand_split` | read | stored sync | brand vs non-brand per window (brand.ts matcher), top brand / non-brand queries; `setup_required` without brand terms |
| `search_console_buyer_queries` | read | stored sync | `jevClassified`: the SEO buyer-query view from cached Jev decisions only (never calls Jev); `modifierMatches`: deterministic commercial-modifier list (`strong-intent-en-2026-09-30.1`, English only), brand excluded unless `includeBrand` |
| `search_console_live_query` | read (live, free) | Search Console API `searchanalytics.query` | the project's stored `gsc_property` only (the model cannot name a property); `startDate`/`endDate` within the last 16 months, not in the future; up to 3 dimensions of query / page / country / device / date; up to 5 AND filters (query / page / country / device; equals, notEquals, contains, notContains, includingRegex, excludingRegex); `searchType` web / image / video / news; `dataState` final / all; `rowLimit` <= 1,000 (default 100), `startRow` 0. Rate limits: 10 per user per 10 minutes, 100 per project per UTC day. No connection, no property or `invalid_grant` -> `{state: "setup_required", path: <Integrations>}`; demo projects -> `{state: "demo"}`; 429 -> "wait about 15 minutes". Each call is recorded in `provider_calls` (provider `google_search_console`, purpose `chat_gsc_live`, cost 0 actual: the API is not billed). The step result starts "Called Search Console API (live)". |
| `dataforseo_competitor_data` | read | stored `competitor_snapshots` | one tracked domain (`section` overview / top_keywords / keyword_gap / top_pages / all, `limit` <= 50) or all tracked domains (overview + latest refresh); untracked domain -> error naming the tracked ones; no credentials -> the panel's `setup_required` message |
| `dataforseo_refresh_competitor` | action (paid) | DataForSEO Labs (3 Live tasks) | workspace owner; tracked domain; credentials required (else `setup_required: ... Integrations → DataForSEO`); the card says "About $0.06 at most, billed by DataForSEO; daily caps apply (2 per domain, 10 per project per UTC day)"; executes the same queue path as `POST /projects/:pid/competitors/dataforseo/refresh` (shares its `dfs_refresh` rate limit) |
| `dataforseo_keyword_lookup` | action (paid) | DataForSEO Labs Keyword Overview (live) | workspace owner; 1-100 keywords (<= 80 characters, <= 10 words, deduplicated case-insensitively); location = the project's competitor-data location (or the locale mapped through the free locations list); the card shows the ceiling `$0.012 + $0.00012 x keywords`; on confirm: one call, `provider_calls` with the returned cost (actual), `provider_calls` + `usd_micros` reserved first via `budgetForKeySource` and settled to the returned cost (unknown outcome keeps the ceiling); 10 lookups per user per 10 minutes. Results are returned to the chat only (not stored). |

Paid tools never run from a model call alone: the confirmation gate below applies, and keywords, URLs and
domains returned by Search Console or DataForSEO are untrusted data.

**Admin tools (amends docs/build-kit.md [A33], 2026-10-03; code `src/worker/chat/tools-admin.ts` (reads),
`src/worker/chat/tools-admin-actions.ts` (actions)).** The chat can read every product area of its project and
propose every UI write a member (or, for owner-only routes, the owner) can make. Reads are grouped behind a
`view`/`kind` enum. Each tool calls the mirrored route's own service function with the `requireProject()` row, so
tenancy, validation, rate-limit keys (shared with the UI), quotas and role rules are the route's. Outputs pass
`compact()` (secret-looking keys dropped, strings clipped, arrays cut with `<key>Total`) and the 12,000-character
cap. Integration status is hand-picked: configured / source / state / model / host / last test only; never a key,
key hint, encrypted column, OAuth token or state row, session or verification token.

**Maton (2026-10-03):** `maton_data` (read, owner only, 20 per user per 10 minutes) reads live through the workspace Maton key via `platform/maton.ts` (same egress allowlist): `status`, `sheet_tabs`, `sheet_values` (≤200 rows), `gsc_query` (this project's property only), `ga_properties`, `ga_report` (GA4 runReport, ≤100 rows). Results carry the Maton source label; no key leaves the server.

| Tool | Kind | Mirrors | Notes |
|---|---|---|---|
| `seo_audit` | read | GET `/seo/audit`, `/seo/page-audit`, `/seo/content-evidence`, `/seo/translation-opportunities`, `/seo/robots-suggestion` | `view` findings (severity / contains filters) / page_audit / content_evidence / translation / robots (`allowTraining`; one SSRF-guarded GET of the verified host's robots.txt under the route's `robots_suggest` limit) |
| `link_workbench` | read | GET `/seo/internal-links/{graph,graph/urls,graph/url,clusters,broken,anchors,placed}` | `view` summary / urls (`filter`, `sort`, `dir`, `q`, `offset`, `limit`) / url (`url`) / clusters / broken / anchors (`all`) / placed |
| `live_insight` | read | GET `/live/insights?kind=` | every kind (striking, movers, technical, engine_queries, brands, cited_domains, prompt_history, sheets, budget) |
| `geo_data` | read | GET `/geo/prompts`, `/geo/board`, `/geo/answer-coverage`, `/geo/citation-evidence`, `/geo/displacements`, `/geo/search-queries`, `/geo/rewrite-plans`, `/geo/competitor-pages`, `/geo/observations/:id`, `/geo/pages/:pageId/skip-factors` | observation ids must belong to the chat's project |
| `import_data` | read | GET `/import`, `/import/records/:destination`, `/import/links` | `view` overview (Sheets state without tokens) / syncs / records / placed_links |
| `project_admin` | read | GET `/projects/:pid`, `/limits`, `/usage`, `/integrations`, `/workspaces/:wid/{credentials,custom-providers,dataforseo}` (status only), `/context`, `/verification` (no token), `/attention`, `/activity/current`; members from `memberships` (name + role only) | `view` settings / limits / usage / integrations / members / context / verification / attention / active_runs |
| `run_detail` | read | GET `/runs/:id`, `/runs/:runId/activity`, `/live/seo`, `/live/geo` | `view` detail / activity / live_board |
| `checklist_status` | read | GET `/checklists/:kind`, `/pages/:pageId/checklist` | new `include: open | all` (all items, `manual` flag) |
| `link_job` | action | POST `/seo/internal-links/run`, `/graph/rebuild` | `job` analysis (3/hour/project, Jev + writer budget) / rebuild_graph (6/hour/project) |
| `set_link_suggestion_status` | action | POST `/seo/internal-links/bulk` | 1-90 ids; open / accepted / dismissed / implemented |
| `edit_link_cluster` | action | PUT `/clusters/hub`, `/clusters/assign` | mark / unmark / clear hub, assign / unassign / reset spoke; URLs on the verified host; 120 edits/hour/project |
| `manage_import_sync` | action | POST `/import/syncs/:id/run`, PATCH `/import/syncs/:id` | **owner only** (checked at proposal and again at execution); run_now (per-sync hourly limit) / enable / disable / set_frequency (6, 12, 24) |
| `update_geo_prompts` | action | PUT `/geo/prompts` | approve / unapprove / remove by id, add prompts; brand-blind discovery prompts, <= 25, no duplicates; saves a new version |
| `update_competitors` | action | PATCH `/projects/:pid` (`competitors`) | add (≤ 20 per call) / remove; at most 60 competitors; the card states the DataForSEO estimate for the new domains ("N new competitor domains → up to N × $0.0624 ..., fetched at most 10 per day") when auto-fetch applies |
| `update_project_settings` | action | PATCH `/projects/:pid`, PUT `/limits` | name, brand, aliases, description, audience, voice, site type, locale, language, schedule; limits within `LIMIT_BOUNDS` (e.g. crawl pages per run 1-200). Site URL: Settings page |
| `update_checklist_item` | action | PUT `/checklists/:kind/:itemId`, `/pages/:pageId/checklist/:itemId` | manual items only |
| `classify_buyer_queries` | action | POST `/seo/buyer-queries` | Jev; the route's per-user and per-project-day limits |
| `set_page_type` | action | PATCH `/pages/:pageId` | |
| `cancel_run` | action | POST `/runs/:id/cancel` | pending / running only |

**Models, credentials and owner admin (amends [A33]; docs/build-kit.md [A35], 2026-10-04; code
`src/worker/chat/{tools-models,tools-admin-settings,route-bridge,secrets,secret-fields}.ts`).** Every change runs
the existing route handler in-process as the signed-in user (`route-bridge.ts`: same handler, owner check,
validation, demo refusals and rate-limit keys as the page; no browser request, so no CSRF; the user's own confirm
POST already passed it). Action rows are owner-only in chat (checked at proposal and again at execution; the route
checks again).

| Tool | Kind | Mirrors | Notes |
|---|---|---|---|
| `models` | read (member) | GET `/workspaces/:wid/{credentials,custom-providers,dataforseo,maton}`, `/projects/:pid/{integrations,gsc/maton}` | writer (`source` default / `custom:<id>`, active host + model), `askOkara` ([A36]: `source` writer / `custom:<id>`, ready, provider, model, host), custom providers (id, role writer/geo/chat, `isChat`, label, host, base URL, model, last test), engines (configured, key source, state, model, model source, workspace model, `modelSelectable`), DataForSEO, Maton apps, Search Console / Sheets. No key, key hint, encrypted column or token |
| `provider_models` | read (owner) | POST `/workspaces/:wid/custom-providers/models` `{providerId}`, POST `/credentials/:provider/models` `{}` | live Fetch models (10/min per user, shared); `contains`, `limit` |
| `integration_options` | read | GET `/projects/:pid/gsc/properties`, `/gsc/maton/sites`, `/workspaces/:wid/maton`, `/projects/:pid/competitors/dataforseo/locations` | `view` gsc_properties / maton_gsc_sites / maton_connections / dataforseo_locations |
| `manage_models` | action (owner) | PUT `/writer-source`; PUT `/chat-model-source` ([A36]); PATCH `/custom-providers/:id` (`model`; `baseUrl` + `keepKeyForNewHost: true`); PUT `/credentials/:provider/model`; DELETE `/custom-providers/:id`; POST `/custom-providers/:id/test`; secure field: POST `/custom-providers`, PATCH `/custom-providers/:id` (`baseUrl` + new key) | `op` set_writer / set_chat_source (`writer` \| `custom:<id>` of a role chat row) / set_custom_model / set_engine_model / update_base_url / add_provider (`role` writer / geo / chat; `useAsWriter` / `useAsChat`) / remove_provider / test_provider. set_custom_model and update_base_url work on chat rows like writer rows. Base URLs pass `validateCustomBaseUrl` at proposal (https, public hostname, no IP / port / query / credentials / own origin). A model id must be in the provider's live list when the list is complete (otherwise the card says it was not verified). update_base_url: same host needs `keepSavedKey: true`; a new host takes `keepSavedKey: true` (card says the saved key will be sent there) or a new key in the secure field |
| `manage_credentials` | action (owner; test of a built-in / DataForSEO / custom key: member, as the route) | secure field: PUT `/credentials/:provider`, PUT `/dataforseo` (login + password), PUT `/maton`, PATCH `/custom-providers/:id`; DELETE `/credentials/:provider`, `/dataforseo`, `/maton`; POST `.../test`, `/custom-providers/:id/test` | `op` set_key / remove_key / test; `target` typesafe, gemini, perplexity, openai_geo, anthropic_geo, writer, dataforseo, maton, `custom:<id>` |
| `admin_settings` | action (owner) | PUT `/projects/:pid/context/:kind`, PUT `/competitors/dataforseo/settings`, POST `/verification/check`, POST `/decisions/:id/feedback`, PUT `/projects/:pid/gsc/source`, PUT `/gsc/property`, PUT `/workspaces/:wid/maton/connections/:app` | `op` context_doc (full content; facts kept unless given) / dataforseo_settings / verification_check / decision_feedback / gsc_source / gsc_property / maton_connection |

**Secrets never pass through the chat.** No tool schema has a key field (strict schemas reject `apiKey`, `key`,
`password`, ...). Before validation, a tool call whose arguments hold a key-like value (known prefixes such as
`sk-`, `AIza`, `pplx-`, `ghp_`, JWTs, Google OAuth tokens; a long random token after key / token / password; a long
mixed-case random token outside a URL) is refused: no pending action, step arguments `[withheld: looked like a
secret]`, the model is told to use the secure field, and the kept assistant round is masked. A user message that
looks like it contains a key is stored, titled and sent to the model with each key replaced by
`[key removed — use the secure field]`. An action that needs a key returns `ChatAction.secretField`
(`{label, fields: [{name: apiKey | login | password, label}], request: {method, path, body}, hintFrom, note}`, only
while pending): the card renders password inputs (autocomplete off, uncontrolled, cleared once the request is built),
sends the typed values plus the non-secret `body` DIRECTLY to `request` (the web only allows the credential routes
above), and then confirms with `POST .../actions/:aid/confirm` body `{secret: {ok, keyHint}}` (`keyHint` 1-4
characters). The confirm route accepts nothing else (400 for any other field, never echoed); a secure-field action
confirmed without `secret` is `400 secret_required`; `execute()` only verifies that the route stored a key with that
hint after the proposal (else `failed`). The action result shows the hint, e.g. "Key saved for Google Gemini (…wxyz)".

Not available from chat (the assistant answers with `navigate` to Integrations or Settings): key reveal, Google
OAuth connects / disconnects (browser redirect), member or role changes, workspace or project delete, the sign-in
allowlist (an environment variable), CSV / sheet import wizards (dry-run, commit, undo), manual GEO answer import,
the redirect map, AI prompt suggestions and the project JSON export.

**Confirmation gate (server-enforced).** The loop never executes an action: it validates it (`prepare`), stores
a `chat_actions` row `pending`, marks the step `awaiting_confirmation`, saves the paused transcript on the
session and stops. Only `.../confirm` runs it, exactly once (`pending -> executing` is a conditional UPDATE;
repeats return the current state), then the agent continues with the result. `.../cancel` and a new message
(`expired`) close it without running. Text in tool results (pages, AI answers, evidence) is evidence, never
instructions, and cannot confirm anything.

**Rendering.** Answers render as markdown-lite (paragraphs, lists, bold, inline code, links) parsed into React
text nodes, never HTML; links only to `/projects/<this project>/...` routes or http(s) URLs.

**Speed: routing, streaming, parallel reads (amends docs/build-kit.md [A40], 2026-10-08; code
`src/worker/chat/{routing,stream,cache,prefs}.ts`, migration `0023_chat_speed.sql`).**
- *Tool routing.* A round no longer sends all ~54 tool schemas. It sends the core tools (`get_overview`, `models`,
  `list_runs`, `run_activity`, `navigate`), the meta tool `more_tools`, and the tools of the groups chosen
  deterministically from the user's message (keyword / intent map) plus the groups the previous answer used:
  `search_console`, `dataforseo` (competitors, volume), `internal_links`, `backlinks`, `live`, `geo`, `imports`
  (sheets, Maton, GA4), `models` (model / key changes), `settings`, `work` (recommendations, runs), `seo_site`
  (pages, audit, checklists, draft check), `export`. No match and no previous groups -> `work`. The system prompt
  has a short base (rules, safety, actions, keys) plus one snippet per active group. Within a turn the set only
  grows and keeps registry order: a call to a registered tool that was not sent still runs (same validation and
  confirmation gate) and its group joins the next round; `more_tools {groups: [...]}` loads groups once per answer
  (a second call returns an error result); an answer that says it lacks a tool ("I don't have a tool for ...") is
  discarded once and the round is re-sent with every group. The routed set is kept with a paused action and reused
  on confirm. Typical rounds drop from about 18,000 to 2,800-5,000 estimated input tokens (`estimateTokens`).
- *New read tool `backlinks`* (`view`: `summary`, `list` with `status` / `contains`, `detail` by `id`, `events`):
  the backlink monitor's stored checks ([A38]); checks are started on the Backlinks page, not from chat.
- *Streaming.* With `?stream=1` the model is called with streaming (OpenAI-compatible: `stream: true`,
  `stream_options: {include_usage: true}`, SSE `chat.completion.chunk` deltas with `content` and `tool_calls` by
  index; Anthropic: Messages API SSE events parsed by the SDK). Visible text is forwarded as
  `{type: "text_delta", round, delta, reset?}`: append to that round's text, `reset` = replace it, a later round
  replaces the earlier round's text. Deltas are display only (the `done` result carries the stored answer); text is
  released only up to the last whitespace and through the same key masking as the stored answer, and
  `<tool_call>` text (text-tools mode) is never streamed. `{type: "phase", phase: "model" | "tools", round,
  tools?}` says what the turn is doing. A provider that answers JSON to a stream request is accepted (its text goes
  out as one delta); an HTTP 400 to a stream request is retried once without streaming and remembered. Usage comes
  from the final stream chunk; without one the call is metered with Okara's estimate and `provider_calls.
  tokens_are_estimate = 1`. JSON mode (no `?stream=1`) sends no stream request.
- *Remembered endpoint facts.* `chat_model_prefs (workspace_id, host, model, text_tools_until, no_stream_until)`:
  when an OpenAI-compatible endpoint ignores native tools (the text-tools fallback) or rejects streaming, later
  turns start in that mode for 24 hours (no empty native round, no rejected stream attempt), then probe again.
- *Parallel reads.* Read / output calls of one round run concurrently (at most 4); results go back to the model
  and steps to the UI in call order. Actions stay sequential and confirmation-gated.
- *Result cache.* The same read tool with the same normalized arguments in the same chat session within 120 s
  reuses the earlier result (step text "(reused, under 2 min old)"); never for actions, output tools or errors;
  live / run-status tools skip it when the user's message asks for fresh data ("refresh", "again", "latest",
  "now", ...); a confirmed action clears the session's entries. Memory per Worker isolate (best effort across turns).
- *Panel.* While a turn runs it shows the current step ("Thinking…", "Reading Search Console…", "Writing answer…")
  with elapsed seconds and renders the streamed text (applied at most every 100 ms, markdown-lite text, never HTML,
  `aria-busy`); the polite live region announces step changes only. Limits unchanged: 8 model rounds and 120 s per
  turn, budgets, secret rules, the confirmation gate and the secure-field flow.
