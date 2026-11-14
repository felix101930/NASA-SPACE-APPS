"""Find-back evaluation: hide a distorted copy of each Moon route among the Earth transects and
measure how often each matcher ranks it first.

Two settings are reported:
* full library - the needle competes with every Earth transect (all lengths); isolates the matcher.
* ``dtw_app`` - the browser's whole pipeline: ``prefilter`` from ``web/src/screens/Walk.tsx``
  (nearest length class, then a loose climb / steepest-slope window) followed by banded DTW. The
  needle is given the length class nearest its own length, as the Earth stage would bin it.
"""
from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from pipeline.walkval.matchers import (
    MATCHERS, Library, heights_from_slopes, pair_distances, query_features, rank_of, rank_sorted, score,
)
from pipeline.walkval.routes import MoonRoute, MoonTile, Needle, generate_routes, load_tiles, make_needle

log = logging.getLogger("pipeline.walkval")

PIPELINE_VERSION = "walkval-0.1"
DEFAULT_SIGMA_M = 2.0
DEFAULT_STRETCH = 0.05
SWEEP_SIGMA_M = (1.0, 2.0, 5.0)
SWEEP_STRETCH = (0.0, 0.05, 0.10)
LENGTH_BINS = ((1000.0, 2000.0, "1-2 km"), (2000.0, 3000.0, "2-3 km"), (3000.0, 4000.01, "3-4 km"))
APP = "dtw_app"


# ----------------------------------------------------------------------------- inputs
@dataclass
class EarthData:
    slopes: np.ndarray  # [N, P] float64 (values exactly as stored Float32)
    length_m: np.ndarray
    climb_m: np.ndarray
    max_slope_deg: np.ndarray
    meta: dict


def load_earth(walk_dir: Path) -> EarthData:
    tj = json.loads((walk_dir / "transects.json").read_text())
    n, p = int(tj["n"]), int(tj["points"])
    raw = np.fromfile(walk_dir / "transects.bin", dtype="<f4")
    if raw.size != n * p or len(tj["items"]) != n:
        raise RuntimeError(f"transects.bin has {raw.size} floats, json says {n}x{p} with {len(tj['items'])} items; "
                           "the Earth stage may be mid-rewrite - re-run when it finishes")
    items = sorted(tj["items"], key=lambda t: t["i"])
    if [t["i"] for t in items] != list(range(n)):
        raise RuntimeError("transects.json item indices are not 0..n-1")
    slopes = raw.reshape(n, p).astype(np.float64)
    ok = np.all(np.isfinite(slopes), axis=1)
    if not ok.all():
        log.warning("dropping %d transects with NaN (the browser skips them too)", int((~ok).sum()))
    return EarthData(
        slopes=slopes[ok],
        length_m=np.array([t["length_m"] for t in items], dtype=np.float64)[ok],
        climb_m=np.array([t["climb_m"] for t in items], dtype=np.float64)[ok],
        max_slope_deg=np.array([t["max_slope_deg"] for t in items], dtype=np.float64)[ok],
        meta={"generated_utc": tj.get("meta", {}).get("generated_utc"),
              "pipeline_version": tj.get("meta", {}).get("pipeline_version"), "n": int(ok.sum()), "points": p},
    )


# ----------------------------------------------------------------------------- app prefilter port
def nearest_class(classes: np.ndarray, length_m: float) -> float:
    """``classes.reduce`` in Walk.tsx: smallest |log(c / L)|, earlier (shorter) class wins ties."""
    best = float(classes[0])
    for c in classes:
        if abs(np.log(c / length_m)) < abs(np.log(best / length_m)):
            best = float(c)
    return best


def app_prefilter(length_m: np.ndarray, climb_m: np.ndarray, max_slope: np.ndarray,
                  q_length: float, q_climb: float, q_max: float) -> np.ndarray:
    """Boolean candidate mask, a port of ``prefilter`` in web/src/screens/Walk.tsx."""
    classes = np.unique(length_m)
    cls = nearest_class(classes, q_length)
    same = length_m == cls
    strict = (same & (max_slope >= q_max * 0.5 - 6) & (max_slope <= q_max * 1.7 + 6)
              & (climb_m >= q_climb * 0.4 - 40) & (climb_m <= q_climb * 2.5 + 40))
    if strict.sum() >= 25:
        return strict
    if same.sum() >= 25:
        return same
    return np.ones_like(same)


# ----------------------------------------------------------------------------- evaluation core
def _f32(a: np.ndarray) -> np.ndarray:
    """Round-trip through Float32, as a row stored in transects.bin would be."""
    return np.asarray(a, dtype=np.float32).astype(np.float64)


def needle_library(nd: Needle, scale: tuple[float, float]) -> Library:
    return Library(_f32(nd.slope_deg)[None, :], np.array([nd.length_m]), scale=scale)


def needle_app_rank(route: MoonRoute, nd: Needle, earth: EarthData, earth_dtw: np.ndarray,
                    needle_dtw: float) -> tuple[int | None, int]:
    """Rank of the needle under the app pipeline (None = filtered out) and the candidate count."""
    classes = np.unique(earth.length_m)
    lengths = np.append(earth.length_m, nearest_class(classes, nd.length_m))
    climbs = np.append(earth.climb_m, round(nd.climb_m, 1))
    maxs = np.append(earth.max_slope_deg, round(nd.max_slope_deg, 1))
    mask = app_prefilter(lengths, climbs, maxs, route.length_m, route.climb_m, route.max_slope_deg)
    n_cand = int(mask.sum())
    if not mask[-1]:
        return None, n_cand
    return rank_of(needle_dtw, earth_dtw[mask[:-1]]), n_cand


def _summ(ranks: list[int | None], with_filtered: bool = False) -> dict:
    r = np.array([np.inf if x is None else x for x in ranks], dtype=np.float64)
    med = float(np.median(r)) if r.size else float("inf")
    # median_rank is null when more than half the needles were filtered out before ranking
    out = {"n": int(r.size), "top1": round(float(np.mean(r <= 1)), 4), "top5": round(float(np.mean(r <= 5)), 4),
           "median_rank": med if np.isfinite(med) else None}
    if with_filtered:
        out["filtered_out"] = round(float(np.mean([x is None for x in ranks])), 4) if ranks else 0.0
    return out


def _pct(a: np.ndarray, q: float) -> float:
    return round(float(np.percentile(a, q)), 2)


def _dist_summary(a: np.ndarray) -> dict:
    return {"median": _pct(a, 50), "p10": _pct(a, 10), "p90": _pct(a, 90)}


def time_matchers(routes: list[MoonRoute], lib: Library, earth: EarthData, n_time: int = 10) -> dict[str, dict]:
    """Single-threaded numba wall time per query over the whole library (both directions)."""
    out: dict[str, dict] = {}
    qs = routes[:n_time]
    for m in MATCHERS:
        qf0 = query_features(qs[0].slope_deg, qs[0].length_m, lib.scale)
        score(m, qf0, lib, parallel=False)  # compile / warm
        ts = []
        for r in qs:
            qf = query_features(r.slope_deg, r.length_m, lib.scale)
            t0 = time.perf_counter()
            score(m, qf, lib, parallel=False)
            ts.append((time.perf_counter() - t0) * 1000)
        out[m] = {"ms_per_query": round(float(np.median(ts)), 2), "rows": lib.n}
    # app: DTW over the prefiltered candidates only
    ts, ncs = [], []
    for r in qs:
        mask = app_prefilter(earth.length_m, earth.climb_m, earth.max_slope_deg, r.length_m, r.climb_m,
                             r.max_slope_deg)
        sub = Library(earth.slopes[mask], earth.length_m[mask], scale=lib.scale)
        qf = query_features(r.slope_deg, r.length_m, lib.scale)
        t0 = time.perf_counter()
        score("dtw_slope", qf, sub, parallel=False)
        ts.append((time.perf_counter() - t0) * 1000)
        ncs.append(int(mask.sum()))
    out[APP] = {"ms_per_query": round(float(np.median(ts)), 2), "rows": int(np.median(ncs))}
    return out


def _best_match_quality(route: MoonRoute, qf: dict, matcher: str, d: np.ndarray, lib: Library,
                        earth: EarthData) -> dict:
    i = int(np.argmin(d))
    a, b = pair_distances(matcher, qf, lib, i)
    rev = b < a
    s = lib.bwd[i] if rev else lib.fwd[i]
    h = heights_from_slopes(s, earth.length_m[i])
    return {"height_rmse_m": float(np.sqrt(np.mean((route.h_rel_m - h) ** 2))),
            "max_slope_diff_deg": float(abs(np.abs(s).max() - route.max_slope_deg)),
            "distance": float(d[i]), "earth_length_m": float(earth.length_m[i])}


def evaluate(web_data: Path, n_routes: int = 300, seed: int = 2026) -> dict:
    regions = json.loads((web_data / "regions.json").read_text())["regions"]
    tiles = load_tiles(regions, web_data)
    tile_by_id: dict[str, MoonTile] = {t.region_id: t for t in tiles}
    earth = load_earth(web_data / "walk")
    P = earth.slopes.shape[1]
    lib = Library(earth.slopes, earth.length_m)
    log.info("Earth library: %d transects x %d points; scale sd_h=%.1f m sd_s=%.2f deg",
             lib.n, P, lib.scale[0], lib.scale[1])
    routes = generate_routes(tiles, n_routes, seed, P)
    names = list(MATCHERS)

    # Earth-row distances do not depend on the distortion: compute once per query, reuse for sweep.
    t0 = time.perf_counter()
    earth_d: dict[str, list[np.ndarray]] = {m: [] for m in names}
    earth_sorted: dict[str, list[np.ndarray]] = {m: [] for m in names}
    qfs = []
    for k, r in enumerate(routes):
        qf = query_features(r.slope_deg, r.length_m, lib.scale)
        qfs.append(qf)
        for m in names:
            d = score(m, qf, lib)
            earth_d[m].append(d if m in ("dtw_slope",) else None)
            earth_sorted[m].append(np.sort(d))
        if (k + 1) % 50 == 0:
            log.info("scored %d/%d queries against the library (%.0f s)", k + 1, len(routes), time.perf_counter() - t0)
    # winner quality needs raw distances of every matcher; recompute lazily for the winner only.

    def run_setting(sigma: float, stretch: float) -> tuple[dict[str, list[int | None]], list[int]]:
        ranks: dict[str, list[int | None]] = {m: [] for m in names + [APP]}
        ncand: list[int] = []
        for k, r in enumerate(routes):
            nd = make_needle(r, tile_by_id[r.region_id], sigma, stretch, P)
            nlib = needle_library(nd, lib.scale)
            for m in names:
                dn = float(score(m, qfs[k], nlib, parallel=False)[0])
                ranks[m].append(rank_sorted(dn, earth_sorted[m][k]))
                if m == "dtw_slope":
                    ar, nc = needle_app_rank(r, nd, earth, earth_d[m][k], dn)
                    ranks[APP].append(ar)
                    ncand.append(nc)
        return ranks, ncand

    ranks, ncand = run_setting(DEFAULT_SIGMA_M, DEFAULT_STRETCH)
    timing = time_matchers(routes, lib, earth)

    matchers_out = []
    for m in names + [APP]:
        s = _summ(ranks[m])
        row = {"name": m, "description": MATCHERS.get(m, "The browser pipeline: Walk.tsx prefilter "
                                                         "(nearest length class + climb/steepest-slope "
                                                         "window), then banded DTW 10% on slope"),
               "top1": s["top1"], "top5": s["top5"], "median_rank": s["median_rank"],
               "ms_per_query": timing[m]["ms_per_query"], "rows_searched": timing[m]["rows"]}
        if m == APP:
            row["needle_filtered_out"] = round(float(np.mean([x is None for x in ranks[APP]])), 4)
            row["median_candidates"] = int(np.median(ncand))
        matchers_out.append(row)
    winner = sorted([r for r in matchers_out if r["name"] != APP],
                    key=lambda r: (-r["top1"], r["ms_per_query"]))[0]["name"]

    def breakdown(key_fn, keys: list[str]) -> list[dict]:
        out = []
        for key in keys:
            idx = [k for k, r in enumerate(routes) if key_fn(r) == key]
            out.append({"bin": key, "n": len(idx),
                        "matchers": {m: _summ([ranks[m][k] for k in idx], m == APP) for m in names + [APP]}})
        return out

    def len_bin(r: MoonRoute) -> str:
        return next(lbl for lo, hi, lbl in LENGTH_BINS if lo <= r.length_m < hi)

    by_length = breakdown(len_bin, [b[2] for b in LENGTH_BINS])
    by_region = breakdown(lambda r: r.region_id, [t.region_id for t in tiles])
    by_shape = breakdown(lambda r: r.shape, ["straight", "two_leg"])
    by_direction = breakdown(lambda r: "reversed" if r.reversed else "as_walked", ["as_walked", "reversed"])

    sweep = []
    for sg in SWEEP_SIGMA_M:
        for st in SWEEP_STRETCH:
            rk, _ = (ranks, ncand) if (sg, st) == (DEFAULT_SIGMA_M, DEFAULT_STRETCH) else run_setting(sg, st)
            sweep.append({"sigma_m": sg, "stretch": st,
                          "matchers": {m: {k: v for k, v in _summ(rk[m], m == APP).items() if k != "n"}
                                       for m in names + [APP]}})
            log.info("sweep sigma=%.0f m stretch=%.0f%%: dtw top1=%.3f euclid top1=%.3f", sg, st * 100,
                     sweep[-1]["matchers"]["dtw_slope"]["top1"], sweep[-1]["matchers"]["euclid_slope"]["top1"])

    # Quality: best REAL Earth match (no needle) for each Moon route.
    q_app, q_win = [], []
    recon = []
    for k, r in enumerate(routes):
        mask = app_prefilter(earth.length_m, earth.climb_m, earth.max_slope_deg, r.length_m, r.climb_m,
                             r.max_slope_deg)
        d_app = np.where(mask, earth_d["dtw_slope"][k], np.inf)
        q_app.append(_best_match_quality(r, qfs[k], "dtw_slope", d_app, lib, earth))
        d_win = earth_d["dtw_slope"][k] if winner == "dtw_slope" else score(winner, qfs[k], lib)
        q_win.append(_best_match_quality(r, qfs[k], winner, d_win, lib, earth))
        recon.append(float(np.sqrt(np.mean((heights_from_slopes(r.slope_deg, r.length_m) - r.h_rel_m) ** 2))))

    def qsum(rows: list[dict]) -> dict:
        h = np.array([x["height_rmse_m"] for x in rows])
        ms = np.array([x["max_slope_diff_deg"] for x in rows])
        dd = np.array([x["distance"] for x in rows])
        same_len = np.mean([abs(x["earth_length_m"] - r.length_m) / r.length_m < 0.5 for x, r in zip(rows, routes)])
        return {"height_rmse_m": _dist_summary(h), "max_slope_diff_deg": _dist_summary(ms),
                "share_max_slope_within_5deg": round(float(np.mean(ms <= 5)), 4),
                "match_distance": _dist_summary(dd),
                "share_earth_length_within_50pct": round(float(same_len), 4)}

    quality = {
        "note": ("Best real Earth transect for each clean Moon route (needle excluded). Earth heights are "
                 "rebuilt by integrating the stored slopes (transects.bin has no heights), so height RMSE "
                 "includes a small reconstruction error, shown below for the Moon routes themselves."),
        "app_pipeline": qsum(q_app),
        "winner_full_library": {"matcher": winner, **qsum(q_win)},
        "height_reconstruction_rmse_m": _dist_summary(np.array(recon)),
    }

    n_rev = sum(r.reversed for r in routes)
    return {
        "meta": {
            "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "pipeline_version": PIPELINE_VERSION,
            "seed": seed,
            "earth_library": earth.meta,
            "moon_regions": [t.region_id for t in tiles],
            "method": ("Each Moon route's distorted copy is appended to the Earth slope library; rank 1 means "
                       "the matcher put the hidden copy above all real Earth transects. Ties count against "
                       "the copy. Both walking directions are scored for every row, as the browser does."),
            "timing_note": ("Single-threaded numba on the build machine, whole library unless stated; no early "
                            "abandoning (the browser abandons rows that cannot enter its top 5, so its DTW is "
                            "faster than the full-scan figure)."),
            "sources": [{"name": "Moon tiles and Earth transects from this project's pipeline",
                         "url": "web/public/data/regions.json; web/public/data/walk/transects.json",
                         "licence": "see those files", "citation": "see those files"},
                        {"name": "Sakoe & Chiba band", "url": "https://doi.org/10.1109/TASSP.1978.1163055",
                         "licence": "n/a (method)",
                         "citation": "Sakoe, H., Chiba, S. (1978). Dynamic programming algorithm optimization "
                                     "for spoken word recognition. IEEE TASSP 26(1):43-49."}],
        },
        "n_routes": len(routes),
        "routes": {"length_m": [1000, 4000], "shapes": {"straight": sum(r.shape == "straight" for r in routes),
                                                        "two_leg": sum(r.shape == "two_leg" for r in routes)},
                   "per_region": {t.region_id: sum(r.region_id == t.region_id for r in routes) for t in tiles},
                   "points": P},
        "needle_distortion": {
            "height_noise_sigma_m": DEFAULT_SIGMA_M,
            "height_noise_model": "i.i.d. Gaussian per 30 m DEM pixel, then bilinear sampling",
            "length_stretch": DEFAULT_STRETCH,
            "stretch_model": "one random contiguous half of the route stretched by 1+2s (local time warp)",
            "reversal_probability": 0.5, "n_reversed": int(n_rev),
            "slope_rederived": True, "stored_as_float32": True,
        },
        "matchers": matchers_out,
        "winner": winner,
        "by_length": by_length,
        "by_region": by_region,
        "by_shape": by_shape,
        "by_direction": by_direction,
        "sweep": sweep,
        "quality": quality,
        "skipped": [{"name": "matrix_profile_aamp",
                     "why": ("Not run: with fixed 100-point profiles a non-normalised matrix profile at full "
                             "window equals Euclidean, and shorter windows match sub-sections rather than "
                             "whole walks; stumpy was not added as a dependency.")}],
    }


def write(result: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result, indent=1, allow_nan=False) + "\n")
    log.info("wrote %s", path)
