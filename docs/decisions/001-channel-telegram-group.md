# 001 — Channel: Telegram family group

Date: 2026-10-24 · Status: accepted (reversible). The channel stands; the real-time bot behaviour (inline confirm buttons, immediate alerts) is superseded by ADR 005 (2026-10-25).

## Context
Want zero-friction daily input from family members (voice in any language, photos, text, PDFs), ideally in a family group.
See [whatsapp-group-channel.md](../research/whatsapp-group-channel.md).

## Decision
Telegram group (family members + the bot). WhatsApp deferred.

## Why
- WhatsApp official bots cannot join normal groups (Groups API = blue-tick OBAs only).
- WhatsApp official needs a dedicated non-WhatsApp number; a household may have no spare SIM. Meta test number is test-only.
- Unofficial WhatsApp libs: ToS violation, ban risk, malicious npm forks — unacceptable for medical data.
- Telegram: no number, free, true group, inline buttons, low policy risk. Cost = one-time app install for each family member.

## Reversal
ChannelAdapter interface + all history in our DB → can add WhatsApp 1:1 later without data loss.
