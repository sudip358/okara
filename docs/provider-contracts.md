# Provider contracts

Official documentation is the authority. Every entry lists the endpoint and fields this codebase relies on,
where it is implemented, and the doc URL. Contracts were checked on 2026-09-30; re-verify before changing an
adapter. Model ids are configuration only (`TYPESAFE_MODEL`, `GEMINI_MODEL`, `PERPLEXITY_MODEL`,
`WRITER_MODEL`); no adapter hardcodes a default model id except the documented `jev-latest` alias.

All provider traffic from runs goes through `ctx.apiFetch` (host allowlist, https, `redirect: "manual"`).
Every HTTP attempt, including retries and failures, is written to `provider_calls`.

## TypeSafe (Jev) — decisions

Implemented in `src/worker/providers/typesafe.ts` with the official SDK `@typesafe-ai/sdk` 0.6.0.

| Item | Contract |
|---|---|
| Docs | https://docs.typesafe.ai, https://docs.typesafe.ai/primitives, https://docs.typesafe.ai/confidence |
| Call | `new TypeSafeClient({ apiKey, defaultModel, fetch, timeout: 12000, retry: { maxRetries: 2 }, logLevel: "off" })`, `client.systemOne({ state, questions, model }).withResponse()` |
| HTTP | `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <key>`, body `{ model, state, questions: { <id>: { type, instructions, criteria } } }` |
| Response | `{ model, answers: { <id>: ... }, usage: { input_tokens, output_tokens } }`; request id header `x-typesafe-request-id` |
| Choice | `{ type: "choice", choice, confidence, probabilities }` |
| Score | `{ type: "score", score, confidence, probabilities, legend }` |
| Noul | `{ type: "noul", noul }` — the yes-probability. **No confidence field**; the adapter never adds one |
| Retries | SDK default statuses 408, 429, 5xx, connection errors and timeouts, max 2 retries with backoff + jitter |
| Credential test | `client.models.list()` → `GET /v1/models` (no inference) |
| Model | `TYPESAFE_MODEL` or the `jev-latest` alias; the resolved `model` returned by the API is recorded per call |

Malformed answers (wrong type, choice not among the criteria, non-finite numbers, noul outside 0..1) are
dropped (`undefined`) and never defaulted. Cost: no verified Jev per-call price is configured, so
`cost_usd` is NULL (unknown). The SDK runs on Workers: it uses the injected `fetch`, reads `process.env`
only when options are omitted, and refuses browser runtimes only.

## Anthropic Messages — writer (`WRITER_PROVIDER=anthropic`)

Implemented in `src/worker/providers/writer-anthropic.ts` (raw fetch).

| Item | Contract |
|---|---|
| Docs | https://docs.claude.com/en/api/messages, structured outputs: https://platform.claude.com/docs/en/build-with-claude/structured-outputs |
| HTTP | `POST https://api.anthropic.com/v1/messages`; headers `x-api-key`, `anthropic-version: 2023-06-01`, `content-type: application/json` |
| Body | `{ model, max_tokens, system, messages: [{ role: "user", content: <JSON input> }], output_config: { format: { type: "json_schema", schema } } }` |
| Response | `content[]` blocks (`text`; `thinking` blocks ignored), `stop_reason` (`end_turn`, `max_tokens`, `refusal`, ...), `usage.{input_tokens, output_tokens}`, `model`; request id header `request-id` |
| Credential test | `GET /v1/models/{model}` (verifies key and configured model id, no inference) |

Why not a forced tool (deviation from the original "forced single output tool with input_schema" plan):
current models (Claude Opus 5.5, Sonnet 5.5, Fable 5.1) return HTTP 400 for `tool_choice: {type: "tool" |
"any"}` ("not supported for this model"). Structured outputs (`output_config.format`; the older
`output_format` parameter is deprecated) is the documented JSON path and is supported on all current models
(Fable 5/5.1, Opus 5.5/5/4.8, Sonnet 5.5/5, Haiku 4.5). With thinking always on for some models (Opus 5.5),
`thinking` content blocks may precede the JSON `text` block; only `text` blocks are parsed. No `tools` are sent. Structured outputs do not accept `minimum/maximum`,
`minLength/maxLength`, or complex array constraints and require `additionalProperties: false`;
`toProviderSchema()` strips those and zod (`recommendationOutputSchema`) enforces them client-side.
`stop_reason: "refusal"` and `"max_tokens"` are reported as writer errors (the call is still recorded).

## OpenAI-compatible Chat Completions — writer (`WRITER_PROVIDER=openai_compatible`)

Implemented in `src/worker/providers/writer-openai.ts`.

| Item | Contract |
|---|---|
| Docs | https://platform.openai.com/docs/api-reference/chat/create, https://platform.openai.com/docs/guides/structured-outputs |
| HTTP | `POST {WRITER_BASE_URL}/chat/completions` (e.g. `WRITER_BASE_URL=https://api.openai.com/v1`), `Authorization: Bearer <key>` |
| Body | `{ model, messages: [system, user], max_completion_tokens, response_format: { type: "json_schema", json_schema: { name, schema, strict: false } } }` |
| Response | `choices[0].message.content` (JSON text), `choices[0].message.refusal`, `choices[0].finish_reason` (`length` = truncated), `usage.{prompt_tokens, completion_tokens}`, `model`; request id header `x-request-id` |
| Credential test | `GET {WRITER_BASE_URL}/models` |

`strict: false` because strict mode requires every property in `required`, which recommendation.v1's
optional fields do not satisfy; outputs are validated with zod regardless. `WRITER_BASE_URL` must be https
and its host is added to the outbound allowlist. Compatible servers that only accept the older
`max_tokens` parameter are not supported without a change.

## Gemini API with Grounding with Google Search — GEO

Implemented in `src/worker/providers/gemini.ts` (geo-providers module).

| Item | Contract |
|---|---|
| Docs | https://ai.google.dev/api/generate-content, https://ai.google.dev/gemini-api/docs/google-search |
| HTTP | `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`, header `x-goog-api-key` |
| Body | `contents[]`, `systemInstruction`, `tools: [{ googleSearch: {} }]`, `generationConfig.maxOutputTokens` |
| Response | `candidates[].content.parts[].text`, `finishReason`, `groundingMetadata.{webSearchQueries[], groundingChunks[].web.{uri,title}, groundingSupports[]}`, `usageMetadata.*`, `responseId`, `modelVersion` |
| Credential test | `GET /v1beta/models/{model}` |

**Documented conflict**: as of 2026-09-30 the grounding guide shows only the newer Interactions API
(`POST /v1beta/interactions`). `generateContent` and `GroundingMetadata` remain in the official API
reference (https://ai.google.dev/api/generate-content), so the adapter keeps `generateContent`; the
Interactions API is the migration path. `grounded` is true only when metadata proves a search
(non-empty `webSearchQueries` or `groundingChunks`); `webSearchQueries` are stored as engine search
queries, otherwise "not exposed".

## Perplexity Agent API — GEO

Implemented in `src/worker/providers/perplexity.ts` (geo-providers module).

| Item | Contract |
|---|---|
| Docs | https://docs.perplexity.ai/api-reference/agent-post, OpenAPI https://docs.perplexity.ai/openapi.json (operation `createAgent`), web search tool https://docs.perplexity.ai/docs/agent-api/tools/web-search |
| HTTP | `POST https://api.perplexity.ai/v1/agent`, `Authorization: Bearer <key>` |
| Body | `model` in provider/model form (e.g. `perplexity/sonar`), `input`, `instructions`, `tools: [{ type: "web_search" }]`, `language_preference`, `max_output_tokens` |
| Response | `status`, `output[]` items: `message` (`content[].output_text`), `search_results` (`results[].{url,title,snippet,date}`, `queries[]`); `usage.{input_tokens, output_tokens, cost.total_cost}` |
| Credential test | `GET https://api.perplexity.ai/v1/models` |

**Switch from Sonar**: the build kit describes Sonar Chat Completions. Perplexity's migration guide states
Sonar Chat Completions support ended on 2026-09-27 and recommends the Agent API, so the adapter targets
`/v1/agent`. The removed top-level `citations` field is never parsed; only `search_results` items produce
citations. `usage.cost.total_cost` is recorded as actual cost (`cost_is_estimate = 0`).

## Google Search Console — SEO

Implemented in `src/worker/platform/gsc-client.ts` and `gsc-oauth.ts` (platform-projects module).

| Item | Contract |
|---|---|
| Docs | https://developers.google.com/webmaster-tools/v1/searchanalytics/query, https://developers.google.com/webmaster-tools/v1/how-tos/all-your-data, https://developers.google.com/webmaster-tools/limits |
| Sites | `GET https://www.googleapis.com/webmasters/v3/sites` → `{ siteEntry: [{ siteUrl, permissionLevel }] }` |
| Query | `POST https://www.googleapis.com/webmasters/v3/sites/{siteUrl}/searchAnalytics/query`, body `{ startDate, endDate, dimensions, type, rowLimit (1..25000), startRow, dataState }` → `{ rows: [{ keys, clicks, impressions, ctr, position }], responseAggregationType }` |
| OAuth | `https://accounts.google.com/o/oauth2/v2/auth` (scope `https://www.googleapis.com/auth/webmasters.readonly`, offline, PKCE), token `https://oauth2.googleapis.com/token`, revoke `https://oauth2.googleapis.com/revoke` |

Pagination does not guarantee complete query data; property totals come from a separate aggregate
request and are never computed by summing slices.

## Disabled / not implemented

OpenAI web search and Anthropic web search GEO providers, SERP data sources, analytics, and publishing
connectors are not implemented and are shown as unavailable, never simulated.
