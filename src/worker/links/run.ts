/**
 * [A25] Internal link suggester run (user-triggered), extended by the internal-links workbench (2026-10-03).
 *
 * Steps: setup check (verified host + a completed/partial crawl; demo projects use the demo crawl) -> the full-site
 * link graph from the LATEST SNAPSHOT OF EVERY PAGE across crawls (graph-store.ts; stored for the other tabs) ->
 * link-context sentences (older snapshots fall back to sentences split from the stored excerpt) -> TF-IDF defining
 * terms (terms.ts) -> candidate targets (candidates.ts, top 15 per source, inlinks and existing links from the full
 * graph) plus cluster-gap pairs (clusters.ts: missing hub -> spoke / spoke -> hub links) -> versioned priority per
 * pair (priority.ts: relevance x Search Console impact x cluster gap) -> pairs sorted by priority; sentences (top 4)
 * and anchors (top 5, avoiding anchors that would worsen a repetition flag, anchor-audit.ts) until MAX_PAIRS_PER_RUN
 * pairs are kept -> Jev in batches of 10 pairs (jev.ts), or deterministic picks marked review -> drafted sentences
 * for the highest-priority pairs where no sentence mentions the target (draft.ts; writer, budgeted, capped, labelled
 * "Draft sentence — review before publishing") -> persist link_run + link_suggestions (priority, placement, cluster,
 * draft), carrying user_status over from earlier runs -> the stored LinkSuggestionReport.
 *
 * Caps: MAX_PAIRS_PER_RUN = 400 pairs judged per run (highest priorities first); at 10 pairs per call a full run is at
 * most 40 Jev calls. The cap was deliberately NOT raised with MAX_TARGETS_PER_SOURCE (8 -> 15): 15/8 x 400 = 750
 * pairs would be 75 calls, above the default 60 jev_calls per project per day. The project's daily
 * jev_calls/provider_calls limit is enforced per call by the DecisionProvider; pairs left when it runs out become
 * deterministic review suggestions. Drafts: at most MAX_DRAFTS_PER_RUN (20) pairs in calls of 5 (writer_tokens +
 * provider_calls reserved per call by the writer's metering).
 *
 * Nothing is fetched from the site and nothing on the site is changed.
 */
import type { LinkSuggestionReport } from "@shared/types";
import type { Env } from "../env";
import type { Db } from "../lib/db";
import { parseJson } from "../lib/db";
import { conflict } from "../lib/errors";
import { newId } from "../lib/ids";
import { addSeconds, iso, type Clock } from "../lib/time";
import type { ProjectRow } from "../platform/access";
import type { DecisionProvider, WritingProvider } from "../providers/types";
import { buildDecisionsForWorkspace } from "../redirects/decisions";
import { POLICY_VERSION } from "../runs/policy";
import { buildWriterForWorkspace } from "../runs/runtime";
import { anchorCandidates, deterministicPick, ANCHORS_VERSION, MAX_ANCHORS_PER_PAIR, type AnchorCandidate } from "./anchors";
import { worsensRepetition } from "./anchor-audit";
import {
  candidateTargets,
  canBeSource,
  GSC_BOOST_CAP,
  isOrphan,
  linkBoost,
  LOW_INLINK_BOOST,
  MAX_TARGETS_PER_SOURCE,
  MIN_BASE_SCORE,
  ORPHAN_BOOST,
  targetExclusion,
  topicalCandidates,
  urlKey,
  CANDIDATES_VERSION,
  type Candidate,
  type LinkPage,
} from "./candidates";
import { clusterGapFor } from "./clusters";
import { DRAFT_LABEL, DRAFT_VERSION, draftSentences, MAX_DRAFTS_PER_RUN, type DraftOutcome, type DraftPair } from "./draft";
import { linkedKeys, STALE_DAYS, type GraphNode } from "./graph";
import type { SnapshotRecord } from "./graph-load";
import { buildAndStoreLinkGraph, computeGraph, type ComputedGraph } from "./graph-store";
import { gscSourceLabel } from "./gsc";
import { decideLinks, LINK_BATCH_SIZE, type LinkJevOutcome, type LinkJevPair, type LinkJevRun } from "./jev";
import { computePriority, explainPriority, LINK_PRIORITY_VERSION, type PriorityBreakdown } from "./priority";
import { emptyReport, getLinkReport, linkSetup, type LinkRunSummary, type LinkSuggestionRow } from "./report";
import { MAX_SENTENCES_PER_PAIR, rankSentences, type RankedSentence } from "./sentences";
import { placedLinkPairs } from "../imports/service";
import { brandStopwords, computeDefiningTerms, round, termStems, TERMS_VERSION, TOP_TERMS, type DefiningTerm } from "./terms";

export const LINKS_METHOD_VERSION = `${TERMS_VERSION}+${CANDIDATES_VERSION}+${ANCHORS_VERSION}+${LINK_PRIORITY_VERSION}+${DRAFT_VERSION}`;
export const MAX_PAIRS_PER_RUN = 400;
export const MAX_GENERIC_ANCHOR_FLAGS = 200;
export const MAX_ORPHAN_PAGES = 200;
/** Cluster-gap pairs considered per run (highest priorities are kept with the other candidates). */
export const MAX_CLUSTER_GAP_PAIRS = 600;
/** A 'running' link run younger than this blocks a second concurrent run for the project. */
export const RUN_GUARD_SECONDS = 10 * 60;

export interface LinkRunOptions {
  /** undefined = build from the workspace's TypeSafe key; null = no Jev. Ignored (null) for demo projects. */
  decisions?: DecisionProvider | null;
  /** undefined = the workspace writer (setup_required when none); null = no drafts. Ignored (null) for demo projects. */
  writer?: WritingProvider | null;
  maxPairs?: number;
  batchSize?: number;
  maxDrafts?: number;
  clock?: Clock;
  userId?: string | null;
}

interface LoadedPage extends LinkPage {
  sentenceSource: "crawl" | "excerpt" | "none";
  genericAnchors: Array<{ href: string; text: string }>;
  node: GraphNode;
  fetchedAt: string;
}

function toLinkPage(s: SnapshotRecord, node: GraphNode): LoadedPage {
  const anchored = (s.linkAnchors ?? []).map((a) => a[0]);
  return {
    pageId: s.pageId,
    url: s.url,
    pageType: s.pageType,
    statusCode: s.statusCode,
    finalUrl: s.finalUrl,
    skippedReason: s.skippedReason,
    robotsMeta: s.robotsMeta,
    canonical: s.canonical,
    title: s.title,
    h1s: s.h1s,
    headings: s.headings,
    sentences: s.sentences,
    internalLinks: anchored.length ? [...new Set([...s.internalLinks, ...anchored])] : s.internalLinks,
    gscImpressions: null,
    sentenceSource: s.sentenceSource,
    genericAnchors: s.genericAnchors,
    node,
    fetchedAt: s.fetchedAt,
  };
}

interface Pair {
  candidate: Candidate;
  source: LoadedPage;
  target: LoadedPage;
  targetTerms: DefiningTerm[];
  priority: PriorityBreakdown;
  gap: "hub_to_spoke" | "spoke_to_hub" | null;
  hubKey: string | null;
  origin: "terms" | "cluster_gap" | "topical";
}

interface KeptPair extends Pair {
  sentences: RankedSentence[];
  anchors: AnchorCandidate[];
  pick: { sentence: RankedSentence; anchor: AnchorCandidate };
  anchorNote: string | null;
}

interface DraftCandidate extends Pair {
  anchor: string;
}

const fmt = (n: number) => n.toLocaleString("en-US");
const day = (t: string) => t.slice(0, 10);

function candidateReasons(p: Pair, sentence: RankedSentence | null, anchor: AnchorCandidate | null): string[] {
  const c = p.candidate;
  const reasons: string[] = [];
  if (c.overlap.length) reasons.push(`Shared terms: ${c.overlap.map((t) => t.label).join(", ")} (overlap weight ${c.base.toFixed(2)}).`);
  if (sentence) reasons.push(`The chosen sentence contains ${sentence.hits} of the target's defining terms.`);
  if (c.orphan) reasons.push(`Target is an orphan in the link graph (0 inlinks from analysed pages), x${ORPHAN_BOOST}.`);
  else if (c.linkBoost > 1) reasons.push(`Target has only 1 inlink in the link graph, x${LOW_INLINK_BOOST}.`);
  if (c.gscImpressions !== null && c.gscImpressions > 0) reasons.push(`Target had ${fmt(c.gscImpressions)} GSC impressions in the current window, x${c.gscBoost.toFixed(2)} (legacy score).`);
  if (anchor?.inTitle) reasons.push("The anchor phrase matches words from the target's title or H1.");
  if (p.gap) {
    reasons.push(
      p.gap === "hub_to_spoke"
        ? "Closes a cluster gap: this hub page does not link to this spoke yet."
        : "Closes a cluster gap: this spoke does not link back to its hub yet.",
    );
  }
  if (p.source.node.stale) reasons.push(`The source snapshot is from ${day(p.source.fetchedAt)} (older than ${STALE_DAYS} days): check the sentence on the live page.`);
  return reasons;
}

/** An anchor for a drafted sentence: a descriptive phrase from the target's H1 or title (never generic). */
function draftAnchor(target: LoadedPage, terms: DefiningTerm[], audit: Parameters<typeof worsensRepetition>[0]): string | null {
  const titleCore = target.title ? target.title.split(/\s[|–—-]\s/)[0]!.trim() : null;
  const pseudo = [target.h1s[0] ?? null, titleCore].filter((s): s is string => !!s && s.length > 2);
  if (!pseudo.length) return null;
  const sentences: RankedSentence[] = pseudo.map((text, i) => ({ key: `s${i}`, index: i, text, hits: 1, weight: 1, matched: [] }));
  const options = anchorCandidates(sentences, { terms, title: target.title, h1s: target.h1s }, 10);
  const ok = options.filter((a) => !worsensRepetition(audit, a.text) && a.text.split(/\s+/).length <= 5);
  return (ok[0] ?? options[0])?.text ?? null;
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
    // ------------------------------------------------------------ the full-site graph (stored for the other tabs)
    const computed: ComputedGraph =
      (await buildAndStoreLinkGraph(db, project, { trigger: "run", now, text: true, userId: opts.userId ?? null, crawlRunId: crawl.id })) ??
      (await computeGraph(db, project, { now, text: true }))!;
    const { graph, clusters, audits, gsc } = computed;
    const gscLabel = gsc ? gscSourceLabel(gsc) : null;

    // ------------------------------------------------------------ pages (one per graph node with a snapshot)
    const pages: LoadedPage[] = [];
    for (const s of computed.snapshots) {
      const node = graph.byKey.get(urlKey(s.url));
      if (!node || node.snap !== s) continue; // a trailing-slash twin: the newer snapshot represents the URL
      const p = toLinkPage(s, node);
      p.gscImpressions = gsc ? (node.gsc?.impressions ?? 0) : null;
      pages.push(p);
    }
    const byId = new Map(pages.map((p) => [p.pageId, p]));
    const byKey = new Map(pages.map((p) => [p.node.key, p]));

    const aliases = parseJson<unknown[]>(project.brand_aliases_json, []).filter((a): a is string => typeof a === "string");
    const extraStop = brandStopwords(project.brand_name, aliases);
    const eligible = pages.filter((p) => targetExclusion(p, host) === null || canBeSource(p, host));
    const terms = computeDefiningTerms(
      eligible.map((p) => ({ id: p.pageId, title: p.title, h1s: p.h1s, headings: p.headings, sentences: p.sentences })),
      { extraStop },
    );
    const analysed = eligible.filter((p) => (terms.get(p.pageId)?.length ?? 0) > 0);
    const inlinksOf = (key: string) => graph.byKey.get(key)?.linksIn ?? 0;
    const linkedCache = new Map<string, Set<string>>();
    const linkedOf = (p: LinkPage) => {
      let s = linkedCache.get(p.pageId);
      if (!s) {
        const n = graph.byKey.get(urlKey(p.url));
        s = n ? linkedKeys(graph, n) : new Set<string>();
        linkedCache.set(p.pageId, s);
      }
      return s;
    };
    const sentenceStemCache = new Map<string, Array<Set<string>>>();
    const sentenceStemsOf = (pageId: string) => {
      let v = sentenceStemCache.get(pageId);
      if (!v) {
        v = (byId.get(pageId)?.sentences ?? []).map((s) => new Set(termStems(s, extraStop)));
        if (sentenceStemCache.size < 2_000) sentenceStemCache.set(pageId, v);
      }
      return v;
    };
    const unionStems = (pageId: string) => new Set(sentenceStemsOf(pageId).flatMap((s) => [...s]));

    // ------------------------------------------------------------ candidates + priority
    const prioritize = (c: Candidate, origin: Pair["origin"]): Pair => {
      const source = byId.get(c.sourcePageId)!;
      const target = byId.get(c.targetPageId)!;
      const gap = clusterGapFor(clusters, source.node.id, target.node.id);
      const priority = computePriority({ relevance: c.relevance, target: target.node.gsc, source: source.node.gsc, sourceInlinks: source.node.linksIn, hasGsc: !!gsc, clusterGap: gap });
      const spoke = clusters.spokes.get(gap === "hub_to_spoke" ? target.node.id : source.node.id) ?? clusters.spokes.get(target.node.id) ?? clusters.spokes.get(source.node.id);
      const hubKey = spoke && spoke.hub !== null ? graph.nodes[spoke.hub]!.key : null;
      return { candidate: c, source, target, targetTerms: terms.get(target.pageId) ?? [], priority, gap, hubKey, origin };
    };
    const candidates = candidateTargets({ pages: eligible, terms, sentenceStems: (id) => unionStems(id), host, inlinks: inlinksOf, linked: linkedOf });
    const pairs: Pair[] = [];
    const seenPairs = new Set<string>();
    for (const list of candidates.values()) {
      for (const c of list) {
        seenPairs.add(`${c.sourcePageId}>${c.targetPageId}`);
        pairs.push(prioritize(c, "terms"));
      }
    }
    // Cluster gaps: missing hub -> spoke and spoke -> hub links, even where term overlap found no candidate.
    let gapPairs = 0;
    const topicStemsOf = (pageId: string) => {
      const p = byId.get(pageId);
      if (!p) return new Set<string>();
      return new Set([...termStems(p.title, extraStop), ...p.h1s.flatMap((h) => termStems(h, extraStop)), ...p.headings.flatMap((h) => termStems(h, extraStop)), ...(terms.get(pageId) ?? []).map((t) => t.term)]);
    };
    const gapCandidate = (src: LoadedPage, tgt: LoadedPage): Candidate | null => {
      if (targetExclusion(tgt, host) !== null || !(src.node.analyzable && !src.node.canonicalKey)) return null;
      if (linkedOf(src).has(tgt.node.key)) return null;
      const tTerms = terms.get(tgt.pageId) ?? [];
      const stems = topicStemsOf(src.pageId);
      const overlap = tTerms.filter((t) => stems.has(t.term));
      const base = Math.max(MIN_BASE_SCORE, overlap.reduce((a, t) => a + t.weight, 0));
      const n = inlinksOf(tgt.node.key);
      const lb = linkBoost(tgt, n);
      return { sourcePageId: src.pageId, targetPageId: tgt.pageId, score: round(base * lb), relevance: round(base * lb), base: round(base), overlap, inlinks: n, orphan: isOrphan(tgt, n), linkBoost: lb, gscBoost: 1, gscImpressions: tgt.gscImpressions };
    };
    for (const s of clusters.spokes.values()) {
      if (s.hub === null || gapPairs >= MAX_CLUSTER_GAP_PAIRS) continue;
      const spoke = byKey.get(graph.nodes[s.spoke]!.key);
      const hub = byKey.get(graph.nodes[s.hub]!.key);
      if (!spoke || !hub) continue;
      for (const [src, tgt, missing] of [
        [hub, spoke, !s.hubToSpoke],
        [spoke, hub, !s.spokeToHub],
      ] as const) {
        if (!missing || seenPairs.has(`${src.pageId}>${tgt.pageId}`)) continue;
        const c = gapCandidate(src, tgt);
        if (!c) continue;
        seenPairs.add(`${src.pageId}>${tgt.pageId}`);
        pairs.push(prioritize(c, "cluster_gap"));
        gapPairs++;
      }
    }
    const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const byPriority = (a: Pair, b: Pair) => b.priority.value - a.priority.value || b.candidate.score - a.candidate.score || cmp(a.source.url, b.source.url) || cmp(a.target.url, b.target.url);
    pairs.sort(byPriority);

    // ------------------------------------------------------------ sentences and anchors, until the cap is full
    const maxPairs = Math.max(1, opts.maxPairs ?? MAX_PAIRS_PER_RUN);
    const kept: KeptPair[] = [];
    const noSentence: Pair[] = [];
    let withoutAnchor = 0;
    for (const p of pairs) {
      if (kept.length >= maxPairs) break;
      const sentences = p.source.sentences.length ? rankSentences(p.source.sentences, sentenceStemsOf(p.source.pageId), p.targetTerms) : [];
      const all = sentences.length ? anchorCandidates(sentences, { terms: p.targetTerms, title: p.target.title, h1s: p.target.h1s }) : [];
      const audit = audits.get(p.target.node.id);
      const allowed = all.filter((a) => !worsensRepetition(audit, a.text));
      const anchors = allowed.length ? allowed : all;
      const pick = deterministicPick(sentences, anchors);
      if (!pick) {
        if (all.length === 0 && sentences.length > 0) withoutAnchor++;
        noSentence.push(p);
        continue;
      }
      const anchorNote =
        allowed.length < all.length
          ? allowed.length
            ? `Skipped ${all.length - allowed.length} anchor option${all.length - allowed.length === 1 ? "" : "s"} already over-used for this target (anchor audit).`
            : "Every anchor option is already common for this target (anchor audit); consider varying the wording."
          : null;
      kept.push({ ...p, sentences, anchors, pick, anchorNote });
    }
    const capped = kept.length >= maxPairs && pairs.length > kept.length + noSentence.length;

    // ------------------------------------------------------------ draft pool: high-priority pairs with no fitting sentence
    const excluded = new Set([...seenPairs]);
    const topical = topicalCandidates({ pages: eligible, terms, topicStems: topicStemsOf, host, exclude: excluded, inlinks: inlinksOf, linked: linkedOf, maxPerSource: 3 }).map((c) => prioritize(c, "topical"));
    const maxDrafts = Math.max(0, Math.min(MAX_DRAFTS_PER_RUN, opts.maxDrafts ?? MAX_DRAFTS_PER_RUN));
    const draftPool: DraftCandidate[] = [];
    for (const p of [...noSentence, ...topical].sort(byPriority)) {
      if (draftPool.length >= maxDrafts) break;
      const anchor = draftAnchor(p.target, p.targetTerms, audits.get(p.target.node.id));
      if (!anchor) continue;
      draftPool.push({ ...p, anchor });
    }

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

    // ------------------------------------------------------------ drafted sentences (writer)
    let writer: WritingProvider | null = null;
    if (!isDemo && draftPool.length > 0) {
      writer = opts.writer === undefined ? await buildWriterForWorkspace(env, db, project.workspace_id, { projectId: project.id, clock }) : opts.writer;
    }
    const drafted = writer
      ? await draftSentences(
          writer,
          draftPool.map<DraftPair>((p) => ({
            pairKey: `${p.source.pageId}>${p.target.pageId}`,
            anchor: p.anchor,
            source: { url: p.source.url, title: p.source.title, h1: p.source.h1s[0] ?? null, sentences: p.source.sentences },
            target: { url: p.target.url, title: p.target.title, h1: p.target.h1s[0] ?? null },
          })),
        )
      : null;
    const draftByKey = new Map<string, DraftOutcome>((drafted?.outcomes ?? []).map((o) => [o.pairKey, o]));

    // ------------------------------------------------------------ suggestion rows
    const createdAt = iso(clock());
    const priorityJson = (p: Pair) =>
      JSON.stringify({ ...p.priority, gscLabel, explanation: explainPriority(p.priority, gscLabel) });
    const rows: LinkSuggestionRow[] = kept.map((p, i) => {
      const outcome: LinkJevOutcome | null = jev?.outcomes[i] ?? null;
      const skipped = jev?.skipped[i] ?? null;
      const sentence = (outcome && p.sentences.find((s) => s.key === outcome.sentenceKey)) || p.pick.sentence;
      const anchor = (outcome && p.anchors.find((a) => a.key === outcome.anchorKey)) || p.pick.anchor;
      const reasons = candidateReasons(p, sentence, anchor);
      if (p.anchorNote) reasons.push(p.anchorNote);
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
        ...baseRow(project, linkRunId, p, createdAt),
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
        reasons_json: JSON.stringify(reasons),
        priority_json: priorityJson(p),
        placement: "existing_sentence",
        draft_json: null,
      };
    });
    for (const p of draftPool) {
      const d = draftByKey.get(`${p.source.pageId}>${p.target.pageId}`);
      if (!d) continue;
      const reasons = [
        `${DRAFT_LABEL}: no sentence on the source page mentions the target's terms, so the writer drafted one from the source page's own text and the target's title/H1.`,
        ...(d.validation.ok ? [] : ["The draft failed validation and is not suggested:", ...d.validation.errors]),
        ...candidateReasons(p, null, null),
      ];
      const evidenceText = new Map(d.evidence.map((e) => [e.id, e.text]));
      rows.push({
        ...baseRow(project, linkRunId, p, createdAt),
        suggestion_key: suggestionKey(p.source.pageId, p.target.pageId, p.anchor),
        sentence_index: null,
        sentence_text: null,
        anchor_text: p.anchor,
        role: null,
        method: "deterministic",
        tier: null,
        should_exist: null,
        sentence_confidence: null,
        anchor_confidence: null,
        role_confidence: null,
        provider: null,
        model: null,
        question_version: null,
        policy_version: null,
        decision_record_id: null,
        status: d.validation.ok && d.text ? "review" : "rejected",
        reasons_json: JSON.stringify(reasons),
        priority_json: priorityJson(p),
        placement: "draft_sentence",
        draft_json: JSON.stringify({
          version: DRAFT_VERSION,
          text: d.text ?? "",
          label: DRAFT_LABEL,
          evidence: d.evidence,
          citedEvidenceIds: d.citedEvidenceIds,
          validation: d.validation,
          insertAfter: d.insertAfter ? (evidenceText.get(d.insertAfter) ?? null) : null,
          writer: d.writer,
        }),
      });
    }

    // ------------------------------------------------------------ carry over user_status
    const superseded = await carryOverUserStatus(db, project, rows);
    // Links the owner already placed per their imported sheet (Import page): never re-suggested as open.
    const placed = await placedLinkPairs(db, project);
    if (placed.size) {
      for (const r of rows) {
        if (r.user_status !== "open" || !placed.has(`${urlKey(r.source_url)}>${urlKey(r.target_url)}`)) continue;
        r.user_status = "implemented";
        r.status_changed_at = placed.get(`${urlKey(r.source_url)}>${urlKey(r.target_url)}`) ?? r.status_changed_at;
        r.reasons_json = JSON.stringify(["Placed per your imported sheet (Import page); kept as implemented, not re-suggested.", ...parseJson<string[]>(r.reasons_json, [])]);
      }
    }

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
    const orphanPages = graph.nodes
      .filter((n) => n.orphan)
      .slice(0, MAX_ORPHAN_PAGES)
      .map((n) => ({ pageId: n.pageId ?? n.key, url: n.url }));
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
    if (capped) noteParts.push(`pairs capped at ${maxPairs} (${pairs.length} candidate pairs; highest priorities kept)`);
    noteParts.push(computed.summary.coverageLabel);
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
    if (kept.length === 0 && draftPool.length === 0) {
      notes.push(
        analysed.length < 2
          ? `Not enough crawled pages to suggest links: the link graph has ${analysed.length} usable page${analysed.length === 1 ? "" : "s"} (${htmlPages.length} fetched with HTTP 2xx${skippedInCrawl ? `, ${skippedInCrawl} skipped by the crawl` : ""}); at least 2 are needed. Run the SEO agent again and check the crawl notes on the Runs page.`
          : "No new internal-link opportunities found in the link graph: every candidate pair already links, or no page's sentences mention another page's defining terms.",
      );
    }
    notes.push(
      `Candidates (${CANDIDATES_VERSION}): up to ${MAX_TARGETS_PER_SOURCE} targets per source from the latest snapshot of every crawled page, scored by the overlap of the source's sentence terms with the target's defining terms (TF-IDF: title x3, H1 x3, headings x2, sentences x1; top ${TOP_TERMS} terms; overlap weight at least ${MIN_BASE_SCORE}), x${ORPHAN_BOOST} for orphan targets, x${LOW_INLINK_BOOST} for targets with one inlink (legacy score adds a GSC boost of at most +${GSC_BOOST_CAP}). Cluster gaps (missing hub/spoke links) are added. Up to ${MAX_SENTENCES_PER_PAIR} sentences and ${MAX_ANCHORS_PER_PAIR} anchor phrases per pair; generic anchors are never proposed, and anchors that would worsen an over-repeated anchor are avoided. Pages that already link (directly or through a redirect or canonical), self links, and non-2xx, noindex, redirecting, non-canonical, or off-host targets are excluded.`,
    );
    notes.push(`Priority (${LINK_PRIORITY_VERSION}): relevance x Search Console impact (target impressions and position, striking distance 8–20 boosted, positions 1–3 lower; source inlinks and clicks) x 1.3 for cluster gaps; suggestions are sorted by it.${gscLabel ? ` Figures: ${gscLabel}.` : " No Search Console data: impact factors are neutral."}`);
    notes.push("Orphan and inlink counts come from the full link graph (latest snapshot of every crawled page); pages not crawled yet can still link to a page that looks orphaned.");
    if (!gsc) notes.push("No Search Console data: targets are not boosted by impressions.");
    let draftsSummary: { state: "ready" | "setup_required" | "partial" | "demo"; drafted: number; rejected: number; candidates: number; cap: number; label: string } | null = null;
    if (draftPool.length > 0) {
      if (isDemo) draftsSummary = { state: "demo", drafted: 0, rejected: 0, candidates: draftPool.length, cap: maxDrafts, label: "Demo project: the writer is never called, so no sentences are drafted." };
      else if (!writer)
        draftsSummary = {
          state: "setup_required",
          drafted: 0,
          rejected: 0,
          candidates: draftPool.length,
          cap: maxDrafts,
          label: `${draftPool.length} high-priority pair${draftPool.length === 1 ? " has" : "s have"} no sentence that mentions the target. Drafting a new sentence needs a writer: set one up on the Integrations page.`,
        };
      else {
        const ok = (drafted?.outcomes ?? []).filter((o) => o.validation.ok && o.text).length;
        const bad = (drafted?.outcomes ?? []).length - ok;
        const stop = drafted?.stoppedBy === "budget" ? ` Writer budget reached: ${drafted.skipped.length} pair(s) not drafted.` : drafted?.stoppedBy === "error" ? ` The writer failed (${drafted.error ?? "error"}); ${drafted.skipped.length} pair(s) not drafted.` : "";
        draftsSummary = {
          state: drafted?.stoppedBy ? "partial" : "ready",
          drafted: ok,
          rejected: bad,
          candidates: draftPool.length,
          cap: maxDrafts,
          label: `Drafted ${ok} sentence${ok === 1 ? "" : "s"} (${bad} rejected by validation) for the highest-priority pairs with no fitting sentence, at most ${maxDrafts} per run, in ${drafted?.calls ?? 0} writer call${drafted?.calls === 1 ? "" : "s"}. Each is labelled "${DRAFT_LABEL}".${stop}`,
        };
      }
      notes.push(draftsSummary.label);
    }

    const summary: LinkRunSummary & Record<string, unknown> = {
      orphanPages,
      genericAnchors,
      completeness,
      counts,
      pairsConsidered: pairs.length,
      pairsWithoutAnchor: withoutAnchor,
      pairsKept: kept.length,
      clusterGapPairs: gapPairs,
      drafts: draftsSummary,
      priorityVersion: LINK_PRIORITY_VERSION,
      graphLabel: computed.summary.coverageLabel,
      jev: jev ? { calls: jev.calls, asked: jev.asked, answered: jev.answered, stoppedBy: jev.stoppedBy, questionVersion: jev.questionVersion } : null,
    };
    await db.run(
      `UPDATE link_runs SET status = ?, pages_analysed = ?, pages_eligible = ?, provider = ?, model = ?, summary_json = ?, notes_json = ?, finished_at = ?
        WHERE id = ? AND workspace_id = ? AND project_id = ?`,
      jev?.stoppedBy || drafted?.stoppedBy ? "partial" : "completed",
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

/** Row fields shared by existing-sentence and drafted suggestions. */
function baseRow(project: ProjectRow, linkRunId: string, p: Pair, createdAt: string) {
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
    score: p.candidate.score,
    priority: p.priority.value,
    hub_key: p.hubKey,
    cluster_gap: p.gap,
    source_fetched_at: p.source.fetchedAt,
    user_status: "open" as const,
    status_changed_at: null as string | null,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

export function suggestionKey(sourcePageId: string, targetPageId: string, anchor: string | null): string {
  return `${sourcePageId}|${targetPageId}|${(anchor ?? "").toLowerCase().replace(/\s+/g, " ").trim()}`;
}

/**
 * Apply user statuses from earlier runs: the latest non-open status for the same suggestion_key wins;
 * otherwise a dismissed source/target pair stays dismissed even if the anchor changed. Returns the ids
 * of earlier rows whose status now lives on a new row. The time the owner set the status travels with it.
 */
async function carryOverUserStatus(db: Db, project: ProjectRow, rows: LinkSuggestionRow[]): Promise<Set<string>> {
  const prior = await db.all<{ id: string; suggestion_key: string; source_page_id: string; target_page_id: string; user_status: LinkSuggestionRow["user_status"]; changed: string | null }>(
    `SELECT id, suggestion_key, source_page_id, target_page_id, user_status, COALESCE(status_changed_at, updated_at) AS changed FROM link_suggestions
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
      r.status_changed_at = exact.changed;
      for (const id of allByKey.get(r.suggestion_key) ?? []) superseded.add(id);
      continue;
    }
    const pair = dismissedPair.get(`${r.source_page_id}|${r.target_page_id}`);
    if (pair) {
      r.user_status = "dismissed";
      r.status_changed_at = pair.changed;
    }
  }
  return superseded;
}

function insertRow(r: LinkSuggestionRow): [string, ...unknown[]] {
  const keys = Object.keys(r) as Array<keyof LinkSuggestionRow>;
  return [`INSERT INTO link_suggestions (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`, ...keys.map((k) => r[k])];
}

/** Re-exported for the SEO agent (seo/recommend/inputs.ts reads it from report.ts). */
export { topLinkSuggestionsForAgent } from "./report";
