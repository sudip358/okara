/**
 * Draft / page quality check [A23]. OWNED BY: draft-check module.
 *   POST /projects/:pid/seo/draft-check   body DraftCheckRequest -> DraftCheckResult
 *
 * - Tenancy: requireUser + requireProject (404 for non-members); a pageId must belong to the project.
 * - Rate limit: DRAFT_CHECK_RATE_LIMIT per user + project (checked before the body is read).
 * - Body: at most MAX_DRAFT_BODY_BYTES; zod-validated: targetQuery 1..200 characters, exactly one of
 *   pageId | draftText (draftText at most 60,000 characters), optional title (<= 300) and
 *   metaDescription (<= 1,000; the same limits as the web form).
 * - Jev: used when TypeSafe is configured for the workspace (never for demo projects); calls are recorded
 *   in provider_calls and reserved against the project's daily provider_calls / jev_calls budget.
 * - Nothing is fetched from the site and the draft is not stored (only Jev decision_records are).
 */
import { Hono } from "hono";
import { z } from "zod";
import type { DraftCheckResult } from "@shared/types";
import type { AppEnv } from "../app";
import { runDraftCheck } from "../draftcheck/service";
import { MAX_DRAFT_CHARS } from "../draftcheck/parse";
import type { Env } from "../env";
import type { Db } from "../lib/db";
import { badRequest, HttpError } from "../lib/errors";
import { requireProject } from "../platform/access";
import { hitRateLimit } from "../platform/rate-limit";
import { requireUser } from "../platform/require-user";
import type { DecisionProvider } from "../providers/types";
import { buildDecisionsForWorkspace } from "../redirects/decisions";

export const draftCheckRoutes = new Hono<AppEnv>();

export const DRAFT_CHECK_RATE_LIMIT = { limit: 10, windowSeconds: 60 } as const;
/** 60,000 characters of text, JSON-escaped (worst case ~6 bytes per character), plus the other fields. */
export const MAX_DRAFT_BODY_BYTES = 512 * 1024;

export const draftCheckSchema = z
  .object({
    targetQuery: z.string().trim().min(1).max(200),
    pageId: z.string().trim().min(1).max(100).optional(),
    draftText: z.string().max(MAX_DRAFT_CHARS).optional(),
    title: z.string().max(300).optional(),
    metaDescription: z.string().max(1000).optional(),
  })
  .strict()
  .refine((b) => (b.pageId !== undefined) !== (b.draftText !== undefined), { message: "Send exactly one of pageId or draftText.", path: ["draftText"] })
  .refine((b) => b.draftText === undefined || b.draftText.trim().length > 0, { message: "draftText is empty.", path: ["draftText"] });

type DecisionsFactory = (env: Env, db: Db, workspaceId: string, projectId: string) => Promise<DecisionProvider | null>;
const defaultFactory: DecisionsFactory = (env, db, workspaceId, projectId) => buildDecisionsForWorkspace(env, db, workspaceId, projectId);
let decisionsFactory: DecisionsFactory = defaultFactory;

/** Test hook: inject the DecisionProvider factory. Pass null to restore the real one. */
export function setDraftCheckDecisionsFactory(f: DecisionsFactory | null): void {
  decisionsFactory = f ?? defaultFactory;
}

async function readBody(c: { req: { header(name: string): string | undefined; text(): Promise<string> } }): Promise<z.infer<typeof draftCheckSchema>> {
  const tooLarge = () => new HttpError(413, "payload_too_large", "Request body is too large (512 KB maximum).");
  const declared = Number(c.req.header("Content-Length") ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_DRAFT_BODY_BYTES) throw tooLarge();
  const raw = await c.req.text();
  if (raw.length > MAX_DRAFT_BODY_BYTES) throw tooLarge();
  let json: unknown;
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    throw badRequest("Request body must be JSON.");
  }
  const parsed = draftCheckSchema.safeParse(json);
  if (!parsed.success) {
    throw badRequest(
      `Invalid request body. Send a target query (1 to 200 characters) and exactly one of pageId or draftText (at most ${MAX_DRAFT_CHARS.toLocaleString("en-US")} characters).`,
      parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return parsed.data;
}

draftCheckRoutes.post("/projects/:pid/seo/draft-check", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  const now = c.get("now");

  const rl = await hitRateLimit(db, `draft_check:${project.id}:${user.id}`, DRAFT_CHECK_RATE_LIMIT.limit, DRAFT_CHECK_RATE_LIMIT.windowSeconds, now);
  if (!rl.allowed) {
    return c.json(
      { error: { code: "rate_limited", message: "Too many draft checks. Try again in a minute." } },
      429,
      { "Retry-After": String(rl.retryAfterSeconds) },
    );
  }

  const body = await readBody(c);
  const decisions = project.is_demo === 1 ? null : await decisionsFactory(c.env, db, project.workspace_id, project.id);
  const data: DraftCheckResult = await runDraftCheck(
    { targetQuery: body.targetQuery, pageId: body.pageId, draftText: body.draftText, title: body.title, metaDescription: body.metaDescription },
    { db, project, decisions, now },
  );
  return c.json({ data });
});
