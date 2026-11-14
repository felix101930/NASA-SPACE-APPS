"""Per-region 90 m fingerprints for the Earth stage-1 global screen.

The 20 m near field (45 km = core + 15 km buffer) is area-averaged to 90 m (500x500). Metrics use the
central 166x166 px (14.94 km, the closest whole-pixel match to the 15 km core). The local shadow
horizon searches only the 45 km window (no far field), 72 azimuths, curvature on.
Distributions are stored as 101 quantiles (0..100 %) for Wasserstein distances.
"""
from __future__ import annotations

import json
import logging

import numpy as np

from pipeline.common.config import MOON_R_M
from pipeline.moon.common import INTERIM_MOON, write_json
from pipeline.moon.regions import build_regions
from pipeline.moon.windows import NEAR_RES, area_average, load_npz, near_path

log = logging.getLogger(__name__)

OUT = INTERIM_MOON / "fingerprints_90m.json"
RES = 90.0
CORE_PX = 166
LAGS = (180, 360, 720, 1440)
ELS = (1, 3, 5)
Q = np.linspace(0, 100, 101)


def _q(v: np.ndarray) -> list[float]:
    v = np.asarray(v, dtype=np.float64).ravel()
    v = v[np.isfinite(v)]
    return [round(float(x), 5) for x in np.percentile(v, Q)] if v.size else []


def fingerprint(rid: str) -> dict:
    from pipeline.metrics import horizon_map, rms_deviation, rim_jump_stats, slope_deg
    from pipeline.metrics.rim import jump_samples

    dem20, g, _ = load_npz(near_path(rid))
    d90 = area_average(dem20, NEAR_RES, RES).astype(np.float64)
    n = d90.shape[0]
    c0 = (n - CORE_PX) // 2
    sl = (slice(c0, c0 + CORE_PX), slice(c0, c0 + CORE_PX))
    core = d90[sl]
    slope = slope_deg(core, RES)
    rim = rim_jump_stats(core, RES, short_baseline_m=None)
    jumps = jump_samples(core, RES, 1000.0)
    rms = rms_deviation(core, RES, LAGS)
    hz = horizon_map(d90, RES, sl, near_origin_xy=(g.x0, g.y0), n_az=72, planet_radius_m=MOON_R_M)
    valid = np.isfinite(hz[0])
    scal = {
        "slope_p50_deg": float(np.nanpercentile(slope, 50)), "slope_p90_deg": float(np.nanpercentile(slope, 90)),
        "relief_p99_p1_m": float(np.nanpercentile(core, 99) - np.nanpercentile(core, 1)),
        "jump1km_p95_m": rim["jump1km_p95_m"], "jump1km_p99_m": rim["jump1km_p99_m"],
        "frac_track_over_500m": rim["frac_track_over_500m"],
        "rms_dev_m": {str(k): float(v) for k, v in rms.items()},
    }
    quant = {"slope_deg": _q(slope), "height_m": _q(core - np.nanmedian(core)), "jump1km_m": _q(jumps)}
    for el in ELS:
        per_px = (hz[:, valid] > el).mean(axis=0)   # fraction of azimuths shadowed, per pixel
        scal[f"shadow_frac_el{el}_local"] = float(per_px.mean())
        quant[f"shadow_az_frac_el{el}_local"] = _q(per_px)
    return {
        "res_m": RES, "core_px": CORE_PX, "core_m": CORE_PX * RES,
        "core_origin_xy": [g.x0 + c0 * RES, g.y0 - c0 * RES],
        "window_m": n * RES, "horizon": "local only: 45 km window, 72 az, curvature on, no far field",
        "scalars": {k: (round(v, 5) if isinstance(v, float) else v) for k, v in scal.items()},
        "quantiles_101": quant,
    }


def run(force: bool = False) -> dict:
    if OUT.exists() and not force:
        return json.loads(OUT.read_text())
    out = {}
    for r in build_regions():
        out[r.id] = fingerprint(r.id)
        log.info("%s fingerprint: %s", r.id, {k: v for k, v in out[r.id]["scalars"].items() if k != "rms_dev_m"})
    doc = {"meta": {"note": __doc__.strip(), "lags_m": list(LAGS), "quantiles": "0..100 step 1 (%)"}, "regions": out}
    write_json(OUT, doc)
    return doc
