"""Synthetic tests for pipeline.metrics (fast: small grids)."""
from __future__ import annotations

import math

import numpy as np
import pytest

from pipeline.metrics import (
    CONTRACT_KEYS,
    compute_all,
    fast_density,
    group_by_hazard,
    horizon_map,
    render_hillshade,
    rim_jump_stats,
    roughness_stats,
    sample_profile,
    shadow_fraction,
    shadow_mask,
    sun_path_moon,
    sun_visible_fraction,
    time_weighted_shadow_fraction,
    to_grid,
)

MOON_R = 1_737_400.0
RES = 30.0


def fractal(n: int, beta: float = 2.6, amp: float = 200.0, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    kx = np.fft.fftfreq(n)[:, None]
    ky = np.fft.fftfreq(n)[None, :]
    k = np.hypot(kx, ky)
    k[0, 0] = 1.0
    f = (rng.normal(size=(n, n)) + 1j * rng.normal(size=(n, n))) / k ** (beta / 2)
    f[0, 0] = 0
    z = np.real(np.fft.ifft2(f))
    return (z - z.mean()) / z.std() * amp


# ------------------------------------------------------------------------------------ shadow
@pytest.mark.parametrize("radius", [None, MOON_R])
def test_flat_plane_no_shadow(radius: float | None) -> None:
    dem = np.zeros((80, 80))
    far = np.zeros((60, 60))
    hz = horizon_map(dem, RES, (slice(20, 60), slice(20, 60)), dem_far=far, res_far=300.0,
                     n_az=36, max_radius_m=10e3, planet_radius_m=radius)
    assert hz.shape == (36, 40, 40)
    assert np.all(hz <= 1e-9)
    for el in (0.1, 1.0, 5.0):
        assert shadow_fraction(hz, el) == 0.0
        assert not shadow_mask(hz, el, 123.0).any()


def test_tilted_plane_flips_at_slope() -> None:
    n = 100
    rows = np.arange(n, dtype=float)[:, None] * np.ones((1, n))
    dem = (n - rows) * RES * math.tan(math.radians(5.0))  # rises toward north (az 0)
    hz = horizon_map(dem, RES, (slice(10, 90), slice(10, 90)), n_az=72)
    np.testing.assert_allclose(hz[0], 5.0, atol=1e-6)
    assert shadow_mask(hz, 3.0, 0.0).all()
    assert not shadow_mask(hz, 7.0, 0.0).any()
    assert shadow_fraction(hz, 3.0, 0.0) == 1.0
    assert shadow_fraction(hz, 7.0, 0.0) == 0.0


@pytest.mark.parametrize("el", [10.0, 20.0])
def test_cylindrical_pit_analytic(el: float) -> None:
    n, rp, depth = 150, 60.0, 200.0
    yy, xx = np.mgrid[0:n, 0:n].astype(float)
    c = (n - 1) / 2.0
    r = np.hypot(yy - c, xx - c)
    dem = np.where(r < rp, -depth, 0.0)
    hz = horizon_map(dem, RES, (slice(0, n), slice(0, n)), n_az=72)
    got = shadow_mask(hz, el, 0.0)
    L = depth / math.tan(math.radians(el)) / RES  # shadow length (px), sun toward row -1
    r_sun = np.hypot(yy - L - c, xx - c)  # distance of the point shifted toward the sun
    floor = r < rp - 1
    must_shadow = floor & (r_sun > rp + 1)
    must_lit = floor & (r_sun < rp - 1)
    assert got[must_shadow].all()
    assert not got[must_lit].any()
    lens = 2 * rp**2 * math.acos(L / (2 * rp)) - (L / 2) * math.sqrt(4 * rp**2 - L**2)
    expect = math.pi * rp**2 - lens
    assert abs(got[r < rp].sum() - expect) < 2 * math.pi * rp  # within 1 px of perimeter


def test_curvature_hides_distant_wall() -> None:
    near = np.zeros((40, 40))
    res_f, nf = 300.0, 700
    hw = 1000.0

    def horizon_north(dist_m: float, radius: float | None) -> float:
        far = np.zeros((nf, nf))
        # far grid centred on the near grid: its centre row is at y = 0 relative to near centre
        row = int(round(nf / 2 - dist_m / res_f))
        far[row - 5:row, :] = hw  # wall from dist_m to dist_m + 1.5 km north
        hz = horizon_map(near, RES, (slice(20, 21), slice(20, 21)), dem_far=far, res_far=res_f,
                         n_az=4, max_radius_m=150e3, planet_radius_m=radius)
        return float(hz[0, 0, 0])

    h40 = horizon_north(40e3, MOON_R)
    expect40 = math.degrees(math.atan((hw - 40e3**2 / (2 * MOON_R)) / 40e3))
    assert h40 > 0.5 and abs(h40 - expect40) < 0.08
    assert horizon_north(80e3, MOON_R) < 0.0  # hidden beyond sqrt(2 R hw) ~ 59 km
    assert horizon_north(80e3, None) > 0.5  # but visible without curvature


def test_far_field_georeferencing_matches_single_grid() -> None:
    big = fractal(240, amp=300.0, seed=4)
    o = 70
    near = big[o:o + 100, o:o + 100]
    core = (slice(30, 70), slice(30, 70))
    ref = horizon_map(big, RES, (slice(o + 30, o + 70), slice(o + 30, o + 70)), n_az=16,
                      planet_radius_m=MOON_R)
    # same DEM as far grid at the same resolution, explicit origins (near origin arbitrary)
    nx0, ny0 = 12345.0, -6789.0
    fx0, fy0 = nx0 - o * RES, ny0 + o * RES
    got = horizon_map(near, RES, core, dem_far=big, res_far=RES, near_origin_xy=(nx0, ny0),
                      far_origin_xy=(fx0, fy0), n_az=16, planet_radius_m=MOON_R)
    np.testing.assert_allclose(got, ref, atol=1e-4)
    # a 2x coarser far field gives nearly the same answer
    far2 = to_grid(big, RES, 2 * RES)
    got2 = horizon_map(near, RES, core, dem_far=far2, res_far=2 * RES, near_origin_xy=(nx0, ny0),
                       far_origin_xy=(fx0, fy0), n_az=16, planet_radius_m=MOON_R)
    assert np.mean(np.abs(got2 - ref)) < 0.1


def test_disk_and_time_weighted() -> None:
    hz = np.full((8, 4, 4), 2.0, dtype=np.float32)
    np.testing.assert_allclose(sun_visible_fraction(hz, 2.0, 45.0), 0.5, atol=1e-6)
    assert np.all(sun_visible_fraction(hz, 2.3, 10.0) == 1.0)
    el = np.array([1.0, 3.0, 5.0, -1.0])
    az = np.array([0.0, 90.0, 180.0, 270.0])
    assert time_weighted_shadow_fraction(hz, el, az) == pytest.approx(0.5)
    assert time_weighted_shadow_fraction(hz, el, az, min_sun_el=0.0) == pytest.approx(1 / 3)


def test_sun_path_moon() -> None:
    el, az = sun_path_moon(-90.0, 1024)
    assert el.size >= 1024 and az.size == el.size
    assert el.max() <= 1.54 + 1e-9 and el.min() >= -1.54 - 1e-9
    el2, _ = sun_path_moon(-86.0, 1024)
    assert el2.max() == pytest.approx(4.0 + 1.54, abs=0.15)
    assert el2.min() == pytest.approx(-4.0 - 1.54, abs=0.15)
    assert np.all((az >= 0) & (az < 360))
    # grid azimuth = geographic azimuth + lon (south-polar stereographic, lon_0 = 0)
    el3, az3 = sun_path_moon(-86.0, 1024, lon_deg=30.0)
    _, az_geo = sun_path_moon(-86.0, 1024)
    np.testing.assert_allclose(el3, el2)
    np.testing.assert_allclose(az3, (az_geo + 30.0) % 360.0)
    # highest sun is toward geographic north (geo az ~ 0) -> grid az ~ lon
    assert abs(((az3[np.argmax(el3)] - 30.0 + 180) % 360) - 180) < 1.0


# ------------------------------------------------------------------------------------ rim
def test_step_edge_rim_jump() -> None:
    dem = np.zeros((200, 200))
    dem[:, 100:] = 700.0
    r = rim_jump_stats(dem, RES)
    assert r["jump1km_p99_m"] == pytest.approx(700.0)
    assert r["frac_track_over_500m"] > 0.02
    assert {"jump1km_p95_m", "jump100m_p95_m", "jump100m_p99_m"} <= set(r)
    flat = rim_jump_stats(np.zeros((100, 100)), RES)
    assert flat["jump1km_p99_m"] == 0.0 and flat["frac_track_over_500m"] == 0.0


# ------------------------------------------------------------------------------------ texture
def test_fast_flat_vs_random() -> None:
    flat = render_hillshade(np.zeros((300, 300)), RES, 3.0, 45.0)
    assert flat.dtype == np.uint8 and np.ptp(flat) == 0
    r0 = fast_density(flat, RES)
    assert r0["fast_per_km2"] == 0.0 and r0["empty_cell_frac"] == 1.0
    rough = render_hillshade(np.random.default_rng(1).normal(0, 20, (300, 300)), RES, 30.0, 45.0)
    r1 = fast_density(rough, RES)
    assert r1["fast_per_km2"] > 50.0 and r1["empty_cell_frac"] == 0.0


def test_hillshade_cast_shadow_dark() -> None:
    dem = fractal(100, seed=2)
    sh = np.zeros((100, 100), dtype=bool)
    sh[:50] = True
    img = render_hillshade(dem, RES, 10.0, 90.0, sh)
    assert np.all(img[:50] == 0) and img[50:].max() > 200


# ------------------------------------------------------------------------------------ roughness
def test_roughness_plane_and_fractal() -> None:
    n = 100
    yy, xx = np.mgrid[0:n, 0:n].astype(float)
    plane = xx * RES * math.tan(math.radians(10.0))
    r = roughness_stats(plane, RES)
    assert r["slope_p50_deg"] == pytest.approx(10.0, abs=1e-6)
    assert max(r["rms_dev_m"].values()) < 1e-6
    rf = roughness_stats(fractal(200, seed=3), RES)
    vals = [rf["rms_dev_m"][k] for k in ("60", "120", "240", "480", "960")]
    assert all(b > a for a, b in zip(vals, vals[1:]))
    assert 0.0 < rf["hurst"] < 1.2


# ------------------------------------------------------------------------------------ resample
def test_resample_preserves_mean() -> None:
    z = np.random.default_rng(0).normal(100, 50, (600, 600))
    out = to_grid(z, 20.0, 30.0)
    assert out.shape == (400, 400)
    assert out.mean() == pytest.approx(z.mean(), rel=1e-12)
    out2 = to_grid(z[:599, :599], 20.0, 30.0)  # partial trailing cell dropped
    assert out2.shape == (399, 399)
    zn = z.copy()
    zn[:3, :3] = np.nan
    assert np.isnan(to_grid(zn, 20.0, 30.0)[0, 0])
    assert to_grid(np.ones((10, 10)), 30.0, 15.0).shape == (20, 20)


# ------------------------------------------------------------------------------------ profile
def test_profile_linear_ramp() -> None:
    n = 200
    xx = np.mgrid[0:n, 0:n][1].astype(float)
    grade = 0.1
    dem = xx * RES * grade  # rises toward +x
    origin = (1000.0, 5000.0)
    y = origin[1] - 100 * RES
    p = sample_profile(dem, RES, origin, [(origin[0] + 20 * RES, y), (origin[0] + 150 * RES, y)])
    expect = math.degrees(math.atan(grade))
    np.testing.assert_allclose(p["slope_deg"], expect, atol=1e-9)
    assert p["length_m"] == pytest.approx(130 * RES)
    assert p["climb_m"] == pytest.approx(130 * RES * grade)
    assert p["max_slope_deg"] == pytest.approx(expect)
    back = sample_profile(dem, RES, origin, [(origin[0] + 150 * RES, y), (origin[0] + 20 * RES, y)])
    np.testing.assert_allclose(back["slope_deg"], -expect, atol=1e-9)
    assert len(p["h_m"]) == 100


# ------------------------------------------------------------------------------------ compute_all
def test_compute_all_contract_keys() -> None:
    big = fractal(160, seed=5)
    core = (slice(30, 130), slice(30, 130))
    hz = horizon_map(big, RES, core, n_az=24, planet_radius_m=MOON_R)
    m = compute_all(big[core], hz, RES, lat_deg=-86.0, lon_deg=45.0, n_sun_samples=256)
    assert set(m) == set(CONTRACT_KEYS)
    assert set(m["rms_dev_m"]) == {"60", "120", "240", "480", "960"}
    assert 0.0 <= m["shadow_frac_el5"] <= m["shadow_frac_el3"] <= m["shadow_frac_el1"] <= 1.0
    assert 0.0 <= m["shadow_frac_timeweighted"] <= 1.0
    g = group_by_hazard(m)
    assert set(g) == {"shadow", "rim", "texture", "slope"}
    mx = compute_all(big[core], hz, RES, el_series=[2.0, 4.0], az_series=[0.0, 180.0], extras=True)
    assert {"hurst", "jump100m_p99_m", "shadow_frac_el7"} <= set(mx)
