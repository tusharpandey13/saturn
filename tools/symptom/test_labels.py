#!/usr/bin/env -S python3 -I
"""Tests for tools/symptom/labels against a local stub of the openFDA label API (synthetic labels; no network).
Run: python3 -I tools/symptom/test_labels.py"""
import http.server, json, pathlib, shutil, subprocess, sys, tempfile, threading, unittest, urllib.parse

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import test_cards as tc  # noqa: E402  (the synthetic records overlay)

LABELS = {  # generic name (lower) -> openFDA results
    "apixaban": [
        {"set_id": "00000000-0000-4000-8000-0000000000a1", "effective_time": "20240101", "openfda": {"brand_name": ["SHORTLABEL"], "product_type": ["HUMAN PRESCRIPTION DRUG"]},
         "adverse_reactions": ["Bleeding."]},
        {"set_id": "00000000-0000-4000-8000-0000000000a2", "effective_time": "20230101", "openfda": {"brand_name": ["FULLLABEL"], "product_type": ["HUMAN PRESCRIPTION DRUG"]},
         "adverse_reactions": ["Eye disorders: conjunctival hemorrhage. Nervous system: headache."], "boxed_warning": ["Synthetic boxed text."],
         "indications_and_usage": ["not kept"]}],
    "exampleolol": [{"set_id": "00000000-0000-4000-8000-0000000000b1", "effective_time": "20240501", "openfda": {"generic_name": ["EXAMPLEOLOL"]},
                     "adverse_reactions": ["Dizziness."]}],
}


class Stub(http.server.BaseHTTPRequestHandler):
    calls, fail = [], False

    def log_message(self, *a):
        pass

    def do_GET(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)["search"][0]
        Stub.calls.append(q)
        if Stub.fail:
            self.send_response(500); self.send_header("Content-Length", "0"); self.end_headers(); return
        name = q.split('"')[1]
        res = LABELS.get(name.lower())
        body = json.dumps({"results": res} if res else {"error": {"code": "NOT_FOUND"}}).encode()
        self.send_response(200 if res else 404); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)


class LabelsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="labels-"))
        self.rec = tc.make_records(self.tmp)
        shutil.rmtree(self.rec / "labels")
        Stub.calls, Stub.fail = [], False
        self.srv = http.server.HTTPServer(("127.0.0.1", 0), Stub)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.api = "http://127.0.0.1:%d" % self.srv.server_address[1]

    def tearDown(self):
        self.srv.shutdown(); self.srv.server_close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_tool(self, *a):
        return subprocess.run([sys.executable, "-I", str(HERE / "labels"), *a, "--records", str(self.rec), "--api", self.api,
                               "--today", "2026-06-20"], capture_output=True, text=True)

    def test_fetch_check_and_choice(self):
        r = self.run_tool("check")
        self.assertEqual(r.returncode, 1); self.assertIn("missing: ref:drug:exampleaban", r.stdout)
        r = self.run_tool("fetch")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("found 2", r.stdout); self.assertIn("not-available 2", r.stdout)  # examplevite, examplezole: no US label
        a = json.loads((self.rec / "labels/exampleaban.json").read_text())
        self.assertEqual((a["schema"], a["status"], a["fetched_at"]), ("label-cache/1", "found", "2026-06-20"))
        e = a["labels"][0]
        self.assertEqual(e["set_id"], "00000000-0000-4000-8000-0000000000a2")  # the longest adverse_reactions wins
        self.assertEqual(sorted(e["sections"]), ["adverse_reactions", "boxed_warning"])
        self.assertEqual(e["candidates"], 2)
        v = json.loads((self.rec / "labels/examplevite.json").read_text())
        self.assertEqual((v["status"], v["labels"][0]["status"]), ("not-available", "not-available"))
        self.assertTrue(any("HUMAN PRESCRIPTION DRUG" in c for c in Stub.calls))
        self.assertTrue(any("HUMAN PRESCRIPTION DRUG" not in c and "examplevitamin" in c for c in Stub.calls))  # OTC fallback
        self.assertEqual(self.run_tool("check").returncode, 0)
        n = len(Stub.calls)
        r = self.run_tool("fetch")  # fresh entries are kept
        self.assertIn("kept 4", r.stdout); self.assertEqual(len(Stub.calls), n)

    def test_network_error_keeps_old_entry(self):
        self.assertEqual(self.run_tool("fetch").returncode, 0)
        before = (self.rec / "labels/exampleaban.json").read_text()
        Stub.fail = True
        r = self.run_tool("fetch", "--force")
        self.assertEqual(r.returncode, 1); self.assertIn("old entry kept", r.stderr)
        self.assertEqual((self.rec / "labels/exampleaban.json").read_text(), before)

    def test_combination_falls_back_to_ingredients(self):
        import sqlite3
        sys.path.insert(0, str(HERE))
        con = sqlite3.connect(self.rec / "data/kb.sqlite")
        import importlib.machinery, importlib.util
        ld = importlib.machinery.SourceFileLoader("labels_tool", str(HERE / "labels"))
        mod = importlib.util.module_from_spec(importlib.util.spec_from_loader("labels_tool", ld)); ld.exec_module(mod)
        obj = mod.fetch_one(mod.Client(self.api), con, "ref:drug:none", "apixaban + examplevitamin", "2026-06-20")
        self.assertEqual(obj["status"], "partial")
        self.assertEqual([(e["query"], e["status"]) for e in obj["labels"]], [("apixaban", "found"), ("examplevitamin", "not-available")])
        self.assertTrue(any("apixaban and examplevitamin" in c for c in Stub.calls))
        con.close()


if __name__ == "__main__":
    unittest.main()
