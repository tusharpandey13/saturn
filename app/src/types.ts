// Core domain types. Channel-agnostic.

export type MessageKind = "text" | "audio" | "image" | "document";

export interface Media {
  data: Uint8Array;
  mimeType: string;
}

export interface MediaStore {
  get(ref: string): Promise<Media>;
}

export interface Transcript {
  text: string;
  /** BCP-47, e.g. hi-IN, when the provider reports it. */
  languageCode?: string | null;
  /** 0-1 language-detection confidence, when reported. */
  languageProbability?: number | null;
}

export interface SpeechToText {
  /** Synchronous transcription for short clips (Sarvam REST: < 30 s). */
  transcribe(audio: Media): Promise<Transcript>;
  /** Long clips: start an async batch job; returns a job id to poll. */
  startBatch(audio: Media): Promise<string>;
  /** null while the job is still running; throws if the job failed. */
  pollBatch(jobId: string): Promise<Transcript | null>;
}

export type ReadingType =
  | "weight" | "bp" | "pulse" | "spo2" | "potassium" | "sodium" | "creatinine"
  | "glucose_fasting" | "glucose_pp" | "glucose_random"; // home glucometer, mg/dL

export interface Reading {
  type: ReadingType;
  /** weight kg | systolic mmHg | bpm | % | mmol/L | mg/dL (creatinine, glucose) */
  value: number;
  /** diastolic for bp */
  value2: number | null;
  /** pulse displayed on a BP monitor */
  value3: number | null;
  unit: string;
  measuredAt: string;
  /** Original value/unit when converted (e.g. 140 lb -> 63.5 kg). */
  sourceValue?: number;
  sourceUnit?: string;
  /** Device screen type, set only when not a plain single reading: a stored average or memory recall, or "unknown"
   *  when the model saw an indicator but could not tell (never set for unknown without an indicator). */
  kind?: ReadingKind;
  /** The memory/average indicator text or icon seen on the screen ("AVG AM", "M 3/30"), as written. */
  indicator?: string;
  /** Count/window of an average or memory recall, if printed ("3 readings", "7 days"). */
  window?: string;
  /** BP components read with low confidence. */
  uncertain?: BpComponent[];
  /** BP components that could not be read: component -> reason. Their values are null, never filled in. */
  missing?: Partial<Record<BpComponent, string>>;
}

export const READING_KINDS = ["single", "average", "memory-recall", "unknown"] as const;
export type ReadingKind = (typeof READING_KINDS)[number];
export const BP_COMPONENTS = ["systolic", "diastolic", "pulse", "time"] as const;
export type BpComponent = (typeof BP_COMPONENTS)[number];
/** A BP screen with systolic or diastolic illegible (e.g. cropped): the legible parts only, stored tagged uncertain
 *  with a needs-human row for the missing part. Not a Reading: no rules, no daily series. */
export type PartialReading = Omit<Reading, "value" | "value2"> & { type: "bp"; value: number | null; value2: number | null; missing: Partial<Record<BpComponent, string>> };

export const SYMPTOM_TYPES = [
  "chest_pain",
  "breathlessness",
  "orthopnea",
  "syncope",
  "palpitations",
  "dizziness",
  "swelling",
  "stroke_signs",
  "angioedema",
  "confusion",
  "vomiting_diarrhoea",
  "pain",
  "numbness",
  "tingling",
  "weakness",
  "clumsiness",
  "imbalance",
  "fall",
  "fatigue",
  "cough",
  "urinary",
  "other",
] as const;
export type SymptomType = (typeof SYMPTOM_TYPES)[number];

export const SIDES = ["left", "right", "both", "midline", "unknown"] as const;
export type Side = (typeof SIDES)[number];

export interface Symptom {
  symptomType: SymptomType;
  location: string | null;
  side: Side;
  character: string[];
  severity: number | null; // 0-10 NRS, null if not said
  durationMin: number | null;
  atRest: boolean | null;
  associated: string[];
  /** What brought it on (symptom-log-schema.md triggers: exertion, walking, stairs, after_meal, ...). */
  triggers: string[];
  freeText: string;
  /** Reported onset time when one was said, else the message time. */
  observedAt: string;
}

/** What a photo/PDF shows; the extractor classifies every photo FIRST (ADR 011). "other" = other health content;
 *  "non_health" = screenshots, scenery, greetings, ...: recorded as a source with no facts and no question. */
export const MEDIA_KINDS = ["device_reading", "prescription", "medicine", "report", "other", "non_health"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];
/** Health classes: unreadable health content is the only media that gets a clarification question (to the admin). */
export const HEALTH_MEDIA_KINDS: readonly MediaKind[] = ["device_reading", "prescription", "medicine", "report", "other"];
/** The class recorded on the message (d1.messages image_class -> KB source note/tag). */
export const IMAGE_CLASS: Record<MediaKind, string> = {
  device_reading: "device-reading", prescription: "prescription", medicine: "medicine-strip", report: "lab-report",
  other: "other-health", non_health: "non-health",
};

/** Everyone is a member: each member's messages are recorded, acked and extracted into their own namespace.
 *  admin = a member plus the only output channel (ADR 011): the digest, questions and ops alerts by private DM. */
export const ROLES = ["member", "admin"] as const;
export type Role = (typeof ROLES)[number];

export interface Person {
  id: string;
  name: string;
  role: Role;
  senderId: string;
}

export type Tier = 1 | 2 | 3;

export interface Alert {
  tier: Tier;
  code: string;
  /** Human-readable reason: reading + rule. English, for the digest annotation. */
  detail: string;
  /** Where the threshold comes from (source ids from the records' thresholds reference). */
  source: string;
}
