"""Moon data from PDS (LRO LOLA): windowed reads of polar-stereographic IMG files with HTTP range requests.

Only the rows and columns covering a region are fetched. Nothing large is written to disk.
"""
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import requests

R_MOON = 1737400.0
PDS = "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx"
PRODUCTS = {
    # name: (url, n_pixels per side, metres per pixel, centre offset (pix), scale factor)
    "ldem20": (f"{PDS}/data/lola_gdr/polar/img/ldem_80s_20m.img", 30400, 20.0, 15199.5, 0.5),
    "sun120": (f"{PDS}/extras/illumination/img/avgvisib_75s_120m_201608.img", 7624, 120.0, 3811.5, 0.00004),
    "earth120": (f"{PDS}/extras/illumination/img/avgvisib_75s_120m_201608_earth.img", 7624, 120.0, 3811.5, 0.00004),
    "psr120": (f"{PDS}/extras/illumination/img/lpsr_75s_120m_201608.img", 7624, 120.0, 3811.5, None),
}
ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "cache" / "moon"


def lonlat_to_xy(lon, lat):
    """South polar stereographic on a 1737.4 km sphere, true scale at the pole (LOLA convention)."""
    lon, lat = np.radians(lon), np.radians(lat)
    rho = 2 * R_MOON * np.tan(np.pi / 4 + lat / 2)
    return rho * np.sin(lon), rho * np.cos(lon)


def xy_to_lonlat(x, y):
    rho = np.hypot(x, y)
    lat = 2 * np.arctan(rho / (2 * R_MOON)) - np.pi / 2
    return np.degrees(np.arctan2(x, y)), np.degrees(lat)


def _rows(url, row0, row1, col0, col1, ncols, nbytes=2):
    def get(r):
        a = (r * ncols + col0) * nbytes
        b = (r * ncols + col1) * nbytes - 1
        for _ in range(5):
            try:
                resp = requests.get(url, headers={"Range": f"bytes={a}-{b}"}, timeout=60)
                if resp.status_code == 206 and len(resp.content) == b - a + 1:
                    return resp.content
            except requests.RequestException:
                pass
        raise IOError(f"row {r} failed")
    with ThreadPoolExecutor(32) as ex:
        chunks = list(ex.map(get, range(row0, row1)))
    return np.frombuffer(b"".join(chunks), dtype="<i2").reshape(row1 - row0, col1 - col0)


def read_box(product, x0, x1, y0, y1):
    """Read a box (metres, polar stereographic) from a PDS product. Returns (array, x_coords, y_coords)."""
    url, n, res, c, scale = PRODUCTS[product]
    col0 = int(np.floor(x0 / res + c)); col1 = int(np.ceil(x1 / res + c)) + 1
    row0 = int(np.floor(c - y1 / res)); row1 = int(np.ceil(c - y0 / res)) + 1
    col0, row0 = max(col0, 0), max(row0, 0); col1, row1 = min(col1, n), min(row1, n)
    a = _rows(url, row0, row1, col0, col1, n).astype(np.float32)
    if scale is not None:
        a = a * scale
    xs = (np.arange(col0, col1) - c + 0.5) * res
    ys = (c - np.arange(row0, row1) - 0.5) * res
    return a, xs, ys


def regions():
    import geopandas as gpd
    g = gpd.read_file(ROOT / "data" / "regions" / "A3_9regions-lonlat-simplified.geojson")
    out = {}
    for _, r in g.iterrows():
        lon, lat = np.array(r.geometry.exterior.coords).T
        x, y = lonlat_to_xy(lon, lat)
        out[r["Region"]] = dict(x=x.tolist(), y=y.tolist(), lon=lon.tolist(), lat=lat.tolist())
    return out


def region_data(name, margin=2000.0):
    """Region DEM (30 m grid), sunlight, Earth visibility, PSR, cached as .npz in cache/moon."""
    CACHE.mkdir(parents=True, exist_ok=True)
    f = CACHE / f"{name.replace(' ', '_')}.npz"
    if f.exists():
        d = dict(np.load(f, allow_pickle=True))
        # PSR label: value = DN * 0.000025 + 0.5, so DN -20000 -> 0 (not PSR), +20000 -> 1 (PSR)
        d["psr120"] = (d["psr120"] > 0).astype(np.float32)
        return d
    reg = regions()[name]
    x0, x1 = min(reg["x"]) - margin, max(reg["x"]) + margin
    y0, y1 = min(reg["y"]) - margin, max(reg["y"]) + margin
    z20, xs, ys = read_box("ldem20", x0, x1, y0, y1)
    # 20 m -> 30 m: light smoothing then bilinear sampling (approximate area mean)
    from scipy.ndimage import gaussian_filter, map_coordinates
    zs = gaussian_filter(z20, 0.6)
    gx = np.arange(xs[0], xs[-1], 30.0); gy = np.arange(ys[0], ys[-1], -30.0)
    cc = (gx - xs[0]) / 20.0; rr = (ys[0] - gy) / 20.0
    R, C = np.meshgrid(rr, cc, indexing="ij")
    z30 = map_coordinates(zs, [R, C], order=1).astype(np.float32)
    out = dict(z30=z30, gx=gx, gy=gy, name=name)
    for p in ("sun120", "earth120", "psr120"):
        a, ax, ay = read_box(p, x0, x1, y0, y1)
        ci = np.clip(np.round((gx - ax[0]) / 120.0).astype(int), 0, len(ax) - 1)
        ri = np.clip(np.round((ay[0] - gy) / 120.0).astype(int), 0, len(ay) - 1)
        out[p] = a[np.ix_(ri, ci)].astype(np.float32)
    np.savez_compressed(f, **out)
    out["psr120"] = (out["psr120"] > 0).astype(np.float32)
    return out


if __name__ == "__main__":
    regs = regions()
    json.dump(regs, open(ROOT / "data" / "regions" / "regions_xy.json", "w"))
    for name in regs:
        d = region_data(name)
        z = d["z30"]
        print(f"{name:22s} grid {z.shape}  height {np.nanmin(z):8.0f} .. {np.nanmax(z):8.0f} m  "
              f"sun {d['sun120'].mean():.2f}  earth {d['earth120'].mean():.2f}  psr {np.unique(d['psr120'])[:4]}")
