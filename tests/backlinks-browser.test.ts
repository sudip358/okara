/**
 * Backlink browser fallback (Browser Run): which plain outcomes are queued for a browser re-check and which are not;
 * the browser step on a FAKE BROWSER binding + fake page (content(), url(), main response status) producing dofollow
 * when the link exists only in the rendered DOM; SSRF request interception (private / local subrequests and redirect
 * hops aborted) and images / media / fonts aborted; page + browser closed; the daily budget cap with next-day deferral,
 * the one-browser lease and the 20 s launch interval; binding missing -> "browser unavailable" (plain result kept);
 * history (method plain / browser) and events computed once on the final result; the UI states.
 */
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import {
  BROWSER_DAILY_CAP_MAX_MS,
  BROWSER_DAILY_CAP_MS,
  BROWSER_RESERVE_MS,
  browserSummaryText,
  needsBrowserRecheck,
  type BacklinkDetail,
  type BacklinkRow,
  type BacklinkSummary,
  type BrowserSummary,
} from "@shared/backlinks";
import { linkUrlKey } from "@shared/import";
import { createApp } from "@worker/app";
import type { Env } from "@worker/env";
import { Db } from "@worker/lib/db";
import { newId } from "@worker/lib/ids";
import { loadProjectRow } from "@worker/platform/projects";
import { insertBacklinkStmt } from "@worker/backlinks/store";
import { browserCapMs, browserConfig, interceptRequest, processBrowserStep, setBrowserLauncher, type BrowserLauncher, type BrowserRequest, type InterceptStats } from "@worker/backlinks/browser";
import { advanceProject, createJob, processBatch, processDueBacklinkChecks, setBacklinkFetch } from "@worker/backlinks/jobs";
import { browserPollInterval, rowCheckState } from "../src/web/pages/backlinks/lib";
import { createTestEnv } from "./helpers/env";
import { authHeaders, seedProject, seedUser } from "./helpers/fixtures";
import { OUR_HOST, T, article, fakeFetch, type Route } from "./backlinks-fixtures";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const noSleep = async () => undefined;
const FAKE_BINDING = { fetch: async () => new Response("fake browser binding") } as unknown as Fetcher;
const TARGET = T("/collections/pulls");
const LIVE = "https://decor-blog.example.net/brass-guide";
const app = createApp();
/** .tsx modules are loaded by path at runtime (the worker tsconfig does not compile JSX). */
const load = async <T,>(rel: string): Promise<T> => (await import(/* @vite-ignore */ rel)) as T;

afterEach(() => {
  setBacklinkFetch(null);
  setBrowserLauncher(null);
});

// ------------------------------------------------------------------ fakes
interface FakeReq {
  url: string;
  type: string;
  nav?: boolean;
}

interface FakeOpts {
  html: string;
  status?: number;
  finalUrl?: string;
  headers?: Record<string, string>;
  /** Requests the page makes after the main document (subresources, redirect hops). */
  requests?: FakeReq[];
  gotoError?: Error;
  launchError?: Error;
}

/** A fake Browser Run session: the page reports each request to the interception handler, then "loads". */
function fakeBrowser(o: FakeOpts) {
  const log = { aborted: [] as string[], continued: [] as string[], pageClosed: 0, browserClosed: 0, launches: 0, gotoUrls: [] as string[], binding: null as unknown, interception: false };
  let handler: ((r: BrowserRequest) => void) | null = null;
  const fire = (r: FakeReq) =>
    new Promise<boolean>((resolve) => {
      handler!({
        url: () => r.url,
        resourceType: () => r.type,
        isNavigationRequest: () => !!r.nav,
        abort: async () => {
          log.aborted.push(r.url);
          resolve(false);
        },
        continue: async () => {
          log.continued.push(r.url);
          resolve(true);
        },
      });
    });
  const page = {
    async setRequestInterception(on: boolean) {
      log.interception = on;
    },
    on(_e: "request", fn: (r: BrowserRequest) => void) {
      handler = fn;
    },
    async goto(url: string) {
      log.gotoUrls.push(url);
      for (const r of [{ url, type: "document", nav: true }, ...(o.requests ?? [])]) {
        const ok = await fire(r);
        if (!ok && r.nav) throw new Error("net::ERR_BLOCKED_BY_CLIENT at " + r.url);
      }
      if (o.gotoError) throw o.gotoError;
      return { status: () => o.status ?? 200, url: () => o.finalUrl ?? url, headers: () => o.headers ?? {} };
    },
    async waitForNetworkIdle() {},
    url: () => o.finalUrl ?? log.gotoUrls[0] ?? "",
    content: async () => o.html,
    close: async () => {
      log.pageClosed++;
    },
  };
  const launcher: BrowserLauncher = async (binding) => {
    log.launches++;
    log.binding = binding;
    if (o.launchError) throw o.launchError;
    return { newPage: async () => page, close: async () => void log.browserClosed++ };
  };
  return { launcher, log };
}

// ------------------------------------------------------------------ setup
async function setup(envOver: Partial<Env> = { BROWSER: FAKE_BINDING }) {
  const env = createTestEnv(envOver);
  const u = await seedUser(env);
  const pid = await seedProject(env, u.workspaceId);
  const db = new Db(env.DB);
  const p = (await loadProjectRow(db, u.workspaceId, pid))!;
  return { env, u, pid, db, p };
}

async function seed(s: Awaited<ReturnType<typeof setup>>, live = LIVE, target = TARGET) {
  const id = newId("bl");
  await s.db.batch([
    insertBacklinkStmt(s.p, id, `${linkUrlKey(live)}>${linkUrlKey(target)}`, {
      liveUrl: live,
      liveUrlKey: linkUrlKey(live),
      liveHost: new URL(live).hostname,
      targetUrl: target,
      targetUrlKey: linkUrlKey(target),
      anchorExpected: "brass cabinet pulls",
      vendor: null,
      linkType: null,
      placedDate: null,
      da: null,
      traffic: null,
      priceText: null,
      sourceRow: 2,
    }, "imp_seed", "csv:seed", new Date("2026-10-04T10:00:00Z")),
  ]);
  return id;
}

const link = (rel = "") => article(`<p>See <a ${rel ? `rel="${rel}" ` : ""}href="${TARGET}">brass cabinet pulls</a>.</p>`);
/** The server HTML has no link; a script would add it (the fake browser returns the rendered DOM with the link). */
const JS_ONLY = article(`<div id="app"></div><script>document.getElementById("app").innerHTML = '<a href="${TARGET}">brass cabinet pulls</a>'</script>`);

/** One plain check of every active backlink (manual job until done). */
async function plainCheck(s: Awaited<ReturnType<typeof setup>>, routes: Record<string, Route>, now = new Date("2026-10-05T10:00:00Z")) {
  setBacklinkFetch(fakeFetch({ [TARGET]: { status: 200, body: "<html></html>" }, ...routes }).fetch, noSleep);
  const { job } = await createJob(s.db, s.p, { userId: null, trigger: "manual", now });
  for (let i = 0; i < 5; i++) {
    const out = await processBatch(s.env, s.db, job.id, s.u.workspaceId, { now: () => now });
    if (out.job?.status === "completed") break;
  }
  return job.id;
}

const blRow = (s: Awaited<ReturnType<typeof setup>>, id: string) => s.db.first<Json>("SELECT * FROM backlinks WHERE id = ?", id);
const checks = (s: Awaited<ReturnType<typeof setup>>, id: string) => s.db.all<Json>("SELECT status, method, error_code, job_id FROM backlink_checks WHERE backlink_id = ? ORDER BY checked_at, rowid", id);
const eventsOf = (s: Awaited<ReturnType<typeof setup>>, id: string) => s.db.all<Json>("SELECT kind, message, check_id FROM backlink_events WHERE backlink_id = ? ORDER BY detected_at, rowid", id);

/** A fake monotonic clock for the measured browser time. */
function ticker(stepMs: number) {
  let t = 0;
  return () => (t += stepMs);
}

// ------------------------------------------------------------------ queueing rules
describe("which plain outcomes go to the browser", () => {
  it.each([
    [{ status: "missing", httpStatus: 200, errorCode: null }, true],
    [{ status: "page_error", httpStatus: 403, errorCode: null }, true],
    [{ status: "page_error", httpStatus: 429, errorCode: null }, true],
    [{ status: "page_error", httpStatus: 503, errorCode: null }, true],
    [{ status: "fetch_failed", httpStatus: null, errorCode: "timeout" }, true],
    [{ status: "fetch_failed", httpStatus: null, errorCode: "error" }, true],
    [{ status: "page_error", httpStatus: 404, errorCode: null }, false],
    [{ status: "page_error", httpStatus: 500, errorCode: null }, false],
    [{ status: "fetch_failed", httpStatus: null, errorCode: "blocked_url" }, false],
    [{ status: "fetch_failed", httpStatus: null, errorCode: "redirect_offsite" }, false],
    [{ status: "dofollow", httpStatus: 200, errorCode: null }, false],
    [{ status: "nofollow", httpStatus: 200, errorCode: null }, false],
    [{ status: "redirected", httpStatus: 200, errorCode: null }, false],
    [{ status: "robots_blocked", httpStatus: null, errorCode: null }, false],
  ] as const)("%j -> %s", (r, want) => {
    expect(needsBrowserRecheck(r)).toBe(want);
  });

  it("a plain batch queues missing / bot wall / fetch failures (no events yet), not 404, dofollow or a blocked URL", async () => {
    const s = await setup();
    const missing = await seed(s, "https://a.example.net/p");
    const wall = await seed(s, "https://b.example.net/p");
    const gone = await seed(s, "https://c.example.net/p");
    const fine = await seed(s, "https://d.example.net/p");
    const blocked = await seed(s, "http://127.0.0.1/admin");
    const down = await seed(s, "https://e.example.net/p");
    await plainCheck(s, {
      "https://a.example.net/p": { status: 200, body: article("<p>no link</p>") },
      "https://b.example.net/p": { status: 403, body: "Just a moment..." },
      "https://c.example.net/p": { status: 404, body: "" },
      "https://d.example.net/p": { status: 200, body: link() },
      "https://e.example.net/p": new TypeError("connection reset"),
    });
    expect((await blRow(s, missing)).browser_state).toBe("pending");
    expect((await blRow(s, wall)).browser_state).toBe("pending");
    expect((await blRow(s, down)).browser_state).toBe("pending");
    expect((await blRow(s, gone)).browser_state).toBeNull();
    expect((await blRow(s, fine)).browser_state).toBeNull();
    expect((await blRow(s, blocked)).browser_state).toBeNull();
    expect((await blRow(s, blocked)).status).toBe("fetch_failed");
    // The plain result is stored (method plain) and shown meanwhile.
    expect(await checks(s, missing)).toMatchObject([{ status: "missing", method: "plain" }]);
    expect((await blRow(s, missing)).status).toBe("missing");
    expect((await blRow(s, missing)).check_method).toBe("plain");
  });

  it("binding missing: the outcome is marked 'browser unavailable' with the reason, the plain result is final (events on it)", async () => {
    const s = await setup({});
    const id = await seed(s);
    await plainCheck(s, { [LIVE]: { status: 200, body: link() } }, new Date("2026-10-04T10:00:00Z"));
    await plainCheck(s, { [LIVE]: { status: 200, body: article("<p>gone</p>") } });
    const r = await blRow(s, id);
    expect(r.browser_state).toBe("unavailable");
    expect(r.browser_reason).toMatch(/no Browser Run binding \(BROWSER\)/);
    expect(r.status).toBe("missing");
    expect((await eventsOf(s, id)).map((e: Json) => e.kind)).toEqual(["link_removed"]);
    expect(browserConfig({}).available).toBe(false);
    // The step never launches anything without a binding.
    const fb = fakeBrowser({ html: link() });
    expect((await processBrowserStep(s.env, s.db, { project: s.p }, { launcher: fb.launcher })).status).toBe("idle");
    expect(fb.log.launches).toBe(0);
  });
});

// ------------------------------------------------------------------ browser step
describe("browser step on a fake BROWSER binding", () => {
  it("link only in the rendered DOM -> dofollow (method browser) supersedes the plain 'missing'; both kept; no false events", async () => {
    const s = await setup();
    const id = await seed(s);
    await plainCheck(s, { [LIVE]: { status: 200, body: link() } }, new Date("2026-10-04T10:00:00Z"));
    await plainCheck(s, { [LIVE]: { status: 200, body: JS_ONLY } });
    expect((await blRow(s, id)).browser_state).toBe("pending");

    const fb = fakeBrowser({ html: JS_ONLY.replace('<div id="app"></div>', `<div id="app"><a href="${TARGET}">brass cabinet pulls</a></div>`) });
    const out = await processBrowserStep(s.env, s.db, { project: s.p }, { launcher: fb.launcher, now: () => new Date("2026-10-05T10:01:00Z"), elapsedMs: ticker(4_000) });
    expect(out).toMatchObject({ status: "rechecked", backlinkId: id, chargedMs: 4_000 });
    expect(fb.log.binding).toBe(FAKE_BINDING);
    expect(fb.log.gotoUrls).toEqual([LIVE]);
    expect(fb.log.interception).toBe(true);
    expect(fb.log.pageClosed).toBe(1);
    expect(fb.log.browserClosed).toBe(1);

    const r = await blRow(s, id);
    expect(r).toMatchObject({ status: "dofollow", link_rel: "dofollow", check_method: "browser", browser_state: null, anchor_match: 1 });
    expect(r.browser_reason).toMatch(/headless browser.*Link missing/);
    expect((await checks(s, id)).map((c: Json) => `${c.method}:${c.status}`)).toEqual(["plain:dofollow", "plain:missing", "browser:dofollow"]);
    // Events on the final result: dofollow -> dofollow is no change (the plain "missing" never produced "link removed").
    expect(await eventsOf(s, id)).toEqual([]);

    // Detail + list carry the method.
    const detail = await call(s, "GET", `/projects/${s.pid}/backlinks/${id}`);
    const d = detail.json.data as BacklinkDetail;
    expect(d.backlink).toMatchObject({ checkMethod: "browser", browserState: null });
    expect(d.checks.map((c) => c.method)).toEqual(["browser", "plain", "plain"]);
    // Usage: the measured 4 s replaced the 60 s reservation.
    expect(await s.db.first<Json>("SELECT ms_used, sessions FROM browser_usage WHERE day = '2026-10-05'")).toEqual({ ms_used: 4_000, sessions: 1 });
  });

  it("a real removal is confirmed in the browser: ONE 'link removed' event, on the browser check", async () => {
    const s = await setup();
    const id = await seed(s);
    await plainCheck(s, { [LIVE]: { status: 200, body: link() } }, new Date("2026-10-04T10:00:00Z"));
    await plainCheck(s, { [LIVE]: { status: 200, body: article("<p>gone</p>") } });
    expect(await eventsOf(s, id)).toEqual([]);
    const fb = fakeBrowser({ html: article("<p>gone</p>") });
    await processBrowserStep(s.env, s.db, { project: s.p }, { launcher: fb.launcher });
    const ev = await eventsOf(s, id);
    expect(ev.map((e: Json) => e.kind)).toEqual(["link_removed"]);
    const browserCheck = await s.db.first<Json>("SELECT id FROM backlink_checks WHERE backlink_id = ? AND method = 'browser'", id);
    expect(ev[0].check_id).toBe(browserCheck.id);
    expect((await blRow(s, id)).last_change_text).toMatch(/^Link removed/);
  });

  it("bot wall (403) on the plain fetch, 200 with a nofollow link in the browser -> nofollow, checked in browser", async () => {
    const s = await setup();
    const id = await seed(s);
    await plainCheck(s, { [LIVE]: { status: 403, body: "Access denied" } });
    const fb = fakeBrowser({ html: link("nofollow"), headers: { "x-robots-tag": "noindex" } });
    expect((await processBrowserStep(s.env, s.db, { project: s.p }, { launcher: fb.launcher })).status).toBe("rechecked");
    expect(await blRow(s, id)).toMatchObject({ status: "nofollow", http_status: 200, page_noindex: 1, check_method: "browser" });
  });

  it("SSRF: private / local / IP subrequests are aborted, public ones continue; images, media and fonts are aborted", async () => {
    const s = await setup();
    const id = await seed(s);
    await plainCheck(s, { [LIVE]: { status: 200, body: JS_ONLY } });
    const fb = fakeBrowser({
      html: link(),
      requests: [
        { url: "http://127.0.0.1/latest/meta-data/", type: "xhr" },
        { url: "http://169.254.169.254/", type: "fetch" },
        { url: "https://localhost/admin", type: "script" },
        { url: "https://intranet.local/x", type: "script" },
        { url: "https://user:pw@cdn.example.org/a.js", type: "script" },
        { url: "https://cdn.example.org:8443/a.js", type: "script" },
        { url: "file:///etc/passwd", type: "other" },
        { url: "https://cdn.example.org/app.js", type: "script" },
        { url: "https://cdn.example.org/hero.jpg", type: "image" },
        { url: "https://cdn.example.org/clip.mp4", type: "media" },
        { url: "https://fonts.example.org/f.woff2", type: "font" },
        { url: "data:image/png;base64,AAAA", type: "image" },
        { url: "data:text/css,body{}", type: "stylesheet" },
      ],
    });
    expect((await processBrowserStep(s.env, s.db, { project: s.p }, { launcher: fb.launcher })).status).toBe("rechecked");
    expect(fb.log.continued).toEqual([LIVE, "https://cdn.example.org/app.js", "data:text/css,body{}"]);
    expect(fb.log.aborted).toEqual([
      "http://127.0.0.1/latest/meta-data/",
      "http://169.254.169.254/",
      "https://localhost/admin",
      "https://intranet.local/x",
      "https://user:pw@cdn.example.org/a.js",
      "https://cdn.example.org:8443/a.js",
      "file:///etc/passwd",
      "https://cdn.example.org/hero.jpg",
      "https://cdn.example.org/clip.mp4",
      "https://fonts.example.org/f.woff2",
      "data:image/png;base64,AAAA",
    ]);
    expect((await blRow(s, id)).status).toBe("dofollow");
  });

  it("a redirect hop to a private host is aborted: the browser attempt is recorded as failed, the plain result stays final", async () => {
    const s = await setup();
    const id = await seed(s);
    await plainCheck(s, { [LIVE]: { status: 200, body: link() } }, new Date("2026-10-04T10:00:00Z"));
    await plainCheck(s, { [LIVE]: new TypeError("connection reset") });
    const fb = fakeBrowser({ html: link(), requests: [{ url: "http://10.0.0.5/internal", type: "document", nav: true }] });
    expect((await processBrowserStep(s.env, s.db, { project: s.p }, { launcher: fb.launcher })).status).toBe("failed");
    expect(fb.log.aborted).toEqual(["http://10.0.0.5/internal"]);
    expect(fb.log.pageClosed).toBe(1);
    expect(fb.log.browserClosed).toBe(1);
    const r = await blRow(s, id);
    expect(r).toMatchObject({ status: "fetch_failed", check_method: "plain", browser_state: "failed" });
    expect(r.browser_reason).toMatch(/non-public address/);
    expect((await checks(s, id)).map((c: Json) => `${c.method}:${c.status}:${c.error_code ?? ""}`)).toEqual(["plain:dofollow:", "plain:fetch_failed:error", "browser:fetch_failed:redirect_offsite"]);
    // Events on the final (plain) result.
    expect((await eventsOf(s, id)).map((e: Json) => e.kind)).toEqual(["fetch_failed"]);
  });

  it("the interception handler alone: navigation to a blocked host is flagged", async () => {
    const stats: InterceptStats = { blocked: [], media: 0, navigationBlocked: null };
    const calls: string[] = [];
    const req = (url: string, type: string, nav = false): BrowserRequest => ({ url: () => url, resourceType: () => type, isNavigationRequest: () => nav, abort: async () => void calls.push(`abort ${url}`), continue: async () => void calls.push(`go ${url}`) });
    await interceptRequest(req("https://[::1]/", "document", true), stats);
    await interceptRequest(req("https://news.example.com/", "document", true), stats);
    expect(calls).toEqual(["abort https://[::1]/", "go https://news.example.com/"]);
    expect(stats.navigationBlocked).toBe("https://[::1]/");
  });

  it("navigation timeout: failed (plain kept); the page and browser are still closed", async () => {
    const s = await setup();
    const id = await seed(s);
    await plainCheck(s, { [LIVE]: { status: 200, body: JS_ONLY } });
    const fb = fakeBrowser({ html: "", gotoError: new Error("Navigation timeout of 20000 ms exceeded") });
    expect((await processBrowserStep(s.env, s.db, { project: s.p }, { launcher: fb.launcher })).status).toBe("failed");
    expect(fb.log.pageClosed + fb.log.browserClosed).toBe(2);
    expect(await blRow(s, id)).toMatchObject({ status: "missing", browser_state: "failed" });
  });
});

// ------------------------------------------------------------------ budget, lease, availability
describe("browser budget and concurrency", () => {
  it(`stops at the daily cap (default ${BROWSER_DAILY_CAP_MS / 60_000} min); rows wait (deferred, not dropped) and run the next UTC day`, async () => {
    const s = await setup();
    const id = await seed(s);
    await plainCheck(s, { [LIVE]: { status: 200, body: JS_ONLY } });
    await s.db.run("INSERT INTO browser_usage (day, ms_used, sessions, exhausted, updated_at) VALUES ('2026-10-05', ?, 9, 0, 'x')", BROWSER_DAILY_CAP_MS - BROWSER_RESERVE_MS + 1);
    const fb = fakeBrowser({ html: link() });
    const today = () => new Date("2026-10-05T23:50:00Z");
    expect((await processBrowserStep(s.env, s.db, { project: s.p }, { launcher: fb.launcher, now: today })).status).toBe("deferred");
    expect(fb.log.launches).toBe(0);
    expect((await blRow(s, id)).browser_state).toBe("pending");
    const sum = (await call(s, "GET", `/projects/${s.pid}/backlinks/summary`)).json.data as BacklinkSummary;
    // The route reads the request clock; the counter for "today" is what the step saw.
    expect(sum.browser.capMs).toBe(BROWSER_DAILY_CAP_MS);
    expect(sum.browser.waiting).toBe(1);

    const tomorrow = () => new Date("2026-10-06T00:01:00Z");
    expect((await processBrowserStep(s.env, s.db, { project: s.p }, { launcher: fb.launcher, now: tomorrow, elapsedMs: ticker(7_500) })).status).toBe("rechecked");
    expect(await s.db.first<Json>("SELECT ms_used FROM browser_usage WHERE day = '2026-10-06'")).toEqual({ ms_used: 7_500 });
    expect((await blRow(s, id)).status).toBe("dofollow");
  });

  it("the cap is configurable (clamped below the free allowance; 0 = off)", () => {
    expect(browserCapMs({})).toBe(480_000);
    expect(browserCapMs({ BACKLINK_BROWSER_MS_PER_DAY: "120000" })).toBe(120_000);
    expect(browserCapMs({ BACKLINK_BROWSER_MS_PER_DAY: "9999999" })).toBe(BROWSER_DAILY_CAP_MAX_MS);
    expect(browserCapMs({ BACKLINK_BROWSER_MS_PER_DAY: "x" })).toBe(480_000);
    expect(browserConfig({ BROWSER: FAKE_BINDING, BACKLINK_BROWSER_MS_PER_DAY: "0" })).toMatchObject({ available: false, reason: expect.stringMatching(/turned off/) });
  });

  it("an invocation cut off mid-render still counts: the reservation is pre-charged", async () => {
    const s = await setup();
    await seed(s);
    await plainCheck(s, { [LIVE]: { status: 200, body: JS_ONLY } });
    const hang: BrowserLauncher = async () => ({
      newPage: async () => {
        const u = await s.db.first<Json>("SELECT ms_used FROM browser_usage WHERE day = ?", new Date().toISOString().slice(0, 10));
        throw new Error(`killed (usage seen ${u.ms_used})`);
      },
      close: async () => undefined,
    });
    const out = await processBrowserStep(s.env, s.db, { project: s.p }, { launcher: hang });
    expect(out.status).toBe("failed");
    const r = await s.db.first<Json>("SELECT browser_reason FROM backlinks WHERE project_id = ?", s.pid);
    expect(r.browser_reason).toMatch(new RegExp(`usage seen ${BROWSER_RESERVE_MS}`));
  });

  it("one browser at a time (lease) and >= 20 s between launches", async () => {
    const s = await setup();
    await seed(s, "https://a.example.net/p");
    await seed(s, "https://b.example.net/p");
    await plainCheck(s, { "https://a.example.net/p": { status: 200, body: JS_ONLY }, "https://b.example.net/p": { status: 200, body: JS_ONLY } });
    const fb = fakeBrowser({ html: link() });
    const t0 = new Date("2026-10-05T12:00:00Z");
    expect((await processBrowserStep(s.env, s.db, { project: s.p }, { launcher: fb.launcher, now: () => t0 })).status).toBe("rechecked");
    // 5 s later: the launch interval is not over.
    expect((await processBrowserStep(s.env, s.db, { project: s.p }, { launcher: fb.launcher, now: () => new Date(t0.getTime() + 5_000) })).status).toBe("busy");
    // A lease held by another invocation (a browser is open): no second browser.
    await s.db.run("UPDATE browser_lease SET lease_until = ?, last_launch_at = ?", "2026-10-05T12:05:00.000Z", "2026-10-05T11:00:00.000Z");
    expect((await processBrowserStep(s.env, s.db, { project: s.p }, { launcher: fb.launcher, now: () => new Date(t0.getTime() + 60_000) })).status).toBe("busy");
    expect(fb.log.launches).toBe(1);
    expect((await processBrowserStep(s.env, s.db, { project: s.p }, { launcher: fb.launcher, now: () => new Date(t0.getTime() + 400_000) })).status).toBe("rechecked");
    expect(fb.log.launches).toBe(2);
  });

  it("Browser Run says the day's time is used up -> deferred to the next UTC day (rows stay pending)", async () => {
    const s = await setup();
    const id = await seed(s);
    await plainCheck(s, { [LIVE]: { status: 200, body: JS_ONLY } });
    const fb = fakeBrowser({ html: link(), launchError: new Error("Unable to create new browser: code: 429: message: Browser time limit exceeded for today") });
    const now = () => new Date("2026-10-05T15:00:00Z");
    expect((await processBrowserStep(s.env, s.db, { project: s.p }, { launcher: fb.launcher, now })).status).toBe("deferred");
    expect(await s.db.first<Json>("SELECT exhausted FROM browser_usage WHERE day = '2026-10-05'")).toEqual({ exhausted: 1 });
    expect((await blRow(s, id)).browser_state).toBe("pending");
    expect((await processBrowserStep(s.env, s.db, { project: s.p }, { launcher: fb.launcher, now: () => new Date("2026-10-05T15:30:00Z") })).status).toBe("deferred");
    expect(fb.log.launches).toBe(1);
  });

  it("no Browser Run access (launch keeps failing) -> 'browser unavailable' after 3 tries, plain result kept, events on it", async () => {
    const s = await setup();
    const id = await seed(s);
    await plainCheck(s, { [LIVE]: { status: 200, body: link() } }, new Date("2026-10-04T10:00:00Z"));
    await plainCheck(s, { [LIVE]: { status: 200, body: article("<p>none</p>") } });
    const fb = fakeBrowser({ html: link(), launchError: new Error("Unauthorized: Browser Run is not enabled for this account") });
    let t = new Date("2026-10-05T12:00:00Z").getTime();
    const statuses: string[] = [];
    for (let i = 0; i < 3; i++) {
      t += 60_000;
      const at = t;
      statuses.push((await processBrowserStep(s.env, s.db, { project: s.p }, { launcher: fb.launcher, now: () => new Date(at) })).status);
    }
    expect(statuses).toEqual(["launch_failed", "launch_failed", "launch_failed"]);
    const r = await blRow(s, id);
    expect(r).toMatchObject({ browser_state: "unavailable", status: "missing", check_method: "plain" });
    expect(r.browser_reason).toMatch(/refused to start a browser 3 times/);
    expect((await eventsOf(s, id)).map((e: Json) => e.kind)).toEqual(["link_removed"]);
  });

  it("a binding removed after rows were queued: the step resolves them as unavailable, never fakes a result", async () => {
    const s = await setup();
    const id = await seed(s);
    await plainCheck(s, { [LIVE]: { status: 200, body: JS_ONLY } });
    const noBinding = { ...s.env, BROWSER: undefined } as Env;
    expect((await processBrowserStep(noBinding, s.db, { project: s.p })).status).toBe("unavailable");
    expect(await blRow(s, id)).toMatchObject({ browser_state: "unavailable", status: "missing", check_method: "plain" });
  });

  it("drivers: advance runs the browser step only when it did no plain work; the cron runs one after its batch", async () => {
    const s = await setup();
    await seed(s);
    await plainCheck(s, { [LIVE]: { status: 200, body: JS_ONLY } });
    const fb = fakeBrowser({ html: link() });
    setBrowserLauncher(fb.launcher);
    await advanceProject(s.env, s.db, s.p);
    expect(fb.log.launches).toBe(1);
    const s2 = await setup();
    await seed(s2);
    await plainCheck(s2, { [LIVE]: { status: 200, body: JS_ONLY } });
    const r = await processDueBacklinkChecks(s2.env, new Date());
    expect(r.browser).toBe("rechecked");
  });
});

// ------------------------------------------------------------------ routes + UI
async function call(s: Awaited<ReturnType<typeof setup>>, method: string, path: string, body?: unknown) {
  const res = await app.request(`/api${path}`, { method, headers: authHeaders(s.u.sessionToken, s.u.csrfToken), body: body === undefined ? undefined : JSON.stringify(body) }, s.env);
  return { status: res.status, json: (await res.json()) as Json };
}

const bs = (o: Partial<BrowserSummary> = {}): BrowserSummary => ({ available: true, unavailableReason: null, waiting: 3, unavailable: 0, failed: 0, usedMs: 90_000, capMs: 480_000, deferred: false, deferredUntil: null, ...o });

describe("browser re-check UI", () => {
  it("summary line: n waiting · used X of 8 min today (deferred / unavailable variants)", () => {
    expect(browserSummaryText(bs())).toBe("Browser re-checks: 3 waiting · used 1.5 of 8 min today");
    expect(browserSummaryText(bs({ usedMs: 480_000, deferred: true }))).toMatch(/used 8 of 8 min today · budget used up, the rest run after 00:00 UTC/);
    expect(browserSummaryText(bs({ available: false, unavailableReason: "no Browser Run binding (BROWSER) is configured" }))).toBe("Browser re-checks: unavailable (no Browser Run binding (BROWSER) is configured)");
    expect(browserPollInterval({ browser: bs() })).toBe(10_000);
    expect(browserPollInterval({ browser: bs({ deferred: true }) })).toBeNull();
    expect(browserPollInterval({ browser: bs({ waiting: 0 }) })).toBeNull();
    expect(browserPollInterval({ browser: bs({ available: false }) })).toBeNull();
  });

  const row = (o: Partial<BacklinkRow> = {}): BacklinkRow =>
    ({ id: "bl1", liveUrl: LIVE, liveHost: "decor-blog.example.net", targetUrl: TARGET, anchorExpected: "brass cabinet pulls", vendor: null, linkType: null, placedDate: null, da: null, traffic: null, priceText: null, anchorFound: null, anchorMatch: null, relText: null, linkRel: null, statusReason: null, targetStatus: 200, targetError: null, pageNoindex: false, active: true, status: "missing", httpStatus: 200, lastCheckedAt: "2026-10-05T10:00:00.000Z", checkMethod: "plain", browserState: "pending", browserReason: null, lastChangeText: null, lastChangeNegative: null, ...o }) as BacklinkRow;

  it("Change column: 'Checking in browser…' while browser_pending", async () => {
    expect(rowCheckState(row(), undefined, null)).toBe("browser");
    expect(rowCheckState(row({ browserState: null }), undefined, null)).toBe("idle");
    expect(rowCheckState(row(), "2026-10-05T11:00:00.000Z", null)).toBe("pending");
    const page = await load<{ RowCheckCell: (p: Json) => ReactElement }>("../src/web/pages/backlinks/BacklinksPage.tsx");
    const html = renderToStaticMarkup(h(page.RowCheckCell, { r: row(), state: "browser", job: null, disabledReason: null, onCheck: () => {} }));
    expect(html).toContain("Checking in browser…");
    expect(html).toContain("disabled");
  });

  it("status badge 'checked in browser' and history with method plain / browser", async () => {
    const parts = await load<{ BacklinkHistory: (p: Json) => ReactElement }>("../src/web/pages/backlinks/parts.tsx");
    const base = { backlinkId: "bl1", jobId: "j", statusReason: null, linkRel: "dofollow", httpStatus: 200, finalUrl: null, redirectChain: [], robots: "not_consulted", metaRobots: null, xRobotsTag: null, pageNoindex: false, pageNofollow: false, canonicalUrl: null, linkMatch: "target", links: [], relText: null, anchorFound: "brass cabinet pulls", anchorMatch: true, targetStatus: 200, targetFinalUrl: null, targetError: null, errorCode: null, fetches: 1, truncated: false };
    const detail: BacklinkDetail = {
      backlink: row({ status: "dofollow", checkMethod: "browser", browserState: null, browserReason: "Checked in a headless browser (Browser Run) because the plain fetch saw “Link missing”." }),
      events: [],
      checks: [
        { ...base, id: "c2", checkedAt: "2026-10-05T10:01:00.000Z", method: "browser", status: "dofollow" },
        { ...base, id: "c1", checkedAt: "2026-10-05T10:00:00.000Z", method: "plain", status: "missing", linkRel: "missing" },
      ] as BacklinkDetail["checks"],
    };
    const html = renderToStaticMarkup(h(MemoryRouter, null, h(parts.BacklinkHistory, { detail })));
    expect(html).toContain('data-testid="browser-badge"');
    expect(html).toContain("checked in browser");
    expect(html).toContain('data-method="browser"');
    expect(html).toContain('data-method="plain"');
    expect(html).toMatch(/plain fetch saw/);
  });

  it("Live Backlinks container 01 and the Backlinks summary show the browser line", async () => {
    const bc = await load<{ LiveCheckPanel: (p: Json) => ReactElement }>("../src/web/pages/live/backlinks/BacklinkContainers.tsx");
    const ra = await load<{ RunActionsProvider: (p: Json) => ReactElement }>("../src/web/pages/live/RunActions.tsx");
    const summary = { state: "ready", totals: { active: 3, inactive: 0, checked: 3, unchecked: 0 }, byStatus: { dofollow: 1, nofollow: 0, sponsored: 0, ugc: 0, missing: 2, page_error: 0, redirected: 0, robots_blocked: 0, fetch_failed: 0 }, dofollow: { n: 1, m: 3 }, targetBroken: 0, anchorMismatch: 0, changes: { last7: 0, last30: 0, negative7: 0, negative30: 0 }, lastCheckAt: null, nextCheckAt: null, job: null, lastJob: null, limits: { maxBacklinks: 2000, manualPerDay: 3, manualUsedToday: 0, recheckRowsPerHour: 30, fetchesPerInvocation: 20, scheduledEveryDays: 7 }, browser: bs({ waiting: 2, usedMs: 120_000 }), canRun: true, verified: true, labels: [] } as BacklinkSummary;
    const feed = { job: null, items: [{ checkId: "c2", method: "browser", backlinkId: "bl1", checkedAt: "2026-10-05T10:01:00.000Z", liveUrl: LIVE, targetUrl: TARGET, status: "dofollow", statusReason: null, httpStatus: 200, finalUrl: null, anchorFound: "x", robots: null }] };
    const action = { kind: "call", key: "k", label: "Run backlink check", disabled: null, path: "/x", body: {}, confirm: { title: "t", body: "b", confirmLabel: "c" } };
    const st = <T,>(data: T) => ({ data, error: null, loading: false });
    const html = renderToStaticMarkup(
      h(MemoryRouter, null, h(ra.RunActionsProvider, { projectId: "p1", onStarted: () => {}, onReload: () => {} }, h(bc.LiveCheckPanel, { projectId: "p1", reduced: true, demo: false, feed: st(feed), summary: st(summary), action }))),
    );
    expect(html).toContain("Browser re-checks: 2 waiting · used 2 of 8 min today");
    expect(html).toContain("checked in browser");
    const page = await load<{ SummaryTiles: (p: Json) => ReactElement }>("../src/web/pages/backlinks/BacklinksPage.tsx");
    expect(renderToStaticMarkup(h(page.SummaryTiles, { s: summary }))).toContain("Browser re-checks: 2 waiting · used 2 of 8 min today");
    expect(OUR_HOST).toBe("shop.example.com");
  });
});
