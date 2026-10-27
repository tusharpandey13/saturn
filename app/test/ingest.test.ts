import { describe, expect, it } from "vitest";
import { parseUpdate } from "../src/channel/telegram.js";
import { ACK, handleWebhook } from "../src/ingest.js";
import { openSqlite } from "../src/dev/sqlite-d1.js";
import { Store } from "../src/store.js";
import { dmUpdate, fakeTelegram, fixture, GROUP, ingestIO, seededStore, textUpdate, TOKEN, webhook } from "./helpers.js";

const inbox = async (db: any) => (await db.prepare("SELECT * FROM inbox ORDER BY update_id").all()).results as any[];

describe("parseUpdate", () => {
  it("text, photo (largest), voice, PDF; other documents are kind other", () => {
    expect(parseUpdate(fixture("text"))).toMatchObject({ type: "message", msg: { kind: "text", text: "wajan 62.4", key: `${GROUP}:11`, editDate: 0 } });
    expect(parseUpdate(fixture("photo"))).toMatchObject({ msg: { kind: "image", text: "subah ka BP", file: { fileId: "large", uniqueId: "u-large" } } });
    expect(parseUpdate(fixture("voice"))).toMatchObject({ msg: { kind: "audio", durationSec: 7, file: { mimeType: "audio/ogg" } } });
    expect(parseUpdate(fixture("document-pdf"))).toMatchObject({ msg: { kind: "document", file: { mimeType: "application/pdf" } } });
    expect(parseUpdate(fixture("document-zip"))).toMatchObject({ msg: { kind: "other" } });
    expect(parseUpdate(fixture("migrate"))).toEqual({ type: "migrate", fromChatId: "-4012345", toChatId: GROUP });
  });

  it("an edit keeps the message key and carries edit_date and the reply context", () => {
    const u = { update_id: 9, edited_message: { message_id: 11, date: 1792814400, edit_date: 1792814500, chat: { id: Number(GROUP) }, from: { id: 111 }, text: "wajan 62", reply_to_message: { message_id: 3, text: "❓ 1. ..." } } };
    expect(parseUpdate(u)).toMatchObject({ msg: { key: `${GROUP}:11`, editDate: 1792814500, replyToText: "❓ 1. ..." } });
  });
});

describe("webhook", () => {
  it("rejects a wrong or missing secret, non-POST and bad JSON", async () => {
    const { store } = await seededStore();
    const io = ingestIO(store, fakeTelegram().tg);
    expect((await handleWebhook(webhook(fixture("text"), "nope"), io)).status).toBe(401);
    expect((await handleWebhook(webhook(fixture("text"), ""), io)).status).toBe(401);
    expect((await handleWebhook(new Request("https://w.test/telegram/webhook"), io)).status).toBe(405);
    const bad = new Request("https://w.test/x", { method: "POST", headers: { "x-telegram-bot-api-secret-token": io.secret }, body: "{" });
    expect((await handleWebhook(bad, io)).status).toBe(400);
  });

  it("stores the raw update, never replies in the group (even with ack_mode all), and is idempotent on update_id", async () => {
    const { db, store } = await seededStore();
    const t = fakeTelegram();
    const io = ingestIO(store, t.tg);
    const u = textUpdate("120/80 72");
    expect((await handleWebhook(webhook(u), io)).status).toBe(200);
    expect((await handleWebhook(webhook(u), io)).status).toBe(200); // Telegram redelivery
    const rows = await inbox(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ update_id: u.update_id, person_id: "alice", kind: "text", status: "new", media_status: "none", ack: null, subject_id: "alice" });
    expect(JSON.parse(rows[0].raw)).toEqual(u);
    expect(t.calls.filter((c) => c.method === "sendMessage")).toEqual([]);
  });

  it("an admin's private chat is an input chat: stored, acked there (ack_mode), an edit marked; plain English", async () => {
    const { db, store } = await seededStore();
    const t = fakeTelegram();
    await handleWebhook(webhook(dmUpdate("120/80 72", 222)), ingestIO(store, t.tg));
    await handleWebhook(webhook(dmUpdate("aaj thoda chakkar aaya", 222)), ingestIO(store, t.tg));
    await handleWebhook(webhook({ update_id: 77, edited_message: { message_id: 76, date: 1792814400, edit_date: 1792814460, chat: { id: 222 }, from: { id: 222 }, text: "wajan 61" } }), ingestIO(store, t.tg));
    expect(t.sent().map((c) => [String(c.body.chat_id), c.body.text])).toEqual([["222", "Carol: BP 120/80, pulse 72 ✓"], ["222", `Carol: ${ACK.text}`], ["222", `${ACK.editPrefix}Carol: weight 61 kg ✓`]]);
    expect((await inbox(db)).map((r) => [r.chat_id, r.person_id])).toEqual([["222", "carol-tg"], ["222", "carol-tg"], ["222", "carol-tg"]]);
    expect(t.sent().every((c) => !/[\u0900-\u097F]/.test(c.body.text))).toBe(true); // no Hindi in bot output
  });

  it("a member's or a stranger's private chat is not an input chat: dropped, no reply", async () => {
    const { db, store } = await seededStore();
    const t = fakeTelegram();
    await handleWebhook(webhook(dmUpdate("120/80 72", 111)), ingestIO(store, t.tg));
    await handleWebhook(webhook(dmUpdate("hello", 999)), ingestIO(store, t.tg));
    expect(await inbox(db)).toEqual([]);
    expect(t.calls).toEqual([]);
  });

  it("copies media to R2 at ingest; no group reply", async () => {
    const { db, store } = await seededStore();
    const t = fakeTelegram({ large: new Uint8Array([0xff, 0xd8, 0xff]) });
    const io = ingestIO(store, t.tg);
    await handleWebhook(webhook(fixture("photo")), io);
    expect(io.r2.objects.get("telegram/u-large")).toEqual({ data: new Uint8Array([0xff, 0xd8, 0xff]), mimeType: "image/jpeg" });
    expect((await inbox(db))[0]).toMatchObject({ kind: "image", media_key: "telegram/u-large", media_status: "stored" });
    expect(t.sent()).toEqual([]);
  });

  it("a failed media copy still answers 200 and leaves media_status pending for the batch", async () => {
    const { db, store } = await seededStore();
    const t = fakeTelegram({}, { failFile: true });
    const res = await handleWebhook(webhook(fixture("voice")), ingestIO(store, t.tg));
    expect(res.status).toBe(200);
    expect((await inbox(db))[0]).toMatchObject({ kind: "audio", media_status: "pending" });
    expect(t.sent()).toEqual([]);
  });

  it("files over 20 MB are not downloaded; nothing is posted in the group (the admin digest asks)", async () => {
    const { db, store } = await seededStore();
    const t = fakeTelegram();
    const big = fixture("document-pdf");
    big.message!.document!.file_size = 25 * 1024 * 1024;
    await handleWebhook(webhook(big), ingestIO(store, t.tg));
    expect(t.calls.some((c) => c.method === "getFile")).toBe(false);
    expect((await inbox(db))[0].media_status).toBe("too_big");
    expect(t.sent()).toEqual([]);
  });

  it("ignores other chats and strangers; an admin's group messages are stored like any member's, no reply", async () => {
    const { db, store } = await seededStore();
    const t = fakeTelegram();
    const io = ingestIO(store, t.tg);
    await handleWebhook(webhook(fixture("other-chat")), io);
    await handleWebhook(webhook(fixture("stranger")), io);
    await handleWebhook(webhook(textUpdate("main kal aa raha hoon", 222)), io);
    expect((await inbox(db)).map((r) => r.person_id)).toEqual(["carol-tg"]);
    expect(t.sent()).toEqual([]);
  });

  it("stickers and other files are stored raw but not acked", async () => {
    const { db, store } = await seededStore();
    const t = fakeTelegram();
    await handleWebhook(webhook(fixture("document-zip")), ingestIO(store, t.tg));
    expect((await inbox(db))[0]).toMatchObject({ kind: "other", media_status: "none" });
    expect(t.sent()).toEqual([]);
  });

  it("migrate_to_chat_id moves the allowlisted chat id", async () => {
    const store = new Store(openSqlite());
    await store.addChat("-4012345", "telegram", "family");
    await handleWebhook(webhook(fixture("migrate")), ingestIO(store, fakeTelegram().tg));
    expect(await store.isAllowedChat("-4012345")).toBe(false);
    expect(await store.isAllowedChat(GROUP)).toBe(true);
  });

  it("D1 down: answers 500 so Telegram redelivers", async () => {
    const { store } = await seededStore();
    const broken = { ...store, isAllowedChat: async () => { throw new Error("D1_ERROR"); } } as unknown as Store;
    expect((await handleWebhook(webhook(textUpdate("spo2 96")), ingestIO(broken, fakeTelegram().tg))).status).toBe(500);
  });

  it("a failed ack does not fail the update; logs never contain the bot token", async () => {
    const { db, store } = await seededStore();
    const logs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void logs.push(a.join(" "));
    try {
      const res = await handleWebhook(webhook(fixture("photo")), ingestIO(store, fakeTelegram({}, { failFile: true, failSend: true }).tg));
      expect(res.status).toBe(200);
    } finally {
      console.error = orig;
    }
    expect((await inbox(db))).toHaveLength(1);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join("\n")).not.toContain(TOKEN.split(":")[1]);
  });
});
