// Webhook assertion (auth-review §3.2): gate-aware URL check, delivery errors, failed calls; alerts reach the digest.
import { describe, expect, it } from "vitest";
import { TelegramAdapter, type WebhookInfo } from "../src/channel/telegram.js";
import { checkWebhook, expectedWebhookUrl, webhookProblems } from "../src/batch/webhook.js";
import { finish } from "../src/batch/steps.js";
import { Repo } from "../src/batch/repo.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeTelegram, GROUP, seededStore } from "./helpers.js";

const NOW = "2026-10-25T15:37:00.000Z";
const W = "https://hl.example.workers.dev";
const info = (o: Partial<WebhookInfo> = {}): WebhookInfo => ({ url: "", pendingUpdateCount: 0, ...o });
const sec = (iso: string) => Date.parse(iso) / 1000;

describe("webhook assertion", () => {
  it("before go-live: an empty URL is expected; any URL is a problem", () => {
    expect(webhookProblems(info(), { live: false, workerUrl: W, now: NOW })).toEqual([]);
    expect(webhookProblems(info(), { live: false, now: NOW })).toEqual([]);
    const p = webhookProblems(info({ url: `${W}/telegram/webhook` }), { live: false, workerUrl: W, now: NOW });
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/before go-live/);
  });
  it("after go-live: the URL must equal WORKER_URL + path", () => {
    expect(expectedWebhookUrl(`${W}/`)).toBe(`${W}/telegram/webhook`);
    expect(webhookProblems(info({ url: `${W}/telegram/webhook` }), { live: true, workerUrl: W, now: NOW })).toEqual([]);
    expect(webhookProblems(info({ url: "https://evil.test/hook" }), { live: true, workerUrl: W, now: NOW })[0]).toMatch(/mismatch: https:\/\/evil.test\/hook/);
    expect(webhookProblems(info(), { live: true, workerUrl: W, now: NOW })[0]).toMatch(/mismatch: \(none\)/);
    expect(webhookProblems(info({ url: `${W}/telegram/webhook` }), { live: true, now: NOW })[0]).toMatch(/WORKER_URL is not set/);
  });
  it("flags a recent delivery error, ignores one older than 48 h", () => {
    const ok = { url: `${W}/telegram/webhook` };
    expect(webhookProblems(info({ ...ok, lastErrorMessage: "Wrong response from the webhook: 500", lastErrorDate: sec(NOW) - 3600 }), { live: true, workerUrl: W, now: NOW })[0]).toMatch(/delivery error: Wrong response/);
    expect(webhookProblems(info({ ...ok, lastErrorMessage: "old", lastErrorDate: sec(NOW) - 72 * 3600 }), { live: true, workerUrl: W, now: NOW })).toEqual([]);
  });
  it("calls getWebhookInfo; a failed call is a problem, not a pass", async () => {
    const t = fakeTelegram();
    expect(await checkWebhook(t.tg, { live: false, now: NOW })).toEqual([]);
    expect(t.calls.map((c) => c.method)).toEqual(["getWebhookInfo"]);
    const down = new TelegramAdapter("x", (async () => Response.json({ ok: false }, { status: 401 })) as unknown as typeof fetch, "https://tg.test");
    expect((await checkWebhook(down, { live: false, now: NOW }))[0]).toMatch(/webhook check failed: telegram getWebhookInfo failed: 401/);
  });
  it("finish DMs alerts to the admins; the family group gets the digest only", async () => {
    const t = fakeTelegram();
    const repo = new Repo(mkdtempSync(join(tmpdir(), "hl-wh-")));
    await finish({ store: (await seededStore()).store, tg: t.tg, repo, now: NOW, digest: "📋 digest", retentionDays: 14, alerts: ["webhook URL mismatch: x ≠ y"] });
    expect(t.sent().map((c) => [String(c.body.chat_id), c.body.text])).toEqual([["222", "⚠ webhook URL mismatch: x ≠ y"], [GROUP, "📋 digest"]]);
  });
  it("no admin in the allowlist: alerts fall back to the family digest as ⚠ lines", async () => {
    const t = fakeTelegram();
    const repo = new Repo(mkdtempSync(join(tmpdir(), "hl-wh-")));
    const { db, store } = await seededStore();
    await db.prepare("UPDATE persons SET role = 'member'").run();
    await finish({ store, tg: t.tg, repo, now: NOW, digest: "📋 digest", retentionDays: 14, alerts: ["webhook URL mismatch: x ≠ y"] });
    expect(t.sent().map((c) => [String(c.body.chat_id), c.body.text])).toEqual([[GROUP, "📋 digest\n\n⚠ webhook URL mismatch: x ≠ y"]]);
  });
});
