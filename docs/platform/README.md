---
title: Platform hub
audience: engineer, agent
type: reference
owner: maintainer
last_reviewed: 2026-10-26
review_every: 90d
status: current
sources: []
generated: false
---

# Platform

How Saturn is built and run. Two services: **hl-service** (the health log: Telegram capture, daily batch, KB, digest; this repo) and **agent-service** (runs background AI jobs; the agent-server repo). The [HLD](hld.md) ties them together.

This folder carries **no health data** and no environment values: concrete resource names, ids and status live in the env repo; records live in the records repo ([records guide](../records-guide.md), PHI section).

## Start here

1. [hld.md](hld.md): the big picture.
2. [deploy.md](deploy.md): the generic deploy runbook (values come from the env repo).
3. [decisions/](../decisions/README.md): why things are the way they are.
4. Current deployment status, go-live state and blockers: env repo.
5. [split-status.md](split-status.md): the product / env / records split, step by step (generic).

## Design docs

| File | Summary | Status |
|---|---|---|
| [hld.md](hld.md) | High-level design of both services: context, data flow, components, cost, risks, roadmap | Proposed 2026-10-25; decisions approved |
| [hl-service-design.md](hl-service-design.md) | Target design of the capture-and-records service | Proposed 2026-10-25 |
| agent-service-design, agent-service-research | Agent service: interactive sessions, a job queue, OSS tools reviewed | in the agent-server repo |
| [oss-review-hl-service.md](oss-review-hl-service.md) | Which hand-built parts could be swapped for standard tools | Review 2026-10-25 |
| [security.md](../security.md) | Threat model, controls, token-scoping principles | Current |
| [token-architecture.md](token-architecture.md) | Where tokens live, lifetimes, branch protection, secret managers | Proposal 2026-10-25 |
| [e2e-testing.md](e2e-testing.md) | End-to-end test plan using synthetic data only | Proposed 2026-10-25; batch half implemented |

## How-to and reference

- [how-to/](how-to/README.md): deploy, rotate tokens, run the batch, build the KB, work a hard-read.
- [reference/](reference/README.md): data model, IDs, glossary of technical terms.
- [decisions/](../decisions/README.md): ADRs (MADR status lines).

## Related

- Code-side docs: [app/README.md](../../app/README.md), [tools/kb](../../tools/kb/README.md), [tools/ocr](../../tools/ocr/README.md), [tools/doc-scan](../../tools/doc-scan/README.md), [tools/docs-site](../../tools/docs-site/DEPLOY.md).
- Technical research notes: [research/](../research/README.md). Change history: release notes and the changelog (env repo for deployment history).

Back to the [docs home](../README.md).
