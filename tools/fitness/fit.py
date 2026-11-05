"""Small FIT reader and series metrics (stdlib only). Input is untrusted: every read is bounds-checked and a malformed
file raises FitError. It decodes only the messages the fitness tool needs: file_id (0), session (18), record (20).

FIT format: Garmin's FIT SDK protocol (header, definition and data messages, compressed timestamp headers, developer
fields, trailing CRC-16). Unknown messages and developer fields are skipped by size.
"""
import math, struct

MAX_FIT_BYTES = 64 * 1024 * 1024
MAX_SERIES_S = 7 * 24 * 3600
FIT_EPOCH = 631065600  # 1989-12-31T00:00:00Z as a Unix time
POWER_WINDOWS = (5, 15, 60, 300, 600, 1200, 3600)
# Base-type code -> (struct char, invalid value); z types use 0 as invalid. float NaN is handled separately.
BASE = {0x00: ("B", 0xFF), 0x01: ("b", 0x7F), 0x02: ("B", 0xFF), 0x83: ("h", 0x7FFF), 0x84: ("H", 0xFFFF),
        0x85: ("i", 0x7FFFFFFF), 0x86: ("I", 0xFFFFFFFF), 0x07: (None, None), 0x88: ("f", None), 0x89: ("d", None),
        0x0A: ("B", 0), 0x8B: ("H", 0), 0x8C: ("I", 0), 0x0D: ("B", 0xFF), 0x8E: ("q", 0x7FFFFFFFFFFFFFFF),
        0x8F: ("Q", 0xFFFFFFFFFFFFFFFF), 0x90: ("Q", 0)}
WANTED = {0: {0, 1, 2, 8}, 18: {2, 5, 6, 7, 8, 9, 11, 14, 16, 17, 18, 19, 20, 21, 22, 34, 35, 36, 45, 253},
          20: {3, 4, 6, 7, 73, 253}}
SPORTS = {0: "generic", 1: "run", 2: "ride", 3: "transition", 4: "fitness-equipment", 5: "swim", 6: "basketball",
          7: "soccer", 8: "tennis", 10: "training", 11: "walk", 12: "ski", 13: "ski", 15: "rowing", 16: "mountaineering",
          17: "hike", 19: "paddle", 21: "ebike"}
INDOOR_SUB = {6, 13, 14, 58}  # treadmill, indoor cycling, spin, virtual activity (FIT sub_sport)
MAKERS = {1: "garmin", 123: "polar", 260: "zwift", 265: "strava"}


class FitError(ValueError):
    pass


def _crc(data):
    table = (0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
             0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400)
    crc = 0
    for b in data:
        t = table[crc & 0xF]
        crc = (crc >> 4) & 0x0FFF
        crc ^= t ^ table[b & 0xF]
        t = table[crc & 0xF]
        crc = (crc >> 4) & 0x0FFF
        crc ^= t ^ table[(b >> 4) & 0xF]
    return crc


def _value(raw, base, little):
    code = BASE.get(base)
    if code is None:
        return None
    ch, invalid = code
    if ch is None:  # string
        return raw.split(b"\0", 1)[0].decode("utf-8", "replace")
    if len(raw) < struct.calcsize(ch):
        return None
    v = struct.unpack_from(("<" if little else ">") + ch, raw)[0]
    if v == invalid or (isinstance(v, float) and not math.isfinite(v)):
        return None
    return v


def parse(data):
    """-> {"file_id": {...}, "sessions": [{field: value}], "records": [{field: value}]}. Raises FitError."""
    n = len(data)
    if n > MAX_FIT_BYTES:
        raise FitError("file too large")
    if n < 14 or data[8:12] != b".FIT":
        raise FitError("not a FIT file")
    hs = data[0]
    if hs not in (12, 14) or n < hs + 2:
        raise FitError("bad header")
    size = struct.unpack_from("<I", data, 4)[0]
    end = hs + size
    if end + 2 > n:
        raise FitError("truncated")
    if _crc(data[:end + 2]) != 0:
        raise FitError("bad CRC")
    out = {"file_id": {}, "sessions": [], "records": []}
    defs, i, last_ts = {}, hs, None
    while i < end:
        h = data[i]
        i += 1
        if h & 0x80:  # compressed timestamp header
            local, offset = (h >> 5) & 3, h & 0x1F
        elif h & 0x40:  # definition
            local = h & 0xF
            if i + 5 > end:
                raise FitError("truncated definition")
            little = data[i + 1] == 0
            msg = struct.unpack_from("<H" if little else ">H", data, i + 2)[0]
            nf = data[i + 4]
            i += 5
            if i + nf * 3 > end:
                raise FitError("truncated definition")
            fields = [(data[i + j * 3], data[i + j * 3 + 1], data[i + j * 3 + 2]) for j in range(nf)]
            i += nf * 3
            extra = 0
            if h & 0x20:  # developer fields: skipped by size
                if i >= end:
                    raise FitError("truncated definition")
                nd = data[i]
                i += 1
                if i + nd * 3 > end:
                    raise FitError("truncated definition")
                extra = sum(data[i + j * 3 + 1] for j in range(nd))
                i += nd * 3
            defs[local] = (msg, little, fields, extra)
            continue
        else:
            local, offset = h & 0xF, None
        if local not in defs:
            raise FitError("data before definition")
        msg, little, fields, extra = defs[local]
        size_all = sum(f[1] for f in fields) + extra
        if i + size_all > end:
            raise FitError("truncated data")
        want, row, p = WANTED.get(msg), {}, i
        if want is not None or any(f[0] == 253 for f in fields):
            for num, sz, base in fields:
                if num == 253 or (want is not None and num in want):
                    v = _value(data[p:p + sz], base, little)
                    if v is not None:
                        row[num] = v
                p += sz
        i += size_all
        if 253 in row:
            last_ts = row[253]
        elif offset is not None and last_ts is not None:
            last_ts = (last_ts & ~0x1F) + offset + (0x20 if offset < (last_ts & 0x1F) else 0)
            row[253] = last_ts
        if msg == 0:
            out["file_id"].update(row)
        elif msg == 18:
            out["sessions"].append(row)
        elif msg == 20 and 253 in row:
            out["records"].append(row)
    return out


def unix(fit_ts):
    return fit_ts + FIT_EPOCH


def to_second_series(points):
    """[(t_seconds, value|None)] -> per-second list from the first to the last point. A gap up to 5 s carries the last
    value; a longer gap (paused, or recording off) counts as None."""
    points = sorted((t, v) for t, v in points if v is not None)
    if not points:
        return []
    t0 = points[0][0]
    span = min(points[-1][0] - t0, MAX_SERIES_S)
    out = [None] * (span + 1)
    for t, v in points:
        if t - t0 <= span:
            out[t - t0] = v
    last, age = None, 0
    for k, v in enumerate(out):
        if v is None:
            age += 1
            if last is not None and age <= 5:
                out[k] = last
        else:
            last, age = v, 0
    return out


def normalised_power(power):
    """Coggan NP: fourth root of the mean fourth power of the 30 s rolling average. None under 60 s."""
    p = [v or 0 for v in power]
    if len(p) < 60:
        return None
    s, acc, n = 0.0, 0.0, 0
    for k, v in enumerate(p):
        s += v
        if k >= 30:
            s -= p[k - 30]
        if k >= 29:
            acc += (s / 30) ** 4
            n += 1
    return round((acc / n) ** 0.25, 1) if n else None


def power_curve(power):
    """{window seconds: best mean power}, for windows the series covers."""
    p = [v or 0 for v in power]
    pre, out = [0.0], {}
    for v in p:
        pre.append(pre[-1] + v)
    for w in POWER_WINDOWS:
        if len(p) >= w:
            out[str(w)] = round(max(pre[k + w] - pre[k] for k in range(len(p) - w + 1)) / w, 1)
    return out


def _mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def series_metrics(power, hr, cadence):
    """Roll per-second series up into activity numbers (the samples stay in the raw file)."""
    m = {}
    if any(power):
        m["avg_power_w"] = round(_mean([v or 0 for v in power]), 1)
        m["max_power_w"] = max(v or 0 for v in power)
        np_ = normalised_power(power)
        if np_:
            m["np_w"] = np_
        m["power_curve_w"] = power_curve(power)
    if any(hr):
        m["avg_hr_bpm"] = round(_mean(hr), 1)
        m["max_hr_bpm"] = max(v for v in hr if v is not None)
    if any(cadence):
        nz = [v for v in cadence if v]
        m["avg_cadence_rpm"] = round(_mean(nz), 1)
        m["max_cadence_rpm"] = max(nz)
    if any(power) and any(hr):
        if m.get("np_w") and m["avg_hr_bpm"]:
            m["ef"] = round(m["np_w"] / m["avg_hr_bpm"], 3)
        n = min(len(power), len(hr))
        if n >= 40 * 60:  # Pw:HR decoupling: EF of the first half vs the second; meaningless on short efforts
            half = n // 2
            np1, np2 = normalised_power(power[:half]), normalised_power(power[half:n])
            hr1, hr2 = _mean(hr[:half]), _mean(hr[half:n])
            if np1 and np2 and hr1 and hr2:
                m["decoupling_pct"] = round((np1 / hr1 - np2 / hr2) / (np1 / hr1) * 100, 1)
    return m


def summarise(parsed):
    """Parsed FIT -> activity dict (numbers and short labels only) or raises FitError when no time information exists."""
    recs, sessions = parsed["records"], parsed["sessions"]
    s = sessions[0] if sessions else {}
    start = s.get(2) or (recs[0][253] if recs else None)
    if not start:
        raise FitError("no start time")
    a = {"start_unix": unix(start), "sport": SPORTS.get(s.get(5), "other"), "indoor": s.get(6) in INDOOR_SUB}
    fid = parsed["file_id"]
    a["device"] = fid.get(8) if isinstance(fid.get(8), str) and fid.get(8) else MAKERS.get(fid.get(1), f"maker-{fid.get(1)}")
    t0 = recs[0][253] if recs else start
    pts = lambda f: [(r[253] - t0, r.get(f)) for r in recs]
    power, hr, cad = to_second_series(pts(7)), to_second_series(pts(3)), to_second_series(pts(4))
    a.update(series_metrics(power, hr, cad))
    if recs:
        a["elapsed_s"] = recs[-1][253] - t0
    sess = {7: ("elapsed_s", .001), 8: ("moving_s", .001), 9: ("distance_m", .01), 11: ("calories_kcal", 1), 22: ("ascent_m", 1),
            35: ("tss", .1), 45: ("ftp_w", 1)}
    for f, (k, scale) in sess.items():
        if s.get(f) is not None:
            a[k] = round(s[f] * scale, 1)
    # The device's own summary fills what the samples did not give (session-only files).
    for f, k in ((20, "avg_power_w"), (21, "max_power_w"), (34, "np_w"), (16, "avg_hr_bpm"), (17, "max_hr_bpm"),
                 (18, "avg_cadence_rpm"), (19, "max_cadence_rpm")):
        if s.get(f) is not None and k not in a:
            a[k] = s[f]
    if not a.get("elapsed_s"):
        raise FitError("no duration")
    return a
