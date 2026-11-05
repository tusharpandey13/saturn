// Daily digest (ADR 005, ADR 011): sent ONLY to the admins by private DM, in plain English. The group is input-only;
// the bot never posts there. Also the heartbeat: a day without a digest DM means the batch broke.
// Values are rendered from the stored records with fixed templates (src/replies.ts), never LLM text.
// No ops noise here: delays, failures and operator warnings go in a separate short admin DM (finish, ops lines).
// Red-flag rules appear only as annotations, explicitly unverified, with the thresholds status.

import { PRODUCT_NAME } from "../product.js";
import { readingEn, symptomEn } from "../replies.js";
import type { Alert, Reading, Symptom } from "../types.js";
import { durationEn } from "../extract/voice.js";

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
  /** Life-context signals in shadow mode (ADR 010), fixed template "<who>: <category>[, <intensity>]: <summary>".
   *  Admin digest only; never in a view while context_mode is shadow. */
  context?: string[];
  /** Fixed "what was recorded" lines that are not readings (e.g. "lab report: 24 value(s) recorded (sample ...)"). */
  notes?: string[];
  /** Voice note read from a machine transcript nobody has checked: the whole entry (readings, symptoms, notes and the
   *  statement lines below) is listed under VOICE_HEAD, never among the recorded facts. Absent for listened transcripts. */
  unchecked?: boolean;
  /** Statement lines of a voice note ("says: <summary>"; the summary keeps its own negation), fixed templates. */
  said?: string[];
  /** An admin's reply to a numbered digest item (data/telegram/answers.ndjson): acknowledged in the next digest. */
  answered?: { n: number; ref: string; label: string; text: string }[];
}

/** A numbered, answerable digest line: the admin replies "<n> <text>" (or "done <n>") in the private chat; the batch
 *  resolves n through the digest's logged items (data/telegram/digests.jsonl) and writes data/telegram/answers.ndjson.
 *  ref: `q:<message key>#<i>` (question i of that message), `unread:<message key>`, `voice:<message key>`. */
export interface DigestItem {
  n: number;
  ref: string;
  /** Short identification for the acknowledgement line (member, time, kind), never the question text. */
  label: string;
}

/** Attribution suffix: who sent it and who it was logged for. */
export const VIA = (sender: string, subject: string) => ` (sent by ${sender}, logged for ${subject})`;
export const FOR_HINT = "Wrong member? Reply /for <name> to the original message in the group.";

export const PRIVATE_NOTE = "🔒 private message kept (not read)";
export const CONTEXT_HEAD = "Context (shadow): life-context notes, unverified, shown to the admin only. Alongside, not as a cause. Facts as written; not advice; doctors decide.";
export const STT_PENDING_NOTE = "voice note: transcription pending";
export const LISTEN_HEAD = "Voice notes to check (not transcribed, low confidence, or nothing understood). Reply \"<n> heard\" after listening, or add the note to data/telegram/listened.ndjson:";
export const LISTEN_MAX = 15;
export const ANNOTATION_NOTE = "unverified; doctor sign-off pending";
export const EMPTY_LINE = "No new messages.";
/** Appended to EMPTY_LINE: how stale the records are (a boring night should look boring, not broken). */
export const lastReadingEn = (lastReadingAt: string | null | undefined, now: string): string => {
  if (!lastReadingAt) return "No readings recorded yet.";
  const days = Math.max(0, Math.floor((Date.parse(now) - Date.parse(lastReadingAt)) / 86_400_000));
  return `Last reading ${days === 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`}.`;
};
export const QUESTIONS_HEAD = "Questions (reply \"<n> <answer>\" to this chat; the batch logs it against the item):";
/** Documents, prescriptions, strip photos and reports nothing has read yet (no facts): a standing list until a person
 *  deals with the item (reply "<n> handled", or a data/telegram/handled-manually.ndjson row). */
export const UNREAD_HEAD = "Unread documents (no facts recorded yet; reply \"<n> handled\" when dealt with):";
export const UNREAD_MAX = 10;
/** Statements and values from a voice note's machine transcript that nobody has listened to. */
export const VOICE_HEAD = "From voice notes (machine transcript, unchecked):";
export const ANSWERED_HEAD = "Answered (logged in data/telegram/answers.ndjson):";

const DEEP_EN: Record<string, string> = {
  document: "document", prescription: "prescription", report: "report", medicine: "medicine photo",
};

export interface DigestInput {
  entries: DigestEntry[];
  /** Messages whose media is not copied yet (retried next run). Delays are ops lines, not digest lines. */
  pending: number;
  now: string;
  timeZone: string;
  /** Thresholds status: pending_clinician_signoff, signed_off or disabled (not configured). */
  thresholdsStatus: string;
  /** Messages not read for context this run because the daily cap was reached (shadow mode). */
  contextSkipped?: number;
  /** Voice notes to check (steps.ts unlistened), with the reason; a standing list until a person marks the note listened. */
  listen?: { key?: string; person: string; ts: string; durationSec: number; why: string }[];
  /** Unread documents (steps.ts unreadDocuments), oldest first; a standing list until handled. */
  unread?: { key: string; person: string; ts: string; what: string; via?: string }[];
  /** When the newest reading in the records was measured (null: none yet); shown with EMPTY_LINE. */
  lastReadingAt?: string | null;
}

export function buildDigest(o: DigestInput): string {
  return renderDigest(o).text;
}

/** The digest text plus its numbered items (logged with the sent digest so a reply "<n> ..." can be resolved). */
export function renderDigest(o: DigestInput): { text: string; items: DigestItem[] } {
  const day = new Intl.DateTimeFormat("en-IN", { timeZone: o.timeZone, day: "numeric", month: "short" }).format(new Date(o.now));
  const dayFmt = (iso: string) => new Intl.DateTimeFormat("en-IN", { timeZone: o.timeZone, day: "numeric", month: "short" }).format(new Date(iso));
  const hm = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: o.timeZone, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  const out: string[] = [`${PRODUCT_NAME} digest, ${day}`];
  const entries = [...o.entries].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  // A digest that catches up on earlier days (a skipped or failed run) groups by day and dates every time.
  const days = [...new Set(entries.map((e) => dayFmt(e.ts)))];
  const multi = days.length > 1;
  const time = (iso: string) => (multi ? `${dayFmt(iso)} ${hm(iso)}` : hm(iso));

  const items: DigestItem[] = [];
  const number = (ref: string, label: string): number => {
    const n = items.length + 1;
    items.push({ n, ref, label });
    return n;
  };
  const full = (iso: string) => `${dayFmt(iso)} ${hm(iso)}`;
  const ago = (iso: string) => {
    const days = Math.max(0, Math.floor((Date.parse(o.now) - Date.parse(iso)) / 86_400_000));
    return days === 1 ? "1 day" : `${days} days`;
  };

  const recorded = entries.filter((e) => !e.unchecked && (e.readings.length || e.symptoms.length || e.notes?.length));
  if (!entries.length && !o.pending) out.push("", `${EMPTY_LINE} ${lastReadingEn(o.lastReadingAt, o.now)}`);
  for (const dy of multi ? days : [null]) {
    const inDay = recorded.filter((e) => dy === null || dayFmt(e.ts) === dy);
    if (dy !== null && inDay.length) out.push("", `== ${dy} ==`);
    for (const p of [...new Set(inDay.map((e) => e.person))]) {
      out.push("", p);
      for (const e of inDay.filter((x) => x.person === p))
        for (const l of [...(e.notes ?? []), ...(e.said ?? []), ...e.readings.map(readingEn), ...e.symptoms.map(symptomEn)]) out.push(`• ${time(e.ts)} ${l}${e.via ? VIA(e.via, e.person) : ""}`);
    }
  }

  const pending = [
    ...entries.filter((e) => e.deep && DEEP_EN[e.deep]).map((e) => `${e.person} ${time(e.ts)} ${DEEP_EN[e.deep!]}: kept for a closer read${e.via ? VIA(e.via, e.person) : ""}`),
    ...entries.flatMap((e) => (e.pending ?? []).map((l) => `${e.person} ${time(e.ts)} ${l}${e.via ? VIA(e.via, e.person) : ""}`)),
    ...(o.pending ? [`${o.pending} message(s) waiting for their file; retried next run`] : []),
  ];
  if (pending.length) out.push("", "Pending", ...pending.map((l) => `• ${l}`));

  if (o.unread?.length) {
    out.push("", UNREAD_HEAD);
    for (const u of o.unread.slice(0, UNREAD_MAX)) out.push(`${number(`unread:${u.key}`, `${u.person} ${full(u.ts)} ${u.what}`)}. ${u.person} ${full(u.ts)} ${u.what}, ${ago(u.ts)}${u.via ? VIA(u.via, u.person) : ""} [${u.key}]`);
    if (o.unread.length > UNREAD_MAX) out.push(`• … and ${o.unread.length - UNREAD_MAX} more (oldest shown first)`);
  }

  // Unchecked machine transcripts: their own section, so nothing said in a voice note looks like a recorded fact.
  const unchecked = entries.filter((e) => e.unchecked && (e.readings.length || e.symptoms.length || e.notes?.length || e.said?.length));
  if (unchecked.length) {
    out.push("", VOICE_HEAD);
    for (const e of unchecked)
      for (const l of [...(e.notes ?? []), ...(e.said ?? []), ...e.readings.map(readingEn), ...e.symptoms.map(symptomEn)]) out.push(`• ${e.person} ${time(e.ts)} ${l}${e.via ? VIA(e.via, e.person) : ""}`);
  }

  const flagged = entries.filter((e) => e.annotations.length);
  if (flagged.length) {
    out.push("", `Rule annotations (${ANNOTATION_NOTE}; thresholds: ${o.thresholdsStatus}). Not advice; call the doctor if worried:`);
    for (const e of flagged) for (const a of e.annotations) out.push(`- ${e.person} ${time(e.ts)}: T${a.tier} ${a.code}: ${a.detail}`);
  }

  const ctx = entries.flatMap((e) => (e.context ?? []).map((l) => `${time(e.ts)} ${l}`));
  if (ctx.length || o.contextSkipped) {
    out.push("", CONTEXT_HEAD, ...ctx.map((l) => `• ${l}`));
    if (o.contextSkipped) out.push(`• ${o.contextSkipped} message(s) not read for context (daily cap reached)`);
  }

  if (o.listen?.length) {
    out.push("", LISTEN_HEAD);
    for (const v of o.listen.slice(0, LISTEN_MAX)) {
      const line = `${v.person} ${full(v.ts)}, ${durationEn(v.durationSec)} (${v.why})`;
      out.push(v.key ? `${number(`voice:${v.key}`, `${v.person} ${full(v.ts)} voice note`)}. ${line}` : `• ${line}`);
    }
    if (o.listen.length > LISTEN_MAX) out.push(`• … and ${o.listen.length - LISTEN_MAX} more`);
  }

  const questions = entries.flatMap((e) => e.questions.map((q, i) => ({ ref: `q:${e.key ?? `${e.person}@${e.ts}`}#${i}`, label: `${e.person} ${full(e.ts)} ${kindEn(e.kind)}`, line: `${e.person} ${time(e.ts)} ${e.snippet ? `"${e.snippet}"` : kindEn(e.kind)}: ${q}` })));
  if (questions.length) {
    out.push("", QUESTIONS_HEAD);
    for (const q of questions) out.push(`${number(q.ref, q.label)}. ${q.line}`);
  }

  const answered = entries.flatMap((e) => e.answered ?? []);
  if (answered.length) out.push("", ANSWERED_HEAD, ...answered.map((a) => `• answered: ${a.n} (${a.label}): ${a.text}`));

  if (entries.some((e) => e.via)) out.push("", FOR_HINT);
  return { text: out.join("\n"), items };
}

const kindEn = (k: string) => ({ audio: "voice note", image: "photo", document: "document", text: "message" })[k] ?? k;
