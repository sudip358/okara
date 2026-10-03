/**
 * Internal-link containers of the Live view (docs/live-view-design.md section 18), built on the internal links
 * workbench (GET /seo/internal-links/{graph,broken,clusters,anchors,placed}, unchanged): 16 link graph coverage,
 * 17 broken and redirected internal links, 18 hub and cluster gaps, 19 anchor text flags, 20 placed links
 * verification. Each `…Panel` renders one stored report (tested with fixtures); each `…Container` fetches it
 * (data.ts: on mount, after a seo.crawl terminal event, after a rebuild or link analysis; no polling of its own).
 *
 * Counts are the server's counts of the stored graph, shown as "n of m" with both numbers; the only percentages are
 * the workbench's documented anchor thresholds and its own reason lines. Titles, anchors, URLs, keywords and fix texts
 * are page text: React text only, never HTML. Each container links to its tab of the Internal links page.
 */
import { useContext, type ReactNode } from "react";
import { Link } from "react-router";
import type { AnchorAuditReport, BrokenLinksReport, LinkClusterReport, LinkGraphSummary, PlacedLinksReport } from "@shared/types";
import { cx } from "@web/components/ui";
import { projectPath } from "@web/lib/project-context";
import { KIND_LABEL, chainText } from "@web/pages/links/lib";
import { ACCENT, LTD, LTH, Panel, PanelEmpty, THEAD, ToneChip } from "../parts";
import { PanelActionsContext, SectionButton } from "../RunActions";
import { linkGraphActionKey, type SectionAction } from "../run-actions";
import { DEMO_LABEL, clipText, fmtInt, shortDate, urlPath } from "../text";
import { LoadState, Notes, ShowingNote, captionsFor, type Loadable } from "./common";
import { useLinkRead, useLiveMore } from "./data";
import {
  ANCHOR_FLAGS,
  ANCHOR_FLAG_LABEL,
  KEYWORD_BASIS_SHORT,
  LINK_ROWS,
  ORIGIN_LABEL,
  TRIGGER_LABEL,
  VERIFY_SEGMENTS,
  anchorFacts,
  anchorFlagCounts,
  anchorThresholdCaption,
  anchorThresholds,
  brokenStatusText,
  brokenSummary,
  brokenTone,
  clusterGaps,
  coverageMeters,
  graphCaption,
  graphNotes,
  graphSizeText,
  linksTabPath,
  meterFraction,
  missingText,
  placedSummary,
  shortDateTime,
  type CoverageMeter,
  type LinkContainerKey,
} from "./links-lib";

interface LinkPanelProps<T> {
  state: Loadable<T>;
  reduced: boolean;
  projectId: string;
  replaying: boolean;
  /** The project's site is verified (the setup note links to Settings when it is not). */
  verified: boolean;
}

const TAB_NAME: Record<LinkContainerKey, string> = {
  "link-graph": "Link graph",
  "broken-links": "Broken links",
  "cluster-gaps": "Clusters",
  "anchor-flags": "Anchors",
  "placed-links": "Placed & verified",
};

/** "Open Internal links ›" to the container's tab (in the caption row, so it never scrolls away). */
function OpenLinks({ projectId, k }: { projectId: string; k: LinkContainerKey }) {
  return (
    <Link
      to={projectPath(projectId, linksTabPath(k))}
      data-open-links={k}
      className="ml-auto shrink-0 text-[11px] font-medium text-sky-800 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-sky-600 dark:text-sky-300"
    >
      Open Internal links<span className="sr-only">, {TAB_NAME[k]} tab</span> <span aria-hidden="true">›</span>
    </Link>
  );
}

/** Setup state: the server's plain-text message, and Settings when the site is not verified. */
function LinkSetup({ message, verified, projectId }: { message: string | null | undefined; verified: boolean; projectId: string }) {
  return (
    <div className="space-y-2 py-4 text-center text-xs text-zinc-700 dark:text-zinc-300">
      <p className="text-sm font-medium">Setup required</p>
      {message && <p className="mx-auto max-w-md">{message}</p>}
      {verified ? (
        <p className="text-zinc-600 dark:text-zinc-400">The link graph is built at the end of every crawl of your verified site.</p>
      ) : (
        <Link to={projectPath(projectId, "settings")}>Verify the site in Settings</Link>
      )}
    </div>
  );
}

const NO_GRAPH = "No link graph yet. It is built at the end of every crawl; 16 Link graph coverage can rebuild it from the stored snapshots.";

/** Demo label first; then where the data comes from; "Current state, not replayed" during a replay. */
function linkCaptions(demo: boolean, source: string | null, replaying: boolean): string[] {
  return captionsFor([demo ? DEMO_LABEL : null, source], replaying);
}

// ------------------------------------------------------------------ 16 link graph coverage
function CoverageRow({ m }: { m: CoverageMeter }) {
  const text = m.m === null ? fmtInt(m.n) : `${fmtInt(m.n)} of ${fmtInt(m.m)}`;
  return (
    <li className="min-w-0" data-meter={m.key}>
      <div className="flex min-w-0 items-baseline justify-between gap-2 text-[11px]">
        <span className="truncate text-zinc-800 dark:text-zinc-200" title={m.label}>
          {m.label}
        </span>
        <span className="shrink-0 font-mono text-zinc-800 tabular-nums dark:text-zinc-200">
          {text} <span className="font-sans text-zinc-500 dark:text-zinc-400">{m.of}</span>
        </span>
      </div>
      {m.m !== null && (
        <div
          role="meter"
          aria-label={m.label}
          aria-valuemin={0}
          aria-valuemax={m.m}
          aria-valuenow={Math.min(m.n, m.m)}
          aria-valuetext={`${text} ${m.of}`}
          className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700"
        >
          <div className={cx("lv-bar h-full rounded-full", m.tone === "sky" ? "bg-sky-700 dark:bg-sky-400" : "bg-amber-500 dark:bg-amber-400")} style={{ width: `${Math.round(meterFraction(m.n, m.m) * 100)}%` }} />
        </div>
      )}
      {m.note && (
        <p className="mt-0.5 truncate text-[11px] text-zinc-500 dark:text-zinc-400" title={m.note}>
          {m.note}
        </p>
      )}
    </li>
  );
}

export function LinkGraphPanel({ state, reduced, projectId, replaying, verified, action }: LinkPanelProps<LinkGraphSummary> & { action: SectionAction | null }) {
  const g = state.data;
  const c = g?.coverage ?? null;
  const ready = !!g && g.state !== "setup_required" && !!g.graphId && !!c;
  const counter = ready && c ? (c.sitemapUrls > 0 ? { value: c.sitemapAnalysed, suffix: "analysed", sub: `of ${fmtInt(c.sitemapUrls)} sitemap URLs` } : { value: c.pagesWithSnapshot, suffix: "pages analysed", sub: "no sitemap inventory yet" }) : null;
  const size = g ? graphSizeText(g) : null;
  return (
    <Panel
      num="16"
      title="Link graph coverage"
      accent="sky"
      reduced={reduced}
      testId="link-graph"
      counter={counter}
      subtitle="How much of your site the stored internal link graph covers: the latest snapshot of every crawled page, rebuilt after each crawl. Counted, not estimated."
      captions={linkCaptions(g?.state === "demo", g ? graphCaption(g.builtAt, g.trigger) : null, replaying)}
      toolbar={<OpenLinks projectId={projectId} k="link-graph" />}
      action={action ? <SectionButton action={action} /> : null}
    >
      {!g ? (
        <LoadState state={state} what="the link graph" />
      ) : g.state === "setup_required" ? (
        <LinkSetup message={g.labels[0]} verified={verified} projectId={projectId} />
      ) : !g.graphId || !c ? (
        <PanelEmpty>{NO_GRAPH}</PanelEmpty>
      ) : (
        <div className="min-w-0 space-y-2.5">
          {g.newerCrawl && (
            <p className="rounded-md border border-amber-200 bg-amber-50/70 px-2 py-1 text-[11px] text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              A crawl finished after this graph was built (started {shortDate(g.newerCrawl)}); rebuild the graph to include it.
            </p>
          )}
          <ul className="grid min-w-0 grid-cols-1 gap-x-5 gap-y-2 @xl:grid-cols-2 @5xl:grid-cols-3" aria-label="Link graph coverage counts">
            {coverageMeters(g).map((m) => (
              <CoverageRow key={m.key} m={m} />
            ))}
          </ul>
          <p className="text-[11px] text-zinc-700 dark:text-zinc-300">
            Built {shortDateTime(g.builtAt)}
            {g.trigger ? ` ${TRIGGER_LABEL[g.trigger]}` : ""}
            {size ? ` · ${size}` : ""}
          </p>
          <Notes labels={graphNotes(g)} />
        </div>
      )}
    </Panel>
  );
}

export function LinkGraphContainer({ projectId, reduced, verified }: { projectId: string; reduced: boolean; verified: boolean }) {
  const v = useLiveMore();
  const state = useLinkRead(projectId, "graph");
  // The right button depends on the stored state: rebuild a graph from stored snapshots, or crawl when none exists.
  const actions = useContext(PanelActionsContext);
  const key = linkGraphActionKey(state.data);
  return <LinkGraphPanel state={state} reduced={reduced} projectId={projectId} replaying={v.replaying} verified={verified} action={key ? (actions?.[key] ?? null) : null} />;
}

// ------------------------------------------------------------------ 17 broken and redirected internal links
function StatusGroup({ tone, label, links, urls, children }: { tone: "change" | "review"; label: string; links: number; urls: number; children?: ReactNode }) {
  return (
    <li className="min-w-0">
      <ToneChip tone={tone}>
        {label}: {fmtInt(links)} link{links === 1 ? "" : "s"} · {fmtInt(urls)} URL{urls === 1 ? "" : "s"}
      </ToneChip>
      {children}
    </li>
  );
}

export function BrokenLinksPanel({ state, reduced, projectId, replaying, verified }: LinkPanelProps<BrokenLinksReport>) {
  const r = state.data;
  const s = r ? brokenSummary(r) : null;
  const rows = r ? r.rows.slice(0, LINK_ROWS.broken) : [];
  const ready = !!r && r.state !== "setup_required" && !!r.graphId && !!s;
  return (
    <Panel
      num="17"
      title="Broken and redirected internal links"
      accent="rose"
      reduced={reduced}
      testId="broken-links"
      counter={ready && s ? { value: s.listed, suffix: "links", sub: `${fmtInt(s.clientErrors + s.serverErrors)} to 4xx/5xx · ${fmtInt(s.redirects)} redirected` } : null}
      subtitle="Internal links whose target returned 4xx/5xx or redirected when last crawled, with every hop and the fix. Fetch errors and timeouts are never called broken."
      captions={linkCaptions(r?.state === "demo", r ? graphCaption(r.builtAt, null) : null, replaying)}
      toolbar={<OpenLinks projectId={projectId} k="broken-links" />}
    >
      {!r ? (
        <LoadState state={state} what="broken and redirected links" />
      ) : r.state === "setup_required" ? (
        <LinkSetup message={r.labels[0]} verified={verified} projectId={projectId} />
      ) : !r.graphId || !s ? (
        <PanelEmpty>{NO_GRAPH}</PanelEmpty>
      ) : r.rows.length === 0 ? (
        <>
          <PanelEmpty>No broken or redirected internal links in the analysed pages{r.unchecked > 0 ? ` (${fmtInt(r.unchecked)} linked URLs not crawled yet)` : ""}.</PanelEmpty>
          <Notes labels={r.labels} />
        </>
      ) : (
        <div className="min-w-0 space-y-2">
          <ul className="flex min-w-0 flex-wrap gap-1.5" aria-label="Links by target status">
            <StatusGroup tone="change" label="4xx" links={s.clientErrors} urls={s.targets.client} />
            <StatusGroup tone="change" label="5xx" links={s.serverErrors} urls={s.targets.server} />
            <StatusGroup tone="review" label="3xx" links={s.redirects} urls={s.targets.redirect} />
          </ul>
          {s.redirects > 0 && (
            <p className="text-[11px] text-zinc-600 dark:text-zinc-400">
              Redirected links: {fmtInt(s.chains)} through a chain (2+ hops) · {fmtInt(s.redirectsToErrors)} ending in 4xx/5xx · {fmtInt(s.offSite)} leaving the site
              {r.unchecked > 0 ? ` · ${fmtInt(r.unchecked)} linked URLs not crawled yet` : ""}.
            </p>
          )}
          <table className="w-full table-fixed border-collapse text-xs">
            <caption className="sr-only">Internal links to targets that failed or redirected, with the fix (errors first, most-linked targets first)</caption>
            <thead className={THEAD}>
              <tr>
                <LTH className="w-[64%] @lg:w-[32%]">Source · anchor</LTH>
                <LTH className="hidden @lg:table-cell @lg:w-[26%]">Target</LTH>
                <LTH className="w-[36%] @lg:w-[16%]" title="The target's status in its latest snapshot; redirects show the final URL's status">
                  Status
                </LTH>
                <LTH className="hidden @lg:table-cell @lg:w-[26%]">Fix</LTH>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {rows.map((x, i) => (
                <tr key={`${x.sourceUrl}|${x.targetUrl}|${i}`} className={ACCENT.rose.row}>
                  <LTD title={`${x.sourceUrl} → ${x.targetUrl}`}>
                    <span className="block truncate font-mono text-zinc-900 dark:text-zinc-100">{urlPath(x.sourceUrl)}</span>
                    <span className="block truncate text-[11px] text-zinc-600 dark:text-zinc-400">
                      {x.anchor ? `“${clipText(x.anchor, 120)}”` : "no anchor recorded"}
                      {x.kind !== "content" ? ` · ${KIND_LABEL[x.kind]}` : ""}
                    </span>
                    <span className="block truncate font-mono text-[11px] text-zinc-500 @lg:hidden dark:text-zinc-400">→ {urlPath(x.targetUrl)}</span>
                    <span className="line-clamp-2 text-[11px] whitespace-normal text-zinc-700 @lg:hidden dark:text-zinc-300">{x.fix}</span>
                  </LTD>
                  <LTD className="hidden @lg:table-cell" title={x.finalUrl ? `${x.targetUrl} → ${x.finalUrl}` : x.targetUrl}>
                    <span className="block truncate font-mono text-zinc-900 dark:text-zinc-100">{urlPath(x.targetUrl)}</span>
                    {x.issue === "redirect" && <span className="block truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400">{x.finalUrl ? `→ ${urlPath(x.finalUrl)}` : "→ off this site"}</span>}
                  </LTD>
                  <LTD className="overflow-visible align-top">
                    <ToneChip tone={brokenTone(x)} title={x.chain.length > 0 ? `Chain: ${chainText(x.chain)}` : undefined}>
                      {brokenStatusText(x)}
                    </ToneChip>
                    {x.stale && <span className="mt-0.5 block text-[11px] text-amber-800 dark:text-amber-300">stale snapshot</span>}
                  </LTD>
                  <LTD className="hidden align-top whitespace-normal @lg:table-cell">
                    <span className="line-clamp-2 text-[11px] text-zinc-800 dark:text-zinc-200" title={x.fix}>
                      {x.fix}
                    </span>
                  </LTD>
                </tr>
              ))}
            </tbody>
          </table>
          <ShowingNote shown={rows.length} total={s.listed} what="links (errors first, then redirects; most-linked targets first)" />
          {r.truncated && <p className="text-[11px] text-zinc-500 dark:text-zinc-400">The list is cut for targets linked from many pages; the counts cover the listed links.</p>}
          <Notes labels={r.labels} />
        </div>
      )}
    </Panel>
  );
}

export function BrokenLinksContainer({ projectId, reduced, verified }: { projectId: string; reduced: boolean; verified: boolean }) {
  const v = useLiveMore();
  return <BrokenLinksPanel state={useLinkRead(projectId, "broken")} reduced={reduced} projectId={projectId} replaying={v.replaying} verified={verified} />;
}

// ------------------------------------------------------------------ 18 hub and cluster gaps
function SpokeBar({ linked, partial, unlinked, label }: { linked: number; partial: number; unlinked: number; label: string }) {
  const total = linked + partial + unlinked;
  const w = (n: number) => `${total > 0 ? Math.round((n / total) * 100) : 0}%`;
  return (
    <span role="img" aria-label={label} title={label} className="flex h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
      <span className="h-full bg-emerald-600 dark:bg-emerald-400" style={{ width: w(linked) }} />
      <span className="h-full bg-amber-500 dark:bg-amber-400" style={{ width: w(partial) }} />
      <span className="h-full bg-rose-600 dark:bg-rose-400" style={{ width: w(unlinked) }} />
    </span>
  );
}

export function ClusterGapsPanel({ state, reduced, projectId, replaying, verified }: LinkPanelProps<LinkClusterReport>) {
  const r = state.data;
  const gaps = r ? clusterGaps(r) : null;
  const ready = !!r && r.state !== "setup_required" && !!r.graphId;
  return (
    <Panel
      num="18"
      title="Hub and cluster gaps"
      accent="emerald"
      reduced={reduced}
      testId="cluster-gaps"
      counter={ready && r ? { value: r.counts.partial + r.counts.unlinked, suffix: "spokes missing a link", sub: `of ${fmtInt(r.counts.spokes)} spokes in ${fmtInt(r.counts.hubs)} hubs` } : null}
      subtitle="Hubs (collections, sheet hubs, pages you marked) and their spokes: whether the hub links to each spoke and the spoke links back. Most missing links first."
      captions={linkCaptions(r?.state === "demo", r ? graphCaption(r.builtAt, null) : null, replaying)}
      toolbar={<OpenLinks projectId={projectId} k="cluster-gaps" />}
    >
      {!r || !gaps ? (
        <LoadState state={state} what="clusters" />
      ) : r.state === "setup_required" ? (
        <LinkSetup message={r.labels[0]} verified={verified} projectId={projectId} />
      ) : !r.graphId ? (
        <PanelEmpty>{NO_GRAPH}</PanelEmpty>
      ) : r.hubs.length === 0 ? (
        <>
          <PanelEmpty>No hubs found yet. Collection pages become hubs once crawled; you can mark any page as a hub on the Internal links page.</PanelEmpty>
          <Notes labels={r.labels} />
        </>
      ) : (
        <div className="min-w-0 space-y-2">
          <p className="flex min-w-0 flex-wrap gap-1.5" aria-label="Spokes by link status">
            <ToneChip tone="keep">Linked both ways {fmtInt(r.counts.linked)}</ToneChip>
            <ToneChip tone="review">Partly linked {fmtInt(r.counts.partial)}</ToneChip>
            <ToneChip tone="change">Unlinked {fmtInt(r.counts.unlinked)}</ToneChip>
            <ToneChip tone="none">No hub {fmtInt(r.counts.unassigned)}</ToneChip>
          </p>
          <p className="text-[11px] text-zinc-600 dark:text-zinc-400">
            Missing links: {fmtInt(gaps.missingHubToSpoke)} hub → spoke · {fmtInt(gaps.missingSpokeToHub)} spoke → hub.
          </p>
          <ol className="space-y-1.5" aria-label="Hubs, most missing links first">
            {gaps.hubs.map((h) => {
              const label = `${h.hub.spokes.length} spokes: ${h.hub.linked} linked both ways, ${h.hub.partial} partly linked, ${h.hub.unlinked} unlinked`;
              return (
                <li key={h.hub.key} className={cx("min-w-0 rounded-md border border-zinc-200 px-2 py-1.5 dark:border-zinc-800", ACCENT.emerald.row)}>
                  <div className="flex min-w-0 items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate text-xs font-semibold text-zinc-900 dark:text-zinc-100" title={`${h.hub.title ?? ""} ${h.hub.url}`.trim()}>
                      {h.hub.title ?? urlPath(h.hub.url)}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-zinc-700 tabular-nums dark:text-zinc-300">
                      {fmtInt(h.gaps)} missing link{h.gaps === 1 ? "" : "s"}
                    </span>
                  </div>
                  <p className="flex min-w-0 items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                    <span className="truncate font-mono" title={h.hub.url}>
                      {urlPath(h.hub.url)}
                    </span>
                    <span className="shrink-0">· {h.hub.sourceLabel}</span>
                  </p>
                  <div className="mt-1 flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1">
                      <SpokeBar linked={h.hub.linked} partial={h.hub.partial} unlinked={h.hub.unlinked} label={label} />
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-zinc-700 tabular-nums dark:text-zinc-300">
                      {fmtInt(h.hub.linked)} · {fmtInt(h.hub.partial)} · {fmtInt(h.hub.unlinked)} of {fmtInt(h.hub.spokes.length)}
                    </span>
                  </div>
                  {h.examples.length > 0 && (
                    <ul className="mt-1 space-y-0.5" aria-label={`Spokes of ${h.hub.title ?? urlPath(h.hub.url)} missing a link`}>
                      {h.examples.map((e) => (
                        <li key={e.spoke.key} className="flex min-w-0 items-baseline justify-between gap-2 text-[11px]">
                          <span className="min-w-0 truncate font-mono text-zinc-800 dark:text-zinc-200" title={`${e.spoke.title ?? ""} ${e.spoke.url}`.trim()}>
                            {urlPath(e.spoke.url)}
                          </span>
                          <span className="shrink-0 text-amber-800 dark:text-amber-300">{missingText(e)}</span>
                        </li>
                      ))}
                      {h.hub.partial + h.hub.unlinked > h.examples.length && (
                        <li className="text-[11px] text-zinc-500 dark:text-zinc-400">… and {fmtInt(h.hub.partial + h.hub.unlinked - h.examples.length)} more on the Internal links page.</li>
                      )}
                    </ul>
                  )}
                </li>
              );
            })}
          </ol>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">Bars: linked both ways · partly linked · unlinked spokes of each hub.</p>
          <ShowingNote shown={gaps.hubs.length} total={gaps.totalHubs} what="hubs (most missing links first)" />
          <Notes labels={r.labels} />
        </div>
      )}
    </Panel>
  );
}

export function ClusterGapsContainer({ projectId, reduced, verified }: { projectId: string; reduced: boolean; verified: boolean }) {
  const v = useLiveMore();
  return <ClusterGapsPanel state={useLinkRead(projectId, "clusters")} reduced={reduced} projectId={projectId} replaying={v.replaying} verified={verified} />;
}

// ------------------------------------------------------------------ 19 anchor text flags
export function AnchorFlagsPanel({ state, reduced, projectId, replaying, verified }: LinkPanelProps<AnchorAuditReport>) {
  const r = state.data;
  const ready = !!r && r.state !== "setup_required" && !!r.graphId;
  const counts = r ? anchorFlagCounts(r) : null;
  const thresholds = r ? anchorThresholds(r.thresholds) : null;
  const rows = r ? r.rows.slice(0, LINK_ROWS.anchors) : [];
  // The thresholds are shown above (chips and caption); the remaining notes say what is counted.
  const notes = r ? r.labels.filter((l) => !l.startsWith("Flags (")) : [];
  return (
    <Panel
      num="19"
      title="Anchor text flags"
      accent="amber"
      reduced={reduced}
      testId="anchor-flags"
      counter={ready && r ? { value: r.total, suffix: "pages flagged", sub: "content links only" } : null}
      subtitle="Pages whose incoming content-link anchors cross a documented threshold: exact-match heavy, one repeated anchor, generic or empty anchors, or none with the page's search terms."
      captions={linkCaptions(r?.state === "demo", r ? graphCaption(r.builtAt, null) : null, replaying)}
      toolbar={<OpenLinks projectId={projectId} k="anchor-flags" />}
    >
      {!r || !counts || !thresholds ? (
        <LoadState state={state} what="anchor flags" />
      ) : r.state === "setup_required" ? (
        <LinkSetup message={r.labels[0]} verified={verified} projectId={projectId} />
      ) : !r.graphId ? (
        <PanelEmpty>{NO_GRAPH}</PanelEmpty>
      ) : (
        <div className="min-w-0 space-y-2">
          <p className="flex min-w-0 flex-wrap gap-1.5" aria-label="Flagged pages per flag">
            {ANCHOR_FLAGS.map((f) => (
              <ToneChip key={f} tone={counts[f] > 0 ? "review" : "none"} title={`${ANCHOR_FLAG_LABEL[f]}: ${thresholds[f]}`}>
                {ANCHOR_FLAG_LABEL[f]} {fmtInt(counts[f])}
              </ToneChip>
            ))}
          </p>
          <p className="text-[11px] text-zinc-600 dark:text-zinc-400" data-thresholds="">
            {anchorThresholdCaption(r.thresholds)}
          </p>
          {rows.length === 0 ? (
            <PanelEmpty>No anchor flags: every audited page is within the thresholds.</PanelEmpty>
          ) : (
            <ol className="space-y-1.5" aria-label="Flagged pages">
              {rows.map((a) => {
                // The most used anchor, unless a reason line already quotes it (exact-match and repetition reasons do).
                const first = a.top[0] ?? null;
                const top = first && !a.reasons.some((x) => x.toLowerCase().includes(`"${first.text.toLowerCase()}"`)) ? first : null;
                return (
                  <li key={a.url} className={cx("min-w-0 rounded-md border border-zinc-200 px-2 py-1.5 dark:border-zinc-800", ACCENT.amber.row)}>
                    <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
                      <span className="min-w-0 flex-1 basis-40 truncate font-mono text-xs text-zinc-900 dark:text-zinc-100" title={`${a.title ?? ""} ${a.url}`.trim()}>
                        {urlPath(a.url)}
                      </span>
                      <span className="flex min-w-0 flex-wrap gap-1">
                        {a.flags.map((f) => (
                          <ToneChip key={f} tone="review" title={thresholds[f]}>
                            {ANCHOR_FLAG_LABEL[f]}
                          </ToneChip>
                        ))}
                      </span>
                    </div>
                    <p className="truncate text-[11px] text-zinc-700 dark:text-zinc-300">
                      {anchorFacts(a)}
                      {a.keyword ? ` · keyword “${clipText(a.keyword, 80)}” (${a.keywordBasis ? KEYWORD_BASIS_SHORT[a.keywordBasis] : "basis unknown"})` : ""}
                    </p>
                    {top && (
                      <p className="truncate text-[11px] text-zinc-600 dark:text-zinc-400" title={top.text}>
                        Most used: “{clipText(top.text, 80)}” from {fmtInt(top.sources)} page{top.sources === 1 ? "" : "s"}
                      </p>
                    )}
                    {a.reasons.map((x, i) => (
                      <p key={i} className="line-clamp-2 text-[11px] text-zinc-600 dark:text-zinc-400">
                        {x}
                      </p>
                    ))}
                  </li>
                );
              })}
            </ol>
          )}
          <ShowingNote shown={rows.length} total={r.total} what="flagged pages (most flags first)" />
          <Notes labels={notes} />
        </div>
      )}
    </Panel>
  );
}

export function AnchorFlagsContainer({ projectId, reduced, verified }: { projectId: string; reduced: boolean; verified: boolean }) {
  const v = useLiveMore();
  return <AnchorFlagsPanel state={useLinkRead(projectId, "anchors")} reduced={reduced} projectId={projectId} replaying={v.replaying} verified={verified} />;
}

// ------------------------------------------------------------------ 20 placed links verification
export function PlacedLinksPanel({ state, reduced, projectId, replaying, verified }: LinkPanelProps<PlacedLinksReport>) {
  const r = state.data;
  const s = r ? placedSummary(r) : null;
  const demo = r?.state === "demo";
  const source = s ? (s.latestCheck ? `From your placed links, checked at every link graph build (latest check: crawl of ${shortDate(s.latestCheck)})` : "From your placed links, checked at every link graph build") : null;
  const segs = s ? VERIFY_SEGMENTS.map((seg) => ({ ...seg, n: s[seg.key] })) : [];
  const barLabel = s ? `${segs.map((x) => `${x.label} ${x.n}`).join(", ")} of ${s.total} placed links` : "";
  return (
    <Panel
      num="20"
      title="Placed links verification"
      accent="zinc"
      reduced={reduced}
      testId="placed-links"
      counter={s && s.total > 0 && r?.state !== "setup_required" ? { value: s.verified, suffix: "verified", sub: `of ${fmtInt(s.total)} placed links · ${fmtInt(s.notFound)} not found` } : null}
      subtitle="Links you accepted or marked implemented, and links your sheet lists as placed, checked against the next crawl of each source page."
      captions={linkCaptions(demo, source, replaying)}
      toolbar={<OpenLinks projectId={projectId} k="placed-links" />}
    >
      {!r || !s ? (
        <LoadState state={state} what="placed links" />
      ) : r.state === "setup_required" ? (
        <LinkSetup message="Verify your site first; placed links are checked against crawls of your verified site." verified={verified} projectId={projectId} />
      ) : s.total === 0 ? (
        <>
          <PanelEmpty>
            No placed links yet. Accept or mark suggestions implemented on the <Link to={projectPath(projectId, "internal-links")}>Internal links page</Link>, or import your
            sheet of placed links on the <Link to={projectPath(projectId, "import")}>Import page</Link>.
          </PanelEmpty>
          <Notes labels={r.labels} />
        </>
      ) : (
        <div className="min-w-0 space-y-2">
          <span role="img" aria-label={barLabel} title={barLabel} className="flex h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
            {segs.map((x) => (
              <span key={x.key} className={cx("h-full", x.cls)} style={{ width: `${s.total > 0 ? Math.round((x.n / s.total) * 100) : 0}%` }} />
            ))}
          </span>
          <ul className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-700 dark:text-zinc-300" aria-label="Placed links by check result">
            {segs.map((x) => (
              <li key={x.key} className="inline-flex items-center gap-1">
                <span aria-hidden="true" className={cx("inline-block h-2 w-2 rounded-sm", x.cls)} />
                {x.label} <span className="font-mono tabular-nums">{fmtInt(x.n)} of {fmtInt(s.total)}</span>
              </li>
            ))}
          </ul>
          <h3 className="pt-1 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">Latest not found</h3>
          {s.notFoundRows.length === 0 ? (
            <p className="text-xs text-zinc-600 dark:text-zinc-400">None: no placed link was missing when its source page was last crawled.</p>
          ) : (
            <ol className="space-y-1" aria-label="Placed links not found in the latest crawl of their source page">
              {s.notFoundRows.map((x) => (
                <li key={x.key} className="min-w-0 rounded-md border border-l-4 border-zinc-200 border-l-rose-600 px-2 py-1 dark:border-zinc-800 dark:border-l-rose-400">
                  <p className="flex min-w-0 items-center gap-1 font-mono text-xs text-zinc-900 dark:text-zinc-100">
                    <span className="truncate" title={x.sourceUrl}>
                      {urlPath(x.sourceUrl)}
                    </span>
                    <span aria-hidden="true">→</span>
                    <span className="sr-only"> should link to </span>
                    <span className="truncate font-semibold" title={x.targetUrl}>
                      {urlPath(x.targetUrl)}
                    </span>
                  </p>
                  <p className="truncate text-[11px] text-zinc-600 dark:text-zinc-400">
                    {x.anchor ? `“${clipText(x.anchor, 80)}” · ` : ""}
                    {x.origins.map((o) => ORIGIN_LABEL[o]).join(" + ")}
                    {x.placedOn ? ` since ${shortDate(x.placedOn)}` : ""}
                  </p>
                  <p className="text-[11px] font-medium text-rose-700 dark:text-rose-300" title={x.verification.detail ?? undefined}>
                    {x.verification.label}
                  </p>
                </li>
              ))}
            </ol>
          )}
          <ShowingNote shown={s.notFoundRows.length} total={s.notFound} what="links not found (latest check first)" />
          {s.pending > 0 && (
            <p className="text-[11px] text-zinc-600 dark:text-zinc-400">
              {fmtInt(s.pending)} link{s.pending === 1 ? " waits" : "s wait"} for the next crawl of {s.pending === 1 ? "its" : "their"} source page.
            </p>
          )}
          <Notes labels={r.labels} />
        </div>
      )}
    </Panel>
  );
}

export function PlacedLinksContainer({ projectId, reduced, verified }: { projectId: string; reduced: boolean; verified: boolean }) {
  const v = useLiveMore();
  return <PlacedLinksPanel state={useLinkRead(projectId, "placed")} reduced={reduced} projectId={projectId} replaying={v.replaying} verified={verified} />;
}
