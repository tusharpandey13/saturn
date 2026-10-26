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
}

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

/** What a photo/PDF shows, so non-reading media (medicine strips, prescriptions, reports) is acknowledged, not "retake". */
export const MEDIA_KINDS = ["device_reading", "medicine", "prescription", "report", "other"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export interface Person {
  id: string;
  name: string;
  /** caregiver = observer (e.g. a family member who helps): messages are kept raw, never acked or extracted as patient data. */
  role: "patient" | "caregiver";
  senderId: string;
}

export type Tier = 1 | 2 | 3;

export interface Alert {
  tier: Tier;
  code: string;
  /** Human-readable reason: reading + rule. English, for the digest annotation. */
  detail: string;
  /** Where the threshold comes from (hf-red-flags.md source ids). */
  source: string;
}
