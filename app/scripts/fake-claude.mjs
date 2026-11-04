#!/usr/bin/env node
// Canned `claude -p` for the local e2e tier (CLAUDE_BIN=scripts/fake-claude.mjs). No network, no account.
// Answers the batch extraction call (--json-schema, json or stream-json) by regex: "120/80 72" -> a BP reading;
// an attachment -> an unreadable device photo. Mode ok (default) | auth | limit: FAKE_CLAUDE_MODE, or (the batch passes the
// CLI only CHILD_ENV_ALLOW) a CLAUDE_CONFIG_DIR ending in fake-claude-<mode>.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
if (!args.includes("-p") || !args.includes("--json-schema")) process.exit(2);
const stream = args.includes("stream-json");
const stdin = readFileSync(0, "utf8");
const texts = stream ? JSON.parse(stdin).message.content.filter((b) => b.type === "text").map((b) => b.text) : [stdin];
const out = (o) => {
  if (stream) console.log(JSON.stringify({ type: "system", subtype: "init", model: "fake" }));
  console.log(JSON.stringify({ type: "result", subtype: "success", ...o }));
};
const mode = process.env.FAKE_CLAUDE_MODE || /fake-claude-(auth|limit)$/.exec(process.env.CLAUDE_CONFIG_DIR ?? "")?.[1] || "ok";
if (mode === "auth") {
  out({ is_error: true, api_error_status: 401, terminal_reason: "api_error", result: "Failed to authenticate. API Error: 401 OAuth access token is invalid." });
  process.exit(1);
}
if (mode === "limit") {
  out({ is_error: true, api_error_status: 429, terminal_reason: "api_error", result: "Claude AI usage limit reached" });
  process.exit(1);
}
const none = { readings: [], symptoms: [], media_kind: "none", confidence: 0.9, unreadable_reason: null };
const results = [...texts.join("\n").matchAll(/Message (\d+): [^\n]*/g)].map(([line, n]) => {
  const bp = line.match(/Text: """(\d{2,3})\/(\d{2,3})(?:\s+(\d{2,3}))?/);
  if (bp) return { msg: +n, ...none, readings: [{ type: "bp", value: +bp[1], value2: +bp[2], value3: bp[3] ? +bp[3] : null, unit: "mmHg", measured_at: null }] };
  if (/Attachment follows/.test(line)) return { msg: +n, ...none, media_kind: "device_reading", confidence: 0.3, unreadable_reason: "display blurred" };
  return { msg: +n, ...none };
});
out({ is_error: false, result: JSON.stringify({ results }), structured_output: { results } });
