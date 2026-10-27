// LlmAdapter contract for extraction (split plan section 8: no provider name in the core). Implementations live in
// adapters/llm/ (claude-cli; a fake for tests and offline dev in app/src/dev/fake-extractor.ts).
import type { Media } from "../types.js";

export interface ExtractInput {
  text?: string; // message text, caption or transcript
  media?: Media; // image or PDF
  now: string;
  /** Text of the message this one replies to (e.g. a digest question), for context only. */
  replyTo?: string;
}

/** Raw (unvalidated) model JSON per input, in input order; an Error for an input that could not be extracted. */
export interface Extractor {
  /** Recorded as extracted_by on every row this adapter produced. */
  readonly model?: string;
  extract(inputs: ExtractInput[]): Promise<(unknown | Error)[]>;
}

/** Adapter for one-message-at-a-time extractors (tests, offline dev). */
export function oneByOne(f: (input: ExtractInput) => Promise<unknown>, model?: string): Extractor {
  return { model, extract: (inputs) => Promise.all(inputs.map((i) => f(i).catch((e: Error) => e))) };
}

/** The model declined, gave no structured output or the input is unusable: retrying the same input will not help. */
export class ExtractorStopError extends Error {
  override name = "ExtractorStopError";
  constructor(readonly stopReason: string) {
    super(`extractor stopped: ${stopReason}`);
  }
}

/** Extractor alias used by the split plan. */
export type LlmAdapter = Extractor;

export const DEFAULT_CONTEXT = "Senders are family members. Each message is recorded for its sender.";

/** The extraction system prompt. `context` (who the senders are) comes from the records repo
 *  (meta/extraction-context.md); the product default names nobody. */
export function systemPrompt(context?: string | null): string {
  return `You extract health readings and symptoms for a home health log.
${(context ?? "").trim() || DEFAULT_CONTEXT}
Messages are Hindi, Hinglish or English (Devanagari or Roman script).
You get one or more numbered messages. Return exactly one result per message, with msg = its number. Messages are independent.
Rules:
- Never invent values. If a number is not clearly visible or said, omit the reading. Unknown fields are null.
- BP monitor photos: value = SYS, value2 = DIA, value3 = PUL. Read labels; do not swap SYS and DIA.
- Oximeter: SpO2 -> type spo2, PR/pulse -> separate type pulse reading.
- Lab reports: only potassium (mmol/L), sodium (mmol/L), creatinine (mg/dL; convert from umol/L by dividing by 88.4).
- Blood sugar / glucometer (sugar, shugar, khoon mein cheeni), mg/dL: khali pet / fasting -> glucose_fasting; khane ke baad / PP -> glucose_pp; otherwise glucose_random.
- Classify every photo/PDF FIRST (media_kind), then extract:
  device_reading (BP monitor, oximeter, scale, glucometer), prescription, medicine (strip, box, bottle),
  report (lab report, scan, discharge summary), other (other health content: wound, rash, swelling, hospital paper),
  non_health (screenshot, forwarded meme, greeting, scenery, food, people, anything not about health); none if there is no image/PDF.
  non_health: return no readings, no symptoms and unreadable_reason null; do not try to read it.
  Medicine strips and prescriptions have no readings: return empty readings, not unreadable_reason.
  Set unreadable_reason only when the image IS health content (not non_health) but its values cannot be read.
- Symptoms: one record per location/side/character cluster. Handle negation: "seene mein dard nahi" means absent, so emit nothing.
- severity only if a 0-10 number was said. at_rest true only if explicitly at rest/lying/sitting.
- onset_at: when it started, only if said ("kal raat 2 baje", "subah 6 baje", "aadha ghanta pehle"), resolved against the message time, as local time (no offset). Else null.
- duration_min: how long it lasted ("10 minute tak", "aadha ghanta" = 30). triggers: what brought it on (chalte hue -> walking, seedhi -> stairs, kaam karte -> exertion, khane ke baad -> after_meal, gussa/tension -> emotion).
- Map: behosh / aankhon ke aage andhera -> syncope; dil tez dhadakna -> palpitations; seene mein dard/dabav -> chest_pain;
  saans phoolna -> breathlessness; lete hue saans -> orthopnea; chakkar -> dizziness; sujan -> swelling; ulti/dast -> vomiting_diarrhoea.
- subject_hint: only when the message is clearly about someone other than the sender ("Maa ka BP 120/80", "Papa ko chakkar aaya"):
  who it is about, as written ("Maa"). Else null. Still extract the values; a human decides whose they are.
- Never diagnose, never advise. If a health image is unreadable, set unreadable_reason.`;
}

export const SYSTEM = systemPrompt();
