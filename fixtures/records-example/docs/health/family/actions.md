---
title: Family actions
audience: family
type: reference
owner: admin
last_reviewed: 2026-06-10
review_every: 30d
status: current
sources: [docs/health/family/context.md]
generated: false
---

# Family actions

**Facts as written; not advice; doctors decide.** Synthetic example (no real data). Every open item carries a tier
(A emergency / B same-week / C next visit or tele-consult) per the family context page.

## At a glance

| Id | What | Priority |
|---|---|---|
| `alice:act:0001` | Photograph the new strip (Tier C) | next visit |
| `family:act:0001` | Pin the when-to-get-help rule in the group | next visit |

## Alice: answer or do

### alice:act:0001: Photograph the new strip
- **Do:** Photograph the front and back of the new strip; say "no change today" if nothing changed.
- **Why:** the strip name is unread (synthetic).
- **Update 2026-06-10 (lint):** Tier C (next visit or tele-consult).
- **Priority:** next visit. **Added:** 2026-06-01.
- **Owner:** family. **Status:** open.

## Family: emergencies

### family:act:0001: Pin the when-to-get-help rule
- **Do:** Pin the rule in the group. Tier A: go to the nearest emergency department immediately for the listed red flags.
- **Priority:** next visit. **Added:** 2026-06-09.
- **Owner:** admin. **Status:** open.

## Done

| Id | What | Done | Outcome |
|---|---|---|---|
| `alice:act:0002` | Call the clinic today | 2026-06-02 | Done; the appointment is booked |
