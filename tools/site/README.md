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
`<URL>/voice/<ns>/<stem>` on `tools/site/voice-api` (`--records DIR --bind 127.0.0.1 --port N --allow-login LOGIN`, Python stdlib; POSTs need a `Tailscale-User-Login` header on the allow-list): "heard"
appends the `data/telegram/listened.ndjson` line, "save" also writes `<stem>.groundtruth.md` beside the audio
(Devanagari or Latin; `tools/stt-eval` scores it and the batch re-extracts the note from it), then commits as
"saturn voice-review" and pushes. `by` comes from the `Tailscale-User-Login` header when `tailscale serve` fronts the
endpoint, else from the form. Without `--voice-api` the pages are read-only. Tests: `python3 -I tools/site/test_site.py`
and `python3 -I tools/site/test_voice_api.py` on `fixtures/records-example` (synthetic voice notes `u-voice-ex1/2`).

Fitness (ADR 015): `docs/health/<ns>/fitness.md` renders like any page at `<ns>/fitness.html`, linked from the wiki; device sources stay out of the documents list and the results page.

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

`--dx-api URL` adds an "Agent run" block to each person's overview: a status line linking the newest loop note
(`docs/log/analysis/<date>-<ns>-dx-loop-<NN>.md`, rendered under `notes/`; "No loop run yet." when none), the
"Run the loop (delta)" button and a "Status of the last run" link. The button posts a plain form to `tools/site/dx-api`
(`POST /dx/<ns>/run`, `GET /dx/<ns>/status`), which only queues a request; a host timer runs `tools/dx/run` (the
diagnostic loop, ADR 013) in its own records clone and reports to the admin DM. The caps, 1 run per 24 h and 8 per
30 days, are enforced by the endpoint, not the page. The overview's CSP `form-action` is widened to that origin only.
Without the flag the overview is read-only (status line plus "Read-only build: no run endpoint."). Defaults, caps,
tool restrictions and the verifier: [tools/dx/README.md](../dx/README.md). Tests: `python3 -I tools/site/test_dx_api.py`.

Symptom context cards ([design](../../docs/design/symptom-context-card.md), `tools/symptom`): every source with a new
symptom (an observation with category symptom or a voice-note statement with category symptom, last 14 days) gets
`<ns>/symptom/<id>.html` (owner: what was said with listener status, same day and day before, medicines alongside,
label mentions with set ids, rule-based warning signs with rule id and tier, at most 5 questions, what would close it,
and an agent-inferred line only when an inference cites the symptom) and `<ns>/symptom/<id>-family.html` (sections 1, 5
in calm words, 7). The overview lists them under "What changed"; timeline rows link to them. The build reads only
`<records>/labels/` (written by `tools/symptom/labels fetch`) and fails on a word-list hit in the card's own words. With
`--dx-api URL` the owner card posts its questions to `<URL>/ask/<ns>` (one DM to the admin; CSP `form-action` widened
to that origin on card pages); without it the message is shown to copy.
