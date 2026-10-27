// Telegram Bot API: the parts the ingest Worker and the daily batch need (ADR 005).
// Input group(s) (members + bot; the bot is a group admin so it receives photos and voice notes). The bot never posts to a
// group (ADR 011); it writes only to admins by private chat.
// Never log or forward Telegram file URLs: they contain the bot token.

export const MAX_FILE_BYTES = 20 * 1024 * 1024; // Bot API getFile limit

// Minimal subset of the Bot API Update type.
interface TgFile { file_id: string; file_unique_id: string; file_size?: number; mime_type?: string }
export interface TgMessage {
  message_id: number;
  date: number;
  edit_date?: number;
  chat: { id: number };
  from?: { id: number; is_bot?: boolean };
  text?: string;
  caption?: string;
  photo?: (TgFile & { width: number; height: number })[];
  voice?: TgFile & { duration?: number };
  audio?: TgFile & { duration?: number };
  document?: TgFile & { file_name?: string };
  reply_to_message?: { message_id: number; text?: string; caption?: string };
  migrate_to_chat_id?: number;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
}

export type Kind = "text" | "audio" | "image" | "document" | "other";
export interface ParsedFile { fileId: string; uniqueId: string; mimeType: string; size?: number }

/** One inbound message, normalised. `key` (chat:message) is stable across edits; it is the KB message id. */
export interface ParsedMessage {
  updateId: number;
  key: string;
  chatId: string;
  messageId: number;
  sender: string;
  kind: Kind;
  text?: string;
  /** Text of the message this one replies to (e.g. a digest question), when Telegram includes it. */
  replyToText?: string;
  /** Id of the message this one replies to (e.g. a bot echo, for the admin's /for correction). */
  replyToMessageId?: number;
  /** ISO time the message was sent (for an edit: the original send time). */
  ts: string;
  /** Unix seconds of the latest edit; 0 for an unedited message. */
  editDate: number;
  durationSec?: number;
  file?: ParsedFile;
}

export type TgEvent = { type: "message"; msg: ParsedMessage } | { type: "migrate"; fromChatId: string; toChatId: string };

/** Pure: Telegram update -> normalised event, or null if irrelevant (bots, service messages). */
export function parseUpdate(u: TgUpdate): TgEvent | null {
  const m = u.message ?? u.edited_message;
  if (!m) return null;
  const chatId = String(m.chat.id);
  if (m.migrate_to_chat_id) return { type: "migrate", fromChatId: chatId, toChatId: String(m.migrate_to_chat_id) };
  if (!m.from || m.from.is_bot) return null;

  const reply = m.reply_to_message;
  const base = {
    updateId: u.update_id, key: `${chatId}:${m.message_id}`, chatId, messageId: m.message_id, sender: String(m.from.id),
    text: m.text ?? m.caption, ts: new Date(m.date * 1000).toISOString(), editDate: m.edit_date ?? 0,
    ...(reply && (reply.text ?? reply.caption) ? { replyToText: reply.text ?? reply.caption } : {}),
    ...(reply ? { replyToMessageId: reply.message_id } : {}),
  };
  const file = (f: TgFile, mimeType: string): ParsedFile => ({ fileId: f.file_id, uniqueId: f.file_unique_id, mimeType, size: f.file_size });
  const msg = (kind: Kind, extra: Partial<ParsedMessage> = {}): TgEvent => ({ type: "message", msg: { ...base, kind, ...extra } });

  const a = m.voice ?? m.audio;
  if (a) return msg("audio", { durationSec: a.duration, file: file(a, a.mime_type ?? "audio/ogg") });
  if (m.photo?.length) return msg("image", { file: file(m.photo[m.photo.length - 1], "image/jpeg") }); // last = largest
  if (m.document) {
    const mime = m.document.mime_type ?? "";
    if (mime === "application/pdf") return msg("document", { file: file(m.document, mime) });
    if (/^image\/(jpeg|png|webp|gif)$/.test(mime)) return msg("image", { file: file(m.document, mime) });
    return msg("other");
  }
  if (m.text) return msg("text");
  return msg("other"); // stickers, videos, locations, ...: kept raw, not acked, not extracted
}

export interface WebhookInfo { url: string; pendingUpdateCount: number; lastErrorDate?: number; lastErrorMessage?: string }

export class TelegramAdapter {
  constructor(
    private token: string,
    private fetchFn: typeof fetch = (...a) => fetch(...a),
    private apiBase = "https://api.telegram.org", // overridable for local tests only
  ) {}

  private async api(method: string, body: unknown): Promise<any> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.apiBase}/bot${this.token}/${method}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
    } catch {
      throw new Error(`telegram ${method}: network error`); // the original error may contain the tokenised URL
    }
    const json: any = await res.json().catch(() => ({}));
    if (!json.ok) throw new Error(`telegram ${method} failed: ${res.status}`);
    return json.result;
  }

  /** Returns the sent message's id (when Telegram reports it). */
  async sendText(chatId: string, text: string, replyTo?: number): Promise<number | undefined> {
    const r = await this.api("sendMessage", {
      chat_id: chatId, text,
      ...(replyTo && { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }),
    });
    return typeof r?.message_id === "number" ? r.message_id : undefined;
  }

  /** Where Telegram delivers updates. The batch asserts it (src/batch/webhook.ts) to detect a setWebhook hijack. */
  async getWebhookInfo(): Promise<WebhookInfo> {
    const r = await this.api("getWebhookInfo", {});
    return { url: typeof r?.url === "string" ? r.url : "", pendingUpdateCount: r?.pending_update_count ?? 0, lastErrorDate: r?.last_error_date, lastErrorMessage: r?.last_error_message };
  }

  /** getFile + download. Returns the raw Response so the Worker can stream the body into R2. */
  async fetchFile(fileId: string): Promise<Response> {
    const { file_path } = await this.api("getFile", { file_id: fileId });
    let res: Response;
    try {
      res = await this.fetchFn(`${this.apiBase}/file/bot${this.token}/${file_path}`);
    } catch {
      throw new Error("telegram file download: network error");
    }
    if (!res.ok) throw new Error(`telegram file download failed: ${res.status}`);
    return res;
  }
}

export function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
