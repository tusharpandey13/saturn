#!/usr/bin/env -S python3 -I
"""tools/inference tests: python3 -I tools/inference/test_inference.py
A tiny synthetic KB (schema/schema.sql + made-up rows; no real data) and a scratch records dir. Covers add, validation
failures, supersede, retire, review, list, diff, gen (+ --check) and the empty page."""
import json, pathlib, sqlite3, subprocess, sys, tempfile, unittest

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
TOOL = HERE / "inference"
RECORDS_YAML = """schema_version: 7
namespaces:
  - id: alice
    display: Alice
  - id: bob
    display: Bob
  - id: family
    display: Family
    shared: true
"""
ENV = ("test", "2026-01-01")
RUN1 = "docs/log/analysis/2026-01-10-alice-dx-loop-01.md"
RUN2 = "docs/log/analysis/2026-01-20-alice-dx-loop-02.md"


def make_db(path):
    con = sqlite3.connect(path)
    con.executescript((ROOT / "schema" / "schema.sql").read_text())
    for p in ("alice", "bob"):
        con.execute("INSERT INTO person (id, name) VALUES (?, 'Test')", (p,))
    con.execute("INSERT INTO ref (id, ns, kind, name, data, recorded_by, created_at) "
                "VALUES ('ref:code:test', 'ref', 'code', 'Test', '{}', ?, ?)", ENV)
    for sid in ("alice:src:2026-01-01-lab", "alice:src:2026-01-05-chat"):
        con.execute("INSERT INTO source (id, ns, kind, path, rank, recorded_by, created_at) "
                    "VALUES (?, 'alice', 'lab', 'x', 'original', ?, ?)", (sid, *ENV))
    for fid, src in (("alice:fact:2026-01-01-lab.k", "alice:src:2026-01-01-lab"),
                     ("alice:fact:2026-01-05-chat.episode", "alice:src:2026-01-05-chat")):
        con.execute("INSERT INTO fact (id, ns, kind, at, at_precision, data, source_id, recorded_by, created_at) "
                    "VALUES (?, 'alice', 'observation', '2026-01-01', 'day', '{}', ?, ?, ?)", (fid, src, *ENV))
    con.commit()
    con.close()


def row(**k):
    r = {"problem": "alice:dx:0001", "problem_title": "Episodes of arm tingling", "hypothesis": "alice:dx:0001.h1",
         "kind": "hypothesis", "statement": "The episodes may come from a nerve in the neck.", "p": 0.35,
         "bucket": "20-50%", "reason": "Episodes follow neck movement.", "stakes": "can't-miss",
         "evidence_for": ["alice:fact:2026-01-05-chat.episode"], "evidence_against": ["sources/alice/doc.pdf#p2"],
         "citations": [{"ref": "doi:10.1000/example.1", "supports": "typical picture", "verified": "V",
                        "checked_at": "2026-01-10"}],
         "would_change": ["A normal ECG taken during an episode lowers a heart cause."],
         "produced_by": {"model": "test-model", "run": RUN1}, "produced_at": "2026-01-10T10:00:00+05:30"}
    r.update(k)
    return r


class InferenceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = self.root = pathlib.Path(self.tmp.name)
        (t / "records.yaml").write_text(RECORDS_YAML)
        (t / "data").mkdir()
        make_db(t / "data" / "kb.sqlite")
        for d in ("docs/health/alice", "docs/health/bob", "docs/log/analysis", "sources/alice", "inferences/alice"):
            (t / d).mkdir(parents=True)
        (t / "sources/alice/doc.pdf").write_text("synthetic")
        (t / RUN1).write_text("run 1")
        (t / RUN2).write_text("run 2")
        (t / "inferences/alice/inferences.ndjson").write_text("")
        self.store = t / "inferences/alice/inferences.ndjson"

    def tearDown(self):
        self.tmp.cleanup()

    def run_tool(self, *args, stdin=None):
        return subprocess.run([sys.executable, "-I", str(TOOL), "--records", str(self.root), *args],
                              input=stdin, capture_output=True, text=True)

    def add(self, *rows_, ok=True):
        p = self.run_tool("add", "alice", "-", stdin="\n".join(json.dumps(r) for r in rows_))
        if ok:
            self.assertEqual(p.returncode, 0, p.stderr)
        return p

    def lines(self):
        return [json.loads(l) for l in self.store.read_text().splitlines() if l.strip()]

    def test_add_sets_tool_fields_and_numbers(self):
        p = self.add(row(), row(hypothesis="alice:dx:0001.h2", p=0.6, bucket=">50%", stakes="quality-of-life"))
        self.assertEqual(p.stdout.split(), ["alice:inf:0001", "alice:inf:0002"])
        r = self.lines()[0]
        self.assertEqual((r["schema"], r["rev"], r["status"], r["review"], r["label"]),
                         ("inference/1", 1, "active", "none", "agent-inferred"))

    def test_validation_fails_loudly_and_writes_nothing(self):
        bad = [
            (row(evidence_for=["alice:fact:nope"]), "not in the KB"),
            (row(evidence_against=["sources/alice/missing.pdf"]), "does not exist"),
            (row(evidence_for=[], evidence_against=[]), "at least one evidence"),
            (row(bucket=">50%"), "does not match p"),
            (row(p=1.5, bucket=">50%"), "p must be"),
            (row(kind="verdict"), "kind must be"),
            (row(citations=[{"ref": "doi:fake", "supports": "x", "verified": "V", "checked_at": "2026-01-10"}]), "citation ref"),
            (row(citations=[{"ref": "pmid:123", "supports": "x", "verified": "U", "checked_at": "2026-01-10"}]), "V or P"),
            (row(statement="This rules out a heart cause."), "word list"),
            (row(statement="The family should stop the evening tablet."), "word list"),
            (row(would_change=[]), "would_change"),
            (row(produced_by={"model": "m", "run": "docs/log/analysis/nope.md"}), "does not exist"),
            (row(problem="bob:dx:0001"), "problem must be"),
            (row(hypothesis="alice:dx:0002.h1"), "hypothesis must be"),
            (row(produced_at="2026-01-10"), "ISO datetime"),
            (dict(row(), id="alice:inf:0009"), "set by the tool"),
            (dict(row(), extra=1), "unknown field"),
        ]
        for r, msg in bad:
            p = self.add(row(), r, ok=False)
            self.assertEqual(p.returncode, 1, msg)
            self.assertIn(msg, p.stderr)
            self.assertEqual(self.store.read_text(), "", msg)

    def test_trend_wording_allowed(self):
        self.add(row(kind="trend", hypothesis=None, statement="Potassium rose from 4.1 to 5.6 over two months.",
                     p=0.9, bucket=">50%", stakes="housekeeping"))

    def test_supersede_retire_review_diff_gen(self):
        self.add(row(), row(hypothesis="alice:dx:0001.h2", statement="Artefact or record error.", p=0.1,
                            bucket="5-20%", stakes="housekeeping"),
                 row(problem=None, problem_title=None, hypothesis=None, kind="status-summary",
                     statement="Home readings are stable.", p=0.7, bucket=">50%", stakes="quality-of-life"))
        p = self.run_tool("supersede", "alice:inf:0001", "-", stdin=json.dumps(
            {"p": 0.6, "reason": "A new episode followed neck movement.", "produced_by": {"model": "m", "run": RUN2},
             "produced_at": "2026-01-20T10:00:00+05:30"}))
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stdout.strip(), "alice:inf:0004")
        self.assertEqual(self.run_tool("supersede", "alice:inf:0001", "-", stdin="{}").returncode, 1)  # not active
        self.assertEqual(self.run_tool("retire", "alice:inf:0002", "--reason", "excluded by the repeat test").returncode, 0)
        self.assertEqual(self.run_tool("review", "alice:inf:0004", "disputed", "--note", "side differs").returncode, 0)
        cur = {}
        for r in self.lines():
            cur[r["id"]] = r
        self.assertEqual(cur["alice:inf:0001"]["status"], "superseded")
        self.assertEqual(cur["alice:inf:0001"]["superseded_by"], "alice:inf:0004")
        self.assertEqual((cur["alice:inf:0004"]["bucket"], cur["alice:inf:0004"]["supersedes"]), (">50%", "alice:inf:0001"))
        self.assertEqual((cur["alice:inf:0004"]["rev"], cur["alice:inf:0004"]["review"]), (2, "disputed"))
        self.assertEqual(cur["alice:inf:0002"]["status"], "retired")
        act = self.run_tool("list", "alice", "--active").stdout.splitlines()
        self.assertEqual([l.split("\t")[0] for l in act], ["alice:inf:0004", "alice:inf:0003"])
        d = self.run_tool("diff", "alice", "--run", RUN2).stdout
        self.assertIn("| moved | alice:inf:0004 (was alice:inf:0001)", d)
        self.assertIn("20-50% (35%) | >50% (60%)", d)
        self.assertIn("| retired | alice:inf:0002", d)
        self.assertIn("| unchanged | alice:inf:0003", d)
        self.assertEqual(self.run_tool("gen", "--check").returncode, 1)
        self.assertEqual(self.run_tool("gen").returncode, 0)
        self.assertEqual(self.run_tool("gen", "--check").returncode, 0)
        page = (self.root / "docs/health/alice/status.md").read_text()
        self.assertIn("Facts as written; not advice; doctors decide.", page)
        self.assertIn("## Episodes of arm tingling (alice:dx:0001)", page)
        self.assertIn("Agent-inferred · not from a document.", page)
        self.assertIn("Not a diagnosis. Doctors decide.", page)
        self.assertIn("owner: **disputed**", page)
        self.assertNotIn("alice:inf:0002", page)  # retired
        self.assertLess(page.index("alice:dx:0001"), page.index("## Other inferences"))
        self.assertFalse((self.root / "docs/health/bob/status.md").exists())  # no store, no page

    def test_empty_store_page_and_tamper_detection(self):
        self.assertEqual(self.run_tool("gen").returncode, 0)
        self.assertIn("No active inferences yet.", (self.root / "docs/health/alice/status.md").read_text())
        self.add(row())
        r = self.lines()[0]
        r["rev"] = 3
        with self.store.open("a") as fh:
            fh.write(json.dumps(r) + "\n")
        p = self.run_tool("gen")
        self.assertEqual(p.returncode, 1)
        self.assertIn("rev 3 does not follow 1", p.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=1)
