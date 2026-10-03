/** Seed helpers for the internal link suggester tests [A25]: crawl snapshots, GSC rows, and a fake Jev. */
import { Db } from "@worker/lib/db";
import { BudgetExceededError } from "@worker/lib/errors";
import { newId } from "@worker/lib/ids";
import type { ProjectRow } from "@worker/platform/access";
import type { DecisionAnswer, DecisionProvider, DecisionRequest, DecisionResult } from "@worker/providers/types";
import { FIXED_NOW } from "./helpers/fixtures";

export const HOST = "shop.example.com";
export const U = (p: string) => (p.startsWith("http") ? p : `https://${HOST}${p}`);

export interface LinkPageSeed {
  path: string;
  pageType?: string;
  status?: number | null;
  finalPath?: string | null;
  skipped?: string | null;
  title?: string | null;
  h1?: string[];
  headings?: Array<{ level: number; text: string }>;
  robotsMeta?: string | null;
  canonical?: string | null;
  links?: string[];
  sentences?: string[];
  excerpt?: string | null;
  firstParagraph?: string | null;
  genericAnchors?: Array<{ href: string; text: string }> | null;
  /** Workbench: [href path, text, kind] content/breadcrumb links with anchor text (null = not recorded). */
  anchors?: Array<[string, string, "c" | "i" | "b"]> | null;
  /** Workbench: redirect hops of a redirecting URL. */
  chain?: Array<{ status: number; to: string }> | null;
}

export async function seedLinkCrawl(
  db: Db,
  ws: string,
  pid: string,
  pages: LinkPageSeed[],
  opts: { startedAt?: string; status?: string; fetchedAt?: string } = {},
): Promise<{ crawlId: string; pageIds: Record<string, string> }> {
  const startedAt = opts.startedAt ?? FIXED_NOW.toISOString();
  const crawlId = newId("crw");
  await db.insert("crawl_runs", {
    id: crawlId,
    workspace_id: ws,
    project_id: pid,
    status: opts.status ?? "completed",
    pages_limit: 20,
    pages_crawled: pages.length,
    pages_skipped: 0,
    notes_json: "[]",
    started_at: startedAt,
    finished_at: startedAt,
  });
  const pageIds: Record<string, string> = {};
  let i = 0;
  for (const p of pages) {
    const url = U(p.path);
    const existing = await db.first<{ id: string }>("SELECT id FROM pages WHERE project_id = ? AND url = ?", pid, url);
    const pageId = existing?.id ?? newId("pg");
    if (!existing) {
      await db.insert("pages", { id: pageId, workspace_id: ws, project_id: pid, url, page_type: p.pageType ?? "other", page_type_method: "url_pattern", first_seen_at: startedAt, last_crawled_at: startedAt });
    }
    pageIds[p.path] = pageId;
    const status = p.status === undefined ? 200 : p.status;
    await db.insert("page_snapshots", {
      id: newId("snap"),
      workspace_id: ws,
      project_id: pid,
      page_id: pageId,
      crawl_run_id: crawlId,
      status_code: status,
      final_url: p.finalPath ? U(p.finalPath) : status === null ? null : url,
      skipped_reason: p.skipped ?? null,
      title: p.title === undefined ? `Page ${p.path}` : p.title,
      h1_json: JSON.stringify(p.h1 ?? []),
      headings_json: JSON.stringify([...(p.h1 ?? []).map((text) => ({ level: 1, text })), ...(p.headings ?? [])]),
      canonical: p.canonical === undefined ? url : p.canonical,
      robots_meta: p.robotsMeta ?? null,
      internal_links_json: JSON.stringify((p.links ?? []).map(U)),
      word_count: (p.sentences ?? []).join(" ").split(/\s+/).filter(Boolean).length,
      main_text_excerpt: p.excerpt ?? (p.sentences ?? []).join(" ").slice(0, 2000),
      first_paragraph: p.firstParagraph ?? null,
      generic_anchors_json: p.genericAnchors === null ? null : JSON.stringify(p.genericAnchors ?? []),
      link_context_json: JSON.stringify(p.sentences ?? []),
      link_anchors_json: p.anchors === undefined || p.anchors === null ? null : JSON.stringify(p.anchors.map(([h, t, k]) => [U(h), t, k])),
      redirect_chain_json: p.chain ? JSON.stringify(p.chain.map((c) => ({ status: c.status, to: U(c.to) }))) : null,
      fetched_at: opts.fetchedAt ?? new Date(new Date(startedAt).getTime() + i++ * 1000).toISOString(),
    });
  }
  return { crawlId, pageIds };
}

export async function seedGscImpressions(db: Db, ws: string, pid: string, rows: Array<{ path: string; impressions: number; query?: string | null }>) {
  const syncId = newId("gsc");
  const now = FIXED_NOW.toISOString();
  await db.insert("gsc_syncs", {
    id: syncId,
    workspace_id: ws,
    project_id: pid,
    source: "api",
    property: "sc-domain:example.com",
    window_start: "2026-09-01",
    window_end: "2026-09-28",
    prev_window_start: "2026-08-04",
    prev_window_end: "2026-08-31",
    row_cap: 5000,
    status: "completed",
    synced_at: now,
  });
  for (const r of rows) {
    await db.insert("gsc_metrics", {
      workspace_id: ws,
      project_id: pid,
      sync_id: syncId,
      window: "current",
      query: r.query === undefined ? "brass" : r.query,
      page: U(r.path),
      device: null,
      clicks: 1,
      impressions: r.impressions,
      ctr: 1 / Math.max(1, r.impressions),
      position: 8,
    });
  }
}

export async function projectRow(db: Db, projectId: string): Promise<ProjectRow> {
  return (await db.first<ProjectRow>("SELECT * FROM projects WHERE id = ?", projectId))!;
}

/**
 * A small store: products, a collection, two articles (one orphan), plus pages that must never be link
 * targets (404, redirect, noindex, variant with a canonical elsewhere, another host).
 */
export const STORE: LinkPageSeed[] = [
  {
    path: "/",
    pageType: "home",
    title: "Residence Example | Solid brass hardware",
    h1: ["Solid brass hardware for kitchens"],
    links: ["/collections/pulls", "/blogs/news/brass-care", "/products/brass-pull"],
    sentences: ["We make solid brass cabinet hardware by hand in small batches for kitchens and bathrooms."],
  },
  {
    path: "/collections/pulls",
    pageType: "collection",
    title: "Brass Cabinet Pulls | Residence Example",
    h1: ["Brass Cabinet Pulls"],
    links: ["/", "/products/brass-pull", "/old-pulls"],
    sentences: [
      "Our brass cabinet pulls come in three lengths for drawers and tall pantry doors.",
      "Every pull is machined from solid brass and left unlacquered so it develops a natural patina.",
    ],
  },
  {
    path: "/products/brass-pull",
    pageType: "product",
    title: "Solid Brass Cabinet Pull | Residence Example",
    h1: ["Solid Brass Cabinet Pull"],
    headings: [{ level: 2, text: "Specifications" }],
    links: ["/", "/collections/pulls"],
    sentences: [
      "This solid brass cabinet pull is machined from a single bar and hand finished in our workshop.",
      "Clean the unlacquered finish with mild soap and water, and read how to care for brass before polishing it.",
      "The pull is sold with two mounting screws and fits standard cabinet doors.",
    ],
  },
  {
    path: "/blogs/news/brass-care",
    pageType: "article",
    title: "How to Clean and Care for Unlacquered Brass | Residence Example",
    h1: ["How to clean and care for unlacquered brass"],
    headings: [{ level: 2, text: "Cleaning brass with soap" }, { level: 2, text: "Polishing brass" }],
    links: ["/", "/products/brass-pull"],
    sentences: [
      "Unlacquered brass darkens over time as the metal reacts with air, forming a patina that many people like.",
      "To clean brass, wash it with mild soap and warm water, then dry it with a soft cloth.",
      "Polishing brass removes the patina and restores the original shine of the metal.",
    ],
  },
  {
    path: "/blogs/news/brass-patina",
    pageType: "article",
    title: "What Is Brass Patina? | Residence Example",
    h1: ["What is brass patina?"],
    headings: [{ level: 2, text: "How patina forms" }],
    links: ["/"],
    sentences: [
      "Brass patina is the darker layer that forms when unlacquered brass reacts with oxygen and moisture.",
      "A patina protects the metal underneath and gives each piece a unique, lived-in character.",
    ],
  },
  { path: "/gone", status: 404, title: "Not found", sentences: [] },
  { path: "/old-pulls", status: 301, finalPath: "/collections/pulls", title: null, sentences: [] },
  {
    path: "/pages/patina-samples",
    pageType: "landing",
    title: "Brass Patina Samples",
    h1: ["Brass patina samples"],
    robotsMeta: "noindex, follow",
    links: ["/"],
    sentences: ["Order brass patina samples to compare unlacquered brass finishes at home."],
  },
  {
    path: "/products/brass-pull?variant=2",
    pageType: "product",
    title: "Solid Brass Cabinet Pull (long) | Residence Example",
    h1: ["Solid Brass Cabinet Pull"],
    canonical: U("/products/brass-pull"),
    links: ["/"],
    sentences: ["This solid brass cabinet pull variant is longer and suits tall pantry doors."],
  },
  {
    path: "https://other.example.com/brass-patina",
    pageType: "article",
    title: "Brass patina explained",
    h1: ["Brass patina explained"],
    sentences: ["Brass patina forms on unlacquered brass over months of use."],
  },
];

// ------------------------------------------------------------------------------------ fake Jev

export type AnswerFn = (questionId: string, req: DecisionRequest, call: number) => DecisionAnswer | undefined;

export function choice(c: string, confidence: number, probabilities?: Record<string, number>): DecisionAnswer {
  return { type: "choice", choice: c, confidence, probabilities: probabilities ?? { [c]: confidence, none: Math.max(0, 1 - confidence) } };
}

export const noul = (p: number): DecisionAnswer => ({ type: "noul", noul: p });

/** Answers every question: yes 0.93, first sentence/anchor at 0.9, role deeper_detail at 0.85. */
export const confidentYes: AnswerFn = (qid) => {
  if (qid.endsWith(".should_exist")) return noul(0.93);
  if (qid.endsWith(".sentence")) return choice("s0", 0.9);
  if (qid.endsWith(".anchor")) return choice("a0", 0.9);
  if (qid.endsWith(".role")) return choice("deeper_detail", 0.85);
  return undefined;
};

export function fakeDecisions(answer: AnswerFn, opts: { budgetOnCall?: number; failOnCall?: number } = {}) {
  const requests: DecisionRequest[] = [];
  const provider: DecisionProvider = {
    name: "typesafe",
    async decide(req): Promise<DecisionResult> {
      requests.push(req);
      const call = requests.length;
      if (opts.budgetOnCall !== undefined && call >= opts.budgetOnCall) throw new BudgetExceededError("jev_calls", "Project daily limit reached for jev_calls.");
      if (opts.failOnCall === call) throw new Error("HTTP 503");
      const answers: Record<string, DecisionAnswer | undefined> = {};
      for (const key of Object.keys(req.questions)) answers[key] = answer(key, req, call);
      return { provider: "typesafe", model: "jev-test-2026-09", answers, usage: { inputTokens: 10, outputTokens: 1 } };
    },
    async test() {
      return { ok: true, detail: "fake" };
    },
  };
  return { provider, requests };
}
