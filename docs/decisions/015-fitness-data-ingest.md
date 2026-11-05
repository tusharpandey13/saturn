# 015: Fitness data ingest (Strava, Polar, Zwift, MyWhoosh), with Strava's API off by default

Date: 2026-11-05 · Status: **PROPOSED** (build authorised by the records owner; the Strava API decision below is theirs) ·
Related: 007 (data model), 008 (three repos), 012, 013 · Tools: [tools/fitness](../../tools/fitness/README.md)

## Context
A records owner trains and wears a sensor. Their data sits in Strava, Polar Flow and two training apps (Zwift, MyWhoosh):
rides, runs, walks, strength, sleep, recharge, heart rate. It belongs next to their health records, usable through the same
KB, search and pages. The data is about a person's body and habits: **data class PHI** (ADR 008 rule 1), so it lives in
the records repo and on PHI-grade hosts only.

Vendor limits, official text fetched 05-Nov-2026:

- **Polar AccessLink** ([docs](https://www.polar.com/accesslink-api/)): "Only Exercises uploaded to Flow in the last 30 days are returned. Only exercises that have been
  uploaded to Flow after the user is registered with your client will be returned." Daily activity reaches back further: "From date cannot be older than 365 days from
  today". Sleep and Nightly Recharge lists cover the last 28 days. Rate limit for a client: 500 + users x 20 per 15 min. So the API gives the future, and
  **the Polar Flow export is the only source of older history**.
- **Strava** requires a paid subscription to create an API app ([getting started](https://developers.strava.com/docs/getting-started/): "A Strava subscription is a prerequisite for creating an app"; [announcement, 01-Jun-2026](https://communityhub.strava.com/insider-journal-9/an-update-to-our-developer-program-13428)).
- **The [Strava API Policy](https://www.strava.com/legal/api_policy) (effective 01-Jun-2026, part of the API Agreement) forbids what this repo does with data**:
  - §5.3: "You may not use the Strava API Materials or Strava Data, directly or indirectly, in connection with the development, training, evaluation, or operation of any AI Application." It extends to "embedding generation, retrieval-augmented generation, ingestion into a context window or working memory", and to data "derived from, aggregated from, anonymized from, or generated using Strava Data". "This prohibition does not extend to use of the Strava MCP".
  - §5.5: "You may not bulk-export Strava Data, including by accumulating Strava Data through repeated authorized API calls into a corpus, dataset, archive, or database"; "You may not store Strava Data, or any data derived from Strava Data, in any Persistent Index" (vector stores, search indexes, archives).
  - §6.2: "You may not retain Strava Data in your cache for longer than seven (7) days."
  - §5.4: "You may not combine Strava Data with other customer data for these or any other purposes."
  - §7.4: on revocation or termination, delete "all Strava Data and all Personal Data derived from Strava Data" within 30 days.
  - §3.5: subscribers "may bring their own AI Application to interact with their own data through the Strava MCP", the sanctioned path for AI.
  - §6.6: "Each Strava user has the right to access and export the user's own Strava data, free of charge, through the Bulk Data Export Tool ... Nothing in this Agreement is intended to limit or condition that user-facing right."

  There is **no carve-out for a single-player app or for one's own data** in §5 or §6; "Single Player Mode" (rate-limits page) limits who may connect, not what may be done. "AI Application" is capitalised but not defined in the Policy or the Agreement text as fetched. Saturn's semantic search embeds rows and its diagnostic loop reads the KB through an LLM, so inference-only use is covered by "operation of" and "context window". The Agreement defines Strava Data as data accessed "from the Strava API Materials"; the owner's own bulk export is not that.

## Decision
1. **Sources, by route.** Polar: AccessLink API on a timer, Polar Flow export for history. Zwift and MyWhoosh: their local FIT files (`import-fit`). Strava: **the owner's bulk export** (`import-export`). **The Strava API pull exists but is off** (`--strava-api`): turning it on is the records owner's own, recorded decision to accept the terms risk below.
2. **Storage.** Raw payloads and FIT files, gzipped, content-addressed, never edited: `sources/<ns>/media/{strava,polar,zwift,mywhoosh}/`. Rows: `data/<ns>/docs/<source-id>.ndjson`, normal `source` plus `fact`. A host running the pull keeps a working clone and its state (tokens, cursors) in its own 0700 home.
3. **One observation per activity, night or day.** `source.kind = other` (adequate; no schema change) with tag `fitness`. `fact.data.category = fitness` (a new enum value on the observation and code schemas: additive, so `schema_version` stays 7), with a readable `value_text` and every metric in `components` (duration, distance, power, NP, heart rate, cadence, calories, sport, device, EF, decoupling, power curve). One row per metric would mean about 10x the rows and search chunks with no reader that needs them; samples stay in the raw files. Provider free text (activity names, notes) never reaches a row: only bounded numbers and slugged labels do, so a hostile title cannot reach a later agent prompt.
4. **Kept apart from clinical views.** `v_trend` excludes the category, so `v_latest`, `v_conflicts`, `v_timeline`, lab pages, the site's results and the cross-check checks see none of it; the fingerprint that triggers cross-checks ignores it. `v_fitness` is the query path. The generated page is `docs/health/<ns>/fitness.md` (`gen:fitness`: weekly hours and load, power curve, EF, decoupling, nights), which the site renders like any page. Search indexes the rows as `fact` by its existing file rule; raw files are not indexed.
5. **Dedupe by time.** Two activities are one when they overlap by at least half of the longer recording, across any sources. Canonical order: MyWhoosh, Zwift (direct file with samples), Polar, Polar export, Strava export, Strava API. Every raw copy and its fact stays; the others get `source.duplicate_of`, `rank: copy`, tag `fitness-duplicate`, and the kept one `fitness-canonical`. The relation lives on source rows and may change when a better source arrives; **fact rows are never rewritten by dedupe** (ADR 007). A changed payload for the same day or activity is a new fact that supersedes the old one.
6. **Metrics.** NP, TSS, EF and decoupling are derived and labelled, with the ERG caveat on the page: under ERG the trainer holds the target, so these describe the prescribed workout. TSS uses the device's FTP, else a records-local `fitness_ftp_w`. None is a health judgement, and nothing advises (record and flag only).
7. **Biosensing** (Polar SpO2, ECG, temperatures) is kept raw with no rows: readings that look clinical need their own decision.

## Options considered (Strava)
| | Export only (chosen default) | API on, rows in the KB (as first asked) | API on, 7-day cache only | Strava MCP |
|---|---|---|---|---|
| Terms | §6.6 protects it | breaks §5.3, §5.4, §5.5, §6.2 | allowed, but useless to the KB and search | allowed for AI use; no storage |
| Cost | manual export (minutes, occasionally) | subscription; deletion duty §7.4 | subscription, code to purge | subscription |
| Freshness | as often as exported | hours | hours | live, interactive only |
| Downside | history lags | API access or account lost (§5: "Strava shall determine in its sole discretion"), history in git is hard to delete | no lasting record | not in the records |

## Asymmetric costs
- Enabling the API later is one flag. Undoing it is not: raw and rows would be in git history, and §7.4 expects deletion. So the default is off, rows from it carry the tag `fitness:strava-api`, and the export route loses little because Polar and the direct files already cover the same activities going forward.
- A missed MyWhoosh ride is permanent when its one file is overwritten and Strava's link is also off. See the README.
- A wrong merge hides one activity from totals, never data: raw and facts stay, and the threshold is conservative.

## Consequences
- The KB gains one view, one observation category and one generated block; every clinical reader is unchanged and tested so.
- An env that runs the pull supplies four secret names (`env.manifest.yaml`); without them it reports "awaiting credentials" and exits 0.
- Repo growth: small rows, plus raw FIT files of tens to hundreds of KB. A large Strava export belongs in one reviewed commit, not a surprise.
