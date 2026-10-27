# 009 — Everyone is a member; admin adds ops privileges; subject attribution; acks off by default

Date: 2026-10-27 · Status: **ACCEPTED** (2026-10-27, owner decision) · Related: 005 (ingest and batch), 008 · Implemented in v0.3.0 (`app/migrations/0002_member_admin_roles.sql`, `0003_inbox_subject.sql`)

## Context
`persons.role` was `patient` or `caregiver`. A caregiver's messages were stored raw but never acked or extracted, so
everything a helping family member reported about their own health was lost to the KB, and the split did not match how
the household uses the group: everyone reports, and one person runs the bot. The owner: "patient/caregiver categories
sound wrong, everyone is a member, I am the admin for now".

## Decision
- `member` (everyone): each member's messages are stored, acked and extracted into **their own** namespace
  (D1 person id → KB namespace through `records.yaml` `d1_person_map`, same id otherwise).
- `admin`: a member plus ops privileges. Ops alerts (the webhook assertion) and the digest-failure notice go to the
  admins by private Telegram DM (chat id = the admin's user id; the admin must have started a private chat with the bot).
  With no admin reachable they fall back to the family group, so an alert is never dropped. Admins manage the allowlist
  and settings (today by hand: D1 and the env repo).
- Migration 0002 rebuilds `persons` with `CHECK (role IN ('member','admin'))`, mapping patient → member and
  caregiver → admin. Rows, ids, sender ids (still UNIQUE) and `created_at` are kept; an unknown role aborts it.
- Raw rows pulled before v0.3.0 keep the role they were written with; the batch no longer filters on role, so the
  first v0.3.0 run also extracts earlier caregiver messages that were never extracted.

## Subject attribution (members log for each other)
Live use showed a parent sending the other parent's BP from their own phone. `inbox.person_id` stays the **sender**;
`inbox.subject_id` (migration 0003, backfilled = person_id) is who the message is about.
- **Name prefix** (deterministic): the records repo's `records.yaml` `aliases:` (`<ns>: [names]`; real names never in
  product code) are synced into D1 (`aliases`) by each batch pull. A message that starts with one ("maa 116/47",
  "papa ka BP ...") is recorded for that member. The echo, when on, names who it was logged for ("Maa: BP 116/47 ✓").
- **Admin correction**: the admin replies `/for <name>` to the member's original message (or to the bot's echo). The
  Worker records it in `subject_corrections` (who, when; the sender is kept) and moves `subject_id`; feedback is a private
  DM. The batch copies corrections to the records repo's `data/telegram/subject-overrides.ndjson` (append-only; also
  hand-editable: `update_id, subject, set_by, set_at, reason`; latest `set_at` wins), which is the auditable record and
  what the batch honours. A re-attributed message is re-extracted into the new subject.
- **The batch** extracts into the subject's namespace and keeps the sender as provenance (`sender_person_id`; KB source
  `identifiers.reported_by`, note "reported by X for Y", facts tagged `family-reported`). The digest shows each such line
  with "(X ने भेजा, Y के लिए दर्ज)" and how to correct it.
- **Not auto-reassigned (known limitation)**: without a prefix the message stays with the sender. It is flagged
  `subject_hint` for review when the extraction says it is about someone else, or when the sender usually logs for one
  other member (2+ earlier messages, most about that member). Then the digest asks, the message is queued
  (`needs_deep`, reason `subject_hint`) and the KB tags it `subject-hint`. Vitals-only texts read by the deterministic
  parser never get the LLM hint.

## Group replies: `ack_mode`
Env var `ack_mode` (env.yaml → Worker var `ACK_MODE`, changeable without a code edit): `off` (default, and prod) sends no
group replies at all; `vitals-only` sends only the vitals echo (and the file-too-big notice); `all` sends every ack.
With acks off the daily digest is where the family sees what was recorded and for whom; ops alerts and `/for` feedback
reach the admin by private DM.

## Consequences
- More LLM calls (every member's messages are extracted); still one batched call per run.
- Ops noise leaves the family digest; extract-step operator warnings (e.g. token expiry) stay in the digest for now.
- Allowlist role labels in env repos change to `member` / `admin`.
