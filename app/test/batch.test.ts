// Daily batch tests, including the local end-to-end run:
// fake Telegram updates -> real Worker fetch handler -> D1 inbox (node:sqlite) + R2 (memory)
// -> pull -> extract (LLM mocked, STT stubbed) -> NDJSON -> tools/kb/build -> digest text -> finish.
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDigest, ANNOTATION_NOTE, EMPTY_LINE, LISTEN_HEAD, QUESTIONS_HEAD, STT_PENDING_NOTE } from "../src/batch/digest.js";
import { DISABLED_THRESHOLDS } from "../src/config/thresholds.js";
import { Repo } from "../src/batch/repo.js";
import { DELAYED_OPS, DIGEST_FAILED, extract, finish, isTransient, pull, splitMessage, unlistened } from "../src/batch/steps.js";
import { loadThresholds } from "../src/batch/records.js";
import { ClaudeCliError, type ExtractInput, type Extractor, ExtractorStopError, oneByOne } from "../../adapters/llm/claude-cli.js";
import { StubSpeechToText } from "../../adapters/stt/sarvam.js";
import type { Person } from "../src/types.js";
import worker from "../src/worker.js";
import { FakeExtractor } from "../src/dev/fake-extractor.js";
import { fakeTelegram, fixture, GROUP, memR2, SECRET, seededStore, textUpdate, webhook } from "./helpers.js";

const NOW = "2026-10-25T15:30:00.000Z"; // 21:00 IST
// Example thresholds from the synthetic records (example values for tests; not clinical guidance).
const THRESHOLDS = loadThresholds(join(import.meta.dirname, "..", "..", "fixtures", "records-example"));
const PERSONS = new Map<string, Person>([
  ["alice", { id: "alice", name: "Alice", role: "member", senderId: "111" }],
  ["bob", { id: "bob", name: "Bob", role: "member", senderId: "333" }],
  ["carol-tg", { id: "carol-tg", name: "Carol", role: "admin", senderId: "222" }],
]);
const JPEG_BP = new Uint8Array([0xff, 0xd8, 0x01]);
const JPEG_GLUCO = new Uint8Array([0xff, 0xd8, 0x02]);
const JPEG_SCREENSHOT = new Uint8Array([0xff, 0xd8, 0x03]); // synthetic: the mock classifies it non_health
const JPEG_BLURRY = new Uint8Array([0xff, 0xd8, 0x04]); // synthetic: a BP monitor photo too blurred to read
const fx = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "fixtures", "app", `${name}.json`), "utf8"));
/** Bot output is plain English (ADR 011). */
const HINDI = /[\u0900-\u097F]/;
/** The wording bug: nobody is ever asked to retype or resend values. */
const RETYPE = /retype|re-type|write (the )?(numbers|values)|send (the )?(numbers|values)|लिखकर/i;

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
    if (input.media && input.media.data[2] === 0x03) return fx("non-health-screenshot");
    if (input.media && input.media.data[2] === 0x04) return fx("blurry-bp-monitor");
    if (input.media && input.media.data[2] === 0x01)
      return { ...none, media_kind: "device_reading", confidence: 0.95, readings: [{ type: "bp", value: 78, value2: 50, value3: 38, unit: "mmHg", measured_at: null }] };
    if (input.media) return { ...none, media_kind: "device_reading", confidence: 0.3, unreadable_reason: "display blurred" };
    if (/^Maa ka BP/.test(input.text ?? ""))
      return { ...none, confidence: 0.9, subject_hint: "Maa", readings: [{ type: "bp", value: 130, value2: 85, value3: null, unit: "mmHg", measured_at: null }] };
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
    DB: db, ACK_MODE: "all", TELEGRAM_BOT_TOKEN: "123:SECRET-BOT-TOKEN", TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_API_BASE: "https://tg.test",
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
    const updates = [textUpdate("120/80 72", 111, {}, 1792814000), photo, voice, pdf, gluco, textUpdate("sugar 1100 khali pet", 333), textUpdate("wajan 70", 222)];
    const { db, store, r2, t, repo } = await ingestAll(updates, { large: JPEG_BP, g1: JPEG_GLUCO, voice1: new TextEncoder().encode("aaj seene mein dard hua 20 minute"), doc1: new Uint8Array([0x25, 0x50]) });
    expect(r2.objects.size).toBe(4);
    expect(t.sent()).toEqual([]); // the group is input-only: no acks even with ACK_MODE all

    // pull: raw first
    const p1 = await pull({ store, r2, tg: t.tg, repo });
    expect(p1).toMatchObject({ pulled: 7, mediaCopied: 4, mediaMissing: 0 });
    expect(readFileSync(join(root, "data/telegram/raw/2026-10.jsonl"), "utf8").trim().split("\n")).toHaveLength(7);
    expect(readFileSync(join(root, "sources/alice/media/telegram/u-large.jpg"))).toEqual(Buffer.from(JPEG_BP));

    // extract
    const llm = new MockExtractor();
    const r = await extract({ repo, extractor: llm, stt: new StubSpeechToText(), thresholds: THRESHOLDS, persons: PERSONS, now: NOW });
    expect(r).toMatchObject({ extracted: 7, pending: 0, queued: 3 });
    expect(llm.calls).toHaveLength(5); // "120/80 72" is recorded by the deterministic parser
    expect(llm.batches).toBe(1); // the day's messages go to the extractor together
    const rows = ndjson(repo);
    const reading = (id: string) => rows.find((x) => x.id === id);
    expect(reading(`${GROUP}:${(updates[0] as any).message.message_id}:r0`)).toMatchObject({ rt: "d1.readings", type: "bp", value: 120, value2: 80, value3: 72, extracted_by: "vitals-parser", confirmed: 0 });
    expect(reading(`${GROUP}:12:r0`)).toMatchObject({ type: "bp", value: 78, extracted_by: "claude-haiku-5-5" });
    expect(rows.find((x) => x.rt === "d1.messages" && x.id === `${GROUP}:13`)).toMatchObject({ kind: "audio", transcript: "aaj seene mein dard hua 20 minute" });
    // the admin is a member: their message is extracted into their own records (D1 id carol-tg -> KB ns carol)
    expect(rows.find((x) => x.rt === "d1.readings" && x.person_id === "carol-tg")).toMatchObject({ type: "weight", value: 70, extracted_by: "vitals-parser" });

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
    expect(d).toContain("\nAlice\n");
    expect(d).toContain("BP 120/80, pulse 72");
    expect(d).toContain("BP 78/50, pulse 38");
    expect(d).toContain("chest pain/pressure");
    expect(d).toMatch(/\nPending\n• Alice \d\d:\d\d prescription: kept for a closer read/);
    expect(d).toContain(QUESTIONS_HEAD);
    expect(d).toContain("device reading photo could not be read; kept for a closer read");
    expect(d).toContain('"sugar (fasting) 1100 mg/dL" looks implausible');
    expect(d).not.toMatch(HINDI);
    expect(d).not.toMatch(RETYPE);
    expect(d).not.toMatch(/delayed|token|webhook/i); // no ops noise in the digest
    expect(d.indexOf("BP 120/80")).toBeLessThan(d.indexOf("BP 78/50")); // by time, not by arrival
    expect(d).toContain(ANNOTATION_NOTE);
    expect(d).toMatch(/T1 PULSE_VERY_LOW/);
    expect(d).toContain("\nCarol\n");

    // finish: rows done, digest to the admin by private DM (never the group), nothing pruned yet
    const before = t.sent().length;
    const f = await finish({ store, tg: t.tg, repo, now: NOW, digest: d, retentionDays: 14 });
    expect(f).toEqual({ done: 7, pruned: 0, sentTo: 1, opsTo: 0, skipped: false });
    expect(t.sent().slice(before).map((c) => [String(c.body.chat_id), c.body.text])).toEqual([["222", d]]);
    expect((await db.prepare("SELECT count(*) AS n FROM inbox WHERE status = 'new'").first<any>()).n).toBe(0);

    // re-run: nothing new, no LLM calls, identical files
    const snapshot = readFileSync(join(root, "data/telegram/2026-10.ndjson"), "utf8");
    expect((await pull({ store, r2, tg: t.tg, repo })).pulled).toBe(0);
    const r2nd = await extract({ repo, extractor: llm, stt: new StubSpeechToText(), thresholds: THRESHOLDS, persons: PERSONS, now: NOW });
    expect(r2nd).toMatchObject({ extracted: 0, queued: 0, changed: [] });
    expect(llm.calls).toHaveLength(5);
    expect(readFileSync(join(root, "data/telegram/2026-10.ndjson"), "utf8")).toBe(snapshot);
    expect(r2nd.digest).toContain(EMPTY_LINE);

    // prune after the retention window
    expect((await finish({ store, tg: t.tg, repo, now: "2026-11-10T15:30:00.000Z", digest: r2nd.digest, retentionDays: 14 })).pruned).toBe(7);
  });
});

describe("batch details", () => {
  const run = (repo: Repo, llm: Extractor) => extract({ repo, extractor: llm, stt: new StubSpeechToText(), thresholds: THRESHOLDS, persons: PERSONS, now: NOW });

  it("thresholds not configured: no rule annotations (and no ops line in the digest)", async () => {
    const { store, r2, t, repo } = await ingestAll([textUpdate("pulse 38")]);
    await pull({ store, r2, tg: t.tg, repo });
    const r = await extract({ repo, extractor: new MockExtractor(), stt: new StubSpeechToText(), thresholds: DISABLED_THRESHOLDS, persons: PERSONS, now: NOW });
    expect(r.digest).toContain("pulse 38"); // recorded
    expect(r.digest).not.toMatch(/threshold/i);
    expect(r.digest).not.toContain(ANNOTATION_NOTE);
    expect(r.digest).not.toContain("PULSE_VERY_LOW");
  });

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
    expect(r).toMatchObject({ extracted: 0, pending: 1, delayed: 1, queued: 0, ops: [DELAYED_OPS(1)] });
    expect(r.digest).not.toMatch(/delayed|waiting/); // ops line only (separate admin DM), not in the digest
    const ok = new MockExtractor();
    expect((await run(repo, ok)).extracted).toBe(1);
    expect(ok.calls).toHaveLength(1);
  });

  it("auth or usage-limit failure: inbox rows stay new, ⚠ extraction delayed, done after a good run", async () => {
    const { db, store, r2, t, repo } = await ingestAll([textUpdate("thoda chakkar aaya"), textUpdate("120/80 72")]);
    await pull({ store, r2, tg: t.tg, repo });
    for (const err of [new ClaudeCliError(401, "auth_failed"), new ClaudeCliError(429, "rate_limited")]) {
      const r = await run(repo, new MockExtractor(err));
      expect(r).toMatchObject({ pending: 1, delayed: 1, ops: [DELAYED_OPS(1)] });
      if (err.status === 401) expect(r.digest).toContain("BP 120/80, pulse 72"); // the vitals text needs no LLM
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
    const noStt = (llm: Extractor) => extract({ repo, extractor: llm, stt: null, thresholds: THRESHOLDS, persons: PERSONS, now: NOW });

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
    expect(r.digest).toContain("could not be processed; kept for a closer read");
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

  it("catch-up: items recorded while no digest was delivered appear in the next one, grouped by day, once", async () => {
    const voice = fixture("voice");
    const { store, r2, t, repo } = await ingestAll([voice, textUpdate("120/80 72", 111, {}, 1792814000)], { voice1: new TextEncoder().encode("aaj seene mein dard hua 20 minute") });
    await pull({ store, r2, tg: t.tg, repo });
    const llm = new MockExtractor();
    // day 1: no STT key; the run's digest never reaches the admins (failed / skipped run)
    const r1 = await extract({ repo, extractor: llm, stt: null, thresholds: THRESHOLDS, persons: PERSONS, now: NOW });
    expect(r1.digest).toContain(STT_PENDING_NOTE);
    expect(r1.digest).toContain("BP 120/80, pulse 72");
    // day 3: STT arrives; the digest carries day 1's reading too, the voice note once (transcribed, not pending)
    const r3 = await extract({ repo, extractor: llm, stt: new StubSpeechToText(), thresholds: THRESHOLDS, persons: PERSONS, now: "2026-10-27T15:30:00.000Z" });
    expect(r3.digest).toContain("BP 120/80, pulse 72");
    expect(r3.digest).not.toContain(STT_PENDING_NOTE);
    expect(r3.digest).toMatch(/chest|dard|pain/i);
    // delivered: the watermark moves, the next run has nothing to repeat
    await finish({ store, tg: t.tg, repo, now: "2026-10-27T15:31:00.000Z", digest: r3.digest, retentionDays: 14 });
    expect(repo.digestsSent().at(-1)).toMatchObject({ through: "2026-10-27T15:31:00.000Z" });
    const r4 = await extract({ repo, extractor: llm, stt: new StubSpeechToText(), thresholds: THRESHOLDS, persons: PERSONS, now: "2026-10-28T15:30:00.000Z" });
    expect(r4.digest).toContain(EMPTY_LINE);
  });

  it("a catch-up digest spanning several days groups by day and dates each time", () => {
    const e = (ts: string, v: number) => ({ person: "Alice", ts, kind: "text", snippet: "", readings: [{ type: "pulse", value: v, value2: null, value3: null, unit: "bpm", measuredAt: ts } as any], symptoms: [], questions: [], annotations: [], deep: null });
    const out = buildDigest({ entries: [e("2026-10-26T05:00:00.000Z", 70), e("2026-10-24T05:00:00.000Z", 72)], pending: 0, now: NOW, timeZone: "Asia/Kolkata", thresholdsStatus: "disabled" });
    expect(out.indexOf("== 24 Oct ==")).toBeGreaterThan(-1);
    expect(out.indexOf("== 24 Oct ==")).toBeLessThan(out.indexOf("== 26 Oct =="));
    expect(out).toMatch(/• 24 Oct 10:30 pulse 72/);
  });

  it("no digest file (extract failed): the failure notice goes to the admins by private DM, not the group", async () => {
    const { store, t, repo } = await ingestAll([]);
    expect(await finish({ store, tg: t.tg, repo, now: NOW, digest: null, retentionDays: 14 })).toMatchObject({ sentTo: 0, opsTo: 1 });
    expect(t.sent().map((c) => [String(c.body.chat_id), c.body.text])).toEqual([["222", `⚠ ${DIGEST_FAILED}`]]);
  });

  it("no admin reachable (DM fails): nothing is posted to the group", async () => {
    const { store, repo } = await ingestAll([]);
    const t = fakeTelegram({}, { failSendTo: "222" });
    expect(await finish({ store, tg: t.tg, repo, now: NOW, digest: null, retentionDays: 14 })).toMatchObject({ sentTo: 0, opsTo: 0 });
    expect(t.sent().filter((c) => c.ok)).toEqual([]);
    expect(repo.digestsSent()).toEqual([]);
  });

  it("failed or delayed run (27-Oct regression): short ops DM to the admin only, no digest, nothing logged", async () => {
    const { store, r2, t, repo } = await ingestAll([textUpdate("aaj chakkar aaya")]);
    await pull({ store, r2, tg: t.tg, repo });
    const r = await run(repo, new MockExtractor(new ClaudeCliError(401, "auth_failed")));
    expect(r.delayed).toBe(1); // batch/run.ts writes no digest file for a delayed run, so finish gets null
    const before = t.sent().length;
    const f = await finish({ store, tg: t.tg, repo, now: NOW, digest: null, alerts: [...r.ops, "webhook moved"], retentionDays: 14 });
    expect(f).toMatchObject({ sentTo: 0, opsTo: 1, skipped: false });
    const sent = t.sent().slice(before).map((c) => [String(c.body.chat_id), c.body.text]);
    expect(sent).toEqual([["222", `⚠ ${DIGEST_FAILED}\n\n⚠ ${DELAYED_OPS(1)}\n\n⚠ webhook moved`]]);
    expect(sent.some(([chat]) => chat === String(GROUP))).toBe(false);
    expect(repo.digestsSent()).toEqual([]);
    // A full run later the same day still sends that day's one digest.
    expect(await finish({ store, tg: t.tg, repo, now: NOW, digest: "ok", retentionDays: 14 })).toMatchObject({ sentTo: 1, skipped: false });
  });

  it("one admin digest per IST day: a second run is skipped, force_digest resends, the next day sends", async () => {
    const { store, t, repo } = await ingestAll([]);
    const group = () => t.sent().filter((c) => c.ok && String(c.body.chat_id) === "222").length;
    expect(await finish({ store, tg: t.tg, repo, now: NOW, digest: "d1", retentionDays: 14 })).toMatchObject({ sentTo: 1, skipped: false });
    expect(repo.digestsSent()).toEqual([{ date: "2026-10-25", message_ids: [1], sent_at: NOW, forced: false, through: NOW }]);
    // 23:59 IST the same day (18:29Z): skipped, admins not bothered, no new log row
    expect(await finish({ store, tg: t.tg, repo, now: "2026-10-25T18:29:00.000Z", digest: "d2", retentionDays: 14 })).toMatchObject({ sentTo: 0, opsTo: 0, skipped: true });
    expect(group()).toBe(1);
    expect(repo.digestsSent()).toHaveLength(1);
    // explicit force_digest
    expect(await finish({ store, tg: t.tg, repo, now: NOW, digest: "d3", force: true, retentionDays: 14 })).toMatchObject({ sentTo: 1, skipped: false });
    expect(repo.digestsSent().at(-1)).toMatchObject({ date: "2026-10-25", forced: true });
    // 00:01 IST the next day (18:31Z): a new day
    expect(await finish({ store, tg: t.tg, repo, now: "2026-10-25T18:31:00.000Z", digest: "d4", retentionDays: 14 })).toMatchObject({ sentTo: 1, skipped: false });
    expect(repo.digestsSent().at(-1)).toMatchObject({ date: "2026-10-26", forced: false });
    expect(group()).toBe(3);
    expect(t.sent().some((c) => String(c.body.chat_id) === String(GROUP))).toBe(false);
    // the log is a .jsonl: tools/kb/build (reads *.ndjson) never sees it
    expect(readFileSync(join(root, "data/telegram/digests.jsonl"), "utf8").trim().split("\n")).toHaveLength(3);
  });

  it("a message about another member stays with the sender and is flagged (subject_hint) for human review", async () => {
    const u = textUpdate("Maa ka BP 130/85 tha", 222);
    const { store, r2, t, repo } = await ingestAll([u]);
    await pull({ store, r2, tg: t.tg, repo });
    const r = await run(repo, new MockExtractor());
    const key = `${GROUP}:${u.message!.message_id}`;
    const rows = ndjson(repo);
    expect(rows.find((x) => x.id === key)).toMatchObject({ rt: "d1.messages", person_id: "carol-tg", subject_hint: "Maa" });
    expect(rows.find((x) => x.rt === "d1.readings")).toMatchObject({ person_id: "carol-tg", type: "bp", value: 130 }); // never auto-reassigned
    expect(repo.queue().map((e) => [e.message_id, e.reasons])).toEqual([[key, ["subject_hint"]]]);
    expect(r.digest).toMatch(/Carol .*may be about "Maa" but is logged for the sender \(Carol\)/);
    expect(kbBuild()).toMatch(/^ok:/);
    const kb = new DatabaseSync(join(root, "kb.sqlite"));
    const tags = kb.prepare("SELECT ns, tags FROM fact WHERE id LIKE '%tg.%'").all() as { ns: string; tags: string }[];
    expect(tags).toEqual([{ ns: "carol", tags: JSON.stringify(["subject-hint"]) }]);
    kb.close();
  });

  it("photos are classified first: non-health = source only (no facts, no question); health but blurry = one admin question", async () => {
    const img = (id: number, from: number, file: string) => ({ update_id: id, message: { message_id: id, date: 1792814460, chat: { id: Number(GROUP) }, from: { id: from }, photo: [{ file_id: file, file_unique_id: `u-${file}`, width: 900, height: 1200, file_size: 5000 }] } });
    const { store, r2, t, repo } = await ingestAll([img(3001, 111, "shot"), img(3002, 333, "blur"), textUpdate("good morning")], { shot: JPEG_SCREENSHOT, blur: JPEG_BLURRY });
    await pull({ store, r2, tg: t.tg, repo });
    const r = await run(repo, new MockExtractor());
    const rows = ndjson(repo);
    expect(rows.find((x) => x.id === `${GROUP}:3001`)).toMatchObject({ rt: "d1.messages", kind: "image", image_class: "non-health", extraction_status: "ok" });
    expect(rows.find((x) => x.id === `${GROUP}:3002`)).toMatchObject({ rt: "d1.messages", kind: "image", image_class: "device-reading" });
    expect(rows.filter((x) => x.rt !== "d1.messages")).toEqual([]); // no facts: the screenshot's "BP 120/80" is not recorded
    expect(repo.queue().map((e) => [e.message_id, e.reasons])).toEqual([[`${GROUP}:3002`, ["unreadable"]]]);
    const q = r.digest.split("\n").filter((l) => /^\d+\. /.test(l));
    expect(q).toEqual([expect.stringMatching(/^1\. Bob \d\d:\d\d photo: device reading photo could not be read; kept for a closer read\. Reply if you know what it shows\.$/)]);
    expect(r.digest).not.toMatch(/Alice/); // the screenshot and the chit-chat text leave no trace in the digest
    expect(r.digest).not.toMatch(RETYPE);
    expect(r.digest).not.toMatch(HINDI);
    expect(kbBuild()).toMatch(/^ok:/);
    const kb = new DatabaseSync(join(root, "kb.sqlite"));
    const src = kb.prepare("SELECT note, tags FROM source WHERE note LIKE '%class=non-health%'").all() as { note: string; tags: string }[];
    expect(src).toHaveLength(1);
    expect(JSON.parse(src[0].tags)).toContain("non-health");
    expect(kb.prepare("SELECT count(*) AS n FROM fact WHERE id LIKE '%tg.%'").get()).toEqual({ n: 0 });
    kb.close();
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

describe("life-context signals (ADR 010)", () => {
  /** Mocked combined call: health as MockExtractor, plus context items when the header asked for them (input.context). */
  class ContextMock extends MockExtractor {
    override async one(input: ExtractInput): Promise<unknown> {
      await super.one(input); // records the call
      const health = (await new FakeExtractor().one(input)) as Record<string, unknown>;
      const t = input.text ?? "";
      const context = !input.context ? [] : /tension/.test(t)
        ? [{ category: "stress", about: "sender", summary: "feeling work pressure before a deadline", intensity: "high", confidence: "high", start: null, end: null },
           { category: "bereavement", about: "a colleague", summary: "a colleague lost a parent", intensity: null, confidence: "high", start: null, end: null }]
        : /safar/.test(t) ? [{ category: "travel", about: "sender", summary: "travelling this week", intensity: null, confidence: "low", start: null, end: null }]
        : [];
      return { ...health, context };
    }
  }
  const CONSENT = new Set(["alice", "carol-tg"]); // bob: pending
  const go = (repo: Repo, llm: Extractor, mode: "off" | "shadow" | "on", cap?: number) =>
    extract({ repo, extractor: llm, stt: new StubSpeechToText(), thresholds: DISABLED_THRESHOLDS, persons: PERSONS, now: NOW, contextMode: mode, contextConsented: CONSENT, contextDailyCap: cap });
  const msgs = () => [
    textUpdate("aaj office mein bahut tension hai, bp 130/85 pulse 80", 111), // alice: consented; health + context
    textUpdate("aaj bahut tension hai ghar par sab theek", 333), // bob: consent pending -> never read for context
    textUpdate("/private feeling very low today, bp 150/95", 111), // never extracted at all
    textUpdate("kal se safar par hoon teen din", 222), // carol (admin): low-confidence travel
    textUpdate("good morning", 111), // too short for context
  ];

  it("shadow: one combined call; stored with tag shadow, hidden from views, only in the admin digest; /private never extracted", async () => {
    const u = msgs();
    const { store, r2, t, repo } = await ingestAll(u);
    await pull({ store, r2, tg: t.tg, repo });
    const llm = new ContextMock();
    const r = await go(repo, llm, "shadow");
    expect(llm.batches).toBe(1);
    expect(llm.calls.map((c) => [c.text?.slice(0, 12), !!c.context])).toEqual([
      ["aaj office m", true], ["aaj bahut te", false], ["kal se safar", true], ["good morning", false],
    ]); // the /private message never reaches the extractor
    expect(r.context).toEqual({ read: 2, signals: 2, dropped: 1, skippedCap: 0 }); // the colleague is dropped
    const rows = ndjson(repo);
    const key = (i: number) => `${GROUP}:${u[i].message!.message_id}`;
    // health is unchanged by the context fields
    expect(rows.find((x) => x.rt === "d1.readings" && x.source_message_id === key(0))).toMatchObject({ type: "bp", value: 130, value2: 85, value3: 80 });
    expect(rows.filter((x) => x.rt === "d1.context").map((x) => [x.source_message_id, x.person_id, x.category, x.mode, x.confidence])).toEqual([
      [key(0), "alice", "stress", "shadow", "high"], [key(3), "carol-tg", "travel", "shadow", "low"],
    ]);
    const priv = rows.find((x) => x.id === key(2))!;
    expect(priv).toMatchObject({ extraction_status: "private", context_status: "private", raw_text: null });
    expect(rows.filter((x) => x.source_message_id === key(2))).toEqual([]); // no health facts either
    expect(rows.find((x) => x.id === key(1))!.context_status).toBeUndefined();
    expect(JSON.stringify(rows.filter((x) => x.rt === "d1.context"))).not.toMatch(/tension|colleague|safar/);

    // the admin digest has the shadow section; the private line has no snippet
    expect(r.digest).toContain("Context (shadow)");
    expect(r.digest).toMatch(/• \d\d:\d\d Alice: stress, high: feeling work pressure before a deadline/);
    expect(r.digest).toMatch(/• \d\d:\d\d Carol: travel: travelling this week \(low confidence\)/);
    expect(r.digest).not.toMatch(/colleague|Bob: stress/);
    expect(r.digest).toMatch(/Alice \d\d:\d\d 🔒 private message kept \(not read\)/);
    expect(r.digest).not.toMatch(/feeling very low|150\/95/);

    // KB: event facts with data.type context, tagged; v_context shows none of them in shadow mode
    expect(kbBuild()).toMatch(/^ok:/);
    const kb = new DatabaseSync(join(root, "kb.sqlite"));
    const facts = (kb.prepare("SELECT ns, at, at_precision, json_extract(data,'$.category') AS c, json_extract(data,'$.data_class') AS dc, quote, verification, tags FROM fact WHERE json_extract(data,'$.type') = 'context' ORDER BY ns").all() as Record<string, unknown>[])
      .map((f) => ({ ...f, tags: JSON.parse(String(f.tags)) }));
    expect(facts).toEqual([
      { ns: "alice", at: "2026-10-24", at_precision: "day", c: "stress", dc: "phi", quote: null, verification: "unverified", tags: ["patient-reported", "shadow"] },
      { ns: "carol", at: "2026-10-24", at_precision: "day", c: "travel", dc: "phi", quote: null, verification: "unverified", tags: ["patient-reported", "shadow", "low-confidence"] },
    ]);
    expect(kb.prepare("SELECT count(*) AS n FROM v_context").get()).toEqual({ n: 0 });
    expect(kb.prepare("SELECT count(*) AS n FROM v_timeline WHERE what = 'context'").get()).toEqual({ n: 0 });
    expect(kb.prepare("SELECT count(*) AS n FROM v_needs_human WHERE what = 'context'").get()).toEqual({ n: 0 });
    kb.close();

    // re-run: idempotent, the cap counts today's reads (nothing re-read)
    const again = await go(repo, llm, "shadow");
    expect(again).toMatchObject({ extracted: 0, context: { read: 0, signals: 0, dropped: 0, skippedCap: 0 } });
  });

  it("an edit that adds /private retracts the message's context and health rows", async () => {
    const u = textUpdate("aaj office mein bahut tension hai, bp 130/85 pulse 80", 111);
    const { store, r2, t, repo } = await ingestAll([u]);
    await pull({ store, r2, tg: t.tg, repo });
    await go(repo, new ContextMock(), "shadow");
    expect(ndjson(repo).filter((x) => x.rt === "d1.context")).toHaveLength(1);
    const edited = { update_id: u.update_id + 900, edited_message: { ...u.message, text: "/private aaj office mein bahut tension hai", edit_date: 1792815000 } };
    const e = await ingestAll([edited]);
    await pull({ store: e.store, r2: e.r2, tg: e.t.tg, repo });
    await go(repo, new ContextMock(), "shadow");
    const rows = ndjson(repo);
    expect(rows.filter((x) => x.rt !== "d1.messages")).toEqual([]);
    expect(rows.find((x) => x.rt === "d1.messages")).toMatchObject({ extraction_status: "private", raw_text: null });
  });

  it("daily cap: over it, context is skipped and counted; health extraction is never blocked", async () => {
    const u = [textUpdate("aaj office mein bahut tension hai, bp 130/85 pulse 80", 111), textUpdate("aaj bhi bahut tension hai bp 128/84", 111)];
    const { store, r2, t, repo } = await ingestAll(u);
    await pull({ store, r2, tg: t.tg, repo });
    const r = await go(repo, new ContextMock(), "shadow", 1);
    expect(r.context).toMatchObject({ read: 1, skippedCap: 1 });
    const rows = ndjson(repo);
    expect(rows.filter((x) => x.rt === "d1.readings").map((x) => x.value)).toEqual([130, 128]);
    expect(rows.filter((x) => x.rt === "d1.messages").map((x) => x.context_status)).toEqual(["extracted", "skipped_cap"]);
    expect(r.digest).toContain("1 message(s) not read for context (daily cap reached)");
  });

  it("off (the default): no context header, no rows, no digest section", async () => {
    const { store, r2, t, repo } = await ingestAll(msgs());
    await pull({ store, r2, tg: t.tg, repo });
    const llm = new ContextMock();
    const r = await go(repo, llm, "off");
    expect(llm.calls.some((c) => c.context)).toBe(false);
    expect(ndjson(repo).filter((x) => x.rt === "d1.context")).toEqual([]);
    expect(r.digest).not.toContain("Context (shadow)");
  });

  it("on: shown in the timeline overlay (v_context), not in the digest; low confidence stays hidden", async () => {
    const { store, r2, t, repo } = await ingestAll(msgs());
    await pull({ store, r2, tg: t.tg, repo });
    const r = await go(repo, new ContextMock(), "on");
    expect(r.digest).not.toContain("Context (shadow)");
    expect(kbBuild()).toMatch(/^ok:/);
    const kb = new DatabaseSync(join(root, "kb.sqlite"));
    expect(kb.prepare("SELECT ns, category, summary FROM v_context").all()).toEqual([{ ns: "alice", category: "stress", summary: "feeling work pressure before a deadline" }]);
    kb.close();
  });
});

describe("photos and PDFs: model per kind, full reports, duplicate files (synthetic)", () => {
  /** Haiku for text, Sonnet for media (like ClaudeCliExtractor); a PDF answers as a lab report. */
  class MediaAwareExtractor extends MockExtractor {
    modelFor(i: ExtractInput) {
      return i.media ? "claude-sonnet-5-5" : this.model;
    }
    override async one(input: ExtractInput): Promise<unknown> {
      if (input.media?.mimeType !== "application/pdf") return super.one(input);
      this.calls.push(input);
      const item = (name: string, value_num: number | null, unit: string | null, ref_range: string | null, flag: string | null = null, value_text: string | null = null) =>
        ({ name, value_num, value_text, unit, ref_range, flag, panel: null });
      return {
        readings: [], symptoms: [], media_kind: "report", confidence: 0.95, unreadable_reason: null, subject_hint: null, context: [],
        report: {
          report_type: "lab", sample_at: "2026-09-01T08:15:00", reported_at: "2026-09-02T18:00:00", facility: "Example Lab", doctors: ["Dr Example (signed)"],
          items: [item("Serum Potassium", 5.6, "mmol/L", "3.5 - 5.1", "H"), item("Sodium", 139, "mmol/L", "135 - 145"), item("Synthetic Marker X", 12.5, "U/L", "< 40"),
            item("Urine Synthetic", null, null, null, null, "Negative"), item("Bad row", null, null, null)],
          findings: null, impression: null,
        },
      };
    }
  }

  it("records every report value at the sample time, tags document, records a duplicate photo once", async () => {
    const photo = (update_id: number, message_id: number, fid: string) =>
      ({ update_id, message: { message_id, date: 1792814460 + message_id, chat: { id: Number(GROUP) }, from: { id: 111 }, photo: [{ file_id: fid, file_unique_id: `u-${fid}`, width: 900, height: 1200, file_size: 50000 }] } });
    const doc = { update_id: 3003, message: { message_id: 43, date: 1792814500, chat: { id: Number(GROUP) }, from: { id: 111 }, document: { file_id: "rep1", file_unique_id: "u-rep1", mime_type: "application/pdf", file_size: 9000, file_name: "report.pdf" } } };
    // The same BP photo bytes sent twice (re-uploaded: different file ids) -> one set of readings.
    const { store, r2, t, repo } = await ingestAll([photo(3001, 41, "bp1"), photo(3002, 42, "bp2"), doc], { bp1: JPEG_BP, bp2: JPEG_BP, rep1: new TextEncoder().encode("%PDF-1.4 synthetic") });
    await pull({ store, r2, tg: t.tg, repo });
    const llm = new MediaAwareExtractor();
    const r = await extract({ repo, extractor: llm, stt: null, thresholds: THRESHOLDS, persons: PERSONS, now: NOW });
    expect(r.extracted).toBe(3);
    expect(llm.calls).toHaveLength(2); // the duplicate never reaches the model
    const rows = ndjson(repo);
    const msgs = rows.filter((x) => x.rt === "d1.messages");
    expect(msgs.map((m) => [m.extraction_status, m.extracted_by, m.duplicate_of ?? null])).toEqual([
      ["ok", "claude-sonnet-5-5", null], ["duplicate", null, `${GROUP}:41`], ["ok", "claude-sonnet-5-5", null],
    ]);
    expect(rows.filter((x) => x.rt === "d1.readings")).toHaveLength(1);
    const items = rows.filter((x) => x.rt === "d1.report_items");
    expect(items.map((i) => i.name)).toEqual(["Serum Potassium", "Sodium", "Synthetic Marker X", "Urine Synthetic"]); // the empty row is dropped
    expect(items[0]).toMatchObject({ value_num: 5.6, unit: "mmol/L", ref_range: "3.5 - 5.1", flag: "H", sample_at: "2026-09-01T08:15:00+05:30", facility: "Example Lab", extracted_by: "claude-sonnet-5-5" });
    expect(r.digest).toMatch(/lab report: 4 value\(s\) recorded \(sample 2026-09-01\)/);
    expect(r.digest).toMatch(/same file as an earlier message; recorded once/);
    expect(r.digest).toMatch(/POTASSIUM_RAISED: Potassium 5\.6/); // report K/Na feed the digest and the rules (not stored twice)
    kbBuild();
    const db = new DatabaseSync(join(root, "kb.sqlite"));
    const facts = db.prepare("SELECT id, at, tags, json_extract(data, '$.code') AS code FROM fact ORDER BY id").all() as { id: string; at: string; tags: string; code: string }[];
    db.close();
    const rep = facts.filter((f) => f.id.includes(".43.i"));
    expect(rep.map((f) => [f.code, f.at, JSON.parse(f.tags)])).toEqual([
      ["ref:code:potassium", "2026-09-01T08:15+05:30", ["document"]], ["ref:code:sodium", "2026-09-01T08:15+05:30", ["document"]],
      ["ref:code:lab-unmapped", "2026-09-01T08:15+05:30", ["document"]], ["ref:code:lab-unmapped", "2026-09-01T08:15+05:30", ["document"]],
    ]);
    expect(facts.filter((f) => f.code === "ref:code:bp")).toHaveLength(1);

    // A later run: the same photo bytes again -> duplicate of the first message (index from git, not memory).
    const again = await ingestAll([photo(3004, 44, "bp3")], { bp3: JPEG_BP });
    await pull({ store: again.store, r2: again.r2, tg: again.t.tg, repo });
    const r2nd = await extract({ repo, extractor: new MediaAwareExtractor(), stt: null, thresholds: THRESHOLDS, persons: PERSONS, now: NOW });
    expect(r2nd.extracted).toBe(1);
    expect(ndjson(repo).find((x) => x.id === `${GROUP}:44`)).toMatchObject({ extraction_status: "duplicate", duplicate_of: `${GROUP}:41` });
  });
});

// ---------------------------------------------------------------- voice notes (local STT, machine transcripts)
class LocalStt {
  readonly local = true;
  calls = 0;
  constructor(private accepted = true, private text = "कल रात चक्कर आया था आज चक्कर नहीं आया") {}
  async transcribe(): Promise<import("../src/types.js").Transcript> {
    this.calls++;
    return { text: this.text, languageCode: "hi", languageProbability: 0.97, segments: [{ start: 0, end: 3.5, text: "कल रात चक्कर आया था" }, { start: 3.5, end: 7, text: "आज चक्कर नहीं आया" }],
      meta: { engine: "whisper.cpp test", model: "test-model", settings: "-l hi --max-context 0", attempts: [{ language: "hi", temperature: 0, detected: "hi", verdict: this.accepted ? "ok" : "repetition:segments", elapsedSec: 1 }], audioSec: 7, elapsedSec: 1, accepted: this.accepted } };
  }
  startBatch(): Promise<string> { throw new Error("no"); }
  pollBatch(): Promise<null> { throw new Error("no"); }
}
class VoiceExtractor implements Extractor {
  readonly model = "claude-haiku-5-5";
  calls: ExtractInput[] = [];
  constructor(private confidence = 0.9) {}
  modelFor(i: ExtractInput) { return i.voice ? "claude-sonnet-5-5" : this.model; }
  async extract(inputs: ExtractInput[]): Promise<unknown[]> {
    this.calls.push(...inputs);
    return inputs.map(() => ({ readings: [], media_kind: "none", confidence: this.confidence, unreadable_reason: null, subject_hint: null, context: [],
      symptoms: [{ symptom_type: "dizziness", location: null, side: "unknown", character: [], severity: null, duration_min: null, at_rest: null, associated: [], triggers: [], onset_at: "2026-10-24T22:00", free_text: "कल रात चक्कर आया था" }],
      statements: [
        { category: "symptom", summary: "dizziness last night", quote: "कल रात चक्कर आया था", negated: false, time_frame: "past", when_text: "kal raat", when: "2026-10-24", speaker: "sender", speaker_name: null, about: null, confidence: 0.9 },
        { category: "symptom", summary: "no dizziness today", quote: "आज चक्कर नहीं आया", negated: true, time_frame: "current", when_text: "aaj", when: "2026-10-25", speaker: "sender", speaker_name: null, about: null, confidence: 0.9 },
        { category: "symptom", summary: "fainted", quote: "बेहोश हो गई", negated: false, time_frame: "past", when_text: null, when: null, speaker: "sender", speaker_name: null, about: null, confidence: 0.9 },
      ] }));
  }
}

describe("voice notes: local transcript, verbatim statements, needs a listener", () => {
  const setup = async () => {
    const voice = fixture("voice");
    const { store, r2, t, repo } = await ingestAll([voice], { voice1: new TextEncoder().encode("OggS-synthetic") });
    await pull({ store, r2, tg: t.tg, repo });
    const key = `${GROUP}:${(voice as any).message.message_id}`;
    return { repo, key, updateId: (voice as any).update_id as number };
  };

  it("pending notes are backfilled: transcript file next to the audio, Hindi to the model, statements tagged, digest says unchecked", async () => {
    const { repo, key, updateId } = await setup();
    await extract({ repo, extractor: new VoiceExtractor(), stt: null, thresholds: THRESHOLDS, persons: PERSONS, now: NOW }); // stt_pending first
    const llm = new VoiceExtractor();
    const r = await extract({ repo, extractor: llm, stt: new LocalStt(), thresholds: THRESHOLDS, persons: PERSONS, now: NOW });
    expect(r).toMatchObject({ extracted: 1, sttPending: 0, voice: { notes: 1, rejected: 0, statements: 2, dropped: 1 } });
    const md = readFileSync(join(root, "sources/alice/media/telegram/u-voice1.transcript.md"), "utf8");
    expect(md).toMatch(/^---\ngenerator: saturn-batch/);
    expect(md).toContain("Machine transcript — needs a listener");
    expect(md).toContain("[00:00.0 → 00:03.5] कल रात चक्कर आया था");
    expect(md).toContain(`"update_id": ${updateId}`);
    expect(llm.calls[0].voice).toBeTruthy();
    expect(llm.calls[0].text).toContain("[00:03] आज चक्कर नहीं आया"); // source language, timed; no translation
    const rows = ndjson(repo);
    expect(rows.find((x) => x.id === key)).toMatchObject({ extraction_status: "ok", transcript_path: "sources/alice/media/telegram/u-voice1.transcript.md", extracted_by: "claude-sonnet-5-5" });
    expect(rows.filter((x) => x.rt === "d1.statements").map((x) => [x.quote, x.negated])).toEqual([["कल रात चक्कर आया था", 0], ["आज चक्कर नहीं आया", 1]]);
    expect(r.digest).toContain("voice note (7 s): machine transcript, 2 item(s) recorded (unchecked)");
    expect(r.digest).not.toContain(LISTEN_HEAD); // transcribed, confident, items recorded: nothing to check
    expect(r.digest).not.toContain("low confidence");
    expect(kbBuild()).toMatch(/^ok:/);
    const db = new DatabaseSync(join(root, "kb.sqlite"));
    const facts = db.prepare("SELECT tags, quote, at FROM fact WHERE locator = ? ORDER BY at").all(`tg:${key}`) as { tags: string; quote: string; at: string }[];
    expect(facts.map((f) => JSON.parse(f.tags))).toEqual([expect.arrayContaining(["patient-reported", "machine-transcript"]), expect.arrayContaining(["patient-reported", "machine-transcript", "negated"])]);
    expect(facts[0].at).toBe("2026-10-24");
    const sym = db.prepare("SELECT tags FROM fact WHERE source_id = (SELECT source_id FROM fact WHERE locator = ? LIMIT 1) AND kind = 'observation'").all(`tg:${key}`) as { tags: string }[];
    expect(JSON.parse(sym[0].tags)).toEqual(expect.arrayContaining(["patient-reported", "machine-transcript"]));

    // A person listens and marks it: the KB build checks the marker.
    writeFileSync(join(root, "data/telegram/listened.ndjson"), JSON.stringify({ update_id: updateId, by: "owner", at: "2026-10-26" }) + "\n");
    expect(kbBuild()).toMatch(/^ok:/);
    writeFileSync(join(root, "data/telegram/listened.ndjson"), JSON.stringify({ update_id: 1, by: "owner", at: "2026-10-26" }) + "\n");
    expect(() => kbBuild()).toThrow(/not a recorded voice note/);
  });

  it("a note read with low confidence (< 0.5; the photo bar of 0.8 would flag most notes) is asked about and listed to check until listened", async () => {
    const { repo, updateId } = await setup();
    const r = await extract({ repo, extractor: new VoiceExtractor(0.4), stt: new LocalStt(), thresholds: THRESHOLDS, persons: PERSONS, now: NOW });
    expect(r.digest).toContain("read with low confidence; check the values above.");
    expect(r.digest).toContain(`${LISTEN_HEAD}\n• Alice 24 Oct 09:30, 7 s (low confidence)`);
    writeFileSync(join(root, "data/telegram/listened.ndjson"), JSON.stringify({ update_id: updateId, by: "owner", at: "2026-10-26" }) + "\n");
    const r2nd = await extract({ repo, extractor: new VoiceExtractor(0.4), stt: new LocalStt(), thresholds: THRESHOLDS, persons: PERSONS, now: "2026-10-26T15:30:00.000Z" });
    expect(r2nd.digest).not.toContain(LISTEN_HEAD);
    // 0.6 is below the photo bar but a normal score for a transcript: no question.
    rmSync(root, { recursive: true, force: true });
    const second = await setup();
    const r3 = await extract({ repo: second.repo, extractor: new VoiceExtractor(0.6), stt: new LocalStt(), thresholds: THRESHOLDS, persons: PERSONS, now: NOW });
    expect(r3.digest).not.toContain("low confidence");
  });

  it("the standing list keeps only notes to check: not transcribed, low confidence, or nothing recorded from more than 10 s", () => {
    const repo = new Repo(root);
    const note = (n: number, extra: Record<string, unknown>) => ({ rt: "d1.messages", id: `g:${n}`, kind: "audio", person_id: "alice", sender_person_id: "alice", external_id: `tg:${n}`,
      received_at: `2026-10-2${n}T10:00:00.000Z`, extraction_status: "ok", transcript: "x", confidence: 0.9, duration_sec: 7, ...extra });
    const item = (n: number) => ({ rt: "d1.statements", id: `g:${n}:t0`, source_message_id: `g:${n}`, person_id: "alice", quote: "x", confidence: 0.9 });
    repo.writeKb([
      note(1, {}), item(1), // fine
      note(2, { transcript: null, extraction_status: "stt_pending" }), // not transcribed
      note(3, { confidence: 0.4 }), item(3), // low confidence
      note(4, { duration_sec: 11 }), // nothing understood from 11 s
      note(5, { duration_sec: 10 }), // short and empty: not worth a listener
      note(6, { transcript: null, extraction_status: "failed" }), // listened below
    ], new Set());
    writeFileSync(join(root, "data/telegram/listened.ndjson"), JSON.stringify({ update_id: 6, by: "owner", at: "2026-10-27" }) + "\n");
    expect(unlistened(repo, () => "Alice").map((v) => [v.ts.slice(8, 10), v.durationSec, v.why])).toEqual([["22", 7, "not transcribed"], ["23", 7, "low confidence"], ["24", 11, "nothing understood"]]);
  });

  it("a looping transcript is not extracted: kept, asked, queued for a listener", async () => {
    const { repo, key } = await setup();
    const llm = new VoiceExtractor();
    const r = await extract({ repo, extractor: llm, stt: new LocalStt(false), thresholds: THRESHOLDS, persons: PERSONS, now: NOW });
    expect(llm.calls).toHaveLength(0);
    expect(r.voice.rejected).toBe(1);
    expect(ndjson(repo).find((x) => x.id === key)).toMatchObject({ extraction_status: "failed" });
    expect(readFileSync(join(root, "sources/alice/media/telegram/u-voice1.transcript.md"), "utf8")).toContain("REJECTED");
    expect(r.digest).toContain("could not be transcribed reliably; needs a listener");
    expect(repo.queue()[0]).toMatchObject({ reasons: ["transcript_rejected"] });
  });

  it("a person's (or the Mac runner's) transcript is never overwritten; the per-run audio cap defers the rest", async () => {
    const { repo, key } = await setup();
    mkdirSync(join(root, "sources/alice/media/telegram"), { recursive: true });
    writeFileSync(join(root, "sources/alice/media/telegram/u-voice1.transcript.md"), "# hand-made transcript\n");
    writeFileSync(join(root, "sources/alice/media/telegram/u-voice1.mac.transcript.md"), "# Mac runner transcript\n");
    await extract({ repo, extractor: new VoiceExtractor(), stt: new LocalStt(), thresholds: THRESHOLDS, persons: PERSONS, now: NOW });
    expect(readFileSync(join(root, "sources/alice/media/telegram/u-voice1.transcript.md"), "utf8")).toBe("# hand-made transcript\n");
    expect(existsSync(join(root, "sources/alice/media/telegram/u-voice1.batch.transcript.md"))).toBe(true);
    expect(readFileSync(join(root, "sources/alice/media/telegram/u-voice1.mac.transcript.md"), "utf8")).toBe("# Mac runner transcript\n"); // tools/stt output
    expect(ndjson(repo).find((x) => x.id === key)).toMatchObject({ transcript_path: "sources/alice/media/telegram/u-voice1.batch.transcript.md" });

    // Deadline already passed: the note waits as stt_pending (no engine call).
    const { repo: repo2 } = await (async () => { rmSync(root, { recursive: true, force: true }); return setup(); })();
    const stt = new LocalStt();
    const r = await extract({ repo: repo2, extractor: new VoiceExtractor(), stt, thresholds: THRESHOLDS, persons: PERSONS, now: NOW, sttDeadline: Date.now() - 1 });
    expect(stt.calls).toBe(0);
    expect(r.sttPending).toBe(1);
    expect(r.digest).toContain("transcription waits for the next run");
  });
});
