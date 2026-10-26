# 007 — Simplified clinical data model

Date: 2026-10-26 · Status: **ACCEPTED** (the user, 2026-10-26) · Amends: 004 (replaces its table design; keeps its provenance principles, source rank, human tier, git-as-truth and OSS-only rules) · Related: 003, 005

## Context
The structured KB is now the **source of truth**. Curated pages and timelines are views that cite KB ids. ADR 004 had 8 fact/anchor tables (encounter, observation, condition, medication, event, plus source, code, drug and party), each repeating a 14-column provenance block. Ids were ad hoc (`obs:<src>:p2:potassium`, `enc:<person>:2026-01-15T1656:<org>`, bare slugs for refs), had page numbers in them, and carried no namespace. The KB has 4 documents so far. The re-key costs least now.

## Decision
**Three concepts.**
| Concept | Table | What |
|---|---|---|
| source | `source` | anything received: document, photo, voice note, Telegram message, chat line. path, sha256, kind, issued_at, received_at, sender, text_path (OCR or transcript), pages, rank (`original > copy > ai_summary`), duplicate_of, org/practitioner, context_id |
| fact | `fact` | **every** clinical statement, `kind` ∈ observation, medication, condition, event. A visit, admission or procedure is an `event` with `data.type` (opd, admission, teleconsult, test_visit, in_absentia, home, procedure, travel, fall, missed_dose, hospitalisation, other). Other facts link to it with `context_id` |
| ref | `ref` | `kind` ∈ drug (local brand → generic, with certainty), code (LOINC etc.), party (organisation or practitioner) |

`person` stays as the namespace registry. Since ADR 008 the namespaces come from the records repo's `records.yaml` (`namespaces:`), never from code. Questions, answers and actions are **not** in the KB; they stay in the docs register.

**Ids.** `<ns>:src:<local>`, `<ns>:fact:<local>`, `ref:<drug|code|party>:<local>`.
```
^(?:(<ns1>|<ns2>|…|family):(src|fact)|ref:(drug|code|party)):([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$
```
- ns ∈ the person namespaces in `records.yaml` plus `family` (the build assembles the regex at runtime; the example family uses `alice`, `bob`). Refs use ns `ref`.
- local: lowercase `[a-z0-9.-]`, **date-first** (`YYYY-MM-DD-…`) where the item is dated, with dots for sub-parts. **No page numbers** (page is a field).
- source: `<ns>:src:<file stem>`, and the file is `data/<ns>/docs/<stem>.ndjson`, e.g. `alice:src:2026-01-15-example-lab-biochemistry-lft-rft`.
- fact from a document: `<ns>:fact:<source-local>.<key>`. The key is the code local (observation), the drug local (medication) or a short slug (condition, event). A repeat of the same key in one source gets `.2`, `.3`. Example: `alice:fact:2026-01-15-example-lab-biochemistry-lft-rft.potassium`.
- visit/admission event (shared by several sources): `<ns>:fact:<date>-<type>-<party-local>`, e.g. `alice:fact:2026-02-10-opd-dr-example` (party `ref:party:dr-example`; an organisation is e.g. `ref:party:example-hospital`).
- ref: `ref:drug:<brand-slug>`, `ref:code:<code>` (`_` → `-`, e.g. `ref:code:bilirubin-total`), `ref:party:<org-slug>-<city>` or `ref:party:dr-<first>-<last>`.
- Telegram: `<ns>:src:<IST date>-tg.<d1 message id>` and `<ns>:fact:<IST date>-tg.<d1 row id>`, with `:` → `.` (e.g. `bob:fact:2026-10-10-tg.-1001234567890.456.r0`). A BP reading's pulse gets `.pulse`.

**The fact envelope** (every fact; `schema/schema.sql` is authoritative):
`id, ns, kind, at` (ISO-8601, `+05:30` when it has a time), `at_precision` (minute|day|month|year), `data` (a JSON object, validated per kind by `schema/<kind>.schema.json`), `source_id, page, locator, quote` (verbatim, ≤200), `context_id`, `verification` (unverified|agent|human|patient|clinician), `verified_by, verified_at`, `uncertain_ref` (an open hard-read id or null), `status` (active|superseded|retracted), `supersedes`, `recorded_by, created_at, tags[], note`.
- **Numeric confidence is dropped.** A value is either settled or has an open `uncertain_ref`. The migration keeps the old number in the id map, and a value that was below 0.8 gets the tag `low-confidence`.
- **Medication:** `data.status` ∈ prescribed, dispensed, taking, stopped records what the statement says. `verification` records how well it was **read**. A `prescribed` line verified against the strip photo is `verification = human` and `status = prescribed`. It becomes `taking` only when someone reports taking it.
- Sources and refs carry the same `recorded_by, created_at, status, supersedes, tags, note`.
- Corrections add a row with `supersedes`. The old row becomes `superseded` (the build checks this).

**Views:** `v_trend`, `v_latest`, `v_conflicts`, `v_needs_human` (medications not human/clinician-verified, anything with `uncertain_ref` or `low-confidence`, alert-input observations), `v_timeline` (events, medication statements and key observations per ns, ordered), `v_meds_current` (latest statement per drug per ns, with status and verification).

**The build** (`tools/kb/build`) validates: the id regex; that the class matches the row type; that ns matches the directory; that kind and `data` match the JSON Schema (a stdlib subset validator; the `x-ref` keyword marks ref-valued fields); referential integrity (source_id, context_id, supersedes, duplicate_of, and the party/drug/code refs inside `data`); unique ids; the required envelope fields; `at` against `at_precision`; and that every superseded row is marked as such.

**Migration:** `tools/kb/migrations/007_simplify.py` (idempotent) re-keyed all existing rows (a few hundred: sources, facts and refs). It merged the per-task ref files into `data/ref/{code,drug,party}.ndjson` and wrote `data/meta/id-map-007.ndjson` (old → new, plus the old confidence) for rewriting doc citations. The Telegram files keep the bot's `d1.*` row shape; the build maps them.

## Options considered
| | Keep ADR 004 tables, add ns ids | **Three concepts + typed JSON data** | Full FHIR resources |
|---|---|---|---|
| Cost | re-key only | re-key + build rewrite (1 run) | high, nested, ≈10x tokens |
| Run cost | 9 tables, 14-col provenance per table | one envelope, one place to check | heavy |
| SQL | plain columns | `json_extract` in views (indexed for code) | poor |
| Risk | schema drift per table | per-kind JSON Schemas must stay in sync with views | lock-in |

## Asymmetric costs
- Re-keying is cheap now (4 documents) and expensive after the ~45-file migration wave. That is why the hold on wave 1 waited for this ADR.
- The main loss is plain-column SQL on fact fields. The views hide it.
- The id map makes old citations in docs recoverable. Nothing is deleted, and git keeps every pre-007 row.
