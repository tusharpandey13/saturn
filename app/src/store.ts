// D1 access, over the D1 API subset. The same SQL runs on Cloudflare D1 in the Worker, on the D1 REST API in the
// daily batch (src/batch/cloudflare.ts) and on node:sqlite in tests (src/dev/sqlite-d1.ts).

import type { Person } from "./types.js";

export interface Stmt {
  bind(...values: unknown[]): Stmt;
  run(): Promise<{ meta: { changes: number } }>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}
export interface Db {
  prepare(sql: string): Stmt;
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
}

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
    return (await this.db.prepare("SELECT id, name, role, sender_id FROM persons ORDER BY id").all()).results.map(rowToPerson);
  }

  async addChat(chatId: string, channel: string, label: string | null = null): Promise<void> {
    await this.db.prepare("INSERT OR IGNORE INTO chats (chat_id, channel, label) VALUES (?, ?, ?)").bind(chatId, channel, label).run();
  }

  async chats(): Promise<{ chat_id: string; channel: string; label: string | null }[]> {
    return (await this.db.prepare("SELECT chat_id, channel, label FROM chats ORDER BY chat_id").all<any>()).results;
  }

  async isAllowedChat(chatId: string): Promise<boolean> {
    return !!(await this.db.prepare("SELECT 1 AS ok FROM chats WHERE chat_id = ?").bind(chatId).first());
  }

  /** Group upgraded to supergroup: carry the allowlist entry over to the new id. */
  async migrateChat(fromId: string, toId: string): Promise<void> {
    await this.db.prepare("UPDATE OR IGNORE chats SET chat_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE chat_id = ?").bind(toId, fromId).run();
  }

  // ---------- inbox (Worker side) ----------

  /** Idempotent on update_id. Returns false if the update was already stored (a Telegram redelivery). */
  async insertInbox(r: InboxRow): Promise<boolean> {
    const res = await this.db
      .prepare("INSERT OR IGNORE INTO inbox (update_id, chat_id, message_id, sender_id, person_id, kind, received_at, raw, media_key, media_status, ack) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(r.update_id, r.chat_id, r.message_id, r.sender_id, r.person_id, r.kind, r.received_at, r.raw, r.media_key, r.media_status, r.ack)
      .run();
    return res.meta.changes > 0;
  }

  async setMediaStatus(updateId: number, status: MediaStatus): Promise<void> {
    await this.db.prepare("UPDATE inbox SET media_status = ? WHERE update_id = ?").bind(status, updateId).run();
  }

  // ---------- inbox (batch side) ----------

  async newInbox(): Promise<InboxRow[]> {
    return (await this.db
      .prepare("SELECT update_id, chat_id, message_id, sender_id, person_id, kind, received_at, raw, media_key, media_status, ack FROM inbox WHERE status = 'new' ORDER BY update_id")
      .all<InboxRow>()).results;
  }

  /** Mark rows done once they are in git. One statement (the D1 REST API has no multi-statement transaction). */
  async markDone(updateIds: number[], at: string): Promise<number> {
    if (!updateIds.length) return 0;
    const res = await this.db
      .prepare("UPDATE inbox SET status = 'done', done_at = ? WHERE status = 'new' AND update_id IN (SELECT value FROM json_each(?))")
      .bind(at, JSON.stringify(updateIds))
      .run();
    return res.meta.changes;
  }

  /** Delete rows committed to git more than `days` ago. */
  async prune(beforeIso: string): Promise<number> {
    return (await this.db.prepare("DELETE FROM inbox WHERE status = 'done' AND done_at < ?").bind(beforeIso).run()).meta.changes;
  }
}
