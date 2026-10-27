#!/usr/bin/env -S python3 -I
"""Citation verifier for a research cross-reference (docs/methods/research-crossref.md).

    python3 -I tools/research/verify_citations.py <crossref.json> [--offline] [--check-quotes] [--json]

Input: the JSON sidecar of a cross-reference (agent-tasks/saturn.research_crossref.output.schema.json).
Checks every citation on every item:
  - it carries an identifier (pmid, doi or url) and a verbatim quote (missing quote = error); for link-only
    hosts (LINK_ONLY_HOSTS) the reverse: a locator and no quote (a quote = error);
  - source tier and licence: a quoted citation (not link-only) carries `source_tier` and `license`; the licence must be
    on the allow-list (QUOTABLE_LICENSES), a `label` tier must be on a label host, and a link-only tier or host is
    never quoted. `reports_guideline` (id or URL of a link-only guideline) is allowed only on a secondary source
    tier (oa_article, bookshelf, abstract), and the item statement must say "secondary: reports" (a secondary
    statement is never presented as the guideline's own text);
  - phrasing: statements and questions carry no dose advice, no diagnosis, no "you should" (error);
  - online (default): each PMID resolves (NCBI E-utilities esummary; the stated title, if any, must match),
    each DOI resolves (HEAD https://doi.org/<doi>, redirects not followed: 3xx = ok, 404 = unresolved),
    each URL answers (HEAD; 403/405/429 = warning "blocked", not proof either way);
  - --check-quotes: the quote must appear in the PubMed abstract (PMID) or the fetched HTML/XML/JSON text (URL);
    not found = warning for the human reviewer (abstracts and pages are not the full text).
Exit 0 = no errors (warnings allowed), 1 = errors, 2 = bad input. Stdlib only; no PHI is sent anywhere: only
public identifiers (PMIDs, DOIs, URLs) leave the machine.

NCBI policy: <= 3 requests/s without a key, <= 10/s with one. Set NCBI_API_KEY, NCBI_TOOL and NCBI_EMAIL in the
environment (never in files); the script sleeps between calls to stay under the limit.
"""
import difflib, html, json, os, re, sys, time, urllib.error, urllib.parse, urllib.request

EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/"
UA = "saturn-verify-citations/1 (+https://github.com/)"
QUOTE_MAX = 400
TITLE_MIN_RATIO = 0.8

# Wording that a cross-reference must never contain in its own voice (statements, questions, summary).
BANNED = [
    (r"\b(start|stop|increas|decreas|reduc|rais|lower|doubl|halv|skip|switch|taper|adjust|titrat)\w*\b[^.?!]{0,40}"
     r"\b(dose|dosage|medicine|medication|tablet|pill|mg)\b", "dose or medicine-change advice"),
    (r"\b(dose|dosage|medicine|medication|tablet|pill)s?\b[^.?!]{0,30}\b(be|to)\s+(increas|decreas|reduc|rais|lower|"
     r"doubl|halv|stopp|chang|adjust|titrat|switch)\w*", "dose or medicine-change advice"),
    (r"\byou (should|must|need to|ought to)\b", "directive to the reader"),
    (r"\b(you|he|she|they|the patient) (has|have|suffers? from)\b[^.?!]{0,30}\b(disease|syndrome|cancer|failure|"
     r"disorder|infection)\b", "diagnosis in the agent's voice"),
    (r"\b(is|are) (caused|due to|because of)\b", "causal claim (write 'is associated with')"),
    (r"\b(safe|unsafe) to take\b", "safety verdict"),
]


class Net:
    """All network access, so tests can replace it."""

    def __init__(self):
        self.key = os.environ.get("NCBI_API_KEY", "")
        self.gap = 0.11 if self.key else 0.34
        self.last = 0.0

    def _ncbi_wait(self):
        dt = time.monotonic() - self.last
        if dt < self.gap:
            time.sleep(self.gap - dt)
        self.last = time.monotonic()

    def _ncbi_params(self, **kw):
        for k, env in (("api_key", "NCBI_API_KEY"), ("tool", "NCBI_TOOL"), ("email", "NCBI_EMAIL")):
            if os.environ.get(env):
                kw[k] = os.environ[env]
        return urllib.parse.urlencode(kw)

    def esummary(self, pmids):
        self._ncbi_wait()
        url = EUTILS + "esummary.fcgi?" + self._ncbi_params(db="pubmed", id=",".join(pmids), retmode="json")
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=30) as r:
            return json.load(r)

    def abstract(self, pmid):
        self._ncbi_wait()
        url = EUTILS + "efetch.fcgi?" + self._ncbi_params(db="pubmed", id=pmid, rettype="abstract", retmode="text")
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=30) as r:
            return r.read().decode("utf-8", "replace")

    def head(self, url, follow=True):
        """Return the HTTP status of a HEAD request (redirects not followed when follow=False)."""
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *a, **k):
                return None
        opener = urllib.request.build_opener(*([] if follow else [NoRedirect()]))
        try:
            with opener.open(urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA}), timeout=30) as r:
                return r.status
        except urllib.error.HTTPError as e:
            return e.code

    def get_text(self, url):
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=30) as r:
            ctype = r.headers.get("Content-Type", "")
            if not re.search(r"html|xml|json|text", ctype):
                return None
            return r.read(5_000_000).decode("utf-8", "replace")


# Guideline bodies whose terms forbid use of their text in AI tools (method, "Source priority"): cite and link only.
# A citation to one of these hosts must carry a locator (recommendation number) and must NOT carry a quote.
LINK_ONLY_HOSTS = ("escardio.org", "auanet.org", "uroweb.org", "nice.org.uk",
                   "diabetesjournals.org", "diabetes.org", "icmr.gov.in", "icmr.org.in", "endocrine.org")
# Source tiers (method, section 4). Quoted citations must name one and a licence that permits quoting.
TIERS = ("label", "guideline_open", "guideline_link_only", "oa_article", "bookshelf", "abstract")
SECONDARY_TIERS = ("oa_article", "bookshelf", "abstract")
LABEL_HOSTS = ("dailymed.nlm.nih.gov", "api.fda.gov", "open.fda.gov", "accessdata.fda.gov", "ema.europa.eu")
# Licences (normalised by norm_license) under which a short attributed verbatim quote is allowed.
QUOTABLE_LICENSES = {"public-domain", "cc0", "cc-by", "cc-by-sa", "cc-by-nc", "cc-by-nc-sa", "cc-by-nc-nd",
                     "cc-by-nd", "ahrq-unaltered", "ema-credit", "publisher-abstract"}
ABSTRACT_QUOTE_MAX = 250  # "short quote" for abstracts of copyrighted papers
SECONDARY_LABEL = "secondary: reports"
# Real markup only: a tag starts with a letter, "/", "!" or "?". Plain-text "<135" or ">12%" is left alone.
TAG = re.compile(r"</?[A-Za-z][^<>]*>|<[!?][^<>]*>")


def link_only(url):
    host = (urllib.parse.urlparse(url or "").hostname or "").lower()
    return any(host == h or host.endswith("." + h) for h in LINK_ONLY_HOSTS)


def host_in(url, hosts):
    host = (urllib.parse.urlparse(url or "").hostname or "").lower()
    return any(host == h or host.endswith("." + h) for h in hosts)


def norm_license(s):
    """'CC BY-NC-ND 4.0', 'cc by-nc-nd', 'CC-BY-NC-SA-3.0-IGO' -> 'cc-by-nc-nd' etc."""
    s = re.sub(r"[\s_]+", "-", (s or "").strip().lower())
    s = re.sub(r"-v?\d+(\.\d+)?(-igo)?$", "", s)
    return s


def check_tier(it, c, where, q, out):
    tier, lic = c.get("source_tier"), c.get("license")
    if tier is not None and tier not in TIERS:
        out.append(("error", where, f"unknown source_tier {tier!r}"))
    if c.get("reports_guideline"):
        if tier not in SECONDARY_TIERS:
            out.append(("error", where, "reports_guideline only on a secondary tier "
                                        f"({', '.join(SECONDARY_TIERS)})"))
        if SECONDARY_LABEL not in (it.get("statement") or "").lower():
            out.append(("error", where, f"reports_guideline: the statement must be labelled '{SECONDARY_LABEL} <guideline>'"))
    if tier == "guideline_link_only" and q:
        out.append(("error", where, "guideline_link_only tier: no quote allowed"))
    if not q or link_only(c.get("url")):
        return  # nothing quoted, or the link-only host rule already applied
    if tier is None:
        out.append(("error", where, "quoted citation needs source_tier"))
        return
    if tier == "label" and c.get("url") and not host_in(c["url"], LABEL_HOSTS):
        out.append(("error", where, "label tier: host is not a known label host"))
    if not lic:
        out.append(("error", where, "quoted citation needs license"))
    elif norm_license(lic) not in QUOTABLE_LICENSES:
        out.append(("error", where, f"license {lic!r} is not on the quotable allow-list"))
    if tier == "abstract" and len(q) > ABSTRACT_QUOTE_MAX:
        out.append(("error", where, f"abstract quote longer than {ABSTRACT_QUOTE_MAX} chars"))


def norm(s):
    s = html.unescape(TAG.sub(" ", s or ""))
    s = s.replace("‑", "-").replace("‐", "-").replace("–", "-").replace("—", "-")
    return re.sub(r"[^a-z0-9%.]+", " ", s.lower()).strip()


def phrasing(text, where, out):
    for pat, why in BANNED:
        m = re.search(pat, text or "", re.I)
        if m:
            out.append(("error", where, f"phrasing: {why}: '{m.group(0)}'"))


def verify(doc, net=None, check_quotes=False):
    """Return a list of (level, where, message); level is 'error' or 'warn'."""
    out = []
    items = doc.get("items")
    if not isinstance(items, list):
        return [("error", "$", "no items[] array")]
    phrasing(doc.get("summary", ""), "summary", out)
    for q in doc.get("questions", []):
        phrasing(q.get("text", ""), f"question {q.get('id', '?')}", out)
    cites = []  # (where, citation)
    for it in items:
        iid = it.get("id", "?")
        phrasing(it.get("statement", ""), f"item {iid}", out)
        cs = it.get("citations") or []
        if not cs:
            out.append(("error", f"item {iid}", "no citations"))
        for n, c in enumerate(cs):
            where = f"item {iid} citation {n + 1}"
            if not any(c.get(k) for k in ("pmid", "doi", "url")):
                out.append(("error", where, "no pmid, doi or url"))
            q = (c.get("quote") or "").strip()
            if link_only(c.get("url")):
                if q:
                    out.append(("error", where, "link-only source: no quote allowed (cite and link only)"))
                if not (c.get("locator") or "").strip():
                    out.append(("error", where, "link-only source: locator (recommendation number) required"))
            elif not q:
                out.append(("error", where, "missing quote"))
            elif len(q) > QUOTE_MAX:
                out.append(("error", where, f"quote longer than {QUOTE_MAX} chars"))
            check_tier(it, c, where, q, out)
            if c.get("pmid") and not re.fullmatch(r"[1-9][0-9]{0,8}", str(c["pmid"])):
                out.append(("error", where, f"malformed PMID {c['pmid']!r}"))
            if c.get("doi") and not re.fullmatch(r"10\.\d{4,9}/\S+", c["doi"]):
                out.append(("error", where, f"malformed DOI {c['doi']!r}"))
            if not c.get("accessed"):
                out.append(("warn", where, "no accessed date"))
            cites.append((where, c))
    if net is None:
        return out

    pm = sorted({str(c["pmid"]) for _, c in cites if c.get("pmid") and re.fullmatch(r"\d+", str(c["pmid"]))})
    summaries = {}
    for i in range(0, len(pm), 200):
        try:
            res = net.esummary(pm[i:i + 200]).get("result", {})
            for u in pm[i:i + 200]:
                summaries[u] = res.get(u, {"error": "absent from esummary result"})
        except Exception as e:  # network or JSON failure: cannot verify, which is an error
            for u in pm[i:i + 200]:
                summaries[u] = {"error": f"esummary failed: {e}"}
    for where, c in cites:
        p = str(c.get("pmid") or "")
        if p in summaries:
            s = summaries[p]
            if s.get("error"):
                out.append(("error", where, f"PMID {p} does not resolve ({s['error']})"))
            else:
                if c.get("title"):
                    r = difflib.SequenceMatcher(None, norm(c["title"]), norm(s.get("title", ""))).ratio()
                    if r < TITLE_MIN_RATIO:
                        out.append(("error", where, f"PMID {p} title mismatch ({r:.2f}): PubMed has "
                                                    f"'{s.get('title', '')[:120]}'"))
                if c.get("doi"):
                    ids = {a.get("value", "").lower() for a in s.get("articleids", []) if a.get("idtype") == "doi"}
                    if ids and c["doi"].lower() not in ids:
                        out.append(("error", where, f"PMID {p} and DOI {c['doi']} name different records"))
                if check_quotes and c.get("quote"):
                    try:
                        if norm(c["quote"]) not in norm(net.abstract(p)):
                            out.append(("warn", where, "quote not found in the PubMed abstract; human check"))
                    except Exception as e:
                        out.append(("warn", where, f"abstract fetch failed: {e}"))
        if c.get("doi") and not c.get("pmid"):
            try:
                st = net.head("https://doi.org/" + urllib.parse.quote(c["doi"], safe="/:;()"), follow=False)
            except Exception as e:
                st = f"failed: {e}"
            if st == 404:
                out.append(("error", where, f"DOI {c['doi']} does not resolve (404)"))
            elif not (isinstance(st, int) and 300 <= st < 400):
                out.append(("warn", where, f"DOI {c['doi']}: unexpected status {st}"))
        if c.get("url"):
            try:
                st = net.head(c["url"])
            except Exception as e:
                st = f"failed: {e}"
            if st in (403, 405, 429):
                out.append(("warn", where, f"URL blocked a HEAD check ({st}); human check"))
            elif not (isinstance(st, int) and st < 400):
                out.append(("error", where, f"URL does not resolve ({st}): {c['url']}"))
            elif check_quotes and c.get("quote") and not c.get("pmid") and not link_only(c["url"]):
                try:
                    text = net.get_text(c["url"])
                    if text is None:
                        out.append(("warn", where, "quote unchecked (not a text page, e.g. PDF); human check"))
                    elif norm(c["quote"]) not in norm(text):
                        out.append(("warn", where, "quote not found on the page; human check"))
                except Exception as e:
                    out.append(("warn", where, f"page fetch failed: {e}"))
    return out


def main(argv):
    args = [a for a in argv if not a.startswith("--")]
    if len(args) != 1:
        print(__doc__, file=sys.stderr)
        return 2
    try:
        with open(args[0], encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, ValueError) as e:
        print(f"cannot read {args[0]}: {e}", file=sys.stderr)
        return 2
    res = verify(doc, None if "--offline" in argv else Net(), "--check-quotes" in argv)
    errors = sum(1 for lv, _, _ in res if lv == "error")
    if "--json" in argv:
        print(json.dumps({"errors": errors, "warnings": len(res) - errors,
                          "findings": [{"level": a, "where": b, "message": c} for a, b, c in res]}, indent=2))
    else:
        for lv, where, msg in res:
            print(f"{lv.upper():5} {where}: {msg}")
        print(f"{errors} error(s), {len(res) - errors} warning(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
