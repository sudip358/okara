/**
 * [A37] "From Search Console" on the GEO prompts page: question-style queries from the project's stored Search
 * Console sync (deterministic, free: no AI call). Pick rows and "Add selected as prompts": they are saved
 * UNAPPROVED in a new prompt-set version (POST /geo/prompts/from-gsc), then approved as usual.
 * Queries and landing pages come from Search Console: untrusted text, rendered as plain text only.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router";
import type { GeoPromptSet } from "@shared/types";
import type { GscAddedPrompt, GscQuestionCandidate, GscQuestionsAddResult, GscQuestionsResponse } from "@shared/gsc-questions";
import { api, errorMessage } from "@web/lib/api";
import { projectPath } from "@web/lib/project-context";
import { Badge, Button, Card, ErrorState, LoadingState, StateBanner, TBody, TD, TH, THead, TR, Table } from "@web/components/ui";
import { RULE_LABEL, addedNoteText, countHeadline, intText, landingPath, positionText, selectTop, selectionLimit, syncText, toggleKey } from "./gsc-questions-lib";

export interface GscQuestionsPanelProps {
  projectId: string;
  /** GET /geo/prompts/from-gsc state (fetched by the page so prompt notes can use `added`). */
  data: GscQuestionsResponse | null;
  error: unknown;
  loading: boolean;
  onReload: () => void;
  includeBrand: boolean;
  onIncludeBrand: (v: boolean) => void;
  /** Active set id the page shows (null = no set yet). */
  setId: string | null;
  /** Unsaved edits on the page: adding would discard them, so it is disabled until saved or discarded. */
  dirty: boolean;
  onAdded: (set: GeoPromptSet, added: number) => void;
  defaultOpen?: boolean;
}

export function GscQuestionsPanel(p: GscQuestionsPanelProps) {
  const d = p.data;
  const [open, setOpen] = useState(p.defaultOpen ?? false);
  const headline = countHeadline(d);
  const sync = syncText(d);
  return (
    <Card
      id="from-search-console"
      title="From Search Console"
      description={
        <>
          Question-style queries people already typed into Google for your site, from your stored Search Console sync. Free and deterministic (no AI call);
          each is added exactly as typed.
        </>
      }
      actions={
        <>
          {headline && (
            <Badge tone={d && d.counts.eligible > 0 ? "info" : "neutral"}>
              <span data-testid="gsc-question-count">{headline}</span>
            </Badge>
          )}
          {d?.state === "demo" && <Badge tone="demo">Demo data</Badge>}
          <Button size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls="gsc-questions-body">
            {open ? "Hide" : "Review questions"}
          </Button>
        </>
      }
    >
      {sync && <p className="mb-2 text-xs text-zinc-600 dark:text-zinc-400">Search Console, {sync}</p>}
      {open && (
        <div id="gsc-questions-body" className="min-w-0">
          <GscQuestionsBody {...p} />
        </div>
      )}
    </Card>
  );
}

function GscQuestionsBody(p: GscQuestionsPanelProps) {
  const d = p.data;
  if (!d) return p.error ? <ErrorState error={p.error} onRetry={p.onReload} title="Could not load Search Console questions" /> : <LoadingState label="Reading your stored Search Console queries…" />;
  if (d.state === "setup_required") {
    return (
      <div className="rounded-lg border border-dashed border-zinc-300 px-4 py-6 text-center dark:border-zinc-700" data-testid="gsc-questions-setup">
        <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Setup required</p>
        <p className="mx-auto mt-1 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">{d.message}</p>
        <Link className="mt-3 inline-block text-sm font-medium text-sky-700 underline dark:text-sky-300" to={projectPath(p.projectId, "integrations")}>
          Connect Search Console in Integrations
        </Link>
      </div>
    );
  }
  if (d.state === "disabled") return <StateBanner state="disabled" title="Not available" message={d.message ?? "Question detection is not available for this project."} />;
  return <CandidateTable {...p} data={d} />;
}

function CandidateTable(p: GscQuestionsPanelProps & { data: GscQuestionsResponse }) {
  const d = p.data;
  const room = d.promptSet?.room ?? 25;
  const limit = selectionLimit(room);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string; details?: string[] } | null>(null);
  const keys = useMemo(() => d.candidates.map((c) => c.key), [d.candidates]);
  const chosen = keys.filter((k) => selected.has(k));

  const add = async () => {
    setAdding(true);
    setResult(null);
    try {
      const res = await api<GscQuestionsAddResult>(`/projects/${encodeURIComponent(p.projectId)}/geo/prompts/from-gsc`, {
        method: "POST",
        body: { queries: chosen, setId: p.setId, includeBrand: p.includeBrand },
      });
      setSelected(new Set());
      const n = res.added.length;
      const rep = res.added.filter((a) => a.promptType === "reputation").length;
      setResult({
        ok: true,
        message: `Added ${n} prompt${n === 1 ? "" : "s"} as unapproved in version ${res.set.version}${rep ? ` (${rep} name a tracked brand and are reputation prompts)` : ""}. Tick “Approved to run” and save to include them in GEO runs.`,
        details: res.skipped.map((s) => `${s.query}: ${s.reason}`),
      });
      p.onAdded(res.set, n);
    } catch (e) {
      setResult({ ok: false, message: errorMessage(e) });
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300">
          <input
            type="checkbox"
            checked={p.includeBrand}
            onChange={(e) => p.onIncludeBrand(e.target.checked)}
            className="h-4 w-4 rounded border-zinc-300 accent-zinc-900 dark:accent-zinc-100"
          />
          Include queries with your brand name (added as reputation prompts)
        </label>
        <p className="text-xs text-zinc-600 dark:text-zinc-400" aria-live="polite">
          {room === 0 ? "The prompt set is full (25 prompts): remove prompts to make room." : `${chosen.length} selected · room for ${intText(room)} more in the set`}
        </p>
      </div>

      {d.candidates.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-300 px-3 py-6 text-center text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-400" data-testid="gsc-questions-empty">
          No new question queries in the stored sync. Queries already in your prompt set are not suggested again.
        </p>
      ) : (
        <Table caption="Question queries from Search Console, by impressions">
          <THead>
            <TR>
              <TH className="w-8">
                <span className="sr-only">Select</span>
              </TH>
              <TH>Question (as searched)</TH>
              <TH className="text-right">Impr.</TH>
              <TH className="hidden text-right sm:table-cell">Clicks</TH>
              <TH className="text-right">Pos.</TH>
              <TH className="hidden md:table-cell">Landing page</TH>
            </TR>
          </THead>
          <TBody>
            {d.candidates.map((c, i) => (
              <CandidateRow
                key={c.key}
                c={c}
                index={i}
                checked={selected.has(c.key)}
                disabled={!selected.has(c.key) && selected.size >= limit}
                onToggle={() => setSelected((s) => toggleKey(s, c.key, limit))}
              />
            ))}
          </TBody>
        </Table>
      )}

      {d.counts.eligible > d.candidates.length && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Showing the top {intText(d.candidates.length)} of {intText(d.counts.eligible)} by impressions.
        </p>
      )}

      {p.dirty && <StateBanner state="pending" title="Unsaved changes" message="Save or discard your edits to the prompt list first; adding creates a new prompt-set version." />}
      {result && (
        <StateBanner
          state={result.ok ? "completed" : "failed"}
          title={result.ok ? "Added" : "Not added"}
          message={
            result.details && result.details.length > 0 ? (
              <>
                <p>{result.message}</p>
                <ul className="mt-1 list-inside list-disc text-xs">
                  {result.details.map((m) => (
                    <li key={m} className="break-words">
                      {m}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              result.message
            )
          }
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => setSelected(selectTop(keys, limit))} disabled={d.candidates.length === 0 || limit === 0}>
          Select top {intText(Math.min(limit, d.candidates.length))}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())} disabled={chosen.length === 0}>
          Clear
        </Button>
        <Button size="sm" variant="primary" onClick={() => void add()} loading={adding} disabled={chosen.length === 0 || p.dirty}>
          Add selected as prompts{chosen.length ? ` (${chosen.length})` : ""}
        </Button>
      </div>

      <ul className="space-y-0.5 text-[11px] text-zinc-500 dark:text-zinc-400" aria-label="How these are selected">
        {d.labels.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </div>
  );
}

function CandidateRow({ c, index, checked, disabled, onToggle }: { c: GscQuestionCandidate; index: number; checked: boolean; disabled: boolean; onToggle: () => void }) {
  const e = c.evidence;
  const id = `gscq-${index}`;
  const typedDiffers = c.text.replace(/\?$/, "").toLowerCase() !== e.query.toLowerCase();
  return (
    <TR data-testid="gsc-question-row">
      <TD className="w-8">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={onToggle}
          className="mt-0.5 h-4 w-4 rounded border-zinc-300 accent-zinc-900 focus-visible:outline-2 focus-visible:outline-sky-600 dark:accent-zinc-100"
        />
      </TD>
      <TD className="min-w-0">
        <label htmlFor={id} className="block break-words text-sm text-zinc-900 dark:text-zinc-100">
          {c.text}
        </label>
        <p className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-zinc-600 dark:text-zinc-400">
          {c.promptType === "reputation" && <Badge tone="warning">Reputation (names a tracked brand)</Badge>}
          <span>{c.rules.map((r) => RULE_LABEL[r]).join(" · ")}</span>
          {typedDiffers && <span className="break-all">· searched as “{e.query}”</span>}
          {c.variants.length > 0 && (
            <span title={c.variants.map((v) => `${v.query} (${intText(v.impressions)})`).join("\n")}>· +{c.variants.length} similar</span>
          )}
        </p>
        <p className="mt-0.5 text-[11px] text-zinc-500 sm:hidden dark:text-zinc-400">
          {intText(e.clicks)} clicks · {landingPath(e.landingPage)}
        </p>
        <p className="mt-0.5 hidden truncate text-[11px] text-zinc-500 sm:block md:hidden dark:text-zinc-400" title={e.landingPage ?? undefined}>
          {landingPath(e.landingPage)}
        </p>
      </TD>
      <TD className="text-right font-mono tabular-nums">{intText(e.impressions)}</TD>
      <TD className="hidden text-right font-mono tabular-nums sm:table-cell">{intText(e.clicks)}</TD>
      <TD className="text-right font-mono tabular-nums">{positionText(e.position)}</TD>
      <TD className="hidden max-w-56 md:table-cell">
        <span className="block truncate text-xs" title={e.landingPage ?? undefined}>
          {landingPath(e.landingPage)}
        </span>
      </TD>
    </TR>
  );
}

/** Note under a prompt that came from Search Console (provenance kept server-side). */
export function PromptGscNote({ note }: { note: GscAddedPrompt | null }) {
  if (!note) return null;
  return (
    <p className="text-xs text-zinc-600 dark:text-zinc-400" data-testid="prompt-gsc-note">
      <span className="font-medium">From Search Console:</span> {addedNoteText(note)}
    </p>
  );
}
