# 014: Mac audio pipeline with a reconciliation layer, answer proposals and a growing eval set

Date: 2026-10-31 · Status: **ACCEPTED** (owner approved the build) · Related: 007 (data model), 008 (three repos),
011 (admin-only output) · Tools: [tools/stt](../../tools/stt/README.md)

## Context
- Recordings are getting longer: phone calls with doctors and family, several speakers, mostly Hindi with English
  words. The daily batch transcribes with whisper.cpp on the GitHub runner at ~5x slower than real time.
- On one 50 s clip with a ground truth (indicative only): whisper large-v3-turbo had the best CER; Meta MMS-1b-all
  (Hindi adapter) was worse overall but caught nouns whisper missed (a medicine word among them); an LLM correction of
  whisper improved CER and key-term recall, but once turned "ill" into "fever", a more specific clinical claim.
- The owner's Mac runs the same whisper model on Metal at ~0.06x real time.

## Decision
1. A **Mac runner** (launchd user agent, installed from the env repo) transcribes every new audio file in the records
   repo when the Mac is awake and pushes one signed commit. The batch's transcript stays as the fallback; the two
   write different files and never overwrite each other or a person's transcript.
2. **Two engines plus optional diarization**: whisper (production settings, never translation) and MMS, aligned by
   time; pyannote speaker labels only when the owner provides a Hugging Face token. All pinned and checksummed.
3. A **reconciliation layer** (Opus, no tools) writes a labelled "suggested reading" per segment under strict rules
   (only engine-supported words; never more specific than said; negations and loanwords kept; uncertainty marked),
   followed by a deterministic support check that marks any word no engine supports. The raw engine outputs remain
   the record.
4. **Answer proposals**: Opus proposes answers only where a recording addresses an open question, with verbatim
   quotes checked against the transcript; a person confirms or rejects with a CLI that writes `questions.md`.
5. **Growing eval set**: each human ground truth scores every engine output (CER/WER, key terms, and two Opus rubrics:
   meaning fidelity and clinical fidelity, which counts "more specific than said" separately). Results are numbers and
   labels only, in the records repo.

## Consequences
- Long recordings get usable transcripts within minutes when the Mac is on; the owner's listening time goes to the
  flagged words and proposals rather than to the whole recording.
- The "more specific than said" failure is bounded twice (prompt rule + support check) and measured by the clinical
  rubric. Engine choices are made from the eval set, not from one clip.
- New dependencies on the Mac (torch, transformers, pyannote: hash-pinned) and ~5 GB of models in a cache. Opus calls
  cost money per recording (reconcile, proposals, judge); the judge runs once per new ground truth or output.
- The LLM judge is not deterministic (the CLI has no temperature): rubric versions are recorded; small moves are noise.
- IndicConformer is designed in as an optional extra engine once the owner's token exists.
