"""CLI: python -m pipeline.earth [pool|screen|rank|stage2|transects|report|all]  (idempotent, cached)."""
from __future__ import annotations

import argparse
import csv
import json
import logging
import math
import time

import numpy as np

from pipeline.common.config import WEB_DATA
from pipeline.earth.common import CANDIDATES_CSV, INTERIM, setup_logging

log = logging.getLogger("pipeline.earth")

REPORT = INTERIM / "screen_report.json"
STAGE2_SITES = INTERIM / "stage2_sites.json"


def stage2_site_list() -> list[dict]:
    from pipeline.earth import rank_stage1, screen
    from pipeline.earth.naming import nearest_place
    from pipeline.earth.pool import load_documented, load_validation
    rk = json.loads(rank_stage1.RANK_JSON.read_text()) if rank_stage1.RANK_JSON.exists() else rank_stage1.rank()
    rows = {r["id"]: r for r in screen.load_fingerprints()}
    sites = []
    for sid, hits in sorted(rk["selected"].items()):
        r = rows[sid]
        nm = nearest_place(r["lat"], r["lon"])
        sites.append({"id": sid, "lat": r["lat"], "lon": r["lon"], "role": "candidate", "selected_by": "global_screen",
                      "name": nm["name"], "country": nm["country"], "name_source": "GeoNames nearest populated place",
                      "category": "global_screen", "stratum": r.get("stratum"),
                      "stage1_rank": rk["best_rank"].get(sid), "stage1_best": rk["best_search"].get(sid),
                      "stage1_hits": hits})
    val, _ = load_validation()
    for s in val:
        sites.append({"id": s.id, "lat": s.lat, "lon": s.lon, "name": s.name, "country": s.country,
                      "category": s.category, "role": s.role, "selected_by": "validation",
                      "stage1_rank": rk["best_rank"].get(s.id), "stage1_best": rk["best_search"].get(s.id),
                      "coord_source_url": s.extra.get("coord_source_url"),
                      "known_analog_text": s.extra.get("known_analog") if s.known_analog else None})
    for s in load_documented():
        e = s.extra
        sites.append({"id": s.id, "lat": s.lat, "lon": s.lon, "name": s.name, "country": s.country,
                      "category": "documented_analog", "role": s.role, "selected_by": "documented",
                      "stage1_rank": rk["best_rank"].get(s.id), "stage1_best": rk["best_search"].get(s.id),
                      "coord_source_url": e.get("coord_source_url"), "lit_id": s.id,
                      "agencies": [a for a in (e.get("agencies") or "").split("|") if a],
                      "uses": [u for u in (e.get("uses") or "").split("|") if u],
                      "source_url": e.get("source_url"), "source_title": e.get("source_title"),
                      "verified": e.get("verified"), "split": e.get("split"), "dup_of": e.get("dup_of")})
    STAGE2_SITES.write_text(json.dumps(sites, indent=1, default=str))
    return sites


def stage2_distances(doc: dict, metric_override: dict[str, dict] | None = None) -> tuple[dict, dict]:
    """{search: {site_id: distance}} on 30 m contract metrics vs regions.json (IQR-scaled |diff|,
    timeweighted shadow excluded); scales from the global-screen stage-2 sites. Returns (D, keys)."""
    from pipeline.metrics import HAZARD_KEYS
    regions = json.loads((WEB_DATA / "regions.json").read_text())["regions"]
    sites = doc["sites"]
    met = {s["id"]: (metric_override or {}).get(s["id"], s["metrics"]) for s in sites}
    keys = {h: [k for k in HAZARD_KEYS[h] if k != "shadow_frac_timeweighted"] for h in ("shadow", "rim", "texture")}
    scale = {}
    for ks in keys.values():
        for k in ks:
            v = np.array([s["metrics"].get(k) for s in sites if s["selected_by"] == "global_screen"
                          and s["metrics"].get(k) is not None], float)
            scale[k] = max(float(np.percentile(v, 75) - np.percentile(v, 25)), 1e-3) if v.size else 1.0
    D = {}
    for r in regions:
        for h, ks in keys.items():
            mm = r["hazards"][h]["metrics"]
            d = {}
            for s in sites:
                m = met[s["id"]]
                vals = [abs(m[k] - mm[k]) / scale[k] for k in ks if m.get(k) is not None and mm.get(k) is not None]
                if vals:
                    d[s["id"]] = float(np.mean(vals))
            D[f"{r['id']}|{h}"] = d
    return D, keys


def stage2_funnel(doc: dict, top_k: int = 3, cut_survivors: set | None = None,
                  metric_override: dict[str, dict] | None = None, restrict: set | None = None) -> dict:
    """Approximate final top-3 using 30 m metrics vs regions.json (official matching is pipeline/match).
    Pool = global-screen discoveries + validation/documented positives and decoys that survived the
    DSM-safe filter and the stage-1 cut."""
    if not (WEB_DATA / "regions.json").exists():
        return {"note": "regions.json not available yet"}
    D, _ = stage2_distances(doc, metric_override)
    roles = {s["id"]: s["role"] for s in doc["sites"]}
    cut_survivors = cut_survivors or set()
    pool = {s["id"] for s in doc["sites"] if s["selected_by"] == "global_screen"
            or (s["role"] in ("heldout_positive", "decoy") and s["id"] in cut_survivors)}
    if restrict is not None:
        pool &= restrict
    res = {"top_k": top_k, "searches": {}, "survivors": {"heldout_positive": set(), "decoy": set()}}
    for key, d in D.items():
        top = sorted((v, i) for i, v in d.items() if i in pool)[:top_k]
        res["searches"][key] = [(i, roles[i]) for _, i in top]
        for _, i in top:
            if roles[i] in res["survivors"]:
                res["survivors"][roles[i]].add(i)
    res["survivors"] = {k: sorted(v) for k, v in res["survivors"].items()}
    res["note"] = ("approximate: IQR-scaled |diff| on 30 m contract metrics (excluding timeweighted); "
                   "official ranking is pipeline/match")
    return res


def documented_vs_screen(doc: dict) -> tuple[dict, dict]:
    """Per documented site: distance and rank among global-screen stage-2 sites for every search."""
    D, _ = stage2_distances(doc)
    screen_ids = [s["id"] for s in doc["sites"] if s["selected_by"] == "global_screen"]
    per_site, best_ranks = {}, []
    for s in doc["sites"]:
        if s["selected_by"] != "documented":
            continue
        out = {}
        for key, d in D.items():
            if s["id"] not in d:
                continue
            v = d[s["id"]]
            rank = 1 + sum(1 for i in screen_ids if d.get(i, np.inf) < v)
            out[key] = {"dist": round(v, 4), "rank_vs_screen": rank, "n_screen": len(screen_ids)}
        if out:
            best = min(out.items(), key=lambda kv: kv[1]["rank_vs_screen"])
            per_site[s["id"]] = {"per_search": out, "best_search": best[0], "best_rank_vs_screen": best[1]["rank_vs_screen"],
                                 "best_dist": best[1]["dist"], "split": s.get("split"), "name": s["name"]}
            best_ranks.append(best[1]["rank_vs_screen"])
    summ = {"n_sites": len(per_site), "n_screen_sites": len(screen_ids),
            "median_best_rank_vs_screen": float(np.median(best_ranks)) if best_ranks else None,
            "n_in_top3_any_search": sum(1 for r in best_ranks if r <= 3),
            "sites": {k: {kk: v[kk] for kk in ("name", "split", "best_search", "best_rank_vs_screen", "best_dist")}
                      for k, v in per_site.items()}}
    return per_site, summ


def cmd_screen(args) -> None:
    from pipeline.earth import screen
    screen.run(workers=args.workers, budget_s=args.budget)


def cmd_rank(args) -> dict:
    from pipeline.earth import rank_stage1
    return rank_stage1.rank()


def cmd_stage2(args) -> dict:
    from pipeline.earth import compute
    sites = stage2_site_list()
    log.info("stage 2: %d sites (%d screen, %d validation)", len(sites),
             sum(1 for s in sites if s["selected_by"] == "global_screen"),
             sum(1 for s in sites if s["selected_by"] == "validation"))
    res = compute.run_sites(sites, force=args.force)
    return compute.write_earth_sites(sites, res)


def cmd_transects(args) -> dict:
    from pipeline.earth import transects
    sites = json.loads(STAGE2_SITES.read_text())
    ids = [s["id"] for s in sites if s["role"] != "decoy"]
    return transects.build(ids, {s["id"]: s for s in sites})


def cmd_report(args) -> dict:
    from pipeline.earth import compute, rank_stage1, screen
    stats = json.loads(screen.DRAW_STATS.read_text())
    rk = json.loads(rank_stage1.RANK_JSON.read_text())
    rows = screen.load_fingerprints()
    fn = rank_stage1.funnel(rk, rows)
    # strict-rule run (earlier pool drawn under bare+moss >= 0.6), ranked the same way
    fn_strict = None
    if screen.FP_CSV_STRICT.exists():
        strict_rank_path = INTERIM / "stage1_ranking_strict.json"
        rk_s = rank_stage1.rank(fp_path=screen.FP_CSV_STRICT, q_path=screen.QUANT_STRICT, out_path=strict_rank_path,
                                apply_refine=False)
        fn_strict = rank_stage1.funnel(rk_s, screen.load_fingerprints(screen.FP_CSV_STRICT))
        fn_strict["n_eligible"] = rk_s["n_eligible"]
        fn_strict["top_k"] = rk_s["top_k"]
    cut = {i for role in ("heldout_positive_ext", "decoy") for i in fn[role]["ids_surviving_with_filter"]}
    doc = json.loads(compute.EARTH_SITES_JSON.read_text()) if compute.EARTH_SITES_JSON.exists() else None
    s2 = stage2_funnel(doc, cut_survivors=cut) if doc else {"note": "earth_sites.json not built"}
    if isinstance(s2.get("survivors"), dict):
        for role, src in (("heldout_positive", "heldout_positive"), ("heldout_positive_ext", "heldout_positive"),
                          ("decoy", "decoy")):
            ids = [i for i in s2["survivors"].get(src, []) if i in set(fn[role]["ids_surviving_with_filter"])]
            fn[role]["n_in_final_top3_approx"] = len(ids)
            fn[role]["ids_final_top3_approx"] = ids
    doc_vs, doc_summary = (documented_vs_screen(doc) if doc and (WEB_DATA / "regions.json").exists() else ({}, None))
    nasadem_summary = None
    if doc:
        from pipeline.earth import nasadem_check
        nd = {s["id"]: json.loads(nasadem_check.result_path(s["id"]).read_text())
              for s in doc["sites"] if nasadem_check.result_path(s["id"]).exists()}
        if nd:
            ag = nasadem_check.agreement({s["id"]: s["metrics"] for s in doc["sites"]}, nd)
            override = {i: v["metrics"] for i, v in nd.items() if v.get("available")}
            s2n = stage2_funnel(doc, cut_survivors=cut, metric_override=override)
            same = []
            for key, lst in s2.get("searches", {}).items():
                a_ = {i for i, _ in lst}
                b_ = {i for i, _ in s2n["searches"].get(key, [])}
                same.append(len(a_ & b_) / max(len(a_), 1))
            unchanged = [1.0 if {i for i, _ in lst} == {i for i, _ in s2n["searches"].get(k, [])} else 0.0
                         for k, lst in s2.get("searches", {}).items()]
            nasadem_summary = {"n_sites": ag["n_sites"],
                               "n_unavailable": sum(1 for v in nd.values() if not v.get("available")),
                               "per_metric_r": {k: v["r"] for k, v in ag["per_metric"].items()},
                               "per_metric": ag["per_metric"],
                               "top3_unchanged_frac": round(float(np.mean(unchanged)), 3) if unchanged else None,
                               "top3_overlap_mean": round(float(np.mean(same)), 3) if same else None,
                               "note": "NASADEM near field (56S-60N) + same GLO-90 far field; sites north of 60N "
                                       "are Copernicus-only (available: false)"}
        # patch per-site blocks into earth_sites.json
        for s in doc["sites"]:
            if s["id"] in nd:
                v = nd[s["id"]]
                s["nasadem"] = {"available": bool(v.get("available")), "metrics": v.get("metrics")} \
                    if v.get("available") else {"available": False, "reason": v.get("reason")}
            if s["id"] in doc_vs:
                s["vs_screen"] = doc_vs[s["id"]]
        from pipeline.earth import nasadem_check as _nc
        if nd and not any(x.get("name", "").startswith("NASADEM") for x in doc["meta"]["sources"]):
            doc["meta"]["sources"].append(_nc.SOURCE)
        from pipeline.earth.naming import SOURCE as GEON
        if not any(x.get("name") == GEON["name"] for x in doc["meta"]["sources"]):
            doc["meta"]["sources"].append(GEON)
        compute.EARTH_SITES_JSON.write_text(json.dumps(compute._clean(doc), separators=(",", ":")))
    table = {}
    for name, f in (("strict_bare>=0.6", fn_strict), ("dsm_safe", fn)):
        if not f:
            continue
        for role in ("heldout_positive", "heldout_positive_ext", "decoy"):
            if role not in f:
                continue
            table.setdefault(name, {})[role] = {
                "with_coords": f[role]["n"], "pass_filter": f[role]["n_pass_filter"],
                "stage1_top_k_any_search": f[role]["n_survive_stage2_cut_any_search"],
                "pass_filter_and_stage1_cut": f[role]["n_survive_stage2_cut_and_filter"],
                "final_top3_approx": f[role].get("n_in_final_top3_approx", "n/a")}
        table[name]["auc_known_vs_decoy_stage1"] = f.get("known_vs_decoy_auc_best_rank")
        table[name]["auc_known_ext_vs_decoy_stage1"] = f.get("known_ext_vs_decoy_auc_best_rank")
    report = {
        "seed": screen.SEED,
        "sampling": {k: stats.get(k) for k in ("n_draw", "n_land", "n_pass", "pass_rate_of_land", "per_band")},
        "filters": {"strict": {"bare_plus_moss_min": screen.BARE_MIN, "snow_max": screen.SNOW_MAX},
                    "dsm_safe": {**screen.DSM_SAFE_MAX, "snow_max_exclusive": screen.DSM_SNOW_MAX},
                    "land_min": screen.LAND_MIN,
                    "source": "ESA WorldCover 2021 COG overview level 4 (~300 m), 2.7 km cells"},
        "strata": {"latitude_bands": screen.BANDS, "relief_terciles_m": stats.get("relief_tercile_edges_m"),
                   "tercile_weights_low_mid_high": stats.get("tercile_weights"),
                   "relief_source": "GLO-90 overview level 1 (~360 m), P99-P1 in 15 km window",
                   "per_stratum": stats.get("strata"), "n_forced_rock": stats.get("n_forced_rock"),
                   "n_forced_rock_anorthosite": stats.get("n_forced_rock_anorthosite"),
                   "k_per_tile": stats.get("k_per_tile"), "min_sep_km": stats.get("min_sep_km")},
        "fingerprint_run": stats.get("fingerprint_run"),
        "coverage": stats.get("coverage"),
        "coverage_wording": "screened N windows sampled from bare land (X% coverage) -- never 'searched all of Earth'",
        "stage1": {"n_eligible": rk["n_eligible"], "top_k_per_search": rk["top_k"], "n_searches": len(rk["searches"]),
                   "n_selected_unique": len(rk["selected"])},
        "funnel_table": table,
        "nasadem_check": nasadem_summary,
        "documented_vs_screen_summary": doc_summary,
        "funnel": fn,
        "funnel_strict_run": fn_strict,
        "pool_note": ("current pool drawn under the DSM-safe rule (tree<=.10, built<=.05, crop<=.20, water<=.20, "
                      "wet+mangrove<=.10, snow<.30); the strict-rule run (bare+moss>=0.6) is kept for comparison. "
                      "Earlier strict pool under-sampled semi-arid shrub/grass land."),
        "stage2_final_top3_approx": s2,
        "loosening_bare_filter": rank_stage1.loosening_effects(rows),
    }
    # adaptive / refinement / before-after / stability
    from pipeline.earth import adaptive
    if adaptive.ALLOC_JSON.exists():
        report["adaptive_round"] = json.loads(adaptive.ALLOC_JSON.read_text())
    if rank_stage1.REFINE_JSON.exists():
        rf = json.loads(rank_stage1.REFINE_JSON.read_text())
        report["refinement"] = {k: v for k, v in rf.items() if k not in ("windows", "replaced_ids")}
    r1 = INTERIM / "stage1_ranking_round1.json"
    if r1.exists():
        rk1 = json.loads(r1.read_text())
        fn1 = rank_stage1.funnel(rk1, [r for r in rows if str(r["id"])[0] not in "AR"])
        report["before_after"] = {
            "round1": {"mean_best_dist": rk1.get("mean_best_dist"), "n_eligible": rk1["n_eligible"],
                       "known_median_best_rank_pct": fn1["heldout_positive"]["best_rank_median_pct"],
                       "decoy_median_best_rank_pct": fn1["decoy"]["best_rank_median_pct"],
                       "auc": fn1["known_vs_decoy_auc_best_rank"],
                       "known_pass_filter_and_cut": fn1["heldout_positive"]["n_survive_stage2_cut_and_filter"]},
            "now": {"mean_best_dist": rk.get("mean_best_dist"), "n_eligible": rk["n_eligible"],
                    "known_median_best_rank_pct": fn["heldout_positive"]["best_rank_median_pct"],
                    "decoy_median_best_rank_pct": fn["decoy"]["best_rank_median_pct"],
                    "auc": fn["known_vs_decoy_auc_best_rank"],
                    "known_pass_filter_and_cut": fn["heldout_positive"]["n_survive_stage2_cut_and_filter"]},
        }
    final_top3 = ({k: [i for i, _ in v] for k, v in s2["searches"].items()}
                  if isinstance(s2.get("searches"), dict) else None)
    try:
        report["stability_bootstrap"] = rank_stage1.bootstrap(final_top3)
    except Exception as exc:  # noqa: BLE001
        log.warning("bootstrap failed: %s", exc)
    n_scr = sum(1 for r in rows if r["selected_by"] == "global_screen" and r.get("status") == "ok"
                and str(r["id"])[0] in "SA")
    lo, hi = screen.BARE_LAND_KM2
    cov = dict(report.get("coverage") or {})
    cov.update({"windows": n_scr, "km2": n_scr * screen.WINDOW_KM2,
                "pct_of_bare_land_range": [round(100 * n_scr * screen.WINDOW_KM2 / hi, 2),
                                           round(100 * n_scr * screen.WINDOW_KM2 / lo, 2)]})
    if cov.get("dsm_safe_land_km2_est"):
        cov["pct_of_dsm_safe_land"] = round(100 * n_scr * screen.WINDOW_KM2 / cov["dsm_safe_land_km2_est"], 2)
    report["coverage"] = cov
    REPORT.write_text(json.dumps(report, indent=1, default=str))
    log.info("wrote %s", REPORT)
    try:
        from pipeline.earth import method
        method.write(report, rk, doc, s2)
    except Exception as exc:  # noqa: BLE001
        log.warning("method.json failed: %s", exc)
    return report


def cmd_adaptive(args) -> None:
    from pipeline.earth import adaptive
    adaptive.run(workers=args.workers, budget_s=args.budget)


def cmd_refine(args) -> None:
    from pipeline.earth import refine
    refine.run()


def cmd_nasadem(args) -> None:
    from pipeline.earth import nasadem_check
    sites = json.loads(STAGE2_SITES.read_text())
    nasadem_check.run([s["id"] for s in sites])


def cmd_documented(args) -> None:
    from pipeline.earth import screen
    screen.run_documented()


def cmd_pool(args) -> None:
    from pipeline.earth.pool import load_validation
    load_validation()


def main() -> None:
    ap = argparse.ArgumentParser(prog="python -m pipeline.earth")
    ap.add_argument("cmd", choices=["pool", "screen", "adaptive", "documented", "refine", "rank", "stage2", "nasadem",
                                       "transects", "report", "all"])
    ap.add_argument("--workers", type=int, default=24)
    ap.add_argument("--budget", type=float, default=2400.0)
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    setup_logging()
    t0 = time.time()
    steps = {"pool": [cmd_pool], "screen": [cmd_screen], "adaptive": [cmd_adaptive], "documented": [cmd_documented],
             "refine": [cmd_refine], "rank": [cmd_rank], "stage2": [cmd_stage2], "nasadem": [cmd_nasadem],
             "transects": [cmd_transects], "report": [cmd_report],
             "all": [cmd_pool, cmd_screen, cmd_adaptive, cmd_documented, cmd_refine, cmd_rank, cmd_stage2,
                     cmd_nasadem, cmd_transects, cmd_report]}[args.cmd]
    for fn in steps:
        t = time.time()
        fn(args)
        log.info("step %s done in %.0f s", fn.__name__, time.time() - t)
    log.info("total %.0f s", time.time() - t0)


if __name__ == "__main__":
    main()
