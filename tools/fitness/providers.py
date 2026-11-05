"""Strava and Polar AccessLink clients for tools/fitness: OAuth, tokens, cursors, rate limits. Stdlib only.

Sources (fetched 05-Nov-2026): https://developers.strava.com/docs/authentication/, /docs/rate-limits/, /docs/reference/;
https://www.polar.com/accesslink-api/. Payloads are untrusted; they go to the raw store as bytes and are read by
store.py only. No token, code, payload or provider error body is ever logged or returned to a caller.

Strava API access is off unless the operator passes it on deliberately: the Strava API Policy (effective 01-Jun-2026,
sections 5.3, 5.5, 6.2) forbids what the records repo does with data (ADR 015). Bulk exports go through store.py.
"""
import base64, datetime, fcntl, json, os, pathlib, time, urllib.error, urllib.parse, urllib.request

import store

STRAVA_AUTHORIZE = "https://www.strava.com/oauth/authorize"
STRAVA_TOKEN = "https://www.strava.com/oauth/token"
STRAVA_API = "https://www.strava.com/api/v3"  # moves to https://www.api-v3.strava.com on 01-Jun-2027 (Strava's notice)
POLAR_AUTHORIZE = "https://flow.polar.com/oauth2/authorization"
POLAR_TOKEN = "https://polarremote.com/v2/oauth2/token"
POLAR_API = "https://www.polaraccesslink.com/v3"
STRAVA_SCOPE = "read,activity:read_all,profile:read_all"
MAX_BODY = 256 * 1024 * 1024
RETRIES = 3
BIO = ("bodytemperature", "ecg", "skincontacts", "skintemperature", "spo2")
BIO_EVERY_S = 7 * 86400  # their window is 28 days: weekly is complete and stores fewer overlapping copies
USAGE_STOP = 0.9  # stop a run at 90 % of the provider's short-window limit; the next timer run resumes


class RateLimited(Exception):
    pass


class AuthFailed(Exception):
    pass


class ProviderError(Exception):
    pass


def read_env_file(path):
    out = {}
    if path and pathlib.Path(path).is_file():
        for line in pathlib.Path(path).read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip("'\"")
    return out


class State:
    """<state>/tokens.json (0600), cursors.json, status.json. The directory is the unit's own 0700 state."""

    def __init__(self, path):
        self.dir = pathlib.Path(path)
        self.dir.mkdir(parents=True, exist_ok=True)
        os.chmod(self.dir, 0o700)

    def load(self, name):
        p = self.dir / f"{name}.json"
        try:
            return json.loads(p.read_text())
        except (OSError, ValueError):
            return {}

    def save(self, name, obj):
        p = self.dir / f"{name}.json"
        tmp = p.with_suffix(f".{os.getpid()}.tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(obj, f)
        os.replace(tmp, p)

    def update(self, name, key, value):
        """Read-modify-write under a lock: the job and the endpoint both write tokens."""
        with open(self.dir / ".lock", "w") as lk:
            fcntl.flock(lk, fcntl.LOCK_EX)
            d = self.load(name)
            d[key] = value
            self.save(name, d)


def request(url, method="GET", headers=None, form=None, body=None, usage=None):
    """-> (status, bytes, response headers). 204 and 404 are returned to the caller. Retries 5xx and network errors."""
    hdr = {"Accept": "application/json", "User-Agent": "saturn-fitness/1"}
    hdr.update(headers or {})
    data = body
    if form is not None:
        data = urllib.parse.urlencode(form).encode()
        hdr["Content-Type"] = "application/x-www-form-urlencoded"
    last = "network"
    for attempt in range(RETRIES):
        if attempt:
            time.sleep(2 ** attempt)
        req = urllib.request.Request(url, data=data, headers=hdr, method=method)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read(MAX_BODY + 1)
                if len(raw) > MAX_BODY:
                    raise ProviderError("response too large")
                if usage:
                    usage(r.headers)
                return r.status, raw, r.headers
        except urllib.error.HTTPError as e:
            if e.code == 429:
                raise RateLimited()
            if e.code in (401, 403):
                raise AuthFailed()
            if e.code in (404, 409):
                return e.code, b"", e.headers
            if e.code < 500:
                raise ProviderError(f"http {e.code}")
            last = f"http {e.code}"
        except (urllib.error.URLError, TimeoutError, OSError):
            last = "network"
    raise ProviderError(last)


def _short_window_guard(usage_h, limit_h):
    def check(headers):
        try:
            used = int(headers.get(usage_h, "").split(",")[0])
            limit = int(headers.get(limit_h, "").split(",")[0])
        except ValueError:
            return
        if limit and used >= USAGE_STOP * limit:
            raise RateLimited()
    return check


def _json(raw):
    try:
        return json.loads(raw)
    except ValueError:
        raise ProviderError("not JSON")


# ---- OAuth (the endpoint and the job share this) -------------------------------------------------------------------
def client(creds, provider):
    cid, secret = creds.get(f"{provider.upper()}_CLIENT_ID"), creds.get(f"{provider.upper()}_CLIENT_SECRET")
    return (cid, secret) if cid and secret else None


def authorize_url(provider, cid, redirect_uri, state):
    if provider == "strava":
        q = {"client_id": cid, "redirect_uri": redirect_uri, "response_type": "code", "approval_prompt": "auto",
             "scope": STRAVA_SCOPE, "state": state}
        return f"{STRAVA_AUTHORIZE}?{urllib.parse.urlencode(q)}"
    q = {"response_type": "code", "client_id": cid, "redirect_uri": redirect_uri, "scope": "accesslink.read_all", "state": state}
    return f"{POLAR_AUTHORIZE}?{urllib.parse.urlencode(q)}"


def _basic(cid, secret):
    return "Basic " + base64.b64encode(f"{cid}:{secret}".encode()).decode()


def exchange(provider, cid, secret, code, redirect_uri, st):
    """Authorization code -> stored token. The code is single-use and short-lived."""
    if provider == "strava":
        _, raw, _ = request(STRAVA_TOKEN, "POST", form={"client_id": cid, "client_secret": secret, "code": code,
                                                         "grant_type": "authorization_code"})
        t = _json(raw)
        token = {"access_token": t.get("access_token"), "refresh_token": t.get("refresh_token"),
                 "expires_at": t.get("expires_at"), "scope": t.get("scope")}
    else:
        _, raw, _ = request(POLAR_TOKEN, "POST", headers={"Authorization": _basic(cid, secret)},
                            form={"grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri})
        t = _json(raw)
        token = {"access_token": t.get("access_token"), "user_id": t.get("x_user_id")}
    if not token["access_token"]:
        raise ProviderError("no token in the response")
    st.update("tokens", provider, token)
    return token


def strava_access(cid, secret, st):
    t = st.load("tokens").get("strava")
    if not t:
        return None
    if int(t.get("expires_at") or 0) - time.time() > 300:
        return t["access_token"]
    _, raw, _ = request(STRAVA_TOKEN, "POST", form={"client_id": cid, "client_secret": secret, "grant_type": "refresh_token",
                                                     "refresh_token": t["refresh_token"]})
    n = _json(raw)
    if not n.get("access_token") or not n.get("refresh_token"):
        raise AuthFailed()
    # Strava: "the older one stops working": store the newest before anything can fail.
    t.update(access_token=n["access_token"], refresh_token=n["refresh_token"], expires_at=n.get("expires_at"))
    st.update("tokens", "strava", t)
    return t["access_token"]


# ---- pulls ----------------------------------------------------------------------------------------------------------
def pull_strava(root, ns, cid, secret, st, counts):
    token = strava_access(cid, secret, st)
    if not token:
        return "awaiting-authorisation"
    cur = st.load("cursors").get("strava", {})
    after = int(cur.get("after") or 0)
    auth = {"Authorization": f"Bearer {token}"}
    guard = _short_window_guard("X-ReadRateLimit-Usage", "X-ReadRateLimit-Limit")
    page = 1
    while True:
        _, raw, _ = request(f"{STRAVA_API}/athlete/activities?after={after}&per_page=100&page={page}", headers=auth, usage=guard)
        items = _json(raw)
        if not isinstance(items, list) or not items:
            break
        for it in items:
            aid, start = it.get("id"), it.get("start_date")
            if not isinstance(aid, int) or not store.is_date(start):
                counts["skipped"] += 1
                continue
            unix = int(datetime.datetime.fromisoformat(str(start).replace("Z", "+00:00")).timestamp())
            date = store.ist_date(unix)
            _, detail, _ = request(f"{STRAVA_API}/activities/{aid}", headers=auth, usage=guard)
            q = "keys=time,watts,heartrate,cadence&key_by_type=true"
            status, streams, _ = request(f"{STRAVA_API}/activities/{aid}/streams?{q}", headers=auth, usage=guard)
            if status == 200:
                store.store_raw(root, ns, "strava", "detail", date, str(aid), "json", streams)
            if store.store_raw(root, ns, "strava", "activity", date, str(aid), "json", detail)[1]:
                counts["new"] += 1
            after = max(after, unix)
            st.update("cursors", "strava", {"after": after})
        page += 1
    return "ok"


def _polar_list(url, auth, guard):
    status, raw, _ = request(url, headers=auth, usage=guard)
    if status in (204, 404):
        return None
    return _json(raw)


def _store_items(root, ns, kind, items, date_of, counts):
    for it in items if isinstance(items, list) else []:
        if not isinstance(it, dict):
            continue
        d = date_of(it)
        if d and store.is_date(d):
            raw = json.dumps(it, sort_keys=True, ensure_ascii=False).encode()
            if store.store_raw(root, ns, "polar", kind, d[:10], "", "json", raw)[1]:
                counts["new"] += 1


def pull_polar(root, ns, cid, secret, st, counts, today=None):
    t = st.load("tokens").get("polar")
    if not t:
        return "awaiting-authorisation"
    today = today or store.today_ist()
    yesterday = (datetime.date.fromisoformat(today) - datetime.timedelta(days=1)).isoformat()
    auth = {"Authorization": f"Bearer {t['access_token']}"}
    guard = _short_window_guard("RateLimit-Usage", "RateLimit-Limit")
    cur = st.load("cursors").get("polar", {})
    # Registration starts the data flow: Polar returns only exercises uploaded after the user is registered with the client.
    if not cur.get("registered"):
        member = f"saturn-{t.get('user_id') or 'owner'}"
        request(f"{POLAR_API}/users", "POST", headers={**auth, "Content-Type": "application/json"},
                body=json.dumps({"member-id": member}).encode())  # 409 = already registered
        cur["registered"] = True
        st.update("cursors", "polar", cur)
    # Exercises: last 30 days only; content-addressed, so the overlap is a no-op. The FIT goes first: a detail that is missing
    # after a failure is fetched again because the exercise was not stored yet.
    for ex in _polar_list(f"{POLAR_API}/exercises", auth, guard) or []:
        if not isinstance(ex, dict) or not ex.get("id"):
            continue
        unix = store.local_unix(ex.get("start_time"), ex.get("start_time_utc_offset"))
        if not unix:
            counts["skipped"] += 1
            continue
        date, eid = store.ist_date(unix), urllib.parse.quote(str(ex["id"]), safe="")
        if store.seen_group(root, ns, "polar", "activity", date, eid):
            continue
        st_fit, fit_bytes, _ = request(f"{POLAR_API}/exercises/{eid}/fit", headers={**auth, "Accept": "*/*"}, usage=guard)
        if st_fit == 200 and fit_bytes:
            store.store_raw(root, ns, "polar", "detail", date, eid, "fit", fit_bytes)
        store.store_raw(root, ns, "polar", "activity", date, eid, "json", json.dumps(ex, sort_keys=True).encode())
        counts["new"] += 1
    # Lists of the last 28 days. A finished night or day is immutable in practice; a changed payload supersedes.
    nights = _polar_list(f"{POLAR_API}/users/sleep", auth, guard)
    _store_items(root, ns, "sleep", (nights or {}).get("nights") if isinstance(nights, dict) else None, lambda i: i.get("date"), counts)
    rech = _polar_list(f"{POLAR_API}/users/nightly-recharge", auth, guard)
    _store_items(root, ns, "recharge", (rech or {}).get("recharges") if isinstance(rech, dict) else None, lambda i: i.get("date"), counts)
    _store_items(root, ns, "cardio", _polar_list(f"{POLAR_API}/users/cardio-load", auth, guard),
                 lambda i: i.get("date") if str(i.get("date")) <= yesterday else None, counts)
    _store_items(root, ns, "alertness", _polar_list(f"{POLAR_API}/users/sleepwise/alertness", auth, guard),
                 lambda i: i.get("period_end_time") or i.get("period_start_time"), counts)
    _store_items(root, ns, "circadian", _polar_list(f"{POLAR_API}/users/sleepwise/circadian-bedtime", auth, guard),
                 lambda i: i.get("period_end_time") or i.get("period_start_time"), counts)
    # Daily activity and continuous HR: finished days only (today is still changing). First run reaches back as far as Polar allows.
    start = cur.get("daily_from") or (datetime.date.fromisoformat(today) - datetime.timedelta(days=364)).isoformat()
    day = datetime.date.fromisoformat(start)
    end = datetime.date.fromisoformat(yesterday)
    while day <= end:
        to = min(day + datetime.timedelta(days=27), end)
        q = urllib.parse.urlencode({"from": day.isoformat(), "to": to.isoformat(), "steps": "true", "activity_zones": "true",
                                    "inactivity_stamps": "true"})
        _store_items(root, ns, "daily", _polar_list(f"{POLAR_API}/users/activities?{q}", auth, guard),
                     lambda i: i.get("start_time"), counts)
        q = urllib.parse.urlencode({"from": day.isoformat(), "to": to.isoformat()})
        h = _polar_list(f"{POLAR_API}/users/continuous-heart-rate?{q}", auth, guard)
        if isinstance(h, dict) and isinstance(h.get("heart_rates"), list):
            h = h["heart_rates"]
        _store_items(root, ns, "chr", h if isinstance(h, list) else ([h] if isinstance(h, dict) else None), lambda i: i.get("date"), counts)
        # Back up 2 days on the next run: a watch can sync late.
        cur["daily_from"] = max((to - datetime.timedelta(days=2)).isoformat(), cur.get("daily_from") or "")
        st.update("cursors", "polar", cur)
        day = to + datetime.timedelta(days=1)
    # Raw only: no stable roll-up yet, and clinical-looking readings need a decision of their own (ADR 015).
    if time.time() - float(cur.get("bio_at") or 0) >= BIO_EVERY_S:
        for name in BIO:
            items = _polar_list(f"{POLAR_API}/users/biosensing/{name}", auth, guard)
            if items:
                if store.store_raw(root, ns, "polar", "bio", today, name, "json", json.dumps(items, sort_keys=True).encode())[1]:
                    counts["new"] += 1
        cur["bio_at"] = int(time.time())
        st.update("cursors", "polar", cur)
    return "ok"


def pull(root, ns, state_dir, creds, sources, strava_api=False, today=None):
    """Exit-free: every source gets a state; nothing here fails the unit for a missing credential. -> status dict."""
    st = State(state_dir)
    status = st.load("status")
    out = {}
    for src in sources:
        counts = {"new": 0, "skipped": 0}
        c = client(creds, src)
        try:
            if src == "strava" and not strava_api:
                state = "disabled-terms"
            elif not c:
                state = "awaiting-credentials"
            elif src == "strava":
                state = pull_strava(root, ns, c[0], c[1], st, counts)
            else:
                state = pull_polar(root, ns, c[0], c[1], st, counts, today)
        except RateLimited:
            state = "rate-limited"
        except AuthFailed:
            state = "auth-failed"
        except ProviderError:
            state = "provider-error"
        row = dict(status.get(src) or {})
        row.update(state=state, last_run=int(time.time()), new=counts["new"], skipped=counts["skipped"])
        # A clean finish or a respectful stop both count as working; the next run continues from the cursor.
        if state in ("ok", "rate-limited"):
            row["last_success"] = row["last_run"]
        status[src] = row
        out[src] = state
    st.save("status", status)
    return status


def prom(status):
    """Metrics for the box: the freshness check stays green while nothing is connected yet."""
    live = [v for v in status.values() if v.get("state") not in ("awaiting-credentials", "awaiting-authorisation", "disabled-terms", None)]
    success = [v["last_success"] for v in status.values() if v.get("last_success")]
    lines = [f"saturn_fitness_awaiting {0 if live else 1}"]
    if success:
        lines.append(f"saturn_fitness_last_success_timestamp_seconds {max(success)}")
    return "\n".join(lines) + "\n"
