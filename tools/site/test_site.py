#!/usr/bin/env -S python3 -I
"""Tests for tools/site/build on the synthetic example records (stdlib unittest; no real data).

Run: python3 -I tools/site/test_site.py
The fixture records are copied to a temp dir and given a few extra synthetic inputs (a second lab report for trends,
questions, family to-dos, an analysis note with an external URL, an inference row) so every screen has content.
"""
import html.parser, importlib.machinery, importlib.util, json, pathlib, re, shutil, subprocess, sys, tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
PRODUCT = HERE.parents[1]
FIXTURE = PRODUCT / "fixtures" / "records-example"
BUILD = HERE / "build"
TABS = ("overview", "status", "medicines", "results", "history", "wiki")

_loader = importlib.machinery.SourceFileLoader("site_build", str(BUILD))
_spec = importlib.util.spec_from_loader("site_build", _loader)
site = importlib.util.module_from_spec(_spec)
_loader.exec_module(site)

EXTRA_LAB = [
    {"rt": "source", "id": "alice:src:2026-06-20-example-lab-rft", "ns": "alice", "kind": "lab",
     "path": "sources/alice/documents/2026-06-20-example-lab-rft.md", "rank": "original", "issued_at": "2026-06-20",
     "recorded_by": "fixture", "created_at": "2026-10-26", "status": "active", "tags": [],
     "org_id": "ref:party:example-lab", "pages": 1},
    {"rt": "fact", "id": "alice:fact:2026-06-20-example-lab-rft.potassium", "ns": "alice", "kind": "observation",
     "at": "2026-06-20T09:00+05:30", "at_precision": "minute",
     "data": {"code": "ref:code:potassium", "category": "lab", "value_num": 5.3, "unit": "mmol/L", "ref_low": 3.5,
              "ref_high": 5.1, "flag": "H", "flag_basis": "computed"},
     "source_id": "alice:src:2026-06-20-example-lab-rft", "page": 1, "quote": "POTASSIUM 5.3",
     "verification": "agent", "status": "active", "recorded_by": "fixture", "created_at": "2026-10-26", "tags": []},
]
QUESTIONS = """---
title: Alice: questions
---

# Alice: questions

## Open: for the example physician

### alice:q:0001: Potassium repeat
- **Ask:** Potassium was 5.7 (lab flag H). Does it need a repeat test?
- **Why:** the March report printed H.
- **Priority:** now. **Added:** 2026-06-01.
- **Audience:** physician. **Status:** open.

### alice:q:0002: Next review
- **Ask:** When is the next review?
- **Priority:** someday. **Added:** 2026-06-01.
- **Audience:** physician. **Status:** open.

## Answered

| Id | Question | Answer |
|---|---|---|
| `alice:ans:0001` | Blood group? | not recorded |
"""
ACTIONS = """---
title: Family actions
---

# Family actions

## Alice: answer or do

### alice:act:0001: Photograph the strip
- **Do:** Photograph the new strip ([questions](../alice/questions.md)).
- **Priority:** now. **Added:** 2026-06-01.
- **Owner:** admin. **Status:** open.

## Done

### alice:act:0002: Old item
- **Do:** done already.
- **Priority:** now. **Status:** done.
"""
NOTE = """---
title: Alice: example analysis
---

# Alice: example analysis

Agent-written synthetic note. Reference: https://example.org/paper and <https://example.org/x>.
See [the medicines page](../../health/alice/medications.md) and `sources/alice/documents/2026-03-12-example-lab-lft-rft.md`.
"""
BASE_INF = {"schema": "inference/1", "problem": "alice:dx:0001", "problem_title": "Potassium above the range",
            "hypothesis": None, "kind": "trend", "p": 0.7, "bucket": ">50%", "reason": "two results in a row",
            "stakes": "quality-of-life",
            "evidence_for": ["alice:fact:2026-03-12-example-lab-lft-rft.potassium",
                             "alice:fact:2026-06-20-example-lab-rft.potassium"], "evidence_against": [],
            "citations": [{"ref": "url:https://example.org/guide", "supports": "example", "verified": "V",
                           "checked_at": "2026-06-21"}],
            "would_change": ["A repeat result inside the range lowers it."],
            "produced_by": {"model": "example", "run": "docs/log/analysis/2026-06-21-alice-example.md"},
            "produced_at": "2026-06-21T10:00:00+05:30", "supersedes": None, "superseded_by": None,
            "status_reason": None, "review": "none", "review_note": None,
            "recorded_at": "2026-06-21T10:00:00+05:30", "label": "agent-inferred"}
INFERENCES = [
    dict(BASE_INF, id="alice:inf:0001", rev=1, status="active",
         statement="Two of the last two potassium results sit above the lab's printed range."),
    dict(BASE_INF, id="alice:inf:0002", rev=1, status="active", statement="An older belief that was later retired."),
    dict(BASE_INF, id="alice:inf:0002", rev=2, status="retired", status_reason="explained",
         statement="An older belief that was later retired."),
    # ordering: Mixed has a low can't-miss row and a high housekeeping row; Critical must still come first
    dict(BASE_INF, id="alice:inf:0003", rev=1, status="active", problem="alice:dx:0002", problem_title="Zz Mixed",
         stakes="can't-miss", p=0.1, bucket="5-20%", statement="Mixed low."),
    dict(BASE_INF, id="alice:inf:0004", rev=1, status="active", problem="alice:dx:0002", problem_title="Zz Mixed",
         stakes="housekeeping", p=0.9, statement="Mixed high."),
    dict(BASE_INF, id="alice:inf:0005", rev=1, status="active", problem="alice:dx:0003", problem_title="Zz Critical",
         stakes="can't-miss", p=0.4, bucket="20-50%", statement="Critical."),
]


def make_records(tmp, inference=True):
    rec = pathlib.Path(tmp) / "records"
    shutil.copytree(FIXTURE, rec, ignore=shutil.ignore_patterns("kb.sqlite", "kb.tmp"))
    (rec / "data/alice/docs/2026-06-20-example-lab-rft.ndjson").write_text(
        "".join(json.dumps(r) + "\n" for r in EXTRA_LAB))
    (rec / "sources/alice/documents/2026-06-20-example-lab-rft.md").write_text("Synthetic report. POTASSIUM 5.3\n")
    (rec / "docs/health/alice/questions.md").write_text(QUESTIONS)
    (rec / "docs/health/family").mkdir(parents=True, exist_ok=True)
    (rec / "docs/health/family/actions.md").write_text(ACTIONS)
    (rec / "docs/log/analysis").mkdir(parents=True, exist_ok=True)
    (rec / "docs/log/analysis/2026-06-21-alice-example.md").write_text(NOTE)
    if inference:
        (rec / "inferences/alice").mkdir(parents=True)
        (rec / "inferences/alice/inferences.ndjson").write_text("".join(json.dumps(r) + "\n" for r in INFERENCES))
    (rec / ".gitignore").write_text("data/kb.sqlite\nsite/\n")
    git = ["git", "-C", str(rec), "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"]
    subprocess.run(git[:3] + ["init", "-q"], check=True)
    subprocess.run(git + ["add", "-A"], check=True)
    subprocess.run(git + ["commit", "-qm", "fixture"], check=True)
    r = subprocess.run([sys.executable, "-I", str(PRODUCT / "tools/kb/build"), "--records", str(rec)],
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
    return rec


def run(rec, out, *extra):
    return subprocess.run([sys.executable, "-I", str(BUILD), "--records", str(rec), "--out", str(out),
                           "--today", "2026-06-25", *extra], capture_output=True, text=True)


class Links(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.links, self.ids = [], set()

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        for k in ("href", "src"):
            if a.get(k) is not None:
                self.links.append(a[k])
        if a.get("id"):
            self.ids.add(a["id"])


class SiteTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.rec = make_records(cls.tmp.name)
        cls.out = pathlib.Path(cls.tmp.name) / "out"
        r = run(cls.rec, cls.out)
        assert r.returncode == 0, r.stdout + r.stderr
        cls.pages = {p.relative_to(cls.out).as_posix(): p.read_text(encoding="utf-8")
                     for p in cls.out.rglob("*.html")}

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_six_tabs_per_person(self):
        for ns in ("alice", "bob"):
            for t in TABS:
                self.assertIn(f"{ns}/{t}.html", self.pages)
        self.assertNotIn("carol/overview.html", self.pages)  # no facts: no pages
        self.assertIn("index.html", self.pages)
        nav = re.findall(r'<nav aria-label="Main">(.*?)</nav>', self.pages["alice/overview.html"], re.S)[0]
        self.assertEqual(re.findall(r"<span>(\w+)", nav), ["Overview", "Status", "Medicines", "Results", "History",
                                                            "Wiki"])

    def test_build_json(self):
        meta = json.loads((self.out / "build.json").read_text())
        self.assertRegex(meta["records_commit"], r"^[0-9a-f]{40}$")
        self.assertIn("built_at", meta)
        self.assertEqual(meta["people"], ["alice", "bob"])

    def test_no_external_urls_scripts_or_inline_styles(self):
        for p in self.out.rglob("*"):
            if p.suffix not in (".html", ".css", ".json"):
                continue
            text = p.read_text(encoding="utf-8")
            self.assertIsNone(re.search(r"https?://", text, re.I), f"external URL in {p}")
            if p.suffix == ".html":
                self.assertNotIn("<script", text.lower(), p)
                self.assertIsNone(re.search(r"\sstyle=", text), f"inline style in {p}")
                self.assertIn("script-src 'none'", text)
                self.assertIn('name="robots" content="noindex', text)
                self.assertIn("Facts as written; not advice; doctors decide.", text)

    def test_relative_links_resolve(self):
        for rel, text in self.pages.items():
            parser = Links()
            parser.feed(text)
            for link in parser.links:
                self.assertFalse(link.startswith("/") or re.match(r"^[a-z][a-z0-9+.-]*:", link, re.I),
                                 f"{rel}: non-relative link {link}")
                path = link.split("#")[0]
                if not path:
                    continue
                target = (self.out / rel).parent / path
                self.assertTrue(target.resolve().is_file(), f"{rel}: broken link {link}")
                self.assertIn(self.out.resolve(), target.resolve().parents, f"{rel}: link leaves the site {link}")

    def test_originals_copied_only_when_linked(self):
        files = {p.relative_to(self.out).as_posix() for p in (self.out / "files").rglob("*") if p.is_file()}
        self.assertIn("files/sources/alice/documents/2026-03-12-example-lab-lft-rft.md", files)
        self.assertTrue(all(f.startswith("files/sources/") for f in files))

    def test_flag_colour_rule(self):
        self.assertIn('class="pill flag"', site.flag_pill({"flag": "H", "flag_basis": "printed", "value_num": 5.7}))
        self.assertIn('class="pill flag"', site.flag_pill({"flag": "L", "flag_basis": "bold", "value_num": 1}))
        computed = site.flag_pill({"flag": "H", "flag_basis": "computed", "value_num": 5.3})
        self.assertNotIn("pill flag", computed)
        self.assertIn("computed", computed)
        derived = site.flag_pill({"value_num": 9, "ref_low": 1, "ref_high": 5})
        self.assertNotIn("pill flag", derived)
        self.assertIn("computed", derived)
        self.assertIn("No lab range", site.flag_pill({"value_num": 120}))
        self.assertIn("No lab range", site.flag_pill({"value_num": 120}, reported=True))
        # the trend page: printed H is amber, the computed H is not
        page = self.pages["alice/trend/potassium.html"]
        self.assertIn("High (lab flag)", page)
        self.assertIn("outside printed range (computed)", page)
        self.assertEqual(page.count('class="mk flag"'), 1)

    def test_inferred_is_apart_from_facts(self):
        st = self.pages["alice/status.html"]
        self.assertIn('class="inferred"', st)
        self.assertIn("Agent-inferred · not from a document", st)
        self.assertIn("Two of the last two potassium results", st)
        self.assertIn("alice:fact:2026-06-20-example-lab-rft.potassium", st)
        self.assertNotIn("later retired", st)  # last rev per id wins; retired rows are not shown
        self.assertIn("Potassium above the range", st)
        self.assertIn("example.org/guide", st)
        self.assertIn("../notes/", st)  # the run note is linked
        self.assertIn('class="inferred"', self.pages["alice/overview.html"])
        self.assertNotIn('class="inferred"', self.pages["alice/results.html"])

    def test_status_problem_order_matches_inference_gen(self):
        st = self.pages["alice/status.html"]
        heads = [st.index(t) for t in ("Zz Critical", "Zz Mixed", "Potassium above the range")]
        self.assertEqual(heads, sorted(heads))

    def test_questions_and_todos(self):
        ov = self.pages["alice/overview.html"]
        self.assertIn("Does it need a repeat test?", ov)
        self.assertIn("1 to ask now", ov)
        q = self.pages["alice/questions.html"]
        self.assertIn("alice:q:0002", q)
        self.assertIn("Answered", q)
        todos = self.pages["alice/todos.html"]
        self.assertIn("Photograph the strip", todos)
        self.assertNotIn("Old item", todos)

    def test_markdown_pages_and_notes(self):
        self.assertIn("alice/pages/medications.html", self.pages)
        notes = [k for k in self.pages if k.startswith("notes/")]
        self.assertEqual(len(notes), 1)
        self.assertIn("example.org/paper", self.pages[notes[0]])

    def test_status_without_inference_lists_notes(self):
        with tempfile.TemporaryDirectory() as tmp:
            rec = make_records(tmp, inference=False)
            out = pathlib.Path(tmp) / "site"
            r = run(rec, out)
            self.assertEqual(r.returncode, 0, r.stderr)
            st = (out / "alice/status.html").read_text()
            self.assertIn("No inferences yet", st)
            self.assertIn("Alice: example analysis", st)
            self.assertIn("../notes/", st)

    def test_voice_pages(self):
        lst = self.pages["alice/voice.html"]
        self.assertLess(lst.index("voice/u-voice-ex2.html"), lst.index("voice/u-voice-ex1.html"))  # newest first
        self.assertRegex(lst, r'u-voice-ex2\.html"><b>12-Jun-2026</b> · 12 s · Alice<div class="small muted">heard')
        self.assertRegex(lst, r'u-voice-ex1\.html"><b>11-Jun-2026</b> · 7 s · Alice<div class="small muted">not heard yet')
        self.assertIn('href="voice.html"><b>2 voice notes</b> · 1 to hear', self.pages["alice/overview.html"])
        self.assertNotIn("bob/voice.html", self.pages)  # no voice notes: no page, no link
        self.assertNotIn("voice.html", self.pages["bob/overview.html"])
        one = self.pages["alice/voice/u-voice-ex1.html"]
        self.assertIn('<source src="../../files/sources/alice/media/telegram/u-voice-ex1.ogg" type="audio/ogg">', one)
        self.assertTrue((self.out / "files/sources/alice/media/telegram/u-voice-ex1.ogg").is_file())
        self.assertIn("Not heard yet", one)
        self.assertIn("suggested reading", one)  # the Mac transcript's reconciled lines fill the text box
        self.assertIn(">आज मौसम अच्छा(?) है\nशाम को दो गोली</textarea>", one)
        self.assertIn("<summary>Raw whisper (verbatim, timed)</summary>", one)
        self.assertIn("[00:00.0 → 00:03.5] [S1] आज मौसम अच्छा है", one)
        self.assertNotIn("<form", one)  # no endpoint given: read-only
        self.assertIn("Read-only build", one)
        self.assertIn("form-action 'none'", one)
        two = self.pages["alice/voice/u-voice-ex2.html"]
        self.assertIn("<b>Heard</b> by owner on 13-Jun-2026", two)
        self.assertIn("machine transcript", two)  # no Mac transcript: the batch transcript is the fallback
        self.assertIn(">टेस्ट रिकॉर्डिंग एक दो तीन</textarea>", two)

    def test_voice_form_with_endpoint(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = pathlib.Path(tmp) / "site"
            r = run(self.rec, out, "--voice-api", "https://api.example.invalid/voice-api/")
            self.assertEqual(r.returncode, 0, r.stderr)
            one = (out / "alice/voice/u-voice-ex1.html").read_text(encoding="utf-8")
            self.assertIn('<form method="post" action="https://api.example.invalid/voice-api/voice/alice/u-voice-ex1" '
                          'accept-charset="utf-8"', one)
            self.assertIn('<textarea name="text"', one)
            self.assertIn('<button type="submit" name="action" value="heard">Heard, no changes</button>', one)
            self.assertIn('<button type="submit" name="action" value="save">Save corrections</button>', one)
            self.assertIn("form-action https://api.example.invalid\"", one)
            self.assertNotIn("<script", one.lower())
            # a corrected transcript beside the audio is what the box shows (and it is linked)
            gt = self.rec / "sources/alice/media/telegram/u-voice-ex1.groundtruth.md"
            gt.write_text("---\ntype: ground-truth-transcript\nlistened: true\n---\n\n# Ground truth\n\n"
                          "[alice] आज मौसम अच्छा है\n[alice] शाम को दो गोली\n\nnotes: synthetic\n", encoding="utf-8")
            try:
                r = run(self.rec, out, "--voice-api", "https://api.example.invalid/voice-api")
                self.assertEqual(r.returncode, 0, r.stderr)
                one = (out / "alice/voice/u-voice-ex1.html").read_text(encoding="utf-8")
                self.assertIn("corrected transcript", one)
                self.assertIn(">[alice] आज मौसम अच्छा है\n[alice] शाम को दो गोली</textarea>", one)
                self.assertNotIn("notes: synthetic", one)
                self.assertIn("Ground truth file", one)
                self.assertIn("corrected transcript saved", (out / "alice/voice.html").read_text(encoding="utf-8"))
            finally:
                gt.unlink()
            r = run(self.rec, out, "--voice-api", "not-a-url")
            self.assertEqual(r.returncode, 2)

    def test_output_guard(self):
        r = run(self.rec, PRODUCT / "tools" / "site" / "out-test")
        self.assertEqual(r.returncode, 2)
        self.assertIn("product repo", r.stderr)
        self.assertFalse((PRODUCT / "tools" / "site" / "out-test").exists())
        r = run(self.rec, self.rec / "docs" / "site-out")
        self.assertEqual(r.returncode, 2)
        self.assertIn("tracked tree", r.stderr)
        r = run(self.rec, self.rec / "site" / "dist")  # gitignored in the records repo: allowed
        self.assertEqual(r.returncode, 0, r.stderr)
        busy = pathlib.Path(self.tmp.name) / "busy"
        busy.mkdir()
        (busy / "keep.txt").write_text("x")
        r = run(self.rec, busy)
        self.assertEqual(r.returncode, 2)
        self.assertTrue((busy / "keep.txt").exists())

    def test_rebuild_replaces_output(self):
        r = run(self.rec, self.out)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse(self.out.with_name("out.old").exists())

    def test_charts_geometry(self):
        import datetime
        svg = site.charts.range_bar(5.7, 3.5, 5.1, prev=5.3, flagged=True)
        self.assertIn('class="mk now flag"', svg)
        self.assertIn('class="mk prev"', svg)
        d = datetime.date
        pts_a = [{"t": d(2026, 1, 1), "v": 1.0, "lo": 0.5, "hi": 1.2, "lab": "A"},
                 {"t": d(2026, 2, 1), "v": 1.1, "lo": 0.5, "hi": 1.2, "lab": "A"},
                 {"t": d(2026, 3, 1), "v": 1.4, "lo": 0.6, "hi": 1.3, "lab": "B", "flag": True}]
        svg = site.charts.trend_chart([("x", pts_a)])
        self.assertEqual(svg.count('<path class="ln'), 1)  # labs never joined: B has one point, no line
        self.assertEqual(svg.count('class="band"'), 3)     # one step band per result
        self.assertIn("<rect class=\"mk flag\"", svg)       # lab B: square marker, flagged


if __name__ == "__main__":
    unittest.main(verbosity=1)
