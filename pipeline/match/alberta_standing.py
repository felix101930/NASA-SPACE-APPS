"""Where Alberta's 30 m sites would stand among the sites measured in detail worldwide.

    python -m pipeline.match.alberta_standing

Scores every Alberta site that has a 30 m tile (web/public/data/alberta/<id>.bin, built by
pipeline/alberta/refine.py with the same construction as the Earth stage 2) with the final-round matcher
(pipeline.match.matches: same terms, weights, Moon IQR scales, shape and brightness features), for every
region x danger. Each score is ranked against

  - all sites measured in detail at 30 m (earth_sites.json: search candidates, documented analogs and
    validation sites) that have that search's core terms, and
  - the sites that won a top-3 slot in matches.json (the "57 picks").

A rank is 1 + the number of sites strictly closer. Alberta sites are not added to the candidate pool, so
this is where they *would* stand; matches.json is unchanged.

Writes web/public/data/alberta/standing.json. The Alberta sites' shape and brightness features are cached
in data/interim/match/alberta_feats.json (the Earth feature cache is never written).
"""
from __future__ import annotations

import logging

import numpy as np

from pipeline.match import earth_feats, moon_ref
from pipeline.match import matches as MM
from pipeline.match.common import EARTH_SITES_JSON, INTERIM, MATCHES_JSON, WEB_DATA, make_meta, read_json, setup_logging, write_json

log = logging.getLogger("pipeline.match.alberta_standing")

ALBERTA_JSON = WEB_DATA / "alberta" / "alberta.json"
OUT_JSON = WEB_DATA / "alberta" / "standing.json"
AB_FEATS_CACHE = INTERIM / "alberta_feats.json"


def _alberta_sites() -> list[dict]:
    ab = read_json(ALBERTA_JSON)["sites"]
    return [{"id": k, "name": v["name"], "lat": v["lat"], "lon": v["lon"], "tile": {"path": v["tile"]["path"]},
             "metrics": v["metrics_30m"]}
            for k, v in sorted(ab.items())
            if v.get("metrics_30m") and str(v.get("tile", {}).get("path", "")).endswith(".bin")]


def _alberta_feats(sites: list[dict]) -> dict[str, dict]:
    earth_cache = earth_feats.CACHE
    earth_feats.CACHE = AB_FEATS_CACHE
    try:
        return earth_feats.load(sites)
    finally:
        earth_feats.CACHE = earth_cache


def run() -> dict:
    mref = moon_ref.load()
    earth_doc = read_json(EARTH_SITES_JSON)
    sites = earth_doc["sites"]
    feats = earth_feats.load(sites)
    table = MM.build_table(mref, sites, feats)
    match_rows = read_json(MATCHES_JSON)["matches"]
    picked = {m["site_id"] for m in match_rows}

    ab_sites = _alberta_sites()
    ab_feats = _alberta_feats(ab_sites)
    rows = []
    for s in ab_sites:
        for rid in mref:
            terms = MM.site_terms(mref[rid], s, ab_feats.get(s["id"]))
            for h in MM.HAZARDS:
                e = table[f"{rid}|{h}"]
                d_all = MM.combine(e, MM.TERM_WEIGHTS[h])
                one = {"D": np.array([[terms[h].get(t, np.nan) for t in e["terms"]]], float), "terms": e["terms"]}
                d = float(MM.combine(one, MM.TERM_WEIGHTS[h])[0])
                fin = [(float(d_all[i]), sid) for i, sid in enumerate(e["site_ids"]) if np.isfinite(d_all[i])]
                p57 = [x for x in fin if x[1] in picked]
                best = min((m for m in match_rows if m["region_id"] == rid and m["hazard"] == h),
                           key=lambda m: m["distance"], default=None)
                rows.append({
                    "site_id": s["id"], "region_id": rid, "hazard": h,
                    "distance": round(d, 4) if np.isfinite(d) else None,
                    "rank_measured": 1 + sum(1 for x, _ in fin if x < d) if np.isfinite(d) else None,
                    "n_measured": len(fin),
                    "rank_picks": 1 + sum(1 for x, _ in p57 if x < d) if np.isfinite(d) else None,
                    "n_picks": len(p57),
                    "world_best_distance": best["distance"] if best else None,
                    "world_best_site": best["site_id"] if best else None,
                    "missing_terms": [t for t in e["terms"] if not np.isfinite(terms[h].get(t, np.nan))],
                })
    n_by = {}
    for s in sites:
        n_by[s.get("selected_by")] = n_by.get(s.get("selected_by"), 0) + 1
    doc = {
        "meta": make_meta(read_json(ALBERTA_JSON).get("meta", {}).get("sources", []), notes=[
            "distance: final-round (30 m) hazard distance in Moon-region IQR units; < 0.5 close, < 1.5 partial.",
            "rank_measured: 1 + number of the sites measured in detail (earth_sites.json) strictly closer in the "
            "same region x danger; rank_picks: the same among the sites in matches.json.",
            "Alberta sites are scored, not added to the candidate pool: this is where they would stand.",
        ]),
        "n_measured_sites": len(sites),
        "measured_by": n_by,
        "n_pick_sites": len(picked),
        "sites": {s["id"]: {"name": s["name"], "lat": s["lat"], "lon": s["lon"]} for s in ab_sites},
        "rows": rows,
    }
    write_json(OUT_JSON, doc)
    k = [r for r in rows if r["site_id"] == "AB_073_027" and r["region_id"] == "mons_mouton_plateau"]
    for r in k:
        log.info("Kohler Coulee vs Mons Mouton Plateau %s: distance %.3f, #%s of %d measured, #%s of %d picks",
                 r["hazard"], r["distance"], r["rank_measured"], r["n_measured"], r["rank_picks"], r["n_picks"])
    return doc


def main() -> None:
    setup_logging()
    run()


if __name__ == "__main__":
    main()
