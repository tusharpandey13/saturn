// Life-context signals (ADR 010): a closed vocabulary of context bands read from family conversation in the same
// extraction call as health facts. Everything here is deterministic: the pre-filter decides which messages may be
// read for context (consent, /private, length, forwards, the daily cap), and parseContext() validates and minimises
// what the model returned before a row is written. Health extraction never depends on anything in this file.

import { z } from "zod";
import { type Alias, resolveName } from "../subject.js";

/** The vocabulary is a product enum: a change is a schema change (schema/event.schema.json data.category). */
export const CONTEXT_CATEGORIES = [
  "stress", "bereavement", "travel", "festival_fasting", "sleep", "diet_change", "activity", "mood", "work_load",
  "weather_heat", "social_event",
] as const;
export type ContextCategory = (typeof CONTEXT_CATEGORIES)[number];

/** env.yaml context_mode -> batch env CONTEXT_MODE. off (default): nothing is read for context. shadow: extracted and
 *  stored (tag shadow, hidden from every view), shown only in the admin DM digest. on: shown in the timeline overlay. */
export const CONTEXT_MODES = ["off", "shadow", "on"] as const;
export type ContextMode = (typeof CONTEXT_MODES)[number];
export const parseContextMode = (v: string | undefined): ContextMode => (CONTEXT_MODES as readonly string[]).includes(v ?? "") ? (v as ContextMode) : "off";

/** Hard cap: messages read for context (header `context: yes`) per IST day. Over it, signals are skipped (counted in
 *  the log); health extraction is never blocked. */
export const CONTEXT_DAILY_CAP = 20;
export const MAX_SIGNALS_PER_MESSAGE = 3;
export const SUMMARY_MAX = 80;

/** `/private` at the start: the message is archived raw and never extracted (no health facts, no context). */
export const isPrivate = (text: string | undefined): boolean => /^\s*\/private(?:@\w+)?(?=$|\s)/i.test(text ?? "");

/** Causal phrasing is never allowed in a summary or any view derived from context (association only). */
export const CAUSAL = /\b(because( of)?|due to|caus(e|ed|es|ing)|trigger(ed|s|ing)?|led to|leads? to|result(ed|s)? (in|from)|explains?|owing to)\b|के कारण|की वजह से|\bse hua\b|\bki wajah se\b|\bke karan\b/i;

/** The model's context items (part of the extraction output; [] unless the message header says context: yes). */
export const ContextItem = z.strictObject({
  category: z.enum(CONTEXT_CATEGORIES),
  about: z.string().describe('"sender", or the family member it is about as written ("Maa"); never anyone else'),
  summary: z.string().describe(`short English paraphrase, <= ${SUMMARY_MAX} chars, never a quote, no names of people or places`),
  intensity: z.enum(["low", "med", "high"]).nullable().describe("only when the message states it (\"very tired\", \"bahut tension\"); else null"),
  confidence: z.enum(["low", "high"]),
  start: z.string().nullable().describe("YYYY-MM-DD when the period starts, if said; else null (= the message day)"),
  end: z.string().nullable().describe("YYYY-MM-DD when the period ends, if said; else null"),
});

export interface ContextSignal {
  /** D1 person id of the member the signal is about. */
  subject: string;
  category: ContextCategory;
  summary: string;
  intensity: "low" | "med" | "high" | null;
  confidence: "low" | "high";
  start: string;
  end: string | null;
}

/** Why a message is (not) read for context. Deterministic, no LLM. */
export function contextEligible(o: { mode: ContextMode; senderConsented: boolean; text: string | undefined; forwarded: boolean; vitalsOnly: boolean }): boolean {
  if (o.mode === "off" || !o.senderConsented || o.forwarded || o.vitalsOnly) return false;
  const words = (o.text ?? "").split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  return words.length >= 4;
}

const norm = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("en").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
/** Shares any 4-word sequence with the message (case, accents and punctuation ignored)? */
export function sharesFourGram(summary: string, text: string): boolean {
  const grams = (w: string[]) => new Set(w.slice(0, Math.max(0, w.length - 3)).map((_, i) => w.slice(i, i + 4).join(" ")));
  const t = grams(norm(text));
  return [...grams(norm(summary))].some((g) => t.has(g));
}

const DAY = 86_400_000;
const istDay = (iso: string) => new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(0, 10);
function day(v: unknown, msgDay: string): string | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return null;
  const d = Date.parse(`${v.trim()}T00:00:00Z`);
  const m = Date.parse(`${msgDay}T00:00:00Z`);
  return Number.isNaN(d) || Math.abs(d - m) > 30 * DAY ? null : v.trim();
}

export interface ParseContextInput {
  /** The message text the model read (text, caption or transcript). */
  text: string;
  /** Message time (ISO); the default period is its IST day. */
  ts: string;
  /** D1 person id of the sender. */
  sender: string;
  aliases: Alias[];
  personIds: string[];
  /** D1 person id -> consent confirmed. Anyone else is never a subject. */
  consented: (personId: string) => boolean;
}

/** Validate and minimise the model's context items. Never throws. Drops (and counts) anything out of vocabulary,
 *  about a non-member or a member without consent, quoting the message, naming anyone, or phrased causally. */
export function parseContext(raw: unknown, i: ParseContextInput): { signals: ContextSignal[]; dropped: number } {
  const items = raw && typeof raw === "object" && Array.isArray((raw as any).context) ? ((raw as any).context as unknown[]) : [];
  const msgDay = istDay(i.ts);
  // Words allowed with a capital letter: member display names and aliases (the subject may be named).
  const allowed = new Set(i.aliases.flatMap((a) => [a.alias, a.display]).map((n) => n.toLocaleLowerCase("en")));
  const signals: ContextSignal[] = [];
  let dropped = 0;
  for (const it of items.slice(0, MAX_SIGNALS_PER_MESSAGE)) {
    const p = ContextItem.safeParse(it);
    if (!p.success) {
      dropped++;
      continue;
    }
    const c = p.data;
    const about = c.about.trim();
    const subject = /^(sender|self|me|i)$/i.test(about) ? i.sender : resolveName(about, i.aliases, i.personIds)?.personId ?? null;
    const summary = c.summary.replace(/\s+/g, " ").trim();
    const capitalised = summary.split(" ").slice(1).map((w) => w.replace(/[^\p{L}]/gu, "")).filter((w) => /^\p{Lu}/u.test(w));
    const ok = subject !== null && i.consented(subject) && summary.length > 0 && summary.length <= SUMMARY_MAX
      && !/["“”«»]/.test(summary) && !sharesFourGram(summary, i.text) && !CAUSAL.test(summary)
      && capitalised.every((w) => allowed.has(w.toLocaleLowerCase("en")));
    if (!ok) {
      dropped++;
      continue;
    }
    const start = day(c.start, msgDay) ?? msgDay;
    const end = day(c.end, msgDay);
    signals.push({ subject: subject!, category: c.category, summary, intensity: c.intensity, confidence: c.confidence, start, end: end && end > start ? end : null });
  }
  return { signals, dropped: dropped + Math.max(0, items.length - MAX_SIGNALS_PER_MESSAGE) };
}

/** Prompt rules for messages whose header says `context: yes` (appended to the extraction system prompt). */
export const CONTEXT_RULES = `- Life context (only for messages whose header says "context: yes"; for all others context is []):
  list explicit life-context signals about a family member, each one of: ${CONTEXT_CATEGORIES.join(", ")}.
  Only what the message says plainly; jokes, idioms ("dimag kharab", "jaan nikal gayi"), forwards and guesses are not signals.
  about: "sender" if it is about the sender, else the family member as written ("Maa"). Never a friend, relative, colleague or anyone else: omit those.
  summary: a short neutral English paraphrase (<= ${SUMMARY_MAX} chars). Never quote the message. No names of people or places
  (write "a relative", "a friend", "a colleague"). No health details of anyone outside the family. Never say why something happened.
  intensity only when the message states it ("very tired", "bahut tension"); else null. confidence high only when explicit.
  Context never changes the readings or symptoms.`;
