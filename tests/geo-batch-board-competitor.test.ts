/**
 * [A7] Competitor pages read for why an AI engine cites them: SSRF single-URL mode (seo/ssrf.ts
 * approvedExternalFetch), the approval route (POST/GET /projects/:pid/geo/competitor-pages), budget, rate
 * limit, robots.txt, Jev Noul checks with tiers, the code-computed verdict, tenancy and CSRF.
 * Every fetch is a fake; nothing goes to the network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "@worker/app";
import { createApp } from "@worker/app";
import type { Env } from "@worker/env";
import { Db } from "@worker/lib/db";
import { BudgetExceededError, HttpError } from "@worker/lib/errors";
import { analyzeObservation } from "@worker/geo/analyze";
import { canonicalExternalUrl, computeVerdict, COMPETITOR_PAGE_RATE_LIMIT, VERDICT_VERSION } from "@worker/geo/competitor-pages";
import { COMPETITOR_QUESTION_IDS, competitorQuestion, competitorQuestionVersion } from "@worker/geo/questions";
import { geoBoardRoutes, setGeoBoardHooks } from "@worker/routes/geo-board";
import { approvedExternalFetch, assertApprovedExternalUrl, CrawlFetchError, sameApprovedHost } from "@worker/seo/ssrf";
import type { Budget } from "@worker/runs/context";
import type { CompetitorCheck, CompetitorPageAssessment } from "@shared/types";
import type { DecisionAnswer, DecisionRequest } from "@worker/providers/types";
import { createTestEnv } from "./helpers/env";
import { authHeaders, FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";
import { makeTestContext } from "./helpers/context";
import { fakeDecisions, fixture, noul, seedObservation, seedPromptSet } from "./fixtures/geo-analysis/seed";

const CITED = "https://bestreviews.example/best-brass-cabinet-hardware";
const PROMPT = fixture("competitor_only").prompt;

// ------------------------------------------------------------------ fake web
type Route = (url: URL, init?: RequestInit) => Response | Promise<Response>;
function fakeWeb(routes: Record<string, Route>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), init });
    const r = routes[url.toString()] ?? routes[`${url.origin}${url.pathname}`];
    if (!r) return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
    return r(url, init);
  }) as unknown as typeof fetch;
  return { impl, calls };
}
const html = (body: string, status = 200, headers: Record<string, string> = {}) => () => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
const text = (body: string, status = 200) => () => new Response(body, { status, headers: { "content-type": "text/plain" } });
const redirect = (to: string, status = 301) => () => new Response(null, { status, headers: { location: to } });

const COMPETITOR_HTML = `<!doctype html><html><head><title>Best brass cabinet hardware</title>
<meta name="author" content="Jane Doe">
<meta property="article:modified_time" content="2026-09-20T00:00:00Z">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[]}</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Knob"}</script>
</head><body><main>
<h1>Best brass cabinet hardware</h1>
<p>The best solid brass cabinet hardware that is not mass-produced comes from small foundries such as Brass Co, which cast knobs in runs of 50.</p>
<h2>What sizes do brass knobs come in?</h2><p>Most knobs are 32 mm, 38 mm or 45 mm wide and weigh 60 g to 120 g.</p>
<h2>How much does solid brass hardware cost?</h2><p>Expect $12 to $40 per knob; unlacquered finishes cost 10% more.</p>
<table><tr><th>Brand</th><th>Price</th></tr><tr><td>Brass Co</td><td>$18</td></tr></table>
<p>Sources: <a href="https://www.thespruce.com/brass">The Spruce</a>, <a href="https://en.wikipedia.org/wiki/Brass">Wikipedia</a>, <a href="https://www.nist.gov/brass">NIST</a>.</p>
<p>${"Solid brass is an alloy of copper and zinc that ages into a warm patina over the years. ".repeat(80)}</p>
</main></body></html>`;

// ------------------------------------------------------------------ app + setup
function makeApp(env: Env, userId: string, now: Date = FIXED_NOW) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", new Db(c.env.DB));
    c.set("now", now);
    c.set("user", { id: userId, email: "u@example.com", name: null });
    c.set("session", null);
    await next();
  });
  app.route("/", geoBoardRoutes);
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as 400);
    throw err;
  });
  return async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) }, env);
    return { status: res.status, headers: res.headers, json: (await res.json()) as any };
  };
}

/** Budget fake that records reservations. */
function fakeBudget(opts: { failOn?: string } = {}) {
  const log: string[] = [];
  let n = 0;
  const b: Budget = {
    async reserve(resource, amount) {
      if (opts.failOn === resource) throw new BudgetExceededError(resource, "limit");
      log.push(`reserve ${resource} ${amount}`);
      return `r${++n}`;
    },
    async settle(id, amount) {
      log.push(`settle ${id} ${amount}`);
    },
    async release(id) {
      log.push(`release ${id}`);
    },
    async markUnknown(id) {
      log.push(`unknown ${id}`);
    },
  };
  return { budget: b, log };
}

async function setup(projectOverrides: Record<string, unknown> = {}) {
  const env = createTestEnv();
  const u = await seedUser(env);
  const projectId = await seedProject(env, u.workspaceId, projectOverrides);
  const project = { id: projectId, workspaceId: u.workspaceId };
  const { promptIds } = await seedPromptSet(env, project, [PROMPT]);
  const obsId = await seedObservation(env, project, fixture("competitor_only"), { promptId: promptIds[0]! });
  await analyzeObservation(makeTestContext(env, project), obsId);
  const other = await seedUser(env, { email: "other@example.com", workspaceName: "Other workspace" });
  return { env, u, projectId, project, obsId, promptId: promptIds[0]!, db: new Db(env.DB), call: makeApp(env, u.userId), callOther: makeApp(env, other.userId) };
}

/** Jev fake: injection screen clean, both checks a confident yes unless overridden. */
function jev(over: Record<string, DecisionAnswer | undefined> = {}) {
  return fakeDecisions((k) => (k in over ? over[k] : k === "injection_risk" ? noul(0.05) : noul(0.92)));
}

function hooks(web: ReturnType<typeof fakeWeb>, decisions: ReturnType<typeof jev> | null, budget = fakeBudget()) {
  setGeoBoardHooks({ fetch: web.impl, decisions: async () => decisions, budget: () => budget.budget });
  return budget;
}

const okWeb = () =>
  fakeWeb({
    "https://bestreviews.example/robots.txt": text("User-agent: *\nAllow: /\n"),
    [CITED]: html(COMPETITOR_HTML),
  });

afterEach(() => {
  setGeoBoardHooks({});
  vi.unstubAllGlobals();
});

// ------------------------------------------------------------------ SSRF single-URL mode
describe("seo/ssrf approved external URL guard", () => {
  it("accepts http(s) public hostnames on the approved host or its www twin only", () => {
    expect(assertApprovedExternalUrl("https://Example.COM./a#frag", "example.com").toString()).toBe("https://example.com/a");
    expect(assertApprovedExternalUrl("http://www.example.com/a", "example.com").hostname).toBe("www.example.com");
    expect(sameApprovedHost("www.example.com", "example.com")).toBe(true);
    expect(sameApprovedHost("blog.example.com", "example.com")).toBe(false);
    for (const bad of [
      "ftp://example.com/a",
      "https://user:pw@example.com/a",
      "https://example.com:8443/a",
      "https://127.0.0.1/a",
      "https://2130706433/a",
      "https://0x7f.1/a",
      "https://[::1]/a",
      "https://169.254.169.254/latest/meta-data",
      "https://8.8.8.8/a",
      "https://localhost/a",
      "https://printer.local/a",
      "https://intranet/a",
      "https://other.com/a",
      "https://blog.example.com/a",
    ]) {
      expect(() => assertApprovedExternalUrl(bad, bad.includes("other.com") || bad.includes("blog.") ? "example.com" : new URL(bad.replace(/^ftp/, "https")).hostname), bad).toThrow(CrawlFetchError);
    }
  });

  it("re-checks every redirect hop and refuses hops off the approved host", async () => {
    const web = fakeWeb({
      "https://example.com/a": redirect("https://www.example.com/b"),
      "https://www.example.com/b": redirect("http://169.254.169.254/latest"),
    });
    await expect(approvedExternalFetch(web.impl, "https://example.com/a", { approvedHost: "example.com", maxBytes: 1000, timeoutMs: 1000 })).rejects.toMatchObject({ code: "redirect_offsite" });
    expect(web.calls.map((c) => c.url)).toEqual(["https://example.com/a", "https://www.example.com/b"]);
    for (const c of web.calls) expect(c.init?.redirect).toBe("manual");

    const ok = fakeWeb({ "https://example.com/a": redirect("/c"), "https://example.com/c": html("<p>hi</p>") });
    const res = await approvedExternalFetch(ok.impl, "https://example.com/a", { approvedHost: "example.com", maxBytes: 1000, timeoutMs: 1000 });
    expect(res).toMatchObject({ status: 200, finalUrl: "https://example.com/c", body: "<p>hi</p>" });
    expect(res.redirects).toHaveLength(1);

    const loop = fakeWeb({ "https://example.com/a": redirect("https://example.com/a") });
    await expect(approvedExternalFetch(loop.impl, "https://example.com/a", { approvedHost: "example.com", maxBytes: 1000, timeoutMs: 1000, maxRedirects: 3 })).rejects.toMatchObject({ code: "too_many_redirects" });
  });

  it("enforces content type, size cap, and timeout", async () => {
    const pdf = fakeWeb({ "https://example.com/a": () => new Response("%PDF", { headers: { "content-type": "application/pdf" } }) });
    await expect(approvedExternalFetch(pdf.impl, "https://example.com/a", { approvedHost: "example.com", maxBytes: 1000, timeoutMs: 1000 })).rejects.toMatchObject({ code: "non_html" });

    const big = fakeWeb({ "https://example.com/a": html("x".repeat(5000)) });
    await expect(approvedExternalFetch(big.impl, "https://example.com/a", { approvedHost: "example.com", maxBytes: 1000, timeoutMs: 1000 })).rejects.toMatchObject({ code: "too_large" });

    const hang = (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    await expect(approvedExternalFetch(hang, "https://example.com/a", { approvedHost: "example.com", maxBytes: 1000, timeoutMs: 30 })).rejects.toMatchObject({ code: "timeout" });
  });
});

// ------------------------------------------------------------------ pure pieces
describe("competitor pages: pure helpers", () => {
  it("canonicalizes URLs for per-URL approval", () => {
    expect(canonicalExternalUrl("https://BestReviews.example./x?a=1#top")).toBe("https://bestreviews.example/x?a=1");
    expect(canonicalExternalUrl("javascript:alert(1)")).toBeNull();
    expect(canonicalExternalUrl("https://u:p@x.example/")).toBeNull();
    expect(canonicalExternalUrl("not a url")).toBeNull();
  });

  it("competitor-verdict.v1: review on flag / partial / injection, adapt on 2+ gaps, else skip", () => {
    const measured: CompetitorCheck[] = [{ key: "depth", label: "Depth", noul: null, tier: null, method: "measured", detail: null }];
    const ours = { answer_first: "missing", depth: "missing", proof: "present", schema: "missing", freshness: "present", author: "missing", entity: "missing", faq: "missing" } as const;
    expect(computeVerdict({ checks: measured, partial: false, screenFlagged: false, theirs: { depth: "present", schema: "present" }, ours })).toEqual({ verdict: "adapt", gaps: ["depth", "schema"] });
    expect(computeVerdict({ checks: measured, partial: false, screenFlagged: false, theirs: { depth: "present", proof: "present" }, ours }).verdict).toBe("skip");
    expect(computeVerdict({ checks: measured, partial: true, screenFlagged: false, theirs: { depth: "present", schema: "present" }, ours }).verdict).toBe("review");
    expect(computeVerdict({ checks: measured, partial: false, screenFlagged: true, theirs: {}, ours }).verdict).toBe("review");
    const flagged: CompetitorCheck[] = [{ key: "entity", label: "Entity", noul: 0.5, tier: "flag", method: "jev", detail: null }];
    expect(computeVerdict({ checks: flagged, partial: false, screenFlagged: false, theirs: {}, ours }).verdict).toBe("review");
  });

  it("competitor Noul questions are versioned and reference only state keys", async () => {
    const q = competitorQuestion(COMPETITOR_QUESTION_IDS.answerFirst, "cited_page");
    expect(q.type).toBe("noul");
    expect(q.instructions).toContain("`cited_page.opening`");
    expect(q.instructions).not.toContain("{ref}");
    const v1 = await competitorQuestionVersion(COMPETITOR_QUESTION_IDS.answerFirst);
    const v2 = await competitorQuestionVersion(COMPETITOR_QUESTION_IDS.entity);
    expect(v1).toMatch(/\S/);
    expect(v1).not.toBe(v2);
  });
});

// ------------------------------------------------------------------ approval route
describe("POST /projects/:pid/geo/competitor-pages", () => {
  it("reads one cited URL: robots first, measured + Jev checks with tiers, verdict in code, compact evidence only", async () => {
    const s = await setup();
    const web = okWeb();
    const decisions = jev();
    const b = hooks(web, decisions);
    const r = await s.call("POST", `/projects/${s.projectId}/geo/competitor-pages`, { url: CITED });
    expect(r.status).toBe(202);
    const a = r.json.data as CompetitorPageAssessment;
    // No page of ours matches this prompt in this setup: nothing to compare, so never 'adapt' (see geo-fix-analysis tests).
    expect(a).toMatchObject({ url: CITED, host: "bestreviews.example", approvedBy: s.u.userId, state: "assessed", verdict: "skip" });
    expect(a.citedIn).toEqual([{ promptId: s.promptId, promptText: PROMPT, provider: "gemini", observationId: s.obsId }]);
    expect(web.calls.map((c) => c.url)).toEqual(["https://bestreviews.example/robots.txt", CITED]);
    expect(String((web.calls[1]!.init?.headers as Record<string, string>)["User-Agent"])).toContain("OkaraBot");

    const byKey = new Map(a.checks.map((c) => [c.key, c]));
    expect([...byKey.keys()]).toEqual(["answer_first", "depth", "proof", "schema", "freshness", "author", "entity", "faq"]);
    expect(byKey.get("answer_first")).toMatchObject({ method: "jev", noul: 0.92, tier: "act" });
    expect(byKey.get("entity")).toMatchObject({ method: "jev", noul: 0.92, tier: "act" });
    for (const k of ["depth", "proof", "schema", "freshness", "author", "faq"] as const) expect(byKey.get(k)).toMatchObject({ method: "measured", noul: null, tier: null });
    expect(byKey.get("schema")!.detail).toContain("FAQPage");
    expect(byKey.get("proof")!.detail).toBe("3 outbound source links");
    for (const c of a.checks) expect(c).not.toHaveProperty("confidence");
    expect(a.reasons.length).toBeGreaterThan(0);
    expect(a.reasons.join(" ")).not.toMatch(/copy|steal/i);

    // Jev: screen first, then the two Noul checks against the page as state (never as instructions).
    expect(decisions.requests).toHaveLength(2);
    expect(Object.keys(decisions.requests[0]!.questions)).toEqual(["injection_risk"]);
    const req = decisions.requests[1] as DecisionRequest & { state: any };
    expect(Object.keys(req.questions).sort()).toEqual(["answer_first", "entity"]);
    expect(req.state.question).toBe(PROMPT);
    expect(req.state.cited_page.title).toBe("Best brass cabinet hardware");
    for (const q of Object.values(req.questions)) expect(q.instructions).not.toContain("Brass Co");

    // Budget: 1 crawl page reserved, then settled because the page was requested.
    expect(b.log).toEqual(["reserve crawl_pages 1", "settle r1 1"]);

    const row = await s.db.first<any>("SELECT * FROM competitor_pages WHERE id = ?", a.id);
    expect(row).toMatchObject({ workspace_id: s.u.workspaceId, project_id: s.projectId, status: "assessed", http_status: 200, verdict_version: VERDICT_VERSION, jev_provider: "typesafe", jev_model: "jev-test-1" });
    const x = JSON.parse(row.extraction_json);
    expect(x.opening.length).toBeLessThanOrEqual(400);
    expect(row.extraction_json.length).toBeLessThan(COMPETITOR_HTML.length);
    expect(row.extraction_json).not.toContain("ages into a warm patina over the years. Solid brass");

    const recs = await s.db.all<any>("SELECT question_id, tier, outcome, question_version FROM decision_records WHERE workspace_id = ? AND project_id = ? ORDER BY question_id", s.u.workspaceId, s.projectId);
    expect(recs.map((d) => [d.question_id, d.tier, d.outcome])).toEqual([
      ["evidence.injection_risk", "act", "selected"],
      ["geo.competitor_answer_first", "act", "selected"],
      ["geo.competitor_entity", "act", "selected"],
    ]);
    expect(recs[1].question_version).toBe(await competitorQuestionVersion(COMPETITOR_QUESTION_IDS.answerFirst));

    // Re-approval within 7 days reuses the assessment: 200, no new fetch, no new reservation.
    const again = await s.call("POST", `/projects/${s.projectId}/geo/competitor-pages`, { url: `${CITED}#section` });
    expect(again.status).toBe(200);
    expect(again.json.data.id).toBe(a.id);
    expect(web.calls).toHaveLength(2);
    expect(b.log).toHaveLength(2);

    // GET lists it.
    const list = await s.call("GET", `/projects/${s.projectId}/geo/competitor-pages`);
    expect(list.status).toBe(200);
    expect(list.json.data.map((x: CompetitorPageAssessment) => x.id)).toEqual([a.id]);
  });

  it("without TypeSafe the measured checks still run and the Jev checks are null", async () => {
    const s = await setup();
    const web = okWeb();
    hooks(web, null);
    const r = await s.call("POST", `/projects/${s.projectId}/geo/competitor-pages`, { url: CITED });
    expect(r.status).toBe(202);
    const a = r.json.data as CompetitorPageAssessment;
    expect(a.state).toBe("assessed");
    expect(a.stateDetail).toContain("Jev not configured: 2 checks not run");
    for (const c of a.checks.filter((c) => c.method === "jev")) expect(c).toMatchObject({ noul: null, tier: null });
    expect(a.checks.find((c) => c.key === "depth")!.detail).toMatch(/words$/);
    expect(await s.db.all("SELECT id FROM decision_records WHERE project_id = ?", s.projectId)).toHaveLength(0);
  });

  it("a page whose text addresses AI systems is flagged: no Noul checks, verdict review", async () => {
    const s = await setup();
    const decisions = jev({ injection_risk: noul(0.95) });
    hooks(okWeb(), decisions);
    const a = (await s.call("POST", `/projects/${s.projectId}/geo/competitor-pages`, { url: CITED })).json.data as CompetitorPageAssessment;
    expect(decisions.requests).toHaveLength(1);
    expect(a.verdict).toBe("review");
    expect(a.stateDetail).toContain("appears to address AI systems");
    expect(a.checks.filter((c) => c.method === "jev").every((c) => c.noul === null)).toBe(true);
  });

  it("a middle-band Noul answer is tier flag and forces review", async () => {
    const s = await setup();
    hooks(okWeb(), jev({ entity: noul(0.5) }));
    const a = (await s.call("POST", `/projects/${s.projectId}/geo/competitor-pages`, { url: CITED })).json.data as CompetitorPageAssessment;
    expect(a.checks.find((c) => c.key === "entity")).toMatchObject({ noul: 0.5, tier: "flag" });
    expect(a.verdict).toBe("review");
  });

  it("robots.txt disallow blocks the read and releases the crawl reservation", async () => {
    const s = await setup();
    const web = fakeWeb({ "https://bestreviews.example/robots.txt": text("User-agent: *\nDisallow: /best-\n"), [CITED]: html(COMPETITOR_HTML) });
    const decisions = jev();
    const b = hooks(web, decisions);
    const a = (await s.call("POST", `/projects/${s.projectId}/geo/competitor-pages`, { url: CITED })).json.data as CompetitorPageAssessment;
    expect(a).toMatchObject({ state: "blocked", stateDetail: "robots.txt disallows", verdict: null, checks: [] });
    expect(web.calls.map((c) => c.url)).toEqual(["https://bestreviews.example/robots.txt"]);
    expect(decisions.requests).toHaveLength(0);
    expect(b.log).toEqual(["reserve crawl_pages 1", "release r1"]);
  });

  it("robots.txt 5xx is disallow-all; 404 is allow-all", async () => {
    const s = await setup();
    hooks(fakeWeb({ "https://bestreviews.example/robots.txt": text("down", 503), [CITED]: html(COMPETITOR_HTML) }), null);
    const a = (await s.call("POST", `/projects/${s.projectId}/geo/competitor-pages`, { url: CITED })).json.data as CompetitorPageAssessment;
    expect(a.state).toBe("blocked");

    const s2 = await setup();
    hooks(fakeWeb({ [CITED]: html(COMPETITOR_HTML) }), null);
    const a2 = (await s2.call("POST", `/projects/${s2.projectId}/geo/competitor-pages`, { url: CITED })).json.data as CompetitorPageAssessment;
    expect(a2.state).toBe("assessed");
  });

  it("login walls, off-host redirects and non-HTML are blocked; HTTP errors fail", async () => {
    const cases: Array<[Route, string, string]> = [
      [html("no", 401), "blocked", "401 login wall or access denied"],
      [redirect("https://evil.example/x"), "blocked", "Redirects to another host"],
      [() => new Response("%PDF", { headers: { "content-type": "application/pdf" } }), "blocked", "Not an HTML page"],
      [html("oops", 500), "failed", "HTTP 500"],
    ];
    for (const [route, state, detail] of cases) {
      const s = await setup();
      hooks(fakeWeb({ "https://bestreviews.example/robots.txt": text("User-agent: *\nAllow: /\n"), [CITED]: route }), jev());
      const a = (await s.call("POST", `/projects/${s.projectId}/geo/competitor-pages`, { url: CITED })).json.data as CompetitorPageAssessment;
      expect([a.state, a.stateDetail]).toEqual([state, detail]);
    }
    const s = await setup();
    hooks(
      fakeWeb({ "https://bestreviews.example/robots.txt": text("User-agent: *\nAllow: /\n"), [CITED]: redirect("/login?next=/x", 302), "https://bestreviews.example/login": html("<form></form>") }),
      jev(),
    );
    const a = (await s.call("POST", `/projects/${s.projectId}/geo/competitor-pages`, { url: CITED })).json.data as CompetitorPageAssessment;
    expect([a.state, a.stateDetail]).toEqual(["blocked", "Redirects to a login page"]);
  });

  it("refuses URLs that no stored answer cited, our own site, IP hosts, provider redirects, and bad bodies", async () => {
    const s = await setup();
    const web = okWeb();
    hooks(web, jev());
    const post = (body: unknown) => s.call("POST", `/projects/${s.projectId}/geo/competitor-pages`, body);
    expect((await post({ url: "https://bestreviews.example/other-page" })).json.error.details).toEqual({ reason: "url_not_cited" });
    expect((await post({ url: "https://shop.example.com/products/x" })).json.error.details).toEqual({ reason: "own_site" });
    expect((await post({ url: "http://127.0.0.1/admin" })).json.error.details).toEqual({ reason: "blocked_url" });
    expect((await post({ url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc" })).json.error.details).toEqual({ reason: "redirect_wrapper" });
    expect((await post({ url: "file:///etc/passwd" })).json.error.details).toEqual({ reason: "invalid_url" });
    expect((await post({ url: CITED, extra: 1 })).status).toBe(400);
    expect((await post("not json")).status).toBe(400);
    expect((await post({ url: `${CITED}?q=${"a".repeat(9000)}` })).status).toBe(413);
    expect(web.calls).toHaveLength(0);
    expect(await s.db.all("SELECT id FROM competitor_pages")).toHaveLength(0);
  });

  it("budget exhaustion is 429 budget_exceeded before any fetch", async () => {
    const s = await setup();
    const web = okWeb();
    hooks(web, jev(), fakeBudget({ failOn: "crawl_pages" }));
    const r = await s.call("POST", `/projects/${s.projectId}/geo/competitor-pages`, { url: CITED });
    expect(r.status).toBe(429);
    expect(r.json.error.code).toBe("budget_exceeded");
    expect(web.calls).toHaveLength(0);
    expect(await s.db.all("SELECT id FROM competitor_pages")).toHaveLength(0);
  });

  it("the real project budget counts the crawl page", async () => {
    const s = await setup();
    setGeoBoardHooks({ fetch: okWeb().impl, decisions: async () => null });
    const r = await s.call("POST", `/projects/${s.projectId}/geo/competitor-pages`, { url: CITED });
    expect(r.status).toBe(202);
    const used = await s.db.first<{ used: number }>("SELECT used FROM usage_counters WHERE scope_key = ? AND resource = 'crawl_pages'", `project:${s.projectId}`);
    expect(used?.used).toBe(1);
  });

  it("rate-limits approvals per project per hour with Retry-After", async () => {
    const s = await setup();
    // Each failed read is a new approval (failed reads are not reused).
    hooks(fakeWeb({ "https://bestreviews.example/robots.txt": text("User-agent: *\nAllow: /\n"), [CITED]: html("oops", 500) }), null);
    for (let i = 0; i < COMPETITOR_PAGE_RATE_LIMIT.limit; i++) {
      expect((await s.call("POST", `/projects/${s.projectId}/geo/competitor-pages`, { url: CITED })).status).toBe(202);
    }
    const r = await s.call("POST", `/projects/${s.projectId}/geo/competitor-pages`, { url: CITED });
    expect(r.status).toBe(429);
    expect(r.json.error.code).toBe("rate_limited");
    expect(Number(r.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("demo projects never fetch; other workspaces get 404 and see nothing", async () => {
    const demo = await setup({ is_demo: 1 });
    const web = okWeb();
    hooks(web, jev());
    const d = await demo.call("POST", `/projects/${demo.projectId}/geo/competitor-pages`, { url: CITED });
    expect(d.status).toBe(400);
    expect(d.json.error.details).toEqual({ reason: "demo_project" });
    expect(web.calls).toHaveLength(0);

    const s = await setup();
    expect((await s.callOther("POST", `/projects/${s.projectId}/geo/competitor-pages`, { url: CITED })).status).toBe(404);
    expect((await s.callOther("GET", `/projects/${s.projectId}/geo/competitor-pages`)).status).toBe(404);
    expect(web.calls).toHaveLength(0);
  });

  it("the full app requires the CSRF token for the POST; rows cascade with the project", async () => {
    const s = await setup();
    const web = okWeb();
    hooks(web, null);
    const app = createApp();
    const path = `/api/projects/${s.projectId}/geo/competitor-pages`;
    const noCsrf = await app.request(path, { method: "POST", headers: { ...authHeaders(s.u.sessionToken, ""), "X-CSRF-Token": "" }, body: JSON.stringify({ url: CITED }) }, s.env);
    expect(noCsrf.status).toBe(403);
    expect(web.calls).toHaveLength(0);
    const ok = await app.request(path, { method: "POST", headers: authHeaders(s.u.sessionToken, s.u.csrfToken), body: JSON.stringify({ url: CITED }) }, s.env);
    expect(ok.status).toBe(202);
    const board = await app.request(`/api/projects/${s.projectId}/geo/board`, { headers: authHeaders(s.u.sessionToken, s.u.csrfToken) }, s.env);
    expect(board.status).toBe(200);

    await s.db.run("DELETE FROM projects WHERE id = ?", s.projectId);
    expect(await s.db.all("SELECT id FROM competitor_pages")).toHaveLength(0);
  });
});
