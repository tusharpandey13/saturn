# Saturn

> **Working name.** "Saturn" is a placeholder (chosen 2026-10-26). The name lives in one constant,
> [`product.json`](product.json), plus this README and the package names. A trademark check is required before
> a public name is fixed.

Saturn is a self-hosted **home health log** for a household. Family members send blood-pressure photos, oximeter
readings, lab reports, prescriptions and voice notes (Hindi, Hinglish or English) to a private Telegram group. A
small Cloudflare Worker stores each message; a daily batch transcribes and extracts structured facts into a
git-based knowledge base; generated pages and a digest go back to the family.

**Saturn records and flags. It is not medical advice and not a medical device.** It never diagnoses and never
suggests starting, stopping or changing a medicine; concerns are phrased as questions for the treating doctor.

## Architecture

```
Telegram group ──webhook──▶ Worker (app/src/worker.ts) ──▶ D1 inbox + R2 media      (Cloudflare, free tier)
                                                              │
                     daily batch (app/batch, deploy/batch.sh) ◀┘   runs in the env repo's CI
                        pull ─▶ raw rows + media committed to the records repo first
                        extract ─▶ STT adapter (adapters/stt) + LLM adapter (adapters/llm), Zod-validated
                        KB build ─▶ tools/kb/build: validate data/**/*.ndjson, build kb.sqlite (schema/)
                        pages ─▶ tools/kb/gen-views: generated blocks in docs/health/<ns>/*.md
                        finish ─▶ digest to the group, inbox rows marked done
```

- **Knowledge base** ([ADR 007](docs/decisions/007-simplified-clinical-data-model.md)): three concepts, `source`
  (anything received), `fact` (observation, medication, condition, event) and `ref` (drug, code, party), as NDJSON
  in git, ids `<ns>:<class>:<local>`. Facts are never edited; corrections supersede.
- **Adapters** keep provider names out of the core: `LlmAdapter` (`claude-cli`; a fake for tests) and
  `SttAdapter` (`sarvam`, or none).
- Design: [docs/platform/hld.md](docs/platform/hld.md); decisions: [docs/decisions/](docs/decisions/README.md);
  threat model: [docs/security.md](docs/security.md).

## The three-repo model

A deployment is three repos with different owners of risk ([ADR 008](docs/decisions/008-product-environment-pii.md)):

| Repo | Holds | Visibility |
|---|---|---|
| **product** (this repo) | code, schema, templates, generic docs, synthetic fixtures | public-ready: no PHI, no secrets, no environment values |
| **env** (`<name>-env-<stage>`) | `env.yaml` (resource names, ids, URLs), SOPS secrets, `product.lock`, thin CI workflows, run history | private, owner-only write |
| **records** (`<name>-records-<slug>`) | `records.yaml`, `data/`, `sources/`, `docs/health/`: all health data | private, no workflows, no secrets |

The contracts between them:
- [`env.manifest.yaml`](env.manifest.yaml): the resources, vars and secret names an environment must supply
  (`cd app && npm run env:check -- --env <env.yaml>`).
- `records.yaml` in the records repo: `schema_version` (this product reads 7), the namespaces (people and shared
  spaces, with display names) and the D1 person map. Nothing in the product names a person.
- The tools take `--records <dir>` (and `--env <env.yaml>`); the thin workflows in
  [`deploy/github/`](deploy/github/) are templates for the env repo.

## Quick start (synthetic records, no accounts)

Requirements: Node 24, Python 3.11+ (stdlib only for the KB tools).

```sh
# Knowledge base against the synthetic example records
python3 -I tools/kb/build --records fixtures/records-example
python3 -I tools/kb/gen-views --records fixtures/records-example
python3 -I tools/kb/test_build.py && python3 -I tools/kb/test_gen.py

# App: unit tests, typecheck, and a full local end-to-end run (wrangler dev + local D1/R2 + stub Telegram + fake LLM)
cd app
npm ci --ignore-scripts
npm test
npm run typecheck
npm run e2e:local
```

`npm run render` writes `app/wrangler.toml` from [`deploy/wrangler.template.toml`](deploy/wrangler.template.toml)
and an env file (default [`deploy/env.example.yaml`](deploy/env.example.yaml)). To deploy a real environment, see
[docs/platform/deploy.md](docs/platform/deploy.md). No real data reaches a deployment until its owner opens the
go-live gate.

## Layout

```
app/          Worker (src/), batch entrypoint (batch/), D1 migrations, tests, scripts (render, e2e)
adapters/     llm/ (claude-cli), stt/ (sarvam)
schema/       KB JSON Schemas + schema.sql (ADR 007)
tools/        kb/ (build, gen-views), research/ (citation verifier), ocr/, doc-scan/, docs-site/
agent-tasks/  task pack for agent-server (PR target = the records repo, set by the env)
deploy/       wrangler template, deploy.sh, batch.sh, thin workflow templates, env.example.yaml
fixtures/     records-example/ (synthetic records), app/ (synthetic Telegram and extraction fixtures)
docs/         platform/, decisions/, methods/, research/, meta/, security.md, records-guide.md
```

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) (DCO sign-off; synthetic data only) and [SECURITY.md](SECURITY.md)
(private reporting). Licensed under [Apache-2.0](LICENSE).
