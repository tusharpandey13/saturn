# 013: Diagnostic loop as the prime method (continuous crossref repositioned as hygiene)

Date: 2026-10-31 · Status: **PROPOSED** · Related: 007 (data model), 011 (admin-only output), 012 (continuous
crossref), the [research cross-reference method](../methods/research-crossref.md) · Method:
[methods/diagnostic-loop.md](../methods/diagnostic-loop.md) · Run prompt:
[methods/diagnostic-loop-run-prompt.md](../methods/diagnostic-loop-run-prompt.md)

## Context
- **The gap.** The families Saturn serves carry open, unexplained problems: recurring symptoms with no documented
  cause, conditions whose cause was never established, findings that disagree with symptoms. Doctors give limited
  explanation, and access is shaped by which doctor, availability, travel, cost and stress. Meanwhile data now
  arrives daily: readings, documents, photos, voice notes with context.
- **What 012 covers.** ADR 012 iteration 1 (deterministic checks) keeps that data correct and consistent. It cannot
  reduce diagnostic uncertainty.
- **The owner's view.** Static rules serve data correctness. The goal is **diagnostic inference accuracy**, improved
  over many iterations, and turned into caretaker actions. In other words, it should bridge the gap a doctor would
  normally fill between data and action.
- **Interpretation already allowed.** On 30-Oct-2026 the deployment's records owner allowed agent-inferred
  interpretation in their records repo (labelled, with confidence and citations, kept out of KB facts). Medicine
  advice stays off.
- **Evidence.** Frontier LLMs put the final diagnosis in their differential for most complex published cases.
  Accuracy improves with structure: sequential and cost-aware questioning, ensembles, reviewers, verified retrieval.
  Failure modes are well documented: order and framing effects, sycophancy, fabricated citations, overconfidence,
  and automation bias in readers. Numbers and sources are in the [method](../methods/diagnostic-loop.md) §1.

## Decision (proposed)
1. **The diagnostic loop is Saturn's prime method.** For each person, an agent run works through these steps:
   - keeps an open-problem ledger;
   - writes a problem representation for each problem;
   - builds a differential per problem with evidence for and against (KB ids and verified literature) and explicit
     probabilities plus a residual;
   - chooses discriminating next steps (doctor questions, tests to ask about, home observations, records to fetch);
   - writes outputs for the caretaker, the doctor and the family;
   - re-runs on new data with a **belief diff**;
   - logs predictions and scores them later against doctor findings and test results, for calibration.
2. **ADR 012 is repositioned, not dropped.**
   - L1 deterministic checks and the claims register become **hygiene and background inputs** to the loop's evidence
     pack.
   - L2 (the evidence cross-reference) becomes the loop's literature supplier.
   - The 012 iteration-1 stop condition still applies to the digest.
   - 012 iterations 2–5 are re-prioritised behind loop iterations 1–3.
3. **Mode, opt-in per records repo.**
   - The product default stays "record and flag only".
   - A records repo enables the loop by setting **interpretation allowed** in its `AGENTS.md`.
   - In both modes, medicine start, stop and dose changes are never suggested.
   - Interpretation never enters KB facts.
   - On acceptance, product `AGENTS.md` rule 2 and `records-guide.md` §0.1 gain the opt-in wording, and the citation
     verifier gains a mode switch for "diagnosis in the agent's voice" (labelled hypotheses allowed; verdicts and
     medicine verbs still rejected).
4. **Architecture: a MAI-DxO-style panel inside each run** (amended 31-Oct-2026; it replaces "three independent
   differentials + one reviewer"). The outer loop is unchanged: new data over days and weeks triggers runs.
   - Fixed roles after MAI-DxO (Nori et al., arXiv:2506.22405, a **preprint** evaluated on simulated sequential
     NEJM CPC cases; Saturn adopts its structure, not its accuracy figures): **Hypothesis** keeps the differential
     with explicit probabilities and updates them per new evidence; **Test-Chooser** ranks next steps by expected
     discrimination between the top hypotheses; **Challenger** argues against the leader (anchoring, premature
     closure); **Stewardship** weighs the family's burden (cost, travel, stress, waiting) and prefers cheap
     informative steps; **Checklist** checks consistency, KB ids, citation format, licence rules and wording.
   - One **blinded** seat (no doctors' labels, no owner hypotheses, no earlier inferences) writes an independent
     differential and never sees the debate, to avoid groupthink.
   - 2–3 debate rounds with a stopping rule (no hypothesis moved by 10 points or more, top 3 unchanged, no blocking
     Checklist issue, no new unanswered can't-miss item); hard cap 3 rounds, 2 for a delta run.
   - Optional ensemble of two panels with different evidence orders for full runs.
   - A citation verifier (Sonnet) after the last round resolves DOIs/PMIDs, checks support, KB ids, quotes and
     licence rules.
   - **Questions to the family** are first-class cheap tests next to questions for doctors, records to fetch,
     episode observations and tests to ask about. They are logged in `family/actions.md` (tag `ask-family`) and
     answered in the next voice note or chat, which is ingested as a family-reported source.
   - Literature queries carry no PHI.
5. **Safety rails.**
   - Red-flag escalation runs first and outside the loop.
   - Uncertainty buckets and a residual are always shown; no false reassurance.
   - Evidence links are mandatory.
   - The owner reviews before anything leaves the records repo.
   - Doctor packets frame hypotheses as questions.
   - Off-switch: the mode line in `AGENTS.md`.
6. **Records-side artefacts use existing places first.**
   - Run notes go in `docs/log/analysis/`.
   - Questions go in `questions.md`, actions in `family/actions.md`, packets in `briefs/`.
   - A predictions file sits beside the run notes.
   - A new docs-register id class `<ns>:dx:NNNN` is added for open problems (hypotheses `.hK`).
   - **Inference records** (added 31-Oct-2026): each run writes its beliefs as rows in
     `inferences/<ns>/inferences.ndjson` through `tools/inference` (`<ns>:inf:NNNN`; kind hypothesis /
     interpretation / trend / risk / status-summary; `p` and bucket; KB-id evidence for and against; verified
     citations; what would change it; the producing run). Append-only snapshots with supersede and retire; the owner
     marks rows accepted or disputed. They are never KB facts. A generated `docs/health/<ns>/status.md` (also built by
     the batch, no AI) shows the active rows, and the next run's belief diff is computed from them.
   - Structured `dx/` rows for problems and predictions, like `crossref/`, are added in iteration 3.
7. **Runs.**
   - Now: the owner's Claude Code session (the "doctor" session) in the records repo.
   - Later: a `saturn.dx_loop` task on the egress-locked PHI user, after go-live, using the 012 split literature fetch.
8. **Budget.**
   - A full run costs about $4–8 and a delta run about $1–3 at API prices.
   - The proposed monthly cap is **$60**. It is the owner's decision and separate from the 012 L2 cap.
   - Owner-session runs use the owner's plan.

## Consequences
- Loop 0 needs no further code (`tools/inference` shipped with this amendment). The owner pastes the run prompt; the
  agent works about 2–4 h; the owner reviews for about 1 h.
- The panel costs more per run than the earlier design (about $5–10 for a full single-panel run, $10–18 with an
  ensemble, $1–4 a delta run; estimates in the method §5). The proposed cap stays $60 a month; ensembles are
  optional.
- Iterations need small product work:
  - the episode card and a predictions file (0.5 day);
  - a digest line for "new facts touching open problems" (1–2 agent-days);
  - structured `dx/` rows, a scoring script and a ledger view (2–3 agent-days);
  - an `hl` task pack (1–2 agent-weeks, shared with 012 L2 delivery).
- The product gains an interpretive mode. Publishing the product with it switched on by default would change its
  regulatory reading (FDA non-device CDS covers clinician-facing software only; India regulates diagnostic software as
  a device). So the mode stays off by default, and outputs are addressed to the treating doctor.
- A new failure surface: confident-sounding hypotheses read by the family. The mitigations are the rails above, the
  family-simple summary (words, not numbers) and the owner's review step.
- 012 §11's recommendation ("keep rule 0") is superseded **for repos that opt in**. Its safeguards list (clinician-
  facing framing, labelled hypotheses, two-pass verification, audit, off-switch) is adopted here as the minimum.

## Options considered
| | Keep 012 only (checks + questions) | **Diagnostic loop, opt-in, MAI-DxO-style panel with a blinded seat and verifier** | Single-agent ad-hoc analyses (status quo since 30-Oct) |
|---|---|---|---|
| Reduces diagnostic uncertainty | no | yes, iteratively, measured by calibration | sometimes; not measured |
| Failure-mode guards | n/a | blinded seat, Challenger, Checklist, Stewardship, verifier, red-flag first | depends on the session |
| Cost | none | ~$4–8 per full run; owner review time | similar per run, no structure |
| Complexity | low | moderate, mostly prompts and markdown until iteration 3 | low, but drifts |
| Learning over time | precision of checks only | belief diffs + scored predictions | none |

## Open decisions for the owner
- The monthly cap (proposed $60).
- Who besides the owner reads run notes (proposed: the owner only; the family sees the family-simple summary).
- Whether doctor packets may name hypotheses at all, or only the discriminating asks (proposed: name up to 3, as
  questions).
- When a treating doctor is shown the method itself (proposed: at the first visit that uses a packet).
