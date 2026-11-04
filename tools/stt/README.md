# tools/stt, tools/answers, tools/stt-eval: Mac audio pipeline

Long, multi-speaker Hindi/Hinglish recordings (phone calls with doctors and family, voice notes) in a records repo,
processed on a Mac (Apple silicon, Metal) when it is awake. The GitHub batch keeps its own whisper transcript
(`.transcript.md` / `.batch.transcript.md`) as the fallback; the two never write each other's files.

```sh
tools/stt/setup-mac.sh                                    # engines into ~/Library/Caches/saturn-stt (pinned, sha256-checked)
tools/stt/stt doctor                                      # what is ready (engines, venv, HF token, claude)
tools/stt/stt pending --records <dir>                     # audio without a .mac.transcript.md
tools/stt/stt transcribe <audio> --records <dir> [--min-speakers 2]   # one file (a call: at least two speakers)
tools/stt/stt run --records <dir> [--limit N]             # all pending + answer proposals + eval; prints changed paths
tools/stt/mac-run.sh --records <clone>                    # one runner pass (lock, battery, pull, run, signed commit, push)
tools/answers/answers list|propose|confirm|reject ...      # answer proposals from recordings
tools/stt-eval/stt-eval --records <dir> [--no-judge]      # score engine outputs against ground truths
python3 -I tools/stt/test_stt.py                          # synthetic tests (fake engines, fake claude)
```

## Engines (all local except the Opus steps)

| Step | Engine | Pin |
|---|---|---|
| ASR 1 | whisper.cpp `whisper-cli`, Metal build | v1.9.5, commit `d1be6fde11ac`; model `ggml-large-v3-turbo-q5_0` sha256 `394221709cd5` |
| ASR 2 | Meta MMS-1b-all + Hindi adapter (CTC, transformers, MPS else CPU), 20 s chunks | HF revision `3d33597edbda`; every file sha256-checked |
| Speakers (optional) | pyannote `speaker-diarization-community-1` | revision `3533c8cf8e36`; every file sha256-checked; the owner's HF token fetches it once, runs are offline |
| Suggested reading | Opus (`claude -p --model claude-opus-5-5 --tools ""`) | no tools; env = model auth, locale, paths |
| Python deps | `requirements-mac.txt` | hash-pinned (`uv pip compile --generate-hashes`), Python 3.12 venv |

whisper runs with the batch's production settings (`adapters/stt/whisper-cpp.ts`; `test_stt.py` fails if they drift):
`-l hi` first and auto-detect as the fallback (or first when a detection pass is confident the speech is not
Hindi/Urdu), `--max-context 0`, entropy/log-prob thresholds, temperature fallback, the repetition post-check, and
**never** `--translate`. Both call sites pass the records key-term list `eval/stt-terms.txt` (non-comment lines in file
order, joined by ", ") as whisper's initial prompt (`--prompt`), so the engine favours the family's medicine, place and
symptom words; the prompt is cut at 700 characters (about 180 tokens, whole terms only) and logs carry only the term
count. `--output-json-full` gives token times, from which words get times; long segments are split
at pauses/punctuation (at most 12 s) so quotes have useful time ranges. MMS words are aligned to those segments by
time; MMS words far from any whisper segment (speech whisper skipped) keep their own rows.

**Diarization** runs only when `~/.config/saturn/hf.token` exists (mode 0600; `SATURN_HF_TOKEN_FILE` overrides) and
the owner has accepted the terms of `pyannote/speaker-diarization-community-1` on Hugging Face; `setup-mac.sh` then
copies the pinned weights into the cache. Without it the transcript has no speaker labels and says so in its banner
and front matter. Labels are per file (`S1` in one recording is not `S1` in another) and never name a person.
Community-1 replaced 3.1 because it keeps a short second voice as its own turn where 3.1 folds it into the main one.

- **Speaker count.** Default: free (`min 1`, no max), for voice notes. `stt transcribe` takes `--speakers N`,
  `--min-speakers N`, `--max-speakers N`; a file named like a call (`...-call-...`) gets `--min-speakers 2`.
- **Second-voice check** (free runs only, clips of 5 s or more, when the first pass finds one speaker). The voice of
  each 1 s window of speech is compared with the file's median voice. If a stretch stands out (distance >= 0.7 with a
  robust z-score >= 3.5), or the pipeline heard a second speaker only under the first, the pipeline runs again with
  `min_speakers=2`. That pass is kept only when its speakers' voices differ (centroid distance >= 0.4). Forced splits of
  one voice score 0.07-0.16 and real second speakers 0.64+, so otherwise the one-speaker result stays and the stretch that
  stood out becomes `S?`. The front matter records the outcome. The thresholds come from few clips.
- **Assignment.** Whisper words go to the speaker with the most time overlap in the pipeline's exclusive diarization
  (one speaker at a time). A line splits where the speaker changes, unless the words have only estimated times.
  There are no combined labels such as `S1+S2`.
- **`S?` (needs a listener)** replaces a confident label when the line is in a speaker's stretch shorter than 2 s in a
  multi-speaker file (gaps up to 1 s join a stretch), when under 30% of its word time overlaps its speaker, when no
  turn covers it, or when the second-voice check marked it. Each one is in the Listener checks list, and
  `speaker_uncertain_rows` in the front matter counts them. Whisper word times are coarse, so a boundary can be off by a word.

**IndicConformer** (AI4Bharat) is a planned optional third engine: it needs the same token file and its own terms.
Add it as a `workers.py` subcommand plus a raw section; the reconcile prompt and the eval pick up new sections.

## Output: `<audio-stem>.mac.transcript.md`

Front matter: engines, versions, settings, attempts, timings and real-time factors, diarization on/off (with the
reason), reconcile status and the number of auto-flagged words. Then a "machine transcript — needs a listener"
banner, and sections, every line `[mm:ss.s → mm:ss.s] [speaker] text` (speaker only with diarization):

1. **Suggested reading** (agent-reconciled, agent-inferred, not verified), in Devanagari, uncertain words `(?)`.
2. **Listener checks**: numbers, doses, medicine names and body parts, every word no engine supports, and every `S?` line.
3. **Raw whisper** and **Raw MMS**: verbatim engine output. These are the record of what the machines heard.

Rules given to Opus: use only words at least one engine supports (this segment or a neighbour); never add content or
complete sentences; never make a claim more specific than what was said (बीमार stays बीमार, never "fever"); keep
negations as spoken; keep English loanwords; mark uncertainty; list numbers/doses/medicine names; no translation,
gloss, interpretation or advice. Then a deterministic **support check**: every word of the reading must match a word
of whisper or MMS (same segment or a neighbour) with normalised similarity >= 0.65; otherwise it is marked `(?)` and
listed under Listener checks. This is what catches "beemaar → fever"-type substitutions even when the model slips.
If every Opus call fails (auth, rate limit), nothing is written and the next run retries.

The tool writes only `.mac.transcript.md` files, and overwrites one only with `--force` and only if it wrote it.
Logs carry file ids, counts and timings; never transcript text.

## Answer proposals (`tools/answers`)

After a transcript is written, `propose` reads the open questions of `docs/health/<ns>/questions.md` (the `### <ns>:q:NNNN`
blocks under `## Open ...`) and asks Opus which ones the recording **addresses**. Each proposal has the verbatim quote
from the suggested reading and from raw whisper, speaker, time range and confidence, and says "needs listener
confirmation". Quotes are checked against the transcript lines in the cited range; a non-verbatim quote drops the
proposal. A short "new information not tied to a question" list follows. Output: `docs/health/<ns>/answer-proposals.md`
(generated; one block per audio id; state in JSON comments). `propose` never edits `questions.md`.

```sh
tools/answers/answers confirm mother:prop:<audio-id>.01 --records . [--edit "what was actually said"] [--keep-open]
tools/answers/answers reject  mother:prop:<audio-id>.02 --records . [--reason "misheard"]
```

`confirm` takes the next free `<ns>:ans:NNNN`, adds a row to the `## Answered` table (question, answer, source =
audio path + time range + "listener-confirmed by <who> <date>", date) and removes the open block (`--keep-open`: keeps
it with a dated update line and names it as the open remainder). Listen to the cited range first.

## Evaluation (`tools/stt-eval`)

A person who listens and writes `<audio-stem>.groundtruth.md` (front matter, then `[speaker] text` lines in Latin
transliteration, an optional `terms:` line and `notes:`) adds a clip to the eval set. `stt-eval` (also run by every
`stt run`) scores each available output for that audio: `mac:suggested`, `mac:whisper`, `mac:mms`, `batch:whisper`.

- **CER / WER**: edit distance over normalised characters / words divided by the reference length.
- **Key-term recall**: ground-truth `terms:` plus the records list `eval/stt-terms.txt` (medicines, symptoms; one per
  line), counted only for terms present in the ground truth; found when a window of as many words reaches normalised
  similarity >= 0.75.
- **Meaning fidelity** (Opus judge, rubric `stt-judge-v1`): each ground-truth line same / minor / changed / missing,
  plus hypothesis statements not in the ground truth (added).
- **Clinical fidelity** (same judge): every symptom, medicine, dose/number, negation, time reference and speaker
  attribution in the ground truth: exact / more specific than said / less specific / wrong / missing, plus added
  clinical claims. "More specific" is the dangerous direction.

The judge runs with a fixed system prompt and JSON schema and returns labels and counts only. The CLI has no
temperature setting, so reruns can move a label; compare rows of the same rubric version and treat one-label moves
as noise. Results: `eval/stt-results.ndjson` (append-only, numbers and labels only, no text) and the generated
summary `eval/stt-results.md` in the records repo.

### Normalisation (`sttlib.norm_words`)

1. Drop bracketed annotations (`[noise: fan]`, speaker tags) and `(?)`.
2. Devanagari → Latin with a simple map: consonants carry an inherent `a` except before a vowel sign or virama and at
   the end of a word (simplified schwa deletion); vowel signs `ा aa, ि i, ी ii, ु u, ू uu, े e, ै ai, ो o, ौ au, ॉ o`;
   anusvara and chandrabindu → `n`; nukta dropped (`ज़` = `ज`); Devanagari digits → ASCII.
3. Lowercase; anything but `a-z0-9` becomes a space.
4. Variant merging, in order: `ph→f`, `ch→x`, other `c→k`, aspiration `h` after a stop or `r` dropped, `sh→s`,
   `w→v`, `z→j`, `q→k`, `ee/ii→i`, `oo/uu→u`, doubled letters single, `ai/ay→a`, `au→o`, word-final `n` after a vowel
   dropped. So बीमार = beemaar, नहीं हैं = nahin hain, कॉफ़ी = coffee.

The merging is deliberately loose (it scores what was heard, not spelling). Numbers from an earlier ad-hoc eval
with a different normalisation are not comparable with these.

## Mac runner

`mac-run.sh` is what a launchd user agent runs every ~10 minutes (the env repo installs it): pause file
(`~/.config/saturn/stt.pause`) → lock (`<cache>/run.lock`, stale-pid safe) → skip on battery below 20% → refuse a
dirty clone → `git pull --rebase` → `stt run` → `git add` only the files the run wrote → signed commit (the user's git
signing config) → `git pull --rebase` → push (a failed push stays local and is retried next run). Log:
`~/Library/Logs/saturn-stt/runner.log`. Use a dedicated records clone, not a working copy someone edits.
