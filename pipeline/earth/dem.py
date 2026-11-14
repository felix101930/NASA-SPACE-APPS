"""Copernicus DEM reads onto local UTM grids.

GLO-30 is read by windowed HTTP range requests (/vsicurl/, 1024 px blocks).
GLO-90 tiles are single-block COGs, so whole tiles are downloaded once and cached on disk.
Missing tiles (ocean, or Copernicus gaps such as Armenia/Azerbaijan) become NaN.
"""
from __future__ import annotations

import logging
import math
from dataclasses import dataclass

import numpy as np
import rasterio
from affine import Affine
from pyproj import Transformer
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.merge import merge
from rasterio.warp import reproject, transform_bounds

from pipeline.earth.common import GLO30_URL, cop_tiles_for_bounds, glo90_local, grid_convergence_deg, utm_epsg

log = logging.getLogger("pipeline.earth.dem")


@dataclass(frozen=True)
class Geom:
    """A square north-up grid centred on (cx, cy) in a UTM CRS."""
    epsg: int
    cx: float
    cy: float
    res: float
    n: int

    @property
    def crs(self) -> CRS:
        return CRS.from_epsg(self.epsg)

    @property
    def transform(self) -> Affine:
        half = self.n * self.res / 2.0
        return Affine(self.res, 0.0, self.cx - half, 0.0, -self.res, self.cy + half)

    @property
    def origin(self) -> tuple[float, float]:
        t = self.transform
        return t.c, t.f

    def with_res(self, res: float, n: int) -> "Geom":
        return Geom(self.epsg, self.cx, self.cy, res, n)


def site_geom(lat: float, lon: float, res: float, n: int, epsg: int | None = None) -> Geom:
    epsg = epsg or utm_epsg(lat, lon)
    x, y = Transformer.from_crs("EPSG:4326", f"EPSG:{epsg}", always_xy=True).transform(lon, lat)
    return Geom(epsg, float(x), float(y), res, n)


def geom_to_lonlat(g: Geom, x: float, y: float) -> tuple[float, float]:
    lon, lat = Transformer.from_crs(f"EPSG:{g.epsg}", "EPSG:4326", always_xy=True).transform(x, y)
    return float(lon), float(lat)


def convergence(g: Geom) -> float:
    lon, lat = geom_to_lonlat(g, g.cx, g.cy)
    return grid_convergence_deg(lat, lon, g.epsg)


def geo_bounds(g: Geom, pad_deg: float = 0.01) -> tuple[float, float, float, float]:
    t = g.transform
    left, top = t.c, t.f
    right, bottom = left + g.n * g.res, top - g.n * g.res
    w, s, e, n = transform_bounds(g.crs, "EPSG:4326", left, bottom, right, top, densify_pts=41)
    return w - pad_deg, s - pad_deg, e + pad_deg, n + pad_deg


def read_dem(g: Geom, source: int = 30, resampling: Resampling = Resampling.bilinear) -> np.ndarray:
    """Float32 heights on grid g (NaN = no data). source 30 -> GLO-30 via HTTP, 90 -> cached GLO-90."""
    w, s, e, n = geo_bounds(g)
    if w < -180 or e > 180:
        log.warning("antimeridian window not supported; clipping")
        w, e = max(w, -180.0), min(e, 180.0)
    names = cop_tiles_for_bounds(w, s, e, n, 90 if source == 90 else 30)
    out = np.full((g.n, g.n), np.nan, np.float32)
    if not names:
        return out
    paths = [str(glo90_local(nm)) if source == 90 else "/vsicurl/" + GLO30_URL.format(name=nm) for nm in names]
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


def fill_nan(a: np.ndarray, value: float | None = None) -> np.ndarray:
    """Fill NaN with a value (default: nearest valid via distance transform; all-NaN -> 0)."""
    m = np.isnan(a)
    if not m.any():
        return a
    if m.all():
        return np.zeros_like(a)
    if value is not None:
        b = a.copy()
        b[m] = value
        return b
    from scipy.ndimage import distance_transform_edt
    idx = distance_transform_edt(m, return_distances=False, return_indices=True)
    return a[tuple(idx)]


def deg_per_km(lat: float) -> tuple[float, float]:
    return 1.0 / 111.32, 1.0 / (111.32 * max(math.cos(math.radians(lat)), 0.02))
