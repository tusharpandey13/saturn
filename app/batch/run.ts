// Daily batch entrypoint (ADR 005), run by deploy/batch.sh (called from the env repo's thin workflow) under Node:
//   npx tsx batch/run.ts pull                      D1 inbox + media -> data/telegram/raw/, sources/
//   npx tsx batch/run.ts extract [--retry-failed]  raw -> STT / Haiku (claude -p) -> data/telegram/*.ndjson, queue, digest file
//                                                  (+ <digest>.ops: actionable ops lines, e.g. token expiry, delays)
//                                                  exit 3 when extraction was delayed (auth, usage limit, outage);
//                                                  the digest file is written only when nothing was delayed
//   npx tsx batch/run.ts finish [--no-digest] [--force-digest]
//                                                  mark inbox rows done, assert the webhook, DM the digest to the admins
//                                                  (once per IST day, logged in data/telegram/digests.jsonl; --force-digest
//                                                  sends again), DM ops lines separately, prune. No digest file = failed/
//                                                  delayed run: ops DM only. Never posts to a group chat (ADR 011).
//                                                  exit 1 when the webhook assertion fails (⚠ lines DM'd to the admins)
//   pull and finish exit 3 ("delayed") when Cloudflare stays rate limited (429) or unavailable after the retries.
// Options: --records DIR (records repo root, holds records.yaml and optional config/thresholds.yaml; --root is the old name), --digest FILE (default
//          $DIGEST_FILE, else $RUNNER_TEMP or app/.batch/digest.txt), --now ISO.
// Env: pull/finish CLOUDFLARE_D1_TOKEN (fallback CLOUDFLARE_API_TOKEN), CLOUDFLARE_R2_TOKEN (optional), CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID, R2_BUCKET, TELEGRAM_BOT_TOKEN;
//      extract CLAUDE_CODE_OAUTH_TOKEN (or a local `claude` login; ANTHROPIC_API_KEY, if set, takes precedence in the CLI),
//      CLAUDE_TOKEN_CREATED (YYYY-MM-DD, expiry warning), CLAUDE_BIN (default claude),
//      STT_ADAPTER (whisper-cpp | sarvam | none; default: sarvam when SARVAM_API_KEY is set, else none),
//      whisper-cpp: WHISPER_BIN (default whisper-cli), WHISPER_MODEL (ggml model path, required), FFMPEG_BIN,
//      STT_MAX_AUDIO_MIN (audio minutes per run, default 30), STT_MAX_RUNTIME_MIN (STT wall minutes per run, default 20);
//      SARVAM_API_KEY (sarvam adapter), EXTRACT_MODEL_TRANSCRIPT (voice transcripts; default claude-sonnet-5-5),
//      CONTEXT_MODE (off default | shadow | on; ADR 010 life-context signals),
//      EXTRACT_MODEL_TEXT (default claude-haiku-5-5), EXTRACT_MODEL_MEDIA (photos/PDFs; default claude-sonnet-5-5),
//      EXTRACT_MAX_MEDIA_CALLS (usage guard per run, default 30);
//      finish INBOX_RETENTION_DAYS (default 14), GO_LIVE (true after the GO-LIVE GATE), WORKER_URL (webhook assertion). Local e2e only: CLOUDFLARE_API_BASE, TELEGRAM_API_BASE.
// Output is counts only: no message content reaches the Actions log.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CloudflareTransientError, cloudflareFromEnv, d1Http, r2Http } from "../src/batch/cloudflare.js";
import { Repo } from "../src/batch/repo.js";
import { extract, finish, pull } from "../src/batch/steps.js";
import { checkWebhook } from "../src/batch/webhook.js";
import { TelegramAdapter } from "../src/channel/telegram.js";
import { ClaudeCliExtractor, tokenExpiryWarning } from "../../adapters/llm/claude-cli.js";
import { Store } from "../src/store.js";
import { parseVocab, SarvamSpeechToText } from "../../adapters/stt/sarvam.js";
import { WhisperCppSpeechToText } from "../../adapters/stt/whisper-cpp.js";
import { loadRecords } from "../src/batch/records.js";
import type { Person } from "../src/types.js";
import { aliasesFromRecords } from "../src/subject.js";
import { parseContextMode } from "../src/extract/context.js";

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const recordsArg = opt("--records") ?? opt("--root") ?? process.env.RECORDS_DIR;
if (!recordsArg) {
  console.error("usage: batch/run.ts pull|extract|finish --records DIR  (or RECORDS_DIR)");
  process.exit(2);
}
const root = resolve(recordsArg);
const records = loadRecords(root);
const digestPath = opt("--digest") ?? process.env.DIGEST_FILE ?? join(process.env.RUNNER_TEMP ?? join(import.meta.dirname, "..", ".batch"), "digest.txt");
const opsPath = `${digestPath}.ops`;
const now = opt("--now") ?? new Date().toISOString();
const repo = new Repo(root, records.d1PersonMap);
const aliases = aliasesFromRecords(records.aliases, records.display, records.d1PersonMap);
const need = (k: string) => process.env[k] || (() => { throw new Error(`missing env: ${k}`); })();

async function main(cmd: string | undefined) {
  if (cmd === "pull") {
    const cf = cloudflareFromEnv();
    const r = await pull({ store: new Store(d1Http(cf)), r2: r2Http(cf), tg: new TelegramAdapter(need("TELEGRAM_BOT_TOKEN"), undefined, process.env.TELEGRAM_API_BASE || undefined), repo, aliases });
    console.log(`pull: ${r.pulled} new inbox rows; media copied ${r.mediaCopied}, missing ${r.mediaMissing}; aliases synced ${aliases.length}; new subject overrides ${r.overrides}; changed ${r.changed.join(", ") || "nothing"}`);
  } else if (cmd === "extract") {
    const persons = new Map<string, Person>();
    const dir = join(root, "data", "telegram", "directory.ndjson");
    if (existsSync(dir))
      for (const l of readFileSync(dir, "utf8").split("\n").filter(Boolean)) {
        const p = JSON.parse(l);
        if (p.rt === "d1.persons") persons.set(p.id, { id: p.id, name: p.name, role: p.role, senderId: p.sender_id });
      }
    const env = process.env;
    const warnings: string[] = [];
    if (!env.ANTHROPIC_API_KEY) {
      const w = tokenExpiryWarning(env.CLAUDE_TOKEN_CREATED, now);
      if (w) warnings.push(w);
      if (env.CLAUDE_CODE_OAUTH_TOKEN && !env.CLAUDE_TOKEN_CREATED) console.log("::warning::CLAUDE_TOKEN_CREATED is not set; no token-expiry warning to the admins");
    }
    const sttAdapter = env.STT_ADAPTER || (env.SARVAM_API_KEY ? "sarvam" : "none");
    const whisper = sttAdapter === "whisper-cpp" && env.WHISPER_MODEL && existsSync(env.WHISPER_MODEL)
      ? new WhisperCppSpeechToText({ bin: env.WHISPER_BIN || undefined, model: env.WHISPER_MODEL, ffmpeg: env.FFMPEG_BIN || undefined }) : null;
    const stt = whisper ?? (sttAdapter === "sarvam" && env.SARVAM_API_KEY ? new SarvamSpeechToText(env.SARVAM_API_KEY, undefined, undefined, parseVocab(records.sttVocab ?? "")) : null);
    if (sttAdapter === "whisper-cpp" && !whisper) console.log("::warning::extract: STT_ADAPTER whisper-cpp but WHISPER_MODEL is missing; voice notes stay stt_pending");
    if (!stt) console.log(`extract: no STT (${sttAdapter}); voice notes are stored as stt_pending`);
    const minutes = (v: string | undefined, dflt: number) => (Number(v) > 0 ? Number(v) : dflt);
    if (records.thresholds.status === "disabled") console.log("extract: rule annotations off (records config/thresholds.yaml not configured)");
    // Life context (ADR 010): env context_mode -> CONTEXT_MODE; consent from records.yaml context_consent (true only).
    const contextMode = parseContextMode(env.CONTEXT_MODE);
    const contextConsented = new Set(Object.entries(records.contextConsent).filter(([, v]) => v === "true").map(([ns]) => repo.d1Id(ns)));
    const maxMedia = Number(env.EXTRACT_MAX_MEDIA_CALLS);
    const extractor = new ClaudeCliExtractor({
      bin: env.CLAUDE_BIN || "claude", context: records.extractionContext, textModel: env.EXTRACT_MODEL_TEXT || undefined,
      mediaModel: env.EXTRACT_MODEL_MEDIA || undefined, transcriptModel: env.EXTRACT_MODEL_TRANSCRIPT || undefined, maxMediaCalls: Number.isInteger(maxMedia) && maxMedia > 0 ? maxMedia : undefined,
    });
    console.log(`extract: models text ${extractor.model}, photo/PDF ${extractor.mediaModel}, voice transcript ${extractor.transcriptModel}; stt ${stt ? sttAdapter : "none"}`);
    const r = await extract({
      repo, persons, now, thresholds: records.thresholds, warnings, aliases, contextMode, contextConsented,
      extractor,
      stt,
      sttMaxAudioSec: minutes(env.STT_MAX_AUDIO_MIN, 30) * 60,
      sttDeadline: Date.now() + minutes(env.STT_MAX_RUNTIME_MIN, 20) * 60_000,
      retryFailed: args.includes("--retry-failed"),
    });
    // A delayed run writes no digest: finish then sends the ops DM only; the next full run sends the digest.
    rmSync(digestPath, { force: true });
    rmSync(opsPath, { force: true });
    mkdirSync(dirname(digestPath), { recursive: true });
    if (!r.delayed) writeFileSync(digestPath, r.digest);
    if (r.ops.length) writeFileSync(opsPath, r.ops.join("\n"));
    console.log(`extract: ${r.extracted} messages; pending ${r.pending} (delayed ${r.delayed}); stt_pending ${r.sttPending}; queued for deep read ${r.queued}; changed ${r.changed.join(", ") || "nothing"}`);
    for (const [m, u] of Object.entries(extractor.usage))
      console.log(`usage ${m}: ${u.calls} call(s), ${u.inputTokens} input / ${u.outputTokens} output tokens, ~$${u.costUsd.toFixed(3)} API-equivalent`);
    for (const w of whisper?.runs ?? [])
      console.log(`stt whisper-cpp: audio ${w.audioSec} s, wall ${w.elapsedSec} s (x${w.audioSec ? (w.elapsedSec / w.audioSec).toFixed(2) : "?"} realtime), attempts ${w.attempts}, accepted ${w.accepted}, language ${w.language ?? "?"}`);
    console.log(`voice: ${r.voice.notes} note(s) transcribed, audio ${Math.round(r.voice.audioSec)} s, wall ${Math.round(r.voice.elapsedSec)} s; rejected ${r.voice.rejected}; statements kept ${r.voice.statements}, dropped (not verbatim/invalid) ${r.voice.dropped}`);
    console.log(`context (${contextMode}; consented ${contextConsented.size}): read ${r.context.read}; signals ${r.context.signals}; dropped ${r.context.dropped}; skipped (daily cap) ${r.context.skippedCap}`);
    // The workflow commits and builds whenever the outputs were written, even when it fails the job for a delay.
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `completed=true\ndelayed=${r.delayed}\n`);
    if (r.delayed) {
      console.error(`extract: ${r.delayed} messages delayed (extraction service: auth, usage limit or outage); inbox rows stay new`);
      process.exitCode = 3;
    }
  } else if (cmd === "finish") {
    const cf = cloudflareFromEnv();
    const digest = existsSync(digestPath) ? readFileSync(digestPath, "utf8") : null;
    const send = !args.includes("--no-digest");
    const tg = new TelegramAdapter(need("TELEGRAM_BOT_TOKEN"), undefined, process.env.TELEGRAM_API_BASE || undefined);
    const live = process.env.GO_LIVE === "true";
    const alerts = await checkWebhook(tg, { live, workerUrl: process.env.WORKER_URL || undefined, now });
    const ops = existsSync(opsPath) ? readFileSync(opsPath, "utf8").split("\n").filter(Boolean) : [];
    const r = await finish({
      store: new Store(d1Http(cf)), tg, repo, now, digest, send, alerts: [...ops, ...alerts], force: args.includes("--force-digest"),
      retentionDays: Number(process.env.INBOX_RETENTION_DAYS || 14),
    });
    if (digest !== null) rmSync(digestPath); // contains PHI
    rmSync(opsPath, { force: true });
    const what = !send ? "not sent (--no-digest)" : digest === null ? "MISSING (failed or delayed run: ops DM to the admins only)"
      : r.skipped ? "skipped (today's digest was already sent; dispatch with force_digest to resend)" : "sent";
    console.log(`finish: marked done ${r.done}; digest ${what}; digest DM(s) ${r.sentTo}; ops DM(s) ${r.opsTo}; group posts 0; pruned ${r.pruned}`);
    console.log(`webhook: ${alerts.length ? "PROBLEM" : "ok"} (gate ${live ? "open" : "closed: no webhook expected"})`);
    for (const a of alerts) console.log(`::error::${a}`);
    if (alerts.length) process.exitCode = 1;
  } else {
    console.error("usage: batch/run.ts pull|extract|finish --records DIR [--digest FILE] [--now ISO] [--retry-failed] [--no-digest] [--force-digest]");
    process.exitCode = 2;
  }
}

main(args[0]).catch((err) => {
  if (err instanceof CloudflareTransientError) {
    // Rate limit (429), 5xx or network after the retries: nothing was marked; inbox rows stay new for the next run.
    console.log(`::warning::batch ${args[0]} delayed: ${err.message}; inbox rows stay new`);
    process.exitCode = 3;
    return;
  }
  console.error(`batch ${args[0]} failed: ${(err as Error).name}: ${(err as Error).message}`);
  process.exitCode = 1;
});
