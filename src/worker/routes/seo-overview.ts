/**
 * SEO overview + GSC CSV import (seo-analysis module) and the [A23]/[A25] Search Console views.
 *   GET  /projects/:pid/seo/overview    -> SeoOverview (incl. brandSplit and the non-brand demand curve)
 *   POST /projects/:pid/seo/import-csv  -> body {csv, window:'current'|'previous', start, end}; labelled csv_import
 *                                          201 {data:{syncId, rows, window}}; 400 with details.expectedHeaders on bad input
 *   GET  /projects/:pid/seo/buyer-queries             -> CoverageResponse<BuyerQueryRow> from the 7-day decision
 *                                                        cache only (never calls Jev; setup_required without Jev)
 *   POST /projects/:pid/seo/buyer-queries             -> same shape; asks Jev for uncached queries (rate-limited,
 *                                                        budgeted, at most BUYER_CALLS_PER_REQUEST calls per POST;
 *                                                        POST again to continue, at most
 *                                                        BUYER_CLASSIFY_DAILY_LIMIT POSTs per project per day). Spending is POST-only so a
 *                                                        cross-site GET cannot. Scope: all non-brand queries up to
 *                                                        the BUYER_QUERIES_MAX env cap (default 5,000).
 *   GET  /projects/:pid/seo/translation-opportunities -> CoverageResponse<TranslationOpportunityRow> (no Jev)
 * CSRF/origin checks for the POSTs are enforced by the app-wide middleware.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app";
import { requireUser } from "../platform/require-user";
import { badRequest, HttpError } from "../lib/errors";
import { requireProject } from "../platform/access";
import { CSV_MAX_BYTES, EXPECTED_CSV_HEADERS, importGscCsv } from "../seo/gsc/csv";
import { buildSeoOverview } from "../seo/gsc/overview";
import { buildTranslationOpportunities } from "../seo/gsc/translation";
import { BUYER_CLASSIFY_DAILY_LIMIT, buildBuyerQueries, buyerQueryCap } from "../seo/recommend/buyer-queries";
import type { Env } from "../env";
import type { Db } from "../lib/db";
import { hitRateLimit } from "../platform/rate-limit";
import type { DecisionProvider } from "../providers/types";
import { buildDecisionsForWorkspace } from "../redirects/decisions";
import { budgetFor, createBudget } from "../runs/budget";
import { createCallRecorder } from "../runs/calls";

export const seoOverviewRoutes = new Hono<AppEnv>();

/** Buyer-query classification can spend Jev calls: per user + project. */
export const BUYER_QUERIES_RATE_LIMIT = { limit: 10, windowSeconds: 60 } as const;

type DecisionsFactory = (env: Env, db: Db, workspaceId: string, projectId: string) => Promise<DecisionProvider | null>;
const defaultDecisionsFactory: DecisionsFactory = (env, db, workspaceId, projectId) => buildDecisionsForWorkspace(env, db, workspaceId, projectId);
let decisionsFactory: DecisionsFactory = defaultDecisionsFactory;

/** Test hook: inject the DecisionProvider factory for the buyer-query view. Pass null to restore. */
export function setSeoJevDecisionsFactory(f: DecisionsFactory | null): void {
  decisionsFactory = f ?? defaultDecisionsFactory;
}

async function buyerQueries(c: Context<AppEnv, "/projects/:pid/seo/buyer-queries">, classify: boolean) {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  const now = c.get("now");
  if (classify) {
    const rl = await hitRateLimit(db, `buyer_queries:${project.id}:${user.id}`, BUYER_QUERIES_RATE_LIMIT.limit, BUYER_QUERIES_RATE_LIMIT.windowSeconds, now);
    if (!rl.allowed) {
      return c.json({ error: { code: "rate_limited", message: "Too many buyer-query requests. Try again in a minute." } }, 429, { "Retry-After": String(rl.retryAfterSeconds) });
    }
  }
  const decisions = project.is_demo === 1 ? null : await decisionsFactory(c.env, db, project.workspace_id, project.id);
  if (classify && decisions) {
    // Separate daily cap so buyer-query spending cannot drain the project's shared Jev/provider allowance.
    const day = await hitRateLimit(db, `buyer_queries_day:${project.id}`, BUYER_CLASSIFY_DAILY_LIMIT, 86_400, now);
    if (!day.allowed) {
      return c.json(
        {
          error: {
            code: "rate_limited",
            message: `Buyer-query classification is limited to ${BUYER_CLASSIFY_DAILY_LIMIT} requests per project per day. Cached answers are kept; continue tomorrow.`,
          },
        },
        429,
        { "Retry-After": String(day.retryAfterSeconds) },
      );
    }
  }
  const scope = { workspaceId: project.workspace_id, projectId: project.id, runId: null };
  const clock = () => now;
  // Optional operator setting: BUYER_QUERIES_MAX caps the queries in scope.
  const maxQueries = buyerQueryCap(c.env.BUYER_QUERIES_MAX);
  const data = await buildBuyerQueries({ db, project, now, decisions, budget: budgetFor(createBudget(db, c.env, scope, clock), "typesafe"), calls: createCallRecorder(db, scope, clock), classify, maxQueries });
  return c.json({ data });
}

/** Cached decisions only: a GET never spends Jev budget. */
seoOverviewRoutes.get("/projects/:pid/seo/buyer-queries", (c) => buyerQueries(c, false));
/** Classifies uncached queries with Jev (budgeted, rate-limited). */
seoOverviewRoutes.post("/projects/:pid/seo/buyer-queries", (c) => buyerQueries(c, true));

seoOverviewRoutes.get("/projects/:pid/seo/translation-opportunities", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  const data = await buildTranslationOpportunities(db, project, c.get("now"));
  return c.json({ data });
});

seoOverviewRoutes.get("/projects/:pid/seo/overview", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  const overview = await buildSeoOverview(db, project);
  return c.json({ data: overview });
});

const importBody = z.object({
  csv: z.string().min(1).max(CSV_MAX_BYTES),
  window: z.enum(["current", "previous"]),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/** JSON envelope allowance on top of the 2 MB CSV (escaping can grow it). */
const MAX_BODY_BYTES = CSV_MAX_BYTES * 2 + 4096;

seoOverviewRoutes.post("/projects/:pid/seo/import-csv", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  const len = Number(c.req.header("content-length") ?? "0");
  if (len > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large", "Upload is larger than 2 MB.");
  let raw: unknown;
  try {
    const text = await c.req.text();
    if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large", "Upload is larger than 2 MB.");
    raw = JSON.parse(text);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw badRequest("Body must be JSON.");
  }
  const parsed = importBody.safeParse(raw);
  if (!parsed.success) {
    throw badRequest("Invalid import request.", {
      expectedHeaders: EXPECTED_CSV_HEADERS,
      errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
  }
  const result = await importGscCsv(
    db,
    { workspaceId: project.workspace_id, projectId: project.id, userId: user.id, property: project.gsc_property, now: c.get("now") },
    parsed.data,
  );
  return c.json({ data: { syncId: result.syncId, rows: result.rows, window: result.window } }, 201);
});
