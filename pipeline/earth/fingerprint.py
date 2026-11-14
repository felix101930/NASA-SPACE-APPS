"""Cheap 90 m terrain fingerprints for the stage-1 global screen.

Uses pipeline.metrics when available (same definitions as the Moon side); otherwise local
fallbacks with the definitions agreed with metrics-builder:
- slope: Horn 3x3, p50/p90 over the core.
- relief: P99 - P1 of core heights.
- rim jump: J = |h(p + L u) - h(p)|, L = 1 km, 16 axes over 180 deg, p and p+Lu both in core,
  bilinear at p+Lu; P95, P99, fraction of samples > 500 m.
- nu(L): RMS of h(x+L) - h(x) over x and y lags (plane removed), lags rounded to whole pixels.
- shadow_frac_local_el{1,3,5}: horizon over 72 azimuths, 1 px steps, bilinear, curvature drop d^2/(2R);
  shadow at el = fraction of (pixel, azimuth) with horizon > el. Window + 15 km buffer only.
"""
from __future__ import annotations

import logging
import math

import numba
import numpy as np

from pipeline.common.config import EARTH_R_EFF_M
from pipeline.earth.dem import Geom, fill_nan, read_dem, site_geom

log = logging.getLogger("pipeline.earth.fingerprint")

RES = 90.0
CORE_N = 167                 # 15.03 km
BUF_N = 167                  # 15.03 km each side
NEAR_N = CORE_N + 2 * BUF_N  # 501
CORE = slice(BUF_N, BUF_N + CORE_N)
EL_FIXED = (1.0, 3.0, 5.0)
NU_LAGS = (180, 360, 720, 1440)

FP_KEYS = (
    "slope_p50_deg", "slope_p90_deg", "relief_m",
    "jump1km_p95_m", "jump1km_p99_m", "frac_track_over_500m",
    "nu_180", "nu_360", "nu_720", "nu_1440",
    "shadow_frac_local_el1", "shadow_frac_local_el3", "shadow_frac_local_el5",
)
# NOTE: stage-1 shadow is a LOCAL proxy (window + 15 km buffer, no far field). It is named
# shadow_frac_local_* so it is never confused with stage-2 shadow_frac_el* (far field to 150 km).


# ----------------------------------------------------------------------------- fallbacks
def slope_deg_local(dem: np.ndarray, res: float) -> np.ndarray:
    z = np.pad(dem, 1, mode="edge")
    a, b, c = z[:-2, :-2], z[:-2, 1:-1], z[:-2, 2:]
    d, f = z[1:-1, :-2], z[1:-1, 2:]
    g, h, i = z[2:, :-2], z[2:, 1:-1], z[2:, 2:]
    dzdx = ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * res)
    dzdy = ((g + 2 * h + i) - (a + 2 * b + c)) / (8 * res)
    return np.degrees(np.arctan(np.hypot(dzdx, dzdy))).astype(np.float32)


def _bilinear(dem: np.ndarray, r: np.ndarray, c: np.ndarray) -> np.ndarray:
    r0 = np.floor(r).astype(int)
    c0 = np.floor(c).astype(int)
    r0 = np.clip(r0, 0, dem.shape[0] - 2)
    c0 = np.clip(c0, 0, dem.shape[1] - 2)
    fr, fc = r - r0, c - c0
    return ((1 - fr) * (1 - fc) * dem[r0, c0] + (1 - fr) * fc * dem[r0, c0 + 1]
            + fr * (1 - fc) * dem[r0 + 1, c0] + fr * fc * dem[r0 + 1, c0 + 1])


def rim_jump_local(dem: np.ndarray, res: float, baseline_m: float = 1000.0, n_dirs: int = 16,
                   threshold_m: float = 500.0, stride: int = 2, return_samples: bool = False) -> dict:
    H, W = dem.shape
    L = baseline_m / res
    rr, cc = np.mgrid[0:H:stride, 0:W:stride]
    rr = rr.ravel().astype(float)
    cc = cc.ravel().astype(float)
    h0 = dem[rr.astype(int), cc.astype(int)]
    js = []
    for k in range(n_dirs):
        az = math.pi * k / n_dirs
        r1 = rr - L * math.cos(az)
        c1 = cc + L * math.sin(az)
        ok = (r1 >= 0) & (r1 <= H - 1) & (c1 >= 0) & (c1 <= W - 1)
        if ok.any():
            js.append(np.abs(_bilinear(dem, r1[ok], c1[ok]) - h0[ok]))
    j = np.concatenate(js)
    j = j[np.isfinite(j)]
    if j.size == 0:
        return {"jump1km_p95_m": float("nan"), "jump1km_p99_m": float("nan"), "frac_track_over_500m": float("nan")}
    out = {"jump1km_p95_m": float(np.percentile(j, 95)), "jump1km_p99_m": float(np.percentile(j, 99)),
           "frac_track_over_500m": float((j > threshold_m).mean())}
    if return_samples:
        out["_samples"] = j
    return out


def nu_local(dem: np.ndarray, res: float, lags_m=NU_LAGS) -> dict[str, float]:
    H, W = dem.shape
    yy, xx = np.mgrid[0:H, 0:W]
    A = np.c_[xx.ravel(), yy.ravel(), np.ones(H * W)]
    z = dem.ravel().astype(np.float64)
    ok = np.isfinite(z)
    coef, *_ = np.linalg.lstsq(A[ok], z[ok], rcond=None)
    d = (z - A @ coef).reshape(H, W)
    out = {}
    for L in lags_m:
        k = max(1, int(round(L / res)))
        dx = (d[:, k:] - d[:, :-k]).ravel()
        dy = (d[k:, :] - d[:-k, :]).ravel()
        v = np.concatenate([dx, dy])
        v = v[np.isfinite(v)]
        out[f"nu_{L}"] = float(np.sqrt(np.mean(v * v))) if v.size else float("nan")
    return out


@numba.njit(nogil=True, cache=True, fastmath=True)
def _horizon_nb(dem, res, r0, r1, c0, c1, stride, n_az, R, hmax):
    H, W = dem.shape
    nr = (r1 - r0 + stride - 1) // stride
    nc = (c1 - c0 + stride - 1) // stride
    out = np.empty((n_az, nr, nc), np.float32)
    for k in range(n_az):
        az = 2.0 * np.pi * k / n_az
        dr = -np.cos(az)
        dc = np.sin(az)
        for ii in range(nr):
            i = r0 + ii * stride
            for jj in range(nc):
                j = c0 + jj * stride
                h0 = dem[i, j]
                best = -1e9
                s = 1
                while True:
                    r = i + dr * s
                    c = j + dc * s
                    if r < 0.0 or c < 0.0 or r > H - 1.0 or c > W - 1.0:
                        break
                    d = s * res
                    # early exit: even the highest point could not raise the horizon
                    if (hmax - h0) / d < best:
                        break
                    ri = int(r)
                    ci = int(c)
                    if ri > H - 2:
                        ri = H - 2
                    if ci > W - 2:
                        ci = W - 2
                    fr = r - ri
                    fc = c - ci
                    hh = ((1 - fr) * (1 - fc) * dem[ri, ci] + (1 - fr) * fc * dem[ri, ci + 1]
                          + fr * (1 - fc) * dem[ri + 1, ci] + fr * fc * dem[ri + 1, ci + 1])
                    t = (hh - h0 - d * d / (2.0 * R)) / d
                    if t > best:
                        best = t
                    s += 1
                out[k, ii, jj] = np.degrees(np.arctan(best))
    return out


def horizon_local(dem_near: np.ndarray, res: float, core: tuple[slice, slice], n_az: int = 72,
                  R: float = EARTH_R_EFF_M, stride: int = 1) -> np.ndarray:
    """Horizon angles (deg) [n_az, core rows/stride, core cols/stride]. Releases the GIL."""
    rs, cs = core
    d = np.ascontiguousarray(dem_near, dtype=np.float64)
    return _horizon_nb(d, float(res), rs.start, rs.stop, cs.start, cs.stop, int(stride), n_az, float(R),
                       float(np.nanmax(d)))


# ----------------------------------------------------------------------------- metrics binding
def _metrics_api():
    """Return pipeline.metrics submodules if the metrics package is ready, else None."""
    try:
        from pipeline.metrics import horizon, rim, roughness  # noqa: F401
        if hasattr(horizon, "horizon_map") and hasattr(rim, "rim_jump_stats") and hasattr(roughness, "roughness_stats"):
            return horizon, rim, roughness
    except Exception:  # noqa: BLE001
        return None
    return None


def fingerprint_dem(near: np.ndarray, res: float = RES, core_n: int = CORE_N,
                    R: float = EARTH_R_EFF_M, use_metrics: bool = False,
                    hz_stride: int = 2, quantiles: bool = False) -> dict:
    """Fingerprint of the centred core of a buffered DEM (near) at resolution res.

    Default is the local, GIL-free implementation (safe to run in many threads; numbers match
    pipeline.metrics to <0.2 %; horizon evaluated on every 2nd core pixel in each axis, which moves
    shadow fractions by <0.002). use_metrics=True calls pipeline.metrics (numba-parallel; do not
    call from several threads at once).
    """
    n = near.shape[0]
    b = (n - core_n) // 2
    core_sl = (slice(b, b + core_n), slice(b, b + core_n))
    nan_frac = float(np.isnan(near[core_sl]).mean())
    near_f = fill_nan(near)
    core = near_f[core_sl]
    fp: dict[str, float] = {"core_nan_frac": nan_frac}
    api = _metrics_api() if use_metrics else None
    if api is not None:
        horizon, rim, roughness = api
        rs = roughness.roughness_stats(core, res, lags_m=NU_LAGS)
        fp["slope_p50_deg"], fp["slope_p90_deg"] = float(rs["slope_p50_deg"]), float(rs["slope_p90_deg"])
        for L in NU_LAGS:
            fp[f"nu_{L}"] = float(rs["rms_dev_m"][str(L)])
        rj = rim.rim_jump_stats(core, res)
        for k in ("jump1km_p95_m", "jump1km_p99_m", "frac_track_over_500m"):
            fp[k] = float(rj[k])
        hz = horizon.horizon_map(near_f, res, core_slice=core_sl, n_az=72, planet_radius_m=R)
        for el in EL_FIXED:
            fp[f"shadow_frac_local_el{int(el)}"] = float(horizon.shadow_fraction(hz, el))
        fp["impl"] = "pipeline.metrics"
    else:
        sl = slope_deg_local(near_f, res)[core_sl]
        fp["slope_p50_deg"] = float(np.percentile(sl, 50))
        fp["slope_p90_deg"] = float(np.percentile(sl, 90))
        rj = rim_jump_local(core, res, stride=1, return_samples=quantiles)
        jsamp = rj.pop("_samples", None)
        fp.update(rj)
        fp.update(nu_local(core, res))
        hz = horizon_local(near_f, res, core_sl, 72, R, stride=hz_stride)
        for el in EL_FIXED:
            fp[f"shadow_frac_local_el{int(el)}"] = float((hz > el).mean())
        fp["impl"] = "local"
        if quantiles:
            q = np.linspace(0, 100, 101)
            qd = {"slope_deg": np.percentile(sl, q),
                  "height_m": np.percentile(core - np.median(core), q),
                  "jump1km_m": np.percentile(jsamp, q) if jsamp is not None and jsamp.size else np.full(101, np.nan)}
            for el in EL_FIXED:
                qd[f"shadow_az_frac_el{int(el)}_local"] = np.percentile((hz > el).mean(axis=0), q)
            fp["quantiles_101"] = {k: [round(float(x), 3) for x in v] for k, v in qd.items()}
    fp["relief_m"] = float(np.percentile(core, 99) - np.percentile(core, 1))
    fp["elev_mean_m"] = float(core.mean())
    return fp


def fingerprint_90m(lat: float, lon: float, quantiles: bool = True) -> dict:
    """Fetch GLO-90 (cached tiles) around (lat, lon) on a local UTM grid and fingerprint it."""
    g: Geom = site_geom(lat, lon, RES, NEAR_N)
    near = read_dem(g, source=90)
    if np.isnan(near[CORE, CORE]).mean() > 0.2:
        return {"core_nan_frac": float(np.isnan(near[CORE, CORE]).mean()), "epsg": g.epsg}
    fp = fingerprint_dem(near, RES, CORE_N, quantiles=quantiles)
    fp["epsg"] = g.epsg
    return fp
