/**
 * [A25] Internal link suggester run (user-triggered, on the latest crawl of the verified site).
 *
 * Steps: setup check (verified host + a completed/partial crawl; demo projects use the demo crawl) ->
 * load snapshots (link-context sentences; older snapshots fall back to sentences split from the stored
 * excerpt/first paragraph) and current-window GSC impressions -> TF-IDF defining terms (terms.ts) ->
 * candidate targets (candidates.ts, top 8 per source) -> sentences (top 4) and anchors (top 5) per pair
 * -> pairs sorted by score and capped at MAX_PAIRS_PER_RUN -> Jev in batches of 10 pairs (jev.ts), or
 * deterministic picks marked review -> persist link_run + link_suggestions, carrying user_status over
 * from earlier runs -> the stored LinkSuggestionReport.
 *
 * Cap: MAX_PAIRS_PER_RUN = 400 pairs per run (highest candidate scores first; sentences and anchors are
 * only computed until the cap is full). At 10 pairs per call a full run is at most 40 Jev calls. The
 * project's daily jev_calls/provider_calls limit (default 60/day, shared with the agents and the redirect
 * tool) is enforced per call by the DecisionProvider; pairs left when it runs out become deterministic
 * review suggestions.
 *
 * Nothing is fetched and nothing on the site is changed.
 */
import type { LinkSuggestionReport } from "@shared/types";
import type { Env } from "../env";
import type { Db } from "../lib/db";
import { parseJson } from "../lib/db";
import { conflict } from "../lib/errors";
import { newId } from "../lib/ids";
import { addSeconds, iso, type Clock } from "../lib/time";
import type { ProjectRow } from "../platform/access";
import type { DecisionProvider } from "../providers/types";
import { buildDecisionsForWorkspace } from "../redirects/decisions";
import { POLICY_VERSION } from "../runs/policy";
import { linkContextSentences } from "../seo/crawl/extract";
import { anchorCandidates, deterministicPick, ANCHORS_VERSION, MAX_ANCHORS_PER_PAIR, type AnchorCandidate } from "./anchors";
import {
  candidateTargets,
  canBeSource,
  computeInlinks,
  GSC_BOOST_CAP,
  isOrphan,
  LOW_INLINK_BOOST,
  MAX_TARGETS_PER_SOURCE,
  MIN_BASE_SCORE,
  ORPHAN_BOOST,
  targetExclusion,
  urlKey,
  CANDIDATES_VERSION,
  type Candidate,
  type LinkPage,
} from "./candidates";
import { decideLinks, LINK_BATCH_SIZE, type LinkJevOutcome, type LinkJevPair, type LinkJevRun } from "./jev";
import { emptyReport, getLinkReport, linkSetup, type LinkRunSummary, type LinkSuggestionRow } from "./report";
import { MAX_SENTENCES_PER_PAIR, rankSentences, type RankedSentence } from "./sentences";
import { brandStopwords, computeDefiningTerms, termStems, TERMS_VERSION, TOP_TERMS, type DefiningTerm } from "./terms";

export const LINKS_METHOD_VERSION = `${TERMS_VERSION}+${CANDIDATES_VERSION}+${ANCHORS_VERSION}`;
export const MAX_PAIRS_PER_RUN = 400;
export const MAX_GENERIC_ANCHOR_FLAGS = 200;
export const MAX_ORPHAN_PAGES = 200;
/** A 'running' link run younger than this blocks a second concurrent run for the project. */
export const RUN_GUARD_SECONDS = 10 * 60;

export interface LinkRunOptions {
  /** undefined = build from the workspace's TypeSafe key; null = no Jev. Ignored (null) for demo projects. */
  decisions?: DecisionProvider | null;
  maxPairs?: number;
  batchSize?: number;
  clock?: Clock;
  userId?: string | null;
}

interface SnapshotRow {
  page_id: string;
  url: string;
  page_type: string;
  status_code: number | null;
  final_url: string | null;
  skipped_reason: string | null;
  title: string | null;
  h1_json: string;
  headings_json: string;
  canonical: string | null;
  robots_meta: string | null;
  internal_links_json: string;
  link_context_json: string | null;
  main_text_excerpt: string | null;
  first_paragraph: string | null;
  generic_anchors_json: string | null;
}

interface LoadedPage extends LinkPage {
  sentenceSource: "crawl" | "excerpt" | "none";
  genericAnchors: Array<{ href: string; text: string }>;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

async function loadPages(db: Db, project: ProjectRow, crawlRunId: string): Promise<LoadedPage[]> {
  const rows = await db.all<SnapshotRow>(
    `SELECT p.id AS page_id, p.url, p.page_type, s.status_code, s.final_url, s.skipped_reason, s.title, s.h1_json, s.headings_json,
            s.canonical, s.robots_meta, s.internal_links_json, s.link_context_json, s.main_text_excerpt, s.first_paragraph, s.generic_anchors_json
       FROM page_snapshots s JOIN pages p ON p.id = s.page_id AND p.workspace_id = s.workspace_id AND p.project_id = s.project_id
      WHERE s.workspace_id = ? AND s.project_id = ? AND s.crawl_run_id = ?
      ORDER BY s.fetched_at, s.rowid`,
    project.workspace_id,
    project.id,
    crawlRunId,
  );
  const byId = new Map<string, LoadedPage>();
  for (const r of rows) {
    let sentences = strings(parseJson<unknown>(r.link_context_json, []));
    let sentenceSource: LoadedPage["sentenceSource"] = sentences.length ? "crawl" : "none";
    if (sentences.length === 0) {
      // Older snapshots (or seeded demo data) have no stored sentences: split the stored excerpt instead.
      const fallback = linkContextSentences([r.first_paragraph ?? "", r.main_text_excerpt ?? ""].filter(Boolean));
      if (fallback.length) {
        sentences = fallback;
        sentenceSource = "excerpt";
      }
    }
    const headings = parseJson<unknown[]>(r.headings_json, [])
      .filter((h): h is { level: number; text: string } => !!h && typeof h === "object" && typeof (h as { text?: unknown }).text === "string")
      .filter((h) => h.level !== 1)
      .map((h) => h.text);
    byId.set(r.page_id, {
      pageId: r.page_id,
      url: r.url,
      pageType: r.page_type,
      statusCode: r.status_code,
      finalUrl: r.final_url,
      skippedReason: r.skipped_reason,
      robotsMeta: r.robots_meta,
      canonical: r.canonical,
      title: r.title,
      h1s: strings(parseJson<unknown>(r.h1_json, [])),
      headings,
      sentences,
      internalLinks: strings(parseJson<unknown>(r.internal_links_json, [])),
      gscImpressions: null,
      sentenceSource,
      genericAnchors: parseJson<unknown[]>(r.generic_anchors_json, []).filter(
        (g): g is { href: string; text: string } => !!g && typeof g === "object" && typeof (g as { href?: unknown }).href === "string" && typeof (g as { text?: unknown }).text === "string",
      ),
    });
  }
  return [...byId.values()];
}

/**
 * Current-window impressions per URL key from the latest GSC sync. Page-level rows (no query/device) are
 * used when present; otherwise query x page rows are summed (an approximation, used only as a boost).
 * Returns null when the project has no GSC data.
 */
async function loadGscImpressions(db: Db, project: ProjectRow): Promise<Map<string, number> | null> {
  const sync = await db.first<{ id: string }>(
    `SELECT id FROM gsc_syncs WHERE workspace_id = ? AND project_id = ? AND status IN ('completed', 'partial')
      ORDER BY synced_at DESC, rowid DESC LIMIT 1`,
    project.workspace_id,
    project.id,
  );
  if (!sync) return null;
  const rows = await db.all<{ page: string; page_level: number; impressions: number }>(
    `SELECT page, CASE WHEN query IS NULL AND device IS NULL THEN 1 ELSE 0 END AS page_level, SUM(impressions) AS impressions
       FROM gsc_metrics WHERE workspace_id = ? AND project_id = ? AND sync_id = ? AND "window" = 'current' AND page IS NOT NULL
      GROUP BY page, page_level`,
    project.workspace_id,
    project.id,
    sync.id,
  );
  const pageLevel = new Map<string, number>();
  const summed = new Map<string, number>();
  for (const r of rows) {
    const k = urlKey(r.page);
    const m = r.page_level === 1 ? pageLevel : summed;
    m.set(k, (m.get(k) ?? 0) + Number(r.impressions ?? 0));
  }
  const out = new Map(summed);
  for (const [k, v] of pageLevel) out.set(k, v);
  return out;
}

interface Pair {
  candidate: Candidate;
  source: LoadedPage;
  target: LoadedPage;
  targetTerms: DefiningTerm[];
  sentences: RankedSentence[];
  anchors: AnchorCandidate[];
  pick: { sentence: RankedSentence; anchor: AnchorCandidate };
}

const fmt = (n: number) => n.toLocaleString("en-US");

function candidateReasons(p: Pair, sentence: RankedSentence, anchor: AnchorCandidate): string[] {
  const c = p.candidate;
  const reasons = [
    `Shared terms: ${c.overlap.map((t) => t.label).join(", ")} (overlap weight ${c.base.toFixed(2)}).`,
    `The chosen sentence contains ${sentence.hits} of the target's defining terms.`,
  ];
  if (c.orphan) reasons.push(`Target is an orphan within crawl coverage (0 inlinks from crawled pages), x${ORPHAN_BOOST}.`);
  else if (c.linkBoost > 1) reasons.push(`Target has only 1 inlink from crawled pages, x${LOW_INLINK_BOOST}.`);
  if (c.gscImpressions !== null && c.gscBoost > 1) reasons.push(`Target had ${fmt(c.gscImpressions)} GSC impressions in the current window, x${c.gscBoost.toFixed(2)}.`);
  if (anchor.inTitle) reasons.push("The anchor phrase matches words from the target's title or H1.");
  return reasons;
}

export async function runLinkSuggestions(env: Env, db: Db, project: ProjectRow, now: Date, opts: LinkRunOptions = {}): Promise<LinkSuggestionReport> {
  const clock = opts.clock ?? (() => now);
  const isDemo = project.is_demo === 1;
  const setup = await linkSetup(db, project);
  if (setup.state === "setup_required" || !setup.host || !setup.crawl) {
    return emptyReport("setup_required", null, [setup.message ?? "Setup required."], isDemo);
  }
  const host = setup.host;
  const crawl = setup.crawl;

  const running = await db.first<{ id: string }>(
    "SELECT id FROM link_runs WHERE workspace_id = ? AND project_id = ? AND status = 'running' AND created_at > ? LIMIT 1",
    project.workspace_id,
    project.id,
    iso(addSeconds(now, -RUN_GUARD_SECONDS)),
  );
  if (running) throw conflict("An internal-link run is already in progress for this project.");

  const linkRunId = newId("lrun");
  await db.insert("link_runs", {
    id: linkRunId,
    workspace_id: project.workspace_id,
    project_id: project.id,
    crawl_run_id: crawl.id,
    status: "running",
    is_demo: isDemo ? 1 : 0,
    method_version: LINKS_METHOD_VERSION,
    created_by: opts.userId ?? null,
    created_at: iso(now),
  });

  try {
    // ------------------------------------------------------------ data
    const pages = await loadPages(db, project, crawl.id);
    const gsc = await loadGscImpressions(db, project);
    if (gsc) for (const p of pages) p.gscImpressions = gsc.get(urlKey(p.url)) ?? 0;

    const aliases = parseJson<unknown[]>(project.brand_aliases_json, []).filter((a): a is string => typeof a === "string");
    const extraStop = brandStopwords(project.brand_name, aliases);
    const eligible = pages.filter((p) => targetExclusion(p, host) === null || canBeSource(p, host));
    const terms = computeDefiningTerms(
      eligible.map((p) => ({ id: p.pageId, title: p.title, h1s: p.h1s, headings: p.headings, sentences: p.sentences })),
      { extraStop },
    );
    const analysed = eligible.filter((p) => (terms.get(p.pageId)?.length ?? 0) > 0);
    const sentenceStems = new Map<string, Array<Set<string>>>();
    const sentenceStemUnion = new Map<string, Set<string>>();
    for (const p of eligible) {
      const perSentence = p.sentences.map((s) => new Set(termStems(s, extraStop)));
      sentenceStems.set(p.pageId, perSentence);
      sentenceStemUnion.set(p.pageId, new Set(perSentence.flatMap((s) => [...s])));
    }

    // ------------------------------------------------------------ candidates, sentences, anchors
    const candidates = candidateTargets({ pages: eligible, terms, sentenceStems: sentenceStemUnion, host });
    const byId = new Map(pages.map((p) => [p.pageId, p]));
    const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    // All candidates in score order; sentences and anchors are computed lazily, only until the cap is full.
    const ordered = [...candidates.values()]
      .flat()
      .map((c) => ({ c, source: byId.get(c.sourcePageId)!, target: byId.get(c.targetPageId)! }))
      .sort((a, b) => b.c.score - a.c.score || cmp(a.source.url, b.source.url) || cmp(a.target.url, b.target.url));
    const maxPairs = Math.max(1, opts.maxPairs ?? MAX_PAIRS_PER_RUN);
    const kept: Pair[] = [];
    let withoutAnchor = 0;
    for (const { c, source, target } of ordered) {
      if (kept.length >= maxPairs) break;
      const targetTerms = terms.get(target.pageId) ?? [];
      const sentences = rankSentences(source.sentences, sentenceStems.get(source.pageId) ?? [], targetTerms);
      const anchors = anchorCandidates(sentences, { terms: targetTerms, title: target.title, h1s: target.h1s });
      const pick = deterministicPick(sentences, anchors);
      if (!pick) {
        withoutAnchor++; // no descriptive anchor phrase in any candidate sentence
        continue;
      }
      kept.push({ candidate: c, source, target, targetTerms, sentences, anchors, pick });
    }
    const capped = kept.length >= maxPairs && ordered.length > kept.length + withoutAnchor;

    // ------------------------------------------------------------ Jev
    const decisions = isDemo ? null : opts.decisions === undefined ? await buildDecisionsForWorkspace(env, db, project.workspace_id, project.id) : opts.decisions;
    let jev: LinkJevRun | null = null;
    const jevPairs: LinkJevPair[] = kept.map((p) => ({
      pairKey: `${p.source.pageId}>${p.target.pageId}`,
      source: { url: p.source.url, title: p.source.title },
      target: { url: p.target.url, title: p.target.title, h1: p.target.h1s[0] ?? null, terms: p.targetTerms.map((t) => t.label) },
      sentences: p.sentences.map((s) => ({ key: s.key, text: s.text })),
      anchors: p.anchors.map((a) => ({ key: a.key, text: a.text, sentenceKey: a.sentenceKey })),
      fallback: { sentenceKey: p.pick.sentence.key, anchorKey: p.pick.anchor.key },
    }));
    if (decisions && kept.length > 0) {
      jev = await decideLinks(jevPairs, { decisions, db, workspaceId: project.workspace_id, projectId: project.id, linkRunId, clock, batchSize: opts.batchSize });
    }

    // ------------------------------------------------------------ suggestion rows
    const createdAt = iso(clock());
    const rows: LinkSuggestionRow[] = kept.map((p, i) => {
      const outcome: LinkJevOutcome | null = jev?.outcomes[i] ?? null;
      const skipped = jev?.skipped[i] ?? null;
      const sentence = (outcome && p.sentences.find((s) => s.key === outcome.sentenceKey)) || p.pick.sentence;
      const anchor = (outcome && p.anchors.find((a) => a.key === outcome.anchorKey)) || p.pick.anchor;
      const reasons = candidateReasons(p, sentence, anchor);
      if (outcome) {
        reasons.unshift(...outcome.reasons);
      } else if (jev) {
        reasons.unshift(
          skipped === "budget"
            ? "Not sent to Jev: this project's daily Jev budget is used up. Deterministic pick; check it yourself."
            : skipped === "error"
              ? "Not decided: Jev could not be reached, so no further questions were sent. Deterministic pick; check it yourself."
              : "Jev returned no usable answer for this pair. Deterministic pick; check it yourself.",
        );
      } else {
        reasons.unshift("Deterministic suggestion (best sentence and anchor by score); check it yourself.");
      }
      const anchorText = anchor.text;
      return {
        id: newId("lsug"),
        workspace_id: project.workspace_id,
        project_id: project.id,
        link_run_id: linkRunId,
        source_page_id: p.source.pageId,
        target_page_id: p.target.pageId,
        source_url: p.source.url,
        source_title: p.source.title,
        target_url: p.target.url,
        target_title: p.target.title,
        target_inlinks: p.candidate.inlinks,
        target_orphan: p.candidate.orphan ? 1 : 0,
        suggestion_key: suggestionKey(p.source.pageId, p.target.pageId, anchorText),
        sentence_index: sentence.index,
        sentence_text: sentence.text,
        anchor_text: anchorText,
        role: outcome?.role ?? null,
        method: outcome ? "jev" : "deterministic",
        tier: outcome ? outcome.tier : null,
        should_exist: outcome?.shouldExist ?? null,
        sentence_confidence: outcome?.sentenceConfidence ?? null,
        anchor_confidence: outcome?.anchorConfidence ?? null,
        role_confidence: outcome?.roleConfidence ?? null,
        provider: outcome ? (jev?.provider ?? null) : null,
        model: outcome ? (jev?.model ?? null) : null,
        question_version: jev ? jev.questionVersion : null,
        policy_version: jev ? POLICY_VERSION : null,
        decision_record_id: jev?.decisionIds[i] ?? null,
        status: outcome ? outcome.status : "review",
        score: p.candidate.score,
        reasons_json: JSON.stringify(reasons),
        user_status: "open",
        created_at: createdAt,
        updated_at: createdAt,
      };
    });

    // ------------------------------------------------------------ carry over user_status
    const superseded = await carryOverUserStatus(db, project, rows);

    const stmts: Array<[string, ...unknown[]]> = rows.map((r) => insertRow(r));
    for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
    // Earlier runs: open rows are superseded by this run; non-open rows are kept as status memory unless
    // their status was just carried onto a new row.
    await db.run("DELETE FROM link_suggestions WHERE workspace_id = ? AND project_id = ? AND link_run_id != ? AND user_status = 'open'", project.workspace_id, project.id, linkRunId);
    const ids = [...superseded];
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      await db.run(
        `DELETE FROM link_suggestions WHERE workspace_id = ? AND project_id = ? AND link_run_id != ? AND id IN (${chunk.map(() => "?").join(",")})`,
        project.workspace_id,
        project.id,
        linkRunId,
        ...chunk,
      );
    }
    await db.run(
      `DELETE FROM link_runs WHERE workspace_id = ? AND project_id = ? AND id != ?
         AND NOT EXISTS (SELECT 1 FROM link_suggestions s WHERE s.link_run_id = link_runs.id)`,
      project.workspace_id,
      project.id,
      linkRunId,
    );

    // ------------------------------------------------------------ summary + labels
    const inlinks = computeInlinks(pages);
    const orphanPages = pages
      .filter((p) => targetExclusion(p, host) === null && isOrphan(p, inlinks.get(urlKey(p.url))?.size ?? 0))
      .slice(0, MAX_ORPHAN_PAGES)
      .map((p) => ({ pageId: p.pageId, url: p.url }));
    const genericAnchors = pages
      .filter((p) => p.genericAnchors.length > 0)
      .flatMap((p) => p.genericAnchors.map((g) => ({ sourceUrl: p.url, targetUrl: g.href, anchor: g.text })))
      .slice(0, MAX_GENERIC_ANCHOR_FLAGS);

    const htmlPages = pages.filter((p) => p.statusCode !== null && p.statusCode >= 200 && p.statusCode < 300 && !p.skippedReason && !(p.finalUrl && urlKey(p.finalUrl) !== urlKey(p.url)));
    const noSentences = analysed.filter((p) => p.sentences.length === 0).length;
    const fromExcerpt = analysed.filter((p) => p.sentenceSource === "excerpt").length;
    const skippedInCrawl = pages.filter((p) => p.skippedReason).length;
    const noteParts = [`${analysed.length} of ${htmlPages.length} pages analysed`];
    if (noSentences) noteParts.push(`${noSentences} without usable sentences (targets only)`);
    if (fromExcerpt) noteParts.push(`${fromExcerpt} using sentences from the stored excerpt (crawled before sentence extraction)`);
    if (skippedInCrawl) noteParts.push(`${skippedInCrawl} crawled URL${skippedInCrawl === 1 ? "" : "s"} skipped by the crawl`);
    if (capped) noteParts.push(`pairs capped at ${maxPairs} (${ordered.length} candidate pairs; highest scores kept)`);
    const completeness = { note: noteParts.join("; "), covered: analysed.length, total: htmlPages.length };

    const counts = { suggested: 0, review: 0, rejected: 0 };
    for (const r of rows) counts[r.status]++;

    const notes: string[] = [];
    if (jev && decisions) {
      const who = `${jev.provider ?? decisions.name}${jev.model ? `, model ${jev.model}` : ""}`;
      notes.push(
        `Jev (${who}) answered ${jev.answered} of ${kept.length} pairs in ${jev.calls} call${jev.calls === 1 ? "" : "s"} (up to ${LINK_BATCH_SIZE} pairs, 4 questions each, per call). Act tier = suggested; Flag = review ("Check this yourself"); withheld answers fall back to the deterministic pick; "no" or "none" = rejected. Policy ${POLICY_VERSION}.`,
      );
      const left = jev.skipped.filter((s) => s !== null).length;
      if (jev.stoppedBy === "budget") notes.push(`Jev budget reached: the project's daily Jev call limit was used up, so ${left} pair${left === 1 ? "" : "s"} are deterministic suggestions marked review.`);
      if (jev.stoppedBy === "error") notes.push(`Jev could not be reached, so ${left} pair${left === 1 ? "" : "s"} are deterministic suggestions marked review.`);
    } else if (!isDemo && kept.length > 0) {
      notes.push("Jev (TypeSafe) is not configured for this workspace: suggestions are deterministic (best sentence and anchor by score) and marked review.");
    }
    if (kept.length === 0) notes.push("No new internal-link opportunities found in the latest crawl: every candidate pair already links, or no page's sentences mention another page's defining terms.");
    notes.push(
      `Candidates (${CANDIDATES_VERSION}): up to ${MAX_TARGETS_PER_SOURCE} targets per source, scored by the overlap of the source's sentence terms with the target's defining terms (TF-IDF over the crawl: title x3, H1 x3, headings x2, sentences x1; top ${TOP_TERMS} terms; overlap weight at least ${MIN_BASE_SCORE}), x${ORPHAN_BOOST} for orphan targets, x${LOW_INLINK_BOOST} for targets with one inlink, and a GSC impressions boost of 1 + log10(1 + impressions)/10 (at most +${GSC_BOOST_CAP}). Up to ${MAX_SENTENCES_PER_PAIR} sentences and ${MAX_ANCHORS_PER_PAIR} anchor phrases per pair; generic anchors are never proposed. Pages that already link, self links, and non-2xx, noindex, redirecting, non-canonical, or off-host targets are excluded.`,
    );
    notes.push("Orphan and inlink counts cover crawled pages only: a page linked from pages outside the crawl can appear orphaned.");
    if (!gsc) notes.push("No Search Console data: targets are not boosted by impressions.");

    const summary: LinkRunSummary & Record<string, unknown> = {
      orphanPages,
      genericAnchors,
      completeness,
      counts,
      pairsConsidered: ordered.length,
      pairsWithoutAnchor: withoutAnchor,
      pairsKept: kept.length,
      jev: jev ? { calls: jev.calls, asked: jev.asked, answered: jev.answered, stoppedBy: jev.stoppedBy, questionVersion: jev.questionVersion } : null,
    };
    await db.run(
      `UPDATE link_runs SET status = ?, pages_analysed = ?, pages_eligible = ?, provider = ?, model = ?, summary_json = ?, notes_json = ?, finished_at = ?
        WHERE id = ? AND workspace_id = ? AND project_id = ?`,
      jev?.stoppedBy ? "partial" : "completed",
      analysed.length,
      htmlPages.length,
      jev?.provider ?? null,
      jev?.model ?? null,
      JSON.stringify(summary),
      JSON.stringify(notes),
      iso(clock()),
      linkRunId,
      project.workspace_id,
      project.id,
    );
    return await getLinkReport(db, project);
  } catch (e) {
    await db
      .run(
        "UPDATE link_runs SET status = 'failed', notes_json = ?, finished_at = ? WHERE id = ? AND workspace_id = ? AND project_id = ?",
        JSON.stringify([`Run failed: ${e instanceof Error ? e.message.slice(0, 200) : "unknown error"}`]),
        iso(clock()),
        linkRunId,
        project.workspace_id,
        project.id,
      )
      .catch(() => undefined);
    throw e;
  }
}

export function suggestionKey(sourcePageId: string, targetPageId: string, anchor: string | null): string {
  return `${sourcePageId}|${targetPageId}|${(anchor ?? "").toLowerCase().replace(/\s+/g, " ").trim()}`;
}

/**
 * Apply user statuses from earlier runs: the latest non-open status for the same suggestion_key wins;
 * otherwise a dismissed source/target pair stays dismissed even if the anchor changed. Returns the ids
 * of earlier rows whose status now lives on a new row.
 */
async function carryOverUserStatus(db: Db, project: ProjectRow, rows: LinkSuggestionRow[]): Promise<Set<string>> {
  const prior = await db.all<{ id: string; suggestion_key: string; source_page_id: string; target_page_id: string; user_status: LinkSuggestionRow["user_status"] }>(
    `SELECT id, suggestion_key, source_page_id, target_page_id, user_status FROM link_suggestions
      WHERE workspace_id = ? AND project_id = ? AND user_status != 'open'
      ORDER BY updated_at DESC, rowid DESC`,
    project.workspace_id,
    project.id,
  );
  const byKey = new Map<string, (typeof prior)[number]>();
  const dismissedPair = new Map<string, (typeof prior)[number]>();
  const allByKey = new Map<string, string[]>();
  for (const p of prior) {
    if (!byKey.has(p.suggestion_key)) byKey.set(p.suggestion_key, p);
    const pk = `${p.source_page_id}|${p.target_page_id}`;
    if (p.user_status === "dismissed" && !dismissedPair.has(pk)) dismissedPair.set(pk, p);
    allByKey.set(p.suggestion_key, [...(allByKey.get(p.suggestion_key) ?? []), p.id]);
  }
  const superseded = new Set<string>();
  for (const r of rows) {
    const exact = byKey.get(r.suggestion_key);
    if (exact) {
      r.user_status = exact.user_status;
      for (const id of allByKey.get(r.suggestion_key) ?? []) superseded.add(id);
      continue;
    }
    const pair = dismissedPair.get(`${r.source_page_id}|${r.target_page_id}`);
    if (pair) r.user_status = "dismissed";
  }
  return superseded;
}

function insertRow(r: LinkSuggestionRow): [string, ...unknown[]] {
  const keys = Object.keys(r) as Array<keyof LinkSuggestionRow>;
  return [`INSERT INTO link_suggestions (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`, ...keys.map((k) => r[k])];
}

/** Re-exported for the SEO agent (not wired here). */
export { topLinkSuggestionsForAgent } from "./report";
