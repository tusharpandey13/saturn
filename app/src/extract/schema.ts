// Extraction contract between the LLM and the pipeline.
// The LLM returns EXTRACTION_SCHEMA JSON; parseExtraction() validates it in code and applies
// plausibility checks. Nothing from the LLM reaches the database without passing through here.

import { z } from "zod";
import { MEDIA_KINDS, SIDES, SYMPTOM_TYPES } from "../types.js";
import type { MediaKind, Reading, ReadingType, Side, Symptom, SymptomType } from "../types.js";

const READING_TYPES = [
  "weight", "bp", "pulse", "spo2", "potassium", "sodium", "creatinine", "glucose_fasting", "glucose_pp", "glucose_random",
] as const satisfies readonly ReadingType[];
const str = (description?: string) => (description ? z.string().describe(description) : z.string());
const strs = (description?: string) => (description ? z.array(z.string()).describe(description) : z.array(z.string()));

/** The extraction contract (Zod 4). Strict: every property required (nullable where optional), no extras. */
export const ExtractionOutput = z.strictObject({
  media_kind: z.enum([...MEDIA_KINDS, "none"]).describe(
    "classify FIRST: what a photo/PDF shows (device_reading, prescription, medicine strip/box, report = lab report/scan/discharge, other = other health, non_health = screenshot, scenery, greeting, anything not about health); none for text/voice",
  ),
  readings: z.array(z.strictObject({
    type: z.enum(READING_TYPES),
    value: z.number().describe("weight kg | systolic | bpm | SpO2 % | lab value | blood sugar"),
    value2: z.number().nullable().describe("diastolic for bp, else null"),
    value3: z.number().nullable().describe("pulse shown on a BP monitor, else null"),
    unit: z.string(),
    measured_at: z.string().nullable().describe("ISO-8601 if shown on the device/report, else null"),
  })),
  symptoms: z.array(z.strictObject({
    symptom_type: z.enum(SYMPTOM_TYPES),
    location: z.string().nullable().describe("region_code, e.g. chest, neck, hand, ankle, abdomen"),
    side: z.enum(SIDES),
    character: strs(),
    severity: z.int().nullable().describe("0-10 only if a number was said"),
    duration_min: z.int().nullable(),
    at_rest: z.boolean().nullable(),
    associated: strs("e.g. sweating, breathlessness, dizziness, fainting, nausea, vomiting, chest_pain"),
    triggers: strs("what brought it on, e.g. exertion, walking, stairs, after_meal, emotion, neck_position, cold"),
    onset_at: z.string().nullable().describe("ISO-8601 local time the symptom started, only if said (\"kal raat 2 baje\"), else null"),
    free_text: str("verbatim span supporting this record"),
  })),
  confidence: z.number().describe("0-1 overall confidence"),
  unreadable_reason: z.string().nullable(),
  subject_hint: z.string().nullable().describe(
    "only when the message is clearly about someone other than the sender (e.g. \"Maa's BP 120/80\" sent by her son): who, as written; else null",
  ),
});

/** JSON Schema for structured output (`claude --json-schema`), generated from the Zod contract. */
export const EXTRACTION_SCHEMA = (() => {
  const { $schema: _drop, ...s } = z.toJSONSchema(ExtractionOutput) as Record<string, any>;
  return s as { type: "object"; required: string[]; properties: Record<string, unknown>; additionalProperties: false };
})();

const isReadingType = (v: unknown): v is ReadingType => z.enum(READING_TYPES).safeParse(v).success;

/** Plausible ranges (hf-home-monitoring.md and architecture-options.md guardrails). Out of range = ask again. */
export const PLAUSIBLE: Record<ReadingType, [number, number]> = {
  weight: [30, 150],
  bp: [60, 250], // systolic
  pulse: [25, 250],
  spo2: [70, 100],
  potassium: [2, 9],
  sodium: [100, 170],
  creatinine: [0.2, 15],
  glucose_fasting: [20, 600], // glucometers read 20-600 mg/dL; "LO"/"HI" are not numbers
  glucose_pp: [20, 600],
  glucose_random: [20, 600],
};
const DIA_RANGE: [number, number] = [30, 150];

export interface Extraction {
  readings: Reading[];
  symptoms: Symptom[];
  confidence: number;
  /** What a photo/PDF shows (null for text/voice or when not reported). */
  mediaKind: MediaKind | null;
  unreadableReason: string | null;
  /** The message seems to be about someone other than the sender (as written, e.g. "Maa"). A flag for human review only:
   *  records stay attributed to the sender. */
  subjectHint: string | null;
  /** Human-readable reasons items were dropped. */
  rejected: string[];
  /** Well-formed readings outside the plausible range (misread, or a real extreme). */
  outOfRange: { type: ReadingType; value: number }[];
}

const HAS_OFFSET = /([zZ]|[+-]\d{2}:?\d{2})$/;
const MAX_PAST_MS = 30 * 86_400_000;
const MAX_FUTURE_MS = 3_600_000;

/** Device/report time: naive timestamps are Asia/Kolkata; anything outside [now-30d, now+1h] -> message time. */
export function normaliseMeasuredAt(v: unknown, now: string): string {
  if (typeof v !== "string" || !v.trim()) return now;
  const iso = HAS_OFFSET.test(v.trim()) ? v.trim() : `${v.trim()}+05:30`;
  const t = Date.parse(iso);
  const n = Date.parse(now);
  if (Number.isNaN(t) || t < n - MAX_PAST_MS || t > n + MAX_FUTURE_MS) return now;
  return iso;
}

const LB_TO_KG = 0.45359237;
/** Canonical units: weight kg, creatinine mg/dL. Returns null for an unknown unit. */
function canonical(type: ReadingType, value: number, unitRaw: unknown): { value: number; unit: string; sourceValue?: number; sourceUnit?: string } | null {
  const unit = String(unitRaw ?? "").trim().toLowerCase();
  if (type === "weight") {
    if (["", "kg", "kgs", "kilogram", "kilograms", "किलो"].includes(unit)) return { value, unit: "kg" };
    if (["lb", "lbs", "pound", "pounds"].includes(unit)) return { value: +(value * LB_TO_KG).toFixed(1), unit: "kg", sourceValue: value, sourceUnit: unit };
    return null;
  }
  if (type.startsWith("glucose")) {
    if (["", "mg/dl", "mg"].includes(unit)) return { value, unit: "mg/dL" };
    if (/^mmol/.test(unit)) return { value: Math.round(value * 18), unit: "mg/dL", sourceValue: value, sourceUnit: unit };
    return null;
  }
  if (type === "creatinine" && /^(umol|µmol|μmol)/.test(unit)) return { value: +(value / 88.4).toFixed(2), unit: "mg/dL", sourceValue: value, sourceUnit: unit };
  return { value, unit: String(unitRaw ?? "") };
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const inRange = (v: number, [lo, hi]: [number, number]) => v >= lo && v <= hi;
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function parseReading(r: any, now: string, rejected: string[], outOfRange: Extraction["outOfRange"]): Reading | null {
  if (!r || !isReadingType(r.type) || !isNum(r.value)) {
    rejected.push(`malformed reading: ${JSON.stringify(r)}`);
    return null;
  }
  const type = r.type as ReadingType;
  const value2 = isNum(r.value2) ? r.value2 : null;
  const value3 = isNum(r.value3) ? r.value3 : null;
  const c = canonical(type, r.value, r.unit);
  if (!c) {
    rejected.push(`${type}: unknown unit ${JSON.stringify(r.unit)}`);
    return null;
  }
  if (!inRange(c.value, PLAUSIBLE[type])) {
    rejected.push(`${type} ${c.value} outside ${PLAUSIBLE[type].join("-")}`);
    outOfRange.push({ type, value: c.value });
    return null;
  }
  if (type === "bp") {
    if (value2 === null || !inRange(value2, DIA_RANGE) || r.value <= value2) {
      rejected.push(`bp ${r.value}/${value2} implausible`);
      return null;
    }
    if (value3 !== null && !inRange(value3, PLAUSIBLE.pulse)) {
      rejected.push(`bp pulse ${value3} implausible`);
      return null;
    }
  }
  return {
    type, value: c.value, value2: type === "bp" ? value2 : null, value3: type === "bp" ? value3 : null, unit: c.unit,
    measuredAt: normaliseMeasuredAt(r.measured_at, now),
    ...(c.sourceUnit && { sourceValue: c.sourceValue, sourceUnit: c.sourceUnit }),
  };
}

function parseSymptom(s: any, now: string, rejected: string[]): Symptom | null {
  if (!s || !SYMPTOM_TYPES.includes(s.symptom_type)) {
    rejected.push(`malformed symptom: ${JSON.stringify(s)}`);
    return null;
  }
  const severity = Number.isInteger(s.severity) && s.severity >= 0 && s.severity <= 10 ? s.severity : null;
  return {
    symptomType: s.symptom_type as SymptomType,
    location: typeof s.location === "string" ? s.location : null,
    side: SIDES.includes(s.side) ? (s.side as Side) : "unknown",
    character: strArr(s.character),
    severity,
    durationMin: Number.isInteger(s.duration_min) && s.duration_min >= 0 ? s.duration_min : null,
    atRest: typeof s.at_rest === "boolean" ? s.at_rest : null,
    associated: strArr(s.associated),
    triggers: strArr(s.triggers),
    freeText: typeof s.free_text === "string" ? s.free_text : "",
    observedAt: normaliseMeasuredAt(s.onset_at, now),
  };
}

/** Validate untrusted LLM output. Accepts an object or a JSON string. Never throws. */
export function parseExtraction(raw: unknown, now: string): Extraction {
  const rejected: string[] = [];
  let obj: any = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return { readings: [], symptoms: [], confidence: 0, mediaKind: null, unreadableReason: "invalid JSON from extractor", subjectHint: null, rejected: ["invalid JSON"], outOfRange: [] };
    }
  }
  if (!obj || typeof obj !== "object") obj = {};
  const outOfRange: Extraction["outOfRange"] = [];
  const readings = (Array.isArray(obj.readings) ? obj.readings : []).map((r: any) => parseReading(r, now, rejected, outOfRange)).filter(Boolean) as Reading[];
  const symptoms = (Array.isArray(obj.symptoms) ? obj.symptoms : []).map((s: any) => parseSymptom(s, now, rejected)).filter(Boolean) as Symptom[];
  const confidence = isNum(obj.confidence) ? Math.min(1, Math.max(0, obj.confidence)) : 0;
  const unreadableReason = typeof obj.unreadable_reason === "string" ? obj.unreadable_reason : null;
  const mediaKind = MEDIA_KINDS.includes(obj.media_kind) ? (obj.media_kind as MediaKind) : null;
  if (mediaKind === "non_health") {
    // Not health content: recorded as a source only. No facts, no question, nothing for the deep read.
    return { readings: [], symptoms: [], confidence, mediaKind, unreadableReason: null, subjectHint: null, rejected: [], outOfRange: [] };
  }
  const hint = typeof obj.subject_hint === "string" ? obj.subject_hint.trim().slice(0, 80) : "";
  const subjectHint = hint && !/^(null|none|self|sender)$/i.test(hint) ? hint : null;
  return { readings, symptoms, confidence, mediaKind, unreadableReason, subjectHint, rejected, outOfRange };
}
