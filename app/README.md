# Saturn bot (app)

Design: [ADR 005](../docs/decisions/005-ingest-and-batch.md). Two halves:

- **Ingest Worker** (Cloudflare Workers Free plan, always on): Telegram webhook → secret check → allowlist (D1) → raw update into the D1 `inbox` (idempotent on `update_id`) → media copied to R2 → short deterministic ack ("BP 120/80, pulse 72 ✓"). No LLM, no queue, no alerts.
- **Daily batch** (GitHub Actions, schedule set by the env): D1 + R2 → raw data committed to the records repo → STT adapter (optional) + LLM extraction adapter → KB NDJSON (`tools/kb/build --records <records-dir>`) → digest with a ❓ list to the family group → inbox rows marked done and pruned. Which adapters run (and on which account) is an env choice in `env.yaml`.

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
src/replies.ts            fixed Hindi labels for the digest
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

- Acks are optional (`ack_mode`: `off` default, `vitals-only`, `all`; Worker var `ACK_MODE`). When on, the ack is deterministic and names who the message was logged for ("Maa: BP 116/47 ✓"): the numbers the sender sees are parsed by code, and vitals-only messages are stored from that same parse (no LLM), so the stored values equal the echoed ones. Implausible values are echoed with "?".
- No medical advice and no real-time alerts (ADR 005: in an emergency people phone family or emergency services directly). Rule results appear in the daily digest as annotations marked "unverified; doctor sign-off pending".
- Roles (ADR 009): everyone in `persons` is a `member`; each member's messages are stored, acked and extracted into their own namespace. An `admin` is a member plus ops privileges: ops alerts (webhook assertion) and digest failures go to the admins by private DM (falling back to the family group when no admin is reachable), and admins manage the allowlist and settings. Unknown senders and chats are dropped.
- Subject attribution (ADR 009): a leading name from the records' `aliases:` ("maa 116/47") records the message for that member; the sender is kept as provenance. An admin re-attributes a message by replying `/for <name>` to it; corrections land in the records' `data/telegram/subject-overrides.ndjson`, which the batch honours. The digest shows "(X ने भेजा, Y के लिए दर्ज)" for every such line.
- Known limitation: an unprefixed message about another member (e.g. "Maa's BP 120/80" sent by her son) is attributed to the **sender**. The extractor sets `subject_hint` (who it seems to be about, as written); the batch then asks in the digest ❓ list, queues the message (`subject_hint` reason) and the KB tags its facts `subject-hint`. Nothing is reassigned automatically: a human moves the facts (KB superseding) if needed. Vitals-only texts read by the deterministic parser carry no hint.
- Logs carry counts and error classes only: no message text, transcripts, values or Telegram file URLs (they contain the bot token).
- Extraction validates untrusted LLM output in code (`parseExtraction`: schema, plausible ranges, units, times). Low-confidence, unreadable or rejected items go to the digest's ❓ list and to `<records-dir>/data/queue/needs_deep.jsonl` for an offline deep read.

Deploy: **[docs/platform/deploy.md](../docs/platform/deploy.md)**.
