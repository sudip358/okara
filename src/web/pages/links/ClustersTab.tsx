/**
 * Clusters tab: each hub (collection, hub named in your sheet, or a page you marked) with its spokes (articles and
 * products), the assignment method per spoke, and the missing hub -> spoke and spoke -> hub links. You can reassign a
 * spoke's hub, mark a page as a hub, or unmark one; changes are stored and applied immediately (automatic
 * reassignment of other spokes happens on the next graph rebuild).
 */
import { useState } from "react";
import type { LinkClusterReport, LinkHubView } from "@shared/types";
import { api, errorMessage } from "@web/lib/api";
import { formatNumber } from "@web/lib/format";
import { useApi } from "@web/lib/hooks";
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, MetricTile, StateBanner, TBody, TD, TH, THead, TR, Table, TextField } from "@web/components/ui";
import { shortUrl } from "./lib";
import { MethodNotes, UrlText, YesNo } from "./parts";

export function ClustersTab({ base }: { base: string }) {
  const report = useApi<LinkClusterReport>(`${base}/clusters`);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const edit = async (path: "hub" | "assign", body: unknown) => {
    setBusy(true);
    setError(null);
    try {
      report.setData(await api<LinkClusterReport>(`${base}/clusters/${path}`, { method: "PUT", body }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  if (report.loading && !report.data) return <LoadingState label="Loading clusters…" />;
  if (report.error) return <ErrorState error={report.error} onRetry={report.reload} />;
  return report.data ? <ClustersView report={report.data} busy={busy} error={error} onEdit={edit} /> : null;
}

export function ClustersView({
  report: r,
  busy,
  error,
  onEdit,
}: {
  report: LinkClusterReport;
  busy: boolean;
  error: string | null;
  onEdit: (path: "hub" | "assign", body: unknown) => Promise<void>;
}) {
  const edit = onEdit;
  if (r.state === "setup_required") return <StateBanner state="setup_required" message={r.labels.join(" ")} />;
  return (
    <div className="space-y-4">
      {r.state === "demo" && <StateBanner state="demo" message="Demo data – clusters of the fictional demo pages." />}
      {error && <StateBanner state="error" message={error} />}
      <Card title="Clusters" description="Hubs and their spokes, with the links each cluster is missing.">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <MetricTile label="Hubs" value={formatNumber(r.counts.hubs)} />
          <MetricTile label="Spokes" value={formatNumber(r.counts.spokes)} sublabel="Assigned articles and products" />
          <MetricTile label="Linked" value={formatNumber(r.counts.linked)} sublabel="Both directions" />
          <MetricTile label="Partly linked" value={formatNumber(r.counts.partial)} sublabel="One direction missing" />
          <MetricTile label="Unlinked" value={formatNumber(r.counts.unlinked)} sublabel="Neither direction" />
          <MetricTile label="Unassigned" value={formatNumber(r.counts.unassigned)} sublabel="No hub found" />
        </div>
        <div className="mt-3">
          <MethodNotes notes={r.labels} title="How clusters are built" />
        </div>
        <MarkHub busy={busy} onMark={(url) => void edit("hub", { url, hub: true })} />
      </Card>
      {r.hubs.length === 0 ? (
        <EmptyState title={r.graphId ? "No hubs found yet." : "No link graph yet."}>
          {r.graphId ? "Collection pages become hubs once crawled; you can also mark any page as a hub." : "The link graph is built after the next crawl, or press Rebuild graph."}
        </EmptyState>
      ) : (
        r.hubs.map((h) => <HubCard key={h.key} hub={h} hubs={r.hubs} busy={busy} onEdit={edit} />)
      )}
      {r.unassigned.length > 0 && (
        <Card title="Unassigned spokes" description="Indexable articles and products with no hub: no link, sheet entry, collection listing or term overlap tied them to one. Assign them yourself.">
          <ul className="space-y-2 text-sm">
            {r.unassigned.slice(0, 100).map((u) => (
              <li key={u.key} className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 break-words">
                  <Badge tone="neutral">{u.type}</Badge> {u.title ?? shortUrl(u.url)} <UrlText url={u.url} className="text-xs" />
                </span>
                <HubSelect hubs={r.hubs} value="" busy={busy} label={`Hub for ${shortUrl(u.url)}`} onChange={(v) => void edit("assign", v === "__reset" ? { spokeUrl: u.url, reset: true } : { spokeUrl: u.url, hubUrl: v === "__none" || !v ? null : v })} />
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function MarkHub({ busy, onMark }: { busy: boolean; onMark: (url: string) => void }) {
  const [url, setUrl] = useState("");
  return (
    <form
      className="mt-3 flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (url.trim()) onMark(url.trim());
      }}
    >
      <div className="min-w-0 flex-1">
        <TextField label="Mark a page as a hub" placeholder="https://your-site.com/pages/lighting-guide" value={url} onChange={(e) => setUrl(e.target.value)} hint="Any page of your verified site; it gets spokes you assign now and automatic ones on the next rebuild." />
      </div>
      <Button type="submit" size="sm" disabled={busy || !url.trim()}>
        Mark as hub
      </Button>
    </form>
  );
}

function HubSelect({ hubs, value, busy, label, onChange }: { hubs: LinkHubView[]; value: string; busy: boolean; label: string; onChange: (hubUrl: string) => void }) {
  return (
    <select
      aria-label={label}
      className="max-w-56 rounded border border-zinc-300 bg-white px-1.5 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-950"
      value={value}
      disabled={busy}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="" disabled={value === ""}>
        {value === "" ? "Choose a hub…" : "No hub"}
      </option>
      {hubs.map((h) => (
        <option key={h.key} value={h.url}>
          {h.title ?? shortUrl(h.url)}
        </option>
      ))}
      <option value="__none">No hub</option>
      <option value="__reset">Automatic (clear my choice)</option>
    </select>
  );
}

function HubCard({ hub, hubs, busy, onEdit }: { hub: LinkHubView; hubs: LinkHubView[]; busy: boolean; onEdit: (path: "hub" | "assign", body: unknown) => Promise<void> }) {
  const missing = hub.partial + hub.unlinked;
  return (
    <Card
      title={hub.title ?? shortUrl(hub.url)}
      description={`${hub.spokes.length} spoke${hub.spokes.length === 1 ? "" : "s"} · ${hub.linked} linked · ${hub.partial} partly · ${hub.unlinked} unlinked`}
      actions={
        <>
          <Badge tone="neutral">{hub.sourceLabel}</Badge>
          {missing > 0 && <Badge tone="warning">{missing} with missing links</Badge>}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void onEdit("hub", { url: hub.url, hub: false })}>
            Not a hub
          </Button>
        </>
      }
    >
      <p className="mb-2 break-all text-xs">
        <UrlText url={hub.url} />
      </p>
      {hub.spokes.length === 0 ? (
        <EmptyState title="No spokes assigned to this hub." />
      ) : (
        <details open={hub.spokes.length <= 25 || missing > 0}>
          <summary className="cursor-pointer text-sm font-medium">Spokes</summary>
          <Table caption={`Spokes of ${hub.title ?? hub.url}`}>
            <THead>
              <TR>
                <TH>Spoke</TH>
                <TH>Assigned by</TH>
                <TH>Hub → spoke</TH>
                <TH>Spoke → hub</TH>
                <TH>Reassign</TH>
              </TR>
            </THead>
            <TBody>
              {hub.spokes.map((s) => (
                <TR key={s.key}>
                  <TD className="min-w-56 max-w-sm">
                    <p className="break-words font-medium">{s.title ?? shortUrl(s.url)}</p>
                    <p className="break-all text-xs">
                      <UrlText url={s.url} />
                    </p>
                    <Badge tone="neutral">{s.type}</Badge>
                  </TD>
                  <TD className="text-xs">
                    {s.methodLabel}
                    {s.similarity !== null && <span className="block text-zinc-500 dark:text-zinc-400">similarity {s.similarity.toFixed(2)}</span>}
                  </TD>
                  <TD className="text-xs">
                    <YesNo ok={s.hubToSpoke} yes="Linked" no="Missing" />
                  </TD>
                  <TD className="text-xs">
                    <YesNo ok={s.spokeToHub} yes="Linked" no="Missing" />
                  </TD>
                  <TD>
                    <HubSelect
                      hubs={hubs}
                      value={hub.url}
                      busy={busy}
                      label={`Hub for ${shortUrl(s.url)}`}
                      onChange={(v) => void onEdit("assign", v === "__reset" ? { spokeUrl: s.url, reset: true } : { spokeUrl: s.url, hubUrl: v === "__none" ? null : v })}
                    />
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </details>
      )}
    </Card>
  );
}
