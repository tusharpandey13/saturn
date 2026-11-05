#!/usr/bin/env -S python3 -I
"""Tests for tools/site/dx-api (queue, caps, identity, status) on a copy of fixtures/records-example (synthetic data).
Run: python3 -I tools/site/test_dx_api.py"""
import importlib.machinery, importlib.util, json, pathlib, shutil, sys, tempfile, threading, unittest, urllib.error, urllib.parse, urllib.request

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent.parent
FIXTURE = ROOT / "fixtures" / "records-example"
sys.path.insert(0, str(ROOT / "tools" / "dx"))
import dxstate  # noqa: E402


def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


API = load("dx_api", HERE / "dx-api")


class Base(unittest.TestCase):
    allow = ("tester@example.com",)   # --allow-login
    login = "tester@example.com"      # the Tailscale-User-Login header `call` sends unless the test sets its own (None = none)
    with_records = True

    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="dx-api-"))
        self.rec = self.tmp / "records"
        if self.with_records:
            shutil.copytree(FIXTURE, self.rec, ignore=shutil.ignore_patterns("kb.sqlite", "kb.tmp"))
        else:
            self.rec.mkdir()
        self.state = self.tmp / "state"
        self.api = API.Api(self.rec, self.state, site="https://h/health", allow=self.allow)
        self.srv = API.Server(("127.0.0.1", 0), self.api)
        self.base = "http://%s:%d" % self.srv.server_address
        self.thread = threading.Thread(target=self.srv.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.srv.shutdown(); self.srv.server_close(); self.thread.join(5)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def call(self, path, body=None, form=False, headers=None, method=None):
        data, hdrs = None, dict(headers or {})
        if self.login and "Tailscale-User-Login" not in hdrs:
            hdrs["Tailscale-User-Login"] = self.login
        if body is not None:
            if form:
                data = urllib.parse.urlencode(body).encode(); hdrs["Content-Type"] = "application/x-www-form-urlencoded"
            else:
                data = json.dumps(body).encode(); hdrs["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base + path, data=data, headers=hdrs, method=method or ("POST" if data is not None else "GET"))
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, r.headers, r.read().decode()
        except urllib.error.HTTPError as e:
            with e:
                return e.code, e.headers, e.read().decode()


class Open(Base):
    def test_health_routes_and_errors(self):
        self.assertEqual(self.call("/health")[0], 200)
        self.assertEqual(self.call("/dx/alice/nope")[0], 404)
        self.assertEqual(self.call("/dx/zed/run", {})[0], 404)       # unknown namespace
        self.assertEqual(self.call("/dx/family/run", {})[0], 404)    # shared namespace, not a person
        self.assertEqual(self.call("/dx/alice/status", {})[0], 404)  # POST on status
        st, _, body = self.call("/dx/alice/run", {"x": "y" * 20000})
        self.assertEqual(st, 413)
        st, _, body = self.call("/dx/alice/run", [1], headers={"Content-Type": "application/json"})
        self.assertEqual(st, 400)
        req = urllib.request.Request(self.base + "/dx/alice/run", data=b"x", headers={"Content-Type": "text/plain"}, method="POST")
        with self.assertRaises(urllib.error.HTTPError) as cm:
            urllib.request.urlopen(req, timeout=10)
        self.assertEqual(cm.exception.code, 415)

    def test_queue_then_refuse(self):
        st, h, body = self.call("/dx/alice/status")
        self.assertEqual(st, 200); j = json.loads(body)
        self.assertEqual(j["state"], "never"); self.assertTrue(j["can_run"]); self.assertEqual(j["caps"], {"per_24h": 1, "per_30d": 8, "scope": "global"})
        self.assertEqual(j["overview"], "https://h/health/alice/overview.html")
        st, h, body = self.call("/dx/alice/run", {"by": "form-user"}, form=True)
        self.assertEqual(st, 202); self.assertIn("text/html", h["Content-Type"]); self.assertIn("Queued: a delta run of the loop for alice, requested by tester@example.com", body)
        self.assertIn('href="status"', body); self.assertIn("no-store", h["Cache-Control"])
        rows = json.loads((self.state / "state.json").read_text())["runs"]
        self.assertEqual([(r["ns"], r["by"], r["state"]) for r in rows], [("alice", "tester@example.com", "queued")])
        self.assertTrue((self.state / "spool" / "alice.json").is_file())
        st, _, body = self.call("/dx/alice/run", {}, form=True)
        self.assertEqual(st, 409); self.assertIn("Not queued: already queued since", body)
        st, _, body = self.call("/dx/bob/run", {})
        self.assertEqual(st, 409); j = json.loads(body); self.assertIn("cap reached: 1 run(s) per 24 h", j["error"]); self.assertTrue(j["next_allowed_at"])
        st, _, body = self.call("/dx/alice/status")
        j = json.loads(body); self.assertEqual(j["state"], "queued"); self.assertFalse(j["can_run"]); self.assertEqual(j["last_run"]["by"], "tester@example.com")
        st, h, body = self.call("/dx/alice/status", headers={"Accept": "text/html,*/*"})
        self.assertEqual(st, 200); self.assertIn("text/html", h["Content-Type"]); self.assertIn("<th>State</th><td>queued</td>", body)
        self.assertIn("1 per 24 h, 8 per 30 days (global)", body); self.assertIn("Back to the overview", body); self.assertIn(API.FOOT, body)
        # the job finishes: the status reflects it and the cap still holds for 24 h
        s = dxstate.State(self.state)
        s.update(rows[0]["id"], state="done", pushed=True, commit="abc123def456", note="docs/log/analysis/2026-06-25-alice-dx-loop-01.md", cost_usd=1.5)
        (self.state / "spool" / "alice.json").unlink()
        st, _, body = self.call("/dx/alice/status", headers={"Accept": "text/html"})
        self.assertIn("<th>State</th><td>done</td>", body); self.assertIn("abc123def456 (pushed)", body); self.assertIn("$1.50", body)
        st, _, body = self.call("/dx/alice/run", {})
        self.assertEqual(st, 409); self.assertIn("last run requested at", json.loads(body)["error"])

    def test_header_is_the_identity_never_the_form(self):
        st, _, body = self.call("/dx/alice/run", {"by": "forged"}, headers={"Tailscale-User-Login": "Tester@Example.com"})
        self.assertEqual(st, 202); self.assertEqual(json.loads(body)["run"]["by"], "Tester@Example.com")

    def test_awaiting_key(self):
        (self.state / "awaiting-key").touch()
        st, _, body = self.call("/dx/alice/run", {})
        self.assertEqual(st, 503); self.assertIn("awaiting key", json.loads(body)["error"])
        self.assertTrue(json.loads(self.call("/dx/alice/status")[2])["awaiting_key"])
        st, _, body = self.call("/dx/alice/run", {}, form=True)
        self.assertEqual(st, 503); self.assertIn("Not queued: awaiting key", body)


class AllowList(Base):
    allow = ("owner@example.com",)
    login = None

    def test_only_the_allowed_login_may_press(self):
        st, _, body = self.call("/dx/alice/run", {"by": "owner@example.com"})  # a form value is not an identity
        self.assertEqual((st, json.loads(body)["error"]), (403, "identity required"))
        self.assertEqual(self.call("/dx/alice/run", {}, headers={"Tailscale-User-Login": "someone@example.com"})[0], 403)
        # identity is checked before the namespace: the owner on an unknown ns gets 404, a stranger gets 403
        self.assertEqual(self.call("/dx/nobody/run", {}, headers={"Tailscale-User-Login": "owner@example.com"})[0], 404)
        self.assertEqual(self.call("/dx/nobody/run", {}, headers={"Tailscale-User-Login": "someone@example.com"})[0], 403)
        self.assertEqual(self.call("/dx/alice/run", {}, headers={"Tailscale-User-Login": "Owner@Example.com"})[0], 202)
        self.assertEqual(self.call("/dx/alice/status")[0], 200)  # status is readable by anyone on the tailnet


class DefaultDeny(Base):
    """No --allow-login: every POST is 403, even with a header; status stays readable."""
    allow = ()
    login = None

    def test_no_allow_list_refuses_every_press(self):
        st, _, body = self.call("/dx/alice/run", {})
        self.assertEqual((st, json.loads(body)["error"]), (403, "identity required"))
        self.assertEqual(self.call("/dx/alice/run", {}, headers={"Tailscale-User-Login": "anyone@example.com"})[0], 403)
        self.assertEqual(self.call("/dx/alice/status")[0], 200)
        self.assertFalse(list((self.state / "spool").glob("*.json")) if (self.state / "spool").is_dir() else [])


class NoClone(Base):
    with_records = False

    def test_not_ready(self):
        self.assertEqual(self.call("/health")[0], 200)
        st, _, body = self.call("/dx/alice/run", {})
        self.assertEqual(st, 503); self.assertIn("records clone not ready", json.loads(body)["error"])
        self.assertEqual(self.call("/dx/alice/status")[0], 503)


if __name__ == "__main__":
    unittest.main()
