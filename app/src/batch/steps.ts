// Daily batch (ADR 005), three idempotent steps. The workflow commits between them:
//   pull     D1 inbox (status new) + media (R2, or Telegram by file_id) -> data/telegram/raw/ + sources/   [commit]
//   extract  raw rows not yet extracted -> STT (optional) / vitals parser / claude -p (Haiku text, Sonnet photo/PDF) -> data/telegram/*.ndjson,
//            needs_deep queue, digest text + ops lines                                                   [build, commit]
//   finish   mark the committed and processed inbox rows done, DM the digest and ops lines to the admins, prune
// The bot never posts to a group chat (ADR 011): groups are input-only; the admins are the only output channel.
// Re-running any step on the same input is safe: raw rows are keyed by update_id, extracted rows by message id
// (chat:message), the queue by message id, and inbox updates only touch rows still 'new'.

import { createHash } from "node:crypto";
import { PRODUCT_NAME } from "../product.js";
import { parseUpdate, type ParsedMessage, type TelegramAdapter } from "../channel/telegram.js";
import type { ThresholdsConfig } from "../config/thresholds.js";
import { type ExtractInput, type Extractor, ExtractorStopError } from "../extract/adapter.js";
import { type Extraction, parseExtraction } from "../extract/schema.js";
import { readingEn } from "../replies.js";
import { evaluate } from "../rules/engine.js";
import type { Store } from "../store.js";
import { SARVAM_REST_MAX_SEC, SttJobFailedError } from "../../../adapters/stt/sarvam.js";
import { HEALTH_MEDIA_KINDS, IMAGE_CLASS, type Media, type Person, type Reading, type SpeechToText, type Symptom, type Transcript } from "../types.js";
import { parseVitals } from "../vitals.js";
import { buildDigest, type DigestEntry, PRIVATE_NOTE, STT_PENDING_NOTE } from "./digest.js";
import { CONTEXT_DAILY_CAP, contextEligible, type ContextMode, type ContextSignal, isPrivate, parseContext } from "../extract/context.js";

/** Ops line (admin DM only): extraction or STT failed for some messages (auth, usage limit, outage). */
export const DELAYED_OPS = (n: number) => `extraction delayed for ${n} message(s) (auth, usage limit or outage); all kept, retried next run. Check the batch log.`;
import { dayOf, MIME_OF_EXT, type RawRow, Repo, type Row, type SubjectOverride } from "./repo.js";
import { type Alias, displayOf, splitSubject } from "../subject.js";

export const LOW_CONFIDENCE = 0.8; // same bar as v_needs_human in data/schema.sql
const DAY = 86_400_000;

// ---------------------------------------------------------------- pull

export interface PullDeps {
  store: Store;
  r2: { get(key: string): Promise<Media> };
  tg: TelegramAdapter;
  repo: Repo;
  /** records.yaml aliases (keyed by D1 person id), synced into D1 for the Worker's name prefixes. Omitted: left as is. */
  aliases?: Alias[];
}

export async function pull(d: PullDeps): Promise<{ pulled: number; mediaCopied: number; mediaMissing: number; overrides: number; changed: string[] }> {
  // One D1 call for the whole pull (alias sync + every read): the Cloudflare REST API is rate limited per user.
  const { inbox: rows, persons, chats, corrections } = await d.store.pullSnapshot(d.aliases);
  const role = new Map(persons.map((p) => [p.id, p.role]));
  d.repo.writeDirectory([
    ...persons.map((p) => ({ rt: "d1.persons", id: p.id, name: p.name, role: p.role, sender_id: p.senderId })),
    ...chats.map((c) => ({ rt: "d1.chats", ...c })),
  ]);

  const fresh: RawRow[] = rows.map((r) => {
    const update = JSON.parse(r.raw);
    const ev = parseUpdate(update);
    return {
      update_id: r.update_id, chat_id: r.chat_id, message_id: r.message_id, sender_id: r.sender_id, person_id: r.person_id,
      role: role.get(r.person_id) ?? "member", kind: r.kind, received_at: r.received_at, media_key: r.media_key,
      media_status: r.media_status, media_mime: ev?.type === "message" ? ev.msg.file?.mimeType ?? null : null,
      media_path: null, ack: r.ack, subject_id: r.subject_id ?? r.person_id, update,
    };
  });
  // Media for the new rows, plus any older raw row whose copy failed before (retry from git, by file_id).
  const known = new Set(fresh.map((r) => r.update_id));
  const retry = d.repo.rawRows().filter((r) => !known.has(r.update_id) && r.media_key && !r.media_path && r.media_status !== "too_big");
  let mediaCopied = 0;
  let mediaMissing = 0;
  for (const r of [...fresh, ...retry]) {
    if (!r.media_key || r.media_status === "too_big") continue;
    r.media_path = d.repo.findMedia(r.person_id, r.media_key);
    if (r.media_path) continue;
    try {
      const media = await fetchMedia(d, r);
      r.media_path = d.repo.writeMedia(r.person_id, r.media_key, media.data, r.media_mime ?? media.mimeType);
      mediaCopied++;
    } catch (err) {
      mediaMissing++;
      console.error(`media for update ${r.update_id} not copied: ${(err as Error).message}`); // no PHI in the message
    }
  }
  const changed = d.repo.writeRaw([...fresh, ...retry.filter((r) => r.media_path)]);
  // Admins' /for corrections -> the records' auditable override file (namespaces, not D1 ids).
  const fromD1: SubjectOverride[] = corrections.map((c) => ({
    id: `tg-for:${c.id}`, update_id: c.update_id, subject: d.repo.personDir(c.subject_id), set_by: d.repo.personDir(c.set_by),
    set_at: c.set_at, reason: c.reason ?? "telegram /for",
  }));
  const before = d.repo.subjectOverrides().length;
  changed.push(...d.repo.appendOverrides(fromD1));
  return { pulled: fresh.length, mediaCopied, mediaMissing, overrides: d.repo.subjectOverrides().length - before, changed };
}

async function fetchMedia(d: PullDeps, r: RawRow): Promise<Media> {
  if (r.media_status === "stored") {
    try {
      return await d.r2.get(r.media_key!);
    } catch {
      /* fall through to Telegram */
    }
  }
  const ev = parseUpdate(r.update);
  if (ev?.type !== "message" || !ev.msg.file) throw new Error("no file in update");
  const res = await d.tg.fetchFile(ev.msg.file.fileId);
  return { data: new Uint8Array(await res.arrayBuffer()), mimeType: ev.msg.file.mimeType };
}

// ---------------------------------------------------------------- extract

export interface ExtractDeps {
  repo: Repo;
  extractor: Extractor;
  /** null: no STT key (Sarvam deferred). Voice notes are kept and marked stt_pending; a later run with STT transcribes them. */
  stt: SpeechToText | null;
  /** From the records repo (config/thresholds.yaml); DISABLED_THRESHOLDS when absent. */
  thresholds: ThresholdsConfig;
  persons: Map<string, Person>;
  now: string;
  timeZone?: string;
  /** STT batch polling (long voice notes). */
  sttPollMs?: number;
  sttTimeoutMs?: number;
  /** Re-try messages whose extraction failed permanently before. */
  retryFailed?: boolean;
  /** Operator warnings (e.g. Claude token expiry): ops lines for the admin DM, never in the digest. */
  warnings?: string[];
  /** records.yaml aliases (keyed by D1 person id): name prefixes for rows the Worker did not attribute (pre-v0.3.0). */
  aliases?: Alias[];
  /** Life-context signals (ADR 010): env context_mode (default off). */
  contextMode?: ContextMode;
  /** D1 person ids whose context consent is confirmed (records.yaml context_consent: true). Nobody else is read. */
  contextConsented?: Set<string>;
  /** Messages read for context per IST day (default CONTEXT_DAILY_CAP). */
  contextDailyCap?: number;
}

/** Who a message is about: a records override (or an admin's /for), else the Worker's subject_id, else a name prefix,
 *  else the sender. The sender (raw.person_id) is never changed. */
export interface Subject {
  id: string;
  source: "override" | "prefix" | "sender";
  setBy: string | null;
}
export function subjectOf(raw: RawRow, text: string | undefined, overrides: Map<number, SubjectOverride>, repo: Repo, aliases: Alias[]): Subject {
  const o = overrides.get(raw.update_id);
  if (o) return { id: repo.d1Id(o.subject), source: "override", setBy: o.set_by };
  if (raw.subject_id) return { id: raw.subject_id, source: raw.subject_id === raw.person_id ? "sender" : "prefix", setBy: null };
  const p = splitSubject(text, aliases).subject;
  return p && p.personId !== raw.person_id ? { id: p.personId, source: "prefix", setBy: null } : { id: raw.person_id, source: "sender", setBy: null };
}

export interface ExtractResult {
  extracted: number;
  pending: number; // missing media + delayed: retried by the next run, inbox rows stay new
  delayed: number; // extraction/STT service failed (auth, usage limit, outage)
  sttPending: number; // voice notes stored without a transcript (no STT key)
  queued: number;
  changed: string[];
  digest: string;
  /** Short, actionable ops lines for a separate admin DM (warnings, delays). Empty = nothing to say. */
  ops: string[];
  /** Life context: messages read, signals kept, signals dropped by minimisation, messages skipped by the daily cap. */
  context: { read: number; signals: number; dropped: number; skippedCap: number };
}

/** A failure the next run may not repeat (network, auth, 429, 5xx, timeouts, CLI crash). */
export function isTransient(err: unknown): boolean {
  if (err instanceof ExtractorStopError || err instanceof SttJobFailedError) return false;
  const e = err as { status?: number; name?: string };
  if (typeof e?.status === "number")
    return [0, 401, 403, 408, 409, 429].includes(e.status) || e.status >= 500;
  return /Connection|Timeout|network/i.test(`${e?.name} ${(err as Error)?.message}`);
}

/** Latest version per message (edits share chat:message_id), every member (admins too), kinds the extractor reads. */
function toExtract(repo: Repo, retryFailed: boolean, sttAvailable: boolean, aliases: Alias[] = []): { raw: RawRow; msg: ParsedMessage; subject: Subject }[] {
  const latest = new Map<string, { raw: RawRow; msg: ParsedMessage }>();
  const overrides = repo.overrideMap();
  for (const raw of repo.rawRows()) {
    if (raw.kind === "other") continue;
    const ev = parseUpdate(raw.update);
    if (ev?.type !== "message") continue;
    const prev = latest.get(ev.msg.key);
    const newer = !prev || ev.msg.editDate > prev.msg.editDate || (ev.msg.editDate === prev.msg.editDate && raw.update_id > prev.raw.update_id);
    if (newer) latest.set(ev.msg.key, { raw, msg: ev.msg });
  }
  const done = new Map(repo.kbRows().filter((r) => r.rt === "d1.messages").map((r) => [r.id as string, r]));
  return [...latest.values()]
    .map((t) => ({ ...t, subject: subjectOf(t.raw, t.msg.text, overrides, repo, aliases) }))
    .filter(({ msg, subject }) => {
      const prev = done.get(msg.key);
      if (!prev) return true;
      if (prev.person_id !== subject.id) return true; // re-attributed (override or /for): re-extract into the new subject
      if (retryFailed && prev.extraction_status === "failed") return true;
      if (sttAvailable && prev.extraction_status === "stt_pending") return true; // backfill once a key exists
      return Number(prev.edit_date ?? 0) < msg.editDate;
    })
    .sort((a, b) => a.raw.update_id - b.raw.update_id);
}

/** Inbox rows that are not processed yet (no KB row): finish leaves them 'new'. */
export function unprocessedUpdateIds(repo: Repo): Set<number> {
  return new Set(toExtract(repo, false, false).map((t) => t.raw.update_id));
}

type Base = {
  /** person_id = the SUBJECT (whose records these are); sender_person_id = who sent it (provenance). */
  rt: string; id: string; person_id: string; sender_person_id: string; subject_source: Subject["source"]; subject_set_by: string | null; chat_id: string; kind: string; media_ref: string | null; raw_text: string | null;
  received_at: string; external_id: string; edit_date: number; transcript: string | null; transcript_language: string | null;
  transcript_confidence: number | null; extraction_json: string | null; extracted_by: string | null; extracted_at: string;
  extraction_status: string; confidence: number | null;
  /** Photo/PDF class (IMAGE_CLASS: device-reading ... non-health), when the extractor reported one. */
  image_class: string | null;
  /** Who the message seems to be about when that is not the sender (extraction hint, for human review). Never reassigns. */
  subject_hint: string | null;
  /** Life context (ADR 010): extracted (read with context: yes) | skipped_cap | private; absent = not read. */
  context_status?: string;
  /** extraction_status duplicate: the message key whose identical file (same bytes, same subject) was recorded. */
  duplicate_of?: string;
};
interface Item {
  raw: RawRow;
  msg: ParsedMessage;
  subject: Subject;
  entry: DigestEntry;
  base: Base;
  input?: ExtractInput;
  ex?: Extraction;
  extractedBy?: string;
  error?: unknown;
  context?: ContextSignal[];
}

export async function extract(d: ExtractDeps): Promise<ExtractResult> {
  const tz = d.timeZone ?? "Asia/Kolkata";
  const aliases = d.aliases ?? [];
  const todo = toExtract(d.repo, !!d.retryFailed, !!d.stt, aliases);
  const history = d.repo.kbRows();
  const out: Row[] = [];
  const replaced = new Set<string>();
  const deep: Record<string, unknown>[] = [];
  const entries: DigestEntry[] = [];
  const items: Item[] = [];
  let pending = 0;
  let delayed = 0;
  let sttPending = 0;
  const mode = d.contextMode ?? "off";
  const consented = d.contextConsented ?? new Set<string>();
  // Daily cap: messages already read for context today (IST), not counting messages this run re-extracts.
  const todoKeys = new Set(todo.map((t) => t.msg.key));
  const today = dayOf(d.now);
  let contextLeft = Math.max(0, (d.contextDailyCap ?? CONTEXT_DAILY_CAP) - history.filter((r) => r.rt === "d1.messages" && r.context_status === "extracted"
    && !todoKeys.has(r.id as string) && dayOf(String(r.extracted_at)) === today).length);
  const ctx = { read: 0, signals: 0, dropped: 0, skippedCap: 0 };
  // Identical media (same bytes, e.g. the same photo sent twice or forwarded) is recorded once per subject:
  // index the files of messages already recorded, then each new file in update order.
  const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
  const seenMedia = new Map<string, string>(); // `${subject}|${sha256}` -> message key
  const recorded = new Map(history.filter((r) => r.rt === "d1.messages").map((r) => [r.id as string, r]));
  for (const raw of d.repo.rawRows()) {
    if (!raw.media_path) continue;
    const ev = parseUpdate(raw.update);
    const prev = ev?.type === "message" ? recorded.get(ev.msg.key) : undefined;
    if (!prev || todoKeys.has(prev.id as string) || ["duplicate", "failed", "skipped", "private"].includes(String(prev.extraction_status))) continue;
    try {
      const k = `${prev.person_id}|${sha(d.repo.readMedia(raw.media_path))}`;
      if (!seenMedia.has(k)) seenMedia.set(k, prev.id as string);
    } catch {
      /* file gone: nothing to match */
    }
  }

  // 1. Per message: skip/park what cannot be read, transcribe voice, take vitals-only texts from the deterministic parser.
  const nameOf = (id: string) => d.persons.get(id)?.name ?? displayOf(id, aliases) ?? id;
  for (const { raw, msg, subject } of todo) {
    const entry: DigestEntry = {
      key: msg.key, person: nameOf(subject.id), ts: msg.ts, snippet: snippet(msg.text), kind: msg.kind, questions: [], annotations: [], deep: null, readings: [], symptoms: [], pending: [],
      ...(subject.id !== raw.person_id && { via: nameOf(raw.person_id) }),
    };
    const base: Base = {
      rt: "d1.messages", id: msg.key, person_id: subject.id, sender_person_id: raw.person_id, subject_source: subject.source,
      subject_set_by: subject.setBy, chat_id: msg.chatId, kind: msg.kind, media_ref: raw.media_key,
      raw_text: msg.text ?? null, received_at: msg.ts, external_id: `tg:${raw.update_id}`, edit_date: msg.editDate,
      transcript: null, transcript_language: null, transcript_confidence: null,
      extraction_json: null, extracted_by: null, extracted_at: d.now, extraction_status: "ok", confidence: null, subject_hint: null, image_class: null,
    };

    if (isPrivate(msg.text)) {
      // /private (ADR 010): archived raw as always, never extracted (no health facts, no context), no snippet.
      out.push({ ...base, raw_text: null, extraction_status: "private", context_status: "private", note: "/private: not extracted" });
      replaced.add(msg.key);
      entries.push({ ...entry, snippet: "", pending: [PRIVATE_NOTE] });
      continue;
    }
    if (raw.media_key && raw.media_status === "too_big") {
      out.push({ ...base, extraction_status: "skipped", note: "file over 20 MB, not stored" });
      replaced.add(msg.key);
      entry.questions.push("file over 20 MB, not saved. Ask the sender for a smaller file or a photo.");
      entries.push(entry);
      continue;
    }
    if (raw.media_key && !raw.media_path) {
      pending++; // media not copied yet: the next pull retries it
      continue;
    }

    const item: Item = { raw, msg, subject, entry, base };
    items.push(item);
    try {
      let transcript: Transcript | null = null;
      const media = raw.media_path ? { data: d.repo.readMedia(raw.media_path), mimeType: raw.media_mime ?? MIME_OF_EXT[raw.media_path.split(".").pop()!] ?? "application/octet-stream" } : undefined;
      if (media && (msg.kind === "image" || msg.kind === "document")) {
        const k = `${subject.id}|${sha(media.data)}`;
        const first = seenMedia.get(k);
        if (first && first !== msg.key) {
          // Same file already recorded for this subject: one source, no second set of facts, no second deep read.
          out.push({ ...base, extraction_status: "duplicate", duplicate_of: first, note: `same file as message ${first}; recorded once` });
          replaced.add(msg.key);
          entry.pending!.push("same file as an earlier message; recorded once");
          entries.push(entry);
          items.pop();
          continue;
        }
        seenMedia.set(k, msg.key);
      }
      if (msg.kind === "audio" && media) {
        if (!d.stt) {
          // Stored (raw + media are in git); transcribed by the first run that has an STT key.
          out.push({ ...base, extraction_status: "stt_pending", note: "voice note stored; transcription pending (no STT key)" });
          replaced.add(msg.key);
          entry.pending!.push(STT_PENDING_NOTE);
          entries.push(entry);
          items.pop();
          sttPending++;
          continue;
        }
        transcript = await transcribe(d.stt, d, media, msg.durationSec ?? 0);
        Object.assign(base, { transcript: transcript.text, transcript_language: transcript.languageCode ?? null, transcript_confidence: transcript.languageProbability ?? null });
      }
      const text = transcript?.text ?? msg.text;
      // The name prefix is not part of the values (the Worker echoed the text without it).
      const vit = msg.kind === "text" ? parseVitals(splitSubject(text, aliases).rest, msg.ts) : null;
      if (vit?.complete && vit.plausible) {
        // Exactly what the Worker echoed to the patient; no LLM call.
        item.ex = { readings: vit.readings, symptoms: [], confidence: 1, mediaKind: null, unreadableReason: null, subjectHint: null, rejected: [], outOfRange: [] };
        item.extractedBy = "vitals-parser";
      } else {
        item.input = { text, media: msg.kind === "audio" ? undefined : media, now: msg.ts, replyTo: msg.replyToText };
        const forwarded = ["forward_origin", "forward_from", "forward_date", "forward_sender_name"].some((k) => k in ((raw.update.message ?? raw.update.edited_message ?? {}) as object));
        if (contextEligible({ mode, senderConsented: consented.has(raw.person_id), text, forwarded, vitalsOnly: !!vit?.complete })) {
          if (contextLeft > 0) {
            contextLeft--;
            ctx.read++;
            item.input.context = true;
            base.context_status = "extracted";
          } else {
            ctx.skippedCap++;
            base.context_status = "skipped_cap";
          }
        }
      }
    } catch (err) {
      item.error = err;
    }
  }

  // 2. Everything else in as few LLM calls as practical.
  const llm = items.filter((i) => i.input);
  const results = llm.length ? await d.extractor.extract(llm.map((i) => i.input!)) : [];
  llm.forEach((it, k) => {
    const r = results[k];
    if (r instanceof Error || r === undefined) {
      it.error = r ?? new ExtractorStopError("missing_result");
      return;
    }
    it.base.extraction_json = typeof r === "string" ? r : JSON.stringify(r);
    it.ex = parseExtraction(r, it.msg.ts);
    it.extractedBy = d.extractor.modelFor?.(it.input!) ?? d.extractor.model ?? "llm";
    if (it.input!.context) {
      // Context never touches the health result above; anything the minimisation checks reject is dropped, not trimmed.
      const c = parseContext(r, { text: it.input!.text ?? "", ts: it.msg.ts, sender: it.raw.person_id, aliases, personIds: [...d.persons.keys()], consented: (p) => consented.has(p) });
      it.context = c.signals;
      ctx.dropped += c.dropped;
    }
  });

  // 3. Records, questions, deep-read queue, annotations.
  for (const { raw, msg, subject, entry, base, ex, extractedBy, error, context } of items) {
    if (error !== undefined || !ex) {
      const err = error as Error;
      if (isTransient(err)) {
        pending++;
        delayed++;
        console.error(`update ${raw.update_id}: transient ${err?.name}; retried next run`);
        continue;
      }
      console.error(`update ${raw.update_id}: extraction failed (${err?.name})`);
      out.push({ ...base, extraction_status: "failed", note: `extraction failed: ${err?.name}` });
      replaced.add(msg.key);
      entry.pending!.push("could not be processed; kept for a closer read");
      deep.push(deepEntry(d.now, { ...raw, subject_id: subject.id }, msg, base.transcript, ["extraction_failed"], null));
      entry.deep = "extraction_failed";
      entries.push(entry);
      continue;
    }

    base.extracted_by = extractedBy!;
    base.confidence = ex.confidence;
    // Only a message attributed to its sender by default is checked: a prefix or an override is explicit.
    const hint = subject.source === "sender" ? ex.subjectHint ?? usualSubject(history, raw.person_id, nameOf) : null;
    base.subject_hint = hint;
    out.push(base, ...recordRows(msg.key, subject.id, ex, extractedBy!, d.now), ...contextRows(msg.key, raw.person_id, context ?? [], mode, extractedBy!, d.now));
    replaced.add(msg.key);
    ctx.signals += context?.length ?? 0;
    if (mode === "shadow" && context?.length)
      entry.context = context.map((c) => `${nameOf(c.subject)}: ${c.category.replace(/_/g, " ")}${c.intensity ? `, ${c.intensity}` : ""}: ${c.summary}${c.confidence === "low" ? " (low confidence)" : ""}`);
    entry.readings = [...ex.readings, ...(ex.reportReadings ?? [])];
    entry.symptoms = ex.symptoms;
    if (ex.report) {
      const n = ex.report.items.filter((i) => i.section === "result").length;
      const text = ex.report.items.filter((i) => i.section !== "result").map((i) => i.section);
      entry.notes = [`${ex.report.type} report: ${n} value(s)${text.length ? ` + ${text.join(" and ")}` : ""} recorded${ex.report.sampleAt ? ` (sample ${ex.report.sampleAt.slice(0, 10)})` : " (no sample date printed)"}`];
    }

    // Questions for the admin and work for the offline Opus agent (needs_deep). Never ask anyone to retype values.
    const reasons: string[] = [];
    const nothing = !ex.readings.length && !ex.symptoms.length;
    const media = msg.kind === "image" || msg.kind === "document";
    if (media && ex.mediaKind) base.image_class = IMAGE_CLASS[ex.mediaKind];
    const docKind = ex.mediaKind && ["prescription", "report", "medicine"].includes(ex.mediaKind) ? ex.mediaKind : null;
    if (msg.kind === "document") reasons.push("document");
    if (docKind) reasons.push(docKind);
    if (ex.unreadableReason && (media || msg.kind === "audio")) {
      // Health content that could not be read: a question only when the class says it IS health (non_health never
      // gets here: parseExtraction drops it). Unknown class: queued for the deep read, no question.
      reasons.push("unreadable");
      if (msg.kind === "audio") entry.questions.push("voice note could not be understood; kept for a closer read. Reply if you know what it says.");
      else if (ex.mediaKind && HEALTH_MEDIA_KINDS.includes(ex.mediaKind))
        entry.questions.push(`${IMAGE_CLASS[ex.mediaKind].replace("-", " ")} ${msg.kind === "document" ? "document" : "photo"} could not be read; kept for a closer read. Reply if you know what it shows.`);
      else entry.pending!.push("unclear content; kept for a closer read");
    }
    if (ex.outOfRange.length || ex.rejected.length) {
      reasons.push("rejected_values");
      const what = ex.outOfRange.map((o) => (o.type === "bp" ? `BP ${o.value}` : readingEn({ type: o.type, value: o.value, value2: null, value3: null, unit: "", measuredAt: msg.ts }))).join(", ");
      entry.questions.push(`${what ? `"${what}"` : "a value"} looks implausible and was not recorded; kept for a closer read. Reply if you know the right value.`);
    }
    if (hint) {
      // Records stay with the sender (never auto-reassigned); a human checks who the message is about (admin: /for <name>).
      reasons.push("subject_hint");
      entry.questions.push(`may be about "${hint.slice(0, 40)}" but is logged for the sender (${entry.person}). Who is it for?`);
    }
    if (!nothing && ex.confidence < LOW_CONFIDENCE) {
      reasons.push("low_confidence");
      entry.questions.push("read with low confidence; check the values above.");
    }
    if (reasons.length) {
      deep.push(deepEntry(d.now, { ...raw, subject_id: subject.id }, msg, base.transcript, [...new Set(reasons)], ex));
      entry.deep = docKind ?? (msg.kind === "document" ? "document" : reasons[0]);
    }

    // Red-flag rules: digest annotations only (ADR 005).
    const weights = [...history, ...out]
      .filter((r) => r.rt === "d1.readings" && r.type === "weight" && r.person_id === subject.id && r.source_message_id !== msg.key && r.confirmed !== -1)
      .map((r) => ({ type: "weight", value: r.value, value2: null, value3: null, unit: "kg", measuredAt: r.measured_at }) as Reading)
      .filter((r) => Date.parse(r.measuredAt) >= Date.parse(msg.ts) - 8 * DAY);
    entry.annotations = evaluate({ readings: [...ex.readings, ...(ex.reportReadings ?? [])], symptoms: ex.symptoms, weightHistory: weights, thresholds: d.thresholds, timeZone: tz });
    if (entry.readings.length || ex.symptoms.length || entry.questions.length || entry.deep || entry.context?.length || entry.notes?.length) entries.push(entry);
  }

  const changed = out.length ? d.repo.writeKb(out, replaced) : [];
  const queued = d.repo.enqueueDeep(deep);
  // Log this run's entries (and an empty one for each processed message with nothing to show), then build the digest
  // from everything recorded since the last delivered digest: a skipped or failed run's items are not lost.
  const seenKeys = new Set(entries.map((e) => e.key));
  d.repo.logDigestEntries([
    ...entries.map((e) => ({ key: e.key!, recorded_at: d.now, entry: e })),
    ...[...replaced].filter((k) => !seenKeys.has(k)).map((k) => ({ key: k, recorded_at: d.now, entry: null })),
  ]);
  const digest = buildDigest({ entries: d.repo.undeliveredDigestEntries(), pending: pending - delayed, now: d.now, timeZone: tz, thresholdsStatus: d.thresholds.status,
    contextSkipped: mode === "shadow" ? ctx.skippedCap : 0 });
  const ops = [...(d.warnings ?? []), ...(delayed ? [DELAYED_OPS(delayed)] : [])];
  return { extracted: replaced.size, pending, delayed, sttPending, queued, changed, digest, ops, context: ctx };
}

async function transcribe(stt: SpeechToText, d: ExtractDeps, media: Media, durationSec: number): Promise<Transcript> {
  if (durationSec <= SARVAM_REST_MAX_SEC) return stt.transcribe(media);
  const job = await stt.startBatch(media);
  const end = Date.now() + (d.sttTimeoutMs ?? 15 * 60_000);
  for (;;) {
    const t = await stt.pollBatch(job);
    if (t) return t;
    if (Date.now() > end) throw Object.assign(new Error("stt batch timeout"), { name: "TimeoutError" });
    await new Promise((r) => setTimeout(r, d.sttPollMs ?? 10_000));
  }
}

/** A sender who usually logs for someone else (2+ earlier messages, most of them about one other member): that
 *  member's name, so an unprefixed message from them is checked. Deterministic; a hint for review only. */
export function usualSubject(history: Row[], sender: string, nameOf: (id: string) => string): string | null {
  const counts = new Map<string, number>();
  for (const r of history)
    if (r.rt === "d1.messages" && r.sender_person_id === sender) counts.set(r.person_id as string, (counts.get(r.person_id as string) ?? 0) + 1);
  const self = counts.get(sender) ?? 0;
  counts.delete(sender);
  const [top, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  return top && n >= 2 && n > self ? nameOf(top) : null;
}

function recordRows(messageId: string, personId: string, ex: Extraction, by: string, at: string): Row[] {
  const common = { person_id: personId, source_message_id: messageId, confidence: ex.confidence, confirmed: 0, extracted_by: by, extracted_at: at };
  const json = (v: unknown) => JSON.stringify(v);
  return [
    ...ex.readings.map((r, i) => ({
      rt: "d1.readings", id: `${messageId}:r${i}`, type: r.type, value: r.value, value2: r.value2, value3: r.value3, unit: r.unit,
      measured_at: r.measuredAt, source_value: r.sourceValue ?? null, source_unit: r.sourceUnit ?? null, ...common,
    })),
    // A report's printed values, ranges, flags, findings and impression (tools/kb/build -> observation facts at the
    // sample time, tagged document). Report meta (facility, doctors, dates) also stays in the message's extraction_json.
    ...(ex.report?.items ?? []).map((it, i) => ({
      rt: "d1.report_items", id: `${messageId}:i${i}`, section: it.section, name: it.name, value_num: it.valueNum, value_text: it.valueText,
      unit: it.unit, ref_range: it.refRange, flag: it.flag, panel: it.panel, report_type: ex.report!.type, sample_at: ex.report!.sampleAt,
      reported_at: ex.report!.reportedAt, facility: ex.report!.facility, doctors: json(ex.report!.doctors), ...common,
    })),
    ...ex.symptoms.map((s: Symptom, i) => ({
      rt: "d1.symptoms", id: `${messageId}:s${i}`, symptom_type: s.symptomType, location: s.location, side: s.side,
      character: json(s.character), severity: s.severity, duration_min: s.durationMin, at_rest: s.atRest === null ? null : s.atRest ? 1 : 0,
      associated: json(s.associated), triggers: json(s.triggers), free_text: s.freeText, observed_at: s.observedAt, ...common,
    })),
  ];
}

/** d1.context rows (ADR 010), mapped by tools/kb/build to event facts with data.type context. No quote, no message text. */
function contextRows(messageId: string, sender: string, signals: ContextSignal[], mode: ContextMode, by: string, at: string): Row[] {
  return signals.map((c, i) => ({
    rt: "d1.context", id: `${messageId}:c${i}`, source_message_id: messageId, person_id: c.subject, sender_person_id: sender,
    category: c.category, summary: c.summary, intensity: c.intensity, confidence: c.confidence, start: c.start, end: c.end,
    mode, extracted_by: by, extracted_at: at,
  }));
}

function deepEntry(now: string, raw: RawRow, msg: ParsedMessage, transcript: string | null, reasons: string[], ex: Extraction | null) {
  return {
    id: `deep:${msg.key}`, status: "open", created_at: now, person_id: raw.subject_id ?? raw.person_id, sender_person_id: raw.person_id, message_id: msg.key, update_id: raw.update_id,
    kind: msg.kind, received_at: msg.ts, reasons, media_path: raw.media_path, text: msg.text?.slice(0, 500) ?? null, transcript,
    haiku: ex && { confidence: ex.confidence, media_kind: ex.mediaKind, unreadable_reason: ex.unreadableReason, subject_hint: ex.subjectHint, rejected: ex.rejected.slice(0, 5) },
  };
}

const snippet = (t?: string) => (t ? (t.length > 40 ? `${t.slice(0, 40)}…` : t) : "");

// ---------------------------------------------------------------- finish

export interface FinishDeps {
  store: Store;
  tg: TelegramAdapter;
  repo: Repo;
  now: string;
  /** The digest text, or null when the run was not fully successful (pull/extract failed or delayed, KB build or
   *  commit failed): then no digest, and the admins get DIGEST_FAILED in the ops DM. */
  digest: string | null;
  retentionDays: number;
  /** false: mark and prune only (manual re-runs). */
  send?: boolean;
  /** Send even if today's digest (IST day, data/telegram/digests.jsonl) was already sent (dispatch input force_digest). */
  force?: boolean;
  /** Operator alerts (e.g. the webhook assertion) and extract ops lines: the separate short admin ops DM, ⚠ lines. */
  alerts?: string[];
}

export const DIGEST_FAILED = `${PRODUCT_NAME}: today's run did not complete. All messages are kept; the next run retries. See the batch workflow log.`;

/** Groups are input-only (ADR 011): everything goes to the admins by private DM (chat id = their Telegram user id;
 *  the admin must have started a private chat with the bot). With no admin reachable nothing is posted anywhere: the
 *  workflow log carries a warning (and the run fails for webhook alerts). Never to a group chat. */
export async function finish(d: FinishDeps): Promise<{ done: number; pruned: number; sentTo: number; opsTo: number; skipped: boolean }> {
  // Only rows that are in git (the raw files of this checkout, which the workflow has pushed) are marked done.
  // Last ~2 months only, to keep the statement small; older rows were marked by earlier runs.
  const since = Date.parse(d.now) - 62 * DAY;
  // Rows not processed yet (extraction delayed, media missing) stay 'new', so they are never pruned before they are.
  const open = unprocessedUpdateIds(d.repo);
  const ids = d.repo.rawRows().filter((r) => Date.parse(r.received_at) >= since && !open.has(r.update_id)).map((r) => r.update_id);
  // One D1 call for the whole finish (mark, prune, the persons to DM). Pruning first is safe: it only removes rows
  // marked done more than retentionDays ago.
  const pruneBefore = new Date(Date.parse(d.now) - d.retentionDays * DAY).toISOString();
  const { done, pruned, persons } = await d.store.finishSnapshot(ids, d.now, pruneBefore);
  let sentTo = 0;
  let opsTo = 0;
  let skipped = false;
  if (d.send !== false) {
    const admins = persons.filter((p) => p.role === "admin");
    const dm = async (text: string): Promise<{ n: number; ids: number[] }> => {
      let n = 0;
      const ids: number[] = [];
      for (const a of admins) {
        try {
          for (const part of splitMessage(text)) {
            const id = await d.tg.sendText(a.senderId, part);
            if (typeof id === "number") ids.push(id);
          }
          n++;
        } catch (err) {
          console.error(`DM to an admin failed: ${(err as Error).name}`); // no ids or content in the log
        }
      }
      return { n, ids };
    };
    // 1. Ops DM (short, actionable only): digest failure, delays, warnings, webhook alerts.
    const ops = [...(d.digest === null ? [DIGEST_FAILED] : []), ...(d.alerts ?? [])].map((a) => `⚠ ${a}`);
    if (ops.length) {
      opsTo = (await dm(ops.join("\n\n"))).n;
      if (!opsTo) console.log("::warning::no admin reachable by DM; the ops notice was not delivered (see this log)");
    }
    // 2. The digest: fully successful runs only (digest !== null), at most once per IST day unless forced.
    const day = dayOf(d.now);
    skipped = d.digest !== null && !d.force && d.repo.digestsSent().some((r) => r.date === day);
    if (d.digest !== null && !skipped) {
      const r = await dm(d.digest);
      sentTo = r.n;
      // Logged even after a partial send, so a re-run does not send a second digest the same day.
      if (r.n || r.ids.length) d.repo.logDigest({ date: day, message_ids: r.ids, sent_at: d.now, forced: !!d.force, through: d.now });
      else console.log("::warning::no admin reachable by DM; the digest was not delivered");
    }
  }
  return { done, pruned, sentTo, opsTo, skipped };
}

/** Telegram caps a message at 4096 characters. Split on line boundaries. */
export function splitMessage(text: string, max = 4000): string[] {
  const parts: string[] = [];
  let cur = "";
  for (const l of text.split("\n")) {
    if (cur && cur.length + l.length + 1 > max) {
      parts.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n${l}` : l.slice(0, max);
  }
  if (cur) parts.push(cur);
  return parts;
}
