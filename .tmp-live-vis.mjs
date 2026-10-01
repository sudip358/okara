import { chromium } from "playwright";
const BASE = "http://localhost:5173";
const OUT = "/tmp/claude-0/-home-user-okara/1afda668-17c1-5634-8ee9-f007318db2a1/scratchpad/live/f-";
import { mkdirSync } from "node:fs";
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const log = (...a) => console.log(...a);

async function ctx(opts) {
  const c = await browser.newContext(opts);
  const p = await c.newPage();
  p.on("pageerror", (e) => log("PAGEERROR", e.message));
  p.on("console", (m) => { if (m.type() === "error") log("CONSOLE", m.text().slice(0, 200)); });
  return [c, p];
}

const [c1, page] = await ctx({ viewport: { width: 1600, height: 1000 } });
await page.goto(`${BASE}/signin`, { waitUntil: "networkidle" });
const dev = page.getByRole("button", { name: /dev|local|demo/i }).first();
if (await dev.count()) await dev.click();
await page.waitForTimeout(1500);
await page.goto(`${BASE}/projects`, { waitUntil: "networkidle" });
let P = null;
const demoLink = page.locator('a[href^="/projects/prj_"]').filter({ hasText: /demo/i }).first();
if (false) {
  P = (await demoLink.getAttribute("href")).match(/\/projects\/prj_[^/?#]+/)[0];
} else {
  await page.getByRole("button", { name: /load demo project/i }).click();
  await page.waitForURL(/\/projects\/prj_/, { timeout: 30000 });
  P = page.url().replace(BASE, "").match(/\/projects\/prj_[^/?#]+/)[0];
}
log("project", P);
const storage = await c1.storageState();
{
  const [ct, tall] = await ctx({ viewport: { width: 1600, height: 2300 }, storageState: storage });
  for (const mode of ["seo", "geo"]) {
    await openLive(tall, mode);
    for (const [i, ms] of [[1, 300], [2, 700], [3, 1000], [4, 1000], [5, 1500], [6, 2500]]) {
      await tall.waitForTimeout(ms);
      const rt = await tall.locator("text=/Run time/").first().textContent().catch(() => "");
      log(mode, "frame", i, rt);
      await shoot(tall, `${mode}-tall-${i}`);
    }
  }
  await ct.close();
}

async function shoot(p, name, fullPage = false) {
  await p.screenshot({ path: `${OUT}${name}.png`, fullPage });
  log("shot", name);
}
async function openLive(p, mode) {
  const t0 = Date.now();
  await p.goto(`${BASE}${P}/live?mode=${mode}`, { waitUntil: "domcontentloaded" });
  await p.getByRole("toolbar", { name: /replay controls/i }).first().waitFor({ timeout: 30000 }).catch(() => log("no replay toolbar", mode));
  return t0;
}
async function metrics(p, tag) {
  const m = await p.evaluate(() => {
    const sections = [...document.querySelectorAll("section")].map((s) => {
      const h = s.querySelector("h2,h3");
      const r = s.getBoundingClientRect();
      return { h: h ? h.textContent.trim().slice(0, 70) : "(no heading)", x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), hgt: Math.round(r.height), txt: s.innerText.replace(/\s+/g, " ").slice(0, 160) };
    });
    return { overflowX: document.documentElement.scrollWidth > window.innerWidth + 1, scrollW: document.documentElement.scrollWidth, docH: document.documentElement.scrollHeight, sections };
  });
  log(tag, JSON.stringify(m, null, 1));
}

// Desktop light SEO
await openLive(page, "seo");
await page.waitForTimeout(1000); await shoot(page, "seo-desk-1s");
await page.waitForTimeout(3000); await shoot(page, "seo-desk-4s");
await page.waitForTimeout(6000); await shoot(page, "seo-desk-10s");
await metrics(page, "SEO-desktop");
await shoot(page, "seo-desk-full", true);
// Desktop light GEO
await openLive(page, "geo");
await page.waitForTimeout(1000); await shoot(page, "geo-desk-1s");
await page.waitForTimeout(3000); await shoot(page, "geo-desk-4s");
await page.waitForTimeout(6000); await shoot(page, "geo-desk-10s");
await metrics(page, "GEO-desktop");
await shoot(page, "geo-desk-full", true);

// Dark
const [c2, dark] = await ctx({ viewport: { width: 1600, height: 1000 }, colorScheme: "dark", storageState: storage });
await openLive(dark, "seo");
await dark.waitForTimeout(5000); await shoot(dark, "seo-dark-5s"); await shoot(dark, "seo-dark-full", true);
await openLive(dark, "geo");
await dark.waitForTimeout(5000); await shoot(dark, "geo-dark-5s"); await shoot(dark, "geo-dark-full", true);

// Mobile
const [c3, mob] = await ctx({ viewport: { width: 390, height: 900 }, storageState: storage, isMobile: true, hasTouch: true });
await openLive(mob, "seo");
await mob.waitForTimeout(6000); await shoot(mob, "seo-mob"); await metrics(mob, "SEO-mobile"); await shoot(mob, "seo-mob-full", true);
await openLive(mob, "geo");
await mob.waitForTimeout(6000); await shoot(mob, "geo-mob"); await metrics(mob, "GEO-mobile"); await shoot(mob, "geo-mob-full", true);

await browser.close();
