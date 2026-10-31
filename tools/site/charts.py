"""Inline SVG charts for the health site, computed at build time (design 6.3). Stdlib only, no JS.

Colours come from CSS classes in style.css (no inline styles): .band (the lab's range), .track, .ln (one lab's line),
.mk (a marker), .mk.flag (a value the lab flagged: the only amber), .mk.prev (hollow previous value), .grid.
Points: dicts with t (datetime.date), v (number), lo/hi (that result's own printed range or None), lab (key for the
marker shape and line breaks), flag (True when the lab printed/bolded H or L), label (title text).
"""
import html

SHAPES = ("circle", "square", "diamond", "triangle")


def _fmt(v):
    s = f"{v:.2f}".rstrip("0").rstrip(".") if isinstance(v, float) else str(v)
    return s


def _scale(lo, hi, a, b):
    if hi == lo:
        hi, lo = hi + 1, lo - 1
    return lambda v: a + (v - lo) * (b - a) / (hi - lo)


def _domain(values, ranges, pad=0.08):
    vals = [v for v in values if v is not None]
    for lo, hi in ranges:
        vals += [x for x in (lo, hi) if x is not None]
    if not vals:
        return 0, 1
    lo, hi = min(vals), max(vals)
    span = (hi - lo) or abs(hi) or 1
    out_lo = lo - span * pad
    return (max(out_lo, 0) if lo >= 0 else out_lo), hi + span * pad


def marker(shape, x, y, cls, r=4.0, title=None):
    t = f"<title>{html.escape(title)}</title>" if title else ""
    if shape == "square":
        return f'<rect class="{cls}" x="{x - r:.1f}" y="{y - r:.1f}" width="{2 * r:.1f}" height="{2 * r:.1f}">{t}</rect>'
    if shape == "diamond":
        r *= 1.25
        return f'<path class="{cls}" d="M{x:.1f},{y - r:.1f} L{x + r:.1f},{y:.1f} L{x:.1f},{y + r:.1f} L{x - r:.1f},{y:.1f} Z">{t}</path>'
    if shape == "triangle":
        r *= 1.2
        return f'<path class="{cls}" d="M{x:.1f},{y - r:.1f} L{x + r:.1f},{y + r * .8:.1f} L{x - r:.1f},{y + r * .8:.1f} Z">{t}</path>'
    return f'<circle class="{cls}" cx="{x:.1f}" cy="{y:.1f}" r="{r:.1f}">{t}</circle>'


def range_bar(value, lo, hi, prev=None, flagged=False, label=""):
    """Number line: grey track, the lab's band, today's dot (amber only if the lab flagged it), previous as hollow."""
    W, H, y = 300, 34, 12
    upper_only = lo is None and hi is not None
    dlo, dhi = _domain([value, prev], [(0 if upper_only else lo, hi)], pad=0.15)
    if upper_only:
        dlo = min(0, dlo)
    x = _scale(dlo, dhi, 6, W - 6)
    parts = [f'<svg class="rb" viewBox="0 0 {W} {H}" role="img" aria-label="{html.escape(label)}">',
             f'<rect class="track" x="0" y="{y - 4}" width="{W}" height="8" rx="4"/>']
    if lo is not None or hi is not None:
        a = x(lo) if lo is not None else 0
        b = x(hi) if hi is not None else W
        parts.append(f'<rect class="band" x="{a:.1f}" y="{y - 4}" width="{max(b - a, 2):.1f}" height="8" rx="4"/>')
        if lo is not None:
            parts.append(f'<text x="{a:.1f}" y="{H - 2}" text-anchor="middle" class="tick">{_fmt(lo)}</text>')
        if hi is not None:
            parts.append(f'<text x="{b:.1f}" y="{H - 2}" text-anchor="middle" class="tick">{_fmt(hi)}</text>')
    if prev is not None:
        parts.append(marker("circle", x(prev), y, "mk prev", 4.5, f"previous {_fmt(prev)}"))
    parts.append(marker("circle", x(value), y, "mk now flag" if flagged else "mk now", 5.5, f"{_fmt(value)}"))
    parts.append("</svg>")
    return "".join(parts)


def sparkline(points, W=80, H=28):
    """Band of the latest range, the line, the last dot (amber only if flagged)."""
    pts = [p for p in points if p.get("v") is not None]
    if not pts:
        return ""
    last = pts[-1]
    dlo, dhi = _domain([p["v"] for p in pts], [(last.get("lo"), last.get("hi"))])
    y = _scale(dlo, dhi, H - 4, 4)
    if len(pts) == 1:
        xs = [W - 6]
    else:
        t0, t1 = pts[0]["t"].toordinal(), pts[-1]["t"].toordinal()
        xs = [4 + (p["t"].toordinal() - t0) * (W - 10) / ((t1 - t0) or 1) for p in pts]
    parts = [f'<svg class="spark" viewBox="0 0 {W} {H}" aria-hidden="true">']
    lo, hi = last.get("lo"), last.get("hi")
    if lo is not None or hi is not None:
        a = y(hi) if hi is not None else 0
        b = y(lo) if lo is not None else H
        parts.append(f'<rect class="band" x="0" y="{a:.1f}" width="{W}" height="{max(b - a, 1):.1f}"/>')
    if len(pts) > 1:
        d = " ".join(f"{'M' if i == 0 else 'L'}{xs[i]:.1f},{y(p['v']):.1f}" for i, p in enumerate(pts))
        parts.append(f'<path class="ln" d="{d}"/>')
    parts.append(marker("circle", xs[-1], y(last["v"]), "mk flag" if last.get("flag") else "mk", 3.5))
    parts.append("</svg>")
    return "".join(parts)


def trend_chart(series, unit="", W=340, H=200):
    """series: list of (name, points). One line per lab within a series (labs never joined), a step band per result,
    marker shape per lab, flagged points amber, only the last value labelled. Several series share one axis (BP)."""
    allp = [p for _, pts in series for p in pts if p.get("v") is not None]
    if not allp:
        return ""
    L, R, T, B = 40, 14, 12, 26
    dlo, dhi = _domain([p["v"] for p in allp], [(p.get("lo"), p.get("hi")) for p in allp])
    y = _scale(dlo, dhi, H - B, T)
    t0 = min(p["t"] for p in allp).toordinal()
    t1 = max(p["t"] for p in allp).toordinal()
    span = (t1 - t0) or 1
    x = (lambda t: L + (t.toordinal() - t0) * (W - L - R) / span) if t1 != t0 else (lambda t: (L + W - R) / 2)
    out = [f'<svg class="trend" viewBox="0 0 {W} {H}" role="img" aria-label="trend chart; the table below has every value">']
    for k in range(5):  # recessive grid, 4 intervals
        v = dlo + (dhi - dlo) * k / 4
        out.append(f'<line class="grid" x1="{L}" x2="{W - R}" y1="{y(v):.1f}" y2="{y(v):.1f}"/>'
                   f'<text class="tick" x="{L - 4}" y="{y(v) + 4:.1f}" text-anchor="end">{_fmt(round(v, 2))}</text>')
    out.append(f'<text class="tick" x="{L}" y="{H - 6}">{_d(min(p["t"] for p in allp))}</text>'
               f'<text class="tick" x="{W - R}" y="{H - 6}" text-anchor="end">{_d(max(p["t"] for p in allp))}</text>')
    # step band: each result's own printed range, from its x to the next result's x
    pts_sorted = sorted(allp, key=lambda p: p["t"])
    if len(series) == 1:
        for i, p in enumerate(pts_sorted):
            lo, hi = p.get("lo"), p.get("hi")
            if lo is None and hi is None:
                continue
            xa = x(p["t"]) if i else L
            xb = x(pts_sorted[i + 1]["t"]) if i + 1 < len(pts_sorted) else W - R
            a = y(hi) if hi is not None else T
            b = y(lo) if lo is not None else H - B
            out.append(f'<rect class="band" x="{xa:.1f}" y="{a:.1f}" width="{max(xb - xa, 2):.1f}" height="{max(b - a, 1):.1f}"/>')
    labs = []
    for _, pts in series:
        for p in pts:
            if p.get("lab") not in labs:
                labs.append(p.get("lab"))
    for si, (name, pts) in enumerate(series):
        pts = [p for p in sorted(pts, key=lambda p: p["t"]) if p.get("v") is not None]
        for lab in labs:
            lp = [p for p in pts if p.get("lab") == lab]
            if len(lp) > 1:
                d = " ".join(f"{'M' if i == 0 else 'L'}{x(p['t']):.1f},{y(p['v']):.1f}" for i, p in enumerate(lp))
                out.append(f'<path class="ln s{si}" d="{d}"/>')
        for p in pts:
            k = labs.index(p.get("lab"))
            shape = SHAPES[k % len(SHAPES)]
            hollow = " hollow" if (k // len(SHAPES)) % 2 else ""
            out.append(marker(shape, x(p["t"]), y(p["v"]), ("mk flag" if p.get("flag") else "mk") + hollow,
                              4.0, p.get("label") or f"{_fmt(p['v'])} {unit}"))
        if pts:
            lp = pts[-1]
            out.append(f'<text class="last" x="{min(x(lp["t"]) + 6, W - R):.1f}" y="{y(lp["v"]) - 7:.1f}" '
                       f'text-anchor="end">{_fmt(lp["v"])}</text>')
    out.append("</svg>")
    return "".join(out)


def legend(labs):
    """Marker shape per lab, as HTML (shapes as tiny SVGs)."""
    items = []
    for i, lab in enumerate(labs):
        svg = f'<svg class="lg" viewBox="0 0 12 12" aria-hidden="true">{marker(SHAPES[i % len(SHAPES)], 6, 6, "mk hollow" if (i // len(SHAPES)) % 2 else "mk", 4)}</svg>'
        items.append(f"<span>{svg}{html.escape(lab or 'source not recorded')}</span>")
    return '<div class="legend">' + "".join(items) + "</div>"


def _d(t):
    return t.strftime("%b %Y")
