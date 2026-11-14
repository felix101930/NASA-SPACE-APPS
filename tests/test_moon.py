"""Tests for the Moon stage (pipeline.moon). Data-dependent tests skip if outputs are missing."""
from __future__ import annotations

import json
import math

import numpy as np
import pytest

from pipeline.common.config import REGION_IDS, WEB_DATA
from pipeline.moon.common import lonlat_to_xy, xy_to_lonlat

REGIONS_JSON = WEB_DATA / "regions.json"


# ---------------------------------------------------------------- coordinate transforms
@pytest.mark.parametrize("lon,lat", [(0.0, -86.0), (31.7, -85.4), (-68.8, -83.6), (125.6, -87.2), (179.0, -89.9)])
def test_lonlat_roundtrip(lon: float, lat: float) -> None:
    x, y = lonlat_to_xy(lon, lat)
    lon2, lat2 = xy_to_lonlat(x, y)
    assert lat2 == pytest.approx(lat, abs=1e-9)
    assert ((lon2 - lon + 180) % 360 - 180) == pytest.approx(0.0, abs=1e-7)


def test_polar_stereo_axes() -> None:
    assert lonlat_to_xy(0.0, -90.0) == pytest.approx((0.0, 0.0), abs=1e-6)
    x, y = lonlat_to_xy(0.0, -85.0)
    assert abs(x) < 1e-6 and y > 0          # lon 0 -> grid +y (tile "up")
    x, y = lonlat_to_xy(90.0, -85.0)
    assert x > 0 and abs(y) < 1e-6          # lon 90E -> grid +x
    # true scale at the pole: rho = 2R tan(colat/2)
    assert math.hypot(*lonlat_to_xy(10.0, -85.0)) == pytest.approx(2 * 1737400 * math.tan(math.radians(2.5)), rel=1e-9)


def test_area_average_exact() -> None:
    from pipeline.moon.windows import area_average

    a = np.arange(36, dtype=np.float32).reshape(6, 6)
    out = area_average(a, 20.0, 30.0)      # 6x6 @20 m -> 4x4 @30 m
    assert out.shape == (4, 4)
    assert float(out.mean()) == pytest.approx(float(a.mean()))
    # top-left 30 m cell = a[0,0] + half of a[0,1], a[1,0] and a quarter of a[1,1]
    w = np.array([[1, .5], [.5, .25]])
    assert out[0, 0] == pytest.approx(float((a[:2, :2] * w).sum() / w.sum()))


# ---------------------------------------------------------------- region coordinates
def test_region_coords_csv() -> None:
    from pipeline.moon.regions import COORDS_JSON

    if not COORDS_JSON.exists():
        pytest.skip("regions not built")
    rows = json.loads(COORDS_JSON.read_text())
    assert [r["id"] for r in rows] == list(REGION_IDS)
    for r in rows:
        assert r["coord_quality"] in ("pgda_site_tile", "traced_approx")
        x, y = lonlat_to_xy(r["lon"], r["lat"])
        assert math.hypot(x - r["x_m"], y - r["y_m"]) < 1.0
        assert -90 < r["lat"] < -83
        if r["fit_residual_km"] is not None:
            assert r["fit_residual_km"] < 0.5   # NASA box vs PGDA tile


# ---------------------------------------------------------------- tile orientation
def _tile(rid: str) -> np.ndarray:
    p = WEB_DATA / "moon" / f"{rid}.bin"
    if not p.exists():
        pytest.skip("tile missing")
    a = np.fromfile(p, dtype="<f4")
    assert a.size == 500 * 500
    return a.reshape(500, 500)


def _region(rid: str) -> dict:
    if not REGIONS_JSON.exists():
        pytest.skip("regions.json missing")
    return {r["id"]: r for r in json.loads(REGIONS_JSON.read_text())["regions"]}[rid]


@pytest.mark.parametrize("rid", ["malapert_massif", "nobile_rim_1"])
def test_tile_orientation_against_cog(rid: str) -> None:
    """2x2 blocks of 30 m tile pixels (at the highest point and at two corners) must equal the mean
    of the 3x3 LOLA 20 m pixels read independently from the source COG at the same map coords."""
    rasterio = pytest.importorskip("rasterio")
    from rasterio.windows import from_bounds

    from pipeline.moon.common import DEM_URL

    tile = _tile(rid)
    reg = _region(rid)
    ox, oy, res = reg["tile"]["origin_x"], reg["tile"]["origin_y"], reg["tile"]["res_m"]
    r_max, c_max = np.unravel_index(np.nanargmax(tile), tile.shape)
    blocks = [(min(r_max - r_max % 2, 498), min(c_max - c_max % 2, 498)), (0, 0), (498, 200)]
    try:
        ds = rasterio.open(DEM_URL)
    except Exception as exc:  # offline
        pytest.skip(f"COG unavailable: {exc}")
    with ds:
        for r0, c0 in blocks:
            x0, y0 = ox + c0 * res, oy - r0 * res
            win = from_bounds(x0, y0 - 2 * res, x0 + 2 * res, y0, transform=ds.transform)
            ref = ds.read(1, window=win.round_offsets().round_lengths())
            assert ref.shape == (3, 3)
            assert float(tile[r0:r0 + 2, c0:c0 + 2].mean()) == pytest.approx(float(ref.mean()), abs=1e-2)
    # the highest point must not sit on a mirrored location (catches flips on asymmetric terrain)
    assert tile[r_max, c_max] > tile[499 - r_max, c_max] or r_max == 499 - r_max


def test_tile_row0_is_plus_y() -> None:
    """Tile origin and row 0 (= +y, top) agree with the cached 20 m near field."""
    from pipeline.moon.windows import load_npz, near_path

    rid = "malapert_massif"
    if not near_path(rid).exists():
        pytest.skip("near field cache missing")
    dem, g, extra = load_npz(near_path(rid))
    r0, r1, c0, c1 = (int(v) for v in extra["core_slice"])
    tile = _tile(rid)
    reg = _region(rid)
    assert reg["tile"]["origin_x"] == pytest.approx(g.x0 + c0 * g.res)
    assert reg["tile"]["origin_y"] == pytest.approx(g.y0 - r0 * g.res)
    # top 30 m row (60 m = 3 rows of 20 m -> 2 rows of 30 m)
    assert float(tile[:2].mean()) == pytest.approx(float(dem[r0:r0 + 3, c0:c1].mean()), abs=1e-2)


# ---------------------------------------------------------------- contract
def test_regions_json_contract() -> None:
    if not REGIONS_JSON.exists():
        pytest.skip("regions.json missing")
    doc = json.loads(REGIONS_JSON.read_text())
    meta = doc["meta"]
    assert {"generated_utc", "pipeline_version", "sources"} <= set(meta)
    assert meta["generated_utc"].endswith("Z")
    for s in meta["sources"]:
        assert {"name", "url", "licence", "citation"} <= set(s)
    regs = doc["regions"]
    assert [r["id"] for r in regs] == list(REGION_IDS)
    top = {"id", "name", "lat", "lon", "x_m", "y_m", "coord_quality", "coord_source", "sun", "tile",
           "hillshade", "shadow_masks", "hazards", "uncertainty"}
    hz_keys = {
        "shadow": {"shadow_frac_el1", "shadow_frac_el3", "shadow_frac_el5", "shadow_frac_timeweighted"},
        "rim": {"jump1km_p95_m", "jump1km_p99_m", "frac_track_over_500m"},
        "texture": {"fast_per_km2_el3", "empty_cell_frac_el3"},
    }
    for r in regs:
        assert top <= set(r), top - set(r)
        assert r["coord_quality"] in ("pgda_site_tile", "traced_approx")
        assert {"el_min", "el_max", "note"} <= set(r["sun"])
        t = r["tile"]
        assert t["size"] == 500 and t["res_m"] == 30 and {"path", "crs", "origin_x", "origin_y"} <= set(t)
        assert (WEB_DATA / t["path"]).stat().st_size == 500 * 500 * 4
        assert (WEB_DATA / r["hillshade"]).exists()
        assert len(r["shadow_masks"]) == 12
        for sm in r["shadow_masks"]:
            assert {"el", "az", "path"} <= set(sm) and (WEB_DATA / sm["path"]).exists()
        for hz, keys in hz_keys.items():
            h = r["hazards"][hz]
            assert 0.0 <= h["score"] <= 1.0 and h["level"] in ("low", "med", "high")
            assert keys <= set(h["metrics"])
            assert all(isinstance(h["metrics"][k], float) for k in keys)
        sl = r["hazards"]["slope"]["metrics"]
        assert {"slope_p50_deg", "slope_p90_deg", "rms_dev_m"} <= set(sl)
        assert set(sl["rms_dev_m"]) == {"60", "120", "240", "480", "960"}
        assert "dem_err_p50_m" in r["uncertainty"] and "notes" in r["uncertainty"]
    for hz in hz_keys:
        scores = [r["hazards"][hz]["score"] for r in regs]
        assert min(scores) == 0.0 and max(scores) == 1.0
        assert sorted(r["hazards"][hz]["level"] for r in regs).count("low") == 3
