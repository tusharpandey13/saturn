---
title: Platform how-tos
audience: engineer, agent
type: how-to
owner: maintainer
last_reviewed: 2026-10-26
review_every: 90d
status: current
sources: [docs/platform/deploy.md, tools/kb/README.md, tools/ocr/HARD-READ.md]
generated: false
---

# How-to index

The step-by-step guides live next to the code they drive. This page links to them so they are findable from one place.

| Task | Guide | Done when |
|---|---|---|
| Deploy the Worker (first time or update) | [deploy.md](../deploy.md), "Checklist" | `/health` returns ok and the deploy workflow is green |
| Roll back a deploy | [deploy.md](../deploy.md), "Roll back" | the previous version serves `/health` |
| Rotate the Telegram bot token | [deploy.md](../deploy.md), "Telegram bot token rotation" | the old token is revoked and the new secret is set |
| Review all tokens and their blast radius | [security.md](../../security.md), [token-architecture.md](../token-architecture.md) | every control in the security model is in place or accepted |
| Run the daily batch | [app/README.md](../../../app/README.md) and [ADR 005](../../decisions/005-ingest-and-batch.md) | the batch workflow run is green |
| Build and query the KB | [tools/kb/README.md](../../../tools/kb/README.md) | `tools/kb/build --records <records-dir>` passes |
| OCR a scan | [tools/ocr/README.md](../../../tools/ocr/README.md) | the `.ocr.md` sidecar sits next to the source file |
| Work a hard-read | [tools/ocr/HARD-READ.md](../../../tools/ocr/HARD-READ.md); queues live in the records repo | each item is resolved or `ask-user` |
| Digitise paper records from video | [tools/doc-scan/README.md](../../../tools/doc-scan/README.md) | one PDF per document |
| Publish the sanitised docs site | [tools/docs-site/DEPLOY.md](../../../tools/docs-site/DEPLOY.md) | the build passes the denylist gate |
| Ingest a new health document | [records-guide.md](../../records-guide.md), ingest fan-out and definition of done | the definition of done is met |

Back to the [platform hub](../README.md).
