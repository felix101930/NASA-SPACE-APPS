"""Tests for the per-region 3D annotations (pipeline.moon.annotations)."""
from __future__ import annotations

import json
import math

import numpy as np
import pytest
from scipy.ndimage import map_coordinates

from pipeline.common.config import WEB_DATA
from pipeline.metrics.rim import jump_samples
from pipeline.moon import annotations as A

REGIONS = json.loads((WEB_DATA / "regions.json").read_text())["regions"] if (WEB_DATA / "regions.json").exists() else []
OUT = {r["id"]: WEB_DATA / "moon" / f"{r['id']}_annotations.json" for r in REGIONS}
HAVE_OUT = bool(OUT) and all(p.exists() for p in OUT.values())
needs_out = pytest.mark.skipif(not HAVE_OUT, reason="run python -m pipeline.moon.annotations first")


def _load(rid: str) -> dict:
    return json.loads(OUT[rid].read_text())


def _positions(obj: object):
    """Yield every {'px': [c, r], 'xy': [x, y]} position dict in the annotation tree."""
    if isinstance(obj, dict):
        if "px" in obj and "xy" in obj and len(obj["px"]) == 2:
            yield obj
        for v in obj.values():
            yield from _positions(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _positions(v)


# ----------------------------------------------------------------------------- synthetic
def test_synthetic_step_edge_yields_rim_drop_at_the_step():
    n, res, step_col, h = 200, 30.0, 120, 400.0
    dem = np.zeros((n, n))
    dem[:, step_col:] = -h  # high on the left, low on the right
    picks = A.pick_rim_drops(dem, res, n_picks=3)
    assert picks, "no drop found"
    lag = 1000.0 / res
    for p in picks:
        (c0, _), (c1, _) = p["start_idx"], p["end_idx"]
        assert p["dh_m"] == pytest.approx(-h, abs=1e-6)
        assert c0 < step_col <= c1 + 1e-9  # the segment crosses the step, high -> low
        assert math.hypot(c1 - c0, p["end_idx"][1] - p["start_idx"][1]) == pytest.approx(lag)
    # picks respect the 1.5 km midpoint separation
    mids = [((p["start_idx"][0] + p["end_idx"][0]) / 2, (p["start_idx"][1] + p["end_idx"][1]) / 2) for p in picks]
    for i in range(len(mids)):
        for j in range(i + 1, len(mids)):
            assert math.dist(mids[i], mids[j]) * res >= 1500.0 - 1e-6


def test_jump_grid_matches_rim_jump_samples():
    rng = np.random.default_rng(0)
    dem = np.cumsum(np.cumsum(rng.normal(size=(120, 120)), 0), 1)
    g = A.jump_grid(dem, 30.0)
    ours = np.sort(np.abs(g[np.isfinite(g)]))
    ref = np.sort(jump_samples(dem, 30.0, 1000.0, 16))
    np.testing.assert_allclose(ours, ref, rtol=0, atol=1e-9)


def test_safest_patch_respects_buffer():
    slope = np.full((100, 100), 2.0)
    slope[:, 50:] = 30.0
    geom = A.TileGeom(0.0, 3000.0, 30.0, 100)
    s = A.safest_patch(slope, geom)
    # flat cols 0..49; >= 100 m (3.33 px) from col 50 -> cols 0..46 qualify (50 - c >= 3.33 px)
    assert s["bbox"]["px"] == [0.0, 0.0, 47.0, 100.0]
    assert s["area_km2"] == pytest.approx(47 * 100 * 0.0009)


# ----------------------------------------------------------------------------- outputs
@needs_out
@pytest.mark.parametrize("rid", list(OUT))
def test_positions_inside_tile_and_xy_consistent(rid):
    a = _load(rid)
    t = a["tile"]
    n, res = t["size"], t["res_m"]
    pos = list(_positions(a))
    assert len(pos) > 20
    for p in pos:
        px = p["px"]
        coords = [(px[0], px[1])] if len(px) == 2 else []
        for c, r in coords:
            assert 0.0 <= c <= n and 0.0 <= r <= n, p
            assert p["xy"][0] == pytest.approx(t["origin_x"] + c * res, abs=1.0)
            assert p["xy"][1] == pytest.approx(t["origin_y"] - r * res, abs=1.0)


@needs_out
@pytest.mark.parametrize("rid", list(OUT))
def test_rim_drop_dh_equals_dem_difference(rid):
    a = _load(rid)
    region = next(r for r in REGIONS if r["id"] == rid)
    dem = A.load_tile_bin(region).astype(np.float64)
    drops = a["rim_drops"]["drops"]
    assert len(drops) == 5
    for d in drops:
        (c0, r0), (c1, r1) = d["start"]["px"], d["end"]["px"]
        h0, h1 = map_coordinates(dem, [[r0 - 0.5, r1 - 0.5], [c0 - 0.5, c1 - 0.5]], order=1, prefilter=False)
        assert d["dh_m"] == pytest.approx(h1 - h0, abs=1.0)  # rounding of px to 0.01 + float32 tile
        assert d["dh_m"] <= 0  # oriented high -> low
        assert math.hypot(c1 - c0, r1 - r0) * a["tile"]["res_m"] == pytest.approx(1000.0, abs=1.0)
        assert d["above_p95"] == (d["abs_dh_m"] > a["rim_drops"]["p95_m"])
    assert drops[0]["abs_dh_m"] >= drops[-1]["abs_dh_m"]
    assert a["rim_drops"]["p95_m"] == pytest.approx(region["hazards"]["rim"]["metrics"]["jump1km_p95_m"], abs=0.1)


@needs_out
@pytest.mark.parametrize("rid", list(OUT))
def test_empty_frac_matches_regions_json(rid):
    a = _load(rid)
    region = next(r for r in REGIONS if r["id"] == rid)
    tex = a["texture"]
    prof = region["hazards"]["texture"]["metrics"]["empty_cell_frac_el3"]
    assert tex["empty_frac"] == pytest.approx(prof, abs=1e-5)
    n_cells = tex["grid"][0] * tex["grid"][1]
    assert sum(c["empty_az_frac"] for c in tex["texture_empty_cells"]) / n_cells == pytest.approx(prof, abs=1e-3)


@needs_out
@pytest.mark.parametrize("rid", list(OUT))
def test_shadow_fractions_match_masks_and_labels_present(rid):
    a = _load(rid)
    for m in a["shadow"]["masks"]:
        img = A.read_mask_png(WEB_DATA / m["path"])
        valid = img != 128
        assert m["frac"] == pytest.approx(float((img[valid] == 255).mean()), abs=1e-4)
    hazards = [lab["hazard"] for lab in a["labels"]]
    assert 4 <= len(hazards) <= 6
    assert set(hazards) <= {"shadow", "rim", "texture", "slope", "safe"}
    assert OUT[rid].stat().st_size < A.MAX_JSON_BYTES
    assert a["profile_mismatches"] == []


@needs_out
@pytest.mark.parametrize("rid", list(OUT))
def test_slope_class_png(rid):
    a = _load(rid)
    s = a["steep_mask_summary"]
    img = A.read_mask_png(WEB_DATA / s["class_png"]["path"])
    assert img.shape == (125, 125) and img.max() <= 3
    assert sum(s["class_fracs"]) == pytest.approx(1.0, abs=1e-3)
    assert s["frac_ge_25deg"] == pytest.approx(s["class_fracs"][3], abs=1e-4)
