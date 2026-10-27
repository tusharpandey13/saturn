#!/usr/bin/env -S python3 -I
"""gen-views tests: python3 -I tools/kb/test_gen.py
1. Fixture: a tiny synthetic KB (schema/schema.sql + a few made-up rows, no real data) rendered into a scratch page with
   every block. Checks markers, header, marks, superseded rows, computed flags, untouched outside text, idempotency.
2. Staleness: build the real KB into a temp db, run gen-views on a temp copy of docs/health/ and diff it against the
   committed pages. Fails when someone changed data/ without running gen-views (fix: run it and commit the pages)."""
import filecmp, json, pathlib, shutil, sqlite3, subprocess, sys, tempfile, unittest

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
EXAMPLE = ROOT / "fixtures" / "records-example"
# Records checked by CommittedPagesTest: the synthetic example, or any records repo via --records DIR.
RECORDS = EXAMPLE
if "--records" in sys.argv:
    i = sys.argv.index("--records")
    RECORDS = pathlib.Path(sys.argv[i + 1]).resolve()
    del sys.argv[i:i + 2]
GEN = HERE / "gen-views"
BLOCKS = ["asof", "timeline", "meds-current", "meds-history", "labs", "quality", "glance", "care-team"]
PAGE = "---\ntitle: test\n---\n\n# Test page\n\nHand-written text stays.\n\n" + "\n\n".join(
    f"<!-- gen:{b} start -->\n<!-- gen:{b} end -->" for b in BLOCKS) + "\n\nTrailing narrative stays.\n"


def gen(*args):
    return subprocess.run([sys.executable, "-I", str(GEN), *args], capture_output=True, text=True)


def make_fixture_db(path):
    con = sqlite3.connect(path)
    con.executescript((ROOT / "schema" / "schema.sql").read_text())
    env = dict(recorded_by="test", created_at="2026-01-01")
    con.execute("INSERT INTO person (id, name) VALUES ('alice', 'Test Person')")
    refs = [("ref:code:potassium", "code", "Potassium", {}), ("ref:code:lvef", "code", "LV ejection fraction", {}),
            ("ref:drug:testol", "drug", "Testol", {"generic": "testolol"}),
            ("ref:party:dr-test", "party", "Dr Test", {"kind": "practitioner", "credentials": {
                "degrees": ["MBBS"], "role": "Resident", "specialty": "Cardiology",
                "registration": {"number": "123", "as_printed": "Reg 123 (Test)"}, "verification_summary": "matched"}})]
    for i, k, n, d in refs:
        con.execute("INSERT INTO ref (id, ns, kind, name, data, recorded_by, created_at) VALUES (?, 'ref', ?, ?, ?, ?, ?)",
                    (i, k, n, json.dumps(d), env["recorded_by"], env["created_at"]))
    for sid, rank in (("alice:src:2026-01-01-lab-a", "original"), ("alice:src:2026-01-01-lab-b", "copy"),
                      ("alice:src:2026-02-01-recall", "recollection")):
        con.execute("INSERT INTO source (id, ns, kind, path, rank, recorded_by, created_at) VALUES (?, 'alice', 'lab', ?, ?, "
                    "'test', '2026-01-01')", (sid, f"sources/alice/{sid.split(':')[-1]}.pdf", rank))
    facts = [
        ("2026-01-01-lab-a.potassium", "observation", "2026-01-01", "2026-01-01-lab-a",
         {"code": "ref:code:potassium", "category": "lab", "value_num": 5.6, "unit": "mmol/L", "ref_low": 3.5, "ref_high": 5.1},
         None, "active", None, []),
        ("2026-01-01-lab-b.potassium", "observation", "2026-01-01", "2026-01-01-lab-b",
         {"code": "ref:code:potassium", "category": "lab", "value_num": 5.4, "unit": "mmol/L", "flag": "H",
          "flag_basis": "printed"}, None, "active", None, []),
        ("2026-01-01-lab-a.lvef", "observation", "2026-01-01", "2026-01-01-lab-a",
         {"code": "ref:code:lvef", "category": "imaging", "value_text": "-36%", "method": "overlay"}, "Z-01", "active", None,
         []),
        ("2026-01-01-lab-a.testol", "medication", "2026-01-01", "2026-01-01-lab-a",
         {"status": "prescribed", "brand": "Testol", "drug_id": "ref:drug:testol", "strength": "5 mg",
          "prescriber_id": "ref:party:dr-test"}, None, "superseded", None, []),
        ("2026-01-01-lab-a.testol.2", "medication", "2026-01-01", "2026-01-01-lab-a",
         {"status": "stopped", "brand": "Testol", "drug_id": "ref:drug:testol", "strength": "5 mg"}, None, "active",
         "alice:fact:2026-01-01-lab-a.testol", []),
        ("2026-02-01-recall.visit", "event", "2026-02", "2026-02-01-recall",
         {"type": "opd", "label": "A visit the user recalls"}, None, "active", None, ["user-report"]),
    ]
    for local, kind, at, src, data, unc, status, sup, tags in facts:
        con.execute("INSERT INTO fact (id, ns, kind, at, at_precision, data, source_id, page, verification, uncertain_ref, "
                    "status, supersedes, recorded_by, created_at, tags) VALUES (?, 'alice', ?, ?, ?, ?, ?, 1, 'agent', ?, "
                    "?, ?, 'test', '2026-01-01', ?)",
                    (f"alice:fact:{local}", kind, at, "month" if len(at) == 7 else "day", json.dumps(data),
                     f"alice:src:{src}", unc, status, sup, json.dumps(tags)))
    con.commit()
    con.close()


class FixtureTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        t = pathlib.Path(cls.tmp.name)
        cls.db = t / "kb.sqlite"
        make_fixture_db(cls.db)
        cls.root = t / "repo"
        cls.page = cls.root / "docs" / "health" / "alice" / "all.md"
        cls.page.parent.mkdir(parents=True)
        shutil.copy(EXAMPLE / "records.yaml", cls.root / "records.yaml")
        cls.page.write_text(PAGE)
        cls.first = gen("--db", str(cls.db), "--records", str(cls.root), "--today", "2026-03-01")
        cls.text = cls.page.read_text()

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def block(self, name):
        s = self.text
        return s[s.index(f"<!-- gen:{name} start -->"):s.index(f"<!-- gen:{name} end -->")]

    def test_run_ok(self):
        self.assertEqual(self.first.returncode, 0, self.first.stdout + self.first.stderr)
        self.assertIn("ok: 8 blocks, 1 pages updated", self.first.stdout)

    def test_outside_text_untouched(self):
        self.assertTrue(self.text.startswith("---\ntitle: test\n---\n\n# Test page\n\nHand-written text stays.\n\n"))
        self.assertTrue(self.text.endswith("\n\nTrailing narrative stays.\n"))

    def test_header(self):
        for b in BLOCKS:
            self.assertIn("_Generated from the KB on 2026-03-01 (data as of 2026-02; 6 facts). Don't edit inside this "
                          "block; see AGENTS.md._", self.block(b), b)

    def test_timeline(self):
        tl = self.block("timeline")
        self.assertIn("### 2026", tl)
        self.assertIn("#### Jan-2026", tl)
        self.assertIn("#### Feb-2026", tl)
        self.assertLess(tl.index("Jan-2026"), tl.index("Feb-2026"))  # oldest first
        self.assertIn("superseded by alice:fact:2026-01-01-lab-a.testol.2", tl)
        self.assertIn("user-report; recollection", tl)
        self.assertIn("`sources/alice/2026-01-01-lab-a.pdf` p.1", tl)
        self.assertIn("Potassium: 5.6 mmol/L (H (computed here))", tl)

    def test_meds(self):
        cur = self.block("meds-current")
        self.assertIn("| Testol | Testol | testolol | 5 mg |  | stopped |", cur)
        self.assertNotIn("lab-a.testol` ", cur)  # the superseded row is not current
        self.assertIn("superseded by", self.block("meds-history"))
        self.assertIn("Dr Test (Resident; Cardiology; reg 123; public check: matched)", self.block("meds-history"))

    def test_care_team(self):
        ct = self.block("care-team")
        self.assertIn("| Dr Test | MBBS | Resident | Cardiology |  | Reg 123 (Test) | matched | 01-Jan-2026 | 01-Jan-2026 |", ct)
        self.assertIn("01-Jan-2026: Testol 5 mg (`alice:src:2026-01-01-lab-a`)", ct)
        self.assertIn("Display only.", ct)
        self.assertNotIn("score", ct.lower())

    def test_labs_and_quality(self):
        labs = self.block("labs")
        self.assertIn("| -36% |", labs)
        self.assertIn("uncertain (Z-01)", labs)
        self.assertIn("H (printed)", labs)
        q = self.block("quality")
        self.assertIn("### Conflicts between sources (1)", q)
        self.assertIn("| 2026-01-01 | Potassium |", q)
        self.assertIn("Open hard reads cited by active facts: Z-01 (1).", q)

    def test_idempotent_across_days(self):
        again = gen("--db", str(self.db), "--records", str(self.root), "--today", "2026-12-31")
        self.assertIn("0 pages updated", again.stdout)
        self.assertEqual(self.page.read_text(), self.text)
        self.assertEqual(gen("--db", str(self.db), "--records", str(self.root), "--check").returncode, 0)

    def test_check_detects_stale_and_unknown(self):
        stale = self.root / "docs" / "health" / "alice" / "stale.md"
        stale.write_text("<!-- gen:asof start -->\nold\n<!-- gen:asof end -->\n")
        try:
            r = gen("--db", str(self.db), "--records", str(self.root), "--check")
            self.assertEqual(r.returncode, 1)
            self.assertIn("stale: docs/health/alice/stale.md", r.stdout)
            self.assertEqual(stale.read_text(), "<!-- gen:asof start -->\nold\n<!-- gen:asof end -->\n")
            stale.write_text("<!-- gen:nope start -->\n<!-- gen:nope end -->\n")
            r = gen("--db", str(self.db), "--records", str(self.root), "--check")
            self.assertEqual(r.returncode, 1)
            self.assertIn("unknown block gen:nope", r.stderr)
        finally:
            stale.unlink()


class MedListSnapshotTest(unittest.TestCase):
    """A med-list-complete event splits meds-current: listed drugs vs older drugs not on the list (display only)."""

    def test_two_sections(self):
        with tempfile.TemporaryDirectory() as t:
            t = pathlib.Path(t)
            db = t / "kb.sqlite"
            make_fixture_db(db)
            con = sqlite3.connect(db)
            con.execute("INSERT INTO ref (id, ns, kind, name, data, recorded_by, created_at) VALUES "
                        "('ref:drug:newol', 'ref', 'drug', 'Newol', '{}', 'test', '2026-01-01')")
            ins = ("INSERT INTO fact (id, ns, kind, at, at_precision, data, source_id, verification, recorded_by, "
                   "created_at) VALUES (?, 'alice', ?, ?, 'day', ?, 'alice:src:2026-02-01-recall', 'patient', 'test', "
                   "'2026-02-01')")
            con.execute(ins, ("alice:fact:2026-02-01-recall.newol", "medication", "2026-02-01",
                              json.dumps({"status": "taking", "brand": "Newol", "drug_id": "ref:drug:newol"})))
            con.execute(ins, ("alice:fact:2026-02-01-recall.list", "event", "2026-02-01",
                              json.dumps({"type": "med-list-complete", "drug_ids": ["ref:drug:newol"]})))
            con.commit()
            st = dict(con.execute("SELECT drug, list_status || '/' || display_status FROM v_meds_current").fetchall())
            con.close()
            self.assertEqual(st, {"ref:drug:newol": "on-list/taking",
                                  "ref:drug:testol": "not-in-current-list/not-in-current-list"})
            page = t / "docs" / "health" / "alice" / "medications.md"
            page.parent.mkdir(parents=True)
            page.write_text("<!-- gen:meds-current start -->\n<!-- gen:meds-current end -->\n")
            shutil.copy(EXAMPLE / "records.yaml", t / "records.yaml")
            r = gen("--db", str(db), "--records", str(t), "--today", "2026-03-01")
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            s = page.read_text()
            cur, rest = s.split("#### Not in the current list (01-Feb-2026 complete list)")
            self.assertIn("#### Current (01-Feb-2026 complete list)", cur)
            self.assertIn("| Newol |", cur)
            self.assertNotIn("| Testol |", cur)
            self.assertIn("| Testol | Testol | testolol | 5 mg |  | not-in-current-list (stopped) |", rest)


class StalenessTest(unittest.TestCase):
    """The committed pages must equal a fresh gen-views run on the committed data/ (of RECORDS)."""

    def test_committed_pages_are_current(self):
        with tempfile.TemporaryDirectory() as t:
            t = pathlib.Path(t)
            db = t / "kb.sqlite"
            b = subprocess.run([sys.executable, "-I", str(HERE / "build"), "--records", str(RECORDS), "--db", str(db)],
                               capture_output=True, text=True)
            self.assertEqual(b.returncode, 0, b.stdout + b.stderr)
            shutil.copytree(RECORDS / "docs" / "health", t / "docs" / "health")
            shutil.copy(RECORDS / "records.yaml", t / "records.yaml")
            if (RECORDS / "data" / "meta" / "gen-views.json").exists():
                (t / "data" / "meta").mkdir(parents=True)
                shutil.copy(RECORDS / "data" / "meta" / "gen-views.json", t / "data" / "meta")
            r = gen("--db", str(db), "--records", str(t))
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            stale = []
            for p in sorted((RECORDS / "docs" / "health").rglob("*.md")):
                q = t / p.relative_to(RECORDS)
                if not filecmp.cmp(p, q, shallow=False):
                    stale.append(str(p.relative_to(RECORDS)))
            self.assertEqual(stale, [], "pages out of date with data/: run tools/kb/build --records DIR && "
                                        "tools/kb/gen-views --records DIR, then commit the pages")


if __name__ == "__main__":
    unittest.main(verbosity=1)
