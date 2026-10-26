#!/usr/bin/env -S python3 -I
"""KB build tests (ADR 007): python3 -I tools/kb/test_build.py
Runs against the synthetic records in fixtures/records-example (namespaces from its records.yaml).
1. Telegram mapping: a throwaway KB from the example records plus the synthetic fixture month
   tools/kb/fixtures/telegram/2026-10.ndjson (in place of data/telegram/).
2. Validation: a copy of the example records with one bad row injected per case must fail with the expected error.
3. records.yaml: a missing file or an unsupported schema_version is refused."""
import json, pathlib, shutil, sqlite3, subprocess, sys, tempfile, unittest

HERE = pathlib.Path(__file__).resolve().parent
RECORDS = HERE.parents[1] / "fixtures" / "records-example"
DATA = RECORDS / "data"
U = "00000000-0000-4000-8000-000000000"
SRC = "alice:src:2026-03-12-example-lab-lft-rft"
DOC = "alice/docs/2026-03-12-example-lab-lft-rft.ndjson"


def build(*args):
    return subprocess.run([sys.executable, "-I", str(HERE / "build"), *args], capture_output=True, text=True)


def fact(local, **kw):
    ns = kw.pop("ns", "alice")
    row = {"rt": "fact", "id": f"{ns}:fact:{local}", "ns": ns, "kind": "observation", "at": "2026-03-12T10:15+05:30",
           "at_precision": "minute", "data": {"code": "ref:code:potassium", "category": "lab", "value_num": 4.1,
                                              "unit": "mmol/L"},
           "source_id": SRC, "page": 2, "locator": "test", "quote": "POTASSIUM 4.1", "context_id": None,
           "verification": "agent", "uncertain_ref": None, "status": "active", "supersedes": None,
           "recorded_by": "test", "created_at": "2026-10-26", "tags": []}
    row.update(kw)
    return row


class TelegramMappingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        db = pathlib.Path(cls.tmp.name) / "kb.sqlite"
        cls.out = build("--records", str(RECORDS), "--telegram", str(HERE / "fixtures" / "telegram"), "--db", str(db))
        cls.con = sqlite3.connect(db) if db.exists() else None

    @classmethod
    def tearDownClass(cls):
        if cls.con:
            cls.con.close()
        cls.tmp.cleanup()

    def q(self, sql):
        return self.con.execute(sql).fetchall()

    def test_build_ok(self):
        self.assertEqual(self.out.returncode, 0, self.out.stdout + self.out.stderr)
        self.assertTrue(self.out.stdout.startswith("ok:"), self.out.stdout)

    def test_messages_become_sources(self):
        self.assertEqual(self.q("SELECT count(*), min(kind), max(kind), min(rank) FROM source WHERE id LIKE '%:src:%-tg.%'"),
                         [(8, "telegram_msg", "telegram_msg", "original")])
        self.assertIn("media_kind=medicine", self.q(f"SELECT note FROM source WHERE id = 'alice:src:2026-10-05-tg.{U}003'")[0][0])

    def test_readings_become_observations(self):
        rows = self.q("""SELECT id, json_extract(data,'$.code'), json_extract(data,'$.value_num'), at, verification, status
                         FROM fact WHERE id LIKE '%-tg.%' AND kind = 'observation'
                           AND json_extract(data,'$.code') != 'ref:code:symptom' ORDER BY id""")
        self.assertEqual(rows, [
            (f"alice:fact:2026-10-01-tg.{U}104", "ref:code:spo2", 96, "2026-10-01T01:30+05:30", "unverified", "active"),
            (f"alice:fact:2026-10-03-tg.{U}101", "ref:code:bp", 132, "2026-10-03T08:00+05:30", "patient", "active"),
            (f"alice:fact:2026-10-03-tg.{U}101.pulse", "ref:code:pulse", 72, "2026-10-03T08:00+05:30", "patient", "active"),
            (f"alice:fact:2026-10-07-tg.{U}103", "ref:code:weight", 46, "2026-10-07T07:30+05:30", "unverified", "retracted"),
            (f"bob:fact:2026-10-06-tg.{U}102", "ref:code:glucose-fasting", 118, "2026-10-06T07:15+05:30", "patient", "active"),
            ("carol:fact:2026-10-10-tg.-1001234567890.456.r0", "ref:code:weight", 72.5, "2026-10-10T00:10+05:30", "unverified", "active"),
        ])
        self.assertEqual(self.q(f"SELECT source_id FROM fact WHERE id = 'bob:fact:2026-10-06-tg.{U}102'"),
                         [(f"bob:src:2026-10-06-tg.{U}004",)])

    def test_d1_person_and_bot_metadata(self):
        self.assertEqual(self.q("SELECT ns, recorded_by, tags FROM fact WHERE id = 'carol:fact:2026-10-10-tg.-1001234567890.456.r0'"),
                         [("carol", "batch/vitals-parser", '["low-confidence"]')])

    def test_symptoms_become_observations_and_falls_events(self):
        obs = self.q(f"""SELECT json_extract(data,'$.value_text'), at, json_extract(data,'$.components.triggers[0]'),
                                json_extract(data,'$.components.duration_min'), quote
                         FROM fact WHERE id = 'alice:fact:2026-10-03-tg.{U}201'""")
        self.assertEqual(obs, [("chest_pain", "2026-10-03T21:30+05:30", "walking", 10, "chalte hue seene mein dard hua, das minute tak")])
        self.assertEqual(self.q("SELECT json_extract(data,'$.type'), at FROM fact WHERE kind = 'event' AND id LIKE '%-tg.%'"),
                         [("fall", "2026-10-08T19:30+05:30")])

    def test_retracted_is_out_of_trends(self):
        self.assertEqual(self.q(f"SELECT count(*) FROM v_trend WHERE id = 'alice:fact:2026-10-07-tg.{U}103'"), [(0,)])

    def test_views_on_example_records(self):
        self.assertEqual(self.q(f"SELECT value_num, flag, page FROM v_trend WHERE source_id = '{SRC}' AND code = 'ref:code:potassium'"),
                         [(5.7, "H", 2)])
        self.assertEqual(self.q("SELECT id FROM v_latest WHERE ns = 'alice' AND code = 'ref:code:potassium'"),
                         self.q("SELECT id FROM v_trend WHERE ns = 'alice' AND code = 'ref:code:potassium' "
                                "ORDER BY at DESC, CASE rank WHEN 'original' THEN 0 ELSE 1 END LIMIT 1"))
        meds = dict(self.q("SELECT drug, med_status FROM v_meds_current WHERE ns = 'alice'"))
        self.assertEqual(meds.get("ref:drug:examplezole"), "dispensed")
        kinds = {k for (k,) in self.q("SELECT DISTINCT kind FROM v_timeline WHERE ns = 'alice'")}
        self.assertEqual(kinds, {"event", "medication", "observation"})
        self.assertEqual(self.q("SELECT count(*) FROM v_needs_human WHERE uncertain_ref = 'G-01'"), [(2,)])

    def test_conflicts_cross_source_only(self):
        self.assertEqual(self.q("SELECT count(*) FROM v_conflicts WHERE source_a = source_b"), [(0,)])
        tagged = {i for (i,) in self.q("SELECT id FROM v_internal_contradictions")}
        self.assertTrue(tagged)
        both = self.q("SELECT id_a, id_b FROM v_conflicts")
        self.assertFalse(tagged & {i for pair in both for i in pair})

    def test_ref_alias(self):
        # a superseded (merged) ref resolves to the ref that supersedes it; trends use the resolved code
        for old, new in self.q("SELECT id, supersedes FROM ref WHERE supersedes IS NOT NULL"):
            self.assertEqual(self.q(f"SELECT current_id FROM v_ref_current WHERE id = '{new}'"), [(old,)])
        self.assertEqual(self.q("SELECT count(*) FROM v_trend t JOIN ref r ON r.id = t.code WHERE r.status = 'superseded'"),
                         [(0,)])


class ValidationTest(unittest.TestCase):
    """Each case: copy data/, apply a change, build; expect failure with a message fragment."""

    def run_case(self, mutate):
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copytree(RECORDS, tmp, dirs_exist_ok=True, ignore=shutil.ignore_patterns("kb.sqlite", "kb.tmp", "telegram"))
            d = pathlib.Path(tmp) / "data"
            (d / "telegram").mkdir()
            mutate(d)
            return build("--data", str(d), "--db", str(pathlib.Path(tmp) / "kb.sqlite"))

    def append(self, d, *rows, path=DOC):
        with open(d / path, "a") as f:
            for r in rows:
                f.write(json.dumps(r) + "\n")

    def expect_fail(self, fragment, *rows, path=DOC):
        out = self.run_case(lambda d: self.append(d, *rows, path=path))
        self.assertEqual(out.returncode, 1, out.stdout)
        self.assertIn(fragment, out.stdout)

    def test_copy_builds(self):
        out = self.run_case(lambda d: None)
        self.assertEqual(out.returncode, 0, out.stdout)

    def test_bad_id(self):
        self.expect_fail("bad id", fact("x", id="alice:fact:2026-03-12_Bad.p2"))
        self.expect_fail("bad id", fact("x", id="obs:2026-03-12:p2:potassium"))
        self.expect_fail("bad id", fact("x", id="aunt:fact:2026-03-12-x", ns="alice"))

    def test_wrong_class(self):
        self.expect_fail("but row is fact", fact("x", id="alice:src:2026-03-12-x"))

    def test_ns_mismatch(self):
        self.expect_fail("but file is under data/alice/", fact("2026-03-12-x", ns="bob"))
        self.expect_fail("id ns 'alice' but field ns 'bob'", fact("2026-03-12-x", ns="alice") | {"ns": "bob"})

    def test_schema_violation(self):
        self.expect_fail("not in", fact("2026-03-12-x", data={"code": "ref:code:potassium", "category": "blood", "value_num": 4}))
        self.expect_fail("matches none of anyOf", fact("2026-03-12-x", data={"code": "ref:code:potassium", "category": "lab"}))
        self.expect_fail("unknown key 'confidence'", fact("2026-03-12-x", data={"code": "ref:code:potassium", "category": "lab",
                                                                               "value_num": 4, "confidence": 0.9}))
        self.expect_fail("missing required", fact("2026-03-12-x", recorded_by=None))
        self.expect_fail("does not match at_precision", fact("2026-03-12-x", at="2026-03-12"))
        self.expect_fail("not ISO-8601", fact("2026-03-12-x", at="2026-03-12T11:26Z"))

    def test_dangling_refs(self):
        self.expect_fail("does not resolve to a source", fact("2026-03-12-x", source_id="alice:src:2026-01-01-nowhere"))
        self.expect_fail("does not resolve to a fact", fact("2026-03-12-x", context_id="alice:fact:2026-01-01-no-visit"))
        self.expect_fail("does not resolve to a ref:code", fact("2026-03-12-x", data={"code": "ref:code:nonsense",
                                                                                      "category": "lab", "value_num": 4}))
        self.expect_fail("does not resolve to a ref:drug", fact("2026-03-12-x", kind="medication",
                                                                data={"status": "taking", "drug_id": "ref:drug:nonsense"}))
        self.expect_fail("does not resolve to a fact", fact("2026-03-12-x", supersedes="alice:fact:2026-01-01-gone"))

    def test_external_source(self):
        src = {"rt": "source", "id": "alice:src:2026-03-13-x", "ns": "alice", "kind": "chat", "path": "outside/git.txt",
               "rank": "recollection", "recorded_by": "test", "created_at": "2026-10-26", "status": "active", "tags": []}
        path = "alice/docs/2026-03-13-x.ndjson"
        out = self.run_case(lambda d: self.append(d, src, path=path))
        self.assertEqual(out.returncode, 0, out.stdout)
        self.assertIn("path outside/git.txt not found", out.stdout)  # a warning only
        out = self.run_case(lambda d: self.append(d, src | {"external": True, "note": "kept on the Mac"}, path=path))
        self.assertEqual(out.returncode, 0, out.stdout)
        self.assertNotIn("outside/git.txt", out.stdout)
        self.expect_fail("external = true needs a note", src | {"external": True}, path=path)

    def test_duplicate_id(self):
        self.expect_fail("duplicate id", fact("2026-03-12-example-lab-lft-rft.potassium"))

    def test_superseded_chain(self):
        a = fact("2026-03-12-k", status="superseded", data={"code": "ref:code:potassium", "category": "lab", "value_num": 5.0})
        b = fact("2026-03-12-k.2", status="superseded", supersedes=a["id"],
                 data={"code": "ref:code:potassium", "category": "lab", "value_num": 5.1})
        c = fact("2026-03-12-k.3", supersedes=b["id"], data={"code": "ref:code:potassium", "category": "lab", "value_num": 5.2})
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copytree(RECORDS, tmp, dirs_exist_ok=True, ignore=shutil.ignore_patterns("kb.sqlite", "kb.tmp", "telegram"))
            d = pathlib.Path(tmp) / "data"
            (d / "telegram").mkdir()
            self.append(d, a, b, c)
            db = pathlib.Path(tmp) / "kb.sqlite"
            out = build("--data", str(d), "--db", str(db))
            self.assertEqual(out.returncode, 0, out.stdout)
            con = sqlite3.connect(db)
            ids = [i for (i,) in con.execute("SELECT id FROM v_trend WHERE id LIKE 'alice:fact:2026-03-12-k%'")]
            con.close()
            self.assertEqual(ids, [c["id"]])
        # an active row that has been superseded is an error
        self.expect_fail("must have status 'superseded'", a | {"status": "active"}, b, c)


class RecordsYamlTest(unittest.TestCase):
    def test_missing_records_yaml(self):
        with tempfile.TemporaryDirectory() as tmp:
            (pathlib.Path(tmp) / "data").mkdir()
            out = build("--records", tmp, "--check")
            self.assertEqual(out.returncode, 2)
            self.assertIn("records.yaml: not found", out.stderr)

    def test_schema_version_checked(self):
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copytree(RECORDS, tmp, dirs_exist_ok=True, ignore=shutil.ignore_patterns("kb.sqlite"))
            y = pathlib.Path(tmp) / "records.yaml"
            y.write_text(y.read_text().replace("schema_version: 7", "schema_version: 6"))
            out = build("--records", tmp, "--check")
            self.assertEqual(out.returncode, 2)
            self.assertIn("schema_version 6 not supported", out.stderr)

    def test_namespaces_come_from_records(self):
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copytree(RECORDS, tmp, dirs_exist_ok=True, ignore=shutil.ignore_patterns("kb.sqlite"))
            y = pathlib.Path(tmp) / "records.yaml"
            y.write_text(y.read_text().replace("id: bob", "id: dave"))
            out = build("--records", tmp, "--check")
            self.assertEqual(out.returncode, 1)
            self.assertIn("bad id 'bob:src:", out.stdout)

    def test_env_file_names_records(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = pathlib.Path(tmp) / "env.yaml"
            env.write_text(f"schema: 1\nrecords_dir: {RECORDS}\n")
            out = build("--env", str(env), "--check")
            self.assertEqual(out.returncode, 0, out.stdout + out.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=1)
