---
title: "Continuous cross-referencing of records against evidence (design)"
audience: engineer, maintainer
type: explanation
owner: maintainer
last_reviewed: 2026-10-30
review_every: 90d
status: proposed
sources: [docs/methods/research-crossref.md, docs/decisions/007-simplified-clinical-data-model.md, docs/decisions/010-life-context-signals.md, docs/decisions/011-group-input-only-admin-output.md, docs/decisions/012-continuous-crossref.md, agent-tasks/saturn.research_crossref.yaml, tools/research/verify_citations.py, schema/schema.sql]
generated: false
---

# Continuous cross-referencing (design, proposed)

**Facts as written; not advice; doctors decide.**

Decision record: [ADR 012](../decisions/012-continuous-crossref.md) (proposed). This page is the design; the ADR is the
short decision. Home-series baselines, change checks and the running profile extend this design in
[health-profile.md](health-profile.md).

## 1. Goal and boundary

The owner asked for "continual continuous diagnosis of facts and measurements against the medical data present",
including cross-checking what doctors wrote and what the family reported against newer data and newer evidence.

Saturn's first rule is **record and flag only** ([AGENTS.md](../../AGENTS.md), rule 2). This design keeps that rule.
The system **checks continuously and flags with citations**, and each concern it keeps becomes a **question for the
named doctor**. It never states a diagnosis, rules one in or out, predicts risk for the person, or suggests starting,
stopping or changing a medicine or dose. Section 11 sets out what would change if the owner ever relaxed the rule.
It is a decision for the owner, and nothing here designs or builds diagnosis.

In practice, "continuous cross-referencing" here means three things:

| The owner's ask | What the system does | What it never does |
|---|---|---|
| "check facts and measurements" | compares each new value with the range printed on its own report, with the person's earlier values, and with monitoring intervals that a drug label or guideline states; finds medicine-list conflicts and stale data | says what a value means for the person |
| "against medical data / new evidence" | reruns the existing [research cross-reference](../methods/research-crossref.md) on **what changed** only, licence-aware | quotes a no-AI body, cites from memory, or summarises evidence as advice |
| "cross-reference doctors' claims" | keeps a **claims register**: each doctor-written or family-reported claim, its evidence links, and a status that changes when new data or evidence touches it | gives a verdict on a claim ("wrong", "confirmed") |

**Why this narrow (asymmetric risk).** The research method's reasoning applies here too
([method](../methods/research-crossref.md) section 1). A missed flag costs little, because the doctor still owns the
care and the records are still there. A wrong or overconfident flag, read by a family member, can cost a great deal:
a medicine stopped, a doctor distrusted, a visit delayed. WHO [W1] and the FDA CDS guidance [W2] both name automation
bias as a key risk. A continuous system also adds a second risk that a one-off report does not have: **alert
fatigue**. When most alerts are noise, people learn to ignore all of them, the real ones included
[A1][A2][A3][A4]. Every choice below therefore trades recall for precision and favours a quiet output.

## 2. Terms

| Term | Meaning |
|---|---|
| **check** | a versioned rule, stored as data: inputs (KB views), one operator from a fixed set, parameters, a phrasing template, a severity, and the citations that justify it |
| **flag** | one output of a check for one person: a templated statement, the fact ids it rests on, its severity, a dedup key and a lifecycle state. FHIR shape: `DetectedIssue` [F4] |
| **claim** | an assertion recorded in a source, plus who made it: a doctor-written diagnosis or impression, a document's finding, or a family- or patient-reported statement. It is a register entry *about* a fact, not a new fact |
| **evidence link** | a typed link from a claim or flag to a KB fact, a research cross-reference item, or a "you read it" checklist row |
| **run** | one execution of one layer for one trigger, with inputs, outputs, cost and verifier result |

## 3. Triggers

| Trigger class | Examples | Detected by | Scope of the run |
|---|---|---|---|
| **Event-driven** (data changed) | new source or fact after a batch or an ingest PR; a fact superseded; a hard-read resolved; a medicine statement added or stopped; an answer from a doctor recorded | the KB build: the set of fact ids added or superseded since the last run's KB fingerprint (`run.inputs_hash`) | layer 1 on the affected namespace and codes; the claims touched by those facts; layer 2 only for topics whose inputs changed (method section 13 trigger table) |
| **Evidence-driven** (the world changed) | a DailyMed label revision for a current medicine (new SPL version for its set id); a new guideline edition or focused update; a `read_checklist[].recheck_after` date passing; a new item in the private or human-only library; an owner note in their own words about a guideline | a small public watcher that polls by **set id or URL only** (no PHI: section 8); the read checklist's dates; the library manifest | the items and claims that cite the changed source; new pointer rows for the owner |
| **Scheduled sweeps** | daily (with the batch): layer 1 on everything, cheap; weekly: stale-data and monitoring-interval sweep, digest roll-up; every 6 months: the full research cross-reference (method section 13) | timer | as named |
| **On request** | the owner asks "check X" | DM command or a task submission | the named focus |

Event-driven runs are debounced: a burst of facts from one document gives one run, not one per fact.

## 4. Pipeline

```
 KB build (facts, views)  --->  L0 snapshot + diff (what changed since the last run)
                                   |
                                   v
                          L1 deterministic checks (no LLM, every batch)
                                   |
                                   v
                          L3 claims register update (deterministic links; LLM-assisted only from iteration 4)
                                   |
             changed topics only   v
                          L2 evidence cross-reference (LLM, licence-aware, verifier-gated, budget-capped)
                                   |
                                   v
              flags -> dedup / suppress -> routing (digest, questions.md candidates, briefs) -> owner feedback
```

Layers run in cost order. Layer 1 is free and runs often. Layer 2 is the costly one, so it runs only on what changed
and only after layer 1 has said what that is.

### 4.0 L0: snapshot and diff

- Build the KB (`tools/kb/build`), record `data_as_of` and a fingerprint (the sha256 of the sorted active fact ids and
  their `created_at`).
- Diff against the last run's fingerprint and list the facts added, superseded and retracted.
- Only facts with `status = active` count. `uncertain_ref` and `low-confidence` facts never carry a flag alone
  (method section 2). They go to the needs-human queue instead.

### 4.1 L1: deterministic checks (rules as data)

Code supplies a **small fixed set of operators**, each tested on synthetic fixtures. Records data supplies the
**check definitions** that bind an operator to codes, drugs and parameters, each with its citations. Neither may grow
without the other: a new operator is a code change with tests, and a new check is a data row with a citation. This
keeps rules versioned and reviewable without a general rules engine (complexity is debt; CQL [F11] is the mapping
target if one is ever needed).

| Operator | Input views | Fires when | Severity default | Phrasing template (fixed; values filled from facts) |
|---|---|---|---|---|
| `range_vs_printed` | `v_trend` + `fact.data.ref_low/ref_high/ref_text/flag` | the value is outside the range printed **on the same report**; or the computed position disagrees with the printed flag | `routine`; a printed-flag disagreement is `data-quality` | "`<code>` `<value>` `<unit>` on `<date>` is outside the range printed on the same report (`<ref_text>`)." |
| `delta_vs_prior` | `v_trend` | the change from the previous comparable value (same code, same method/body site, alias-resolved) is larger than the check's threshold, given as a reference change value (RCV) from published biological variation [B1] or as a fixed delta that the check cites | `routine` | "`<code>` was `<v1>` on `<d1>` and `<v2>` on `<d2>`; the change exceeds the check's threshold (`<basis>`)." |
| `interval_since` | `v_meds_current`, `v_latest` | a current medicine (strip-seen or better, or `taking`) has a monitoring statement in its label or a cited guideline, and no result for the named code is recorded within the stated interval | `next-visit` | "No `<code>` result is recorded since `<date>`. The `<drug>` label (`<section>`, `<set id>` v`<n>`) states: '`<quote>`'." |
| `med_list_conflict` | `fact` (medication), `v_meds_current`, `med-list-complete` events | two active statements for one drug disagree on status (for example stopped in one source and taking in a later one, with no stop or restart between); two current lines share a generic; a `prescribed`-only line is older than the review window | `next-visit` / `data-quality` | "`<drug>`: `<status1>` (`<src1>`, `<d1>`) and `<status2>` (`<src2>`, `<d2>`)." |
| `stale` | `v_latest`, `v_meds_current` | a key series (per person, from `gen-views.json`) has no value newer than N days; the medicine list has not been confirmed within the records' review window | `routine` | "Latest `<code>` on file: `<date>`." |
| `suggested_not_recorded` | events of type order/suggestion (section 6.4) | a document suggests a test or review and no matching result or visit is recorded after it | `next-visit` | "`<source>` (`<date>`) wrote: '`<quote>`'. No matching result is recorded since." |
| `passthrough` | `v_conflicts`, `v_internal_contradictions`, `v_needs_human` | a row is new since the last run | `data-quality` | "Two sources disagree on `<what>` on `<day>`: `<a>` vs `<b>`." |
| `threshold` (exists) | `config/thresholds.yaml` | the red-flag rules already in the batch | red flag | unchanged (digest annotations, ADR 005/011) |

Rules for every operator:
- **Templates only.** A layer-1 flag statement is a filled template, never free text. The verifier checks it against
  the check's template (as it does for pointer items, method 5a).
- **The printed range wins.** `range_vs_printed` uses the report's own range and never a population default. When
  the printed range has age or sex bands as text, the check does not pick a band; it emits a `data-quality` flag
  "range is banded; needs a human".
- **Monitoring statements are quoted from public sources only.** `interval_since` checks are written from US/EU
  labels (public domain or EMA-credit, method section 4) or quotable guidelines. A no-AI body (AUA, EAU, NICE, ESC,
  ADA) can never be the basis of a check. The owner may add a check from their own reading of such a body, written in
  their own words and tagged `owner-reported`, with the guideline linked (pointer form), never quoted.
- **Brand vs generic.** Checks bind to generics through `ref:drug`; a brand whose generic certainty is low gets no
  `interval_since` check (it becomes a `data-quality` flag instead).
- **Red flags stay where they are.** The existing threshold annotations (ADR 005/011) are not routed through this
  system and are never suppressed by it.

### 4.2 L2: evidence cross-reference (only on what changed)

This layer reuses the [research cross-reference method](../methods/research-crossref.md) unchanged: licence groups,
public and private mode (4a), link-only pointers and the read checklist (5a/5b), grading as printed (GRADE [G1],
OCEBM), applicability, and the verifier. The changes are in scope and scheduling only:

- **Delta scope.** The task gets `focus` from the L0 diff and L1 flags (topics whose inputs changed) and `previous`
  from the last run. The method's revisit diff (step 10) then marks each item new, unchanged, changed or retired. A
  label revision for one medicine gives a label pass for that medicine alone.
- **Living-evidence pattern.** This is the "living review" idea [E1] at family scale: keep the last answer, watch its
  sources, and rerun only the part a new source affects. It is not a systematic review (method section 12).
- **Licence routing.**

  | Source group | What L2 may do | Output |
  |---|---|---|
  | public, quotable (labels, CC-licensed papers, KDIGO 2024+, USPSTF, WHO) | read, quote briefly | public crossref page |
  | group A, copyright-only (listed in the records repo's private source list) | read and quote briefly in private mode, from `.cache/` | `research/private/` only; never a brief |
  | group B, no-AI (AUA, EAU, NICE, ESC, ADA) and publishers whose terms ban AI | never fetched, read or quoted; pointer item + `read_checklist` | "you read it" rows; owner notes come back as `owner-reported` |
  | human-only library (outside every repo) | never opened by any agent | not an input |
- **Verifier gate.** No L2 output reaches a person until `verify_citations.py` reports 0 errors. An unresolvable
  citation drops the item (method section 12).

### 4.3 L3: claims register

Every doctor-written or document-stated condition, impression or finding, and every family- or patient-reported
claim, gets a claim entry. Iteration 1 builds it from facts of kind `condition` and from events tagged
`family-reported` / `patient-reported`. The register tracks how a claim relates to later data and evidence. It never
judges whether the claim is true.

| Claim state | Set by | Meaning (all "as recorded") |
|---|---|---|
| `as-recorded` | default | the claim exists in a source; nothing newer touches it |
| `restated` | deterministic | a later, independent source states the same claim (same label or code, compatible `status_as_documented`) |
| `differs-in-later-source` | deterministic | a later source states it differently (a different label for the same finding, a query that became confirmed or the reverse, or "normal" where an earlier one was not). Both are shown (`conflict:` rule); nothing is chosen |
| `linked-data-changed` | deterministic, from a **claim link** | a measurement linked to the claim by a cited link (below) has a new value or crossed the range printed on its report since the claim was written |
| `evidence-changed` | L2 | an evidence item linked to the claim is new, changed or retired |
| `question-open` | owner | a question about the claim is open in `questions.md` |
| `clinician-answered` | owner, from an answer | the named doctor answered; the answer is linked (`ans` id) |
| `retired` | owner | the claim was superseded by the source itself, or recorded in error |

**Claim links** say which measurements bear on a claim. They are data, with a basis, and never inferred silently:
- `same-source`: facts from the same document or visit (`source_id`, `context_id`);
- `cited`: a link written into a check definition that cites a public label or quotable guideline naming that
  measurement for that condition (for example, a guideline that names a test used to follow a condition);
- `owner`: a link the owner adds by hand.

An LLM may **propose** links in iteration 4 (tagged `agent-inferred`, inactive until the owner accepts them).

Every state change other than `as-recorded` and `restated` produces at most one flag, and that flag is phrased as a
question for the doctor who wrote the claim (`care-team.md`). For example: "Dr `<role>`: the record has
'`<claim as written>`' (`<date>`, `<source>`); later `<code>` values are recorded (`<ids>`). Is this still current?"
The register's states describe **records**. "Supported" and "contradicted", the words the owner used, are kept out
of the output on purpose, because each one is a clinical judgment.

## 5. Outputs, routing and alert-fatigue design

### 5.1 Severity

| Severity | Meaning | FHIR `DetectedIssue.severity` [F4] / CDS Hooks indicator [F10] | Route |
|---|---|---|---|
| red flag | existing threshold rules only | high / critical | unchanged: digest annotation (and ops DM if configured); never batched, never suppressed |
| `next-visit` | a question worth taking to the named doctor at the next contact | moderate / warning | digest (new only), then "question candidates" for the owner to promote into `questions.md` |
| `routine` | worth knowing, not urgent | low / info | weekly roll-up line in the digest |
| `data-quality` | the records need a human (a conflict, banded range, unclear brand, stale list) | low / info | needs-human queue (`v_needs_human` and `data-quality.md`), not the clinical part of the digest |

### 5.2 Dedup and suppression

- **Dedup key** = `check_id + check_major_version + ns + subject (code, drug or claim id) + input fingerprint (sorted
  fact ids that decide the outcome)`. While a flag with the same key is open, nothing new is raised. A new fact that
  changes the fingerprint updates the open flag (as a superseding row) rather than adding a second one.
- **Refractory period** per check (for example 30 days for `stale`), so a snooze-free reminder cannot repeat daily.
- **Owner actions**, by reply to the digest DM or by a row in the records repo: `useful`, `noise`, `snooze <days>`,
  `promote` (opens a question with the next free id), `resolved` (with an answer or a reason). Every action is a
  superseding flag row, so the history is kept.
- **Budget.** At most N new `next-visit` flags per person per digest (default 3). The rest wait in order of severity
  and age. `routine` flags appear only in the weekly roll-up.
- **Self-tuning, owner-approved.** Each check's measured precision (section 9) is shown in the weekly roll-up. A check
  whose precision falls below a set floor after a minimum number of votes is **proposed** for retirement or retuning;
  the owner decides. Nothing is switched off silently, because a silently failing CDS rule is a known hazard [A5].
- These choices follow the CDS literature: interrupt only for high value, prefer non-interruptive display for the
  rest, tier by severity, and measure overrides [A1][A3][A4][A6].

### 5.3 Who sees what (ADR 011: admin-only output)

| Output | Admin (DM digest) | Records repo (readers with access) | Doctor (brief, by deliberate share) | Family group |
|---|---|---|---|---|
| red flags | yes (as today) | yes | via brief, if the admin includes it | never (input-only) |
| `next-visit` flags | yes, new only, capped | `docs/health/<ns>/flags.md` (generated view) | only when promoted to a question and the brief is regenerated | never |
| `routine`, `data-quality` | weekly roll-up line | `flags.md`, `data-quality.md` | no | never |
| claims register | weekly count of state changes | `docs/health/<ns>/claims.md` (generated view) | the claims with open questions, cited, in the brief's question section | never |
| L2 evidence pages | link in the digest | `research/` (public) or `research/private/` | public items only, as cited questions; never private items | never |

## 6. Data model additions (ADR 007-compatible)

### 6.1 Principle

Flags and claims are **derived outputs, not clinical statements**. They must never be confused with facts, because a
flag that looked like a fact would be an agent inference presented as a record. So they get their own id classes and
files, and the clinical views (`v_trend`, `v_timeline`, `v_meds_current` and the rest) never read them. Check
definitions are reference data, like codes and drugs, so they are refs.

| Concept | Id | File (records repo) | FHIR reference shape |
|---|---|---|---|
| check definition | `ref:check:<slug>` | `data/ref/check.ndjson` (product defaults ship as a synthetic example; each records repo activates its own) | `PlanDefinition` (ECA rule) + `Library` (logic) [F8][F9]; CQL [F11] as a later option |
| flag | `<ns>:flag:<YYYY-MM-DD>-<check-slug>-<hash8>` | `data/<ns>/crossref/flags.ndjson` | `DetectedIssue` (status, severity, code, `implicated` = fact refs, `evidence`, `detail`, `mitigation` = owner action) [F4] |
| claim | `<ns>:claim:<fact-local>` (one claim per asserting fact) | `data/<ns>/crossref/claims.ndjson` | the asserting fact maps to `Condition` / `Observation`, with `verificationStatus` copied **as documented** and never set by the system [F1][F2]; the register's state maps to `ArtifactAssessment` (an assessment *about* a record) [F7] |
| evidence link | embedded `links[]` in claims and flags: `{target, relation, basis, by, at}` | as above | `DetectedIssue.evidence`, `ArtifactAssessment.content`, `Evidence` for literature [F6] |
| run log | `run:<UTC timestamp>-<layer>` | `data/meta/runs/YYYY-MM.ndjson` (ids and counts only) | `Provenance` (agent = software and version, activity, entities used and generated) [F3] |

`ClinicalImpression` and `RiskAssessment` [F5] are clinician judgment and risk prediction. They are listed here **as
shapes the system never produces**. A doctor-written impression that arrives in a source is ingested as a fact and
then becomes a claim.

### 6.2 Row shapes (sketch)

```jsonc
// ref:check (versioned by supersede; status draft -> active -> retired)
{"rt":"ref","id":"ref:check:interval-since-example-drug-potassium","kind":"check","name":"…",
 "data":{"version":"1.0.0","operator":"interval_since","params":{"drug_generic":"example","code":"ref:code:potassium","max_days":90},
  "severity":"next-visit","template":"No {code} result is recorded since {date}. The {drug} label ({section}, {set_id} v{v}) states: '{quote}'.",
  "sources":[{"source_type":"label","set_id":"…","version":"…","section":"…","quote":"…","license":"public-domain","accessed":"2026-10-30"}],
  "approved_by":"owner","approved_at":"…"},
 "status":"active","supersedes":null,"recorded_by":"agent:…","created_at":"…"}

// flag (immutable; a state change is a new row that supersedes the old)
{"rt":"flag","id":"alice:flag:2026-10-30-interval-since-example-drug-potassium-1a2b3c4d","ns":"alice",
 "data":{"check":"ref:check:interval-since-example-drug-potassium","check_version":"1.0.0","severity":"next-visit",
  "statement":"…rendered template…","inputs":["alice:fact:…"],"dedup_key":"…","state":"open",
  "question_id":null,"run":"run:2026-10-30T15:00Z-l1","feedback":null},
 "status":"active","supersedes":null,"created_at":"…"}

// claim
{"rt":"claim","id":"alice:claim:2026-01-15-example-clinic-rx.example-condition","ns":"alice",
 "data":{"fact":"alice:fact:2026-01-15-example-clinic-rx.example-condition","asserted_by":"doctor-written",
  "author":"ref:party:dr-example","text_as_written":"…verbatim, <=200…","state":"as-recorded",
  "links":[{"target":"alice:fact:…","relation":"same-source","basis":"source_id","by":"build"}]},
 "status":"active","supersedes":null,"created_at":"…"}
```

### 6.3 How it fits ADR 007

- **Id regex.** Add the classes `flag` and `claim` to `<ns>:` ids, and `check` to `ref:` kinds. The build validates
  them as it does now: class matches row type, ns matches directory, referential integrity for `inputs`, `fact` and
  `links[].target`.
- **Supersede semantics are unchanged.** Facts are never edited, and neither are flags or claims: a state change is
  a new row with `supersedes`, and the old row becomes `superseded`. A check is versioned the same way. A flag records
  the check version that raised it, so a rule change never rewrites history.
- **Docs register stays separate.** Questions, answers and to-dos remain in `questions.md` and `actions.md` (ADR 007).
  A flag links to a question by id once promoted; it never becomes one by itself.
- **Views.** New views `v_flags_open`, `v_claims` and `v_check_precision` feed the generated blocks `gen:flags`
  (`flags.md`) and `gen:claims` (`claims.md`). No existing view changes.

### 6.4 One small fact-model addition

Doctor-written "suggested" or "advised" tests and reviews are stored today as events of type `other`, so a check cannot
find them reliably. Add `event.data.type = order` (FHIR `ServiceRequest` shape [F12]), with `data.detail` as written.
Recording only what the document says keeps this inside "record only". Existing rows are not edited; a later
extraction pass adds superseding rows.

## 7. Where it runs and what it costs

| Layer | Runs where | Why | Claude cost |
|---|---|---|---|
| L0 + L1 + deterministic L3 | the daily batch, right after `build` and `gen-views` (same place, same records access, go-live gate already open for it) | pure Python on `kb.sqlite`, stdlib only, no network | none |
| evidence watcher (label versions, guideline pages, recheck dates) | a **public** job (the `agents` user or the batch), which sees only set ids, URLs and dates: no ns, no fact, no name | the PHI user `hl` is egress-locked to the Anthropic API and the router, and should stay so | none |
| L2 evidence cross-reference, L3 link proposals (iteration 4+) | `hl` on the PHI host, through the `saturn.research_crossref` task pack (refs-only params, claude tier, `git_pr` output; delivery is phase 2 of agent-server) | PHI enclave | per-run cap in the task (`budget.max_usd`, today 15), plus a monthly cap the owner sets (proposed 30 USD) enforced by the dispatcher; a delta run is expected to cost a fraction of a full run |

**Evidence fetching from the enclave.** L2 needs PubMed, Europe PMC and DailyMed, which `hl` cannot reach. There are
two options:
1. Widen `hl` egress to a short list of evidence hosts. This is simple, but a query from the PHI user could leak
   record text, and the method's query rule (section 5) would then be the only guard.
2. **Split fetch (recommended).** `hl` writes the generic queries it needs (drug INN, condition term, design filter)
   to a queue. A public job runs them, after a lint that rejects anything other than vocabulary terms and filters, and
   returns results into an evidence cache that `hl` reads.

Option 2 costs one more component and keeps the egress lock as the real boundary.

**General agents.** General-purpose agents (the `agents` user, laptop sessions) get no PHI access by default. A
planned **break-glass** path (not built) would work like this. The agent asks for a scope (one ns, read-only, named
paths, a time box). The owner approves it with a push to the admin DM plus a second factor. The router mints a
short-lived token for that scope, and every read is audited in the run log. Until it exists, PHI work runs only as
`hl` tasks or in the owner's own sessions.

## 8. Privacy rules specific to continuous runs

- Watchers and fetchers outside the enclave see only public identifiers: set ids, guideline URLs, DOIs and dates.
  They never see a namespace, a fact or a value.
- Flags and claims are PHI and live only in the records repo.
- Product fixtures use the synthetic example records.
- The run log holds ids and counts, never values or quotes.
- Digest DMs carry the same content the admin already receives (ADR 011).

## 9. Verification, metrics and feedback

**How each flag is checked.**

| Output | Machine check | Human check |
|---|---|---|
| L1 flag | operator unit tests on synthetic fixtures (golden files per operator); the statement matches the check's template; every `inputs` id resolves and is active; the check is `active` and its citations resolved when it was approved | the owner approves each new check definition before it goes `active` (the same checklist as method section 14: the source is quotable, the quote is exact, no dose or advice wording) |
| L2 item | `verify_citations.py` (0 errors; `--check-quotes`; private-source list in private mode) | the owner reviews the PR (method section 14) |
| claim state change | deterministic; the build checks link targets | the owner promotes, or does not promote, the question |

**Metrics** (computed from flag rows and the run log; `v_check_precision`):
- **precision per check** = useful / (useful + noise), from the owner's marks. Target ≥ 0.7 before a check may post to
  the daily digest; below that it posts to the weekly roll-up only.
- **time-to-flag**: from the fact's `created_at` (ingest) to the flag, which should be under 1 day for L1; and from the
  source's own date to the flag, which shows ingest lag.
- **promotion rate**: flags promoted to questions; **answer rate**: questions answered by a doctor.
- **load**: new `next-visit` flags per person per week (alert burden). The budget in section 5.2 caps it.
- **cost**: USD per L2 run and per month, against the cap.
- **verifier pass rate** for L2 on the first attempt.

**Feedback loop.** The owner's marks go back into each check's precision. Checks below the floor are proposed for
retuning. "Noise" with a reason ("already known", "wrong unit", "range banded") is grouped weekly so that the fix
lands in the right place (a check, the extraction, or the data).

## 10. Iteration plan

Estimates are agent working time, with the owner's review time on top. Claude cost is for runs, not for building.

| Iteration | Scope | Effort | Run cost | Unlocks |
|---|---|---|---|---|
| **1. Deterministic checks + claims skeleton + digest** | operators `range_vs_printed`, `delta_vs_prior` (fixed deltas only, each cited, or none), `med_list_conflict`, `stale`, `passthrough`; check defs as `ref:check` rows; flag and claim rows, id classes and build validation; L0 fingerprint and diff; dedup, budget and refractory period; claims register built from `condition` facts and family/patient-reported events, with `same-source` links and the states `as-recorded` / `restated` / `differs-in-later-source`; digest section "New flags" (capped) + weekly roll-up; `gen:flags` and `gen:claims` views; owner feedback by digest reply; synthetic fixtures and tests | about 3 to 4 agent-days | none (no LLM) | a quiet daily list of what changed and what disagrees, with ids; a register of every claim and who made it; precision data from the first week |
| **2. Monitoring intervals from labels + evidence watcher** | `interval_since` and `suggested_not_recorded`; `event.type = order` in the schema; a check-authoring task (an agent drafts a check from a DailyMed label section, with verbatim quote, set id and version; verifier extension; owner approves); public watcher for label versions, guideline editions and `recheck_after` dates; `cited` claim links | about 4 to 5 agent-days | about 1 to 3 USD per drug for check authoring (one-off per label version) | "label X states monitoring Y, none on file since Z" flags, each quoting the label; alerts when a label or guideline changes |
| **3. Delta-scoped evidence cross-reference** | trigger `saturn.research_crossref` with a focus from the diff; split evidence fetch (section 7); `evidence-changed` claim state; claims and flags link to crossref items; needs agent-server `git_pr` delivery (phase 2) | about 1.5 to 2 agent-weeks, mostly in agent-server delivery and the fetch split | capped per run (15 USD today; delta runs expected to be lower) and per month (owner sets) | evidence that stays current without full reruns; human-only items surfaced as read-checklist rows when their topic changes |
| **4. LLM-assisted claim links and re-evaluation** | Haiku/Sonnet proposes claim links and `differs-in-later-source` candidates from free text (tagged `agent-inferred`, inactive until accepted); question drafting for promoted flags, using method phrasing rules and the verifier word list | about 1 agent-week | small per batch (Haiku tier), capped | fewer missed links in free-text documents; less owner typing |
| **5. Sharing and interoperability** | FHIR export of flags, claims and provenance (`DetectedIssue`, `Condition` as documented, `Provenance`) for a doctor brief annex; precision dashboard in the weekly roll-up; CQL mapping study (no adoption unless it removes code) | about 3 to 5 agent-days | none | a brief annex a doctor can scan; portability |

**Iteration 1 as built (31-Oct-2026, [tools/crossref](../../tools/crossref/README.md)).** Cut to ship sooner:
check definitions, flags and claims live in the records repo's `crossref/` directory (outside `data/`), so the KB build,
its id regex and the views are unchanged (the `flag`/`claim` id classes and `v_flags_open`/`v_claims` views wait until
they are needed); flag and claim state is rewritten each run with git as the history instead of superseding rows;
pages are whole-file generated (`flags.md`, `claims.md`) rather than `gen:` blocks; feedback is a command that appends
to `crossref/feedback.ndjson` (digest-reply parsing is next); no refractory period beyond dedup and snooze;
`linked-data-changed` is not built.

**Iteration 1 stop condition.** Run the checks on the records for 2 weeks. Keep iteration 2 only if the owner marks
at least half of the `next-visit` flags `useful` and the daily load stays at or under the budget. Otherwise, retune
or drop checks before adding more.

## 11. Decision for the owner: the "diagnose" boundary

This section is information for a decision. It is not a design, and nothing here is built.

**Today (rule 0, kept by this design).** The system records, compares with printed ranges, intervals and sources,
and asks the named doctor. A family member reading any output sees facts, citations and questions, never "this
means …".

**What relaxing it would mean.** Concretely, the system would write statements in its own voice about the person's
condition: "this pattern is consistent with X", a differential, "claim Y is no longer supported", a risk estimate, or
a suggested medicine change. Those are the shapes of `ClinicalImpression` and `RiskAssessment` [F5], which this
design never produces.

**Risks (asymmetric).**
- **Automation bias in lay readers** [W1][W2]. A confident machine statement carries weight it has not earned.
  Errors fall on the side that is hard to undo: a medicine stopped, a doctor distrusted, a delay.
- **Error profile.** LLMs produce fluent, wrong statements. Records here contain hard reads, low-confidence facts,
  brand-to-generic uncertainty and conflicts (the views that list them exist for that reason). A diagnosis built on
  them inherits every uncertainty without showing it.
- **Regulatory.** Software that gives patient-specific diagnostic or treatment output to patients or caregivers,
  rather than to a clinician who can review the basis independently, falls outside the FDA's non-device CDS criteria
  [W2] and inside the IMDRF "software as a medical device" framing [W3]. Indian medical device rules may also apply.
  Saturn is a private family tool, but publishing it as open source with such a feature would change how it reads.
- **Relationship.** Doctors may disengage from a family that arrives with machine verdicts. Questions keep the
  conversation open.
- **Fatigue and anxiety.** A continuously running "diagnoser" produces a stream of possibilities. The alert-fatigue
  evidence [A1][A2] suggests that people learn to ignore them, or are frightened by them.

**Safeguards, if the owner ever chose to relax it (the minimum):**
1. **Clinician-facing only.** Any interpretive output goes only into a doctor brief, marked as machine-generated, and
   never into the family digest. This is close to the FDA's HCP-review criterion.
2. **Scope allowlist.** A named topic list (for example "flag trends for the doctor to interpret"), never medicines or
   doses. Rule 0's medicine clause stays absolute.
3. **Labelled hypotheses.** Every such statement is tagged `agent-inferred`, cites its inputs and sources, states
   what would change it, and is phrased as "for the doctor to consider".
4. **Two-model or two-pass verification**, the citation verifier, and the owner's review before anything is shared.
5. **Audit and off-switch.** Each interpretive output is logged with model, prompt version and inputs. A single env
   flag turns the feature off, and it defaults to off.
6. **Doctor sign-off** of the feature itself by a treating clinician, recorded like the thresholds sign-off.

**Recommendation.** Keep rule 0. Nearly all of the value the owner asked for comes from continuous checking, the
claims register and well-aimed questions. The extra value of machine verdicts is small, and their downside is large
and hard to reverse.

## 12. Risks and open questions

| Risk / question | Mitigation or owner decision |
|---|---|
| Alert fatigue makes the digest ignored | budget, tiers, weekly roll-up, precision floor, stop condition for iteration 1 |
| A check cites a label that later changes | the watcher flags checks whose source version changed; the check goes back to `draft` until re-approved |
| Indian brands and fixed-dose combinations differ from US/EU labels | the method's proxy rule (section 4): say so in the template; low-certainty generics get no `interval_since` |
| Banded or missing printed ranges | never pick a band; `data-quality` flag |
| A claim register looks like a verdict list | state names describe records only; generated pages carry the disclaimer; no "supported/contradicted" wording |
| hl egress and evidence fetch | split fetch (recommended) vs. a widened allowlist: **owner decision** |
| Monthly Claude cap for L2 | **owner decision** (proposed 30 USD) |
| Digest budget per person per day | **owner decision** (proposed 3) |
| Who approves check definitions (the owner alone, or a doctor for thresholds-like checks) | **owner decision**; thresholds already wait for doctor sign-off |
| Read access for other family members to `flags.md` and `claims.md` | **owner decision** (records repo access is unchanged) |
| Break-glass for general agents | design and build separately; until then, `hl` tasks only |
| The diagnose boundary | section 11; **owner decision**; the recommendation is to keep rule 0 |

## References (accessed 30-Oct-2026)

- [F1] HL7 FHIR R5 Observation: https://hl7.org/fhir/R5/observation.html
- [F2] HL7 FHIR R5 Condition (clinicalStatus, verificationStatus): https://hl7.org/fhir/R5/condition.html
- [F3] HL7 FHIR R5 Provenance: https://hl7.org/fhir/R5/provenance.html
- [F4] HL7 FHIR R5 DetectedIssue (severity high | moderate | low; implicated; evidence; mitigation):
  https://hl7.org/fhir/R5/detectedissue.html ; also Flag, considered and not used for this purpose:
  https://hl7.org/fhir/R5/flag.html
- [F5] HL7 FHIR R5 ClinicalImpression and RiskAssessment (shapes this design never produces):
  https://hl7.org/fhir/R5/clinicalimpression.html ; https://hl7.org/fhir/R5/riskassessment.html
- [F6] HL7 FHIR R5 Evidence: https://hl7.org/fhir/R5/evidence.html
- [F7] HL7 FHIR R5 ArtifactAssessment: https://hl7.org/fhir/R5/artifactassessment.html
- [F8] HL7 FHIR R5 PlanDefinition (ECA rules): https://hl7.org/fhir/R5/plandefinition.html
- [F9] HL7 FHIR R5 Library: https://hl7.org/fhir/R5/library.html
- [F10] HL7 CDS Hooks (cards with indicator info | warning | critical): https://cds-hooks.hl7.org/
- [F11] HL7 Clinical Quality Language: https://cql.hl7.org/
- [F12] HL7 FHIR R5 ServiceRequest: https://hl7.org/fhir/R5/servicerequest.html
- [A1] Ancker JS et al. Effects of workload, work complexity, and repeated alerts on alert fatigue in a clinical
  decision support system. BMC Med Inform Decis Mak 2017. doi 10.1186/s12911-017-0430-8
- [A2] van der Sijs H et al. Overriding of drug safety alerts in computerized physician order entry. JAMIA 2006.
  doi 10.1197/jamia.M1809
- [A3] Bates DW et al. Ten commandments for effective clinical decision support. JAMIA 2003. doi 10.1197/jamia.M1370
- [A4] Phansalkar S et al. Drug-drug interactions that should be non-interruptive in order to reduce alert fatigue in
  electronic health records. JAMIA 2013. doi 10.1136/amiajnl-2012-001089 ; and High-priority drug-drug interactions for
  use in electronic health records. JAMIA 2012. doi 10.1136/amiajnl-2011-000612
- [A5] Wright A et al. Analysis of clinical decision support system malfunctions: a case series and survey. JAMIA
  2016. doi 10.1093/jamia/ocw005
- [A6] Sittig DF et al. Grand challenges in clinical decision support. J Biomed Inform 2008.
  doi 10.1016/j.jbi.2007.09.003 ; Kesselheim AS et al. Clinical decision support systems could be modified to reduce
  'alert fatigue' while still minimizing the risk of litigation. Health Aff 2011. doi 10.1377/hlthaff.2010.1111
- [B1] Fraser CG. Reference change values. Clin Chem Lab Med 2012. doi 10.1515/cclm.2011.733 ; EFLM Biological
  Variation Database: https://biologicalvariation.eu/ (check its terms before using values in a check)
- [E1] Elliott JH et al. Living systematic reviews: an emerging opportunity to narrow the evidence-practice gap. PLoS
  Med 2014. doi 10.1371/journal.pmed.1001603
- [G1] Guyatt GH et al. GRADE: an emerging consensus on rating quality of evidence and strength of recommendations.
  BMJ 2008. doi 10.1136/bmj.39489.470347.AD
- [L] DailyMed SPL web services (label versions by set id): https://dailymed.nlm.nih.gov/dailymed/app-support-web-services.cfm
- [W1] WHO, Ethics and governance of AI for health: guidance on large multi-modal models (2024):
  https://www.who.int/publications/i/item/9789240084759
- [W2] FDA, Clinical Decision Support Software, guidance (2022; non-device CDS criteria, automation bias):
  https://www.fda.gov/regulatory-information/search-fda-guidance-documents/clinical-decision-support-software
- [W3] IMDRF, Software as a Medical Device: possible framework for risk categorization and corresponding
  considerations, IMDRF/SaMD WG/N12FINAL:2014:
  https://www.imdrf.org/documents/software-medical-device-possible-framework-risk-categorization-and-corresponding-considerations
  (the site did not answer our fetcher on 30-Oct-2026; cited by document number)
