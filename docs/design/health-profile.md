---
title: "Running health profile from daily readings and voice logs (research and design)"
audience: engineer, maintainer
type: explanation
owner: maintainer
last_reviewed: 2026-10-31
review_every: 90d
status: proposed
sources: [docs/design/continuous-crossref.md, docs/decisions/007-simplified-clinical-data-model.md, docs/decisions/010-life-context-signals.md, docs/decisions/011-group-input-only-admin-output.md, docs/decisions/012-continuous-crossref.md, schema/schema.sql, tools/kb/build, tools/kb/gen-views, app/src/rules/engine.ts, app/src/config/thresholds.ts, app/src/types.ts, tools/crossref/home_series.py]
generated: false
---

# Running health profile from daily readings and voice logs (design, proposed)

**Facts as written; not advice; doctors decide.**

> **Iteration 1 built (31-Oct-2026):** `tools/crossref/home_series.py` (`v_home_daily`), the `baseline_shift`
> operator, `docs/health/<ns>/profile.md` and the weekly digest line. See section 5.1 for what was built and how it
> differs from this page.

This page extends [continuous cross-referencing](continuous-crossref.md) (ADR 012, proposed). It does not repeat it.
That design owns checks, flags, claims, dedup, budgets, routing, feedback and the run log. This page adds three
things to it:

1. **Home-series signals:** a daily per-person series built from home readings, with duplicates removed.
2. **A personal baseline and a change check:** one new operator, `baseline_shift`, which raises ordinary
   crossref flags.
3. **A running profile:** a generated, problem-oriented weekly page. Iterations 2 to 4 add symptoms from voice logs
   and a structured daily check-in.

Everything here is generic. The examples use the synthetic namespaces in `fixtures/records-example/`.

## 1. Goal and boundary

**Goal.** A household member sends home BP, pulse and weight readings and Hindi/English voice notes most days. The
system should:

- keep a per-person picture of the signals that matter for that person's documented problems;
- notice when the person's own readings move away from their usual level;
- put that in front of the admin quietly, with ids, so it can become a question for the named doctor.

**Boundary.**

- **Interpretation.** The product's rule 2 ([AGENTS.md](../../AGENTS.md)) applies to everything in this page's
  automated pipeline. Statements are templated, compare the person with themselves or with a cited rule, and never
  say what a change means.
- **Opt-in exception.** A records repo may allow labelled agent interpretation in offline analysis notes (tagged
  `agent-inferred`, with confidence and citations, never in KB facts). The weekly profile may *link* such a note. It
  never generates one. Moving interpretation into the automated profile is an owner decision (section 10, D6) and
  would need the safeguards in [continuous-crossref](continuous-crossref.md) section 11.
- **Medicines.** Nothing here ever suggests starting, stopping or changing a medicine or dose.
- **Red flags.** The red-flag threshold rules (`app/src/rules/engine.ts`, records `config/thresholds.yaml`) are
  unchanged. They are never routed through this system or suppressed by it.

## 2. Research summary

Status tags: **[V]** checked against the primary source or its abstract. **[S]** from a secondary summary.
**[U]** unverified lead; do not build on it without checking. Accessed 30/31-Oct-2026. References are in section 12.

### 2.1 Which daily signals matter (heart failure; after a stroke)

| Signal | What the evidence says | Use here |
|---|---|---|
| **Weight (daily, same time, same scale)** | Weight rises over about 30 days before an HF admission, but not before non-HF admissions. Odds rise with the size of the gain (OR 2.77 for 2–5 lb up to 7.65 for >10 lb vs <2 lb) [H1, V]. The common rule of thumb (>2 kg in 3 days; HFA self-care paper [H2, S]) caught only **20%** of decompensations in one cohort. A moving-average (MACD) method caught 33%, at about 90% specificity [H3, V]. Many worsening episodes show no weight gain at all [H4, S]. | A signal with **low sensitivity**. Keep the existing red-flag rule as it is. Add a person-relative trend check, and never present "no weight change" as reassurance. |
| **Heart rate** | In HFrEF in sinus rhythm, risk rises by about 3% per extra beat per minute [H5, S]. A personalised remote-monitoring algorithm found heart rate the most useful single signal (PPV 92% vs 7% for the rule of thumb). Recall was low (F1 28%) [H6, V]. | Strong case for a **person-relative** pulse series. A cuff's pulse is a rate, not a rhythm: it cannot show a bundle-branch block or confirm AF. |
| **Blood pressure** | After stroke, guidelines set an office target of <130/80 for most people [S1, S]. Home BP is read differently from office BP: home hypertension is ≥135/85 [S2, S]. Large visit-to-visit SBP variability predicts stroke independently of the mean (top decile HR 6.22) [S3, S]. In HFrEF, most low BP has no symptoms. Consensus advises against reacting to the number alone and keys concern on **symptomatic** hypotension [H7, S]. | Track the level (median), the **spread** (SD or CV) and the maximum of SBP. A low reading matters when it comes **with** dizziness, presyncope or a fall, and those rules already exist in the red flags. |
| **Symptoms** | The trials that monitored weight plus symptoms alone did not reduce readmissions (Tele-HF [H8, V]; BEAT-HF [H9, S]). A programme that paired daily signals with a team that acts on them did (TIM-HF2: fewer days lost, lower all-cause death [H10, S]). | The **response pathway** matters as much as the signal. Route to a named doctor through the admin, and measure whether flags are acted on (crossref metrics). |
| **Post-stroke warning signs** | FAST misses many posterior-circulation strokes. BE-FAST adds Balance and Eyes, and cut missed strokes from about 14% to 4.4% in a small retrospective study [S4, V]. Vertigo, unsteadiness, double vision, vomiting and headache are the posterior-circulation pattern. | These are **red-flag symptoms**, handled by the existing symptom rules (`stroke_signs`, `imbalance`, `clumsiness`). A daily check-in (iteration 3) should ask about them in plain words. |
| **Orthostatic symptoms** | Dizziness on standing is common and under-measured in HF. Its prevalence is not systematically known [H11, U]. | A check-in item; not computed from readings. |
| **Sleep, activity** | Useful context, but weak as standalone HF signals without devices. | Already covered by ADR 010 life-context categories (`sleep`, `activity`), shown alongside, never as a cause. |

### 2.2 Home measurement and its artefacts

- **Protocol.** ESH's home BP protocol is 3–7 days, 2 readings morning and evening, with day 1 discarded
  [S2, S]. AHA 2019 also says to use a validated upper-arm cuff [M1, S].
  - Consequence for a family log: one reading a day at varying times is common. The system must say which session a
    reading came from and must not mix sessions silently.
- **First reading and first day read high.** Hence the session median of duplicates, and the warm-up before a
  baseline exists [S2, S].
- **Arrhythmia.** In AF, oscillometric devices are acceptable for systolic BP but not for diastolic BP [M2, S].
  Repeated readings are advised. Design choice: change checks use SBP, pulse and weight. DBP is shown, not flagged.
- **Time of day.** Telegram message time is when the reading was *sent*, not when it was measured. Relayed chat
  readings often have day precision only. A session tag is derived only when `at_precision` is `minute`. Otherwise
  the reading is `untimed`.
- **Cross-channel duplicates.** The same reading often arrives twice: a photo in the group, and the same numbers
  relayed in a chat summary, sometimes with a different date. Counting it twice makes the series look more stable
  than it is.

### 2.3 Detecting change in a sparse, noisy n=1 series

- **SPC for single patients.** Statistical process control (Shewhart charts, EWMA, CUSUM) is well established in
  healthcare quality work [C1, V][C2, V]. It has been applied to individual patients, including home BP, in a handful
  of studies. A review called it "promising but largely under-researched" [C3, V].
  - The framing that matters here is common-cause vs special-cause variation: flag only what lies outside the
    person's own usual noise.
- **Trend methods beat fixed differences in HF.** MACD on weight and CUSUM on impedance beat the fixed rule of thumb
  [H3, V]. Personalised thresholds raised PPV sharply over fixed rules [H6, V]. Both studies show low recall.
  Expect few true flags and some misses.
- **Robust statistics.** Median and MAD (scaled by 1.4826 to estimate a normal SD) resist the outliers home readings
  produce: a cuff error, or a mistyped 811 for 118 [C4, S].
  - EWMA (λ about 0.2–0.3) and tabular CUSUM (k about 0.5σ, h about 4–5σ) are the textbook choices for small
    sustained shifts [C4, S]. They need a stable in-control period first, which a new series does not have.
  - **Agent-inferred design choice** (no n=1 HF validation found): start with a robust median/MAD band plus a
    persistence rule. Add EWMA once 30+ in-control days exist.
- **Missing data.** Gaps are the norm.
  - Never impute across a gap. Restart the baseline when the gap exceeds the window.
  - Treat a gap as information: show it, and let the crossref `stale` check flag it [U: design reasoning].

### 2.4 Symptoms from voice and free text (Hindi, Hinglish, English)

- **ASR.** Whisper fine-tuned on Indian languages (IndicWhisper) had the lowest WER on most of the Vistaar
  benchmarks [N1, V].
  - Vanilla Whisper large-v3 Hindi WER figures vary from about 27% to 60% depending on normalisation and script, and
    no neutral Hinglish benchmark exists [N2, S/U].
  - So **measure on our own clips** (20 hand-corrected clips) before choosing a model.
- **Negation and context.** NegEx (English triggers, 6-word scope) reached specificity 94.5% and sensitivity 77.8%
  [N3, V]. medspaCy's ConText adds temporality, certainty and **experiencer** [N4, S]. Experiencer matters when a
  relative reports for someone else.
  - Hindi and Hinglish need their own cue list: "nahi", "nahin", "na", "koi … nahi", "ab nahi", "pehle tha".
  - "Pertinent negatives" ("no breathlessness today") are data and must be kept.
- **LLM extraction with grounding.**
  - LLMs extract clinical information well zero- and few-shot [N5, V].
  - A sentence-level verification framework measured 1.47% hallucination and 3.45% omission against source
    transcripts [N6, S].
  - Rule here: every extracted symptom carries a verbatim span that must occur in the transcript, checked
    deterministically.
- **Coding.** SNOMED CT symptom concepts sit in the Clinical finding hierarchy.
  - India is a SNOMED member; use is free under an Affiliate Licence issued by NRCeS [N7, S].
  - Mapping the product's closed symptom vocabulary (`app/src/types.ts` `SYMPTOM_TYPES`) to SNOMED concept ids on
    `ref:code` rows is a small, one-off table.

### 2.5 Structured check-ins (PROMs)

- **KCCQ-12** is the validated HF instrument [P1, V]. It is **copyrighted and licensed** (CV Outcomes). No Hindi
  version was found [P2, S]. It is weekly-recall, not daily.
- **PROMIS** items are free for most clinical use, but item wording may not be modified and electronic use needs
  permission. No official Hindi version was found [P3, S].
- **EQ-5D** needs registration [P4, S].
- **The successful HF telemonitoring programmes used short daily symptom or self-rated-health questions**, not
  validated PROMs [H8][H10, U for item lists].
- Design consequence:
  - **Daily:** a small set of plain-language daily items, written by the owner and not taken from any licensed
    instrument, each mapped to a symptom code.
  - **Monthly (option):** a licensed KCCQ-12, only if the owner obtains a licence.

### 2.6 Profile representation and provenance

- **Problem-oriented record.** Weed's problem-oriented record organises data by problem, not by source [R1, S]. The
  profile page follows that: each documented problem lists its signals.
- **FHIR keeps who-said-it separate from what-is-true.**
  - `Condition.verificationStatus` (unconfirmed … confirmed … refuted), with `asserter` separate from `recorder`
    and `evidence` links [R2, V].
  - `Observation.derivedFrom` and `Provenance` (agent = software, entity role = derivation) carry computed values
    [R3, S].
  - Mapping here: home readings = `Observation`. Baselines and shifts are **not** observations: they are
    `DetectedIssue` (a crossref flag) with the statistics in its detail. The weekly profile is a rendered view.
  - `ClinicalImpression` stays a shape the system never produces (crossref section 6.1).

### 2.7 Alert fatigue

- Alert fatigue is covered in [continuous-crossref](continuous-crossref.md) section 1 and references [A1]–[A6]. Two
  RPM-specific points add to it:
  - Unanswered alerts erode trust in home telemonitoring. The authors advise tailoring thresholds to the patient
    [F1, S].
  - Most RPM alerts are not linked to an event (for example 0.48 false alarms per patient-year even for the best
    method in [H3]).
- Hence: change flags are `routine` by default and appear in the **weekly** roll-up. They are promoted only by
  persistence or by the owner.

### 2.8 Privacy

- The Anthropic API deletes inputs and outputs within 30 days by default. They are kept longer only under separate
  agreement or for policy enforcement [Q1, V].
- India's DPDP Act 2023 and its 2025 Rules apply consent rules to all personal data. Phased commencement runs into
  Nov-2026 [Q2, S/U].
- Design rule:
  - **Raw audio never leaves the PHI host.**
  - **Transcripts and readings** go to the Claude API only from the egress-locked PHI user, as message text does
    today.
  - **Statistics run locally** with no network.

## 3. Layered design

```
 home readings (Telegram, relays) ----> KB facts (observation, unchanged)
 voice notes -> local ASR -> transcript -> extraction (it.2) -> symptom observations (+presence, span)
 daily check-in (it.3) ----------------> check-in observations
                                            |
 S1 signals: v_home_daily (session tag, duplicate collapse, daily value per series)
                                            |
 S2 baselines + change: operator baseline_shift (median/MAD band + persistence)   -> crossref flags (DetectedIssue)
                                            |                                         dedup, budget, feedback (ADR 012)
 S3 profile: gen:profile block in docs/health/<ns>/profile.md (problem-oriented, weekly)
                                            |
 S4 routing: weekly digest roll-up line; next-visit flags -> question candidates -> questions.md (owner promotes)
```

### 3.1 S1: signals (`v_home_daily`)

**Scope: home readings.** An observation counts as a home reading when:

- its code is in the person's profile series (default `bp`, `pulse`, `weight`), and
- its source kind is in `profile.home_source_kinds` (default `telegram_msg`, `chat`), or
- `data.method` contains `home`.

Clinic readings are shown as reference points and never enter the baseline.

**Session tag.** Taken from IST clock time when `at_precision = minute`:

| Session | IST time |
|---|---|
| `morning` | 04:00–11:59 |
| `afternoon` | 12:00–16:59 |
| `evening` | 17:00–03:59 |

Any other precision gives `untimed`.

**Duplicate collapse.** These rules are deterministic and every collapse is listed:

- **Same reading sent twice:** same code, same values, within 30 minutes, any source. Keep one: the better source
  rank wins, then the earlier `created_at`.
- **Probable cross-channel duplicate:** same code and identical values (all components), one or both day-precision,
  dates at most 1 day apart, from different sources.
  - Counted once.
  - Raises a `data-quality` flag through the crossref `passthrough` route.
  - Template: "`<code>` `<value>` appears in `<src1>` (`<d1>`) and `<src2>` (`<d2>`); counted once until a human
    confirms."

**Daily value.** For each series and day:

- Take the median of the readings in the preferred session (default `morning`, a per-person parameter).
- When that session has no reading, use the median of all readings that day and mark it `mixed-session`.
- The baseline uses only same-session days when there are at least 7 of them in the window; otherwise mixed days are
  used, and the profile says so.

**Series.**

| Series | Derived from | Note |
|---|---|---|
| `sbp` | `bp` components | |
| `dbp` | `bp` components | shown only |
| `pp` (SBP − DBP) | `bp` components | shown only |
| `pulse` | `pulse` | |
| `weight` | `weight` | |

### 3.2 S2: baseline and change (`baseline_shift` operator)

One new operator joins the crossref operator set (crossref section 4.1: rules as data, operators as code, each
tested on synthetic fixtures).

| Parameter (check row) | Default | Why |
|---|---|---|
| `series` | `sbp` / `pulse` / `weight` | one check per series |
| `window_days` | 28 | long enough to hold 7+ readings with gaps |
| `recent_days` | 3 | excluded from the baseline; the "now" window |
| `min_baseline_days` | 7 | below this the status is `warming-up` and the operator emits nothing |
| `k` | 3 | band = median ± k × 1.4826 × MAD (about ±3σ under normality; Shewhart convention [C4]) |
| `min_spread` | per series: `sbp` 4 mmHg, `pulse` 3 /min, `weight` 0.3 kg | floor for the MAD when readings are near-identical. **Owner parameter**, not a clinical threshold; documented as device resolution plus margin |
| `min_delta` | `null` | optional absolute floor (for example a doctor-given number); `null` = band only. When set, it cites its basis or is `owner-reported` |
| `persistence` | 2 of the last 3 daily values beyond the band, same side | removes single outliers |
| `escalate_after_days` | 7 | a shift that persists this long moves from `routine` to `next-visit` |

**Severity.** `routine` by default. Weekly roll-up only.

**Template.**
> "Home `<series>`: daily values `<v1>`, `<v2>`, `<v3>` (`<d1>`–`<d3>`) are `<above|below>` this person's usual band
> `<lo>`–`<hi>` (median `<m>` of `<n>` days, `<b1>`–`<b2>`, `<session>`)."

**Rules.**

- **Statistics, not facts.** The flag's `data.stats` holds `{median, mad, spread, lo, hi, n, window, session}`. The
  input fact ids are listed in `inputs`. Nothing is written back to `fact`.
- **Dedup key.** Crossref's key plus the band bucket, so a shift that persists updates one open flag.
- **Restart.** A gap longer than `window_days`, or an owner `reset` action (for example after a documented medicine
  change), restarts the baseline. The owner records the reason.
  - The system also lists documented medicine changes from `v_meds_current` next to the series in the profile, as
    "around the same dates" (ADR 010 language). It never says one caused the other.
- **Deferred to iteration 2b.** An `ewma_drift` check (λ = 0.25, L = 3, mainly for weight) once a series has 30+
  in-control days [H3][C4]. Until then the median band is the only change check, which keeps one operator.

### 3.3 S3: running profile (`docs/health/<ns>/profile.md`)

The page is generated and regenerated by `gen-views` on every build. Its front matter is `generated: true`. It is
problem-oriented [R1] and its content is facts plus statistics. Sections:

1. **Problems as documented.** Condition facts (`status_as_documented`, author, date, id) from the existing views.
   Each problem lists its linked series. The links come from `gen-views.json` `profile.problem_signals`, which is
   owner-set. Crossref `cited` claim links replace them when they exist.
2. **Signals this week.** One row per series:
   - home n and days covered this week;
   - median, min–max and SBP SD/CV;
   - baseline band, or `warming-up (n/7)`;
   - status (`within` / `above` / `below` / `no data`);
   - latest clinic reading for comparison (id).
3. **Change flags.** Open `baseline_shift` flags (ids, from `v_flags_open`).
4. **Symptoms this week, as written.** Symptom observations (iteration 2 adds presence and the span) and the red-flag
   annotations already raised.
5. **Alongside.** ADR 010 context bands (`v_context`) and medicine changes in the same dates, under the header
   "Shown alongside, not as a cause."
6. **Data quality.** Collapsed duplicates, untimed or mixed-session days, readings without pulse, and the `stale`
   status.
7. **Linked analyses.** Paths of records-side analysis notes that the owner has tagged for this person (optional;
   interpretation stays in those notes).

The admin digest gets one weekly line per person, for example: "Profile: 3 series, 5/7 days; 1 change flag (pulse);
2 duplicates collapsed." The full page is in the records repo.

### 3.4 S4: symptom extraction (iteration 2)

- **ASR.** Voice notes are transcribed on the PHI host with a local model (whisper.cpp or mlx-whisper; the model is
  chosen by measured WER on our clips). Today the product adapter is a cloud STT (Sarvam); for PHI audio the
  **local** path is preferred (section 2.8).
  - The transcript is stored with the message, as the D1 `transcript` column does today.
  - Low-confidence transcripts go to the needs-human queue, not to extraction.
- **Extraction.** The existing daily Haiku extraction already turns text into symptom rows (`SYMPTOM_TYPES`).
  Iteration 2 adds three fields and one check:
  - `data.presence`: `present` / `absent` / `uncertain`. Absent symptoms are kept as pertinent negatives.
  - `data.temporality`: `current` / `past` / `hypothetical`. Only `current` rows feed the weekly profile counts.
  - `data.experiencer`: `subject` / `other`. Rows about `other` are dropped.
  - **Span check:** `quote` must be a verbatim substring of the transcript after normalisation; otherwise the row is
    dropped and counted. A small Hindi/Hinglish/English negation cue list cross-checks `presence`. On disagreement
    the row goes to needs-human.
- **Owner requirements for transcripts (31-Oct-2026).** A member's voice notes may describe past days and carry
  complex life context, not just today's symptoms. Transcript processing must:
  - **Resolve relative dates to actual dates, anchored on the message date** (the date the note was sent, not the
    batch date). Examples: "aaj" / "today", "kal" / "yesterday", "parson", "pichhle hafte" / "last week".
    - "kal" can mean yesterday or tomorrow. Resolve it from the verb tense; when the tense does not settle it, keep it
      unresolved and send it to needs-human.
    - Store the resolved date with its precision (`day`, or a week range for "pichhle hafte"), plus the phrase as
      spoken.
  - **Separate past events from current state.** "Last week I fell" is a past event on its resolved date, not a
    current symptom. Only `current` rows count in the weekly profile (temporality, above). A past event lands on its
    own date in the timeline, tagged `patient-reported`.
  - **Attribute speakers.** Record who speaks (the patient, or a relative speaking for her) and whom each item is
    about (experiencer). An item about someone else is not recorded as hers.
  - **Keep negations as pertinent negatives.** For example "aaj chakkar nahi aaya" (no dizziness today) is kept as
    `presence: absent` on the resolved date, never dropped.
  - **Keep a verbatim quote for every extracted item.** The quote must pass the span check against the transcript.
  - **Context and life events go through ADR 010's shadow rules.** Per-member consent applies, shadow mode applies
    until the owner enables it, and the content is shown alongside, never as a cause. These items never become
    symptom observations.
- **Codes.** `ref:code` rows for each symptom type gain `data.snomed` (concept id and preferred term), mapped once by
  hand. The licence is noted on the code refs.

### 3.5 S5: structured daily check-in (iteration 3)

ADR 011 makes the group input-only, and only the admin receives bot DMs. A bot-posted questionnaire would therefore
change ADR 011. The recommended route needs **no bot output**:

- A printed card (Hindi and English) with 5–6 plain questions, answered aloud in the daily voice note.
- Extraction maps each answer to a check-in observation (`ref:code:checkin-<item>`, values `less` / `same` / `more`
  or `yes` / `no`).
- Draft items, written by the owner, not from a licensed instrument:
  - breathing compared with usual;
  - ankle or leg swelling;
  - slept propped up or woke breathless;
  - dizziness on standing;
  - walking and balance compared with usual;
  - any new trouble with speech, vision or one-sided weakness. This item is routed to the existing red-flag rules.
- Alternative: a member DM check-in (an ADR 011 amendment; owner decision D4).

### 3.6 Where each part runs

| Part | Runs on | Network | LLM |
|---|---|---|---|
| S1–S3, profile page, digest line | daily batch (`build`, crossref L1, `gen-views`) | none | none |
| ASR (iteration 2+) | PHI host, `hl` user, local model | none | none |
| Symptom extraction | existing batch Haiku call (text only) | Anthropic API only | yes, existing budget |
| Local extraction model (iteration 4) | PHI host | none | local |
| Interpretation (optional, records policy) | offline agent session, owner-requested; output is a records analysis note | as today | yes |

## 4. Data model additions (ADR 007 and ADR 012 compatible)

| Change | Where | Iteration |
|---|---|---|
| `baseline_shift` operator; check rows `ref:check:baseline-shift-<series>-home` | crossref operator set; records `data/ref/check.ndjson` | 1 |
| optional `data.stats` object on flag rows | crossref flag shape | 1 |
| view `v_home_daily` (ns, series, day, session, value, n_readings, input ids, collapsed ids) | `schema/schema.sql`; reads `v_trend` + `source`; no existing view changes | 1 |
| `gen:profile` block and page `docs/health/<ns>/profile.md`; `gen-views.json` keys `profile.series`, `profile.home_source_kinds`, `profile.preferred_session`, `profile.problem_signals` | `tools/kb/gen-views` | 1 |
| observation `data.presence`, `data.temporality`, `data.experiencer` (symptom category only) | `schema/observation.schema.json`; build check | 2 |
| `ref:code` `data.snomed` | code refs | 2 |
| `ref:code:checkin-<item>` codes; observation category `checkin` | code refs; observation schema enum | 3 |

There are no new fact kinds, no new tables and no new services. Baselines are never facts.

## 5. Iteration 1 (buildable now)

**Scope.**

- **`v_home_daily`.** Home filter, session tag, duplicate collapse.
- **`baseline_shift` operator.** Its three check rows (sbp, pulse, weight) ship as a synthetic example; the records
  repo activates its own. It emits through the crossref flag path.
- **`gen:profile` block and `profile.md` page.** Sections 1–3, 5 and 6 of 3.3; section 4 lists existing symptom rows
  as written.
- **Digest.** The weekly profile line.
- **Tests.**
  - Golden fixtures with synthetic series: steady, single outlier (no flag), sustained shift (flag), gap restart,
    cross-channel duplicate, warming-up, mixed-session.
  - `test_gen.py` staleness check covers the new block.

**Dependencies.**

- **Crossref iteration 1** (flag rows, ids, dedup, routing, digest section), in progress separately.
- **If crossref iteration 1 has not landed:** ship `v_home_daily` and `gen:profile` first, with the band status shown
  in the table and no flag rows. The operator then moves over unchanged when the flag path exists.

**Not in iteration 1.** EWMA or CUSUM, voice extraction, check-ins, any LLM, any interpretation, and any change to the
red-flag rules.

**Effort.** Agent time; owner review is extra.

| Piece | Effort |
|---|---|
| `v_home_daily` + duplicate collapse + tests | 0.5 day |
| `baseline_shift` + 3 check rows + golden tests | 0.75 day |
| `gen:profile` + page template + digest line | 0.5 day |
| docs (records guide section, this page's status) | 0.25 day |
| **Total** | **about 2 agent-days** after crossref iteration 1 (about 1.5 days for the standalone variant). Run cost: none. |

### 5.1 As built (iteration 1, 31-Oct-2026)

The build follows sections 3.1 to 3.3, with these differences (each chosen as the smaller option):

- **`v_home_daily` is Python, not SQL.** It lives in `tools/crossref/home_series.py`, because it needs the
  `gen-views.json` settings, medians and the duplicate rules. `schema/schema.sql` is unchanged.
- **crossref writes the profile page, not `gen-views`.** Like `flags.md`, `profile.md` is a whole-file generated
  page, because it needs the flag state of the same run. The batch already commits `docs/health` after crossref.
- **Owner scope.** There are four check rows, `ref:check:baseline-shift-{sbp,dbp,pulse,weight}-home`, all `routine`.
  DBP is in by owner request. Its `min_spread` floor of 3 mmHg is an owner parameter, like the other floors.
  - `escalate_after_days` is not built yet. Every shift stays `routine`.
  - The "recent" window is the 3 calendar days ending on the latest home value, which must be within `window_days`
    of today. The baseline is the rest of the 28-day window.
- **Duplicates.** Both collapse rules run and every collapse is listed on the page with both ids.
  - When a timed reading and a day-precision relay match, the timed reading is kept (it carries a session).
  - Collapsed duplicates do **not** yet raise a `data-quality` flag, and the override row that undoes a collapse
    is not built.
- **Exclusions.** Low-confidence readings and readings with an open hard read are listed and not used.
- **Medicines alongside.** Only starts, stops and restarts, as recorded.
- **Linked analyses.** The page links `profile.links[ns]` plus the 5 newest notes under `docs/log/analysis/` or
  `docs/log/inference/` whose file name contains the namespace.
- **Settings.** All live under `profile` in `data/meta/gen-views.json`:
  - `persons`: null = every namespace with a home reading;
  - `series`, `home_source_kinds`;
  - `preferred_session`: a string, or a per-ns object; `any` turns off mixed-session marking;
  - `sessions`: the IST windows;
  - `problem_signals`, `links`.
- **Medicine timing.** A reading records "before" or "after" morning medicines **only when the record says so**:
  either `data.med_timing`, or a quote or note matching an English or Hinglish pattern ("after morning medicines",
  "dawai se pehle", "goli ke baad"). Otherwise it is "not stated".

**D1 decided (owner, 31-Oct-2026).** Readings are usually around 11 am, after breakfast and morning chores, but not
at a rigid time.

- Sessions are tagged by time window, and the page shows the spread of reading times.
- Time variation is **not** treated as an artefact. The records set `preferred_session: any` for that person, so all
  of a day's readings make the daily value and no day is marked `mixed-session`.
- Readings record before/after morning medicines when the data says so.

**Stop condition.** Run for 4 weeks of home data. Keep iteration 2 only if both hold:

- At least 4 days a week have readings. Below that, the first problem is collection, not analysis.
- The owner marks at least half of the `baseline_shift` flags `useful`.

## 6. Later iterations

| Iteration | Scope | Effort | Run cost | Gate to start |
|---|---|---|---|---|
| **2. Voice-log symptoms** | local ASR wiring for the batch (or the existing pending-STT path with a local adapter); presence, temporality and experiencer fields; relative dates resolved from the message date, past events kept apart from current state, speakers attributed, verbatim quote per item, life context via ADR 010 shadow rules (owner requirements in 3.4); span check; Hindi/Hinglish negation cue list; SNOMED map for the symptom vocabulary; profile section 4 counts; a 20-clip hand-corrected WER and extraction eval set (kept in the records repo, never in the product) | 3–4 agent-days + about 2 owner hours for the eval set | existing Haiku budget (small) | iteration 1 kept; the owner's ASR test picks a model |
| **2b. Slow drift** | `ewma_drift` operator for weight and pulse | 1 agent-day | none | 30+ in-control days on a series |
| **3. Structured daily check-in** | card items (owner-written), `checkin` category and codes, extraction mapping, profile trend of each item (counts of `more` / `yes` per week), red-flag routing for neuro items | 2–3 agent-days + a 2-week family trial | small | iteration 2 extraction precision ≥ 0.9 on the eval set |
| **4. Local models** | evaluate a local extraction model (llama.cpp-class, 7–8B) against Haiku on the eval set; move ASR fully local if not already; keep Haiku as fallback only when measured agreement says so | about 1 agent-week + host time | none (local), lower API spend | iterations 2–3 eval sets exist; the host has the memory for it |

## 7. Verification

- **Operators.** Unit and golden tests on synthetic fixtures only.
- **Profile page.** A snapshot test. `test_gen.py` fails on stale pages.
- **Extraction (iteration 2+).**
  - Span check (machine).
  - Eval-set precision and recall per symptom type and for negation (owner-labelled).
  - A regression set that gates prompt changes.
- **Metrics** (crossref section 9 plus):
  - reading coverage (days per week per series);
  - duplicates collapsed per week;
  - `baseline_shift` precision from owner marks;
  - time from reading to weekly line.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Too few readings for any baseline (the usual case early on) | `warming-up` status shown plainly. No flag below `min_baseline_days`. Coverage is the first metric. |
| A shift flag read as "something is wrong" | Templated, `routine`, weekly only. Compares the person with themselves. Never says what it means. Red flags remain the urgent path. |
| A shift flag read as "all fine" when there is none | The profile says weight and BP trends have low sensitivity [H3][H4] and that symptoms and doctors decide. |
| Duplicate collapse hides a real repeat reading | Every collapse is listed with both ids; a human can undo one with an override row. |
| Diastolic unreliability, untimed readings, cuff errors | Shown, not flagged. Session and mixed-session marks. Median and MAD resist single errors. |
| A baseline that absorbs a slow deterioration | The window is bounded (28 days). The owner can reset or pin the baseline. EWMA in 2b. Weekly view of the long series. |
| A medicine change shifts the series | Medicine changes are shown alongside. The owner may reset the baseline. Never "caused by". |
| Hindi ASR errors invent or drop symptoms | Local WER eval, span check, negation cross-check, low-confidence to needs-human. Raw audio kept for a listener. |
| Check-in items mistaken for a validated score | Plain items, per-item counts, no summed score, no instrument name. |
| PHI leakage | Statistics local. Audio local. Only text to the API from the PHI user. Product fixtures synthetic. |

## 9. Fit with the existing designs

- **[Continuous-crossref](continuous-crossref.md):** `baseline_shift` is one more L1 operator. Flags, dedup, budget,
  feedback, routing and the digest are reused unchanged.
- **[ADR 010](../decisions/010-life-context-signals.md):** context bands appear only as "alongside" rows, and the
  causal-phrase lint applies to the profile block.
- **[ADR 011](../decisions/011-group-input-only-admin-output.md):** output goes to the admin only. The iteration 3
  card needs no bot message.
- **Red-flag thresholds (ADR 005):** untouched.

## 10. Open decisions for the owner

| # | Decision | Proposed |
|---|---|---|
| D1 | Preferred session per person (morning, evening, or any) and whether to ask the family for a fixed time | **Decided 31-Oct-2026:** readings around 11 am after breakfast and morning chores, not rigid. Sessions are tagged by window, time variation is not an artefact (`any`), and before/after morning medicines is recorded when the data says so |
| D2 | `min_spread` floors and whether to set any `min_delta` from a doctor | floors as in 3.2; no `min_delta` until a doctor gives one |
| D3 | Which series per person, and the problem-to-signal links | `bp`, `pulse`, `weight` for the profile person; links set by the owner |
| D4 | Check-in channel: printed card in the voice note (no ADR change), or a member DM (amends ADR 011) | card |
| D5 | ASR: local only for PHI audio (deprecate the cloud STT adapter for real data) | local only |
| D6 | Whether the weekly profile ever carries an automated `agent-inferred` section (needs a product rule change and the crossref section 11 safeguards), or only links offline analysis notes | links only |
| D7 | Whether to licence KCCQ-12 for a monthly check | not now |
| D8 | SNOMED CT affiliate licence via NRCeS before storing concept ids | yes, before iteration 2 ships codes |

## 11. Not covered

- Device integrations (Bluetooth cuffs or scales).
- Wearables.
- Rhythm detection.
- Risk prediction.
- Any medicine logic.

## 12. References (accessed 30/31-Oct-2026; tags as in section 2)

**Heart failure**
- [H1] Chaudhry SI et al. Patterns of weight change preceding hospitalization for heart failure. Circulation
  2007;116:1549. https://pmc.ncbi.nlm.nih.gov/articles/PMC2892745
- [H2] Jaarsma T et al. Self-care of heart failure patients: practical management recommendations from the HFA of the
  ESC. Eur J Heart Fail 2021;23:157. https://openaccess.sgul.ac.uk/112597/1/ejhf.2008.pdf (rule-of-thumb wording
  from a secondary source; the exact wording in the 2021 ESC guideline was not verified)
- [H3] Cuba Gyllensten I et al. Early indication of decompensated heart failure in patients on home-telemonitoring:
  a comparison of prediction algorithms based on daily weight and noninvasive transthoracic bio-impedance. JMIR Med
  Inform 2016;4:e3. https://pmc.ncbi.nlm.nih.gov/articles/PMC4777885
- [H4] Zhang J, Goode KM, Cuddihy PE, Cleland JGF. Predicting hospitalization due to worsening heart failure using
  daily weight measurement. Eur J Heart Fail 2009.
  https://spiral.imperial.ac.uk/entities/publication/0d915b0c-7872-45da-98c2-e9ad05ab19be
- [H5] Böhm M et al. Heart rate as a risk factor in chronic heart failure (SHIFT). Lancet 2010;376:886.
  https://www.acc.org/Latest-in-Cardiology/Clinical-Trials/2012/05/20/16/30/SHIFT
- [H6] Moazeni M et al. Developing a personalized remote patient monitoring algorithm: a proof-of-concept in heart
  failure. Eur Heart J Digit Health 2023;4:455.
  https://researchinformation.umcutrecht.nl/en/publications/developing-a-personalized-remote-patient-monitoring-algorithm-a-p/
- [H7] Skouri H et al. Low blood pressure in HFrEF: HFA clinical consensus statement. Eur J Heart Fail 2025.
  doi 10.1002/ejhf.3618. https://eprints.gla.ac.uk/354979
- [H8] Chaudhry SI et al. Telemonitoring in patients with heart failure (Tele-HF). N Engl J Med 2010;363:2301.
  https://www.nejm.org/doi/full/10.1056/NEJMoa1010029
- [H9] Ong MK et al. Effectiveness of remote patient monitoring after discharge of hospitalized patients with heart
  failure (BEAT-HF). JAMA Intern Med 2016;176:310.
  https://www.acc.org/Latest-in-Cardiology/Clinical-Trials/2015/11/06/23/24/BEAT-HF
- [H10] Koehler F et al. Efficacy of telemedical interventional management in patients with heart failure (TIM-HF2).
  Lancet 2018;392:1047. doi 10.1016/S0140-6736(18)31880-4
- [H11] Orthostatic hypotension in heart failure, 2026 study (abstract only; unverified). https://efim.org/node/151696

**Stroke and blood pressure**
- [S1] Kleindorfer DO et al. 2021 Guideline for the prevention of stroke in patients with stroke and TIA (AHA/ASA).
  Stroke 2021;52:e364.
  https://www.acc.org/latest-in-cardiology/ten-points-to-remember/2021/06/02/18/08/2021-guideline-for-the-prevention-of-stroke
- [S2] Parati G et al. Home blood pressure monitoring: methodology, clinical relevance and practical application (ESH
  position paper). J Hypertens 2021;39:1742. https://pmc.ncbi.nlm.nih.gov/articles/PMC9904446 ; Stergiou GS et al.
  2021 ESH practice guidelines for office and out-of-office BP measurement. J Hypertens 2021;39:1293.
- [S3] Rothwell PM et al. Prognostic significance of visit-to-visit variability, maximum systolic blood pressure, and
  episodic hypertension. Lancet 2010;375:895. doi 10.1016/S0140-6736(10)60308-X
- [S4] Aroor S, Singh R, Goldstein LB. BE-FAST: reducing the proportion of strokes missed using the FAST mnemonic.
  Stroke 2017;48:479. doi 10.1161/STROKEAHA.116.015169

**Measurement**
- [M1] Muntner P et al. Measurement of blood pressure in humans: AHA scientific statement. Hypertension 2019;73:e35.
  https://pubmed.ncbi.nlm.nih.gov/30827125/
- [M2] Stergiou GS et al. Automated blood pressure measurement in atrial fibrillation: a systematic review and
  meta-analysis. J Hypertens 2012; Clark CE et al. J Hum Hypertens 2019.
  https://ora.ox.ac.uk/objects/uuid:b03c4ccf-5a2f-4c73-ab46-9061f8ba01aa

**Change detection**
- [C1] Thor J et al. Application of statistical process control in healthcare improvement: systematic review. Qual Saf
  Health Care 2007;16:387. https://qualitysafety.bmj.com/content/16/5/387
- [C2] Mohammed MA, Cheng KK, Rouse A, Marshall T. Bristol, Shipman, and clinical governance: Shewhart's forgotten
  lessons. Lancet 2001;357:463.
- [C3] Tennant R, Mohammed MA, Coleman JJ, Martin U. Monitoring patients using control charts: a systematic review.
  Int J Qual Health Care 2007;19:187. https://pubmed.ncbi.nlm.nih.gov/17545672
- [C4] Montgomery DC. Introduction to Statistical Quality Control. Wiley (Shewhart, EWMA and CUSUM design; edition
  not verified). Robust scale (MAD × 1.4826): standard robust-statistics result; see e.g. Rousseeuw PJ, Croux C.
  J Am Stat Assoc 1993;88:1273.

**Language and extraction**
- [N1] Bhogale K et al. Vistaar: diverse benchmarks and training sets for Indian language ASR. Interspeech 2023.
  https://www.isca-archive.org/interspeech_2023/bhogale23_interspeech.pdf ; https://github.com/AI4Bharat/vistaar
- [N2] Vendor-reported Whisper Hindi benchmarks (self-reported, not neutral): https://huggingface.co/Trelis/tara ;
  https://huggingface.co/Oriserve/Whisper-Hindi2Hinglish-Prime
- [N3] Chapman WW et al. A simple algorithm for identifying negated findings and diseases in discharge summaries. J
  Biomed Inform 2001;34:301. doi 10.1006/jbin.2001.1029
- [N4] Eyre H et al. Launching into clinical space with medspaCy. AMIA 2021. https://arxiv.org/abs/2106.07799 ;
  Harkema H et al. ConText. J Biomed Inform 2009;42:839.
- [N5] Agrawal M et al. Large language models are few-shot clinical information extractors. EMNLP 2022.
  https://aclanthology.org/2022.emnlp-main.130
- [N6] Asgari E et al. A framework to assess clinical safety and hallucination rates of LLMs for medical text
  summarisation. npj Digit Med 2025. doi 10.1038/s41746-025-01670-7
- [N7] NRCeS (India SNOMED CT release centre) FAQ: https://nrces.in/faqs ; https://www.snomed.org/members/india

**PROMs**
- [P1] Spertus JA, Jones PG. Development and validation of a short version of the KCCQ. Circ Cardiovasc Qual Outcomes
  2015;8:469. https://pmc.ncbi.nlm.nih.gov/articles/PMC4885562
- [P2] KCCQ licensing and translations: https://cvoutcomes.org/
- [P3] PROMIS terms of use: https://www.assessmentcenter.net/ac_api/2012-01/Terms/PROMIS ; languages:
  https://www.facit.org/measures-language-availability
- [P4] EuroQol registration: https://euroqol.org/

**Records and FHIR**
- [R1] Weed LL. Medical records that guide and teach. N Engl J Med 1968;278:593. https://pubmed.ncbi.nlm.nih.gov/5637758/
- [R2] HL7 FHIR R4 Condition: https://hl7.org/fhir/R4/condition.html (R5 equivalents: continuous-crossref [F2])
- [R3] HL7 FHIR R4 Observation and Provenance: https://hl7.org/fhir/R4/observation.html ;
  https://hl7.org/fhir/R4/provenance.html

**Telemonitoring practice**
- [F1] Alert fatigue in home-health heart failure telemonitoring (2014; authors not verified).
  https://pmc.ncbi.nlm.nih.gov/articles/PMC3885909/

**Privacy**
- [Q1] Anthropic Privacy Center: data retention (dated 1-Jul-2026).
  https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data
- [Q2] Digital Personal Data Protection Act 2023 and DPDP Rules 2025 (notified Nov-2025; phased).
  https://www.scconline.com/blog/post/2025/11/14/meity-notified-digital-personal-data-protection-rules-2025/
