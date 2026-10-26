// Deterministic (non-LLM) parser for fixed vitals formats. Used twice (ADR 005):
// - by the Worker, to echo what it read at once ("BP 120/80, pulse 72 ✓") so the parents can catch typos;
// - by the daily batch: a message that is ONLY vitals (complete) is recorded from this parse, without an LLM call,
//   so the stored values are exactly the ones the parents saw echoed.
// It gives no advice and makes no safety judgement. A value outside the plausible range is echoed with "?" (typo check).
//
// Understood (Roman or Devanagari, any case, Devanagari digits too):
//   "120/80 72"  "BP 120/80 pulse 72"  "bp 120-80, 72"  "बीपी 120/80 पल्स 72"  "BP 120 by 80"
//   "wajan 62.5" "weight 62 kg" "वज़न 62"   "spo2 96" "oxygen 96%"   "pulse 72" "pals 72"
//   "sugar 110 khali pet" "sugar 160 khane ke baad" "शुगर 110"
// Unlabelled numbers ("120/80 72") are read as BP only when the whole message is vitals.

import { PLAUSIBLE } from "./extract/schema.js";
import type { Reading, ReadingType } from "./types.js";

export interface VitalsParse {
  readings: Reading[];
  /** The whole message was vitals (plus filler words): the batch may record it without the LLM. */
  complete: boolean;
  /** Every reading is inside the plausible range. */
  plausible: boolean;
}

const DEVANAGARI_DIGITS = "०१२३४५६७८९";
const N = String.raw`(\d{2,3}(?:\.\d)?)`;
const SEP = String.raw`\s*(?:[:=\-–]\s*)?`;

const BP_LABEL = String.raw`(?:b\.?\s?p\.?|बीपी|बी\.पी\.|blood pressure)`;
const BP_PAIR = String.raw`(\d{2,3})\s*(?:/|\\|-|by|बटा|ऊपर)\s*(\d{2,3})`;
const PULSE_LABEL = String.raw`(?:pulse|pals|puls|pul|pr|hr|heart rate|पल्स|नब्ज़|नब्ज|नाड़ी)`;
const WEIGHT_LABEL = String.raw`(?:wajan|wazan|vajan|vazan|weight|wt|वज़न|वजन)`;
const SPO2_LABEL = String.raw`(?:spo2|sp02|spo|oxygen|o2|ऑक्सीजन|आक्सीजन)`;
const SUGAR_LABEL = String.raw`(?:sugar|shugar|glucose|शुगर|सुगर)`;
const FASTING = /\b(?:khali pet|khaali pet|fasting|fbs)\b|खाली पेट/;
const AFTER_MEAL = /\b(?:khane ke baad|khana khane ke baad|after food|after meal|pp|ppbs)\b|खाने के बाद/;
// Words that may surround vitals without making the message "more than vitals".
// FILLER keeps "/" and "-" (BP separators); ALL_FILLER also drops them for the final "anything left?" test.
const FILLER = /\b(?:aaj|aj|abhi|subah|sube|shaam|sham|raat|dopahar|ka|ki|ke|hai|tha|thi|he|h|ji|mera|meri|mummy|papa|aur|and|today|morning|evening|night|reading|kg|kgs|kilo|mg\/dl|mg|dl|bpm|mmhg)\b|आज|अभी|सुबह|शाम|रात|का|की|के|है|था|थी|और|किलो|[,.;:!।()–+%✓]/g;
const ALL_FILLER = new RegExp(`${FILLER.source}|[/\\\\-]`, "g");

const PLAUSIBLE_DIA: [number, number] = [30, 150];

function normalise(text: string): string {
  return text
    .replace(/[०-९]/g, (d) => String(DEVANAGARI_DIGITS.indexOf(d)))
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function parseVitals(text: string | undefined, measuredAt: string): VitalsParse {
  if (!text) return { readings: [], complete: false, plausible: true };
  let rest = normalise(text);
  const readings: Reading[] = [];
  const take = (re: RegExp, f: (m: RegExpExecArray) => void) => {
    const g = new RegExp(re.source, "g");
    rest = rest.replace(g, (...args) => {
      f(args.slice(0, -2) as unknown as RegExpExecArray);
      return " ";
    });
  };
  const add = (type: ReadingType, value: number, unit: string, value2: number | null = null, value3: number | null = null) =>
    readings.push({ type, value, value2, value3, unit, measuredAt });

  const bpWithPulse = (m: RegExpExecArray) => add("bp", +m[1], "mmHg", +m[2], m[3] ? +m[3] : null);
  // Labelled BP anywhere, optionally followed by a pulse (labelled or a bare third number).
  take(new RegExp(`${BP_LABEL}${SEP}${BP_PAIR}(?:\\s*,?\\s*(?:${PULSE_LABEL}${SEP})?(\\d{2,3})(?![\\d/]))?`), bpWithPulse);
  take(new RegExp(`${WEIGHT_LABEL}${SEP}${N}`), (m) => add("weight", +m[1], "kg"));
  take(new RegExp(`${SPO2_LABEL}${SEP}(\\d{2,3})`), (m) => add("spo2", +m[1], "%"));
  take(new RegExp(`${SUGAR_LABEL}${SEP}(\\d{2,3})`), (m) => {
    const type = FASTING.test(rest) ? "glucose_fasting" : AFTER_MEAL.test(rest) ? "glucose_pp" : "glucose_random";
    add(type, +m[1], "mg/dL");
  });
  if (readings.some((r) => r.type.startsWith("glucose"))) {
    rest = rest.replace(new RegExp(FASTING.source, "g"), " ").replace(new RegExp(AFTER_MEAL.source, "g"), " ");
  }
  take(new RegExp(`${PULSE_LABEL}${SEP}(\\d{2,3})`), (m) => add("pulse", +m[1], "bpm"));

  // Unlabelled "120/80 72": BP only if nothing else is left in the message.
  const bare = new RegExp(`^\\s*${BP_PAIR}(?:\\s*,?\\s*(\\d{2,3}))?\\s*$`);
  const leftover = rest.replace(FILLER, " ").trim();
  const m = bare.exec(leftover);
  if (m) {
    bpWithPulse(m as RegExpExecArray);
    rest = "";
  }

  const complete = readings.length > 0 && rest.replace(ALL_FILLER, " ").trim() === "";
  return { readings, complete, plausible: readings.every(isPlausible) };
}

export function isPlausible(r: Reading): boolean {
  const [lo, hi] = PLAUSIBLE[r.type];
  if (r.value < lo || r.value > hi) return false;
  if (r.type !== "bp") return true;
  if (r.value2 === null || r.value2 < PLAUSIBLE_DIA[0] || r.value2 > PLAUSIBLE_DIA[1] || r.value <= r.value2) return false;
  return r.value3 === null || (r.value3 >= PLAUSIBLE.pulse[0] && r.value3 <= PLAUSIBLE.pulse[1]);
}

const LABEL: Record<ReadingType, (r: Reading) => string> = {
  bp: (r) => `BP ${r.value}/${r.value2}${r.value3 !== null ? `, pulse ${r.value3}` : ""}`,
  pulse: (r) => `pulse ${r.value}`,
  weight: (r) => `weight ${r.value} kg`,
  spo2: (r) => `SpO2 ${r.value}%`,
  glucose_fasting: (r) => `sugar (fasting) ${r.value}`,
  glucose_pp: (r) => `sugar (after food) ${r.value}`,
  glucose_random: (r) => `sugar ${r.value}`,
  potassium: (r) => `potassium ${r.value}`,
  sodium: (r) => `sodium ${r.value}`,
  creatinine: (r) => `creatinine ${r.value}`,
};

/** "BP 120/80, pulse 72 ✓". Implausible values get "?" so a typo is noticed. */
export function vitalsEcho(readings: Reading[]): string {
  return readings.map((r) => `${LABEL[r.type](r)} ${isPlausible(r) ? "✓" : "?"}`).join(" · ");
}
