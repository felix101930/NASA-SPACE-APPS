"""27 searches (9 regions x 3 hazards): top-3 Earth sites, traffic lights and plain-English notes.

Distance per metric = 1-D Wasserstein distance between the Moon and Earth values, divided by the
Moon region's IQR (spread of the metric across the 25 blocks of 3 km in the 15 km core, see
moon_ref.py), floored. For scalars W1 is |earth - moon|; for 101-quantile arrays it is the mean
|dQ|. A hazard distance is the weighted mean of its terms (TERM_WEIGHTS); missing terms drop out.
"""
from __future__ import annotations

import logging
import math

import numpy as np

from pipeline.common.config import ROOT
from pipeline.match.common import HAZARDS, finite, is_eligible, is_heldout_or_decoy

log = logging.getLogger("pipeline.match.matches")

TOP_K = 3

# Hazard -> term -> weight. Core contract metrics weigh 1. Extras count as ONE averaged sub-term
# each (docs/features-extra.md) so the validated metrics stay dominant; brightness at half weight.
TERM_WEIGHTS: dict[str, dict[str, float]] = {
    "shadow": {"shadow_frac_el1": 1.0, "shadow_frac_el3": 1.0, "shadow_frac_el5": 1.0,
               "shadow_frac_timeweighted": 1.0, "aspect_anisotropy": 0.5, "brightness_rank": 0.5},
    "rim": {"jump1km_p95_m": 1.0, "jump1km_p99_m": 1.0, "frac_track_over_500m": 1.0, "shape_terrain": 1.0},
    "texture": {"fast_per_km2_el3": 1.0, "empty_cell_frac_el3": 1.0, "brightness_rank": 0.5},
}
# Floors for the Moon-IQR scale (a very uniform Moon region must not make every Earth site "infinitely" far).
SCALE_FLOORS: dict[str, float] = {
    "shadow_frac_el1": 0.02, "shadow_frac_el3": 0.02, "shadow_frac_el5": 0.02, "shadow_frac_timeweighted": 0.02,
    "jump1km_p95_m": 10.0, "jump1km_p99_m": 10.0, "frac_track_over_500m": 0.005,
    "fast_per_km2_el3": 1.0, "empty_cell_frac_el3": 0.03, "slope_p50_deg": 1.0,
}
# Shape scalars are scale-dependent (a 3 km block is not a 15 km window), so the block IQR is not a
# fair yardstick; these fixed scales (~typical spread between 15 km windows) are used instead.
SHAPE_SCALAR_SCALES: dict[str, float] = {"shape_aspect_R": 0.10, "shape_aspect_R2": 0.10,
                                         "shape_depr_per_100km2": 10.0, "shape_depr_area_frac": 0.01,
                                         "shape_hypso_integral": 0.05}
BRIGHT_RANK_SCALE = 0.5   # population IQR of a percentile rank (pipeline.metrics.brightness)
REQUIRE_DSM_SAFE = True   # prefer DSM-safe sites (surface model ~ bare earth); relaxed if < TOP_K remain
LIGHT_GREEN, LIGHT_AMBER = 0.5, 1.0   # |gap| / IQR: inside the IQR band (±0.5 IQR), inside 2 x IQR band (±1 IQR)

# Novelty rule (team METHOD.md, approved): the top 3 of each search must be >= NOVELTY_KM apart from each
# other AND >= NOVELTY_KM from every catalogued analog (all rows with coordinates in
# data/literature_analogs.csv + known_analog rows of data/earth_candidates.csv). Greedy pick down the
# ranked list; if fewer than TOP_K qualify the search reports novelty_shortfall (never relaxed silently).
NOVELTY_KM = 50.0
CATALOG_FILES = (ROOT / "data" / "literature_analogs.csv", ROOT / "data" / "earth_candidates.csv")
NOVELTY_RULE = (f"Each region x hazard top {TOP_K} must be >= {NOVELTY_KM:g} km from each other and >= {NOVELTY_KM:g} km "
                "from every catalogued analog site (every row with coordinates in data/literature_analogs.csv plus the "
                "known_analog rows of data/earth_candidates.csv). Greedy pick down the ranked list; if fewer than "
                f"{TOP_K} qualify, the search keeps what qualifies and reports novelty_shortfall (rule never relaxed).")

CORE_TERMS = {h: [t for t in TERM_WEIGHTS[h] if t in SCALE_FLOORS] for h in HAZARDS}
LIGHT_METRICS = {"shadow": CORE_TERMS["shadow"], "rim": CORE_TERMS["rim"] + ["slope_p50_deg"],
                 "texture": CORE_TERMS["texture"]}
CANNOT_TEST_BASE = ["1/6 g gravity", "hard vacuum", "−200 °C nights", "Earth skylight fills shadows",
                    "low sun lasts minutes on Earth, days on the Moon"]
LABELS = {
    "shadow_frac_el1": "Shadow at 1° sun", "shadow_frac_el3": "Shadow at 3° sun", "shadow_frac_el5": "Shadow at 5° sun",
    "shadow_frac_timeweighted": "Shadow over a low-sun day", "jump1km_p95_m": "1 km height jumps (worst 5%)",
    "jump1km_p99_m": "1 km height jumps (worst 1%)", "frac_track_over_500m": "Track crossing 500 m jumps",
    "fast_per_km2_el3": "Camera landmarks at 3° sun", "empty_cell_frac_el3": "Featureless 1 km cells",
    "slope_p50_deg": "Typical slope",
}


# ------------------------------------------------------------------ distances (pure functions)
def scalar_distance(earth: float, moon: float, scale: float) -> float:
    """W1 between two point masses (|earth - moon|) divided by the scale. NaN if either is missing."""
    if not (finite(earth) and finite(moon)) or not scale > 0:
        return float("nan")
    return abs(float(earth) - float(moon)) / float(scale)


def quantile_w1(a: list[float], b: list[float], scale: float) -> float:
    """W1 between two 101-quantile vectors (mean |dQ|) divided by the scale. NaN if either is empty."""
    qa, qb = np.asarray(a or [], float), np.asarray(b or [], float)
    if qa.size != 101 or qb.size != 101 or not scale > 0:
        return float("nan")
    return float(np.mean(np.abs(qa - qb))) / float(scale)


def iqr_scale(metric: str, iqr: list[float] | None) -> float:
    w = (iqr[1] - iqr[0]) if iqr else 0.0
    return max(float(w), SCALE_FLOORS.get(metric, 1e-6))


def weighted_mean(terms: dict[str, float], weights: dict[str, float]) -> float:
    num = den = 0.0
    for t, d in terms.items():
        if finite(d) and weights.get(t, 0) > 0:
            num += weights[t] * d
            den += weights[t]
    return num / den if den > 0 else float("nan")


def _nanmean(v: list[float]) -> float:
    v = [x for x in v if finite(x)]
    return float(np.mean(v)) if v else float("nan")


def site_terms(moon: dict, site: dict, feat: dict | None) -> dict[str, dict[str, float]]:
    """Per-hazard term distances for one (region, site)."""
    from pipeline.metrics.shape import SCALE_FLOORS as Q_FLOORS
    m_e = site.get("metrics", {})
    out: dict[str, dict[str, float]] = {h: {} for h in HAZARDS}
    for h in HAZARDS:
        for t in CORE_TERMS[h]:
            out[h][t] = scalar_distance(m_e.get(t), moon["values"].get(t), iqr_scale(t, moon["iqr"].get(t)))
    sh_e = (feat or {}).get("shape30") or {}
    se, sm = sh_e.get("scalars", {}), moon.get("shape_scalars", {})
    out["shadow"]["aspect_anisotropy"] = _nanmean(
        [scalar_distance(se.get(k), sm.get(k), SHAPE_SCALAR_SCALES[k]) for k in ("shape_aspect_R", "shape_aspect_R2")])
    rim_parts = [scalar_distance(se.get(k), sm.get(k), SHAPE_SCALAR_SCALES[k])
                 for k in ("shape_depr_per_100km2", "shape_depr_area_frac", "shape_hypso_integral")]
    qe, qm = sh_e.get("quantiles_101", {}), moon.get("shape_q", {})
    for k in qe:
        mq = qm.get(k) or []
        if len(mq) == 101:
            rim_parts.append(quantile_w1(qe[k], mq, max(float(mq[75] - mq[25]), Q_FLOORS.get(k, 1e-6))))
    out["rim"]["shape_terrain"] = _nanmean(rim_parts)
    br = scalar_distance((feat or {}).get("bright_rank"), moon.get("bright_rank"), BRIGHT_RANK_SCALE)
    out["shadow"]["brightness_rank"] = br
    out["texture"]["brightness_rank"] = br
    return out


# ------------------------------------------------------------------ novelty
def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371.0 * math.asin(min(1.0, math.sqrt(a)))


def load_catalog() -> list[dict]:
    """Catalogued analog sites: literature_analogs.csv rows with coordinates + known_analog rows of earth_candidates.csv."""
    import csv
    out = []
    lit, cand = CATALOG_FILES
    if lit.exists():
        for r in csv.DictReader(lit.open(encoding="utf-8")):
            try:
                out.append({"id": r["lit_id"], "name": r["name"], "lat": float(r["lat"]), "lon": float(r["lon"]),
                            "source": "literature_analogs.csv"})
            except (ValueError, KeyError, TypeError):
                continue
    if cand.exists():
        for r in csv.DictReader(cand.open(encoding="utf-8")):
            known = (r.get("known_analog") or "").strip().lower().startswith("yes") or (r.get("category") or "").strip() == "known_analog"
            if not known:
                continue
            try:
                out.append({"id": r["id"].strip(), "name": r["name"].strip(), "lat": float(r["lat"]), "lon": float(r["lon"]),
                            "source": "earth_candidates.csv"})
            except (ValueError, KeyError, TypeError):
                continue
    return out


def nearest_catalog(sites: list[dict], catalog: list[dict]) -> dict[str, tuple[float, str | None]]:
    """{site_id: (km to nearest catalogued analog, its name)}."""
    out = {}
    for s in sites:
        best = (float("inf"), None)
        for c in catalog:
            d = haversine_km(float(s["lat"]), float(s["lon"]), c["lat"], c["lon"])
            if d < best[0]:
                best = (d, c["name"])
        out[s["id"]] = best
    return out


def is_catalogued_site(site: dict) -> bool:
    """Earth-site records that ARE catalogued analogs (for the best_documented comparison)."""
    return (str(site.get("selected_by")) == "documented" or str(site.get("role")) in ("heldout_positive", "heldout_positive_ext")
            or str(site.get("category")) in ("known_analog", "documented_analog"))


# ------------------------------------------------------------------ term table + ranking
def build_table(moon_ref: dict[str, dict], sites: list[dict], feats: dict[str, dict]) -> dict:
    """{"region|hazard": {"site_ids", "terms", "D" (n_sites x n_terms, NaN = missing)}}."""
    table = {}
    per_site = {s["id"]: {rid: site_terms(moon_ref[rid], s, feats.get(s["id"])) for rid in moon_ref} for s in sites}
    for rid in moon_ref:
        for h in HAZARDS:
            terms = list(TERM_WEIGHTS[h])
            ids = [s["id"] for s in sites if all(finite(per_site[s["id"]][rid][h].get(t)) for t in CORE_TERMS[h])]
            D = np.array([[per_site[i][rid][h].get(t, np.nan) for t in terms] for i in ids], float).reshape(len(ids), len(terms))
            table[f"{rid}|{h}"] = {"site_ids": ids, "terms": terms, "D": D}
    return table


def combine(entry: dict, weights: dict[str, float]) -> np.ndarray:
    D = entry["D"]
    w = np.array([weights.get(t, 0.0) for t in entry["terms"]], float)
    ok = np.isfinite(D)
    num = np.where(ok, D, 0.0) @ w
    den = ok.astype(float) @ w
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(den > 0, num / den, np.nan)


def candidate_pool(sites: list[dict], near_cat: dict[str, tuple[float, str | None]] | None = None
                   ) -> tuple[set[str], str]:
    """Eligible sites (DSM-safe preferred) that are >= NOVELTY_KM from every catalogued analog."""
    elig = [s for s in sites if is_eligible(s)]
    if near_cat is not None:
        elig = [s for s in elig if near_cat.get(s["id"], (float("inf"), None))[0] >= NOVELTY_KM]
    if REQUIRE_DSM_SAFE:
        safe = {s["id"] for s in elig if s.get("dsm_safe") is not False}
        if len(safe) >= TOP_K:
            return safe, f"eligible, DSM-safe and >= {NOVELTY_KM:g} km from catalogued analogs"
    return {s["id"] for s in elig}, f"eligible and >= {NOVELTY_KM:g} km from catalogued analogs (DSM-safe filter relaxed: too few sites)"


def top_k(table: dict, pool: set[str], weights: dict[str, dict[str, float]] | None = None,
          k: int = TOP_K, coords: dict[str, tuple[float, float]] | None = None,
          min_sep_km: float = NOVELTY_KM) -> dict[str, list[tuple[str, float]]]:
    """Greedy top-k down the ranked list; with ``coords`` each pick must be >= min_sep_km from earlier picks."""
    weights = weights or TERM_WEIGHTS
    out = {}
    for key, e in table.items():
        h = key.split("|")[1]
        d = combine(e, weights[h])
        cand = sorted((float(d[i]), sid) for i, sid in enumerate(e["site_ids"]) if sid in pool and np.isfinite(d[i]))
        picked: list[tuple[str, float]] = []
        for dist, sid in cand:
            if len(picked) >= k:
                break
            if coords is not None and any(haversine_km(*coords[sid], *coords[p]) < min_sep_km for p, _ in picked):
                continue
            picked.append((sid, dist))
        out[key] = picked
    return out


def best_documented(table: dict, sites: list[dict], pool: set[str]) -> dict[str, dict | None]:
    """Per search: best-scoring catalogued analog present in earth_sites.json (comparison only, never a match)."""
    cat = {s["id"]: s for s in sites if is_catalogued_site(s)}
    out = {}
    for key, e in table.items():
        h = key.split("|")[1]
        d = combine(e, TERM_WEIGHTS[h])
        cand = sorted((float(d[i]), sid) for i, sid in enumerate(e["site_ids"]) if sid in cat and np.isfinite(d[i]))
        if not cand:
            out[key] = None
            continue
        dist, sid = cand[0]
        pool_d = np.sort([d[i] for i, x in enumerate(e["site_ids"]) if x in pool and np.isfinite(d[i])])
        s = cat[sid]
        out[key] = {"site_id": sid, "name": s.get("name"), "country": s.get("country"), "lat": s.get("lat"),
                    "lon": s.get("lon"), "role": s.get("role"), "selected_by": s.get("selected_by"),
                    "distance": round(dist, 4), "would_rank": int(np.searchsorted(pool_d, dist)) + 1,
                    "n_pool": int(pool_d.size)}
    return out


def validation_ranks(table: dict, pool: set[str], sites: list[dict]) -> dict:
    """Where each held-out positive / decoy WOULD rank among the pool (scored, never shown as a match)."""
    roles = {s["id"]: s for s in sites if is_heldout_or_decoy(s)}
    res = {}
    for key, e in table.items():
        h = key.split("|")[1]
        d = combine(e, TERM_WEIGHTS[h])
        pool_d = np.sort([d[i] for i, sid in enumerate(e["site_ids"]) if sid in pool and np.isfinite(d[i])])
        for i, sid in enumerate(e["site_ids"]):
            if sid in roles and np.isfinite(d[i]):
                r = int(np.searchsorted(pool_d, d[i])) + 1
                rec = res.setdefault(sid, {"role": roles[sid].get("role"), "name": roles[sid].get("name"), "best_rank": None,
                                           "best_search": None, "best_distance": None, "n_pool": int(pool_d.size)})
                if rec["best_rank"] is None or r < rec["best_rank"]:
                    rec.update(best_rank=r, best_search=key, best_distance=round(float(d[i]), 4))
    return res


# ------------------------------------------------------------------ lights and text
def _fmt_val(metric: str, v: float) -> str:
    if metric.startswith("shadow_frac") or metric in ("empty_cell_frac_el3",):
        return f"{100 * v:.0f}%"
    if metric == "frac_track_over_500m":
        return f"{100 * v:.1f}%"
    if metric.endswith("_m"):
        return f"{v:.0f} m"
    if metric == "fast_per_km2_el3":
        return f"{v:.1f}/km²"
    if metric.endswith("_deg"):
        return f"{v:.0f}°"
    return f"{v:.3g}"


def gap_text(metric: str, earth: float, moon: float) -> str:
    d = earth - moon
    more = d > 0
    if metric.startswith("shadow_frac"):
        pts = round(100 * abs(d))
        where = {"shadow_frac_el1": "at 1° sun", "shadow_frac_el3": "at 3° sun", "shadow_frac_el5": "at 5° sun",
                 "shadow_frac_timeweighted": "over a low-sun day"}[metric]
        return f"same shadow {where}" if pts == 0 else f"{pts} pts {'more' if more else 'less'} shadow {where}"
    if metric in ("jump1km_p95_m", "jump1km_p99_m"):
        x = round(abs(d))
        tail = "worst 5%" if metric.endswith("p95_m") else "worst 1%"
        return f"same 1 km height jumps ({tail})" if x == 0 else f"1 km height jumps {x} m {'bigger' if more else 'smaller'} ({tail})"
    if metric == "frac_track_over_500m":
        if earth == 0 and moon == 0:
            return "no 500 m jumps on either"
        return f"{100 * abs(d):.1f} pts {'more' if more else 'less'} track crossing 500 m jumps"
    if metric == "fast_per_km2_el3":
        return f"{abs(d):.1f} {'more' if more else 'fewer'} camera landmarks per km²"
    if metric == "empty_cell_frac_el3":
        pts = round(100 * abs(d))
        return "same share of featureless 1 km cells" if pts == 0 else f"{pts} pts {'more' if more else 'fewer'} featureless 1 km cells"
    if metric == "slope_p50_deg":
        x = round(abs(d))
        return "same typical slope" if x == 0 else f"slopes {x}° {'steeper' if more else 'gentler'}"
    return f"{d:+.3g}"


def make_lights(moon: dict, site: dict, hazard: str) -> list[dict]:
    lights = []
    for t in LIGHT_METRICS[hazard]:
        e, m = site.get("metrics", {}).get(t), moon["values"].get(t)
        if not (finite(e) and finite(m)):
            continue
        scale = iqr_scale(t, moon["iqr"].get(t))
        rel = abs(e - m) / scale
        light = "green" if rel <= LIGHT_GREEN else "amber" if rel <= LIGHT_AMBER else "red"
        band = [max(0.0, m - scale / 2), m + scale / 2]
        lights.append({"metric": t, "label": LABELS.get(t, t), "moon": round(m, 5), "moon_iqr": [round(x, 5) for x in band],
                       "moon_block_iqr": [round(x, 5) for x in moon["iqr"][t]] if moon["iqr"].get(t) else None,
                       "earth": round(float(e), 5), "gap_text": gap_text(t, float(e), m), "light": light,
                       "gap_in_iqr": round(rel, 2), "in_distance": t in TERM_WEIGHTS[hazard]})
    return lights


def make_texts(moon: dict, site: dict, feat: dict | None, hazard: str, lights: list[dict]) -> tuple[list[str], list[str]]:
    good, bad = [], []
    for li in lights:
        line = f"{li['label']}: {_fmt_val(li['metric'], li['earth'])} here vs {_fmt_val(li['metric'], li['moon'])} on the Moon"
        if li["light"] == "green":
            good.append(line)
        elif li["light"] == "red":
            bad.append(f"{line} ({li['gap_text']})")
    if site.get("dsm_safe") is True:
        good.append("Surface model is trustworthy here: little tree cover or buildings (DSM-safe)")
    elif site.get("dsm_safe") is False:
        bad.append("Surface model includes trees or buildings here (not DSM-safe), so heights are partly canopy/roofs")
    note = site.get("low_vegetation_note")
    if note:
        bad.append(f"{note[0].upper()}{note[1:]}; grass and shrubs soften texture and shadows")
    elif site.get("bare_frac") is not None and site.get("dsm_safe") is not False:
        good.append(f"Mostly open ground ({site.get('worldcover_note') or f'bare {100 * site['bare_frac']:.0f}%'})")
    rock = site.get("rock") or {}
    if rock.get("anorthosite"):
        good.append("Anorthosite bedrock, like the lunar highlands")
    elif rock.get("lith"):
        bad.append(f"Rock is {rock['lith'].lower()} (Macrostrat), not the anorthosite of the lunar highlands: "
                   "colour, brightness and grain differ")
    else:
        bad.append("Rock type unknown here; the Moon south pole is anorthosite highland")
    be, bm = (feat or {}).get("bright_rank"), moon.get("bright_rank")
    if hazard in ("shadow", "texture") and finite(be) and finite(bm):
        if abs(be - bm) <= 0.15:
            good.append("Ground brightness sits at a similar place in its world's range as the Moon region's")
        else:
            bad.append(f"Ground is relatively {'brighter' if be > bm else 'darker'} for Earth than this region is for the Moon")
    se = ((feat or {}).get("shape30") or {}).get("scalars", {})
    if hazard == "shadow" and finite(se.get("shape_aspect_R")) and finite(moon["shape_scalars"].get("shape_aspect_R")):
        de = se["shape_aspect_R"] - moon["shape_scalars"]["shape_aspect_R"]
        if abs(de) <= SHAPE_SCALAR_SCALES["shape_aspect_R"]:
            good.append("Slopes face a mix of directions to a similar degree as on the Moon (aspect anisotropy)")
        else:
            bad.append(f"Slopes are {'more' if de > 0 else 'less'} one-directional than on the Moon (aspect anisotropy)")
    return good, bad


def cannot_test(site: dict) -> list[str]:
    out = list(CANNOT_TEST_BASE)
    lat = abs(float(site.get("lat") or 0))
    wc = site.get("worldcover") or {}
    if lat >= 55:
        out.append("permafrost/snow season: access and bare ground mostly in summer")
    elif (wc.get("snow") or 0) >= 0.02:
        out.append("seasonal snow cover hides terrain part of the year")
    if lat >= 66.5:
        out.append("polar night and midnight sun: low-sun windows only in spring and autumn")
    return out


def build_matches(moon_ref: dict[str, dict], sites: list[dict], feats: dict[str, dict],
                  table: dict | None = None) -> tuple[list[dict], dict, set[str], str, list[dict], dict]:
    """Returns (match rows, term table, pool, pool note, per-search records, coords)."""
    by_id = {s["id"]: s for s in sites}
    table = table or build_table(moon_ref, sites, feats)
    catalog = load_catalog()
    near_cat = nearest_catalog(sites, catalog)
    pool, pool_note = candidate_pool(sites, near_cat)
    coords = {s["id"]: (float(s["lat"]), float(s["lon"])) for s in sites}
    tops = top_k(table, pool, coords=coords)
    bdoc = best_documented(table, sites, pool)
    searches = []
    for key, lst in tops.items():
        rid, h = key.split("|")
        searches.append({"region_id": rid, "hazard": h, "n_selected": len(lst),
                         "novelty_shortfall": max(0, TOP_K - len(lst)), "best_documented": bdoc.get(key)})
    out = []
    for key, lst in tops.items():
        rid, h = key.split("|")
        moon = moon_ref[rid]
        e = table[key]
        for rank, (sid, dist) in enumerate(lst, start=1):
            s, f = by_id[sid], feats.get(sid)
            row = e["D"][e["site_ids"].index(sid)]
            lights = make_lights(moon, s, h)
            good, bad = make_texts(moon, s, f, h, lights)
            assert not is_heldout_or_decoy(s), f"held-out/decoy site {sid} reached top-{TOP_K}"
            out.append({
                "region_id": rid, "hazard": h, "rank": rank, "site_id": sid, "distance": round(dist, 4),
                "site_name": s.get("name"), "country": s.get("country"), "lat": s.get("lat"), "lon": s.get("lon"),
                "selected_by": s.get("selected_by"), "role": s.get("role"), "dsm_safe": s.get("dsm_safe"),
                "nearest_catalogued_km": round(near_cat[sid][0], 1), "nearest_catalogued": near_cat[sid][1],
                "terms": {t: (round(float(v), 4) if np.isfinite(v) else None) for t, v in zip(e["terms"], row)},
                "lights": lights, "matches_text": good, "mismatches_text": bad, "cannot_test": cannot_test(s),
                "light_counts": {c: sum(1 for li in lights if li["light"] == c and li["in_distance"])
                                 for c in ("green", "amber", "red")},
                "windows": [],
            })
    log.info("novelty rule: %d catalogued analogs, pool %d sites, shortfalls in %d searches",
             len(catalog), len(pool), sum(1 for x in searches if x["novelty_shortfall"]))
    return out, table, pool, pool_note, searches, coords
