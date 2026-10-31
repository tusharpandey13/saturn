// Voice notes: extraction from a machine transcript (whisper.cpp, local). The SOURCE-LANGUAGE transcript (Hindi,
// Devanagari) goes to the model as is; there is no translation step anywhere (a translation pass once rendered
// "vomiting" as "fainted"). The model returns the normal extraction fields plus `statements`: one item per thing
// said, each with a verbatim quote from the transcript. parseStatements() validates every item in code: a quote that
// is not in the transcript, an unknown category or a date after the message is dropped (counted), never repaired.
// Items are tagged machine-transcript (+ patient-reported / family-reported) by tools/kb/build.

import { z } from "zod";
import { ExtractionOutput } from "./schema.js";

export const STATEMENT_CATEGORIES = ["symptom", "medication", "reading", "food_fluid", "sleep", "activity", "event", "state", "other"] as const;
export const TIME_FRAMES = ["current", "past", "ongoing", "planned", "unclear"] as const;
export const SPEAKERS = ["sender", "other", "unclear"] as const;
export const STATEMENT_SUMMARY_MAX = 160;
export const QUOTE_MAX = 300;
export const MAX_STATEMENTS = 40;

export const Statement = z.strictObject({
  category: z.enum(STATEMENT_CATEGORIES),
  summary: z.string().describe(`short neutral English paraphrase of exactly what is said (<= ${STATEMENT_SUMMARY_MAX} chars); no interpretation, no diagnosis, no advice; keep a negation ("no dizziness today")`),
  quote: z.string().describe("the supporting words copied EXACTLY from the transcript, in its own script (Devanagari stays Devanagari); never translated, never corrected"),
  negated: z.boolean().describe("true when the speaker says it did NOT happen / is absent (\"aaj chakkar nahi aaya\")"),
  time_frame: z.enum(TIME_FRAMES).describe("current = true now/today; past = happened earlier and is over; ongoing = started earlier and continues; planned = intended; unclear"),
  when_text: z.string().nullable().describe("the time words as said (\"kal\", \"parso\", \"pichhle hafte\", \"subah\"), else null"),
  when: z.string().nullable().describe("resolved against the message date: YYYY-MM-DD, or YYYY-MM-DDTHH:MM local time when a clock time is said; a span like \"last week\" -> its first day; null when no time is said (= the message time)"),
  speaker: z.enum(SPEAKERS).describe("sender = the person who sent the voice note is speaking; other = another voice in the recording; unclear"),
  speaker_name: z.string().nullable().describe("the other speaker as identified in the recording (\"beta\", \"doctor\"), else null"),
  about: z.string().nullable().describe("who it is about when that is not the speaker, as said (\"Papa\"); else null"),
  confidence: z.number().describe("0-1: how sure you are this is what the transcript says (machine transcripts have errors)"),
});

/** The voice-note contract: the extraction fields + statements. Strict, like ExtractionOutput. */
export const VoiceOutput = ExtractionOutput.extend({
  statements: z.array(Statement).describe(`every health-relevant thing said, in order, max ${MAX_STATEMENTS}`),
});

export const VOICE_SCHEMA = (() => {
  const { $schema: _drop, ...s } = z.toJSONSchema(VoiceOutput) as Record<string, any>;
  return s as { type: "object"; required: string[]; properties: Record<string, unknown>; additionalProperties: false };
})();

/** Added to the system prompt for voice notes only. */
export const VOICE_RULES = `
VOICE NOTES (header says voice: yes). The text is a MACHINE TRANSCRIPT of a voice note in the speaker's own language
(usually Hindi in Devanagari; Hinglish or English words may appear). It has recognition errors. Read it in that language;
do NOT translate it first and never rely on a translation.
- statements: one item per health-relevant thing said (symptoms, medicines taken/stopped/missed, readings said aloud,
  food/fluids, sleep, activity, events such as a visit or a fall, how the person feels now). quote = the exact words from
  the transcript (copy-paste, same script, no fixes). summary = a neutral English paraphrase of those words only.
- Dates: resolve relative time words against the MESSAGE date in the header (Asia/Kolkata): aaj/today = that day;
  kal/yesterday (past tense) = day before; parso = two days before (past tense); pichhle hafte / last week = 7 days before;
  "do din se" = ongoing since two days before. "kal" with future tense = planned, next day. Put the words in when_text.
- Separate the past from now: "kal chakkar aaya tha" = past; "abhi theek hoon" = current. Never merge them.
- Negations are facts: "aaj chakkar nahi aaya" -> a statement with negated true. In \`symptoms\`, emit only symptoms that
  are present (not negated) and current or recent; everything said, including negated and past items, goes in statements.
- Medicines: what is said about taking, stopping, missing or changing a medicine is a statement (category medication),
  exactly as said; never judge it, never suggest anything.
- Speakers: the sender usually speaks; mark another voice (a doctor, a child) as speaker other with speaker_name.
- Readings said aloud ("BP ek sau bees bata assi") go in readings as numbers AND in statements with the quote.
- If the transcript is mostly unintelligible, set unreadable_reason and return what is clear.`;

export interface ParsedStatement {
  category: (typeof STATEMENT_CATEGORIES)[number];
  summary: string;
  quote: string;
  negated: boolean;
  timeFrame: (typeof TIME_FRAMES)[number];
  whenText: string | null;
  /** YYYY-MM-DD or YYYY-MM-DDTHH:MM (local), or null = the message time. */
  when: string | null;
  speaker: (typeof SPEAKERS)[number];
  speakerName: string | null;
  about: string | null;
  confidence: number;
}

/** Whitespace/punctuation-insensitive form for the verbatim check. */
const norm = (s: string) => s.normalize("NFC").replace(/[\s।॥,.?!;:"'“”‘’()\-–—…]+/gu, " ").trim().toLowerCase();

const DAY = 86_400_000;
const istDay = (iso: string) => new Date(Date.parse(iso) + 5.5 * 3_600_000).toISOString().slice(0, 10);

/** Validate the model's statements against the transcript. Drops (and counts) anything not verbatim or out of range. */
export function parseStatements(raw: unknown, messageTs: string, transcript: string): { statements: ParsedStatement[]; dropped: number } {
  const items = Array.isArray((raw as { statements?: unknown })?.statements) ? ((raw as { statements: unknown[] }).statements) : [];
  const hay = norm(transcript);
  const msgDay = istDay(messageTs);
  const out: ParsedStatement[] = [];
  let dropped = 0;
  for (const it of items.slice(0, MAX_STATEMENTS)) {
    const p = Statement.safeParse(it);
    if (!p.success) {
      dropped++;
      continue;
    }
    const s = p.data;
    const q = norm(s.quote);
    if (q.length < 2 || !hay.includes(q) || !s.summary.trim()) {
      dropped++; // not verbatim: the model paraphrased, translated or invented it
      continue;
    }
    let when = s.when?.trim() || null;
    if (when) {
      const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/.exec(when);
      const day = m?.[1];
      const ok = day && !Number.isNaN(Date.parse(day)) && Date.parse(day) <= Date.parse(msgDay) + (s.time_frame === "planned" ? 7 * DAY : 0)
        && Date.parse(day) >= Date.parse(msgDay) - 366 * DAY;
      when = ok ? (m![2] ? `${day}T${m![2]}` : day!) : null; // unusable date: the message time stands, when_text keeps the words
    }
    out.push({
      category: s.category, summary: s.summary.trim().slice(0, STATEMENT_SUMMARY_MAX), quote: s.quote.trim().slice(0, QUOTE_MAX),
      negated: s.negated, timeFrame: s.time_frame, whenText: s.when_text?.trim().slice(0, 60) || null, when,
      speaker: s.speaker, speakerName: s.speaker_name?.trim().slice(0, 40) || null, about: s.about?.trim().slice(0, 40) || null,
      confidence: Math.max(0, Math.min(1, s.confidence)),
    });
  }
  return { statements: out, dropped: dropped + Math.max(0, items.length - MAX_STATEMENTS) };
}

/** "3 min 48 s" / "42 s". */
export const durationEn = (sec: number) => {
  const s = Math.max(0, Math.round(sec));
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
};
