/**
 * [A23] GET /projects/:pid/seo/buyer-queries and /seo/translation-opportunities: honest states (no Jev ->
 * setup_required, never guessed), Noul-based buyer classification with the 7-day decision cache,
 * brand exclusion, budget refusal, rate limit, and tenancy.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "@worker/app";
import type { Env } from "@worker/env";
import type { BuyerQueryRow, CoverageResponse, TranslationOpportunityRow } from "@shared/types";
import type { GscRow } from "@worker/providers/types";
import { Db } from "@worker/lib/db";
import { HttpError } from "@worker/lib/errors";
import { seoOverviewRoutes, setSeoJevDecisionsFactory } from "@worker/routes/seo-overview";
import { QUESTION } from "@worker/seo/questions";
import { BUYER_LABELS } from "@worker/seo/recommend/buyer-queries";
import { FIXED_NOW, seedUser } from "./helpers/fixtures";
import { DEFAULT_GSC_DATA, fakeDecisions, noul, QP_CURRENT, QP_PREVIOUS, U } from "./fixtures/gsc/site";
import { scenario } from "./fixtures/gsc/scenario";
import { answers } from "./seo-jev.fixtures";

const row = (keys: string[], clicks: number, impressions: number, position: number): GscRow => ({ keys, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position });

function makeApp(env: Env, userId: string) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", new Db(c.env.DB));
    c.set("now", FIXED_NOW);
    c.set("user", { id: userId, email: "u@example.com", name: null });
    c.set("session", null);
    await next();
  });
  app.route("/", seoOverviewRoutes);
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    throw err;
  });
  return async (path: string) => {
    const res = await app.request(path, { method: "GET" }, env);
    return { status: res.status, json: (await res.json()) as { data: never; error?: { code: string } } };
  };
}

const BUYER: Record<string, number> = { "brass cabinet knob": 0.95, "cabinet hardware": 0.5, "wall sconces": 0.9, "brass sconces": 0.9, "how to clean unlacquered brass": 0.05 };
const READY: Record<string, number | undefined> = { "brass cabinet knob": 0.9, "cabinet hardware": 0.9, "wall sconces": 0.1, "brass sconces": undefined };
const queryOf = (req: { state: unknown }, id: string) => (req.state as { queries: Record<string, string> }).queries[id.split("#")[1]!]!;
const buyerJev = () =>
  fakeDecisions(
    answers({
      [QUESTION.buyerQuery]: (req, id) => noul(BUYER[queryOf(req, id)] ?? 0.1),
      [QUESTION.buyerReady]: (req, id) => {
        const v = READY[queryOf(req, id)];
        return v === undefined ? undefined : noul(v);
      },
    }),
  );

const DATA = { ...DEFAULT_GSC_DATA, qp: { current: [...QP_CURRENT, row(["resex brass knob", U.knob], 30, 300, 2)], previous: QP_PREVIOUS } };

afterEach(() => setSeoJevDecisionsFactory(null));

describe("GET /projects/:pid/seo/buyer-queries", () => {
  it("without Jev: setup_required with a clear label and no guessed intents", async () => {
    const s = await scenario({ crawl: false, gsc: DATA });
    setSeoJevDecisionsFactory(async () => null);
    const r = await makeApp(s.env, s.userId)(`/projects/${s.projectId}/seo/buyer-queries`);
    expect(r.status).toBe(200);
    const d = r.json.data as CoverageResponse<BuyerQueryRow>;
    expect(d).toMatchObject({ state: "setup_required", rows: [] });
    expect(d.labels[0]).toBe(BUYER_LABELS.noJev);
    expect(d.completeness!.note).toMatch(/5 non-brand queries are waiting/);
  });

  it("classifies non-brand queries with two Nouls per query in one batch; flag rows are shown; cached for 7 days", async () => {
    const s = await scenario({ crawl: false, gsc: DATA });
    const jev = buyerJev();
    setSeoJevDecisionsFactory(async () => jev);
    const call = makeApp(s.env, s.userId);
    const d = (await call(`/projects/${s.projectId}/seo/buyer-queries`)).json.data as CoverageResponse<BuyerQueryRow>;
    expect(d.state).toBe("ready");
    expect(jev.requests).toHaveLength(1);
    const req = jev.requests[0]!;
    expect(Object.keys(req.questions)).toHaveLength(10); // 5 non-brand queries x 2 questions (<= 50 per call)
    expect(Object.values((req.state as { queries: Record<string, string> }).queries)).not.toContain("resex brass knob"); // brand excluded
    expect(req.state).toMatchObject({ country: "US", language: "en", site_type: "ecommerce" });
    expect(d.rows.map((r) => [r.query, r.intent, r.intentTier])).toEqual([
      ["brass cabinet knob", "transactional", "act"],
      ["cabinet hardware", "transactional", "flag"],
      ["wall sconces", "commercial_investigation", "act"],
    ]);
    expect(d.rows[0]).toMatchObject({ impressions: 2150, clicks: 12, topPage: U.knob, segment: "head" });
    expect(d.rows[0]!.position).toBeCloseTo((5 * 2000 + 9 * 150) / 2150, 10);
    expect(d.completeness!.note).toMatch(/5 of 5 non-brand queries classified .* 3 buyer queries\. 1 buyer queries had no usable ready-to-buy answer/);
    expect(d.labels.join(" ")).toMatch(/1 brand query is excluded; 0 queries name a competitor/);
    const dec = await new Db(s.env.DB).all<{ question_id: string; candidate_key: string; question_version: string; run_id: string | null }>(
      "SELECT question_id, candidate_key, question_version, run_id FROM decision_records WHERE project_id = ?",
      s.projectId,
    );
    expect(dec).toHaveLength(10);
    expect(new Set(dec.map((x) => x.question_id))).toEqual(new Set([QUESTION.buyerQuery, QUESTION.buyerReady]));
    expect(dec.some((x) => x.candidate_key === "buyer:brass cabinet knob")).toBe(true);

    // Cached: a second request re-asks nothing and returns the same rows.
    const again = (await call(`/projects/${s.projectId}/seo/buyer-queries`)).json.data as CoverageResponse<BuyerQueryRow>;
    expect(jev.requests).toHaveLength(1);
    expect(again.rows).toEqual(d.rows);
    expect(again.completeness!.note).toMatch(/5 from the 7-day cache, 0 Jev calls/);
  });

  it("a budget refusal stops before any call and leaves queries unclassified (said so)", async () => {
    const s = await scenario({ crawl: false, gsc: DATA });
    await new Db(s.env.DB).run("UPDATE project_limits SET provider_calls_per_day = 0 WHERE project_id = ?", s.projectId);
    const jev = buyerJev();
    setSeoJevDecisionsFactory(async () => jev);
    const d = (await makeApp(s.env, s.userId)(`/projects/${s.projectId}/seo/buyer-queries`)).json.data as CoverageResponse<BuyerQueryRow>;
    expect(jev.requests).toHaveLength(0);
    expect(d).toMatchObject({ state: "ready", rows: [] });
    expect(d.completeness!.note).toMatch(/0 of 5 .*daily Jev budget was reached/);
  });

  it("tenancy and rate limit", async () => {
    const s = await scenario({ crawl: false, gsc: DATA });
    setSeoJevDecisionsFactory(async () => null);
    const other = await seedUser(s.env);
    expect((await makeApp(s.env, other.userId)(`/projects/${s.projectId}/seo/buyer-queries`)).status).toBe(404);
    const call = makeApp(s.env, s.userId);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await call(`/projects/${s.projectId}/seo/buyer-queries`)).status);
    expect(statuses.slice(0, 10).every((x) => x === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe("GET /projects/:pid/seo/translation-opportunities", () => {
  it("returns rows from the country slice; setup_required before any sync", async () => {
    const data = { ...DATA, country: [row(["usa"], 250, 40000, 12), row(["gbr"], 30, 5000, 14)], countryPage: [row(["gbr", U.knob], 20, 3000, 12)] };
    const s = await scenario({ crawl: false, gsc: data });
    const d = (await makeApp(s.env, s.userId)(`/projects/${s.projectId}/seo/translation-opportunities`)).json.data as CoverageResponse<TranslationOpportunityRow>;
    expect(d.state).toBe("ready");
    expect(d.rows).toEqual([
      expect.objectContaining({ country: "gbr", impressions: 5000, topPages: [U.knob], servedLanguage: null, shareOfImpressions: { numerator: 5000, denominator: 45000, value: 5000 / 45000 } }),
    ]);
    const empty = await scenario({ crawl: false, gsc: null });
    const e = (await makeApp(empty.env, empty.userId)(`/projects/${empty.projectId}/seo/translation-opportunities`)).json.data as CoverageResponse<TranslationOpportunityRow>;
    expect(e).toMatchObject({ state: "setup_required", rows: [] });
  });
});
