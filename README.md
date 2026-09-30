# okara

A two-agent SEO and GEO SaaS, built from the specification in [`docs/build-kit.md`](docs/build-kit.md).

- **SEO agent.** Connects Google Search Console, crawls a verified site, and proposes 0–2 evidence-backed
  recommendations a day (page, template, or site scope).
- **GEO agent.** Runs a stable, user-approved set of brand-blind buyer prompts against web-grounded AI APIs
  (Gemini with Google Search grounding, Perplexity). It records mentions, citations, sentiment, "cited instead"
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

Secrets are set with `wrangler secret put <NAME>`. Workspaces can also bring their own provider keys in the app;
those are stored encrypted server-side and never returned to the browser.

| Name | Needed for |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Sign-in (OIDC) and the Search Console connection |
| `TOKEN_ENCRYPTION_KEY_V1` | AES-GCM encryption of refresh tokens and provider keys (32 bytes, base64). Add `_V2` to rotate. |
| `TYPESAFE_API_KEY`, `TYPESAFE_MODEL` | Jev decisions (default alias `jev-latest`) |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | GEO provider: Gemini with Google Search grounding |
| `PERPLEXITY_API_KEY`, `PERPLEXITY_MODEL` | GEO provider: Perplexity |
| `WRITER_PROVIDER`, `WRITER_MODEL`, `WRITER_API_KEY`, `WRITER_BASE_URL` | Recommendation drafting |
| `GLOBAL_USD_MICROS_PER_DAY` | Global daily spend cap across projects |

Model IDs always come from configuration. None are hard-coded.

## Documentation

- [`docs/build-kit.md`](docs/build-kit.md): the specification (authoritative)
- [`docs/api.md`](docs/api.md): API contract; response types in [`src/shared/types.ts`](src/shared/types.ts)
- [`docs/architecture.md`](docs/architecture.md), [`docs/provider-contracts.md`](docs/provider-contracts.md),
  [`docs/limits-and-costs.md`](docs/limits-and-costs.md)
- [`eval/README.md`](eval/README.md): labelled evaluation set and benchmark harness

## What the metrics mean

GEO numbers are **API-sampled visibility**: answers from provider APIs, not from consumer apps (ChatGPT, the Gemini
app, the Perplexity app) or Google AI Overviews. Failed and ungrounded responses are excluded from the relevant
denominators, and trends only compare runs with the same prompt set, model, and grounding configuration.
