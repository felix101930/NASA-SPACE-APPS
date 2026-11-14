"""Tests for the Earth stage (no network)."""
from __future__ import annotations

import json

import numpy as np
import pytest

from pipeline.earth.common import cop_name, utm_epsg, worldcover_tag
from pipeline.earth.dem import geom_to_lonlat, site_geom
from pipeline.earth.fingerprint import fingerprint_dem, horizon_local, rim_jump_local
from pipeline.earth.landcover import CLASSES, class_shares
from pipeline.earth.sun import solar_position


@pytest.mark.parametrize("lat,lon,epsg", [
    (51.0, -115.0, 32611), (-23.5, -68.3, 32719), (75.38, -89.67, 32616), (0.1, 0.1, 32631),
    (-77.5, 161.8, 32757), (35.03, -111.02, 32612), (10.0, 179.9, 32660), (10.0, -180.0, 32601),
])
def test_utm_selection(lat, lon, epsg):
    assert utm_epsg(lat, lon) == epsg


def test_tile_names():
    assert cop_name(51, -115, 30) == "Copernicus_DSM_COG_10_N51_00_W115_00_DEM"
    assert cop_name(-23, -68, 90) == "Copernicus_DSM_COG_30_S23_00_W068_00_DEM"
    assert worldcover_tag(51.5, -115.0) == "N51W117"
    assert worldcover_tag(-22.5, -68.3) == "S24W069"


def test_window_north_up():
    g = site_geom(75.38, -89.67, 30.0, 500)
    t = g.transform
    assert t.e < 0 and t.b == 0 and t.d == 0          # north-up, no rotation
    top = geom_to_lonlat(g, g.cx, t.f - 15.0)           # centre of row 0
    bot = geom_to_lonlat(g, g.cx, t.f - 499 * 30 - 15)  # centre of last row
    assert top[1] > bot[1]                              # row 0 is north
    # centred on the site
    lon, lat = geom_to_lonlat(g, g.cx, g.cy)
    assert abs(lat - 75.38) < 1e-6 and abs(lon + 89.67) < 1e-6


def test_worldcover_shares_sum_to_one():
    rng = np.random.default_rng(0)
    codes = np.array(list(CLASSES) + [0])
    arr = rng.choice(codes, size=(300, 300)).astype(np.uint8)
    sh = class_shares(arr)
    assert abs(sum(sh[n] for n in CLASSES.values()) - 1.0) < 1e-9
    assert 0.9 < sh["valid_frac"] < 0.95


def test_flat_plane_fingerprint():
    dem = np.zeros((101, 101), np.float32) + 100.0
    fp = fingerprint_dem(dem, 90.0, 33)
    assert fp["slope_p90_deg"] < 1e-6
    assert fp["jump1km_p99_m"] < 1e-6
    # on a flat plane only curvature drop matters -> nothing above 1 deg
    assert fp["shadow_frac_local_el1"] == 0.0


def test_tilted_plane_horizon():
    # plane rising to the east at 2 deg: horizon toward east ~2 deg, toward west ~ -2 deg
    res = 90.0
    x = np.arange(201) * res
    dem = np.tile(np.tan(np.radians(2.0)) * x, (201, 1))
    h = horizon_local(dem, res, (slice(80, 121), slice(80, 121)), n_az=4, R=1e12)
    east, west = h[1], h[3]
    assert np.allclose(east, 2.0, atol=0.05)
    assert np.all(west < 0)


def test_rim_jump_step():
    dem = np.zeros((200, 200))
    dem[:, 100:] = 600.0
    r = rim_jump_local(dem, 30.0, stride=1)
    assert r["jump1km_p99_m"] == pytest.approx(600.0, abs=1)
    assert 0 < r["frac_track_over_500m"] < 0.5


def test_solar_position_equinox_noon():
    # 2026-03-20 ~ equinox; at lon 0 local solar noon ~12:07 UTC -> el ~ 90 - lat
    t = np.datetime64("2026-03-20T12:07").astype("datetime64[s]").astype(np.int64)
    el, az = solar_position(np.array([t]), 45.0, 0.0)
    assert abs(el[0] - 45.0) < 0.6
    assert abs(az[0] - 180.0) < 3


def test_earth_sites_json_contract():
    from pipeline.earth.compute import EARTH_SITES_JSON
    if not EARTH_SITES_JSON.exists():
        pytest.skip("earth_sites.json not built")
    doc = json.loads(EARTH_SITES_JSON.read_text())
    assert set(doc["meta"]) >= {"generated_utc", "pipeline_version", "sources"}
    for src in doc["meta"]["sources"]:
        assert set(src) >= {"name", "url", "licence", "citation"}
    required = {"id", "name", "country", "lat", "lon", "category", "known_analog", "role", "bare_frac",
                "worldcover_note", "rock", "tile", "hillshade", "metrics", "image_tile_url", "citations",
                "stage1_rank", "selected_by"}
    from pipeline.metrics import CONTRACT_KEYS
    assert doc["sites"]
    for s in doc["sites"]:
        assert required <= set(s), required - set(s)
        assert s["role"] in ("candidate", "heldout_positive", "decoy", "listed_candidate", "seed")
        assert s["selected_by"] in ("global_screen", "validation", "documented")
        assert set(s["tile"]) >= {"path", "size", "res_m", "crs", "origin_x", "origin_y"}
        assert s["tile"]["size"] == 500 and s["tile"]["res_m"] == 30
        assert set(s["rock"]) >= {"lith", "anorthosite", "source"}
        assert set(CONTRACT_KEYS) <= set(s["metrics"])


def test_dsm_safe_filter():
    from pipeline.earth.screen import bare_pass, dsm_pass
    base = {k: 0.0 for k in ("tree", "shrub", "grass", "crop", "built", "bare", "snow", "water", "wet", "moss")}
    meteor = {**base, "grass": 0.71, "bare": 0.29, "land": 1.0}           # sparse desert scrub
    black_forest = {**base, "tree": 0.71, "grass": 0.27, "built": 0.02, "land": 1.0}
    haughton = {**base, "bare": 0.52, "moss": 0.48, "land": 1.0}
    assert dsm_pass(meteor) and not bare_pass(meteor)
    assert not dsm_pass(black_forest) and not bare_pass(black_forest)
    assert dsm_pass(haughton) and bare_pass(haughton)
    assert not dsm_pass({**haughton, "snow": 0.35})
