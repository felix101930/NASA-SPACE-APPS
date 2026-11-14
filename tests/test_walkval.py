"""Tests for the walk-matcher find-back validation (pipeline/walkval)."""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

from pipeline.common.config import ROOT
from pipeline.metrics.profile import sample_profile
from pipeline.walkval.findback import app_prefilter, evaluate, nearest_class
from pipeline.walkval.matchers import (
    MATCHERS, Library, best_orientation_reversed, dtw_banded, dtw_naive, heights_from_slopes, query_features,
    rank_of, reverse_slopes, score, znormalise,
)
from pipeline.walkval.routes import MoonRoute, MoonTile, make_needle, warp_positions

P = 100


def _walks(rng: np.random.Generator, n: int) -> np.ndarray:
    """Smooth random slope profiles (degrees), roughly like real transects."""
    x = np.cumsum(rng.normal(0, 1.5, size=(n, P)), axis=1)
    return np.clip(x - x.mean(axis=1, keepdims=True), -40, 40)


@pytest.fixture(scope="module")
def lib() -> Library:
    rng = np.random.default_rng(0)
    s = _walks(rng, 300)
    return Library(s, rng.choice([1000.0, 2000.0, 5000.0], size=300))


# ----------------------------------------------------------------------------- DTW definition
@pytest.mark.parametrize("n,m,band", [(5, 5, 0.1), (7, 7, 0.3), (12, 9, 0.1), (6, 11, 0.25), (30, 30, 0.1), (1, 4, 0.1)])
def test_dtw_matches_naive_reference(n: int, m: int, band: float) -> None:
    rng = np.random.default_rng(n * 100 + m)
    for _ in range(20):
        a, b = rng.normal(size=n), rng.normal(size=m)
        assert dtw_banded(a, b, band) == pytest.approx(dtw_naive(a.tolist(), b.tolist(), band), rel=1e-12, abs=1e-12)


def test_dtw_basic_properties() -> None:
    rng = np.random.default_rng(1)
    a, b = rng.normal(size=P), rng.normal(size=P)
    assert dtw_banded(a, a) == 0.0
    assert dtw_banded(a, b) == pytest.approx(dtw_banded(b, a))
    # Warping can only help, so DTW <= mean absolute difference (the diagonal path).
    assert dtw_banded(a, b) <= np.mean(np.abs(a - b)) + 1e-12
    # Early abandon returns inf only when the threshold is exceeded.
    full = dtw_banded(a, b)
    assert dtw_banded(a, b, 0.1, full * 10) == pytest.approx(full)
    assert dtw_banded(a, b, 0.1, 1e-6) == np.inf


def test_znormalise_matches_browser_definition() -> None:
    z = znormalise(np.array([1.0, 2.0, 3.0, 4.0]))
    assert np.mean(z) == pytest.approx(0.0)
    assert np.sqrt(np.mean(z ** 2)) == pytest.approx(1.0)  # population SD
    assert np.all(znormalise(np.full(5, 3.0)) == 0.0)  # SD 0 -> divide by 1


def test_dtw_matches_browser_typescript(tmp_path: Path) -> None:
    """Run web/src/lib/dtw.ts under Node (native type stripping) and compare to the Python port."""
    node = shutil.which("node")
    ts = ROOT / "web" / "src" / "lib" / "dtw.ts"
    if node is None or not ts.exists():
        pytest.skip("node or dtw.ts not available")
    rng = np.random.default_rng(7)
    cases = [(rng.normal(0, 8, P).round(3).tolist(), rng.normal(0, 8, P).round(3).tolist()) for _ in range(5)]
    cases.append((rng.normal(size=13).tolist(), rng.normal(size=9).tolist()))
    script = tmp_path / "parity.mjs"
    script.write_text(
        f"import {{ dtwBanded, zNormalise }} from {json.dumps(ts.as_uri())};\n"
        f"const cases = {json.dumps(cases)};\n"
        "console.log(JSON.stringify(cases.map(([a, b]) => [dtwBanded(a, b, 0.1),"
        " dtwBanded(Array.from(zNormalise(a)), Array.from(zNormalise(b)), 0.1)])));\n")
    proc = subprocess.run([node, str(script)], capture_output=True, text=True, timeout=60)
    if proc.returncode != 0:
        pytest.skip(f"node could not run dtw.ts: {proc.stderr.strip()[:200]}")
    js = json.loads(proc.stdout)
    for (a, b), (d_js, dz_js) in zip(cases, js):
        a, b = np.array(a), np.array(b)
        assert dtw_banded(a, b, 0.1) == pytest.approx(d_js, rel=1e-12)
        assert dtw_banded(znormalise(a), znormalise(b), 0.1) == pytest.approx(dz_js, rel=1e-12)


# ----------------------------------------------------------------------------- find-back basics
@pytest.mark.parametrize("matcher", list(MATCHERS))
def test_identical_profile_ranks_first(matcher: str, lib: Library) -> None:
    rng = np.random.default_rng(3)
    q = _walks(rng, 1)[0]
    qf = query_features(q, 2000.0, lib.scale)
    earth_d = score(matcher, qf, lib)
    needle = Library(q[None, :], np.array([2000.0]), scale=lib.scale)
    d = float(score(matcher, qf, needle, parallel=False)[0])
    assert d == pytest.approx(0.0, abs=1e-9)
    assert rank_of(d, earth_d) == 1


@pytest.mark.parametrize("matcher", list(MATCHERS))
def test_reversed_copy_is_found_and_flagged(matcher: str, lib: Library) -> None:
    rng = np.random.default_rng(4)
    q = _walks(rng, 1)[0]
    qf = query_features(q, 2000.0, lib.scale)
    rev = Library(reverse_slopes(q)[None, :], np.array([2000.0]), scale=lib.scale)
    d = float(score(matcher, qf, rev, parallel=False)[0])
    assert d == pytest.approx(0.0, abs=1e-9)
    assert rank_of(d, score(matcher, qf, lib)) == 1
    assert best_orientation_reversed(matcher, qf, rev, 0)
    fwd = Library(q[None, :], np.array([2000.0]), scale=lib.scale)
    assert not best_orientation_reversed(matcher, qf, fwd, 0)


def test_parallel_and_serial_scores_agree(lib: Library) -> None:
    qf = query_features(_walks(np.random.default_rng(5), 1)[0], 1000.0, lib.scale)
    for m in MATCHERS:
        np.testing.assert_allclose(score(m, qf, lib, parallel=True), score(m, qf, lib, parallel=False))


def test_rank_ties_count_against_needle() -> None:
    assert rank_of(1.0, np.array([0.5, 1.0, 2.0])) == 3
    assert rank_of(0.1, np.array([0.5, 1.0])) == 1
    assert rank_of(np.inf, np.array([0.5, np.inf])) == 2


# ----------------------------------------------------------------------------- routes and needles
def _tile() -> MoonTile:
    yy, xx = np.mgrid[0:200, 0:200].astype(np.float64)
    dem = 40 * np.sin(xx / 17.0) + 25 * np.cos(yy / 11.0) + 0.3 * xx
    return MoonTile("synthetic", dem, 30.0, 1000.0, 9000.0)


def _route(tile: MoonTile, reversed_: bool = False) -> MoonRoute:
    poly = np.array([[1500.0, 8500.0], [3000.0, 7000.0], [4200.0, 7600.0]])
    prof = sample_profile(tile.dem, tile.res_m, (tile.origin_x, tile.origin_y), poly, n=P)
    h = np.asarray(prof["h_m"])
    return MoonRoute(0, tile.region_id, "two_leg", poly, float(prof["length_m"]), np.asarray(prof["slope_deg"]),
                     h - h.mean(), float(prof["climb_m"]), float(prof["max_slope_deg"]), seed=11,
                     reversed=reversed_, warp_start_frac=0.2)


def test_undistorted_needle_equals_sample_profile() -> None:
    tile = _tile()
    r = _route(tile)
    nd = make_needle(r, tile, sigma_m=0.0, stretch=0.0, points=P, reverse=False)
    np.testing.assert_allclose(nd.slope_deg, r.slope_deg, atol=1e-9)
    assert nd.climb_m == pytest.approx(r.climb_m)
    nd_rev = make_needle(r, tile, sigma_m=0.0, stretch=0.0, points=P, reverse=True)
    np.testing.assert_allclose(nd_rev.slope_deg, reverse_slopes(r.slope_deg), atol=1e-9)
    assert nd_rev.reversed


def test_needle_distortions_are_seeded_and_scaled() -> None:
    tile = _tile()
    r = _route(tile)
    a = make_needle(r, tile, 2.0, 0.05, P)
    b = make_needle(r, tile, 2.0, 0.05, P)
    np.testing.assert_array_equal(a.slope_deg, b.slope_deg)
    assert a.length_m == pytest.approx(r.length_m * 1.05)
    lo = make_needle(r, tile, 1.0, 0.0, P, reverse=False)
    hi = make_needle(r, tile, 5.0, 0.0, P, reverse=False)
    assert np.std(hi.slope_deg - r.slope_deg) > np.std(lo.slope_deg - r.slope_deg) > 0


def test_warp_positions() -> None:
    t, Lc = warp_positions(2000.0, 0.0, 0.3, P)
    np.testing.assert_allclose(t, np.linspace(0, 2000.0, P))
    t, Lc = warp_positions(2000.0, 0.1, 0.3, P)
    assert Lc == pytest.approx(2200.0)
    assert t[0] == 0.0 and t[-1] == pytest.approx(2000.0)
    assert np.all(np.diff(t) > 0)
    # The copy's sample spacing in original metres is slower inside the stretched half.
    spacing = np.diff(t)
    assert spacing.min() == pytest.approx(2200.0 / 99 / 1.2, rel=1e-6)


def test_heights_from_slopes_inverts_profile() -> None:
    tile = _tile()
    r = _route(tile)
    h = heights_from_slopes(r.slope_deg, r.length_m)
    assert np.sqrt(np.mean((h - r.h_rel_m) ** 2)) < 0.05 * np.ptp(r.h_rel_m)
    assert heights_from_slopes(np.zeros((2, P)), np.array([1000.0, 2000.0])).shape == (2, P)


# ----------------------------------------------------------------------------- app prefilter port
def test_nearest_class_matches_walk_tsx() -> None:
    classes = np.array([1000.0, 2000.0, 5000.0])
    assert nearest_class(classes, 1300.0) == 1000.0
    assert nearest_class(classes, 3000.0) == 2000.0  # |log 1.5| < |log 5/3|
    assert nearest_class(classes, 3500.0) == 5000.0


def test_app_prefilter_fallbacks() -> None:
    n = 40
    lengths = np.array([1000.0] * n + [2000.0] * n)
    climb = np.full(2 * n, 50.0)
    maxs = np.full(2 * n, 10.0)
    m = app_prefilter(lengths, climb, maxs, 1100.0, 50.0, 10.0)
    assert m.sum() == n and m[:n].all()
    m = app_prefilter(lengths, climb, maxs, 1100.0, 5000.0, 10.0)  # strict empty -> same length
    assert m.sum() == n
    m = app_prefilter(lengths[:30], climb[:30], maxs[:30], 1100.0, 50.0, 10.0)
    assert m.sum() == 30


# ----------------------------------------------------------------------------- end to end
def test_evaluate_end_to_end_on_synthetic_data(tmp_path: Path) -> None:
    rng = np.random.default_rng(9)
    (tmp_path / "moon").mkdir()
    (tmp_path / "walk").mkdir()
    regions = []
    for k in range(2):
        yy, xx = np.mgrid[0:500, 0:500].astype(np.float64)
        dem = (60 * np.sin(xx / (20 + 7 * k)) * np.cos(yy / 23.0) + rng.normal(0, 0.5, (500, 500))).astype("<f4")
        dem.tofile(tmp_path / "moon" / f"r{k}.bin")
        regions.append({"id": f"r{k}", "tile": {"path": f"moon/r{k}.bin", "size": 500, "res_m": 30.0,
                                                 "origin_x": 1e5 * k, "origin_y": 2e5}})
    (tmp_path / "regions.json").write_text(json.dumps({"meta": {}, "regions": regions}))
    n = 90
    s = _walks(rng, n).astype("<f4")
    s.tofile(tmp_path / "walk" / "transects.bin")
    items = [{"i": i, "site_id": "T", "length_m": [1000, 2000, 5000][i % 3], "climb_m": 50.0,
              "max_slope_deg": float(np.abs(s[i]).max())} for i in range(n)]
    (tmp_path / "walk" / "transects.json").write_text(json.dumps({"meta": {}, "n": n, "points": P, "items": items}))
    out = evaluate(tmp_path, n_routes=6, seed=1)
    assert out["n_routes"] == 6
    names = {m["name"] for m in out["matchers"]}
    assert set(MATCHERS) <= names and "dtw_app" in names
    assert out["winner"] in MATCHERS
    assert len(out["sweep"]) == 9
    assert {b["bin"] for b in out["by_length"]} == {"1-2 km", "2-3 km", "3-4 km"}
    json.dumps(out, allow_nan=False)
    # Re-runnable and deterministic apart from timings / timestamp.
    again = evaluate(tmp_path, n_routes=6, seed=1)
    assert [m["top1"] for m in again["matchers"]] == [m["top1"] for m in out["matchers"]]
