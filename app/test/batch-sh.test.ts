// deploy/batch.sh guards (shell, synthetic repos): the AI step refuses to run with a write credential in sight, and a
// batch commit is signed and limited to the batch paths.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const BATCH = join(import.meta.dirname, "..", "..", "deploy", "batch.sh");
let d: string;
let records: string;
const sh = (cwd: string, ...a: string[]) => execFileSync(a[0], a.slice(1), { cwd, encoding: "utf8" }).trim();
const base = () => ({ PATH: process.env.PATH!, HOME: d, RUNNER_TEMP: d, TARGET_BRANCH: "main", GIT_CONFIG_NOSYSTEM: "1" });
const batch = (env: Record<string, string>, ...args: string[]) => spawnSync("bash", [BATCH, ...args, "--records", records], { env: { ...base(), ...env }, encoding: "utf8" });

beforeEach(() => {
  d = mkdtempSync(join(tmpdir(), "batch-sh-"));
  const remote = join(d, "remote.git");
  sh(d, "git", "init", "-q", "--bare", "-b", "main", remote);
  records = join(d, "records");
  sh(d, "git", "clone", "-q", remote, records);
  for (const [k, v] of [["user.name", "t"], ["user.email", "t@example.com"]]) sh(records, "git", "config", k, v);
  writeFileSync(join(records, "records.yaml"), "schema_version: 7\n");
  sh(records, "git", "add", "-A");
  sh(records, "git", "commit", "-q", "--no-gpg-sign", "-m", "init");
  sh(records, "git", "push", "-q", "origin", "HEAD:main");
});
afterEach(() => rmSync(d, { recursive: true, force: true }));

describe("assert-isolated (the AI step)", () => {
  it("passes with model auth only (and the workflow's non-secret names: SOPS file lists, token dates)", () => {
    const r = batch({ CLAUDE_CODE_OAUTH_TOKEN: "tok", SECRETS_EXTRACT: "secrets/claude-ci.sops.env", SECRETS_KEYS: "secrets/github.sops.env",
      CLAUDE_TOKEN_CREATED: "2026-10-25", EXTRACT_MAX_MEDIA_CALLS: "30" }, "assert-isolated");
    expect(r.status, r.stderr).toBe(0);
  });
  it.each(["SOPS_AGE_KEY", "GH_TOKEN", "GITHUB_TOKEN", "RECORDS_TOKEN", "BATCH_SIGNING_KEY", "RECORDS_APP_PRIVATE_KEY", "TELEGRAM_BOT_TOKEN", "SOME_NEW_TOKEN", "OTHER_API_KEY", "DB_PASSWORD"])("fails when %s is visible (names only in the log)", (v) => {
    const r = batch({ CLAUDE_CODE_OAUTH_TOKEN: "tok", [v]: "s3cr3t-value" }, "assert-isolated");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(v);
    expect(r.stderr + r.stdout).not.toContain("s3cr3t-value");
  });
  it("fails when the records checkout persisted a credential", () => {
    sh(records, "git", "config", "http.https://github.com/.extraheader", "AUTHORIZATION: basic eA==");
    expect(batch({}, "assert-isolated").status).toBe(1);
  });
});

describe("commit (deterministic step)", () => {
  const key = () => {
    sh(d, "ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "saturn-batch", "-f", join(d, "k"));
    const pub = readFileSync(join(d, "k.pub"), "utf8").split(" ");
    writeFileSync(join(d, "signers"), `saturn-batch@example ${pub[0]} ${pub[1]}\n`);
    return readFileSync(join(d, "k"), "utf8");
  };
  it("signs with the batch SSH key and pushes only batch paths", () => {
    const k = key();
    mkdirSync(join(records, "sources/alice/media/telegram"), { recursive: true });
    writeFileSync(join(records, "sources/alice/media/telegram/u1.transcript.md"), "x\n");
    mkdirSync(join(records, "data/telegram"), { recursive: true });
    writeFileSync(join(records, "data/telegram/2026-10.ndjson"), "{}\n");
    const r = batch({ BATCH_SIGNING_KEY: k, REQUIRE_SIGNED: "1" }, "commit", "batch");
    expect(r.status, r.stderr).toBe(0);
    const v = sh(records, "git", "-c", "gpg.format=ssh", "-c", `gpg.ssh.allowedSignersFile=${join(d, "signers")}`, "log", "-1", "--format=%G?");
    expect(v).toBe("G");
    expect(sh(records, "git", "status", "--porcelain")).toBe("");
    expect(readFileSync(join(records, ".git/config"), "utf8")).not.toMatch(/signingkey|extraheader/);
  });
  it("refuses a change outside the batch paths, and an unsigned commit when signing is required", () => {
    const k = key();
    writeFileSync(join(records, "records.yaml"), "schema_version: 8\n");
    const r = batch({ BATCH_SIGNING_KEY: k, REQUIRE_SIGNED: "1" }, "commit", "batch");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("change outside the batch paths: records.yaml");
    sh(records, "git", "checkout", "--", "records.yaml");
    mkdirSync(join(records, "data/telegram"), { recursive: true });
    writeFileSync(join(records, "data/telegram/x.ndjson"), "{}\n");
    expect(batch({ REQUIRE_SIGNED: "1" }, "commit", "batch").status).toBe(1);
    mkdirSync(join(records, "sources/alice/documents"), { recursive: true });
    writeFileSync(join(records, "sources/alice/documents/a.pdf"), "x");
    expect(batch({ BATCH_SIGNING_KEY: k }, "commit", "batch").stderr).toContain("sources/alice/documents/a.pdf");
  });
});
