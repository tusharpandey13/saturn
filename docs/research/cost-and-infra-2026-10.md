# Bot running cost and infra consolidation (2026-10-25)

> Outcome: ADR 005 (2026-10-25) moves the bot to the Workers **Free** plan (ingest only) plus a daily batch in GitHub Actions; target ≈ $1/month, $0 fixed. Sections 1, 3 and 6 describe the earlier real-time design.

Research only. Prices were checked 2026-10-25 on the pages cited. Rate used: **₹95 = $1**. The latest observed rate was about ₹95–96 (Aug–Sep 2026 market reports via web search, no official October fixing). Totals leave out GST: 18% may apply on foreign digital services, and Sarvam's INR prices may also be before GST.

## 1. What the app actually calls (app/ as of today)

- **Cloudflare**: one Worker (`fetch` webhook, `queue` consumer, `scheduled` cron every 5 min = 8,640 runs/month), **D1** (`<d1-name>`), **R2** (`<bucket>`: raw photos, PDFs, voice), **Queues** (`<queue>` + DLQ, batch size 1, plus delayed `stt_poll` jobs). `wrangler.toml` targets **Workers Paid** because base64-encoding photos breaks the Free plan's 10 ms CPU limit. No Workers AI.
- **LLM** (`app/src/extract/claude.ts`): **one Anthropic call per inbound patient message**. Exceptions: confirmations (`haan`/`nahi`/buttons) and messages from non-patients make no call. No model fallback.
  - Text and voice transcripts: `claude-haiku-5-5`, effort low, structured output, max 4,000 tokens.
  - Photos and PDFs: `claude-sonnet-5-5`, effort medium, structured output, max 8,000 tokens.
  - Prompt: SYSTEM is about 1,330 chars (~450 tokens). The JSON schema adds ~700. The user turn adds ~100. That is **~1,300 input tokens** before any media. Output is ~150–300 JSON tokens plus reasoning. Estimates below: Haiku **400 out**. Sonnet **1,500 out**, with **~4,000 media tokens**: Telegram photos are 1,280 px (~1,600 tokens); file uploads and PDFs run up to 4,784 tokens per image or page on Claude 4.7+ models.
- **Sarvam** (`app/src/stt/sarvam.ts`): STT only, `saaras:v4`, `hi-IN`. REST for clips ≤30 s, the batch job API for longer ones. Translation is not used.
- **No weekly summary in the code yet.** It is costed below as an assumption: one Sonnet 5.5 call, ~20k tokens in and 2k out.
- **Git sync** (ADR 004, not built; `.github/workflows/` does not exist yet): `d1-sync.yml` every 3 h. The ADR estimates ~1 min per run, ~240 min/month.

## 2. Prices (checked 2026-10-25)

| Item | Price | Source |
|---|---|---|
| Workers Paid | $5/mo; 10M requests + 30M CPU-ms included; then $0.30/M requests, $0.02/M CPU-ms; cron billed as requests | developers.cloudflare.com/workers/platform/pricing/ |
| D1 (Paid) | 25B rows read, 50M rows written, 5 GB included; then $0.001/M reads, $1/M writes, $0.75/GB | same page |
| Queues (Paid) | 1M ops included (≈3 ops per message), then $0.40/M | same page |
| R2 Standard | 10 GB-mo, 1M Class A, 10M Class B free; then $0.015/GB, $4.50/M A, $0.36/M B; egress free | developers.cloudflare.com/r2/pricing/ |
| Claude Sonnet 5.5 | $2 in / $10 out per MTok; 5-min cache write $2.50, cache hit $0.10; Batch $1/$5 | platform.claude.com/docs/en/about-claude/pricing |
| Claude Haiku 5.5 (≤100k prompt) | $0.10 in / $0.50 out; cache hit $0.01; Batch $0.05/$0.25 | same |
| Claude Haiku 4.5 | $1 / $5 (more expensive than Haiku 5.5) | same |
| Prompt caching minimum | 512 tokens for Sonnet 5.5 and Haiku 5.5 | platform.claude.com/docs/en/build-with-claude/prompt-caching |
| Image tokens | ⌈w/28⌉×⌈h/28⌉, capped at 4,784 (2,576 px long edge) on 4.7+ models | platform.claude.com/docs/en/build-with-claude/vision |
| DeepSeek flash | peak $0.30 in (miss) / $1.20 out; off-peak half; vision supported | api-docs.deepseek.com/quick_start/pricing |
| Gemini 3.1 Flash-Lite / 3.6 Flash | $0.25/$1.50; $0.75/$3.75 (rising to $1.50/$7.50 on 2027-01-01); free tier trains on data | ai.google.dev/gemini-api/docs/pricing |
| OpenAI gpt-5-nano / gpt-5-mini | $0.05/$0.40; $0.25/$2.00 | developers.openai.com/api/docs/pricing |
| Sarvam STT | ₹0.49/min pay-as-you-go (₹0.45 Pro), batch at the same rate; translation ₹2 per 1k chars (unused) | sarvam.ai/api-pricing |
| GitHub Actions (private) | 2,000 min/mo free (Free plan and Free org); Linux 2-core $0.006/min; macOS $0.062/min | docs.github.com/en/billing/concepts/product-billing/github-actions |

## 3. Monthly estimate (2 people sending, 30.4 days)

Assumptions: every text message costs one Haiku call. This is an upper bound, because confirmations are free. Voice notes per day: 2 (low), 4 (expected), 10 (high), each one Haiku call. Unit costs: Haiku text call ≈ $0.00033. Sonnet photo call ≈ $0.026. Weekly summary ≈ $0.06 (×4.33).

| Line item | Type | Low | Expected | High |
|---|---|---|---|---|
| Cloudflare Workers Paid (covers Worker, D1, Queues, R2, cron; all usage stays inside the included quotas) | **fixed** | $5.00 | $5.00 | $5.00 |
| Haiku 5.5: text + transcripts (243 / 578 / 1,520 calls) | variable | $0.08 | $0.19 | $0.50 |
| Sonnet 5.5: photos/PDFs (4.3 / 13 / 30 calls) | variable | $0.11 | $0.33 | $0.78 |
| Sarvam STT (30 / 91 / 304 min) | variable | $0.16 (₹15) | $0.47 (₹45) | $1.56 (₹149) |
| Weekly summary, Sonnet 5.5 (assumed; not built) | variable | $0 | $0.26 | $0.26 |
| GitHub Actions d1-sync (~240 min) | fixed, free | $0 | $0 | $0 |
| **Total USD** | | **$5.35** | **$6.25** | **$8.10** |
| **Total INR (₹95/$)** | | **₹508** | **₹594** | **₹770** |

Cost drivers: **the $5 Cloudflare base fee is 62–94% of the bill.** The variable costs are small: STT is the largest variable item at high usage, Sonnet vision at expected usage. Even 10× the high scenario stays under ~$35/month. Nothing in Cloudflare's included quotas comes close to being used up: ~2k messages/month against 10M requests and 1M queue ops; media in the hundreds of MB against 10 GB free.

Same text workload on other models (expected scenario, 578 calls): Haiku 5.5 $0.19. gpt-5-nano ~$0.13. DeepSeek flash (peak) ~$0.50. Gemini 3.1 Flash-Lite ~$0.53. **Haiku 5.5 is already at or near the cheapest option.** A second provider would save cents and add a key, an SDK and a new place where medical data goes. DeepSeek and Gemini's free tier also raise privacy concerns.

### Cost levers (in order of value)
1. **Set spend caps first** (Anthropic console monthly limit of ~$10; Cloudflare usage notifications). The real risk is a retry loop or a leaked key costing a lot, not the steady-state bill.
2. **Use Sonnet only when needed.** Send device photos (BP, oximeter, scale) to Haiku 5.5. Escalate to Sonnet on `unreadable_reason`, low confidence or a PDF. Also downscale uploads to a 1,568 px long edge. Saves about $0.30/mo at expected volume, about 5% of the bill. The sender's confirmation step limits the risk, but a SYS/DIA misread is the asymmetric risk, so test this on real photos before switching.
3. **Run the weekly summary and other analysis in batch, or on a flat-rate plan (an env choice)**: Batch API at 50% off, or `claude` CLI on the agent server at no extra cost. Prompt caching is not worth it: messages arrive minutes to hours apart, past the 5-min TTL, and a cache write costs 1.25×.
- Not recommended: dropping to the Workers Free plan to save the $5. It would need streaming uploads instead of base64, and checks that Queues and the CPU limit fit. A silent failure on a Tier-1 photo costs far more than ₹475/month.

## 4. The remote agent server option

Account-specific findings (where the plan was found, which machines and plans the operator has, the org name) live in the environment repo.
- **Today (typical)**: coding agents (the `claude` CLI, opencode with free models, pi with a DeepSeek key) run on the operator's laptop, reached from the phone via Paseo, with Tailscale + SSH as the fallback.
- **Long-term plan (option D)**: an always-on VPS running opencode, pi, the `claude` CLI and the Paseo daemon. Git (a private GitHub org, `<org>`) is the source of truth; the laptop and phone become screens. Proposed cost: "0 (Oracle Always Free ARM, 4 cores/24 GB) or ~€4/mo (Hetzner)". Not started.
- **Corrections from today's checks**:
  - Oracle Always Free A1 is now **2 OCPU / 12 GB**, 200 GB block storage, and idle instances can be **reclaimed**: 7-day p95 CPU, network and memory all below 20% (docs.oracle.com Always Free resources page).
  - Hetzner's cheapest shared plans are **€5.99 (CX23, 2 vCPU/4 GB) to €6.49 (CAX11 Arm)**, with CAX21 4 vCPU/8 GB at €10.99, all excl. VAT. There is no €4 plan. Every cost-optimized and regular plan showed "currently unavailable" today (hetzner.com/cloud/cost-optimized/, /regular-performance/).
  - Realistic budget: **€6.5–11/mo (~₹700–1,200)**, or free on Oracle with reclamation and capacity risk.

## 5. Should the bot run on that server?

**No. Keep the bot on Cloudflare. Use the server for batch and agent work only.**
- **Cost**: the bot costs $5 fixed on Cloudflare. Moving it saves that $5, but the server is sized and paid for the agents anyway.
- **Reliability**: the bot must receive a Tier-1 message at 3 a.m. On a single VPS, agent sessions compete with it for CPU and RAM. Reboots, kernel updates, Oracle reclamation or a stuck disk take it offline. It would also need its own TLS, process supervision, a queue and backups to match what Workers + Queues + DLQ + outbox already give. A failure here is a missed emergency, while the gain is ₹475/month.
- **Security and privacy**: D1 and R2 are managed and encrypted at rest. The server runs agents with shell access and *non-Anthropic models* (opencode free models, DeepSeek via pi). Any agent on it could read the records repo or media and send them to a provider that trains on inputs. If Saturn's batch work lives on the server: use a separate Unix user or checkout, allow only Claude Code there, keep media off the box unless needed, and use full-disk encryption plus Tailscale-only SSH.
- **Ops burden**: Cloudflare deploys are `wrangler deploy` with nothing to patch. A self-hosted bot adds a second production system to look after, which is a permanent debt.

**What the server is good for in this project** (none of it latency-critical):
- **Git sync**: keep GitHub Actions as the ADR chose. It is free, independent of both the Mac and the server, and emails on failure. The server adds nothing here; at most it serves as a manual fallback runner.
- **OCR of new documents**: `tools/ocr` is Apple Vision (Swift) and runs only on macOS. On Linux, **PaddleOCR** is the better choice for phone photos and mixed Hindi/English print (runs on ARM CPU). **tesseract** (`hin+eng`) is fine for clean scans but weak on photos and handwriting. Cheapest path: keep OCR on the Mac, since documents arrive in batches. Add PaddleOCR on the server only when the Mac must stop being required. Claude vision (~$0.02–0.03/page with Sonnet 5.5) is a fallback for hard pages.
- **KB builds (`tools/kb`) and scheduled analysis agents**: a good fit. Run cron plus the headless `claude` CLI (plan or API: an env choice), write results to git, and open PRs for review.
- **Hard-read workflow**: the enhancement steps (upscale, CLAHE, threshold, deskew) are Python and portable to Linux. The OCR re-run is not (see OCR above). It also needs `<media-dir>` (the PHI media folder outside git), which would have to be copied to the server: one more copy of medical data to protect. Keep it on the Mac until OCR moves.

## 6. Proposed split

| Where | Runs |
|---|---|
| **Cloudflare (production, always on)** | Telegram webhook, Queues + DLQ, extraction (Haiku/Sonnet), Sarvam STT, D1, R2, reminder cron, outbox, alerts |
| **GitHub Actions** | d1-sync every 3 h (D1/R2 → git), the source of truth for clinical data in the repo |
| **Agent server (when it exists; best-effort)** | Scheduled analysis agents, KB builds, weekly-summary drafting, later PaddleOCR. Claude-only, with a separate user for Saturn |
| **Mac** | Apple Vision OCR, hard-read queue, anything that touches `<media-dir>` |

Asymmetric risks:
- **Bot on the VPS**: saves ₹475/mo, but a downside of missed alerts.
- **Bot on Cloudflare**: the only downside is ₹475/mo.
- **Health data on a shared agent server**: a privacy loss can't be undone, while isolating it costs little.
- **Leaving OCR on the Mac**: the worst case is a delay in reading new documents, which is recoverable.

Decide the server on agent needs alone. The bot doesn't need it.
