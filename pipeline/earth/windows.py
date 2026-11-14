"""Stage-2 Earth windows at 30 m, for any list of (id, lat, lon).

Per site (local UTM zone, north-up, row 0 = north):
- near: GLO-30, 15 km core + 15 km buffer = 45 km, 1500 x 1500 px at 30 m (cached .npz).
- far : GLO-90 (cached tiles), radius FAR_RADIUS_M (150 km) at FAR_RES_M, rebuilt on demand from
        the cached GLO-90 tiles (cheap), so it is not stored per site.
- WorldCover 10 m class shares over the 15 km core.
- web: earth/<id>.bin (500 x 500 Float32 LE, row 0 = north) + earth/<id>_hill.png.
"""
from __future__ import annotations

import json
import logging

import numpy as np
from affine import Affine
from rasterio.enums import Resampling

from pipeline.common.config import CORE_SIZE_PX, GRID_RES_M
from pipeline.earth.common import INTERIM, WEB_EARTH
from pipeline.earth.dem import Geom, convergence, read_dem, site_geom
from pipeline.earth.landcover import class_shares, read_classes_to_grid, worldcover_note

log = logging.getLogger("pipeline.earth.windows")

RES = GRID_RES_M                  # 30 m
CORE_N = CORE_SIZE_PX             # 500 px = 15 km
BUF_N = 500                       # 15 km near buffer each side
NEAR_N = CORE_N + 2 * BUF_N       # 1500
CORE_SLICE = (slice(BUF_N, BUF_N + CORE_N), slice(BUF_N, BUF_N + CORE_N))
FAR_RADIUS_M = 150_000.0
FAR_RES_M = 90.0
FAR_N = int(2 * FAR_RADIUS_M / FAR_RES_M) + 2  # 3335 -> radius ~150 km

SITE_DIR = INTERIM / "sites"
SITE_DIR.mkdir(parents=True, exist_ok=True)


def hillshade(dem: np.ndarray, res: float, az_deg: float = 315.0, alt_deg: float = 35.0) -> np.ndarray:
    """Lambertian hillshade 0..255; azimuth clockwise from grid +y (same as the Moon tiles)."""
    filled = np.where(np.isfinite(dem), dem, np.nanmean(dem) if np.isfinite(dem).any() else 0.0)
    gy, gx = np.gradient(filled, res)
    dzdx, dzdy = gx, -gy
    az, alt = np.radians(az_deg), np.radians(alt_deg)
    sx, sy, sz = np.sin(az) * np.cos(alt), np.cos(az) * np.cos(alt), np.sin(alt)
    shade = (-dzdx * sx - dzdy * sy + sz) / np.sqrt(1 + dzdx ** 2 + dzdy ** 2)
    return (np.clip(shade, 0, 1) * 255).astype(np.uint8)


def write_png(path, img: np.ndarray) -> None:
    import cv2
    if not cv2.imwrite(str(path), img):
        raise RuntimeError(f"failed to write {path}")


def dsm_safe_shares(sh: dict) -> bool:
    """DSM-safe rule on 10 m WorldCover shares (same thresholds as the stage-1 screen)."""
    return (sh.get("tree", 0) <= 0.10 and sh.get("built", 0) <= 0.05 and sh.get("crop", 0) <= 0.20
            and sh.get("water", 0) <= 0.20 and sh.get("wetland", 0) + sh.get("mangrove", 0) <= 0.10
            and sh.get("snow", 0) < 0.30)


def near_geom(lat: float, lon: float) -> Geom:
    return site_geom(lat, lon, RES, NEAR_N)


def core_geom(g_near: Geom) -> Geom:
    return g_near.with_res(RES, CORE_N)


def far_geom(g_near: Geom) -> Geom:
    return g_near.with_res(FAR_RES_M, FAR_N)


def near_path(site_id: str):
    return SITE_DIR / f"{site_id}_near30.npz"


def info_path(site_id: str):
    return SITE_DIR / f"{site_id}_window.json"


def load_near(site_id: str) -> tuple[np.ndarray, Geom]:
    z = np.load(near_path(site_id))
    g = Geom(int(z["epsg"]), float(z["cx"]), float(z["cy"]), float(z["res"]), int(z["n"]))
    return z["dem"], g


def read_far(g_near: Geom) -> np.ndarray:
    """Far field from cached GLO-90 tiles, average-resampled to FAR_RES_M; NaN (ocean/missing) -> 0 m."""
    far = read_dem(far_geom(g_near), source=90, resampling=Resampling.average)
    far[np.isnan(far)] = 0.0
    return far


def process_site(site_id: str, lat: float, lon: float, force: bool = False) -> dict:
    """Fetch + cache the near field, WorldCover shares and web tile for one site. Returns window info."""
    ip = info_path(site_id)
    if ip.exists() and near_path(site_id).exists() and not force:
        return json.loads(ip.read_text())
    g = near_geom(lat, lon)
    near = read_dem(g, source=30)
    np.savez_compressed(near_path(site_id), dem=near, epsg=g.epsg, cx=g.cx, cy=g.cy, res=g.res, n=g.n,
                        transform=np.array(g.transform)[:6])
    core = near[CORE_SLICE]
    gc = core_geom(g)
    classes = read_classes_to_grid(gc.crs, Affine(10.0, 0, gc.origin[0], 0, -10.0, gc.origin[1]),
                                   (CORE_N * 3, CORE_N * 3))
    sh = class_shares(classes)
    bin_path = WEB_EARTH / f"{site_id}.bin"
    core.astype("<f4").tofile(bin_path)
    write_png(WEB_EARTH / f"{site_id}_hill.png", hillshade(core, RES))
    info = {
        "id": site_id, "lat": lat, "lon": lon, "epsg": g.epsg, "cx": g.cx, "cy": g.cy,
        "origin_x": gc.origin[0], "origin_y": gc.origin[1],
        "grid_convergence_deg": round(convergence(g), 3),
        "core_nan_frac": float(np.isnan(core).mean()),
        "near_nan_frac": float(np.isnan(near).mean()),
        "core_relief_m": float(np.nanpercentile(core, 99) - np.nanpercentile(core, 1)) if np.isfinite(core).any() else None,
        "worldcover": sh,
        "bare_frac": sh["bare"],
        "moss_frac": sh["moss"],
        "worldcover_note": worldcover_note(sh),
    }
    ip.write_text(json.dumps(info, indent=1))
    log.info("window %s (%.3f, %.3f) EPSG:%d bare %.2f nan %.3f", site_id, lat, lon, g.epsg, sh["bare"],
             info["core_nan_frac"])
    return info
