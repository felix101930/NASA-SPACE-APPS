"""Moon walks in Calgary: City pathway routes profiled on the NRCan lidar DTM, with transit access and
Calgary Equity Index context, plus preset Moon-route -> Calgary-walk matches (banded DTW).

Outputs (web/public/data/calgary/, schema in docs/data-contract-alberta.md):
- walks.bin  Float32 LE [N, 100] signed slope profiles (deg, + = climbing in the direction of travel)
- walks.json route metadata (row i of walks.bin = items[i])
- calgary_overlays.geojson Equity Index tracts (Accessibility & Amenities domain) for a choropleth
- presets.json 2 Moon routes per region (gentle, steeper) and their best Calgary matches

Geometry is handled in EPSG:3979 (the DTM's CRS). Its scale factor at Calgary is K = 0.99256, so
true ground distance = map distance / K; all lengths and slopes below use true distances.
Walks are reversible; each route is oriented so its start is the end nearer an ACTIVE transit stop.
"""
from __future__ import annotations

import json
import logging
import math
import time

import numpy as np
from pyproj import Proj, Transformer
from scipy.spatial import cKDTree
from shapely import STRtree
from shapely.geometry import LineString, Point, shape

from pipeline.alberta import calgary_data as C
from pipeline.alberta import routes as R
from pipeline.alberta.common import WEB_YYC, meta, write_json
from pipeline.common.config import WEB_DATA
from pipeline.metrics.profile import sample_profile

log = logging.getLogger("pipeline.alberta.calgary_walks")

SEED = 20261114
MAX_ROUTES = 5000
MIN_M, MAX_M = 500.0, 3000.0
STEP_M = 5.0
N_PTS = 100
MAX_SLOPE_DEG = 20.0          # steeper 100-pt slope on a City pathway = DTM artifact or stairs -> dropped
GAP_M = 20.0                  # dangling pathway ends joined to the nearest pathway within 20 m (street crossings)
OVERLAP_MAX = 0.7             # max share of a route's length on edges of any single accepted route
STOP_NEAR_M = 400.0
# Calgary Equity Index 2024: "When interpreting the total equity score and domain scores, a higher score means
# greater inequities and needs and more barriers to equity" (https://www.calgary.ca/research/calgary-equity-index.html).
# The tie-break therefore prefers the Highest / High categories (greatest need).
CEI_SOURCE = "https://www.calgary.ca/research/calgary-equity-index.html"
CEI_QUOTE = ("When interpreting the total equity score and domain scores, a higher score means greater inequities "
             "and needs and more barriers to equity")
CAT_RANK = {"Highest": 0, "High": 1, "Moderate": 2, "Low": 3, "Lowest": 4}
TO_MAP = Transformer.from_crs("EPSG:4326", C.DTM_CRS, always_xy=True)
TO_LL = Transformer.from_crs(C.DTM_CRS, "EPSG:4326", always_xy=True)
K = float(Proj(C.DTM_CRS).get_factors(-114.07, 51.05).meridional_scale)

NOTES = (
    "Moon south-pole terrain is mostly steeper than city paths: the 9 Artemis III candidate regions have "
    "median slopes of roughly 7-18 deg at 30 m, while City of Calgary pathways rarely exceed ~5 deg over a "
    "30 m step. Calgary walks reproduce the gentler traverse segments of a Moon route (the rhythm of climbs "
    "and descents), not the hazard itself. They are for outreach and education, not mission or equipment "
    "testing. Profiles come from the NRCan 2020 lidar bare-earth DTM read at 4 m; pathways on bridges and "
    "overpasses are bridged by interpolation (bridge_repaired). Transit and Equity Index fields are context "
    "for choosing where to run public walks; they are not accessibility certifications. Equity Index direction: "
    "the City states \"" + CEI_QUOTE + "\" (" + CEI_SOURCE + "); access_domain_score and access_category therefore "
    "measure NEED (Highest = greatest barriers), and the preset tie-break favours Highest/High tracts. In the 2024 "
    "data this domain is anti-correlated with the index's Transit Score (Spearman -0.83) and Walk Score (-0.88): "
    "the highest-need tracts for access & amenities are mostly newer outer suburbs with weak transit and walkability."
)


def _proj_lines(coords_ll: list) -> np.ndarray:
    a = np.asarray(coords_ll, float)
    x, y = TO_MAP.transform(a[:, 0], a[:, 1])
    return np.c_[x, y]


class PolyIndex:
    """Point-in-polygon lookup over lon/lat features."""

    def __init__(self, feats: list[dict], key):
        self.geoms, self.props = [], []
        for f in feats:
            if f.get("geometry"):
                g = shape(f["geometry"]).buffer(0)
                if not g.is_empty:
                    self.geoms.append(g)
                    self.props.append(key(f))
        self.tree = STRtree(self.geoms)

    def lookup(self, lon: float, lat: float):
        p = Point(lon, lat)
        for i in self.tree.query(p):
            if self.geoms[int(i)].contains(p):
                return self.props[int(i)]
        return None


def _nice(name: str | None) -> str | None:
    if not name:
        return None
    return " ".join(w.capitalize() for w in name.split())


def build_network() -> tuple[R.Graph, PolyIndex]:
    parks = PolyIndex(C.park_sites(), lambda f: _nice(f["properties"].get("site_name")))
    lines = []
    for f in C.pathways():
        p = f["properties"]
        if p.get("life_cycle_status") == "PLANNED" or (p.get("operational") or "OPEN") != "OPEN":
            continue
        for part in f["geometry"]["coordinates"]:
            if len(part) < 2:
                continue
            xy = _proj_lines(part)
            mid = part[len(part) // 2]
            park = parks.lookup(mid[0], mid[1])
            w = (3.0 if p.get("asset_type") == "REGIONAL" else 1.0) * (2.0 if park else 1.0)
            lines.append((xy, {"regional": p.get("asset_type") == "REGIONAL", "park": park, "weight": w}))
    n0 = len(lines)
    lines = R.node_lines(lines, R.SNAP_M, GAP_M, {"regional": False, "park": None, "weight": 0.5,
                                                 "connector": True})
    log.info("noding: %d line parts -> %d edges", n0, len(lines))
    g = R.build_graph(lines)
    lab = R.components(g)
    sizes = np.bincount(lab)
    log.info("pathway graph: %d edges, %d nodes, %d components (largest %d nodes)",
             len(g.edges), len(g.xy), len(sizes), sizes.max())
    return g, parks


def generate_routes(g: R.Graph, rng: np.random.Generator, n_max: int = MAX_ROUTES,
                    max_attempts: int = 80_000) -> list[tuple[list[int], np.ndarray]]:
    """Seeded chains of true length MIN_M..MAX_M with limited overlap between routes."""
    lens = np.array([e["length"] for e in g.edges])
    p = np.array([e["weight"] for e in g.edges]) * lens
    p /= p.sum()
    edge_routes: dict[int, list[int]] = {}
    out = []
    for _ in range(max_attempts):
        if len(out) >= n_max:
            break
        target = rng.uniform(MIN_M, MAX_M) * K       # map metres
        res = R.random_chain(g, rng, int(rng.choice(len(g.edges), p=p)), target, MIN_M * K)
        if res is None:
            continue
        seq, xy = res
        xy = R.trim_polyline(xy, MAX_M * K)
        tot = sum(lens[e] for e in seq)
        shared: dict[int, float] = {}
        for e in seq:
            for rid in edge_routes.get(e, ()):
                shared[rid] = shared.get(rid, 0.0) + lens[e]
        if shared and max(shared.values()) / tot > OVERLAP_MAX:
            continue
        for e in seq:
            edge_routes.setdefault(e, []).append(len(out))
        out.append((seq, xy))
    log.info("routes generated: %d", len(out))
    return out


def transit_index() -> tuple[cKDTree, list[dict]]:
    by_stop: dict[str, set] = {}
    for r in C.stops_by_route():
        if r.get("status", "ACTIVE") == "ACTIVE" and r.get("teleride_number"):
            by_stop.setdefault(r["teleride_number"], set()).add(
                f"{r.get('route_short_name', '')} {r.get('route_long_name', '')}".strip())
    st = [s for s in C.stops() if s.get("status") == "ACTIVE" and s.get("point")]
    ll = np.array([s["point"]["coordinates"] for s in st], float)
    x, y = TO_MAP.transform(ll[:, 0], ll[:, 1])
    info = [{"name": s.get("stop_name"), "stop_id": s.get("teleride_number"),
             "routes": sorted(by_stop.get(s.get("teleride_number"), set()))} for s in st]
    return cKDTree(np.c_[x, y]), info


def equity_index() -> tuple[PolyIndex, dict[str, dict], list[dict]]:
    eq = C.equity()
    vals: dict[str, dict] = {}
    for key, feats in eq.items():
        for f in feats:
            p = f["properties"]
            d = vals.setdefault(p["CENSUSTRACT"], {"name": p["NAME"], "communities": p.get("COMMUNITIES")})
            try:
                d[key] = float(p["INDICATOR_VALUE"])
            except (TypeError, ValueError):
                d[key] = None
            if key == "access_domain":
                d["access_category"] = p.get("EQUITY_CATEGORY")
    idx = PolyIndex(eq["access_domain"], lambda f: f["properties"]["CENSUSTRACT"])
    return idx, vals, eq["access_domain"]


def _simplify_ll(xy_map: np.ndarray, max_pts: int = 50) -> list[list[float]]:
    line = LineString(xy_map)
    tol = 2.0
    s = line.simplify(tol)
    while len(s.coords) > max_pts:
        tol *= 1.6
        s = line.simplify(tol)
    c = np.asarray(s.coords)
    lon, lat = TO_LL.transform(c[:, 0], c[:, 1])
    return [[round(float(a), 6), round(float(b), 6)] for a, b in zip(lat, lon)]


def profile_route(dtm: np.ndarray, origin: tuple[float, float], xy: np.ndarray) -> dict:
    """5 m DTM samples -> bridge repair -> 100-point slope profile + stats (true distances)."""
    seg = np.hypot(*np.diff(xy, axis=0).T)
    length = float(seg.sum()) / K
    n5 = max(int(round(length / STEP_M)) + 1, 3)
    pr = sample_profile(dtm, C.DTM_RES, origin, xy, n=n5)
    h5 = np.asarray(pr["h_m"], float)
    if not np.isfinite(h5).all():
        return {"ok": False, "why": "nodata"}
    h5, nfix = R.repair_bridges(h5, length / (n5 - 1))
    h100, slope = R.profile_100(h5, length, N_PTS)
    grade = np.abs(np.tan(np.radians(slope))) * 100.0
    dh = np.diff(h100)
    return {"ok": bool(np.abs(slope).max() <= MAX_SLOPE_DEG), "why": "steep_artifact", "length_m": length,
            "slope": slope.astype(np.float32), "climb_m": float(dh[dh > 0].sum()),
            "descent_m": float(-dh[dh < 0].sum()), "max_grade_pct": float(grade.max()),
            "mean_grade_pct": float(grade.mean()), "mean_abs_slope_deg": float(np.abs(slope).mean()),
            "bridge_repaired": nfix > 0, "elev_start_m": float(h100[0])}


def build_walks(force: bool = False) -> dict:
    out_json = WEB_YYC / "walks.json"
    if out_json.exists() and (WEB_YYC / "walks.bin").exists() and not force:
        return json.loads(out_json.read_text())
    t0 = time.time()
    g, _ = build_network()
    rng = np.random.default_rng(SEED)
    chains = generate_routes(g, rng)
    allx = np.vstack([xy for _, xy in chains])
    dtm, tr = C.dtm((allx[:, 0].min() - 200, allx[:, 1].min() - 200, allx[:, 0].max() + 200, allx[:, 1].max() + 200))
    origin = (tr.c, tr.f)
    stree, sinfo = transit_index()
    tidx, tvals, _ = equity_index()
    items, profiles, dropped = [], [], {"nodata": 0, "steep_artifact": 0}
    for seq, xy in chains:
        d0, i0 = stree.query(xy[0])
        d1, i1 = stree.query(xy[-1])
        if d1 < d0:
            xy, d0, i0 = xy[::-1].copy(), d1, i1
        pr = profile_route(dtm, origin, xy)
        if not pr["ok"]:
            dropped[pr["why"]] += 1
            continue
        mid = R.trim_polyline(xy, float(np.hypot(*np.diff(xy, axis=0).T).sum()) / 2)[-1]
        mlon, mlat = TO_LL.transform(mid[0], mid[1])
        tract_id = tidx.lookup(mlon, mlat)
        tv = tvals.get(tract_id) if tract_id else None
        parks = [g.edges[e]["park"] for e in seq if g.edges[e]["park"]]
        lens = [g.edges[e]["length"] for e in seq]
        reg = sum(l for e, l in zip(seq, lens) if g.edges[e]["regional"]) / sum(lens)
        items.append({
            "id": f"YYC{len(items):05d}", "row": len(items), "coords": _simplify_ll(xy),
            "park": max(set(parks), key=parks.count) if parks else None,
            "length_m": round(pr["length_m"], 1), "climb_m": round(pr["climb_m"], 1),
            "descent_m": round(pr["descent_m"], 1), "max_grade_pct": round(pr["max_grade_pct"], 2),
            "mean_grade_pct": round(pr["mean_grade_pct"], 2),
            "mean_abs_slope_deg": round(pr["mean_abs_slope_deg"], 3), "regional_frac": round(reg, 3),
            "bridge_repaired": pr["bridge_repaired"],
            "near_stop": {**sinfo[int(i0)], "dist_m": round(float(d0) / K, 1)},
            "tract": None if tv is None else {
                "ctuid": tract_id, "name": tv["name"], "communities": tv.get("communities"),
                "access_domain_score": tv.get("access_domain"), "access_category": tv.get("access_category"),
                "transit_score": tv.get("transit_score"), "walk_score": tv.get("walk_score"),
                "park_proximity": tv.get("park_proximity")},
        })
        profiles.append(pr["slope"])
    arr = np.asarray(profiles, dtype="<f4").reshape(-1, N_PTS)
    arr.tofile(WEB_YYC / "walks.bin")
    near = [it["near_stop"]["dist_m"] <= STOP_NEAR_M for it in items]
    stats = {"n_routes": len(items), "n_generated": len(chains), "dropped": dropped,
             "pct_start_within_400m_of_active_stop": round(100.0 * float(np.mean(near)), 1),
             "median_length_m": float(np.median([i["length_m"] for i in items])),
             "median_mean_abs_slope_deg": float(np.median([i["mean_abs_slope_deg"] for i in items])),
             "p95_max_grade_pct": float(np.percentile([i["max_grade_pct"] for i in items], 95)),
             "pct_in_park": round(100.0 * np.mean([i["park"] is not None for i in items]), 1),
             "pct_bridge_repaired": round(100.0 * np.mean([i["bridge_repaired"] for i in items]), 1),
             "pct_in_highest_or_high_need_tract": round(100.0 * np.mean(
                 [bool(i["tract"]) and i["tract"]["access_category"] in ("Highest", "High") for i in items]), 1),
             "elapsed_s": round(time.time() - t0, 1)}
    doc = {"meta": meta(["hrdem", "yyc_pathways", "yyc_parks", "yyc_stops", "yyc_equity"],
                        method={"profile": "slope deg at 100 points equally spaced by arc length; heights = box "
                                           "mean of 5 m DTM samples within +-ds/2; slope = atan(gradient(h, ds))",
                                "dtm": "NRCan HRDEM lidar DTM 2020 (bare earth) at 4 m via COG overview, EPSG:3979",
                                "scale_factor_K": K, "seed": SEED, "orientation": "start = end nearer an ACTIVE stop",
                                "grades": "max_grade_pct / mean_grade_pct from the 100-point profile (|tan slope| x 100)"},
                        licence_note="Contains information licensed under the Open Government Licence - City of "
                                     "Calgary; NRCan HRDEM under OGL-Canada 2.0."),
           "bin": {"path": "calgary/walks.bin", "dtype": "float32-le", "shape": [len(items), N_PTS]},
           "stats": stats, "notes": NOTES, "items": items}
    write_json(out_json, doc)
    log.info("walks: %s", stats)
    return doc


def write_overlays(force: bool = False) -> None:
    path = WEB_YYC / "calgary_overlays.geojson"
    if path.exists() and not force:
        return
    _, vals, feats = equity_index()
    out = []
    for f in feats:
        ct = f["properties"]["CENSUSTRACT"]
        v = vals[ct]
        geom = shape(f["geometry"]).simplify(0.00008, preserve_topology=True)
        gj = json.loads(json.dumps(geom.__geo_interface__))
        gj["coordinates"] = _round_coords(gj["coordinates"])
        out.append({"type": "Feature", "geometry": gj, "properties": {
            "ctuid": ct, "name": v["name"], "communities": v.get("communities"),
            "access_domain_score": v.get("access_domain"), "access_category": v.get("access_category"),
            "transit_score": v.get("transit_score"), "walk_score": v.get("walk_score"),
            "park_proximity": v.get("park_proximity")}})
    doc = {"type": "FeatureCollection", "meta": meta(["yyc_equity"], layer="Calgary Equity Index 2024 - "
           "Accessibility and Amenities domain score and category per census tract (288 tracts)"), "features": out}
    write_json(path, doc)


def _round_coords(c):
    if isinstance(c[0], (int, float)):
        return [round(c[0], 5), round(c[1], 5)]
    return [_round_coords(x) for x in c]


# ----------------------------------------------------------------------------- presets
def moon_routes(rid: str, tile: dict) -> list[dict]:
    """Straight 30 m-tile routes (1, 1.5, 2 km; 16 directions; starts every 750 m) -> gentle (10th pct of
    mean |slope|) and steeper (60th pct) representative routes."""
    dem = np.fromfile(WEB_DATA / tile["path"], dtype="<f4").reshape(tile["size"], tile["size"]).astype(np.float64)
    res, x0, y0 = tile["res_m"], tile["origin_x"], tile["origin_y"]
    span = tile["size"] * res
    cands = []
    for L in (1000.0, 1500.0, 2000.0):
        for sx in np.arange(250.0, span - 250.0, 750.0):
            for sy in np.arange(250.0, span - 250.0, 750.0):
                for k in range(16):
                    az = 2 * math.pi * k / 16
                    a = (x0 + sx, y0 - sy)
                    b = (a[0] + L * math.sin(az), a[1] + L * math.cos(az))
                    if not (x0 + res <= b[0] <= x0 + span - res and y0 - span + res <= b[1] <= y0 - res):
                        continue
                    pr = sample_profile(dem, res, (x0, y0), [a, b], n=N_PTS)
                    s = np.asarray(pr["slope_deg"])
                    if np.isfinite(s).all():
                        cands.append((float(np.abs(s).mean()), L, a, b, s, pr))
    cands.sort(key=lambda c: c[0])
    out = []
    for kind, pct in (("gentle", 10), ("steeper", 60)):
        c = cands[int(round(pct / 100 * (len(cands) - 1)))]
        h = np.asarray(c[5]["h_m"])
        out.append({"kind": kind, "percentile_of_tile_routes": pct, "length_m": c[1],
                    "moon_xy": [[round(c[2][0], 1), round(c[2][1], 1)], [round(c[3][0], 1), round(c[3][1], 1)]],
                    "mean_abs_slope_deg": round(c[0], 3), "max_slope_deg": round(float(np.abs(c[4]).max()), 3),
                    "climb_m": round(float(np.clip(np.diff(h), 0, None).sum()), 1),
                    "slope_deg": [round(float(v), 3) for v in c[4]], "n_tile_candidates": len(cands)})
    return out


def match(moon_slope: np.ndarray, moon_len: float, items: list[dict], prof: np.ndarray, top: int = 5) -> dict:
    band = max(1, int(round(0.10 * N_PTS)))
    lens = np.array([i["length_m"] for i in items])
    ok = np.where((lens >= 0.6 * moon_len) & (lens <= 1.6 * moon_len))[0]
    d = np.array([R.dtw_banded(moon_slope.astype(np.float64), prof[i].astype(np.float64), band) for i in ok])
    order = ok[np.argsort(d)]
    ds = np.sort(d)
    best = float(ds[0])
    tie = order[ds <= best * 1.10 + 0.05]

    def tb(i: int) -> tuple:
        t = items[i]["tract"] or {}
        return (CAT_RANK.get(t.get("access_category"), 5), 0 if items[i]["near_stop"]["dist_m"] <= STOP_NEAR_M else 1,
                items[i]["near_stop"]["dist_m"])
    rec = min(tie, key=tb)
    dmap = dict(zip(ok.tolist(), d.tolist()))

    def row(i):
        it = items[i]
        return {"id": it["id"], "row": it["row"], "dtw_deg": round(dmap[i], 3), "length_m": it["length_m"],
                "park": it["park"], "mean_abs_slope_deg": it["mean_abs_slope_deg"],
                "near_stop": {k: it["near_stop"][k] for k in ("name", "dist_m", "routes")},
                "access_category": (it["tract"] or {}).get("access_category"),
                "access_domain_score": (it["tract"] or {}).get("access_domain_score"),
                "tract": (it["tract"] or {}).get("name"),
                "communities": (it["tract"] or {}).get("communities")}
    return {"recommended": row(int(rec)), "strict_best": row(int(order[0])),
            "tie_break_applied": int(rec) != int(order[0]), "n_in_tie_band": int(len(tie)),
            "n_length_compatible": int(len(ok)), "top": [row(int(i)) for i in order[:top]]}


def build_presets(walks: dict, force: bool = False) -> dict:
    path = WEB_YYC / "presets.json"
    if path.exists() and not force:
        return json.loads(path.read_text())
    items = walks["items"]
    prof = np.fromfile(WEB_YYC / "walks.bin", dtype="<f4").reshape(len(items), N_PTS)
    regions = json.loads((WEB_DATA / "regions.json").read_text())["regions"]
    out = []
    for r in regions:
        for mr in moon_routes(r["id"], r["tile"]):
            m = match(np.asarray(mr["slope_deg"]), mr["length_m"], items, prof)
            mr["slope_gap_deg"] = round(mr["mean_abs_slope_deg"] - m["recommended"]["mean_abs_slope_deg"], 3)
            out.append({"region": r["id"], "region_name": r["name"], **mr, "match": m})
        log.info("presets %s done", r["id"])
    doc = {"meta": meta(["moon_fp", "hrdem", "yyc_pathways", "yyc_stops", "yyc_equity"],
                        method={"moon_routes": "straight lines on the region's 30 m tile (moon/<id>.bin), 1/1.5/2 km, "
                                               "16 directions, starts every 750 m; gentle = 10th, steeper = 60th "
                                               "percentile of mean |slope| over all tile routes",
                                "dtw": "banded DTW (Sakoe-Chiba radius 10 % = 10 samples) on 100-point signed slope "
                                       "profiles, |a-b| cost normalised by warping-path length (deg)",
                                "candidates": "Calgary walks with length 0.6-1.6x the Moon route",
                                "tie_break": "among walks within 10 % (+0.05 deg) of the best DTW, prefer tracts in "
                                             "the Highest/High Accessibility & Amenities category (greatest need; "
                                             "City: '" + CEI_QUOTE + "', " + CEI_SOURCE + "), then a start within "
                                             "400 m of an ACTIVE stop, then the nearer stop"}),
           "notes": NOTES, "presets": out}
    write_json(path, doc)
    return doc


def run(force: bool = False) -> dict:
    walks = build_walks(force=force)
    write_overlays(force=force)
    presets = build_presets(walks, force=force)
    return {"walks": walks["stats"], "n_presets": len(presets["presets"])}
