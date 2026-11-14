"""Stage-1 ranking: distance of every screened 90 m window to each Moon region, per hazard.

Moon side: data/interim/moon/fingerprints_90m.json (moon-builder; 20 m near field area-averaged
to 90 m, 45 km window, local horizon only: same construction as the Earth screen).

Per region x hazard the distance is the mean of its components:
- shadow : W1 of the per-pixel shadowed-azimuth fraction at el 1, 3, 5 deg (local proxy), each
           divided by max(Moon IQR, 0.05).
- rim    : W1 of pooled 1 km jump samples / max(Moon IQR, 10 m); |frac_track_over_500m diff| / s.
- texture: (stage-1 proxy, no FAST at 90 m) W1 of slope / max(Moon IQR, 1 deg) and the ν(L)
           roughness at 180/360/720/1440 m as |diff| / s.
W1 is computed from 101 quantiles (mean |Q_earth - Q_moon|). Scalar scales s are the IQR of that
metric over the screened Earth population. Validation rows are ranked "as if" they competed
(rank = 1 + number of eligible windows strictly closer) but never selected.
"""
from __future__ import annotations

import json
import logging
import math

import numpy as np

from pipeline.common.config import INTERIM as INTERIM_ROOT
from pipeline.common.config import REGION_IDS
from pipeline.earth.common import INTERIM
from pipeline.earth.screen import load_fingerprints, load_quantiles

log = logging.getLogger("pipeline.earth.rank_stage1")

MOON_FP = INTERIM_ROOT / "moon" / "fingerprints_90m.json"
RANK_JSON = INTERIM / "stage1_ranking.json"
TOP_K = 15
MAX_SELECTED = 120   # lower top_k (down to 8) until the deduplicated union fits
HAZ = ("shadow", "rim", "texture")
EL = (1, 3, 5)
NU = (180, 360, 720, 1440)


def _iqr(q: np.ndarray) -> float:
    return float(q[75] - q[25])


def load_moon() -> dict[str, dict]:
    d = json.loads(MOON_FP.read_text())["regions"]
    out = {}
    for rid, v in d.items():
        s = v["scalars"]
        q = {k: np.array(x, float) for k, x in v["quantiles_101"].items()}
        out[rid] = {"s": {"frac_track_over_500m": s["frac_track_over_500m"],
                          **{f"nu_{L}": s["rms_dev_m"][str(L)] for L in NU}}, "q": q}
    return out


def _w1(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.nanmean(np.abs(a - b)))


def scalar_scales(rows: list[dict]) -> dict[str, float]:
    scal = {}
    for k in ["frac_track_over_500m"] + [f"nu_{L}" for L in NU]:
        v = np.array([r.get(k, np.nan) for r in rows if r["selected_by"] == "global_screen"
                      and str(r["id"])[0] in "SA"], float)
        v = v[np.isfinite(v)]
        iqr = float(np.percentile(v, 75) - np.percentile(v, 25)) if v.size else 1.0
        scal[k] = max(iqr, 0.01 if k.startswith("frac") else 1.0)
    return scal


def _wmean(terms: list[tuple[float, float]]) -> float:
    t = [(v, w) for v, w in terms if v is not None and math.isfinite(v)]
    return float(sum(v * w for v, w in t) / sum(w for _, w in t)) if t else float("nan")


USE_EXTRAS = True   # shape + brightness terms when pipeline.metrics.shape/brightness and Moon extras exist


def load_extras(rows: list[dict]) -> dict | None:
    """Shape features, brightness ranks and Moon extras for all rows (computes missing ones)."""
    from pipeline.earth import extras
    if not (USE_EXTRAS and extras.available()):
        return None
    shape = extras.enrich_shape(rows)
    bright = extras.enrich_brightness(rows)
    return {"shape": shape, "branks": extras.brightness_ranks(rows, bright), "moon": extras.load_moon_extra(),
            "scales": extras.scalar_scales(rows, shape)}


def distances(rows: list[dict], quants: dict[str, dict], moon: dict[str, dict],
              scal: dict[str, float] | None = None, quiet: bool = False,
              xt: dict | None = None) -> dict[str, np.ndarray]:
    """{f'{region}|{hazard}': distance array aligned with rows} (NaN when not computable).

    xt (from load_extras) adds: rim += shape sub-term; shadow += aspect sub-term + brightness (w 0.5);
    texture += brightness (w 0.5). Each existing metric has weight 1."""
    scal = scal or scalar_scales(rows)
    if not quiet:
        log.info("scalar scales (Earth population IQR): %s", {k: round(v, 3) for k, v in scal.items()})
    out = {}
    for rid, m in moon.items():
        mq, ms = m["q"], m["s"]
        sh_scale = {el: max(_iqr(mq[f"shadow_az_frac_el{el}_local"]), 0.05) for el in EL}
        j_scale = max(_iqr(mq["jump1km_m"]), 10.0)
        s_scale = max(_iqr(mq["slope_deg"]), 1.0)
        d = {h: np.full(len(rows), np.nan) for h in HAZ}
        for i, r in enumerate(rows):
            q = quants.get(r["id"])
            if q is None or r.get("status") != "ok":
                continue
            x = {"rim_shape": float("nan"), "shadow_aspect": float("nan"), "bright": float("nan")}
            if xt is not None and rid in xt["moon"]:
                from pipeline.earth.extras import BRIGHT_WEIGHT, extra_terms
                x = extra_terms(r["id"], rid, xt["shape"], xt["branks"], xt["moon"], xt["scales"])
                bw = BRIGHT_WEIGHT
            else:
                bw = 0.0
            d["shadow"][i] = _wmean([(_w1(q[f"shadow_az_frac_el{el}_local"], mq[f"shadow_az_frac_el{el}_local"])
                                      / sh_scale[el], 1.0) for el in EL]
                                    + [(x["shadow_aspect"], 1.0), (x["bright"], bw)])
            d["rim"][i] = _wmean([(_w1(q["jump1km_m"], mq["jump1km_m"]) / j_scale, 1.0),
                                  (abs(r["frac_track_over_500m"] - ms["frac_track_over_500m"])
                                   / scal["frac_track_over_500m"], 1.0),
                                  (x["rim_shape"], 1.0)])
            d["texture"][i] = _wmean([(_w1(q["slope_deg"], mq["slope_deg"]) / s_scale, 1.0)]
                                     + [(abs(r[f"nu_{L}"] - ms[f"nu_{L}"]) / scal[f"nu_{L}"], 1.0) for L in NU]
                                     + [(x["bright"], bw)])
        for h in HAZ:
            out[f"{rid}|{h}"] = d[h]
    return out


def rank(top_k: int = TOP_K, max_selected: int = MAX_SELECTED, fp_path=None, q_path=None, out_path=None,
         apply_refine: bool = True, rows: list[dict] | None = None, write: bool = True,
         use_extras: bool = True) -> dict:
    """Rank, choosing the largest top_k <= TOP_K whose deduplicated union is <= max_selected."""
    rows = rows if rows is not None else load_fingerprints(fp_path)
    quants = load_quantiles(q_path)
    moon = load_moon()
    xt = load_extras(rows) if (use_extras and fp_path is None) else None
    D = distances(rows, quants, moon, xt=xt)
    replaced = _replaced_ids() if apply_refine else set()
    res = None
    for k in range(top_k, 7, -1):
        res = _rank_with(rows, D, k, replaced)
        if len(res["selected"]) <= max_selected:
            break
    res["best_dist"] = {}
    for key, d in D.items():
        for i, r in enumerate(rows):
            if np.isfinite(d[i]) and (r["id"] not in res["best_dist"] or d[i] < res["best_dist"][r["id"]]):
                res["best_dist"][r["id"]] = float(d[i])
    idx = {r["id"]: i for i, r in enumerate(rows)}
    res["best_dist_per_search"] = {k: float(D[k][idx[v["top"][0]]]) for k, v in res["searches"].items() if v["top"]}
    res["mean_topk_dist_per_search"] = {k: float(np.mean([D[k][idx[t]] for t in v["top"]]))
                                        for k, v in res["searches"].items() if v["top"]}
    res["mean_best_dist"] = float(np.mean(list(res["best_dist_per_search"].values())))
    res["features"] = ("base+aspect+brightness" if xt is not None else "base")
    if write:
        (out_path or RANK_JSON).write_text(json.dumps(res))
    log.info("stage-1 ranking: %d eligible windows, %d searches, %d unique selected (top %d each)",
             res["n_eligible"], len(D), len(res["selected"]), res["top_k"])
    return res


REFINE_JSON = INTERIM / "refine.json"


def _replaced_ids() -> set[str]:
    """Originals replaced by zoom-in refined windows (see refine.py)."""
    if REFINE_JSON.exists():
        return set(json.loads(REFINE_JSON.read_text()).get("replaced_ids", []))
    return set()


def _rank_with(rows: list[dict], D: dict[str, np.ndarray], top_k: int, replaced: set[str]) -> dict:
    missing = [r for r in REGION_IDS if r not in {k.split("|")[0] for k in D}]
    if missing:
        log.warning("Moon fingerprints missing for %s", missing)
    eligible = np.array([r["selected_by"] == "global_screen" and int(r.get("eligible_discovery") or 0) == 1
                         and r.get("status") == "ok" and (r.get("core_nan_frac") or 0) < 0.05
                         and r["id"] not in replaced for r in rows])
    n_elig = int(eligible.sum())
    per_search = {}
    best_rank = {r["id"]: math.inf for r in rows}
    best_search = {}
    selected: dict[str, list[str]] = {}
    for key, d in D.items():
        de = d[eligible]
        order = np.argsort(np.where(np.isfinite(de), de, np.inf))
        elig_ids = np.array([r["id"] for r in rows])[eligible]
        top = [str(x) for x in elig_ids[order[:top_k]]]
        for k, sid in enumerate(top):
            selected.setdefault(sid, []).append(f"{key}#{k + 1}")
        sorted_de = np.sort(de[np.isfinite(de)])
        ranks = {}
        for i, r in enumerate(rows):
            if not np.isfinite(d[i]):
                continue
            rk = int(np.searchsorted(sorted_de, d[i], side="left")) + (0 if eligible[i] else 0) + 1
            ranks[r["id"]] = rk
            if rk < best_rank[r["id"]]:
                best_rank[r["id"]] = rk
                best_search[r["id"]] = key
        per_search[key] = {"top": top, "ranks": ranks, "n_eligible": n_elig}
    res = {"top_k": top_k, "n_eligible": n_elig, "selected": selected,
           "best_rank": {k: (None if v == math.inf else int(v)) for k, v in best_rank.items()},
           "best_search": best_search,
           "searches": {k: {"top": v["top"]} for k, v in per_search.items()},
           "ranks": {k: v["ranks"] for k, v in per_search.items()}}
    return res


def _positive_sets(rows: list[dict]) -> dict[str, list[str]]:
    """heldout_positive = original 13 CSV analogs; heldout_positive_ext = + documented holdouts not within
    20 km of an original positive (deduplicated)."""
    from pipeline.earth.pool import load_documented
    dup = {s.id: s.extra.get("dup_of") for s in load_documented()}
    orig = [r["id"] for r in rows if r.get("role") == "heldout_positive" and not str(r["id"]).startswith("LA")]
    ext = orig + [r["id"] for r in rows if r.get("role") == "heldout_positive" and str(r["id"]).startswith("LA")
                  and not dup.get(r["id"])]
    indep = [i for i in ext if str(i).startswith("LA")]
    return {"heldout_positive": orig, "heldout_positive_ext": ext, "heldout_positive_indep": indep}


def funnel(rank_res: dict, rows: list[dict] | None = None) -> dict:
    """Where known analogs and decoys fall in the stage-1 rankings."""
    rows = rows or load_fingerprints()
    by_id = {r["id"]: r for r in rows}
    n = rank_res["n_eligible"]
    out = {}
    pos = _positive_sets(rows)
    for role in ("heldout_positive", "heldout_positive_ext", "heldout_positive_indep", "decoy", "listed_candidate"):
        ids = pos[role] if role in pos else [r["id"] for r in rows if r.get("role") == role]
        bare = [i for i in ids if int(by_id[i].get("dsm_pass", by_id[i].get("bare_pass")) or 0) == 1]
        strict = [i for i in ids if int(by_id[i].get("bare_pass") or 0) == 1]
        per = {}
        for key, ranks in rank_res["ranks"].items():
            pct = [100.0 * ranks[i] / n for i in ids if i in ranks]
            per[key] = {"median_pct": round(float(np.median(pct)), 1) if pct else None,
                        "n_in_top_k": sum(1 for i in ids if ranks.get(i, math.inf) <= rank_res["top_k"])}
        best = [rank_res["best_rank"].get(i) for i in ids]
        best = [b for b in best if b is not None]
        out[role] = {
            "n": len(ids), "n_pass_filter": len(bare), "n_pass_strict_rule": len(strict),
            "n_survive_stage2_cut_any_search": sum(1 for b in best if b <= rank_res["top_k"]),
            "n_survive_stage2_cut_and_filter": sum(1 for i in bare if (rank_res["best_rank"].get(i) or math.inf) <= rank_res["top_k"]),
            "best_rank_median_pct": round(float(np.median([100.0 * b / n for b in best])), 2) if best else None,
            "per_search": per,
            "ids_all": ids,
            "ids_surviving": [i for i in ids if (rank_res["best_rank"].get(i) or math.inf) <= rank_res["top_k"]],
            "ids_surviving_with_filter": [i for i in bare if (rank_res["best_rank"].get(i) or math.inf) <= rank_res["top_k"]],
        }
    # AUC known vs decoy on best rank across searches (lower = more Moon-like)
    de = [rank_res["best_rank"][r["id"]] for r in rows if r.get("role") == "decoy" and rank_res["best_rank"].get(r["id"])]
    for name, key in (("heldout_positive", "known_vs_decoy_auc_best_rank"),
                      ("heldout_positive_ext", "known_ext_vs_decoy_auc_best_rank"),
                      ("heldout_positive_indep", "known_indep_vs_decoy_auc_best_rank")):
        kn = [rank_res["best_rank"][i] for i in pos[name] if rank_res["best_rank"].get(i)]
        pairs = [(1.0 if a < b else 0.5 if a == b else 0.0) for a in kn for b in de]
        out[key] = round(float(np.mean(pairs)), 3) if pairs else None
    out["feature_selection_note"] = ("shape rim term excluded because it lowered known-vs-decoy AUC (0.80 -> 0.70); "
                                     "selection used the original 13 known analogs")
    out["extended_auc_note"] = ("the extended-set AUC partly overlaps the selection set (it contains the original 13); "
                                "heldout_positive_indep = documented hold-outs not within 20 km of the original 13 is "
                                "the independent test")
    out["positives_failing_dsm_safe"] = [i for i in pos["heldout_positive_ext"]
                                         if not int(by_id[i].get("dsm_pass", by_id[i].get("bare_pass")) or 0)]
    return out


def loosening_effects(rows: list[dict] | None = None) -> dict:
    """How many validation rows would pass the bare filter at looser thresholds (coarse shares)."""
    rows = rows or load_fingerprints()
    res = {}
    for thr in (0.6, 0.5, 0.4, 0.3, 0.2):
        for role in ("heldout_positive", "decoy"):
            sel = [r for r in rows if r.get("role") == role]
            ok = [r for r in sel if (r["wc_bare"] + r["wc_moss"]) >= thr and r["wc_snow"] < 0.3 and r["wc_land"] >= 0.5]
            res.setdefault(f"strict_bare_moss>={thr}", {})[role] = f"{len(ok)}/{len(sel)}"
    if rows and "wc_tree" in rows[0]:
        for tmax in (0.05, 0.10, 0.20, 0.30):
            for role in ("heldout_positive", "decoy"):
                sel = [r for r in rows if r.get("role") == role]
                ok = [r for r in sel if r["wc_tree"] <= tmax and r["wc_built"] <= 0.05 and r["wc_crop"] <= 0.20
                      and r["wc_water"] <= 0.20 and r["wc_wet"] <= 0.10 and r["wc_snow"] < 0.30 and r["wc_land"] >= 0.5]
                res.setdefault(f"dsm_safe_tree<={tmax}", {})[role] = f"{len(ok)}/{len(sel)}"
        for role in ("heldout_positive", "decoy"):
            fails = {}
            for r in rows:
                if r.get("role") != role or int(r.get("dsm_pass") or 0):
                    continue
                why = [k for k, v in (("tree", .10), ("built", .05), ("crop", .20), ("water", .20), ("wet", .10))
                       if r[f"wc_{k}"] > v] + (["snow"] if r["wc_snow"] >= 0.3 else []) + (["land"] if r["wc_land"] < 0.5 else [])
                fails[r["id"]] = why
            res[f"dsm_safe_fail_reasons_{role}"] = fails
    return res


def bootstrap(final_top3: dict[str, list[str]] | None = None, n_boot: int = 3, frac: float = 0.8,
              seed: int = 99) -> dict:
    """Stability: re-rank on n_boot random subsamples (frac of the sampled windows; refined windows
    follow their originals). Reports how often each stage-1 shortlisted / final top-3 site
    reappears in the bootstrap shortlists."""
    rows = load_fingerprints()
    quants = load_quantiles()
    moon = load_moon()
    full = json.loads(RANK_JSON.read_text())
    refine = json.loads(REFINE_JSON.read_text()) if REFINE_JSON.exists() else {"windows": []}
    origin_of = {w["id"]: w["origins"] for w in refine.get("windows", [])}
    xt = load_extras(rows) if full.get("features", "base") != "base" else None
    rng = np.random.default_rng(seed)
    sampled = [r["id"] for r in rows if str(r["id"])[0] in "SA"]
    appear: dict[str, int] = {}
    top3_same = []
    for b in range(n_boot):
        keep = set(rng.choice(sampled, int(frac * len(sampled)), replace=False).tolist())
        sub = [r for r in rows if (str(r["id"])[0] in "SA" and r["id"] in keep)
               or (str(r["id"])[0] == "R" and any(o in keep for o in origin_of.get(r["id"], [])))
               or str(r["id"])[0] not in "SAR"]
        D = distances(sub, quants, moon, quiet=True, xt=xt)
        res = _rank_with(sub, D, full["top_k"], _replaced_ids())
        for sid in res["selected"]:
            appear[sid] = appear.get(sid, 0) + 1
        same = []
        for key, v in res["searches"].items():
            a = set(v["top"][:3])
            f = set(full["searches"][key]["top"][:3])
            same.append(len(a & f) / max(len(f), 1))
        top3_same.append(float(np.mean(same)))
    out = {"n_boot": n_boot, "frac": frac, "seed": seed,
           "stage1_top3_overlap_mean": round(float(np.mean(top3_same)), 3),
           "shortlist_reappearance": {sid: appear.get(sid, 0) for sid in full["selected"]}}
    if final_top3:
        out["final_top3_reappearance"] = {k: {sid: appear.get(sid, 0) for sid in v} for k, v in final_top3.items()}
        allf = {sid for v in final_top3.values() for sid in v if str(sid)[0] in "SAR"}
        out["final_top3_mean_reappearance_frac"] = round(float(np.mean([appear.get(s, 0) / n_boot for s in allf])), 3) if allf else None
    return out
