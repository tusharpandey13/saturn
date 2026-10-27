// ClaudeCliExtractor against a fake `claude` binary on PATH (no network, no account).
// The fake logs its argv/stdin and answers like `claude -p --output-format json|stream-json --json-schema`.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCliError, ClaudeCliExtractor, type ExtractInput, ExtractorStopError, MAX_PER_CALL, MODEL, parseResult, tokenExpiryWarning } from "../../adapters/llm/claude-cli.js";
import { parseExtraction } from "../src/extract/schema.js";

const FAKE = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, stdin, apiKey: "ANTHROPIC_API_KEY" in process.env, oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null }) + "\\n");
const stream = args.includes("stream-json");
let texts = [], media = 0;
if (stream) for (const b of JSON.parse(stdin).message.content) { if (b.type === "text") texts.push(b.text); else media++; }
else texts = [stdin];
const msgs = [...texts.join("\\n").matchAll(/Message (\\d+): [^\\n]*/g)].map((m) => ({ n: Number(m[1]), text: m[0] }));
const mode = process.env.FAKE_CLAUDE_MODE || "ok";
const out = (o) => { if (stream) console.log(JSON.stringify({ type: "system", subtype: "init" })); console.log(JSON.stringify({ type: "result", subtype: "success", ...o })); };
if (mode === "auth") { out({ is_error: true, api_error_status: 401, terminal_reason: "api_error", result: "Failed to authenticate. API Error: 401 OAuth access token is invalid." }); process.exit(1); }
if (mode === "nologin") { out({ is_error: true, api_error_status: null, terminal_reason: "api_error", result: "Not logged in · Please run /login" }); process.exit(1); }
if (mode === "ratelimit") { out({ is_error: true, api_error_status: 429, terminal_reason: "api_error", result: "API Error: 429 rate_limit_error" }); process.exit(1); }
if (mode === "crash") process.exit(2);
if (mode === "refuse-multi" && msgs.length > 1) { out({ is_error: false, result: "I can't help with that." }); process.exit(0); }
const none = { readings: [], symptoms: [], media_kind: "none", confidence: 0.9, unreadable_reason: null };
const results = msgs.filter((m) => !(mode === "skip2" && m.n === 2)).map(({ n, text }) => {
  const bp = text.match(/BP (\\d+)\\/(\\d+)(?: pulse (\\d+))?/);
  if (bp) return { msg: n, ...none, readings: [{ type: "bp", value: +bp[1], value2: +bp[2], value3: bp[3] ? +bp[3] : null, unit: "mmHg", measured_at: null }] };
  if (/Attachment/.test(text)) return { msg: n, ...none, media_kind: "device_reading", unreadable_reason: "blurred" };
  return { msg: n, ...none };
});
out({ is_error: false, result: JSON.stringify({ results }), structured_output: { results } });
`;

let dir: string;
let log: string;
const calls = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const NOW = "2026-10-25T10:00:00.000Z";
const text = (t: string): ExtractInput => ({ text: t, now: NOW });
const cli = (mode: string, extra: Record<string, string> = {}, sleeps: number[] = []) =>
  new ClaudeCliExtractor({
    env: { PATH: `${dir}:${process.env.PATH}`, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_MODE: mode, ...extra },
    sleep: async (ms) => void sleeps.push(ms),
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  log = join(dir, "calls.ndjson");
  writeFileSync(log, "");
  writeFileSync(join(dir, "claude"), FAKE);
  chmodSync(join(dir, "claude"), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ClaudeCliExtractor (fake claude on PATH)", () => {
  it("batches text messages into one claude -p call with the schema, Haiku, no tools, json output", async () => {
    const out = await cli("ok", { CLAUDE_CODE_OAUTH_TOKEN: "tok", ANTHROPIC_API_KEY: "" }).extract([text("BP 130/85 pulse 70, thoda chakkar aaya"), text("aaj theek hoon"), text("BP 120/80")]);
    const c = calls();
    expect(c).toHaveLength(1);
    const a = c[0].args as string[];
    expect(a.slice(0, 3)).toEqual(["-p", "--model", MODEL]);
    expect(MODEL).toBe("claude-haiku-5-5");
    expect(a[a.indexOf("--tools") + 1]).toBe("");
    expect(a[a.indexOf("--max-turns") + 1]).toBe("1");
    expect(a[a.indexOf("--output-format") + 1]).toBe("json");
    expect(JSON.parse(a[a.indexOf("--json-schema") + 1]).properties.results.items.required).toContain("msg");
    expect(a).not.toContain("--bare"); // bare mode ignores CLAUDE_CODE_OAUTH_TOKEN
    expect(a).toContain("--no-session-persistence");
    expect(c[0].oauth).toBe("tok");
    expect(c[0].apiKey).toBe(false); // an empty secret is not passed as an (empty) API key
    expect(parseExtraction(out[0], NOW).readings).toEqual([{ type: "bp", value: 130, value2: 85, value3: 70, unit: "mmHg", measuredAt: NOW }]);
    expect(parseExtraction(out[1], NOW).readings).toEqual([]);
    expect((out[2] as any).readings[0].value).toBe(120);
    expect((out[0] as any).msg).toBeUndefined();
  });

  it("one combined call: each message header says context: yes|no (ADR 010 pre-filter)", async () => {
    await cli("ok").extract([{ ...text("aaj bahut tension hai office mein"), context: true }, text("BP 120/80")]);
    const stdin = String(calls()[0].stdin);
    expect(stdin).toMatch(/Message 1: [^\n]*context: yes\./);
    expect(stdin).toMatch(/Message 2: [^\n]*context: no\./);
    expect(JSON.parse(calls()[0].args[calls()[0].args.indexOf("--json-schema") + 1]).properties.results.items.required).toContain("context");
  });

  it("photos/PDFs go as content blocks over stream-json; chunks of at most MAX_PER_CALL", async () => {
    const photo: ExtractInput = { now: NOW, media: { data: new Uint8Array([0xff, 0xd8, 1]), mimeType: "image/jpeg" } };
    const pdf: ExtractInput = { now: NOW, media: { data: new Uint8Array([0x25, 0x50]), mimeType: "application/pdf" } };
    const many = Array.from({ length: MAX_PER_CALL + 1 }, (_, i) => text(`wajan ${60 + (i % 5)}`));
    const out = await cli("ok").extract([photo, pdf, ...many]);
    const c = calls();
    expect(c).toHaveLength(2);
    expect(c[0].args).toEqual(expect.arrayContaining(["--input-format", "stream-json", "--output-format", "stream-json"]));
    const content = JSON.parse(c[0].stdin).message.content;
    expect(content.map((b: any) => b.type).slice(0, 4)).toEqual(["text", "image", "text", "document"]);
    expect(content[1].source).toEqual({ type: "base64", media_type: "image/jpeg", data: Buffer.from([0xff, 0xd8, 1]).toString("base64") });
    expect(c[1].args[c[1].args.indexOf("--output-format") + 1]).toBe("json");
    expect(out).toHaveLength(MAX_PER_CALL + 3);
    expect((out[0] as any).unreadable_reason).toBe("blurred");
    expect(out.every((o) => !(o instanceof Error))).toBe(true);
  });

  it("auth failure: no retry, every message gets a transient 401, later chunks are not attempted", async () => {
    const sleeps: number[] = [];
    const inputs = Array.from({ length: MAX_PER_CALL + 5 }, () => text("chakkar"));
    for (const mode of ["auth", "nologin"]) {
      writeFileSync(log, "");
      const out = await cli(mode, {}, sleeps).extract(inputs);
      expect(calls()).toHaveLength(1);
      expect(out.every((e) => e instanceof ClaudeCliError && e.status === 401)).toBe(true);
    }
    expect(sleeps).toEqual([]);
  });

  it("rate limit: 3 retries with backoff, then delayed", async () => {
    const sleeps: number[] = [];
    const out = await cli("ratelimit", {}, sleeps).extract([text("a"), text("b")]);
    expect(calls()).toHaveLength(4);
    expect(sleeps).toEqual([5_000, 20_000, 60_000]);
    expect(out.every((e) => e instanceof ClaudeCliError && e.status === 429)).toBe(true);
  });

  it("a CLI crash without a result is transient (retried), not a permanent failure", async () => {
    const out = await cli("crash").extract([text("a")]);
    expect(calls()).toHaveLength(4);
    expect(out[0]).toBeInstanceOf(ClaudeCliError);
    expect((out[0] as ClaudeCliError).status).toBe(0);
  });

  it("a missing result fails only that message; a refused batch is retried one by one", async () => {
    const out = await cli("skip2").extract([text("BP 120/80"), text("x"), text("BP 110/70")]);
    expect(out[1]).toBeInstanceOf(ExtractorStopError);
    expect((out[2] as any).readings[0].value).toBe(110);

    writeFileSync(log, "");
    const out2 = await cli("refuse-multi").extract([text("BP 120/80"), text("BP 110/70")]);
    expect(calls()).toHaveLength(3);
    expect((out2[1] as any).readings[0].value).toBe(110);
  });

  it("attachments too large for one call are failed without a call", async () => {
    const big: ExtractInput = { now: NOW, media: { data: new Uint8Array(5_000_000), mimeType: "application/pdf" } };
    const out = await cli("ok").extract([big]);
    expect(out[0]).toBeInstanceOf(ExtractorStopError);
    expect(calls()).toHaveLength(0);
  });
});

describe("parseResult (real CLI shapes, 2.1.30x)", () => {
  it("classifies results", () => {
    expect(parseResult(JSON.stringify({ type: "result", is_error: false, structured_output: { results: [] } }), 0)).toEqual({ results: [] });
    expect(() => parseResult(JSON.stringify({ type: "result", is_error: false, result: "no" }), 0)).toThrow(ExtractorStopError);
    expect(() => parseResult(JSON.stringify({ type: "result", is_error: true, subtype: "error_max_turns" }), 1)).toThrow(ExtractorStopError);
    const e = (() => { try { parseResult(JSON.stringify({ type: "result", is_error: true, api_error_status: 529, terminal_reason: "api_error" }), 1); } catch (x) { return x as ClaudeCliError; } })();
    expect(e?.status).toBe(529);
    expect(() => parseResult("garbage", 1)).toThrow(ClaudeCliError);
  });
});

describe("token expiry guard", () => {
  it("warns from 30 days before the 1-year expiry", () => {
    expect(tokenExpiryWarning(undefined, NOW)).toBeNull();
    expect(tokenExpiryWarning("2026-10-25", NOW)).toBeNull();
    expect(tokenExpiryWarning("2025-11-26", NOW)).toBeNull(); // expires 2026-11-26, 32 days left
    expect(tokenExpiryWarning("2025-11-20", NOW)).toMatch(/expires on 2026-11-20 \(26 days\).*claude setup-token/);
    expect(tokenExpiryWarning("2025-10-01", NOW)).toMatch(/expired on 2026-10-01/);
  });
});
