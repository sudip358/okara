/**
 * Suggestions tab: priority-sorted internal-link suggestions with filters (status, role, hub, cluster gap, method,
 * your status, verification, target), bulk accept/dismiss/implement, and exports (CSV, JSON, the owner's sheet format
 * for all rows or the selection). Sentences and drafts are plain text; the anchor is highlighted by string splitting.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router";
import type { LinkSuggestion, LinkSuggestionReport } from "@shared/types";
import { api, errorMessage } from "@web/lib/api";
import { formatDate, formatDateTime, formatNumber } from "@web/lib/format";
import { projectPath } from "@web/lib/project-context";
import {
  Badge,
  Button,
  Card,
  CompletenessNote,
  EmptyState,
  MetricTile,
  SelectField,
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
  DRAFT_LABEL,
  METHOD_LABEL,
  ROLES,
  ROLE_LABEL,
  STATUS_FILTERS,
  USER_STATUS_LABEL,
  VERIFICATION_FILTERS,
  counts,
  exportHref,
  extraLabels,
  filterSuggestions,
  jevNotices,
  pct,
  positionBandLabel,
  shortUrl,
  sortSuggestions,
  splitAnchor,
  suggestionHubs,
  type LinkFilters,
  type SuggestionSort,
  type UserStatus,
} from "./lib";
import { MethodNotes, UrlText, VerificationBadge } from "./parts";

const STATUS_TONE: Record<LinkSuggestion["status"], BadgeTone> = { suggested: "success", review: "warning", rejected: "neutral" };
const STATUS_TEXT: Record<LinkSuggestion["status"], string> = { suggested: "Suggested", review: "Review", rejected: "Rejected" };
const USER_TONE: Record<UserStatus, BadgeTone> = { open: "neutral", accepted: "info", dismissed: "neutral", implemented: "success" };

export function SuggestionsTab({
  report: r,
  projectId,
  base,
  onChange,
}: {
  report: LinkSuggestionReport;
  projectId: string;
  base: string;
  onChange: (changed: LinkSuggestion[]) => void;
}) {
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
  const jev = jevNotices(r.labels);
  return (
    <div className="space-y-4">
      {r.state === "demo" && <StateBanner state="demo" message="Demo data – simulated crawl. Suggestions come from fictional pages; Jev and the writer are not called." />}
      {jev.budget && <StateBanner state="rate_limited" title="Jev budget reached" message={jev.budget} />}
      {jev.unavailable && <StateBanner state="partial" title="Jev unavailable" message={jev.unavailable} />}
      {jev.notConfigured && (
        <StateBanner
          state="not_connected"
          title="Jev not configured"
          message={jev.notConfigured}
          action={
            <Link to={projectPath(projectId, "integrations")} className={buttonClass("secondary", "sm")}>
              Integrations
            </Link>
          }
        />
      )}
      {r.drafts && r.drafts.state === "setup_required" && (
        <StateBanner
          state="setup_required"
          title="Drafted sentences need a writer"
          message={r.drafts.label}
          action={
            <Link to={projectPath(projectId, "integrations")} className={buttonClass("secondary", "sm")}>
              Set up a writer
            </Link>
          }
        />
      )}
      {r.drafts && r.drafts.state === "partial" && <StateBanner state="partial" title="Drafting stopped early" message={r.drafts.label} />}

      <Card
        title="Summary"
        description={r.generatedAt ? `Analysed ${formatDateTime(r.generatedAt)} from the latest snapshot of every crawled page.` : "Not analysed yet. Run the analysis to get suggestions."}
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <MetricTile
            label="Pages analysed"
            value={formatNumber(r.pagesAnalysed)}
            sublabel={r.completeness?.total !== null && r.completeness?.total !== undefined ? `of ${formatNumber(r.completeness.total)} crawled HTML pages` : undefined}
          />
          <MetricTile label="Suggested" value={formatNumber(c.suggested)} sublabel="Jev act tier" />
          <MetricTile label="Review" value={formatNumber(c.review)} sublabel="Check these yourself" />
          <MetricTile label="Cluster gaps" value={formatNumber(c.gaps)} sublabel="Missing hub/spoke links" />
          <MetricTile label="Drafted sentences" value={formatNumber(c.drafts)} sublabel={r.drafts ? `cap ${r.drafts.cap} per run` : "No drafts this run"} />
          <MetricTile label="Your decisions" value={`${formatNumber(c.accepted + c.implemented + c.dismissed)} of ${formatNumber(r.suggestions.length)}`} sublabel={`${c.accepted} accepted · ${c.implemented} implemented · ${c.dismissed} dismissed`} />
        </div>
        <CompletenessNote completeness={r.completeness} className="mt-3" />
        <div className="mt-3">
          <MethodNotes notes={notes} title="How these suggestions were made" />
        </div>
      </Card>

      <SuggestionsCard report={r} base={base} onChange={onChange} />

      {r.genericAnchors.length > 0 && (
        <Card title="Generic anchor text" description='Existing internal links whose anchor text says nothing about the target ("click here", "read more"). The Anchors tab audits every target.'>
          <ul className="space-y-1 text-sm">
            {r.genericAnchors.slice(0, 50).map((g, i) => (
              <li key={`${g.sourceUrl}|${g.targetUrl}|${i}`} className="break-words">
                <UrlText url={g.sourceUrl} /> <span className="font-medium">“{g.anchor}”</span> <span aria-hidden="true">→</span> <UrlText url={g.targetUrl} />
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function SuggestionsCard({ report: r, base, onChange }: { report: LinkSuggestionReport; base: string; onChange: (changed: LinkSuggestion[]) => void }) {
  const [filters, setFilters] = useState<LinkFilters>(DEFAULT_FILTERS);
  const [sort, setSort] = useState<SuggestionSort>("priority");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const targets = useMemo(() => [...new Set(r.suggestions.map((s) => s.target.url))].sort(), [r.suggestions]);
  const hubs = useMemo(() => suggestionHubs(r.suggestions), [r.suggestions]);
  const shown = useMemo(() => sortSuggestions(filterSuggestions(r.suggestions, filters), sort), [r.suggestions, filters, sort]);
  const set = (patch: Partial<LinkFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const visibleIds = shown.map((s) => s.id);
  const selectedVisible = visibleIds.filter((id) => selected.has(id));
  const allSelected = visibleIds.length > 0 && selectedVisible.length === visibleIds.length;
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const bulk = async (userStatus: UserStatus) => {
    const ids = selectedVisible.slice(0, 200);
    if (!ids.length) return;
    setBulkBusy(true);
    setBulkError(null);
    try {
      const res = await api<{ updated: number; suggestions: LinkSuggestion[] }>(`${base}/bulk`, { method: "POST", body: { ids, userStatus } });
      onChange(res.suggestions);
      setSelected(new Set());
    } catch (e) {
      setBulkError(errorMessage(e));
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <Card
      title="Suggestions"
      description="Sorted by priority: relevance × Search Console impact × cluster gap (the numbers are under each priority). Add the link on your site yourself, then mark it implemented; the next crawl of the source page verifies it."
      actions={
        r.suggestions.length > 0 ? (
          <>
            <a href={exportHref(base, "sheet")} download className={buttonClass("secondary", "sm")} title='Columns: "Date","Source Article URL","Target URL","Anchor","Method","Hub","Status"'>
              Export sheet format
            </a>
            <a href={exportHref(base, "csv")} download className={buttonClass("ghost", "sm")}>
              CSV
            </a>
            <a href={exportHref(base, "json")} download className={buttonClass("ghost", "sm")}>
              JSON
            </a>
          </>
        ) : null
      }
    >
      {r.suggestions.length === 0 ? (
        <EmptyState title={r.generatedAt ? "No new internal-link opportunities in the link graph." : "No suggestions yet."}>
          {r.generatedAt ? "Every candidate pair already links, or no page's sentences mention another page's defining terms." : "Run the analysis to build suggestions from the latest snapshot of every crawled page."}
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
            <SelectField id="links-filter-hub" label="Hub / cluster" value={filters.hub ?? "all"} onChange={(e) => set({ hub: e.target.value })}>
              <option value="all">All</option>
              {hubs.map((h) => (
                <option key={h.url} value={h.url}>
                  {h.title ?? shortUrl(h.url)}
                </option>
              ))}
              <option value="none">No cluster</option>
            </SelectField>
            <SelectField id="links-filter-gap" label="Cluster gap" value={filters.gap ?? "all"} onChange={(e) => set({ gap: e.target.value as LinkFilters["gap"] })}>
              <option value="all">All</option>
              <option value="gap">Closes a cluster gap</option>
              <option value="no_gap">Other links</option>
            </SelectField>
            <SelectField id="links-filter-method" label="Method" value={filters.method ?? "all"} onChange={(e) => set({ method: e.target.value as LinkFilters["method"] })}>
              <option value="all">All</option>
              <option value="existing_sentence">{METHOD_LABEL.existing_sentence}</option>
              <option value="draft_sentence">{METHOD_LABEL.draft_sentence}</option>
            </SelectField>
            <SelectField id="links-filter-user" label="Your status" value={filters.user} onChange={(e) => set({ user: e.target.value as LinkFilters["user"] })}>
              <option value="all">All</option>
              {(Object.keys(USER_STATUS_LABEL) as UserStatus[]).map((u) => (
                <option key={u} value={u}>
                  {USER_STATUS_LABEL[u]}
                </option>
              ))}
            </SelectField>
            <SelectField id="links-filter-verification" label="Verification" value={filters.verification ?? "all"} onChange={(e) => set({ verification: e.target.value as LinkFilters["verification"] })}>
              {VERIFICATION_FILTERS.map((v) => (
                <option key={v.value} value={v.value}>
                  {v.label}
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
          </div>
          <div className="flex flex-wrap items-end justify-between gap-2">
            <p className="text-sm text-zinc-600 dark:text-zinc-400" aria-live="polite">
              Showing {shown.length} of {r.suggestions.length} suggestion{r.suggestions.length === 1 ? "" : "s"}
              {selectedVisible.length ? ` · ${selectedVisible.length} selected` : ""}.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1 text-xs text-zinc-700 dark:text-zinc-300">
                Sort
                <select className="rounded border border-zinc-300 bg-white px-1.5 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-950" value={sort} onChange={(e) => setSort(e.target.value as SuggestionSort)} aria-label="Sort suggestions">
                  <option value="priority">Priority</option>
                  <option value="score">Relevance score (legacy)</option>
                </select>
              </label>
              <div role="group" aria-label="Bulk actions on selected suggestions" className="flex flex-wrap gap-1">
                <Button size="sm" onClick={() => void bulk("accepted")} disabled={!selectedVisible.length || bulkBusy}>
                  Accept selected
                </Button>
                <Button size="sm" onClick={() => void bulk("implemented")} disabled={!selectedVisible.length || bulkBusy}>
                  Mark implemented
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void bulk("dismissed")} disabled={!selectedVisible.length || bulkBusy}>
                  Dismiss selected
                </Button>
                {selectedVisible.length > 0 && (
                  <a href={exportHref(base, "sheet", { ids: selectedVisible })} download className={buttonClass("ghost", "sm")}>
                    Export selection
                  </a>
                )}
              </div>
            </div>
          </div>
          {bulkError && (
            <p role="alert" className="text-sm text-red-700 dark:text-red-400">
              {bulkError}
            </p>
          )}
          {shown.length === 0 ? (
            <EmptyState title="No suggestions match these filters." />
          ) : (
            <Table caption="Internal-link suggestions, highest priority first">
              <THead>
                <TR>
                  <TH className="w-8">
                    <input
                      type="checkbox"
                      aria-label={allSelected ? "Clear the selection" : "Select every suggestion shown"}
                      checked={allSelected}
                      onChange={() => setSelected(allSelected ? new Set() : new Set(visibleIds))}
                    />
                  </TH>
                  <TH>Link</TH>
                  <TH>Sentence and anchor</TH>
                  <TH>Priority</TH>
                  <TH>Judgment</TH>
                  <TH>Your status</TH>
                </TR>
              </THead>
              <TBody>
                {shown.map((s) => (
                  <SuggestionRow key={s.id} s={s} base={base} onChange={onChange} selected={selected.has(s.id)} onToggle={() => toggle(s.id)} />
                ))}
              </TBody>
            </Table>
          )}
        </div>
      )}
    </Card>
  );
}

function SuggestionRow({ s, base, onChange, selected, onToggle }: { s: LinkSuggestion; base: string; onChange: (changed: LinkSuggestion[]) => void; selected: boolean; onToggle: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setStatus = async (userStatus: UserStatus) => {
    setBusy(true);
    setError(null);
    try {
      onChange([await api<LinkSuggestion>(`${base}/${encodeURIComponent(s.id)}`, { method: "PATCH", body: { userStatus } })]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const d = s.decision;
  const p = s.priority;

  return (
    <TR>
      <TD>
        <input type="checkbox" checked={selected} onChange={onToggle} aria-label={`Select the link from ${shortUrl(s.source.url)} to ${shortUrl(s.target.url)}`} />
      </TD>
      <TD className="min-w-56 max-w-72">
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">From</p>
        <p className="break-words font-medium">{s.source.title ?? shortUrl(s.source.url)}</p>
        <p className="break-all text-xs">
          <UrlText url={s.source.url} />
        </p>
        {s.sourceSnapshot?.stale && <Badge tone="warning">Snapshot {formatDate(s.sourceSnapshot.fetchedAt)} (stale)</Badge>}
        <p className="mt-2 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          <span aria-hidden="true">→ </span>To
        </p>
        <p className="break-words font-medium">{s.target.title ?? shortUrl(s.target.url)}</p>
        <p className="break-all text-xs">
          <UrlText url={s.target.url} />
        </p>
        <div className="mt-1 flex flex-wrap gap-1">
          {s.target.orphan ? <Badge tone="warning">Orphan target</Badge> : <Badge tone="neutral">{s.target.inlinks} inlink{s.target.inlinks === 1 ? "" : "s"}</Badge>}
          {s.cluster?.gap && (
            <Badge tone="info" title={s.cluster.gap === "hub_to_spoke" ? "The hub does not link to this spoke yet" : "The spoke does not link back to its hub yet"}>
              Cluster gap
            </Badge>
          )}
          {s.cluster && <Badge tone="neutral">Hub: {s.cluster.hubTitle ?? shortUrl(s.cluster.hubUrl)}</Badge>}
        </div>
      </TD>
      <TD className="min-w-64 max-w-md">
        {s.placement === "draft_sentence" && s.draft ? (
          <DraftBlock s={s} />
        ) : s.sentence ? (
          <SentenceText text={s.sentence.text} anchor={s.anchor?.text} />
        ) : (
          <p className="text-zinc-500">No sentence.</p>
        )}
        <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
          Anchor: {s.anchor ? <span className="font-medium text-zinc-900 dark:text-zinc-100">{s.anchor.text}</span> : "none"} ·{" "}
          {s.placement === "draft_sentence" ? "insert PK sentence" : "wrap existing"}
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
      <TD className="min-w-40">
        {p ? (
          <>
            <p className="text-lg font-semibold tabular-nums">{p.value.toFixed(2)}</p>
            <p className="text-xs text-zinc-600 dark:text-zinc-400">
              {p.target.impressions !== null ? `${formatNumber(p.target.impressions)} impr.` : "No GSC data"}
              {p.target.position !== null ? ` · pos ${p.target.position.toFixed(1)}` : ""}
            </p>
            {p.positionBand === "striking_distance" && <Badge tone="info">Striking distance</Badge>}
            <details className="mt-1 text-xs">
              <summary className="cursor-pointer text-zinc-700 dark:text-zinc-300">Numbers behind it</summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-zinc-700 dark:text-zinc-300">
                {p.explanation.map((line, i) => (
                  <li key={i} className="break-words">
                    {line}
                  </li>
                ))}
                <li>Position band: {positionBandLabel(p.positionBand)}.</li>
              </ul>
            </details>
          </>
        ) : (
          <span className="text-xs text-zinc-500 dark:text-zinc-400">—</span>
        )}
      </TD>
      <TD className="min-w-48">
        <div className="flex flex-wrap gap-1">
          <Badge tone={STATUS_TONE[s.status]}>{STATUS_TEXT[s.status]}</Badge>
          {s.method === "jev" ? <TierBadge tier={d?.tier ?? null} /> : null}
          <Badge tone={s.method === "jev" ? "info" : "neutral"} title={s.method === "jev" ? "Judged by Jev" : "Best sentence and anchor by score; no Jev judgment"}>
            {s.method === "jev" ? "Jev" : "Deterministic"}
          </Badge>
          {s.role && <Badge tone="info">{ROLE_LABEL[s.role]}</Badge>}
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
        <div className="flex flex-wrap gap-1">
          <Badge tone={USER_TONE[s.userStatus]}>{USER_STATUS_LABEL[s.userStatus]}</Badge>
          <VerificationBadge v={s.verification} />
        </div>
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

function SentenceText({ text, anchor }: { text: string; anchor: string | null | undefined }) {
  const parts = splitAnchor(text, anchor);
  return (
    <p className="break-words">
      {parts ? (
        <>
          {parts.before}
          <mark className="rounded bg-amber-200 px-0.5 font-medium text-zinc-900 dark:bg-amber-400/30 dark:text-amber-50">{parts.match}</mark>
          {parts.after}
        </>
      ) : (
        text
      )}
    </p>
  );
}

function DraftBlock({ s }: { s: LinkSuggestion }) {
  const d = s.draft!;
  return (
    <div className="rounded-lg border border-dashed border-violet-300 bg-violet-50 p-2 dark:border-violet-800 dark:bg-violet-950/40">
      <p className="text-xs font-semibold text-violet-900 dark:text-violet-200">{DRAFT_LABEL}</p>
      {d.text ? <SentenceText text={d.text} anchor={s.anchor?.text} /> : <p className="text-sm text-zinc-600 dark:text-zinc-400">No usable draft.</p>}
      {d.insertAfter && (
        <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
          Insert after: <span className="italic">“{d.insertAfter}”</span>
        </p>
      )}
      <p className="mt-1 text-xs">
        {d.validation.ok ? (
          <Badge tone="success">Passed validation</Badge>
        ) : (
          <Badge tone="danger" title={d.validation.errors.join(" ")}>
            Rejected by validation
          </Badge>
        )}{" "}
        {d.writer && <span className="text-zinc-600 dark:text-zinc-400">Writer: {d.writer.provider} · {d.writer.model}</span>}
      </p>
      {(d.validation.errors.length > 0 || d.validation.warnings.length > 0 || d.evidence.length > 0) && (
        <details className="mt-1 text-xs">
          <summary className="cursor-pointer text-zinc-700 dark:text-zinc-300">Evidence and checks</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-zinc-700 dark:text-zinc-300">
            {d.validation.errors.map((e, i) => (
              <li key={`e${i}`} className="text-red-700 dark:text-red-400">
                {e}
              </li>
            ))}
            {d.validation.warnings.map((w, i) => (
              <li key={`w${i}`}>{w}</li>
            ))}
            {d.evidence.map((e) => (
              <li key={e.id} className="break-words">
                <span className="font-mono">{e.id}</span>
                {d.citedEvidenceIds.includes(e.id) ? " (cited)" : ""}: {e.text}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
