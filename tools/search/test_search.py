#!/usr/bin/env python3
"""Tests for tools/search/search: synthetic records (fixtures/records-example + generated notes), a mock embedding
server (deterministic bag-of-words vectors), stdlib only."""
import hashlib, http.server, json, pathlib, shutil, subprocess, sys, tempfile, threading, unittest

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
TOOL = HERE / "search"
EX = ROOT / "fixtures" / "records-example"


class Mock(http.server.BaseHTTPRequestHandler):
    model = "mock-embeddinggemma"
    inputs = []

    def log_message(self, *a):
        pass

    def _send(self, obj):
        b = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        self._send({"data": [{"id": Mock.model}]})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        Mock.inputs.extend(body["input"])
        out = []
        for i, t in enumerate(body["input"]):
            v = [0.0] * 128
            for w in t.lower().replace("|", " ").split():
                v[int(hashlib.md5(w.strip(".,:\"'").encode()).hexdigest(), 16) % 128] += 1
            out.append({"index": i, "embedding": v})
        self._send({"data": out})


class Search(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Mock)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.srv.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.rec = self.tmp / "records"
        shutil.copytree(EX, self.rec)
        self.db = self.tmp / "index" / "index.sqlite"
        Mock.model, Mock.inputs = "mock-embeddinggemma", []
        w = lambda rel, text: ((self.rec / rel).parent.mkdir(parents=True, exist_ok=True), (self.rec / rel).write_text(text))
        w("sources/alice/documents/2026-04-01-example-clinic-note.ocr.md",
          "# Page 1\n\nBreathlessness on climbing stairs. Ankle swelling by evening.\n\n# Page 2\n\nReview in 4 weeks.\n")
        w("sources/bob/media/family/2026-04-02-example-voice.transcript.md", "Subah chakkar aaya, BP 150/90 tha.\n")
        w("docs/log/analysis/2026-04-03-alice-example-trend.md",
          "---\ntitle: Example trend\n---\n# Trend\n\nPotassium rose across three synthetic reports.\n")
        w("docs/health/alice/questions.md", "# Open\n\n- alice:q:0001 Ask about the ankle swelling.\n")
        w("docs/log/research/2026-04-04-not-indexed.md", "Research notes are not indexed.\n")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_tool(self, *args, ok=True):
        r = subprocess.run([sys.executable, "-I", str(TOOL), "--db", str(self.db), "--endpoint", self.url, *args],
                           capture_output=True, text=True)
        if ok:
            self.assertEqual(r.returncode, 0, r.stderr)
        return r

    def index(self, *extra):
        return json.loads(self.run_tool("index", "--records", str(self.rec), *extra).stdout)

    def query(self, text, *extra):
        return json.loads(self.run_tool("query", text, "--json", *extra).stdout)["results"]

    def test_full_then_incremental(self):
        s = self.index()
        self.assertGreater(s["chunks_total"], 10)
        self.assertEqual(s["prompt_style"], "gemma")
        self.assertTrue(all(t.startswith("title: ") for t in Mock.inputs))
        self.assertTrue(not any("Research notes" in t for t in Mock.inputs))
        self.assertEqual(oct(self.db.stat().st_mode & 0o777), "0o600")
        Mock.inputs = []
        s2 = self.index()
        self.assertEqual((s2["files_changed"], s2["chunks_embedded"], Mock.inputs), (0, 0, []))
        # one file changes: only it is re-embedded
        (self.rec / "docs/health/alice/questions.md").write_text("# Open\n\n- alice:q:0002 New synthetic question.\n")
        s3 = self.index()
        self.assertEqual((s3["files_changed"], s3["chunks_embedded"]), (1, 1))
        self.assertEqual(s3["chunks_total"], s["chunks_total"])
        # deleted file drops out
        (self.rec / "sources/bob/media/family/2026-04-02-example-voice.transcript.md").unlink()
        s4 = self.index()
        self.assertEqual((s4["files_removed"], s4["chunks_total"]), (1, s["chunks_total"] - 1))

    def test_ref_change_reembeds_facts(self):
        self.index()
        with open(self.rec / "data/ref/code.ndjson", "a") as f:
            f.write("\n")
        s = self.index()
        n_fact_files = len([p for p in (self.rec / "data").rglob("*.ndjson") if "ref" not in p.parts])
        self.assertEqual(s["files_changed"], n_fact_files)

    def test_model_change_reindexes_everything(self):
        n = self.index()["chunks_total"]
        Mock.model = "mock-bge-m3"
        s = self.index()
        self.assertEqual((s["files_changed"], s["chunks_total"], s["prompt_style"]), (s["files_total"], n, "none"))
        Mock.model = "mock-other"
        r = self.run_tool("query", "anything", ok=False)
        self.assertEqual(r.returncode, 1)
        self.assertIn("re-index", r.stderr)

    def test_query_metadata_and_filters(self):
        self.index()
        res = self.query("POTASSIUM 5.7 H", "-k", "3")
        top = res[0]
        self.assertEqual(top["kind"], "fact")
        self.assertEqual(top["id"], "alice:fact:2026-03-12-example-lab-lft-rft.potassium")
        self.assertEqual((top["path"], top["page"], top["ns"]),
                         ("sources/alice/documents/2026-03-12-example-lab-lft-rft.md", 2, "alice"))
        self.assertIn("Potassium", top["snippet"])  # ref name resolved from data/ref
        q = self.query("ankle swelling question", "--kind", "questions")
        self.assertEqual((q[0]["id"], q[0]["ns"]), ("alice:q:0001", "alice"))
        o = self.query("breathlessness stairs", "--kind", "ocr")[0]
        self.assertEqual((o["page"], o["ns"]), (1, "alice"))
        self.assertTrue(all(r["ns"] in ("bob", None) for r in self.query("chakkar BP", "--ns", "bob", "-k", "50")))
        a = self.query("potassium trend", "--kind", "analysis")[0]
        self.assertEqual((a["ns"], a["title"]), ("alice", "Example trend / Trend"))
        human = self.run_tool("query", "chakkar")
        self.assertIn("transcript/bob", human.stdout)

    def test_stats_and_dry_run(self):
        r = self.run_tool("index", "--records", str(self.rec), "--dry-run", ok=False)
        self.assertEqual((r.returncode, json.loads(r.stdout)["files_changed"] > 0), (1, True))
        self.index()
        self.assertEqual(self.run_tool("index", "--records", str(self.rec), "--dry-run").returncode, 0)
        st = json.loads(self.run_tool("stats").stdout)
        self.assertEqual(st["model"], "mock-embeddinggemma")
        self.assertGreater(st["last_index_at"], 0)
        prom = self.run_tool("stats", "--prom", "--probe", "blood pressure").stdout
        for m in ("saturn_search_chunks{kind=\"fact\"}", "saturn_search_db_bytes", "saturn_search_probe_query_seconds",
                  "saturn_search_last_index_timestamp_seconds"):
            self.assertIn(m, prom)

    def test_errors(self):
        r = self.run_tool("query", "x", ok=False)
        self.assertEqual(r.returncode, 1)  # no index yet
        r = subprocess.run([sys.executable, "-I", str(TOOL), "--db", str(self.db), "--endpoint", "http://127.0.0.1:9",
                            "index", "--records", str(self.rec)], capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)
        self.assertEqual(self.run_tool("index", "--records", str(self.tmp / "nope"), ok=False).returncode, 3)


if __name__ == "__main__":
    unittest.main(verbosity=1)
