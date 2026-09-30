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

**Decision: Workers Paid ($5/month).** `wrangler.jsonc` sets `limits` (60 s CPU per invocation/step, 2,000 subrequests), which only works on the paid plan, so upgrade before the first deploy. Crawling and parsing pages, Search Console pagination, and provider calls
need more than 10 ms of CPU per step, so agent runs will fail on the free plan. Run history is stored in D1, not only in Workflow state.

## Steps

0. **Upgrade the Cloudflare account to Workers Paid** (dashboard → Workers & Pages → Plans).

1. **Cloudflare**
   ```sh
   npx wrangler login
   npx wrangler d1 create okara          # copy the database_id into wrangler.jsonc
   ```
   Set `APP_ORIGIN` in `wrangler.jsonc` to your final https origin (custom domain or `*.workers.dev`).

2. **Google Cloud** (sign-in + Search Console)
   - Create an OAuth client (Web application). Authorized redirect URIs:
     `https://<APP_ORIGIN>/api/auth/callback` and `https://<APP_ORIGIN>/api/gsc/callback`.
   - Enable the Google Search Console API. Configure the OAuth consent screen (scopes: `openid email profile`,
     and `https://www.googleapis.com/auth/webmasters.readonly`).

3. **Secrets** (never commit them; set each with `npx wrangler secret put <NAME>`)
   - Required: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY_V1`
     (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`)
   - Optional operator keys (workspaces can instead add their own in the app): `TYPESAFE_API_KEY`,
     `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`, `WRITER_API_KEY`.
   - Model ids are plain vars in `wrangler.jsonc`: `GEMINI_MODEL`, `PERPLEXITY_MODEL` (e.g. `perplexity/sonar`),
     `WRITER_PROVIDER` + `WRITER_MODEL`; `TYPESAFE_MODEL` defaults to `jev-latest`.

4. **Database**
   ```sh
   npm run db:migrate:remote
   ```

5. **Deploy**
   ```sh
   npm run deploy
   ```

6. **First use**
   Sign in, create a project, verify ownership (connect Search Console and pick the property, or DNS/file),
   approve GEO prompts, add provider keys, then use "Run now" on Overview or wait for the daily cron.

## Local development

```sh
cp .dev.vars.example .dev.vars   # ENVIRONMENT=development, DEMO_MODE=true
npm run db:migrate:local
npm run dev
```
