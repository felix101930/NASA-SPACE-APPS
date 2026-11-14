"""DEM windows per region: 20 m near field, 240 m far field, 30 m core tile, hillshade, DEM error.

Cached outputs (data/interim/moon/):
  <id>_near20.npz  dem (float32, NaN nodata), x0, y0 (top-left corner, m), res, transform (GDAL order
                   a,b,c,d,e,f), crs, core_slice (r0, r1, c0, c1 in near-field pixels)
  <id>_far240.npz  same keys, 300 km square centred on the region (LDEM_60S_240MPP)
  <id>_err.json    LOLA height-error stats over the core
Web outputs (web/public/data/moon/): <id>.bin (500x500 Float32 LE, row 0 = +y), <id>_hill.png
"""
from __future__ import annotations

import json
import logging
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np

from pipeline.common.config import CORE_SIZE_PX, GRID_RES_M, MOON_CRS
from pipeline.moon.common import (
    DEM_URL, ERR_URL, FAR_URL, INTERIM_MOON, WEB_MOON, Grid, write_json,
)
from pipeline.moon.regions import RegionCoord, build_regions

log = logging.getLogger(__name__)

CORE_M = CORE_SIZE_PX * GRID_RES_M      # 15 000 m
BUFFER_M = 15_000.0
FAR_RADIUS_M = 150_000.0
NEAR_RES = 20.0
FAR_RES = 240.0


def near_path(rid: str):
    return INTERIM_MOON / f"{rid}_near20.npz"


def far_path(rid: str):
    return INTERIM_MOON / f"{rid}_far240.npz"


def core_grid(r: RegionCoord) -> Grid:
    return Grid(r.x_m - CORE_M / 2, r.y_m + CORE_M / 2, GRID_RES_M, CORE_SIZE_PX, CORE_SIZE_PX)


def read_window(url: str, x0: float, y0: float, x1: float, y1: float, res: float,
                attempts: int = 4) -> tuple[np.ndarray, Grid]:
    """Read with retries (PGDA occasionally drops range requests)."""
    for i in range(attempts):
        try:
            return _read_window(url, x0, y0, x1, y1, res)
        except Exception as exc:  # rasterio.errors.RasterioIOError and HTTP hiccups
            if i == attempts - 1:
                raise
            log.warning("read failed (%s), retry %d/%d", str(exc)[:80], i + 1, attempts - 1)
            time.sleep(3 * (i + 1))
    raise AssertionError("unreachable")


def _read_window(url: str, x0: float, y0: float, x1: float, y1: float, res: float) -> tuple[np.ndarray, Grid]:
    """Read [x0,x1]x[y1,y0] (top-left x0,y0) at native/overview resolution ``res``; outside -> NaN."""
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.windows import from_bounds

    with rasterio.open(url) as ds:
        nx = int(round((x1 - x0) / res))
        ny = int(round((y0 - y1) / res))
        win = from_bounds(x0, y1, x1, y0, transform=ds.transform)
        arr = ds.read(1, window=win, out_shape=(ny, nx), boundless=True, fill_value=np.nan,
                      resampling=Resampling.average if res > ds.res[0] else Resampling.nearest,
                      masked=False).astype(np.float32)
        if ds.nodata is not None and not np.isnan(ds.nodata):
            arr[arr == ds.nodata] = np.nan
    return arr, Grid(x0, y0, res, nx, ny)


def save_npz(path, arr: np.ndarray, g: Grid, **extra) -> None:
    np.savez_compressed(path, dem=arr, x0=g.x0, y0=g.y0, res=g.res, transform=np.array(g.affine()),
                        crs=MOON_CRS, **extra)


def load_npz(path) -> tuple[np.ndarray, Grid, dict]:
    z = np.load(path)
    dem = z["dem"]
    g = Grid(float(z["x0"]), float(z["y0"]), float(z["res"]), dem.shape[1], dem.shape[0])
    extra = {k: z[k] for k in z.files if k not in ("dem", "x0", "y0", "res", "transform", "crs")}
    return dem, g, extra


def area_average(arr: np.ndarray, src_res: float, dst_res: float) -> np.ndarray:
    """Exact area-weighted downsampling when dst/src = p/q is rational with small q (20->30, 20->90).

    Upsample by q with pixel replication, then block-mean by p. NaN propagates only if all inputs are NaN.
    """
    from fractions import Fraction

    fr = Fraction(dst_res / src_res).limit_denominator(8)
    p, q = fr.numerator, fr.denominator
    up = np.repeat(np.repeat(arr, q, axis=0), q, axis=1) if q > 1 else arr
    ny, nx = up.shape[0] // p, up.shape[1] // p
    blk = up[: ny * p, : nx * p].reshape(ny, p, nx, p)
    with np.errstate(invalid="ignore"):
        out = np.nanmean(blk, axis=(1, 3))
    return out.astype(np.float32)


def hillshade(dem: np.ndarray, res: float, az_deg: float = 315.0, alt_deg: float = 35.0) -> np.ndarray:
    """Lambertian hillshade 0..255; azimuth clockwise from grid +y (row 0 = top)."""
    filled = np.where(np.isfinite(dem), dem, np.nanmean(dem))
    gy, gx = np.gradient(filled, res)          # gy: d/d(row) = -d/dy
    dzdx, dzdy = gx, -gy
    az, alt = np.radians(az_deg), np.radians(alt_deg)
    sx, sy, sz = np.sin(az) * np.cos(alt), np.cos(az) * np.cos(alt), np.sin(alt)
    shade = (-dzdx * sx - dzdy * sy + sz) / np.sqrt(1 + dzdx ** 2 + dzdy ** 2)
    return (np.clip(shade, 0, 1) * 255).astype(np.uint8)


def write_png(path, img: np.ndarray) -> None:
    import cv2

    if not cv2.imwrite(str(path), img):
        raise RuntimeError(f"failed to write {path}")


def fetch_region(r: RegionCoord, force: bool = False) -> dict[str, float]:
    """Read + cache near/far/err for one region and write the web tile + hillshade."""
    t0 = time.time()
    timings: dict[str, float] = {}
    cg = core_grid(r)
    # near field: core + 15 km buffer on all sides, 20 m
    if force or not near_path(r.id).exists():
        x0, y0 = cg.x0 - BUFFER_M, cg.y0 + BUFFER_M
        arr, g = read_window(DEM_URL, x0, y0, x0 + CORE_M + 2 * BUFFER_M, y0 - CORE_M - 2 * BUFFER_M, NEAR_RES)
        b = int(BUFFER_M / NEAR_RES)
        c = int(CORE_M / NEAR_RES)
        save_npz(near_path(r.id), arr, g, core_slice=np.array([b, b + c, b, b + c]), region_id=r.id)
        timings["near_s"] = time.time() - t0
    # far field: 150 km radius square, 240 m, centred on the region (grid-aligned to 240 m)
    if force or not far_path(r.id).exists():
        t1 = time.time()
        fx0 = np.floor((r.x_m - FAR_RADIUS_M) / FAR_RES) * FAR_RES
        fy0 = np.ceil((r.y_m + FAR_RADIUS_M) / FAR_RES) * FAR_RES
        n = int(2 * FAR_RADIUS_M / FAR_RES)
        arr, g = read_window(FAR_URL, fx0, fy0, fx0 + n * FAR_RES, fy0 - n * FAR_RES, FAR_RES)
        save_npz(far_path(r.id), arr, g, region_id=r.id)
        timings["far_s"] = time.time() - t1
    err_json = INTERIM_MOON / f"{r.id}_err.json"
    if force or not err_json.exists():
        t1 = time.time()
        err, _ = read_window(ERR_URL, cg.x0, cg.y0, cg.x0 + CORE_M, cg.y0 - CORE_M, NEAR_RES)
        v = err[np.isfinite(err)]
        write_json(err_json, {
            "dem_err_p50_m": float(np.percentile(v, 50)), "dem_err_p90_m": float(np.percentile(v, 90)),
            "dem_err_mean_m": float(v.mean()), "dem_err_max_m": float(v.max()),
            "valid_frac": float(v.size / err.size),
            "source": ERR_URL.replace("/vsicurl/", ""),
        })
        timings["err_s"] = time.time() - t1
    bin_path, hill_path = WEB_MOON / f"{r.id}.bin", WEB_MOON / f"{r.id}_hill.png"
    if force or not bin_path.exists() or not hill_path.exists():
        tile = core_tile(r.id)
        tile.astype("<f4").tofile(bin_path)
        write_png(hill_path, hillshade(tile, GRID_RES_M))
    timings["total_s"] = time.time() - t0
    log.info("%s windows done %s", r.id, {k: round(v, 1) for k, v in timings.items()})
    return timings


def core_tile(rid: str) -> np.ndarray:
    """30 m, 500x500 area-averaged core tile from the cached 20 m near field."""
    dem, _, extra = load_npz(near_path(rid))
    r0, r1, c0, c1 = (int(v) for v in extra["core_slice"])
    tile = area_average(dem[r0:r1, c0:c1], NEAR_RES, GRID_RES_M)
    assert tile.shape == (CORE_SIZE_PX, CORE_SIZE_PX), tile.shape
    return tile


def buffered_30m(rid: str) -> tuple[np.ndarray, Grid, tuple[slice, slice]]:
    """Core + buffer resampled to 30 m (1500x1500) with the core slice into it."""
    dem, g, _ = load_npz(near_path(rid))
    d30 = area_average(dem, NEAR_RES, GRID_RES_M)
    b = int(BUFFER_M / GRID_RES_M)
    sl = (slice(b, b + CORE_SIZE_PX), slice(b, b + CORE_SIZE_PX))
    return d30, Grid(g.x0, g.y0, GRID_RES_M, d30.shape[1], d30.shape[0]), sl


def err_stats(rid: str) -> dict:
    return json.loads((INTERIM_MOON / f"{rid}_err.json").read_text())


def run(force: bool = False, workers: int = 2) -> dict[str, dict[str, float]]:
    regions = build_regions()
    with ThreadPoolExecutor(max_workers=workers) as ex:
        res = dict(zip([r.id for r in regions], ex.map(lambda r: fetch_region(r, force), regions)))
    return res
