/**
 * D1-safe statement helpers for the internal-links workbench and the rolling crawl.
 * D1 allows at most 100 bound parameters per statement (https://developers.cloudflare.com/d1/platform/limits/);
 * multi-row statements here stay at or below MAX_PARAMS, and batches hold at most MAX_BATCH statements.
 */
import type { Db } from "../lib/db";

export const MAX_PARAMS = 99;
export const MAX_BATCH = 50;
/** Ids per `IN (...)` list, leaving room for the tenant parameters of the same statement. */
export const IN_CHUNK = 90;

export function chunks<T>(list: readonly T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

/**
 * Multi-row INSERT statements (`VALUES (...), (...)`) with at most MAX_PARAMS parameters each. `suffix` is appended
 * verbatim (e.g. an `ON CONFLICT ... DO UPDATE` clause written by the caller, never user input).
 */
export function multiRowInsert(table: string, columns: readonly string[], rows: ReadonlyArray<readonly unknown[]>, suffix = ""): Array<[string, ...unknown[]]> {
  if (!IDENT.test(table) || columns.some((c) => !IDENT.test(c))) throw new Error("Unsafe SQL identifier.");
  if (columns.length === 0 || columns.length > MAX_PARAMS) throw new Error("Bad column list.");
  const perStatement = Math.max(1, Math.floor(MAX_PARAMS / columns.length));
  const tuple = `(${columns.map(() => "?").join(", ")})`;
  const out: Array<[string, ...unknown[]]> = [];
  for (const part of chunks(rows, perStatement)) {
    for (const r of part) if (r.length !== columns.length) throw new Error("Row width does not match the column list.");
    const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${part.map(() => tuple).join(", ")}${suffix ? ` ${suffix}` : ""}`;
    out.push([sql, ...part.flat()]);
  }
  return out;
}

/** Runs statements in D1 batches of at most MAX_BATCH (each batch is one transaction and one round trip). */
export async function runBatches(db: Db, statements: ReadonlyArray<[string, ...unknown[]]>, size = MAX_BATCH): Promise<void> {
  for (const part of chunks(statements, Math.min(size, MAX_BATCH))) await db.batch(part);
}

/** `?, ?, ?` for an IN list. */
export const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/**
 * Bulk INSERT through one bound JSON parameter per statement: `INSERT INTO t (consts..., cols...) SELECT ?, ...,
 * json_extract(value, '$[0]'), ... FROM json_each(?)`. Each row is an array of scalars (strings, numbers, null) in
 * `columns` order; nested JSON must be passed pre-serialized as a string. Statements stay at
 * `constants.length + 1` parameters and at most `maxJsonBytes` of JSON each, so very wide or numerous rows need few
 * round trips without approaching D1's 100-parameter limit.
 */
export function jsonEachInsert(
  table: string,
  constants: ReadonlyArray<readonly [string, unknown]>,
  columns: readonly string[],
  rows: ReadonlyArray<readonly unknown[]>,
  opts: { maxRows?: number; maxJsonBytes?: number; suffix?: string } = {},
): Array<[string, ...unknown[]]> {
  if (!IDENT.test(table) || columns.some((c) => !IDENT.test(c)) || constants.some(([c]) => !IDENT.test(c))) throw new Error("Unsafe SQL identifier.");
  if (constants.length + 1 > MAX_PARAMS) throw new Error("Too many constant columns.");
  const maxRows = Math.max(1, opts.maxRows ?? 200);
  const maxBytes = Math.max(1024, opts.maxJsonBytes ?? 400_000);
  const head = `INSERT INTO ${table} (${[...constants.map(([c]) => c), ...columns].join(", ")}) SELECT ${[
    ...constants.map(() => "?"),
    ...columns.map((_, i) => `json_extract(value, '$[${i}]')`),
  ].join(", ")} FROM json_each(?)${opts.suffix ? ` ${opts.suffix}` : ""}`;
  const out: Array<[string, ...unknown[]]> = [];
  let part: string[] = [];
  let bytes = 2;
  const flush = () => {
    if (!part.length) return;
    out.push([head, ...constants.map(([, v]) => v), `[${part.join(",")}]`]);
    part = [];
    bytes = 2;
  };
  for (const r of rows) {
    if (r.length !== columns.length) throw new Error("Row width does not match the column list.");
    const json = JSON.stringify(r);
    if (part.length >= maxRows || (part.length > 0 && bytes + json.length + 1 > maxBytes)) flush();
    part.push(json);
    bytes += json.length + 1;
  }
  flush();
  return out;
}
