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

Implemented in `src/worker/providers/writer-anthropic.ts` with the official `@anthropic-ai/sdk` (`client.messages.create(...).withResponse()`, `maxRetries: 0` so every attempt is metered by our own loop; retries only 408/429/5xx/529 and connection errors; typed SDK error classes, never message matching).

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

## OpenAI Responses API web search — GEO (`openai_geo`, implemented)

Implemented in `src/worker/providers/openai-geo.ts` (grounding mode `openai_web_search`; cohort
`samplingOptions` `{ maxOutputTokens, tools: ["web_search"], toolChoice: "auto", maxToolCalls: 5 }`).

Read 2026-09-30 from the official docs (the old `platform.openai.com/docs/...` URLs now 301 to
`developers.openai.com/api/docs/...`; the `.md` suffix returns the same page as Markdown):
guide https://developers.openai.com/api/docs/guides/tools-web-search, reference
https://developers.openai.com/api/reference/resources/responses/methods/create, pricing
https://developers.openai.com/api/docs/pricing#built-in-tools.

| Item | Contract |
|---|---|
| HTTP | `POST https://api.openai.com/v1/responses`, `Authorization: Bearer <key>`, `Content-Type: application/json` |
| Body | `{ model: env.OPENAI_GEO_MODEL, input: <prompt text>, instructions?, tools: [{ type: "web_search" }], tool_choice: "auto", include: ["web_search_call.action.sources"], max_output_tokens, max_tool_calls: 5 }` |
| `max_tool_calls` | Reference (read 2026-10-01): "The maximum number of total calls to built-in tools that can be processed in a response. This maximum number applies across all built-in tool calls, not per individual tool. Any further attempts to call a tool by the model will be ignored." Set to the 5 search calls the `usd_micros` reservation assumes (`RESERVATION_ENVELOPE.openaiSearchCalls`), so `tool_choice: "auto"` cannot search past the reserved envelope |
| Tool type | `"web_search"` (recommended for new integrations). Reference enum: `"web_search" \| "web_search_2025_08_26"`. `"web_search_preview"` is legacy only (no `filters`, `return_token_budget`; ignores `external_web_access`) and must not be used |
| Tool options | `search_context_size: "low" \| "medium" \| "high"`; `filters: { allowed_domains?, blocked_domains? }` (up to 100, bare domains); `user_location: { type: "approximate", country (ISO alpha-2), city, region, timezone }` (not for deep research); `external_web_access` (default `true`); `return_token_budget: "default" \| "unlimited"` (GPT-5+ reasoning only) |
| Output: search happened | `output[]` item `{ type: "web_search_call", id: "ws_...", status: "in_progress" \| "searching" \| "completed" \| "failed" \| "incomplete", action }`; `action` is `{ type: "search", queries?, query?, sources?: [{ type: "url", url }] }`, `{ type: "open_page", url }` or `{ type: "find_in_page", pattern, url }` (the last two on reasoning models) |
| Output: answer + citations | `output[]` item `{ type: "message", role: "assistant", status, content: [{ type: "output_text", text, annotations: [{ type: "url_citation", start_index, end_index, url, title }] }] }` |
| Sources | `include: ["web_search_call.action.sources"]` returns every URL consulted (usually more than the cited ones; may include `oai-sports`, `oai-weather`, `oai-finance` feeds). Stored as consulted sources, never as citations |
| Usage | `usage: { input_tokens, input_tokens_details: { cached_tokens, cache_write_tokens }, output_tokens, output_tokens_details: { reasoning_tokens }, total_tokens }`. No search-call count and no cost field |
| Request id | response header `x-request-id`; response `id` (`resp_...`) |
| Rate limits | "Same as tiered rate limits for underlying model used with the tool" |
| Credential test | `GET https://api.openai.com/v1/models/{OPENAI_GEO_MODEL}` (no inference) |

Rules for the adapter:
- `grounded = true` only when the output holds at least one `web_search_call` with `status: "completed"` and
  `action.type: "search"`. With `tool_choice: "auto"` search is optional (docs: "Use `tool_choice:
  "required"` ... when search must run"); an answer without a search call is stored `grounded = false`,
  never re-labelled. `tool_choice` is part of the cohort key.
- Engine search queries [A6]: `action.queries[]`, else `action.query`, from `search` actions only. The docs
  say queries are "usually (but not always)" present; when absent the observation stores "not exposed".
- Citations: `url_citation` annotations only (URL, title, character span). `start_index`/`end_index` locate
  the supporting span in `output_text.text`.
- Pricing (pricing page, "Tools" table): Web search (all models) **$10.00 / 1k calls + search content tokens
  billed at model rates**; web search preview on reasoning models $10.00 / 1k calls; web search preview on
  non-reasoning models $25.00 / 1k calls with free search content tokens. "For gpt-4o-mini and gpt-4.1-mini
  with the non-preview web search tool, search content tokens are billed as a fixed block of 8,000 input
  tokens per call." The guide: "Search actions incur a tool call cost"; billable calls are therefore counted
  as the number of `web_search_call` items with `action.type: "search"`. The API returns no cost, so cost is
  always an estimate (`cost_is_estimate = 1`) from a versioned rate entry for the exact configured model;
  without a rate entry for that model, `cost_usd` is NULL (unknown), never $0.
- Model support (guide, read 2026-09-30): Responses `web_search` with GPT-5-family reasoning models (the
  guide recommends `gpt-5.5`), `gpt-4.1`, `gpt-4.1-mini`; not `gpt-5` with `minimal` reasoning; `o4-mini`
  is deprecated (shutdown 2026-10-23). Search context is capped at 128k regardless of model window.
  `gpt-5-search-api` is Chat Completions only and is not used. The model id is never hardcoded:
  `OPENAI_GEO_MODEL` must be set or the lane is `setup_required`.
- Hosts: `api.openai.com` (in `API_HOST_ALLOWLIST`, `src/worker/runs/runtime.ts`).
- Keys: operator key `OPENAI_GEO_API_KEY` or a workspace key under provider id `openai_geo` (storable since
  migration 0008), separate from the writer key.
- Rates (`src/worker/providers/rates.ts`): Standard tier text-token prices from the pricing page, read
  2026-09-30 and re-verified 2026-10-01; web_search support per the guide varies by model.

## Anthropic Messages web search — GEO (`anthropic_geo`, implemented)

Implemented in `src/worker/providers/anthropic-geo.ts` (grounding mode `anthropic_web_search`; cohort
`samplingOptions` `{ maxTokens, tools: ["web_search_20250305"], maxUses: 3 }`).

Read 2026-09-30: https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool (the
docs.claude.com URL 302s here), tool versions https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference,
pricing https://platform.claude.com/docs/en/about-claude/pricing (section "Web search tool").

| Item | Contract |
|---|---|
| HTTP | `POST https://api.anthropic.com/v1/messages`; headers `x-api-key`, `anthropic-version: 2023-06-01`, `content-type: application/json` (no beta header) |
| SDK | `@anthropic-ai/sdk` 0.130.0 (already a dependency, used by the writer) types `WebSearchTool20250305`, `WebSearchTool20260209`, `WebSearchTool20260318`, `ServerToolUseBlock`, `WebSearchToolResultBlock`, `CitationsWebSearchResultLocation`, `ServerToolUsage`; use `client.messages.create(...).withResponse()` with `fetch: ctx.apiFetch`, `maxRetries: 0` like the writer |
| Body | `{ model: env.ANTHROPIC_GEO_MODEL, max_tokens, system?, messages: [{ role: "user", content: <prompt text> }], tools: [{ type: "web_search_20250305", name: "web_search", max_uses: <n> }] }` |
| Tool versions | `web_search_20250305` (basic), `web_search_20260209` (adds dynamic filtering through code execution; `allowed_callers` defaults to `["code_execution_20260120"]`), `web_search_20260318` (adds `response_inclusion`). All three are current. The GEO lane uses `web_search_20250305` (direct search, the same behaviour on every model, no code-execution blocks); the tool version is part of the cohort key |
| Tool options | `max_uses`; `allowed_domains` or `blocked_domains` (not both: 400); `user_location: { type: "approximate", city, region, country (ISO alpha-2), timezone }`; `allowed_callers` |
| Response blocks | `server_tool_use { id: "srvtoolu_...", name: "web_search", input: { query } }`; `web_search_tool_result { tool_use_id, content: [{ type: "web_search_result", url, title, encrypted_content, page_age }] }` or, on error, `content: { type: "web_search_tool_result_error", error_code }`; `text { text, citations?: [{ type: "web_search_result_location", url, title, encrypted_index, cited_text }] }` (`cited_text` up to 150 characters) |
| Error codes | `too_many_requests`, `invalid_tool_input`, `max_uses_exceeded`, `query_too_long`, `request_too_large`, `unavailable` (HTTP 200; the error is inside the block; errored searches are not billed) |
| Stop reasons | `end_turn`, `max_tokens`, `pause_turn` (long search turn paused; continue by sending the assistant content back unchanged), `refusal`, ... |
| Usage | `usage: { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, server_tool_use: { web_search_requests, web_fetch_requests } }` |
| Request id | response header `request-id`; message `id` |
| Org setting | Web search is on unless an admin disabled it in the Claude Console; then the request fails with 400 `invalid_request_error` saying web search is not enabled. The lane reports `error` with that detail (not a fake empty answer) |
| Credential test | `GET /v1/models/{ANTHROPIC_GEO_MODEL}` (as the writer) |

Rules for the adapter:
- `grounded = true` only when at least one `server_tool_use` with `name: "web_search"` is followed by a
  `web_search_tool_result` whose `content` is a (possibly empty) result list, and
  `usage.server_tool_use.web_search_requests >= 1`.
- Engine search queries [A6]: `server_tool_use.input.query` (exposed on every search).
- Answer text: the `text` blocks after the last `web_search_tool_result` (consecutive blocks joined with no
  separator: they are one passage split at citation boundaries). Text written before searching ("I'll search
  for ...") is narration, not the answer. With no search result, all text is the answer; if no text follows
  the last result, every passage is kept, separated by a blank line.
- Citations: `web_search_result_location` citations on `text` blocks (URL, title, `cited_text`). Search
  results that were not cited are consulted sources, not citations. `encrypted_content`/`encrypted_index`
  are not stored (only needed for multi-turn, which the lane never does).
- `pause_turn`: continue at most once (bounded); otherwise the observation is `incomplete`.
- Pricing: **$10 per 1,000 searches** plus standard token costs; "Each web search counts as one use,
  regardless of the number of results returned. If an error occurs during web search, the web search will
  not be billed." Search results count as input tokens. Cost = `web_search_requests × $0.01` + tokens × the
  configured model's rates, labelled estimate; NULL when the model has no rate entry.
- Hosts: `api.anthropic.com` (already in `API_HOST_ALLOWLIST`).
- Keys: operator key `ANTHROPIC_GEO_API_KEY` or a workspace key under `anthropic_geo` (storable since
  migration 0008), separate from `WRITER_API_KEY`. Model only from `ANTHROPIC_GEO_MODEL`.
- Rates (`src/worker/providers/rates.ts`): base input/output prices verified live on
  https://platform.claude.com/docs/en/about-claude/pricing on 2026-10-01 (they first came from a cached
  table dated 2026-09-25; the live page matched).
- Not available on Amazon Bedrock; on Google Cloud only the basic tool. This app calls the Claude API directly.

## Disabled / not implemented

All four GEO answer-engine lanes (OpenAI, Anthropic, Gemini, Perplexity) are implemented; an unconfigured
lane shows `setup_required`, never simulated. SERP data sources, analytics, and publishing connectors are not
implemented and are shown as unavailable.
