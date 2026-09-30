/**
 * Labelled SEO fixture (not live data): a small brass-hardware store with a crawl, audit findings,
 * a GSC API sync (current + previous windows), and captured engine search queries. Every candidate
 * kind in src/worker/seo/recommend/candidates.ts fires on this fixture.
 */
import { Db } from "@worker/lib/db";
import { newId } from "@worker/lib/ids";
import type { Env } from "@worker/env";
import type {
  DecisionAnswer,
  DecisionProvider,
  DecisionRequest,
  GscProvider,
  GscQueryRequest,
  GscRow,
  WritingProvider,
  WritingRequest,
} from "@worker/providers/types";
import { FIXED_NOW } from "../../helpers/fixtures";

export const ORIGIN = "https://shop.example.com";
export const U = {
  home: `${ORIGIN}/`,
  knob: `${ORIGIN}/products/brass-knob`,
  knobLarge: `${ORIGIN}/products/brass-knob-large`,
  hardware: `${ORIGIN}/collections/cabinet-hardware`,
  guide: `${ORIGIN}/blogs/guide/how-to-clean-brass`,
  sconces: `${ORIGIN}/pages/wall-sconces`,
};

export const CURRENT = { start: "2026-08-31", end: "2026-09-27" };
export const PREVIOUS = { start: "2026-08-03", end: "2026-08-30" };

interface PageFx {
  url: string;
  type: "home" | "collection" | "product" | "article" | "landing" | "other";
  title: string;
  h1: string;
  headings: string[];
  excerpt: string;
  links: string[];
}

export const PAGES: PageFx[] = [
  { url: U.home, type: "home", title: "Residence Example | Brass Hardware", h1: "Brass hardware for the home", headings: ["Shop"], excerpt: "Solid brass hardware.", links: [U.hardware, U.guide] },
  {
    url: U.hardware,
    type: "collection",
    title: "Cabinet Hardware",
    h1: "Cabinet Hardware",
    headings: ["Knobs", "Pulls"],
    excerpt: "Cabinet knobs and pulls in solid brass.",
    links: [U.knob, U.knobLarge, U.home],
  },
  {
    url: U.knob,
    type: "product",
    title: "Solid Brass Cabinet Knob | ResEx",
    h1: "Solid Brass Cabinet Knob",
    headings: ["Details", "Shipping"],
    excerpt: "A solid brass cabinet knob machined from bar stock.",
    links: [U.hardware],
  },
  {
    url: U.knobLarge,
    type: "product",
    title: "Solid Brass Cabinet Knob Large | ResEx",
    h1: "Solid Brass Cabinet Knob, Large",
    headings: ["Details"],
    excerpt: "The larger solid brass cabinet knob.",
    links: [U.hardware],
  },
  {
    url: U.guide,
    type: "article",
    title: "How to Clean Unlacquered Brass",
    h1: "How to Clean Unlacquered Brass",
    headings: ["What you need", "Steps"],
    excerpt: "Unlacquered brass develops a patina over time.",
    links: [U.home],
  },
  { url: U.sconces, type: "landing", title: "Wall Sconces", h1: "Wall Sconces", headings: ["Styles"], excerpt: "Wall sconces for every room.", links: [] },
];

const row = (keys: string[], clicks: number, impressions: number, position: number): GscRow => ({ keys, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position });

/** query+page rows, current window. */
export const QP_CURRENT: GscRow[] = [
  row(["brass cabinet knob", U.knob], 10, 2000, 5), // weak CTR in bucket 4-10
  row(["cabinet hardware", U.hardware], 90, 1500, 6),
  row(["wall sconces", U.sconces], 60, 1200, 7),
  row(["brass sconces", U.sconces], 20, 400, 8),
  row(["how to clean unlacquered brass", U.knob], 3, 300, 15), // mismatch + coverage gap
  row(["brass cabinet knob", U.knobLarge], 2, 150, 9), // shared query -> duplicate pair
];
export const QP_PREVIOUS: GscRow[] = [row(["cabinet hardware", U.hardware], 190, 1600, 5), row(["brass cabinet knob", U.knob], 12, 1900, 5)];
/** page-dimension rows. */
export const PAGE_CURRENT: GscRow[] = [row([U.knob], 13, 2300, 6), row([U.hardware], 100, 1600, 6), row([U.sconces], 80, 1600, 7), row([U.knobLarge], 2, 150, 9)];
export const PAGE_PREVIOUS: GscRow[] = [row([U.knob], 14, 2100, 6), row([U.hardware], 200, 1700, 5), row([U.sconces], 70, 1500, 7)];
export const TOTALS = { current: row([], 300, 50000, 12.3), previous: row([], 400, 48000, 11.9) };

export function dailyRows(): GscRow[] {
  const out: GscRow[] = [];
  for (let i = 0; i < 26; i++) {
    const d = new Date(Date.parse(`${CURRENT.start}T00:00:00Z`) + i * 86400_000).toISOString().slice(0, 10);
    out.push(row([d], 10, 1800, 12));
  }
  return out; // last 2 days missing: not finalized yet
}

// ------------------------------------------------------------------ fake GSC
export interface FakeGscData {
  totals: { current: GscRow | null; previous: GscRow | null };
  daily: GscRow[];
  page: { current: GscRow[]; previous: GscRow[] };
  qp: { current: GscRow[]; previous: GscRow[] };
}

export const DEFAULT_GSC_DATA: FakeGscData = {
  totals: TOTALS,
  daily: dailyRows(),
  page: { current: PAGE_CURRENT, previous: PAGE_PREVIOUS },
  qp: { current: QP_CURRENT, previous: QP_PREVIOUS },
};

export function fakeGsc(data: FakeGscData = DEFAULT_GSC_DATA, fail?: (req: GscQueryRequest, n: number) => unknown) {
  const requests: GscQueryRequest[] = [];
  const provider: GscProvider & { requests: GscQueryRequest[] } = {
    requests,
    async listProperties() {
      return [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" }];
    },
    async query(req) {
      requests.push(req);
      const err = fail?.(req, requests.length);
      if (err) throw err;
      const which = req.startDate === CURRENT.start ? "current" : "previous";
      let rows: GscRow[];
      if (req.dimensions.length === 0) rows = data.totals[which] ? [data.totals[which]!] : [];
      else if (req.dimensions[0] === "date") rows = which === "current" ? data.daily : [];
      else if (req.dimensions.length === 1) rows = data.page[which];
      else rows = data.qp[which];
      return { rows: rows.slice(req.startRow, req.startRow + req.rowLimit) };
    },
  };
  return provider;
}

// ------------------------------------------------------------------ DB seed
export interface SeedOptions {
  /** Findings: default = 10 product URLs missing Offer (template) + one page-level + one site-level. */
  findings?: Array<{ rule: string; severity: string; url: string | null; template?: string | null; detail: string }>;
  pages?: PageFx[];
  engineQueries?: string[];
  pillars?: string | null;
}

export function defaultFindings() {
  const products = Array.from({ length: 10 }, (_, i) => `${ORIGIN}/products/item-${i + 1}`);
  return [
    ...products.map((url) => ({ rule: "product_offer_missing", severity: "major", url, template: "product template", detail: "Product JSON-LD has no Offer (price, availability)." })),
    { rule: "meta_description_missing", severity: "moderate", url: U.sconces, template: null, detail: "No meta description." },
    { rule: "robots_blocks_answer_crawler", severity: "advisory", url: null, template: null, detail: "robots.txt blocks an answer crawler." },
  ];
}

export async function seedCrawl(env: Env, workspaceId: string, projectId: string, opts: SeedOptions = {}) {
  const db = new Db(env.DB);
  const now = FIXED_NOW.toISOString();
  const crawlId = newId("crawl");
  const pages = opts.pages ?? PAGES;
  await db.insert("crawl_runs", { id: crawlId, workspace_id: workspaceId, project_id: projectId, status: "completed", pages_limit: 20, pages_crawled: pages.length, started_at: "2026-09-29T08:00:00.000Z", finished_at: "2026-09-29T08:05:00.000Z" });
  for (const p of pages) {
    const pageId = newId("pg");
    await db.insert("pages", { id: pageId, workspace_id: workspaceId, project_id: projectId, url: p.url, page_type: p.type, page_type_method: "url_pattern", first_seen_at: now, last_crawled_at: now });
    await db.insert("page_snapshots", {
      id: newId("snap"),
      workspace_id: workspaceId,
      project_id: projectId,
      page_id: pageId,
      crawl_run_id: crawlId,
      status_code: 200,
      final_url: p.url,
      title: p.title,
      meta_description: p.url === U.sconces ? null : `${p.title} from Residence Example.`,
      h1_json: JSON.stringify([p.h1]),
      headings_json: JSON.stringify(p.headings.map((text) => ({ level: 2, text }))),
      internal_links_json: JSON.stringify(p.links.map((u) => u.replace(ORIGIN, ""))),
      word_count: 300,
      main_text_excerpt: p.excerpt,
      first_paragraph: p.excerpt,
      fetched_at: "2026-09-29T08:01:00.000Z",
    });
  }
  for (const f of opts.findings ?? defaultFindings()) {
    await db.insert("audit_findings", { id: newId("fnd"), workspace_id: workspaceId, project_id: projectId, crawl_run_id: crawlId, rule_id: f.rule, severity: f.severity, url: f.url, template: f.template ?? null, detail: f.detail, evidence_json: "{}", created_at: now });
  }
  return crawlId;
}

export async function seedEngineQueries(env: Env, workspaceId: string, projectId: string, queries: string[]) {
  const db = new Db(env.DB);
  const obs = newId("obs");
  await db.insert("geo_observations", {
    id: obs, workspace_id: workspaceId, project_id: projectId, prompt_text: "Where can I buy solid brass cabinet knobs?", prompt_type: "discovery",
    cohort_key: "c1", provider: "gemini", model: "gemini-test-model", grounding_mode: "google_search", measurement_type: "api", status: "ok", grounded: 1,
    created_at: "2026-09-29T09:00:00.000Z",
  });
  for (const q of queries) {
    await db.insert("geo_search_queries", { id: newId("gsq"), workspace_id: workspaceId, project_id: projectId, observation_id: obs, provider: "gemini", model: "gemini-test-model", query: q, normalized: q.toLowerCase(), created_at: "2026-09-29T09:00:00.000Z" });
  }
  return obs;
}

export async function seedPillars(env: Env, workspaceId: string, projectId: string, content: string) {
  await new Db(env.DB).insert("context_documents", { id: newId("ctx"), workspace_id: workspaceId, project_id: projectId, kind: "pillars", version: 1, content, facts_json: "[]", created_at: FIXED_NOW.toISOString() });
}

// ------------------------------------------------------------------ fake Jev
export type AnswerFn = (questionId: string, req: DecisionRequest) => DecisionAnswer | undefined;

export const choice = (c: string, confidence = 0.9, runner = "other"): DecisionAnswer => ({ type: "choice", choice: c, confidence, probabilities: { [c]: confidence, [runner]: 1 - confidence } });
export const noul = (v: number): DecisionAnswer => ({ type: "noul", noul: v });
export const score = (s: number, confidence = 0.9): DecisionAnswer => ({ type: "score", score: s, confidence, probabilities: { [String(s)]: confidence } });

/** Approves everything: relevant, transactional, fits, action by kind, major severity, overlap yes. */
export const approveAll: AnswerFn = (id, req) => {
  if (id.startsWith("seo.page_overlap")) return noul(0.95);
  if (id === "seo.query_page_relevance") return noul(0.92);
  if (id === "seo.query_intent") return choice("transactional");
  if (id === "seo.intent_page_fit") return choice("fits");
  if (id === "seo.issue_severity") return score(3);
  if (id === "seo.pillar_fit") return choice("none");
  if (id === "seo.action_choice") {
    const type = ((req.state as { issue?: { type?: string } }).issue?.type ?? "") as string;
    return choice(type === "weak_ctr" ? "rewrite_title_meta" : type === "internal_link" ? "add_internal_links" : "add_section", 0.83, "improve_intro_answer");
  }
  return undefined;
};

export function fakeDecisions(answer: AnswerFn = approveAll) {
  const requests: DecisionRequest[] = [];
  const provider: DecisionProvider & { requests: DecisionRequest[] } = {
    name: "fake-jev",
    requests,
    async decide(req) {
      requests.push(req);
      const answers: Record<string, DecisionAnswer | undefined> = {};
      for (const id of Object.keys(req.questions)) answers[id] = answer(id, req);
      return { provider: "fake-jev", model: "jev-test-1", answers, usage: { inputTokens: 100, outputTokens: 10 } };
    },
    async test() {
      return { ok: true, detail: "fake" };
    },
  };
  return provider;
}

// ------------------------------------------------------------------ fake writer
export type WriterFn = (req: WritingRequest) => unknown;

interface WriterInput {
  EVIDENCE: Array<{ id: string; source: string; text_or_metric: string }>;
  TARGET: { target: { kind: "url" | "template" | "site"; url?: string; template?: string } };
  REQUIRED_FIELDS: { scope: "page" | "template" | "site"; trigger_hint: string; issue_hint: string; limitations_hint: string };
}

/** A well-behaved writer: copies evidence, cites ids, no new numbers. */
export const goodWriter: WriterFn = (req) => {
  const input = req.input as WriterInput;
  const ids = input.EVIDENCE.map((e) => e.id);
  return {
    agent: "seo",
    scope: input.REQUIRED_FIELDS.scope,
    target: { kind: input.TARGET.target.kind, ...(input.TARGET.target.url ? { url: input.TARGET.target.url } : {}) },
    trigger: input.REQUIRED_FIELDS.trigger_hint.replace(/[\d.,%]+/g, "").slice(0, 200),
    issue: `The evidence shows an opportunity on this page [${ids[0]}].`,
    evidence_ids: ids.slice(0, 2),
    evidence_bullets: input.EVIDENCE.slice(0, 2).map((e) => ({ evidence_id: e.id, source: e.source === "rule" ? "crawl" : e.source, text: "See cited evidence." })),
    action: `Rewrite the snippet to reflect the searched topic [${ids[0]}]. [confirm: product finish]`,
    rationale: `The cited rows suggest searchers want this topic [${ids[0]}].`,
    effort: "low",
    uncertainty: "low",
    limitations: "Heuristic; no ranking change is promised.",
    verified: true,
  };
};

/** A writer that invents a certification and a number: must be rejected by the validator. */
export const badWriter: WriterFn = (req) => {
  const out = goodWriter(req) as Record<string, unknown>;
  return { ...out, action: `${out.action as string} Mention it is UL listed and lifts CTR by 37%.` };
};

export function fakeWriter(fn: WriterFn = goodWriter) {
  const requests: WritingRequest[] = [];
  const provider: WritingProvider & { requests: WritingRequest[] } = {
    name: "fake-writer",
    model: "writer-test-1",
    requests,
    async write(req) {
      requests.push(req);
      return { provider: "fake-writer", model: "writer-test-1", output: fn(req), usage: { inputTokens: 500, outputTokens: 200 } };
    },
    async test() {
      return { ok: true, detail: "fake" };
    },
  };
  return provider;
}
