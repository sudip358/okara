/**
 * 08 Internal links judged (Borja link map, docs/live-view-design.md section 4). The report is the stored
 * internal-link run (GET /seo/internal-links); this run's "Links" element rows move the highlight to their
 * destination bucket. Sentences and anchors are plain text; the anchor is a <mark> around a text slice.
 */
import { Link } from "react-router";
import type { LinkRole, LinkSuggestion, LinkSuggestionReport, LiveSeoElementRow } from "@shared/types";
import { projectPath } from "@web/lib/project-context";
import { cx, ErrorState } from "@web/components/ui";
import { Crossfade, Shimmer } from "../motion";
import { JevChip, Panel, PanelEmpty, ToneChip } from "../parts";
import { clipText, fmtInt, jevChipText, shortDate, urlPath } from "../text";

const ROLE_LABEL: Record<LinkRole, string> = {
  explains_concept: "Explains a concept",
  deeper_detail: "Deeper detail",
  broader_guide: "Broader guide",
  next_step: "Next step",
  product_service: "Product or service",
  comparison: "Comparison",
};

/** Sentence split around the first occurrence of the anchor (case-insensitive); plain-text slices only. */
export function markAnchor(sentence: string, anchor: string | null | undefined): Array<{ text: string; mark: boolean }> {
  if (!anchor) return [{ text: sentence, mark: false }];
  const i = sentence.toLowerCase().indexOf(anchor.toLowerCase());
  if (i < 0) return [{ text: sentence, mark: false }];
  return [
    { text: sentence.slice(0, i), mark: false },
    { text: sentence.slice(i, i + anchor.length), mark: true },
    { text: sentence.slice(i + anchor.length), mark: false },
  ].filter((s) => s.text.length > 0);
}

interface Bucket {
  key: string;
  url: string;
  orphan: boolean;
  inlinks: number;
  sources: LinkSuggestion[];
}

export function linkBuckets(suggestions: readonly LinkSuggestion[], max = 6): Bucket[] {
  const m = new Map<string, Bucket>();
  for (const s of suggestions) {
    if (s.status === "rejected") continue;
    const key = s.target.pageId || s.target.url;
    const b = m.get(key) ?? { key, url: s.target.url, orphan: s.target.orphan, inlinks: s.target.inlinks, sources: [] };
    b.sources.push(s);
    m.set(key, b);
  }
  return Array.from(m.values())
    .sort((a, b) => b.sources.length - a.sources.length || (a.url < b.url ? -1 : 1))
    .slice(0, max);
}

export function LinksPanel({
  report,
  runRows,
  reduced,
  projectId,
  replaying,
}: {
  report: { data: LinkSuggestionReport | null; error: unknown };
  /** This run's revealed Links rows with a link suggestion id (ascending). */
  runRows: LiveSeoElementRow[];
  reduced: boolean;
  projectId: string;
  replaying: boolean;
}) {
  const r = report.data;
  const suggestions = r?.suggestions ?? [];
  const byId = new Map(suggestions.map((s) => [s.id, s]));
  const latest = [...runRows].reverse().find((row) => row.linkSuggestionId && byId.has(row.linkSuggestionId)) ?? null;
  const focus = latest ? byId.get(latest.linkSuggestionId!)! : null;
  const buckets = linkBuckets(suggestions);
  const judgedPerBucket = new Map<string, number>();
  for (const row of runRows) {
    const s = row.linkSuggestionId ? byId.get(row.linkSuggestionId) : undefined;
    if (!s) continue;
    const k = s.target.pageId || s.target.url;
    judgedPerBucket.set(k, (judgedPerBucket.get(k) ?? 0) + 1);
  }
  const focusKey = focus ? focus.target.pageId || focus.target.url : null;
  const suggested = suggestions.filter((s) => s.status === "suggested").length;
  const review = suggestions.filter((s) => s.status === "review").length;
  // The report (counter, buckets, focus card) is the CURRENT stored link run; only the "judged in this run"
  // marks come from this run's revealed rows.
  const captions = [
    r ? `Report generated ${r.generatedAt ? shortDate(r.generatedAt) : "—"} · current state${replaying ? " · not replayed" : ""}${runRows.length === 0 ? " · not part of this run" : ""}` : null,
    runRows.length > 0 ? `${fmtInt(runRows.length)} link judgment${runRows.length === 1 ? "" : "s"} in this run` : null,
  ].filter((x): x is string => !!x);
  return (
    <Panel
      num="08"
      title="Internal links judged"
      accent="sky"
      reduced={reduced}
      testId="links"
      counter={r ? { value: suggested, suffix: "suggested", sub: `${fmtInt(review)} for review · ${fmtInt(r.orphanPages.length)} orphan pages` } : null}
      subtitle="Where links should point, from a stored sentence on the source page; Jev's should-exist answer is shown as stored."
      captions={captions}
    >
      {!r ? (
        report.error ? <ErrorState error={report.error} title="Could not load internal links" /> : <Shimmer label="Loading the internal link report…" />
      ) : r.suggestions.length === 0 && !r.generatedAt ? (
        <PanelEmpty>
          No internal link run yet. <Link to={projectPath(projectId, "internal-links")}>Open Internal links</Link>.
        </PanelEmpty>
      ) : (
        <div className="space-y-3">
          {focus && latest && (
            <Crossfade k={latest.id} className="rounded-lg border border-sky-200 bg-sky-50/60 p-2.5 text-xs dark:border-sky-900 dark:bg-sky-950/40">
              <p className="flex min-w-0 items-center gap-1 font-mono text-zinc-900 dark:text-zinc-100">
                <span className="truncate" title={focus.source.url}>
                  {urlPath(focus.source.url)}
                </span>
                <span aria-hidden="true">→</span>
                <span className="sr-only"> links to </span>
                <span className="truncate font-semibold" title={focus.target.url}>
                  {urlPath(focus.target.url)}
                </span>
              </p>
              {focus.sentence && (
                <p className="mt-1 line-clamp-2 text-zinc-700 dark:text-zinc-300">
                  {markAnchor(clipText(focus.sentence.text, 300), focus.anchor?.text).map((seg, i) =>
                    seg.mark ? (
                      <mark key={i} className="rounded bg-amber-200 px-0.5 text-zinc-950 dark:bg-amber-400/40 dark:text-zinc-50">
                        {seg.text}
                      </mark>
                    ) : (
                      <span key={i}>{seg.text}</span>
                    ),
                  )}
                </p>
              )}
              <p className="mt-1 flex flex-wrap items-center gap-1.5">
                {focus.role && <ToneChip tone="info">{ROLE_LABEL[focus.role]}</ToneChip>}
                <JevChip text={jevChipText(latest.jev)} tier={latest.jev?.tier ?? null} title={latest.verdictBasis} />
              </p>
            </Crossfade>
          )}
          <ul className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3" aria-label="Link destinations">
            {buckets.map((b) => {
              const judged = judgedPerBucket.get(b.key) ?? 0;
              const isFocus = b.key === focusKey;
              return (
                <li
                  key={b.key}
                  className={cx(
                    "lv-move min-w-0 rounded-lg border p-2 text-[11px]",
                    isFocus ? "border-sky-500 ring-2 ring-sky-500/40 dark:border-sky-400" : "border-zinc-200 dark:border-zinc-800",
                  )}
                >
                  <p className="flex min-w-0 items-center justify-between gap-1">
                    <span className="truncate font-mono font-semibold text-zinc-900 dark:text-zinc-100" title={b.url}>
                      {urlPath(b.url)}
                    </span>
                    {b.orphan && <ToneChip tone="review">Orphan</ToneChip>}
                  </p>
                  <ul className="mt-1 space-y-0.5">
                    {b.sources.slice(0, 3).map((s) => (
                      <li key={s.id} className="truncate rounded bg-zinc-100 px-1 font-mono text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300" title={s.source.url}>
                        {urlPath(s.source.url)}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1 flex items-center justify-between gap-1 text-zinc-500 dark:text-zinc-400">
                    <span>{b.sources.length > 3 ? `+${fmtInt(b.sources.length - 3)} more` : `${fmtInt(b.inlinks)} links in now`}</span>
                    {judged > 0 && (
                      <span key={isFocus && latest ? latest.id : "n"} className={cx("font-medium text-sky-800 dark:text-sky-300", isFocus && "lv-pop")}>
                        +{fmtInt(judged)} judged in this run
                      </span>
                    )}
                  </p>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Panel>
  );
}
