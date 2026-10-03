/**
 * Internal-links workbench, item 8: export in the owner's sheet format. Exact headers
 * "Date","Source Article URL","Target URL","Anchor","Method","Hub","Status"; UTF-8 with BOM; RFC 4180 quoting and
 * formula-safe cells; method/hub/status mapping; filtering by selection and status (route and service).
 */
import { afterEach, describe, expect, it } from "vitest";
import type { LinkSuggestion, LinkSuggestionReport } from "@shared/types";
import { createApp } from "@worker/app";
import { Db } from "@worker/lib/db";
import { SHEET_COLUMNS, sheetCsv, sheetHub, sheetStatus, type SheetRowSource } from "@worker/links/report";
import { setLinkDecisionsFactory, setLinkWriterFactory } from "@worker/routes/links";
import { createTestEnv } from "./helpers/env";
import { authHeaders, seedProject, seedUser } from "./helpers/fixtures";
import { STORE, U, seedLinkCrawl } from "./links-seed";

afterEach(() => {
  setLinkDecisionsFactory(null);
  setLinkWriterFactory(null);
});

const BOM = String.fromCharCode(0xfeff);

function row(over: Partial<SheetRowSource> = {}): SheetRowSource {
  return {
    id: "lsug_1",
    source: { pageId: "a", url: "https://shop.example.com/blogs/news/brass-care", title: null },
    target: { pageId: "b", url: "https://shop.example.com/collections/pulls", title: null, inlinks: 0, orphan: false },
    sentence: { index: 0, text: "x" },
    anchor: { text: "brass cabinet pulls" },
    role: null,
    method: "deterministic",
    decision: null,
    status: "review",
    score: 1,
    reasons: [],
    userStatus: "open",
    dateIso: "2026-09-30T12:00:00.000Z",
    ...over,
  } as SheetRowSource;
}

describe("sheet CSV", () => {
  it("writes the exact headers with a UTF-8 BOM and CRLF lines", () => {
    expect([...SHEET_COLUMNS]).toEqual(["Date", "Source Article URL", "Target URL", "Anchor", "Method", "Hub", "Status"]);
    const csv = sheetCsv([]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toBe(`${BOM}Date,Source Article URL,Target URL,Anchor,Method,Hub,Status\r\n`);
    const bytes = new TextEncoder().encode(csv);
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it("maps method, hub and status, and escapes quotes, commas, line breaks and formulas", () => {
    const lines = sheetCsv([
      row({ placement: "existing_sentence", cluster: { hubUrl: "https://shop.example.com/collections/chandeliers", hubTitle: "Chandeliers", gap: "hub_to_spoke" } }),
      row({
        id: "lsug_2",
        placement: "draft_sentence",
        anchor: { text: 'brass "unlacquered", pulls\nnew' },
        userStatus: "implemented",
        dateIso: "2026-10-01T09:00:00.000Z",
        verification: { status: "verified", checkedAt: "2026-10-02T10:00:00.000Z", matchedVia: "target", detail: null, label: "verified on 2026-10-02" },
        cluster: { hubUrl: "https://shop.example.com/pages/lighting-guide", hubTitle: null, gap: null },
      }),
      row({ id: "lsug_3", anchor: { text: "=HYPERLINK(\"http://x\")" }, userStatus: "accepted", verification: { status: "not_found", checkedAt: "2026-10-02T10:00:00.000Z", matchedVia: null, detail: null, label: "" } }),
    ]).split("\r\n");
    expect(lines[0]).toBe(`${BOM}Date,Source Article URL,Target URL,Anchor,Method,Hub,Status`);
    expect(lines[1]).toBe("2026-09-30,https://shop.example.com/blogs/news/brass-care,https://shop.example.com/collections/pulls,brass cabinet pulls,wrap existing,chandeliers,Review");
    // The embedded line break (LF) stays inside one quoted cell; rows end with CRLF.
    expect(lines[2]).toBe(
      '2026-10-01,https://shop.example.com/blogs/news/brass-care,https://shop.example.com/collections/pulls,"brass ""unlacquered"", pulls\nnew",insert PK sentence,/pages/lighting-guide,Implemented · verified 2026-10-02',
    );
    expect(lines[3]).toBe('2026-09-30,https://shop.example.com/blogs/news/brass-care,https://shop.example.com/collections/pulls,"\'=HYPERLINK(""http://x"")",wrap existing,,Accepted · not found in crawl 2026-10-02');
    expect(lines[4]).toBe("");
    expect(lines).toHaveLength(5);
  });

  it("status and hub cells", () => {
    expect(sheetHub(null)).toBe("");
    expect(sheetHub("https://shop.example.com/collections/wall-sconces")).toBe("wall-sconces");
    const s = (over: Partial<LinkSuggestion>) => sheetStatus(row(over));
    expect(s({ status: "suggested" })).toBe("Suggested");
    expect(s({ status: "rejected" })).toBe("Rejected");
    expect(s({ userStatus: "dismissed" })).toBe("Dismissed");
    expect(s({ userStatus: "implemented", verification: { status: "pending", checkedAt: null, matchedVia: null, detail: null, label: "" } })).toBe("Implemented · pending crawl");
    expect(s({ userStatus: "implemented", verification: { status: "source_unavailable", checkedAt: "2026-10-02T00:00:00.000Z", matchedVia: null, detail: null, label: "" } })).toBe("Implemented · source unavailable 2026-10-02");
  });
});

describe("sheet export route", () => {
  async function setup() {
    const env = createTestEnv();
    const user = await seedUser(env);
    const projectId = await seedProject(env, user.workspaceId);
    const db = new Db(env.DB);
    await seedLinkCrawl(db, user.workspaceId, projectId, STORE);
    const app = createApp();
    const H = authHeaders(user.sessionToken, user.csrfToken);
    const base = `/api/projects/${projectId}/seo/internal-links`;
    setLinkDecisionsFactory(async () => null);
    setLinkWriterFactory(async () => null);
    const run = ((await (await app.request(`${base}/run`, { method: "POST", headers: H }, env)).json()) as { data: LinkSuggestionReport }).data;
    return { env, db, app, H, base, user, projectId, run };
  }

  it("downloads the selection or a status filter in the sheet format", async () => {
    const { env, app, H, base, run } = await setup();
    expect(run.suggestions.length).toBeGreaterThan(2);
    const all = await app.request(`${base}/export?format=sheet`, { headers: H }, env);
    expect(all.status).toBe(200);
    expect(all.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(all.headers.get("content-disposition")).toMatch(/^attachment; filename="internal-links-sheet-shop\.example\.com-\d{4}-\d{2}-\d{2}\.csv"$/);
    const buf = new Uint8Array(await all.arrayBuffer());
    expect([...buf.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder("utf-8", { ignoreBOM: true, fatal: false }).decode(buf);
    const lines = text.split("\r\n").filter(Boolean);
    expect(lines[0]).toBe(`${BOM}Date,Source Article URL,Target URL,Anchor,Method,Hub,Status`);
    expect(lines).toHaveLength(1 + run.suggestions.filter((s) => s.status !== "rejected").length);

    // Selection.
    const [a, b] = run.suggestions;
    const sel = await (await app.request(`${base}/export?format=sheet&ids=${a!.id},${b!.id}`, { headers: H }, env)).text();
    const selLines = sel.split("\r\n").filter(Boolean);
    expect(selLines).toHaveLength(3);
    expect(selLines.slice(1).map((l) => l.split(",")[1]).sort()).toEqual([a!.source.url, b!.source.url].sort());

    // Status filter: mark one implemented, export only implemented rows.
    expect((await app.request(`${base}/${a!.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ userStatus: "implemented" }) }, env)).status).toBe(200);
    const impl = (await (await app.request(`${base}/export?format=sheet&userStatus=implemented`, { headers: H }, env)).text()).split("\r\n").filter(Boolean);
    expect(impl).toHaveLength(2);
    expect(impl[1]).toContain(a!.target.url);
    expect(impl[1]).toMatch(/,wrap existing,/);
    expect(impl[1]).toMatch(/,Implemented$/);

    // Dismissed rows are left out of the default sheet export.
    expect((await app.request(`${base}/${b!.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ userStatus: "dismissed" }) }, env)).status).toBe(200);
    const def = (await (await app.request(`${base}/export?format=sheet`, { headers: H }, env)).text()).split("\r\n").filter(Boolean);
    expect(def.some((l) => l.includes(",Dismissed"))).toBe(false);

    // Validation.
    expect((await app.request(`${base}/export?format=xlsx`, { headers: H }, env)).status).toBe(400);
    expect((await app.request(`${base}/export?format=sheet&userStatus=done`, { headers: H }, env)).status).toBe(400);
    expect((await app.request(`${base}/export?format=sheet&placement=elsewhere`, { headers: H }, env)).status).toBe(400);
    const many = Array.from({ length: 501 }, (_, i) => `lsug_${i}`).join(",");
    expect((await app.request(`${base}/export?format=sheet&ids=${many}`, { headers: H }, env)).status).toBe(400);

    // The legacy CSV keeps its header.
    const legacy = await (await app.request(`${base}/export?format=csv`, { headers: H }, env)).text();
    expect(legacy.split("\r\n")[0]).toBe("source_url,target_url,anchor,sentence,role,status,tier,should_exist,sentence_confidence,anchor_confidence,role_confidence");
  });

  it("never exports another workspace's suggestions", async () => {
    const { env, app, base, run } = await setup();
    const intruder = await seedUser(env);
    const IH = authHeaders(intruder.sessionToken, intruder.csrfToken);
    expect((await app.request(`${base}/export?format=sheet`, { headers: IH }, env)).status).toBe(404);
    const own = await seedProject(env, intruder.workspaceId);
    const res = await app.request(`/api/projects/${own}/seo/internal-links/export?format=sheet&ids=${run.suggestions[0]!.id}`, { headers: IH }, env);
    expect(res.status).toBe(200);
    expect((await res.text()).split("\r\n").filter(Boolean)).toHaveLength(1);
    expect(U("/")).toBeTruthy();
  });
});
