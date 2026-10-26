---
title: Platform reference
audience: engineer, agent
type: reference
owner: maintainer
last_reviewed: 2026-10-26
review_every: 90d
status: current
sources: [docs/decisions/007-simplified-clinical-data-model.md, docs/decisions/004-clinical-data-model.md, tools/kb/README.md]
generated: false
---

# Reference

## Data model and IDs

- **Data model:** [ADR 007](../../decisions/007-simplified-clinical-data-model.md) (source / fact / ref rows, typed JSON `data`), amending [ADR 004](../../decisions/004-clinical-data-model.md); `schema/schema.sql` and `schema/*.schema.json`. Build and query: [tools/kb](../../../tools/kb/README.md).
- **IDs:** `<ns>:<class>:<local>`. KB (ADR 007): `<ns>:src:…`, `<ns>:fact:…`, `ref:<drug|code|party>:…`. Docs register: `<ns>:q|ans|act:NNNN`. ns comes from `namespaces:` in the records repo's `records.yaml` (synthetic example: `alice`, `bob`, `family`; refs: `ref`). Rules: [records guide](../../records-guide.md).
- **Source of truth:** the KB in the records repo's `data/`. Health pages in the records repo are views that cite KB ids.

## Glossary (technical terms)

Medical terms are in the records repo's health glossary.

| Term | Meaning |
|---|---|
| ADR | Architecture decision record: one decision and why. See [decisions/](../../decisions/README.md) |
| HLD | High-level design: the one-document view of the system. See [hld.md](../hld.md) |
| KB | Knowledge base: the structured facts in the records repo's `data/` (ADR 007) |
| D1 | Cloudflare's small SQL database; the bot's inbox lives there |
| R2 | Cloudflare's file storage; raw photos and voice notes go there |
| Worker | A small Cloudflare program that receives Telegram messages |
| data_class | A label on each background job, such as `phi`, that controls where the job may run |
| hard-read | A word or number in a scan that OCR could not read with confidence; it is queued for careful review |
| PHI | Protected health information: any health data tied to a person |
| go-live gate | No real data reaches any deployment until its owner says "go" ([records guide](../../records-guide.md)) |

Back to the [platform hub](../README.md).
