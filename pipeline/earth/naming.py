"""Offline names for screened windows: nearest GeoNames populated place (cities1000, CC-BY 4.0).

Name format: "<distance> km <bearing> of <place>" (or "near <place>" within 5 km); country is the
nearest place's country (approximate for windows close to borders).
"""
from __future__ import annotations

import csv
import logging
import math
from functools import lru_cache

import numpy as np
from scipy.spatial import cKDTree

from pipeline.earth.common import RAW

log = logging.getLogger("pipeline.earth.naming")

GEONAMES_DIR = RAW / "geonames"
SOURCE = {"name": "GeoNames cities1000", "url": "https://download.geonames.org/export/dump/",
          "licence": "CC-BY 4.0", "citation": "GeoNames geographical database (geonames.org), CC-BY 4.0"}
_BEARINGS = ("N", "NE", "E", "SE", "S", "SW", "W", "NW")


def _xyz(lat, lon):
    la, lo = np.radians(lat), np.radians(lon)
    return np.c_[np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)]


@lru_cache(maxsize=1)
def _index():
    countries = {}
    with open(GEONAMES_DIR / "countryInfo.txt", encoding="utf-8") as fh:
        for line in fh:
            if line.startswith("#") or not line.strip():
                continue
            p = line.rstrip("\n").split("\t")
            countries[p[0]] = p[4]
    names, cc, lats, lons = [], [], [], []
    with open(GEONAMES_DIR / "cities1000.txt", encoding="utf-8") as fh:
        for p in csv.reader(fh, delimiter="\t", quoting=csv.QUOTE_NONE):
            names.append(p[2] or p[1])
            cc.append(p[8])
            lats.append(float(p[4]))
            lons.append(float(p[5]))
    lats, lons = np.array(lats), np.array(lons)
    return cKDTree(_xyz(lats, lons)), names, cc, lats, lons, countries


def nearest_place(lat: float, lon: float) -> dict:
    tree, names, cc, lats, lons, countries = _index()
    _, i = tree.query(_xyz(np.array([lat]), np.array([lon]))[0])
    i = int(i)
    plat, plon = lats[i], lons[i]
    # great-circle distance and bearing from the place to the window
    p1, p2 = math.radians(plat), math.radians(lat)
    dl = math.radians(lon - plon)
    d_km = 6371.0 * math.acos(min(1.0, max(-1.0, math.sin(p1) * math.sin(p2) + math.cos(p1) * math.cos(p2) * math.cos(dl))))
    brg = math.degrees(math.atan2(math.sin(dl) * math.cos(p2),
                                  math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl))) % 360
    b = _BEARINGS[int(((brg + 22.5) % 360) // 45)]
    place = names[i]
    country = countries.get(cc[i], cc[i])
    name = f"near {place}" if d_km < 5 else f"{d_km:.0f} km {b} of {place}"
    return {"name": name, "country": country, "place": place, "place_km": round(d_km, 1), "bearing": b}


# ----------------------------------------------------------------------------- admin lookup
NE_DIR = RAW / "naturalearth"
NE_SOURCE = {"name": "Natural Earth 1:10m admin-0 / admin-1", "url": "https://www.naturalearthdata.com/",
             "licence": "public domain", "citation": "Made with Natural Earth. Free vector and raster map data."}


@lru_cache(maxsize=2)
def _admin(level: int):
    import json as _json
    from shapely.geometry import shape
    from shapely.strtree import STRtree
    fn = "ne_10m_admin_0_countries.geojson" if level == 0 else "ne_10m_admin_1_states_provinces.geojson"
    gj = _json.loads((NE_DIR / fn).read_text(encoding="utf-8"))
    geoms, props = [], []
    for f in gj["features"]:
        if not f.get("geometry"):
            continue
        geoms.append(shape(f["geometry"]))
        p = f["properties"]
        props.append({"name": p.get("NAME_EN") or p.get("NAME") or p.get("name_en") or p.get("name") or p.get("ADMIN"),
                      "admin": p.get("ADMIN") or p.get("admin")})
    return STRtree(geoms), geoms, props


def admin_lookup(lat: float, lon: float) -> dict:
    """Country (admin-0) and admin-1 containing the point (nearest polygon within ~25 km if none)."""
    from shapely.geometry import Point
    pt = Point(lon, lat)
    out = {"country": None, "admin1": None}
    for level, key in ((0, "country"), (1, "admin1")):
        tree, geoms, props = _admin(level)
        hits = [int(i) for i in tree.query(pt) if geoms[int(i)].contains(pt)]
        if not hits:
            i = int(tree.nearest(pt))
            if geoms[i].distance(pt) < 0.25:
                hits = [i]
        if hits:
            out[key] = props[hits[0]]["name"]
            if level == 1 and not out["country"]:
                out["country"] = props[hits[0]]["admin"]
    return out


def site_label(lat: float, lon: float) -> dict:
    """name (nearest place), country (point-in-polygon), region_label (admin-1, country) when remote."""
    np_ = nearest_place(lat, lon)
    ad = admin_lookup(lat, lon)
    country = ad["country"] or np_["country"]
    out = {"name": np_["name"], "country": country, "admin1": ad["admin1"], "place_km": np_["place_km"]}
    if np_["place_km"] > 100:
        out["region_label"] = f"{ad['admin1']}, {country}" if ad["admin1"] and ad["admin1"] != country else country
    return out
