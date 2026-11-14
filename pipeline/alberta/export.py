"""Assemble web/public/data/alberta/alberta.json and alberta_windows.geojson (schema:
docs/data-contract-alberta.md)."""
from __future__ import annotations

import json
import logging

import numpy as np

from pipeline.alberta import screen as S
from pipeline.alberta.common import WEB_AB, meta, write_json
from pipeline.alberta.geodata import TO_LL, WIN_M, ParkIndex, Places, fetch_parks
from pipeline.common.config import WEB_DATA

log = logging.getLogger("pipeline.alberta.export")

PARK_LABEL = "terrain comparison & visit — equipment testing not permitted without authorization"
NAMED_PARKS = ("Banff", "Jasper", "Waterton", "Elk Island", "Wood Buffalo", "Dinosaur", "Writing-on-Stone")
COMP_INFO = {   # component -> (label, alberta fp key, moon scalar key, unit, scale source)
    **{f"shadow_el{el}": (f"Shadowed azimuths at sun elevation {el}° (local horizon, 90 m)",
                          f"shadow_frac_local_el{el}", f"shadow_frac_el{el}_local", "frac", "moon_iqr") for el in S.EL},
    "jump1km": ("1 km height jump, P95 (rim / boulder-step proxy)", "jump1km_p95_m", "jump1km_p95_m", "m", "moon_iqr"),
    "frac_track_over_500m": ("Share of 1 km tracks with > 500 m height jump", "frac_track_over_500m",
                             "frac_track_over_500m", "frac", "global_iqr"),
    "slope": ("Median slope (90 m)", "slope_p50_deg", "slope_p50_deg", "deg", "moon_iqr"),
    **{f"nu_{L}": (f"Roughness ν({L} m), RMS height difference", f"nu_{L}", f"nu_{L}", "m", "global_iqr") for L in S.NU},
}
LIGHT = ((0.5, "green"), (1.5, "amber"), (float("inf"), "red"))


def _fmt(v: float, unit: str) -> str:
    if unit == "frac":
        return f"{100 * v:.1f} %"
    if unit == "deg":
        return f"{v:.1f}°"
    return f"{v:.0f} m" if abs(v) >= 10 else f"{v:.1f} m"


def lights(fp: dict, moon_r: dict, scal: dict, hazard: str) -> list[dict]:
    comps = S.components(fp, fp["q"], moon_r, scal)[hazard]
    ms = {**moon_r["scalars"], **moon_r["s"]}
    sc = S.moon_scales(moon_r)
    out = []
    for comp, term in comps:
        label, ak, mk, unit, src = COMP_INFO[comp]
        a, m = float(fp[ak]), float(ms[mk])
        if comp.startswith("shadow_el"):
            scale = sc["shadow"][int(comp[-1])]
        elif comp == "jump1km":
            scale = sc["jump"]
        elif comp == "slope":
            scale = sc["slope"]
        else:
            scale = scal[comp]
        light = next(name for thr, name in LIGHT if term <= thr)
        direction = "close to" if light == "green" else ("lower than" if a < m else "higher than")
        out.append({"component": comp, "label": label, "unit": unit, "moon": m, "alberta": a,
                    "scale": scale, "scale_source": "Moon IQR of the 101-quantile distribution" if src == "moon_iqr"
                    else "IQR over the global earth screen population",
                    "term": term, "light": light,
                    "gap": f"Alberta {_fmt(a, unit)} vs Moon {_fmt(m, unit)}: {direction} the Moon "
                           f"(distribution gap {term:.2f} × scale)"})
    return out


def _park_info(pidx: ParkIndex, w: dict):
    from shapely.geometry import box
    hits = pidx.overlaps(box(w["x0"], w["y1"] - WIN_M, w["x0"] + WIN_M, w["y1"]))
    named = sorted({n for h in hits for n in NAMED_PARKS if n.lower() in (h["name"] or "").lower()})
    return {"in_protected_area": bool(hits), "areas": hits[:5], "named_parks": named,
            "label": PARK_LABEL if hits else None,
            "status_source": "CPCAD (ECCC) polygons; overlap = share of the 15 km window"}


def _corners_ll(w: dict) -> list[list[float]]:
    xs = [w["x0"], w["x0"] + WIN_M, w["x0"] + WIN_M, w["x0"], w["x0"]]
    ys = [w["y1"], w["y1"], w["y1"] - WIN_M, w["y1"] - WIN_M, w["y1"]]
    lon, lat = TO_LL.transform(xs, ys)
    return [[round(float(a), 5), round(float(b), 5)] for a, b in zip(lon, lat)]


def export(win_doc: dict, fps: dict, dist: dict, refined: dict[str, dict], elapsed: dict) -> dict:
    rows = {r["id"]: r for r in win_doc["rows"]}
    moon = S.load_moon()
    regions = {r["id"]: r for r in json.loads((WEB_DATA / "regions.json").read_text())["regions"]}
    scal = dist["scalar_scales"]
    places = Places()
    pidx = ParkIndex(fetch_parks())
    D = dist["distances"]
    top_ids = sorted({t["id"] for s in dist["searches"].values() for t in s["top"]})

    sites = {}
    for wid in top_ids:
        w, fp, rf = rows[wid], fps[wid], refined.get(wid, {})
        ok = rf.get("status") == "ok"
        sites[wid] = {
            "id": wid, "name": places.label(w["lat"], w["lon"]),
            "nearest_town_1000": places.nearest(w["lat"], w["lon"], min_pop=1000),
            "nearest_place": places.nearest(w["lat"], w["lon"]),
            "nearest_terrain_feature": places.feature(w["lat"], w["lon"]),
            "lat": w["lat"], "lon": w["lon"], "frac_in_ab": w["frac_in_ab"],
            "window_3400": {"x0": w["x0"], "y1": w["y1"], "size_m": WIN_M},
            "worldcover": {k[3:]: v for k, v in w.items() if k.startswith("wc_")},
            "park": _park_info(pidx, w),
            "fingerprint_90m": {k: fp[k] for k in ("slope_p50_deg", "slope_p90_deg", "relief_m", "jump1km_p95_m",
                                                   "jump1km_p99_m", "frac_track_over_500m", "nu_180", "nu_360",
                                                   "nu_720", "nu_1440", "shadow_frac_local_el1",
                                                   "shadow_frac_local_el3", "shadow_frac_local_el5", "elev_mean_m")},
            "tile": None if not ok else {
                "path": f"alberta/{wid}.bin", "size": 500, "res_m": 30.0, "crs": f"EPSG:{rf['epsg']}",
                "origin_x": rf["origin_x"], "origin_y": rf["origin_y"],
                "origin_note": "top-left corner of pixel (0,0); row 0 = north (grid +y)",
                "true_north_grid_az_deg": rf["true_north_grid_az_deg"]},
            "hillshade": f"alberta/{wid}_hill.png" if ok else None,
            "metrics_30m": rf.get("metrics") if ok else None,
            "core_relief_m": rf.get("core_relief_m"),
        }

    from pipeline.metrics import HAZARD_KEYS
    searches, best = [], {}
    for key, s in dist["searches"].items():
        rid, hz = key.split("|")
        top = []
        for k, t in enumerate(s["top"]):
            m30 = sites[t["id"]]["metrics_30m"]
            moon30 = regions[rid]["hazards"][hz]["metrics"]
            top.append({"rank": k + 1, "id": t["id"], "distance": t["distance"],
                        "lights": lights(fps[t["id"]], moon[rid], scal, hz),
                        "metrics_30m_vs_moon": None if m30 is None else {
                            mk: {"moon": moon30.get(mk), "alberta": m30.get(mk)} for mk in HAZARD_KEYS[hz]}})
        entry = {"region": rid, "region_name": regions[rid]["name"], "hazard": hz, "n_eligible": s["n_eligible"],
                 "top": top}
        tv, tid = s.get("best_terrain_only") or (None, None)
        if tid is not None:
            tw = rows[tid]
            entry["terrain_only_best"] = {
                "id": tid, "distance": tv, "name": places.label(tw["lat"], tw["lon"]), "lat": tw["lat"],
                "lon": tw["lon"], "dsm_pass": tw["dsm_pass"], "fail": tw["fail"],
                "park_label": _park_info(pidx, tw)["label"], "named_parks": _park_info(pidx, tw)["named_parks"],
                "note": "closest window on terrain alone, ignoring the WorldCover DSM-safe filter (the 30 m "
                        "Copernicus DSM includes tree canopy, so this window is NOT eligible for comparison)"}
        g = s.get("global")
        if g:
            entry["global_screen"] = {
                "best_distance": g["distance"], "best_id": g["id"], "best_lat": g["lat"], "best_lon": g["lon"],
                "n_eligible": g["n_eligible"],
                "alberta_best_rank_among_global": g["alberta_best_rank_among_global"],
                "ratio_alberta_to_global": (top[0]["distance"] / g["distance"]) if top and g["distance"] > 0 else None,
                "note": "global earth stage-1 screen (90 m, DSM-safe, same distance & scales); rank = 1 + number of "
                        "global eligible windows strictly closer than Alberta's best"}
        searches.append(entry)
        if top and (hz not in best or top[0]["distance"] < best[hz]["distance"]):
            st = sites[top[0]["id"]]
            best[hz] = {"region": rid, "region_name": regions[rid]["name"], "id": top[0]["id"], "name": st["name"],
                        "lat": st["lat"], "lon": st["lon"], "distance": top[0]["distance"],
                        "park_label": st["park"]["label"], "named_parks": st["park"]["named_parks"],
                        "global_best_distance": (g or {}).get("distance")}

    cov = win_doc["coverage"]
    doc = {
        "meta": meta(["natural_earth", "worldcover", "copdem", "moon_fp", "cpcad", "geonames"], method={
            "tiling": "complete census: regular 15 x 15 km grid in EPSG:3400 (NAD83 / Alberta 10-TM Forest); every "
                      "cell intersecting the Natural Earth 1:10m Alberta polygon is a window",
            "landcover": "ESA WorldCover 2021 at COG overview level 3 (~160 m) resampled (nearest) to 150 m on the "
                         "window grid; DSM-safe rule tree<=0.10, built<=0.05, crop<=0.20, water<=0.20, "
                         "wetland+mangrove<=0.10, snow/ice<0.30, valid land>=0.5 (same as earth stage)",
            "fingerprint": "pipeline.earth.fingerprint.fingerprint_dem on GLO-90 (15.03 km core + 15 km buffer, local "
                           "UTM, centred on the window centre); identical to the global screen; shadow is the LOCAL "
                           "proxy shadow_frac_local_el* (window + buffer only, no far field)",
            "distance": S.__doc__.split("Distance")[1].strip() if "Distance" in (S.__doc__ or "") else "",
            "scalar_scales": scal, "scalar_scales_source": dist["scalar_scales_source"],
            "refine": "top 5 per region x hazard re-run at 30 m: GLO-30 core 500x500 + 15 km buffer, GLO-90 far field "
                      "at 180 m to <= 150 km, R_eff = 7/6 R_earth, compute_all (same as earth stage 2)",
            "names": "GeoNames: '<named terrain feature (class T) within 7.5 km> · <d> km <dir> of <nearest "
                     "populated place with population >= 500>'",
            "parks": "CPCAD park-type polygons (national/provincial/wildland parks, wilderness and natural areas, "
                     "ecological reserves, heritage rangelands, recreation areas); any overlap >= 1 % of a window "
                     "sets park.label"}, elapsed_s=elapsed),
        "coverage": {"n_windows": cov["n_windows"], "n_pass": cov["n_pass"], "pct_area_pass": cov["pct_area_pass"],
                     "province_km2": cov["province_km2"], "pct_province_covered": cov["pct_covered"],
                     "tiled_km2": cov["tiled_km2"], "fail_reason_counts": cov["fail_reason_counts"],
                     "n_fingerprinted": sum(1 for f in fps.values() if f.get("status") == "ok"),
                     "n_eligible": dist["n_eligible"]},
        "best_per_hazard": best,
        "searches": searches,
        "sites": sites,
    }
    write_json(WEB_AB / "alberta.json", doc)
    _geojson(rows, fps, D, places, pidx)
    return doc


def _geojson(rows: dict, fps: dict, D: dict, places: Places, pidx: ParkIndex) -> None:
    feats = []
    for wid, w in rows.items():
        per_h = {}
        for key, d in D.items():
            hz = key.split("|")[1]
            v = d.get(wid)
            if v is not None and np.isfinite(v):
                if hz not in per_h or v < per_h[hz][0]:
                    per_h[hz] = (v, key.split("|")[0])
        elig = S.eligible(w, fps.get(wid))
        allv = [(v, h, r) for h, (v, r) in per_h.items()]
        bd = min(allv) if allv else None
        pk = _park_info(pidx, w)
        feats.append({"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [_corners_ll(w)]},
                      "properties": {
                          "id": wid, "name": places.label(w["lat"], w["lon"]), "lat": round(w["lat"], 5),
                          "lon": round(w["lon"], 5), "pass": bool(w["dsm_pass"]), "eligible": elig,
                          "fail": ",".join(w["fail"]), "frac_in_ab": w["frac_in_ab"],
                          "best_distance": round(bd[0], 4) if bd and elig else None,
                          "best_distance_terrain_only": round(bd[0], 4) if bd else None,
                          "best_hazard": bd[1] if bd else None, "best_region": bd[2] if bd else None,
                          **{f"d_{h}": round(per_h[h][0], 4) if h in per_h else None for h in S.HAZ},
                          "in_protected_area": pk["in_protected_area"],
                          "wc_tree": w["wc_tree"], "wc_crop": w["wc_crop"], "wc_grass": w["wc_grass"],
                          "wc_bare": w["wc_bare"]}})
    doc = {"type": "FeatureCollection", "meta": meta(["natural_earth", "worldcover", "copdem", "cpcad", "geonames"]),
           "features": feats}
    write_json(WEB_AB / "alberta_windows.geojson", doc)
