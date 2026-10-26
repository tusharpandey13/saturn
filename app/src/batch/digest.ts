// Daily digest to the family group (ADR 005). Also the heartbeat: a day without a digest means the batch broke.
// Values are rendered from the stored records with fixed templates (src/replies.ts), never LLM text.
// Red-flag rules appear only as annotations, explicitly unverified (thresholds pending clinician sign-off).

import { PRODUCT_NAME } from "../product.js";
import { readingHi, symptomHi } from "../replies.js";
import type { Alert, Reading, Symptom } from "../types.js";

export interface DigestEntry {
  person: string;
  ts: string;
  kind: string;
  /** Start of the message text, so the family can tell which message a question is about. */
  snippet: string;
  readings: Reading[];
  symptoms: Symptom[];
  questions: string[];
  annotations: Alert[];
  /** Why the entry was queued for the offline deep read (document, prescription, ...), if it was. */
  deep: string | null;
  /** Fixed status lines shown under the person (e.g. STT_PENDING_NOTE). */
  notes?: string[];
}

export const STT_PENDING_NOTE = "🎤 voice note saved; transcription pending";
export const DELAYED_LINE = (n: number) => `⚠ extraction delayed: ${n} संदेश सुरक्षित हैं, अगले रन में अपने-आप प्रोसेस होंगे।`;

export const ANNOTATION_NOTE = "unverified; doctor sign-off pending";

const DEEP_HI: Record<string, string> = {
  document: "दस्तावेज़", prescription: "पर्चा", report: "रिपोर्ट", medicine: "दवा की फ़ोटो",
};

export function buildDigest(o: {
  entries: DigestEntry[];
  /** Not processed yet (media not copied, or delayed); retried next run. */
  pending: number;
  /** Of pending: the extraction or STT service failed (auth, usage limit, outage). */
  delayed?: number;
  /** Operator warnings (e.g. the Claude token expiry), one ⚠ line each. */
  warnings?: string[];
  now: string;
  timeZone: string;
  thresholdsStatus: string;
}): string {
  const day = new Intl.DateTimeFormat("en-IN", { timeZone: o.timeZone, day: "numeric", month: "short" }).format(new Date(o.now));
  const time = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: o.timeZone, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  const out: string[] = [`📋 ${PRODUCT_NAME} सारांश — ${day}`];
  o = { ...o, entries: [...o.entries].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)) };

  const recorded = o.entries.filter((e) => e.readings.length || e.symptoms.length || e.notes?.length);
  if (!recorded.length && !o.entries.length) out.push("आज कोई नया संदेश दर्ज नहीं हुआ।");
  const people = [...new Set(recorded.map((e) => e.person))];
  for (const p of people) {
    out.push("", `👤 ${p}`);
    for (const e of recorded.filter((x) => x.person === p))
      for (const l of [...e.readings.map(readingHi), ...e.symptoms.map(symptomHi), ...(e.notes ?? [])]) out.push(`• ${time(e.ts)} ${l}`);
  }

  const deep = o.entries.filter((e) => e.deep && DEEP_HI[e.deep]);
  if (deep.length) out.push("", `📄 ध्यान से पढ़ने के लिए रखे गए: ${deep.map((e) => `${e.person} ${time(e.ts)} ${DEEP_HI[e.deep!]}`).join(", ")}`);

  const questions = o.entries.flatMap((e) => e.questions.map((q) => `${e.person} ${time(e.ts)}${e.snippet ? ` "${e.snippet}"` : ` (${kindHi(e.kind)})`}: ${q}`));
  if (questions.length) {
    out.push("", "❓ कृपया बताएँ (इसी संदेश का जवाब दें):");
    questions.forEach((q, i) => out.push(`${i + 1}. ${q}`));
  }

  const flagged = o.entries.filter((e) => e.annotations.length);
  if (flagged.length) {
    out.push("", `⚠ Rule annotations (${ANNOTATION_NOTE}; thresholds: ${o.thresholdsStatus}). Not advice; call the doctor if worried:`);
    for (const e of flagged) for (const a of e.annotations) out.push(`- ${e.person} ${time(e.ts)}: T${a.tier} ${a.code}: ${a.detail}`);
  }

  const delayed = o.delayed ?? 0;
  if (delayed) out.push("", DELAYED_LINE(delayed));
  if (o.pending > delayed) out.push("", `⏳ ${o.pending - delayed} संदेश अभी प्रोसेस नहीं हुए (फ़ाइल अभी कॉपी नहीं हुई); कल फिर कोशिश होगी।`);
  for (const w of o.warnings ?? []) out.push("", `⚠ ${w}`);
  return out.join("\n");
}

const kindHi = (k: string) => ({ audio: "आवाज़", image: "फ़ोटो", document: "दस्तावेज़", text: "संदेश" })[k] ?? k;
