"""Synthetic tests for pipeline.metrics.shape."""
from __future__ import annotations

import numpy as np
import pytest

from pipeline.metrics.shape import (
    aspect_stats, curvature_maps, depressions, fill_depressions, hypsometry, quantile_distance,
    shape_features, w1_quantiles,
)

RES = 30.0
N = 300


def _xy(n: int = N, res: float = RES) -> tuple[np.ndarray, np.ndarray]:
    """Pixel-centre x (east) and y (north) in metres, row 0 = north."""
    c = (np.arange(n) + 0.5) * res
    x, yrow = np.meshgrid(c, c)
    return x, n * res - yrow


def _bowls(centres: list[tuple[float, float, float, float]], n: int = N, res: float = RES) -> np.ndarray:
    """Paraboloid bowls (cx, cy, radius_m, depth_m) cut into a flat plane at z = 0."""
    x, y = _xy(n, res)
    z = np.zeros((n, n))
    for cx, cy, rad, dep in centres:
        r2 = ((x - cx) ** 2 + (y - cy) ** 2) / rad ** 2
        z = np.minimum(z, np.where(r2 < 1.0, -dep * (1.0 - r2), 0.0))
    return z


def test_fill_bowl_and_nan():
    z = _bowls([(4500, 4500, 600, 60)])
    f = fill_depressions(z)
    assert np.allclose(f, 0.0, atol=1e-9)
    z[0, 0] = np.nan
    f = fill_depressions(z)
    assert np.isnan(f[0, 0]) and np.allclose(f[1:, 1:], 0.0)


def test_flat_has_no_depressions():
    d = depressions(np.zeros((N, N)), RES)
    assert d["n"] == 0 and d["per_100km2"] == 0.0 and d["area_frac"] == 0.0
    rng = np.random.default_rng(0)
    noisy = rng.normal(0, 0.5, (N, N))  # sub-threshold noise pits must be rejected
    assert depressions(noisy, RES)["n"] == 0


def test_bowl_count_and_diameters():
    spec = [(1500, 1500, 300, 40), (6000, 1800, 750, 120), (3000, 6500, 1200, 200), (7000, 7000, 450, 60)]
    d = depressions(_bowls(spec), RES)
    assert d["n"] == 4
    diam = np.sort(d["diam_m"])
    want = np.sort([2 * s[2] for s in spec])
    assert np.all(np.abs(diam - want) < 2 * RES)
    depth = np.sort(d["depth_m"])
    assert np.allclose(depth, np.sort([s[3] for s in spec]), rtol=0.05)
    area_km2 = (N * RES / 1000) ** 2
    assert d["per_100km2"] == pytest.approx(4 / area_km2 * 100)


def test_depression_filters():
    big = _bowls([(4500, 4500, 2000, 300)])          # 4 km > 3 km cap
    assert depressions(big, RES)["n"] == 0
    shallow = _bowls([(4500, 4500, 900, 10)])         # d/D = 0.0056 < 0.02
    assert depressions(shallow, RES)["n"] == 0
    tiny = _bowls([(4500, 4500, 30, 20)])             # 60 m < 3 px
    assert depressions(tiny, RES)["n"] == 0
    edge = _bowls([(0, 4500, 600, 80)])               # cut by the edge: drains out
    assert depressions(edge, RES)["n"] == 0


def test_hypsometry_tilted_plane_and_curves():
    x, y = _xy()
    hi, hi_rob, hn = hypsometry(0.1 * x + 0.05 * y)
    assert hi == pytest.approx(0.5, abs=1e-6) and hi_rob == pytest.approx(0.5, abs=1e-6)
    assert hn.min() == 0.0 and hn.max() == 1.0
    cone = -np.hypot(x - 4500, y - 4500)              # a peak: most area low -> HI < 0.5
    assert hypsometry(cone)[0] < 0.48 < 0.52 < hypsometry(-cone)[0]
    assert np.isnan(hypsometry(np.zeros((10, 10)))[0])


def test_aspect_tilted_plane_concentrated():
    x, y = _xy()
    a = aspect_stats(0.2 * x, RES)                   # rises to the east -> faces west (270)
    assert a["R"] == pytest.approx(1.0, abs=1e-9)
    assert a["mean_dir_deg"] == pytest.approx(270.0, abs=1e-6)
    assert a["hist"][6] == pytest.approx(1.0) and a["hist_aligned"][0] == pytest.approx(1.0)
    b = aspect_stats(-0.2 * y, RES)                  # falls to the north -> faces 0
    assert b["mean_dir_deg"] % 360 == pytest.approx(0.0, abs=1e-6) or b["mean_dir_deg"] == pytest.approx(360, abs=1e-6)
    cone = -np.hypot(x - 4500, y - 4500)
    c = aspect_stats(cone, RES)
    assert c["R"] < 0.05 and max(c["hist"]) < 0.2
    ridge = -np.abs(x - 4500) * 0.2                   # two opposite sides: R ~ 0, R2 ~ 1
    r = aspect_stats(ridge, RES)
    assert r["R"] < 0.05 and r["R2"] > 0.95
    flat = aspect_stats(np.zeros((50, 50)), RES)
    assert flat["frac_sloped"] == 0.0 and np.isnan(flat["R"])


def test_curvature_signs():
    x, y = _xy()
    xc, yc = x - 4500, y - 4500
    a = 1e-4
    dome = -a * (xc ** 2 + yc ** 2)
    m = curvature_maps(dome, RES, 270.0)
    assert np.nanmedian(m["lap"]) == pytest.approx(4 * a, rel=1e-6)
    assert np.nanmin(m["profile"]) > 0 and np.nanmin(m["plan"]) > 0
    bowl = curvature_maps(-dome, RES, 270.0)
    assert np.nanmax(bowl["lap"]) < 0 and np.nanmax(bowl["profile"]) < 0 and np.nanmax(bowl["plan"]) < 0
    cone = curvature_maps(-0.3 * np.hypot(xc, yc), RES, 270.0)
    ring = (np.hypot(xc, yc) > 1000) & (np.hypot(xc, yc) < 3500)
    assert np.all(cone["plan"][ring] > 0)
    # straight flanks: profile curvature is tiny next to plan curvature (~1/r)
    assert np.nanmax(np.abs(cone["profile"][ring])) < 0.1 * np.nanmin(cone["plan"][ring])
    ridge = curvature_maps(-a * xc ** 2, RES, 1080.0)
    ok = np.isfinite(ridge["profile"])
    assert np.all(ridge["profile"][ok] > 0) and np.nanmax(np.abs(ridge["plan"])) < 1e-9
    plane = curvature_maps(0.1 * x + 0.2 * y, RES, 270.0)
    assert np.nanmax(np.abs(plane["lap"])) < 1e-9


def test_shape_features_layout_and_resolution():
    rng = np.random.default_rng(1)
    z = _bowls([(1500, 1500, 300, 40), (6000, 1800, 750, 120)]) + rng.normal(0, 0.2, (N, N))
    f = shape_features(z, RES)
    s, q = f["scalars"], f["quantiles_101"]
    assert s["shape_depr_n"] == 2.0
    assert all(k.startswith("shape_") for k in list(s) + list(q))
    for k in ("shape_hypso_norm_height", "shape_lap_270m_per_km", "shape_prof_1080m_per_km", "shape_depr_diam_m"):
        assert len(q[k]) == 101
    assert len(s["shape_aspect_hist8"]) == 8
    # same terrain at 90 m (area average) finds the same two bowls
    z90 = z.reshape(N // 3, 3, N // 3, 3).mean(axis=(1, 3))
    assert shape_features(z90, 90.0)["scalars"]["shape_depr_n"] == 2.0


def test_wasserstein_helpers():
    a = list(np.linspace(0, 1, 101))
    b = list(np.linspace(0, 1, 101) + 0.5)
    assert w1_quantiles(a, b) == pytest.approx(0.5)
    assert quantile_distance(b, a, 0.05) == pytest.approx(0.5 / 0.5)
    assert np.isnan(w1_quantiles([], a))
