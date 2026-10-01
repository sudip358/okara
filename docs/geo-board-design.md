# AI engines board: UI spec

Route `/projects/:pid/geo/board`, nav label **"AI engines"** (GEO group in `ProjectLayout.tsx`, between
"GEO results" and "Competitors"). Data: `GET /projects/:pid/geo/board` (`EngineBoardResponse`), plus
skip factors, competitor pages, and rewrite plans (docs/api.md, "AI engine board"). Status: spec only.

Reference: the Ryze "Jev for SEO/GEO" board (a video labelled "Simulated run"; layout only, its numbers
are not evidence) and the Rankie/Okara 4-panel "Jev for SEO and GEO" frame. We keep the layout — engine
columns, a prompt feed, "why we are skipped", "why they are cited", a rewrite checklist — and replace
every simulated or projected element with stored data or an honest empty state.

## 1. Page frame

- Header: title "AI engines", one-line description "How API-sampled AI answers treat your prompts, and what
  the cited pages do differently." Right side: prompt-set version, `generatedAt`, a "Run GEO now" button
  (existing `RunNowButton`, agent `geo`), and a link to Usage. No "elapsed seconds" or "$ spent" ticker;
  cost lives in each lane.
- A disclosure strip under the header always renders `EngineBoardResponse.labels` (at least "API-sampled
  answers; not consumer-app answers" and "Measured, not projected"). Demo projects add `DemoBanner`.
- Columns: one per `lanes[]` entry in API order (OpenAI, Anthropic, Gemini, Perplexity). Desktop ≥1280px:
  up to 4 columns (`grid-cols-4`, each `min-w-0`); 1024–1279px: 2 columns; below 1024px: 1 column,
  lanes stacked, each lane a collapsible `<details>` (the first ready lane open). No horizontal page
  scroll at 360px; long URLs and model ids use `break-all`.
- Each column stacks the Ryze sections in order: lane header (§2) → A prompt feed (§3) → B our pages
  (§4) → C competitor pages (§5) → D rewrite plans (§6). B–D are project-level lists filtered to that
  engine; on mobile they are tabs inside the lane ("Prompts · Our pages · Cited pages · Plans").

## 2. Lane header (mockup: logo, model, grounding, citation gauge, 4 stats)

| Mockup element | Real data | Label / rule |
|---|---|---|
| Engine logo + name ("ChatGPT") | `label` ("OpenAI Responses API · web_search"). A plain monochrome glyph per vendor, no brand logos | Never say "ChatGPT"/"Claude app": these are API answers. Badge "API-sampled" |
| "OpenAI · gpt-5.2 · web" | `model` (exact id, mono) · `groundingMode` | `model` null → "Model not set" |
| "Asking and reading" live dot | `state` via `StateBadge` + `lastRunAt` ("Last run 2 h ago", exact time in `title`) | No live animation unless a run is actually `running` (from runs API) |
| Citation-rate gauge "21%" | `citationRate` | Semicircle SVG gauge `role="img"` with `aria-label="Citation rate 21.1%: 292 of 1,386 valid answers cited your site"`; the numerator/denominator is also printed under the gauge. `value` null → gauge empty, text "Unavailable (no valid answers)" |
| "Prompts / sec 82" | Dropped | Throughput is not a user metric; latency per prompt is in the feed |
| "Answers citing us" | `answersCitingUs` | Plus `mentionRate` as a secondary line "Named in 412 of 1,386" |
| "Answers skipping us" | `answersSkippingUs` | Tooltip: "Valid answers that neither name nor cite you" |
| "Cited instead · 21% Peptide Sciences" | `citedInstead.host` + `citedInstead.share` (as n of m) | Host, not a guessed brand name. Null → "No other source dominates" |
| "Cost (latest cohort)" | `costUsd` (sum over the latest cohort only) | Reuse `EngineLane` `costLabel`: "Actual" / "Estimate (versioned rates)" / "Unknown" — never $0 for unknown |
| — (added) | `counts`, `searchQueries`, `smallSampleWarning` | "1,386 valid · 1,301 grounded · 4 failed"; "38 engine searches captured" or "Search queries not exposed"; small-sample warning badge |

### Lane empty / setup states
- `setup_required`: the lane keeps its header (name, "Model not set" / "Key not set") and replaces the body
  with `EmptyState` "Connect <vendor> to sample answers", text from `stateDetail`, and a link to
  Integrations. For `openai_geo`/`anthropic_geo` before the adapters ship, `stateDetail` reads "Not
  implemented yet". No gauge, no zeros.
- `disabled`: "Turned off for this project" with a Settings link.
- `error`: `StateBanner` tone danger with `stateDetail` (e.g. "Web search is not enabled for this
  Anthropic organization") and the last successful run time if any.
- `ready` with `promptsRun = 0`: "No answers yet. Approve prompts, then run GEO." linking to GEO prompts.
- `demo`: normal rendering plus the demo badge on the lane.

## 3. A · Prompt feed (mockup: "523 buyer prompts run against ChatGPT", Missing/Named cards)

- Section title: "`{counts.valid}` prompts answered by {engine}" and a "Latest cohort" note, not "Live feed".
- Cards = `feed[]`, horizontally scrollable row on desktop (`overflow-x-auto` inside the lane, scroll
  snap, keyboard focusable list, not the page) and a vertical list on mobile; max 50.
- Card content: prompt text (plain text, 2-line clamp, full text in `title`), status chip
  (`missing` red "Missing", `named` amber "Named", `cited` green "Cited", `not_run` grey "Not run"),
  `latencyMs` ("377 ms", omitted when null), position ("#2 in list", only when `position` is non-null; the
  mockup's "#15" style ranks without a list are not shown), sentiment with method (`Sentiment`, `title`
  "Method: deterministic+jev"), and "Cited instead: host via <source type>" when present.
- The mockup's per-card "Share 0%" is dropped (a single answer has no share).
- Click / Enter opens the existing `ObservationDrawer` for `observationId` (raw answer as plain text).

## 4. B · Our pages: why {engine} skips them (mockup factor bars + "3.0/10 citability")

Label "Measured from crawl" (and "Heuristic" on heuristic rows). Data: `PageSkipFactors` for each page
matched to a `missing` prompt (best page from `AnswerCoverageRow.matchedPage`), fetched lazily when the
section opens.

| Mockup element | Real data |
|---|---|
| "Now reading directpeptides.com …/hplc-testing-explained/" | `page.url`, `snapshotAt` ("Crawled 29 Sep") |
| "For 'What is HPLC testing' ChatGPT cites Peptide Sciences via reddit" | `promptText`, `citedInsteadHost` + source type |
| "Page does not exist yet · words 340 · last edit 8 mo" | `page.wordCount`, freshness factor `measured`; "No matching page" when the coverage row has no `matchedPage` (then link to create-page recommendation, not an auto-created page) |
| Factor bars with % (answer first 28%, FAQ schema 45% …) | One row per `factors[]`: label, status chip (present / partial / missing / unknown), `measured` text ("answer at word 180", "FAQPage JSON-LD absent"), method tag. When `citedPage` exists, a second chip "Cited page: present · 1,709 words". No bars with invented percentages |
| "3.0/10 citability" | **Removed.** No aggregate score, no predicted citation % |
| "→ Not citable, creating page" | Replaced by links: "See rewrite plan" (§6) or "Draft check this page". Nothing is created automatically |

Footer caveat: "These are observable differences, not causes. Engines do not publish ranking factors."

## 5. C · Competitor pages: why {engine} cites them (mockup brand/type/reasons/radar "7.4/10")

Label "Jev judgment" on Jev checks, "Measured" on measured competitor checks (skip-factor rows in section B use "Measured from crawl"); section note "Read only for URLs you
approved". Data: `GET …/geo/competitor-pages` filtered by `citedIn[].provider`.

- Candidate list: cited URLs from `citedInstead` / citation evidence, each with an **"Approve reading this
  page"** button (POST, confirm dialog: "We fetch this one URL once, respecting robots.txt, and keep short
  evidence only."). No auto-crawl of competitor domains.
- Assessment card: host (not an inferred brand), `sourceType` ("Listicle", "Video", "Forum"), URL (via
  `ExternalUrl`, `rel="noopener noreferrer nofollow"`), `fetchedAt`, `reasons[]` as bullets (plain text,
  observable facts: "Answer in first 40 words", "Updated 20 days ago", "FAQPage schema"), and `verdict`
  chip: **Adapt** ("adapt the structure; never copy their text"), **Skip**, **Review**.
- Radar chart (answer, FAQ, author, fresh, sources, entity axes): optional small SVG polygon of the check
  statuses (present = outer ring, partial = middle, missing = centre, unknown = no point), `aria-hidden`,
  always accompanied by a visible `Table` fallback (`checks[]`: check, method, result/`detail`, Noul as
  "yes-probability 0.82" for Jev rows, tier badge). On mobile only the table renders. No "7.4/10".
- States: `queued`/`fetching` spinner rows; `blocked` shows `stateDetail` ("robots.txt disallows"); `failed`
  with retry allowed after the rate-limit window; Jev checks not answered → rows show "Not run" (or "Not run · <detail>"); the reason comes from `assessment.stateDetail`.

## 6. D · Pages to rewrite (mockup checklist + Traffic/Conv/AI citations/Revenue arrows)

Label "Manual plan · Publishing: manual (not connected)". Data: `RewritePlansResponse`.

- Card: page URL, `question`, engine, then `items[]` as a read-only checklist (checkbox glyph by status:
  done ✓, todo ☐, not applicable –, unknown ?), each with `evidence` text and method tag. Manual items
  (`read_winning_page`, `map_question`, `indexnow`) are read-only here and show "Check this yourself";
  no write endpoint is defined for them yet (adding one is a separate API change).
- The `indexnow` item always reads "Submit to IndexNow (Bing and participating engines, not Google) ·
  optional".
- Metrics row: `gsc` → "Clicks 12 · Impressions 1,268 (1–28 Sep)"; `aiCitations` → "Cited in 3 stored
  answers (same window)". Null → "GSC not connected" / "No GEO data".
- **Removed**: Traffic/Conv. rate/Revenue values and all "→ projected" arrows [A11]; "clusters" counts
  and "N pages rewritten" (nothing is rewritten by the app).
- Actions: "Open recommendation" (`recommendationId`), "Draft check". Never "Publish".

## 7. Honesty labels (exact strings)

| Where | Label |
|---|---|
| Lane header, feed | "API-sampled" (tooltip: "Answers from the provider's API with web search; consumer apps may answer differently.") |
| B factors (measured) | "Measured from crawl" |
| B/C heuristic rows | "Heuristic" |
| C Jev rows | "Jev judgment" |
| Costs | "Actual" / "Estimate (versioned rates)" / "Unknown" |
| D | "Manual plan · Publishing: manual (not connected)" |
| Page footer | "Practices, not guarantees. No projected traffic, revenue, rankings or citations are shown." |

## 8. Tokens, theme, accessibility

- Reuse `src/web/components/ui.tsx` (`Card`, `Badge`, `StateBadge`, `StateBanner`, `EmptyState`,
  `Table`, `MetricTile`, `Tabs`, `CompletenessNote`) and the zinc/sky Tailwind palette with `dark:`
  variants already used by `EngineLane.tsx`. Status tones: missing = danger, named = warning, cited =
  success, not_run/unknown = neutral. No per-vendor brand colours; lane accents use neutral borders.
- Every colour-coded status also has text. Contrast ≥ 4.5:1 in both themes.
- Gauge: SVG with `role="img"` and a full `aria-label`; the exact numerator/denominator is visible text.
- Radar: decorative (`aria-hidden`) with the check table as the accessible and mobile representation.
- Feed scroller: `role="list"`, each card a focusable button; arrow-key scrolling via native overflow.
- `prefers-reduced-motion` respected (global rule in `styles.css`); no auto-updating counters.
- All third-party text (prompt text, answer excerpts, reasons, titles) is rendered as plain text.

## 9. Where the SEO extras go

The Rankie 4-panel frame's SEO panels are not part of this page:
- "Every SEO element, judged one by one" → existing SEO audit and page audit table
  (`/seo`, `CoverageResponse<PageAuditRow>`), keep/update/review, no "Rank #4" unless GSC position.
- "Pages and SEO techniques to steal from competitors" → reframed as **adapt**, only for approved URLs,
  in §5 and in the content-evidence table's competitor columns [A22]; no "Google #2 / ChatGPT #2" rank
  columns (no data source) and no "Steal" verdicts.
- "Do our pages answer what people ask AI?" → existing answer coverage table on GEO results.
- "How likely is each page to be cited?" → **not built** (predicted citation % / "After 79%" are
  projections). Its per-page attributes are covered by §4 skip factors.
- Engine search queries [A6] stay on Competitors; buyer queries and translation opportunities stay on SEO.
