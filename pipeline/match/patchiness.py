"""Patchiness: does the Earth site vary across its own 15 km square as much as the Moon site does?

The level check (matches.py) compares whole-square values, scaled by the Moon region's IQR across the
25 blocks of 3 km in the 15 km core. This second check compares the SPREAD itself: for every light
metric, the 25 block values of the Moon core and of the Earth tile are computed with ONE function
(moon_ref.block_values, the same block grid and metric code that defines the Moon IQRs), and

    spread       = IQR (p75 - p25) of the 25 block values
    spread_ratio = earth_spread / moon_spread
    patchiness   = "similar" if 0.67 <= ratio <= 1.5, "smoother" if < 0.67, "patchier" if > 1.5

The thresholds are illustrative (a factor of 1.5 either way), not calibrated. Patchiness is a second
indicator only: it never changes the distance, the lights or the ranking.

Horizon: Earth sites keep only a decimated horizon map (every 5th pixel, 0.01 deg steps,
data/interim/earth/sites/<id>_horizon_d5.npz). For a like-for-like comparison the Moon's 30 m horizon
is decimated the same way, and both are bilinearly re-gridded to 30 m before block_values, so the
shadow and texture blocks of both worlds see the same horizon treatment. Rim and slope blocks need no
horizon and are identical to the moon_ref blocks. Each side keeps its own sun path for the
time-weighted shadow (Moon: sun_path_moon; Earth: the site's low-sun series, as in the Earth stage).

Cached per Moon region and per Earth site in data/interim/match/patchiness.json (keyed on tile and
horizon file signatures), so a rerun only computes new sites (~1.5 s per tile).
"""
from __future__ import annotations

import logging

import numpy as np

from pipeline.common.config import WEB_DATA
from pipeline.match import moon_ref
from pipeline.match.common import EARTH_INTERIM, HAZARDS, INTERIM, MOON_INTERIM, file_sig, finite, read_json, write_json
from pipeline.match.matches import LABELS, LIGHT_METRICS

log = logging.getLogger("pipeline.match.patchiness")

CACHE = INTERIM / "patchiness.json"
VERSION = "patch-1"
DECIM = 5                       # Earth horizon cache stride (pipeline/earth/compute.py)
NODATA_CDEG = -32768
SIMILAR_LO, SIMILAR_HI = 0.67, 1.5   # illustrative thresholds on earth_spread / moon_spread
ZERO_SPREAD = 1e-9
# The metric that states each danger in one number (same as web/src/screens/terrain3d/copy.ts).
HEADLINE_METRIC: dict[str, str] = {"shadow": "shadow_frac_el3", "rim": "jump1km_p95_m", "texture": "empty_cell_frac_el3"}
METRICS: tuple[str, ...] = tuple(dict.fromkeys(m for h in HAZARDS for m in LIGHT_METRICS[h]))
HORIZON_METRICS = frozenset(m for m in METRICS if m.startswith("shadow_frac") or m in ("fast_per_km2_el3", "empty_cell_frac_el3"))
FRACTION_METRICS = frozenset(m for m in METRICS if m.startswith("shadow_frac") or m in ("empty_cell_frac_el3", "frac_track_over_500m"))
METHOD_NOTE = (f"Second indicator, not part of the rank. For each light metric, 25 block values (3 km blocks of the "
               f"15 km square, same code as the Moon IQRs) on both worlds; spread = IQR of the 25 values; "
               f"spread_ratio = earth_spread / moon_spread; similar if {SIMILAR_LO} <= ratio <= {SIMILAR_HI}, smoother "
               f"below, patchier above (illustrative thresholds). Shadow and texture blocks use the horizon decimated "
               f"to every {DECIM}th pixel on both worlds (the form stored for Earth sites).")


# ------------------------------------------------------------------ horizon handling (pure)
def decimate_horizon(h: np.ndarray, step: int = DECIM) -> np.ndarray:
    """(n_az, n, n) degrees -> (n_az, n/step, n/step) int16 centi-degrees, as stored for Earth sites."""
    d = np.asarray(h, float)[:, ::step, ::step]
    out = np.round(np.where(np.isfinite(d), d, 0.0) * 100.0).astype(np.int16)
    out[~np.isfinite(d)] = NODATA_CDEG
    return out


def upsample_horizon(h_cdeg: np.ndarray, n: int, step: int = DECIM) -> np.ndarray:
    """Bilinear re-grid of a decimated horizon (sample k sits on pixel k*step) back to (n_az, n, n) degrees."""
    h = np.asarray(h_cdeg).astype(np.float32)
    h[np.asarray(h_cdeg) <= NODATA_CDEG] = np.nan
    h /= 100.0
    m = h.shape[1]
    x = np.arange(n, dtype=np.float64) / step
    i0 = np.clip(np.floor(x).astype(int), 0, m - 1)
    i1 = np.minimum(i0 + 1, m - 1)
    w = np.clip(x - i0, 0.0, 1.0).astype(np.float32)
    rows = h[:, i0, :] * (1 - w)[None, :, None] + h[:, i1, :] * w[None, :, None]
    return rows[:, :, i0] * (1 - w)[None, None, :] + rows[:, :, i1] * w[None, None, :]


def _fill_nan(z: np.ndarray) -> np.ndarray:
    if not np.isnan(z).any():
        return z
    from scipy import ndimage
    idx = ndimage.distance_transform_edt(np.isnan(z), return_distances=False, return_indices=True)
    return z[tuple(idx)]


def block_stats(dem: np.ndarray, h_cdeg: np.ndarray | None, sun: tuple[np.ndarray, np.ndarray]) -> dict[str, list[float] | None]:
    """25 block values per light metric for one 15 km tile; one function for Moon and Earth.

    ``h_cdeg`` is the decimated horizon (None = unavailable: horizon metrics come back None).
    """
    dem = _fill_nan(np.asarray(dem, float))
    if h_cdeg is None:
        horizon = np.full((72,) + dem.shape, -90.0, np.float32)   # placeholder; horizon metrics dropped below
    else:
        horizon = upsample_horizon(h_cdeg, dem.shape[0])
    bv = moon_ref.block_values(dem, horizon, 0.0, 0.0, sun=sun, with_shape=False)
    return {k: (None if (h_cdeg is None and k in HORIZON_METRICS) else [float(x) for x in bv[k]]) for k in METRICS}


# ------------------------------------------------------------------ comparison (pure)
def spread(vals: list[float] | None) -> float | None:
    """IQR of the block values (None if fewer than 4 finite values)."""
    v = np.asarray([x for x in (vals or []) if finite(x)], float)
    if v.size < 4:
        return None
    return float(np.percentile(v, 75) - np.percentile(v, 25))


def classify(earth_spread: float, moon_spread: float) -> tuple[float | None, str]:
    """(spread_ratio, patchiness). A flat Moon square: ratio undefined; flat Earth too -> similar, else patchier."""
    if moon_spread <= ZERO_SPREAD:
        return (None, "similar") if earth_spread <= ZERO_SPREAD else (None, "patchier")
    r = earth_spread / moon_spread
    return r, ("smoother" if r < SIMILAR_LO else "patchier" if r > SIMILAR_HI else "similar")


def _round_for(metric: str) -> int:
    if metric in FRACTION_METRICS:
        return 4
    if metric.endswith("_m"):
        return 1
    return 2


def fmt_spread(metric: str, v: float) -> str:
    if metric in FRACTION_METRICS:
        x = 100 * v
        return f"{x:.0f} pts" if x >= 9.5 or x == 0 else f"{x:.1f} pts"
    if metric.endswith("_m"):
        return f"{v:.0f} m"
    if metric == "fast_per_km2_el3":
        return f"{v:.1f} per km²"
    if metric.endswith("_deg"):
        return f"{v:.1f}°"
    return f"{v:.3g}"


def sentence(metric: str, patch: str, ratio: float | None, earth_spread: float, moon_spread: float) -> str:
    sp = f"(Earth spread {fmt_spread(metric, earth_spread)} vs Moon {fmt_spread(metric, moon_spread)})"
    if ratio is None:
        return f"Neither square varies in this measure {sp}" if patch == "similar" else \
            f"Varies more than the Moon site, which is uniform in this measure {sp}"
    if patch == "similar":
        return f"Varies about as much as the Moon site {sp}"
    if patch == "smoother":
        return f"Smoother than the Moon site: varies less across its area {sp}"
    return f"Patchier than the Moon site: varies more across its area {sp}"


def compare(metric: str, moon_blocks: list[float] | None, earth_blocks: list[float] | None) -> dict:
    """Fields added to a light row; all None when either side's blocks are unavailable."""
    nd = _round_for(metric)
    ms, es = spread(moon_blocks), spread(earth_blocks)
    rec = {"moon_blocks": [round(x, nd) for x in moon_blocks] if moon_blocks else None,
           "earth_blocks": [round(x, nd) for x in earth_blocks] if earth_blocks else None,
           "moon_spread": None, "earth_spread": None, "spread_ratio": None, "patchiness": None}
    if ms is None or es is None:
        return rec
    ratio, patch = classify(es, ms)
    rec.update(moon_spread=round(ms, nd + 1), earth_spread=round(es, nd + 1),
               spread_ratio=round(ratio, 3) if ratio is not None else None, patchiness=patch)
    return rec


def summary_for(metric: str, rec: dict) -> dict | None:
    if rec.get("patchiness") is None:
        return None
    return {"metric": metric, "label": LABELS.get(metric, metric), "patchiness": rec["patchiness"],
            "spread_ratio": rec["spread_ratio"], "earth_spread": rec["earth_spread"], "moon_spread": rec["moon_spread"],
            "text": sentence(metric, rec["patchiness"], rec["spread_ratio"], rec["earth_spread"], rec["moon_spread"])}


# ------------------------------------------------------------------ inputs + cache
def _moon_inputs(reg: dict) -> tuple[np.ndarray | None, np.ndarray | None, tuple[np.ndarray, np.ndarray]]:
    from pipeline.match.common import read_tile
    from pipeline.metrics import sun_path_moon
    dem = read_tile(reg["tile"]["path"])
    hp = MOON_INTERIM / f"{reg['id']}_horizon30.npy"
    h = decimate_horizon(np.load(hp).astype(np.float32)) if hp.exists() else None
    return dem, h, sun_path_moon(float(reg["lat"]), 2048, lon_deg=float(reg["lon"]))


def _earth_horizon_path(sid: str):
    return EARTH_INTERIM / "sites" / f"{sid}_horizon_d5.npz"


def _earth_inputs(site: dict) -> tuple[np.ndarray | None, np.ndarray | None, tuple[np.ndarray, np.ndarray]]:
    from pipeline.earth.sun import low_sun_series
    from pipeline.match.common import read_tile
    dem = read_tile(site["tile"]["path"]) if site.get("tile", {}).get("path") else None
    hp = _earth_horizon_path(site["id"])
    h, north = None, 0.0
    if hp.exists():
        z = np.load(hp)
        if int(z["step_px"]) == DECIM:
            h, north = z["h_cdeg"], float(z["true_north_grid_az"])
        else:
            log.warning("%s: horizon stride %s != %d; horizon metrics skipped", site["id"], z["step_px"], DECIM)
    el, az, _ = low_sun_series(float(site["lat"]), float(site["lon"]))
    return dem, h, (el, np.mod(az + north, 360.0))


def load_blocks(regions: list[dict], sites: list[dict], force: bool = False) -> tuple[dict, dict]:
    """({region_id: blocks}, {site_id: blocks}); blocks = {metric: 25 floats | None} or None if no tile."""
    cache = {} if force or not CACHE.exists() else read_json(CACHE)
    if cache.get("version") != VERSION:
        cache = {}
    moon_c, earth_c = cache.get("moon", {}), cache.get("earth", {})
    changed = False
    for reg in regions:
        sig = file_sig(WEB_DATA / reg["tile"]["path"], MOON_INTERIM / f"{reg['id']}_horizon30.npy")
        if moon_c.get(reg["id"], {}).get("sig") != sig:
            dem, h, sun = _moon_inputs(reg)
            moon_c[reg["id"]] = {"sig": sig, "blocks": block_stats(dem, h, sun) if dem is not None else None}
            changed = True
    n_new = 0
    for s in sites:
        tpath = s.get("tile", {}).get("path")
        sig = f"{file_sig(WEB_DATA / tpath, _earth_horizon_path(s['id'])) if tpath else 'notile'}|{s['lat']:.5f},{s['lon']:.5f}"
        if earth_c.get(s["id"], {}).get("sig") != sig:
            dem, h, sun = _earth_inputs(s)
            ok = dem is not None and np.isnan(dem).mean() <= 0.5
            earth_c[s["id"]] = {"sig": sig, "blocks": block_stats(dem, h, sun) if ok else None}
            changed, n_new = True, n_new + 1
    if changed:
        write_json(CACHE, {"version": VERSION, "moon": moon_c, "earth": earth_c}, indent=None)
    log.info("patchiness blocks: %d regions, %d sites (%d computed)", len(regions), len(sites), n_new)
    return {k: v["blocks"] for k, v in moon_c.items()}, {k: v["blocks"] for k, v in earth_c.items()}


# ------------------------------------------------------------------ wiring
def attach(matches: list[dict], regions: list[dict], sites: list[dict], force: bool = False) -> dict:
    """Add patchiness fields to every light of every match and a per-match ``patchiness_summary``."""
    by_id = {s["id"]: s for s in sites}
    need = [by_id[sid] for sid in dict.fromkeys(m["site_id"] for m in matches)]
    moon_b, earth_b = load_blocks(regions, need, force=force)
    for m in matches:
        mb, eb = moon_b.get(m["region_id"]) or {}, earth_b.get(m["site_id"]) or {}
        for li in m["lights"]:
            li.update(compare(li["metric"], mb.get(li["metric"]), eb.get(li["metric"])))
        head = HEADLINE_METRIC[m["hazard"]]
        hl = next((li for li in m["lights"] if li["metric"] == head), None)
        m["patchiness_summary"] = summary_for(head, hl) if hl is not None else None
    return top1_counts(matches)


def top1_counts(matches: list[dict]) -> dict:
    """summary.json block: how many #1 matches have similar patchiness on their headline metric."""
    top = [m for m in matches if m["rank"] == 1]
    classes = [(m.get("patchiness_summary") or {}).get("patchiness") for m in top]
    by_class = {c: sum(1 for x in classes if x == c) for c in ("similar", "smoother", "patchier")}
    by_class["unavailable"] = sum(1 for x in classes if x is None)
    by_hazard = {h: {"n": sum(1 for m in top if m["hazard"] == h),
                     "similar": sum(1 for m in top if m["hazard"] == h
                                    and (m.get("patchiness_summary") or {}).get("patchiness") == "similar")}
                 for h in HAZARDS}
    return {"n_top1": len(top), "n_similar_headline": by_class["similar"], "by_class": by_class,
            "by_hazard": by_hazard, "headline_metric": HEADLINE_METRIC,
            "thresholds": {"similar_min_ratio": SIMILAR_LO, "similar_max_ratio": SIMILAR_HI,
                           "note": "illustrative thresholds, not calibrated"},
            "method": METHOD_NOTE}
