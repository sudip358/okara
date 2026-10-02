/**
 * Rewrite plans (docs/api.md "GET /projects/:pid/geo/rewrite-plans"): a manual checklist per page that
 * has an open or approved GEO recommendation targeting it (url targets, and example URLs of template
 * targets) or an approved competitor page with verdict 'adapt' (our matched page). Read-only: stored
 * data only, no Jev, no budget. Nothing is ever published: `publishing` is always "manual".
 *
 * Items: measured from the latest crawl snapshot where possible (answer_first, faq, compare_table,
 * internal_links, author, schema; ticked 'done' when the crawl shows it, 'todo' when it does not,
 * 'unknown' when the signal was not collected); manual otherwise (read_winning_page, map_question,
 * indexnow: status 'unknown' with "Check this yourself", or 'not_applicable' when there is nothing to
 * check). IndexNow is always optional and labelled "Bing and participating engines, not Google".
 * Metrics are measured only: GSC clicks/impressions of the latest sync's current window for the page
 * (null without GSC) and stored API-sampled answers citing the page in the same window (null without
 * GEO data). No projected traffic, conversions, revenue, rankings, or citations.
 */
import type { BoardLaneProviderId, DateWindow, FactorStatus, GeoEngineProviderId, RewritePlan, RewritePlanItem, RewritePlanItemKey, RewritePlansResponse, SkipFactor } from "@shared/types";
import type { Db } from "../lib/db";
import { parseJson } from "../lib/db";
import type { ProjectRow } from "../platform/access";
import { addDays, utcDay } from "../lib/time";
import { brandTokenSet, computeAnswerCoverage } from "../coverage/answer-coverage";
import { DEMO_LABEL, inChunks, loadGscPageData, pageKey } from "../coverage/common";
import { isSelfHost } from "../coverage/geo-data";
import { resolveCitationHost, selfDomains } from "./detect";
import { canonicalExternalUrl, citationUses, type CompetitorExtraction } from "./competitor-pages";
import { evaluateFactors, inlinkCache, loadOurPagesEvidence } from "./skip-factors";
import { BOARD_LANES } from "./board";
import { isCustomGeoId } from "./custom-lanes";

export const REWRITE_PLAN_VERSION = "rewrite-plan-2026-09-30.1";
export const MAX_PLANS = 50;
export const INDEXNOW_LABEL = "Submit to IndexNow (Bing and participating engines, not Google) · optional";
const TEMPLATE_EXAMPLES = 5;
const CHECK_YOURSELF = "Check this yourself";

export const REWRITE_PLAN_LABELS = {
  manual: "Manual plan · Publishing: manual (not connected)",
  measured: "Items are ticked from the latest crawl where the crawl can show them; the rest are for you to check.",
  noProjection: "Practices, not guarantees. No projected traffic, revenue, rankings or citations are shown.",
  adapt: "Adapt the structure of cited pages; never copy their text.",
} as const;

const ITEM_LABELS: Record<RewritePlanItemKey, string> = {
  read_winning_page: "Read the cited page",
  map_question: "Map the question to this page",
  answer_first: "Answer the question first",
  faq: "FAQ section with FAQPage markup",
  compare_table: "Comparison table",
  internal_links: "Internal links to this page",
  author: "Author byline",
  schema: "Structured data",
  indexnow: INDEXNOW_LABEL,
};

interface RecRow {
  id: string;
  target_json: string;
  priority: number;
  created_at: string;
}

interface Candidate {
  pageId: string;
  url: string;
  recommendationId: string | null;
  priority: number;
  assessment: { id: string; url: string; question: string | null; provider: string | null } | null;
}

function statusOf(s: FactorStatus): RewritePlanItem["status"] {
  return s === "present" ? "done" : s === "unknown" ? "unknown" : "todo";
}

function measuredItem(key: RewritePlanItemKey, f: SkipFactor | undefined, crawlDay: string | null): RewritePlanItem {
  if (!f) return { key, label: ITEM_LABELS[key], status: "unknown", evidence: "Not collected by the crawl", method: "measured", optional: false };
  return { key, label: ITEM_LABELS[key], status: statusOf(f.status), evidence: `${f.measured}${crawlDay ? ` (crawl of ${crawlDay})` : ""}`, method: "measured", optional: false };
}

function asEngine(p: string | null | undefined): BoardLaneProviderId | null {
  if (p && (BOARD_LANES as readonly string[]).includes(p)) return p as GeoEngineProviderId;
  // A custom GEO engine lane: its citations exist only for grounded answers (provider-reported sources).
  return isCustomGeoId(p) ? p : null;
}

/** Default window when there is no GSC: the 28 days ending yesterday (UTC). */
function defaultWindow(now: Date): DateWindow {
  const end = addDays(utcDay(now), -1);
  return { start: addDays(end, -27), end };
}

export async function buildRewritePlans(db: Db, project: ProjectRow, now: Date): Promise<RewritePlansResponse> {
  const ws = project.workspace_id;
  const pid = project.id;
  const generatedAt = now.toISOString();
  const labels: string[] = [];
  if (project.is_demo) labels.push(DEMO_LABEL);
  labels.push(REWRITE_PLAN_LABELS.manual, REWRITE_PLAN_LABELS.measured, REWRITE_PLAN_LABELS.adapt, REWRITE_PLAN_LABELS.noProjection);

  const [recs, pageRows, adapts] = await Promise.all([
    db.all<RecRow>(
      `SELECT id, target_json, priority, created_at FROM recommendations
        WHERE workspace_id = ? AND project_id = ? AND agent = 'geo' AND status IN ('open', 'approved')
        ORDER BY priority DESC, created_at DESC LIMIT 500`,
      ws,
      pid,
    ),
    db.all<{ id: string; url: string }>("SELECT id, url FROM pages WHERE workspace_id = ? AND project_id = ?", ws, pid),
    db.all<{ id: string; url: string; extraction_json: string }>(
      `SELECT id, url, extraction_json FROM competitor_pages
        WHERE workspace_id = ? AND project_id = ? AND status = 'assessed' AND verdict = 'adapt' ORDER BY approved_at DESC LIMIT 200`,
      ws,
      pid,
    ),
  ]);
  const pageByKey = new Map<string, { id: string; url: string }>();
  for (const p of pageRows) {
    const k = pageKey(p.url);
    if (k && !pageByKey.has(k)) pageByKey.set(k, p);
  }

  const candidates = new Map<string, Candidate>();
  const add = (url: string, recommendationId: string | null, priority: number, assessment: Candidate["assessment"]) => {
    const k = pageKey(url);
    const page = k ? pageByKey.get(k) : undefined;
    if (!page) return;
    const cur = candidates.get(page.id);
    if (!cur) candidates.set(page.id, { pageId: page.id, url: page.url, recommendationId, priority, assessment });
    else {
      if (!cur.recommendationId && recommendationId) cur.recommendationId = recommendationId;
      cur.priority = Math.max(cur.priority, priority);
      if (!cur.assessment && assessment) cur.assessment = assessment;
    }
  };
  for (const r of recs) {
    const t = parseJson<{ kind?: string; url?: string; exampleUrls?: unknown[] }>(r.target_json, {});
    if (t.kind === "url" && typeof t.url === "string") add(t.url, r.id, r.priority, null);
    else if (t.kind === "template" && Array.isArray(t.exampleUrls)) {
      for (const u of t.exampleUrls.slice(0, TEMPLATE_EXAMPLES)) if (typeof u === "string") add(u, r.id, r.priority, null);
    }
  }
  // Engine of the newest API-sampled answer citing each adapt page: one chunked lookup for all of them
  // (citationUses: joins on workspace_id + project_id, compares canonical URLs in code).
  const adaptX = adapts.map((a) => ({ a, x: parseJson<Partial<CompetitorExtraction>>(a.extraction_json, {}) })).filter((r) => !!r.x.ourPage?.url);
  const adaptUrls = [...new Set(adaptX.map((r) => canonicalExternalUrl(r.a.url)).filter((u): u is string => !!u))];
  const uses = adaptUrls.length > 0 ? await citationUses(db, ws, pid, adaptUrls) : new Map<string, Array<{ provider: string }>>();
  for (const { a, x } of adaptX) {
    const k = canonicalExternalUrl(a.url);
    const provider = k ? (uses.get(k)?.[0]?.provider ?? null) : null;
    add(x.ourPage!.url!, null, 0, { id: a.id, url: a.url, question: x.question ?? null, provider });
  }

  if (candidates.size === 0) {
    return { state: project.is_demo ? "demo" : "ready", generatedAt, plans: [], labels: [...labels, "No page has an open GEO recommendation or an 'adapt' cited page yet."] };
  }

  const [coverage, gsc] = await Promise.all([computeAnswerCoverage(db, project, now), loadGscPageData(db, ws, pid)]);
  const promptByPage = new Map<string, { promptId: string; text: string }>();
  for (const m of coverage.matches) if (m.pageId && !promptByPage.has(m.pageId)) promptByPage.set(m.pageId, { promptId: m.promptId, text: m.text });
  const window: DateWindow = gsc?.window ?? defaultWindow(now);

  // Stored API answers citing our pages within the window (self citations only).
  const obs = await db.all<{ id: string }>(
    `SELECT id FROM geo_observations WHERE workspace_id = ? AND project_id = ? AND measurement_type = 'api' AND status = 'ok'
        AND created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT 2000`,
    ws,
    pid,
    `${window.start}T00:00:00.000Z`,
    `${addDays(window.end, 1)}T00:00:00.000Z`,
  );
  const anyGeo = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM geo_observations WHERE workspace_id = ? AND project_id = ? AND measurement_type = 'api'", ws, pid);
  const domains = selfDomains(project);
  const citeRows = await inChunks(
    obs.map((o) => o.id),
    (chunk, ph) =>
      db.all<{ observation_id: string; url: string; title: string | null }>(
        `SELECT observation_id, url, title FROM geo_citations WHERE workspace_id = ? AND project_id = ? AND observation_id IN (${ph})`,
        ws,
        pid,
        ...chunk,
      ),
  );
  const citedByPageKey = new Map<string, Set<string>>();
  for (const c of citeRows) {
    const r = resolveCitationHost(c.url, c.title);
    if (r.via !== "url" || !isSelfHost(r.host, domains)) continue;
    const k = pageKey(c.url);
    if (!k) continue;
    if (!citedByPageKey.has(k)) citedByPageKey.set(k, new Set());
    citedByPageKey.get(k)!.add(c.observation_id);
  }

  // Open internal-link suggestions pointing at each page (latest suggester run).
  const linkRun = await db.first<{ id: string }>(
    "SELECT id FROM link_runs WHERE workspace_id = ? AND project_id = ? AND status IN ('completed', 'partial') ORDER BY created_at DESC, rowid DESC LIMIT 1",
    ws,
    pid,
  );
  const linkCounts = new Map<string, number>();
  if (linkRun) {
    const rows = await db.all<{ target_page_id: string; n: number }>(
      `SELECT target_page_id, COUNT(*) AS n FROM link_suggestions
        WHERE workspace_id = ? AND project_id = ? AND link_run_id = ? AND status = 'suggested' AND user_status = 'open' GROUP BY target_page_id`,
      ws,
      pid,
      linkRun.id,
    );
    for (const r of rows) linkCounts.set(r.target_page_id, r.n);
  }

  const brand = brandTokenSet(project);
  const ordered = [...candidates.values()].sort((a, b) => b.priority - a.priority || a.url.localeCompare(b.url)).slice(0, MAX_PLANS);
  // Evidence for every plan page in batched queries; inlinks computed once per crawl run.
  const evidence = await loadOurPagesEvidence(db, project, ordered.map((c) => c.pageId), inlinkCache(db, project));
  const plans: RewritePlan[] = [];
  for (const c of ordered) {
    const matched = promptByPage.get(c.pageId) ?? null;
    const question = matched?.text ?? c.assessment?.question ?? "";
    const ev = evidence.get(c.pageId) ?? null;
    const crawlDay = ev?.snapshotAt ? ev.snapshotAt.slice(0, 10) : null;
    const factors = ev?.evidence ? evaluateFactors(ev.evidence, question || null, brand, now, ev.snapshotAt) : [];
    const fx = new Map(factors.map((f) => [f.key, f]));
    const noCrawl = !ev?.evidence;
    const crawlMissing = (key: RewritePlanItemKey): RewritePlanItem => ({
      key,
      label: ITEM_LABELS[key],
      status: "unknown",
      evidence: ev?.basis ?? "No crawl yet",
      method: "measured",
      optional: false,
    });

    const items: RewritePlanItem[] = [];
    items.push(
      c.assessment
        ? { key: "read_winning_page", label: ITEM_LABELS.read_winning_page, status: "unknown", evidence: `${CHECK_YOURSELF}: ${c.assessment.url}`, method: "manual", optional: false }
        : { key: "read_winning_page", label: ITEM_LABELS.read_winning_page, status: "not_applicable", evidence: "No approved cited page for this page yet", method: "manual", optional: false },
    );
    items.push(
      question
        ? { key: "map_question", label: ITEM_LABELS.map_question, status: "unknown", evidence: `${CHECK_YOURSELF}: does this page answer "${question.slice(0, 200)}"?`, method: "manual", optional: false }
        : { key: "map_question", label: ITEM_LABELS.map_question, status: "not_applicable", evidence: "No approved prompt matches this page", method: "manual", optional: false },
    );
    items.push(noCrawl ? crawlMissing("answer_first") : question ? measuredItem("answer_first", fx.get("answer_first"), crawlDay) : { ...measuredItem("answer_first", fx.get("answer_first"), crawlDay), status: "unknown" });
    items.push(noCrawl ? crawlMissing("faq") : measuredItem("faq", fx.get("faq_schema"), crawlDay));
    items.push(noCrawl ? crawlMissing("compare_table") : measuredItem("compare_table", fx.get("compare_table"), crawlDay));
    if (noCrawl) items.push(crawlMissing("internal_links"));
    else {
      const it = measuredItem("internal_links", fx.get("internal_links"), crawlDay);
      const open = linkCounts.get(c.pageId) ?? 0;
      if (open > 0) it.evidence = `${it.evidence}; ${open} open internal-link suggestion${open === 1 ? "" : "s"} point here`;
      items.push(it);
    }
    items.push(noCrawl ? crawlMissing("author") : measuredItem("author", fx.get("author"), crawlDay));
    if (noCrawl) items.push(crawlMissing("schema"));
    else {
      const types = ev!.evidence!.jsonldTypes;
      items.push({
        key: "schema",
        label: ITEM_LABELS.schema,
        status: types.length > 0 ? "done" : "todo",
        evidence: `${types.length > 0 ? `JSON-LD: ${types.slice(0, 5).join(", ")}` : "No JSON-LD found"}${crawlDay ? ` (crawl of ${crawlDay})` : ""}`,
        method: "measured",
        optional: false,
      });
    }
    items.push({ key: "indexnow", label: INDEXNOW_LABEL, status: "unknown", evidence: CHECK_YOURSELF, method: "manual", optional: true });

    const k = pageKey(c.url);
    const m = gsc && k ? gsc.pages.get(k) : undefined;
    plans.push({
      pageId: c.pageId,
      url: c.url,
      question,
      promptId: matched?.promptId ?? null,
      engine: asEngine(c.assessment?.provider),
      competitorAssessmentId: c.assessment?.id ?? null,
      items,
      gsc: gsc ? { clicks: m?.clicks ?? 0, impressions: m?.impressions ?? 0, window: gsc.window } : null,
      aiCitations: (anyGeo?.n ?? 0) > 0 ? { count: k ? (citedByPageKey.get(k)?.size ?? 0) : 0, window } : null,
      recommendationId: c.recommendationId,
      publishing: "manual",
    });
  }
  if (candidates.size > MAX_PLANS) labels.push(`Showing the first ${MAX_PLANS} of ${candidates.size} pages.`);
  if (!gsc) labels.push("Search Console not connected: no clicks or impressions shown.");
  return { state: project.is_demo ? "demo" : "ready", generatedAt, plans, labels };
}
