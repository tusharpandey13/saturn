import json
import sys
from pathlib import Path

import cv2
import pytest

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent)]

import make_synthetic  # noqa: E402
import scan  # noqa: E402


@pytest.fixture(scope="module")
def single(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("single")
    out = tmp / "out"
    return scan.run(make_synthetic.make(tmp / "in"), out, 6.0, label=True, verbose=False), out


def check(manifest, out):
    assert manifest["label_image"] == "label.jpg"
    assert [len(d["pages"]) for d in manifest["documents"]] == [3, 2]
    assert (out / "doc-001" / "page-003.jpg").is_file()
    assert (out / "doc-001" / "page-001.orig.jpg").is_file()
    assert (out / "doc-002.pdf").read_bytes()[:4] == b"%PDF"
    assert json.loads((out / "manifest.json").read_text()) == manifest
    for d in manifest["documents"]:
        for p in d["pages"]:
            assert p["crop_confidence"] > 0.9, p
            assert p["warnings"] == [], p
    assert manifest["needs_reshoot"] == []


def test_single_video(single):
    check(*single)


def test_page_crop_is_upright_a4(single):
    _, out = single
    h, w = cv2.imread(str(out / "doc-001" / "page-001.jpg")).shape[:2]
    assert h / w == pytest.approx(make_synthetic.PH / make_synthetic.PW, rel=0.05)


def test_split_hevc_videos(tmp_path):
    """Two consecutive H.265 files (like DJI splits) give the same result."""
    videos = make_synthetic.make(tmp_path / "in", split=True, codec="libx265")
    assert len(videos) == 2
    out = tmp_path / "out"
    check(scan.run(videos, out, 6.0, label=True, verbose=False), out)
