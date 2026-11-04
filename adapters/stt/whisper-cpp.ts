// Local speech-to-text with whisper.cpp (`whisper-cli`), run on the batch runner. No network, no keys.
//
// Pinned build and model (env workflow builds/caches them; deploy/github/batch.yml):
//   whisper.cpp v1.9.5 (commit d1be6fde11ac6e0407606b4e42fe72d34add8037), CPU build, static
//   model ggml-large-v3-turbo-q5_0.bin, sha256 394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2
// Audio: ffmpeg -> 16 kHz mono PCM WAV (Telegram voice notes are OGG/Opus).
//
// Loop protection (Whisper repeats itself when it conditions on its own earlier text):
//   --max-context 0          no previous-text conditioning (= condition_on_previous_text False)
//   --entropy-thold 2.4      a segment whose tokens are too repetitive (low entropy) is re-decoded at a higher temperature
//   --logprob-thold -1.0     ... and one with a low average log-probability
//   --temperature T, --temperature-inc 0.2   whisper.cpp's own per-segment temperature fallback
//   post-check (repetitionVerdict): repeated segments, word runs and duplicate 4-grams reject the whole output; the
//   adapter then retries with a higher starting temperature, then with the other language setting.
// Language: `-l hi` first (Hindi detected on every test clip; Devanagari output), auto-detect as the fallback, or first
// when a quick detection pass is confident the speech is something else (forcing hi on non-Hindi speech would turn
// the transcriber into a translator).
// NEVER a translation pass: the argument list never contains --translate (asserted in buildArgs and in the tests).
// The source-language transcript is the primary record; extraction reads it as is.
// Children get a minimal environment (PATH, HOME, TMPDIR, locale): no tokens or keys from the batch env.
// Never log transcript text: logs carry counts, durations and verdicts only.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import type { Media, SpeechToText, Transcript, TranscriptAttempt, TranscriptSegment } from "../../app/src/types.js";

export const WHISPER_VERSION = "v1.9.5";
export const WHISPER_COMMIT = "d1be6fde11ac6e0407606b4e42fe72d34add8037";
export const WHISPER_MODEL_NAME = "ggml-large-v3-turbo-q5_0";
export const WHISPER_MODEL_SHA256 = "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2";

/** Decoding settings (whisper-cli flags) shared by every attempt; language and temperature vary per attempt. */
export const DECODE = { maxContext: 0, entropyThold: 2.4, logprobThold: -1.0, noSpeechThold: 0.6, temperatureInc: 0.2, beamSize: 5, bestOf: 5 };
/** Starting temperatures per language setting: greedy first, then a warmer start if the post-check rejects it. */
export const TEMPERATURES = [0.0, 0.4];
/** A detection pass this confident that the speech is not Hindi/Urdu starts with auto-detect instead of `-l hi`. */
export const DETECT_CONFIDENT = 0.8;
/** Character budget of the initial prompt (`--prompt`): about 180 tokens, whisper's decoder context for a prompt. */
export const PROMPT_CHARS = 700;

/** Initial prompt from the records key-term list (eval/stt-terms.txt: one term per line, `#` comments): the terms in
 *  file order, joined by ", ", cut at PROMPT_CHARS (whole terms only). Returns the prompt and how many terms it holds. */
export function termsPrompt(text: string): { prompt: string; terms: number } {
  const terms = text.split("\n").map((l) => l.split("#")[0].trim()).filter(Boolean);
  let prompt = "";
  let n = 0;
  for (const t of terms) {
    const next = prompt ? `${prompt}, ${t}` : t;
    if (next.length > PROMPT_CHARS) break;
    prompt = next;
    n++;
  }
  return { prompt, terms: n };
}

/** `<records>/eval/stt-terms.txt` -> prompt; no file: empty prompt (no `--prompt`). */
export function loadTermsPrompt(recordsDir: string): { prompt: string; terms: number } {
  const p = join(recordsDir, "eval", "stt-terms.txt");
  return existsSync(p) ? termsPrompt(readFileSync(p, "utf8")) : { prompt: "", terms: 0 };
}

export class WhisperError extends Error {
  override name = "WhisperError";
  /** 0 = the engine is missing (not installed / not cached): transient, the note waits for the next run. */
  readonly status?: number;
  constructor(readonly reason: string) {
    super(`whisper ${reason}`); // never stderr text: it can carry transcript content
    if (reason === "spawn_failed") this.status = 0;
  }
}

export interface WhisperOptions {
  bin?: string;
  model: string;
  ffmpeg?: string;
  threads?: number;
  /** Default language (Hindi). */
  language?: string;
  /** Test seam: run a command, return exit code + stderr (stdout is not used). */
  exec?: (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number | null; stderr: string }>;
  /** Engine label in the transcript file. */
  engine?: string;
  /** Initial prompt (`--prompt`): the records key-term list (loadTermsPrompt). Never logged. */
  prompt?: string;
}

export function buildArgs(o: { model: string; wav: string; out: string; language: string; temperature: number; threads: number; prompt?: string }): string[] {
  const args = [
    "-m", o.model, "-f", o.wav, "-l", o.language, "-t", String(o.threads),
    "--max-context", String(DECODE.maxContext), "--entropy-thold", String(DECODE.entropyThold),
    "--logprob-thold", String(DECODE.logprobThold), "--no-speech-thold", String(DECODE.noSpeechThold),
    "--temperature", String(o.temperature), "--temperature-inc", String(DECODE.temperatureInc),
    "--beam-size", String(DECODE.beamSize), "--best-of", String(DECODE.bestOf),
    "--suppress-nst", "--output-json", "--output-file", o.out, "--no-prints",
  ];
  if (o.prompt) args.push("--prompt", o.prompt);
  if (args.some((a) => a === "-tr" || a === "--translate")) throw new WhisperError("translate_forbidden");
  return args;
}

/** Settings string recorded in the transcript file (no paths). */
export const settingsLine = (language: string) =>
  `-l ${language} (auto-detect fallback) --max-context ${DECODE.maxContext} --entropy-thold ${DECODE.entropyThold} --logprob-thold ${DECODE.logprobThold} ` +
  `--no-speech-thold ${DECODE.noSpeechThold} --temperature ${TEMPERATURES.join("|")} --temperature-inc ${DECODE.temperatureInc} ` +
  `--beam-size ${DECODE.beamSize} --best-of ${DECODE.bestOf} --suppress-nst; no translation; post-check: repetition`;

const words = (t: string) => t.toLowerCase().replace(/[।॥,.?!;:"'()\[\]-]/g, " ").split(/\s+/).filter(Boolean);

/** Post-check of a whole transcript: "ok", or why it looks like a decoding loop. Deterministic, content-free result. */
export function repetitionVerdict(segments: TranscriptSegment[]): string {
  const text = segments.map((s) => s.text).join(" ");
  const w = words(text);
  if (!w.length) return "empty";
  // The same segment three times in a row.
  const segs = segments.map((s) => words(s.text).join(" ")).filter(Boolean);
  for (let i = 2; i < segs.length; i++) if (segs[i] === segs[i - 1] && segs[i] === segs[i - 2] && words(segs[i]).length >= 2) return "repetition:segments";
  // One word (or a short phrase) repeated back to back.
  for (const n of [1, 2, 3]) {
    let run = 1;
    for (let i = n; i + n <= w.length; i += n) {
      const same = w.slice(i, i + n).join(" ") === w.slice(i - n, i).join(" ");
      run = same ? run + 1 : 1;
      if (run >= (n === 1 ? 8 : 5)) return "repetition:run";
    }
  }
  // Duplicate 4-grams over the whole text and over its second half (loops usually take over the tail).
  const dup = (xs: string[]) => {
    const grams = xs.slice(0, Math.max(0, xs.length - 3)).map((_, i) => xs.slice(i, i + 4).join(" "));
    return grams.length >= 20 ? 1 - new Set(grams).size / grams.length : 0;
  };
  if (dup(w) > 0.5 || dup(w.slice(Math.floor(w.length / 2))) > 0.6) return "repetition:ngrams";
  return "ok";
}

/** Share of letters in Devanagari (0-1). */
export function devanagariShare(text: string): number {
  const letters = [...text].filter((c) => /\p{L}/u.test(c));
  return letters.length ? letters.filter((c) => /[ऀ-ॿ]/.test(c)).length / letters.length : 0;
}

export function parseWhisperJson(json: string): { language: string | null; segments: TranscriptSegment[] } {
  const j = JSON.parse(json) as { result?: { language?: string }; transcription?: { offsets?: { from?: number; to?: number }; text?: string }[] };
  const segments = (j.transcription ?? [])
    .map((s) => ({ start: (s.offsets?.from ?? 0) / 1000, end: (s.offsets?.to ?? 0) / 1000, text: String(s.text ?? "").trim() }))
    .filter((s) => s.text);
  return { language: j.result?.language ?? null, segments };
}

const minimalEnv = (): NodeJS.ProcessEnv => {
  const e: NodeJS.ProcessEnv = {};
  for (const k of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]) if (process.env[k]) e[k] = process.env[k];
  return e;
};

function defaultExec(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: minimalEnv(), stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.stderr.setEncoding("utf8").on("data", (d: string) => (stderr = (stderr + d).slice(-20_000)));
    p.on("error", () => {
      clearTimeout(timer);
      reject(new WhisperError("spawn_failed"));
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

const EXT: Record<string, string> = { "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/wav": "wav", "audio/x-wav": "wav" };
const sec = (ms: number) => Math.round(ms / 100) / 10;

export class WhisperCppSpeechToText implements SpeechToText {
  readonly local = true;
  private readonly exec: NonNullable<WhisperOptions["exec"]>;
  /** Per call, counts only (for the batch log): audio seconds, wall seconds, attempts. */
  readonly runs: { audioSec: number; elapsedSec: number; attempts: number; accepted: boolean; language: string | null }[] = [];

  constructor(private o: WhisperOptions) {
    this.exec = o.exec ?? defaultExec;
  }

  async transcribe(audio: Media): Promise<Transcript> {
    const t0 = Date.now();
    const dir = mkdtempSync(join(tmpdir(), "hl-stt-"));
    try {
      const input = join(dir, `in.${EXT[audio.mimeType] ?? "ogg"}`);
      const wav = join(dir, "audio.wav");
      writeFileSync(input, audio.data);
      const ff = await this.exec(this.o.ffmpeg ?? "ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", input, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], 5 * 60_000);
      if (ff.code !== 0) throw new WhisperError("ffmpeg_failed");
      const audioSec = Math.max(0, (statSync(wav).size - 44) / 32_000);
      const threads = this.o.threads ?? Math.max(1, availableParallelism());
      const timeoutMs = Math.max(180_000, audioSec * 8_000);
      const lang = this.o.language ?? "hi";
      const bin = this.o.bin ?? "whisper-cli";

      // Quick detection pass (first 30 s): decides only the ORDER of the language settings.
      let detected: { lang: string; p: number } | null = null;
      const det = await this.exec(bin, ["-m", this.o.model, "-f", wav, "-l", "auto", "-t", String(threads), "--detect-language"], timeoutMs);
      const m = /auto-detected language:\s*([a-z]{2,3})\s*\(p\s*=\s*([\d.]+)\)/.exec(det.stderr);
      if (m) detected = { lang: m[1], p: Number(m[2]) };
      const other = detected && !["hi", "ur"].includes(detected.lang) && detected.p >= DETECT_CONFIDENT;
      const langs = other ? ["auto", lang] : [lang, "auto"];

      const attempts: TranscriptAttempt[] = [];
      let best: { segments: TranscriptSegment[]; language: string | null; accepted: boolean } | null = null;
      outer: for (const l of langs)
        for (const temperature of TEMPERATURES) {
          const a0 = Date.now();
          const out = join(dir, `out-${attempts.length}`);
          const r = await this.exec(bin, buildArgs({ model: this.o.model, wav, out, language: l, temperature, threads, prompt: this.o.prompt }), timeoutMs);
          let verdict = "ok";
          let parsed: ReturnType<typeof parseWhisperJson> = { language: null, segments: [] };
          if (r.code !== 0) verdict = r.code === null ? "timeout" : `exit_${r.code}`;
          else {
            try {
              parsed = parseWhisperJson(readFileSync(`${out}.json`, "utf8"));
              verdict = repetitionVerdict(parsed.segments);
              if (verdict === "ok" && (l === "hi" || parsed.language === "hi") && devanagariShare(parsed.segments.map((s) => s.text).join(" ")) < 0.5) verdict = "script";
            } catch {
              verdict = "bad_json";
            }
          }
          attempts.push({ language: l, temperature, detected: parsed.language, verdict, elapsedSec: sec(Date.now() - a0) });
          if (verdict === "ok") {
            best = { ...parsed, accepted: true };
            break outer;
          }
          if (parsed.segments.length && !best) best = { ...parsed, accepted: false };
        }
      const elapsedSec = sec(Date.now() - t0);
      const accepted = !!best?.accepted;
      this.runs.push({ audioSec: Math.round(audioSec), elapsedSec, attempts: attempts.length, accepted, language: best?.language ?? null });
      if (!best) {
        if (attempts.every((a) => a.verdict.startsWith("exit_") || a.verdict === "timeout" || a.verdict === "bad_json")) throw new WhisperError(attempts[0]?.verdict ?? "no_attempt");
        best = { segments: [], language: null, accepted: false };
      }
      return {
        text: best.segments.map((s) => s.text).join(" "),
        languageCode: best.language,
        languageProbability: detected && detected.lang === best.language ? detected.p : null,
        segments: best.segments,
        meta: {
          engine: this.o.engine ?? `whisper.cpp ${WHISPER_VERSION} (${WHISPER_COMMIT.slice(0, 12)})`,
          model: `${WHISPER_MODEL_NAME} (sha256 ${WHISPER_MODEL_SHA256.slice(0, 12)})`,
          settings: settingsLine(lang) + (detected ? `; detection pass: ${detected.lang} p=${detected.p}` : "; detection pass: none"),
          attempts, audioSec: Math.round(audioSec * 10) / 10, elapsedSec, accepted,
        },
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  startBatch(): Promise<string> {
    return Promise.reject(new WhisperError("no_batch_mode"));
  }

  pollBatch(): Promise<Transcript | null> {
    return Promise.reject(new WhisperError("no_batch_mode"));
  }
}
