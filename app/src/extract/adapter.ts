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

export const DEFAULT_CONTEXT = "Senders are patients or their caregivers.";

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
- media_kind: device_reading (BP monitor, oximeter, scale, glucometer), medicine (strip, box, bottle), prescription, report (lab, scan, discharge), other; none if there is no image/PDF.
  Medicine strips and prescriptions have no readings: return empty readings, not unreadable_reason.
- Symptoms: one record per location/side/character cluster. Handle negation: "seene mein dard nahi" means absent, so emit nothing.
- severity only if a 0-10 number was said. at_rest true only if explicitly at rest/lying/sitting.
- onset_at: when it started, only if said ("kal raat 2 baje", "subah 6 baje", "aadha ghanta pehle"), resolved against the message time, as local time (no offset). Else null.
- duration_min: how long it lasted ("10 minute tak", "aadha ghanta" = 30). triggers: what brought it on (chalte hue -> walking, seedhi -> stairs, kaam karte -> exertion, khane ke baad -> after_meal, gussa/tension -> emotion).
- Map: behosh / aankhon ke aage andhera -> syncope; dil tez dhadakna -> palpitations; seene mein dard/dabav -> chest_pain;
  saans phoolna -> breathlessness; lete hue saans -> orthopnea; chakkar -> dizziness; sujan -> swelling; ulti/dast -> vomiting_diarrhoea.
- Never diagnose, never advise. If the image is unreadable, set unreadable_reason.`;
}

export const SYSTEM = systemPrompt();
