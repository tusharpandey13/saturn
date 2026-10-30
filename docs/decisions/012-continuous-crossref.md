# 012: Continuous cross-referencing (checks, flags, claims register)

Date: 2026-10-30 · Status: **PROPOSED** · Related: 005 (batch), 007 (data model), 011 (admin-only output), the
[research cross-reference method](../methods/research-crossref.md) · Design:
[design/continuous-crossref.md](../design/continuous-crossref.md)

## Context
The owner wants records checked continuously against new data and new evidence, including claims written by doctors
and claims reported by the family. Today the research cross-reference is a manual, whole-person run, and the batch
checks only the red-flag thresholds. Rule 2 of [AGENTS.md](../../AGENTS.md) (record and flag only) still holds.

## Decision (proposed)
1. **Three layers, run in cost order.** L1 runs deterministic checks in the daily batch with no LLM. L2 is the
   existing research cross-reference, triggered only for topics whose inputs changed, licence-aware and verifier-gated,
   in the PHI enclave. L3 is a claims register that tracks how each recorded claim relates to later data and evidence.
2. **Rules as data, operators as code.** A small fixed set of tested operators (`range_vs_printed`, `delta_vs_prior`,
   `interval_since`, `med_list_conflict`, `stale`, `suggested_not_recorded`, `passthrough`). Check definitions are
   versioned `ref:check` rows. Each one cites a quotable source, or is owner-written, and goes `active` only after the
   owner approves it. A no-AI body is never the basis of a check.
3. **Flags and claims are derived rows, not facts.** They get new id classes (`<ns>:flag:…`, `<ns>:claim:…`) and files
   under `data/<ns>/crossref/`, with ADR 007 supersede semantics. Clinical views never read them. FHIR reference
   shapes: `DetectedIssue` (flag), `Condition` as documented plus `ArtifactAssessment` (claim), `Provenance` (run),
   `PlanDefinition`/`Library` (check).
4. **Output is templated, quiet and admin-only (ADR 011).** Severity tiers, dedup keys, a per-person daily budget, a
   weekly roll-up, refractory periods, and owner feedback (useful, noise, snooze, promote, resolved) that drives a
   per-check precision metric. A flag reaches a doctor only after the owner promotes it to a question. Red-flag
   thresholds are unchanged and never suppressed.
5. **Claim states describe records, never truth:** `as-recorded`, `restated`, `differs-in-later-source`,
   `linked-data-changed`, `evidence-changed`, `question-open`, `clinician-answered`, `retired`.
6. **The PHI user stays egress-locked.** Evidence fetching is split: a public job runs lint-checked generic queries and
   watches label and guideline versions by public id.

## Consequences
- Iteration 1 (deterministic checks, claims skeleton, digest section) needs no LLM spend and about 3 to 4 agent-days.
- The id regex, the build and `gen-views` gain the new classes and two generated blocks (`gen:flags`, `gen:claims`).
- L2 depends on agent-server `git_pr` delivery (phase 2) and the split fetch.
- The "diagnose" boundary is unchanged. The design lists what relaxing it would involve, as a decision for the owner,
  and recommends keeping rule 2.

## Options considered
| | Rules in code | **Rules as data + fixed operators** | General rules engine (CQL / PlanDefinition runtime) |
|---|---|---|---|
| Review | code review per rule | data row with citation + owner approval | expressions need a CQL reader |
| Complexity | low at first, grows per rule | low and bounded | high (engine, terminology services) |
| Portability | none | maps to PlanDefinition/Library later | native |
