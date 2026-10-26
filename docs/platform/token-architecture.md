---
title: "Token architecture"
audience: engineer
type: explanation
owner: maintainer
last_reviewed: 2026-10-26
review_every: 90d
status: "proposal (2026-10-25)"
sources: [docs/security.md]
generated: false
---

# Token architecture: storage, OAuth, TTLs, DPoP, branch protection, secret managers (2026-10-25)

Status: **PROPOSAL**. This builds on the [security model](../security.md) and doesn't repeat its rotation runbook. Vendor claims were checked on 2026-10-25, with links inline. *Unverified* marks claims the official docs didn't settle. Deployment specifics (the token inventory, plan tier and prices, rotation dates, environment and client names) live in the environment repo.

**Bottom line.**
- **Nothing Saturn owns mints OAuth tokens.** The only OAuth credentials are Anthropic's. Everything else is a static bearer.
- **Short-lived federation is available in exactly two places:** a GitHub App (1 h tokens) and **Anthropic Workload Identity Federation** for the API-key fallback (GitHub OIDC → token, 10 min to 1 h). Cloudflare still has no OIDC.
- **The agent router doesn't need AT/RT or DPoP.** It needs `expires_at` and `last_used_at`, two-token overlap, and a single "rotation day".
- **Fence for repo secrets:** environment secrets limited to `main` (a paid GitHub plan) or, on Free, keeping secrets in the env repo only, with access parity (ADR 008).
- **Secret source of truth:** SOPS+age in the env repo. A home server uses systemd-creds (TPM), and Claude Code gets deny rules on the secret paths.

## 1. Where tokens live (model)
Each deployment has the same kinds of store. The per-deployment inventory is in the env repo.

| Store | What goes there | Who can read it | Blast radius |
|---|---|---|---|
| Owner config files `~/.config/<env>/*.env` (0600), or better `sops exec-env` | deploy token, account id, bot token, webhook secret, R2 keys, router tokens | the owner's user and **any process running as it**: Claude Code and its subagents, `npm` lifecycle scripts, editors; root, backups | deploy token = every Worker secret and all PHI. An R2 admin token = every bucket. Keep only least-scope tokens on disk |
| OS keychain | the interactive Claude `/login` OAuth credential, the age identity | apps on the item ACL while unlocked | model requests, account standing |
| GitHub secrets of the env repo | the secret **names** in `env.manifest.yaml` | on GitHub Free: **any workflow on any branch** of that repo ([envs](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)); values are write-only in the UI | the union of everything stored |
| Worker secrets | bot token, webhook secret; bindings `DB`, `MEDIA` | Worker code. **Anyone with Workers Scripts Edit can deploy code that reads them** ([secrets](https://developers.cloudflare.com/workers/configuration/secrets/)) | bot hijack; all D1 and R2 PHI through the bindings |
| Router D1 token table | SHA-256 of router tokens plus scopes | holders of a D1 token on the same account | hashes aren't usable as bearers, **but D1 Edit is account-wide** ([perms](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)), so a batch D1 token can `INSERT` a row for a hash it chose and **forge a router admin token** if the router shares the account. Argument for a separate account |
| Home server | `/etc/credstore.encrypted/` → `LoadCredentialEncrypted`; one setup-token per Unix user; runner tokens; GitHub App key | root, the unit's user, and anyone with the disk unless LUKS is on | per-user scoped |
| Claude Code transcripts `~/.claude/projects/**.jsonl` | **every secret pasted into or printed in a session**: the main leak path | the owner's user; kept for `cleanupPeriodDays` ([settings](https://code.claude.com/docs/en/settings)); readable by every later session | whatever was pasted |
| Dispatcher job transcripts | model I/O; known secret values redacted; PHI deleted at job end | user | low |

## 2. OAuth vs static: what we have, and where short-lived minting is possible
**OAuth-derived (all of it Anthropic's):**
- **Interactive `/login`.** Authorization-code flow in the browser. It stores an access token and a refresh token, and Claude Code refreshes it on its own. It warns 3 days before the login expires, and once refresh fails, requests fail until `/login` ([auth](https://code.claude.com/docs/en/authentication)). The access-token TTL isn't documented (*unverified*). `/logout` revokes it.
- **`claude setup-token`.** It uses the same browser authorization flow and prints a **one-year OAuth token** (`sk-ant-oat01-…` style). It has **no refresh token and no refresh**: it is used until it expires, "can only make model requests", and isn't saved anywhere (same page). Revoking a single one isn't documented (*unverified*). The documented remedy is to mint a new one.

**Static bearers (no TTL unless we set one):**
- Cloudflare API tokens: optional `expires_on`, plus Roll.
- R2 tokens and their S3 key pairs.
- The Telegram bot token: lives until BotFather `/revoke`.
- The Telegram webhook secret.
- The DeepSeek and Sarvam keys.
- Our router `as_` tokens: no expiry column.
- Tailscale node keys: 180 d.

**Where we could mint short-lived tokens instead:**
| Option | Real? | Verdict |
|---|---|---|
| GitHub OIDC → **Cloudflare** | **No.** CF docs still require a stored API token ([Workers GH Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)). OIDC is an open request ([workers-sdk #11434](https://github.com/cloudflare/workers-sdk/discussions/11434), [wrangler-action #402](https://github.com/cloudflare/wrangler-action/issues/402)) | nothing to do. Use a 1-year TTL plus least scope |
| GitHub OIDC → **Anthropic API** (WIF) | **Yes.** It accepts GitHub Actions as the issuer and returns a token with a TTL of 60–86400 s (wizard default 600 s) via RFC 7523 `jwt-bearer`; `jti` is single-use; Claude Code reads `ANTHROPIC_FEDERATION_RULE_ID` etc. ([WIF](https://platform.claude.com/docs/en/manage-claude/workload-identity-federation)). **API billing only**, not the subscription | **adopt for the `ANTHROPIC_API_KEY` fallback.** Match `sub` = `repo:<owner>/<env-repo>:ref:refs/heads/main`, so branch workflows can't get a token. Delete the static key |
| GitHub OIDC → Vault/OpenBao or Infisical | technically yes: OpenBao `jwt` auth with `bound_claims` ([openbao](https://openbao.org/docs/auth/jwt/)); Infisical OIDC auth | the manager must be reachable from GitHub runners, so self-hosting means a public endpoint, or else a SaaS holds the keys. It still ends in a static CF token. **No** |
| CF Access service tokens / Access JWT on the router | yes. Service tokens are a client id plus secret with a duration, 1 y in the examples, and are refreshable ([service tokens](https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/)). Access issues a JWT the Worker can verify | a second static secret per client. **Later, optional** for `/v1/admin*` only |
| GitHub App installation token for dispatcher PRs | yes. **1 h**, scoped to repos and permissions at mint time ([docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)). The App private key is the static root | **adopt** |
| Our router: client secret → short-lived JWT | possible: `/v1/token` signs an HS256 or ES256 JWT with `jose` | see §3. **No** |

## 3. TTLs and rotation
Static tokens carry no TTL unless one is set. The setup-token has a fixed one year, tracked by `CLAUDE_TOKEN_CREATED`. Proposal: one **rotation day each half-year** (the dates are a deployment choice), plus annual items on the same day, so there is one calendar entry. Add a non-secret `credentials.yaml` (name, issuer, created, expires, consumers) to the env repo. The daily digest generalises the `CLAUDE_TOKEN_CREATED` warning: it warns at T−30 d and `/fail`s at T−7 d.

**Router: AT/RT vs hashed bearers.** AT/RT only helps if the refresh token sits somewhere better protected than the access token. Here both would sit in the same 0600 file or GH secret. A short-lived AT does shrink the value of a token copied from logs or transcripts. The cost is a token endpoint, rotation of the signing key, refresh logic in two clients and two runners, and clock skew. **Recommendation: hashed bearers with `expires_at`, `last_used_at`, ≤2 live tokens per client (overlap) and the rotation day.** Revisit only if a third party or a browser becomes a client.

TTL and rotation per credential are in the table in §7.

## 4. DPoP (RFC 9449)
- **What it gives.** It binds an access or refresh token to a client key pair. Each request carries a proof JWT (`jti`, `htm`, `htu`, `iat`, `ath`, and optional server `nonce`), so a stolen token alone is useless and replays can be detected ([RFC 9449](https://datatracker.ietf.org/doc/html/rfc9449) §1, §4.2, §8).
- **What it doesn't give.** It offers no protection once the attacker runs code as the client (§2, §11.4). It covers only the method and URI, not the body (§11.7). Server-side `jti` tracking is optional (§11.1).
- **Where it applies.** Only OUR clients and runners → OUR router. Telegram (bot token in the URL), Cloudflare, GitHub, Anthropic and DeepSeek document no DPoP for their APIs. We searched their API auth docs and found none, so treat this as an *unverified absence*. GitHub, CF and DeepSeek use static or bearer tokens only, and Anthropic WIF is plain bearer.
- **Libraries.** panva `oauth4webapi` does client DPoP and runs on Workers and Node 20+ ([repo](https://github.com/panva/oauth4webapi)). Its `validateJwtAccessToken` covers RFC 9449 but "does NOT validate the DPoP Proof JWT nonce" ([doc](https://github.com/panva/oauth4webapi/blob/main/docs/functions/validateJwtAccessToken.md)). `jose` handles the JWS/JWK primitives.
- **Cost.** About 150 LOC across the router and two clients. A `jti` replay store, meaning a D1 write per request or a nonce round-trip. Clock-skew handling. Key provisioning per host.
- **The decisive point.** The leak path is the disk and transcripts. The DPoP private key would live in the same 0600 file or env as the token, unless it were non-extractable in the Secure Enclave or a TPM, which Node can't use without native code. So DPoP adds almost nothing against our actual threat.
- **Alternatives:**
  - **mTLS** needs a custom domain on our zone; `workers.dev` won't work ([mtls](https://developers.cloudflare.com/api-shield/security/mtls/)).
  - **HTTP Message Signatures** (RFC 9421) cost the same and have weaker Workers library support.
  - **Tailscale Serve identity headers** "are not populated for traffic originating from tagged devices" ([serve](https://tailscale.com/kb/1312/serve)), and a tagged home server is affected. The router runs on CF, not the tailnet, anyway.
- **Verdict: no now. Revisit later** only if the router gets external clients or the keys can be hardware-bound (systemd-creds `tpm2` on a home server makes that plausible).

## 5. Branch protection on GitHub Free: options

> **Amended 2026-10-26:** the plan tier is an env choice. Without Team, the fence is the env-repo split with access parity ([ADR 008](../decisions/008-product-environment-pii.md)); the analysis below stays as the option record.
| Option | Prevents exfil? | Cost / ops | Notes |
|---|---|---|---|
| **GitHub Team**, paid per user ([pricing](https://github.com/pricing)) | **yes.** Rulesets on private repos ([rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)), plus **environment secrets limited to `main`** and deployment branches ([envs](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)) | per-user fee, 10 min | keeps org-level policies (read-only `GITHUB_TOKEN`, SHA-pin, require 2FA). Required reviewers still need Enterprise |
| Move to a personal account + **Pro** (paid) | mostly. Pro has protected branches and code owners on private repos ([plans](https://docs.github.com/en/get-started/learning-about-github/githubs-plans)), plus environment secrets and deployment branches | similar fee plus a repo transfer | loses org-only "restrict who can push" ([protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)) and the org policies |
| Personal account on Free | no | 0 | same limits as an org on Free |
| Forgejo/Gitea self-hosted (primary or mirror) | only for pushes to Forgejo. Secrets in GitHub Actions stay unfenced if CI stays on GitHub. As the primary, it moves CI and PHI git onto the home box | a 24/7 home service, backups, upgrades; protection is approvals and force-push blocking ([forgejo](https://forgejo.org/docs/latest/user/protection/)) | complexity debt, and an availability risk for the PHI KB. **No** |
| CI-side guard (`on: push`, alert on an unexpected author or a workflow diff) | **no, detect only.** The malicious workflow runs in parallel | 1 file | keep as a cheap tripwire |
| Signed commits (SSH signing) + a CI verify check | detect only, same reason. GitHub verifies GPG, SSH and S/MIME ([sig](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification)). gitsign isn't listed there (*it shows as unverified*) | low | useful with Team rulesets ("require signed commits") |
| pre-push hook | no. Local only, `--no-verify`, doesn't constrain the App | trivial | convenience only |
| CODEOWNERS | no, without protection | trivial | add it once Team is on |
| Allstar / Scorecard | monitors only. The hosted Allstar app has been retired, so you run it yourself as an Action ([allstar](https://github.com/ossf/allstar)) | low | Scorecard Action once a month is enough |

**Recommendation (when a paid plan is chosen): GitHub Team.** It is the only option that *prevents* exfiltration rather than just detecting it. Move every secret into a `main`-only environment. Add a ruleset on `main`: require a PR for the App, block force-push and deletion, require signed commits, and add a push-path restriction on `.github/workflows/**` for the App (the plan tier for push rulesets is *unverified*; the App's missing `workflows` permission already covers this).

## 6. Secret managers
| Tool | Cost | Ops | Security model | GH Actions without static secrets? | Offline / home fit | Lock-in |
|---|---|---|---|---|---|---|
| **SOPS + age** ([sops](https://github.com/getsops/sops), CNCF sandbox) | 0 | none (CLI) | encrypted values in git; the age private key is the root | no (only via a KMS) | **excellent** | none |
| Infisical ([pricing](https://infisical.com/pricing)) | Free cloud: 5 identities, 3 envs; core is MIT for self-host. Rotation and dynamic secrets are paid | SaaS or a Postgres+Redis service | central server; machine identities | yes in principle (OIDC auth; free-tier availability *unverified*) | self-host = another daemon | medium |
| OpenBao / Vault | 0 (OpenBao MPL) | **high**: unseal, storage, HA | dynamic secrets, leases | yes (`jwt` auth) but needs a public endpoint | poor at our size | low (API) |
| Bitwarden Secrets Manager ([page](https://bitwarden.com/products/secrets-manager/)) | Free: 2 users, 3 machine accounts, 3 projects | SaaS | machine-account **static access token** | no | needs internet | medium |
| 1Password CLI / Connect / service accounts ([docs](https://www.1password.dev/service-accounts/)) | paid plan | SaaS (Connect = a daemon) | the service-account token is static | no | needs internet | high |
| Doppler ([pricing](https://www.doppler.com/pricing)) | Developer: 3 users, 10 projects, 50 service tokens. OIDC service accounts are Team-tier | SaaS | static service tokens on free | no (free) | needs internet | high |
| CF Secrets Store ([docs](https://developers.cloudflare.com/secrets-store/)) | **open beta**; 100 secrets and 1 store per account ([limits](https://developers.cloudflare.com/secrets-store/manage-secrets/)); free-plan terms not stated | none | account-level, bound by `secrets_store_secrets` ([workers](https://developers.cloudflare.com/secrets-store/integrations/workers/)). The bind role is separate (Secrets Store Deployer), but deployed code can still `get()` | n/a | n/a | CF |
| systemd-creds ([man](https://www.freedesktop.org/software/systemd/man/latest/systemd-creds.html)) | 0 | built in | AES-256-GCM, `host+tpm2` key, decrypted only into the unit's `$CREDENTIALS_DIRECTORY` (ramfs, "secure") | n/a | **home server** | none |
| macOS Keychain | 0 | built in | per-item ACL, unlocked at login; `security find-generic-password -w` | n/a | macOS | none |
| GitHub OIDC → manager | — | — | the only way to fence CI secrets on Free is to bind to `ref:refs/heads/main`. Team environments do the same with no new system | — | — | — |

**Recommended setup (least moving parts):**
- **Source of truth.** One `secrets/*.sops.env` set in the **env repo** (never in the records repo), encrypted to two age recipients: the workstation key and an **offline paper or USB backup key**. A home server gets its own recipient for its files only. Adding a key means re-encrypting to the new recipients ([sops](https://github.com/getsops/sops)).
- **Workstation (macOS).**
  - Keep the age identity in the **Keychain** (`security add-generic-password -s sops-age`), not as `keys.txt`. Feeding it to sops through a key command is *version-dependent and unverified*. The fallback is `keys.txt` at 0600.
  - Run consumers via `sops exec-env secrets/x.sops.env '<cmd>'`, so no plaintext `.env` stays on disk. LaunchAgents call a 5-line wrapper.
  - **Add Claude Code `permissions.deny` for `Read(~/.config/<env>/**)`, `Read(~/.config/<agent-env>/**)`, `Read(~/.claude/.credentials.json)`** plus a Bash hook that blocks `cat`/`grep` on those paths. This is the cheapest control on the actual leak path.
- **Home server.** Decrypt on the workstation, pipe over Tailscale SSH into `systemd-creds encrypt --with-key=host+tpm2`, and write the result to `/etc/credstore.encrypted/`. Units use `LoadCredentialEncrypted=`. Enable LUKS. Encryption is bound to the machine, so a copied disk image is useless.
- **GitHub Actions.**
  - A Team environment limited to `main` holds the CF, Telegram, R2, setup-token and router secrets. They are set from sops with `gh secret set --env <environment>`.
  - **Anthropic API fallback via WIF**, not a key.
  - The App token comes from `actions/create-github-app-token`, if the batch ever needs it.
- **Cloudflare.** Worker secrets pushed by `wrangler secret bulk` in deploy-worker. Skip Secrets Store until GA. Use a **separate CF account for agent-router**, which closes the D1 forging path in §1.

**Rotation end to end.** Mint at the issuer, then:
1. `sops edit`
2. `scripts/push-secrets <name>` fans out to `gh secret set --env`, `ssh <home-server> systemd-creds` plus a restart, and `wrangler secret bulk` through a deploy run.
3. Verify (CI green, `/health`, `getMe`, one router claim).
4. Revoke the old credential at the issuer.
5. Bump `credentials.yaml`, then commit.

The router is no-downtime, because its tokens overlap. Cloudflare is no-downtime with create, swap, then delete. Telegram has a short outage, since a revoke kills the old token instantly, so do it inside one deploy run.

## 7. Credential classes and TTL policy
| Credential class | Type | Issuer | Stored | Proposed TTL | Rotation | DPoP/PoP |
|---|---|---|---|---|---|---|
| Cloudflare deploy token | static API token, least scope | Cloudflare | env secret; sops | **1 y** `expires_on`, account-owned | annual: create, swap, delete | no (CF) |
| Cloudflare batch D1 token | static API token, D1 Edit | Cloudflare | env secret; sops | **1 y** | annual | no |
| R2 S3 read key (`<bucket>`) | static SigV4 key pair | Cloudflare R2 | env secret; sops | **1 y**; no admin/object tokens kept | annual | SigV4 is per-request signing (PoP-like) |
| Telegram bot token | static | BotFather | Worker secret, env secret, sops | **annual + on suspicion** | revoke, then deploy in one run | no (Telegram) |
| Telegram webhook secret | shared secret | us | Worker secret, env secret | **180 d** | `setWebhook` + deploy | no |
| `CLAUDE_CODE_OAUTH_TOKEN` (one per consumer) | OAuth token, no refresh token | Anthropic | env secret; systemd-creds | fixed 1 y → **rotate at 11 months** | `setup-token`, swap; the old one lapses | no |
| Claude `/login` (workstation) | OAuth access + refresh tokens | Anthropic | keychain | auto-refresh | `/login` when warned | no |
| Anthropic API fallback | **WIF token** | Anthropic | nothing stored | **600 s**, bound to `main` | none (federated) | no |
| Third-party model key | static | provider | sops; systemd-creds | **180 d**, low balance cap | create, swap, delete | no |
| STT key (Sarvam) | static | Sarvam | env secret | **annual** | create, swap, delete | no |
| Router owner (admin) | hashed bearer | us | sops exec-env | **90 d** | mint, swap, revoke (overlap) | possible, not worth it (§4) |
| Router batch client | hashed bearer | us | env secret | **180 d** | rotation day | same |
| Router runners | hashed bearer | us | systemd-creds; sops | **180 d** | rotation day | same |
| GitHub App (dispatcher) | private key → 1 h installation token | GitHub | systemd-creds | key **annual**; token 1 h (fixed) | add a 2nd key, swap, delete the old one | no (GitHub) |
| `GITHUB_TOKEN` | per-job | GitHub | ephemeral | 1 job | n/a | no |
| Tailscale node keys | WireGuard key | Tailscale | devices | 180 d; tagged = ∞ | remove node on loss | inherent (keypair) |

## 8. Token flows
```mermaid
flowchart LR
  subgraph WS[Workstation]
    KC[Keychain: claude login AT/RT + age key] --> SOPS[sops exec-env]
    SOPS --> CTL[agentctl owner token]
  end
  subgraph GH[GitHub Actions, Team env = main only]
    OIDC[GitHub OIDC JWT] -->|jwt-bearer, sub=ref main| ANT[Anthropic WIF, 600 s token]
    ENV[env secrets: CF deploy/D1, R2 S3, TG, setup-token, router batch client]
  end
  subgraph HS[Home server]
    TPM[systemd-creds host+tpm2] --> DH[dispatcher@hl: runner-hl, setup-token, App key]
    TPM --> DA[dispatcher@agents: runner-agents, setup-token, DeepSeek]
  end
  ENV -->|Bearer CF token| CFAPI[Cloudflare API: deploy, D1 REST]
  ENV -->|SigV4| R2[(R2 bucket)]
  ENV -->|secret bulk| W[Worker secrets]
  TG[Telegram] -->|X-Telegram-Bot-Api-Secret-Token| W
  W -->|bot token| TGAPI[Telegram API]
  ENV -->|Bearer batch client| RT[agent-router, separate CF account; D1 hashed tokens]
  CTL -->|Bearer admin| RT
  DH -->|Bearer runner + lease_token| RT
  DA -->|Bearer runner + lease_token| RT
  DH -->|App JWT -> 1 h installation token| GHAPI[GitHub PRs]
  DH -->|OAuth setup-token| ANTAPI[Anthropic]
  DA -->|key| DS[DeepSeek]
```


## 9. Recommendations (impact/effort order)
1. **Keep only least-scope tokens.** No admin or object-write R2 tokens on disk; purge transcripts after any paste.
2. **Claude Code deny rules and a Bash hook on the secret paths.** This closes the main leak path.
3. **Fence CI secrets**: secrets only in the env repo, access parity (ADR 008); on a paid plan, a `main`-only environment plus a ruleset on `main`.
4. **Router:** `expires_at`, `last_used_at`, ≤2 tokens per client, and an expiry warning in the digest. Use the TTLs in §7.
5. **`credentials.yaml` and the rotation day**; the digest warns at T−30 d.
6. **Separate Cloudflare account for the agent router** (closes forging tokens via account-wide D1 Edit).
7. **SOPS+age source of truth and a push-secrets step**, then remove plaintext `.env` files.
8. **Anthropic WIF** for the API fallback instead of a static key, when the fallback is first needed.
9. **Home server:** systemd-creds `host+tpm2`, LUKS, and the GitHub App.
10. **Later, optional:** CF Access on `/v1/admin*`; a monthly Scorecard Action. **No:** DPoP, router AT/RT, Vault/OpenBao, Forgejo, SaaS secret managers.

Open choices per deployment (plan tier, second account, backup-key holder, API fallback) are env choices; they are recorded in the env repo.
