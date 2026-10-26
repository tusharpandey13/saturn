---
title: "OSS-replacement review: hl-service"
audience: engineer
type: explanation
owner: maintainer
last_reviewed: 2026-10-26
review_every: 90d
status: "review (2026-10-25)"
sources: [app/, .github/, tools/]
generated: false
---

# OSS-replacement review: hl-service

Date: 2026-10-25 · Scope: everything in `app/`, `.github/`, `tools/kb/`, `tools/ocr/`, `tools/doc-scan/`, `schema/schema.sql` · Design that uses it: [hl-service-design.md](hl-service-design.md)

**Method.** We read every hand-rolled component. For each one we looked up the mature alternatives on 2026-10-25, using GitHub API and npm registry data plus the vendor docs (URLs under Sources). Star counts are approximate.

**Rule.** We replace bespoke code when a standard tool covers it at equal or lower total cost. Total cost counts new dependencies, CPU on Workers Free (10 ms per request), supply-chain exposure on a PHI repo, and churn. We do not add infrastructure for a single-household system.

**Baseline.** `app/src` + `app/batch` is 2,152 lines of TypeScript, and tests are 891 lines. `tools/kb/build` is 203 lines of Python, `tools/ocr` is 95 lines of Swift/sh, and `tools/doc-scan/scan.py` is 372 lines of Python.

## Verdict table

| # | Component (what we built) | Lines | Standard alternatives (maturity) | Fit (CF Free / GHA) | Migration cost | Verdict |
|---|---|---|---|---|---|---|
| 1 | Telegram adapter: Update types, `parseUpdate`, `sendMessage`, `getFile` + download (`src/channel/telegram.ts`) | 132 | **grammY** 1.46.0 (2026-08-26), ~3.8k★, MIT, monthly minors, CF adapter `webhookCallback(bot,"cloudflare-mod")` [1]. **Telegraf** 4.16.3, last release 2024-02-29, dormant [2]. **@grammyjs/types** 5.0.0, types only, but 2 majors in 2 months [1] | grammY works on Workers, but it is ~27 KB gz with 4 deps, and the framework's middleware/context costs CPU on the 10 ms budget. We use 3 API calls | 1 run, plus test rewrites | **KEEP.** Three endpoints and a pure parser. The framework would replace ~60 lines and add a churny dependency on the always-on path. `@grammyjs/types` is **DEFER**: adopt it only if we start using many more Bot API fields |
| 2 | Webhook secret check, hand-rolled `timingSafeEqual` | 7 | Workers built-in `crypto.subtle.timingSafeEqual` (runtime API, no dependency). grammY `secretToken` option [1] | Native on Workers | trivial | **REPLACE** with the runtime primitive. It throws on unequal lengths, so compare SHA-256 digests or check the length first. Saves ~6 lines |
| 3 | Inbox + idempotency: D1 `INSERT OR IGNORE` keyed by `update_id`, status/prune (`store.ts`, `0001_init.sql`) | ~60 | Durable Objects, Queues, an ORM upsert | This is already the standard pattern on D1 | — | **KEEP.** Idempotency on Telegram's own key is the textbook design |
| 4 | D1 access over 3 backends (binding / REST / `node:sqlite`) (`store.ts`, `batch/cloudflare.ts`, `dev/sqlite-d1.ts`) | 201 | **Drizzle** 0.45.4 stable, 1.0.0-rc.5 (2026-10-21), ~36k★, Apache-2.0, has a `d1-http` driver [3]. **Kysely** 0.29.7, ~14k★, MIT; `kysely-d1` is single-maintainer and quiet since 2025-04 [3]. Official `cloudflare` npm SDK for the REST call (not verified here) | An ORM must cover all 3 backends; Drizzle is mid-1.0 RC | 1–2 runs | **KEEP.** 9 SQL statements over a 4-method interface; an ORM adds a schema DSL and a dependency in the middle of a 1.0 RC. Revisit at more than ~5 tables |
| 5 | D1 migrations (`wrangler d1 migrations apply`) | 38 SQL | Already the first-party tool; drizzle-kit as an alternative | ✓ | — | **KEEP** (already standard) |
| 6 | R2 media copy: stream the Telegram download into `R2.put`, `media_status` retry by `file_id` | ~20 | None needed: native binding | ✓, CPU-free streaming | — | **KEEP** |
| 7 | Vitals parser: Hinglish/Devanagari regexes, echo + plausibility "?" (`vitals.ts`) | 116 | No OSS parser exists for "BP 120 by 80 khali pet". LLM at ingest is ruled out by ADR 005 | Must run under 10 ms; measured 4 µs | — | **KEEP.** Pure domain logic |
| 8 | Extraction contract: hand-written JSON schema (~60 lines) + hand-written structural validation (~70 lines) + units/ranges/time (~70 lines) (`extract/schema.ts`) | 201 | **Zod 4** 4.6.7 (2026-10-12), ~44k★, MIT, built-in `z.toJSONSchema` [4]. **Anthropic SDK** `zodOutputFormat` + `client.messages.parse()` → `parsed_output` (SDK 1.3.0, Apache-2.0) [5]. Valibot 1.5.0 via `betaStandardSchemaOutputFormat` [4,5]. **Instructor-js** dormant since 2025-01 [6]. **BAML** 0.226 pre-1.0, DSL + codegen + native binaries [6]. Ajv 8.20 validates but does not coerce [7] | Node batch only, so bundle size does not matter | 1 run (`test/extraction.test.ts` exists) | **REPLACE** the schema and structural validation with one Zod schema + `zodOutputFormat`. **KEEP** unit conversion, plausibility and `normaliseMeasuredAt` as a post-parse function (`.transform()` is unrepresentable in JSON Schema [4]). Keep the per-item drop semantics with `safeParse` per array element. Saves ~110 lines. Pin the SDK: 1.x is days old |
| 9 | Claude extractor: SYSTEM prompt, base64, text join (`extract/claude.ts`) | 96 | SDK `messages.parse` (as #8). Node `Buffer.toString('base64')` | ✓ | inside #8 | **REPLACE** the plumbing (~25 lines). **KEEP** the prompt, which is domain content |
| 10 | Sarvam STT: REST + 5-step batch job client (`stt/sarvam.ts`) + the poll loop in `steps.ts` | 136 + 11 | **`sarvamai`** official JS SDK 1.1.12: `speechToTextJob.createJob → uploadFiles → start → waitUntilComplete → downloadOutputs` [8]. Licence field missing on npm; the public repo URL 404s (unverified) | Node batch only | 1 run (`test/sarvam.test.ts` rewritten against a mocked client) | **REPLACE** behind the existing `SpeechToText` interface. Keep our error-to-transient mapping and the no-body-in-logs rule. Saves ~110 lines. Pin the exact version; re-check the licence before adopting |
| 11 | Red-flag rules + thresholds (`rules/engine.ts`, `config/thresholds.ts`) | 293 | json-rules-engine and similar generic engines | Generic engines move the logic into JSON and lose types and tests | — | **KEEP.** Clinical domain logic; pure functions, fully tested |
| 12 | Batch orchestration: 3 idempotent steps (`batch/steps.ts`, `batch/run.ts`) + workflow steps | 408 + 113 | Temporal, Airflow, Dagster, Prefect: all servers. GHA steps *are* the orchestrator | Every alternative needs always-on infrastructure | — | **KEEP.** Actions already provides scheduling, retries via re-run, logs and failure email. The TS is domain mapping |
| 13 | Git layout writer: stable-bytes NDJSON merge, month files (`batch/repo.ts`) | 174 | git-scraping style (Simon Willison) is a pattern, not a library | — | — | **KEEP.** Domain layout; deterministic output is what makes re-runs safe |
| 14 | Commit + rebase + retry push (`.github/scripts/commit-push.sh`) | 17 | **EndBug/add-and-commit** v11.1.1, MIT, `pull: --rebase --autostash`, `push_attempts` [9]. **stefanzweifel/git-auto-commit-action** v7.2.1 does not pull or retry, so it does not fit [9] | Both are third-party actions holding `contents: write` on a PHI repo | 0.5 run | **KEEP.** 17 lines of plain git versus a third-party action holding a write token to medical data. The supply-chain downside is irreversible; the saving is 17 lines |
| 15 | KB schema + build + validation: NDJSON → SQLite with CHECK/FK, plausible ranges, file rules, Telegram mapping (`tools/kb/build`, `schema/schema.sql`) | 203 + 154 | **sqlite-utils** 4.2.1, Apache-2.0, `insert --nl` [10]. **Frictionless** 5.21.0, MIT, one resource per table, which does not fit mixed-`rt` files [10]. **check-jsonschema** 0.38.2, whole-file oriented [10]. **LinkML** 1.12.1, heavy [10] | All run on GHA | 1 run for sqlite-utils | **KEEP.** SQLite itself is the validator (CHECK, FK, NOT NULL), so a JSON Schema / Frictionless layer would be a second schema to keep in sync. sqlite-utils would save only the ~30-line loader and add a dependency to a stdlib-only tool |
| 16 | KB views (`v_trend`, `v_latest`, `v_conflicts`, `v_needs_human`) | in schema.sql | dbt and similar | Overkill | — | **KEEP** (SQL views are the standard) |
| 17 | Query layer: `sqlite3` CLI + README queries | 0 code | **Datasette** 0.65.5 stable, Apache-2.0, ~11.5k★, local `datasette data/kb.sqlite` [10]. **DuckDB** 2.0.0, MIT [10]. datasette-lite needs a public CORS URL and has analytics on by default, so it is unfit for PHI [10] | Local Mac only | 0 (no code) | **DEFER / optional.** Run `uvx datasette data/kb.sqlite` locally when browsing helps. Never `publish`. Skip DuckDB (a second engine for no gain) |
| 18 | OCR: Apple Vision Swift script → `.ocr.md` sidecars (`tools/ocr/`) | 95 | **OCRmyPDF** 17.13.0, MPL-2.0, ~35k★, monthly [11]. **Tesseract** 5.5.3 `hin+eng` [11]. **PaddleOCR** 3.7.0 PP-OCRv5, Apache-2.0, Devanagari [11]. **docTR** 1.1.0, no Devanagari [11]. **Surya/Marker**: weights under modified OpenRAIL-M, slow on CPU [11]. **Docling** 2.142, MIT, high churn [11]. **ocrmac** 1.0.1, single maintainer [11] | Vision is macOS only; OCRmyPDF+Tesseract run cheaply on GHA | 1 run to add a CI OCR step | **KEEP** Apple Vision on the Mac (local, $0, good on print). **DEFER** OCRmyPDF + Tesseract `hin+eng` as the Linux path, adopted when documents must be OCR'd without the Mac. Escalate to PaddleOCR only if Tesseract disappoints on Hindi. Verify Apple Vision's Hindi support (`supportedRecognitionLanguages`) |
| 19 | Hard-read workflow (`tools/ocr/HARD-READ.md`, an agent runbook; no code) | 14 md | unpaper (last release 2022), ScanTailor Advanced (stale since 2023, GUI) [11]. No standard CLI covers crop → CLAHE → upscale → threshold → deskew | — | — | **KEEP** as a runbook executed by the agent service (`data_class=phi`). Optional `enhance.py` (OpenCV) only if the steps get repeated by hand |
| 20 | Video → page PDFs (`tools/doc-scan/scan.py`, OpenCV + img2pdf) | 372 | No OSS tool turns a top-down video with colour separators into per-document PDFs. Phone scanner apps are manual | Mac/offline tool | — | **KEEP.** Built on standard libraries (OpenCV, img2pdf); the remaining code is task-specific |
| 21 | Digest rendering: fixed Hindi templates (`batch/digest.ts`, `replies.ts`) + `splitMessage` | 62 + 52 + 14 | Template engines (Handlebars, Eta). `@gramio/split` is self-described WIP [12] | — | — | **KEEP.** String templates are the right size; safety rule "never LLM text" |
| 22 | Deploy: tests → `sed` db id → `d1 migrations apply` → `deploy` → `secret put` loop (`deploy-worker.yml`) | 73 | **cloudflare/wrangler-action** v4.1.3 (first-party, `secrets:`, `preCommands`, `command`) [13]. **`wrangler secret bulk`** (≥4.97) [13] | ✓ | 0.5 run | **REPLACE** the `secret put` loop with `wrangler secret bulk` (we already depend on wrangler, so no new action). Saves ~6 lines. wrangler-action is fine but adds nothing we need |
| 23 | Action versions: `actions/checkout@v4`, `actions/setup-node@v4` | — | checkout v7.0.1, setup-node v7.1.0. v4 declares `node20`; runners default to Node 24 since 2026-06-16, and Node 20 was removed 2026-09-23 [14] | — | trivial | **REPLACE** (bump to current majors, SHA-pinned). This is a breakage risk, not an aesthetic one |
| 24 | Dependency updates: none today | 0 | **Dependabot** (native, one yml; npm, pip, github-actions) [15]. **Renovate** (Mend Community Cloud, free for private repos, app install) [15] | ✓ | trivial | **ADD Dependabot**: weekly, grouped, `github-actions` + `npm` (`app/`) + `pip` (`tools/doc-scan`). Lighter than Renovate for one repo. Free on private repos is widely stated but not confirmed on a current docs page |
| 25 | Secrets: repo-level Actions secrets; Worker secrets pushed on deploy | — | **GitHub Environments**: on Free, environment secrets and required reviewers are public-repo only [16]. sops/age, Doppler, Infisical | Environments give no value on Free private | — | **KEEP** repo secrets (one place, documented rotation in `app/DEPLOY.md`). No vault for 8 secrets |
| 26 | Monitoring / dead-man: daily digest = family heartbeat; optional `curl` to a healthchecks URL | 8 yml | **healthchecks.io** Hobbyist free: 20 checks, 100 log entries; code BSD-3, self-hostable [17]. Better Stack free: 10 heartbeats; Dead Man's Snitch: 1 [17] | ✓ | trivial | **ADOPT** (make it required, not optional). One check, period 1 d, grace 3 h, email alert. Already wired; this is configuration, not code |
| 27 | Secret scanning: none | 0 | GitHub push protection for private repos needs Team/Enterprise [18]. **gitleaks** 8.30.1 (feature-complete, security fixes only; the action needs a licence key for org repos) [18] | CLI step works on Free | 0.5 run | **DEFER.** Low value: no secrets are in code paths, and all of them live in Actions secrets. Add `gitleaks` CLI (not the action) as a pre-commit hook if agents start writing config files |
| 28 | Backups | 0 | git (every clone is a full copy), D1 Time Travel 7 days on Free + `wrangler d1 export` [19]. R2: no object versioning (unimplemented); **Bucket Locks** available [19] | ✓ | trivial | **KEEP.** Git is the store of record; D1 is a 14-day inbox; R2 is a second media copy. **DEFER** an R2 bucket-lock rule (e.g. 30 days) against accidental deletes |
| 29 | Tests: vitest + `node:sqlite` D1 shim + `scripts/e2e-local.mjs` (workerd via wrangler dev) + `tools/kb/test_build.py` | 891 + 58 | **@cloudflare/vitest-pool-workers** 0.23.0: real D1/R2 bindings in Miniflare, but its peer dependency is **vitest ^4.1** and we are on vitest 5 [20] | — | 1 run | **DEFER** until the pool supports vitest 5; then it can replace `e2e-local.mjs` (116 lines). **KEEP** the rest |

## Totals
- **REPLACE:** #8 + #9 (Zod 4 + SDK `zodOutputFormat`, ~135 lines), #10 (`sarvamai` SDK, ~120 lines), #2 (runtime `timingSafeEqual`, ~6), #22 (`secret bulk`, ~6), #23 (action bumps). That is **≈270 lines** of 2,152, about 13%.
- **ADD:** Dependabot, a required healthchecks.io check. Both are configuration only.
- **KEEP:** the remaining ~87% is domain logic: the Hinglish vitals parser, clinical rules, KB mapping, deterministic git layout, Hindi digest templates. Or it is already the standard tool (D1 migrations, SQLite as validator, GHA as orchestrator).
- **Rejected outright:** Telegraf (dormant), Instructor-js (dormant), BAML (DSL + native binaries), ORMs, Frictionless/LinkML, datasette-lite (PHI), Surya/Marker on CI (licence + CPU), git-auto-commit-action (no retry), workflow engines.

## Sources
1. grammY: https://github.com/grammyjs/grammY · https://www.npmjs.com/package/grammy · https://www.npmjs.com/package/@grammyjs/types · https://grammy.dev/hosting/cloudflare-workers-nodejs · https://github.com/grammyjs/grammY/blob/main/src/convenience/webhook.ts · https://bundlephobia.com/package/grammy@1.46.0
2. Telegraf: https://github.com/telegraf/telegraf · https://www.npmjs.com/package/telegraf
3. Drizzle / Kysely: https://github.com/drizzle-team/drizzle-orm · https://orm.drizzle.team/docs/connect-cloudflare-d1 · https://orm.drizzle.team/docs/guides/d1-http-with-drizzle-kit · https://github.com/kysely-org/kysely · https://github.com/aidenwallis/kysely-d1
4. Zod / Valibot: https://github.com/colinhacks/zod · https://zod.dev/json-schema · https://www.npmjs.com/package/zod · https://github.com/open-circle/valibot
5. Anthropic SDK helpers: https://github.com/anthropics/anthropic-sdk-typescript/blob/main/helpers.md · https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/helpers/zod.ts · https://www.npmjs.com/package/@anthropic-ai/sdk
6. Instructor-js / BAML: https://github.com/567-labs/instructor-js · https://github.com/BoundaryML/baml · https://www.npmjs.com/package/@boundaryml/baml
7. Ajv: https://github.com/ajv-validator/ajv
8. Sarvam SDK: https://registry.npmjs.org/sarvamai/latest · https://docs.sarvam.ai/api-reference-docs/speech-to-text/batch
9. Commit actions: https://github.com/EndBug/add-and-commit · https://github.com/stefanzweifel/git-auto-commit-action
10. KB tools: https://github.com/simonw/sqlite-utils · https://github.com/simonw/datasette/releases · https://github.com/simonw/datasette-lite · https://github.com/duckdb/duckdb · https://framework.frictionlessdata.io/docs/formats/json.html · https://github.com/python-jsonschema/check-jsonschema · https://github.com/linkml/linkml
11. OCR: https://github.com/ocrmypdf/OCRmyPDF · https://github.com/tesseract-ocr/tesseract · https://github.com/tesseract-ocr/tessdata_best · https://github.com/PaddlePaddle/PaddleOCR/releases · https://www.paddleocr.ai/latest/en/version3.x/algorithm/PP-OCRv5/PP-OCRv5_multi_languages.html · https://arxiv.org/pdf/2604.16504 · https://github.com/mindee/doctr · https://github.com/datalab-to/surya · https://github.com/datalab-to/marker · https://github.com/docling-project/docling · https://github.com/straussmaximilian/ocrmac · https://github.com/unpaper/unpaper · https://github.com/4lex4/scantailor-advanced · https://developer.apple.com/documentation/vision/recognizetextrequest/supportedrecognitionlanguages
12. Telegram split: https://github.com/gramiojs/split
13. Wrangler: https://github.com/cloudflare/wrangler-action · https://developers.cloudflare.com/workers/wrangler/commands/workers/
14. Actions runtime: https://api.github.com/repos/actions/checkout/releases/latest · https://raw.githubusercontent.com/actions/checkout/v4/action.yml · https://github.blog/changelog/2026-09-23-deprecation-of-node-20-on-github-actions-runners/
15. Dependabot / Renovate: https://docs.github.com/en/code-security/dependabot/ecosystems-supported-by-dependabot/supported-ecosystems-and-repositories · https://docs.renovatebot.com/mend-hosted/overview/
16. Environments: https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments
17. healthchecks.io: https://healthchecks.io/pricing/ · https://github.com/healthchecks/healthchecks · https://healthchecks.io/about/
18. Secret scanning: https://docs.github.com/en/code-security/secret-scanning/introduction/about-push-protection · https://github.com/gitleaks/gitleaks · https://github.com/gitleaks/gitleaks-action
19. Backups: https://developers.cloudflare.com/d1/reference/time-travel/ · https://developers.cloudflare.com/d1/wrangler-commands/ · https://developers.cloudflare.com/r2/api/s3/api/ · https://developers.cloudflare.com/r2/buckets/bucket-locks/
20. Workers testing: https://www.npmjs.com/package/@cloudflare/vitest-pool-workers · https://developers.cloudflare.com/workers/platform/limits/

## GitHub Actions cost (private repo, GitHub Free)
The analysis assumes a **private repo owned by an organization on the `free` plan** (check with `gh api orgs/<org>`: `plan.name`). Minutes are billed to the org, not to the user account. The plan a deployment actually uses is an env choice (env repo).

| Item | Value (verified 2026-10-25) | Source |
|---|---|---|
| Included minutes, Free org (and Free personal) | 2,000 min/month, private repos | https://docs.github.com/en/billing/concepts/product-billing/github-actions |
| Artifact storage (shared with Packages) | 500 MB; overage $0.25/GB-month | same |
| Actions cache | 10 GB per repo included, separate from artifacts; $0.07/GB-month only if the limit is raised above 10 GB | same |
| Overage, Linux 2-core x64 | $0.006/min (arm64 $0.005, 1-core slim $0.002) | same |
| 2026 changes | Hosted-runner prices cut by up to 39% from 2026-01-01; free quotas unchanged. The $0.002/min "cloud platform" fee for self-hosted runners (planned 2026-03-01) is **postponed**, with no new date; the docs say self-hosted usage is free | https://github.blog/changelog/2025-12-16-coming-soon-simpler-pricing-and-a-better-experience-for-github-actions/ · https://resources.github.com/actions/2026-pricing-changes-for-github-actions/ |
| Cron caveats | Schedules "can be delayed during periods of high loads"; "some queued jobs may be dropped"; minimum interval 5 min | https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows |
| 60-day auto-disable | Documented **for public repositories only** ("In a public repository, scheduled workflows are automatically disabled when no repository activity has occurred in 60 days"). It is not documented for private repos, and the daily batch commits to `main` every day anyway, which counts as activity | same |

Per-job rounding is not stated on the current page. The estimate below assumes each job rounds up to a whole minute.

| Workload | Runs/month | Billed min/run | Min/month |
|---|---|---|---|
| Daily batch (npm ci, pull, extract with LLM/STT waits, KB build, 2 commits, digest) | 30–31 | 3–5 (up to 15 when a long voice note polls Sarvam) | 90–155 |
| Deploy + CI tests (`deploy-worker.yml`: test, typecheck, KB self-test, deploy) | 10–30 pushes to `app/` | 2–3 | 20–90 |
| KB build | inside the batch and CI | <0.2 | ~0 extra |
| Dependabot PR CI (after #24) | ~4–8 | 2 | 8–16 |
| Future weekly jobs (doctor brief submit, OCRmyPDF on new PDFs, D1 export) | 4–12 | 2–5 | 8–60 |
| **Total** | | | **≈130–320 of 2,000 (7–16%)** |

**Cost: $0.** Headroom is ≈1,700 min/month, so even 6× today's load stays free. Storage: we upload no artifacts, and the npm cache is ~100 MB of the 10 GB cache allowance. The real exposure is a runaway loop. The 45-min batch timeout and the 15-min deploy timeout cap that at ~1 h per day. Set the org's Actions budget to $0 so overage stops jobs instead of billing (Billing → Budgets).
