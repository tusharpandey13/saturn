// Daily batch entrypoint (ADR 005), run by deploy/batch.sh (called from the env repo's thin workflow) under Node:
//   npx tsx batch/run.ts pull                      D1 inbox + media -> data/telegram/raw/, sources/
//   npx tsx batch/run.ts extract [--retry-failed]  raw -> STT / Haiku (claude -p) -> data/telegram/*.ndjson, queue, digest file
//                                                  exit 3 when extraction was delayed (auth, usage limit, outage)
//   npx tsx batch/run.ts finish [--no-digest]      mark inbox rows done, assert the webhook, send the digest, prune
//                                                  exit 1 when the webhook assertion fails (⚠ lines DM'd to the admins)
// Options: --records DIR (records repo root, holds records.yaml and optional config/thresholds.yaml; --root is the old name), --digest FILE (default
//          $RUNNER_TEMP or app/.batch/digest.txt), --now ISO.
// Env: pull/finish CLOUDFLARE_D1_TOKEN (fallback CLOUDFLARE_API_TOKEN), CLOUDFLARE_R2_TOKEN (optional), CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID, R2_BUCKET, TELEGRAM_BOT_TOKEN;
//      extract CLAUDE_CODE_OAUTH_TOKEN (or a local `claude` login; ANTHROPIC_API_KEY, if set, takes precedence in the CLI),
//      CLAUDE_TOKEN_CREATED (YYYY-MM-DD, expiry warning), CLAUDE_BIN (default claude), SARVAM_API_KEY (optional);
//      finish INBOX_RETENTION_DAYS (default 14), GO_LIVE (true after the GO-LIVE GATE), WORKER_URL (webhook assertion). Local e2e only: CLOUDFLARE_API_BASE, TELEGRAM_API_BASE.
// Output is counts only: no message content reaches the Actions log.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { cloudflareFromEnv, d1Http, r2Http } from "../src/batch/cloudflare.js";
import { Repo } from "../src/batch/repo.js";
import { extract, finish, pull } from "../src/batch/steps.js";
import { checkWebhook } from "../src/batch/webhook.js";
import { TelegramAdapter } from "../src/channel/telegram.js";
import { ClaudeCliExtractor, tokenExpiryWarning } from "../../adapters/llm/claude-cli.js";
import { Store } from "../src/store.js";
import { parseVocab, SarvamSpeechToText } from "../../adapters/stt/sarvam.js";
import { loadRecords } from "../src/batch/records.js";
import type { Person } from "../src/types.js";
import { aliasesFromRecords } from "../src/subject.js";

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const recordsArg = opt("--records") ?? opt("--root") ?? process.env.RECORDS_DIR;
if (!recordsArg) {
  console.error("usage: batch/run.ts pull|extract|finish --records DIR  (or RECORDS_DIR)");
  process.exit(2);
}
const root = resolve(recordsArg);
const records = loadRecords(root);
const digestPath = opt("--digest") ?? join(process.env.RUNNER_TEMP ?? join(import.meta.dirname, "..", ".batch"), "digest.txt");
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
      if (env.CLAUDE_CODE_OAUTH_TOKEN && !env.CLAUDE_TOKEN_CREATED) console.log("::warning::CLAUDE_TOKEN_CREATED is not set; no token-expiry warning in the digest");
    }
    if (!env.SARVAM_API_KEY) console.log("extract: no SARVAM_API_KEY; voice notes are stored as stt_pending");
    const r = await extract({
      repo, persons, now, thresholds: records.thresholds, warnings, aliases,
      extractor: new ClaudeCliExtractor({ bin: env.CLAUDE_BIN || "claude", context: records.extractionContext }),
      stt: env.SARVAM_API_KEY ? new SarvamSpeechToText(env.SARVAM_API_KEY, undefined, undefined, parseVocab(records.sttVocab ?? "")) : null,
      retryFailed: args.includes("--retry-failed"),
    });
    mkdirSync(dirname(digestPath), { recursive: true });
    writeFileSync(digestPath, r.digest);
    console.log(`extract: ${r.extracted} messages; pending ${r.pending} (delayed ${r.delayed}); stt_pending ${r.sttPending}; queued for deep read ${r.queued}; changed ${r.changed.join(", ") || "nothing"}`);
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
    const r = await finish({
      store: new Store(d1Http(cf)), tg, repo, now, digest, send, alerts,
      retentionDays: Number(process.env.INBOX_RETENTION_DAYS || 14),
    });
    if (digest !== null) rmSync(digestPath); // contains PHI
    const what = !send ? "not sent (--no-digest)" : digest === null ? "MISSING (failure notice to the admins)" : "sent";
    console.log(`finish: marked done ${r.done}; digest ${what}; family chat(s) ${r.sentTo}; admin DM(s) ${r.opsTo}; pruned ${r.pruned}`);
    console.log(`webhook: ${alerts.length ? "PROBLEM" : "ok"} (gate ${live ? "open" : "closed: no webhook expected"})`);
    for (const a of alerts) console.log(`::error::${a}`);
    if (alerts.length) process.exitCode = 1;
  } else {
    console.error("usage: batch/run.ts pull|extract|finish --records DIR [--digest FILE] [--now ISO] [--retry-failed]");
    process.exitCode = 2;
  }
}

main(args[0]).catch((err) => {
  console.error(`batch ${args[0]} failed: ${(err as Error).name}: ${(err as Error).message}`);
  process.exitCode = 1;
});
