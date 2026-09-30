/**
 * [A22] SEO · Page audit: per crawled page, title / H1 / schema status and keep / update / review.
 * Built only from the latest stored crawl + findings (GET /projects/:pid/seo/page-audit). Also exports the
 * small shared pieces used by the other coverage tables (status chips, coverage notes, URL text).
 * Untrusted text (titles, URLs, details) renders as plain text; only external http(s) URLs become links.
 */
import type { ReactNode } from "react";
import type { AuditCellStatus, CoverageResponse, PageAuditRow, Project } from "@shared/types";
import type { ApiState } from "@web/lib/hooks";
import { useApi } from "@web/lib/hooks";
import { useProject } from "@web/lib/project-context";
import {
  Badge,
  Card,
  CompletenessNote,
  EmptyState,
  ErrorState,
  LoadingState,
  StateBadge,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  type BadgeTone,
} from "@web/components/ui";
import { PAGE_TYPE_LABEL } from "../lib";

// ------------------------------------------------------------------ shared coverage UI
const CELL_META: Record<AuditCellStatus, { label: string; tone: BadgeTone }> = {
  ok: { label: "OK", tone: "success" },
  review: { label: "Review", tone: "warning" },
  missing: { label: "Missing", tone: "danger" },
  not_applicable: { label: "N/A", tone: "neutral" },
  unknown: { label: "Unknown", tone: "neutral" },
};

export function CellChip({ status, label }: { status: AuditCellStatus; label?: string }) {
  const m = CELL_META[status] ?? { label: status, tone: "neutral" as const };
  return <Badge tone={m.tone}>{label ? `${label}: ${m.label}` : m.label}</Badge>;
}

/** Small muted detail line under a chip. */
export function Detail({ children }: { children: ReactNode }) {
  if (children === null || children === undefined || children === "") return null;
  return <p className="mt-0.5 max-w-60 break-words text-[11px] leading-snug text-zinc-600 dark:text-zinc-400">{children}</p>;
}

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** The project's own hosts (site URL host, verified host, sc-domain property), without "www.". */
export function ownHosts(project: Pick<Project, "siteUrl" | "verifiedHost" | "gscProperty">): string[] {
  const out = new Set<string>();
  const site = hostOf(project.siteUrl);
  if (site) out.add(site);
  if (project.verifiedHost) out.add(project.verifiedHost.toLowerCase().replace(/^www\./, ""));
  if (project.gscProperty?.startsWith("sc-domain:")) out.add(project.gscProperty.slice("sc-domain:".length).toLowerCase());
  return [...out];
}

export function useOwnHosts(): string[] {
  const { project } = useProject();
  return ownHosts(project);
}

/**
 * A URL as plain text. It becomes a link (new tab, rel="noopener noreferrer nofollow") only when it is an
 * http(s) URL on an external host; your own site's URLs stay plain text.
 */
export function UrlText({ url, own, className }: { url: string; own: string[]; className?: string }) {
  const host = hostOf(url);
  const external = !!host && !own.some((h) => host === h || host.endsWith(`.${h}`));
  const cls = `break-all text-xs ${className ?? ""}`;
  if (!external) return <span className={`${cls} text-zinc-800 dark:text-zinc-200`}>{url}</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className={`${cls} rounded text-sky-800 underline hover:text-sky-950 focus-visible:outline-2 focus-visible:outline-sky-600 dark:text-sky-300`}
    >
      {url}
    </a>
  );
}

/** Completeness note + the response's labels (method, thresholds, disclosures). */
export function CoverageNotes({ data }: { data: CoverageResponse<unknown> }) {
  return (
    <div className="mb-3 space-y-1">
      <CompletenessNote completeness={data.completeness} />
      {data.labels.length > 0 && (
        <details className="text-xs text-zinc-600 dark:text-zinc-400">
          <summary className="cursor-pointer rounded font-medium focus-visible:outline-2 focus-visible:outline-sky-600">How this is computed</summary>
          <ul className="mt-1 list-inside list-disc space-y-0.5">
            {data.labels.map((l, i) => (
              <li key={`${i}-${l}`} className="break-words">
                {l}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** Card with honest loading / error / setup / empty states around a coverage table. */
export function CoverageCard<T>({
  title,
  description,
  state,
  emptyTitle,
  setupHint,
  children,
}: {
  title: string;
  description: ReactNode;
  state: ApiState<CoverageResponse<T>>;
  emptyTitle: string;
  setupHint?: ReactNode;
  children: (data: CoverageResponse<T>) => ReactNode;
}) {
  const d = state.data;
  return (
    <Card title={title} description={description} actions={d ? <StateBadge state={d.state} /> : undefined}>
      {state.loading && !d ? (
        <LoadingState label={`Loading ${title.toLowerCase()}…`} />
      ) : state.error ? (
        <ErrorState error={state.error} onRetry={state.reload} title={`${title} unavailable`} />
      ) : d ? (
        <>
          <CoverageNotes data={d} />
          {d.rows.length === 0 ? (
            <EmptyState title={d.state === "setup_required" ? "Setup required" : d.state === "error" ? "No data available" : emptyTitle}>
              {d.completeness?.note ?? null}
              {d.state === "setup_required" && setupHint ? <span className="mt-1 block">{setupHint}</span> : null}
            </EmptyState>
          ) : (
            children(d)
          )}
        </>
      ) : null}
    </Card>
  );
}

// ------------------------------------------------------------------ page audit table
const ACTION_META: Record<PageAuditRow["action"], { label: string; tone: BadgeTone; title: string }> = {
  keep: { label: "Keep", tone: "success", title: "No findings on this page and no flagged cell" },
  update: { label: "Update", tone: "warning", title: "A fact finding of moderate or higher severity" },
  review: { label: "Review", tone: "info", title: "Only minor, advisory, or heuristic signals, or the page was not analysed" },
};

export function ActionBadge({ action }: { action: PageAuditRow["action"] }) {
  const m = ACTION_META[action];
  return (
    <Badge tone={m.tone} title={m.title}>
      {m.label}
    </Badge>
  );
}

export function PageAuditTable({ projectId }: { projectId: string }) {
  const own = useOwnHosts();
  const state = useApi<CoverageResponse<PageAuditRow>>(projectId ? `/projects/${encodeURIComponent(projectId)}/seo/page-audit` : null);
  return (
    <CoverageCard
      title="Page audit"
      description="Per crawled page: title, H1, and structured data status from the latest crawl and its findings. Keep / update / review is derived from those findings, not a score."
      state={state}
      emptyTitle="No pages in the latest crawl."
      setupHint="Verify your site and run a crawl; nothing is shown for pages that were not crawled."
    >
      {(d) => (
        <Table caption="Page audit">
          <THead>
            <TR>
              <TH>Page</TH>
              <TH>Title</TH>
              <TH>H1</TH>
              <TH>Schema</TH>
              <TH>Action</TH>
              <TH className="text-right">Findings</TH>
            </TR>
          </THead>
          <TBody>
            {d.rows.map((r) => (
              <TR key={r.pageId}>
                <TD className="min-w-44 max-w-64">
                  <UrlText url={r.url} own={own} />
                  <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{PAGE_TYPE_LABEL[r.pageType] ?? r.pageType}</p>
                </TD>
                <TD className="min-w-32">
                  <CellChip status={r.title.status} />
                  <Detail>{r.title.detail}</Detail>
                </TD>
                <TD className="min-w-32">
                  <CellChip status={r.h1.status} />
                  <Detail>{r.h1.detail}</Detail>
                </TD>
                <TD className="min-w-32">
                  <CellChip status={r.schema.status} />
                  {r.schema.types.length > 0 && <Detail>{r.schema.types.join(", ")}</Detail>}
                  <Detail>{r.schema.detail}</Detail>
                </TD>
                <TD className="whitespace-nowrap">
                  <ActionBadge action={r.action} />
                </TD>
                <TD className="text-right text-xs tabular-nums">{r.findingsCount}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </CoverageCard>
  );
}
