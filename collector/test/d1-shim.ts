// 테스트용 D1 대역: node:sqlite 위에 D1이 쓰는 API 일부만 구현
// (prepare/bind/first/all/run/batch). D1도 SQLite라 SQL은 그대로 동작.

import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

class Stmt {
  db: DatabaseSync;
  sql: string;
  params: SQLInputValue[];
  constructor(db: DatabaseSync, sql: string, params: SQLInputValue[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...params: unknown[]) {
    return new Stmt(this.db, this.sql, params.map((p) => (p === undefined ? null : p)) as SQLInputValue[]);
  }
  async first(col?: string) {
    const row = this.db.prepare(this.sql).get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    return col ? (row[col] ?? null) : { ...row };
  }
  async all() {
    const rows = this.db.prepare(this.sql).all(...this.params) as Record<string, unknown>[];
    return { results: rows.map((r) => ({ ...r })), success: true, meta: {} };
  }
  runSync() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async run() {
    return this.runSync();
  }
}

export class D1Shim {
  db: DatabaseSync;
  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    const migrated = this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'watch_rule'").get();
    if (migrated) return;
    const dir = new URL("../migrations/", import.meta.url);
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      this.db.exec(readFileSync(new URL(f, dir), "utf8"));
    }
  }
  prepare(sql: string) {
    return new Stmt(this.db, sql);
  }
  async batch(stmts: Stmt[]) {
    this.db.exec("BEGIN");
    try {
      const out = stmts.map((s) => s.runSync());
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  /** 테스트 편의: 동기 조회 */
  rows(sql: string, ...params: SQLInputValue[]) {
    return (this.db.prepare(sql).all(...params) as Record<string, any>[]).map((r) => ({ ...r }));
  }
}

export const asD1 = (s: D1Shim) => s as unknown as D1Database;
