import { chromium } from "playwright";
const BASE = "http://localhost:5173";
const browser = await chromium.launch();
const c = await browser.newContext();
const page = await c.newPage();
await page.goto(`${BASE}/signin`, { waitUntil: "networkidle" });
const dev = page.getByRole("button", { name: /dev|local|demo/i }).first();
if (await dev.count()) await dev.click();
await page.waitForTimeout(1200);
const P = "prj_sefxxxcvlsczg6mvcqhg6k2kfq";
const get = async (p) => { const r = await c.request.get(`${BASE}/api/projects/${P}${p}`); return [r.status(), await r.json().catch(() => null)]; };
const [, cur] = await get("/activity/current");
for (const run of cur.data.runs) {
  const [, act] = await get(`/runs/${run.id}/activity?limit=200`);
  console.log(run.agent, act.data.run.startedAt, act.data.run.finishedAt);
  const [, live] = await get(`/live/${run.agent}?runId=${run.id}&limit=200`);
  const rows = [...act.data.items.map((i) => [i.at, i.kind, i.kind === "step" ? i.detail : i.title.slice(0, 50)])];
  for (const e of live.data.elements ?? []) rows.push([e.at, "EL", `${e.element} ${e.verdict} ${e.role}`]);
  for (const q of live.data.queries ?? []) rows.push([q.at, "Q", q.query ?? q.queryKey]);
  for (const r of live.data.recommendations ?? []) rows.push([r.at ?? r.createdAt, "REC", r.target ?? r.id]);
  rows.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const r of rows) console.log("  ", r.join(" | "));
}
const [, links] = await get("/seo/internal-links"); console.log("links", JSON.stringify(links).slice(0, 300));
await browser.close();
