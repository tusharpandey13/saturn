# tools/fitness: Strava, Polar, Zwift and MyWhoosh data into a records repo

Decision and terms findings: [ADR 015](../../docs/decisions/015-fitness-data-ingest.md). Python stdlib; FIT is read by `fit.py` (a small
reader: the file types here need no SDK). **Data class PHI.** Tests use synthetic data only: `python3 -I tools/fitness/test_fitness.py`.

```sh
tools/fitness/fitness import-fit    --records R --ns NS --source zwift|mywhoosh PATH...   # .fit, .fit.gz or directories
tools/fitness/fitness import-export --records R --ns NS --source strava|polar EXPORT.zip  # official bulk exports
tools/fitness/fitness pull          --records R --ns NS --state S --credentials FILE      # Polar; Strava API only with --strava-api
tools/fitness/fitness normalise     --records R --ns NS                                   # raw -> rows, dedupe, creates fitness.md
tools/fitness/fitness status        --records R --ns NS --state S [--prom]
tools/fitness/fitness-api --records R --ns NS --state S --credentials FILE --bind ADDR --port N --public-url URL --allow LOGIN
```
Then, as for any data change: `tools/kb/build --records R && tools/kb/gen-views --records R`. Output is JSON counts and states; values never
go to stdout or logs. Exit 0 also for "awaiting credentials", "awaiting authorisation", rate limits and provider errors (those are states, read by `status`); 1 = local error.

## What goes where
| What | Where |
|---|---|
| Raw (gzip, never edited, content-addressed) | `sources/<ns>/media/<channel>/<date>-fitness-<channel>-<kind>[-<key>]-<sha12>.<ext>.gz` |
| Rows, one source and one observation per raw file with a row | `data/<ns>/docs/<same stem>.ndjson` |
| Page | `docs/health/<ns>/fitness.md` (block `gen:fitness`; the site renders it at `<ns>/fitness.html`) |
| State: tokens (0600), cursors, status | `--state` directory, the unit's own |

Dates are IST. `kind`: `activity`, `export-activity`, `sleep`, `recharge`, `daily`, `chr` (continuous HR rolled up per day), `cardio`, `alertness`
give rows; `detail` (FIT or streams of an activity), `circadian`, `bio` (Polar biosensing), `export-raw` are kept without rows.

Query: `SELECT at, value_text, json_extract(components, '$.np_w') FROM v_fitness WHERE code = 'ref:code:fitness-activity' AND canonical = 1`.
`tools/search` indexes the rows as kind `fact` (`value_text` is the chunk). They are not in `v_trend`, the lab pages or cross-checks.

`components`: `start_unix`, `elapsed_s`, `moving_s`, `distance_m`, `ascent_m`, `sport`, `sport_detail`, `indoor`, `calories_kcal`, `avg_power_w`, `max_power_w`,
`np_w`, `avg_hr_bpm`, `max_hr_bpm`, `avg_cadence_rpm`, `max_cadence_rpm`, `ef`, `decoupling_pct`, `power_curve_w` (`{"5":..,"60":..,"1200":..}`), `tss`, `ftp_w`, `polar_training_load`.

## Routes, and how far back each one reaches
- **Polar API:** only what is uploaded after registering with your client, exercises for 30 days after upload (so run the pull at least monthly; the timer runs every few hours); daily activity up to 365 days back, sleep and recharge 28 days. Older history: the Polar Flow export (account.polar.com, "Download your data").
- **Strava:** the export (strava.com, Settings, My Account, "Download or Delete Your Account", Request your archive). It holds every activity type. The API pull is off: read ADR 015 first.
- **Zwift:** `Documents/Zwift/Activities/*.fit` (`inProgressActivity.fit` is skipped; empty recordings count as `invalid`).
- **MyWhoosh:** one file, `MyNewActivity-<version>.fit`, **overwritten by the next ride**. Going forward, choose one:
  1. **Strava link in the app (recommended, cheapest):** no code; Strava keeps every ride; the periodic export backfills it. Downside: rows lag until the next export, and only summary plus the FIT Strava keeps.
  2. **Local watcher:** a launchd agent with `WatchPaths` on that file, running `cp` to a dated name in an inbox, then `import-fit` on the inbox. About ten lines, needs no account, keeps the original samples; needs a person to commit from the Mac. Add it if same-day MyWhoosh rows or the original file become worth it.

Export readers follow the documented or commonly seen file shapes and are lenient: an unknown shape is counted, not guessed. The first real export needs a look at those counts.

## Connecting (`fitness-api`, behind `tailscale serve` only)
`GET /` is a phone page with a Connect button per source; `GET /status` is counts only. Redirect URI: `<public-url>/callback/<source>`. If a provider rejects that host, the page's fallback uses `http://localhost/fitness-callback`: approve, copy the whole address of the failed page, paste it in the form. Every route but `/health` needs a `Tailscale-User-Login` header in `--allow`.
Provider values and request lines are never logged. Tokens stay in the state directory; Polar's do not expire unless revoked; Strava's refresh token rotates and is saved before use.
