// LlmAdapter `claude-cli`: the daily-batch extractor (ADR 005) via the Claude Code CLI (auth is an env choice):
//   claude -p --model claude-haiku-5-5 --tools "" --max-turns 1 --json-schema <BATCH_SCHEMA> --output-format json
// Auth: CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`, valid 1 year). Never --bare: bare mode ignores that token.
// Optional fallback: if ANTHROPIC_API_KEY is set, the CLI itself prefers it over the OAuth token (CLI auth
// precedence), so the API-key path needs no SDK and no second code path. Off by default.
// The day's messages go in as few calls as practical (chunks of <= 20 messages, <= 6 MB of base64 media).
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
export { type ExtractInput, type Extractor, ExtractorStopError, oneByOne } from "../../app/src/extract/adapter.js";

/** Full model ID, not the alias, so a new Haiku does not change extraction silently. The CLI version is pinned in
 *  the daily-batch workflow (CLAUDE_CODE_VERSION; Haiku 5.5 needs >= 2.1.293). */
export const MODEL = "claude-haiku-5-5";

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

export const MAX_PER_CALL = 20;
/** Piped stdin is capped at 10 MB by the CLI; base64 media per call stays well under it. */
export const MAX_MEDIA_B64_PER_CALL = 6_000_000;

type Block =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string } };

const b64 = (data: Uint8Array) => Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64");

function blocksFor(n: number, { text, media, now, replyTo, context }: ExtractInput): Block[] {
  const ctx = replyTo ? ` It replies to: """${replyTo.slice(0, 500)}""" (context only; extract from the reply itself).` : "";
  const head: Block = { type: "text", text: `Message ${n}: received at ${now} (Asia/Kolkata context). context: ${context ? "yes" : "no"}.${ctx} ${text ? `Text: """${text}"""` : "No text."}${media ? " Attachment follows." : ""}` };
  if (!media) return [head];
  const data = b64(media.data);
  return [head, media.mimeType === "application/pdf" ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } } : { type: "image", source: { type: "base64", media_type: media.mimeType, data } }];
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
}

export class ClaudeCliExtractor implements Extractor {
  readonly model = MODEL;
  private blocked: ClaudeCliError | null = null;
  private readonly backoffMs: number[];
  calls = 0;

  constructor(private o: ClaudeCliOptions = {}) {
    this.backoffMs = o.backoffMs ?? [5_000, 20_000, 60_000];
  }

  async extract(inputs: ExtractInput[]): Promise<(unknown | Error)[]> {
    const out: (unknown | Error)[] = new Array(inputs.length);
    let chunk: number[] = [];
    let size = 0;
    const flush = async () => {
      if (chunk.length) await this.runChunk(inputs, chunk, out);
      chunk = [];
      size = 0;
    };
    for (let i = 0; i < inputs.length; i++) {
      const s = mediaSize(inputs[i]);
      if (s > MAX_MEDIA_B64_PER_CALL) {
        out[i] = new ExtractorStopError("attachment_too_large");
        continue;
      }
      if (chunk.length >= MAX_PER_CALL || size + s > MAX_MEDIA_B64_PER_CALL) await flush();
      chunk.push(i);
      size += s;
    }
    await flush();
    return out;
  }

  private async runChunk(inputs: ExtractInput[], idx: number[], out: (unknown | Error)[]): Promise<void> {
    try {
      const so = (await this.call(idx.flatMap((i, k) => blocksFor(k + 1, inputs[i])))) as { results?: { msg?: unknown }[] };
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
      if (err instanceof ExtractorStopError && idx.length > 1) for (const i of idx) await this.runChunk(inputs, [i], out);
      else for (const i of idx) out[i] = err as Error;
    }
  }

  /** One CLI call with retries; returns structured_output. */
  private async call(blocks: Block[]): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      if (this.blocked) throw this.blocked; // auth or usage limit hit earlier in this run: do not hammer
      try {
        return await this.once(blocks);
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

  private async once(blocks: Block[]): Promise<unknown> {
    this.calls++;
    const stream = blocks.some((b) => b.type !== "text");
    const effort = stream ? "medium" : "low";
    const args = [
      "-p", "--model", MODEL, "--effort", effort, "--tools", "", "--max-turns", "1",
      "--system-prompt", systemPrompt(this.o.context), "--json-schema", JSON.stringify(BATCH_SCHEMA),
      "--no-session-persistence", "--strict-mcp-config", "--disable-slash-commands",
      ...(stream ? ["--input-format", "stream-json", "--output-format", "stream-json", "--verbose"] : ["--output-format", "json"]),
    ];
    const input = stream
      ? `${JSON.stringify({ type: "user", message: { role: "user", content: blocks } })}\n`
      : blocks.map((b) => (b as { text: string }).text).join("\n\n");
    const env = { ...(this.o.env ?? process.env) };
    for (const k of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) if (!env[k]) delete env[k]; // empty secret = unset
    // Empty scratch cwd: no project settings, hooks or CLAUDE.md from the repo are picked up.
    const cwd = mkdtempSync(join(tmpdir(), "hl-claude-"));
    try {
      const { code, stdout } = await run(this.o.bin ?? "claude", args, input, { cwd, env, timeoutMs: this.o.timeoutMs ?? 10 * 60_000 });
      return parseResult(stdout, code);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
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
export function parseResult(stdout: string, code: number | null): unknown {
  let res: any = null;
  for (const line of stdout.split("\n")) {
    try {
      const j = JSON.parse(line);
      if (j?.type === "result") res = j;
    } catch {
      /* not a JSON line */
    }
  }
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
