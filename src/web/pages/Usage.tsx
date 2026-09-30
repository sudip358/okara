/** Usage and limits. Costs: actual vs labelled estimate vs unknown (never shown as $0). OWNED BY: web-shell. */
import { useEffect, useId, useState } from "react";
import type { UsageSummary } from "@shared/types";
import { api } from "@web/lib/api";
import { useApi, useMutation } from "@web/lib/hooks";
import { formatDate, formatDateTime, formatNumber, formatUsd, humanize } from "@web/lib/format";
import { useProject } from "@web/lib/project-context";
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, MetricTile, PageHeader, StateBanner, TBody, TD, TH, THead, TR, Table, TextField } from "@web/components/ui";

type Limits = UsageSummary["limits"];
const LIMIT_FIELDS: Array<{ key: keyof Limits; label: string; hint: string; step: string }> = [
  { key: "crawlPages", label: "Crawl pages per run", hint: "HTML pages fetched per crawl.", step: "1" },
  { key: "gscRows", label: "GSC rows per sync", hint: "Row cap across paginated slices.", step: "1" },
  { key: "geoPromptsPerRun", label: "GEO prompts per run", hint: "Prompts sent per provider per batch.", step: "1" },
  { key: "providerCallsPerDay", label: "Provider calls per day", hint: "All paid API calls for this project.", step: "1" },
  { key: "usdPerDay", label: "USD per day", hint: "Daily spending allowance (actual + estimated).", step: "0.01" },
];

export function UsagePage() {
  const { projectId } = useProject();
  const pid = encodeURIComponent(projectId);
  const usage = useApi<UsageSummary>(`/projects/${pid}/usage`);

  if (usage.loading && !usage.data) return <LoadingState />;
  if (usage.error) return <ErrorState error={usage.error} onRetry={usage.reload} />;
  const u = usage.data;
  if (!u) return null;

  const spendParts = [
    u.used.usdActual !== null ? `${formatUsd(u.used.usdActual)} actual` : "Actual: unknown",
    u.used.usdEstimated !== null ? `${formatUsd(u.used.usdEstimated, true)}` : null,
    u.used.usdUnknownCalls > 0 ? `${u.used.usdUnknownCalls} call${u.used.usdUnknownCalls === 1 ? "" : "s"} with unknown cost` : null,
  ].filter(Boolean);
  const knownTotal = (u.used.usdActual ?? 0) + (u.used.usdEstimated ?? 0);
  const anyKnown = u.used.usdActual !== null || u.used.usdEstimated !== null;

  return (
    <div className="space-y-4">
      <PageHeader title="Usage and limits" description={`Day: ${formatDate(u.day)} (UTC). Limits are enforced on the server before any external call.`} />
      <div className="grid gap-3 sm:grid-cols-3">
        <MetricTile
          label="Provider calls today"
          value={`${formatNumber(u.used.providerCalls)} / ${formatNumber(u.limits.providerCallsPerDay)}`}
          sublabel="Every attempt counts, including retries."
          numerator={u.used.providerCalls}
          denominator={u.limits.providerCallsPerDay}
        />
        <MetricTile
          label="Spend today"
          value={anyKnown ? formatUsd(knownTotal, (u.used.usdEstimated ?? 0) > 0) : "Unknown"}
          sublabel={spendParts.join(" · ")}
          source={`Limit ${formatUsd(u.limits.usdPerDay)}/day`}
        />
        <MetricTile
          label="Calls with unknown cost"
          value={formatNumber(u.used.usdUnknownCalls)}
          sublabel="Provider did not return usage and no configured rate applies. Not counted as $0."
          state={u.used.usdUnknownCalls > 0 ? "partial" : undefined}
        />
      </div>
      {u.notes.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-zinc-600 dark:text-zinc-400">
          {u.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      <LimitsForm projectId={projectId} limits={u.limits} onSaved={usage.reload} />
      <Card title={`Provider calls today (${u.calls.length})`}>
        {u.calls.length === 0 ? (
          <EmptyState title="No provider calls today." />
        ) : (
          <Table caption="Provider calls today">
            <THead>
              <TR>
                <TH>Time</TH>
                <TH>Provider</TH>
                <TH>Model</TH>
                <TH>Purpose</TH>
                <TH>Status</TH>
                <TH className="text-right">Cost</TH>
              </TR>
            </THead>
            <TBody>
              {u.calls.map((c, i) => (
                <TR key={`${c.createdAt}-${i}`}>
                  <TD className="whitespace-nowrap text-xs">{formatDateTime(c.createdAt)}</TD>
                  <TD>{c.provider}</TD>
                  <TD className="break-all font-mono text-xs">{c.model ?? "—"}</TD>
                  <TD>{humanize(c.purpose)}</TD>
                  <TD>
                    <Badge tone={c.status === "ok" || c.status === "succeeded" ? "success" : c.status === "failed" || c.status === "error" ? "danger" : "neutral"}>{humanize(c.status)}</Badge>
                  </TD>
                  <TD className="whitespace-nowrap text-right tabular-nums">{formatUsd(c.costUsd, c.costIsEstimate)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
          "$" = cost returned by the provider; "~$ est." = estimate from versioned configured rates; "Unknown" = no usage data.
        </p>
      </Card>
    </div>
  );
}

function LimitsForm({ projectId, limits, onSaved }: { projectId: string; limits: Limits; onSaved: () => void }) {
  const id = useId();
  const [draft, setDraft] = useState<Record<keyof Limits, string>>(() => toDraft(limits));
  useEffect(() => setDraft(toDraft(limits)), [limits]);
  const save = useMutation((body: Limits) => api<Limits>(`/projects/${encodeURIComponent(projectId)}/limits`, { method: "PUT", body }));
  const parsed = Object.fromEntries(LIMIT_FIELDS.map((f) => [f.key, Number(draft[f.key])])) as Limits;
  const invalid = LIMIT_FIELDS.filter((f) => draft[f.key].trim() === "" || !Number.isFinite(parsed[f.key]) || parsed[f.key] < 0).map((f) => f.key);
  const dirty = LIMIT_FIELDS.some((f) => parsed[f.key] !== limits[f.key]);

  return (
    <Card title="Limits" description="The server enforces its own upper bounds; values above them are rejected.">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (invalid.length) return;
          const r = await save.run(parsed);
          if (r) onSaved();
        }}
        className="space-y-3"
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {LIMIT_FIELDS.map((f) => (
            <TextField
              key={f.key}
              id={`${id}-${f.key}`}
              label={f.label}
              type="number"
              inputMode="decimal"
              min={0}
              step={f.step}
              value={draft[f.key]}
              onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
              hint={f.hint}
              error={invalid.includes(f.key) ? "Enter a number ≥ 0." : null}
            />
          ))}
        </div>
        {save.error !== null && <ErrorState error={save.error} />}
        {save.data && !dirty && <StateBanner state="completed" title="Saved" message="New limits apply to the next run." />}
        <div className="flex justify-end gap-2">
          <Button disabled={!dirty} onClick={() => setDraft(toDraft(limits))}>
            Reset
          </Button>
          <Button type="submit" variant="primary" disabled={!dirty || invalid.length > 0} loading={save.loading}>
            Save limits
          </Button>
        </div>
      </form>
    </Card>
  );
}

function toDraft(l: Limits): Record<keyof Limits, string> {
  return {
    crawlPages: String(l.crawlPages),
    gscRows: String(l.gscRows),
    geoPromptsPerRun: String(l.geoPromptsPerRun),
    providerCallsPerDay: String(l.providerCallsPerDay),
    usdPerDay: String(l.usdPerDay),
  };
}
