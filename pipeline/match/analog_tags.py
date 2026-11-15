"""Tags for the Earth analog list on the Summary page: protected areas and new-vs-known.

    python -m pipeline.match.analog_tags [--force]

Reads web/public/data/matches.json (the sites that win a top-3 slot) and writes
web/public/data/analog_tags.json.

Protected areas: each site's centre point and its 15 km square are tested against the World Database on Protected
and Conserved Areas (UNEP-WCMC and IUCN, Protected Planet) through its public ArcGIS polygon layer. Answers are
cached in data/interim/match/wdpa_cache.json, so reruns are offline; --force asks again.

New vs known: the team's catalogue-and-literature check (14 Nov 2026) sorted the 57 sites into four groups.
The group counts are recorded below. The per-site groups are read from data/novelty_check.csv
(columns: site_id,group with group one of established|near_known|studied_region|new) when that file exists;
until then each site's novelty is null and the page shows the counts only.
"""
from __future__ import annotations

import argparse
import csv
import logging
import math
import time

import requests

from pipeline.match.common import INTERIM, MATCHES_JSON, ROOT, WEB_DATA, make_meta, read_json, setup_logging, write_json

log = logging.getLogger("pipeline.match.analog_tags")

OUT_JSON = WEB_DATA / "analog_tags.json"
CACHE = INTERIM / "wdpa_cache.json"
NOVELTY_CSV = ROOT / "data" / "novelty_check.csv"
WDPA_POLY = ("https://data-gis.unep-wcmc.org/server/rest/services/ProtectedSites/"
             "The_World_Database_of_Protected_Areas/MapServer/1/query")
FIELDS = "site_id,name_eng,desig_eng,iucn_cat,iso3,status,site_type"
HALF_KM = 7.5  # half the 15 km site square

GROUPS = ("established", "near_known", "studied_region", "new")
# Team novelty check, 14 Nov 2026 (catalogues: USGS TADP, USGS PAAD, NASA Planetary Analog Explorer,
# data/analogs/known_analogs.json, plus a literature search). Same figures as the pitch.
TEAM_COUNTS = {"established": 9, "near_known": 8, "studied_region": 7, "new": 33}

SOURCES = [
    {"name": "World Database on Protected and Conserved Areas (WDPCA), polygon layer",
     "url": "https://www.protectedplanet.net/",
     "licence": "WDPA Terms of Use (non-commercial, attribution): https://www.protectedplanet.net/en/legal",
     "citation": "UNEP-WCMC and IUCN (2026), Protected Planet: The World Database on Protected and Conserved Areas "
                 "(WDPCA) [On-line], November 2026, Cambridge, UK: UNEP-WCMC and IUCN. www.protectedplanet.net"},
    {"name": "Analog novelty check (this project's pipeline team review)", "url": "",
     "licence": "n/a",
     "citation": "Team Kinetic, 14 Nov 2026: USGS TADP, USGS PAAD, NASA Planetary Analog Explorer, "
                 "data/analogs/known_analogs.json and a literature search."},
]


def _query(geometry: str, geometry_type: str) -> list[dict]:
    params = {"geometry": geometry, "geometryType": geometry_type, "inSR": "4326",
              "spatialRel": "esriSpatialRelIntersects", "outFields": FIELDS, "returnGeometry": "false", "f": "json"}
    for attempt in range(4):
        try:
            r = requests.get(WDPA_POLY, params=params, timeout=60)
            r.raise_for_status()
            doc = r.json()
            if "error" in doc:
                raise RuntimeError(doc["error"])
            return [f["attributes"] for f in doc.get("features", [])]
        except Exception as e:  # noqa: BLE001
            log.warning("WDPA query failed (%s), retry %d", e, attempt + 1)
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"WDPA query failed for {geometry}")


def _square(lat: float, lon: float) -> str:
    dlat = HALF_KM / 111.32
    dlon = HALF_KM / (111.32 * max(math.cos(math.radians(lat)), 1e-6))
    return f"{lon - dlon},{lat - dlat},{lon + dlon},{lat + dlat}"


def _area(a: dict) -> dict:
    return {"wdpa_id": a.get("site_id"), "name": a.get("name_eng"), "designation": a.get("desig_eng"),
            "iucn": a.get("iucn_cat"), "iso3": a.get("iso3"), "status": a.get("status"), "type": a.get("site_type")}


def _novelty_per_site(site_ids: set[str]) -> dict[str, str]:
    if not NOVELTY_CSV.exists():
        log.info("no %s yet: per-site novelty left null", NOVELTY_CSV.relative_to(ROOT))
        return {}
    out: dict[str, str] = {}
    with NOVELTY_CSV.open(newline="") as f:
        for row in csv.DictReader(f):
            sid, g = row["site_id"].strip(), row["group"].strip()
            if g not in GROUPS:
                raise ValueError(f"{NOVELTY_CSV.name}: unknown group {g!r} for {sid}")
            out[sid] = g
    unknown = set(out) - site_ids
    if unknown:
        log.warning("%s lists sites that are not in matches.json: %s", NOVELTY_CSV.name, sorted(unknown))
    return {k: v for k, v in out.items() if k in site_ids}


def run(force: bool = False) -> dict:
    matches = read_json(MATCHES_JSON)["matches"]
    sites: dict[str, dict] = {}
    for m in matches:
        sites.setdefault(m["site_id"], {"lat": m["lat"], "lon": m["lon"], "name": m["site_name"]})
    cache = {} if force or not CACHE.exists() else read_json(CACHE)

    tags: dict[str, dict] = {}
    for sid, s in sorted(sites.items()):
        key = f"{sid}:{s['lat']:.5f}:{s['lon']:.5f}"
        if key not in cache:
            centre = _query(f"{s['lon']},{s['lat']}", "esriGeometryPoint")
            square = _query(_square(s["lat"], s["lon"]), "esriGeometryEnvelope")
            cache[key] = {"centre": centre, "square": square}
            write_json(CACHE, cache)
            time.sleep(0.3)
        c = cache[key]
        centre_ids = {a["site_id"] for a in c["centre"]}
        areas = [{**_area(a), "covers_centre": a["site_id"] in centre_ids} for a in c["square"]]
        # the centre test catches parks the envelope query missed (it should not happen, but stay safe)
        areas += [{**_area(a), "covers_centre": True} for a in c["centre"] if a["site_id"] not in {x["wdpa_id"] for x in areas}]
        tags[sid] = {"protected": {"centre_inside": bool(centre_ids), "square_overlaps": bool(areas), "areas": areas},
                     "novelty": None}

    per_site = _novelty_per_site(set(sites))
    for sid, g in per_site.items():
        tags[sid]["novelty"] = g
    counts = TEAM_COUNTS
    if per_site:
        counts = {g: sum(1 for v in per_site.values() if v == g) for g in GROUPS}
        if len(per_site) != len(sites) or counts != TEAM_COUNTS:
            log.warning("per-site novelty %s (%d sites) differs from the team counts %s", counts, len(per_site), TEAM_COUNTS)

    n_inside = sum(t["protected"]["centre_inside"] for t in tags.values())
    n_touch = sum(t["protected"]["square_overlaps"] for t in tags.values())
    doc = {
        "meta": make_meta(SOURCES, notes=[
            "protected.centre_inside: the site's centre point lies inside a WDPCA polygon; square_overlaps: any part "
            "of its 15 km square does. Point-only WDPCA records (no boundary) are not tested.",
            "novelty groups: established = an analog already studied at this place; near_known = 50-100 km from one; "
            "studied_region = inside a region studied as an analog; new = no prior analog study found in the "
            "catalogues and literature checked.",
        ]),
        "n_sites": len(sites),
        "novelty": {"counts": counts, "total": sum(counts.values()), "per_site_available": bool(per_site),
                    "checked": "USGS TADP, USGS PAAD, NASA Planetary Analog Explorer, 89 catalogued analogs and a "
                               "literature search (14 Nov 2026)"},
        "protected": {"n_centre_inside": n_inside, "n_square_overlaps": n_touch},
        "sites": tags,
    }
    write_json(OUT_JSON, doc)
    log.info("%d sites: %d with centre in a protected area, %d touching one; per-site novelty %s",
             len(sites), n_inside, n_touch, "yes" if per_site else "not yet")
    return doc


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--force", action="store_true", help="ask the WDPCA service again instead of using the cache")
    args = ap.parse_args()
    setup_logging()
    run(force=args.force)


if __name__ == "__main__":
    main()
