"""Stage 2: 30 m metrics with far field for a site list, and earth_sites.json assembly.

Horizon: GLO-30 near field (15 km buffer) + GLO-90 far field average-resampled to 180 m out to
150 km (max_radius_m=150 km), curvature with R_eff = config.EARTH_R_EFF_M. Fixed sun elevations
{1,3,5} deg over 72 azimuths (identical definition to the Moon). shadow_frac_timeweighted uses the
site's real low-sun geometry: apparent sun elevations in (0, 7] deg over a year (10 min steps),
azimuths rotated into the UTM grid frame.
"""
from __future__ import annotations

import json
import logging
import math
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from pyproj import Transformer

from pipeline.common.config import EARTH_R_EFF_M
from pipeline.earth import windows as W
from pipeline.earth.common import HLS_TEMPLATE, WEB_EARTH, meta
from pipeline.earth.dem import fill_nan
from pipeline.earth.rock import lookup as rock_lookup
from pipeline.earth.sun import UNCERTAIN_BELOW_DEG, low_sun_series

log = logging.getLogger("pipeline.earth.compute")

FAR_RES_M = 180.0      # beyond the 15 km GLO-30 buffer; identical results to 90 m in tests, 2x faster
EARTH_SITES_JSON = WEB_EARTH.parent / "earth_sites.json"


def true_north_grid_az(lat: float, lon: float, epsg: int) -> float:
    """Grid azimuth (deg, clockwise from grid +y) of true north at (lat, lon)."""
    tr = Transformer.from_crs("EPSG:4326", f"EPSG:{epsg}", always_xy=True)
    x0, y0 = tr.transform(lon, lat)
    x1, y1 = tr.transform(lon, lat + 0.01)
    return math.degrees(math.atan2(x1 - x0, y1 - y0))


def search_radius_m(dh_m: float, el_deg: float = 0.5, r_min: float = 30e3, r_max: float = W.FAR_RADIUS_M) -> float:
    """Distance beyond which terrain dh_m higher cannot rise above el_deg with curvature R_eff:
    R*(-tan e + sqrt(tan^2 e + 2 dh / R)), +10 %, clipped to [30, 150] km (lead's rule of thumb)."""
    R = EARTH_R_EFF_M
    te = math.tan(math.radians(el_deg))
    d = R * (-te + math.sqrt(te * te + 2.0 * max(dh_m, 50.0) / R))
    return float(min(max(1.1 * d, r_min), r_max))


def metrics_path(site_id: str):
    return W.SITE_DIR / f"{site_id}_metrics.json"


def compute_site(site_id: str, force: bool = False) -> dict:
    """Horizon + compute_all for one processed site. Not thread-safe (numba parallel inside)."""
    from pipeline.metrics import compute_all, horizon_map
    mp = metrics_path(site_id)
    if mp.exists() and not force:
        return json.loads(mp.read_text())
    info = json.loads(W.info_path(site_id).read_text())
    near, g = W.load_near(site_id)
    if np.isnan(near[W.CORE_SLICE]).mean() > 0.5:
        out = {"id": site_id, "status": "nodata", "core_nan_frac": float(np.isnan(near[W.CORE_SLICE]).mean())}
        mp.write_text(json.dumps(out))
        return out
    t0 = time.time()
    fg = g.with_res(FAR_RES_M, int(2 * W.FAR_RADIUS_M / FAR_RES_M) + 2)
    from rasterio.enums import Resampling
    from pipeline.earth.dem import read_dem
    far = read_dem(fg, source=90, resampling=Resampling.average)
    far[np.isnan(far)] = 0.0
    near_f = fill_nan(near)
    radius = search_radius_m(float(np.nanmax(far)) - float(np.nanmin(near[W.CORE_SLICE])))
    H = horizon_map(near_f, W.RES, W.CORE_SLICE, dem_far=far, res_far=FAR_RES_M, near_origin_xy=g.origin,
                    far_origin_xy=fg.origin, n_az=72, max_radius_m=radius,
                    planet_radius_m=EARTH_R_EFF_M)
    t_hz = time.time() - t0
    lat, lon = info["lat"], info["lon"]
    north = true_north_grid_az(lat, lon, g.epsg)
    el_s, az_s, _ = low_sun_series(lat, lon)
    az_grid = np.mod(az_s + north, 360.0)
    core = near_f[W.CORE_SLICE]
    m = compute_all(core, H, W.RES, el_series=el_s, az_series=az_grid, extras=True)
    # decimated horizon (every 5th px, centi-degrees) for downstream sun-window searches
    np.savez_compressed(W.SITE_DIR / f"{site_id}_horizon_d5.npz",
                        h_cdeg=np.round(H[:, ::5, ::5] * 100).astype(np.int16), step_px=5,
                        n_az=72, origin_x=info["origin_x"], origin_y=info["origin_y"], res=W.RES,
                        true_north_grid_az=north)
    out = {"id": site_id, "status": "ok", "metrics": m, "true_north_grid_az_deg": round(north, 3),
           "low_sun_samples": int(el_s.size),
           "low_sun_note": (f"apparent sun el in (0,7] deg over 2026 at 10-min steps; values < "
                            f"{UNCERTAIN_BELOW_DEG} deg are refraction-uncertain"),
           "horizon_s": round(t_hz, 1), "far_res_m": FAR_RES_M, "search_radius_m": round(radius)}
    mp.write_text(json.dumps(out, indent=1, default=float))
    log.info("metrics %s: horizon %.1f s, shadow_el3 %.3f, jump p95 %.0f m", site_id, t_hz,
             m["shadow_frac_el3"], m["jump1km_p95_m"])
    return out


def run_sites(sites: list[dict], io_workers: int = 6, force: bool = False) -> dict[str, dict]:
    """sites: [{id, lat, lon, ...}] -> {id: {window, metrics, rock}}. I/O threaded, compute serial."""
    t0 = time.time()
    results: dict[str, dict] = {}

    def io(s: dict) -> tuple[str, dict | None, dict]:
        try:
            info = W.process_site(s["id"], float(s["lat"]), float(s["lon"]), force=force)
        except Exception as exc:  # noqa: BLE001
            log.warning("window failed %s: %s", s["id"], exc)
            info = None
        rk = rock_lookup(float(s["lat"]), float(s["lon"]))
        return s["id"], info, rk

    with ThreadPoolExecutor(io_workers) as ex:
        futs = [ex.submit(io, s) for s in sites]
        for i, f in enumerate(futs):   # consume in order; compute serially while I/O continues
            sid, info, rk = f.result()
            if info is None:
                results[sid] = {"window": None, "metrics": None, "rock": rk}
                continue
            try:
                mt = compute_site(sid, force=force)
            except Exception as exc:  # noqa: BLE001
                log.warning("metrics failed %s: %s", sid, exc)
                mt = {"status": "error"}
            results[sid] = {"window": info, "metrics": mt, "rock": rk}
            if (i + 1) % 10 == 0:
                log.info("stage 2: %d/%d sites (%.0f s)", i + 1, len(sites), time.time() - t0)
    log.info("stage 2 done: %d sites in %.0f s", len(results), time.time() - t0)
    return results


def _clean(v):
    if isinstance(v, dict):
        return {k: _clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_clean(x) for x in v]
    if isinstance(v, (np.floating, float)):
        f = float(v)
        return None if not math.isfinite(f) else round(f, 5)
    if isinstance(v, np.integer):
        return int(v)
    return v


def _shape30(site_id: str) -> dict | None:
    """Terrain-shape context at 30 m (pipeline.metrics.shape; NOT used in ranking). Cached per site."""
    p = W.SITE_DIR / f"{site_id}_shape30.json"
    if p.exists():
        return json.loads(p.read_text())
    try:
        from pipeline.earth.extras import shape_from_core
        near, _ = W.load_near(site_id)
        sh = shape_from_core(fill_nan(near)[W.CORE_SLICE], W.RES)["s"]
        out = {**{k: (None if v is None or not math.isfinite(v) else round(v, 4)) for k, v in sh.items()},
               "note": "context only (30 m); shape rim term excluded from ranking after validation check"}
    except Exception as exc:  # noqa: BLE001
        log.warning("shape30 failed %s: %s", site_id, exc)
        out = None
    p.write_text(json.dumps(out))
    return out


def write_earth_sites(sites: list[dict], results: dict[str, dict], extra_meta: dict | None = None) -> dict:
    """Assemble web/public/data/earth_sites.json per docs/data-contract.md."""
    from pipeline.metrics import group_by_hazard
    out_sites = []
    for s in sites:
        r = results.get(s["id"]) or {}
        win, mt, rk = r.get("window"), r.get("metrics") or {}, r.get("rock") or {}
        if not win or mt.get("status") != "ok":
            continue
        m = mt["metrics"]
        role = s.get("role", "candidate")
        wc = win["worldcover"]
        lowveg = wc.get("shrub", 0) + wc.get("grass", 0)
        dsm_safe = W.dsm_safe_shares(wc)
        veg_note = (f"low vegetation present ({lowveg:.0%} shrub/grass: {wc.get('shrub', 0):.0%} shrub, "
                    f"{wc.get('grass', 0):.0%} grass)") if lowveg >= 0.10 else None
        cites = []
        if s.get("coord_source_url"):
            cites.append({"claim": "coordinate locator (Wikipedia; locator only)", "url": s["coord_source_url"]})
        if s.get("source_url"):
            cites.append({"claim": f"documented analog use ({', '.join(s.get('agencies') or [])}): "
                                   f"{(s.get('source_title') or '')[:160]}", "url": s["source_url"]})
        if s.get("known_analog_text"):
            cites.append({"claim": f"analog status (unverified text from candidate list): {s['known_analog_text'][:200]}",
                          "url": s.get("coord_source_url")})
        out_sites.append({
            "id": s["id"], "name": s.get("name") or f"Screen window {s['id']}", "country": s.get("country", ""),
            "lat": s["lat"], "lon": s["lon"],
            "category": s.get("category") or "global_screen",
            "known_analog": role == "heldout_positive", "role": role,
            "selected_by": s.get("selected_by", "validation"), "stage1_rank": s.get("stage1_rank"),
            "stage1_best": s.get("stage1_best"),
            "stratum": s.get("stratum"),
            "bare_frac": win["bare_frac"], "moss_frac": win.get("moss_frac"),
            "bare_ok": (win["bare_frac"] + (win.get("moss_frac") or 0)) >= 0.5,
            "dsm_safe": bool(dsm_safe), "low_vegetation_note": veg_note,
            "worldcover_note": win["worldcover_note"], "worldcover": win["worldcover"],
            "rock": {"lith": rk.get("lith"), "anorthosite": bool(rk.get("anorthosite")),
                     "plutonic": bool(rk.get("plutonic")), "source": rk.get("source", "none")},
            "tile": {"path": f"earth/{s['id']}.bin", "size": W.CORE_N, "res_m": W.RES, "crs": f"EPSG:{win['epsg']}",
                     "origin_x": win["origin_x"], "origin_y": win["origin_y"],
                     "origin_note": "top-left corner of pixel (0,0); row 0 = north (grid +y)",
                     "true_north_grid_az_deg": mt.get("true_north_grid_az_deg")},
            "hillshade": f"earth/{s['id']}_hill.png",
            "core_relief_m": win.get("core_relief_m"), "core_nan_frac": win.get("core_nan_frac"),
            "metrics": m,
            "hazards": group_by_hazard(m),
            "image_tile_url": HLS_TEMPLATE,
            "citations": cites,
            **({"lit_id": s.get("lit_id"), "agencies": s.get("agencies"), "uses": s.get("uses"),
                "source_url": s.get("source_url"), "source_title": s.get("source_title"),
                "verified": s.get("verified"), "split": s.get("split"), "dup_of": s.get("dup_of")}
               if s.get("selected_by") == "documented" else {}),
            **({"name_source": s.get("name_source")} if s.get("name_source") else {}),
            "shape": _shape30(s["id"]),
            **({"nasadem": (r.get("nasadem") or {"available": False})} if "nasadem" in r else {}),
        })
    md = meta()
    md["notes"] = {
        "dem": "Copernicus GLO-30 is a surface model (includes trees/buildings); use bare_frac to judge.",
        "horizon": "near GLO-30 15 km buffer + GLO-90 far field at 180 m to 150 km, R_eff = 7/6 * 6371 km",
        "shadow_fixed_el": "shadow_frac_el{1,3,5}: fraction of (pixel, 72 azimuths) below the horizon, same as Moon",
        "shadow_timeweighted": "Earth: apparent sun el in (0,7] deg over 2026; below 1 deg refraction-uncertain",
        "image_tile_url": "replace {date} with YYYY-MM-DD; GIBS HLS S30 goes to zoom 12 (~30 m)",
        "stage1": "stage1_rank = best rank across the 27 region x hazard stage-1 searches (90 m, local shadow proxy)",
    }
    if extra_meta:
        md.update(extra_meta)
    doc = _clean({"meta": md, "sites": out_sites})
    EARTH_SITES_JSON.write_text(json.dumps(doc, separators=(",", ":")))
    log.info("wrote %s: %d sites (%.1f MB)", EARTH_SITES_JSON, len(out_sites), EARTH_SITES_JSON.stat().st_size / 1e6)
    return doc
