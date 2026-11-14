"""Tests for pipeline.match.patchiness: same block code on both worlds, zero-spread handling, wiring."""
from __future__ import annotations

import json

import numpy as np
import pytest

from pipeline.common.config import WEB_DATA
from pipeline.match import patchiness as P

pytestmark = pytest.mark.filterwarnings("ignore")

N = 500


def _rough_tile(seed: int = 0) -> np.ndarray:
    """Hilly synthetic DEM whose roughness grows from left to right (so block spread > 0)."""
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:N, 0:N].astype(float)
    base = 300 * np.sin(x / 37.0) * np.cos(y / 53.0) * (0.2 + x / N)
    return base + rng.normal(0, 5, (N, N))


def _horizon(dem: np.ndarray) -> np.ndarray:
    """Cheap stand-in horizon (72, N, N) that varies with local height, decimated like the Earth cache."""
    z = (dem - dem.mean()) / (dem.std() + 1e-9)
    h = np.stack([3.0 - 2.0 * z * np.cos(np.radians(5 * k)) for k in range(72)]).astype(np.float32)
    return P.decimate_horizon(h)


def _sun() -> tuple[np.ndarray, np.ndarray]:
    return np.array([1.0, 2.0, 3.0, 4.0]), np.array([90.0, 135.0, 225.0, 270.0])


def test_upsample_roundtrip_keeps_samples() -> None:
    h = np.random.default_rng(1).uniform(-1, 10, (72, N, N)).astype(np.float32)
    d = P.decimate_horizon(h)
    up = P.upsample_horizon(d, N)
    assert up.shape == (72, N, N)
    np.testing.assert_allclose(up[:, ::P.DECIM, ::P.DECIM], d / 100.0, atol=1e-5)


def test_identical_tile_ratio_one_and_equal_blocks() -> None:
    dem = _rough_tile()
    h = _horizon(dem)
    moon = P.block_stats(dem, h, _sun())
    earth = P.block_stats(dem.copy(), h.copy(), _sun())
    for metric in P.METRICS:
        assert moon[metric] is not None and len(moon[metric]) == 25
        assert moon[metric] == earth[metric]
        rec = P.compare(metric, moon[metric], earth[metric])
        assert rec["moon_blocks"] == rec["earth_blocks"]
        assert rec["moon_spread"] == rec["earth_spread"]
        if rec["moon_spread"] > 0:
            assert rec["spread_ratio"] == pytest.approx(1.0)
        assert rec["patchiness"] == "similar"
    rim = P.compare("jump1km_p95_m", moon["jump1km_p95_m"], earth["jump1km_p95_m"])
    assert rim["moon_spread"] > 0, "fixture should vary across blocks"
    s = P.summary_for("jump1km_p95_m", rim)
    assert s is not None and s["text"].startswith("Varies about as much as the Moon site (Earth spread ")


def test_flat_earth_tile_zero_spread_is_smoother() -> None:
    moon_dem = _rough_tile()
    flat = np.full((N, N), 1234.0)
    moon = P.block_stats(moon_dem, _horizon(moon_dem), _sun())
    earth = P.block_stats(flat, P.decimate_horizon(np.zeros((72, N, N), np.float32)), _sun())
    for metric in ("jump1km_p95_m", "slope_p50_deg"):
        rec = P.compare(metric, moon[metric], earth[metric])
        assert rec["earth_spread"] == 0.0 and rec["moon_spread"] > 0
        assert rec["spread_ratio"] == 0.0 and rec["patchiness"] == "smoother"
        assert "Smoother than the Moon site" in P.summary_for(metric, rec)["text"]


def test_zero_moon_spread_no_divide_by_zero() -> None:
    flat = [0.0] * 25
    assert P.classify(0.0, 0.0) == (None, "similar")
    assert P.classify(0.3, 0.0) == (None, "patchier")
    rec = P.compare("frac_track_over_500m", flat, flat)
    assert rec["spread_ratio"] is None and rec["patchiness"] == "similar"
    rec = P.compare("jump1km_p95_m", flat, list(np.linspace(0, 200, 25)))
    assert rec["spread_ratio"] is None and rec["patchiness"] == "patchier"


def test_thresholds_and_missing() -> None:
    assert P.classify(0.66, 1.0)[1] == "smoother"
    assert P.classify(0.67, 1.0)[1] == "similar"
    assert P.classify(1.5, 1.0)[1] == "similar"
    assert P.classify(1.51, 1.0)[1] == "patchier"
    rec = P.compare("shadow_frac_el3", None, [0.1] * 25)
    assert rec["patchiness"] is None and P.summary_for("shadow_frac_el3", rec) is None


def test_missing_horizon_drops_horizon_metrics_only() -> None:
    b = P.block_stats(_rough_tile(), None, _sun())
    for m in P.METRICS:
        assert (b[m] is None) == (m in P.HORIZON_METRICS)


@pytest.mark.skipif(not (WEB_DATA / "matches.json").exists(), reason="run python -m pipeline.match all first")
def test_outputs_carry_patchiness() -> None:
    m = json.loads((WEB_DATA / "matches.json").read_text())
    s = json.loads((WEB_DATA / "summary.json").read_text())
    if "patchiness" not in s:
        pytest.skip("summary.json predates the patchiness check")
    top1 = [r for r in m["matches"] if r["rank"] == 1]
    for row in m["matches"]:
        assert "patchiness_summary" in row
        for li in row["lights"]:
            assert {"moon_blocks", "earth_blocks", "moon_spread", "earth_spread", "spread_ratio", "patchiness"} <= set(li)
            assert li["patchiness"] in (None, "similar", "smoother", "patchier")
            if li["moon_blocks"] is not None:
                assert len(li["moon_blocks"]) == 25
    p = s["patchiness"]
    assert p["n_top1"] == len(top1)
    assert p["n_similar_headline"] == sum(1 for r in top1 if (r["patchiness_summary"] or {}).get("patchiness") == "similar")
