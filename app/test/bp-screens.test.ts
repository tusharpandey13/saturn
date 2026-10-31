// BP-monitor memory/average screens and partly legible screens (synthetic values only): the extraction marks the
// reading type and per-component legibility; the batch keeps device summaries out of the red-flag rules and queues the
// unclear ones; the KB build tags them (tools/kb/test_build.py and tools/crossref/test_crossref.py cover the KB side).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadThresholds } from "../src/batch/records.js";
import { Repo } from "../src/batch/repo.js";
import { extract, pull } from "../src/batch/steps.js";
import { oneByOne } from "../src/extract/adapter.js";
import { EXTRACTION_SCHEMA, isDeviceSummary, parseExtraction } from "../src/extract/schema.js";
import { ingestIO, seededStore, fakeTelegram, textUpdate, webhook, GROUP } from "./helpers.js";
import { handleWebhook } from "../src/ingest.js";
import { readingEn } from "../src/replies.js";
import type { Person } from "../src/types.js";

const NOW = "2026-10-24T08:00:00+05:30";
const comp = (confidence: number, illegible_reason: string | null = null) => ({ confidence, illegible_reason });
const ok = { systolic: comp(0.95), diastolic: comp(0.95), pulse: comp(0.95), time: comp(0.9) };
const bp = (o: Record<string, unknown>) => ({
  type: "bp", value: 128, value2: 82, value3: 76, unit: "mmHg", measured_at: null, reading_kind: "single", indicator: null, window: null, components: ok, ...o,
});
const out = (...readings: unknown[]) => ({ media_kind: "device_reading", readings, symptoms: [], confidence: 0.9, unreadable_reason: null, subject_hint: null, context: [], report: null });

describe("parseExtraction: device screen type", () => {
  it("a plain single reading carries no extra fields", () => {
    expect(parseExtraction(out(bp({})), NOW).readings).toEqual([{ type: "bp", value: 128, value2: 82, value3: 76, unit: "mmHg", measuredAt: NOW }]);
  });

  it("average and memory recall keep the indicator and window as seen; both are device summaries", () => {
    const ex = parseExtraction(out(bp({ reading_kind: "average", indicator: "AVG AM", window: "7 days" }), bp({ reading_kind: "memory-recall", indicator: "M 3/30" })), NOW);
    expect(ex.readings.map((r) => [r.kind, r.indicator, r.window])).toEqual([["average", "AVG AM", "7 days"], ["memory-recall", "M 3/30", undefined]]);
    expect(ex.readings.every(isDeviceSummary)).toBe(true);
    expect(readingEn(ex.readings[0])).toBe('BP 128/82, pulse 76 (device average "AVG AM", 7 days)');
  });

  it("unknown with an indicator stays unknown; unknown with nothing seen (or a missing field) is a single reading", () => {
    const ex = parseExtraction(out(bp({ reading_kind: "unknown", indicator: "M" }), bp({ reading_kind: "unknown" }), bp({ reading_kind: undefined })), NOW);
    expect(ex.readings.map((r) => r.kind ?? "single")).toEqual(["unknown", "single", "single"]);
    expect(ex.readings.map(isDeviceSummary)).toEqual([true, false, false]);
  });

  it("the schema asks for the reading type, indicator, window and per-component confidence", () => {
    const r = (EXTRACTION_SCHEMA.properties.readings as any).items;
    expect(r.properties.reading_kind.enum).toEqual(["single", "average", "memory-recall", "unknown"]);
    expect(r.required).toEqual(expect.arrayContaining(["reading_kind", "indicator", "window", "components"]));
    const c = r.properties.components.anyOf.find((x: any) => x.type === "object");
    expect(Object.keys(c.properties)).toEqual(["systolic", "diastolic", "pulse", "time"]);
  });
});

describe("parseExtraction: partly legible BP screens", () => {
  it("cropped systolic: legible diastolic and pulse kept, systolic null with the reason; never invented", () => {
    const ex = parseExtraction(out(bp({ value: null, value2: 72, value3: 81, components: { ...ok, systolic: comp(0, "cropped at the top") } })), NOW);
    expect(ex.readings).toEqual([]);
    expect(ex.partials).toEqual([{ type: "bp", value: null, value2: 72, value3: 81, unit: "mmHg", measuredAt: NOW, missing: { systolic: "cropped at the top" } }]);
    expect(readingEn(ex.partials![0])).toBe("BP ?/72, pulse 81 (not legible: systolic)");
    expect(ex.rejected).toEqual([]);
  });

  it("an illegible reason wins over a number the model also gave", () => {
    const ex = parseExtraction(out(bp({ value: 188, components: { ...ok, systolic: comp(0.2, "half the digit is cut off") } })), NOW);
    expect(ex.partials![0]).toMatchObject({ value: null, value2: 82, missing: { systolic: "half the digit is cut off" } });
  });

  it("complete reading with an illegible pulse or clock: stored, the part null, low-confidence parts marked uncertain", () => {
    const ex = parseExtraction(out(bp({ measured_at: "2026-10-24T07:10:00", components: { systolic: comp(0.95), diastolic: comp(0.6), pulse: comp(0, "glare"), time: comp(0, "cropped") } })), NOW);
    expect(ex.partials).toBeUndefined();
    expect(ex.readings).toEqual([{ type: "bp", value: 128, value2: 82, value3: null, unit: "mmHg", measuredAt: NOW, uncertain: ["diastolic"], missing: { pulse: "glare", time: "cropped" } }]);
  });

  it("nothing legible, or an implausible legible part, is rejected or dropped, not guessed", () => {
    const none = parseExtraction(out(bp({ value: null, value2: null, value3: null })), NOW);
    expect([none.readings, none.partials, none.rejected]).toEqual([[], undefined, ["bp: no legible component"]]);
    const odd = parseExtraction(out(bp({ value: null, value2: 300, value3: 81 })), NOW);
    expect(odd.partials![0]).toMatchObject({ value: null, value2: null, value3: 81, missing: { systolic: "not legible", diastolic: "implausible value 300" } });
  });
});

describe("batch: device summaries and partial screens", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "saturn-bp-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const EXAMPLE = join(import.meta.dirname, "..", "..", "fixtures", "records-example");
  const PERSONS = new Map<string, Person>([
    ["alice", { id: "alice", name: "Alice", role: "member", senderId: "111" }],
    ["carol-tg", { id: "carol-tg", name: "Carol", role: "admin", senderId: "222" }],
  ]);
  // Synthetic low values (below the example thresholds): only the plain single reading may raise an annotation.
  const BY_TEXT: Record<string, unknown> = {
    "screen avg": out(bp({ value: 85, value2: 50, value3: null, reading_kind: "average", indicator: "AVG PM", window: "3 readings" })),
    "screen mem": out(bp({ value: 86, value2: 50, value3: null, reading_kind: "memory-recall", indicator: "MEM" })),
    "screen unk": out(bp({ value: 87, value2: 50, value3: null, reading_kind: "unknown", indicator: "M" })),
    "screen crop": out(bp({ value: null, value2: 52, value3: 80, components: { ...ok, systolic: comp(0, "cropped") } })),
    "screen one": out(bp({ value: 88, value2: 50, value3: null })),
  };
  const llm = oneByOne(async (i) => BY_TEXT[i.text ?? ""], "mock");

  it("rules skip device summaries; unclear and partial screens are queued with a question; the KB tags them", async () => {
    const { store } = await seededStore();
    const t = fakeTelegram();
    const ups = Object.keys(BY_TEXT).map((text) => textUpdate(text, 111));
    for (const u of ups) await handleWebhook(webhook(u), ingestIO(store, t.tg, undefined, "off"));
    const repo = new Repo(root, { "carol-tg": "carol" });
    await pull({ store, r2: { get: async () => { throw new Error("none"); } }, tg: t.tg, repo });
    await extract({ repo, extractor: llm, stt: null, thresholds: loadThresholds(EXAMPLE), persons: PERSONS, now: NOW });
    const key = (text: string) => `${GROUP}:${ups[Object.keys(BY_TEXT).indexOf(text)].message!.message_id}`;
    const entries = new Map(repo.undeliveredDigestEntries().map((e) => [e.key, e]));
    const alerts = (text: string) => entries.get(key(text))!.annotations.length;
    expect(["screen avg", "screen mem", "screen unk", "screen one"].map(alerts)).toEqual([0, 0, 0, 1]);
    expect(entries.get(key("screen unk"))!.questions[0]).toMatch(/^screen shows "M": a new single reading, or the device's stored average\/memory\?/);
    expect(entries.get(key("screen crop"))!.questions[0]).toMatch(/^photo partly legible \(systolic not readable\)/);
    expect(entries.get(key("screen crop"))!.notes).toEqual(["BP ?/52, pulse 80 (not legible: systolic); legible parts kept as uncertain"]);
    expect(repo.queue().map((q) => [q.message_id, q.reasons])).toEqual([[key("screen unk"), ["reading_type_unknown"]], [key("screen crop"), ["partial_reading"]]]);
    const crop = repo.kbRows().find((r) => r.rt === "d1.readings" && r.source_message_id === key("screen crop"));
    expect(crop).toMatchObject({ value: null, value2: 52, value3: 80, missing: JSON.stringify({ systolic: "cropped" }) });

    execFileSync("python3", ["-I", join(import.meta.dirname, "..", "..", "tools", "kb", "build"), "--records", EXAMPLE, "--telegram", join(root, "data", "telegram"), "--db", join(root, "kb.sqlite")], { encoding: "utf8" });
    const db = new DatabaseSync(join(root, "kb.sqlite"));
    const tags = db.prepare("SELECT json_extract(data, '$.components.systolic') AS sys, tags FROM fact WHERE json_extract(data, '$.code') = 'ref:code:bp' ORDER BY json_extract(data, '$.components.diastolic'), sys").all();
    expect(tags.map((r: any) => [r.sys, JSON.parse(r.tags)])).toEqual([
      [85, ["device-average"]], [86, ["device-memory"]], [87, ["device-type-unknown", "needs-human"]], [88, []],
      [null, ["partial-reading", "uncertain", "needs-human"]],
    ]);
    db.close();
  });
});
