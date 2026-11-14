"""Profile matchers compared by the find-back test.

``dtw_banded`` is a line-for-line port of ``web/src/lib/dtw.ts::dtwBanded`` (Sakoe-Chiba band,
absolute-difference cost, steps (i-1,j), (i-1,j-1), (i,j-1), total cost divided by max(n, m),
optional early abandon) and ``znormalise`` ports ``zNormalise`` (population SD, SD 0 -> 1).
Direction handling follows ``web/src/workers/dtw.worker.ts``: every Earth row is scored as stored
and walked backwards (order reversed, slope sign flipped) and the smaller distance is kept.

Every library scorer returns, for one query, a distance per library row (smaller = more alike).
"""
from __future__ import annotations

import math
from collections.abc import Sequence

import numba
import numpy as np

BAND_FRAC = 0.1


# ----------------------------------------------------------------------------- single-pair kernels
@numba.njit(cache=True)
def dtw_banded(a: np.ndarray, b: np.ndarray, band_frac: float = BAND_FRAC,
               abandon_above: float = np.inf) -> float:
    """Mean absolute DTW cost (input units), exactly as the browser's ``dtwBanded``."""
    n = a.shape[0]
    m = b.shape[0]
    w = max(1, int(math.ceil(band_frac * max(n, m))), abs(n - m))
    prev = np.full(m + 1, np.inf)
    cur = np.full(m + 1, np.inf)
    prev[0] = 0.0
    limit = abandon_above * (n + m)
    for i in range(1, n + 1):
        cur[:] = np.inf
        j_start = max(1, i - w)
        j_end = min(m, i + w)
        row_min = np.inf
        for j in range(j_start, j_end + 1):
            cost = abs(a[i - 1] - b[j - 1])
            best = min(prev[j], prev[j - 1], cur[j - 1])
            v = cost + best
            cur[j] = v
            if v < row_min:
                row_min = v
        if row_min > limit:
            return np.inf
        prev, cur = cur, prev
    return prev[m] / max(n, m)


def dtw_naive(a: Sequence[float], b: Sequence[float], band_frac: float = BAND_FRAC) -> float:
    """Textbook full-matrix banded DTW, used only as a test reference for ``dtw_banded``."""
    n, m = len(a), len(b)
    w = max(1, math.ceil(band_frac * max(n, m)), abs(n - m))
    inf = float("inf")
    d = [[inf] * (m + 1) for _ in range(n + 1)]
    d[0][0] = 0.0
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            if abs(i - j) > w:
                continue
            d[i][j] = abs(a[i - 1] - b[j - 1]) + min(d[i - 1][j], d[i - 1][j - 1], d[i][j - 1])
    return d[n][m] / max(n, m)


@numba.njit(cache=True)
def _znorm_1d(a: np.ndarray) -> np.ndarray:
    n = a.shape[0]
    mean = 0.0
    for i in range(n):
        mean += a[i]
    mean /= n
    v = 0.0
    for i in range(n):
        v += (a[i] - mean) ** 2
    sd = math.sqrt(v / n)
    if sd == 0.0:
        sd = 1.0
    out = np.empty(n)
    for i in range(n):
        out[i] = (a[i] - mean) / sd
    return out


def znormalise(a: np.ndarray) -> np.ndarray:
    """Port of ``zNormalise``: works on 1-D or row-wise on 2-D arrays."""
    x = np.asarray(a, dtype=np.float64)
    if x.ndim == 1:
        return _znorm_1d(x)
    mean = x.mean(axis=1, keepdims=True)
    sd = np.sqrt(((x - mean) ** 2).mean(axis=1, keepdims=True))
    sd[sd == 0] = 1.0
    return (x - mean) / sd


# ----------------------------------------------------------------------------- feature helpers
def reverse_slopes(s: np.ndarray) -> np.ndarray:
    """The same path walked backwards: reverse order, flip sign (row-wise for 2-D input)."""
    return -np.asarray(s)[..., ::-1]


def heights_from_slopes(slope_deg: np.ndarray, length_m: np.ndarray | float) -> np.ndarray:
    """Relative height (m, mean removed) by trapezoid-integrating tan(slope) over ds = L/(n-1).

    Earth transects store only slopes, so every matcher that uses height derives it this way, for
    queries too, to keep the comparison consistent. Works row-wise on 2-D input.
    """
    s = np.atleast_2d(np.asarray(slope_deg, dtype=np.float64))
    n = s.shape[1]
    ds = np.broadcast_to(np.asarray(length_m, dtype=np.float64), (s.shape[0],)) / (n - 1)
    g = np.tan(np.radians(s))
    steps = 0.5 * (g[:, 1:] + g[:, :-1]) * ds[:, None]
    h = np.concatenate([np.zeros((s.shape[0], 1)), np.cumsum(steps, axis=1)], axis=1)
    h -= h.mean(axis=1, keepdims=True)
    return h if np.ndim(slope_deg) == 2 else h[0]


# ----------------------------------------------------------------------------- library scorers
@numba.njit(parallel=True, cache=True)
def _dtw_lib_par(q: np.ndarray, fwd: np.ndarray, bwd: np.ndarray, band: float) -> np.ndarray:
    out = np.empty(fwd.shape[0])
    for i in numba.prange(fwd.shape[0]):
        a = dtw_banded(q, fwd[i], band, np.inf)
        b = dtw_banded(q, bwd[i], band, np.inf)
        out[i] = min(a, b)
    return out


@numba.njit(cache=True)
def _dtw_lib_ser(q: np.ndarray, fwd: np.ndarray, bwd: np.ndarray, band: float) -> np.ndarray:
    out = np.empty(fwd.shape[0])
    for i in range(fwd.shape[0]):
        a = dtw_banded(q, fwd[i], band, np.inf)
        b = dtw_banded(q, bwd[i], band, np.inf)
        out[i] = min(a, b)
    return out


@numba.njit(parallel=True, cache=True)
def _rms_lib_par(q: np.ndarray, fwd: np.ndarray, bwd: np.ndarray) -> np.ndarray:
    out = np.empty(fwd.shape[0])
    p = q.shape[0]
    for i in numba.prange(fwd.shape[0]):
        sa = 0.0
        sb = 0.0
        for k in range(p):
            sa += (q[k] - fwd[i, k]) ** 2
            sb += (q[k] - bwd[i, k]) ** 2
        out[i] = math.sqrt(min(sa, sb) / p)
    return out


@numba.njit(cache=True)
def _rms_lib_ser(q: np.ndarray, fwd: np.ndarray, bwd: np.ndarray) -> np.ndarray:
    out = np.empty(fwd.shape[0])
    p = q.shape[0]
    for i in range(fwd.shape[0]):
        sa = 0.0
        sb = 0.0
        for k in range(p):
            sa += (q[k] - fwd[i, k]) ** 2
            sb += (q[k] - bwd[i, k]) ** 2
        out[i] = math.sqrt(min(sa, sb) / p)
    return out


class Library:
    """Pre-computed per-matcher representations of a set of slope profiles (both directions).

    ``slopes`` [N, P] degrees, ``length_m`` [N]. ``scale`` (sd_height_m, sd_slope_deg) used by the
    height+slope matcher; defaults to this library's own spread (pass the Earth library's scale when
    building a one-row library for a needle so both are standardised identically).
    """

    def __init__(self, slopes: np.ndarray, length_m: np.ndarray, scale: tuple[float, float] | None = None):
        s = np.ascontiguousarray(np.asarray(slopes, dtype=np.float64))
        self.n, self.p = s.shape
        self.length_m = np.asarray(length_m, dtype=np.float64)
        self.fwd = s
        self.bwd = np.ascontiguousarray(reverse_slopes(s))
        self.z_fwd = np.ascontiguousarray(znormalise(self.fwd))
        self.z_bwd = np.ascontiguousarray(znormalise(self.bwd))
        h = heights_from_slopes(s, self.length_m)
        if scale is None:
            sd_h = float(np.std(h)) or 1.0
            sd_s = float(np.std(s)) or 1.0
            scale = (sd_h, sd_s)
        self.scale = scale
        # Height+slope feature: standardised channels concatenated; RMS over 2P values is then
        # sqrt((mean dh'^2 + mean ds'^2)/2), order-equivalent to the sum of both channel MSEs.
        hs_f = np.concatenate([h / scale[0], s / scale[1]], axis=1)
        hs_b = np.concatenate([h[:, ::-1] / scale[0], self.bwd / scale[1]], axis=1)
        self.hs_fwd = np.ascontiguousarray(hs_f)
        self.hs_bwd = np.ascontiguousarray(hs_b)


def query_features(slope_deg: np.ndarray, length_m: float, scale: tuple[float, float]) -> dict[str, np.ndarray]:
    s = np.ascontiguousarray(np.asarray(slope_deg, dtype=np.float64))
    h = heights_from_slopes(s, length_m)
    return {
        "raw": s,
        "z": np.ascontiguousarray(znormalise(s)),
        "hs": np.ascontiguousarray(np.concatenate([h / scale[0], s / scale[1]])),
    }


MATCHERS: dict[str, str] = {
    "dtw_slope": "Banded DTW (Sakoe-Chiba 10%) on signed slope - the browser's default search",
    "dtw_slope_znorm": "Banded DTW 10% on z-normalised slope - the browser's 'Compare shape only' option",
    "euclid_slope": "Euclidean (RMS) on signed slope, no warping",
    "euclid_height_slope": "Euclidean on relative height + slope, each channel standardised by the library spread",
}


def score(matcher: str, qf: dict[str, np.ndarray], lib: Library, parallel: bool = True) -> np.ndarray:
    """Distance from one query to every row of ``lib`` (both walking directions, min kept)."""
    if matcher == "dtw_slope":
        f = _dtw_lib_par if parallel else _dtw_lib_ser
        return f(qf["raw"], lib.fwd, lib.bwd, BAND_FRAC)
    if matcher == "dtw_slope_znorm":
        f = _dtw_lib_par if parallel else _dtw_lib_ser
        return f(qf["z"], lib.z_fwd, lib.z_bwd, BAND_FRAC)
    if matcher == "euclid_slope":
        f = _rms_lib_par if parallel else _rms_lib_ser
        return f(qf["raw"], lib.fwd, lib.bwd)
    if matcher == "euclid_height_slope":
        f = _rms_lib_par if parallel else _rms_lib_ser
        return f(qf["hs"], lib.hs_fwd, lib.hs_bwd)
    raise ValueError(f"unknown matcher {matcher!r}")


def pair_distances(matcher: str, qf: dict[str, np.ndarray], lib: Library, i: int) -> tuple[float, float]:
    """(distance as stored, distance walked backwards) between the query and row ``i``."""
    if matcher in ("dtw_slope", "dtw_slope_znorm"):
        q, f, b = (qf["raw"], lib.fwd, lib.bwd) if matcher == "dtw_slope" else (qf["z"], lib.z_fwd, lib.z_bwd)
        return float(dtw_banded(q, f[i], BAND_FRAC)), float(dtw_banded(q, b[i], BAND_FRAC))
    if matcher in ("euclid_slope", "euclid_height_slope"):
        q, f, b = (qf["raw"], lib.fwd, lib.bwd) if matcher == "euclid_slope" else (qf["hs"], lib.hs_fwd, lib.hs_bwd)
        return (float(np.sqrt(np.mean((q - f[i]) ** 2))), float(np.sqrt(np.mean((q - b[i]) ** 2))))
    raise ValueError(f"unknown matcher {matcher!r}")


def best_orientation_reversed(matcher: str, qf: dict[str, np.ndarray], lib: Library, i: int) -> bool:
    """True when row ``i`` matches better walked backwards (ties -> as stored, like the worker)."""
    a, b = pair_distances(matcher, qf, lib, i)
    return b < a


def rank_of(needle_d: float, earth_d: np.ndarray) -> int:
    """1-based rank of the needle among ``earth_d`` + needle; ties count against the needle."""
    if not np.isfinite(needle_d):
        return int(np.sum(np.isfinite(earth_d))) + 1
    return int(np.sum(earth_d <= needle_d)) + 1


def rank_sorted(needle_d: float, earth_sorted: np.ndarray) -> int:
    """``rank_of`` against an ascending-sorted array (fast path for the sweep)."""
    return int(np.searchsorted(earth_sorted, needle_d, side="right")) + 1
