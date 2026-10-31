# tools/inference: agent-inferred records (inferences)

Method: [diagnostic loop](../../docs/methods/diagnostic-loop.md) (step 8 writes them) · Decision:
[ADR 013](../../docs/decisions/013-diagnostic-loop.md) (proposed). Stdlib Python, no LLM, no network.

An **inference** is one fact-like statement produced by analysis, with a probability, the KB ids it rests on, verified
literature and what would change it. It is **agent-inferred**, never a KB fact: it lives outside `data/` so the KB
build never reads it, and clinical views never mix it with facts. Only a records repo whose `AGENTS.md` allows
labelled interpretation writes inferences. Medicine start, stop or dose changes are never an inference: they are
rejected by the word list, and become questions for the named doctor.

```sh
python3 -I tools/kb/build --records <records-dir>                        # add/supersede check KB ids against kb.sqlite
python3 -I tools/inference/inference --records <records-dir> add <ns> FILE|-          # JSON object or NDJSON rows
python3 -I tools/inference/inference --records <records-dir> supersede <inf-id> FILE|- # changed fields only
python3 -I tools/inference/inference --records <records-dir> retire <inf-id> --reason TEXT
python3 -I tools/inference/inference --records <records-dir> review <inf-id> accepted|disputed|none [--note TEXT]
python3 -I tools/inference/inference --records <records-dir> list <ns> [--active] [--json]
python3 -I tools/inference/inference --records <records-dir> diff <ns> --run <run-note-path>    # belief diff (markdown)
python3 -I tools/inference/inference --records <records-dir> gen [--check]                     # docs/health/<ns>/status.md
python3 -I tools/inference/test_inference.py                                                   # synthetic fixtures only
```
Every write validates the whole store first and fails loudly (exit 1, the reason on stderr). `add` prints the new ids.
The batch runs `gen` after `build` and `gen-views` (page generation only; no AI in the batch).

## Files (records repo; all PHI)
| Path | Holds |
|---|---|
| `inferences/<ns>/inferences.ndjson` | append-only row snapshots; the file existing turns the Status page on for `<ns>` |
| `docs/health/<ns>/status.md` | whole-file generated page (rewritten only when its content changes) |

## Row (one JSON object per line; `schema: "inference/1"`)
**Append-only; the last row per id wins.** Each line is a full snapshot of one inference at revision `rev`. A change
appends a new snapshot (`rev` + 1); nothing is edited in place. Readers: read every line, keep the highest `rev` per
`id`, then filter `status`.

| Field | Type | Rule |
|---|---|---|
| `schema` | `"inference/1"` | constant |
| `id` | `<ns>:inf:NNNN` | next free number per ns; stable; never reused |
| `rev` | int ≥ 1 | 1 on add; +1 per later snapshot of the same id |
| `problem` | `<ns>:dx:NNNN` or null | the diagnostic-loop problem it belongs to |
| `problem_title` | string or null | required with `problem`: the problem's one-line name, plain words |
| `hypothesis` | `<ns>:dx:NNNN.hK` or null | the loop hypothesis, when `kind` is `hypothesis` |
| `kind` | `hypothesis` \| `interpretation` \| `trend` \| `risk` \| `status-summary` | |
| `statement` | string | one plain-language sentence, ≤ 300 characters, no line breaks; passes the word list (no verdicts, no reassurance, no medicine instructions) |
| `p` | number 0–1 | point estimate that the statement is true (for a `hypothesis`, its probability in the problem's differential) |
| `bucket` | `>50%` \| `20-50%` \| `5-20%` \| `<5%` | must match `p` (`>50%`: p > 0.5; `20-50%`: 0.2 ≤ p ≤ 0.5; `5-20%`: 0.05 ≤ p < 0.2; `<5%`: p < 0.05) |
| `reason` | string | one line: why this probability |
| `stakes` | `can't-miss` \| `quality-of-life` \| `housekeeping` | page order; a `can't-miss` item stays visible at any `p` |
| `evidence_for`, `evidence_against` | list of evidence refs | together at least one. A ref is a KB id that exists in `kb.sqlite` (`fact`, `source` or `ref`), or a records-relative `sources/…` path that exists (`#p3` page suffix allowed) where no KB row exists yet |
| `citations` | list of `{ref, supports, verified, checked_at}` | `ref`: `doi:10.…` \| `pmid:NNN` \| `arxiv:NNNN.NNNNN` \| `url:https://…`; `verified`: `V` (checked against the abstract or official text) or `P` (partly); unverified citations are dropped, never stored; `checked_at`: `YYYY-MM-DD` |
| `would_change` | list of strings (≥ 1) | the finding, test, observation or answer that would move `p`, and which way |
| `produced_by` | `{model, run}` | `run` = the records-relative run note path (`docs/log/analysis/….md`) |
| `produced_at` | ISO datetime with offset | when the analysis produced it |
| `status` | `active` \| `superseded` \| `retired` | |
| `supersedes` | id or null | on the replacing row: the id it replaces |
| `superseded_by` | id or null | on the old row's final snapshot |
| `status_reason` | string or null | required for `retired` |
| `review` | `none` \| `accepted` \| `disputed` | the owner's review; `none` on add |
| `review_note` | string or null | |
| `recorded_at` | ISO datetime with offset | when this snapshot line was written (set by the tool) |
| `label` | `"agent-inferred"` | constant; every display shows it with "Not a diagnosis. Doctors decide." |

Example (synthetic):
```json
{"schema":"inference/1","id":"alice:inf:0001","rev":1,"problem":"alice:dx:0001","problem_title":"Episodes of left arm tingling","hypothesis":"alice:dx:0001.h2","kind":"hypothesis","statement":"The tingling episodes may come from a nerve in the neck rather than the heart.","p":0.35,"bucket":"20-50%","reason":"Episodes follow neck movement and are not exertional; no ECG during an episode yet.","stakes":"can't-miss","evidence_for":["alice:fact:2026-05-01-chat.episode-1"],"evidence_against":[],"citations":[{"ref":"doi:10.1000/example","supports":"typical picture of cervical radiculopathy","verified":"V","checked_at":"2026-10-31"}],"would_change":["An ECG taken during an episode that is normal lowers a heart cause; arm weakness raises a nerve cause."],"produced_by":{"model":"claude-opus-5-5","run":"docs/log/analysis/2026-10-31-alice-dx-loop-01.md"},"produced_at":"2026-10-31T12:00:00+05:30","status":"active","supersedes":null,"superseded_by":null,"status_reason":null,"review":"none","review_note":null,"recorded_at":"2026-10-31T12:05:00+05:30","label":"agent-inferred"}
```

## Commands
- **`add <ns> FILE|-`**: rows without `schema`, `id`, `rev`, `status`, `supersedes`, `superseded_by`, `status_reason`,
  `review`, `review_note`, `recorded_at`, `label` (the tool sets them). All rows are validated before any is written.
- **`supersede <id> FILE|-`**: one JSON object with the changed fields (usually `p`, `bucket`, `reason`, evidence,
  `produced_by`, `produced_at`). It appends a new id (`supersedes: <id>`, `review: none`) carrying the other fields
  over, then a final snapshot of the old id (`status: superseded`, `superseded_by`). Use it when the belief changed;
  keep the id when nothing changed (no row needed).
- **`retire <id> --reason`**: appends a snapshot with `status: retired` (the problem was explained by a doctor, the
  hypothesis was excluded by a cited test, or the statement no longer applies).
- **`review <id> accepted|disputed|none [--note]`**: the owner's mark; appends a snapshot.
- **`list <ns> [--active] [--json]`**: current snapshot per id.
- **`diff <ns> --run <path>`**: a belief diff for the run's rows against what they superseded: new, moved
  (old p → new p, bucket change), retired by the run, and active rows the run did not touch.
- **`gen [--check]`**: writes `docs/health/<ns>/status.md` for every ns with `inferences/<ns>/inferences.ndjson`:
  active inferences grouped by problem, problems and rows ordered by stakes (`can't-miss` first) then `p`; each row
  with its bucket, reason, evidence ids, citations, what would change it, the review mark and the label.
  `--check` exits 1 when a page is stale.
