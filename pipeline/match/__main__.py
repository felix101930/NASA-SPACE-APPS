"""CLI: python -m pipeline.match [all|matches|summary] [--force] [--skip-classifier] [--skip-tests]

Idempotent: heavy pieces (Moon IQRs, Earth tile features, windows, two-sample tests, synthetic tests)
are cached in data/interim/match/ keyed on their inputs; --force recomputes everything. Re-run after
the Earth stage rewrites earth_sites.json: the site set is read fresh every time.
"""
from __future__ import annotations

import argparse
import logging
import time

from pipeline.match.common import (
    EARTH_SITES_JSON, INTERIM, MATCHES_JSON, REGIONS_JSON, ROOT, SUMMARY_JSON, TESTS_DIR, file_sig, make_meta,
    merge_sources, read_json, setup_logging, write_json,
)

log = logging.getLogger("pipeline.match")

WINDOWS_CACHE = INTERIM / "windows_cache.json"
C2ST_CACHE = INTERIM / "c2st_cache.json"
TESTS_CACHE = INTERIM / "synthetic_tests_cache.json"
STATE = INTERIM / "state.json"

EXTRA_SOURCES = [
    {"name": "Astropy (get_sun, AltAz refraction)", "url": "https://www.astropy.org/",
     "licence": "BSD-3-Clause",
     "citation": "Astropy Collaboration (2022), ApJ 935:167, doi:10.3847/1538-4357/ac7c74"},
    {"name": "Classifier two-sample test", "url": "https://arxiv.org/abs/1610.06545", "licence": "n/a (method)",
     "citation": "Lopez-Paz, D., Oquab, M. (2017). Revisiting Classifier Two-Sample Tests. ICLR 2017."},
]


def _load_json_or(path, default):
    try:
        return read_json(path)
    except Exception:  # noqa: BLE001
        return default


def attach_windows(matches: list[dict], moon_ref: dict, sites: list[dict], feats: dict) -> dict:
    from pipeline.match import windows as W
    by_id = {s["id"]: s for s in sites}
    cache = _load_json_or(WINDOWS_CACHE, {})
    stats = {"computed": 0, "cached": 0}
    for m in matches:
        s, f, moon = by_id[m["site_id"]], feats.get(m["site_id"]) or {}, moon_ref[m["region_id"]]
        el = W.target_el_for(m["hazard"], moon.get("sun"))
        if m["hazard"] == "shadow":
            az, az_note = W.shadow_target_az(moon, f, s, el)
        else:
            az, az_note = None, ("rim jumps do not depend on sun direction" if m["hazard"] == "rim" else
                                 "texture metric averages 8 sun directions; azimuth unconstrained")
        elev = f.get("elev_m") or 0.0
        key = f"{W.START_UTC}|{W.SEARCH_DAYS}|{s['lat']:.5f}|{s['lon']:.5f}|{elev:.0f}|{el:.2f}|{az}"
        if key in cache:
            wins, note = cache[key]["windows"], cache[key]["note"]
            stats["cached"] += 1
        else:
            wins, note = W.windows_for_match(float(s["lat"]), float(s["lon"]), float(elev), el, az)
            cache[key] = {"windows": wins, "note": note}
            stats["computed"] += 1
        m["windows"] = wins
        m["rehearsal"] = {"target_sun_el": el, "target_sun_az": az, "el_tolerance": W.EL_TOL_DEG,
                          "az_tolerance": W.AZ_TOL_DEG if az is not None else None,
                          "site_elev_m": round(float(elev)), "azimuth_note": az_note, "note": note,
                          "search": f"{W.START_UTC[:10]} + {W.SEARCH_DAYS} days, 2-min steps"}
    write_json(WINDOWS_CACHE, cache, indent=None)
    return stats


def cmd_all(args: argparse.Namespace) -> None:
    from pipeline.match import earth_feats, matches as MM, moon_ref, summary as SS, windows as W

    t_all = time.time()
    times = {}
    if args.force and INTERIM.exists():
        for p in INTERIM.glob("*.json"):
            p.unlink()
        log.info("--force: cleared %s", INTERIM.relative_to(ROOT))
    regions_doc = read_json(REGIONS_JSON)
    earth_doc = read_json(EARTH_SITES_JSON)
    regions, sites = regions_doc["regions"], earth_doc["sites"]
    log.info("inputs: %d regions, %d Earth sites (earth_sites.json generated %s%s)", len(regions), len(sites),
             earth_doc.get("meta", {}).get("generated_utc"), ", PARTIAL" if earth_doc.get("meta", {}).get("partial") else "")

    t = time.time()
    mref = moon_ref.load(force=args.force)
    times["moon_ref_s"] = round(time.time() - t, 1)
    t = time.time()
    feats = earth_feats.load(sites, force=args.force)
    times["earth_feats_s"] = round(time.time() - t, 1)

    t = time.time()
    matches, table, pool, pool_note, searches, coords = MM.build_matches(mref, sites, feats)
    val_ranks = MM.validation_ranks(table, pool, sites)
    times["matching_s"] = round(time.time() - t, 1)
    t = time.time()
    wstats = attach_windows(matches, mref, sites, feats)
    times["windows_s"] = round(time.time() - t, 1)
    log.info("windows: %s", wstats)

    sources = merge_sources(regions_doc.get("meta", {}).get("sources", []), earth_doc.get("meta", {}).get("sources", []),
                            EXTRA_SOURCES)
    emeta = earth_doc.get("meta", {})
    n_by = {}
    for s in sites:
        n_by[s.get("selected_by")] = n_by.get(s.get("selected_by"), 0) + 1
    method = {
        "distance": ("per metric: 1-D Wasserstein distance (|Δ| for scalars, mean |ΔQ| over 101 quantiles for "
                     "distributions) divided by the Moon region's IQR (spread across the 25 blocks of 3 km in the "
                     "15 km core; floored); hazard distance = weighted mean of its terms"),
        "term_weights": MM.TERM_WEIGHTS, "scale_floors": MM.SCALE_FLOORS, "shape_scalar_scales": MM.SHAPE_SCALAR_SCALES,
        "brightness_rank_scale": MM.BRIGHT_RANK_SCALE,
        "lights": "green: Earth value inside moon_iqr (Moon value ± IQR/2); amber: inside a band twice as wide; red: beyond",
        "candidate_pool": (f"{pool_note}: selected_by global_screen/refine, documented (seed split only), validation "
                           "listed_candidate; held-out positives, split=holdout and decoys are scored for validation "
                           "only and can never be a match"),
        "novelty_rule": MM.NOVELTY_RULE, "novelty_km": MM.NOVELTY_KM,
        "n_pool": len(pool), "n_sites_by_source": n_by,
        "earth_sites_snapshot": {"generated_utc": emeta.get("generated_utc"), "pipeline_version": emeta.get("pipeline_version"),
                                 "partial": emeta.get("partial", False), "sig": file_sig(EARTH_SITES_JSON)},
        "windows": {"start_utc": W.START_UTC + "Z", "days": W.SEARCH_DAYS, "el_tolerance_deg": W.EL_TOL_DEG,
                    "az_tolerance_deg": W.AZ_TOL_DEG, "target_el": {"shadow": "region sun-range minimum clamped to [1, 5]°",
                                                                     **{k: v for k, v in W.TARGET_EL.items()}},
                    "refraction": "astropy AltAz, ICAO standard atmosphere at the site elevation, RH 50%, 0.55 µm",
                    "refraction_sensitive_below_deg": W.REFRACTION_SENSITIVE_DEG},
    }
    write_json(MATCHES_JSON, {"meta": make_meta(sources, method=method), "matches": matches, "searches": searches})

    # ---------------- summary
    t = time.time()
    rank = SS.ranking(matches, regions)
    auc, auc_detail = SS.known_vs_decoy(val_ranks)
    stab = SS.weight_stability(table, pool, coords=coords)
    times["weight_stability_s"] = round(time.time() - t, 1)
    t = time.time()
    if args.skip_classifier:
        c2st = {"per_region_auc": {}, "top_features": [], "note": "skipped (--skip-classifier)"}
    else:
        cc = _load_json_or(C2ST_CACHE, {})
        c2st = SS.classifier_panel(matches, regions, sites, cache=cc)
        write_json(C2ST_CACHE, cc, indent=None)
    times["classifier_s"] = round(time.time() - t, 1)
    t = time.time()
    tsig = file_sig(TESTS_DIR / "test_metrics.py", *sorted((ROOT / "pipeline" / "metrics").glob("*.py")))
    tc = _load_json_or(TESTS_CACHE, {})
    if args.skip_tests and tc.get("results"):
        tests = tc["results"]
    elif tc.get("sig") == tsig and tc.get("results"):
        tests = tc["results"]
    elif args.skip_tests:
        tests = []
    else:
        tests = SS.synthetic_tests()
        write_json(TESTS_CACHE, {"sig": tsig, "results": tests}, indent=None)
    times["synthetic_tests_s"] = round(time.time() - t, 1)
    cov, cov_src = SS.coverage_pct()
    validation = {
        "shadow_vs_pgda": SS.shadow_vs_pgda(),
        "known_vs_decoy_auc": auc,
        "known_vs_decoy_detail": auc_detail,
        "weight_stability_jaccard": stab["mean"],
        "weight_stability_detail": stab,
        "classifier_two_sample": c2st,
        "synthetic_tests": tests,
        "where_it_fails": SS.where_it_fails(),
        "earth_coverage_pct_bare": cov, "earth_coverage_source": cov_src,
        "heldout_ranks": val_ranks,
    }
    wf = SS.walk_findback()
    if wf is not None:
        validation["walk_findback"] = wf
    shortfalls = [f"{x['region_id']}|{x['hazard']}" for x in searches if x["novelty_shortfall"]]
    times["total_s"] = round(time.time() - t_all, 1)
    write_json(SUMMARY_JSON, {"meta": make_meta(sources, earth_sites_snapshot=method["earth_sites_snapshot"],
                                                ranking_method=(f"rehearsability = 1 / (1 + mean best distance + "
                                                                f"{SS.GAP_PENALTY} × Σ max(0, best distance − {SS.CLOSE_DISTANCE})) "
                                                                "over the 3 hazards; distance 1 ≈ one Moon-region IQR off"),
                                                runtimes=times),
                              "ranking": rank, "validation": validation,
                              "notes": {"novelty_rule": MM.NOVELTY_RULE,
                                        "novelty_shortfall_searches": shortfalls,
                                        "best_documented": {f"{x['region_id']}|{x['hazard']}": x["best_documented"]
                                                            for x in searches}}})
    write_json(STATE, {"times": times, "windows": wstats})
    log.info("done in %.1f s: %s", time.time() - t_all, times)


def main() -> None:
    ap = argparse.ArgumentParser(prog="python -m pipeline.match", description=__doc__)
    ap.add_argument("cmd", nargs="?", default="all", choices=["all"])
    ap.add_argument("--force", action="store_true", help="recompute all cached pieces")
    ap.add_argument("--skip-classifier", action="store_true")
    ap.add_argument("--skip-tests", action="store_true", help="reuse cached synthetic-test results if any")
    args = ap.parse_args()
    setup_logging()
    {"all": cmd_all}[args.cmd](args)


if __name__ == "__main__":
    main()
