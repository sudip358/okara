/** Tracked-brand share of voice. Restricted to configured brands; never market share. */
import type { GeoResults } from "@shared/types";
import { formatRatio } from "@web/lib/format";
import { Badge, EmptyState, TBody, TD, TH, THead, TR, Table } from "@web/components/ui";

export function ShareOfVoiceTable({ rows }: { rows: GeoResults["shareOfVoice"] }) {
  if (rows.length === 0) return <EmptyState title="No tracked-brand mentions in this sample." />;
  const sorted = rows.slice().sort((a, b) => (b.ratio.value ?? -1) - (a.ratio.value ?? -1) || a.brandKey.localeCompare(b.brandKey));
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-amber-800 dark:text-amber-300">Tracked brands only – not market share</p>
      <Table caption="Tracked-brand share of voice">
        <THead>
          <TR>
            <TH>Brand</TH>
            <TH>Share of tracked mentions</TH>
          </TR>
        </THead>
        <TBody>
          {sorted.map((r) => (
            <TR key={r.brandKey}>
              <TD className="break-words">
                {r.brandKey} {r.isSelf && <Badge tone="info">You</Badge>}
              </TD>
              <TD className="tabular-nums">{formatRatio(r.ratio, "tracked mentions")}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Binary response-level mentions of each brand / sum of those counts across all configured brands in the same sample.
      </p>
    </div>
  );
}
