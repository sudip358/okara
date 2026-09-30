/**
 * Internal link suggester [A25]. Route: /projects/:projectId/internal-links
 * Suggestions come from the latest crawl of the verified site: source -> target, the sentence to link
 * from (plain text, anchor highlighted by string splitting), the anchor, the link's role, Jev's per-answer
 * confidence (or the deterministic method), and the user's status. Okara never edits pages.
 */
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import type { LinkRole, LinkSuggestion, LinkSuggestionReport } from "@shared/types";
import { api, ApiError, errorMessage } from "@web/lib/api";
import { formatDateTime, formatNumber } from "@web/lib/format";
import { useApi, useMutation } from "@web/lib/hooks";
import { projectPath } from "@web/lib/project-context";
import {
  Badge,
  Button,
  Card,
  CompletenessNote,
  EmptyState,
  ErrorState,
  LoadingState,
  MetricTile,
  PageHeader,
  SelectField,
  StateBadge,
  StateBanner,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  TierBadge,
  buttonClass,
  type BadgeTone,
} from "@web/components/ui";
import {
  DEFAULT_FILTERS,
  LINK_LABEL_CONFIDENCE,
  LINK_LABEL_REVIEW,
  ROLES,
  ROLE_LABEL,
  STATUS_FILTERS,
  USER_STATUS_LABEL,
  counts,
  extraLabels,
  filterSuggestions,
  pct,
  safeHref,
  shortUrl,
  splitAnchor,
  type LinkFilters,
  type UserStatus,
} from "./lib";

const STATUS_TONE: Record<LinkSuggestion["status"], BadgeTone> = { suggested: "success", review: "warning", rejected: "neutral" };
const STATUS_TEXT: Record<LinkSuggestion["status"], string> = { suggested: "Suggested", review: "Review", rejected: "Rejected" };
const USER_TONE: Record<UserStatus, BadgeTone> = { open: "neutral", accepted: "info", dismissed: "neutral", implemented: "success" };

export function InternalLinksPage() {
  const { projectId = "" } = useParams();
  const base = `/projects/${encodeURIComponent(projectId)}/seo/internal-links`;
  const report = useApi<LinkSuggestionReport>(projectId ? base : null);
  const runner = useMutation(() => api<LinkSuggestionReport>(`${base}/run`, { method: "POST" }));
  const r = report.data;

  const run = async () => {
    const next = await runner.run();
    if (next) report.setData(next);
  };

  const replaceSuggestion = (s: LinkSuggestion) => {
    if (!r) return;
    report.setData({ ...r, suggestions: r.suggestions.map((x) => (x.id === s.id ? s : x)) });
  };

  const exportHref = (format: "csv" | "json") => `/api${base}/export?format=${format}`;
  const hasSuggestions = !!r && r.suggestions.length > 0;

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        title="Internal links"
        description="Contextual internal-link suggestions from the latest crawl of your verified site: which page should link to which, from which sentence, and with which anchor text."
        actions={
          <>
            {r && <StateBadge state={r.state} />}
            <Button variant="primary" onClick={() => void run()} loading={runner.loading} disabled={!projectId}>
              {runner.loading ? "Analysing…" : r?.generatedAt ? "Run again" : "Run analysis"}
            </Button>
            {hasSuggestions ? (
              <>
                <a href={exportHref("csv")} download className={buttonClass("secondary")}>
                  Export CSV
                </a>
                <a href={exportHref("json")} download className={buttonClass("secondary")}>
                  Export JSON
                </a>
              </>
            ) : null}
          </>
        }
      />

      <div role="note" aria-label="How to read these suggestions" className="rounded-lg border border-sky-300 bg-sky-50 px-4 py-3 text-sm text-sky-950 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-100">
        <p className="font-semibold">{LINK_LABEL_REVIEW}</p>
        <p className="mt-1">{LINK_LABEL_CONFIDENCE}</p>
      </div>

      {runner.error ? <RunError error={runner.error} /> : null}

      {report.loading && !r ? (
        <LoadingState label="Loading internal-link suggestions…" />
      ) : report.error ? (
        <ErrorState error={report.error} onRetry={report.reload} />
      ) : r ? (
        <ReportView report={r} projectId={projectId} base={base} onChange={replaceSuggestion} />
      ) : null}
    </div>
  );
}

function RunError({ error }: { error: unknown }) {
  if (error instanceof ApiError && error.status === 409) return <StateBanner state="running" title="Already running" message={errorMessage(error)} />;
  if (error instanceof ApiError && error.status === 429) return <StateBanner state="rate_limited" message={errorMessage(error)} />;
  return <ErrorState error={error} title="Could not run the analysis" />;
}

function ReportView({ report: r, projectId, base, onChange }: { report: LinkSuggestionReport; projectId: string; base: string; onChange: (s: LinkSuggestion) => void }) {
  const notes = extraLabels(r.labels);

  if (r.state === "setup_required") {
    return (
      <StateBanner
        state="setup_required"
        message={notes.length ? notes.join(" ") : "Verify your site and run a crawl first."}
        action={
          <Link to={projectPath(projectId, "integrations")} className={buttonClass("secondary", "sm")}>
            Go to integrations
          </Link>
        }
      />
    );
  }

  const c = counts(r.suggestions);
  return (
    <div className="space-y-4">
      {r.state === "demo" && <StateBanner state="demo" message="Demo data – simulated crawl. Suggestions come from fictional pages; Jev is not called." />}

      <Card
        title="Summary"
        description={r.generatedAt ? `Analysed ${formatDateTime(r.generatedAt)} from the latest crawl.` : "Not analysed yet. Run the analysis to get suggestions from the latest crawl."}
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <MetricTile
            label="Pages analysed"
            value={formatNumber(r.pagesAnalysed)}
            sublabel={r.completeness?.total !== null && r.completeness?.total !== undefined ? `of ${formatNumber(r.completeness.total)} crawled HTML pages` : undefined}
          />
          <MetricTile label="Suggested" value={formatNumber(c.suggested)} sublabel="Jev act tier" />
          <MetricTile label="Review" value={formatNumber(c.review)} sublabel="Check these yourself" />
          <MetricTile label="Rejected" value={formatNumber(c.rejected)} sublabel="Jev: no / no fitting sentence" />
          <MetricTile label="Orphan pages" value={formatNumber(r.orphanPages.length)} sublabel="Within crawl coverage" />
          <MetricTile label="Your decisions" value={`${formatNumber(c.accepted + c.implemented + c.dismissed)} of ${formatNumber(r.suggestions.length)}`} sublabel={`${c.accepted} accepted · ${c.implemented} implemented · ${c.dismissed} dismissed`} />
        </div>
        <CompletenessNote completeness={r.completeness} className="mt-3" />
        {notes.length > 0 && (
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer font-medium text-zinc-800 dark:text-zinc-200">How these suggestions were made</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-zinc-700 dark:text-zinc-300">
              {notes.map((n, i) => (
                <li key={i} className="break-words">
                  {n}
                </li>
              ))}
            </ul>
          </details>
        )}
      </Card>

      <SuggestionsCard report={r} base={base} onChange={onChange} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Orphan pages" description="Crawled, indexable pages that no other crawled page links to. A page linked only from pages outside the crawl can appear here.">
          {r.orphanPages.length === 0 ? (
            <EmptyState title={r.generatedAt ? "No orphan pages within crawl coverage." : "Run the analysis to list orphan pages."} />
          ) : (
            <ul className="space-y-1 text-sm">
              {r.orphanPages.map((o) => (
                <li key={o.pageId} className="break-all">
                  <UrlText url={o.url} />
                </li>
              ))}
            </ul>
          )}
        </Card>
        <GenericAnchorsCard report={r} />
      </div>
    </div>
  );
}

function SuggestionsCard({ report: r, base, onChange }: { report: LinkSuggestionReport; base: string; onChange: (s: LinkSuggestion) => void }) {
  const [filters, setFilters] = useState<LinkFilters>(DEFAULT_FILTERS);
  const targets = useMemo(() => [...new Set(r.suggestions.map((s) => s.target.url))].sort(), [r.suggestions]);
  const shown = useMemo(() => filterSuggestions(r.suggestions, filters), [r.suggestions, filters]);
  const set = (patch: Partial<LinkFilters>) => setFilters((f) => ({ ...f, ...patch }));

  return (
    <Card title="Suggestions" description="Ranked by the deterministic candidate score. Add the link on your site yourself, then mark it implemented; it disappears once a new crawl sees the link.">
      {r.suggestions.length === 0 ? (
        <EmptyState title={r.generatedAt ? "No new internal-link opportunities in the latest crawl." : "No suggestions yet."}>
          {r.generatedAt ? "Every candidate pair already links, or no page's sentences mention another page's defining terms." : "Run the analysis to build suggestions from the latest crawl."}
        </EmptyState>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <SelectField id="links-filter-status" label="Status" value={filters.status} onChange={(e) => set({ status: e.target.value as LinkFilters["status"] })}>
              {STATUS_FILTERS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </SelectField>
            <SelectField id="links-filter-role" label="Role" value={filters.role} onChange={(e) => set({ role: e.target.value as LinkFilters["role"] })}>
              <option value="all">All roles</option>
              {ROLES.map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABEL[role]}
                </option>
              ))}
              <option value="none">No role</option>
            </SelectField>
            <SelectField id="links-filter-target" label="Target page" value={filters.target} onChange={(e) => set({ target: e.target.value })}>
              <option value="all">All targets</option>
              {targets.map((t) => (
                <option key={t} value={t}>
                  {shortUrl(t)}
                </option>
              ))}
            </SelectField>
            <SelectField id="links-filter-user" label="Your status" value={filters.user} onChange={(e) => set({ user: e.target.value as LinkFilters["user"] })}>
              <option value="all">All</option>
              {(Object.keys(USER_STATUS_LABEL) as UserStatus[]).map((u) => (
                <option key={u} value={u}>
                  {USER_STATUS_LABEL[u]}
                </option>
              ))}
            </SelectField>
          </div>
          <p className="text-sm text-zinc-600 dark:text-zinc-400" aria-live="polite">
            Showing {shown.length} of {r.suggestions.length} suggestion{r.suggestions.length === 1 ? "" : "s"}.
          </p>
          {shown.length === 0 ? (
            <EmptyState title="No suggestions match these filters." />
          ) : (
            <Table caption="Internal-link suggestions">
              <THead>
                <TR>
                  <TH>Link</TH>
                  <TH>Sentence and anchor</TH>
                  <TH>Role</TH>
                  <TH>Judgment</TH>
                  <TH>Your status</TH>
                </TR>
              </THead>
              <TBody>
                {shown.map((s) => (
                  <SuggestionRow key={s.id} s={s} base={base} onChange={onChange} />
                ))}
              </TBody>
            </Table>
          )}
        </div>
      )}
    </Card>
  );
}

function SuggestionRow({ s, base, onChange }: { s: LinkSuggestion; base: string; onChange: (s: LinkSuggestion) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setStatus = async (userStatus: UserStatus) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await api<LinkSuggestion>(`${base}/${encodeURIComponent(s.id)}`, { method: "PATCH", body: { userStatus } }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const parts = s.sentence ? splitAnchor(s.sentence.text, s.anchor?.text) : null;
  const d = s.decision;

  return (
    <TR>
      <TD className="min-w-56 max-w-72">
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">From</p>
        <p className="break-words font-medium">{s.source.title ?? shortUrl(s.source.url)}</p>
        <p className="break-all text-xs"><UrlText url={s.source.url} /></p>
        <p className="mt-2 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          <span aria-hidden="true">→ </span>To
        </p>
        <p className="break-words font-medium">{s.target.title ?? shortUrl(s.target.url)}</p>
        <p className="break-all text-xs"><UrlText url={s.target.url} /></p>
        <div className="mt-1 flex flex-wrap gap-1">
          {s.target.orphan ? <Badge tone="warning">Orphan target</Badge> : <Badge tone="neutral">{s.target.inlinks} inlink{s.target.inlinks === 1 ? "" : "s"}</Badge>}
        </div>
      </TD>
      <TD className="min-w-64 max-w-md">
        {s.sentence ? (
          <p className="break-words">
            {parts ? (
              <>
                {parts.before}
                <mark className="rounded bg-amber-200 px-0.5 font-medium text-zinc-900 dark:bg-amber-400/30 dark:text-amber-50">{parts.match}</mark>
                {parts.after}
              </>
            ) : (
              s.sentence.text
            )}
          </p>
        ) : (
          <p className="text-zinc-500">No sentence.</p>
        )}
        <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
          Anchor: {s.anchor ? <span className="font-medium text-zinc-900 dark:text-zinc-100">{s.anchor.text}</span> : "none"}
        </p>
        {s.reasons.length > 0 && (
          <details className="mt-1 text-xs">
            <summary className="cursor-pointer text-zinc-700 dark:text-zinc-300">Why (score {s.score.toFixed(2)})</summary>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-zinc-700 dark:text-zinc-300">
              {s.reasons.map((reason, i) => (
                <li key={i} className="break-words">
                  {reason}
                </li>
              ))}
            </ul>
          </details>
        )}
      </TD>
      <TD className="whitespace-nowrap">{s.role ? <RoleBadge role={s.role} /> : <span className="text-xs text-zinc-500 dark:text-zinc-400">No role</span>}</TD>
      <TD className="min-w-48">
        <div className="flex flex-wrap gap-1">
          <Badge tone={STATUS_TONE[s.status]}>{STATUS_TEXT[s.status]}</Badge>
          {s.method === "jev" ? <TierBadge tier={d?.tier ?? null} /> : null}
          <Badge tone={s.method === "jev" ? "info" : "neutral"} title={s.method === "jev" ? "Judged by Jev" : "Best sentence and anchor by score; no Jev judgment"}>
            {s.method === "jev" ? "Jev" : "Deterministic"}
          </Badge>
        </div>
        {d ? (
          <dl className="mt-1 grid grid-cols-[auto_auto] gap-x-2 text-xs text-zinc-700 dark:text-zinc-300">
            <dt>Should exist (Noul)</dt>
            <dd className="tabular-nums">{d.shouldExist === null ? "withheld" : d.shouldExist.toFixed(2)}</dd>
            <dt>Sentence</dt>
            <dd className="tabular-nums">{d.sentenceConfidence === null ? "withheld" : pct(d.sentenceConfidence)}</dd>
            <dt>Anchor</dt>
            <dd className="tabular-nums">{d.anchorConfidence === null ? "withheld" : pct(d.anchorConfidence)}</dd>
            <dt>Role</dt>
            <dd className="tabular-nums">{d.roleConfidence === null ? "—" : pct(d.roleConfidence)}</dd>
            {d.model && (
              <>
                <dt>Model</dt>
                <dd className="break-all">{d.model}</dd>
              </>
            )}
          </dl>
        ) : (
          <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">No Jev judgment.</p>
        )}
      </TD>
      <TD className="min-w-40">
        <Badge tone={USER_TONE[s.userStatus]}>{USER_STATUS_LABEL[s.userStatus]}</Badge>
        <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label="Set your status">
          {s.userStatus !== "accepted" && (
            <Button size="sm" onClick={() => void setStatus("accepted")} disabled={busy}>
              Accept
            </Button>
          )}
          {s.userStatus !== "implemented" && (
            <Button size="sm" onClick={() => void setStatus("implemented")} disabled={busy}>
              Mark implemented
            </Button>
          )}
          {s.userStatus !== "dismissed" && (
            <Button size="sm" variant="ghost" onClick={() => void setStatus("dismissed")} disabled={busy}>
              Dismiss
            </Button>
          )}
          {s.userStatus !== "open" && (
            <Button size="sm" variant="ghost" onClick={() => void setStatus("open")} disabled={busy}>
              Reopen
            </Button>
          )}
        </div>
        {error && (
          <p role="alert" className="mt-1 text-xs text-red-700 dark:text-red-400">
            {error}
          </p>
        )}
      </TD>
    </TR>
  );
}

function RoleBadge({ role }: { role: LinkRole }) {
  return <Badge tone="info">{ROLE_LABEL[role]}</Badge>;
}

function GenericAnchorsCard({ report: r }: { report: LinkSuggestionReport }) {
  return (
    <Card title="Generic anchor text" description='Existing internal links whose anchor text says nothing about the target ("click here", "read more"). Replace them with descriptive text.'>
      {r.genericAnchors.length === 0 ? (
        <EmptyState title={r.generatedAt ? "No generic anchors found in the crawled pages." : "Run the analysis to list generic anchors."} />
      ) : (
        <Table caption="Internal links with generic anchor text">
          <THead>
            <TR>
              <TH>On page</TH>
              <TH>Anchor</TH>
              <TH>Links to</TH>
            </TR>
          </THead>
          <TBody>
            {r.genericAnchors.map((g, i) => (
              <TR key={`${g.sourceUrl}|${g.targetUrl}|${i}`}>
                <TD className="break-all">
                  <UrlText url={g.sourceUrl} />
                </TD>
                <TD className="whitespace-nowrap font-medium">“{g.anchor}”</TD>
                <TD className="break-all">
                  <UrlText url={g.targetUrl} />
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}

/** The user's own crawled URL as an external link (http/https only), shown as its path. */
function UrlText({ url }: { url: string }) {
  const href = safeHref(url);
  const text = shortUrl(url);
  if (!href) return <span>{text}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" title={url} className="text-sky-700 underline-offset-2 hover:underline dark:text-sky-400">
      {text}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
