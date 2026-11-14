"""Tests for the Alberta screen + Calgary walks module (pipeline.alberta)."""
from __future__ import annotations

import json
import math

import numpy as np
import pytest
from shapely.geometry import Polygon, box

from pipeline.alberta import geodata as G
from pipeline.alberta import landcover as L
from pipeline.alberta import routes as R
from pipeline.common.config import WEB_DATA


# ----------------------------------------------------------------------------- tiling
def test_tiling_covers_irregular_polygon_without_gaps_or_overlaps():
    poly = Polygon([(3_000, 7_000), (95_000, 1_000), (140_000, 60_000), (70_000, 130_000), (10_000, 90_000)])
    wins = G.tile_polygon(poly, win=15_000.0, prefix="T")
    cov = G.coverage_stats(poly, wins, win=15_000.0)
    assert cov["pct_covered"] == pytest.approx(100.0, abs=1e-6)
    cells = [box(w.x0, w.y1 - 15_000, w.x0 + 15_000, w.y1) for w in wins]
    assert all(c.intersects(poly) for c in cells)
    # no overlaps: union area == sum of cell areas
    from shapely.ops import unary_union
    assert unary_union(cells).area == pytest.approx(len(cells) * 15_000.0 ** 2)
    # fractions inside sum to the polygon area
    assert sum(w.frac_in_ab for w in wins) * 15_000.0 ** 2 == pytest.approx(poly.area, rel=1e-9)
    # every cell of the bounding grid that touches the polygon interior is present
    x0, y1, nrow, ncol = G.grid_origin(poly.bounds, 15_000.0)
    ids = {(w.row, w.col) for w in wins}
    for r in range(nrow):
        for c in range(ncol):
            cell = box(x0 + c * 15_000, y1 - (r + 1) * 15_000, x0 + (c + 1) * 15_000, y1 - r * 15_000)
            assert ((r, c) in ids) == (poly.intersection(cell).area > 0)


def test_grid_origin_anchored_on_multiples():
    x0, y1, nrow, ncol = G.grid_origin((16_000, 1_000, 44_000, 29_999), 15_000.0)
    assert (x0, y1, nrow, ncol) == (15_000, 30_000, 2, 2)


# ----------------------------------------------------------------------------- worldcover rule
def _classes(**shares) -> np.ndarray:
    n = 10_000
    a = np.full(n, 30, np.uint8)   # grass
    codes = {"tree": 10, "crop": 40, "built": 50, "snow": 70, "water": 80, "wetland": 90, "mangrove": 95,
             "nodata": 0, "bare": 60}
    i = 0
    for k, v in shares.items():
        m = int(round(v * n))
        a[i:i + m] = codes[k]
        i += m
    return a.reshape(100, 100)


@pytest.mark.parametrize("shares, ok, why", [
    ({"tree": 0.10}, True, []),
    ({"tree": 0.11}, False, ["tree"]),
    ({"built": 0.05}, True, []),
    ({"built": 0.06}, False, ["built"]),
    ({"crop": 0.21}, False, ["crop"]),
    ({"water": 0.20}, True, []),
    ({"water": 0.21}, False, ["water"]),
    ({"wetland": 0.06, "mangrove": 0.05}, False, ["wet"]),
    ({"snow": 0.29}, True, []),
    ({"snow": 0.30}, False, ["snow"]),
    ({"bare": 0.9}, True, []),
])
def test_dsm_safe_rule(shares, ok, why):
    sh = L.shares_from_classes(_classes(**shares))
    assert L.dsm_safe(sh) == (ok, why)


def test_shares_over_valid_pixels_and_land_fraction():
    sh = L.shares_from_classes(_classes(nodata=0.6, water=0.2))
    assert sh["valid"] == pytest.approx(0.4)
    assert sh["water"] == pytest.approx(0.5)        # 0.2 of all / 0.4 valid
    assert sh["land"] == pytest.approx(0.2)         # valid non-water / all
    assert L.dsm_safe(sh)[1] == ["water", "land"]


def test_dsm_rule_matches_earth_stage_constants():
    earth = pytest.importorskip("pipeline.earth.screen")
    assert L.DSM_SAFE_MAX == earth.DSM_SAFE_MAX
    assert L.DSM_SNOW_MAX == earth.DSM_SNOW_MAX


# ----------------------------------------------------------------------------- route graph
def _grid_lines(n: int = 6, step: float = 200.0) -> list:
    lines = []
    for i in range(n):
        for j in range(n - 1):
            lines.append((np.array([[j * step, i * step], [(j + 1) * step, i * step]]), {"weight": 1.0}))
            lines.append((np.array([[i * step, j * step], [i * step, (j + 1) * step]]), {"weight": 1.0}))
    return lines


def test_graph_connected_and_chains_contiguous():
    g = R.build_graph(_grid_lines())
    assert len(g.xy) == 36
    assert len(set(R.components(g))) == 1
    rng = np.random.default_rng(0)
    n_ok = 0
    for _ in range(50):
        res = R.random_chain(g, rng, int(rng.integers(len(g.edges))), 1500.0)
        if res is None:
            continue
        seq, xy = res
        n_ok += 1
        assert len(seq) == len(set(seq))                         # no edge reused
        steps = np.hypot(*np.diff(xy, axis=0).T)
        assert steps.max() <= 200.0 + 1e-6                        # polyline is continuous
        length = steps.sum()
        assert 500.0 <= length <= 1500.0 * 1.25 + 200.0
        # consecutive edges share a node
        for a, b in zip(seq[:-1], seq[1:]):
            ea, eb = g.edges[a], g.edges[b]
            assert {ea["u"], ea["v"]} & {eb["u"], eb["v"]}
    assert n_ok > 30


def test_snapping_and_t_junction_noding():
    lines = [(np.array([[0.0, 0.0], [100.0, 0.0]]), {"weight": 1}),
             (np.array([[101.5, 0.0], [200.0, 0.0]]), {"weight": 1}),       # 1.5 m gap -> snapped
             (np.array([[50.0, 1.0], [50.0, 100.0]]), {"weight": 1}),       # T-junction 1 m off the line
             (np.array([[150.0, 12.0], [150.0, 80.0]]), {"weight": 1})]     # 12 m gap -> connector
    g0 = R.build_graph(R.node_lines(lines))
    assert len(set(R.components(g0))) == 2                     # 12 m gap not bridged at 2 m
    g = R.build_graph(R.node_lines(lines, 2.0, 20.0, {"weight": 0.5, "connector": True}))
    assert len(set(R.components(g))) == 1
    assert sum(1 for e in g.edges if e.get("connector")) == 1


def test_trim_polyline():
    xy = np.array([[0.0, 0.0], [100.0, 0.0], [100.0, 100.0]])
    t = R.trim_polyline(xy, 150.0)
    assert np.allclose(t[-1], [100.0, 50.0])


# ----------------------------------------------------------------------------- profiles
def test_profile_on_synthetic_ramp():
    from pipeline.metrics.profile import sample_profile
    res, n = 4.0, 400
    x0, y0 = 1000.0, 5000.0
    xs = x0 + (np.arange(n) + 0.5) * res
    dem = np.tile(0.05 * (xs - x0), (n, 1))                      # 5 % grade rising to the east
    line = [(x0 + 100.0, y0 - 800.0), (x0 + 1300.0, y0 - 800.0)]  # 1.2 km west -> east
    n5 = int(1200 / 5) + 1
    h5 = np.asarray(sample_profile(dem, res, (x0, y0), line, n=n5)["h_m"])
    h100, slope = R.profile_100(h5, 1200.0)
    assert len(slope) == 100
    assert np.allclose(slope[2:-2], math.degrees(math.atan(0.05)), atol=1e-6)
    assert np.allclose(slope, math.degrees(math.atan(0.05)), atol=0.05)
    rev = R.profile_100(h5[::-1], 1200.0)[1]
    assert np.allclose(rev[2:-2], -math.degrees(math.atan(0.05)), atol=1e-6)
    assert h100[-1] - h100[0] == pytest.approx(60.0 * 0.99, rel=0.02)


def test_bridge_repair_fills_notch_only():
    h = np.linspace(1000.0, 1010.0, 201)                          # 1 km at 5 m, gentle
    hb = h.copy()
    hb[90:110] -= 8.0                                             # 100 m bridge dropped to the river
    fixed, n = R.repair_bridges(hb, 5.0)
    assert n == 20
    assert np.allclose(fixed, h, atol=0.06)
    same, n0 = R.repair_bridges(h, 5.0)
    assert n0 == 0 and np.array_equal(same, h)


def test_dtw_banded():
    a = np.sin(np.linspace(0, 6, 100))
    assert R.dtw_banded(a, a, 10) == pytest.approx(0.0)
    shifted = np.sin(np.linspace(0, 6, 100) - 0.3)
    assert R.dtw_banded(a, shifted, 10) < np.mean(np.abs(a - shifted))
    assert R.dtw_banded(a, a + 2.0, 10) == pytest.approx(2.0)


# ----------------------------------------------------------------------------- distance definition
def test_distance_matches_earth_rank_stage1():
    rk = pytest.importorskip("pipeline.earth.rank_stage1")
    from pipeline.alberta import screen as S
    if not S.MOON_FP.exists():
        pytest.skip("moon fingerprints missing")
    rng = np.random.default_rng(3)
    moon = S.load_moon()
    q = {k: np.sort(rng.random(101)) * s for k, s in (("slope_deg", 20), ("height_m", 300), ("jump1km_m", 400),
                                                      ("shadow_az_frac_el1_local", 1), ("shadow_az_frac_el3_local", 1),
                                                      ("shadow_az_frac_el5_local", 1))}
    rows = [{"id": "S1", "status": "ok", "selected_by": "global_screen", "frac_track_over_500m": 0.02,
             **{f"nu_{L}": 10.0 * i for i, L in enumerate(S.NU, 1)}},
            {"id": "S2", "status": "ok", "selected_by": "global_screen", "frac_track_over_500m": 0.3,
             **{f"nu_{L}": 40.0 * i for i, L in enumerate(S.NU, 1)}}]
    D = rk.distances(rows, {"S1": q, "S2": q}, rk.load_moon())
    scal = S.scalar_scales(rows)
    for rid, m in moon.items():
        mine = S.hazard_distances(rows[0], q, m, scal)
        for h in S.HAZ:
            assert mine[h] == pytest.approx(D[f"{rid}|{h}"][0], rel=1e-9)


# ----------------------------------------------------------------------------- output contract
def _load(path):
    if not path.exists():
        pytest.skip(f"{path.name} not built yet")
    return json.loads(path.read_text())


def test_alberta_json_contract():
    d = _load(WEB_DATA / "alberta" / "alberta.json")
    assert set(d) >= {"meta", "coverage", "best_per_hazard", "searches", "sites"}
    assert set(d["meta"]) >= {"generated_utc", "pipeline_version", "sources", "method"}
    assert set(d["coverage"]) >= {"n_windows", "n_pass", "pct_area_pass", "pct_province_covered"}
    assert len(d["searches"]) == 27
    for s in d["searches"]:
        assert set(s) >= {"region", "hazard", "n_eligible", "top"}
        assert 1 <= len(s["top"]) <= 5
        for t in s["top"]:
            assert set(t) >= {"rank", "id", "distance", "lights", "metrics_30m_vs_moon"}
            assert t["id"] in d["sites"]
            for li in t["lights"]:
                assert set(li) >= {"component", "label", "moon", "alberta", "scale", "term", "light", "gap"}
                assert li["light"] in ("green", "amber", "red")
    for st in d["sites"].values():
        assert set(st) >= {"id", "name", "lat", "lon", "park", "worldcover", "fingerprint_90m", "tile", "hillshade",
                           "metrics_30m"}
        if st["tile"]:
            assert (WEB_DATA / st["tile"]["path"]).stat().st_size == 500 * 500 * 4


def test_alberta_geojson_contract():
    d = _load(WEB_DATA / "alberta" / "alberta_windows.geojson")
    assert d["type"] == "FeatureCollection"
    p = d["features"][0]["properties"]
    assert set(p) >= {"id", "name", "pass", "eligible", "fail", "best_distance", "d_shadow", "d_rim", "d_texture",
                      "in_protected_area", "frac_in_ab"}


def test_calgary_contract():
    w = _load(WEB_DATA / "calgary" / "walks.json")
    assert set(w) >= {"meta", "bin", "stats", "notes", "items"}
    n = len(w["items"])
    assert (WEB_DATA / "calgary" / "walks.bin").stat().st_size == n * 100 * 4
    it = w["items"][0]
    assert set(it) >= {"id", "row", "coords", "park", "length_m", "climb_m", "max_grade_pct", "mean_grade_pct",
                       "near_stop", "tract"}
    assert not {"paved", "gentle_paved"} & set(it)               # accessibility labels removed (scope change)
    assert set(it["near_stop"]) >= {"name", "dist_m", "routes"}
    assert 2 <= len(it["coords"]) <= 50
    assert all(49 < c[0] < 52 and -115 < c[1] < -113 for c in it["coords"])   # [lat, lon]
    p = _load(WEB_DATA / "calgary" / "presets.json")
    assert len(p["presets"]) == 18
    for pr in p["presets"]:
        assert set(pr) >= {"region", "kind", "moon_xy", "slope_deg", "match"}
        assert set(pr["match"]) >= {"recommended", "strict_best", "top"}
    o = _load(WEB_DATA / "calgary" / "calgary_overlays.geojson")
    assert len(o["features"]) == 288
    assert set(o["features"][0]["properties"]) >= {"ctuid", "access_domain_score", "access_category"}
