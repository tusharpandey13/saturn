"""Shared state of the "Run the loop" trigger (T-01): one JSON file plus a spool directory, under one file lock.

Layout of the state directory (owned by the job's user; PHI-free apart from namespaces and run-note paths):
  state.json        {"runs": [row, ...]}  one row per accepted request, newest last
  state.lock        flock target
  spool/<ns>.json   a queued request (the row); tools/dx/run takes the oldest and deletes it
  awaiting-key      marker written by the host when the job's deploy key is not registered yet
  dm/<ts>-<ns>.json a ready admin DM queued by a symptom card's button (POST /ask/<ns>); tools/dx/run sends it
  asks.json         {"asks": [{ns, card, by, requested_at}]} accepted DM requests (cap ASK_CAP_24H per rolling 24 h)
  runs/<id>/        the job's working files for one run (prompt, evidence pack, claude output): never committed

Row: {id, ns, by, requested_at, state, started_at, finished_at, note, commit, pushed, error, cost_usd, turns, rounds}
States: queued -> running -> done | failed | awaiting-key (committed locally, push refused).
Caps (owner defaults, ADR 013 §8 budget): CAP_24H accepted requests per rolling 24 h and CAP_30D per rolling 30 days,
counted over every accepted request (done, failed or still queued: a failed run spent tokens too). Scope "global"
counts all namespaces together; "ns" counts each namespace on its own.
"""
import contextlib, datetime, fcntl, json, pathlib, re

CAP_24H = 1
CAP_30D = 8
ASK_CAP_24H = 20       # ready DMs from symptom cards per rolling 24 h (all namespaces)
DM_MAX_AGE = datetime.timedelta(hours=24)  # an unsent DM older than this is dropped (logged)
WINDOWS = ((CAP_24H, datetime.timedelta(hours=24)), (CAP_30D, datetime.timedelta(days=30)))
ACTIVE = ("queued", "running")
STATES = ("queued", "running", "done", "failed", "awaiting-key")
NS_RE = re.compile(r"^[a-z][a-z0-9-]*$")
IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))


def utcnow():
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)


def iso(dt):
    return dt.isoformat().replace("+00:00", "Z")


def parse(s):
    return datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))


def run_id(ns, now):
    return f"{now.strftime('%Y%m%dT%H%M%SZ')}-{ns}"


class State:
    def __init__(self, root, cap_24h=CAP_24H, cap_30d=CAP_30D, scope="global"):
        self.root = pathlib.Path(root)
        self.windows = ((cap_24h, datetime.timedelta(hours=24)), (cap_30d, datetime.timedelta(days=30)))
        if scope not in ("global", "ns"):
            raise ValueError("scope must be global or ns")
        self.scope = scope
        self.spool = self.root / "spool"
        self.dm = self.root / "dm"
        self.root.mkdir(parents=True, exist_ok=True)
        self.spool.mkdir(exist_ok=True)
        self.dm.mkdir(exist_ok=True)
        (self.root / "runs").mkdir(exist_ok=True)

    # ---- lock and file
    @contextlib.contextmanager
    def locked(self):
        with open(self.root / "state.lock", "w") as fh:
            fcntl.flock(fh, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(fh, fcntl.LOCK_UN)

    def load(self):
        p = self.root / "state.json"
        if not p.is_file():
            return {"runs": []}
        return json.loads(p.read_text(encoding="utf-8"))

    def save(self, data):
        p = self.root / "state.json"
        tmp = p.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
        tmp.replace(p)

    def awaiting_key(self):
        return (self.root / "awaiting-key").exists()

    # ---- queries (call under the lock when the answer drives a write)
    def runs(self, ns=None, data=None):
        rows = (data or self.load())["runs"]
        return [r for r in rows if ns is None or r["ns"] == ns]

    def last(self, ns, data=None):
        rows = self.runs(ns, data)
        return rows[-1] if rows else None

    def active(self, ns, data=None):
        return [r for r in self.runs(ns, data) if r["state"] in ACTIVE]

    def cap_check(self, ns, now, data=None):
        """-> (ok, reason, next_allowed_at iso|None). Counts accepted requests in each rolling window."""
        rows = self.runs(None if self.scope == "global" else ns, data)
        worst = None
        for cap, window in self.windows:
            inside = sorted(parse(r["requested_at"]) for r in rows if now - parse(r["requested_at"]) < window)
            if len(inside) >= cap:
                free_at = inside[len(inside) - cap] + window  # when the oldest counted request leaves the window
                if worst is None or free_at > worst[0]:
                    worst = (free_at, cap, window)
        if worst is None:
            return True, None, None
        free_at, cap, window = worst
        span = f"{int(window.total_seconds() // 3600)} h" if window < datetime.timedelta(days=2) else f"{window.days} days"
        return False, f"cap reached: {cap} run(s) per {span}", iso(free_at)

    # ---- transitions
    def enqueue(self, ns, by, now=None):
        """-> (row, None) or (None, (http_status, reason, next_allowed_at)). Writes the row and the spool file."""
        now = now or utcnow()
        if not NS_RE.match(ns or ""):
            return None, (400, "bad namespace", None)
        with self.locked():
            data = self.load()
            if self.awaiting_key():
                return None, (503, "awaiting key: the job's deploy key is not registered yet", None)
            act = self.active(ns, data)
            if act:
                r = act[-1]
                return None, (409, f"already {r['state']} since {r.get('started_at') or r['requested_at']} (by {r['by']})", None)
            ok, reason, nxt = self.cap_check(ns, now, data)
            if not ok:
                last = self.last(ns, data) or self.last(None, data)
                when = f"; last run requested at {last['requested_at']} ({last['state']})" if last else ""
                return None, (409, f"{reason}{when}; next allowed at {nxt}", nxt)
            row = {"id": run_id(ns, now), "ns": ns, "by": by, "requested_at": iso(now), "state": "queued",
                   "started_at": None, "finished_at": None, "note": None, "commit": None, "pushed": False,
                   "error": None, "cost_usd": None, "turns": None, "rounds": None}
            data["runs"].append(row)
            self.save(data)
            (self.spool / f"{ns}.json").write_text(json.dumps(row) + "\n", encoding="utf-8")
            return row, None

    def take(self):
        """Job side: -> the oldest spool row (deleted from the spool, marked running) or None."""
        with self.locked():
            files = sorted(self.spool.glob("*.json"), key=lambda p: p.stat().st_mtime)
            if not files:
                return None
            row = json.loads(files[0].read_text(encoding="utf-8"))
            files[0].unlink()
            self._update(row["id"], state="running", started_at=iso(utcnow()))
            return self.find(row["id"])

    def update(self, rid, **fields):
        with self.locked():
            self._update(rid, **fields)

    def _update(self, rid, **fields):
        data = self.load()
        for r in data["runs"]:
            if r["id"] == rid:
                bad = set(fields) - set(r)
                if bad:
                    raise KeyError(f"unknown fields {sorted(bad)}")
                if "state" in fields and fields["state"] not in STATES:
                    raise ValueError(f"bad state {fields['state']}")
                r.update(fields)
                self.save(data)
                return r
        raise KeyError(rid)

    def find(self, rid):
        for r in self.load()["runs"]:
            if r["id"] == rid:
                return r
        return None

    def status(self, ns, now=None):
        """-> dict for GET /dx/<ns>/status."""
        now = now or utcnow()
        data = self.load()
        last = self.last(ns, data)
        ok, reason, nxt = self.cap_check(ns, now, data)
        return {"ns": ns, "state": (last or {}).get("state", "never"), "last_run": last, "awaiting_key": self.awaiting_key(),
                "can_run": ok and not self.active(ns, data) and not self.awaiting_key(), "cap_reason": reason, "next_allowed_at": nxt,
                "caps": {"per_24h": self.windows[0][0], "per_30d": self.windows[1][0], "scope": self.scope}}


    # ---- ready DMs from symptom cards (docs/design/symptom-context-card.md section 10)
    def enqueue_dm(self, ns, card, by, text, now=None, cap=ASK_CAP_24H):
        """-> (row, None) or (None, (http_status, reason)). Caps accepted asks per rolling 24 h; writes dm/<ts>-<ns>.json."""
        now = now or utcnow()
        if not NS_RE.match(ns or ""):
            return None, (400, "bad namespace")
        with self.locked():
            p = self.root / "asks.json"
            data = json.loads(p.read_text(encoding="utf-8")) if p.is_file() else {"asks": []}
            data["asks"] = [a for a in data["asks"] if now - parse(a["requested_at"]) < datetime.timedelta(days=2)]
            if sum(1 for a in data["asks"] if now - parse(a["requested_at"]) < datetime.timedelta(hours=24)) >= cap:
                return None, (429, f"cap reached: {cap} messages per 24 h")
            row = {"ns": ns, "card": card, "by": by, "requested_at": iso(now)}
            data["asks"].append(row)
            tmp = p.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(data, indent=1) + "\n", encoding="utf-8")
            tmp.replace(p)
            name = f"{now.strftime('%Y%m%dT%H%M%SZ')}-{len(data['asks']):03d}-{ns}.json"
            (self.dm / name).write_text(json.dumps(dict(row, text=text), ensure_ascii=False) + "\n", encoding="utf-8")
            return row, None

    def pending_dms(self):
        """Job side: [(path, row)] oldest first."""
        out = []
        for f in sorted(self.dm.glob("*.json")):
            try:
                out.append((f, json.loads(f.read_text(encoding="utf-8"))))
            except ValueError:
                f.unlink()
        return out
