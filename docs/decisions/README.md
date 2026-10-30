# decisions/

[← back to the docs home](../README.md)

Architecture decision records (ADRs). Each file is one decision: the context, what we chose, and why. They are numbered in the order they were made. Status lines follow MADR (proposed / accepted / superseded, with Supersedes / Superseded-by links both ways).

## Files

| File | Summary | Status | Audience |
|---|---|---|---|
| [001-channel-telegram-group.md](001-channel-telegram-group.md) | Use a Telegram group as the input channel; WhatsApp deferred. | Accepted 2026-10-24; real-time bot parts superseded by 005 | engineer, family |
| [002-medical-media-outside-git.md](002-medical-media-outside-git.md) | Keep scans and images outside git. | Superseded by 003 | engineer |
| [003-medical-data-in-git.md](003-medical-data-in-git.md) | Store medical images and PDFs in the private records repo; raw videos stay out. | Accepted 2026-10-24 | engineer |
| [004-clinical-data-model.md](004-clinical-data-model.md) | NDJSON facts with provenance, rebuilt into SQLite. | Accepted 2026-10-24; amended by 007 | engineer |
| [005-ingest-and-batch.md](005-ingest-and-batch.md) | Ingest-only Worker on the Free plan, plus a daily batch. No real-time alerts. | Accepted 2026-10-25 (implemented) | engineer |
| [006-unified-platform.md](006-unified-platform.md) | One platform for Saturn and the agent router. | Superseded in part by the HLD (2026-10-25); rest proposed | engineer |
| [007-simplified-clinical-data-model.md](007-simplified-clinical-data-model.md) | Three row types (source, fact, ref) with typed JSON data and namespaced ids; the KB is the source of truth. | Accepted 2026-10-26; amends 004 | engineer |
| [008-product-environment-pii.md](008-product-environment-pii.md) | Split into product (public-ready), environment and PII units joined by `env.manifest.yaml`, `product.lock` and `records.yaml`. | Accepted 2026-10-26 | engineer, maintainer |
| [009-member-admin-roles.md](009-member-admin-roles.md) | Everyone is a `member` (extracted into their own namespace); `admin` adds ops DMs and allowlist/settings. `subject_hint` flags messages about another member. | Accepted 2026-10-27 | engineer, maintainer |
| [010-life-context-signals.md](010-life-context-signals.md) | Closed-vocabulary life-context signals (stress, travel, fasting, ...) from group chat as `event` facts with `data.type = context`; per-member consent, `/private`, summaries only, association-only timeline overlay, capped Haiku cost. | Accepted 2026-10-27 (v0.5.0, prod in shadow) | engineer, maintainer |
| [011-group-input-only-admin-output.md](011-group-input-only-admin-output.md) | The group is input-only (the bot never posts there); the admins are the only output channel: English digest + questions + ops by private DM. Photos are classified first; non-health photos are sources only. | Accepted 2026-10-27 (v0.4.0); amends 005, 009 | engineer, maintainer |
| [012-continuous-crossref.md](012-continuous-crossref.md) | Continuous cross-referencing: deterministic checks (rules as data) in the batch, delta-scoped evidence cross-reference in the PHI enclave, a claims register; flags are derived rows, templated, deduped and admin-only. Design: [continuous-crossref](../design/continuous-crossref.md). | Proposed 2026-10-30 | engineer, maintainer |

## Reading order

1. **001** for the channel.
2. **003**, then **004** and **007** for how data is stored (skip 002, it is replaced).
3. **005** for how the bot works today.
4. **006**, then the [HLD](../platform/hld.md), which wins where they differ.

## Related

- [platform/](../platform/README.md): the designs that build on these decisions.
- [research/](../research/README.md): the research behind 001, 005 and 006.
