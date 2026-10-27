# 011 — The group is input-only; the admin is the only output channel

Date: 2026-10-27 · Status: **ACCEPTED** (2026-10-27, owner decision) · Amends: 005 (digest to the group), 009 (ops
fallback to the group, Hindi digest, group acks) · Implemented in v0.4.0

## Context
Live use of v0.3.x: the bot posted the daily digest, clarification questions and ops lines ("⚠ extraction delayed")
in the family group, partly in Hindi. The owner (27-Oct-2026): "group is user interface, not a place for logs ...
parents will not understand ... from pov of parents it's a one-way thing." The parents send; they should never have
to read bot output. Photo handling also asked the family to retype numbers, and treated screenshots or greetings as
unreadable readings.

## Decision
1. **A group chat is input-only.** The bot never posts to any group: no digest, no questions, no ops alerts, no acks,
   no notices (file too big). This is hard-coded in the Worker (`app/src/ingest.ts`) and in the batch
   (`app/src/batch/steps.ts` `finish` reads no chats). `ack_mode` stays, but applies only to an admin's private chat.
2. **Chats are allowlisted input chats, nothing more.** `chats.label` is a free note with no semantics (the old
   `label = 'family'` digest target is gone). An existing label such as `members-silent` keeps working.
3. **Admins are the only output channel**, by private Telegram DM (chat id = the admin's user id; the admin must have
   started a private chat with the bot):
   - the **daily digest**, in plain English: per member what was recorded ("sent by X, logged for Y" where they
     differ), pending items (voice transcription pending, documents kept for a closer read, files not yet copied),
     rule annotations, and questions the admin can answer by replying;
   - a separate short **ops DM**, only when actionable: run did not complete, extraction delayed, token expiry,
     webhook alerts. No ops lines in the digest.
   - With no admin reachable nothing is posted anywhere; the workflow log carries a warning (and webhook alerts fail
     the run). The old fallback of security alerts to the group is removed.
4. **An admin's private chat is also an input chat**, so replies to the digest questions are stored and extracted
   like any message (the replied-to question is context). A member's or stranger's private chat is dropped.
5. **Hindi input is still understood** (prompt, vitals parser, aliases). Bot output has no Hindi templates.
6. **Photos are classified first** (`media_kind`, the first property of the extraction schema): device reading,
   prescription, medicine strip, lab report, other health, non-health. The message row records `image_class`
   (`device-reading`, `prescription`, `medicine-strip`, `lab-report`, `other-health`, `non-health`); the KB source note
   carries `class=<x>` and non-health sources are tagged `non-health`.
   - **Non-health** (screenshot, meme, greeting, scenery): a source only. No facts, no question, no deep-read item.
   - A question goes to the admin **only** when health content is detected but unreadable. Unknown class: queued for
     the deep read, no question.
   - Nobody is ever asked to retype or resend numbers. Questions say what happened ("kept for a closer read") and
     invite a reply if the admin knows.

## Consequences
- The family sees nothing from the bot; the admin carries the review load (one digest DM a day plus rare ops DMs).
- Parts in the Worker (group acks off, admin-DM input) take effect only after a Worker deploy; the batch parts take
  effect from `product.lock`. Until the Worker is redeployed, a group is silent only while `ack_mode` is `off`.
- `/for <name>` still works as a reply in the group (the admin's own message, visible to members); feedback is a DM.
- Messages recorded in a delayed run are not repeated in the next digest (unchanged from v0.3.3; a known gap).

## Records-side wording (for the records repo's AGENTS.md, Telegram bullet)
> Telegram (owner, 27-Oct-2026, ADR 011): the family group is **input-only**; the bot never posts there. Everyone in
> the group is a **member**; each member's messages go to their own namespace. The **admin** is a member plus the only
> output channel: the daily digest (plain English), clarification questions and ops alerts arrive by private DM, and
> the admin answers by replying there. Members may log for each other with a name prefix ("maa 116/47"); otherwise a
> message is the sender's. A wrong attribution is fixed by an override row (or the admin's `/for <name>`), never by
> editing D1 or old rows. Non-health photos are kept as sources with `class=non-health` and no facts. Never ask the
> family to retype or resend values.
