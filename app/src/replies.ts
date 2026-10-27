// Fixed English labels for the admin digest (ADR 011: the bot writes only to admins, in plain English; Hindi input is
// still understood). Values shown are never LLM-generated text: they are rendered from the stored records.

import type { Reading, Symptom, SymptomType } from "./types.js";

const SYMPTOM_EN: Partial<Record<SymptomType, string>> = {
  chest_pain: "chest pain/pressure",
  breathlessness: "breathlessness",
  orthopnea: "breathless lying down",
  syncope: "fainting",
  palpitations: "palpitations",
  dizziness: "dizziness",
  swelling: "swelling",
  stroke_signs: "stroke-like signs",
  angioedema: "lip/tongue/throat swelling",
  confusion: "confusion/drowsiness",
  vomiting_diarrhoea: "vomiting/diarrhoea",
  pain: "pain",
  numbness: "numbness",
  tingling: "tingling",
  weakness: "weakness",
  clumsiness: "clumsiness",
  imbalance: "imbalance",
  fall: "fall",
  fatigue: "fatigue",
  cough: "cough",
  urinary: "urinary trouble",
};

export function readingEn(r: Reading): string {
  switch (r.type) {
    case "bp": return `BP ${r.value}/${r.value2}${r.value3 !== null ? `, pulse ${r.value3}` : ""}`;
    case "weight": return `weight ${r.value} kg`;
    case "pulse": return `pulse ${r.value}`;
    case "spo2": return `SpO2 ${r.value}%`;
    case "potassium": return `potassium ${r.value} mmol/L`;
    case "sodium": return `sodium ${r.value} mmol/L`;
    case "creatinine": return `creatinine ${r.value} mg/dL`;
    case "glucose_fasting": return `sugar (fasting) ${r.value} mg/dL`;
    case "glucose_pp": return `sugar (after food) ${r.value} mg/dL`;
    case "glucose_random": return `sugar ${r.value} mg/dL`;
  }
}

export function symptomEn(s: Symptom): string {
  const parts = [SYMPTOM_EN[s.symptomType] ?? s.freeText ?? "symptom"];
  if (s.location) parts.push(`(${s.location}${s.side !== "unknown" ? `, ${s.side}` : ""})`);
  if (s.severity !== null) parts.push(`${s.severity}/10`);
  if (s.durationMin !== null) parts.push(`${s.durationMin} min`);
  if (s.atRest) parts.push("at rest");
  return parts.join(" ");
}
