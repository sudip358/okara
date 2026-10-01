/**
 * Engines follow-up fixes: migration 0008 (provider_credentials CHECK widened to the GEO engine lanes),
 * migration 0009 (decision cache index), GEO agent readiness, results lanes/labels and the checklist
 * provider filter over the shared GEO_ENGINE_IDS list, OpenAI max_tool_calls, and the Anthropic answer text.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createApp, type AppEnv } from "@worker/app";
import type { Env } from "@worker/env";
import { Db } from "@worker/lib/db";
import { HttpError } from "@worker/lib/errors";
import { decryptSecret } from "@worker/lib/crypto";
import { credentialAad } from "@worker/platform/credentials";
import { recommendationRoutes } from "@worker/routes/recommendations";
import { geoRoutes } from "@worker/routes/geo";
import { loadGeo } from "@worker/checklists/data";
import { GEO_ENGINE_IDS, anyGeoEngineConfigured, isGeoEngineId } from "@worker/geo/engines";
import { API_PROVIDERS } from "@worker/geo/results";
import { createOpenAiGeoProvider, OPENAI_GEO_MAX_TOOL_CALLS } from "@worker/providers/openai-geo";
import { parseAnthropicGeoMessages } from "@worker/providers/anthropic-geo";
import { RESERVATION_ENVELOPE } from "@worker/providers/rates";
import type { GeoResults } from "@shared/types";
import { createTestEnv } from "./helpers/env";
import { authHeaders, FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";
import { seedPromptSet } from "./fixtures/geo-analysis/seed";

const SECRET = "sk-test-GEOENGINEKEY-0123456789abcdefQRST";
const OPENAI_ENV: Partial<Env> = { OPENAI_GEO_API_KEY: "op-openai-key", OPENAI_GEO_MODEL: "gpt-4.1" };
const ANTHROPIC_ENV: Partial<Env> = { ANTHROPIC_GEO_API_KEY: "op-anthropic-key", ANTHROPIC_GEO_MODEL: "claude-sonnet-5-5" };
const WRITER_ENV: Partial<Env> = { WRITER_API_KEY: "k", WRITER_PROVIDER: "anthropic", WRITER_MODEL: "configured-model" };

function migrationFiles(): string[] {
  const dir = join(process.cwd(), "migrations");
  return readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().map((f) => join(dir, f));
}

// ------------------------------------------------------------------ migration 0008

describe("migration 0008: provider_credentials accepts the GEO engine lanes", () => {
  it("rebuild keeps every existing row, the FK cascade and the (workspace_id, provider) uniqueness", () => {
    const files = migrationFiles();
    const i8 = files.findIndex((f) => f.endsWith("0008_provider_credentials_geo_engines.sql"));
    expect(i8).toBeGreaterThan(0);
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    for (const f of files.slice(0, i8)) db.exec(readFileSync(f, "utf8"));
    const now = FIXED_NOW.toISOString();
    db.prepare("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'W', ?)").run(now);
    db.prepare(
      "INSERT INTO provider_credentials (id, workspace_id, provider, key_enc, key_hint, last_tested_at, last_test_ok, last_test_detail, created_at, updated_at) VALUES ('c1', 'w1', 'gemini', 'enc', 'abcd', ?, 1, 'ok', ?, ?)",
    ).run(now, now, now);
    // Before 0008 the new ids are refused by the CHECK.
    expect(() =>
      db.prepare("INSERT INTO provider_credentials (id, workspace_id, provider, key_enc, key_hint, created_at, updated_at) VALUES ('c2', 'w1', 'openai_geo', 'e', 'h', ?, ?)").run(now, now),
    ).toThrow(/CHECK/);

    for (const f of files.slice(i8)) db.exec(readFileSync(f, "utf8"));
    expect(db.prepare("SELECT id, workspace_id, provider, key_enc, key_hint, last_tested_at, last_test_ok, last_test_detail FROM provider_credentials").all().map((r) => ({ ...r }))).toEqual([
      { id: "c1", workspace_id: "w1", provider: "gemini", key_enc: "enc", key_hint: "abcd", last_tested_at: now, last_test_ok: 1, last_test_detail: "ok" },
    ]);
    for (const p of ["openai_geo", "anthropic_geo"]) {
      db.prepare("INSERT INTO provider_credentials (id, workspace_id, provider, key_enc, key_hint, created_at, updated_at) VALUES (?, 'w1', ?, 'e', 'h', ?, ?)").run(`c-${p}`, p, now, now);
    }
    expect(() =>
      db.prepare("INSERT INTO provider_credentials (id, workspace_id, provider, key_enc, key_hint, created_at, updated_at) VALUES ('c9', 'w1', 'openai', 'e', 'h', ?, ?)").run(now, now),
    ).toThrow(/CHECK/);
    expect(() =>
      db.prepare("INSERT INTO provider_credentials (id, workspace_id, provider, key_enc, key_hint, created_at, updated_at) VALUES ('c10', 'w1', 'gemini', 'e', 'h', ?, ?)").run(now, now),
    ).toThrow(/UNIQUE/);
    expect(() =>
      db.prepare("INSERT INTO provider_credentials (id, workspace_id, provider, key_enc, key_hint, created_at, updated_at) VALUES ('c11', 'nope', 'writer', 'e', 'h', ?, ?)").run(now, now),
    ).toThrow(/FOREIGN KEY/);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    // Deleting the workspace still cascades.
    db.exec("DELETE FROM workspaces WHERE id = 'w1'");
    expect(db.prepare("SELECT COUNT(*) AS n FROM provider_credentials").get()).toEqual({ n: 0 });
  });

  it("PUT /workspaces/:wid/credentials/:provider stores encrypted workspace keys for openai_geo and anthropic_geo", async () => {
    const env = createTestEnv({ OPENAI_GEO_MODEL: "gpt-4.1", ANTHROPIC_GEO_MODEL: "claude-sonnet-5-5" });
    const u = await seedUser(env);
    const app = createApp();
    for (const provider of ["openai_geo", "anthropic_geo"] as const) {
      const res = await app.request(
        `/api/workspaces/${u.workspaceId}/credentials/${provider}`,
        { method: "PUT", headers: authHeaders(u.sessionToken, u.csrfToken), body: JSON.stringify({ apiKey: SECRET }) },
        env,
      );
      const text = await res.text();
      expect(res.status, text).toBe(200);
      expect(text).not.toContain(SECRET);
      expect((JSON.parse(text) as { data: unknown }).data).toMatchObject({ provider, source: "workspace_key", keyHint: "QRST", state: "ready" });
      const row = await u.db.first<{ key_enc: string }>("SELECT key_enc FROM provider_credentials WHERE workspace_id = ? AND provider = ?", u.workspaceId, provider);
      expect(row!.key_enc).not.toContain(SECRET);
      expect(await decryptSecret(env, row!.key_enc, credentialAad(u.workspaceId, provider))).toBe(SECRET);
    }
    expect(await u.db.all("SELECT id FROM provider_credentials WHERE workspace_id = ?", u.workspaceId)).toHaveLength(2);
  });
});

// ------------------------------------------------------------------ migration 0009

describe("migration 0009: decision cache index", () => {
  it("creates idx_decisions_cache on (project_id, question_id, candidate_key, created_at); with statistics the cache lookup uses it", () => {
    const db = new DatabaseSync(":memory:");
    for (const f of migrationFiles()) db.exec(readFileSync(f, "utf8"));
    const cols = db.prepare("PRAGMA index_info('idx_decisions_cache')").all().map((r) => (r as { name: string }).name);
    expect(cols).toEqual(["project_id", "question_id", "candidate_key", "created_at"]);
    expect(readFileSync(join(process.cwd(), "migrations", "0009_decisions_cache_index.sql"), "utf8")).toMatch(/^PRAGMA optimize;/m);

    // A populated project (as after a full buyer classification), then the statistics PRAGMA optimize gathers.
    db.exec("PRAGMA foreign_keys = OFF");
    const ins = db.prepare(
      "INSERT INTO decision_records (id, workspace_id, project_id, agent, candidate_key, question_id, question_version, provider, outcome, created_at) VALUES (?, 'w', 'p', 'seo', ?, ?, 'v1', 'typesafe', 'selected', ?)",
    );
    db.exec("BEGIN");
    for (let i = 0; i < 4000; i++) ins.run(`d${i}`, `buyer:q${i >> 1}`, i % 2 ? "seo.buyer_a" : "seo.buyer_b", `2026-09-${String(10 + (i % 20)).padStart(2, "0")}T00:00:00.000Z`);
    db.exec("COMMIT");
    db.exec("ANALYZE");
    // Same shape as the query-batch.ts cache lookup.
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT candidate_key, question_id, question_version, answer_json, provider, model FROM decision_records
          WHERE workspace_id = ? AND project_id = ? AND created_at >= ? AND provider IS NOT NULL
            AND question_id IN (?, ?) AND question_version IN (?) AND candidate_key IN (?, ?, ?)
          ORDER BY created_at DESC`,
      )
      .all("w", "p", "2026-09-20T00:00:00.000Z", "seo.buyer_a", "seo.buyer_b", "v1", "buyer:q1", "buyer:q2", "buyer:q3")
      .map((r) => String((r as { detail: string }).detail))
      .join("\n");
    expect(plan).toContain("idx_decisions_cache");
  });
});

// ------------------------------------------------------------------ shared engine list + readiness

function makeApp(env: Env, userId: string) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", new Db(c.env.DB));
    c.set("now", FIXED_NOW);
    c.set("user", { id: userId, email: "u@example.com", name: null });
    c.set("session", null);
    await next();
  });
  app.route("/", recommendationRoutes);
  app.route("/", geoRoutes);
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    throw err;
  });
  return async (method: string, path: string) => {
    const res = await app.request(path, { method }, env);
    return { status: res.status, json: (await res.json()) as any };
  };
}

describe("GEO_ENGINE_IDS drives GEO readiness, results lanes and the checklist provider list", () => {
  it("lists exactly the four engines", () => {
    expect([...GEO_ENGINE_IDS]).toEqual(["gemini", "perplexity", "openai_geo", "anthropic_geo"]);
    expect(API_PROVIDERS).toBe(GEO_ENGINE_IDS);
    expect(isGeoEngineId("openai_geo")).toBe(true);
    expect(isGeoEngineId("writer")).toBe(false);
    expect(anyGeoEngineConfigured({ gemini: false, anthropic_geo: true })).toBe(true);
    expect(anyGeoEngineConfigured({})).toBe(false);
  });

  for (const [name, engineEnv] of [["OpenAI", OPENAI_ENV], ["Anthropic", ANTHROPIC_ENV]] as const) {
    it(`GEO agent is ready when only the ${name} lane is configured`, async () => {
      const env = createTestEnv({ ...WRITER_ENV, ...engineEnv });
      const u = await seedUser(env);
      const pid = await seedProject(env, u.workspaceId);
      const r = await makeApp(env, u.userId)("GET", `/projects/${pid}/attention`);
      expect(r.status).toBe(200);
      expect(r.json.data.agents.find((a: any) => a.agent === "geo")).toMatchObject({ state: "ready" });
    });
  }

  it("GEO agent stays setup_required with a writer but no engine", async () => {
    const env = createTestEnv(WRITER_ENV);
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    const r = await makeApp(env, u.userId)("GET", `/projects/${pid}/attention`);
    expect(r.json.data.agents.find((a: any) => a.agent === "geo")).toMatchObject({ state: "setup_required" });
  });

  it("results list configured OpenAI/Anthropic lanes as ready with their labels; the setup label names all engines", async () => {
    const env = createTestEnv({ ...OPENAI_ENV, ...ANTHROPIC_ENV });
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    await seedPromptSet(env, { id: pid, workspaceId: u.workspaceId }, ["Where can I buy solid brass cabinet hardware?"]);
    const call = makeApp(env, u.userId);
    const data = (await call("GET", `/projects/${pid}/geo/results`)).json.data as GeoResults;
    expect(data.state).toBe("ready");
    expect(data.lanes.map((l) => [l.provider, l.state, l.label])).toEqual([
      ["openai_geo", "ready", "OpenAI API with web search (API-sampled)"],
      ["anthropic_geo", "ready", "Anthropic API with web search (API-sampled)"],
    ]);

    const bare = createTestEnv();
    const u2 = await seedUser(bare);
    const pid2 = await seedProject(bare, u2.workspaceId);
    await seedPromptSet(bare, { id: pid2, workspaceId: u2.workspaceId }, ["Where can I buy solid brass cabinet hardware?"]);
    const none = (await makeApp(bare, u2.userId)("GET", `/projects/${pid2}/geo/results`)).json.data as GeoResults;
    expect(none.labels).toContain("Setup required: configure a GEO provider key and model (OpenAI, Anthropic, Gemini or Perplexity).");
  });

  it("checklist GEO data lists every GEO engine provider and nothing else", async () => {
    const env = createTestEnv(OPENAI_ENV);
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId);
    const geo = await loadGeo(env, new Db(env.DB), u.workspaceId, pid);
    expect(geo.providers.map((p) => p.provider).sort()).toEqual([...GEO_ENGINE_IDS].sort());
    expect(geo.providers.find((p) => p.provider === "openai_geo")!.state).toBe("ready");
    expect(geo.providers.find((p) => p.provider === "anthropic_geo")!.state).toBe("setup_required");
  });
});

// ------------------------------------------------------------------ OpenAI max_tool_calls

describe("OpenAI GEO adapter bounds built-in tool calls", () => {
  it("sends max_tool_calls equal to the reserved search envelope and keys the cohort on it", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ id: "resp_1", model: "gpt-4.1", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const p = createOpenAiGeoProvider({ apiKey: "sk-x-0001", model: "gpt-4.1", fetchImpl, now: () => FIXED_NOW });
    await p.ask("q", { locale: "en-US", language: "en" });
    expect(OPENAI_GEO_MAX_TOOL_CALLS).toBe(RESERVATION_ENVELOPE.openaiSearchCalls);
    expect(bodies[0]!.max_tool_calls).toBe(5);
    expect(p.samplingOptions).toMatchObject({ maxToolCalls: 5 });
  });
});

// ------------------------------------------------------------------ Anthropic answer text

/** Constructed fixtures carry extra documented fields (encrypted_index, cited_text) the parser type omits. */
const parse = (m: unknown[]) => parseAnthropicGeoMessages(m as Parameters<typeof parseAnthropicGeoMessages>[0]);
const usage = { input_tokens: 10, output_tokens: 10, server_tool_use: { web_search_requests: 1 } };
const search = (id: string) => [
  { type: "server_tool_use", id, name: "web_search", input: { query: "brass pulls" } },
  { type: "web_search_tool_result", tool_use_id: id, content: [{ type: "web_search_result", url: "https://a.example/x", title: "A", encrypted_content: "E", page_age: null }] },
];

describe("Anthropic GEO answer text", () => {
  it("keeps only the text after the last web_search_tool_result (doc example shape: narration, search, cited answer)", () => {
    const parsed = parse([
      {
        model: "claude-sonnet-5-5",
        stop_reason: "end_turn",
        content: [
          { type: "text", text: "I'll search for the best brass pulls." },
          ...search("srvtoolu_1"),
          { type: "text", text: "Based on the search results, " },
          { type: "text", text: "Brass Co is a popular choice.", citations: [{ type: "web_search_result_location", url: "https://a.example/x", title: "A", encrypted_index: "I", cited_text: "Brass Co" }] },
          { type: "text", text: " Rival Hardware is another." },
        ],
        usage,
      },
    ]);
    expect(parsed.text).toBe("Based on the search results, Brass Co is a popular choice. Rival Hardware is another.");
    expect(parsed.citations.map((c) => c.url)).toEqual(["https://a.example/x"]);
  });

  it("uses the text after the second search when Claude searches twice", () => {
    const parsed = parse([
      {
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Searching." }, ...search("s1"), { type: "text", text: "Let me refine." }, ...search("s2"), { type: "text", text: "Final answer." }],
        usage: { ...usage, server_tool_use: { web_search_requests: 2 } },
      },
    ]);
    expect(parsed.text).toBe("Final answer.");
  });

  it("without any search, all text is the answer; with no text after the last result, passages join with a blank line", () => {
    const plain = parse([{ stop_reason: "end_turn", content: [{ type: "text", text: "Part one, " }, { type: "text", text: "part two." }], usage: { input_tokens: 1, output_tokens: 1 } }]);
    expect(plain.text).toBe("Part one, part two.");
    const noTail = parse([
      { stop_reason: "end_turn", content: [{ type: "text", text: "I'll search for it." }, ...search("s1")], usage },
    ]);
    expect(noTail.text).toBe("I'll search for it.");
    const twoPassages = parse([
      { stop_reason: "end_turn", content: [{ type: "text", text: "Before." }, ...search("s1"), { type: "text", text: "Middle." }, ...search("s2")], usage },
    ]);
    expect(twoPassages.text).toBe("Before.\n\nMiddle.");
  });
});

