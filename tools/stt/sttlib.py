"""Shared helpers for tools/stt, tools/stt-eval and tools/answers (stdlib only; run the tools with `python3 -I`).

- Normalisation for scoring and support checks: Devanagari -> Latin (simple map) + variant merging (documented in
  tools/stt/README.md "Normalisation").
- Transcript files: parse the timed lines of `.mac.transcript.md` / `.batch.transcript.md` sections.
- Opus calls: `claude -p --model M --tools ""` with a JSON schema, an empty scratch cwd and an allowlisted env
  (model auth, locale, paths only). Never log prompt or output text.
"""
import json, os, re, shutil, subprocess, tempfile, unicodedata

OPUS = "claude-opus-5-5"
CLAUDE_ENV_ALLOW = ("PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "TZ", "CLAUDE_CODE_OAUTH_TOKEN",
                    "ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "NODE_EXTRA_CA_CERTS")
AUDIO_EXT = (".ogg", ".oga", ".m4a", ".mp3", ".wav", ".opus")
FACTS_LINE = "Facts as written; not advice; doctors decide."


# ---------------------------------------------------------------- normalisation
_V = {"अ": "a", "आ": "aa", "इ": "i", "ई": "ii", "उ": "u", "ऊ": "uu", "ऋ": "ri", "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au",
      "ऑ": "o", "ऍ": "e", "ॲ": "e"}
_M = {"ा": "aa", "ि": "i", "ी": "ii", "ु": "u", "ू": "uu", "ृ": "ri", "े": "e", "ै": "ai", "ो": "o", "ौ": "au", "ॉ": "o",
      "ॅ": "e", "ॆ": "e", "ॊ": "o"}
_C = {"क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "n", "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "n",
      "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n", "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
      "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m", "य": "y", "र": "r", "ल": "l", "व": "v", "श": "sh",
      "ष": "sh", "स": "s", "ह": "h", "ळ": "l", "क़": "k", "ख़": "kh", "ग़": "g", "ज़": "z", "ड़": "r", "ढ़": "rh", "फ़": "f", "य़": "y"}
_D = {"०": "0", "१": "1", "२": "2", "३": "3", "४": "4", "५": "5", "६": "6", "७": "7", "८": "8", "९": "9"}
VIRAMA, NUKTA = "्", "़"


def deva_to_latin(text: str) -> str:
    """Simple Devanagari -> Latin map. Inherent 'a' after a consonant unless a matra/virama follows; the word-final
    inherent 'a' is dropped (Hindi schwa deletion, simplified). Anusvara/chandrabindu -> 'n', visarga -> 'h'."""
    text = unicodedata.normalize("NFC", text)
    text = unicodedata.normalize("NFD", text).replace(NUKTA, "")  # क़ -> क (nukta variants merged)
    out, i, n = [], 0, len(text)
    while i < n:
        c = text[i]
        if c in _C:
            out.append(_C[c])
            nxt = text[i + 1] if i + 1 < n else ""
            if nxt == VIRAMA:
                i += 2
                continue
            if nxt in _M:
                out.append(_M[nxt])
                i += 2
                continue
            word_end = not nxt or not ("\u0900" <= nxt <= "\u097f") or nxt in "।॥"
            if not word_end:
                out.append("a")  # inherent vowel (also before anusvara/visarga); dropped at the word end
            i += 1
            continue
        if c in _V:
            out.append(_V[c])
        elif c in _M:
            out.append(_M[c])
        elif c in "ंँ":
            out.append("n")
        elif c == "ः":
            out.append("h")
        elif c in _D:
            out.append(_D[c])
        elif c in "।॥":
            out.append(" ")
        elif c == VIRAMA:
            pass
        else:
            out.append(c)
        i += 1
    return "".join(out)


_VARIANTS = [(r"ph", "f"), (r"ch", "x"), (r"c", "k"), (r"(?<=[kgxjtdpbr])h", ""), (r"sh", "s"), (r"w", "v"), (r"z", "j"),
             (r"q", "k"), (r"ee|ii", "i"), (r"oo|uu", "u"), (r"([a-z])\1+", r"\1"), (r"ai|ay", "a"), (r"au", "o"),
             (r"(?<=[aeiou])n\b", "")]


def norm_words(text: str) -> list:
    """Words for scoring: bracketed annotations dropped, Devanagari -> Latin, lowercase, punctuation out, then
    variant merging, in this order: ph -> f, ch -> x (kept apart from k), other c -> k, aspiration h after a stop or
    r dropped, sh -> s, w -> v, z -> j, q -> k, long vowels (ee/ii, oo/uu) shortened, doubled letters single,
    ai/ay -> a, au -> o, word-final nasal n after a vowel dropped."""
    text = re.sub(r"\[[^\]]*\]|\(\?\)", " ", text)
    t = deva_to_latin(text).lower()
    t = unicodedata.normalize("NFKD", t)
    t = "".join(ch for ch in t if not unicodedata.combining(ch))
    t = re.sub(r"[^a-z0-9\s]", " ", t)
    words = []
    for w in t.split():
        for pat, rep in _VARIANTS:
            w = re.sub(pat, rep, w)
        if w:
            words.append(w)
    return words


def norm_text(text: str) -> str:
    return " ".join(norm_words(text))


def edit_distance(a, b) -> int:
    """Levenshtein distance over sequences (chars or words)."""
    if len(a) < len(b):
        a, b = b, a
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        cur = [i]
        for j, y in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x != y)))
        prev = cur
    return prev[-1]


def similar(a: str, b: str) -> float:
    """1 - normalised edit distance between two normalised words."""
    if not a or not b:
        return 0.0
    return 1 - edit_distance(a, b) / max(len(a), len(b))


# ---------------------------------------------------------------- transcript files
def ts(sec: float) -> str:
    m = int(sec // 60)
    return f"{m:02d}:{sec - m * 60:04.1f}"


def parse_ts(s: str) -> float:
    m, rest = s.split(":")
    return int(m) * 60 + float(rest)


LINE_RE = re.compile(r"^\[(\d+:\d\d\.\d) → (\d+:\d\d\.\d)\](?: \[([^\]]+)\])? (.*)$")


def front_matter(md: str) -> dict:
    """Flat `key: value` front matter (values unquoted when JSON strings)."""
    if not md.startswith("---\n"):
        return {}
    end = md.find("\n---", 4)
    out = {}
    for line in md[4:end].splitlines():
        m = re.match(r"^([A-Za-z_][\w-]*):\s*(.*)$", line)
        if m:
            v = m.group(2).strip()
            if v.startswith('"'):
                try:
                    v = json.loads(v)
                except ValueError:
                    pass
            out[m.group(1)] = v
    return out


def sections(md: str) -> dict:
    """{heading (## level, text after '## '): [timed line dicts]} for every section with timed lines."""
    out, cur = {}, None
    for line in md.splitlines():
        if line.startswith("## "):
            cur = line[3:].strip()
            continue
        m = LINE_RE.match(line)
        if cur and m:
            out.setdefault(cur, []).append({"start": parse_ts(m.group(1)), "end": parse_ts(m.group(2)),
                                            "speaker": m.group(3), "text": m.group(4).strip()})
    return out


def section(md: str, prefix: str) -> list:
    for k, v in sections(md).items():
        if k.lower().startswith(prefix.lower()):
            return v
    return []


# ---------------------------------------------------------------- Opus (claude CLI)
class LlmError(Exception):
    pass


def claude_env() -> dict:
    env = {k: os.environ[k] for k in CLAUDE_ENV_ALLOW if os.environ.get(k)}
    env["DISABLE_AUTOUPDATER"] = "1"
    return env


def call_claude(system: str, prompt: str, schema: dict, model: str = OPUS, effort: str = "medium", timeout: int = 900,
                bin_: str = None) -> tuple:
    """One structured call. Returns (structured_output, usage dict). Raises LlmError(reason) with no content.
    Test seam: env SATURN_STT_FAKE_CLAUDE = path to an executable that replaces `claude`."""
    exe = bin_ or os.environ.get("SATURN_STT_FAKE_CLAUDE") or shutil.which("claude") or "claude"
    args = [exe, "-p", "--model", model, "--effort", effort, "--tools", "", "--max-turns", "1",
            "--system-prompt", system, "--json-schema", json.dumps(schema), "--no-session-persistence",
            "--strict-mcp-config", "--disable-slash-commands", "--output-format", "json"]
    cwd = tempfile.mkdtemp(prefix="saturn-stt-claude-")
    try:
        p = subprocess.run(args, input=prompt, capture_output=True, text=True, cwd=cwd, env=claude_env(), timeout=timeout)
    except subprocess.TimeoutExpired:
        raise LlmError("timeout")
    except OSError:
        raise LlmError("spawn_failed")
    finally:
        shutil.rmtree(cwd, ignore_errors=True)
    res = None
    for line in p.stdout.splitlines():
        try:
            j = json.loads(line)
        except ValueError:
            continue
        if isinstance(j, dict) and j.get("type") == "result":
            res = j
    if not res:
        raise LlmError(f"no_result_exit_{p.returncode}")
    if res.get("is_error"):
        txt = str(res.get("result", ""))
        if re.search(r"not logged in|authenticat|oauth|api key", txt, re.I):
            raise LlmError("auth_failed")
        if re.search(r"rate.?limit|usage limit|hit your limit", txt, re.I):
            raise LlmError("rate_limited")
        raise LlmError(str(res.get("terminal_reason") or res.get("subtype") or "error"))
    out = res.get("structured_output")
    if out is None:
        raise LlmError("no_structured_output")
    u = res.get("usage") or {}
    return out, {"cost_usd": res.get("total_cost_usd") or 0, "output_tokens": u.get("output_tokens", 0)}
