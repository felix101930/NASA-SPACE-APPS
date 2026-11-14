"""Slope and multi-baseline roughness.

* Slope: Horn (1981) 3x3 finite differences, degrees. Edge pixels use edge replication.
* RMS deviation (Shepard et al. 1999): ``nu(L) = sqrt(mean[(z(x+L) - z(x))**2])`` over x- and
  y-lags pooled, after removing the least-squares plane from the tile (so a regional tilt does not
  dominate). Lags are rounded to whole pixels: ``p = max(1, round(L / res))``; the effective lag
  is ``p * res`` (e.g. at 90 m the 60 m lag is evaluated at 90 m). Lags of at least the tile size
  give NaN.
* Hurst-like exponent: least-squares slope of log(nu) vs log(L_effective).
"""
from __future__ import annotations

import math
from collections.abc import Sequence

import numpy as np

DEFAULT_LAGS_M: tuple[int, ...] = (60, 120, 240, 480, 960)


def slope_deg(dem: np.ndarray, res_m: float) -> np.ndarray:
    """Horn 3x3 slope in degrees (float64, same shape; NaN propagates)."""
    z = np.pad(np.asarray(dem, dtype=np.float64), 1, mode="edge")
    a, b, c = z[:-2, :-2], z[:-2, 1:-1], z[:-2, 2:]
    d, f = z[1:-1, :-2], z[1:-1, 2:]
    g, h, i = z[2:, :-2], z[2:, 1:-1], z[2:, 2:]
    dzdx = ((c + 2 * f + i) - (a + 2 * d + g)) / (8.0 * res_m)
    dzdy = ((g + 2 * h + i) - (a + 2 * b + c)) / (8.0 * res_m)
    return np.degrees(np.arctan(np.hypot(dzdx, dzdy)))


def detrend_plane(dem: np.ndarray) -> np.ndarray:
    """Subtract the least-squares plane fitted to the finite pixels."""
    z = np.asarray(dem, dtype=np.float64)
    rows, cols = np.mgrid[0:z.shape[0], 0:z.shape[1]]
    ok = np.isfinite(z)
    if ok.sum() < 3:
        return z - np.nanmean(z) if ok.any() else z.copy()
    a = np.column_stack([rows[ok], cols[ok], np.ones(ok.sum())])
    coef, *_ = np.linalg.lstsq(a, z[ok], rcond=None)
    return z - (coef[0] * rows + coef[1] * cols + coef[2])


def rms_deviation(dem: np.ndarray, res_m: float, lags_m: Sequence[float] = DEFAULT_LAGS_M,
                  detrend: bool = True) -> dict[str, float]:
    """``{str(int(L)): nu(L) in metres}`` for each requested lag (keys are the nominal lags)."""
    z = detrend_plane(dem) if detrend else np.asarray(dem, dtype=np.float64)
    out: dict[str, float] = {}
    for lag in lags_m:
        p = max(1, int(round(lag / res_m)))
        if p >= min(z.shape):
            out[f"{int(lag)}"] = float("nan")
            continue
        dx = (z[:, p:] - z[:, :-p]).ravel()
        dy = (z[p:, :] - z[:-p, :]).ravel()
        d = np.concatenate([dx, dy])
        d = d[np.isfinite(d)]
        out[f"{int(lag)}"] = float(np.sqrt(np.mean(d * d))) if d.size else float("nan")
    return out


def hurst_slope(rms: dict[str, float], res_m: float) -> float:
    """Log-log slope of nu(L) vs effective lag; NaN with fewer than 2 usable lags."""
    xs, ys = [], []
    for k, v in rms.items():
        lag_eff = max(1, int(round(float(k) / res_m))) * res_m
        if np.isfinite(v) and v > 0:
            xs.append(math.log(lag_eff))
            ys.append(math.log(v))
    if len(set(xs)) < 2:
        return float("nan")
    return float(np.polyfit(xs, ys, 1)[0])


def roughness_stats(dem: np.ndarray, res_m: float,
                    lags_m: Sequence[float] = DEFAULT_LAGS_M) -> dict[str, object]:
    """``slope_p50_deg``, ``slope_p90_deg``, ``rms_dev_m`` (dict) and ``hurst``."""
    s = slope_deg(dem, res_m)
    s = s[np.isfinite(s)]
    p50, p90 = (np.percentile(s, [50, 90]) if s.size else (np.nan, np.nan))
    rms = rms_deviation(dem, res_m, lags_m)
    return {"slope_p50_deg": float(p50), "slope_p90_deg": float(p90), "rms_dev_m": rms,
            "hurst": hurst_slope(rms, res_m)}
