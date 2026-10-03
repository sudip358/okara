/**
 * Rolling crawl (internal-links workbench 2026-10-03, item 1). Each SEO run crawls the next batch of the site
 * within the existing per-run page cap (project_limits.crawl_pages), so successive runs cover the whole sitemap
 * and the link graph can use the latest snapshot of every page.
 *
 * Inventory (`crawl_inventory`): every URL the crawl knows: sitemap URLs (read with larger bounded caps than the
 * audit's sitemap parse: INVENTORY_MAX_CHILDREN sitemap files, INVENTORY_MAX_URLS URLs), internal-link targets
 * discovered on crawled pages (at most MAX_DISCOVERED_PER_CRAWL new ones per crawl), and the home page. `ord` is
 * the insertion order (sitemap order at first sight) and the round-robin order. Total: at most INVENTORY_MAX_URLS
 * per project. A sitemap that could not be read (no file fetched) or was truncated never marks URLs as removed.
 *
 * Batch order (ROLLING_VERSION, `rollingOrder`, pure): the home page first (the crawl root), then
 *   1. never-crawled URLs: Search Console impressions (latest stored sync, current window) desc, sitemap URLs
 *      before link-discovered ones, then round-robin from the stored cursor (ord after the cursor first);
 *   2. previously crawled URLs: oldest crawl first, then impressions desc, then round-robin from the cursor.
 * The crawler takes URLs in this order until its page cap; links discovered on crawled pages are only crawled in
 * the same run when the inventory is exhausted (small sites behave as before). After the crawl the cursor moves
 * to the last inventory URL dispatched; `passes` counts wrap-arounds.
 *
 * Snapshot retention (`pruneSnapshots`, bounded): every snapshot of the project's KEEP_RECENT_CRAWLS latest crawl
 * runs is kept intact; outside them each page keeps its latest usable snapshot (completed/partial crawl) in full
 * and its previous one compacted (heavy evidence columns cleared, status/hashes/title/dates kept for change
 * history); anything older is deleted. So a project holds at most (pages + recent crawl pages) full snapshots plus
 * one compact row per page. At most PRUNE_MAX_ROWS rows are changed per crawl (the rest on the next crawl).
 *
 * Every query filters by workspace_id and project_id; statements stay under D1's 100-parameter limit.
 */
import type { Db } from "../../lib/db";
import { sha256Hex } from "../../lib/hash";
import { iso } from "../../lib/time";
import { chunks, IN_CHUNK, multiRowInsert, placeholders, runBatches } from "../../links/sql";
import { normalizeUrlKey } from "../rules/registry";

export const ROLLING_VERSION = "rolling-crawl-2026-10-03.1";
export const INVENTORY_MAX_URLS = 10_000;
export const INVENTORY_MAX_CHILDREN = 25;
export const MAX_DISCOVERED_PER_CRAWL = 1_000;
export const KEEP_RECENT_CRAWLS = 7;
export const PRUNE_MAX_ROWS = 2_000;
const INVENTORY_PAGE = 2_500;

export interface ProjectScope {
  id: string;
  workspaceId: string;
}

export interface InventoryRow {
  urlKey: string;
  url: string;
  ord: number;
  source: "sitemap" | "link" | "home";
  inSitemap: boolean;
  lastCrawledAt: string | null;
}

export interface InventoryState {
  sitemapHash: string | null;
  sitemapUrls: number;
  sitemapTruncated: boolean;
  sitemapReadAt: string | null;
  nextOrd: number;
  cursorOrd: number | null;
  passes: number;
}

const EMPTY_STATE: InventoryState = { sitemapHash: null, sitemapUrls: 0, sitemapTruncated: false, sitemapReadAt: null, nextOrd: 0, cursorOrd: null, passes: 0 };

export async function loadInventoryState(db: Db, p: ProjectScope): Promise<InventoryState> {
  const r = await db.first<{ sitemap_hash: string | null; sitemap_urls: number; sitemap_truncated: number; sitemap_read_at: string | null; next_ord: number; cursor_ord: number | null; passes: number }>(
    "SELECT sitemap_hash, sitemap_urls, sitemap_truncated, sitemap_read_at, next_ord, cursor_ord, passes FROM crawl_inventory_state WHERE workspace_id = ? AND project_id = ?",
    p.workspaceId,
    p.id,
  );
  if (!r) return { ...EMPTY_STATE };
  return {
    sitemapHash: r.sitemap_hash,
    sitemapUrls: Number(r.sitemap_urls) || 0,
    sitemapTruncated: Number(r.sitemap_truncated) === 1,
    sitemapReadAt: r.sitemap_read_at,
    nextOrd: Number(r.next_ord) || 0,
    cursorOrd: r.cursor_ord === null || r.cursor_ord === undefined ? null : Number(r.cursor_ord),
    passes: Number(r.passes) || 0,
  };
}

async function saveInventoryState(db: Db, p: ProjectScope, s: InventoryState, now: Date): Promise<void> {
  await db.run(
    `INSERT INTO crawl_inventory_state (project_id, workspace_id, sitemap_hash, sitemap_urls, sitemap_truncated, sitemap_read_at, next_ord, cursor_ord, passes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET sitemap_hash = excluded.sitemap_hash, sitemap_urls = excluded.sitemap_urls,
       sitemap_truncated = excluded.sitemap_truncated, sitemap_read_at = excluded.sitemap_read_at, next_ord = excluded.next_ord,
       cursor_ord = excluded.cursor_ord, passes = excluded.passes, updated_at = excluded.updated_at
     WHERE crawl_inventory_state.workspace_id = excluded.workspace_id`,
    p.id,
    p.workspaceId,
    s.sitemapHash,
    s.sitemapUrls,
    s.sitemapTruncated ? 1 : 0,
    s.sitemapReadAt,
    s.nextOrd,
    s.cursorOrd,
    s.passes,
    iso(now),
  );
}

/** Inventory rows in ord order, keyset-paged (bounded by INVENTORY_MAX_URLS). */
export async function loadInventory(db: Db, p: ProjectScope, max = INVENTORY_MAX_URLS): Promise<InventoryRow[]> {
  const out: InventoryRow[] = [];
  let after = -1;
  while (out.length < max) {
    const rows = await db.all<{ url_key: string; url: string; ord: number; source: InventoryRow["source"]; in_sitemap: number; last_crawled_at: string | null }>(
      `SELECT url_key, url, ord, source, in_sitemap, last_crawled_at FROM crawl_inventory
        WHERE workspace_id = ? AND project_id = ? AND ord > ? ORDER BY ord LIMIT ?`,
      p.workspaceId,
      p.id,
      after,
      Math.min(INVENTORY_PAGE, max - out.length),
    );
    for (const r of rows) {
      out.push({ urlKey: r.url_key, url: r.url, ord: Number(r.ord), source: r.source, inSitemap: Number(r.in_sitemap) === 1, lastCrawledAt: r.last_crawled_at });
    }
    if (rows.length < INVENTORY_PAGE) break;
    after = Number(rows[rows.length - 1]!.ord);
  }
  return out;
}

export interface SitemapRead {
  urls: string[];
  entries: Array<{ url: string; lastmod: string | null }>;
  source: Map<string, string>;
  /** Sitemap files actually read (0 = the sitemap could not be read: nothing is marked removed). */
  fetchedCount: number;
  /** The read stopped at a cap: URLs missing from it are not marked removed. */
  truncated: boolean;
}

export interface InventoryRefresh {
  rows: InventoryRow[];
  state: InventoryState;
  added: number;
  removed: number;
  relisted: number;
  notes: string[];
}

/**
 * Sync the inventory with a sitemap read. Unchanged sitemap (same hash of its URL keys) = no writes. New URLs are
 * appended in sitemap order; their last crawl time is seeded from `pages.last_crawled_at` when the page was crawled
 * before the inventory existed.
 */
export async function refreshInventory(db: Db, p: ProjectScope, sitemap: SitemapRead, homeUrl: string, now: Date): Promise<InventoryRefresh> {
  const state = await loadInventoryState(db, p);
  let rows = await loadInventory(db, p);
  const notes: string[] = [];
  const listed: Array<{ key: string; url: string; file: string | null; lastmod: string | null }> = [];
  const seen = new Set<string>();
  const lastmodOf = new Map(sitemap.entries.map((e) => [e.url, e.lastmod]));
  for (const u of sitemap.urls) {
    const key = normalizeUrlKey(u);
    if (seen.has(key)) continue;
    seen.add(key);
    listed.push({ key, url: u, file: sitemap.source.get(u) ?? null, lastmod: lastmodOf.get(u) ?? null });
  }
  const homeKey = normalizeUrlKey(homeUrl);
  // A capped read hashes differently, so the next complete read of the same URLs still applies removals.
  const hash = sitemap.fetchedCount > 0 ? (await sha256Hex(`${sitemap.truncated ? "truncated\n" : ""}${[...seen].sort().join("\n")}`)).slice(0, 32) : null;
  const byKey = new Map(rows.map((r) => [r.urlKey, r]));
  const nowIso = iso(now);
  let added = 0;
  let removed = 0;
  let relisted = 0;

  const unchanged = hash !== null && hash === state.sitemapHash && rows.length > 0;
  if (sitemap.fetchedCount === 0) notes.push("Rolling crawl: no sitemap could be read this time, so the inventory was not changed.");
  if (!unchanged && sitemap.fetchedCount > 0) {
    const fresh = listed.filter((l) => !byKey.has(l.key));
    const capacity = Math.max(0, INVENTORY_MAX_URLS - rows.length);
    const toAdd = fresh.slice(0, capacity);
    if (fresh.length > toAdd.length) notes.push(`Rolling crawl inventory is capped at ${INVENTORY_MAX_URLS.toLocaleString("en-US")} URLs; ${fresh.length - toAdd.length} new sitemap URLs were not added.`);
    let crawledBefore = new Map<string, string>();
    if (toAdd.length > 0) crawledBefore = await pagesCrawledAt(db, p);
    let ord = Math.max(state.nextOrd, rows.length ? rows[rows.length - 1]!.ord + 1 : 0);
    const insertRows: unknown[][] = [];
    for (const l of toAdd) {
      const last = crawledBefore.get(l.key) ?? null;
      const source: InventoryRow["source"] = l.key === homeKey ? "home" : "sitemap";
      insertRows.push([p.workspaceId, p.id, l.key, l.url.slice(0, 2048), ord, source, 1, l.file, l.lastmod, nowIso, last]);
      const row: InventoryRow = { urlKey: l.key, url: l.url, ord, source, inSitemap: true, lastCrawledAt: last };
      rows.push(row);
      byKey.set(l.key, row);
      ord++;
      added++;
    }
    const stmts: Array<[string, ...unknown[]]> = multiRowInsert(
      "crawl_inventory",
      ["workspace_id", "project_id", "url_key", "url", "ord", "source", "in_sitemap", "sitemap_file", "lastmod", "first_seen_at", "last_crawled_at"],
      insertRows,
      "ON CONFLICT(project_id, url_key) DO NOTHING",
    );
    // Listed again after being removed, or first listed after being discovered as a link target.
    const relist = listed.filter((l) => {
      const r = byKey.get(l.key);
      return !!r && !r.inSitemap;
    });
    for (const part of chunks(relist, IN_CHUNK)) {
      stmts.push([
        `UPDATE crawl_inventory SET in_sitemap = 1, removed_from_sitemap_at = NULL WHERE workspace_id = ? AND project_id = ? AND url_key IN (${placeholders(part.length)})`,
        p.workspaceId,
        p.id,
        ...part.map((l) => l.key),
      ]);
      for (const l of part) byKey.get(l.key)!.inSitemap = true;
      relisted += part.length;
    }
    if (!sitemap.truncated) {
      const gone = rows.filter((r) => r.inSitemap && !seen.has(r.urlKey));
      for (const part of chunks(gone, IN_CHUNK)) {
        stmts.push([
          `UPDATE crawl_inventory SET in_sitemap = 0, removed_from_sitemap_at = ? WHERE workspace_id = ? AND project_id = ? AND url_key IN (${placeholders(part.length)})`,
          nowIso,
          p.workspaceId,
          p.id,
          ...part.map((r) => r.urlKey),
        ]);
        for (const r of part) r.inSitemap = false;
        removed += part.length;
      }
    } else {
      notes.push("The sitemap read stopped at a cap; URLs missing from it were not marked as removed.");
    }
    await runBatches(db, stmts);
    state.nextOrd = ord;
    state.sitemapHash = hash;
    state.sitemapUrls = listed.length;
    state.sitemapTruncated = sitemap.truncated;
    state.sitemapReadAt = nowIso;
  }
  // The crawl root is always known (never-crawled sites have no sitemap at all).
  if (!byKey.has(homeKey) && rows.length < INVENTORY_MAX_URLS) {
    const ord = Math.max(state.nextOrd, rows.length ? rows[rows.length - 1]!.ord + 1 : 0);
    await db.run(
      `INSERT INTO crawl_inventory (workspace_id, project_id, url_key, url, ord, source, in_sitemap, first_seen_at) VALUES (?, ?, ?, ?, ?, 'home', 0, ?)
       ON CONFLICT(project_id, url_key) DO NOTHING`,
      p.workspaceId,
      p.id,
      homeKey,
      homeUrl,
      ord,
      nowIso,
    );
    const row: InventoryRow = { urlKey: homeKey, url: homeUrl, ord, source: "home", inSitemap: false, lastCrawledAt: null };
    rows.push(row);
    byKey.set(homeKey, row);
    state.nextOrd = ord + 1;
  }
  if (!unchanged) await saveInventoryState(db, p, state, now);
  rows = rows.sort((a, b) => a.ord - b.ord);
  return { rows, state, added, removed, relisted, notes };
}

async function pagesCrawledAt(db: Db, p: ProjectScope): Promise<Map<string, string>> {
  const rows = await db.all<{ url: string; last_crawled_at: string }>(
    `SELECT url, last_crawled_at FROM pages WHERE workspace_id = ? AND project_id = ? AND last_crawled_at IS NOT NULL LIMIT ${INVENTORY_MAX_URLS * 2}`,
    p.workspaceId,
    p.id,
  );
  const out = new Map<string, string>();
  for (const r of rows) {
    const k = normalizeUrlKey(r.url);
    const prev = out.get(k);
    if (!prev || r.last_crawled_at > prev) out.set(k, r.last_crawled_at);
  }
  return out;
}

/**
 * The rolling batch order (see the module header). Pure; `impressions` maps URL keys to current-window Search
 * Console impressions (null = no Search Console data). The home page is excluded (the crawler queues it first).
 */
export function rollingOrder(rows: readonly InventoryRow[], opts: { impressions: ReadonlyMap<string, number> | null; cursorOrd: number | null; homeKey?: string | null }): InventoryRow[] {
  const cursor = opts.cursorOrd ?? -1;
  const imp = (r: InventoryRow) => opts.impressions?.get(r.urlKey) ?? 0;
  const rot = (ord: number) => (ord > cursor ? 0 : 1);
  return rows
    .filter((r) => r.urlKey !== opts.homeKey)
    .slice()
    .sort((a, b) => {
      const ta = a.lastCrawledAt ? 1 : 0;
      const tb = b.lastCrawledAt ? 1 : 0;
      if (ta !== tb) return ta - tb;
      if (ta === 1 && a.lastCrawledAt !== b.lastCrawledAt) return a.lastCrawledAt! < b.lastCrawledAt! ? -1 : 1;
      const ia = imp(a);
      const ib = imp(b);
      if (ia !== ib) return ib - ia;
      if (ta === 0 && a.inSitemap !== b.inSitemap) return a.inSitemap ? -1 : 1;
      const ra = rot(a.ord);
      const rb = rot(b.ord);
      if (ra !== rb) return ra - rb;
      return a.ord - b.ord;
    });
}

export interface CrawlRecordInput {
  crawlRunId: string;
  /** One timestamp for the whole crawl (crawl start), so a batch shares its "last crawled" time. */
  crawledAt: string;
  /** Every URL the crawl recorded a snapshot for (fetched, redirected, errored or skipped). */
  recordedUrls: readonly string[];
  /** Internal link targets found on crawled pages (already checked crawlable on the verified host). */
  linkTargets: readonly string[];
  /** Inventory URLs in the order the crawl dispatched them. */
  dispatched: readonly string[];
  /** The rolling order the crawl used (for the cursor). */
  ordered: readonly InventoryRow[];
  inventoryKeys: ReadonlySet<string>;
  state: InventoryState;
  homeUrl: string;
}

/**
 * Post-crawl bookkeeping: last crawl time for every recorded URL, new inventory rows for recorded or discovered
 * URLs, and the round-robin cursor. Returns how many URLs were added.
 */
export async function recordRollingCrawl(db: Db, p: ProjectScope, input: CrawlRecordInput, now: Date): Promise<{ updated: number; discovered: number; cursorOrd: number | null; passes: number }> {
  const recordedKeys = new Map<string, string>();
  for (const u of input.recordedUrls) recordedKeys.set(normalizeUrlKey(u), u);
  const stmts: Array<[string, ...unknown[]]> = [];
  const known = [...recordedKeys.keys()].filter((k) => input.inventoryKeys.has(k));
  for (const part of chunks(known, IN_CHUNK - 2)) {
    stmts.push([
      `UPDATE crawl_inventory SET last_crawled_at = ?, last_crawl_run_id = ? WHERE workspace_id = ? AND project_id = ? AND url_key IN (${placeholders(part.length)})`,
      input.crawledAt,
      input.crawlRunId,
      p.workspaceId,
      p.id,
      ...part,
    ]);
  }
  const state = { ...input.state };
  let ord = state.nextOrd;
  const capacity = Math.max(0, INVENTORY_MAX_URLS - input.inventoryKeys.size);
  const homeKey = normalizeUrlKey(input.homeUrl);
  const insertRows: unknown[][] = [];
  const added = new Set<string>();
  const nowIso = iso(now);
  for (const [key, url] of recordedKeys) {
    if (input.inventoryKeys.has(key) || added.size >= capacity) continue;
    added.add(key);
    insertRows.push([p.workspaceId, p.id, key, url.slice(0, 2048), ord++, key === homeKey ? "home" : "link", 0, nowIso, input.crawledAt, input.crawlRunId]);
  }
  let discovered = 0;
  for (const url of input.linkTargets) {
    if (discovered >= MAX_DISCOVERED_PER_CRAWL || added.size >= capacity) break;
    const key = normalizeUrlKey(url);
    if (input.inventoryKeys.has(key) || added.has(key)) continue;
    added.add(key);
    discovered++;
    insertRows.push([p.workspaceId, p.id, key, url.slice(0, 2048), ord++, "link", 0, nowIso, null, null]);
  }
  stmts.push(
    ...multiRowInsert(
      "crawl_inventory",
      ["workspace_id", "project_id", "url_key", "url", "ord", "source", "in_sitemap", "first_seen_at", "last_crawled_at", "last_crawl_run_id"],
      insertRows,
      "ON CONFLICT(project_id, url_key) DO NOTHING",
    ),
  );
  // Cursor: the last inventory URL dispatched, in rolling order.
  const dispatchedKeys = new Set(input.dispatched.map((u) => normalizeUrlKey(u)));
  let cursor: number | null = state.cursorOrd;
  for (let i = input.ordered.length - 1; i >= 0; i--) {
    const r = input.ordered[i]!;
    if (dispatchedKeys.has(r.urlKey)) {
      if (state.cursorOrd !== null && r.ord <= state.cursorOrd) state.passes += 1;
      cursor = r.ord;
      break;
    }
  }
  state.cursorOrd = cursor;
  state.nextOrd = ord;
  await runBatches(db, stmts);
  await saveInventoryState(db, p, state, now);
  return { updated: known.length, discovered: added.size, cursorOrd: cursor, passes: state.passes };
}

export interface PruneResult {
  compacted: number;
  deleted: number;
  /** More rows qualified than PRUNE_MAX_ROWS; the rest are handled by the next crawl. */
  more: boolean;
}

/** Bounded snapshot retention (see the module header). */
export async function pruneSnapshots(db: Db, p: ProjectScope, now: Date, opts: { keepRecentCrawls?: number; maxRows?: number } = {}): Promise<PruneResult> {
  const keep = Math.max(1, Math.floor(opts.keepRecentCrawls ?? KEEP_RECENT_CRAWLS));
  const maxRows = Math.max(1, Math.floor(opts.maxRows ?? PRUNE_MAX_ROWS));
  const recent = await db.all<{ id: string }>(
    "SELECT id FROM crawl_runs WHERE workspace_id = ? AND project_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?",
    p.workspaceId,
    p.id,
    keep,
  );
  if (recent.length < keep) return { compacted: 0, deleted: 0, more: false };
  const recentIds = recent.map((r) => r.id);
  const rows = await db.all<{ id: string; rk: number; usable: number; compacted: number }>(
    `SELECT id, rk, usable, compacted FROM (
       SELECT s.id, s.crawl_run_id, CASE WHEN c.status IN ('completed', 'partial') THEN 1 ELSE 0 END AS usable,
              CASE WHEN s.compacted_at IS NULL THEN 0 ELSE 1 END AS compacted,
              ROW_NUMBER() OVER (PARTITION BY s.page_id
                                 ORDER BY CASE WHEN c.status IN ('completed', 'partial') THEN 0 ELSE 1 END, s.fetched_at DESC, s.rowid DESC) AS rk
         FROM crawl_runs c JOIN page_snapshots s ON s.crawl_run_id = c.id AND s.workspace_id = c.workspace_id AND s.project_id = c.project_id
        WHERE c.workspace_id = ? AND c.project_id = ?)
      WHERE rk >= 2 AND crawl_run_id NOT IN (${placeholders(recentIds.length)}) AND NOT (rk = 2 AND usable = 1 AND compacted = 1)
      LIMIT ?`,
    p.workspaceId,
    p.id,
    ...recentIds,
    maxRows + 1,
  );
  const more = rows.length > maxRows;
  const work = rows.slice(0, maxRows);
  const compact = work.filter((r) => Number(r.rk) === 2 && Number(r.usable) === 1 && Number(r.compacted) === 0).map((r) => r.id);
  const drop = work.filter((r) => !(Number(r.rk) === 2 && Number(r.usable) === 1)).map((r) => r.id);
  const stmts: Array<[string, ...unknown[]]> = [];
  const nowIso = iso(now);
  for (const part of chunks(compact, IN_CHUNK)) {
    stmts.push([
      `UPDATE page_snapshots SET internal_links_json = '[]', link_anchors_json = NULL, link_context_json = '[]', headings_json = '[]',
              main_text_excerpt = NULL, first_paragraph = NULL, jsonld_issues_json = '[]', generic_anchors_json = NULL,
              meta_description = NULL, images_total = NULL, images_missing_alt = NULL, compacted_at = ?
        WHERE workspace_id = ? AND project_id = ? AND id IN (${placeholders(part.length)})`,
      nowIso,
      p.workspaceId,
      p.id,
      ...part,
    ]);
  }
  for (const part of chunks(drop, IN_CHUNK)) {
    stmts.push([`DELETE FROM page_snapshots WHERE workspace_id = ? AND project_id = ? AND id IN (${placeholders(part.length)})`, p.workspaceId, p.id, ...part]);
  }
  await runBatches(db, stmts);
  return { compacted: compact.length, deleted: drop.length, more };
}
