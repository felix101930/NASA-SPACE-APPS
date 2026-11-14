"""Hazard metrics shared by the Moon and Earth pipelines.

Typical use (one tile)::

    from pipeline.metrics import horizon_map, compute_all
    H = horizon_map(dem_buffered_30m, 30.0, core_slice, dem_far=far300, res_far=300.0,
                    near_origin_xy=(x0, y0), far_origin_xy=(fx0, fy0),
                    max_radius_m=100e3, planet_radius_m=MOON_R_M)
    m = compute_all(dem_buffered_30m[core_slice], H, 30.0, lat_deg=-86.0, lon_deg=lon)

``compute_all`` returns exactly the data-contract metric keys (flat), see ``CONTRACT_KEYS``;
``group_by_hazard`` reshapes them into the ``hazards`` block of ``regions.json``.
"""
from __future__ import annotations

import logging
from collections.abc import Sequence

import numpy as np

from .horizon import (
    SUN_SEMI_DIAMETER_DEG,
    centered_far_origin,
    horizon_at,
    horizon_map,
    origin_from_transform,
    shadow_fraction,
    shadow_mask,
    sun_path_moon,
    sun_visible_fraction,
    time_weighted_shadow_fraction,
    time_weighted_visibility,
)
from .profile import sample_profile
from .resample import to_grid
from .rim import rim_jump_stats
from .roughness import rms_deviation, roughness_stats, slope_deg
from .texture import fast_density, render_hillshade, texture_stats

log = logging.getLogger(__name__)

HAZARD_KEYS: dict[str, tuple[str, ...]] = {
    "shadow": ("shadow_frac_el1", "shadow_frac_el3", "shadow_frac_el5", "shadow_frac_timeweighted"),
    "rim": ("jump1km_p95_m", "jump1km_p99_m", "frac_track_over_500m"),
    "texture": ("fast_per_km2_el3", "empty_cell_frac_el3"),
    "slope": ("slope_p50_deg", "slope_p90_deg", "rms_dev_m"),
}
CONTRACT_KEYS: tuple[str, ...] = tuple(k for keys in HAZARD_KEYS.values() for k in keys)
RMS_LAGS_M: tuple[int, ...] = (60, 120, 240, 480, 960)

MetricValue = float | dict[str, float]


def compute_all(
    dem_core: np.ndarray,
    horizon: np.ndarray,
    res_m: float = 30.0,
    lat_deg: float | None = None,
    lon_deg: float | None = None,
    el_series: Sequence[float] | np.ndarray | None = None,
    az_series: Sequence[float] | np.ndarray | None = None,
    weights: Sequence[float] | np.ndarray | None = None,
    min_sun_el: float | None = 0.0,
    n_sun_samples: int = 2048,
    extras: bool = False,
) -> dict[str, MetricValue]:
    """All contract metrics for one core tile.

    Parameters
    ----------
    dem_core : (H, W) heights on the comparison grid (30 m, 500x500), no buffer.
    horizon : (n_az, H, W) from :func:`horizon_map` for exactly these pixels (computed on the
        buffered DEM + far field).
    res_m : pixel size of ``dem_core``.
    lat_deg, lon_deg : Moon latitude/longitude of the tile centre -> sun directions from
        :func:`sun_path_moon` (uniform declination), converted to south-polar-stereographic grid
        azimuth with ``lon_deg`` (grid_az = geo_az + lon). ``lon_deg=None`` leaves azimuths in the
        geographic frame and logs a warning (only correct if grid north == geographic north).
    el_series, az_series, weights : explicit sun directions (deg, az clockwise from grid north)
        and optional time weights; used instead of ``lat_deg`` (e.g. Earth windows).
    min_sun_el : time samples with sun elevation below this are dropped from
        ``shadow_frac_timeweighted`` (default 0: only times the sun is above the mathematical
        horizon). None keeps all samples (= 1 - average visibility, PGDA-comparable).
    extras : also return ``hurst``, ``jump100m_p95_m``, ``jump100m_p99_m``,
        ``shadow_frac_el7``, ``shadow_frac_timeweighted_all``.

    Returns
    -------
    Flat dict with the keys in ``CONTRACT_KEYS`` (``rms_dev_m`` is ``{"60": .., ..., "960": ..}``).
    ``shadow_frac_timeweighted`` is NaN if no sun series was given.
    """
    dem_core = np.asarray(dem_core, dtype=np.float64)
    if horizon.shape[1:] != dem_core.shape:
        raise ValueError(f"horizon {horizon.shape} does not match dem_core {dem_core.shape}")
    out: dict[str, MetricValue] = {}
    for el in (1, 3, 5):
        out[f"shadow_frac_el{el}"] = shadow_fraction(horizon, float(el))

    if el_series is not None and az_series is not None:
        el_s, az_s = np.asarray(el_series, float), np.asarray(az_series, float)
        w = None if weights is None else np.asarray(weights, float)
    elif lat_deg is not None:
        if lon_deg is None:
            log.warning("compute_all: lat_deg without lon_deg; sun azimuths stay geographic, "
                        "not grid (wrong frame on south-polar stereographic tiles)")
        el_s, az_s = sun_path_moon(lat_deg, n_sun_samples, lon_deg=lon_deg)
        w = None
    else:
        el_s = az_s = w = None
    if el_s is not None:
        out["shadow_frac_timeweighted"] = time_weighted_shadow_fraction(
            horizon, el_s, az_s, w, min_sun_el=min_sun_el)
    else:
        log.warning("compute_all: no sun series; shadow_frac_timeweighted = NaN")
        out["shadow_frac_timeweighted"] = float("nan")

    rim = rim_jump_stats(dem_core, res_m)
    out.update({k: rim[k] for k in HAZARD_KEYS["rim"]})
    tex = texture_stats(dem_core, horizon, res_m, sun_el=3.0, n_az=8)
    out.update({k: tex[k] for k in HAZARD_KEYS["texture"]})
    rough = roughness_stats(dem_core, res_m, RMS_LAGS_M)
    out["slope_p50_deg"] = rough["slope_p50_deg"]
    out["slope_p90_deg"] = rough["slope_p90_deg"]
    out["rms_dev_m"] = rough["rms_dev_m"]

    if extras:
        out["hurst"] = rough["hurst"]
        out["jump100m_p95_m"] = rim["jump100m_p95_m"]
        out["jump100m_p99_m"] = rim["jump100m_p99_m"]
        out["shadow_frac_el7"] = shadow_fraction(horizon, 7.0)
        if el_s is not None:
            out["shadow_frac_timeweighted_all"] = time_weighted_shadow_fraction(
                horizon, el_s, az_s, w, min_sun_el=None)
    return out


def group_by_hazard(metrics: dict[str, MetricValue]) -> dict[str, dict[str, dict[str, MetricValue]]]:
    """Reshape flat metrics into ``{"shadow": {"metrics": {...}}, "rim": ..., ...}``."""
    return {hz: {"metrics": {k: metrics[k] for k in keys if k in metrics}}
            for hz, keys in HAZARD_KEYS.items()}


__all__ = [
    "CONTRACT_KEYS", "HAZARD_KEYS", "RMS_LAGS_M", "SUN_SEMI_DIAMETER_DEG",
    "centered_far_origin", "compute_all", "fast_density", "group_by_hazard", "horizon_at",
    "horizon_map", "origin_from_transform", "render_hillshade", "rim_jump_stats",
    "rms_deviation", "roughness_stats", "sample_profile", "shadow_fraction", "shadow_mask",
    "slope_deg", "sun_path_moon", "sun_visible_fraction", "texture_stats",
    "time_weighted_shadow_fraction", "time_weighted_visibility", "to_grid",
]
