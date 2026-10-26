import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS as T } from "../src/config/thresholds.js";
import { evaluate, evaluateSymptoms, highestTier, localDate } from "../src/rules/engine.js";
import type { Reading, Symptom } from "../src/types.js";

const TZ = "Asia/Kolkata";
const r = (type: Reading["type"], value: number, measuredAt = "2026-10-24T08:00:00+05:30", value2: number | null = null, value3: number | null = null): Reading => ({ type, value, value2, value3, unit: "", measuredAt });
const s = (symptomType: Symptom["symptomType"], extra: Partial<Symptom> = {}): Symptom => ({
  symptomType, location: null, side: "unknown", character: [], severity: null, durationMin: null, atRest: null, associated: [], triggers: [], freeText: "", observedAt: "2026-10-24T08:00:00+05:30", ...extra,
});
const run = (readings: Reading[], symptoms: Symptom[] = [], weightHistory: Reading[] = [], contextSymptoms: Symptom[] = []) =>
  evaluate({ readings, symptoms, weightHistory, contextSymptoms, thresholds: T, timeZone: TZ });
const codes = (a: { code: string }[]) => a.map((x) => x.code);
const day = (d: number, time = "08:00") => `2026-10-${String(d).padStart(2, "0")}T${time}:00+05:30`;

describe("thresholds config", () => {
  it("is marked pending clinician sign-off", () => {
    expect(T.status).toBe("pending_clinician_signoff");
  });
});

describe("SpO2", () => {
  it.each([
    [89, [], 1, "SPO2_LOW"],
    [90, [], 2, "SPO2_BORDERLINE"],
    [92, [s("breathlessness")], 1, "SPO2_LOW_BREATHLESS"],
    [92, [], 2, "SPO2_BORDERLINE"],
    [94, [], 2, "SPO2_BORDERLINE"],
  ] as const)("%i%% with %j -> tier %i", (v, sy, tier, code) => {
    const a = run([r("spo2", v)], [], [], [...sy]);
    expect(a[0]).toMatchObject({ tier, code });
  });
  it("95% is normal", () => expect(run([r("spo2", 95)])).toEqual([]));
});

describe("pulse", () => {
  it("< 40 is tier 1", () => expect(run([r("pulse", 39)])[0]).toMatchObject({ tier: 1, code: "PULSE_VERY_LOW" }));
  it("< 50 with dizziness is tier 1", () => expect(run([r("pulse", 48)], [s("dizziness")])[0]).toMatchObject({ tier: 1, code: "PULSE_LOW_SYMPTOMATIC" }));
  it("< 50 alone is tier 2", () => expect(run([r("pulse", 48)])[0]).toMatchObject({ tier: 2, code: "PULSE_LOW" }));
  it("> 130 is tier 1", () => expect(run([r("pulse", 131)])[0]).toMatchObject({ tier: 1, code: "PULSE_FAST" }));
  it("50 and 130 are normal", () => expect(run([r("pulse", 50), r("pulse", 130)])).toEqual([]));
  it("pulse shown on a BP monitor is checked too", () => expect(codes(run([r("bp", 120, undefined, 80, 38)]))).toEqual(["PULSE_VERY_LOW"]));
});

describe("blood pressure", () => {
  it("SYS < 80 with dizziness is tier 1", () => expect(run([r("bp", 78, undefined, 50)], [s("dizziness")])[0]).toMatchObject({ tier: 1 }));
  it("SYS < 80 without symptoms is tier 2", () => expect(run([r("bp", 78, undefined, 50)])[0]).toMatchObject({ tier: 2, code: "SBP_LOW_SYMPTOMATIC" }));
  it("SYS 88 with dizziness is tier 2", () => expect(highestTier(run([r("bp", 88, undefined, 60)], [s("dizziness")]))).toBe(2));
  it("SYS 88 without symptoms is tier 3 (log only)", () => expect(run([r("bp", 88, undefined, 60)])[0]).toMatchObject({ tier: 3, code: "SBP_LOW_ASYMPTOMATIC" }));
  it("128/82 is normal", () => expect(run([r("bp", 128, undefined, 82, 76)])).toEqual([]));
});

describe("labs", () => {
  it("K 6.0 is tier 1, K 5.6 tier 2, K 5.5 normal", () => {
    expect(run([r("potassium", 6.0)])[0]).toMatchObject({ tier: 1, code: "POTASSIUM_HIGH" });
    expect(run([r("potassium", 5.6)])[0]).toMatchObject({ tier: 2 });
    expect(run([r("potassium", 5.5)])).toEqual([]);
  });
  it("Na < 130 and creatinine > 2.5 are tier 2", () => {
    expect(codes(run([r("sodium", 129), r("creatinine", 2.6)]))).toEqual(["SODIUM_LOW", "CREATININE_HIGH"]);
  });
});

describe("weight trends", () => {
  it("> 1.5 kg in 1 day is tier 2", () => {
    const a = run([r("weight", 63.6, day(24))], [], [r("weight", 62.0, day(23))]);
    expect(codes(a)).toContain("WEIGHT_GAIN_1D");
    expect(highestTier(a)).toBe(2);
  });
  it("exactly 1.5 kg in 1 day does not fire", () => {
    expect(run([r("weight", 63.5, day(24))], [], [r("weight", 62.0, day(23))])).toEqual([]);
  });
  it("> 2 kg over 3 days fires even when each day is small", () => {
    const hist = [r("weight", 60.0, day(21)), r("weight", 60.8, day(22)), r("weight", 61.5, day(23))];
    const a = run([r("weight", 62.1, day(24))], [], hist);
    expect(codes(a)).toEqual(["WEIGHT_GAIN_3D"]);
  });
  it("a reading 4 days ago is outside the 3-day window but inside 7 days", () => {
    const a = run([r("weight", 62.2, day(24))], [], [r("weight", 60.0, day(20))]);
    expect(codes(a)).toEqual([]); // 2.2 kg: not > 2.3 in 7 days, outside 3-day window
    expect(codes(run([r("weight", 62.4, day(24))], [], [r("weight", 60.0, day(20))]))).toEqual(["WEIGHT_GAIN_7D"]);
  });
  it("uses calendar days in IST, not 24 h windows", () => {
    // 23:30 IST yesterday vs 06:00 today is 'yesterday' even though only 6.5 h apart
    expect(localDate("2026-10-23T18:00:00Z", TZ)).toBe("2026-10-23");
    expect(localDate("2026-10-23T19:00:00Z", TZ)).toBe("2026-10-24");
    const a = run([r("weight", 63.6, day(24, "06:00"))], [], [r("weight", 62.0, day(23, "23:30"))]);
    expect(codes(a)).toContain("WEIGHT_GAIN_1D");
  });
  it("same-day earlier readings are ignored (no intraday trend)", () => {
    expect(run([r("weight", 64, day(24, "20:00"))], [], [r("weight", 62, day(24, "07:00"))])).toEqual([]);
  });
  it("weight loss > 2 kg in 3 days fires only with dizziness", () => {
    const hist = [r("weight", 62.5, day(22))];
    expect(run([r("weight", 60.0, day(24))], [], hist)).toEqual([]);
    expect(codes(run([r("weight", 60.0, day(24))], [s("dizziness")], hist))).toContain("WEIGHT_LOSS_DIZZY");
  });
  it("no history, no trend alert", () => expect(run([r("weight", 70)])).toEqual([]));
});

describe("symptoms", () => {
  it("chest pain > 15 min is tier 1; unknown duration is tier 1; brief without associated is tier 2", () => {
    expect(evaluateSymptoms([s("chest_pain", { durationMin: 20 })], T)[0].tier).toBe(1);
    expect(evaluateSymptoms([s("chest_pain")], T)[0].tier).toBe(1);
    expect(evaluateSymptoms([s("chest_pain", { durationMin: 5 })], T)[0]).toMatchObject({ tier: 2, code: "CHEST_PAIN_BRIEF" });
    expect(evaluateSymptoms([s("chest_pain", { durationMin: 5, associated: ["sweating"] })], T)[0].tier).toBe(1);
  });
  it.each(["syncope", "stroke_signs", "angioedema", "confusion"] as const)("%s is tier 1", (t) => {
    expect(evaluateSymptoms([s(t)], T)[0].tier).toBe(1);
  });
  it("breathlessness at rest is tier 1, on exertion tier 3", () => {
    expect(evaluateSymptoms([s("breathlessness", { atRest: true })], T)[0].tier).toBe(1);
    expect(evaluateSymptoms([s("breathlessness", { atRest: false })], T)[0].tier).toBe(3);
  });
  it("palpitations with dizziness tier 1, alone tier 2", () => {
    expect(evaluateSymptoms([s("palpitations", { associated: ["dizziness"] })], T)[0].tier).toBe(1);
    expect(evaluateSymptoms([s("palpitations")], T)[0].tier).toBe(2);
  });
  it("abdominal swelling tier 2, ankle swelling tier 3; neuro symptoms do not alert here", () => {
    expect(evaluateSymptoms([s("swelling", { location: "abdomen" })], T)[0].tier).toBe(2);
    expect(evaluateSymptoms([s("swelling", { location: "ankle" })], T)[0].tier).toBe(3);
    expect(evaluateSymptoms([s("tingling")], T)).toEqual([]);
  });
  it("context symptoms inform reading rules but are not re-alerted", () => {
    const a = run([r("pulse", 45)], [], [], [s("syncope")]);
    expect(codes(a)).toEqual(["PULSE_LOW_SYMPTOMATIC"]);
  });
});

describe("evaluate", () => {
  it("sorts by tier and dedupes codes", () => {
    const a = run([r("spo2", 89), r("spo2", 88)], [s("dizziness")]);
    expect(a.map((x) => x.tier)).toEqual([1, 3]);
    expect(codes(a)).toEqual(["SPO2_LOW", "DIZZINESS"]);
  });
  it("is a pure function (same input, same output)", () => {
    const input = [r("weight", 63.6, day(24))];
    expect(run(input, [], [r("weight", 62, day(23))])).toEqual(run(input, [], [r("weight", 62, day(23))]));
  });
});
