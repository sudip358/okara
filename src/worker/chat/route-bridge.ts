/**
 * [A35] Ask Okara -> existing route handlers, in-process. The credential / provider / integration actions call
 * the very route the Integrations and Settings pages call (same handler code): same role check
 * (requireWorkspaceOwner / requireProject), same validation (validateCustomBaseUrl, keepKeyForNewHost, model id
 * rules, operator-key spend guard), same rate-limit middleware and keys (`cred_write:<wid>:<user>`,
 * `cprov_write:...`, `maton_write:...`, `dfs_settings:...`, `verify_check:...`, ...), so the UI's limits are
 * shared. The request runs as the chat's signed-in user (re-read from `users`; membership is re-checked by the
 * route itself). CSRF does not apply: there is no browser request here; the user's own Confirm POST to the chat
 * route already passed the global CSRF check.
 *
 * Never used to carry a key: no bridged request body contains an API key (secrets go browser -> route directly).
 */
import { Hono } from "hono";
import type { AppEnv } from "../app";
import { HttpError } from "../lib/errors";
import type { SessionUser } from "../platform/access";
import { credentialRoutes } from "../routes/credentials";
import { customProviderRoutes } from "../routes/custom-providers";
import { competitorDataRoutes } from "../routes/competitor-data";
import { integrationRoutes } from "../routes/integrations";
import { matonRoutes } from "../routes/maton";
import { projectRoutes } from "../routes/projects";
import { recommendationRoutes } from "../routes/recommendations";
import { ToolError, type ToolContext } from "./tool-base";

export type BridgeMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

function bridgeApp(ctx: ToolContext, user: SessionUser) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", ctx.db);
    c.set("now", ctx.now);
    c.set("user", user);
    c.set("session", null);
    await next();
  });
  for (const r of [credentialRoutes, customProviderRoutes, competitorDataRoutes, integrationRoutes, matonRoutes, projectRoutes, recommendationRoutes]) app.route("/", r);
  app.notFound((c) => c.json({ error: { code: "not_found", message: "Not found." } }, 404));
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    return c.json({ error: { code: "internal", message: "Something went wrong." } }, 500);
  });
  return app;
}

export class RouteError extends ToolError {
  constructor(message: string, public readonly status: number, public readonly code: string) {
    super(message);
  }
}

/** Call an existing route as the chat's user; returns its `data`, or throws a RouteError with the route's message. */
export async function callRoute<T>(ctx: ToolContext, method: BridgeMethod, path: string, body?: Record<string, unknown>): Promise<T> {
  const user = await ctx.db.first<SessionUser>("SELECT id, email, name FROM users WHERE id = ?", ctx.userId);
  if (!user) throw new ToolError("Your account no longer exists.");
  const exec = ctx.waitUntil ? { waitUntil: ctx.waitUntil, passThroughOnException() {}, props: {} } : undefined;
  const res = await bridgeApp(ctx, user).request(
    path,
    { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) },
    ctx.env,
    exec as never,
  );
  const text = await res.text();
  let json: { data?: T; error?: { code?: string; message?: string } } = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  if (!res.ok) {
    const code = json.error?.code ?? `http_${res.status}`;
    const msg = (json.error?.message ?? `The request failed (HTTP ${res.status}).`).slice(0, 400);
    throw new RouteError(code === "setup_required" ? `setup_required: ${msg}` : res.status === 429 ? `${msg} (rate limit shared with the app)` : msg, res.status, code);
  }
  return json.data as T;
}
