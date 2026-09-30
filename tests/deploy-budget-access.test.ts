import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { createApp } from "@worker/app";
import type { Env } from "@worker/env";
import { Db } from "@worker/lib/db";
import { BudgetExceededError } from "@worker/lib/errors";
import { newId } from "@worker/lib/ids";
import { resetOidcDeps, setOidcDeps } from "@worker/platform/oidc";
import { lookupSession, signInAccess } from "@worker/platform/session";
import { credentialSources } from "@worker/platform/credentials";
import { budgetFor, createBudget, GLOBAL_SCOPE_KEY, globalDailyLimit, projectScopeKey } from "@worker/runs/budget";
import { runGeoBatch } from "@worker/geo/batch";
import type { GeoProvider } from "@worker/providers/types";
import type { ProviderId } from "@shared/types";
import { createTestEnv } from "./helpers/env";
import { makeTestContext } from "./helpers/context";
import { FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";

// ------------------------------------------------------------------ B1: sign-in allowlist

describe("signInAccess", () => {
  it("fails closed in production when no allowlist is configured; open elsewhere", () => {
    expect(signInAccess({ ENVIRONMENT: "production" }, "a@example.com")).toBe("signup_closed");
    expect(signInAccess({ ENVIRONMENT: "production", ALLOWED_EMAILS: " , " }, "a@example.com")).toBe("signup_closed");
    expect(signInAccess({ ENVIRONMENT: "development" }, "a@example.com")).toBe("allowed");
    expect(signInAccess({ ENVIRONMENT: "test" }, "a@example.com")).toBe("allowed");
  });

  it("matches emails and domains case-insensitively, exact domain only", () => {
    const env = { ENVIRONMENT: "production" as const, ALLOWED_EMAILS: " Alice@Example.com ,bob@x.io", ALLOWED_EMAIL_DOMAINS: "@Corp.COM, team.dev" };
    expect(signInAccess(env, "alice@example.COM")).toBe("allowed");
    expect(signInAccess(env, "BOB@x.io")).toBe("allowed");
    expect(signInAccess(env, "carol@corp.com")).toBe("allowed");
    expect(signInAccess(env, "dave@TEAM.dev")).toBe("allowed");
    expect(signInAccess(env, "eve@example.com")).toBe("not_allowed");
    expect(signInAccess(env, "eve@evil-corp.com")).toBe("not_allowed");
    expect(signInAccess(env, "eve@sub.corp.com")).toBe("not_allowed");
    expect(signInAccess(env, "corp.com")).toBe("not_allowed");
    // A list set in a non-production environment is enforced too.
    expect(signInAccess({ ENVIRONMENT: "development", ALLOWED_EMAIL_DOMAINS: "corp.com" }, "x@other.com")).toBe("not_allowed");
  });
});

const CLIENT_ID = "test-client-id.apps.googleusercontent.com";
const app = createApp();
let privateKey: CryptoKey;
let jwk: JWK;

beforeAll(async () => {
  const kp = await generateKeyPair("RS256");
  privateKey = kp.privateKey;
  jwk = { ...(await exportJWK(kp.publicKey)), kid: "test-kid", alg: "RS256", use: "sig" };
});
beforeEach(() => {
  setOidcDeps({
    jwks: createLocalJWKSet({ keys: [jwk] }),
    fetch: async () => {
      throw new Error("Network disabled in tests");
    },
  });
});
afterEach(() => resetOidcDeps());

async function idToken(nonce: string, email: string, sub: string) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ nonce, email, email_verified: true, name: "Tester" })
    .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
    .setIssuer("https://accounts.google.com")
    .setAudience(CLIENT_ID)
    .setSubject(sub)
    .setIssuedAt(now - 10)
    .setExpirationTime(now + 3600)
    .sign(privateKey);
}

async function loginAs(env: Env, email: string, sub: string) {
  const start = await app.request("/api/auth/login", {}, env);
  expect(start.status).toBe(302);
  const loc = new URL(start.headers.get("Location")!);
  const state = loc.searchParams.get("state")!;
  const nonce = loc.searchParams.get("nonce")!;
  const token = await idToken(nonce, email, sub);
  setOidcDeps({
    fetch: async () => new Response(JSON.stringify({ id_token: token, access_token: "at", token_type: "Bearer" }), { status: 200, headers: { "Content-Type": "application/json" } }),
  });
  return app.request(`/api/auth/callback?state=${encodeURIComponent(state)}&code=c`, { headers: { Cookie: `okara_login_state=${state}` } }, env);
}

const authError = (res: Response) => {
  const loc = res.headers.get("Location");
  return loc ? new URL(loc).searchParams.get("authError") : null;
};
const count = async (env: Env, table: string) => Number((await new Db(env.DB).first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))?.n ?? 0);

describe("sign-in allowlist routes", () => {
  it("production without an allowlist redirects /auth/login to authError=signup_closed (no Google round trip)", async () => {
    const env = createTestEnv({ ENVIRONMENT: "production", APP_ORIGIN: "https://app.example.com" });
    const res = await app.request("https://app.example.com/api/auth/login", {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://app.example.com/?authError=signup_closed");
    expect(await count(env, "oauth_states")).toBe(0);
  });

  it("refuses a verified email outside the allowlist without creating a user or workspace", async () => {
    const env = createTestEnv({ ALLOWED_EMAILS: "alice@example.com" });
    const res = await loginAs(env, "mallory@example.com", "sub-mallory");
    expect(authError(res)).toBe("not_allowed");
    expect(res.headers.getSetCookie().some((c) => c.startsWith("okara_session=") && !c.startsWith("okara_session=;"))).toBe(false);
    expect(await count(env, "users")).toBe(0);
    expect(await count(env, "workspaces")).toBe(0);
  });

  it("admits an allowlisted email (case-insensitive) and an allowlisted domain", async () => {
    const env = createTestEnv({ ALLOWED_EMAILS: "ALICE@example.com", ALLOWED_EMAIL_DOMAINS: "corp.com" });
    expect(authError(await loginAs(env, "alice@Example.com", "sub-alice"))).toBeNull();
    expect(authError(await loginAs(env, "bob@CORP.com", "sub-bob"))).toBeNull();
    expect(await count(env, "users")).toBe(2);
  });

  it("lookupSession with access rules rejects and deletes a session whose user is no longer allowed", async () => {
    const env = createTestEnv();
    const u = await seedUser(env, { email: "old@example.com" });
    const db = new Db(env.DB);
    const now = new Date();
    expect(await lookupSession(db, u.sessionToken, now, { ENVIRONMENT: "test" })).not.toBeNull();
    expect(await lookupSession(db, u.sessionToken, now, { ENVIRONMENT: "test", ALLOWED_EMAILS: "new@example.com" })).toBeNull();
    expect(await db.first("SELECT id FROM sessions WHERE id = ?", u.sessionId)).toBeNull();
  });
});

// ------------------------------------------------------------------ B1 + H4: operator-key global caps

async function saveKey(db: Db, workspaceId: string, provider: ProviderId) {
  const now = FIXED_NOW.toISOString();
  await db.run(
    "INSERT INTO provider_credentials (id, workspace_id, provider, key_enc, key_hint, created_at, updated_at) VALUES (?, ?, ?, 'enc', 'abcd', ?, ?)",
    newId("cred"),
    workspaceId,
    provider,
    now,
    now,
  );
}

async function used(db: Db, scope: string, resource: string): Promise<number> {
  const row = await db.first<{ used: number }>("SELECT used FROM usage_counters WHERE scope_key = ? AND day = '2026-09-30' AND resource = ?", scope, resource);
  return row?.used ?? 0;
}

async function setupBudget(env: Env, limits: Record<string, number> = { provider_calls_per_day: 100_000, usd_micros_per_day: 100_000_000 }) {
  const u = await seedUser(env);
  const projectId = await seedProject(env, u.workspaceId);
  const db = new Db(env.DB);
  const sets = Object.keys(limits).map((k) => `${k} = ?`).join(", ");
  await db.run(`UPDATE project_limits SET ${sets} WHERE project_id = ?`, ...Object.values(limits), projectId);
  const budget = createBudget(db, env, { workspaceId: u.workspaceId, projectId, runId: null }, () => FIXED_NOW);
  return { db, workspaceId: u.workspaceId, projectId, budget };
}

describe("global caps for operator-key spend", () => {
  it("defaults and env overrides", () => {
    expect(globalDailyLimit("jev_calls", {})).toBe(2_000);
    expect(globalDailyLimit("provider_calls", {})).toBe(3_000);
    expect(globalDailyLimit("writer_tokens", {})).toBe(1_000_000);
    expect(globalDailyLimit("usd_micros", {})).toBe(2_000_000);
    expect(globalDailyLimit("jev_calls", { GLOBAL_JEV_CALLS_PER_DAY: "7" })).toBe(7);
    expect(globalDailyLimit("crawl_pages", {})).toBeNull();
  });

  it("credentialSources mirrors resolveProviderKey precedence without decrypting", async () => {
    const env = createTestEnv({ TYPESAFE_API_KEY: "op", WRITER_API_KEY: "op", GEMINI_API_KEY: " " });
    const { db, workspaceId } = await setupBudget(env);
    await saveKey(db, workspaceId, "writer");
    expect(await credentialSources(env, db, workspaceId)).toEqual({ typesafe: "operator_key", writer: "workspace_key", gemini: null, perplexity: null });
  });

  it("jev_calls / provider_calls on the operator key hit the global cap, roll back the project, and settle/release the global row", async () => {
    const env = createTestEnv({ TYPESAFE_API_KEY: "op", GLOBAL_JEV_CALLS_PER_DAY: "5", GLOBAL_PROVIDER_CALLS_PER_DAY: "4" });
    const a = await setupBudget(env);
    const b = await setupBudget(env); // another tenant on the same operator key
    const r1 = await a.budget.reserve("jev_calls", 3);
    expect(await used(a.db, GLOBAL_SCOPE_KEY, "jev_calls")).toBe(3);
    await expect(b.budget.reserve("jev_calls", 3)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(await used(b.db, projectScopeKey(b.projectId), "jev_calls")).toBe(0);
    await a.budget.settle(r1, 1);
    expect(await used(a.db, GLOBAL_SCOPE_KEY, "jev_calls")).toBe(1);
    const r2 = await b.budget.reserve("jev_calls", 3);
    await b.budget.release(r2);
    expect(await used(a.db, GLOBAL_SCOPE_KEY, "jev_calls")).toBe(1);

    await a.budget.reserve("provider_calls", 4);
    await expect(budgetFor(b.budget, "typesafe").reserve("provider_calls", 1)).rejects.toThrow(/Global/);
  });

  it("attributes by the sources the runtime resolved, even if a workspace key is saved mid-step", async () => {
    const env = createTestEnv({ TYPESAFE_API_KEY: "op", GLOBAL_JEV_CALLS_PER_DAY: "2" });
    const { db, workspaceId, projectId } = await setupBudget(env);
    const budget = createBudget(db, env, { workspaceId, projectId, runId: null }, () => FIXED_NOW, {
      sources: { typesafe: "operator_key", writer: null, gemini: null, perplexity: null },
    });
    await saveKey(db, workspaceId, "typesafe"); // saved after the step picked the operator key
    await budget.reserve("jev_calls", 2);
    expect(await used(db, GLOBAL_SCOPE_KEY, "jev_calls")).toBe(2);
    await expect(budget.reserve("jev_calls", 1)).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("writer_tokens on the operator key count globally; on the workspace's own key they do not", async () => {
    const env = createTestEnv({ WRITER_API_KEY: "op", GLOBAL_WRITER_TOKENS_PER_DAY: "1000" });
    const op = await setupBudget(env);
    await op.budget.reserve("writer_tokens", 1000);
    await expect(op.budget.reserve("writer_tokens", 1)).rejects.toThrow(/Global/);

    const byo = await setupBudget(env);
    await saveKey(byo.db, byo.workspaceId, "writer");
    await byo.budget.reserve("writer_tokens", 5000);
    await byo.budget.reserve("provider_calls", 3); // only writer is keyed: attributed to the BYO key
    expect(await used(byo.db, GLOBAL_SCOPE_KEY, "writer_tokens")).toBe(1000);
    expect(await used(byo.db, GLOBAL_SCOPE_KEY, "provider_calls")).toBe(0);
  });

  it("H4: a tenant on its own Gemini key is not stopped by the operator-key $ allowance", async () => {
    const env = createTestEnv({ GEMINI_API_KEY: "op", GLOBAL_USD_MICROS_PER_DAY: "1000" });
    const op = await setupBudget(env);
    await budgetFor(op.budget, "gemini").reserve("usd_micros", 1000);
    await expect(budgetFor(op.budget, "gemini").reserve("usd_micros", 1)).rejects.toThrow(/Global/);

    const byo = await setupBudget(env);
    await saveKey(byo.db, byo.workspaceId, "gemini");
    await budgetFor(byo.budget, "gemini").reserve("usd_micros", 5000);
    await budgetFor(byo.budget, "gemini").reserve("provider_calls", 1);
    expect(await used(byo.db, GLOBAL_SCOPE_KEY, "usd_micros")).toBe(1000);
    expect(await used(byo.db, projectScopeKey(byo.projectId), "usd_micros")).toBe(5000);
  });

  it("H4: runGeoBatch attributes usd_micros to the provider's key", async () => {
    const env = createTestEnv({ GEMINI_API_KEY: "op", GLOBAL_USD_MICROS_PER_DAY: "1" });
    const provider = (): GeoProvider => ({
      id: "gemini",
      label: "fake",
      model: "fake-model",
      groundingMode: "fake",
      async ask() {
        throw new Error("boom"); // unknown outcome: reservations are kept
      },
      async test() {
        return { ok: true, detail: "" };
      },
    });
    const run = async (byo: boolean) => {
      const s = await setupBudget(env);
      if (byo) await saveKey(s.db, s.workspaceId, "gemini");
      const setId = newId("ps");
      const now = FIXED_NOW.toISOString();
      await s.db.run(
        "INSERT INTO geo_prompt_sets (id, workspace_id, project_id, version, active, created_at) VALUES (?, ?, ?, 1, 1, ?)",
        setId, s.workspaceId, s.projectId, now,
      );
      await s.db.run(
        "INSERT INTO geo_prompts (id, workspace_id, project_id, prompt_set_id, text, prompt_type, locale, language, approved, position) VALUES (?, ?, ?, ?, 'P1', 'discovery', 'en-US', 'en', 1, 1)",
        newId("gp"), s.workspaceId, s.projectId, setId,
      );
      const ctx = makeTestContext(env, { id: s.projectId, workspaceId: s.workspaceId }, { geoProviders: [provider()], budget: s.budget });
      return { r: await runGeoBatch(ctx), s };
    };
    const byo = await run(true);
    expect(byo.r.note).not.toMatch(/budget/i);
    expect(await used(byo.s.db, projectScopeKey(byo.s.projectId), "usd_micros")).toBeGreaterThan(0);
    const op = await run(false);
    expect(op.r.note).toMatch(/budget/i);
  });
});
