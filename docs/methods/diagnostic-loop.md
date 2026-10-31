---
title: "Diagnostic loop (method): iterative, evidence-linked reasoning on open problems"
audience: agent, maintainer
type: how-to
owner: maintainer
last_reviewed: 2026-10-31
review_every: 90d
status: proposed
sources: [docs/decisions/013-diagnostic-loop.md, docs/decisions/012-continuous-crossref.md, docs/design/continuous-crossref.md, docs/design/health-profile.md, docs/methods/research-crossref.md, docs/records-guide.md]
generated: false
---

# Diagnostic loop (method)

**Facts as written; not advice; doctors decide.**

Decision record: [ADR 013](../decisions/013-diagnostic-loop.md) (proposed). Ready-to-paste run prompt:
[diagnostic-loop-run-prompt.md](diagnostic-loop-run-prompt.md).

## 0. What this is, and the mode it needs

Saturn's prime method ("MO"). Agents act as a constant reasoning partner on a person's **open, unexplained
problems**. They do five things on every run:

1. Keep a ledger of the problems.
2. Reason about each problem as a differential with explicit probabilities, cited to the records and the literature.
3. Choose the next steps that would best tell the hypotheses apart.
4. Turn those steps into actions for the caretaker and a one-page packet for the doctor.
5. Re-run when new data arrives and say what moved.

Predictions are logged and later scored against what doctors and tests find, so the system learns how well
calibrated it is.

The deterministic checks of [ADR 012](../decisions/012-continuous-crossref.md) (iteration 1) stay. Their role is
**hygiene and inputs**: they make sure the data the loop reasons on is correct, current and consistent. Those checks
do not try to explain anything. This loop does.

**Mode.** The product's default is still "record and flag only" ([records-guide](../records-guide.md) §0). The loop runs
only in a records repo whose `AGENTS.md` sets **interpretation allowed**: agent-inferred, labelled, with confidence and
citations, and kept out of KB facts. In every mode, the rule on medicines stays absolute. **Never suggest starting,
stopping or changing a medicine or dose.** Medicine points are written as questions for the named doctor.

## 1. Why: what the evidence says (research summary)

Every result is tagged **V** (verified against the abstract or official text, 31-Oct-2026), **P** (partial: some
numbers came only from secondary reports) or **U** (unverified). Full references are at the end.

### 1.1 LLMs on hard diagnostic cases

| Study | Setting | Result | Tag |
|---|---|---|---|
| Kanjee, Crowe, Rodman, JAMA 2023 [D1] | GPT-4, 70 NEJM clinicopathological conference (CPC) cases | correct diagnosis ranked first in **39%**; anywhere in the differential in **64%** | V |
| McDuff et al., Nature 2025 (AMIE differential) [D2] | 302 NEJM CPCs, 20 clinicians | top-10 accuracy: AMIE alone **59.1%**, clinicians unassisted **33.6%**; clinicians with AMIE **51.7%**, clinicians with search **36.1%** | V (assisted figures P) |
| Tu et al., Nature 2025 (AMIE dialogue) [D3] | randomised, blinded text-chat OSCE, 159 scenarios, 20 primary-care doctors | AMIE had higher diagnostic accuracy, and did better on 28 of 32 specialist-rated axes | V |
| Nori et al., arXiv 2025 (MAI-DxO, SDBench) [D4] | 304 NEJM CPCs posed step by step (ask questions, order tests, at a cost) | physicians **19.9%** at $2,963 per case; o3 alone 78.6% at $7,850; MAI-DxO with a budget **79.9% at $2,397**; MAI-DxO ensemble 85.5% | V (preprint) |
| Brodeur, Rodman, Manrai et al. [D5] | o1 on CPCs and on 76 real emergency department cases | diagnosis in the differential 78.3%; at emergency triage 67.1% vs 50–55% for physicians; **probabilistic reasoning no better than older models** | P (reported in Science 2026) |
| Goh et al., JAMA Netw Open 2024 (RCT) [D6] | 50 physicians, with or without GPT-4 | **no significant gain** in diagnostic reasoning (76% vs 74%, P=.60); **LLM alone scored 16 points higher** than the physicians using conventional resources | V |
| Goh et al., Nature Medicine 2025 (RCT) [D7] | 92 physicians, management reasoning | GPT-4 assistance **+6.5 points**; GPT-4 alone about equal to physicians with GPT-4 | V |
| DeepRare, Nature 2026 [D8] | agentic rare-disease system with traceable reasoning, 2,919 diseases | Recall@1 **57.2%** from phenotype alone (23.8 points above the next best method); experts agreed with **95.4%** of its reasoning chains | V |

**What this means for the method.**
- On hard, complete case write-ups, frontier models put the right diagnosis in a top-10 list more often than not.
  They rank it first much less often.
- Simply handing a doctor a chatbot does not reliably help ([D6]). The value comes from **structure**: sequential
  questioning, choosing tests with their cost in mind, ensembles, and output a person can audit ([D4][D8]).
- Saturn's case differs from those benchmarks in ways that cut both ways. The data are **incomplete, noisy and
  partly family-reported**, which is worse than a CPC write-up. But the data **accumulate over months**, which
  allows real iteration.

### 1.2 Where models fail (and what the loop must guard against)

| Failure | Evidence | Guard in this method |
|---|---|---|
| Sensitive to the **order and amount** of information; does not follow guidelines; reads labs poorly | Hager et al., Nature Medicine 2024: on 2,400 real cases, models were worse than physicians and answers changed with the order of information [F1] V | a fixed evidence-pack order; several independent agents given different orderings and framings; labs passed in as computed tables, never prose |
| **Anchoring and framing** on a label already written | BiasMedQA: accuracy fell when cognitive-bias cues were added [F2] V | one differential agent is **blinded to doctors' labels**; the reviewer runs a bias checklist |
| **Sycophancy** (goes along with the user's premise) | Chen et al., npj Digit Med 2025: up to 100% compliance with illogical drug requests; explicitly allowing refusal helped [F3] V | the prompt says the owner's hypothesis is one hypothesis among others; agents are told to disagree with evidence |
| **Fabricated or unsupported citations** | Walters & Wilder 2023: 18% of GPT-4 references fabricated [F4] V. SourceCheckup 2025: 50–90% of LLM answers not fully supported by the sources they cite [F5] V | a **citation verifier** (§5) resolves every DOI or PMID and checks the cited text supports the claim; anything unverified is marked U or dropped |
| **Overconfidence and poor calibration** | stated confidence 90–100 across the board on USMLE-style questions [F6] P; no gain in probabilistic reasoning [D5] P | probabilities come in buckets with a residual "something else" share; predictions are logged and scored (§4 step 9); the synthesiser explains each probability |
| **Automation bias** in the human reader | wrong AI advice lowered radiologists' accuracy, e.g. inexperienced readers 79.7% → 19.8% [S1] V; a systematically biased model cut clinician accuracy by 11.3 points, and explanations did not fix it [S2] V; review of 74 studies [S3] V | outputs are questions and observations, never verdicts; uncertainty is shown; red flags are handled outside the loop; a human reviews before anything is shared |

### 1.3 Techniques that measurably help

- **Ensembles and structured prompting.** Medprompt (ensembling plus chain of thought) took GPT-4 past 90% on MedQA
  [T1] V.
- **Multi-agent work with a moderator or reviewer.** MDAgents: adding moderator review plus outside knowledge raised
  accuracy by 11.8% on average [T2] V. A multi-agent conversation on 302 rare-disease cases beat single models [T3] P.
- **Sequential, cost-aware test selection.** MAI-DxO kept its accuracy at about half the cost of physicians [D4] V.
- **Retrieval with citations.** MedRAG: up to 18% better than chain of thought alone, with a "lost in the middle"
  effect (material in the middle of a long context gets missed) [T4] V. Almanac gave better factuality and citations
  [T5] P.
- **Clinical-reasoning prompts, including Bayesian ones.** They do not lose accuracy and they make the reasoning
  auditable. They did not beat plain chain of thought [T6] V. Use them for transparency, not as a source of accuracy.
- **Traceable reasoning chains** that experts can check [D8] V.

### 1.4 Diagnostic reasoning methods from medicine that agents can follow

- **Scale of the problem.** Most people will experience at least one diagnostic error in their lifetime [M1] V.
  - Outpatient diagnostic error affects about **5%** of US adults a year [M2] V.
  - Vascular events, infections and cancers account for most serious harms [M3] V.
  - Premature closure was the most common cognitive cause in a classic series of 100 errors [M4] V.
- **Methods:**
  - problem representation (a one-sentence summary using descriptive qualifiers);
  - illness scripts;
  - a differential with pretest probabilities, updated by likelihood ratios;
  - a "can't-miss" list;
  - a **diagnostic time-out** and checklists [M5] V.
  - Caveat: evidence that teaching people to debias reduces error is weak [M6] V. That is one reason this method puts
    the checklist into a separate reviewer agent rather than trusting a single reasoner to check itself.
- **Undiagnosed-disease programmes.** The NIH Undiagnosed Diseases Network diagnosed **35%** of fully evaluated
  patients; 74% of those diagnoses came from exome or genome sequencing and 11% from clinical review alone [M7] V.
  Its structure is a useful template:
  - a full records pull;
  - a phenotype summary;
  - multispecialty review;
  - targeted testing;
  - re-analysis as knowledge grows.
- **Diagnostic odysseys.** People with rare diseases waited a mean of **4.7 years** for a diagnosis. The number of
  professionals consulted was a strong driver of delay [M8] V. Crowdsourced second opinions (CrowdMed) were rated
  useful by most users, but their accuracy could not be measured [M9] V.

### 1.5 Patient-generated data

- **Symptom diaries.** Their value is highest when the record is made **during** the episode.
  - In ambulatory rhythm monitoring, symptom-rhythm correlation depends on symptoms happening while a recording
    exists.
  - Patient-activated and smartphone recorders reached 85–98% correlation in small studies [P1] P. Conventional
    Holter monitoring did poorly when symptoms were not daily [P1] P.
  - Lesson for the loop: **timestamp + what you felt + a reading taken at that moment** beats recall days later.
- **Pain characterisation.** SOCRATES (site, onset, character, radiation, associations, time course,
  exacerbating/relieving factors, severity) and OPQRST are standard teaching mnemonics. They are used here because
  they make episodes comparable (U as a cited source; standard curricula).
- **Free text and voice.** See [health-profile design](../design/health-profile.md) §2.4:
  - keep a verbatim span for every extracted symptom;
  - keep pertinent negatives;
  - record the experiencer (who the symptom belongs to).

### 1.6 Safety, people, regulation

- **Symptom checkers** (no LLM): correct diagnosis listed first in 34% of cases, triage correct in 57% [S4] V. A later
  review found primary diagnosis correct in 19–36% [S5] V. Triage is where lay-facing tools fail. That is why red
  flags in this method are rules, not reasoning.
- **Communicating uncertainty** does not necessarily reduce trust [S6] V. Natural frequencies ("about 2 in 10") are
  easier for lay readers (U as a cited source here).
- **Patients bringing outside information to doctors** can help the relationship, depending on how it is raised
  [S7] P. Evidence on doctors' reactions to AI analyses brought by families is still thin (U). The method assumes:
  - short, prioritised and question-framed material is welcome;
  - verdicts and long printouts are not.
- **Regulation (not legal advice).**
  - **US.** Under the FDA CDS guidance (2022; revised January 2026 [R1] P), the non-device exemption covers software
    for **health-care professionals**. Patient- or caregiver-facing, patient-specific diagnostic output does not get
    that exemption.
  - **India.** Since 1-Apr-2020, software intended for diagnosis is a medical device under the Medical Devices Rules
    [R2] V. CDSCO published draft guidance on medical-device software on 21-Oct-2025 [R3] P. ICMR's 2023 ethical
    guidelines for AI apply [R4] V.
  - **Saturn's position.** Saturn is a private family tool, not marketed, and every interpretive output is addressed
    to the treating doctor as questions. Publishing the product with this mode switched on by default would change
    that reading (ADR 013).

## 2. Principles

1. **Red flags first, outside the loop.** Every run starts with the red-flag screen
   ([research-crossref](research-crossref.md) §11, `config/thresholds.yaml`). A red flag is written as "seek urgent
   care now" or "same-day doctor contact". It is never researched, softened, or put inside a differential.
2. **Open, not closed.** Every problem keeps a residual "something not yet considered" share and an "artefact or
   record error" hypothesis. A hypothesis is dropped only when the evidence against it is cited.
3. **Documents over recollection** ([records-guide](../records-guide.md) §6). A memory is a lead to verify. Every
   premise cites a KB id, or a source path and page.
4. **Calibrated, not confident.** Numbers come with buckets and reasons. A prediction is logged before the answer is
   known.
5. **Discriminate, don't accumulate.** Each next step must say which hypotheses it would separate, and how.
6. **No medicine changes.** Medicine points become questions, quoting labels and guidelines under the licence rules of
   [research-crossref](research-crossref.md) §4.
7. **Quiet.** One run gives one belief diff, at most 5 questions for the doctor and at most 5 caretaker actions.
   Precision beats recall. Alert fatigue is the failure mode of continuous systems (ADR 012).

## 3. Where outputs live (records repo; all PHI)

Loop 0 uses only existing places. No new list of questions or to-dos is created (records rule).

| Output | Path | Notes |
|---|---|---|
| Run note (ledger, representations, differentials, belief diff, predictions) | `docs/log/analysis/YYYY-MM-DD-<ns>-dx-loop-NN.md` | append-only, like every log note; the latest run's ledger is the current state |
| Predictions log | `docs/log/analysis/dx/<ns>-predictions.ndjson` | one row per prediction (§4 step 9); later superseded by `dx/` rows (iteration 3) |
| Questions for doctors | `docs/health/<ns>/questions.md` (new `<ns>:q:NNNN`, or new item ids added to an existing question) | priority now / next visit |
| Caretaker actions | `docs/health/family/actions.md` (`family:act:NNNN`) | observation tasks, records to fetch, when to escalate |
| Doctor packet | `docs/health/<ns>/briefs/YYYY-MM-DD-dx-packet-<specialty>.md` | one page; regenerated within 48 h before a visit |
| Family-simple summary | the run note's §F, which the owner forwards or reads out | plain language, no probabilities beyond "likely / possible / less likely" |

Ids: open problems take `<ns>:dx:NNNN` (a docs-register class like `q`/`act`, proposed in ADR 013). Hypotheses are
`<ns>:dx:NNNN.hK`. Ids are stable and never reused, so belief diffs can track them across runs.

## 4. The loop (one run)

Steps 0–2 are deterministic or close to it. Steps 3–6 are the reasoning. Steps 7–9 are output and learning.

**Step 0. Red-flag screen.** Check the newest readings, symptoms and voice notes against the red-flag rules. Any hit
goes at the top of the run note and is DMed to the owner first. Then continue.

**Step 1. Evidence pack.** Build a fixed-order pack:
1. who the person is (age band, sex);
2. the problems doctors have written;
3. medicines (status as recorded);
4. a dated timeline of events and episodes;
5. lab and vital trends (computed tables from `v_trend`, home series);
6. imaging and test reports, quoted;
7. family- and patient-reported items, tagged;
8. open hard reads and conflicts;
9. ADR 012 flags and claims;
10. what changed since the last run.

Hygiene checks (ADR 012) run first. A fact with an open hard read or low confidence can **inform** a hypothesis but
can never **decide** one.

**Step 2. Open-problem ledger.** List every problem that is unexplained, contested or under-specified, with:
- id;
- one-line statement;
- why it is open (no cause documented / sources disagree / symptom not characterised);
- the stakes (`can't-miss` / `quality-of-life` / `housekeeping`);
- date first recorded;
- status (`open`, `narrowing`, `explained-by-doctor`, `parked`).

A problem is closed only by a doctor's documented explanation, and even then it is kept as `explained-by-doctor` with
the source.

**Step 3. Problem representation.** One or two sentences per problem, using semantic qualifiers:
- acute / subacute / chronic;
- episodic / constant;
- focal / diffuse;
- left / right / bilateral;
- exertional / at rest;
- the key positives and pertinent negatives, each with its id.

Write down **discrepancies** explicitly (for example, symptom side vs lesion side; timing vs exposure). Discrepancies
are often the most informative facts.

**Step 4. Differential per problem.** For each hypothesis `hK`:

| Field | Content |
|---|---|
| name | the condition or mechanism, in plain words + the medical term |
| illness script fit | the typical picture in 1–2 lines (literature-cited) and where this person fits or departs |
| evidence for / against | KB ids or source path + page, verbatim for values; tagged by who said it |
| probability | a bucket (`>50%`, `20–50%`, `5–20%`, `<5%`) plus a point estimate, with a one-line reason; the set of hypotheses + residual adds up to 100% |
| can't-miss | yes/no; a can't-miss hypothesis stays visible at any probability until it is excluded by a cited test |
| what would raise / lower it | the specific finding, test or observation, ideally with a published likelihood ratio (cite it, or mark it U) |
| citations | literature that supports the script and any likelihood ratio (§5 verifier) |

Always include the hypotheses "two problems, not one" and "artefact or record error" when the facts allow them.

**Step 5. Independence, adversarial review, verification** (§5 architecture). Then synthesis: merge the independent
differentials, show where the agents disagreed, and settle the probabilities with reasons.

**Step 6. Discriminating next steps.** Rank candidate steps by **how much they would shift the leading hypotheses**,
weighed against burden (cost, travel, risk, stress, wait). Cheap and informative steps come first. They are often:
- **fetching an existing record** (old reports, discharge summaries, the original images);
- **a structured home observation** of the next episode (§6);
- **a question the doctor can answer from memory or notes**.

Tests are phrased as "would test X help distinguish A from B?" for the doctor. Each step names the hypotheses it
separates.

**Step 7. Belief diff** (every run after the first). For each problem:
- what moved;
- by how much;
- **because of which new id**;
- what did not move despite new data, and why.

New problems added, problems parked. One table, then three sentences.

**Step 8. Outputs** (§7): caretaker actions, doctor packet, family summary, questions. Human review point: the owner
reads the run note before anything goes to a doctor or the wider family.

**Step 9. Predictions and scoring.** For each testable expectation, log one row:
- `id`;
- `made_at`;
- `problem`;
- `hypothesis`;
- `statement` ("the next echo will show X", "a monitor worn during an episode will show Y");
- `p`;
- `resolves_by` (event or date);
- `resolution_source` (which document would settle it).

When a later document settles it, append a resolution row with the source id. Track:
- the **Brier score** and a calibration table per bucket;
- the share of resolved predictions;
- how often the eventual doctor diagnosis was in the run's top 3 / top 10 at the time (the CPC-style metric of
  [D1][D2]).

These are the loop's accuracy measures. Static checks cannot produce them.

**Re-run triggers.**
- A new source or fact touching a problem's evidence ids (after the daily batch).
- A doctor's answer or visit.
- An episode capture (§6).
- A prediction's resolution date passing.
- On request.

Event-driven runs are **delta runs**: only the problems touched, plus the reviewer. A full run happens weekly while
problems are active, and monthly otherwise.

### 4.1 Diagnostic time-out (reviewer checklist)

The reviewer answers each item in writing, for each problem:
- What else could this be? Did we name at least one can't-miss alternative?
- Did we anchor on the first label a doctor wrote, or on the owner's hypothesis?
- Which findings do **not** fit the leading hypothesis? Have we explained them, or explained them away?
- Could two conditions be present? Could a medicine, an artefact or a recording error explain it?
- Are we relying on a family recollection that no document supports?
- Is any probability stated with more confidence than the evidence carries?
- Is any wording a verdict, a reassurance or a medicine instruction? (The verifier word list, research-crossref §9.)

## 5. Agent architecture

| Role | Model / effort | Sees | Produces | Why |
|---|---|---|---|---|
| **Orchestrator** (the owner's "doctor" session, later a `hl` task) | Opus 5.5, high | everything | the evidence pack, dispatch, the run note | single writer; follows this method |
| **Differential agents ×3, independent** | Opus 5.5, high | the same pack, in different orders and framings: **A** systems sweep (organ system by organ system); **B** timeline and mechanism first; **C** blinded to doctors' diagnostic labels and the owner's hypotheses (facts, readings and findings only) | per-problem differentials (§4 step 4), with no sight of each other | ensembles and independence reduce order and framing effects [T1][T2][F1][F2] |
| **Adversarial reviewer** | Opus 5.5, high | the pack + all three differentials | the time-out checklist (§4.1); missed can't-miss items; overconfidence; unsupported premises | a separate critic catches what self-review misses [T2][M6] |
| **Citation verifier** | Sonnet 5.5, medium, with web access to PubMed / DOI / DailyMed (public mode: generic queries only) | claims + citations; KB ids | resolves each DOI or PMID, checks that the cited text supports the statement, checks KB ids exist and quotes match, enforces the licence rules (research-crossref §4) | fabricated or unsupported citations are common [F4][F5] |
| **Synthesiser** | Opus 5.5, high | all of the above | merged differential with probabilities and disagreement, next steps, belief diff, predictions, outputs | one voice, with explicit uncertainty |

**Literature queries never carry PHI.** They use generic terms only: condition, finding, drug INN. They never include
names, dates, places or verbatim record text (research-crossref §5; ADR 012 split fetch).

**Cost per run** (API list prices checked 31-Oct-2026: Opus 5.5 $4 / $20 per million input / output tokens, cache
reads $0.20; Sonnet 5.5 $2 / $10). An evidence pack of about 80–120k tokens is shared by five calls (caching the pack
cuts repeat input):
- **Full run:** about **$4–8**.
- **Delta run** (1–2 problems, reviewer, verifier): about **$1–3**.
- **Steady state:** weekly full runs plus about 3 delta runs a week come to about **$30–60 a month**. The owner sets
  the cap (ADR 013). It is separate from the ADR 012 L2 cap.
- **Owner-session runs** (Claude Code on the owner's Mac) use the owner's plan, not API billing.

**Where it runs.**
- **Now:** the owner's Claude Code session in the records repo checkout on the owner's Mac. Subagents provide the
  independent agents. Outputs are commits or PRs in the records repo.
- **Later:** a `saturn.dx_loop` task pack for the egress-locked PHI user `hl` on the home server, using the ADR 012
  split fetch for literature, triggered by the batch's "facts touching an open problem" diff, with per-run and
  per-month budgets and `git_pr` delivery. The go-live gate applies: no deployment runs it on real data until the
  owner says "go".

**How the "doctor" chat session uses it.** The owner's doctor session is the orchestrator and the place to ask
questions. Typical requests:
- "run loop 0";
- "new data arrived: delta run";
- "prepare the packet for Tuesday's cardiology visit";
- "what would change your mind on problem 2?"

It answers from the latest run note and cites ids, and it never re-derives the case from memory.

## 6. Data capture that serves diagnosis

**Quick wins with the existing Telegram flow** (no code needed):
- A pinned **episode card** in the group, which a family member follows in a voice note. The batch already keeps voice
  notes verbatim with timestamps.
- The owner tags it in the DM ("episode") so the next run treats it as an episode.

**Episode card (SOCRATES + context), for a voice note during or right after an episode:**
1. **Safety first:** if any red-flag sign is present (chest pain or pressure, breathlessness at rest, fainting, new
   weakness, face droop or speech trouble, confusion), **call emergency services first and record later**.
2. **When:** the time it started; is it still going on; how long it lasted.
3. **Where:** point to it and **name the side out loud** ("left arm", "right side of chest"); does it spread anywhere.
4. **What it feels like:** in the person's own words (pressing, burning, stabbing, tingling, numb, cramp, heavy).
5. **How bad:** 0 to 10, and whether it stopped what they were doing.
6. **What they were doing:** walking, climbing, resting, lying down, after food, after waking, under stress.
7. **Anything else at the same time:** sweating, breathlessness, palpitations, nausea, dizziness, weakness, numbness,
   speech or vision change, headache; say also what was **not** there.
8. **What made it better or worse:** rest, position, movement, pressing on it, food, a medicine already prescribed
   for it (record only).
9. **A reading at the time**, if the home device is at hand and it is safe: BP and pulse (and SpO2 if available), with
   a photo of the screen.
10. **Medicines taken in the last 6 hours** (as taken; never change anything because of an episode).

**Between episodes:** keep the usual daily readings. Add a one-line voice note "no episode today", or "episode: see
card". Pertinent negatives are data.

**Discrepancy capture:** when the side or place of a symptom differs between sources, record a short video of the
person pointing to, or moving, the affected part. Name the side aloud.

**Later iterations** turn the card into structured fields:
- `event` facts with `data.type = symptom-episode` and the SOCRATES fields;
- each field carrying a verbatim span from the transcript (health-profile §2.4).

## 7. Outputs per audience

**Caretaker action list (weekly, at most 5 items).**
- What to watch, and how to record it (§6).
- Which records to fetch.
- Which appointment to book or ask about.
- The escalation rule in plain words: "**If X, call emergency services now. If Y, call the doctor today.**"

No medicine instructions.

**Doctor packet (one page, per specialty and visit).**
1. Header: the person, the purpose, "prepared by family with AI assistance; agent-inferred items are labelled".
2. Up to 3 open problems, each as:
   - the problem representation;
   - the top hypotheses, with buckets and the key evidence ids;
   - **the discriminating ask**: one test or one question.
3. Discrepancies we noticed.
4. What we are recording at home.
5. A link to the full run note on request.

Hypotheses are framed as "we wondered whether…; is that worth considering?". Never "the AI thinks you missed…".

**Family-simple summary (half a page).**
- What we know.
- What we don't know yet.
- What we are doing about it.
- When to get help urgently.

Words, not numbers: "likely / possible / less likely". No new alarms without a step to take.

## 8. Safety rails (all mandatory)

1. **Red-flag escalation first** (§2.1). Red flags are never suppressed, researched or softened.
2. **No medicine changes.** The verifier word list (research-crossref §9) runs on every output. Medicine points are
   questions to the named doctor.
3. **Uncertainty language.** Always use a bucket and a residual. Never "rules out", "confirms" or "nothing to worry
   about" in the agent's voice. Never false reassurance: when a can't-miss hypothesis is not excluded by a cited test,
   say so.
4. **Evidence links are mandatory.** A statement with no KB id, source path or verified citation is deleted, or
   marked U and kept out of the packet.
5. **Interpretation stays out of KB facts.** It lives only in run notes, briefs and questions, labelled
   `agent-inferred` with the model and the date.
6. **Human review points.** The owner reviews:
   - every run note before outputs leave the records repo;
   - every doctor packet before it is printed or sent.

   The owner can veto any item.
7. **Off-switch.** Set the records repo's `AGENTS.md` mode back to "record and flag only". Runs stop, and the history
   stays.
8. **No PHI in the product or in queries** (records-guide §10).

## 9. Metrics

- **Calibration** (Brier score; observed vs stated per bucket) once at least 10 predictions have resolved.
- **Top-k capture:** the doctor's eventual diagnosis was in the run's top 3 / top 10 when it was made.
- **Time to a discriminating answer:** from a step proposed to its result recorded.
- **Doctor reception:** the owner logs per visit whether the packet was used, ignored or unwelcome.
- **Reviewer catches per run.**
- **Verifier error rate:** citations dropped.
- **Cost per run.**

Stop or retune if, after 6 weeks, no next step has produced a discriminating answer, or doctors find the packets
unwelcome twice.

## 10. Iteration plan (quick return first)

| Loop | Scope | Effort | Return |
|---|---|---|---|
| **0 (today)** | the owner pastes the [run prompt](diagnostic-loop-run-prompt.md) into the doctor session; it builds the pack, spawns 3 differential agents + reviewer + verifier, and writes the run note, questions, actions and packet as markdown | about 2–4 h agent time + 1 h owner review; no code | a first ledger, differentials and discriminating asks on the real case within a day |
| **1** | pin the episode card in the group; create the predictions file; a second, delta run after the first new episode or document | about 0.5 day | episode data begins; first belief diff |
| **2** | a batch-side trigger: the daily digest lists "new facts touching open problems `<ns>:dx:…`" (a deterministic match of fact ids against the ledger's evidence ids); the owner starts a delta run | 1–2 agent-days | runs happen when data warrants them, not when remembered |
| **3** | structured `dx/<ns>/{problems,hypotheses,predictions}.ndjson` beside `crossref/`; a scoring script (Brier, top-k); `gen` views of the ledger; episode facts with SOCRATES fields | 2–3 agent-days | calibration numbers; a ledger page that stays current |
| **4** | a `saturn.dx_loop` task pack on `hl` (egress-locked, split literature fetch, budgets, `git_pr`) | 1–2 agent-weeks (shares agent-server phase 2 with ADR 012 L2) | runs without the owner's laptop; scheduled weekly full runs |
| **5** | an offline evaluation of the prompts on public, synthetic or CPC-style held-out cases, to tune ensemble size and effort against cost | 3–5 agent-days | evidence that a prompt change helped, not just felt better |

## References (accessed 31-Oct-2026)

- [D1] Kanjee Z, Crowe B, Rodman A. Accuracy of a generative AI model in a complex diagnostic challenge. JAMA 2023. doi 10.1001/jama.2023.8288
- [D2] McDuff D et al. Towards accurate differential diagnosis with large language models. Nature 2025;642:451–457. doi 10.1038/s41586-025-08869-4
- [D3] Tu T et al. Towards conversational diagnostic artificial intelligence. Nature 2025;642:442–450. doi 10.1038/s41586-025-08866-7
- [D4] Nori H et al. Sequential diagnosis with language models. arXiv:2506.22405 (2025), preprint
- [D5] Brodeur PG et al. Superhuman performance of a large language model on the reasoning tasks of a physician. arXiv:2412.10849; reported as Science 2026, doi 10.1126/science.adz4433 (journal version not checked)
- [D6] Goh E et al. Large language model influence on diagnostic reasoning: a randomized clinical trial. JAMA Netw Open 2024;7(10):e2440969. doi 10.1001/jamanetworkopen.2024.40969
- [D7] Goh E et al. GPT-4 assistance for improvement of physician performance on patient care tasks: a randomized controlled trial. Nature Medicine 2025. doi 10.1038/s41591-024-03456-y
- [D8] An agentic system for rare disease diagnosis with traceable reasoning (DeepRare). Nature 2026. doi 10.1038/s41586-025-10097-9
- [F1] Hager P et al. Evaluation and mitigation of the limitations of large language models in clinical decision-making. Nature Medicine 2024;30:2613–2622. doi 10.1038/s41591-024-03097-1
- [F2] Schmidgall S et al. Addressing cognitive bias in medical language models (BiasMedQA). arXiv:2402.08113 (2024)
- [F3] Chen S et al. When helpfulness backfires: LLMs and the risk of false medical information due to sycophantic behavior. npj Digit Med 2025. doi 10.1038/s41746-025-02008-z
- [F4] Walters WH, Wilder EI. Fabrication and errors in the bibliographic citations generated by ChatGPT. Sci Rep 2023;13:14045
- [F5] Wu K et al. An automated framework for assessing how well LLMs cite relevant medical references (SourceCheckup). Nat Commun 2025;16:3615. doi 10.1038/s41467-025-58551-6
- [F6] Calibration of LLM confidence on USMLE-style questions, J Med Internet Res 2025;e64348 (authors and exact figures not confirmed: P)
- [T1] Nori H et al. Can generalist foundation models outcompete special-purpose tuning? (Medprompt). arXiv:2311.16452 (2023)
- [T2] Kim Y et al. MDAgents: an adaptive collaboration of LLMs for medical decision-making. NeurIPS 2024. arXiv:2404.15155
- [T3] Multi-agent conversation for rare-disease diagnosis. npj Digit Med 2025. doi 10.1038/s41746-025-01550-0
- [T4] Xiong G et al. Benchmarking retrieval-augmented generation for medicine (MedRAG/MIRAGE). Findings of ACL 2024
- [T5] Zakka C et al. Almanac: retrieval-augmented language models for clinical medicine. NEJM AI 2024. doi 10.1056/AIoa2300068
- [T6] Savage T et al. Diagnostic reasoning prompts reveal the potential for large language model interpretability in medicine. npj Digit Med 2024;7:20. doi 10.1038/s41746-024-01010-1
- [M1] National Academies of Sciences, Engineering, and Medicine. Improving Diagnosis in Health Care. 2015. PMID 26803862
- [M2] Singh H, Meyer AND, Thomas EJ. The frequency of diagnostic errors in outpatient care. BMJ Qual Saf 2014;23(9):727–731
- [M3] Newman-Toker DE et al. Burden of serious harms from diagnostic error in the USA. BMJ Qual Saf 2024;33(2):109–120
- [M4] Graber ML, Franklin N, Gordon R. Diagnostic error in internal medicine. Arch Intern Med 2005;165(13):1493–1499
- [M5] Ely JW, Graber ML, Croskerry P. Checklists to reduce diagnostic errors. Acad Med 2011;86(3):307–313 (the "diagnostic time-out" step); Croskerry P. Cognitive forcing strategies in clinical decisionmaking. Ann Emerg Med 2003
- [M6] Sherbino J et al. Ineffectiveness of cognitive forcing strategies to reduce biases in diagnostic reasoning: a controlled trial. CJEM 2014;16(1):34–40
- [M7] Splinter K et al. Effect of genetic diagnosis on patients with previously undiagnosed disease. NEJM 2018;379(22):2131–2139
- [M8] Faye F et al. Time to diagnosis and determinants of diagnostic delays of people living with a rare disease (Rare Barometer). Eur J Hum Genet 2024. doi 10.1038/s41431-024-01604-z
- [M9] Meyer AND, Longhurst CA, Singh H. Crowdsourcing diagnosis for patients with undiagnosed illnesses: an evaluation of CrowdMed. J Med Internet Res 2016;18(1):e12
- [P1] Ambulatory rhythm monitoring and symptom-rhythm correlation: small studies of patient-activated wristband and smartphone recorders (85–98% correlation) and wearable-patch data showing low correlation when symptoms are not daily. Indirect evidence; no head-to-head diary trial found (P)
- [S1] Dratsch T et al. Automation bias in mammography: the impact of artificial intelligence BI-RADS suggestions on reader performance. Radiology 2023
- [S2] Jabbour S et al. Measuring the impact of AI in the diagnosis of hospitalized patients: a randomized clinical vignette survey study. JAMA 2023;330(23):2275. doi 10.1001/jama.2023.22295
- [S3] Goddard K, Roudsari A, Wyatt JC. Automation bias: a systematic review of frequency, effect mediators, and mitigators. JAMIA 2012;19(1):121–127
- [S4] Semigran HL et al. Evaluation of symptom checkers for self diagnosis and triage: audit study. BMJ 2015;351:h3480
- [S5] Wallace W et al. The diagnostic and triage accuracy of digital and online symptom checker tools: a systematic review. npj Digit Med 2022. doi 10.1038/s41746-022-00667-w
- [S6] van der Bles AM et al. Communicating uncertainty about facts, numbers and science. R Soc Open Sci 2019;6:181870
- [S7] Tan SS-L, Goonawardene N. Internet health information seeking and the patient-physician relationship: a systematic review. J Med Internet Res 2017;19(1):e9
- [R1] US FDA. Clinical Decision Support Software: guidance for industry and FDA staff (28-Sep-2022; revised January 2026, revision not read in full: P)
- [R2] India, Ministry of Health and Family Welfare, S.O. 648(E), 11-Feb-2020 (medical devices, including software, notified as drugs from 1-Apr-2020)
- [R3] CDSCO draft guidance document on medical device software, 21-Oct-2025 (P)
- [R4] ICMR. Ethical guidelines for application of artificial intelligence in biomedical research and healthcare. 2023
