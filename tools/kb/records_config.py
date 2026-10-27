"""Records manifest loader shared by tools/kb/build and tools/kb/gen-views (stdlib only).

A records repo carries `records.yaml` at its root (split plan section 9: namespaces are data, not code):
  schema_version: 7
  namespaces: [{id, display, shared?}]   # KB namespaces; ids <ns>:<class>:<local>
  d1_person_map: {<d1 person id>: <ns>}  # optional; Telegram batch person id -> KB namespace
  context_consent: {<ns>: true|false|pending}  # optional; ADR 010 life-context consent
Only that YAML subset is parsed (scalars, one nested map, a list of flat maps); anything else is an error.
"""
import pathlib, re

SUPPORTED_SCHEMA_VERSIONS = (7,)
NS_RE = re.compile(r"^[a-z][a-z0-9-]*$")
RESERVED_NS = {"ref"}


class RecordsError(Exception):
    pass


def _scalar(v):
    v = v.split(" #")[0].strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        return v[1:-1]
    if re.fullmatch(r"-?\d+", v):
        return int(v)
    return {"true": True, "false": False, "null": None, "": None}.get(v, v)


def parse_yaml_subset(text, where="records.yaml"):
    out, key, item = {}, None, None
    for n, raw in enumerate(text.splitlines(), 1):
        line = raw.rstrip()
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        body = line.strip()
        if indent == 0:
            m = re.match(r"^([A-Za-z0-9_]+):(.*)$", body)
            if not m:
                raise RecordsError(f"{where}:{n}: unparsable line")
            key, val = m.group(1), _scalar(m.group(2))
            out[key] = val
            item = None
            continue
        if key is None:
            raise RecordsError(f"{where}:{n}: indented line without a key")
        m = re.match(r"^(- )?([A-Za-z0-9_.-]+):(.*)$", body)
        if not m:
            raise RecordsError(f"{where}:{n}: unparsable line")
        if m.group(1):  # list of maps
            if out[key] is None:
                out[key] = []
            if not isinstance(out[key], list):
                raise RecordsError(f"{where}:{n}: {key} mixes a list and a map")
            item = {}
            out[key].append(item)
            item[m.group(2)] = _scalar(m.group(3))
        elif item is not None:
            item[m.group(2)] = _scalar(m.group(3))
        else:  # nested map
            if out[key] is None:
                out[key] = {}
            if not isinstance(out[key], dict):
                raise RecordsError(f"{where}:{n}: {key} mixes a map and a list")
            out[key][m.group(2)] = _scalar(m.group(3))
    return out


def load(records_dir):
    """-> dict(schema_version, namespaces (tuple of ids), persons (non-shared ids), display {ns: name}, d1_person_map)."""
    path = pathlib.Path(records_dir) / "records.yaml"
    if not path.is_file():
        raise RecordsError(f"{path}: not found (is --records a records repo?)")
    y = parse_yaml_subset(path.read_text(encoding="utf-8"), str(path))
    ver = y.get("schema_version")
    if ver not in SUPPORTED_SCHEMA_VERSIONS:
        raise RecordsError(f"{path}: schema_version {ver!r} not supported (this product reads {SUPPORTED_SCHEMA_VERSIONS})")
    nss = y.get("namespaces") or []
    if not isinstance(nss, list) or not nss:
        raise RecordsError(f"{path}: namespaces must be a non-empty list")
    ids = []
    for ns in nss:
        i = ns.get("id")
        if not isinstance(i, str) or not NS_RE.match(i) or i in RESERVED_NS or i in ids:
            raise RecordsError(f"{path}: bad or duplicate namespace id {i!r}")
        ids.append(i)
    d1 = y.get("d1_person_map") or {}
    for k, v in d1.items():
        if v not in ids:
            raise RecordsError(f"{path}: d1_person_map {k} -> {v!r} is not a namespace")
    return {
        "schema_version": ver,
        "namespaces": tuple(ids),
        "persons": tuple(ns["id"] for ns in nss if not ns.get("shared")),
        "display": {ns["id"]: ns.get("display") or ns["id"] for ns in nss},
        "d1_person_map": dict(d1),
        # ADR 010: {ns: True | False | "pending"}; only True lets a view show that member's context bands
        "context_consent": dict(y.get("context_consent") or {}),
    }


def id_regex(namespaces):
    alt = "|".join(re.escape(n) for n in namespaces)
    return re.compile(r"^(?:(?P<ns>" + alt + r"):(?P<cls>src|fact)|(?P<refns>ref):(?P<refkind>drug|code|party))"
                      r":(?P<local>[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$")
