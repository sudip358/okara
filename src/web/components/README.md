# Web shell exports (for web-features)

Owned by web-shell. Import with the `@web/*` alias. Render untrusted text as plain children (or `<PlainText>`); never `dangerouslySetInnerHTML`.

## `@web/lib/api`
- `api<T>(path, { method?, body?, signal? })` — path WITHOUT `/api` prefix (e.g. `api<Project>("/projects/p1")`). Unwraps `{data}`; throws `ApiError`. CSRF header added automatically for non-GET.
- `ApiError` (`.status`, `.body`, `.code`), `setCsrfToken`, `errorMessage(err)`, `isSetupRequired(err)` (412), `isRateLimited(err)` (429).

## `@web/lib/hooks`
- `useApi<T>(path | null, deps?)` → `{ data, error, loading, reload, setData }` (null path = skip).
- `useMutation(fn)` → `{ run(...args), loading, error, data, reset }` (`run` resolves `undefined` on error; error kept in state).

## `@web/lib/format`
`formatRatio(r, unit?)` → `"12.5% (5 of 40)"` / `"Unavailable (0 responses)"`; `formatFraction`; `formatPercent`;
`formatUsd(value, isEstimate)` → `"$0.12"` / `"~$0.12 est."` / `"Unknown"` (never $0 for null); `formatDate`, `formatDateTime`,
`formatTime`, `formatRelative`, `formatWindow(DateWindow)` → `"Sep 3 – Sep 30, 2026 (28 days)"`; `formatNumber`; `humanize`; `agentLabel`.

## `@web/lib/project-context`
- `useProject()` → `{ project, projectId, reload, setProject }` — available in every page under `/projects/:projectId`.
- `projectPath(projectId, "recommendations")` → `/projects/<id>/recommendations`.

## `@web/lib/session`
- `useSession()` → `{ me, workspaceId, setWorkspaceId, reload, signOut, status }`; `useMe()`.

## `@web/components/ui`
- Layout: `Card({title, description, actions, bodyClassName})`, `PageHeader({title, description, actions})`, `Definition({term})`.
- `Badge({tone})` tones: `neutral | success | warning | danger | info | demo`.
- `Button({variant: primary|secondary|ghost|danger, size: sm|md, loading})`, `buttonClass(variant, size)` for `<Link>`.
- Forms: `TextField`, `TextArea`, `SelectField` (labelled, `hint`, `error`), `Field`, `inputClass`.
- Table: `Table({caption})`, `THead`, `TBody`, `TR`, `TH`, `TD` (table scrolls inside its own container).
- States: `Spinner`, `LoadingState({label})`, `EmptyState({title, action})`, `ErrorState({error, onRetry})` (maps 412 → Setup required, 429 → Rate limited).
- Honest states: `StateBanner({state, message, title?, action?})`, `StateBadge({state})`, `stateLabel(state)`; `HonestState` =
  `CapabilityState | RunStatus | "no_data" | "insufficient_evidence" | "not_connected"`.
- `DemoBanner()` — already rendered by the project layout when `project.isDemo`; pages don't need to add it.
- `MetricTile({label, value, sublabel?, numerator?, denominator?, window?, source?, freshness?, state?})`.
- `CompletenessNote({completeness})`, `StatusBadge({status: RunStatus})`, `TierBadge({tier})` (act / flag = "Check this yourself" / drop = withheld).
- `Tabs({tabs: [{id, label, content}], label, value?, onChange?})` — accessible tablist.
- `Drawer({open, onClose, title, footer?})` — `role=dialog`, `aria-modal`, focus trap, Esc closes, focus restored.
- `PlainText({text})` — whitespace-preserving plain text for raw answers / crawled text.

## `@web/components/DecisionLog`
- `DecisionLog({decisions})` — [A3] table with tier badges, rejected reason codes and the [A18] "Disagree" control
  (POST `/decisions/:id/feedback`). Reuse it on recommendation detail.

## Routes (App.tsx) and placeholders
Project child routes import these named exports (placeholders were created by web-shell; overwrite them):
`pages/seo/SeoAuditPage.tsx` (`SeoAuditPage`, path `seo`), `pages/recommendations/RecommendationsPage.tsx`
(`RecommendationsPage`, `recommendations`), `pages/recommendations/RecommendationDetailPage.tsx`
(`RecommendationDetailPage`, `recommendations/:recId`), `pages/geo/GeoPromptsPage.tsx` (`GeoPromptsPage`, `geo/prompts`),
`pages/geo/GeoResultsPage.tsx` (`GeoResultsPage`, `geo/results`), `pages/geo/CompetitorsPage.tsx` (`CompetitorsPage`, `competitors`).
Read route params with `useParams()` (`projectId`, `recId`). Other shell routes: `runs`, `runs/:runId`, `integrations`, `usage`, `settings`.
