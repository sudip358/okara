/**
 * Security middleware. OWNED BY: platform-auth module. Stubs keep the app bootable until implemented.
 * - securityHeaders: CSP, HSTS, frame-ancestors, nosniff, referrer policy
 * - loadSession: resolve session cookie -> c.var.user/session
 * - csrfProtection: Origin check + X-CSRF-Token for state-changing requests
 */
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app";

export const securityHeaders = (): MiddlewareHandler<AppEnv> => async (_c, next) => next();
export const loadSession = (): MiddlewareHandler<AppEnv> => async (_c, next) => next();
export const csrfProtection = (): MiddlewareHandler<AppEnv> => async (_c, next) => next();
