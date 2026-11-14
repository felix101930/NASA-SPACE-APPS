"""ESA WorldCover helpers.

Two products:
1. A coarse global class-count map built from COG overviews (level 4 = 1/32 of full res,
   ~300 m), aggregated 9x9 to 0.024 deg cells (~2.7 km). Used for stage-1 prefiltering only.
2. Full-resolution (10 m) class shares over a projected window (stage 2 / site windows).
"""
from __future__ import annotations

import json
import logging
import math
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.merge import merge
from rasterio.warp import reproject, transform_bounds

from pipeline.earth.common import INTERIM, RAW, WORLDCOVER_URL, worldcover_tag

log = logging.getLogger("pipeline.earth.landcover")

CLASSES = {
    10: "tree", 20: "shrub", 30: "grass", 40: "crop", 50: "built", 60: "bare",
    70: "snow", 80: "water", 90: "wetland", 95: "mangrove", 100: "moss",
}

# ----------------------------------------------------------------------------- coarse map
CELL_DEG = 0.024          # 3 deg / 125
OV_LEVEL = 4              # overview index -> 1125 x 1125 px per 3 deg tile
AGG = 9                   # 1125 / 9 = 125 cells per tile side
LAT_TOP, LAT_BOT = 84.0, -60.0
N_ROWS = int(round((LAT_TOP - LAT_BOT) / CELL_DEG))   # 6000
N_COLS = int(round(360.0 / CELL_DEG))                 # 15000
# counts out of AGG*AGG per 2.7 km cell; nodata (0) is the remainder
CHANNELS = ("tree", "shrub", "grass", "crop", "built", "bare", "snow", "water", "wet", "moss")
CH_CODES = ((10,), (20,), (30,), (40,), (50,), (60,), (70,), (80,), (90, 95), (100,))
COARSE_PATH = INTERIM / "worldcover_coarse_v2.npz"


def _grid_tiles() -> list[str]:
    g = json.loads((RAW / "worldcover_grid.geojson").read_text())
    return [f["properties"]["ll_tile"] for f in g["features"]]


def _tile_counts(tag: str) -> tuple[str, np.ndarray | None]:
    url = "/vsicurl/" + WORLDCOVER_URL.format(tile=tag)
    for attempt in range(3):
        try:
            with rasterio.open(url, overview_level=OV_LEVEL) as src:
                a = src.read(1)
            break
        except Exception as exc:  # noqa: BLE001
            log.warning("worldcover overview %s attempt %d: %s", tag, attempt + 1, exc)
            time.sleep(1 + attempt)
    else:
        return tag, None
    if a.shape != (1125, 1125):
        log.warning("unexpected overview shape %s for %s", a.shape, tag)
        return tag, None
    blk = a.reshape(125, AGG, 125, AGG)
    out = np.empty((len(CHANNELS), 125, 125), np.uint8)
    for i, codes in enumerate(CH_CODES):
        out[i] = np.isin(blk, codes).sum(axis=(1, 3))
    return tag, out


def build_coarse_map(workers: int = 32) -> np.ndarray:
    """Global [len(CHANNELS), N_ROWS, N_COLS] uint8 count map (cached)."""
    if COARSE_PATH.exists():
        return np.load(COARSE_PATH)["counts"]
    tags = _grid_tiles()
    log.info("building WorldCover coarse map from %d tile overviews", len(tags))
    counts = np.zeros((len(CHANNELS), N_ROWS, N_COLS), np.uint8)
    t0 = time.time()
    failed = []
    with ThreadPoolExecutor(workers) as ex:
        futs = [ex.submit(_tile_counts, t) for t in tags]
        for i, f in enumerate(as_completed(futs)):
            tag, arr = f.result()
            if arr is None:
                failed.append(tag)
                continue
            lat0 = int(tag[1:3]) * (1 if tag[0] == "N" else -1)
            lon0 = int(tag[4:7]) * (1 if tag[3] == "E" else -1)
            r0 = int(round((LAT_TOP - (lat0 + 3)) / CELL_DEG))
            c0 = int(round((lon0 + 180.0) / CELL_DEG))
            if r0 < 0 or r0 + 125 > N_ROWS:
                continue
            counts[:, r0:r0 + 125, c0:c0 + 125] = arr
            if (i + 1) % 500 == 0:
                log.info("  %d/%d tiles (%.0f s)", i + 1, len(tags), time.time() - t0)
    if failed:
        log.warning("WorldCover overview failures: %d (%s...)", len(failed), failed[:5])
    np.savez_compressed(COARSE_PATH, counts=counts, failed=np.array(failed))
    log.info("coarse map done in %.0f s", time.time() - t0)
    return counts


def coarse_shares(counts: np.ndarray, lat: float, lon: float, half_km: float = 7.5) -> dict[str, float]:
    """Class shares (over valid px, incl. water) of a ~15 km window from the coarse map, plus
    land = valid non-water px / all px."""
    hr = max(1, int(round(half_km / (CELL_DEG * 111.32))))
    hc = max(1, int(round(half_km / (CELL_DEG * 111.32 * max(math.cos(math.radians(lat)), 0.05)))))
    r = int((LAT_TOP - lat) / CELL_DEG)
    c = int((lon + 180.0) / CELL_DEG)
    r0, r1 = max(r - hr, 0), min(r + hr + 1, N_ROWS)
    cols = np.arange(c - hc, c + hc + 1) % N_COLS
    blk = counts[:, r0:r1][:, :, cols].astype(np.int64).sum(axis=(1, 2))
    total = (r1 - r0) * len(cols) * AGG * AGG
    valid = int(blk.sum())
    if valid <= 0:
        return {**{ch: 0.0 for ch in CHANNELS}, "land": 0.0}
    out = {ch: float(blk[i]) / valid for i, ch in enumerate(CHANNELS)}
    out["land"] = float(valid - blk[CHANNELS.index("water")]) / total
    return out


# ----------------------------------------------------------------------------- full-res shares
def read_classes_to_grid(dst_crs: CRS, dst_transform, shape: tuple[int, int]) -> np.ndarray:
    """WorldCover classes (uint8, 0 = no data) reprojected (nearest) onto a projected grid."""
    h, w = shape
    left, top = dst_transform.c, dst_transform.f
    right, bottom = left + w * dst_transform.a, top + h * dst_transform.e
    west, south, east, north = transform_bounds(dst_crs, "EPSG:4326", left, bottom, right, top, densify_pts=21)
    pad = 0.001
    west, south, east, north = west - pad, south - pad, east + pad, north + pad
    tags = sorted({worldcover_tag(la, lo)
                   for la in np.linspace(south, north, 8) for lo in np.linspace(west, east, 8)})
    srcs = []
    for t in tags:
        try:
            srcs.append(rasterio.open("/vsicurl/" + WORLDCOVER_URL.format(tile=t)))
        except Exception as exc:  # noqa: BLE001 - tile absent (ocean)
            log.debug("worldcover tile %s missing: %s", t, exc)
    out = np.zeros(shape, np.uint8)
    if not srcs:
        return out
    try:
        mos, mtr = merge(srcs, bounds=(west, south, east, north), nodata=0)
        reproject(mos[0], out, src_transform=mtr, src_crs="EPSG:4326", src_nodata=0,
                  dst_transform=dst_transform, dst_crs=dst_crs, dst_nodata=0,
                  resampling=Resampling.nearest)
    finally:
        for s in srcs:
            s.close()
    return out


def class_shares(classes: np.ndarray) -> dict[str, float]:
    """Shares of each WorldCover class over valid (non-zero) pixels. Sums to 1 when any valid px."""
    valid = classes[classes > 0]
    n = valid.size
    shares = {name: (float((valid == code).sum()) / n if n else 0.0) for code, name in CLASSES.items()}
    shares["valid_frac"] = n / classes.size if classes.size else 0.0
    return shares


def worldcover_note(sh: dict[str, float]) -> str:
    top = sorted(((v, k) for k, v in sh.items() if k in CLASSES.values()), reverse=True)[:3]
    return ", ".join(f"{k} {v:.0%}" for v, k in top if v >= 0.01) + " (ESA WorldCover 2021, 15 km core)"
