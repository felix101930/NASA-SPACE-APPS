"""Calgary Equity Index analysis for the "Moon walks in Calgary" module.

Question: are free Moon-walk events reachable where the need for access to amenities is highest?

Inputs (all already produced or cached by calgary_walks.py / calgary_data.py):
- walks.json + walks.bin  2,762 City pathway routes (slope profiles, nearest ACTIVE stop, Equity Index tract)
- presets.json            18 Moon routes (9 Artemis III regions x gentle/steeper) with 100-point slope profiles
- Equity Index 2024       ArcGIS layer 2 (long format): Accessibility & Amenities domain (category, score,
                          TOTAL_POPULATION) plus the Total Equity Score and two other domains (robustness check)

Definitions (same matcher and thresholds as the presets and the web UI):
- A route is SUITABLE when (a) its start is within 400 m of an ACTIVE Calgary Transit stop and (b) its slope
  profile matches at least one Moon preset route with banded DTW < 1.0 deg (Sakoe-Chiba radius 10 samples,
  candidates 0.6-1.6x the Moon route's length): exactly `calgary_walks.match`'s matcher and the UI's
  "Calgary match" threshold.
- A tract is COVERED when at least one suitable route has its midpoint in it (the tract stored in walks.json).
- Equity Index direction: higher score = GREATER NEED (City of Calgary). Categories are quintiles of tracts.

Output: web/public/data/calgary/equity.json (schema in docs/data-contract-alberta.md).
"""
from __future__ import annotations

import json
import logging
import math
import re
from dataclasses import dataclass

import numpy as np
from scipy.stats import rankdata
from shapely.geometry import shape

from pipeline.alberta import calgary_data as C
from pipeline.alberta.calgary_walks import CEI_QUOTE, CEI_SOURCE, K, N_PTS, STOP_NEAR_M, TO_MAP
from pipeline.alberta.common import WEB_YYC, meta, write_json

log = logging.getLogger("pipeline.alberta.equity_analysis")

MATCH_DEG = 1.0               # "Calgary match": typical slope mismatch (banded DTW) under 1 deg
DTW_BAND = max(1, int(round(0.10 * N_PTS)))
LEN_LO, LEN_HI = 0.6, 1.6     # length-compatibility window of calgary_walks.match
WALK_M_PER_MIN = 80.0         # assumed walking pace (4.8 km/h) for "minutes' walk"
ROUTES_CAP = 4                # stop with >= 4 bus/train routes gets the full "routes" credit
SCHOOL_ROUTES = (600, 899)    # Calgary Transit school-term specials (named after schools): not counted for events
MIN_SEP_KM = 2.0              # event starts at least 2 km apart, so the top 5 reach different areas
CATEGORIES = ["Highest", "High", "Moderate", "Low", "Lowest"]   # greatest need first
HIGH_NEED = ("Highest", "High")
LOW_NEED = ("Low", "Lowest")


# ----------------------------------------------------------------------------- matcher (vectorised)
def dtw_banded_batch(a: np.ndarray, B: np.ndarray, band: int) -> np.ndarray:
    """routes.dtw_banded(a, B[k], band) for every row k at once (identical tie handling).

    a: (n,) Moon slope profile; B: (k, m) Calgary slope profiles. Returns (k,) mean |slope difference|
    along the optimal warping path (deg)."""
    a = np.asarray(a, np.float64)
    B = np.asarray(B, np.float64)
    k, m = B.shape
    n = len(a)
    inf = 1e18
    Dp = np.full((k, m + 1), inf)
    Lp = np.zeros((k, m + 1))
    Dp[:, 0] = 0.0
    for i in range(1, n + 1):
        Dc = np.full((k, m + 1), inf)
        Lc = np.zeros((k, m + 1))
        for j in range(max(1, i - band), min(m, i + band) + 1):
            c = np.abs(a[i - 1] - B[:, j - 1])
            best, bl = Dp[:, j - 1].copy(), Lp[:, j - 1].copy()
            up = Dp[:, j] < best
            best[up], bl[up] = Dp[up, j], Lp[up, j]
            left = Dc[:, j - 1] < best
            best[left], bl[left] = Dc[left, j - 1], Lc[left, j - 1]
            Dc[:, j] = best + c
            Lc[:, j] = bl + 1.0
        Dp, Lp = Dc, Lc
    return Dp[:, m] / np.maximum(Lp[:, m], 1.0)


def best_moon_match(profiles: np.ndarray, lengths: np.ndarray, presets: list[dict]) -> tuple[np.ndarray, np.ndarray]:
    """Per Calgary route: the lowest DTW over all length-compatible Moon presets, and that preset's index
    (inf / -1 when no preset is length-compatible)."""
    best = np.full(len(lengths), np.inf)
    arg = np.full(len(lengths), -1, int)
    for pi, p in enumerate(presets):
        ok = np.where((lengths >= LEN_LO * p["length_m"]) & (lengths <= LEN_HI * p["length_m"]))[0]
        if not len(ok):
            continue
        d = dtw_banded_batch(np.asarray(p["slope_deg"]), profiles[ok], DTW_BAND)
        better = d < best[ok]
        best[ok[better]] = d[better]
        arg[ok[better]] = pi
    return best, arg


# ----------------------------------------------------------------------------- records
@dataclass
class TractRec:
    ctuid: str
    name: str
    communities: str
    category: str | None          # Accessibility & Amenities domain category (Highest = greatest need)
    score: float | None           # Accessibility & Amenities domain score
    population: int | None
    x: float                      # tract centroid, EPSG:3979 map metres
    y: float
    total_category: str | None = None
    total_score: float | None = None


@dataclass
class RouteRec:
    id: str
    ctuid: str | None
    park: str | None
    length_m: float
    stop_name: str | None
    stop_dist_m: float
    stop_routes: list[str]
    best_dtw: float               # inf when no length-compatible Moon preset
    preset: int                   # index into presets, -1 if none
    x: float                      # route start (meeting point), EPSG:3979 map metres
    y: float

    @property
    def public_routes(self) -> list[str]:
        """Routes at the stop excluding school-term specials (600-899), which do not run for weekend events."""
        return [r for r in self.stop_routes if not is_school_route(r)]

    @property
    def near_stop(self) -> bool:
        return self.stop_dist_m <= STOP_NEAR_M

    @property
    def moon_match(self) -> bool:
        return self.best_dtw < MATCH_DEG

    @property
    def suitable(self) -> bool:
        return self.near_stop and self.moon_match


_SUBAREA = re.compile(r"^\d{2}[A-Z]$")   # City residual sub-area codes such as "03W" (not a community name)


def is_school_route(name: str) -> bool:
    m = re.match(r"\s*(\d+)", name or "")
    return bool(m) and SCHOOL_ROUTES[0] <= int(m.group(1)) <= SCHOOL_ROUTES[1]


def nice(s: str | None) -> str:
    """'CANYON MEADOWS, 03W' -> 'Canyon Meadows' (title case, sub-area codes dropped)."""
    if not s:
        return ""
    parts = [p.strip() for p in s.split(",") if p.strip() and not _SUBAREA.match(p.strip())]
    return ", ".join(" ".join(w.capitalize() for w in p.split()) for p in parts)


def tract_label(t: TractRec) -> str:
    return nice(t.communities) or f"Census tract {t.name}"


def park_label(park: str | None) -> str | None:
    """'Carburn Park; Carburn Park Depot' -> 'Carburn Park' (first City park-site name)."""
    if not park:
        return None
    return re.sub(r"-(\w)", lambda m: "-" + m.group(1).upper(), park.split(";")[0].strip())


def _num(v) -> float | None:
    try:
        f = float(str(v).replace(",", ""))
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


# ----------------------------------------------------------------------------- analysis (pure)
def coverage_by(tracts: list[TractRec], routes: list[RouteRec], attr: str = "category") -> list[dict]:
    """One row per need category (Highest..Lowest): tracts, tracts with any sampled route, covered tracts,
    and population-weighted shares."""
    covered = {r.ctuid for r in routes if r.suitable and r.ctuid}
    any_route = {r.ctuid for r in routes if r.ctuid}
    out = []
    for cat in CATEGORIES:
        ts = [t for t in tracts if getattr(t, attr) == cat]
        cov = [t for t in ts if t.ctuid in covered]
        pop = sum(t.population or 0 for t in ts)
        pop_cov = sum(t.population or 0 for t in cov)
        out.append({"category": cat, "n_tracts": len(ts),
                    "n_with_any_route": sum(t.ctuid in any_route for t in ts),
                    "n_covered": len(cov), "pct_covered": round(100.0 * len(cov) / len(ts), 1) if ts else None,
                    "population": pop, "population_covered": pop_cov,
                    "pct_population_covered": round(100.0 * pop_cov / pop, 1) if pop else None,
                    "n_suitable_routes": sum(1 for r in routes if r.suitable and r.ctuid in {t.ctuid for t in ts})})
    return out


def equity_gap(rows: list[dict]) -> dict:
    """Share of Highest/High tracts covered vs Low/Lowest, with a plain-language statement."""
    def agg(cats: tuple[str, ...]) -> tuple[int, int, int, int]:
        sel = [r for r in rows if r["category"] in cats]
        return (sum(r["n_covered"] for r in sel), sum(r["n_tracts"] for r in sel),
                sum(r["population_covered"] for r in sel), sum(r["population"] for r in sel))
    hc, hn, hpc, hp = agg(HIGH_NEED)
    lc, ln, lpc, lp = agg(LOW_NEED)
    hi = 100.0 * hc / hn if hn else 0.0
    lo = 100.0 * lc / ln if ln else 0.0
    diff = hi - lo
    if abs(diff) < 5:
        verdict = "about the same"
    elif diff < 0:
        verdict = "lower"
    else:
        verdict = "higher"
    statement = (f"{hc} of {hn} higher-need neighbourhoods ({hi:.0f}%) have a Moon-walk route that starts within "
                 f"{STOP_NEAR_M:.0f} m of a bus or train stop, compared with {lc} of {ln} lower-need neighbourhoods "
                 f"({lo:.0f}%).")
    if verdict == "lower":
        statement += (" Coverage is lower where the need for access to amenities is greater, so free events should "
                      "start in the higher-need neighbourhoods that do have a route, and add shuttles for the rest.")
    elif verdict == "higher":
        statement += " Coverage is higher where the need for access to amenities is greater."
    else:
        statement += " Coverage is about the same across need levels."
    return {"high_need": {"categories": list(HIGH_NEED), "n_tracts": hn, "n_covered": hc, "pct_covered": round(hi, 1),
                          "population": hp, "population_covered": hpc,
                          "pct_population_covered": round(100.0 * hpc / hp, 1) if hp else None},
            "low_need": {"categories": list(LOW_NEED), "n_tracts": ln, "n_covered": lc, "pct_covered": round(lo, 1),
                         "population": lp, "population_covered": lpc,
                         "pct_population_covered": round(100.0 * lpc / lp, 1) if lp else None},
            "gap_pct_points": round(diff, 1), "direction": verdict, "statement": statement}


def need_percentiles(tracts: list[TractRec]) -> dict[str, float]:
    """Accessibility & Amenities score -> percentile among tracts with a score (0 = least need, 1 = most)."""
    ts = [t for t in tracts if t.score is not None]
    if len(ts) < 2:
        return {t.ctuid: 1.0 for t in ts}
    r = rankdata([t.score for t in ts], method="average")
    return {t.ctuid: float((ri - 1) / (len(ts) - 1)) for t, ri in zip(ts, r)}


def transit_factor(dist_m: float, n_routes: int) -> float:
    """0..1: half from stop distance (1 at the stop, 0 at 400 m), half from routes serving it (capped at 4)."""
    return 0.5 * max(0.0, 1.0 - dist_m / STOP_NEAR_M) + 0.5 * min(n_routes, ROUTES_CAP) / ROUTES_CAP


def quality_factor(dtw: float) -> float:
    """0..1: 1 = identical slope profile, 0 = at the 1 deg match threshold."""
    return max(0.0, 1.0 - dtw / MATCH_DEG)


def minutes_walk(dist_m: float) -> int:
    return max(1, int(math.ceil(dist_m / WALK_M_PER_MIN)))


def rank_events(tracts: list[TractRec], routes: list[RouteRec], presets: list[dict], n: int = 5,
                min_sep_km: float = MIN_SEP_KM) -> list[dict]:
    """Top-n locations for free Moon-walk events: one route per tract (its best transit x quality),
    tracts ranked by need x transit x quality, and starts at least min_sep_km apart (greedy, in rank order).
    Ties are broken by tract id, then route id (deterministic)."""
    pct = need_percentiles(tracts)
    by_id = {t.ctuid: t for t in tracts}
    best: dict[str, tuple[float, float, RouteRec]] = {}
    for r in sorted(routes, key=lambda x: x.id):
        if not r.suitable or r.ctuid not in pct:
            continue
        local = transit_factor(r.stop_dist_m, len(r.public_routes)) * quality_factor(r.best_dtw)
        if r.ctuid not in best or local > best[r.ctuid][0] + 1e-12:
            best[r.ctuid] = (local, pct[r.ctuid] * local, r)
    order = sorted(best.items(), key=lambda kv: (-kv[1][1], kv[0]))
    picked: list[tuple[str, float, RouteRec]] = []
    for ct, (_, score, r) in order:
        if len(picked) >= n:
            break
        if all(math.hypot(r.x - q.x, r.y - q.y) / K >= min_sep_km * 1000.0 for _, _, q in picked):
            picked.append((ct, score, r))
    out = []
    for rank, (ct, score, r) in enumerate(picked, start=1):
        t = by_id[ct]
        p = presets[r.preset]
        place = park_label(r.park) or tract_label(t)
        mins = minutes_walk(r.stop_dist_m)
        top_pct = max(1, int(round(100 * (1 - pct[ct]))))
        why = (f"{t.category} need for access to amenities (in the top {top_pct}% of Calgary's 288 tracts); "
               f"starts {r.stop_dist_m:.0f} m (about {mins} min walk) from {r.stop_name}"
               f"{f' with {len(r.public_routes)} routes' if len(r.public_routes) > 1 else ''}; slope profile matches the "
               f"Moon's {p['region_name']} {p['kind']} route with a {r.best_dtw:.2f}° typical slope mismatch.")
        out.append({"rank": rank, "ctuid": ct, "tract": t.name, "communities": tract_label(t),
                    "place": place, "park": park_label(r.park), "access_category": t.category,
                    "access_domain_score": t.score, "need_percentile": round(pct[ct], 3),
                    "population": t.population, "route_id": r.id, "length_m": round(r.length_m, 0),
                    "near_stop": {"name": r.stop_name, "dist_m": round(r.stop_dist_m, 0),
                                  "minutes_walk": mins, "routes": r.public_routes,
                                  "n_school_routes": len(r.stop_routes) - len(r.public_routes)},
                    "moon_match": {"region": p["region"], "region_name": p["region_name"], "kind": p["kind"],
                                   "dtw_deg": round(r.best_dtw, 3)},
                    "factors": {"need": round(pct[ct], 3),
                                "transit": round(transit_factor(r.stop_dist_m, len(r.public_routes)), 3),
                                "quality": round(quality_factor(r.best_dtw), 3)},
                    "score": round(score, 4), "why": why})
    return out


def uncaptured(tracts: list[TractRec], routes: list[RouteRec], category: str = "Highest") -> list[dict]:
    """Tracts of `category` with no suitable route: why, and where the nearest suitable route starts."""
    by_id = {t.ctuid: t for t in tracts}
    suit = sorted((r for r in routes if r.suitable), key=lambda x: x.id)
    sxy = np.array([[r.x, r.y] for r in suit]) if suit else np.zeros((0, 2))
    covered = {r.ctuid for r in suit}
    out = []
    for t in sorted((t for t in tracts if t.category == category and t.ctuid not in covered),
                    key=lambda t: (-(t.score or 0.0), t.ctuid)):
        here = [r for r in routes if r.ctuid == t.ctuid]
        if not here:
            reason = "no_route"
            why = "No pathway route was sampled here (few or no connected City pathways)."
        elif not any(r.near_stop for r in here):
            reason = "far_from_stop"
            d = min(r.stop_dist_m for r in here)
            why = f"Pathway routes here start at least {d:.0f} m from an active stop (limit {STOP_NEAR_M:.0f} m)."
        elif not any(r.moon_match for r in here if r.near_stop):
            reason = "no_slope_match"
            why = "Routes near a stop exist, but none match a Moon route's slope profile within 1°."
        else:   # pragma: no cover - a near-stop matching route would make the tract covered
            reason, why = "other", ""
        nearest = None
        if len(sxy):
            d = np.hypot(sxy[:, 0] - t.x, sxy[:, 1] - t.y) / K
            i = int(np.argmin(d))
            r = suit[i]
            rt = by_id.get(r.ctuid or "")
            nearest = {"route_id": r.id, "place": park_label(r.park) or (tract_label(rt) if rt else r.id),
                       "ctuid": r.ctuid,
                       "dist_km": round(float(d[i]) / 1000.0, 1), "stop_name": r.stop_name,
                       "stop_dist_m": round(r.stop_dist_m, 0)}
        out.append({"ctuid": t.ctuid, "tract": t.name, "communities": tract_label(t), "population": t.population,
                    "access_domain_score": t.score, "n_routes_sampled": len(here), "reason": reason, "why": why,
                    "nearest_suitable": nearest})
    return out


# ----------------------------------------------------------------------------- IO
def load_tracts() -> list[TractRec]:
    acc = C.equity()["access_domain"]
    extra = {k: {f["properties"]["CENSUSTRACT"]: f["properties"] for f in C.equity_indicator(k, lab)}
             for k, lab in C.EQUITY_EXTRA.items()}
    out = []
    for f in acc:
        p = f["properties"]
        g = shape(f["geometry"]).buffer(0)
        c = g.centroid
        x, y = TO_MAP.transform(c.x, c.y)
        tot = extra["total_equity"].get(p["CENSUSTRACT"], {})
        out.append(TractRec(ctuid=p["CENSUSTRACT"], name=p["NAME"], communities=p.get("COMMUNITIES") or "",
                            category=p.get("EQUITY_CATEGORY"), score=_num(p.get("INDICATOR_VALUE")),
                            population=None if _num(p.get("TOTAL_POPULATION")) is None
                            else int(_num(p.get("TOTAL_POPULATION"))),
                            x=float(x), y=float(y), total_category=tot.get("EQUITY_CATEGORY"),
                            total_score=_num(tot.get("INDICATOR_VALUE"))))
    out.sort(key=lambda t: t.ctuid)
    return out


def load_routes(presets: list[dict]) -> list[RouteRec]:
    walks = json.loads((WEB_YYC / "walks.json").read_text())
    items = walks["items"]
    prof = np.fromfile(WEB_YYC / "walks.bin", dtype="<f4").reshape(len(items), N_PTS)
    lens = np.array([i["length_m"] for i in items], float)
    best, arg = best_moon_match(prof, lens, presets)
    lat = np.array([i["coords"][0][0] for i in items])
    lon = np.array([i["coords"][0][1] for i in items])
    x, y = TO_MAP.transform(lon, lat)
    out = []
    for k, it in enumerate(items):
        ns = it.get("near_stop") or {}
        out.append(RouteRec(id=it["id"], ctuid=(it.get("tract") or {}).get("ctuid"), park=it.get("park"),
                            length_m=float(it["length_m"]), stop_name=ns.get("name"),
                            stop_dist_m=float(ns.get("dist_m", math.inf)), stop_routes=list(ns.get("routes") or []),
                            best_dtw=float(best[k]), preset=int(arg[k]), x=float(x[k]), y=float(y[k])))
    return out


def analyse(tracts: list[TractRec], routes: list[RouteRec], presets: list[dict]) -> dict:
    rows = coverage_by(tracts, routes, "category")
    gap = equity_gap(rows)
    hi = rows[0]
    headline = (f"{hi['n_covered']} of {hi['n_tracts']} highest-need neighbourhoods have a Moon-walk route that "
                f"starts within {STOP_NEAR_M:.0f} m of a bus or train stop")
    by_preset = {}
    for r in routes:
        if r.suitable:
            p = presets[r.preset]
            key = f"{p['region']}:{p['kind']}"
            by_preset[key] = by_preset.get(key, 0) + 1
    n_steep_match = sum(v for k, v in by_preset.items() if k.endswith(":steeper"))
    unc = uncaptured(tracts, routes, "Highest")
    reasons = {k: sum(u["reason"] == k for u in unc) for k in ("no_route", "far_from_stop", "no_slope_match")}
    return {
        "headline": headline,
        "summary": {
            "n_tracts": len(tracts), "n_routes": len(routes),
            "n_routes_in_a_tract": sum(r.ctuid is not None for r in routes),
            "n_routes_near_stop": sum(r.near_stop for r in routes),
            "n_routes_moon_match": sum(r.moon_match for r in routes),
            "n_routes_suitable": sum(r.suitable for r in routes),
            "n_tracts_covered": len({r.ctuid for r in routes if r.suitable and r.ctuid}),
            "suitable_by_moon_route": dict(sorted(by_preset.items())),
            "n_suitable_matching_a_steeper_moon_route": n_steep_match,
        },
        "coverage": rows,
        "coverage_total_equity": coverage_by(tracts, routes, "total_category"),
        "gap": gap,
        "top_events": rank_events(tracts, routes, presets, 5),
        "uncaptured_highest": {"n": len(unc), "reasons": reasons, "tracts": unc},
    }


def build(force: bool = False) -> dict:
    path = WEB_YYC / "equity.json"
    if path.exists() and not force:
        return json.loads(path.read_text())
    presets = json.loads((WEB_YYC / "presets.json").read_text())["presets"]
    tracts = load_tracts()
    routes = load_routes(presets)
    res = analyse(tracts, routes, presets)
    method = {
        "suitable_route": (f"start within {STOP_NEAR_M:.0f} m of an ACTIVE Calgary Transit stop AND banded DTW < "
                           f"{MATCH_DEG:.1f} deg to at least one of the 18 Moon preset routes (Sakoe-Chiba radius "
                           f"{DTW_BAND} samples on 100-point signed slope profiles; candidates {LEN_LO}-{LEN_HI}x "
                           "the Moon route's length) - the same matcher and threshold as presets.json and the UI"),
        "covered_tract": "at least one suitable route whose midpoint lies in the tract (walks.json tract)",
        "need": ("Calgary Equity Index 2024, Accessibility and Amenities domain; higher score = greater need. City: '"
                 + CEI_QUOTE + "' (" + CEI_SOURCE + "). Categories are the City's quintiles (Highest..Lowest)."),
        "population": "TOTAL_POPULATION per tract from the Equity Index layer (used for population-weighted shares)",
        "event_score": ("need x transit x quality, one route per tract: need = percentile of the Accessibility & "
                        "Amenities score among the 288 tracts (0-1); transit = 0.5 x (1 - stop distance / 400 m) + "
                        f"0.5 x min(routes at the stop, {ROUTES_CAP}) / {ROUTES_CAP} (school-term specials numbered "
                        f"{SCHOOL_ROUTES[0]}-{SCHOOL_ROUTES[1]} not counted); quality = 1 - DTW / 1 deg. "
                        f"Ties: tract id, then route id. Starts at least {MIN_SEP_KM:.0f} km apart (greedy in rank "
                        "order) so the five events reach different areas."),
        "minutes_walk": f"ceil(distance / {WALK_M_PER_MIN:.0f} m per minute) - an assumed 4.8 km/h walking pace",
        "nearest_suitable": "straight-line distance from the tract centroid to the start of the nearest suitable route",
        "robustness": "coverage_total_equity repeats the coverage table with the City's Total Equity Score categories",
        "scale_note": ("Slope profiles match at about 20-30 m scale (100 points over 1-3 km). Steep Moon routes have "
                       "no city equivalent: suitable routes match gentle Moon routes."),
    }
    doc = {"meta": meta(["yyc_equity", "yyc_pathways", "yyc_parks", "yyc_stops", "hrdem", "moon_fp"],
                        method=method, cei_source=CEI_SOURCE, cei_quote=CEI_QUOTE,
                        licence_note="Contains information licensed under the Open Government Licence - City of "
                                     "Calgary; NRCan HRDEM under OGL-Canada 2.0; NASA LOLA open data."),
           **res}
    write_json(path, doc)
    log.info("equity: %s", res["headline"])
    return doc


if __name__ == "__main__":   # pragma: no cover
    from pipeline.alberta.common import setup_logging
    setup_logging()
    print(json.dumps(build(force=True)["summary"], indent=1))
