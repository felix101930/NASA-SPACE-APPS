"""Verify our 9 Artemis III region centres against the official USGS LGRS release.

Source: McClernan, M.T. (2024) "Down Selected Artemis III Candidate Landing Site Navigational
Grids", USGS data release, doi:10.5066/P1MEQ6UK (ScienceBase item 671a6fa8d34efed5620f89f8).
USGS data: public domain (US Government work).

The release ships one small region-boundary file, ``A3_9regions-lonlat-simplified.zip`` (0.6 MB,
shapefile + GeoJSON in Moon 2000/2015 sphere lon/lat, R = 1 737 400 m), plus per-region zips
(68 MB - 1.2 GB) holding the 1 km / 100 m / 10 m LGRS grids in Lunar Polar Stereographic (LPS:
stere, lat_0=-90, k=0.994, FE=FN=500 000 m). We use the boundary file as the official extent and
cross-check it against the 1 km grid of Mons Mouton (the smallest per-region zip).

Each official boundary is a 4-corner polygon whose edges are straight in LPS. LPS and our MOON_CRS
are both south-polar stereographic on the same sphere and differ only by scale (0.994) and false
origin, so straight LPS edges stay straight in MOON_CRS: reprojecting the corners is exact.

Outputs (never overwrites the existing region products):
  data/regions_usgs_compare.csv
  data/raw/usgs_lgrs/regions_extent.geojson          (lon/lat, IAU_2015:30100)
  data/raw/usgs_lgrs/regions_extent_moon_crs.geojson (MOON_CRS metres)

Run: python -m pipeline.moon.usgs_regions
"""
from __future__ import annotations

import csv
import json
import logging
import zipfile
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import requests
import shapefile
from pyproj import CRS, Geod, Transformer
from shapely.geometry import Point, Polygon, box, mapping
from shapely.affinity import translate
from shapely.ops import nearest_points

from pipeline.common.config import CORE_SIZE_PX, GRID_RES_M, MOON_CRS, MOON_R_M, RAW, ROOT

log = logging.getLogger(__name__)

DOI = "10.5066/P1MEQ6UK"
SCIENCEBASE_ITEM = "https://www.sciencebase.gov/catalog/item/671a6fa8d34efed5620f89f8"
FILE_BASE = "https://www.sciencebase.gov/catalog/file/get/671a6fa8d34efed5620f89f8"
BOUNDARY_ZIP_URL = f"{FILE_BASE}?name=A3_9regions-lonlat-simplified.zip"
METADATA_XML_URL = f"{FILE_BASE}?f=__disk__66%2F70%2F0c%2F66700c5f82e107f68bfc6c364877658331de198f"
MONS_MOUTON_ZIP_URL = f"{FILE_BASE}?f=__disk__d5%2Ffb%2Fa8%2Fd5fba8aa1285f6255df0c5bc5fdb8a7fc6d841d1"

USGS_DIR = RAW / "usgs_lgrs"
BOUNDARY_ZIP = USGS_DIR / "A3_9regions-lonlat-simplified.zip"
BOUNDARY_DIR = USGS_DIR / "A3_9regions"
BOUNDARY_GEOJSON = BOUNDARY_DIR / "A3_9regions-lonlat-simplified.geojson"
GRID_1KM_DIR = USGS_DIR / "grids_1km"
MM_GRID_1KM = GRID_1KM_DIR / "Mons_Mouton_PolarLGRS_ACC_1km_S_Grid.shp"
EXTENT_LONLAT = USGS_DIR / "regions_extent.geojson"
EXTENT_MOON = USGS_DIR / "regions_extent_moon_crs.geojson"

OUR_COORDS_CSV = ROOT / "data" / "regions_coords.csv"
COMPARE_CSV = ROOT / "data" / "regions_usgs_compare.csv"

GEOG_CRS = "IAU_2015:30100"  # Moon (2015) - Sphere / Ocentric, R = 1 737 400 m
LPS_SOUTH = "+proj=stere +lat_0=-90 +lon_0=0 +k=0.994 +x_0=500000 +y_0=500000 +R=1737400 +units=m +no_defs"
LPS_K0 = 0.994
LPS_FALSE_EN = 500_000.0

CORE_M = CORE_SIZE_PX * GRID_RES_M       # 15 000 m
SNAP_M = 60.0                            # same snap as pipeline.moon.regions
MOVE_DIST_KM = 5.0                       # recommend move if centre is further than this ...
LARGE_REGION_KM2 = 1_500.0               # ... unless the region is this large (distance then irrelevant)

USGS_NAME_TO_ID = {
    "Peak Near Cabeus B": "cabeus_b_peak",
    "Haworth": "haworth",
    "Malapert Massif": "malapert_massif",
    "Mons Mouton Plateau": "mons_mouton_plateau",
    "Mons Mouton": "mons_mouton",
    "Nobile Rim 1": "nobile_rim_1",
    "Nobile Rim 2": "nobile_rim_2",
    "de Gerlache Rim 2": "de_gerlache_rim_2",
    "Slater Plain": "slater_plain",
}

_TO_MOON = Transformer.from_crs(CRS(GEOG_CRS), CRS(MOON_CRS), always_xy=True)
_TO_GEOG = Transformer.from_crs(CRS(MOON_CRS), CRS(GEOG_CRS), always_xy=True)
_GEOD = Geod(a=MOON_R_M, b=MOON_R_M)


# ----------------------------------------------------------------------------- transforms
def lonlat_to_moon(lon: float, lat: float) -> tuple[float, float]:
    x, y = _TO_MOON.transform(lon, lat)
    return float(x), float(y)


def moon_to_lonlat(x: float, y: float) -> tuple[float, float]:
    lon, lat = _TO_GEOG.transform(x, y)
    return float(lon), float(lat)


def lps_to_moon(x_lps: float, y_lps: float) -> tuple[float, float]:
    """LPS south (k0=0.994, FE=FN=500 km) -> MOON_CRS (k0=1, no false origin). Analytic."""
    return (x_lps - LPS_FALSE_EN) / LPS_K0, (y_lps - LPS_FALSE_EN) / LPS_K0


def spherical_area_km2(poly_moon: Polygon, step_m: float = 250.0) -> float:
    """True area on the lunar sphere (stereographic is conformal, not equal-area)."""
    dense = poly_moon.segmentize(step_m)
    lon, lat = _TO_GEOG.transform(*np.asarray(dense.exterior.coords).T)
    area, _ = _GEOD.polygon_area_perimeter(lon, lat)
    return abs(area) / 1e6


# ----------------------------------------------------------------------------- download
def _download(url: str, dest: Path) -> None:
    if dest.exists() and dest.stat().st_size > 0:
        log.info("cached %s", dest.name)
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    log.info("GET %s", url)
    with requests.get(url, stream=True, timeout=120) as r:
        r.raise_for_status()
        ctype = r.headers.get("content-type", "")
        if "html" in ctype:
            raise RuntimeError(f"{url} returned HTML ({ctype}), not data")
        tmp = dest.with_suffix(dest.suffix + ".part")
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
        tmp.rename(dest)


def fetch_boundaries() -> Path:
    """Download (once) the 0.6 MB official region-boundary zip and the release metadata XML."""
    _download(METADATA_XML_URL, USGS_DIR / "Publication_Data_Release_LGRS3.xml")
    _download(BOUNDARY_ZIP_URL, BOUNDARY_ZIP)
    if not BOUNDARY_GEOJSON.exists():
        with zipfile.ZipFile(BOUNDARY_ZIP) as z:
            for name in z.namelist():
                if Path(name).name != name or name.startswith("."):
                    raise RuntimeError(f"unexpected path in zip: {name}")
            z.extractall(BOUNDARY_DIR)
    return BOUNDARY_GEOJSON


# ----------------------------------------------------------------------------- official extents
@dataclass
class OfficialRegion:
    id: str
    name: str
    code: str
    attr_area_km2: float      # USGS Area_km2 attribute (planar, LPS metres)
    poly_lonlat: Polygon
    poly_moon: Polygon


def load_official_regions(path: Path = BOUNDARY_GEOJSON) -> dict[str, OfficialRegion]:
    gj = json.loads(Path(path).read_text())
    out: dict[str, OfficialRegion] = {}
    for f in gj["features"]:
        p = f["properties"]
        rid = USGS_NAME_TO_ID[p["Region"]]
        ring = f["geometry"]["coordinates"][0]
        poly_ll = Polygon(ring)
        poly_m = Polygon([lonlat_to_moon(lon, lat) for lon, lat in ring])
        out[rid] = OfficialRegion(rid, p["Region"], p["RegionCode"], float(p["Area_km2"]), poly_ll, poly_m)
    missing = set(USGS_NAME_TO_ID.values()) - set(out)
    if missing:
        raise RuntimeError(f"official boundary file is missing regions: {sorted(missing)}")
    return out


def grid_1km_union_moon(shp: Path = MM_GRID_1KM) -> Polygon:
    """Union of a region's 1 km LGRS cells, in MOON_CRS (cells are axis-aligned LPS squares)."""
    r = shapefile.Reader(str(shp))
    xs0, ys0, xs1, ys1 = r.bbox
    # all cells are axis-aligned and contiguous; verify before taking the bbox as the union
    n = len(r)
    expected = round((xs1 - xs0) / 1000) * round((ys1 - ys0) / 1000)
    if n != expected:
        raise RuntimeError(f"{shp.name}: {n} cells, bbox implies {expected}")
    (x0, y0), (x1, y1) = lps_to_moon(xs0, ys0), lps_to_moon(xs1, ys1)
    return box(x0, y0, x1, y1)


# ----------------------------------------------------------------------------- comparison
def core_box(x: float, y: float) -> Polygon:
    return box(x - CORE_M / 2, y - CORE_M / 2, x + CORE_M / 2, y + CORE_M / 2)


def core_inside(poly: Polygon, x: float, y: float) -> str:
    c = core_box(x, y)
    if poly.covers(c):
        return "full"
    return "partial" if poly.intersects(c) else "none"


def feasible_centres(poly: Polygon) -> Polygon:
    """Centres whose 15 km core lies fully inside a convex polygon: intersect P shifted by each corner."""
    h = CORE_M / 2
    out = poly
    for dx, dy in ((h, h), (h, -h), (-h, h), (-h, -h)):
        out = out.intersection(translate(poly, -dx, -dy))
    return out


def propose_centre(poly: Polygon) -> tuple[float, float, str]:
    c = poly.centroid
    feas = feasible_centres(poly)
    if feas.is_empty:
        return c.x, c.y, "region smaller than 15 km core; centroid used"
    if feas.buffer(1e-6).contains(c):
        return c.x, c.y, "centroid (core fully inside)"
    p = nearest_points(feas, c)[0]
    return p.x, p.y, "nearest point to centroid keeping core fully inside"


def _snap(v: float) -> float:
    return round(v / SNAP_M) * SNAP_M


@dataclass
class CompareRow:
    id: str
    name: str
    our_lat: float
    our_lon: float
    our_coord_quality: str
    usgs_centroid_lat: float
    usgs_centroid_lon: float
    dist_km: float
    core_inside: str
    usgs_area_km2: float
    usgs_width_km: float
    usgs_height_km: float
    proposed_lat: float
    proposed_lon: float
    proposed_x_m: float
    proposed_y_m: float
    proposed_core_inside: str
    recommend: str
    reason: str


def read_our_coords(path: Path = OUR_COORDS_CSV) -> dict[str, dict[str, str]]:
    with open(path, newline="") as f:
        return {r["id"]: r for r in csv.DictReader(f)}


def compare(official: dict[str, OfficialRegion], ours: dict[str, dict[str, str]]) -> list[CompareRow]:
    rows: list[CompareRow] = []
    for rid, o in ours.items():
        reg = official[rid]
        poly = reg.poly_moon
        ox, oy = float(o["x_m"]), float(o["y_m"])
        cen = poly.centroid
        clon, clat = moon_to_lonlat(cen.x, cen.y)
        dist_km = Point(ox, oy).distance(cen) / 1000
        inside = core_inside(poly, ox, oy)
        area = spherical_area_km2(poly)
        px, py, how = propose_centre(poly)
        px, py = _snap(px), _snap(py)
        if not poly.covers(core_box(px, py)):   # snapping must not push the core out
            px, py = round(px), round(py)
        plon, plat = moon_to_lonlat(px, py)
        large = area >= LARGE_REGION_KM2
        if inside != "full":
            rec, why = "move", f"our core is only {inside}ly inside the official extent" if inside == "partial" \
                else "our core lies outside the official extent"
        elif dist_km > MOVE_DIST_KM and not large:
            rec, why = "move", f"core inside but centre {dist_km:.1f} km from official centroid (> {MOVE_DIST_KM:.0f} km)"
        elif large:
            rec, why = "keep", f"core fully inside a {area:.0f} km2 region; centroid offset ({dist_km:.1f} km) not material"
        else:
            rec, why = "keep", f"core fully inside; centre {dist_km:.2f} km from official centroid"
        rows.append(CompareRow(
            rid, reg.name, float(o["lat"]), float(o["lon"]), o["coord_quality"],
            round(clat, 5), round(clon, 5), round(dist_km, 3), inside, round(area, 1),
            round((poly.bounds[2] - poly.bounds[0]) / 1000, 2), round((poly.bounds[3] - poly.bounds[1]) / 1000, 2),
            round(plat, 5), round(plon, 5), px, py, core_inside(poly, px, py), rec, f"{why}; proposal = {how}",
        ))
    return rows


# ----------------------------------------------------------------------------- outputs
def write_extents(official: dict[str, OfficialRegion]) -> None:
    def fc(geom_key: str, crs_note: str) -> dict:
        feats = []
        for reg in official.values():
            feats.append({
                "type": "Feature",
                "properties": {"id": reg.id, "name": reg.name, "usgs_code": reg.code,
                               "usgs_attr_area_km2": reg.attr_area_km2,
                               "area_km2_sphere": round(spherical_area_km2(reg.poly_moon), 2)},
                "geometry": mapping(getattr(reg, geom_key)),
            })
        return {"type": "FeatureCollection", "crs_note": crs_note,
                "source": f"USGS doi:{DOI} A3_9regions-lonlat-simplified", "features": feats}

    EXTENT_LONLAT.write_text(json.dumps(fc("poly_lonlat", f"{GEOG_CRS} lon/lat degrees (Moon sphere R=1737400)"), indent=1))
    EXTENT_MOON.write_text(json.dumps(fc("poly_moon", f"MOON_CRS metres: {MOON_CRS}"), indent=1))
    log.info("wrote %s and %s", EXTENT_LONLAT, EXTENT_MOON)


def write_compare(rows: list[CompareRow], path: Path = COMPARE_CSV) -> None:
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(asdict(rows[0])))
        w.writeheader()
        for r in rows:
            w.writerow(asdict(r))
    log.info("wrote %s (%d rows)", path, len(rows))


def cross_check_grid(official: dict[str, OfficialRegion]) -> dict[str, float] | None:
    """Compare Mons Mouton's 1 km LGRS grid union with its simplified boundary (if the grid is cached)."""
    if not MM_GRID_1KM.exists():
        log.warning("1 km grid not cached (%s); skip grid cross-check", MM_GRID_1KM)
        return None
    g = grid_1km_union_moon()
    b = official["mons_mouton"].poly_moon
    res = {
        "grid_area_km2_moon": g.area / 1e6, "boundary_area_km2_moon": b.area / 1e6,
        "boundary_within_grid": float(g.buffer(1.0).covers(b)),
        "centroid_offset_m": g.centroid.distance(b.centroid),
        "hausdorff_m": g.hausdorff_distance(b),
    }
    log.info("Mons Mouton 1 km grid vs boundary: %s", {k: round(v, 3) for k, v in res.items()})
    return res


def run() -> list[CompareRow]:
    fetch_boundaries()
    official = load_official_regions()
    write_extents(official)
    cross_check_grid(official)
    rows = compare(official, read_our_coords())
    write_compare(rows)
    for r in rows:
        log.info("%-20s dist %6.2f km  core %-7s area %7.1f km2  -> %s", r.id, r.dist_km, r.core_inside,
                 r.usgs_area_km2, r.recommend)
    return rows


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    run()
