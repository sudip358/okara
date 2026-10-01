# okara

A two-agent SEO and GEO SaaS, built from the specification in [`docs/build-kit.md`](docs/build-kit.md).

- **SEO agent.** Connects Google Search Console, crawls a verified site, and proposes 0–2 evidence-backed
  recommendations a day (page, template, or site scope).
- **GEO agent.** Runs a stable, user-approved set of brand-blind buyer prompts against web-grounded AI APIs
  (Gemini with Google Search grounding, Perplexity, OpenAI and Anthropic with web search). It records mentions, citations, sentiment, "cited instead"
  displacements, and the search queries engines issued, and proposes 0–2 improvements a day.

Every recommendation cites stored evidence. Metrics show numerators, denominators, windows, and sources.
Missing credentials produce a "setup required" state, never synthetic output. Nothing is published automatically.

## Stack

TypeScript throughout. React + Vite SPA, Tailwind CSS, Hono API on Cloudflare Workers, D1, Cloudflare Workflows
for resumable agent runs, a cron dispatcher, Zod, and Vitest. The decision model is TypeSafe Jev
(`@typesafe-ai/sdk`). The writer is configurable (Anthropic Messages API or any OpenAI-compatible endpoint).

## Getting started

```sh
npm ci
cp .dev.vars.example .dev.vars   # fill in what you have; everything else shows "setup required"
npm run db:migrate:local
npm run dev
```

With `DEMO_MODE=true` and `ENVIRONMENT=development`, the Projects page offers **Load demo project**, a clearly
labelled fixture project that exercises every screen. Demo mode cannot be enabled in production.

| Command | What it does |
|---|---|
| `npm test` | Unit and integration tests (Node, D1 shim over `node:sqlite`) |
| `npm run typecheck` | Worker and web TypeScript projects |
| `npm run build` | SPA assets + Worker bundle |
| `npm run deploy` | Build and `wrangler deploy` (requires your Cloudflare account; not run automatically) |

## Configuration

**Secrets** are set with `wrangler secret put <NAME>` (locally, in `.dev.vars`). **Vars** are plain values in
`wrangler.jsonc` → `vars`. A name cannot be both. Workspaces can also bring their own provider keys in the app;
those are stored encrypted server-side and never returned to the browser. Full list and deploy steps:
[`docs/deploy.md`](docs/deploy.md).

| Name | Kind | Needed for |
|---|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | secret | Sign-in (OIDC) and the Search Console connection |
| `TOKEN_ENCRYPTION_KEY_V1` | secret | AES-GCM encryption of refresh tokens and provider keys (32 bytes, base64). Add `_V2` to rotate. |
| `TYPESAFE_API_KEY`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`, `OPENAI_GEO_API_KEY`, `ANTHROPIC_GEO_API_KEY`, `WRITER_API_KEY` | secret (optional) | Operator provider keys shared by all workspaces (the GEO keys are separate from the writer key) |
| `APP_ORIGIN` | var | The one https origin users reach; sign-in, CSRF and OAuth redirects are bound to it |
| `TYPESAFE_MODEL` | var | Jev decisions (default alias `jev-latest`) |
| `GEMINI_MODEL`, `PERPLEXITY_MODEL`, `OPENAI_GEO_MODEL`, `ANTHROPIC_GEO_MODEL` | var | GEO providers: Gemini with Google Search grounding, Perplexity, OpenAI Responses `web_search`, Anthropic `web_search_20250305` |
| `WRITER_PROVIDER`, `WRITER_MODEL`, `WRITER_BASE_URL`, `WRITER_REASONING_EFFORT`, `WRITER_REASONING_HEADROOM_TOKENS` | var | Recommendation drafting (`WRITER_BASE_URL` and the reasoning settings for `openai_compatible` only) |
| `GEMINI_THINKING_LEVEL` | var (optional) | Override Gemini `thinkingLevel` (`MINIMAL`/`LOW`/`MEDIUM`/`HIGH`/`OFF`); default `LOW` for Gemini 3+ only |
| `ALLOWED_EMAILS`, `ALLOWED_EMAIL_DOMAINS` | var | Sign-in allowlist. In production nobody can sign in until one is set (`?authError=signup_closed`); other emails get `not_allowed`. |
| `GLOBAL_USD_MICROS_PER_DAY`, `GLOBAL_JEV_CALLS_PER_DAY`, `GLOBAL_PROVIDER_CALLS_PER_DAY`, `GLOBAL_WRITER_TOKENS_PER_DAY` | var | Daily caps across all projects on the operator keys (defaults 2000000 / 2000 / 3000 / 1000000) |

Model IDs always come from configuration. None are hard-coded.

## Documentation

- [`docs/build-kit.md`](docs/build-kit.md): the specification (authoritative)
- [`docs/api.md`](docs/api.md): API contract; response types in [`src/shared/types.ts`](src/shared/types.ts)
- [`docs/architecture.md`](docs/architecture.md), [`docs/provider-contracts.md`](docs/provider-contracts.md),
  [`docs/limits-and-costs.md`](docs/limits-and-costs.md)
- [`docs/deploy.md`](docs/deploy.md): Cloudflare deployment steps and which plan you need
- [`eval/README.md`](eval/README.md): labelled evaluation set and benchmark harness
- [`resource.md`](resource.md): every external reference used, what was taken from it, and where it landed

## What the metrics mean

GEO numbers are **API-sampled visibility**: answers from provider APIs, not from consumer apps (ChatGPT, the Claude app, the Gemini
app, the Perplexity app) or Google AI Overviews. Failed and ungrounded responses are excluded from the relevant
denominators, and trends only compare runs with the same prompt set, model, and grounding configuration.
