// Ingest (ADR 005): the only always-on piece. Per Telegram update:
//   secret check -> allowlist (D1 chats, persons) -> INSERT OR IGNORE into inbox (key: update_id)
//   -> subject (name prefix, records aliases) -> copy media to R2 -> optional ack (ACK_MODE; default off; the echo
//   names who it was logged for). An admin's "/for <name>" reply re-attributes a row (DM feedback). No LLM, no alerts.
// Failure policy: if the inbox insert fails, answer 500 so Telegram redelivers (it keeps updates ~24 h).
// After the insert, answer 200 whatever happens: a failed media copy stays media_status 'pending' and the batch
// fetches it by file_id; a failed ack is only a missing reply. Never log message content or file URLs.

import { MAX_FILE_BYTES, parseUpdate, type TelegramAdapter, type TgUpdate, timingSafeEqual } from "./channel/telegram.js";
import type { InboxRow, MediaStatus, Store } from "./store.js";
import { displayOf, parseForCommand, resolveName, splitSubject } from "./subject.js";
import { parseVitals, vitalsEcho } from "./vitals.js";

/** Group replies (env ack_mode -> Worker var ACK_MODE). off: none at all, the daily digest shows what was recorded;
 *  vitals-only: the vitals echo (and the file-too-big notice); all: every ack. Unset or unknown = off. */
export type AckMode = "off" | "vitals-only" | "all";
export const parseAckMode = (v: string | undefined): AckMode => (v === "all" || v === "vitals-only" ? v : "off");

export interface IngestIO {
  ackMode?: AckMode;
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
  /** The echo names who the message was logged for, so the family can catch a wrong attribution. */
  subject: (name: string) => `${name}: `,
  forDone: (name: string) => `✓ ठीक किया: अब ${name} के लिए दर्ज`,
  forNoTarget: "/for: बॉट के जवाब (या उस संदेश) पर reply करके भेजें, जैसे /for maa",
  forUnknown: (name: string) => `/for: "${name.slice(0, 30)}" नाम नहीं मिला`,
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

  const aliases = await io.store.aliases();
  const forName = m.kind === "text" ? parseForCommand(m.text) : null;
  if (forName !== null) {
    // Admin correction: re-attribute the replied-to row (the member's original message, or the bot's echo of it).
    // The command itself is not an inbox row. Feedback goes to the admin by private DM, never to the group.
    if (person.role !== "admin") return ok(); // dropped: not stored, no reply
    const reply = (t: string) => io.tg.sendText(person.senderId, t).catch((err) => console.error("/for DM failed", m.updateId, safeErr(err)));
    const target = m.replyToMessageId ? await io.store.rowForReply(m.chatId, m.replyToMessageId) : null;
    if (!target) return (await reply(ACK.forNoTarget), ok());
    const who = resolveName(forName, aliases, (await io.store.persons()).map((p) => p.id));
    if (!who) return (await reply(ACK.forUnknown(forName)), ok());
    const fresh = await io.store.correctSubject({
      id: m.updateId, update_id: target.update_id, subject_id: who.personId, set_by: person.id, set_at: m.ts, reason: "telegram /for",
    });
    if (fresh) await reply(ACK.forDone(who.display));
    return ok();
  }

  const tooBig = !!m.file && (m.file.size ?? 0) > MAX_FILE_BYTES;
  const mediaStatus: MediaStatus = !m.file ? "none" : tooBig ? "too_big" : "pending";
  const { subject, rest } = splitSubject(m.text, aliases);
  const subjectId = subject?.personId ?? person.id;
  const name = subject?.display ?? displayOf(person.id, aliases) ?? person.name;
  const mode = io.ackMode ?? "off";
  const ack = mode === "off" ? null : ackFor(m.kind, rest, m.ts, tooBig, m.editDate > 0, name, mode === "vitals-only");
  const row: InboxRow = {
    update_id: m.updateId, chat_id: m.chatId, message_id: m.messageId, sender_id: m.sender, person_id: person.id,
    kind: m.kind, received_at: m.ts, raw: JSON.stringify(update), media_key: m.file ? `telegram/${m.file.uniqueId}` : null,
    media_status: mediaStatus, ack, subject_id: subjectId,
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
  if (ack) {
    try {
      const sentId = await io.tg.sendText(m.chatId, ack, m.messageId);
      if (sentId !== undefined) await io.store.setAckMessage(m.updateId, sentId); // lets an admin /for-reply to the echo
    } catch (err) {
      console.error("ack failed", m.updateId, safeErr(err));
    }
  }
  return ok();
}

/** `text` is the message without its name prefix; `subject` is who it was logged for (named in the echo). */
export function ackFor(kind: string, text: string | undefined, ts: string, tooBig: boolean, edited: boolean, subject?: string, vitalsOnly = false): string | null {
  if (tooBig) return ACK.tooBig;
  const v = kind === "text" ? parseVitals(text, ts) : { readings: [] };
  const body = v.readings.length ? vitalsEcho(v.readings) : vitalsOnly ? null : kind === "image" ? ACK.image : kind === "document" ? ACK.document : kind === "audio" ? ACK.audio : kind === "text" ? ACK.text : null;
  const named = body && subject ? ACK.subject(subject) + body : body;
  return named && edited ? ACK.editPrefix + named : named;
}
