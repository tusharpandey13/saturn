// Voice notes: whisper.cpp adapter (fake engine), loop post-check, no-translation guard, statement validation.
// Synthetic data only. The real-engine test runs only when WHISPER_MODEL points at a model file (CI env, or locally).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildArgs, devanagariShare, repetitionVerdict, WhisperCppSpeechToText, WhisperError } from "../../adapters/stt/whisper-cpp.js";
import { durationEn, parseStatements } from "../src/extract/voice.js";
import type { TranscriptSegment } from "../src/types.js";

const seg = (...t: string[]): TranscriptSegment[] => t.map((text, i) => ({ start: i * 5, end: i * 5 + 5, text }));

describe("loop post-check", () => {
  it("accepts ordinary Hindi speech", () => {
    expect(repetitionVerdict(seg("आज सुबह बीपी एक सौ बीस बटा अस्सी था", "कल रात चक्कर आया था", "आज चक्कर नहीं आया"))).toBe("ok");
  });
  it("rejects a segment repeated three times, a word run, and a looping tail", () => {
    expect(repetitionVerdict(seg("दवाई ले ली है", "दवाई ले ली है", "दवाई ले ली है"))).toBe("repetition:segments");
    expect(repetitionVerdict(seg("हाँ हाँ हाँ हाँ हाँ हाँ हाँ हाँ हाँ"))).toBe("repetition:run");
    const loop = Array.from({ length: 12 }, () => "मुझे बहुत कमज़ोरी लग रही है और").join(" ");
    expect(repetitionVerdict(seg("आज सुबह से", loop))).not.toBe("ok");
    expect(repetitionVerdict([])).toBe("empty");
  });
  it("measures the Devanagari share", () => {
    expect(devanagariShare("आज सुबह मेरा BP 120 था")).toBeGreaterThan(0.5);
    expect(devanagariShare("today BP is fine")).toBe(0);
  });
});

describe("no translation, loop protection flags", () => {
  it("never passes --translate; always --max-context 0 and the thresholds", () => {
    const a = buildArgs({ model: "m.bin", wav: "a.wav", out: "o", language: "hi", temperature: 0, threads: 2 });
    expect(a).not.toContain("--translate");
    expect(a).not.toContain("-tr");
    expect(a[a.indexOf("--max-context") + 1]).toBe("0");
    expect(a[a.indexOf("--entropy-thold") + 1]).toBe("2.4");
    expect(a[a.indexOf("--logprob-thold") + 1]).toBe("-1");
    expect(a[a.indexOf("-l") + 1]).toBe("hi");
  });
});

/** Fake ffmpeg + whisper-cli: ffmpeg writes a WAV of `sec` seconds; whisper answers from `outputs` in order. */
function fakeEngine(outputs: (string[] | "fail")[], detect = "hi", p = 0.97, sec = 12) {
  const calls: string[][] = [];
  let i = 0;
  const exec = async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    if (cmd === "ffmpeg") {
      writeFileSync(args[args.length - 1], Buffer.alloc(44 + sec * 32_000));
      return { code: 0, stderr: "" };
    }
    if (args.includes("--detect-language")) return { code: 0, stderr: `whisper_full: auto-detected language: ${detect} (p = ${p})\n` };
    const o = outputs[i++];
    if (o === "fail" || o === undefined) return { code: 1, stderr: "" };
    const lang = args[args.indexOf("-l") + 1];
    writeFileSync(`${args[args.indexOf("--output-file") + 1]}.json`, JSON.stringify({ result: { language: lang === "auto" ? detect : lang },
      transcription: o.map((text, k) => ({ offsets: { from: k * 4000, to: k * 4000 + 4000 }, text: ` ${text}` })) }));
    return { code: 0, stderr: "" };
  };
  return { calls, exec };
}
const OGG = { data: new Uint8Array([0x4f, 0x67, 0x67, 0x53]), mimeType: "audio/ogg" };

describe("WhisperCppSpeechToText (fake engine)", () => {
  it("transcribes with -l hi, keeps timed segments and records how", async () => {
    const f = fakeEngine([["आज चक्कर नहीं आया", "बीपी ठीक है"]]);
    const t = await new WhisperCppSpeechToText({ model: "m.bin", exec: f.exec, threads: 2 }).transcribe(OGG);
    expect(t.text).toBe("आज चक्कर नहीं आया बीपी ठीक है");
    expect(t.segments).toEqual([{ start: 0, end: 4, text: "आज चक्कर नहीं आया" }, { start: 4, end: 8, text: "बीपी ठीक है" }]);
    expect(t.meta).toMatchObject({ accepted: true, audioSec: 12, attempts: [{ language: "hi", temperature: 0, verdict: "ok" }] });
    expect(t.meta!.settings).toMatch(/--max-context 0.*no translation/);
    expect(f.calls.flat()).not.toContain("--translate");
  });
  it("a looping output is rejected and retried at a higher temperature, then with auto-detect", async () => {
    const loop = Array(4).fill("दवाई ले ली है");
    const f = fakeEngine([loop, loop, ["आज दवाई ले ली है"]]);
    const t = await new WhisperCppSpeechToText({ model: "m.bin", exec: f.exec }).transcribe(OGG);
    expect(t.meta!.attempts.map((a) => [a.language, a.temperature, a.verdict])).toEqual([["hi", 0, "repetition:segments"], ["hi", 0.4, "repetition:segments"], ["auto", 0, "ok"]]);
    expect(t.text).toBe("आज दवाई ले ली है");
  });
  it("every attempt looping: the text is returned unaccepted (nothing will be extracted from it)", async () => {
    const loop = Array(4).fill("दवाई ले ली है");
    const t = await new WhisperCppSpeechToText({ model: "m.bin", exec: fakeEngine([loop, loop, loop, loop]).exec }).transcribe(OGG);
    expect(t.meta!.accepted).toBe(false);
    expect(t.meta!.attempts).toHaveLength(4);
  });
  it("confident non-Hindi detection starts with auto (forcing hi would translate)", async () => {
    const f = fakeEngine([["my BP is fine today"]], "en", 0.95);
    const t = await new WhisperCppSpeechToText({ model: "m.bin", exec: f.exec }).transcribe(OGG);
    expect(t.meta!.attempts[0]).toMatchObject({ language: "auto", verdict: "ok" });
    expect(t.languageCode).toBe("en");
  });
  it("engine crash on every attempt is an error; a missing binary is transient", async () => {
    await expect(new WhisperCppSpeechToText({ model: "m.bin", exec: fakeEngine(["fail", "fail", "fail", "fail"]).exec }).transcribe(OGG)).rejects.toBeInstanceOf(WhisperError);
    expect(new WhisperError("spawn_failed").status).toBe(0);
    expect(new WhisperError("exit_1").status).toBeUndefined();
  });
});

describe("statements from a transcript", () => {
  const T = "[00:00] कल रात चक्कर आया था [00:04] आज चक्कर नहीं आया [00:08] बीपी की दवाई दो दिन से नहीं ली";
  const st = (o: Record<string, unknown>) => ({ category: "symptom", summary: "dizziness last night", quote: "कल रात चक्कर आया था", negated: false, time_frame: "past",
    when_text: "kal raat", when: "2026-10-30", speaker: "sender", speaker_name: null, about: null, confidence: 0.9, ...o });
  it("keeps verbatim quotes, negations and past/current; resolves dates no later than the message", () => {
    const r = parseStatements({ statements: [st({}), st({ summary: "no dizziness today", quote: "आज चक्कर नहीं आया", negated: true, time_frame: "current", when: "2026-10-31", when_text: "aaj" }),
      st({ category: "medication", summary: "has not taken the BP medicine for two days", quote: "बीपी की दवाई दो दिन से नहीं ली", time_frame: "ongoing", when: "2026-10-29" })] }, "2026-10-31T05:51:26.000Z", T);
    expect(r.dropped).toBe(0);
    expect(r.statements.map((s) => [s.negated, s.timeFrame, s.when])).toEqual([[false, "past", "2026-10-30"], [true, "current", "2026-10-31"], [false, "ongoing", "2026-10-29"]]);
  });
  it("drops a translated or invented quote and a future date for a past event", () => {
    const r = parseStatements({ statements: [st({ quote: "felt dizzy last night" }), st({ quote: "उल्टी हुई" }), st({ when: "2026-11-05" }), { bad: 1 }] }, "2026-10-31T05:51:26.000Z", T);
    expect(r.dropped).toBe(3);
    expect(r.statements).toHaveLength(1);
    expect(r.statements[0].when).toBeNull(); // unusable date: the message time stands; when_text keeps the words
  });
  it("formats durations", () => {
    expect(durationEn(228)).toBe("3 min 48 s");
    expect(durationEn(7)).toBe("7 s");
  });
});

const MODEL = process.env.WHISPER_MODEL;
const CLIP = join(import.meta.dirname, "..", "..", "fixtures", "app", "voice", "synthetic-hi.ogg"); // macOS TTS (synthetic sentence, no PHI)
describe.skipIf(!MODEL || !existsSync(MODEL))("real whisper.cpp on a synthetic TTS clip (WHISPER_MODEL set)", () => {
  it("returns Devanagari, timed, accepted, untranslated", async () => {
    const t = await new WhisperCppSpeechToText({ model: MODEL!, bin: process.env.WHISPER_BIN || "whisper-cli" }).transcribe({ data: new Uint8Array(readFileSync(CLIP)), mimeType: "audio/ogg" });
    expect(t.meta!.accepted).toBe(true);
    expect(devanagariShare(t.text)).toBeGreaterThan(0.5);
    expect(t.text).toMatch(/चक्कर/);
    expect(t.segments!.length).toBeGreaterThan(0);
  }, 300_000);
});
