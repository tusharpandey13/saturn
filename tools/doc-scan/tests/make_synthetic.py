"""Render a synthetic top-down 'page flipping' video (no real data).

Timeline: label sheet, doc 1 (3 pages, page 2 shown twice with a hand in between),
red separator, doc 2 (2 pages), with sliding pages, still-hand frames and motion between.
Expected result: label + 2 documents with 3 and 2 pages.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

FFMPEG = "/opt/homebrew/bin/ffmpeg"
W, H, FPS = 1280, 960, 30
PW, PH = 520, 735  # A4-ish page size in pixels
rng = np.random.default_rng(0)


def render_page(lines: list[str], bg=(245, 245, 240), ink=(30, 30, 30)) -> np.ndarray:
    p = np.full((PH, PW, 3), bg, np.uint8)
    y = 60
    for i, t in enumerate(lines):
        scale = 1.4 if i == 0 else 0.6
        cv2.putText(p, t, (30, y), cv2.FONT_HERSHEY_SIMPLEX, scale, ink, 3 if i == 0 else 1,
                    cv2.LINE_AA)
        y += 60 if i == 0 else 28
    return p


def text_page(title: str, seed: int) -> np.ndarray:
    r = np.random.default_rng(seed)
    words = ["sample", "report", "value", "range", "normal", "test", "unit", "note", "date"]
    lines = [title] + [" ".join(r.choice(words, 5)) + f" {r.integers(10, 999)}"
                       for _ in range(20)]
    return render_page(lines)


def red_sheet() -> np.ndarray:
    p = np.full((PH, PW, 3), (30, 30, 210), np.uint8)
    cv2.putText(p, "NEW DOC", (90, PH // 2), cv2.FONT_HERSHEY_SIMPLEX, 2.2, (255, 255, 255), 5)
    return p


def place(page: np.ndarray | None, dx=0.0, tilt=12.0) -> np.ndarray:
    """Dark background with page perspective-placed at offset dx (fraction of W)."""
    frame = np.full((H, W, 3), (35, 32, 30), np.uint8)
    if page is None:
        return frame
    cx, cy = W / 2 + dx * W, H / 2
    src = np.float32([[0, 0], [PW, 0], [PW, PH], [0, PH]])
    dst = np.float32([[cx - PW / 2 + tilt, cy - PH / 2], [cx + PW / 2 - tilt / 2, cy - PH / 2 + 8],
                      [cx + PW / 2 + tilt / 2, cy + PH / 2], [cx - PW / 2 - tilt, cy + PH / 2 - 6]])
    M = cv2.getPerspectiveTransform(src, dst)
    warped = cv2.warpPerspective(page, M, (W, H))
    mask = cv2.warpPerspective(np.full((PH, PW), 255, np.uint8), M, (W, H)) > 0
    frame[mask] = warped[mask]
    return frame


def hand(frame: np.ndarray, x: float, y: float) -> np.ndarray:
    f = frame.copy()
    skin = (120, 160, 210)
    cx, cy = int(x * W), int(y * H)
    cv2.ellipse(f, (cx, cy), (110, 150), 20, 0, 360, skin, -1)
    for k in range(4):
        cv2.ellipse(f, (cx - 70 + 45 * k, cy - 190), (18, 70), 0, 0, 360, skin, -1)
    cv2.rectangle(f, (cx - 80, cy + 100), (cx + 80, H + 10), skin, -1)
    return f


def noise(f: np.ndarray) -> np.ndarray:
    n = rng.normal(0, 2.0, f.shape)
    return np.clip(f.astype(np.int16) + n.astype(np.int16), 0, 255).astype(np.uint8)


def timeline() -> list[np.ndarray]:
    frames: list[np.ndarray] = []

    def still(page, secs=2.0):
        base = place(page)
        frames.extend(base for _ in range(int(secs * FPS)))

    def swap(page_in, secs=0.8):
        n = int(secs * FPS)
        for i in range(n):
            t = i / n
            frames.append(hand(place(page_in, dx=0.6 * (1 - t)), 0.75 - 0.3 * t, 0.7))

    label = render_page(["BOB", "", "scan label sheet"])
    p = [text_page(f"DOC1 PAGE {i}", i) for i in (1, 2, 3)]
    q = [text_page(f"DOC2 PAGE {i}", 10 + i) for i in (1, 2)]

    still(None, 0.5)
    swap(label); still(label)
    swap(p[0]); still(p[0])
    swap(p[1]); still(p[1], 1.5)
    # hand reaches in and rests still briefly (should be ignored / deduped)
    for i in range(8):
        frames.append(hand(place(p[1]), 0.9 - 0.04 * i, 0.8))
    frames.extend(hand(place(p[1]), 0.6, 0.8) for _ in range(int(0.3 * FPS)))
    for i in range(8):
        frames.append(hand(place(p[1]), 0.6 + 0.05 * i, 0.8))
    still(p[1], 1.5)                      # same page again -> dedupe
    swap(p[2]); still(p[2])
    swap(red_sheet()); still(red_sheet())
    # empty background with a resting hand -> 'empty'
    for i in range(10):
        frames.append(hand(place(None), 0.9 - 0.03 * i, 0.6))
    frames.extend(hand(place(None), 0.6, 0.6) for _ in range(int(1.2 * FPS)))
    swap(q[0]); still(q[0])
    swap(q[1]); still(q[1])
    for i in range(10):                   # page removed
        frames.append(place(q[1], dx=0.06 * i))
    still(None, 0.5)
    return frames


def encode(frames: list[np.ndarray], path: Path, codec="libx264") -> None:
    cmd = [FFMPEG, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24",
           "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-", "-c:v", codec,
           "-pix_fmt", "yuv420p", "-preset", "ultrafast", str(path)]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for f in frames:
        p.stdin.write(noise(f).tobytes())
    p.stdin.close()
    if p.wait() != 0:
        raise RuntimeError("ffmpeg encode failed")


def make(out_dir: Path, split: bool = False, codec: str = "libx264") -> list[Path]:
    """Write one video, or two consecutive parts (split during a page swap)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    frames = timeline()
    if not split:
        path = out_dir / "synthetic.mp4"
        encode(frames, path, codec)
        return [path]
    cut = int(11.1 * FPS)  # falls inside a swap (motion), like a DJI file boundary
    parts = [out_dir / "part1.mp4", out_dir / "part2.mp4"]
    encode(frames[:cut], parts[0], codec)
    encode(frames[cut:], parts[1], codec)
    return parts


if __name__ == "__main__":
    print(make(Path(sys.argv[1] if len(sys.argv) > 1 else "."), split="--split" in sys.argv))
