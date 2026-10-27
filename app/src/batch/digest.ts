// Daily digest (ADR 005, ADR 011): sent ONLY to the admins by private DM, in plain English. The group is input-only;
// the bot never posts there. Also the heartbeat: a day without a digest DM means the batch broke.
// Values are rendered from the stored records with fixed templates (src/replies.ts), never LLM text.
// No ops noise here: delays, failures and operator warnings go in a separate short admin DM (finish, ops lines).
// Red-flag rules appear only as annotations, explicitly unverified, with the thresholds status.

import { PRODUCT_NAME } from "../product.js";
import { readingEn, symptomEn } from "../replies.js";
import type { Alert, Reading, Symptom } from "../types.js";

export interface DigestEntry {
  /** Message key; the later entry for a key replaces an earlier one (a voice note transcribed after being pending). */
  key?: string;
  person: string;
  ts: string;
  kind: string;
  /** Start of the message text, so the admin can tell which message a question is about. */
  snippet: string;
  readings: Reading[];
  symptoms: Symptom[];
  /** Clarification questions for the admin (answered by replying to the digest DM). */
  questions: string[];
  annotations: Alert[];
  /** Why the entry was queued for the offline deep read (document, prescription, ...), if it was. */
  deep: string | null;
  /** Fixed pending lines (e.g. STT_PENDING_NOTE), shown under "Pending". */
  pending?: string[];
  /** Who sent it, when that is not the person it is about (subject attribution), so a wrong one is easy to spot. */
  via?: string;
}

/** Attribution suffix: who sent it and who it was logged for. */
export const VIA = (sender: string, subject: string) => ` (sent by ${sender}, logged for ${subject})`;
export const FOR_HINT = "Wrong member? Reply /for <name> to the original message in the group.";

export const STT_PENDING_NOTE = "voice note: transcription pending";
export const ANNOTATION_NOTE = "unverified; doctor sign-off pending";
export const EMPTY_LINE = "No new messages.";
export const QUESTIONS_HEAD = "Questions (reply to this message; start with the member's name so the answer is logged for them):";

const DEEP_EN: Record<string, string> = {
  document: "document", prescription: "prescription", report: "report", medicine: "medicine photo",
};

export function buildDigest(o: {
  entries: DigestEntry[];
  /** Messages whose media is not copied yet (retried next run). Delays are ops lines, not digest lines. */
  pending: number;
  now: string;
  timeZone: string;
  /** Thresholds status: pending_clinician_signoff, signed_off or disabled (not configured). */
  thresholdsStatus: string;
}): string {
  const day = new Intl.DateTimeFormat("en-IN", { timeZone: o.timeZone, day: "numeric", month: "short" }).format(new Date(o.now));
  const dayFmt = (iso: string) => new Intl.DateTimeFormat("en-IN", { timeZone: o.timeZone, day: "numeric", month: "short" }).format(new Date(iso));
  const hm = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: o.timeZone, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  const out: string[] = [`${PRODUCT_NAME} digest, ${day}`];
  const entries = [...o.entries].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  // A digest that catches up on earlier days (a skipped or failed run) groups by day and dates every time.
  const days = [...new Set(entries.map((e) => dayFmt(e.ts)))];
  const multi = days.length > 1;
  const time = (iso: string) => (multi ? `${dayFmt(iso)} ${hm(iso)}` : hm(iso));

  const recorded = entries.filter((e) => e.readings.length || e.symptoms.length);
  if (!entries.length && !o.pending) out.push("", EMPTY_LINE);
  for (const dy of multi ? days : [null]) {
    const inDay = recorded.filter((e) => dy === null || dayFmt(e.ts) === dy);
    if (dy !== null && inDay.length) out.push("", `== ${dy} ==`);
    for (const p of [...new Set(inDay.map((e) => e.person))]) {
      out.push("", p);
      for (const e of inDay.filter((x) => x.person === p))
        for (const l of [...e.readings.map(readingEn), ...e.symptoms.map(symptomEn)]) out.push(`• ${time(e.ts)} ${l}${e.via ? VIA(e.via, e.person) : ""}`);
    }
  }

  const pending = [
    ...entries.filter((e) => e.deep && DEEP_EN[e.deep]).map((e) => `${e.person} ${time(e.ts)} ${DEEP_EN[e.deep!]}: kept for a closer read${e.via ? VIA(e.via, e.person) : ""}`),
    ...entries.flatMap((e) => (e.pending ?? []).map((l) => `${e.person} ${time(e.ts)} ${l}${e.via ? VIA(e.via, e.person) : ""}`)),
    ...(o.pending ? [`${o.pending} message(s) waiting for their file; retried next run`] : []),
  ];
  if (pending.length) out.push("", "Pending", ...pending.map((l) => `• ${l}`));

  const flagged = entries.filter((e) => e.annotations.length);
  if (flagged.length) {
    out.push("", `Rule annotations (${ANNOTATION_NOTE}; thresholds: ${o.thresholdsStatus}). Not advice; call the doctor if worried:`);
    for (const e of flagged) for (const a of e.annotations) out.push(`- ${e.person} ${time(e.ts)}: T${a.tier} ${a.code}: ${a.detail}`);
  }

  const questions = entries.flatMap((e) => e.questions.map((q) => `${e.person} ${time(e.ts)} ${e.snippet ? `"${e.snippet}"` : kindEn(e.kind)}: ${q}`));
  if (questions.length) {
    out.push("", QUESTIONS_HEAD);
    questions.forEach((q, i) => out.push(`${i + 1}. ${q}`));
  }

  if (entries.some((e) => e.via)) out.push("", FOR_HINT);
  return out.join("\n");
}

const kindEn = (k: string) => ({ audio: "voice note", image: "photo", document: "document", text: "message" })[k] ?? k;
