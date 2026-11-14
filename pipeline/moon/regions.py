"""Centre coordinates for NASA's nine Artemis III candidate regions (Oct 28 2024).

Method (no invented coordinates):
1. NASA's region map (artemis-iii-landing-region-candidates.jpg) shows nine yellow boxes on a
   polar-stereographic mosaic. Box centres/sizes were measured from the yellow pixels (see
   ``NASA_BOXES_PX``; reproducible with ``measure_boxes``).
2. Six boxes coincide with PGDA product 78 5 m/px site tiles (Barker et al.); the tile bounds are
   read from the GeoTIFF headers. Those six pairs fit a 2-D similarity/affine transform
   image px -> stereographic metres (residuals are logged and stored). For those six regions we use
   the PGDA tile centre itself (coord_quality = "pgda_site_tile"; note: it is the PGDA *site tile*
   extent, because ROI shapefiles are only published for Sites 01/04/07/11).
3. The remaining three boxes (Peak near Cabeus B, Mons Mouton Plateau, Slater Plain) are mapped
   through the fitted transform (coord_quality = "traced_approx").
4. IAU Gazetteer feature centres are used only as sanity checks (distance reported).
"""
from __future__ import annotations

import csv
import json
import logging
import math
import zipfile
from dataclasses import asdict, dataclass

import numpy as np
import requests

from pipeline.common.config import REGION_IDS
from pipeline.moon.common import (
    GAZETTEER_ZIP_URL, INTERIM_MOON, NASA_MAP_URL, NASA_RELEASE_URL, PGDA78_URL, RAW_MOON, REGIONS_CSV,
    lonlat_to_xy, write_json, xy_to_lonlat,
)

log = logging.getLogger(__name__)

PGDA_5MPP = "https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/{s}/{s}_final_adj_5mpp_surf.tif"
NASA_MAP_LOCAL = RAW_MOON / "nasa_regions_2024.jpg"
GAZ_DIR = RAW_MOON / "gazetteer"
COORDS_JSON = INTERIM_MOON / "regions_coords.json"
SNAP_M = 60.0  # snap centres to 60 m so the 30 m tile edges align with the 20 m LDEM grid

NAMES = {
    "cabeus_b_peak": "Peak near Cabeus B", "haworth": "Haworth", "malapert_massif": "Malapert Massif",
    "mons_mouton_plateau": "Mons Mouton Plateau", "mons_mouton": "Mons Mouton", "nobile_rim_1": "Nobile Rim 1",
    "nobile_rim_2": "Nobile Rim 2", "de_gerlache_rim_2": "de Gerlache Rim 2", "slater_plain": "Slater Plain",
}

# Box centre (col, row) and size (w, h) in NASA image pixels (1430x1105), measured at the yellow
# line centres with measure_boxes(); the three touching boxes (plateau / Mons Mouton / Nobile Rim 1)
# were separated from row/column line profiles.
NASA_BOXES_PX: dict[str, tuple[float, float, float, float]] = {
    "malapert_massif": (745.0, 326.0, 80.0, 76.0),
    "haworth": (610.5, 437.5, 111.0, 111.0),
    "nobile_rim_2": (1309.5, 421.0, 75.0, 76.0),
    "cabeus_b_peak": (102.0, 511.5, 74.0, 75.0),
    "de_gerlache_rim_2": (573.0, 679.0, 76.0, 76.0),
    "slater_plain": (997.5, 940.5, 75.0, 75.0),
    "mons_mouton_plateau": (1059.75, 231.75, 275.5, 207.5),
    "mons_mouton": (1008.25, 339.5, 56.5, 57.0),
    "nobile_rim_1": (1047.5, 367.0, 71.0, 72.0),
}
NASA_POLE_STAR_PX = (745.8, 762.3)  # green star "South Pole" (check point, not used in fit)
NASA_SCALEBAR_PX_PER_KM = (226.0 - 47.0) / 50.0  # coarse check only

# Region -> PGDA product 78 site whose 5 m/px tile coincides with the NASA box.
PGDA_SITE = {
    "malapert_massif": ("Site23", "Malapert massif"),
    "haworth": ("Haworth", "Haworth"),
    "nobile_rim_1": ("Site06", "Nobile rim 1"),
    "nobile_rim_2": ("DM2", "Nobile rim 2"),
    "de_gerlache_rim_2": ("SL2", "de Gerlache rim (SL2; Site11 is the other 'de Gerlache rim' = Rim 1 position)"),
    "mons_mouton": ("Site20", "Leibnitz beta plateau (Leibnitz Beta = former name of Mons Mouton)"),
}

# IAU Gazetteer feature used as a sanity check per region (name in the gazetteer).
GAZ_CHECK = {
    "cabeus_b_peak": "Cabeus B", "haworth": "Haworth", "malapert_massif": "Mons Malapert",
    "mons_mouton_plateau": "Mons Mouton", "mons_mouton": "Mons Mouton", "nobile_rim_1": "Nobile",
    "nobile_rim_2": "Nobile", "de_gerlache_rim_2": "de Gerlache", "slater_plain": "Slater",
}


@dataclass
class RegionCoord:
    id: str
    name: str
    lat: float
    lon: float
    x_m: float
    y_m: float
    coord_quality: str
    coord_source: str
    method: str
    reasoning: str
    box_w_km: float
    box_h_km: float
    fit_residual_km: float | None
    gazetteer_feature: str
    gazetteer_dist_km: float


def _download(url: str, dest) -> None:
    if dest.exists() and dest.stat().st_size > 10_000:
        return
    log.info("downloading %s", url)
    r = requests.get(url, timeout=120)
    r.raise_for_status()
    if len(r.content) <= 4000:
        raise RuntimeError(f"{url} returned {len(r.content)} bytes (soft 404?)")
    dest.write_bytes(r.content)


def pgda_tile_bounds() -> dict[str, list[float]]:
    """Bounds (left, bottom, right, top) of PGDA 78 site tiles, cached as JSON."""
    cache = RAW_MOON / "pgda78_tile_bounds.json"
    if cache.exists():
        return json.loads(cache.read_text())
    import rasterio

    out: dict[str, list[float]] = {}
    for site in sorted({s for s, _ in PGDA_SITE.values()} | {"Site11", "Site20v2"}):
        with rasterio.open("/vsicurl/" + PGDA_5MPP.format(s=site)) as ds:
            out[site] = list(ds.bounds)
    write_json(cache, out)
    return out


def gazetteer_lookup(names: set[str]) -> dict[str, tuple[float, float, str]]:
    """name -> (lat, lon_east, link) from the USGS/IAU nomenclature centre-points shapefile."""
    cache = RAW_MOON / "gazetteer_subset.json"
    if cache.exists():
        got = json.loads(cache.read_text())
        if names <= set(got):
            return {k: tuple(v) for k, v in got.items()}
    GAZ_DIR.mkdir(parents=True, exist_ok=True)
    zpath = GAZ_DIR / "MOON_nomenclature_center_pts.zip"
    _download(GAZETTEER_ZIP_URL, zpath)
    with zipfile.ZipFile(zpath) as zf:
        zf.extractall(GAZ_DIR)
    import shapefile  # pyshp

    rdr = shapefile.Reader(str(GAZ_DIR / "MOON_nomenclature_center_pts"))
    fields = [f[0] for f in rdr.fields[1:]]
    out: dict[str, tuple[float, float, str]] = {}
    for rec in rdr.iterRecords():
        d = dict(zip(fields, rec))
        if d["name"] in names:
            out[d["name"]] = (float(d["center_lat"]), float(d["center_lon"]), str(d["link"]))
    write_json(cache, out)
    return out


def measure_boxes(path=NASA_MAP_LOCAL) -> list[tuple[float, float, int, int]]:
    """Connected yellow components -> (cx, cy, w, h) in px. Touching boxes come out merged."""
    import cv2
    from scipy import ndimage

    im = cv2.imread(str(path))[:, :, ::-1].astype(int)
    yel = (im[..., 0] > 180) & (im[..., 1] > 180) & (im[..., 2] < 110)
    lab, _ = ndimage.label(ndimage.binary_dilation(yel))
    res = []
    for i, sl in enumerate(ndimage.find_objects(lab)):
        if (lab[sl] == i + 1).sum() > 50:
            ys, xs = sl
            res.append(((xs.start + xs.stop - 1) / 2, (ys.start + ys.stop - 1) / 2, xs.stop - xs.start, ys.stop - ys.start))
    return res


def fit_image_to_grid(bounds: dict[str, list[float]]) -> tuple[np.ndarray, dict[str, float]]:
    """Least-squares affine [x, y] = A @ [col, row, 1] from the PGDA-matched boxes."""
    rows, tx, ty, ids = [], [], [], []
    for rid, (site, _) in PGDA_SITE.items():
        l, b, r, t = bounds[site]
        cx, cy = NASA_BOXES_PX[rid][:2]
        rows.append([cx, cy, 1.0])
        tx.append((l + r) / 2)
        ty.append((b + t) / 2)
        ids.append(rid)
    m = np.array(rows)
    ax, *_ = np.linalg.lstsq(m, np.array(tx), rcond=None)
    ay, *_ = np.linalg.lstsq(m, np.array(ty), rcond=None)
    a = np.vstack([ax, ay])
    pred = (a @ m.T).T
    resid = {rid: float(math.hypot(p[0] - x, p[1] - y)) / 1000 for rid, p, x, y in zip(ids, pred, tx, ty)}
    return a, resid


def _snap(v: float) -> float:
    return round(v / SNAP_M) * SNAP_M


def build_regions(force: bool = False) -> list[RegionCoord]:
    if COORDS_JSON.exists() and not force:
        return [RegionCoord(**d) for d in json.loads(COORDS_JSON.read_text())]
    _download(NASA_MAP_URL, NASA_MAP_LOCAL)
    bounds = pgda_tile_bounds()
    gaz = gazetteer_lookup(set(GAZ_CHECK.values()))
    a, resid = fit_image_to_grid(bounds)
    scale_km_per_px = math.sqrt(abs(np.linalg.det(a[:, :2]))) / 1000
    rot_deg = math.degrees(math.atan2(a[1, 0], a[0, 0]))
    pole = a @ np.array([*NASA_POLE_STAR_PX, 1.0])
    rms = math.sqrt(np.mean(np.square(list(resid.values()))))
    log.info("NASA map fit: %.4f km/px (scalebar %.4f), rotation %.2f deg, RMS resid %.2f km, pole star -> (%.1f, %.1f) km",
             scale_km_per_px, 1 / NASA_SCALEBAR_PX_PER_KM, rot_deg, rms, pole[0] / 1000, pole[1] / 1000)
    fit_note = (f"affine fit of 6 NASA boxes to PGDA-78 tile centres: {scale_km_per_px * 1000:.0f} m/px, "
                f"rotation {rot_deg:+.2f} deg, RMS residual {rms:.2f} km; pole star maps to "
                f"({pole[0] / 1000:+.1f}, {pole[1] / 1000:+.1f}) km")

    out: list[RegionCoord] = []
    for rid in REGION_IDS:
        cx, cy, w, h = NASA_BOXES_PX[rid]
        traced = a @ np.array([cx, cy, 1.0])
        bw, bh = w * scale_km_per_px, h * scale_km_per_px
        if rid in PGDA_SITE:
            site, desc = PGDA_SITE[rid]
            l, b, r, t = bounds[site]
            x, y = (l + r) / 2, (b + t) / 2
            quality = "pgda_site_tile"
            source = f"PGDA product 78 {site} ({desc}) 5 m/px tile extent centre; {PGDA_5MPP.format(s=site)}; {PGDA78_URL}"
            d_tr = math.hypot(traced[0] - x, traced[1] - y) / 1000
            method = (f"Centre of PGDA-78 {site} tile bounds [{l:.0f},{b:.0f},{r:.0f},{t:.0f}] m "
                      f"({(r - l) / 1000:.0f} km square). NASA Oct-2024 box maps to within {d_tr:.2f} km.")
            reasoning = (f"NASA box '{NAMES[rid]}' has the same size ({bw:.1f}x{bh:.1f} km) and position as the "
                         f"{site} tile, so NASA drew the region from that PGDA site. ROI shapefile not published "
                         f"for {site}; tile extent used.")
            if rid == "de_gerlache_rim_2":
                reasoning += (" PGDA lists two 'de Gerlache rim' sites: Site11 (ROI shapefile exists, centre "
                              "(-37.0, 15.0) km) and SL2 (-48.5, 23.0) km. The 'Rim 2' box matches SL2, not Site11.")
            if rid == "mons_mouton":
                reasoning += (" The small 'Mons Mouton' box matches Site20 (Leibnitz beta plateau); the large "
                              "'Mons Mouton Plateau' box is a separate, traced region.")
            resid_km = resid[rid]
        else:
            x, y = float(traced[0]), float(traced[1])
            quality = "traced_approx"
            source = f"Approximate, traced from NASA map ({NASA_MAP_URL}; release {NASA_RELEASE_URL}) georeferenced on PGDA-78 tiles"
            method = f"NASA box centre px ({cx:.1f},{cy:.1f}) mapped through {fit_note}."
            reasoning = (f"No PGDA-78 tile matches this box; position uncertainty ~ fit RMS ({rms:.1f} km) plus "
                         f"~0.3 km box-measurement error. Box is {bw:.1f}x{bh:.1f} km.")
            if rid == "mons_mouton_plateau":
                reasoning += " The region box is much larger than our 15 km core; core taken at the box centre."
            resid_km = None
        x, y = _snap(x), _snap(y)
        lon, lat = xy_to_lonlat(x, y)
        gname = GAZ_CHECK[rid]
        glat, glon, glink = gaz[gname]
        gx, gy = lonlat_to_xy(glon, glat)
        gd = math.hypot(gx - x, gy - y) / 1000
        reasoning += f" IAU feature '{gname}' centre ({glat:.2f}, {glon:.2f}E; {glink}) is {gd:.1f} km away."
        out.append(RegionCoord(rid, NAMES[rid], round(lat, 5), round(lon, 5), x, y, quality, source, method,
                               reasoning, round(bw, 2), round(bh, 2), None if resid_km is None else round(resid_km, 3),
                               gname, round(gd, 2)))
    write_json(COORDS_JSON, [asdict(r) for r in out])
    with REGIONS_CSV.open("w", newline="") as fh:
        wr = csv.DictWriter(fh, fieldnames=list(asdict(out[0]).keys()))
        wr.writeheader()
        for r in out:
            wr.writerow(asdict(r))
    log.info("wrote %s and %s", COORDS_JSON, REGIONS_CSV)
    return out


def regions_by_id(force: bool = False) -> dict[str, RegionCoord]:
    return {r.id: r for r in build_regions(force)}
