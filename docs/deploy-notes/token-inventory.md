---
title: "Token inventory (deploy notes, leaves the product at S7)"
audience: engineer
type: reference
owner: maintainer
last_reviewed: 2026-10-26
review_every: 90d
status: "route to env repo at S7, then delete from product"
sources: [docs/platform/token-architecture.md]
generated: false
---

# Token inventory (from token-architecture §1, §7, §9, §10)

Environment-specific. This file lists **what** must be routed to the env repo; the concrete values (account ids, token names as minted, hosts, paths, run state) already live there. **Values: see env repo.** No secret values appear here or anywhere in the product.

## 1. Where tokens live (as inventoried 2026-10-25)
| Store | What is there | Who can read it | Blast radius |
|---|---|---|---|
| `~/.config/<env>/*.env` (0600) | Cloudflare deploy token + account id; Telegram bot token + webhook secret; R2 values (admin, object and read, each as an API token plus an S3 key pair) | the owner's user and any process running as it (Claude Code and subagents, `npm` lifecycle scripts, editors), root, backups | deploy token = every Worker secret and all PHI. R2 admin = every bucket. At inventory time the admin and object R2 tokens were still on disk and were due for deletion |
| `~/.config/<agent-env>/*.env` (0600) | owner admin router token, runner token, third-party model key | same | admin = the whole router; runner = claim jobs; model key = the balance |
| macOS login Keychain (Claude Code credentials item) | interactive `/login` OAuth access + refresh token (falls back to a 0600 file when the keychain is locked) | apps on the item ACL | model requests, account standing |
| GitHub repo secrets (`<owner>/<env-repo>`) | `CLOUDFLARE_DEPLOY_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_R2_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` (off), `SARVAM_API_KEY`, `HEALTHCHECK_URL`; later `AGENT_ROUTER_TOKEN` | any workflow on any branch (GitHub Free has no environment secrets) | the union of everything listed |
| Worker secrets (`<worker>`) | bot token, webhook secret; bindings `DB`, `MEDIA` | Worker code; anyone with Workers Scripts Edit | bot hijack; all D1 and R2 PHI |
| Router D1 token table | SHA-256 hashes of router tokens + scopes | holders of a D1 token on the same account (D1 Edit is account-wide, so a hash row can be forged) | router admin forgery if the router shares the account |
| Home server (future) | per-user systemd credentials, runner tokens, model key, GitHub App key | root, the unit's user | per-user scoped |
| Claude Code transcripts (`~/.claude/projects/`) | every secret ever pasted or printed in a session (main leak path) | the owner's user; every later session | whatever was pasted |
| Dispatcher job transcripts | model I/O, known secrets redacted, PHI deleted at job end | user | low |

## 2. Credential table (as inventoried)
| Credential | Stored | Consumers | TTL then → proposed |
|---|---|---|---|
| CF deploy token | GH secret; sops | deploy workflow | none → 1 y |
| CF batch D1 token | GH secret; sops | batch | none → 1 y |
| R2 S3 read key (`<bucket>`) | GH secret; sops | batch media read | none → 1 y; extra R2 tokens to delete |
| Telegram bot token | Worker secret, GH, sops | Worker, batch | ∞ → annual + on suspicion |
| Telegram webhook secret | Worker secret, GH | Telegram → Worker | ∞ → 180 d |
| `CLAUDE_CODE_OAUTH_TOKEN` ×3 (CI, two dispatchers) | GH; systemd-creds | batch, dispatchers | fixed 1 y → rotate at 11 months |
| Anthropic API fallback | GH → WIF (nothing stored) | batch fallback | ∞ → 600 s, bound to `repo:<owner>/<env-repo>:ref:refs/heads/main` |
| Third-party model key | sops; systemd-creds | agent dispatcher | ∞ → 180 d, low balance cap |
| Sarvam key | GH | batch | ∞ → annual |
| Router owner / batch client / runners | sops; GH; systemd-creds | agentctl, batch, dispatchers | ∞ → 90 d / 180 d / 180 d |
| GitHub App (dispatcher) private key | systemd-creds | dispatcher PRs | key ∞ → annual; token 1 h |

## 3. Open actions and decisions at inventory time
- Delete the extra R2 admin and object tokens and their S3 keys; finish the rotation runbook and the transcript purge (owner, 15 min).
- Decisions then open: GitHub Team vs personal Pro (later superseded by the no-Team posture, env repo split plan §6a); a second Cloudflare account for the router; who holds the offline age backup key; whether the Anthropic API fallback is wanted at all (WIF needs a Console org with billing).
