/**
 * Thin typed helpers over D1. All tenant queries must include workspace_id in their WHERE clause;
 * use `scoped()` helpers or pass workspaceId explicitly. JSON columns end in `_json`.
 */
export type Row = Record<string, unknown>;

export class Db {
  constructor(public readonly d1: D1Database) {}

  async all<T = Row>(sql: string, ...params: unknown[]): Promise<T[]> {
    const res = await this.d1.prepare(sql).bind(...params.map(norm)).all<T>();
    return res.results ?? [];
  }

  async first<T = Row>(sql: string, ...params: unknown[]): Promise<T | null> {
    return (await this.d1.prepare(sql).bind(...params.map(norm)).first<T>()) ?? null;
  }

  async run(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
    const res = await this.d1.prepare(sql).bind(...params.map(norm)).run();
    return { changes: res.meta?.changes ?? 0 };
  }

  /** Execute statements atomically (D1 batch is a transaction). */
  async batch(statements: Array<[string, ...unknown[]]>): Promise<void> {
    if (statements.length === 0) return;
    await this.d1.batch(statements.map(([sql, ...params]) => this.d1.prepare(sql).bind(...params.map(norm))));
  }

  /** Insert a row object. Undefined values are omitted; objects/arrays are JSON-encoded. */
  async insert(table: string, row: Row): Promise<void> {
    const [sql, ...params] = insertStatement(table, row);
    await this.run(sql, ...params);
  }
}

export function insertStatement(table: string, row: Row): [string, ...unknown[]] {
  const keys = Object.keys(row).filter((k) => row[k] !== undefined);
  assertIdent(table);
  keys.forEach(assertIdent);
  const sql = `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`;
  return [sql, ...keys.map((k) => row[k])];
}

function norm(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v !== null && typeof v === "object" && !(v instanceof ArrayBuffer) && !ArrayBuffer.isView(v)) return JSON.stringify(v);
  return v;
}

function assertIdent(name: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unsafe SQL identifier: ${name}`);
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value === "") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
