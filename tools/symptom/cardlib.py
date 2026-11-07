"""Symptom context cards (design: docs/design/symptom-context-card.md). Pure stdlib; no network, no AI.

Builds one card dict per source that carries a new symptom (an observation with category symptom, or a voice-note
statement with detail.category symptom), from the KB (kb.sqlite through tools/kb/gen-views' KB helper), the label
cache (<records>/labels/), the curated maps (sites.json, rules.json; records overrides in config/symptom-card.json)
and the family context page (tier wording). tools/site/build renders the cards. Record and flag only: a card states
what was written, what happened alongside, what labels mention and which rule-based warning signs apply; it never
names a cause and never suggests a medicine change.
"""
import datetime, importlib.machinery, importlib.util, json, pathlib, re, sys

HERE = pathlib.Path(__file__).resolve().parent
PRODUCT = HERE.parents[1]
sys.path.insert(0, str(PRODUCT / "tools" / "crossref"))
import home_series as hs  # noqa: E402


def _script(name, path):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


_inference = _script("inference_tool", PRODUCT / "tools" / "inference" / "inference")
_crossref = None  # loaded on first use (home-reading band parameters)

CARD_DAYS = 14         # a symptom is "new" for this many days (the overview's "What changed" window)
CHANGE_DAYS = 14       # medicine starts, stops and changes shown alongside
MAX_QUESTIONS = 5
QUOTE_MAX = 160
QUOTES_PER_DRUG = 3
TIERS = ("A", "B", "C")
SECTIONS = (("boxed_warning", "Boxed warning"), ("warnings_and_cautions", "Warnings and precautions"),
            ("warnings", "Warnings"), ("precautions", "Precautions"), ("adverse_reactions", "Adverse reactions"))
DEFAULT_TIERS = {"A": ("emergency", "Go to the nearest emergency hospital now."),
                 "B": ("same-week doctor", "See a doctor within the week (realistically 2 to 4 days)."),
                 "C": ("next planned visit or tele-consult", "Add it to the list for the next planned visit or a tele-consult.")}
MT_PREFIX = re.compile(r"^voice \((machine|listened) transcript\):\s*")

# ---- word lists (section 11). The card's own voice only; text as written (what was said, facts) is quoted, not checked.
CAUSAL = [re.compile(x, re.I) for x in (r"\bbecause of\b", r"\bdue to\b", r"\bside[- ]effects? of\b", r"\breaction to\b",
                                         r"\btriggered by\b", r"\bresult of\b")]
FAMILY_WORDS = [re.compile(x, re.I) for x in (r"\brush\w*", r"\bimmediately\b", r"\basap\b", r"\burgent\w*", r"\bdanger\w*",
                                               r"\bserious\w*", r"\bfatal\b", r"\bdie\b", r"\bdeath\b", r"%", r"\bprobab\w*",
                                               r"\blikely\b", r"\bdifferential\b", r"\bagent-inferred\b")]


class CardError(Exception):
    pass


def check_words(text, family=False):
    """-> list of offending phrases (empty = passes). All views: the inference word list (verdicts, reassurance,
    medicine instructions) plus causal wording; the family view also bans alarming and probability words."""
    hits = []
    for rx in list(_inference.WORDS) + CAUSAL + (FAMILY_WORDS if family else []):
        m = rx.search(text or "")
        if m:
            hits.append(m.group(0))
    return hits


# ------------------------------------------------------------------------------------------------------------ config
def _read_json(path, what):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise CardError(f"{path}: {what}: {e}")


def _merge(base, extra, key):
    out = {x["id"]: x for x in base}
    for x in extra or []:
        if not isinstance(x, dict) or not x.get("id"):
            raise CardError(f"config/symptom-card.json: {key}: every entry needs an id")
        out[x["id"]] = x
    return list(out.values())


def load_config(root=None):
    """Product defaults plus the records override (<root>/config/symptom-card.json: sites, rules, modifiers replace or
    add by id; disable = rule ids). Validated; a bad file raises CardError naming the key (fail closed)."""
    sites = _read_json(HERE / "sites.json", "sites")
    rules = _read_json(HERE / "rules.json", "rules")
    cfg = {"version": f"{sites['version']}/{rules['version']}", "status": rules["status"], "sites": sites["sites"],
           "rules": rules["rules"], "modifiers": rules["modifiers"], "sources": dict(rules["sources"]), "override": None}
    ov = pathlib.Path(root) / "config" / "symptom-card.json" if root else None
    if ov and ov.is_file():
        o = _read_json(ov, "override")
        unknown = set(o) - {"sites", "rules", "modifiers", "sources", "disable", "status", "_doc"}
        if unknown:
            raise CardError(f"{ov}: unknown key {sorted(unknown)[0]!r}")
        cfg["sites"] = _merge(cfg["sites"], o.get("sites"), "sites")
        cfg["rules"] = [r for r in _merge(cfg["rules"], o.get("rules"), "rules") if r["id"] not in set(o.get("disable") or [])]
        cfg["modifiers"] = _merge(cfg["modifiers"], o.get("modifiers"), "modifiers")
        cfg["sources"].update(o.get("sources") or {})
        if o.get("status"):
            cfg["status"] = o["status"]
        cfg["override"] = "config/symptom-card.json"
    validate(cfg)
    cfg["site_by_id"] = {s["id"]: s for s in cfg["sites"]}
    return cfg


def validate(cfg):
    def need(cond, msg):
        if not cond:
            raise CardError(msg)
    need(cfg["status"] in ("pending_clinician_signoff", "signed_off"), f"status: {cfg['status']!r}")
    site_ids = [s.get("id") for s in cfg["sites"]]
    need(len(site_ids) == len(set(site_ids)), "sites: duplicate id")
    for s in cfg["sites"]:
        w = f"sites.{s.get('id')}"
        for k in ("triggers", "label_terms", "questions"):
            need(isinstance(s.get(k), list) and all(isinstance(x, str) and x.strip() for x in s[k]), f"{w}.{k}: list of text")
        need(isinstance(s.get("name"), str) and s["name"], f"{w}.name")
        need(1 <= len(s["questions"]) <= MAX_QUESTIONS, f"{w}.questions: 1 to {MAX_QUESTIONS}")
        c = s.get("closing") or {}
        need(isinstance(c.get("max_days"), int) and c["max_days"] > 0 and isinstance(c.get("better_days"), str)
             and c.get("tier") in TIERS, f"{w}.closing: better_days text, max_days > 0, tier A/B/C")
        need(isinstance(s.get("before_using", ""), str), f"{w}.before_using: text")
        for text in s["questions"] + [s.get("before_using") or ""]:
            need(not check_words(text, family=True), f"{w}: word list: {text!r}")
    mod_ids = {m.get("id") for m in cfg["modifiers"]}
    for m in cfg["modifiers"]:
        w = f"modifiers.{m.get('id')}"
        match = m.get("match") or {}
        need(isinstance(m.get("name"), str) and m["name"], f"{w}.name")
        need(set(match) <= {"current_generic_any", "text_any", "kinds", "within_days"} and
             bool(match.get("current_generic_any") or match.get("text_any")), f"{w}.match: current_generic_any or text_any")
        if match.get("text_any"):
            need(isinstance(match.get("kinds"), list) and match["kinds"], f"{w}.match.kinds")
    rule_ids = [r.get("id") for r in cfg["rules"]]
    need(len(rule_ids) == len(set(rule_ids)), "rules: duplicate id")
    for r in cfg["rules"]:
        w = f"rules.{r.get('id')}"
        need(re.fullmatch(r"[a-z0-9][a-z0-9-]*", r.get("id") or ""), f"{w}: id is a lower-case slug")
        need(r.get("tier") in TIERS, f"{w}.tier: A, B or C")
        need(isinstance(r.get("sites"), list) and r["sites"] and set(r["sites"]) <= set(site_ids), f"{w}.sites: known site ids")
        need(isinstance(r.get("when"), list) and set(r["when"]) <= mod_ids, f"{w}.when: known modifier ids")
        need(r.get("source") in cfg["sources"], f"{w}.source: a key of sources")
        for k, fam in (("owner", False), ("family", True)):
            need(isinstance(r.get(k), str) and r[k].strip(), f"{w}.{k}: text")
            need(not check_words(r[k], family=fam), f"{w}.{k}: word list: {check_words(r[k], family=fam)}")
    for k, s in cfg["sources"].items():
        need(isinstance(s, dict) and s.get("publisher") and s.get("title") and s.get("checked"), f"sources.{k}: publisher, title, checked")


# ------------------------------------------------------------------------------------------------------------ helpers
def j(v):
    return json.loads(v) if v else {}


def ddmon(at):
    try:
        return datetime.date.fromisoformat(str(at)[:10]).strftime("%d-%b-%Y")
    except ValueError:
        return str(at or "")


def word_start(term):
    return re.compile(r"(?<![\w])" + re.escape(term.lower()), re.I)


def word(term):
    return re.compile(r"(?<![\w])" + re.escape(term.lower()) + r"(?![\w])", re.I)


def transcript_text(label):
    """A statement label -> (summary, negated)."""
    t = MT_PREFIX.sub("", label or "")
    return (t[5:], True) if t.startswith("NOT: ") else (t, False)


def withhold_numbers(text):
    return re.sub(r"\d+(?:[.,/:]\d+)*", "(number)", text)


def classify(text, cfg):
    """Body-site ids matched in the file's order; 'general' only when nothing else matches (it is also the fallback)."""
    t = (text or "").lower()
    hit = [s["id"] for s in cfg["sites"] if s["id"] != "general" and any(word_start(x).search(t) for x in s["triggers"])]
    return hit or (["general"] if "general" in cfg["site_by_id"] else [])


NEG_AFTER = re.compile(r"^\s*\(\s*-\s*\)")
NEG_BEFORE = re.compile(r"\b(no|not|nil|without|h/o no)\s+$", re.I)


def text_mentions(text, terms):
    """True when a term occurs at a word boundary and is not written as negative ('CVA (-)', 'no stroke')."""
    t = text or ""
    for term in terms:
        for m in word(term).finditer(t):
            if NEG_AFTER.match(t[m.end():]) or NEG_BEFORE.search(t[max(0, m.start() - 12):m.start()]):
                continue
            return True
    return False


def generic_names(kb, drug_id, generic):
    names = set()
    for g in re.split(r"\s*(?:/|\+|,|\band\b)\s*", (generic or "").lower()):
        if g.strip():
            names.add(g.strip())
    ref = kb.refs.get(drug_id) if drug_id else None
    for i in (j(ref["data"]).get("ingredients") or []) if ref else []:
        n = i.get("name") if isinstance(i, dict) else i
        if isinstance(n, str) and n.strip():
            names.add(n.strip().lower())
    return names


def current_meds(kb, ns):
    return [r for r in kb.q("SELECT * FROM v_meds_current WHERE ns = ? ORDER BY drug", ns)
            if r["display_status"] not in ("stopped", "not-in-current-list")]


def person_modifiers(kb, ns, today, cfg):
    """-> [(modifier, evidence id)] that hold for this person now (rules.json modifiers, KB only)."""
    out = []
    meds = current_meds(kb, ns)
    for m in cfg["modifiers"]:
        match, ev = m["match"], None
        if match.get("current_generic_any"):
            want = {g.lower() for g in match["current_generic_any"]}
            for r in meds:
                if generic_names(kb, r["drug"] if r["drug"].startswith("ref:") else None, r["generic"]) & want:
                    ev = r["id"]; break
        if ev is None and match.get("text_any"):
            since = (today - datetime.timedelta(days=match["within_days"])).isoformat() if match.get("within_days") else ""
            kinds = match["kinds"]
            for f in kb.q(f"SELECT id, at, data FROM fact WHERE ns = ? AND status = 'active' AND kind IN ({','.join('?' * len(kinds))}) "
                          "AND substr(at, 1, 10) >= ? AND substr(at, 1, 10) <= ? ORDER BY at DESC, id", ns, *kinds, since, today.isoformat()):
                d = j(f["data"])
                text = " ".join(str(d.get(k) or "") for k in ("text_as_written", "label", "value_text", "name_raw"))
                if text_mentions(text, match["text_any"]):
                    ev = f["id"]; break
        if ev:
            out.append((m, ev))
    return out


def tier_text(root):
    """{tier: (label, path text)} from docs/health/family/context.md ('- **Tier A, label (...):** text'); defaults
    otherwise. Tier A keeps the first quoted sentence (the realistic path); B and C keep the first sentence."""
    out = dict(DEFAULT_TIERS)
    page = pathlib.Path(root) / "docs" / "health" / "family" / "context.md" if root else None
    if not page or not page.is_file():
        return out
    lines = page.read_text(encoding="utf-8").splitlines()
    for i, line in enumerate(lines):
        m = re.match(r"^\s*-\s+\*\*Tier ([ABC]),\s*(.+?):\*\*\s*(.*)$", line)
        if not m:
            continue
        tier, label, text = m.group(1), m.group(2), m.group(3)
        for nxt in lines[i + 1:]:  # wrapped bullet continuation lines
            if not nxt.startswith("     ") or re.match(r"^\s*-\s", nxt):
                break
            text += " " + nxt.strip()
        label = re.sub(r"\s*\(.*\)\s*$", "", label).strip()
        text = re.sub(r"\*\*|`", "", text).strip()
        q = re.search(r"[\"“]([^\"”]+)[\"”]", text) if tier == "A" else None
        path = q.group(1).strip() if q else re.split(r"(?<=[.;])\s", text, maxsplit=1)[0].strip()
        path = path[:1].upper() + path[1:]
        out[tier] = (label, path.rstrip(";") if path.endswith(";") else path)
    return out


# ------------------------------------------------------------------------------------------------------------ labels
def load_label(root, drug_id):
    if not root or not drug_id or not drug_id.startswith("ref:drug:"):
        return None
    p = pathlib.Path(root) / "labels" / (drug_id.split(":", 2)[2] + ".json")
    if not p.is_file():
        return None
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
    except ValueError:
        raise CardError(f"{p}: not JSON (refetch with tools/symptom/labels fetch --force)")
    if d.get("schema") != "label-cache/1":
        raise CardError(f"{p}: schema must be label-cache/1")
    return d


def quote_window(text, m):
    """The clause around a match (sentence or semicolon bounded), at most QUOTE_MAX characters."""
    starts = [text.rfind(c, 0, m.start()) for c in ".;:•\n"]
    a = max(starts) + 1
    ends = [x for x in (text.find(c, m.end()) for c in ".;•\n") if x != -1]
    b = min(ends) if ends else len(text)
    q = " ".join(text[a:b].split())
    if len(q) <= QUOTE_MAX:
        return q
    pos = q.lower().find(m.group(0).lower())
    lo = max(0, pos - 60)
    return ("…" if lo else "") + q[lo:lo + QUOTE_MAX - 2].strip() + "…"


def label_quotes(entry, terms):
    """[(quote, section label, term)] for one cached label, at most QUOTES_PER_DRUG, distinct terms first."""
    found, seen_terms, seen_q = [], set(), set()
    pats = [(t, word(t)) for t in terms]
    for key, title in SECTIONS:
        v = (entry.get("sections") or {}).get(key) or ""
        text = " ".join(v) if isinstance(v, list) else str(v)
        if not text.strip():
            continue
        for term, rx in pats:
            if term in seen_terms:
                continue
            m = rx.search(text)
            if not m:
                continue
            q = quote_window(text, m)
            if check_words(q):  # label wording may read as an instruction or a cause: quote the term alone
                q = m.group(0)
            if any(q.lower() in x or x in q.lower() for x in seen_q):  # one clause, quoted once
                seen_terms.add(term)
                continue
            seen_terms.add(term); seen_q.add(q.lower())
            found.append((q, title, term))
            if len(found) >= QUOTES_PER_DRUG:
                return found
    return found


def label_rows(kb, root, ns, day, terms):
    """Section 4: one row per current medicine (and per medicine stopped within CHANGE_DAYS)."""
    rows = []
    meds = {r["drug"]: r for r in current_meds(kb, ns)}
    since = (day - datetime.timedelta(days=CHANGE_DAYS)).isoformat()
    for r in kb.q("SELECT * FROM v_meds_current WHERE ns = ? AND display_status = 'stopped' AND substr(at, 1, 10) >= ?", ns, since):
        meds.setdefault(r["drug"], r)
    for key in sorted(meds, key=lambda k: (meds[k]["brand"] or kb.name(k) or k).lower()):
        r = meds[key]
        drug_id = key if key.startswith("ref:drug:") else None
        name = kb.name(drug_id) if drug_id else (r["brand"] or key.replace("brand:", ""))
        row = {"drug": name, "drug_id": drug_id, "generic": r["generic"], "status": r["display_status"], "parts": []}
        if not drug_id:
            row["state"] = "no generic recorded"
        else:
            cache = load_label(root, drug_id)
            if cache is None:
                row["state"] = "label not fetched yet"
            elif not cache.get("queried"):
                row["state"] = "no generic recorded"
            else:
                row["fetched_at"] = cache.get("fetched_at")
                states = []
                for e in cache.get("labels") or []:
                    if e.get("status") != "found":
                        row["parts"].append({"query": e.get("query"), "state": "no label available", "quotes": []})
                        states.append("no label available")
                        continue
                    qs = [{"text": q, "section": sec, "set_id": e["set_id"], "effective": e.get("effective_time")}
                          for q, sec, _ in label_quotes(e, terms)]
                    st = "label mentions" if qs else "no label mention"
                    row["parts"].append({"query": e.get("query"), "state": st, "quotes": qs, "set_id": e["set_id"],
                                         "effective": e.get("effective_time"), "title": e.get("title")})
                    states.append(st)
                row["state"] = ("label mentions" if "label mentions" in states else "no label mention" if "no label mention" in states
                                else "no label available")
        rows.append(row)
    return rows


# ------------------------------------------------------------------------------------------------------------ cards
TRIGGER_SQL = ("SELECT * FROM fact WHERE ns = ? AND status = 'active' AND substr(at, 1, 10) >= ? AND substr(at, 1, 10) <= ? "
               "AND ((kind = 'observation' AND json_extract(data, '$.category') = 'symptom') OR "
               "(kind = 'event' AND json_extract(data, '$.detail.category') = 'symptom')) ORDER BY at, id")


def slug(source_id):
    return re.sub(r"[^A-Za-z0-9._-]+", "-", source_id.split(":", 2)[-1]).strip("-")[:120] or "card"


def said_item(kb, f, unchecked):
    d, tags = j(f["data"]), j(f["tags"]) or []
    if f["kind"] == "event":
        text, neg = transcript_text(d.get("label"))
        kind = "statement"
    else:
        text = " · ".join(x for x in (d.get("value_text"), d.get("body_site")) if x)
        neg, kind = "negated" in tags, "symptom"
    unc = unchecked(f["id"])
    return {"fid": f["id"], "kind": kind, "at": f["at"], "text": withhold_numbers(text) if unc else text, "raw": text,
            "unchecked": unc, "negated": neg, "low_confidence": "low-confidence" in tags,
            "listened": "listened-transcript" in tags, "quote": f["quote"]}


class Cards:
    """Builds the card dicts of one records repo. kb: tools/kb/gen-views KB; unchecked(fid) -> True for a phrase from a
    voice note nobody has heard (the site's rule); infs(ns) -> active inference rows (or None)."""

    def __init__(self, kb, root, today, unchecked=lambda fid: False, infs=lambda ns: None, cfg=None):
        self.kb, self.root, self.today = kb, pathlib.Path(root) if root else None, today
        self.unchecked, self.infs = unchecked, infs
        self.cfg = cfg or load_config(self.root)
        self.tiers = tier_text(self.root)
        self._home = {}

    # ---- triggers
    def for_person(self, ns):
        lo = (self.today - datetime.timedelta(days=CARD_DAYS - 1)).isoformat()
        groups = {}
        for f in self.kb.q(TRIGGER_SQL, ns, lo, self.today.isoformat()):
            tags = j(f["tags"]) or []
            if "shadow" in tags:
                continue
            groups.setdefault(f["source_id"], []).append(f)
        cards = []
        for sid, fs in groups.items():
            trig = [f for f in fs if not (f["kind"] == "event" and "negated" in (j(f["tags"]) or []))]
            if trig:
                cards.append(self.card(ns, sid, trig, [f for f in fs if f not in trig]))
        cards.sort(key=lambda c: (c["at"], c["id"]), reverse=True)
        return cards

    def card(self, ns, sid, trig, negated):
        kb, cfg = self.kb, self.cfg
        said = [said_item(kb, f, self.unchecked) for f in trig] + [dict(said_item(kb, f, self.unchecked), negated=True) for f in negated]
        text = " ".join(" ".join(str(x or "") for x in (s["raw"], s["quote"])) for s in said if not s["negated"])
        sites = [cfg["site_by_id"][s] for s in classify(text, cfg)]
        day = datetime.date.fromisoformat(trig[0]["at"][:10])
        src = kb.sources.get(sid)
        status = ("machine transcript, not yet listened" if any(s["unchecked"] for s in said)
                  else "listened transcript" if any(s["listened"] for s in said)
                  else "machine transcript" if any("machine-transcript" in (j(f["tags"]) or []) for f in trig) else "")
        mods = person_modifiers(kb, ns, self.today, cfg)
        mod_ids = {m["id"] for m, _ in mods}
        site_ids = [s["id"] for s in sites]
        warn = [r for r in cfg["rules"] if set(r["sites"]) & set(site_ids) and set(r["when"]) <= mod_ids]
        warn.sort(key=lambda r: (r["tier"], not r["when"], r["id"]))
        terms = list(dict.fromkeys(t for s in sites for t in s["label_terms"]))
        trig_ids = {f["id"] for f in trig}
        return {
            "id": slug(sid), "ns": ns, "source_id": sid, "source_kind": src["kind"] if src else "", "at": trig[0]["at"],
            "day": day, "days_since": (self.today - day).days, "said": said, "listener": status,
            "sites": [{"id": s["id"], "name": s["name"]} for s in sites],
            "alongside": self.alongside(ns, day, trig_ids), "readings": self.readings(ns, day),
            "meds": self.med_changes(ns, day), "labels": label_rows(kb, self.root, ns, day, terms), "terms": terms,
            "modifiers": [{"id": m["id"], "name": m["name"], "evidence": ev} for m, ev in mods],
            "warnings": [{"id": r["id"], "tier": r["tier"], "owner": r["owner"], "family": r["family"],
                          "specific": bool(r["when"]), "source": cfg["sources"][r["source"]]} for r in warn],
            "tiers": {t: self.tiers[t] for t in TIERS},
            "questions": self.questions(sites), "closing": self.closing(sites, day),
            "inferred": self.inferred(ns, trig_ids | {sid}),
            "rules_status": cfg["status"], "rules_version": cfg["version"],
        }

    # ---- section 2
    def alongside(self, ns, day, trig_ids):
        kb = self.kb
        d0, d1 = (day - datetime.timedelta(days=1)).isoformat(), day.isoformat()
        home_ids = {r["id"] for r in self.home(ns)["readings"]}
        rows = []
        for f in kb.q("SELECT * FROM fact WHERE ns = ? AND status = 'active' AND kind != 'medication' AND substr(at, 1, 10) BETWEEN ? AND ? "
                      "ORDER BY at, id", ns, d0, d1):
            tags, d = j(f["tags"]) or [], j(f["data"])
            if f["id"] in trig_ids or f["id"] in home_ids or "fitness" in tags or "shadow" in tags:
                continue
            if d.get("type") == "context" and "low-confidence" in tags:
                continue
            rows.append(f)
        by_src = {}
        for f in rows:
            by_src.setdefault(f["source_id"], []).append(f)
        out = []
        for sid, fs in by_src.items():
            s = kb.sources.get(sid)
            if len(fs) > 3:
                kind = KIND_WORDS.get(s["kind"], s["kind"]) if s else "source"
                out.append({"at": fs[0]["at"], "text": f"{kind}: {len(fs)} items", "fid": fs[0]["id"],
                            "unchecked": False, "summary": True, "said": False})
                continue
            for f in fs:
                d = j(f["data"])
                said = False
                if f["kind"] == "event" and MT_PREFIX.match(d.get("label") or ""):
                    text, neg = transcript_text(d["label"])
                    text, said = ("said as a negative: " if neg else "") + text, True
                elif f["kind"] == "event" and d.get("type") == "context":
                    text = f"{(d.get('category') or 'context').replace('_', ' ')}: {d.get('summary') or ''}"
                elif f["kind"] == "event":
                    text = d.get("label") or (d.get("type") or "event").replace("_", " ")
                elif f["kind"] == "condition":
                    text = d.get("text_as_written") or ""
                else:
                    comp = d.get("components") or {}
                    val = (f"{comp.get('systolic')}/{comp.get('diastolic')}" if isinstance(comp, dict) and "systolic" in comp
                           else d.get("value_num") if d.get("value_num") is not None else d.get("value_text") or "")
                    text = f"{kb.name(d.get('code')) if d.get('code') else 'observation'}: {val} {d.get('unit') or ''}".strip()
                unc = self.unchecked(f["id"])
                out.append({"at": f["at"], "text": withhold_numbers(text) if unc else text, "fid": f["id"], "unchecked": unc,
                            "summary": False, "said": said})
        out.sort(key=lambda x: (x["at"], x["fid"]))
        return out

    def home(self, ns):
        if ns not in self._home:
            gvcfg = {}
            p = self.root / "data" / "meta" / "gen-views.json" if self.root else None
            if p and p.is_file():
                gvcfg = _read_json(p, "gen-views")
            hcfg = hs.config(gvcfg)
            readings = hs.home_readings(self.kb, hcfg, ns)
            for r in readings:
                if self.unchecked(r["id"]):  # a number said in a voice note nobody heard is not a reading
                    r["used"] = False
            kept, _ = hs.collapse(readings)
            self._home[ns] = {"readings": readings, "daily": hs.daily(kept, hs.pref_session(hcfg, ns))}
        return self._home[ns]

    def band_params(self):
        global _crossref
        if _crossref is None:
            _crossref = _script("crossref_tool", PRODUCT / "tools" / "crossref" / "crossref")
        try:
            checks = _crossref.load_checks(self.root, seed=False) if self.root else {}
        except _crossref.CrossrefError:
            checks = {}
        if not checks:
            checks = {c["id"]: c for c in (json.loads(x) for x in (PRODUCT / "tools" / "crossref" / "default-checks.ndjson")
                                           .read_text(encoding="utf-8").splitlines() if x.strip())}
        return {c["params"].get("series"): dict(_crossref.BS_DEFAULTS, **c["params"]) for c in checks.values()
                if c["operator"] == "baseline_shift" and c["status"] == "active"}

    def readings(self, ns, day):
        """Home readings of the day and the day before against this person's own usual band (the profile's method)."""
        daily = self.home(ns)["daily"]
        params = self.band_params()
        out = []
        for s in ("sbp", "dbp", "pulse", "weight"):
            days = daily.get(s) or {}
            for dd in ((day - datetime.timedelta(days=1)).isoformat(), day.isoformat()):
                if dd not in days:
                    continue
                v = days[dd]["value"]
                p = params.get(s) or dict((_crossref.BS_DEFAULTS if _crossref else {}), min_spread=0)
                past = {d: x for d, x in days.items() if d < dd}
                band = hs.baseline(past, datetime.date.fromisoformat(dd), p) if past else {"status": "warming-up", "n": 0, "need": p.get("min_baseline_days", 7)}
                w28 = [x["value"] for d, x in days.items() if (datetime.date.fromisoformat(dd) - datetime.timedelta(days=27)).isoformat() <= d <= dd]
                if band["status"] == "ok":
                    pos = hs.position(v, band)
                    words = (f"{'inside' if pos == 'within' else pos} the usual range {r1(band['lo'])}-{r1(band['hi'])} "
                             f"(median {r1(band['median'])}, {band['n']} days)")
                else:
                    words = (f"usual range not set yet ({band['n']} of {band['need']} days); last 28 days "
                             f"{r1(min(w28))}-{r1(max(w28))}")
                out.append({"series": s, "day": dd, "value": r1(v), "unit": hs.UNIT[s], "words": words, "n": days[dd]["n"]})
        return out

    # ---- section 3
    def med_changes(self, ns, day):
        kb = self.kb
        lo = (day - datetime.timedelta(days=CHANGE_DAYS)).isoformat()
        first, prev, changes = {}, {}, []
        for f in kb.q("SELECT id, at, data FROM fact WHERE ns = ? AND kind = 'medication' AND status = 'active' AND substr(at, 1, 10) <= ? "
                      "ORDER BY at, created_at, id", ns, day.isoformat()):
            d = j(f["data"])
            key = d.get("drug_id") or "brand:" + (d.get("brand") or "").lower()
            name = kb.name(d["drug_id"]) if d.get("drug_id") else d.get("brand")
            first.setdefault(key, f["at"][:10])
            p, st = prev.get(key), d.get("status")
            what = None
            if p is None or (p["status"] == "stopped" and st != "stopped"):
                what = "first recorded" if p is None else "restarted"
            elif st == "stopped" and p["status"] != "stopped":
                what = "stopped"
            elif st != "stopped":
                diff = [f"{k.replace('_raw', '')} {p.get(k)} → {d.get(k)}" for k in ("strength", "schedule_raw")
                        if p.get(k) and d.get(k) and dose_key(k, p[k]) != dose_key(k, d[k])]
                if diff:
                    what = "changed: " + "; ".join(diff)
            if what and f["at"][:10] >= lo:
                changes.append({"drug": name, "what": what, "at": f["at"][:10], "fid": f["id"],
                                "days_before": (day - datetime.date.fromisoformat(f["at"][:10])).days})
            prev[key] = d
        recent = {c["drug"] for c in changes}
        long = [{"drug": kb.name(r["drug"]) if r["drug"].startswith("ref:") else (r["brand"] or r["drug"]),
                 "since": first.get(r["drug"] if r["drug"].startswith("ref:") else "brand:" + (r["brand"] or "").lower()),
                 "status": r["display_status"]} for r in current_meds(kb, ns)]
        long = [x for x in long if x["drug"] not in recent and x["since"] and x["since"] < lo]
        return {"changes": changes, "long": sorted(long, key=lambda x: x["drug"].lower())}

    # ---- sections 6, 7, inferred
    def questions(self, sites):
        out, seen = [], set()
        pools = [list(s["questions"]) for s in sites]
        while len(out) < MAX_QUESTIONS and any(pools):
            for pool in pools:
                while pool:
                    q = pool.pop(0)
                    if q.lower() not in seen:
                        seen.add(q.lower()); out.append(q); break
                if len(out) >= MAX_QUESTIONS:
                    break
        return out

    def closing(self, sites, day):
        strict = min(sites, key=lambda s: (s["closing"]["max_days"], TIERS.index(s["closing"]["tier"])))
        tier = min((s["closing"]["tier"] for s in sites), key=TIERS.index)
        return {"better_days": strict["closing"]["better_days"], "max_days": strict["closing"]["max_days"], "tier": tier,
                "review_on": (day + datetime.timedelta(days=strict["closing"]["max_days"])).isoformat(),
                "before_using": list(dict.fromkeys(s["before_using"] for s in sites if s.get("before_using")))}

    def inferred(self, ns, ids):
        for r in self.infs(ns) or []:
            if set(r.get("evidence_for") or []) & ids:
                return {"id": r["id"], "statement": r["statement"], "bucket": r.get("bucket"), "kind": r.get("kind")}
        return None


def dose_key(field, text):
    """Comparable form of a strength or schedule as written: the numbers of a strength ('10' = '10 mg'); a schedule's
    m-n-e pattern when written ('0-0-1 (8 pm), per Rx' = '0-0-1'), else the words without spacing and notes."""
    t = str(text).lower()
    if field == "strength":
        return tuple(re.findall(r"\d+(?:\.\d+)?", t)) or t.strip()
    m = re.search(r"\b\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?\b", t)
    return re.sub(r"\s", "", m.group(0)) if m else re.sub(r"[^a-z0-9]", "", t.split(",")[0])


KIND_WORDS = {"telegram_msg": "Telegram messages", "voice": "voice notes", "chat": "family chat", "rx": "prescription",
              "lab": "lab report", "photo": "photos"}


def r1(x):
    x = round(float(x), 1)
    return f"{x:g}"


def dm_text(card, display):
    """The ready DM (owner only): what was said (numbers withheld when unchecked), date, numbered questions."""
    said = "; ".join(s["text"] for s in card["said"] if not s["negated"])[:200]
    lines = [f"Questions for {display}: {said} ({ddmon(card['at'])})"]
    lines += [f"{i}. {q}" for i, q in enumerate(card["questions"], 1)]
    lines.append("Facts as written; not advice; doctors decide.")
    text = "\n".join(lines)
    return text[:1200]
