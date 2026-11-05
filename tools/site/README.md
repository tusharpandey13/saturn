# tools/site: the family health site

`tools/site/build --records DIR --out DIR [--voice-api URL] [--m4a-cache DIR]` renders a records repo's KB into static HTML (design:
`docs/design/health-site.md`; no JS, relative links, CSP `script-src 'none'`); the env repo serves it on the tailnet.
Voice notes (Telegram audio recorded in `data/telegram/<month>.ndjson`) get `<ns>/voice.html` (newest first: date,
length, sender, heard or not) and `<ns>/voice/<stem>.html`: an `<audio>` player over the copied original under
`files/` (served as `audio/ogg`; iOS Safari does not play Ogg/Opus in the page: when a `<stem>.m4a` sits beside the
original (the ops transcode, or `--m4a-cache DIR`: a dir outside the records repo where the build runs `ffmpeg` once per
Ogg-only note into `DIR/<ns>/<stem>.m4a`, reused while not older than the original; no ffmpeg or a failure logs one
`m4a: skipped` line and leaves that note Ogg-only; the m4a is copied beside the original in the output only), the player lists it first as `audio/mp4` and the original second,
with download links for both; without it the page offers the Ogg to download), the suggested reading from
`<stem>.mac.transcript.md` (fallback: the batch transcript) in a text box, the raw whisper lines collapsed below, and
two buttons, "Heard, no changes" and "Save corrections", that post a plain form (no script) to
`<URL>/voice/<ns>/<stem>` on `tools/site/voice-api` (`--records DIR --bind ADDR --port N`, Python stdlib): "heard"
appends the `data/telegram/listened.ndjson` line, "save" also writes `<stem>.groundtruth.md` beside the audio
(Devanagari or Latin; `tools/stt-eval` scores it and the batch re-extracts the note from it), then commits as
"saturn voice-review" and pushes. `by` comes from the `Tailscale-User-Login` header when `tailscale serve` fronts the
endpoint, else from the form. Without `--voice-api` the pages are read-only. Tests: `python3 -I tools/site/test_site.py`
and `python3 -I tools/site/test_voice_api.py` on `fixtures/records-example` (synthetic voice notes `u-voice-ex1/2`).

Usability review 05-Nov-2026 (site half): the overview opens with **This week** (the `now` to-dos of that person and the
first five numbered steps, each with its Tier, of the newest analysis note that has a `## For <someone>:` section, linked
to that section); statements read from a voice note nobody has marked heard (`listened.ndjson`) render muted as
"machine transcript, unchecked" with numbers withheld and are kept out of key-number tiles; a negated statement is shown
with a "said as a negative" pill, never a leading "NOT:"; a stored device average reads "(device average)" wherever the
value appears; `docs/health/<ns>/<page>.md` renders at `<ns>/<page>.html` (`<ns>/pages/` only when a built page owns the
name, e.g. `questions`), analysis notes about a person carry that person's nav and a "‹ <name>" breadcrumb; the doctor
and simple stubs are not built or linked until they exist. `test_site.py` measures the fixture pages at 390 px when
`SITE_PLAYWRIGHT_MODULES=<node_modules dir with playwright>` is set (no overflow, six tabs visible, footer clear of the
tab bar); without it the CSS rules are checked statically.
