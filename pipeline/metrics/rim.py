"""Rim-jump statistics (Hakuto-R hazard): height change over a fixed horizontal baseline.

For each of ``n_dirs`` directions spread evenly over 180 deg (|dh| is symmetric, so opposite
directions are redundant), every pixel ``p`` whose partner ``p + L*u`` also lies inside the tile
contributes one sample ``J = |h(p + L*u) - h(p)|`` (partner height by bilinear interpolation).
This is equivalent to sliding the baseline along every straight transect through the tile.
Each sample represents one pixel of track length, so "fraction of track length over threshold"
is the fraction of pooled samples with ``J > threshold``.

ispace has not published the altimeter-rejection threshold; ``threshold_m=500`` is illustrative.
"""
from __future__ import annotations

import logging
import math

import numpy as np
from scipy.ndimage import map_coordinates

log = logging.getLogger(__name__)


def _baseline_label(baseline_m: float) -> str:
    """1000 -> '1km', 100 -> '100m', 1500 -> '1.5km'."""
    if baseline_m >= 1000.0:
        km = baseline_m / 1000.0
        return f"{km:g}km"
    return f"{baseline_m:g}m"


def jump_samples(dem: np.ndarray, res_m: float, baseline_m: float, n_dirs: int = 16) -> np.ndarray:
    """Pooled |dh| samples (m) over ``baseline_m`` for ``n_dirs`` directions; NaNs removed."""
    z = np.asarray(dem, dtype=np.float64)
    n0, n1 = z.shape
    rows, cols = np.mgrid[0:n0, 0:n1].astype(np.float64)
    lag = baseline_m / res_m
    out: list[np.ndarray] = []
    for k in range(n_dirs):
        th = math.pi * k / n_dirs  # clockwise from grid north
        dr = -math.cos(th) * lag
        dc = math.sin(th) * lag
        rr = rows + dr
        cc = cols + dc
        ok = (rr >= 0) & (rr <= n0 - 1) & (cc >= 0) & (cc <= n1 - 1)
        if not ok.any():
            continue
        h1 = map_coordinates(z, [rr[ok], cc[ok]], order=1, mode="nearest", prefilter=False)
        j = np.abs(h1 - z[ok])
        out.append(j[np.isfinite(j)])
    if not out:
        return np.empty(0)
    return np.concatenate(out)


def rim_jump_stats(dem: np.ndarray, res_m: float, baseline_m: float = 1000.0, n_dirs: int = 16,
                   threshold_m: float = 500.0, short_baseline_m: float | None = 100.0) -> dict[str, float]:
    """Rim-jump percentiles and exceedance fraction.

    Returns keys (labels derived from the arguments; defaults shown):
    ``jump1km_p95_m``, ``jump1km_p99_m``, ``frac_track_over_500m`` and, if ``short_baseline_m``
    is not None, ``jump100m_p95_m``, ``jump100m_p99_m``. NaN if the tile is narrower than the
    baseline or all-NaN.
    """
    lab = _baseline_label(baseline_m)
    res: dict[str, float] = {}
    j = jump_samples(dem, res_m, baseline_m, n_dirs)
    if j.size:
        p95, p99 = np.percentile(j, [95, 99])
        res[f"jump{lab}_p95_m"] = float(p95)
        res[f"jump{lab}_p99_m"] = float(p99)
        res[f"frac_track_over_{threshold_m:g}m"] = float((j > threshold_m).mean())
    else:
        log.warning("rim_jump_stats: no valid samples for baseline %.0f m", baseline_m)
        res[f"jump{lab}_p95_m"] = res[f"jump{lab}_p99_m"] = float("nan")
        res[f"frac_track_over_{threshold_m:g}m"] = float("nan")
    if short_baseline_m is not None:
        slab = _baseline_label(short_baseline_m)
        js = jump_samples(dem, res_m, short_baseline_m, n_dirs)
        if js.size:
            q95, q99 = np.percentile(js, [95, 99])
            res[f"jump{slab}_p95_m"], res[f"jump{slab}_p99_m"] = float(q95), float(q99)
        else:
            res[f"jump{slab}_p95_m"] = res[f"jump{slab}_p99_m"] = float("nan")
    return res
