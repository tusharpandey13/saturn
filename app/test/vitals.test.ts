import { describe, expect, it } from "vitest";
import { parseVitals, vitalsEcho } from "../src/vitals.js";

const T = "2026-10-25T03:00:00.000Z";
const p = (text: string) => parseVitals(text, T);
const brief = (text: string) => p(text).readings.map((r) => [r.type, r.value, r.value2, r.value3]);

describe("parseVitals: fixed formats", () => {
  it.each([
    ["120/80 72", [["bp", 120, 80, 72]]],
    ["120/80", [["bp", 120, 80, null]]],
    ["BP 120/80 pulse 72", [["bp", 120, 80, 72]]],
    ["bp 120-80, 72", [["bp", 120, 80, 72]]],
    ["B.P. 132/84", [["bp", 132, 84, null]]],
    ["बीपी 120/80 पल्स 72", [["bp", 120, 80, 72]]],
    ["बीपी १२०/८० पल्स ७२", [["bp", 120, 80, 72]]],
    ["bp 120 by 80", [["bp", 120, 80, null]]],
    ["wajan 62.5", [["weight", 62.5, null, null]]],
    ["weight 62 kg", [["weight", 62, null, null]]],
    ["वज़न 62", [["weight", 62, null, null]]],
    ["spo2 96", [["spo2", 96, null, null]]],
    ["oxygen 96%", [["spo2", 96, null, null]]],
    ["pulse 72", [["pulse", 72, null, null]]],
    ["sugar 110 khali pet", [["glucose_fasting", 110, null, null]]],
    ["sugar 160 khane ke baad", [["glucose_pp", 160, null, null]]],
    ["शुगर 110", [["glucose_random", 110, null, null]]],
    ["aaj subah bp 118/76 pulse 70, wajan 61", [["bp", 118, 76, 70], ["weight", 61, null, null]]],
  ])("%s", (text, want) => {
    expect(brief(text)).toEqual(want);
    expect(p(text).complete).toBe(true);
  });

  it("labelled vitals inside a longer message are read but the message is not complete", () => {
    const v = p("aaj bp 120/80 tha aur chakkar aaya");
    expect(brief("aaj bp 120/80 tha aur chakkar aaya")).toEqual([["bp", 120, 80, null]]);
    expect(v.complete).toBe(false);
  });

  it("unlabelled numbers in chatter are not read as BP (dates, counts)", () => {
    expect(p("dawai 25/10 se band hai").readings).toEqual([]);
    expect(p("good morning").readings).toEqual([]);
    expect(p("").readings).toEqual([]);
  });

  it("implausible values are kept but flagged, and echoed with ?", () => {
    const v = p("bp 210/250");
    expect(v.plausible).toBe(false);
    expect(vitalsEcho(v.readings)).toBe("BP 210/250 ?");
  });

  it("echo format", () => {
    expect(vitalsEcho(p("120/80 72").readings)).toBe("BP 120/80, pulse 72 ✓");
    expect(vitalsEcho(p("wajan 62 spo2 97").readings)).toBe("weight 62 kg ✓ · SpO2 97% ✓");
  });

  it("measured_at is the message time", () => {
    expect(p("spo2 96").readings[0].measuredAt).toBe(T);
  });
});
