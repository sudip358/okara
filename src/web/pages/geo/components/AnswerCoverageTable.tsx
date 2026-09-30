/**
 * [A22] GEO · Answer coverage: each approved prompt, your best-matching page (method labelled), who the
 * API-sampled answers cited, and a gap label (GET /projects/:pid/geo/answer-coverage). Gaps are prompts
 * for review, never predictions of citation. Provider text and URLs render as plain text; only external
 * http(s) URLs become links.
 */
import type { AnswerCoverageRow, CoverageResponse } from "@shared/types";
import { useApi } from "@web/lib/hooks";
import { Badge, TBody, TD, TH, THead, TR, Table, type BadgeTone } from "@web/components/ui";
import { CoverageCard, Detail, UrlText, useOwnHosts } from "../../seo/components/PageAuditTable";
import { sourceTypeLabel } from "../lib";

const AI_SOURCE_META: Record<AnswerCoverageRow["aiSource"], { label: string; tone: BadgeTone }> = {
  your_site: { label: "Your site", tone: "success" },
  other_site: { label: "Other site", tone: "warning" },
  none: { label: "No sources cited", tone: "neutral" },
  not_run: { label: "Not run", tone: "neutral" },
};

export const GAP_META: Record<AnswerCoverageRow["gap"], { label: string; tone: BadgeTone; title: string }> = {
  covered: { label: "Covered", tone: "success", title: "Your site was cited in a sampled answer" },
  improve: { label: "Improve", tone: "warning", title: "A matching page exists but was not cited" },
  create_page: { label: "Create page", tone: "danger", title: "Other sites were cited and no matching page was found" },
  check: { label: "Check", tone: "neutral", title: "Not run, ungrounded, or ambiguous: review manually" },
};

const METHOD_LABEL: Record<NonNullable<AnswerCoverageRow["matchedPage"]>["method"], string> = {
  engine_search_query: "via engine search query",
  title_heading_overlap: "via title/H1 overlap (heuristic)",
};

export function AnswerCoverageTable({ projectId }: { projectId: string }) {
  const own = useOwnHosts();
  const state = useApi<CoverageResponse<AnswerCoverageRow>>(projectId ? `/projects/${encodeURIComponent(projectId)}/geo/answer-coverage` : null);
  return (
    <CoverageCard
      title="Answer coverage"
      description="Each approved buyer prompt, the page on your site that best matches it, and who the API-sampled answers cited. API-sampled answers; not consumer apps."
      state={state}
      emptyTitle="No approved prompts yet."
      setupHint="Approve prompts and configure a GEO provider; rows show 'Not run' until answers exist."
    >
      {(d) => (
        <Table caption="Answer coverage">
          <THead>
            <TR>
              <TH>Buyer question</TH>
              <TH>Your page</TH>
              <TH>AI source</TH>
              <TH>Top other source</TH>
              <TH>Gap</TH>
            </TR>
          </THead>
          <TBody>
            {d.rows.map((r) => {
              const src = AI_SOURCE_META[r.aiSource];
              const gap = GAP_META[r.gap];
              return (
                <TR key={r.promptId}>
                  <TD className="min-w-48 max-w-72">
                    <p className="break-words text-xs text-zinc-900 dark:text-zinc-100">{r.text}</p>
                    {r.promptType === "reputation" && (
                      <Badge tone="info" className="mt-0.5">
                        Reputation prompt
                      </Badge>
                    )}
                  </TD>
                  <TD className="min-w-44 max-w-64">
                    {r.matchedPage ? (
                      <>
                        <UrlText url={r.matchedPage.url} own={own} />
                        <Detail>
                          {METHOD_LABEL[r.matchedPage.method]} · score {r.matchedPage.score.toFixed(2)}
                        </Detail>
                      </>
                    ) : (
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">No matching page</span>
                    )}
                  </TD>
                  <TD className="min-w-28">
                    <Badge tone={src.tone}>{src.label}</Badge>
                    <Detail>{`${r.providersRun} provider(s) with a successful answer`}</Detail>
                  </TD>
                  <TD className="min-w-40 max-w-64">
                    {r.topOtherSource ? (
                      <>
                        <p className="break-all text-xs font-medium text-zinc-900 dark:text-zinc-100">{r.topOtherSource.host}</p>
                        <Detail>{sourceTypeLabel(r.topOtherSource.sourceType)}</Detail>
                        {r.topOtherSource.url && <UrlText url={r.topOtherSource.url} own={own} className="mt-0.5 block text-[11px]" />}
                      </>
                    ) : (
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">—</span>
                    )}
                  </TD>
                  <TD className="min-w-40 max-w-72">
                    <Badge tone={gap.tone} title={gap.title}>
                      {gap.label}
                    </Badge>
                    <Detail>{r.basis}</Detail>
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
