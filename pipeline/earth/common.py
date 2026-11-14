"""Shared helpers for the Earth stage: paths, GDAL env, UTM, tile naming, downloads."""
from __future__ import annotations

import logging
import math
import os
import threading
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path

import requests

from pipeline.common import config

log = logging.getLogger("pipeline.earth")

PIPELINE_VERSION = "earth-0.2"

RAW = config.RAW / "earth"
INTERIM = config.INTERIM / "earth"
WEB_EARTH = config.WEB_DATA / "earth"
WEB_WALK = config.WEB_DATA / "walk"
CANDIDATES_CSV = config.ROOT / "data" / "earth_candidates.csv"
CLEAN_CSV = config.ROOT / "data" / "earth_sites_clean.csv"

for _p in (RAW, INTERIM, WEB_EARTH, WEB_WALK, RAW / "glo90", RAW / "macrostrat"):
    _p.mkdir(parents=True, exist_ok=True)

GLO30_URL = "https://copernicus-dem-30m.s3.amazonaws.com/{name}/{name}.tif"
GLO90_URL = "https://copernicus-dem-90m.s3.amazonaws.com/{name}/{name}.tif"
WORLDCOVER_URL = config.WORLDCOVER_TILE
HLS_TEMPLATE = (
    "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/HLS_S30_Nadir_BRDF_Adjusted_Reflectance/"
    "default/{date}/GoogleMapsCompatible_Level12/{z}/{y}/{x}.png"
)

GDAL_ENV = {
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif",
    "GDAL_HTTP_MULTIRANGE": "YES",
    "GDAL_HTTP_MERGE_CONSECUTIVE_RANGES": "YES",
    "GDAL_HTTP_MAX_RETRY": "4",
    "GDAL_HTTP_RETRY_DELAY": "1",
    "VSI_CACHE": "TRUE",
    "VSI_CACHE_SIZE": str(256 * 1024 * 1024),
    "GDAL_CACHEMAX": "1024",
}
for _k, _v in GDAL_ENV.items():
    os.environ.setdefault(_k, _v)

SOURCES = [
    {
        "name": "Copernicus DEM GLO-30 / GLO-90",
        "url": "https://registry.opendata.aws/copernicus-dem/",
        "licence": "Copernicus DEM licence (free, attribution required)",
        "citation": (
            "© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under "
            "COPERNICUS by the European Union and ESA; all rights reserved."
        ),
    },
    {
        "name": "ESA WorldCover 10 m 2021 v200",
        "url": "https://esa-worldcover.org/",
        "licence": "CC-BY 4.0",
        "citation": (
            "Zanaga, D., Van De Kerchove, R., Daems, D., De Keersmaecker, W., Brockmann, C., Kirches, G., "
            "Wevers, J., Cartus, O., Santoro, M., Fritz, S., Lesiv, M., Herold, M., Tsendbazar, N.E., Xu, P., "
            "Ramoino, F., Arino, O. (2022). ESA WorldCover 10 m 2021 v200. "
            "https://doi.org/10.5281/zenodo.7254221"
        ),
    },
    {
        "name": "Macrostrat geologic map units",
        "url": "https://macrostrat.org/api/v2/geologic_units/map",
        "licence": "CC-BY 4.0",
        "citation": "Peters, S.E., Husson, J.M., Czaplewski, J. (2018). Macrostrat: a platform for geological "
                    "data integration and deep-time Earth crust research. G-cubed 19. https://doi.org/10.1029/2018GC007467",
    },
    {
        "name": "NASA GIBS HLS S30 (imagery basemap)",
        "url": "https://nasa-gibs.github.io/gibs-api-docs/",
        "licence": "NASA open data",
        "citation": "Imagery courtesy of NASA Global Imagery Browse Services (GIBS), HLS Sentinel-2 surface reflectance.",
    },
]


def meta() -> dict:
    return {
        "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "pipeline_version": PIPELINE_VERSION,
        "sources": SOURCES,
    }


def setup_logging(level: int = logging.INFO) -> None:
    logging.basicConfig(level=level, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("rasterio").setLevel(logging.WARNING)
    logging.getLogger("urllib3").setLevel(logging.WARNING)


# --------------------------------------------------------------------------- UTM
def utm_epsg(lat: float, lon: float) -> int:
    """Standard UTM zone EPSG (326xx north / 327xx south). No Norway/Svalbard exceptions."""
    lon = ((lon + 180.0) % 360.0) - 180.0
    zone = int(math.floor((lon + 180.0) / 6.0)) + 1
    zone = min(max(zone, 1), 60)
    return (32600 if lat >= 0 else 32700) + zone


def utm_central_meridian(epsg: int) -> float:
    return (epsg % 100) * 6.0 - 183.0


def grid_convergence_deg(lat: float, lon: float, epsg: int) -> float:
    """Approximate angle between UTM grid north and true north (positive: grid north east of true)."""
    dlon = lon - utm_central_meridian(epsg)
    return math.degrees(math.atan(math.tan(math.radians(dlon)) * math.sin(math.radians(lat))))


# --------------------------------------------------------------------------- tiles
def _lat_tag(lat_i: int) -> str:
    return f"{'N' if lat_i >= 0 else 'S'}{abs(lat_i):02d}"


def _lon_tag(lon_i: int) -> str:
    return f"{'E' if lon_i >= 0 else 'W'}{abs(lon_i):03d}"


def cop_name(lat_i: int, lon_i: int, res: int = 30) -> str:
    """Copernicus tile name from SW corner integer degrees. res=30 -> GLO-30 ('10'), 90 -> GLO-90 ('30')."""
    code = "10" if res == 30 else "30"
    return f"Copernicus_DSM_COG_{code}_{_lat_tag(lat_i)}_00_{_lon_tag(lon_i)}_00_DEM"


def worldcover_tag(lat: float, lon: float) -> str:
    lat_i = int(math.floor(lat / 3.0)) * 3
    lon_i = int(math.floor(lon / 3.0)) * 3
    return f"{'N' if lat_i >= 0 else 'S'}{abs(lat_i):02d}{'E' if lon_i >= 0 else 'W'}{abs(lon_i):03d}"


def _tile_list(res: int) -> frozenset[str]:
    url = f"https://copernicus-dem-{res}m.s3.amazonaws.com/tileList.txt"
    path = RAW / f"glo{res}_tileList.txt"
    if not path.exists():
        r = requests.get(url, timeout=60)
        r.raise_for_status()
        path.write_text(r.text)
    return frozenset(x.strip() for x in path.read_text().splitlines() if x.strip())


@lru_cache(maxsize=2)
def tile_set(res: int) -> frozenset[str]:
    return _tile_list(res)


def cop_tiles_for_bounds(west: float, south: float, east: float, north: float, res: int) -> list[str]:
    """Existing Copernicus tile names intersecting a geographic bbox (no antimeridian wrap)."""
    have = tile_set(res)
    out = []
    for la in range(int(math.floor(south)), int(math.floor(north - 1e-9)) + 1):
        for lo in range(int(math.floor(west)), int(math.floor(east - 1e-9)) + 1):
            lo_w = ((lo + 180) % 360) - 180
            n = cop_name(la, lo_w, res)
            if n in have:
                out.append(n)
    return out


def cop_tile_exists(lat: float, lon: float, res: int = 90) -> bool:
    return cop_name(int(math.floor(lat)), int(math.floor(lon)), res) in tile_set(res)


_dl_locks: dict[str, threading.Lock] = {}
_dl_guard = threading.Lock()
_session_local = threading.local()


def _session() -> requests.Session:
    s = getattr(_session_local, "s", None)
    if s is None:
        s = requests.Session()
        _session_local.s = s
    return s


def download_cached(url: str, path: Path, timeout: float = 120.0, retries: int = 3) -> Path:
    """Download url to path once (thread-safe, atomic rename)."""
    if path.exists() and path.stat().st_size > 0:
        return path
    with _dl_guard:
        lock = _dl_locks.setdefault(str(path), threading.Lock())
    with lock:
        if path.exists() and path.stat().st_size > 0:
            return path
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + f".part{threading.get_ident()}")
        last: Exception | None = None
        for attempt in range(retries):
            try:
                with _session().get(url, timeout=timeout, stream=True) as r:
                    r.raise_for_status()
                    with open(tmp, "wb") as fh:
                        for chunk in r.iter_content(1 << 20):
                            fh.write(chunk)
                tmp.replace(path)
                return path
            except Exception as exc:  # noqa: BLE001 - network retry
                last = exc
                log.warning("download failed (%s/%s) %s: %s", attempt + 1, retries, url, exc)
        if tmp.exists():
            tmp.unlink()
        raise RuntimeError(f"download failed: {url}") from last


def glo90_local(name: str) -> Path:
    """Local cached copy of a whole GLO-90 tile (they are single-block COGs, so whole-file is cheapest)."""
    return download_cached(GLO90_URL.format(name=name), RAW / "glo90" / f"{name}.tif")
