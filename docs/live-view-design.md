# Live view: UI and data spec

A full-screen, mission-control view of what the SEO and GEO agents are doing: every panel is one real
stage of the agent's work, fed only by rows the run stored. Route `/projects/:pid/live`. Status: spec and
contract. The contract types are in `src/shared/types.ts` (section "Live view"), the endpoints are in
docs/api.md ("Live view"), and the element map is in `src/worker/live/elements.ts`.

References, used for layout and motion only. Their numbers are not evidence: both videos are labelled
"Simulated run", and Ryze's own blog says the numbers on screen are illustrative.
- Rankie "Jev for SEO and GEO", a 4-panel board. Frames are in `scratchpad/vid/`, `frames-rankie/`
  (0.25 s apart) and `vid3/rankie.png`.
- Ryze "Jev for SEO/GEO", with one column per engine. Frames are in `scratchpad/vid2/`, `frames-ryze/`
  (0.5 s apart) and `vid3/ryze*.png`.
- Research extras: Okara CMO log, Borja link map, Hall heatmap, Ira AI Overview chips
  (`scratchpad/research/`).

The view builds on docs/geo-board-design.md (engine columns, honesty labels, components) and does not
duplicate it. Where this document says "as in the board", the board spec applies unchanged.

## 0. Rules this view never breaks

1. Every number, row, card and chip comes from a stored row of a real run. The one exception is the demo
   project's seeded rows, which carry the label "Demo data - simulated run" everywhere they show.
2. Nothing ticks up on a timer. A value changes only when a newer stored value arrives (live) or when a
   stored event's time is reached (replay). The elapsed clock is the only timer: it is wall-clock time
   since `run.startedAt`.
3. "Reading…" style placeholders appear only for work that is genuinely pending:
   - a queued prompt/engine pair of an active run;
   - an answer that is stored but not analysed yet;
   - a step that has started but not finished;
   - a competitor page in the `queued` or `fetching` state;
   - in replay, a stored row whose time has not been reached yet.
   A row that has already been judged is never shown as "Reading…" before it resolves.
4. Nothing is projected. The view never shows predicted clicks, traffic, conversions, revenue, "after"
   percentages, citation chance, "x/10" scores, prompts per second, or question volume. A cost is
   "actual", "estimate", or "unknown", never $0 for unknown.
5. Jev never gets a confidence it does not have. Noul shows as "Jev act · 0.92" (the stored tier and the
   raw yes-probability). Choice shows as "Jev act · update · conf 0.87", because confidence is a real
   Choice field. Code computes every verdict.
6. Untrusted text is rendered as plain text: page titles, snippets, prompts, answers, competitor reasons,
   and step messages. Brand highlights in answers are `<mark>` wrapped around plain-text slices, never HTML.
7. We adapt competitor pages, we never steal from them. The view only shows competitor pages whose URLs a
   user approved.
8. Engines appear as the existing letter badges (`engineGlyph`), never as vendor logos or colours.
   Engines are named by their real lane label ("OpenAI Responses API · web_search"), never "ChatGPT".

## 1. Route, entry points, modes

- **Route:** `/projects/:pid/live?run=<runId>&mode=seo|geo`. Both params are optional. Add it with one
  line in `App.tsx`:
  `{ path: "live", lazy: page(() => import("./pages/live/LivePage"), "LivePage") }`.
- **Nav:** add `{ to: "live", label: "Live" }` to `ProjectLayout.tsx` `NAV`, right after "Overview". When
  any run of the project is `pending` or `running`, the label carries a pulsing dot, `LiveNavDot`, with
  sr-only text "run in progress". `LiveNavDot` reads a tiny store that `ActivityLauncher` already feeds
  from its `GET /activity/current` poll (`useSyncExternalStore`), so it adds no new request. The only
  ProjectLayout change is that entry plus `{item.to === "live" && <LiveNavDot projectId=… />}`.
- **Activity panel:** add an "Open live view" link in the Activity panel header (`ActivityView.tsx` /
  `ActivityWindow.tsx`, owned by web-activity) pointing to `live?run=<shown runId>`. Another workflow is
  editing `ActivityView.tsx`: re-read it before the edit and keep the change to that one link.
- **Run selection:** `GET /projects/:pid/activity/current` (existing).
  - `?run=` wins when the run belongs to the project.
  - Otherwise the newest active run is shown LIVE.
  - Otherwise the latest finished run is shown as a REPLAY.
  - Demo projects get their two demo runs, replay only.
- **Mode:** chosen automatically from `run.agent`. A segmented toggle `SEO | GEO` in the header switches to
  the other agent's run from the same `current` list: active first, else the latest finished. When the
  other agent has no run, the toggle shows the empty state "No GEO run yet" with the existing
  `RunNowButton`.
- **Live and replay:**
  - LIVE applies while the shown run is `pending` or `running`.
  - REPLAY applies otherwise.
  - When a LIVE run finishes on screen, the pill switches to "Run finished" and a **Replay this run**
    button appears. Panels keep their state.
  - While replaying, the view polls `current` every 10 s (existing cadence). If a run becomes active, a
    banner shows "A run is live now · Watch live".

## 2. Page frame (both modes)

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ ■ Live · SEO agent   example.com   [G][O][A][P]     [SEO|GEO]   ● Live run · 06:42 elapsed · │
│                                                                   $0.07 spent (estimate)  ⛶  │
│ Live from this run's stored rows · Jev judgments are stored answers · nothing is projected   │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ RUN RAIL  validate ▸ crawl ▸ gsc_sync ▸ recommend ▸ summary   calls 41 · p50 820 ms · act 23 │
│ ▁▂▃▅▆▇ spend line                                    [step log ▾]                            │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ panels (section 4 for SEO, section 5 for GEO)                                                │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Header, left:** a 20 px logo square, then "Live · SEO agent" or "Live · GEO agent", then the project
  domain in mono. After that come the engine letter badges: lanes configured for the workspace (board
  `lanes[].state` not `setup_required`) plus lanes present in the run. A badge has `title` = lane label and
  no logo.
- **Header pill (exact strings):**
  - LIVE: `● Live run · 06:42 elapsed · $0.07 spent (estimate)`. The dot pulses (emerald). Elapsed is
    mm:ss, or h:mm:ss after an hour, ticking every 1 s from `run.startedAt`. Spend comes from
    `RunActivity.totals.spend` and is formatted as:

    | Case | Text |
    |---|---|
    | Priced and actual | "$0.07 spent (actual)" |
    | Priced, any estimate | "$0.07 spent (estimate)" |
    | Some calls unpriced | "$0.07+ spent (estimate; 3 calls unpriced)" |
    | `usd` null | "spend unknown (12 calls unpriced)" |
    | No calls | "$0.00 spent (no provider calls)" |

  - Pending: `○ Queued run · waiting to start`.
  - Finished while watching: `Run finished · 07:12 · $0.08 spent (estimate)`.
  - REPLAY: `▶ Replay of the run on 29 Sep 2026, 14:02 · real stored events · 10× speed`. Elapsed and
    spend at the playhead go in a second line (section 9).
  - Demo: the pill is prefixed with `Demo data - simulated run ·` and the `DemoBanner` renders under the
    header.
- **Honesty strip** (one line, muted, always visible): "Live from this run's stored rows · Jev judgments
  are stored answers · nothing is projected". Replay uses "Replay of stored rows" instead. GEO mode adds
  "API-sampled answers; consumer apps may answer differently". `labels[]` from the live endpoints and
  any reused endpoint appear as small chips; dedupe them.
- **Full screen (⛶):** the button calls `root.requestFullscreen()` on the Live view root, so the app
  sidebar and header are naturally hidden. It has `aria-pressed`, the label "Enter full screen" or "Exit
  full screen", and the keyboard shortcut F. Esc exits natively.
  - Fallback where the Fullscreen API is missing (iOS Safari): "focus mode". The root becomes
    `fixed inset-0 z-50 overflow-y-auto` with the page background, which covers the sidebar without
    changing the layout component. Esc or the same button leaves focus mode.
  - Focus mode remembers nothing across visits.
- **Run rail** (full width, about 120 px; both modes; data: `RunActivity`):
  - A horizontal Gantt of the agent's steps: `AGENT_STEPS[agent]` in order, without `*.summary`.
    - Each segment spans from the `step` item with status `started` to its terminal event.
    - Segment tone: completed = emerald, partial = amber, failed = rose, skipped = zinc hatched,
      running = sky with a pulsing right edge.
    - GEO lane steps (`geo_batch:<engine>`) are thin sub-bars under `geo.batch`, one per lane, each
      carrying its letter badge.
  - Provider-call ticks on the same time axis: `provider_call` items, plus `engine_answer` items in GEO.
    A tick is a 2 px mark; hover or focus shows "typesafe · 820 ms · $0.0012 (estimate)".
  - A cumulative spend line over the same axis, built from the `costUsd` of those items. It is drawn only
    while every point is priced. From the first unpriced call on, the line stops and a dashed marker reads
    "unpriced calls from here".
  - Counters on the right:
    - `calls N` (`totals.providerCalls`);
    - `p50 820 ms`, the median of the stored `latencyMs` of the run's calls (shown only when at least 5
      calls have a latency);
    - `Jev act 23 · flag 4 · drop 2` (`totals.decisions`);
    - SEO only: `pages 38 / 50`.
  - A **Step log** disclosure (closed by default on desktop, a tab on mobile). It is a terminal-style
    `role="log"` list of the `step` items: time offset "+00:41", step, status chip, and the stored message
    as plain text. This replaces the Okara "CMO decisions" log.

## 3. Data plan: one heartbeat, feeds on demand

The view never polls more than one heartbeat request plus one feed request per 2 s tick.

| Data | Endpoint (all existing unless marked NEW) | LIVE: when fetched | REPLAY |
|---|---|---|---|
| Run list | `GET /activity/current` | mount; then 10 s idle or 3 s active (existing cadence) | same |
| Heartbeat: steps, page reads, calls, decisions, answers, lanes, queued, totals, spend | `GET /runs/:runId/activity?after=` → `RunActivity` | page from start, then every 2 s while active (reuse `useRunActivity`) | paged to the end once |
| SEO feed: element judgments, queries, recommendations, GSC sync | **NEW** `GET /live/seo?runId=&after=` → `LiveSeoBoardResponse` | page from start; then right after a heartbeat page that contained `jev_decision` items or a `seo.*` `step` item; otherwise every 6 s while active | paged to the end once |
| GEO feed: structured answers, planned prompts, recommendations | **NEW** `GET /live/geo?runId=&after=` → `LiveGeoBoardResponse` | page from start; then right after a heartbeat page with `engine_answer` items or a `geo.proposals` step item; otherwise every 6 s | paged to the end once |
| GSC overview (daily, demand curve, totals) | `GET /seo/overview` → `SeoOverview` | mount; again after `seo.gsc_sync` reaches a terminal status | mount |
| Buyer labels for queries | `GET /seo/buyer-queries` (cache-only GET, never calls Jev) | mount; after `seo.recommend` terminal | mount |
| Internal link report | `GET /seo/internal-links` → `LinkSuggestionReport` | mount | mount |
| Competitor pages | `GET /geo/competitor-pages` → `CompetitorPageAssessment[]` | mount; every 5 s only while any is `queued`/`fetching` | mount |
| Answer coverage | `GET /geo/answer-coverage` → `CoverageResponse<AnswerCoverageRow>` | mount; GEO LIVE: after each `geo_batch:<engine>` terminal (at most 1 per 10 s) | mount |
| Citation evidence | `GET /geo/citation-evidence` → `CoverageResponse<CitationEvidenceRow>` | mount; after `geo.batch` terminal | mount |
| Skip factors | `GET /geo/pages/:pageId/skip-factors?promptId=&engine=` → `PageSkipFactors` | lazily, cached by (page, prompt, engine), at most 1 per 4 s per lane; SEO panel 07: at most 8 pages, once | same |
| Rewrite plans | `GET /geo/rewrite-plans` → `RewritePlansResponse` | mount; after `geo.proposals` terminal | mount |
| Engine board (model id, grounding, lane state) | `GET /geo/board` → `EngineBoardResponse` | mount; after `geo.batch` terminal | mount |
| One answer, in full | `GET /geo/observations/:id` → `GeoObservationDetail` | GEO panel 02, throttled to 1 per 4 s | 1 per 2 s of playback |

- Hidden tab: polling pauses, as in the existing `useRunActivity` visibility logic, and resumes with a
  catch-up page.
- 404 or 403 on the run stops everything and shows "This run is no longer available." (existing label).
- Rows from different sources are joined by id. Element rows `dec:<id>` are the same ids as `jev_decision`
  activity items, and answer rows `obs:<id>` are the same as `engine_answer` items. Each id is shown once:
  the feed row wins, and the activity item is only a "something arrived" signal for it.

## 4. SEO mode: 9 stage panels plus the run rail

Each panel is a `<section>` with a 2 px accent top border, a numbered chip ("01", in mono, a white number
on the accent background) and a title. The big counter sits on the right of the header, as in the
reference. The panel body scrolls inside the panel; the page never scrolls sideways.

```
desktop >= 1280 (12 columns, gap 16)
┌ Run rail ───────────────────────────────────────────────────────────────────────────── 12 ┐
┌ 01 Pages being read ──── 4 ┐┌ 02 Search Console ────── 4 ┐┌ 03 Queries classified ─── 4 ┐  h 300
┌ 04 Every SEO element, judged one by one ─────── 6 ┐┌ 05 Competitor pages worth adapting ── 6 ┐  h 460
┌ 06 Do our pages answer what people ask AI? ──── 6 ┐┌ 07 How our pages show up in AI answers 6 ┐  h 460
┌ 08 Internal links judged ───────────────────── 6 ┐┌ 09 Recommendations drafted and checked 6 ┐  h 380
```

Accent tokens are Tailwind classes that already exist in this app, with `dark:` variants. Each accent
has three uses: the chip background, the top border, and the counter text.

| Panels | Accent |
|---|---|
| 01–04 and 08 | `sky-700` / `dark:sky-400` |
| 05 | `amber-600` / `dark:amber-400` |
| 06 | `emerald-700` / `dark:emerald-400` |
| 07 | `rose-600` / `dark:rose-400` |
| 09 | `zinc-700` / `dark:zinc-300` |

Panels 05–07 show project-level state, not something this SEO run produced. They carry a caption: "From
your latest GEO data (29 Sep), not part of this run".

### 01 Pages being read (live crawl; Ryze "Now reading" plus the Borja crawl cards)
- **Counter:** `38 / 50 pages` (`totals.pagesRead` / `totals.pagesPlanned`, "of the 50-page limit").
- **"Now reading" card:** shown only while `nowReading` is set. It holds the URL path in mono and the
  host, and crossfades to the next URL. Its caption reads "latest stored read; may trail the crawler by up
  to 10 pages", because snapshots are batched.
- **Progress bar:** read / planned. The remaining part shows animated stripes only while the
  `seo.crawl` step is running.
- **Ticker:** the last 8 `page_read` items as small cards. Each card has the path, and the detail
  `"200 · 1,240 words"` or `"Skipped: robots_disallowed"`. Status tones: ok = neutral, warn = amber,
  error = rose. A new card slides in at the top.
- **Footer:** skipped reasons counted from `page_read` details that start with "Skipped: " (the format
  documented in docs/api.md), for example "3 skipped: 2 robots_disallowed, 1 js_rendered".
- **States:**
  - No crawl in this run: "This run did not crawl." When the step was skipped, its message comes from the
    `seo.crawl` skipped step item.
  - Unverified project: the step message, with a link to Settings.

### 02 Search Console sync (demand curve)
- **Header chips:** source ("Search Console API", "CSV import" or "Demo"), from `LiveGscSync.source`;
  status; "Rows 4,812 of 25,000" with a "Truncated at cap" chip when `truncated`; and the windows
  "1–28 Sep vs 4–31 Aug".
- **Body:** a tab pair, **Clicks per day** (`SeoOverview.daily`, existing `LineChart`) and **Demand
  curve** (`SeoOverview.demandCurve`, existing `DemandCurveChart`). Measured totals sit beside it:
  clicks, impressions, CTR and position for the current and previous windows, with the delta as a
  measured difference, not an arrow-projection.
- **Counter:** `12,480 clicks`, current window, with the window as the counter's suffix.
- **Freshness:** when `SeoOverview.syncedAt` is not this run's `gscSync.syncedAt`, the caption reads
  "From an earlier sync (27 Sep)".
- **Motion:** when the `seo.gsc_sync` step reaches a terminal status, the overview is refetched once and
  the line draws left to right in 600 ms. Counters tween from the old stored value to the new one.
- **States:**
  - `SeoOverview.state` `setup_required`: `EmptyState` "Search Console not connected", with a link to
    Integrations. No chart, no zeros.
  - Sync `failed`: `StateBanner` danger, with the clipped error.

### 03 Queries classified by Jev
- **Rows:** `LiveSeoQueryRow`, grouped by `queryKey`. Each query is one line, and its cells fill as its
  answers arrive.

  | Column | Content |
  |---|---|
  | Query | Plain text, 1-line clamp, full text in `title` |
  | Clicks · Impr. · Pos. | Measured, from `gsc` with `basis`; header tooltip shows the window |
  | Relevant? | `seo.query_relevance` band chip: yes "Relevant", no "Not relevant", middle "Unsure" |
  | Intent | `seo.query_intent` choice ("transactional", "informational", …) |
  | Buyer? | From the cache-only `GET /seo/buyer-queries` (`BuyerQueryRow.intent`) matched by query text; "—" when not classified |

- **Jev chip:** each Jev cell carries one, for example "Jev act · 0.92" (Noul) or "Jev act ·
  transactional · conf 0.88" (Choice). A flag tier shows amber with "unsure".
- **Counter:** `214 relevant` (`totals.queries.relevance.yes`), with the second line "of 260 queries
  classified".
- **Not shown:** search volume and difficulty (no source). The relevance gate's "drop" rows are shown as
  "Dropped (not relevant)", not hidden, so the user sees what was filtered.

### 04 Every SEO element, judged one by one (Rankie panel 01)
- **Subtitle:** "Jev answers one narrow question per element; code turns the stored answer into keep,
  change or review."
- **Counter:** `1,284 to change`, from `totals.elements.change`, with the second line "of 3,910 judged
  in this run".
- **Columns** (`LiveSeoElementRow`):

  | Column | Content |
  |---|---|
  | Page | `pagePath`, else `targetLabel`; mono, ellipsis, full value in `title` |
  | Element | `element` |
  | Now → proposed | `now` (muted). When `proposed` is set: `now` struck through, "→", then `proposed` in medium weight. Without `proposed`, only `now`, with no arrow. Both plain text, 1-line clamp |
  | Avg pos. | `gsc.position`, one decimal, prefixed "≈" for `page_rows`; "—" when null |
  | Clicks | `gsc.clicks` (measured; no "+"; "≥" for `query_page_rows` sums, a lower bound). The window is a panel caption ("Search Console 1–28 Sep · ≈ = page aggregate") from the first row's window; the header title carries the full wording |
  | Jev | "Jev act · 0.92", "Jev flag · 0.55", or "Rule · fact" for rule rows. Tooltip: `verdictBasis`, provider and model |
  | Verdict | Square chip plus word: Keep (emerald), Change (rose), Review (amber) |

- Rows with Change have a 2 px rose left border, as in the reference.
- **Action rows:** a row with `role: "action"` shows only when no element row with the same
  `candidateKey` is present. Otherwise its chosen action shows as a small "Next: Title + meta" note under
  the element row.
- **Order:** time order, as stored: resolved rows with the newest at the bottom, then (replay) the next
  pending rows under them (section 9), resolving in place. The panel body follows the first pending row
  (else the newest row) about 55% down, unless the viewer scrolled that panel in the last 10 s. Rows
  revealed on the same tick enter staggered (70 ms apart, presentation only).
- **Live pending:** only while the `seo.recommend` step has started and has not ended. At most 3 skeleton
  rows at the bottom, with no page or element text, labelled "Waiting for the next stored judgment"
  (shimmer).
- **Filters** (chips above the table): All, Change, Keep, Review, and an element select.
- **Row action:** click or Enter opens the recommendation (`recommendationId`). Without one, the
  decision detail opens (existing `DecisionLog` drawer pattern).

### 05 Competitor pages worth adapting (Rankie panel 02)
- **Subtitle:** "Only pages you approved. Checks are measured or Jev Noul; we adapt structure, never copy
  text."
- **Counter:** `3 to adapt` (assessments with `verdict === "adapt"`).
- **Data:** `CompetitorPageAssessment[]`.

  | Column | Content |
  |---|---|
  | Site | `host` (not an inferred brand) |
  | Page | URL path, opened via `ExternalUrl` |
  | Answer · Depth · Proof · Schema · Fresh | One block bar per check (`answer_first`, `depth`, `proof`, `schema`, `freshness`), drawn from `checks[].status`: present = 4 blocks, partial = 2, missing = 0 (an outline), unknown = hatched. Jev checks show "Noul 0.82 · act" in the tooltip |
  | Cited in | "4 stored answers" (`citedIn.length`), plus engine letter badges from `citedIn[].provider` |
  | Verdict | Adapt (emerald), Skip (zinc), Review (amber); "Assessing…" shimmer only for `queued`/`fetching` |

- **Empty state:** "No approved competitor pages yet." It links to the AI engines board, where cited URLs
  can be approved.

### 06 Do our pages answer what people ask AI? (Rankie panel 03)
- **Counter:** `7 of 18` with the suffix "approved prompts have no matching page". The percentage is a
  secondary note ("39%"). The ratio is the rows with `matchedPage === null` over all rows.
- **Data:** `AnswerCoverageRow`.

  | Column | Content |
  |---|---|
  | Prompt | `text`. Header is "Approved prompt", not "question people ask" |
  | Engines asked | `providersRun` (replaces "Asked 1,300") |
  | Our best page | `matchedPage.url` path, or "—" |
  | Match | Thin bar of `matchedPage.score` with "overlap 0.46" and a method tag ("engine search query" or "title/H1 overlap"); tooltip `basis` |
  | AI cites | `aiSource`: `your_site` = own host in emerald; `other_site` = `topOtherSource.host` plus a source-type tag; `none` = "No sources"; `not_run` = "Not asked" |
  | Verdict | `gap`: `covered` "Cited", `improve` "Page not cited", `create_page` "No page", `check` "Check" |
  | Next step | `create_page` "Consider a new page", `improve` "Improve the page" (links to the rewrite plan when one exists), `covered` "—", `check` "Check this yourself" |

- Rows are sorted create_page, improve, check, covered. Rows that change on refetch move with FLIP
  (section 8).

### 07 How our pages show up in AI answers (replaces Rankie panel 04 "How likely is each page to be cited?")
- **Counter:** `5 of 18` with the suffix "answered prompts cite our site". It counts the coverage rows with
  `aiSource === "your_site"` over those with `aiSource !== "not_run"`.
- **Rows:** first the `CitationEvidenceRow` pages, then the coverage matched pages with `gap === "improve"`
  as "Cited in 0".

  | Column | Content |
  |---|---|
  | Page | Path |
  | Cited in | `citedCount` answers, plus engine badges (`providers`) and "last 29 Sep" |
  | Answer first · Facts · Sources · Schema · Fresh | Five status dots from `PageSkipFactors.factors` (`answer_first`, `entity_facts`, `sources_cited`, `faq_schema`, `freshness`), with "Measured" or "Heuristic" tags in the tooltip and `measured` text, for example "answer at word 180" |
  | Cited alongside | Up to 3 hosts from `citedAlongside` |
  | Next step | `nextStep` plus `reason` (stored code rule); else "First missing: Sources cited" (the first `missing` factor in `FACTOR_ORDER`) |

- Skip factors are fetched for the first 8 visible pages only (lazy, cached).
- **Removed:** Chance bar, "Now %", "After %". There is no likelihood of any kind.

### 08 Internal links judged (Borja link map)
- **Counter:** `12 suggested` (suggestions with status `suggested`), with the second line "3 for review
  · 4 orphan pages".
- **Focus card:** the latest element row of this run with `element === "Links"` and a `linkSuggestionId`,
  joined to `LinkSuggestionReport.suggestions` by id. It shows:
  - source path → target path;
  - the sentence as plain text, with the anchor wrapped in `<mark>`;
  - a role chip ("Next step", "Deeper detail", …);
  - "Jev act · should-exist 0.91".
- **Destination buckets:** the top 6 targets in the report, grouped by `target`. Each is a small stack of
  mini cards with a "+N" count beyond 3, and an orphan badge when `target.orphan`. When a row of this run
  arrives for a bucket, a highlight box moves to it and the bucket shows "+1 judged in this run".
- **No link rows in this run:** the report renders statically with the caption "From the link run on
  27 Sep (not part of this run)". No report: `EmptyState` "No internal link run yet", with a link to
  Internal links.

### 09 Recommendations drafted and checked (pipeline)
- **Pipeline bar** (replaces Okara's Read→Decide→Draft→Publish), from `totals.pipeline`. Five stations,
  each with a count:
  - Candidates;
  - Judged by Jev;
  - Drafted (`created`);
  - Awaiting approval (`byStage.awaiting_approval`);
  - Implemented (`byStatus.implemented`).
- Under the bar, rejected reasons are chips: "12 low fit · 3 duplicate · 1 budget"
  (`rejectedByReason`, labels from `DecisionLog.reasonLabel`).
- **Cards:** `LiveRecommendationRow`, newest first. Each card has:
  - target, issue type, and the action (2-line clamp);
  - the snippet, in mono, when present;
  - "Priority 0.62 (priority-v3)", code-computed, with its version;
  - effort and uncertainty chips, and the tier badge;
  - "3 evidence items" and the writer model;
  - **Open** (`/recommendations/:id`).
  Publishing is never offered.
- **Draft checks:** shown only if stored for the run. Today draft checks are user-triggered and have no
  run id, so no chip is shown.

## 5. GEO mode: engine columns plus 5 panels

```
desktop >= 1280: lanes in repeat(auto-fit, minmax(380px, 1fr)), so 3 columns at 1280 and 4 at >= 1600
┌ Run rail (lane sub-bars per engine) ─────────────────────────────────────────────────── 12 ┐
┌ [O] OpenAI Responses API ─┐┌ [A] Anthropic Messages API ┐┌ [G] Gemini API · google_search ┐
│ header + gauge + 4 stats  ││ …                          ││ …                               │  h 150
│ A answers strip  ▸▸▸ [Q]  ││                            ││                                 │  h 150
│ B our best page, skipped  ││                            ││                                 │  h 230
│ C approved cited page     ││                            ││                                 │  h 200
│ D rewrite plan (manual)   ││                            ││                                 │  h 210
└───────────────────────────┘└────────────────────────────┘└─────────────────────────────────┘
┌ 01 Prompt × engine ──────────────────────── 6 ┐┌ 02 Inside the latest answer ──────────── 6 ┐  h 420
┌ 03 Cited instead, this run ─── 4 ┐┌ 04 Do our pages answer what people ask AI? ─────────── 8 ┐  h 420
┌ 05 Proposals drafted and checked (the SEO 09 component, agent geo) ─────────────────────── 12 ┐  h 300
```

**Columns.** There is one column per `RunActivity.lanes[]` entry, in board order (built-in engines, then
custom). An unconfigured lane that is not in the run gets no column. The header's letter badges show
what is configured. Model id, grounding, `state` and `stateDetail` come from the board lane with the same
`provider`.

### Lane header (Ryze header row)
- Letter badge and lane label. The second line is `model` (mono) · `groundingMode` · lane state:
  - `asking`: pulsing dot, "Asking";
  - `queued`: "Queued";
  - `done`: "Done";
  - `idle`: "Idle".
  It never says "Asking and reading" unless the state is `asking`.
- **Gauge:** the existing `CitationGauge`, fed with this run's lane `Ratio`: `cited / (cited + named +
  missing)` from `LiveGeoBoardResponse.totals.lanes[]`, with "23 of 98 answers" printed under it.
  - Custom lanes (amended 2026-10-02): when this run has answers with provider-reported sources
    (`totals.lanes[].grounded > 0`) the gauge is citation rate over those answers, `cited / grounded`, under
    "Citation rate, this run (answers with sources)", and sections B-D show as for any engine; otherwise it
    shows the mention rate, `(cited + named) / valid`, under "Mention rate (no sources returned)".
  - With no valid answers yet, the gauge is empty and reads "No answers yet".
- **Stats row** (Ryze's five stats, honest):

  | Stat | Source |
  |---|---|
  | Answered | `ActivityLane.done` / `planned` ("41 of 60"), with "last 377 ms" from `lastLatencyMs`; replaces Prompts/sec |
  | Citing us | lane `cited` |
  | Naming us, not citing | lane `named` |
  | Skipping us | lane `missing` |
  | Cited instead | lane `citedInstead.host` plus "in 31 answers" |
  | Cost so far | lane `cost` via the existing `costLabel` (Actual / Estimate / Unknown) |

- Counters tween between received values.

### A · Answers strip (Ryze row A)
- **Title:** "`41` approved prompts answered by <lane> in this run", with "of 60 planned" and, on the
  right, "Live from stored answers" or "Replay".
- **Cards:** `LiveGeoAnswerRow` of this provider, newest at the right. The strip is horizontal, with
  overflow inside the column (`role="list"`, scroll snap). It keeps the last 12 cards; older ones remain in
  panel 01. The existing `FeedCard` is reused through an adapter (`LiveGeoAnswerRow` → `EngineFeedItem`;
  `failed` maps to a "Failed" chip). A card shows:
  - `latencyMs` ("190 ms"; hidden when null);
  - an outcome chip: Cited, Named, Missing, Failed, or "Analysing…" with shimmer when `outcome === null`;
  - the prompt (2-line clamp);
  - "#2 in list", only when `position` is set;
  - the sentiment category and method (no %);
  - "Cited instead: host via review site".
  Clicking a card opens `ObservationDrawer`.
- **Queued card:** the first `RunActivity.queued` entry for this provider, at the right edge at 50 %
  opacity. It shows "Queued" and the prompt text, which is known, and a shimmer on the empty stat line.
  The queued card exists only while the run is active.

### B · Our best page for a prompt <lane> answered without us (Ryze row B)
- **Title:** "`9` prompts <lane> answered without us · 6 with a matching page". The counts come from this
  lane's `missing` and `named` rows and their `matchedPage`.
- **Card:** the newest such row with a `matchedPage`. It shows:
  - "Our best page", URL in mono, and the match method;
  - "For “<prompt>” <lane> cited <host> via <source type>";
  - "Page: 1,240 words · updated 8 mo ago", from `PageSkipFactors.page.wordCount` and the freshness
    factor's `measured`;
  - one row per factor (the existing `FactorRow`): label, a status-level bar (present = full, partial =
    half, missing = empty outline, unknown = hatched; never a percentage), and the `measured` text in
    place of the %.
  The card crossfades when a newer skipped row arrives.
- **Removed:** "x/10 citability" and "→ Not citable, creating page". They are replaced by links: "See
  rewrite plan" (D) and "Draft check this page". The app creates nothing.
- **No matched page:** "No page of ours matches “<prompt>”", plus the cited-instead line and "Consider a
  new page" (links to Recommendations).
- **Caption:** "Measured from the crawl of 29 Sep · observable differences, not causes."

### C · Approved page <lane> cited (Ryze row C)
- **Data:** `CompetitorPageAssessment` with `citedIn[].provider === lane` (existing
  `assessmentsForEngine`). It prefers the assessment whose `url` equals this lane's latest
  `citedInstead.url` in the run, else the newest `assessed` one.
- **Card** (`AssessmentCard`):
  - host and source type ("Review site");
  - the URL;
  - "What their page has (observed)", from `reasons[]` as bullets. The header is not "why the engine cites
    it", because nothing here is causal;
  - the `CheckRadar` from check statuses (decorative), with `CheckTable` behind "Details";
  - the verdict chip Adapt / Skip / Review.
- **Not approved yet:** `ApproveCandidate` for that URL, with the existing confirm text. Demo projects
  show "Not available in the demo".
- **Count line:** "`2` approved pages cited by <lane>".
- **Removed:** "7.6/10" and brand-name guessing.

### D · Rewrite plan for a page <lane> skips (Ryze row D)
- **Data:** a `RewritePlan` with `engine === lane`. It prefers the plan for B's page, else the first.
- **Card** (`RewritePlanCard`):
  - URL and `question`;
  - the checklist from `items[]` (done ✓, todo ☐, n/a –, unknown ?) with evidence;
  - "Clicks 12 · Impressions 1,268 (1–28 Sep)" from `gsc`;
  - "Cited in 3 stored answers" from `aiCitations`.
- **Title:** "`4` rewrite plans for pages <lane> skips · Manual plan · Publishing: manual (not
  connected)".
- **Removed:** Traffic, Conv. rate, Revenue, the "→ projected" arrows, "N clusters", and "N of our pages
  rewritten". Nothing is rewritten by the app.

### 01 Prompt × engine (Hall-style heatmap)
- **Rows:** `plannedPrompts`. Columns are the lanes. Each cell shows the outcome of the run's answer for
  that pair: C, N, M or F with a tone. The letter always appears beside the colour.
- **Pending cells:** shimmer only while the run is active and the lane is `queued`/`asking`.
- **After the run:** cells with no answer are hatched "Not run".
- **Interaction:** clicking a cell opens `ObservationDrawer`.
- **Accessibility:** a real `<table>` with `th scope`, plus a caption "Outcome per approved prompt and
  engine, this run". It shows the first 40 prompts and scrolls vertically inside the panel.

### 02 Inside the latest answer (Ira's AI Overview screenshot)
- **Data:** `GeoObservationDetail` for the newest arrived (or, in replay, revealed) answer, throttled.
- **Shows:**
  - lane badge, model, prompt, and "stored 14:02:31";
  - `rawAnswer`, plain text, the first 1,200 characters, with brand spans (`brands[].spans`) as `<mark>`
    (own brand emerald, others zinc);
  - citation chips in `position` order, own site highlighted, each with a `sourceType` tag;
  - "Engine searches": `searchQueries`, or "Not exposed by this provider" when null.
- **Caption:** "API-sampled answer".
- **Motion:** crossfade, 200 ms.

### 03 Cited instead, this run
- **Data:** a bar list of hosts, counting this run's answers whose `citedInstead.host` is that host (first
  non-own citation per answer). Top 8, each with a source-type tag and letter badges for the lanes where
  it appeared.
- **Counter:** the top host's count. **Caption:** "First non-own citation per answer, this run".
- **Motion:** bars grow by width tween when counts change.

### 04 Do our pages answer what people ask AI?
- **Data:** the same component as SEO panel 06.
- **Live behaviour:**
  - When a prompt has queued pairs in the active run, its AI cites and Verdict cells show "Asking…"
    (shimmer).
  - When a `LiveGeoAnswerRow` for the prompt arrives, its AI cites cell updates at once from that row.
  - The verdict updates with the next coverage refetch: after a lane step ends, at most 1 per 10 s.

### 05 Proposals drafted and checked
- The SEO 09 component, with `agent: "geo"` rows and `totals.pipeline` from the GEO feed.

## 6. `LIVE_SEO_ELEMENT_MAP` (src/worker/live/elements.ts)

It is the one exported constant that maps stored judgments to elements. It is pure code, with no database
and no provider calls, and is tested in `tests/live-elements.test.ts`. Verdicts are computed from the
STORED tier, the raw stored answer, and a per-question polarity. Jev never supplies verdict text, and
nothing is re-asked.

| Stored row | Element | Verdict rule |
|---|---|---|
| `seo.title_matches_query` | Title | Noul. Act and yes = keep, act and no = change, flag or drop = review |
| `seo.meta_matches_query` | Meta | same |
| `seo.answer_is_direct` | Intro | same |
| `seo.schema_content_match` | Schema | same |
| `seo.covers_topic#t<n>` | Topics | same |
| `seo.outdated_information` | Freshness | Noul, inverted: act and yes = change |
| `seo.thin_content#e<n>` | Content | Noul, inverted |
| `seo.page_overlap#<k>` | Duplicate | Noul, inverted |
| `seo.intent_page_fit` | Intent | Choice. fits = keep, mismatch = change, partial_fit or insufficient_context = review; flag or drop = review |
| `seo.page_action` | Page | Choice. keep = keep, update, merge or remove = change, insufficient_context = review |
| `seo.action_choice` (role `action`) | by option | rewrite_title_meta → Title + meta, improve_intro_answer → Intro, add_section → Section, add_comparison_or_spec_table → Compare table, add_internal_links → Links, fix_structured_data → Schema, fix_canonical_or_indexing → Canonical, consolidate_duplicate → Duplicate, new_page_candidate → New page (all change); no_action → Page, keep. Demo fixture options (`add_offer_markup`, `rewrite_snippet`, `add_intro`, `none`, `insufficient_context`) are mapped too. Unknown option = review |
| Question-less row with `answer_json.kind = "internal_link_suggestion"` | Links | The suggester's stored tier (act = change, else review) and Noul `shouldExist`, shown as "links.should_exist" |
| Audit finding of the run's crawl | `rules` map (Title, Meta, H1, Headings, Canonical, Indexing, Status, Links, Content, Duplicate, Schema, Intro, Sitemap) | fact = change, heuristic = review |
| `seo.query_relevance`, `seo.buyer_query`, `seo.buyer_ready`, `seo.query_intent` | none; query rows (panel 03) | Band: act → yes/no (noul ≥ 0.5), flag → middle, else null |
| Anything else (`seo.query_page_relevance`, `seo.issue_severity`, `seo.pillar_fit`, technical candidates without a question, `AI-SEARCH-CRAWLER-BLOCKED`) | not an element | Counted in the pipeline totals only |

Where the other row fields come from, for the builder (`src/worker/live/seo.ts`):

| Field | Source |
|---|---|
| Target (first match wins) | 1. the candidate's recommendation (`recommendations.dedup_key = decision_records.candidate_key`, same run), via `target_json`: url gives the path, template gives "Template: <name> (N URLs)", site gives "Site"; 2. `parseCandidateKey(answer_json.candidate)`, the first http(s) segment; 3. the finding's `url` or `template`; 4. "Unknown target" |
| `pageId` | `pages` by normalized URL (`normalizeUrl`) |
| `now` | The element's stored value from the page's snapshot in this run's crawl (else the latest snapshot), plain text clipped to 160 |
| `proposed` | `recommendations.suggested_snippet` of the candidate (one per candidate, shown on its change rows) |
| `gsc` | `latestUsableSync` + `pageMetrics` (seo/gsc/aggregate.ts), current window, page rows; `basis` as returned |
| Query text (query rows) | `answer_json.query`, else `parseCandidateKey(...).query`. A `seo.query_intent` row with no recoverable query text is skipped. The cursor still advances over it |

`now` by element:

| Element | Snapshot value |
|---|---|
| Title | `title` |
| Meta | `meta_description` |
| H1 | `h1_json[0]` |
| Headings | the first 3 `headings_json` |
| Intro | `first_paragraph` |
| Schema | `jsonld_types_json` joined ("Product, Offer") |
| Content | "1,240 words" |
| Freshness | `last_updated` ("Updated 2025-03-02") |
| Canonical | `canonical` |
| Indexing | `robots_meta` |
| Status | `status_code` |
| Intent | the page type ("product page") |
| Links | "4 internal links in" (the link suggestion's `target_inlinks`) |
| Topics, Page, Section, Compare table, Duplicate, New page, Sitemap | null |

## 7. Every video element → data source, honest replacement, or dropped

Legend:
- **D** = real data source (table, endpoint and field).
- **R** = honest replacement.
- **X** = dropped (with the reason).

### Headers (both videos)

| # | Video element | Treatment |
|---|---|---|
| 1 | Logo square + "Jev for SEO and GEO" | R: logo square + "Live · SEO agent" / "Live · GEO agent" + project domain |
| 2 | Engine logos in the header | R: letter badges (`engineGlyph`) for configured lanes and lanes in the run; logos are trademarks |
| 3 | "● Simulated run · 6.9 s elapsed · $0.08 spent" | D: `RunActivity.run.startedAt`/`elapsedMs`, `totals.spend` → "● Live run · 06:42 elapsed · $0.07 spent (estimate)". Replay: "▶ Replay of the run on <date> · real stored events · N× speed". Demo prefix |
| 4 | Ryze subtitle "Asks ChatGPT, Claude and Gemini … rewrites the pages" | R: "Asks the configured AI engines (API-sampled) your approved prompts and records who they cite." It does not say "rewrites the pages", because publishing is manual |

### Rankie 01: Every SEO element, judged one by one

| # | Video element | Treatment |
|---|---|---|
| 5 | Panel "01" chip, title, subtitle | R: same title; subtitle "Jev answers one narrow question per element; code turns the stored answer into keep, change or review" |
| 6 | Counter "23,239 to change" ticking up | D: `LiveSeoBoardResponse.totals.elements.change`, "of N judged in this run". Tweens only between received values |
| 7 | Page column | D: `LiveSeoElementRow.pagePath` / `targetLabel` |
| 8 | Element column (URL, Title, Meta, H1, Intro, Images, Compare, FAQ, Reviews, Schema, Canonical, Links) | D: `element` via `LIVE_SEO_ELEMENT_MAP`. X: URL slug, Images (alt), Reviews and FAQ: no stored question or rule judges them |
| 9 | "Now → proposed" (strikethrough → bold) | D: `now` (page_snapshots) → `proposed` (recommendations.suggested_snippet). The arrow appears only when drafted |
| 10 | Rank "#11" | R: "≈ 11.2" avg position from GSC (`gsc.position`, `basis`); "—" without GSC |
| 11 | Clicks "+310" (projected) | R: measured `gsc.clicks` for the window, header "Clicks (GSC, 1–28 Sep)"; no "+" |
| 12 | Confidence "0.95" | R: "Jev act · 0.92" (stored tier + raw Noul); Choice: "Jev act · update · conf 0.87"; rules: "Rule · fact" |
| 13 | Keep / Change / "Reading…" chips | D: `verdict` (code). "Reading…" only for replay rows not yet reached, or up to 3 live skeletons while `seo.recommend` runs |
| 14 | Red left border on Change rows | D: same, from `verdict === "change"` |
| 15 | Blue-tinted resolved block, blurred pending rows | R: arrival highlight fade; blur only on replay-pending rows |
| 16 | List scrolling up continuously | R: time order, newest at the bottom with pending rows under it; the panel follows the newest row only when a stored row arrives or is revealed (never on a timer), paused for 10 s after the viewer scrolls |

### Rankie 02: Pages and SEO techniques to steal from competitors

| # | Video element | Treatment |
|---|---|---|
| 17 | Title "…to steal from competitors" | R: "Competitor pages worth adapting" |
| 18 | Subtitle "…picks the ones worth copying" | R: "Only pages you approved. Checks are measured or Jev Noul; we adapt structure, never copy text." |
| 19 | Counter "13 to build" | D: count of `CompetitorPageAssessment.verdict === "adapt"` → "3 to adapt" |
| 20 | Competitor (brand name) | R: `host`; no brand inference |
| 21 | Page | D: assessment `url` path |
| 22 | Answer / Depth / Proof / Schema / Fresh dot bars | D: `checks[].status` for those keys as block levels; Jev Noul + tier in the tooltip |
| 23 | Google rank "#2" | X: no rank source for competitor pages |
| 24 | ChatGPT rank "#2" | X: no source. R: engine letter badges from `citedIn[].provider` |
| 25 | Cited "11%" | R: "Cited in N stored answers" (`citedIn.length`) |
| 26 | Steal / Adapt / Skip / "Scoring…" | D: Adapt / Skip / Review (`verdict`); "Assessing…" only for `queued`/`fetching` |

### Rankie 03: Do our pages answer what people ask AI?

| # | Video element | Treatment |
|---|---|---|
| 27 | Title | Kept |
| 28 | "41% of questions we have no page for" | D: "7 of 18 approved prompts have no matching page" (`AnswerCoverageRow.matchedPage === null`), % secondary |
| 29 | Question column | D: `AnswerCoverageRow.text` (the user's approved prompts) |
| 30 | Asked "1,100" | X: no question-volume source. R: "Engines asked" = `providersRun` |
| 31 | Our best page | D: `matchedPage.url` |
| 32 | Match bar % | D: `matchedPage.score` labelled "overlap 0.46" + method; not a quality score |
| 33 | AI cites (brand / domain) | D: `aiSource` + `topOtherSource.host` / own host; "Not asked" for `not_run` |
| 34 | Verdict No page / Weak answer / Answered / "Matching…" | D: `gap` → No page / Page not cited / Cited / Check; "Asking…" only for prompts queued in an active GEO run |
| 35 | Next step "Write guide / Answer at top / Add proof / Write versus" | R: from `gap` only ("Consider a new page", "Improve the page", "Check this yourself"); X: content-type suggestions (no stored source) |

### Rankie 04: How likely is each page to be cited?

| # | Video element | Treatment |
|---|---|---|
| 36 | Title | R: "How our pages show up in AI answers" |
| 37 | "8% cited now" | D: "5 of 18 answered prompts cite our site" (`aiSource`) |
| 38 | Page | D: `CitationEvidenceRow.url` + matched-but-not-cited coverage pages |
| 39 | Chance bar, "Now %" | X: a prediction. R: "Cited in N answers" (`citedCount`) + engine badges + last cited date |
| 40 | Answer / Facts / Source / Schema / Fresh dots | D: `PageSkipFactors.factors` statuses (measured / heuristic) |
| 41 | "Fix this first" | R: `CitationEvidenceRow.nextStep` + `reason`, else "First missing: <factor>" (measured) |
| 42 | "After %" | X: a projection [A11] |
| 43 | Pink tint and bars filling | R: the accent only; dots change state on refetch |

### Ryze engine columns

| # | Video element | Treatment |
|---|---|---|
| 44 | Engine logo + "ChatGPT" | R: letter badge + lane label (`LANE_LABELS`, e.g. "OpenAI Responses API · web_search") |
| 45 | "OpenAI · gpt-5.2 · web · Asking and reading" | D: board `model` (exact id) · `groundingMode` · `ActivityLane.state` ("Asking" only when asking) |
| 46 | Citation-rate gauge "21%" | D: this run's `cited / (cited+named+missing)` from `totals.lanes[]`, with n of m; custom lanes use `cited / grounded` when the run returned sources, else mention rate |
| 47 | Prompts / sec "82" | X: throughput is not a user metric. R: "Answered 41 of 60 planned" (`ActivityLane.done/planned`) + last latency |
| 48 | Answers citing us | D: lane `cited` |
| 49 | Answers skipping us | D: lane `missing`; plus "Naming us, not citing" = lane `named` |
| 50 | "Cited instead · 21% Peptide Sciences" | D: lane `citedInstead.host` + "in N answers" (host, not brand) |
| 51 | Cost so far "$0.162" | D: lane `cost` (Actual / Estimate / Unknown) |
| 52 | A "771 buyer prompts run against ChatGPT" | D: "41 approved prompts answered by <lane> in this run · of 60 planned" |
| 53 | Card latency "190 ms" | D: `latencyMs` (hidden when null) |
| 54 | Missing / Named chip | D: `outcome`; "Analysing…" for stored-but-unanalysed answers |
| 55 | Card prompt | D: `promptText` |
| 56 | Share "0%" | X: a single answer has no share |
| 57 | Position "#18" | D: `position` only when `list_rank` exists ("#2 in list"); else not shown |
| 58 | Sentiment "45%" | R: sentiment category + method; no % |
| 59 | Greyed "Queued" card | D: `RunActivity.queued` entry for the lane (prompt text known); exists only while the run is active |
| 60 | "Live feed" label, strip sliding left | R: "Live from stored answers" / "Replay"; a card slides in only when an answer arrives |
| 61 | B "237 of our pages analyzed for why ChatGPT skips them" | R: "9 prompts <lane> answered without us · 6 with a matching page" |
| 62 | "Now reading · directpeptides.com" + URL | R: "Our best page" + `matchedPage.url`; the engine is not reading our page, so no "Now reading" |
| 63 | "For 'X' ChatGPT cites Swiss Chems via health" | D: `promptText` + `citedInstead.host` + source type |
| 64 | "Page: does not exist yet · words 354 · last edit 26 mo" | D: `PageSkipFactors.page.wordCount`, freshness `measured`; "No page of ours matches" when `matchedPage` is null |
| 65 | Factor bars with % | R: status-level bars + `measured` text (`SkipFactor`); no percentages |
| 66 | "2.8/10 citability" | X: no aggregate score |
| 67 | "→ Not citable, creating page" | X: nothing is created automatically. R: "See rewrite plan" / "Draft check this page" links |
| 68 | C "313 competitor pages read for why ChatGPT cites them" | R: "2 approved pages cited by <lane>"; only user-approved URLs are read |
| 69 | Brand / Type / Page | D: `host` / `sourceType` / `url` |
| 70 | "Why the engine cites it" bullets | R: "What their page has (observed)" = `reasons[]`; not causal |
| 71 | Radar chart | D: `CheckRadar` from `checks[].status` (decorative) + `CheckTable` |
| 72 | "7.6/10" | X: no score |
| 73 | D "246 of our pages rewritten so ChatGPT cites them" | R: "4 rewrite plans for pages <lane> skips · Manual plan · Publishing: manual (not connected)" |
| 74 | Rewrite card URL + title | D: `RewritePlan.url` + `question` |
| 75 | Checklist ticking item by item | D: `items[].status` + `evidence`; ticks only when a status changes between fetches |
| 76 | Traffic / Conv / AI citations / Revenue with arrows | D: `gsc` clicks and impressions (window) + `aiCitations.count`; X: conversion, revenue and arrows (not connected; projections) |
| 77 | "9 clusters" | X: no clustering source |
| 78 | Per-engine column tints (green / orange / blue) | X: no vendor colours; neutral columns |
| 79 | Ghosting crossfades of text in C | R: a single 200 ms crossfade when the shown assessment changes |

### Research extras

| # | Element | Treatment |
|---|---|---|
| 80 | Okara "CMO decisions" log | D: run-rail Step log (`step` items) |
| 81 | Okara "Strategy every agent reads first" (context docs, one highlighted) | X (v1): no stored step names the document it read; listing them as "being read" would be invented |
| 82 | Okara "fit 78%" | X: no such stored value |
| 83 | Borja judgments/sec gauge | X. R: "calls N · p50 820 ms" from stored latencies |
| 84 | Borja coin-stack spend | R: the cumulative spend line, only while every point is priced |
| 85 | Borja "Edition of <date> · Speed 1× real · Stop" | D: the replay label and controls (section 9) |
| 86 | Borja moving highlight box and growing destination stacks | D: panel 08 buckets with "+1 judged in this run" from arriving Links rows |
| 87 | Hall prompt × engine heatmap | D: GEO panel 01 |
| 88 | Ira AI Overview citation chips | D: GEO panel 02 (`GeoObservationDetail` citations, brand spans) |
| 89 | Okara launch Signal/Value table (title length, canonical, internal links) | D: covered by panel 04 rule rows and `now` values |

## 8. Motion spec (only on arrival of stored data)

| What | Trigger | Animation | Duration / easing | Reduced motion |
|---|---|---|---|---|
| Table row arrival (04, 03, 09, step log) | A new id in a feed page, or a replay reveal | Insert at top: `translateY(-6px)`→0 and opacity 0→1, then a background highlight (`sky-100/60`, dark `sky-900/40`) fading out | 240 ms ease-out, then 1,200 ms fade | Instant insert; a 2 px sky left marker for 2 s |
| Replay pending → resolved | The playhead passes the row's `at` | "Reading…" chip crossfades to the verdict chip; blurred cells sharpen (`blur(3px)`→0) | 180 ms | Instant swap |
| Counters (big numbers, stats, pill spend) | A new stored value differs | Tween from old to new, `tabular-nums` | 600 ms easeOutCubic; at most 1 tween per counter in flight (retarget) | Instant |
| Gauge arc | A new lane ratio | Arc sweep from the old to the new value | 600 ms ease-out | Instant |
| A-strip card | New answer for the lane | Enters from the right (`translateX(24px)`→0, opacity); the strip scrolls to show it unless the user scrolled it in the last 10 s | 280 ms ease-out | No slide; newest card first in reading order |
| Queued card | `queued` changes | Opacity 0.5 with a shimmer on its stat line | 1.6 s loop | Static "Queued" text |
| B card / panel 02 | A newer skipped answer or a newer answer | Crossfade | 200 ms | Instant |
| Now-reading URL (01) | `nowReading.url` changes | Crossfade + 8 px slide up | 200 ms | Instant |
| Crawl progress bar | `pagesRead` changes | Width transition; animated stripes on the remainder only while `seo.crawl` runs | 400 ms | No stripes |
| Checklist tick (D) | An item went todo → done between two fetches | Check stroke draws in, staggered 120 ms per item | 200 ms | Instant |
| Bucket highlight box (08) | A Links row arrives | The box moves to the bucket (transform); "+1" badge pops | 300 ms ease-in-out | Static outline on the bucket |
| Coverage row reorder (06, GEO 04) | Refetch changes the order | FLIP move | 300 ms | Instant |
| Heatmap cell (GEO 01) | An answer arrives | Fill in from 0.4 to 1 opacity | 200 ms | Instant |
| Run rail | A step event arrives | The segment extends; the running edge pulses | 1.5 s pulse loop | No pulse |
| Live dot (pill, nav) | Run active | Pulse ring | 2 s loop | Solid dot |
| Pending shimmer (all) | Genuinely pending only (section 0) | Gradient sweep | 1.6 s loop | Static muted "Pending" text |

- **Batching:** when one tick brings more than 12 new rows into a panel, only the newest 12 animate and the
  rest are inserted instantly. At most 40 animated elements on screen at once. Animations use
  `transform` and `opacity` only.
- **Reduced motion:** `prefers-reduced-motion: reduce` is honoured by the global rule in `styles.css` and
  additionally by checking `matchMedia` in JS. Tweens and auto-scroll are disabled in code, not just
  shortened. Replay still advances content; with reduced motion it advances without transitions.

## 9. Replay spec

- **Loading:** page `GET /runs/:runId/activity` (limit 200) and the agent's live feed (limit 200) to the
  end. A cap of 25 pages per source (5,000 rows) applies. Progress reads "Loading stored events… 1,200".
  When a cap is hit, the label adds "· first 5,000 events".
- **Timeline:** the union of activity items and feed rows, deduplicated by id (feed rows win), sorted by
  `(at, id)`.
  - `t0 = run.startedAt ?? run.createdAt`.
  - `tEnd = run.finishedAt ?? last event at`.
  - Panel state is a pure reducer over the revealed prefix, so seeking backwards recomputes from the start.
    That is cheap for 10,000 or fewer events. The reducer lives in `src/web/pages/live/replay.ts` and is
    unit-tested.
- **Clock:** each animation frame advances the playhead `p` (run time) by `dt × speed`.
  - Speeds are 1×, 10× (default) and 30×. The choice is stored per viewer in `localStorage` (try/catch;
    defaults when unavailable).
  - **Idle gaps:** when the next event is more than 10 s of run time ahead of `p`, `p` jumps to
    `next.at − 1 s`. The label then reads "· idle gaps over 10 s shortened".
  - The elapsed figure is true run time (`p`), so it jumps on shortened gaps. Run time is never invented.
- **Label** (always visible, in the pill and in a strip under the header):
  "Replay of the run on 29 Sep 2026, 14:02 · real stored events · 10× speed" (+ "· idle gaps over 10 s
  shortened"). Demo: "Demo data - simulated run · Replay of …".
- **Second line under the pill:** "Run time 03:12 of 07:12 · $0.03 spent so far (estimate)".
  - Spend so far = the sum of the `costUsd` of revealed `provider_call` and `engine_answer` items.
  - If any revealed cost-bearing item is unpriced: "$0.03 + 2 unpriced".
  - At the end the authoritative `totals.spend` replaces it.
- **Counters during replay** come from revealed rows. At the end they switch to the server `totals`. When
  caps made them differ, the end shows the server value with "(N rows not replayed)".
- **Pending in replay:** rows with `at` greater than the playhead, at most 8 per panel. They show
  page/element (or prompt/engine) with blurred value cells and a "Reading…" chip (element rows),
  "Asking…" (answers), or "Scoring…" (none in v1: competitor assessments are not time-indexed). Rows
  beyond the first 8 stay hidden.
- **Project-level panels** (SEO 05–07, GEO C, D and 04) are not time-indexed. They show their current
  state with the caption "Current state, not replayed".
- **Controls** (`role="toolbar"`, `aria-label="Replay controls"`):

  | Control | Keys |
  |---|---|
  | Play / Pause | Space or K |
  | Restart | Home |
  | Skip to end | End |
  | Speed 1× / 10× / 30× (segmented, `aria-pressed`) | 1, 2, 3 |
  | Scrubber, `<input type="range">` in run-time seconds, `aria-valuetext="Run time 03:12 of 07:12"` | ← → seek 5 s; Shift+← → seek 30 s |
  | Full screen | F |

  Shortcuts apply only when focus is inside the Live view and not in a text field. A "Keyboard" button
  lists them.
- **End:** "Replay finished · Restart". The view stays on the final state.

## 10. Responsive

| Width | SEO | GEO |
|---|---|---|
| ≥ 1280 | 12-column grid as in section 4 | Lanes `repeat(auto-fit, minmax(380px, 1fr))` (3 at 1280, 4 at ≥ 1600); extras as in section 5 |
| 768–1279 | 2 columns: 01–03 stack 2 + 1; 04 spans both columns; 05–09 one column each | Lanes 2 per row; extras one per row, at full width |
| < 768 | Single column with **panel tabs**: a segmented control that scrolls inside itself (`overflow-x-auto` on the tab list only): Run · Crawl · GSC · Queries · Elements · Competitors · Coverage · AI answers · Links · Recs. One panel at a time | **Lane tabs** (letter badges), then **section tabs** A · B · C · D inside the lane, then the extras as tabs |

- **Mobile tables become stacked cards.** Line 1: page or prompt and the verdict chip. Line 2: now →
  proposed. Line 3: metrics and the Jev chip.
- No horizontal page scroll at 390 px (and 360 px). Every grid child is `min-w-0`; URLs and model ids
  use `break-all` or truncation with `title`; tables use `table-fixed` with truncating cells. Inner
  scrollers (A strip, tab lists) are the only horizontal overflow, and they are keyboard-focusable.
- Panel heights are fixed only at ≥ 1280. Below that, panels size to their content, capped at 70 vh with
  inner scroll.
- Full screen and focus mode work at every width. The run rail collapses to step chips plus counters
  below 768 px.

## 11. Theme

- Light and dark use the existing tokens only:
  - zinc surfaces (`bg-white` / `dark:bg-zinc-900` panels on `bg-zinc-50` / `dark:bg-zinc-950`);
  - `Card` borders;
  - the `Badge` tones (success, warning, danger, info, neutral, demo);
  - the accent table in section 4.
  There are no new colours and no vendor colours.
- Numbers, paths, model ids and ids use `font-mono tabular-nums`, which matches the mono look of the
  reference. Titles use the app sans.
- Shimmer is a `zinc-200 → zinc-100` sweep (dark: `zinc-800 → zinc-700`).
- Status always pairs colour with text (Keep, Change, Review, Cited, Named, Missing, Failed). Contrast is
  at least 4.5:1 in both themes, including chips on tinted highlight rows.

## 12. Accessibility

- Each panel is a `<section aria-labelledby>` with an `<h2>`. The page `<h1>` is "Live · SEO agent". The
  numbered chip is `aria-hidden`; the number is part of the heading text ("04 Every SEO element…").
- **Live regions:** one visually hidden `aria-live="polite"` region for the whole view. Announcements are
  throttled to at most 1 per 5 s and summarise what arrived since the last one, for example "6 new
  judgments: 2 change, 4 keep. 3 new answers: 1 cited." This reuses `ActivityWindow`'s
  `announcement()`/throttle.
- The Step log is `role="log"` with `aria-live="off"`, because the summary region speaks for it. Tables
  and strips are not live regions.
- Run state changes ("Run finished", "Replay finished") are announced at once.
- Replay: the toolbar and keys are listed in section 9. The scrubber is labelled. Playback pauses when
  focus enters a table, so screen-reader users are not chased by moving rows; it resumes on Play.
- Cards and heatmap cells are `<button>`s with full accessible names, for example "Gemini, Missing:
  'best washable sofa', 377 ms, cited instead reviewsite.example".
- The radar and spend line are `aria-hidden`, with visible tables or text equivalents. The gauge keeps the
  board's `role="img"` label.
- Full screen: the button has `aria-pressed`, and focus stays on it after toggling.
- All third-party text is plain text (`PlainText`). Highlights are `<mark>` around text slices.

## 13. States

| Situation | View |
|---|---|
| No runs at all | `EmptyState` "No runs yet", with `RunNowButton` for SEO and GEO |
| Run `pending` | Pill "○ Queued run · waiting to start"; panels show their empty captions; run rail empty |
| Step skipped (`setup_required`, budget, cancelled) | The rail segment is zinc and hatched with the stored message; the dependent panel shows that message (for example 02 "Search Console not connected") |
| Run `failed` / `partial` / `cancelled` / `rate_limited` | Pill shows the status (`StatusBadge`); panels keep what was stored |
| Jev not configured | Element rows come only from rules; panel 04 subtitle adds "Jev not configured: rule findings only"; 03 shows "Query classification needs Jev" |
| No GEO engine configured (GEO mode) | Lanes missing; `EmptyState` "Connect an AI engine", with a link to Integrations |
| Demo project | Replay only; `DemoBanner`; every label prefixed "Demo data - simulated run"; Approve buttons disabled |
| Network error | Existing reconnecting label; the last stored rows stay on screen |

## 14. Implementation map

**Worker:**
- `src/worker/live/elements.ts`: done; the map and verdict rules.
- `live/seo.ts` (`buildLiveSeo`).
- `live/geo.ts` (`buildLiveGeo`).
- `live/cursor.ts`: base64url JSON marks; keys `{d,f,r,k?}` for SEO and `{o,r}` for GEO; reuse the
  validation style of `runs/activity.ts`.
- `routes/live.ts`.
- One mount line in `app.ts`: `app.route("/", liveRoutes)`.
- Reuse:
  - `runs/activity.ts` (`answerOutcome`, `OBS_HOLD_MS`, `START_CURSOR` pattern);
  - `coverage/common.ts` (`clip`, `inChunks`);
  - `coverage/geo-data.ts` (`resolveCitation`);
  - `coverage/answer-coverage.ts` (`matchPrompt`, `brandTokenSet`);
  - `seo/gsc/overview.ts` (`latestUsableSync`);
  - `seo/gsc/aggregate.ts` (`pageMetrics`);
  - `geo/board.ts` (`laneCost`, `BOARD_LANES`).
- Do not edit `runs/activity.ts` or `geo/board.ts`; another workflow owns them right now.

**Web:**
- `src/web/pages/live/LivePage.tsx`.
- `useLiveRun.ts`: the heartbeat via `useRunActivity`, plus the feed fetch-on-signal.
- `replay.ts`: pure reducer and clock.
- `panels/*.tsx`.
- `LiveNavDot.tsx`.
- One route line in `App.tsx`, the nav entry in `ProjectLayout.tsx`, and the "Open live view" link in the
  Activity header.
- Reuse:
  - `CitationGauge`, `FeedCard`, `FactorRow`, `CheckRadar`, `CheckTable`, `AssessmentCard`,
    `ApproveCandidate`, `RewritePlanCard` (pages/geo/board);
  - `DemandCurveChart`, `LineChart`, `DecisionLog`;
  - `ObservationDrawer`;
  - the `ui.tsx` primitives.

**Tests:**
- `tests/live-elements.test.ts` (done).
- `live-worker-seo.test.ts`: tenant 404, agent mismatch 400, cursor per source and crawl attempt,
  at most 100 bound parameters, totals via grouped queries, demo fixtures.
- `live-worker-geo.test.ts`: held answers keep their id, per-lane totals, `plannedPrompts` only without
  `after`.
- `live-web-replay.test.ts`: reducer, gap shortening, spend so far, pending.
- `live-web-render.test.ts`: 390 px with no overflow, labels, reduced motion.

## 15. Acceptance checklist

- [ ] No number on screen is absent from a stored row or a documented aggregate of stored rows.
- [ ] No "Reading…", "Asking…" or "Scoring…" shimmer appears on an item that is not genuinely pending
      (section 0.3).
- [ ] Every Noul is shown as "Jev <tier> · <noul>"; nothing reads "confidence" for a Noul.
- [ ] None of these appear: "steal", "x/10", "chance", "after", "prompts/sec", projected arrows, vendor
      logos, or "ChatGPT" as a lane name.
- [ ] Replay is labelled with its date, "real stored events" and its speed; demo is labelled simulated.
- [ ] 390 px has no horizontal page scroll in either mode, in light and dark.
- [ ] Reduced motion: no slides, tweens or shimmer loops; content still updates.
- [ ] Polling is at most 1 heartbeat plus 1 feed request per 2 s while active, and none while the tab is
      hidden.

## 16. Section run controls (amendment 2026-10-03)

Owner request: "In the Live tab add a separate button for each section to run that section, and one common
button to run all." Code: `src/web/pages/live/run-actions.ts` (pure mapping, tested), `RunActions.tsx`
(button, dialog, menu); server: partial runs (`docs/api.md` "Partial (section) runs").

**Panel → action** (no entry = no button; nothing is faked):

| Mode | Panel | Button | What it calls |
|---|---|---|---|
| SEO | 01 Pages being read | ▶ Run crawl | partial SEO run `steps: ["crawl"]` |
| SEO | 02 Search Console | ▶ Run Search Console sync | partial SEO run `["gsc_sync"]` |
| SEO | 03 Queries classified by Jev | ▶ Classify queries | `POST /seo/buyer-queries` (existing tool; not an agent run) |
| SEO | 04 Every SEO element judged | ▶ Run judging | partial SEO run `["recommend"]` (uses the latest stored crawl + sync) |
| SEO | 05 Competitor pages worth adapting | ↗ Review pages to approve | link to the AI engines board approval flow (needs approval per URL; never fetches) |
| SEO | 06 Answer coverage / 07 AI answers | ▶ Ask AI engines | partial GEO run `["batch"]` |
| SEO | 08 Internal links judged | ▶ Run link analysis | `POST /seo/internal-links/run` (existing tool, 3 per hour) |
| SEO | 09 Recommendations drafted | ▶ Run drafting | partial SEO run `["recommend"]` |
| GEO | each engine column | ▶ Ask <engine> | partial GEO run `["batch"]`, `engines: [<provider>]` |
| GEO | 01 Prompt × engine, 04 Coverage | ▶ Ask all engines | partial GEO run `["batch"]` |
| GEO | 05 Proposals | ▶ Run proposals | partial GEO run `["proposals"]` (uses stored answers) |
| GEO | 02 Inside the latest answer, 03 Cited instead | none | views of stored answers |

**Header:** "▶ Run all ▾" next to full screen: "Run SEO agent (all steps)", "Run GEO agent (all steps)",
"Run both" (two manual runs).

**Disabled states** (the button stays focusable with `aria-disabled`, the reason as tooltip and screen-reader
description): demo project ("Demo project: runs are disabled"); the agent has a pending/running run (label
"Running…"); today's manual runs (UTC, from the run list) would exceed 3; missing setup known on the client
(site not verified, no Search Console property, no ready engine / that engine's board `stateDetail`, the
tool's own `setup_required` label). Anything the client cannot know (no stored crawl yet) comes back from the
server (409/412/429) and is shown in the dialog.

**Confirm:** every action that starts work opens one dialog (focus on Cancel, Tab trapped, Escape closes)
saying what it calls and what it uses, e.g. "Partial GEO run: ask 4 prompts × Gemini, then analyse each stored
answer." / "Calls the engine APIs and uses your daily GEO budget" / "Uses 1 manual run of the 3 per project per
UTC day (2 left today)". The prompt count is the shown GEO run's planned prompts; when unknown it says "your
approved prompts (up to the per-run cap)".

**After start:** the view switches to the new run (`?run=<id>`), i.e. LIVE mode while it is pending/running;
tool calls reload their panel's data. A partial run shows "Partial run: crawl only" under the header (also in
Runs, Run detail and the Activity window). An engine-limited GEO run shows only its lanes.

Layout: the button sits in the panel header (wraps under the title at phone width); the menu is
`min(18rem, 100vw - 2rem)` wide; colours use the zinc/sky tokens with `dark:` variants like the rest of the
view. Keyboard: the menu button opens with Enter/Space/ArrowDown; arrows/Home/End move; Escape or Tab closes
and returns focus; the view's shortcuts (F, Space, arrows) are ignored inside the dialog and menu.

## 17. Project containers (amendment 2026-10-03, docs/build-kit.md [A31])

Owner request on `/projects/:pid/live`: "can you add more containers here", each with its own run button where a
real action exists. Six SEO containers (10-15) and six GEO containers (06-11) show the project's latest STORED
state next to the run on screen. They never claim to be part of that run: every caption says where the data
comes from and when. Server: `GET /projects/:pid/live/insights?kind=` (`docs/api.md` "Live view: project
containers"), builders `src/worker/live/insights{,-seo,-geo,-lib}.ts`. Web: `src/web/pages/live/more/**`
(registry, data hooks, formatters, containers, "Containers" menu) and the run mapping in `run-actions.ts`.

**Containers** (accent in brackets; "▶" = a §16 section button with the same disabled/confirm rules):

| Mode | # | Container | Data (stored rows only) | Button |
|---|---|---|---|---|
| SEO | 10 | Striking-distance queries [sky] | `insights?kind=striking`: current-window query+page rows of the latest usable Search Console sync with position 8-20 (inclusive) and ≥ 1 impression, by impressions, top 50; clicks, CTR, position and the same query+page of the previous window ("prev 2,050 · −4 vs prev"). Counter: rows in range. | ▶ Run Search Console sync (partial SEO run `["gsc_sync"]`) |
| SEO | 11 | Pages gaining and losing clicks [sky] | `insights?kind=movers`: page sums per window (page rows; else query+page rows, labelled a lower bound). Only pages in BOTH windows are ranked (top 8 each way, measured click difference, both values shown); pages only in one window are counted as new / lost, never ranked. | ▶ Run Search Console sync |
| SEO | 12 | Technical issues from the latest crawl [rose] | `insights?kind=technical`: `audit_findings` of the latest completed/partial crawl grouped by severity and rule (count, rule name, fact/heuristic, up to 5 example URLs behind an "Examples" disclosure), crawl date and pages read; a newer running/failed crawl is named. Unverified site: setup state. | ▶ Run crawl (partial SEO run `["crawl"]`) |
| SEO | 13 | Competitor keyword gap (DataForSEO) [amber] | Existing endpoints `GET /competitors/dataforseo` + `/domains/:domain`: per tracked domain (tabs), the stored `domain_intersection` rows (keywords they rank for where DataForSEO found no ranking for your domain), volume, their position and page, labelled "DataForSEO estimate, fetched <date> · <location> · <language> · <cost>". Not configured: setup state linking to Integrations. | ▶ Refresh competitor data (`POST /competitors/dataforseo/refresh {domain}`; the domain is picked in the confirm dialog) |
| SEO | 14 | Master sheet sync [zinc] | `insights?kind=sheets`: each sheet tab kept in sync (`import_syncs`), status, last/next run, error or warning text, and the changes its sync imports applied in the last 7 days (`+added · ~updated · −removed`). None: link to the Import page. | ▶ Sync now per row (`POST /import/syncs/:syncId/run`) |
| SEO | 15 | Budget and quotas today [zinc] | `insights?kind=budget`: today's (UTC) `usage_counters` of the project vs each cap, the operator's global counters only for resources this workspace spends on an operator key, manual runs used of 3, which key each provider uses (never the key). | none (nothing to run) |
| GEO | 06 | What the AI engines searched for [sky] | `insights?kind=engine_queries`: `geo_search_queries` of API answers stored in the last 30 days, grouped by normalized query: engines, distinct answers, last seen, and an EXACT normalized match in the latest sync's current window ("pos 12.3 · 340 impr."; "≈" when summed over query+page rows, i.e. impression-weighted). | ▶ Ask AI engines (partial GEO run `["batch"]`) |
| GEO | 07 | Brands in AI answers [emerald] | `insights?kind=brands`: per brand (yours first, then tracked competitors) and engine, over analysed API answers to discovery prompts in the last 30 days: named / cited / recommended / mentioned negatively, each "n of m answers". No share, no rate. | ▶ Ask AI engines |
| GEO | 08 | Most-cited domains, last 30 days [amber] | `insights?kind=cited_domains`: citation hosts (redirect links resolved by their bare-domain title, `www.` folded) by answers citing them, engines, source type; your site highlighted (and shown after "…" when outside the top 25), tracked competitors tagged. | ▶ Ask AI engines |
| GEO | 09 | Prompt history [sky] | `insights?kind=prompt_history`: approved prompts of the active set × engine × the engine's last up to 8 GEO runs with stored answers (oldest first): cited / mentioned / absent / no answer (failed) / not analysed / nothing stored. Letters plus colour plus an accessible name per engine ("Gemini, last 3 runs: 29 Sep cited, …"). | ▶ Ask AI engines |
| GEO | 10 | AI questions from your sheet [zinc] | `insights?kind=sheets` (GEO-prompt tabs): as SEO 14, plus what each tab feeds: questions in the set / not added (set full) / archived, how many are approved in the active set, when one was last asked. | ▶ Sync now per row |
| GEO | 11 | Budget and quotas today [zinc] | as SEO 15 | none |

**Thresholds** (one exported constant each, `src/worker/live/insights-lib.ts`, asserted by tests):
`STRIKING_DISTANCE = {minPosition: 8, maxPosition: 20, minImpressions: 1, maxRows: 50}` (Search Console's
average position, inclusive), `MOVERS = {top: 8, groupCap: 5,000}`, `TECHNICAL = {examples: 5, groupCap: 500}`,
`INSIGHT_WINDOW_DAYS = 30`, `ENGINE_QUERIES_LIMIT = 50`, `CITED_DOMAINS = {limit: 25, rowCap: 20,000}`,
`PROMPT_HISTORY = {runsPerEngine: 8, runScan: 40, observationCap: 6,000, prompts: 100}`,
`SHEETS = {syncs: 50, recentDays: 7}`. A hit cap is reported (`truncated` + a "lower bound" label).

**Captions** (first line of every container, `more/format.ts`): the demo label first for demo projects; then
"From this run's Search Console sync (3 Oct) · 3-30 Sep vs 6 Aug-2 Sep" when the run on screen produced the
data, else "From your latest Search Console sync (29 Sep), not part of this run" (crawl, DataForSEO refresh
likewise); GEO 06-08 "From your stored answers, 3 Sep-3 Oct (30 days), not only this run"; GEO 09 "From your
stored runs (latest 3 Oct), not only this run · prompt set v4"; sheets/budget "From your … , not part of this
run". During a replay a "Current state, not replayed" chip is added: these containers always show the current
stored state, never a reconstruction of the replayed moment. Untrusted strings (queries, URLs, sheet titles,
tabs and error text, DataForSEO keywords and pages, brand keys) are React text only.

**Data plan** (no polling loop of their own; the §3 budget of one heartbeat + one feed per 2 s holds): each
container fetches once when it mounts. It refetches only when (a) the step that changes it reaches a terminal
status in the heartbeat the page already polls (`seo.gsc_sync` → 10/11, `seo.crawl` → 12, `geo.batch` → GEO
06-09; budget after any terminal step, throttled to one refetch per 10 s), or (b) a run control of the view
finished (a sheet "Sync now" → 14 / GEO 10, a DataForSEO refresh → 13, any start → budget). The scheduled
sheet sync and an asynchronous DataForSEO refresh show on the next mount or reload ("Check again" nudge in 13).

**Run buttons:** `moreSeoActions` / `moreGeoActions` reuse the §16 actions of panels 02, 01 and the GEO batch
(same keys prefix, labels, disabled reasons, confirm text: manual-run quota, budget). New `call` actions:
- *Refresh competitor data* (paid): disabled in demo, for non-owners ("Only the workspace owner can refresh
  competitor data."), when DataForSEO is not ready (the panel's message, else "add credentials on the
  Integrations page"), with no tracked competitor, or when every domain is at its cap. The dialog lists the
  domains as radio buttons (a capped domain is disabled with its reason) and says: "Paid call: DataForSEO Labs
  ranked keywords, keyword gap against <domain> and top pages for the domain you pick.", the existing
  `refreshCostNote` (published-price ceiling, from the server's constants), the per-domain and per-project
  daily caps with today's count, whose account it uses (operator vs workspace) and "Not an agent run: no manual
  run is used."
- *Sync now* (free): disabled in demo, for non-owners, and while Google Sheets is not connected or its
  authorization expired. The dialog names the tab and sheet, what syncing does for that destination
  (competitors queue paid refreshes within their caps; questions are added pending approval / archived; links
  are append-only), and "Google Sheets reads are free; at most 6 per tab per hour." (`SYNC_NOW_PER_HOUR`, the
  route's rate limit). A 200 whose sync outcome is not ok is shown in the dialog as an error.

**Containers menu** (header, before "Run all"): "▦ Containers ▾" (label hidden below `sm`, "N hidden" when
any), a `menu` of `menuitemcheckbox` items (number + title) and "Show all". Default: everything shown. Choice
per viewer and mode in `localStorage` `okara.live.hidden.<mode>` (a JSON array of keys; read and written in
try/catch, unknown keys dropped, so a private window simply shows everything). Keyboard: Enter/Space/ArrowDown
open, arrows/Home/End move, Space/Enter toggle (menu stays open), Escape/Tab close and return focus. Hiding
every container shows "Every container is hidden. Use “Containers” in the header to show them again."

**Layout:** desktop grid cells `xl:col-span-6`, fixed heights (420 px; sheets/budget 400 px) with internal
scroll; below `xl` they stack. New containers mount lazily (`IntersectionObserver`, 400 px root margin; a
"Loads when it scrolls into view." placeholder of the same accent). Phone width: one tab per container in the
existing tab strip; tables are `table-fixed` with columns dropped below the container's `@lg` width; no
horizontal page scroll at 390 px (verified light and dark). The scrollers of the tab strips are `relative`
so their screen-reader-only text cannot widen the page.

**States:** loading shimmer; `setup_required` (no Search Console sync stored, site not verified, no prompt set,
DataForSEO not configured, migration missing) with the step that fixes it; empty (e.g. "No query+page row at
positions 8–20 with impressions in the latest sync."); error ("Could not load …", fetched again on the next
refetch key or a page reload); demo (simulated, labelled).

**Demo:** the demo seed adds labelled fictional rows so every container renders: two DataForSEO snapshots per
tracked competitor (ranked keywords + keyword gap, cost unknown, "United States (demo)"), a demo sheet with a
paused "Competitors" sync (OK) and a paused "AI questions" sync whose last run failed (header changed), with
their imports and changes; the exact Search Console match in GEO 06 is "oak side table". Budget counters are
not seeded (the demo shows the real, zero counters) and the demo has one GEO run, so GEO 09 shows one cell per
engine.

**Not shown / dropped:** SEO 13's "(or rank worse)": the stored keyword gap is DataForSEO's
`intersections: false` set (keywords where your domain has no ranking), and the positions of shared keywords
are not stored, so "ranks worse" cannot be computed without another paid call. No share of voice, visibility
score, traffic or forecast anywhere; differences are measured between two stored windows and always show both
values.

**GEO 12 Question queries from Search Console (amendment 2026-10-04, docs/build-kit.md [A37]).** The companion
of GEO 10 (sheet questions), appended as 12 so 10 and 11 keep their numbers. It reads
`GET /projects/:pid/geo/prompts/from-gsc` (read-only, no provider call) on mount and when the shown run's
`seo.gsc_sync` step ends; it lists the top 8 question-style queries not yet in the prompt set (prompt text,
impressions, position, landing page at wider widths), the count of all of them as the counter, the caption "From
your latest Search Console sync (<date>), not part of this run", and "↗ Review on GEO prompts" (the page's "From
Search Console" card, where they are added unapproved). No run button. Setup state (no stored sync) links to
Integrations; non-English projects show the server's "not available" message.

## 18. Internal-link containers (amendment 2026-10-03, docs/build-kit.md [A32])

Owner request on `/projects/:pid/live` (SEO mode): containers built on the internal links workbench ([A30]), each with
a run button where a real action exists and a link "Open Internal links ›" to the matching tab of the Internal links
page. They are project containers like section 17 (same caption, setup, empty, error, demo and replay conventions,
listed in the "Containers" menu, lazily mounted) and read the workbench's existing GET endpoints unchanged (no new
endpoint, no worker change). Code: `src/web/pages/live/more/{LinkContainers.tsx,links-lib.ts}` (pure helpers),
`more/data.ts` (`useLinkRead`), `more/registry.ts` (`links: true`), the mapping `linkContainerActions` /
`linkGraphActionKey` in `run-actions.ts`. Tests: `tests/live-links-{containers,actions,demo}.test.ts`.

| # | Container [accent] | Data (GET `/projects/:pid/seo/internal-links/…`) | Button | Tab |
|---|---|---|---|---|
| 16 | Link graph coverage [sky], full row | `graph` → `LinkGraphSummary`: counter "8 analysed / of 8 sitemap URLs"; n-of-m meters with bars: sitemap URLs analysed (oldest/newest snapshot), orphan pages (0 links in) of the sitemap URLs (crawled pages without a sitemap), no content links in (sitemap URLs only; no bar without a sitemap), stale snapshots of crawled pages, known URLs not crawled yet (rolling crawl, pages per run); graph built time and trigger ("after a crawl", "rebuilt on request", "by a link analysis run", "from the demo crawl"), link and URL counts, a newer-crawl notice, the server's notes | ▶ Rebuild link graph, or ▶ Run crawl while no crawl is stored (below) | graph |
| 17 | Broken and redirected internal links [rose] | `broken` → `BrokenLinksReport`: counter = links listed ("3 to 4xx/5xx · 2 redirected"); 4xx / 5xx / 3xx groups with links and distinct URLs; redirected links through a chain (2+ hops), ending in 4xx/5xx, leaving the site; linked URLs not crawled yet; top 20 rows: source path, anchor (plain text) and link position, target and final URL, status ("404", "301 → 200 (2 hops)", "302 → off-site", chain in the tooltip), stale snapshot, the server's fix text | ▶ Run crawl (partial `["crawl"]`) | broken |
| 18 | Hub and cluster gaps [emerald] | `clusters` → `LinkClusterReport`: counter "spokes missing a link of N spokes in M hubs"; linked both ways / partly / unlinked / no hub; missing hub → spoke and spoke → hub links; the top 8 hubs sorted by missing links (then unlinked spokes, size), each with a linked · partly · unlinked bar ("n · n · n of m") and its first 3 spokes with the missing direction | ▶ Run link analysis (`POST …/internal-links/run`) | clusters |
| 19 | Anchor text flags [amber] | `anchors` (flagged only) → `AnchorAuditReport`: counter = flagged pages; pages per flag; the returned `thresholds` as a one-line caption ("exact match > 50% with ≥ 5 links · repeated: one anchor from ≥ 10 pages and ≥ 60% · no query terms: ≥ 3 anchored links", engineering defaults) and as full sentences in each flag chip's tooltip (a threshold not returned is left out, never guessed); top 12 pages: flags, anchored links, distinct and empty anchors, keyword and its basis, the most used anchor (unless a reason quotes it), the server's reason lines | ▶ Run crawl | anchors |
| 20 | Placed links verification [zinc] | `placed` → `PlacedLinksReport`: counter "verified of N placed links · n not found"; verified / not found / source unavailable / pending crawl (pending + not checked) as a stacked bar and "n of N"; the latest 6 "not found in crawl of <date>" rows (source → target, anchor, accepted / implemented / from your sheet, since) with the server's label; links waiting for the next crawl | ▶ Run link analysis | placed |

**Numbers:** every count is the server's count of the stored graph or a count of listed rows (17 and 19 count the rows
the endpoint lists, at most 2,000 / 500; "Showing n of m" and the server's truncation note say so). Percentages appear
only in 19: the returned thresholds and the server's own reason lines. Bars are n/m widths with both numbers printed.

**Captions:** demo label first for demo projects; then "From your latest link graph (built 3 Oct, 19:12 after a
crawl)". The summary does not say which crawl built the graph, so a crawl-built graph claims neither "this run" nor
"not part of this run"; a graph rebuilt on request, by a link analysis run or by the demo seed adds ", not part of this
run". 20: "From your placed links, checked at every link graph build (latest check: crawl of <date>)". During a
replay "Current state, not replayed" is added. Titles, anchors, keywords, URLs and fix texts are React text only.

**States:** loading shimmer; error "Could not load …"; setup (`state: "setup_required"`: unverified site, or for 16 no
crawl stored) with the server's message and Settings when the site is not verified; no graph yet ("It is built at the
end of every crawl; 16 can rebuild it"); empty (17 "No broken or redirected internal links in the analysed pages.",
18 "No hubs found yet.", 19 "No anchor flags…", 20 "No placed links yet." with links to Internal links and Import);
demo (labelled).

**Run buttons** (`linkContainerActions`; same disabled reasons and confirm dialog as section 16):
- 16: `POST …/graph/rebuild` is deterministic (no provider call, no budget), 6 per project per hour
  (`GRAPH_REBUILD_RATE_LIMIT`, stated in the dialog and asserted by the tests) and answers 409 while another build runs.
  Without a stored crawl (or on an unverified site) the route returns the unchanged `setup_required` summary and
  rebuilds nothing, so 16 picks its button from its own data (`linkGraphActionKey`): ▶ Run crawl (the panel 01 action,
  `["crawl"]`; the graph is rebuilt at the end of every crawl) while the summary is `setup_required`, else ▶ Rebuild
  link graph. Disabled in demo and on an unverified site; not blocked by a running agent or the manual-run quota (not
  an agent run).
- 17 and 19: ▶ Run crawl (statuses, redirect chains and anchors come from crawled snapshots).
- 18 and 20: ▶ Run link analysis (the panel 08 tool: rebuilds the graph, re-derives clusters, re-checks placed links).
- The dialog shows a 409 as "Not started: …" and a 429 as "Limit reached: …" in amber (server message as text).

**Data plan** (no polling of their own; the section 3 budget holds): each container fetches when it mounts (lazily),
then refetches only on `linkDeps`: the id of the shown run's latest `seo.crawl` terminal event (the crawl step logs it
after the rebuilt graph is stored) and a reload counter bumped when a rebuild or a link analysis of the view finished
(both rebuild the graph, so all five reload; a link analysis also reloads panel 08). A crawl started from 16, 17 or 19
switches the view to that run (section 16) and the containers refetch when its crawl ends.

**Layout:** 16 spans the row (`xl:col-span-12`, 260 px) above 17 | 18 and 19 | 20 (`xl:col-span-6`, 420 px); below `xl`
they stack (16 spans both `md` columns); phone tabs "Link graph", "Broken links", "Clusters", "Anchors", "Placed
links". Tables are `table-fixed` with the target and fix columns dropped below the container's `@lg` width (the fix
moves under the link); no horizontal page scroll at 390 px, light and dark (verified on the dev server).

**Demo:** the demo seed's link graph feeds 16, 18 and 19 (8 of 8 sitemap URLs, 3 orphans, 2 hubs with 2 partly linked
spokes, 2 exact-match-heavy pages). It has no failing or redirecting link targets, so 17 shows its empty state (adding
one would need a redirecting page and snapshot: not a tiny fixture). For 20 the seed marks two fictional suggestions the
demo SEO run did not reuse as "accepted" (labelled demo data): one before the demo crawl, checked against it ("not
found in crawl of <date>"), one after it (pending the next crawl). Accepted-only links are not flagged on the Overview.

**Not shown:** verification of links that are only suggested (open), per-URL link counts (the Link graph tab has them),
and anything about link equity, value or expected ranking change: the workbench stores none of it.

## 19. Live Backlinks (amendment 2026-10-04, docs/build-kit.md [A38])

Owner request: "Add a live tab for backlink monitor as well … In live action create a separate container for each
section: backlink live check; dofollow/nofollow check; current status; new status (e.g. earlier it was dofollow, now
nofollow; or 404, redirected, etc.)". A separate Live tab, `/projects/:pid/live/backlinks`, with its own sidebar entry
"Live Backlinks" right after "Live SEO" / "Live GEO" (a pulsing dot with screen-reader text while a backlink check job
is queued or running: `BacklinkNavDot`, one shared poller of `GET /backlinks/feed?limit=0`, 60 s idle / 5 s while a
job runs, visible tab only). It is not a run replay: the backlink monitor has no agent run; the containers show the
stored checks (docs/api.md "Backlinks"). Code: `src/web/pages/live/backlinks/{LiveBacklinksPage,BacklinkContainers,
actions,job-store,BacklinkNavDot}.tsx|ts`, helpers in `src/web/pages/backlinks/lib.ts`. Tests:
`tests/backlinks-web.test.ts`.

| # | Container [accent] | Data | Button |
|---|---|---|---|
| 01 | Backlink live check [sky] | `GET /backlinks/feed` + `POST /backlinks/check/advance` while a job runs: progress "Checking n of m" with a progress bar (`role=progressbar`), robots-blocked, failed / page errors, changes, requests and batches; the job's latest checks as they land (live article host + path, status chip, anchor, time). Caption: running/last check (manual run, recheck or weekly check) and "Updates every 2 s while the check runs" / "Idle: not polling". | ▶ Run backlink check |
| 02 | Dofollow / nofollow check [emerald] | `summary.byStatus` counts (dofollow, nofollow, sponsored, ugc) and the counter "n dofollow of m pages read"; the loaded rows grouped by rel, with page-level nofollow (meta robots / X-Robots-Tag) as its own group; anchor found vs expected ("≠ expected") and the match / differ / no-expected counts. | ▶ Run backlink check |
| 03 | Current status [amber] | Buckets from the server counts: live + dofollow, live + nofollow / sponsored / ugc, link missing, page 404 / 5xx, redirected, robots blocked, fetch failed, target broken (overlaps the others), not checked yet; the first 50 rows by status (status chip with the reason as tooltip, broken target, target, last checked); the summary's notes (site not verified, scheduled runs off). Caption: latest check and next weekly check. | ▶ Recheck failed/changed (failing pages first, then rows changed in the last 7 days; ≤ 30 ids; 30 rows per project per hour) |
| 04 | New status (changes) [rose] | `GET /backlinks/events` (last 30 days): "was dofollow → now nofollow", "Link removed", "Page now 404", "Redirected to …", "noindex added", "Anchor changed", "Target now 404", "Recovered", with the article and date; losses marked ▼ in rose (colour plus symbol plus words); link "Open Backlinks ›" (`?changed=30`). Counter: changes, sub "n losses". | ▶ Run backlink check |

**Run buttons** reuse the section 16 `RunActionsProvider` / `SectionButton` / confirm dialog (`call` actions to `POST
/backlinks/check`): disabled with the reason in demo projects, while loading, with no backlinks ("import your built
links"), while a full check runs (label "Checking…", reason "A backlink check is running (Checking n of m)"), and when the
3 manual checks of the UTC day are used. The dialog says what is fetched (each live article and its robots.txt, our
target pages), the politeness and batch limits, "Free: no paid provider is called", and the manual checks left today.
The header carries the same "▶ Run backlink check" (no "Run all" menu: there is one action).

**Data plan:** summary, rows (first 100, sorted by status) and events load on mount and again when a check ends (the
feed's job leaves queued/running) or a run button finished. While a job runs the view calls `POST
/backlinks/check/advance {after}` sequentially at most every 2 s (`LIVE_POLL_MS`), visible tab only: each call runs one
more bounded batch in its own invocation and returns the checks stored since `after`, merged newest-first (≤ 50).
Nothing polls while idle. Replay is not offered.

**States:** loading shimmer; empty / setup (no backlinks: "Import your built links sheet (the Built Links tab maps
automatically …)" with a link to Import; demo projects: "demo projects never fetch pages"); data; running (progress,
live rows, arrival highlight `lv-row-in`, a static marker under reduced motion); errors use the shared "Could not load …" state.

**Layout:** a 12-column grid at `xl` with each container `xl:col-span-6` at 420 px (internal scroll), stacked below `xl`;
tables are `table-fixed` with secondary columns dropped below the container's `@lg` width; no horizontal page scroll at
390 px; light and dark through the shared zinc / accent tokens; the progress bar's width transition and arrival
animation are off under `prefers-reduced-motion`.

**Not shown:** no backlink "value", authority or traffic estimate from Okara; DA, traffic and price appear only on the
Backlinks page as the owner's own sheet labels.
