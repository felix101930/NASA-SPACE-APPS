"""Moon reference per region: metric values, within-region IQRs, 30 m shape, brightness, per-azimuth shadow.

"Moon region IQR" = interquartile range of a metric across the 25 blocks of 3 km x 3 km that tile the
15 km core (30 m LOLA tile + its 72-azimuth horizon map). It says how much the metric varies as you
move around inside the landing region, which is the natural yardstick for "is this Earth value
Moon-like for this region". Cached in data/interim/match/moon_ref.json (keyed on input files).
"""
from __future__ import annotations

import logging
import math

import cv2
import numpy as np

from pipeline.match.common import INTERIM, MOON_INTERIM, REGIONS_JSON, file_sig, read_json, read_tile, write_json

log = logging.getLogger("pipeline.match.moon_ref")

CACHE = INTERIM / "moon_ref.json"
BLOCK_PX = 100          # 3 km blocks on the 30 m grid -> 5 x 5 blocks per 15 km core
RES_M = 30.0
SHAPE_SCALARS = ("shape_aspect_R", "shape_aspect_R2", "shape_depr_per_100km2", "shape_depr_area_frac",
                 "shape_hypso_integral")
AZ_PROFILE_ELS = (1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0)
CORE_KEYS = ("shadow_frac_el1", "shadow_frac_el3", "shadow_frac_el5", "shadow_frac_timeweighted",
             "jump1km_p95_m", "jump1km_p99_m", "frac_track_over_500m", "fast_per_km2_el3",
             "empty_cell_frac_el3", "slope_p50_deg")


def _blocks(n: int = 500, b: int = BLOCK_PX) -> list[tuple[slice, slice]]:
    k = n // b
    return [(slice(i * b, (i + 1) * b), slice(j * b, (j + 1) * b)) for i in range(k) for j in range(k)]


def _iqr(vals: list[float]) -> tuple[float, float] | None:
    v = np.asarray([x for x in vals if x is not None and math.isfinite(x)], float)
    if v.size < 4:
        return None
    return float(np.percentile(v, 25)), float(np.percentile(v, 75))


def block_values(dem: np.ndarray, horizon: np.ndarray, lat: float, lon: float) -> dict[str, list[float]]:
    """Per-3 km-block values of every core metric (same definitions as pipeline.metrics.compute_all)."""
    from pipeline.metrics import render_hillshade, rim_jump_stats, shadow_mask, slope_deg, sun_path_moon
    from pipeline.metrics.horizon import time_weighted_visibility
    from pipeline.metrics.shape import shape_features

    blocks = _blocks(dem.shape[0])
    out: dict[str, list[float]] = {k: [] for k in CORE_KEYS + SHAPE_SCALARS}
    valid = np.isfinite(horizon[0])
    sh_maps = {el: np.where(valid, (horizon > el).mean(axis=0), np.nan) for el in (1.0, 3.0, 5.0)}
    el_s, az_s = sun_path_moon(lat, 2048, lon_deg=lon)
    keep = el_s >= 0.0
    vis = time_weighted_visibility(horizon, el_s[keep], az_s[keep])
    slope = slope_deg(dem, RES_M)
    # texture: full-tile hillshades (8 azimuths, sun 3 deg, cast shadows) -> keypoints counted per block
    det = cv2.FastFeatureDetector_create(threshold=20, nonmaxSuppression=True)
    kp_maps = []
    for k in range(8):
        az = 45.0 * k
        img = render_hillshade(dem, RES_M, 3.0, az, shadow_mask(horizon, 3.0, az))
        cnt = np.zeros(dem.shape, np.int32)
        for kp in det.detect(np.ascontiguousarray(img, np.uint8), None):
            cnt[min(int(kp.pt[1]), dem.shape[0] - 1), min(int(kp.pt[0]), dem.shape[1] - 1)] += 1
        kp_maps.append(cnt)
    cell = int(round(1000.0 / RES_M))  # 33 px ~ 1 km cells, as in fast_density
    for rs, cs in blocks:
        for el in (1, 3, 5):
            out[f"shadow_frac_el{el}"].append(float(np.nanmean(sh_maps[float(el)][rs, cs])))
        out["shadow_frac_timeweighted"].append(float(1.0 - np.nanmean(vis[rs, cs])))
        rim = rim_jump_stats(dem[rs, cs], RES_M, short_baseline_m=None)
        out["jump1km_p95_m"].append(rim["jump1km_p95_m"])
        out["jump1km_p99_m"].append(rim["jump1km_p99_m"])
        out["frac_track_over_500m"].append(rim["frac_track_over_500m"])
        dens, empt = [], []
        area_km2 = (BLOCK_PX * RES_M / 1000.0) ** 2
        for cnt in kp_maps:
            c = cnt[rs, cs]
            dens.append(c.sum() / area_km2)
            nb = BLOCK_PX // cell
            cells = [c[i * cell:(i + 1) * cell, j * cell:(j + 1) * cell].sum() for i in range(nb) for j in range(nb)]
            empt.append(float(np.mean([x == 0 for x in cells])))
        out["fast_per_km2_el3"].append(float(np.mean(dens)))
        out["empty_cell_frac_el3"].append(float(np.mean(empt)))
        out["slope_p50_deg"].append(float(np.nanpercentile(slope[rs, cs], 50)))
        sf = shape_features(dem[rs, cs], RES_M)["scalars"]
        for k in SHAPE_SCALARS:
            v = sf.get(k)
            out[k].append(float(v) if v is not None else float("nan"))
    return out


def az_shadow_profile(horizon: np.ndarray) -> dict[str, list[float]]:
    """Shadow fraction per stored azimuth (72, clockwise from grid +y) at a few sun elevations."""
    valid = np.isfinite(horizon[0])
    hz = horizon[:, valid]
    return {f"{el:g}": [round(float(x), 4) for x in (hz > el).mean(axis=1)] for el in AZ_PROFILE_ELS}


def _compute_region(reg: dict, extra: dict) -> dict:
    rid = reg["id"]
    m = {k: v for h in ("shadow", "rim", "texture", "slope") for k, v in reg["hazards"][h]["metrics"].items()}
    values = {k: m.get(k) for k in CORE_KEYS}
    ex = extra.get(rid, {})
    s30 = ex.get("30m", {})
    shape_scalars = {k: s30.get("scalars", {}).get(k) for k in SHAPE_SCALARS + ("shape_aspect_mean_dir_deg",)}
    shape_q = s30.get("quantiles_101", {})
    bright_rank = ex.get("brightness", {}).get("scalars", {}).get("bright_rank")
    dem = read_tile(reg["tile"]["path"])
    hpath = MOON_INTERIM / f"{rid}_horizon30.npy"
    iqr: dict[str, list[float] | None] = {}
    az_prof = None
    check = {}
    if dem is not None and hpath.exists():
        H = np.load(hpath).astype(np.float32)
        bv = block_values(dem, H, float(reg["lat"]), float(reg["lon"]))
        iqr = {k: (list(_iqr(v)) if _iqr(v) else None) for k, v in bv.items()}
        az_prof = az_shadow_profile(H)
        check = {k: round(float(np.nanmean(bv[k])), 4) for k in ("shadow_frac_el3", "shadow_frac_timeweighted")}
    else:
        log.warning("%s: tile or horizon missing; Moon IQR unavailable (scale floors only)", rid)
    return {"values": values, "iqr": iqr, "shape_scalars": shape_scalars, "shape_q": shape_q,
            "bright_rank": bright_rank, "az_shadow": az_prof, "block_mean_check": check,
            "sun": reg.get("sun"), "lat": reg["lat"], "lon": reg["lon"], "name": reg.get("name", rid)}


def load(force: bool = False) -> dict[str, dict]:
    """{region_id: reference dict}; cached on regions.json + Moon interim inputs."""
    extra_p = MOON_INTERIM / "fingerprints_extra.json"
    regions = read_json(REGIONS_JSON)["regions"]
    sig = file_sig(REGIONS_JSON, extra_p, *[MOON_INTERIM / f"{r['id']}_horizon30.npy" for r in regions])
    if CACHE.exists() and not force:
        c = read_json(CACHE)
        if c.get("sig") == sig:
            return c["regions"]
    extra = read_json(extra_p)["regions"] if extra_p.exists() else {}
    out = {}
    for reg in regions:
        log.info("moon ref: %s", reg["id"])
        out[reg["id"]] = _compute_region(reg, extra)
    write_json(CACHE, {"sig": sig, "block_px": BLOCK_PX, "regions": out}, indent=None)
    return out
