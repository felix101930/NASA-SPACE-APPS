"""City of Calgary open data + NRCan HRDEM DTM fetchers for the "Moon walks in Calgary" module.

All downloads are cached under data/raw/alberta/calgary/. City datasets are paged through the Socrata
API ($limit/$offset); the Equity Index comes from the City's ArcGIS FeatureServer (layer 2, long format
tract x indicator). The DTM is read from the two 2020 NRCan lidar COGs (EPSG:3979, 1 m) at their 4 m
overview with windowed range reads only (the full-resolution files are ~11 GB each), mosaicked into one
EPSG:3979 grid at DTM_RES over the pathway extent.
"""
from __future__ import annotations

import json
import logging

import numpy as np
import rasterio
from affine import Affine
from rasterio.enums import Resampling
from rasterio.windows import from_bounds

from pipeline.alberta.common import RAW, http_get

log = logging.getLogger("pipeline.alberta.calgary_data")

CAL = RAW / "calgary"
CAL.mkdir(parents=True, exist_ok=True)
SOCRATA = "https://data.calgary.ca/resource/{id}.{fmt}"
EQUITY_URL = ("https://services1.arcgis.com/AVP60cs0Q9PEA8rH/arcgis/rest/services/"
              "Calgary_Equity_Index_Matrix_and_Indicator_Data/FeatureServer/2/query")
EQUITY_INDICATORS = {
    "access_domain": "*Domain Score - Accessibility and Amenities",
    "transit_score": "Transit Score",
    "walk_score": "Walk Score",
    "park_proximity": "Proximity to Neighbourhood Parks",
}
HRDEM_ITEMS = ("NRCAN-Calgary_West_utm11_2020-1m", "NRCAN-Calgary_East_utm12_2020-1m")
HRDEM_URL = "/vsicurl/https://canelevation-dem.s3.ca-central-1.amazonaws.com/hrdem-lidar/{item}-dtm.tif"
DTM_CRS = "EPSG:3979"
DTM_RES = 4.0
DTM_OVERVIEW = 1   # overview index 1 = factor 4 -> 4 m
DTM_NPZ = CAL / "calgary_dtm_4m_3979.npz"


def socrata_all(dataset: str, fmt: str = "geojson", where: str | None = None, page: int = 5000) -> list:
    """All rows/features of a Socrata dataset (cached)."""
    cache = CAL / f"{dataset}.{fmt}.json"
    if cache.exists():
        return json.loads(cache.read_text())
    rows, offset = [], 0
    while True:
        params = {"$limit": page, "$offset": offset, "$order": ":id"}
        if where:
            params["$where"] = where
        d = http_get(SOCRATA.format(id=dataset, fmt=fmt), params=params, timeout=180).json()
        batch = d["features"] if fmt == "geojson" else d
        rows += batch
        log.info("  %s: %d rows", dataset, len(rows))
        if len(batch) < page:
            break
        offset += page
    cache.write_text(json.dumps(rows))
    return rows


def pathways() -> list[dict]:
    return socrata_all("qndb-27qm")


def park_sites() -> list[dict]:
    return socrata_all("kami-qbfh")


def stops() -> list[dict]:
    return socrata_all("muzh-c9qc", fmt="json")


def stops_by_route() -> list[dict]:
    return socrata_all("pm3p-838w", fmt="json")


# Extra Equity Index indicators used only by equity_analysis.py (robustness checks on the overall index).
EQUITY_EXTRA = {
    "total_equity": "Total Equity Score",
    "social_wellbeing": "*Domain Score - Human and Social Wellbeing",
    "belonging_safety": "*Domain Score - Community Belonging and Safety",
}


def equity_indicator(key: str, label: str) -> list[dict]:
    """GeoJSON features (one per tract) for one Equity Index indicator label (cached)."""
    cache = CAL / f"equity_{key}.geojson"
    if not cache.exists():
        d = http_get(EQUITY_URL, params={
            "where": f"INDICATOR_LABEL='{label}'",
            "outFields": "NAME,CENSUSTRACT,COMMUNITIES,INDICATOR_VALUE,EQUITY_CATEGORY,TOTAL_POPULATION",
            "outSR": "4326", "f": "geojson", "resultRecordCount": 2000}, timeout=180).json()
        cache.write_text(json.dumps(d))
    feats = json.loads(cache.read_text())["features"]
    log.info("equity %s: %d tracts", key, len(feats))
    return feats


def equity() -> dict[str, list[dict]]:
    """{indicator_key: [geojson features (one per tract)]} (cached)."""
    return {key: equity_indicator(key, label) for key, label in EQUITY_INDICATORS.items()}


def dtm(bounds_3979: tuple[float, float, float, float], force: bool = False) -> tuple[np.ndarray, Affine]:
    """Bare-earth DTM (float32, NaN = no data) on an EPSG:3979 grid at DTM_RES covering bounds (cached)."""
    if DTM_NPZ.exists() and not force:
        z = np.load(DTM_NPZ)
        return z["dtm"], Affine(*z["transform"])
    minx, miny, maxx, maxy = bounds_3979
    minx, miny = np.floor(minx / DTM_RES) * DTM_RES, np.floor(miny / DTM_RES) * DTM_RES
    maxx, maxy = np.ceil(maxx / DTM_RES) * DTM_RES, np.ceil(maxy / DTM_RES) * DTM_RES
    w, h = int((maxx - minx) / DTM_RES), int((maxy - miny) / DTM_RES)
    tr = Affine(DTM_RES, 0, minx, 0, -DTM_RES, maxy)
    out = np.full((h, w), np.nan, np.float32)
    for item in HRDEM_ITEMS:
        with rasterio.open(HRDEM_URL.format(item=item), overview_level=DTM_OVERVIEW) as src:
            if src.crs.to_string() != DTM_CRS:
                raise RuntimeError(f"{item}: unexpected CRS {src.crs}")
            ob = src.bounds
            ix0, iy0 = max(minx, ob.left), max(miny, ob.bottom)
            ix1, iy1 = min(maxx, ob.right), min(maxy, ob.top)
            if ix0 >= ix1 or iy0 >= iy1:
                continue
            win = from_bounds(ix0, iy0, ix1, iy1, transform=src.transform)
            c0, r0 = int(round((ix0 - minx) / DTM_RES)), int(round((maxy - iy1) / DTM_RES))
            ww, hh = int(round((ix1 - ix0) / DTM_RES)), int(round((iy1 - iy0) / DTM_RES))
            log.info("HRDEM %s: reading %dx%d px at %.0f m (overview)", item, ww, hh, DTM_RES)
            a = src.read(1, window=win, out_shape=(hh, ww), resampling=Resampling.nearest,
                         boundless=False).astype(np.float32)
            nod = src.nodata
        a[(a == nod) | (a < -1000)] = np.nan
        sub = out[r0:r0 + hh, c0:c0 + ww]
        m = np.isnan(sub) & np.isfinite(a[:sub.shape[0], :sub.shape[1]])
        sub[m] = a[:sub.shape[0], :sub.shape[1]][m]
    np.savez_compressed(DTM_NPZ, dtm=out, transform=np.array(tr)[:6])
    log.info("DTM mosaic %s, %.1f %% valid", out.shape, 100 * np.isfinite(out).mean())
    return out, tr
