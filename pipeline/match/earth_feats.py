"""Extra Earth features computed by the match stage from the published 30 m tiles.

- 30 m terrain shape (pipeline.metrics.shape) on web/public/data/earth/<id>.bin, so every site
  (screen, documented, validation) gets the same features as the Moon 30 m block of
  fingerprints_extra.json (30 m vs 30 m only).
- site elevation (median of the central 3 km) for the refraction atmosphere.
- brightness rank: taken from the site record if the Earth stage provides it, else computed with
  pipeline.metrics.brightness (MODIS pseudo-1064 nm) without touching its caches, ranked against the
  screened Earth windows if available, else the global snow-free reference.

Cached per site in data/interim/match/earth_feats.json, keyed on the tile file signature.
"""
from __future__ import annotations

import json
import logging
import math

import numpy as np

from pipeline.match.common import EARTH_INTERIM, INTERIM, file_sig, read_json, read_tile, write_json
from pipeline.common.config import WEB_DATA

log = logging.getLogger("pipeline.match.earth_feats")

CACHE = INTERIM / "earth_feats.json"
RES_M = 30.0
SHAPE_SCALARS = ("shape_aspect_R", "shape_aspect_R2", "shape_aspect_mean_dir_deg", "shape_depr_per_100km2",
                 "shape_depr_area_frac", "shape_hypso_integral")


def _fill_nan(z: np.ndarray) -> np.ndarray:
    if not np.isnan(z).any():
        return z
    from scipy import ndimage
    idx = ndimage.distance_transform_edt(np.isnan(z), return_distances=False, return_indices=True)
    return z[tuple(idx)]


def shape30(dem: np.ndarray) -> dict:
    from pipeline.metrics.shape import SHAPE_HAZARD_KEYS, shape_features
    f = shape_features(_fill_nan(dem), RES_M)
    qk = SHAPE_HAZARD_KEYS["rim"]["quantiles_101"]
    return {"scalars": {k: (float(f["scalars"][k]) if f["scalars"].get(k) is not None else None) for k in SHAPE_SCALARS},
            "quantiles_101": {k: [round(float(x), 5) for x in (f["quantiles_101"].get(k) or [])] for k in qk}}


def site_bright_rank(site: dict) -> float | None:
    for src in (site.get("metrics", {}), site.get("brightness", {}), site.get("brightness", {}).get("scalars", {})
                if isinstance(site.get("brightness"), dict) else {}, site.get("extras", {}) or {}):
        v = src.get("bright_rank") if isinstance(src, dict) else None
        if v is not None and math.isfinite(float(v)):
            return float(v)
    return None


def _bright_reference() -> tuple[np.ndarray | list[float], str]:
    """Screened Earth window means (preferred, Earth-stage cache) or the global snow-free reference."""
    p = EARTH_INTERIM / "screen_brightness.json"
    if p.exists():
        vals = np.array([v for v in json.loads(p.read_text()).values() if v is not None], float)
        if vals.size > 100:
            return vals, f"screened Earth windows (n={vals.size})"
    from pipeline.metrics.brightness import earth_reference
    return earth_reference(), "global snow-free land 15 km blocks (fallback reference)"


def compute_brightness(sites: list[dict]) -> tuple[dict[str, float], str]:
    """{site_id: bright_rank} for sites lacking it; ({}, reason) if brightness data are unavailable."""
    try:
        from pipeline.metrics.brightness import brightness_rank_feature, earth_brightness_batch
        ref, ref_note = _bright_reference()
        res = earth_brightness_batch([(float(s["lat"]), float(s["lon"])) for s in sites], use_cache=False)
    except Exception as exc:  # noqa: BLE001 - optional feature, never fatal
        log.warning("brightness unavailable (%s); brightness terms skipped", exc)
        return {}, f"unavailable: {exc}"
    out = {}
    for s, b in zip(sites, res):
        v = b.get("bright_mean")
        if v is not None and math.isfinite(v):
            out[s["id"]] = float(brightness_rank_feature(v, ref)["bright_rank"])
    return out, ref_note


def load(sites: list[dict], force: bool = False) -> dict[str, dict]:
    """{site_id: {"shape30", "elev_m", "bright_rank", "bright_source"}} for every site with a tile."""
    cache = {} if force or not CACHE.exists() else read_json(CACHE)
    feats = cache.get("sites", {})
    changed = False
    need_bright = []
    for s in sites:
        tpath = s.get("tile", {}).get("path")
        if not tpath:
            continue
        sig = file_sig(WEB_DATA / tpath)
        rec = feats.get(s["id"])
        if rec is None or rec.get("sig") != sig:
            dem = read_tile(tpath)
            if dem is None or np.isnan(dem).mean() > 0.5:
                feats[s["id"]] = {"sig": sig, "shape30": None, "elev_m": None}
            else:
                c = dem[200:300, 200:300]
                feats[s["id"]] = {"sig": sig, "shape30": shape30(dem),
                                  "elev_m": float(np.nanmedian(c)) if np.isfinite(c).any() else float(np.nanmedian(dem))}
            changed = True
        rec = feats[s["id"]]
        given = site_bright_rank(s)
        if given is not None:
            rec["bright_rank"], rec["bright_source"] = given, "earth_sites.json"
        elif rec.get("bright_rank") is None or rec.get("bright_key") != f"{s['lat']:.4f},{s['lon']:.4f}":
            need_bright.append(s)
    if need_bright:
        br, note = compute_brightness(need_bright)
        for s in need_bright:
            rec = feats[s["id"]]
            rec["bright_rank"] = br.get(s["id"])
            rec["bright_source"] = f"MODIS MCD43C3 pseudo-1064 nm, rank vs {note}" if s["id"] in br else None
            rec["bright_key"] = f"{s['lat']:.4f},{s['lon']:.4f}"
        changed = True
    if changed:
        write_json(CACHE, {"sites": feats}, indent=None)
    return feats
