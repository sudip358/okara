/**
 * Round-2 follow-ups (budget-auth): allowlist revocation wired into loadSession, the credential-source
 * lookup not caching a rejection, and provider-attributed budgets (budgetFor) for Jev and the writer.
 */
import { describe, expect, it } from "vitest";
import { createApp } from "@worker/app";
import type { Env } from "@worker/env";
import { encryptSecret } from "@worker/lib/crypto";
import { Db } from "@worker/lib/db";
import { BudgetExceededError } from "@worker/lib/errors";
import { newId } from "@worker/lib/ids";
import { credentialAad } from "@worker/platform/credentials";
import { buildDecisionsForWorkspace } from "@worker/redirects/decisions";
import { createBudget, GLOBAL_SCOPE_KEY } from "@worker/runs/budget";
import { buildRunContext, buildWriterForWorkspace } from "@worker/runs/runtime";
import { createRun } from "@worker/runs/runs-service";
import type { ProviderId } from "@shared/types";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";

const app = createApp();
const PROD_ORIGIN = "https://app.example.com";

describe("loadSession enforces the sign-in allowlist on existing sessions", () => {
  it("production: a session whose email left ALLOWED_EMAILS gets 401 on /api/me and its row is deleted", async () => {
    const env = createTestEnv({ ENVIRONMENT: "production", APP_ORIGIN: PROD_ORIGIN, ALLOWED_EMAILS: "a@x.com" });
    const u = await seedUser(env, { email: "a@x.com" });
    const cookie = { Cookie: `__Host-okara_session=${u.sessionToken}` };
    expect((await app.request(`${PROD_ORIGIN}/api/me`, { headers: cookie }, env)).status).toBe(200);

    const changed: Env = { ...env, ALLOWED_EMAILS: "b@x.com" };
    expect((await app.request(`${PROD_ORIGIN}/api/me`, { headers: cookie }, changed)).status).toBe(401);
    expect(await u.db.first("SELECT id FROM sessions WHERE id = ?", u.sessionId)).toBeNull();
  });

  it("production with no allowlist at all rejects existing sessions (signup_closed)", async () => {
    const env = createTestEnv({ ENVIRONMENT: "production", APP_ORIGIN: PROD_ORIGIN });
    const u = await seedUser(env, { email: "a@x.com" });
    expect((await app.request(`${PROD_ORIGIN}/api/me`, { headers: { Cookie: `__Host-okara_session=${u.sessionToken}` } }, env)).status).toBe(401);
    expect(await u.db.first("SELECT id FROM sessions WHERE id = ?", u.sessionId)).toBeNull();
  });

  it("an allowlisted domain keeps the session", async () => {
    const env = createTestEnv({ ENVIRONMENT: "production", APP_ORIGIN: PROD_ORIGIN, ALLOWED_EMAIL_DOMAINS: "x.com" });
    const u = await seedUser(env, { email: "someone@X.com" });
    expect((await app.request(`${PROD_ORIGIN}/api/me`, { headers: { Cookie: `__Host-okara_session=${u.sessionToken}` } }, env)).status).toBe(200);
  });
});

describe("auth redirect_uri comes from appRedirectUri", () => {
  it("normalises APP_ORIGIN (trailing slash) into the Google redirect_uri", async () => {
    const env = createTestEnv({ APP_ORIGIN: "https://app.example.com/" });
    const res = await app.request("/api/auth/login", {}, env);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.searchParams.get("redirect_uri")).toBe("https://app.example.com/api/auth/callback");
  });
});

// ------------------------------------------------------------------ budgets

async function saveKey(env: Env, db: Db, workspaceId: string, provider: ProviderId, plaintext: string) {
  const now = FIXED_NOW.toISOString();
  await db.run(
    "INSERT INTO provider_credentials (id, workspace_id, provider, key_enc, key_hint, created_at, updated_at) VALUES (?, ?, ?, ?, 'abcd', ?, ?)",
    newId("cred"),
    workspaceId,
    provider,
    await encryptSecret(env, plaintext, credentialAad(workspaceId, provider)),
    now,
    now,
  );
}

async function used(db: Db, scope: string, resource: string): Promise<number> {
  const row = await db.first<{ used: number }>("SELECT used FROM usage_counters WHERE scope_key = ? AND resource = ?", scope, resource);
  return row?.used ?? 0;
}

describe("createBudget credential-source lookup", () => {
  it("does not cache a rejected lookup: the next reserve() retries it", async () => {
    const env = createTestEnv({ TYPESAFE_API_KEY: "op" });
    const u = await seedUser(env);
    const projectId = await seedProject(env, u.workspaceId);
    const real = new Db(env.DB);
    let failures = 1;
    const flaky = new Proxy(real, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (prop === "all" && typeof v === "function") {
          return async (sql: string, ...args: unknown[]) => {
            if (sql.includes("provider_credentials") && failures-- > 0) throw new Error("D1 transient");
            return v.call(target, sql, ...args);
          };
        }
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const budget = createBudget(flaky, env, { workspaceId: u.workspaceId, projectId, runId: null }, () => FIXED_NOW);
    await expect(budget.reserve("jev_calls", 1)).rejects.toThrow(/D1 transient/);
    const id = await budget.reserve("jev_calls", 1);
    expect(typeof id).toBe("string");
    expect(await used(real, GLOBAL_SCOPE_KEY, "jev_calls")).toBe(1);
  });
});

/**
 * Tenant on its own TypeSafe and writer keys, Gemini on the operator key, global provider_calls cap
 * exhausted (0). Jev and writer calls must still run: their provider_calls are attributed to the BYO key.
 */
async function byoTenant() {
  const env = createTestEnv({
    GEMINI_API_KEY: "op-gemini",
    GEMINI_MODEL: "gemini-test",
    WRITER_PROVIDER: "anthropic",
    WRITER_MODEL: "claude-test",
    GLOBAL_PROVIDER_CALLS_PER_DAY: "0",
  });
  const u = await seedUser(env);
  const projectId = await seedProject(env, u.workspaceId);
  const db = new Db(env.DB);
  await saveKey(env, db, u.workspaceId, "typesafe", "ts-byo");
  await saveKey(env, db, u.workspaceId, "writer", "w-byo");
  const seen: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    seen.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "bad" } }), { status: 400, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { env, db, workspaceId: u.workspaceId, projectId, seen, fetchImpl };
}

async function settleErr(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return null;
  } catch (e) {
    return e;
  }
}

const DECIDE = { purpose: "test", state: { q: "x" }, questions: { ok: { type: "noul" as const, instructions: "Is `q` fine?" } } };
const WRITE = { purpose: "geo_prompt_generation" as const, system: "s", input: { a: 1 }, jsonSchema: { type: "object" }, maxOutputTokens: 100 };

describe("BYO TypeSafe/writer + operator Gemini under an exhausted global provider_calls cap", () => {
  it("buildRunContext: Jev and writer calls are attributed to the BYO keys and reach the provider", async () => {
    const t = await byoTenant();
    const { runId } = await createRun(t.db, { workspaceId: t.workspaceId, projectId: t.projectId, agent: "seo", trigger: "manual", idempotencyKey: "r2", createdBy: null, now: FIXED_NOW });
    const ctx = await buildRunContext(t.env, runId, { fetchImpl: t.fetchImpl, clock: () => FIXED_NOW });
    expect(ctx.decisions).not.toBeNull();
    expect(ctx.writer).not.toBeNull();
    expect(ctx.geoProviders.map((g) => g.id)).toEqual(["gemini"]);

    // Control: an unattributed provider_calls reservation is counted globally (Gemini is on the operator key).
    await expect(ctx.budget.reserve("provider_calls", 1)).rejects.toBeInstanceOf(BudgetExceededError);

    const dErr = await settleErr(ctx.decisions!.decide(DECIDE));
    expect(dErr).not.toBeInstanceOf(BudgetExceededError);
    expect(t.seen.some((u) => u.includes("api.typesafe.ai"))).toBe(true);

    const wErr = await settleErr(ctx.writer!.write(WRITE));
    expect(wErr).not.toBeInstanceOf(BudgetExceededError);
    expect(t.seen.some((u) => u.includes("api.anthropic.com"))).toBe(true);
    expect(await used(t.db, GLOBAL_SCOPE_KEY, "provider_calls")).toBe(0);
  });

  it("buildWriterForWorkspace (project-scoped) attributes to the writer key", async () => {
    const t = await byoTenant();
    const writer = await buildWriterForWorkspace(t.env, t.db, t.workspaceId, { projectId: t.projectId, fetchImpl: t.fetchImpl, clock: () => FIXED_NOW });
    expect(writer).not.toBeNull();
    const err = await settleErr(writer!.write(WRITE));
    expect(err).not.toBeInstanceOf(BudgetExceededError);
    expect(t.seen.some((u) => u.includes("api.anthropic.com"))).toBe(true);
  });

  it("buildDecisionsForWorkspace (redirects / buyer queries) attributes to the TypeSafe key", async () => {
    const t = await byoTenant();
    const decisions = await buildDecisionsForWorkspace(t.env, t.db, t.workspaceId, t.projectId, { fetchImpl: t.fetchImpl, clock: () => FIXED_NOW });
    expect(decisions).not.toBeNull();
    const err = await settleErr(decisions!.decide(DECIDE));
    expect(err).not.toBeInstanceOf(BudgetExceededError);
    expect(t.seen.some((u) => u.includes("api.typesafe.ai"))).toBe(true);
  });

  it("the same Jev call on the operator TypeSafe key is stopped by the global cap", async () => {
    const t = await byoTenant();
    await t.db.run("DELETE FROM provider_credentials WHERE workspace_id = ? AND provider = 'typesafe'", t.workspaceId);
    const env: Env = { ...t.env, TYPESAFE_API_KEY: "op-ts" };
    const decisions = await buildDecisionsForWorkspace(env, t.db, t.workspaceId, t.projectId, { fetchImpl: t.fetchImpl, clock: () => FIXED_NOW });
    await expect(decisions!.decide(DECIDE)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(t.seen).toHaveLength(0);
  });
});

describe("Env declares the provider tuning variables", () => {
  it("accepts WRITER_REASONING_EFFORT, WRITER_REASONING_HEADROOM_TOKENS and GEMINI_THINKING_LEVEL", () => {
    const env: Env = createTestEnv({ WRITER_REASONING_EFFORT: "low", WRITER_REASONING_HEADROOM_TOKENS: "0", GEMINI_THINKING_LEVEL: "LOW" });
    expect(env.WRITER_REASONING_EFFORT).toBe("low");
    expect("SESSION_SECRET" in env).toBe(false);
  });
});
