/** [A25] Sitemap health rules: each rule fires / stays quiet, exact fix text, lastmod parsing, crawl wiring. */
import { describe, expect, it } from "vitest";
// Import the app module first (route modules reference AppEnv from app.ts).
import "@worker/app";
import { Db } from "@worker/lib/db";
import { parseRobotsJson } from "@worker/checklists/data";
import { runCrawl } from "@worker/seo/crawl/run";
import { collectSitemapUrls, parseSitemap, parseSitemapWithLastmod } from "@worker/seo/crawl/sitemap";
import { getRule, RULES, RULESET_VERSION, runRules, type RuleInput, type RuleSnapshot } from "@worker/seo/rules/registry";
import { lastmodProblem, parseLastmod, SITEMAP_HEALTH_RULES } from "@worker/seo/rules/sitemap-health";
import { parseRobots } from "@worker/seo/crawl/robots";
import { createTestEnv } from "./helpers/env";
import { seedProject, seedUser } from "./helpers/fixtures";
import { makeTestContext, unlimitedBudget } from "./helpers/context";
import { fakeSite, html, redirect } from "./fixtures/crawl/fake-site";

const H = "shop.example.com";
const U = (p: string) => `https://${H}${p}`;
const NOW = new Date("2026-09-30T12:00:00Z");

function snap(path: string, over: Partial<RuleSnapshot> = {}): RuleSnapshot {
  const url = path.startsWith("http") ? path : U(path);
  return {
    url,
    finalUrl: url,
    statusCode: 200,
    pageType: "other",
    skippedReason: null,
    title: `Title ${path}`,
    metaDescription: `Description ${path}`,
    h1s: [`H ${path}`],
    headings: [{ level: 1, text: `H ${path}` }],
    canonical: url,
    robotsMeta: null,
    jsonLdTypes: [],
    jsonLdIssues: [],
    internalLinks: [],
    wordCount: 400,
    firstParagraph: "An introductory paragraph with more than ten words describing this page clearly.",
    contentHash: `h-${path}`,
    textHash: `t-${path}`,
    ...over,
  };
}

const input = (snapshots: RuleSnapshot[], over: Partial<RuleInput> = {}): RuleInput => ({
  siteType: "publisher",
  verifiedHost: H,
  snapshots,
  sitemapUrls: [],
  robots: { status: "ok", httpStatus: 200, parsed: parseRobots(""), note: "" },
  aiCrawlerAccess: null,
  now: NOW,
  ...over,
});
const fired = (inp: RuleInput, id: string) => runRules(inp).filter((f) => f.ruleId === id);

describe("sitemap health rules are registered facts with emitters", () => {
  it("six stable ids in the registry; ruleset version bumped", () => {
    const ids = SITEMAP_HEALTH_RULES.map((r) => r.id);
    expect(ids).toEqual(["SEO-SITEMAP-URL-ERROR", "SEO-SITEMAP-URL-REDIRECT", "SEO-SITEMAP-URL-NOINDEX", "SEO-SITEMAP-URL-NONCANONICAL", "SEO-SITEMAP-LASTMOD-INVALID", "SEO-SITEMAP-OFFHOST"]);
    for (const id of ids) {
      expect(getRule(id)).toBeDefined();
      expect(getRule(id)).toMatchObject({ class: "fact", area: "indexing", templateable: false, appliesTo: "all" });
    }
    expect(RULES.filter((r) => r.id.startsWith("SEO-SITEMAP-"))).toHaveLength(6);
    expect(RULESET_VERSION).toBe("2026-09-30.3");
  });

  it("no sitemap data: nothing fires", () => {
    const f = runRules(input([snap("/"), snap("/gone", { statusCode: 404 })], { now: undefined }));
    expect(f.filter((x) => x.ruleId.startsWith("SEO-SITEMAP-"))).toEqual([]);
  });
});

describe("SEO-SITEMAP-URL-ERROR", () => {
  it("fires for crawled sitemap URLs with 4xx/5xx, with the exact fix", () => {
    const f = fired(input([snap("/gone", { statusCode: 404 }), snap("/err", { statusCode: 503 }), snap("/ok")], { sitemapUrls: [U("/gone"), U("/err"), U("/ok"), U("/not-crawled")] }), "SEO-SITEMAP-URL-ERROR");
    expect(f.map((x) => [x.url, x.detail, x.evidence.fix, x.severity])).toEqual([
      [U("/gone"), "Listed in the sitemap but returned HTTP 404. Fix: Remove this URL from the sitemap or fix the 404.", "Remove this URL from the sitemap or fix the 404.", "moderate"],
      [
        U("/err"),
        "Listed in the sitemap but returned HTTP 503. Fix: Remove this URL from the sitemap or fix the 503 (recheck first: a single 5xx can be transient).",
        "Remove this URL from the sitemap or fix the 503 (recheck first: a single 5xx can be transient).",
        "moderate",
      ],
    ]);
  });

  it("does not judge uncrawled or unfetched (timeout) sitemap URLs", () => {
    expect(fired(input([snap("/t", { statusCode: null, skippedReason: "timeout" })], { sitemapUrls: [U("/t"), U("/never")] }), "SEO-SITEMAP-URL-ERROR")).toEqual([]);
  });
});

describe("SEO-SITEMAP-URL-REDIRECT", () => {
  it("fires with 'replace with the final URL'; a redirect to an error says remove", () => {
    const f = fired(
      input([snap("/old", { statusCode: 301, finalUrl: U("/new") }), snap("/new"), snap("/older", { statusCode: 302, finalUrl: U("/gone") }), snap("/gone", { statusCode: 404 })], {
        sitemapUrls: [U("/old"), U("/older"), U("/new")],
      }),
      "SEO-SITEMAP-URL-REDIRECT",
    );
    expect(f.map((x) => [x.url, x.evidence.fix])).toEqual([
      [U("/old"), `Replace this URL in the sitemap with its final URL ${U("/new")}.`],
      [U("/older"), `Remove this URL from the sitemap: it redirects to ${U("/gone")}, which returned 404.`],
    ]);
    expect(f[0]!.detail).toBe(`Listed in the sitemap but redirects (HTTP 301) to ${U("/new")}. Fix: Replace this URL in the sitemap with its final URL ${U("/new")}.`);
  });

  it("a trailing-slash redirect keeps its own 3xx record; an off-site redirect says remove", () => {
    const f = fired(
      input([snap("/a", { statusCode: 301, finalUrl: U("/a/") }), snap("/a/"), snap("/away", { statusCode: null, finalUrl: null, skippedReason: "redirect_offsite" })], { sitemapUrls: [U("/a"), U("/away")] }),
      "SEO-SITEMAP-URL-REDIRECT",
    );
    expect(f.map((x) => [x.url, x.evidence.fix])).toEqual([
      [U("/a"), `Replace this URL in the sitemap with its final URL ${U("/a/")}.`],
      [U("/away"), "Remove this URL from the sitemap: it redirects to another host."],
    ]);
  });
});

describe("SEO-SITEMAP-URL-NOINDEX", () => {
  it("fires for meta robots and X-Robots-Tag noindex on 2xx sitemap URLs only", () => {
    const f = fired(
      input([snap("/a", { robotsMeta: "noindex, follow" }), snap("/b", { robotsMeta: "x-robots-tag: noindex" }), snap("/c", { robotsMeta: "index, follow" }), snap("/d", { robotsMeta: "noindex" })], {
        sitemapUrls: [U("/a"), U("/b"), U("/c")],
      }),
      "SEO-SITEMAP-URL-NOINDEX",
    );
    expect(f.map((x) => x.url)).toEqual([U("/a"), U("/b")]);
    expect(f[0]!.evidence.fix).toBe("Remove this URL from the sitemap, or remove the noindex directive if the page should be indexed.");
  });
});

describe("SEO-SITEMAP-URL-NONCANONICAL", () => {
  it("fires when the canonical points elsewhere, with 'Replace with the canonical URL <x>'", () => {
    const f = fired(
      input([snap("/a?ref=nav", { canonical: U("/a") }), snap("/a"), snap("/b", { canonical: U("/b/") }), snap("/c", { canonical: "https://other.example/c" }), snap("/d", { canonical: null })], {
        sitemapUrls: [U("/a?ref=nav"), U("/a"), U("/b"), U("/c"), U("/d")],
      }),
      "SEO-SITEMAP-URL-NONCANONICAL",
    );
    expect(f.map((x) => [x.url, x.evidence.fix])).toEqual([
      [U("/a?ref=nav"), `Replace with the canonical URL ${U("/a")}`],
      [U("/c"), "Remove this URL from the sitemap: its canonical points to another host (https://other.example/c)."],
    ]);
  });
});

describe("SEO-SITEMAP-LASTMOD-INVALID", () => {
  it("parses W3C Datetime values and rejects others (including impossible dates)", () => {
    for (const v of ["2026", "2026-09", "2026-09-30", "2026-09-30T10:00Z", "2026-09-30T10:00:00+02:00", "2026-09-30T10:00:00.123Z", " 2026-09-30 "]) expect(parseLastmod(v), v).not.toBeNull();
    for (const v of ["", "30/09/2026", "2026-02-30", "2026-13-01", "2026-09-30 10:00:00", "2026-09-30T10:00:00", "yesterday", "Tue, 29 Sep 2026 10:00:00 GMT"]) expect(parseLastmod(v), v).toBeNull();
  });

  it("future means more than a day after the crawl; absent lastmod is fine; no clock = no future check", () => {
    expect(lastmodProblem("2026-10-01", NOW)).toBeNull();
    expect(lastmodProblem("2026-10-05", NOW)).toMatchObject({ kind: "future" });
    expect(lastmodProblem(null, NOW)).toBeNull();
    expect(lastmodProblem("2030-01-01", undefined)).toBeNull();
    expect(lastmodProblem("not a date", undefined)).toEqual({ kind: "invalid" });
  });

  it("fires per sitemap entry with the exact fix", () => {
    const f = fired(
      input([snap("/")], {
        sitemapUrls: [U("/"), U("/a"), U("/b"), U("/c")],
        sitemapEntries: [
          { url: U("/"), lastmod: "2026-09-01" },
          { url: U("/a"), lastmod: "30/09/2026" },
          { url: U("/b"), lastmod: "2027-01-01" },
          { url: U("/c"), lastmod: null },
        ],
      }),
      "SEO-SITEMAP-LASTMOD-INVALID",
    );
    expect(f.map((x) => [x.url, x.detail])).toEqual([
      [U("/a"), 'The sitemap <lastmod> "30/09/2026" is not a valid W3C Datetime. Fix: Set <lastmod> to the page\'s last significant change in W3C Datetime format (for example 2026-09-30), or remove it.'],
      [U("/b"), 'The sitemap <lastmod> "2027-01-01" is in the future. Fix: Set <lastmod> to the date of the page\'s last significant change, not a future date.'],
    ]);
    expect(f[0]!.pageType).toBeNull();
  });
});

describe("SEO-SITEMAP-OFFHOST", () => {
  it("fires for listed page URLs refused because of the host, not for SSRF refusals or sitemap files", () => {
    const f = fired(
      input([snap("/")], {
        sitemapRefused: [
          { url: "https://www.shop.example.com/x", reason: "Host is not the verified host.", kind: "page" },
          { url: "https://169.254.169.254/latest", reason: "Private, reserved, or metadata addresses are refused.", kind: "page" },
          { url: "https://cdn.example.net/sitemap.xml", reason: "Host is not the verified host.", kind: "sitemap" },
        ],
      }),
      "SEO-SITEMAP-OFFHOST",
    );
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ url: "https://www.shop.example.com/x", severity: "minor", pageType: null });
    expect(f[0]!.evidence.fix).toBe(`Remove this URL from the sitemap: it is outside the verified host ${H}. List it in a sitemap on its own host.`);
  });

  it("defense in depth: an off-host URL passed in sitemapUrls also fires", () => {
    expect(fired(input([snap("/")], { sitemapUrls: ["https://other.example/p", U("/")] }), "SEO-SITEMAP-OFFHOST").map((x) => x.url)).toEqual(["https://other.example/p"]);
  });
});

describe("sitemap parsing keeps <lastmod>", () => {
  it("reads lastmod before or after loc, empty and absent values; parseSitemap's shape is unchanged", () => {
    const xml = `<urlset><url><loc>https://a.example/1</loc><lastmod>2026-09-01</lastmod></url><url><lastmod> 2026-08-01T10:00:00Z </lastmod><loc>https://a.example/2</loc></url><url><loc>https://a.example/3</loc></url><url><loc>https://a.example/4</loc><lastmod></lastmod></url></urlset>`;
    const p = parseSitemapWithLastmod(xml);
    expect([...p.lastmod.entries()]).toEqual([
      ["https://a.example/1", "2026-09-01"],
      ["https://a.example/2", "2026-08-01T10:00:00Z"],
      ["https://a.example/3", null],
      ["https://a.example/4", ""],
    ]);
    expect(parseSitemap(xml)).toEqual({ kind: "urlset", locs: ["https://a.example/1", "https://a.example/2", "https://a.example/3", "https://a.example/4"], truncated: false });
    expect([...parseSitemapWithLastmod("https://a.example/1\n").lastmod.values()]).toEqual([null]);
  });

  it("collectSitemapUrls returns entries in URL order and labels refusals as page or sitemap", async () => {
    const site = fakeSite({
      [U("/sitemap.xml")]: {
        status: 200,
        contentType: "application/xml",
        body: `<urlset><url><loc>${U("/a")}</loc><lastmod>2026-09-01</lastmod></url><url><loc>https://other.example/b</loc></url><url><loc>${U("/c")}</loc></url></urlset>`,
      },
    });
    const r = await collectSitemapUrls(site.fetch, { verifiedHost: H, sitemapUrls: [U("/sitemap.xml"), "https://cdn.example.net/sitemap.xml"], userAgent: "x" });
    expect(r.entries).toEqual([
      { url: U("/a"), lastmod: "2026-09-01" },
      { url: U("/c"), lastmod: null },
    ]);
    expect(r.refused).toEqual([
      { url: "https://other.example/b", reason: "Host is not the verified host.", kind: "page" },
      { url: "https://cdn.example.net/sitemap.xml", reason: "Host is not the verified host.", kind: "sitemap" },
    ]);
  });
});

describe("crawl wiring: findings from a real crawl run, entries persisted in robots_json", () => {
  it("emits all six sitemap rules and keeps robots_json readable by the checklists", async () => {
    const env = createTestEnv({ APP_ORIGIN: "https://app.okara.example" });
    const { workspaceId } = await seedUser(env);
    const projectId = await seedProject(env, workspaceId, { site_type: "publisher" });
    const db = new Db(env.DB);
    const page = (title: string, extraHead = "", canonicalPath?: string) =>
      html(
        `<html><head><title>${title}</title><meta name="description" content="${title} page."><link rel="canonical" href="${U(canonicalPath ?? "/")}">${extraHead}</head><body><main><h1>${title}</h1><p>${"Solid brass hardware made by hand in our workshop. ".repeat(20)}</p></main></body></html>`,
      );
    const site = fakeSite({
      [U("/robots.txt")]: { status: 200, contentType: "text/plain", body: `User-agent: *\nAllow: /\n\nSitemap: ${U("/sitemap.xml")}\n` },
      [U("/sitemap.xml")]: {
        status: 200,
        contentType: "application/xml",
        body: `<urlset>
          <url><loc>${U("/")}</loc><lastmod>2026-09-01</lastmod></url>
          <url><loc>${U("/gone")}</loc></url>
          <url><loc>${U("/old")}</loc></url>
          <url><loc>${U("/hidden")}</loc></url>
          <url><loc>${U("/copy")}</loc><lastmod>2026-13-01</lastmod></url>
          <url><loc>${U("/tomorrow")}</loc><lastmod>2027-01-01</lastmod></url>
          <url><loc>https://blog.example.org/post</loc></url>
        </urlset>`,
      },
      [U("/")]: page("Home"),
      [U("/gone")]: { status: 404, contentType: "text/html", body: "<html><body>gone</body></html>" },
      [U("/old")]: redirect("/new"),
      [U("/new")]: page("New", "", "/new"),
      [U("/hidden")]: page("Hidden", '<meta name="robots" content="noindex">', "/hidden"),
      [U("/copy")]: page("Copy", "", "/new"),
      [U("/tomorrow")]: page("Tomorrow", "", "/tomorrow"),
    });
    const ctx = makeTestContext(env, { id: projectId, workspaceId }, { crawlFetch: site.fetch, budget: unlimitedBudget() });
    const summary = await runCrawl(ctx);
    expect(summary.status).toBe("completed");

    const findings = await db.all<{ rule_id: string; url: string | null; detail: string; evidence_json: string }>(
      "SELECT rule_id, url, detail, evidence_json FROM audit_findings WHERE crawl_run_id = ? AND workspace_id = ? AND rule_id LIKE 'SEO-SITEMAP-%' ORDER BY rule_id, url",
      summary.crawlRunId,
      workspaceId,
    );
    expect(findings.map((f) => [f.rule_id, f.url])).toEqual([
      ["SEO-SITEMAP-LASTMOD-INVALID", U("/copy")],
      ["SEO-SITEMAP-LASTMOD-INVALID", U("/tomorrow")],
      ["SEO-SITEMAP-OFFHOST", "https://blog.example.org/post"],
      ["SEO-SITEMAP-URL-ERROR", U("/gone")],
      ["SEO-SITEMAP-URL-NOINDEX", U("/hidden")],
      ["SEO-SITEMAP-URL-NONCANONICAL", U("/copy")],
      ["SEO-SITEMAP-URL-REDIRECT", U("/old")],
    ]);
    expect(JSON.parse(findings.find((f) => f.rule_id === "SEO-SITEMAP-URL-NONCANONICAL")!.evidence_json)).toMatchObject({ fix: `Replace with the canonical URL ${U("/new")}`, rulesetVersion: "2026-09-30.3" });

    const run = await db.first<{ robots_json: string }>("SELECT robots_json FROM crawl_runs WHERE id = ?", summary.crawlRunId);
    const robotsJson = JSON.parse(run!.robots_json);
    expect(robotsJson.sitemap.entries).toEqual([
      { url: U("/"), lastmod: "2026-09-01" },
      { url: U("/gone"), lastmod: null },
      { url: U("/old"), lastmod: null },
      { url: U("/hidden"), lastmod: null },
      { url: U("/copy"), lastmod: "2026-13-01" },
      { url: U("/tomorrow"), lastmod: "2027-01-01" },
    ]);
    expect(robotsJson.sitemap.refused).toEqual([{ url: "https://blog.example.org/post", reason: "Host is not the verified host.", kind: "page" }]);
    expect(robotsJson.sitemap.urlCount).toBe(6);
    // The checklists still read the stored shape (extra fields are ignored).
    expect(parseRobotsJson(run!.robots_json)).toMatchObject({ recorded: true, status: "ok", sitemapsFetched: [U("/sitemap.xml")], sitemapUrlCount: 6 });
  });
});
