#!/usr/bin/env -S python3 -I
"""tools/crossref tests: python3 -I tools/crossref/test_crossref.py
A tiny synthetic KB (schema/schema.sql + made-up rows; no real data) and a scratch records dir. Covers every operator,
dedup and updates, closing, the daily cap, the baseline first run, feedback, the claims register, pages, the digest
section, idempotency and check validation."""
import json, pathlib, shutil, sqlite3, subprocess, sys, tempfile, unittest

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
TOOL = HERE / "crossref"
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


def make_db(path, extra=()):
    con = sqlite3.connect(path)
    con.executescript((ROOT / "schema" / "schema.sql").read_text())
    for p in ("alice", "bob"):
        con.execute("INSERT INTO person (id, name) VALUES (?, 'Test')", (p,))
    refs = [("ref:code:potassium", "code", "Potassium", {}), ("ref:code:ntp", "code", "Example peptide", {}),
            ("ref:code:sodium", "code", "Sodium", {}), ("ref:code:hb", "code", "Haemoglobin", {}),
            ("ref:drug:testol", "drug", "Testol", {"generic": "testolol"}),
            ("ref:drug:otherol", "drug", "Otherol", {"generic": "testolol"}),
            ("ref:drug:stopix", "drug", "Stopix", {"generic": "stopixine"}),
            ("ref:party:dr-test", "party", "Dr Test", {"kind": "practitioner"})]
    for i, k, n, d in refs:
        con.execute("INSERT INTO ref (id, ns, kind, name, data, recorded_by, created_at) VALUES (?, 'ref', ?, ?, ?, ?, ?)",
                    (i, k, n, json.dumps(d), *ENV))
    srcs = [("alice:src:2026-01-01-lab-a", "lab", None), ("alice:src:2026-01-01-lab-b", "lab", None),
            ("alice:src:2026-03-01-lab-c", "lab", None), ("alice:src:2026-02-01-rx", "rx", "ref:party:dr-test"),
            ("alice:src:2026-04-01-rx", "rx", "ref:party:dr-test"), ("alice:src:2026-05-01-chat", "chat", None),
            ("bob:src:2026-01-05-lab", "lab", None)]
    for sid, kind, pr in srcs:
        con.execute("INSERT INTO source (id, ns, kind, path, rank, practitioner_id, recorded_by, created_at) "
                    "VALUES (?, ?, ?, 'x', 'original', ?, ?, ?)", (sid, sid.split(":")[0], kind, pr, *ENV))
    obs = lambda code, v, **k: dict({"code": code, "category": "lab", "value_num": v, "unit": "mmol/L"}, **k)
    facts = [
        # printed H; computed agrees
        ("alice", "2026-01-01-lab-a.potassium", "observation", "2026-01-01", "2026-01-01-lab-a",
         obs("ref:code:potassium", 5.6, ref_low=3.5, ref_high=5.1, flag="H", flag_basis="printed", ref_text="3.5-5.1"), None, []),
        # banded printed range, no printed flag, computed H -> data-quality banded
        ("alice", "2026-01-01-lab-a.ntp", "observation", "2026-01-01", "2026-01-01-lab-a",
         obs("ref:code:ntp", 700, unit="pg/mL", ref_high=125, ref_text="< 75 Years: < 125; > 75 Years: < 450"), None, []),
        # printed N but outside printed limits -> data-quality mismatch
        ("alice", "2026-01-01-lab-a.sodium", "observation", "2026-01-01", "2026-01-01-lab-a",
         obs("ref:code:sodium", 150, ref_low=135, ref_high=145, flag="N", flag_basis="printed"), None, []),
        # uncertain read: never flagged alone
        ("alice", "2026-01-01-lab-b.hb", "observation", "2026-01-01", "2026-01-01-lab-b",
         obs("ref:code:hb", 7, unit="g/dL", ref_low=12, flag="L", flag_basis="printed"), "Z-01", []),
        # second potassium a later day, method stated (the first does not say): delta pair
        ("alice", "2026-03-01-lab-c.potassium", "observation", "2026-03-01", "2026-03-01-lab-c",
         obs("ref:code:potassium", 4.6, method="ISE"), None, []),
        # same-day sodium in another source -> v_conflicts
        ("alice", "2026-01-01-lab-b.sodium", "observation", "2026-01-01", "2026-01-01-lab-b",
         obs("ref:code:sodium", 149), None, []),
        # internal contradiction
        ("alice", "2026-03-01-lab-c.sodium", "observation", "2026-03-01", "2026-03-01-lab-c",
         obs("ref:code:sodium", 140), None, ["internal-contradiction"]),
        # medicines: stopped then taking with no prescription between; two current lines with one generic
        ("alice", "2026-02-01-rx.stopix", "medication", "2026-02-01", "2026-02-01-rx",
         {"status": "stopped", "brand": "Stopix", "drug_id": "ref:drug:stopix"}, None, []),
        ("alice", "2026-05-01-chat.stopix", "medication", "2026-05-01", "2026-05-01-chat",
         {"status": "taking", "brand": "Stopix", "drug_id": "ref:drug:stopix"}, None, ["family-reported"]),
        ("alice", "2026-02-01-rx.testol", "medication", "2026-02-01", "2026-02-01-rx",
         {"status": "prescribed", "brand": "Testol", "drug_id": "ref:drug:testol"}, None, []),
        ("alice", "2026-04-01-rx.otherol", "medication", "2026-04-01", "2026-04-01-rx",
         {"status": "taking", "brand": "Otherol", "drug_id": "ref:drug:otherol"}, None, []),
        # claims: same key in a later source, query -> confirmed (differs); a restated one; a family-reported event
        ("alice", "2026-02-01-rx.example-condition", "condition", "2026-02-01", "2026-02-01-rx",
         {"text_as_written": "?Example condition", "status_as_documented": "query"}, None, []),
        ("alice", "2026-04-01-rx.example-condition", "condition", "2026-04-01", "2026-04-01-rx",
         {"text_as_written": "Example condition", "status_as_documented": "confirmed"}, None, []),
        ("alice", "2026-02-01-rx.old-history", "condition", "2026-02-01", "2026-02-01-rx",
         {"text_as_written": "H/o example", "status_as_documented": "history"}, None, []),
        ("alice", "2026-04-01-rx.old-history", "condition", "2026-04-01", "2026-04-01-rx",
         {"text_as_written": "Old example", "status_as_documented": "confirmed"}, None, []),
        ("alice", "2026-05-01-chat.felt-tired", "event", "2026-05-01", "2026-05-01-chat",
         {"type": "other", "label": "Felt tired (family report)"}, None, ["family-reported"]),
        ("bob", "2026-01-05-lab.hb", "observation", "2026-01-05", "2026-01-05-lab",
         obs("ref:code:hb", 11, unit="g/dL", ref_low=13, ref_high=17, flag="L", flag_basis="printed"), None, []),
    ] + list(extra)
    for ns, local, kind, at, src, data, unc, tags in facts:
        con.execute("INSERT INTO fact (id, ns, kind, at, at_precision, data, source_id, page, verification, uncertain_ref, "
                    "status, recorded_by, created_at, tags) VALUES (?, ?, ?, ?, 'day', ?, ?, 1, 'agent', ?, 'active', ?, ?, ?)",
                    (f"{ns}:fact:{local}", ns, kind, at, json.dumps(data), f"{ns}:src:{src}", unc, *ENV, json.dumps(tags)))
    con.commit()
    con.close()


def xr(*args):
    return subprocess.run([sys.executable, "-I", str(TOOL), *map(str, args)], capture_output=True, text=True)


def rows(path):
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()] if path.exists() else []


class CrossrefTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = pathlib.Path(self.tmp.name)
        self.rec, self.db = t / "rec", t / "kb.sqlite"
        (self.rec / "docs" / "health" / "alice").mkdir(parents=True)
        (self.rec / "docs" / "health" / "bob").mkdir(parents=True)
        (self.rec / "records.yaml").write_text(RECORDS_YAML)
        make_db(self.db)

    def tearDown(self):
        self.tmp.cleanup()

    def run_xr(self, day, *extra, ok=True):
        r = xr("--records", self.rec, "--db", self.db, "--today", day, *extra)
        if ok:
            self.assertEqual(r.returncode, 0, r.stderr)
        return r

    def flags(self, ns="alice"):
        return {f["id"]: f for f in rows(self.rec / "crossref" / ns / "flags.ndjson")}

    def by_variant(self, ns="alice"):
        out = {}
        for f in rows(self.rec / "crossref" / ns / "flags.ndjson"):
            out.setdefault(f["subject_key"].split("|")[3], []).append(f)
        return out

    def test_operators(self):
        self.run_xr("2026-06-01")
        v = self.by_variant()
        self.assertEqual(len(v["outside"]), 1)  # the uncertain Hb is skipped
        self.assertIn("is marked H on its report (range as printed: 3.5-5.1)", v["outside"][0]["statement"])
        self.assertEqual(v["outside"][0]["severity"], "routine")
        self.assertIn("printed range is banded", v["banded"][0]["statement"])
        self.assertEqual(v["banded"][0]["severity"], "data-quality")
        self.assertIn("printed flag (N) differs", v["mismatch"][0]["statement"])
        delta = {f["inputs"][0].split(".")[-1]: f for f in v["delta"]}
        self.assertIn("changed by -1 mmol/L, -18%", delta["potassium"]["statement"])  # method unstated vs ISE: comparable
        self.assertEqual(delta["potassium"]["severity"], "routine")
        self.assertIn("stopped (alice:src:2026-02-01-rx", v["order"][0]["statement"])
        self.assertIn("share the generic testolol", v["generic"][0]["statement"])
        self.assertEqual(v["generic"][0]["severity"], "next-visit")
        self.assertEqual(len(v["conflict"]), 1)
        self.assertEqual(len(v["internal"]), 1)
        self.assertTrue(any("reason: uncertain" in f["statement"] for f in v["needs-human"]))
        self.assertIn("Question for Dr Test", v["claim"][0]["statement"])
        self.assertNotIn("stale", v)  # disabled by default
        self.assertEqual(len(self.by_variant("bob")["outside"]), 1)
        for f in sum(v.values(), []):
            self.assertRegex(f["id"], r"^alice:flag:2026-06-01-[a-z0-9-]+-[0-9a-f]{8}$")

    def test_claims(self):
        self.run_xr("2026-06-01")
        c = {r["fact"].split(":")[-1]: r for r in rows(self.rec / "crossref" / "alice" / "claims.ndjson")}
        self.assertEqual(c["2026-02-01-rx.example-condition"]["state"], "differs-in-later-source")
        self.assertEqual(c["2026-02-01-rx.old-history"]["state"], "restated")  # history ~ confirmed
        self.assertEqual(c["2026-04-01-rx.example-condition"]["state"], "as-recorded")
        self.assertEqual(c["2026-02-01-rx.example-condition"]["asserted_by"], "doctor-written")
        self.assertEqual(c["2026-05-01-chat.felt-tired"]["asserted_by"], "family-reported")
        self.assertTrue(any(l["relation"] == "same-source" for l in c["2026-02-01-rx.example-condition"]["links"]))
        page = (self.rec / "docs" / "health" / "alice" / "claims.md").read_text()
        self.assertIn("Facts as written; not advice; doctors decide.", page)
        for word in ("supported", "contradicted", "wrong", "confirmed by"):
            self.assertNotIn(word, page.split("| claim |")[0].lower())

    def test_first_run_baseline_then_new_capped(self):
        dg = pathlib.Path(self.tmp.name) / "digest.txt"
        dg.write_text("Saturn digest\n")
        self.run_xr("2026-06-01", "--digest", dg)
        self.assertIn("First run:", dg.read_text())
        self.assertTrue(all(f["digest_day"] == "baseline" for f in self.flags().values()))
        # four new next-visit flags arrive: cap 3 lists three, one waits for tomorrow
        extra = [("alice", f"2026-05-01-chat.dup{i}", "medication", "2026-05-01", "2026-05-01-chat",
                  {"status": "taking", "brand": f"Dup{i}", "drug_id": d}, None, [])
                 for i, d in enumerate(("ref:drug:testol",))]
        self.db.unlink()
        cond = [("alice", f"2026-0{m}-01-rx.cond-{k}", "condition", f"2026-0{m}-01", f"2026-0{m}-01-rx",
                 {"text_as_written": f"C{k}", "status_as_documented": s}, None, [])
                for k in "abcd" for m, s in ((2, "query"), (4, "resolved"))]
        make_db(self.db, extra + cond)
        dg.write_text("Saturn digest\n")
        self.run_xr("2026-06-02", "--digest", dg)
        text = dg.read_text()
        self.assertIn("Cross-check flags, new", text)
        self.assertEqual(text.count("• Question for") + text.count("current lines share"), 3)
        self.assertIn("more waiting (cap 3 a day)", text)
        listed = [f for f in self.flags().values() if f["digest_day"] == "2026-06-02"]
        self.assertEqual(len(listed), 3)
        # same day again: the same three, nothing new picked
        dg.write_text("")
        self.run_xr("2026-06-02", "--digest", dg)
        self.assertEqual(len([f for f in self.flags().values() if f["digest_day"] == "2026-06-02"]), 3)
        # next day: the waiting ones
        self.run_xr("2026-06-03")  # no digest file (delayed run): nothing is picked
        self.assertFalse(any(f["digest_day"] == "2026-06-03" for f in self.flags().values()))
        self.run_xr("2026-06-03", "--digest", dg)
        self.assertTrue(any(f["digest_day"] == "2026-06-03" for f in self.flags().values()))

    def test_digest_needs_existing_file(self):
        dg = pathlib.Path(self.tmp.name) / "none.txt"
        self.run_xr("2026-06-01", "--digest", dg)
        self.assertFalse(dg.exists())  # a delayed batch run has no digest file: nothing is created

    def test_idempotent_and_close_and_update(self):
        self.run_xr("2026-06-01")
        files = sorted(p for p in self.rec.rglob("*") if p.is_file())
        before = {p: p.read_text() for p in files}
        self.run_xr("2026-06-05")
        self.assertEqual(before, {p: p.read_text() for p in files})  # nothing changed: no diff on a later day
        # a third potassium: the delta flag updates in place (same id, new inputs, re-notified); the old fact closes nothing
        self.db.unlink()
        make_db(self.db, [("alice", "2026-05-01-chat.potassium", "observation", "2026-05-01", "2026-05-01-chat",
                           {"code": "ref:code:potassium", "value_num": 5.0, "unit": "mmol/L"}, None, [])])
        old = {f["id"]: f for f in self.by_variant()["delta"]}
        self.run_xr("2026-06-06")
        new = {f["id"]: f for f in self.by_variant()["delta"]}
        pid = next(i for i, f in old.items() if "potassium" in f["subject_key"])
        self.assertEqual(new[pid]["changed_at"], "2026-06-06")
        self.assertIn("2026-05-01-chat.potassium", " ".join(new[pid]["inputs"]))
        # the conflict disappears from the KB -> its flag closes
        self.db.unlink()
        make_db(self.db)
        c = sqlite3.connect(self.db)
        c.execute("UPDATE fact SET status = 'retracted' WHERE id = 'alice:fact:2026-01-01-lab-b.sodium'")
        c.commit()
        c.close()
        self.run_xr("2026-06-07")
        conflict = self.by_variant()["conflict"][0]
        self.assertEqual((conflict["state"], conflict["closed_at"]), ("closed", "2026-06-07"))
        runs = rows(self.rec / "crossref" / "runs.ndjson")
        self.assertTrue(all(set(r) >= {"run", "facts", "new", "closed", "open"} for r in runs))
        self.assertFalse(any("statement" in json.dumps(r) for r in runs))  # ids and counts only

    def test_feedback(self):
        self.run_xr("2026-06-01")
        f = self.by_variant()["generic"][0]
        claim = rows(self.rec / "crossref" / "alice" / "claims.ndjson")[0]["id"]
        fb = lambda *a: xr("--records", self.rec, "feedback", *a)
        self.assertNotEqual(fb(f["id"], "promote").returncode, 0)  # promote needs a question id
        self.assertNotEqual(fb("alice:flag:nope", "noise").returncode, 0)  # unknown id
        self.assertNotEqual(fb(claim, "noise").returncode, 0)  # flag action on a claim
        self.assertEqual(fb(f["id"], "promote", "--question", "alice:q:0007", "--at", "2026-06-02T10:00+05:30").returncode, 0)
        self.assertEqual(fb(claim, "question", "--question", "alice:q:0008", "--at", "2026-06-02T10:00+05:30").returncode, 0)
        self.run_xr("2026-06-02")
        page = (self.rec / "docs" / "health" / "alice" / "flags.md").read_text()
        self.assertIn("promoted (alice:q:0007)", page)
        self.assertIn("1 / 0", page)  # promote counts as useful in precision
        c = {r["id"]: r for r in rows(self.rec / "crossref" / "alice" / "claims.ndjson")}
        self.assertEqual(c[claim]["state"], "question-open")
        # snooze hides from the digest until it ends; noise hides for good
        o = self.by_variant()["order"][0]
        fb(o["id"], "snooze", "--days", "5", "--at", "2026-06-02T09:00+05:30")
        self.run_xr("2026-06-03")
        self.assertIn("| snoozed |", (self.rec / "docs" / "health" / "alice" / "flags.md").read_text().split("## Summary")[1][:400])

    def test_check_validation(self):
        self.run_xr("2026-06-01")
        p = self.rec / "crossref" / "checks.ndjson"
        good = p.read_text()
        delta = json.loads(next(l for l in good.splitlines() if "delta-vs-prior" in l))
        bad = dict(delta, version="1.1.0", params={"thresholds": {"potassium": {"abs": 0.5}}})
        p.write_text(good + json.dumps(bad) + "\n")
        r = self.run_xr("2026-06-02", ok=False)
        self.assertIn("cited basis", r.stderr)
        p.write_text(good + json.dumps(dict(delta, version="1.0.0")) + "\n")
        self.assertIn("does not increase", self.run_xr("2026-06-02", ok=False).stderr)
        # a cited threshold turns a big change into a next-visit flag with the basis stated
        cited = dict(delta, version="1.1.0", params={"thresholds": {"potassium": {"abs": 0.5, "basis": "Example 2020, table 1"}}})
        p.write_text(good + json.dumps(cited) + "\n")
        self.run_xr("2026-06-02")
        k = next(f for f in self.by_variant()["delta"] if "potassium" in f["subject_key"])
        self.assertEqual(k["severity"], "next-visit")
        self.assertIn("(Example 2020, table 1)", k["statement"])
        # stale: active needs max_days
        stale = json.loads(next(l for l in good.splitlines() if "ref:check:stale" in l))
        p.write_text(good + json.dumps(dict(stale, version="1.1.0", status="active")) + "\n")
        self.assertIn("max_days", self.run_xr("2026-06-02", ok=False).stderr)
        p.write_text(good + json.dumps(dict(stale, version="1.1.0", status="active",
                                            params={"max_days": 60, "codes": ["potassium"]})) + "\n")
        self.run_xr("2026-06-02")
        self.assertIn("Latest Potassium on file: 01-Mar-2026", self.by_variant()["stale"][0]["statement"])

    def test_dry_run_writes_nothing(self):
        r = self.run_xr("2026-06-01", "--dry-run", "--print-digest")
        self.assertIn("First run:", r.stdout)
        self.assertFalse((self.rec / "crossref").exists())
        self.assertFalse((self.rec / "docs" / "health" / "alice" / "flags.md").exists())


# ------------------------------------------------------------------------------------------------- health profile
def add_home(db, readings):
    """readings: (local, at, precision, code, values, source_kind, quote, tags). bp values = (sys, dia)."""
    con = sqlite3.connect(db)
    for code, name in (("bp", "Blood pressure"), ("pulse", "Pulse"), ("weight", "Weight")):
        con.execute("INSERT OR IGNORE INTO ref (id, ns, kind, name, data, recorded_by, created_at) "
                    "VALUES (?, 'ref', 'code', ?, '{}', ?, ?)", (f"ref:code:{code}", name, *ENV))
    for local, at, prec, code, v, kind, quote, tags in readings:
        sid = f"alice:src:{local.split('.')[0]}"
        con.execute("INSERT OR IGNORE INTO source (id, ns, kind, path, rank, recorded_by, created_at) "
                    "VALUES (?, 'alice', ?, 'x', 'original', ?, ?)", (sid, kind, *ENV))
        data = {"code": f"ref:code:{code}", "category": "vital"}
        if code == "bp":
            data.update(value_num=v[0], unit="mm[Hg]", components={"systolic": v[0], "diastolic": v[1]})
        else:
            data.update(value_num=v, unit="kg" if code == "weight" else "/min")
        con.execute("INSERT INTO fact (id, ns, kind, at, at_precision, data, source_id, verification, status, recorded_by, "
                    "created_at, tags, quote) VALUES (?, 'alice', 'observation', ?, ?, ?, ?, 'agent', 'active', ?, ?, ?, ?)",
                    (f"alice:fact:{local}", at, prec, json.dumps(data), sid, *ENV, json.dumps(tags), quote))
    con.commit()
    con.close()


def daily_bp(start, n, sys_=120, dia=70, hhmm="10:30", wobble=(0, 2, -1, 1, -2)):
    import datetime as dt
    d0 = dt.date.fromisoformat(start)
    out = []
    for i in range(n):
        d = (d0 + dt.timedelta(days=i)).isoformat()
        w = wobble[i % len(wobble)]
        out += [(f"{d}-tg.{i}.bp", f"{d}T{hhmm}:00+05:30", "minute", "bp", (sys_ + w, dia), "telegram_msg", None, []),
                (f"{d}-tg.{i}.pulse", f"{d}T{hhmm}:00+05:30", "minute", "pulse", 70 + w, "telegram_msg", None, [])]
    return out


class ProfileTest(unittest.TestCase):
    """Synthetic home series: steady, single outlier, sustained shift, gap restart, duplicates, warming-up,
    mixed-session, medicine timing, the weekly digest line."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = pathlib.Path(self.tmp.name)
        self.rec, self.db = t / "rec", t / "kb.sqlite"
        (self.rec / "docs" / "health" / "alice").mkdir(parents=True)
        (self.rec / "docs" / "health" / "bob").mkdir(parents=True)
        (self.rec / "records.yaml").write_text(RECORDS_YAML)
        make_db(self.db)

    def tearDown(self):
        self.tmp.cleanup()

    def run_xr(self, day, *extra):
        r = xr("--records", self.rec, "--db", self.db, "--today", day, *extra)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r

    def shifts(self):
        return [f for f in rows(self.rec / "crossref" / "alice" / "flags.ndjson") if "baseline-shift" in f["check"]
                and f["state"] == "open"]

    def page(self):
        return (self.rec / "docs" / "health" / "alice" / "profile.md").read_text()

    def test_steady_no_flag_band_shown(self):
        add_home(self.db, daily_bp("2026-05-01", 20))
        self.run_xr("2026-05-20")
        self.assertEqual(self.shifts(), [])
        page = self.page()
        self.assertIn("Facts as written; not advice; doctors decide.", page)
        self.assertRegex(page, r"\| sbp \| `[·▁-█]{28}` \| 7 / 7 \|")
        self.assertIn("(last 3 days)", page)
        self.assertFalse((self.rec / "docs" / "health" / "bob" / "profile.md").exists())  # no home readings

    def test_single_outlier_no_flag(self):
        add_home(self.db, daily_bp("2026-05-01", 19) + daily_bp("2026-05-20", 1, sys_=160))
        self.run_xr("2026-05-20")
        self.assertEqual(self.shifts(), [])
        self.assertIn("1 above, 2 within (last 3 days)", self.page())

    def test_sustained_shift_flags_routine_with_stats(self):
        add_home(self.db, daily_bp("2026-05-01", 18) + daily_bp("2026-05-19", 2, sys_=150, wobble=(0,)))
        self.run_xr("2026-05-20")
        f = [x for x in self.shifts() if x["check"].endswith("sbp-home")]
        self.assertEqual(len(f), 1)
        f = f[0]
        self.assertEqual(f["severity"], "routine")
        self.assertTrue(f["subject_key"].endswith("|sbp|above"))
        self.assertRegex(f["statement"], r"^Home systolic BP: daily values 1\d\d, 150, 150 \(18-May-2026 to 20-May-2026\) "
                                         r"are above this person's usual band [\d.]+-[\d.]+ mmHg \(median 120 of 17 days, "
                                         r"01-May-2026 to 17-May-2026, morning\)\.$")
        self.assertEqual(set(f["stats"]) >= {"median", "mad", "spread", "lo", "hi", "n", "window", "session"}, True)
        self.assertEqual(f["stats"]["n"], 17)
        self.assertIn(f["id"], self.page())
        # a persisting shift updates the same flag, never a second one
        add_home(self.db, [x for x in daily_bp("2026-05-21", 1, sys_=150, wobble=(0,))])
        self.run_xr("2026-05-21")
        g = [x for x in self.shifts() if x["check"].endswith("sbp-home")]
        self.assertEqual([x["id"] for x in g], [f["id"]])

    def test_device_average_memory_and_partial_screens_stay_out_of_series(self):
        # The same high days as the sustained-shift case, but read from device average / memory / unclear-indicator /
        # partly legible screens: not one home measurement each, so no daily value, no baseline input and no flag.
        high = [r for r in daily_bp("2026-05-18", 3, sys_=150, wobble=(0,)) if r[3] == "bp"]
        tags = (["device-average"], ["device-memory"], ["partial-reading", "uncertain", "needs-human"])
        unknown = ("2026-05-18-tg.u.bp", "2026-05-18T11:00:00+05:30", "minute", "bp", (155, 90), "telegram_msg", None,
                   ["device-type-unknown", "needs-human"])
        add_home(self.db, daily_bp("2026-05-01", 17) + [(*r[:7], t) for r, t in zip(high, tags)] + [unknown])
        self.run_xr("2026-05-20")
        self.assertEqual(self.shifts(), [])
        sys.path.insert(0, str(HERE))
        import home_series as hs
        con = sqlite3.connect(self.db)
        con.row_factory = sqlite3.Row
        kb = type("KB", (), {"q": staticmethod(lambda sql, *a: con.execute(sql, a).fetchall())})
        unused = sorted(r["id"] for r in hs.home_readings(kb, hs.config({}), "alice") if not r["used"])
        con.close()
        self.assertEqual(unused, ["alice:fact:2026-05-18-tg.0.bp", "alice:fact:2026-05-18-tg.u.bp",
                                  "alice:fact:2026-05-19-tg.1.bp", "alice:fact:2026-05-20-tg.2.bp"])

    def test_gap_restarts_baseline(self):
        add_home(self.db, daily_bp("2026-03-01", 15) + daily_bp("2026-05-19", 2, sys_=150, wobble=(0,)))
        self.run_xr("2026-05-20")
        self.assertEqual(self.shifts(), [])
        self.assertIn("warming-up (0/7)", self.page())

    def test_warming_up(self):
        add_home(self.db, daily_bp("2026-05-14", 7))
        self.run_xr("2026-05-20")
        self.assertIn("warming-up (4/7)", self.page())
        self.assertEqual(self.shifts(), [])

    def test_duplicates_collapsed_and_listed(self):
        add_home(self.db, daily_bp("2026-05-18", 3) + [
            # same reading sent twice, 10 min apart (another message)
            ("2026-05-18-tg.x.bp", "2026-05-18T10:40:00+05:30", "minute", "bp", (120, 70), "telegram_msg", None, []),
            # relayed in a chat summary with the next day's date, day precision
            ("2026-05-21-chat.bp", "2026-05-21", "day", "bp", (119, 70), "chat", None, ["family-reported"]),
            # a low-confidence reading is not used
            ("2026-05-19-tg.y.bp", "2026-05-19T11:00:00+05:30", "minute", "bp", (200, 90), "telegram_msg", None,
             ["low-confidence"]),
        ])
        self.run_xr("2026-05-21")
        page = self.page()
        self.assertIn("Duplicates collapsed: 2", page)
        self.assertIn("| same reading sent twice (30 min) | bp | `alice:fact:2026-05-18-tg.0.bp` (18-May-2026) | "
                      "`alice:fact:2026-05-18-tg.x.bp` (18-May-2026) |", page)
        self.assertIn("| probable cross-channel duplicate (day precision, dates 1 day apart at most) | bp | "
                      "`alice:fact:2026-05-20-tg.2.bp` (20-May-2026) | `alice:fact:2026-05-21-chat.bp` (21-May-2026) |", page)
        self.assertIn("Not used (low-confidence", page)
        self.assertIn("`alice:fact:2026-05-19-tg.y.bp`", page)
        self.assertIn("## 7. Linked analyses and inferences\n\nOffline notes and agent-inferred records; any interpretation "
                      "stays in them, labelled as it is there.\n\nNone.", page)
        (self.rec / "docs" / "health" / "alice" / "status.md").write_text("x")
        (self.rec / "docs" / "log" / "analysis").mkdir(parents=True)
        (self.rec / "docs" / "log" / "analysis" / "2026-05-20-alice-note.md").write_text("x")
        self.run_xr("2026-05-21")
        self.assertIn("- [status.md](status.md) (agent-inferred records, `tools/inference`)\n- [docs/log/analysis/"
                      "2026-05-20-alice-note.md](../../../docs/log/analysis/2026-05-20-alice-note.md)", self.page())

    def test_mixed_session_and_med_timing(self):
        add_home(self.db, daily_bp("2026-05-18", 2) + [
            ("2026-05-20-tg.a.bp", "2026-05-20T15:00:00+05:30", "minute", "bp", (130, 80), "telegram_msg",
             "bp 130/80 after morning medicines", []),
            ("2026-05-21-tg.b.bp", "2026-05-21T09:00:00+05:30", "minute", "bp", (118, 70), "telegram_msg",
             "dawai se pehle 118/70", []),
            ("2026-05-21-chat.c.bp", "2026-05-21", "day", "bp", (125, 75), "chat", "bp 125 75", []),
        ])
        self.run_xr("2026-05-21")
        page = self.page()
        self.assertIn("| 20-May-2026 | afternoon | 130/80 |  |  | 1 | after | mixed-session |", page)
        self.assertIn("| 21-May-2026 | morning | 118/70 |  |  | 1 | before |  |", page)  # the untimed one is not morning
        self.assertIn("Mixed-session days: 1 (20-May-2026)", page)
        # preferred session "any" (owner decision D1): every reading of the day, no mixed-session mark
        (self.rec / "data" / "meta").mkdir(parents=True)
        (self.rec / "data" / "meta" / "gen-views.json").write_text(json.dumps({"profile": {"preferred_session": {"alice": "any"}}}))
        self.run_xr("2026-05-21")
        page = self.page()
        self.assertIn("| 21-May-2026 | morning, untimed | 121.5/72.5 |  |  | 2 | before |  |", page)
        self.assertIn("Mixed-session days: 0", page)

    def test_digest_line_weekly_no_values(self):
        add_home(self.db, daily_bp("2026-04-20", 27) + daily_bp("2026-05-17", 2, sys_=150, wobble=(0,)))
        dg = pathlib.Path(self.tmp.name) / "digest.txt"
        dg.write_text("")
        self.run_xr("2026-05-18", "--digest", dg)  # Monday = default roll-up day
        text = dg.read_text()
        self.assertIn("• Alice profile: 2 series, 7/7 days; 1 change flag(s) (sbp); 0 duplicate(s) collapsed; "
                      "0 series warming up; see docs/health/alice/profile.md", text)
        self.assertNotIn("150", text)
        dg.write_text("")
        self.run_xr("2026-05-19", "--digest", dg)  # not the roll-up day: routine change flags are not listed
        self.assertNotIn("profile", dg.read_text())

    def test_check_validation(self):
        self.run_xr("2026-05-20")
        p = self.rec / "crossref" / "checks.ndjson"
        good = p.read_text()
        row = json.loads(next(l for l in good.splitlines() if "baseline-shift-sbp-home" in l))
        p.write_text(good + json.dumps(dict(row, version="1.1.0", params=dict(row["params"], series="bmi"))) + "\n")
        r = xr("--records", self.rec, "--db", self.db, "--today", "2026-05-20")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("baseline_shift needs series", r.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=1)
