/** GSC performance CSV import. Clearly labelled as an import, not a live API sync. */
import { useId, useState } from "react";
import { api, errorMessage } from "@web/lib/api";
import { Badge, Button, Card, SelectField, StateBanner, TextField } from "@web/components/ui";

const MAX_BYTES = 5 * 1024 * 1024;

function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("Could not read file."));
    reader.readAsText(file);
  });
}

export function CsvImportPanel({ projectId, onImported }: { projectId: string; onImported: () => void }) {
  const fileId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [windowKind, setWindowKind] = useState<"current" | "previous">("current");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const dateError = start && end && start > end ? "Start date must be on or before the end date." : null;
  const fileError = file && file.size > MAX_BYTES ? "File is larger than 5 MB." : null;

  const submit = async () => {
    if (!file || !start || !end || dateError || fileError) return;
    setBusy(true);
    setResult(null);
    try {
      const csv = await readFileText(file);
      await api<unknown>(`/projects/${encodeURIComponent(projectId)}/seo/import-csv`, {
        method: "POST",
        body: { csv, window: windowKind, start, end },
      });
      setResult({ ok: true, text: `Imported ${file.name} as the ${windowKind} window (${start} to ${end}). Labelled as a CSV import.` });
      onImported();
    } catch (e) {
      setResult({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={
        <span className="inline-flex flex-wrap items-center gap-2">
          Import Search Console CSV <Badge tone="warning">Imported CSV (not live API)</Badge>
        </span>
      }
      description="Use an export from Search Console's Performance report when the API is not connected. Imported rows are labelled csv_import everywhere they appear and are not treated as a live sync."
    >
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="sm:col-span-2">
          <label htmlFor={fileId} className="mb-1 block text-sm font-medium text-zinc-800 dark:text-zinc-200">
            CSV file <span className="text-red-700 dark:text-red-400">*</span>
          </label>
          <input
            id={fileId}
            type="file"
            accept=".csv,text/csv"
            required
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-zinc-700 file:mr-3 file:rounded-lg file:border file:border-zinc-300 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-zinc-800 hover:file:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 dark:text-zinc-300 dark:file:border-zinc-700 dark:file:bg-zinc-900 dark:file:text-zinc-100"
            aria-invalid={fileError ? true : undefined}
          />
          {fileError && (
            <p role="alert" className="mt-1 text-xs text-red-700 dark:text-red-400">
              {fileError}
            </p>
          )}
        </div>
        <SelectField label="Window" value={windowKind} onChange={(e) => setWindowKind(e.target.value as "current" | "previous")}>
          <option value="current">Current 28-day window</option>
          <option value="previous">Previous 28-day window</option>
        </SelectField>
        <div className="grid grid-cols-2 gap-3">
          <TextField label="Start date" type="date" required value={start} onChange={(e) => setStart(e.target.value)} />
          <TextField label="End date" type="date" required value={end} onChange={(e) => setEnd(e.target.value)} error={dateError} />
        </div>
        <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" loading={busy} disabled={!file || !start || !end || !!dateError || !!fileError}>
            Import CSV
          </Button>
          <span className="text-xs text-zinc-600 dark:text-zinc-400">The dates must match the export's date range; they are stored as the window.</span>
        </div>
      </form>
      {result && <StateBanner className="mt-3" state={result.ok ? "completed" : "failed"} title={result.ok ? "Imported" : "Import failed"} message={result.text} />}
    </Card>
  );
}
