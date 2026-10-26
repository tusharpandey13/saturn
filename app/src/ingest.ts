// Ingest (ADR 005): the only always-on piece. Per Telegram update:
//   secret check -> allowlist (D1 chats, persons) -> INSERT OR IGNORE into inbox (key: update_id)
//   -> copy media to R2 -> short ack (deterministic vitals echo). No LLM, no queue, no alerts.
// Failure policy: if the inbox insert fails, answer 500 so Telegram redelivers (it keeps updates ~24 h).
// After the insert, answer 200 whatever happens: a failed media copy stays media_status 'pending' and the batch
// fetches it by file_id; a failed ack is only a missing reply. Never log message content or file URLs.

import { MAX_FILE_BYTES, parseUpdate, type TelegramAdapter, type TgUpdate, timingSafeEqual } from "./channel/telegram.js";
import type { InboxRow, MediaStatus, Store } from "./store.js";
import { parseVitals, vitalsEcho } from "./vitals.js";

export interface IngestIO {
  secret: string;
  store: Store;
  tg: TelegramAdapter;
  putMedia(key: string, body: ReadableStream | ArrayBuffer, mimeType: string): Promise<void>;
}

export const ACK = {
  text: "✓ मिल गया",
  image: "📷 फ़ोटो मिल गई ✓",
  document: "📄 दस्तावेज़ मिल गया ✓",
  audio: "🎤 आवाज़ संदेश मिल गया ✓",
  tooBig: "यह फ़ाइल 20 MB से बड़ी है, सेव नहीं हुई। कृपया छोटी फ़ाइल या फ़ोटो भेजें।",
  editPrefix: "सुधार: ",
};

export const safeErr = (err: unknown) => {
  const e = err as { name?: string; status?: number };
  return `${e?.name ?? "Error"}${e?.status ? ` status=${e.status}` : ""}`;
};

export async function handleWebhook(req: Request, io: IngestIO): Promise<Response> {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const got = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!io.secret || !timingSafeEqual(got, io.secret)) return new Response("unauthorized", { status: 401 });

  let update: TgUpdate;
  try {
    update = await req.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }
  if (typeof update?.update_id !== "number") return new Response("bad request", { status: 400 });

  try {
    return await ingest(update, io);
  } catch (err) {
    console.error("ingest failed", update.update_id, safeErr(err));
    return new Response("retry", { status: 500 }); // nothing stored yet (or a duplicate-safe retry): Telegram redelivers
  }
}

async function ingest(update: TgUpdate, io: IngestIO): Promise<Response> {
  const ok = () => new Response("ok");
  const ev = parseUpdate(update);
  if (!ev) return ok();
  if (ev.type === "migrate") {
    if (await io.store.isAllowedChat(ev.fromChatId)) await io.store.migrateChat(ev.fromChatId, ev.toChatId);
    return ok();
  }
  const m = ev.msg;
  if (!(await io.store.isAllowedChat(m.chatId))) return ok();
  const person = await io.store.personBySender(m.sender);
  if (!person) return ok(); // strangers are dropped, not stored

  const tooBig = !!m.file && (m.file.size ?? 0) > MAX_FILE_BYTES;
  const mediaStatus: MediaStatus = !m.file ? "none" : tooBig ? "too_big" : "pending";
  const ack = person.role === "patient" ? ackFor(m.kind, m.text, m.ts, tooBig, m.editDate > 0) : null;
  const row: InboxRow = {
    update_id: m.updateId, chat_id: m.chatId, message_id: m.messageId, sender_id: m.sender, person_id: person.id,
    kind: m.kind, received_at: m.ts, raw: JSON.stringify(update), media_key: m.file ? `telegram/${m.file.uniqueId}` : null,
    media_status: mediaStatus, ack,
  };
  if (!(await io.store.insertInbox(row))) return ok(); // redelivery: already stored (and acked)

  if (m.file && mediaStatus === "pending") {
    try {
      const res = await io.tg.fetchFile(m.file.fileId);
      // Stream when the length is known (no copy through the isolate); otherwise buffer (<= 20 MB).
      const body = res.headers.get("content-length") && res.body ? res.body : await res.arrayBuffer();
      await io.putMedia(row.media_key!, body, m.file.mimeType);
      await io.store.setMediaStatus(m.updateId, "stored");
    } catch (err) {
      console.error("media copy failed; batch will fetch by file_id", m.updateId, safeErr(err));
    }
  }
  if (ack) await io.tg.sendText(m.chatId, ack, m.messageId).catch((err) => console.error("ack failed", m.updateId, safeErr(err)));
  return ok();
}

export function ackFor(kind: string, text: string | undefined, ts: string, tooBig: boolean, edited: boolean): string | null {
  if (tooBig) return ACK.tooBig;
  const v = kind === "text" ? parseVitals(text, ts) : { readings: [] };
  const body = v.readings.length ? vitalsEcho(v.readings) : kind === "image" ? ACK.image : kind === "document" ? ACK.document : kind === "audio" ? ACK.audio : kind === "text" ? ACK.text : null;
  return body && edited ? ACK.editPrefix + body : body;
}
