// LlmAdapter `claude-cli`: the daily-batch extractor (ADR 005) via the Claude Code CLI (auth is an env choice):
//   claude -p --model <text: claude-haiku-5-5 | photo/PDF: claude-sonnet-5-5> --tools "" --max-turns 1 --json-schema <BATCH_SCHEMA> --output-format json
// Auth: CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`, valid 1 year). Never --bare: bare mode ignores that token.
// Optional fallback: if ANTHROPIC_API_KEY is set, the CLI itself prefers it over the OAuth token (CLI auth
// precedence), so the API-key path needs no SDK and no second code path. Off by default.
// Model per input kind (env EXTRACT_MODEL_TEXT / EXTRACT_MODEL_MEDIA): text stays on Haiku; photos and PDFs go to a
// stronger model (Sonnet by default; Opus configurable). Text messages go in chunks of <= 20; a PDF goes alone (every
// page reaches the model as one document block); photos in chunks of <= 4 (<= 6 MB of base64 per call).
// Usage guard: at most maxMediaCalls (EXTRACT_MAX_MEDIA_CALLS, default 30) photo/PDF calls per run; the rest wait as
// delayed (retried next run). Per-model calls, tokens and cost are counted in `usage` (logged as counts only).
// Photos and PDFs need content blocks, which only `--input-format stream-json` accepts, and the CLI requires
// `--output-format stream-json` with it; the final `result` event has the same fields as `--output-format json`.
// The CLI's structured_output is schema-constrained; parseExtraction() still validates and normalises it in code.
// Hard cases (documents, prescriptions, low confidence) are re-read later by an offline Opus agent (needs_deep queue).

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtractInput, type Extractor, ExtractorStopError, systemPrompt } from "../../app/src/extract/adapter.js";
import { EXTRACTION_SCHEMA } from "../../app/src/extract/schema.js";
import { VOICE_RULES, VOICE_SCHEMA } from "../../app/src/extract/voice.js";
export { type ExtractInput, type Extractor, ExtractorStopError, oneByOne } from "../../app/src/extract/adapter.js";

/** Full model ID, not the alias, so a new Haiku does not change extraction silently. The CLI version is pinned in
 *  the daily-batch workflow (CLAUDE_CODE_VERSION; Haiku 5.5 needs >= 2.1.293). */
export const MODEL = "claude-haiku-5-5";
/** Default for photos and PDFs (reports, prescriptions, device photos): reads every page and value. */
export const MEDIA_MODEL = "claude-sonnet-5-5";
export const MAX_MEDIA_CALLS = 30;
export const MAX_IMAGES_PER_CALL = 4;
const MODEL_RE = /^claude-[a-z0-9][a-z0-9.-]*$/;

/** Auth (401), rate/usage limit (429), overload/5xx, or the CLI died: retried next run, inbox rows stay new. */
export class ClaudeCliError extends Error {
  override name = "ClaudeCliError";
  constructor(readonly status: number, readonly reason: string) {
    super(`claude cli ${reason} (${status})`); // never the CLI's result text: it could echo message content
  }
}

/** One result per message: the extraction schema plus the message number. */
export const BATCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        ...EXTRACTION_SCHEMA,
        required: ["msg", ...EXTRACTION_SCHEMA.required],
        properties: { msg: { type: "integer", description: "the message number" }, ...EXTRACTION_SCHEMA.properties },
      },
    },
  },
} as const;

/** Voice notes: one transcript per call, the voice schema (extraction fields + verbatim statements). */
export const VOICE_BATCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        ...VOICE_SCHEMA,
        required: ["msg", ...VOICE_SCHEMA.required],
        properties: { msg: { type: "integer", description: "the message number" }, ...VOICE_SCHEMA.properties },
      },
    },
  },
} as const;
/** Default for voice-note transcripts (Hindi source text, relative dates, negations, speakers). */
export const TRANSCRIPT_MODEL = "claude-sonnet-5-5";

/** The ONLY variables the `claude` child process gets: auth, locale, paths and CLI switches. Everything else in the
 *  batch environment (SOPS_AGE_KEY, GitHub/App tokens, Cloudflare and Telegram secrets, runner tokens) is dropped, so
 *  the AI step can never see a write credential even if one is present in the parent. Pure prompt-in/JSON-out:
 *  --tools "" (no Bash, no file read/write), --max-turns 1, no MCP, an empty scratch cwd. */
export const CHILD_ENV_ALLOW = [
  "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "DISABLE_AUTOUPDATER",
  "DISABLE_TELEMETRY", "DISABLE_ERROR_REPORTING", "CLAUDE_CONFIG_DIR", "NODE_EXTRA_CA_CERTS",
] as const;
export function childEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of CHILD_ENV_ALLOW) if (parent[k]) env[k] = parent[k]; // empty secret = unset
  env.DISABLE_AUTOUPDATER = "1";
  return env;
}

export const MAX_PER_CALL = 20;
/** Piped stdin is capped at 10 MB by the CLI; base64 media per call stays well under it. */
export const MAX_MEDIA_B64_PER_CALL = 6_000_000;

type Block =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string } };

/** Page count of a PDF from its page objects (0 when they are compressed away). A hint for the model only. */
export function pdfPages(data: Uint8Array): number {
  return (Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("latin1").match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
}

const b64 = (data: Uint8Array) => Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64");

function blocksFor(n: number, { text, media, now, replyTo, context, voice }: ExtractInput): Block[] {
  if (voice)
    return [{ type: "text", text: `Message ${n}: received at ${now} (Asia/Kolkata context). context: ${context ? "yes" : "no"}. voice: yes (${Math.round(voice.durationSec)} s). Machine transcript, verbatim, [mm:ss] per segment:\n"""\n${text ?? ""}\n"""` }];
  const ctx = replyTo ? ` It replies to: """${replyTo.slice(0, 500)}""" (context only; extract from the reply itself).` : "";
  const pdf = media?.mimeType === "application/pdf";
  const pages = pdf ? pdfPages(media.data) : 0;
  const att = !media ? "" : pdf ? ` Attachment follows: a PDF${pages ? ` of ${pages} pages` : ""}; read every page.` : " Attachment follows.";
  const head: Block = { type: "text", text: `Message ${n}: received at ${now} (Asia/Kolkata context). context: ${context ? "yes" : "no"}.${ctx} ${text ? `Text: """${text}"""` : "No text."}${att}` };
  if (!media) return [head];
  const data = b64(media.data);
  return [head, pdf ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } } : { type: "image", source: { type: "base64", media_type: media.mimeType, data } }];
}

const mediaSize = (i: ExtractInput) => (i.media ? Math.ceil(i.media.data.byteLength / 3) * 4 : 0);

export interface ClaudeCliOptions {
  bin?: string;
  env?: NodeJS.ProcessEnv;
  /** Waits before retry 1..3 (transient errors only; auth errors are not retried). */
  backoffMs?: number[];
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Who the senders are (records meta/extraction-context.md); see systemPrompt(). */
  context?: string | null;
  /** Model for text-only messages (default MODEL, Haiku) and for photos/PDFs (default MEDIA_MODEL, Sonnet). */
  textModel?: string;
  mediaModel?: string;
  /** Model for voice-note transcripts (default TRANSCRIPT_MODEL, Sonnet; env EXTRACT_MODEL_TRANSCRIPT). */
  transcriptModel?: string;
  /** Usage guard: photo/PDF calls per run (default MAX_MEDIA_CALLS); over it, inputs wait as delayed. */
  maxMediaCalls?: number;
}

export interface ModelUsage { calls: number; inputTokens: number; outputTokens: number; costUsd: number }

const pickModel = (v: string | undefined, dflt: string) => {
  const m = v?.trim();
  if (m && !MODEL_RE.test(m)) console.error(`claude cli: ignoring invalid model id; using ${dflt}`);
  return m && MODEL_RE.test(m) ? m : dflt;
};

export class ClaudeCliExtractor implements Extractor {
  /** The text model (Haiku by default); photos and PDFs use `mediaModel` (see modelFor). */
  readonly model: string;
  readonly mediaModel: string;
  readonly transcriptModel: string;
  private readonly maxMediaCalls: number;
  private blocked: ClaudeCliError | null = null;
  private readonly backoffMs: number[];
  calls = 0;
  mediaCalls = 0;
  /** Per model: CLI calls, tokens and cost as reported by the CLI (counts only; no content). */
  readonly usage: Record<string, ModelUsage> = {};

  constructor(private o: ClaudeCliOptions = {}) {
    this.backoffMs = o.backoffMs ?? [5_000, 20_000, 60_000];
    this.model = pickModel(o.textModel, MODEL);
    this.mediaModel = pickModel(o.mediaModel, MEDIA_MODEL);
    this.transcriptModel = pickModel(o.transcriptModel, TRANSCRIPT_MODEL);
    this.maxMediaCalls = o.maxMediaCalls ?? MAX_MEDIA_CALLS;
  }

  modelFor(input: ExtractInput): string {
    return input.voice ? this.transcriptModel : input.media ? this.mediaModel : this.model;
  }

  async extract(inputs: ExtractInput[]): Promise<(unknown | Error)[]> {
    const out: (unknown | Error)[] = new Array(inputs.length);
    // Text first (one cheap chunked pass), then photos/PDFs on the media model.
    let chunk: number[] = [];
    let size = 0;
    const flush = async (media: boolean) => {
      if (chunk.length) await this.runChunk(inputs, chunk, out, media);
      chunk = [];
      size = 0;
    };
    for (let i = 0; i < inputs.length; i++) {
      if (inputs[i].media || inputs[i].voice) continue;
      if (chunk.length >= MAX_PER_CALL) await flush(false);
      chunk.push(i);
    }
    await flush(false);
    for (let i = 0; i < inputs.length; i++) {
      const m = inputs[i].media;
      if (!m) continue;
      const s = mediaSize(inputs[i]);
      if (s > MAX_MEDIA_B64_PER_CALL) {
        out[i] = new ExtractorStopError("attachment_too_large");
        continue;
      }
      const pdf = m.mimeType === "application/pdf";
      if (pdf || chunk.length >= MAX_IMAGES_PER_CALL || size + s > MAX_MEDIA_B64_PER_CALL) await flush(true);
      chunk.push(i);
      size += s;
      if (pdf) await flush(true); // a PDF always goes alone: the model's whole attention on its pages
    }
    await flush(true);
    // Voice notes: one transcript per call on the transcript model, voice schema and rules.
    for (let i = 0; i < inputs.length; i++) if (inputs[i].voice) await this.runChunk(inputs, [i], out, false, true);
    return out;
  }

  private async runChunk(inputs: ExtractInput[], idx: number[], out: (unknown | Error)[], media: boolean, voice = false): Promise<void> {
    if (media && this.mediaCalls >= this.maxMediaCalls) {
      // Usage guard: kept as delayed (transient), so the inbox rows stay new and the next run reads them.
      for (const i of idx) out[i] = new ClaudeCliError(0, "media_call_cap");
      return;
    }
    try {
      if (media) this.mediaCalls++;
      const so = (await this.call(idx.flatMap((i, k) => blocksFor(k + 1, inputs[i])), voice ? this.transcriptModel : media ? this.mediaModel : this.model, voice)) as { results?: { msg?: unknown }[] };
      const byMsg = new Map<number, Record<string, unknown>>();
      for (const r of Array.isArray(so?.results) ? so.results : []) if (typeof r?.msg === "number" && !byMsg.has(r.msg)) byMsg.set(r.msg, r);
      idx.forEach((i, k) => {
        const r = byMsg.get(k + 1);
        if (!r) out[i] = new ExtractorStopError("missing_result");
        else {
          const { msg: _msg, ...rest } = r;
          out[i] = rest;
        }
      });
    } catch (err) {
      // One refused or unusable message must not fail the whole chunk: retry those one by one.
      if (err instanceof ExtractorStopError && idx.length > 1) for (const i of idx) await this.runChunk(inputs, [i], out, media, voice);
      else for (const i of idx) out[i] = err as Error;
    }
  }

  /** One CLI call with retries; returns structured_output. */
  private async call(blocks: Block[], model: string, voice = false): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      if (this.blocked) throw this.blocked; // auth or usage limit hit earlier in this run: do not hammer
      try {
        return await this.once(blocks, model, voice);
      } catch (err) {
        if (!(err instanceof ClaudeCliError)) throw err;
        if (err.status === 401 || attempt >= this.backoffMs.length) {
          if (err.status === 401 || err.status === 429) this.blocked = err;
          throw err;
        }
        console.error(`claude cli ${err.reason} (${err.status}); retry ${attempt + 1}/${this.backoffMs.length}`);
        await (this.o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(this.backoffMs[attempt]);
      }
    }
  }

  private async once(blocks: Block[], model: string, voice = false): Promise<unknown> {
    this.calls++;
    const stream = blocks.some((b) => b.type !== "text");
    const effort = stream || voice ? "medium" : "low";
    const args = [
      "-p", "--model", model, "--effort", effort, "--tools", "", "--max-turns", "1",
      "--system-prompt", systemPrompt(this.o.context) + (voice ? VOICE_RULES : ""), "--json-schema", JSON.stringify(voice ? VOICE_BATCH_SCHEMA : BATCH_SCHEMA),
      "--no-session-persistence", "--strict-mcp-config", "--disable-slash-commands",
      ...(stream ? ["--input-format", "stream-json", "--output-format", "stream-json", "--verbose"] : ["--output-format", "json"]),
    ];
    const input = stream
      ? `${JSON.stringify({ type: "user", message: { role: "user", content: blocks } })}\n`
      : blocks.map((b) => (b as { text: string }).text).join("\n\n");
    const env = childEnv(this.o.env ?? process.env); // allowlist: no write tokens, no SOPS key reach the AI process
    // Empty scratch cwd: no project settings, hooks or CLAUDE.md from the repo are picked up.
    const cwd = mkdtempSync(join(tmpdir(), "hl-claude-"));
    try {
      const { code, stdout } = await run(this.o.bin ?? "claude", args, input, { cwd, env, timeoutMs: this.o.timeoutMs ?? 10 * 60_000 });
      countUsage(this.usage, model, stdout);
      return parseResult(stdout, code);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
}

/** Adds the CLI's reported usage (result event: usage, total_cost_usd) to `usage`. Never throws. */
function countUsage(usage: Record<string, ModelUsage>, model: string, stdout: string): void {
  const u = (usage[model] ??= { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
  u.calls++;
  const res = lastResult(stdout);
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  u.inputTokens += n(res?.usage?.input_tokens) + n(res?.usage?.cache_read_input_tokens) + n(res?.usage?.cache_creation_input_tokens);
  u.outputTokens += n(res?.usage?.output_tokens);
  u.costUsd += n(res?.total_cost_usd);
}

function run(bin: string, args: string[], input: string, o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    const timer = setTimeout(() => p.kill("SIGTERM"), o.timeoutMs);
    p.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    p.stderr.resume(); // not logged: may contain content
    p.on("error", () => {
      clearTimeout(timer);
      reject(new ClaudeCliError(0, "spawn_failed"));
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout });
    });
    p.stdin.on("error", () => {}); // the CLI may exit before reading stdin
    p.stdin.end(input);
  });
}

/** Last `result` event of json / stream-json output -> structured_output, or a classified error. */
function lastResult(stdout: string): any {
  let res: any = null;
  for (const line of stdout.split("\n")) {
    try {
      const j = JSON.parse(line);
      if (j?.type === "result") res = j;
    } catch {
      /* not a JSON line */
    }
  }
  return res;
}

export function parseResult(stdout: string, code: number | null): unknown {
  const res = lastResult(stdout);
  if (!res) throw new ClaudeCliError(0, code === null ? "killed" : `no_result_exit_${code}`);
  if (res.is_error) {
    const text = String(res.result ?? "");
    const status = typeof res.api_error_status === "number" ? res.api_error_status : null;
    if (status === 401 || status === 403 || /not logged in|authenticat|oauth|api key|invalid.*token|token.*(expired|revoked)/i.test(text)) throw new ClaudeCliError(401, "auth_failed");
    if (status === 429 || /rate.?limit|usage limit|hit your limit/i.test(text)) throw new ClaudeCliError(429, "rate_limited");
    if (status !== null || res.terminal_reason === "api_error") throw new ClaudeCliError(status ?? 0, "api_error");
    throw new ExtractorStopError(String(res.subtype ?? res.terminal_reason ?? "error"));
  }
  if (res.structured_output === undefined || res.structured_output === null) throw new ExtractorStopError("no_structured_output");
  return res.structured_output;
}

const DAY = 86_400_000;
export const TOKEN_LIFETIME_DAYS = 365;
export const TOKEN_WARN_DAYS = 30;

/** Digest warning from 30 days before the 1-year CLAUDE_CODE_OAUTH_TOKEN expires (created date: repo variable CLAUDE_TOKEN_CREATED). */
export function tokenExpiryWarning(created: string | undefined, now: string): string | null {
  const t = created ? Date.parse(created) : NaN;
  if (Number.isNaN(t)) return null;
  const expiry = new Date(t + TOKEN_LIFETIME_DAYS * DAY);
  const days = Math.ceil((expiry.getTime() - Date.parse(now)) / DAY);
  if (days > TOKEN_WARN_DAYS) return null;
  const when = expiry.toISOString().slice(0, 10);
  return `Claude token ${days < 0 ? `expired on ${when}` : `expires on ${when} (${days} days)`}: run \`claude setup-token\`, update the CLAUDE_CODE_OAUTH_TOKEN secret and the CLAUDE_TOKEN_CREATED variable (app/DEPLOY.md).`;
}
