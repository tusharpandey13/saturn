#!/usr/bin/env -S python3 -I
"""Tests for tools/stt, tools/answers and tools/stt-eval. Synthetic data only; engines and Opus are faked
(a fake whisper-cli, a fake venv python for MMS, a fake `claude`), so no model, network or account is needed.
Audio is a generated sine tone (ffmpeg lavfi); skipped where ffmpeg is missing.
Run: python3 -I tools/stt/test_stt.py"""
import importlib.machinery, importlib.util, json, os, pathlib, re, shutil, subprocess, sys, tempfile, textwrap, unittest

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))
import sttlib as L  # noqa: E402


def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


STT = load("stt_tool", HERE / "stt")
WORKERS = load("stt_workers", HERE / "workers.py")
ANS = load("answers_tool", ROOT / "tools/answers/answers")
EVAL = load("stt_eval_tool", ROOT / "tools/stt-eval/stt-eval")

# Synthetic speech (not from any record): "today the weather is good", "I did not eat", "two tablets in the evening"
SEG = [("आज मौसम अच्छा है।", 0.0, 3.0), ("मैंने खाना नहीं खाया।", 3.0, 6.5), ("शाम को दो गोली।", 7.0, 9.5)]

FAKE_WHISPER = r'''#!/usr/bin/env python3
import json, sys
a = sys.argv[1:]
if "--detect-language" in a:
    sys.stderr.write("whisper_full_with_state: auto-detected language: hi (p = 0.970000)\n"); sys.exit(0)
assert "--translate" not in a and "-tr" not in a
out = a[a.index("--output-file") + 1]
segs = json.loads(open(__file__ + ".segs").read())
tr = []
for text, s, e in segs:
    toks, words = [{"text": "[_BEG_]", "offsets": {"from": int(s*1000), "to": int(s*1000)}}], text.split()
    step = (e - s) / len(words)
    for i, w in enumerate(words):
        toks.append({"text": " " + w, "offsets": {"from": int((s + i*step)*1000), "to": int((s + (i+1)*step)*1000)}})
    tr.append({"offsets": {"from": int(s*1000), "to": int(e*1000)}, "text": " " + text, "tokens": toks})
json.dump({"result": {"language": "hi"}, "transcription": tr}, open(out + ".json", "w"), ensure_ascii=False)
'''

FAKE_VENV_PY = r'''#!/usr/bin/env python3
import json, sys
a = sys.argv[1:]
cmd = a[2]
out = a[a.index("--out") + 1]
if cmd == "mms":
    words = [{"w": "आज", "start": 0.1, "end": 0.5}, {"w": "मोसम", "start": 0.6, "end": 1.2}, {"w": "अच्छा", "start": 1.3, "end": 1.9},
             {"w": "मैने", "start": 3.1, "end": 3.6}, {"w": "खाना", "start": 3.7, "end": 4.2}, {"w": "नही", "start": 4.3, "end": 4.8},
             {"w": "शाम", "start": 7.1, "end": 7.5}, {"w": "दो", "start": 7.6, "end": 7.9}, {"w": "गोली", "start": 8.0, "end": 8.6},
             {"w": "पानी", "start": 20.0, "end": 20.5}]
    json.dump({"engine": "facebook/mms-1b-all (adapter hin)", "revision": "fake", "device": "cpu", "words": words, "elapsed_sec": 0.1}, open(out, "w"), ensure_ascii=False)
else:
    open(__file__ + ".diar-args", "w").write(json.dumps(a))
    json.dump({"engine": "fake", "revision": "fake", "speakers": 2, "turns": [{"start": 0, "end": 6.6, "speaker": "S1"}, {"start": 7.0, "end": 8.5, "speaker": "S2"}, {"start": 8.5, "end": 30, "speaker": "S1"}], "elapsed_sec": 0.1}, open(out, "w"))
'''

# Fake `claude`: answers by schema. Reconcile echoes whisper but invents "बुखार" in segment 1 (must be flagged).
FAKE_CLAUDE = r'''#!/usr/bin/env python3
import json, re, sys
a = sys.argv[1:]
schema = a[a.index("--json-schema") + 1]
prompt = sys.stdin.read()
log = __file__ + ".calls"
open(log, "a").write(json.dumps({"tools": a[a.index("--tools") + 1], "model": a[a.index("--model") + 1]}) + "\n")
if '"reading"' in schema:
    segs = json.loads(prompt[prompt.index("{"):])["segments"]
    out = {"segments": [{"id": s["id"], "reading": (s["whisper"] or s["mms"]) + (" बुखार" if s["id"] == 1 else ""), "check": ["दो"] if "दो" in s["whisper"] else []} for s in segs]}
elif '"question_id"' in schema:
    raw = prompt[prompt.index("raw whisper:"):]
    m = re.search(r"\[(\d+:\d\d\.\d) → (\d+:\d\d\.\d)\] (?:\[[^\]]+\] )?(.*खाना.*)", raw)
    sug = prompt[prompt.index("suggested reading"):prompt.index("raw whisper:")]
    ms = re.search(r"\[\d+:\d\d\.\d → \d+:\d\d\.\d\] (?:\[[^\]]+\] )?(.*खाना.*)", sug)
    good = {"question_id": "alice:q:0002", "answer": "She said she did not eat.", "quote_suggested": ms.group(1), "quote_whisper": m.group(3),
            "speaker": "S1", "start": m.group(1), "end": m.group(2), "confidence": "medium"}
    bad = dict(good, question_id="alice:q:0001", quote_whisper="this text is not in the transcript")
    out = {"proposals": [good, bad], "new_information": [{"summary": "Two tablets in the evening.", "quote_whisper": "शाम को दो गोली।", "start": "00:07.0", "end": "00:09.5"}]}
else:
    n = len(re.findall(r"^\d+\. ", prompt.split("HYPOTHESIS:")[0], re.M))
    out = {"sentences": [{"index": i, "label": "same" if i % 2 else "minor"} for i in range(1, n + 1)], "added_statements": 1,
           "clinical": [{"kind": "symptom", "label": "more_specific"}, {"kind": "negation", "label": "exact"}], "added_clinical": 1}
print(json.dumps({"type": "result", "is_error": False, "structured_output": out, "total_cost_usd": 0, "usage": {"output_tokens": 1}}))
'''

QUESTIONS = """---
title: Alice: questions
---

# Alice: questions

## Open: for the GP

### alice:q:0001: Is the cough better?
- **Ask:** Is the cough better?

### alice:q:0002: Is she eating?
- **Ask:** Is she eating normally?
- **Status:** open.

## Family to-dos for this person

- none

## Answered

| Id | Question | Answer as documented | Source | Answered | Open remainder | Was (from) |
|---|---|---|---|---|---|---|
| `alice:ans:0001` | Blood group? | O+ | lab | 2026-01-01 | — | — |

## Dropped / historical
"""

GROUNDTRUTH = """---
type: ground-truth-transcript
audio: "sources/alice/media/telegram/note1.ogg"
---

# Ground truth (synthetic)

[alice] Aaj mausam achchha hai.
[alice] Maine khaana nahin khaaya.
[bob] Shaam ko do goli.

terms: mausam, khaana, goli
"""


def write_exec(path, text):
    path.write_text(textwrap.dedent(text))
    path.chmod(0o755)


class Unit(unittest.TestCase):
    def test_constants_match_batch_adapter(self):
        ts = (ROOT / "adapters/stt/whisper-cpp.ts").read_text()
        self.assertIn(f'WHISPER_VERSION = "{STT.WHISPER_VERSION}"', ts)
        self.assertIn(f'WHISPER_COMMIT = "{STT.WHISPER_COMMIT}"', ts)
        self.assertIn(f'WHISPER_MODEL_SHA256 = "{STT.WHISPER_MODEL_SHA256}"', ts)
        dec = re.search(r"export const DECODE = (\{.*?\});", ts).group(1)
        dec = json.loads(re.sub(r"(\w+):", r'"\1":', dec))
        self.assertEqual(dec, STT.DECODE)
        self.assertIn("TEMPERATURES = [0.0, 0.4]", ts)
        self.assertIn(f"PROMPT_CHARS = {L.PROMPT_CHARS};", ts)
        setup = (HERE / "setup-mac.sh").read_text()
        self.assertIn(STT.WHISPER_COMMIT, setup)
        self.assertIn(STT.WHISPER_MODEL_SHA256, setup)

    def test_never_translate(self):
        args = STT.whisper_args("m", "w", "o", "hi", 0.0, 4)
        self.assertNotIn("--translate", args)
        self.assertNotIn("-tr", args)
        self.assertIn("--output-json-full", args)
        self.assertEqual(args[args.index("--max-context") + 1], "0")
        self.assertNotIn("--prompt", args)
        args = STT.whisper_args("m", "w", "o", "hi", 0.0, 4, "alpha, beta")
        self.assertEqual(args[args.index("--prompt") + 1], "alpha, beta")

    def test_terms_prompt(self):
        self.assertEqual(L.terms_prompt("# medicines\nTermA\n\n  TermB  # brand\n# symptoms\nterm c\n"), ("TermA, TermB, term c", 3))
        self.assertEqual(L.terms_prompt(""), ("", 0))
        self.assertEqual(L.terms_prompt("# only a comment\n\n"), ("", 0))
        prompt, n = L.terms_prompt("\n".join(f"term{i:03d}" for i in range(200)))  # 7 chars each, ", " between
        self.assertEqual(L.PROMPT_CHARS, 700)
        self.assertLessEqual(len(prompt), 700)
        self.assertEqual(n, 78)  # 78 * 7 + 77 * 2 = 700; the 79th would make 709
        self.assertTrue(prompt.startswith("term000, term001") and prompt.endswith("term077"))
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(L.load_terms_prompt(d), ("", 0))
            os.mkdir(os.path.join(d, "eval"))
            pathlib.Path(d, "eval/stt-terms.txt").write_text("# list\nalpha\nbeta\n", encoding="utf-8")
            self.assertEqual(L.load_terms_prompt(d), ("alpha, beta", 2))

    def test_repetition(self):
        self.assertEqual(STT.repetition_verdict([{"text": "एक दो तीन"}]), "ok")
        self.assertEqual(STT.repetition_verdict([{"text": "हाँ " * 10}]), "repetition:run")
        self.assertEqual(STT.repetition_verdict([{"text": "चलो घर चलें"}] * 3), "repetition:segments")
        self.assertEqual(STT.repetition_verdict([]), "empty")

    def test_normalisation(self):
        for a, b in [("बीमार", "beemaar"), ("नहीं हैं", "nahin hain"), ("चक्कर", "chakkar"), ("गैस का दवाई", "Gas ka dawai"), ("कॉफ़ी", "coffee")]:
            self.assertEqual(L.norm_text(a), L.norm_text(b), (a, b))
        self.assertEqual(L.norm_words("[noise: fan] ok (?)"), ["ok"])
        self.assertEqual(L.edit_distance("abc", "abd"), 1)

    def test_parse_whisper_full_words(self):
        raw = json.dumps({"result": {"language": "hi"}, "transcription": [{"offsets": {"from": 0, "to": 2000}, "text": " आज ठीक",
               "tokens": [{"text": "[_BEG_]", "offsets": {"from": 0, "to": 0}}, {"text": " आज", "offsets": {"from": 0, "to": 800}},
                          {"text": " ठी", "offsets": {"from": 900, "to": 1500}}, {"text": "क", "offsets": {"from": 1500, "to": 2000}}]}]})
        lang, segs = STT.parse_whisper_full(raw)
        self.assertEqual(lang, "hi")
        self.assertEqual([w["w"] for w in segs[0]["words"]], ["आज", "ठीक"])
        self.assertEqual((segs[0]["words"][1]["start"], segs[0]["words"][1]["end"]), (0.9, 2.0))

    def test_rows_alignment_and_speakers(self):
        w = {"segments": [{"start": s, "end": e, "text": t, "words": []} for t, s, e in SEG]}
        m = {"words": [{"w": "आज", "start": 0.1, "end": 0.4}, {"w": "दो", "start": 7.6, "end": 7.9}, {"w": "पानी", "start": 20, "end": 20.5}]}
        d = {"turns": [{"start": 0, "end": 6.6, "speaker": "S1"}, {"start": 6.6, "end": 30, "speaker": "S2"}]}
        rows = STT.build_rows(w, m, d)
        self.assertEqual(len(rows), 4)  # 3 whisper segments + one MMS-only gap row
        self.assertEqual(rows[0]["mms"], "आज")
        self.assertEqual(rows[3]["text"], "")
        self.assertEqual([r["speaker"] for r in rows], ["S1", "S1", "S2", "S2"])

    def seg_words(self, *spans):
        """A timed whisper segment of neutral synthetic words, one per (start, end) span."""
        words = [{"w": f"w{i}", "start": a, "end": b} for i, (a, b) in enumerate(spans)]
        return {"start": spans[0][0], "end": spans[-1][1], "text": " ".join(w["w"] for w in words), "words": words, "timed": True}

    def speakers(self, seg, turns):
        return [(r["text"], r["speaker"]) for r in STT.build_rows({"segments": [seg]}, {"words": []}, {"turns": turns})]

    def test_line_splits_at_speaker_change(self):
        seg = self.seg_words((0, 2), (2, 4), (4, 6), (6, 8), (8, 10), (10, 12))
        turns = [{"start": 0, "end": 6, "speaker": "S1"}, {"start": 6, "end": 12, "speaker": "S2"}]
        self.assertEqual(self.speakers(seg, turns), [("w0 w1 w2", "S1"), ("w3 w4 w5", "S2")])

    def test_no_combined_label_and_second_speaker_kept(self):
        # Two speakers overlap the same long line equally: never "S1+S2", and a line wholly inside S2 stays S2.
        seg = {"start": 0, "end": 10, "text": "x", "words": []}
        turns = [{"start": 0, "end": 5, "speaker": "S1"}, {"start": 5, "end": 10, "speaker": "S2"}]
        self.assertIn(self.speakers(seg, turns)[0][1], ("S1", "S2"))
        seg2 = {"start": 6, "end": 9, "text": "y", "words": []}
        self.assertEqual(self.speakers(seg2, turns), [("y", "S2")])

    def test_short_turn_is_uncertain(self):
        seg = self.seg_words((0, 3), (3, 6), (6, 7), (7, 10), (10, 13))
        turns = [{"start": 0, "end": 6, "speaker": "S1"}, {"start": 6, "end": 7, "speaker": "S2"}, {"start": 7, "end": 13, "speaker": "S1"}]
        rows = STT.build_rows({"segments": [seg]}, {"words": []}, {"turns": turns})
        self.assertEqual([(r["text"], r["speaker"]) for r in rows], [("w0 w1", "S1"), ("w2", "S?"), ("w3 w4", "S1")])
        self.assertIn("short turn", rows[1]["speaker_why"])

    def test_short_phrases_of_one_voice_are_not_uncertain(self):
        seg = {"start": 0, "end": 1.5, "text": "x", "words": []}
        self.assertEqual(self.speakers(seg, [{"start": 0, "end": 1.5, "speaker": "S1"}]), [("x", "S1")])

    def test_turns_with_small_gaps_make_one_stretch(self):
        seg = {"start": 0, "end": 1, "text": "x", "words": []}
        turns = [{"start": 0, "end": 1, "speaker": "S1"}, {"start": 1.5, "end": 3.5, "speaker": "S1"}, {"start": 4, "end": 9, "speaker": "S2"}]
        self.assertEqual(self.speakers(seg, turns), [("x", "S1")])

    def test_low_overlap_and_no_turn_are_uncertain(self):
        turns = [{"start": 0, "end": 3, "speaker": "S1"}, {"start": 30, "end": 40, "speaker": "S2"}]
        rows = STT.build_rows({"segments": [self.seg_words((2.9, 8.0)), self.seg_words((15, 16))]}, {"words": []}, {"turns": turns})
        self.assertEqual([r["speaker"] for r in rows], ["S?", "S?"])
        self.assertIn("low overlap", rows[0]["speaker_why"])
        self.assertIn("no speaker turn", rows[1]["speaker_why"])

    def test_estimated_word_times_do_not_split(self):
        seg = dict(self.seg_words((0, 2), (2, 4)), timed=False)
        turns = [{"start": 0, "end": 2, "speaker": "S1"}, {"start": 2, "end": 4, "speaker": "S2"}]
        self.assertEqual(len(self.speakers(seg, turns)), 1)

    def test_second_voice_stretch_found(self):
        times = [i * 0.25 for i in range(40)]
        dists = [0.3 + (i % 3) * 0.02 for i in range(40)]
        self.assertEqual(WORKERS.spread_groups(times, dists), [])  # one steady voice
        dists[30:33] = [0.9, 0.85, 0.8]
        self.assertEqual(WORKERS.spread_groups(times, dists), [(7.5, 9.0)])
        dists = [0.3 + (i % 3) * 0.02 for i in range(40)]
        dists[30] = 0.65  # stands out, but not by enough
        self.assertEqual(WORKERS.spread_groups(times, dists), [])
        self.assertEqual(WORKERS.spread_groups([0, 1], [0.9, 0.9]), [])  # too little to measure

    def test_forced_two_speaker_pass_kept_only_if_voices_differ(self):
        first = {"turns": [{"start": 0, "end": 10, "speaker": "S1"}], "speakers": 1}
        apart = {"turns": [{"start": 0, "end": 5, "speaker": "S1"}, {"start": 5, "end": 10, "speaker": "S2"}], "speakers": 2, "embeddings": [[1.0, 0.0], [0.0, 1.0]]}
        turns, n, c = WORKERS.choose_pass(first, apart, [(4, 5)])
        self.assertEqual((n, c["accepted"], turns), (2, True, apart["turns"]))
        close = dict(apart, embeddings=[[1.0, 0.0], [1.0, 0.1]])
        turns, n, c = WORKERS.choose_pass(first, close, [(4, 5)])
        self.assertEqual((n, c["accepted"], c["uncertain_stretches"]), (1, False, 1))
        self.assertEqual(turns, [{"start": 0, "end": 4, "speaker": "S1"}, {"start": 4, "end": 5, "speaker": "S?"}, {"start": 5, "end": 10, "speaker": "S1"}])
        self.assertEqual(WORKERS.choose_pass(first, dict(apart, embeddings=[[0.0, 0.0], [0.0, 1.0]]), [])[1], 1)  # zero voice vector: unmeasured

    def test_uncertain_stretch_separates_a_short_interjection(self):
        # One voice, one word in a stretch the check marked: the rest of the line keeps its label.
        seg = self.seg_words((0, 3), (3, 6), (6, 6.8), (6.8, 8))
        turns = WORKERS.carve_uncertain([{"start": 0, "end": 8, "speaker": "S1"}], [(6.0, 6.8)])
        self.assertEqual(self.speakers(seg, turns), [("w0 w1", "S1"), ("w2", "S?"), ("w3", "S1")])

    def test_speaker_hints(self):
        self.assertEqual(STT.speaker_hints("note1.ogg"), {})
        self.assertEqual(STT.speaker_hints("2026-01-02-clinic-call.ogg"), {"min_speakers": 2})
        self.assertEqual(STT.speaker_hints("recall.ogg"), {})
        self.assertEqual(STT.speaker_hints("x-call-y.ogg", speakers=3), {"speakers": 3})
        self.assertEqual(STT.speaker_hints("x-call-y.ogg", max_speakers=1), {"max_speakers": 1})
        self.assertTrue(WORKERS.wants_second_voice_check({}, 60))
        self.assertFalse(WORKERS.wants_second_voice_check({}, 3))
        for h in ({"num_speakers": 2}, {"min_speakers": 2}, {"max_speakers": 1}):
            self.assertFalse(WORKERS.wants_second_voice_check(h, 60), h)

    def test_diarization_pin_matches_setup(self):
        setup = (HERE / "setup-mac.sh").read_text()
        self.assertIn(f"DIAR_REV={WORKERS.DIAR_REV}", setup)
        self.assertEqual(WORKERS.DIAR_MODEL.split("/")[1], pathlib.Path(STT.DIAR_MODEL_DIR).name)
        self.assertEqual(WORKERS.UNSURE, STT.UNSURE_SPEAKER)
        block = setup[setup.index("DIAR_FILES=("):setup.index("token_file=")]
        self.assertEqual(len(re.findall(r'"\S+ [0-9a-f]{64}"', block)), 5)  # every file carries a sha256

    def test_support_check_flags_more_specific_word(self):
        rows = [{"text": "लेकिन बीमार भी नहीं हैं", "mms": "लेकिन बिमार भि नहि है"}]
        out, bad = STT.support_check("लेकिन बुखार भी नहीं हैं", rows, 0)
        self.assertEqual(bad, ["बुखार"])
        self.assertIn("बुखार(?)", out)
        out, bad = STT.support_check("लेकिन बीमार भी नहीं हैं", rows, 0)
        self.assertEqual(bad, [])

    def test_split_long_segment(self):
        words = [{"w": f"श{i}," if i % 5 == 4 else f"श{i}", "start": i * 1.0, "end": i * 1.0 + 0.8} for i in range(30)]
        rows = STT.split_segment({"start": 0, "end": 30, "text": " ".join(w["w"] for w in words), "words": words})
        self.assertGreater(len(rows), 2)
        self.assertTrue(all(r["end"] - r["start"] <= STT.SUB_MAX_SEC + 1 for r in rows))

    def test_open_questions_and_answered(self):
        qs = ANS.open_questions(QUESTIONS)
        self.assertEqual([q["id"] for q in qs], ["alice:q:0001", "alice:q:0002"])
        self.assertEqual(ANS.next_ans(QUESTIONS, "alice"), "alice:ans:0002")

    def test_groundtruth_parse_and_score(self):
        lines, terms = EVAL.parse_groundtruth(GROUNDTRUTH)
        self.assertEqual(len(lines), 3)
        self.assertEqual(terms, ["mausam", "khaana", "goli"])
        hyp = [{"text": t, "speaker": None} for t, _, _ in SEG]
        s = EVAL.score(lines, hyp, terms)
        self.assertEqual(s["terms_total"], 3)
        self.assertEqual(s["terms_hit"], 3)
        self.assertLess(s["cer"], 0.35)


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg missing")
class EndToEnd(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="stt-test-"))
        cache, rec = self.tmp / "cache", self.tmp / "records"
        (cache / "bin").mkdir(parents=True)
        (cache / "models").mkdir()
        (cache / "venv/bin").mkdir(parents=True)
        (cache / f"models/{STT.WHISPER_MODEL_NAME}.bin").write_text("fake")
        write_exec(cache / "bin/whisper-cli", FAKE_WHISPER)
        (cache / "bin/whisper-cli.segs").write_text(json.dumps(SEG, ensure_ascii=False))
        write_exec(cache / "venv/bin/python", FAKE_VENV_PY)
        self.claude = self.tmp / "claude"
        write_exec(self.claude, FAKE_CLAUDE)
        audio = rec / "sources/alice/media/telegram/note1.ogg"
        audio.parent.mkdir(parents=True)
        subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=10", "-c:a", "libopus", str(audio)], check=True)
        (rec / "docs/health/alice").mkdir(parents=True)
        (rec / "docs/health/alice/questions.md").write_text(QUESTIONS)
        (audio.with_name("note1.groundtruth.md")).write_text(GROUNDTRUTH)
        (audio.with_name("note1.transcript.md")).write_text("a person's transcript\n")
        self.rec, self.audio = rec, audio
        self.env = {**os.environ, "SATURN_STT_CACHE": str(cache), "SATURN_STT_FAKE_CLAUDE": str(self.claude),
                    "SATURN_HF_TOKEN_FILE": str(self.tmp / "no-token")}

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_tool(self, *args):
        return subprocess.run([sys.executable, "-I", *args], capture_output=True, text=True, env=self.env)

    def test_pipeline(self):
        r = self.run_tool(str(HERE / "stt"), "run", "--records", str(self.rec))
        self.assertEqual(r.returncode, 0, r.stderr)
        written = r.stdout.split()
        mac = "sources/alice/media/telegram/note1.mac.transcript.md"
        self.assertIn(mac, written)
        self.assertIn("docs/health/alice/answer-proposals.md", written)
        self.assertIn("eval/stt-results.ndjson", written)
        self.assertEqual((self.audio.with_name("note1.transcript.md")).read_text(), "a person's transcript\n")  # never touched
        md = (self.rec / mac).read_text()
        self.assertTrue(md.startswith(STT.MARK))
        self.assertIn("needs a listener", md)
        self.assertIn("diarization: off", md)
        self.assertIn("No speaker labels", md)
        self.assertIn("बुखार(?)", md)  # the invented, more specific word is marked
        self.assertIn("no engine supports this word", md)
        self.assertIn("## Raw whisper", md)
        self.assertIn("## Raw MMS", md)
        self.assertIn("[00:20.0 → 00:20.5] पानी", md)  # MMS-only speech keeps its own row
        self.assertNotIn("आज मौसम", r.stderr)  # logs carry no transcript text
        calls = [json.loads(l) for l in (self.tmp / "claude.calls").read_text().splitlines()]
        self.assertTrue(all(c["tools"] == "" and c["model"] == L.OPUS for c in calls))
        # Proposals: the verbatim one kept, the made-up quote dropped; questions.md untouched by propose
        page = (self.rec / "docs/health/alice/answer-proposals.md").read_text()
        self.assertIn("alice:prop:note1.01", page)
        self.assertNotIn("alice:prop:note1.02", page)
        self.assertIn("Needs listener confirmation", page)
        self.assertIn("Two tablets in the evening", page)
        self.assertEqual((self.rec / "docs/health/alice/questions.md").read_text(), QUESTIONS)
        # Eval rows: numbers and labels only, no transcript text
        rows = [json.loads(l) for l in (self.rec / "eval/stt-results.ndjson").read_text().splitlines()]
        self.assertEqual({x["system"] for x in rows}, {"mac:suggested", "mac:whisper", "mac:mms"})
        blob = json.dumps(rows, ensure_ascii=False)
        for word in ("मौसम", "mausam", "खाना"):
            self.assertNotIn(word, blob)
        self.assertEqual(rows[0]["clinical"]["more_specific"], 1)
        self.assertEqual(sum(rows[0]["meaning"][k] for k in ("same", "minor", "changed", "missing")), 3)
        self.assertIn("| mac:whisper |", (self.rec / "eval/stt-results.md").read_text())
        # A second run does nothing (no pending audio, eval rows already present)
        r2 = self.run_tool(str(HERE / "stt"), "run", "--records", str(self.rec))
        self.assertEqual(r2.stdout.strip(), "")
        # Confirm moves the answer into Answered with the next ans id and the audio citation
        r3 = self.run_tool(str(ROOT / "tools/answers/answers"), "confirm", "alice:prop:note1.01", "--records", str(self.rec), "--edit", "She had not eaten.")
        self.assertEqual(r3.returncode, 0, r3.stderr)
        q = (self.rec / "docs/health/alice/questions.md").read_text()
        self.assertNotIn("### alice:q:0002", q)
        self.assertIn("### alice:q:0001", q)
        row = next(l for l in q.splitlines() if l.startswith("| `alice:ans:0002`"))
        self.assertIn("She had not eaten.", row)
        self.assertIn("sources/alice/media/telegram/note1.ogg", row)
        self.assertRegex(row, r"\d\d:\d\d\.\d–\d\d:\d\d\.\d")
        page = (self.rec / "docs/health/alice/answer-proposals.md").read_text()
        self.assertIn("confirmed by owner", page)
        r4 = self.run_tool(str(ROOT / "tools/answers/answers"), "confirm", "alice:prop:note1.01", "--records", str(self.rec))
        self.assertNotEqual(r4.returncode, 0)

    def diarization_on(self):
        token = self.tmp / "token"
        token.write_text("synthetic")
        token.chmod(0o600)
        self.env["SATURN_HF_TOKEN_FILE"] = str(token)

    def test_uncertain_speaker_reaches_transcript_and_checks(self):
        self.diarization_on()
        r = self.run_tool(str(HERE / "stt"), "transcribe", str(self.audio), "--records", str(self.rec), "--min-speakers", "2")
        self.assertEqual(r.returncode, 0, r.stderr)
        md = self.audio.with_name("note1.mac.transcript.md").read_text()
        self.assertIn("[00:00.0 → 00:03.0] [S1]", md)
        self.assertIn("[S?]", md)  # the 1.5 s S2 turn
        self.assertNotIn("+S", md)
        self.assertRegex(md, r"speaker_uncertain_rows: [1-9]")
        self.assertRegex(md, r"- \[00:07\.0\] who is speaking\? S\? — short turn \(under 2 s\): needs a listener")
        self.assertIn("needs a listener", md[md.index("## Listener checks"):])
        args = json.loads((self.tmp / "cache/venv/bin/python.diar-args").read_text())
        self.assertEqual(args[args.index("--min-speakers") + 1], "2")
        self.assertNotIn("--token-file", args)
        lines = L.section(md, "Raw whisper")
        self.assertIn("S?", [l["speaker"] for l in lines])  # the eval and answers parsers read the label

    def test_call_name_is_a_speaker_hint(self):
        self.diarization_on()
        call = self.audio.with_name("2026-01-02-clinic-call.ogg")
        shutil.copy(self.audio, call)
        r = self.run_tool(str(HERE / "stt"), "transcribe", str(call), "--records", str(self.rec))
        self.assertEqual(r.returncode, 0, r.stderr)
        args = json.loads((self.tmp / "cache/venv/bin/python.diar-args").read_text())
        self.assertEqual(args[args.index("--min-speakers") + 1], "2")

    def test_reject_and_keep_open(self):
        self.run_tool(str(HERE / "stt"), "run", "--records", str(self.rec), "--no-eval")
        r = self.run_tool(str(ROOT / "tools/answers/answers"), "reject", "alice:prop:note1.01", "--records", str(self.rec), "--reason", "misheard")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("rejected by owner", (self.rec / "docs/health/alice/answer-proposals.md").read_text())
        self.assertEqual((self.rec / "docs/health/alice/questions.md").read_text(), QUESTIONS)

    def test_never_overwrites_foreign_mac_file(self):
        mac = self.audio.with_name("note1.mac.transcript.md")
        mac.write_text("written by someone else\n")
        r = self.run_tool(str(HERE / "stt"), "transcribe", str(self.audio), "--records", str(self.rec), "--force")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(mac.read_text(), "written by someone else\n")

    def test_reconcile_failure_writes_nothing(self):
        write_exec(self.claude, "#!/bin/sh\necho '{\"type\":\"result\",\"is_error\":true,\"result\":\"Not logged in\"}'\n")
        r = self.run_tool(str(HERE / "stt"), "run", "--records", str(self.rec), "--no-eval")
        self.assertEqual(r.returncode, 0)
        self.assertFalse(self.audio.with_name("note1.mac.transcript.md").exists())
        self.assertIn("reconcile_failed (auth_failed)", r.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=1)
