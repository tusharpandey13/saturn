"""Raw store, normalise (raw -> KB rows), dedupe and bulk-export import for tools/fitness. Stdlib only.

Raw files are immutable: sources/<ns>/media/<channel>/<date>-fitness-<channel>-<kind>[-<key>]-<sha12>.<ext>.gz, gzip of
the provider's bytes, content-addressed so a re-fetch is a no-op. One row-bearing raw file gives one
data/<ns>/docs/<stem>.ndjson with one source row and one observation fact. Fact rows are immutable (a changed payload for
the same <date, kind, key> is a new fact that supersedes the old one); dedupe only maintains the source row's rank,
duplicate_of and canonical tag (ADR 015). Every provider value is untrusted: only bounded numbers and slugged labels
reach the KB, free text (activity names, notes) stays in the raw file.
"""
import csv, datetime, gzip, hashlib, io, json, math, os, pathlib, re, sys, zipfile, zlib

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "kb"))
import fit  # noqa: E402
import records_config  # noqa: E402

IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
CHANNELS = ("strava", "polar", "zwift", "mywhoosh")
ROW_KINDS = ("activity", "export-activity", "sleep", "recharge", "daily", "chr", "cardio", "alertness")
RAW_KINDS = ("detail", "export-raw", "circadian", "bio")  # kept, no KB row
NAME_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})-fitness-(%s)-(%s)(?:-([a-z0-9]+))?-([0-9a-f]{12})$"
                     % ("|".join(CHANNELS), "|".join(sorted(ROW_KINDS + RAW_KINDS, key=len, reverse=True))))
RECORDED_BY = "tools/fitness"
# Canonical preference: the direct file first (it has the samples), then the wearable, then the copy on Strava.
ORIGIN_RANK = {"mywhoosh": 0, "zwift": 1, "polar": 2, "polar-export": 3, "strava-export": 4, "strava-api": 5}
OVERLAP_MIN = 0.5  # same activity = overlap of at least half the longer recording
MAX_ZIP_ENTRY = 256 * 1024 * 1024
MAX_ZIP_ENTRIES = 200000
SPORT_FAMILY = (("ride", ("ride", "cycl", "bik", "velomobile", "handcycle")), ("run", ("run",)), ("walk", ("walk",)),
                ("hike", ("hik", "mountaineer")), ("swim", ("swim",)), ("row", ("row",)), ("ski", ("ski", "snowboard")),
                ("strength", ("strength", "weight", "crossfit", "workout")), ("yoga", ("yoga", "pilates")))
CODES = {  # Also in tools/kb/build (FITNESS_CODES), which emits the built-in refs
    "activity": "ref:code:fitness-activity", "sleep": "ref:code:fitness-sleep", "recharge": "ref:code:fitness-recharge",
    "daily": "ref:code:fitness-daily", "chr": "ref:code:fitness-hr-day", "cardio": "ref:code:fitness-cardio-load",
    "alertness": "ref:code:fitness-sleepwise"}


class StoreError(Exception):
    pass


def today_ist():
    return datetime.datetime.now(IST).date().isoformat()


def slug(v, n=40):
    return re.sub(r"[^a-z0-9]+", "-", str(v or "").lower()).strip("-")[:n].strip("-")


def key_of(v):
    return re.sub(r"[^a-z0-9]", "", str(v or "").lower())[:40]


def num(v, lo=0, hi=1e7, nd=2):
    """A finite number within [lo, hi], or None. Provider values are untrusted."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    if not math.isfinite(v) or v < lo or v > hi:
        return None
    return round(v, nd) if isinstance(v, float) else v


def iso_duration(v):
    m = re.fullmatch(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?", str(v or ""))
    if not m or not any(m.groups()):
        return None
    return int(m[1] or 0) * 3600 + int(m[2] or 0) * 60 + float(m[3] or 0)


def is_date(v):
    try:
        datetime.date.fromisoformat(str(v)[:10])
    except ValueError:
        return False
    return len(str(v)) >= 10


def sport_family(raw):
    s = slug(raw)
    for fam, words in SPORT_FAMILY:
        if any(w in s for w in words):
            return fam
    return "other"


def ist_at(unix):
    return datetime.datetime.fromtimestamp(unix, IST).replace(microsecond=0).isoformat()


def ist_date(unix):
    return datetime.datetime.fromtimestamp(unix, IST).date().isoformat()


def local_unix(text, offset_min):
    """Provider local time + UTC offset in minutes -> Unix time, or None."""
    try:
        d = datetime.datetime.fromisoformat(str(text).replace("Z", "+00:00"))
    except ValueError:
        return None
    if d.tzinfo is None:
        off = offset_min if isinstance(offset_min, (int, float)) and abs(offset_min) <= 14 * 60 else 330
        d = d.replace(tzinfo=datetime.timezone(datetime.timedelta(minutes=off)))
    return int(d.timestamp())


# ---- raw store ----------------------------------------------------------------------------------------------------
def media_dir(root, ns, channel):
    if channel not in CHANNELS:
        raise StoreError(f"unknown channel {channel}")
    return pathlib.Path(root) / "sources" / ns / "media" / channel


def store_raw(root, ns, channel, kind, date, key, ext, payload):
    """Write the gzip of `payload` unless the same bytes are stored. -> (path, new?)."""
    if kind not in ROW_KINDS + RAW_KINDS or ext not in ("json", "fit", "tcx", "gpx") or not is_date(date):
        raise StoreError(f"bad raw item {kind}/{ext}")
    k = key_of(key)
    sha = hashlib.sha256(payload).hexdigest()[:12]
    stem = f"{date[:10]}-fitness-{channel}-{kind}" + (f"-{k}" if k else "") + f"-{sha}"
    d = media_dir(root, ns, channel)
    p = d / f"{stem}.{ext}.gz"
    if p.exists():
        return p, False
    d.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_bytes(gzip.compress(payload, mtime=0))
    os.replace(tmp, p)
    return p, True


def seen_group(root, ns, channel, kind, date, key):
    """True when any version of <date, kind, key> is stored (a pull can then skip the costly detail fetches)."""
    k = key_of(key)
    return any(media_dir(root, ns, channel).glob(f"{date[:10]}-fitness-{channel}-{kind}" + (f"-{k}" if k else "") + "-*.gz"))


def read_raw(p):
    return gzip.decompress(p.read_bytes())


def read_json(p):
    try:
        return json.loads(read_raw(p))
    except (ValueError, OSError, EOFError, zlib.error):
        return None


# ---- raw payload -> one fact ---------------------------------------------------------------------------------------
def _comps(pairs):
    return {k: v for k, v in pairs if v is not None}


def activity_fact(a, origin):
    """Activity numbers (from fit.summarise or a provider's summary) -> fact fields."""
    comps = {k: v for k, v in a.items() if k not in ("device", "power_curve_w") and v is not None}
    if a.get("power_curve_w"):
        comps["power_curve_w"] = a["power_curve_w"]
    mins = round(a["elapsed_s"] / 60, 1)
    parts = [f"{a['sport']} activity {mins} min"]
    labels = (("distance_m", "distance {:.1f} km", 0.001), ("avg_power_w", "avg power {:.0f} W", 1), ("np_w", "NP {:.0f} W", 1),
              ("avg_hr_bpm", "avg HR {:.0f} bpm", 1), ("max_hr_bpm", "max HR {:.0f} bpm", 1),
              ("avg_cadence_rpm", "cadence {:.0f} rpm", 1), ("calories_kcal", "{:.0f} kcal", 1))
    parts += [fmt.format(a[k] * s) for k, fmt, s in labels if a.get(k) is not None]
    return {"at": ist_at(a["start_unix"]), "precision": "minute", "code": CODES["activity"], "value": mins, "unit": "min",
            "text": ", ".join(parts) + f" ({origin})", "comps": comps, "device": slug(a.get("device"), 60) or None}


def from_fit(data):
    return fit.summarise(fit.parse(data))


def _base_activity(start, elapsed, raw_sport, indoor=None, **kw):
    if not start or not elapsed:
        return None
    a = {"start_unix": int(start), "elapsed_s": num(elapsed, 1, 2e6, 0), "sport": sport_family(raw_sport),
         "sport_detail": slug(raw_sport) or None}
    if a["elapsed_s"] is None:
        return None
    if indoor is not None:
        a["indoor"] = bool(indoor)
    a.update(kw)
    return a


def _merge_detail(a, m):
    for k, v in m.items():
        if k not in a or a[k] is None:
            a[k] = v
    return a


def polar_activity(j, detail):
    start = local_unix(j.get("start_time"), j.get("start_time_utc_offset"))
    hr = j.get("heart_rate") if isinstance(j.get("heart_rate"), dict) else {}
    a = _base_activity(start, iso_duration(j.get("duration")), j.get("detailed_sport_info") or j.get("sport"),
                       distance_m=num(j.get("distance")), calories_kcal=num(j.get("calories")),
                       avg_hr_bpm=num(hr.get("average"), 1, 260), max_hr_bpm=num(hr.get("maximum"), 1, 260),
                       polar_training_load=num(j.get("training_load"), 0, 1e5), device=j.get("device"))
    if a and detail:
        s = {k: v for k, v in detail.items() if k not in ("start_unix", "elapsed_s", "sport", "device")}
        _merge_detail(a, s)
    return a


def strava_activity(j, streams):
    try:
        start = int(datetime.datetime.fromisoformat(str(j.get("start_date")).replace("Z", "+00:00")).timestamp())
    except ValueError:
        return None
    a = _base_activity(start, j.get("elapsed_time"), j.get("sport_type") or j.get("type"), j.get("trainer"),
                       moving_s=num(j.get("moving_time"), 0, 2e6, 0), distance_m=num(j.get("distance")),
                       ascent_m=num(j.get("total_elevation_gain"), 0, 1e5), calories_kcal=num(j.get("calories")),
                       avg_power_w=num(j.get("average_watts"), 0, 5000), max_power_w=num(j.get("max_watts"), 0, 5000),
                       np_w=num(j.get("weighted_average_watts"), 0, 5000), avg_hr_bpm=num(j.get("average_heartrate"), 1, 260),
                       max_hr_bpm=num(j.get("max_heartrate"), 1, 260), avg_cadence_rpm=num(j.get("average_cadence"), 0, 400),
                       device=j.get("device_name"))
    if a and isinstance(streams, dict):
        def stream(name):
            d = streams.get(name)
            return d.get("data") if isinstance(d, dict) and isinstance(d.get("data"), list) else []
        t = stream("time")
        if t:
            pts = lambda name: [(tt, v if num(v, 0, 5000) is not None else None) for tt, v in zip(t, stream(name))
                                if isinstance(tt, int)]
            _merge_detail(a, fit.series_metrics(fit.to_second_series(pts("watts")), fit.to_second_series(pts("heartrate")),
                                                fit.to_second_series(pts("cadence"))))
    return a


def strava_export_activity(j, detail):
    start, elapsed = None, num(_float(j.get("Elapsed Time")), 1, 2e6, 0)
    try:
        start = int(datetime.datetime.strptime(j.get("Activity Date", ""), "%b %d, %Y, %I:%M:%S %p")
                    .replace(tzinfo=datetime.timezone.utc).timestamp())
    except ValueError:
        pass
    a = _base_activity(start, elapsed, j.get("Activity Type"), distance_m=num(_float(j.get("Distance#2") or j.get("Distance"))),
                       moving_s=num(_float(j.get("Moving Time")), 0, 2e6, 0), avg_hr_bpm=num(_float(j.get("Average Heart Rate")), 1, 260),
                       max_hr_bpm=num(_float(j.get("Max Heart Rate")), 1, 260), avg_power_w=num(_float(j.get("Average Watts")), 0, 5000),
                       max_power_w=num(_float(j.get("Max Watts")), 0, 5000), np_w=num(_float(j.get("Weighted Average Power")), 0, 5000),
                       calories_kcal=num(_float(j.get("Calories"))), ascent_m=num(_float(j.get("Elevation Gain")), 0, 1e5))
    if a and detail:
        _merge_detail(a, {k: v for k, v in detail.items() if k not in ("start_unix", "elapsed_s", "sport")})
    return a


def polar_export_activity(j, detail):
    ex = j.get("exercises") if isinstance(j.get("exercises"), list) and j["exercises"] else [{}]
    e = ex[0] if isinstance(ex[0], dict) else {}
    start = local_unix(e.get("startTime") or j.get("startTime"), e.get("timezoneOffset", j.get("timeZoneOffset")))
    stop = local_unix(e.get("stopTime") or j.get("stopTime"), e.get("timezoneOffset", j.get("timeZoneOffset")))
    dur = (num(_float(e.get("durationMillis")), 1, 2e9) or 0) / 1000 or ((stop - start) if start and stop else None)
    hr = e.get("heartRate") if isinstance(e.get("heartRate"), dict) else {}
    return _base_activity(start, dur, e.get("sport") or j.get("sport") or j.get("name"),
                          distance_m=num(_float(e.get("distance", j.get("distanceMeters")))),
                          calories_kcal=num(_float(e.get("kiloCalories", j.get("kiloCalories")))),
                          avg_hr_bpm=num(_float(hr.get("avg", j.get("hrAvg"))), 1, 260),
                          max_hr_bpm=num(_float(hr.get("max", j.get("hrMax"))), 1, 260))


def _float(v):
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return v
    try:
        return float(str(v).replace(",", "")) if v not in (None, "") else None
    except ValueError:
        return None


def daily_fact(kind, j):
    """One day's or night's payload -> fact fields, or None when it carries nothing."""
    if not isinstance(j, dict):
        return None
    if kind == "sleep":
        secs = [num(j.get(k), 0, 1e5) for k in ("light_sleep", "deep_sleep", "rem_sleep")]
        total = sum(s for s in secs if s)
        hrs = j.get("heart_rate_samples") if isinstance(j.get("heart_rate_samples"), dict) else {}
        hv = [v for v in (num(x, 20, 260) for x in hrs.values()) if v]
        c = _comps([("sleep_s", total or None), ("light_s", secs[0]), ("deep_s", secs[1]), ("rem_s", secs[2]),
                    ("interruption_s", num(j.get("total_interruption_duration"), 0, 1e5)), ("score", num(j.get("sleep_score"), 0, 100)),
                    ("charge", num(j.get("sleep_charge"), 0, 10)), ("continuity", num(j.get("continuity"), 0, 10)),
                    ("cycles", num(j.get("sleep_cycles"), 0, 50)), ("sleep_hr_min_bpm", min(hv) if hv else None),
                    ("sleep_hr_avg_bpm", round(sum(hv) / len(hv), 1) if hv else None)])
        if not total:
            return None
        return {"code": CODES["sleep"], "value": round(total / 3600, 2), "unit": "h", "comps": c,
                "text": f"sleep {total / 3600:.1f} h" + (f", score {c['score']}" if "score" in c else "")}
    if kind == "recharge":
        c = _comps([("status", num(j.get("nightly_recharge_status"), 0, 10)), ("ans_charge", num(j.get("ans_charge"), -100, 100)),
                    ("hr_avg_bpm", num(j.get("heart_rate_avg"), 20, 260)), ("hrv_avg_ms", num(j.get("heart_rate_variability_avg"), 0, 1000)),
                    ("beat_to_beat_ms", num(j.get("beat_to_beat_avg"), 0, 5000)), ("breathing_rate", num(j.get("breathing_rate_avg"), 0, 100))])
        if "status" not in c:
            return None
        return {"code": CODES["recharge"], "value": c["status"], "unit": "status", "comps": c,
                "text": f"nightly recharge status {c['status']}" + (f", HRV {c['hrv_avg_ms']} ms" if "hrv_avg_ms" in c else "")}
    if kind == "daily":
        c = _comps([("steps", num(j.get("steps"))), ("calories_kcal", num(j.get("calories"))), ("active_calories_kcal", num(j.get("active_calories"))),
                    ("active_s", iso_duration(j.get("active_duration"))), ("inactive_s", iso_duration(j.get("inactive_duration"))),
                    ("distance_m", num(j.get("distance_from_steps"))), ("daily_activity_pct", num(j.get("daily_activity"), 0, 1000))])
        if "steps" not in c:
            return None
        return {"code": CODES["daily"], "value": c["steps"], "unit": "steps", "comps": c, "text": f"{c['steps']} steps"}
    if kind == "chr":
        samples = j.get("heart_rate_samples") if isinstance(j.get("heart_rate_samples"), list) else []
        hv = [v for v in (num(s.get("heart_rate"), 20, 260) for s in samples if isinstance(s, dict)) if v]
        if not hv:
            return None
        avg = round(sum(hv) / len(hv), 1)
        return {"code": CODES["chr"], "value": avg, "unit": "bpm", "text": f"day heart rate avg {avg} bpm, range {min(hv)}-{max(hv)}",
                "comps": {"hr_avg_bpm": avg, "hr_min_bpm": min(hv), "hr_max_bpm": max(hv), "samples": len(hv)}}
    if kind == "cardio":
        if j.get("cardio_load_status") == "LOAD_STATUS_NOT_AVAILABLE" or num(j.get("cardio_load"), 0, 1e5) is None:
            return None
        c = _comps([("cardio_load", num(j.get("cardio_load"), 0, 1e5)), ("strain", num(j.get("strain"), 0, 1e5)),
                    ("tolerance", num(j.get("tolerance"), 0, 1e5)), ("ratio", num(j.get("cardio_load_ratio"), 0, 1e3)),
                    ("status", slug(j.get("cardio_load_status")) or None)])
        return {"code": CODES["cardio"], "value": c["cardio_load"], "unit": "load", "comps": c, "text": f"cardio load {c['cardio_load']}"}
    if kind == "alertness":
        g = num(j.get("grade"), 0, 100)
        if g is None:
            return None
        c = _comps([("grade", g), ("classification", slug(j.get("grade_classification")) or None), ("validity", slug(j.get("validity")) or None),
                    ("sleep_inertia", slug(j.get("sleep_inertia")) or None)])
        return {"code": CODES["alertness"], "value": g, "unit": "grade", "comps": c, "text": f"SleepWise alertness grade {g}"}
    return None


# ---- normalise ------------------------------------------------------------------------------------------------------
def docs_dir(root, ns):
    return pathlib.Path(root) / "data" / ns / "docs"


def _detail(d, date, channel, key, kind="detail"):
    """The newest stored detail for an activity: parsed FIT numbers, or the stream JSON."""
    for p in sorted(d.glob(f"{date}-fitness-{channel}-{kind}-{key}-*.gz")):
        if p.name.endswith(".fit.gz"):
            try:
                return from_fit(read_raw(p))
            except fit.FitError:
                return None
        if p.name.endswith(".json.gz"):
            return read_json(p)
    return None


def _extract(p, m):
    """Raw file -> (fact fields, origin) or (None, reason)."""
    date, channel, kind, key = m[1], m[2], m[3], m[4] or ""
    if kind == "activity" and p.name.endswith(".fit.gz"):
        try:
            a = from_fit(read_raw(p))
        except fit.FitError as e:
            return None, f"unreadable FIT: {e}"
        origin = channel
    elif kind in ("activity", "export-activity"):
        j = read_json(p)
        if not isinstance(j, dict):
            return None, "unreadable JSON"
        if (channel, kind) == ("polar", "activity"):
            a, origin = polar_activity(j, _detail(p.parent, date, channel, key)), "polar"
        elif (channel, kind) == ("strava", "activity"):
            a, origin = strava_activity(j, _detail(p.parent, date, channel, key)), "strava-api"
        elif (channel, kind) == ("strava", "export-activity"):
            a, origin = strava_export_activity(j, _detail(p.parent, date, channel, key)), "strava-export"
        elif (channel, kind) == ("polar", "export-activity"):
            a, origin = polar_export_activity(j, None), "polar-export"
        else:
            return None, "no reader"
        if a is None:
            return None, "no start or duration"
    else:
        f = daily_fact(kind, read_json(p))
        if f is None:
            return None, "no usable values"
        f.update(at=date, precision="day", device=None)
        return f, channel
    if not a.get("sport_detail"):
        a["sport_detail"] = None
    return activity_fact(a, origin), origin


def _rows(ns, local, rel, sha, date, origin, f, today, supersedes=None):
    src = {"rt": "source", "id": f"{ns}:src:{local}", "ns": ns, "kind": "other", "path": rel, "sha256": sha, "issued_at": date,
           "rank": "original", "recorded_by": RECORDED_BY, "created_at": today, "status": "active",
           "tags": ["fitness", f"fitness:{origin}"]}
    data = {"code": f["code"], "category": "fitness", "value_num": f["value"], "unit": f["unit"], "value_text": f["text"],
            "components": f["comps"]}
    if f.get("device"):
        data["device"] = f["device"]
    fact = {"rt": "fact", "id": f"{ns}:fact:{local}.obs", "kind": "observation", "ns": ns, "at": f["at"], "at_precision": f["precision"],
            "source_id": src["id"], "page": None, "context_id": None, "verification": "unverified", "uncertain_ref": None,
            "status": "active", "supersedes": supersedes, "recorded_by": RECORDED_BY, "created_at": today,
            "tags": ["fitness", "device-reported", f"fitness:{origin}"], "locator": None, "quote": None, "data": data}
    return src, fact


def _write_rows(path, rows):
    tmp = path.with_suffix(".tmp")
    tmp.write_text("".join(json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n" for r in rows), encoding="utf-8")
    os.replace(tmp, path)


def _load_rows(path):
    return [json.loads(x) for x in path.read_text(encoding="utf-8").splitlines() if x.strip()]


def normalise(root, ns, today=None):
    """New raw files -> KB rows, then dedupe. Idempotent. -> counts."""
    root, today = pathlib.Path(root), today or today_ist()
    dd = docs_dir(root, ns)
    counts = {"new_rows": 0, "superseded": 0, "skipped": 0, "source_rows_updated": 0}
    groups = {}
    for f in dd.glob("*-fitness-*.ndjson") if dd.is_dir() else []:
        m = NAME_RE.match(f.stem)
        if m:
            rows = _load_rows(f)
            if any(r.get("rt") == "fact" and r.get("status") == "active" for r in rows):
                groups[(m[1], m[2], m[3], m[4])] = f
    for channel in CHANNELS:
        d = media_dir(root, ns, channel)
        for p in sorted(d.glob("*-fitness-*.gz")) if d.is_dir() else []:
            stem = p.name.split(".", 1)[0]
            m = NAME_RE.match(stem)
            if not m or m[3] not in ROW_KINDS:
                continue
            target = dd / f"{stem}.ndjson"
            if target.exists():
                continue
            f, origin = _extract(p, m)
            if f is None:
                counts["skipped"] += 1
                continue
            old = groups.get((m[1], m[2], m[3], m[4]))
            supersedes = None
            if old is not None:
                rows = _load_rows(old)
                for r in rows:
                    if r.get("rt") == "fact":
                        supersedes = r["id"]
                        r["status"] = "superseded"
                _write_rows(old, rows)
                counts["superseded"] += 1
            dd.mkdir(parents=True, exist_ok=True)
            src, fact = _rows(ns, stem, p.relative_to(root).as_posix(), hashlib.sha256(p.read_bytes()).hexdigest(),
                              m[1], origin, f, today, supersedes)
            _write_rows(target, [src, fact])
            groups[(m[1], m[2], m[3], m[4])] = target
            counts["new_rows"] += 1
    counts["source_rows_updated"] = dedupe(root, ns)
    ensure_page(root, ns, today)
    return counts


def _prefers(a):
    """Lower sorts first: the source order, then more complete, then the stable id."""
    return (ORIGIN_RANK.get(a["origin"], 9), 0 if a["np"] else 1, a["path"].name)


def dedupe(root, ns):
    """Cluster active activities by time overlap, keep one canonical source; only source rows change. -> rows changed."""
    dd = docs_dir(root, ns)
    acts = []
    for f in sorted(dd.glob("*-fitness-*activity-*.ndjson")) if dd.is_dir() else []:
        rows = _load_rows(f)
        src = next((r for r in rows if r.get("rt") == "source"), None)
        fact = next((r for r in rows if r.get("rt") == "fact" and r.get("status") == "active"), None)
        if not src or not fact or fact["data"].get("code") != CODES["activity"]:
            continue
        c = fact["data"]["components"]
        if not isinstance(c.get("start_unix"), int) or not c.get("elapsed_s"):
            continue
        origin = next((t.split(":", 1)[1] for t in src["tags"] if t.startswith("fitness:")), "?")
        acts.append({"path": f, "rows": rows, "src": src, "start": c["start_unix"], "end": c["start_unix"] + int(c["elapsed_s"]),
                     "origin": origin, "np": c.get("np_w")})
    acts.sort(key=lambda a: a["start"])
    parent = list(range(len(acts)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for i, a in enumerate(acts):
        for j in range(i + 1, len(acts)):
            b = acts[j]
            if b["start"] >= a["end"]:
                break
            overlap = min(a["end"], b["end"]) - b["start"]
            if overlap >= OVERLAP_MIN * max(a["end"] - a["start"], b["end"] - b["start"]):
                parent[find(j)] = find(i)
    clusters = {}
    for i, a in enumerate(acts):
        clusters.setdefault(find(i), []).append(a)
    changed = 0
    for members in clusters.values():
        canon = min(members, key=_prefers)
        for a in members:
            s = a["src"]
            want_dup = None if a is canon or len(members) == 1 else canon["src"]["id"]
            want_rank = "original" if want_dup is None else "copy"
            base = [t for t in s["tags"] if t not in ("fitness-canonical", "fitness-duplicate")]
            want_tags = base + (["fitness-canonical"] if want_dup is None else ["fitness-duplicate"])
            if s.get("duplicate_of") != want_dup or s["rank"] != want_rank or s["tags"] != want_tags:
                s["rank"], s["tags"] = want_rank, want_tags
                if want_dup:
                    s["duplicate_of"] = want_dup
                else:
                    s.pop("duplicate_of", None)
                _write_rows(a["path"], a["rows"])
                changed += 1
    return changed


PAGE = """---
title: {display} fitness
audience: owner
type: reference
owner: owner
last_reviewed: {today}
review_every: 90d
status: active
sources: [v_fitness]
generated: partial
---

# {display}: fitness

Facts as written; not advice; doctors decide. Device-reported numbers from wearables and training apps, not clinical readings.

<!-- gen:fitness start -->
<!-- gen:fitness end -->
"""


def ensure_page(root, ns, today):
    """The generated view's page, once this namespace has fitness rows. The block itself is written by gen-views."""
    root = pathlib.Path(root)
    page = root / "docs" / "health" / ns / "fitness.md"
    if page.exists() or not any(docs_dir(root, ns).glob("*-fitness-*.ndjson")):
        return
    rc = records_config.load(root)
    display = rc["display"].get(ns, ns)
    page.parent.mkdir(parents=True, exist_ok=True)
    page.write_text(PAGE.format(display=display, today=today), encoding="utf-8")


# ---- local files ----------------------------------------------------------------------------------------------------
def import_fit(root, ns, channel, paths):
    """FIT files (or directories of them) from Zwift or MyWhoosh -> raw store. Counts only; values are never printed."""
    if channel not in ("zwift", "mywhoosh"):
        raise StoreError("import-fit --source is zwift or mywhoosh")
    counts = {"files": 0, "new": 0, "already_stored": 0, "skipped_in_progress": 0, "invalid": 0}
    files = []
    for p in map(pathlib.Path, paths):
        files += sorted(x for x in p.rglob("*") if x.is_file() and x.name.lower().endswith((".fit", ".fit.gz"))) if p.is_dir() else [p]
    for p in files:
        counts["files"] += 1
        if p.name == "inProgressActivity.fit":  # Zwift's scratch file for a ride still running
            counts["skipped_in_progress"] += 1
            continue
        try:
            if p.stat().st_size > fit.MAX_FIT_BYTES:
                raise fit.FitError("too large")
            data = p.read_bytes()
            if p.name.lower().endswith(".gz"):
                data = _gunzip(data)
            a = from_fit(data)
        except (fit.FitError, OSError, EOFError, zlib.error):
            counts["invalid"] += 1
            continue
        date = ist_date(a["start_unix"])
        _, new = store_raw(root, ns, channel, "activity", date, str(a["start_unix"]), "fit", data)
        counts["new" if new else "already_stored"] += 1
    return counts


def _gunzip(data, cap=fit.MAX_FIT_BYTES):
    d = zlib.decompressobj(47)
    out = d.decompress(data, cap + 1)
    if len(out) > cap or d.unconsumed_tail:
        raise fit.FitError("gzip too large")
    return out


def _zip_entries(zf):
    infos = zf.infolist()
    if len(infos) > MAX_ZIP_ENTRIES:
        raise StoreError("too many entries in the export")
    return {i.filename: i for i in infos if not i.is_dir()}


def _zip_read(zf, info):
    if info.file_size > MAX_ZIP_ENTRY:
        raise StoreError("an export entry is too large")
    with zf.open(info) as f:
        data = f.read(MAX_ZIP_ENTRY + 1)
    if len(data) > MAX_ZIP_ENTRY:
        raise StoreError("an export entry is too large")
    return data


def import_export(root, ns, source, path):
    """An official bulk export (.zip) -> raw store; never extracted to disk, entry names are only matched."""
    if source not in ("strava", "polar"):
        raise StoreError("import-export --source is strava or polar")
    counts = {"activities": 0, "new": 0, "already_stored": 0, "details": 0, "raw_only": 0, "unreadable": 0}
    with zipfile.ZipFile(path) as zf:
        entries = _zip_entries(zf)
        (_strava_export if source == "strava" else _polar_export)(zf, entries, root, ns, counts)
    return counts


def _strava_export(zf, entries, root, ns, counts):
    name = next((n for n in entries if n.rsplit("/", 1)[-1] == "activities.csv"), None)
    if name is None:
        raise StoreError("no activities.csv in the export")
    reader = csv.reader(io.StringIO(_zip_read(zf, entries[name]).decode("utf-8-sig", "replace")))
    head = next(reader, [])
    names, seen = [], {}
    for h in head:  # Strava repeats some headers (a display column, then a raw one): the repeat becomes "<name>#2"
        seen[h] = seen.get(h, 0) + 1
        names.append(h if seen[h] == 1 else f"{h}#{seen[h]}")
    prefix = name[:-len("activities.csv")]
    for row in reader:
        j = dict(zip(names, row))
        counts["activities"] += 1
        aid = key_of(j.get("Activity ID"))
        a = strava_export_activity(j, None)
        if not aid or a is None:
            counts["unreadable"] += 1
            continue
        date = ist_date(a["start_unix"])
        fn = (j.get("Filename") or "").strip()
        if fn and prefix + fn in entries:
            try:
                data = _zip_read(zf, entries[prefix + fn])
                if fn.endswith(".gz"):
                    data = _gunzip(data, MAX_ZIP_ENTRY)
                ext = fn.removesuffix(".gz").rsplit(".", 1)[-1].lower()
                if ext in ("fit", "tcx", "gpx"):
                    store_raw(root, ns, "strava", "detail", date, aid, ext, data)
                    counts["details"] += 1
            except (fit.FitError, OSError, EOFError, zipfile.BadZipFile, zlib.error):
                counts["unreadable"] += 1
        _, new = store_raw(root, ns, "strava", "export-activity", date, aid,
                           "json", json.dumps(j, sort_keys=True, ensure_ascii=False).encode())
        counts["new" if new else "already_stored"] += 1


def _polar_export(zf, entries, root, ns, counts):
    for n, info in sorted(entries.items()):
        base = n.rsplit("/", 1)[-1]
        if not base.endswith(".json"):
            continue
        try:
            data = _zip_read(zf, info)
            j = json.loads(data)
        except (ValueError, zipfile.BadZipFile):
            counts["unreadable"] += 1
            continue
        if base.startswith("training-session") and isinstance(j, dict):
            counts["activities"] += 1
            a = polar_export_activity(j, None)
            if a is None:
                counts["unreadable"] += 1
                continue
            _, new = store_raw(root, ns, "polar", "export-activity", ist_date(a["start_unix"]), str(a["start_unix"]), "json", data)
            counts["new" if new else "already_stored"] += 1
        else:
            # Other export files (daily activity, sleep, recovery): kept raw until a real export shows a stable shape.
            d = re.search(r"\d{4}-\d{2}-\d{2}", base)
            store_raw(root, ns, "polar", "export-raw", d[0] if d and is_date(d[0]) else today_ist(), slug(base.split("-")[0] or "x", 20), "json", data)
            counts["raw_only"] += 1


# ---- counts (status endpoint, metrics) -------------------------------------------------------------------------------
def counts(root, ns):
    """Numbers only: no dates of individual activities, no values."""
    dd = docs_dir(root, ns)
    out = {"activities": 0, "canonical_activities": 0, "daily_rows": 0, "raw_files": 0}
    for channel in CHANNELS:
        d = media_dir(root, ns, channel)
        if d.is_dir():
            out["raw_files"] += sum(1 for _ in d.glob("*-fitness-*.gz"))
    for f in dd.glob("*-fitness-*.ndjson") if dd.is_dir() else []:
        if "-activity-" in f.name or "-export-activity-" in f.name:
            out["activities"] += 1
            if '"fitness-canonical"' in f.read_text(encoding="utf-8"):
                out["canonical_activities"] += 1
        else:
            out["daily_rows"] += 1
    return out
