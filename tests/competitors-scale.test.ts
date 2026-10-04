/**
 * [A39] "add competitors data from sheet": up to 60 tracked competitors.
 *   - one shared cap (worker schema, web validation, import room math);
 *   - domain cleaning of the competitors import (URL -> host, www., case, page URL noted, dedupe, own domain,
 *     invalid hosts, "ww." typo suggestions that need the owner's acceptance, subdomains grouped under the parent);
 *   - DataForSEO auto-fetch: cost estimate in the dry run, the import option (default on <= 10 new, off above),
 *     52 new domains -> at most 10 refreshes per UTC day, the rest DEFERRED (backlog drained by the cron), none dropped;
 *     no credentials -> nothing queued;
 *   - GEO: Jev calls per answer do not scale with the competitor count (60 competitors, an answer naming 2);
 *   - bounded reads with 60 competitors x many observations.
 * The sheet fixture is synthetic (".example" hosts), shaped like the "04 - Competitors" tab. Nothing reaches the network.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "@worker/app";
import type { Env } from "@worker/env";
import { Db } from "@worker/lib/db";
import { newId } from "@worker/lib/ids";
import { MAX_COMPETITORS as SHARED_MAX, cleanCompetitorDomain, parentDomainIn, wwwTypoSuggestion } from "@shared/competitors";
import { MAX_COMPETITORS as WORKER_MAX, normalizeDomain as workerNormalizeDomain, projectInputSchema } from "@worker/platform/projects";
import {
  FETCHES_PER_PROJECT_PER_DAY,
  competitorDomains,
  estimateCompetitorFetch,
  onCompetitorsChanged,
  processQueuedCompetitorFetches,
  prune,
  setCompetitorDataFetch,
} from "@worker/competitors/dataforseo";
import { maxRefreshCostUsd } from "@worker/providers/dataforseo";
import { analyzeObservation, MAX_JEV_STATE_BRANDS } from "@worker/geo/analyze";
import { competitorTermsForState, brandTermsFrom, createBrandClassifier } from "@worker/seo/gsc/brand";
import { brandBlindViolations } from "@worker/geo/prompts";
import { competitorList, namedCompetitors } from "@worker/geo/proposals";
import type { ProjectRow } from "@worker/platform/access";
import type { ImportPlan } from "@shared/import";
import type { CompetitorDataPanel } from "@shared/competitor-data";
import type { Project } from "@shared/types";
import { MAX_COMPETITORS as WEB_MAX, LIMITS, domainError, normalizeDomain as webNormalizeDomain, validateProjectInput } from "@web/lib/validation";
import { createTestEnv } from "./helpers/env";
import { authHeaders, seedProject, seedUser } from "./helpers/fixtures";
import { makeTestContext } from "./helpers/context";
import { COMPETITORS_HEADERS } from "./fixtures/sheets";
import { choice, fakeDecisions, noul, seedObservation } from "./fixtures/geo-analysis/seed";

const app = createApp();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
type U = { sessionToken: string; csrfToken: string; userId: string; workspaceId: string };

async function call(env: Env, u: { sessionToken: string; csrfToken: string }, method: string, path: string, body?: unknown) {
  const res = await app.request(`/api${path}`, { method, headers: authHeaders(u.sessionToken, u.csrfToken), body: body === undefined ? undefined : JSON.stringify(body) }, env);
  const text = await res.text();
  return { status: res.status, json: text && text.startsWith("{") ? (JSON.parse(text) as { data?: Json; error?: { code: string; message: string } }) : null };
}

const csv = (rows: string[][]) => rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n");
const MAPPING = { domain: "Competing Domains", notes: "Notes", assignedTo: "Assigned to", metrics: COMPETITORS_HEADERS.slice(3) };
const body = (rows: string[][], options: Record<string, unknown> = {}) => ({ source: { kind: "csv", name: "04 - Competitors.csv", text: csv(rows) }, destination: "competitors", mapping: MAPPING, options });

/** Project owned at residence.example, no competitors yet (room for 60). */
async function setup(envOver: Partial<Env> = {}, projectOver: Record<string, unknown> = {}) {
  const env = createTestEnv(envOver);
  const u = await seedUser(env);
  const pid = await seedProject(env, u.workspaceId, {
    site_url: "https://www.residence.example",
    verified_host: "www.residence.example",
    gsc_property: null,
    brand_name: "Residence Example",
    competitors_json: "[]",
    ...projectOver,
  });
  return { env, u: u as U & typeof u, pid, db: new Db(env.DB) };
}

/**
 * Synthetic rows shaped like the "04 - Competitors" tab (52 competitor entries + messy cells): the own domain, bare
 * domains, "www.", full URLs, a deep link, a trailing slash, mixed case, a "ww." typo, a subdomain of the typo's
 * corrected domain, a duplicate after cleaning, an invalid cell and a local host.
 */
function messyRows(): string[][] {
  const metrics = (i: number) => [String(20 + (i % 60)), String(100 + i), `${(i + 1) * 1000}`, `${(i + 1) * 300}`, `${i * 7}`];
  const rows: string[][] = [COMPETITORS_HEADERS];
  rows.push(["residence.example", "our own site", "", ...metrics(0)]); // row 2: own domain (bare) -> skipped
  rows.push(["https://www.bigbox.example", "home improvement", "Sam", ...metrics(1)]); // row 3: full URL + www.
  rows.push(["https://www.bigbox.example/n/ideas-inspiration/living-room-ideas", "deep link", "", ...metrics(2)]); // row 4: deep link -> dup of row 3
  rows.push(["lights.example/", "", "Ana", ...metrics(3)]); // row 5: trailing slash
  rows.push(["Mixedcase.example", "", "", ...metrics(4)]); // row 6: mixed case
  rows.push(["ww.lampshop.example", "typo", "", ...metrics(5)]); // row 7: typo -> suggestion lampshop.example
  rows.push(["the-edit.lampshop.example", "editorial", "", ...metrics(6)]); // row 8: subdomain of the corrected typo
  rows.push(["not a domain", "", "", ...metrics(7)]); // row 9: invalid
  rows.push(["http://intranet.local/x"]); // row 10: local host -> skipped
  rows.push(["https://www.ideas.example/blog/post-1?utm=x", "page", "", ...metrics(8)]); // row 11: page URL (only listing)
  rows.push(["wwww.typo2.example"]); // row 12: typo (4 w)
  for (let i = 0; i < 44; i++) rows.push([`shop${i + 1}.example`, "", "", ...metrics(10 + i)]); // rows 13..56
  return rows;
}

afterEach(() => setCompetitorDataFetch(null));

// ------------------------------------------------------------------ cap 60 everywhere
describe("[A39] competitor cap = 60, shared by worker and web", () => {
  it("one constant: shared, worker schema, web validation", () => {
    expect(SHARED_MAX).toBe(60);
    expect(WORKER_MAX).toBe(60);
    expect(WEB_MAX).toBe(60);
    expect(LIMITS.domains).toBe(5);
    const comp = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `C${i}`, domains: [`c${i}.example`], aliases: [] }));
    const base = { name: "P", siteUrl: "https://www.residence.example", siteType: "ecommerce" as const, brandName: "Residence", brandAliases: [] };
    expect(projectInputSchema.safeParse({ ...base, competitors: comp(60) }).success).toBe(true);
    expect(projectInputSchema.safeParse({ ...base, competitors: comp(61) }).success).toBe(false);
    const web = (n: number) =>
      validateProjectInput({ ...base, competitors: comp(n), productDescription: "", audience: "", locale: "en-US", language: "en", voice: "" }).errors.competitors;
    expect(web(60)).toBeUndefined();
    expect(web(61)).toBe("Up to 60 competitors.");
  });
});

// ------------------------------------------------------------------ cleaning rules
describe("[A39] competitor domain cleaning (shared rules)", () => {
  it("URL -> hostname, www. stripped, lowercase, page URLs noted, typos suggested, invalid hosts skipped with a reason", () => {
    expect(cleanCompetitorDomain("example.com")).toEqual({ ok: true, domain: "example.com", fromPage: false, typoOf: null });
    expect(cleanCompetitorDomain(" www.Example.COM ")).toMatchObject({ ok: true, domain: "example.com", fromPage: false });
    expect(cleanCompetitorDomain("https://www.example.com")).toMatchObject({ ok: true, domain: "example.com", fromPage: false });
    expect(cleanCompetitorDomain("https://www.example.com/n/ideas-inspiration/living-room")).toMatchObject({ ok: true, domain: "example.com", fromPage: true });
    expect(cleanCompetitorDomain("example.org/")).toMatchObject({ ok: true, domain: "example.org", fromPage: false });
    expect(cleanCompetitorDomain("example.net/?q=1")).toMatchObject({ ok: true, domain: "example.net", fromPage: true });
    expect(cleanCompetitorDomain("Mixedcase.example")).toMatchObject({ ok: true, domain: "mixedcase.example" });
    expect(cleanCompetitorDomain("ww.example.com")).toMatchObject({ ok: true, domain: "ww.example.com", typoOf: "example.com" });
    expect(cleanCompetitorDomain("wwww.example.com")).toMatchObject({ ok: true, domain: "wwww.example.com", typoOf: "example.com" });
    expect(wwwTypoSuggestion("www2.example.com")).toBeNull();
    expect(wwwTypoSuggestion("ww.com")).toBeNull(); // the rest is not a public domain
    expect(cleanCompetitorDomain("the-edit.example.com")).toMatchObject({ ok: true, domain: "the-edit.example.com", typoOf: null });
    expect(cleanCompetitorDomain("not a domain")).toEqual({ ok: false, reason: "not a domain name" });
    expect(cleanCompetitorDomain("localhost")).toMatchObject({ ok: false });
    expect(cleanCompetitorDomain("192.168.0.1")).toMatchObject({ ok: false });
    expect(cleanCompetitorDomain("printer.local")).toMatchObject({ ok: false });
    expect(cleanCompetitorDomain("ftp://example.com")).toMatchObject({ ok: false, reason: "not a web address (only http/https)" });
    expect(cleanCompetitorDomain("example.com:8080")).toMatchObject({ ok: false, reason: "contains a port" });
    expect(cleanCompetitorDomain("")).toMatchObject({ ok: false });
    expect(parentDomainIn("the-edit.example.com", ["example.com", "other.example"])).toBe("example.com");
    expect(parentDomainIn("a.b.example.com", ["example.com", "b.example.com"])).toBe("b.example.com");
    expect(parentDomainIn("example.com", ["example.com"])).toBeNull();
    expect(parentDomainIn("notexample.com", ["example.com"])).toBeNull();
    // Manual form and server use the same rules; a typo is never corrected silently.
    expect(webNormalizeDomain("https://www.Example.com/path")).toBe("example.com");
    expect(workerNormalizeDomain("https://www.Example.com/path")).toBe("example.com");
    expect(workerNormalizeDomain("ww.example.com")).toBe("ww.example.com");
    expect(domainError("ww.example.com")).toMatch(/looks like a typo\. Did you mean example\.com\?/);
    expect(domainError("example.com")).toBeNull();
  });

  it("import preview: each row's outcome (added / merged / skipped with reason / typo suggestion), dedupe after cleaning, own domain", async () => {
    const s = await setup();
    const dry = await call(s.env, s.u, "POST", `/projects/${s.pid}/import/dry-run`, body(messyRows()));
    expect(dry.status).toBe(200);
    const plan = dry.json!.data as ImportPlan;
    const byRow = (row: number) => plan.items.filter((i) => i.row === row);
    expect(byRow(2)[0]).toMatchObject({ action: "skip", reason: "your own domain" });
    expect(byRow(3)[0]).toMatchObject({ key: "bigbox.example", action: "add" });
    expect(byRow(4)[0]).toMatchObject({ key: "bigbox.example", action: "skip", reason: "duplicate of row 3 (bigbox.example) after cleaning" });
    expect(byRow(5)[0]).toMatchObject({ key: "lights.example", action: "add", reason: null });
    expect(byRow(6)[0]).toMatchObject({ key: "mixedcase.example", action: "add" });
    expect(byRow(7)[0]).toMatchObject({ key: "ww.lampshop.example", action: "skip" });
    expect(byRow(7)[0]!.reason).toMatch(/possible typo: did you mean lampshop\.example\?/);
    // Without the accepted fix there is no lampshop.example: the subdomain is its own competitor.
    expect(byRow(8)[0]).toMatchObject({ key: "the-edit.lampshop.example", action: "add", reason: null });
    expect(byRow(9)[0]).toMatchObject({ action: "skip", reason: "not a domain name" });
    expect(byRow(10)[0]!.action).toBe("skip");
    expect(byRow(10)[0]!.reason).toMatch(/not a public domain name/);
    expect(byRow(11)[0]).toMatchObject({ key: "ideas.example", action: "add", reason: "from a page URL (path dropped)" });
    expect(byRow(12)[0]!.reason).toMatch(/did you mean typo2\.example/);
    expect(plan.domainFixes).toEqual([
      { key: "ww.lampshop.example", from: "ww.lampshop.example", to: "lampshop.example", row: 7, accepted: false },
      { key: "wwww.typo2.example", from: "wwww.typo2.example", to: "typo2.example", row: 12, accepted: false },
    ]);
    // bigbox, lights, mixedcase, the-edit, ideas + 44 shops = 49 new; 6 skipped (own, duplicate, 2 typos, 2 invalid).
    expect(plan.counts).toMatchObject({ add: 49, skip: 6, not_added: 0 });
    expect(plan.summary.join(" | ")).toMatch(/2 possible typos \(www\. mistyped\)/);

    // The owner accepts the lampshop fix: it is imported as lampshop.example and the-edit is grouped under it.
    const acc = await call(s.env, s.u, "POST", `/projects/${s.pid}/import/dry-run`, body(messyRows(), { acceptDomainFixes: ["ww.lampshop.example"] }));
    const p2 = acc.json!.data as ImportPlan;
    expect(p2.items.find((i) => i.row === 7)).toMatchObject({ key: "lampshop.example", action: "add", reason: "typo fixed: ww.lampshop.example → lampshop.example (accepted by you)" });
    expect(p2.items.find((i) => i.row === 8)).toMatchObject({ key: "the-edit.lampshop.example", action: "add", reason: 'merged into "lampshop.example" as an extra domain (subdomain of lampshop.example)' });
    expect(p2.domainFixes!.find((f) => f.key === "ww.lampshop.example")!.accepted).toBe(true);
    const commit = await call(s.env, s.u, "POST", `/projects/${s.pid}/import/commit`, body(messyRows(), { acceptDomainFixes: ["ww.lampshop.example"] }));
    expect(commit.status).toBe(201);
    const project = (await call(s.env, s.u, "GET", `/projects/${s.pid}`)).json!.data as Project;
    expect(project.competitors).toHaveLength(49); // 50 domains, the subdomain grouped under lampshop.example
    expect(project.competitors.find((c) => c.name === "lampshop.example")!.domains).toEqual(["lampshop.example", "the-edit.lampshop.example"]);
    expect(project.competitors.flatMap((c) => c.domains)).not.toContain("residence.example");
    expect(commit.json!.data.changes).toContain("+ the-edit.lampshop.example (into lampshop.example)");
    // Re-import is idempotent; nothing is removed by a manual import.
    const again = await call(s.env, s.u, "POST", `/projects/${s.pid}/import/commit`, body(messyRows(), { acceptDomainFixes: ["ww.lampshop.example"] }));
    expect(again.json!.data.import, JSON.stringify(again.json!.data.plan.items.filter((i: Json) => i.action !== "unchanged" && i.action !== "skip"))).toBeNull();
  });

  it("room math at 60: existing competitors count, the rest are 'not added (limit)' with sheet metrics kept", async () => {
    const existing = Array.from({ length: 55 }, (_, i) => ({ name: `Old ${i}`, domains: [`old${i}.example`], aliases: [] }));
    const s = await setup({}, { competitors_json: JSON.stringify(existing) });
    const rows = [COMPETITORS_HEADERS, ...Array.from({ length: 8 }, (_, i) => [`new${i}.example`, "", "", "50"]), ["old3.example"], ["sub.old4.example"]];
    const r = await call(s.env, s.u, "POST", `/projects/${s.pid}/import/commit`, body(rows));
    const plan = r.json!.data.plan as ImportPlan;
    // 5 slots: new0..new4 added; new5..new7 not added; old3 already tracked; sub.old4 grouped under "Old 4" (no slot used).
    expect(plan.counts).toMatchObject({ add: 6, not_added: 3, unchanged: 1 });
    expect(plan.items.find((i) => i.key === "sub.old4.example")!.reason).toBe('merged into "Old 4" as an extra domain (subdomain of old4.example)');
    const project = (await call(s.env, s.u, "GET", `/projects/${s.pid}`)).json!.data as Project;
    expect(project.competitors).toHaveLength(60);
    const rec = await s.db.all<{ record_key: string; status: string }>("SELECT record_key, status FROM import_records WHERE project_id = ? AND status = 'not_tracked_limit' ORDER BY record_key", s.pid);
    expect(rec.map((x) => x.record_key)).toEqual(["new5.example", "new6.example", "new7.example"]);
  });
});

// ------------------------------------------------------------------ DataForSEO
describe("[A39] DataForSEO auto-fetch for many new competitors", () => {
  const OP = { DATAFORSEO_LOGIN: "op@example.com", DATAFORSEO_PASSWORD: "op-password" };
  const failing = () => {
    const urls: string[] = [];
    setCompetitorDataFetch((async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response("{}", { status: 500 });
    }) as typeof fetch);
    return urls;
  };
  const shopRows = (n: number) => [COMPETITORS_HEADERS, ...Array.from({ length: n }, (_, i) => [`shop${i + 1}.example`])];

  it("estimate text uses the published-price constants", () => {
    expect(maxRefreshCostUsd()).toBe(0.0624);
    expect(estimateCompetitorFetch(52).text).toBe("52 new competitor domains → up to 52 × $0.0624 DataForSEO (≈$3.24), fetched at most 10 per day (about 6 days)");
    expect(estimateCompetitorFetch(5).text).toBe("5 new competitor domains → up to 5 × $0.0624 DataForSEO (≈$0.31), fetched at most 10 per day");
    expect(estimateCompetitorFetch(1)).toMatchObject({ newDomains: 1, maxUsd: 0.0624, perDay: 10, days: 1 });
  });

  it("52 new domains: preview shows the estimate, option defaults off (> 10); ticked -> at most 10 per UTC day, the rest deferred (not dropped) in sheet order", async () => {
    const s = await setup(OP);
    failing();
    const dry = await call(s.env, s.u, "POST", `/projects/${s.pid}/import/dry-run`, body(shopRows(52)));
    const plan = dry.json!.data as ImportPlan;
    expect(plan.competitorFetch).toMatchObject({ newDomains: 52, defaultOn: false, selected: null, willFetch: false, state: "ready", perDay: 10, days: 6 });
    expect(plan.summary).toContain("DataForSEO: 52 new competitor domains → up to 52 × $0.0624 DataForSEO (≈$3.24), fetched at most 10 per day (about 6 days).");
    expect(plan.summary.join(" ")).toMatch(/Not fetched \(option off\): no DataForSEO cost/);

    const commit = await call(s.env, s.u, "POST", `/projects/${s.pid}/import/commit`, body(shopRows(52), { fetchCompetitorData: true }));
    expect(commit.status).toBe(201);
    expect((commit.json!.data.plan as ImportPlan).competitorFetch!.willFetch).toBe(true);
    const fetchRows = () => s.db.all<{ domain: string; created_at: string }>("SELECT domain, created_at FROM competitor_fetches WHERE project_id = ? ORDER BY created_at, domain", s.pid);
    const backlog = () => s.db.all<{ domain: string; position: number }>("SELECT domain, position FROM competitor_fetch_backlog WHERE project_id = ? ORDER BY position", s.pid);
    expect(await fetchRows()).toHaveLength(FETCHES_PER_PROJECT_PER_DAY);
    expect((await fetchRows()).map((f) => f.domain).sort()).toEqual(Array.from({ length: 10 }, (_, i) => `shop${i + 1}.example`).sort());
    const waiting = await backlog();
    expect(waiting).toHaveLength(42);
    expect(waiting[0]!.domain).toBe("shop11.example"); // sheet order kept
    expect(waiting.at(-1)!.domain).toBe("shop52.example");

    // The panel says so.
    const panel = (await call(s.env, s.u, "GET", `/projects/${s.pid}/competitors/dataforseo`)).json!.data as CompetitorDataPanel;
    expect(panel.caps.waitingDomains).toBe(42);
    expect(panel.domains.find((d) => d.domain === "shop11.example")!.waiting).toBe(true);
    expect(panel.domains).toHaveLength(52);

    // Same day: the cron cannot promote anything (cap used).
    const today = new Date();
    expect((await processQueuedCompetitorFetches(s.env, today)).promoted).toBe(0);
    // Following days: at most 10 new refreshes per UTC day until the backlog is empty; nothing is dropped.
    const perDay: number[] = [];
    for (let d = 1; d <= 6; d++) {
      const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + d, 1, 0, 0));
      let promoted = 0;
      for (let tick = 0; tick < 4; tick++) promoted += (await processQueuedCompetitorFetches(s.env, new Date(day.getTime() + tick * 15 * 60_000))).promoted;
      perDay.push(promoted);
      const dayKey = day.toISOString().slice(0, 10);
      expect((await fetchRows()).filter((f) => f.created_at.startsWith(dayKey)).length).toBeLessThanOrEqual(FETCHES_PER_PROJECT_PER_DAY);
    }
    expect(perDay).toEqual([10, 10, 10, 10, 2, 0]);
    expect(await backlog()).toHaveLength(0);
    expect(new Set((await fetchRows()).map((f) => f.domain)).size).toBe(52);
  });

  it("option off -> no fetch and no backlog; default on for <= 10 new domains", async () => {
    const s = await setup(OP);
    failing();
    const off = await call(s.env, s.u, "POST", `/projects/${s.pid}/import/commit`, body(shopRows(3), { fetchCompetitorData: false }));
    expect((off.json!.data.plan as ImportPlan).competitorFetch).toMatchObject({ newDomains: 3, defaultOn: true, selected: false, willFetch: false });
    expect(await s.db.all("SELECT id FROM competitor_fetches WHERE project_id = ?", s.pid)).toHaveLength(0);
    expect(await s.db.all("SELECT id FROM competitor_fetch_backlog WHERE project_id = ?", s.pid)).toHaveLength(0);

    const s2 = await setup(OP);
    failing();
    const on = await call(s2.env, s2.u, "POST", `/projects/${s2.pid}/import/commit`, body(shopRows(4)));
    expect((on.json!.data.plan as ImportPlan).competitorFetch).toMatchObject({ newDomains: 4, defaultOn: true, selected: null, willFetch: true });
    expect(await s2.db.all("SELECT id FROM competitor_fetches WHERE project_id = ?", s2.pid)).toHaveLength(4);
  });

  it("missing credentials: setup_required in the preview, nothing queued or deferred even when ticked", async () => {
    const s = await setup();
    const urls = failing();
    const r = await call(s.env, s.u, "POST", `/projects/${s.pid}/import/commit`, body(shopRows(12), { fetchCompetitorData: true }));
    expect((r.json!.data.plan as ImportPlan).competitorFetch).toMatchObject({ state: "setup_required", willFetch: false });
    expect(await s.db.all("SELECT id FROM competitor_fetches WHERE project_id = ?", s.pid)).toHaveLength(0);
    expect(await s.db.all("SELECT id FROM competitor_fetch_backlog WHERE project_id = ?", s.pid)).toHaveLength(0);
    expect(urls).toHaveLength(0);
  });

  it("manual saves with many new domains defer too; the backlog drops untracked domains and clears when auto-fetch is turned off", async () => {
    const s = await setup(OP);
    failing();
    const before = await s.db.first<ProjectRow>("SELECT * FROM projects WHERE id = ?", s.pid);
    const comps = Array.from({ length: 14 }, (_, i) => ({ name: `M${i}`, domains: [`m${i}.example`], aliases: [] }));
    await s.db.run("UPDATE projects SET competitors_json = ? WHERE id = ?", JSON.stringify(comps), s.pid);
    const p = (await s.db.first<ProjectRow>("SELECT * FROM projects WHERE id = ?", s.pid))!;
    const r = await onCompetitorsChanged(s.env, s.db, p, JSON.parse(before!.competitors_json), s.u.userId, new Date());
    expect(r.queued).toHaveLength(10);
    expect(r.deferred).toEqual(["m10.example", "m11.example", "m12.example", "m13.example"]);
    // m10 removed from the project before its day comes: dropped from the backlog, never fetched.
    await s.db.run("UPDATE projects SET competitors_json = ? WHERE id = ?", JSON.stringify(comps.filter((c) => c.name !== "M10")), s.pid);
    const tomorrow = new Date(Date.now() + 86_400_000);
    expect((await processQueuedCompetitorFetches(s.env, tomorrow)).promoted).toBe(3);
    expect(await s.db.all("SELECT id FROM competitor_fetches WHERE project_id = ? AND domain = 'm10.example'", s.pid)).toHaveLength(0);
    // Auto-fetch off clears what is waiting.
    await s.db.run("INSERT INTO competitor_fetch_backlog (id, workspace_id, project_id, domain, position, created_at) VALUES ('cfbk_x', ?, ?, 'm1.example', 99, ?)", s.u.workspaceId, s.pid, new Date().toISOString());
    await s.db.run(
      "INSERT INTO competitor_data_settings (project_id, workspace_id, auto_fetch, updated_at) VALUES (?, ?, 0, ?)",
      s.pid,
      s.u.workspaceId,
      new Date().toISOString(),
    );
    await processQueuedCompetitorFetches(s.env, new Date(Date.now() + 2 * 86_400_000));
    expect(await s.db.all("SELECT id FROM competitor_fetch_backlog WHERE project_id = ?", s.pid)).toHaveLength(0);
  });

  it("60 competitors x 5 domains: panel reads every domain (chunked under D1 limits), prune keeps all current domains", async () => {
    const s = await setup(OP);
    failing();
    const comps = Array.from({ length: 60 }, (_, i) => ({ name: `C${i}`, domains: Array.from({ length: 5 }, (_, j) => `c${i}-${j}.example`), aliases: [] }));
    await s.db.run("UPDATE projects SET competitors_json = ? WHERE id = ?", JSON.stringify(comps), s.pid);
    const at = new Date().toISOString();
    const seedSnap = async (domain: string) => {
      const fid = newId("cfetch");
      await s.db.insert("competitor_fetches", { id: fid, workspace_id: s.u.workspaceId, project_id: s.pid, domain, trigger: "manual", status: "completed", created_at: at, finished_at: at, location_code: 2840, language_code: "en", cost_usd: 0.05 });
      await s.db.insert("competitor_snapshots", { id: newId("csnap"), workspace_id: s.u.workspaceId, project_id: s.pid, fetch_id: fid, domain, endpoint: "ranked_keywords", location_code: 2840, language_code: "en", status: "ok", cost_usd: 0.02, item_count: 0, data_json: "{}", fetched_at: at });
    };
    await seedSnap("c59-4.example"); // domain #300
    await seedSnap("gone.example"); // no longer a competitor
    const panel = (await call(s.env, s.u, "GET", `/projects/${s.pid}/competitors/dataforseo`)).json!.data as CompetitorDataPanel;
    expect(panel.domains).toHaveLength(300);
    expect(panel.domains.find((d) => d.domain === "c59-4.example")!.snapshot).not.toBeNull();
    const p = (await s.db.first<ProjectRow>("SELECT * FROM projects WHERE id = ?", s.pid))!;
    await prune(s.db, p, "c0-0.example", competitorDomains(comps).map((d) => d.domain));
    const left = await s.db.all<{ domain: string }>("SELECT DISTINCT domain FROM competitor_snapshots WHERE project_id = ?", s.pid);
    expect(left.map((l) => l.domain)).toEqual(["c59-4.example"]);
  });
});

// ------------------------------------------------------------------ GEO: Jev does not scale with the competitor count
describe("[A39] GEO detection with 60 tracked competitors", () => {
  const competitors = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `Rival ${i + 1}`, domains: [`rival${i + 1}.example`], aliases: [`Rival${i + 1} Lighting`] }));
  const answer = {
    prompt: "What are the best brass wall sconces for a hallway?",
    grounded: true,
    answer: "For hallways, Rival 7 is a solid choice for brass sconces. Rival 42 also stands out for aged brass finishes. Residence Example offers solid brass options too.",
    citations: [
      { url: "https://rival42.example/sconces", title: "Rival 42 sconces", position: 1 },
      { url: "https://reviews.example/best-sconces", title: "Best sconces", position: 2 },
    ],
  };

  async function run(n: number) {
    const env = createTestEnv();
    const u = await seedUser(env);
    const pid = await seedProject(env, u.workspaceId, { competitors_json: JSON.stringify(competitors(n)) });
    const project = { id: pid, workspaceId: u.workspaceId };
    const id = await seedObservation(env, project, answer);
    const decisions = fakeDecisions((key) => (key === "injection_risk" ? noul(0.02) : key.startsWith("sent_") ? choice("positive") : key.startsWith("rec_") ? choice("recommended") : key.startsWith("src_") ? choice("listicle_roundup") : undefined));
    const ctx = makeTestContext(env, project, { decisions });
    const summary = await analyzeObservation(ctx, id);
    const rows = await new Db(env.DB).all<{ brand_key: string; mentioned: number; cited: number }>("SELECT brand_key, mentioned, cited FROM geo_brand_observations WHERE observation_id = ?", id);
    return { decisions, summary, rows };
  }

  it("2 Jev calls whatever the competitor count; questions and state only about self + the 2 brands found", async () => {
    const big = await run(60);
    const small = await run(45); // Rival 7 and Rival 42 are both tracked here too
    expect(big.decisions.requests).toHaveLength(2);
    expect(small.decisions.requests).toHaveLength(2);
    const qs = (r: typeof big) => r.decisions.requests.map((q) => Object.keys(q.questions).sort());
    expect(qs(big)).toEqual(qs(small));
    const state = big.decisions.requests[0]!.state as { brands: Record<string, { name: string }>; tracked_domains: string[]; brands_note?: string };
    expect(Object.values(state.brands).map((b) => b.name).sort()).toEqual(["Residence Example", "Rival 42", "Rival 7"]);
    expect(Object.keys(state.brands).length).toBeLessThanOrEqual(MAX_JEV_STATE_BRANDS);
    expect(state.tracked_domains).toContain("rival42.example");
    expect(state.tracked_domains).not.toContain("rival13.example");
    expect(state.brands_note).toBe("58 other tracked brand(s) were not found in this answer and are omitted.");
    expect(JSON.stringify(big.decisions.requests[0]!.state).length).toBeLessThan(JSON.stringify(small.decisions.requests[0]!.state).length + 200);
    // Deterministic matching still covers every brand: 61 rows, exactly 2 competitors mentioned.
    expect(big.rows).toHaveLength(61);
    expect(big.rows.filter((r) => r.brand_key !== "self" && r.mentioned === 1).map((r) => r.brand_key).sort()).toEqual(["Rival 42", "Rival 7"]);
    expect(big.rows.find((r) => r.brand_key === "Rival 42")!.cited).toBe(1);
  });

  it("brand-blind checks, SEO brand terms and proposal text stay bounded with 60 competitors", () => {
    const comps = competitors(60);
    const p = { brand_name: "Residence Example", brand_aliases_json: "[]", competitors_json: JSON.stringify(comps), site_url: "https://shop.example.com", verified_host: null, gsc_property: null };
    expect(brandBlindViolations("is rival 59 better than the others?", p).map((v) => v.brandKey)).toEqual(["Rival 59"]);
    const terms = brandTermsFrom({ brandName: "Residence Example", brandAliases: [], competitors: comps });
    expect(terms.competitors).toHaveLength(120);
    const cls = createBrandClassifier(terms);
    expect(cls.classify("rival 37 brass sconce")).toMatchObject({ kind: "competitor_brand", competitorTerm: "rival 37" });
    // Same result as a linear scan: the first matching term in configured order ("rival 37" joined = "rival37").
    expect(cls.classify("rival37 lighting sconce")).toMatchObject({ kind: "competitor_brand", competitorTerm: "rival 37" });
    expect(cls.classify("the rival12 lighting store")).toMatchObject({ kind: "competitor_brand", competitorTerm: "rival 12" });
    expect(cls.classify("brass sconce")).toMatchObject({ kind: "non_brand" });
    const st = competitorTermsForState(terms, ["rival 51 sconces"]);
    expect(st.terms).toHaveLength(20);
    expect(st.terms[0]).toBe("rival 51");
    expect(st.note).toBe("100 of 120 competitor terms omitted (terms found in the query listed first).");
    const counts = new Map(Array.from({ length: 9 }, (_, i) => [`Rival ${i + 1}`, 9 - i] as const));
    const named = namedCompetitors(counts);
    expect(named).toEqual(["Rival 1", "Rival 2", "Rival 3", "Rival 4", "Rival 5"]);
    expect(competitorList(named, counts.size)).toBe("Rival 1, Rival 2, Rival 3, Rival 4, Rival 5 and 4 other tracked competitors");
  });
});

// ------------------------------------------------------------------ bounded reads: 60 competitors x many observations
describe("[A39] bounded reads with 60 competitors x many observations", () => {
  it("results, board and checklists read only informative brand rows (self, mentioned, cited)", async () => {
    const env = createTestEnv();
    const u = await seedUser(env);
    const comps = Array.from({ length: 60 }, (_, i) => ({ name: `Rival ${i + 1}`, domains: [`rival${i + 1}.example`], aliases: [] }));
    const pid = await seedProject(env, u.workspaceId, { competitors_json: JSON.stringify(comps) });
    const db = new Db(env.DB);
    const OBS = 300;
    const stmts: Array<[string, ...unknown[]]> = [];
    const t0 = Date.parse("2026-10-01T00:00:00Z");
    for (let i = 0; i < OBS; i++) {
      const oid = `gobs_${i}`;
      stmts.push([
        `INSERT INTO geo_observations (id, workspace_id, project_id, prompt_text, prompt_type, cohort_key, provider, model, grounding_mode, measurement_type, status, grounded, raw_answer, usage_json, cost_usd, cost_is_estimate, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        oid, u.workspaceId, pid, `prompt ${i % 25}`, "discovery", "cohort-gemini-1", "gemini", "gemini-test", "google_search", "api", "ok", 1, "answer", "{}", 0.001, 1, new Date(t0 + i * 60_000).toISOString(),
      ]);
      for (let k = 0; k <= 60; k++) {
        const self = k === 0;
        const mentioned = self ? i % 2 : k === (i % 60) + 1 ? 1 : 0;
        stmts.push([
          `INSERT INTO geo_brand_observations (id, workspace_id, project_id, observation_id, brand_key, is_self, mentioned, cited, recommendation_status, list_rank, sentiment, spans_json, method)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          `gbo_${i}_${k}`, u.workspaceId, pid, oid, self ? "self" : `Rival ${k}`, self ? 1 : 0, mentioned, 0, mentioned ? "recommended" : "not_mentioned", null, mentioned ? "unknown" : "not_applicable", "[]", "deterministic",
        ]);
      }
    }
    for (let i = 0; i < stmts.length; i += 500) await db.batch(stmts.slice(i, i + 500));
    expect((await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM geo_brand_observations WHERE project_id = ?", pid))!.n).toBe(OBS * 61);

    // Count the rows each geo_brand_observations read returns.
    const reads: number[] = [];
    const orig = Db.prototype.all;
    Db.prototype.all = async function (this: Db, sql: string, ...params: unknown[]) {
      const rows = await orig.call(this, sql, ...params);
      if (/FROM geo_brand_observations/.test(sql) && !/COUNT\(|MAX\(/.test(sql)) reads.push((rows as unknown[]).length);
      return rows;
    } as typeof Db.prototype.all;
    try {
      const results = await call(env, u, "GET", `/projects/${pid}/geo/results`);
      expect(results.status).toBe(200);
      const sov = results.json!.data.shareOfVoice as Array<{ brandKey: string }>;
      expect(sov).toHaveLength(61);
      expect((await call(env, u, "GET", `/projects/${pid}/geo/board`)).status).toBe(200);
      expect((await call(env, u, "GET", `/projects/${pid}/checklists/geo`)).status).toBe(200);
      expect((await call(env, u, "GET", `/projects/${pid}/live/insights?kind=brands`)).status).toBe(200);
    } finally {
      Db.prototype.all = orig;
    }
    expect(reads.length).toBeGreaterThan(0);
    // Self row + one mentioned competitor per answer = 2 rows per answer, never 61.
    for (const n of reads) expect(n).toBeLessThanOrEqual(OBS * 2);
  });
});
