"""Terrain-shape features: bowl-shaped depressions, hypsometry, aspect statistics, curvature.

All functions take a north-up height grid (row 0 = north / grid +y, metres, NaN = no data) and its
pixel size ``res_m``, so the same code serves the 90 m screen and the 30 m refinement. Every
length threshold is given in metres and converted to pixels, so results at 90 m and 30 m are in
the same absolute units (they still differ because a coarser grid smooths small features).

Features (keys are prefixed ``shape_``; see :func:`shape_features`):

* **Bowl-shaped depressions** (:func:`depressions`). The DEM is filled with a priority flood
  (Barnes et al. 2014, no epsilon) seeded from the tile border and from pixels next to NaNs, so
  water can leave only through the border. ``fill depth = filled - dem``. Each 8-connected
  region with fill depth > 0 is one closed depression (its outline is the spill contour). It is
  kept when
  - max fill depth >= ``min_depth_m`` (default ``max(2 m, 0.05 * res)``: 2 m at 30 m, 4.5 m at
    90 m; above Copernicus / LOLA vertical noise),
  - equivalent diameter ``D = 2 sqrt(A / pi)`` is in ``[min_diam_px * res, max_diam_m]``
    (default 3 px .. 3 km),
  - depth / diameter >= ``min_depth_ratio`` (default 0.02: rejects broad shallow noise sinks;
    fresh lunar craters are ~0.2, degraded ones ~0.05-0.1).
  Limits: on Earth most closed depressions are sinks, karst dolines, kettles, playas or DEM
  artefacts, not impact craters; we call them "bowl-shaped depressions" and only use their
  statistics. Nested craters are counted once, at the spill level of the outer bowl. Bowls cut by
  the tile edge drain through the edge and are not counted. Open, breached craters (a gap in the
  rim) are not closed depressions and are missed.
* **Hypsometry** (:func:`hypsometry`): ``HI = (mean - min) / (max - min)`` (Strahler 1952) and a
  robust version with the 1st / 99th percentiles; plus the 101-quantile normalised height curve.
* **Aspect** (:func:`aspect_stats`): downslope azimuth clockwise from grid +y on pixels with slope
  > ``min_slope_deg`` (Horn gradients, as ``roughness.slope_deg``). Mean resultant length ``R``
  (0 = all directions, 1 = one direction), axial resultant ``R2`` (of 2*theta: high for ridges
  and valleys with two opposite facing sides), mean direction, and an 8-bin histogram (bins
  centred on 0, 45, ..., 315 deg) both raw and rotated so the fullest bin comes first (frame-free;
  Moon grid +y is not geographic north).
* **Curvature** (:func:`curvature_stats`): Zevenbergen & Thorne (1987) second derivatives with a
  finite-difference step of ``k = round(scale / res)`` pixels after a box pre-filter of the same
  width, at two scales (default 270 m and 1080 m). Sign convention: **convex = positive**
  (peaks, ridges, crater rims), concave = negative (bowls, valleys). Reported per km:
  ``lap`` = -(z_xx + z_yy), profile curvature (along the slope line) and plan curvature (across
  it; only on pixels with slope > ``min_slope_deg``, because it is undefined on flats).

Pure numpy/scipy, except the priority-flood fill, which is a small numba kernel (numba is already
a dependency of ``horizon.py``); a heapq fallback runs if numba is unavailable.
"""
from __future__ import annotations

import heapq
import logging
import math
from collections.abc import Sequence
from typing import TypedDict

import numpy as np
from scipy import ndimage

log = logging.getLogger(__name__)

Q101 = np.linspace(0.0, 100.0, 101)
CURV_SCALES_M: tuple[float, ...] = (270.0, 1080.0)
MIN_SLOPE_DEG = 2.0
ASPECT_BINS = 8

ScalarValue = float | list[float]


class ShapeFeatures(TypedDict):
    """Same layout as one region of ``fingerprints_90m.json`` (scalars + 101-quantile lists)."""

    scalars: dict[str, ScalarValue]
    quantiles_101: dict[str, list[float]]


class DepressionResult(TypedDict):
    n: int
    per_100km2: float
    area_frac: float
    diam_m: np.ndarray
    depth_m: np.ndarray
    fill_depth: np.ndarray


# --------------------------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------------------------
def q101(values: np.ndarray, ndigits: int = 5) -> list[float]:
    """101 quantiles (0..100 %) of the finite values, rounded; [] if none (fingerprint convention)."""
    v = np.asarray(values, dtype=np.float64).ravel()
    v = v[np.isfinite(v)]
    if not v.size:
        return []
    return [round(float(x), ndigits) for x in np.percentile(v, Q101)]


def w1_quantiles(a: Sequence[float] | np.ndarray, b: Sequence[float] | np.ndarray) -> float:
    """1-D Wasserstein distance from two 101-quantile vectors: mean |Qa - Qb|. NaN if either empty."""
    qa, qb = np.asarray(a, dtype=np.float64), np.asarray(b, dtype=np.float64)
    if qa.size == 0 or qb.size == 0 or qa.size != qb.size:
        return float("nan")
    return float(np.nanmean(np.abs(qa - qb)))


def horn_gradient(dem: np.ndarray, res_m: float) -> tuple[np.ndarray, np.ndarray]:
    """(dz/dx east, dz/dy north) with Horn 3x3 weights, edge replication (as ``slope_deg``)."""
    z = np.pad(np.asarray(dem, dtype=np.float64), 1, mode="edge")
    a, b, c = z[:-2, :-2], z[:-2, 1:-1], z[:-2, 2:]
    d, f = z[1:-1, :-2], z[1:-1, 2:]
    g, h, i = z[2:, :-2], z[2:, 1:-1], z[2:, 2:]
    dzdx = ((c + 2 * f + i) - (a + 2 * d + g)) / (8.0 * res_m)
    dzdy = ((a + 2 * b + c) - (g + 2 * h + i)) / (8.0 * res_m)  # row 0 is north -> +y
    return dzdx, dzdy


# --------------------------------------------------------------------------------------------
# priority-flood fill
# --------------------------------------------------------------------------------------------
_NB = np.array([(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)], dtype=np.int64)


def _fill_python(z: np.ndarray) -> np.ndarray:
    n0, n1 = z.shape
    filled = z.copy()
    closed = ~np.isfinite(z)
    heap: list[tuple[float, int]] = []
    for r in range(n0):
        for c in range(n1):
            if closed[r, c]:
                continue
            seed = r == 0 or c == 0 or r == n0 - 1 or c == n1 - 1
            if not seed:
                for dr, dc in _NB:
                    if not np.isfinite(z[r + dr, c + dc]):
                        seed = True
                        break
            if seed:
                closed[r, c] = True
                heapq.heappush(heap, (float(z[r, c]), r * n1 + c))
    while heap:
        h, idx = heapq.heappop(heap)
        r, c = divmod(idx, n1)
        for dr, dc in _NB:
            rr, cc = r + dr, c + dc
            if 0 <= rr < n0 and 0 <= cc < n1 and not closed[rr, cc]:
                closed[rr, cc] = True
                v = max(float(z[rr, cc]), h)
                filled[rr, cc] = v
                heapq.heappush(heap, (v, rr * n1 + cc))
    return filled


try:
    import numba as _nb

    @_nb.njit(cache=True)
    def _fill_numba(z: np.ndarray) -> np.ndarray:  # pragma: no cover - compiled
        n0, n1 = z.shape
        filled = z.copy()
        closed = np.zeros((n0, n1), dtype=np.bool_)
        cap = n0 * n1 + 1
        hz = np.empty(cap, dtype=np.float64)
        hi = np.empty(cap, dtype=np.int64)
        size = 0
        dr8 = np.array([-1, -1, -1, 0, 0, 1, 1, 1])
        dc8 = np.array([-1, 0, 1, -1, 1, -1, 0, 1])
        for r in range(n0):
            for c in range(n1):
                if not np.isfinite(z[r, c]):
                    closed[r, c] = True
        for r in range(n0):
            for c in range(n1):
                if closed[r, c]:
                    continue
                seed = r == 0 or c == 0 or r == n0 - 1 or c == n1 - 1
                if not seed:
                    for k in range(8):
                        if not np.isfinite(z[r + dr8[k], c + dc8[k]]):
                            seed = True
                            break
                if seed:
                    closed[r, c] = True
                    # push
                    j = size
                    size += 1
                    hz[j] = z[r, c]
                    hi[j] = r * n1 + c
                    while j > 0:
                        p = (j - 1) // 2
                        if hz[p] <= hz[j]:
                            break
                        hz[p], hz[j] = hz[j], hz[p]
                        hi[p], hi[j] = hi[j], hi[p]
                        j = p
        while size > 0:
            h = hz[0]
            idx = hi[0]
            size -= 1
            hz[0] = hz[size]
            hi[0] = hi[size]
            j = 0
            while True:
                lft = 2 * j + 1
                if lft >= size:
                    break
                m = lft
                if lft + 1 < size and hz[lft + 1] < hz[lft]:
                    m = lft + 1
                if hz[j] <= hz[m]:
                    break
                hz[m], hz[j] = hz[j], hz[m]
                hi[m], hi[j] = hi[j], hi[m]
                j = m
            r = idx // n1
            c = idx - r * n1
            for k in range(8):
                rr = r + dr8[k]
                cc = c + dc8[k]
                if rr < 0 or cc < 0 or rr >= n0 or cc >= n1 or closed[rr, cc]:
                    continue
                closed[rr, cc] = True
                v = z[rr, cc]
                if v < h:
                    v = h
                filled[rr, cc] = v
                j = size
                size += 1
                hz[j] = v
                hi[j] = rr * n1 + cc
                while j > 0:
                    p = (j - 1) // 2
                    if hz[p] <= hz[j]:
                        break
                    hz[p], hz[j] = hz[j], hz[p]
                    hi[p], hi[j] = hi[j], hi[p]
                    j = p
        return filled

    _HAVE_NUMBA = True
except ImportError:  # pragma: no cover
    _HAVE_NUMBA = False


def fill_depressions(dem: np.ndarray) -> np.ndarray:
    """Priority-flood filled DEM (outlets: tile border and NaN neighbours). NaN stays NaN."""
    z = np.ascontiguousarray(dem, dtype=np.float64)
    if z.ndim != 2 or min(z.shape) < 3:
        return z.copy()
    return _fill_numba(z) if _HAVE_NUMBA else _fill_python(z)


# --------------------------------------------------------------------------------------------
# 1. depressions
# --------------------------------------------------------------------------------------------
def default_min_depth(res_m: float) -> float:
    """Resolution-aware depth floor: max(2 m, 0.05 * res)."""
    return max(2.0, 0.05 * res_m)


def depressions(dem: np.ndarray, res_m: float, min_depth_m: float | None = None,
                min_diam_px: float = 3.0, max_diam_m: float = 3000.0,
                min_depth_ratio: float = 0.02) -> DepressionResult:
    """Closed bowl-shaped depressions (see module docstring for the definition and limits).

    Returns ``n``, ``per_100km2`` (count per 100 km^2 of valid area), ``area_frac`` (fraction of
    valid pixels inside kept depressions), ``diam_m`` / ``depth_m`` arrays (one entry per kept
    depression) and the full ``fill_depth`` grid.
    """
    z = np.asarray(dem, dtype=np.float64)
    dmin = default_min_depth(res_m) if min_depth_m is None else float(min_depth_m)
    filled = fill_depressions(z)
    fd = filled - z
    valid = np.isfinite(z)
    n_valid = int(valid.sum())
    empty = np.empty(0)
    if n_valid == 0:
        return {"n": 0, "per_100km2": float("nan"), "area_frac": float("nan"),
                "diam_m": empty, "depth_m": empty, "fill_depth": fd}
    lab, n_lab = ndimage.label(np.where(valid, fd, 0.0) > 1e-9, structure=np.ones((3, 3), dtype=bool))
    if n_lab:
        idx = np.arange(1, n_lab + 1)
        area_px = np.bincount(lab.ravel(), minlength=n_lab + 1)[1:].astype(np.float64)
        depth = np.asarray(ndimage.maximum(np.where(valid, fd, 0.0), lab, idx), dtype=np.float64)
        diam = 2.0 * np.sqrt(area_px / math.pi) * res_m
        keep = ((depth >= dmin) & (diam >= min_diam_px * res_m) & (diam <= max_diam_m)
                & (depth / np.maximum(diam, 1e-9) >= min_depth_ratio))
        diam_k, depth_k = diam[keep], depth[keep]
        area_frac = float(area_px[keep].sum() / n_valid)
    else:
        diam_k = depth_k = empty
        area_frac = 0.0
    area_km2 = n_valid * (res_m / 1000.0) ** 2
    return {"n": int(diam_k.size), "per_100km2": float(diam_k.size / area_km2 * 100.0),
            "area_frac": area_frac, "diam_m": diam_k, "depth_m": depth_k, "fill_depth": fd}


# --------------------------------------------------------------------------------------------
# 2. hypsometry
# --------------------------------------------------------------------------------------------
def hypsometry(dem: np.ndarray) -> tuple[float, float, np.ndarray]:
    """(HI min/max, HI p1/p99, normalised heights (h - min) / (max - min) of finite pixels)."""
    v = np.asarray(dem, dtype=np.float64).ravel()
    v = v[np.isfinite(v)]
    if v.size == 0:
        return float("nan"), float("nan"), v
    lo, hi = float(v.min()), float(v.max())
    if hi - lo <= 1e-9:
        return float("nan"), float("nan"), np.zeros_like(v)
    hi_mm = (float(v.mean()) - lo) / (hi - lo)
    p1, p99 = np.percentile(v, [1, 99])
    vr = np.clip(v, p1, p99)
    hi_rob = (float(vr.mean()) - p1) / (p99 - p1) if p99 - p1 > 1e-9 else float("nan")
    return hi_mm, float(hi_rob), (v - lo) / (hi - lo)


# --------------------------------------------------------------------------------------------
# 3. aspect
# --------------------------------------------------------------------------------------------
def aspect_deg(dem: np.ndarray, res_m: float) -> tuple[np.ndarray, np.ndarray]:
    """(downslope azimuth deg clockwise from grid +y in [0, 360), slope deg)."""
    dzdx, dzdy = horn_gradient(dem, res_m)
    az = np.degrees(np.arctan2(-dzdx, -dzdy)) % 360.0
    slope = np.degrees(np.arctan(np.hypot(dzdx, dzdy)))
    return az, slope


def aspect_stats(dem: np.ndarray, res_m: float, min_slope_deg: float = MIN_SLOPE_DEG,
                 n_bins: int = ASPECT_BINS) -> dict[str, ScalarValue]:
    """Circular statistics of aspect on pixels steeper than ``min_slope_deg``.

    Keys: ``R`` (mean resultant length), ``R2`` (axial, of 2*theta), ``mean_dir_deg``,
    ``frac_sloped`` (share of valid pixels used), ``hist`` and ``hist_aligned`` (fractions,
    ``n_bins`` bins centred on 0, 360/n_bins, ...; aligned = rotated so the fullest bin is first).
    """
    az, slope = aspect_deg(dem, res_m)
    valid = np.isfinite(slope)
    m = valid & (slope > min_slope_deg)
    nanv = float("nan")
    if not m.any():
        return {"R": nanv, "R2": nanv, "mean_dir_deg": nanv,
                "frac_sloped": 0.0 if valid.any() else nanv,
                "hist": [nanv] * n_bins, "hist_aligned": [nanv] * n_bins}
    th = np.radians(az[m])
    c1, s1 = np.cos(th).mean(), np.sin(th).mean()
    c2, s2 = np.cos(2 * th).mean(), np.sin(2 * th).mean()
    width = 360.0 / n_bins
    b = np.floor(((az[m] + width / 2.0) % 360.0) / width).astype(np.int64) % n_bins
    hist = np.bincount(b, minlength=n_bins).astype(np.float64)
    hist /= hist.sum()
    hist_al = np.roll(hist, -int(np.argmax(hist)))
    return {"R": float(math.hypot(c1, s1)), "R2": float(math.hypot(c2, s2)),
            "mean_dir_deg": float(math.degrees(math.atan2(s1, c1)) % 360.0),
            "frac_sloped": float(m.sum() / valid.sum()),
            "hist": [round(float(x), 5) for x in hist], "hist_aligned": [round(float(x), 5) for x in hist_al]}


# --------------------------------------------------------------------------------------------
# 4. curvature
# --------------------------------------------------------------------------------------------
def curvature_maps(dem: np.ndarray, res_m: float, scale_m: float,
                   min_slope_deg: float = MIN_SLOPE_DEG) -> dict[str, np.ndarray]:
    """Convex-positive curvature maps (1/m) at baseline ``scale_m``; NaN where not defined.

    ``lap`` = -(z_xx + z_yy); ``profile`` = -(r p^2 + 2 s p q + t q^2) / (g^2 (1 + g^2)^1.5);
    ``plan`` = -(t p^2 - 2 s p q + r q^2) / g^3, with p = z_x, q = z_y, r = z_xx, s = z_xy,
    t = z_yy, g^2 = p^2 + q^2 (x east, y north). Profile / plan are NaN where slope <=
    ``min_slope_deg``. Pixels closer than ``k + w // 2`` to the edge (``w`` = box width) are NaN.
    """
    z = np.asarray(dem, dtype=np.float64)
    k = max(1, int(round(scale_m / res_m)))
    n0, n1 = z.shape
    out = {key: np.full(z.shape, np.nan) for key in ("lap", "profile", "plan")}
    if n0 <= 2 * k or n1 <= 2 * k:
        return out
    w = 2 * (k // 2) + 1
    zs = ndimage.uniform_filter(z, size=w, mode="nearest") if w > 1 else z
    h = k * res_m
    c = zs[k:-k, k:-k]
    e, wv = zs[k:-k, 2 * k:], zs[k:-k, :-2 * k]          # east, west
    nn, ss = zs[:-2 * k, k:-k], zs[2 * k:, k:-k]          # north (row - k), south
    ne, nw = zs[:-2 * k, 2 * k:], zs[:-2 * k, :-2 * k]
    se, sw = zs[2 * k:, 2 * k:], zs[2 * k:, :-2 * k]
    p = (e - wv) / (2 * h)
    q = (nn - ss) / (2 * h)
    r = (e - 2 * c + wv) / (h * h)
    t = (nn - 2 * c + ss) / (h * h)
    s = (ne - nw - se + sw) / (4 * h * h)
    g2 = p * p + q * q
    lap = -(r + t)
    steep = np.degrees(np.arctan(np.sqrt(g2))) > min_slope_deg
    with np.errstate(invalid="ignore", divide="ignore"):
        prof = -(r * p * p + 2 * s * p * q + t * q * q) / (g2 * (1.0 + g2) ** 1.5)
        plan = -(t * p * p - 2 * s * p * q + r * q * q) / (g2 ** 1.5)
    out["lap"][k:-k, k:-k] = lap
    out["profile"][k:-k, k:-k] = np.where(steep, prof, np.nan)
    out["plan"][k:-k, k:-k] = np.where(steep, plan, np.nan)
    mg = k + w // 2  # the box pre-filter is biased by edge replication within w//2 of the border
    for arr in out.values():
        arr[:mg, :] = np.nan
        arr[-mg:, :] = np.nan
        arr[:, :mg] = np.nan
        arr[:, -mg:] = np.nan
    return out


def _scale_tag(scale_m: float) -> str:
    return f"{scale_m:g}m"


def curvature_stats(dem: np.ndarray, res_m: float, scales_m: Sequence[float] = CURV_SCALES_M,
                    min_slope_deg: float = MIN_SLOPE_DEG) -> tuple[dict[str, float], dict[str, list[float]]]:
    """Scalars (per km) and 101-quantile lists of lap / profile curvature at each scale.

    Scalar keys per scale tag ``T`` (e.g. ``270m``): ``shape_lap_{T}_p05|p50|p95_per_km``,
    ``shape_prof_{T}_p05|p95_per_km``, ``shape_plan_{T}_p05|p95_per_km``,
    ``shape_convex_frac_{T}`` (share of lap > 0). Quantile keys: ``shape_lap_{T}_per_km``,
    ``shape_prof_{T}_per_km``.
    """
    scal: dict[str, float] = {}
    quant: dict[str, list[float]] = {}
    nanv = float("nan")
    for sc in scales_m:
        tag = _scale_tag(sc)
        cm = curvature_maps(dem, res_m, sc, min_slope_deg)
        lap = cm["lap"][np.isfinite(cm["lap"])] * 1000.0
        prof = cm["profile"][np.isfinite(cm["profile"])] * 1000.0
        plan = cm["plan"][np.isfinite(cm["plan"])] * 1000.0
        if lap.size:
            p05, p50, p95 = np.percentile(lap, [5, 50, 95])
            scal.update({f"shape_lap_{tag}_p05_per_km": float(p05), f"shape_lap_{tag}_p50_per_km": float(p50),
                         f"shape_lap_{tag}_p95_per_km": float(p95),
                         f"shape_convex_frac_{tag}": float((lap > 0).mean())})
        else:
            scal.update({f"shape_lap_{tag}_p05_per_km": nanv, f"shape_lap_{tag}_p50_per_km": nanv,
                         f"shape_lap_{tag}_p95_per_km": nanv, f"shape_convex_frac_{tag}": nanv})
        for name, arr in (("prof", prof), ("plan", plan)):
            if arr.size:
                a05, a95 = np.percentile(arr, [5, 95])
            else:
                a05 = a95 = nanv
            scal[f"shape_{name}_{tag}_p05_per_km"] = float(a05)
            scal[f"shape_{name}_{tag}_p95_per_km"] = float(a95)
        quant[f"shape_lap_{tag}_per_km"] = q101(lap)
        quant[f"shape_prof_{tag}_per_km"] = q101(prof)
    return scal, quant


# --------------------------------------------------------------------------------------------
# all together
# --------------------------------------------------------------------------------------------
def shape_features(dem: np.ndarray, res_m: float, curv_scales_m: Sequence[float] = CURV_SCALES_M,
                   min_slope_deg: float = MIN_SLOPE_DEG, min_depth_m: float | None = None,
                   min_diam_px: float = 3.0, max_diam_m: float = 3000.0,
                   min_depth_ratio: float = 0.02) -> ShapeFeatures:
    """All shape features of one core tile (no buffer), in fingerprint layout.

    ``scalars``:
      ``shape_depr_n``, ``shape_depr_per_100km2``, ``shape_depr_area_frac``,
      ``shape_depr_diam_p50_m``, ``shape_depr_depth_p50_m``, ``shape_depr_dD_p50`` (NaN if none),
      ``shape_hypso_integral``, ``shape_hypso_integral_robust``,
      ``shape_aspect_R``, ``shape_aspect_R2``, ``shape_aspect_mean_dir_deg``,
      ``shape_aspect_frac_sloped``, ``shape_aspect_hist8`` / ``shape_aspect_hist8_aligned`` (lists),
      curvature scalars from :func:`curvature_stats`.
    ``quantiles_101``:
      ``shape_hypso_norm_height``, ``shape_depr_diam_m``, ``shape_depr_depth_m`` ([] if no
      depressions), ``shape_lap_{T}_per_km``, ``shape_prof_{T}_per_km``.
    """
    z = np.asarray(dem, dtype=np.float64)
    nanv = float("nan")
    dep = depressions(z, res_m, min_depth_m, min_diam_px, max_diam_m, min_depth_ratio)
    hi_mm, hi_rob, hnorm = hypsometry(z)
    asp = aspect_stats(z, res_m, min_slope_deg)
    curv_s, curv_q = curvature_stats(z, res_m, curv_scales_m, min_slope_deg)
    has = dep["n"] > 0
    scal: dict[str, ScalarValue] = {
        "shape_depr_n": float(dep["n"]),
        "shape_depr_per_100km2": dep["per_100km2"],
        "shape_depr_area_frac": dep["area_frac"],
        "shape_depr_diam_p50_m": float(np.median(dep["diam_m"])) if has else nanv,
        "shape_depr_depth_p50_m": float(np.median(dep["depth_m"])) if has else nanv,
        "shape_depr_dD_p50": float(np.median(dep["depth_m"] / dep["diam_m"])) if has else nanv,
        "shape_hypso_integral": hi_mm,
        "shape_hypso_integral_robust": hi_rob,
        "shape_aspect_R": asp["R"],
        "shape_aspect_R2": asp["R2"],
        "shape_aspect_mean_dir_deg": asp["mean_dir_deg"],
        "shape_aspect_frac_sloped": asp["frac_sloped"],
        "shape_aspect_hist8": asp["hist"],
        "shape_aspect_hist8_aligned": asp["hist_aligned"],
    }
    scal.update(curv_s)
    quant: dict[str, list[float]] = {
        "shape_hypso_norm_height": q101(hnorm),
        "shape_depr_diam_m": q101(dep["diam_m"], 2),
        "shape_depr_depth_m": q101(dep["depth_m"], 3),
    }
    quant.update(curv_q)
    return {"scalars": scal, "quantiles_101": quant}


# Which hazard each feature should count toward (proposal; see docs/features-extra.md).
SHAPE_HAZARD_KEYS: dict[str, dict[str, tuple[str, ...]]] = {
    "rim": {
        "scalars": ("shape_depr_per_100km2", "shape_depr_area_frac", "shape_hypso_integral"),
        "quantiles_101": ("shape_lap_270m_per_km", "shape_prof_270m_per_km", "shape_lap_1080m_per_km",
                          "shape_hypso_norm_height", "shape_depr_diam_m"),
    },
    "shadow": {
        "scalars": ("shape_aspect_R", "shape_aspect_R2"),
        "quantiles_101": (),
    },
}

# Floors for IQR-based scales (avoid dividing by ~0 for very uniform Moon regions).
SCALE_FLOORS: dict[str, float] = {
    "shape_hypso_norm_height": 0.05, "shape_depr_diam_m": 90.0, "shape_depr_depth_m": 5.0,
    "shape_lap_270m_per_km": 0.05, "shape_prof_270m_per_km": 0.05,
    "shape_lap_1080m_per_km": 0.02, "shape_prof_1080m_per_km": 0.02,
}


def quantile_distance(earth_q: Sequence[float], moon_q: Sequence[float], floor: float) -> float:
    """W1 between 101-quantile vectors divided by max(Moon IQR, floor); NaN if either is empty."""
    mq = np.asarray(moon_q, dtype=np.float64)
    if mq.size != 101:
        return float("nan")
    return w1_quantiles(earth_q, mq) / max(float(mq[75] - mq[25]), floor)


__all__ = [
    "CURV_SCALES_M", "SCALE_FLOORS", "SHAPE_HAZARD_KEYS", "ShapeFeatures", "aspect_deg", "aspect_stats",
    "curvature_maps", "curvature_stats", "default_min_depth", "depressions", "fill_depressions",
    "horn_gradient", "hypsometry", "q101", "quantile_distance", "shape_features", "w1_quantiles",
]
