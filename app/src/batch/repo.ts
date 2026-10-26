// Git working-tree layout written by the daily batch (ADR 005). Git is the source of truth.
//   data/telegram/raw/YYYY-MM.jsonl   raw inbox rows (verbatim Telegram update), one per update_id. Written FIRST.
//   data/telegram/YYYY-MM.ndjson      extracted rows ("rt": "d1.messages|d1.readings|d1.symptoms"), read by tools/kb/build
//   data/telegram/directory.ndjson    persons and chats ("rt": "d1.persons|d1.chats")
//   data/queue/needs_deep.jsonl       work for the offline Opus agent (append-only)
//   sources/<person>/media/telegram/<file_unique_id>.<ext>   photos, PDFs, voice notes (ADR 003)
// .jsonl files are deliberately not *.ndjson: tools/kb/build only reads *.ndjson.
// Months are Asia/Kolkata calendar months of the message's send time. Output is sorted and stable: re-running on
// the same input writes identical bytes.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TgUpdate } from "../channel/telegram.js";
import type { InboxKind, MediaStatus } from "../store.js";

/** D1 person id -> records namespace (records.yaml d1_person_map, as tools/kb/build); the same id otherwise. */
export type PersonMap = Readonly<Record<string, string>>;

export const EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "application/pdf": "pdf",
  "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a",
};
export const MIME_OF_EXT: Record<string, string> = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]));

export interface RawRow {
  update_id: number;
  chat_id: string;
  message_id: number;
  sender_id: string;
  person_id: string;
  role: "patient" | "caregiver";
  kind: InboxKind;
  received_at: string;
  media_key: string | null;
  media_status: MediaStatus;
  media_mime: string | null;
  /** Repo-relative path of the media copy, null until copied. */
  media_path: string | null;
  ack: string | null;
  update: TgUpdate;
}

export type Row = Record<string, unknown> & { rt: string };

const TABLE_ORDER = ["d1.persons", "d1.chats", "d1.messages", "d1.readings", "d1.symptoms"];

export function monthOf(iso: string): string {
  const ist = new Date(Date.parse(iso) + 330 * 60_000); // Asia/Kolkata has no DST
  return ist.toISOString().slice(0, 7);
}

/** One JSON object per line, keys sorted, rt first: stable bytes for a stable input. */
export function line(row: Record<string, unknown>): string {
  const { rt, ...rest } = row;
  const sorted = Object.fromEntries(Object.keys(rest).sort().map((k) => [k, rest[k]]));
  return JSON.stringify(rt === undefined ? sorted : { rt, ...sorted });
}

function readLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T);
}

/** Write only if the bytes change. Returns true if the file changed. */
function writeIfChanged(path: string, text: string): boolean {
  if (existsSync(path) && readFileSync(path, "utf8") === text) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return true;
}

export class Repo {
  constructor(readonly root: string, private readonly personMap: PersonMap = {}) {}

  personDir(id: string): string {
    return this.personMap[id] ?? id;
  }

  private p(...parts: string[]) {
    return join(this.root, ...parts);
  }

  private files(dir: string, ext: string): string[] {
    const d = this.p(dir);
    return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(ext)).sort().map((f) => join(d, f)) : [];
  }

  // ---------- raw ----------

  rawRows(): RawRow[] {
    return this.files("data/telegram/raw", ".jsonl").flatMap((f) => readLines<RawRow>(f));
  }

  /** Merge rows into their month files by update_id (an incoming row replaces a stored one). */
  writeRaw(rows: RawRow[]): string[] {
    const byMonth = new Map<string, RawRow[]>();
    for (const r of rows) byMonth.set(monthOf(r.received_at), [...(byMonth.get(monthOf(r.received_at)) ?? []), r]);
    const changed: string[] = [];
    for (const [month, fresh] of byMonth) {
      const path = this.p("data/telegram/raw", `${month}.jsonl`);
      const all = new Map(readLines<RawRow>(path).map((r) => [r.update_id, r]));
      for (const r of fresh) all.set(r.update_id, r);
      const text = [...all.values()].sort((a, b) => a.update_id - b.update_id).map((r) => line(r as unknown as Record<string, unknown>) + "\n").join("");
      if (writeIfChanged(path, text)) changed.push(`raw/${month}.jsonl`);
    }
    return changed;
  }

  // ---------- media ----------

  /** Existing copy of telegram/<uid> for this person, if any (any extension). */
  findMedia(personId: string, mediaKey: string): string | null {
    const dir = `sources/${this.personDir(personId)}/media/telegram`;
    const uid = mediaKey.split("/").pop()!;
    const hit = existsSync(this.p(dir)) ? readdirSync(this.p(dir)).find((f) => f.startsWith(`${uid}.`)) : undefined;
    return hit ? `${dir}/${hit}` : null;
  }

  writeMedia(personId: string, mediaKey: string, data: Uint8Array, mime: string): string {
    const rel = `sources/${this.personDir(personId)}/media/telegram/${mediaKey.split("/").pop()}.${EXT[mime] ?? "bin"}`;
    mkdirSync(dirname(this.p(rel)), { recursive: true });
    writeFileSync(this.p(rel), data);
    return rel;
  }

  readMedia(rel: string): Uint8Array {
    return new Uint8Array(readFileSync(this.p(rel)));
  }

  // ---------- extracted rows ----------

  kbRows(): Row[] {
    return this.files("data/telegram", ".ndjson").filter((f) => !f.endsWith("directory.ndjson")).flatMap((f) => readLines<Row>(f));
  }

  /**
   * Replace everything derived from these messages (the message row and its readings/symptoms) and write the
   * month files. An edited message is re-extracted under the same id, so stale rows must go.
   */
  writeKb(rows: Row[], replacedMessageIds: Set<string>): string[] {
    const byMonth = new Map<string, Row[]>();
    const msgMonth = new Map(rows.filter((r) => r.rt === "d1.messages").map((r) => [r.id as string, monthOf(r.received_at as string)]));
    for (const r of rows) {
      const m = msgMonth.get((r.rt === "d1.messages" ? r.id : r.source_message_id) as string)!;
      byMonth.set(m, [...(byMonth.get(m) ?? []), r]);
    }
    const changed: string[] = [];
    for (const [month, fresh] of byMonth) {
      const path = this.p("data/telegram", `${month}.ndjson`);
      const kept = readLines<Row>(path).filter((r) => !replacedMessageIds.has((r.rt === "d1.messages" ? r.id : r.source_message_id) as string));
      const all = [...kept, ...fresh].sort((a, b) => TABLE_ORDER.indexOf(a.rt) - TABLE_ORDER.indexOf(b.rt) || String(a.id).localeCompare(String(b.id)));
      if (writeIfChanged(path, all.map((r) => line(r) + "\n").join(""))) changed.push(`${month}.ndjson`);
    }
    return changed;
  }

  writeDirectory(rows: Row[]): boolean {
    const sorted = [...rows].sort((a, b) => TABLE_ORDER.indexOf(a.rt) - TABLE_ORDER.indexOf(b.rt) || String(a.id ?? a.chat_id).localeCompare(String(b.id ?? b.chat_id)));
    return writeIfChanged(this.p("data/telegram/directory.ndjson"), sorted.map((r) => line(r) + "\n").join(""));
  }

  // ---------- needs_deep queue ----------

  queue(): Record<string, unknown>[] {
    return readLines(this.p("data/queue/needs_deep.jsonl"));
  }

  /** Append entries whose id is not in the queue yet (append-only; idempotent). Returns how many were added. */
  enqueueDeep(entries: Record<string, unknown>[]): number {
    const seen = new Set(this.queue().map((e) => e.id));
    const add = entries.filter((e) => !seen.has(e.id));
    if (!add.length) return 0;
    const path = this.p("data/queue/needs_deep.jsonl");
    const prev = existsSync(path) ? readFileSync(path, "utf8") : "";
    writeIfChanged(path, prev + add.map((e) => JSON.stringify(e) + "\n").join(""));
    return add.length;
  }
}
