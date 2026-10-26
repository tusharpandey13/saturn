# KB migration plan (generic): moving a records repo onto the ADR 007 model

Date: 2026-10-24; updated 2026-10-26 for ADR 007. Product version: every file name, namespace and value below is **synthetic** (the example family `alice`, `bob`, `family`). The plan for a real records repo lives in that records repo.

**Use this when** a records repo holds facts only in prose (profiles, batch notes, OCR sidecars, chat exports) and you want them in the structured KB ([ADR 004](../decisions/004-clinical-data-model.md), [ADR 007](../decisions/007-simplified-clinical-data-model.md)). Do the ADR 007 re-key first: it is cheap while the KB holds a few documents and expensive after a migration wave (a one-off migration script, retired once applied; keep its id map in the records repo, e.g. `<records-dir>/data/meta/id-map-007.ndjson`).

Record verification honestly: `verification` says how well the **reading** was checked (a `prescribed` line read against a strip photo can be `agent` or `human`), while `data.status` says what the statement is (`prescribed` ≠ `taking`; use `taking` only when someone reports taking it). An unresolved reading keeps its hard-read id in `uncertain_ref`.

Prerequisites: the product `schema/schema.sql` and `schema/*.schema.json`, the records repo's `data/ref/*`, `tools/kb/build`, and one **pilot** document migrated by hand and reviewed (e.g. `<records-dir>/data/alice/docs/2026-01-15-example-lab-biochemistry-lft-rft.ndjson`; every task copies its shape). Record only; no diagnosis.

## Tasks
Split the work by **input batch**, one agent per task. Wave 1 runs in parallel; wave 2 starts after wave 1 is merged and `tools/kb/build` passes.

| ID | Scope (inputs) | Output | Notes |
|---|---|---|---|
| M1…Mk | One scan batch each: a handful of PDFs (e.g. `2026-01-15-example-lab-cbc.pdf`, `2026-02-10-example-hospital-consult-rx.pdf`) + their `.ocr.md` sidecars + the batch note + the batch's hard-read queue | one file per source in `data/<ns>/docs/` | typed lab reports are easy; imaging findings → fact `observation` (data.category `imaging`, `value_text`); prescriptions → `medication` |
| | Handwritten batches (consult notes, prescription pads) | one file per source | many hard reads; every medication fact not human-verified goes to the human tier |
| | A second person's batch | files in `data/bob/docs/` | check the batch note for pages that belong to someone else |
| | A large discharge pack (one PDF, tens of pages) | one file | biggest single source; in-patient medicines → medication facts with data.status `dispensed`; the admission → one event fact (data.type `admission`) that the other facts point at with `context_id` |
| | Chat images (e.g. `sources/alice/media/<channel>/*.jpg`) + their batch notes | one file per image (`YYYY-MM-DD-<channel>-img-<n>`) | many are copies of scans already migrated: `rank: copy`, `duplicate_of`, and only facts the original lacks |
| | Older PDFs without a sidecar (odd names such as `LabReport1.pdf`, `scan 0001.pdf`) | OCR sidecars first (`tools/ocr/ocr.sh`), then one file each | identify each against the profile's source keys before extracting; rename to `YYYY-MM-DD-<facility>-<what>` |
| | Chat statements (exported chat text) | `data/<ns>/docs/*` | `source.kind = 'chat'`, `rank: original`, tag `low-confidence` unless a document backs them |
| W2-a | AI summaries (for example a notes-app export) | `data/<ns>/docs/summary-*.ndjson` | **gap-fill only**: load a fact only if `v_trend`/tables have no primary source for it, after checking the summary states it plainly; `rank: ai_summary` |
| W2-b | Telegram mapping in `tools/kb/build` (done in the product): `rt = d1.<table>` rows from `data/telegram/YYYY-MM.ndjson`, `readings`/`symptoms` → `observation`, messages → `source` | build code + synthetic fixture | |
| W2-c | Reconcile + views: diff `v_trend`/medications against the profile tables and list every mismatch in a dated log note; render the views with `tools/kb/gen-views` | generated pages | the owner then reviews `v_needs_human` |

Out of scope: non-clinical folders (insurance, identity, unknown).

## Shared-file rules (parallel safety)
- An agent writes only the files of its task. Shared refs are append-only via **per-task files**: new parties in `data/ref/party-<ID>.ndjson`, new drugs in `data/ref/drug-<ID>.ndjson`, new codes in `data/ref/code-<ID>.ndjson` (rows `rt: ref`, ids `ref:<kind>:<local>`). First `grep` the existing refs for the same entity; never add a second id for one.
- Duplicate ids across tasks surface as build errors after the merge; the reconcile task folds the per-task ref files into the main ones.
- Commit only your files: `git add data/<ns>/docs/<your files> data/ref/*-<ID>.ndjson`, then `git pull --rebase origin main`, run the build, `git push`. Retry the pull on a push race.

## Id conventions (ADR 007)
Regex (assembled at runtime from `records.yaml` `namespaces:`): `^(?:(<ns1>|<ns2>|…|family):(src|fact)|ref:(drug|code|party)):([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$`. Lowercase, date-first, dots for sub-parts, **no page numbers** (page is a field).
- source: `<ns>:src:<file stem>`; the file is `data/<ns>/docs/<file stem>.ndjson` (stem e.g. `2026-01-15-example-lab-cbc`, `2026-01-20-tg-img-0006`).
- fact from that source: `<ns>:fact:<stem>.<key>`, where key = the code local for observations (`.potassium`), the drug local for medications (`.exampledrug`), a short slug for conditions and events (`.example-condition`). Same key again in one source: `.2`, `.3`.
- visit / admission / procedure (an event other facts point at): `<ns>:fact:<YYYY-MM-DD>-<type>-<party-local>`, e.g. `alice:fact:2026-02-10-opd-example-hospital`. It lives in one document file; others reference it with `context_id`. Before creating one, `grep -r '"<ns>:fact:<date>-' data/`.
- refs: `ref:drug:<brand-slug>`, `ref:code:<code>` (hyphens, e.g. `ref:code:bilirubin-total`), `ref:party:<org-slug>-<city>` (e.g. `ref:party:example-hospital`) or `ref:party:dr-<first>-<last>` (e.g. `ref:party:dr-example`).
- Old (ADR 004) ids still cited in docs: look them up in `data/meta/id-map-007.ndjson`.

## Per-agent brief template
Copy, fill the `<…>` fields, send one per task.

```text
Repo <records-dir> (private medical records). Task <ID>: migrate <scope> into the clinical KB.
Record only: no diagnosis, no interpretation, no dose advice.

Read first (product repo): docs/decisions/007-simplified-clinical-data-model.md (model, ids, envelope),
schema/schema.sql and schema/*.schema.json (authoritative fields and enums), tools/kb/README.md,
docs/research/kb-migration-plan.md (id conventions, shared-file rules); and the pilot
<records-dir>/data/<ns>/docs/<pilot-stem>.ndjson (copy its shape exactly).
Inputs: <PDFs / images>, their .ocr.md sidecars, <batch note(s)>, <hard-read queue(s)>, and the matching
rows of the person's profile notes in the records repo.

For each source document write data/<ns>/docs/<source-local>.ndjson (ns = one of records.yaml namespaces, or family) with:
1. one `source` row (rt "source", id "<ns>:src:<source-local>"): path, sha256 from `shasum -a 256`, kind, issued_at,
   received_at/sender when known, text_path (OCR sidecar or transcript), pages, rank original|copy|ai_summary,
   duplicate_of, org_id/practitioner_id (ref:party:…), context_id, identifiers such as a hospital or visit number;
2. the visit/admission as an `event` fact (data.type opd|admission|test_visit|…) unless one already exists (grep first);
3. EVERY fact on the page as rt "fact" with kind observation|medication|condition|event and kind-specific fields in
   `data` (see schema/<kind>.schema.json):
   observation: data.code = ref:code:<code> from data/ref/code.ndjson, value_num/value_text, unit = the code's
   canonical unit, unit_raw and value_raw as printed (convert only when exact, say so in note), ref range, flag;
   medication: data.status prescribed|dispensed|taking|stopped (what the document says, not whether it was read
   well), brand as written, drug_id ref:drug:<id>, strength, schedule_raw like 1-0-1, dose_m/n/e;
   condition: text_as_written (icd10 only if printed); event: type, label.
Envelope on every fact: id "<ns>:fact:<source-local>.<key>" (no page numbers; .2/.3 for repeats), ns, kind,
at (ISO-8601 with the local offset when it has a time) + at_precision minute|day|month|year, source_id, page,
locator (section > line label), quote (verbatim, <=200 chars), context_id (the visit event), verification ("agent"
only if you viewed the rendered page image yourself or the batch note records a page-image check; "human" only if
a person or a photo of the printed strip/box confirmed the reading; otherwise "unverified"), verified_by,
verified_at, uncertain_ref (the hard-read id while the reading is still open, else null), status "active",
supersedes null, recorded_by "<ID>/<model>/<date>", created_at, tags [] (add "low-confidence" when you are unsure
but there is no hard-read id). No numeric confidence.
Flags: data.flag H/L/N only as printed; flag_basis "printed" (letters), "bold" (bold-only prints), or
"computed" (you compared with the printed range; say so in note).
Duplicates: a value printed twice in one document is stored once (note the second page). A document that
copies another: rank "copy", duplicate_of, and only facts the original does not have.
Never guess identities or illegible text: keep the reading as written, set uncertain_ref, cite the hard read.
New parties/drugs/codes go to data/ref/{party,drug,code}-<ID>.ndjson (rt "ref", id "ref:<kind>:<local>",
name, data per schema/<kind>.schema.json, recorded_by, created_at, status, tags) only after grepping
existing refs.

Check: `python3 -I tools/kb/build --records <records-dir>` must print "ok". Then cross-check every value against
the batch note table and the profile rows; list mismatches (do not silently resolve them).
Commit only your files with message "kb: migrate <ID> (<scope>)"; `git pull --rebase origin main`, re-run the
build, push.
Report (<200 words): files written, fact counts per kind, rows in v_needs_human from your sources,
mismatches vs batch notes/profile, new ref rows, open questions.
```

## Size and lessons
- Order of magnitude: about one agent-run per batch of ~5 sources; the discharge pack and chat-image tasks may need two. Human time afterwards: `SELECT * FROM v_needs_human` (medications not yet human-verified, uncertain or low-confidence values, and alert-input labs) and `SELECT * FROM v_meds_current`.
- Re-key before the wave, not after: id changes are cheap only while few rows exist.
- Settle medicine names (hard reads, strip and box photos) before migrating prescriptions; otherwise most medication facts land as `uncertain_ref`.
- Per-task ref files make parallel agents safe; one shared ref file causes merge conflicts and duplicate ids.
- Copies (chat photos of scans already migrated) are the main duplicate risk: `rank: copy` + `duplicate_of`, never a second fact.
- AI summaries are gap-fill only and never outrank a primary source.
