/**
 * DataForSEO competitor data on the Competitors page: per competitor domain an overview (organic keywords,
 * estimated traffic, rank buckets), top ranked keywords, the keyword gap vs the project's domain, and top
 * pages, with provenance ("DataForSEO estimate · location · fetched date · cost"). Owner-only "Refresh data"
 * (paid; CSRF via the api client; server-side caps and rate limits). Keywords and URLs are untrusted
 * third-party text rendered as plain text (URLs only as safe http(s) links). Not Search Console data.
 */
import { useId, useState } from "react";
import { Link } from "react-router";
import type {
  CompetitorDataPanel,
  CompetitorDomainDetail,
  CompetitorDomainSummary,
  CompetitorLocationOption,
  CompetitorRefreshResult,
} from "@shared/competitor-data";
import { api, errorMessage } from "@web/lib/api";
import { useApi, useMutation, usePolling } from "@web/lib/hooks";
import { formatDateTime } from "@web/lib/format";
import { projectPath } from "@web/lib/project-context";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  MetricTile,
  SelectField,
  StateBanner,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  type BadgeTone,
} from "@web/components/ui";
import { ExternalUrl } from "@web/components/ExternalUrl";
import {
  ESTIMATE_NOTE,
  FETCH_STATUS_LABEL,
  GAP_NOTE,
  bucketGroups,
  estimate,
  locationLabel,
  maxCostText,
  provenanceLabel,
  refreshCostNote,
  refreshState,
  shouldPoll,
} from "./competitor-data-lib";

const base = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/competitors/dataforseo`;

const STATUS_TONE: Record<string, BadgeTone> = {
  queued: "neutral",
  running: "info",
  completed: "success",
  partial: "warning",
  failed: "danger",
  setup_required: "warning",
};

/** Loads the panel and polls it while a refresh is queued or running. */
export function CompetitorDataSection({ projectId }: { projectId: string }) {
  const panel = useApi<CompetitorDataPanel>(projectId ? base(projectId) : null);
  usePolling(panel.reload, shouldPoll(panel.data), 4000);
  return (
    <Card
      title="Search data (DataForSEO)"
      description={ESTIMATE_NOTE}
      actions={
        <Link to={projectPath(projectId, "integrations")} className="rounded text-xs text-sky-700 underline focus-visible:outline-2 focus-visible:outline-sky-600 dark:text-sky-400">
          DataForSEO settings
        </Link>
      }
    >
      {panel.loading && !panel.data ? (
        <LoadingState />
      ) : panel.error && !panel.data ? (
        <ErrorState error={panel.error} onRetry={panel.reload} />
      ) : panel.data ? (
        <CompetitorDataView projectId={projectId} panel={panel.data} onChange={(next) => (next ? panel.setData(next) : panel.reload())} />
      ) : null}
    </Card>
  );
}

export function CompetitorDataView({
  projectId,
  panel,
  onChange,
  openDomain,
}: {
  projectId: string;
  panel: CompetitorDataPanel;
  onChange: (next?: CompetitorDataPanel) => void;
  /** Domain whose tables start expanded (tests). */
  openDomain?: string;
}) {
  return (
    <div className="space-y-4">
      {panel.state !== "ready" && (
        <StateBanner
          state={panel.state}
          message={panel.message ?? undefined}
          action={
            panel.credentialSource === "none" ? (
              <Link to={projectPath(projectId, "integrations")} className="text-xs font-medium underline">
                Add DataForSEO credentials
              </Link>
            ) : undefined
          }
        />
      )}
      <LocationSettings projectId={projectId} panel={panel} onChange={onChange} />
      {panel.canManage && panel.state === "ready" && <p className="text-xs text-zinc-600 dark:text-zinc-400">{refreshCostNote(panel)}</p>}
      {panel.domains.length === 0 ? (
        <EmptyState title="No competitor domains.">Add competitors with their domains in project settings to pull DataForSEO data.</EmptyState>
      ) : (
        <ul className="space-y-3">
          {panel.domains.map((d) => (
            <li key={d.domain}>
              <CompetitorDomainPanel projectId={projectId} panel={panel} d={d} onChange={onChange} initiallyOpen={openDomain === d.domain} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LocationSettings({ projectId, panel, onChange }: { projectId: string; panel: CompetitorDataPanel; onChange: (next?: CompetitorDataPanel) => void }) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [options, setOptions] = useState<CompetitorLocationOption[] | null>(null);
  const [loc, setLoc] = useState<number | null>(panel.location?.locationCode ?? null);
  const [lang, setLang] = useState<string>(panel.location?.languageCode ?? "");
  const load = useMutation(() => api<CompetitorLocationOption[]>(`${base(projectId)}/locations`));
  const save = useMutation((body: unknown) => api<CompetitorDataPanel>(`${base(projectId)}/settings`, { method: "PUT", body }));
  const needsChoice = panel.state === "setup_required" && panel.credentialSource !== "none" && !panel.location;
  const selected = options?.find((o) => o.locationCode === loc) ?? null;

  const open = async () => {
    setEditing(true);
    if (!options) {
      const r = await load.run();
      if (r) setOptions(r);
    }
  };

  return (
    <div className="flex flex-wrap items-start justify-between gap-2 rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">
      <div className="min-w-0 space-y-1">
        <p>
          <span className="font-medium">Location:</span> {locationLabel(panel.location)}
          {panel.locationSource === "auto" && " (from the project locale)"}
          {panel.locationSource === "user" && " (chosen by the owner)"}
        </p>
        <p>
          <span className="font-medium">Pull data when a competitor is added:</span> {panel.autoFetch ? "on" : "off"} · up to {panel.caps.refreshesPerDomainPerDay} refreshes per domain and {panel.caps.fetchesPerProjectPerDay} per project per UTC day ({panel.caps.fetchesToday} used today)
        </p>
      </div>
      {panel.canManage && panel.credentialSource !== "none" && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant={needsChoice ? "primary" : "secondary"} loading={load.loading} onClick={open}>
            {needsChoice ? "Choose location" : "Change location"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            loading={save.loading}
            onClick={async () => {
              const r = await save.run({ autoFetch: !panel.autoFetch });
              if (r) onChange(r);
            }}
          >
            {panel.autoFetch ? "Turn off auto-pull" : "Turn on auto-pull"}
          </Button>
        </div>
      )}
      {editing && options && (
        <form
          className="flex w-full flex-wrap items-end gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (loc === null || !lang) return;
            const r = await save.run({ location: { locationCode: loc, languageCode: lang } });
            if (r) {
              setEditing(false);
              onChange(r);
            }
          }}
        >
          <div className="min-w-0 flex-1 sm:max-w-xs">
            <SelectField
              id={`${id}-loc`}
              label="DataForSEO location"
              value={loc ?? ""}
              onChange={(e) => {
                const code = Number(e.target.value);
                setLoc(Number.isFinite(code) && code > 0 ? code : null);
                const o = options.find((x) => x.locationCode === code);
                setLang(o?.languages[0]?.languageCode ?? "");
              }}
            >
              <option value="">Choose…</option>
              {options.map((o) => (
                <option key={o.locationCode} value={o.locationCode}>
                  {o.locationName}
                </option>
              ))}
            </SelectField>
          </div>
          <div className="min-w-0 flex-1 sm:max-w-xs">
            <SelectField id={`${id}-lang`} label="Language" value={lang} onChange={(e) => setLang(e.target.value)} disabled={!selected}>
              {(selected?.languages ?? []).map((l) => (
                <option key={l.languageCode} value={l.languageCode}>
                  {l.languageName}
                </option>
              ))}
            </SelectField>
          </div>
          <Button type="submit" size="sm" variant="primary" disabled={loc === null || !lang} loading={save.loading}>
            Save location
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </form>
      )}
      {[load.error, save.error].map((e, i) =>
        e !== null ? (
          <p key={i} role="alert" className="w-full text-red-700 dark:text-red-400">
            {errorMessage(e)}
          </p>
        ) : null,
      )}
    </div>
  );
}

export function CompetitorDomainPanel({
  projectId,
  panel,
  d,
  onChange,
  initiallyOpen = false,
}: {
  projectId: string;
  panel: CompetitorDataPanel;
  d: CompetitorDomainSummary;
  onChange: (next?: CompetitorDataPanel) => void;
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const refresh = useMutation(() => api<CompetitorRefreshResult>(`${base(projectId)}/refresh`, { method: "POST", body: { domain: d.domain } }));
  const rs = refreshState(panel, d);
  const f = d.latestFetch;
  const o = d.snapshot?.overview ?? null;

  return (
    <article aria-label={`DataForSEO data for ${d.domain}`} className="min-w-0 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="break-all text-sm font-semibold text-zinc-900 dark:text-zinc-100">{d.domain}</h3>
          <p className="break-words text-xs text-zinc-600 dark:text-zinc-400">{d.competitorName}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {f && (
            <Badge tone={STATUS_TONE[f.status] ?? "neutral"} title={f.error ?? undefined}>
              {FETCH_STATUS_LABEL[f.status]}
            </Badge>
          )}
          {panel.canManage && (
            <Button
              size="sm"
              loading={refresh.loading}
              disabled={rs.disabled}
              title={rs.reason ?? `Paid: at most ${maxCostText(panel.pricing.maxRefreshUsd)} at DataForSEO's published price`}
              onClick={async () => {
                const r = await refresh.run();
                if (r) onChange();
              }}
            >
              Refresh data
            </Button>
          )}
        </div>
      </header>
      {rs.disabled && rs.reason && panel.canManage && panel.state === "ready" && <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">{rs.reason}</p>}
      {f && f.error && (f.status === "failed" || f.status === "partial" || f.status === "setup_required") && (
        <p className="mt-2 break-words text-xs text-red-700 dark:text-red-400">
          Last refresh ({formatDateTime(f.finishedAt ?? f.createdAt)}): {f.error}
        </p>
      )}
      {refresh.error !== null && (
        <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-400">
          {errorMessage(refresh.error)}
        </p>
      )}

      {!d.snapshot ? (
        <p className="mt-3 text-xs text-zinc-600 dark:text-zinc-400">
          {f && (f.status === "queued" || f.status === "running") ? "Fetching DataForSEO data…" : "No DataForSEO data yet for this domain."}
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-zinc-600 dark:text-zinc-400">{provenanceLabel(d.snapshot)}</p>
          {o ? (
            <>
              <div className="grid gap-2 sm:grid-cols-3">
                <MetricTile label="Organic keywords (estimate)" value={estimate(o.organicKeywords)} sublabel="Google SERPs where the domain ranks in the top 100" />
                <MetricTile label="Est. organic traffic / month" value={estimate(o.organicEtv)} sublabel="DataForSEO ETV: CTR × search volume" />
                <MetricTile label="Est. traffic value / month" value={o.estimatedPaidTrafficCost === null ? "—" : `$${estimate(o.estimatedPaidTrafficCost)}`} sublabel="Equivalent Google Ads cost (DataForSEO)" />
              </div>
              {o.buckets && (
                <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-700 dark:text-zinc-300" aria-label="Ranking positions (estimate)">
                  {bucketGroups(o.buckets).map((b) => (
                    <div key={b.label} className="flex gap-1">
                      <dt className="text-zinc-500 dark:text-zinc-400">{b.label}</dt>
                      <dd className="tabular-nums font-medium">{estimate(b.value)}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </>
          ) : (
            <p className="text-xs text-zinc-600 dark:text-zinc-400">Overview not available from the last refresh.</p>
          )}
          <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? "Hide keywords, gap and pages" : "Show keywords, gap and pages"}
          </Button>
          {open && <DomainTables projectId={projectId} domain={d.domain} fetchId={d.snapshot.fetchId} />}
        </div>
      )}
    </article>
  );
}

function DomainTables({ projectId, domain, fetchId }: { projectId: string; domain: string; fetchId: string }) {
  const detail = useApi<CompetitorDomainDetail>(`${base(projectId)}/domains/${encodeURIComponent(domain)}`, [fetchId]);
  if (detail.loading && !detail.data) return <LoadingState />;
  if (detail.error && !detail.data) return <ErrorState error={detail.error} onRetry={detail.reload} />;
  return detail.data ? <DomainTablesView detail={detail.data} /> : null;
}

const endpointError = (detail: CompetitorDomainDetail, endpoint: string) => detail.snapshot?.endpoints.find((e) => e.endpoint === endpoint && e.status === "error")?.error ?? null;

export function DomainTablesView({ detail }: { detail: CompetitorDomainDetail }) {
  const kwErr = endpointError(detail, "ranked_keywords");
  const gapErr = endpointError(detail, "domain_intersection");
  const pagesErr = endpointError(detail, "relevant_pages");
  return (
    <div className="space-y-4">
      <section aria-label="Top ranked keywords" className="space-y-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">Top keywords (by search volume)</h4>
        {kwErr ? (
          <p className="text-xs text-red-700 dark:text-red-400">{kwErr}</p>
        ) : detail.topKeywords.length === 0 ? (
          <p className="text-xs text-zinc-600 dark:text-zinc-400">No ranked keywords returned.</p>
        ) : (
          <Table caption={`Top keywords for ${detail.domain} (DataForSEO estimate)`}>
            <THead>
              <TR>
                <TH>Keyword</TH>
                <TH className="text-right">Position</TH>
                <TH className="text-right">Search volume</TH>
                <TH className="text-right">Est. traffic</TH>
                <TH>URL</TH>
              </TR>
            </THead>
            <TBody>
              {detail.topKeywords.map((k, i) => (
                <TR key={`${k.keyword}-${i}`}>
                  <TD className="min-w-40 break-words">{k.keyword}</TD>
                  <TD className="text-right tabular-nums">{estimate(k.position)}</TD>
                  <TD className="text-right tabular-nums">{estimate(k.searchVolume)}</TD>
                  <TD className="text-right tabular-nums">{estimate(k.etv, 1)}</TD>
                  <TD className="min-w-48 max-w-xs">{k.url ? <ExternalUrl url={k.url} /> : "—"}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </section>

      <section aria-label="Keyword gap" className="space-y-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">Keyword gap vs {detail.ownDomain}</h4>
        <p className="text-xs text-zinc-600 dark:text-zinc-400">{GAP_NOTE}</p>
        {gapErr ? (
          <p className="text-xs text-red-700 dark:text-red-400">{gapErr}</p>
        ) : !detail.snapshot?.endpoints.some((e) => e.endpoint === "domain_intersection") ? (
          <p className="text-xs text-zinc-600 dark:text-zinc-400">Not requested (the competitor domain is your own domain).</p>
        ) : detail.keywordGap.length === 0 ? (
          <p className="text-xs text-zinc-600 dark:text-zinc-400">No gap keywords returned.</p>
        ) : (
          <Table caption={`Keywords ${detail.domain} ranks for and ${detail.ownDomain} does not (DataForSEO estimate)`}>
            <THead>
              <TR>
                <TH>Keyword</TH>
                <TH className="text-right">Search volume</TH>
                <TH className="text-right">Their position</TH>
                <TH className="text-right">Difficulty</TH>
                <TH>Their URL</TH>
              </TR>
            </THead>
            <TBody>
              {detail.keywordGap.map((g, i) => (
                <TR key={`${g.keyword}-${i}`}>
                  <TD className="min-w-40 break-words">{g.keyword}</TD>
                  <TD className="text-right tabular-nums">{estimate(g.searchVolume)}</TD>
                  <TD className="text-right tabular-nums">{estimate(g.competitorPosition)}</TD>
                  <TD className="text-right tabular-nums">{estimate(g.keywordDifficulty)}</TD>
                  <TD className="min-w-48 max-w-xs">{g.competitorUrl ? <ExternalUrl url={g.competitorUrl} /> : "—"}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </section>

      <section aria-label="Top pages" className="space-y-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">Top pages (by estimated organic traffic)</h4>
        {pagesErr ? (
          <p className="text-xs text-red-700 dark:text-red-400">{pagesErr}</p>
        ) : detail.topPages.length === 0 ? (
          <p className="text-xs text-zinc-600 dark:text-zinc-400">No pages returned.</p>
        ) : (
          <Table caption={`Top pages for ${detail.domain} (DataForSEO estimate)`}>
            <THead>
              <TR>
                <TH>Page</TH>
                <TH className="text-right">Est. traffic</TH>
                <TH className="text-right">Keywords</TH>
                <TH className="text-right">Top 3</TH>
              </TR>
            </THead>
            <TBody>
              {detail.topPages.map((p, i) => (
                <TR key={`${p.url}-${i}`}>
                  <TD className="min-w-56 max-w-md">
                    <ExternalUrl url={p.url} />
                  </TD>
                  <TD className="text-right tabular-nums">{estimate(p.etv, 1)}</TD>
                  <TD className="text-right tabular-nums">{estimate(p.keywords)}</TD>
                  <TD className="text-right tabular-nums">{estimate(p.top3)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </section>
    </div>
  );
}
