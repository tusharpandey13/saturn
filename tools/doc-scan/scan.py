#!/usr/bin/env python3
"""Turn top-down videos of document pages into page images, PDFs and a manifest.

Usage: python3 -I tools/doc-scan/scan.py VIDEO [VIDEO ...] --out DIR
(run with tools/doc-scan/.venv/bin/python, or activate the venv first)
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import img2pdf
import numpy as np

FFMPEG = shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"
FFPROBE = shutil.which("ffprobe") or "/opt/homebrew/bin/ffprobe"

ANALYSIS_W = 480          # analysis frame width (px)
STILL_DIFF = 3.0          # mean abs grey diff (0-255) below which a frame is "still"
MIN_STILL_S = 0.7         # minimum still duration
# Separator = a large coloured sheet or cover: share of frame in the colour > ratio.
# hues: OpenCV HSV ranges (0-179). "green" is broad (yellow-green to teal) so a printed
# notebook cover counts: on clip 0185 the cover measured 0.19-0.21, pages with green
# letterheads <= 0.04. Red keeps its stricter saturation/ratio so hands don't trigger it.
SEPARATOR_COLOURS = {
    "red": {"hues": ((0, 10), (170, 180)), "s_min": 100, "v_min": 70, "ratio": 0.30},
    "green": {"hues": ((25, 90),), "s_min": 60, "v_min": 50, "ratio": 0.12},
}
SEPARATORS = ("red", "green")
PAPER_S_MAX = 50          # paper = low saturation ...
PAPER_V_MIN = 100         # ... and not dark (beige/wood backgrounds are saturated)
MIN_PAGE_AREA = 0.08      # page quad must cover this share of the frame
SHARP_MIN = 12.0          # Laplacian variance (on 1200px-wide page) below => re-shoot.
                          # Clip 0185 (dim room, DJI Action 4, 4K): legible pages 19-38
                          # (sparse pages score lower); same frames blurred (sigma 1.5 px
                          # at 4K) 6-13; a motion frame 8.
DUP_CORR = 0.95           # fingerprint correlation above which two pages are the same
SAME_PAGE_CHANGE = 0.15   # two still runs are one page if, in between, at most this share
                          # of the frame changed (hands adjusting). Clip 0185: same page
                          # <= 0.09, page swap >= 0.30. Too high would merge (lose) pages.


@dataclass
class Segment:
    video: Path
    t_local: float        # seconds within its file (sharpest frame)
    t_global: float       # seconds across all files
    still_s: float = 0.0  # length of the still run
    gap_change: float = 1.0  # max share of frame changed since the previous still run
    kind: str = ""        # separator | page | empty
    image: np.ndarray | None = None      # warped colour page
    sharpness: float = 0.0
    crop_conf: float = 0.0
    warnings: list[str] = field(default_factory=list)
    fp: np.ndarray | None = None


def probe(video: Path) -> tuple[int, int, float]:
    """Display width, height (after rotation metadata, which ffmpeg applies) and duration."""
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height:stream_side_data=rotation:format=duration",
         "-of", "json", str(video)],
        check=True, capture_output=True, text=True).stdout
    info = json.loads(out)
    s = info["streams"][0]
    w, h = int(s["width"]), int(s["height"])
    rot = next((int(float(d["rotation"])) for d in s.get("side_data_list", [])
                if "rotation" in d), 0)
    if rot % 180:   # e.g. DJI clips filmed in portrait carry rotation -90
        w, h = h, w
    return w, h, float(info["format"]["duration"])


def read_frames(video: Path, w: int, h: int, fps: float | None = None, ss: float | None = None,
                n: int | None = None):
    cmd = [FFMPEG, "-v", "error"]
    if ss is not None:
        cmd += ["-ss", f"{ss:.3f}"]
    cmd += ["-i", str(video)]
    vf = [f"fps={fps}"] if fps else []
    vf.append(f"scale={w}:{h}")
    cmd += ["-vf", ",".join(vf), "-an"]
    if n:
        cmd += ["-frames:v", str(n)]
    cmd += ["-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    size = w * h * 3
    try:
        while True:
            buf = p.stdout.read(size)
            if len(buf) < size:
                break
            yield np.frombuffer(buf, np.uint8).reshape(h, w, 3)
    finally:
        p.stdout.close()
        p.wait()


def laplacian_var(gray: np.ndarray) -> float:
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def find_still_segments(video: Path, fps: float, offset: float) -> list[Segment]:
    W, H, _ = probe(video)
    aw = ANALYSIS_W
    ah = int(round(H * aw / W / 2)) * 2
    min_len = max(2, int(np.ceil(MIN_STILL_S * fps)))
    segs: list[Segment] = []
    run: list[tuple[int, float]] = []   # (frame index, sharpness)
    prev = None
    ref = None          # last frame of the previous still run
    gap_change = 1.0    # max changed share since ref

    def flush():
        nonlocal ref, gap_change
        if len(run) >= min_len:
            i, _ = max(run, key=lambda r: r[1])
            t = i / fps
            segs.append(Segment(video, t, t + offset, still_s=len(run) / fps,
                                gap_change=round(gap_change, 3)))
            ref, gap_change = prev, 0.0

    for i, frame in enumerate(read_frames(video, aw, ah, fps=fps)):
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        small = cv2.GaussianBlur(gray, (5, 5), 0)
        if ref is not None:
            gap_change = max(gap_change, float((cv2.absdiff(small, ref) > 40).mean()))
        if prev is not None and float(cv2.absdiff(small, prev).mean()) < STILL_DIFF:
            if not run:
                run.append((i - 1, prev_sharp))
            run.append((i, laplacian_var(gray)))
        else:
            flush()
            run = []
        prev, prev_sharp = small, laplacian_var(gray)
    flush()
    return segs


def grab_full(video: Path, t: float) -> np.ndarray:
    W, H, _ = probe(video)
    frames = list(read_frames(video, W, H, ss=t, n=1))
    if not frames:
        raise RuntimeError(f"could not extract frame at {t:.2f}s from {video}")
    return frames[0].copy()


def order_quad(pts: np.ndarray) -> np.ndarray:
    pts = pts.reshape(4, 2).astype(np.float32)
    s, d = pts.sum(1), np.diff(pts, axis=1).ravel()
    return np.array([pts[s.argmin()], pts[d.argmin()], pts[s.argmax()], pts[d.argmax()]],
                    np.float32)  # tl, tr, br, bl


def find_page_quad(img: np.ndarray) -> tuple[np.ndarray | None, float, float]:
    """Return (quad in img coords or None, confidence, bright-area ratio)."""
    scale = 800.0 / max(img.shape[:2])
    small = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
    # paper = bright and low-saturation; robust on a dark background
    mask = ((hsv[..., 2] > PAPER_V_MIN) & (hsv[..., 1] < PAPER_S_MAX)).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    area_total = mask.shape[0] * mask.shape[1]
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None, 0.0, 0.0
    c = max(contours, key=cv2.contourArea)
    area = cv2.contourArea(c)
    bright = area / area_total
    if bright < MIN_PAGE_AREA:
        return None, 0.0, bright
    hull = cv2.convexHull(c)
    peri = cv2.arcLength(hull, True)
    hull_area = cv2.contourArea(hull)
    for eps in (0.02, 0.03, 0.04, 0.05):
        approx = cv2.approxPolyDP(hull, eps * peri, True)
        if len(approx) == 4 and cv2.isContourConvex(approx):
            quad_area = cv2.contourArea(approx)
            conf = float(min(area, quad_area) / max(area, quad_area))
            # reject quads that cut off part of the paper (e.g. a stack of sheets
            # whose under-sheets stick out, so the outline is not a clean 4-gon)
            if conf >= 0.9 and quad_area >= 0.97 * hull_area:
                return order_quad(approx) / scale, conf, bright
            break
    # Fallback: loosest safe crop, the rotated rectangle around all the paper.
    # Never cuts text; may include slivers of sheets underneath. Camera is top-down,
    # so a rotation-only warp keeps the page rectangular.
    (cx, cy), (bw, bh), ang = cv2.minAreaRect(hull)
    box = cv2.boxPoints(((cx, cy), (bw * 1.04, bh * 1.04), ang))  # + margin: coloured
    conf = float(area / max(cv2.contourArea(box), 1.0))            # letterheads aren't "paper"
    return order_quad(box) / scale, conf, bright


def warp(img: np.ndarray, q: np.ndarray) -> np.ndarray:
    tl, tr, br, bl = q
    w = int(max(np.linalg.norm(tr - tl), np.linalg.norm(br - bl)))
    h = int(max(np.linalg.norm(bl - tl), np.linalg.norm(br - tr)))
    dst = np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]], np.float32)
    return cv2.warpPerspective(img, cv2.getPerspectiveTransform(q, dst), (w, h),
                               flags=cv2.INTER_CUBIC)


def cleanup(img: np.ndarray) -> np.ndarray:
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    l = cv2.createCLAHE(clipLimit=1.5, tileGridSize=(8, 8)).apply(l)
    # stretch so paper is near-white, ink near-black
    lo, hi = np.percentile(l, (1, 99))
    if hi - lo > 20:
        l = np.clip((l.astype(np.float32) - lo) * 255.0 / (hi - lo), 0, 255).astype(np.uint8)
    return cv2.cvtColor(cv2.merge([l, a, b]), cv2.COLOR_LAB2BGR)


def fingerprint(img: np.ndarray) -> np.ndarray:
    """128x128 normalised grey thumbnail; compare with mean product (correlation).
    More stable than a bit-hash on mostly-white pages, where gradient bits are noise."""
    g = cv2.resize(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), (128, 128), interpolation=cv2.INTER_AREA)
    g = g.astype(np.float32)
    return (g - g.mean()) / (g.std() + 1e-6)


def colour_ratio(img: np.ndarray, colour: str) -> float:
    """Share of the frame in a separator colour (see SEPARATOR_COLOURS)."""
    c = SEPARATOR_COLOURS[colour]
    small = cv2.resize(img, (320, int(320 * img.shape[0] / img.shape[1])))
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    hit = np.zeros(h.shape, bool)
    for lo, hi in c["hues"]:
        hit |= (h >= lo) & (h <= hi)
    return float((hit & (s > c["s_min"]) & (v > c["v_min"])).mean())


def is_separator(img: np.ndarray) -> bool:
    return any(colour_ratio(img, c) > SEPARATOR_COLOURS[c]["ratio"] for c in SEPARATORS)


def classify(seg: Segment) -> None:
    img = grab_full(seg.video, seg.t_local)
    if is_separator(img):
        seg.kind = "separator"
        return
    quad, conf, _ = find_page_quad(img)
    if quad is None:    # too little paper
        seg.kind = "empty"
        return
    page = warp(img, quad)
    seg.crop_conf = round(conf, 3)
    seg.kind = "page"
    seg.image = page
    g = cv2.cvtColor(page, cv2.COLOR_BGR2GRAY)
    g = cv2.resize(g, (1200, int(1200 * g.shape[0] / g.shape[1])), interpolation=cv2.INTER_AREA)
    seg.sharpness = round(laplacian_var(g), 1)
    if seg.sharpness < SHARP_MIN:
        seg.warnings.append(f"low sharpness ({seg.sharpness} < {SHARP_MIN})")
    seg.fp = fingerprint(page)


def group(segs: list[Segment], label: bool) -> tuple[Segment | None, list[list[Segment]]]:
    label_seg = None
    docs: list[list[Segment]] = [[]]
    last = None
    for s in segs:
        prev, last = last, s
        if s.kind == "separator":
            if docs[-1]:
                docs.append([])
        elif s.kind == "page":
            if label and label_seg is None and not any(docs):
                label_seg = s
                continue
            cur = docs[-1]
            # same page, only hands moved in between -> keep the better still run;
            # or an identical-looking page shown again
            same_hold = (cur and prev is cur[-1] and s.gap_change < SAME_PAGE_CHANGE)
            if same_hold or (cur and float((cur[-1].fp * s.fp).mean()) > DUP_CORR):
                if (s.still_s, s.sharpness) > (cur[-1].still_s, cur[-1].sharpness):  # most stable
                    cur[-1] = s
                continue
            cur.append(s)
    return label_seg, [d for d in docs if d]


def write_jpg(path: Path, img: np.ndarray) -> None:
    cv2.imwrite(str(path), img, [cv2.IMWRITE_JPEG_QUALITY, 92])


def run(videos: list[Path], out: Path, fps: float, label: bool, verbose=True) -> dict:
    log = print if verbose else (lambda *a, **k: None)
    out.mkdir(parents=True, exist_ok=True)
    segs: list[Segment] = []
    offset = 0.0
    for v in videos:
        log(f"analysing {v.name} ...")
        found = find_still_segments(v, fps, offset)
        log(f"  {len(found)} still segments")
        segs += found
        offset += probe(v)[2]
    for s in segs:
        classify(s)
        log(f"  t={s.t_global:7.2f}s ({s.still_s:.1f}s still, {s.gap_change:.2f} changed) {s.kind}{' ' + '; '.join(s.warnings) if s.warnings else ''}")
    label_seg, docs = group(segs, label)

    manifest = {"videos": [str(v) for v in videos], "label_image": None, "documents": [],
                "needs_reshoot": []}
    if label_seg is not None:
        write_jpg(out / "label.jpg", label_seg.image)
        manifest["label_image"] = "label.jpg"
    for di, doc in enumerate(docs, 1):
        ddir = out / f"doc-{di:03d}"
        ddir.mkdir(exist_ok=True)
        pages, jpgs = [], []
        for pi, s in enumerate(doc, 1):
            name = f"page-{pi:03d}.jpg"
            write_jpg(ddir / name, cleanup(s.image))
            write_jpg(ddir / f"page-{pi:03d}.orig.jpg", s.image)
            jpgs.append(str(ddir / name))
            entry = {"doc": di, "page": pi, "file": f"doc-{di:03d}/{name}",
                     "source": s.video.name, "timestamp": round(s.t_local, 2),
                     "timestamp_global": round(s.t_global, 2), "sharpness": s.sharpness,
                     "crop_confidence": s.crop_conf, "warnings": s.warnings}
            pages.append(entry)
            if s.warnings:
                manifest["needs_reshoot"].append(entry)
        pdf = out / f"doc-{di:03d}.pdf"
        pdf.write_bytes(img2pdf.convert(jpgs))
        manifest["documents"].append({"doc": di, "pdf": pdf.name, "pages": pages})
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))

    log(f"\n{len(docs)} document(s), {sum(len(d) for d in docs)} page(s) -> {out}")
    for e in manifest["needs_reshoot"]:
        log(f"NEEDS RE-SHOOT: doc {e['doc']} page {e['page']} "
            f"({e['source']} @ {e['timestamp']}s): {'; '.join(e['warnings'])}")
    return manifest


def main(argv=None) -> int:
    global SHARP_MIN, SEPARATORS
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("videos", nargs="+", type=Path, help="video file(s), in recording order")
    ap.add_argument("--out", required=True, type=Path, help="output directory")
    ap.add_argument("--fps", type=float, default=6.0, help="analysis frame rate (default 6)")
    ap.add_argument("--sharp-min", type=float, default=SHARP_MIN,
                    help=f"sharpness below which a page needs re-shoot (default {SHARP_MIN})")
    ap.add_argument("--no-label", action="store_true",
                    help="first page is a real page, not the person label sheet")
    ap.add_argument("--separator", default=",".join(SEPARATORS),
                    help="separator colour(s), comma-separated, from: "
                         f"{', '.join(SEPARATOR_COLOURS)} (default {','.join(SEPARATORS)})")
    a = ap.parse_args(argv)
    seps = tuple(c.strip() for c in a.separator.split(",") if c.strip())
    if not seps or any(c not in SEPARATOR_COLOURS for c in seps):
        ap.error(f"--separator must be from: {', '.join(SEPARATOR_COLOURS)}")
    SEPARATORS = seps
    for v in a.videos:
        if not v.is_file():
            ap.error(f"not a file: {v}")
    SHARP_MIN = a.sharp_min
    run(a.videos, a.out, a.fps, label=not a.no_label)
    return 0


if __name__ == "__main__":
    sys.exit(main())
