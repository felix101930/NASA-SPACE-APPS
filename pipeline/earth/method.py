"""web/public/data/method.json: data for the "How we find analogs" explainer (docs/data-contract.md)."""
from __future__ import annotations

import json
import logging
import math

import numpy as np

from pipeline.common.config import WEB_DATA
from pipeline.earth import screen
from pipeline.earth.common import INTERIM, cop_tile_exists, meta
from pipeline.earth.landcover import build_coarse_map, coarse_shares

log = logging.getLogger("pipeline.earth.method")

METHOD_JSON = WEB_DATA / "method.json"
MAX_POINTS = 6000


def _failed_land_points(n_max: int, seed: int) -> list[dict]:
    """Replay the seeded uniform draws and keep land windows that FAIL the DSM-safe filter."""
    counts = build_coarse_map()
    rng = np.random.default_rng(seed)
    s0, s1 = math.sin(math.radians(screen.LAT_MIN)), math.sin(math.radians(screen.LAT_MAX))
    lats = np.degrees(np.arcsin(rng.uniform(s0, s1, 100_000)))
    lons = rng.uniform(-180.0, 180.0, 100_000)
    out = []
    for la, lo in zip(lats, lons):
        la, lo = float(la), float(lo)
        if not cop_tile_exists(la, lo, 90):
            continue
        sh = coarse_shares(counts, la, lo)
        if sh["land"] < screen.LAND_MIN or screen.dsm_pass(sh):
            continue
        out.append({"lat": round(la, 2), "lon": round(lo, 2), "pass": False, "stage": "sampled", "best_dist": None})
        if len(out) >= n_max:
            break
    return out


def write(report: dict, rank: dict, earth_doc: dict | None, s2: dict, regions_path=WEB_DATA / "regions.json") -> dict:
    stats = json.loads(screen.DRAW_STATS.read_text())
    rows = screen.load_fingerprints()
    by_id = {r["id"]: r for r in rows}
    screened = [r for r in rows if r["selected_by"] == "global_screen" and r.get("status") == "ok"
                and str(r["id"])[0] in "SA"]
    cov = report.get("coverage") or {}
    strata_counts: dict[tuple[str, str], int] = {}
    for r in screened:
        st = str(r.get("stratum") or "")
        if "_relief" in st and st.replace("adaptive_", "").startswith("band"):
            band = st.replace("adaptive_", "").split("_relief")[0].replace("band", "")
            rel = st.split("_relief")[1]
        else:
            band, rel = (f"{screen.BANDS[int(r['band'])][0]}..{screen.BANDS[int(r['band'])][1]}"
                         if math.isfinite(r.get("band", float("nan"))) else "?"), st or "other"
        strata_counts[(band, rel)] = strata_counts.get((band, rel), 0) + 1
    fn = report["funnel"]
    shortlist = set(rank["selected"])
    final_ids = set()
    if isinstance(s2.get("searches"), dict):
        for lst in s2["searches"].values():
            final_ids.update(i for i, _ in lst)
    funnel = [
        {"stage": "sampled", "n": stats.get("n_land"), "known_pass": fn["heldout_positive"]["n"],
         "decoy_pass": fn["decoy"]["n"]},
        {"stage": "dsm_safe", "n": stats.get("n_pass"), "known_pass": fn["heldout_positive"]["n_pass_filter"],
         "decoy_pass": fn["decoy"]["n_pass_filter"]},
        {"stage": "stage1_top", "n": len(shortlist), "known_pass": fn["heldout_positive"]["n_survive_stage2_cut_and_filter"],
         "decoy_pass": fn["decoy"]["n_survive_stage2_cut_and_filter"]},
        {"stage": "stage2", "n": sum(1 for s in (earth_doc or {}).get("sites", []) if s["selected_by"] == "global_screen"),
         "known_pass": fn["heldout_positive"]["n_survive_stage2_cut_and_filter"],
         "decoy_pass": fn["decoy"]["n_survive_stage2_cut_and_filter"]},
        {"stage": "final_top3", "n": len(final_ids), "known_pass": fn["heldout_positive"].get("n_in_final_top3_approx", 0),
         "decoy_pass": fn["decoy"].get("n_in_final_top3_approx", 0)},
    ]
    n_el = rank["n_eligible"]
    names = {}
    if earth_doc:
        names = {s["id"]: (s.get("name"), s.get("dsm_safe")) for s in earth_doc["sites"]}
    from pipeline.earth.rank_stage1 import _positive_sets
    pos_ext = set(_positive_sets(rows)["heldout_positive_ext"])
    known = [{"id": r["id"], "name": names.get(r["id"], (r["id"], None))[0],
              "best_rank_pct": round(100.0 * rank["best_rank"][r["id"]] / n_el, 2) if rank["best_rank"].get(r["id"]) else None,
              "dsm_safe": bool(int(r.get("dsm_pass") or 0))}
             for r in rows if r["id"] in pos_ext]
    decoys = [{"id": r["id"], "name": names.get(r["id"], (r["id"], None))[0],
               "best_rank_pct": round(100.0 * rank["best_rank"][r["id"]] / n_el, 2) if rank["best_rank"].get(r["id"]) else None}
              for r in rows if r.get("role") == "decoy"]
    rng = np.random.default_rng(screen.SEED + 7)
    pts = []
    priority = [r for r in screened if r["id"] in shortlist or r["id"] in final_ids]
    rest = [r for r in screened if r["id"] not in shortlist and r["id"] not in final_ids]
    n_fail = 1000
    n_rest = max(0, MAX_POINTS - len(priority) - n_fail)
    if len(rest) > n_rest:
        rest = [rest[i] for i in sorted(rng.choice(len(rest), n_rest, replace=False))]
    for r in priority + rest:
        stage = "final" if r["id"] in final_ids else ("shortlist" if r["id"] in shortlist else "screened")
        bd = rank.get("best_dist", {}).get(r["id"])
        pts.append({"lat": round(r["lat"], 2), "lon": round(r["lon"], 2), "pass": True, "stage": stage,
                    "best_dist": round(bd, 3) if bd is not None else None})
    pts.extend(_failed_land_points(n_fail, screen.SEED))
    # worked example: the strongest final top-1 match
    example = None
    if earth_doc and regions_path.exists() and isinstance(s2.get("searches"), dict):
        regions = {r["id"]: r for r in json.loads(regions_path.read_text())["regions"]}
        sites = {s["id"]: s for s in earth_doc["sites"]}
        pref = ["malapert_massif|rim", "haworth|shadow", "mons_mouton_plateau|texture"]
        keys = pref + [k for k in s2["searches"] if k not in pref]
        for key in keys:
            lst = s2["searches"].get(key) or []
            if not lst or lst[0][0] not in sites:
                continue
            rid, hz = key.split("|")
            sid = lst[0][0]
            mm = regions[rid]["hazards"][hz]["metrics"]
            em = sites[sid]["metrics"]
            ks = [k for k in mm if k in em and isinstance(mm[k], (int, float)) and k != "shadow_frac_timeweighted"]
            example = {"region_id": rid, "hazard": hz, "site_id": sid, "site_name": sites[sid]["name"],
                       "site_lat": sites[sid]["lat"], "site_lon": sites[sid]["lon"],
                       "moon": {k: round(float(mm[k]), 4) for k in ks},
                       "earth": {k: round(float(em[k]), 4) for k in ks}}
            break
    lo, hi = screen.BARE_LAND_KM2
    doc = {
        "meta": meta(),
        "screen": {"n_draws": stats.get("n_draw"), "n_land": stats.get("n_land"), "n_pool": stats.get("n_pass"),
                   "n_screened": len(screened), "coverage_km2": round(len(screened) * screen.WINDOW_KM2),
                   "coverage_pct_bare": round(100 * len(screened) * screen.WINDOW_KM2 / ((lo + hi) / 2), 2),
                   "coverage_pct_dsm_safe": cov.get("pct_of_dsm_safe_land"),
                   "coverage_note": "screened N windows sampled from bare land (X% coverage); not 'all of Earth'",
                   "seed": screen.SEED,
                   "strata": [{"lat_band": b, "relief_class": c, "n": n} for (b, c), n in sorted(strata_counts.items())]},
        "funnel": funnel,
        "validation": {"known_median_pct": fn["heldout_positive"].get("best_rank_median_pct"),
                       "decoy_median_pct": fn["decoy"].get("best_rank_median_pct"),
                       "auc": fn.get("known_vs_decoy_auc_best_rank"), "known": known, "decoys": decoys,
                       "extended": {
                           "note": "original 13 + documented agency-cited hold-outs (deduplicated within 20 km)",
                           "n_positive": fn.get("heldout_positive_ext", {}).get("n"),
                           "known_median_pct": fn.get("heldout_positive_ext", {}).get("best_rank_median_pct"),
                           "auc": fn.get("known_ext_vs_decoy_auc_best_rank"),
                           "n_pass_dsm_safe": fn.get("heldout_positive_ext", {}).get("n_pass_filter"),
                           "failing_dsm_safe": fn.get("positives_failing_dsm_safe")}},
        "nasadem_check": report.get("nasadem_check"),
        "documented": report.get("documented_vs_screen_summary"),
        "points": pts[: MAX_POINTS + 200],
        "example": example,
    }
    METHOD_JSON.write_text(json.dumps(doc, separators=(",", ":"), default=float))
    log.info("wrote %s (%d points, %.2f MB)", METHOD_JSON, len(doc["points"]), METHOD_JSON.stat().st_size / 1e6)
    return doc
