# tools/kb — clinical knowledge base build

Design: [ADR 007](../../docs/decisions/007-simplified-clinical-data-model.md) (amends [ADR 004](../../docs/decisions/004-clinical-data-model.md)). Migration notes: [kb-migration-plan](../../docs/research/kb-migration-plan.md).

The tools run from the product checkout against a separate **records repo** (`<records-dir>`); no records live in the product.

```sh
python3 -I tools/kb/build --records <records-dir> [--env <env.yaml>] [--check]
    # validate <records-dir>/data/**/*.ndjson, rebuild <records-dir>/data/kb.sqlite (gitignored);
    # --check validates only and writes nothing
python3 -I tools/kb/build --records <records-dir> --db /tmp/x.sqlite
python3 -I tools/kb/gen-views --records <records-dir> [--check]
    # refresh the generated page sections; --check exits 1 if a page is stale (writes nothing)
python3 -I tools/kb/build --records <records-dir> && python3 -I tools/kb/gen-views --records <records-dir>
    # after every data/ change: rebuild, then refresh the pages
python3 -I tools/kb/lint-actions --records <records-dir> [--today YYYY-MM-DD]
    # wording lint for OPEN to-dos and questions; exit 1 on any finding (see below)
python3 -I tools/kb/test_build.py       # product tests, run against fixtures/records-example/
python3 -I tools/kb/test_gen.py
```
Python stdlib + sqlite3 only, run as `python3 -I`. Exit 1 on any error; `kb.sqlite` is then left unchanged.
Run it before every records commit that touches `data/`.

**Records config.** Namespaces and display names come from `<records-dir>/records.yaml`, never from code:
```yaml
schema_version: 7          # checked: the build refuses a version it does not support
namespaces:                # person namespaces (plus the shared `family`)
  alice: {display: Alice}
  bob: {display: Bob}
d1_person_map:             # D1 person id -> namespace, where they differ (same id otherwise), for Telegram rows
  alice-tg: alice
```
The JSON Schemas and DDL live in the product [`schema/`](../../schema/). A synthetic example records repo that passes
the same validation is at `fixtures/records-example/`.

## Generated page sections (`gen-views`)
`tools/kb/gen-views` fills only the text between `<!-- gen:NAME start -->` and `<!-- gen:NAME end -->` in
`<records-dir>/docs/health/<ns>/*.md`; everything outside the markers is left as written. Each block opens with
"_Generated from the KB on <date> (data as of <latest fact date>; <n> facts)…_" and every row cites the fact id and the
source path/page. A block whose content has not changed keeps its old date line, so re-runs give no diff.

| Block | Page | From |
|---|---|---|
| `timeline` | `timeline.md` | `v_timeline` plus superseded rows from `fact`; oldest first, by year and month; marks uncertain, family/patient-reported, recollection, conflict |
| `meds-current`, `meds-history` | `medications.md` | `v_meds_current` (split into "current" and "not in the current list" when the ns has a `med-list-complete` event); every medication fact (superseded included); the prescriber column shows role, specialty, registration and public-check status |
| `labs` | `labs.md` | `v_trend` key series (per person in `<records-dir>/data/meta/gen-views.json`; a person without a list gets every code), printed or computed flags, ranges |
| `quality` | `data-quality.md` | `v_conflicts`, `v_internal_contradictions`, `v_needs_human` counts by reason, open hard reads, corrections |
| `glance`, `asof` | `summary.md` | recent `v_meds_current` rows, `v_latest` key values; the "Data as of" line |
| `care-team` | `care-team.md` | every party linked to the person's facts (or printed on their documents): `data.credentials` as printed + public checks, first/last seen, medicine instructions per prescriber. Display only |

Add a block by placing the two marker lines in a page and running the script; an unknown NAME is an error.
CI: the records repo runs `gen-views --records . --check` so a stale page fails; the batch runs `gen-views` after the build step.

## Wording lint (`lint-actions`)
`tools/kb/lint-actions --records <records-dir>` reads `docs/health/family/actions.md` and every `docs/health/<ns>/questions.md`,
takes each `### <ns>:<q|act>:NNNN:` block whose text says `**Status:** open`, and prints one line per finding
(`<id> <file>:<line> <rule>: <detail>`; exit 1 if any). Rules, from the records repo's family context page
(`docs/health/family/context.md`, "Rules for every agent recommendation"): **urgency**: a line with *today*, *ASAP*,
*immediately*, *rush* or *urgent(ly)* unless the same line says `Tier A` or the bullet starts with `**Superseded`
(text inside double quotes is ignored: verbatim report wording, the family's own diary line); **no-tier**: no
`Tier A`, `Tier B` or `Tier C` anywhere in the block (the notation the dx loop writes, e.g. `Tier C (next visit)`);
**stale-now**: `**Priority:** now` with an `**Added:**` date more than 7 days before today (`--today` for tests).
Fix a finding in place: append an `- **Update <date> (lint):** Tier C …` line and change the priority; mark a stale
update by prefixing the bullet with `**Superseded <date> …:**`; never rewrite the Ask or renumber ids.
`test_gen.py` runs it on `fixtures/records-example/` (or `--records DIR`, as the records CI does) and fails on findings.

## Model (ADR 007)
Three concepts: **source** (anything received), **fact** (every clinical statement; `kind` = observation | medication |
condition | event; visits and admissions are events that other facts point at with `context_id`), **ref** (`kind` = drug |
code | party). Ids: `<ns>:src:<local>`, `<ns>:fact:<local>`, `ref:<drug|code|party>:<local>`; ns = a namespace from
`records.yaml` or `family`; local = `[a-z0-9.-]`, date-first, no page numbers (the id regex is built at runtime from
`records.yaml`; see `schema/schema.sql` and ADR 007).
Every fact has the envelope `at, at_precision, data, source_id, page, locator, quote, context_id, verification,
uncertain_ref, status, supersedes, recorded_by, created_at, tags`; `data` is checked against `schema/<kind>.schema.json`.

**Source rank:** `original > copy > recollection > ai_summary`. `recollection` is a person's later account from memory
(e.g. the user recalling a visit): below any document and its copies, above an AI summary.

**External raw files:** a source whose raw file is kept outside git on purpose (e.g. `<media-dir>/`)
sets `"external": true` and says where in `note`; the build then skips the path check. Without a note it is an error.

**Credentials (party refs).** `data.credentials` holds what the documents print (each field cited in `printed[]`: source id, page, quote) and the public checks (`verified[]` / `accreditation[]`: URL, date, matched / not found / mismatch / not checked). Display only, never a rank ([AGENTS.md](../../AGENTS.md) section 6; method: the records repo's `docs/log/research/2026-10-27-clinician-credentials.md`). Inside `data`, `x-ref: source` marks a citation that must resolve to a source.

**Folding a per-task ref that adds to an existing ref.** A row in `data/ref/<kind>-<TASK>.ndjson` with the id of an existing ref replaces it on fold only if it keeps every value and just adds (data keys, tags, text appended to the note); any changed value stops the run.

**Merging duplicate refs (alias, not rewrite).** Facts are never edited (ADR 007), so a duplicate ref is merged by
setting `supersedes: <duplicate id>` on the kept ref and `status: superseded` on the duplicate. Facts keep the id they
were written with; `v_ref_current` maps every ref id to its active successor, and `v_trend` (so `v_latest`,
`v_conflicts`, `v_timeline`) reports the resolved code (`code_as_written` keeps the original). Suspected but unconfirmed
identities are not merged: both rows get the tag `possible_same_as:<other id>` and a note.

**Fitness rows (ADR 015).** Written only by `tools/fitness`: `category: fitness`, built-in `ref:code:fitness-*` codes, read through `v_fitness`, never `v_trend`. Page: `docs/health/<ns>/fitness.md`, block `gen:fitness`.

## Layout (records repo, unless marked product)
| Path | Holds |
|---|---|
| `schema/schema.sql` (product) | the DDL and views (authoritative envelope and enums) |
| `schema/<kind>.schema.json` (product) | JSON Schema for `fact.data` (observation, medication, condition, event) and `ref.data` (drug, code, party); `x-ref` marks ref-valued fields |
| `records.yaml` | the namespace registry (`namespaces:`), the D1 person map (`d1_person_map:`) and `schema_version` (`family` is a shared ns without an entry) |
| `data/ref/{code,drug,party}.ndjson` | refs. Parallel tasks may add `data/ref/<kind>-<TASK>.ndjson`; fold them afterwards into the per-kind files (merges and deletes them; already-folded rows are skipped) |
| `data/<ns>/docs/<source-local>.ndjson` | one file per source: its `source` row plus every fact from it |
| `data/telegram/YYYY-MM.ndjson`, `directory.ndjson` | Telegram rows (`rt = d1.<table>`, the bot's D1 shape) written by the daily batch (ADR 005); the build maps messages → `source`, readings and symptoms → `fact` observation, falls → `fact` event (ids `<ns>:src:<date>-tg.<id>`) |
| `data/meta/id-map-007.ndjson` | old (ADR 004) id → new id, plus the dropped confidence; not read by the build |
| `data/telegram/raw/*.jsonl`, `data/queue/needs_deep.jsonl` | raw Telegram updates and the deep-read queue (`.jsonl`, not read) |

Each line is one JSON object; `"rt"` names the table (`person`, `ref`, `source`, `fact`), the other keys are its columns.

## What the build checks
JSON syntax; unknown `rt` or keys; the id regex; that the id class matches the row (`src` → source, `fact` → fact,
`ref:<kind>` → ref of that kind); that ns matches the id and the `data/<ns>/` directory; that a document file's source id
is `<ns>:src:<file stem>`; unique ids; the required envelope fields; `at` is ISO-8601 with `+05:30` (IST, fixed in the build today) and agrees with
`at_precision`; `data` against its JSON Schema; every reference (source_id, context_id, supersedes, duplicate_of, and the
code/drug/party refs inside `data`); a superseded row is marked `superseded`; values inside the code's plausible range;
quote ≤200 chars; an `external` source has a note. Warnings: a unit differing from the code's canonical unit, a source
path not found (unless `external`), a fact citing another source.

## Example queries
```sh
sqlite3 -header -column <records-dir>/data/kb.sqlite "<query>"
```
```sql
-- Trend, with citations
SELECT at, value_num, unit, flag, ref_text, verification, source_id, page
FROM v_trend WHERE ns = 'alice' AND code = 'ref:code:potassium';

-- Latest value of every code
SELECT code, at, value_num, unit, flag FROM v_latest WHERE ns = 'alice';

-- Latest value before a date
SELECT * FROM v_trend WHERE ns = 'alice' AND code = 'ref:code:creatinine'
  AND at < '2026-06-01' ORDER BY at DESC LIMIT 1;

-- Two sources disagree: same code (alias-resolved), day, body_site and method/view (or one unstated), not two
-- different clock times. Pairs inside one source and facts tagged internal-contradiction / text-table-mismatch are out.
SELECT * FROM v_conflicts;

-- A document that contradicts itself (tagged at extraction)
SELECT day, what, value, tag, source_id, page, quote FROM v_internal_contradictions;

-- Merged refs: old id -> current id
SELECT * FROM v_ref_current WHERE id != current_id;

-- What the user must check (medicines, uncertain reads, alert inputs)
SELECT reason, kind, id, what, uncertain_ref FROM v_needs_human;

-- Timeline (events, medication statements, flagged or alert-input observations)
SELECT at, kind, what, label, id FROM v_timeline WHERE ns = 'alice';

-- Current medicines: latest statement per drug (status = prescribed/dispensed/taking/stopped)
SELECT drug, generic, brand, med_status, schedule_raw, at, verification FROM v_meds_current WHERE ns = 'alice';

-- Abnormal printed flags, with the verbatim quote
SELECT at, code, value_num, flag, quote, source_id, page FROM v_trend WHERE flag IN ('H','L') ORDER BY at;

-- Everything from one visit
SELECT kind, id, json_extract(data, '$.code') AS code FROM fact
WHERE context_id = 'alice:fact:2026-01-20-opd-dr-example';

-- Drug name lookup
SELECT id, name, json_extract(data, '$.generic') AS generic, json_extract(data, '$.certainty') AS certainty
FROM ref WHERE kind = 'drug' AND (name LIKE 'Exampl%' OR json_extract(data, '$.brand_variants') LIKE '%Samplex%');

-- Resolve an old (ADR 004) id cited in a doc:  grep '"old": "obs:2026-01-15-' <records-dir>/data/meta/id-map-007.ndjson
```
Always filter facts on `status = 'active'` (the views already do).
