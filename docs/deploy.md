# Deploying to Cloudflare

The app is one Cloudflare Worker: the React SPA is served as static assets, `/api/*` runs the Hono API, a cron
trigger dispatches daily agent runs, and each run executes as a Cloudflare Workflow. Data lives in one D1 database.
`npx wrangler deploy --dry-run --config dist/okara/wrangler.json` passes (upload ≈ 530 KiB gzipped).

## Which plan

Checked against Cloudflare's docs on 2026-09-30 (workers/platform/limits, workflows/reference/limits,
changelog 2026-02-11 subrequests, changelog 2026-09-01 D1 free-tier enforcement):

| Limit | Workers Free | Workers Paid |
|---|---|---|
| CPU per HTTP request / cron trigger | 10 ms | 30 s default, up to 5 min |
| CPU per Workflow step | 10 ms | 30 s default, up to 5 min |
| External subrequests per invocation | 50 | 10,000 default (configurable) |
| D1 daily row reads/writes | Enforced since 2026-09-01; queries fail over the limit until midnight UTC | Usage-based |
| Workflow instance retention | 3 days | 30 days |

**Decision: Workers Paid ($5/month).** `wrangler.jsonc` sets `limits` (60 s CPU per invocation/step, 50,000 subrequests), which only works on the paid plan, so upgrade before the first deploy. Crawling and parsing pages, Search Console pagination, and provider calls
need more than 10 ms of CPU per step, so agent runs will fail on the free plan. Run history is stored in D1, not only in Workflow state.

## Steps

0. **Upgrade the Cloudflare account to Workers Paid** (dashboard → Workers & Pages → Plans).

1. **Cloudflare**
   ```sh
   npx wrangler login
   npx wrangler d1 create okara          # copy the database_id into wrangler.jsonc
   ```
   Set `APP_ORIGIN` in `wrangler.jsonc` to your final https origin, with no path or trailing slash
   (for example `https://app.example.com`). Until it is edited, the placeholder is treated as unset and sign-in
   shows "setup required". Every sign-in, CSRF check and OAuth redirect is bound to this one origin: on any other
   host that serves the Worker (`*.workers.dev`, preview URLs) sign-in fails with `state_mismatch` and every write
   returns 403 `csrf_failed`.

   **Custom domain (recommended).** The zone must be active on Cloudflare in your account, and the hostname must
   not already have a CNAME record. Uncomment the example in `wrangler.jsonc` and put your host in it:
   ```jsonc
   "routes": [{ "pattern": "app.example.com", "custom_domain": true }],
   "workers_dev": false,
   "preview_urls": false,
   ```
   `npm run deploy` then creates the DNS record and certificate for the custom domain. `workers_dev: false` and
   `preview_urls: false` turn off the `*.workers.dev` host and the version/preview URLs, so users cannot reach
   the app on a host where sign-in and writes fail.
   ([Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/),
   [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/).)
   Without a custom domain, set `APP_ORIGIN` to `https://okara.<your-subdomain>.workers.dev` and leave
   `workers_dev` on.

2. **Google Cloud** (sign-in + Search Console). Start this first: verification can take weeks.
   - Enable the **Google Search Console API**.
   - Create an **OAuth client** (type: Web application). Authorized redirect URIs are exactly `APP_ORIGIN`
     followed by the path, with no extra scheme or trailing slash:
     - `<APP_ORIGIN>/api/auth/callback` (sign-in), e.g. `https://app.example.com/api/auth/callback`
     - `<APP_ORIGIN>/api/gsc/callback` (Search Console), e.g. `https://app.example.com/api/gsc/callback`
     - For local development, add `http://localhost:5173/api/auth/callback` and
       `http://localhost:5173/api/gsc/callback` (the `APP_ORIGIN` in `.dev.vars.example`), or use a separate
       client for development.
   - **Consent screen** (Google Auth Platform → Branding, Audience, Data access). Scopes: `openid`, `email`,
     `profile`, and `https://www.googleapis.com/auth/webmasters.readonly`.
     - **User type.** Choose *Internal* if every user belongs to your Google Workspace organization. This avoids
       test-user limits and app verification, but only accounts in that organization can sign in. Otherwise
       choose *External*.
     - **Publishing status.** A new External app starts in *Testing*. In Testing, only listed **test users**
       (up to 100) can sign in, and because the app requests a scope beyond `openid email profile`,
       Google issues **refresh tokens that expire after 7 days**. From about day 8, every Search Console sync
       fails with `invalid_grant` and users must reconnect each week. Before real use, go to Audience and
       click **Publish app** so the status is *In production*.
     - **Verification.** `webmasters.readonly` is listed as a sensitive scope on the Data access page. Until
       Google verifies the app, users see the "Google hasn't verified this app" warning and the app is limited
       to 100 users. Submit it for verification (privacy policy URL, authorized domain, and a scope
       justification) as soon as the production domain exists, and allow weeks of lead time.
     - For a closed beta you can stay in Testing: add each user's Google account as a test user, and expect
       them to reconnect Search Console every 7 days.
     ([OAuth 2.0 refresh token expiration](https://developers.google.com/identity/protocols/oauth2#expiration),
     [Manage app audience](https://support.google.com/cloud/answer/15549945).)

3. **Secrets and vars**
   Secrets are never committed; set each with `npx wrangler secret put <NAME>`:
   - Required: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY_V1`
     (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`). Add
     `TOKEN_ENCRYPTION_KEY_V2` later to rotate.
   - Optional operator keys (workspaces can instead add their own in the app): `TYPESAFE_API_KEY`,
     `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`, `OPENAI_GEO_API_KEY`, `ANTHROPIC_GEO_API_KEY`, `WRITER_API_KEY`.
     The two `*_GEO_API_KEY` keys are separate from `WRITER_API_KEY` even when the writer uses the same vendor.
     Workspace-saved keys for the OpenAI/Anthropic GEO lanes need the migration that widens the
     `provider_credentials` CHECK constraint; until it is applied, saving one returns `setup_required` and only
     the operator key works. Spend on these keys is shared by every
     workspace and bounded by the `GLOBAL_*` caps below. Review those caps before setting these keys.

   Plain vars live in `wrangler.jsonc` → `vars` (not secrets; a name cannot be both a var and a secret):

   | Var | Meaning |
   |---|---|
   | `APP_ORIGIN` | The one https origin users reach (step 1) |
   | `GEMINI_MODEL`, `PERPLEXITY_MODEL` | Exact model ids (e.g. `perplexity/sonar`); no defaults. Operator defaults only: a workspace owner can choose its own model on the Integrations page (workspace selection wins; migration 0011). On the operator's key a workspace may only pick models with a verified price in `src/worker/providers/rates.ts` (or the model set here); any model with its own key |
   | `OPENAI_GEO_MODEL` | Exact OpenAI model id for the OpenAI web_search lane (a model the web search guide supports, e.g. `gpt-5.5`, `gpt-4.1`); no default. Unset: the lane is `setup_required`. Cost estimates exist for the ids in `src/worker/providers/rates.ts`; any other id records cost as unknown |
   | `ANTHROPIC_GEO_MODEL` | Exact Claude model id for the Anthropic web_search lane (e.g. `claude-sonnet-5-5`); no default. Web search must be enabled for the organization in the Claude Console, otherwise every call fails with HTTP 400 |
   | `TYPESAFE_MODEL` | Jev model alias, default `jev-latest`. Always used with the operator's TypeSafe key; a workspace's own model choice applies only with its own TypeSafe key |
   | `WRITER_PROVIDER`, `WRITER_MODEL` | `anthropic` or `openai_compatible`, plus an exact model id |
   | `WRITER_BASE_URL` | Required for `openai_compatible` (https only), e.g. `https://api.openai.com/v1` |
   | `WRITER_REASONING_EFFORT` | Optional, `openai_compatible` reasoning models only: `none`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`, sent as `reasoning_effort`. Unset: not sent. Any other value makes the writer `setup_required` with the value named. |
   | `WRITER_REASONING_HEADROOM_TOKENS` | Optional, `openai_compatible` only: extra `max_completion_tokens` added to each answer budget for reasoning tokens, and reserved in `writer_tokens`. Default 0 when `WRITER_REASONING_EFFORT` is unset, 4000 when it is set. Whole number 0-100000. |
   | `GEMINI_THINKING_LEVEL` | Optional override for Gemini `thinkingLevel`: `MINIMAL`, `LOW`, `MEDIUM`, `HIGH` (sent for any model id) or `OFF` (never sent). Unset: `LOW` for Gemini 3+ ids and the `gemini-flash-latest` / `gemini-pro-latest` aliases, nothing for older models (where the parameter is an API error). Unrecognised values fall back to the default. |
   | `ALLOWED_EMAILS`, `ALLOWED_EMAIL_DOMAINS` | Sign-in allowlist, comma-separated, case-insensitive, verified Google emails only. **In production nobody can sign in until at least one is set** (`?authError=signup_closed`); other emails get `not_allowed`. Example: `ALLOWED_EMAIL_DOMAINS=example.com` |
   | `GLOBAL_USD_MICROS_PER_DAY` | Priced GEO spend per UTC day across all projects on the operator Gemini/Perplexity/OpenAI-GEO/Anthropic-GEO keys (default 2,000,000 = $2.00) |
   | `GLOBAL_JEV_CALLS_PER_DAY` | Jev calls per UTC day across all projects on the operator TypeSafe key (default 2,000) |
   | `GLOBAL_PROVIDER_CALLS_PER_DAY` | Provider calls per UTC day across all projects on any operator key (default 3,000) |
   | `GLOBAL_WRITER_TOKENS_PER_DAY` | Writer tokens per UTC day across all projects on the operator writer key (default 1,000,000) |

   The `GLOBAL_*` values in `wrangler.jsonc` are the code defaults (`src/worker/runs/budget.ts`: 2000000,
   2000, 3000 and 1000000); set them from your real budget. An empty value also means the default. Workspaces using their own keys are bounded only by their project limits
   (`docs/limits-and-costs.md`).

   **Upgrading an existing deployment (Gemini cohorts reset once).** This release sends Gemini
   `maxOutputTokens` 8192 (was 4096) and, for Gemini 3+ models, `thinkingLevel` `LOW`. Both are part of the GEO
   cohort key, so the first run after the upgrade starts a new observation series for Gemini, and trends
   restart from that run. Earlier observations stay stored under the old cohort. Changing
   `GEMINI_THINKING_LEVEL` later starts another cohort in the same way. Perplexity cohorts are unchanged.

   **Removing a project or disconnecting Search Console** deletes the locally stored Google token only. The
   app does not call Google's revoke endpoint, because that would end the grant for every project connected
   with the same Google account. To revoke access at Google, remove the app at myaccount.google.com.

4. **Database**
   ```sh
   npm run db:migrate:remote
   ```
   Migration `0010_workspace_custom_providers.sql` adds workspace custom (OpenAI-compatible) writer providers.
   Until it is applied, the custom provider routes return `setup_required` and every workspace keeps the
   default writer. Migration `0011_workspace_models_custom_geo.sql` adds per-workspace model selection
   (`workspace_provider_models`) and the `role` column for custom GEO engines; until it is applied, models come
   from the env vars only, saving a model or adding a custom GEO engine returns `setup_required`, and custom
   writers keep working.

5. **Deploy**
   ```sh
   npm run deploy
   ```

6. **First use**
   Sign in, create a project, verify ownership (connect Search Console and pick the property, or DNS/file),
   approve GEO prompts, add provider keys, then use "Run now" on Overview or wait for the daily cron.
   Do the first run supervised, with the checklist below.

## First live run checklist

These checks need live credentials and real infrastructure; tests cannot cover them. Do them on the first
supervised run, with a small crawl (50 pages or fewer) and the sign-in allowlist set.

1. **D1 limits in practice.** Find out whether the 1,000 queries per invocation or the configured
   `subrequests` cap is the one enforced. Run a 200-page crawl, including a site whose URLs redirect, and watch
   for "Too many subrequests".
2. **Workflow retries and timeouts.** Confirm step retry and timeout behaviour, and whether a timed-out attempt
   is actually torn down or keeps running beside its retry. After any retry, check `usage_reservations` and
   `crawl_runs` for rows left behind.
3. **Google sign-in in production.** Verify that the `__Host-` session and state cookies work (tests run with
   `ENVIRONMENT=test` and never use those names), that the registered redirect URIs match exactly, and that
   CSRF passes on the real origin. Confirm the `*.workers.dev` and preview hosts are off if you use a custom domain.
4. **Google OAuth publishing status.** Confirm the consent screen is *In production* and that a Search Console
   refresh token still works after 7 days. Check what the unverified-app screen looks like to users.
5. **Search Console.** Test property listing, a sync with `dataState: final`, and paging against a real
   property, including an `sc-domain:` property.
6. **Gemini.** With the chosen `GEMINI_MODEL`, check the `finishReason` distribution (how often `MAX_TOKENS`
   appears), latency against the 30 s timeout, and the thinking-token count in `usageMetadata`.
7. **Perplexity.** Check that `usage.cost` and `tool_calls_details.search_web` parse from a live response and
   that the recorded cost matches the invoice.
7a. **OpenAI and Anthropic GEO lanes.** With the chosen `OPENAI_GEO_MODEL`, confirm a live response has
   `web_search_call` items with `action.queries` and `url_citation` annotations, and how often the model answers
   without searching (`tool_choice: "auto"`; those answers are stored ungrounded). With `ANTHROPIC_GEO_MODEL`,
   confirm `usage.server_tool_use.web_search_requests`, `web_search_result_location` citations, and how often
   `pause_turn` appears. Compare the estimated costs (both lanes are estimates) with the invoices.
8. **Jev (TypeSafe SDK) and the Anthropic writer in workerd.** Confirm the TypeSafe SDK constructs and calls
   work in workerd, that the Anthropic SDK's lazily imported `node:` chunks load at runtime, and that
   structured-output (`json_schema`) responses from the real writer parse.
9. **Budget accounting.** After one full scheduled SEO and GEO run, confirm that reservations settle or
   release, and that the `GLOBAL_*` caps compare sensibly with real spend.
10. **Cron.** Confirm the `*/15` trigger fires, dispatch is idempotent, and the pending-run sweep runs at the
    UTC day boundary.
11. **Migrations on real D1.** Confirm `PRAGMA foreign_keys = ON` in 0001 is accepted and that cascades behave
    as expected.
12. **Domain verification.** Test the DoH and well-known-file checks against a real domain.
13. **Redeploy.** With a tab open, redeploy, then navigate in that tab. The app should reload once onto the new
    version (or show "A new version is available" with a Reload button) instead of an error page. Confirm
    `_headers` and the CSP are served on the production host.

## Local development

```sh
cp .dev.vars.example .dev.vars   # ENVIRONMENT=development, DEMO_MODE=true
npm run db:migrate:local
npm run dev
```
