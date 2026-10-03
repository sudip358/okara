/**
 * Auto-verification of placed links (internal-links workbench 2026-10-03, item 7).
 *
 * Expected links: suggestions the owner accepted or marked implemented (since = when the status was set), and links
 * the imported sheet says are placed (since = the sheet's Date cell when it parses, else the import time). One
 * expectation per (source, target) pair; the earliest "since" wins and every origin is kept.
 *
 * Check (VERIFY_VERSION), against the latest snapshot of the source page in the link graph:
 *   pending             the source has no snapshot, or its latest snapshot was taken before `since`
 *                       (waiting for the next crawl of the source page);
 *   source_unavailable  the source's latest snapshot is not an analysable 2xx page (error, redirect, skipped);
 *   verified            a link on the source resolves to the target: the same URL ("target"), a URL that redirects to it
 *                       ("redirecting_url"), the target's final URL after its own redirect ("final_url"), or a canonical
 *                       variant either way ("canonical");
 *   not_found           none does ("not found in crawl of <date>").
 * Results are stored in link_verifications (one row per expected pair; rows for pairs no longer expected are removed).
 * Implemented or sheet-placed links that are not found surface in the Overview attention feed.
 */
import type { Db } from "../lib/db";
import { parseJson } from "../lib/db";
import { iso } from "../lib/time";
import type { ProjectRow } from "../platform/access";
import { normalizeUrlKey } from "../seo/rules/registry";
import type { LinkGraph } from "./graph";
import { chunks, jsonEachInsert, runBatches } from "./sql";

export const VERIFY_VERSION = "links-verify-2026-10-03.1";
export const MAX_EXPECTED_LINKS = 2_000;

export type VerifyOrigin = "implemented" | "accepted" | "sheet";
export type VerifyStatus = "pending" | "verified" | "not_found" | "source_unavailable";

export interface ExpectedLink {
  sourceKey: string;
  targetKey: string;
  sourceUrl: string;
  targetUrl: string;
  since: string;
  origins: Set<VerifyOrigin>;
}

export interface VerificationResult {
  sourceKey: string;
  targetKey: string;
  since: string;
  origins: VerifyOrigin[];
  status: VerifyStatus;
  checkedAt: string | null;
  matchedVia: "target" | "final_url" | "canonical" | "redirecting_url" | null;
  detail: string;
}

/** A sheet Date cell as an ISO day start (UTC): 2026-09-14, 9/14/2026 (US order unless the first part exceeds 12), "Sep 14, 2026". */
export function parseSheetDate(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return isoDay(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/.exec(s);
  if (m) {
    let a = Number(m[1]);
    let b = Number(m[2]);
    const y = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
    if (a > 12 && b <= 12) [a, b] = [b, a];
    return isoDay(y, a, b);
  }
  const t = Date.parse(s);
  if (Number.isFinite(t)) {
    const d = new Date(t);
    return isoDay(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  return null;
}

function isoDay(y: number, mo: number, d: number): string | null {
  if (!(y >= 1990 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null;
  return dt.toISOString();
}

export async function loadExpectedLinks(db: Db, project: Pick<ProjectRow, "id" | "workspace_id">): Promise<ExpectedLink[]> {
  const out = new Map<string, ExpectedLink>();
  const add = (source: string, target: string, since: string, origin: VerifyOrigin) => {
    let sk: string;
    let tk: string;
    try {
      sk = normalizeUrlKey(new URL(source).toString());
      tk = normalizeUrlKey(new URL(target).toString());
    } catch {
      return;
    }
    const k = `${sk}>${tk}`;
    const e = out.get(k);
    if (!e) out.set(k, { sourceKey: sk, targetKey: tk, sourceUrl: source, targetUrl: target, since, origins: new Set([origin]) });
    else {
      e.origins.add(origin);
      if (since < e.since) e.since = since;
    }
  };
  const sugg = await db.all<{ source_url: string; target_url: string; user_status: "accepted" | "implemented"; changed: string }>(
    `SELECT source_url, target_url, user_status, COALESCE(status_changed_at, updated_at) AS changed FROM link_suggestions
      WHERE workspace_id = ? AND project_id = ? AND user_status IN ('accepted', 'implemented')
      ORDER BY changed DESC LIMIT ${MAX_EXPECTED_LINKS}`,
    project.workspace_id,
    project.id,
  );
  for (const s of sugg) add(s.source_url, s.target_url, s.changed, s.user_status);
  let sheet: Array<{ data_json: string; created_at: string }> = [];
  try {
    sheet = await db.all<{ data_json: string; created_at: string }>(
      `SELECT data_json, created_at FROM import_records
        WHERE workspace_id = ? AND project_id = ? AND destination = 'implemented_links' AND status = 'placed'
        ORDER BY created_at DESC LIMIT ${MAX_EXPECTED_LINKS}`,
      project.workspace_id,
      project.id,
    );
  } catch {
    sheet = []; // migration 0015 not applied
  }
  for (const r of sheet) {
    const d = parseJson<{ source?: string; target?: string; date?: string | null }>(r.data_json, {});
    if (!d.source || !d.target) continue;
    add(d.source, d.target, parseSheetDate(d.date) ?? r.created_at, "sheet");
  }
  return [...out.values()].slice(0, MAX_EXPECTED_LINKS);
}

const day = (t: string) => t.slice(0, 10);

export function verifyExpectedLinks(graph: LinkGraph, expected: readonly ExpectedLink[]): VerificationResult[] {
  return expected.map((e) => {
    const base = { sourceKey: e.sourceKey, targetKey: e.targetKey, since: e.since, origins: [...e.origins].sort() };
    const src = graph.byKey.get(e.sourceKey);
    if (!src || !src.snap) return { ...base, status: "pending", checkedAt: null, matchedVia: null, detail: "Waiting for the first crawl of the source page." };
    const fetched = src.snap.fetchedAt;
    if (fetched < e.since) {
      return { ...base, status: "pending", checkedAt: fetched, matchedVia: null, detail: `Waiting for the next crawl of the source page (last crawled ${day(fetched)}, before the link was placed).` };
    }
    if (!src.analyzable) {
      const why = src.issue === "redirect" ? "redirects" : src.snap.statusCode ? `returned HTTP ${src.snap.statusCode}` : `was skipped (${src.snap.skippedReason ?? "fetch failed"})`;
      return { ...base, status: "source_unavailable", checkedAt: fetched, matchedVia: null, detail: `The source page ${why} in the crawl of ${day(fetched)}.` };
    }
    const target = graph.byKey.get(e.targetKey);
    let via: VerificationResult["matchedVia"] = null;
    for (const tid of src.outAll) {
      const l = graph.nodes[tid]!;
      if (l.key === e.targetKey) {
        via = "target";
        break;
      }
      if (!via && l.finalKey === e.targetKey) via = "redirecting_url";
      if (!via && target?.finalKey && l.key === target.finalKey) via = "final_url";
      if (!via && (l.canonicalKey === e.targetKey || (target?.canonicalKey && l.key === target.canonicalKey))) via = "canonical";
    }
    if (via) {
      const how = via === "target" ? "" : via === "redirecting_url" ? " (through a URL that redirects to it)" : via === "final_url" ? " (to its final URL after a redirect)" : " (to a canonical variant)";
      return { ...base, status: "verified", checkedAt: fetched, matchedVia: via, detail: `Verified on ${day(fetched)}: the source page links to the target${how}.` };
    }
    return { ...base, status: "not_found", checkedAt: fetched, matchedVia: null, detail: `Not found in the crawl of ${day(fetched)}: the source page does not link to the target.` };
  });
}

export async function persistVerifications(db: Db, project: Pick<ProjectRow, "id" | "workspace_id">, results: readonly VerificationResult[], now: Date): Promise<void> {
  const nowIso = iso(now);
  const stmts = jsonEachInsert(
    "link_verifications",
    [
      ["workspace_id", project.workspace_id],
      ["project_id", project.id],
      ["updated_at", nowIso],
    ],
    ["source_key", "target_key", "expected_since", "origins", "status", "checked_at", "matched_via", "detail"],
    results.map((r) => [r.sourceKey, r.targetKey, r.since, r.origins.join(","), r.status, r.checkedAt, r.matchedVia, r.detail.slice(0, 300)]),
    {
      suffix: `WHERE true ON CONFLICT(project_id, source_key, target_key) DO UPDATE SET expected_since = excluded.expected_since, origins = excluded.origins,
        status = excluded.status, checked_at = excluded.checked_at, matched_via = excluded.matched_via, detail = excluded.detail, updated_at = excluded.updated_at
        WHERE link_verifications.workspace_id = excluded.workspace_id`,
    },
  );
  const keep = new Set(results.map((r) => `${r.sourceKey}>${r.targetKey}`));
  const existing = await db.all<{ source_key: string; target_key: string }>(
    `SELECT source_key, target_key FROM link_verifications WHERE workspace_id = ? AND project_id = ? LIMIT ${MAX_EXPECTED_LINKS * 3}`,
    project.workspace_id,
    project.id,
  );
  const stale = existing.filter((r) => !keep.has(`${r.source_key}>${r.target_key}`));
  for (const part of chunks(stale, 40)) {
    stmts.push([
      `DELETE FROM link_verifications WHERE workspace_id = ? AND project_id = ? AND (${part.map(() => "(source_key = ? AND target_key = ?)").join(" OR ")})`,
      project.workspace_id,
      project.id,
      ...part.flatMap((r) => [r.source_key, r.target_key]),
    ]);
  }
  await runBatches(db, stmts);
}

export interface StoredVerification {
  sourceKey: string;
  targetKey: string;
  status: VerifyStatus;
  since: string;
  origins: VerifyOrigin[];
  checkedAt: string | null;
  matchedVia: string | null;
  detail: string | null;
}

export async function loadVerifications(db: Db, project: Pick<ProjectRow, "id" | "workspace_id">): Promise<Map<string, StoredVerification>> {
  let rows: Array<{ source_key: string; target_key: string; status: VerifyStatus; expected_since: string; origins: string; checked_at: string | null; matched_via: string | null; detail: string | null }> = [];
  try {
    rows = await db.all(
      `SELECT source_key, target_key, status, expected_since, origins, checked_at, matched_via, detail FROM link_verifications
        WHERE workspace_id = ? AND project_id = ? LIMIT ${MAX_EXPECTED_LINKS * 3}`,
      project.workspace_id,
      project.id,
    );
  } catch {
    rows = [];
  }
  const out = new Map<string, StoredVerification>();
  for (const r of rows) {
    out.set(`${r.source_key}>${r.target_key}`, {
      sourceKey: r.source_key,
      targetKey: r.target_key,
      status: r.status,
      since: r.expected_since,
      origins: r.origins.split(",").filter((o): o is VerifyOrigin => o === "implemented" || o === "accepted" || o === "sheet"),
      checkedAt: r.checked_at,
      matchedVia: r.matched_via,
      detail: r.detail,
    });
  }
  return out;
}
