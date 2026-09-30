/**
 * Minimal D1Database-compatible shim over node:sqlite for tests. Applies migrations/*.sql.
 * Supports prepare().bind().all/first/run/raw, batch (transactional), and exec.
 */
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Bindable = string | number | bigint | null | Uint8Array;

class Stmt {
  constructor(private db: DatabaseSync, private sql: string, private params: Bindable[] = []) {}
  bind(...params: unknown[]) {
    return new Stmt(this.db, this.sql, params.map(toBindable));
  }
  async all<T>() {
    const rows = this.db.prepare(this.sql).all(...this.params) as T[];
    return { results: rows.map(plain) as T[], success: true, meta: {} };
  }
  async first<T>(col?: string) {
    const row = this.db.prepare(this.sql).get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (col ? row[col] : plain(row)) as T;
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async raw<T>() {
    const rows = this.db.prepare(this.sql).all(...this.params) as Record<string, unknown>[];
    return rows.map((r) => Object.values(r)) as T[];
  }
  runSync() {
    return this.db.prepare(this.sql).run(...this.params);
  }
}

function toBindable(v: unknown): Bindable {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return v as Bindable;
}

function plain<T>(row: T): T {
  return row && typeof row === "object" ? ({ ...(row as object) } as T) : row;
}

export class TestD1 {
  readonly sqlite: DatabaseSync;
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys = ON;");
    const dir = join(process.cwd(), "migrations");
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      this.sqlite.exec(readFileSync(join(dir, f), "utf8"));
    }
  }
  prepare(sql: string) {
    return new Stmt(this.sqlite, sql);
  }
  async batch(stmts: Stmt[]) {
    this.sqlite.exec("BEGIN");
    try {
      const out = stmts.map((s) => {
        const r = s.runSync();
        return { success: true, results: [], meta: { changes: Number(r.changes) } };
      });
      this.sqlite.exec("COMMIT");
      return out;
    } catch (e) {
      this.sqlite.exec("ROLLBACK");
      throw e;
    }
  }
  async exec(sql: string) {
    this.sqlite.exec(sql);
    return { count: 0, duration: 0 };
  }
}

export function createTestD1(): D1Database {
  return new TestD1() as unknown as D1Database;
}
