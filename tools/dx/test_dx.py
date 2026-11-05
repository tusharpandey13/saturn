#!/usr/bin/env -S python3 -I
"""Tests for tools/dx (state, caps, dry run, verifier, fake-claude end to end) on a git copy of fixtures/records-example.
Synthetic data only. Run: python3 -I tools/dx/test_dx.py"""
import datetime, http.server, importlib.machinery, importlib.util, json, os, pathlib, shutil, stat, subprocess, sys, tempfile, threading, unittest

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
FIXTURE = ROOT / "fixtures" / "records-example"
sys.path.insert(0, str(HERE))
import dxstate  # noqa: E402


def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


RUN = load("dx_run", HERE / "run")
GIT_T = ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"]
AGENTS = "# Rules\n\n1. Record facts as written; interpretation is allowed, labelled (owner, 30-Oct-2026).\n"
CONTEXT = "# Family context\n\nTier every action. Labs are closed on Sundays (synthetic).\n"
FAKE_CLAUDE = r'''#!/usr/bin/env python3
import json, os, re, sys
prompt = sys.stdin.read()
mode = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "mode")).read().strip()  # the job passes no env through
note = re.search(r"Write the run note at (docs/\S+\.md)", prompt).group(1)
os.makedirs(os.path.dirname(note), exist_ok=True)
body = ["---", 'title: "Alice: diagnostic loop (synthetic)"', "type: analysis", "---", "", "Facts as written; not advice; doctors decide.", "",
        "## 0. Red flags", "", "None found in the synthetic readings.", "", "## 6. Next steps ranked", "", "1. Ask the family when the headaches started (separates h1 from h2).", "",
        "## 7. Belief diff", "", "| id | before | after |", "|---|---|---|", "| alice:inf:0001 | 40 | 55 |", "", "## F. For the family", "", "Likely nothing urgent; we are watching.", "",
        "## 10. Hand-back summary", "", "red flags: none", "rounds 2, ensemble no, cost 1.50"]
if mode == "advice":
    body.append("Alice should stop the tablet tonight.")
open(note, "w").write("\n".join(body) + "\n")
q = "docs/health/alice/questions.md"
old = open(q).read() if os.path.exists(q) else "# Questions\n\n"
open(q, "w").write(old + "\n### alice:q:0007 Ask Dr Example whether an ECG would help?\n")
if mode == "outside":
    open("data/alice/docs/2026-07-01-fake.ndjson", "w").write("{}\n")
print(json.dumps({"type": "result", "subtype": "success", "is_error": False, "num_turns": 3, "total_cost_usd": 1.5, "result": "done"}))
'''


def git(cwd, *args):
    return subprocess.run(["git", "-C", str(cwd), *GIT_T, *args], capture_output=True, text=True, check=True).stdout


def make_records(tmp, origin=True):
    rec = tmp / "records"
    shutil.copytree(FIXTURE, rec, ignore=shutil.ignore_patterns("kb.sqlite", "kb.tmp"))
    (rec / "AGENTS.md").write_text(AGENTS)
    (rec / "docs/health/family").mkdir(parents=True, exist_ok=True)
    (rec / "docs/health/family/context.md").write_text(CONTEXT)
    (rec / ".gitignore").write_text("data/kb.sqlite\ndata/kb.tmp\n")
    git(rec, "init", "--quiet", "-b", "main")
    git(rec, "config", "commit.gpgsign", "false")
    git(rec, "add", "-A")
    git(rec, "commit", "--quiet", "-m", "fixture")
    if origin:
        bare = tmp / "origin.git"
        git(tmp, "init", "--quiet", "--bare", "-b", "main", str(bare))
        git(rec, "remote", "add", "origin", str(bare))
        git(rec, "push", "--quiet", "-u", "origin", "main")
    return rec


class TeleStub(http.server.BaseHTTPRequestHandler):
    got = []

    def log_message(self, *a):
        pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        TeleStub.got.append((self.path, json.loads(self.rfile.read(n))))
        body = b'{"ok":true}'
        self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)


class StateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="dx-state-"))
        self.t0 = datetime.datetime(2026, 11, 5, 10, 0, tzinfo=datetime.timezone.utc)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_queue_run_caps(self):
        st = dxstate.State(self.tmp)
        row, err = st.enqueue("alice", "owner@example", self.t0)
        self.assertIsNone(err); self.assertEqual(row["state"], "queued")
        self.assertTrue((self.tmp / "spool" / "alice.json").is_file())
        _, err = st.enqueue("alice", "owner@example", self.t0 + datetime.timedelta(minutes=1))
        self.assertEqual(err[0], 409); self.assertIn("already queued", err[1])
        _, err = st.enqueue("bob", "owner@example", self.t0 + datetime.timedelta(minutes=1))  # global cap: 1 per 24 h
        self.assertEqual(err[0], 409); self.assertIn("cap reached: 1 run(s) per 24 h", err[1])
        self.assertEqual(err[2], "2026-11-06T10:00:00Z")
        taken = st.take()
        self.assertEqual(taken["state"], "running"); self.assertFalse(list((self.tmp / "spool").glob("*")))
        self.assertIsNone(st.take())
        _, err = st.enqueue("alice", "x", self.t0 + datetime.timedelta(hours=1))
        self.assertEqual(err[0], 409); self.assertIn("already running", err[1])
        st.update(taken["id"], state="done", finished_at="2026-11-05T11:00:00Z", pushed=True, commit="abc")
        s = st.status("alice", self.t0 + datetime.timedelta(hours=2))
        self.assertEqual(s["state"], "done"); self.assertFalse(s["can_run"]); self.assertEqual(s["next_allowed_at"], "2026-11-06T10:00:00Z")
        row, err = st.enqueue("alice", "x", self.t0 + datetime.timedelta(hours=24))
        self.assertIsNone(err)
        with self.assertRaises(KeyError):
            st.update(row["id"], nonsense=1)
        with self.assertRaises(ValueError):
            st.update(row["id"], state="bogus")

    def test_scope_ns_and_30_days(self):
        st = dxstate.State(self.tmp, cap_24h=1, cap_30d=3, scope="ns")
        self.assertIsNone(st.enqueue("alice", "x", self.t0)[1])
        self.assertIsNone(st.enqueue("bob", "x", self.t0)[1])  # per-namespace scope: bob is not blocked by alice
        for d in (2, 4):
            st.take(); st.update(st.last("alice")["id"], state="done")
            self.assertIsNone(st.enqueue("alice", "x", self.t0 + datetime.timedelta(days=d))[1])
        st.take(); st.update(st.last("alice")["id"], state="failed")
        _, err = st.enqueue("alice", "x", self.t0 + datetime.timedelta(days=6))
        self.assertEqual(err[0], 409); self.assertIn("3 run(s) per 30 days", err[1])
        self.assertEqual(err[2], "2026-12-05T10:00:00Z")  # the first request leaves the window 30 days after t0
        self.assertIsNone(st.enqueue("alice", "x", self.t0 + datetime.timedelta(days=30))[1])

    def test_awaiting_key(self):
        st = dxstate.State(self.tmp)
        (self.tmp / "awaiting-key").touch()
        _, err = st.enqueue("alice", "x", self.t0)
        self.assertEqual(err[0], 503); self.assertIn("awaiting key", err[1])
        self.assertTrue(st.status("alice", self.t0)["awaiting_key"])


class VerifierUnits(unittest.TestCase):
    def test_paths(self):
        ok = ["docs/log/analysis/2026-11-05-alice-dx-loop-01.md", "docs/log/analysis/dx/alice-predictions.ndjson",
              "inferences/alice/inferences.ndjson", "docs/health/alice/status.md", "docs/health/bob/status.md",
              "docs/health/alice/summary.md", "docs/health/alice/questions.md", "docs/health/family/actions.md"]
        bad = ["data/alice/docs/x.ndjson", "docs/health/alice/medications.md", "docs/health/bob/questions.md",
               "inferences/bob/inferences.ndjson", "sources/alice/documents/x.pdf", "docs/health/alice/briefs/x.md", "tools/x"]
        for p in ok:
            self.assertTrue(RUN.allowed(p, "alice"), p)
        for p in bad:
            self.assertFalse(RUN.allowed(p, "alice"), p)

    def test_advice_words(self):
        caught = ["Alice should stop the tablet tonight.", "Consider reducing the dose to 2.5 mg.", "It is safe to double the medicine.",
                  "This rules out a stroke.", "You should switch to the evening tablets.", "The spells are caused by the medicine."]
        fine = ["Ask Dr Example whether stopping the medicine would help?", "The neurologist stopped two medicines on 27-Oct.",
                "Never suggest starting, stopping or changing a medicine.", "> quoted: stop the tablet (doctor-written, 01-Nov)",
                "| dx:0006.h4 stopped neuro medicines | 9 | 6 |", "Question for the cardiologist: would a lower dose be worth discussing?"]
        for t in caught:
            self.assertTrue(RUN.advice_hits(t), t)
        for t in fine:
            self.assertFalse(RUN.advice_hits(t), t)
        self.assertEqual(RUN.advice_hits("+Alice should stop the tablet.\n+++ b/x\n-stop the dose")[0][0], 1)

    def test_summary_is_ten_lines(self):
        row = {"by": "o", "cost_usd": 1.234, "turns": 7, "started_at": "2026-11-05T10:00:00Z", "finished_at": "2026-11-05T11:30:00Z",
               "commit": "abcdef1234567", "pushed": True}
        note = "## 0. Red flags\n\nNone.\n\n## 6. Next steps\n\n1. Ask.\n\n## 7. Belief diff\n\n| alice:inf:0001 | 40 | 55 |\n| alice:inf:0002 | 10 | 5 |\n\n## F. Family\n\nCalm words.\n"
        s = RUN.summary_lines("alice", 3, "done", note, "+ alice:q:0007\n+ family:act:0003\n+ family:act:0004\n", row, "https://h/health")
        lines = s.splitlines()
        self.assertEqual(len(lines), 10)
        self.assertEqual(lines[0], "dx loop 03 · alice · done (delta, site trigger by o)")
        self.assertEqual(lines[1], "note: https://h/health/alice/overview.html")
        self.assertIn("2 row(s) in the belief diff", lines[3]); self.assertIn("questions +1 · family actions +2", lines[4])
        self.assertIn("cost $1.23 · 7 turns · 90 min", lines[7]); self.assertIn("commit abcdef1234 pushed", lines[8])
        self.assertEqual(lines[9], RUN.FOOT)

    def test_claude_argv(self):
        argv = RUN.claude_argv("claude", 12, pathlib.Path("/p"), None)
        self.assertEqual(argv[:4], ["claude", "-p", "--output-format", "json"])
        for flag in ("--restricted", "--no-session-persistence", "--add-dir", "--max-budget-usd", "--setting-sources"):
            self.assertIn(flag, argv)
        self.assertEqual(argv[argv.index("--permission-mode") + 1], "dontAsk")
        self.assertEqual(argv[argv.index("--disallowedTools") + 1], "WebSearch")
        self.assertIn("Bash(python3 -I *)", argv); self.assertIn("WebFetch(domain:doi.org)", argv)
        self.assertNotIn("WebFetch(domain:www.google.com)", argv)
        self.assertNotIn("Bash", argv[argv.index("--allowedTools"):])  # never a bare Bash allow
        self.assertNotIn("--model", argv); self.assertIn("--model", RUN.claude_argv("claude", 1, pathlib.Path("/p"), "opus"))

    def test_child_env_is_minimal(self):
        tmp = pathlib.Path(tempfile.mkdtemp()); f = tmp / "c.env"; f.write_text("CLAUDE_CODE_OAUTH_TOKEN=sk-test\nOTHER=1\n")
        os.environ["GITHUB_TOKEN"] = "leak"
        try:
            env = RUN.child_env(str(f))
        finally:
            del os.environ["GITHUB_TOKEN"]; shutil.rmtree(tmp)
        self.assertEqual(env["CLAUDE_CODE_OAUTH_TOKEN"], "sk-test")
        self.assertNotIn("GITHUB_TOKEN", env); self.assertNotIn("OTHER", env); self.assertIn("PATH", env)


class RunTest(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="dx-run-"))
        self.rec = make_records(self.tmp)
        self.state = self.tmp / "state"
        self.fake = self.tmp / "fake-claude"
        self.fake.write_text(FAKE_CLAUDE); self.fake.chmod(self.fake.stat().st_mode | stat.S_IEXEC)
        self.notify = self.tmp / "ops.env"; self.notify.write_text("TELEGRAM_BOT_TOKEN=t0k\nTELEGRAM_ADMIN_CHAT_ID=123\n")
        TeleStub.got = []
        self.srv = http.server.HTTPServer(("127.0.0.1", 0), TeleStub)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.api = "http://127.0.0.1:%d" % self.srv.server_address[1]

    def tearDown(self):
        self.srv.shutdown(); self.srv.server_close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_tool(self, *extra, mode="good"):
        (self.tmp / "mode").write_text(mode)
        return subprocess.run([sys.executable, "-I", str(HERE / "run"), "--records", str(self.rec), "--product", str(ROOT), "--state", str(self.state),
                               "--claude", str(self.fake), "--notify-env", str(self.notify), "--telegram-api", self.api, "--site", "https://h/health", *extra],
                              capture_output=True, text=True, timeout=600)

    def test_dry_run(self):
        r = self.run_tool("--ns", "alice", "--dry-run")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("dry run ok: alice run 01", r.stdout); self.assertIn("claude argv:", r.stdout)
        run_dir = next((self.state / "runs").iterdir())
        prompt = (run_dir / "prompt.md").read_text()
        for s in ("RUN = delta, trigger =", "NS = alice", f"PRODUCT = {ROOT}", "HEADLESS RUN", "docs/log/analysis/2026-", "-alice-dx-loop-01.md",
                  "Hard cap 2 rounds, no ENSEMBLE", "interpretation is allowed, labelled", "Labs are closed on Sundays", "doi.org", "docs/health/family/actions.md"):
            self.assertIn(s, prompt)
        pack = (run_dir / "pack.md").read_text()
        for s in ("## 1 age band", "## 3 medicines", "docs/health/alice/medications.md", "## 11 open questions", "## 12 changed since", "No earlier run note"):
            self.assertIn(s, pack)
        self.assertEqual(git(self.rec, "status", "--porcelain"), "")
        self.assertFalse((self.state / "state.json").exists())  # a dry run writes no state row
        self.assertEqual(TeleStub.got, [])

    def test_dry_run_refuses_without_mode_line(self):
        (self.rec / "AGENTS.md").write_text("# Rules\n\nRecord and flag only.\n"); git(self.rec, "commit", "-qam", "mode off")
        r = self.run_tool("--ns", "alice", "--dry-run")
        self.assertEqual(r.returncode, 2); self.assertIn("interpretation is allowed", r.stderr)

    def test_spool_end_to_end(self):
        self.assertEqual(self.run_tool().returncode, 0)  # empty spool: nothing to do
        st = dxstate.State(self.state)
        row, err = st.enqueue("alice", "owner@example")
        self.assertIsNone(err)
        r = self.run_tool()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        row = st.find(row["id"])
        self.assertEqual(row["state"], "done"); self.assertTrue(row["pushed"]); self.assertEqual(row["cost_usd"], 1.5); self.assertEqual(row["turns"], 3)
        self.assertRegex(row["note"], r"^docs/log/analysis/\d{4}-\d{2}-\d{2}-alice-dx-loop-01\.md$")
        self.assertEqual(git(self.rec, "log", "-1", "--format=%an|%s").strip(), "saturn dx-loop|docs: alice dx loop 01 (delta, site trigger) [skip ci]")
        self.assertEqual(git(self.rec, "rev-parse", "HEAD").strip(), row["commit"])
        self.assertEqual(git(self.tmp / "origin.git", "rev-parse", "main").strip(), row["commit"])
        files = git(self.rec, "show", "--name-only", "--format=", "HEAD").split()
        self.assertEqual(sorted(files), sorted([row["note"], "docs/health/alice/questions.md"]))
        self.assertEqual(git(self.rec, "status", "--porcelain"), "")
        self.assertEqual(len(TeleStub.got), 1)
        path, body = TeleStub.got[0]
        self.assertEqual(path, "/bott0k/sendMessage"); self.assertEqual(body["chat_id"], 123)
        lines = body["text"].splitlines()
        self.assertEqual(len(lines), 10)
        self.assertEqual(lines[0], "dx loop 01 · alice · done (delta, site trigger by owner@example)")
        self.assertEqual(lines[1], "note: https://h/health/alice/overview.html")
        self.assertIn("red flags: None found", lines[2]); self.assertIn("1 row(s) in the belief diff", lines[3])
        self.assertIn("questions +1", lines[4]); self.assertTrue(lines[8].endswith("pushed"))
        # a second press the same day is refused by the state, and run 02 would be the next number
        self.assertEqual(st.enqueue("alice", "owner@example")[1][0], 409)
        self.assertEqual(RUN.run_number(self.rec, "alice")[0], 2)

    def test_advice_is_refused_and_stashed(self):
        st = dxstate.State(self.state); row, _ = st.enqueue("alice", "o")
        r = self.run_tool(mode="advice")
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        row = st.find(row["id"])
        self.assertEqual(row["state"], "failed"); self.assertIn("medicine advice", row["error"]); self.assertIsNone(row["commit"])
        self.assertEqual(git(self.rec, "status", "--porcelain"), "")
        self.assertIn("dx " + row["id"] + " failed", git(self.rec, "stash", "list"))
        self.assertEqual(git(self.rec, "log", "-1", "--format=%s").strip(), "fixture")
        self.assertEqual(TeleStub.got[0][1]["text"].splitlines()[0], "dx loop 01 · alice · failed (delta, site trigger by o)")

    def test_outside_path_is_refused(self):
        st = dxstate.State(self.state); row, _ = st.enqueue("alice", "o")
        r = self.run_tool(mode="outside")
        self.assertEqual(r.returncode, 1)
        self.assertIn("outside the allowed paths: data/alice/docs/2026-07-01-fake.ndjson", st.find(row["id"])["error"])
        self.assertEqual(git(self.rec, "status", "--porcelain"), "")

    def test_push_refused_is_awaiting_key(self):
        hook = self.tmp / "origin.git" / "hooks" / "pre-receive"  # pull works, push is refused (an unauthorised key behaves the same)
        hook.write_text("#!/bin/sh\necho refused >&2\nexit 1\n"); hook.chmod(0o755)
        r = self.run_tool("--ns", "alice", "--by", "cli")
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
        row = dxstate.State(self.state).last("alice")
        self.assertEqual(row["state"], "awaiting-key"); self.assertFalse(row["pushed"]); self.assertTrue(row["commit"])
        self.assertIn("push awaits the deploy key", TeleStub.got[0][1]["text"])

    def test_group_chat_id_is_refused(self):
        self.notify.write_text("TELEGRAM_BOT_TOKEN=t0k\nTELEGRAM_ADMIN_CHAT_ID=-100123\n")
        self.assertFalse(RUN.tele_send(str(self.notify), "x", self.api))
        self.assertEqual(TeleStub.got, [])


if __name__ == "__main__":
    unittest.main()
