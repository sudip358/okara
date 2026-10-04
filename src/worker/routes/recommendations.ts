/**
 * Recommendation, decision-feedback, and attention routes (runtime module).
 *   GET   /projects/:pid/recommendations?agent=&status=   Recommendation[]
 *   GET   /recommendations/:id                           RecommendationDetail
 *   PATCH /recommendations/:id                           status transitions + edits (recorded as events)
 *   POST  /decisions/:id/feedback                        [A18] "Disagree" -> judgment_feedback
 *   GET   /projects/:pid/attention                       AttentionFeed
 * Status transitions: open -> approved | dismissed; approved -> implemented | dismissed;
 * dismissed -> open (reopen). "Implemented" is a manual mark; it never claims the site changed.
 */
import { backlinkAttention } from "../backlinks/service";
import { Hono } from "hono";
import { z } from "zod";
import type {
  AgentKind,
  AttentionFeed,
  CapabilityState,
  EvidenceItem,
  Recommendation,
  RecommendationDetail,
  RecommendationStatus,
} from "@shared/types";
import type { AppEnv } from "../app";
import { requireUser } from "../platform/require-user";
import type { Db } from "../lib/db";
import { parseJson } from "../lib/db";
import { inChunks } from "../coverage/common";
import { badRequest, conflict, notFound } from "../lib/errors";
import { newId } from "../lib/ids";
import { iso, utcDay } from "../lib/time";
import { requireProject, type ProjectRow } from "../platform/access";
import { capabilityPresence, writerStatusForWorkspace, type RunRow } from "../runs/runtime";
import { toRunSummary } from "../runs/runs-service";
import { mapDecision, mapEvent } from "./runs";
import { anyGeoEngineConfigured } from "../geo/engines";
import { failingSyncs } from "../imports/service";
import { linkVerificationAttention } from "../links/report";

export const ZERO_STATE_MESSAGE = "No new verified opportunities today.";
export const IMPLEMENTED_NOTE = "Marked implemented by a reviewer. The site change is not verified by this app.";

const TRANSITIONS: Record<RecommendationStatus, RecommendationStatus[]> = {
  open: ["approved", "dismissed"],
  approved: ["implemented", "dismissed"],
  dismissed: ["open"],
  implemented: [],
};

const EVENT_FOR: Record<RecommendationStatus, string> = {
  approved: "approved",
  dismissed: "dismissed",
  implemented: "implemented",
  open: "reopened",
};

const patchBody = z
  .object({
    status: z.enum(["open", "approved", "dismissed", "implemented"]).optional(),
    action: z.string().trim().min(1).max(600).optional(),
    suggestedSnippet: z.string().max(64_000).nullable().optional(),
    note: z.string().max(1000).optional(),
  })
  .strict();

const feedbackBody = z.object({ humanAnswer: z.string().trim().min(1).max(200), reason: z.string().max(1000).optional() }).strict();

export interface RecRow {
  id: string;
  workspace_id: string;
  project_id: string;
  run_id: string | null;
  agent: AgentKind;
  scope: Recommendation["scope"];
  target_json: string;
  issue_type: string;
  trigger: string;
  issue: string;
  action: string;
  suggested_snippet: string | null;
  rationale: string;
  effort: Recommendation["effort"];
  uncertainty: Recommendation["uncertainty"];
  limitations: string;
  verified: number;
  priority: number;
  priority_version: string;
  decision_label: string | null;
  decision_score_json: string | null;
  evidence_ids_json: string;
  evidence_bullets_json: string;
  confirm_placeholders_json: string;
  dedup_key: string;
  status: RecommendationStatus;
  stage: Recommendation["stage"];
  writer_provider: string | null;
  writer_model: string | null;
  is_demo: number;
  created_at: string;
  updated_at: string;
}

/**
 * Only real TypeSafe response field names reach the UI (it prints keys verbatim): Choice `choice` +
 * `confidence`, Score `score` + `confidence`, Noul `noul` (no confidence). Keys may be qualified by the
 * question id, as the SEO agent stores them ("seo.action_choice.confidence"); bare keys stored next to a
 * `question` id (GEO: {question, score, confidence}) are qualified with it. Derived or invented keys
 * (runner_up, priority, ...) are dropped; the runner-up is derived in the UI from the stored answer.
 */
export const DECISION_FIELD_NAMES: ReadonlySet<string> = new Set(["choice", "confidence", "score", "noul"]);
const QUESTION_ID_RE = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/;

export function decisionFields(json: string | null): { fields: Record<string, number | string> | null; provider: string | null } {
  const raw = parseJson<Record<string, unknown> | null>(json, null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { fields: null, provider: null };
  const qRaw = typeof raw.question === "string" ? raw.question : typeof raw.questionId === "string" ? raw.questionId : null;
  const question = qRaw && QUESTION_ID_RE.test(qRaw) ? qRaw : null;
  const fields: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "number" && typeof v !== "string") continue;
    if (typeof v === "number" && !Number.isFinite(v)) continue;
    const dot = k.lastIndexOf(".");
    const name = dot >= 0 ? k.slice(dot + 1) : k;
    if (!DECISION_FIELD_NAMES.has(name)) continue;
    if (dot >= 0) {
      if (QUESTION_ID_RE.test(k.slice(0, dot))) fields[k] = v;
    } else {
      fields[question ? `${question}.${k}` : k] = v;
    }
  }
  return { fields: Object.keys(fields).length ? fields : null, provider: typeof raw.provider === "string" ? raw.provider : null };
}

export function mapRecommendation(r: RecRow, decisionProvider: string | null = null): Recommendation {
  const { fields, provider: storedProvider } = decisionFields(r.decision_score_json);
  const provider = storedProvider ?? decisionProvider;
  return {
    id: r.id,
    projectId: r.project_id,
    agent: r.agent,
    scope: r.scope,
    target: parseJson<Recommendation["target"]>(r.target_json, { kind: "site" }),
    issueType: r.issue_type,
    trigger: r.trigger,
    issue: r.issue,
    action: r.action,
    suggestedSnippet: r.suggested_snippet,
    rationale: r.rationale,
    effort: r.effort,
    uncertainty: r.uncertainty,
    limitations: r.limitations,
    verified: r.verified === 1,
    priority: r.priority,
    priorityVersion: r.priority_version,
    decision: { tier: (r.decision_label as Recommendation["decision"]["tier"]) ?? null, fields, provider },
    evidenceBullets: parseJson(r.evidence_bullets_json, []),
    confirmPlaceholders: parseJson(r.confirm_placeholders_json, []),
    status: r.status,
    stage: r.status === "implemented" ? "marked_implemented" : r.stage,
    writer: { provider: r.writer_provider, model: r.writer_model },
    isDemo: r.is_demo === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Attach the true decision provider from decision_records (candidate_key = dedup key). */
export async function withProviders(db: Db, rows: RecRow[]): Promise<Recommendation[]> {
  if (rows.length === 0) return [];
  const first = rows[0]!;
  const keys = [...new Set(rows.map((r) => r.dedup_key))];
  // Up to 200 keys per list: chunked so each statement stays under D1's 100 bound-parameter limit.
  const found = await inChunks(keys, (chunk, placeholders) =>
    db.all<{ candidate_key: string; provider: string }>(
      `SELECT candidate_key, provider FROM decision_records
        WHERE workspace_id = ? AND project_id = ? AND provider IS NOT NULL AND candidate_key IN (${placeholders})
        ORDER BY created_at DESC`,
      first.workspace_id,
      first.project_id,
      ...chunk,
    ),
  );
  // A key lives in exactly one chunk, so per-chunk newest-first order already picks the latest provider.
  const byKey = new Map<string, string>();
  for (const f of found) if (!byKey.has(f.candidate_key)) byKey.set(f.candidate_key, f.provider);
  return rows.map((r) => mapRecommendation(r, r.decision_label ? byKey.get(r.dedup_key) ?? null : null));
}

async function loadRecForUser(db: Db, userId: string, id: string): Promise<RecRow> {
  const row = await db.first<RecRow>(
    `SELECT r.* FROM recommendations r JOIN memberships m ON m.workspace_id = r.workspace_id AND m.user_id = ? WHERE r.id = ?`,
    userId,
    id,
  );
  if (!row) throw notFound("Recommendation");
  await requireProject(db, userId, row.project_id);
  return row;
}

export async function recommendationDetail(db: Db, r: RecRow): Promise<RecommendationDetail> {
  const ids = parseJson<string[]>(r.evidence_ids_json, []).filter((x) => typeof x === "string").slice(0, 100);
  // 100 ids + 2 scope params would exceed D1's 100 bound-parameter limit: chunked.
  const evidence = await inChunks(ids, (chunk, placeholders) =>
    db.all<{ id: string; source: EvidenceItem["source"]; ref_id: string | null; window: string | null; text: string; data_json: string; tainted: number; created_at: string }>(
      `SELECT id, source, ref_id, window, text, data_json, tainted, created_at FROM evidence
        WHERE workspace_id = ? AND project_id = ? AND id IN (${placeholders})`,
      r.workspace_id,
      r.project_id,
      ...chunk,
    ),
  );
  const decisions = await db.all(
    `SELECT * FROM decision_records WHERE workspace_id = ? AND project_id = ? AND candidate_key IN (?, ?)
      ORDER BY created_at DESC, id LIMIT 50`,
    r.workspace_id,
    r.project_id,
    r.dedup_key,
    r.id,
  );
  const events = await db.all<{ event: string; note: string | null; user_id: string | null; created_at: string }>(
    `SELECT event, note, user_id, created_at FROM recommendation_events
      WHERE workspace_id = ? AND project_id = ? AND recommendation_id = ? ORDER BY created_at, rowid`,
    r.workspace_id,
    r.project_id,
    r.id,
  );
  const order = new Map(ids.map((id, i) => [id, i]));
  const [base] = await withProviders(db, [r]);
  return {
    ...base!,
    evidence: evidence
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
      .map((e) => ({ id: e.id, source: e.source, refId: e.ref_id, window: e.window, text: e.text, data: parseJson<unknown>(e.data_json, {}), tainted: e.tainted === 1, createdAt: e.created_at })),
    decisions: decisions.map(mapDecision),
    events: events.map((e) => ({ event: e.event, note: e.note, userId: e.user_id, createdAt: e.created_at })),
  };
}

async function agentState(c: { env: AppEnv["Bindings"] }, db: Db, project: ProjectRow, agent: AgentKind): Promise<CapabilityState> {
  if (project.is_demo === 1) return "demo";
  const [caps, writer] = await Promise.all([capabilityPresence(c.env, db, project.workspace_id), writerStatusForWorkspace(c.env, db, project.workspace_id)]);
  // Default writer: a key plus WRITER_PROVIDER/WRITER_MODEL; a selected custom writer brings its own config.
  if (!writer.configured) return "setup_required";
  if (agent === "seo") {
    const gsc = await db.first<{ status: string }>(
      "SELECT status FROM oauth_connections WHERE workspace_id = ? AND project_id = ? AND provider = 'google_gsc'",
      project.workspace_id,
      project.id,
    );
    const hasData = Boolean(project.verified_host) || (gsc?.status === "connected" && Boolean(project.gsc_property));
    return hasData ? "ready" : "setup_required";
  }
  return anyGeoEngineConfigured(caps) ? "ready" : "setup_required";
}

/**
 * Status transition for one recommendation of `project` by `userId` (Ask Okara's confirmed approve/dismiss
 * action). Same transition table and event as PATCH /recommendations/:id; conditional on the current status
 * so a concurrent change cannot be overwritten. Throws 404 (not in this project) or 409 (invalid transition).
 */
export async function setRecommendationStatus(
  db: Db,
  project: Pick<ProjectRow, "id" | "workspace_id">,
  userId: string,
  id: string,
  status: Exclude<RecommendationStatus, "implemented">,
  note: string | null,
  now: Date,
): Promise<Recommendation> {
  const row = await db.first<RecRow>("SELECT * FROM recommendations WHERE id = ? AND workspace_id = ? AND project_id = ?", id, project.workspace_id, project.id);
  if (!row) throw notFound("Recommendation");
  if (row.status !== status) {
    if (!TRANSITIONS[row.status].includes(status)) throw conflict(`Cannot change status from ${row.status} to ${status}.`);
    const at = iso(now);
    await db.batch([
      [
        "UPDATE recommendations SET status = ?, stage = 'awaiting_approval', updated_at = ? WHERE id = ? AND workspace_id = ? AND status = ?",
        status,
        at,
        row.id,
        row.workspace_id,
        row.status,
      ],
      [
        "INSERT INTO recommendation_events (id, workspace_id, project_id, recommendation_id, user_id, event, note, created_at) VALUES (?,?,?,?,?,?,?,?)",
        newId("rev"),
        row.workspace_id,
        row.project_id,
        row.id,
        userId,
        EVENT_FOR[status],
        note,
        at,
      ],
    ]);
  }
  const updated = await db.first<RecRow>("SELECT * FROM recommendations WHERE id = ? AND workspace_id = ?", row.id, row.workspace_id);
  const [rec] = await withProviders(db, [updated!]);
  return rec!;
}

/** Allowed next statuses (UI + Ask Okara validation). */
export const RECOMMENDATION_TRANSITIONS: Readonly<Record<RecommendationStatus, readonly RecommendationStatus[]>> = TRANSITIONS;

export const recommendationRoutes = new Hono<AppEnv>();

recommendationRoutes.get("/projects/:pid/recommendations", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  const agent = c.req.query("agent");
  const status = c.req.query("status");
  if (agent !== undefined && agent !== "seo" && agent !== "geo") throw badRequest("agent must be seo or geo.");
  if (status !== undefined && !(status in TRANSITIONS)) throw badRequest("status must be open, approved, dismissed, or implemented.");
  const where = ["workspace_id = ?", "project_id = ?"];
  const params: unknown[] = [project.workspace_id, project.id];
  if (agent) {
    where.push("agent = ?");
    params.push(agent);
  }
  if (status) {
    where.push("status = ?");
    params.push(status);
  }
  const rows = await db.all<RecRow>(
    `SELECT * FROM recommendations WHERE ${where.join(" AND ")} ORDER BY created_at DESC, priority DESC LIMIT 200`,
    ...params,
  );
  return c.json({ data: await withProviders(db, rows) });
});

recommendationRoutes.get("/recommendations/:id", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const row = await loadRecForUser(db, user.id, c.req.param("id"));
  return c.json({ data: await recommendationDetail(db, row) });
});

recommendationRoutes.patch("/recommendations/:id", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const now = iso(c.get("now"));
  const row = await loadRecForUser(db, user.id, c.req.param("id"));
  const parsed = patchBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw badRequest("Invalid recommendation update.", parsed.error.issues.map((i) => i.message));
  const body = parsed.data;
  if (body.status === undefined && body.action === undefined && body.suggestedSnippet === undefined) {
    throw badRequest("Nothing to update.");
  }

  const statements: Array<[string, ...unknown[]]> = [];
  const event = (name: string, note: string | null): [string, ...unknown[]] => [
    "INSERT INTO recommendation_events (id, workspace_id, project_id, recommendation_id, user_id, event, note, created_at) VALUES (?,?,?,?,?,?,?,?)",
    newId("rev"),
    row.workspace_id,
    row.project_id,
    row.id,
    user.id,
    name,
    note,
    now,
  ];

  // Edits (only while not implemented).
  const changed: string[] = [];
  if (body.action !== undefined && body.action !== row.action) changed.push("action");
  if (body.suggestedSnippet !== undefined && (body.suggestedSnippet ?? null) !== row.suggested_snippet) changed.push("suggested snippet");
  if (changed.length > 0) {
    if (row.status === "implemented") throw conflict("Implemented recommendations cannot be edited.");
    statements.push([
      "UPDATE recommendations SET action = ?, suggested_snippet = ?, updated_at = ? WHERE id = ? AND workspace_id = ?",
      body.action ?? row.action,
      body.suggestedSnippet !== undefined ? body.suggestedSnippet : row.suggested_snippet,
      now,
      row.id,
      row.workspace_id,
    ]);
    statements.push(event("edited", `Edited ${changed.join(" and ")}.${body.note ? ` ${body.note}` : ""}`));
  }

  // Status transition.
  if (body.status !== undefined && body.status !== row.status) {
    if (!TRANSITIONS[row.status].includes(body.status)) {
      throw conflict(`Cannot change status from ${row.status} to ${body.status}.`);
    }
    const stage = body.status === "implemented" ? "marked_implemented" : "awaiting_approval";
    statements.push([
      "UPDATE recommendations SET status = ?, stage = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND status = ?",
      body.status,
      stage,
      now,
      row.id,
      row.workspace_id,
      row.status,
    ]);
    const note = body.status === "implemented" ? (body.note ? `${IMPLEMENTED_NOTE} ${body.note}` : IMPLEMENTED_NOTE) : body.note ?? null;
    statements.push(event(EVENT_FOR[body.status], note));
  }

  await db.batch(statements);
  const updated = await db.first<RecRow>("SELECT * FROM recommendations WHERE id = ? AND workspace_id = ?", row.id, row.workspace_id);
  const [rec] = await withProviders(db, [updated!]);
  return c.json({ data: rec });
});

recommendationRoutes.post("/decisions/:id/feedback", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const decision = await db.first<{ id: string; workspace_id: string; project_id: string }>(
    `SELECT d.id, d.workspace_id, d.project_id FROM decision_records d
       JOIN memberships m ON m.workspace_id = d.workspace_id AND m.user_id = ? WHERE d.id = ?`,
    user.id,
    c.req.param("id"),
  );
  if (!decision) throw notFound("Decision");
  await requireProject(db, user.id, decision.project_id);
  const parsed = feedbackBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw badRequest("Body must be {humanAnswer, reason?}.");
  const id = newId("fb");
  const now = iso(c.get("now"));
  await db.insert("judgment_feedback", {
    id,
    workspace_id: decision.workspace_id,
    project_id: decision.project_id,
    decision_record_id: decision.id,
    user_id: user.id,
    human_answer: parsed.data.humanAnswer,
    reason: parsed.data.reason ?? null,
    created_at: now,
  });
  return c.json({ data: { ok: true } }, 201);
});

recommendationRoutes.get("/projects/:pid/attention", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  return c.json({ data: await buildAttentionFeed(c.env, db, project, c.get("now")) });
});

/** Attention feed (route GET /attention and Ask Okara): per-agent counts and state, recent events, failing syncs, link checks. */
export async function buildAttentionFeed(env: AppEnv["Bindings"], db: Db, project: ProjectRow, now: Date): Promise<AttentionFeed> {
  const c = { env };
  const day = utcDay(now);
  const agents: AttentionFeed["agents"] = [];
  for (const agent of ["seo", "geo"] as const) {
    const counts = await db.first<{ new_today: number; open: number }>(
      `SELECT SUM(CASE WHEN substr(created_at, 1, 10) = ? THEN 1 ELSE 0 END) AS new_today,
              SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open
         FROM recommendations WHERE workspace_id = ? AND project_id = ? AND agent = ?`,
      day,
      project.workspace_id,
      project.id,
      agent,
    );
    const last = await db.first<RunRow>(
      "SELECT * FROM agent_runs WHERE workspace_id = ? AND project_id = ? AND agent = ? ORDER BY created_at DESC, id DESC LIMIT 1",
      project.workspace_id,
      project.id,
      agent,
    );
    const newToday = Number(counts?.new_today ?? 0);
    agents.push({
      agent,
      newToday,
      openApprovals: Number(counts?.open ?? 0),
      lastRun: last ? toRunSummary(last) : null,
      state: await agentState(c, db, project, agent),
      zeroStateMessage: newToday === 0 ? ZERO_STATE_MESSAGE : null,
    });
  }
  const events = await db.all(
    `SELECT e.*, r.agent FROM run_events e JOIN agent_runs r ON r.id = e.run_id
      WHERE e.workspace_id = ? AND e.project_id = ? ORDER BY e.created_at DESC, e.rowid DESC LIMIT 20`,
    project.workspace_id,
    project.id,
  );
  const syncs = await failingSyncs(db, project);
  const feed: AttentionFeed = {
    agents,
    recentEvents: events.map(mapEvent),
    importSyncs: syncs.map((s) => ({ id: s.id, spreadsheetTitle: s.spreadsheetTitle, tab: s.tab, destination: s.destination, code: s.lastErrorCode, message: s.lastError, lastRunAt: s.lastRunAt })),
    // Internal links workbench: implemented or sheet-placed links the latest crawl of their source page did not find.
    linkVerification: await linkVerificationAttention(db, project),
    // Backlink monitor: new negative changes (lost, nofollow, 404, redirected, noindex, target broken) in the last 7 days.
    backlinkChanges: await backlinkAttention(db, project, now),
  };
  return feed;
}
