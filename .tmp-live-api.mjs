import { chromium } from "playwright";
const BASE = "http://localhost:5173";
const browser = await chromium.launch();
const c = await browser.newContext();
const page = await c.newPage();
await page.goto(`${BASE}/signin`, { waitUntil: "networkidle" });
const dev = page.getByRole("button", { name: /dev|local|demo/i }).first();
if (await dev.count()) await dev.click();
await page.waitForTimeout(1500);
await page.goto(`${BASE}/projects`, { waitUntil: "networkidle" });
const hrefs = await page.locator('a[href^="/projects/prj_"]').evaluateAll((as) => as.map((a) => [a.getAttribute("href"), a.textContent]));
console.log(hrefs);
const P = hrefs.find(([h, t]) => /demo/i.test(t))[0].match(/prj_[^/?#]+/)[0];
const get = async (p) => { const r = await c.request.get(`${BASE}/api/projects/${P}${p}`); return [r.status(), await r.json().catch(() => null)]; };
const [, cur] = await get("/activity/current");
console.log("current", JSON.stringify(cur).slice(0, 600));
const runs = cur.data.runs;
for (const run of runs) {
  const [, act] = await get(`/runs/${run.id}/activity?limit=200`);
  const items = act.data.items;
  console.log(run.agent, run.id, "items", items.length, "lanes", JSON.stringify(act.data.lanes));
  for (const it of items.filter((i) => i.kind === "step")) console.log("  STEP", it.at, JSON.stringify(it.title), JSON.stringify(it.detail), it.status);
  const kinds = {}; for (const it of items) kinds[it.kind] = (kinds[it.kind] || 0) + 1; console.log("  kinds", kinds);
  const [st, live] = await get(`/live/${run.agent}?runId=${run.id}&limit=200`);
  const d = live?.data ?? live;
  console.log("  live", st, Object.keys(d || {}), JSON.stringify(d?.totals).slice(0, 900));
  if (d?.queries) console.log("  queries", d.queries.length, JSON.stringify(d.queries.slice(0, 2)));
  if (d?.answers) console.log("  answers", d.answers.length, JSON.stringify(d.answers.map((a) => [a.provider, a.outcome, a.at, a.latencyMs])));
  if (d?.elements) console.log("  elements", d.elements.length, JSON.stringify(d.elements.slice(0, 2)).slice(0, 1200));
}
for (const p of ["/geo/competitor-pages", "/geo/rewrite-plans", "/seo/buyer-queries"]) { const [s, j] = await get(p); console.log(p, s, JSON.stringify(j).slice(0, 500)); }
await browser.close();
