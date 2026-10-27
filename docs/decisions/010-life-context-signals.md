# 010 — Life-context signals from family group conversation

Date: 2026-10-27 · Status: **ACCEPTED** (2026-10-27, owner approved the defaults; implemented in v0.5.0; see "Decisions taken", which wins where the text below differs) · Related: 005 (ingest and batch), 007 (data model), 008 (PII), 009 (members, `ack_mode`), [HLD](../platform/hld.md), [records guide](../records-guide.md)

## Context
With `ack_mode` off (ADR 009) the family group is also a general conversation and sharing group, not only a reading log. Those chats carry context a doctor may want next to the readings: a bereavement, a week of travel, a fasting festival, poor sleep, a heatwave. The admin states that members are okay with indirect context analysis (the records repo's family consent note). That note is the admin's word, not each member's; this ADR treats it as permission to design and test, not to run on real messages.

Every non-vitals message already goes through the daily Haiku call (ADR 005, chunks of ≤20 messages), so the marginal cost of reading context is small. The risks are not cost: they are privacy, misreading and how the family feels about being read.

## Decision
**1. Closed vocabulary.** A life-context signal is one of: `stress`, `bereavement`, `travel`, `festival_fasting`, `sleep`, `diet_change`, `activity`, `mood`, `work_load`, `weather_heat`, `social_event`. Anything else is ignored (no `other`). The vocabulary is a product enum; a change is a schema change.

**2. A context fact is an `event` with `data.type = context`.** Not a fifth `kind`: ADR 007 keeps four kinds and `v_timeline` already orders events with a period (`at` + `data.end`), which is exactly a context band. A new kind would mean a new table check, a new schema file and view changes for no extra meaning. `event.schema.json` gains `context` and these fields (required when `type = context`, checked by the build):

| Field | Where | Value |
|---|---|---|
| subject | `ns` | the member the signal is about (subject attribution as in ADR 009) |
| category | `data.category` | one of the vocabulary above |
| period | `at` + `at_precision`, optional `data.end` | start/end, or one day |
| summary | `data.summary` | short English paraphrase, ≤80 chars, **never a quote** |
| sentiment, intensity | `data.sentiment` (neg/neutral/pos), `data.intensity` (low/med/high) | only where the message states it explicitly ("very tired", "bahut tension"); else `null` |
| confidence | `data.confidence` (low/high) | categorical, since ADR 007 dropped numbers; `low` adds the tag `low-confidence` and the band is hidden from views |
| source message | `source_id` + `locator` (Telegram message id) | |
| provenance | `tags[]` | `patient-reported` (sender = subject) or `family-reported` (sender ≠ subject) |
| verification | `verification` | always `unverified` |
| quote | `quote` | always `null` (build check) |

The existing `travel` event type (a journey recorded from a document or by hand) stays; the overlay shows both.

**3. Extraction: one combined call.** The existing Haiku prompt gains an optional `context[]` output per message; the message header says `context: yes|no`, set by a cheap deterministic **pre-filter** (no LLM): `yes` only if the subject has consented, the message is not `/private`, has ≥4 words, is not a sticker/emoji/vitals-only text, and matches the product lexicon (English, Hindi, Hinglish; a records repo may add terms in `meta/context-lexicon.txt`). Headers with `no` get no context instructions applied and cost no output tokens. `parseExtraction()` validates the enum, drops anything out of vocabulary, and runs the minimisation checks (4) before a row is written. Health extraction is never delayed or changed by the context fields; a regression in the health fixtures blocks the change.

**4. Minimisation.**
- No verbatim storage beyond the raw archive (`data/telegram/raw/`, unchanged). Summaries only.
- A summary that shares any 4-word sequence with the message (after lowercasing and transliteration-insensitive normalising) is dropped, not trimmed.
- Non-members are never subjects and never named: a third party is "a relative", "a friend", "a colleague" or omitted. A summary containing a token that is a name in the message and not a records namespace display name is dropped.
- No health detail of a third party ("a relative is in hospital" is allowed; their diagnosis is not).

**5. Consent, opt-out and `/private`.**
- `records.yaml` gains `context_signals: {<ns>: {state: confirmed|opted_out, at: <date>}}`. Absent = not extracted. So the opt-out is also the opt-in: nothing runs for a member until they confirm (rollout gate).
- **Messages about an opted-out member** sent by others: no context fact for that subject. If the sender's own context is in the same message, only the sender's is extracted and the opted-out member is treated as a non-member (omitted). A `subject_hint` towards an opted-out member also blocks extraction.
- Opting out later: views stop showing that member's bands at the next build; existing rows get `status = retracted` rows by the batch. Git history keeps them (see retention, open decision 4).
- **`/private`** at the start of a message: archived raw as today (it is not a deletion), never context-extracted, and the digest shows "🔒 private message kept" without a snippet. An edit that adds `/private` retracts any context fact from it. Whether `/private` also skips health extraction is open decision 2.

**6. `data_class: phi`.** Context facts are PHI (ADR 008 rule 1). Any job that reads them is `phi` and runs only on `phi_ok` adapters (HLD data_class policy).

**7. Cross-referencing: association only.**
- `tools/kb/gen-views` adds a `gen:context` block to `timeline.md`: context bands (dates, category, summary, source id) alongside readings and symptoms of the same member and dates. Header line: "Shown alongside, not as a cause. Facts as written; not advice; doctors decide."
- Language rules: the overlay and any text derived from it say "around the same dates", "alongside", "during". A lint rejects causal phrasing ("because of", "due to", "caused", "triggered", "led to", "explains", "के कारण", "की वजह से", "se hua") in generated views, prompts' outputs and questions.
- Nothing is inferred by the batch. Something notable (e.g. high readings during a reported fasting week) may be drafted as a **question for the named doctor** by the offline Opus agent, tagged `agent-inferred`, in its PR to `questions.md`; a human merges it. Never advice, never a diagnosis.
- Not in the digest by default (open decision 3; since ADR 011 the digest goes to the admins only by DM): the digest was read by everyone, and a context line there is where "being watched" is felt most.

**8. LLM budget.** Env vars (env.yaml → batch, like `ack_mode`): `context_mode` ∈ `off` (default) | `shadow` | `on`, and caps. Proposed defaults:

| Cap | Default | Note |
|---|---|---|
| messages/day with `context: yes` | 60 | after the pre-filter |
| context output tokens/day | 6,000 | ≈100 per message |
| context tokens/month (input share + output) | 250,000 | the env converts this to money from the current price list |

Over a cap: health extraction runs as normal; the remaining messages are marked `context_status = deferred` on the KB message row and retried oldest-first by the next run in a small context-only call; after 3 days they become `expired` (never extracted). The admin gets the counts by DM (deferred, expired, month-to-date); the digest does not.

## Risks
| Risk | Mitigation |
|---|---|
| Privacy: a family chat becomes a record | closed vocabulary, summaries only, no third parties, per-member consent, `/private`, `phi` class, off by default |
| Misreading: sarcasm, Hinglish idioms ("dimag kharab", "jaan nikal gayi"), forwards and jokes | explicit-only sentiment/intensity, `low` confidence hidden, forwarded messages skipped by the pre-filter, `unverified` always, shadow review of a sample before any view |
| Family dynamics: members reading each other's context in the records repo | admin-only during shadow; overlay per member; who may view is open decision 5 (a single repo cannot give per-member read access) |
| Chilling effect: people stop chatting freely | not in the digest, `/private`, easy opt-out with no question asked, a check-in with each member after shadow |
| Spurious patterns read as causes | association-only rendering and lint, questions only via a human-merged PR |
| Prompt bloat degrades health extraction | health regression fixtures gate the change; falling back to a separate pass is open decision 1 |

## Test plan (synthetic fixtures only: `fixtures/records-example`, Alice/Bob/Carol)
- Extraction schema: enum, required fields, `quote` null, `verification` unverified, provenance tag by sender/subject; out-of-vocabulary dropped.
- Consent: absent/`opted_out` → no rows; messages by Bob about opted-out Alice → none for Alice, Bob's own kept; `subject_hint` towards an opted-out member → none; opt-out writes retractions.
- `/private`: raw archived, no context row, digest line has no snippet; edit to `/private` retracts.
- Non-member minimisation: a synthetic third-party name never appears in a summary; relation-free roles only.
- No verbatim: 4-gram overlap check on every fixture summary (and a fixture that must be dropped).
- Budget: caps hit → `deferred`, retried oldest-first, `expired` after 3 days; health rows unaffected; admin DM counts.
- Pre-filter: stickers, emoji-only, vitals, forwards → `context: no`.
- Overlay rendering: `gen:context` block snapshot; `low-confidence` and retracted rows hidden; header line present.
- Language lint: causal phrases fail, association phrases pass, over generated views and fixture questions.
- KB: `tools/kb/test_build.py` (schema, required-when-context, quote null) and `tools/kb/test_gen.py` (stale `gen:context` fails).

## Rollout
0. **Build** behind `context_mode = off`, fake adapter, synthetic fixtures only.
1. **Consent gate.** Each member confirms directly (in person or by private DM to the bot, recorded with the date in `records.yaml`); the admin's note is not enough. This is in addition to the go-live gate ([records guide](../records-guide.md) §0).
2. **Shadow** (`context_mode = shadow`, ~4 weeks): rows are written with the tag `shadow` and excluded from every view; the admin gets a weekly private report, reviews a sample for misreads and minimisation failures, and checks in with each member.
3. **On**: overlay in `timeline.md` for consented members; doctor questions only via agent PRs. Rollback: `context_mode = off` (no code change); rows stay and stop rendering.

## Consequences
- One more event subtype, a `records.yaml` key, two env vars and a gen-views block; no new table or service.
- Cost stays inside the existing daily call for most days; the caps bound the worst case.
- The records repo holds more PHI of a softer kind, which git history keeps; retention needs a decision before shadow.

## Decisions taken (owner, 2026-10-27)
1. **Combined pass:** one extraction call returns health facts and `context[]`. Each message header says `context: yes|no`.
2. **`/private`** covers that single message only, and that message is **never extracted** (no health facts, no context). It is archived raw; the digest line has no snippet. An edit that adds `/private` removes the message's earlier rows.
3. **Digest:** the group gets nothing (ADR 011). Context appears in the **admin DM digest only, and only in shadow mode** ("Context (shadow)" section).
4. **Retention:** the raw archive stays as it is; context facts are kept indefinitely like other facts.
5. **Viewing:** overlays (`gen:context` in `timeline.md`) are for the admin, by convention. A doctor brief includes a context row only when it is tagged `brief-relevant` by a human.
6. **Budget:** a hard cap of **20 messages read for context per IST day** (`CONTEXT_DAILY_CAP`). Over it, context is skipped for the rest of the day and counted in the log and the shadow digest; no deferral or retry. Health extraction is never blocked.
7. **Vocabulary:** the eleven categories.
8. **Consent:** each member confirms with a short group message; the admin records it in the records' consent note and in `records.yaml` as `context_consent: {<ns>: true | false | pending}` (replaces the `context_signals` shape in 5). Only `true` is read. A sender without consent gets no context extraction, and no signal is ever recorded about a member without consent or a non-member.

Implementation notes (v0.5.0): `context_mode` (env.yaml, batch env `CONTEXT_MODE`, default `off`). The pre-filter is consent + not `/private` + >= 4 words + not forwarded + not vitals-only; the lexicon match is deferred (the cap bounds cost). Fields are `category`, `summary`, `intensity` (only when stated), `confidence`, period (`at`, `data.end`) and `data_class: phi`; `sentiment` is dropped. Batch rows are `rt: d1.context` in `data/telegram/` (not a D1 table); `tools/kb/build` maps them to `event` facts and checks `quote` null, `unverified`, a provenance tag and day/month precision. `v_timeline` and `v_needs_human` leave context out; `v_context` excludes `shadow` and `low-confidence` rows. Opt-out retractions and the causal-phrase lint over questions are not built yet (an opted-out member is simply never read again; existing rows can be superseded by hand).

## Open decisions for the user (as proposed; settled above)
1. **Combined vs separate LLM pass:** combined (proposed, cheaper) vs a separate context-only Haiku call (isolates health extraction from prompt changes, ~2x calls).
2. **`/private` scope:** context only (proposed) vs also skip health extraction (safer for privacy, but a reading sent with `/private` would be lost to the KB).
3. **Digest visibility:** none (proposed) vs a per-member count only ("2 context notes for Alice") vs full lines.
4. **Retention of context facts:** keep like other facts; or hide from views after N days (proposed 180); or true deletion, which needs a records history rewrite.
5. **Who can view overlays:** admin only; the subject and admin (needs a per-member surface outside the shared repo); everyone with records access.
6. **Budget numbers:** the caps above, the 3-day expiry, and the monthly money ceiling in env.yaml.
7. **Vocabulary:** the eleven categories as listed, or fewer to start (e.g. drop `mood` and `stress` until shadow shows they read well).
8. **Consent recording:** where the direct confirmation is captured (private DM to the bot vs in person, written by the admin).
