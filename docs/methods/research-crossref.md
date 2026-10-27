---
title: Research cross-reference (method)
audience: agent, engineer
type: how-to
owner: maintainer
last_reviewed: 2026-10-27
review_every: 90d
status: current
sources: [agent-tasks/saturn.research_crossref.yaml, agent-tasks/saturn.research_crossref.output.schema.json, tools/research/verify_citations.py]
generated: false
---

# Research cross-reference

A standard way for an agent (Opus-class, task `saturn.research_crossref`) to set one person's recorded data beside
the medical literature and drug labels, and to turn what it finds into **sourced facts and questions for the
treating doctor**. It is a records task. It is not a clinical review.

**Facts as written; not advice; doctors decide.**

Worked example (fictional person): [examples/2026-10-27-crossref.md](examples/2026-10-27-crossref.md).

## 1. Scope and non-goals

**In scope.** Each item is about recorded facts (KB ids) and says what an authoritative source states about them:
- **associations:** e.g. a recorded condition and a recorded lab trend that a guideline discusses together;
- **interaction and label facts:** what the current labels say about the recorded medicines together, about the
  recorded conditions (contraindications, warnings) and about monitoring;
- **lab interference:** a drug that changes a lab value or its reading (e.g. 5-alpha-reductase inhibitors and
  PSA);
- **monitoring gaps:** a test that a guideline or label sets for a recorded condition or medicine, with no
  matching result in the records in that interval;
- **signals:** a recorded pattern that a source names as worth a clinician's attention.

All of these become **questions for the named clinician**.

**Non-goals.** The method never:
- diagnoses, rules out, or gives a differential;
- suggests starting, stopping, switching or dosing a medicine, or says a medicine is "safe" or "unsafe";
- ranks or judges doctors;
- predicts risk or prognosis for this person;
- triages symptoms (red flags escalate; they are not researched, step 2);
- does a systematic review. The search log follows PRISMA-S so it can be repeated. It does not claim to have
  found every study.

**Why so narrow (asymmetric risk).** A missed association costs little, because the doctor still owns the
care. A
wrong or overconfident statement read by a lay family member can cost a great deal: a medicine stopped, a doctor
distrusted, or care delayed. WHO's guidance on large multi-modal models names automation bias in patients as well as
in professionals [W1], and the FDA's clinical decision support guidance treats automation bias as a key
risk [W2]. The method therefore trades recall for precision and phrasing safety at every step.

## 2. Inputs

Read only from the records repo. Build the KB first (`tools/kb/build --records <dir>`), then query `data/kb.sqlite`.

| Input | Use |
|---|---|
| `records.yaml` | the ns exists; display name for prose only |
| `v_latest`, `v_trend` | recorded lab values and series, flags, ranges, verification (`tools/kb/README.md`) |
| `v_meds_current` | current medicines (generic via `ref:drug`), status and verification. Treat `prescribed`-only lines as "prescribed, not confirmed taken" |
| `fact` kind = condition (active) | recorded conditions, **as a doctor wrote them** (never inferred ones) |
| `v_timeline` | events, admissions, medicine changes, flagged observations, family-reported symptoms |
| `v_conflicts`, `v_needs_human` | conflicting or uncertain inputs. Cite them as uncertain and never build an item on an `uncertain` fact alone |
| `persons.ndjson` | age band and sex for the applicability check (age in years at run date; never the DOB in output) |
| `docs/health/<ns>/questions.md` | open questions (do not duplicate); the next free `<ns>:q:NNNN` |
| `docs/health/<ns>/care-team.md` | which clinician (party ref or role) each question goes to |
| `docs/health/<ns>/research/*-crossref.json` | the previous run, for a revisit (step 10) |
| `config/thresholds.yaml` | red-flag values, if the records owner has set them |

## 3. Procedure

1. **Snapshot.** Record `data_as_of` (latest fact date), the views read and their row counts. Work only on
   `status = active` facts.
2. **Red-flag screen (before any research).** Compare recent readings and symptoms with the red-flag rules
   (section 11 and `config/thresholds.yaml`). On any match, write a `red_flags[]` entry at the top of the output:
   "seek urgent care now / same-day doctor". **Do not research it and do not soften it.** Then continue with
   the rest.
3. **Build the problem list for research.** For each medicine, recorded condition, out-of-range or trending lab,
   and recurrent symptom, write a PICO-style topic: population (age band, sex, recorded conditions), exposure
   (medicine or condition), and outcome (lab, event or symptom). Limit it to the `focus` areas if given. Each topic
   carries the KB ids it comes from.
4. **Label pass (per medicine).** Get the current label for each generic (section 4, tier 1). Extract what it
   says about:
   - boxed warnings;
   - contraindications that match recorded conditions;
   - warnings that match recorded labs or conditions;
   - interactions with other recorded medicines;
   - lab-test interference;
   - recommended monitoring.

   Quote it verbatim and record the section, label revision date and set id. **Leave out dosing text entirely.**
5. **Guideline pass (per condition).** Find the current guideline from the bodies in section 4, tier 2. Check the
   version is the latest (step 10 triggers). Extract the recommendation on monitoring, targets or tests, with its
   number and printed grade, **except for link-only bodies** (section 4): never fetch, quote or summarise their
   recommendations. Cite body, version, recommendation number and URL, and point the clinician to it by name.
6. **Literature pass (only for topics the label and guideline passes leave open).** Search PubMed/Europe PMC
   (section 5). Prefer systematic reviews and meta-analyses, then RCTs, then cohorts. Screen titles and abstracts,
   then fetch the record you cite and quote from it. Log every query (section 9).
7. **Grade** each item (section 6). Use the certainty the source states. Never upgrade, and never invent a grade.
8. **Applicability check** (section 7). Items with `match: poor` are dropped or kept only as an explicit
   limitation.
9. **Write** the items, then the questions (section 10), then the page and sidecar (section 8).
10. **Revisit diff** (if `previous`): mark each item `new`, `unchanged`, `changed` (source version or data
    changed) or `retired` (no longer supported, or the inputs are gone). Never delete old pages. The new run is a
    new dated file.
11. **Verify.** Run
    `python3 -I tools/research/verify_citations.py <sidecar.json> --check-quotes`. Fix every error. If an
    identifier does not resolve or a quote cannot be found, drop the item; never "repair" a citation from memory.
    Record the result in `verifier`.
12. **PR.** Add the page, the sidecar and the new `questions.md` rows. Mark briefs whose inputs changed
    `regenerate: true` only if a question was added to them. The owner reviews (section 13) before merging.

## 4. Source priority

Use the highest tier that answers the question, and say which tier the item came from. Free access is preferred,
and so is label text over interaction databases.

| Tier | Source | Access (checked 27-Oct-2026) | Licence / limits |
|---|---|---|---|
| 1 Labels | **DailyMed** SPL web services `https://dailymed.nlm.nih.gov/dailymed/services/v2/` [S5] | free, no key | US government labels. Attribute NLM; images and trademarks are excepted |
| 1 | **openFDA** `https://api.fda.gov/drug/label.json` [S4] | free; 240/min, 1,000/day per IP without a key; 120,000/day with a key | CC0 unless marked. The API itself says "Do not rely on openFDA to make decisions regarding medical care" |
| 1 | **EMA** EPAR product information (SmPC, PIL) `https://www.ema.europa.eu/en/medicines` [S7] | free, web only | reuse is allowed with EMA credited |
| 1 (India) | **CDSCO** approvals; **Indian Pharmacopoeia** / **National Formulary of India** (IPC) [S8] | CDSCO: PDF approval lists only, no label database or API. IP and NFI are paid (print/online) | the Indian package insert usually cannot be fetched. Use the US/EU label as a proxy, say so, and note that brand, strength and combination products may differ |
| 2 Guidelines, **link-only** | ESC [S13a]; AUA [S13e]; EAU [S13f]; NICE [S13g]; ADA Standards of Care [S13d]; ICMR Standard Treatment Workflows [S13g]; Endocrine Society [S13g] | free to read | **LINK-ONLY: cite and link, never quote or summarise the recommendations.** Output carries body, version, recommendation number (`locator`), URL and no quote. The verifier rejects a quote from these hosts. Terms in the table below |
| 2 Guidelines, quotable | KDIGO [S13c] (kidney); USPSTF [S13h] (screening); ACC/AHA/HFSA [S13b] (not re-checked) | free to read | brief verbatim quote (<= 400 chars), attributed, unaltered, per the edition's notice. Always record the version |

**Link-only terms (checked 27-Oct-2026; re-check at each review, and whenever a body changes its terms).**

| Body | Verdict | Basis |
|---|---|---|
| AUA | link-only | page notice: "You are prohibited from using or uploading content you accessed through this website into external applications ... including those using artificial intelligence ..." (https://www.auanet.org/guidelines-and-quality/guidelines) |
| EAU | link-only | copyright page: use or upload of the Guidelines "and any material derived from these texts (whether in full or in part) on external websites, bots ... software, or external applications" is prohibited without written permission; the EAU/AUA joint position covers AI tools (https://uroweb.org/guidelines/prostate-cancer/chapter/copyright-and-terms-of-use ; https://uroweb.org/eau-guidelines/citing-usage-republication) |
| NICE | link-only | content may not be used in a retrieval system without prior written agreement; AI use is outside the open content licence and needs approval, licence and fee; scraping and training not permitted (https://www.nice.org.uk/terms-and-conditions ; https://www.nice.org.uk/reusing-our-content/nice-uk-open-content-licence) |
| ESC | link-only | licence needed for software or AI use (already link-only) |
| ADA | link-only (stricter than asked) | 2026 Standards notice: no text or data mining, machine learning or similar without prior written permission; separate AI Content Licensing Policy (https://diabetesjournals.org/journals/pages/ada-journal-policies) |
| ICMR STW | link-only (precaution) | STW PDFs: "all rights reserved", no reproduction without permission; site policy is looser but excludes this (https://www.icmr.gov.in/copyright-policy ; https://stw.icmr.org.in/) |
| Endocrine Society | link-only until verified | no AI or reuse terms for the guidelines found; journal reuse via OUP/CCC (https://www.endocrine.org/journals/permissions) |
| KDIGO | quotable, per edition | 2024 CKD, 2025 IgAN, 2026 anaemia: CC BY-NC-ND, noncommercial text and data mining of the unaltered text allowed; 2012 and 2017 editions: all rights reserved, so treat as link-only. Confirm the edition's notice (PDF front matter, https://kdigo.org/guidelines/) |
| USPSTF | quotable | AHRQ notice (Sep-2017): unaltered reuse with attribution; some JAMA-published pages carry an AMA copyright, so check the page (https://www.uspreventiveservicestaskforce.org/uspstf/recommendation-topics/copyright-notice) |

Not fetchable from an agent (HTTP 403/404) on 27-Oct-2026: the NICE and ADA terms pages and the EAU copyright
page were read through search excerpts, not the pages themselves; the owner should open them once.
A journal or PubMed version of a link-only body's guideline is still link-only.

| 3 Syntheses | **Cochrane** reviews (abstracts free) via PubMed; systematic reviews and meta-analyses | free abstracts | abstracts only unless open access |
| 4 Primary studies | **PubMed** via NCBI E-utilities [S1]; **Europe PMC** REST `https://www.ebi.ac.uk/europepmc/webservices/rest/search` [S2] | free. E-utilities: ≤3 requests/s without a key, ≤10/s with `api_key`; send `tool` and `email` (registered with NCBI). Europe PMC: no key; official limits not published, so stay under 3/s | quote only from the abstract, or from the full text if it is open access |
| 4 | **ClinicalTrials.gov API v2** `https://clinicaltrials.gov/api/v2/` [S3] | free, no key; back off on HTTP 429 | context only (ongoing trials). Never a basis for an item on its own |
| — | Interaction checkers (Lexicomp, Micromedex, Medscape, Drugs.com, Stockley's) | proprietary | **do not use or quote.** The free NLM RxNav interaction API was discontinued on about 2-Jan-2024 [S6] (RxNorm itself is still available for name normalisation). Interactions come from label text only |

API keys (NCBI, openFDA) are environment secrets. They are never written to files.

## 5. Query construction

- **Generic clinical terms only.** Never put a name, id, date of birth, date, place, facility, doctor or verbatim
  record text in a query. Queries leave the machine.
- Normalise drug names to the INN/generic through `ref:drug` (RxNorm if needed). Search the generic, never an
  Indian brand.
- PubMed pattern:
  `("<generic>"[tiab] OR "<MeSH>"[MeSH]) AND ("<outcome>"[tiab] OR "<MeSH>"[MeSH])`, plus a design filter:
  - `(systematic[sb] OR meta-analysis[pt])` first;
  - then `randomized controlled trial[pt]`;
  - then cohort terms.

  Add `humans[mh]`, a date window (default the last 10 years, wider when nothing is found) and English. Log the
  exact string and the hit count.
- Europe PMC: the same terms with `SRC:MED` and `PUB_TYPE`. Use it to find open-access full text for a quote.
- Labels: openFDA `search=openfda.generic_name:"<generic>"`, then read the named sections
  (`boxed_warning`, `contraindications`, `warnings_and_cautions`, `drug_interactions`, `laboratory_tests`,
  `drug_and_or_laboratory_test_interactions`). Record `set_id` and `effective_time`.
- Stop when two consecutive higher-tier searches add nothing new, or the budget is half spent.

## 6. Evidence grading

Every item records three things:
- the **design** of the source behind the claim, in this order: guideline > systematic review/meta-analysis > RCT >
  cohort > case-control > case series > expert opinion (with `label` and `reference_text` kept separate);
- the **certainty** the source states, on the GRADE scale (high, moderate, low, very low) [S12];
- `grade_as_printed`: the source's own notation, e.g. KDIGO "1C" or "practice point", or ESC "Class I, Level A".

Map the design to the 2011 Oxford CEBM level (`ocebm`, 1 to 5) for a quick read [S12b].

- Never assign a GRADE rating yourself. If the source states none, write `not_graded`.
- A label statement is `label` / `n/a`. It is a regulatory fact, not a graded finding.
- An ungraded practice point, expert opinion, a single cohort or a case series can support a **question** only.
  It is never framed as "evidence shows".
- Where sources disagree, write `conflict:`, show both, and do not choose (records rule).

## 7. Applicability check

For each item, compare the studied population with the person's recorded facts:
- **age** band;
- **sex**;
- **comorbidity**: recorded conditions, kidney or liver function where relevant, pregnancy;
- **ancestry/region**: many trials under-enrol South Asians, and some thresholds are ancestry-specific (e.g. BMI
  and waist cut-offs, eGFR equations);
- **setting**: Indian availability, brands, fixed-dose combinations, and lab methods and units.

Score each dimension `match` / `differs` / `not_reported` / `unknown`, then give an overall `good` / `partial` /
`poor` / `unknown` with one line of notes. An Indian guideline (ICMR, Indian society) or an Indian cohort is noted
where one exists. Say plainly when only Western data exist.

## 8. Output

Two files in the records repo, plus question rows:

- `docs/health/<ns>/research/YYYY-MM-DD-crossref.md`: the page that people read. It has:
  - front matter (template: `type: reference`, `audience: family, doctor`, `generated: false`, `sources:` the KB
    ids);
  - the disclaimer line;
  - **Red flags** (if any);
  - **Summary**: at most 5 lines;
  - a table per item type (statement, person's facts with KB ids, source with quote, evidence, applicability,
    clinician, question id);
  - **Questions for the doctor**;
  - **Limitations**;
  - **Search log**;
  - **Revisit**.
- `docs/health/<ns>/research/YYYY-MM-DD-crossref.json`: the sidecar, valid against
  [`saturn.research_crossref.output.schema.json`](../../agent-tasks/saturn.research_crossref.output.schema.json).
  The verifier reads it.
- New rows in `docs/health/<ns>/questions.md`, with the next free ids. The cross-reference never keeps its own
  question list.

Item fields (schema): `id` (rx-NNN), `type`, `statement`, `kb_ids`, `evidence {design, certainty, grade_as_printed,
ocebm}`, `applicability`, `citations[] {source_type, pmid|doi|url, title, version, locator, quote (omitted for link-only bodies), accessed}`,
`for_clinician`, `question_ids`, `status` (revisit), `verification`.

## 9. Phrasing rules

| Do | Never |
|---|---|
| "The current dutasteride label states: '…'" | "Dutasteride lowers your PSA, so your result is fine" |
| "A 2024 guideline recommends testing X in people with Y (practice point 1.1.1.1)" | "You need test X" / "You should …" |
| "is associated with", "was reported in", "the label lists" | "causes", "is due to", "because of" |
| "No X result is recorded since <date>" | "X was not done" (the records may be incomplete) |
| "Question for <clinician role>: …?" | "Ask to stop / reduce / switch …" or any dose |
| "Studied in men aged 50 to 75; applicability partial" | presenting a trial result as this person's risk |

- Tag who said what: document, doctor-written, label, guideline or agent-inferred. Mark any agent inference as
  such, and never present it as a fact.
- Questions are open and neutral. They name the clinician (a party ref or role), cite the item ids, and leave
  the decision to the doctor:
  "Dr <role>: given rx-002, is a urine albumin test due?". Never "should I stop …?".
- No numbers that the person could act on alone: no doses, titration steps or "safe" thresholds.
- `verify_citations.py` rejects the commonest violations (dose-change verbs near medicine words, "you should",
  diagnosis in the agent's voice, "caused by", "safe to take"). The reviewer checks the rest.

## 10. Questions

One question per decision, at most 10 per run, sorted by priority (`next-visit` / `routine`). Before adding one,
search `questions.md` for an open question on the same topic. If one exists, add the new item ids to it in the PR
note instead of opening a duplicate.

## 11. Red-flag escalation

Red flags are **not research topics**. Check them in step 2 against recorded readings and symptoms, using the records
repo's `config/thresholds.yaml` where it is set and the generic list below otherwise. Write each match as:
"**Seek urgent care now** (emergency number / nearest emergency department)" or "**same-day doctor contact**". Each
entry cites its KB ids. The page opens with it, and the PR title says `RED FLAG`.

Generic list (examples of the common patient-facing red flags, not exhaustive, not thresholds):
- chest pain or pressure;
- new breathlessness at rest;
- fainting;
- signs of stroke (face, arm, speech);
- confusion;
- vomiting or passing blood;
- black stools;
- severe abdominal pain;
- no urine output, or being unable to pass urine;
- a fall with head injury on a blood thinner;
- low oxygen saturation, or very high or very low blood pressure or pulse, as set by the person's doctor in
  thresholds.

Records written days ago may be stale, so the entry says "recorded on <date>; if this is happening now, seek care
now". Red flags are never researched, softened or set beside literature.

## 12. Search log (reproducibility)

Follow PRISMA-S [S11b]. Each search records:
- the timestamp (IST);
- the source;
- the exact query or URL;
- the filters;
- the hits, the number screened and the number kept;
- notes (e.g. "abstract only", "licence: link only").

The search is reported transparently in the spirit of PRISMA 2020 [S11a], but the cross-reference is **not** a
systematic review and says so.

AI use follows the Cochrane, Campbell, JBI and CEE joint position (2025) [S10]:
- humans stay accountable;
- AI output is checked by a human before use;
- the AI's role is disclosed. Every page says "Prepared by an AI agent (model, date); citations machine-checked;
  reviewed by <owner> on <date>".

**Hallucination controls:**
1. Every claim carries a PMID, DOI or URL and a verbatim quote (link-only bodies: a locator and no quote).
2. The verifier resolves every PMID (esummary; the title must match), DOI (doi.org) and URL. With
   `--check-quotes` it also confirms the quote appears in the PubMed abstract or the fetched page.
3. Nothing is cited from model memory.
4. An unresolvable citation means the item is dropped, never repaired.

## 13. Revisit triggers and cadence

A new run is a new dated file with `previous:` set. Old files are never edited (append-only log rule).

| Trigger | Scope |
|---|---|
| New lab result on a code that an item cites, or a new out-of-range value | items on that code, plus monitoring gaps |
| New medicine, or a stopped or changed medicine | label pass for it, plus interactions with every current medicine |
| New doctor-written condition | guideline pass for it |
| New major guideline version or focused update (e.g. ESC heart failure 2026 replacing 2021/2023; EAU LUTS 2026; ADA's yearly Standards in December) | items that cite the old version |
| A label safety update (DailyMed revision or boxed warning) for a current medicine | that medicine |
| **Every 6 months**, scheduled | full run |
| On request (`reason: on-request`) | the named focus |

The run records `revisit.next_due` (the run date plus 6 months) and the triggers it watches.

## 14. Reviewer checklist (the owner, before merging)

- [ ] Red flags, if any, are at the top, plain, and were acted on outside the PR.
- [ ] The verifier shows 0 errors; each warning has been checked by hand (open the link and find the quote).
- [ ] Every item cites the person's KB ids, and those facts say what the item claims (open two at random).
- [ ] No diagnosis, no causation, no dose or medicine-change wording, no "you should".
- [ ] Grades are the source's own, and nothing weaker than a guideline or systematic review is framed as
      established.
- [ ] Applicability is stated; Western-only evidence is named as such.
- [ ] Guideline versions are current, and licence-restricted text is not pasted.
- [ ] Questions are neutral, name a clinician, carry new ids, and do not duplicate open ones.
- [ ] The search log is complete, and the queries contain no names, ids, dates or places.
- [ ] The page carries "Facts as written; not advice; doctors decide." and the AI-use line.

## References (accessed 27-Oct-2026)

- [S1] NCBI E-utilities usage (rate limits, `tool`/`email`/`api_key`): https://www.ncbi.nlm.nih.gov/books/NBK25497/
- [S2] Europe PMC REST API: https://europepmc.org/RestfulWebService
- [S3] ClinicalTrials.gov API v2: https://clinicaltrials.gov/data-api/api
- [S4] openFDA authentication and limits: https://open.fda.gov/apis/authentication/ ; drug label:
  https://open.fda.gov/apis/drug/label/ ; terms: https://open.fda.gov/terms/
- [S5] DailyMed web services: https://dailymed.nlm.nih.gov/dailymed/app-support-web-services.cfm ; NLM reuse:
  https://www.nlm.nih.gov/web_policies.html
- [S6] RxNav interaction API discontinuation: https://lhncbc.nlm.nih.gov/RxNav/news/APIUpdate.html
- [S7] EMA medicines and legal notice: https://www.ema.europa.eu/en/medicines ;
  https://www.ema.europa.eu/en/about-us/legal-notice
- [S8] CDSCO: https://cdsco.gov.in ; National Formulary of India: https://ipc.gov.in/mandates/nfi/about-nfi.html
- [S10] Cochrane, Campbell, JBI and CEE position statement on AI in evidence synthesis (2025), doi
  10.1002/14651858.ED000178: https://pmc.ncbi.nlm.nih.gov/articles/PMC12594113/
- [S11a] PRISMA 2020, BMJ 2021;372:n71, doi 10.1136/bmj.n71: https://www.prisma-statement.org/
- [S11b] PRISMA-S, Syst Rev 2021;10:39, doi 10.1186/s13643-020-01542-z
- [S12] GRADE handbook: https://gdt.gradepro.org/app/handbook/handbook.html ; [S12b] OCEBM 2011 levels:
  https://www.cebm.ox.ac.uk/resources/levels-of-evidence/ocebm-levels-of-evidence
- [S13a] ESC heart failure guidelines (2026 edition; LINK-ONLY):
  https://www.escardio.org/guidelines/clinical-practice-guidelines/acute-and-chronic-heart-failure/
- [S13b] ACC/AHA/HFSA 2022 heart failure guideline, doi 10.1161/CIR.0000000000001063: https://hfsa.org/HFGuidelines
- [S13c] KDIGO 2024 CKD guideline, doi 10.1016/j.kint.2023.10.018:
  https://kdigo.org/guidelines/ckd-evaluation-and-management/
- [S13d] ADA Standards of Care in Diabetes 2026: https://diabetesjournals.org/care/issue/49/Supplement_1
- [S13e] AUA BPH guideline (2023 amendment):
  https://www.auanet.org/guidelines/guidelines/benign-prostatic-hyperplasia-(bph)-guideline
- [S13f] EAU non-neurogenic male LUTS (2026): https://uroweb.org/guidelines/management-of-non-neurogenic-male-luts
- [S13g] Endocrine Society: https://www.endocrine.org/clinical-practice-guidelines ; NICE:
  https://www.nice.org.uk/guidance ; ICMR Standard Treatment Workflows: https://stw.icmr.org.in/
- [S13h] USPSTF prostate cancer screening (2018; update in progress):
  https://www.uspreventiveservicestaskforce.org/uspstf/recommendation/prostate-cancer-screening
- [W1] WHO, Ethics and governance of AI for health: guidance on large multi-modal models (2024):
  https://www.who.int/publications/i/item/9789240084759
- [W2] FDA, Clinical Decision Support Software guidance (2022, reissued Jan-2026; automation bias):
  https://www.fda.gov/regulatory-information/search-fda-guidance-documents/clinical-decision-support-software
