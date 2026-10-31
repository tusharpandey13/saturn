// LlmAdapter contract for extraction (split plan section 8: no provider name in the core). Implementations live in
// adapters/llm/ (claude-cli; a fake for tests and offline dev in app/src/dev/fake-extractor.ts).
import type { Media } from "../types.js";
import { CONTEXT_RULES } from "./context.js";

export interface ExtractInput {
  text?: string; // message text, caption or transcript
  media?: Media; // image or PDF
  now: string;
  /** Text of the message this one replies to (e.g. a digest question), for context only. */
  replyTo?: string;
  /** Read this message for life-context signals too (ADR 010 pre-filter passed). Header `context: yes|no`. */
  context?: boolean;
}

/** Raw (unvalidated) model JSON per input, in input order; an Error for an input that could not be extracted. */
export interface Extractor {
  /** Recorded as extracted_by on every row this adapter produced. */
  readonly model?: string;
  /** The model that reads this input, when it depends on the input (text vs photo/PDF); else `model`. */
  modelFor?(input: ExtractInput): string;
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
- Reports (lab report, imaging/scan report such as MRI/CT/X-ray/USG/echo, discharge summary), as PDF or photo: fill \`report\`, readings stays [].
  Read EVERY page to the end. report.items: EVERY printed result, none skipped, in page order: name exactly as printed,
  value as printed (value_num for a number, value_text for text such as Negative or "<0.5"), unit as printed, the printed
  reference range verbatim (ref_range), flag only if printed or the value is marked high/low/bold (H, L, N), panel heading.
  Do not convert units. Do not compute flags. sample_at = sample COLLECTION / registration date-time as printed (not the
  report, print or authorisation time; those go in reported_at). facility and doctors (referring, reporting, signing;
  with role/degree as printed). Imaging and narrative reports: findings and impression copied verbatim, complete.
  A report with no printed values still gets report_type, dates, facility, doctors, findings and impression.
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
${CONTEXT_RULES}
- report is null unless media_kind is report.
- Never diagnose, never advise. If a health image is unreadable, set unreadable_reason.`;
}

export const SYSTEM = systemPrompt();
