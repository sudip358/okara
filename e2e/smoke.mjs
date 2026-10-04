/**
 * End-to-end smoke test against a running local dev server (npm run dev) with demo mode on.
 * Requires .dev.vars with ENVIRONMENT=development, DEMO_MODE=true, DEV_AUTH_BYPASS=true, APP_ORIGIN=http://localhost:5173.
 *   npm run db:migrate:local && npm run dev    # in one terminal
 *   npm run e2e                                # in another
 * Screenshots and a JSON report go to e2e/output/ (gitignored). Exit code 1 on any failure.
 * Browser: uses Playwright's Chromium (set PLAYWRIGHT_BROWSERS_PATH or install with `npx playwright install chromium`).
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:5173";
const OUT = new URL("./output/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
const failures = [];
const checks = [];
let step = "start";
page.on("pageerror", (e) => failures.push({ step, kind: "pageerror", text: String(e).slice(0, 300) }));
page.on("console", (m) => { if (m.type() === "error" && !/401 \(Unauthorized\)/.test(m.text())) failures.push({ step, kind: "console", text: m.text().slice(0, 300) }); });
page.on("response", async (r) => {
  if (r.url().includes("/api/") && r.status() >= 400 && !(r.url().endsWith("/api/me") && r.status() === 401)) {
    failures.push({ step, kind: "api", status: r.status(), method: r.request().method(), url: r.url().replace(BASE, ""), body: (await r.text().catch(() => "")).slice(0, 200) });
  }
});
const check = (name, pass, detail = "") => { checks.push({ name, pass, detail }); if (!pass) failures.push({ step, kind: "check", text: `${name}: ${detail}` }); };
const shot = async (name) => { await page.waitForTimeout(500); await page.screenshot({ path: `${OUT}${name}.png`, fullPage: true }); };
const waitFor = (pred, ms = 30000) => page.waitForResponse(pred, { timeout: ms }).catch(() => null);

// Sign in with the local-only dev login, then load the demo project.
step = "signin";
await page.goto(`${BASE}/signin`, { waitUntil: "networkidle" });
await shot("01-signin");
const devBtn = page.getByRole("button", { name: /dev|local|demo/i }).first();
check("dev login button present", (await devBtn.count()) > 0, "DEV_AUTH_BYPASS must be true in .dev.vars");
if (await devBtn.count()) await devBtn.click();
await page.waitForTimeout(1200);

step = "demo";
await page.goto(`${BASE}/projects`, { waitUntil: "networkidle" });
const demoBtn = page.getByRole("button", { name: /demo/i }).first();
if (await demoBtn.count()) {
  await demoBtn.click();
  await page.waitForURL(/\/projects\/prj_[^/]+/, { timeout: 20000 }).catch(() => {});
}
let P = page.url().match(/\/projects\/prj_[^/?#]+/)?.[0] ?? null;
if (!P) {
  const link = page.locator('a[href^="/projects/prj_"]').first();
  if (await link.count()) P = (await link.getAttribute("href")).match(/\/projects\/prj_[^/?#]+/)[0];
}
check("demo project available", !!P, "DEMO_MODE must be true and ENVIRONMENT development");

if (P) {
  const routes = [
    ["", /overview/i], ["seo", /seo audit/i], ["internal-links", /internal links/i], ["redirects", /redirect/i],
    ["draft-check", /draft check/i], ["recommendations", /recommendations/i], ["geo/prompts", /geo prompts/i],
    ["geo/results", /geo results/i], ["competitors", /competitors/i], ["checklists", /checklist/i],
    ["checklists?tab=geo", /checklist/i], ["runs", /runs/i], ["integrations", /integrations/i], ["usage", /usage/i], ["settings", /settings/i],
  ];
  let n = 2;
  for (const [r, heading] of routes) {
    step = r || "overview";
    await page.goto(`${BASE}${P}/${r}`, { waitUntil: "networkidle" });
    const h1 = (await page.locator("main h1, h1").first().textContent().catch(() => "")) ?? "";
    check(`page ${step} renders`, heading.test(h1), `h1="${h1.trim()}"`);
    await shot(`${String(n++).padStart(2, "0")}-${step.replace(/[/?=]/g, "_")}`);
  }

  // Writes through the real UI (session cookie + X-CSRF-Token + same-origin Origin).
  step = "approve";
  await page.goto(`${BASE}${P}/recommendations`, { waitUntil: "networkidle" });
  const approve = page.getByRole("button", { name: /^approve$/i }).first();
  if (await approve.count()) {
    const [resp] = await Promise.all([waitFor((r) => r.url().includes("/api/recommendations/") && r.request().method() === "PATCH", 10000), approve.click()]);
    check("approve a recommendation", resp?.status() === 200, `HTTP ${resp?.status()}`);
  } else check("approve a recommendation", true, "no open recommendation (already approved)");

  step = "checklist-manual";
  await page.goto(`${BASE}${P}/checklists`, { waitUntil: "networkidle" });
  // The demo project is reused across runs: take the first manual item not yet marked done.
  const boxes = page.getByLabel(/mark as done/i);
  let done = null;
  for (let i = 0; i < (await boxes.count()); i++) {
    if (!(await boxes.nth(i).isChecked())) {
      done = boxes.nth(i);
      break;
    }
  }
  if (done) {
    await done.check();
    const form = done.locator("xpath=ancestor::form[1]");
    const [resp] = await Promise.all([waitFor((r) => r.url().includes("/checklists/") && r.request().method() === "PUT", 10000), form.getByRole("button").last().click()]);
    check("save a manual checklist item", resp?.status() === 200, `HTTP ${resp?.status()}`);
  } else check("save a manual checklist item", true, "no unchecked manual item left");

  step = "internal-links";
  await page.goto(`${BASE}${P}/internal-links`, { waitUntil: "networkidle" });
  const runLinks = page.getByRole("button", { name: /run|analy/i }).first();
  if (await runLinks.count() && await runLinks.isEnabled()) {
    const [resp] = await Promise.all([waitFor((r) => r.url().includes("/internal-links/run")), runLinks.click()]);
    check("run internal link suggester", !!resp && (resp.status() < 400 || resp.status() === 429), `HTTP ${resp?.status()}`);
  }

  step = "redirects";
  await page.goto(`${BASE}${P}/redirects`, { waitUntil: "networkidle" });
  const ta = page.locator("textarea").first();
  if (await ta.count()) {
    await ta.fill("https://demo.example/collections/sofa\nhttps://demo.example/unknown-page-xyz");
    const [resp] = await Promise.all([waitFor((r) => r.url().includes("/redirect-map")), page.getByRole("button", { name: /map|run|generate/i }).first().click()]);
    check("map redirects", !!resp && resp.status() < 400, `HTTP ${resp?.status()}`);
  }

  step = "draft-check";
  await page.goto(`${BASE}${P}/draft-check`, { waitUntil: "networkidle" });
  const q = page.getByLabel(/target query/i).first();
  const draft = page.locator("textarea").first();
  if (await q.count() && await draft.count()) {
    await q.fill("washable linen slipcover sofa");
    await draft.fill("# Washable linen slipcover sofas\n\nOur linen slipcover sofas have removable covers you can machine wash at 30°C, according to the care guide at https://demo.example/care.\n\n## What size fits a small living room?\n\nA 180 cm two-seater suits most rooms under 12 m².\n\n\"Best sofa ever!\" — Jane D., CEO\n");
    const [resp] = await Promise.all([waitFor((r) => r.url().includes("/draft-check") && r.request().method() === "POST"), page.getByRole("button", { name: /run|check/i }).last().click()]);
    const body = resp ? await resp.json().catch(() => null) : null;
    check("run a draft check", !!resp && resp.status() === 200 && !!body?.data?.verdict, `HTTP ${resp?.status()} verdict=${body?.data?.verdict} flags=${body?.data?.flags?.length}`);
    await shot("80-draft-check-result");
  } else check("run a draft check", false, "form fields not found");

  step = "mobile";
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}${P}`, { waitUntil: "networkidle" });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check("no horizontal overflow at 390px", !overflow);
  await shot("90-mobile-overview");

  // ---- Live Activity window (button in the project shell, role="log" feed, Esc closes) ----
  const pid = P.split("/").pop();
  const unwrap = (b) => (b && typeof b === "object" && "data" in b && b.data && typeof b.data === "object" ? b.data : b);
  const apiGet = async (path) => {
    const r = await page.request.get(`${BASE}/api${path}`).catch((e) => ({ status: () => 0, json: async () => null, text: async () => String(e) }));
    const ct = r.headers?.()["content-type"] ?? "";
    const body = await r.json().catch(() => null);
    return { status: r.status(), json: /json/.test(ct) || body !== null, body: unwrap(body) };
  };
  const DURATION = /\b\d+h \d{2}m\b|\b\d+m \d{2}s\b|\b\d+(\.\d+)?\s?(s|ms|sec|min)\b|\b\d{1,2}:\d{2}(:\d{2})?\b/;
  /** Opens the Activity window on the current page; returns { panel, log } locators or null. */
  const openActivity = async (label) => {
    const btn = page.getByRole("button", { name: /activity/i }).first();
    if (!(await btn.count())) { check(`activity: ${label} open`, false, 'no button matching /activity/i in the project shell'); return null; }
    await btn.click();
    const log = page.getByRole("log").first();
    const ok = await log.waitFor({ state: "visible", timeout: 8000 }).then(() => true).catch(() => false);
    if (!ok) { check(`activity: ${label} open`, false, 'clicking Activity did not show a role="log" feed within 8s'); return null; }
    check(`activity: ${label} open`, true, 'role="log" visible');
    const dialog = page.getByRole("dialog").filter({ has: page.getByRole("log") }).first();
    const panel = (await dialog.count()) ? dialog : log.locator("xpath=ancestor::*[self::aside or self::section or @role='dialog' or @role='complementary' or @role='region'][1]");
    return { panel: (await panel.count()) ? panel : log, log };
  };

  step = "activity-api";
  let replayRunId = null;
  {
    const cur = await apiGet(`/projects/${pid}/activity/current`);
    const runs = cur.body?.runs;
    check("activity: GET /activity/current returns 200 JSON with runs[]", cur.status === 200 && cur.json && Array.isArray(runs),
      `HTTP ${cur.status} json=${cur.json} runs=${Array.isArray(runs) ? runs.length : typeof runs}`);
    replayRunId = Array.isArray(runs) && runs[0]?.id ? runs[0].id : null;
    if (!replayRunId) {
      // Fall back to the latest run from the run history API so the feed endpoint can still be exercised.
      const hist = await apiGet(`/projects/${pid}/runs`);
      const list = Array.isArray(hist.body) ? hist.body : hist.body?.runs ?? hist.body?.items ?? [];
      replayRunId = list[0]?.id ?? null;
    }
    if (!replayRunId) check("activity: GET /runs/:id/activity returns items[] + cursor", false, "no run id available (activity/current runs[] empty and /runs empty)");
    else {
      const first = await apiGet(`/projects/${pid}/runs/${replayRunId}/activity?limit=5`);
      const items = first.body?.items;
      const hasCursorField = !!first.body && "cursor" in first.body;
      const cursor = first.body?.cursor ?? null;
      check("activity: GET /runs/:id/activity returns items[] + cursor", first.status === 200 && Array.isArray(items) && hasCursorField && (items.length === 0 || typeof cursor === "string"),
        `HTTP ${first.status} run=${replayRunId} items=${Array.isArray(items) ? items.length : typeof items} cursor=${hasCursorField ? JSON.stringify(cursor) : "missing"}`);
      check("activity: demo replay run has at least one stored item", Array.isArray(items) && items.length > 0, `run=${replayRunId} items=${Array.isArray(items) ? items.length : "n/a"}`);
      if (typeof cursor === "string" && Array.isArray(items)) {
        const next = await apiGet(`/projects/${pid}/runs/${replayRunId}/activity?after=${encodeURIComponent(cursor)}&limit=200`);
        const ids = new Set(items.map((i) => i.id));
        const nextItems = Array.isArray(next.body?.items) ? next.body.items : null;
        const dupes = (nextItems ?? []).filter((i) => ids.has(i.id)).map((i) => i.id);
        const selfDupes = (nextItems ?? []).length - new Set((nextItems ?? []).map((i) => i.id)).size;
        check("activity: ?after=<cursor> returns no duplicate item ids", next.status === 200 && !!nextItems && dupes.length === 0 && selfDupes === 0,
          `HTTP ${next.status} newer=${nextItems?.length ?? "n/a"} dupes=${JSON.stringify(dupes.slice(0, 5))} withinPageDupes=${selfDupes}`);
      } else check("activity: ?after=<cursor> returns no duplicate item ids", false, `no cursor returned by first page (cursor=${JSON.stringify(cursor)})`);
    }
  }

  step = "activity-ui";
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.goto(`${BASE}${P}`, { waitUntil: "networkidle" });
  const nActBtn = await page.getByRole("button", { name: /activity/i }).count();
  check("activity: Activity button on project overview", nActBtn > 0, nActBtn ? `${nActBtn} button(s) named /activity/i` : 'no button matching /activity/i');
  const opened = await openActivity("desktop");
  if (opened) {
    const { panel, log } = opened;
    const itemSel = log.locator(':scope > li, :scope > ol > li, :scope > ul > li, [role="listitem"], [role="article"], article');
    const t0 = Date.now();
    let nItems = 0;
    while (Date.now() - t0 < 10000) { nItems = (await itemSel.count()) || (await log.locator(":scope > *").count()); if (nItems > 0) break; await page.waitForTimeout(500); }
    check("activity: feed shows at least one item for the last demo run", nItems > 0, `role="log" has ${nItems} items after 10s`);
    const header = ((await panel.innerText().catch(() => "")) ?? "").replace(/\s+/g, " ");
    const logText = ((await log.innerText().catch(() => "")) ?? "").replace(/\s+/g, " ");
    const headText = header.replace(logText, " ");
    check("activity: header shows agent (SEO/GEO)", /\b(SEO|GEO)\b/.test(headText), `header="${headText.slice(0, 160)}"`);
    const dur = headText.match(DURATION)?.[0];
    check("activity: header shows duration/elapsed time", !!dur, dur ? `found "${dur}"` : `header="${headText.slice(0, 160)}"`);
    await shot("activity-desktop");
    await page.keyboard.press("Escape");
    const closed = await log.waitFor({ state: "hidden", timeout: 3000 }).then(() => true).catch(() => false);
    check("activity: Esc closes the panel", closed, closed ? 'role="log" hidden after Escape' : 'role="log" still visible 3s after Escape');
  } else {
    await shot("activity-desktop");
    check("activity: feed shows at least one item for the last demo run", false, "panel did not open");
    check("activity: Esc closes the panel", false, "panel did not open");
  }

  step = "activity-mobile";
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}${P}`, { waitUntil: "networkidle" });
  const openedM = await openActivity("mobile 390px");
  await page.waitForTimeout(800);
  const overflowM = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check("activity: no horizontal overflow at 390px with window open", !!openedM && !overflowM,
    openedM ? `scrollWidth=${await page.evaluate(() => document.documentElement.scrollWidth)} innerWidth=390` : "panel did not open");
  await shot("activity-mobile");
  if (openedM) await page.keyboard.press("Escape");
}

writeFileSync(`${OUT}report.json`, JSON.stringify({ base: BASE, project: P, checks, failures }, null, 2));
const passed = checks.filter((c) => c.pass).length;
console.log(`${passed}/${checks.length} checks passed; ${failures.length} failure(s). Report: e2e/output/report.json`);
for (const f of failures) console.log("FAIL", JSON.stringify(f));
await browser.close();
process.exit(failures.length ? 1 : 0);
