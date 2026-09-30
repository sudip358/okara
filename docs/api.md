# API contract

All routes are under `/api`. JSON bodies. Success: `{ "data": T }`. Failure: `{ "error": { code, message, details? } }`.
Types referenced below are in `src/shared/types.ts`. State-changing requests require the session cookie, a
same-origin `Origin` header, and `X-CSRF-Token` (value from `GET /api/me`). Every project-scoped route resolves
access with `requireProject(db, user.id, projectId)`; every workspace-scoped route with `requireWorkspaceMember`.

| Method | Path | Owner module | Returns |
|---|---|---|---|
| GET | /health | foundation | `{ok:true}` |
| GET | /auth/login?returnTo= | platform-auth | 302 to Google (state, nonce, PKCE) |
| GET | /auth/callback | platform-auth | 302 to app; creates user/workspace on first login |
| POST | /auth/logout | platform-auth | `{ok:true}` |
| GET | /me | platform-auth | `Me` |
| POST | /auth/dev-login | platform-auth | local-only demo bypass (DEV_AUTH_BYPASS=true AND ENVIRONMENT=development AND localhost) |
| GET | /workspaces/:wid/credentials | platform-auth | `IntegrationsStatus["providers"]` (no keys) |
| PUT | /workspaces/:wid/credentials/:provider | platform-auth | body `{apiKey}`; stores encrypted; returns provider status |
| POST | /workspaces/:wid/credentials/:provider/test | platform-auth | body `{apiKey?}` (tests the typed key if given, else saved); `{ok, detail}` |
| DELETE | /workspaces/:wid/credentials/:provider | platform-auth | `{ok:true}` |
| GET | /workspaces/:wid/projects | platform-projects | `Project[]` |
| POST | /workspaces/:wid/projects | platform-projects | body `ProjectInput`; `Project` |
| GET | /projects/:pid | platform-projects | `Project` |
| PATCH | /projects/:pid | platform-projects | partial `ProjectInput` + `scheduleEnabled`; `Project` |
| DELETE | /projects/:pid | platform-projects | deletes tenant data, revokes integrations |
| GET | /projects/:pid/export | platform-projects | JSON download of all project data, no secrets |
| GET | /projects/:pid/context | platform-projects | `ContextDocument[]` (latest version per kind) |
| PUT | /projects/:pid/context/:kind | platform-projects | body `{content, facts}`; new version; `ContextDocument` |
| GET | /projects/:pid/verification | platform-projects | `VerificationStatus` |
| POST | /projects/:pid/verification/check | platform-projects | body `{method:'dns'|'file'|'gsc'}`; `VerificationStatus` |
| GET | /projects/:pid/limits | platform-projects | `UsageSummary["limits"]` |
| PUT | /projects/:pid/limits | platform-projects | bounded update |
| GET | /projects/:pid/integrations | platform-projects | `IntegrationsStatus` |
| GET | /projects/:pid/gsc/connect | platform-projects | 302 to Google consent (webmasters.readonly, offline) |
| GET | /gsc/callback | platform-projects | 302 back to integrations page |
| GET | /projects/:pid/gsc/properties | platform-projects | `{siteUrl, permissionLevel}[]` |
| PUT | /projects/:pid/gsc/property | platform-projects | body `{property}`; also verifies ownership via GSC |
| DELETE | /projects/:pid/gsc | platform-projects | revoke + delete token |
| GET | /projects/:pid/seo/overview | seo-analysis | `SeoOverview` |
| POST | /projects/:pid/seo/import-csv | seo-analysis | body `{csv, window:'current'|'previous', start, end}`; labelled `csv_import` |
| GET | /projects/:pid/seo/audit | seo-crawl | `SeoAudit` |
| GET | /projects/:pid/seo/robots-suggestion?allowTraining=true|false | robots-advisor | `RobotsSuggestion` (fetches live robots.txt of the verified host through the SSRF guard; rate-limited) |
| GET | /projects/:pid/seo/page-audit | coverage | `CoverageResponse<PageAuditRow>` |
| GET | /projects/:pid/seo/content-evidence | coverage | `CoverageResponse<ContentEvidenceRow>` |
| GET | /projects/:pid/geo/answer-coverage | coverage | `CoverageResponse<AnswerCoverageRow>` |
| GET | /projects/:pid/geo/citation-evidence | coverage | `CoverageResponse<CitationEvidenceRow>` |
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
| GET | /projects/:pid/geo/prompts | geo-analysis | `GeoPromptSet` (active) |
| PUT | /projects/:pid/geo/prompts | geo-analysis | body `{prompts:[{text,promptType,stage,approved}]}`; new version |
| POST | /projects/:pid/geo/prompts/generate | geo-analysis | writer-generated brand-blind suggestions (unapproved) |
| GET | /projects/:pid/geo/results | geo-analysis | `GeoResults` |
| GET | /geo/observations/:id | geo-analysis | `GeoObservationDetail` |
| GET | /projects/:pid/geo/displacements | geo-analysis | `DisplacementSummary[]` |
| GET | /projects/:pid/geo/search-queries | geo-analysis | `SearchQuerySummary[]` |
| POST | /projects/:pid/geo/import | geo-analysis | body `{promptText, surface, answer, citations[]}` manual import |
| GET | /projects/:pid/checklists/:kind | checklists | `Checklist` for kind `seo` or `geo` [A21] |
| GET | /projects/:pid/pages/:pageId/checklist | checklists | `Checklist` kind `page` (on-page checklist for one URL) [A21] |
| PUT | /projects/:pid/pages/:pageId/checklist/:itemId | checklists | body `{checked, note?}` for manual items on that page |
| PUT | /projects/:pid/checklists/:kind/:itemId | checklists | body `{checked, note?}` for manual items; returns `ChecklistItem` |
| POST | /demo/seed | platform-projects | DEMO_MODE only, never production: creates a labelled demo project with fixture data |
