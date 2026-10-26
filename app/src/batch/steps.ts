// Daily batch (ADR 005), three idempotent steps. The workflow commits between them:
//   pull     D1 inbox (status new) + media (R2, or Telegram by file_id) -> data/telegram/raw/ + sources/   [commit]
//   extract  raw rows not yet extracted -> STT (optional) / vitals parser / Haiku via claude -p -> data/telegram/*.ndjson,
//            needs_deep queue, digest text                                                               [build, commit]
//   finish   mark the committed and processed inbox rows done, send the digest, prune old done rows
// Re-running any step on the same input is safe: raw rows are keyed by update_id, extracted rows by message id
// (chat:message), the queue by message id, and inbox updates only touch rows still 'new'.

import { PRODUCT_NAME } from "../product.js";
import { parseUpdate, type ParsedMessage, type TelegramAdapter } from "../channel/telegram.js";
import type { Thresholds } from "../config/thresholds.js";
import { type ExtractInput, type Extractor, ExtractorStopError } from "../extract/adapter.js";
import { type Extraction, parseExtraction } from "../extract/schema.js";
import { readingHi } from "../replies.js";
import { evaluate } from "../rules/engine.js";
import type { Store } from "../store.js";
import { SARVAM_REST_MAX_SEC, SttJobFailedError } from "../../../adapters/stt/sarvam.js";
import type { Media, Person, Reading, SpeechToText, Symptom, Transcript } from "../types.js";
import { parseVitals } from "../vitals.js";
import { buildDigest, type DigestEntry, STT_PENDING_NOTE } from "./digest.js";
import { MIME_OF_EXT, type RawRow, Repo, type Row } from "./repo.js";

export const LOW_CONFIDENCE = 0.8; // same bar as v_needs_human in data/schema.sql
const DAY = 86_400_000;

// ---------------------------------------------------------------- pull

export interface PullDeps {
  store: Store;
  r2: { get(key: string): Promise<Media> };
  tg: TelegramAdapter;
  repo: Repo;
}

export async function pull(d: PullDeps): Promise<{ pulled: number; mediaCopied: number; mediaMissing: number; changed: string[] }> {
  const [rows, persons, chats] = [await d.store.newInbox(), await d.store.persons(), await d.store.chats()];
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
      role: role.get(r.person_id) ?? "caregiver", kind: r.kind, received_at: r.received_at, media_key: r.media_key,
      media_status: r.media_status, media_mime: ev?.type === "message" ? ev.msg.file?.mimeType ?? null : null,
      media_path: null, ack: r.ack, update,
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
  return { pulled: fresh.length, mediaCopied, mediaMissing, changed };
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
  thresholds: Thresholds;
  persons: Map<string, Person>;
  now: string;
  timeZone?: string;
  /** STT batch polling (long voice notes). */
  sttPollMs?: number;
  sttTimeoutMs?: number;
  /** Re-try messages whose extraction failed permanently before. */
  retryFailed?: boolean;
  /** Operator warnings for the digest (e.g. Claude token expiry). */
  warnings?: string[];
}

export interface ExtractResult {
  extracted: number;
  pending: number; // missing media + delayed: retried by the next run, inbox rows stay new
  delayed: number; // extraction/STT service failed (auth, usage limit, outage)
  sttPending: number; // voice notes stored without a transcript (no STT key)
  queued: number;
  changed: string[];
  digest: string;
}

/** A failure the next run may not repeat (network, auth, 429, 5xx, timeouts, CLI crash). */
export function isTransient(err: unknown): boolean {
  if (err instanceof ExtractorStopError || err instanceof SttJobFailedError) return false;
  const e = err as { status?: number; name?: string };
  if (typeof e?.status === "number")
    return [0, 401, 403, 408, 409, 429].includes(e.status) || e.status >= 500;
  return /Connection|Timeout|network/i.test(`${e?.name} ${(err as Error)?.message}`);
}

/** Latest version per message (edits share chat:message_id), patients only, kinds the extractor reads. */
function toExtract(repo: Repo, retryFailed: boolean, sttAvailable: boolean): { raw: RawRow; msg: ParsedMessage }[] {
  const latest = new Map<string, { raw: RawRow; msg: ParsedMessage }>();
  for (const raw of repo.rawRows()) {
    if (raw.role !== "patient" || raw.kind === "other") continue;
    const ev = parseUpdate(raw.update);
    if (ev?.type !== "message") continue;
    const prev = latest.get(ev.msg.key);
    const newer = !prev || ev.msg.editDate > prev.msg.editDate || (ev.msg.editDate === prev.msg.editDate && raw.update_id > prev.raw.update_id);
    if (newer) latest.set(ev.msg.key, { raw, msg: ev.msg });
  }
  const done = new Map(repo.kbRows().filter((r) => r.rt === "d1.messages").map((r) => [r.id as string, r]));
  return [...latest.values()]
    .filter(({ msg }) => {
      const prev = done.get(msg.key);
      if (!prev) return true;
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
  rt: string; id: string; person_id: string; chat_id: string; kind: string; media_ref: string | null; raw_text: string | null;
  received_at: string; external_id: string; edit_date: number; transcript: string | null; transcript_language: string | null;
  transcript_confidence: number | null; extraction_json: string | null; extracted_by: string | null; extracted_at: string;
  extraction_status: string; confidence: number | null;
};
interface Item {
  raw: RawRow;
  msg: ParsedMessage;
  entry: DigestEntry;
  base: Base;
  input?: ExtractInput;
  ex?: Extraction;
  extractedBy?: string;
  error?: unknown;
}

export async function extract(d: ExtractDeps): Promise<ExtractResult> {
  const tz = d.timeZone ?? "Asia/Kolkata";
  const todo = toExtract(d.repo, !!d.retryFailed, !!d.stt);
  const history = d.repo.kbRows();
  const out: Row[] = [];
  const replaced = new Set<string>();
  const deep: Record<string, unknown>[] = [];
  const entries: DigestEntry[] = [];
  const items: Item[] = [];
  let pending = 0;
  let delayed = 0;
  let sttPending = 0;

  // 1. Per message: skip/park what cannot be read, transcribe voice, take vitals-only texts from the deterministic parser.
  for (const { raw, msg } of todo) {
    const person = d.persons.get(raw.person_id) ?? { id: raw.person_id, name: raw.person_id, role: "patient", senderId: raw.sender_id };
    const entry: DigestEntry = { person: person.name, ts: msg.ts, snippet: snippet(msg.text), kind: msg.kind, questions: [], annotations: [], deep: null, readings: [], symptoms: [], notes: [] };
    const base: Base = {
      rt: "d1.messages", id: msg.key, person_id: raw.person_id, chat_id: msg.chatId, kind: msg.kind, media_ref: raw.media_key,
      raw_text: msg.text ?? null, received_at: msg.ts, external_id: `tg:${raw.update_id}`, edit_date: msg.editDate,
      transcript: null, transcript_language: null, transcript_confidence: null,
      extraction_json: null, extracted_by: null, extracted_at: d.now, extraction_status: "ok", confidence: null,
    };

    if (raw.media_key && raw.media_status === "too_big") {
      out.push({ ...base, extraction_status: "skipped", note: "file over 20 MB, not stored" });
      replaced.add(msg.key);
      entry.questions.push("फ़ाइल 20 MB से बड़ी थी, सेव नहीं हुई — कृपया छोटी फ़ाइल या फ़ोटो भेजें");
      entries.push(entry);
      continue;
    }
    if (raw.media_key && !raw.media_path) {
      pending++; // media not copied yet: the next pull retries it
      continue;
    }

    const item: Item = { raw, msg, entry, base };
    items.push(item);
    try {
      let transcript: Transcript | null = null;
      const media = raw.media_path ? { data: d.repo.readMedia(raw.media_path), mimeType: raw.media_mime ?? MIME_OF_EXT[raw.media_path.split(".").pop()!] ?? "application/octet-stream" } : undefined;
      if (msg.kind === "audio" && media) {
        if (!d.stt) {
          // Stored (raw + media are in git); transcribed by the first run that has an STT key.
          out.push({ ...base, extraction_status: "stt_pending", note: "voice note stored; transcription pending (no STT key)" });
          replaced.add(msg.key);
          entry.notes!.push(STT_PENDING_NOTE);
          entries.push(entry);
          items.pop();
          sttPending++;
          continue;
        }
        transcript = await transcribe(d.stt, d, media, msg.durationSec ?? 0);
        Object.assign(base, { transcript: transcript.text, transcript_language: transcript.languageCode ?? null, transcript_confidence: transcript.languageProbability ?? null });
      }
      const text = transcript?.text ?? msg.text;
      const vit = msg.kind === "text" ? parseVitals(text, msg.ts) : null;
      if (vit?.complete && vit.plausible) {
        // Exactly what the Worker echoed to the patient; no LLM call.
        item.ex = { readings: vit.readings, symptoms: [], confidence: 1, mediaKind: null, unreadableReason: null, rejected: [], outOfRange: [] };
        item.extractedBy = "vitals-parser";
      } else {
        item.input = { text, media: msg.kind === "audio" ? undefined : media, now: msg.ts, replyTo: msg.replyToText };
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
    it.extractedBy = d.extractor.model ?? "llm";
  });

  // 3. Records, questions, deep-read queue, annotations.
  for (const { raw, msg, entry, base, ex, extractedBy, error } of items) {
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
      entry.questions.push("यह संदेश प्रोसेस नहीं हो पाया — कृपया दोबारा भेजें या लिखकर भेजें");
      deep.push(deepEntry(d.now, raw, msg, base.transcript, ["extraction_failed"], null));
      entry.deep = "extraction_failed";
      entries.push(entry);
      continue;
    }

    base.extracted_by = extractedBy!;
    base.confidence = ex.confidence;
    out.push(base, ...recordRows(msg.key, raw.person_id, ex, extractedBy!, d.now));
    replaced.add(msg.key);
    entry.readings = ex.readings;
    entry.symptoms = ex.symptoms;

    // Questions for the family (❓) and work for the offline Opus agent (needs_deep).
    const reasons: string[] = [];
    const nothing = !ex.readings.length && !ex.symptoms.length;
    const docKind = ex.mediaKind && ["prescription", "report", "medicine"].includes(ex.mediaKind) ? ex.mediaKind : null;
    if (msg.kind === "document") reasons.push("document");
    if (docKind) reasons.push(docKind);
    if (ex.unreadableReason && !docKind) {
      reasons.push("unreadable");
      entry.questions.push(msg.kind === "audio" ? "आवाज़ संदेश समझ नहीं आया — कृपया लिखकर भेजें" : "फ़ोटो साफ़ नहीं पढ़ी गई — कृपया संख्या लिखकर भेजें");
    }
    if (ex.outOfRange.length || ex.rejected.length) {
      reasons.push("rejected_values");
      const what = ex.outOfRange.map((o) => (o.type === "bp" ? `BP ${o.value}` : readingHi({ type: o.type, value: o.value, value2: null, value3: null, unit: "", measuredAt: msg.ts }))).join(", ");
      entry.questions.push(`${what ? `"${what}"` : "एक संख्या"} सही नहीं लगती — कृपया दोबारा जाँचकर लिखें`);
    }
    if (!nothing && ex.confidence < LOW_CONFIDENCE) {
      reasons.push("low_confidence");
      entry.questions.push("पक्का नहीं पढ़ पाया — कृपया ऊपर लिखी संख्याएँ जाँचें");
    }
    if (reasons.length) {
      deep.push(deepEntry(d.now, raw, msg, base.transcript, [...new Set(reasons)], ex));
      entry.deep = docKind ?? (msg.kind === "document" ? "document" : reasons[0]);
    }

    // Red-flag rules: digest annotations only (ADR 005).
    const weights = [...history, ...out]
      .filter((r) => r.rt === "d1.readings" && r.type === "weight" && r.person_id === raw.person_id && r.source_message_id !== msg.key && r.confirmed !== -1)
      .map((r) => ({ type: "weight", value: r.value, value2: null, value3: null, unit: "kg", measuredAt: r.measured_at }) as Reading)
      .filter((r) => Date.parse(r.measuredAt) >= Date.parse(msg.ts) - 8 * DAY);
    entry.annotations = evaluate({ readings: ex.readings, symptoms: ex.symptoms, weightHistory: weights, thresholds: d.thresholds, timeZone: tz });
    if (ex.readings.length || ex.symptoms.length || entry.questions.length || entry.deep) entries.push(entry);
  }

  const changed = out.length ? d.repo.writeKb(out, replaced) : [];
  const queued = d.repo.enqueueDeep(deep);
  const digest = buildDigest({ entries, pending, delayed, warnings: d.warnings, now: d.now, timeZone: tz, thresholdsStatus: d.thresholds.status });
  return { extracted: replaced.size, pending, delayed, sttPending, queued, changed, digest };
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

function recordRows(messageId: string, personId: string, ex: Extraction, by: string, at: string): Row[] {
  const common = { person_id: personId, source_message_id: messageId, confidence: ex.confidence, confirmed: 0, extracted_by: by, extracted_at: at };
  const json = (v: unknown) => JSON.stringify(v);
  return [
    ...ex.readings.map((r, i) => ({
      rt: "d1.readings", id: `${messageId}:r${i}`, type: r.type, value: r.value, value2: r.value2, value3: r.value3, unit: r.unit,
      measured_at: r.measuredAt, source_value: r.sourceValue ?? null, source_unit: r.sourceUnit ?? null, ...common,
    })),
    ...ex.symptoms.map((s: Symptom, i) => ({
      rt: "d1.symptoms", id: `${messageId}:s${i}`, symptom_type: s.symptomType, location: s.location, side: s.side,
      character: json(s.character), severity: s.severity, duration_min: s.durationMin, at_rest: s.atRest === null ? null : s.atRest ? 1 : 0,
      associated: json(s.associated), triggers: json(s.triggers), free_text: s.freeText, observed_at: s.observedAt, ...common,
    })),
  ];
}

function deepEntry(now: string, raw: RawRow, msg: ParsedMessage, transcript: string | null, reasons: string[], ex: Extraction | null) {
  return {
    id: `deep:${msg.key}`, status: "open", created_at: now, person_id: raw.person_id, message_id: msg.key, update_id: raw.update_id,
    kind: msg.kind, received_at: msg.ts, reasons, media_path: raw.media_path, text: msg.text?.slice(0, 500) ?? null, transcript,
    haiku: ex && { confidence: ex.confidence, media_kind: ex.mediaKind, unreadable_reason: ex.unreadableReason, rejected: ex.rejected.slice(0, 5) },
  };
}

const snippet = (t?: string) => (t ? (t.length > 40 ? `${t.slice(0, 40)}…` : t) : "");

// ---------------------------------------------------------------- finish

export interface FinishDeps {
  store: Store;
  tg: TelegramAdapter;
  repo: Repo;
  now: string;
  digest: string | null;
  retentionDays: number;
  /** false: mark and prune only (manual re-runs). */
  send?: boolean;
  /** Operator alerts (e.g. the webhook assertion), appended to the digest as ⚠ lines. */
  alerts?: string[];
}

export const DIGEST_FAILED = `⚠ ${PRODUCT_NAME}: आज की प्रोसेसिंग पूरी नहीं हुई। सभी संदेश सुरक्षित हैं; कल दोबारा कोशिश होगी।`;

export async function finish(d: FinishDeps): Promise<{ done: number; pruned: number; sentTo: number }> {
  // Only rows that are in git (the raw files of this checkout, which the workflow has pushed) are marked done.
  // Last ~2 months only, to keep the statement small; older rows were marked by earlier runs.
  const since = Date.parse(d.now) - 62 * DAY;
  // Rows not processed yet (extraction delayed, media missing) stay 'new', so they are never pruned before they are.
  const open = unprocessedUpdateIds(d.repo);
  const ids = d.repo.rawRows().filter((r) => Date.parse(r.received_at) >= since && !open.has(r.update_id)).map((r) => r.update_id);
  const done = await d.store.markDone(ids, d.now);
  const family = d.send === false ? [] : (await d.store.chats()).filter((c) => c.label === "family");
  const text = [d.digest ?? DIGEST_FAILED, ...(d.alerts ?? []).map((a) => `\n⚠ ${a}`)].join("\n");
  for (const c of family) for (const part of splitMessage(text)) await d.tg.sendText(c.chat_id, part);
  const pruned = await d.store.prune(new Date(Date.parse(d.now) - d.retentionDays * DAY).toISOString());
  return { done, pruned, sentTo: family.length };
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
