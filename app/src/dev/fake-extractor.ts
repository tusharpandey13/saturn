// Offline extractor for tests: tiny regex parser, no LLM.
// Understands e.g. "bp 128/82 pulse 76", "wajan 62.5", "spo2 95", plus a few Hindi symptom keywords.
import { type ExtractInput, type Extractor, oneByOne } from "../extract/adapter.js";

const SYMPTOMS: [RegExp, string, Record<string, unknown>?][] = [
  [/seene|chest/i, "chest_pain"],
  [/behosh|faint/i, "syncope"],
  [/saans|breath/i, "breathlessness"],
  [/chakkar|dizz/i, "dizziness"],
  [/sujan|swell/i, "swelling", { location: "ankle" }],
];

export class FakeExtractor implements Extractor {
  extract(inputs: ExtractInput[]): Promise<unknown[]> {
    return oneByOne((i) => this.one(i)).extract(inputs);
  }

  async one({ text = "" }: ExtractInput): Promise<unknown> {
    const readings: unknown[] = [];
    const num = (re: RegExp) => text.match(re)?.slice(1).map(Number);
    const bp = num(/bp\s*(\d{2,3})\s*\/\s*(\d{2,3})/i);
    const pulse = num(/(?:pulse|pals)\s*(\d{2,3})/i);
    if (bp) readings.push({ type: "bp", value: bp[0], value2: bp[1], value3: pulse?.[0] ?? null, unit: "mmHg", measured_at: null });
    else if (pulse) readings.push({ type: "pulse", value: pulse[0], value2: null, value3: null, unit: "bpm", measured_at: null });
    const w = num(/(?:wajan|weight|vajan)\s*(\d{2,3}(?:\.\d)?)/i);
    if (w) readings.push({ type: "weight", value: w[0], value2: null, value3: null, unit: "kg", measured_at: null });
    const o = num(/spo2\s*(\d{2,3})/i);
    if (o) readings.push({ type: "spo2", value: o[0], value2: null, value3: null, unit: "%", measured_at: null });
    const g = num(/(?:sugar|shugar|शुगर)\s*(\d{2,3})/i);
    if (g) {
      const type = /khali pet|fasting|खाली पेट/i.test(text) ? "glucose_fasting" : /khane ke baad|pp\b|खाने के बाद/i.test(text) ? "glucose_pp" : "glucose_random";
      readings.push({ type, value: g[0], value2: null, value3: null, unit: "mg/dL", measured_at: null });
    }
    const negated = /nahi|nahin|no\b/i.test(text);
    const symptoms = negated
      ? []
      : SYMPTOMS.filter(([re]) => re.test(text)).map(([, type, extra]) => ({
          symptom_type: type, location: null, side: "unknown", character: [], severity: null,
          duration_min: num(/(\d+)\s*min/i)?.[0] ?? null, at_rest: /aaram|rest|lete/i.test(text) || null,
          associated: [], triggers: /chalte|walk/i.test(text) ? ["walking"] : [], onset_at: null, free_text: text, ...extra,
        }));
    return { readings, symptoms, media_kind: "none", confidence: 0.9, unreadable_reason: readings.length || symptoms.length ? null : "nothing found" };
  }
}
