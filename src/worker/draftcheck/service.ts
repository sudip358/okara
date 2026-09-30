/**
 * [A23] Draft / page quality check (madewithjev "Jev for SEO and GEO" workflow): paste a draft or pick a
 * crawled page, plus a target query. Returns the 16 per-page on-page checklist items evaluated against
 * it, deterministic flags (guarantees, testimonials, filler, unsupported claims), optional Jev answers,
 * and a pass / needs_review / fail verdict.
 *
 * It is a quality gate before human review: never an AI-authorship detector, never a ranking or citation
 * prediction. Nothing is fetched and nothing is stored except decision_records for Jev questions.
 *
 * Pipeline:
 *  1. Subject: a synthetic snapshot built from the parsed draft (parse.ts; evaluated as an article page,
 *     status 200 by construction, on a synthetic URL of the project host), or the latest snapshot of a
 *     crawled page (workspace- and project-scoped; verified or demo projects only).
 *  2. Items: the checklist's own per-page evaluators (checklists/items/page.ts) with the target query as
 *     the page's only query. Items that need the published page (URL, inbound links, HTTP status /
 *     indexability / canonical, structured data + viewport + CWV) are overridden to `unknown` for drafts,
 *     except what the draft itself shows (outgoing internal links, a pasted noindex).
 *  3. Flags: flags.ts (rules). Jev (jev.ts): one batched call for five items + suspicious excerpts, when
 *     TypeSafe is configured, the project is not a demo, and the subject could be measured.
 *  4. Verdict (VERDICT_RULES_VERSION):
 *       fail          any CRITICAL_ITEMS item not_met by a non-manual method (deterministic or Jev act),
 *                     or any fabricated_testimonial / guarantee_language flag;
 *       needs_review  any other flag, any Jev flag-tier answer, or a subject that could not be measured
 *                     (page without a snapshot);
 *       pass          otherwise (items may still be partial; the label says how many need attention).
 */
import type { CapabilityState, Checklist, ChecklistItem, DraftCheckFlag, DraftCheckResult, PageType } from "@shared/types";
import { EMPTY_GEO, crawlAllowed, loadCrawl, loadGsc, projectInfo, SNAPSHOT_COLUMNS, toSnap, type ChecklistData, type GscRow, type Snap, type SnapshotRow } from "../checklists/data";
import { PAGE_ITEMS, type PageContext } from "../checklists/items/page";
import { CHECKLIST_VERSION, countStatuses, DISCLAIMER, evaluateItem, sortItems } from "../checklists/registry";
import { Signals, THRESHOLDS } from "../checklists/signals";
import { DEMO_LABEL } from "../demo/fixtures";
import type { Db } from "../lib/db";
import { parseJson } from "../lib/db";
import { notFound } from "../lib/errors";
import { sha256Hex } from "../lib/hash";
import { iso, type Clock } from "../lib/time";
import type { ProjectRow } from "../platform/access";
import type { DecisionProvider } from "../providers/types";
import { POLICY_VERSION } from "../runs/policy";
import { scanFlags, FLAG_RULES_VERSION, type FlagScan } from "./flags";
import { askDraftJev, DRAFTCHECK_QUESTIONS_REVISION, ITEM_QUESTIONS, type DraftJevRun, type ItemQuestionKey } from "./jev";
import { parseDraft, type DraftBlock, type DraftDoc } from "./parse";

export const VERDICT_RULES_VERSION = "draftcheck-verdict-2026-09-30.1";
export const LABEL_GATE = "A quality gate before human review — not an AI detector and not a ranking prediction.";
export const LABEL_FLAGS = "Flags mark wording to verify, support, or cut before publishing. They never judge who or what wrote the text.";
/** Drafts have no page type; they are evaluated as article pages (the usual shape of a written draft). */
export const DRAFT_PAGE_TYPE: PageType = "article";

/** Items whose measured failure blocks the draft: intent and crawlability/indexability. */
export const CRITICAL_ITEMS: readonly string[] = [
  "page.before_write.search_intent",
  "page.while_write.answer_early",
  "page.while_write.crawlable_text",
  "page.publish_check.indexability",
];
const BLOCKING_FLAGS: ReadonlySet<DraftCheckFlag["kind"]> = new Set(["fabricated_testimonial", "guarantee_language"]);

export interface DraftCheckInput {
  targetQuery: string;
  pageId?: string | undefined;
  draftText?: string | undefined;
  title?: string | undefined;
  metaDescription?: string | undefined;
}

export interface DraftCheckDeps {
  db: Db;
  project: ProjectRow;
  /** null = TypeSafe not configured for this workspace. Ignored for demo projects. */
  decisions: DecisionProvider | null;
  now: Date;
  clock?: Clock;
}

interface Subject {
  mode: "draft" | "page";
  ctx: PageContext;
  data: ChecklistData;
  blocks: DraftBlock[];
  doc: DraftDoc | null;
  state: CapabilityState;
  measurable: boolean;
  /** Stable identity of what was checked (for the decision_records candidate key). */
  identity: string;
  note: string;
  labels: string[];
  page: Checklist["page"];
}

const emptyGsc: ChecklistData["gsc"] = { connection: null, sync: null, rows: [] };
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const targetRow = (query: string, url: string): GscRow => ({ window: "current", query, page: url, device: null, clicks: 0, impressions: 0, position: 0 });

function projectHost(p: ProjectRow): string {
  if (p.verified_host) return p.verified_host;
  try {
    return new URL(p.site_url).hostname.toLowerCase();
  } catch {
    return "example.invalid";
  }
}

// ------------------------------------------------------------------ subjects
function draftSubject(input: DraftCheckInput, project: ProjectRow, now: Date): Subject {
  const host = projectHost(project);
  const url = `https://${host}/draft-preview`;
  const doc = parseDraft(input.draftText ?? "", url);
  const title = input.title?.trim() || doc.html?.title || null;
  const meta = input.metaDescription?.trim() || doc.html?.metaDescription || null;
  const snap: Snap = {
    pageId: "draft",
    url,
    pageType: DRAFT_PAGE_TYPE,
    statusCode: 200, // synthetic: the draft is text by construction; HTTP status is checked after publishing
    finalUrl: url,
    skippedReason: null,
    title,
    metaDescription: meta,
    h1s: doc.h1s,
    headings: doc.headings,
    canonical: doc.html?.canonical ?? null,
    robotsMeta: doc.html?.robotsMeta ?? null,
    jsonLdTypes: doc.html?.jsonLdTypes ?? [],
    jsonLdIssues: [],
    internalLinks: doc.internalLinks,
    wordCount: doc.wordCount,
    firstParagraph: doc.firstParagraph,
    excerpt: doc.text, // the whole draft (not the crawler's 2,000-character cap)
    author: doc.html?.author ?? null,
    lastUpdated: null,
    outboundCitations: doc.outboundLinks.length,
    tableCount: doc.tableCount,
    imagesTotal: doc.imagesTotal,
    imagesMissingAlt: doc.imagesMissingAlt,
    viewport: null,
    breadcrumbNav: null,
    genericAnchors: doc.genericAnchors,
    crawlRunId: "draft",
    fetchedAt: iso(now),
  };
  const data: ChecklistData = { now, project: projectInfo(project), crawl: null, snapshots: [], findings: [], gsc: emptyGsc, geo: EMPTY_GEO, decisions: [], pillars: null };
  const note = `Pasted draft parsed as ${doc.format === "html" ? "HTML" : "markdown/plain text"}: ${plural(doc.wordCount, "word")}, ${plural(doc.headings.length, "heading")}, ${plural(doc.tableCount, "table")}, ${plural(doc.internalLinks.length, "internal link")}, ${plural(doc.outboundLinks.length, "outbound link")}.`;
  const labels = [
    note,
    `Drafts are evaluated as an ${DRAFT_PAGE_TYPE} page. URL, inbound links, HTTP status, indexability, canonical, structured data, and Core Web Vitals are checked after publishing: pick the crawled page here once it is live.`,
  ];
  if (input.title?.trim() === undefined || !input.title?.trim()) {
    if (!title) labels.push("No title was given; enter the planned title tag to check it.");
  }
  return {
    mode: "draft",
    ctx: { sig: new Signals(data), page: { id: "draft", url, pageType: DRAFT_PAGE_TYPE }, snap, queries: [targetRow(input.targetQuery, url)], intent: null },
    data,
    blocks: doc.blocks,
    doc,
    state: project.is_demo === 1 ? "demo" : "ready",
    measurable: true,
    identity: `draft\n${input.draftText ?? ""}\n${title ?? ""}\n${meta ?? ""}`,
    note,
    labels,
    page: null,
  };
}

async function pageSubject(input: DraftCheckInput, db: Db, project: ProjectRow, now: Date): Promise<Subject> {
  const ws = project.workspace_id;
  const pid = project.id;
  const page = await db.first<{ id: string; url: string; page_type: PageType }>(
    "SELECT id, url, page_type FROM pages WHERE workspace_id = ? AND project_id = ? AND id = ?",
    ws,
    pid,
    input.pageId!,
  );
  if (!page) throw notFound("Page");
  const row = crawlAllowed(project)
    ? await db.first<SnapshotRow & { link_context_json: string | null; snapshot_id: string }>(
        `SELECT ${SNAPSHOT_COLUMNS}, s.link_context_json, s.id AS snapshot_id
           FROM page_snapshots s JOIN pages p ON p.id = s.page_id AND p.workspace_id = s.workspace_id
          WHERE s.workspace_id = ? AND s.project_id = ? AND s.page_id = ?
          ORDER BY s.fetched_at DESC, s.rowid DESC LIMIT 1`,
        ws,
        pid,
        page.id,
      )
    : null;
  const base = row ? toSnap(row) : null;
  const snap: Snap | null = base
    ? { ...base, title: input.title?.trim() || base.title, metaDescription: input.metaDescription?.trim() || base.metaDescription }
    : null;
  const [crawl, gsc] = await Promise.all([
    snap ? loadCrawl(db, ws, pid, snap.crawlRunId) : Promise.resolve({ crawl: null, snapshots: [], findings: [] }),
    loadGsc(db, ws, pid),
  ]);
  const data: ChecklistData = { now, project: projectInfo(project), crawl: crawl.crawl, snapshots: crawl.snapshots, findings: crawl.findings, gsc, geo: EMPTY_GEO, decisions: [], pillars: null };

  // Flag scan text: headings, the stored excerpt (first 2,000 characters), and stored link-context sentences.
  const blocks: DraftBlock[] = [];
  if (snap) {
    for (const h of snap.headings) blocks.push({ kind: "heading", text: h.text, hasSource: false });
    const excerpt = snap.excerpt ?? snap.firstParagraph ?? "";
    if (excerpt.trim()) blocks.push({ kind: "paragraph", text: excerpt, hasSource: false });
    for (const s of parseJson<unknown[]>(row?.link_context_json ?? "[]", [])) {
      if (typeof s === "string" && s.trim() && !excerpt.includes(s.replace(/…$/, ""))) blocks.push({ kind: "paragraph", text: s, hasSource: false });
    }
  }
  const labels: string[] = [];
  const note = snap
    ? `Crawled page ${page.url}, snapshot from ${snap.fetchedAt.slice(0, 16).replace("T", " ")} UTC (compact extraction: title, meta, headings, first paragraph, 2,000-character excerpt, links).`
    : `Crawled page ${page.url} has no crawl snapshot${crawlAllowed(project) ? "" : " (site ownership is not verified)"}.`;
  labels.push(note);
  if (snap) {
    labels.push(
      "Flags on a crawled page are scanned on the stored excerpt and link-context sentences only, and link targets are not stored per sentence: a flagged claim may already link a source on the live page.",
    );
    if (input.title?.trim() || input.metaDescription?.trim()) labels.push("The title and/or meta description you entered replace the crawled ones for this check.");
  } else {
    labels.push(crawlAllowed(project) ? "Run an SEO crawl of the verified site to measure this page." : "Verify site ownership, then run an SEO crawl to measure this page.");
  }
  const state: CapabilityState = project.is_demo === 1 ? "demo" : snap ? "ready" : "setup_required";
  return {
    mode: "page",
    ctx: { sig: new Signals(data), page: { id: page.id, url: page.url, pageType: page.page_type }, snap, queries: [targetRow(input.targetQuery, page.url)], intent: null },
    data,
    blocks,
    doc: null,
    state,
    measurable: !!snap,
    identity: `page\n${page.id}\n${row?.snapshot_id ?? "none"}\n${snap?.title ?? ""}\n${snap?.metaDescription ?? ""}`,
    note,
    labels,
    page: { id: page.id, url: page.url, pageType: page.page_type, snapshotAt: snap?.fetchedAt ?? null, topQuery: input.targetQuery },
  };
}

// ------------------------------------------------------------------ item wording and draft overrides
/** The page evaluators speak of "top GSC queries"; here the target query plays that role. */
export function rephrase(text: string, mode: "draft" | "page"): string {
  const where = mode === "draft" ? "the draft's title, headings, or text" : "the page's title, headings, or opening text";
  let t = text
    .replace(/(\d+) of (\d+) top GSC queries for this page have most of their words in its title, headings, or opening text\./g, (_m, a: string, b: string) =>
      a === b ? `The target query has most of its words in ${where}.` : `The target query does not have most of its words in ${where}.`,
    )
    .replace(/Top GSC query/g, "The target query")
    .replace(/this page's top GSC queries appear in its title, headings, or opening text/g, `the target query appear in ${where}`)
    .replace(/this page's top GSC queries/g, "the target query")
    .replace(/\btop query\b/g, "target query")
    .replace(/No Jev intent judgment is available for this page\./g, "")
    .replace(/this is a article page/g, "this is an article page");
  if (mode === "draft") {
    t = t
      .replace(/this is an? (\w+) page/g, "the draft is evaluated as an $1 page")
      .replace(/in the served HTML/g, "in the draft")
      .replace(/the stored extract \(title, headings, first 2,000 characters\)/g, "the draft's title, headings, and text")
      .replace(/on the stored extract only/g, "on the draft's title, headings, and text")
      .replace(/Headings are read from server-delivered HTML \(first 60\)\./g, "Headings are read from the draft (markdown # lines or HTML h1-h6, first 60).")
      .replace(/^The page has no /, "The draft has no ");
  }
  return t.replace(/\s{2,}/g, " ").trim();
}

function reword(item: ChecklistItem, mode: "draft" | "page", subjectNote: string): ChecklistItem {
  const out: ChecklistItem = {
    ...item,
    summary: rephrase(item.summary, mode),
    caveat: item.caveat ? rephrase(item.caveat, mode) || null : null,
    evidence: item.evidence.map((e) => ({ ...e, detail: e.detail ? rephrase(e.detail, mode) : e.detail ?? null })),
    manual: null, // draft checks are not stored, so nothing is checked off here
  };
  const queryItems = ["page.before_write.search_intent", "page.before_write.topic_coverage", "page.while_write.terms_entities", "page.while_write.answer_early"];
  if (mode === "draft" || queryItems.includes(item.id)) out.completeness = { note: subjectNote, covered: null, total: null };
  return out;
}

function draftOverride(item: ChecklistItem, doc: DraftDoc, host: string): ChecklistItem {
  switch (item.id) {
    case "page.details.url":
      return { ...item, status: "unknown", method: "heuristic", summary: "A pasted draft has no URL yet, so the URL cannot be checked.", evidence: [], caveat: "Check the slug when you publish.", links: [] };
    case "page.publish_check.internal_links": {
      const n = doc.internalLinks.length;
      const generic = doc.genericAnchors;
      return {
        ...item,
        status: n === 0 ? "not_met" : generic.length > 0 ? "partial" : "met",
        method: "measured",
        summary:
          n === 0
            ? `The draft has no links to other pages on ${host}.`
            : `The draft links to ${plural(n, "page")} on ${host}; ${generic.length ? `${plural(generic.length, "link")} use generic anchor text` : "no generic anchor text"}.`,
        evidence: [
          ...generic.slice(0, 3).map((g) => ({ label: `Generic anchor "${g.text}"`, url: g.href, detail: null })),
          ...doc.internalLinks.slice(0, 2).map((u) => ({ label: "Links to", url: u, detail: null })),
        ],
        caveat: "Only the draft's own outgoing links are counted. Links pointing to this page from other pages are checked after publishing (pick the crawled page).",
      };
    }
    case "page.publish_check.indexability": {
      const robots = doc.html?.robotsMeta ?? "";
      if (/\b(noindex|none)\b/.test(robots)) {
        return { ...item, status: "not_met", method: "measured", summary: `The pasted HTML declares noindex ("${robots}").`, evidence: [], caveat: "Remove noindex if this page should appear in search." };
      }
      return {
        ...item,
        status: "unknown",
        method: "measured",
        summary: "HTTP status, crawlability, indexability, and canonical can only be checked on the published URL.",
        evidence: [],
        caveat: "After publishing, run a crawl and check the crawled page here. Crawlability is not index status.",
      };
    }
    case "page.publish_check.structured_data_ux": {
      const types = doc.html?.jsonLdTypes ?? [];
      return {
        ...item,
        status: "unknown",
        method: "measured",
        summary: `Structured data, the mobile viewport, and Core Web Vitals belong to the published page and its template${types.length ? `; JSON-LD types in the pasted HTML: ${types.join(", ")}` : ""}. Core Web Vitals: not connected.`,
        evidence: [],
        caveat: "Checked on the crawled page after publishing. Structured data never guarantees rich results.",
      };
    }
    case "page.before_write.first_hand":
      return /^No declared author/.test(item.summary) ? { ...item, summary: "First-hand experience cannot be measured automatically; check the draft yourself." } : item;
    default:
      return item;
  }
}

// ------------------------------------------------------------------ Jev mapping
const JEV_PHRASE: Record<ItemQuestionKey, string> = {
  answer_early: "the opening paragraph answers the target query directly",
  topic_coverage: "the text covers the subtopics searchers for the target query expect",
  unique_angle: "the text contains original information or a distinct angle",
  first_hand: "the text shows first-hand experience",
  terms_entities: "the text uses the relevant terms and entities naturally",
};
const JEV_CAVEAT = "A Jev model judgment on the text (a Noul yes-probability tiered by the decision policy), not a measurement. It never predicts rankings or citations.";

export function applyJevToItem(item: ChecklistItem, a: DraftJevRun["items"][number], run: Pick<DraftJevRun, "provider" | "model" | "status">): ChecklistItem {
  const wasManual = item.method === "manual";
  if (a.noul === null || a.tier === null) {
    const why = run.status === "answered" ? " Jev returned no usable answer for this item." : "";
    return why ? { ...item, summary: `${item.summary}${why}` } : item;
  }
  if (a.tier === "drop") return { ...item, summary: `${item.summary} Jev's answer was below the review threshold and is withheld.` };
  const yes = a.noul >= 0.5;
  const p = a.noul.toFixed(2);
  const phrase = JEV_PHRASE[a.key];
  const summary =
    a.tier === "act"
      ? `Jev judgment on whether ${phrase}: ${yes ? "yes" : "no"} (yes-probability ${p}).`
      : `Check this yourself: Jev leaned ${yes ? "yes" : "no"} on whether ${phrase} (yes-probability ${p}).`;
  return {
    ...item,
    status: a.tier === "act" ? (yes ? "met" : "not_met") : "partial",
    method: "heuristic",
    summary: wasManual ? summary : `${summary} Word check: ${item.summary}`,
    evidence: [
      { label: `Jev ${a.questionId}`, url: null, detail: `yes-probability ${p}; tier ${a.tier}; ${run.provider ?? "typesafe"}${run.model ? ` ${run.model}` : ""}; ${POLICY_VERSION}` },
      ...item.evidence,
    ].slice(0, 5),
    caveat: item.caveat ? `${JEV_CAVEAT} ${item.caveat}` : JEV_CAVEAT,
    manual: null,
  };
}

/** Jev excerpt answers become flags when act-tier yes, or flag-tier leaning yes ("Check this yourself"). */
export function jevClaimFlags(run: DraftJevRun, existing: readonly DraftCheckFlag[]): DraftCheckFlag[] {
  const out: DraftCheckFlag[] = [];
  for (const c of run.claims) {
    if (c.noul === null || c.tier === null || c.tier === "drop") continue;
    if (c.noul < 0.5 || (c.tier === "act" && c.noul < 0.8)) continue;
    if (existing.some((f) => f.text === c.excerpt) || out.some((f) => f.text === c.excerpt)) continue;
    out.push({ kind: "unsupported_claim", text: c.excerpt, method: "jev", noul: c.noul });
  }
  return out;
}

// ------------------------------------------------------------------ verdict
export function decideVerdict(
  items: readonly ChecklistItem[],
  flags: readonly DraftCheckFlag[],
  opts: { jevFlagTier: boolean; measurable: boolean },
): { verdict: DraftCheckResult["verdict"]; reason: string } {
  const blockingItems = items.filter((i) => CRITICAL_ITEMS.includes(i.id) && i.status === "not_met" && i.method !== "manual");
  const blockingFlags = flags.filter((f) => BLOCKING_FLAGS.has(f.kind));
  if (blockingItems.length || blockingFlags.length) {
    const parts = [
      ...blockingItems.map((i) => `"${i.label}" is not met`),
      ...(blockingFlags.some((f) => f.kind === "guarantee_language") ? [plural(blockingFlags.filter((f) => f.kind === "guarantee_language").length, "guarantee-language flag")] : []),
      ...(blockingFlags.some((f) => f.kind === "fabricated_testimonial") ? [plural(blockingFlags.filter((f) => f.kind === "fabricated_testimonial").length, "testimonial without evidence", "testimonials without evidence")] : []),
    ];
    return { verdict: "fail", reason: `Fail: ${parts.join("; ")}. Fix these before human review.` };
  }
  if (!opts.measurable) return { verdict: "needs_review", reason: "Needs review: the page could not be measured (no crawl snapshot), so nothing was checked against it." };
  if (flags.length || opts.jevFlagTier) {
    const parts = [flags.length ? `${plural(flags.length, "flag")} to verify` : null, opts.jevFlagTier ? "Jev answers marked \"Check this yourself\"" : null].filter(Boolean);
    return { verdict: "needs_review", reason: `Needs review: ${parts.join("; ")}.` };
  }
  const attention = items.filter((i) => i.status === "not_met" || i.status === "partial").length;
  return {
    verdict: "pass",
    reason: `Pass: no blocking item or flag found${attention ? `; ${plural(attention, "checklist item")} still need${attention === 1 ? "s" : ""} attention` : ""}. A person still reviews the draft before publishing.`,
  };
}

// ------------------------------------------------------------------ main
export async function runDraftCheck(input: DraftCheckInput, deps: DraftCheckDeps): Promise<DraftCheckResult> {
  const { db, project, now } = deps;
  const clock = deps.clock ?? (() => now);
  const isDemo = project.is_demo === 1;
  const subject = input.pageId ? await pageSubject(input, db, project, now) : draftSubject(input, project, now);
  const host = projectHost(project);

  // Items.
  let items = PAGE_ITEMS.map((def) => evaluateItem(def, subject.ctx, undefined, "page")).map((i) => reword(i, subject.mode, subject.note));
  if (subject.mode === "draft" && subject.doc) items = items.map((i) => draftOverride(i, subject.doc!, host));

  // Flags.
  const scan: FlagScan = subject.measurable ? scanFlags(subject.blocks) : { flags: [], jevCandidates: [], sentences: 0 };
  let flags = scan.flags;

  // Jev.
  const labels: string[] = [LABEL_GATE, LABEL_FLAGS];
  let run: DraftJevRun | null = null;
  let jevUsed = false;
  const decisions = isDemo ? null : deps.decisions;
  if (decisions && subject.measurable) {
    const snap = subject.ctx.snap!;
    const hash = (await sha256Hex(`${input.targetQuery}\n${subject.identity}`)).slice(0, 16);
    run = await askDraftJev(
      {
        targetQuery: input.targetQuery,
        title: snap.title,
        metaDescription: snap.metaDescription,
        headings: snap.headings,
        opening: snap.firstParagraph,
        text: subject.blocks.filter((b) => b.kind !== "code").map((b) => b.text).join("\n"),
        wordCount: snap.wordCount ?? 0,
        claims: scan.jevCandidates,
      },
      { decisions, db, workspaceId: project.workspace_id, projectId: project.id, candidateKey: `draftcheck:${hash}`, clock },
    );
    jevUsed = run.status === "answered" && run.answered > 0;
    const byItem = new Map(run.items.map((a) => [a.itemId, a]));
    items = items.map((i) => {
      const a = byItem.get(i.id);
      return a ? applyJevToItem(i, a, run!) : i;
    });
    flags = [...flags, ...jevClaimFlags(run, flags)];
  }

  // Verdict.
  const jevFlagTier = !!run && (run.items.some((a) => a.tier === "flag") || run.claims.some((c) => c.tier === "flag"));
  const { verdict, reason } = decideVerdict(items, flags, { jevFlagTier, measurable: subject.measurable });
  labels.push(reason);
  labels.push(...subject.labels);

  // Jev and method labels.
  if (run) {
    if (run.status === "budget") labels.push("Jev budget reached: this project's daily Jev call limit is used up, so this check is deterministic only.");
    else if (run.status === "error") labels.push("Jev could not be reached, so this check is deterministic only.");
    else if (run.asked > 0)
      labels.push(
        `Jev (${run.provider ?? decisions!.name}${run.model ? `, model ${run.model}` : ""}) answered ${run.answered} of ${run.asked} questions in one call: ${Object.keys(ITEM_QUESTIONS).length} checklist items where their inputs exist, plus ${plural(run.claims.length, "unsourced excerpt")}. Act = used; Flag = "Check this yourself"; below the review threshold = withheld. Policy ${POLICY_VERSION}; ${DRAFTCHECK_QUESTIONS_REVISION}.`,
      );
  } else if (isDemo) {
    labels.push(`${DEMO_LABEL}: Jev is not called on demo projects; deterministic checks only.`);
  } else if (!subject.measurable) {
    labels.push("Jev was not asked because there is nothing to judge yet.");
  } else {
    labels.push("Jev (TypeSafe) is not configured for this workspace: deterministic checks only. Originality, first-hand experience, and topic completeness stay manual.");
  }
  if (subject.measurable) {
    labels.push(
      `Flag rules ${FLAG_RULES_VERSION} scanned ${plural(scan.sentences, "sentence")}. Claims count as sourced when their paragraph has a link, a URL, a citation marker such as [1], or "according to" a named source. Verdict ${VERDICT_RULES_VERSION}; minimum ${THRESHOLDS.thinWords} words for article text.`,
    );
  }

  const ordered = sortItems("page", items);
  const checklist: Checklist = {
    kind: "page",
    page: subject.page,
    state: subject.state,
    checklistVersion: CHECKLIST_VERSION,
    generatedAt: now.toISOString(),
    sources: {
      crawlRunId: subject.mode === "page" ? (subject.ctx.snap?.crawlRunId ?? null) : null,
      crawledAt: subject.mode === "page" ? (subject.ctx.snap?.fetchedAt ?? null) : null,
      gscSyncedAt: subject.data.gsc.sync?.syncedAt ?? null,
      geoObservations: 0,
    },
    counts: countStatuses(ordered),
    items: ordered,
    disclaimer: DISCLAIMER,
  };
  return { state: subject.state, verdict, checklist, flags, jevUsed, labels };
}
