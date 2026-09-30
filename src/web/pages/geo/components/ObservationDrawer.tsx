/** Raw-answer / citation drawer for one GEO observation. Provider text is plain text only. */
import type { GeoObservationDetail } from "@shared/types";
import { formatDateTime, formatUsd } from "@web/lib/format";
import { useApi } from "@web/lib/hooks";
import { Badge, Definition, Drawer, ErrorState, LoadingState, TBody, TD, TH, THead, TR, Table } from "@web/components/ui";
import { ExternalUrl } from "@web/components/ExternalUrl";
import { HighlightedAnswer } from "./HighlightedAnswer";
import { SENTIMENT_LABEL, sourceTypeLabel } from "../lib";

export function ObservationDrawer({ observationId, title, onClose }: { observationId: string | null; title: string; onClose: () => void }) {
  return (
    <Drawer open={observationId !== null} onClose={onClose} title={title || "Observation"}>
      {observationId && <ObservationBody id={observationId} />}
    </Drawer>
  );
}

function ObservationBody({ id }: { id: string }) {
  const { data: o, error, loading, reload } = useApi<GeoObservationDetail>(`/geo/observations/${encodeURIComponent(id)}`);
  if (loading && !o) return <LoadingState label="Loading observation…" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!o) return null;
  const manual = o.measurementType === "manual_import";
  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <div className="flex flex-wrap gap-1.5">
          {manual ? (
            <Badge tone="warning">Manual import{o.importedSurface ? ` · ${o.importedSurface}` : ""} – not an API measurement</Badge>
          ) : (
            <Badge tone="info">API-sampled</Badge>
          )}
          <Badge tone={o.status === "ok" ? "success" : o.status === "failed" ? "danger" : "warning"}>
            {o.status === "ok" ? "OK" : o.status === "failed" ? "Failed" : "Incomplete"}
          </Badge>
          <Badge tone={o.grounded ? "success" : "neutral"}>{o.grounded ? "Grounded" : "Not grounded"}</Badge>
          <Badge>{o.promptType === "discovery" ? "Discovery prompt" : "Reputation prompt"}</Badge>
        </div>
        <dl className="space-y-1">
          <Definition term="Prompt">{o.promptText}</Definition>
          <Definition term="Provider">{o.provider}</Definition>
          <Definition term="Model">
            <span className="break-all font-mono text-xs">{o.model}</span>
          </Definition>
          <Definition term="Grounding">{o.groundingMode}</Definition>
          <Definition term="Collected">{formatDateTime(o.createdAt)}</Definition>
          <Definition term="Cost">
            {o.cost.usd === null ? "Unknown" : formatUsd(o.cost.usd, o.cost.isEstimate)}
            {o.cost.usd !== null && !o.cost.isEstimate ? " (actual)" : ""}
          </Definition>
          {o.requestId && (
            <Definition term="Request ID">
              <span className="break-all font-mono text-xs">{o.requestId}</span>
            </Definition>
          )}
        </dl>
      </section>

      <section>
        <h3 className="mb-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Raw answer</h3>
        <p className="mb-2 text-xs text-zinc-600 dark:text-zinc-400">
          Shown as plain text. Highlighted spans are detected brand mentions (
          <mark className="rounded-sm bg-indigo-200 px-0.5 text-indigo-950 dark:bg-indigo-800 dark:text-indigo-50">your brand</mark>,{" "}
          <mark className="rounded-sm bg-amber-200 px-0.5 text-amber-950 dark:bg-amber-800 dark:text-amber-50">other tracked brands</mark>).
        </p>
        {o.rawAnswer ? (
          <HighlightedAnswer text={o.rawAnswer} brands={o.brands} />
        ) : (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">No answer text stored.</p>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Brands in this answer</h3>
        {o.brands.length === 0 ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">No tracked brands detected.</p>
        ) : (
          <Table caption="Brands">
            <THead>
              <TR>
                <TH>Brand</TH>
                <TH>Mentioned</TH>
                <TH>Cited</TH>
                <TH>Status</TH>
                <TH>Rank</TH>
                <TH>Sentiment</TH>
                <TH>Method</TH>
              </TR>
            </THead>
            <TBody>
              {o.brands.map((b) => (
                <TR key={b.brandKey}>
                  <TD className="break-words">
                    {b.brandKey} {b.isSelf && <Badge tone="info">You</Badge>}
                  </TD>
                  <TD>{b.mentioned ? "Yes" : "No"}</TD>
                  <TD>{o.grounded ? (b.cited ? "Yes" : "No") : "n/a"}</TD>
                  <TD className="whitespace-nowrap text-xs">{b.recommendationStatus.replace(/_/g, " ")}</TD>
                  <TD>{b.listRank ?? "—"}</TD>
                  <TD>{SENTIMENT_LABEL[b.sentiment]}</TD>
                  <TD className="text-xs text-zinc-600 dark:text-zinc-400">{b.method}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Citations</h3>
        {!o.grounded ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">Not grounded – no citations were returned, and none are inferred.</p>
        ) : o.citations.length === 0 ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">No citations returned.</p>
        ) : (
          <ol className="space-y-2">
            {o.citations.map((c, i) => (
              <li key={`${c.url}-${i}`} className="min-w-0 rounded-lg border border-zinc-200 p-2 text-sm dark:border-zinc-800">
                <div className="flex flex-wrap items-center gap-1.5">
                  {c.position !== null && <span className="text-xs tabular-nums text-zinc-500">#{c.position}</span>}
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">{c.host}</span>
                  <Badge>{sourceTypeLabel(c.sourceType)}</Badge>
                  {c.brandKey && <Badge tone="info">{c.brandKey}</Badge>}
                </div>
                {c.title && <p className="mt-0.5 break-words text-xs text-zinc-700 dark:text-zinc-300">{c.title}</p>}
                <ExternalUrl url={c.url} className="mt-0.5 block" />
              </li>
            ))}
          </ol>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Search queries issued</h3>
        {o.searchQueries === null ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">Not exposed by this provider</p>
        ) : o.searchQueries.length === 0 ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">None issued</p>
        ) : (
          <ul className="list-inside list-disc space-y-0.5 text-sm text-zinc-800 dark:text-zinc-200">
            {o.searchQueries.map((q, i) => (
              <li key={`${i}-${q}`} className="break-words">
                {q}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Cited instead</h3>
        {o.displacements.length === 0 ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">No displacements recorded.</p>
        ) : (
          <ul className="space-y-2">
            {o.displacements.map((d, i) => (
              <li key={`${d.entity}-${i}`} className="min-w-0 rounded-lg border border-zinc-200 p-2 text-sm dark:border-zinc-800">
                <p>
                  <span className="font-medium">{d.entity}</span> via {sourceTypeLabel(d.sourceType)}
                </p>
                {d.url && (
                  <ExternalUrl url={d.url} className="block" />
                )}
                {d.span && <blockquote className="mt-1 border-l-2 border-zinc-300 pl-2 text-xs text-zinc-700 dark:border-zinc-700 dark:text-zinc-300">{d.span}</blockquote>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
