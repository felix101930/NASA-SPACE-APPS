"""Horizon maps and cast-shadow metrics (numba).

Conventions (shared by every function in this module)
-----------------------------------------------------
* Grids are north-up rasters, row 0 = top (= +y, "grid north"), column 0 = left (= -x).
* A grid is georeferenced by the map coordinates ``(x0, y0)`` of the **top-left corner of its
  top-left pixel** (the rasterio ``Affine.c, Affine.f`` values) plus a square pixel size ``res``.
  The centre of pixel ``(r, c)`` is therefore ``(x0 + (c + 0.5) * res, y0 - (r + 0.5) * res)``.
  The near grid and the far grid must be in the same projected CRS (metres).
* Azimuth is clockwise from grid north (+y): 0 = up, 90 = +x (right). Horizon azimuth sample
  ``k`` is at ``360 * k / n_az`` degrees.
* Horizon elevation is the maximum, over distance ``d``, of
  ``atan((h(d) - h0 - observer_height - d**2 / (2 R)) / d)`` in degrees. ``-90`` means "no terrain
  sample in that direction" (grid edge right next to the pixel); NaN means the pixel itself is NaN.
* A pixel is in shadow when the sun centre is strictly below its horizon: ``sun_el < horizon(az)``.

Search strategy
---------------
Near field: 1-pixel steps on the fine grid with bilinear sampling, until the ray leaves the fine
grid (or ``near_max_m``). Far field: continues from that distance on the coarse grid, one coarse
pixel per step, until ``max_radius_m`` or the coarse grid edge. An early-exit bound using the
maximum height of both grids, ``(hmax - h0)/d - d/(2R)`` (monotone decreasing in d), stops the
march once no remaining sample can raise the horizon.
"""
from __future__ import annotations

import logging
import math

import numpy as np
from numba import njit, prange

log = logging.getLogger(__name__)

SUN_SEMI_DIAMETER_DEG = 0.27
MOON_DECLINATION_MAX_DEG = 1.54

# fastmath without 'nnan'/'ninf' so NaN tests stay valid.
_FM = {"nsz", "arcp", "contract", "afn", "reassoc"}


# --------------------------------------------------------------------------------------------
# Georeferencing helpers
# --------------------------------------------------------------------------------------------
def origin_from_transform(transform: object) -> tuple[float, float, float]:
    """Return ``(x0, y0, res)`` from a north-up rasterio/affine ``Affine``.

    Raises ValueError for rotated or non-square grids.
    """
    a, b, c, d, e, f = (float(getattr(transform, k)) for k in "abcdef")
    if b != 0.0 or d != 0.0 or not math.isclose(a, -e, rel_tol=1e-9) or a <= 0:
        raise ValueError("expected a north-up grid with square pixels")
    return c, f, a


def centered_far_origin(
    near_shape: tuple[int, int],
    res_near: float,
    near_origin_xy: tuple[float, float],
    far_shape: tuple[int, int],
    res_far: float,
) -> tuple[float, float]:
    """Top-left corner of a far grid that shares its centre with the near grid."""
    cx = near_origin_xy[0] + near_shape[1] * res_near / 2.0
    cy = near_origin_xy[1] - near_shape[0] * res_near / 2.0
    return cx - far_shape[1] * res_far / 2.0, cy + far_shape[0] * res_far / 2.0


# --------------------------------------------------------------------------------------------
# Kernels
# --------------------------------------------------------------------------------------------
@njit(cache=True, fastmath=_FM, inline="always")
def _bilinear(a: np.ndarray, fr: float, fc: float) -> tuple[bool, float]:
    """(inside, value) of bilinear sample at fractional pixel-centre coords (fr, fc)."""
    n0, n1 = a.shape
    if fr < 0.0 or fc < 0.0 or fr > n0 - 1.0 or fc > n1 - 1.0:
        return False, 0.0
    i0 = min(int(fr), n0 - 2)
    j0 = min(int(fc), n1 - 2)
    p = fr - i0
    q = fc - j0
    v = (a[i0, j0] * (1.0 - p) * (1.0 - q) + a[i0 + 1, j0] * p * (1.0 - q)
         + a[i0, j0 + 1] * (1.0 - p) * q + a[i0 + 1, j0 + 1] * p * q)
    return True, v


@njit(parallel=True, cache=True, fastmath=_FM)
def _horizon_kernel(near, res_n, nx0, ny0, r0, c0, h_core, w_core,
                    far, res_f, fx0, fy0, use_far,
                    n_az, near_max, max_radius, inv2r, hmax, obs_h):
    out = np.empty((n_az, h_core, w_core), dtype=np.float32)
    n0, n1 = near.shape
    for kk in prange(n_az * h_core):
        k = kk // h_core
        ii = kk - k * h_core
        az = 2.0 * math.pi * k / n_az
        ux = math.sin(az)
        uy = math.cos(az)
        r = r0 + ii
        for jj in range(w_core):
            c = c0 + jj
            h0 = near[r, c]
            if h0 != h0:
                out[k, ii, jj] = np.nan
                continue
            h0 = h0 + obs_h
            best = -1e30
            done = False
            # ---- near field: 1 fine pixel per step
            s = 1
            d = res_n
            while True:  # d ends as the hand-off distance (first unsampled fine step)
                d = s * res_n
                if d > max_radius:
                    done = True
                    break
                if d > near_max:
                    break
                if (hmax - h0) / d - d * inv2r <= best:
                    done = True
                    break
                inside, h = _bilinear(near, r - uy * s, c + ux * s)
                if not inside:
                    break
                if h == h:
                    t = (h - h0) / d - d * inv2r
                    if t > best:
                        best = t
                s += 1
            # ---- far field: continue from the hand-off distance, 1 coarse pixel per step
            if use_far and not done:
                xc = nx0 + (c + 0.5) * res_n
                yc = ny0 - (r + 0.5) * res_n
                while d <= max_radius:
                    if (hmax - h0) / d - d * inv2r <= best:
                        break
                    fc = (xc + ux * d - fx0) / res_f - 0.5
                    fr = (fy0 - (yc + uy * d)) / res_f - 0.5
                    inside, h = _bilinear(far, fr, fc)
                    if not inside:
                        break
                    if h == h:
                        t = (h - h0) / d - d * inv2r
                        if t > best:
                            best = t
                    d += res_f
            out[k, ii, jj] = math.degrees(math.atan(best)) if best > -1e29 else -90.0
    return out


@njit(cache=True, fastmath=_FM, inline="always")
def _disk_visible(x: float) -> float:
    """Visible fraction of a disk whose centre is x radii above a straight horizon."""
    if x >= 1.0:
        return 1.0
    if x <= -1.0:
        return 0.0
    return 1.0 - (math.acos(x) - x * math.sqrt(1.0 - x * x)) / math.pi


@njit(parallel=True, cache=True, fastmath=_FM)
def _visibility_kernel(hz, el, az, w, semi):
    n_az, h, wd = hz.shape
    t_n = el.shape[0]
    out = np.zeros((h, wd), dtype=np.float32)
    wsum = 0.0
    for t in range(t_n):
        wsum += w[t]
    for i in prange(h):
        for j in range(wd):
            if hz[0, i, j] != hz[0, i, j]:
                out[i, j] = np.nan
                continue
            acc = 0.0
            for t in range(t_n):
                f = (az[t] % 360.0) / 360.0 * n_az
                k0 = int(f) % n_az
                k1 = (k0 + 1) % n_az
                a = f - math.floor(f)
                hh = hz[k0, i, j] * (1.0 - a) + hz[k1, i, j] * a
                if semi > 0.0:
                    acc += w[t] * _disk_visible((el[t] - hh) / semi)
                elif el[t] > hh:
                    acc += w[t]
            out[i, j] = acc / wsum
    return out


# --------------------------------------------------------------------------------------------
# Public API
# --------------------------------------------------------------------------------------------
def horizon_map(
    dem_near: np.ndarray,
    res_near: float,
    core_slice: tuple[slice, slice],
    dem_far: np.ndarray | None = None,
    res_far: float | None = None,
    near_origin_xy: tuple[float, float] = (0.0, 0.0),
    far_origin_xy: tuple[float, float] | None = None,
    n_az: int = 72,
    max_radius_m: float | None = None,
    planet_radius_m: float | None = None,
    near_max_m: float | None = None,
    observer_height_m: float = 0.0,
) -> np.ndarray:
    """Horizon elevation angles (deg) for every core pixel.

    Parameters
    ----------
    dem_near : 2-D heights (m) on the fine grid: core plus near buffer. NaN = no data (skipped).
    res_near : fine pixel size (m).
    core_slice : ``(row_slice, col_slice)`` into ``dem_near`` selecting the output pixels.
    dem_far, res_far : optional coarse grid (m, m/px) searched beyond the fine grid's extent.
    near_origin_xy, far_origin_xy : map coordinates of each grid's top-left pixel *corner*, same
        CRS. Only their difference matters. ``far_origin_xy=None`` means the far grid is centred
        on the near grid (see :func:`centered_far_origin`).
    n_az : number of azimuths, sample k at 360*k/n_az deg clockwise from grid north.
    max_radius_m : search radius (m); None = until the grid edges.
    planet_radius_m : radius for the curvature drop d**2/(2R); None disables curvature.
        Moon: 1_737_400. Earth: 7/6 * 6_371_000 (refraction-adjusted).
    near_max_m : optional cap on the fine-grid search distance; the far grid takes over beyond it.
    observer_height_m : height of the observer above the surface (m).

    Returns
    -------
    float32 array ``(n_az, H, W)``.
    """
    near = np.ascontiguousarray(dem_near, dtype=np.float64)
    if near.ndim != 2 or min(near.shape) < 2:
        raise ValueError("dem_near must be 2-D with at least 2x2 pixels")
    rs, cs = core_slice
    r0, r1, _ = rs.indices(near.shape[0])
    c0, c1, _ = cs.indices(near.shape[1])
    if r1 <= r0 or c1 <= c0:
        raise ValueError("empty core_slice")
    use_far = dem_far is not None
    if use_far:
        if res_far is None:
            raise ValueError("res_far is required with dem_far")
        far = np.ascontiguousarray(dem_far, dtype=np.float64)
        if far.ndim != 2 or min(far.shape) < 2:
            raise ValueError("dem_far must be 2-D with at least 2x2 pixels")
        if far_origin_xy is None:
            far_origin_xy = centered_far_origin(near.shape, res_near, near_origin_xy, far.shape, res_far)
        hmax = float(np.nanmax([np.nanmax(near), np.nanmax(far)]))
    else:
        far = np.zeros((2, 2))
        res_far = 1.0
        far_origin_xy = (0.0, 0.0)
        hmax = float(np.nanmax(near))
    inv2r = 0.0 if planet_radius_m is None else 0.5 / float(planet_radius_m)
    log.debug("horizon_map near=%s far=%s core=%dx%d n_az=%d", near.shape,
              far.shape if use_far else None, r1 - r0, c1 - c0, n_az)
    return _horizon_kernel(
        near, float(res_near), float(near_origin_xy[0]), float(near_origin_xy[1]),
        r0, c0, r1 - r0, c1 - c0,
        far, float(res_far), float(far_origin_xy[0]), float(far_origin_xy[1]), use_far,
        int(n_az), math.inf if near_max_m is None else float(near_max_m),
        math.inf if max_radius_m is None else float(max_radius_m),
        inv2r, hmax + max(float(observer_height_m), 0.0), float(observer_height_m),
    )


def horizon_at(horizon: np.ndarray, sun_az: float) -> np.ndarray:
    """Horizon elevation (deg) at an arbitrary azimuth, periodic linear interpolation."""
    n_az = horizon.shape[0]
    f = (float(sun_az) % 360.0) / 360.0 * n_az
    k0 = int(math.floor(f)) % n_az
    k1 = (k0 + 1) % n_az
    a = f - math.floor(f)
    return horizon[k0] * (1.0 - a) + horizon[k1] * a


def visible_disk_fraction(sun_el_minus_horizon_deg: np.ndarray,
                          semi_diameter_deg: float = SUN_SEMI_DIAMETER_DEG) -> np.ndarray:
    """Visible fraction (0..1) of the solar disk given (sun_el - horizon) in degrees."""
    x = np.clip(np.asarray(sun_el_minus_horizon_deg, dtype=np.float64) / semi_diameter_deg, -1.0, 1.0)
    return 1.0 - (np.arccos(x) - x * np.sqrt(1.0 - x * x)) / np.pi


def shadow_mask(horizon: np.ndarray, sun_el: float, sun_az: float) -> np.ndarray:
    """Boolean ``(H, W)``: True where the point sun centre is below the horizon.

    NaN horizon pixels are returned as False; use ``np.isfinite(horizon[0])`` as validity mask.
    """
    with np.errstate(invalid="ignore"):
        return horizon_at(horizon, sun_az) > float(sun_el)


def sun_visible_fraction(horizon: np.ndarray, sun_el: float, sun_az: float,
                         semi_diameter_deg: float = SUN_SEMI_DIAMETER_DEG) -> np.ndarray:
    """Float ``(H, W)`` visible fraction 0..1 of the solar disk (penumbra-aware). NaN stays NaN."""
    hz = horizon_at(horizon, sun_az)
    out = visible_disk_fraction(float(sun_el) - hz, semi_diameter_deg)
    out[~np.isfinite(hz)] = np.nan
    return out


def shadow_fraction(horizon: np.ndarray, sun_el: float, sun_az: float | None = None,
                    disk: bool = False) -> float:
    """Fraction of valid pixels in shadow.

    ``sun_az=None`` averages over all stored horizon azimuths (the fixed-elevation metrics
    ``shadow_frac_el{1,3,5}``). ``disk=True`` counts the occluded fraction of the solar disk.
    """
    valid = np.isfinite(horizon[0])
    if not valid.any():
        return float("nan")
    if sun_az is None:
        hz = horizon[:, valid]
        if disk:
            return float(1.0 - visible_disk_fraction(float(sun_el) - hz).mean())
        return float((hz > sun_el).mean())
    if disk:
        return float(1.0 - np.nanmean(sun_visible_fraction(horizon, sun_el, sun_az)[valid]))
    return float(shadow_mask(horizon, sun_el, sun_az)[valid].mean())


def time_weighted_visibility(horizon: np.ndarray, el_series: np.ndarray, az_series: np.ndarray,
                             weights: np.ndarray | None = None, disk: bool = False,
                             semi_diameter_deg: float = SUN_SEMI_DIAMETER_DEG) -> np.ndarray:
    """Per-pixel time-averaged solar visibility (0..1), float32 ``(H, W)``; NaN for NaN pixels."""
    el = np.ascontiguousarray(el_series, dtype=np.float64).ravel()
    az = np.ascontiguousarray(az_series, dtype=np.float64).ravel()
    if el.shape != az.shape or el.size == 0:
        raise ValueError("el_series and az_series must be non-empty and the same length")
    w = np.ones_like(el) if weights is None else np.ascontiguousarray(weights, dtype=np.float64).ravel()
    hz = np.ascontiguousarray(horizon, dtype=np.float32)
    return _visibility_kernel(hz, el, az, w, float(semi_diameter_deg) if disk else 0.0)


def time_weighted_shadow_fraction(horizon: np.ndarray, el_series: np.ndarray, az_series: np.ndarray,
                                  weights: np.ndarray | None = None, disk: bool = False,
                                  min_sun_el: float | None = None) -> float:
    """Mean over time and valid pixels of the shadowed state.

    ``min_sun_el`` drops samples with the sun below that elevation (e.g. 0.0 keeps only times when
    the sun is above the mathematical horizon, i.e. landing-relevant daylight). With
    ``min_sun_el=None`` every sample counts, which corresponds to ``1 - average visibility`` as in
    the PGDA AVGVISIB product.
    """
    el = np.asarray(el_series, dtype=np.float64).ravel()
    az = np.asarray(az_series, dtype=np.float64).ravel()
    w = None if weights is None else np.asarray(weights, dtype=np.float64).ravel()
    if min_sun_el is not None:
        keep = el >= min_sun_el
        if not keep.any():
            return float("nan")
        el, az = el[keep], az[keep]
        w = None if w is None else w[keep]
    vis = time_weighted_visibility(horizon, el, az, w, disk)
    return float(1.0 - np.nanmean(vis))


def sun_path_moon(lat_deg: float, n_samples: int = 4096, n_dec: int = 16,
                  dec_max_deg: float = MOON_DECLINATION_MAX_DEG,
                  dec_dist: str = "uniform",
                  lon_deg: float | None = None) -> tuple[np.ndarray, np.ndarray]:
    """Approximate long-term sun directions (el, az in deg) seen from lunar latitude ``lat_deg``.

    Approximation: the sub-solar latitude (declination) is sampled over +/-``dec_max_deg``
    (``"uniform"`` = evenly spaced values, as specified; ``"sinusoidal"`` = dec_max*sin(phase)
    with uniform phase, which is the true time distribution of a sinusoid) and the hour angle
    uniformly over 360 deg (one synodic day), the two treated as independent (incommensurate
    periods over the 18.6-yr cycle). Sun at infinity, no parallax, no libration, spherical Moon:
    ``sin el = sin(lat) sin(dec) + cos(lat) cos(dec) cos(H)``.

    Azimuth frame: with ``lon_deg=None`` azimuth is clockwise from local geographic north. Pass
    ``lon_deg`` to get **grid** azimuth for the south-polar stereographic grid (lon_0 = 0,
    x = rho sin(lon), y = rho cos(lon)), where geographic north points along grid azimuth ``lon``:
    ``grid_az = (geo_az + lon) % 360``. This matters: elevation and azimuth are both tied to the
    hour angle (near the pole el ~ dec + colat cos H), so the sun is ~2*colat higher toward
    geographic north than toward the pole, and a wrong azimuth frame puts the high sun on the
    wrong slopes. Horizon maps are in grid azimuth, so pass ``lon_deg`` for Moon tiles.

    Returns arrays of length ``n_dec * ceil(n_samples / n_dec)``; all samples have equal weight.
    """
    n_dec = max(1, min(int(n_dec), int(n_samples)))
    n_ha = int(math.ceil(n_samples / n_dec))
    phase = (np.arange(n_dec) + 0.5) / n_dec
    if dec_dist == "uniform":
        dec = np.radians(dec_max_deg * (2.0 * phase - 1.0))
    elif dec_dist == "sinusoidal":
        dec = np.radians(dec_max_deg * np.sin(2.0 * np.pi * phase))
    else:
        raise ValueError("dec_dist must be 'uniform' or 'sinusoidal'")
    ha = np.radians(np.arange(n_ha) * 360.0 / n_ha)
    d, h = np.meshgrid(dec, ha, indexing="ij")
    phi = math.radians(lat_deg)
    up = math.sin(phi) * np.sin(d) + math.cos(phi) * np.cos(d) * np.cos(h)
    east = -np.cos(d) * np.sin(h)
    north = np.sin(d) * math.cos(phi) - np.cos(d) * np.cos(h) * math.sin(phi)
    el = np.degrees(np.arcsin(np.clip(up, -1.0, 1.0)))
    az = np.degrees(np.arctan2(east, north))
    if lon_deg is not None:
        az = az + float(lon_deg)
    return el.ravel(), (az % 360.0).ravel()
