# Architecture options: a family health-logging chat bot

Researched 2026-10-24. Prices are from vendor pages or secondary sources as cited, and they change quarterly. Re-check before committing money.
FX assumption: 1 USD = ₹88. GST (18%) is extra unless noted.

## TL;DR

- **Channel:** use the WhatsApp Cloud API directly from Meta, with no BSP, on a dedicated cheap prepaid SIM. Family members keep using the app they already know. At 2 users the cost is close to zero because of Meta's 1,000 free service messages per month per number.
- **Speech-to-text:** Sarvam `saaras:v3` (or v4) for Hindi and Hinglish, with Gemini as the fallback. Avoid OpenAI's transcribe models for Hindi.
- **Extraction:** Claude Sonnet 5.5 vision with structured outputs (JSON schema) for device photos and reports. Claude Haiku 5.5 handles routing, text messages and Hindi acknowledgements.
- **Red flags:** deterministic threshold rules in code. The LLM is never the alerting authority.
- **Hosting:** one Cloudflare Worker, with D1 (SQLite) for the time series, R2 for raw media, Queues/Cron for async work and reports.
- **Q&A:** Claude Sonnet 5.5 with a read-only SQL tool over D1. No vector DB.
- **Cost:** about **₹1,000–1,700/month** all-in (details below). The LLM is about half of that.
- **First milestone:** a family member sends a BP-monitor photo to a Meta test number, a Worker extracts SYS/DIA/pulse into D1, and the bot replies in their language (Hindi in this study) with the values so they can confirm them.

---

## 1. Channel

### Facts that drive the decision (2026)

- **Pricing model:** Meta has charged per delivered message since 2025-07-01. Conversation-based pricing is deprecated. Messages *from* users to the business are free. [Meta pricing](https://developers.facebook.com/docs/whatsapp/pricing)
- **2026-10-01 change:** service messages (free-form replies inside the 24h customer-service window) and utility messages sent inside an open window are now charged. **Each business number gets 1,000 free service messages per month.** Beyond that, India pays ₹0.115 per service message. [Meta pricing](https://developers.facebook.com/docs/whatsapp/pricing), [Free Press Journal, 2026-09-30](https://www.freepressjournal.in/tech/how-much-does-india-have-to-pay-for-whatsapp-messages-from-october-1)
- **India rate card (third-party reported):** marketing ₹0.8631, utility ₹0.115, authentication ₹0.115 per message. [FPJ](https://www.freepressjournal.in/tech/how-much-does-india-have-to-pay-for-whatsapp-messages-from-october-1), [baat.ai](https://baat.ai/blog/whatsapp-api-pricing-india)
- **24h window:** a user message opens a 24h window for free-form (non-template) replies. Outside it, only pre-approved **templates** can be sent. This matters for reminders ("आज का BP भेजिए") and for alerts to the caregiver when they haven't messaged recently. Use utility templates for those.
- **Billing:** INR billing for eligible accounts since 2026-01-01. Non-INR accounts must migrate by 2026-12-31. A payment method must be on file. [Meta pricing](https://developers.facebook.com/docs/whatsapp/pricing)
- **Media download:** the webhook carries a media ID. `GET /<ver>/<MEDIA_ID>` returns a URL that **expires in 5 minutes**. Download it with the bearer token. Incoming media IDs stay downloadable for 7 days. Audio is OGG/Opus mono (WhatsApp voice notes), up to 16 MB. Images up to 5 MB, documents up to 100 MB. [Meta media reference](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media)
- **Number setup friction:** "Get Started" auto-provisions a **test business number**, which is enough for the first milestone. A production number must be one you own that can receive SMS or a voice call, with a 2-step PIN. A number **active on regular WhatsApp can't be registered until it is deleted from the app**. Meta advises against using a personal number. [Meta phone numbers](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers/) **"Coexistence"** lets a WhatsApp *Business app* number also be on the Cloud API, but regional support is inconsistent and it adds complexity. [Telnyx](https://telnyx.com/release-notes/whatsapp-coexistence) Simplest path: buy a new prepaid SIM for the bot and save it in the family's phones as "Health Diary".

### Comparison

| Option | Setup friction | Monthly cost at 2 users | Ban risk | Privacy | Verdict |
|---|---|---|---|---|---|
| **WhatsApp Cloud API (Meta direct)** | Medium: Meta dev app, WABA, new SIM, webhook, templates for reminders. About half a day. | ~₹0–10 in Meta fees (within the 1,000 free service tier) + SIM upkeep | None (sanctioned) | Meta hosts the Cloud API and decrypts messages sent to the business. Not end-to-end to your server. | **Recommended** |
| BSP: Twilio | Low–medium | Meta fees + **$0.005/msg Twilio fee** on top. [Twilio](https://support.twilio.com/hc/en-us/articles/53100480177819-Notice-Changes-to-WhatsApp-s-Pricing-October-2026), [Landbot](https://landbot.io/blog/twilio-whatsapp-pricing) | None | Adds a second processor | Pointless middleman at this scale |
| BSP: Gupshup / AiSensy / Interakt | Low (no-code dashboards) | Monthly subscription + typically ₹0.10–0.30/msg markup (third-party estimate). [baat.ai](https://baat.ai/blog/whatsapp-api-pricing-india) | None | Third processor, marketing-oriented | Built for marketing campaigns, not a 2-user bot |
| **Telegram bot** | Lowest: BotFather token, no number, no templates, no 24h window | ₹0 | None | Bot chats are cloud chats, not E2E. Telegram servers see the content. [Bot API](https://core.telegram.org/bots/api) | Best developer experience, but family members must learn a new app. **Fallback** if Meta setup stalls. |
| Unofficial WhatsApp Web libs (Baileys, whatsapp-web.js) | Low (QR-pair a number) | ₹0 | **Real.** They reverse-engineer WhatsApp and violate the ToS. Malicious npm forks exist (e.g. `@fhkry/baileys`). [checkleaked](https://whatsapp.checkleaked.cc/blog/best-open-source-whatsapp-libraries), [OSV MAL-2026-4803](https://osv.dev/vulnerability/MAL-2026-4803) | Session keys on your server | **Reject.** A ban silently kills the health log, and the supply-chain risk is unacceptable for medical data. |

**Message-volume check:** about 10 inbound per sender per day is ~600 inbound per month (free). Replies/acks are ~600 service messages per month, under the 1,000 free tier. Reminder/alert templates outside the window are ~60–90 utility messages × ₹0.115 ≈ ₹10.

---

## 2. Hindi speech-to-text

### Accuracy evidence

The best independent 2026 evidence is **Josh Talks "Voice of India"** (April 2026). It covers 46.9 h of unscripted Hindi telephonic conversations from 4,270 speakers in 306 districts, keeps natural Hindi–English code-switching, and deliberately includes 3–7% noisy audio. Scoring is OI-WER, which accepts valid spelling variants; lower is better. It reports no age-specific results, so **older speakers' speech is untested everywhere**. [Voice of India](https://voiceofindiablogs.ai.joshtalks.com/)

| System | Hindi OI-WER | Price | Notes |
|---|---|---|---|
| Sarvam Audio | **5.0%** | n/a (LLM-style audio model) | Top of the table |
| Gemini 3 Pro | 6.0% | Token-priced (Gemini API) | Best non-Indic-specialist |
| **Sarvam Saarika v2.5** | 6.2% | **₹30/hour** STT, billed per second. [Sarvam pricing](https://docs.sarvam.ai/api/pricing) | Now legacy. Successor `saaras:v3` (default) / v4 has `transcribe`, `translit`, `codemix` modes, 22 Indic languages + English. REST ≤30 s audio, Batch ≤2 h. [Saaras docs](https://docs.sarvam.ai/api-reference-docs/models/saaras) |
| ElevenLabs Scribe v2 | 7.7% | **$0.22/hour** batch (~₹19). [ElevenLabs](https://elevenlabs.io/pricing/api) | Cheapest strong option |
| AI4Bharat IndicConformer | 8.2% | Free, MIT, self-host (NeMo fork, ~120M params Hindi model). [GitHub](https://github.com/AI4Bharat/IndicConformerASR), [HF](https://huggingface.co/ai4bharat/indicconformer_stt_hi_hybrid_ctc_rnnt_large) | Needs GPU/CPU hosting. Not worth the ops cost for 2 h/month. |
| Gemini 3 Flash | 8.3% | Gemini 3.x Flash ~$0.75/M input tokens until 2026-12-31, then $1.50. [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing) | Free tier data **is** used to improve Google products. Use the paid tier only. |
| GPT-4o Mini Transcribe | 19.6% | ~$0.003/min. [CostGoat](https://costgoat.com/pricing/openai-transcription) | Weak on Hindi |
| GPT-4o Transcribe | **34.0%** | ~$0.006/min | **Avoid for Hindi** |
| Google Chirp 3 (Cloud STT v2) | not in benchmark | From ~$0.016/min (secondary). [OpenRouter](https://openrouter.ai/google/chirp-3) | Hindi GA status unverified |
| Claude (any model) | n/a | n/a | **No audio input.** The API takes text, images and PDFs only. [Claude features](https://platform.claude.com/docs/en/build-with-claude/overview) |

**Latency:** async voice notes make latency nearly irrelevant. Sarvam REST (≤30 s clips) is synchronous; longer notes go to Batch (5 s polling by default) or get split into ≤30 s chunks. [Sarvam rate limits](https://docs.sarvam.ai/api-reference-docs/getting-started/pricing)

**Recommendation:** Sarvam `saaras:v3` in `codemix` mode, since medical terms like "BP", "sugar" and "tablet" come out in Latin script and that helps extraction. Sarvam's free signup credits (₹100) cover the pilot. Keep the raw OGG in R2 so you can re-transcribe later with a better model. Build a 30-clip eval set from real voice notes in week 1. Re-test ElevenLabs Scribe v2 and Gemini 3 Pro on it before locking in, because older speakers and regional accents are not benchmarked anywhere.

---

## 3. Device photos and reports

**Evidence:** I found no published benchmark of vision LLMs on 7-segment BP/oximeter LCD photos. Classical pipelines report 93–100% digit accuracy on curated sets: EfficientDet 100% on 104 images [arXiv 2210.01325](https://arxiv.org/pdf/2210.01325), 98.2% for smartphone ML [arXiv 1807.04888](https://arxiv.org/pdf/1807.04888), 93% for an Oxford synthetic-trained classifier [Oxford](https://eng.ox.ac.uk/lcmt/resources/resources-seven-segment). Generic OCR (Tesseract) is known to struggle with 7-segment digits. [HF forum](https://discuss.huggingface.co/t/help-needed-extracting-blood-pressure-glucose-readings-using-ml/142783)

| Approach | Strengths | Weaknesses | Fit |
|---|---|---|---|
| **Vision LLM (Claude Sonnet 5.5)** | Zero training. Understands *which* number is SYS/DIA/PUL from labels and layout. Handles glare and rotation reasonably. Reads reports and handwriting in the same call. | Can hallucinate a plausible digit. No published 7-seg accuracy. | **Default** |
| Gemini 3.x Flash vision | Cheap; one vendor for audio + vision | Second vendor, second data processor | Fallback / cross-check |
| Tesseract / cloud OCR | Cheap, deterministic | Poor on 7-segment; no semantics (which number is which) | Reject |
| Custom detector (YOLO/EfficientDet) | Highest reliability per the literature | Needs labelled data and hosting. Overkill for 2 devices. | Only if the LLM error rate stays unacceptable |

**Structured output:** Claude supports **structured outputs** (guaranteed JSON-schema conformance via JSON outputs or strict tool use) and PDF input. Prompts and outputs are not stored; only schemas are cached for 24 h. [Claude features](https://platform.claude.com/docs/en/build-with-claude/overview)

Suggested schema per message: `{kind: bp|spo2|pulse|weight|glucose|symptom|report|other, readings:[{metric, value, unit, measured_at?}], device_display_visible: bool, confidence: 0-1, unreadable_reason?, symptoms:[{body_part, description_hi, description_en, severity_0_10?}], report:{lab, date, tests:[{name, value, unit, ref_range, flag}]}}`.

**Accuracy guardrails (more important than model choice):**
1. Echo every extracted value back to the sender in their language and ask for confirmation: "BP 128/82, पल्स 76 दर्ज किया। सही है? 👍 / ❌". This puts a human in the loop at zero cost.
2. Plausibility checks in code (SYS 60–250, DIA 30–150, SpO2 70–100, SYS > DIA). If a value fails, ask the sender to re-photograph.
3. If `confidence < 0.8` or the reading would trigger a red flag, re-run extraction once (or on Opus 5.5) and require the two results to agree before alerting.
4. Keep every photo in R2 so any reading can be audited.

---

## 4. Storage and hosting

| Option | Monthly cost | Ops burden | Notes |
|---|---|---|---|
| **Cloudflare Workers + D1 + R2 (+ Queues, Cron)** | ₹0 on the free tier. **$5 (₹440)** Workers Paid if you need Queues/Workflows or more CPU. | Near zero: no OS, no patching | Free: R2 10 GB, D1 5 GB, ~100k Worker req/day; R2 has no egress fees. [secondary summary](https://eastondev.com/blog/en/posts/dev/20260526-cloudflare-free-limits/) D1 is SQLite, which is ideal for a 2-person time series. Not hosted in India. |
| Small VPS (Mumbai region, e.g. Lightsail/DigitalOcean BLR) | ~₹400–900 | Medium: patching, backups, TLS, uptime | Choose this only if India residency becomes a hard requirement |
| Supabase | Free tier **pauses after 7 days of low activity**; Pro $25 (₹2,200). [Supabase docs](https://supabase.com/docs/guides/platform/free-project-pausing.md) | Low | Postgres is nice but overpriced here; pausing risk on free |
| Google Sheets as DB | ₹0 | Low | Good human-readable *view*, bad source of truth (no schema, sharing-permission foot-guns). Optional nightly export for the caregiver/doctor. |

**Privacy and DPDP (India):**
- The DPDP Act 2023 **does not apply to personal data processed by an individual for a personal or domestic purpose** (s.3). A family member running a private tracker for relatives almost certainly falls under this. Not legal advice. [dpdpa.com s.3](https://dpdpa.com/dpdpa2023/chapter-1/section3.html)
- Even if it applied: cross-border transfer is allowed by default under a **negative list** (s.16), and no restricted list has been notified (per secondary sources). [Taxmann](https://www.taxmann.com/post/blog/cross-border-data-transfers-under-the-dpdp-act/) The DPDP Rules were notified in Nov 2025, with core data-fiduciary obligations phased in by ~May 2027. [Deccan Herald](https://www.deccanherald.com/india/centre-notifies-dpdp-rules-implementation-planned-in-phases-spread-over-12-18-months-3798465), [AZB](https://www.azbpartners.com/?p=87799)
- **Consent:** get each person's explicit consent anyway, and record it in the records repo.
- **Processors in the data path:** Meta (WhatsApp Cloud API), Sarvam (India company), Anthropic (Claude API, global routing; `inference_geo` offers only `global`/`us`; ZDR only by arrangement). [Claude data residency](https://platform.claude.com/docs/en/manage-claude/data-residency), [Claude retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention) Cloudflare: D1/R2 encrypted at rest.
- **Controls:** allowlist the sender phone numbers. Verify `X-Hub-Signature-256` on every webhook. Keep secrets in Worker secrets. Make the R2 bucket private, with no public URLs; serve reports as signed or short-lived links, or send them as WhatsApp documents. Run weekly D1 export to an encrypted backup (`age`) somewhere you control.

---

## 5. LLM layer and monthly cost

Claude prices (USD per million tokens, input/output): **Haiku 5.5 $0.10/$0.50** (prompts ≤100k tokens), **Sonnet 5.5 $2/$10**, **Opus 5.5 $4/$20**. Batch is −50%. Cache hits are 0.05× on Sonnet/Opus 5.5. [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing)

| Task | Model | Volume/month (2 people, ~10 msgs/day each) | Est. tokens per call (in/out) | USD |
|---|---|---|---|---|
| Route/classify + Hindi ack, text and transcript extraction | Haiku 5.5 | ~600 | 2k / 300 | ~$0.2 |
| Device-photo extraction (structured) | Sonnet 5.5 | ~240 | 2.5k / 200 | ~$1.7 |
| Lab/discharge report extraction (PDF, ~10 pages) | Sonnet 5.5 | ~8 | 25k / 2k | ~$0.6 |
| Red-flag double-check re-extraction | Opus 5.5 | ~20 | 3k / 300 | ~$0.4 |
| Weekly doctor-ready report (per person) | Sonnet 5.5 (Batch) | 8 | 50k / 3k | ~$0.5 |
| Monthly specialist summary | Opus 5.5 | 2 | 80k / 4k | ~$0.8 |
| Q&A over history (SQL tool) | Sonnet 5.5 | ~60 | 20k / 500 | ~$2.7 |
| **Total LLM** | | | | **~$7 (~₹620); budget $10–12 (~₹1,000) with retries and verbose prompts** |

**Q&A design:** give Claude a `run_sql(query)` tool bound to a **read-only** D1 connection, plus the schema and patient profile in a cached system prompt. Two people's readings fit easily in SQL, so skip embeddings and vector DBs. Return charts by rendering a PNG/HTML in the Worker or in the report job.

### All-in monthly estimate

| Item | ₹/month |
|---|---|
| Claude API (budget) | ~600–1,000 |
| Sarvam STT (~3 h of voice notes at ₹30/h) | ~90 |
| WhatsApp Meta fees (within free service tier + ~60–90 utility templates) | ~10 |
| Dedicated prepaid SIM upkeep (assumption: cheapest validity pack) | ~150–200 |
| Cloudflare (free → Workers Paid) | 0–440 |
| **Total** | **~₹850–1,750; plan for ~₹1,500** |

One-time cost: optional Bluetooth BP monitor ~₹2,800–3,000 (Omron HEM-7156T, [price history](https://www.pricebefore.com/omron-hem-7156-t-digital-blood-pressure-monitor-3600-accuracy-p685453.html)) and a digital weight scale (weight trends matter for several chronic conditions; see risks).

---

## 6. Buy instead of build?

| Alternative | What it does | Why it doesn't replace the bot |
|---|---|---|
| ABHA app / ABDM PHR | Self-upload records, link ABHA, share reports with ABDM-linked facilities. [Vikaspedia](https://en.vikaspedia.in/viewcontent/health/health-care-innovations/ayushman-bharat-digital-mission-health-care-innovations-1/abha-mobile-application-to-manage-health-records-under-ayushman-bharat-digital-mission?lgn=en) | No Hindi voice logging, no vitals trending or alerts. **Complementary:** use it to pull hospital/lab records later. |
| Eka Care, DRiefcase (Indian PHRs) | Report storage, ABHA creation; DRiefcase has a journal. [Eka](https://apps.apple.com/app/id1561621558), [DRiefcase](https://www.actcorp.in/driefcase) | App-based UX, no custom per-condition red-flag rules, data locked in a vendor |
| Google Health Connect / Apple Health | On-device health data hub fed by device apps | Needs a native companion app to read data off the phone. Users still have to open apps. No Hindi voice, no reports. |
| BLE devices (Omron Connect BP monitors, BLE scales/oximeters) | Auto-sync readings to the vendor app; removes OCR error | Vendor app silos; an export path into your DB is unverified (Health Connect support not confirmed for Omron India). Phone pairing/battery adds friction for older users. |

**Verdict:** build the thin WhatsApp bot. The unique value (Hindi voice symptoms, a single chat UX the family already uses, condition-specific alerts, doctor reports) isn't offered by any existing app. Revisit BLE plus Health Connect in phase 3 *only* if photo extraction errors prove annoying.

---

## Recommended MVP stack

```
Family WhatsApp ──> WhatsApp Cloud API (Meta, own WABA, dedicated SIM)
                         │ webhook (verify X-Hub-Signature-256, allowlist numbers)
                         ▼
                Cloudflare Worker  ── download media within 5 min ──> R2 (raw audio/photos/PDFs)
                         │ enqueue
                         ▼
                Queue consumer:
                  audio  → Sarvam saaras:v3 (codemix) → transcript
                  image/pdf/text/transcript → Claude (Haiku route; Sonnet 5.5 structured extraction)
                  → D1: messages, readings, symptoms, documents, alerts
                  → rules engine (code, thresholds from the doctor) → alert the caregiver via WhatsApp template
                  → confirmation reply to the sender
                Cron: weekly report (Sonnet, Batch) / monthly (Opus) → PDF in R2 → WhatsApp document to the caregiver
                Q&A: caregiver messages bot → Sonnet 5.5 + read-only run_sql tool
```

Language: TypeScript on Workers, with the Anthropic TS SDK and plain `fetch` for Meta and Sarvam. No framework.

## Risks

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| 1 | **Silent misread of a reading** (LLM hallucinates a digit or swaps SYS/DIA) leads to a false alarm or missed alarm | High (care decisions rest on vitals) | Echo-back confirmation, plausibility rules, dual extraction before alerting, photos retained for audit, weekly manual spot check of 10 photos |
| 2 | **Red-flag logic wrong or untuned** for the patient's condition | High | Thresholds come from the treating doctor (recorded in the records repo). Deterministic code, not the LLM. Alerts go to the caregiver, never to the patient as medical advice (a non-goal). Add a **weight** trend rule if the doctor asks for one, so get a scale. |
| 3 | **Third-party exposure of medical data** (Meta, Anthropic, Sarvam, Cloudflare); no India residency | Medium | Domestic-use DPDP exemption; minimise PII in prompts (use pseudonymous IDs); private R2; allowlist; encrypted backups. If residency becomes mandatory, move storage to a Mumbai VPS (LLM calls stay offshore regardless). |
| 4 | Meta platform friction: number registration, template approval, payment method, pricing changes each quarter (e.g. the Oct-2026 service charge) | Medium | Keep the channel adapter thin; Telegram adapter as a ready fallback |
| 5 | Older speakers' or noisy voice notes transcribe poorly (unbenchmarked) | Medium | Own 30-clip eval; keep raw audio for re-transcription; the sender can always send text or a photo instead |
| 6 | Adoption: family members stop sending | High (no data) | Daily reminder template at a fixed time; zero-friction acks; the caregiver reviews the weekly report with them |
| 7 | Over-reliance on the bot instead of calling the doctor | High | Every alert says "call the doctor / caregiver". Emergency symptoms (chest pain, breathlessness at rest, fainting) trigger an immediate call-out text to the caregiver, not just a log entry. |

## Smallest first milestone (1–2 evenings)

**"A family member's BP photo becomes a confirmed row in D1."**

1. Create the Meta developer app with the auto-provisioned **test number** and add the sender's and caregiver's phones as test recipients. No SIM, no business verification.
2. Cloudflare Worker: webhook verify plus signature check, sender allowlist, download the image to R2.
3. One Claude Sonnet 5.5 call with a JSON schema `{sys, dia, pulse, confidence, unreadable_reason}`, then plausibility checks.
4. Insert into a D1 `readings` table; reply in Hindi with the values and a 👍/❌ prompt; store their confirmation.
5. Run it for 7 days, then measure the extraction accuracy against the photos.

Success means at least 95% correct readings and the first sender using it unprompted for a week. Then add voice notes (Sarvam), red-flag rules, a second person, reports, and Q&A, in that order.
