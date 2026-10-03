/**
 * robots.txt advisor route [A19]. OWNED BY: robots-advisor module.
 *   GET /projects/:pid/seo/robots-suggestion?allowTraining=true|false (default true) -> RobotsSuggestion
 *
 * - Tenancy: requireProject() (404 for non-members).
 * - Demo projects: a built-in, labelled demo robots.txt; nothing is fetched.
 * - Unverified projects: setup_required; nothing is fetched.
 * - Verified projects: GET https://<verified_host>/robots.txt through the SSRF guard (512 KB cap,
 *   10 s timeout, same-host redirects only, OkaraBot user agent), rate-limited per user + project.
 * The result is a suggestion for review; Okara never edits robots.txt.
 */
import { Hono } from "hono";
import type { CapabilityState, RobotsSuggestion } from "@shared/types";
import type { AppEnv } from "../app";
import { requireUser } from "../platform/require-user";
import { requireProject, type ProjectRow } from "../platform/access";
import type { Env } from "../env";
import type { Db } from "../lib/db";
import { hitRateLimit } from "../platform/rate-limit";
import { badRequest } from "../lib/errors";
import { CrawlFetchError, guardedFetch, type CrawlFetchErrorCode } from "../seo/ssrf";
import { crawlerUserAgent, ROBOTS_MAX_BYTES } from "../seo/crawl/robots";
import { ADVISOR_REVIEW_LABEL, CDN_WARNING, buildRobotsSuggestion, demoRobotsTxt } from "../seo/robots-advisor";
import { DEMO_HOST, DEMO_LABEL, DEMO_ORIGIN } from "../demo/fixtures";

export const robotsRoutes = new Hono<AppEnv>();

export const CURRENT_ROBOTS_DISPLAY_BYTES = 32 * 1024;
export const ROBOTS_ADVISOR_TIMEOUT_MS = 10_000;
export const ROBOTS_ADVISOR_RATE_LIMIT = { limit: 10, windowSeconds: 60 } as const;

const platformFetch: typeof fetch = (input, init) => fetch(input, init);
let robotsFetch: typeof fetch = platformFetch;

/** Inject a fetch implementation (tests). Pass null to restore the platform fetch. */
export function setRobotsAdvisorFetch(impl: typeof fetch | null): void {
  robotsFetch = impl ?? platformFetch;
}

function parseAllowTraining(raw: string | undefined): boolean {
  if (raw === undefined || raw === "") return true;
  const v = raw.toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  throw badRequest("allowTraining must be true or false.");
}

/** Cap text for display at `maxBytes` of UTF-8 without splitting a character. */
function capForDisplay(text: string, maxBytes: number): { text: string; capped: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) return { text, capped: false };
  const cut = new TextDecoder("utf-8").decode(bytes.subarray(0, maxBytes)).replace(/�+$/, "");
  return { text: cut, capped: true };
}

const FETCH_ERRORS: Record<CrawlFetchErrorCode, string> = {
  blocked_url: "the verified host is not a crawlable public hostname",
  redirect_offsite: "it redirected off the verified host, and the SSRF guard refused that redirect",
  too_many_redirects: "it redirected too many times",
  too_large: "the response was too large",
  timeout: `the request timed out after ${ROBOTS_ADVISOR_TIMEOUT_MS / 1000} s`,
  non_html: "it was served with a non-text content type",
  error: "of a network error",
};

function emptySuggestion(state: CapabilityState, allowTraining: boolean, fields: Partial<RobotsSuggestion> = {}): RobotsSuggestion {
  return {
    state,
    fetchedAt: null,
    currentRobotsTxt: null,
    policy: { allowTraining },
    suggestedRobotsTxt: null,
    preservedRules: [],
    changes: [],
    warnings: [],
    notes: [ADVISOR_REVIEW_LABEL],
    ...fields,
  };
}

robotsRoutes.get("/projects/:pid/seo/robots-suggestion", async (c) => {
  const user = requireUser(c);
  const db = c.get("db");
  const project = await requireProject(db, user.id, c.req.param("pid"));
  const allowTraining = parseAllowTraining(c.req.query("allowTraining"));
  const r = await robotsSuggestionFor(c.env, db, project, user.id, allowTraining, c.get("now"));
  if ("rateLimited" in r) {
    return c.json({ error: { code: "rate_limited", message: "Too many robots.txt checks. Try again shortly." } }, 429, { "Retry-After": String(r.retryAfterSeconds) });
  }
  return c.json({ data: r.data });
});

/**
 * The robots.txt suggestion (route GET /seo/robots-suggestion and Ask Okara's seo_audit view robots): demo fixture,
 * setup_required without a verified host, otherwise one SSRF-guarded GET of the verified host's robots.txt under
 * ROBOTS_ADVISOR_RATE_LIMIT per user + project (shared by both callers).
 */
export async function robotsSuggestionFor(
  env: Env,
  db: Db,
  project: ProjectRow,
  userId: string,
  allowTraining: boolean,
  now: Date,
): Promise<{ data: RobotsSuggestion } | { rateLimited: true; retryAfterSeconds: number }> {
  // Demo projects never fetch: show a labelled, illustrative robots.txt.
  if (project.is_demo) {
    const text = demoRobotsTxt(DEMO_ORIGIN, DEMO_LABEL);
    const core = buildRobotsSuggestion(text, { allowTraining, siteType: project.site_type, host: DEMO_HOST });
    const data: RobotsSuggestion = {
      state: "demo",
      fetchedAt: null,
      currentRobotsTxt: text,
      ...core,
      warnings: [`${DEMO_LABEL}: this robots.txt is illustrative (it resembles a typical Shopify default) and was not fetched from a live site.`, ...core.warnings],
    };
    return { data };
  }

  const host = project.verified_host;
  if (!host) {
    return {
      data: emptySuggestion("setup_required", allowTraining, {
        notes: [ADVISOR_REVIEW_LABEL, "Verify site ownership (Search Console, DNS, or file) before Okara reads your robots.txt. Nothing was fetched."],
      }),
    };
  }

  const rl = await hitRateLimit(db, `robots_suggest:${project.id}:${userId}`, ROBOTS_ADVISOR_RATE_LIMIT.limit, ROBOTS_ADVISOR_RATE_LIMIT.windowSeconds, now);
  if (!rl.allowed) return { rateLimited: true, retryAfterSeconds: rl.retryAfterSeconds };

  const fetchedAt = now.toISOString();
  const errorResult = (message: string, currentRobotsTxt: string | null = null) => ({
      data: emptySuggestion("error", allowTraining, {
        fetchedAt,
        currentRobotsTxt,
        warnings: [message, CDN_WARNING],
        notes: [ADVISOR_REVIEW_LABEL, "No suggestion is shown because Okara could not read the whole robots.txt. Replacing a file Okara has not fully read could drop existing rules."],
      }),
    });

  let res;
  try {
    res = await guardedFetch(robotsFetch, `https://${host}/robots.txt`, {
      verifiedHost: host,
      maxBytes: ROBOTS_MAX_BYTES,
      timeoutMs: ROBOTS_ADVISOR_TIMEOUT_MS,
      maxRedirects: 5,
      kind: "robots",
      lenientContentType: true,
      truncateAtCap: true,
      userAgent: crawlerUserAgent(env.APP_ORIGIN),
    });
  } catch (e) {
    const code: CrawlFetchErrorCode = e instanceof CrawlFetchError ? e.code : "error";
    return errorResult(`robots.txt could not be read because ${FETCH_ERRORS[code]}.`);
  }

  const opts = { allowTraining, siteType: project.site_type, host };
  if (res.status >= 200 && res.status < 300) {
    const shown = capForDisplay(res.body, CURRENT_ROBOTS_DISPLAY_BYTES);
    if (res.truncated) {
      return errorResult(`robots.txt is larger than ${ROBOTS_MAX_BYTES / 1024} KB, so Okara read only the first part and did not build a suggestion.`, shown.text);
    }
    const core = buildRobotsSuggestion(res.body, opts);
    const data: RobotsSuggestion = {
      state: "ready",
      fetchedAt,
      currentRobotsTxt: shown.text,
      ...core,
      notes: shown.capped ? [...core.notes, `Current robots.txt display shows the first ${CURRENT_ROBOTS_DISPLAY_BYTES / 1024} KB; the suggestion uses the whole file.`] : core.notes,
    };
    return { data };
  }
  if (res.status >= 400 && res.status < 500 && res.status !== 429) {
    const core = buildRobotsSuggestion(null, opts);
    const data: RobotsSuggestion = {
      state: "ready",
      fetchedAt,
      currentRobotsTxt: null,
      ...core,
      notes: [...core.notes, `https://${host}/robots.txt returned ${res.status}, which crawlers treat as "no robots.txt" (allow all).`],
    };
    return { data };
  }
  return errorResult(`robots.txt returned ${res.status}. Under RFC 9309 crawlers may treat an unreachable robots.txt as "disallow all" until it is served again.`);
}
