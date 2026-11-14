"""Walk library: straight Earth transects for DTW matching against Moon routes.

For each stage-2 site that is DSM-safe at 10 m (tree <= .10, built <= .05, crop <= .20,
water <= .20, wetland+mangrove <= .10, snow < .30; lead decision, replaces bare_frac >= 0.5): start points on a regular grid inside the
30 m core, 16 directions, lengths 1/2/5 km, path fully inside the core and NaN-free. A seeded
random subset (cap per site, sized so the library stays < ~15 MB) is profiled with
pipeline.metrics.profile.sample_profile (bilinear heights, signed slope deg, 100 points).
Outputs web/public/data/walk/transects.bin (Float32 LE [N,100]) + transects.json.
"""
from __future__ import annotations

import json
import logging
import math

import numpy as np
from pyproj import Transformer

from pipeline.earth import windows as W
from pipeline.earth.common import WEB_WALK, meta

log = logging.getLogger("pipeline.earth.transects")

LENGTHS_M = (1000, 2000, 5000)
N_DIRS = 16
GRID_STEP_M = 1500.0
POINTS = 100
ROW_BUDGET = 22_000
MAX_PER_SITE = 200
SEED = 7


def _profile_fn():
    try:
        from pipeline.metrics.profile import sample_profile
        return sample_profile
    except Exception:  # noqa: BLE001
        return None


def _fallback_profile(dem, res_m, origin_xy, polyline_xy, n=POINTS):
    (xa, ya), (xb, yb) = polyline_xy
    x = np.linspace(xa, xb, n)
    y = np.linspace(ya, yb, n)
    col = (x - origin_xy[0]) / res_m - 0.5
    row = (origin_xy[1] - y) / res_m - 0.5
    i0 = np.clip(np.floor(row).astype(int), 0, dem.shape[0] - 2)
    j0 = np.clip(np.floor(col).astype(int), 0, dem.shape[1] - 2)
    p, q = row - i0, col - j0
    h = (dem[i0, j0] * (1 - p) * (1 - q) + dem[i0 + 1, j0] * p * (1 - q)
         + dem[i0, j0 + 1] * (1 - p) * q + dem[i0 + 1, j0 + 1] * p * q)
    s = np.hypot(x - xa, y - ya)
    slope = np.degrees(np.arctan(np.gradient(h, s)))
    return {"s_m": s, "x": x, "y": y, "h_m": h, "slope_deg": slope, "length_m": float(s[-1]),
            "climb_m": float(np.clip(np.diff(h), 0, None).sum()), "max_slope_deg": float(np.abs(slope).max())}


def site_transects(site_id: str, info: dict, cap: int, rng: np.random.Generator) -> list[dict]:
    near, g = W.load_near(site_id)
    core = near[W.CORE_SLICE].astype(np.float64)
    if np.isnan(core).mean() > 0.2:
        return []
    x0, y0 = info["origin_x"], info["origin_y"]
    size = W.CORE_N * W.RES
    starts = np.arange(GRID_STEP_M / 2, size, GRID_STEP_M)
    cands = []
    for sx in starts:
        for sy in starts:
            for k in range(N_DIRS):
                az = 2 * math.pi * k / N_DIRS
                for L in LENGTHS_M:
                    ex, ey = sx + L * math.sin(az), sy + L * math.cos(az)
                    if 30 <= ex <= size - 30 and 30 <= ey <= size - 30:
                        cands.append((x0 + sx, y0 - size + sy, x0 + ex, y0 - size + ey, L))
    if not cands:
        return []
    order = rng.permutation(len(cands))
    prof = _profile_fn() or _fallback_profile
    to_ll = Transformer.from_crs(f"EPSG:{info['epsg']}", "EPSG:4326", always_xy=True)
    out = []
    for idx in order:
        if len(out) >= cap:
            break
        xa, ya, xb, yb, L = cands[int(idx)]
        p = prof(core, W.RES, (x0, y0), [(xa, ya), (xb, yb)], n=POINTS)
        sl = np.asarray(p["slope_deg"], np.float32)
        if not np.all(np.isfinite(sl)):
            continue
        lon0, lat0 = to_ll.transform(xa, ya)
        lon1, lat1 = to_ll.transform(xb, yb)
        out.append({"site_id": site_id, "x0": round(xa, 1), "y0": round(ya, 1), "x1": round(xb, 1), "y1": round(yb, 1),
                    "lat0": round(lat0, 5), "lon0": round(lon0, 5), "lat1": round(lat1, 5), "lon1": round(lon1, 5),
                    "length_m": L, "climb_m": round(float(p["climb_m"]), 1),
                    "max_slope_deg": round(float(p["max_slope_deg"]), 2), "_slope": sl})
    return out


def build(site_ids: list[str], site_meta: dict[str, dict] | None = None) -> dict:
    infos = {}
    for sid in site_ids:
        ip = W.info_path(sid)
        if not ip.exists():
            continue
        info = json.loads(ip.read_text())
        if W.dsm_safe_shares(info.get("worldcover", {})) and (info.get("core_nan_frac") or 0) < 0.2:
            infos[sid] = info
    if not infos:
        log.warning("no eligible sites for transects")
        return {}
    cap = int(min(MAX_PER_SITE, ROW_BUDGET // len(infos)))
    rng = np.random.default_rng(SEED)
    items, prof = [], []
    for sid, info in infos.items():
        for it in site_transects(sid, info, cap, rng):
            prof.append(it.pop("_slope"))
            it["i"] = len(items)
            items.append(it)
    arr = np.stack(prof).astype("<f4") if prof else np.zeros((0, POINTS), "<f4")
    arr.tofile(WEB_WALK / "transects.bin")
    md = meta()
    md["notes"] = ("straight transects, 16 directions, 1/2/5 km, start grid 1.5 km inside the 15 km core; "
                   "slope signed along path, degrees, resampled to 100 points; x/y in the site's UTM CRS (tile.crs)")
    used = sorted({it["site_id"] for it in items})
    site_meta = site_meta or {}
    lookup = {}
    for sid in used:
        info = infos[sid]
        sm = site_meta.get(sid, {})
        lookup[sid] = {"name": sm.get("name") or sid, "country": sm.get("country", ""),
                       "lat": round(float(info["lat"]), 5), "lon": round(float(info["lon"]), 5),
                       "dsm_safe": bool(W.dsm_safe_shares(info.get("worldcover", {}))),
                       "bare_frac": round(float(info.get("bare_frac") or 0), 3),
                       "selected_by": sm.get("selected_by")}
    doc = {"meta": md, "n": int(arr.shape[0]), "points": POINTS, "sites": lookup, "items": items}
    (WEB_WALK / "transects.json").write_text(json.dumps(doc, separators=(",", ":")))
    sz = ((WEB_WALK / "transects.bin").stat().st_size + (WEB_WALK / "transects.json").stat().st_size) / 1e6
    log.info("transects: %d rows from %d sites (cap %d/site), %.1f MB total", arr.shape[0], len(infos), cap, sz)
    return {"n": int(arr.shape[0]), "sites": len(infos), "cap_per_site": cap, "mb": round(sz, 2)}
