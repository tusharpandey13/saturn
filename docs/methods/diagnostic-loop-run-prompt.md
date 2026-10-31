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
[diagnostic-loop.md](diagnostic-loop.md).

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

Step 4. Independent differentials. Spawn THREE subagents in parallel (Opus, high effort). Each gets the pack and the
ledger, NOT each other's output:
- A: systems sweep (organ system by organ system).
- B: timeline and mechanism first (what happened in what order; what links the problems).
- C: BLINDED. Remove doctors' diagnostic labels and my hypotheses from its pack; give facts, readings, findings and
  episodes only.
Each returns, per problem, hypotheses with these fields:
- illness-script fit (cited);
- evidence for and against (ids);
- a probability bucket (>50 / 20–50 / 5–20 / <5%) plus a point estimate and a one-line reason;
- the set plus a residual "not yet considered" share adding to 100%;
- a can't-miss flag;
- what would raise or lower it (with a likelihood ratio if published and cited, else marked UNVERIFIED);
- citations.
Each must consider "two problems, not one" and "artefact or record error".
Brief them with the hard rules above. They write nothing to the repo; they return text.

Step 5. Adversarial review. Spawn ONE reviewer subagent (Opus, high). It gets the pack plus all three differentials.
For each problem it answers the diagnostic time-out checklist in method §4.1 and lists:
- missed can't-miss diagnoses;
- anchoring on a label;
- findings that do not fit;
- overconfident probabilities;
- premises with no document;
- any verdict, reassurance or medicine wording.

Step 6. Citation verification. Spawn ONE verifier subagent (Sonnet, medium, web allowed, generic queries only). It:
- resolves every DOI/PMID;
- checks the cited text supports the statement;
- checks every KB id exists and every quoted value matches its source;
- applies the licence rules (no quotes from link-only or no-AI bodies).
It returns keep / fix / drop per citation.

Step 7. Synthesis (you).
- Merge into one differential per problem. Show where agents disagreed and why you settled where you did.
- Apply the reviewer's and verifier's results.
- Rank discriminating next steps by how much they would separate the leading hypotheses against burden (cost, travel,
  risk, stress, wait). Cheapest informative steps first: records to fetch, a structured observation of the next
  episode, questions a doctor can answer from notes, then tests to ask about. Each step names the hypotheses it
  separates.
- For a delta run, write the belief diff: what moved, by how much, because of which new id; and what did not move
  and why.
- Write testable predictions with p, resolves_by and resolution_source.

Step 8. Write the outputs (Facts as written; not advice; doctors decide. on each page):
 a) docs/log/analysis/<today>-NS-dx-loop-NN.md (append-only log note, NN = run number). Sections:
    0 red flags;
    1 what was read;
    2 ledger;
    3 representations;
    4 differentials, with agent disagreement;
    5 reviewer findings and what changed;
    6 next steps ranked;
    7 belief diff (delta runs);
    8 predictions;
    F family-simple summary (half a page, words not numbers: likely / possible / less likely; what we know, what we
      don't, what we're doing, when to get urgent help);
    9 cost and models used.
 b) docs/log/analysis/dx/NS-predictions.ndjson: append one JSON row per prediction
    {id, made_at, run, problem, hypothesis, statement, p, resolves_by, resolution_source, status:"open"}.
 c) docs/health/NS/questions.md: at most 5 new or updated questions (next free NS:q:NNNN; reuse an open question on the
    same topic instead of duplicating), neutral, naming the doctor or role, citing ids.
 d) docs/health/family/actions.md: at most 5 caretaker actions (next free family:act:NNNN):
    - what to watch and how to record it (include the episode card from method §6 if it is not pinned yet);
    - records to fetch;
    - appointments to ask about;
    - the escalation rule in plain words ("If X, call emergency services now. If Y, call the doctor today.").
    No medicine instructions.
 e) docs/health/NS/briefs/<today>-dx-packet-<specialty>.md: ONE page per specialty with a visit coming up:
    - header ("prepared by family with AI assistance; agent-inferred items labelled");
    - up to 3 problems, each with representation, top hypotheses phrased as "we wondered whether…", key ids, and ONE
      discriminating ask;
    - discrepancies noticed;
    - what we record at home.
    Mark older briefs for the same specialty regenerate: true if their inputs changed.

Step 9. Check and hand back.
- Run the verifier word list over all outputs: no "you should", "stop", "reduce", "increase", "switch", "safe to",
  "rules out", "confirms", "caused by", "nothing to worry about" in the agent's voice.
- Run gitleaks with this repo's config.
- Do NOT push yet. Show me:
  - any red flags;
  - the ledger (one line per problem);
  - the top 2–3 hypotheses per problem with buckets;
  - the 5 next steps;
  - the caretaker actions;
  - the paths written;
  - the cost.
After I approve: commit "docs: NS dx loop NN" (+ [skip ci]), git pull --rebase origin main, push, report the hash.
```

---

## Notes for the owner

- **First run:** expect about 2–4 hours of agent time. Review the run note before the packet goes anywhere.
- **Later runs:** paste with `RUN = delta` and the trigger. The orchestrator re-reads the last run note and keeps the
  problem and hypothesis ids stable, so the belief diff is meaningful.
- **Pinning the episode card:** copy method §6 into the family group once, in the family's language. Family members
  then just talk through it in a voice note when an episode happens.
