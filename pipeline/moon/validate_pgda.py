"""Compare our long-term sun visibility with PGDA product 69 AVGVISIB (85-90S, 60 m).

Ours: per-pixel time-averaged visible fraction of the solar disk over the approximate 18.6-yr sun
path (declination 1.54*sin(phase) x uniform hour angle, 11 520 directions; all samples, night included), computed
from the cached 30 m horizon maps (72 az, near 30 m + far 240 m to 150 km, curvature), then
area-averaged 2x2 to the AVGVISIB 60 m grid (both grids share 60 m-aligned edges).
PGDA: AVGVISIB_85S_060M_201608 (int16, scale 4e-5 -> 0..1), hourly over 18.6 yr (Mazarico 2011).
"""
from __future__ import annotations

import logging
import math

import numpy as np

from pipeline.common.config import GRID_RES_M
from pipeline.moon.common import ILLUM_LOCAL, ILLUM_URL, INTERIM_MOON, write_json
from pipeline.moon.compute import region_horizon, sun_series_grid
from pipeline.moon.regions import build_regions
from pipeline.moon.windows import CORE_M, core_grid

log = logging.getLogger(__name__)

OUT = INTERIM_MOON / "validation_pgda.json"
PGDA_RES = 60.0


def ensure_illum() -> None:
    if ILLUM_LOCAL.exists() and ILLUM_LOCAL.stat().st_size > 30_000_000:
        return
    import requests

    log.info("downloading %s", ILLUM_URL)
    with requests.get(ILLUM_URL, stream=True, timeout=300) as r:
        r.raise_for_status()
        tmp = ILLUM_LOCAL.with_suffix(".part")
        with tmp.open("wb") as fh:
            for chunk in r.iter_content(1 << 20):
                fh.write(chunk)
    tmp.replace(ILLUM_LOCAL)


def read_pgda(x0: float, y0: float, n: int) -> np.ndarray | None:
    """n x n window (60 m) with top-left corner (x0, y0); None if not fully inside the product."""
    import rasterio
    from rasterio.windows import Window

    with rasterio.open(ILLUM_LOCAL) as ds:
        col = (x0 - ds.bounds.left) / PGDA_RES
        row = (ds.bounds.top - y0) / PGDA_RES
        if abs(col - round(col)) > 1e-6 or abs(row - round(row)) > 1e-6:
            raise ValueError("grid misaligned with AVGVISIB")
        col, row = int(round(col)), int(round(row))
        if col < 0 or row < 0 or col + n > ds.width or row + n > ds.height:
            return None
        raw = ds.read(1, window=Window(col, row, n, n)).astype(np.float64)
        nod = ds.nodata
        scale, offset = ds.scales[0], ds.offsets[0]
    out = raw * scale + offset
    if nod is not None:
        out[raw == nod] = np.nan
    return out


def _stats(ours: np.ndarray, ref: np.ndarray) -> dict:
    ok = np.isfinite(ours) & np.isfinite(ref)
    a, b = ours[ok], ref[ok]
    d = a - b
    bias = float(d.mean())
    ss_res = float(np.sum(d ** 2))
    ss_tot = float(np.sum((b - b.mean()) ** 2))
    return {"pearson_r": float(np.corrcoef(a, b)[0, 1]), "mae": float(np.mean(np.abs(d))),
            "bias": bias, "rmse": float(np.sqrt(np.mean(d ** 2))),
            # R² of ours as a direct predictor of PGDA (1 - SS_res/SS_tot), offset included
            "r2": float(1.0 - ss_res / ss_tot) if ss_tot > 0 else float("nan"),
            # MAE after removing the constant mean offset: how well the pattern itself matches
            "mae_offset_removed": float(np.mean(np.abs(d - bias))),
            "n_px": int(ok.sum()),
            "ours_mean": float(a.mean()), "pgda_mean": float(b.mean())}


def run(force: bool = False) -> dict:
    if OUT.exists() and not force:
        import json
        return json.loads(OUT.read_text())
    from pipeline.metrics import time_weighted_visibility

    ensure_illum()
    n60 = int(CORE_M / PGDA_RES)
    per, all_o, all_p = {}, [], []
    for r in build_regions():
        cg = core_grid(r)
        ref = read_pgda(cg.x0, cg.y0, n60)
        if ref is None:
            per[r.id] = {"included": False, "reason": "core not fully inside AVGVISIB 85-90S extent"}
            continue
        hz = np.asarray(region_horizon(r.id))
        el, az = sun_series_grid(r)
        vis30 = time_weighted_visibility(hz, el, az, disk=True).astype(np.float64)
        f = int(round(PGDA_RES / GRID_RES_M))
        vis60 = vis30.reshape(n60, f, n60, f).mean(axis=(1, 3))
        st = _stats(vis60, ref)
        st["included"] = True
        per[r.id] = st
        all_o.append(vis60.ravel())
        all_p.append(ref.ravel())
        log.info("%s vs PGDA: r=%.3f MAE=%.3f bias=%+.3f RMSE=%.3f R2=%.3f MAE0=%.3f", r.id, st["pearson_r"],
                 st["mae"], st["bias"], st["rmse"], st["r2"], st["mae_offset_removed"])
    pooled = _stats(np.concatenate(all_o), np.concatenate(all_p))
    region_means = [(v["ours_mean"], v["pgda_mean"]) for v in per.values() if v.get("included")]
    mo, mp = np.array(region_means).T
    doc = {
        "shadow_vs_pgda": {
            **{k: pooled[k] for k in ("pearson_r", "mae", "bias", "rmse", "r2", "mae_offset_removed", "n_px")},
            "region_mean_pearson_r": float(np.corrcoef(mo, mp)[0, 1]) if len(mo) > 2 else None,
            "note": ("Pixelwise at 60 m over the 15 km cores of regions inside 85-90S; ours = mean solar-disk "
                     "visibility over an approximate 18.6-yr sun path (declination 1.54°·sin(phase), 11 520 directions, solar disk 0.27°) from LOLA 20 m "
                     "(PGDA 90) horizons; PGDA = AVGVISIB_85S_060M_201608 (Mazarico et al. 2011, hourly 18.6 yr, "
                     "older LOLA DEM). bias = ours − PGDA (visibility, 0..1); rmse = root-mean-square error; r2 = 1 − SS_res/SS_tot "
                     "(ours as a direct predictor, offset included); mae_offset_removed = MAE after subtracting the "
                     "mean bias (pattern error only)."),
            "per_region": per,
        },
        "source": {"pgda_url": ILLUM_URL, "citation": "Mazarico et al. (2011) Icarus 211:1066, doi:10.1016/j.icarus.2010.10.030"},
    }
    if not all(math.isfinite(pooled[k]) for k in ("pearson_r", "mae", "bias")):
        log.warning("non-finite validation stats")
    write_json(OUT, doc)
    log.info("PGDA validation pooled: %s",
             {k: round(pooled[k], 4) for k in ("pearson_r", "mae", "bias", "rmse", "r2", "mae_offset_removed")})
    return doc


ILLUM_120_URL = "https://pgda.gsfc.nasa.gov/data/MoonIllumination/AVGVISIB_75S_120M_201608.TIF"


def pgda_core_visibility(r) -> dict:
    """Mean PGDA AVGVISIB over the region's 15 km core: 60 m product inside 85S, else 120 m (75-90S)."""
    import rasterio
    from rasterio.windows import from_bounds

    cg = core_grid(r)
    ref = read_pgda(cg.x0, cg.y0, int(CORE_M / PGDA_RES)) if ILLUM_LOCAL.exists() else None
    if ref is not None:
        return {"pgda_avg_visibility": round(float(np.nanmean(ref)), 4), "res_m": PGDA_RES, "url": ILLUM_URL}
    local = ILLUM_LOCAL.parent / "AVGVISIB_75S_120M_201608.TIF"
    if not local.exists() or local.stat().st_size < 80_000_000:
        return {"pgda_avg_visibility": None, "res_m": None, "url": ILLUM_120_URL}
    with rasterio.open(local) as ds:
        win = from_bounds(cg.x0, cg.y0 - CORE_M, cg.x0 + CORE_M, cg.y0, transform=ds.transform)
        raw = ds.read(1, window=win.round_offsets().round_lengths()).astype(np.float64)
        val = raw * ds.scales[0] + ds.offsets[0]
        if ds.nodata is not None:
            val[raw == ds.nodata] = np.nan
    return {"pgda_avg_visibility": round(float(np.nanmean(val)), 4), "res_m": 120.0, "url": ILLUM_120_URL}
