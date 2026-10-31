---
title: "Backlog (parked work)"
audience: maintainer, agent
type: reference
owner: maintainer
last_reviewed: 2026-10-31
review_every: 30d
status: active
sources: []
generated: false
---

# Backlog: parked work

Work the owner has parked. Not scheduled. Pick up only when the owner un-parks an item. Newest first.

## Transcription follow-ups (parked 31-Oct-2026)

- Retire Sarvam fully (adapter, token inventory, secret name) now that STT is local whisper.cpp.
- Faster STT if notes get long or frequent: run whisper on the home server as a turbo task (or the Mac when awake)
  instead of the GitHub runner (currently ~5–6x slower than real time, job timeout 75 min).
- After the ground-truth clip: evaluate whisper large-v3 (non-turbo), turbo, and Indic models (e.g. AI4Bharat
  IndicConformer, Meta MMS) on WER/CER and medicine-name accuracy; pick by measured quality.

## Dependency, package and model upgrades (parked 31-Oct-2026)

Goal: keep packages, NixOS inputs and local models current, with a cheap automatic path and a rarer agentic path.

- **Model manifest** `models.yaml` (one entry per capability: stt, embeddings, later slm): model, source and pinned
  revision, sha256, licence, RAM, eval set id, current scores. Code reads it instead of hard-coding models.
- **Eval harness per capability** (the enabler): STT word and character error rate on typed Hindi clips;
  embeddings retrieval accuracy on known questions; speed and RAM on the box under the CPU power cap. Eval sets with
  health data stay in the records repo and run on the home server as the PHI user; only scores leave.
- **Static path (weekly, automatic):** Renovate instead of Dependabot (npm, pip, GitHub Actions digests, Nix flake
  inputs, model revisions through a regex manager on `models.yaml`). Tests and the relevant evals run on every PR;
  patch and minor updates that pass merge automatically; major versions and model swaps go to the agentic path. The
  home server still applies signed releases only.
- **Agentic path (monthly):** a research agent scans leaderboards and releases (Open ASR, Indic ASR, MTEB, new
  Gemma/Qwen/Whisper), filters by CPU/RAM/licence/Hindi, runs the evals on the best 2–3, writes a report, and opens a
  PR on `models.yaml` when a candidate clearly wins. It also handles major-version upgrades. The owner approves.
- **Blocker:** auto-merge needs PR checks that run. The product repo's GitHub Actions fail at startup (billing or
  account); fix that first.
- **Estimate:** manifest + STT and embeddings evals about 1 day; Renovate about 2 hours; the research agent about half
  a day.

## Separate signing identity for agents (parked 31-Oct-2026)

Agents sign with their own key, so the owner's key (optionally behind Touch ID via Secretive) means the owner
approved. The records-integrity check gets the agent key as a signer limited to its paths. About 1 hour.

## The three disabled GitHub checks in the home server's Gatus (parked 31-Oct-2026)

Batch, guard and records-validate run results. Needs a fine-grained token with Actions: read on the env repo. About 15
minutes.
