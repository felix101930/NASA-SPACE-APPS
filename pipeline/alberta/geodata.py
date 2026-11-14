"""Alberta boundary, the complete 15 km window tiling, park flags and place names.

- Boundary: Natural Earth 1:10m admin-1 (public domain), feature name == "Alberta", projected to
  EPSG:3400 (NAD83 / Alberta 10-TM Forest), the province's own equal-ish-scale projection.
- Tiling: a regular 15 x 15 km grid in EPSG:3400 anchored at a multiple of 15 km below/left of the
  boundary bbox. Every cell that intersects the boundary is a window -> a full census (no sampling).
- Parks: CPCAD polygons (ECCC, OGL-Canada) in the Alberta bbox for park-type designations.
- Names: GeoNames Canada extract, populated places (feature class P), nearest by great-circle.
"""
from __future__ import annotations

import io
import json
import logging
import math
import zipfile
from dataclasses import dataclass

import numpy as np
import shapefile  # pyshp
from pyproj import Transformer
from shapely import STRtree
from shapely.geometry import box, shape
from shapely.ops import transform as shp_transform, unary_union

from pipeline.alberta.common import RAW, download_cached, http_get

log = logging.getLogger("pipeline.alberta.geodata")

AB_CRS = "EPSG:3400"
WIN_M = 15_000.0
NE_URL = "https://naciscdn.org/naturalearth/10m/cultural/ne_10m_admin_1_states_provinces.zip"
CPCAD_URL = "https://maps-cartes.ec.gc.ca/arcgis/rest/services/CWS_SCF/CPCAD/MapServer/0/query"
GEONAMES_URL = "https://download.geonames.org/export/dump/CA.zip"
PARK_TYPES = (
    "National Park", "Provincial Park", "Wildland Provincial Park", "Wilderness Park", "Wilderness Area",
    "Ecological Reserve", "Heritage Rangeland", "Natural Area", "Provincial Recreation Area",
    "Special Protection Natural Environment Park",
)
TO_AB = Transformer.from_crs("EPSG:4326", AB_CRS, always_xy=True)
TO_LL = Transformer.from_crs(AB_CRS, "EPSG:4326", always_xy=True)


def _proj(geom, tr: Transformer):
    return shp_transform(lambda x, y, z=None: tr.transform(x, y), geom)


# ----------------------------------------------------------------------------- boundary
def alberta_boundary_ll():
    """Alberta polygon (lon/lat) from Natural Earth admin-1 10m (cached GeoJSON)."""
    cache = RAW / "alberta_boundary_ne10m.geojson"
    if not cache.exists():
        z = download_cached(NE_URL, RAW / "ne_10m_admin_1_states_provinces.zip")
        with zipfile.ZipFile(z) as zf:
            def part(ext):
                return io.BytesIO(zf.read(next(n for n in zf.namelist() if n.endswith(ext))))
            rdr = shapefile.Reader(shp=part(".shp"), shx=part(".shx"), dbf=part(".dbf"), encoding="utf-8")
            fields = [f[0] for f in rdr.fields[1:]]
            for sr in rdr.iterShapeRecords():
                rec = dict(zip(fields, sr.record))
                if rec.get("name") == "Alberta" and rec.get("admin") == "Canada":
                    cache.write_text(json.dumps({"type": "Feature", "properties": {"name": "Alberta",
                                                 "source": NE_URL}, "geometry": sr.shape.__geo_interface__}))
                    break
            else:
                raise RuntimeError("Alberta not found in Natural Earth admin-1")
    return shape(json.loads(cache.read_text())["geometry"])


def alberta_boundary_ab():
    return _proj(alberta_boundary_ll(), TO_AB).buffer(0)


# ----------------------------------------------------------------------------- tiling
@dataclass(frozen=True)
class Window:
    id: str
    row: int
    col: int
    x0: float   # left (EPSG:3400)
    y1: float   # top
    frac_in_ab: float

    @property
    def cx(self) -> float:
        return self.x0 + WIN_M / 2

    @property
    def cy(self) -> float:
        return self.y1 - WIN_M / 2

    def lonlat(self) -> tuple[float, float]:
        lon, lat = TO_LL.transform(self.cx, self.cy)
        return float(lon), float(lat)


def grid_origin(bounds: tuple[float, float, float, float], win: float = WIN_M) -> tuple[float, float, int, int]:
    """(x_left, y_top, n_rows, n_cols) of a grid anchored on multiples of win that covers bounds."""
    minx, miny, maxx, maxy = bounds
    x0 = math.floor(minx / win) * win
    y1 = math.ceil(maxy / win) * win
    ncol = int(math.ceil((maxx - x0) / win))
    nrow = int(math.ceil((y1 - miny) / win))
    return x0, y1, nrow, ncol


def tile_polygon(poly, win: float = WIN_M, prefix: str = "AB") -> list[Window]:
    """All grid cells intersecting poly (area > 0), with the fraction of each cell inside poly."""
    x0, y1, nrow, ncol = grid_origin(poly.bounds, win)
    out = []
    for r in range(nrow):
        for c in range(ncol):
            cell = box(x0 + c * win, y1 - (r + 1) * win, x0 + (c + 1) * win, y1 - r * win)
            if not poly.intersects(cell):
                continue
            a = poly.intersection(cell).area
            if a <= 0:
                continue
            out.append(Window(f"{prefix}_{r:03d}_{c:03d}", r, c, cell.bounds[0], cell.bounds[3], a / (win * win)))
    return out


def coverage_stats(poly, wins: list[Window], win: float = WIN_M) -> dict:
    cells = unary_union([box(w.x0, w.y1 - win, w.x0 + win, w.y1) for w in wins])
    covered = poly.intersection(cells).area
    return {"province_km2": poly.area / 1e6, "covered_km2": covered / 1e6,
            "pct_covered": 100.0 * covered / poly.area, "tiled_km2": len(wins) * win * win / 1e6}


# ----------------------------------------------------------------------------- parks
def fetch_parks() -> list[dict]:
    """CPCAD park-type polygons intersecting the Alberta bbox, in EPSG:3400 (cached GeoJSON in lon/lat)."""
    cache = RAW / "cpcad_alberta_parks.geojson"
    if not cache.exists():
        feats, offset = [], 0
        types = ",".join("'" + t + "'" for t in PARK_TYPES)
        while True:
            r = http_get(CPCAD_URL, params={
                "where": f"TYPE_E IN ({types})", "geometry": "-120.1,48.9,-109.9,60.1",
                "geometryType": "esriGeometryEnvelope", "inSR": "4326", "spatialRel": "esriSpatialRelIntersects",
                "outFields": "NAME_E,TYPE_E,LOC,O_AREA_HA,MGMT_E", "outSR": "4326", "maxAllowableOffset": "0.001",
                "resultOffset": str(offset), "resultRecordCount": "500", "f": "geojson"}, timeout=180)
            d = r.json()
            fs = d.get("features", [])
            feats += fs
            if len(fs) < 500 and not d.get("exceededTransferLimit") and not d.get("properties", {}).get("exceededTransferLimit"):
                break
            offset += len(fs)
            if not fs:
                break
        cache.write_text(json.dumps({"type": "FeatureCollection", "features": feats}))
        log.info("CPCAD: %d park polygons cached", len(feats))
    out = []
    for f in json.loads(cache.read_text())["features"]:
        if not f.get("geometry"):
            continue
        g = _proj(shape(f["geometry"]), TO_AB).buffer(0)
        if not g.is_empty:
            p = f["properties"]
            out.append({"name": p.get("NAME_E"), "type": p.get("TYPE_E"), "geom": g})
    return out


class ParkIndex:
    def __init__(self, parks: list[dict]):
        self.parks = parks
        self.tree = STRtree([p["geom"] for p in parks]) if parks else None

    def overlaps(self, geom, min_frac: float = 0.01) -> list[dict]:
        """Parks covering >= min_frac of geom (sorted by overlap)."""
        if self.tree is None:
            return []
        hits = []
        for i in self.tree.query(geom):
            p = self.parks[int(i)]
            a = p["geom"].intersection(geom).area / geom.area
            if a >= min_frac:
                hits.append({"name": p["name"], "type": p["type"], "frac": round(a, 3)})
        return sorted(hits, key=lambda h: -h["frac"])


# ----------------------------------------------------------------------------- places
T_CODES = {"HLL", "HLLS", "MT", "MTS", "RDG", "RDGE", "PK", "PKS", "BUTE", "MESA", "PLAT", "UPLD", "VAL", "CNYN",
           "SCRP", "CLF", "BDLD", "CRQ", "PASS", "GAP"}


class Places:
    """Nearest GeoNames populated place (class P) and named terrain feature (class T) in Canada."""

    def __init__(self):
        cache = RAW / "geonames_ca_places_v2.json"
        if not cache.exists():
            z = download_cached(GEONAMES_URL, RAW / "geonames_CA.zip")
            rows = []
            with zipfile.ZipFile(z) as zf, zf.open("CA.txt") as fh:
                for line in io.TextIOWrapper(fh, encoding="utf-8"):
                    p = line.rstrip("\n").split("\t")
                    if len(p) > 14 and (p[6] == "P" or (p[6] == "T" and p[7] in T_CODES)):
                        rows.append([p[1], round(float(p[4]), 5), round(float(p[5]), 5), p[10], int(p[14] or 0),
                                     p[7], p[6]])
            cache.write_text(json.dumps(rows))
        rows = json.loads(cache.read_text())
        self.name = [r[0] for r in rows]
        self.lat = np.radians([r[1] for r in rows])
        self.lon = np.radians([r[2] for r in rows])
        self.admin1 = [r[3] for r in rows]
        self.pop = np.array([r[4] for r in rows])
        self.code = [r[5] for r in rows]
        self.is_p = np.array([r[6] == "P" for r in rows])

    def _nearest(self, lat: float, lon: float, mask: np.ndarray) -> dict:
        la, lo = math.radians(lat), math.radians(lon)
        d = 6371.0 * 2 * np.arcsin(np.sqrt(np.sin((self.lat - la) / 2) ** 2
                                           + math.cos(la) * np.cos(self.lat) * np.sin((self.lon - lo) / 2) ** 2))
        d = np.where(mask, d, np.inf)
        i = int(np.argmin(d))
        brg = math.degrees(math.atan2(math.sin(lo - self.lon[i]) * math.cos(la),
                                      math.cos(self.lat[i]) * math.sin(la)
                                      - math.sin(self.lat[i]) * math.cos(la) * math.cos(lo - self.lon[i]))) % 360
        dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
        return {"name": self.name[i], "dist_km": round(float(d[i]), 1), "dir": dirs[int((brg + 22.5) // 45) % 8],
                "pop": int(self.pop[i]), "admin1": self.admin1[i], "feature_code": self.code[i]}

    def nearest(self, lat: float, lon: float, min_pop: int = 0) -> dict:
        """Nearest populated place (optionally with population >= min_pop)."""
        return self._nearest(lat, lon, self.is_p & (self.pop >= min_pop))

    def feature(self, lat: float, lon: float) -> dict:
        """Nearest named terrain feature (hills, ridges, buttes, badlands, valleys...)."""
        return self._nearest(lat, lon, ~self.is_p)

    def label(self, lat: float, lon: float, feature_km: float = 7.5, min_pop: int = 500) -> str:
        """'<terrain feature> · <d> km <dir> of <town>' if a named feature lies within the window half-width,
        else '<d> km <dir> of <town>'; town = nearest populated place with population >= min_pop."""
        p = self.nearest(lat, lon, min_pop=min_pop)
        place = p["name"] if p["dist_km"] < 2 else f"{p['dist_km']:.0f} km {p['dir']} of {p['name']}"
        f = self.feature(lat, lon)
        if f["dist_km"] <= feature_km:
            return f"{f['name']} · {place}"
        return place
