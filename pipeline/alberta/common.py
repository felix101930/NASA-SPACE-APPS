"""Shared helpers for the Alberta + Calgary module: paths, sources/licences, HTTP, JSON."""
from __future__ import annotations

import json
import logging
import math
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import requests

from pipeline.common import config

log = logging.getLogger("pipeline.alberta")

PIPELINE_VERSION = "alberta-0.1"

RAW = config.RAW / "alberta"
INTERIM = config.INTERIM / "alberta"
WEB_AB = config.WEB_DATA / "alberta"
WEB_YYC = config.WEB_DATA / "calgary"
SITE_DIR = INTERIM / "sites"
EARTH_GLO90_CACHE = config.RAW / "earth" / "glo90"   # read-only reuse of the earth stage's tile cache
for _p in (RAW, INTERIM, WEB_AB, WEB_YYC, SITE_DIR, RAW / "glo90"):
    _p.mkdir(parents=True, exist_ok=True)

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

# Generic client name only; no personal or project-identifying details are sent.
USER_AGENT = "open-data-pipeline/0.1 (python-requests)"

GLO30_URL = "https://copernicus-dem-30m.s3.amazonaws.com/{name}/{name}.tif"
GLO90_URL = "https://copernicus-dem-90m.s3.amazonaws.com/{name}/{name}.tif"

SRC = {
    "copdem": {
        "name": "Copernicus DEM GLO-30 / GLO-90", "url": "https://registry.opendata.aws/copernicus-dem/",
        "licence": "Copernicus DEM licence (free, attribution required)",
        "citation": "© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under "
                    "COPERNICUS by the European Union and ESA; all rights reserved."},
    "worldcover": {
        "name": "ESA WorldCover 10 m 2021 v200", "url": "https://esa-worldcover.org/", "licence": "CC-BY 4.0",
        "citation": "Zanaga, D. et al. (2022). ESA WorldCover 10 m 2021 v200. https://doi.org/10.5281/zenodo.7254221"},
    "natural_earth": {
        "name": "Natural Earth 1:10m Admin-1 states/provinces (Alberta boundary)",
        "url": "https://www.naturalearthdata.com/downloads/10m-cultural-vectors/",
        "licence": "Public domain", "citation": "Made with Natural Earth. Free vector and raster map data @ naturalearthdata.com."},
    "cpcad": {
        "name": "Canadian Protected and Conserved Areas Database (CPCAD), ECCC",
        "url": "https://open.canada.ca/data/en/dataset/6c343726-1e92-451a-876a-76e17d398a1c",
        "licence": "Open Government Licence - Canada",
        "citation": "Environment and Climate Change Canada. Canadian Protected and Conserved Areas Database (CPCAD), "
                    "via https://maps-cartes.ec.gc.ca/arcgis/rest/services/CWS_SCF/CPCAD/MapServer/0"},
    "geonames": {
        "name": "GeoNames gazetteer (Canada extract)", "url": "https://download.geonames.org/export/dump/CA.zip",
        "licence": "CC-BY 4.0", "citation": "GeoNames (geonames.org), CC-BY 4.0."},
    "moon_fp": {
        "name": "NASA LOLA 20 m DEM (PGDA) via moon stage fingerprints_90m.json",
        "url": "https://pgda.gsfc.nasa.gov/products/78", "licence": "NASA open data",
        "citation": "Barker, M.K. et al. (2021/2023). LOLA south-pole 20 m/px DEM products, NASA GSFC PGDA."},
    "hrdem": {
        "name": "NRCan HRDEM (CanElevation) lidar DTM 1 m: NRCAN-Calgary_West_utm11_2020-1m, "
                "NRCAN-Calgary_East_utm12_2020-1m",
        "url": "https://datacube.services.geo.ca/stac/api/collections/hrdem-lidar",
        "licence": "Open Government Licence - Canada (OGL-Canada-2.0)",
        "citation": "Natural Resources Canada. High Resolution Digital Elevation Model (HRDEM) - CanElevation Series."},
    "yyc_pathways": {
        "name": "City of Calgary - Parks Pathways (qndb-27qm)", "url": "https://data.calgary.ca/d/qndb-27qm",
        "licence": "Open Government Licence – City of Calgary v2.1 (https://data.calgary.ca/stories/s/Open-Calgary-Terms-of-Use/u45n-7awa)",
        "citation": "Contains information licensed under the Open Government Licence - City of Calgary."},
    "yyc_parks": {
        "name": "City of Calgary - Parks Sites (kami-qbfh)", "url": "https://data.calgary.ca/d/kami-qbfh",
        "licence": "Open Government Licence – City of Calgary v2.1 (https://data.calgary.ca/stories/s/Open-Calgary-Terms-of-Use/u45n-7awa)",
        "citation": "Contains information licensed under the Open Government Licence - City of Calgary."},
    "yyc_stops": {
        "name": "City of Calgary - Calgary Transit Stops (muzh-c9qc) and Stops by Route (pm3p-838w)",
        "url": "https://data.calgary.ca/d/muzh-c9qc", "licence": "Open Government Licence – City of Calgary v2.1 (https://data.calgary.ca/stories/s/Open-Calgary-Terms-of-Use/u45n-7awa)",
        "citation": "Contains information licensed under the Open Government Licence - City of Calgary."},
    "yyc_equity": {
        "name": "City of Calgary - Calgary Equity Index 2024 (matrix and indicator data, layer 2)",
        "url": "https://services1.arcgis.com/AVP60cs0Q9PEA8rH/arcgis/rest/services/"
               "Calgary_Equity_Index_Matrix_and_Indicator_Data/FeatureServer/2",
        "licence": "Open Government Licence – City of Calgary v2.1 (https://data.calgary.ca/stories/s/Open-Calgary-Terms-of-Use/u45n-7awa)",
        "citation": "Contains information licensed under the Open Government Licence - City of Calgary."},
}


def meta(keys: list[str], **extra) -> dict:
    return {"generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "pipeline_version": PIPELINE_VERSION, "sources": [SRC[k] for k in keys], **extra}


def setup_logging(level: int = logging.INFO) -> None:
    logging.basicConfig(level=level, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    for name in ("rasterio", "urllib3", "numba"):
        logging.getLogger(name).setLevel(logging.WARNING)


_local = threading.local()


def session() -> requests.Session:
    s = getattr(_local, "s", None)
    if s is None:
        s = requests.Session()
        s.headers["User-Agent"] = USER_AGENT
        _local.s = s
    return s


def http_get(url: str, params: dict | None = None, timeout: float = 120.0, retries: int = 4) -> requests.Response:
    last: Exception | None = None
    for attempt in range(retries):
        try:
            r = session().get(url, params=params, timeout=timeout)
            r.raise_for_status()
            return r
        except Exception as exc:  # noqa: BLE001 - network retry
            last = exc
            log.warning("GET failed (%d/%d) %s: %s", attempt + 1, retries, url, exc)
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"GET failed: {url}") from last


_dl_lock = threading.Lock()
_dl_locks: dict[str, threading.Lock] = {}


def download_cached(url: str, path: Path, timeout: float = 300.0) -> Path:
    """Download once (thread-safe, atomic rename)."""
    if path.exists() and path.stat().st_size > 0:
        return path
    with _dl_lock:
        lock = _dl_locks.setdefault(str(path), threading.Lock())
    with lock:
        if path.exists() and path.stat().st_size > 0:
            return path
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + f".part{threading.get_ident()}")
        for attempt in range(4):
            try:
                with session().get(url, timeout=timeout, stream=True) as r:
                    r.raise_for_status()
                    with open(tmp, "wb") as fh:
                        for chunk in r.iter_content(1 << 20):
                            fh.write(chunk)
                tmp.replace(path)
                return path
            except Exception as exc:  # noqa: BLE001
                log.warning("download failed (%d/4) %s: %s", attempt + 1, url, exc)
                time.sleep(2 * (attempt + 1))
        if tmp.exists():
            tmp.unlink()
        raise RuntimeError(f"download failed: {url}")


def glo90_path(name: str) -> Path:
    """Cached GLO-90 tile: reuse the earth stage's cache read-only, else download to data/raw/alberta."""
    p = EARTH_GLO90_CACHE / f"{name}.tif"
    if p.exists() and p.stat().st_size > 0:
        return p
    return download_cached(GLO90_URL.format(name=name), RAW / "glo90" / f"{name}.tif")


def clean(v):
    """JSON-safe: NaN/inf -> None, numpy -> python, floats rounded to 5 dp."""
    if isinstance(v, dict):
        return {str(k): clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [clean(x) for x in v]
    if isinstance(v, np.ndarray):
        return clean(v.tolist())
    if isinstance(v, (bool, np.bool_)):
        return bool(v)
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (float, np.floating)):
        f = float(v)
        return None if not math.isfinite(f) else round(f, 5)
    return v


def write_json(path: Path, doc, compact: bool = True) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(clean(doc), separators=(",", ":")) if compact else json.dumps(clean(doc), indent=1))
    tmp.replace(path)
    log.info("wrote %s (%.1f kB)", path, path.stat().st_size / 1e3)
