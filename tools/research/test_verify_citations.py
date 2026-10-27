#!/usr/bin/env -S python3 -I
"""verify_citations tests: python3 -I tools/research/test_verify_citations.py
Synthetic cross-reference (fictional person, made-up PMIDs and DOIs) and a fake network: nothing leaves the machine."""
import json, pathlib, subprocess, sys, tempfile, unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import verify_citations as vc  # noqa: E402


class FakeNet:
    """PubMed has 1000001 (title 'Example trial of testolol'); 1000002 does not exist."""

    def __init__(self):
        self.calls = []

    def esummary(self, pmids):
        self.calls.append(("esummary", tuple(pmids)))
        res = {"uids": pmids}
        for p in pmids:
            res[p] = ({"uid": p, "title": "Example trial of testolol in adults.",
                       "articleids": [{"idtype": "doi", "value": "10.9999/example.1"}]}
                      if p == "1000001" else {"uid": p, "error": "cannot get document summary"})
        return {"result": res}

    def abstract(self, pmid):
        return "Example trial of testolol. Results: testolol was associated with lower example-marker values."

    def head(self, url, follow=True):
        self.calls.append(("head", url, follow))
        if url.startswith("https://doi.org/"):
            return 302 if url.endswith("10.9999/exists") else 404
        return {"https://labels.example.org/ok": 200, "https://labels.example.org/blocked": 403}.get(url, 404)

    def get_text(self, url):
        return "<p>Testolol may lower example-marker values by about 30%.</p>"


def item(iid, statement="Testolol is associated with lower example-marker values.", **cite):
    c = {"quote": "testolol was associated with lower example-marker values", "accessed": "2026-10-27",
         "source_tier": "abstract", "license": "publisher-abstract"}
    c.update(cite)
    return {"id": iid, "type": "association", "statement": statement, "citations": [c]}


def doc(*items, questions=()):
    return {"schema": "saturn.research_crossref/v1", "ns": "zed", "summary": "Synthetic.",
            "items": list(items), "questions": list(questions)}


class Structural(unittest.TestCase):
    def test_clean_offline(self):
        self.assertEqual(vc.verify(doc(item("rx-001", pmid="1000001"))), [])

    def test_missing_quote_and_id(self):
        d = doc({"id": "rx-002", "statement": "x", "citations": [{"accessed": "2026-10-27"}]})
        msgs = [m for _, _, m in vc.verify(d)]
        self.assertIn("missing quote", msgs)
        self.assertIn("no pmid, doi or url", msgs)

    def test_no_citations(self):
        self.assertEqual([m for _, _, m in vc.verify(doc({"id": "rx-3", "statement": "x"}))], ["no citations"])

    def test_malformed_ids(self):
        msgs = " ".join(m for _, _, m in vc.verify(doc(item("a", pmid="PMC123"), item("b", doi="doi:10.1/x"))))
        self.assertIn("malformed PMID", msgs)
        self.assertIn("malformed DOI", msgs)

    def test_phrasing(self):
        bad = [
            "Consider reducing the dose of testolol.",
            "You should ask for a scan.",
            "The patient has heart failure.",
            "Low values are caused by testolol.",
        ]
        for s in bad:
            res = vc.verify(doc(item("p", statement=s, pmid="1000001")))
            self.assertTrue(any("phrasing" in m for _, _, m in res), s)
        q = {"id": "zed:q:0001", "text": "Should the testolol dose be halved?"}
        ok_q = {"id": "zed:q:0002", "text": "Dr Example: is a repeat example-marker test due, given testolol?"}
        res = vc.verify(doc(item("p", pmid="1000001"), questions=[q, ok_q]))
        self.assertEqual([w for _, w, m in res if "phrasing" in m], ["question zed:q:0001"])


class Tiers(unittest.TestCase):
    def errs(self, *items):
        return [m for lv, _, m in vc.verify(doc(*items)) if lv == "error"]

    def test_quote_needs_tier_and_license(self):
        a = item("a", pmid="1000001"); del a["citations"][0]["source_tier"]
        b = item("b", pmid="1000001"); del b["citations"][0]["license"]
        e = " | ".join(self.errs(a, b))
        self.assertIn("needs source_tier", e)
        self.assertIn("needs license", e)

    def test_license_allow_list(self):
        for lic in ("CC BY-NC-ND 4.0", "cc by-nc-nd", "CC BY-NC-SA 3.0 IGO", "CC0", "Public Domain"):
            self.assertEqual(self.errs(item("a", pmid="1000001", source_tier="oa_article", license=lic)), [], lic)
        for lic in ("all rights reserved", "proprietary", "CC BY-NC-ND-EXTRA"):
            self.assertTrue(any("allow-list" in m for m in
                                self.errs(item("a", pmid="1000001", source_tier="oa_article", license=lic))), lic)

    def test_label_host_and_abstract_length(self):
        bad = item("a", url="https://labels.example.org/ok", source_tier="label", license="public-domain")
        self.assertTrue(any("label host" in m for m in self.errs(bad)))
        good = item("b", url="https://dailymed.nlm.nih.gov/x", source_tier="label", license="public-domain")
        self.assertEqual(self.errs(good), [])
        long_ = item("c", pmid="1000001", quote="x" * 300)
        self.assertTrue(any("abstract quote longer" in m for m in self.errs(long_)))

    def test_link_only_tier_never_quoted(self):
        q = item("a", url="https://example.org/g", source_tier="guideline_link_only", license="n/a")
        self.assertTrue(any("no quote allowed" in m for m in self.errs(q)))

    def test_reports_guideline(self):
        g = "https://uroweb.org/guidelines/x"
        ok = item("a", statement="secondary: reports EAU recommendation. Testolol is associated with lower values.",
                  url="https://www.ncbi.nlm.nih.gov/books/NBK1/", source_tier="bookshelf",
                  license="CC BY-NC-ND", reports_guideline=g)
        self.assertEqual(self.errs(ok), [])
        unlabelled = item("b", pmid="1000001", reports_guideline=g)
        self.assertTrue(any("must be labelled" in m for m in self.errs(unlabelled)))
        primary = item("c", statement="secondary: reports EAU recommendation.", url="https://dailymed.nlm.nih.gov/x",
                       source_tier="label", license="public-domain", reports_guideline=g)
        self.assertTrue(any("only on a secondary tier" in m for m in self.errs(primary)))
        # quoting the link-only host itself is still rejected
        self.assertTrue(any("link-only source: no quote" in m for m in
                            self.errs(item("d", url=g, locator="3.1", source_tier="oa_article", license="CC BY"))))


PRIV = "/r/docs/health/zed/research/private/2026-10-27-crossref.json"
PUB = "/r/docs/health/zed/research/2026-10-27-crossref.json"


def pdoc(*items, **kw):
    d = doc(*items)
    d.update(visibility="private", run_date="2026-10-27", **kw)
    return d


def restricted(iid, url="https://stw.icmr.org.in/x", **kw):
    return item(iid, url=url, locator="p. 2", source_tier="restricted", license="private-research", **kw)


class PrivateMode(unittest.TestCase):
    def errs(self, d, path=None):
        return [m for lv, _, m in vc.verify(d, path=path) if lv == "error"]

    def test_private_research_accepted_in_private_dir(self):
        self.assertEqual(self.errs(pdoc(restricted("a"), restricted("b", url="https://publisher.example.org/p")),
                                   PRIV), [])

    def test_private_file_outside_private_dir(self):
        for path in (PUB, None, "/r/docs/health/zed/notresearch/private/x.json"):
            e = self.errs(pdoc(item("a", pmid="1000001")), path)
            self.assertTrue(any("must sit under" in m for m in e), path)
        # and nothing private is accepted there
        self.assertTrue(any("only in a visibility: private file" in m for m in self.errs(pdoc(restricted("a")), PUB)))

    def test_private_research_rejected_in_public_file(self):
        for path in (PUB, PRIV, None):
            e = self.errs(doc(restricted("a")), path)
            self.assertTrue(any("only in a visibility: private file" in m for m in e), path)
            self.assertTrue(any("link-only source: no quote" in m for m in e), path)

    def test_licence_and_tier_go_together(self):
        a = item("a", pmid="1000001", source_tier="restricted", license="CC BY")
        b = item("b", pmid="1000001", source_tier="abstract", license="private-research")
        e = self.errs(pdoc(a, b), PRIV)
        self.assertEqual(sum("go together" in m for m in e), 2)

    def test_no_ai_bodies_link_only_in_both_modes(self):
        for host in ("https://uroweb.org/g", "https://www.auanet.org/g", "https://www.nice.org.uk/g",
                     "https://www.escardio.org/g", "https://diabetesjournals.org/care/g"):
            e = self.errs(pdoc(restricted("a", url=host)), PRIV)
            self.assertTrue(any("link-only source: no quote" in m for m in e), host)
            self.assertTrue(any("link-only in both modes" in m for m in e), host)
            # a link with no quote, but private-research licence, is still rejected
            c = restricted("b", url=host, quote="")
            self.assertTrue(any("link-only in both modes" in m for m in self.errs(pdoc(c), PRIV)), host)

    def test_link_only_statement_says_no_recommendation(self):
        link = {"url": "https://uroweb.org/g", "locator": "4.2", "accessed": "2026-10-27"}
        bad = {"id": "a", "statement": "EAU recommends an example-marker test.", "citations": [link]}
        ok = {"id": "b", "statement": "EAU addresses example-marker testing (section 4.2).", "citations": [link]}
        for d, path in ((doc(bad, ok), PUB), (pdoc(bad, ok), PRIV)):
            res = vc.verify(d, path=path)
            self.assertEqual([w for lv, w, m in res if lv == "error"], ["item a"], path)

    def test_copyright_only_host_still_link_only_in_public(self):
        e = self.errs(doc(item("a", url="https://stw.icmr.org.in/x", locator="p. 2", source_tier="oa_article",
                               license="CC BY")), PUB)
        self.assertTrue(any("link-only source: no quote" in m for m in e))

    def test_cli_derives_path(self):
        with tempfile.TemporaryDirectory() as t:
            for sub, rc in (("research/private", 0), ("research", 1)):
                d = pathlib.Path(t, sub); d.mkdir(parents=True, exist_ok=True)
                f = d / "2026-10-27-crossref.json"
                f.write_text(json.dumps(pdoc(restricted("a"))))
                r = subprocess.run([sys.executable, "-I", str(HERE / "verify_citations.py"), str(f), "--offline"],
                                   capture_output=True, text=True)
                self.assertEqual(r.returncode, rc, r.stdout)


def check(**kw):
    r = {"body": "EAU", "title": "Example guideline", "version": "2026", "url": "https://uroweb.org/guidelines/x",
         "locator": "Section 5.3", "kb_ids": ["zed:fact:2026-01-01-example-lab.psa"], "recheck_after": "2027-03-31",
         "own_words_note": ""}
    r.update(kw)
    return r


class ReadChecklist(unittest.TestCase):
    def errs(self, *rows):
        d = doc(item("a", pmid="1000001"))
        d.update(run_date="2026-10-27", read_checklist=list(rows))
        return [m for lv, _, m in vc.verify(d) if lv == "error"]

    def test_clean(self):
        self.assertEqual(self.errs(check(), check(url="https://www.nice.org.uk/guidance/ng1")), [])

    def test_no_quote_or_recommendation_fields(self):
        for k in ("quote", "recommendation", "summary"):
            e = self.errs(check(**{k: "text"}))
            self.assertTrue(any("no quote or recommendation content" in m for m in e), k)

    def test_required_and_dates(self):
        e = " | ".join(self.errs(check(locator="", kb_ids=[], recheck_after="2026-01-01",
                                       url="https://example.org/g", own_words_note="filled by agent")))
        for frag in ("locator required", "kb_ids required", "recheck_after", "link-only guideline body",
                     "own_words_note stays blank"):
            self.assertIn(frag, e)


class Online(unittest.TestCase):
    def test_pmid_resolves_and_missing(self):
        net = FakeNet()
        res = vc.verify(doc(item("a", pmid="1000001"), item("b", pmid="1000002")), net)
        self.assertEqual([(lv, w) for lv, w, _ in res], [("error", "item b citation 1")])
        self.assertEqual([c for c in net.calls if c[0] == "esummary"], [("esummary", ("1000001", "1000002"))])

    def test_title_and_doi_mismatch(self):
        res = vc.verify(doc(item("a", pmid="1000001", title="A different paper on cats", doi="10.9999/other")),
                        FakeNet())
        msgs = " ".join(m for _, _, m in res)
        self.assertIn("title mismatch", msgs)
        self.assertIn("different records", msgs)

    def test_doi_head_without_redirects(self):
        net = FakeNet()
        res = vc.verify(doc(item("a", doi="10.9999/exists"), item("b", doi="10.9999/missing")), net)
        self.assertEqual([(lv, w) for lv, w, _ in res], [("error", "item b citation 1")])
        self.assertTrue(all(c[2] is False for c in net.calls if c[0] == "head"))

    def test_urls(self):
        res = vc.verify(doc(item("a", url="https://labels.example.org/ok"),
                            item("b", url="https://labels.example.org/blocked"),
                            item("c", url="https://labels.example.org/gone")), FakeNet())
        self.assertEqual([(lv, w) for lv, w, _ in res], [("warn", "item b citation 1"), ("error", "item c citation 1")])

    def test_check_quotes(self):
        good = item("a", pmid="1000001")
        page = item("b", url="https://labels.example.org/ok", quote="lower example-marker values by about 30%")
        wrong = item("c", url="https://labels.example.org/ok", quote="not on the page")
        res = vc.verify(doc(good, page, wrong), FakeNet(), check_quotes=True)
        self.assertEqual([(lv, w) for lv, w, _ in res], [("warn", "item c citation 1")])

    def test_angle_brackets_in_plain_text_quote(self):
        # regression: "<135 ... >12%" was stripped as an HTML tag, so the quote never matched
        class Abs(FakeNet):
            def abstract(self, pmid):
                return "Results: systolic <135 mmHg and HbA1c >12% were recorded. <b>Bold</b> text."
        q = item("a", pmid="1000001", quote="systolic <135 mmHg and HbA1c >12% were recorded")
        self.assertEqual(vc.verify(doc(q), Abs(), check_quotes=True), [])
        self.assertEqual(vc.norm("a <b>x</b> &lt;5 and >7"), "a x 5 and 7")
        self.assertIn("5", vc.norm("<135 ... >12%"))
        self.assertIn("135", vc.norm("<135 ... >12%"))

    def test_link_only_sources(self):
        ok = item("a", url="https://uroweb.org/guidelines/x", quote="", locator="Rec 3.1")
        quoted = item("b", url="https://www.nice.org.uk/guidance/ng1", locator="1.2.3")
        nolocator = item("c", url="https://uroweb.org/guidelines/x", quote="")
        res = vc.verify(doc(ok, quoted, nolocator), None)
        self.assertEqual([(lv, w) for lv, w, _ in res], [("error", "item b citation 1"), ("error", "item c citation 1")])
        self.assertTrue(vc.link_only("https://www.auanet.org/g"))
        self.assertFalse(vc.link_only("https://notauanet.org/g"))

    def test_network_failure_is_error(self):
        class Down(FakeNet):
            def esummary(self, pmids):
                raise OSError("offline")
        res = vc.verify(doc(item("a", pmid="1000001")), Down())
        self.assertEqual([lv for lv, _, _ in res], ["error"])


class Cli(unittest.TestCase):
    def run_cli(self, d, *flags):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(d, f)
        return subprocess.run([sys.executable, "-I", str(HERE / "verify_citations.py"), f.name, *flags],
                              capture_output=True, text=True)

    def test_exit_codes(self):
        self.assertEqual(self.run_cli(doc(item("a", pmid="1000001")), "--offline").returncode, 0)
        r = self.run_cli(doc(item("a", pmid="1000001", quote="")), "--offline", "--json")
        self.assertEqual(r.returncode, 1)
        self.assertEqual(json.loads(r.stdout)["errors"], 1)

    def test_bad_input(self):
        r = subprocess.run([sys.executable, "-I", str(HERE / "verify_citations.py"), "/nonexistent.json"],
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)


class Example(unittest.TestCase):
    def test_worked_example_passes_offline(self):
        ex = HERE.parents[1] / "docs" / "methods" / "examples" / "2026-10-27-crossref.json"
        self.assertEqual([r for r in vc.verify(json.loads(ex.read_text())) if r[0] == "error"], [])


if __name__ == "__main__":
    unittest.main()
