---
title: "Deploy runbook (generic)"
audience: engineer
type: how-to
owner: maintainer
last_reviewed: 2026-10-26
review_every: 90d
status: active
sources: [../decisions/005-ingest-and-batch.md, ../decisions/008-product-environment-pii.md, ../security.md]
generated: false
---

# Deploy runbook (Workers FREE plan, ADR 005)

How to stand up one Saturn environment. The product holds **templates and scripts only**; every concrete value (account id, resource names and ids, URLs, chat ids, run history) lives in an **env repo** (`<env-repo>`, [ADR 008](../decisions/008-product-environment-pii.md)). Concrete values and the history of one deployment are in that env repo, never here.

**[USER]** steps need an account, a credential or a phone; **[AGENT]** steps an agent can run once the credentials exist. Design: [ADR 005](../decisions/005-ingest-and-batch.md). The Worker only stores, copies media and acks; extraction and the digest run daily in GitHub Actions.

## The pieces

| Piece | Where | What |
|---|---|---|
| Contract | product `env.manifest.yaml` | required resources (Worker, D1 + `app/migrations`, R2 bucket), vars (`WORKER_URL`, `GO_LIVE`, …), secret **names** with consumer, scope and max TTL, adapter choices, supported `schema_version` |
| Values | env `env.yaml` | the values the manifest asks for: account id, `worker` (default `saturn-bot`), `d1.name` (default `saturn`), `d1.id` (pinned after first deploy), `r2.bucket` (default `saturn-media`), `WORKER_URL`, `GO_LIVE`, adapter choices, caps |
| Secrets | env `secrets/*.sops.yaml` | SOPS + age encrypted; decrypted only in CI or on the operator's machine, never printed |
| Version | env `product.lock` | product tag + commit SHA the env runs |
| Deploy | product `deploy/deploy.sh` | renders `deploy/wrangler.template.toml` from `env.yaml`, applies `app/migrations`, deploys the Worker, pushes the Worker secrets |
| Batch | product `deploy/batch.sh` | the daily pull → extract → finish run (`app/batch/run.ts … --records <records-dir>`) |
| Workflows | product `deploy/github/{batch,deploy,records-pages,records-validate}.yml` + `deploy/github/ci` | thin templates the env repo copies into `.github/workflows/` and `scripts/ci`; every value comes from `env.yaml`/`product.lock`; they check out the product at the lock tag (verified against the pinned commit), mint a per-job records App token, decrypt each step's SOPS files at runtime (`ci run`, one standing secret `SOPS_AGE_KEY`) and call the scripts |

Nothing secret goes into any git repo in plain text. Local copies of secrets, if any, live outside every repo in files of mode 0600 and are passed by stdin, never argv or the terminal.

## Secrets (names only)

| Secret | Scope | Used by |
|---|---|---|
| `CLOUDFLARE_DEPLOY_TOKEN` | Workers Scripts Edit, D1 Edit, Account Settings Read; account-owned; TTL ≤ 1 y | deploy |
| `CLOUDFLARE_D1_TOKEN` | D1 Edit only; account-owned; TTL ≤ 1 y | batch |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | S3 key pair, Object Read only, one bucket | batch |
| `CLOUDFLARE_ACCOUNT_ID` | an id, not a credential | both |
| `TELEGRAM_BOT_TOKEN` | whole bot | both (deploy pushes it to the Worker) |
| `TELEGRAM_WEBHOOK_SECRET` | one endpoint; 256-bit random | deploy |
| LLM adapter credential (e.g. `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`) | model requests only | batch |
| `SARVAM_API_KEY` | optional STT (`sarvam` adapter; `whisper-cpp` needs no key) | batch |
| `BATCH_SIGNING_KEY` | SSH key that signs batch commits to the records repo; batch paths only (the env's records-integrity check pins its public half) | batch commit steps only |
| `HEALTHCHECK_URL` | optional heartbeat (finish: GET after a digest, `/fail` after a failed or delayed run) | batch |

Which LLM credential to use (a subscription token or an API key) is an env choice, made in `env.yaml`. The reasoning behind each scope is in [security.md](../security.md).

## Checklist

1. [AGENT] Local checks pass: in `app/`, `npm ci && npm test && npm run typecheck && npm run e2e:local`; from the repo root `python3 -I tools/kb/test_build.py` and `python3 -I tools/kb/build --records fixtures/records-example --check`.
2. [USER] Cloudflare: a free account is enough; Workers Paid is not needed. Dashboard → R2 → complete the R2 subscription checkout (free tier; Cloudflare may ask for a payment method).
3. [USER] Create the env repo from the env template: `env.yaml`, `product.lock`, `.sops.yaml` with the operator's age key, and the workflow files copied from `deploy/github/`. Fill `env.yaml` with names (or keep the defaults) and leave `d1.id` empty.
4. [USER] LLM adapter credential: create it per the adapter's docs (for `claude-cli`, `claude setup-token` in a local terminal, never in a chat) and put it straight into the SOPS file. Record its creation date in `env.yaml` (`llm.token_created`); the digest warns 30 days before expiry. On a usage-limit or auth failure the digest says "extraction delayed", the inbox rows stay unprocessed and the next run retries.
5. [USER] STT is optional. With the `none` adapter, voice notes are stored and the admin digest lists "voice note: transcription pending". `whisper-cpp` (recommended) transcribes on the runner itself: no key, no audio leaves the runner; the workflow builds whisper.cpp at a pinned tag and fetches the pinned model (both sha-checked, cached), and `batch.stt_max_audio_min` / `stt_max_runtime_min` cap a run. To use `sarvam` instead, opt out of model training first, then add `SARVAM_API_KEY`. Either way the next run transcribes the waiting notes; a voice note that is not transcribed, read with low confidence, or yields nothing from more than 10 s stays listed "to check" in the digest until a person adds it to the records' `data/telegram/listened.ndjson`.
6. [USER] Thresholds: the digest shows rule annotations marked "unverified; doctor sign-off pending" until a clinician reviews the records repo's `config/thresholds.yaml` or the household accepts that label. Without that file the rules are disabled and the digest says thresholds are not configured.
7. [USER] Tell the household what to expect: with `ack_mode: off` (the default) the bot stays silent in the group and the evening summary shows what was recorded and for whom; with `vitals-only` / `all` it echoes numbers ("Maa: BP 120/80, pulse 72 ✓"; resend or edit if wrong). Start a message with a name ("maa 116/47") to log it for someone else; the admin fixes a wrong one by replying `/for <name>` to it. The summary comes with questions; it never gives medical advice; in an emergency, phone the local emergency number.
8. [USER] Telegram: create the bot with @BotFather (token straight into the SOPS file). Create the group, add the bot, **make it admin with every right off** (admins receive photos and voice notes; leave privacy mode at default). If a bot token was ever pasted into a chat or log, revoke and replace it first.
9. [USER] Each member sends one group message. [AGENT] reads the ids with `getUpdates` (works only before a webhook is set) and records the group id and each sender id in the env repo's allowlist file (ids and role labels only, never names; role `member`, or `admin` for whoever runs ops; the admin also opens a private chat with the bot and sends /start so ops DMs can reach them).
10. [USER] Cloudflare → Manage Account → **Account API Tokens** → Create Custom Token, twice (deploy and D1 tokens, scopes above). Only this account; set an expiry and calendar the renewal; IP filtering off (GitHub runners vary). Create the R2 S3 key pair (Object Read only, the one bucket) after the first deploy has created the bucket. All go into the SOPS file.
11. [AGENT] Webhook secret: generate 32 random bytes (`openssl rand -hex 32`) straight into the SOPS file, never printed.
12. [AGENT] First deploy: run the env repo's deploy workflow (manual dispatch, `confirm` = `deploy-<stage>`), or locally `deploy/deploy.sh --env <env.yaml>`. It
    1. renders `deploy/wrangler.template.toml` from `env.yaml` into a temp `wrangler.toml` (never committed);
    2. lets wrangler **auto-provision** D1 and R2 on first deploy when `d1.id` is not pinned;
    3. applies `app/migrations` to the remote D1;
    4. deploys the Worker and pushes `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` as Worker secrets;
    5. smoke-tests `/health` (→ `ok`) and an unauthenticated webhook POST (→ 401).
13. [AGENT] **Pin the D1 id**: copy the id the first deploy printed into `env.yaml` (`d1.id`) by PR in the env repo, and set `WORKER_URL` (`https://<worker>.<subdomain>.workers.dev`). Later deploys use the pinned id and never create a second database.
14. [AGENT] Dry batch: run the env repo's batch workflow with `send_digest=false` on the empty inbox: 0 pulled, 0 extracted, no digest. Before the secrets exist it skips with a notice.

**GO-LIVE GATE (records owner approval required).** Until the owner explicitly says go: no Telegram webhook (step 15), no real chat or user ids in D1 (step 15 allowlist load), no real files in R2, no batch run except on an empty inbox or synthetic data, and nothing copied from a records repo into D1 or R2. Synthetic smoke tests are fine only with a chat id that is not allowlisted, and the test rows are deleted afterwards. Record the decision and its date in the env repo.

15. [AGENT] (after the gate) Load the allowlist into D1 from the env repo's allowlist file (chat id; the label is a free note, e.g. `members-silent`: the group is input-only, ADR 011; each sender id with its role `member` or `admin`, mapped to a namespace by the records repo's `d1_person_map`). Register the webhook with `setWebhook` (`url=$WORKER_URL/telegram/webhook`, the webhook secret as `secret_token`, `max_connections=5`, `drop_pending_updates=true`, `allowed_updates=["message","edited_message"]`), check `getWebhookInfo` (url set, no `last_error_message`), then set `GO_LIVE=true` in `env.yaml`. Order matters: until `GO_LIVE=true` the batch fails if **any** webhook is set; once it is `true` it fails if the URL is anything but `WORKER_URL/telegram/webhook`.
16. [USER] BotFather `/setjoingroups` → Disable (after the bot is in the group).
17. [USER] + [AGENT] Smoke test (the agent runs `npx wrangler tail` and a D1 check):
    1. `curl $WORKER_URL/health` → `ok`.
    2. With `ack_mode: all` for the test: a member sends `120/80 72` → "<name>: BP 120/80, pulse 72 ✓"; an edit → a correction ack; `<alias> 116/47` → "<that member>: BP 116/47 ✓". With `off`: no reply at all.
    3. A photo, a 10 s voice note and a PDF each get their localised ack (`all` only).
    4. The admin replies `/for <name>` to a member's message → a private DM "✓ ठीक किया …"; D1 `subject_corrections` has the row.
    5. D1: `SELECT update_id, person_id, kind, media_status, ack, status FROM inbox ORDER BY update_id DESC LIMIT 10` → media rows `stored`, all `new`.
18. [AGENT] Run the batch. Expect a raw commit and a batch commit in the records repo, the digest as a private DM to the admin (nothing in the group, ADR 011), and any ops alert as a separate short admin DM. The admin must have started a private chat with the bot first. It then runs daily on the env's schedule. A run whose extraction was delayed still commits, sends only the ops DM (no digest), then fails the job (exit 3) so the failure email or heartbeat fires.
19. [USER] Optional heartbeat (e.g. healthchecks.io: period 1 day, grace 3 h): its ping URL is the `HEALTHCHECK_URL` secret. The admin's digest DM itself is the human-visible heartbeat.

## Hardening

### Deploy gate
GitHub Free gives private repos no environment required-reviewers, so the deploy workflow **never deploys on push**. A push runs tests only (no secrets). To deploy: manual dispatch with `confirm` = `deploy-<stage>`, from the default branch, after the test job passes. Limit: this stops accidental deploys, not a malicious collaborator.

### Workflow guard
On every push that touches `.github/`, each commit must be signed (Verified) and by the env owner (or a GitHub UI merge, or Dependabot); otherwise the run fails, and after go-live it also DMs `ALERT_CHAT_ID` through the bot. It **detects, it cannot prevent** (see [security.md](../security.md)). Operators sign their commits (`git config --global gpg.format ssh`, a signing key uploaded to GitHub, `commit.gpgsign true`). Require actions pinned to a full SHA and allow GitHub-owned actions only; Dependabot bumps the pins.

### Credential rotation
Rule: **create new → update the SOPS file → redeploy or re-run → verify → revoke old.**
- **Bot token:** BotFather `/revoke` (the old token dies at once) → SOPS → deploy (pushes the Worker secret) → `getMe` ok → after go-live only, `setWebhook` again with the **same** webhook secret. Before go-live, never set a webhook; the next batch asserts the URL is still empty.
- **Cloudflare tokens:** create the replacement with the same scope → SOPS → run the consumer once → delete the old token → check the audit log for later use of it.
- **LLM / STT keys:** revoke in the vendor console, replace in SOPS, re-run.

## Operating notes
- Inbox rows are deleted 14 days after they are committed (`INBOX_RETENTION_DAYS`). R2 objects are kept (second copy of the media).
- Re-running the batch is always safe. Inputs: `retry_failed` re-extracts messages that failed permanently; `send_digest: false` avoids a second digest the same day.
- The LLM CLI version is pinned in the batch workflow; bump it deliberately and run once by hand.
- Thresholds: edit the records repo's `config/thresholds.yaml`, bump `version`, set `setBy`/`effectiveFrom`, commit to the records repo; the next batch run validates and uses it (no product release; they only change digest annotations). See [records guide](../records-guide.md).
- Deep reads: the `needs_deep` queue in the records repo; runbook in ADR 005.
- Answer by reply: digest questions, unread documents and voice notes to check are numbered; the admin replies `3 yes, left hand`, `done 1` or `2 heard` in the private chat and the next batch logs it to the records' `data/telegram/answers.ndjson` (`question_ref`, `text`, `by`, `at`, `message_key`), drops the item from the standing lists and acknowledges it under "Answered". Numbers refer to the latest delivered digest (`digests.jsonl` `items`); replies from a group or a member's chat are never read as answers.
- Unread documents: every document, prescription, strip photo or report file with no recorded facts stays in the digest (oldest first, 10 shown) until a reply `<n> handled` or a `handled-manually.ndjson` row.
- Failure DMs: a step that throws leaves a `batch failed at <step>` ops line that finish DMs; an empty run says "No new messages. Last reading N days ago". Dead-man: set `HEALTHCHECK_URL` (finish pings it after a digest, `/fail` after a failed or delayed run); the heartbeat service, not the batch, alerts when no run completes by its deadline (e.g. 03:30 IST).
- Telegram stops redelivering after 24 h: if the Worker is down, fix it the same day.

## Roll back

| Problem | Action |
|---|---|
| Bad Worker deploy | `npx wrangler deployments list`, then `npx wrangler rollback <version-id>`; or pin the previous tag in `product.lock` and redeploy |
| Stop all intake now | `deleteWebhook` (Telegram keeps updates ≤ 24 h; `setWebhook` to resume) |
| Stop the batch | disable the batch workflow in the env repo (rows wait in D1; nothing is pruned until committed) |
| Bad data from a batch | `git revert` the batch commit in the records repo; the raw commit stays; re-run (`retry_failed` if needed) |
| Bad D1 change | `npx wrangler d1 time-travel restore <d1-name> --timestamp=<RFC3339>` (Free keeps 7 days). D1 is only an inbox: anything committed is in git |
| Workflow guard failed, not you | assume every env secret leaked: rotate all of them, check the Actions runs for unknown runs, delete the branch |
| Batch failed on the webhook assertion | `getWebhookInfo`. Unknown URL: `deleteWebhook`, rotate the bot token, then `setWebhook` to the Worker |
| Leaked credential | rotate per "Credential rotation" |
