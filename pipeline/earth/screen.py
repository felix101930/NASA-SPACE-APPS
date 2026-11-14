"""Stage 1: Moon-first global screen of bare land at 90 m.

Sampling design (seeded, SEED below; fully reproducible):
1. Pool: draw points uniformly on the sphere between 60S and 83N (GLO-90 / WorldCover coverage).
   A point is a land window when its GLO-90 tile exists and >= 50 % of the ~15 km window is valid
   non-water WorldCover (rejection sampling against land).
2. Bare prefilter from the coarse WorldCover map (COG overview ~300 m px, aggregated to 2.7 km
   cells): bare/sparse (60) + moss/lichen (100) >= 0.6 and snow/ice (70) < 0.3.
3. Coarse relief for every pool point: P99 - P1 of GLO-90 overview level 1 (~360 m px) within the
   15 km window (centre tile only; approximate, used for stratification only).
4. Strata = latitude band x relief tercile (terciles over the bare pool). Band quotas start equal
   and unused quota is water-filled to bands with spare windows; inside a band the terciles get
   weights low:mid:high = 1:2:3 (high relief oversampled). Within a stratum windows are drawn in
   random order, >= 15 km apart, at most K per 1 deg tile (bounds download volume).
5. forced_rock: Macrostrat anorthosite/plutonic hits around the validation anorthosite rows
   (site + rings at 25 and 50 km, 8 bearings) are force-included with stratum=forced_rock.
   They are discovery-eligible only if they also pass the bare filter.
6. Each window: GLO-90 on a local UTM grid at 90 m, 15 km core + 15 km buffer -> fingerprint
   (pipeline.earth.fingerprint; same definitions as pipeline.metrics; shadow is the LOCAL proxy
   shadow_frac_local_*, no far field).
"""
from __future__ import annotations

import csv
import json
import logging
import math
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait

import numpy as np
import rasterio

from pipeline.earth.common import GLO90_URL, INTERIM, cop_name, cop_tile_exists
from pipeline.earth.fingerprint import FP_KEYS, fingerprint_90m
from pipeline.earth.landcover import build_coarse_map, coarse_shares
from pipeline.earth.pool import load_validation

log = logging.getLogger("pipeline.earth.screen")

SEED = 20261114
LAT_MIN, LAT_MAX = -60.0, 83.0
# STRICT (original) bare rule -- kept as an attribute and for the funnel comparison
BARE_MIN = 0.6     # share of (60 bare + 100 moss)
SNOW_MAX = 0.3
LAND_MIN = 0.5     # valid non-water share of the window (land test)
# DSM-SAFE rule (lead decision): exclude what biases a 30 m surface model (trees, buildings,
# crops, water, wetlands, snow), do not demand bare ground. Shrub/grass (20/30) are allowed.
DSM_SAFE_MAX = {"tree": 0.10, "built": 0.05, "crop": 0.20, "water": 0.20, "wet": 0.10}
DSM_SNOW_MAX = 0.30   # strict <
BANDS = ((-60, -35), (-35, -15), (-15, 15), (15, 35), (35, 55), (55, 70), (70, 83))
TERCILE_WEIGHTS = (1, 2, 3)   # low, mid, high relief
K_PER_TILE = 3
MIN_SEP_KM = 15.0
POOL_TARGET = 30_000
BARE_LAND_KM2 = (17e6, 20e6)  # approx. global WorldCover 60+100 area, used for coverage %
WINDOW_KM2 = 225.0

WINDOWS_CSV = INTERIM / "screen_windows.csv"
FP_CSV = INTERIM / "screen_fingerprints.csv"
DRAW_STATS = INTERIM / "screen_draw_stats.json"
POOL_CSV = INTERIM / "screen_pool.csv"
QUANT_JSONL = INTERIM / "screen_quantiles.jsonl"

WC_FIELDS = ["wc_tree", "wc_shrub", "wc_grass", "wc_crop", "wc_built", "wc_bare", "wc_snow", "wc_water",
             "wc_wet", "wc_moss", "wc_land"]
WIN_COLS = ["id", "lat", "lon", "band", "relief_class", "stratum", "coarse_relief_m", "role", "selected_by",
            "eligible_discovery", "dsm_pass", "bare_pass", *WC_FIELDS]
FP_CSV_STRICT = INTERIM / "screen_fingerprints_strict.csv"
QUANT_STRICT = INTERIM / "screen_quantiles_strict.jsonl"
FP_COLS = WIN_COLS + [k for k in FP_KEYS] + ["elev_mean_m", "core_nan_frac", "epsg", "impl", "status"]


def _band(lat: float) -> int:
    for i, (a, b) in enumerate(BANDS):
        if a <= lat < b:
            return i
    return len(BANDS) - 1


def bare_pass(sh: dict) -> bool:
    """Strict rule: bare + moss >= 0.6, snow < 0.3, land >= 0.5."""
    return (sh["bare"] + sh["moss"]) >= BARE_MIN and sh["snow"] < SNOW_MAX and sh["land"] >= LAND_MIN


def dsm_pass(sh: dict) -> bool:
    """DSM-safe rule: tree <= .10, built <= .05, crop <= .20, water <= .20, wet+mangrove <= .10, snow < .30."""
    return (all(sh[k] <= v for k, v in DSM_SAFE_MAX.items()) and sh["snow"] < DSM_SNOW_MAX
            and sh["land"] >= LAND_MIN)


def wc_fields(sh: dict) -> dict:
    out = {f"wc_{k}": round(float(v), 4) for k, v in sh.items()}
    out["bare_pass"] = int(bare_pass(sh))
    out["dsm_pass"] = int(dsm_pass(sh))
    return out


def draw_pool(seed: int = SEED, pool_target: int = POOL_TARGET, chunk: int = 100_000,
              max_draw: int = 2_000_000) -> tuple[list[dict], dict]:
    """Uniform-on-sphere draws until pool_target windows pass the bare filter."""
    counts = build_coarse_map()
    rng = np.random.default_rng(seed)
    s0, s1 = math.sin(math.radians(LAT_MIN)), math.sin(math.radians(LAT_MAX))
    stats = {"seed": seed, "pool_filter": "dsm_safe", "n_draw": 0, "n_land": 0, "n_pass": 0, "n_pass_strict": 0,
             "per_band": {f"{a}..{b}": {"land": 0, "pass": 0} for a, b in BANDS}}
    passing: list[dict] = []
    while len(passing) < pool_target and stats["n_draw"] < max_draw:
        lats = np.degrees(np.arcsin(rng.uniform(s0, s1, chunk)))
        lons = rng.uniform(-180.0, 180.0, chunk)
        for la, lo in zip(lats, lons):
            stats["n_draw"] += 1
            la, lo = float(la), float(lo)
            if not cop_tile_exists(la, lo, 90):
                continue
            sh = coarse_shares(counts, la, lo)
            if sh["land"] < LAND_MIN:
                continue
            b = _band(la)
            key = f"{BANDS[b][0]}..{BANDS[b][1]}"
            stats["n_land"] += 1
            stats["per_band"][key]["land"] += 1
            stats["n_pass_strict"] += int(bare_pass(sh))
            if dsm_pass(sh):
                stats["n_pass"] += 1
                stats["per_band"][key]["pass"] += 1
                passing.append({"lat": la, "lon": lo, "band": b, **wc_fields(sh)})
                if len(passing) >= pool_target:
                    break
    stats["pass_rate_of_land"] = stats["n_pass"] / max(stats["n_land"], 1)
    log.info("draws %d -> land %d -> DSM-safe pool %d (%.1f %% of land)", stats["n_draw"], stats["n_land"],
             stats["n_pass"], 100 * stats["pass_rate_of_land"])
    return passing, stats


def _tile_relief(name: str, pts: list[dict]) -> None:
    """Coarse relief (P99-P1) from GLO-90 overview level 1 for points inside one tile."""
    try:
        with rasterio.open("/vsicurl/" + GLO90_URL.format(name=name), overview_level=1) as src:
            a = src.read(1).astype(np.float32)
            tr = src.transform
    except Exception as exc:  # noqa: BLE001
        log.warning("overview relief failed %s: %s", name, exc)
        for p in pts:
            p["coarse_relief_m"] = float("nan")
        return
    for p in pts:
        dlat = 7.5 / 111.32
        dlon = 7.5 / (111.32 * max(math.cos(math.radians(p["lat"])), 0.05))
        c0 = int((p["lon"] - dlon - tr.c) / tr.a)
        c1 = int(math.ceil((p["lon"] + dlon - tr.c) / tr.a))
        r0 = int((p["lat"] + dlat - tr.f) / tr.e)
        r1 = int(math.ceil((p["lat"] - dlat - tr.f) / tr.e))
        w = a[max(r0, 0):max(r1, 1), max(c0, 0):max(c1, 1)]
        p["coarse_relief_m"] = float(np.percentile(w, 99) - np.percentile(w, 1)) if w.size else float("nan")


def add_coarse_relief(pool: list[dict], workers: int = 32) -> None:
    groups: dict[str, list[dict]] = {}
    for p in pool:
        groups.setdefault(cop_name(math.floor(p["lat"]), math.floor(p["lon"]), 90), []).append(p)
    t0 = time.time()
    log.info("coarse relief for %d pool points over %d tiles", len(pool), len(groups))
    with ThreadPoolExecutor(workers) as ex:
        list(ex.map(lambda kv: _tile_relief(*kv), groups.items()))
    log.info("coarse relief done in %.0f s", time.time() - t0)


def _km(a: dict, b: dict) -> float:
    dy = (a["lat"] - b["lat"]) * 111.32
    dx = (a["lon"] - b["lon"]) * 111.32 * math.cos(math.radians(0.5 * (a["lat"] + b["lat"])))
    return math.hypot(dx, dy)


def _water_fill(caps: dict, total: int, weights: dict | None = None) -> dict:
    weights = weights or {k: 1 for k in caps}
    quota = {k: 0 for k in caps}
    remaining = total
    open_k = [k for k in caps if caps[k] > 0]
    while remaining > 0 and open_k:
        wsum = sum(weights[k] for k in open_k)
        progressed = False
        for k in list(open_k):
            add = min(max(1, int(remaining * weights[k] / wsum)), caps[k] - quota[k], remaining)
            if add > 0:
                quota[k] += add
                remaining -= add
                progressed = True
            if quota[k] >= caps[k]:
                open_k.remove(k)
            if remaining <= 0:
                break
        if not progressed:
            break
    return quota


def select_windows(pool: list[dict], target: int, seed: int = SEED) -> tuple[list[dict], dict]:
    rng = np.random.default_rng(seed + 1)
    rel = np.array([p["coarse_relief_m"] for p in pool if np.isfinite(p["coarse_relief_m"])])
    t1, t2 = (float(np.percentile(rel, 100 / 3)), float(np.percentile(rel, 200 / 3))) if rel.size else (0.0, 0.0)
    for p in pool:
        r = p["coarse_relief_m"]
        p["relief_class"] = -1 if not np.isfinite(r) else (0 if r < t1 else (1 if r < t2 else 2))
    strata: dict[tuple[int, int], list[dict]] = {}
    for p in pool:
        if p["relief_class"] >= 0:
            strata.setdefault((p["band"], p["relief_class"]), []).append(p)
    band_caps = {b: sum(len(strata.get((b, c), [])) for c in range(3)) for b in range(len(BANDS))}
    band_q = _water_fill(band_caps, target)
    quotas = {}
    for b in range(len(BANDS)):
        caps = {c: len(strata.get((b, c), [])) for c in range(3)}
        q = _water_fill(caps, band_q[b], {c: TERCILE_WEIGHTS[c] for c in range(3)})
        for c in range(3):
            quotas[(b, c)] = q[c]
    chosen: list[dict] = []
    per_tile: dict[tuple[int, int], list[dict]] = {}
    realised = {}
    for key in sorted(strata):
        cands = strata[key]
        order = rng.permutation(len(cands))
        got = 0
        for i in order:
            if got >= quotas[key]:
                break
            w = cands[int(i)]
            t = (math.floor(w["lat"]), math.floor(w["lon"]))
            if len(per_tile.get(t, [])) >= K_PER_TILE:
                continue
            near = [k for dt in ((0, 0), (1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1))
                    for k in per_tile.get((t[0] + dt[0], t[1] + dt[1]), [])]
            if any(_km(w, k) < MIN_SEP_KM for k in near):
                continue
            per_tile.setdefault(t, []).append(w)
            w["stratum"] = f"band{BANDS[key[0]][0]}..{BANDS[key[0]][1]}_relief{['low', 'mid', 'high'][key[1]]}"
            chosen.append(w)
            got += 1
        realised[f"{BANDS[key[0]][0]}..{BANDS[key[0]][1]}|{['low', 'mid', 'high'][key[1]]}"] = {
            "pool": len(cands), "quota": quotas[key], "selected": got}
    info = {"relief_tercile_edges_m": [round(t1, 1), round(t2, 1)], "tercile_weights": TERCILE_WEIGHTS,
            "k_per_tile": K_PER_TILE, "min_sep_km": MIN_SEP_KM, "strata": realised}
    log.info("selected %d stratified windows over %d tiles; relief terciles %.0f / %.0f m", len(chosen),
             len(per_tile), t1, t2)
    return chosen, info


def forced_rock_windows(existing: list[dict]) -> list[dict]:
    """Macrostrat anorthosite / plutonic windows around the validation anorthosite rows."""
    from pipeline.earth.rock import lookup_many
    counts = build_coarse_map()
    sites, _ = load_validation(write_clean=False)
    seeds = [s for s in sites if s.category == "anorthosite"]
    pts = []
    for s in seeds:
        pts.append((s.lat, s.lon))
        for dist in (25.0, 50.0):
            for k in range(8):
                az = math.radians(45 * k)
                la = s.lat + dist * math.cos(az) / 111.32
                lo = s.lon + dist * math.sin(az) / (111.32 * max(math.cos(math.radians(s.lat)), 0.05))
                pts.append((round(la, 4), round(lo, 4)))
    log.info("forced_rock: querying Macrostrat at %d points around %d anorthosite rows", len(pts), len(seeds))
    rocks = lookup_many(pts, workers=6)
    out = []
    for (la, lo), rk in zip(pts, rocks):
        if not (rk["anorthosite"] or rk["plutonic"]) or not cop_tile_exists(la, lo, 90):
            continue
        sh = coarse_shares(counts, la, lo)
        if sh["land"] < LAND_MIN:
            continue
        w = {"lat": la, "lon": lo, "band": _band(la), **wc_fields(sh),
             "stratum": "forced_rock", "relief_class": -1, "coarse_relief_m": float("nan"),
             "rock_lith": rk["lith"], "rock_anorthosite": rk["anorthosite"]}
        if all(_km(w, k) >= MIN_SEP_KM for k in out):
            out.append(w)
    log.info("forced_rock: %d windows (%d anorthosite, %d DSM-safe)", len(out),
             sum(1 for w in out if w["rock_anorthosite"]), sum(w["dsm_pass"] for w in out))
    return out


def validation_windows() -> list[dict]:
    """Validation rows get the same bare test (recorded, not enforced) and the same fingerprint."""
    counts = build_coarse_map()
    sites, _ = load_validation()
    out = []
    for s in sites:
        sh = coarse_shares(counts, s.lat, s.lon)
        out.append({"id": s.id, "lat": s.lat, "lon": s.lon, "band": _band(s.lat), "role": s.role,
                    "selected_by": "validation", "eligible_discovery": 0, **wc_fields(sh),
                    "stratum": "validation", "relief_class": -1, "coarse_relief_m": float("nan")})
    return out


def _load_done(path=None) -> dict[str, dict]:
    path = path or FP_CSV
    if not path.exists():
        return {}
    with open(path, newline="") as fh:
        return {r["id"]: r for r in csv.DictReader(fh)}


def _fp_task(w: dict) -> dict:
    try:
        fp = fingerprint_90m(w["lat"], w["lon"])
        status = "ok" if "shadow_frac_local_el3" in fp else "nodata"
    except Exception as exc:  # noqa: BLE001 - keep the screen running
        log.warning("fingerprint failed %s (%.3f, %.3f): %s", w["id"], w["lat"], w["lon"], exc)
        fp, status = {}, "error"
    return {**w, **fp, "status": status}


def fingerprint_windows(windows: list[dict], workers: int = 16, budget_s: float = 2400.0) -> dict:
    """Fingerprint windows (skipping cached ids). Stops submitting when the time budget is spent."""
    done = _load_done()
    todo = [w for w in windows if w["id"] not in done]
    log.info("fingerprinting %d windows (%d cached), %d threads, budget %.0f s", len(todo), len(done), workers, budget_s)
    new_file = not FP_CSV.exists()
    fh = open(FP_CSV, "a", newline="")
    wr = csv.DictWriter(fh, fieldnames=FP_COLS, extrasaction="ignore")
    if new_file:
        wr.writeheader()
    qfh = open(QUANT_JSONL, "a")
    t0 = time.time()
    n_done = 0
    stopped_early = False
    it = iter(todo)
    with ThreadPoolExecutor(workers) as ex:
        pending = set()
        for _ in range(workers * 2):
            w = next(it, None)
            if w is None:
                break
            pending.add(ex.submit(_fp_task, w))
        while pending:
            fin, pending = wait(pending, return_when=FIRST_COMPLETED)
            for f in fin:
                row = f.result()
                q = row.pop("quantiles_101", None)
                if q is not None:
                    qfh.write(json.dumps({"id": row["id"], "q": q}) + "\n")
                wr.writerow(row)
                n_done += 1
                if n_done % 100 == 0:
                    fh.flush()
                    qfh.flush()
                    el = time.time() - t0
                    rate = n_done / el
                    proj = len(todo) / rate
                    log.info("  %d/%d  %.2f win/s  elapsed %.0f s  projected total %.0f s", n_done, len(todo), rate, el, proj)
                if time.time() - t0 > budget_s:
                    if not stopped_early:
                        log.warning("time budget reached after %d windows; not submitting more", n_done)
                    stopped_early = True
                    continue
                w = next(it, None)
                if w is not None:
                    pending.add(ex.submit(_fp_task, w))
    fh.close()
    qfh.close()
    el = time.time() - t0
    return {"n_fingerprinted_this_run": n_done, "elapsed_s": round(el, 1),
            "win_per_s": round(n_done / el, 3) if el > 0 else None, "stopped_early": stopped_early,
            "threads": workers}


def build_windows(target: int = 5000) -> tuple[list[dict], dict]:
    """Draw pool, stratify, add forced_rock + validation rows. Cached in WINDOWS_CSV."""
    if WINDOWS_CSV.exists() and DRAW_STATS.exists():
        with open(WINDOWS_CSV, newline="") as fh:
            windows = [{**r, "lat": float(r["lat"]), "lon": float(r["lon"])} for r in csv.DictReader(fh)]
        log.info("loaded %d cached screen windows", len(windows))
        return windows, json.loads(DRAW_STATS.read_text())
    pool, stats = draw_pool()
    add_coarse_relief(pool)
    with open(POOL_CSV, "w", newline="") as fh:
        wr = csv.DictWriter(fh, fieldnames=["lat", "lon", "band", "coarse_relief_m", "dsm_pass", "bare_pass",
                                            *WC_FIELDS], extrasaction="ignore")
        wr.writeheader()
        wr.writerows(pool)
    chosen, info = select_windows(pool, target)
    forced = forced_rock_windows(chosen)
    for i, w in enumerate(chosen + forced):
        w["id"] = f"S{i + 1:05d}"
        w["role"] = "screen"
        w["selected_by"] = "global_screen"
        w["eligible_discovery"] = int(w.get("dsm_pass", 1))
    windows = chosen + forced + validation_windows()
    with open(WINDOWS_CSV, "w", newline="") as fh:
        wr = csv.DictWriter(fh, fieldnames=WIN_COLS, extrasaction="ignore")
        wr.writeheader()
        wr.writerows(windows)
    stats.update(info)
    stats["n_selected_stratified"] = len(chosen)
    stats["n_forced_rock"] = len(forced)
    stats["n_forced_rock_anorthosite"] = sum(1 for w in forced if w.get("rock_anorthosite"))
    stats["n_validation"] = sum(1 for w in windows if w["selected_by"] == "validation")
    DRAW_STATS.write_text(json.dumps(stats, indent=1))
    return windows, stats


def _ckey(lat, lon) -> str:
    return f"{float(lat):.6f},{float(lon):.6f}"


def reuse_strict_fingerprints(windows: list[dict]) -> int:
    """Copy fingerprints computed in the earlier strict-pool run for windows at identical coordinates
    (same seeded draw sequence), re-labelled with the new window fields and ids."""
    if not FP_CSV_STRICT.exists():
        return 0
    with open(FP_CSV_STRICT, newline="") as fh:
        old = {}
        for r in csv.DictReader(fh):
            old[_ckey(r["lat"], r["lon"])] = r
    oldq = {}
    if QUANT_STRICT.exists():
        for line in QUANT_STRICT.read_text().splitlines():
            if line.strip():
                d = json.loads(line)
                oldq[d["id"]] = d["q"]
    done = _load_done()
    new_file = not FP_CSV.exists()
    n = 0
    with open(FP_CSV, "a", newline="") as fh, open(QUANT_JSONL, "a") as qfh:
        wr = csv.DictWriter(fh, fieldnames=FP_COLS, extrasaction="ignore")
        if new_file:
            wr.writeheader()
        for w in windows:
            if w["id"] in done:
                continue
            o = old.get(_ckey(w["lat"], w["lon"]))
            if o is None or o.get("status") != "ok" or o["id"] not in oldq:
                continue
            fp = {k: o[k] for k in FP_KEYS + ("elev_mean_m", "core_nan_frac", "epsg", "impl", "status") if k in o}
            wr.writerow({**w, **fp})
            qfh.write(json.dumps({"id": w["id"], "q": oldq[o["id"]]}) + "\n")
            n += 1
    log.info("reused %d fingerprints from the strict-pool run", n)
    return n


def run(target: int = 5000, workers: int = 24, budget_s: float = 2400.0, limit: int | None = None) -> dict:
    windows, stats = build_windows(target)
    stats["n_reused_from_strict_run"] = reuse_strict_fingerprints(windows)
    val = [w for w in windows if w["selected_by"] == "validation"]
    scr = [w for w in windows if w["selected_by"] != "validation"]
    # tile-clustered order so threads share freshly downloaded GLO-90 tiles
    scr.sort(key=lambda w: (math.floor(float(w["lat"])), math.floor(float(w["lon"]))))
    order = val + (scr[:limit] if limit else scr)
    stats["fingerprint_run"] = fingerprint_windows(order, workers=workers, budget_s=budget_s)
    rows = load_fingerprints()
    n_scr = sum(1 for r in rows if r["selected_by"] == "global_screen" and r["status"] == "ok")
    stats["n_screen_fingerprinted_ok"] = n_scr
    lo, hi = BARE_LAND_KM2
    zone_km2 = 2 * math.pi * 6371.0 ** 2 * (math.sin(math.radians(LAT_MAX)) - math.sin(math.radians(LAT_MIN)))
    dsm_km2 = zone_km2 * stats["n_pass"] / max(stats["n_draw"], 1)
    strict_km2 = zone_km2 * stats.get("n_pass_strict", 0) / max(stats["n_draw"], 1)
    stats["coverage"] = {
        "windows": n_scr, "km2": n_scr * WINDOW_KM2,
        "pct_of_bare_land_range": [round(100 * n_scr * WINDOW_KM2 / hi, 2), round(100 * n_scr * WINDOW_KM2 / lo, 2)],
        "denominator_note": "approx. 17-20 M km2 of WorldCover bare/sparse (60) + moss/lichen (100) globally",
        "dsm_safe_land_km2_est": round(dsm_km2), "pct_of_dsm_safe_land": round(100 * n_scr * WINDOW_KM2 / dsm_km2, 2),
        "strict_bare_land_km2_est": round(strict_km2),
        "estimate_note": "Monte-Carlo area of window centres passing each filter (60S-83N), from the seeded draws",
    }
    DRAW_STATS.write_text(json.dumps(stats, indent=1))
    return stats


def load_quantiles(path=None) -> dict[str, dict]:
    out = {}
    path = path or QUANT_JSONL
    if path.exists():
        for line in path.read_text().splitlines():
            if line.strip():
                d = json.loads(line)
                out[d["id"]] = {k: np.array(v, dtype=float) for k, v in d["q"].items()}
    return out


def load_fingerprints(path=None) -> list[dict]:
    rows = list(_load_done(path).values())
    for r in rows:
        for k, v in list(r.items()):
            if k in ("id", "role", "selected_by", "impl", "status"):
                continue
            try:
                r[k] = float(v)
            except (TypeError, ValueError):
                r[k] = float("nan")
    return rows


def documented_windows() -> list[dict]:
    """Agency-documented analogs (holdout + seed) as fingerprinted rows; never discovery-eligible."""
    from pipeline.earth.pool import load_documented
    counts = build_coarse_map()
    out = []
    for s in load_documented():
        sh = coarse_shares(counts, s.lat, s.lon)
        out.append({"id": s.id, "lat": s.lat, "lon": s.lon, "band": _band(s.lat), "role": s.role,
                    "selected_by": "documented", "eligible_discovery": 0, **wc_fields(sh),
                    "stratum": f"documented_{s.extra['split']}", "relief_class": -1, "coarse_relief_m": float("nan")})
    return out


def run_documented(workers: int = 16) -> dict:
    return fingerprint_windows(documented_windows(), workers=workers)
