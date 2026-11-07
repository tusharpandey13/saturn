#!/usr/bin/env -S python3 -I
"""Tests for symptom context cards (cardlib + tools/site/build rendering) on synthetic records only.

Run: python3 -I tools/symptom/test_cards.py      (UPDATE_GOLDEN=1 rewrites golden/*.html)
Fixture: a temp copy of fixtures/records-example plus a synthetic overlay: alice on a blood thinner (generic apixaban,
first recorded 5 days before), a product with no US label, a long-standing medicine with no cache entry, a strength
change, a machine-transcript voice note nobody has heard ("Eyes are burning", "Slight headache today, 2 times"), a
same-day activity, home BP readings and a label cache. Design and test spec: docs/design/symptom-context-card.md.
"""
import datetime, importlib.machinery, importlib.util, json, os, pathlib, re, shutil, sqlite3, subprocess, sys, tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
PRODUCT = HERE.parents[1]
FIXTURE = PRODUCT / "fixtures" / "records-example"
sys.path.insert(0, str(HERE))
import cardlib  # noqa: E402

_l = importlib.machinery.SourceFileLoader("gen_views_t", str(PRODUCT / "tools" / "kb" / "gen-views"))
gv = importlib.util.module_from_spec(importlib.util.spec_from_loader("gen_views_t", _l)); _l.exec_module(gv)

TODAY = "2026-06-20"
CHAT = "-1001234567890"
DRUGS = [
    {"rt": "ref", "id": "ref:drug:exampleaban", "ns": "ref", "kind": "drug", "name": "Exampleaban",
     "data": {"brand": "Exampleaban", "generic": "apixaban", "ingredients": [{"name": "apixaban", "mg": 5}], "certainty": "confirmed",
              "persons": ["alice"]}, "recorded_by": "fixture", "created_at": "2026-06-13", "status": "active", "tags": []},
    {"rt": "ref", "id": "ref:drug:examplevite", "ns": "ref", "kind": "drug", "name": "Examplevite",
     "data": {"brand": "Examplevite", "generic": "examplevitamin", "ingredients": [{"name": "examplevitamin", "mg": None}],
              "certainty": "confirmed", "persons": ["alice"]}, "recorded_by": "fixture", "created_at": "2026-06-13",
     "status": "active", "tags": []},
    {"rt": "ref", "id": "ref:drug:exampleolol", "ns": "ref", "kind": "drug", "name": "Exampleolol",
     "data": {"brand": "Exampleolol", "generic": "exampleolol", "ingredients": [{"name": "exampleolol", "mg": 2.5}],
              "certainty": "confirmed", "persons": ["alice"]}, "recorded_by": "fixture", "created_at": "2026-04-01",
     "status": "active", "tags": []},
]


def src(local, kind, issued):
    return {"rt": "source", "id": f"alice:src:{local}", "ns": "alice", "kind": kind, "path": f"sources/alice/documents/{local}.md",
            "rank": "original", "issued_at": issued, "recorded_by": "fixture", "created_at": issued, "status": "active", "tags": [],
            "org_id": "ref:party:example-clinic"}


def med(local, name, drug, at, strength, status="taking"):
    return {"rt": "fact", "id": f"alice:fact:{local}.{name}", "ns": "alice", "kind": "medication", "at": at, "at_precision": "day",
            "data": {"status": status, "brand": name.capitalize(), "drug_id": drug, "strength": strength},
            "source_id": f"alice:src:{local}", "quote": f"Tab {name} {strength}", "verification": "agent", "status": "active",
            "recorded_by": "fixture", "created_at": at, "tags": []}


DOC_APRIL = [src("2026-04-01-example-clinic-rx", "rx", "2026-04-01"),
             med("2026-04-01-example-clinic-rx", "exampleolol", "ref:drug:exampleolol", "2026-04-01", "2.5 mg"),
             {"rt": "fact", "id": "alice:fact:2026-04-01-example-clinic-rx.dx", "ns": "alice", "kind": "condition",
              "at": "2026-04-01", "at_precision": "day", "data": {"text_as_written": "Dilated cardiomyopathy (EF 30%); CVA (-)"},
              "source_id": "alice:src:2026-04-01-example-clinic-rx", "quote": "DCM", "verification": "agent",
              "status": "active", "recorded_by": "fixture", "created_at": "2026-04-01", "tags": ["doctor-written"]}]
DOC_JUNE = [src("2026-06-13-example-clinic-rx", "rx", "2026-06-13"),
            med("2026-06-13-example-clinic-rx", "exampleaban", "ref:drug:exampleaban", "2026-06-13", "5 mg"),
            med("2026-06-13-example-clinic-rx", "examplevite", "ref:drug:examplevite", "2026-06-13", "1 cap"),
            med("2026-06-13-example-clinic-rx", "exampleolol", "ref:drug:exampleolol", "2026-06-13", "5 mg")]


def msg(n, kind, received, **kw):
    base = {"rt": "d1.messages", "chat_id": CHAT, "confidence": 0.9, "edit_date": 0, "external_id": f"tg:9000001{n:02d}",
            "extracted_at": received, "extracted_by": "fixture-extractor", "extraction_json": None, "extraction_status": "ok",
            "id": f"{CHAT}:1{n:02d}", "image_class": None, "kind": kind, "media_ref": None, "person_id": "alice", "raw_text": None,
            "received_at": received, "sender_person_id": "alice", "subject_hint": None, "subject_set_by": None, "subject_source": "sender"}
    base.update(kw)
    return base


def stmt(n, k, category, summary, quote, when):
    return {"rt": "d1.statements", "id": f"{CHAT}:1{n:02d}:s{k}", "source_message_id": f"{CHAT}:1{n:02d}", "person_id": "alice",
            "sender_person_id": "alice", "speaker": "sender", "category": category, "summary": summary, "quote": quote,
            "negated": 0, "time_frame": "today", "when_text": None, "when": when, "about": None, "confidence": 0.9, "confirmed": 0,
            "extracted_by": "fixture-extractor", "extracted_at": "2026-06-18T06:30:00.000Z"}


def bp(n, at, s, d, p):
    return [msg(n, "text", at, raw_text=f"bp {s}/{d} pulse {p}"),
            {"rt": "d1.readings", "id": f"{CHAT}:1{n:02d}:r0", "source_message_id": f"{CHAT}:1{n:02d}", "person_id": "alice",
             "type": "bp", "value": s, "value2": d, "value3": p, "unit": "mmHg", "source_value": None, "source_unit": None,
             "measured_at": at, "confidence": 0.9, "confirmed": 0, "extracted_by": "fixture-extractor", "extracted_at": at}]


TG = (bp(1, "2026-06-17T02:30:00.000Z", 104, 60, 70) + bp(2, "2026-06-18T02:30:00.000Z", 102, 58, 72)
      + [msg(3, "audio", "2026-06-18T06:09:00.000Z", media_ref="telegram/u-voice-ex3", duration_sec=20,
             transcript="आँखों में जलन है, थोड़ा सिर दर्द है दो बार", transcript_confidence=0.8, transcript_engine="whisper.cpp test; test-model",
             transcript_language="hi", transcript_path="sources/alice/media/telegram/u-voice-ex3.transcript.md"),
         stmt(3, 0, "symptom", "Eyes are burning", "आँखों में जलन है", "2026-06-18T11:39"),
         stmt(3, 1, "symptom", "Slight headache today, 2 times", "थोड़ा सिर दर्द है दो बार", "2026-06-18T11:39"),
         stmt(3, 2, "activity", "Emptied the plant pots in the morning", "गमले खाली किए", "2026-06-18"),
         {"rt": "d1.symptoms", "id": f"{CHAT}:103:y0", "source_message_id": f"{CHAT}:103", "person_id": "alice",
          "symptom_type": "pain", "location": "head", "side": "unknown", "character": "[]", "severity": None, "duration_min": None,
          "at_rest": None, "associated": "[]", "triggers": "[]", "free_text": "थोड़ा सिर दर्द", "observed_at": "2026-06-18T06:09:00.000Z",
          "confidence": 0.9, "confirmed": 0, "extracted_by": "fixture-extractor", "extracted_at": "2026-06-18T06:30:00.000Z"}])

LABELS = {
    "exampleaban": {"schema": "label-cache/1", "drug_id": "ref:drug:exampleaban", "queried": ["apixaban"], "fetched_at": "2026-06-19",
                    "source": "openFDA drug/label", "status": "found", "labels": [
                        {"query": "apixaban", "status": "found", "set_id": "00000000-0000-4000-8000-000000000001",
                         "effective_time": "20250101", "title": "EXAMPLEABAN", "sections": {
                             "adverse_reactions": "Less common adverse reactions: Eye disorders: conjunctival hemorrhage, eye hemorrhage. "
                                                  "Nervous system: headache. Discontinue if serious bleeding occurs due to the drug.",
                             "warnings_and_cautions": "Bleeding risk. Patients should be told to report unusual bleeding."}}]},
    "examplevite": {"schema": "label-cache/1", "drug_id": "ref:drug:examplevite", "queried": ["examplevitamin"], "fetched_at": "2026-06-19",
                    "source": "openFDA drug/label", "status": "not-available", "labels": [{"query": "examplevitamin", "status": "not-available"}]},
    "exampleolol": {"schema": "label-cache/1", "drug_id": "ref:drug:exampleolol", "queried": ["exampleolol"], "fetched_at": "2026-06-19",
                    "source": "openFDA drug/label", "status": "found", "labels": [
                        {"query": "exampleolol", "status": "found", "set_id": "00000000-0000-4000-8000-000000000002",
                         "effective_time": "20240501", "title": "EXAMPLEOLOL", "sections": {
                             "adverse_reactions": "Dizziness, fatigue. Rarely luminous phenomena (phosphenes)."}}]},
}
CONTEXT = """# Family context

## Rules
1. **Tier every action** and say the tier.
   - **Tier A, emergency (a listed red flag):** "go to Example Hospital now (about 20 minutes); call a taxi." Example
     Clinic stays the larger option.
   - **Tier B, same-week doctor:** realistically **2 to 4 days** at the example clinic. Say what to observe.
   - **Tier C, next planned visit or tele-consult:** the default for non-urgent questions.
"""


def make_records(tmp, inferred=False):
    rec = pathlib.Path(tmp) / "records"
    shutil.copytree(FIXTURE, rec, ignore=shutil.ignore_patterns("kb.sqlite", "kb.tmp"))
    with (rec / "data/ref/drug.ndjson").open("a", encoding="utf-8") as fh:
        fh.write("".join(json.dumps(r) + "\n" for r in DRUGS))
    for rows in (DOC_APRIL, DOC_JUNE):
        local = rows[0]["id"].split(":", 2)[2]
        (rec / f"data/alice/docs/{local}.ndjson").write_text("".join(json.dumps(r) + "\n" for r in rows))
        (rec / f"sources/alice/documents/{local}.md").write_text("Synthetic prescription.\n")
    with (rec / "data/telegram/2026-06.ndjson").open("a", encoding="utf-8") as fh:
        fh.write("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in TG))
    tg = rec / "sources/alice/media/telegram"
    shutil.copy(tg / "u-voice-ex1.ogg", tg / "u-voice-ex3.ogg")
    shutil.copy(tg / "u-voice-ex1.transcript.md", tg / "u-voice-ex3.transcript.md")
    (rec / "labels").mkdir()
    for k, v in LABELS.items():
        (rec / "labels" / f"{k}.json").write_text(json.dumps(v, ensure_ascii=False))
    (rec / "docs/health/family").mkdir(parents=True, exist_ok=True)
    (rec / "docs/health/family/context.md").write_text(CONTEXT)
    (rec / ".gitignore").write_text("data/kb.sqlite\n")
    git = ["git", "-C", str(rec), "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"]
    subprocess.run(git[:3] + ["init", "-q"], check=True)
    subprocess.run(git + ["add", "-A"], check=True)
    subprocess.run(git + ["commit", "-qm", "fixture"], check=True)
    r = subprocess.run([sys.executable, "-I", str(PRODUCT / "tools/kb/build"), "--records", str(rec)], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
    if inferred:
        fid = trigger_ids(rec)[0]
        row = {"schema": "inference/1", "id": "alice:inf:0001", "rev": 1, "problem": None, "problem_title": None, "hypothesis": None,
               "kind": "interpretation", "statement": "The eye burning sits alongside the soil work that morning.", "p": 0.6,
               "bucket": ">50%", "reason": "same morning", "stakes": "quality-of-life", "evidence_for": [fid], "evidence_against": [],
               "citations": [], "would_change": ["burning without soil work"], "produced_by": {"model": "example", "run": "docs/log/analysis/x.md"},
               "produced_at": "2026-06-19T10:00:00+05:30", "status": "active", "supersedes": None, "superseded_by": None,
               "status_reason": None, "review": "none", "review_note": None, "recorded_at": "2026-06-19T10:00:00+05:30", "label": "agent-inferred"}
        (rec / "inferences/alice").mkdir(parents=True)
        (rec / "inferences/alice/inferences.ndjson").write_text(json.dumps(row) + "\n")
    return rec


def trigger_ids(rec):
    con = sqlite3.connect(rec / "data/kb.sqlite")
    return [r[0] for r in con.execute("SELECT id FROM fact WHERE json_extract(data, '$.detail.category') = 'symptom' "
                                      "AND substr(at, 1, 10) = '2026-06-18' ORDER BY id")]


def site(rec, out, *extra, today=TODAY):
    return subprocess.run([sys.executable, "-I", str(PRODUCT / "tools/site/build"), "--records", str(rec), "--out", str(out),
                           "--today", today, *extra], capture_output=True, text=True)


def main_part(page):
    m = re.search(r'<main class="card-sym[^"]*".*?</main>', page, re.S)
    return m.group(0) if m else ""


class Fixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = pathlib.Path(tempfile.mkdtemp(prefix="sym-"))
        cls.rec = make_records(cls.tmp, inferred=True)
        cls.kb = gv.KB(sqlite3.connect(f"file:{cls.rec / 'data/kb.sqlite'}?mode=ro", uri=True))
        heard = {900000005}

        def unchecked(fid):
            f = cls.kb.facts.get(fid)
            if not f or "machine-transcript" not in json.loads(f["tags"]):
                return False
            s = cls.kb.sources[f["source_id"]]
            m = re.fullmatch(r"tg:(\d+)", json.loads(s["identifiers"] or "{}").get("external_id") or "")
            return not (m and int(m.group(1)) in heard)
        cls.cards = cardlib.Cards(cls.kb, cls.rec, datetime.date.fromisoformat(TODAY), unchecked=unchecked)
        cls.alice = cls.cards.for_person("alice")
        cls.out = cls.tmp / "site"
        r = site(cls.rec, cls.out, "--dx-api", "http://dx.example:8092")
        assert r.returncode == 0, r.stdout + r.stderr

    @classmethod
    def tearDownClass(cls):
        cls.kb.con.close()
        shutil.rmtree(cls.tmp, ignore_errors=True)


class ConfigTest(unittest.TestCase):
    def test_defaults_validate(self):
        cfg = cardlib.load_config()
        self.assertEqual({s["id"] for s in cfg["sites"]} >= {"eye", "head", "chest", "abdomen", "skin", "limbs-neuro", "breathing",
                                                             "urinary", "dizziness", "general"}, True)
        for r in cfg["rules"]:
            self.assertIn(r["tier"], "ABC"); self.assertIn(r["source"], cfg["sources"])
            self.assertEqual(cardlib.check_words(r["family"], family=True), [], r["id"])
        self.assertEqual(cfg["status"], "pending_clinician_signoff")

    def test_override_replaces_and_fails_closed(self):
        with tempfile.TemporaryDirectory() as t:
            (pathlib.Path(t) / "config").mkdir()
            f = pathlib.Path(t) / "config/symptom-card.json"
            f.write_text(json.dumps({"disable": ["head-b-other"], "rules": [{"id": "head-c-extra", "sites": ["head"], "when": [],
                                     "tier": "C", "source": "nhs-headaches", "owner": "A headache on most days for a month.",
                                     "family": "A headache on most days."}]}))
            cfg = cardlib.load_config(t)
            ids = {r["id"] for r in cfg["rules"]}
            self.assertIn("head-c-extra", ids); self.assertNotIn("head-b-other", ids)
            f.write_text(json.dumps({"rules": [{"id": "bad", "sites": ["head"], "when": [], "tier": "D", "source": "nhs-headaches",
                                                "owner": "x", "family": "y"}]}))
            with self.assertRaisesRegex(cardlib.CardError, r"rules\.bad\.tier"):
                cardlib.load_config(t)
            f.write_text(json.dumps({"rules": [{"id": "calm", "sites": ["head"], "when": [], "tier": "A", "source": "nhs-headaches",
                                                "owner": "x", "family": "Rush to hospital immediately."}]}))
            with self.assertRaisesRegex(cardlib.CardError, "word list"):
                cardlib.load_config(t)
            f.write_text(json.dumps({"colour": 1}))
            with self.assertRaisesRegex(cardlib.CardError, "unknown key 'colour'"):
                cardlib.load_config(t)

    def test_classify(self):
        cfg = cardlib.load_config()
        self.assertEqual(cardlib.classify("Eyes are burning; slight headache", cfg), ["eye", "head"])
        self.assertEqual(cardlib.classify("थोड़ा सिर दर्द", cfg), ["head"])
        self.assertEqual(cardlib.classify("chakkar aa raha", cfg), ["dizziness"])
        self.assertEqual(cardlib.classify("felt low after the bath", cfg), ["general"])

    def test_words(self):
        self.assertTrue(cardlib.check_words("The headache is caused by the tablet."))
        self.assertTrue(cardlib.check_words("Stop the evening medicine."))
        self.assertTrue(cardlib.check_words("Burning due to dust."))
        self.assertEqual(cardlib.check_words("Shown alongside, not as a cause."), [])
        self.assertTrue(cardlib.check_words("Go now, it is urgent", family=True))
        self.assertTrue(cardlib.check_words("p 40%", family=True))
        self.assertEqual(cardlib.check_words("p 40%"), [])

    def test_text_mentions_negation(self):
        self.assertFalse(cardlib.text_mentions("CVA (-), HTN (-)", ["cva"]))
        self.assertFalse(cardlib.text_mentions("no stroke", ["stroke"]))
        self.assertTrue(cardlib.text_mentions("Acute infarcts right cerebellum", ["infarcts"]))

    def test_tier_text(self):
        with tempfile.TemporaryDirectory() as t:
            self.assertEqual(cardlib.tier_text(t)["A"][0], "emergency")
            (pathlib.Path(t) / "docs/health/family").mkdir(parents=True)
            (pathlib.Path(t) / "docs/health/family/context.md").write_text(CONTEXT)
            tt = cardlib.tier_text(t)
            self.assertEqual(tt["A"], ("emergency", "Go to Example Hospital now (about 20 minutes); call a taxi."))
            self.assertEqual(tt["B"], ("same-week doctor", "Realistically 2 to 4 days at the example clinic."))
            self.assertEqual(tt["C"][0], "next planned visit or tele-consult")

    def test_label_quote_trimmed_against_word_list(self):
        e = LABELS["exampleaban"]["labels"][0]
        qs = cardlib.label_quotes(e, ["bleeding", "headache"])
        texts = [q for q, _, _ in qs]
        self.assertIn("Nervous system: headache", " ".join(texts) + " Nervous system: headache")
        for q in texts:
            self.assertEqual(cardlib.check_words(q), [], q)


class CardTest(Fixture):
    def card(self):
        self.assertEqual(len(self.alice), 1)
        return self.alice[0]

    def test_said_and_listener(self):
        c = self.card()
        said = [s for s in c["said"] if s["kind"] == "statement"]
        self.assertEqual(sorted(s["text"] for s in said), ["Eyes are burning", "Slight headache today, (number) times"])
        self.assertTrue(all(s["unchecked"] for s in c["said"]))
        self.assertEqual(c["listener"], "machine transcript, not yet listened")
        self.assertEqual([s["id"] for s in c["sites"]], ["eye", "head"])

    def test_alongside_and_readings(self):
        c = self.card()
        self.assertTrue(any("plant pots" in a["text"] for a in c["alongside"]))
        self.assertEqual([(r["series"], r["day"]) for r in c["readings"] if r["series"] == "sbp"], [("sbp", "2026-06-17"), ("sbp", "2026-06-18")])
        self.assertTrue(all("usual range not set yet" in r["words"] for r in c["readings"]))

    def test_meds(self):
        m = self.card()["meds"]
        got = {(x["drug"], x["what"], x["days_before"]) for x in m["changes"]}
        self.assertIn(("Exampleaban", "first recorded", 5), got)
        self.assertIn(("Exampleolol", "changed: strength 2.5 mg → 5 mg", 5), got)
        self.assertEqual([x["drug"] for x in m["long"]], ["Examplezole"])

    def test_labels(self):
        rows = {r["drug"]: r for r in self.card()["labels"]}
        self.assertEqual(rows["Exampleaban"]["state"], "label mentions")
        for q in rows["Exampleaban"]["parts"][0]["quotes"]:
            self.assertTrue(q["set_id"]) ; self.assertTrue(q["section"])
        self.assertTrue(any("conjunctival hemorrhage" in q["text"] for q in rows["Exampleaban"]["parts"][0]["quotes"]))
        self.assertEqual(rows["Examplevite"]["state"], "no label available")
        self.assertEqual(rows["Examplezole"]["state"], "label not fetched yet")
        self.assertEqual(rows["Exampleolol"]["state"], "label mentions")

    def test_warnings_anticoagulant_headache(self):
        c = self.card()
        self.assertEqual({m["id"] for m in c["modifiers"]}, {"anticoagulant", "weak-heart"})
        ids = {w["id"]: w["tier"] for w in c["warnings"]}
        self.assertEqual(ids["anticoagulant-a-bleeding"], "A")
        self.assertEqual(ids["eye-b-anticoagulant-red-patch"], "B")
        self.assertIn("head-a-sudden-severe", ids)
        self.assertNotIn("stroke-a-recent", ids)  # "CVA (-)" is written as negative
        self.assertTrue(all(w["id"] and w["tier"] in "ABC" for w in c["warnings"]))

    def test_questions_and_closing(self):
        c = self.card()
        self.assertLessEqual(len(c["questions"]), 5)
        self.assertEqual(len(set(c["questions"])), len(c["questions"]))
        self.assertEqual(c["questions"][:2], ["One eye or both?", "Where is the headache: front, side, back or all over?"])
        self.assertEqual((c["closing"]["max_days"], c["closing"]["tier"]), (3, "B"))
        self.assertIn("Eye drops: ask a doctor before using any.", c["closing"]["before_using"])

    def test_dm_text(self):
        t = cardlib.dm_text(self.card(), "Alice")
        self.assertLessEqual(len(t), 1200)
        self.assertTrue(t.startswith("Questions for Alice: "))
        self.assertNotIn("2 times", t)
        self.assertEqual(cardlib.check_words("\n".join(t.splitlines()[1:])), [])

    def test_no_card_after_the_window(self):
        c = cardlib.Cards(self.kb, self.rec, datetime.date(2026, 7, 3))
        self.assertEqual(c.for_person("alice"), [])


class SiteTest(Fixture):
    def pages(self):
        cid = self.alice[0]["id"]
        o = (self.out / f"alice/symptom/{cid}.html").read_text()
        f = (self.out / f"alice/symptom/{cid}-family.html").read_text()
        return cid, o, f

    def test_owner_sections(self):
        _, o, _ = self.pages()
        for h in ("1. What was said", "2. Same day and day before", "3. Medicines alongside", "4. What the labels say",
                  "5. Warning signs", "6. What to ask", "7. What would close it"):
            self.assertIn(f"<h2>{h}</h2>", o)
        main = main_part(o)
        for q in re.findall(r'<q class="aw">.*?</q> <span class="setid">([^<]*)</span>', main):
            self.assertRegex(q, r"^set id [0-9a-f-]{36} · ")
        for li in re.findall(r'<li><span class="tier">Tier ([ABC])</span>[^<]*<span class="rid">([a-z0-9-]+)</span></li>', main):
            self.assertTrue(li[0] and li[1])
        self.assertGreaterEqual(len(re.findall(r'<span class="rid">', main)), 5)
        self.assertIn("no label available", main); self.assertIn("label not fetched yet", main)
        self.assertIn("Most likely link (&gt;50%)", main)
        self.assertIn("(number) times", main); self.assertNotIn("2 times", main)
        self.assertIn('<span class="pill mt">machine transcript, not yet listened</span>', main)
        self.assertEqual(cardlib.check_words(re.sub(r"<[^>]+>", " ", re.sub(r'<(span|q|b) class="aw">.*?</\1>', " ", main))), [])

    def test_family_view(self):
        _, _, f = self.pages()
        main = main_part(f)
        for h in ("1. What was said", "5. Warning signs", "7. What would close it"):
            self.assertIn(f"<h2>{h}</h2>", main)
        for h in ("2. Same", "3. Medicines", "4. What the labels", "6. What to ask"):
            self.assertNotIn(h, main)
        self.assertNotIn("%", main); self.assertNotIn("gent-inferred", main); self.assertNotIn("likely", main.lower())
        self.assertNotIn("set id", main)
        self.assertIn("On the blood thinner: blood in urine, stool or vomit", main)
        self.assertIn("Go to Example Hospital now (about 20 minutes); call a taxi.", main)
        self.assertEqual(cardlib.check_words(re.sub(r"<[^>]+>", " ", re.sub(r'<(span|q|b) class="aw">.*?</\1>', " ", main)), family=True), [])

    def test_overview_and_links(self):
        cid, o, _ = self.pages()
        ov = (self.out / "alice/overview.html").read_text()
        self.assertIn("New symptoms", ov)
        self.assertIn(f'href="symptom/{cid}.html"', ov); self.assertIn(f'href="symptom/{cid}-family.html"', ov)
        self.assertIn("Symptom card</a>", ov)
        self.assertIsNone(re.search(r"https?://", (self.out / f"alice/symptom/{cid}-family.html").read_text()))
        self.assertIn('<form method="post" action="http://dx.example:8092/ask/alice"', o)
        self.assertIn("form-action http://dx.example:8092\"", o)
        self.assertIn('name="card" value="%s"' % cid, o)

    def test_read_only_without_dx(self):
        out = self.tmp / "ro"
        r = site(self.rec, out)
        self.assertEqual(r.returncode, 0, r.stderr)
        cid = self.alice[0]["id"]
        o = (out / f"alice/symptom/{cid}.html").read_text()
        self.assertIn("Read-only build: no send endpoint.", o)
        self.assertIsNone(re.search(r"https?://", o))
        self.assertIn("form-action 'none'", o)

    def test_golden(self):
        cid, o, f = self.pages()
        for name, page in (("alice-owner.html", o), ("alice-family.html", f)):
            got = main_part(page).replace(cid, "CARD").replace("><", ">\n<") + "\n"
            path = HERE / "golden" / name
            if os.environ.get("UPDATE_GOLDEN") == "1":
                path.parent.mkdir(exist_ok=True); path.write_text(got)
            self.assertEqual(got, path.read_text(), f"golden {name} differs (UPDATE_GOLDEN=1 rewrites it after review)")


if __name__ == "__main__":
    unittest.main()
