/**
 * [A22] GEO · Citation evidence: per URL of your site, how API-sampled answers cited it (counts, prompts,
 * providers, what was cited alongside) plus crawled pages matched to prompts where your site was not
 * cited (GET /projects/:pid/geo/citation-evidence). Next steps are review prompts; nothing here claims a
 * change will cause a citation. Hosts are shown as text; other sites are never crawled automatically.
 */
import type { CitationEvidenceRow, CoverageResponse } from "@shared/types";
import { formatDateTime } from "@web/lib/format";
import { useApi } from "@web/lib/hooks";
import { Badge, TBody, TD, TH, THead, TR, Table, type BadgeTone } from "@web/components/ui";
import { CoverageCard, Detail, UrlText, useOwnHosts } from "../../seo/components/PageAuditTable";
import { sourceTypeLabel } from "../lib";

const NEXT_STEP_META: Record<CitationEvidenceRow["nextStep"], { label: string; tone: BadgeTone }> = {
  compare: { label: "Compare", tone: "info" },
  add_proof: { label: "Add proof", tone: "warning" },
  none: { label: "No step", tone: "neutral" },
};

export function CitationEvidenceTable({ projectId }: { projectId: string }) {
  const own = useOwnHosts();
  const state = useApi<CoverageResponse<CitationEvidenceRow>>(projectId ? `/projects/${encodeURIComponent(projectId)}/geo/citation-evidence` : null);
  return (
    <CoverageCard
      title="Citation evidence"
      description="Pages of your site cited in API-sampled answers, and pages that matched a prompt where your site was not cited. Counts are from stored answers only; API-sampled answers, not consumer apps."
      state={state}
      emptyTitle="No page of your site was cited, and no matched page lacks a citation."
      setupHint="Configure a GEO provider and approve prompts; citation evidence appears after the first answers are stored."
    >
      {(d) => (
        <Table caption="Citation evidence">
          <THead>
            <TR>
              <TH>Page</TH>
              <TH className="text-right">Cited</TH>
              <TH>Prompts</TH>
              <TH>Providers</TH>
              <TH>Last cited</TH>
              <TH>Cited alongside</TH>
              <TH>Next step</TH>
            </TR>
          </THead>
          <TBody>
            {d.rows.map((r) => {
              const step = NEXT_STEP_META[r.nextStep];
              return (
                <TR key={`${r.pageId ?? ""}|${r.url}|${r.nextStep}`}>
                  <TD className="min-w-44 max-w-64">
                    <UrlText url={r.url} own={own} />
                    {r.pageId === null && <Detail>Not in the latest crawl</Detail>}
                  </TD>
                  <TD className="text-right text-xs tabular-nums">{r.citedCount}</TD>
                  <TD className="min-w-48 max-w-72">
                    {r.citedInPrompts.length === 0 ? (
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">—</span>
                    ) : (
                      <ul className="space-y-0.5 text-xs">
                        {r.citedInPrompts.slice(0, 3).map((p) => (
                          <li key={p} className="break-words">
                            {p}
                          </li>
                        ))}
                        {r.citedInPrompts.length > 3 && <li className="text-zinc-500 dark:text-zinc-400">+{r.citedInPrompts.length - 3} more</li>}
                      </ul>
                    )}
                  </TD>
                  <TD className="text-xs">{r.providers.length ? r.providers.join(", ") : "—"}</TD>
                  <TD className="whitespace-nowrap text-xs">{formatDateTime(r.lastCitedAt)}</TD>
                  <TD className="min-w-40 max-w-64">
                    {r.citedAlongside.length === 0 ? (
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">—</span>
                    ) : (
                      <ul className="space-y-0.5 text-xs">
                        {r.citedAlongside.map((a) => (
                          <li key={a.host} className="break-all">
                            {a.host} <span className="text-zinc-500 dark:text-zinc-400">({sourceTypeLabel(a.sourceType)})</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </TD>
                  <TD className="min-w-40 max-w-72">
                    <Badge tone={step.tone}>{step.label}</Badge>
                    <Detail>{r.reason}</Detail>
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}
    </CoverageCard>
  );
}
