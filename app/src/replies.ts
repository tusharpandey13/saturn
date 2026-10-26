// Fixed Hindi labels for the daily digest. Values shown to the family are never LLM-generated text:
// they are rendered from the stored records.

import type { Reading, Symptom, SymptomType } from "./types.js";

const SYMPTOM_HI: Partial<Record<SymptomType, string>> = {
  chest_pain: "सीने में दर्द/दबाव",
  breathlessness: "साँस फूलना",
  orthopnea: "लेटने पर साँस फूलना",
  syncope: "बेहोशी",
  palpitations: "धड़कन तेज़",
  dizziness: "चक्कर",
  swelling: "सूजन",
  stroke_signs: "लकवे जैसे लक्षण",
  angioedema: "होंठ/जीभ/गले में सूजन",
  confusion: "भ्रम/ज़्यादा नींद",
  vomiting_diarrhoea: "उल्टी/दस्त",
  pain: "दर्द",
  numbness: "सुन्नपन",
  tingling: "झुनझुनी",
  weakness: "कमज़ोरी",
  clumsiness: "हाथ से काम में दिक्कत",
  imbalance: "संतुलन में दिक्कत",
  fall: "गिरना",
  fatigue: "थकान",
  cough: "खाँसी",
  urinary: "पेशाब की तकलीफ़",
};

export function readingHi(r: Reading): string {
  switch (r.type) {
    case "bp": return `BP ${r.value}/${r.value2}${r.value3 !== null ? `, पल्स ${r.value3}` : ""}`;
    case "weight": return `वज़न ${r.value} kg`;
    case "pulse": return `पल्स ${r.value}`;
    case "spo2": return `SpO2 ${r.value}%`;
    case "potassium": return `पोटैशियम ${r.value} mmol/L`;
    case "sodium": return `सोडियम ${r.value} mmol/L`;
    case "creatinine": return `क्रिएटिनिन ${r.value} mg/dL`;
    case "glucose_fasting": return `शुगर (खाली पेट) ${r.value} mg/dL`;
    case "glucose_pp": return `शुगर (खाने के बाद) ${r.value} mg/dL`;
    case "glucose_random": return `शुगर ${r.value} mg/dL`;
  }
}

export function symptomHi(s: Symptom): string {
  const parts = [SYMPTOM_HI[s.symptomType] ?? s.freeText ?? "लक्षण"];
  if (s.location) parts.push(`(${s.location}${s.side !== "unknown" ? `, ${s.side}` : ""})`);
  if (s.severity !== null) parts.push(`${s.severity}/10`);
  if (s.durationMin !== null) parts.push(`${s.durationMin} मिनट`);
  if (s.atRest) parts.push("आराम में");
  return parts.join(" ");
}
