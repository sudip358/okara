/**
 * Follow-up fixes for competitor pages (POST /projects/:pid/geo/competitor-pages):
 *  - every CompetitorCheck carries `status` (their page's presence);
 *  - only API-sampled answers make a URL approvable (manual imports never do);
 *  - an injection screen that errors fails closed (verdict review, evidence untrusted);
 *  - with no matched page of ours there are no gaps and the verdict is never 'adapt';
 *  - a redirect to the www. twin is checked against the twin's robots.txt before it is requested.
 * Every fetch is a fake; nothing goes to the network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "@worker/app";
import type { Env } from "@worker/env";
import { Db } from "@worker/lib/db";
import { BudgetExceededError, HttpError } from "@worker/lib/errors";
import { analyzeObservation } from "@worker/geo/analyze";
import { computeVerdict } from "@worker/geo/competitor-pages";
import { geoBoardRoutes, setGeoBoardHooks } from "@worker/routes/geo-board";
import type { Budget } from "@worker/runs/context";
import type { CompetitorPageAssessment } from "@shared/types";
import type { DecisionAnswer } from "@worker/providers/types";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";
import { makeTestContext } from "./helpers/context";
import { fakeDecisions, fixture, noul, seedObservation, seedPromptSet } from "./fixtures/geo-analysis/seed";
import { seedCrawl, seedObservation as seedRawObservation } from "./coverage-seed";

const CITED = "https://bestreviews.example/best-brass-cabinet-hardware";
const WWW_CITED = "https://www.bestreviews.example/best-brass-cabinet-hardware";
const PROMPT = fixture("competitor_only").prompt;

type Route = (url: URL, init?: RequestInit) => Response | Promise<Response>;
function fakeWeb(routes: Record<string, Route>) {
  const calls: string[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    const r = routes[url.toString()];
    if (!r) return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
    return r(url, init);
  }) as unknown as typeof fetch;
  return { impl, calls };
}
const html = (body: string) => () => new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
const text = (body: string) => () => new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
const redirect = (to: string) => () => new Response(null, { status: 301, headers: { location: to } });

const PAGE = `<!doctype html><html><head><title>Best brass cabinet hardware</title>
<meta name="author" content="Jane Doe">
<meta property="article:modified_time" content="2026-09-20T00:00:00Z">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[]}</script>
</head><body><main>
<h1>Best brass cabinet hardware</h1>
<p>The best solid brass cabinet hardware that is not mass-produced comes from small foundries.</p>
<h2>What sizes do brass knobs come in?</h2><p>Most knobs are 32 mm, 38 mm or 45 mm wide.</p>
<p>Sources: <a href="https://www.thespruce.com/brass">The Spruce</a>, <a href="https://en.wikipedia.org/wiki/Brass">Wikipedia</a>, <a href="https://www.nist.gov/brass">NIST</a>.</p>
<p>${"Solid brass is an alloy of copper and zinc that ages into a warm patina over the years. ".repeat(80)}</p>
</main></body></html>`;
const ALLOW = text("User-agent: *\nAllow: /\n");

function fakeBudget(): Budget {
  let n = 0;
  return {
    async reserve() {
      return `r${++n}`;
    },
    async settle() {},
    async release() {},
    async markUnknown() {},
  };
}

function makeApp(env: Env, userId: string) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", new Db(c.env.DB));
    c.set("now", FIXED_NOW);
    c.set("user", { id: userId, email: "u@example.com", name: null });
    c.set("session", null);
    await next();
  });
  app.route("/", geoBoardRoutes);
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as 400);
    throw err;
  });
  return async (body: unknown, pid: string) => {
    const res = await app.request(`/projects/${pid}/geo/competitor-pages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, env);
    return { status: res.status, json: (await res.json()) as any };
  };
}

async function setup(opts: { cite?: boolean } = {}) {
  const env = createTestEnv();
  const u = await seedUser(env);
  const projectId = await seedProject(env, u.workspaceId);
  const project = { id: projectId, workspaceId: u.workspaceId };
  const { promptIds } = await seedPromptSet(env, project, [PROMPT]);
  if (opts.cite !== false) {
    const obsId = await seedObservation(env, project, fixture("competitor_only"), { promptId: promptIds[0]! });
    await analyzeObservation(makeTestContext(env, project), obsId);
  }
  const db = new Db(env.DB);
  const call = makeApp(env, u.userId);
  return { env, u, projectId, promptId: promptIds[0]!, db, ws: u.workspaceId, pid: projectId, post: (body: unknown) => call(body, projectId) };
}

const jevOk = (over: Record<string, DecisionAnswer | undefined> = {}) => fakeDecisions((k) => (k in over ? over[k] : k === "injection_risk" ? noul(0.05) : noul(0.92)));

function hooks(web: ReturnType<typeof fakeWeb>, decisions: ReturnType<typeof fakeDecisions> | null) {
  setGeoBoardHooks({ fetch: web.impl, decisions: async () => decisions, budget: () => fakeBudget() });
}

afterEach(() => {
  setGeoBoardHooks({});
  vi.unstubAllGlobals();
});

describe("competitor checks carry their page's presence (status)", () => {
  it("sets status on every check, measured and Jev, from the same presence the verdict uses", async () => {
    const s = await setup();
    hooks(fakeWeb({ "https://bestreviews.example/robots.txt": ALLOW, [CITED]: html(PAGE) }), jevOk({ entity: noul(0.1) }));
    const a = (await s.post({ url: CITED })).json.data as CompetitorPageAssessment;
    expect(a.state).toBe("assessed");
    const by = new Map(a.checks.map((c) => [c.key, c]));
    for (const c of a.checks) expect(["present", "partial", "missing", "unknown"]).toContain(c.status);
    expect(by.get("depth")!.status).toBe("present");
    expect(by.get("schema")!.status).toBe("present");
    expect(by.get("author")!.status).toBe("present");
    expect(by.get("answer_first")).toMatchObject({ method: "jev", status: "present" });
    expect(by.get("entity")).toMatchObject({ method: "jev", status: "missing" });
    const row = await s.db.first<{ extraction_json: string }>("SELECT extraction_json FROM competitor_pages WHERE id = ?", a.id);
    const presence = JSON.parse(row!.extraction_json).presence as Record<string, string>;
    for (const c of a.checks) expect(c.status).toBe(presence[c.key] ?? "unknown");
  });

  it("Jev checks are 'unknown' when Jev is not configured", async () => {
    const s = await setup();
    hooks(fakeWeb({ "https://bestreviews.example/robots.txt": ALLOW, [CITED]: html(PAGE) }), null);
    const a = (await s.post({ url: CITED })).json.data as CompetitorPageAssessment;
    for (const c of a.checks.filter((c) => c.method === "jev")) expect(c.status).toBe("unknown");
    expect(a.checks.find((c) => c.key === "depth")!.status).toBe("present");
  });
});

describe("only API-sampled answers authorise a fetch", () => {
  it("a URL cited only by a manual import is url_not_cited and nothing is fetched", async () => {
    const s = await setup({ cite: false });
    await seedRawObservation(s, { promptId: s.promptId, promptText: PROMPT, measurement: "manual_import", citations: [{ url: CITED }] });
    const web = fakeWeb({ "https://bestreviews.example/robots.txt": ALLOW, [CITED]: html(PAGE) });
    hooks(web, null);
    const r = await s.post({ url: CITED });
    expect(r.status).toBe(400);
    expect(r.json.error.details).toEqual({ reason: "url_not_cited" });
    expect(web.calls).toHaveLength(0);

    // The same URL cited by an API-sampled answer is approvable, and citedIn lists only the API answer.
    const apiObs = await seedRawObservation(s, { promptId: s.promptId, promptText: PROMPT, citations: [{ url: CITED }] });
    const ok = await s.post({ url: CITED });
    expect(ok.status).toBe(202);
    expect((ok.json.data as CompetitorPageAssessment).citedIn.map((c) => c.observationId)).toEqual([apiObs]);
  });
});

describe("injection screen fails closed", () => {
  for (const [name, err] of [
    ["provider error", new Error("Jev down")],
    ["budget stop", new BudgetExceededError("jev_calls", "limit")],
  ] as const) {
    it(`a screen ${name} gives verdict review with an 'unavailable' screen and no Noul checks`, async () => {
      const s = await setup();
      // Our matched page lacks several checks their page has, so without the fail-closed rule this would be 'adapt'.
      await seedCrawl(s, [{ path: "/collections/solid-brass-cabinet-hardware", title: "Solid brass cabinet hardware", h1: ["Solid brass cabinet hardware"], words: 100, jsonld: [], outbound: 0 }]);
      const decisions = fakeDecisions(() => noul(0.05), { fail: err });
      hooks(fakeWeb({ "https://bestreviews.example/robots.txt": ALLOW, [CITED]: html(PAGE) }), decisions);
      const a = (await s.post({ url: CITED })).json.data as CompetitorPageAssessment;
      expect(decisions.requests).toHaveLength(1);
      expect(Object.keys(decisions.requests[0]!.questions)).toEqual(["injection_risk"]);
      expect(a.state).toBe("assessed");
      expect(a.verdict).toBe("review");
      expect(a.stateDetail).toContain("Injection screen unavailable; evidence treated as untrusted");
      for (const c of a.checks.filter((c) => c.method === "jev")) expect(c).toMatchObject({ noul: null, tier: null, status: "unknown" });
      const row = await s.db.first<{ extraction_json: string; jev_provider: string | null }>("SELECT extraction_json, jev_provider FROM competitor_pages WHERE id = ?", a.id);
      expect(JSON.parse(row!.extraction_json).injectionScreen).toBe("unavailable");
      expect(row!.jev_provider).toBeNull();
    });
  }
});

describe("no matched page of ours: no gaps, never adapt", () => {
  it("pure rule: all-unknown ours gives no gaps and skip", () => {
    const unknown = { answer_first: "unknown", depth: "unknown", proof: "unknown", schema: "unknown", freshness: "unknown", author: "unknown", entity: "unknown", faq: "unknown" } as const;
    expect(computeVerdict({ checks: [], partial: false, screenFlagged: false, theirs: { depth: "present", schema: "present", faq: "present" }, ours: unknown })).toEqual({ verdict: "skip", gaps: [] });
  });

  it("without a crawled page matching the prompt the verdict is skip, gaps empty, with a note", async () => {
    const s = await setup();
    hooks(fakeWeb({ "https://bestreviews.example/robots.txt": ALLOW, [CITED]: html(PAGE) }), jevOk());
    const a = (await s.post({ url: CITED })).json.data as CompetitorPageAssessment;
    expect(a.verdict).toBe("skip");
    expect(a.stateDetail).toContain("No page on your site matches this question; compared against no page");
    const x = JSON.parse((await s.db.first<{ extraction_json: string }>("SELECT extraction_json FROM competitor_pages WHERE id = ?", a.id))!.extraction_json);
    expect(x.ourPage).toBeNull();
    expect(x.gaps).toEqual([]);
  });

  it("with a matched page lacking 2+ checks the verdict is adapt and the gaps name them", async () => {
    const s = await setup();
    const { pageIds } = await seedCrawl(s, [{ path: "/collections/solid-brass-cabinet-hardware", title: "Solid brass cabinet hardware", h1: ["Solid brass cabinet hardware"], words: 100, jsonld: [], outbound: 0 }]);
    hooks(fakeWeb({ "https://bestreviews.example/robots.txt": ALLOW, [CITED]: html(PAGE) }), jevOk());
    const a = (await s.post({ url: CITED })).json.data as CompetitorPageAssessment;
    expect(a.verdict).toBe("adapt");
    const x = JSON.parse((await s.db.first<{ extraction_json: string }>("SELECT extraction_json FROM competitor_pages WHERE id = ?", a.id))!.extraction_json);
    expect(x.ourPage.pageId).toBe(pageIds["/collections/solid-brass-cabinet-hardware"]);
    expect(x.gaps).toEqual(expect.arrayContaining(["depth", "schema", "author"]));
    expect(a.stateDetail ?? "").not.toContain("compared against no page");
  });
});

describe("robots.txt of the www twin on redirect", () => {
  it("a redirect to the www twin whose robots.txt disallows is blocked before the twin page is requested", async () => {
    const s = await setup();
    const web = fakeWeb({
      "https://bestreviews.example/robots.txt": ALLOW,
      [CITED]: redirect(WWW_CITED),
      "https://www.bestreviews.example/robots.txt": text("User-agent: *\nDisallow: /best-\n"),
      [WWW_CITED]: html(PAGE),
    });
    const decisions = jevOk();
    hooks(web, decisions);
    const a = (await s.post({ url: CITED })).json.data as CompetitorPageAssessment;
    expect(a).toMatchObject({ state: "blocked", stateDetail: "robots.txt of www.bestreviews.example disallows the redirect target", verdict: null });
    expect(web.calls).toEqual(["https://bestreviews.example/robots.txt", CITED, "https://www.bestreviews.example/robots.txt"]);
    expect(decisions.requests).toHaveLength(0);
  });

  it("a twin that allows is read, and its robots.txt is fetched once", async () => {
    const s = await setup();
    const web = fakeWeb({
      "https://bestreviews.example/robots.txt": ALLOW,
      [CITED]: redirect(`${WWW_CITED}?a=1`),
      [`${WWW_CITED}?a=1`]: redirect(WWW_CITED),
      "https://www.bestreviews.example/robots.txt": ALLOW,
      [WWW_CITED]: html(PAGE),
    });
    hooks(web, null);
    const a = (await s.post({ url: CITED })).json.data as CompetitorPageAssessment;
    expect(a.state).toBe("assessed");
    expect(web.calls.filter((u) => u.endsWith("/robots.txt"))).toEqual(["https://bestreviews.example/robots.txt", "https://www.bestreviews.example/robots.txt"]);
  });

  it("a same-host redirect into a disallowed path is blocked too", async () => {
    const s = await setup();
    const web = fakeWeb({
      "https://bestreviews.example/robots.txt": text("User-agent: *\nDisallow: /private/\n"),
      [CITED]: redirect("https://bestreviews.example/private/page"),
      "https://bestreviews.example/private/page": html(PAGE),
    });
    hooks(web, null);
    const a = (await s.post({ url: CITED })).json.data as CompetitorPageAssessment;
    expect(a).toMatchObject({ state: "blocked", stateDetail: "robots.txt disallows the redirect target" });
    expect(web.calls).not.toContain("https://bestreviews.example/private/page");
  });
});
