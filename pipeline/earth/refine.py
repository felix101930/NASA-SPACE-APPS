"""Zoom-in refinement of the best stage-1 windows (90 m, same fingerprint + distance).

For each region x hazard search, the top TOP_N eligible windows are re-centred:
1. coarse pass: 5 x 5 grid of offsets {-10,-5,0,+5,+10} km (24 new positions),
2. fine pass: 3 x 3 grid of +-2.5 km around the best coarse position for that search.
Shifted positions must pass the DSM-safe filter (coarse WorldCover map). The best position per
(original window, search) is kept; positions within MIN_SEP_KM of each other are merged (best
distance wins). Refined windows get ids R##### and replace their originals in the ranking.
"""
from __future__ import annotations

import json
import logging
import math
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np

from pipeline.earth import rank_stage1, screen
from pipeline.earth.common import INTERIM, cop_tile_exists
from pipeline.earth.fingerprint import fingerprint_90m
from pipeline.earth.landcover import build_coarse_map, coarse_shares

log = logging.getLogger("pipeline.earth.refine")

TOP_N = 10
COARSE_KM = (-10.0, -5.0, 0.0, 5.0, 10.0)
FINE_KM = (-2.5, 0.0, 2.5)
CAND_JSONL = INTERIM / "refine_candidates.jsonl"


def _offset(lat: float, lon: float, dn_km: float, de_km: float) -> tuple[float, float]:
    la = lat + dn_km / 111.32
    lo = lon + de_km / (111.32 * max(math.cos(math.radians(lat)), 0.05))
    return round(la, 6), round(((lo + 180) % 360) - 180, 6)


class Store:
    """Cache of fingerprints at arbitrary positions (keyed by rounded lat/lon)."""

    def __init__(self):
        self.rows: dict[str, dict] = {}
        if CAND_JSONL.exists():
            for line in CAND_JSONL.read_text().splitlines():
                if line.strip():
                    d = json.loads(line)
                    self.rows[d["key"]] = d
        self.counts = build_coarse_map()
        from pipeline.earth.extras import available
        self.with_shape = rank_stage1.USE_EXTRAS and available()

    def get_many(self, pts: list[tuple[float, float]], workers: int = 24) -> list[dict | None]:
        todo = []
        for la, lo in pts:
            k = screen._ckey(la, lo)
            if k not in self.rows and k not in {t[0] for t in todo}:
                todo.append((k, la, lo))

        def job(t):
            k, la, lo = t
            if not cop_tile_exists(la, lo, 90):
                return {"key": k, "lat": la, "lon": lo, "status": "nodata"}
            sh = coarse_shares(self.counts, la, lo)
            base = {"key": k, "lat": la, "lon": lo, **screen.wc_fields(sh)}
            if not screen.dsm_pass(sh):
                return {**base, "status": "filtered"}
            try:
                fp = fingerprint_90m(la, lo)
                if self.with_shape and "shadow_frac_local_el3" in fp:
                    from pipeline.earth.extras import _shape_job
                    fp["shape"] = {k: v for k, v in _shape_job((k, la, lo)).items() if k != "id"}
            except Exception as exc:  # noqa: BLE001
                log.warning("refine fingerprint failed %.4f %.4f: %s", la, lo, exc)
                return {**base, "status": "error"}
            st = "ok" if "shadow_frac_local_el3" in fp else "nodata"
            return {**base, **fp, "status": st}

        if todo:
            with ThreadPoolExecutor(workers) as ex, open(CAND_JSONL, "a") as fh:
                for d in ex.map(job, todo):
                    self.rows[d["key"]] = d
                    fh.write(json.dumps(d, default=float) + "\n")
        return [self.rows.get(screen._ckey(la, lo)) for la, lo in pts]


def _dist(store_rows: list[dict | None], search: str, moon: dict, scal: dict, xt: dict | None = None) -> np.ndarray:
    rid, hz = search.split("|")
    rows, quants, idx = [], {}, []
    sub_xt = None
    if xt is not None:
        sub_xt = {**xt, "shape": dict(xt["shape"]), "branks": dict(xt["branks"])}
    for i, d in enumerate(store_rows):
        if d and d.get("status") == "ok" and "quantiles_101" in d:
            rid_i = f"_c{i}"
            rows.append({**d, "id": rid_i, "selected_by": "refine"})
            quants[rid_i] = {k: np.array(v, float) for k, v in d["quantiles_101"].items()}
            if sub_xt is not None:
                if d.get("shape"):
                    sub_xt["shape"][rid_i] = d["shape"]
                b = d.get("bright_rank")
                if b is not None:
                    sub_xt["branks"][rid_i] = b
            idx.append(i)
    out = np.full(len(store_rows), np.inf)
    if rows:
        D = rank_stage1.distances(rows, quants, {rid: moon[rid]}, scal=scal, quiet=True, xt=sub_xt)
        out[idx] = D[search]
    return out


def _add_brightness(store: "Store", pts_rows: list[dict | None], ref: np.ndarray) -> None:
    """Attach bright_rank (vs the screened DSM-safe reference) to store rows lacking it."""
    from pipeline.metrics.brightness import brightness_rank_feature, earth_brightness_batch
    need = [d for d in pts_rows if d and d.get("status") == "ok" and "bright_rank" not in d]
    if not need:
        return
    res = earth_brightness_batch([(d["lat"], d["lon"]) for d in need])
    for d, b in zip(need, res):
        v = b.get("bright_mean")
        d["bright_rank"] = (brightness_rank_feature(v, ref)["bright_rank"]
                            if v is not None and math.isfinite(v) else None)


def run(top_n: int = TOP_N, force: bool = False) -> dict:
    if rank_stage1.REFINE_JSON.exists() and not force:
        return json.loads(rank_stage1.REFINE_JSON.read_text())
    t0 = time.time()
    rows = screen.load_fingerprints()
    quants = screen.load_quantiles()
    moon = rank_stage1.load_moon()
    scal = rank_stage1.scalar_scales(rows)
    xt = rank_stage1.load_extras(rows)
    D = rank_stage1.distances(rows, quants, moon, scal=scal, xt=xt)
    bref = None
    if xt is not None:
        from pipeline.earth.extras import enrich_brightness
        bvals = enrich_brightness(rows)
        bref = np.array([bvals.get(r["id"]) for r in rows if str(r["id"])[0] in "SA"
                         and int(r.get("eligible_discovery") or 0) == 1 and bvals.get(r["id"]) is not None], float)
    elig = np.array([r["selected_by"] == "global_screen" and int(r.get("eligible_discovery") or 0) == 1
                     and r.get("status") == "ok" and (r.get("core_nan_frac") or 0) < 0.05
                     and str(r["id"])[0] in "SA" for r in rows])
    pairs: dict[str, list[str]] = {}
    for key, d in D.items():
        dd = np.where(elig & np.isfinite(d), d, np.inf)
        for i in np.argsort(dd)[:top_n]:
            pairs.setdefault(rows[int(i)]["id"], []).append(key)
    # documented SEED sites (never held-out) as extra starting points, refined for every search
    from pipeline.earth.pool import LIT_SEED
    n_seed = 0
    for r in rows:
        if r["id"] in LIT_SEED and r.get("status") == "ok":
            pairs.setdefault(r["id"], []).extend(k for k in D if k not in pairs.get(r["id"], []))
            n_seed += 1
    by_id = {r["id"]: (i, r) for i, r in enumerate(rows)}
    log.info("refine: %d originals (%d documented seeds) from %d searches x top %d", len(pairs), n_seed, len(D), top_n)
    store = Store()
    # coarse pass: one grid per original, shared by all its searches
    grids = {}
    all_pts = []
    for oid in pairs:
        _, r = by_id[oid]
        g = [_offset(r["lat"], r["lon"], dn, de) for dn in COARSE_KM for de in COARSE_KM if (dn, de) != (0.0, 0.0)]
        grids[oid] = g
        all_pts.extend(g)
    got = store.get_many(all_pts)
    if bref is not None:
        _add_brightness(store, got, bref)
    log.info("refine coarse pass: %d positions (%.0f s)", len(all_pts), time.time() - t0)
    best: list[dict] = []
    fine_req = []
    for oid, searches in pairs.items():
        i0, r = by_id[oid]
        g_rows = store.get_many(grids[oid])
        for key in searches:
            d_orig = float(D[key][i0])
            dg = _dist(g_rows, key, moon, scal, xt)
            j = int(np.argmin(dg))
            if dg[j] < d_orig:
                bl, bo, bd = g_rows[j]["lat"], g_rows[j]["lon"], float(dg[j])
            else:
                bl, bo, bd = r["lat"], r["lon"], d_orig
            fine = [_offset(bl, bo, dn, de) for dn in FINE_KM for de in FINE_KM if (dn, de) != (0.0, 0.0)]
            fine_req.append((oid, key, d_orig, bl, bo, bd, fine))
    got = store.get_many([p for f in fine_req for p in f[6]])
    if bref is not None:
        _add_brightness(store, got, bref)
    log.info("refine fine pass done (%.0f s)", time.time() - t0)
    for oid, key, d_orig, bl, bo, bd, fine in fine_req:
        f_rows = store.get_many(fine)
        df = _dist(f_rows, key, moon, scal, xt)
        j = int(np.argmin(df))
        if df[j] < bd:
            bl, bo, bd = f_rows[j]["lat"], f_rows[j]["lon"], float(df[j])
        _, r = by_id[oid]
        shift_km = math.hypot((bl - r["lat"]) * 111.32,
                              (bo - r["lon"]) * 111.32 * math.cos(math.radians(r["lat"])))
        best.append({"origin": oid, "search": key, "lat": bl, "lon": bo, "dist": bd, "dist_orig": d_orig,
                     "shift_km": round(shift_km, 2)})
    # merge positions closer than MIN_SEP_KM (keep best distance; union of searches)
    best.sort(key=lambda b: b["dist"] - b["dist_orig"])
    merged: list[dict] = []
    for b in best:
        hit = None
        for m in merged:
            dy = (b["lat"] - m["lat"]) * 111.32
            dx = (b["lon"] - m["lon"]) * 111.32 * math.cos(math.radians(b["lat"]))
            if math.hypot(dx, dy) < screen.MIN_SEP_KM:
                hit = m
                break
        if hit:
            hit["searches"].append(b["search"])
            hit["origins"] = sorted(set(hit["origins"] + [b["origin"]]))
        else:
            merged.append({**b, "searches": [b["search"]], "origins": [b["origin"]]})
    # write refined windows into the main fingerprint files (ids R#####)
    done = screen._load_done()
    with open(screen.FP_CSV, "a", newline="") as fh, open(screen.QUANT_JSONL, "a") as qfh:
        import csv
        wr = csv.DictWriter(fh, fieldnames=screen.FP_COLS, extrasaction="ignore")
        for i, m in enumerate(merged):
            m["id"] = f"R{i + 1:05d}"
            if m["id"] in done:
                continue
            d = store.rows.get(screen._ckey(m["lat"], m["lon"]))
            if d is None:   # unshifted original kept: copy its row
                d = {**by_id[m["origins"][0]][1]}
                q = {k: v.tolist() for k, v in quants[m["origins"][0]].items()}
            else:
                q = d["quantiles_101"]
            row = {k: v for k, v in d.items() if k not in ("quantiles_101", "key")}
            m["from_seed"] = any(o in LIT_SEED for o in m["origins"])
            row.update({"id": m["id"], "lat": m["lat"], "lon": m["lon"], "band": screen._band(m["lat"]),
                        "stratum": "refined_from_seed" if m["from_seed"] else "refined", "role": "screen", "selected_by": "global_screen",
                        "eligible_discovery": 1, "relief_class": -1})
            wr.writerow(row)
            qfh.write(json.dumps({"id": m["id"], "q": q}) + "\n")
    improv = [b["dist_orig"] - b["dist"] for b in best]
    res = {"top_n": top_n, "n_originals": len(pairs), "n_pairs": len(best), "n_refined_windows": len(merged),
           "n_moved": sum(1 for b in best if b["shift_km"] > 0),
           "mean_improvement": float(np.mean(improv)) if improv else 0.0,
           "median_rel_improvement": float(np.median([(b["dist_orig"] - b["dist"]) / b["dist_orig"]
                                                      for b in best if b["dist_orig"] > 0])) if best else 0.0,
           "replaced_ids": sorted(pairs.keys()),
           "n_from_documented_seed": sum(1 for m in merged if m.get("from_seed")),
           "windows": [{k: m.get(k) for k in ("id", "lat", "lon", "dist", "dist_orig", "shift_km", "searches",
                                              "origins", "from_seed")}
                       for m in merged],
           "elapsed_s": round(time.time() - t0, 1)}
    rank_stage1.REFINE_JSON.write_text(json.dumps(res, indent=1))
    log.info("refine: %d pairs, %d moved, mean improvement %.3f, %d refined windows (%.0f s)", len(best),
             res["n_moved"], res["mean_improvement"], len(merged), res["elapsed_s"])
    return res
