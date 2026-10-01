/** Seed helpers for the Live view worker tests (tests/live-worker-*.test.ts). Not a test file. */
import { createApp } from "@worker/app";
import type { Env } from "@worker/env";
import { Db } from "@worker/lib/db";
import { newId } from "@worker/lib/ids";
import type { ProjectRow } from "@worker/platform/access";
import { createTestEnv } from "./helpers/env";
import { authHeaders, FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";

export const ORIGIN = "https://shop.example.com";
/** Seconds after FIXED_NOW - 1 h. */
export const t = (sec: number) => new Date(FIXED_NOW.getTime() - 3_600_000 + sec * 1000).toISOString();

export async function setup(envOverrides: Partial<Env> = {}) {
  const env = createTestEnv(envOverrides);
  const u = await seedUser(env);
  const pid = await seedProject(env, u.workspaceId);
  const db = new Db(env.DB);
  const p = (await db.first<ProjectRow>("SELECT * FROM projects WHERE id = ?", pid))!;
  return { env, u, db, ws: u.workspaceId, pid, p };
}

/** GET through the real app (auth, CSRF, tenancy, mount line); returns status + parsed JSON. */
export function caller(env: Env, user: { sessionToken: string; csrfToken: string }) {
  const app = createApp();
  return async (path: string) => {
    const res = await app.request(`/api${path}`, { method: "GET", headers: authHeaders(user.sessionToken, user.csrfToken) }, env);
    return { status: res.status, json: (await res.json()) as any };
  };
}

export async function seedRun(db: Db, ws: string, pid: string, agent: "seo" | "geo", status: string, extra: Record<string, unknown> = {}) {
  const id = newId("run");
  await db.insert("agent_runs", {
    id, workspace_id: ws, project_id: pid, agent, trigger: "manual", idempotency_key: `k-${id}`, status,
    created_at: t(0), started_at: t(0), finished_at: status === "running" || status === "pending" ? null : t(3000), ...extra,
  });
  return id;
}

export async function seedCrawl(db: Db, ws: string, pid: string, runId: string | null, startedAt = t(1), status = "completed") {
  const id = newId("crawl");
  await db.insert("crawl_runs", {
    id, workspace_id: ws, project_id: pid, run_id: runId, status, pages_limit: 50, pages_crawled: 0, started_at: startedAt, finished_at: status === "running" ? null : startedAt,
  });
  return id;
}

export interface SnapFields {
  title?: string | null;
  meta_description?: string | null;
  h1?: string[];
  headings?: Array<{ level: number; text: string }>;
  first_paragraph?: string | null;
  jsonld_types?: string[];
  word_count?: number | null;
  last_updated?: string | null;
  canonical?: string | null;
  robots_meta?: string | null;
  status_code?: number | null;
  skipped_reason?: string | null;
  fetched_at?: string;
}

/** A page (created once per URL) plus a snapshot in `crawlId`. */
export async function seedPage(db: Db, ws: string, pid: string, crawlId: string, url: string, s: SnapFields = {}, pageType = "product") {
  let page = await db.first<{ id: string }>("SELECT id FROM pages WHERE project_id = ? AND url = ?", pid, url);
  if (!page) {
    page = { id: newId("pg") };
    await db.insert("pages", { id: page.id, workspace_id: ws, project_id: pid, url, page_type: pageType, page_type_method: "url_pattern", first_seen_at: t(0) });
  }
  await db.insert("page_snapshots", {
    id: newId("snap"), workspace_id: ws, project_id: pid, page_id: page.id, crawl_run_id: crawlId, status_code: s.status_code === undefined ? 200 : s.status_code,
    final_url: url, skipped_reason: s.skipped_reason ?? null, title: s.title ?? null, meta_description: s.meta_description ?? null,
    h1_json: JSON.stringify(s.h1 ?? []), headings_json: JSON.stringify(s.headings ?? []), canonical: s.canonical ?? null, robots_meta: s.robots_meta ?? null,
    jsonld_types_json: JSON.stringify(s.jsonld_types ?? []), word_count: s.word_count ?? null, first_paragraph: s.first_paragraph ?? null,
    last_updated: s.last_updated ?? null, fetched_at: s.fetched_at ?? t(2),
  });
  return page.id;
}

export const noul = (n: number) => ({ type: "noul", noul: n });
export const choice = (c: string, confidence: number) => ({ type: "choice", choice: c, confidence, probabilities: { [c]: confidence } });

export interface DecisionSeed {
  id?: string;
  candidateKey?: string;
  /** Readable candidate key stored in answer_json.candidate. */
  readable?: string | null;
  questionId: string | null;
  /** Stored raw answer (wrapped as {answer, candidate, questionTier}); undefined = no `answer` field. */
  answer?: unknown;
  /** Extra answer_json fields (e.g. query, key, link suggestion fields). */
  extra?: Record<string, unknown>;
  /** Store answer_json exactly as given (demo bare answers). */
  rawAnswerJson?: string | null;
  tier?: string | null;
  outcome?: "selected" | "rejected";
  reason?: string | null;
  provider?: string | null;
  model?: string | null;
  at?: string;
}

export async function seedDecision(db: Db, ws: string, pid: string, runId: string | null, d: DecisionSeed) {
  const id = d.id ?? newId("dec");
  const answerJson =
    d.rawAnswerJson !== undefined
      ? d.rawAnswerJson
      : JSON.stringify({
          ...(d.answer !== undefined ? { answer: d.answer } : {}),
          ...(d.readable !== null ? { candidate: d.readable ?? "weak_ctr:https://shop.example.com/a" } : {}),
          questionTier: d.tier ?? "act",
          ...(d.extra ?? {}),
        });
  await db.insert("decision_records", {
    id, workspace_id: ws, project_id: pid, run_id: runId, agent: "seo", candidate_key: d.candidateKey ?? `seo:test:${id}`, question_id: d.questionId,
    question_version: "v", policy_version: "p", provider: d.provider === undefined ? "typesafe" : d.provider, model: d.model === undefined ? "jev-test" : d.model,
    answer_json: answerJson, tier: d.tier === undefined ? "act" : d.tier, outcome: d.outcome ?? "selected", reason_code: d.reason ?? null, created_at: d.at ?? t(10),
  });
  return id;
}

export async function seedFinding(db: Db, ws: string, pid: string, crawlId: string, f: { id?: string; ruleId: string; severity?: string; url?: string | null; template?: string | null; at?: string }) {
  const id = f.id ?? newId("fnd");
  await db.insert("audit_findings", {
    id, workspace_id: ws, project_id: pid, crawl_run_id: crawlId, rule_id: f.ruleId, severity: f.severity ?? "minor", url: f.url === undefined ? `${ORIGIN}/a` : f.url,
    template: f.template ?? null, detail: "detail", created_at: f.at ?? t(5),
  });
  return id;
}

export async function seedRec(
  db: Db, ws: string, pid: string, runId: string | null,
  r: { id?: string; dedupKey: string; target: Record<string, unknown>; snippet?: string | null; at?: string; stage?: string; status?: string; agent?: "seo" | "geo"; label?: string | null },
) {
  const id = r.id ?? newId("rec");
  const scope = r.target.kind === "url" ? "page" : r.target.kind === "template" ? "template" : "site";
  await db.insert("recommendations", {
    id, workspace_id: ws, project_id: pid, run_id: runId, agent: r.agent ?? "seo", scope, target_json: JSON.stringify(r.target), issue_type: "weak_ctr",
    trigger: "t", issue: "i", action: "Rewrite the title.", suggested_snippet: r.snippet ?? null, rationale: "r", effort: "low", uncertainty: "medium",
    limitations: "l", verified: 1, priority: 0.5, priority_version: "priority-v3", decision_label: r.label === undefined ? "act" : r.label,
    evidence_ids_json: JSON.stringify(["ev_1", "ev_2"]), dedup_key: r.dedupKey, status: r.status ?? "open", stage: r.stage ?? "awaiting_approval",
    writer_provider: "writer", writer_model: "w-1", created_at: r.at ?? t(20), updated_at: r.at ?? t(20),
  });
  return id;
}

export async function seedGsc(
  db: Db, ws: string, pid: string,
  o: { runId?: string | null; status?: string; syncedAt?: string; source?: string; error?: string | null; rows: Array<{ query?: string | null; page?: string | null; clicks: number; impressions: number; position: number; window?: "current" | "previous"; device?: string | null }> },
) {
  const id = newId("gsc");
  await db.insert("gsc_syncs", {
    id, workspace_id: ws, project_id: pid, run_id: o.runId ?? null, source: o.source ?? "api", property: "sc-domain:example.com",
    window_start: "2026-09-01", window_end: "2026-09-28", prev_window_start: "2026-08-04", prev_window_end: "2026-08-31",
    rows_fetched: o.rows.length, row_cap: 25000, truncated: 0, totals_json: "{}", status: o.status ?? "completed", error: o.error ?? null, synced_at: o.syncedAt ?? t(3),
  });
  for (const r of o.rows) {
    await db.insert("gsc_metrics", {
      workspace_id: ws, project_id: pid, sync_id: id, window: r.window ?? "current", query: r.query ?? null, page: r.page ?? null, device: r.device ?? null,
      clicks: r.clicks, impressions: r.impressions, ctr: r.impressions > 0 ? r.clicks / r.impressions : 0, position: r.position,
    });
  }
  return id;
}
