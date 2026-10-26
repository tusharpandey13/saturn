// Webhook assertion (auth-review §3.2, rec. 5): the bot token can repoint the webhook anywhere (setWebhook), which would
// silently intercept every new family message. The daily batch checks getWebhookInfo and fails loudly on a mismatch.
// Gate-aware (app/DEPLOY.md, GO-LIVE GATE): before go-live (repo variable GO_LIVE != true) the URL must be EMPTY, since
// any URL is a hijack or a premature setWebhook; after go-live it must equal WORKER_URL + WEBHOOK_PATH.
import type { WebhookInfo } from "../channel/telegram.js";

export const WEBHOOK_PATH = "/telegram/webhook";
/** A delivery error older than this is history, not a live problem (Telegram keeps the last one indefinitely). */
const ERROR_WINDOW_SEC = 48 * 3600;

export interface WebhookExpectation {
  /** The GO-LIVE GATE is open (repo variable GO_LIVE=true). */
  live: boolean;
  workerUrl?: string;
  now: string;
}

export function expectedWebhookUrl(workerUrl: string | undefined): string | null {
  return workerUrl ? `${workerUrl.replace(/\/+$/, "")}${WEBHOOK_PATH}` : null;
}

/** Problems with the webhook, as digest lines (URLs only, never the token). Empty = fine. */
export function webhookProblems(info: WebhookInfo, o: WebhookExpectation): string[] {
  const out: string[] = [];
  const want = expectedWebhookUrl(o.workerUrl);
  if (!o.live) {
    if (info.url) out.push(`webhook is set before go-live (${info.url}); expected none. Possible hijack: deleteWebhook, rotate the bot token.`);
  } else if (!want) {
    out.push("webhook check: WORKER_URL is not set; cannot verify the webhook URL.");
  } else if (info.url !== want) {
    out.push(`webhook URL mismatch: ${info.url || "(none)"} ≠ ${want}. Possible hijack or lost webhook: check now (app/DEPLOY.md, Roll back).`);
  }
  const age = info.lastErrorDate ? Date.parse(o.now) / 1000 - info.lastErrorDate : 0;
  if (info.lastErrorMessage && age <= ERROR_WINDOW_SEC) out.push(`webhook delivery error: ${info.lastErrorMessage.slice(0, 200)}`);
  return out;
}

/** getWebhookInfo + webhookProblems. A failed call is itself a problem: fail loudly, never pass silently. */
export async function checkWebhook(tg: { getWebhookInfo(): Promise<WebhookInfo> }, o: WebhookExpectation): Promise<string[]> {
  let info: WebhookInfo;
  try {
    info = await tg.getWebhookInfo();
  } catch (err) {
    return [`webhook check failed: ${(err as Error).message}`];
  }
  return webhookProblems(info, o);
}
