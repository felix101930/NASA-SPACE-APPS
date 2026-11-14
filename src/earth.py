"""Earth pool: VIIRS bare-ground screen + ASTER GDEM v3 windowed reads, measured with the same terrain code.

Run: python src/earth.py <viirs_dir> <scratch_dir>
Output: results/earth_windows.csv. Window heights (for Job 3) go to <scratch_dir>/earth_z/ (deleted after use).
"""
import glob
import os
import sys
import threading
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from terrain import MARGIN, window_features

ROOT = Path(__file__).resolve().parents[1]
ASTER = "https://data.lpdaac.earthdatacloud.nasa.gov/lp-prod-protected/ASTGTM.003/ASTGTMV003_{t}_dem.tif"
_url_cache = {}
_lock = threading.Lock()


def _token():
    t = os.environ.get("EARTHDATA_TOKEN")
    return t or Path.home().joinpath(".earthdata_token").read_text().strip()


def _presigned(tile):
    import requests
    if tile not in _url_cache:
        r = requests.get(ASTER.format(t=tile), headers={"Authorization": f"Bearer {_token()}", "Range": "bytes=0-0"},
                         timeout=60)
        _url_cache[tile] = r.url if r.status_code in (200, 206) else None
    return _url_cache[tile]


def _tile(lat, lon):
    return f"{'N' if lat >= 0 else 'S'}{abs(lat):02d}{'E' if lon >= 0 else 'W'}{abs(lon):03d}"


def read_geo(lon0, lon1, lat0, lat1):
    """Mosaic ASTER heights for a lon/lat box. Returns (array, lon_coords, lat_coords) at 1 arcsec, or None."""
    import rasterio
    from rasterio.windows import from_bounds
    os.environ["GDAL_DISABLE_READDIR_ON_OPEN"] = "EMPTY_DIR"
    step = 1 / 3600
    lons = np.arange(np.floor(lon0 * 3600), np.ceil(lon1 * 3600) + 1) * step
    lats = np.arange(np.ceil(lat1 * 3600), np.floor(lat0 * 3600) - 1, -1) * step
    out = np.full((len(lats), len(lons)), np.nan, np.float32)
    for tl in range(int(np.floor(lat0)), int(np.floor(lat1)) + 1):
        for tn in range(int(np.floor(lon0)), int(np.floor(lon1)) + 1):
            url = _presigned(_tile(tl, tn))
            if url is None:
                return None
            a0, a1 = max(lon0, tn), min(lon1, tn + 1)
            b0, b1 = max(lat0, tl), min(lat1, tl + 1)
            for _ in range(3):
                try:
                    with rasterio.open("/vsicurl/" + url) as src:
                        w = from_bounds(a0, b0, a1, b1, src.transform).round_offsets().round_lengths()
                        arr = src.read(1, window=w).astype(np.float32)
                        tr = src.window_transform(w)
                    break
                except Exception:
                    _url_cache.pop(_tile(tl, tn), None)
                    url = _presigned(_tile(tl, tn))
            else:
                return None
            ci = np.round((tr.c + (np.arange(arr.shape[1]) + 0.5) * tr.a - lons[0]) / step).astype(int)
            ri = np.round((lats[0] - (tr.f + (np.arange(arr.shape[0]) + 0.5) * tr.e)) / step).astype(int)
            ok_c, ok_r = (ci >= 0) & (ci < len(lons)), (ri >= 0) & (ri < len(lats))
            out[np.ix_(ri[ok_r], ci[ok_c])] = arr[np.ix_(ok_r, ok_c)]
    return out, lons, lats


def local_grid(lon, lat, npx):
    """Heights on a local 30 m grid (azimuthal equidistant, grid up = north) centred on lon, lat; npx x npx."""
    from pyproj import Transformer
    from scipy.ndimage import map_coordinates
    tr = Transformer.from_crs(f"+proj=aeqd +lat_0={lat} +lon_0={lon} +R=6371000", "EPSG:4326", always_xy=True)
    h = (npx / 2) * 30.0
    xs = (np.arange(npx) - npx / 2 + 0.5) * 30.0
    X, Y = np.meshgrid(xs, -xs)
    LON, LAT = tr.transform(X, Y)
    g = read_geo(LON.min() - 0.001, LON.max() + 0.001, LAT.min() - 0.001, LAT.max() + 0.001)
    if g is None:
        return None
    a, lons, lats = g
    ci = (LON - lons[0]) * 3600
    ri = (lats[0] - LAT) * 3600
    z = map_coordinates(a, [ri, ci], order=1, mode="nearest").astype(np.float32)
    return z if np.isfinite(z).all() else None


def bare_boxes(viirs_dir, n_per_cell=2, cell=5.0, seed=0):
    import h5py
    key = "HDFEOS/GRIDS/VIIRS_Grid_monthly_VI_CMG/Data Fields/CMG 0.05 Deg monthly NDVI"
    stack = []
    for f in sorted(glob.glob(str(Path(viirs_dir) / "*.h5"))):
        a = h5py.File(f)[key][:].astype(np.float32)
        a[a < -10000] = np.nan
        stack.append(a * 1e-4)
    peak = np.nanmax(np.stack(stack), 0)
    bare = (peak >= 0.02) & (peak <= 0.15)
    from scipy.ndimage import minimum_filter
    core = minimum_filter(bare.astype(np.uint8), 3) == 1          # 3x3 cells (0.15 deg) all bare
    r, c = np.nonzero(core)
    lat = 90 - (r + 0.5) * 0.05
    lon = -180 + (c + 0.5) * 0.05
    keep = np.abs(lat) < 82.5
    lat, lon, pk = lat[keep], lon[keep], peak[r[keep], c[keep]]
    rng = np.random.default_rng(seed)
    cells = (np.floor(lat / cell) * 1000 + np.floor(lon / cell)).astype(int)
    pick = []
    for u in np.unique(cells):
        idx = np.nonzero(cells == u)[0]
        pick += list(rng.choice(idx, min(n_per_cell, len(idx)), replace=False))
    print(f"bare 0.05-deg cells: {int(bare.sum())}, core cells: {len(lat)}, 5-deg cells: {len(np.unique(cells))}, boxes: {len(pick)}")
    return [dict(lon=float(lon[i]), lat=float(lat[i]), ndvi=float(pk[i]), kind="bare") for i in pick]


def do_box(args):
    box, zdir, offsets = args
    npx = 128 + 2 * MARGIN + int(2 * max(abs(o) for o in offsets) * 128)
    try:
        z = local_grid(box["lon"], box["lat"], npx)
    except Exception as e:
        return []
    if z is None:
        return []
    rows, c0 = [], npx // 2
    for i, oy in enumerate(offsets):
        for j, ox in enumerate(offsets):
            r, c = c0 + int(oy * 128), c0 + int(ox * 128)
            pad = 64 + MARGIN
            zp = z[r - pad:r + pad, c - pad:c + pad]
            f = window_features(zp, 64)
            if f is None:
                continue
            f2 = window_features(z[r - 32 - MARGIN:r + 32 + MARGIN, c - 32 - MARGIN:c + 32 + MARGIN], 32)
            # approximate window centre (local metres -> degrees)
            lat = box["lat"] - oy * 3840 / 111195
            lon = box["lon"] + ox * 3840 / (111195 * np.cos(np.radians(box["lat"])))
            wid = f"{box['kind']}_{box['lat']:.3f}_{box['lon']:.3f}_{i}{j}"
            f.update(id=wid, lon=lon, lat=lat, kind=box["kind"], ndvi=box.get("ndvi", np.nan),
                     site=box.get("name", ""), catalog=box.get("catalog", ""), body=box.get("body", ""))
            f.update({f"{k}__1.92": v for k, v in (f2 or {}).items()})
            np.save(Path(zdir) / f"{wid}.npy", zp.astype(np.float32))
            rows.append(f)
    return rows


if __name__ == "__main__":
    viirs, scratch = sys.argv[1], Path(sys.argv[2])
    zdir = scratch / "earth_z"
    zdir.mkdir(parents=True, exist_ok=True)
    from catalogs import load
    boxes = [(b, str(zdir), (-1, 0, 1)) for b in bare_boxes(viirs)]
    known = [dict(lon=k["lon"], lat=k["lat"], kind="known", name=k["name"], catalog=k["catalog"], body=k["body"])
             for k in load() if abs(k["lat"]) < 82.5]
    boxes += [(b, str(zdir), (0,)) for b in known]
    rows = []
    with ProcessPoolExecutor(16) as ex:
        for i, r in enumerate(ex.map(do_box, boxes, chunksize=2)):
            rows += r
            if i % 100 == 0:
                print(i, len(boxes), len(rows), flush=True)
    df = pd.DataFrame(rows)
    df.to_csv(ROOT / "results" / "earth_windows.csv", index=False)
    print(df.kind.value_counts())
