"""Alberta exhaustive screen: every 15 km window of the province, WorldCover filter, 90 m fingerprints,
Moon-region distances per hazard (same definition as the global earth stage-1 screen).

Distance (identical to pipeline.earth.rank_stage1.distances; re-implemented here so the Alberta module
does not depend on a file still being edited, and tested against it in tests/test_alberta.py):
- W1(a, b) = mean |Q_a - Q_b| over the 101 quantiles (1-D Wasserstein-1).
- shadow : mean over el 1,3,5 of W1(per-pixel shadowed-azimuth fraction) / max(Moon IQR, 0.05).
- rim    : mean of W1(1 km jump samples) / max(Moon IQR, 10 m) and |frac_track_over_500m diff| / s.
- texture: mean of W1(slope) / max(Moon IQR, 1 deg) and |nu(L) diff| / s for L = 180/360/720/1440 m.
Scalar scales s are the IQR of that metric over the GLOBAL earth screen population
(data/interim/earth/screen_fingerprints.csv, selected_by == global_screen), so Alberta distances are on
exactly the same scale as the global screen. Falls back to the Alberta population if that file is absent.
"""
from __future__ import annotations

import csv
import json
import logging
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np

from pipeline.alberta.common import INTERIM, write_json
from pipeline.alberta.dem import read_dem, site_geom
from pipeline.common.config import INTERIM as INTERIM_ROOT

log = logging.getLogger("pipeline.alberta.screen")

WIN_JSON = INTERIM / "windows.json"
FP_JSONL = INTERIM / "fingerprints_90m.jsonl"
DIST_JSON = INTERIM / "distances.json"
MOON_FP = INTERIM_ROOT / "moon" / "fingerprints_90m.json"
EARTH_FP_CSV = INTERIM_ROOT / "earth" / "screen_fingerprints.csv"
EARTH_Q_JSONL = INTERIM_ROOT / "earth" / "screen_quantiles.jsonl"
HAZ = ("shadow", "rim", "texture")
EL = (1, 3, 5)
NU = (180, 360, 720, 1440)
SCALAR_KEYS = ["frac_track_over_500m"] + [f"nu_{L}" for L in NU]


# ----------------------------------------------------------------------------- windows
def build_windows(force: bool = False) -> dict:
    """Tiling + WorldCover shares + DSM-safe pass flag for every window (cached)."""
    if WIN_JSON.exists() and not force:
        return json.loads(WIN_JSON.read_text())
    from pipeline.alberta import geodata as G
    from pipeline.alberta import landcover as L
    t0 = time.time()
    poly = G.alberta_boundary_ab()
    wins = G.tile_polygon(poly)
    cov = G.coverage_stats(poly, wins)
    cls, x0, y1 = L.class_grid(poly.bounds, G.alberta_boundary_ll().bounds)
    np.savez_compressed(INTERIM / "worldcover_grid150.npz", cls=cls, x0=x0, y1=y1)
    shares = L.window_shares(wins, cls, x0, y1)
    rows = []
    for w in wins:
        sh = shares[w.id]
        ok, why = L.dsm_safe(sh)
        lon, lat = w.lonlat()
        rows.append({"id": w.id, "row": w.row, "col": w.col, "x0": w.x0, "y1": w.y1, "lat": lat, "lon": lon,
                     "frac_in_ab": round(w.frac_in_ab, 4), "dsm_pass": ok, "fail": why,
                     **{f"wc_{k}": round(v, 4) for k, v in sh.items()}})
    pass_km2 = sum(r["frac_in_ab"] * 225.0 for r in rows if r["dsm_pass"])
    doc = {"crs": G.AB_CRS, "win_m": G.WIN_M, "coverage": {
        **cov, "n_windows": len(rows), "n_pass": sum(r["dsm_pass"] for r in rows),
        "pass_km2_in_ab": pass_km2, "pct_area_pass": 100.0 * pass_km2 / cov["province_km2"],
        "fail_reason_counts": {k: sum(k in r["fail"] for r in rows)
                               for k in ("tree", "built", "crop", "water", "wet", "snow", "land")}},
           "rows": rows, "elapsed_s": round(time.time() - t0, 1)}
    write_json(WIN_JSON, doc)
    log.info("windows: %d (%.2f %% of Alberta covered), %d pass DSM-safe (%.2f %% of area)",
             len(rows), cov["pct_covered"], doc["coverage"]["n_pass"], doc["coverage"]["pct_area_pass"])
    return doc


# ----------------------------------------------------------------------------- fingerprints
def _fp_one(row: dict) -> dict:
    from pipeline.earth.fingerprint import CORE_N, NEAR_N, RES, fingerprint_dem
    g = site_geom(row["lat"], row["lon"], RES, NEAR_N)
    near = read_dem(g, source=90)
    b = (NEAR_N - CORE_N) // 2
    nan_core = float(np.isnan(near[b:b + CORE_N, b:b + CORE_N]).mean())
    if nan_core > 0.2:
        return {"id": row["id"], "status": "nodata", "core_nan_frac": nan_core, "epsg": g.epsg}
    fp = fingerprint_dem(near, RES, CORE_N, quantiles=True)
    q = fp.pop("quantiles_101")
    return {"id": row["id"], "status": "ok", "epsg": g.epsg, **fp, "q": q}


def load_fps() -> dict[str, dict]:
    out = {}
    if FP_JSONL.exists():
        for line in FP_JSONL.read_text().splitlines():
            if line.strip():
                d = json.loads(line)
                out[d["id"]] = d
    return out


def fingerprint_all(rows: list[dict], force: bool = False, workers: int = 10) -> dict[str, dict]:
    """90 m fingerprints of every window (pass and fail; only passing ones are eligible). Resumable."""
    if force and FP_JSONL.exists():
        FP_JSONL.unlink()
    done = load_fps()
    todo = [r for r in rows if r["id"] not in done]
    if not todo:
        return done
    log.info("fingerprinting %d windows (%d cached) with %d threads", len(todo), len(done), workers)
    t0 = time.time()
    with open(FP_JSONL, "a") as fh, ThreadPoolExecutor(workers) as ex:
        futs = {ex.submit(_fp_one, r): r["id"] for r in todo}
        for i, f in enumerate(as_completed(futs)):
            try:
                d = f.result()
            except Exception as exc:  # noqa: BLE001
                log.warning("fingerprint %s failed: %s", futs[f], exc)
                d = {"id": futs[f], "status": "error", "error": str(exc)[:200]}
            fh.write(json.dumps(d, default=float) + "\n")
            fh.flush()
            done[d["id"]] = d
            if (i + 1) % 200 == 0:
                el = time.time() - t0
                log.info("  %d/%d  %.1f win/s", i + 1, len(todo), (i + 1) / el)
    log.info("fingerprints done in %.0f s", time.time() - t0)
    return done


# ----------------------------------------------------------------------------- distances
def _iqr(q: np.ndarray) -> float:
    return float(q[75] - q[25])


def w1(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.nanmean(np.abs(np.asarray(a, float) - np.asarray(b, float))))


def load_moon(path=MOON_FP) -> dict[str, dict]:
    d = json.loads(path.read_text())["regions"]
    out = {}
    for rid, v in d.items():
        s = v["scalars"]
        out[rid] = {"s": {"frac_track_over_500m": s["frac_track_over_500m"],
                          **{f"nu_{L}": s["rms_dev_m"][str(L)] for L in NU}},
                    "scalars": s, "q": {k: np.array(x, float) for k, x in v["quantiles_101"].items()}}
    return out


def _read_earth_rows() -> list[dict]:
    if not EARTH_FP_CSV.exists():
        return []
    with open(EARTH_FP_CSV) as fh:
        return list(csv.DictReader(fh))


def _f(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return float("nan")


def scalar_scales(rows: list[dict]) -> dict[str, float]:
    """IQR of each scalar over a population (same floors as the earth stage)."""
    out = {}
    for k in SCALAR_KEYS:
        v = np.array([_f(r.get(k)) for r in rows], float)
        v = v[np.isfinite(v)]
        iqr = float(np.percentile(v, 75) - np.percentile(v, 25)) if v.size else 1.0
        out[k] = max(iqr, 0.01 if k.startswith("frac") else 1.0)
    return out


def global_scales() -> tuple[dict[str, float], str]:
    rows = [r for r in _read_earth_rows() if r.get("selected_by") == "global_screen" and str(r["id"])[:1] in "SA"]
    if rows:
        return scalar_scales(rows), f"global earth screen population (n={len(rows)})"
    return {}, "unavailable"


def moon_scales(m: dict) -> dict:
    mq = m["q"]
    return {"shadow": {el: max(_iqr(mq[f"shadow_az_frac_el{el}_local"]), 0.05) for el in EL},
            "jump": max(_iqr(mq["jump1km_m"]), 10.0), "slope": max(_iqr(mq["slope_deg"]), 1.0)}


def components(fp: dict, q: dict, m: dict, scal: dict) -> dict[str, list[tuple[str, float]]]:
    """Normalised component terms per hazard: {hazard: [(component, term), ...]}."""
    ms, mq, sc = m["s"], m["q"], moon_scales(m)
    qa = {k: np.asarray(v, float) for k, v in q.items()}
    return {
        "shadow": [(f"shadow_el{el}", w1(qa[f"shadow_az_frac_el{el}_local"], mq[f"shadow_az_frac_el{el}_local"])
                    / sc["shadow"][el]) for el in EL],
        "rim": [("jump1km", w1(qa["jump1km_m"], mq["jump1km_m"]) / sc["jump"]),
                ("frac_track_over_500m", abs(fp["frac_track_over_500m"] - ms["frac_track_over_500m"])
                 / scal["frac_track_over_500m"])],
        "texture": [("slope", w1(qa["slope_deg"], mq["slope_deg"]) / sc["slope"])]
                   + [(f"nu_{L}", abs(fp[f"nu_{L}"] - ms[f"nu_{L}"]) / scal[f"nu_{L}"]) for L in NU],
    }


def hazard_distances(fp: dict, q: dict, m: dict, scal: dict) -> dict[str, float]:
    return {h: float(np.mean([t for _, t in comps])) for h, comps in components(fp, q, m, scal).items()}


def global_best(moon: dict, scal: dict) -> dict[str, dict]:
    """Best (smallest) distance per region|hazard over the global screen's eligible windows."""
    rows = _read_earth_rows()
    if not rows or not EARTH_Q_JSONL.exists():
        return {}
    elig = {r["id"]: r for r in rows if r.get("selected_by") == "global_screen"
            and int(_f(r.get("eligible_discovery")) or 0) == 1 and r.get("status") == "ok"
            and (_f(r.get("core_nan_frac")) or 0) < 0.05}
    dist: dict[str, list[tuple[float, str]]] = {}
    for line in EARTH_Q_JSONL.read_text().splitlines():
        if not line.strip():
            continue
        d = json.loads(line)
        r = elig.get(d["id"])
        if r is None:
            continue
        fp = {k: _f(r.get(k)) for k in SCALAR_KEYS}
        for rid, m in moon.items():
            for h, v in hazard_distances(fp, d["q"], m, scal).items():
                dist.setdefault(f"{rid}|{h}", []).append((v, d["id"]))
    out = {}
    for key, lst in dist.items():
        vals = np.array([v for v, _ in lst])
        i = int(np.nanargmin(vals))
        r = elig[lst[i][1]]
        out[key] = {"distance": float(vals[i]), "id": lst[i][1], "lat": _f(r["lat"]), "lon": _f(r["lon"]),
                    "n_eligible": len(lst), "_sorted": np.sort(vals[np.isfinite(vals)])}
    return out


def eligible(row: dict, fp: dict | None) -> bool:
    return bool(row["dsm_pass"]) and fp is not None and fp.get("status") == "ok" and (fp.get("core_nan_frac") or 0) < 0.05


def compute_distances(rows: list[dict], fps: dict[str, dict], force: bool = False) -> dict:
    """Distances of every fingerprinted window to every region x hazard; ranking among eligible ones."""
    if DIST_JSON.exists() and not force:
        return json.loads(DIST_JSON.read_text())
    moon = load_moon()
    scal, scal_src = global_scales()
    if not scal:
        scal = scalar_scales([fps[r["id"]] for r in rows if fps.get(r["id"], {}).get("status") == "ok"])
        scal_src = "Alberta population (global earth screen file not found)"
    D: dict[str, dict[str, float]] = {}
    for r in rows:
        fp = fps.get(r["id"])
        if not fp or fp.get("status") != "ok":
            continue
        for rid, m in moon.items():
            for h, v in hazard_distances(fp, fp["q"], m, scal).items():
                D.setdefault(f"{rid}|{h}", {})[r["id"]] = v
    elig_ids = {r["id"] for r in rows if eligible(r, fps.get(r["id"]))}
    gb = global_best(moon, scal)
    searches = {}
    for key, d in D.items():
        cand = sorted(((v, i) for i, v in d.items() if i in elig_ids and np.isfinite(v)))
        g = gb.get(key)
        entry = {"top": [{"id": i, "distance": v} for v, i in cand[:5]], "n_eligible": len(cand),
                 "best_terrain_only": min(((v, i) for i, v in d.items() if np.isfinite(v)), default=(None, None))}
        if g is not None and cand:
            best = cand[0][0]
            entry["global"] = {k: v for k, v in g.items() if k != "_sorted"}
            entry["global"]["alberta_best_rank_among_global"] = int(np.searchsorted(g["_sorted"], best)) + 1
        searches[key] = entry
    doc = {"scalar_scales": scal, "scalar_scales_source": scal_src, "n_eligible": len(elig_ids),
           "distances": D, "searches": searches}
    write_json(DIST_JSON, doc)
    return doc
