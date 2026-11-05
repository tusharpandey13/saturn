#!/usr/bin/env -S python3 -I
"""Tests for tools/site/build on the synthetic example records (stdlib unittest; no real data).

Run: python3 -I tools/site/test_site.py
The fixture records are copied to a temp dir and given a few extra synthetic inputs (a second lab report for trends,
questions, family to-dos, an analysis note with an external URL, an inference row) so every screen has content.
"""
import html.parser, importlib.machinery, importlib.util, json, os, pathlib, re, shutil, subprocess, sys, tempfile
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
DX_NOTE = """---
title: "Alice: diagnostic loop 01 (synthetic)"
type: analysis
---

# Alice: diagnostic loop 01 (synthetic)

## For Owner: what the week says

**What changed.** Synthetic prose with a number 5.3 that must not be copied as a fact.

**Next steps (tiered; nothing is Tier A today).**
1. **Tier C, this week, free (family):** keep the morning seated reading to 30-Jun, one reading per day.
2. **Tier C, this week (owner, one call):** ask which hand was used on 12-Jun; see [questions](../../health/alice/questions.md).
3. **Tier B, by 28-Jun (owner books):** repeat potassium at the same lab (`alice:q:0001`).
4. Tier C: photograph the strip of the new tablet.
5. **Tier C, someday:** tidy the care-team page.
6. **Tier C, never shown:** the sixth step is beyond the five the overview shows.

The panel disagreed on step 3.

## 0. Red flags

1. Not a next step: a numbered line in another section.

## F. For the family (plain words)

1. Family step that must not be mixed in.
"""
TG_EXTRA = [
    # what the two fixture voice notes say (d1.statements): ex1 (update 900000004) nobody has heard; ex2 is heard
    {"rt": "d1.statements", "id": "-1001234567890:21:s0", "source_message_id": "-1001234567890:21", "person_id": "alice",
     "sender_person_id": "alice", "speaker": "sender", "category": "reading", "summary": "numbers said as 122, 152, 152, not clear which is systolic",
     "quote": "एक सौ बाईस", "negated": 0, "time_frame": "today", "when_text": None, "when": "2026-06-11", "about": None,
     "confidence": 0.6, "confirmed": 0, "extracted_by": "fixture-extractor", "extracted_at": "2026-06-11T05:00:00.000Z"},
    {"rt": "d1.statements", "id": "-1001234567890:21:s1", "source_message_id": "-1001234567890:21", "person_id": "alice",
     "sender_person_id": "alice", "speaker": "sender", "category": "symptom", "summary": "feeling fine, no problem",
     "quote": "कोई दिक्कत नहीं", "negated": 1, "time_frame": "today", "when_text": None, "when": "2026-06-11", "about": None,
     "confidence": 0.9, "confirmed": 0, "extracted_by": "fixture-extractor", "extracted_at": "2026-06-11T05:00:00.000Z"},
    {"rt": "d1.statements", "id": "-1001234567890:22:s0", "source_message_id": "-1001234567890:22", "person_id": "alice",
     "sender_person_id": "alice", "speaker": "sender", "category": "medication", "summary": "took the evening tablets",
     "quote": "शाम की गोली ली", "negated": 0, "time_frame": "today", "when_text": None, "when": "2026-06-12", "about": None,
     "confidence": 0.9, "confirmed": 0, "extracted_by": "fixture-extractor", "extracted_at": "2026-06-12T05:00:00.000Z"},
    # two BP photos: a single reading, then a stored device average (reading_kind average) as the latest value
    {"rt": "d1.messages", "chat_id": "-1001234567890", "confidence": 0.9, "edit_date": 0, "external_id": "tg:900000006",
     "extracted_at": "2026-06-14T05:00:00.000Z", "extracted_by": "fixture-extractor", "extraction_json": None,
     "extraction_status": "ok", "id": "-1001234567890:23", "image_class": "device-reading", "kind": "image", "media_ref": None,
     "person_id": "alice", "raw_text": None, "received_at": "2026-06-14T03:10:00.000Z", "sender_person_id": "alice",
     "subject_hint": None, "subject_set_by": None, "subject_source": "sender"},
    {"rt": "d1.readings", "id": "-1001234567890:23:r0", "source_message_id": "-1001234567890:23", "person_id": "alice",
     "type": "bp", "value": 128, "value2": 80, "value3": 68, "unit": "mmHg", "source_value": None, "source_unit": None,
     "measured_at": "2026-06-14T08:30:00+05:30", "confidence": 0.9, "confirmed": 0, "extracted_by": "fixture-extractor",
     "extracted_at": "2026-06-14T05:00:00.000Z"},
    {"rt": "d1.messages", "chat_id": "-1001234567890", "confidence": 0.9, "edit_date": 0, "external_id": "tg:900000007",
     "extracted_at": "2026-06-15T05:00:00.000Z", "extracted_by": "fixture-extractor", "extraction_json": None,
     "extraction_status": "ok", "id": "-1001234567890:24", "image_class": "device-reading", "kind": "image", "media_ref": None,
     "person_id": "alice", "raw_text": None, "received_at": "2026-06-15T03:10:00.000Z", "sender_person_id": "alice",
     "subject_hint": None, "subject_set_by": None, "subject_source": "sender"},
    {"rt": "d1.readings", "id": "-1001234567890:24:r0", "source_message_id": "-1001234567890:24", "person_id": "alice",
     "type": "bp", "value": 130, "value2": 82, "value3": 70, "unit": "mmHg", "source_value": None, "source_unit": None,
     "measured_at": "2026-06-15T08:30:00+05:30", "reading_kind": "average", "indicator": "AVG AM", "window": "7 days",
     "confidence": 0.9, "confirmed": 0, "extracted_by": "fixture-extractor", "extracted_at": "2026-06-15T05:00:00.000Z"},
]
BASE_INF = {"schema": "inference/1", "problem": "alice:dx:0001", "problem_title": "Potassium above the range",
            "hypothesis": None, "kind": "trend", "p": 0.7, "bucket": ">50%", "reason": "two results in a row (LR: U); capped at +2. No repeat yet.",
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
    (rec / "docs/log/analysis/2026-06-22-alice-dx-loop-01.md").write_text(DX_NOTE)
    with (rec / "data/telegram/2026-06.ndjson").open("a", encoding="utf-8") as fh:
        fh.write("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in TG_EXTRA))
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


def run(rec, out, *extra, env=None):
    return subprocess.run([sys.executable, "-I", str(BUILD), "--records", str(rec), "--out", str(out),
                           "--today", "2026-06-25", *extra], capture_output=True, text=True, env=env)


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
        self.assertIn('title="alice:fact:2026-06-20-example-lab-rft.potassium"', st)
        self.assertNotIn("later retired", st)  # last rev per id wins; retired rows are not shown
        self.assertIn("Potassium above the range", st)
        self.assertIn("example.org/guide", st)
        self.assertIn("../notes/", st)  # the run note is linked
        self.assertIn('class="inferred"', self.pages["alice/overview.html"])
        self.assertNotIn('class="inferred"', self.pages["alice/results.html"])

    def test_status_evidence_is_collapsed_and_labelled(self):
        """Phone review: evidence ids collapse into one summary line, each resolved to date · source · test value,
        linked to the trend page; the raw id survives only as a title. Method jargon leaves the visible reason."""
        st = self.pages["alice/status.html"]
        self.assertIn("<summary>Evidence: 2 for · 0 against</summary>", st)
        self.assertNotIn("<details class=\"ev\" open", st)
        self.assertIn('<a href="trend/potassium.html" title="alice:fact:2026-06-20-example-lab-rft.potassium">'
                      "20-Jun-2026 · Example Lab · Potassium 5.3 mmol/L</a>", st)
        visible = re.sub(r'title="[^"]*"', "", st)
        self.assertNotIn("alice:fact:", visible)
        self.assertIn("Why this probability: two results in a row. No repeat yet.</div>", st)
        self.assertNotIn("LR: U", visible.split("Method notes")[0])
        self.assertIn("<summary>Method notes</summary><div class=\"small\">(LR: U); capped at +2</div>", st)
        self.assertIn('<span title="must not be missed">can&#x27;t-miss</span>', st)
        self.assertNotIn("<summary>Evidence", self.pages["alice/overview.html"])  # short form: unchanged

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
        self.assertIn("alice/medications.html", self.pages)  # docs/health/<ns>/<page>.md -> <ns>/<page>.html
        self.assertIn("family/actions.html", self.pages)
        self.assertIn("alice/pages/questions.html", self.pages)  # questions.html is the built page
        notes = [k for k in self.pages if k.startswith("notes/")]
        self.assertEqual(len(notes), 2)
        ex = self.pages["notes/docs--log--analysis--2026-06-21-alice-example.html"]
        self.assertIn("example.org/paper", ex)
        # U-24: a note about a person carries that person's nav and a way back to the overview
        self.assertIn('<nav aria-label="Main">', ex)
        self.assertIn('<a class="back" href="../alice/overview.html">‹ Alice</a>', ex)
        self.assertIn('<a class="back" href="wiki.html">‹ Wiki</a>', self.pages["alice/medications.html"])

    def test_navigation_no_dead_ends(self):
        for stub in ("alice/doctor.html", "alice/simple.html", "bob/doctor.html", "bob/simple.html"):
            self.assertNotIn(stub, self.pages)  # stub views hidden until built
        ov = self.pages["alice/overview.html"]
        self.assertNotIn("Doctor view", ov)
        self.assertNotIn("Simple view", ov)
        self.assertIn('<a class="back" href="overview.html">‹ Overview</a>', self.pages["alice/todos.html"])
        self.assertIn('<a class="back" href="overview.html">‹ Overview</a>', self.pages["alice/questions.html"])
        for rel, text in self.pages.items():
            if rel.count("/") >= 1 and not rel.startswith(("notes/", "family/")):
                self.assertIn('<nav aria-label="Main">', text, rel)

    def test_this_week_block(self):
        ov = self.pages["alice/overview.html"]
        self.assertIn("<h2>This week", ov)
        self.assertLess(ov.index("<h2>This week"), ov.index("What changed"))  # above the change feed, no scrolling
        block = ov[ov.index("<h2>This week"):ov.index("What changed")]
        self.assertIn("<b>1 to-do now</b>", block)
        self.assertIn("Photograph the strip", block)
        self.assertEqual(block.count("<li>"), 5)  # at most five steps
        self.assertEqual(block.count('<span class="tier">Tier C</span>'), 4)
        self.assertEqual(block.count('<span class="tier">Tier B</span>'), 1)
        self.assertIn("keep the morning seated reading to 30-Jun", block)
        self.assertIn("repeat potassium at the same lab", block)
        self.assertNotIn("sixth step", block)
        self.assertNotIn("Family step", block)
        self.assertNotIn("Not a next step", block)
        self.assertNotIn("**", block)
        self.assertIn('href="../notes/docs--log--analysis--2026-06-22-alice-dx-loop-01.html#for-owner-what-the-week-says"', block)
        self.assertLessEqual(len(re.sub(r"<[^>]+>", " ", block).split()), 180)  # fits a phone screen
        self.assertNotIn("<h2>This week", self.pages["bob/overview.html"])  # no note, no now to-dos: no block

    def test_unchecked_transcripts_never_look_like_facts(self):
        for rel, text in self.pages.items():
            self.assertNotIn("NOT: ", re.sub(r"<[^>]+>", "", text), rel)  # never a leading NOT: (U-06)
        for rel in ("alice/overview.html", "alice/history.html"):
            page = self.pages[rel]
            self.assertIn("Voice note (machine transcript, unchecked)", page)
            self.assertIn('class="ev reported unchecked"', page)
            self.assertIn("said as a negative", page)  # the negated statement, phrased, not "NOT:"
            self.assertIn("Voice note: took the evening tablets", page)  # heard note: rendered normally
            self.assertNotIn("Voice note: numbers said", page)
            self.assertNotIn("122", page.split("What changed")[-1] if rel.endswith("overview.html") else page)
        hist = self.pages["alice/history.html"]
        self.assertIn("numbers said as (number), (number), (number), not clear which is systolic", hist)
        self.assertIn("numbers withheld until someone has heard it", hist)
        self.assertEqual(hist.count("numbers withheld"), 1)  # only where the summary had a number
        # after a listened row the same statements render normally
        lf = self.rec / "data/telegram/listened.ndjson"
        orig = lf.read_text(encoding="utf-8")
        lf.write_text(orig + json.dumps({"update_id": 900000004, "by": "owner", "at": "2026-06-16"}) + "\n")
        try:
            with tempfile.TemporaryDirectory() as tmp:
                out = pathlib.Path(tmp) / "site"
                r = run(self.rec, out)
                self.assertEqual(r.returncode, 0, r.stderr)
                for rel in ("alice/overview.html", "alice/history.html"):
                    page = (out / rel).read_text(encoding="utf-8")
                    self.assertNotIn("machine transcript, unchecked", page)
                    self.assertIn("said as a negative", page)
                hist = (out / "alice/history.html").read_text(encoding="utf-8")
                self.assertIn("Voice note: numbers said as 122, 152, 152, not clear which is systolic", hist)
                self.assertNotIn("numbers withheld", hist)
        finally:
            lf.write_text(orig)

    def test_device_average_labelled(self):
        self.assertEqual(site.obs_display({"components": {"systolic": 130, "diastolic": 82, "reading_type": "average"}}),
                         "130/82 (device average)")
        self.assertEqual(site.obs_display({"components": {"systolic": 128, "diastolic": 80}}), "128/80")
        self.assertEqual(site.obs_display({"value_num": 61, "components": {"reading_type": "average"}}), "61 (device average)")
        res = self.pages["alice/results.html"]
        self.assertIn("130/82 (device average)", res)
        tr = self.pages["alice/trend/bp.html"]
        self.assertIn("130/82 (device average)", tr)
        self.assertIn("128/80</td>", tr)
        hist = self.pages["alice/history.html"]
        self.assertIn("130/82 (device average)", hist)
        self.assertIn('<span class="pill neutral">device average</span>', self.pages["alice/overview.html"])

    def test_no_horizontal_overflow(self):
        css = (self.out / "style.css").read_text(encoding="utf-8")
        self.assertIn("html, body { overflow-x: hidden;", css)
        self.assertRegex(css, r"\.pill \{[^}]*white-space: normal")
        self.assertRegex(css, r"\.pill \{[^}]*max-width: 100%")
        mods = os.environ.get("SITE_PLAYWRIGHT_MODULES")  # node_modules dir with playwright; else static checks only
        if not mods or not shutil.which("node"):
            self.skipTest("set SITE_PLAYWRIGHT_MODULES=<node_modules with playwright> for the 390 px measurement")
        pages = ["alice/overview.html", "alice/status.html", "alice/questions.html", "alice/voice.html",
                 "alice/voice/u-voice-ex1.html", "alice/todos.html", "alice/medicines.html", "alice/results.html",
                 "notes/docs--log--analysis--2026-06-22-alice-dx-loop-01.html"]
        js = f"""
import {{ createRequire }} from 'module';
const require = createRequire({json.dumps(mods.rstrip('/') + '/')});
const {{ chromium, devices }} = require('playwright');
const browser = await chromium.launch({{headless: true}});
const ctx = await browser.newContext({{...devices['iPhone 14']}});
const page = await ctx.newPage();
const out = [];
for (const rel of {json.dumps(pages)}) {{
  await page.goto('file://' + {json.dumps(str(self.out))} + '/' + rel, {{waitUntil: 'load'}});
  out.push(await page.evaluate((rel) => {{
    const wide = [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > window.innerWidth + 1)
      .map(e => e.tagName + '.' + String(e.className).split(' ')[0]).slice(0, 5);
    const tabs = [...document.querySelectorAll('.tabs nav a')].map(a => a.getBoundingClientRect().right <= window.innerWidth + 1);
    const last = document.querySelector('.footer'); const fr = last ? last.getBoundingClientRect() : null;
    window.scrollTo(0, document.documentElement.scrollHeight);
    const bar = document.querySelector('.tabs'); const br = bar ? bar.getBoundingClientRect() : null;
    const fr2 = last ? last.getBoundingClientRect() : null;
    return {{rel, scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth, wide, tabs,
            footerClear: !(fr2 && br) || fr2.bottom <= br.top + 1}};
  }}, rel));
}}
await browser.close();
console.log(JSON.stringify(out));
"""
        with tempfile.TemporaryDirectory() as tmp:
            script = pathlib.Path(tmp) / "measure.mjs"
            script.write_text(js)
            r = subprocess.run(["node", str(script)], capture_output=True, text=True, timeout=180)
        self.assertEqual(r.returncode, 0, r.stderr)
        for m in json.loads(r.stdout.strip().splitlines()[-1]):
            self.assertLessEqual(m["scrollW"], m["innerW"], m)
            self.assertEqual(m["wide"], [], m)
            if not m["rel"].startswith("notes/") or "alice" in m["rel"]:
                self.assertEqual(len(m["tabs"]), 6, m)
                self.assertTrue(all(m["tabs"]), m)
            self.assertTrue(m["footerClear"], m)

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
        # U-08: an .m4a beside the .ogg is offered first (iOS Safari plays it in the page); the original stays
        self.assertIn('<audio controls preload="none"><source src="../../files/sources/alice/media/telegram/u-voice-ex1.m4a" '
                      'type="audio/mp4"><source src="../../files/sources/alice/media/telegram/u-voice-ex1.ogg" type="audio/ogg">'
                      '</audio>', one)
        self.assertIn('href="../../files/sources/alice/media/telegram/u-voice-ex1.m4a">Download the audio (m4a)</a>', one)
        self.assertIn('href="../../files/sources/alice/media/telegram/u-voice-ex1.ogg">original (ogg)</a>', one)
        self.assertTrue((self.out / "files/sources/alice/media/telegram/u-voice-ex1.ogg").is_file())
        self.assertTrue((self.out / "files/sources/alice/media/telegram/u-voice-ex1.m4a").is_file())
        two_src = self.pages["alice/voice/u-voice-ex2.html"]
        self.assertIn('<audio controls preload="none"><source src="../../files/sources/alice/media/telegram/u-voice-ex2.ogg" '
                      'type="audio/ogg"></audio>', two_src)  # no m4a yet: the original only, with the iOS note
        self.assertIn("iOS Safari may not play", two_src)
        self.assertNotIn("iOS Safari may not play", one)
        self.assertIn("Not heard yet", one)
        self.assertIn("suggested reading", one)  # the Mac transcript's reconciled lines fill the text box
        self.assertIn(">[alice] आज मौसम अच्छा(?) है\n[alice] शाम को दो गोली</textarea>", one)  # S1 (dominant voice) -> [<ns>]
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
            self.assertIn("<code>[?]</code> means the machine was unsure who spoke", one)
            # diarization tags: S1 -> [alice], S? -> [?], other Sn -> [Sn], none -> no prefix
            mac = self.rec / "sources/alice/media/telegram/u-voice-ex1.mac.transcript.md"
            orig = mac.read_text(encoding="utf-8")
            mac.write_text(orig.replace("[00:03.5 → 00:07.0] [S1] शाम को दो गोली\n\n## Listener",
                                        "[00:03.5 → 00:05.0] [S?] शाम को\n[00:05.0 → 00:06.0] [S2] दो गोली\n"
                                        "[00:06.0 → 00:07.0] हाँ\n\n## Listener"), encoding="utf-8")
            try:
                r = run(self.rec, out, "--voice-api", "https://api.example.invalid/voice-api/")
                self.assertEqual(r.returncode, 0, r.stderr)
                one = (out / "alice/voice/u-voice-ex1.html").read_text(encoding="utf-8")
                self.assertIn(">[alice] आज मौसम अच्छा(?) है\n[?] शाम को\n[S2] दो गोली\nहाँ</textarea>", one)
            finally:
                mac.write_text(orig, encoding="utf-8")
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

    def test_dx_api_overview(self):
        # the synthetic records carry one loop note for alice (DX_NOTE, 22-Jun-2026 run 01) and none for bob
        ov = self.pages["alice/overview.html"]
        self.assertIn("<h2>Agent run</h2>", ov)
        self.assertRegex(ov, r'<a href="\.\./notes/[^"]+dx-loop-01\.html">Last loop note: 22-Jun-2026 · run 01</a>')
        self.assertNotIn("No loop run yet", ov)
        self.assertIn("Read-only build: no run endpoint.", ov)
        self.assertNotIn("/dx/", ov)
        self.assertIn("form-action 'none'", ov)
        bob = self.pages["bob/overview.html"]
        self.assertIn("<h2>Agent run</h2>", bob)
        self.assertIn("No loop run yet.", bob)
        with tempfile.TemporaryDirectory() as tmp:
            out = pathlib.Path(tmp) / "site"
            r = run(self.rec, out, "--dx-api", "http://dx.example:8092/")
            self.assertEqual(r.returncode, 0, r.stderr)
            ov = (out / "alice/overview.html").read_text(encoding="utf-8")
            self.assertIn('<form method="post" action="http://dx.example:8092/dx/alice/run" accept-charset="utf-8"', ov)
            self.assertIn('<button type="submit">Run the loop (delta)</button>', ov)
            self.assertIn('<a href="http://dx.example:8092/dx/alice/status">Status of the last run</a>', ov)
            self.assertIn("1 run per 24 h and 8 per 30 days", ov)
            self.assertIn("form-action http://dx.example:8092\"", ov)
            self.assertNotIn("Read-only build", ov)
            self.assertNotIn("<script", ov.lower())
            self.assertTrue(list((out / "notes").glob("*dx-loop-01.html")))
            bob = (out / "bob/overview.html").read_text(encoding="utf-8")
            self.assertIn("/dx/bob/run", bob)
            self.assertIn("No loop run yet.", bob)
            # the newest loop note for this person becomes the status line and is rendered
            note = self.rec / "docs/log/analysis/2026-06-23-alice-dx-loop-02.md"
            note.write_text("---\ntitle: Alice: dx loop run 02\n---\n\n# Alice: dx loop run 02\n\nSynthetic run note.\n\n"
                            "Nothing new since the last run.\n\nFacts as written; not advice; doctors decide.\n",
                            encoding="utf-8")
            try:
                r = run(self.rec, out, "--dx-api", "http://dx.example:8092")
                self.assertEqual(r.returncode, 0, r.stderr)
                ov = (out / "alice/overview.html").read_text(encoding="utf-8")
                self.assertRegex(ov, r'<a href="\.\./notes/[^"]+dx-loop-02\.html">Last loop note: 23-Jun-2026 · run 02</a>')
                self.assertNotIn("run 01</a>", ov)
                self.assertTrue(list((out / "notes").glob("*dx-loop-02.html")))
            finally:
                note.unlink()
            r = run(self.rec, out, "--dx-api", "not-a-url")
            self.assertEqual(r.returncode, 2)
            self.assertIn("--dx-api must be an absolute http(s) URL", r.stderr)

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

    def test_m4a_cache(self):
        """--m4a-cache DIR: ffmpeg (faked here) transcodes Ogg-only notes into DIR/<ns>/<stem>.m4a once; the site copies
        the result beside the original, never into the records repo; a failing or missing ffmpeg leaves the Ogg-only page."""
        tmp = pathlib.Path(self.tmp.name)
        fake, log = tmp / "fakebin", tmp / "ffmpeg.log"
        fake.mkdir(exist_ok=True)

        def ffmpeg(code):  # logs argv; on success writes a stub to the last argument (the output path)
            (fake / "ffmpeg").write_text(f'#!/bin/sh\necho "$@" >> "{log}"\nfor a; do last=$a; done\n'
                                         f'[ {code} -eq 0 ] && printf stub > "$last"\nexit {code}\n')
            os.chmod(fake / "ffmpeg", 0o755)
        env = dict(os.environ, PATH=f"{fake}{os.pathsep}{os.environ.get('PATH', '')}")
        out, cache = tmp / "out-m4a", tmp / "m4a-cache"
        ffmpeg(0)
        r = run(self.rec, out, "--m4a-cache", str(cache), env=env)
        self.assertEqual(r.returncode, 0, r.stderr)
        lines = log.read_text().splitlines()
        self.assertEqual(len(lines), 1)  # ex1 has its m4a in records; only ex2 (Ogg-only) is transcoded
        ogg = self.rec / "sources/alice/media/telegram/u-voice-ex2.ogg"
        self.assertEqual(lines[0], f"-nostdin -loglevel error -y -i {ogg.resolve()} -vn -c:a aac -b:a 64k -ac 1 "
                                   f"{cache.resolve()}/alice/u-voice-ex2.tmp.m4a")
        self.assertTrue((cache / "alice/u-voice-ex2.m4a").is_file())
        self.assertEqual([f.name for f in cache.rglob("*.m4a")], ["u-voice-ex2.m4a"])  # no .tmp left behind
        two = (out / "alice/voice/u-voice-ex2.html").read_text(encoding="utf-8")
        self.assertIn('<audio controls preload="none"><source src="../../files/sources/alice/media/telegram/u-voice-ex2.m4a" '
                      'type="audio/mp4"><source src="../../files/sources/alice/media/telegram/u-voice-ex2.ogg" type="audio/ogg">'
                      '</audio>', two)
        self.assertTrue((out / "files/sources/alice/media/telegram/u-voice-ex2.m4a").is_file())
        self.assertTrue((out / "files/sources/alice/media/telegram/u-voice-ex1.m4a").is_file())  # records sibling still copied
        self.assertFalse(ogg.with_suffix(".m4a").exists())  # nothing written into the records repo
        # idempotent: a second build with the same cache reuses the file (no ffmpeg call)
        r = run(self.rec, out, "--m4a-cache", str(cache), env=env)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(len(log.read_text().splitlines()), 1)
        self.assertTrue((out / "files/sources/alice/media/telegram/u-voice-ex2.m4a").is_file())
        # ffmpeg fails: the build still succeeds, one stderr line, Ogg-only block, no partial file
        ffmpeg(1)
        cache2 = tmp / "m4a-cache-fail"
        r = run(self.rec, out, "--m4a-cache", str(cache2), env=env)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("m4a: skipped u-voice-ex2: ", r.stderr)
        two = (out / "alice/voice/u-voice-ex2.html").read_text(encoding="utf-8")
        self.assertIn('<audio controls preload="none"><source src="../../files/sources/alice/media/telegram/u-voice-ex2.ogg" '
                      'type="audio/ogg"></audio>', two)
        self.assertEqual(list(cache2.rglob("*.m4a")), [])
        self.assertFalse((out / "files/sources/alice/media/telegram/u-voice-ex2.m4a").exists())
        # no ffmpeg on PATH at all: same outcome
        (tmp / "emptybin").mkdir(exist_ok=True)
        r = run(self.rec, out, "--m4a-cache", str(cache2), env=dict(os.environ, PATH=str(tmp / "emptybin")))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("m4a: skipped u-voice-ex2: ffmpeg not on PATH", r.stderr)
        # the cache is refused inside the records repo's tracked tree (gitignored paths and outside are fine)
        r = run(self.rec, out, "--m4a-cache", str(self.rec / "docs" / "m4a"), env=env)
        self.assertEqual(r.returncode, 2)
        self.assertIn("m4a cache inside the records repo's tracked tree", r.stderr)
        self.assertFalse((self.rec / "docs" / "m4a").exists())
        r = run(self.rec, out, "--m4a-cache", str(PRODUCT / "tools" / "site" / "m4a-test"), env=env)
        self.assertEqual(r.returncode, 2)
        self.assertIn("product repo", r.stderr)
        self.assertFalse((PRODUCT / "tools" / "site" / "m4a-test").exists())

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
