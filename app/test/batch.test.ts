// Daily batch tests, including the local end-to-end run:
// fake Telegram updates -> real Worker fetch handler -> D1 inbox (node:sqlite) + R2 (memory)
// -> pull -> extract (LLM mocked, STT stubbed) -> NDJSON -> tools/kb/build -> digest text -> finish.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANNOTATION_NOTE, STT_PENDING_NOTE } from "../src/batch/digest.js";
import { Repo } from "../src/batch/repo.js";
import { DIGEST_FAILED, extract, finish, isTransient, pull, splitMessage } from "../src/batch/steps.js";
import { DEFAULT_THRESHOLDS } from "../src/config/thresholds.js";
import { ClaudeCliError, type ExtractInput, type Extractor, ExtractorStopError, oneByOne } from "../../adapters/llm/claude-cli.js";
import { StubSpeechToText } from "../../adapters/stt/sarvam.js";
import type { Person } from "../src/types.js";
import worker from "../src/worker.js";
import { fakeTelegram, fixture, GROUP, memR2, SECRET, seededStore, textUpdate, webhook } from "./helpers.js";

const NOW = "2026-10-25T15:30:00.000Z"; // 21:00 IST
const PERSONS = new Map<string, Person>([
  ["alice", { id: "alice", name: "Alice", role: "patient", senderId: "111" }],
  ["bob", { id: "bob", name: "Bob", role: "patient", senderId: "333" }],
]);
const JPEG_BP = new Uint8Array([0xff, 0xd8, 0x01]);
const JPEG_GLUCO = new Uint8Array([0xff, 0xd8, 0x02]);

/** Mocked LLM: answers by input. Records every input and every batch call. */
class MockExtractor implements Extractor {
  readonly model = "claude-haiku-5-5";
  calls: ExtractInput[] = [];
  batches = 0;
  constructor(private fail?: Error) {}
  extract(inputs: ExtractInput[]): Promise<unknown[]> {
    this.batches++;
    return oneByOne((i) => this.one(i)).extract(inputs);
  }
  async one(input: ExtractInput): Promise<unknown> {
    this.calls.push(input);
    if (this.fail) throw this.fail;
    const none = { readings: [], symptoms: [], media_kind: "none", confidence: 0.9, unreadable_reason: null };
    if (input.media?.mimeType === "application/pdf") return { ...none, media_kind: "prescription" };
    if (input.media && input.media.data[2] === 0x01)
      return { ...none, media_kind: "device_reading", confidence: 0.95, readings: [{ type: "bp", value: 78, value2: 50, value3: 38, unit: "mmHg", measured_at: null }] };
    if (input.media) return { ...none, media_kind: "device_reading", confidence: 0.3, unreadable_reason: "display blurred" };
    if (/seene/.test(input.text ?? ""))
      return { ...none, confidence: 0.85, symptoms: [{ symptom_type: "chest_pain", location: "chest", side: "unknown", character: [], severity: null, duration_min: 20, at_rest: null, associated: [], triggers: [], onset_at: null, free_text: input.text }] };
    if (/sugar/.test(input.text ?? "")) return { ...none, readings: [{ type: "glucose_fasting", value: 1100, value2: null, value3: null, unit: "mg/dL", measured_at: null }] };
    return none;
  }
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hl-batch-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

async function ingestAll(updates: unknown[], files: Record<string, Uint8Array> = {}) {
  const { db, store } = await seededStore();
  const r2 = memR2();
  const t = fakeTelegram(files);
  vi.stubGlobal("fetch", t.fetchFn);
  const env = {
    DB: db, TELEGRAM_BOT_TOKEN: "123:SECRET-BOT-TOKEN", TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_API_BASE: "https://tg.test",
    MEDIA: { put: (k: string, b: any, o: any) => r2.put(k, b, o.httpMetadata.contentType) },
  } as any;
  for (const u of updates) expect((await worker.fetch(webhook(u) as any, env)).status).toBe(200);
  return { db, store, r2, t, repo: new Repo(root) };
}

const ndjson = (repo: Repo) => repo.kbRows();
const kbBuild = () => {
  const args = ["-I", join(import.meta.dirname, "..", "..", "tools", "kb", "build"), "--records", join(import.meta.dirname, "..", "..", "fixtures", "records-example"),
    "--telegram", join(root, "data", "telegram"), "--db", join(root, "kb.sqlite")];
  try {
    return execFileSync("python3", args, { encoding: "utf8" });
  } catch (e) {
    throw new Error(`kb build failed:\n${(e as { stdout?: string }).stdout ?? ""}${(e as { stderr?: string }).stderr ?? ""}`);
  }
};

describe("end-to-end (local): update -> inbox -> batch -> NDJSON -> digest", () => {
  it("records, asks, annotates, queues and is idempotent", async () => {
    const photo = fixture("photo"); // alice, BP monitor photo (largest size file_id "large")
    const voice = fixture("voice"); // alice, 7 s voice note
    const pdf = fixture("document-pdf"); // alice, prescription PDF
    const gluco = { update_id: 2001, message: { message_id: 31, date: 1792814460, chat: { id: Number(GROUP) }, from: { id: 333 }, photo: [{ file_id: "g1", file_unique_id: "u-g1", width: 900, height: 1200, file_size: 50000 }] } };
    const updates = [textUpdate("120/80 72", 111, {}, 1792814000), photo, voice, pdf, gluco, textUpdate("sugar 1100 khali pet", 333), textUpdate("main kal aaunga", 222)];
    const { db, store, r2, t, repo } = await ingestAll(updates, { large: JPEG_BP, g1: JPEG_GLUCO, voice1: new TextEncoder().encode("aaj seene mein dard hua 20 minute"), doc1: new Uint8Array([0x25, 0x50]) });
    expect(r2.objects.size).toBe(4);
    expect(t.sent().map((c) => c.body.text)[0]).toBe("BP 120/80, pulse 72 ✓");

    // pull: raw first
    const p1 = await pull({ store, r2, tg: t.tg, repo });
    expect(p1).toMatchObject({ pulled: 7, mediaCopied: 4, mediaMissing: 0 });
    expect(readFileSync(join(root, "data/telegram/raw/2026-10.jsonl"), "utf8").trim().split("\n")).toHaveLength(7);
    expect(readFileSync(join(root, "sources/alice/media/telegram/u-large.jpg"))).toEqual(Buffer.from(JPEG_BP));

    // extract
    const llm = new MockExtractor();
    const r = await extract({ repo, extractor: llm, stt: new StubSpeechToText(), thresholds: DEFAULT_THRESHOLDS, persons: PERSONS, now: NOW });
    expect(r).toMatchObject({ extracted: 6, pending: 0, queued: 3 });
    expect(llm.calls).toHaveLength(5); // "120/80 72" is recorded by the deterministic parser
    expect(llm.batches).toBe(1); // the day's messages go to the extractor together
    const rows = ndjson(repo);
    const reading = (id: string) => rows.find((x) => x.id === id);
    expect(reading(`${GROUP}:${(updates[0] as any).message.message_id}:r0`)).toMatchObject({ rt: "d1.readings", type: "bp", value: 120, value2: 80, value3: 72, extracted_by: "vitals-parser", confirmed: 0 });
    expect(reading(`${GROUP}:12:r0`)).toMatchObject({ type: "bp", value: 78, extracted_by: "claude-haiku-5-5" });
    expect(rows.find((x) => x.rt === "d1.messages" && x.id === `${GROUP}:13`)).toMatchObject({ kind: "audio", transcript: "aaj seene mein dard hua 20 minute" });
    expect(rows.filter((x) => x.person_id === "caregiver")).toEqual([]); // the caregiver's messages are never patient data

    // the KB build accepts the batch output
    expect(kbBuild()).toMatch(/^ok:/);

    // needs_deep queue: prescription, unreadable photo, rejected value
    const q = repo.queue();
    expect(q.map((e) => [e.message_id, e.reasons])).toEqual([
      [`${GROUP}:14`, ["document", "prescription"]],
      [`${GROUP}:31`, ["unreadable"]],
      [`${GROUP}:${(updates[5] as any).message.message_id}`, ["rejected_values"]],
    ]);

    // digest text
    const d = r.digest;
    expect(d).toContain("👤 Alice");
    expect(d).toContain("BP 120/80, पल्स 72");
    expect(d).toContain("BP 78/50, पल्स 38");
    expect(d).toContain("सीने में दर्द/दबाव");
    expect(d).toContain("📄 ध्यान से पढ़ने के लिए रखे गए: Alice");
    expect(d).toContain("❓");
    expect(d).toContain("फ़ोटो साफ़ नहीं पढ़ी गई");
    expect(d).toContain('"शुगर (खाली पेट) 1100 mg/dL" सही नहीं लगती');
    expect(d.indexOf("BP 120/80")).toBeLessThan(d.indexOf("BP 78/50")); // by time, not by arrival
    expect(d).toContain(ANNOTATION_NOTE);
    expect(d).toMatch(/T1 PULSE_VERY_LOW/);
    expect(d).not.toContain("main kal aaunga");

    // finish: rows done, digest to the family group, nothing pruned yet
    const before = t.sent().length;
    const f = await finish({ store, tg: t.tg, repo, now: NOW, digest: d, retentionDays: 14 });
    expect(f).toEqual({ done: 7, pruned: 0, sentTo: 1 });
    expect(t.sent().slice(before).map((c) => [c.body.chat_id, c.body.text])).toEqual([[GROUP, d]]);
    expect((await db.prepare("SELECT count(*) AS n FROM inbox WHERE status = 'new'").first<any>()).n).toBe(0);

    // re-run: nothing new, no LLM calls, identical files
    const snapshot = readFileSync(join(root, "data/telegram/2026-10.ndjson"), "utf8");
    expect((await pull({ store, r2, tg: t.tg, repo })).pulled).toBe(0);
    const r2nd = await extract({ repo, extractor: llm, stt: new StubSpeechToText(), thresholds: DEFAULT_THRESHOLDS, persons: PERSONS, now: NOW });
    expect(r2nd).toMatchObject({ extracted: 0, queued: 0, changed: [] });
    expect(llm.calls).toHaveLength(5);
    expect(readFileSync(join(root, "data/telegram/2026-10.ndjson"), "utf8")).toBe(snapshot);
    expect(r2nd.digest).toContain("आज कोई नया संदेश दर्ज नहीं हुआ");

    // prune after the retention window
    expect((await finish({ store, tg: t.tg, repo, now: "2026-11-10T15:30:00.000Z", digest: r2nd.digest, retentionDays: 14 })).pruned).toBe(7);
  });
});

describe("batch details", () => {
  const run = (repo: Repo, llm: Extractor) => extract({ repo, extractor: llm, stt: new StubSpeechToText(), thresholds: DEFAULT_THRESHOLDS, persons: PERSONS, now: NOW });

  it("an edited message replaces its earlier rows (same id)", async () => {
    const u = textUpdate("wajan 62");
    const { store, r2, t, repo } = await ingestAll([u]);
    await pull({ store, r2, tg: t.tg, repo });
    await run(repo, new MockExtractor());
    const m = u.message!;
    const edit = { update_id: u.update_id + 1, edited_message: { ...m, edit_date: m.date + 60, text: "wajan 61 spo2 97" } };
    const { store: s2, r2: r22, t: t2 } = await ingestAll([u, edit]);
    await pull({ store: s2, r2: r22, tg: t2.tg, repo });
    await run(repo, new MockExtractor());
    const rows = ndjson(repo).filter((r) => r.rt === "d1.readings");
    expect(rows.map((r) => [r.id, r.type, r.value])).toEqual([[`${GROUP}:${m.message_id}:r0`, "weight", 61], [`${GROUP}:${m.message_id}:r1`, "spo2", 97]]);
  });

  it("LLM down (transient): nothing written, counted as pending, retried next run", async () => {
    const { store, r2, t, repo } = await ingestAll([textUpdate("aaj chakkar aaya")]);
    await pull({ store, r2, tg: t.tg, repo });
    const r = await run(repo, new MockExtractor(Object.assign(new Error("overloaded"), { status: 529 })));
    expect(r).toMatchObject({ extracted: 0, pending: 1, delayed: 1, queued: 0 });
    expect(r.digest).toContain("⚠ extraction delayed: 1");
    const ok = new MockExtractor();
    expect((await run(repo, ok)).extracted).toBe(1);
    expect(ok.calls).toHaveLength(1);
  });

  it("auth or usage-limit failure: inbox rows stay new, ⚠ extraction delayed, done after a good run", async () => {
    const { db, store, r2, t, repo } = await ingestAll([textUpdate("thoda chakkar aaya"), textUpdate("120/80 72")]);
    await pull({ store, r2, tg: t.tg, repo });
    for (const err of [new ClaudeCliError(401, "auth_failed"), new ClaudeCliError(429, "rate_limited")]) {
      const r = await run(repo, new MockExtractor(err));
      expect(r).toMatchObject({ pending: 1, delayed: 1 });
      expect(r.digest).toContain("⚠ extraction delayed: 1");
      if (err.status === 401) expect(r.digest).toContain("BP 120/80, पल्स 72"); // the vitals text needs no LLM
      expect((await finish({ store, tg: t.tg, repo, now: NOW, digest: r.digest, retentionDays: 14 })).done).toBeLessThanOrEqual(1);
      const open = await db.prepare("SELECT count(*) AS n FROM inbox WHERE status = 'new'").first<any>();
      expect(open.n).toBe(1);
    }
    expect((await run(repo, new MockExtractor())).delayed).toBe(0);
    expect((await finish({ store, tg: t.tg, repo, now: NOW, digest: "x", retentionDays: 14 })).done).toBe(1);
    expect((await db.prepare("SELECT count(*) AS n FROM inbox WHERE status = 'new'").first<any>()).n).toBe(0);
  });

  it("no STT key: voice note stored as stt_pending, digest says so; a later run with STT transcribes it", async () => {
    const voice = fixture("voice");
    const { db, store, r2, t, repo } = await ingestAll([voice], { voice1: new TextEncoder().encode("aaj seene mein dard hua 20 minute") });
    await pull({ store, r2, tg: t.tg, repo });
    const key = `${GROUP}:${(voice as any).message.message_id}`;
    const noStt = (llm: Extractor) => extract({ repo, extractor: llm, stt: null, thresholds: DEFAULT_THRESHOLDS, persons: PERSONS, now: NOW });

    const llm = new MockExtractor();
    const r = await noStt(llm);
    expect(r).toMatchObject({ extracted: 1, pending: 0, delayed: 0, sttPending: 1 });
    expect(llm.calls).toHaveLength(0);
    expect(r.digest).toContain(STT_PENDING_NOTE);
    expect(ndjson(repo).find((x) => x.id === key)).toMatchObject({ rt: "d1.messages", kind: "audio", extraction_status: "stt_pending", transcript: null });
    expect(repo.findMedia("alice", "telegram/u-voice1")).toBe("sources/alice/media/telegram/u-voice1.ogg"); // raw + media in git
    expect(kbBuild()).toMatch(/^ok:/);
    expect((await finish({ store, tg: t.tg, repo, now: NOW, digest: r.digest, retentionDays: 14 })).done).toBe(1); // stored in git

    expect((await noStt(llm)).extracted).toBe(0); // still no key: nothing to redo

    // The key is added later: the next run (scheduled, or retry_failed) transcribes the pending note.
    const later = await run(repo, llm);
    expect(later).toMatchObject({ extracted: 1, sttPending: 0 });
    const row = ndjson(repo).find((x) => x.id === key)!;
    expect(row).toMatchObject({ extraction_status: "ok", transcript: "aaj seene mein dard hua 20 minute" });
    expect(ndjson(repo).some((x) => x.rt === "d1.symptoms" && x.source_message_id === key && x.symptom_type === "chest_pain")).toBe(true);
    expect(later.digest).not.toContain(STT_PENDING_NOTE);
    expect((await db.prepare("SELECT count(*) AS n FROM inbox WHERE status = 'new'").first<any>()).n).toBe(0);
  });

  it("a refusal is permanent: marked failed, asked about, queued, not retried", async () => {
    const { store, r2, t, repo } = await ingestAll([textUpdate("aaj chakkar aaya")]);
    await pull({ store, r2, tg: t.tg, repo });
    const r = await run(repo, new MockExtractor(new ExtractorStopError("refusal")));
    expect(r).toMatchObject({ extracted: 1, queued: 1 });
    expect(ndjson(repo)[0]).toMatchObject({ extraction_status: "failed" });
    expect(r.digest).toContain("प्रोसेस नहीं हो पाया");
    const again = new MockExtractor();
    await run(repo, again);
    expect(again.calls).toHaveLength(0);
  });

  it("media the Worker could not copy is fetched from Telegram by file_id at pull", async () => {
    const { db, store, r2, t, repo } = await ingestAll([fixture("voice")], { voice1: new TextEncoder().encode("wajan 60") });
    r2.objects.clear();
    await db.prepare("UPDATE inbox SET media_status = 'pending'").run();
    expect((await pull({ store, r2, tg: t.tg, repo })).mediaCopied).toBe(1);
    expect(readFileSync(join(root, "sources/alice/media/telegram/u-voice1.ogg"), "utf8")).toBe("wajan 60");
  });

  it("no digest file (extract failed) sends the failure notice", async () => {
    const { store, t, repo } = await ingestAll([]);
    await finish({ store, tg: t.tg, repo, now: NOW, digest: null, retentionDays: 14 });
    expect(t.sent().map((c) => c.body.text)).toEqual([DIGEST_FAILED]);
  });

  it("transient vs permanent errors", () => {
    expect(isTransient(Object.assign(new Error("x"), { status: 429 }))).toBe(true);
    expect(isTransient(Object.assign(new Error("x"), { status: 503 }))).toBe(true);
    expect(isTransient(Object.assign(new Error("x"), { name: "APIConnectionError" }))).toBe(true);
    expect(isTransient(Object.assign(new Error("x"), { status: 400 }))).toBe(false);
    expect(isTransient(new ExtractorStopError("refusal"))).toBe(false);
  });

  it("long digests are split under Telegram's 4096-character limit", () => {
    const parts = splitMessage(Array.from({ length: 300 }, (_, i) => `• line ${i} ${"x".repeat(30)}`).join("\n"));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 4000)).toBe(true);
  });
});
