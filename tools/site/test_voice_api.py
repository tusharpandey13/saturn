#!/usr/bin/env -S python3 -I
"""Tests for tools/site/voice-api against a git copy of fixtures/records-example (synthetic data only).
Run: python3 -I tools/site/test_voice_api.py"""
import importlib.machinery, importlib.util, json, pathlib, shutil, subprocess, sys, tempfile, threading, unittest
import urllib.error, urllib.parse, urllib.request

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent
FIXTURE = ROOT / "fixtures" / "records-example"
sys.path.insert(0, str(ROOT / "tools" / "stt"))  # stt-eval imports sttlib


def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


API = load("voice_api", HERE / "voice-api")
EVAL = load("stt_eval_tool", ROOT / "tools" / "stt-eval" / "stt-eval")
GIT_T = ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"]


def git(cwd, *args):
    return subprocess.run(["git", "-C", str(cwd), *GIT_T, *args], capture_output=True, text=True, check=True).stdout


class Base(unittest.TestCase):
    push = True

    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="voice-api-"))
        self.rec = self.tmp / "records"
        shutil.copytree(FIXTURE, self.rec, ignore=shutil.ignore_patterns("kb.sqlite", "kb.tmp"))
        git(self.rec, "init", "--quiet", "-b", "main")
        git(self.rec, "config", "commit.gpgsign", "false")  # the API signs only when the clone says so
        git(self.rec, "add", "-A")
        git(self.rec, "commit", "--quiet", "-m", "fixture")
        if self.push:
            self.bare = self.tmp / "origin.git"
            git(self.tmp, "init", "--quiet", "--bare", "-b", "main", str(self.bare))
            git(self.rec, "remote", "add", "origin", str(self.bare))
            git(self.rec, "push", "--quiet", "-u", "origin", "main")
        store = API.Store(self.rec, push=self.push)
        self.srv = API.Server(("127.0.0.1", 0), store)
        self.base = "http://%s:%d" % self.srv.server_address
        self.thread = threading.Thread(target=self.srv.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        self.thread.join(5)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def call(self, path, body=None, form=False, headers=None, method=None):
        """-> (status, headers, text). JSON bodies unless form=True."""
        data = None
        hdrs = dict(headers or {})
        if body is not None:
            if form:
                data = urllib.parse.urlencode(body).encode()
                hdrs["Content-Type"] = "application/x-www-form-urlencoded"
            else:
                data = json.dumps(body, ensure_ascii=False).encode("utf-8")
                hdrs["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base + path, data=data, headers=hdrs, method=method or ("POST" if data else "GET"))
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, r.headers, r.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            with e:
                return e.code, e.headers, e.read().decode("utf-8")

    def listened(self):
        p = self.rec / "data" / "telegram" / "listened.ndjson"
        return [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]

    def build_ok(self):
        r = subprocess.run([sys.executable, "-I", str(ROOT / "tools" / "kb" / "build"), "--records", str(self.rec)],
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


class TestWithOrigin(Base):
    def test_health_and_404(self):
        st, h, body = self.call("/health")
        self.assertEqual(st, 200)
        self.assertEqual(json.loads(body), {"ok": True})
        self.assertEqual(h["Cache-Control"], "no-store")
        self.assertEqual(h["X-Robots-Tag"], "noindex, nofollow")
        self.assertEqual(h["Referrer-Policy"], "no-referrer")
        self.assertEqual(h["X-Content-Type-Options"], "nosniff")
        self.assertNotIn("Python", h.get("Server", ""))
        self.assertEqual(self.call("/voice/alice/u-voice-ex1")[0], 404)

    def test_heard_then_save_then_build(self):
        st, h, body = self.call("/voice/alice/u-voice-ex1", {"action": "heard", "by": "tester"})
        self.assertEqual(st, 200, body)
        out = json.loads(body)
        self.assertTrue(out["ok"] and out["changed"])
        self.assertEqual((out["action"], out["ns"], out["stem"], out["update_id"], out["by"]),
                         ("heard", "alice", "u-voice-ex1", 900000004, "tester"))
        rows = self.listened()
        self.assertEqual(rows[-1]["update_id"], 900000004)
        self.assertEqual(rows[-1]["by"], "tester")
        self.assertRegex(rows[-1]["at"], r"^\d{4}-\d{2}-\d{2}$")
        self.assertEqual(rows[-1]["note"], "voice review: heard, no changes")
        self.assertEqual(list(rows[-1]), ["update_id", "by", "at", "note"])
        self.assertEqual(git(self.bare, "log", "-1", "--format=%an%n%s", "main").split("\n")[:2],
                         ["saturn voice-review", "data: voice review heard alice/u-voice-ex1"])
        self.assertEqual(git(self.bare, "rev-parse", "main").strip(), out["commit"])

        # second heard on the same stem: nothing to write, no commit
        st, _, body = self.call("/voice/alice/u-voice-ex1", {"action": "heard"})
        self.assertEqual(st, 200)
        self.assertEqual(json.loads(body)["changed"], False)
        self.assertIsNone(json.loads(body)["commit"])
        self.assertEqual(git(self.bare, "rev-parse", "main").strip(), out["commit"])
        self.assertEqual(len([r for r in self.listened() if r["update_id"] == 900000004]), 1)

        # save with Devanagari text
        text = "आज मौसम अच्छा है\nशाम को दो गोली"
        st, _, body = self.call("/voice/alice/u-voice-ex1", {"action": "save", "text": text, "by": "tester"})
        self.assertEqual(st, 200, body)
        out = json.loads(body)
        self.assertTrue(out["changed"])
        gt = self.rec / "sources" / "alice" / "media" / "telegram" / "u-voice-ex1.groundtruth.md"
        md = gt.read_text(encoding="utf-8")
        self.assertIn("[alice] आज मौसम अच्छा है\n[alice] शाम को दो गोली\n", md)
        self.assertNotIn("\\u", md)
        self.assertTrue(md.startswith("---\ntype: ground-truth-transcript\n"))
        self.assertIn('audio: "sources/alice/media/telegram/u-voice-ex1.ogg"', md)
        self.assertIn('message_id: "-1001234567890:21"', md)
        self.assertIn("update_id: 900000004\nduration_sec: 7\n", md)
        self.assertIn("speakers: [alice]\nlisten", md)
        self.assertIn("transcribed_by: tester (voice review page)", md)
        self.assertIn("# Ground truth: voice note u-voice-ex1 (alice)", md)
        lines, terms = EVAL.parse_groundtruth(md)
        self.assertEqual(lines, [{"speaker": "alice", "text": "आज मौसम अच्छा है"},
                                 {"speaker": "alice", "text": "शाम को दो गोली"}])
        self.assertEqual(git(self.bare, "log", "-1", "--format=%s", "main").strip(),
                         "data: voice review save alice/u-voice-ex1")
        self.assertEqual(len([r for r in self.listened() if r["update_id"] == 900000004]), 1)
        self.build_ok()

    def test_form_and_tailscale_header(self):
        st, h, body = self.call("/voice/alice/u-voice-ex1", {"action": "heard", "by": "formuser"}, form=True,
                                headers={"Tailscale-User-Login": "owner@example.com"})
        self.assertEqual(st, 200, body)
        self.assertTrue(h["Content-Type"].startswith("text/html"))
        self.assertIn("Recorded: heard for u-voice-ex1 by owner@example.com.", body)
        self.assertIn("The site shows this within about ten minutes (it rebuilds on a timer).", body)
        self.assertNotIn("<a ", body)
        self.assertNotIn("<script", body)
        self.assertEqual(self.listened()[-1]["by"], "owner@example.com")
        # form save with the speaker-prefixed and terms: lines kept
        st, _, body = self.call("/voice/alice/u-voice-ex2", {"action": "save",
                                "text": "[bob] हाँ\nठीक है\n[papa] नहीं\n[?] शायद\n[?]\nterms: गोली\nnotes: x\n\nraw"}, form=True)
        self.assertEqual(st, 200, body)
        md = (self.rec / "sources/alice/media/telegram/u-voice-ex2.groundtruth.md").read_text(encoding="utf-8")
        # [?] (unresolved by the listener) is dropped and the line falls back to [<ns>]; an explicit name is kept
        self.assertIn("[bob] हाँ\n[alice] ठीक है\n[papa] नहीं\n[alice] शायद\nterms: गोली\nnotes: x\n\nraw\n", md)
        lines, terms = EVAL.parse_groundtruth(md)
        self.assertEqual([l["speaker"] for l in lines], ["bob", "alice", "papa", "alice"])
        self.assertEqual(terms, ["गोली"])
        self.assertEqual(len([r for r in self.listened() if r["update_id"] == 900000005]), 1)  # fixture row kept
        self.build_ok()

    def test_errors(self):
        self.assertEqual(self.call("/voice/alice/nope", {"action": "heard"})[0], 404)
        self.assertEqual(self.call("/voice/zed/u-voice-ex1", {"action": "heard"})[0], 404)
        self.assertEqual(self.call("/voice/family/u-voice-ex1", {"action": "heard"})[0], 404)
        st, _, body = self.call("/voice/alice/u-voice-ex1", {"action": "delete"})
        self.assertEqual(st, 400)
        self.assertEqual(json.loads(body)["ok"], False)
        self.assertEqual(self.call("/voice/alice/u-voice-ex1", {"action": "save", "text": " "})[0], 400)
        self.assertEqual(self.call("/voice/alice/u-voice-ex1", {"action": "save", "text": "x" * (65 * 1024)})[0], 413)
        (self.rec / "sources/alice/media/telegram/u-orphan.ogg").write_bytes(b"OggS")
        st, _, body = self.call("/voice/alice/u-orphan", {"action": "heard"})
        self.assertEqual(st, 409)
        self.assertEqual(json.loads(body)["ok"], False)
        self.assertEqual(git(self.bare, "log", "--format=%s", "main").strip(), "fixture")  # nothing committed


class TestNoPush(Base):
    push = False

    def test_no_push_commits_locally(self):
        st, _, body = self.call("/voice/alice/u-voice-ex1", {"action": "save", "text": "एक दो"})
        self.assertEqual(st, 200, body)
        out = json.loads(body)
        self.assertEqual(git(self.rec, "rev-parse", "HEAD").strip(), out["commit"])
        self.assertEqual(git(self.rec, "log", "-1", "--format=%an", "HEAD").strip(), "saturn voice-review")
        self.assertEqual(git(self.rec, "status", "--porcelain").strip(), "")
        self.assertEqual(self.listened()[-1]["by"], "voice-review")
        self.build_ok()


if __name__ == "__main__":
    unittest.main()
