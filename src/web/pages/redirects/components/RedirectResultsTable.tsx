/**
 * Redirect map results: one row per old URL with method, Jev confidence/tier (Jev rows only), status,
 * a local decision control for review rows, and the expandable deterministic shortlist.
 * URLs and notes are untrusted text and render as plain text.
 */
import { useId, useState } from "react";
import type { RedirectMapRow } from "@shared/types";
import { formatNumber, formatPercent } from "@web/lib/format";
import { Badge, TBody, TD, TH, THead, TR, Table, TierBadge, cx, inputClass } from "@web/components/ui";

/** Row index -> chosen candidate URL, or NO_REDIRECT. Missing = undecided. */
export type Decisions = Record<number, string>;
export const NO_REDIRECT = "__no_redirect__";

type Filter = "all" | RedirectMapRow["status"];
const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "All" },
  { id: "auto", label: "Automatic" },
  { id: "review", label: "Review" },
  { id: "no_match", label: "No match" },
];

const METHOD_LABEL: Record<RedirectMapRow["method"], string> = {
  exact_path: "Exact path",
  normalized_slug: "Normalized slug",
  jev: "Jev choice",
  none: "No match method",
};

function MethodBadge({ method }: { method: RedirectMapRow["method"] }) {
  if (method === "none") return <span className="text-zinc-500 dark:text-zinc-400">—</span>;
  return <Badge tone={method === "jev" ? "info" : "neutral"}>{METHOD_LABEL[method]}</Badge>;
}

function StatusCell({ row, decision }: { row: RedirectMapRow; decision: string | undefined }) {
  if (row.status === "auto") return <Badge tone="success">Auto</Badge>;
  if (row.status === "no_match") return <Badge tone="neutral">No match</Badge>;
  return (
    <span className="flex flex-col items-start gap-1">
      <Badge tone="warning">Review</Badge>
      {decision && <span className="text-xs text-zinc-600 dark:text-zinc-400">{decision === NO_REDIRECT ? "You: no redirect" : "You: redirect"}</span>}
    </span>
  );
}

export function RedirectResultsTable({ rows, decisions, onDecide }: { rows: RedirectMapRow[]; decisions: Decisions; onDecide: (index: number, value: string) => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const groupId = useId();
  const visible = rows.map((row, index) => ({ row, index })).filter(({ row }) => filter === "all" || row.status === filter);
  const count = (f: Filter) => (f === "all" ? rows.length : rows.filter((r) => r.status === f).length);

  return (
    <div className="space-y-2">
      <div role="group" aria-labelledby={groupId} className="flex flex-wrap items-center gap-1">
        <span id={groupId} className="mr-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
          Show
        </span>
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={cx(
              "rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset focus-visible:outline-2 focus-visible:outline-sky-600",
              filter === f.id
                ? "bg-zinc-900 text-white ring-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 dark:ring-zinc-100"
                : "text-zinc-700 ring-zinc-300 hover:bg-zinc-100 dark:text-zinc-300 dark:ring-zinc-700 dark:hover:bg-zinc-800",
            )}
          >
            {f.label} ({formatNumber(count(f.id))})
          </button>
        ))}
      </div>

      <Table caption="Suggested redirects: old URL, suggested target, method, Jev confidence and tier, status, your decision, and shortlist">
        <THead>
          <TR>
            <TH>From</TH>
            <TH>To</TH>
            <TH>Method</TH>
            <TH>Confidence</TH>
            <TH>Jev tier</TH>
            <TH>Status</TH>
            <TH>Your decision</TH>
            <TH>Shortlist</TH>
          </TR>
        </THead>
        <TBody>
          {visible.length === 0 && (
            <TR>
              <TD colSpan={8} className="py-4 text-center text-zinc-600 dark:text-zinc-400">
                No rows with this status.
              </TD>
            </TR>
          )}
          {visible.map(({ row, index }) => (
            <ResultRow key={index} row={row} index={index} decision={decisions[index]} onDecide={onDecide} />
          ))}
        </TBody>
      </Table>
    </div>
  );
}

function ResultRow({ row, index, decision, onDecide }: { row: RedirectMapRow; index: number; decision: string | undefined; onDecide: (index: number, value: string) => void }) {
  const selectId = useId();
  const isJev = row.method === "jev";
  const suggested = row.status === "review" ? row.to : null;
  return (
    <TR className={cx(row.status === "review" && !decision && "bg-amber-50/60 dark:bg-amber-950/30")}>
      <TD className="min-w-48 max-w-72">
        <span className="break-all font-mono text-xs">{row.from}</span>
        {row.note && <p className="mt-1 break-words text-xs text-zinc-600 dark:text-zinc-400">{row.note}</p>}
      </TD>
      <TD className="min-w-48 max-w-72">
        {row.to ? (
          <span className="break-all font-mono text-xs">
            {row.to}
            {suggested && <span className="mt-0.5 block font-sans text-zinc-600 dark:text-zinc-400">Jev suggestion, not applied</span>}
          </span>
        ) : (
          <span className="text-zinc-500 dark:text-zinc-400">—</span>
        )}
      </TD>
      <TD>
        <MethodBadge method={row.method} />
      </TD>
      <TD className="tabular-nums">{isJev && row.confidence !== null ? formatPercent(row.confidence, 0) : <span className="text-zinc-500 dark:text-zinc-400">—</span>}</TD>
      <TD>{isJev ? <TierBadge tier={row.tier} /> : row.method === "none" ? <TierBadge tier={null} /> : <span className="text-xs text-zinc-600 dark:text-zinc-400">Deterministic</span>}</TD>
      <TD>
        <StatusCell row={row} decision={decision} />
      </TD>
      <TD className="min-w-56">
        {row.status === "review" ? (
          <>
            <label htmlFor={selectId} className="sr-only">
              Decision for {row.from}
            </label>
            <select id={selectId} className={cx(inputClass, "py-1 text-xs")} value={decision ?? ""} onChange={(e) => onDecide(index, e.target.value)}>
              <option value="">Undecided (not exported)</option>
              {row.candidates.map((c) => (
                <option key={c.url} value={c.url}>
                  {c.url}
                  {c.url === suggested ? " (Jev suggestion)" : ""}
                </option>
              ))}
              <option value={NO_REDIRECT}>No redirect</option>
            </select>
          </>
        ) : (
          <span className="text-xs text-zinc-500 dark:text-zinc-400">{row.status === "auto" ? "Included" : "Not exported"}</span>
        )}
      </TD>
      <TD className="min-w-40">
        {row.candidates.length === 0 ? (
          <span className="text-xs text-zinc-500 dark:text-zinc-400">None</span>
        ) : (
          <details className="text-xs">
            <summary className="cursor-pointer select-none rounded text-zinc-700 focus-visible:outline-2 focus-visible:outline-sky-600 dark:text-zinc-300">
              {row.candidates.length} candidate{row.candidates.length === 1 ? "" : "s"}
            </summary>
            <ol className="mt-1 list-decimal space-y-1 pl-4">
              {row.candidates.map((c) => (
                <li key={c.url}>
                  <span className="break-all font-mono">{c.url}</span>{" "}
                  <span className="whitespace-nowrap text-zinc-600 dark:text-zinc-400">similarity {c.score.toFixed(2)}</span>
                </li>
              ))}
            </ol>
          </details>
        )}
      </TD>
    </TR>
  );
}
