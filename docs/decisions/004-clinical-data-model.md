# 004 — Clinical data model

Date: 2026-10-24 · Status: **ACCEPTED** (decisions by the user, 2026-10-24) · Related: 001 (Telegram), 003 (medical data in git)

> **Amended by ADR 007 (2026-10-26).** The table design below (encounter/observation/condition/medication/event tables, the per-table provenance block, numeric `confidence`, the id conventions) is replaced by `source` / `fact(kind)` / `ref` with namespaced ids `<ns>:<src|fact>:<local>` and `ref:<kind>:<local>`. Provenance principles, source rank, the human tier and git-as-truth still hold. `schema/schema.sql` follows ADR 007.

## Context
Facts live in three places that share no ids or codes: hand-written markdown (per-person profiles in the records repo, timeline tables with `[KEY] p.N` citations), agent batch notes (per scan batch and per chat export, in the records repo) plus per-PDF `.ocr.md` sidecars, and the bot's D1 (`messages`, `readings`, `symptoms`, `alerts`). A question such as "every potassium value, with its source" can only be answered by reading prose.

Scale: a few persons, hundreds of documents, a few thousand observations a year (mostly Telegram vitals). Maintained by AI agents plus one person.

Requirements:
1. Every fact is tied to a person, a time (with its precision), an organisation or practitioner where known, and its context.
2. Every fact points to its source file and page, a verbatim quote, the extractor, a confidence and a verification state.
3. Document facts and Telegram facts land in one model, queryable together with SQL.
4. Git is the source of truth for **all** data (ADR 003). Records and flags only; no diagnosis.
5. OSS and free only. No licences, no paperwork. Complexity is debt: nothing that is not queried.

## Options considered
| | A. Keep markdown | **B. Flat records (NDJSON in git) + generated SQLite** | C. FHIR server (HAPI / Medplum / Fasten) | D. OMOP CDM |
|---|---|---|---|---|
| Build cost | 0 | ~2 agent-runs | 3–6 runs + hosted service + ops | 5+ runs + vocabulary load + ETL |
| Run cost | grows per fact, drifts | low: agent appends NDJSON, build is one script | upkeep, auth, backups | concept-map every fact |
| Impact | no trends or alerts over docs + Telegram | one timeline, provenance per fact | interop, weak for SQL aggregates | population analytics; ~0 at family scale |
| Asymmetric risk | cheap now, migration cost grows linearly | low lock-in; plain SQL + JSON | high fixed cost for speculative interop | cost certain, benefit absent |

Rejected inside B: storing native FHIR JSON (≈10x the tokens of a flat row, nested).

## Decision: option B
- **Git is canonical for everything.** Document facts: `data/<person>/docs/<source-id>.ndjson`, one file per source document; re-extracting a document replaces one file and review is a diff. Telegram data: `data/telegram/YYYY-MM.ndjson` (exported, below). Reference tables: `data/ref/{code,drug,party}.ndjson`. Persons: `data/persons.ndjson`.
- **D1 is a replica/cache** for the bot. It may be dropped and rebuilt from git at any time.
- **One schema**, `schema/schema.sql`. `tools/kb/build` validates all NDJSON against it and rebuilds `data/kb.sqlite` (gitignored, seconds). The same DDL becomes D1 migration `0005_clinical.sql` later.
- **Codes, OSS only:** LOINC (free, attribution) on observation codes; a hand-kept local brand → generic table (`data/ref/drug.ndjson`, with `certainty` per row); ICD-10 only as an optional free-text field on `condition`. **No SNOMED CT, no RxNorm, no ABDM** import or export. A FHIR R4 export script is a possible later note only; the table names below follow FHIR so it stays cheap.

## Telegram ↔ git sync (follow-up; app/ is not changed by this ADR)
> **Superseded by ADR 005 (2026-10-25).** D1 is now only an inbox; a daily batch commits the raw updates and the extracted rows to git, so there is no 3-hourly export and no `d1-rebuild`. The row shape (`rt = d1.<table>`) and the KB mapping in step 4 are kept.

Chosen: **one scheduled GitHub Actions workflow** in the private repo (`.github/workflows/telegram-sync.yml`, built 2026-10-25 with `tools/telegram-sync/sync.py`; see [deploy.md](../platform/deploy.md)), every 3 hours plus manual dispatch, `concurrency: d1-sync`.
1. **Export.** `wrangler d1 execute <d1-name> --remote --json` dumps rows of `persons, chats, messages, readings, symptoms, alerts` (not `outbox`: transient delivery state) for the current and previous month, sorted by id. It rewrites `data/telegram/YYYY-MM.ndjson` (one line per row, `rt` = `d1.<table>`) and copies new R2 media (`media_ref`) to `sources/<person>/media/telegram/`. It runs `tools/kb/build` and commits with the repo's own `GITHUB_TOKEN` only if the diff is non-empty.
2. **Idempotent ids.** D1 ids are already random UUIDs fixed at insert (`newId()` in `app/src/store.ts`); messages also carry the unique Telegram `external_id`. The export is a pure function of D1 state, so re-running it gives the same bytes. KB ids derived from it are `tg:<table>:<uuid>`. Rewriting two months picks up late edits (e.g. `confirmed` set after a month rolls over).
3. **Rebuild D1 from git.** `tools/kb/d1-rebuild` (later) applies migrations to an empty D1 and loads `data/telegram/*.ndjson` with `INSERT OR REPLACE` by id; then upserts the document facts once `0005_clinical` exists. Idempotent by id, so it is safe to re-run.
   Implementation notes (2026-10-25): the export calls the D1 REST `/query` endpoint (accepts D1 Read) instead of wrangler, stdlib Python only; months are IST months of the source message; `persons`/`chats` go to `data/telegram/directory.ndjson`; rows in git but missing from D1 are kept (an export never deletes from git). Media per ADR 003: photos, PDFs and voice notes go to git, videos never. Step 3 is `sync.py rebuild-sql`.
4. **Mapping into the KB** happens in `build`, not in the bot: `readings` → `observation` (category `vital`/`lab`), `symptoms` → `observation` (category `symptom`; a `fall` → `event`), each message → a `source` (kind `telegram_msg`). `confirmed = 1` → `verification = 'patient'`; `-1` → `status = 'entered-in-error'`.

Cost: about 1 Actions minute per run, ≈240 min/month (inside the free 2,000 for private repos); one Cloudflare API token (D1 read + R2 read) stored as a repo secret. Failure modes: GitHub cron is delayed or skipped under load (data lands at the next run; D1 still holds it); token expiry or a Cloudflare outage fails the job loudly (email on failure) and the next success catches up, because each run re-exports whole months; a D1 rebuild loses at most the rows written since the last successful export (≤3 h; run a manual export before any rebuild). Rejected: a Worker cron pushing via the GitHub API (needs a PAT with write access to PHI kept in Cloudflare, plus sha-handling code in TS); a laptop pull job (stops when the laptop is off).

## Minimal schema (`schema/schema.sql` is authoritative)
Provenance block (P) on every fact table: `source_id`, `page`, `locator`, `quote` (verbatim, ≤200 chars), `extracted_by`, `extracted_at`, `confidence` (0–1), `verification` (`unverified|agent|human|patient|clinician`), `verified_by`, `verified_at`, `hard_read_id`, `status` (`active|superseded|entered-in-error`), `supersedes_id`, `note`. Facts are never edited in place: a correction adds a row with `supersedes_id`, and the old row becomes `superseded`.

| Table | FHIR name | Key fields |
|---|---|---|
| `person` | Patient | id (a namespace such as `alice`, `bob`), name, relation, dob, sex, identifiers JSON, name_variants JSON. Persons without records are minimal |
| `party` | Organization / Practitioner | id, kind (`hospital|lab|clinic|pharmacy|practitioner|other`), name, qualification, reg_no, org_id, city |
| `source` | DocumentReference | id (file slug), person_id, path, sha256, kind, issued_at, org_id, practitioner_id, pages, ocr_path, **rank** (`original > copy > ai_summary`), duplicate_of, identifiers JSON |
| `encounter` | Encounter | id, person_id, kind, start, end, org_id, practitioner_id, reason_text + (P) |
| `observation` | Observation | id, person_id, category, code → `code`, value_num / value_text, unit (canonical), value_raw, unit_raw, ref_low, ref_high, ref_text, flag (`H|L|N`), flag_basis (`printed|bold|computed`), effective_at, time_precision, specimen, method, components JSON, report_id, encounter_id, org_id + (P) |
| `condition` | Condition | id, person_id, text_as_written, label, icd10 (optional), status_as_documented + (P) |
| `medication` | MedicationStatement | id, person_id, kind (`prescribed|reported_taking|stopped|dispensed`), brand, drug_id → `drug`, strength, schedule_raw (`1-0-1`), dose_m/n/e, start, end, prescriber_id + (P) |
| `event` | Procedure / other | id, person_id, kind (`procedure|travel|fall|missed_dose|hospitalisation|other`), label, start, end, detail JSON + (P) |
| `code` (ref) | — | code, display, category, loinc, unit, plausible_min/max (the validator's sanity bounds) |
| `drug` (ref) | Medication | id (brand slug), brand, generic, ingredients JSON, class, certainty (`confirmed|probable|uncertain`), evidence |

Views: `v_trend` (active values by person and code, with citation and rank), `v_latest` (latest per person and code; best rank wins a tie), `v_conflicts` (same person, code and day, different value), `v_needs_human` (the human tier below).

## Rules for sources and verification
- **Source rank.** `original` (the document itself) > `copy` (a photo or re-scan of it; set `duplicate_of`) > `ai_summary`. Notion AI summaries are **not** bulk-loaded. A fact from them is loaded only when no primary source has it, only after an agent check that the summary states it plainly, with `source.rank = 'ai_summary'` and `verification = 'agent'` at most.
- **Human tier (the user):** every `medication` row (medicines and doses); observations with `confidence < 0.8` or an unresolved `hard_read_id`; anything that feeds bot alerts (codes the rules engine reads: weight, bp, pulse, spo2, potassium, sodium, creatinine). `v_needs_human` lists exactly these. Everything else is agent-verified (the agent views the page image and records `verified_by`).

## Worked example (pilot, done)
A pilot lab report was migrated to `data/<ns>/docs/<source-id>.ndjson`: 1 source, 1 encounter, 21 observations (two pages; values printed on both pages stored once). Each observation row carries `value_num`, `unit`, `ref_text`, `flag`, `flag_basis`, `effective_at`, `page`, a verbatim `quote` and `verification` (for example `agent` after a page-image check). Values are in the KB, not here (records repo; see [records-guide.md](../records-guide.md)). Parties go in `data/ref/party.ndjson`. A referrer whose identity is uncertain is stored with a note such as "possibly = <named doctor>; unconfirmed": identity merges are explicit edits, never guesses.

## Where the markdown fits
- **Generated (never hand-edited):** profile timeline tables (key lab and imaging series, medications, BP), the source-key list and the doctors list. Written to `knowledge-base/generated/<person>-*.md` (since 26-Oct-2026: the curated pages under `docs/health/<person>/` with `generated: true`; see [records-guide.md](../records-guide.md)) and spliced between `<!-- gen:NAME -->` markers; each row keeps its `[source p.N]` citation.
- **Hand-written:** narrative, conflict reasoning, condition notes, doctor questions, gaps. They cite record ids (`obs:…`), not restated values.
- **Batch notes and `.ocr.md` sidecars** stay as the audit trail and are frozen after migration. New documents go OCR → sidecar → NDJSON.

## Plan
| Step | Work | Agent-runs |
|---|---|---|
| 0 | Schema, `code`/`drug`/`party` refs, `tools/kb/build`, pilot (one document) | **done** |
| 1 | Migrate everything else per [kb-migration-plan.md](../research/kb-migration-plan.md) (scan batches, discharge packs, chat images, older PDFs) | ~10, in parallel |
| 2 | Reconcile against the profiles; generate the profile views | 2 |
| 3 | Follow-up, after the bot deploy trial: the sync workflow above, `d1-rebuild`, D1 migration `0005_clinical` | 2 |

## Query path for agents
1. Orient: the generated profile, then `tools/kb/README.md`.
2. Retrieve: SQL on `data/kb.sqlite` (run `tools/kb/build` first), always on `status = 'active'` or through the views.
3. Verify: for any value that drives a flag, open `source.path` at `page` and compare with `quote`; report the `verification` level.
4. Reason: correlate by time window (medication changes ↔ labs ↔ symptoms ↔ vitals). Output flags and doctor questions with record ids; never diagnosis or dose advice.

## Asymmetric costs
- Late is costly: every new document and Telegram month adds markdown to re-parse later. Now costs ~12 runs once.
- The main harm is a wrong value stated confidently. `quote`, `confidence`, `verification` and `v_needs_human` make that visible; markdown hides it.
- Reversal is cheap: NDJSON plus SQL export to anything, FHIR included. C or D first would be expensive to undo.
