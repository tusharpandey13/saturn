---
title: "Security model"
audience: engineer
type: reference
owner: maintainer
last_reviewed: 2026-10-26
review_every: 90d
status: active
sources: [platform/hld.md, platform/token-architecture.md, decisions/008-product-environment-pii.md]
generated: false
---

# Security model

The generic threat model, controls and credential-scoping principles for any Saturn deployment. Vendor facts were checked against official docs on 2026-10-25 (links inline); claims marked *unverified* were not found there. The concrete credential inventory and incident history of one deployment live in its env repo. Related: [token architecture](platform/token-architecture.md), [deploy runbook](platform/deploy.md), [ADR 008](decisions/008-product-environment-pii.md).

**Design stance.** PHI travels as refs, not content, wherever it can: scoped router tokens, fencing tokens, the Telegram secret header compared in constant time, and the batch LLM call run with tools disabled. The typical exposures are operational: secrets pasted into chats or transcripts, one token doing several jobs, and CI platforms that cannot fence secrets from any branch.

## 1. Principals and hops

| Principal → resource | Mechanism | Scope | Blast radius if leaked | Control |
|---|---|---|---|---|
| Telegram → ingest Worker | `X-Telegram-Bot-Api-Secret-Token` (256-bit), constant-time compare; D1 allowlist of chats and senders (plus each admin's own private chat, ADR 011; the bot never posts to a group) | one endpoint | forged updates from allowlisted ids → false facts (integrity), no read | rotate by `setWebhook` + deploy; optional source-IP check |
| Worker → D1 / R2 | bindings | one DB, one bucket | only reachable by deployed code | `preview_urls = false` (preview URLs expose the same bindings) |
| Worker / batch → Telegram API | bot token | whole bot | `setWebhook` hijack (intercept new messages), `getFile` on known file ids, messages sent as the bot | rotate on any exposure; batch asserts the webhook URL |
| CI deploy → Cloudflare | API token: Workers Scripts Edit, D1 Edit, Account Settings Read | account | deploy code that reads **every Worker secret and binding** | deploy job only; manual dispatch; account-owned; TTL ≤ 1 y |
| CI batch → D1 REST | API token: D1 Edit only | account (D1 has no per-database scope) | read/write every D1 in the account | separate from deploy; separate CF account for hard isolation |
| CI batch → R2 | S3 key pair, Object Read only | one bucket | read that bucket's media | no standing write or admin keys |
| CI → git push | `GITHUB_TOKEN` (`contents: write` only where needed) | one repo, one job | push for that job | read-only default; SHA-pinned actions |
| CI / runners → LLM | subscription setup-token or API key (an env choice) | model requests only | usage limits, spend or account standing | one credential per consumer; spend caps; expiry warning |
| Batch → agent router | hashed bearer | `submit_classes`, `tasks` | submit jobs within caps; read own job refs | server-side minimum data class per task; `expires_at`, `last_used_at` |
| Runner → router | runner bearer | `claim_classes`, `harnesses` | claim job refs of its class | bind `runner_id` to the token |
| Runner → GitHub (PRs) | GitHub App installation token (1 h) | contents + pull_requests, **no `workflows`** | push branches, open PRs; cannot change workflows | one repo per installation |
| Operator → tailnet → SSH | IdP login + node keys | ACL grants | shell on the PHI runner | grants, tags, SSH check mode, device approval |
| Operator → vendor dashboards | password + 2FA | whole account | everything above | passkeys or security keys everywhere; org "require 2FA" |

## 2. Vendor constraints (Cloudflare, GitHub, Telegram, LLM)

- **D1 scoping.** D1 Read and Edit are account-level only ([permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)). Accounts are the only hard boundary for Workers and D1.
- **R2 tokens.** Object permissions "are only supported by the S3-compatible API, not the Cloudflare REST API" ([r2 tokens](https://developers.cloudflare.com/r2/api/tokens/)); a REST GET with an Object token fails with `10002`. Least privilege for reads is the S3 API ([s3](https://developers.cloudflare.com/r2/api/s3/)) with an Object Read key scoped to one bucket. Admin permissions are account-wide; R2 has a payment method on file, so a leaked write or admin key can run up a bill.
- **IP filtering.** Tokens support client IP filters ([create token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)), but GitHub advises against runner ranges as allowlists ([runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)). Use IP filters only for tokens used from a host with static egress.
- **No OIDC to Cloudflare** (*unverified absence*, 2026-10): long-lived CI secrets are unavoidable, so keep TTLs short, scopes least and rotation calendared.
- **Rotation.** Roll invalidates the old value immediately ([roll](https://developers.cloudflare.com/fundamentals/api/how-to/roll-token/)); prefer create new → swap → verify → delete old. Account-owned tokens survive user changes.
- **Workers secrets** are write-only, but any Workers Scripts Edit holder can deploy code that reads them ([secrets](https://developers.cloudflare.com/workers/configuration/secrets/)): the deploy token equals secret read.
- **Audit logs** exist on all plans ([audit](https://developers.cloudflare.com/fundamentals/account/account-security/audit-logs/)); after a rotation, check the old token's last use.
- **Access / mTLS.** The ingest webhook cannot use Access or mTLS (Telegram cannot authenticate). Access is optional defence in depth for the router and should protect preview URLs.
- **GitHub Free, private repos.** No branch protection or rulesets ([rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)), no environment secrets or required reviewers ([environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)). Every secret is repo-level and readable by a workflow on **any** branch. ADR 008's answer: owner-only env repos, secret-free records repos, and a GitHub App without the `workflows` permission for automated writes.
- **Actions hardening.** Read-only `GITHUB_TOKEN` default; pin every `uses:` to a full SHA and enable the SHA-pinning policy ([changelog](https://github.blog/changelog/2025-08-15-github-actions-policy-now-supports-blocking-and-sha-pinning-actions/), [secure use](https://docs.github.com/en/actions/reference/security/secure-use)); secrets in step-level `env`, never job-level, so dependency install scripts never see them; `persist-credentials: false` on deploy checkouts.
- **Telegram.** The `secret_token` header is the documented webhook mechanism ([Bot API](https://core.telegram.org/bots/api#setwebhook)). Optional: log, then reject, source IPs outside Telegram's published ranges ([webhooks](https://core.telegram.org/bots/webhooks)). Until a webhook is set, anyone with the token can `getUpdates` and read queued messages (kept up to 24 h): revoke an exposed token **before** the bot joins a real group, and set the webhook with `drop_pending_updates=true` right after reading ids.
- **LLM subscriptions.** A setup-token "can only make model requests" and lasts 1 year ([auth](https://code.claude.com/docs/en/authentication)). Subscription limits assume ordinary individual use ([legal](https://code.claude.com/docs/en/legal-and-compliance)); products for other users must use API keys. Using a subscription is an env choice; if chosen, keep jobs owner-consumed and low-volume, the CLI unmodified, and the API-key path one setting away.
- **Prepaid providers.** Where a provider bills from a prepaid balance with no per-key limits (*assumed*), the balance is the cap: keep it small with no auto top-up, and never route PHI to it.
- **Tailnet.** Grants limited to the needed ports ([grants](https://tailscale.com/kb/1324/grants)); tagged nodes do not expire ([key expiry](https://tailscale.com/kb/1028/key-expiry)), so remove a stolen node; SSH check mode ([ssh](https://tailscale.com/kb/1193/tailscale-ssh)); Funnel off ([funnel](https://tailscale.com/kb/1223/funnel)).

## 3. Agent router controls
- Tokens: prefix + 32 random bytes, stored as SHA-256 (a fast hash is correct at 256-bit entropy). Rotation is mint → swap → revoke. Keep `expires_at` and `last_used_at`.
- Replay: bearer over TLS; idempotency keys and lease fencing make replays harmless. Loopback-only HTTP is acceptable; never expose plain HTTP on a network.
- **data_class enforcement** at submit (token `submit_classes`, task `max_class`, tier classes, refs-only params of ≤ 2 KB), claim (`claim_classes`), exec (runner re-check) and complete (no PHI inline). The class is client-declared, so PHI-producing clients get `submit_classes: ["phi"]` only and their tasks a server-side `min_class: phi`, so a mislabel is rejected. Enforce the `repos` scope against the output repo.

## 4. Threat model (likelihood × impact, asymmetric first)
| # | Threat | L | I | Primary control |
|---|---|---|---|---|
| 1 | Secrets pasted into chats, logs or agent transcripts get reused | High wherever it has happened | PHI, irreversible | rotate at once (create → swap → verify → revoke); purge transcripts; never paste |
| 2 | Secret exfiltration via a branch workflow (any push credential, dependency or bot) | Med | PHI + all tokens | App without `workflows`; owner-only env repos; SHA pins; step-scoped env; rulesets when available |
| 3 | Account takeover (GitHub, Cloudflare, tailnet IdP, LLM vendor) | Low–Med | PHI | passkeys or security keys; org-wide 2FA |
| 4 | LLM account suspension or limit drain from automated use | Med (subscription) | loses interactive and CI use | owner-consumed only, caps, presence guard, per-consumer tokens, API-key fallback |
| 5 | Prompt injection from untrusted documents or messages into a tool-enabled deep read | Med | PHI integrity; exfiltration bounded by egress | egress allow-list, PR review, App limited to one repo, batch extraction with tools off |
| 6 | Runaway spend (API keys, prepaid balances, R2 ops, Actions) | Low | money | vendor spend limits, small balances, no R2 write keys, Actions budget 0 |
| 7 | Forged webhook updates (secret leak) → false facts | Low | integrity | secret rotation, optional IP check, digest and PR review |
| 8 | Lost or stolen operator machine → local credential files | Low | host credentials | disk encryption, node removal, per-host revocation list |

## 5. Credential-scoping principles
1. **One credential, one job.** Never reuse the deploy token for the batch; the deploy token is used only by the deploy workflow.
2. **Least scope the vendor supports**, and record where it cannot go lower (D1 is account-wide; a separate account is the only hard fence).
3. **Short TTL, calendared**, account-owned for CI. Rotation is create → update consumers → verify → revoke, never revoke-first.
4. **No standing admin or write credentials** outside the runtime binding; admin work uses an interactive login.
5. **One LLM credential per consumer**, so a leak is one revocation and usage is attributable.
6. **Secrets never through chat, argv or logs.** Stdin or hidden prompts only; encrypted at rest (SOPS) in the env repo.
7. **Detect what you cannot prevent:** the batch asserts the webhook URL; a workflow guard alerts on unsigned or foreign commits to `.github/` (it detects, it cannot prevent: a malicious workflow in the same push runs in parallel).
8. **Env write = records write.** Whoever can write an env repo can reach its records and secrets (ADR 008 access parity).
