// Extraction contract between the LLM and the pipeline.
// The LLM returns EXTRACTION_SCHEMA JSON; parseExtraction() validates it in code and applies
// plausibility checks. Nothing from the LLM reaches the database without passing through here.

import { z } from "zod";
import { MEDIA_KINDS, SIDES, SYMPTOM_TYPES } from "../types.js";
import type { MediaKind, Reading, ReadingType, Side, Symptom, SymptomType } from "../types.js";
import { ContextItem } from "./context.js";

export const REPORT_TYPES = ["lab", "imaging", "discharge", "other"] as const;
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
  context: z.array(ContextItem).describe("life-context signals (ADR 010); [] unless the message header says context: yes"),
  report: z.strictObject({
    report_type: z.enum(REPORT_TYPES).describe("lab = lab/pathology values; imaging = MRI/CT/X-ray/USG/echo/ECG report; discharge; other"),
    sample_at: z.string().nullable().describe("sample COLLECTION / registration date-time as printed (ISO-8601 local, date only if no time printed); never the report/print time. null if not printed"),
    reported_at: z.string().nullable().describe("report / authorised date-time as printed (ISO-8601 local), else null"),
    facility: z.string().nullable().describe("lab, hospital or centre name as printed"),
    doctors: strs("doctor names as printed, with role if printed (e.g. \"Dr A B, MD Pathology (signed)\", \"Ref: Dr C D\")"),
    items: z.array(z.strictObject({
      name: str("test/parameter name exactly as printed"),
      value_num: z.number().nullable().describe("numeric result as printed; null for a text result"),
      value_text: z.string().nullable().describe("text result as printed (e.g. Negative, Reactive, '<0.5'), else null"),
      unit: z.string().nullable().describe("unit as printed"),
      ref_range: z.string().nullable().describe("reference / biological interval exactly as printed, else null"),
      flag: z.string().nullable().describe("H, L or N only if printed (or the value is printed in bold/marked high/low), else null"),
      panel: z.string().nullable().describe("panel / section heading as printed (e.g. Lipid profile), else null"),
    })).describe("EVERY result on EVERY page, in page order; nothing skipped"),
    findings: z.string().nullable().describe("imaging/narrative report: the findings text verbatim; else null"),
    impression: z.string().nullable().describe("imaging/narrative report: the impression / conclusion / opinion verbatim; else null"),
  }).nullable().describe("for a report document/photo (media_kind report): everything printed; null otherwise"),
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
  /** A report document/photo: every printed value, ranges, flags, sample time, facility, doctors, findings, impression.
   *  Stored as d1.report_items (the facts); its K/Na/creatinine/glucose also feed the rules as `reportReadings`. */
  report?: Report | null;
  /** Rule-engine/digest view of report values with a reading type (not stored as d1.readings: the items are the facts). */
  reportReadings?: Reading[];
}

export interface ReportItem {
  name: string;
  valueNum: number | null;
  valueText: string | null;
  unit: string | null;
  refRange: string | null;
  flag: "H" | "L" | "N" | null;
  panel: string | null;
  section: "result" | "findings" | "impression";
}
export interface Report {
  type: (typeof REPORT_TYPES)[number];
  /** Sample collection time (ISO, +05:30 when naive) or date (YYYY-MM-DD); null when not printed. */
  sampleAt: string | null;
  reportedAt: string | null;
  facility: string | null;
  doctors: string[];
  items: ReportItem[];
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

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_REPORT_PAST_MS = 60 * 365 * 86_400_000;
/** A printed report date/time: ISO date-time (naive = IST) or a date; not in the future (1 day grace); else null. */
export function normaliseReportAt(v: unknown, now: string): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.trim();
  const n = Date.parse(now);
  if (DATE_ONLY.test(s)) {
    const t = Date.parse(`${s}T00:00:00+05:30`);
    return Number.isNaN(t) || t > n + 86_400_000 || t < n - MAX_REPORT_PAST_MS ? null : s;
  }
  const iso = HAS_OFFSET.test(s) ? s : `${s}+05:30`;
  const t = Date.parse(iso);
  return Number.isNaN(t) || t > n + 86_400_000 || t < n - MAX_REPORT_PAST_MS ? null : iso;
}

const nstr = (v: unknown, max = 4000) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const FLAG: Record<string, "H" | "L" | "N"> = { h: "H", high: "H", l: "L", low: "L", n: "N", normal: "N" };
/** Report values that are also reading types (rules + digest). Name as printed -> type; units must be canonical. */
const REPORT_READING: [RegExp, ReadingType, RegExp][] = [
  [/^(serum |s\.? ?)?potassium( \(k\+?\))?$|^k\+?$/i, "potassium", /^mmol\/l$|^meq\/l$/i],
  [/^(serum |s\.? ?)?sodium( \(na\+?\))?$|^na\+?$/i, "sodium", /^mmol\/l$|^meq\/l$/i],
  [/^(serum |s\.? ?)?creatinine$/i, "creatinine", /^mg\/dl$/i],
  [/^(plasma |blood )?glucose,? ?(\(?fasting\)?|f)$|^fasting (plasma |blood )?(glucose|sugar)$|^fbs$/i, "glucose_fasting", /^mg\/dl$/i],
];

function parseReport(r: any, now: string): { report: Report | null; readings: Reading[] } {
  if (!r || typeof r !== "object") return { report: null, readings: [] };
  const item = (x: any, section: ReportItem["section"]): ReportItem | null => {
    const name = nstr(x?.name, 200);
    const valueNum = isNum(x?.value_num) ? x.value_num : null;
    const valueText = nstr(x?.value_text, 500);
    if (!name || (valueNum === null && valueText === null)) return null;
    return { name, valueNum, valueText, unit: nstr(x?.unit, 40), refRange: nstr(x?.ref_range, 200), flag: FLAG[String(x?.flag ?? "").trim().toLowerCase()] ?? null, panel: nstr(x?.panel, 120), section };
  };
  const items = (Array.isArray(r.items) ? r.items : []).map((x: any) => item(x, "result")).filter(Boolean) as ReportItem[];
  for (const k of ["findings", "impression"] as const) {
    const t = nstr(r[k], 8000);
    if (t) items.push({ name: k, valueNum: null, valueText: t, unit: null, refRange: null, flag: null, panel: null, section: k });
  }
  const sampleAt = normaliseReportAt(r.sample_at, now);
  const report: Report = {
    type: (REPORT_TYPES as readonly string[]).includes(r.report_type) ? r.report_type : "other",
    sampleAt, reportedAt: normaliseReportAt(r.reported_at, now), facility: nstr(r.facility, 200), doctors: strArr(r.doctors).map((d) => d.trim().slice(0, 200)).filter(Boolean).slice(0, 10), items,
  };
  if (!items.length && !report.facility && !report.sampleAt) return { report: null, readings: [] };
  const at = report.sampleAt ?? report.reportedAt;
  const measuredAt = at && !DATE_ONLY.test(at) ? normaliseMeasuredAt(at, now) : now;
  const readings: Reading[] = [];
  for (const it of items) {
    if (it.valueNum === null) continue;
    const hit = REPORT_READING.find(([re, , unit]) => re.test(it.name.trim()) && unit.test((it.unit ?? "").replace(/\s/g, "")));
    if (hit && inRange(it.valueNum, PLAUSIBLE[hit[1]]) && !readings.some((x) => x.type === hit[1]))
      readings.push({ type: hit[1], value: it.valueNum, value2: null, value3: null, unit: it.unit!, measuredAt });
  }
  return { report, readings };
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
  const { report, readings: reportReadings } = parseReport(obj.report, now);
  return { readings, symptoms, confidence, mediaKind, unreadableReason, subjectHint, rejected, outOfRange, report, reportReadings };
}
