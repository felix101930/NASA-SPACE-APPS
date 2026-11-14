"""Adaptive second sampling round for the stage-1 screen.

Allocation of ~N new windows (seeded, SEED_ADAPTIVE), all under the same DSM-safe filter:
- uniform (>= 20 %): random unused points of the round-1 DSM-safe pool (uniform by area).
- strata  (40 %)   : unused pool points, strata (latitude band x relief tercile) weighted by their
                     share of the round-1 top-1 % hits (top 1 % of eligible windows per search, union).
- local   (40 %)   : new points uniformly within 100 km of a top-1 % hit (hits chosen uniformly),
                     DSM-safe and land tested on the coarse WorldCover map.
New windows are >= MIN_SEP_KM from every existing window. They are fingerprinted exactly like
round 1 and appended to the same fingerprint files with ids A#####.
"""
from __future__ import annotations

import csv
import json
import logging
import math

import numpy as np
from scipy.spatial import cKDTree

from pipeline.earth import rank_stage1, screen
from pipeline.earth.common import INTERIM, cop_tile_exists
from pipeline.earth.landcover import build_coarse_map, coarse_shares

log = logging.getLogger("pipeline.earth.adaptive")

SEED_ADAPTIVE = 20261115
N_TOTAL = 8000
FRAC = {"uniform": 0.2, "strata": 0.4, "local": 0.4}
LOCAL_RADIUS_KM = 100.0
TOP_FRAC = 0.01
ALLOC_JSON = INTERIM / "adaptive_allocation.json"
WINDOWS_CSV = INTERIM / "adaptive_windows.csv"


def _xyz(lat, lon):
    la, lo = np.radians(lat), np.radians(lon)
    return np.c_[np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)] * 6371.0


class Spacing:
    def __init__(self, lats, lons, min_km):
        self.pts = list(_xyz(np.asarray(lats), np.asarray(lons)))
        self.tree = cKDTree(np.array(self.pts))
        self.extra: list[np.ndarray] = []
        self.min_km = min_km

    def ok_add(self, lat, lon) -> bool:
        p = _xyz(np.array([lat]), np.array([lon]))[0]
        if self.tree.query_ball_point(p, self.min_km):
            return False
        if self.extra and np.min(np.linalg.norm(np.array(self.extra) - p, axis=1)) < self.min_km:
            return False
        self.extra.append(p)
        if len(self.extra) >= 2000:   # rebuild tree periodically
            self.pts.extend(self.extra)
            self.tree = cKDTree(np.array(self.pts))
            self.extra = []
        return True


def top_hits(rk_rows: list[dict], frac: float = TOP_FRAC) -> list[dict]:
    rows = rk_rows
    quants = screen.load_quantiles()
    moon = rank_stage1.load_moon()
    D = rank_stage1.distances(rows, quants, moon)
    elig = np.array([r["selected_by"] == "global_screen" and int(r.get("eligible_discovery") or 0) == 1
                     and r.get("status") == "ok" for r in rows])
    n_top = max(1, int(round(frac * elig.sum())))
    hit = set()
    for d in D.values():
        dd = np.where(elig & np.isfinite(d), d, np.inf)
        hit.update(np.argsort(dd)[:n_top].tolist())
    return [rows[i] for i in sorted(hit)]


def build(n_total: int = N_TOTAL, seed: int = SEED_ADAPTIVE) -> tuple[list[dict], dict]:
    if WINDOWS_CSV.exists() and ALLOC_JSON.exists():
        with open(WINDOWS_CSV, newline="") as fh:
            wins = [{**r, "lat": float(r["lat"]), "lon": float(r["lon"])} for r in csv.DictReader(fh)]
        return wins, json.loads(ALLOC_JSON.read_text())
    rng = np.random.default_rng(seed)
    counts = build_coarse_map()
    stats = json.loads(screen.DRAW_STATS.read_text())
    t1, t2 = stats["relief_tercile_edges_m"]
    rows = screen.load_fingerprints()
    hits = top_hits(rows)
    existing = [r for r in rows]
    sp = Spacing([r["lat"] for r in existing], [r["lon"] for r in existing], screen.MIN_SEP_KM)

    # pool points not yet used
    with open(screen.POOL_CSV, newline="") as fh:
        pool = [{k: float(v) for k, v in r.items()} for r in csv.DictReader(fh)]
    for p in pool:
        r = p["coarse_relief_m"]
        p["relief_class"] = -1 if not math.isfinite(r) else (0 if r < t1 else (1 if r < t2 else 2))
        p["band"] = int(p["band"])
    used = {screen._ckey(r["lat"], r["lon"]) for r in existing}
    pool = [p for p in pool if screen._ckey(p["lat"], p["lon"]) not in used and p["relief_class"] >= 0]

    # strata weights from top hits
    def stratum(lat, rel):
        b = screen._band(lat)
        c = -1 if not math.isfinite(rel) else (0 if rel < t1 else (1 if rel < t2 else 2))
        return (b, c)
    hit_strata: dict[tuple[int, int], int] = {}
    for h in hits:
        rel = h.get("coarse_relief_m")
        rel = rel if rel is not None and math.isfinite(rel) else h.get("relief_m", float("nan"))
        key = stratum(h["lat"], rel)
        if key[1] >= 0:
            hit_strata[key] = hit_strata.get(key, 0) + 1
    tot_hits = sum(hit_strata.values()) or 1
    weights = {k: v / tot_hits for k, v in hit_strata.items()}

    n_uni = int(round(FRAC["uniform"] * n_total))
    n_str = int(round(FRAC["strata"] * n_total))
    n_loc = n_total - n_uni - n_str
    out: list[dict] = []

    def add(p: dict, kind: str, stratum_name: str) -> bool:
        if not sp.ok_add(p["lat"], p["lon"]):
            return False
        out.append({**p, "stratum": stratum_name, "adaptive_kind": kind})
        return True

    # uniform
    order = rng.permutation(len(pool))
    taken = set()
    got = 0
    for i in order:
        if got >= n_uni:
            break
        p = pool[int(i)]
        if add(p, "uniform", "adaptive_uniform"):
            taken.add(int(i))
            got += 1
    n_uni_real = got
    # strata-weighted
    by_stratum: dict[tuple[int, int], list[int]] = {}
    for i, p in enumerate(pool):
        if i not in taken:
            by_stratum.setdefault((p["band"], p["relief_class"]), []).append(i)
    quota = {k: int(round(w * n_str)) for k, w in weights.items()}
    real_strata = {}
    for k, q in quota.items():
        idx = by_stratum.get(k, [])
        rng.shuffle(idx)
        g = 0
        for i in idx:
            if g >= q:
                break
            p = pool[i]
            name = f"adaptive_band{screen.BANDS[k[0]][0]}..{screen.BANDS[k[0]][1]}_relief{['low', 'mid', 'high'][k[1]]}"
            if add(p, "strata", name):
                g += 1
        real_strata[f"{screen.BANDS[k[0]][0]}..{screen.BANDS[k[0]][1]}|{['low', 'mid', 'high'][k[1]]}"] = {
            "weight": round(weights[k], 4), "quota": q, "selected": g, "available": len(idx)}
    # local around hits
    got_loc, tries = 0, 0
    while got_loc < n_loc and tries < n_loc * 30:
        tries += 1
        h = hits[int(rng.integers(len(hits)))]
        r_km = LOCAL_RADIUS_KM * math.sqrt(rng.uniform())
        az = rng.uniform(0, 2 * math.pi)
        la = h["lat"] + r_km * math.cos(az) / 111.32
        lo = h["lon"] + r_km * math.sin(az) / (111.32 * max(math.cos(math.radians(h["lat"])), 0.05))
        if not (screen.LAT_MIN <= la < screen.LAT_MAX) or not cop_tile_exists(la, lo, 90):
            continue
        lo = ((lo + 180) % 360) - 180
        sh = coarse_shares(counts, la, lo)
        if not screen.dsm_pass(sh):
            continue
        p = {"lat": la, "lon": lo, "band": screen._band(la), "relief_class": -1, "coarse_relief_m": float("nan"),
             **screen.wc_fields(sh)}
        if add(p, "local", "adaptive_local"):
            got_loc += 1
    for i, w in enumerate(out):
        w["id"] = f"A{i + 1:05d}"
        w["role"] = "screen"
        w["selected_by"] = "global_screen"
        w["eligible_discovery"] = int(w.get("dsm_pass", 1))
    alloc = {"seed": seed, "n_total_target": n_total, "fractions": FRAC, "top_frac": TOP_FRAC,
             "n_top_hits": len(hits), "local_radius_km": LOCAL_RADIUS_KM,
             "selected": {"uniform": n_uni_real, "strata": sum(v["selected"] for v in real_strata.values()),
                          "local": got_loc}, "strata": real_strata, "local_tries": tries}
    with open(WINDOWS_CSV, "w", newline="") as fh:
        wr = csv.DictWriter(fh, fieldnames=screen.WIN_COLS + ["adaptive_kind"], extrasaction="ignore")
        wr.writeheader()
        wr.writerows(out)
    ALLOC_JSON.write_text(json.dumps(alloc, indent=1))
    log.info("adaptive round: %s", alloc["selected"])
    return out, alloc


def run(n_total: int = N_TOTAL, workers: int = 24, budget_s: float = 2400.0) -> dict:
    wins, alloc = build(n_total)
    wins.sort(key=lambda w: (math.floor(float(w["lat"])), math.floor(float(w["lon"]))))
    alloc["fingerprint_run"] = screen.fingerprint_windows(wins, workers=workers, budget_s=budget_s)
    ALLOC_JSON.write_text(json.dumps(alloc, indent=1))
    return alloc
