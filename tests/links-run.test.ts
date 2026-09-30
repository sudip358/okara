/** [A25] runLinkSuggestions end-to-end over seeded crawl data (no network, fake Jev). */
import { describe, expect, it } from "vitest";
import type { LinkSuggestionReport } from "@shared/types";
import { DEMO_LABEL } from "@worker/demo/fixtures";
import { seedDemoProject } from "@worker/demo/seed";
import { Db } from "@worker/lib/db";
import { LABEL_CONFIDENCE, LABEL_REVIEW_ONLY, getLinkReport, topLinkSuggestionsForAgent, updateLinkUserStatus } from "@worker/links/report";
import { runLinkSuggestions } from "@worker/links/run";
import { createTestEnv } from "./helpers/env";
import { FIXED_NOW, seedProject, seedUser } from "./helpers/fixtures";
import { STORE, U, confidentYes, fakeDecisions, noul, projectRow, seedGscImpressions, seedLinkCrawl, type AnswerFn } from "./links-seed";

async function setup(projectOverrides: Record<string, unknown> = {}) {
  const env = createTestEnv();
  const { workspaceId, userId } = await seedUser(env);
  const projectId = await seedProject(env, workspaceId, projectOverrides);
  const db = new Db(env.DB);
  return { env, db, workspaceId, userId, projectId };
}

const pairOf = (r: LinkSuggestionReport) => r.suggestions.map((s) => `${new URL(s.source.url).pathname} -> ${new URL(s.target.url).pathname}`);
const NEVER_TARGETS = ["/gone", "/old-pulls", "/pages/patina-samples", "/products/brass-pull?variant=2", "https://other.example.com/brass-patina"];

describe("links: run setup", () => {
  it("is setup_required without a verified host, and without a crawl", async () => {
    const a = await setup({ verified_host: null, verification_method: null, verified_at: null });
    await seedLinkCrawl(a.db, a.workspaceId, a.projectId, STORE);
    const r1 = await runLinkSuggestions(a.env, a.db, await projectRow(a.db, a.projectId), FIXED_NOW, { decisions: null });
    expect(r1.state).toBe("setup_required");
    expect(r1.labels.join(" ")).toMatch(/Verify site ownership/);

    const b = await setup();
    const r2 = await runLinkSuggestions(b.env, b.db, await projectRow(b.db, b.projectId), FIXED_NOW, { decisions: null });
    expect(r2.state).toBe("setup_required");
    expect(r2.labels.join(" ")).toMatch(/No crawl yet/);
    expect(await b.db.first("SELECT id FROM link_runs WHERE project_id = ?", b.projectId)).toBeNull();
    expect((await getLinkReport(b.db, await projectRow(b.db, b.projectId))).state).toBe("setup_required");
  });
});

describe("links: deterministic run (no Jev)", () => {
  it("produces review suggestions from the latest crawl with exclusions, orphans, labels, and completeness", async () => {
    const { env, db, workspaceId, projectId } = await setup();
    await seedLinkCrawl(db, workspaceId, projectId, STORE);
    await seedGscImpressions(db, workspaceId, projectId, [{ path: "/blogs/news/brass-care", impressions: 1200 }]);
    const r = await runLinkSuggestions(env, db, await projectRow(db, projectId), FIXED_NOW, { decisions: null });

    expect(r.state).toBe("ready");
    expect(r.labels).toContain(LABEL_REVIEW_ONLY);
    expect(r.labels).toContain(LABEL_CONFIDENCE);
    expect(r.labels.join(" ")).toMatch(/Jev \(TypeSafe\) is not configured/);
    expect(r.suggestions.length).toBeGreaterThan(0);
    for (const s of r.suggestions) {
      expect(s).toMatchObject({ method: "deterministic", status: "review", decision: null, userStatus: "open" });
      expect(s.sentence!.text.toLowerCase()).toContain(s.anchor!.text.toLowerCase());
      expect(NEVER_TARGETS.map(U)).not.toContain(s.target.url);
      expect(s.source.url).not.toBe(s.target.url);
    }
    // Existing links are skipped: the care article already links to the product, the home page to the care article.
    expect(pairOf(r)).not.toContain("/blogs/news/brass-care -> /products/brass-pull");
    expect(pairOf(r)).not.toContain("/ -> /blogs/news/brass-care");
    // The product page's care sentence is the top suggestion, boosted by GSC impressions and a low inlink count.
    const top = r.suggestions[0]!;
    expect(`${new URL(top.source.url).pathname} -> ${new URL(top.target.url).pathname}`).toBe("/products/brass-pull -> /blogs/news/brass-care");
    expect(top.anchor!.text).toBe("care for brass");
    expect(top.reasons.join(" ")).toMatch(/1,200 GSC impressions/);
    // The orphan article is listed and suggested as a target.
    expect(r.orphanPages.map((o) => o.url)).toEqual([U("/blogs/news/brass-patina")]);
    const toOrphan = r.suggestions.filter((s) => s.target.url === U("/blogs/news/brass-patina"));
    expect(toOrphan.length).toBeGreaterThan(0);
    expect(toOrphan.every((s) => s.target.orphan && s.target.inlinks === 0)).toBe(true);
    expect(r.completeness!.note).toMatch(/^\d+ of \d+ pages analysed/);
    expect(r.pagesAnalysed).toBe(r.completeness!.covered);
  });

  it("uses sentences split from the stored excerpt for snapshots without link context", async () => {
    const { env, db, workspaceId, projectId } = await setup();
    const store = STORE.map((p) => (p.path === "/products/brass-pull" ? { ...p, sentences: [], excerpt: STORE[2]!.sentences!.join(" ") } : p));
    await seedLinkCrawl(db, workspaceId, projectId, store);
    const r = await runLinkSuggestions(env, db, await projectRow(db, projectId), FIXED_NOW, { decisions: null });
    expect(pairOf(r)).toContain("/products/brass-pull -> /blogs/news/brass-care");
    expect(r.completeness!.note).toMatch(/1 using sentences from the stored excerpt/);
  });

  it("reports generic-anchor flags from the crawl", async () => {
    const { env, db, workspaceId, projectId } = await setup();
    const store = STORE.map((p) => (p.path === "/" ? { ...p, genericAnchors: [{ href: U("/blogs/news/brass-care"), text: "read more" }] } : p));
    await seedLinkCrawl(db, workspaceId, projectId, store);
    const r = await runLinkSuggestions(env, db, await projectRow(db, projectId), FIXED_NOW, { decisions: null });
    expect(r.genericAnchors).toEqual([{ sourceUrl: U("/"), targetUrl: U("/blogs/news/brass-care"), anchor: "read more" }]);
  });
});

describe("links: Jev run", () => {
  it("maps act answers to suggested, stores decision fields, and feeds the SEO agent helper", async () => {
    const { env, db, workspaceId, projectId } = await setup();
    await seedLinkCrawl(db, workspaceId, projectId, STORE);
    const fake = fakeDecisions(confidentYes);
    const r = await runLinkSuggestions(env, db, await projectRow(db, projectId), FIXED_NOW, { decisions: fake.provider });
    expect(fake.requests.length).toBe(Math.ceil(r.suggestions.length / 10));
    for (const s of r.suggestions) {
      expect(s).toMatchObject({ method: "jev", status: "suggested", role: "deeper_detail" });
      expect(s.decision).toMatchObject({ tier: "act", shouldExist: 0.93, sentenceConfidence: 0.9, anchorConfidence: 0.9, roleConfidence: 0.85, provider: "typesafe", model: "jev-test-2026-09" });
    }
    expect(r.labels.join(" ")).toMatch(/Jev \(typesafe, model jev-test-2026-09\) answered \d+ of \d+ pairs in \d+ call/);
    const recs = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM decision_records WHERE project_id = ? AND candidate_key LIKE 'link:%'", projectId);
    expect(recs!.n).toBe(r.suggestions.length);

    const top = await topLinkSuggestionsForAgent(db, workspaceId, projectId, 2);
    expect(top.map((s) => s.id)).toEqual(r.suggestions.slice(0, 2).map((s) => s.id));
    await updateLinkUserStatus(db, await projectRow(db, projectId), top[0]!.id, "dismissed", FIXED_NOW);
    expect((await topLinkSuggestionsForAgent(db, workspaceId, projectId, 2)).map((s) => s.id)).not.toContain(top[0]!.id);
  });

  it("rejects pairs Jev says should not exist and pairs with no fitting sentence", async () => {
    const { env, db, workspaceId, projectId } = await setup();
    await seedLinkCrawl(db, workspaceId, projectId, STORE);
    const answer: AnswerFn = (qid, req) => {
      const key = qid.split(".")[0]!;
      const state = (req.state as Record<string, { target: { url: string }; source: { url: string } }>)[key]!;
      if (qid.endsWith(".should_exist") && state.target.url.endsWith("/brass-patina")) return noul(0.05);
      if (qid.endsWith(".sentence") && state.source.url.endsWith("/products/brass-pull")) return { type: "choice", choice: "none", confidence: 0.9, probabilities: { none: 0.9, s0: 0.1 } };
      return confidentYes(qid, req, 1);
    };
    const r = await runLinkSuggestions(env, db, await projectRow(db, projectId), FIXED_NOW, { decisions: fakeDecisions(answer).provider });
    const byPair = new Map(r.suggestions.map((s) => [`${new URL(s.source.url).pathname} -> ${new URL(s.target.url).pathname}`, s]));
    for (const s of r.suggestions.filter((x) => x.target.url.endsWith("/brass-patina"))) expect(s.status).toBe("rejected");
    expect(byPair.get("/products/brass-pull -> /blogs/news/brass-care")!.status).toBe("rejected");
    // Rejected rows sort after suggested/review rows.
    const order = r.suggestions.map((s) => s.status);
    expect(order.indexOf("rejected")).toBeGreaterThan(order.lastIndexOf("suggested"));
  });

  it("falls back to deterministic review for every pair when the Jev budget is exhausted", async () => {
    const { env, db, workspaceId, projectId } = await setup();
    await seedLinkCrawl(db, workspaceId, projectId, STORE);
    const fake = fakeDecisions(confidentYes, { budgetOnCall: 1 });
    const r = await runLinkSuggestions(env, db, await projectRow(db, projectId), FIXED_NOW, { decisions: fake.provider });
    expect(r.suggestions.length).toBeGreaterThan(0);
    for (const s of r.suggestions) {
      expect(s).toMatchObject({ method: "deterministic", status: "review", decision: null });
      expect(s.reasons[0]).toMatch(/daily Jev budget is used up/);
    }
    expect(r.labels.join(" ")).toMatch(/Jev budget reached/);
    const run = await db.first<{ status: string }>("SELECT status FROM link_runs WHERE project_id = ?", projectId);
    expect(run!.status).toBe("partial");
  });

  it("budget exhausted part-way: pairs answered before the limit keep Jev's answers, the rest are deterministic review", async () => {
    const { env, db, workspaceId, projectId } = await setup();
    await seedLinkCrawl(db, workspaceId, projectId, STORE);
    const fake = fakeDecisions(confidentYes, { budgetOnCall: 2 });
    const r = await runLinkSuggestions(env, db, await projectRow(db, projectId), FIXED_NOW, { decisions: fake.provider, batchSize: 1, maxPairs: 3 });
    expect(r.suggestions).toHaveLength(3);
    expect(r.suggestions.filter((s) => s.method === "jev")).toHaveLength(1);
    expect(r.suggestions.filter((s) => s.method === "deterministic" && s.status === "review")).toHaveLength(2);
    expect(r.completeness!.note).toMatch(/pairs capped at 3/);
  });
});

describe("links: user status persists across reruns", () => {
  it("carries accepted/dismissed/implemented over by (source, target, anchor), and a dismissed pair when the anchor changes", async () => {
    const { env, db, workspaceId, projectId } = await setup();
    await seedLinkCrawl(db, workspaceId, projectId, STORE);
    const project = await projectRow(db, projectId);
    const first = await runLinkSuggestions(env, db, project, FIXED_NOW, { decisions: null });
    expect(first.suggestions.length).toBeGreaterThanOrEqual(3);
    const [a, b, c] = first.suggestions;
    await updateLinkUserStatus(db, project, a!.id, "accepted", FIXED_NOW);
    await updateLinkUserStatus(db, project, b!.id, "implemented", FIXED_NOW);
    await updateLinkUserStatus(db, project, c!.id, "dismissed", FIXED_NOW);
    // Simulate the dismissed pair coming back with a different anchor.
    await db.run("UPDATE link_suggestions SET anchor_text = 'old anchor', suggestion_key = source_page_id || '|' || target_page_id || '|old anchor' WHERE id = ?", c!.id);

    const later = new Date(FIXED_NOW.getTime() + 3_600_000);
    const second = await runLinkSuggestions(env, db, project, later, { decisions: null });
    const key = (s: { source: { pageId: string }; target: { pageId: string }; anchor: { text: string } | null }) => `${s.source.pageId}|${s.target.pageId}|${s.anchor?.text}`;
    const byKey = new Map(second.suggestions.map((s) => [key(s), s]));
    expect(byKey.get(key(a!))!.userStatus).toBe("accepted");
    expect(byKey.get(key(b!))!.userStatus).toBe("implemented");
    expect(byKey.get(key(c!))!.userStatus).toBe("dismissed");
    expect(second.suggestions.filter((s) => s.userStatus === "open")).toHaveLength(second.suggestions.length - 3);
    expect(byKey.get(key(a!))!.id).not.toBe(a!.id);

    // Only the latest run's rows are served; superseded rows are gone, and the dismissed memory row remains.
    const runs = await db.all<{ id: string }>("SELECT id FROM link_runs WHERE project_id = ?", projectId);
    const rows = await db.all<{ link_run_id: string; user_status: string }>("SELECT link_run_id, user_status FROM link_suggestions WHERE project_id = ?", projectId);
    expect(rows.filter((r) => r.user_status === "open").every((r) => r.link_run_id === rows.find((x) => x.user_status === "accepted")!.link_run_id)).toBe(true);
    expect(rows.filter((r) => r.user_status !== "open")).toHaveLength(4);
    expect(runs).toHaveLength(2);

    const third = await runLinkSuggestions(env, db, project, new Date(later.getTime() + 3_600_000), { decisions: null });
    expect(third.suggestions.filter((s) => s.userStatus !== "open").map((s) => s.userStatus).sort()).toEqual(["accepted", "dismissed", "implemented"]);
  });
});

describe("links: demo project", () => {
  it("runs on the demo crawl without calling Jev and reports the demo state", async () => {
    const env = createTestEnv({ DEMO_MODE: "true", ENVIRONMENT: "development" });
    const { userId } = await seedUser(env);
    const db = new Db(env.DB);
    const project = await seedDemoProject(env, db, userId, FIXED_NOW);
    const fake = fakeDecisions(confidentYes);
    const r = await runLinkSuggestions(env, db, project, FIXED_NOW, { decisions: fake.provider });
    expect(r.state).toBe("demo");
    expect(fake.requests).toHaveLength(0);
    expect(r.labels.join(" ")).toContain(DEMO_LABEL);
    expect(r.suggestions.length).toBeGreaterThan(0);
    expect(r.suggestions.every((s) => s.method === "deterministic" && s.status === "review")).toBe(true);
    expect(r.suggestions.every((s) => s.source.url.startsWith("https://demo.example/"))).toBe(true);
    expect((await getLinkReport(db, project)).state).toBe("demo");
  });
});
