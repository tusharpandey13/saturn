// The transcript file the batch writes next to a voice note: sources/<ns>/media/telegram/<audio-name>.transcript.md.
// Verbatim machine output (source language, timed segments), how it was made (engine, model, settings, attempts,
// timing) and a "needs a listener" banner. Never edited by the batch once a person has replaced it (Repo.writeTranscript).
// PHI: it lives under sources/ only; nothing from it reaches a log.

import type { Transcript } from "../types.js";
import { durationEn } from "../extract/voice.js";

const ts = (s: number) => {
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
};
const q = (v: string) => JSON.stringify(v);

export function renderTranscript(o: {
  t: Transcript; mediaPath: string; messageId: string; updateId: number; receivedAt: string; durationSec: number;
  sender: string; subject: string; now: string; audioSha256: string;
}): string {
  const m = o.t.meta!;
  const status = m.accepted ? "machine-transcript" : "rejected";
  const lines = [
    "---",
    "generator: saturn-batch",
    `status: ${status}`,
    "listened: false",
    `audio: ${q(o.mediaPath)}`,
    `audio_sha256: ${o.audioSha256}`,
    `message_id: ${q(o.messageId)}`,
    `update_id: ${o.updateId}`,
    `received_at: ${o.receivedAt}`,
    `duration_sec: ${Math.round(o.durationSec || m.audioSec)}`,
    `language: ${o.t.languageCode ?? "unknown"}`,
    `engine: ${q(m.engine)}`,
    `model: ${q(m.model)}`,
    `settings: ${q(m.settings)}`,
    `transcribed_at: ${o.now}`,
    `elapsed_sec: ${m.elapsedSec}`,
    `realtime_factor: ${m.audioSec ? (m.elapsedSec / m.audioSec).toFixed(2) : "n/a"}`,
    "attempts:",
    ...m.attempts.map((a) => `  - {language: ${a.language}, temperature: ${a.temperature}, detected: ${a.detected ?? "null"}, verdict: ${a.verdict}, elapsed_sec: ${a.elapsedSec}}`),
    "---",
    "",
    `# Voice note: ${o.subject}, ${o.receivedAt} (machine transcript)`,
    "",
    "> **Machine transcript — needs a listener.** Made by a speech-recognition model, not checked by a person. It has",
    "> recognition errors; the audio is the record. The text is the speech in its own language, verbatim; there is no",
    "> translation. Facts as written; not advice; doctors decide.",
    ...(m.accepted ? [] : [">", "> **REJECTED:** every attempt failed the loop/repetition post-check. Nothing was extracted from this text."]),
    ">",
    `> After listening, append one line to \`data/telegram/listened.ndjson\`:`,
    `> \`{"update_id": ${o.updateId}, "by": "<who>", "at": "YYYY-MM-DD", "note": "<optional>"}\``,
    "",
    `- Audio: \`${o.mediaPath}\` (${durationEn(o.durationSec || m.audioSec)})`,
    `- Sent by: ${o.sender}${o.sender !== o.subject ? `; logged for: ${o.subject}` : ""}`,
    `- Telegram message: ${o.messageId} (update ${o.updateId})`,
    "",
    "## Transcript (verbatim, timed)",
    "",
    ...(o.t.segments?.length ? o.t.segments.map((s) => `[${ts(s.start)} → ${ts(s.end)}] ${s.text}`) : ["(no speech recognised)"]),
    "",
  ];
  return lines.join("\n");
}
