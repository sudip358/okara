/**
 * Redirect map [A23] service: builds a RedirectMapResult for one project. The route
 * (routes/redirects.ts) handles auth, tenancy, rate limits, and body validation; this module handles
 * data loading and the matching pipeline:
 *   host -> new URLs (provided, or the latest crawl's 2xx pages) -> old URL parsing -> exact path /
 *   normalized slug -> shortlist -> Jev Choice (when configured and allowed) -> rows, counts, CSV.
 * Nothing is fetched from the site: matching works on the submitted lists and stored crawl data.
 * Okara never changes redirects; the CSV is a suggestion for the user to review and import.
 */
import type { CapabilityState, RedirectMapResult, RedirectMapRow } from "@shared/types";
import { DEMO_LABEL } from "../demo/fixtures";
import type { Db } from "../lib/db";
import { parseJson } from "../lib/db";
import { badRequest } from "../lib/errors";
import type { Clock } from "../lib/time";
import type { ProjectRow } from "../platform/access";
import { siteHost } from "../platform/projects";
import type { DecisionProvider } from "../providers/types";
import { POLICY_VERSION } from "../runs/policy";
import { decideRedirects, REDIRECT_BATCH_SIZE, type RedirectJevItem } from "./jev";
import {
  buildShopifyCsv,
  comparablePath,
  indexNewPages,
  makeNewPage,
  matchOld,
  MATCH_VERSION,
  parseSiteUrl,
  pathOf,
  SHORTLIST_SIZE,
  type NewPage,
  type ParsedSiteUrl,
  type ShortlistEntry,
} from "./match";

export const MAX_OLD_URLS = 500;
export const MAX_NEW_URLS = 5000;
export const MAX_URL_LENGTH = 2048;

export const LABEL_REVIEW_ONLY = "Suggestions for review. Okara never changes your redirects.";
export const LABEL_UNCERTAIN = "Uncertain matches are flagged, not redirected.";
export const LABEL_CSV_SCOPE =
  "The Shopify CSV (Redirect from, Redirect to; paths only) contains automatic matches only. Decide every review row yourself before importing it; this page adds the rows you resolve to the download.";

export interface RedirectMapInput {
  oldUrls: string[];
  newUrls?: string[] | undefined;
  useJev?: boolean | undefined;
}

export interface RedirectMapDeps {
  db: Db;
  project: ProjectRow;
  /** null = TypeSafe not configured for this workspace. Ignored for demo projects. */
  decisions: DecisionProvider | null;
  now: Date;
  clock?: Clock;
}

interface CrawlPage {
  url: string;
  title: string | null;
  h1: string[];
}

interface LatestCrawl {
  startedAt: string;
  pages: CrawlPage[];
}

/** Latest completed/partial crawl's 2xx pages (final URL after redirects; titles/H1 when extracted). */
export async function loadLatestCrawlPages(db: Db, workspaceId: string, projectId: string): Promise<LatestCrawl | null> {
  const run = await db.first<{ id: string; started_at: string }>(
    `SELECT id, started_at FROM crawl_runs
      WHERE workspace_id = ? AND project_id = ? AND status IN ('completed', 'partial')
      ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    workspaceId,
    projectId,
  );
  if (!run) return null;
  const rows = await db.all<{ url: string; final_url: string | null; title: string | null; h1_json: string; skipped_reason: string | null }>(
    `SELECT p.url, s.final_url, s.title, s.h1_json, s.skipped_reason
       FROM page_snapshots s JOIN pages p ON p.id = s.page_id AND p.workspace_id = s.workspace_id
      WHERE s.workspace_id = ? AND s.project_id = ? AND s.crawl_run_id = ?
        AND s.status_code BETWEEN 200 AND 299
        AND (s.skipped_reason IS NULL OR s.skipped_reason = 'js_rendered')
      ORDER BY s.fetched_at, s.rowid`,
    workspaceId,
    projectId,
    run.id,
  );
  return {
    startedAt: run.started_at,
    pages: rows.map((r) => ({ url: r.final_url || r.url, title: r.title, h1: parseJson<unknown[]>(r.h1_json, []).filter((x): x is string => typeof x === "string") })),
  };
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function emptyResult(state: CapabilityState, now: Date, labels: string[]): RedirectMapResult {
  return {
    state,
    generatedAt: now.toISOString(),
    rows: [],
    counts: { auto: 0, review: 0, noMatch: 0 },
    shopifyCsv: buildShopifyCsv([]),
    labels: [LABEL_REVIEW_ONLY, LABEL_UNCERTAIN, ...labels],
  };
}

const candidatesOf = (entries: ShortlistEntry[]): RedirectMapRow["candidates"] => entries.map((e) => ({ url: e.page.url.absolute, score: e.score }));

export async function buildRedirectMap(input: RedirectMapInput, deps: RedirectMapDeps): Promise<RedirectMapResult> {
  const { db, project, now } = deps;
  const clock = deps.clock ?? (() => now);
  const isDemo = project.is_demo === 1;
  const host = isDemo ? siteHost(project.site_url) : project.verified_host;
  const labels: string[] = [];
  if (isDemo) labels.push(`${DEMO_LABEL}: unless you paste new URLs, candidates come from the fictional demo crawl.`);

  if (!host) {
    return emptyResult("setup_required", now, [
      "Verify site ownership (Search Console, DNS, or file) first. New URLs must be on the verified host, and old URLs must be paths on it.",
    ]);
  }

  // ------------------------------------------------------------ new URLs
  const crawl = await loadLatestCrawlPages(db, project.workspace_id, project.id);
  const crawlByMatchPath = new Map<string, CrawlPage>();
  const crawlPages: NewPage[] = [];
  for (const cp of crawl?.pages ?? []) {
    const parsed = parseSiteUrl(cp.url, host, "new");
    if (!parsed.ok || crawlByMatchPath.has(parsed.url.matchPath)) continue;
    crawlByMatchPath.set(parsed.url.matchPath, cp);
    crawlPages.push(makeNewPage(parsed.url, cp.title, cp.h1));
  }

  const provided = (input.newUrls ?? []).map((u) => u.trim()).filter((u) => u.length > 0);
  let newPages: NewPage[];
  if (provided.length > 0) {
    const rejected: string[] = [];
    newPages = [];
    for (const raw of provided) {
      const parsed = parseSiteUrl(raw, host, "new");
      if (!parsed.ok) {
        rejected.push(raw);
        continue;
      }
      const crawled = crawlByMatchPath.get(parsed.url.matchPath);
      newPages.push(makeNewPage(parsed.url, crawled?.title ?? null, crawled?.h1 ?? []));
    }
    if (newPages.length === 0) {
      throw badRequest(`None of the new URLs are on the verified host ${host}. New URLs must be absolute URLs or paths on ${host}.`, {
        rejected: rejected.slice(0, 5).map((r) => truncate(r, 200)),
      });
    }
    const withTitles = newPages.filter((p) => p.titleTokens.length > 0).length;
    labels.push(
      `New URLs: ${newPages.length} provided${rejected.length ? `; ${rejected.length} ignored because they are not http(s) URLs or paths on ${host} (for example ${truncate(rejected[0]!, 120)})` : ""}. Crawled titles/H1s were available for ${withTitles}.`,
    );
  } else {
    if (crawlPages.length === 0) {
      return emptyResult(isDemo ? "demo" : "setup_required", now, [
        ...labels,
        crawl
          ? `The latest crawl has no 2xx pages on ${host}. Paste the new URLs, or run the SEO agent crawl again.`
          : `No crawl yet. Paste the new URLs, or run the SEO agent to crawl ${host} first.`,
      ]);
    }
    newPages = crawlPages;
    labels.push(`New URLs: ${crawlPages.length} pages with a 2xx status from the latest crawl of ${host} (started ${crawl!.startedAt}). Pages outside the crawl cap are not candidates; paste the full list of new URLs for complete coverage.`);
  }
  const index = indexNewPages(newPages);

  // ------------------------------------------------------------ old URLs + deterministic matching
  type Pending = { row: RedirectMapRow; old: ParsedSiteUrl | null; unresolved: ShortlistEntry[] | null; ambiguousSlug: number };
  const pending: Pending[] = [];
  const firstByPath = new Map<string, number>();
  let rejectedOld = 0;
  for (const raw of input.oldUrls) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const parsed = parseSiteUrl(trimmed, host, "old");
    if (!parsed.ok) {
      rejectedOld++;
      pending.push({
        row: { from: truncate(trimmed, 300), to: null, method: "none", confidence: null, tier: null, status: "no_match", candidates: [], note: `Not processed: ${parsed.reason}` },
        old: null,
        unresolved: null,
        ambiguousSlug: 0,
      });
      continue;
    }
    const old = parsed.url;
    const dupKey = comparablePath(old.path);
    const first = firstByPath.get(dupKey);
    if (first !== undefined) {
      pending.push({
        row: { from: old.path, to: null, method: "none", confidence: null, tier: null, status: "no_match", candidates: [], note: `Duplicate of entry ${first + 1} (same path; query strings and fragments are ignored). Only the first occurrence is mapped.` },
        old: null,
        unresolved: null,
        ambiguousSlug: 0,
      });
      continue;
    }
    firstByPath.set(dupKey, pending.length);
    const queryNote = old.droppedQuery ? " The query string or fragment was ignored; the redirect is for the path only." : "";
    const m = matchOld(old, index);
    if (m.kind === "exact_path" || m.kind === "normalized_slug") {
      const samePath = comparablePath(old.path) === comparablePath(m.page.url.path);
      const base = m.kind === "exact_path" ? "Exact path match (after normalization)." : "Normalized slug match: the last path segment has the same words.";
      pending.push({
        row: {
          from: old.path,
          to: m.page.url.absolute,
          method: m.kind,
          confidence: null,
          tier: null,
          status: "auto",
          candidates: [],
          note: `${base}${samePath ? " The same path already exists on the new site, so no redirect row is exported (a redirect to itself would loop)." : ""}${queryNote}`,
        },
        old,
        unresolved: null,
        ambiguousSlug: 0,
      });
      continue;
    }
    pending.push({
      row: { from: old.path, to: null, method: "none", confidence: null, tier: null, status: "review", candidates: candidatesOf(m.candidates), note: queryNote.trim() || null },
      old,
      unresolved: m.candidates,
      ambiguousSlug: m.ambiguousSlug,
    });
  }
  if (pending.length === 0) throw badRequest("Add at least one old URL.");
  if (rejectedOld > 0) labels.push(`${rejectedOld} old ${rejectedOld === 1 ? "entry was" : "entries were"} not processed because ${rejectedOld === 1 ? "it is" : "they are"} not a path or http(s) URL on ${host} (see the row notes).`);

  // ------------------------------------------------------------ Jev for the unresolved rows
  const unresolved = pending.filter((p) => p.unresolved !== null);
  const jevWanted = input.useJev !== false;
  const decisions = isDemo ? null : deps.decisions;
  const ambiguityNote = (p: Pending) => (p.ambiguousSlug > 1 ? ` ${p.ambiguousSlug} new URLs share this slug, so it was not matched automatically.` : "");

  if (unresolved.length > 0 && decisions && jevWanted) {
    const items: RedirectJevItem[] = unresolved.map((p) => ({
      from: p.row.from,
      oldUrl: p.old!.absolute,
      slugTokens: p.old!.slugTokens,
      candidates: p.unresolved!.map((e) => ({ url: e.page.url.absolute, title: e.page.title ?? e.page.h1[0] ?? null, score: e.score })),
    }));
    const run = await decideRedirects(items, { decisions, db, workspaceId: project.workspace_id, projectId: project.id, clock });
    run.outcomes.forEach((o, i) => {
      const p = unresolved[i]!;
      const extra = [p.row.note, ambiguityNote(p).trim()].filter(Boolean).join(" ");
      p.row = {
        ...p.row,
        to: o.to,
        method: o.answered ? "jev" : "none",
        confidence: o.confidence,
        tier: o.tier,
        status: o.status,
        note: extra ? `${o.note} ${extra}` : o.note,
      };
    });
    const askable = items.filter((it) => it.candidates.length > 0).length;
    labels.push(
      `Jev (${run.provider ?? decisions.name}${run.model ? `, model ${run.model}` : ""}) answered ${run.asked} of ${askable} shortlisted URLs in ${run.calls} call${run.calls === 1 ? "" : "s"} (up to ${REDIRECT_BATCH_SIZE} questions per call). Act tier = automatic; Flag tier = "Check this yourself" (review); "none", "insufficient context", and withheld answers = no match. Policy ${POLICY_VERSION}.`,
    );
    if (run.stoppedBy === "budget") labels.push("Jev budget reached: the project's daily Jev call limit was used up, so the remaining rows need your review.");
    if (run.stoppedBy === "error") labels.push("Jev could not be reached, so no further questions were sent; the remaining rows need your review.");
  } else {
    for (const p of unresolved) {
      const lead =
        p.unresolved!.length === 0
          ? "No new URL shares any words with this URL; decide it yourself or leave it unredirected."
          : "No deterministic match. Pick one of the shortlisted pages or leave it unredirected.";
      const extra = [p.row.note, ambiguityNote(p).trim()].filter(Boolean).join(" ");
      p.row = { ...p.row, status: "review", note: extra ? `${lead} ${extra}` : lead };
    }
    if (unresolved.length > 0) {
      if (isDemo) labels.push("Demo: Jev is not called; rows without a deterministic match need your review.");
      else if (!jevWanted) labels.push("Jev was turned off for this request: only exact-path and normalized-slug matches are automatic; everything else needs your review.");
      else labels.push("Jev (TypeSafe) is not configured for this workspace: only exact-path and normalized-slug matches are automatic; everything else needs your review.");
    }
  }

  // ------------------------------------------------------------ result
  const rows = pending.map((p) => p.row);
  const counts = { auto: 0, review: 0, noMatch: 0 };
  for (const r of rows) {
    if (r.status === "auto") counts.auto++;
    else if (r.status === "review") counts.review++;
    else counts.noMatch++;
  }
  const pairs: Array<{ fromPath: string; toPath: string }> = [];
  for (const r of rows) {
    if (r.status !== "auto" || !r.to) continue;
    const toPath = pathOf(r.to);
    if (!toPath || comparablePath(r.from) === comparablePath(toPath)) continue;
    pairs.push({ fromPath: r.from, toPath });
  }
  labels.push(LABEL_CSV_SCOPE);
  labels.push(
    `Matching ${MATCH_VERSION}: exact path, then normalized slug (automatic, no Jev confidence); otherwise the top ${SHORTLIST_SIZE} new URLs by slug, title/H1, and path word overlap.`,
  );

  return {
    state: isDemo ? "demo" : "ready",
    generatedAt: now.toISOString(),
    rows,
    counts,
    shopifyCsv: buildShopifyCsv(pairs),
    labels: [LABEL_REVIEW_ONLY, LABEL_UNCERTAIN, ...labels],
  };
}
