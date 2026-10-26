# doc-scan

Turns a top-down video of document pages into cropped page images, one PDF per
document, and a `manifest.json`. Runs locally; nothing leaves the machine.

## Setup

```sh
cd tools/doc-scan
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

Needs `ffmpeg`/`ffprobe` on PATH (or at `/opt/homebrew/bin`).

## Usage

```sh
source tools/doc-scan/.venv/bin/activate
python3 -I tools/doc-scan/scan.py <media-dir>/raw/<chat>/CLIP_0001.MP4 \
    --out <media-dir>/scans/<person>-<date>
# camera split the recording? pass every file, in order:
python3 -I tools/doc-scan/scan.py CLIP_0001.MP4 CLIP_0002.MP4 --out ...
```

Options: `--fps 6` (analysis rate), `--sharp-min 12` (re-shoot threshold),
`--no-label` (first page is a real page, not the label sheet),
`--separator red,green` (separator colours; default both).

Output:

```
out/label.jpg                    the label sheet (first page seen)
out/doc-001/page-001.jpg         cropped, contrast-cleaned
out/doc-001/page-001.orig.jpg    cropped, colour original
out/doc-001.pdf
out/manifest.json                doc, page, source file + timestamp, sharpness,
                                 crop confidence, warnings, needs_reshoot list
```

Pages flagged **NEEDS RE-SHOOT** (low sharpness) are
printed at the end and listed in `manifest.json` with their video timestamp.

## How it works

1. Decode at 6 fps, 480 px wide (honouring the rotation flag of portrait clips);
   find still runs (low frame difference) of >= 0.7 s.
2. Pick the sharpest frame (Laplacian variance), re-extract it at full resolution.
3. Classify: separator (red share > 30%, or green share > 12% — a green notebook
   cover works), page (large bright, unsaturated area), or empty (background / hands).
4. Find the page outline and perspective-warp it upright, apply mild CLAHE. If the
   outline is not a clean 4-gon (a stack of sheets sticking out, hands), fall back to
   the rotated rectangle around all the paper (+4% margin): loose but never cuts text.
5. Merge still runs of the same page: if at most 15% of the frame changed between
   two runs (hands adjusting), keep the longest run; also drop identical-looking
   consecutive pages (thumbnail correlation > 0.95).

## Recording tips

- an action camera on a stand pointing straight down; 4K 4:3, 30 fps, H.265,
  stabilisation **off**. Fixed exposure/white balance if possible; even light, no glare.
- Dark, matte background that is larger than the page.
- Start with a label sheet naming whose documents follow. One video per person.
- Each page: lay it flat, hands fully out of frame, hold still ~2 s, then next page.
- Between documents, show a **red A4 sheet marked "NEW DOC"** or the green
  notebook cover for ~2 s.
- Keep the whole page inside the frame with some dark border around it.
- Lift each page away in one movement; pausing mid-removal can produce a duplicate.
- Light from the sides, not from above/behind the camera (its shadow lands on the page).

## Privacy

Videos (`*.mp4`, `*.MP4`, `*.mov`, `*.LRF`) and outputs (`scans/`,
`tools/doc-scan/out/`) are gitignored. Keep real media in
`<media-dir>/` (outside git, back it up privately).
The tests use only a synthetic, generated video.

## Tests

```sh
tools/doc-scan/.venv/bin/python -m pytest -q tools/doc-scan/tests
```

Renders a synthetic video (perspective text pages, label sheet, red separator,
hand occlusion, motion, a repeated page) and checks label + 2 docs of 3 and 2
pages, for one H.264 file and for two consecutive H.265 files. The video is made by
`tests/make_synthetic.py`; the tests use no real footage.

## Known limits

- Does not read the label sheet (no OCR); it is saved as `label.jpg`.
- Needs a background darker or more saturated than paper (dark cloth, beige cushion);
  a white page on a white table won't be outlined.
- The default sharpness threshold (`--sharp-min 12`) was tuned on real footage; check it on
  your own setup. Sparse pages score lower than dense ones.
- Stacked sheets give loose crops (slivers of the sheets below are included).
- A page held < 0.7 s, or interrupted by hands throughout, is missed.
- Two genuinely identical consecutive pages (e.g. blank forms) are merged.
- Page orientation is kept as filmed (no auto-rotate).
