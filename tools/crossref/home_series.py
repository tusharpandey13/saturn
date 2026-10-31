"""Home-series signals for the running health profile, iteration 1 (docs/design/health-profile.md sections 3.1-3.3).

v_home_daily: home readings only (bp, pulse, weight), session-tagged by IST clock time, duplicates collapsed with
every collapse listed, one value per series and day. baseline(): the median/MAD band used by the crossref
baseline_shift operator and the profile page. Deterministic, stdlib only, no network. Statistics, never facts.
"""
import datetime, json, re, statistics

SERIES = ("sbp", "dbp", "pp", "pulse", "weight")
SERIES_CODE = {"sbp": "bp", "dbp": "bp", "pp": "bp", "pulse": "pulse", "weight": "weight"}
UNIT = {"sbp": "mmHg", "dbp": "mmHg", "pp": "mmHg", "pulse": "/min", "weight": "kg"}
DEFAULTS = {
    "persons": None,  # null = every namespace with at least one home reading
    "series": ["bp", "pulse", "weight"],
    "home_source_kinds": ["telegram_msg", "chat"],
    "preferred_session": "morning",  # or "afternoon" / "evening" / "any" (any = no mixed-session marking)
    # IST windows [start, end) in HH:MM; evening wraps past midnight
    "sessions": {"morning": ["04:00", "12:00"], "afternoon": ["12:00", "17:00"], "evening": ["17:00", "04:00"]},
    "problem_signals": {},  # {ns: {condition fact id: [series]}} (owner-set, design D3)
    "links": {},  # {ns: [records-relative paths of analysis notes]} (owner-tagged)
}
# Not one home measurement, or not settled: device averages / memory recalls / unclear indicators and partly legible
# screens (tools/kb/build _reading_tags) never enter the daily series or the baseline.
DEVICE_SKIP_TAGS = ("device-average", "device-memory", "device-type-unknown", "partial-reading", "uncertain")
SKIP_TAGS = ("low-confidence",) + DEVICE_SKIP_TAGS
MED = r"(?:morning\s+)?(?:medicines?|meds|tablets?|pills?|dawa|dawai|davai|dawaai|goli|goliyan|golis)"
BEFORE = re.compile(rf"\b(?:before\s+(?:\w+\s+){{0,2}}?{MED}|{MED}\s+(?:\w+\s+){{0,2}}?(?:pehle|pahle|se\s+pehle))\b", re.I)
AFTER = re.compile(rf"\b(?:after\s+(?:\w+\s+){{0,2}}?{MED}|{MED}\s+(?:\w+\s+){{0,2}}?(?:baad|bad|ke\s+baad))\b", re.I)


def config(gen_views):
    """data/meta/gen-views.json 'profile' object over the defaults (per-ns overrides: preferred_session may be a dict)."""
    cfg = json.loads(json.dumps(DEFAULTS))
    for k, v in (gen_views.get("profile") or {}).items():
        if not k.startswith("_"):
            cfg[k] = v
    return cfg


def pref_session(cfg, ns):
    p = cfg["preferred_session"]
    return p.get(ns, p.get("default", "morning")) if isinstance(p, dict) else p


def session_of(at, precision, windows):
    if precision != "minute" or len(at or "") < 16:
        return "untimed"
    hm = at[11:16]
    for name, (a, b) in windows.items():
        if (a <= hm < b) if a < b else (hm >= a or hm < b):
            return name
    return "untimed"


def med_timing(row):
    """'before' / 'after' morning medicines only when the record says so (data.med_timing, or the quote / note)."""
    d = row.get("data") or {}
    v = str(d.get("med_timing") or "").lower()
    if v.startswith("before") or v.startswith("after"):
        return v.split("-")[0]
    text = " ".join(x for x in (row.get("quote"), row.get("note")) if x)
    b, a = bool(BEFORE.search(text)), bool(AFTER.search(text))
    return "before" if b and not a else "after" if a and not b else None


RANK = {"original": 0, "copy": 1, "recollection": 2}


def home_readings(kb, cfg, ns=None):
    """One dict per home reading (bp, pulse, weight). Low-confidence / open hard reads are returned with used=False."""
    codes = [f"ref:code:{c}" for c in cfg["series"]]
    kinds = cfg["home_source_kinds"]
    sql = ("SELECT t.ns, t.code, t.at, t.at_precision, t.value_num, t.unit, t.components, t.method, t.rank, t.id, "
           "t.source_id, t.quote, t.uncertain_ref, s.kind AS skind, f.created_at, f.tags, f.note, f.data "
           "FROM v_trend t JOIN source s ON s.id = t.source_id JOIN fact f ON f.id = t.id "
           f"WHERE t.code IN ({','.join('?' * len(codes))}) AND (s.kind IN ({','.join('?' * len(kinds))}) "
           "OR lower(coalesce(t.method, '')) LIKE '%home%')" + (" AND t.ns = ?" if ns else "") + " ORDER BY t.ns, t.at, t.id")
    out = []
    for r in kb.q(sql, *codes, *kinds, *([ns] if ns else [])):
        comp = json.loads(r["components"]) if r["components"] else {}
        code = r["code"].split(":")[-1]
        vals = {}
        if code == "bp":
            s, d = comp.get("systolic", r["value_num"]), comp.get("diastolic")
            if s is not None:
                vals["sbp"] = float(s)
            if d is not None:
                vals["dbp"] = float(d)
            if s is not None and d is not None:
                vals["pp"] = float(s) - float(d)
        elif code == "pulse" and r["value_num"] is not None:
            vals["pulse"] = float(r["value_num"])
        elif code == "weight" and r["value_num"] is not None and (r["unit"] or "kg").lower() in ("kg", "kgs"):
            vals["weight"] = float(r["value_num"])
        tags = json.loads(r["tags"] or "[]")
        row = dict(ns=r["ns"], code=code, at=r["at"], day=r["at"][:10], precision=r["at_precision"], id=r["id"],
                   source=r["source_id"], skind=r["skind"], rank=r["rank"], created_at=r["created_at"], vals=vals,
                   quote=r["quote"], note=r["note"], data=json.loads(r["data"] or "{}"),
                   used=not (r["uncertain_ref"] or any(t in SKIP_TAGS for t in tags)) and bool(vals))
        row["session"] = session_of(r["at"], r["at_precision"], cfg["sessions"])
        row["med_timing"] = med_timing(row)
        out.append(row)
    return out


def _minutes(at):
    return datetime.datetime.fromisoformat(at.replace("Z", "+00:00")).timestamp() / 60


def _keep_first(a, b):
    """Better source rank wins, then the timed reading, then the earlier created_at, then the id."""
    ka = (RANK.get(a["rank"], 3), a["precision"] != "minute", a["created_at"] or "", a["id"])
    kb_ = (RANK.get(b["rank"], 3), b["precision"] != "minute", b["created_at"] or "", b["id"])
    return (a, b) if ka <= kb_ else (b, a)


def collapse(readings):
    """Duplicate collapse (design 3.1). Returns (kept readings, collapses [{rule, kept, dropped, code}])."""
    live = [r for r in readings if r["used"]]
    dropped, merges = set(), []
    live.sort(key=lambda r: (r["code"], r["at"], r["id"]))
    for i, a in enumerate(live):
        for b in live[i + 1:]:
            if a["id"] in dropped or b["id"] in dropped or a["code"] != b["code"] or a["vals"] != b["vals"]:
                continue
            rule = None
            if a["precision"] == "minute" and b["precision"] == "minute":
                if abs(_minutes(a["at"]) - _minutes(b["at"])) <= 30:
                    rule = "same reading sent twice (30 min)"
            elif a["source"] != b["source"]:
                da, db = datetime.date.fromisoformat(a["day"]), datetime.date.fromisoformat(b["day"])
                if abs((da - db).days) <= 1:
                    rule = "probable cross-channel duplicate (day precision, dates 1 day apart at most)"
            if rule:
                keep, drop = _keep_first(a, b)
                dropped.add(drop["id"])
                merges.append(dict(rule=rule, code=a["code"], kept=keep["id"], kept_day=keep["day"],
                                   dropped=drop["id"], dropped_day=drop["day"]))
    return [r for r in live if r["id"] not in dropped], merges


def daily(kept, preferred):
    """{series: {day: {value, n, sessions, mark, inputs, med_timing}}} (median of the day's readings)."""
    out = {}
    by = {}
    for r in kept:
        for s, v in r["vals"].items():
            by.setdefault((s, r["day"]), []).append((r, v))
    for (s, day), items in sorted(by.items()):
        pref = [(r, v) for r, v in items if r["session"] == preferred]
        use, mark = (items, None) if preferred == "any" else (pref, None) if pref else (items, "mixed-session")
        timings = {r["med_timing"] for r, _ in use if r["med_timing"]}
        out.setdefault(s, {})[day] = dict(
            value=statistics.median(v for _, v in use), n=len(use), mark=mark,
            sessions=sorted({r["session"] for r, _ in use}), inputs=sorted(r["id"] for r, _ in use),
            med_timing=timings.pop() if len(timings) == 1 else ("mixed" if timings else None))
    return out


def v_home_daily(kb, cfg, ns):
    readings = home_readings(kb, cfg, ns)
    kept, merges = collapse(readings)
    pref = pref_session(cfg, ns)
    return dict(readings=readings, kept=kept, merges=merges, preferred=pref, daily=daily(kept, pref))


def baseline(days, anchor, params):
    """Band from days in [anchor - window + 1, anchor - recent] (median +- k * max(1.4826 MAD, min_spread)).
    days: {day: {value, mark, ...}}; anchor: date of the latest daily value. Same-session days only when there are at
    least min_baseline_days of them, else all days (basis 'mixed')."""
    w, rec, need, k = params["window_days"], params["recent_days"], params["min_baseline_days"], params["k"]
    lo_day = (anchor - datetime.timedelta(days=w - 1)).isoformat()
    hi_day = (anchor - datetime.timedelta(days=rec)).isoformat()
    base = {d: v for d, v in days.items() if lo_day <= d <= hi_day}
    same = {d: v for d, v in base.items() if not v["mark"]}
    use, basis = (same, "same-session") if len(same) >= need else (base, "mixed" if len(same) < len(base) else "same-session")
    n = len(use)
    if n < need:
        return dict(status="warming-up", n=n, need=need)
    vals = [v["value"] for v in use.values()]
    med = statistics.median(vals)
    mad = statistics.median(abs(x - med) for x in vals)
    spread = max(1.4826 * mad, float(params["min_spread"]))
    return dict(status="ok", n=n, need=need, median=med, mad=mad, spread=spread, lo=med - k * spread,
                hi=med + k * spread, b1=min(use), b2=max(use), basis=basis,
                inputs=sorted(i for v in use.values() for i in v["inputs"]))


def recent(days, anchor, params):
    lo = (anchor - datetime.timedelta(days=params["recent_days"] - 1)).isoformat()
    return [(d, days[d]) for d in sorted(days) if lo <= d <= anchor.isoformat()]


def position(v, band):
    return "above" if v > band["hi"] else "below" if v < band["lo"] else "within"


SPARK = "▁▂▃▄▅▆▇█"


def sparkline(days, end, n=28):
    """One character per day for n days ending at `end` ('·' = no value); scaled to the shown min-max."""
    span = [(end - datetime.timedelta(days=n - 1 - i)).isoformat() for i in range(n)]
    vals = [days[d]["value"] for d in span if d in days]
    if not vals:
        return "·" * n
    lo, hi = min(vals), max(vals)
    return "".join("·" if d not in days else SPARK[0 if hi == lo else round((days[d]["value"] - lo) / (hi - lo) * 7)]
                   for d in span)
