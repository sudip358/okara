/**
 * Fixed-window rate limiter backed by the D1 `rate_limits` table. OWNED BY: platform-auth module.
 * Each (key, window_start) row is incremented with a single atomic upsert, so concurrent requests
 * cannot both read a stale count. Old windows for a key are pruned when a new window opens.
 */
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../app";
import type { Db } from "../lib/db";

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  /** Seconds until the current window ends. */
  retryAfterSeconds: number;
}

export function windowStart(now: Date, windowSeconds: number): string {
  const ms = windowSeconds * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms).toISOString();
}

/** Increment the counter for `key` in the current window and report whether the limit is exceeded. */
export async function hitRateLimit(db: Db, key: string, limit: number, windowSeconds: number, now: Date): Promise<RateLimitResult> {
  const start = windowStart(now, windowSeconds);
  const row = await db.first<{ count: number }>(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1
     RETURNING count`,
    key,
    start,
  );
  const count = Number(row?.count ?? 1);
  if (count === 1) {
    // First hit in a fresh window: prune this key's older windows.
    await db.run("DELETE FROM rate_limits WHERE key = ? AND window_start < ?", key, start);
  }
  const windowEnd = new Date(start).getTime() + windowSeconds * 1000;
  return {
    allowed: count <= limit,
    count,
    limit,
    retryAfterSeconds: Math.max(1, Math.ceil((windowEnd - now.getTime()) / 1000)),
  };
}

/** Best-effort client identifier: the signed-in user, else the Cloudflare-provided client IP. */
export function clientKey(c: Context<AppEnv>): string {
  const user = c.get("user");
  if (user) return `u:${user.id}`;
  const ip = c.req.header("CF-Connecting-IP");
  return `ip:${ip && ip.length <= 64 ? ip : "unknown"}`;
}

export interface RateLimitOptions {
  /** Bucket name, or a function deriving the full key from the request. */
  key: string | ((c: Context<AppEnv>) => string);
  limit: number;
  windowSeconds: number;
}

/** Middleware factory. A string key is combined with the client identifier (user id or IP). */
export function rateLimit(opts: RateLimitOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const key = typeof opts.key === "function" ? opts.key(c) : `${opts.key}:${clientKey(c)}`;
    const res = await hitRateLimit(c.get("db"), key.slice(0, 300), opts.limit, opts.windowSeconds, c.get("now"));
    if (!res.allowed) {
      return c.json(
        { error: { code: "rate_limited", message: "Too many requests. Try again shortly." } },
        429,
        { "Retry-After": String(res.retryAfterSeconds) },
      );
    }
    await next();
  };
}
