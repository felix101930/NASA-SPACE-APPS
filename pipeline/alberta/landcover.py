"""ESA WorldCover class shares for every Alberta window (DSM-safe filter, same rule as the earth stage).

WorldCover v200 3-degree COGs are read at overview level 3 (1/16 of 10 m -> ~160 m px, nearest-type
overview) through /vsicurl/, mosaicked and reprojected (nearest) onto the EPSG:3400 window grid at
150 m, so each 15 km window is exactly 100 x 100 class samples (~10^4 per window).
Shares are over valid (non-zero) pixels incl. water, like pipeline.earth.landcover.coarse_shares;
wc_land = valid non-water px / all px.
"""
from __future__ import annotations

import logging
import math
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import rasterio
from affine import Affine
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.warp import reproject

from pipeline.alberta.geodata import AB_CRS, WIN_M, Window, grid_origin
from pipeline.common.config import WORLDCOVER_TILE

log = logging.getLogger("pipeline.alberta.landcover")

OV_LEVEL = 3
GRID_RES = 150.0
CHANNELS = ("tree", "shrub", "grass", "crop", "built", "bare", "snow", "water", "wet", "moss")
CH_CODES = ((10,), (20,), (30,), (40,), (50,), (60,), (70,), (80,), (90, 95), (100,))
# DSM-safe rule (identical to pipeline.earth.screen.DSM_SAFE_MAX / DSM_SNOW_MAX)
DSM_SAFE_MAX = {"tree": 0.10, "built": 0.05, "crop": 0.20, "water": 0.20, "wet": 0.10}
DSM_SNOW_MAX = 0.30   # strict <
LAND_MIN = 0.5


def dsm_safe(sh: dict[str, float]) -> tuple[bool, list[str]]:
    """(passes, failing reasons) for the DSM-safe WorldCover rule."""
    why = [k for k, v in DSM_SAFE_MAX.items() if sh[k] > v]
    if sh["snow"] >= DSM_SNOW_MAX:
        why.append("snow")
    if sh.get("land", 1.0) < LAND_MIN:
        why.append("land")
    return (not why), why


def shares_from_classes(cls: np.ndarray) -> dict[str, float]:
    valid = cls[cls > 0]
    n = valid.size
    out = {ch: (float(np.isin(valid, codes).sum()) / n if n else 0.0) for ch, codes in zip(CHANNELS, CH_CODES)}
    out["land"] = float(n - np.isin(valid, (80,)).sum()) / cls.size if cls.size else 0.0
    out["valid"] = n / cls.size if cls.size else 0.0
    return out


def _tag(lat_i: int, lon_i: int) -> str:
    return f"{'N' if lat_i >= 0 else 'S'}{abs(lat_i):02d}{'E' if lon_i >= 0 else 'W'}{abs(lon_i):03d}"


def _read_tile(tag: str):
    url = "/vsicurl/" + WORLDCOVER_TILE.format(tile=tag)
    try:
        with rasterio.open(url, overview_level=OV_LEVEL) as src:
            a = src.read(1)
            tr = src.transform
        return tag, a, tr
    except Exception as exc:  # noqa: BLE001 - tile absent
        log.warning("WorldCover %s unavailable: %s", tag, exc)
        return tag, None, None


def class_grid(bounds_ab: tuple[float, float, float, float], bounds_ll: tuple[float, float, float, float]):
    """WorldCover classes on the EPSG:3400 window grid at GRID_RES. Returns (classes, x0, y1)."""
    x0, y1, nrow, ncol = grid_origin(bounds_ab)
    k = int(WIN_M / GRID_RES)
    out = np.zeros((nrow * k, ncol * k), np.uint8)
    dst_tr = Affine(GRID_RES, 0, x0, 0, -GRID_RES, y1)
    w, s, e, n = bounds_ll
    tags = [_tag(la, lo) for la in range(int(math.floor(s / 3) * 3), int(math.floor(n / 3) * 3) + 1, 3)
            for lo in range(int(math.floor(w / 3) * 3), int(math.floor(e / 3) * 3) + 1, 3)]
    log.info("WorldCover: reading %d tiles at overview level %d", len(tags), OV_LEVEL)
    with ThreadPoolExecutor(8) as ex:
        for tag, a, tr in ex.map(_read_tile, tags):
            if a is None:
                continue
            tmp = np.zeros_like(out)
            reproject(a, tmp, src_transform=tr, src_crs=CRS.from_epsg(4326), src_nodata=0,
                      dst_transform=dst_tr, dst_crs=CRS.from_string(AB_CRS), dst_nodata=0,
                      resampling=Resampling.nearest)
            m = tmp > 0
            out[m] = tmp[m]
    return out, x0, y1


def window_shares(wins: list[Window], cls: np.ndarray, x0: float, y1: float) -> dict[str, dict[str, float]]:
    k = int(WIN_M / GRID_RES)
    res = {}
    for w in wins:
        r0 = int(round((y1 - w.y1) / GRID_RES))
        c0 = int(round((w.x0 - x0) / GRID_RES))
        res[w.id] = shares_from_classes(cls[r0:r0 + k, c0:c0 + k])
    return res
