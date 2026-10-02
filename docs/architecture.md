# Architecture

Two-agent SEO/GEO SaaS on Cloudflare: one Worker serves the React SPA (static assets) and the Hono API
under `/api/*`, a cron trigger dispatches daily agent runs, and a Cloudflare Workflow executes each run as
small resumable steps. All history lives in D1 (Workflow state is only a cache of step results).

Specification: `docs/build-kit.md`. API contract: `docs/api.md` + `src/shared/types.ts`. Schema:
`migrations/0001_init.sql`. Provider contracts: `docs/provider-contracts.md`. Limits and costs:
`docs/limits-and-costs.md`.

## Components

| Component | Files | Responsibility |
|---|---|---|
| API app | `src/worker/app.ts`, `src/worker/routes/*` | Hono routes; sessions, CSRF, tenancy (`requireProject`) |
| Platform | `src/worker/platform/*` | Google OIDC, sessions, encrypted BYO keys, projects, verification, GSC OAuth + client |
| Runtime | `src/worker/runs/*`, `src/worker/providers/{typesafe,writer*}.ts`, `src/worker/writing/*` | Run context, budgets, locks, orchestration, scheduler, Workflow, Jev + writer adapters, output validator |
| SEO agent | `src/worker/seo/*` | Crawl (SSRF-guarded), rule registry, GSC sync, candidate shortlist, Jev decisions, priority, writer drafts |
| GEO agent | `src/worker/geo/*`, `src/worker/providers/{gemini,perplexity,rates}.ts` | Grounded prompt sampling, mention/citation/sentiment analysis, displacement, search-query capture, proposals |
| Recommendations | `src/worker/recommendations/*` | Evidence rows, dedup, 0-2/day cap, persistence shared by both agents |
| Ask Okara | `src/worker/chat/*`, `src/worker/routes/chat.ts`, `src/web/components/chat/*` | In-app chat agent: tool-calling writer model over internal read tools; confirmed actions only |
| Web | `src/web/*` | SPA; renders untrusted text as plain text |

## Run pipeline

```
cron (*/15) ──► dispatchDueRuns ──► agent_runs (idempotency_key = project:agent:YYYY-MM-DD, INSERT OR IGNORE)
                                    │ claim (workflow_instance_id IS NULL) + run_locks (project, agent, expiry)
                                    ▼
POST /projects/:pid/runs ──► same claim + lock (manual; 3/day/project, atomic conditional INSERT)
                                    ▼
             AGENT_RUN.create({id: runId, params: {runId}})   (inline executeRun when the binding is absent)
                                    ▼
AgentRunWorkflow: step.do("prepare") → step.do(<each step>) → step.do("finalize")
                                    ▼
orchestrate.ts: prepareRun / executeStep / finalizeRun  (pure TS, tested in Node)
```

Steps (names are stored on `run_events.step`, which gives the UI its `[SEO]`/`[GEO]` prefix):

| Agent | Steps |
|---|---|
| SEO | `seo.validate` → `seo.crawl` (runCrawl) → `seo.gsc_sync` (syncGsc) → `seo.recommend` (generateSeoRecommendations) → `seo.summary` |
| GEO | `geo.validate` → `geo.batch` (runGeoBatch, analyzeObservation per answer) → `geo.proposals` (generateGeoProposals) → `geo.summary` |

Step semantics:

- Every step logs `started` and one of `completed | partial | failed | skipped` to `run_events`, and stores its
  compact summary under `agent_runs.summary_json.steps[<step>]`. Workflow step results carry only ids and
  short strings; full summaries stay in D1.
- **Partial completion**: a failing step never erases earlier results and later steps still run (the
  recommendation step decides what it can do with the data that exists). Only a failed `validate` is fatal.
- **Setup required**: a step whose summary is `status: 'setup_required'` or that throws
  `SetupRequiredError` is `skipped` with the reason. If every work step is skipped for setup, the run ends
  `setup_required`. Nothing is simulated.
- **Budget**: `BudgetExceededError` fails the step with reason `budget`; if every work step failed on
  budget the run ends `rate_limited`.
- **Cancellation**: `POST /runs/:id/cancel` sets `cancel_requested`. It is checked before every step (and
  steps may poll `ctx.isCancelled()`); remaining steps are skipped and the run ends `cancelled`. A run that
  has not started is cancelled immediately.
- Final status: `completed` (no failures), `partial` (some failures, some success), `failed`, `cancelled`,
  `setup_required`, or `rate_limited`. The lock is released in `finally`, including on failure.
- Workflow retries (`limit 2, delay 10 s, exponential`) apply to infrastructure failures only:
  `executeStep` catches step errors so a step's external calls are not silently repeated. Step timeouts:
  validate 1 min, crawl/gsc/recommend/proposals 10 min, batch 15 min.

## Run context

`buildRunContext(env, runId)` (`runs/runtime.ts`) assembles what every step receives:

- `decisions`: TypeSafe (Jev) via the official SDK when a key exists (model `TYPESAFE_MODEL` or the
  `jev-latest` alias), else `null` (semantic ranking shown as unavailable).
- `writer`: Anthropic Messages or an OpenAI-compatible endpoint when `WRITER_PROVIDER`, `WRITER_MODEL`
  (and `WRITER_BASE_URL` for openai_compatible) and a key exist, else `null` (setup required). There is no
  default model id. When the workspace selected one of its custom OpenAI-compatible providers
  (`platform/custom-providers.ts`, table `workspace_custom_providers`), that provider's base URL, model and
  key are used instead; if it cannot be used, `writer` is `null` (no fallback to the default writer).
- `geoProviders`: Gemini and/or Perplexity, only when a key and a configured model id exist.
- `gsc`: Search Console client when the project has a connected OAuth token.
- `budget` (atomic reservations), `calls` (provider_calls recorder), `log` (run_events), `isCancelled`.
- `apiFetch`: allowlisted fetch for provider APIs (`api.typesafe.ai`, `generativelanguage.googleapis.com`,
  `api.perplexity.ai`, `api.anthropic.com`, `oauth2.googleapis.com`, `www.googleapis.com`,
  `searchconsole.googleapis.com`, the configured `WRITER_BASE_URL` host, and, for this workspace only, the
  host of its selected custom writer); https only, default port, no
  URL credentials, `redirect: "manual"`. Anything else (including crawl targets) is refused with
  `OutboundBlockedError`. DNS-over-HTTPS ownership checks run in the verification route with its own fetch,
  never inside a run.
- `crawlFetch`: the platform fetch (wrapped so it is never invoked with a foreign `this`, which workerd
  rejects); the crawler wraps it in its SSRF guard (`seo/ssrf.ts`).

Credentials resolve per workspace (encrypted BYO key first, then operator key) and are decrypted only
inside the run; a key that cannot be decrypted is treated as not configured and logged.

## Decisions, writing, validation

Code shortlists candidates and computes priority; Jev answers narrow typed questions (one `systemOne`
call per state; Noul has no confidence and is tiered by probability bands in `runs/policy.ts`); the writer
drafts only from supplied evidence using the prompts in `writing/prompts.ts` and the `recommendation.v1`
schema in `writing/schemas.ts`; `writing/validate.ts` rejects drafts that cite unknown evidence ids,
reference rule ids (`SEO-…`, `ECOM-…`, `AI-…`) or decision ids (`dec_…`) the writer was never given [A17],
contain numbers, dates, certification/spec terms not present in the cited evidence, or guarantee/ranking
promises, and extracts `[confirm: ...]` placeholders.

Recommendation cards show `decision.fields` with real TypeSafe field names only (`choice`, `confidence`,
`score`, `noul`), qualified by question id (for example `seo.action_choice.confidence`,
`geo.proposal_fit.score`); a Noul answer never carries a confidence. Derived values such as the runner-up
are computed in the UI from the stored raw answer in the decision log.

## Scheduling

Daily cadence per project and agent. The cron runs every 15 minutes so that a dispatch blocked by an active
run lock is retried the same day; the date-based idempotency key makes a second run for the same day
impossible. A Workflow instance that fails to start marks that day's run `failed` (with the error) and is
not retried until the next day. At most 25 runs are started per tick. Demo projects and projects
with `schedule_enabled = 0` are never scheduled. Each tick also marks stale work as failed: pending
scheduled runs from earlier days that never started, runs dispatched to a Workflow instance that never
started, and `running` runs whose lock expired (2 x TTL, no live lock).

Manual runs (`POST /projects/:pid/runs`) are limited to 3 per project per UTC day with one conditional
`INSERT … SELECT … WHERE (count of today's manual runs) < 3`, so concurrent requests cannot exceed the
quota (HTTP 429 `quota_exceeded`); demo projects return 409 `demo_project`; a repeat within the same minute
for the same agent returns the existing run; a run refused because another run holds the lock is removed so
it does not consume quota (409).

## Ask Okara (chat agent)

```
POST /projects/:pid/chat/sessions/:sid/messages (CSRF, rate limit) ──► prepareSend: session lease (conditional UPDATE),
     expire a waiting action, store user + assistant messages ──► runAgentLoop (chat/loop.ts)
        model.round()  ── metered: provider_calls + writer_tokens reserved, settled, provider_calls row (chat.turn)
        tool calls ──► read/output tool: run now (zod-validated, tenancy-scoped, result capped) ──► next round
                   └─► action tool: prepare() + chat_actions 'pending' ──► pause (transcript saved on the session)
POST .../actions/:aid/confirm ──► lease + pending→executing (exactly once) ──► execute() ──► resume the loop
```

- Model: `chat/model.ts` resolves the workspace writer (custom OpenAI-compatible writer, else `WRITER_PROVIDER`
  anthropic / openai_compatible with `WRITER_MODEL` and a key); adapters `chat/model-anthropic.ts` (SDK, client
  tools) and `chat/model-openai.ts` (function tools). Same allowlisted `apiFetch` and metering as the writer.
- Transcript: earlier turns as text pairs only; the current turn append-only (provider-native assistant
  content replayed verbatim, thinking blocks included), so nothing replayed was produced against a different
  prefix. A paused turn keeps its transcript in `chat_sessions.pending_json` until confirm/cancel.
- Tools (`chat/tools.ts`) call the same service functions as the routes (`buildSeoOverview`, `buildGeoResults`,
  `getProjectChecklist`, `getLinkReport`, `runDraftCheck`, `requestManualRun`, `setRecommendationStatus`,
  `approveCompetitorPage`, ...) with the route's `ProjectRow`; nothing goes over HTTP.
- Safety: the confirmation gate lives in `chat/service.ts` (not the prompt); the system prompt (`chat/prompt.ts`)
  marks tool data as untrusted; the UI renders answers as markdown-lite text with in-app or http(s) links only.
- Streaming: `?stream=1` returns ndjson events through a `TransformStream`; the turn keeps running (and is
  stored) if the client disconnects (`waitUntil`).

## Deviations and known limitations

- **HTML parsing**: the crawler uses `htmlparser2` (streaming tokenizer) instead of `HTMLRewriter` so the
  same extraction code runs on Workers and in Node tests (see `seo/crawl/extract.ts`).
- **DNS rebinding**: Workers do not expose DNS resolution, so resolve-then-pin is impossible. The SSRF
  guard's primary control is the exact verified-host allowlist plus IP-literal range blocking, manual
  redirects re-validated per hop, streamed size caps, and timeouts (see `seo/ssrf.ts`).
- **Writer JSON mode** (deviation from the "forced single output tool" plan): Anthropic uses structured
  outputs (`output_config.format` json_schema) rather than a forced tool, because current models (Claude
  Opus 5.5, Sonnet 5.5, Fable 5.1) reject `tool_choice` `{type: "tool"}` / `{type: "any"}` with HTTP 400
  ("not supported for this model"). Structured outputs work on every current model, including Haiku 4.5,
  and is the documented path when a forced call only existed to extract JSON. No tools are sent to either
  writer, so the writer has no tool access.
- **Perplexity**: uses the Agent API (`/v1/agent`) because Sonar Chat Completions support ended on
  2026-09-27 (see `docs/provider-contracts.md`).
- **Gemini**: keeps `generateContent` + `groundingMetadata` although the grounding guide now shows the
  Interactions API (documented conflict).
- **Exactly-once billing** is not guaranteed: providers expose no idempotency keys. Every HTTP attempt is
  recorded and counted; outcomes of timeouts stay conservatively accounted.
- **Workflow step retries** (timeout, eviction, a thrown error): a step whose record is already saved in
  `agent_runs.summary_json.steps` is not run again (`executeStep` returns the saved record), and the
  bookkeeping after a step's work (saving the record, events, lock renewal) is best-effort so a transient
  D1 write error cannot trigger a retry. A step attempt that dies before saving its record is re-run from
  the top: `geo.batch` skips prompt x provider pairs already observed for the run (plus a unique index on
  `geo_observations(run_id, prompt_id, provider)`), recommendation saves re-check dedup and the 0-2/day
  cap right before each insert, but other writes (e.g. `crawl_runs`, `run_events` lines) are not
  deduplicated. Budget reservations stranded as 'reserved' by a killed attempt are released by the cron
  sweep after an hour once their run is no longer active (`runs/scheduler.ts` `sweepOrphans`).
