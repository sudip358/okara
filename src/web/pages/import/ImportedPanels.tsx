/**
 * Small read-only panels that show imported sheet data on other pages, always labelled as the owner's sheet data:
 *   PlacedLinksPanel       Internal links page: links placed per the sheet + "found / not found in latest crawl",
 *                          and imported internal-link reference tables next to Okara's own crawl counts.
 *   SheetCompetitorMetrics Competitors page: the sheet's metrics per domain ("from your sheet (third-party tool)").
 *   PromptSheetNotes       GEO prompts page: reference notes per imported question ("from your sheet, not measured by Okara").
 * Every value is untrusted text rendered as plain text.
 */
import { Link } from "react-router";
import { IMPORT_LABEL_SHEET, IMPORT_LABEL_THIRD_PARTY, promptKey, type ImportedCompetitorRow, type ImportedLinksReport } from "@shared/import";
import { formatDate, formatDateTime } from "@web/lib/format";
import { useApi } from "@web/lib/hooks";
import { projectPath } from "@web/lib/project-context";
import { Badge, Card, TBody, TD, TH, THead, TR, Table } from "@web/components/ui";
import { crawlCheckLabel } from "./lib";

export function PlacedLinksView({ report, projectId, crawlCounts }: { report: ImportedLinksReport; projectId: string; crawlCounts?: { pagesAnalysed: number; orphanPages: number } | null }) {
  if (report.total === 0 && report.references.length === 0) return null;
  const found = report.links.filter((l) => l.crawl === "found").length;
  return (
    <Card
      title="Placed per your sheet"
      description={`Links your imported sheet says are already placed. The suggester does not suggest these pairs again. Checked against the latest crawl${report.crawlStartedAt ? ` (${formatDateTime(report.crawlStartedAt)})` : ""}: ${found} of ${report.links.length} found.`}
    >
      {report.links.length > 0 && (
        <Table>
          <THead>
            <TR>
              <TH>Source page</TH>
              <TH>Target</TH>
              <TH>Anchor</TH>
              <TH>Placed</TH>
              <TH>Latest crawl</TH>
            </TR>
          </THead>
          <TBody>
            {report.links.slice(0, 200).map((l) => {
              const c = crawlCheckLabel(l.crawl);
              return (
                <TR key={l.key}>
                  <TD className="max-w-xs break-all">{l.sourceUrl}</TD>
                  <TD className="max-w-xs break-all">{l.targetUrl}</TD>
                  <TD>{l.anchor ?? ""}</TD>
                  <TD className="whitespace-nowrap text-xs">{l.placedOn ?? ""}</TD>
                  <TD>
                    <Badge tone={c.tone}>{c.text}</Badge>
                    {l.status === "removed_from_sheet" && <Badge tone="neutral">removed from sheet</Badge>}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}
      {report.references.length > 0 && (
        <div className="space-y-1 px-4 py-3 text-sm">
          <p className="font-medium">Imported reference tables ({IMPORT_LABEL_SHEET})</p>
          <ul className="list-disc pl-5">
            {report.references.map((r) => (
              <li key={r.id}>
                {r.title} · imported {formatDate(r.createdAt)}
              </li>
            ))}
          </ul>
          {crawlCounts && (
            <p className="text-xs text-zinc-600 dark:text-zinc-400">
              Okara's own latest analysis: {crawlCounts.pagesAnalysed} pages analysed, {crawlCounts.orphanPages} orphan pages within crawl coverage. Differences usually come from crawl
              coverage (Okara crawls up to the project's page limit).
            </p>
          )}
        </div>
      )}
      <p className="px-4 pb-3 text-xs">
        <Link to={projectPath(projectId, "import")}>Manage imports</Link>
      </p>
    </Card>
  );
}

export function PlacedLinksPanel({ projectId, crawlCounts }: { projectId: string; crawlCounts?: { pagesAnalysed: number; orphanPages: number } | null }) {
  const r = useApi<ImportedLinksReport>(projectId ? `/projects/${encodeURIComponent(projectId)}/import/links` : null);
  if (!r.data) return null;
  return <PlacedLinksView report={r.data} projectId={projectId} crawlCounts={crawlCounts} />;
}

export function SheetCompetitorMetricsView({ rows }: { rows: ImportedCompetitorRow[] }) {
  if (rows.length === 0) return null;
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r.metrics)))].slice(0, 12);
  return (
    <Card title="From your sheet" description={`Competitor metrics ${IMPORT_LABEL_THIRD_PARTY}: as imported, not measured by Okara.`}>
      <Table>
        <THead>
          <TR>
            <TH>Domain</TH>
            <TH>Status</TH>
            {cols.map((c) => (
              <TH key={c}>{c}</TH>
            ))}
            <TH>Notes</TH>
            <TH>Imported</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map((r) => (
            <TR key={r.domain}>
              <TD className="whitespace-nowrap">{r.domain}</TD>
              <TD>
                <Badge tone={r.status === "tracked" ? "success" : r.status === "removed_from_sheet" ? "neutral" : "warning"}>
                  {r.status === "tracked" ? "tracked" : r.status === "removed_from_sheet" ? `removed from sheet${r.removedAt ? ` ${formatDate(r.removedAt)}` : ""}` : "not tracked (limit)"}
                </Badge>
              </TD>
              {cols.map((c) => (
                <TD key={c} className="whitespace-nowrap">
                  {r.metrics[c] ?? ""}
                </TD>
              ))}
              <TD className="max-w-xs break-words text-xs">{[r.notes, r.assignedTo ? `assigned to ${r.assignedTo}` : null].filter(Boolean).join(" · ")}</TD>
              <TD className="whitespace-nowrap text-xs">{formatDate(r.importedAt)}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </Card>
  );
}

export function SheetCompetitorMetrics({ projectId }: { projectId: string }) {
  const r = useApi<ImportedCompetitorRow[]>(projectId ? `/projects/${encodeURIComponent(projectId)}/import/records/competitors` : null);
  return r.data ? <SheetCompetitorMetricsView rows={r.data} /> : null;
}

export interface PromptNote {
  key: string;
  text: string;
  status: string;
  notes: Record<string, string>;
  done: string | null;
  importedAt: string;
}

/** Notes for one prompt text, or null. */
export function noteFor(notes: PromptNote[] | null, text: string): PromptNote | null {
  if (!notes) return null;
  const k = promptKey(text);
  return notes.find((n) => n.key === k) ?? null;
}

export function PromptSheetNote({ note }: { note: PromptNote | null }) {
  if (!note || (Object.keys(note.notes).length === 0 && !note.done)) return null;
  const parts = Object.entries(note.notes).map(([k, v]) => `${k}: ${v}`);
  if (note.done) parts.unshift(`Done: ${note.done}`);
  return (
    <p className="text-xs text-zinc-600 dark:text-zinc-400" data-testid="prompt-sheet-note">
      <span className="font-medium">{`From your sheet (${IMPORT_LABEL_SHEET.replace("from your sheet, ", "")}):`}</span> {parts.join(" · ")}
    </p>
  );
}

export function usePromptNotes(projectId: string) {
  return useApi<PromptNote[]>(projectId ? `/projects/${encodeURIComponent(projectId)}/import/records/geo_prompts` : null).data;
}
