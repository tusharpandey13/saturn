# Can the health bot live in a WhatsApp group?

Researched 2026-10-24. This follows [architecture-options.md](architecture-options.md), which recommends the official WhatsApp Cloud API with 1:1 chats. Sources are linked inline. Several are vendor blogs, and those are marked as such.

## TL;DR

- **Officially, no, not for us.** Meta's Cloud API **Groups API** exists, but it is limited to **Official Business Accounts (OBA, the blue tick)**. OBA is granted to "notable" brands with press coverage. A family's private health tracker will not qualify. A normal Cloud API number also cannot be added to an ordinary WhatsApp group.
- **Unofficially, yes, but don't.** Baileys, whatsapp-web.js, WAHA and Evolution API can all sit in a normal family group on a spare SIM. They break WhatsApp's terms, a ban can come without warning, there has been a large malicious Baileys fork on npm, and WhatsApp is building detection for unofficial clients.
- **Recommendation:** keep the **official 1:1 bot** (one chat per patient) and add a **family mirror**: the bot sends each family member a 1:1 copy of red-flag alerts at once and a daily Hindi digest. The family keeps its normal human WhatsApp group. Keep the bot out of that group. **History lives in D1/R2, not in WhatsApp**, so no channel can take the data with it.
- **Fallback:** a Telegram group with the bot as admin. It has full group support and costs nothing. The cost is that family members must install and learn a new app.

---

## 1. Official Cloud API Groups API

| Question | Answer (2026) | Source |
|---|---|---|
| Status | Live and documented. The page was last updated 2026-06-16. Kapso (a WhatsApp vendor) calls it "real, but not broadly usable." | [Meta Groups API](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/), [Kapso, 2026-06](https://kapso.com/blog/whatsapp-groups-api-state-2026) |
| Eligibility | **Official Business Account only.** Business verification alone is not enough, because OBA is a separate status. Not available to WhatsApp Business *app* numbers or to Multi-solution Conversations numbers. | Meta, Kapso |
| How OBA is granted | You need Meta Business Verification first, then an OBA review. Approval depends on "notability", meaning organic media coverage and a strong public presence. After a rejection you wait 30 days to reapply. Applying is free. Meta Verified (a paid subscription) is a different product for the Business *app*, so it does not unlock the Cloud API Groups feature. (These details come from vendor blogs.) | [WATI](https://www.wati.io/blog/whatsapp-verification), [Infobip](https://www.infobip.com/blog/verify-whatsapp-business-account), [SleekFlow](https://sleekflow.io/en-us/blog/whatsapp-business-verification-blue-tick) |
| Messaging tier | Not stated in Meta's docs. | Meta |
| Participants | **Max 8** per group. 10,000 groups per number. One Cloud API business per group. | Meta |
| Joining | **Invite link only.** The business creates the group, gets the link from a lifecycle webhook, and sends it to members, who join themselves. There is no endpoint to add a participant directly; you can only remove participants. Groups with join requests are also supported. | Meta, Kapso, [Unipile](https://www.unipile.com/whatsapp-group-api/) |
| Inbound | You get group message webhooks, participant-update webhooks and status webhooks. The docs do **not** say whether the business receives every message and all media, or only some. This is unverified. | Meta, Kapso |
| Unsupported in groups | **Interactive messages** (so no buttons such as the planned confirmation buttons), view-once, disappearing messages, calling, authentication, commerce, editing and deleting messages. | Meta |
| Pricing | Normal per-message pricing, but **billed once per delivered member**. A reply to a group of 4 costs 4 messages. Any member's message opens or refreshes a service window for the whole group. | [Meta Groups pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/pricing) |
| Individual developer in India | **Practically no.** The blocker is OBA notability, not code or the country. Even established vendors such as Kapso don't offer it on managed numbers. | Kapso |

**Policy note, which applies to 1:1 as well:** since 2026-01-15, the WhatsApp Business Solution terms ban **general-purpose AI chatbots**, where the AI *is* the product. Task-specific bots are still allowed. A narrow health-logging assistant is task-specific, so it is fine. Keep the Q&A feature scoped to the family's health data and don't present the bot as an open-ended assistant. [respond.io](https://respond.io/blog/whatsapp-general-purpose-chatbots-ban), [TechRadar](https://techradar.com/ai-platforms-assistants/meta-will-ban-rival-ai-chatbots-from-whatsapp)

## 2. Unofficial libraries on a spare number

| | Baileys | whatsapp-web.js | WAHA / Evolution API |
|---|---|---|---|
| How it works | Reverse-engineered WebSocket protocol (Node) | Puppeteer driving real WhatsApp Web | Self-hosted HTTP wrappers around the engines on the left (WAHA's engines include whatsapp-web.js; Evolution uses Baileys) |
| Groups | Full: reads every message and media item in any normal group, and can be added like a person | Full | Full |
| Maintenance | v7 has been at release-candidate stage since late 2025. The last full release was 2025-11-21, and v7 required changes for the LID/phone-number ID switch. [newreleases rc10](https://newreleases.io/project/github/WhiskeySockets/Baileys/release/v7.0.0-rc10), [checkleaked](https://whatsapp.checkleaked.cc/tr/blog/what-is-baileys) | Breaks when the WhatsApp Web UI or JS changes, and needs a headless Chromium | Inherits both, plus another layer to patch |

**Ban risk.** I found no reliable 2025–26 data on ban *rates* for low-volume personal use. The evidence is vendor claims and anecdotes. Low-volume, receive-mostly use within a group of known contacts is the lowest-risk profile, but the risk is not zero, and enforcement is getting tighter:
- WhatsApp is testing a persistent Linked-devices warning for unofficial web clients (Android beta 2.26.35.1, 2026-09-01). This shows Meta can tell these clients apart and plans to act on it. [WABetaInfo](https://wabetainfo.com/whatsapp-is-testing-a-safety-warning-for-unofficial-web-clients/)
- Vendors say Meta is actively banning Baileys and Web-automation numbers, and that bans can wipe chats with little room for appeal. These are vendors with an interest in saying so. [ChatDaddy](https://help.chatdaddy.tech/article/ban-type-distribution), [richautomate](https://richautomate.in/blog/whatsapp-unofficial-api-ban-risk-india-2026)
- The Terms of Service say unofficial clients "may... result in account suspension."

**Supply chain.** `lotusbail` was a working Baileys fork on npm for about 6 months with more than 56,000 downloads. It stole session tokens, every message, media and contacts, and **linked the attacker's device to the account**, so access continued after the package was uninstalled. [The Register, 2025-12-22](https://www.theregister.com/2025/12/22/whatsapp_npm_package_message_steal/), [CSO](https://www.csoonline.com/article/4111068/whatsapp-api-worked-exactly-as-promised-and-stole-everything.html). Another malicious fork, `@fhkry/baileys`, is listed as OSV MAL-2026-4803 (see the previous doc). For a bot that holds a family's medical data, a single bad dependency means a full leak of the family group's history, and the leak keeps going.

**Maintenance burden.** You would run an always-on process (not a Worker), store the session state safely, re-pair by QR whenever the session drops, track library breakage after WhatsApp updates, and pin and review dependencies. That is ongoing, unscheduled work, which goes against the "lowest maintenance" goal.

## 3. Hybrid options (official API only)

| Option | Feasible? | Family visibility | Cost (Meta fees) | Notes |
|---|---|---|---|---|
| A. 1:1 bot per patient, with no mirroring | Yes | Caregivers must ask the bot | ~₹10/mo | Baseline from the previous doc |
| **B. 1:1 bot per patient + family mirror** (each member gets an immediate 1:1 copy of red-flag alerts and a daily Hindi digest; caregivers can also ask questions 1:1) | **Yes** | High: everyone sees what matters, and the patients' chats stay uncluttered | 2 extra recipients × (30 digests + about 10 alerts) ≈ 80 utility templates ≈ **₹10/mo** at ₹0.115 | **Recommended.** Use utility templates because caregivers are usually outside the 24h window. Mirroring *every* message would cost about ₹140/mo and add noise. |
| C. Bot posts into the existing family group | **No.** That needs the Groups API, which needs OBA. A Cloud API number can't join consumer groups. | | | |
| D. Bot builds a summary, a caregiver forwards it to the family group by hand | Yes | Medium | ₹0 extra | Manual step. Works as a stopgap. |
| E. Patients forward messages from the family group to the bot | Yes | | | Extra steps for every sender. Reject. |

Extra benefit of B: patients get **interactive confirmation buttons** in 1:1 chats (✅/❌), which group chats don't support even with OBA.

## 4. Telegram group fallback

- **Works fully:** add the bot as a **group admin**, or turn off privacy mode in BotFather and re-add the bot, and it receives every message, including voice notes, photos and PDFs. By default, with privacy mode on, a bot only sees commands and replies to it. [Telegram bot features](https://core.telegram.org/bots/features#privacy-mode)
- **Cost:** ₹0. No phone number, templates, 24h window or ToS risk. The bot token can be revoked and reissued in seconds.
- **Friction for family members:** install a second app, sign up with phone and OTP, trust a new icon, and remember to send health updates *there* rather than to WhatsApp. Voice notes and photos work the same way (press and hold, camera button). In practice one family member sets up the phones once. The ongoing risk is **habit**: people keep sending updates to WhatsApp, and logging quietly stops.
- **Privacy:** bot and group chats are Telegram cloud chats, so they are not end-to-end encrypted. That is about the same exposure as Meta under the Cloud API.

## 5. Recommendation and asymmetric-risk reasoning

| Option | Downside if it goes wrong | Chance | Setup cost | Ongoing cost |
|---|---|---|---|---|
| **Official 1:1 + family mirror** | Meta pricing or policy changes; templates get rejected | Low | Half a day, plus a SIM and a card | About ₹0–20/mo Meta fees; near-zero maintenance on Workers |
| Official Groups API | Can't get OBA | ~Certain | Weeks of verification, then rejection | n/a |
| Unofficial group bot | **Number banned**: the channel is gone overnight and the family is confused; or a **dependency compromise** leaks medical history | Medium per year, compounding over time | 1 evening | Always-on server, re-pairing, library churn |
| Telegram group | Family members stop using it | Medium | 1 hour + setting up the phones | ~0 |

The costs are asymmetric. The official route costs a **one-time** half-day of Meta setup. The unofficial route saves that half-day but takes on a **recurring, unbounded** tail risk: losing the channel at the moment a red flag needs to get through, and a leak that persists after the bad package is removed. For a health-monitoring tool, that tail is unacceptable. The group experience is attractive, but most of its value is "the family sees everything," and Option B delivers that through 1:1 copies.

**Set up (user):**
1. Meta developer account plus a Meta Business portfolio. Business verification is **not** needed at this scale, since unverified accounts can still message a handful of users.
2. A **new prepaid SIM** (Jio or Airtel, cheapest validity pack) that has **never been registered on WhatsApp**. Register it on the Cloud API with a 2-step PIN. Start with the free test number for the milestone.
3. A payment method with INR billing, and 3–4 **utility templates** in Hindi (daily digest, red-flag alert, daily reminder, document-ready).
4. Allowlist the family members' numbers. Each one messages the bot once, so it's saved in their contacts as "Health Diary".
5. Keep the family's normal WhatsApp group for human conversation.

**Blockers:** none for Option B. The only real one is that the Groups API needs OBA, which is out of reach for a personal project.

## 6. Migration path

Design rule: **channel adapter ⟶ normalised event ⟶ core (D1/R2)**. The adapter only translates `{sender, kind, text|media_ref, ts}` in and `{recipient, text|template|document}` out. All history and media go to D1/R2 as they arrive, so a channel can be lost without losing the record.

1. **Now:** Meta test number, 1:1 (milestone from the previous doc).
2. **Production:** your own SIM on the Cloud API, 1:1 for each patient, plus the family mirror (Option B).
3. **If Meta becomes unworkable** (pricing, policy, template rejections): add a Telegram adapter, create a family Telegram group with the bot as admin, and send each patient a WhatsApp message: "अब यहाँ भेजें". The core and the data don't change. You can run both adapters in parallel during the switch.
4. **If the Groups API ever opens to non-OBA accounts** (re-check yearly): on the same WABA and number, create one family group, send invite links, and add group webhook handling. Keep 1:1 chats for confirmations, since groups don't support interactive messages.
5. **Unofficial libraries:** last resort only, and only on a disposable SIM, with dependencies pinned and reviewed. Use them as a *read-only mirror* of the group, never as the system of record. Not recommended.
