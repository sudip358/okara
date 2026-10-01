/**
 * AI engine board routes (docs/api.md "AI engine board"; UI docs/geo-board-design.md). Every handler:
 * requireUser + requireProject (404 for non-members); every query is scoped by workspace_id + project_id.
 *
 *   GET  /projects/:pid/geo/board                                   -> EngineBoardResponse (stored data only)
 *   GET  /projects/:pid/geo/pages/:pageId/skip-factors?promptId=&engine= -> PageSkipFactors (crawl data only)
 *   POST /projects/:pid/geo/competitor-pages  {url}                 -> 202 CompetitorPageAssessment (200 when reused)
 *   GET  /projects/:pid/geo/competitor-pages                        -> CompetitorPageAssessment[]
 *   GET  /projects/:pid/geo/rewrite-plans                           -> RewritePlansResponse (stored data only)
 *
 * The POST is state-changing: the app-wide csrfProtection middleware enforces same-origin Origin and the
 * session's X-CSRF-Token. It is rate-limited per project (COMPETITOR_PAGE_RATE_LIMIT), budgeted
 * (1 crawl_pages unit; Jev calls reserve provider_calls + jev_calls), and fetches the single approved URL
 * through the SSRF guard (seo/ssrf.ts approvedExternalFetch). Demo projects never fetch or call Jev.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { GeoEngineProviderId } from "@shared/types";
import type { AppEnv } from "../app";
import type { Env } from "../env";
import type { Db } from "../lib/db";
import { badRequest, HttpError } from "../lib/errors";
import { requireProject } from "../platform/access";
import { hitRateLimit } from "../platform/rate-limit";
import { requireUser } from "../platform/require-user";
import type { DecisionProvider } from "../providers/types";
import { buildDecisionsForWorkspace } from "../redirects/decisions";
import { createBudget } from "../runs/budget";
import type { Budget } from "../runs/context";
import { buildEngineBoard, BOARD_LANES } from "../geo/board";
import { approveCompetitorPage, citedPageFactors, listCompetitorPages, MAX_URL_LENGTH, RateLimitedError } from "../geo/competitor-pages";
import { buildRewritePlans } from "../geo/rewrite-plan";
import { buildPageSkipFactors } from "../geo/skip-factors";

export const geoBoardRoutes = new Hono<AppEnv>();

/** Max request body for the approval POST (a URL of at most 2,048 characters plus JSON framing). */
export const MAX_APPROVAL_BODY_BYTES = 8 * 1024;

const approvalSchema = z.object({ url: z.string().trim().min(1).max(MAX_URL_LENGTH) }).strict();

// ------------------------------------------------------------------ injectable dependencies (tests)
type DecisionsFactory = (env: Env, db: Db, workspaceId: string, projectId: string) => Promise<DecisionProvider | null>;
type BudgetFactory = (env: Env, db: Db, workspaceId: string, projectId: string) => Budget;
export interface GeoBoardHooks {
  decisions?: DecisionsFactory | null;
  /** Platform fetch used for the single approved URL (always wrapped by the SSRF guard). */
  fetch?: typeof fetch | null;
  budget?: BudgetFactory | null;
}
const defaults = {
  decisions: ((env, db, ws, pid) => buildDecisionsForWorkspace(env, db, ws, pid)) as DecisionsFactory,
  fetch: ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)) as typeof fetch,
  budget: ((env, db, ws, pid) => createBudget(db, env, { workspaceId: ws, projectId: pid, runId: null })) as BudgetFactory,
};
let hooks = { ...defaults };

/** Test hook: inject Jev, the outbound fetch, or the budget. Pass null (or omit) to restore a default. */
export function setGeoBoardHooks(h: GeoBoardHooks): void {
  hooks = {
    decisions: h.decisions ?? defaults.decisions,
    fetch: h.fetch ?? defaults.fetch,
    budget: h.budget ?? defaults.budget,
  };
}

function isEngine(v: string): v is GeoEngineProviderId {
  return (BOARD_LANES as readonly string[]).includes(v);
}

// ------------------------------------------------------------------ routes
geoBoardRoutes.get("/projects/:pid/geo/board", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  return c.json({ data: await buildEngineBoard(c.env, db, project, c.get("now")) });
});

geoBoardRoutes.get("/projects/:pid/geo/pages/:pageId/skip-factors", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  const promptId = c.req.query("promptId")?.trim() || null;
  const engineRaw = c.req.query("engine")?.trim() || null;
  if (promptId && promptId.length > 100) throw badRequest("promptId is too long.");
  if (engineRaw !== null && !isEngine(engineRaw)) throw badRequest(`engine must be one of ${BOARD_LANES.join(", ")}.`);
  const data = await buildPageSkipFactors(db, project, c.req.param("pageId"), { promptId, engine: engineRaw as GeoEngineProviderId | null }, c.get("now"), citedPageFactors);
  return c.json({ data });
});

geoBoardRoutes.get("/projects/:pid/geo/competitor-pages", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  return c.json({ data: await listCompetitorPages(db, project) });
});

geoBoardRoutes.post("/projects/:pid/geo/competitor-pages", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  const now = c.get("now");

  const declared = Number(c.req.header("Content-Length") ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_APPROVAL_BODY_BYTES) throw new HttpError(413, "payload_too_large", "Request body is too large.");
  const raw = await c.req.text();
  if (raw.length > MAX_APPROVAL_BODY_BYTES) throw new HttpError(413, "payload_too_large", "Request body is too large.");
  let json: unknown;
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    throw badRequest("Request body must be JSON.");
  }
  const parsed = approvalSchema.safeParse(json);
  if (!parsed.success) throw badRequest("Send {url}: the cited page URL (at most 2,048 characters).", { reason: "invalid_url" });

  if (project.is_demo === 1) {
    throw badRequest("Demo projects never fetch pages. Create a real project to approve reading a cited page.", { reason: "demo_project" });
  }

  try {
    const result = await approveCompetitorPage(
      {
        env: c.env,
        db,
        project,
        userId: user.id,
        now,
        fetchImpl: hooks.fetch,
        decisions: await hooks.decisions(c.env, db, project.workspace_id, project.id),
        budget: hooks.budget(c.env, db, project.workspace_id, project.id),
        rateLimit: (key, limit, windowSeconds) => hitRateLimit(db, key, limit, windowSeconds, now),
      },
      parsed.data.url,
    );
    return c.json({ data: result.assessment }, result.status);
  } catch (e) {
    if (e instanceof RateLimitedError) {
      return c.json({ error: { code: e.code, message: e.message } }, 429, { "Retry-After": String(e.retryAfterSeconds) });
    }
    throw e;
  }
});

geoBoardRoutes.get("/projects/:pid/geo/rewrite-plans", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  return c.json({ data: await buildRewritePlans(db, project, c.get("now")) });
});
