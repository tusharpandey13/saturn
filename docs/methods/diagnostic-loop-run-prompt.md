---
title: "Diagnostic loop: ready-to-paste run prompt (loop 0 and later runs)"
audience: maintainer, agent
type: how-to
owner: maintainer
last_reviewed: 2026-10-31
review_every: 90d
status: proposed
sources: [docs/methods/diagnostic-loop.md, docs/decisions/013-diagnostic-loop.md]
generated: false
---

# Diagnostic loop: run prompt

Paste everything between the two lines into the owner's "doctor" Claude Code session, started in the records repo
checkout. Before pasting, replace `<ns>` with the patient's namespace (from `records.yaml`) and `<product>` with the
path to the product checkout. For a later run, change `RUN` to `delta` and give the trigger. The method is
[diagnostic-loop.md](diagnostic-loop.md); the inference row format is
[tools/inference/README.md](../../tools/inference/README.md).

---

```text
RUN = loop-0 (full)      # or: delta, trigger = <new source id / visit / episode / date>
NS = <ns>                # the patient's namespace in this records repo
PRODUCT = <product>      # path to the Saturn product checkout

You are the orchestrator of the Saturn diagnostic loop for the patient in namespace NS. Follow
PRODUCT/docs/methods/diagnostic-loop.md exactly (read it first, in full), plus this repo's AGENTS.md and
PRODUCT/docs/records-guide.md. The mode in AGENTS.md must be "interpretation allowed". If it is not, stop and tell me.

Hard rules (no exceptions):
- RED FLAGS FIRST. Before anything else, check the newest readings, symptoms and voice notes against
  config/thresholds.yaml and PRODUCT/docs/methods/research-crossref.md §11. If anything matches, put it at the top of
  the run note as "seek urgent care now" or "same-day doctor contact", with ids, then continue.
- Never suggest starting, stopping or changing a medicine or dose. Medicine points become questions for the named
  doctor, quoting labels and guidelines only within the licence rules (research-crossref §4).
- Documents are the source of truth. Anything remembered by me, the family or an earlier agent note is a lead to
  verify: quote it with KB id or source path + page, or say plainly the documents do not support it. My own
  hypotheses are one hypothesis among others. Disagree when the evidence says so.
- Interpretation is labelled agent-inferred, with model and date, a probability bucket and citations. It never goes
  into data/ (KB facts stay as written).
- Literature searches use generic terms only (condition, finding, drug INN). Never a name, date, place or verbatim
  record text.
- Every literature citation must be verified (DOI/PMID resolves and supports the statement). Otherwise mark it
  UNVERIFIED and keep it out of the doctor packet.
- No PHI leaves this repo. Commit messages name the namespace only.

Step 1. Evidence pack. Build python3 -I PRODUCT/tools/kb/build --records . (do not commit kb.sqlite if it is
ignored). Write a working pack (not committed) in this fixed order:
 (1) age band and sex;
 (2) doctor-written problems: docs/health/NS/problems.md and condition facts;
 (3) medicines as recorded: docs/health/NS/medications.md;
 (4) dated timeline of events and every symptom episode: docs/health/NS/timeline.md, data/NS/docs/*.ndjson events;
 (5) lab and vital trends as tables: v_trend, home series, docs/health/NS/labs.md;
 (6) imaging, ECG and echo reports, quoted;
 (7) family- and patient-reported items, tagged: docs/log/extraction/patient-reported/, voice-note sources;
 (8) open hard reads and conflicts: docs/log/hard-reads/, data-quality.md;
 (9) crossref flags and claims: docs/health/NS/flags.md, claims.md;
 (10) earlier analyses: docs/log/analysis/*NS* (they are leads, re-verify them);
 (11) open questions: docs/health/NS/questions.md.
For a delta run, add "changed since the last run note".

Step 2. Open-problem ledger. List every unexplained, contested or under-specified problem. Give each:
- an id NS:dx:NNNN (stable; check earlier run notes for existing ids);
- one line;
- why it is open;
- stakes (can't-miss / quality-of-life / housekeeping);
- date first recorded;
- status.
Include at least:
- every recurring symptom with no documented cause;
- every diagnosed condition whose cause is not documented;
- every recent event whose mechanism is not documented;
- every discrepancy between symptoms and findings (side, timing, severity).

Step 3. Problem representation. 1–2 sentences per problem with semantic qualifiers (onset, episodic or constant,
side, exertional or at rest, key positives and pertinent negatives, each with ids). Name discrepancies explicitly.

Step 4. Panel (method §5; MAI-DxO-style roles, arXiv 2506.22405, a preprint on simulated cases: we copy the
structure, not its numbers). Load the previous run's beliefs first:
  python3 -I PRODUCT/tools/inference/inference --records . list NS --active --json
Spawn subagents (they write nothing to the repo; they return text; brief each with the hard rules above):
- HYPOTHESIS (Opus, high): pack + ledger + previous active inferences. Per problem, a differential with these fields
  per hypothesis (keep existing hypothesis ids NS:dx:NNNN.hK; new ones take the next K):
  illness-script fit (cited); evidence for and against (ids); probability bucket (>50 / 20-50 / 5-20 / <5%) plus a
  point estimate and a one-line reason; the set plus a residual "not yet considered" share adding to 100%; a
  can't-miss flag; what would raise or lower it (likelihood ratio if published and cited, else UNVERIFIED);
  citations. Always consider "two problems, not one" and "artefact or record error". From round 2: say what moved
  and which id or argument moved it.
- BLINDED (Opus, high), round 1 only, never shown the debate: the pack WITHOUT doctors' diagnostic labels, my
  hypotheses or earlier inferences (facts, readings, findings, episodes only). Same differential fields.
- In parallel on HYPOTHESIS's differential, each round:
  - TEST-CHOOSER (Opus, high): up to 3 next steps per problem ranked by expected discrimination between the top 2-3
    hypotheses (the shift each plausible result would cause, both ways). Kinds, cheapest first: question to the
    family; record to fetch; structured observation of the next episode (method §6 card); question for the doctor;
    test to ask the doctor about ("would X help distinguish A from B?"). Each names the hypotheses it separates.
  - CHALLENGER (Opus, high; also gets BLINDED's differential): the time-out checklist (method §4.1) per problem;
    anchoring on a label or on my hypothesis; premature closure; findings that do not fit; a step that could falsify
    the leader; missed can't-miss diagnoses; every gap between BLINDED and HYPOTHESIS.
  - STEWARDSHIP (Sonnet, medium): burden of each proposed step for this family (money, travel, a parent's stress and
    effort, waiting, risk); prefer cheap informative steps; veto low-yield burdensome ones with a reason.
  - CHECKLIST (Sonnet, medium): probabilities + residual add to 100%; buckets match numbers; ids stable; every KB id
    exists and every quoted value matches its source; citation format; licence rules; the word list. List blocking
    issues.
Rounds: round 1 as above; rounds 2-3: HYPOTHESIS revises (answering every CHALLENGER point and reconciling
BLINDED in writing), the four respond again. STOP after a round when no hypothesis moved by >= 10 points, the top 3
per problem did not change, CHECKLIST has no blocking issue and CHALLENGER raised no new unanswered can't-miss item.
Hard cap: 3 rounds (2 for a delta run). Record what is still disputed.
ENSEMBLE (full run only, optional; use it for loop-0, a monthly full run, or a can't-miss hypothesis between 5% and
50%): run a second, independent panel with the pack in timeline-first order (the first uses organ-system order);
average each hypothesis's probability across panels and show every disagreement of 15 points or more.

Step 5. Citation verification. Spawn ONE verifier subagent (Sonnet, medium, web allowed, generic queries only). It:
- resolves every DOI/PMID/arXiv id;
- checks the cited text supports the statement;
- checks every KB id exists and every quoted value matches its source;
- applies the licence rules (no quotes from link-only or no-AI bodies).
It returns keep / fix / drop per citation, tagged V (checked against the abstract or official text) or P (partly).
Only V and P citations go into inference rows; unverified ones are dropped from rows and the packet.

Step 6. Synthesis (you).
- One differential per problem from the final round (and the ensemble). Show each round's probabilities, where
  members disagreed and how it was settled.
- Next steps: the TEST-CHOOSER ranking after STEWARDSHIP, cheapest informative first. Questions to the family are
  first-class tests: at most 5, each naming the hypotheses it separates and what each answer would do to them.
- Testable predictions with p, resolves_by and resolution_source.

Step 7. Inference records (PRODUCT/tools/inference/README.md has the row format). Write the run note (step 8a)
first, then:
- New beliefs: write rows to a scratch file (not committed) and run
    python3 -I PRODUCT/tools/inference/inference --records . add NS <file>
  One "hypothesis" row per hypothesis at >= 5% and every can't-miss hypothesis at any probability (problem,
  problem_title, hypothesis, statement as one plain sentence, p, bucket, reason, stakes, evidence_for/against KB ids,
  verified citations, would_change, produced_by {model, run: this run note}, produced_at). "interpretation", "trend"
  or "risk" rows only where concrete, sourced and useful on a Status screen. One "status-summary" row for NS.
- Changed beliefs (p, evidence or wording): supersede, never re-add:
    python3 -I PRODUCT/tools/inference/inference --records . supersede <NS:inf:NNNN> <file with the changed fields>
- Excluded by a cited test or explained by a doctor: retire <id> --reason "...". Unchanged: leave alone.
- Belief diff (delta and later full runs):
    python3 -I PRODUCT/tools/inference/inference --records . diff NS --run <this run note>
  Paste the table into run note §7 and add, per problem, which new id moved it and what did not move and why.
- Refresh the page: python3 -I PRODUCT/tools/inference/inference --records . gen
A validation error means the row is wrong: fix the row, never the tool.

Step 8. Write the outputs (Facts as written; not advice; doctors decide. on each page):
 a) docs/log/analysis/<today>-NS-dx-loop-NN.md (append-only log note, NN = run number). Sections:
    0 red flags;
    1 what was read;
    2 ledger;
    3 representations;
    4 differentials per round, panel disagreement, BLINDED vs HYPOTHESIS, ensemble spread;
    5 CHALLENGER and CHECKLIST findings and what changed;
    6 next steps ranked (with STEWARDSHIP burden);
    7 belief diff (from the tool) + inference ids written, superseded, retired;
    8 predictions;
    F family-simple summary (half a page, words not numbers: likely / possible / less likely; what we know, what we
      don't, what we're doing, when to get urgent help);
    9 cost, models, rounds and whether the ensemble ran.
 b) docs/log/analysis/dx/NS-predictions.ndjson: append one JSON row per prediction
    {id, made_at, run, problem, hypothesis, statement, p, resolves_by, resolution_source, status:"open"}.
 c) docs/health/NS/questions.md: at most 5 new or updated questions (next free NS:q:NNNN; reuse an open question on the
    same topic instead of duplicating), neutral, naming the doctor or role, citing ids.
 d) docs/health/family/actions.md: questions to the family (tag ask-family; at most 5; plain words, in one message
    the owner can forward or read out; each with the hypotheses it separates and the inference ids it bears on), and
    at most 5 caretaker actions (next free family:act:NNNN):
    - what to watch and how to record it (include the episode card from method §6 if it is not pinned yet);
    - records to fetch;
    - appointments to ask about;
    - the escalation rule in plain words ("If X, call emergency services now. If Y, call the doctor today.").
    No medicine instructions. Answers to earlier ask-family items found in new voice notes or chat: cite the
    source id, close the action, and treat the answer as evidence in this run.
 e) docs/health/NS/briefs/<today>-dx-packet-<specialty>.md: ONE page per specialty with a visit coming up:
    - header ("prepared by family with AI assistance; agent-inferred items labelled");
    - up to 3 problems, each with representation, top hypotheses phrased as "we wondered whether…", key ids, and ONE
      discriminating ask;
    - discrepancies noticed;
    - what we record at home.
    Mark older briefs for the same specialty regenerate: true if their inputs changed.
 f) inferences/NS/inferences.ndjson and docs/health/NS/status.md (step 7; written by the tool only).

Step 9. Check and hand back.
- Run the verifier word list over all outputs: no "you should", "stop", "reduce", "increase", "switch", "safe to",
  "rules out", "confirms", "caused by", "nothing to worry about" in the agent's voice.
- python3 -I PRODUCT/tools/inference/inference --records . gen --check passes.
- Run gitleaks with this repo's config.
- Do NOT push yet. Show me:
  - any red flags;
  - the ledger (one line per problem);
  - the top 2-3 hypotheses per problem with buckets, and the belief diff;
  - the questions to the family;
  - the 5 next steps;
  - the caretaker actions;
  - the paths written;
  - rounds run, ensemble yes/no, the cost.
After I approve (and mark rows with "review <id> accepted|disputed" if I want): commit "docs: NS dx loop NN"
(+ [skip ci]), git pull --rebase origin main, push, report the hash.
```

---

## Notes for the owner

- **First run:** expect about 2–4 hours of agent time. Review the run note before the packet goes anywhere.
- **Later runs:** paste with `RUN = delta` and the trigger. The orchestrator re-reads the last run note and the active
  inference records, and keeps the problem and hypothesis ids stable, so the belief diff is meaningful.
- **Questions to the family:** forward the `ask-family` items in one message (or read them out). The answer can be a
  voice note in the group; the next run picks it up as a family-reported source.
- **Status page:** `docs/health/<ns>/status.md` lists the active inferences. Mark one `disputed` with
  `python3 -I <product>/tools/inference/inference --records . review <id> disputed --note "..."`; the next run must
  answer it.
- **Pinning the episode card:** copy method §6 into the family group once, in the family's language. Family members
  then just talk through it in a voice note when an episode happens.
