/**
 * [A23] Redirect map tool. Route: /projects/:projectId/redirects
 * Old URLs (paste or CSV import) are mapped to new URLs (pasted, or the latest crawl's 2xx pages):
 * exact path and normalized-slug matches are automatic; everything else is shortlisted and, when
 * TypeSafe is configured, sent to Jev. Uncertain rows are flagged for review and the user decides
 * them here. The CSV download holds automatic rows plus the rows the user resolved. Okara never
 * changes redirects. All URLs and notes render as plain text.
 */
import { useId, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Link } from "react-router";
import type { IntegrationsStatus, RedirectMapRequest, RedirectMapResult } from "@shared/types";
import { api } from "@web/lib/api";
import { useApi, useMutation } from "@web/lib/hooks";
import { formatNumber } from "@web/lib/format";
import { projectPath, useProject } from "@web/lib/project-context";
import { Badge, Button, Card, ErrorState, MetricTile, PageHeader, StateBadge, StateBanner, TextArea, buttonClass, cx } from "@web/components/ui";
import { MAX_IMPORT_BYTES, MAX_NEW_URLS, MAX_OLD_URLS, MAX_URL_LENGTH, buildDownloadCsv, parseCsvFirstColumn, splitLines } from "./csv";
import { RedirectResultsTable, NO_REDIRECT, type Decisions } from "./components/RedirectResultsTable";

const LABEL_REVIEW_ONLY = "Suggestions for review. Okara never changes your redirects.";
const LABEL_UNCERTAIN = "Uncertain matches are flagged, not redirected.";

type NewSource = "crawl" | "paste";

export function RedirectMapPage() {
  const { project, projectId } = useProject();
  const pid = encodeURIComponent(projectId);
  const integrations = useApi<IntegrationsStatus>(`/projects/${pid}/integrations`);
  const typesafe = integrations.data?.providers.find((p) => p.provider === "typesafe") ?? null;
  const jevConfigured = !!typesafe && typesafe.source !== "none";
  const jevAvailable = !project.isDemo && jevConfigured;

  const [oldText, setOldText] = useState("");
  const [newSource, setNewSource] = useState<NewSource>("crawl");
  const [newText, setNewText] = useState("");
  const [useJev, setUseJev] = useState(true);
  const [importNote, setImportNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [result, setResult] = useState<RedirectMapResult | null>(null);
  const [decisions, setDecisions] = useState<Decisions>({});
  const fileRef = useRef<HTMLInputElement>(null);
  const ids = { file: useId(), jev: useId(), jevHint: useId(), source: useId() };

  const oldUrls = useMemo(() => splitLines(oldText), [oldText]);
  const newUrls = useMemo(() => splitLines(newText), [newText]);
  const tooLongOld = oldUrls.some((u) => u.length > MAX_URL_LENGTH);
  const tooLongNew = newUrls.some((u) => u.length > MAX_URL_LENGTH);
  const oldError =
    oldUrls.length > MAX_OLD_URLS
      ? `${formatNumber(oldUrls.length)} lines: at most ${MAX_OLD_URLS} old URLs per request. Split the list and run it in parts.`
      : tooLongOld
        ? `Each URL can be at most ${formatNumber(MAX_URL_LENGTH)} characters.`
        : null;
  const newError =
    newSource !== "paste"
      ? null
      : newUrls.length === 0
        ? "Paste at least one new URL, or use the latest crawl."
        : newUrls.length > MAX_NEW_URLS
          ? `${formatNumber(newUrls.length)} lines: at most ${formatNumber(MAX_NEW_URLS)} new URLs.`
          : tooLongNew
            ? `Each URL can be at most ${formatNumber(MAX_URL_LENGTH)} characters.`
            : null;

  const mapper = useMutation((body: RedirectMapRequest) => api<RedirectMapResult>(`/projects/${pid}/seo/redirect-map`, { method: "POST", body }));
  const canRun = oldUrls.length > 0 && !oldError && !newError && !mapper.loading;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canRun) return;
    const body: RedirectMapRequest = { oldUrls, useJev: jevAvailable && useJev };
    if (newSource === "paste") body.newUrls = newUrls;
    const r = await mapper.run(body);
    if (r) {
      setResult(r);
      setDecisions({});
    }
  }

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      setImportNote({ tone: "error", text: `${file.name} is larger than 2 MB. Import a smaller file.` });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      const urls = parseCsvFirstColumn(text);
      if (urls.length === 0) {
        setImportNote({ tone: "error", text: `No URLs found in the first column of ${file.name}.` });
        return;
      }
      setOldText(urls.join("\n"));
      setImportNote({
        tone: urls.length > MAX_OLD_URLS ? "error" : "ok",
        text: `Imported ${formatNumber(urls.length)} URL${urls.length === 1 ? "" : "s"} from the first column of ${file.name}.${urls.length > MAX_OLD_URLS ? ` Only ${MAX_OLD_URLS} can be mapped per request.` : ""}`,
      });
    };
    reader.onerror = () => setImportNote({ tone: "error", text: `Could not read ${file.name}.` });
    reader.readAsText(file);
  }

  const resolved = useMemo(() => {
    if (!result) return [];
    const out: Array<{ from: string; to: string }> = [];
    result.rows.forEach((row, i) => {
      const d = decisions[i];
      if (row.status === "review" && d && d !== NO_REDIRECT) out.push({ from: row.from, to: d });
    });
    return out;
  }, [result, decisions]);
  const decidedCount = result ? result.rows.filter((r, i) => r.status === "review" && decisions[i]).length : 0;
  const download = useMemo(() => (result ? buildDownloadCsv(result.shopifyCsv, resolved) : null), [result, resolved]);
  const autoCsvRows = result ? Math.max(0, result.shopifyCsv.trim().split("\n").length - 1) : 0;

  function onDownload() {
    if (!download) return;
    const blob = new Blob([download.csv], { type: "text/csv;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = `redirects-${(project.verifiedHost ?? "site").replace(/[^a-z0-9.-]/gi, "_")}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }

  const serverLabels = result ? result.labels.filter((l) => l !== LABEL_REVIEW_ONLY && l !== LABEL_UNCERTAIN) : [];

  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        title="Redirect map"
        description="Match old URLs to the pages that replace them. Exact paths and matching slugs are mapped automatically; other URLs get a shortlist of likely pages and, when Jev is configured, one narrow choice each."
      />

      <div role="note" aria-label="How to use these suggestions" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
        <p className="font-semibold">{LABEL_REVIEW_ONLY}</p>
        <p className="font-semibold">{LABEL_UNCERTAIN}</p>
        <p className="mt-1 text-xs">The download contains automatic matches and the review rows you decide below. Import it in Shopify only after checking it.</p>
      </div>

      <Card title="Inputs">
        <form onSubmit={onSubmit} className="space-y-4 p-4" noValidate>
          <div className="space-y-2">
            <TextArea
              label="Old URLs (one per line)"
              value={oldText}
              onChange={(e) => setOldText(e.target.value)}
              rows={8}
              spellCheck={false}
              autoComplete="off"
              placeholder={`https://${project.verifiedHost ?? "your-store.example"}/old-page\n/collections/sale/products/old-product`}
              hint={`${formatNumber(oldUrls.length)} of ${MAX_OLD_URLS}. Paths or full URLs on your site. Query strings are ignored.`}
              error={oldError}
              className="font-mono text-xs"
            />
            <div className="flex flex-wrap items-center gap-2">
              <input ref={fileRef} id={ids.file} type="file" accept=".csv,text/csv,text/plain" className="sr-only" onChange={onFile} />
              <Button size="sm" onClick={() => fileRef.current?.click()} aria-describedby={`${ids.file}-hint`}>
                Import CSV…
              </Button>
              <span id={`${ids.file}-hint`} className="text-xs text-zinc-600 dark:text-zinc-400">
                Reads the first column; a header row is skipped. Replaces the list above.
              </span>
            </div>
            {importNote && (
              <p role={importNote.tone === "error" ? "alert" : "status"} className={cx("text-xs", importNote.tone === "error" ? "text-red-700 dark:text-red-400" : "text-emerald-800 dark:text-emerald-300")}>
                {importNote.text}
              </p>
            )}
          </div>

          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-medium text-zinc-800 dark:text-zinc-200">New URLs</legend>
            <label className="flex items-start gap-2 text-sm text-zinc-800 dark:text-zinc-200">
              <input type="radio" name={ids.source} className="mt-0.5" checked={newSource === "crawl"} onChange={() => setNewSource("crawl")} />
              <span>
                Use the latest crawl
                <span className="block text-xs text-zinc-600 dark:text-zinc-400">Pages that returned a 2xx status on your verified host. The crawl is capped, so paste the full list for complete coverage.</span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm text-zinc-800 dark:text-zinc-200">
              <input type="radio" name={ids.source} className="mt-0.5" checked={newSource === "paste"} onChange={() => setNewSource("paste")} />
              <span>Paste the new URLs</span>
            </label>
            {newSource === "paste" && (
              <TextArea
                label="New URLs (one per line)"
                value={newText}
                onChange={(e) => setNewText(e.target.value)}
                rows={6}
                spellCheck={false}
                autoComplete="off"
                hint={`${formatNumber(newUrls.length)} of ${formatNumber(MAX_NEW_URLS)}. Must be on ${project.verifiedHost ?? "your verified host"}; other hosts are ignored.`}
                error={newError}
                className="font-mono text-xs"
              />
            )}
          </fieldset>

          <div className="space-y-1">
            <label htmlFor={ids.jev} className={cx("flex items-center gap-2 text-sm", jevAvailable ? "text-zinc-800 dark:text-zinc-200" : "text-zinc-500 dark:text-zinc-400")}>
              <input
                id={ids.jev}
                type="checkbox"
                checked={jevAvailable && useJev}
                disabled={!jevAvailable}
                onChange={(e) => setUseJev(e.target.checked)}
                aria-describedby={ids.jevHint}
              />
              Use Jev for uncertain matches
              {typesafe && !project.isDemo && <StateBadge state={jevConfigured ? typesafe.state : "setup_required"} />}
            </label>
            <p id={ids.jevHint} className="text-xs text-zinc-600 dark:text-zinc-400">
              {project.isDemo ? (
                "Demo projects never call Jev; rows without an exact or slug match are left for your review."
              ) : integrations.loading && !integrations.data ? (
                "Checking whether TypeSafe is configured…"
              ) : jevAvailable ? (
                "Jev picks one page from each shortlist, or none. Only confident answers are applied automatically; the rest are flagged for you. Calls count against this project's daily Jev budget."
              ) : (
                <>
                  TypeSafe is not configured for this workspace, so only exact and slug matches are automatic and everything else needs your review.{" "}
                  <Link to={projectPath(projectId, "integrations")} className="underline">
                    Add a TypeSafe key in Integrations
                  </Link>
                  .
                </>
              )}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="primary" loading={mapper.loading} disabled={!canRun}>
              Map redirects
            </Button>
            <span className="text-xs text-zinc-600 dark:text-zinc-400">Limited to 5 runs per minute.</span>
          </div>
        </form>
      </Card>

      <div aria-live="polite" className="sr-only">
        {mapper.loading ? "Mapping redirects…" : result ? `Mapped ${result.rows.length} URLs: ${result.counts.auto} automatic, ${result.counts.review} to review, ${result.counts.noMatch} with no match.` : ""}
      </div>

      {mapper.error != null && <ErrorState error={mapper.error} title="Could not build the redirect map" />}

      {result && (
        <Card
          title="Suggested redirects"
          description={`Generated ${new Date(result.generatedAt).toLocaleString()}`}
          actions={<StateBadge state={result.state} />}
        >
          <div className="space-y-4 p-4">
            {result.state === "setup_required" && (
              <StateBanner
                state="setup_required"
                message={serverLabels[0] ?? "Nothing could be mapped yet."}
                action={
                  <Link to={projectPath(projectId, project.verifiedAt ? "seo" : "integrations")} className={buttonClass("secondary", "sm")}>
                    {project.verifiedAt ? "Go to SEO audit" : "Verify your site"}
                  </Link>
                }
              />
            )}
            {result.state === "demo" && <StateBanner state="demo" message="Demo data – simulated run. Candidates come from the fictional demo crawl." />}

            {result.rows.length > 0 && (
              <>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <MetricTile label="Automatic" value={formatNumber(result.counts.auto)} sublabel="Exact path, slug, or Jev act tier" />
                  <MetricTile label="To review" value={formatNumber(result.counts.review)} sublabel={`${formatNumber(decidedCount)} decided by you`} />
                  <MetricTile label="No match" value={formatNumber(result.counts.noMatch)} sublabel="Not redirected" />
                  <MetricTile label="Rows in download" value={formatNumber(autoCsvRows + (download?.added ?? 0))} sublabel={`${formatNumber(autoCsvRows)} automatic + ${formatNumber(download?.added ?? 0)} yours`} />
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="primary" onClick={onDownload} disabled={!download || autoCsvRows + download.added === 0}>
                    Download Shopify CSV
                  </Button>
                  <span className="text-xs text-zinc-600 dark:text-zinc-400">
                    Format: <span className="font-mono">Redirect from,Redirect to</span> (paths). Undecided review rows and rows marked “No redirect” are left out.
                  </span>
                </div>

                <RedirectResultsTable rows={result.rows} decisions={decisions} onDecide={(i, v) => setDecisions((d) => ({ ...d, [i]: v }))} />
              </>
            )}

            {serverLabels.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">About these results</h3>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-zinc-700 dark:text-zinc-300">
                  {serverLabels.map((l, i) => (
                    <li key={i} className="break-words">
                      {l}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="flex flex-wrap items-center gap-1 text-xs text-zinc-600 dark:text-zinc-400">
              <Badge tone="warning">Review</Badge> rows are never exported until you choose a page.
            </p>
          </div>
        </Card>
      )}
    </div>
  );
}
