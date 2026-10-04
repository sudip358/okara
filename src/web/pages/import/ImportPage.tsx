/**
 * Import page: bring any tab of a spreadsheet into the right Okara feature.
 * Source (Google Sheet link via the optional read-only Sheets connection, or CSV upload / pasted cells) -> pick tabs
 * (destination auto-suggested from the header row) -> column mapping with a 20-row preview -> dry run (what would
 * change; uncheck rows) -> Import. Sheet-linked imports into competitors, GEO prompts and placed links can be kept in
 * sync. History with undo for the latest import of each destination. Every cell is untrusted text, rendered as plain
 * text only (never HTML).
 */
import { useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import {
  DESTINATION_LABELS,
  IMPORT_DESTINATIONS,
  IMPORT_LABEL_SHEET,
  SYNC_FREQUENCIES,
  type CompetitorsMapping,
  type DocMapping,
  type ImportDestination,
  type ImportMapping,
  type ImportOverview,
  type ImportPlan,
  type ImportRecordSummary,
  type ImportSyncSummary,
  type LinksMapping,
  type PromptsMapping,
  type SheetTabsResult,
  type SheetsConnectionStatus,
  type TabPreview,
} from "@shared/import";
import { api, errorMessage } from "@web/lib/api";
import { formatDateTime, formatRelative } from "@web/lib/format";
import { useApi } from "@web/lib/hooks";
import { projectPath, useProject } from "@web/lib/project-context";
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, PageHeader, PlainText, SelectField, TBody, TD, TH, THead, TR, Table, TextArea, TextField, buttonClass, cx } from "@web/components/ui";
import {
  ACTION_LABELS,
  ACTION_TONES,
  canSync,
  countsText,
  defaultMapping,
  destinationLabel,
  excludable,
  formatBytes,
  frequencyLabel,
  importRequestBody,
  planHasChanges,
  readCsvFile,
  sheetsErrorMessage,
  stageCsv,
  stageSheetTab,
  syncErrorHelp,
  syncErrorLabel,
  syncStatusText,
  type StagedTab,
} from "./lib";

interface CommitResponse {
  plan: ImportPlan;
  import: ImportRecordSummary | null;
  changes: string[];
  sync: ImportSyncSummary | null;
}

export function ImportPage() {
  const { projectId, project, reload: reloadProject } = useProject();
  const overview = useApi<ImportOverview>(`/projects/${projectId}/import`);
  const [params] = useSearchParams();
  const [mode, setMode] = useState<"sheets" | "csv">("sheets");
  const [staged, setStaged] = useState<StagedTab[]>([]);
  const [plans, setPlans] = useState<Record<string, ImportPlan>>({});
  const [excluded, setExcluded] = useState<Record<string, string[]>>({});
  const [results, setResults] = useState<Record<string, CommitResponse>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const base = `/projects/${projectId}/import`;

  const sheetsError = sheetsErrorMessage(params.get("sheetsError"));
  const connected = params.get("sheets") === "connected";

  const setTab = (id: string, patch: Partial<StagedTab>) => {
    setStaged((s) => s.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    setPlans((p) => {
      const { [id]: _drop, ...rest } = p;
      return rest;
    });
  };
  const addStaged = (tabs: StagedTab[]) => {
    setStaged((s) => [...s.filter((x) => !tabs.some((t) => t.id === x.id)), ...tabs]);
  };

  async function runDry(t: StagedTab) {
    setBusy(`dry:${t.id}`);
    setErrors((e) => ({ ...e, [t.id]: "" }));
    try {
      const plan = await api<ImportPlan>(`${base}/dry-run`, { method: "POST", body: importRequestBody(t, excluded[t.id] ?? []) });
      setPlans((p) => ({ ...p, [t.id]: plan }));
    } catch (e) {
      setErrors((x) => ({ ...x, [t.id]: errorMessage(e) }));
    } finally {
      setBusy(null);
    }
  }

  async function runImport(t: StagedTab) {
    setBusy(`commit:${t.id}`);
    setErrors((e) => ({ ...e, [t.id]: "" }));
    try {
      const r = await api<CommitResponse>(`${base}/commit`, { method: "POST", body: importRequestBody(t, excluded[t.id] ?? []) });
      setResults((x) => ({ ...x, [t.id]: r }));
      setPlans((p) => ({ ...p, [t.id]: r.plan }));
      overview.reload();
      if (t.destination === "competitors" || t.destination === "geo_prompts") reloadProject();
    } catch (e) {
      setErrors((x) => ({ ...x, [t.id]: errorMessage(e) }));
    } finally {
      setBusy(null);
    }
  }

  const ov = overview.data;
  const canManage = ov?.canManage ?? false;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Import"
        description="Bring tabs from your spreadsheet into Okara: questions become GEO prompts, competitor domains become tracked competitors, placed internal links stop being re-suggested, and research tabs become context the agents can read. Imported values are labelled as yours, never as Okara measurements."
      />
      {connected && <Notice tone="success">Google Sheets connected (read-only).</Notice>}
      {sheetsError && <Notice tone="danger">{sheetsError}</Notice>}
      {project.isDemo && <Notice tone="info">Demo project: imports are disabled.</Notice>}

      {overview.loading && !ov ? (
        <LoadingState label="Loading import settings…" />
      ) : overview.error ? (
        <ErrorState error={overview.error} onRetry={overview.reload} />
      ) : ov ? (
        <>
          {!canManage && <Notice tone="info">Only the workspace owner can import. You can see the history and sync status.</Notice>}
          {canManage && (
            <Card
              title="1. Choose a source"
              actions={
                <div role="radiogroup" aria-label="Source" className="flex gap-1">
                  {(["sheets", "csv"] as const).map((m) => (
                    <button
                      key={m}
                      role="radio"
                      aria-checked={mode === m}
                      className={buttonClass(mode === m ? "primary" : "secondary", "sm")}
                      onClick={() => setMode(m)}
                      type="button"
                    >
                      {m === "sheets" ? "Google Sheet link" : "CSV file / paste"}
                    </button>
                  ))}
                </div>
              }
            >
              <div className="p-4">
                {mode === "sheets" ? (
                  <SheetsSource projectId={projectId} status={ov.sheets} base={base} onStage={addStaged} onDisconnected={overview.reload} />
                ) : (
                  <CsvSource maxBytes={ov.limits.maxCsvBytes} onStage={addStaged} />
                )}
              </div>
            </Card>
          )}

          {staged.length > 0 && (
            <section aria-labelledby="map-heading" className="space-y-4">
              <h2 id="map-heading" className="text-sm font-semibold">
                2. Map columns, dry run, import
              </h2>
              {staged.map((t) => (
                <TabCard
                  key={t.id}
                  tab={t}
                  plan={plans[t.id] ?? null}
                  result={results[t.id] ?? null}
                  error={errors[t.id] || null}
                  busy={busy}
                  excluded={excluded[t.id] ?? []}
                  disabled={project.isDemo}
                  onChange={(patch) => setTab(t.id, patch)}
                  onToggleExclude={(key) =>
                    setExcluded((x) => {
                      const cur = new Set(x[t.id] ?? []);
                      if (cur.has(key)) cur.delete(key);
                      else cur.add(key);
                      return { ...x, [t.id]: [...cur] };
                    })
                  }
                  onDryRun={() => runDry(t)}
                  onImport={() => runImport(t)}
                  onRemove={() => setStaged((s) => s.filter((x) => x.id !== t.id))}
                />
              ))}
            </section>
          )}

          <SyncList syncs={ov.syncs} canManage={canManage} base={base} projectId={projectId} onChanged={overview.reload} />
          <HistoryList history={ov.history} canManage={canManage} base={base} onChanged={() => { overview.reload(); reloadProject(); }} />
          <DocumentList documents={ov.documents} projectId={projectId} />
        </>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ small parts
export function Notice({ tone, children }: { tone: "success" | "danger" | "info" | "warning"; children: ReactNode }) {
  const cls = {
    success: "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100",
    danger: "border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100",
    info: "border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-100",
    warning: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100",
  }[tone];
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cx("rounded-lg border px-3 py-2 text-sm", cls)}>
      {children}
    </div>
  );
}

// ------------------------------------------------------------------ sources
export function SheetsConnection({ projectId, status, onDisconnect }: { projectId: string; status: SheetsConnectionStatus; onDisconnect?: () => void }) {
  const connectHref = `/api/projects/${encodeURIComponent(projectId)}/import/sheets/connect`;
  return (
    <div className="space-y-2" data-testid="sheets-connection">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Google Sheets (read-only)</span>
        {status.state === "ready" && status.via === "maton" && <Badge tone="success">Connected via Maton ({status.maton?.label ?? "default connection"})</Badge>}
        {status.state === "ready" && status.via !== "maton" && <Badge tone="success">Connected {status.connectedAt ? formatRelative(status.connectedAt) : ""}</Badge>}
        {status.state === "error" && <Badge tone="danger">Reconnect needed</Badge>}
        {status.state === "setup_required" && <Badge tone="warning">Not connected</Badge>}
        {status.state === "disabled" && <Badge tone="neutral">Not configured on this server</Badge>}
        {status.state === "demo" && <Badge tone="demo">Demo</Badge>}
      </div>
      {status.lastError && <PlainText className="text-sm text-red-800 dark:text-red-300" text={status.lastError} />}
      <ul className="list-disc space-y-0.5 pl-5 text-xs text-zinc-600 dark:text-zinc-400">
        {status.notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        {(status.state === "setup_required" || status.state === "error" || status.via === "maton") && (
          <a className={buttonClass(status.via === "maton" ? "secondary" : "primary", "sm")} href={connectHref}>
            {status.state === "error" ? "Reconnect Google Sheets" : "Connect Google Sheets"}
          </a>
        )}
        {(status.state === "setup_required" || status.state === "disabled") && !status.maton?.available && (
          <a className={buttonClass("secondary", "sm")} href={`/projects/${encodeURIComponent(projectId)}/integrations#maton`}>
            Use Maton
          </a>
        )}
        {(status.state === "ready" || status.state === "error") && status.via !== "maton" && onDisconnect && (
          <Button size="sm" variant="ghost" onClick={onDisconnect}>
            Disconnect
          </Button>
        )}
      </div>
      {status.state === "disabled" && <p className="text-sm">Use CSV import: in Google Sheets, File → Download → Comma-separated values (.csv) for each tab.</p>}
    </div>
  );
}

function SheetsSource({ projectId, status, base, onStage, onDisconnected }: { projectId: string; status: SheetsConnectionStatus; base: string; onStage: (t: StagedTab[]) => void; onDisconnected: () => void }) {
  const [url, setUrl] = useState("");
  const [meta, setMeta] = useState<SheetTabsResult | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const ready = status.state === "ready";

  async function loadTabs() {
    setLoading(true);
    setError(null);
    try {
      setMeta(await api<SheetTabsResult>(`${base}/sheets/tabs`, { method: "POST", body: { spreadsheet: url } }));
      setSelected([]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }
  async function preview() {
    if (!meta || selected.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const out: TabPreview[] = [];
      for (let i = 0; i < selected.length; i += 10) {
        out.push(...(await api<TabPreview[]>(`${base}/sheets/preview`, { method: "POST", body: { spreadsheetId: meta.spreadsheetId, tabs: selected.slice(i, i + 10) } })));
      }
      onStage(out.map((p) => stageSheetTab(meta.spreadsheetId, p)));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <SheetsConnection
        projectId={projectId}
        status={status}
        onDisconnect={async () => {
          await api(`${base}/sheets`, { method: "DELETE" }).catch(() => undefined);
          onDisconnected();
        }}
      />
      {ready && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1">
              <TextField label="Spreadsheet link" placeholder="https://docs.google.com/spreadsheets/d/…" value={url} onChange={(e) => setUrl(e.target.value)} />
            </div>
            <Button onClick={loadTabs} disabled={!url.trim() || loading}>
              Load tabs
            </Button>
          </div>
          {meta && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">
                {meta.title} · {meta.tabs.length} tabs: choose what to import
              </legend>
              <div className="grid max-h-72 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
                {meta.tabs.map((t) => (
                  <label key={t.sheetId} className="flex min-w-0 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selected.includes(t.title)}
                      onChange={(e) => setSelected((s) => (e.target.checked ? [...s, t.title] : s.filter((x) => x !== t.title)))}
                    />
                    <span className="truncate" title={t.title}>
                      {t.title}
                    </span>
                    {t.rowCount !== null && <span className="text-xs text-zinc-500">{t.rowCount.toLocaleString("en-US")} rows</span>}
                  </label>
                ))}
              </div>
              <Button variant="primary" onClick={preview} disabled={selected.length === 0 || loading}>
                Preview {selected.length || ""} tab{selected.length === 1 ? "" : "s"}
              </Button>
            </fieldset>
          )}
        </div>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );
}

function CsvSource({ maxBytes, onStage }: { maxBytes: number; onStage: (t: StagedTab[]) => void }) {
  const [paste, setPaste] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-700 dark:text-zinc-300">
        In Google Sheets: File → Download → Comma-separated values (.csv), one file per tab, or select cells and paste them below. Up to {formatBytes(maxBytes)} per file.
      </p>
      <label className="block text-sm">
        <span className="mb-1 block font-medium">CSV files (one per tab)</span>
        <input
          type="file"
          multiple
          accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values"
          onChange={async (e) => {
            setError(null);
            const files = [...(e.target.files ?? [])];
            const out: StagedTab[] = [];
            for (const f of files) {
              try {
                out.push(stageCsv(f.name, await readCsvFile(f)));
              } catch (err) {
                setError(errorMessage(err));
              }
            }
            if (out.length) onStage(out);
            e.target.value = "";
          }}
        />
      </label>
      <div className="grid gap-2 sm:grid-cols-[1fr_16rem]">
        <TextArea label="Or paste cells (with the header row)" value={paste} onChange={(e) => setPaste(e.target.value)} rows={5} />
        <div className="space-y-2">
          <TextField label="Tab name" placeholder="e.g. AI Questions" value={name} onChange={(e) => setName(e.target.value)} hint="Used to suggest the destination and name the import." />
          <Button
            disabled={!paste.trim()}
            onClick={() => {
              onStage([stageCsv(name.trim() || "Pasted cells", paste)]);
              setPaste("");
            }}
          >
            Preview pasted cells
          </Button>
        </div>
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );
}

// ------------------------------------------------------------------ mapping + plan
export function PreviewTable({ headers, rows, caption }: { headers: string[]; rows: string[][]; caption?: string }) {
  return (
    <div className="max-h-80 overflow-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
      <Table caption={caption}>
        <THead>
          <TR>
            {headers.map((h, i) => (
              <TH key={i} className="whitespace-nowrap">
                {h}
              </TH>
            ))}
          </TR>
        </THead>
        <TBody>
          {rows.map((r, i) => (
            <TR key={i}>
              {headers.map((_, c) => (
                <TD key={c} className="max-w-64 truncate" title={r[c] ?? ""}>
                  {r[c] ?? ""}
                </TD>
              ))}
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

function ColumnSelect({ label, value, headers, onChange, optional }: { label: string; value: string | null | undefined; headers: string[]; onChange: (v: string | null) => void; optional?: boolean }) {
  return (
    <SelectField label={label} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} required={!optional}>
      {optional && <option value="">— none —</option>}
      {headers.map((h) => (
        <option key={h} value={h}>
          {h}
        </option>
      ))}
    </SelectField>
  );
}

function ColumnChecks({ label, values, headers, onChange, hint }: { label: string; values: string[]; headers: string[]; onChange: (v: string[]) => void; hint?: string }) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1 text-sm font-medium">{label}</legend>
      {hint && <p className="mb-1 text-xs text-zinc-600 dark:text-zinc-400">{hint}</p>}
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {headers.map((h) => (
          <label key={h} className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={values.includes(h)} onChange={(e) => onChange(e.target.checked ? [...values, h] : values.filter((x) => x !== h))} />
            {h}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function MappingFields({ destination, mapping, headers, onChange }: { destination: ImportDestination; mapping: ImportMapping; headers: string[]; onChange: (m: ImportMapping) => void }) {
  if (destination === "geo_prompts") {
    const m = mapping as PromptsMapping;
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <ColumnSelect label="Question column" value={m.question} headers={headers} onChange={(v) => onChange({ ...m, question: v ?? "" })} />
        <ColumnSelect label="Done column" value={m.done} headers={headers} onChange={(v) => onChange({ ...m, done: v })} optional />
        <div className="sm:col-span-2">
          <ColumnChecks label="Keep as reference notes" hint={`Shown with each prompt, labelled "${IMPORT_LABEL_SHEET}".`} values={m.notes ?? []} headers={headers.filter((h) => h !== m.question)} onChange={(v) => onChange({ ...m, notes: v })} />
        </div>
      </div>
    );
  }
  if (destination === "competitors") {
    const m = mapping as CompetitorsMapping;
    return (
      <div className="grid gap-3 sm:grid-cols-3">
        <ColumnSelect label="Domain column" value={m.domain} headers={headers} onChange={(v) => onChange({ ...m, domain: v ?? "" })} />
        <ColumnSelect label="Notes column" value={m.notes} headers={headers} onChange={(v) => onChange({ ...m, notes: v })} optional />
        <ColumnSelect label="Assigned to column" value={m.assignedTo} headers={headers} onChange={(v) => onChange({ ...m, assignedTo: v })} optional />
        <div className="sm:col-span-3">
          <ColumnChecks label="Sheet metrics to keep" hint="Stored as an imported snapshot from your sheet (third-party tool), with the import date." values={m.metrics ?? []} headers={headers.filter((h) => h !== m.domain)} onChange={(v) => onChange({ ...m, metrics: v })} />
        </div>
      </div>
    );
  }
  if (destination === "implemented_links") {
    const m = mapping as LinksMapping;
    const set = (k: keyof LinksMapping) => (v: string | null) => onChange({ ...m, [k]: k === "source" || k === "target" ? (v ?? "") : v });
    return (
      <div className="grid gap-3 sm:grid-cols-3">
        <ColumnSelect label="Source page URL" value={m.source} headers={headers} onChange={set("source")} />
        <ColumnSelect label="Target URL" value={m.target} headers={headers} onChange={set("target")} />
        <ColumnSelect label="Anchor" value={m.anchor} headers={headers} onChange={set("anchor")} optional />
        <ColumnSelect label="Date" value={m.date} headers={headers} onChange={set("date")} optional />
        <ColumnSelect label="Method" value={m.method} headers={headers} onChange={set("method")} optional />
        <ColumnSelect label="Hub" value={m.hub} headers={headers} onChange={set("hub")} optional />
      </div>
    );
  }
  const m = mapping as DocMapping;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <TextField label="Document title" value={m.title ?? ""} maxLength={120} onChange={(e) => onChange({ ...m, title: e.target.value })} />
      <ColumnSelect label="Keep the top rows by (numeric, descending)" value={m.sortBy} headers={headers} onChange={(v) => onChange({ ...m, sortBy: v })} optional />
      <div className="sm:col-span-2">
        <ColumnChecks label="Columns to keep" values={m.columns ?? headers} headers={headers} onChange={(v) => onChange({ ...m, columns: v })} />
      </div>
    </div>
  );
}

export function PlanView({ plan, excluded, onToggle, disabled }: { plan: ImportPlan; excluded: string[]; onToggle?: (key: string) => void; disabled?: boolean }) {
  return (
    <div className="space-y-2" data-testid="plan">
      <ul className="space-y-0.5 text-sm">
        {plan.summary.map((s) => (
          <li key={s} className="font-medium">
            {s}
          </li>
        ))}
      </ul>
      {plan.notes.length > 0 && (
        <ul className="list-disc pl-5 text-xs text-zinc-600 dark:text-zinc-400">
          {plan.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      {plan.items.length > 0 && (
        <div className="max-h-96 overflow-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          <Table caption={`${plan.items.length} of ${plan.itemsTotal} rows shown. Uncheck a row to leave it out (also on later syncs), then run the dry run again.`}>
            <THead>
              <TR>
                <TH className="w-10">Use</TH>
                <TH>Row</TH>
                <TH>Item</TH>
                <TH>Result</TH>
                <TH>Why</TH>
              </TR>
            </THead>
            <TBody>
              {plan.items.map((it) => (
                <TR key={`${it.action}:${it.key}:${it.row ?? ""}`}>
                  <TD>
                    {excludable(it.action) && onToggle ? (
                      <input type="checkbox" aria-label={`Include ${it.label}`} checked={!excluded.includes(it.key)} disabled={disabled} onChange={() => onToggle(it.key)} />
                    ) : null}
                  </TD>
                  <TD className="text-xs text-zinc-500">{it.row ?? ""}</TD>
                  <TD className="max-w-md break-words">{it.label}</TD>
                  <TD>
                    <Badge tone={ACTION_TONES[it.action]}>{ACTION_LABELS[it.action]}</Badge>
                  </TD>
                  <TD className="text-xs">{it.reason ?? ""}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function TabCard({
  tab,
  plan,
  result,
  error,
  busy,
  excluded,
  disabled,
  onChange,
  onToggleExclude,
  onDryRun,
  onImport,
  onRemove,
}: {
  tab: StagedTab;
  plan: ImportPlan | null;
  result: CommitResponse | null;
  error: string | null;
  busy: string | null;
  excluded: string[];
  disabled: boolean;
  onChange: (patch: Partial<StagedTab>) => void;
  onToggleExclude: (key: string) => void;
  onDryRun: () => void;
  onImport: () => void;
  onRemove: () => void;
}) {
  const syncable = canSync(tab);
  const promptCompetitors = plan?.suggestedCompetitors?.filter((c) => !c.tracked) ?? [];
  return (
    <Card
      title={tab.label}
      description={`${tab.source.kind === "sheets" ? "Google Sheet tab" : "CSV"} · ${tab.rowsRead.toLocaleString("en-US")} data rows${tab.source.kind === "sheets" ? " in the preview read" : ""}${tab.truncated ? " (file cut at the row cap)" : ""}`}
      actions={
        <Button size="sm" variant="ghost" onClick={onRemove}>
          Remove
        </Button>
      }
    >
      <div className="space-y-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField
            label="Import into"
            value={tab.destination}
            onChange={(e) => {
              const d = e.target.value as ImportDestination;
              onChange({ destination: d, mapping: defaultMapping(tab.suggestion, d, tab.headers, tab.label), keepInSync: tab.keepInSync && canSync({ source: tab.source, destination: d }) });
            }}
            hint={`Suggested: ${destinationLabel(tab.suggestion.destination)}. ${tab.suggestion.reason}`}
          >
            {IMPORT_DESTINATIONS.map((d) => (
              <option key={d} value={d}>
                {DESTINATION_LABELS[d]}
              </option>
            ))}
          </SelectField>
          <div className="space-y-2 text-sm">
            {tab.destination === "geo_prompts" && (
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={tab.options.approvePrompts === true} onChange={(e) => onChange({ options: { ...tab.options, approvePrompts: e.target.checked } })} />
                Save prompts approved (otherwise pending your approval)
              </label>
            )}
            {syncable && (
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={tab.keepInSync} onChange={(e) => onChange({ keepInSync: e.target.checked })} />
                  Keep in sync
                </label>
                {tab.keepInSync && (
                  <select aria-label="Sync frequency" className="rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950" value={tab.frequencyHours} onChange={(e) => onChange({ frequencyHours: Number(e.target.value) })}>
                    {SYNC_FREQUENCIES.map((h) => (
                      <option key={h} value={h}>
                        {frequencyLabel(h)}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}
            {syncable && tab.keepInSync && (
              <p className="text-xs text-zinc-600 dark:text-zinc-400">
                Okara re-reads this tab on schedule: new rows are added
                {tab.destination === "implemented_links" ? "" : tab.destination === "geo_prompts" ? "; removed questions are archived" : "; removed domains stop being tracked (history kept)"}.
              </p>
            )}
          </div>
        </div>
        <MappingFields destination={tab.destination} mapping={tab.mapping} headers={tab.headers} onChange={(m) => onChange({ mapping: m })} />
        <details>
          <summary className="cursor-pointer text-sm font-medium">Preview (first {tab.rows.length} rows, plain text)</summary>
          <div className="mt-2">
            <PreviewTable headers={tab.headers} rows={tab.rows} />
          </div>
        </details>

        {promptCompetitors.length > 0 && (
          <fieldset className="space-y-1">
            <legend className="text-sm font-medium">Track these competitors from the "(position)" headers?</legend>
            <div className="flex flex-wrap gap-3">
              {promptCompetitors.map((c) => (
                <label key={c.name} className="flex items-center gap-1 text-sm">
                  <input
                    type="checkbox"
                    checked={(tab.options.addCompetitors ?? []).includes(c.name)}
                    onChange={(e) => {
                      const cur = tab.options.addCompetitors ?? [];
                      onChange({ options: { ...tab.options, addCompetitors: e.target.checked ? [...cur, c.name] : cur.filter((x) => x !== c.name) } });
                    }}
                  />
                  {c.name}
                </label>
              ))}
            </div>
          </fieldset>
        )}

        <div className="flex flex-wrap gap-2">
          <Button onClick={onDryRun} disabled={busy !== null}>
            {busy === `dry:${tab.id}` ? "Checking…" : "Dry run"}
          </Button>
          <Button variant="primary" onClick={onImport} disabled={busy !== null || !plan || disabled}>
            {busy === `commit:${tab.id}` ? "Importing…" : tab.keepInSync && syncable ? "Import and keep in sync" : "Import"}
          </Button>
          {!plan && <span className="self-center text-xs text-zinc-600 dark:text-zinc-400">Run the dry run first to see what changes.</span>}
        </div>
        {error && <Notice tone="danger">{error}</Notice>}
        {plan && <PlanView plan={plan} excluded={excluded} onToggle={onToggleExclude} disabled={disabled} />}
        {result && (
          <Notice tone={result.import ? "success" : "info"}>
            {result.import ? `Imported: ${countsText(result.import.destination, result.import.counts)}.` : "Nothing changed: everything is already up to date."}
            {result.sync ? ` Kept in sync (${frequencyLabel(result.sync.frequencyHours).toLowerCase()}).` : ""}
          </Notice>
        )}
        {plan && !planHasChanges(plan) && !result && <p className="text-xs text-zinc-600 dark:text-zinc-400">The dry run found nothing new to import.</p>}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ syncs, history, documents
export function SyncList({ syncs, canManage, base, projectId, onChanged }: { syncs: ImportSyncSummary[]; canManage: boolean; base: string; projectId: string; onChanged: () => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  if (syncs.length === 0) return null;
  const act = async (fn: () => Promise<unknown>) => {
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg(errorMessage(e));
    }
    onChanged();
  };
  return (
    <Card title="Kept in sync" description="Sheet tabs Okara re-reads on schedule (never more often than every 6 hours). Failures stay here and on the Overview until fixed.">
      <ul className="divide-y divide-zinc-100 dark:divide-zinc-800" data-testid="sync-list">
        {syncs.map((s) => (
          <li key={s.id} className="space-y-1 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">
                {`${s.spreadsheetTitle} · ${s.tab}`}
              </span>
              <span className="text-sm text-zinc-600 dark:text-zinc-400">→ {destinationLabel(s.destination)}</span>
              <Badge tone={s.lastStatus === "error" ? "danger" : s.enabled ? "success" : "neutral"}>{syncStatusText(s)}</Badge>
            </div>
            <p className="text-xs text-zinc-600 dark:text-zinc-400">
              {frequencyLabel(s.frequencyHours)} · last sync {s.lastRunAt ? formatRelative(s.lastRunAt) : "never"} · next {s.enabled ? formatDateTime(s.nextRunAt) : "paused"}
              {s.lastTransport === "maton" ? " · read via Maton" : ""}
            </p>
            {s.lastStatus === "error" && (
              <div className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100">
                <p className="font-medium">{syncErrorLabel(s.lastErrorCode)}</p>
                {s.lastError && <PlainText text={s.lastError} />}
                <p className="mt-1 text-xs">{syncErrorHelp(s.lastErrorCode)}</p>
              </div>
            )}
            {s.lastWarning && <p className="text-xs text-amber-800 dark:text-amber-300">{s.lastWarning}</p>}
            {s.lastChanges.length > 0 && (
              <p className="text-xs" data-testid="sync-changes">
                {s.lastChanges.slice(0, 8).join(", ")}
                {s.lastChanges.length > 8 ? ` … (+${s.lastChanges.length - 8})` : ""}
                {s.lastRunAt ? `, synced ${formatDateTime(s.lastRunAt)}` : ""}
              </p>
            )}
            {canManage && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button size="sm" onClick={() => act(() => api(`${base}/syncs/${s.id}/run`, { method: "POST" }))}>
                  Sync now
                </Button>
                <select
                  aria-label="Sync frequency"
                  className="rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                  value={s.frequencyHours}
                  onChange={(e) => act(() => api(`${base}/syncs/${s.id}`, { method: "PATCH", body: { frequencyHours: Number(e.target.value) } }))}
                >
                  {SYNC_FREQUENCIES.map((h) => (
                    <option key={h} value={h}>
                      {frequencyLabel(h)}
                    </option>
                  ))}
                </select>
                <Button size="sm" variant="ghost" onClick={() => act(() => api(`${base}/syncs/${s.id}`, { method: "PATCH", body: { enabled: !s.enabled } }))}>
                  {s.enabled ? "Pause" : "Resume"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => act(() => api(`${base}/syncs/${s.id}`, { method: "DELETE" }))}>
                  Stop syncing
                </Button>
                {(s.lastErrorCode === "token_expired" || s.lastErrorCode === "not_connected") && (
                  <a className={buttonClass("primary", "sm")} href={`/api/projects/${encodeURIComponent(projectId)}/import/sheets/connect`}>
                    Reconnect Google Sheets
                  </a>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {msg && <div className="px-4 pb-3"><Notice tone="danger">{msg}</Notice></div>}
    </Card>
  );
}

export function HistoryList({ history, canManage, base, onChanged }: { history: ImportRecordSummary[]; canManage: boolean; base: string; onChanged: () => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <Card title="Import history" description="Undo is available for the latest import of each destination: rows it created are removed and what it changed is restored.">
      {history.length === 0 ? (
        <div className="p-4">
          <EmptyState title="No imports yet">Imported tabs, and syncs that changed something, appear here.</EmptyState>
        </div>
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800" data-testid="history">
          {history.map((h) => (
            <li key={h.id} className="space-y-1 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">
                  {`${h.sourceName}${h.tab && h.tab !== h.sourceName ? ` · ${h.tab}` : ""}`}
                </span>
                <span className="text-sm text-zinc-600 dark:text-zinc-400">→ {destinationLabel(h.destination)}</span>
                {h.trigger === "sync" && <Badge tone="info">Sync</Badge>}
                {h.status === "undone" && <Badge tone="neutral">Undone</Badge>}
              </div>
              <p className="text-xs text-zinc-600 dark:text-zinc-400">
                {formatDateTime(h.createdAt)} · {countsText(h.destination, h.counts)} · {h.rowsRead.toLocaleString("en-US")} rows read
              </p>
              {h.changes.length > 0 && (
                <details>
                  <summary className="cursor-pointer text-xs">What changed ({h.changes.length})</summary>
                  <ul className="mt-1 max-h-48 overflow-y-auto text-xs">
                    {h.changes.map((c, i) => (
                      <li key={i} className="break-words">
                        {c}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {canManage && h.canUndo && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    setMsg(null);
                    try {
                      await api(`${base}/${h.id}/undo`, { method: "POST" });
                    } catch (e) {
                      setMsg(errorMessage(e));
                    }
                    onChanged();
                  }}
                >
                  Undo this import
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {msg && <div className="px-4 pb-3"><Notice tone="danger">{msg}</Notice></div>}
    </Card>
  );
}

function DocumentList({ documents, projectId }: { documents: ImportOverview["documents"]; projectId: string }) {
  const sorted = useMemo(() => [...documents].sort((a, b) => a.title.localeCompare(b.title)), [documents]);
  if (documents.length === 0) return null;
  return (
    <Card title="Imported research documents" description="Capped plain-text tables the agents and Ask Okara can read as evidence (never as instructions). Each keeps its source, tab, import date and row cap.">
      <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
        {sorted.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
            <span className="min-w-0 break-words">{d.title}</span>
            <span className="text-xs text-zinc-600 dark:text-zinc-400">
              v{d.version} · {formatRelative(d.createdAt)} · {d.chars.toLocaleString("en-US")} characters
            </span>
          </li>
        ))}
      </ul>
      <p className="px-4 pb-3 text-xs">
        Full text: <Link to={projectPath(projectId)}>Overview → Context</Link>.
      </p>
    </Card>
  );
}
