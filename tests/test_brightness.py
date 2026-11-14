"""Offline tests for pipeline.metrics.brightness (synthetic grids; real files only if cached)."""
from __future__ import annotations

import numpy as np
import pytest

from pipeline.metrics import brightness as b


def test_percentile_rank_quantiles_and_sample():
    q = np.linspace(0.1, 0.5, 101)
    assert b.percentile_rank(0.1, q) == pytest.approx(0.0)
    assert b.percentile_rank(0.3, q) == pytest.approx(0.5)
    assert b.percentile_rank(0.5, q) == pytest.approx(1.0)
    assert b.percentile_rank(0.9, q) == pytest.approx(1.0)       # clipped above the max
    sample = np.arange(1, 11, dtype=float)                       # raw sample -> empirical CDF
    assert b.percentile_rank(5.0, sample) == pytest.approx(0.45)
    assert np.isnan(b.percentile_rank(float("nan"), q))


def test_rank_feature_is_scale_free():
    """Same relative position in two worlds with different albedo scales -> same rank and z."""
    rng = np.random.default_rng(0)
    moon = np.exp(rng.normal(np.log(0.32), 0.05, 5000))
    earth = np.exp(rng.normal(np.log(0.25), 0.05, 5000))
    fm = b.brightness_rank_feature(float(np.percentile(moon, 80)), np.percentile(moon, b.Q101))
    fe = b.brightness_rank_feature(float(np.percentile(earth, 80)), np.percentile(earth, b.Q101))
    assert fm["bright_rank"] == pytest.approx(0.8, abs=0.01)
    assert fe["bright_rank"] == pytest.approx(fm["bright_rank"], abs=0.01)
    assert fe["bright_z"] == pytest.approx(fm["bright_z"], abs=0.05)
    assert b.brightness_distance(0.8, 0.3) == pytest.approx(1.0)


def test_ldam_index_convention():
    r, c = b.ldam_index(0.0, 0.0)                                # pole = between the central pixels
    assert float(r) == pytest.approx(1265.5) and float(c) == pytest.approx(1265.5)
    r, c = b.ldam_index(-1265500.0, 1265500.0)                   # centre of pixel (0, 0)
    assert float(r) == pytest.approx(0.0) and float(c) == pytest.approx(0.0)


def test_moon_brightness_window_on_synthetic_grid():
    a = np.full((b.LDAM_N, b.LDAM_N), 0.3, dtype=np.float32)
    r, c = b.ldam_index(10_000.0, 20_000.0)
    a[int(r) - 3:int(r) + 4, int(c) - 3:int(c) + 4] = 0.5        # bright 7x7 km patch in the window
    s = b.moon_brightness(10_000.0, 20_000.0, 15_000.0, ldam=a)
    assert s["bright_n_px"] == 15 * 15
    assert s["bright_mean"] == pytest.approx(0.3 + 0.2 * 49 / 225, rel=1e-5)
    assert s["bright_p10"] == pytest.approx(0.3, rel=1e-5) and s["bright_p90"] == pytest.approx(0.5, rel=1e-5)
    assert len(s["bright_quantiles_101"]) == 101


def test_block_means_nan_rule():
    a = np.ones((6, 6))
    a[:3, :3] = np.nan                                            # one block fully missing
    a[3, 3] = np.nan                                              # one block 8/9 valid
    m = b.block_means(a, 3)
    assert np.isnan(m[0, 0]) and m[1, 1] == pytest.approx(1.0)


def test_cmg_window_size_and_wrap():
    rows, cols = b.cmg_window(18.0, 10.0, 15.0)
    assert 3 <= rows.stop - rows.start <= 4 and 3 <= cols.size <= 4
    rows, cols = b.cmg_window(-17.8, 179.99, 15.0)
    assert 0 in cols and b.CMG_SHAPE[1] - 1 in cols              # wraps across the antimeridian
    rows, cols = b.cmg_window(60.0, 0.0, 15.0)
    assert cols.size >= 5                                         # wider in longitude at 60 N


def test_earth_brightness_synthetic_cmg():
    a = np.full(b.CMG_SHAPE, np.nan, dtype=np.float32)
    rows, cols = b.cmg_window(30.0, 30.0, 15.0)
    a[rows][:, cols] = 0.4
    sub = a[rows]
    sub[:, cols] = 0.4
    a[rows] = sub
    g = {"a1064": a, "sw": a * 0.8, "snowy": np.zeros(b.CMG_SHAPE, dtype=bool)}
    s = b.earth_brightness(30.0, 30.0, 15.0, cmg=g)
    assert s["bright_mean"] == pytest.approx(0.4, rel=1e-6) and s["bright_snow_frac"] == 0.0
    assert s["bright_sw_mean"] == pytest.approx(0.32, rel=1e-5)
    ocean = b.earth_brightness(0.0, -30.0, 15.0, cmg=g)
    assert ocean["bright_n_px"] == 0 and np.isnan(ocean["bright_mean"])


@pytest.mark.skipif(not b.ldam_path().exists(), reason="LDAM not downloaded")
def test_real_ldam_plausible():
    s = b.moon_brightness(-480.0, 121500.0)                        # Malapert Massif core
    assert 0.2 < s["bright_mean"] < 0.5 and s["bright_n_px"] == 225
