"""Horizons, hazard metrics, shadow-mask PNGs and web/public/data/regions.json."""
from __future__ import annotations

import datetime as dt
import logging
import math
import time

import numpy as np

from pipeline.common.config import CORE_SIZE_PX, GRID_RES_M, MOON_R_M, REGION_IDS, WEB_DATA
from pipeline.moon.common import (
    CRS_SHORT, INTERIM_MOON, NASA_MAP_URL, PIPELINE_VERSION, WEB_MOON, write_json,
)
from pipeline.moon.regions import RegionCoord, build_regions
from pipeline.moon.windows import FAR_RADIUS_M, buffered_30m, core_grid, err_stats, far_path, load_npz, write_png

log = logging.getLogger(__name__)

N_AZ = 72
MASK_ELS = (1, 3, 5)
MASK_AZS = (0, 90, 180, 270)
DEC_MAX = 1.54
REGIONS_JSON = WEB_DATA / "regions.json"

SOURCES = [
    {"name": "LOLA 20 m/px south-pole DEM (PGDA product 90), LDEM_80S_20MPP_ADJ + _ERR; LDEM_60S_240MPP_ADJ far field",
     "url": "https://pgda.gsfc.nasa.gov/products/90",
     "licence": "NASA data, public domain (US Government work); cite data paper",
     "citation": "Barker, M.K. et al. (2023) A New View of the Lunar South Pole from the Lunar Orbiter Laser Altimeter (LOLA). PSJ 4:183, doi:10.3847/PSJ/acf3e1"},
    {"name": "High-resolution LOLA topography for lunar south pole sites (PGDA product 78): site tile extents used for region centres",
     "url": "https://pgda.gsfc.nasa.gov/products/78",
     "licence": "NASA data, public domain (US Government work); cite data paper",
     "citation": "Barker, M.K. et al. (2021) Improved LOLA elevation maps for south pole landing sites: error estimates and their impact on illumination conditions. PSS 203:105119, doi:10.1016/j.pss.2020.105119"},
    {"name": "Lunar polar illumination, AVGVISIB_85S_060M_201608 (PGDA product 69), validation only",
     "url": "https://pgda.gsfc.nasa.gov/products/69",
     "licence": "NASA data, public domain (US Government work); cite data paper",
     "citation": "Mazarico, E. et al. (2011) Illumination conditions of the lunar polar regions using LOLA topography. Icarus 211:1066-1081, doi:10.1016/j.icarus.2010.10.030"},
    {"name": "NASA Artemis III candidate landing regions map (Oct 28 2024), traced region boxes",
     "url": NASA_MAP_URL,
     "licence": "NASA media, not copyrighted (NASA/GSFC/ASU/JSC/AGDT credit)",
     "citation": "NASA (2024) NASA Provides Update on Artemis III Moon Landing Regions, https://www.nasa.gov/news-release/nasa-provides-update-on-artemis-iii-moon-landing-regions/"},
    {"name": "IAU/USGS Gazetteer of Planetary Nomenclature (feature centres, sanity checks)",
     "url": "https://planetarynames.wr.usgs.gov/",
     "licence": "USGS, public domain",
     "citation": "Gazetteer of Planetary Nomenclature, IAU WGPSN / USGS Astrogeology Science Center"},
]


def horizon_path(rid: str):
    return INTERIM_MOON / f"{rid}_horizon30.npy"


def sun_range(lat: float) -> tuple[float, float]:
    colat = 90.0 - abs(lat)
    return colat - DEC_MAX, colat + DEC_MAX


def sun_series_grid(r: RegionCoord, n: int = 11520) -> tuple[np.ndarray, np.ndarray]:
    """Long-term sun directions with azimuth converted from geographic to GRID north.

    In south polar stereographic (lon_0 = 0) local geographic north at longitude lon points
    radially away from the pole, i.e. grid azimuth = geographic azimuth + lon. This matters per
    pixel: the sun is ~2*(90-|lat|) deg higher toward geographic north than toward the pole.
    """
    from pipeline.metrics import sun_path_moon

    # sinusoidal declination (true time distribution), 11 520 directions: same model as the
    # lead's buffer study that was validated against PGDA AVGVISIB
    el, az = sun_path_moon(r.lat, n, n_dec=32, dec_dist="sinusoidal")
    return el, (az + r.lon) % 360.0


def region_horizon(rid: str, force: bool = False) -> np.ndarray:
    """(72, 500, 500) float32 horizon (deg) for the core at 30 m; near 30 m buffer + 240 m far field."""
    p = horizon_path(rid)
    if p.exists() and not force:
        return np.load(p, mmap_mode="r")
    from pipeline.metrics import horizon_map

    d30, g, sl = buffered_30m(rid)
    far, fg, _ = load_npz(far_path(rid))
    t0 = time.time()
    hz = horizon_map(d30, GRID_RES_M, sl, dem_far=far, res_far=fg.res, near_origin_xy=(g.x0, g.y0),
                     far_origin_xy=(fg.x0, fg.y0), n_az=N_AZ, max_radius_m=FAR_RADIUS_M,
                     planet_radius_m=MOON_R_M).astype(np.float32)
    log.info("%s horizon %s in %.1f s", rid, hz.shape, time.time() - t0)
    np.save(p, hz)
    return hz


def _clean(v):
    if isinstance(v, dict):
        return {k: _clean(x) for k, x in v.items()}
    if isinstance(v, (float, np.floating)):
        f = float(v)
        return None if not math.isfinite(f) else round(f, 6)
    return v


def region_metrics(r: RegionCoord, force: bool = False) -> dict:
    cache = INTERIM_MOON / f"{r.id}_metrics.json"
    if cache.exists() and not force:
        import json
        return json.loads(cache.read_text())
    from pipeline.metrics import compute_all, shadow_mask

    hz = np.asarray(region_horizon(r.id, force))
    d30, _, sl = buffered_30m(r.id)
    core = d30[sl]
    t0 = time.time()
    el_s, az_s = sun_series_grid(r)
    m = compute_all(core, hz, GRID_RES_M, el_series=el_s, az_series=az_s, extras=True)
    log.info("%s metrics in %.1f s", r.id, time.time() - t0)
    masks = []
    valid = np.isfinite(hz[0])
    for el in MASK_ELS:
        for az in MASK_AZS:
            name = f"{r.id}_sh_el{el}_az{az:03d}.png"
            sm = shadow_mask(hz, float(el), float(az))
            img = np.where(sm, 255, 0).astype(np.uint8)
            img[~valid] = 128
            write_png(WEB_MOON / name, img)
            masks.append({"el": float(el), "az": az, "path": f"moon/{name}", "frac": round(float(sm[valid].mean()), 4)})
    out = {"metrics": _clean(m), "shadow_masks": masks}
    write_json(cache, out)
    return out


def _minmax(vals: list[float]) -> list[float]:
    a = np.array([np.nan if v is None else v for v in vals], dtype=float)
    lo, hi = np.nanmin(a), np.nanmax(a)
    if not math.isfinite(lo) or hi - lo < 1e-12:
        return [0.0 if math.isfinite(x) else float("nan") for x in a]
    return list((a - lo) / (hi - lo))


# metric -> +1 if larger = more hazardous, -1 if larger = safer
SCORE_TERMS = {
    "shadow": {"shadow_frac_el1": 1, "shadow_frac_el3": 1, "shadow_frac_el5": 1, "shadow_frac_timeweighted": 1},
    "rim": {"jump1km_p95_m": 1, "jump1km_p99_m": 1, "frac_track_over_500m": 1},
    "texture": {"fast_per_km2_el3": -1, "empty_cell_frac_el3": 1},
}


def hazard_scores(all_metrics: dict[str, dict]) -> dict[str, dict[str, tuple[float, str]]]:
    """Per hazard: mean of oriented min-max-normalised metrics, re-normalised to 0..1; level by tercile."""
    ids = list(all_metrics)
    out: dict[str, dict[str, tuple[float, str]]] = {rid: {} for rid in ids}
    for hz, terms in SCORE_TERMS.items():
        parts = []
        for key, sign in terms.items():
            n = np.array(_minmax([all_metrics[rid].get(key) for rid in ids]))
            parts.append(n if sign > 0 else 1 - n)
        combo = np.nanmean(np.vstack(parts), axis=0)
        score = np.array(_minmax(list(combo)))
        order = np.argsort(np.argsort(score, kind="stable"), kind="stable")  # 0..8
        n = len(ids)
        for i, rid in enumerate(ids):
            lvl = "low" if order[i] < n / 3 else ("med" if order[i] < 2 * n / 3 else "high")
            out[rid][hz] = (round(float(score[i]), 4), lvl)
    return out


def _illumination(r: RegionCoord, m: dict) -> dict:
    """Long-term average illumination: PGDA AVGVISIB is authoritative; ours kept for reference."""
    from pipeline.moon.validate_pgda import pgda_core_visibility

    p = pgda_core_visibility(r)
    ours = m.get("shadow_frac_timeweighted_all")
    return {"pgda_avg_visibility": p["pgda_avg_visibility"], "pgda_res_m": p["res_m"], "pgda_url": p["url"],
            "ours_avg_visibility": None if ours is None else round(1.0 - ours, 4),
            "note": ("Use pgda_avg_visibility for long-term average illumination (Mazarico et al. 2011). Ours "
                     "(point-sun, approximate sun path) runs ~2-3 pts darker; our shadow fractions at fixed "
                     "elevations and the masks use the same method on both worlds.")}


def build_regions_json(force: bool = False) -> dict:
    regions = build_regions()
    per = {r.id: region_metrics(r, force) for r in regions}
    flat = {rid: v["metrics"] for rid, v in per.items()}
    scores = hazard_scores(flat)
    items = []
    for r in regions:
        m = flat[r.id]
        cg = core_grid(r)
        el_min, el_max = sun_range(r.lat)
        err = err_stats(r.id)
        hazards = {}
        for hz in ("shadow", "rim", "texture"):
            s, lvl = scores[r.id][hz]
            hazards[hz] = {"score": s, "level": lvl, "metrics": {k: m.get(k) for k in SCORE_TERMS[hz]}}
        hazards["slope"] = {"metrics": {"slope_p50_deg": m.get("slope_p50_deg"), "slope_p90_deg": m.get("slope_p90_deg"),
                                        "rms_dev_m": m.get("rms_dev_m")}}
        items.append({
            "id": r.id, "name": r.name, "lat": r.lat, "lon": r.lon, "x_m": r.x_m, "y_m": r.y_m,
            "coord_quality": r.coord_quality, "coord_source": r.coord_source, "coord_method": r.method,
            "sun": {"el_min": round(el_min, 3), "el_max": round(el_max, 3),
                    "note": "geometric, from latitude ± 1.54° declination"},
            "tile": {"path": f"moon/{r.id}.bin", "size": CORE_SIZE_PX, "res_m": GRID_RES_M, "crs": CRS_SHORT,
                     "origin_x": cg.x0, "origin_y": cg.y0},
            "illumination": _illumination(r, m),
            "hillshade": f"moon/{r.id}_hill.png",
            "shadow_masks": [{"el": s["el"], "az": s["az"], "path": s["path"]} for s in per[r.id]["shadow_masks"]],
            "shadow_mask_note": "PNG 255 = cast shadow, 0 = lit, 128 = no data; az clockwise from grid +y (tile up)",
            "hazards": hazards,
            "extras": {k: m.get(k) for k in ("hurst", "jump100m_p95_m", "jump100m_p99_m", "shadow_frac_el7",
                                             "shadow_frac_timeweighted_all")},
            "uncertainty": {
                "dem_err_p50_m": round(err["dem_err_p50_m"], 3), "dem_err_p90_m": round(err["dem_err_p90_m"], 3),
                "notes": ("LOLA LDEM_80S_20MPP_ADJ_ERR over the 15 km core at 20 m. Region centre "
                          + ("from PGDA-78 site tile (±0.2 km vs NASA box)." if r.coord_quality == "pgda_site_tile"
                             else "approximate, traced from NASA map (±~0.5 km).")
                          + " Horizon: 72 az, 30 m near field (15 km buffer) + 240 m far field to 150 km, curvature on."),
            },
        })
    doc = {
        "meta": {"generated_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                 "pipeline_version": PIPELINE_VERSION, "sources": SOURCES,
                 "score_method": ("score = min-max over the 9 regions of the mean of oriented, min-max-normalised "
                                  "metrics (texture: low FAST density = high hazard); level = tercile of score")},
        "regions": items,
    }
    assert [i["id"] for i in items] == list(REGION_IDS)
    write_json(REGIONS_JSON, doc)
    log.info("wrote %s", REGIONS_JSON)
    return doc


def metrics_ready() -> bool:
    try:
        from pipeline.metrics import compute_all, horizon_map  # noqa: F401
        return True
    except ImportError:
        return False
