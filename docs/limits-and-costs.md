# Limits and costs

This app does not promise exact provider spend. It enforces hard call, token, row, and page caps, reserves
money atomically before priced calls, records every HTTP attempt, and labels every cost as actual,
estimated, or unknown. Unknown is never shown as $0.

## Default limits

Per project (`project_limits`, editable within bounds via `PUT /projects/:pid/limits`):

| Limit | Default | Budget resource | Daily ceiling used by reservations |
|---|---|---|---|
| Crawl pages per run | 20 | `crawl_pages` | 20 x 4 runs = 80 |
| GSC rows per run | 5,000 | `gsc_rows` | 5,000 x 4 = 20,000 |
| GEO prompts per run | 5 | `geo_prompts` | 5 x 2 providers x 4 = 40 prompt executions |
| Provider calls per day | 60 | `provider_calls` (all providers) and `jev_calls` (Jev only) | 60 each |
| Priced spend per day | $0.50 (500,000 USD micros) | `usd_micros` | 500,000 |
| Writer tokens per day | 200,000 (engineering default, no column yet) | `writer_tokens` | 200,000 |

"4 runs" = one scheduled run plus the manual-run quota (3 per project per UTC day) for each agent.

Global, across all projects, per UTC day (`wrangler.jsonc` vars; defaults in `src/worker/runs/budget.ts`). These
are checked only for reservations that will spend an **operator** key; workspaces on their own keys are bounded
by their project limits alone:

| Var | Default | Resource |
|---|---|---|
| `GLOBAL_USD_MICROS_PER_DAY` | 2,000,000 ($2.00) | `usd_micros` (priced GEO calls on the operator Gemini/Perplexity keys) |
| `GLOBAL_JEV_CALLS_PER_DAY` | 2,000 | `jev_calls` (operator TypeSafe key) |
| `GLOBAL_PROVIDER_CALLS_PER_DAY` | 3,000 | `provider_calls` (any operator key) |
| `GLOBAL_WRITER_TOKENS_PER_DAY` | 1,000,000 | `writer_tokens` (operator writer key) |

Other hard caps: 0-2 new recommendations per agent per project per day; manual runs 3 per project per UTC day
(HTTP 429 `quota_exceeded`; one conditional INSERT, so concurrent requests cannot exceed it); one active run per project and agent (lock TTL 60 minutes); at most 25 runs
started per cron tick; Jev 12 s timeout per attempt with 2 retries; writers 90 s timeout per attempt with 2
retries; GEO raw answers capped at 20,000 characters; evidence text capped at 600 characters.

## Budget mechanics (`src/worker/runs/budget.ts`)

`usage_counters(scope_key, day, resource, used, limit_value)` holds one row per project (`project:<id>`) or
`global` scope, per UTC day and resource.

1. **Reserve** before any external call: upsert today's counter row (the limit is refreshed from
   `project_limits` on every reservation), then a single conditional statement
   `UPDATE usage_counters SET used = used + :amt WHERE ... AND used + :amt <= limit_value`. If no row changed,
   `BudgetExceededError` is thrown and no call is made. When the reservation spends an operator key, the
   `global` counter for `usd_micros`, `jev_calls`, `provider_calls` or `writer_tokens` is reserved the same
   way, and the project increment is rolled back if the global cap is hit. Because check and increment
   are one statement, concurrent reservations cannot overspend (tested: 20 parallel reservations against a
   limit of 5 admit exactly 5).
2. **Settle** to the actual amount when the outcome is known (`used += actual - reserved`, floored at 0).
3. **Release** only when the call certainly did not happen (for example the budget for a second resource
   failed before sending).
4. **Mark unknown** when the outcome is unknown (timeout or dropped connection after sending): the full
   reservation stays counted.

Each reservation is a row in `usage_reservations` (`reserved → settled | released | unknown`); status
changes are claimed with a conditional update so a reservation is settled at most once.

What each caller reserves:

| Caller | Reserved before the call | Settled to |
|---|---|---|
| Jev (`providers/typesafe.ts`) | `provider_calls` and `jev_calls` = 3 (1 attempt + 2 retries) | number of HTTP attempts actually made |
| Writers (`providers/writer-*.ts`) | `provider_calls` = 3; `writer_tokens` = estimated input (chars / 3) + `max_tokens` | attempts; reported input + output tokens (kept in full if any attempt's outcome was unknown) |
| GEO batch (`geo/batch.ts`) | `geo_prompts` 1, `provider_calls` 1, `usd_micros` = versioned upper bound (`rates.reservationMicros`) | actual cost when returned, else the labelled estimate; unknown outcomes keep the reservation |
| Crawl / GSC | `crawl_pages` / `gsc_rows` | pages fetched / rows imported |

## Actual vs estimated vs unknown

| Provider | Cost recorded in `provider_calls.cost_usd` |
|---|---|
| Perplexity Agent API | **Actual** from `usage.cost.total_cost` when returned (`cost_is_estimate = 0`); otherwise an estimate |
| Gemini | **Estimate** from the versioned rate table (tokens + grounding fees), `cost_is_estimate = 1`, `rate_version` stored |
| TypeSafe (Jev) | **Unknown** (NULL): no verified per-call price is configured. Bounded by `provider_calls` / `jev_calls` caps |
| Writers (Anthropic / OpenAI-compatible) | **Unknown** (NULL): the model id is configuration and no verified rate table exists for it. Bounded by call and `writer_tokens` caps |
| Workspace custom writer (OpenAI-compatible, owner-entered base URL) | **Unknown** (NULL), even if the response carries a cost field. Spend is on the workspace's own key: project `writer_tokens` / `provider_calls` limits apply, the `GLOBAL_*` operator caps do not |

Rates live in `src/worker/providers/rates.ts` (`RATE_VERSION = "geo-rates-2026-09-30.1"`), each with its
official pricing URL and validity window. Estimates use paid Standard-tier list prices and ignore free
allowances, so they are conservative upper bounds, not invoices. A model outside every rate window is
treated as unknown until the table is re-verified and the version bumped.

Output budgets that count thinking/reasoning tokens:

- Gemini: `maxOutputTokens` is 8192 (the reservation envelope's output tokens), and thinking tokens count
  toward it. Gemini 3+ models (and the `gemini-flash-latest` / `gemini-pro-latest` aliases) get
  `thinkingLevel` `LOW` unless `GEMINI_THINKING_LEVEL` overrides it. Both values are part of the GEO cohort
  key, so the upgrade that introduced them (and any later change of `GEMINI_THINKING_LEVEL`) starts a new
  Gemini cohort once; trends restart from that run.
- OpenAI-compatible writer: `max_completion_tokens` is the caller's answer budget plus
  `WRITER_REASONING_HEADROOM_TOKENS` (default 0, or 4000 when `WRITER_REASONING_EFFORT` is set). The
  `writer_tokens` reservation is the prompt estimate plus that same `max_completion_tokens`.

`GET /projects/:pid/usage` reports, for the current UTC day: every call (provider, model, purpose, status,
cost, estimate flag), `usdActual` (sum of provider-returned costs, or null when none), `usdEstimated` (sum of
labelled estimates, or null), and `usdUnknownCalls` (count of calls with unknown cost), plus notes that
explain these limits. The `usd_micros` cap applies to priced calls only; spend on unpriced providers is
limited by call and token caps.

Limitations:

- Providers do not offer idempotency keys, so exactly-once billing is not guaranteed. Every attempt
  (including retries) is recorded and counted.
- A settle may exceed the original reservation when a call costs more than its upper bound; the counter
  then reflects the true amount even if it passes the limit, and further reservations are refused.
- Any speed or cost claim requires the benchmark harness ([A5]); none is made here.

## Retention

| Data | Retention |
|---|---|
| `agent_runs`, `run_events`, `decision_records`, `recommendations`, `recommendation_events`, `judgment_feedback` | Kept for the life of the project (audit trail, dedup, evaluation set); deleted with the project |
| `provider_calls`, `usage_reservations`, `usage_counters` | Kept for the life of the project as financial/audit metadata (no prompts, answers, or keys) |
| GSC slice rows (`gsc_metrics`) | Last 3 API syncs per project; totals and daily series kept with their sync |
| GEO raw answers | Capped at 20,000 characters per observation; deleted with the project |
| Page snapshots | Compact extracted evidence only (no raw HTML) |
| Workflow instance state | Cloudflare Workflows retention only; D1 is the system of record |

Project deletion (`DELETE /projects/:pid`) removes tenant data and deletes the stored Search Console token (Google's
revoke endpoint is not called, since it would disconnect every project using that Google account); `GET
/projects/:pid/export` exports it without secrets.
