"""Copernicus DEM reads for Alberta windows (mirrors pipeline.earth.dem.read_dem).

Geometry helpers (Geom, site_geom, geo_bounds, fill_nan) are imported read-only from the earth
stage; tile resolution uses this module's cache (pipeline.alberta.common.glo90_path), which reuses the
earth GLO-90 cache when a tile is already there and otherwise downloads into data/raw/alberta/glo90.
"""
from __future__ import annotations

import logging

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.merge import merge
from rasterio.warp import reproject

from pipeline.alberta.common import GLO30_URL, glo90_path
from pipeline.earth.common import cop_tiles_for_bounds
from pipeline.earth.dem import Geom, fill_nan, geo_bounds, site_geom  # noqa: F401 (re-export)

log = logging.getLogger("pipeline.alberta.dem")


def read_dem(g: Geom, source: int = 30, resampling: Resampling = Resampling.bilinear) -> np.ndarray:
    """Float32 heights on grid g (NaN = no data). 30 -> GLO-30 via HTTP range reads, 90 -> cached GLO-90."""
    w, s, e, n = geo_bounds(g)
    names = cop_tiles_for_bounds(w, s, e, n, 90 if source == 90 else 30)
    out = np.full((g.n, g.n), np.nan, np.float32)
    if not names:
        return out
    paths = [str(glo90_path(nm)) if source == 90 else "/vsicurl/" + GLO30_URL.format(name=nm) for nm in names]
    srcs = [rasterio.open(p) for p in paths]
    try:
        resx = min(abs(sr.transform.a) for sr in srcs)
        resy = min(abs(sr.transform.e) for sr in srcs)
        mos, mtr = merge(srcs, bounds=(w, s, e, n), res=(resx, resy), nodata=np.nan,
                         dtype="float32", resampling=Resampling.bilinear)
    finally:
        for sr in srcs:
            sr.close()
    reproject(mos[0], out, src_transform=mtr, src_crs="EPSG:4326", src_nodata=np.nan,
              dst_transform=g.transform, dst_crs=g.crs, dst_nodata=np.nan, resampling=resampling)
    return out
