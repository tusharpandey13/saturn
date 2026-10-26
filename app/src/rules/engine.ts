// Deterministic red-flag rules. Pure functions: no I/O, no LLM, no clock.
// Every threshold comes from Thresholds (src/config/thresholds.ts).
// ADR 005: these only annotate the daily digest ("unverified; doctor sign-off pending"). Nothing alerts in real time.

import type { Thresholds } from "../config/thresholds.js";
import type { Alert, Reading, Symptom, SymptomType } from "../types.js";

export interface RuleInput {
  /** Newly confirmed readings to evaluate. */
  readings: Reading[];
  /** Symptoms reported in the message being evaluated. */
  symptoms: Symptom[];
  /** Recent earlier symptoms (caller picks the window). Only used for "reading + symptom" rules, never re-alerted. */
  contextSymptoms?: Symptom[];
  /** Earlier confirmed weight readings (any order). Needed for trend rules. */
  weightHistory: Reading[];
  thresholds: Thresholds;
  timeZone: string;
}

/** Calendar date (YYYY-MM-DD) of an ISO timestamp in the given time zone. */
export function localDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(iso),
  );
}

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);
}

const present = (symptoms: Symptom[], ...types: (SymptomType | string)[]): boolean =>
  symptoms.some((s) => types.includes(s.symptomType) || s.associated.some((a) => types.includes(a)));

const alert = (tier: Alert["tier"], code: string, detail: string, source: string): Alert => ({ tier, code, detail, source });

// ---------- symptoms ----------

/** Symptom rules. */
export function evaluateSymptoms(symptoms: Symptom[], t: Thresholds): Alert[] {
  const out: Alert[] = [];
  for (const s of symptoms) {
    const has = (...a: string[]) => s.associated.some((x) => a.includes(x));
    switch (s.symptomType) {
      case "chest_pain": {
        const long = s.durationMin === null || s.durationMin > t.chestPainTier1MinDurationMin;
        if (long || has("sweating", "breathlessness", "fainting", "syncope", "vomiting", "nausea")) {
          out.push(alert(1, "CHEST_PAIN", `Chest pain (duration ${s.durationMin ?? "unknown"} min, with: ${s.associated.join(", ") || "none"})`, "ACS public advice; PLACEHOLDER duration"));
        } else {
          out.push(alert(2, "CHEST_PAIN_BRIEF", `Brief chest discomfort (${s.durationMin} min), settled`, "hf-red-flags.md tier 2, PLACEHOLDER"));
        }
        break;
      }
      case "breathlessness":
        if (s.atRest) out.push(alert(1, "BREATHLESS_AT_REST", "Breathlessness at rest", "Acute HF features [S1, S7]"));
        else if (s.atRest === null && (s.severity ?? 0) >= t.breathlessUnknownRestTier2Severity)
          out.push(alert(2, "BREATHLESS_SEVERE_UNCLEAR", `Breathlessness severity ${s.severity}/10, unknown whether at rest`, "[S7], PLACEHOLDER"));
        else out.push(alert(3, "BREATHLESS_EXERTION", "Breathlessness on exertion (trend vs baseline not yet implemented)", "[S7]"));
        break;
      case "syncope":
        out.push(alert(1, "SYNCOPE", "Fainting or collapse", "[S22, S11]"));
        break;
      case "stroke_signs":
        out.push(alert(1, "STROKE_SIGNS", "Possible stroke signs", "Standard"));
        break;
      case "angioedema":
        out.push(alert(1, "ANGIOEDEMA", "Swelling of lips, tongue or throat", "ARNI warning [S3a, S24]"));
        break;
      case "confusion":
        out.push(alert(1, "CONFUSION", "New confusion or unusual drowsiness", "[S8], PLACEHOLDER"));
        break;
      case "palpitations":
        if (has("dizziness", "chest_pain", "breathlessness", "fainting", "syncope"))
          out.push(alert(1, "PALPITATIONS_SYMPTOMATIC", `Palpitations with ${s.associated.join(", ")}`, "[S22], PLACEHOLDER"));
        else out.push(alert(2, "PALPITATIONS", "Palpitations", "[S18, S22]"));
        break;
      case "orthopnea":
        out.push(alert(2, "ORTHOPNEA", "Breathless lying flat / waking breathless", "HFA Table 2 [S7]"));
        break;
      case "vomiting_diarrhoea":
        out.push(alert(2, "SICK_DAY", "Vomiting or diarrhoea", "SIGN MRA [S8], SGLT2i [S25]"));
        break;
      case "fall":
        out.push(alert(2, "FALL", "Fall reported", "symptom-log-schema.md FALL"));
        break;
      case "swelling":
        if (s.location === "abdomen") out.push(alert(2, "ABDOMINAL_SWELLING", "Abdominal swelling or bloating", "[S7]"));
        else out.push(alert(3, "SWELLING", `Swelling (${s.location ?? "unspecified"}, ${s.side})`, "[S7, S16]"));
        break;
      case "dizziness":
        out.push(alert(3, "DIZZINESS", "Dizziness", "[S8]"));
        break;
    }
  }
  return out;
}

// ---------- readings ----------

function evaluateSpo2(v: number, sy: Symptom[], t: Thresholds): Alert | null {
  const s = t.spo2;
  if (v < s.tier1Below) return alert(1, "SPO2_LOW", `SpO2 ${v}% (< ${s.tier1Below})`, "ESC 2021 [S15]");
  if (v <= s.tier1WithBreathlessnessAtOrBelow && present(sy, "breathlessness"))
    return alert(1, "SPO2_LOW_BREATHLESS", `SpO2 ${v}% with breathlessness`, "NHS oximetry [S14]");
  if (v <= s.tier2AtOrBelow) return alert(2, "SPO2_BORDERLINE", `SpO2 ${v}% (<= ${s.tier2AtOrBelow}); recheck at rest`, "NHS oximetry [S14], adapted");
  return null;
}

function evaluatePulse(v: number, sy: Symptom[], t: Thresholds): Alert | null {
  const p = t.pulse;
  if (v < p.tier1Below) return alert(1, "PULSE_VERY_LOW", `Pulse ${v} bpm (< ${p.tier1Below})`, "PLACEHOLDER");
  if (v < p.tier1BelowWithSymptoms && present(sy, "syncope", "fainting", "dizziness", "confusion", "breathlessness"))
    return alert(1, "PULSE_LOW_SYMPTOMATIC", `Pulse ${v} bpm with symptoms`, "SIGN [S8], rate-lowering drug label [S18]");
  if (v > p.tier1Above) return alert(1, "PULSE_FAST", `Pulse ${v} bpm (> ${p.tier1Above})`, "PLACEHOLDER [S22]");
  if (v < p.tier2Below) return alert(2, "PULSE_LOW", `Pulse ${v} bpm (< ${p.tier2Below}); confirm with a 60 s manual count`, "Rate-lowering drug label [S18]");
  return null;
}

function evaluateBp(sys: number, dia: number | null, sy: Symptom[], t: Thresholds): Alert | null {
  const b = t.sbp;
  const bp = `BP ${sys}/${dia ?? "?"}`;
  const symptomatic = present(sy, "dizziness", "confusion", "syncope", "fainting");
  if (sys < b.tier1BelowWithSymptoms && symptomatic)
    return alert(1, "SBP_VERY_LOW_SYMPTOMATIC", `${bp} with dizziness/confusion/fainting`, "PLACEHOLDER [Island Health]");
  if (sys < b.tier2BelowWithDizziness && (symptomatic || sys < b.tier1BelowWithSymptoms))
    return alert(2, "SBP_LOW_SYMPTOMATIC", `${bp} (SYS < ${b.tier2BelowWithDizziness})${symptomatic ? " with symptoms" : ""}`, "SIGN [S8], drug label [S19]");
  if (sys < b.tier3Below) return alert(3, "SBP_LOW_ASYMPTOMATIC", `${bp}, no symptoms reported`, "SIGN [S8]");
  return null;
}

function evaluateLab(r: Reading, t: Thresholds): Alert | null {
  const l = t.labs;
  if (r.type === "potassium") {
    if (r.value >= l.potassiumTier1AtOrAbove) return alert(1, "POTASSIUM_HIGH", `Potassium ${r.value} mmol/L (>= ${l.potassiumTier1AtOrAbove}); call the treating doctor now, emergency care if unreachable`, "SIGN MRA [S8], NHS SPS [S9]");
    if (r.value > l.potassiumTier2Above) return alert(2, "POTASSIUM_RAISED", `Potassium ${r.value} mmol/L (> ${l.potassiumTier2Above})`, "SIGN [S8], NHS SPS [S9]");
  }
  if (r.type === "sodium" && r.value < l.sodiumTier2Below)
    return alert(2, "SODIUM_LOW", `Sodium ${r.value} mmol/L (< ${l.sodiumTier2Below})`, "PLACEHOLDER");
  if (r.type === "creatinine" && r.value > l.creatinineTier2AboveMgDl)
    return alert(2, "CREATININE_HIGH", `Creatinine ${r.value} mg/dL (> ${l.creatinineTier2AboveMgDl})`, "SIGN [S8], NHS SPS [S9]");
  return null;
}

/**
 * Weight trend: gain = new reading minus the LOWEST reading in the previous N calendar days
 * (local time zone, today excluded). Using the minimum is the conservative choice.
 */
export function evaluateWeight(w: Reading, history: Reading[], sy: Symptom[], t: Thresholds, tz: string): Alert[] {
  const today = localDate(w.measuredAt, tz);
  const prior = history
    .filter((h) => h.type === "weight")
    .map((h) => ({ kg: h.value, ago: dayDiff(today, localDate(h.measuredAt, tz)) }))
    .filter((h) => h.ago >= 1);
  const within = (days: number) => prior.filter((h) => h.ago <= days).map((h) => h.kg);
  const out: Alert[] = [];

  for (const rule of t.weight.gainTier2) {
    const ws = within(rule.days);
    if (!ws.length) continue;
    const gain = +(w.value - Math.min(...ws)).toFixed(2);
    if (gain > rule.kg)
      out.push(alert(2, `WEIGHT_GAIN_${rule.days}D`, `Weight ${w.value} kg: +${gain} kg in ${rule.days} day(s) (> ${rule.kg})`, rule.source));
  }

  // Sustained smaller gain: gain over the previous window, on each of the last N days in a row.
  const sg = t.weight.sustainedGainTier2;
  const daily = new Map<number, number>([[0, w.value]]); // days ago -> latest weight that day
  for (const h of [...history].filter((h) => h.type === "weight").sort((a, b) => Date.parse(a.measuredAt) - Date.parse(b.measuredAt))) {
    const ago = dayDiff(today, localDate(h.measuredAt, tz));
    if (ago >= 1) daily.set(ago, h.value);
  }
  const gainOn = (ago: number): number | null => {
    const kg = daily.get(ago);
    const prior = [...daily].filter(([d]) => d > ago && d <= ago + sg.windowDays).map(([, v]) => v);
    return kg === undefined || !prior.length ? null : +(kg - Math.min(...prior)).toFixed(2);
  };
  const gains = Array.from({ length: sg.consecutiveDays }, (_, i) => gainOn(i));
  if (gains.every((g) => g !== null && g > sg.kg) && !out.length)
    out.push(alert(2, "WEIGHT_GAIN_SUSTAINED", `Weight ${w.value} kg: > ${sg.kg} kg above the ${sg.windowDays}-day low on ${sg.consecutiveDays} days in a row`, "SIGN beta-blocker annex [S8 Annex 4]"));

  const loss = t.weight.lossWithDizzinessTier2;
  const wl = within(loss.days);
  if (wl.length && present(sy, "dizziness")) {
    const lost = +(Math.max(...wl) - w.value).toFixed(2);
    if (lost > loss.kg)
      out.push(alert(2, "WEIGHT_LOSS_DIZZY", `Weight ${w.value} kg: -${lost} kg in ${loss.days} days with dizziness`, "HFA [S7], PLACEHOLDER"));
  }
  return out;
}

export function evaluateReadings(input: RuleInput): Alert[] {
  const { readings, weightHistory, thresholds: t, timeZone } = input;
  const sy = [...input.symptoms, ...(input.contextSymptoms ?? [])];
  const out: Alert[] = [];
  const push = (a: Alert | null) => a && out.push(a);
  for (const r of readings) {
    switch (r.type) {
      case "spo2": push(evaluateSpo2(r.value, sy, t)); break;
      case "pulse": push(evaluatePulse(r.value, sy, t)); break;
      case "bp":
        push(evaluateBp(r.value, r.value2, sy, t));
        if (r.value3 !== null) push(evaluatePulse(r.value3, sy, t));
        break;
      case "weight": out.push(...evaluateWeight(r, weightHistory, sy, t, timeZone)); break;
      default: push(evaluateLab(r, t));
    }
  }
  return out;
}

/** All rules. Deduplicated by code, keeping the highest-priority (lowest tier number) instance. */
export function evaluate(input: RuleInput): Alert[] {
  const all = [...evaluateSymptoms(input.symptoms, input.thresholds), ...evaluateReadings(input)];
  const byCode = new Map<string, Alert>();
  for (const a of all) {
    const prev = byCode.get(a.code);
    if (!prev || a.tier < prev.tier) byCode.set(a.code, a);
  }
  return [...byCode.values()].sort((a, b) => a.tier - b.tier);
}

export function highestTier(alerts: Alert[]): Alert["tier"] | null {
  return alerts.length ? (Math.min(...alerts.map((a) => a.tier)) as Alert["tier"]) : null;
}
