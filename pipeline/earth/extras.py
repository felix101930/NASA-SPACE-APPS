"""Extra stage-1 features: terrain shape (pipeline.metrics.shape) and brightness rank
(pipeline.metrics.brightness), and their distance terms (docs/features-extra.md).

- Shape at 90 m on the same 167 px core as the fingerprint (Moon side: the 90m block; 90 m vs 90 m only).
- Brightness: MODIS MCD43C3 pseudo-1064 nm window mean, ranked against the SCREENED DSM-safe Earth
  windows (lead decision: vegetation is bright at 1064 nm, so not against all land).
- Distance terms (one averaged sub-term per group, per the features doc):
    rim    += mean(shape scalar + quantile terms)
    shadow += mean(aspect R, R2 terms); + brightness at weight 0.5
    texture+= brightness at weight 0.5
"""
from __future__ import annotations

import json
import logging
import math
from concurrent.futures import ThreadPoolExecutor

import numpy as np

from pipeline.common.config import INTERIM as INTERIM_ROOT
from pipeline.earth.common import INTERIM
from pipeline.earth.dem import fill_nan, read_dem, site_geom
from pipeline.earth.fingerprint import CORE_N, NEAR_N, RES

log = logging.getLogger("pipeline.earth.extras")

SHAPE_JSONL = INTERIM / "screen_shape.jsonl"
BRIGHT_JSON = INTERIM / "screen_brightness.json"
MOON_EXTRA = INTERIM_ROOT / "moon" / "fingerprints_extra.json"
BRIGHT_WEIGHT = 0.5
# Validation check (stage 1, 11,940 windows): adding the shape rim sub-term dropped known-vs-decoy AUC
# 0.80 -> 0.70 (decoy median best-rank 66 % -> 19 %: forest/farm DSMs mimic bowl/curvature stats),
# while aspect (shadow) and brightness kept or raised it (0.80 / 0.82 ext). So the shape rim term is
# computed and reported but NOT used in the ranking.
USE_RIM_SHAPE = False
SCALAR_FLOORS = {"shape_depr_per_100km2": 1.0, "shape_depr_area_frac": 0.01, "shape_hypso_integral": 0.05,
                 "shape_aspect_R": 0.05, "shape_aspect_R2": 0.05}


def available() -> bool:
    try:
        from pipeline.metrics import brightness, shape  # noqa: F401
        return MOON_EXTRA.exists()
    except Exception:  # noqa: BLE001
        return False


def _keys():
    from pipeline.metrics.shape import SHAPE_HAZARD_KEYS
    sc = set(SHAPE_HAZARD_KEYS["rim"]["scalars"]) | set(SHAPE_HAZARD_KEYS["shadow"]["scalars"])
    qk = set(SHAPE_HAZARD_KEYS["rim"]["quantiles_101"])
    return sorted(sc), sorted(qk)


def shape_from_core(core: np.ndarray, res: float = RES) -> dict:
    from pipeline.metrics.shape import shape_features
    sc_k, q_k = _keys()
    f = shape_features(core, res)
    return {"s": {k: (float(f["scalars"][k]) if f["scalars"].get(k) is not None else None) for k in sc_k},
            "q": {k: [round(float(x), 4) for x in (f["quantiles_101"].get(k) or [])] for k in q_k}}


def _shape_job(item):
    sid, lat, lon = item
    try:
        g = site_geom(lat, lon, RES, NEAR_N)
        near = read_dem(g, source=90)
        b = (NEAR_N - CORE_N) // 2
        core = fill_nan(near)[b:b + CORE_N, b:b + CORE_N]
        return {"id": sid, **shape_from_core(core)}
    except Exception as exc:  # noqa: BLE001
        log.warning("shape failed %s: %s", sid, exc)
        return {"id": sid, "s": {}, "q": {}}


def load_shape() -> dict[str, dict]:
    out = {}
    if SHAPE_JSONL.exists():
        for line in SHAPE_JSONL.read_text().splitlines():
            if line.strip():
                d = json.loads(line)
                out[d["id"]] = d
    return out


def enrich_shape(rows: list[dict], workers: int = 16) -> dict[str, dict]:
    have = load_shape()
    todo = [(r["id"], float(r["lat"]), float(r["lon"])) for r in rows
            if r["id"] not in have and r.get("status") == "ok"]
    log.info("shape features: %d to compute (%d cached)", len(todo), len(have))
    if todo:
        with ThreadPoolExecutor(workers) as ex, open(SHAPE_JSONL, "a") as fh:
            for i, d in enumerate(ex.map(_shape_job, todo)):
                have[d["id"]] = d
                fh.write(json.dumps(d) + "\n")
                if (i + 1) % 2000 == 0:
                    log.info("  shape %d/%d", i + 1, len(todo))
    return have


def enrich_brightness(rows: list[dict]) -> dict[str, float]:
    from pipeline.metrics.brightness import earth_brightness_batch
    have = json.loads(BRIGHT_JSON.read_text()) if BRIGHT_JSON.exists() else {}
    todo = [r for r in rows if r["id"] not in have]
    if todo:
        res = earth_brightness_batch([(float(r["lat"]), float(r["lon"])) for r in todo])
        for r, b in zip(todo, res):
            v = b.get("bright_mean")
            have[r["id"]] = None if v is None or not math.isfinite(v) else float(v)
        BRIGHT_JSON.write_text(json.dumps(have))
    return have


def brightness_ranks(rows: list[dict], bright: dict[str, float]) -> dict[str, float]:
    """Percentile rank of each window mean among the screened DSM-safe windows (S/A, eligible)."""
    from pipeline.metrics.brightness import brightness_rank_feature
    ref = np.array([bright.get(r["id"]) for r in rows if str(r["id"])[0] in "SA"
                    and int(r.get("eligible_discovery") or 0) == 1 and bright.get(r["id"]) is not None], float)
    return {r["id"]: brightness_rank_feature(bright[r["id"]], ref)["bright_rank"]
            for r in rows if bright.get(r["id"]) is not None}


def load_moon_extra() -> dict[str, dict]:
    d = json.loads(MOON_EXTRA.read_text())["regions"]
    out = {}
    for rid, v in d.items():
        b = v["90m"]
        out[rid] = {"s": b["scalars"], "q": b["quantiles_101"],
                    "bright_rank": v.get("brightness", {}).get("scalars", {}).get("bright_rank")}
    return out


def scalar_scales(rows: list[dict], shape: dict[str, dict]) -> dict[str, float]:
    sc_k, _ = _keys()
    out = {}
    for k in sc_k:
        v = np.array([shape[r["id"]]["s"].get(k) for r in rows if str(r["id"])[0] in "SA" and r["id"] in shape
                      and shape[r["id"]]["s"].get(k) is not None], float)
        v = v[np.isfinite(v)]
        iqr = float(np.percentile(v, 75) - np.percentile(v, 25)) if v.size else 1.0
        out[k] = max(iqr, SCALAR_FLOORS.get(k, 0.01))
    return out


def extra_terms(sid: str, rid: str, shape: dict[str, dict], branks: dict[str, float], moon_x: dict[str, dict],
                scales: dict[str, float]) -> dict[str, float]:
    """{'rim_shape', 'shadow_aspect', 'bright'} distance sub-terms (NaN when unavailable)."""
    from pipeline.metrics.brightness import brightness_distance
    from pipeline.metrics.shape import SCALE_FLOORS, SHAPE_HAZARD_KEYS, quantile_distance
    out = {"rim_shape": float("nan"), "shadow_aspect": float("nan"), "bright": float("nan")}
    m = moon_x[rid]
    e = shape.get(sid)
    if e and e.get("s") and USE_RIM_SHAPE:
        terms = []
        for k in SHAPE_HAZARD_KEYS["rim"]["scalars"]:
            a, b = e["s"].get(k), m["s"].get(k)
            if a is not None and b is not None:
                terms.append(abs(a - b) / scales[k])
        for k in SHAPE_HAZARD_KEYS["rim"]["quantiles_101"]:
            eq, mq = e["q"].get(k) or [], m["q"].get(k) or []
            if len(eq) == 101 and len(mq) == 101:
                d = quantile_distance(eq, mq, SCALE_FLOORS.get(k, 0.05))
                if math.isfinite(d):
                    terms.append(d)
        if terms:
            out["rim_shape"] = float(np.mean(terms))
    if e and e.get("s"):
        at = [abs(e["s"][k] - m["s"][k]) / scales[k] for k in SHAPE_HAZARD_KEYS["shadow"]["scalars"]
              if e["s"].get(k) is not None and m["s"].get(k) is not None]
        if at:
            out["shadow_aspect"] = float(np.mean(at))
    if sid in branks and m.get("bright_rank") is not None:
        out["bright"] = brightness_distance(branks[sid], m["bright_rank"])
    return out
