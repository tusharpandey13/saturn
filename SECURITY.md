# Security policy

## Reporting a vulnerability
Report privately through GitHub: **Security > Report a vulnerability** (a private advisory) on this repository. Do not
open a public issue. Expect an acknowledgement within 7 days. Include a minimal **synthetic** reproduction: never send
real health data.

Supported versions: the latest `0.x` release.

## Scope and model
The threat model, principals, vendor constraints and credential-scoping principles are in
[docs/security.md](docs/security.md). In short:
- The product holds no secrets and no deployment values; each environment keeps them in its own private env repo
  (SOPS-encrypted) and CI secrets, scoped per step.
- Health data lives only in a private records repo, which has no workflows and no Actions secrets. CI writes to it
  with a per-job GitHub App token (one repo, contents only, no `workflows`), revoked at the end of the job.
- The ingest Worker checks the Telegram webhook secret and an allowlist of chats and senders held in D1.
- LLM output is untrusted: it is validated against a Zod schema and plausibility ranges before it is stored.

## Hygiene in this repo
- gitleaks, actionlint, zizmor, check-jsonschema and `lychee --offline` run in pre-commit and CI (one config).
  PHI and deployment-term rules are kept privately by each environment and run as a separate scan.
- Actions are pinned by commit SHA with read-only default permissions; product CI uses no secrets and no
  `pull_request_target`.
- Dependabot uses a 7-day cooldown.
