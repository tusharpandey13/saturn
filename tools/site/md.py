"""Minimal Markdown -> HTML for the health site's Wiki pages (stdlib only).

Covers what the records pages use: front matter (dropped), ATX headings (with GitHub-style ids), paragraphs, nested
lists, tables, blockquotes, fenced code, horizontal rules, code spans, bold, italic and links. Raw HTML is escaped,
HTML comments (the gen:NAME markers) are dropped. Links go through a callback that maps a target to a site-relative
href or None (then only the text is kept). Bare http(s) URLs are never emitted as links or with their scheme: the
site makes no third-party requests and its output carries no external URL (design section 9).
"""
import html, re

URL_RE = re.compile(r"\bhttps?://", re.I)
_INLINE = re.compile(
    r"(?P<code>`+)(?P<ctext>.+?)(?P=code)"
    r"|\[(?P<ltext>[^\]]+)\]\((?P<lurl>[^)\s]+)(?:\s+\"[^\"]*\")?\)"
    r"|<(?P<auto>https?://[^>\s]+)>"
    r"|\*\*(?P<b>.+?)\*\*"
    r"|__(?P<b2>[^_].*?)__"
    r"|(?<![\w*])\*(?P<i>[^*\s][^*]*?)\*(?![\w*])"
    r"|(?<![\w_])_(?P<i2>[^_\s][^_]*?)_(?![\w_])",
    re.S)


def slug(text):
    """GitHub-style heading anchor: lowercase, drop punctuation except - and _, spaces -> -."""
    t = re.sub(r"<[^>]+>", "", text).strip().lower()
    t = re.sub(r"[^\w\- ]", "", t, flags=re.U)
    return t.replace(" ", "-")


def strip_scheme(text):
    """Visible text with no http(s):// (domains stay readable, nothing is fetched or linked)."""
    return URL_RE.sub("", text)


def inline(text, link=None):
    """Inline markdown -> escaped HTML. link(target) -> href or None."""
    out, pos = [], 0
    for m in _INLINE.finditer(text):
        out.append(html.escape(strip_scheme(text[pos:m.start()]), quote=False))
        pos = m.end()
        if m.group("code"):
            c = m.group("ctext").strip()
            href = link(c) if link and re.match(r"^[\w./-]+\.\w+(#[\w-]+)?$", c) else None
            body = f"<code>{html.escape(strip_scheme(c), quote=False)}</code>"
            out.append(f'<a href="{html.escape(href)}">{body}</a>' if href else body)
        elif m.group("ltext") is not None:
            href = link(m.group("lurl")) if link else None
            body = inline(m.group("ltext"), None)
            out.append(f'<a href="{html.escape(href)}">{body}</a>' if href else body)
        elif m.group("auto"):
            out.append(html.escape(strip_scheme(m.group("auto")), quote=False))
        elif m.group("b") is not None or m.group("b2") is not None:
            out.append(f"<b>{inline(m.group('b') or m.group('b2'), link)}</b>")
        else:
            out.append(f"<i>{inline(m.group('i') or m.group('i2'), link)}</i>")
    out.append(html.escape(strip_scheme(text[pos:]), quote=False))
    return re.sub(r"&lt;br\s*/?&gt;", "<br>", "".join(out))  # the one raw tag the records pages use in tables


def split_front_matter(text):
    """-> (front matter dict of raw strings, body)."""
    if text.startswith("---\n"):
        end = text.find("\n---", 4)
        if end != -1:
            fm = {}
            for line in text[4:end].splitlines():
                m = re.match(r"^([A-Za-z_]+):\s*(.*)$", line)
                if m:
                    fm[m.group(1)] = m.group(2).strip().strip("\"'")
            return fm, text[end + 4:].lstrip("\n")
    return {}, text


def _cells(line):
    line = line.strip()
    if line.startswith("|"):
        line = line[1:]
    if line.endswith("|") and not line.endswith("\\|"):
        line = line[:-1]
    return [c.strip().replace("\\|", "|") for c in re.split(r"(?<!\\)\|", line)]


def render(text, link=None):
    """Markdown body -> HTML string."""
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    lines = text.splitlines()
    out, i, n = [], 0, len(lines)
    para = []

    def flush_para():
        if para:
            out.append(f"<p>{inline(' '.join(s.strip() for s in para), link)}</p>")
            para.clear()

    while i < n:
        line = lines[i]
        s = line.strip()
        if not s:
            flush_para()
            i += 1
            continue
        if s.startswith("```"):
            flush_para()
            j = i + 1
            while j < n and not lines[j].strip().startswith("```"):
                j += 1
            out.append("<pre><code>" + html.escape(strip_scheme("\n".join(lines[i + 1:j])), quote=False) +
                       "</code></pre>")
            i = j + 1
            continue
        m = re.match(r"^(#{1,6})\s+(.*?)\s*#*$", s)
        if m:
            flush_para()
            lvl = min(len(m.group(1)) + 1, 6)  # page title is the site's h1
            out.append(f'<h{lvl} id="{html.escape(slug(m.group(2)))}">{inline(m.group(2), link)}</h{lvl}>')
            i += 1
            continue
        if re.match(r"^(-{3,}|\*{3,}|_{3,})$", s):
            flush_para()
            out.append("<hr>")
            i += 1
            continue
        if s.startswith("|") and i + 1 < n and re.match(r"^\|?\s*:?-{2,}", lines[i + 1].strip()):
            flush_para()
            head = _cells(s)
            rows = []
            i += 2
            while i < n and lines[i].strip().startswith("|"):
                rows.append(_cells(lines[i]))
                i += 1
            t = ["<div class=\"tw\"><table><thead><tr>" + "".join(f"<th>{inline(h, link)}</th>" for h in head) +
                 "</tr></thead><tbody>"]
            for r in rows:
                t.append("<tr>" + "".join(f"<td>{inline(c, link)}</td>" for c in r) + "</tr>")
            out.append("".join(t) + "</tbody></table></div>")
            continue
        if s.startswith(">"):
            flush_para()
            buf = []
            while i < n and lines[i].strip().startswith(">"):
                buf.append(lines[i].strip()[1:].lstrip())
                i += 1
            out.append(f"<blockquote>{render(chr(10).join(buf), link)}</blockquote>")
            continue
        if re.match(r"^\s*([-*+]|\d+[.)])\s+", line):
            flush_para()
            block = []
            while i < n and (lines[i].strip() == "" and i + 1 < n and re.match(r"^\s+\S|^\s*([-*+]|\d+[.)])\s", lines[i + 1])
                             or re.match(r"^\s*([-*+]|\d+[.)])\s+", lines[i]) or (lines[i].startswith(" ") and lines[i].strip())):
                block.append(lines[i])
                i += 1
            out.append(_list(block, link))
            continue
        para.append(line)
        i += 1
    flush_para()
    return "\n".join(out)


def _list(block, link):
    """A list block (lines with markers and continuation lines) -> nested <ul>/<ol>."""
    base = len(block[0]) - len(block[0].lstrip())
    ordered = bool(re.match(r"^\s*\d+[.)]\s", block[0]))
    items, cur = [], None
    for line in block:
        ind = len(line) - len(line.lstrip())
        m = re.match(r"^\s*([-*+]|\d+[.)])\s+(.*)$", line)
        if m and ind <= base + 1:
            cur = [m.group(2)]
            items.append(cur)
        elif cur is not None:
            cur.append(line[base + 2:] if len(line) > base + 2 and not line[:base + 2].strip() else line.strip())
    tag = "ol" if ordered else "ul"
    parts = []
    for it in items:
        first, rest = it[0], it[1:]
        nested = [r for r in rest]
        if nested and any(re.match(r"^\s*([-*+]|\d+[.)])\s+", r) for r in nested):
            k = next(idx for idx, r in enumerate(nested) if re.match(r"^\s*([-*+]|\d+[.)])\s+", r))
            text = " ".join([first] + [r.strip() for r in nested[:k] if r.strip()])
            parts.append(f"<li>{inline(text, link)}{render(chr(10).join(nested[k:]), link)}</li>")
        else:
            text = " ".join([first] + [r.strip() for r in nested if r.strip()])
            parts.append(f"<li>{inline(text, link)}</li>")
    return f"<{tag}>" + "".join(parts) + f"</{tag}>"
