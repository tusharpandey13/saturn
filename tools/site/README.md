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
