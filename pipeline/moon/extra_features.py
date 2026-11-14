"""Extra Moon fingerprint features: terrain shape (90 m and 30 m) and LOLA 1064 nm brightness.

For each of the 9 regions the 20 m near field (45 km window, data/interim/moon/<id>_near20.npz) is
area-averaged with ``pipeline.metrics.resample.to_grid``:
  * 90 m: 500 x 500, central 166 x 166 px core (14.94 km), as in fingerprints_90m.json;
  * 30 m: 1500 x 1500, central 500 x 500 px core (15 km), the common comparison grid.
``pipeline.metrics.shape.shape_features`` runs on the core only (no buffer), exactly as the Earth
side must. Brightness is LOLA normal albedo (LDAM_50S_1000M_FLOAT) over the 15 km core square,
plus its percentile rank / log z-score among all 15 km blocks south of 80 S.

CLI: ``python -m pipeline.moon.extra_features [--force]`` ->
``data/interim/moon/fingerprints_extra.json``.
"""
from __future__ import annotations

import argparse
import json
import logging
import math
import time
from datetime import datetime, timezone

import numpy as np

from pipeline.common.config import INTERIM, REGION_IDS
from pipeline.metrics.brightness import (
    MOON_SOURCE, brightness_rank_feature, load_ldam, moon_brightness, moon_reference,
)
from pipeline.metrics.resample import to_grid
from pipeline.metrics.shape import CURV_SCALES_M, shape_features

log = logging.getLogger("pipeline.moon.extra_features")

INTERIM_MOON = INTERIM / "moon"
OUT = INTERIM_MOON / "fingerprints_extra.json"
NEAR_RES = 20.0
GRIDS: dict[str, tuple[float, int]] = {"90m": (90.0, 166), "30m": (30.0, 500)}
CORE_M = 15000.0
PIPELINE_VERSION = "extra-0.1.0"
JsonValue = float | int | str | None | list["JsonValue"] | dict[str, "JsonValue"]


def _clean(obj: object) -> JsonValue:
    """Round floats to 5 significant decimals and turn NaN/inf into None (strict JSON)."""
    if isinstance(obj, dict):
        return {str(k): _clean(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_clean(v) for v in obj]
    if isinstance(obj, (float, np.floating)):
        f = float(obj)
        return round(f, 6) if math.isfinite(f) else None
    if isinstance(obj, (int, np.integer)):
        return int(obj)
    if isinstance(obj, str) or obj is None:
        return obj
    raise TypeError(f"cannot serialise {type(obj).__name__}")


def region_features(rid: str, ldam: np.ndarray, moon_ref: list[float]) -> dict[str, object]:
    z = np.load(INTERIM_MOON / f"{rid}_near20.npz")
    dem20 = z["dem"].astype(np.float64)
    x0, y0, res = float(z["x0"]), float(z["y0"]), float(z["res"])
    if not math.isclose(res, NEAR_RES):
        raise ValueError(f"{rid}: near field res {res} != {NEAR_RES}")
    win_m = dem20.shape[0] * res
    cx, cy = x0 + win_m / 2.0, y0 - win_m / 2.0
    out: dict[str, object] = {"centre_xy": [cx, cy]}
    for tag, (r, core_px) in GRIDS.items():
        t0 = time.perf_counter()
        d = to_grid(dem20, NEAR_RES, r)
        c0 = (d.shape[0] - core_px) // 2
        core = d[c0:c0 + core_px, c0:c0 + core_px]
        f = shape_features(core, r)
        dt = time.perf_counter() - t0
        out[tag] = {"res_m": r, "core_px": core_px, "core_m": core_px * r,
                    "core_origin_xy": [x0 + c0 * r, y0 - c0 * r], "core_nan_frac": float(np.isnan(core).mean()),
                    "runtime_s": round(dt, 3), **f}
    b = moon_brightness(cx, cy, CORE_M, ldam)
    rk = brightness_rank_feature(b["bright_mean"], moon_ref)
    q = b.pop("bright_quantiles_101")
    out["brightness"] = {"scalars": {**b, **rk}, "quantiles_101": {"bright_albedo": q}}
    return out


def run(force: bool = False) -> dict[str, object]:
    if OUT.exists() and not force:
        return json.loads(OUT.read_text())
    ldam = load_ldam()
    moon_ref = moon_reference()
    regions: dict[str, object] = {}
    for rid in REGION_IDS:
        regions[rid] = region_features(rid, ldam, moon_ref)
        s90 = regions[rid]["90m"]["scalars"]  # type: ignore[index]
        log.info("%s: depr/100km2 %.2f  HI %.3f  aspect R %.3f  bright %.4f (rank %.2f)", rid,
                 s90["shape_depr_per_100km2"], s90["shape_hypso_integral"], s90["shape_aspect_R"],
                 regions[rid]["brightness"]["scalars"]["bright_mean"],  # type: ignore[index]
                 regions[rid]["brightness"]["scalars"]["bright_rank"])  # type: ignore[index]
    doc = {
        "meta": {
            "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "pipeline_version": PIPELINE_VERSION,
            "note": __doc__.strip(),
            "quantiles": "0..100 step 1 (%)",
            "curvature_scales_m": list(CURV_SCALES_M),
            "brightness_reference": {"population": "15 km block means of LDAM south of 80 S",
                                     "q101": moon_ref},
            "sources": [MOON_SOURCE, {
                "name": "LOLA LDEM_80S_20MPP_ADJ (shape features)",
                "url": "https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LDEM_80S_20MPP_ADJ.TIF",
                "licence": "NASA PGDA, public domain",
                "citation": "Barker, M.K. et al. (2021) Improved LOLA elevation maps for south pole landing sites: "
                            "error estimates and their impact on illumination conditions. PSS 203:105119, "
                            "doi:10.1016/j.pss.2020.105119"}],
            "null_means": "NaN (e.g. no depressions -> depression medians null, quantile list [])",
        },
        "regions": regions,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    tmp = OUT.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(_clean(doc), indent=1, allow_nan=False))
    tmp.replace(OUT)
    log.info("wrote %s", OUT)
    return doc


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--force", action="store_true", help="recompute even if the output exists")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s",
                        datefmt="%H:%M:%S")
    run(force=args.force)


if __name__ == "__main__":
    main()
