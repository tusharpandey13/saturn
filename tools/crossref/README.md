# tools/crossref: continuous cross-referencing, iteration 1

Design: [continuous-crossref](../../docs/design/continuous-crossref.md) · Decision: [ADR 012](../../docs/decisions/012-continuous-crossref.md).
Deterministic checks over the KB (no LLM, no network), a claims register, and quiet, capped output for the admin.
Record and flag only: every flag statement is a fixed template filled from facts, with the fact ids it rests on.

```sh
python3 -I tools/kb/build --records <records-dir>
python3 -I tools/crossref/crossref --records <records-dir> [--digest FILE] [--today YYYY-MM-DD] [--dry-run --print-digest]
python3 -I tools/crossref/crossref --records <records-dir> feedback <flag-or-claim-id> <action> [--days N] [--question ID] [--answer ID] [--reason TEXT]
python3 -I tools/crossref/test_crossref.py      # synthetic fixtures only
```
The batch runs it after `build` and `gen-views` and appends its section to the admin digest (ADR 011: admin DM only).
Stdout carries counts only.

## Checks (rules as data, operators as code)
`crossref/checks.ndjson` in the records repo holds the check definitions; the first run seeds it from
[default-checks.ndjson](default-checks.ndjson). To change a check, append a row with the same id and a higher
`version`; the last row per id wins. `status`: `active` | `disabled` | `retired`. `sources` states the basis; a
`delta_vs_prior` threshold needs `basis` (a citation) and an active `stale` check needs `max_days`.

| Check | Operator | Default | Fires on | Severity |
|---|---|---|---|---|
| `range-vs-printed` | `range_vs_printed` | active | a printed or computed H/L flag (restated); a computed position that differs from the printed flag (banded ranges are never resolved: "needs a human") | routine; data-quality |
| `delta-vs-prior` | `delta_vs_prior` | active, no thresholds | the latest value vs the previous earlier-day value of the same code and body site (same method, or one unstated): states the change; over a cited threshold | routine; next-visit |
| `med-list-conflict` | `med_list_conflict` | active | `stopped` then `taking`/`dispensed` in a later source with no prescription between; two current lines with one generic; prescribed-only older than `prescribed_only_days` (off while null). Lines outside the latest complete-list snapshot are skipped | next-visit; data-quality |
| `passthrough-*` | `passthrough` | active | each `v_conflicts` pair, each `v_internal_contradictions` row, one flag per person and `v_needs_human` reason | data-quality |
| `stale` | `stale` | **disabled** | the latest value of a key series (`data/meta/gen-views.json`, or `params.codes`) is older than `max_days` | routine |
| `claim-differs` | `claim_differs` | active | a claim whose key appears in a later source with an incompatible `status_as_documented`; phrased as a question for the earlier claim's author | next-visit |

Facts with an open hard read (`uncertain_ref`) or tagged `low-confidence` never carry a flag alone; they stay in the
needs-human queue. Red-flag thresholds (`config/thresholds.yaml`) are not routed here and are never suppressed.

## Flags, dedup and the digest
- A flag's subject key is check + major version + ns + variant + subject; its dedup key adds a hash of the input fact
  ids. A changed input set updates the open flag (same id, `changed_at` moves, it is re-notified); inputs that no
  longer fire close it; a closed flag that fires again reopens.
- The digest lists new or changed `next-visit` flags only, at most `daily_cap` per person per day (default 3); the
  rest wait (oldest first). `routine` and `data-quality` appear only in the weekly roll-up (`rollup_weekday`, ISO,
  default 1 = Monday), with open counts per severity and per-check precision. Settings: `crossref/config.json`.
- The first run is a baseline: its flags are recorded and shown on the pages, not listed in the digest.

## Claims register
Every active `condition` fact and every event tagged `family-reported` / `patient-reported` / `user-report`
(life-context events excluded) is a claim `<ns>:claim:<fact-local>`, with who asserted it, the author (source
practitioner or organisation), `same-source` links (same source or visit), and a state that describes the records:
`as-recorded`, `restated` (the same key in a later source with a compatible status), `differs-in-later-source`;
owner states by feedback: `question-open`, `clinician-answered`, `retired`. Never a verdict on the claim.

## Feedback
`crossref/feedback.ndjson` (append-only, the latest row per target wins), written by the `feedback` command. Flag
actions: `useful`, `noise`, `snooze --days N`, `promote --question <ns>:q:NNNN`, `resolved`; claim actions:
`question --question`, `answered --answer <ns>:ans:NNNN`, `retired`. Feedback given before a flag changed does not
hide the changed flag. `useful` + `promote` vs `noise` give each check's precision.

## Files (records repo; all PHI; outside `data/` so the KB build never reads them)
| Path | Holds |
|---|---|
| `crossref/checks.ndjson`, `crossref/config.json` | check definitions; settings (optional) |
| `crossref/feedback.ndjson` | owner feedback |
| `crossref/<ns>/flags.ndjson`, `crossref/<ns>/claims.ndjson` | derived state, rewritten each run (git is the history) |
| `crossref/runs.ndjson` | run log: KB fingerprint, ids-free counts; appended only when something changed |
| `docs/health/<ns>/flags.md`, `claims.md` | whole-file generated pages (rewritten only when their content changes) |

Not in iteration 1 (design section 10): `interval_since`, `suggested_not_recorded`, label watcher, `cited` claim links,
`linked-data-changed`, the `flag`/`claim` id classes inside the KB build, feedback by digest reply, L2 evidence runs.
