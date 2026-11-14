"""Job 1: Moon danger profiles. Tiles each region with 3.84 km windows (1.92 km step), measures every window.

Output: results/moon_windows.csv (one row per window, plus 1.92 km versions for the stability test)
        results/danger_profiles.csv (one row per region)
"""
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd
from shapely.geometry import Point, Polygon

sys.path.insert(0, str(Path(__file__).parent))
from moon import region_data, regions, xy_to_lonlat
from terrain import ALL_COLS, MARGIN, window_features

ROOT = Path(__file__).resolve().parents[1]
RES = ROOT / "results"


def one_region(name):
    d = region_data(name)
    z, gx, gy = d["z30"], d["gx"], d["gy"]
    reg = regions()[name]
    poly = Polygon(zip(reg["x"], reg["y"]))
    half, pad = 64, 64 + MARGIN
    rows = []
    for r in range(pad, z.shape[0] - pad + 1, 64):
        for c in range(pad, z.shape[1] - pad + 1, 64):
            if not poly.contains(Point(gx[c], gy[r])):
                continue
            zp = z[r - pad:r + pad, c - pad:c + pad]
            f = window_features(zp, half)
            if f is None:
                continue
            f2 = window_features(z[r - 32 - MARGIN:r + 32 + MARGIN, c - 32 - MARGIN:c + 32 + MARGIN], 32)
            lon, lat = xy_to_lonlat(gx[c], gy[r])
            w = (slice(r - half, r + half), slice(c - half, c + half))
            w2 = (slice(r - pad, r + pad), slice(c - pad, c + pad))
            f.update(region=name, x=float(gx[c]), y=float(gy[r]), lon=float(lon), lat=float(lat),
                     sun=float(d["sun120"][w].mean()), earth=float(d["earth120"][w].mean()),
                     psr=float(d["psr120"][w].mean()), psr2km=float(d["psr120"][w2].mean()))
            f.update({f"{k}__1.92": v for k, v in (f2 or {}).items()})
            rows.append(f)
    print(f"{name}: {len(rows)} windows", flush=True)
    return rows


if __name__ == "__main__":
    RES.mkdir(exist_ok=True)
    names = list(regions())
    with ProcessPoolExecutor(9) as ex:
        allrows = [r for rows in ex.map(one_region, names) for r in rows]
    df = pd.DataFrame(allrows)
    df.to_csv(RES / "moon_windows.csv", index=False)
    moon_only = ["sun", "earth", "psr", "psr2km"]
    prof = df.groupby("region")[ALL_COLS + moon_only].median()
    prof.insert(0, "windows", df.groupby("region").size())
    prof.to_csv(RES / "danger_profiles.csv", float_format="%.4g")
    pd.set_option("display.width", 250)
    print(prof.round(3).to_string())
