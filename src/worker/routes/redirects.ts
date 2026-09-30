/**
 * Redirect map tool [A23]. OWNED BY: redirects module.
 *   POST /projects/:pid/seo/redirect-map   body RedirectMapRequest -> RedirectMapResult
 *
 * - Tenancy: requireUser + requireProject (404 for non-members).
 * - Rate limit: REDIRECT_MAP_RATE_LIMIT per user + project (checked before the body is read).
 * - Body: at most MAX_REDIRECT_BODY_BYTES; zod-validated (oldUrls 1..500, newUrls <= 5,000, each
 *   <= 2,048 characters; useJev optional).
 * - Jev: used when TypeSafe is configured for the workspace and useJev !== false; calls are recorded
 *   in provider_calls and reserved against the project's daily provider_calls/jev_calls budget.
 *   Demo projects never call Jev.
 * - Nothing is fetched from the site and nothing is changed: the result (rows + Shopify CSV) is a
 *   suggestion for review.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { RedirectMapResult } from "@shared/types";
import type { AppEnv } from "../app";
import type { Env } from "../env";
import type { Db } from "../lib/db";
import { badRequest, HttpError } from "../lib/errors";
import { requireProject } from "../platform/access";
import { hitRateLimit } from "../platform/rate-limit";
import { requireUser } from "../platform/require-user";
import type { DecisionProvider } from "../providers/types";
import { buildDecisionsForWorkspace } from "../redirects/decisions";
import { buildRedirectMap, MAX_NEW_URLS, MAX_OLD_URLS, MAX_URL_LENGTH } from "../redirects/service";

export const redirectRoutes = new Hono<AppEnv>();

export const REDIRECT_MAP_RATE_LIMIT = { limit: 5, windowSeconds: 60 } as const;
/** 500 old + 5,000 new URLs of typical length fit comfortably; worst-case 2,048-char lists do not. */
export const MAX_REDIRECT_BODY_BYTES = 2 * 1024 * 1024;

export const redirectMapSchema = z
  .object({
    oldUrls: z.array(z.string().max(MAX_URL_LENGTH)).min(1).max(MAX_OLD_URLS),
    newUrls: z.array(z.string().max(MAX_URL_LENGTH)).max(MAX_NEW_URLS).optional(),
    useJev: z.boolean().optional(),
  })
  .strict();

type DecisionsFactory = (env: Env, db: Db, workspaceId: string, projectId: string) => Promise<DecisionProvider | null>;
const defaultFactory: DecisionsFactory = (env, db, workspaceId, projectId) => buildDecisionsForWorkspace(env, db, workspaceId, projectId);
let decisionsFactory: DecisionsFactory = defaultFactory;

/** Test hook: inject the DecisionProvider factory. Pass null to restore the real one. */
export function setRedirectDecisionsFactory(f: DecisionsFactory | null): void {
  decisionsFactory = f ?? defaultFactory;
}

async function readBody(c: { req: { header(name: string): string | undefined; text(): Promise<string> } }): Promise<z.infer<typeof redirectMapSchema>> {
  const declared = Number(c.req.header("Content-Length") ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_REDIRECT_BODY_BYTES) throw new HttpError(413, "payload_too_large", "Request body is too large (2 MB maximum).");
  const raw = await c.req.text();
  if (raw.length > MAX_REDIRECT_BODY_BYTES) throw new HttpError(413, "payload_too_large", "Request body is too large (2 MB maximum).");
  let json: unknown;
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    throw badRequest("Request body must be JSON.");
  }
  const parsed = redirectMapSchema.safeParse(json);
  if (!parsed.success) {
    throw badRequest(
      `Invalid request body. Send 1 to ${MAX_OLD_URLS} old URLs and at most ${MAX_NEW_URLS.toLocaleString("en-US")} new URLs, each up to ${MAX_URL_LENGTH} characters.`,
      parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return parsed.data;
}

redirectRoutes.post("/projects/:pid/seo/redirect-map", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  const now = c.get("now");

  const rl = await hitRateLimit(db, `redirect_map:${project.id}:${user.id}`, REDIRECT_MAP_RATE_LIMIT.limit, REDIRECT_MAP_RATE_LIMIT.windowSeconds, now);
  if (!rl.allowed) {
    return c.json(
      { error: { code: "rate_limited", message: "Too many redirect-map requests. Try again in a minute." } },
      429,
      { "Retry-After": String(rl.retryAfterSeconds) },
    );
  }

  const body = await readBody(c);
  const wantJev = body.useJev !== false && project.is_demo !== 1;
  const decisions = wantJev ? await decisionsFactory(c.env, db, project.workspace_id, project.id) : null;
  const data: RedirectMapResult = await buildRedirectMap(
    { oldUrls: body.oldUrls, newUrls: body.newUrls, useJev: body.useJev },
    { db, project, decisions, now },
  );
  return c.json({ data });
});
