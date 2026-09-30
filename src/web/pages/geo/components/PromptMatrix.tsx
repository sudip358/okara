/** Prompt × provider matrix. Each cell with an observation opens the raw-answer drawer. */
import type { GeoResults } from "@shared/types";
import { Badge, EmptyState, TBody, TD, TH, THead, TR, Table, cx } from "@web/components/ui";
import { SENTIMENT_LABEL, providerStatusLabel, sourceTypeLabel } from "../lib";

type Cell = GeoResults["prompts"][number]["perProvider"][number];

function yesNo(v: boolean | null): string {
  return v === null ? "—" : v ? "Yes" : "No";
}

function CellContent({ c }: { c: Cell }) {
  if (c.status !== "ok") {
    return (
      <span className="text-xs text-zinc-600 dark:text-zinc-400">
        <Badge tone={c.status === "failed" ? "danger" : c.status === "incomplete" ? "warning" : "neutral"}>{providerStatusLabel(c.status)}</Badge>
        {c.status !== "not_run" && <span className="mt-0.5 block">Not counted as an absence</span>}
      </span>
    );
  }
  return (
    <span className="block space-y-0.5 text-xs">
      <span className="flex flex-wrap gap-1">
        <Badge tone={c.mentioned ? "success" : "neutral"}>Mentioned: {yesNo(c.mentioned)}</Badge>
        <Badge tone={c.cited ? "success" : "neutral"}>{c.grounded ? `Cited: ${yesNo(c.cited)}` : "Not grounded"}</Badge>
      </span>
      <span className="block text-zinc-600 dark:text-zinc-400">
        Sentiment: {c.sentiment ? SENTIMENT_LABEL[c.sentiment] : "—"}
        {c.listRank !== null ? ` · List rank #${c.listRank}` : ""}
      </span>
      {c.citedInstead && (
        <span className="block break-words text-amber-800 dark:text-amber-300">
          Cited instead: {c.citedInstead.entity} via {sourceTypeLabel(c.citedInstead.sourceType)}
        </span>
      )}
    </span>
  );
}

export function PromptMatrix({
  results,
  onOpen,
}: {
  results: GeoResults;
  onOpen: (observationId: string, label: string) => void;
}) {
  const providers = Array.from(new Set([...results.lanes.map((l) => l.provider), ...results.prompts.flatMap((p) => p.perProvider.map((c) => c.provider))]));
  const labelFor = (provider: string) => results.lanes.find((l) => l.provider === provider)?.label ?? provider;
  if (results.prompts.length === 0) return <EmptyState title="No prompt results yet." />;

  const groups: Array<{ type: "discovery" | "reputation"; title: string }> = [
    { type: "discovery", title: "Discovery prompts (brand-blind; used for visibility metrics)" },
    { type: "reputation", title: "Reputation prompts (name your brand; excluded from visibility metrics)" },
  ];

  return (
    <div className="space-y-5">
      {groups.map((g) => {
        const rows = results.prompts.filter((p) => p.promptType === g.type);
        if (rows.length === 0) return null;
        return (
          <div key={g.type}>
            <h3 className="mb-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">{g.title}</h3>
            <Table caption={g.title}>
              <THead>
                <TR>
                  <TH className="min-w-56">Prompt</TH>
                  {providers.map((p) => (
                    <TH key={p} className="min-w-48 whitespace-normal">
                      {labelFor(p)}
                    </TH>
                  ))}
                </TR>
              </THead>
              <TBody>
                {rows.map((row) => (
                  <TR key={row.promptId}>
                    <TD className="break-words text-sm">{row.text}</TD>
                    {providers.map((prov) => {
                      const c = row.perProvider.find((x) => x.provider === prov);
                      if (!c) {
                        return (
                          <TD key={prov} className="text-xs text-zinc-500 dark:text-zinc-400">
                            Not run
                          </TD>
                        );
                      }
                      return (
                        <TD key={prov}>
                          {c.observationId ? (
                            <button
                              type="button"
                              onClick={() => onOpen(c.observationId!, `${labelFor(prov)} · ${row.text}`)}
                              className={cx(
                                "block w-full rounded-lg border border-transparent p-1.5 text-left hover:border-zinc-300 hover:bg-zinc-50 dark:hover:border-zinc-700 dark:hover:bg-zinc-800",
                                "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sky-600 dark:focus-visible:outline-sky-400",
                              )}
                              aria-label={`Open answer from ${labelFor(prov)} for prompt: ${row.text}`}
                            >
                              <CellContent c={c} />
                              <span className="mt-1 block text-[11px] font-medium text-sky-700 dark:text-sky-400">View answer →</span>
                            </button>
                          ) : (
                            <CellContent c={c} />
                          )}
                        </TD>
                      );
                    })}
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        );
      })}
    </div>
  );
}
