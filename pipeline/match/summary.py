"""summary.json: region ranking (easiest -> hardest to rehearse) and the validation panel."""
from __future__ import annotations

import csv
import json
import logging
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np

from pipeline.match.common import (
    EARTH_INTERIM, HAZARDS, METHOD_JSON, MOON_INTERIM, ROOT, TESTS_DIR, finite, read_json, read_tile,
)
from pipeline.match.matches import TERM_WEIGHTS, TOP_K, top_k

log = logging.getLogger("pipeline.match.summary")

CLOSE_DISTANCE = 1.0          # best match within ~1 Moon-region IQR on average = "close"
GAP_PENALTY = 0.5             # extra cost per unit of distance beyond CLOSE_DISTANCE, per hazard
N_WEIGHT_DRAWS = 200
WEIGHT_JITTER = 0.20
WEIGHT_SEED = 20261115
HAZARD_WORDS = {"shadow": "low-sun shadows", "rim": "rim height jumps", "texture": "camera-navigation texture"}


# ------------------------------------------------------------------ ranking
def rehearsability(best: dict[str, float | None]) -> float:
    """1 / (1 + mean best distance + GAP_PENALTY * sum of excess over CLOSE_DISTANCE); missing hazard = 3."""
    d = [float(best[h]) if finite(best.get(h)) else 3.0 for h in HAZARDS]
    excess = sum(max(0.0, x - CLOSE_DISTANCE) for x in d)
    return 1.0 / (1.0 + float(np.mean(d)) + GAP_PENALTY * excess)


def ranking(matches: list[dict], regions: list[dict]) -> list[dict]:
    names = {r["id"]: r.get("name", r["id"]) for r in regions}
    best: dict[str, dict[str, dict]] = {r["id"]: {} for r in regions}
    for m in matches:
        if m["rank"] == 1:
            best[m["region_id"]][m["hazard"]] = m
    rows = []
    for rid, b in best.items():
        dist = {h: (round(b[h]["distance"], 4) if h in b else None) for h in HAZARDS}
        score = rehearsability(dist)
        avail = {h: v for h, v in dist.items() if v is not None}
        weakest = max(avail, key=avail.get) if avail else None
        far = [h for h, v in dist.items() if v is None or v > CLOSE_DISTANCE]
        if weakest is None:
            reason = "No Earth site could be scored for this region."
        else:
            w = b[weakest]
            site = w.get("site_name") or w["site_id"]
            if not far:
                reason = (f"All three hazards have a close Earth match; the weakest is {HAZARD_WORDS[weakest]} "
                          f"(best: {site}, {dist[weakest]:.2f} Moon-IQRs off).")
            else:
                miss = ", ".join(HAZARD_WORDS[h] for h in far)
                reason = (f"No close Earth match for {miss}; weakest is {HAZARD_WORDS[weakest]} "
                          f"(best: {site}, {dist[weakest]:.2f} Moon-IQRs off).")
        rows.append({"region_id": rid, "region_name": names[rid], "rehearsability": round(score, 4),
                     "per_hazard_best_distance": dist,
                     "per_hazard_best_site": {h: (b[h]["site_id"] if h in b else None) for h in HAZARDS},
                     "weakest_hazard": weakest, "reason": reason})
    rows.sort(key=lambda r: -r["rehearsability"])
    for i, r in enumerate(rows, start=1):
        r["rank"] = i
    return [{"region_id": r["region_id"], "rank": r["rank"], **{k: v for k, v in r.items() if k not in ("region_id", "rank")}}
            for r in rows]


# ------------------------------------------------------------------ validation pieces
def shadow_vs_pgda() -> dict:
    p = MOON_INTERIM / "validation_pgda.json"
    if not p.exists():
        return {"pearson_r": None, "mae": None, "bias": None, "n_px": None, "note": "validation_pgda.json missing"}
    v = read_json(p)["shadow_vs_pgda"]
    return {"pearson_r": round(v["pearson_r"], 4), "mae": round(v["mae"], 4), "bias": round(v["bias"], 4),
            "n_px": v["n_px"], "region_mean_pearson_r": round(v.get("region_mean_pearson_r", float("nan")), 4),
            "n_regions": sum(1 for r in v.get("per_region", {}).values() if r.get("included")),
            "note": v.get("note", "")}


def _find_key(o: object, key: str) -> object:
    if isinstance(o, dict):
        if key in o:
            return o[key]
        for v in o.values():
            r = _find_key(v, key)
            if r is not None:
                return r
    return None


def _auc(pos: list[float], neg: list[float]) -> float | None:
    """P(positive ranks better = smaller value than a decoy); ties count half."""
    if not pos or not neg:
        return None
    pairs = [(1.0 if a < b else 0.5 if a == b else 0.0) for a in pos for b in neg]
    return round(float(np.mean(pairs)), 3)


def known_vs_decoy(val_ranks: dict) -> tuple[float | None, dict]:
    """AUC known analogs vs decoys. Preference: method.json / screen_report.json (Earth stage, stage-1 search
    over ~4.7 k screened windows), else recomputed from stage1_ranking.json. Also the final 30 m search here."""
    detail: dict = {}
    src_auc = None
    if METHOD_JSON.exists():
        mv = read_json(METHOD_JSON).get("validation", {})
        if mv.get("auc") is not None:
            src_auc = mv["auc"]
            detail.update(source="method.json validation.auc (stage-1 best rank)",
                          known_median_pct=mv.get("known_median_pct"), decoy_median_pct=mv.get("decoy_median_pct"))
    rep = EARTH_INTERIM / "screen_report.json"
    if rep.exists():
        r = read_json(rep)
        a13, a_ext = _find_key(r, "known_vs_decoy_auc_best_rank"), _find_key(r, "known_ext_vs_decoy_auc_best_rank")
        detail["screen_report_auc_original13"], detail["screen_report_auc_with_heldout_documented"] = a13, a_ext
        if src_auc is None and a13 is not None:
            src_auc, detail["source"] = a13, "screen_report.json known_vs_decoy_auc_best_rank (stage-1)"
    rk_p = EARTH_INTERIM / "stage1_ranking.json"
    clean = ROOT / "data" / "earth_sites_clean.csv"
    if rk_p.exists() and clean.exists():
        best = read_json(rk_p).get("best_rank", {})
        rows = list(csv.DictReader(clean.open(encoding="utf-8")))
        kn = [best[r["id"]] for r in rows if r.get("role") == "heldout_positive" and best.get(r["id"])]
        de = [best[r["id"]] for r in rows if r.get("role") == "decoy" and best.get(r["id"])]
        detail["recomputed_stage1_auc_original13"] = _auc(kn, de)
        detail["recomputed_stage1_n"] = {"known": len(kn), "decoy": len(de)}
        ext = _heldout_documented_ids()
        n_ext = sum(1 for i in ext if best.get(i))
        if n_ext:
            kx = kn + [best[i] for i in ext if best.get(i)]
            detail["recomputed_stage1_auc_with_heldout_documented"] = _auc(kx, de)
            detail["recomputed_stage1_n"]["heldout_documented"] = n_ext
        elif ext:
            detail["heldout_documented_note"] = (f"{len(ext)} held-out documented analogs exist but none has a "
                                                 "stage-1 rank yet; AUC uses the original 13 only")
        if src_auc is None:
            src_auc = detail["recomputed_stage1_auc_original13"]
            detail["source"] = ("recomputed here from data/interim/earth/stage1_ranking.json best ranks "
                                "(original 13 known analogs vs decoys); method.json/screen_report.json not yet written")
    pos = [v["best_rank"] for v in val_ranks.values() if v["role"] in ("heldout_positive", "heldout_positive_ext")]
    neg = [v["best_rank"] for v in val_ranks.values() if v["role"] == "decoy"]
    detail["final_30m_auc"] = _auc(pos, neg)
    detail["final_30m_n"] = {"known": len(pos), "decoy": len(neg)}
    if not neg:
        detail["final_30m_note"] = "no decoys in the current earth_sites.json snapshot; final-stage AUC not computable"
    detail["positive_set"] = ("original 13 hand-listed known analogs (role heldout_positive)"
                              + (" + held-out documented analogs (split=holdout) where reported" if
                                 detail.get("recomputed_stage1_auc_with_heldout_documented") is not None
                                 or detail.get("screen_report_auc_with_heldout_documented") is not None else ""))
    return src_auc, detail


def _heldout_documented_ids() -> list[str]:
    """Held-out documented analogs (split=holdout, not duplicates), via the Earth stage loader if importable."""
    try:
        from pipeline.earth.pool import load_documented
        return [s.id for s in load_documented() if s.role == "heldout_positive" and not s.extra.get("dup_of")]
    except Exception as exc:  # noqa: BLE001 - the Earth stage is being edited concurrently
        log.info("documented held-out set unavailable (%s)", exc)
        return []


def weight_stability(table: dict, pool: set[str], n: int = N_WEIGHT_DRAWS, jitter: float = WEIGHT_JITTER,
                     seed: int = WEIGHT_SEED, coords: dict | None = None) -> dict:
    """Mean Jaccard overlap of top-3 sets (same novelty-constrained picking) under per-term weight jitter U(1-j, 1+j)."""
    base = {k: {s for s, _ in v} for k, v in top_k(table, pool, coords=coords).items()}
    rng = np.random.default_rng(seed)
    per_draw = []
    per_search = {k: [] for k in base}
    for _ in range(n):
        w = {h: {t: v * float(rng.uniform(1 - jitter, 1 + jitter)) for t, v in ws.items()} for h, ws in TERM_WEIGHTS.items()}
        tops = top_k(table, pool, weights=w, coords=coords)
        js = []
        for k, b in base.items():
            s = {x for x, _ in tops[k]}
            j = len(b & s) / len(b | s) if (b | s) else 1.0
            js.append(j)
            per_search[k].append(j)
        per_draw.append(float(np.mean(js)))
    worst = sorted(((float(np.mean(v)), k) for k, v in per_search.items()))[:3]
    return {"mean": round(float(np.mean(per_draw)), 4) if per_draw else 1.0, "n_draws": n, "jitter": f"±{int(jitter * 100)}%",
            "seed": seed, "least_stable": [{"search": k, "jaccard": round(v, 3)} for v, k in worst]}


def classifier_panel(matches: list[dict], regions: list[dict], sites: list[dict], cache: dict | None = None) -> dict:
    """Two-sample test per region x top-1 site. ``cache`` ({key: result}) is updated in place."""
    from pipeline.common.config import WEB_DATA
    from pipeline.match.classifier import FEATURES, two_sample_test
    from pipeline.match.common import file_sig
    cache = {} if cache is None else cache
    tiles = {s["id"]: s.get("tile", {}).get("path") for s in sites}
    reg = {r["id"]: r for r in regions}
    per_pair, per_region = [], {}
    moon_cache: dict[str, np.ndarray | None] = {}
    done: dict[tuple[str, str], dict] = {}
    for m in matches:
        if m["rank"] != 1:
            continue
        rid, sid = m["region_id"], m["site_id"]
        ckey = f"{rid}|{sid}|{file_sig(WEB_DATA / reg[rid]['tile']['path'], WEB_DATA / (tiles.get(sid) or 'none'))}"
        if (rid, sid) not in done and ckey in cache:
            done[(rid, sid)] = cache[ckey]
        if (rid, sid) not in done:
            if rid not in moon_cache:
                moon_cache[rid] = read_tile(reg[rid]["tile"]["path"])
            e = read_tile(tiles[sid]) if tiles.get(sid) else None
            if moon_cache[rid] is None or e is None:
                continue
            done[(rid, sid)] = cache[ckey] = two_sample_test(moon_cache[rid], e, seed=0)
        r = done[(rid, sid)]
        per_pair.append({"region_id": rid, "hazard": m["hazard"], "site_id": sid, "auc": r.get("auc"),
                         "lr_auc": r.get("lr_auc"), "rf_auc": r.get("rf_auc"),
                         "top_feature": max(r["importance"], key=r["importance"].get) if r.get("importance") else None})
    for rid in reg:
        v = [p["auc"] for p in per_pair if p["region_id"] == rid and p["auc"] is not None]
        per_region[rid] = round(float(np.mean(v)), 3) if v else None
    imp = {f: float(np.mean([r["importance"].get(f, 0.0) for r in done.values() if r.get("importance")] or [0.0]))
           for f in FEATURES}
    top = [{"feature": f, "importance": round(v, 4)} for f, v in sorted(imp.items(), key=lambda kv: -kv[1])]
    allv = [p["auc"] for p in per_pair if p["auc"] is not None]
    return {"per_region_auc": per_region, "top_features": top, "per_pair": per_pair,
            "mean_auc": round(float(np.mean(allv)), 3) if allv else None,
            "method": ("Lopez-Paz & Oquab (2017) classifier two-sample test on 1 km sub-tiles of the 30 m tiles "
                       "(each region vs its top-1 Earth site per hazard); logistic regression and a 100-tree depth-4 "
                       "random forest; StratifiedGroupKFold(6) grouped by 5 km block; reported AUC = the better of the "
                       "two (out-of-fold); importance = permutation drop in AUC on held-out folds. 0.5 = "
                       "indistinguishable, 1.0 = trivially separable."),
            "features": list(FEATURES)}


def synthetic_tests() -> list[dict]:
    """Run tests/test_metrics.py with pytest in a subprocess; one row per test (name, passed)."""
    path = TESTS_DIR / "test_metrics.py"
    if not path.exists():
        return []
    with tempfile.TemporaryDirectory() as td:
        xml = Path(td) / "junit.xml"
        proc = subprocess.run([sys.executable, "-m", "pytest", str(path), "-q", "-p", "no:cacheprovider",
                               f"--junitxml={xml}"], cwd=ROOT, capture_output=True, text=True, timeout=900)
        if not xml.exists():
            log.warning("pytest produced no report: %s", proc.stdout[-500:])
            return [{"name": "test_metrics.py", "passed": False}]
        out = []
        for tc in ET.parse(xml).getroot().iter("testcase"):
            failed = any(ch.tag in ("failure", "error") for ch in tc)
            skipped = any(ch.tag == "skipped" for ch in tc)
            out.append({"name": tc.get("name"), "passed": not failed and not skipped,
                        **({"skipped": True} if skipped else {})})
        return out


def coverage_pct() -> tuple[str | None, str]:
    if METHOD_JSON.exists():
        v = read_json(METHOD_JSON).get("screen", {}).get("coverage_pct_bare")
        if v is not None:
            return f"{v:g}", "method.json screen.coverage_pct_bare"
    p = EARTH_INTERIM / "screen_draw_stats.json"
    if p.exists():
        cov = read_json(p).get("coverage", {})
        rng = cov.get("pct_of_bare_land_range")
        if rng:
            return f"{rng[0]:.0f}–{rng[1]:.0f}", "data/interim/earth/screen_draw_stats.json coverage.pct_of_bare_land_range"
    return None, "unavailable"


def where_it_fails() -> list[str]:
    x, _ = coverage_pct()
    return [
        "Boulders smaller than ~30 m are invisible: both worlds are compared on a 30 m grid",
        "Earth skylight fills shadows; lunar shadows are pitch black, so shadow contrast is understated on Earth",
        "Vegetation and buildings sit inside the Copernicus surface model; we mask them with ESA WorldCover "
        "(DSM-safe filter) but low shrubs and grass remain",
        "Atmospheric refraction near the horizon: windows with the sun below 1° are refraction-sensitive "
        "(a few tenths of a degree can shift them by minutes)",
        "Low sun lasts minutes on Earth but days on the Moon, so rehearsal windows are short",
        (f"The Earth search covers only ~{x}% of the planet's bare land (a seeded sample of 15 km windows), "
         "so better analogs may exist unsampled") if x else
        "The Earth search covers only a seeded sample of bare land, so better analogs may exist unsampled",
        "Metrics describe terrain shape and lighting geometry only, not regolith, rock strength or dust",
    ]


def walk_findback() -> dict | None:
    """validation.walk_findback from web/public/data/walk/findback.json (written by the walk agent), if present."""
    from pipeline.common.config import WEB_DATA
    p = WEB_DATA / "walk" / "findback.json"
    if not p.exists():
        return None
    try:
        d = read_json(p)
    except Exception as exc:  # noqa: BLE001
        log.warning("findback.json unreadable (%s); walk_findback omitted", exc)
        return None
    out = {k: _find_key(d, k) for k in ("winner", "top1", "top5", "n_routes")}
    # findback.json keeps top1/top5 per matcher; report the winner's scores plus the app-default DTW for contrast.
    matchers = d.get("matchers") if isinstance(d, dict) else None
    if isinstance(matchers, list):
        by_name = {m.get("name"): m for m in matchers if isinstance(m, dict)}
        win = by_name.get(out.get("winner"))
        if win is not None:
            out["top1"], out["top5"] = win.get("top1"), win.get("top5")
        if "dtw_slope" in by_name:
            out["dtw_top1"] = by_name["dtw_slope"].get("top1")
    return out if any(v is not None for v in out.values()) else None
