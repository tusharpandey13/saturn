---
title: "Three-unit split: status"
audience: engineer, owner
type: reference
owner: maintainer
last_reviewed: 2026-10-27
review_every: 90d
status: active
sources: [docs/decisions/008-product-environment-pii.md]
generated: false
---

# Three-unit split: status (product side)

The split of the original single repo into **product** (this repo), **environment** (deployment config + SOPS
secrets, one repo per deployment) and **records** (PII only) is described in
[ADR 008](../decisions/008-product-environment-pii.md). This page keeps the generic status. Deployment-specific
state (accounts, tokens, the go-live gate, run links) lives in the env repo's `ops/STATUS.md`.

| Step | What | State (27-Oct-2026) |
|---|---|---|
| S0 | Plan approved | done |
| S1 | Path map + secret/PHI scan of the old history | done |
| S2 | Org and repos created | done |
| S3 | Env repo bootstrap (SOPS, age recipients, thin workflows) | done |
| S4 | Token rotation into the env repo | partly done; the rest is an owner task |
| S5 | Product built with a fresh history (`--records` / `--env` on every tool) | done (`v0.1.0`) |
| S6 | Records built from the old history with `git filter-repo` | done |
| S7 | Wiring: `product.lock`, records manifest, records-writer App, runtime SOPS | done (`v0.2.0`) |
| S8 | Agent-server split the same way | done |
| S9 | Cutover: records rebuilt from the final history and pushed once; validation from env; old repo archived | done, except the owner-side agent deny rules |
| S10 | e2e on the split layout | pending |
| S11 | Public flip of the product | pending (after one month of clean scans) |

## What the cutover changed in the product
- `v0.2.1`: party `credentials` (as printed + public-register checks; display only), the `care-team` block,
  issued-by columns, and the `med-list-complete` snapshot in `v_meds_current` (two-section meds page). The records
  data had gained these after the S5 freeze; KB parity at the cutover (same summary line, same per-table row hash,
  0 stale pages) needed them.

## Lessons for the next deployment
- Freeze tool changes in the old repo before building the product, or port them before the records cutover: the
  parity check catches drift, but only at the end.
- `git filter-repo` drops commit signatures. If the records history must be all-signed, re-sign the rewritten,
  linear history with `git commit-tree -S` (same trees, authors, dates and messages) before the one-time push.
- GitHub can refuse a workflow-file write by an App at the tree, commit or ref step. A check has to accept a
  403 at any of them.
