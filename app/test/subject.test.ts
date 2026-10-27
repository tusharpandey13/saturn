// Subject attribution (ADR 009): name prefixes, ack modes, the admin's /for correction, records overrides, the batch.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FOR_HINT, VIA } from "../src/batch/digest.js";
import { loadThresholds, parseRecordsYaml } from "../src/batch/records.js";
import { Repo } from "../src/batch/repo.js";
import { extract, pull, usualSubject } from "../src/batch/steps.js";
import { ACK, handleWebhook, parseAckMode } from "../src/ingest.js";
import { aliasesFromRecords, parseForCommand, resolveName, splitSubject } from "../src/subject.js";
import { oneByOne } from "../../adapters/llm/claude-cli.js";
import type { Person } from "../src/types.js";
import worker from "../src/worker.js";
import { ALIASES, dmUpdate, fakeTelegram, GROUP, ingestIO, seededStore, textUpdate, webhook } from "./helpers.js";

const ROOT = join(import.meta.dirname, "..", "..");
const EXAMPLE = join(ROOT, "fixtures", "records-example");
const NOW = "2026-10-25T15:30:00.000Z";
const inbox = async (db: any) => (await db.prepare("SELECT * FROM inbox ORDER BY update_id").all()).results as any[];
const PERSONS = new Map<string, Person>([
  ["alice", { id: "alice", name: "Alice", role: "member", senderId: "111" }],
  ["bob", { id: "bob", name: "Bob", role: "member", senderId: "333" }],
  ["carol-tg", { id: "carol-tg", name: "Carol", role: "admin", senderId: "222" }],
]);
const none = { readings: [], symptoms: [], media_kind: "none", confidence: 0.9, unreadable_reason: null, subject_hint: null };
const llm = oneByOne(async () => none, "mock");
const reply = (text: string, from: number, to: number) => textUpdate(text, from, { reply_to_message: { message_id: to } });

describe("splitSubject / parseForCommand", () => {
  it("a leading alias (any case, NFC, Devanagari) names the subject; the rest is the message", () => {
    expect(splitSubject("ali 116/47", ALIASES)).toMatchObject({ subject: { personId: "alice", display: "Alice" }, rest: "116/47" });
    expect(splitSubject("Ali ka BP 120/80", ALIASES)).toMatchObject({ subject: { personId: "alice" }, rest: "BP 120/80" });
    expect(splitSubject("ALICE: 120/80 72", ALIASES)).toMatchObject({ subject: { alias: "alice" }, rest: "120/80 72" });
    expect(splitSubject("एलिस की sugar 110", ALIASES)).toMatchObject({ subject: { personId: "alice" }, rest: "sugar 110" });
    expect(splitSubject("bob", ALIASES)).toMatchObject({ subject: { personId: "bob" }, rest: "" });
  });
  it("no prefix: no subject, text unchanged (a word that only starts with an alias does not count)", () => {
    expect(splitSubject("alibaba 120/80", ALIASES)).toEqual({ subject: null, rest: "alibaba 120/80" });
    expect(splitSubject("120/80 ali", ALIASES)).toEqual({ subject: null, rest: "120/80 ali" });
    expect(splitSubject(undefined, ALIASES)).toEqual({ subject: null, rest: undefined });
  });
  it("/for <name>, resolved by alias, display name or person id", () => {
    expect(parseForCommand("/for ali")).toBe("ali");
    expect(parseForCommand("/for@saturn_bot  Bob ")).toBe("Bob");
    expect(parseForCommand("for ali")).toBeNull();
    expect(resolveName("ALI", ALIASES, ["alice", "bob"])).toEqual({ personId: "alice", display: "Alice" });
    expect(resolveName("carol-tg", ALIASES, ["carol-tg"])).toEqual({ personId: "carol-tg", display: "Carol" });
    expect(resolveName("zed", ALIASES, ["alice"])).toBeNull();
  });
  it("records.yaml aliases: parsed per namespace and keyed by D1 person id (inverse d1_person_map)", () => {
    const y = parseRecordsYaml("schema_version: 7\nnamespaces:\n  - id: alice\n    display: Alice\n  - id: carol\n    display: Carol\nd1_person_map:\n  carol-tg: carol\naliases:\n  alice: [ali, \"एलिस\"]\n  carol: carol\n");
    expect(y.aliases).toEqual({ alice: ["ali", "एलिस"], carol: ["carol"] });
    expect(aliasesFromRecords(y.aliases, y.display, y.d1PersonMap)).toEqual([
      { alias: "ali", personId: "alice", display: "Alice" }, { alias: "एलिस", personId: "alice", display: "Alice" },
      { alias: "carol", personId: "carol-tg", display: "Carol" },
    ]);
  });
  it("ack_mode: unset or unknown is off", () => {
    expect([undefined, "", "on", "off", "vitals-only", "all"].map(parseAckMode)).toEqual(["off", "off", "off", "off", "vitals-only", "all"]);
  });
});

describe("ingest: subject and ack mode", () => {
  it("a name prefix sets subject_id (the sender stays person_id); group: no echo even with ack_mode all", async () => {
    const { db, store } = await seededStore();
    const t = fakeTelegram();
    await handleWebhook(webhook(textUpdate("ali 116/47", 333)), ingestIO(store, t.tg));
    expect((await inbox(db))[0]).toMatchObject({ person_id: "bob", subject_id: "alice", ack: null, ack_message_id: null });
    expect(t.sent()).toEqual([]);
  });

  it("an admin's private chat: the prefix echo names who it was logged for", async () => {
    const { db, store } = await seededStore();
    const t = fakeTelegram();
    await handleWebhook(webhook(dmUpdate("ali 116/47", 222)), ingestIO(store, t.tg));
    expect((await inbox(db))[0]).toMatchObject({ person_id: "carol-tg", subject_id: "alice", ack: "Alice: BP 116/47 ✓", ack_message_id: 1 });
    expect(t.sent().map((c) => [String(c.body.chat_id), c.body.text])).toEqual([["222", "Alice: BP 116/47 ✓"]]);
  });

  it("ack off: no outbound message at all (vitals, text, media, too big); attribution still recorded", async () => {
    const { db, store } = await seededStore();
    const t = fakeTelegram();
    const io = ingestIO(store, t.tg, undefined, "off");
    const big = { update_id: 4999, message: { message_id: 4999, date: 1792814400, chat: { id: Number(GROUP) }, from: { id: 111 }, document: { file_id: "d", file_unique_id: "u-d", mime_type: "application/pdf", file_size: 30 * 1024 * 1024 } } };
    const photo = { update_id: 4998, message: { message_id: 4998, date: 1792814400, chat: { id: Number(GROUP) }, from: { id: 111 }, photo: [{ file_id: "p", file_unique_id: "u-p", width: 9, height: 9 }] } };
    for (const u of [textUpdate("ali 116/47", 333), textUpdate("aaj chakkar aaya"), photo, big]) expect((await handleWebhook(webhook(u), io)).status).toBe(200);
    expect(t.calls.filter((c) => c.method === "sendMessage")).toEqual([]);
    const rows = await inbox(db);
    expect(rows.map((r) => [r.person_id, r.subject_id, r.ack])).toEqual([["alice", "alice", null], ["alice", "alice", null], ["bob", "alice", null], ["alice", "alice", null]]);
    expect(rows.find((r) => r.update_id === 4998).media_status).toBe("stored");
  });

  it("vitals-only (admin private chat): the vitals echo, nothing else; the group still gets nothing", async () => {
    const { store } = await seededStore();
    const t = fakeTelegram();
    const io = ingestIO(store, t.tg, undefined, "vitals-only");
    await handleWebhook(webhook(dmUpdate("aaj chakkar aaya", 222)), io);
    await handleWebhook(webhook(dmUpdate("120/80 72", 222)), io);
    await handleWebhook(webhook(textUpdate("120/80 72")), io);
    expect(t.sent().map((c) => [String(c.body.chat_id), c.body.text])).toEqual([["222", "Carol: BP 120/80, pulse 72 ✓"]]);
  });
});

describe("Worker: ACK_MODE", () => {
  it("unset (the default) sends nothing; the row is still stored", async () => {
    const { db, store } = await seededStore();
    const t = fakeTelegram();
    const env = { DB: db, TELEGRAM_BOT_TOKEN: "x", TELEGRAM_WEBHOOK_SECRET: "webhook-secret", TELEGRAM_API_BASE: "https://tg.test", MEDIA: {} } as any;
    const orig = globalThis.fetch;
    globalThis.fetch = t.fetchFn;
    try {
      expect((await worker.fetch(webhook(textUpdate("120/80 72")) as any, env)).status).toBe(200);
    } finally {
      globalThis.fetch = orig;
    }
    expect(t.calls).toEqual([]);
    expect((await store.newInbox()).map((r) => r.ack)).toEqual([null]);
    void db;
  });
});

describe("ingest: the admin's /for correction", () => {
  it("ack off: replying to the ORIGINAL member message re-attributes it; recorded with who and when; DM feedback only", async () => {
    const { db, store } = await seededStore();
    const t = fakeTelegram();
    const io = ingestIO(store, t.tg, undefined, "off");
    const orig = textUpdate("116/47", 333); // bob sent alice's BP without a prefix
    await handleWebhook(webhook(orig), io);
    const cmd = reply("/for ali", 222, orig.message!.message_id);
    await handleWebhook(webhook(cmd), io);
    await handleWebhook(webhook(cmd), io); // redelivery: no second correction, no second DM
    const rows = await inbox(db);
    expect(rows.map((r) => [r.update_id, r.person_id, r.subject_id])).toEqual([[orig.update_id, "bob", "alice"]]); // the command is not an inbox row
    expect(await store.corrections()).toEqual([{ id: cmd.update_id, update_id: orig.update_id, subject_id: "alice", set_by: "carol-tg", set_at: new Date(cmd.message!.date * 1000).toISOString(), reason: "telegram /for" }]);
    expect(t.sent().map((c) => [String(c.body.chat_id), c.body.text])).toEqual([["222", ACK.forDone("Alice")]]); // private DM, not the group
  });

  it("ack all: still no echo in the group; /for on the original works and replies by DM only", async () => {
    const { db, store } = await seededStore();
    const t = fakeTelegram();
    const io = ingestIO(store, t.tg);
    const orig = textUpdate("116/47", 333);
    await handleWebhook(webhook(orig), io);
    await handleWebhook(webhook(reply("/for alice", 222, orig.message!.message_id)), io);
    expect((await inbox(db))[0]).toMatchObject({ person_id: "bob", subject_id: "alice" });
    expect(t.sent().map((c) => String(c.body.chat_id))).toEqual(["222"]);
  });

  it("a member's /for is dropped silently; an unknown name or no reply target gets a DM to the admin", async () => {
    const { db, store } = await seededStore();
    const t = fakeTelegram();
    const io = ingestIO(store, t.tg, undefined, "off");
    const orig = textUpdate("116/47", 333);
    await handleWebhook(webhook(orig), io);
    await handleWebhook(webhook(reply("/for ali", 111, orig.message!.message_id)), io);
    await handleWebhook(webhook(reply("/for zed", 222, orig.message!.message_id)), io);
    await handleWebhook(webhook(textUpdate("/for ali", 222)), io);
    expect((await inbox(db)).map((r) => r.subject_id)).toEqual(["bob"]);
    expect(await store.corrections()).toEqual([]);
    expect(t.sent().map((c) => [String(c.body.chat_id), c.body.text])).toEqual([["222", ACK.forUnknown("zed")], ["222", ACK.forNoTarget]]);
  });
});

describe("batch: subject namespace, sender provenance, overrides", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "saturn-subj-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const repoOf = () => new Repo(root, { "carol-tg": "carol" });
  const run = (repo: Repo) => extract({ repo, extractor: llm, stt: null, thresholds: loadThresholds(EXAMPLE), persons: PERSONS, now: NOW, aliases: ALIASES });
  const kb = () => {
    execFileSync("python3", ["-I", join(ROOT, "tools", "kb", "build"), "--records", EXAMPLE, "--telegram", join(root, "data", "telegram"), "--db", join(root, "kb.sqlite")], { encoding: "utf8" });
    return new DatabaseSync(join(root, "kb.sqlite"));
  };

  it("prefix: extracted into the subject; the sender kept; the digest shows the attribution line", async () => {
    const { store } = await seededStore();
    const t = fakeTelegram();
    const u = textUpdate("ali 116/47", 333);
    await handleWebhook(webhook(u), ingestIO(store, t.tg, undefined, "off"));
    const repo = repoOf();
    await pull({ store, r2: { get: async () => { throw new Error("none"); } }, tg: t.tg, repo, aliases: ALIASES });
    const r = await run(repo);
    const key = `${GROUP}:${u.message!.message_id}`;
    const rows = repo.kbRows();
    expect(rows.find((x) => x.id === key)).toMatchObject({ person_id: "alice", sender_person_id: "bob", subject_source: "prefix", extraction_status: "ok" });
    expect(rows.find((x) => x.rt === "d1.readings")).toMatchObject({ person_id: "alice", type: "bp", value: 116, value2: 47, extracted_by: "vitals-parser" });
    expect(r.digest).toContain("\nAlice\n");
    expect(r.digest).toContain(`BP 116/47${VIA("Bob", "Alice")}`);
    expect(r.digest).toContain(FOR_HINT);
    const db = kb();
    expect(db.prepare("SELECT ns, tags FROM fact").all()).toContainEqual({ ns: "alice", tags: JSON.stringify(["family-reported"]) });
    const src = db.prepare("SELECT identifiers, note FROM source WHERE kind = 'telegram_msg'").get() as any;
    expect(JSON.parse(src.identifiers).reported_by).toBe("bob");
    expect(src.note).toContain("reported by bob for alice");
    db.close();
  });

  it("an admin /for in D1 is copied to subject-overrides.ndjson by pull, and the batch honours it", async () => {
    const { store } = await seededStore();
    const t = fakeTelegram();
    const io = ingestIO(store, t.tg, undefined, "off");
    const orig = textUpdate("116/47", 333);
    await handleWebhook(webhook(orig), io);
    const repo = repoOf();
    const r2 = { get: async () => { throw new Error("none"); } };
    await pull({ store, r2, tg: t.tg, repo, aliases: ALIASES });
    await run(repo);
    expect(repo.kbRows().find((x) => x.rt === "d1.readings")).toMatchObject({ person_id: "bob" }); // before the correction
    const cmd = reply("/for ali", 222, orig.message!.message_id);
    await handleWebhook(webhook(cmd), io);
    expect((await pull({ store, r2, tg: t.tg, repo, aliases: ALIASES })).overrides).toBe(1);
    expect((await pull({ store, r2, tg: t.tg, repo, aliases: ALIASES })).overrides).toBe(0); // idempotent
    expect(repo.subjectOverrides()).toEqual([{ id: `tg-for:${cmd.update_id}`, update_id: orig.update_id, subject: "alice", set_by: "carol", set_at: new Date(cmd.message!.date * 1000).toISOString(), reason: "telegram /for" }]);
    expect((await run(repo)).extracted).toBe(1); // re-extracted into the new subject
    const rows = repo.kbRows();
    expect(rows.filter((x) => x.rt === "d1.readings").map((x) => x.person_id)).toEqual(["alice"]);
    expect(rows.find((x) => x.rt === "d1.messages")).toMatchObject({ person_id: "alice", sender_person_id: "bob", subject_source: "override", subject_set_by: "carol" });
    expect((await run(repo)).extracted).toBe(0);
  });

  it("a hand-written records override (no D1 correction) re-attributes a row; the KB build accepts the file", async () => {
    const { store } = await seededStore();
    const t = fakeTelegram();
    const orig = textUpdate("116/47", 333);
    await handleWebhook(webhook(orig), ingestIO(store, t.tg, undefined, "off"));
    const repo = repoOf();
    await pull({ store, r2: { get: async () => { throw new Error("none"); } }, tg: t.tg, repo });
    mkdirSync(join(root, "data", "telegram"), { recursive: true });
    writeFileSync(join(root, "data", "telegram", "subject-overrides.ndjson"),
      JSON.stringify({ update_id: orig.update_id, subject: "alice", set_by: "carol", set_at: "2026-10-27", reason: "user: bob sent alice's metrics from his phone" }) + "\n");
    await run(repo);
    expect(repo.kbRows().find((x) => x.rt === "d1.readings")).toMatchObject({ person_id: "alice", value: 116 });
    kb().close();
    writeFileSync(join(root, "data", "telegram", "subject-overrides.ndjson"), JSON.stringify({ update_id: "x", subject: "nobody" }) + "\n");
    expect(() => kb()).toThrow();
  });

  it("no prefix from a sender who usually logs for someone else: kept with the sender, flagged subject_hint", async () => {
    const { store } = await seededStore();
    const t = fakeTelegram();
    const io = ingestIO(store, t.tg, undefined, "off");
    const repo = repoOf();
    for (const u of [textUpdate("ali 120/80", 333), textUpdate("ali 118/76", 333), textUpdate("116/47", 333)]) await handleWebhook(webhook(u), io);
    await pull({ store, r2: { get: async () => { throw new Error("none"); } }, tg: t.tg, repo });
    const first = await run(repo); // the two prefixed ones come first in history only after this run
    expect(first.extracted).toBe(3);
    const msgs = repo.kbRows().filter((x) => x.rt === "d1.messages");
    expect(msgs.map((m) => [m.person_id, m.subject_hint])).toEqual([["alice", null], ["alice", null], ["bob", null]]);
    expect(usualSubject(msgs, "bob", (id) => PERSONS.get(id)!.name)).toBe("Alice");
    expect(usualSubject(msgs, "alice", (id) => id)).toBeNull();
    // the next unprefixed message from bob is checked
    await handleWebhook(webhook(textUpdate("110/70", 333)), io);
    await pull({ store, r2: { get: async () => { throw new Error("none"); } }, tg: t.tg, repo });
    const r = await run(repo);
    const last = repo.kbRows().filter((x) => x.rt === "d1.messages").at(-1)!;
    expect(last).toMatchObject({ person_id: "bob", subject_hint: "Alice" });
    expect(r.digest).toContain('may be about "Alice"');
    expect(repo.queue().at(-1)).toMatchObject({ reasons: ["subject_hint"], person_id: "bob" });
  });
});

describe("records-example and the env contract", () => {
  it("the example records carry aliases for every person namespace", () => {
    const y = parseRecordsYaml(readFileSync(join(EXAMPLE, "records.yaml"), "utf8"));
    expect(Object.keys(y.aliases).sort()).toEqual(["alice", "bob", "carol"]);
  });
});
