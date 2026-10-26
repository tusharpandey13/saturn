# Deploy notes: first prod deploy, values and history

Source: the old deploy runbook (now generic at [../platform/deploy.md](../platform/deploy.md)). **Route to the env repo (`<env-repo>`, `runbooks/deploy.md`) at S7, then delete from the product.** This file lists WHAT must be routed; the values themselves already live in the source repo and the env. Values: see env repo.

## Concrete values to route
| Item | Placeholder | Notes |
|---|---|---|
| Worker name | `<worker>` | concrete name in `env.yaml` |
| Worker URL | `https://<worker>.<subdomain>.workers.dev` | `WORKER_URL` variable |
| D1 name and id | `<d1-name>`, `<d1-id>` | region APAC; pin in `env.yaml` (`d1.id`) |
| R2 bucket | `<bucket>` | APAC, private, r2.dev disabled |
| GitHub repo for secrets and workflow runs | `<owner>/<env-repo>` | was the old single repo |
| Local secret files | `<config-dir>/{telegram,cloudflare}.env` | replaced by SOPS in the env repo |
| Deploy run id, dry batch run id | see env repo | both green on 2026-10-25 |
| Allowlist role labels and the D1 role → namespace map | see env repo / records `d1_person_map` | no names in the env |
| `ALERT_CHAT_ID` | see env repo | the maintainer's Telegram user id |

## State at the split (2026-10-25, phase 0: deployed, webhook pending)
- Local checks passed; D1 and R2 created; `0001_init.sql` applied remotely; **no allowlist rows** (go-live gate).
- Webhook secret generated; GitHub secrets set (names: `CLOUDFLARE_DEPLOY_TOKEN`, legacy `CLOUDFLARE_API_TOKEN` = the deploy token, `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`; variable `WORKER_URL`).
- The org forbids a read/write workflow default (HTTP 409); the batch workflow declares `contents: write` itself.
- Deploy and a dry batch on the empty inbox succeeded; `/health` ok; wrong-secret POST 401. Other Workers on the account untouched.
- Webhook **not set**.
- Code-side auth fixes landed: batch D1 token split, webhook assertion, SHA-pinned actions, step-scoped secrets, manual deploy gate, workflow guard, Dependabot.

## Open items at the split
1. **Blocked: R2 read for the batch.** REST object GET with the R2 object token returned `10002 Unauthorized`; the deploy token got 403. Target: S3 key pair, Object Read only, one bucket ([auth-review-incidents.md](auth-review-incidents.md)).
2. Batch D1 token (`CLOUDFLARE_D1_TOKEN`) to be minted by the user; then delete the legacy `CLOUDFLARE_API_TOKEN`.
3. LLM credential + its creation-date variable; bot token rotation before the bot joins the group (it was exposed); group creation; id collection via `getUpdates`; thresholds sign-off decision; household briefing.
4. GO-LIVE GATE, then allowlist load, webhook, smoke test, first real batch.
