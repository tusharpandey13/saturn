# Build research: Telegram-group health bot on Cloudflare Workers

Researched 2026-10-24. Builds on [ADR 001](../decisions/001-channel-telegram-group.md) and [architecture-options.md](architecture-options.md).
FX assumption: 1 USD = ₹88. Vendor limits change, so re-check the cited pages before relying on an edge case.

## TL;DR: gotchas that shape the code

1. **The bot sees almost nothing in a group unless it is an admin.** Make the bot a group **admin** (admins "always receive all messages"), or turn privacy mode off in BotFather and **re-add** the bot to the group.
2. **Return 200 to the webhook immediately and do the work in a Queue.** Telegram retries any non-2xx response or timeout. `waitUntil` stops after 30 s, but a Sonnet vision call plus STT can take longer. Deduplicate on `update_id` with `INSERT OR IGNORE` before enqueueing.
3. **Any group member can tap an inline button.** Check `callback_query.from.id` against the patient's user ID, and reject anyone else with `answerCallbackQuery` and a short alert.
4. **Sarvam REST STT only takes audio under 30 s.** It accepts OGG/Opus directly, so no conversion is needed. Route on Telegram's `voice.duration`: up to 30 s goes to REST, anything longer goes to the Sarvam Batch API (async, so poll it from the Queue).
5. **Telegram file URLs contain the bot token** (`https://api.telegram.org/file/bot<TOKEN>/...`). Never log them, never pass them to Claude as an image URL, and scrub them out of error messages.
6. **Chat ID can change.** If the group is upgraded to a supergroup, you get a `migrate_to_chat_id` message. Handle it by updating the stored chat ID.
7. **Use Workers Paid ($5/month).** The free plan's 10 ms CPU limit per request is too tight for base64-encoding photos and PDFs and parsing JSON. Paid also gives 30-day D1 Time Travel instead of 7 days.
8. **Don't put PHI in Claude JSON schemas.** Compiled schemas are cached outside the normal data protections. Default API retention is 30 days, and ZDR requires a sales contract.

---

## 1. Telegram Bot API (current: Bot API 10.3, 2026-08-24)

Source: [Bot API](https://core.telegram.org/bots/api), [Bot features: privacy mode](https://core.telegram.org/bots/features#privacy-mode)

### What the bot receives in a group
- **Privacy mode on (the default):** the bot only gets `/cmd@bot` commands, replies to its own messages, inline messages sent via the bot, and service messages. That means it would **miss** plain voice notes, photos and PDFs from family members.
- **Bot added as admin:** "bot admins always receive all messages", whatever the privacy setting. **Recommended.** Give it the minimum rights it needs: none are required just to read. Delete-messages is optional.
- **Privacy mode off** (BotFather `/setprivacy` → Disable): the bot receives everything, but "the bot will need to be re-added to the group for this change to take effect". Members can see the setting in the member list.
- Bots never see other bots' messages unless Bot-to-Bot Communication Mode is on. That doesn't matter here.

### Files
- `getFile` → `file_path`, then download from `https://api.telegram.org/file/bot<TOKEN>/<file_path>`. The **maximum download is 20 MB**, and the link is valid for **at least 1 hour** (call `getFile` again to refresh it). Larger files need a self-hosted Local Bot API server, which isn't worth it here. Reply "फ़ाइल बहुत बड़ी है" for files over 20 MB.
- Voice notes arrive as `message.voice` with fields `file_id`, `file_unique_id`, `duration` (seconds) and `mime_type` (`audio/ogg`, Opus).
- Photos arrive as `message.photo[]`, an array of sizes. Take the **last (largest)** entry. Telegram recompresses photos (long edge up to about 1280–2560 px). That is enough for LCD digits. A photo sent "as file" arrives as `message.document` with an `image/*` mime type, so handle both cases.
- PDFs arrive as `message.document` with `mime_type: application/pdf`.
- Copy each file to R2 immediately, keyed by `file_unique_id`, which is stable across bots and works for deduplication. After that, never re-fetch from Telegram.

### Webhook
- `setWebhook(url, secret_token, allowed_updates, max_connections, drop_pending_updates)`.
- `secret_token` is 1–256 characters from `A-Z a-z 0-9 _ -`. Telegram sends it in the **`X-Telegram-Bot-Api-Secret-Token`** header. Compare it in constant time and return 401 if it doesn't match. Keep the bot token **out of the webhook URL path**.
- Retries: "In case of an unsuccessful request (a request with response HTTP status code different from 2XY), we will repeat the request and give up after a reasonable amount of attempts." Undelivered updates are kept for at most 24 hours.
- `update_id` values "increase sequentially" and "allow you to ignore repeated updates". After a week with no updates, the next ID is random, so **don't assume `id > last_id`**. Use a unique-key table: `INSERT OR IGNORE INTO tg_updates(update_id)`. If no row was inserted, return 200 and stop.
- Set `allowed_updates: ["message","edited_message","callback_query","my_chat_member"]`. Set `max_connections` to something low, such as 5, so updates for one chat arrive in roughly the right order.
- Ports: 443, 80, 88, 8443. A `*.workers.dev` or custom domain on 443 works.

### Inline keyboards in groups
- **Any member can press any inline button**, and the API has no per-user restriction. `CallbackQuery.from` is the person who pressed. To restrict buttons to the patient:
  - Encode the target user in `callback_data`, which is **1–64 bytes**. For example `c:<reading_id>:<patient_tg_id>:y`, or better, a short opaque ID that you look up in D1.
  - On a mismatch, call `answerCallbackQuery(show_alert=true, text="यह बटन सिर्फ़ मम्मी के लिए है")`.
  - **Always call `answerCallbackQuery`.** Otherwise the client shows a spinner on the button.
- After a confirm or cancel, edit the message (`editMessageText`/`editMessageReplyMarkup`) to remove the buttons so they can't be pressed twice. Also make the D1 update idempotent: `UPDATE ... WHERE status='pending'`.
- New in 10.3: `DisabledButton`. You can use it to show a confirmed state.

### UX helpers
- `sendChatAction(action="typing" | "record_voice" | "upload_document")`: the status lasts **5 s or less**. Repeat it every 4 s during long jobs, or send it once and accept that it lapses.
- `setMessageReaction`: bots can set **one** reaction per message. A cheap "received" acknowledgement is 👍 or ✍️ on the sender's message, sent before the slow processing starts.
- `reply_parameters.message_id`: reply to the specific photo or voice note so it's clear which reading the bot means.

### Text limits and Hindi formatting
- `sendMessage` text: **1–4096 characters after entity parsing**. Captions: **0–1024**. Devanagari vowel signs (matras) count as separate code points, so a Hindi message uses up its character count faster than it looks. Keep replies short anyway; most readers prefer it.
- Use **`parse_mode: "HTML"`** and avoid MarkdownV2, which needs a lot of escaping. Escape only `<`, `>` and `&` (as `&lt; &gt; &amp;`), and only for dynamic text. Supported tags include `<b> <i> <u> <s> <code> <pre> <a> <blockquote>`. Entity offsets are counted in UTF-16 code units, which only matters if you build entities by hand. Devanagari is all in the BMP.
- UTF-8 JSON works with no special handling. Don't use custom emoji. Plain emoji such as ✅ ⚠️ are fine.

### Bot API features from 2025–26 that matter here
- **Ephemeral messages** (10.2/10.3): the bot can send a message in a **supergroup** that only `receiver_user_id` sees, within 15 s of that user's action (admins can send them any time). Delivery "is **not guaranteed**", and they "may disappear". Don't use them for confirmations or alerts. At most, use them for low-value hints.
- **Reaction management** (10.0) and **`DisabledButton` / `force_reply` in reply markup** (10.3).
- **Rich messages / tables** (10.1–10.3): optional for a weekly summary to the caregiver. Don't depend on them for the MVP.
- Checklists exist (1–30 tasks) and could work as a medicine checklist later. Not for the MVP.

---

## 2. Sarvam STT

Sources: [STT REST reference](https://docs.sarvam.ai/api-reference-docs/speech-to-text/transcribe), [STT APIs overview](https://docs.sarvam.ai/api/speech-to-text/apis/overview), [FAQ](https://docs.sarvam.ai/api/speech-to-text/faq), [Pricing](https://docs.sarvam.ai/api-reference-docs/getting-started/pricing), [Privacy policy (updated 2026-07-29)](https://www.sarvam.ai/privacy-policy)

- **Formats:** REST and Batch accept OGG and OPUS directly, with the codec auto-detected. So a Telegram `.oga` voice note can be posted as is. Set the multipart filename to `voice.ogg` and the type to `audio/ogg`. **No transcoding is needed.**
- **APIs:**
  - **REST** `POST https://api.sarvam.ai/speech-to-text` (multipart: `file`, `model`, `mode`, `language_code`; header `api-subscription-key`). Synchronous, **under 30 s of audio only**. Longer audio most likely gets a 400. Rate limit is 60 requests/min on pay-as-you-go.
  - **Batch:** async, **up to 2 h per file, 20 files per job**, with optional diarization. The flow is create job → upload to the returned URL → start → poll status → download results. Rate limit is 20 requests/min. Drive it from a Queue message re-enqueued with `delaySeconds: 10–20`.
  - **Streaming (WebSocket):** **WAV/PCM only**, 16 or 8 kHz. Not useful, because it would need Opus decoding.
- **Models and settings:** `saaras:v4` is the default and recommended model for new integrations. `saaras:v3` is still supported. For Hindi set `language_code: "hi-IN"`, or `unknown` for auto-detect, which also returns `language_probability`. For Hinglish, `mode: "codemix"` returns Devanagari Hindi mixed with Latin-script English terms. The docs say `mode` applies to v3, but the v4 text also mentions it, so test this. `transcribe` (the default) is the safe fallback. Pass `keyterms` (v4, up to 50 terms) with drug names, "BP", "sugar" and so on (product: medicine names come from the records repo's `meta/stt-vocab.txt`) to improve recognition of drug names.
- **Pricing:** **₹30/hour** of audio, billed per second and rounded up per request. With diarization it is ₹45/hour. New accounts get ₹100 of free credits that don't expire.
- **Privacy:** The policy says "Your Content (Inputs/Outputs)" is retained "User-configurable (default: 30 days after last access)". By default, content **may be used to train models** (opt-out through account settings or email). Data "may be transferred to … countries outside India". Deletion requests are completed within 30 days. **Action: opt out of training in the Sarvam dashboard before sending real audio, and delete Batch job data after download if the API allows it.** The policy also says it doesn't cover content processed for business-offering customers under contract, but we are on self-serve.
- **If conversion is ever needed** (another STT provider, streaming): (a) ffmpeg.wasm is about 25–30 MB with a heavy CPU cost, which is impractical against the 128 MB memory limit. (b) A small Opus decoder in WASM (`ogg-opus-decoder`, about 100s of KB) could decode to PCM, then write a WAV header, on Paid CPU. (c) Cloudflare Containers as an escape hatch. (d) Workers AI Whisper takes audio directly, but Hindi quality is unverified. Recommendation: **don't convert**, use REST plus Batch.
- **Long voice notes:** many users talk for more than 30 s. Splitting Ogg/Opus at page boundaries into valid sub-files is possible without decoding, but fiddly. Batch is the supported path.

---

## 3. Cloudflare Workers limits

Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/), [R2 pricing](https://developers.cloudflare.com/r2/pricing/), [Cron triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

| Limit | Free | Paid ($5/month) |
|---|---|---|
| CPU per HTTP request | **10 ms** | 30 s default, up to 5 min (`limits.cpu_ms`) |
| CPU per cron run | 10 ms | 30 s (interval under 1 h) / 15 min (interval 1 h or more) |
| Wall clock | HTTP: unlimited while the client is connected. Cron and queue consumer: 15 min | same |
| `waitUntil` after response | 30 s | 30 s |
| Subrequests per invocation | 50 | 10,000 |
| Concurrent outbound connections | 6 | 6 |
| Request body | 100 MB (Free/Pro zone plan) | same |
| Memory | 128 MB | 128 MB |
| Requests | 100k/day | 10M/month included |
| D1 | 10 DBs, 500 MB each, 5M rows read/day, 100k rows written/day, 50 queries per invocation, Time Travel 7 d | 10 GB per DB, 25B reads/50M writes per month included, 1,000 queries per invocation, Time Travel **30 d** |
| Queues | 10k ops/day, 24 h retention (fixed) | 1M ops/month included, then $0.40/M |
| R2 (Standard) | 10 GB-month, 1M Class A, 10M Class B, free egress | same free tier, then metered |
| Cron triggers | 5 per account | 250 per account. Times are **UTC**, and changes take up to 15 min to propagate. |

- **Waiting on fetches costs no CPU.** Waiting on Claude or Sarvam is wall-clock time, not CPU time. The 10 ms free limit is about our own work: base64-encoding a 2 MB photo or a 5 MB PDF, JSON parsing, and SQL loops. That can exceed 10 ms.
- **Pattern:** webhook handler checks the secret, deduplicates, calls `MEDIA.put` for small items or just enqueues the `file_id`, enqueues `{update_id, kind}`, and returns 200 in under 100 ms. A **queue consumer** (15 min wall clock, automatic retries, DLQ) runs getFile → R2 → STT/Claude → D1 → reply. Set `max_retries: 3` and send failures to a dead-letter queue that alerts the caregiver.
- Cron (UTC): `30 3 * * *` = 09:00 IST reminder, `30 15 * * *` = 21:00 IST digest, plus a weekly backup.
- **Recommendation: Workers Paid, $5/month (about ₹440 plus GST).** Reasons: CPU headroom for base64 work, 30-day Time Travel, no risk of daily caps on D1 or Queues, and a 15-min CPU limit for hourly or daily crons. Free works for a prototype if you keep the CPU work tiny, but the downside asymmetry is bad: silently dropped health readings cost far more than ₹440.

---

## 4. Claude API

Sources: [Vision](https://platform.claude.com/docs/en/build-with-claude/vision), [PDF support](https://platform.claude.com/docs/en/build-with-claude/pdf-support), [Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [Pricing](https://platform.claude.com/docs/en/about-claude/pricing), [API and data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention), [Commercial retention](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data)

- **Prices (per MTok):** Sonnet 5.5 is $2 input, $10 output, $0.10 cache hit. Haiku 5.5 is $0.10 input, $0.50 output, $0.01 cache hit (for prompts up to 100k tokens).
- **Images:** JPEG, PNG, GIF and WebP. Up to **10 MB base64 per image**, 8000×8000 px maximum, and a 32 MB request limit. Sonnet 5.5 is in the **high-resolution tier**: long edge 2576 px, up to 4,784 visual tokens, costing `ceil(w/28)*ceil(h/28)` tokens. A Telegram photo at 1280×960 is about 1,600 tokens, or $0.003. Put the image block **before** the text. Sources can be `base64`, `url`, or a Files API `file_id`.
  - Option: give Claude a **short-lived presigned R2 URL** as the `url` source. That avoids base64 CPU work in the Worker. **Never** use the Telegram file URL, because it contains the bot token.
- **PDFs:** a `document` block (base64, URL, or file_id). Up to 32 MB per request and 600 pages (100 below a 1M context window). Each page costs text tokens (about 1,500–3,000) plus image tokens, because pages are also rasterized. Scanned lab reports work because of the image path. Encrypted PDFs fail, so reply asking for a photo instead.
- **Structured outputs:** GA with no beta header. Use `output_config: { format: { type: "json_schema", schema } }`, or `strict: true` on a tool. Supported on `claude-sonnet-5-5` and `claude-haiku-5-5`. **Not supported in the schema:** `minimum/maximum`, `minLength/maxLength`, or recursion. Objects need `additionalProperties: false`. **Do range checks in code.** Watch for `stop_reason` of `refusal` or `max_tokens`: in both cases the output may not match the schema, so validate it anyway, using zod or a hand-written check.
- **Prompt caching:** minimum cacheable prefix is **512 tokens for Sonnet 5.5 and Haiku 5.5**. The default TTL is 5 min (write at 1.25×), and 1 h costs 2×. Reads are 0.05× on Sonnet 5.5 and 0.1× on Haiku. Use a top-level `cache_control: {type:"ephemeral"}` for automatic caching, or mark the end of the static system prompt plus tools. For our traffic (a few messages per hour), the **1 h TTL** on a long extraction or system prompt pays off after 2 hits. With the 5-min TTL it only pays off when messages arrive in bursts. Keep timestamps and per-message data **after** the cached prefix.
- **Data retention:** by default, API inputs and outputs are **deleted within 30 days**. Flagged content is kept up to 2 years. API data is **not used for training** without permission. **ZDR** requires a request to sales and is set per organization, which isn't realistic for a family project. **HIPAA-ready API** (BAA) can be enabled in the Console's Data retention page for eligible organizations. Not legally needed in India, but if eligible it is free hardening. **Files API is not ZDR or HIPAA-eligible** (files persist until you delete them), so prefer base64 or URL. **Structured-output schemas are cached separately and must not contain PHI**: keep the schema generic and never interpolate names or values into it.

---

## 5. Reading device photos (7-segment LCD)

**Prompt pattern (Sonnet 5.5, structured output):**
- The system prompt (cached) describes the device layouts:
  - **BP monitor:** three stacked numbers. Top and largest is **SYS**, middle is **DIA**, bottom and smaller is **PULSE** (often next to a heart icon). The unit is mmHg. Ignore the date and time (small digits at the top), the memory or average indicator ("M", "AVG"), and the battery icon. An irregular-heartbeat icon becomes a boolean.
  - **Pulse oximeter:** **SpO2 %** is larger or labelled `%SpO2`. **PR bpm** has a heart icon, and **PI** is a small decimal. The display is often rotated 90°/180° and may show a pleth bar. Readings fluctuate, so take what's shown.
  - **Scale:** a single number, usually with a decimal point (`72.4`). Check the unit (kg/lb/st). A flashing or locked reading isn't visible in a photo.
- Tell the model: "Transcribe only the digits you can see. If any digit is ambiguous, set it to null and explain why. Do not infer from typical values." List the 7-segment confusions to watch for: **1↔7, 5↔6, 6↔8, 8↔9/0, 3↔9**, and missing segments on an old LCD.
- Schema (generic, no PHI):
  ```json
  { "device": "bp|oximeter|scale|glucometer|thermometer|other|none",
    "readable": true,
    "values": { "sys": null, "dia": null, "pulse": null, "spo2": null, "pr": null, "weight": null, "unit": null },
    "error_code_shown": null,
    "memory_or_avg_mode": false,
    "irregular_heartbeat_icon": false,
    "uncertain_fields": ["..."],
    "retake_reason": "glare|blur|cropped|too_far|dark|display_off|not_a_device|multiple_devices|null" }
  ```
  Use number or null types. Ranges can't go in the schema, so they live in code.

**Validation in code (deterministic):**
- Plausibility checks. BP: SYS 60–260, DIA 30–160, SYS − DIA at least 10, pulse 30–200. SpO2: 50–100, PR 30–220. Weight: 20–200 kg, and within ±3 kg of the last reading, or else confirm. Outside the range means **retake or confirm**, never silent storage.
- Treat these as **errors, not values**: `E1`, `Err`, `EE`, `---`, `Lo`, `HI` (HI is also a possible red flag, so ask), kPa or lb units (convert explicitly), and memory mode. Memory mode means an old stored reading.
- Optional self-consistency check: when `uncertain_fields` is non-empty, or a value is near a red-flag threshold, run the extraction a second time with temperature 0 and a "re-read digit by digit" prompt. If the two runs disagree, ask for a retake.
- **Always echo the values back** as text plus ✅ सही / ❌ गलत buttons, restricted to the patient (or the caregiver). Store with `status='pending'`, and only `confirmed` readings feed trends. Red-flag rules run on the extracted value immediately, but the alert should say "(अपुष्ट / unconfirmed)" until confirmed.

**Ask for a retake when** `readable=false`, `retake_reason` is set, a required field is null, the plausibility check fails, an error code is shown, more than one display is in frame, or the image is under about 400 px. Retake hints in Hindi: "फ़ोटो सीधे सामने से, बिना चमक (glare) के, स्क्रीन पूरी दिखे". Cap it at **two retakes**, then fall back to "बोलकर बता दीजिए" (say the numbers in a voice note), which goes through the STT path.

---

## 6. Ops

- **D1 backups:**
  - Time Travel is always on and free: 30 days on Paid, 7 on Free. Restore with `wrangler d1 time-travel restore <d1-name> --timestamp=<unix|RFC3339>`. A restore is **destructive and in place**, but it prints a bookmark you can use to undo it. ([docs](https://developers.cloudflare.com/d1/reference/time-travel/))
  - For longer retention, run a **weekly cron** that `SELECT`s every table and writes gzipped NDJSON to R2 as `backups/YYYY-MM-DD/*.ndjson.gz`. The DB is tiny, this needs no API token, and it stays inside Paid CPU limits. Alternatives: the D1 REST export API driven by Workflows (the "Export and save D1 database" guide linked from the Time Travel page), or a manual `wrangler d1 export <d1-name> --remote --output=backup.sql` from a laptop once a month. Set an R2 lifecycle rule to delete backups after 1 year.
  - Test restores: once, import a backup into a scratch D1 and run queries against it.
- **Secrets:** use `wrangler secret put TELEGRAM_BOT_TOKEN`, then `TELEGRAM_WEBHOOK_SECRET` (random 64 characters from `[A-Za-z0-9_-]`), `ANTHROPIC_API_KEY` and `SARVAM_API_KEY`. Put local values in `app/.dev.vars`, which is **gitignored**. Keep only non-secret values in `wrangler.toml [vars]`: chat IDs, patient Telegram user IDs and timezone. Rotate the bot token with BotFather `/revoke` if it ever lands in logs, then call setWebhook again.
- **Logging without PHI:** Workers Logs keep `console.log` output, and invocation logs include request metadata.
  - Log only: `update_id`, a hash or alias of the chat or user (for example `patient=mom`), message kind, R2 key, provider latency, HTTP status, token usage and cost.
  - **Never log** message text, transcripts, extracted values, captions, file URLs (they contain the bot token), or full provider error bodies (they may echo input).
  - Wrap `fetch` errors so the URL is redacted. Turn off any request-body logging. Store PHI only in D1 and R2.
  - R2 bucket: private, no public `r2.dev` URL. Presigned URLs should expire in 5 minutes or less.
- **Monthly cost estimate.** Workload: 2 patients, about 6 photos/day, 6 voice notes/day averaging 40 s, 15 text messages/day, 4 PDFs/month at 5 pages each, and 30 Q&A questions/month from the caregiver.

| Item | Calculation | USD | INR |
|---|---|---|---|
| Sonnet 5.5 vision | ~200 photos incl. retakes × (~2.5k image + ~1k uncached + ~1.5k cached prompt tokens in, 300 out) ≈ $0.01 each | ~2.0 | ~175 |
| Sonnet 5.5 PDFs | 4 × (~25k in, 2k out) | ~0.5 | ~45 |
| Sonnet 5.5 Q&A (SQL tool) | 30 × ~20k in / 1k out | ~1.5 | ~130 |
| Haiku 5.5 routing + Hindi replies | ~700 calls × 2k in / 200 out | ~0.25 | ~20 |
| Sarvam STT | 6 × 40 s × 30 days ≈ 2 h × ₹30 | — | ~60 |
| Cloudflare Workers Paid | flat; D1, R2, Queues and Cron stay inside the included quotas | 5.0 | ~440 |
| Telegram | free | 0 | 0 |
| **Total** | | | **≈ ₹870/month, ≈ ₹1,000–1,100 with 18% GST** |

  Claude costs swing with retakes and Q&A volume. Even at 3× the estimate, the total stays under ₹1,500. On Workers Free the total is about ₹450, but see the CPU risk above. Set a **monthly spend limit** in the Anthropic Console (for example $15), and put a per-day call counter in D1 to catch runaway loops.

---

## Decisions for the builder

1. **Bot is a group admin** with no extra rights. Keep BotFather privacy mode as is. Add the admin step to the setup checklist.
2. **Webhook handler is minimal:** constant-time `X-Telegram-Bot-Api-Secret-Token` check → `INSERT OR IGNORE` on `update_id` → enqueue → 200. All slow work goes in a **Queue consumer** with `max_retries=3` and a DLQ.
3. **Identity:** keep a `members` table mapping Telegram `user_id` to patient or caregiver. Readings attach to the **sender**. If a caregiver sends a photo, ask "किसका है?" with buttons.
4. **Callback auth:** each button's `callback_data` is a short D1 key. The handler checks `from.id` is allowed for that action. Always `answerCallbackQuery`, then edit the buttons away. State changes are idempotent.
5. **Media:** download through getFile in the consumer and store in R2 as `media/<chat>/<yyyy-mm>/<file_unique_id>.<ext>`. Reject files over 20 MB. Use `file_unique_id` to deduplicate re-sent media.
6. **STT:** use Sarvam `saaras:v4` with `hi-IN` and `codemix` (fall back to `transcribe`) plus drug-name `keyterms`. Use REST if `voice.duration` is 30 s or less, else Batch with delayed-queue polling. No transcoding. **Opt out of Sarvam training** before going live.
7. **Vision:** Sonnet 5.5 with `output_config.format` JSON schema (generic, no PHI). Range checks, error codes and retake rules live in code. Echo values and confirm by button, with pending vs confirmed status.
8. **Haiku 5.5** handles intent routing and short Hindi replies, using a cached system prompt. Reply with `parse_mode: HTML`, escape `<>&`, and keep replies under about 500 characters.
9. **Acknowledge immediately** with `setMessageReaction` (👍) on receipt, plus `sendChatAction` while processing.
10. **Handle `migrate_to_chat_id`.** Store the chat ID in D1, not just in `[vars]`.
11. **Workers Paid plan.** Crons are in UTC (IST − 5:30). Back up D1 weekly as NDJSON to R2. Logs are PHI-free and never contain Telegram file URLs.
12. **Don't use** ephemeral messages for anything important, Local Bot API server, ffmpeg.wasm, the Files API (not ZDR-eligible), or the Telegram file URL as a Claude image source.
