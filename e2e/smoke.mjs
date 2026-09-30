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
  const done = page.getByLabel(/mark as done/i).first();
  if (await done.count()) {
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
}

writeFileSync(`${OUT}report.json`, JSON.stringify({ base: BASE, project: P, checks, failures }, null, 2));
const passed = checks.filter((c) => c.pass).length;
console.log(`${passed}/${checks.length} checks passed; ${failures.length} failure(s). Report: e2e/output/report.json`);
for (const f of failures) console.log("FAIL", JSON.stringify(f));
await browser.close();
process.exit(failures.length ? 1 : 0);
