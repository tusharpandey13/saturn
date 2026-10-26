# 008 — Product, environment and PII as separate units

Date: 2026-10-26 · Status: **ACCEPTED** (2026-10-26, with the plan §12 defaults) · Related: 003 (medical data in git), 005, 006, 007, [HLD](../platform/hld.md), [security model](../security.md), [token architecture](../platform/token-architecture.md) · Execution plan: split plan (env repo)

## Context
One private repo holds four things with different owners, audiences and lifetimes: the code and its docs; the concrete deployment (resource ids, run ids, workflow secrets, status and changelog); the family's health records; and agent-server, a second repo that mixes the same three. Consequences today:
- The code cannot be shared, reviewed in public or reused by another family: its git history contains PHI and once-pasted secrets.
- Product files carry PII. Real first names are hard-coded as KB namespaces (`tools/kb`, `data/schema.sql`), the docs-site denylist embeds a real name and facility, a doc-scan test uses frames of a real clip, the STT vocabulary lists family medicines, and ADR 007's examples cite a real hospital and doctor.
- Any workflow in the repo can read every secret (GitHub Free) **and** every record. Write access to code is write access to PHI.
- Prod and e2e cannot be told apart by repo, so e2e isolation rests on discipline ([e2e-testing §7](../platform/e2e-testing.md)).

## Decision
Split everything into three kinds of unit, joined by versioned contracts. Classify **by content, not by path**. The naming pattern above is the model; the concrete repo, org and resource names of a deployment live in its env repo.

| Unit | Visibility | Holds | Instances |
|---|---|---|---|
| **PRODUCT** | public-ready (private until the user flips it) | logic, schemas and migrations, deploy **templates** (parameters only), generic runbooks, docs and ADRs, synthetic fixtures, agent task templates, the LLM/STT adapter interfaces | Saturn (this repo), `agent-server` |
| **ENVIRONMENT** ("supplied") | private | resource declarations and ids, concrete deploy config, SOPS+age secrets, operational data (logs, job audit, status, changelog), environment runbook values, allowlists (ids and role labels, no names), the pinned product version | `<name>-env-<stage>` (e.g. `saturn-env-prod`, `saturn-env-e2e`, `agent-server-env-prod`) |
| **PII** ("provided") | confidential | health records, sources and media, KB NDJSON, curated and generated health pages, working notes, and non-health personal data: family, insurance, identity (names ↔ Telegram ids), the denylist itself | `<name>-records-<slug>` (one per family); a synthetic `<name>-records-e2e` for the e2e env |

The product is **provider-agnostic**: extraction, deep reads and briefs go through an `LlmAdapter` (`claude-cli`, `anthropic-api`, `fake`; others by contribution) and STT through an `SttAdapter` (`sarvam`, `none`). Which LLM plan or API terms an adapter uses is an env choice, made in `env.yaml`.

## Contracts
| Contract | File | Lives in | Content | Checked by |
|---|---|---|---|---|
| product → env | `env.manifest.yaml` | each product repo | required resources (Worker, D1 + migrations dir, R2 bucket, router), vars (`WORKER_URL`, `GO_LIVE`, …), secret **names** with consumer, scope and max TTL, adapter choices, supported `schema_version` range | `hl env check` in env CI: every declared secret and var exists (by name), adapters valid, lock matches |
| env → product | `product.lock` | each env repo | product repo, semver tag, commit SHA (and agent-server's, for the router env) | env CI refuses a tag whose SHA differs; upgrades are PRs |
| env (concrete) | `env.yaml` | each env repo | the values the manifest asks for: account and database ids, names, URLs, adapter choices, caps, `GO_LIVE` | `hl env check` |
| product → PII | `records.yaml` | each PII repo | `schema_version` (integer; 7 = ADR 007), the person registry file, the denylist file, the product range it was validated with | records CI with product tests, no secrets |
| migrations | `schema/migrations/NNN_*.py` | product | idempotent N → N+1 transforms; `hl records migrate` opens a PR on the PII repo | the product tests run against `fixtures/records-example` |

Namespaces come from the PII person registry, never from code. The product ships a synthetic example family (`fixtures/records-example`) that passes the same validation as a real records repo.

## Classification rules (by content)
1. **PII** if it names, identifies or describes a real person: name, DOB, phone, Telegram or chat id **joined with a name**, policy or claim number, any clinical detail, media from the family, a real doctor or facility tied to a person, source file names (they carry facility and date), and anything derived from these (kb.sqlite, generated pages, analyses, agent transcripts, deny-patterns).
2. **ENVIRONMENT** if it identifies or configures one deployment: account, database and bucket ids, hostnames, run ids, token names and scopes, concrete runbook values, status and changelog, job audit with opaque refs, bare ids in allowlists (mapped to role labels only).
3. **PRODUCT** only if it is true for any deployment and any family and passes the scanners plus the denylist gate.
4. **Mixed file:** split it. If it cannot be split, the strictest class wins (PII > ENVIRONMENT > PRODUCT).
5. **Fixtures:** synthetic only, generated or hand-written; never "anonymised" real data.

## PII-at-runtime controls
The env repo holds no PII, but its resources process PII: D1 inbox, R2 media, the Actions runner of the batch, agent-server jobs and worktrees, the Mac's kb.sqlite and Claude transcripts. They get PII-grade controls:
- **Access parity.** Write on an env repo ⇒ its workflows reach the records and secrets, so env write = records write: same people, 2FA/passkeys, no outside collaborators.
- **Least-privilege writes.** The batch writes records through a GitHub App installation token (1 h, contents only, no `workflows`); the e2e env uses a different App or PAT that cannot see prod records.
- **Logs.** Ids and counts only; Actions log retention set to the minimum that ops needs (7 days default); job params and audit use opaque refs (queue id, sha256), never file names.
- **Retention.** D1 inbox pruned 14 days after commit; R2 lifecycle on committed media; agent worktrees and PHI transcripts wiped at job end (HLD §6).
- **Providers.** PHI goes only to the adapters the env marks `phi_ok` (training off; recorded in `env.yaml` with the date).
- **Go-live gate** ([records-guide.md](../records-guide.md) §0) is unchanged and now names the env repo: no real data reaches its resources until the user says "go".

## Versioning and release
- Product repos: Conventional Commits, **release-please**, semver tags `vX.Y.Z` with a changelog; `0.x` until the first public release.
- A major bump means a breaking `env.manifest.yaml` change or a new `schema_version`; release notes list the env steps and the migration.
- Env repos upgrade by a PR that edits `product.lock` (Renovate or by hand); CI runs `hl env check` and the records validation at the new version before merge.
- PII repos move `schema_version` only through a product migration PR.

## Consequences
- Good: the product can go public and be reused; secrets and records stop sharing a blast radius with code; prod and e2e become different repos with different credentials; another family needs only new env and PII repos.
- Cost: 5–7 repos instead of 2; cross-repo checkouts in CI; three AGENTS.md files; ~9 agent-runs plus about an hour of user steps (plan).
- The old repo becomes a read-only archive. Its history keeps PHI and revoked secrets, so it is never made public.
- Evidence paths inside records are kept unchanged (the PII repo keeps `sources/`, `data/`, `docs/health/`, `docs/log/`), so no KB id or citation is rewritten.

## Asymmetric risks
| Risk | Downside | Mitigation |
|---|---|---|
| PHI or a secret lands in the public product history | **irreversible** (forks, caches, archives) | fresh history; gitleaks + trufflehog + denylist gate in CI and pre-push; the user flips to public only after the OSS checklist; until then private |
| Records history lost in the filter | provenance gone | filter-repo on a copy; per-path sha256 and commit-count checks; old repo archived, not deleted |
| Env write used to exfiltrate records | PHI leak | access parity, App tokens without `workflows`, GitHub Team rulesets when adopted |
| Cross-repo wiring breaks the batch | late digest only (inbox waits 14 days in D1) | split before go-live; dry runs on an empty inbox |
| Over-splitting (complexity debt) | slower changes | one env repo per environment (hosts as folders), thin env workflows that call product scripts |
