"""Ground check of a candidate spot (METHOD.md change 13): share of bare, snow/ice, water and vegetation in its
3.84 km window from ESA WorldCover 2021 v200 (10 m), windowed read only. Used for checking, never for scoring.
Results are cached in results/final_spots_ground.csv.
"""
import os
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "results" / "final_spots_ground.csv"
URL = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_{t}_Map.tif"


def ground(lat, lon):
    import rasterio
    from rasterio.windows import from_bounds
    os.environ["GDAL_DISABLE_READDIR_ON_OPEN"] = "EMPTY_DIR"
    cache = pd.read_csv(CACHE) if CACHE.exists() else pd.DataFrame(columns=["lat", "lon"])
    hit = cache[(np.abs(cache.lat - lat) < 1e-4) & (np.abs(cache.lon - lon) < 1e-4)]
    if len(hit):
        return hit.iloc[0].to_dict()
    tl, tn = int(np.floor(lat / 3) * 3), int(np.floor(lon / 3) * 3)
    t = f"{'N' if tl >= 0 else 'S'}{abs(tl):02d}{'E' if tn >= 0 else 'W'}{abs(tn):03d}"
    dlat, dlon = 1.92 / 111.2, 1.92 / (111.2 * np.cos(np.radians(lat)))
    with rasterio.open("/vsicurl/" + URL.format(t=t)) as src:
        a = src.read(1, window=from_bounds(lon - dlon, lat - dlat, lon + dlon, lat + dlat, src.transform))
    pct = lambda *c: round(float(np.isin(a, c).mean() * 100), 1)
    r = dict(lat=lat, lon=lon, bare_pct=pct(60, 100), ice_pct=pct(70), water_pct=pct(80),
             veg_pct=pct(10, 20, 30, 40, 90, 95))
    pd.concat([cache, pd.DataFrame([r])]).to_csv(CACHE, index=False)
    return r


def passes(lat, lon):
    g = ground(lat, lon)
    return g["ice_pct"] < 30 and g["water_pct"] <= 5 and g["veg_pct"] <= 20
