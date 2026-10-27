// Test doubles: Telegram Bot API (fetch), R2 (memory), D1 (node:sqlite with the real migrations).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TelegramAdapter, type TgUpdate } from "../src/channel/telegram.js";
import { openSqlite } from "../src/dev/sqlite-d1.js";
import type { AckMode, IngestIO } from "../src/ingest.js";
import { Store } from "../src/store.js";

export const TOKEN = "123:SECRET-BOT-TOKEN";
export const SECRET = "webhook-secret";
export const GROUP = "-1001234567890";

export const fixture = (name: string): TgUpdate => JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "fixtures", "app", "telegram", `${name}.json`), "utf8"));

export function fakeTelegram(files: Record<string, Uint8Array> = {}, opts: { failFile?: boolean; failSend?: boolean; failSendTo?: string } = {}) {
  const calls: { method: string; body: any; ok?: boolean }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const file = url.match(/\/file\/bot[^/]+\/(.+)$/);
    if (file) {
      if (opts.failFile) return new Response("gone", { status: 502 });
      const data = files[file[1]] ?? new Uint8Array([1, 2, 3]);
      return new Response(data, { headers: { "content-length": String(data.length) } });
    }
    const method = url.split("/").pop()!;
    const body = init.body ? JSON.parse(String(init.body)) : {};
    const fail = method === "sendMessage" && (opts.failSend || (opts.failSendTo !== undefined && String(body.chat_id) === opts.failSendTo));
    calls.push({ method, body, ok: !fail });
    if (method === "getFile") return Response.json({ ok: true, result: { file_path: body.file_id } });
    if (fail) return Response.json({ ok: false, description: "Forbidden: bot can't initiate conversation with a user" }, { status: 403 });
    return Response.json({ ok: true, result: { message_id: 1 } });
  }) as typeof fetch;
  return { calls, fetchFn, tg: new TelegramAdapter(TOKEN, fetchFn, "https://tg.test"), sent: () => calls.filter((c) => c.method === "sendMessage") };
}

export function memR2() {
  const objects = new Map<string, { data: Uint8Array; mimeType: string }>();
  return {
    objects,
    async put(key: string, body: ReadableStream | ArrayBuffer, mimeType: string) {
      const data = body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(await new Response(body).arrayBuffer());
      objects.set(key, { data, mimeType });
    },
    async get(key: string) {
      const o = objects.get(key);
      if (!o) throw new Error("not found");
      return o;
    },
  };
}

export async function seededStore() {
  const db = openSqlite();
  const store = new Store(db);
  // The label is a free note (ADR 011: no digest semantics); production relabelled its group 'members-silent'.
  await store.addChat(GROUP, "telegram", "members-silent");
  await store.addPerson({ id: "alice", name: "Alice", role: "member", senderId: "111" });
  await store.addPerson({ id: "bob", name: "Bob", role: "member", senderId: "333" });
  // An admin is a member too. D1 id differs from the KB namespace (records d1_person_map: carol-tg -> carol).
  await store.addPerson({ id: "carol-tg", name: "Carol", role: "admin", senderId: "222" });
  await store.replaceAliases(ALIASES);
  return { db, store };
}

/** Synthetic name prefixes (as the batch syncs them from records.yaml aliases), keyed by D1 person id. */
export const ALIASES = [
  { alias: "alice", personId: "alice", display: "Alice" },
  { alias: "ali", personId: "alice", display: "Alice" },
  { alias: "एलिस", personId: "alice", display: "Alice" },
  { alias: "bob", personId: "bob", display: "Bob" },
  { alias: "carol", personId: "carol-tg", display: "Carol" },
];

export function ingestIO(store: Store, tg: TelegramAdapter, r2 = memR2(), ackMode: AckMode = "all"): IngestIO & { r2: ReturnType<typeof memR2> } {
  return { ackMode, secret: SECRET, store, tg, putMedia: (k, b, m) => r2.put(k, b, m), r2 };
}

export const webhook = (update: unknown, secret = SECRET) =>
  new Request("https://w.test/telegram/webhook", {
    method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify(update),
  });

let nextId = 5000;
export function textUpdate(text: string, from = 111, extra: Record<string, unknown> = {}, date = 1792814400): TgUpdate {
  const id = nextId++;
  return { update_id: id, message: { message_id: id, date, chat: { id: Number(GROUP) }, from: { id: from, is_bot: false }, text, ...extra } } as TgUpdate;
}

/** A message in the sender's private chat with the bot (Telegram: private chat id = user id). */
export function dmUpdate(text: string, from = 222, extra: Record<string, unknown> = {}, date = 1792814400): TgUpdate {
  const id = nextId++;
  return { update_id: id, message: { message_id: id, date, chat: { id: from }, from: { id: from, is_bot: false }, text, ...extra } } as TgUpdate;
}
