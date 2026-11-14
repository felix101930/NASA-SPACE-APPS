"""Tests for the USGS LGRS region cross-check (pipeline.moon.usgs_regions).

Data-dependent tests skip if the official boundary file has not been downloaded
(run `python -m pipeline.moon.usgs_regions` first).
"""
from __future__ import annotations

import csv
import math

import pytest
from shapely.geometry import box

from pipeline.common.config import MOON_R_M, REGION_IDS
from pipeline.moon import usgs_regions as U

needs_boundaries = pytest.mark.skipif(not U.BOUNDARY_GEOJSON.exists(), reason="USGS boundary file not downloaded")


# ----------------------------------------------------------------------------- CRS
@pytest.mark.parametrize("lon,lat", [(0.0, -86.0), (31.7, -85.4), (-68.75, -83.64), (125.5, -87.16), (179.0, -89.9)])
def test_crs_roundtrip(lon: float, lat: float) -> None:
    x, y = U.lonlat_to_moon(lon, lat)
    lon2, lat2 = U.moon_to_lonlat(x, y)
    assert lat2 == pytest.approx(lat, abs=1e-9)
    assert ((lon2 - lon + 180) % 360 - 180) == pytest.approx(0.0, abs=1e-7)


def test_known_point_true_scale_at_pole() -> None:
    # lon 0 -> +y ; rho = 2R tan(colat/2) for k0 = 1
    x, y = U.lonlat_to_moon(0.0, -86.0)
    assert abs(x) < 1e-6
    assert y == pytest.approx(2 * MOON_R_M * math.tan(math.radians(2.0)), rel=1e-12)


def test_lps_to_moon_matches_pyproj() -> None:
    """Analytic LPS (k0=0.994, FE=FN=500 km) -> MOON_CRS agrees with a full pyproj transform."""
    from pyproj import Transformer

    t = Transformer.from_crs(U.LPS_SOUTH, U.GEOG_CRS, always_xy=True)
    for xl, yl in [(500_000.0, 500_000.0), (572_500.0, 617_500.0), (320_000.0, 570_000.0), (570_000.0, 450_000.0)]:
        lon, lat = t.transform(xl, yl)
        assert U.lps_to_moon(xl, yl) == pytest.approx(U.lonlat_to_moon(lon, lat), abs=1e-4)


# ----------------------------------------------------------------------------- geometry helpers
def test_spherical_area_close_to_planar_near_pole() -> None:
    # 20 km square centred 75 km from the pole: stereographic area scale ~ (1 + rho^2/4R^2)^2 ~ 1.0019
    sq = box(-10_000, 65_000, 10_000, 85_000)
    a = U.spherical_area_km2(sq)
    assert 0.99 * 400 < a < 400
    assert a == pytest.approx(400 / (1 + (75_000 / (2 * MOON_R_M)) ** 2) ** 2, rel=2e-3)


def test_core_inside_and_feasible_centres() -> None:
    poly = box(0, 0, 20_000, 20_000)
    assert U.core_inside(poly, 10_000, 10_000) == "full"
    assert U.core_inside(poly, 2_000, 10_000) == "partial"
    assert U.core_inside(poly, 40_000, 10_000) == "none"
    feas = U.feasible_centres(poly)
    assert feas.bounds == pytest.approx((7_500, 7_500, 12_500, 12_500))
    assert U.feasible_centres(box(0, 0, 10_000, 10_000)).is_empty


# ----------------------------------------------------------------------------- official data
@needs_boundaries
def test_official_regions_complete_and_areas_sane() -> None:
    off = U.load_official_regions()
    assert set(off) == set(REGION_IDS)
    for r in off.values():
        # USGS Area_km2 attribute equals the planar MOON_CRS area: boundaries were drawn in k0=1 polar stereo
        assert r.poly_moon.area / 1e6 == pytest.approx(r.attr_area_km2, rel=1e-4)
        true_area = U.spherical_area_km2(r.poly_moon)
        assert 0.98 * r.attr_area_km2 < true_area < r.attr_area_km2
        assert 200 < true_area < 5_000
    assert U.spherical_area_km2(off["mons_mouton_plateau"].poly_moon) > 4_000


@needs_boundaries
def test_cabeus_and_slater_in_right_part_of_pole() -> None:
    off = U.load_official_regions()
    cab = off["cabeus_b_peak"].poly_moon.centroid
    sla = off["slater_plain"].poly_moon.centroid
    # Peak near Cabeus B: near side, western longitudes (~ -69 E), ~ 6.4 deg from the pole
    lon, lat = U.moon_to_lonlat(cab.x, cab.y)
    assert cab.x < 0 < cab.y and -75 < lon < -60 and -84.5 < lat < -83
    # Slater Plain: far side (~ 125 E), within 3 deg of the pole
    lon, lat = U.moon_to_lonlat(sla.x, sla.y)
    assert sla.x > 0 > sla.y and 115 < lon < 135 and -88 < lat < -86.5


@needs_boundaries
def test_compare_rows_consistent() -> None:
    rows = U.compare(U.load_official_regions(), U.read_our_coords())
    assert len(rows) == 9
    for r in rows:
        assert r.core_inside in {"full", "partial", "none"}
        assert r.proposed_core_inside == "full"
        assert r.recommend in {"keep", "move"}
        if r.core_inside != "full":
            assert r.recommend == "move"


@pytest.mark.skipif(not U.MM_GRID_1KM.exists(), reason="Mons Mouton 1 km grid not cached")
@needs_boundaries
def test_mons_mouton_grid_covers_boundary() -> None:
    res = U.cross_check_grid(U.load_official_regions())
    assert res is not None
    assert res["boundary_within_grid"] == 1.0
    assert res["centroid_offset_m"] < 500
    assert res["hausdorff_m"] < 1_500


@pytest.mark.skipif(not U.COMPARE_CSV.exists(), reason="compare CSV not written")
def test_compare_csv_columns() -> None:
    with open(U.COMPARE_CSV, newline="") as f:
        rows = list(csv.DictReader(f))
    need = {"id", "name", "our_lat", "our_lon", "usgs_centroid_lat", "usgs_centroid_lon", "dist_km", "core_inside",
            "usgs_area_km2", "proposed_lat", "proposed_lon", "proposed_x_m", "proposed_y_m", "recommend", "reason"}
    assert need <= set(rows[0])
    assert {r["id"] for r in rows} == set(REGION_IDS)
