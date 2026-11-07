---
title: "Symptom context card (design and test spec)"
audience: engineer, maintainer
type: explanation
owner: maintainer
last_reviewed: 2026-11-07
review_every: 90d
status: active
sources: [decisions/011-group-input-only-admin-output.md, decisions/012-continuous-crossref.md, decisions/013-diagnostic-loop.md, design/health-site.md, design/health-profile.md]
generated: false
---

# Symptom context card

**Facts as written; not advice; doctors decide.** Generic design; no PHI. Examples use the synthetic family in
`fixtures/records-example/` (`alice`, `bob`).

## 1. Goal

Every new symptom gets a card on the next site build, assembled only from the KB, a label cache, curated maps and
rules. No agent run, no free model text. The owner sees the full card; the family sees a calm short version.

Trigger rows (a "symptom item"):

- an `observation` fact with `data.category = "symptom"` (D1 symptoms, documents), and
- a voice-note statement: an `event` fact whose `data.detail.category = "symptom"` (d1.statements via
  `tools/kb/build`), **not** tagged `negated`.

Only `status = active` facts dated within the last `CARD_DAYS = 14` days of the build's `--today` count (the same
window as "What changed"). Items are grouped **by source** (one voice note, message or document = one card), because one
voice note often carries several symptoms ("eyes burning; slight headache"). Card id = the slug of the source id's local
part; pages `<ns>/symptom/<slug>.html` (owner) and `<ns>/symptom/<slug>-family.html` (family).

## 2. Research that shaped the design

- **Data already in the KB.** Symptom observations carry `value_text`, `body_site`, `components`; statements carry an
  English `label` (`voice (machine|listened transcript): ...`), a verbatim source-language `quote`, `detail.category`
  and tags `machine-transcript` / `listened-transcript`, `negated`, `low-confidence`. The site already decides
  "unchecked" (machine transcript, no `listened.ndjson` row) and withholds numbers from such phrases; the card reuses
  that rule (`Builder.unchecked`), so an unlistened phrase is never shown as a fact.
- **Home readings and the usual range.** `tools/crossref/home_series.py` (`v_home_daily`, `baseline`) is the running
  profile's band (median ± k·max(1.4826·MAD, floor) over the baseline days; "warming-up" below 7 days). The card
  imports it and the active `baseline_shift` check parameters (`crossref.load_checks`) so the card and the profile
  page always agree.
- **Medicines.** `v_meds_current` gives the current list (`display_status`); medication facts give start, stop and
  change dates. The profile's "Alongside" logic (first statement, stop, restart) is the model; the card adds a
  strength/schedule change.
- **Labels.** openFDA `drug/label.json` (no key needed: 240 requests/min and 1,000/day per IP without a key) returns SPL
  labels with `set_id` (the DailyMed set id), `effective_time` and sections `boxed_warning`, `warnings_and_cautions`,
  `warnings`, `precautions`, `adverse_reactions`. Search by `openfda.generic_name` (the US generic/INN name); KB
  `ref:drug` rows hold Indian brands with `generic` and `ingredients`, so the mapping is generic-by-generic. One generic
  returns several labels (repackagers): pick deterministically (rule in §6). openFDA and SPL label text are public
  domain (openFDA licence: CC0/public domain; US government works); brand names are trademarks and are not reproduced
  beyond the label title. A product with no US label (many Indian combinations and supplements)
  is "no label available", said plainly.
- **Red flags.** Wording is transcribed from public NHS pages (headaches, red eye, chest pain, stomach ache, shortness
  of breath, dizziness, stroke symptoms, heart failure symptoms, UTI, hives, apixaban side effects), checked
  07-Nov-2026. "Call 999 / A&E" items map to Tier A; "urgent GP / 111" items map to Tier B; "see a GP" items map to
  Tier B or C. The tier meaning (and the realistic path) comes from the records repo's family context page.
- **Family context rules** (records `docs/health/family/context.md`): every action tiered; never "rush", "immediately"
  or "ASAP" outside Tier A; at most 5 asks; family text calm, no probabilities, no differential.
- **ADR 011.** Output goes only to the admin's private DM. The existing button-to-DM path is the "Run the loop" form:
  site → `tools/site/dx-api` (tailnet-only, allow-listed `Tailscale-User-Login`) → spool → `tools/dx/run` (host
  timer, holds the bot token) → `sendMessage` to `TELEGRAM_ADMIN_CHAT_ID` (refuses group ids). The card's "send to my
  DM" button reuses exactly that path; no new credential, no Worker change.
- **Diagnostic loop (ADR 013).** Inference rows (`inferences/<ns>/inferences.ndjson`) list `evidence_for` KB ids. The
  optional agent-inferred line appears only when an active inference cites one of the card's facts or its source.

## 3. Modules

| Path | What |
|---|---|
| `tools/symptom/cardlib.py` | pure stdlib: load maps and rules (+ records overrides), classify body sites, person modifiers, build the card dict from the KB, label matching, tier text, wording check, DM text |
| `tools/symptom/sites.json` | body sites: triggers, label terms, questions, closing rule, "ask before using" line |
| `tools/symptom/rules.json` | person modifiers and red-flag rules (status `pending_clinician_signoff`) |
| `tools/symptom/labels` | CLI: `fetch` (network; writes the label cache) and `check` (offline; lists current medicines without a cache entry) |
| `tools/site/build` | renders cards (owner page, family page, overview block, link from timeline rows) from the card dicts |
| `tools/site/dx-api` | new route `POST /ask/<ns>`: queues a ready DM (identity, word list, size, cap) |
| `tools/dx/run` | drains the DM spool before looking at the run spool |

## 4. Data contract per section

All sections read the KB through `kb.sqlite` (built by `tools/kb/build`), never D1.

1. **What was said.** Per trigger fact: statements → the English summary (`transcript_text(label)`), observations →
  `value_text` (+ `body_site`). Source kind and time (`fdate(at)`, minute precision when present), the source chip.
  Listener status: `machine transcript, not yet listened` (unchecked: numbers withheld, muted), `listened transcript`,
  or the source kind for documents. Tags `low-confidence` → "low confidence". Negated statements never trigger, but are
  listed as "said as a negative" when the source has a card.
2. **Same day and day before.** Active facts of the person with `substr(at,1,10)` in [D-1, D] (D = the card's first
  trigger day), excluding the card's triggers, `medication` facts (section 3), fitness rows, `shadow` and
  `low-confidence` context rows. Statements render like the timeline (unchecked → muted, numbers withheld). A source
  with more than 3 facts collapses to one line ("lab report: 12 values"). Home readings: per series (sbp/dbp, pulse,
  weight) the daily value for D-1 and D from `home_series.v_home_daily` and the band from `home_series.baseline` with the
  active `baseline_shift` parameters; words: "inside / above / below the usual range lo–hi (median m, n days)" or
  "usual range not set yet (n of 7 days); last 28 days min–max". Header: "As written, alongside. Not a cause."
3. **Medicines alongside.** From medication facts (`status = active`) per drug key (`drug_id`, else brand):
  `started` (first statement, or first after `stopped`), `stopped`, `changed` (strength or `schedule_raw` differs from
  the previous statement), dated within [D-14, D], with "N days before". Then "long-standing": current medicines
  (`v_meds_current`, `display_status` not `stopped` / `not-in-current-list`) whose first statement is older than 14
  days. Header: "Shown alongside, not as a cause."
4. **What the labels say.** For each current medicine (and each medicine stopped within the 14 days): the label cache
  entry for its drug id; the card's body-site label terms (union) are matched case-insensitively on word boundaries in
  the cached sections. Up to 3 quotes per medicine, each ≤ 160 characters, with **set id**, **section** and label
  effective date. States, one per medicine (or per ingredient for a combination without a combined label):
  `label mentions` / `no label mention` / `no label available` / `label not fetched yet` (no cache entry; run
  `tools/symptom/labels fetch`) / `no generic recorded` (brand-only, no `drug_id`).
5. **Warning signs (rules).** Generic rules for each body site plus rules whose `when` modifiers all hold for this
  person (from the KB, §7). Each line: rule id, tier, owner wording; family view: calm wording. Tier text from the
  family context page (§8). Ordered A, B, C, then id. Footer: the rules file status ("generic defaults; doctor sign-off
  pending") and the source titles (no URLs on the site).
6. **What to ask.** At most 5 questions: round-robin across the card's body sites (in classification order) from the
  curated sets, de-duplicated. One button posts them as a ready message to the owner's DM (§10).
7. **What would close it.** Per body site: "Better within N days: note it in a voice note." vs "Lasts more than M days,
  or any warning sign above: Tier X." (`closing` in sites.json; the strictest site wins: smallest M, highest tier),
  plus "Said K days ago". The site's "ask a doctor before using" line (eye drops, painkillers, balms) sits here.

Optional (owner view only): "Agent-inferred link (bucket): statement. Not a diagnosis. Doctors decide." from active
inference rows whose `evidence_for` contains a trigger fact id or the card's source id; at most 1 (the first in the
Status page order).

## 5. Symptom → body site → terms map (`tools/symptom/sites.json`)

```json
{"version": "2026-11-07", "sites": [
  {"id": "eye", "name": "eyes",
   "triggers": ["eye", "eyes", "vision", "blurr", "burning eye", "watering", "aankh", "आंख", "आँख"],
   "label_terms": ["eye", "ocular", "conjunctival", "vision", "visual", "lacrimation", "phosphenes", "luminous phenomena", "blurred"],
   "questions": ["One eye or both?", "Is the eye red?", "Any discharge (sticky or watery)?", "Any blurring or change in vision?", "Better or worse today?"],
   "closing": {"better_days": "2-3", "max_days": 3, "tier": "B"},
   "before_using": "Eye drops: ask a doctor before using any."}]}
```

Initial sites (generic): `eye`, `head` (headache, head pain, sir dard), `chest` (chest pain, tightness, palpitations),
`abdomen` (stomach, loose motions, vomiting, gas, acidity), `skin` (rash, itching, swelling of lips), `limbs-neuro`
(numbness, tingling, weakness of an arm or leg, speech, balance), `breathing` (breathless, cough, wheeze),
`urinary` (urine, burning when passing urine), `dizziness` (dizzy, giddy, chakkar, light-headed, faint), and
`general` (weakness, fatigue, low energy, not feeling well) as the fallback when nothing else matches. Matching:
lower-cased text of the trigger facts (summary, `value_text`, `body_site`, quote), a trigger matches at a word start;
several sites may match; order = the file's order.

## 6. Label cache (records repo, `labels/`)

- **Location:** `<records>/labels/<drug-local>.json` (one per `ref:drug` id; e.g. `ref:drug:exampleaban` →
  `labels/exampleaban.json`). Records-side because the list of drugs a person takes is personal; the label text itself
  is public domain. The site build reads only this directory (offline).
- **Fields:** `schema: "label-cache/1"`, `drug_id`, `queried` (list of generic names asked), `fetched_at` (ISO date),
  `source: "openFDA drug/label"`, `status` (`found` / `partial` / `not-available`), `labels`: one entry per ingredient
  or combination: `{query, status, set_id, effective_time, title, product_type, choice, sections: {name: text}}`;
  sections kept: `boxed_warning`, `warnings_and_cautions`, `warnings`, `precautions`, `adverse_reactions`.
- **Query order per drug:** the full combination (`A and B`) when there are several ingredients, then each ingredient
  alone; per query `openfda.generic_name:"<name>"` with `product_type:"HUMAN PRESCRIPTION DRUG"`, then without the
  product type (OTC). **Choice among labels:** has `adverse_reactions`, then the longest `adverse_reactions` text (the
  full prescribing information, not a short repackager summary), then the newest `effective_time`, then `set_id`; the
  rule is written into `choice`.
- **Refresh:** `labels fetch --records DIR [--drug ID]... [--max-age-days 90]` fetches current medicines (and those
  stopped in the last 30 days) with no entry
  or an entry older than the max age; `--force` refetches. Sleeps 0.3 s between requests. A network error leaves the old
  entry untouched and exits 1 after the rest (never writes a half entry).
- **Offline behaviour:** no entry → "label not fetched yet"; an entry older than 180 days → shown with its fetch date.
- **Who runs it:** the records session after a medicine ingest (records guide §8 fan-out row "Prescription / medicine
  photo"), then commits `labels/`. `labels check` lists the missing ones (exit 1 when any).

## 7. Red-flag rules and person modifiers (`tools/symptom/rules.json`)

```json
{"version": "2026-11-07", "status": "pending_clinician_signoff",
 "modifiers": [
   {"id": "anticoagulant", "name": "on a blood thinner (anticoagulant)", "match": {"current_generic_any": ["apixaban", "rivaroxaban", "dabigatran", "edoxaban", "warfarin", "acenocoumarol", "heparin", "enoxaparin"]}},
   {"id": "recent-stroke", "name": "stroke in the last 180 days", "match": {"text_any": ["infarct", "stroke", "cva", "tia"], "kinds": ["condition", "observation"], "within_days": 180}},
   {"id": "weak-heart", "name": "weak heart pumping on record", "match": {"text_any": ["cardiomyopathy", "dcmp", "heart failure", "hfref", "lv dysfunction"], "kinds": ["condition"]}}],
 "rules": [
   {"id": "head-a-sudden-severe", "site": "head", "when": [], "tier": "A",
    "owner": "Headache that started suddenly and is extremely painful.",
    "family": "A sudden, very bad headache.",
    "source": {"publisher": "NHS", "title": "Headaches", "url": "https://www.nhs.uk/conditions/headaches/", "checked": "2026-11-07"}}]}
```

- `when`: modifier ids that must all hold; `[]` = generic. A modifier holds from the KB at build time:
  `current_generic_any` against `v_meds_current.generic` and the drug's ingredients (current = not `stopped` /
  `not-in-current-list`); `text_any` against the text of active facts of `kinds`
  (`text_as_written`, `label`, `value_text`) at word start, skipping a term followed by `(-)` or preceded by `no `,
  within `within_days` of today when set. The card lists the modifiers that held ("For this person: on a blood thinner").
- `tier`: A, B or C. `owner` and `family` wording are fixed text; `family` is calm (no alarming words; §11).
- Every rule cites its source; the site shows "NHS: Headaches (checked 07-Nov-2026)" without the URL.
- **Records overrides:** optional `<records>/config/symptom-card.json` with `sites`, `rules`, `modifiers` (replace or
  add by `id`) and `disable` (rule ids). Validated like the product files; a bad file stops the site build with the
  key named (fail closed).

## 8. Tier text (family context page)

`docs/health/family/context.md` bullets `- **Tier A, <label>...:** <text>`: the card uses the label ("emergency",
"same-week doctor", "next planned visit ...") and, for Tier A, the first quoted sentence of the text (the realistic
path, e.g. the named hospital and the transport rule); for B and C the first sentence. Without the page: generic
defaults ("Tier A: go to the nearest emergency hospital now.", "Tier B: see a doctor within the week (2 to 4 days).",
"Tier C: the next planned visit or a tele-consult."). Rule lines always carry "Tier X"; the path text is printed once
per tier, above that tier's lines.

## 9. Where cards render

- **Card pages**: `<ns>/symptom/<slug>.html` (owner, sections 1-7, optional inferred line, the DM form) and
  `<ns>/symptom/<slug>-family.html` (family: sections 1, 5 in calm words, 7). Each links to the other.
- **Overview (person home), inside "What changed"**: a "New symptoms" list, newest first: what was said (unchecked
  muted), date, "N warning signs to watch (Tier A: k)", links "Card" and "Family version".
- **Timeline rows** (Overview "What changed" and History) of a trigger statement get a "Symptom card" link.
- No card for a source when every trigger is older than 14 days.

## 10. DM post (owner only; ADR 011)

- With `--dx-api URL` the owner card carries a plain form: `POST <URL>/ask/<ns>` with hidden `card` (slug) and `text`
  (the ready message), button "Send these questions to my DM". CSP `form-action` widened to that origin on card pages.
  Without it: the message in a box to copy, "Read-only build: no send endpoint."
- Message: `Questions for <display>: <what was said, numbers withheld when unchecked> (<date>)` then numbered questions,
  then `Facts as written; not advice; doctors decide.` English only, ≤ 1,200 characters.
- `dx-api`: identity first (no `Tailscale-User-Login` → 403; not allow-listed → 403), namespace known (404), `text`
  1-1,200 characters, at most 12 lines, passes the word list (422 otherwise), cap 20 accepted asks per 24 h (429).
  Writes `<state>/dm/<utc-ts>-<ns>.json` `{ns, card, by, text, requested_at}` under the state lock; answers 202 with a
  page "Queued for your DM (about 2 minutes)."
- `tools/dx/run` (timer every 2 min, already holds the bot token): first sends each `dm/*.json` oldest first with the
  existing `tele_send` (private chat id only, never a group), deletes the file on success, keeps it on failure, drops
  files older than 24 h with a log line; then handles the run spool as before. While a loop run is running (up to 3 h)
  DMs wait for the next timer start.
- Never posts to a group; never posts the family view; never includes probabilities.

## 11. Word-list checks (`cardlib.check_words(text, family=False)`)

Run on every rendered card text (owner and family) and on the DM text; the build fails on a hit (the card is product
code, so a hit is a product bug or a bad override).

- **All views:** the inference word list (verdicts, reassurance, medicine instructions: "you should", "safe to",
  "rule out", "caused by", "nothing to worry", start/stop/increase/reduce ... medicine/dose) plus causal wording
  ("because of", "due to", "side effect of", "reaction to", "triggered by").
- **Family view in addition:** "rush", "immediately", "ASAP", "urgent", "danger", "serious", "fatal", "die", "death",
  "%", "probability", "likely", "differential", "agent-inferred".
- **Label quotes** are verbatim but short: a quote window that would hit the list is cut to the matched term's clause;
  if it still hits, only the matched term itself is quoted ("label mentions: “headache”").
- "Never upgrade an unlistened phrase": unchecked statements are always rendered with the
  `machine transcript, not yet listened` pill and numbers withheld; the test asserts it.

## 12. Failure modes

| Failure | Behaviour |
|---|---|
| no `labels/` or no entry | "label not fetched yet" per medicine; card still complete |
| openFDA down / rate-limited | `labels fetch` keeps old entries, exits 1; the site is unaffected |
| no family context page | generic tier text |
| bad override file | site build stops naming the key (fail closed) |
| word-list hit | site build stops naming the card and phrase |
| home readings too few | "usual range not set yet" |
| no `--dx-api` | read-only box with the message to copy |
| DM send fails | spool file kept; retried on the next timer run; dropped after 24 h with a log line |
| symptom without body site match | `general` site |

## 13. Test spec

All tests are stdlib `unittest` on synthetic data only.

**Unit (`tools/symptom/test_cards.py`)**

- maps/rules load and validate (unique ids, tiers A/B/C, every rule has a source, every family text passes the family
  word list, every site has ≤ 5 questions, closing present); a bad override fails with the key named.
- body-site classification (eye + head from "eyes burning; slight headache", Hindi trigger, fallback `general`).
- modifiers: anticoagulant from a current drug's generic; not from a stopped one; recent stroke within 180 days and not
  "CVA (-)"; weak heart.
- rules selection: anticoagulant + headache yields the anticoagulant-specific head rule and the generic head rules,
  each with id and tier; without the modifier the specific rule is absent.
- label matching: quote has set id + section; "no label mention"; "no label available"; "label not fetched yet";
  quote trimming against the word list.
- medicine changes: started 5 days before, strength change, stopped, long-standing.
- home readings vs band (inside / above; warming-up wording).
- tier text parsed from a synthetic context page; defaults without it.
- word list: hits and misses for both views; DM text ≤ 1,200 characters and passes.
- questions ≤ 5 across two sites, de-duplicated.

**Fixture overlay** (synthetic, added to a temp copy of `fixtures/records-example`): alice on `ref:drug:exampleaban`
(generic `apixaban`, started 5 days before), `ref:drug:examplevite` (generic `examplevitamin`, label `not-available`),
long-standing `examplezole` (no cache entry → "not fetched yet"); a machine-transcript voice note (not in
`listened.ndjson`) with statements "Eyes are burning" and "Slight headache today, 2 times" (category symptom), a
symptom observation `pain`/`head`, same-day activity statement and two home BP readings; label cache files for
`exampleaban` (synthetic label text with "conjunctival hemorrhage" and "headache") and `examplevite`.

**Golden files** (`tools/symptom/golden/alice-owner.html`, `alice-family.html`): the rendered card bodies (between
`<main class="card-sym">` markers) of the overlay at a fixed `--today`; `UPDATE_GOLDEN=1` rewrites them.

**Site build tests** (in `test_cards.py`, running `tools/site/build`): the card pages exist; owner page has sections
1-7 headings; every label quote line has a set id; every warning line has a rule id and a tier; family page has only
sections 1, 5, 7, no "%", no "agent-inferred", no section 4 text; unchecked phrase muted with numbers withheld; overview
"New symptoms" block links both pages; no external URL; with `--dx-api` the form posts to `/ask/alice` and CSP allows
the origin; an active inference citing the trigger adds the owner-only line; card absent when the trigger is 15 days old.

**DM path tests** (`tools/site/test_dx_api.py`, `tools/dx/test_dx.py`): `/ask/<ns>` 403 without identity, 403 not
allow-listed, 404 unknown ns, 422 word-list hit, 413/422 too long, 429 over the cap, 202 writes the spool file;
`tools/dx/run` with a Telegram stub sends the spooled message to the admin chat id, deletes the file, refuses a group
chat id, keeps the file when the stub fails.

**Labels CLI tests** (`tools/symptom/test_labels.py`): fetch against a local stub of the openFDA API (choice rule,
combination fallback to ingredients, not-available, network error keeps the old file), `check` lists missing entries.

**e2e (batch to site):** `app/scripts/e2e-local.mjs` step 8 adds a symptom ("chakkar") to a test message, then runs
`tools/site/build --db <e2e kb>` and checks that a symptom card page exists for that person. (The Worker is unchanged,
so the DM-post test runs against the dx-api/dx-run harness above, not the Worker's e2e harness.)

**Real-data verification** (records clone, outside git; report counts only): `labels fetch` for current medicines
(found / not available / partial), `labels check` exit 0, a site build into a temp dir, then counts: cards built,
cards per person, sections present per card (7/7), word-list pass, warning lines with rule id and tier, family pages
free of "%" and "agent-inferred".
