#!/usr/bin/env node
// Worker dry run in the real runtime: wrangler dev (workerd) + local D1/R2 + a stub Telegram API.
// Then the real batch CLI (batch/run.ts pull|extract|finish, as deploy/batch.sh runs it) against the same local
// D1/R2, through a fake Cloudflare REST API (wrangler getPlatformProxy) and a fake `claude` (scripts/fake-claude.mjs).
// No accounts, no keys, no network. Design: docs/platform/e2e-testing.md (local tier).
//
// Flow: wrong secret -> 401; vitals text in the group -> inbox row, NO group reply (ADR 011: the group is input-only,
//       even with ack_mode all); photo -> R2 + inbox media stored, no reply; redelivered update -> still one row;
//       an admin's private message -> stored + acked in the DM only; batch pull -> raw + media in a scratch repo;
//       extract with Claude auth failing -> exit 3, rows stay new; finish -> short ops DM to the admin, nothing to the
//       group; extract again -> BP reading in NDJSON; KB build ok; finish -> rows done, digest DM'd to the admin only.
//   npm run e2e:local
import { execFile, execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPlatformProxy } from "wrangler";

const APP = join(import.meta.dirname, "..");
const EXAMPLE = join(APP, "..", "fixtures", "records-example");
// Resource names come from the rendered app/wrangler.toml (npm run render; deploy/env.example.yaml by default).
const WRANGLER_TOML = readFileSync(join(APP, "wrangler.toml"), "utf8");
const BUCKET = /bucket_name = "([^"]+)"/.exec(WRANGLER_TOML)[1];
const STATE = join(APP, ".wrangler", "e2e");
const STUB_PORT = 8790;
const CF_PORT = 8791;
const WORKER_PORT = 8797;
const TOKEN = "e2e-bot-token";
const SECRET = "e2e-webhook-secret";
const GROUP = -1001234567890;
const ALICE = 111;
const ADMIN = 222;

const telegramCalls = [];
const stub = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const url = new URL(req.url, "http://stub");
  const json = (obj, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (url.pathname === `/file/bot${TOKEN}/photos/bp.jpg`) {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    res.writeHead(200, { "content-type": "image/jpeg", "content-length": String(jpeg.length) });
    return res.end(jpeg);
  }
  const tg = url.pathname.match(new RegExp(`^/bot${TOKEN}/(\\w+)$`));
  if (tg) {
    const payload = body ? JSON.parse(body) : {};
    telegramCalls.push({ method: tg[1], body: payload });
    if (tg[1] === "getFile") return json({ ok: true, result: { file_id: payload.file_id, file_path: "photos/bp.jpg" } });
    if (tg[1] === "getWebhookInfo") return json({ ok: true, result: { url: "", has_custom_certificate: false, pending_update_count: 0 } }); // before go-live
    return json({ ok: true, result: { message_id: 1000 + telegramCalls.length } });
  }
  json({ ok: false }, 404);
});

const wrangler = (args, opts = {}) => execFileSync("npx", ["wrangler", ...args], { cwd: APP, stdio: "pipe", encoding: "utf8", ...opts });
const d1 = (sql) => JSON.parse(wrangler(["d1", "execute", "DB", "--local", "--persist-to", STATE, "--json", "--command", sql]))[0].results;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what, fn, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(300);
  }
  throw new Error(`timed out waiting for: ${what}`);
}
const post = (update, secret = SECRET) =>
  fetch(`http://127.0.0.1:${WORKER_PORT}/telegram/webhook`, {
    method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify(update),
  });
const sent = () => telegramCalls.filter((c) => c.method === "sendMessage");
const now = () => Math.floor(Date.now() / 1000);
const check = (ok, msg) => { if (!ok) throw new Error(msg); };

let dev, cf, proxy, root;
async function main() {
  await new Promise((r) => stub.listen(STUB_PORT, "127.0.0.1", r));
  rmSync(STATE, { recursive: true, force: true });
  mkdirSync(STATE, { recursive: true });

  console.log("0/9 role + subject migrations (0002, 0003) on a local D1 at 0001 with 3 persons like production");
  const MIG_STATE = join(STATE, "migration");
  const d1m = (args) => JSON.parse(wrangler(["d1", "execute", "DB", "--local", "--persist-to", MIG_STATE, "--json", ...args]))[0]?.results;
  d1m(["--file", join(APP, "migrations", "0001_init.sql")]);
  d1m(["--command", `INSERT INTO persons (id, name, role, sender_id) VALUES ('alice', 'Alice', 'patient', '111'), ('bob', 'Bob', 'patient', '333'), ('carol-tg', 'Carol', 'caregiver', '222');`]);
  d1m(["--command", "INSERT INTO inbox (update_id, chat_id, message_id, sender_id, person_id, kind, received_at, raw) VALUES (1, '-1', 1, '333', 'bob', 'text', '2026-10-27T08:24:00Z', '{}')"]);
  d1m(["--file", join(APP, "migrations", "0002_member_admin_roles.sql")]);
  d1m(["--file", join(APP, "migrations", "0003_inbox_subject.sql")]);
  const sub = d1m(["--command", "SELECT person_id, subject_id FROM inbox"]);
  check(JSON.stringify(sub) === JSON.stringify([{ person_id: "bob", subject_id: "bob" }]), `subject migration: unexpected ${JSON.stringify(sub)}`);
  const migrated = d1m(["--command", "SELECT id, role, sender_id FROM persons ORDER BY id"]);
  check(JSON.stringify(migrated) === JSON.stringify([{ id: "alice", role: "member", sender_id: "111" }, { id: "bob", role: "member", sender_id: "333" }, { id: "carol-tg", role: "admin", sender_id: "222" }]),
    `role migration: unexpected rows ${JSON.stringify(migrated)}`);
  let refused = false;
  try { d1m(["--command", "INSERT INTO persons (id, name, role, sender_id) VALUES ('x', 'X', 'patient', '999')"]); } catch { refused = true; }
  check(refused, "role migration: the old role 'patient' was accepted");
  refused = false;
  try { d1m(["--command", "INSERT INTO persons (id, name, role, sender_id) VALUES ('y', 'Y', 'member', '111')"]); } catch { refused = true; }
  check(refused, "role migration: sender_id is no longer UNIQUE");

  console.log("1/9 local D1: migrations + seed");
  wrangler(["d1", "migrations", "apply", "DB", "--local", "--persist-to", STATE], { input: "y\n" });
  // The label is a free note with no semantics (ADR 011); production relabelled its group 'members-silent'.
  d1(`INSERT INTO chats (chat_id, channel, label) VALUES ('${GROUP}', 'telegram', 'members-silent');
      INSERT INTO persons (id, name, role, sender_id) VALUES ('alice', 'Alice', 'member', '${ALICE}'), ('carol-tg', 'Carol', 'admin', '${ADMIN}');`);

  console.log("2/9 wrangler dev (local workerd, stub Telegram)");
  const envFile = join(STATE, "e2e.env");
  writeFileSync(envFile, [`TELEGRAM_BOT_TOKEN=${TOKEN}`, `TELEGRAM_WEBHOOK_SECRET=${SECRET}`, `TELEGRAM_API_BASE=http://127.0.0.1:${STUB_PORT}`].join("\n"));
  dev = spawn("npx", ["wrangler", "dev", "--local", "--port", String(WORKER_PORT), "--ip", "127.0.0.1", "--persist-to", STATE, "--env-file", envFile, "--show-interactive-dev-session=false", "--log-level", "warn"], { cwd: APP, stdio: ["ignore", "inherit", "inherit"] });
  await waitFor("worker /health", () => fetch(`http://127.0.0.1:${WORKER_PORT}/health`).then((r) => r.ok).catch(() => false));

  console.log("3/9 wrong secret -> 401");
  check((await post({ update_id: 1 }, "nope")).status === 401, "expected 401");

  console.log("4/9 vitals text in the group -> inbox, no group reply (ack_mode all); redelivery is a no-op");
  const text = { update_id: 900001, message: { message_id: 1, date: now(), chat: { id: GROUP }, from: { id: ALICE, is_bot: false }, text: "120/80 72" } };
  check((await post(text)).status === 200, "webhook not 200");
  check((await post(text)).status === 200, "redelivery not 200");

  console.log("5/9 photo -> R2 copy at ingest");
  const photo = { update_id: 900002, message: { message_id: 2, date: now(), chat: { id: GROUP }, from: { id: ALICE, is_bot: false },
    photo: [{ file_id: "small", file_unique_id: "u-s", width: 90, height: 120, file_size: 1000 }, { file_id: "bp-large", file_unique_id: "u-bp", width: 960, height: 1280, file_size: 9000 }] } };
  check((await post(photo)).status === 200, "photo webhook not 200");
  check(telegramCalls.some((c) => c.method === "getFile" && c.body.file_id === "bp-large"), "largest photo not fetched");
  const rows = d1("SELECT update_id, kind, media_key, media_status, ack, status FROM inbox ORDER BY update_id");
  check(rows.length === 2, `expected 2 inbox rows, got ${rows.length}`);
  check(rows[1].media_status === "stored" && rows[1].media_key === "telegram/u-bp", `media not stored: ${JSON.stringify(rows[1])}`);
  check(sent().length === 0, `the bot posted ${sent().length} message(s) in the group`);
  const obj = wrangler(["r2", "object", "get", `${BUCKET}/telegram/u-bp`, "--local", "--persist-to", STATE, "--pipe"], { encoding: "buffer" });
  check(obj.length === 10 && obj[0] === 0xff, "R2 object missing or wrong");

  console.log("    admin private chat -> stored, acked in the DM only (plain English)");
  const dm = { update_id: 900003, message: { message_id: 3, date: now(), chat: { id: ADMIN }, from: { id: ADMIN, is_bot: false }, text: "wajan 70" } };
  check((await post(dm)).status === 200, "admin DM webhook not 200");
  const dmAck = await waitFor("admin DM ack", () => sent()[0]);
  check(String(dmAck.body.chat_id) === String(ADMIN) && dmAck.body.text === "Carol: weight 70 kg ✓", `unexpected DM ack: ${JSON.stringify(dmAck.body)}`);
  check(sent().every((c) => String(c.body.chat_id) !== String(GROUP)), "a message reached the group");

  console.log("6/9 batch pull (fake Cloudflare REST over the same local D1/R2) -> raw + media in a scratch repo");
  await new Promise((r) => { dev.once("exit", r); dev.kill("SIGTERM"); });
  dev = null;
  proxy = await getPlatformProxy({ persist: { path: join(STATE, "v3") } });
  cf = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const q = req.url.match(/\/client\/v4\/accounts\/[^/]+\/d1\/database\/[^/]+\/query$/);
      const o = req.url.match(/\/client\/v4\/accounts\/[^/]+\/r2\/buckets\/[^/]+\/objects\/(.+)$/);
      if (q && req.method === "POST") {
        const parsed = JSON.parse(body);
        const qs = parsed.batch ?? [parsed]; // {sql, params} or {batch: [{sql, params}, ...]} (one result per statement)
        const out = await proxy.env.DB.batch(qs.map(({ sql, params = [] }) => proxy.env.DB.prepare(sql).bind(...params)));
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ success: true, result: out.map((r) => ({ results: r.results, meta: { changes: r.meta.changes } })) }));
      }
      const obj = o && (await proxy.env.MEDIA.get(decodeURIComponent(o[1])));
      if (obj) {
        res.writeHead(200, { "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream" });
        return res.end(Buffer.from(await obj.arrayBuffer()));
      }
      res.writeHead(404).end();
    } catch {
      res.writeHead(500).end();
    }
  });
  await new Promise((r) => cf.listen(CF_PORT, "127.0.0.1", r));
  root = mkdtempSync(join(tmpdir(), "saturn-e2e-records-"));
  cpSync(join(EXAMPLE, "records.yaml"), join(root, "records.yaml"));
  cpSync(join(EXAMPLE, "meta"), join(root, "meta"), { recursive: true });
  const digest = join(root, "digest.txt");
  const batchEnv = {
    ...process.env, CLOUDFLARE_API_BASE: `http://127.0.0.1:${CF_PORT}/client/v4`, CLOUDFLARE_API_TOKEN: "e2e", CLOUDFLARE_ACCOUNT_ID: "e2e",
    D1_DATABASE_ID: "e2e", R2_BUCKET: BUCKET, TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_API_BASE: `http://127.0.0.1:${STUB_PORT}`,
    CLAUDE_BIN: join(APP, "scripts", "fake-claude.mjs"), CLAUDE_CODE_OAUTH_TOKEN: "", ANTHROPIC_API_KEY: "", SARVAM_API_KEY: "", GITHUB_OUTPUT: "",
  };
  // Async on purpose: the fake Cloudflare API runs in this process and must keep serving while the batch runs.
  const batch = (args, extra = {}) => new Promise((resolve) => {
    execFile("npx", ["tsx", "batch/run.ts", ...args, "--records", root, "--digest", digest], { cwd: APP, encoding: "utf8", env: { ...batchEnv, ...extra } },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: `${stdout}${stderr}` }));
  });
  const pulled = await batch(["pull"]);
  check(pulled.code === 0, `pull failed (${pulled.code}): ${pulled.out}`);
  const rawDir = join(root, "data", "telegram", "raw");
  const raw = readdirSync(rawDir).flatMap((f) => readFileSync(join(rawDir, f), "utf8").split("\n").filter(Boolean));
  check(raw.length === 3, `expected 3 raw rows, got ${raw.length}`);
  const media = readdirSync(join(root, "sources", "alice", "media", "telegram"));
  check(media.length === 1, `expected 1 media file in git, got ${media}`);

  console.log("7/9 extract with Claude auth failing -> exit 3, extraction delayed, rows stay new");
  const delayed = await batch(["extract"], { CLAUDE_CONFIG_DIR: join(tmpdir(), "fake-claude-auth") }); // the CLI child gets CHILD_ENV_ALLOW only
  check(delayed.code === 3, `expected exit 3, got ${delayed.code}: ${delayed.out}`);
  check(!existsSync(digest), "a delayed run wrote a digest file (the family would get it)");
  const waiting = (await proxy.env.DB.prepare("SELECT status FROM inbox").all()).results;
  check(waiting.some((r) => r.status === "new"), `delayed rows not left new: ${JSON.stringify(waiting)}`);
  check(existsSync(`${digest}.ops`), "a delayed run wrote no ops lines for the admin");
  const beforeOps = sent().length;
  const opsRun = await batch(["finish"]);
  check(opsRun.code === 0 && opsRun.out.includes("group posts 0"), `delayed finish: ${opsRun.out}`);
  const opsDm = sent().slice(beforeOps);
  check(opsDm.length === 1 && String(opsDm[0].body.chat_id) === String(ADMIN) && /did not complete/.test(opsDm[0].body.text) && /extraction delayed/.test(opsDm[0].body.text),
    `ops DM: ${JSON.stringify(opsDm.map((c) => c.body))}`);

  console.log("8/9 extract (fake claude) -> NDJSON + KB build");
  const ok = await batch(["extract"]);
  check(ok.code === 0, `extract failed (${ok.code}): ${ok.out}`);
  const kb = readdirSync(join(root, "data", "telegram")).filter((f) => f.endsWith(".ndjson") && f !== "directory.ndjson")
    .flatMap((f) => readFileSync(join(root, "data", "telegram", f), "utf8").split("\n").filter(Boolean)).map((l) => JSON.parse(l));
  check(kb.some((r) => JSON.stringify(r).includes('"value":120') && JSON.stringify(r).includes('"value2":80')), "BP 120/80 not in NDJSON");
  const built = execFileSync("python3", ["-I", join(APP, "..", "tools", "kb", "build"), "--records", EXAMPLE, "--telegram", join(root, "data", "telegram"), "--db", join(root, "kb.sqlite")], { encoding: "utf8" });
  check(built.startsWith("ok:"), `kb build: ${built}`);

  console.log("9/9 finish -> inbox rows done, digest DM'd to the admin, nothing to the group");
  const before = sent().length;
  const fin = await batch(["finish"]);
  check(fin.code === 0, `finish failed: ${fin.out}`);
  check(fin.out.includes("webhook: ok (gate closed"), `webhook assertion: ${fin.out}`);
  const done = (await proxy.env.DB.prepare("SELECT status FROM inbox").all()).results;
  check(done.length === 3 && done.every((r) => r.status === "done"), `inbox not done: ${JSON.stringify(done)}`);
  const digests = sent().slice(before);
  check(digests.length >= 1 && digests.every((c) => String(c.body.chat_id) === String(ADMIN)), `digest not DM'd to the admin only: ${JSON.stringify(digests.map((c) => c.body.chat_id))}`);
  // The texts were recorded by the delayed run (no LLM needed); this run adds the photo: one admin question, English.
  check(digests.some((c) => c.body.text.includes("device reading photo could not be read")) && digests.every((c) => !/[\u0900-\u097F]/.test(c.body.text)),
    `digest content (English, the photo question): ${digests.map((c) => c.body.text).join("\n---\n")}`);
  check(readFileSync(join(root, "data", "telegram", "digests.jsonl"), "utf8").includes('"date":'), "digest not logged");

  console.log("    second full run the same day -> digest skipped (one per day)");
  check((await batch(["extract"])).code === 0, "re-extract failed");
  const before2 = sent().length;
  const again = await batch(["finish"]);
  check(again.code === 0 && again.out.includes("digest skipped"), `second finish: ${again.out}`);
  check(sent().slice(before2).length === 0, "a second digest was sent");
  check(telegramCalls.filter((c) => c.method === "sendMessage").every((c) => String(c.body.chat_id) !== String(GROUP)), "the bot posted to the group");

  console.log("\nE2E PASS: secret check, idempotent inbox insert, group input-only (no bot posts), admin DM ack, media to R2, batch pull/extract/KB/finish, admin-only digest, delayed path");
}

main()
  .then(() => (process.exitCode = 0))
  .catch((err) => {
    console.error("\nE2E FAIL:", err.message);
    console.error("telegram calls:", JSON.stringify(telegramCalls.map((c) => c.method)));
    process.exitCode = 1;
  })
  .finally(() => {
    dev?.kill("SIGTERM");
    stub.close();
    cf?.close();
    proxy?.dispose();
    if (root) rmSync(root, { recursive: true, force: true });
    setTimeout(() => process.exit(), 1000);
  });
