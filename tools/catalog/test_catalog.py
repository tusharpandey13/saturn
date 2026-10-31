#!/usr/bin/env python3
"""Tests for tools/catalog/catalog against the synthetic fixtures/catalog-example (stdlib only)."""
import importlib.machinery, importlib.util, json, pathlib, shutil, subprocess, sys, tempfile, unittest

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
TOOL = HERE / "catalog"
EX = ROOT / "fixtures" / "catalog-example"
DIRS = [str(EX / "env-a"), str(EX / "env-b")]

loader = importlib.machinery.SourceFileLoader("catalog_tool", str(TOOL))
spec = importlib.util.spec_from_loader("catalog_tool", loader)
cat = importlib.util.module_from_spec(spec)
loader.exec_module(cat)


def run(*args):
    return subprocess.run([sys.executable, "-I", str(TOOL), *args], capture_output=True, text=True)


class Parser(unittest.TestCase):
    def test_subset(self):
        docs = cat.parse_yaml(
            "a: 1  # c\nb: \"x, # y\"\nc: [p, 'q r', \"s\\\"t\"]\nd: {k: v, n: 2}\ne:\n  - f: 1\n    g: [h]\n  - plain\n"
            "t: |\n  one\n  two\nu: >-\n  folded\n  text\n---\nz: true\n", "t")
        self.assertEqual(docs[0], {"a": 1, "b": "x, # y", "c": ["p", "q r", 's"t'], "d": {"k": "v", "n": 2},
                                   "e": [{"f": 1, "g": ["h"]}, "plain"], "t": "one\ntwo\n", "u": "folded text"})
        self.assertEqual(docs[1], {"z": True})

    def test_list_at_key_indent(self):
        self.assertEqual(cat.parse_yaml("k:\n- a\n- b\nm: 1\n", "t"), [{"k": ["a", "b"], "m": 1}])

    def test_rejects(self):
        for bad in ("a: &x 1\n", "a: 1\na: 2\n", "a: \"open\n", "  a: 1\n", "a: [1, 2\n"):
            with self.assertRaises(cat.CatalogError, msg=bad):
                cat.parse_yaml(bad, "t")


class Validate(unittest.TestCase):
    def copy(self):
        d = pathlib.Path(tempfile.mkdtemp())
        for sub in ("env-a", "env-b"):
            shutil.copytree(EX / sub, d / sub)
        self.addCleanup(shutil.rmtree, d)
        return d

    def test_example_ok(self):
        r = run("validate", *DIRS)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("10 entities", r.stdout)

    def test_cross_catalog_ref_needs_both(self):
        r = run("validate", DIRS[1])
        self.assertEqual(r.returncode, 1)
        self.assertIn("does not resolve", r.stderr)

    def broken(self, edit, expect):
        d = self.copy()
        f = d / "env-b" / "box.yaml"
        f.write_text(edit(f.read_text()))
        r = run("validate", str(d / "env-a"), str(d / "env-b"))
        self.assertEqual(r.returncode, 1, r.stdout)
        self.assertIn(expect, r.stderr)

    def test_duplicate_name(self):
        self.broken(lambda t: t.replace("name: box-checks", "name: box-router"), "not unique")

    def test_wrong_ref_kind(self):
        self.broken(lambda t: t.replace("consumesApis: [api:example-webhook]", "consumesApis: [example-db]"), "is a Resource")

    def test_schema(self):
        self.broken(lambda t: t.replace("type: service\n  lifecycle: production\n  owner: group:owner\n  system: home-box\n  dependsOn: [resource:box]",
                                        "type: daemon\n  lifecycle: production\n  owner: group:owner\n  system: home-box\n  dependsOn: [resource:box]"),
                    "not one of")

    def test_secret_value(self):
        self.broken(lambda t: t.replace("agent notes", "x") + "  agents: \"token ghp_" + "A1b2C3d4" * 4 + "\"\n", "GitHub token")
        self.broken(lambda t: t.replace("unit: checks.service", "unit: checks.service\n    description: k=Zx81Qp0LmN3vB7cT5yW2eR9uI4oA6sD1"),
                    "random-looking")
        self.broken(lambda t: t.replace("unit: checks.service", "unit: checks.service\n    description: id e97c01c7-3faf-4ca0-8fd3-d2d835c39f6e"),
                    "random-looking")

    def test_names_are_not_secrets(self):
        self.assertEqual(cat.secret_findings({"a": "TELEGRAM_BOT_TOKEN_FOR_THE_ADMIN_DIGEST", "b": "docs/decisions/011-group-input-only-admin-dm.md"}), [])


class Generators(unittest.TestCase):
    def test_gatus(self):
        r = run("gen", "gatus", "--format", "json", *DIRS)
        self.assertEqual(r.returncode, 0, r.stderr)
        eps = json.loads(r.stdout)
        self.assertEqual([(e["group"], e["name"]) for e in eps], [("core", "box-router"), ("external", "example-worker")])
        self.assertEqual(eps[1], {"name": "example-worker", "group": "external", "url": "https://worker.example.invalid/health",
                                  "interval": "5m", "conditions": ["[STATUS] == 200", "[BODY] == ok"],
                                  "alerts": [{"type": "custom", "description": "Example Worker /health failing"}]})
        y = run("gen", "gatus", *DIRS).stdout
        self.assertEqual(cat.parse_yaml(y, "gatus.yaml")[0], {"endpoints": eps})

    def test_wellknown_and_merge_roundtrip(self):
        wk = json.loads(run("gen", "wellknown", *DIRS).stdout)
        self.assertEqual(len(wk["entities"]), 10)
        merged = cat.parse_yaml(run("merge", *DIRS).stdout, "merged")
        self.assertEqual(merged, wk["entities"])
        self.assertEqual(run("gen", "wellknown", *DIRS).stdout, run("gen", "wellknown", *DIRS).stdout)

    def test_llms(self):
        d = pathlib.Path(tempfile.mkdtemp()); self.addCleanup(shutil.rmtree, d)
        r = run("gen", "llms", *DIRS, "--out", str(d), "--title", "Example")
        self.assertEqual(r.returncode, 0, r.stderr)
        short, full = (d / "llms.txt").read_text(), (d / "llms-full.txt").read_text()
        self.assertTrue(short.startswith("# Example\n\n> "))
        self.assertIn("## Home box", short)
        self.assertIn("- box-router [Component (service)]", short)
        self.assertIn("secret WEBHOOK_SECRET in secrets/example.sops.env", full)
        self.assertIn("(tailnet only)", full)

    def test_agents_md(self):
        d = pathlib.Path(tempfile.mkdtemp()); self.addCleanup(shutil.rmtree, d)
        t = d / "AGENTS.md"
        t.write_text(f"# Rules\n\n{cat.START}\nold\n{cat.END}\n\nmore\n")
        self.assertEqual(run("gen", "agents-md", *DIRS, "--target", str(t), "--check").returncode, 1)
        self.assertEqual(run("gen", "agents-md", *DIRS, "--target", str(t)).returncode, 0)
        text = t.read_text()
        self.assertIn("| `box-router` | Component (service) |", text)
        self.assertTrue(text.startswith("# Rules\n") and text.endswith("\nmore\n"))
        self.assertEqual(run("gen", "agents-md", *DIRS, "--target", str(t), "--check").returncode, 0)
        t.write_text("no markers\n")
        self.assertEqual(run("gen", "agents-md", *DIRS, "--target", str(t)).returncode, 1)


if __name__ == "__main__":
    unittest.main(verbosity=1)
