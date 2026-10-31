---
title: Family health site: design
status: approved; first slice built (tools/site)
date: 2026-10-31
---

# Family health site: design

It contains no PHI. Every example uses the synthetic person in the mockup.

**First slice (31-Oct-2026), owner feedback applied:** `tools/site/build --records <dir> --out <dir>`. Six tabs, in
this order: **Overview** (the mockup's Today), **Status** (agent inferences; "No inferences yet" plus the person's
latest analysis notes until rows exist), **Medicines**, **Results**, **History** (own tab) and **Wiki** (problems as
written, care team, documents with the originals, questions, family to-dos, every records page and analysis note).
All six fit the bottom bar at 390 px. The Ask screen became Wiki > Questions (the top "now" question stays on
Overview). Doctor view and Simple view are placeholders. Sections 4 and 5 below are the original proposal.

- **Mockup:** [health-site-mockup/index.html](health-site-mockup/index.html). It has 8 pages, uses synthetic data and is mobile-first.
- **Screenshots:** in [health-site-mockup/shots/](health-site-mockup/shots/), taken at 390 px, light mode, plus two in dark mode.

## 1. Goals

The records repo is correct but hard to use: on GitHub it is long Markdown, tables and ids. The site is a **read-only view of the same KB**. It is generated, never hand-written, and phone-first.

Three tests decide whether it works:

1. **The owner, on a phone, in under a minute:** what is the state now, what changed, what is pending, and what to ask the doctor.
2. **A parent:** can see today's medicines, the next visit and the latest key numbers, in large type, without help.
3. **A doctor in a consult:** can read one short page in a familiar order and trust where each line came from.

Non-goals:

- No editing, no log-in screens and no notifications. Answers and to-dos still go through the bot or the records repo.
- No medicine advice.
- No new clinical thresholds (see 6.2).

## 2. Users and jobs

| User | Device and context | Job | What they need |
|---|---|---|---|
| Owner (son, technical, caring all day) | Phone, one hand, interrupted | State, changes, pending, questions | One scroll on Today; tap for detail; provenance one tap away |
| Parents (non-technical; Hindi later) | Phone, larger text setting | "What do I take, when is the doctor, am I OK" | Simple view: 3 cards, 22 px or larger type, plain words, no ids |
| Doctor (consult, 5 to 10 minutes) | The owner's phone handed over, or a printout | Problems, medicines, latest results with ranges and trends, recent events | Doctor view in IPS order, dense, sources shown, no data dump |

## 3. Research basis

The research was done on 31-Oct-2026; full digest in the task report. Each point is followed by what the design does with it.

**Use number lines, not tables, for patients.**
- Patients who saw a visual number line were less likely than table readers to call a near-normal value urgent, and extreme values still read as urgent. Zikmund-Fisher et al., JAMIA 2017: <https://iro.uiowa.edu/esploro/outputs/journalArticle/Graphics-help-patients-distinguish-between-urgent/9984094506702771>.
- Harm anchors help, but they are clinical judgement: <https://pmc.ncbi.nlm.nih.gov/articles/PMC5891666/>.
- **Design:** range bars use the lab's own range. Harm anchors appear only when a doctor or guideline is cited (open decision D4).

**Give every number its comparison, in whole and familiar numbers.**
- CDC Clear Communication Index: <https://www.cdc.gov/ccindex/tool/page-15.html>, <https://www.cdc.gov/ccindex/tool/page-16.html>.
- CDC numeracy: <https://www.cdc.gov/healthliteracy/researchevaluate/numeracy.html>.
- **Design:** never a bare "high". Always "5.4, lab range 3.5–5.1, lab flag H".

**Icon arrays help with probabilities, not lab values.**
- <https://pmc.ncbi.nlm.nih.gov/articles/PMC2775772>; Ancker's review: <https://pubmed.ncbi.nlm.nih.gov/25133362/>.
- **Design:** not used now. Kept for any future risk score.

**Colour is never the only signal.**
- WCAG 1.4.1: <https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html>.
- **Design:** every colour pairs with a word and an arrow ("↑ High (lab flag)"). Colour comes only from the lab's printed flag.

**Clinician order.**
- HL7 IPS sections: Problems, Allergies, Medications (required); Results, Procedures, Immunizations (recommended); Vital signs, Plan of care and others (optional). An empty required section states why it is empty: <https://build.fhir.org/ig/HL7/fhir-ips/en/Structure-of-the-International-Patient-Summary.html>, <https://build.fhir.org/ig/HL7/fhir-ips/en/Empty-Sections-and-Missing-Data.html>.
- Problem-oriented record (Weed 1968): <https://pubmed.ncbi.nlm.nih.gov/5637758/>.
- **Design:** the doctor view follows this order and shows "No known allergies recorded in any document".

**Flowsheets.**
- Panel tables are scannable but values get missed; graphs show trends; drop empty columns: <https://rcastoragev2.blob.core.windows.net/d4cccf3fea158127819abdc9e03b68fc/PMC2929542.pdf>.
- **Design:** the doctor flowsheet is latest, previous, range and a sparkline. It has no wide date grid.

**What clinicians distrust in patient-provided data.**
- Accuracy, completeness and workload: <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8663681/>.
- **Design:**
  - Every line shows its source and verification.
  - Family-reported items are tagged.
  - Normal home readings are summarised, not listed.

**Existing patterns.**
- MyChart shows the standard range with a per-test trend: <https://www.mychart.org/l/en-us/help/test-results/>. Epic graphs the trend against the reference limits: <https://salemhealth.org/common-ground-home/common-ground-post/from-it-to-you-graphing-patient-lab-data-in-epic>.
- Apple Health uses Highlights and pinned tests: <https://support.apple.com/guide/iphone/view-health-records-iph2b3a37ddd/ios>.
- Withings uses a range bar with a cursor and a named category: <https://support.withings.com/hc/ja/articles/33575381550481-BPM-Vision-Color-Code-Meanings>.
- Fasten Health is a self-hosted PHR with lab dashboards: <https://docs.fastenhealth.com>.
- **Design:** the Today page acts as Highlights, results use range bars with cursors, and each test has a trend on tap.

**Mobile layout.**
- Progressive disclosure: <https://nngroup.com/articles/progressive-disclosure/>.
- Cards suit mixed summaries; lists and tables suit comparison: <https://www.nngroup.com/articles/cards-component/>.
- Keep tabs few, with no "More" tab: <https://developer.apple.com/design/human-interface-guidelines/tab-bars>.
- **Design:** 4 tabs. Cards on Today; lists and tables on Results and Medicines.

**Older users.**
- Contrast 4.5:1 (AA) and 7:1 (AAA): <https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html>.
- Targets of 24 px minimum (WCAG 2.5.8) and 44 pt (Apple): <https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html>, <https://developer.apple.com/design/tips/>.
- Older adults prefer larger fonts, but returns diminish: <https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9376262/>.
- Devanagari needs about 1.7 line-height and 1 to 2 px more size (practitioner advice): <https://www.websnp.com/help/nepali-unicode-fonts-website-typography>.

**AI labelling.**
- A short, visible credit line is accepted by patients: <https://www.medicaleconomics.com/view/patients-prefer-ai-portal-messages-until-they-learn-the-source>.
- **Design:** the "Agent-inferred · not from a document" block.

## 4. Information architecture

The URL scheme is static: `/<person>/<screen>.html` (for example `/mother/today.html`), plus `/index.html`, the person picker. The site has one site-wide picker and no log-in, because the network is the access control (section 9).

```
Person picker (index)
└─ Person
   ├─ Today ─────────── tab 1   (History is reached from "What changed → All history")
   │   └─ History (timeline)
   ├─ Results ───────── tab 2   Latest | Trends | Table
   │   └─ Trend detail (one test)
   ├─ Medicines ─────── tab 3   (full history behind a link)
   ├─ Ask ───────────── tab 4   questions by priority, family to-dos
   ├─ Doctor view       (separate page, no tabs, printable)
   └─ Simple view       (separate page, no tabs, for parents; English | हिंदी)
```

- **Bottom tab bar:** Today, Results, Medicines, Ask. It is the same on every family page. The Ask badge counts the "now" questions.
- **Doctor and Simple views** have no tab bar. Each is a mode reached from Today, so they can be bookmarked or opened alone: a parent's home-screen icon goes straight to Simple view, and the owner hands over the phone on Doctor view.
- **Every page footer** reads: "Facts as written; not advice; doctors decide." It also gives the legend (dashed purple = agent-inferred) and the privacy line.

## 5. Screens: content and visual hierarchy

Order on the page is the order of importance.

**1. Today** ([shot](health-site-mockup/shots/today.png))
1. Top bar: the person (avatar and short name; tap to switch) and "Data as of DD-Mon-YYYY". This is the latest KB fact date, not the build time.
2. **What changed (14 days):** up to 3 items from `v_timeline`, each with:
   - its date and type (test, visit, medicine, event);
   - one line of headline;
   - flag pills for any H or L values.
   - Family-reported items are tagged. Followed by a link to "All history".
3. **Pending:**
   - the next appointment;
   - ordered tests with no result yet;
   - the count of "now" family to-dos.
4. **Ask the doctor:** the top "now" question in full, plus a count.
5. **Key numbers:** a 2×2 grid of tiles, chosen per person in config.
   - Each tile shows the value with its unit, a flag pill (or "In range"), a sparkline, and the date with the lab's range.
   - Home vitals show "No lab range" and are never coloured.
6. **Agent-inferred note** (optional, at most one): what to raise next, labelled.
7. Mode buttons: Doctor view, Simple view.

**2. Results** ([shot](health-site-mockup/shots/results.png))
- A segmented control switches between Latest, Trends and Table.
- **Latest** is grouped by panel (Kidney, Sugar, Thyroid, and so on). Each panel header gives its date and lab. Each row shows:
  - the name and the value (large) with its unit;
  - a **range bar** (lab band, value dot, previous value as a hollow dot when it came from the same lab);
  - the flag pill and the range text;
  - "before: X on date (other lab)".
- **Home readings** (BP, weight, SpO₂) form their own section, tagged family-reported. They show as a short table plus a count.

**3. Trend detail** ([shot](health-site-mockup/shots/trend.png))
1. A hero value with its flag, date, lab and range.
2. The trend chart (6.3), with a legend.
3. An optional agent-inferred reading.
4. A table of every value (the accessible equivalent of the chart).
5. The verbatim quote of the latest value, with its source and page. A "Provenance" disclosure shows the fact id and verification.
6. Related tests and problems.

**4. Medicines** ([shot](health-site-mockup/shots/medicines.png))
- A notice: "records what was written and what is taken; never suggests a change".
- The **schedule grid** has one row per medicine and columns for Morning, Noon and Night.
  - Each cell shows the tablet count from `dose_m/n/e`.
  - Each row shows the name, strength, instructions, the prescriber with date, and a status pill.
- **Conflicts** are shown, never resolved: the affected cells are dashed amber with "1?", and a conflict card shows both statements and links its question.
- Then "Recent changes" (started or stopped, with the document), and the full history behind a link.

**5. Ask** ([shot](health-site-mockup/shots/ask.png))
- Filter chips: All, per doctor, Answered.
- **Question cards** are grouped by priority (Now, Next visit, Someday). Each card shows:
  - the doctor chip and the id;
  - **Ask** (bold);
  - **Why** (the documented facts, quoted with dates);
  - the source count.
- **Family to-dos** come next: checkbox-styled, read-only.

**6. History** ([shot](health-site-mockup/shots/timeline.png))
- Filter chips: All, Visits, Tests, Medicines, Events.
- A vertical timeline, newest first, with month headers.
- Each card has an icon by type, the date, a title and a one-line detail.
- Family-reported cards are dashed. Older years are collapsed behind a link.

**7. Doctor view** ([shot](health-site-mockup/shots/doctor.png))
- One page, dense (15 px), print CSS. Sections in **IPS order**:
  1. Allergies, stating why if empty.
  2. Problems, as written by doctors, each with its source.
  3. Current medicines: dose pattern and status, plus the conflict and stopped lines.
  4. Results flowsheet: latest, previous (with month and a † mark for another lab), range and sparkline. Lab flags are shown as printed.
  5. Vital signs: home summary (range and a computed mean, labelled).
  6. Recent events (90 days).
  7. The family's questions for today (only that doctor's "now" questions).
- **Banner:** compiled by the family, values as printed, status explains verification, inferred lines are marked. "Print or save as PDF" uses the browser's print, with no JS library.

**8. Simple view** ([shot](health-site-mockup/shots/simple.png))
- A language toggle (English, हिंदी) and a greeting with the date.
- **Today's medicines:** three large slots (sun, noon, moon icons) with names in plain words. A conflict is told plainly ("the paper says morning; you take it at night; Rohan will ask").
- **Next doctor visit.**
- **Latest tests:** up to 3, each with one plain sentence derived only from the lab flag and the previous value.
- A large "Call <son>" button (`tel:`).
- No ids, no charts, 22 px or larger body text, 52 to 64 px targets.

## 6. Components

**6.1 Fact vs agent-inferred: the core visual rule.**
- **Facts** sit on solid white cards in normal-weight upright text, and always carry a source chip (document icon, "Lab, date · page"). A "Provenance" disclosure shows the KB id and verification.
- **Agent-inferred** content sits in a purple-tinted box with a **dashed purple border**. It has a header ("✦ Agent-inferred · not from a document"), *italic* body text, and a foot line ("Not a diagnosis. Doctors decide.", with the linked question).
- Inline derived numbers (means, counts) get a small dashed purple "computed" or "inferred" pill.
- **Family- or patient-reported** items use a dashed grey border on the card plus the words "family-reported".
- **These three never share styling.**

**6.2 Flag pill and colour rule.** Colour comes **only** from the lab's printed flag:

| Flag | Shown as |
|---|---|
| H or L, printed by the lab (`data.flag` with `flag_basis` printed) | Amber pill with an arrow and "High (lab flag)" or "Low (lab flag)" |
| Critical, printed by the lab | Red pill |
| A flag the build computed from the printed range | Outline pill, "outside printed range (computed)", never filled |
| No flag | Neutral "In lab range" outline |
| No range (home vitals) | "No lab range", never coloured |

- **The site never invents thresholds.** A guideline band (for example a BP category) appears only if a cited ref row defines it (D4).
- High and low share one amber, with an arrow for direction. Using blue for "low" would read as "good".

**6.3 Lab trend card and charts.** These are inline SVG, computed at build time, with no JS.
- **Range bar** (number line):
  - a grey track;
  - the lab's range as a teal-tinted band with its numbers below;
  - today's value as an 8 px dot (amber only if flagged), with a 2.5 px surface ring;
  - the previous same-lab value as a hollow dot.
  - A range with only an upper limit ("<100") shades from 0.
- **Trend chart:**
  - x is time and y is the value with a recessive grid of 4 ticks;
  - **a step band per result** draws each result's own lab range;
  - **one line per lab, joining only that lab's results.** Results from different labs are never joined;
  - marker shape encodes the lab (circle, square), with a legend;
  - flagged points are amber;
  - only the last value is labelled directly;
  - `<title>` gives a native tooltip, and the **table below is the accessible equivalent**.
- **Sparkline:** 64 to 96 px, with the band, the line and the last dot.
- One axis only. BP is the exception: systolic and diastolic share one mmHg axis.

**6.4 Medicine schedule grid.**
- Columns are Morning, Noon and Night, with icons and labels. Cells come from `dose_m/n/e`.
- When those are missing, the row spans all columns and shows `schedule_raw` verbatim ("as written").
- The status pill follows the AGENTS ladder:

| Status | Style |
|---|---|
| prescribed | Dashed amber "Prescribed only" |
| strip-seen / patient-confirmed / clinician-reconciled | Teal |
| stopped | Shown only in "Recent changes" and history |

- `display_status = not-in-current-list` renders under "Not in the current list".

**6.5 Timeline item.** An icon by `type` (opd and teleconsult: stethoscope; test_visit and observations: flask; medication: pill; fall: figure; procedure and admission: hospital), a date, a title and a one-line detail. `uncertain_ref` adds "uncertain". Family-reported cards are dashed.

**6.6 Question card.** Priority label (Now in red text, Next visit in teal, Someday in grey), a doctor chip, the id, the **Ask** text (bold, 17 px), the **Why** text (secondary, with a left rule) and the source count. Answered questions show the answer and its source in a collapsed section.

**6.7 Key-number tile, change-feed row, conflict card, notice** are shown in the mockup's [style.css](health-site-mockup/style.css).

## 7. Visual system

- **Type:** the system font stack (`system-ui`, then Noto Sans and Noto Sans Devanagari as fallbacks). **No web fonts**; a Devanagari face can be self-hosted later (D3). Numbers use `tabular-nums`.
  - Family pages: 13, 15, **17 (body)**, 20, 26 and 34 px.
  - Simple view: 17, 19, **22 (body)**, 26 and 34 px; line-height 1.5 (1.7 for Hindi).
  - Doctor view: 15 px body.
- **Spacing:** a 4 px base (4, 8, 12, 16, 24, 32). Cards have a 14 px radius and 16 px padding. The page column is at most 480 px, or 760 px for the doctor view.
- **Targets:** at least 44 px on family pages and 52 to 64 px on Simple view; the tab bar is 56 px.
- **Colours** are CSS custom properties with light and dark sets, via `prefers-color-scheme` plus a `data-theme` override. WCAG contrast was measured for these values:

| Token | Light (on card) | Dark | Use |
|---|---|---|---|
| ink | 17.6:1 | 15.0:1 | body |
| ink-2 | 9.7:1 | 10.2:1 | secondary |
| ink-3 | 6.1:1 (7.9:1 in Simple) | 6.8:1 | meta |
| accent (teal) | 7.2:1 | 8.8:1 | links, tabs, strong status |
| flag-ink on flag-bg (amber) | 7.0:1 | 9.2:1 | lab H/L |
| crit-ink | 7.6:1 | 8.4:1 | critical, "Now" |
| inf-ink on inf-bg (purple) | 7.7:1 | 9.5:1 | agent-inferred |
| flag marker vs card | 3.9:1 | 8.1:1 | chart dots (graphics, 3:1 needed) |

- Status colours (amber, red) are reserved for lab flags and priority. Purple is reserved for agent-inferred content. Teal is used for navigation and the range band.
- Light mode uses a warm off-white page with white cards. Dark mode (`#121211`/`#1c1b19`) has its own steps rather than an automatic inversion.

## 8. Data contract (KB → components)

The generator reads `<records>/data/kb.sqlite`, built by `tools/kb/build`, through the existing views. **No new clinical logic lives in the site.**

| Component / screen | Source | Notes |
|---|---|---|
| "Data as of", fact count | Same query as `gen:asof` | Latest dated fact per ns |
| Key-number tiles, Results latest | `v_latest` + `v_trend` (previous value) | Codes and panel grouping from `data/meta/gen-views.json` (extended with `panel` and `tiles`); display names from `ref:code` |
| Flag pill | `v_trend.flag` + `fact.data.flag_basis` | `printed` → coloured; `computed` → outline |
| Range bar, trend chart, sparkline | `v_trend` (`value_num`, `unit`, `ref_low`/`ref_high` from data, `ref_text`, `source_id` → `org_id`) | The lab for marker shape and line breaks comes from `data.org_id` or the source |
| Home readings | `v_trend` where the source is Telegram / family-reported | Never coloured |
| What changed | `v_timeline`, last 14 days | Titles from `label`; groups observations by source |
| History | `v_timeline` (+ `v_context` bands later, ADR 010) | Uses the `gen:timeline` grouping |
| Medicine grid | `v_meds_current` + `fact.data` (`dose_m/n/e`, `schedule_raw`, `prescriber_id`) | `display_status`, `list_status`, verification |
| Medicine conflicts | `v_conflicts` (kind medication) + facts tagged conflict | Both sides shown |
| Problems | `fact` kind condition, active | `text_as_written`, `status_as_documented`, source |
| Allergies | none yet | Shows "No allergy statement on file" (D5) |
| Care team chips | `ref:party` (display name, role) | Credentials only in the doctor view, as `gen:care-team` |
| Questions, to-dos | **not in the KB**: `docs/health/<ns>/questions.md`, `docs/health/family/actions.md` | Parsed by heading id and the `Ask/Why/Priority/Audience/Status` fields (D1) |
| Pending tests, next appointment | **not in the KB as structured rows** | D2 |
| Agent-inferred notes | `inferences/<ns>/inferences.ndjson` (`inference/1`, [tools/inference/README.md](../../tools/inference/README.md)): highest `rev` per id, then `status == active`; grouped by problem, ordered by stakes then p | Never mixed into `fact`; each row carries its evidence and "Not a diagnosis. Doctors decide." |
| Data-quality hints | `v_needs_human`, open hard-reads | A small "n items need a human" line on Today (later) |

**Rule:** any page element whose data is missing is left out, never filled with a placeholder or a guess. An IPS-required section that is empty says why.

## 9. Privacy and serving

- **Served only on the tailnet.**
  - The home server runs `tailscale serve` (HTTPS with the tailnet certificate) on a static directory.
  - No public port, no Cloudflare and no Funnel.
  - The tailnet ACL lists the family's devices. Each parent's phone joins the tailnet, or uses the owner's phone.
- **No third-party requests.**
  - No CDNs, web fonts, analytics or external images.
  - Every page sets `Content-Security-Policy: default-src 'self'; script-src 'none'` (inline styles move into the stylesheet in the real build). It also sets `Referrer-Policy: no-referrer` and `<meta name="robots" content="noindex">`.
  - A build test fails on any `http(s)://` URL in the output other than the site's own host, and on any `<script>` that is not allowlisted.
- **Output lives outside git:** `<records>/site/dist/` (gitignored), or a directory on the home server. The build refuses to write inside the product repo.
- **Go-live gate.** Serving real records on the home server is a deployment of real data, so it needs the owner's explicit "go", recorded per the records rules. Until then the site is built only from `fixtures/records-example/`.
- **Sharing.**
  - The doctor view is shown on the phone or printed. That is deliberate, one-to-one sharing.
  - A PDF sent outside the family passes the existing `tools/docs-site` denylist gate (sanitiser plugin).
  - The health site never reuses the public docs-site build or output directory. The docs-site private-input gate (`private-gate.mjs`) protects the *public* docs from private research. The health site is the reverse: its whole output is private, so its gate is the output-location check and the no-external-URL test.

## 10. Build plan

**Stack:**
- Python 3 standard library only (`sqlite3`, `string.Template`/f-strings, `html`), run as `python3 -I`. This matches `tools/kb` and needs no npm or framework.
- Static HTML with one CSS file. Charts are inline SVG generated at build time.
- **JS: none**, beyond optional progressive enhancement later (tap-to-show tooltip on charts, about 30 lines).

**Tool:** `tools/site/build --records <dir> --out <dir> [--person <ns>]`.

| Step | What | Effort (agent-days) |
|---|---|---|
| 1 | Skeleton: config (`records.yaml` display names, `gen-views.json` panels and tiles), page shell, CSS from the mockup, output-location guard, CSP | 0.5 |
| 2 | Data layer: queries over the views above; lab and org resolution; previous-value logic | 0.5 |
| 3 | SVG components: range bar, trend chart (step band, per-lab lines), sparkline; unit tests on geometry | 1 |
| 4 | Screens: Today, Results, Trend, Medicines, History | 1.5 |
| 5 | Questions and to-dos parser (or D1 KB rows), Ask screen | 0.5 |
| 6 | Doctor view (IPS order, print CSS) and Simple view (English) | 1 |
| 7 | Tests on `fixtures/records-example`: golden HTML snapshots, no-external-URL test, contrast check of the CSS tokens, stale-output check (like `test_gen.py`) | 0.5 |
| 8 | Serving: a systemd timer or post-pull hook runs build then `tailscale serve`; runbook and status update | 0.5 |
| | **Total** | **about 6 agent-days**, plus about 1 hour of owner review at two checkpoints (after step 4 and after step 6) |

**Later:**
- Hindi Simple view: a string table plus family-reviewed translations of the fixed phrases. Generated sentences are templates, not machine-translated free text. About 1.5 days.
- Self-hosted Devanagari font: 0.5 day.
- Tap tooltips: 0.5 day.

**Asymmetric risks:**
- **(a) Leaking real data outside the tailnet:** high impact, low probability. Mitigated by the output guard, the CSP and no-external-URL test, `tailscale serve` without Funnel, and the go gate.
- **(b) A colour or wording that looks like advice or a diagnosis:** high impact. Mitigated by the lab-flag-only colour rule, the inferred styling, and the copy review in step 7.
- **(c) Drift between the site and the Markdown pages:** low impact. Both come from the same views, and the build reuses the `gen-views` queries.

## 11. Open decisions for the owner

| # | Decision | Recommendation |
|---|---|---|
| D1 | Questions and to-dos live in Markdown, outside the KB. Parse the Markdown, or move them into KB rows? | Parse now (cheap, stable format); move to KB rows when the register next changes shape |
| D2 | Pending tests and appointments have no structured home. Add `event` types `order` and `appointment`, or a tag? | Add event types `order` (with the ordered codes) and `appointment`; a schema change via ADR |
| D3 | Self-host a Devanagari font now or rely on the phone's system font? | System font now; self-host when Hindi ships |
| D4 | Harm anchors and guideline bands (for example a BP category): ever shown? | Only when a doctor's documented target or a cited guideline ref exists; labelled with its source |
| D5 | Allergies: add an `allergy` fact kind, or a condition with a tag? | Condition with category `allergy` plus an explicit "none known" statement fact |
| D6 | Where agent-inferred notes come from | Decided: `inferences/<ns>/inferences.ndjson` (inference records, product v0.9.0); the old `data/<ns>/inferred/` idea is dropped |
| D7 | Parent access: a parent's phone on the tailnet, or only the owner's phone? | Owner's phone first; add a parent's phone after a trial |
| D8 | Screens: is History behind Today enough, or should it be a 5th tab? | Keep 4 tabs |
| D9 | Go-live: serve real records on the home server | Needs the owner's explicit "go" after the build passes on synthetic fixtures |
