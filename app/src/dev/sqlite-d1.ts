// Node-only: adapts node:sqlite to the D1 subset used by Store, and applies migrations.
// Lets tests run the exact production SQL with no network and no wrangler.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Db, Stmt } from "../store.js";

export function openSqlite(path = ":memory:", migrationsDir = join(import.meta.dirname, "../../migrations")): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  for (const f of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(migrationsDir, f), "utf8"));
  }
  return {
    prepare(sql: string): Stmt {
      const st = db.prepare(sql);
      let params: any[] = [];
      const stmt: Stmt = {
        bind: (...v: unknown[]) => ((params = v.map((x) => (x === undefined ? null : x))), stmt),
        run: async () => ({ meta: { changes: Number(st.run(...params).changes) } }), // D1 result shape
        all: async <T>() => ({ results: st.all(...params) as T[] }),
        first: async <T>() => (st.get(...params) as T) ?? null,
      };
      return stmt;
    },
  };
}
