// D1 migrations on node:sqlite (the same SQL wrangler applies). 0002 rebuilds persons for the member/admin roles.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Store } from "../src/store.js";
import { openSqlite } from "../src/dev/sqlite-d1.js";

const MIG = join(import.meta.dirname, "..", "migrations");
const sql = (f: string) => readFileSync(join(MIG, f), "utf8");

/** A D1 at 0001 with three persons like production (two patients, one caregiver), then 0002. */
function migrated() {
  const db = new DatabaseSync(":memory:");
  db.exec(sql("0001_init.sql"));
  db.exec(`INSERT INTO persons (id, name, role, sender_id, created_at) VALUES
    ('alice', 'Alice', 'patient', '111', '2026-10-01T00:00:00.000Z'),
    ('bob', 'Bob', 'patient', '333', '2026-10-01T00:00:01.000Z'),
    ('carol-tg', 'Carol', 'caregiver', '222', '2026-10-01T00:00:02.000Z');
    INSERT INTO inbox (update_id, chat_id, message_id, sender_id, person_id, kind, received_at, raw)
      VALUES (1, '-100', 1, '222', 'carol-tg', 'text', '2026-10-02T00:00:00.000Z', '{}');`);
  db.exec(sql("0002_member_admin_roles.sql"));
  return db;
}

describe("0002_member_admin_roles", () => {
  it("maps patient -> member and caregiver -> admin, keeping ids, names, sender ids and created_at", () => {
    const db = migrated();
    expect(db.prepare("SELECT id, name, role, sender_id, created_at FROM persons ORDER BY id").all()).toEqual([
      { id: "alice", name: "Alice", role: "member", sender_id: "111", created_at: "2026-10-01T00:00:00.000Z" },
      { id: "bob", name: "Bob", role: "member", sender_id: "333", created_at: "2026-10-01T00:00:01.000Z" },
      { id: "carol-tg", name: "Carol", role: "admin", sender_id: "222", created_at: "2026-10-01T00:00:02.000Z" },
    ]);
    expect(db.prepare("SELECT count(*) AS n FROM inbox").get()).toEqual({ n: 1 }); // other tables untouched
  });

  it("the new CHECK refuses the old roles; sender_id stays UNIQUE", () => {
    const db = migrated();
    for (const role of ["patient", "caregiver", "observer"])
      expect(() => db.exec(`INSERT INTO persons (id, name, role, sender_id) VALUES ('x', 'X', '${role}', '999')`)).toThrow(/CHECK/);
    expect(() => db.exec("INSERT INTO persons (id, name, role, sender_id) VALUES ('dup', 'D', 'member', '111')")).toThrow(/UNIQUE/);
    db.exec("INSERT INTO persons (id, name, role, sender_id) VALUES ('dan', 'Dan', 'member', '444')");
    expect(db.prepare("SELECT created_at FROM persons WHERE id = 'dan'").get()).toMatchObject({ created_at: expect.stringMatching(/Z$/) });
  });

  it("an unknown role aborts the migration (CHECK), leaving persons as it was", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(sql("0001_init.sql"));
    db.exec("PRAGMA ignore_check_constraints = ON; INSERT INTO persons (id, name, role, sender_id) VALUES ('z', 'Z', 'other', '9'); PRAGMA ignore_check_constraints = OFF;");
    // wrangler applies a migration as one unit; emulate that with a transaction.
    expect(() => db.exec(`BEGIN; ${sql("0002_member_admin_roles.sql")} COMMIT;`)).toThrow(/CHECK/);
    db.exec("ROLLBACK");
    expect(db.prepare("SELECT id, role FROM persons").all()).toEqual([{ id: "z", role: "other" }]);
  });

  it("0003 adds inbox.subject_id backfilled = person_id, ack_message_id, aliases and subject_corrections", () => {
    const db = migrated();
    db.exec(sql("0003_inbox_subject.sql"));
    expect(db.prepare("SELECT update_id, person_id, subject_id, ack_message_id FROM inbox").all()).toEqual([{ update_id: 1, person_id: "carol-tg", subject_id: "carol-tg", ack_message_id: null }]);
    db.exec("INSERT INTO inbox (update_id, chat_id, message_id, sender_id, person_id, kind, received_at, raw) VALUES (2, '-100', 2, '111', 'alice', 'text', 't', '{}')");
    expect(db.prepare("SELECT subject_id FROM inbox WHERE update_id = 2").get()).toEqual({ subject_id: null }); // nullable: NULL = the sender
    for (const t of ["aliases", "subject_corrections"]) expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = ?").get(t)).toEqual({ n: 1 });
  });

  it("the full chain (what tests and wrangler apply) takes member and admin through the Store", async () => {
    const store = new Store(openSqlite());
    await store.addPerson({ id: "a", name: "A", role: "member", senderId: "1" });
    await store.addPerson({ id: "b", name: "B", role: "admin", senderId: "2" });
    expect((await store.persons()).map((p) => p.role)).toEqual(["member", "admin"]);
  });
});
