# Deploy notes: auth review 2026-10-25, incidents and inventory

Source: the old auth review (env class). The generic threat model is now [../security.md](../security.md). **Route to the env repo (`<env-repo>`) at S7, then delete from the product.** This file lists WHAT must be routed; token names, ids, hosts and values: see env repo. No secret values are recorded here.

## Incidents to route
1. **Pasted secrets still live** at review time: the Telegram bot token, the Cloudflare account token (used for deploy **and** batch), an R2 read token, two unused R2 tokens (object RW, admin RW) with S3 key pairs, and a prepaid LLM-provider key. Agent transcripts on the operator machine kept copies.
2. **One Cloudflare token doing three jobs** (deploy, batch D1, implicit secret read): `<deploy-token>`.
3. **GitHub Free, private org repo (`<org>`)**: no fence between branch workflows and repo secrets.
4. R2 REST read returned `10002` with the object token (S3-only permission); a third, account-wide read token worked (GET 200, PUT 403) and was wider than needed.

## Inventory gaps at review time (per hop)
| Hop | Gap then |
|---|---|
| Telegram → Worker | webhook not set; no source-IP check |
| Worker bindings | preview URLs enabled |
| Bot token | exposed in chat; in job-level `env` for every step |
| CI deploy token `<deploy-token>` | pasted; reused as the batch token |
| R2 read token `<r2-read-token>` | pasted; account-wide |
| R2 object RW / admin RW tokens | pasted, unused → delete |
| Actions | tag-pinned, not SHA-pinned |
| LLM subscription token | readable by any workflow on any branch |
| Router hl token | `repos` scope not enforced; no `expires_at` |
| Runner → router | `runner_id` not bound to the token |
| Runner → GitHub PRs | credential not chosen (target: App without `workflows`) |
| Runner host deploy keys | no expiry; cannot open PRs |
| Tailnet | ACLs not written; check mode off |
| Dashboards | passkey/2FA to confirm on all four vendors; org 2FA |
| Owner admin bearer | no expiry; router loopback-only |

## Rotation runbook as executed for this env
Rule: create new → update every consumer → verify → revoke old; values into 0600 files with an editor and into secrets with a hidden prompt (`gh secret set NAME -R <owner>/<env-repo>`), never into chat.
1. Prepaid LLM-provider key: new key → `<config-dir>` env file → restart the dispatcher → one public demo job → delete old.
2. New batch D1 token `<batch-d1-token>` (D1 Edit only, TTL 1 y) → batch secret → dry batch green. Must precede step 3.
3. New deploy token `<deploy-token-new>` → deploy secret → deploy green → delete `<deploy-token>`; check the audit log.
4. R2 read: interim replacement or Roll → verify a GET on a synthetic object → delete it; target S3 key pair `<r2-s3-key>` (Object Read, `<bucket>`).
5. Delete the R2 object RW and admin RW tokens; remove their lines from the local env files.
6. Bot token last (so its deploy uses the new deploy token), before the bot joins the group; regenerate the webhook secret if it was ever pasted.
7. Verify: secret list dates, the Cloudflare token list matches the final set, no old-token use in the audit log, transcripts purged.

## Final token set for this env (names: see env repo)
Deploy token (account-owned, TTL 1 y), batch D1 token, R2 S3 read key pair on `<bucket>`, bot token + webhook secret, one LLM token per consumer (CI, batch runner, agents runner), prepaid provider key (agents runner only, small balance), router tokens (owner admin, batch submit-phi, per-runner claim tokens), GitHub App `<app>` (contents + pull_requests, no `workflows`), optional API key with a spend limit. No standing R2 admin, no PATs, no RW deploy keys.

## Recommendations status at review time (ordered)
1. rotation runbook + transcript purge; 2. split CF tokens; 3. Actions hardening + `preview_urls = false`; 4. passkeys everywhere; 5. batch webhook assertion; 6. R2 over S3 read key; 7. GitHub App before PR automation; 8. router data-class hardening; 9. tailnet grants; 10. paid GitHub plan (amended 2026-10-26: superseded by the no-paid-plan posture of the split plan); 11. optional separate CF account, Telegram IP check.
