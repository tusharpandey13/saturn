# Saturn bot (app)

Design: [ADR 005](../docs/decisions/005-ingest-and-batch.md), [ADR 011](../docs/decisions/011-group-input-only-admin-output.md). Two halves:

- **Ingest Worker** (Cloudflare Workers Free plan, always on): Telegram webhook → secret check → allowlist (D1) → raw update into the D1 `inbox` (idempotent on `update_id`) → media copied to R2. Never replies in a group (ADR 011); an optional deterministic ack ("BP 120/80, pulse 72 ✓") goes only to an admin's private chat. No LLM, no queue, no alerts.
- **Daily batch** (GitHub Actions, schedule set by the env): D1 + R2 → raw data committed to the records repo → STT adapter (optional) + LLM extraction adapter → KB NDJSON (`tools/kb/build --records <records-dir>`) → English digest (records, pending, questions) and a separate ops DM to the admins only → inbox rows marked done and pruned. Which adapters run (and on which account) is an env choice in `env.yaml`.

```
src/worker.ts             Worker entry (fetch only)
src/ingest.ts             webhook: secret, allowlist, inbox insert, R2 copy, ack
src/vitals.ts             deterministic vitals parser + echo (Worker ack and batch)
src/channel/telegram.ts   Telegram update parsing, sendMessage, getFile
src/store.ts              D1 SQL (persons, chats, inbox); runs on D1, D1 REST and node:sqlite
src/batch/                pull / extract / finish steps, Cloudflare REST, records layout, digest
batch/run.ts              batch CLI used by deploy/batch.sh (workflow template deploy/github/batch.yml)
src/extract/              extraction schema (Zod 4), validation and plausibility checks
../adapters/llm/          LLM adapters: claude-cli, fake
../adapters/stt/          STT adapters: sarvam (REST <= 30 s, batch job for longer notes), none
src/rules/, src/config/   red-flag rules + thresholds schema: digest annotations only. Values come from the records
                          repo's config/thresholds.yaml (validated); absent = rules disabled
src/replies.ts            fixed English labels for the admin digest (Hindi input is still understood)
migrations/               D1 schema (persons, chats, inbox)
```

## Run locally (no network, no keys)

```
npm ci
npm test            # vitest; all external APIs mocked. test/batch.test.ts is the local end-to-end run:
                    # fake update -> Worker -> inbox -> pull -> extract (LLM mocked) -> NDJSON -> KB build -> digest
npm run typecheck
npm run e2e:local   # the real Worker in wrangler dev (workerd) with local D1/R2 and a stub Telegram
```

The batch against real services: `npx tsx batch/run.ts pull|extract|finish --records <records-dir>` (or
`npm run batch -- …`) with the env vars listed in `batch/run.ts`. Per-records inputs, both optional:
- `<records-dir>/meta/stt-vocab.txt`: STT vocabulary (one term per line, e.g. the household's medicine names); the
  product ships only generic device and vital words.
- `<records-dir>/meta/extraction-context.md`: who the senders are, passed to the extraction prompt.

## Safety behaviour

- The group is input-only (ADR 011): the Worker and the batch never post to a group chat, whatever `ack_mode` says. `chats` rows are allowlisted input chats; `label` is a free note. An admin's private chat with the bot is also an input chat (answers to digest questions); members' and strangers' private chats are dropped.
- Acks are optional and go only to an admin's private chat (`ack_mode`: `off` default, `vitals-only`, `all`; Worker var `ACK_MODE`). When on, the ack is deterministic and names who the message was logged for ("Maa: BP 116/47 ✓"): the numbers the sender sees are parsed by code, and vitals-only messages are stored from that same parse (no LLM), so the stored values equal the echoed ones. Implausible values are echoed with "?".
- No medical advice and no real-time alerts (ADR 005: in an emergency people phone family or emergency services directly). Rule results appear in the daily digest as annotations marked "unverified; doctor sign-off pending".
- Roles (ADR 009): everyone in `persons` is a `member`; each member's messages are stored, acked and extracted into their own namespace. An `admin` is a member plus the only output channel (ADR 011): the daily digest (plain English) and a separate short ops DM (run failed, extraction delayed, token expiry, webhook alerts) go to the admins by private DM; with no admin reachable nothing is posted anywhere and the workflow log carries a warning. Admins manage the allowlist and settings. Unknown senders and chats are dropped.
- Subject attribution (ADR 009): a leading name from the records' `aliases:` ("maa 116/47") records the message for that member; the sender is kept as provenance. An admin re-attributes a message by replying `/for <name>` to it; corrections land in the records' `data/telegram/subject-overrides.ndjson`, which the batch honours. The digest shows "(sent by X, logged for Y)" for every such line.
- Identical media (same bytes, same subject) is recorded once: each new file is checked against the files already recorded; pairs extracted before v0.8.0 are not re-checked. To drop the automatic facts of a message the owner ingested by hand (or of such an old duplicate), add it to the records' `data/telegram/handled-manually.ndjson` (`replaced_by` a source id, or `duplicate_of` an update_id; [records guide](../docs/records-guide.md) section 7). The batch does not read that file; `tools/kb/build` drops the facts and keeps the message as a source.
- Known limitation: an unprefixed message about another member (e.g. "Maa's BP 120/80" sent by her son) is attributed to the **sender**. The extractor sets `subject_hint` (who it seems to be about, as written); the batch then asks the admin in the digest questions, queues the message (`subject_hint` reason) and the KB tags its facts `subject-hint`. Nothing is reassigned automatically: a human moves the facts (KB superseding) if needed. Vitals-only texts read by the deterministic parser carry no hint.
- Life context (ADR 010, `context_mode`: `off` default, `shadow`, `on`; batch env `CONTEXT_MODE`): the same Haiku call may also return closed-vocabulary context signals, but only for messages that pass a deterministic pre-filter (sender's `context_consent` is `true` in `records.yaml`, >= 4 words, not forwarded, not vitals-only) and only up to 20 messages per IST day (over the cap: skipped and counted; health is never blocked). `parseContext` drops anything out of vocabulary, about a non-member or a member without consent, quoting the message (4-word overlap), naming anyone, or phrased causally. `/private` at the start of a message: archived raw, never extracted at all. Shadow: rows tagged `shadow`, hidden from views, listed in the admin digest under "Context (shadow)".
- Logs carry counts and error classes only: no message text, transcripts, values or Telegram file URLs (they contain the bot token).
- Extraction validates untrusted LLM output in code (`parseExtraction`: schema, plausible ranges, units, times). Every photo is classified first (device reading, prescription, medicine strip, lab report, other health, non-health; `image_class` on the message row, `class=` in the KB source note). Non-health photos become a source only: no facts, no question. Low-confidence, rejected or unreadable **health** items go to the admin's digest questions and to `<records-dir>/data/queue/needs_deep.jsonl` for an offline deep read. Nobody is asked to retype values.
- BP-monitor memory/average screens ("M", "MEM", "AVG", "AVG AM/PM", "Ave", an average icon, "M 3/30"): the extraction returns `reading_kind` (single, average, memory-recall, unknown) with the indicator and count/window as seen. Averages and memory recalls are stored tagged `device-average` / `device-memory`; an unclear indicator is tagged `device-type-unknown` + `needs-human` and queued with a question. None of them feed the red-flag rules, the home daily series or baselines.
- Partly legible BP screens: per-component confidence (systolic, diastolic, pulse, clock). Legible parts are kept; an illegible one is null with its reason (never filled in). The reading is stored tagged `partial-reading` + `uncertain` + `needs-human`, kept out of the series (and out of the rules when systolic or diastolic is missing), and queued for the deep read (`partial_reading`); "unreadable" is only for a screen with nothing legible.

Deploy: **[docs/platform/deploy.md](../docs/platform/deploy.md)**.
