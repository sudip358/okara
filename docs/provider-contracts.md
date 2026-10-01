# Provider contracts

Official documentation is the authority. Every entry lists the endpoint and fields this codebase relies on,
where it is implemented, and the doc URL. Contracts were checked on 2026-09-30; re-verify before changing an
adapter. Model ids are configuration only: the workspace owner's selection on the Integrations page
(`workspace_provider_models`, see "Workspace model selection") or the operator env vars (`TYPESAFE_MODEL`,
`GEMINI_MODEL`, `PERPLEXITY_MODEL`, `OPENAI_GEO_MODEL`, `ANTHROPIC_GEO_MODEL`, `WRITER_MODEL`); no adapter
hardcodes a default model id except the documented `jev-latest` alias.

All provider traffic from runs goes through `ctx.apiFetch` (host allowlist, https, `redirect: "manual"`), or,
for a custom GEO engine, a lane fetch built by the same `createApiFetch` that admits only that provider's host.
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

## Custom OpenAI-compatible provider — workspace writer (`workspace_custom_providers`)

Added 2026-10-01. A workspace owner can make any OpenAI-compatible endpoint (for example OpenRouter, Groq,
Together, DeepSeek, Mistral, or a self-hosted gateway) the workspace's writer from the Integrations page by
entering a base URL and an API key, fetching the provider's models, and picking one. Rules:
`src/worker/platform/custom-providers.ts`; routes: `src/worker/routes/custom-providers.ts`; writer:
`createCustomProviderWriter` in `src/worker/providers/writer.ts` (the same implementation as
`WRITER_PROVIDER=openai_compatible`, `src/worker/providers/writer-openai.ts`).

| Item | Contract |
|---|---|
| Docs | The OpenAI API reference is the shape relied on: https://platform.openai.com/docs/api-reference/models/list, https://platform.openai.com/docs/api-reference/chat/create. Each provider documents its own base URL and model ids; none is hardcoded here |
| Model list | `GET {baseUrl}/models`, `Authorization: Bearer <key>`, `Accept: application/json`; response `{ object: "list", data: [{ id, ... }] }`. Also accepted: `{ models: [{ id \| name }] }` and a bare array (gateways that differ). Used for "Fetch models" and the Test button (no inference, no cost). A 2xx answer that is not one of those shapes (an HTML page because the base URL lacks `/v1`, a gateway's `200 {"error": ...}`, an empty body) is a failure ("not an OpenAI-style model list; check the base URL"), never "key accepted". A model list only shows that the key was **not rejected**: some providers list models without checking the key (self-hosted vLLM/Ollama, some hosted catalogues), so the first draft is the final check, and the wording says so |
| Drafting | `POST {baseUrl}/chat/completions`, body as the OpenAI-compatible writer: `{ model, messages: [system, user], max_completion_tokens, response_format: { type: "json_schema", json_schema: { name, schema, strict: false } } }`. No `reasoning_effort`, no reasoning headroom, no `tools` |
| Response | `choices[0].message.content` (JSON text), `refusal`, `finish_reason`, `usage.{prompt_tokens, completion_tokens}`, `model`; request id header `x-request-id` |
| Base URL | Validated before saving and before every use: https, no credentials, no IP literal, public hostname (dot, LDH labels, alphabetic or IDN TLD, no local/reserved suffix, no cluster service-discovery suffix such as `.svc` / `.cluster` / `.consul` / `.docker`, no loopback wildcard-DNS service such as `nip.io` / `sslip.io` / `xip.io` / `localtest.me` / `lvh.me`, no IPv4 address spelled in the name such as `127.0.0.1.example.com` or `10-0-0-1.example.com`), default port, no query/fragment, not the app's own host. Names are **not resolved**: the residual risk (a public name whose DNS points at a private address) is covered by Workers egress, which cannot reach private addresses, the same as the crawler note in `src/worker/seo/ssrf.ts`. Under local `npm run dev` that egress protection does not exist, so only use trusted base URLs there. See docs/api.md "Custom providers" |
| Hosts | Only the selected provider's host, only for its workspace, joins `ctx.apiFetch` (`createApiFetch(env, fetch, [host])`); `redirect: "manual"`, a 3xx is a failure |
| Timeouts and sizes | Model list and test: 10 s (headers and body), body capped at 8 MiB. Drafting: the writer's 90 s per attempt, 2 retries (408/429/5xx/network); the response body is capped at 2 MiB per attempt (`CUSTOM_WRITER_MAX_RESPONSE_BYTES`; output is already bounded by `max_completion_tokens`): a larger body is cancelled, recorded as `Response exceeded 2097152 bytes.` and not retried (status `unknown` for a 2xx, since the provider may bill for it, so the `writer_tokens` reservation is kept) |
| Keys | AES-GCM envelope, AAD `workspace_custom_providers:<workspace_id>:<id>` (workspace and row; the host is not part of the AAD); never returned, logged or exported; a stored key is only sent to the host it was saved for, unless the owner explicitly moves it: a PATCH to a new host needs a new key or `keepKeyForNewHost: true` (the owner ticked "Send my saved key to <new host>"), else 400 `key_required_for_new_host` (see "Base URL changes" below). A provider error body that echoes the key (in any format, e.g. `gsk_...`, also JSON-escaped or URL-encoded) has the key replaced by `[redacted]` before it is stored in `provider_calls.error` or reaches run events (`requestJson` `secrets`, on top of the generic `redact()` patterns; applies to every OpenAI-compatible writer) |
| Cost | Unknown (`cost_usd` NULL): the model and its price are third-party configuration and no rate table exists. A `usage.cost` field in a response is not read |
| Budget | `provider_calls` and `writer_tokens` reserved per attempt like every writer, attributed to the workspace's own key: project limits apply, the operator `GLOBAL_*` caps do not |

Limits: the endpoint must support `response_format` `json_schema` and `max_completion_tokens` (servers that only
accept `max_tokens` or `json_object` fail the draft, recorded as a writer error, never faked). A reasoning
model may spend the completion budget on reasoning; the truncation error then says to pick a non-reasoning
model. A provider without a `/models` endpoint still works: the model id is typed by hand (the Test button
then reports the HTTP status of `/models`). Outputs are validated with zod and the product-fact validator like
every writer draft. Data sent is the writer's disclosure (`DATA_SENT.writer`): stored evidence, confirmed
context documents, brand and competitor names; never credentials or raw Search Console exports.

Base URL changes (added 2026-10-01, owner request: "the custom base URL keeps on changing"). Tunnels such as
Cloudflare quick tunnels (`*.trycloudflare.com`), ngrok (`*.ngrok-free.app`) and localtunnel (`*.loca.lt`)
get a new hostname on every restart. They validate like any public hostname; a tunnel name that spells an
IPv4 address in four groups is refused (wildcard-DNS services such as nip.io/sslip.io resolve those names to the
spelled address), except exactly one label directly under an ngrok domain (`ngrok-free.app`, `ngrok-free.dev`,
`ngrok.app`, `ngrok.io`): ngrok's random names for IPv4 clients (`<hex>-203-0-113-5.ngrok-free.app`) resolve to
ngrok's own edge addresses, not the embedded one (checked 2026-10-01 with dns.google:
`7c3e-103-21-58-191.ngrok-free.app` and `127-0-0-1.ngrok-free.app` both answer with ngrok edge IPs). Moving a
saved provider (writer or GEO engine) to a new host keeps its key only on explicit confirmation
(`keepKeyForNewHost: true` from the "Send my saved key to <new host>" checkbox, unchecked by default, in
"Edit URL or key" and the inline "Quick update URL"); without it the server answers 400
`key_required_for_new_host`, so a saved key is never forwarded to another host silently. Because the AAD binds
workspace and row (not the host), the stored envelope stays valid and is not re-encrypted; the server checks
that it still decrypts before accepting the move. The new host is re-validated (SSRF rules above), only that
host is admitted to the guarded fetch, and the old host is no longer reachable with the key. Each change is
recorded in `workspace_custom_provider_changes` (migration 0012: when, which owner, which fields, old and new
host, whether the key was kept; no key material) and shown on the card ("URL changed ..."). After the save the
UI re-runs Test; the test result's `modelListed: false` (the saved model is not in the new host's complete
model list) makes the card offer "Change model". A provider saved without a name is labelled with its host; that
default name follows the new host (a chosen name is kept). Runs read the base URL, host, model and key of a
custom provider in one statement just before use (`resolveCustomProviderRow`), so a move that lands while a
run starts can never pair the old host with a new key. Risk of claimable tunnel names: scheduled runs and the
automatic Test send the saved key to whatever host is saved. A tunnel name that someone else can claim when
your tunnel is down (e.g. a chosen `*.loca.lt` subdomain, first come, first served) will receive the saved key,
and the writer evidence or GEO prompts, on the next run or Test; prefer random or reserved names (Cloudflare
quick tunnel, an ngrok reserved domain), and when you stop the tunnel, update the URL, remove the provider, or
rotate the key. The "Send my saved key to <host>" confirmation shows a short form of this note.

## Workspace model selection — built-in providers (`workspace_provider_models`)

Added 2026-10-01 (owner request). The owner picks the model per workspace for `gemini`, `perplexity`,
`openai_geo` and `anthropic_geo` on the Integrations page. TypeSafe (Jev) is not selectable (owner decision
2026-10-01, "TypeSafe will perform as it is"): its card has no model row, both model routes answer 400
`model_not_selectable` for it whatever the key source, and it always runs `TYPESAFE_MODEL`, else the
documented `jev-latest` alias (a stored `typesafe` row from the short-lived picker is ignored). Rules:
`src/worker/platform/provider-models.ts`; routes: `src/worker/routes/credentials.ts`
(`POST /workspaces/:wid/credentials/:provider/models`, `PUT /workspaces/:wid/credentials/:provider/model`).
Resolution: workspace selection > operator env var > none (`setup_required`, "choose a model"). List
endpoints, verified against the official docs on 2026-10-01 (the TypeSafe row is reference only; the model
routes no longer call it):

| Provider | List request | Response used | Official docs |
|---|---|---|---|
| Gemini | `GET https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000`, header `x-goog-api-key` (pageSize default 50, max 1000) | `models[].name` (`models/{model}`; the prefix is removed), `displayName`, `supportedGenerationMethods[]` (only models listing `generateContent` are offered), `nextPageToken` (reported as "more models than one page") | https://ai.google.dev/api/models#method:-models.list |
| OpenAI (`openai_geo`) | `GET https://api.openai.com/v1/models`, `Authorization: Bearer` | `{object: "list", data: [{id, created, owned_by}]}` | https://platform.openai.com/docs/api-reference/models/list (served at https://developers.openai.com/api/reference/resources/models/methods/list) |
| Anthropic (`anthropic_geo`) | `GET https://api.anthropic.com/v1/models?limit=1000`, headers `x-api-key`, `anthropic-version: 2023-06-01` (limit default 20, range 1-1000) | `data[].{id, display_name}`, `has_more` (reported as more pages). The response also carries `capabilities`, but none of them is web search, so no web-search capability is inferred | https://platform.claude.com/docs/en/api/models/list |
| Perplexity | `GET https://api.perplexity.ai/v1/models` (OpenAPI operation `listModels`; `Authorization: Bearer` sent as for every Perplexity call). listModels has no security requirement (openapi.json `security: []`, re-read 2026-10-01): a successful list does not prove the key works | `{object: "list", data: [{id, object, created, owned_by}]}`; ids are Agent API models in `provider/model` format (e.g. `perplexity/sonar`); ids without a `/` are dropped | https://docs.perplexity.ai/api-reference/models-get, https://docs.perplexity.ai/openapi.json |
| TypeSafe | `GET https://api.typesafe.ai/v1/models`, `Authorization: Bearer` | `{models: [{name, description, release_date}]}` ("returns the names your account can send in the model field"; versioned ids such as `jev-1.13.0` are accepted whether or not they are listed) | https://docs.typesafe.ai/models |

Transport for every list: the guarded API fetch (allowlisted hosts only), `redirect: "manual"`, 10 s timeout
covering headers and body, body capped at 8 MiB, at most 10,000 entries inspected and 500 returned; ids are
validated per provider (the id rules the adapters already apply), at most 200 characters, no control
characters. The provider body is never echoed and the key travels only in a header. Capability: a list
cannot prove that a model supports the lane's feature (Gemini grounding with `google_search`, Perplexity
Agent API `web_search`, OpenAI Responses `web_search`, Anthropic web search tool); the UI says "Must support
<feature>; the Test run will tell you" and nothing is inferred. Cost: `providers/rates.ts` only; a selected
model without a verified rate records cost as unknown (NULL) and the card says so. The model is part of the
cohort key, so trend series split by model.

Operator-key spend guard (`modelForKeySource` in `provider-models.ts`; runtime, request-scoped decisions,
Integrations statuses, capability presence and the board all use it). Before this feature only the operator
chose the model that runs on the operator's key. An unpriced call reserves and settles a flat
`UNKNOWN_RATE_RESERVE_USD_MICROS` ($0.15) whatever it really costs, so `GLOBAL_USD_MICROS_PER_DAY` would
undercount operator spend. Therefore, when a workspace has no key of its own for a provider and the
operator key is used:

- a workspace-chosen GEO engine model runs only when `providers/rates.ts` has a verified rate for it (or it
  equals the operator's own env model). Otherwise no lane is built, the run logs "<Vendor> model <id> has
  no verified price and this workspace uses the operator key; add your own <Vendor> key to use it.", and
  the card and the board show `setup_required` with that text. `PUT .../model` refuses such a choice
  up front (400, `reason: "operator_key_unpriced"`);
- a model list fetched with the operator key returns only ids with a verified rate. For OpenAI it also
  drops fine-tuned (`ft:`) models and models whose `owned_by` is not `openai`, `system` or
  `openai-internal`, so the operator's private model and organisation names are never shown to a tenant.

With the workspace's own key every valid id can be chosen (cost unknown when unpriced).

## Custom GEO engine lane (`workspace_custom_providers.role = 'geo'`)

Added 2026-10-01 (owner request). Same records, base URL rules, key storage, model list and test as the
custom writer above (`role` column from migration 0011; at most 2 per workspace; never the writer). Adapter:
`src/worker/providers/custom-geo.ts`; lane rules: `src/worker/geo/custom-lanes.ts`.

| Item | Contract |
|---|---|
| Request | `POST {baseUrl}/chat/completions`, `Authorization: Bearer <key>`, body `{ model, messages: [ {role: "system", content: <neutral locale instruction>}?, {role: "user", content: <prompt>} ], max_completion_tokens: 4096 }`. No `tools`, no `response_format`; the brand is never named. Same OpenAI-compatible Chat Completions shape the custom writer relies on (https://platform.openai.com/docs/api-reference/chat/create) |
| Response | `choices[0].message.content` (answer text, stored as untrusted plain text, capped like every raw answer), `finish_reason` (`length` = incomplete), `usage.{prompt_tokens, completion_tokens}`, `id`, `model`. Body capped at 2 MiB |
| Grounding | None: nothing in the response proves a web search. `grounded = 0`, grounding mode `none (custom provider)`, no citations, no search queries (`searchQueriesExposed: false`). Mention rate and tracked-brand share of voice only; citation rate excludes ungrounded answers by definition |
| Errors | 3xx not followed (rejected); 4xx rejected; 5xx, a non-JSON or oversized body = server error (billing unknown); timeouts 30 s. Stored error text is the HTTP status only (never the provider body); the key is scrubbed |
| Hosts | A lane-specific guarded fetch admitting only that provider's host, only for its workspace; `ctx.apiFetch` does not admit it |
| Cost and budget | Cost unknown (NULL). Reserves `geo_prompts` and `provider_calls` like every engine (tenant key: project limits only, never the operator global caps); no `usd_micros` reservation |
| Label | "Custom · no web search proof · mention rate only" on results lanes, the AI engines board and the activity window |
| Untrusted response fields | The host is owner-chosen, so its `model` and `id` are untrusted: every answer (ok or failed) is stored with the CONFIGURED model id, so the cohort key and the trend series are fixed by the owner's selection, never by what a router reports; the request id is kept only when it is at most 200 characters without control characters (else NULL); `finish_reason` likewise |
| Board and proposals | The AI engines board shows only the prompt feed for this lane, its mention rate and "Citation rate: not measured (no web search proof)"; no cited pages, skip factors or rewrite plans (they need citations). Custom lanes are not inputs to GEO proposals (`geo/proposals.ts`) |

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
