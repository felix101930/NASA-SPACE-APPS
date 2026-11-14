"""Shared helpers for the Moon stage: paths, projection, URLs, logging."""
from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from pyproj import CRS, Transformer

from pipeline.common.config import INTERIM, MOON_CRS, MOON_DEM_URL, MOON_ILLUM_URL, MOON_R_M, RAW, ROOT, WEB_DATA

os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("GDAL_HTTP_MAX_RETRY", "4")
os.environ.setdefault("GDAL_HTTP_RETRY_DELAY", "2")
os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".TIF,.tif")

log = logging.getLogger("pipeline.moon")

RAW_MOON = RAW / "moon"
INTERIM_MOON = INTERIM / "moon"
WEB_MOON = WEB_DATA / "moon"
REGIONS_CSV = ROOT / "data" / "regions_coords.csv"
for _p in (RAW_MOON, INTERIM_MOON, WEB_MOON):
    _p.mkdir(parents=True, exist_ok=True)

PGDA_20MPP = "https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/"
DEM_URL = MOON_DEM_URL                                   # 20 m LDEM, 80-90S
ERR_URL = "/vsicurl/" + PGDA_20MPP + "LDEM_80S_20MPP_ADJ_ERR.TIF"   # verified 3 954 709 201 B
SLOPE_URL = "/vsicurl/" + PGDA_20MPP + "LDSM_80S_20MPP_ADJ.TIF"     # verified 3 778 056 355 B
FAR_URL = "/vsicurl/" + PGDA_20MPP + "LDEM_60S_240MPP_ADJ.TIF"      # 240 m, 60-90S (covers 150 km around Cabeus B)
ILLUM_URL = MOON_ILLUM_URL
ILLUM_LOCAL = RAW_MOON / "AVGVISIB_85S_060M_201608.TIF"
NASA_MAP_URL = "https://www.nasa.gov/wp-content/uploads/2024/10/artemis-iii-landing-region-candidates.jpg"
NASA_RELEASE_URL = "https://www.nasa.gov/news-release/nasa-provides-update-on-artemis-iii-moon-landing-regions/"
PGDA78_URL = "https://pgda.gsfc.nasa.gov/products/78"
GAZETTEER_ZIP_URL = "https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/MOON_nomenclature_center_pts.zip"

CRS_SHORT = "+proj=stere +lat_0=-90 +lat_ts=-90 +lon_0=0 +R=1737400 +units=m"
PIPELINE_VERSION = "moon-0.1.0"

_MOON_GEO = CRS.from_proj4(f"+proj=longlat +R={MOON_R_M} +no_defs")
_MOON_PS = CRS.from_proj4(MOON_CRS)
_FWD = Transformer.from_crs(_MOON_GEO, _MOON_PS, always_xy=True)
_INV = Transformer.from_crs(_MOON_PS, _MOON_GEO, always_xy=True)


def lonlat_to_xy(lon: float, lat: float) -> tuple[float, float]:
    """Planetocentric lon/lat (deg, sphere R=1737.4 km) -> south polar stereographic metres."""
    x, y = _FWD.transform(lon, lat)
    return float(x), float(y)


def xy_to_lonlat(x: float, y: float) -> tuple[float, float]:
    """South polar stereographic metres -> lon in [-180, 180), lat (deg)."""
    lon, lat = _INV.transform(x, y)
    lon = ((float(lon) + 180.0) % 360.0) - 180.0
    return lon, float(lat)


@dataclass(frozen=True)
class Grid:
    """North-up grid: x0,y0 are the top-left corner (metres); row 0 is +y."""
    x0: float
    y0: float
    res: float
    nx: int
    ny: int

    def affine(self) -> tuple[float, float, float, float, float, float]:
        """GDAL-order affine (a, b, c, d, e, f) as used by rasterio.Affine(*...)."""
        return (self.res, 0.0, self.x0, 0.0, -self.res, self.y0)

    def centers(self) -> tuple[np.ndarray, np.ndarray]:
        xs = self.x0 + (np.arange(self.nx) + 0.5) * self.res
        ys = self.y0 - (np.arange(self.ny) + 0.5) * self.res
        return xs, ys


def write_json(path: Path, obj: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=1, allow_nan=False))
    tmp.replace(path)


def setup_logging(level: int = logging.INFO) -> None:
    logging.basicConfig(level=level, format="%(asctime)s %(levelname)s %(name)s: %(message)s", datefmt="%H:%M:%S")
