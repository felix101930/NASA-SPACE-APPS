"""Height / slope profile along a polyline. Kept deliberately simple: the web app ports this
exact logic to TypeScript.

Algorithm
1. Georeference: ``origin_xy = (x0, y0)`` is the map coordinate of the top-left CORNER of pixel
   (0, 0); north-up; pixel (r, c) centre = (x0 + (c + .5)*res, y0 - (r + .5)*res).
   So a point (x, y) maps to fractional pixel coords ``col = (x - x0)/res - 0.5``,
   ``row = (y0 - y)/res - 0.5``.
2. Resample the polyline to ``n`` points equally spaced by arc length (both endpoints included):
   spacing ``ds = length / (n - 1)``.
3. Height at each point by bilinear interpolation; points outside the pixel-centre hull clamp to
   the nearest edge pixel; a NaN neighbour gives NaN.
4. Signed slope (deg) = ``atan(dh/ds)`` using central differences
   (``(h[i+1]-h[i-1]) / (2 ds)``) and one-sided differences at the two ends (numpy.gradient).
   Positive = climbing in the direction of travel.
5. ``climb_m`` = sum of positive successive height differences, ``descent_m`` = sum of negative
   ones (positive number), ``max_slope_deg`` = max |slope|.
"""
from __future__ import annotations

import math
from collections.abc import Sequence

import numpy as np


def _bilinear_clamped(z: np.ndarray, r: np.ndarray, c: np.ndarray) -> np.ndarray:
    n0, n1 = z.shape
    r = np.clip(r, 0.0, n0 - 1.0)
    c = np.clip(c, 0.0, n1 - 1.0)
    i0 = np.minimum(np.floor(r).astype(np.int64), max(n0 - 2, 0))
    j0 = np.minimum(np.floor(c).astype(np.int64), max(n1 - 2, 0))
    i1 = np.minimum(i0 + 1, n0 - 1)
    j1 = np.minimum(j0 + 1, n1 - 1)
    p = r - i0
    q = c - j0
    return (z[i0, j0] * (1 - p) * (1 - q) + z[i1, j0] * p * (1 - q)
            + z[i0, j1] * (1 - p) * q + z[i1, j1] * p * q)


def resample_polyline(polyline_xy: Sequence[Sequence[float]], n: int) -> tuple[np.ndarray, np.ndarray, np.ndarray, float]:
    """(x, y, s) of ``n`` points equally spaced by arc length, plus the total length."""
    pts = np.asarray(polyline_xy, dtype=np.float64)
    if pts.ndim != 2 or pts.shape[0] < 2 or pts.shape[1] != 2:
        raise ValueError("polyline_xy must be a sequence of at least two (x, y) points")
    seg = np.hypot(np.diff(pts[:, 0]), np.diff(pts[:, 1]))
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    length = float(cum[-1])
    s = np.linspace(0.0, length, n)
    x = np.interp(s, cum, pts[:, 0])
    y = np.interp(s, cum, pts[:, 1])
    return x, y, s, length


def sample_profile(dem: np.ndarray, res_m: float, origin_xy: Sequence[float],
                   polyline_xy: Sequence[Sequence[float]], n: int = 100) -> dict[str, object]:
    """Profile along ``polyline_xy`` (map metres). Returns a dict with arrays ``s_m``, ``x``, ``y``,
    ``h_m``, ``slope_deg`` (length n) and floats ``length_m``, ``climb_m``, ``descent_m``,
    ``max_slope_deg``."""
    if n < 2:
        raise ValueError("n must be >= 2")
    z = np.asarray(dem, dtype=np.float64)
    x, y, s, length = resample_polyline(polyline_xy, n)
    col = (x - origin_xy[0]) / res_m - 0.5
    row = (origin_xy[1] - y) / res_m - 0.5
    h = _bilinear_clamped(z, row, col)
    ds = length / (n - 1)
    if ds > 0:
        slope = np.degrees(np.arctan(np.gradient(h, ds)))
    else:
        slope = np.zeros(n)
    dh = np.diff(h)
    return {
        "s_m": s, "x": x, "y": y, "h_m": h, "slope_deg": slope,
        "length_m": length,
        "climb_m": float(np.nansum(np.clip(dh, 0, None))),
        "descent_m": float(-np.nansum(np.clip(dh, None, 0))),
        "max_slope_deg": float(np.nanmax(np.abs(slope))) if np.isfinite(slope).any() else math.nan,
    }
