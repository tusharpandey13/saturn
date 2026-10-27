// Cloudflare Worker entry (Workers FREE plan; ADR 005). Ingest only: see src/ingest.ts.
// Extraction, STT, the KB and the digest run in the daily batch (src/batch/), not here.
import { TelegramAdapter } from "./channel/telegram.js";
import { handleWebhook, parseAckMode } from "./ingest.js";
import { type Db, Store } from "./store.js";

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  /** off (default) | vitals-only | all: group replies (env.yaml ack_mode). */
  ACK_MODE?: string;
  /** Local e2e only: point the Telegram API at a stub. Leave unset in production. */
  TELEGRAM_API_BASE?: string;
}

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname !== "/telegram/webhook") return new Response("not found", { status: 404 });
    return handleWebhook(req, {
      secret: env.TELEGRAM_WEBHOOK_SECRET,
      ackMode: parseAckMode(env.ACK_MODE),
      store: new Store(env.DB as unknown as Db),
      tg: new TelegramAdapter(env.TELEGRAM_BOT_TOKEN, undefined, env.TELEGRAM_API_BASE),
      putMedia: async (key, body, mimeType) => void (await env.MEDIA.put(key, body, { httpMetadata: { contentType: mimeType } })),
    });
  },
} satisfies ExportedHandler<Env>;
