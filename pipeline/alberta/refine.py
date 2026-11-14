"""30 m refinement of Alberta's top windows (same construction as the earth stage 2).

Per window (local UTM zone, north-up, row 0 = north): GLO-30 near field 1500 x 1500 px (15 km core +
15 km buffer) via HTTP range reads; GLO-90 far field average-resampled to 180 m out to the search radius
(<= 150 km); horizon_map with curvature R_eff = config.EARTH_R_EFF_M, 72 azimuths; compute_all with
fixed sun elevations 1/3/5 deg and the site's real low-sun series (apparent el in (0, 7] deg over 2026,
pipeline.earth.sun.low_sun_series) rotated into the grid frame.
Web: alberta/<id>.bin (500 x 500 Float32 LE, row 0 = north, corner origin) + alberta/<id>_hill.png.
"""
from __future__ import annotations

import json
import logging
import math
import time

import numpy as np
from pyproj import Transformer
from rasterio.enums import Resampling

from pipeline.alberta.common import SITE_DIR, WEB_AB
from pipeline.alberta.dem import fill_nan, read_dem, site_geom
from pipeline.common.config import CORE_SIZE_PX, EARTH_R_EFF_M, GRID_RES_M

log = logging.getLogger("pipeline.alberta.refine")

RES = GRID_RES_M
CORE_N = CORE_SIZE_PX
BUF_N = 500
NEAR_N = CORE_N + 2 * BUF_N
CORE = (slice(BUF_N, BUF_N + CORE_N), slice(BUF_N, BUF_N + CORE_N))
FAR_RES_M = 180.0
FAR_RADIUS_M = 150_000.0


def search_radius_m(dh_m: float, el_deg: float = 0.5, r_min: float = 30e3, r_max: float = FAR_RADIUS_M) -> float:
    """Same rule as pipeline.earth.compute.search_radius_m."""
    te = math.tan(math.radians(el_deg))
    d = EARTH_R_EFF_M * (-te + math.sqrt(te * te + 2.0 * max(dh_m, 50.0) / EARTH_R_EFF_M))
    return float(min(max(1.1 * d, r_min), r_max))


def true_north_grid_az(lat: float, lon: float, epsg: int) -> float:
    tr = Transformer.from_crs("EPSG:4326", f"EPSG:{epsg}", always_xy=True)
    x0, y0 = tr.transform(lon, lat)
    x1, y1 = tr.transform(lon, lat + 0.01)
    return math.degrees(math.atan2(x1 - x0, y1 - y0))


def hillshade(dem: np.ndarray, res: float, az_deg: float = 315.0, alt_deg: float = 35.0) -> np.ndarray:
    """Lambertian hillshade 0..255, azimuth clockwise from grid +y (same as earth/moon tiles)."""
    filled = np.where(np.isfinite(dem), dem, np.nanmean(dem) if np.isfinite(dem).any() else 0.0)
    gy, gx = np.gradient(filled, res)
    dzdx, dzdy = gx, -gy
    az, alt = np.radians(az_deg), np.radians(alt_deg)
    sx, sy, sz = np.sin(az) * np.cos(alt), np.cos(az) * np.cos(alt), np.sin(alt)
    shade = (-dzdx * sx - dzdy * sy + sz) / np.sqrt(1 + dzdx ** 2 + dzdy ** 2)
    return (np.clip(shade, 0, 1) * 255).astype(np.uint8)


def refine_site(wid: str, lat: float, lon: float, force: bool = False) -> dict:
    from pipeline.earth.sun import low_sun_series
    from pipeline.metrics import compute_all, horizon_map
    mp = SITE_DIR / f"{wid}_metrics.json"
    if mp.exists() and (WEB_AB / f"{wid}.bin").exists() and not force:
        return json.loads(mp.read_text())
    t0 = time.time()
    g = site_geom(lat, lon, RES, NEAR_N)
    near = read_dem(g, source=30)
    core_raw = near[CORE]
    nan_frac = float(np.isnan(core_raw).mean())
    core_raw.astype("<f4").tofile(WEB_AB / f"{wid}.bin")
    import cv2
    cv2.imwrite(str(WEB_AB / f"{wid}_hill.png"), hillshade(core_raw, RES))
    t_io = time.time() - t0
    if nan_frac > 0.5:
        out = {"id": wid, "status": "nodata", "core_nan_frac": nan_frac}
        mp.write_text(json.dumps(out))
        return out
    fg = g.with_res(FAR_RES_M, int(2 * FAR_RADIUS_M / FAR_RES_M) + 2)
    far = read_dem(fg, source=90, resampling=Resampling.average)
    far[np.isnan(far)] = 0.0
    near_f = fill_nan(near)
    radius = search_radius_m(float(np.nanmax(far)) - float(np.nanmin(core_raw)))
    H = horizon_map(near_f, RES, CORE, dem_far=far, res_far=FAR_RES_M, near_origin_xy=g.origin,
                    far_origin_xy=fg.origin, n_az=72, max_radius_m=radius, planet_radius_m=EARTH_R_EFF_M)
    north = true_north_grid_az(lat, lon, g.epsg)
    el_s, az_s, _ = low_sun_series(lat, lon)
    m = compute_all(near_f[CORE], H, RES, el_series=el_s, az_series=np.mod(az_s + north, 360.0), extras=True)
    ox, oy = g.origin
    out = {"id": wid, "status": "ok", "metrics": m, "epsg": g.epsg,
           "origin_x": ox + BUF_N * RES, "origin_y": oy - BUF_N * RES,
           "true_north_grid_az_deg": round(north, 3), "core_nan_frac": nan_frac,
           "core_relief_m": float(np.nanpercentile(core_raw, 99) - np.nanpercentile(core_raw, 1)),
           "elev_mean_m": float(np.nanmean(core_raw)), "far_res_m": FAR_RES_M, "search_radius_m": round(radius),
           "low_sun_samples": int(el_s.size), "io_s": round(t_io, 1), "total_s": round(time.time() - t0, 1)}
    mp.write_text(json.dumps(out, indent=1, default=float))
    log.info("refined %s: %.0f s, shadow_el3 %.3f, jump p95 %.0f m", wid, out["total_s"], m["shadow_frac_el3"],
             m["jump1km_p95_m"])
    return out


def refine_many(sites: list[dict], force: bool = False) -> dict[str, dict]:
    """sites: [{id, lat, lon}]; serial (horizon_map is numba-parallel internally)."""
    res = {}
    t0 = time.time()
    for i, s in enumerate(sites):
        try:
            res[s["id"]] = refine_site(s["id"], s["lat"], s["lon"], force=force)
        except Exception as exc:  # noqa: BLE001
            log.warning("refine %s failed: %s", s["id"], exc)
            res[s["id"]] = {"id": s["id"], "status": "error", "error": str(exc)[:200]}
        if (i + 1) % 5 == 0:
            log.info("refine: %d/%d (%.0f s)", i + 1, len(sites), time.time() - t0)
    return res
