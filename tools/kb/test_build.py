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
        self.assertEqual(meds.get("ref:drug:examplezole"), "taking")  # the 10-Jun family list supersedes the 20-May Rx
        snap = self.q("SELECT drug, list_status, display_status FROM v_meds_current WHERE ns = 'alice'")
        self.assertEqual(snap, [("ref:drug:examplezole", "on-list", "taking")])
        self.assertEqual(self.q("SELECT count(*) FROM v_meds_current WHERE ns = 'bob' AND list_status IS NOT NULL"), [(0,)])
        cred = self.q("SELECT json_extract(data, '$.credentials.verification_summary') FROM ref WHERE id = 'ref:party:dr-example'")
        self.assertEqual(cred, [("matched",)])
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


def ctx_fact(local, **kw):
    """A hand-written life-context event (ADR 010) on the example lab source."""
    return fact(local, kind="event", at="2026-03-12", at_precision="day", quote=None, verification="unverified",
                tags=["family-reported"], data={"type": "context", "category": "travel", "summary": "away for a few days",
                                                "confidence": "high", "data_class": "phi"}) | kw


class ContextTest(unittest.TestCase):
    """ADR 010: d1.context rows -> event facts with data.type context; the build's context checks."""

    def test_batch_rows_map_to_context_events(self):
        msg = {"rt": "d1.messages", "id": "-100:7", "person_id": "alice", "sender_person_id": "carol-tg", "kind": "text",
               "chat_id": "-100", "received_at": "2026-10-24T05:00:00.000Z", "raw_text": "synthetic", "extraction_status": "ok",
               "extracted_by": "claude-haiku-5-5", "extracted_at": "2026-10-25T15:30:00.000Z", "context_status": "extracted"}
        rows = [msg, {"rt": "d1.context", "id": "-100:7:c0", "source_message_id": "-100:7", "person_id": "alice",
                      "sender_person_id": "carol-tg", "category": "travel", "summary": "Alice away for a few days",
                      "intensity": None, "confidence": "high", "start": "2026-10-24", "end": "2026-10-27", "mode": "shadow",
                      "extracted_by": "claude-haiku-5-5", "extracted_at": "2026-10-25T15:30:00.000Z"},
                {"rt": "d1.context", "id": "-100:7:c1", "source_message_id": "-100:7", "person_id": "carol-tg",
                 "sender_person_id": "carol-tg", "category": "sleep", "summary": "sleeping poorly", "intensity": "high",
                 "confidence": "low", "start": "2026-10-24", "end": None, "mode": "on",
                 "extracted_by": "claude-haiku-5-5", "extracted_at": "2026-10-25T15:30:00.000Z"}]
        with tempfile.TemporaryDirectory() as tmp:
            tg = pathlib.Path(tmp) / "telegram"
            tg.mkdir()
            (tg / "2026-10.ndjson").write_text("".join(json.dumps(r) + "\n" for r in rows))
            db = pathlib.Path(tmp) / "kb.sqlite"
            out = build("--records", str(RECORDS), "--telegram", str(tg), "--db", str(db))
            self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
            con = sqlite3.connect(db)
            got = con.execute("SELECT id, ns, at, at_precision, data, quote, verification, tags, source_id, locator FROM fact "
                              "WHERE json_extract(data, '$.type') = 'context' ORDER BY id").fetchall()
            self.assertEqual(con.execute("SELECT count(*) FROM v_context").fetchone(), (0,))  # shadow and low-confidence
            self.assertEqual(con.execute("SELECT count(*) FROM v_timeline WHERE what = 'context'").fetchone(), (0,))
            con.close()
        self.assertEqual([(g[0], g[1], g[2], g[3], json.loads(g[4]), g[5], g[6], json.loads(g[7]), g[8], g[9]) for g in got], [
            ("alice:fact:2026-10-24-tg.-100.7.c0", "alice", "2026-10-24", "day",
             {"type": "context", "category": "travel", "summary": "Alice away for a few days", "confidence": "high",
              "end": "2026-10-27", "data_class": "phi"}, None, "unverified", ["family-reported", "shadow"],
             "alice:src:2026-10-24-tg.-100.7", "tg:-100:7"),
            ("carol:fact:2026-10-24-tg.-100.7.c1", "carol", "2026-10-24", "day",
             {"type": "context", "category": "sleep", "summary": "sleeping poorly", "intensity": "high", "confidence": "low",
              "data_class": "phi"}, None, "unverified", ["patient-reported", "low-confidence"],
             "alice:src:2026-10-24-tg.-100.7", "tg:-100:7"),
        ])


class ReportTest(unittest.TestCase):
    """d1.report_items -> observation facts at the sample time; photo/PDF provenance = document; duplicate files."""

    def test_report_items_provenance_and_duplicates(self):
        T = "2026-10-30T15:30:00.000Z"
        base = {"rt": "d1.messages", "person_id": "alice", "sender_person_id": "carol-tg", "chat_id": "-100",
                "received_at": "2026-10-30T05:00:00.000Z", "raw_text": None, "extraction_status": "ok",
                "extracted_by": "claude-sonnet-5-5", "extracted_at": T}
        rep = {"report_type": "lab", "facility": "Example Lab", "doctors": ["Dr Example, MD Pathology"],
               "sample_at": "2026-09-01T08:15:00+05:30", "reported_at": "2026-09-02T18:00:00+05:30", "items": []}
        common = {"source_message_id": "-100:7", "person_id": "alice", "report_type": "lab", "sample_at": "2026-09-01T08:15:00+05:30",
                  "reported_at": "2026-09-02T18:00:00+05:30", "facility": "Example Lab", "doctors": "[\"Dr Example\"]",
                  "confidence": 0.95, "confirmed": 0, "extracted_by": "claude-sonnet-5-5", "extracted_at": T}
        item = lambda i, **kw: {"rt": "d1.report_items", "id": f"-100:7:i{i}", "unit": None, "ref_range": None, "flag": None,
                                "panel": None, "value_num": None, "value_text": None, "section": "result", **common, **kw}
        rows = [
            {**base, "id": "-100:7", "kind": "document", "media_ref": None, "extraction_json": json.dumps({"media_kind": "report", "report": rep})},
            item(0, name="Serum Potassium", value_num=5.6, unit="mEq/L", ref_range="3.5 - 5.1", flag="H", panel="Electrolytes"),
            item(1, name="Synthetic Marker X", value_num=12.5, unit="U/L", ref_range="< 40"),
            item(2, name="Creatinine", value_num=88, unit="umol/L"),  # not the canonical unit: stays unmapped
            item(3, name="impression", section="impression", value_text="Synthetic impression text."),
            {**base, "id": "-100:8", "kind": "image", "media_ref": None, "extraction_json": None},
            {"rt": "d1.readings", "id": "-100:8:r0", "source_message_id": "-100:8", "person_id": "alice", "type": "bp", "value": 128,
             "value2": 82, "value3": None, "unit": "mmHg", "measured_at": "2026-10-30T10:00:00+05:30", "confidence": 0.95,
             "confirmed": 0, "extracted_by": "claude-sonnet-5-5", "extracted_at": T},
            {**base, "id": "-100:9", "kind": "image", "media_ref": None, "extraction_status": "duplicate", "duplicate_of": "-100:8",
             "received_at": "2026-10-30T05:05:00.000Z"},
            {**base, "id": "-100:10", "kind": "text", "raw_text": "synthetic 61 kg", "media_ref": None},
            {"rt": "d1.readings", "id": "-100:10:r0", "source_message_id": "-100:10", "person_id": "alice", "type": "weight",
             "value": 61, "value2": None, "value3": None, "unit": "kg", "measured_at": "2026-10-30T10:00:00+05:30",
             "confidence": 0.95, "confirmed": 0, "extracted_by": "claude-haiku-5-5", "extracted_at": T},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            tg = pathlib.Path(tmp) / "telegram"
            tg.mkdir()
            (tg / "2026-10.ndjson").write_text("".join(json.dumps(r) + "\n" for r in rows))
            db = pathlib.Path(tmp) / "kb.sqlite"
            out = build("--records", str(RECORDS), "--telegram", str(tg), "--db", str(db))
            self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
            con = sqlite3.connect(db)
            q = lambda sql: con.execute(sql).fetchall()
            facts = {r[0]: (r[1], r[2], json.loads(r[3]), json.loads(r[4]), r[5]) for r in q(
                "SELECT id, at, at_precision, data, tags, quote FROM fact WHERE id LIKE 'alice:fact:%-tg.-100.%'")}
            src = dict((r[0], r[1:]) for r in q("SELECT id, rank, duplicate_of, tags, note FROM source WHERE id LIKE 'alice:src:%-tg.-100.%'"))
            refs = q("SELECT id FROM ref WHERE id IN ('ref:code:lab-unmapped', 'ref:code:report-impression', 'ref:code:report-findings') ORDER BY id")
            con.close()
        k = facts["alice:fact:2026-09-01-tg.-100.7.i0"]
        self.assertEqual(k[:2], ("2026-09-01T08:15+05:30", "minute"))  # the sample time, not the report or message time
        self.assertEqual(k[2], {"code": "ref:code:potassium", "category": "lab", "name_raw": "Serum Potassium", "panel": "Electrolytes",
                                "value_num": 5.6, "unit": "mmol/L", "unit_raw": "mEq/L", "ref_text": "3.5 - 5.1", "ref_low": 3.5,
                                "ref_high": 5.1, "flag": "H", "flag_basis": "printed"})
        self.assertEqual(k[3], ["document"])  # sent by another member, but read from a document: not family-reported
        self.assertEqual(k[4], "Serum Potassium: 5.6 mEq/L (ref 3.5 - 5.1)")
        x = facts["alice:fact:2026-09-01-tg.-100.7.i1"][2]
        self.assertEqual((x["code"], x["name_raw"], x.get("ref_high"), x.get("ref_low")), ("ref:code:lab-unmapped", "Synthetic Marker X", 40, None))
        self.assertEqual(facts["alice:fact:2026-09-01-tg.-100.7.i2"][2]["code"], "ref:code:lab-unmapped")
        imp = facts["alice:fact:2026-09-01-tg.-100.7.i3"]
        self.assertEqual((imp[2]["code"], imp[2]["value_text"], imp[3]), ("ref:code:report-impression", "Synthetic impression text.", ["document", "doctor-written"]))
        self.assertEqual(refs, [("ref:code:lab-unmapped",), ("ref:code:report-impression",)])  # built-ins only when used
        self.assertEqual(facts["alice:fact:2026-10-30-tg.-100.8.r0"][3], ["document"])  # BP monitor photo
        self.assertEqual(facts["alice:fact:2026-10-30-tg.-100.10.r0"][3], ["family-reported"])  # typed by another member
        self.assertIn("facility: Example Lab", src["alice:src:2026-10-30-tg.-100.7"][3])
        self.assertIn("sample_at: 2026-09-01T08:15:00+05:30", src["alice:src:2026-10-30-tg.-100.7"][3])
        dup = src["alice:src:2026-10-30-tg.-100.9"]
        self.assertEqual(dup[:3], ("copy", "alice:src:2026-10-30-tg.-100.8", '["duplicate"]'))
        self.assertFalse(any(".-100.9." in f for f in facts))


class ContextValidationTest(unittest.TestCase):
    run_case, append, expect_fail = ValidationTest.run_case, ValidationTest.append, ValidationTest.expect_fail

    def test_context_builds(self):
        out = self.run_case(lambda d: self.append(d, ctx_fact("2026-03-12-ctx")))
        self.assertEqual(out.returncode, 0, out.stdout)

    def test_context_rules(self):
        self.expect_fail("quote must be null", ctx_fact("2026-03-12-ctx", quote="I am travelling"))
        self.expect_fail("verification must be unverified", ctx_fact("2026-03-12-ctx", verification="agent"))
        self.expect_fail("needs tag patient-reported or family-reported", ctx_fact("2026-03-12-ctx", tags=[]))
        self.expect_fail("matches none of anyOf", ctx_fact("2026-03-12-ctx", data={"type": "context", "summary": "x",
                                                                                   "confidence": "high", "data_class": "phi"}))
        self.expect_fail("not in", ctx_fact("2026-03-12-ctx", data={"type": "context", "category": "other", "summary": "x",
                                                                    "confidence": "high", "data_class": "phi"}))
        self.expect_fail("longer than 80", ctx_fact("2026-03-12-ctx", data={"type": "context", "category": "mood",
                                                                             "summary": "x" * 81, "confidence": "high",
                                                                             "data_class": "phi"}))


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
