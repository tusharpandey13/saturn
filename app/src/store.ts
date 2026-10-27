// D1 access, over the D1 API subset. The same SQL runs on Cloudflare D1 in the Worker, on the D1 REST API in the
// daily batch (src/batch/cloudflare.ts) and on node:sqlite in tests (src/dev/sqlite-d1.ts).

import type { Alias } from "./subject.js";
import type { Person } from "./types.js";

export interface Stmt {
  bind(...values: unknown[]): Stmt;
  run(): Promise<{ meta: { changes: number } }>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}
export interface Db {
  prepare(sql: string): Stmt;
  /** Several statements in one round trip (the D1 REST client). Absent: Store runs them one by one. */
  batch?(qs: { sql: string; params?: unknown[] }[]): Promise<{ results: any[]; meta: { changes: number } }[]>;
}

export type InboxKind = "text" | "audio" | "image" | "document" | "other";
export type MediaStatus = "none" | "pending" | "stored" | "too_big";

export interface InboxRow {
  update_id: number;
  chat_id: string;
  message_id: number;
  sender_id: string;
  person_id: string;
  kind: InboxKind;
  received_at: string;
  raw: string;
  media_key: string | null;
  media_status: MediaStatus;
  ack: string | null;
  /** Who the message is about (D1 person id); the sender unless a name prefix or a /for correction says otherwise. */
  subject_id: string | null;
}

export interface SubjectCorrection {
  id: number;
  update_id: number;
  subject_id: string;
  set_by: string;
  set_at: string;
  reason: string | null;
}

const SQL = {
  persons: "SELECT id, name, role, sender_id FROM persons ORDER BY id",
  chats: "SELECT chat_id, channel, label FROM chats ORDER BY chat_id",
  aliasDelete: "DELETE FROM aliases WHERE alias NOT IN (SELECT json_extract(value, '$.a') FROM json_each(?))",
  aliasUpsert: "INSERT OR REPLACE INTO aliases (alias, person_id, display) SELECT json_extract(value, '$.a'), json_extract(value, '$.p'), json_extract(value, '$.d') FROM json_each(?)",
  corrections: "SELECT id, update_id, subject_id, set_by, set_at, reason FROM subject_corrections ORDER BY id",
  newInbox: "SELECT update_id, chat_id, message_id, sender_id, person_id, kind, received_at, raw, media_key, media_status, ack, subject_id FROM inbox WHERE status = 'new' ORDER BY update_id",
  markDone: "UPDATE inbox SET status = 'done', done_at = ? WHERE status = 'new' AND update_id IN (SELECT value FROM json_each(?))",
  prune: "DELETE FROM inbox WHERE status = 'done' AND done_at < ?",
};

const rowToPerson = (r: any): Person => ({ id: r.id, name: r.name, role: r.role, senderId: r.sender_id });

export class Store {
  constructor(private db: Db) {}

  // ---------- people and chats ----------

  async addPerson(p: Person): Promise<void> {
    await this.db.prepare("INSERT INTO persons (id, name, role, sender_id) VALUES (?, ?, ?, ?)").bind(p.id, p.name, p.role, p.senderId).run();
  }

  async personBySender(sender: string): Promise<Person | null> {
    const r = await this.db.prepare("SELECT id, name, role, sender_id FROM persons WHERE sender_id = ?").bind(sender).first();
    return r ? rowToPerson(r) : null;
  }

  async persons(): Promise<Person[]> {
    return (await this.db.prepare(SQL.persons).all()).results.map(rowToPerson);
  }

  async addChat(chatId: string, channel: string, label: string | null = null): Promise<void> {
    await this.db.prepare("INSERT OR IGNORE INTO chats (chat_id, channel, label) VALUES (?, ?, ?)").bind(chatId, channel, label).run();
  }

  async chats(): Promise<{ chat_id: string; channel: string; label: string | null }[]> {
    return (await this.db.prepare(SQL.chats).all<any>()).results;
  }

  async isAllowedChat(chatId: string): Promise<boolean> {
    return !!(await this.db.prepare("SELECT 1 AS ok FROM chats WHERE chat_id = ?").bind(chatId).first());
  }

  /** Group upgraded to supergroup: carry the allowlist entry over to the new id. */
  async migrateChat(fromId: string, toId: string): Promise<void> {
    await this.db.prepare("UPDATE OR IGNORE chats SET chat_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE chat_id = ?").bind(toId, fromId).run();
  }

  // ---------- subjects (aliases, /for corrections) ----------

  async aliases(): Promise<Alias[]> {
    return (await this.db.prepare("SELECT alias, person_id, display FROM aliases ORDER BY alias").all<any>()).results
      .map((r) => ({ alias: r.alias, personId: r.person_id, display: r.display }));
  }

  /** Replace the alias table with the records' aliases (the batch, each pull). Two statements: no D1 REST transaction. */
  async replaceAliases(list: Alias[]): Promise<void> {
    const rows = list.map((a) => ({ a: a.alias.normalize("NFC").toLocaleLowerCase("en"), p: a.personId, d: a.display }));
    await this.db.prepare(SQL.aliasDelete).bind(JSON.stringify(rows)).run();
    await this.db
      .prepare(SQL.aliasUpsert)
      .bind(JSON.stringify(rows))
      .run();
  }

  /** The inbox row a reply points at: the bot's echo of it, or the message itself. */
  async rowForReply(chatId: string, messageId: number): Promise<{ update_id: number; person_id: string; subject_id: string | null } | null> {
    return this.db
      .prepare("SELECT update_id, person_id, subject_id FROM inbox WHERE chat_id = ? AND (ack_message_id = ? OR message_id = ?) ORDER BY update_id DESC LIMIT 1")
      .bind(chatId, messageId, messageId)
      .first();
  }

  /** Record a /for correction (idempotent on the command's update_id) and move the row's subject. */
  async correctSubject(c: SubjectCorrection): Promise<boolean> {
    const res = await this.db
      .prepare("INSERT OR IGNORE INTO subject_corrections (id, update_id, subject_id, set_by, set_at, reason) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(c.id, c.update_id, c.subject_id, c.set_by, c.set_at, c.reason)
      .run();
    if (!res.meta.changes) return false;
    await this.db.prepare("UPDATE inbox SET subject_id = ? WHERE update_id = ?").bind(c.subject_id, c.update_id).run();
    return true;
  }

  async corrections(): Promise<SubjectCorrection[]> {
    return (await this.db.prepare(SQL.corrections).all<SubjectCorrection>()).results;
  }

  async setAckMessage(updateId: number, messageId: number): Promise<void> {
    await this.db.prepare("UPDATE inbox SET ack_message_id = ? WHERE update_id = ?").bind(messageId, updateId).run();
  }

  /** Runs statements in one call when the Db can batch (REST: one API request), else one by one (tests, Worker). */
  private async many(qs: { sql: string; params?: unknown[] }[]): Promise<{ results: any[]; changes: number }[]> {
    if (this.db.batch) return (await this.db.batch(qs)).map((r) => ({ results: r.results, changes: r.meta.changes }));
    const out: { results: any[]; changes: number }[] = [];
    for (const q of qs) {
      const st = this.db.prepare(q.sql).bind(...(q.params ?? []));
      if (/^\s*SELECT/i.test(q.sql)) out.push({ results: (await st.all()).results, changes: 0 });
      else out.push({ results: [], changes: (await st.run()).meta.changes });
    }
    return out;
  }

  /** Everything the batch pull reads (and the alias sync) in ONE D1 call: the REST API is rate limited per user. */
  async pullSnapshot(aliases?: Alias[]): Promise<{ inbox: InboxRow[]; persons: Person[]; chats: { chat_id: string; channel: string; label: string | null }[]; corrections: SubjectCorrection[] }> {
    const rows = (aliases ?? []).map((a) => ({ a: a.alias.normalize("NFC").toLocaleLowerCase("en"), p: a.personId, d: a.display }));
    const sync = aliases ? [
      { sql: SQL.aliasDelete, params: [JSON.stringify(rows)] },
      { sql: SQL.aliasUpsert, params: [JSON.stringify(rows)] },
    ] : [];
    const r = await this.many([...sync, { sql: SQL.newInbox }, { sql: SQL.persons }, { sql: SQL.chats }, { sql: SQL.corrections }]);
    const [inbox, persons, chats, corrections] = r.slice(sync.length);
    return { inbox: inbox.results, persons: persons.results.map(rowToPerson), chats: chats.results, corrections: corrections.results };
  }

  /** The batch finish's D1 work in ONE call: mark rows done, prune old done rows, read chats and persons for sending. */
  async finishSnapshot(updateIds: number[], at: string, pruneBefore: string): Promise<{ done: number; pruned: number; persons: Person[]; chats: { chat_id: string; channel: string; label: string | null }[] }> {
    const [done, pruned, persons, chats] = await this.many([
      { sql: SQL.markDone, params: [at, JSON.stringify(updateIds)] },
      { sql: SQL.prune, params: [pruneBefore] },
      { sql: SQL.persons },
      { sql: SQL.chats },
    ]);
    return { done: updateIds.length ? done.changes : 0, pruned: pruned.changes, persons: persons.results.map(rowToPerson), chats: chats.results };
  }

  // ---------- inbox (Worker side) ----------

  /** Idempotent on update_id. Returns false if the update was already stored (a Telegram redelivery). */
  async insertInbox(r: InboxRow): Promise<boolean> {
    const res = await this.db
      .prepare("INSERT OR IGNORE INTO inbox (update_id, chat_id, message_id, sender_id, person_id, kind, received_at, raw, media_key, media_status, ack, subject_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(r.update_id, r.chat_id, r.message_id, r.sender_id, r.person_id, r.kind, r.received_at, r.raw, r.media_key, r.media_status, r.ack, r.subject_id)
      .run();
    return res.meta.changes > 0;
  }

  async setMediaStatus(updateId: number, status: MediaStatus): Promise<void> {
    await this.db.prepare("UPDATE inbox SET media_status = ? WHERE update_id = ?").bind(status, updateId).run();
  }

  // ---------- inbox (batch side) ----------

  async newInbox(): Promise<InboxRow[]> {
    return (await this.db
      .prepare(SQL.newInbox)
      .all<InboxRow>()).results;
  }

  /** Mark rows done once they are in git. One statement (the D1 REST API has no multi-statement transaction). */
  async markDone(updateIds: number[], at: string): Promise<number> {
    if (!updateIds.length) return 0;
    const res = await this.db
      .prepare(SQL.markDone)
      .bind(at, JSON.stringify(updateIds))
      .run();
    return res.meta.changes;
  }

  /** Delete rows committed to git more than `days` ago. */
  async prune(beforeIso: string): Promise<number> {
    return (await this.db.prepare(SQL.prune).bind(beforeIso).run()).meta.changes;
  }
}
