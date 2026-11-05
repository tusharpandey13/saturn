# tools/site: the family health site

`tools/site/build --records DIR --out DIR [--voice-api URL]` renders a records repo's KB into static HTML (design:
`docs/design/health-site.md`; no JS, relative links, CSP `script-src 'none'`); the env repo serves it on the tailnet.
Voice notes (Telegram audio recorded in `data/telegram/<month>.ndjson`) get `<ns>/voice.html` (newest first: date,
length, sender, heard or not) and `<ns>/voice/<stem>.html`: an `<audio>` player over the copied original under
`files/` (served as `audio/ogg`; iOS Safari does not play Ogg/Opus in the page, so the page also offers the file to
download; a build-time transcode to m4a was not added because the box has no ffmpeg), the suggested reading from
`<stem>.mac.transcript.md` (fallback: the batch transcript) in a text box, the raw whisper lines collapsed below, and
two buttons, "Heard, no changes" and "Save corrections", that post a plain form (no script) to
`<URL>/voice/<ns>/<stem>` on `tools/site/voice-api` (`--records DIR --bind ADDR --port N`, Python stdlib): "heard"
appends the `data/telegram/listened.ndjson` line, "save" also writes `<stem>.groundtruth.md` beside the audio
(Devanagari or Latin; `tools/stt-eval` scores it and the batch re-extracts the note from it), then commits as
"saturn voice-review" and pushes. `by` comes from the `Tailscale-User-Login` header when `tailscale serve` fronts the
endpoint, else from the form. Without `--voice-api` the pages are read-only. Tests: `python3 -I tools/site/test_site.py`
and `python3 -I tools/site/test_voice_api.py` on `fixtures/records-example` (synthetic voice notes `u-voice-ex1/2`).

`--dx-api URL` adds an "Agent run" block to each person's overview: a status line linking the newest loop note
(`docs/log/analysis/<date>-<ns>-dx-loop-<NN>.md`, rendered under `notes/`; "No loop run yet." when none), the
"Run the loop (delta)" button and a "Status of the last run" link. The button posts a plain form to `tools/site/dx-api`
(`POST /dx/<ns>/run`, `GET /dx/<ns>/status`), which only queues a request; a host timer runs `tools/dx/run` (the
diagnostic loop, ADR 013) in its own records clone and reports to the admin DM. The caps, 1 run per 24 h and 8 per
30 days, are enforced by the endpoint, not the page. The overview's CSP `form-action` is widened to that origin only.
Without the flag the overview is read-only (status line plus "Read-only build: no run endpoint."). Defaults, caps,
tool restrictions and the verifier: [tools/dx/README.md](../dx/README.md). Tests: `python3 -I tools/site/test_dx_api.py`.
