"""Per-region 3D annotations: WHERE each danger is on the Moon tile ("Explore in 3D").

Writes ``web/public/data/moon/<region_id>_annotations.json`` and ``<region_id>_slope_classes.png``
for the 9 regions in ``web/public/data/regions.json``. Every number uses the same definitions as
the danger profile (``pipeline.metrics``), so labels agree with the ``hazards`` block:

* rim drops     -- the 16-direction, 1 km-baseline transect scan of ``rim.jump_samples``.
* texture cells -- ``texture.render_hillshade`` + FAST-9 (threshold 20, NMS) at a 3 deg sun,
  8 azimuths, cast shadows from the cached horizon, 1 km cells binned like ``fast_density``.
* slope         -- ``roughness.slope_deg`` (Horn).
* shadow        -- the precomputed mask PNGs listed in regions.json (cast shadow = 255).

Position convention (see docs/data-contract-annotations.md): ``px = [col, row]`` continuous,
origin at the top-left CORNER of pixel (0, 0), so the centre of pixel (c, r) is (c+0.5, r+0.5);
``xy = [x, y]`` projected metres: ``x = origin_x + col*res``, ``y = origin_y - row*res``.

CLI: ``python -m pipeline.moon.annotations [--force] [--region ID ...]``
"""
from __future__ import annotations

import argparse
import json
import logging
import math
import time
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from scipy import ndimage
from scipy.ndimage import map_coordinates

from pipeline.common.config import INTERIM, WEB_DATA
from pipeline.metrics.horizon import shadow_mask
from pipeline.metrics.rim import rim_jump_stats
from pipeline.metrics.roughness import slope_deg
from pipeline.metrics.texture import fast_density, render_hillshade

log = logging.getLogger(__name__)

WEB_MOON = WEB_DATA / "moon"
REGIONS_JSON = WEB_DATA / "regions.json"
INTERIM_MOON = INTERIM / "moon"

RIM_BASELINE_M = 1000.0
RIM_N_DIRS = 16
RIM_N_PICKS = 5
RIM_MIN_SEP_M = 1500.0
TEX_SUN_EL = 3.0
TEX_N_AZ = 8
TEX_FAST_THRESHOLD = 20
TEX_CELL_M = 1000.0
SLOPE_EDGES_DEG = (8.0, 15.0, 25.0)  # class 0 <8, 1 8-15, 2 15-25, 3 >=25
SLOPE_GRID = 125
SAFE_SLOPE_DEG = 8.0
SAFE_BUFFER_M = 100.0
MAX_JSON_BYTES = 150_000
EIGHT = np.ones((3, 3), dtype=bool)

SLOPE_THRESHOLDS_NOTE = (
    "Illustrative thresholds, not mission requirements: ~8-10 deg is the order of the landing-slope "
    "limit discussed for Artemis Human Landing System (HLS) vehicles; ~15 deg makes walking markedly "
    "harder; ~20-25 deg is the order of the EVA walking limit cited in Apollo-era and Artemis EVA "
    "studies. Slopes here are 30 m Horn slopes, which smooth out steeper metre-scale features.")
SAFE_RULE_NOTE = ("Illustrative HLS-style rule: slope < 8 deg AND at least 100 m from any pixel with "
                  "slope >= 8 deg (pixels beyond the tile edge are unknown and not counted as steep).")


@dataclass(frozen=True)
class TileGeom:
    """Tile georeference (corner convention)."""

    origin_x: float
    origin_y: float
    res_m: float
    size: int

    def xy(self, col: float, row: float) -> list[float]:
        return [round(self.origin_x + col * self.res_m, 1), round(self.origin_y - row * self.res_m, 1)]

    def pos(self, col: float, row: float) -> dict[str, list[float]]:
        """Position dict for a continuous corner-convention pixel coordinate."""
        return {"px": [round(float(col), 2), round(float(row), 2)], "xy": self.xy(col, row)}

    def centre_of(self, c: float, r: float) -> dict[str, list[float]]:
        """Position of the centre of pixel index (c, r) (indices may be fractional)."""
        return self.pos(c + 0.5, r + 0.5)

    def bbox(self, c0: float, r0: float, c1: float, r1: float) -> dict[str, list[float]]:
        """bbox in px [col0, row0, col1, row1] (corner coords) and xy [xmin, ymin, xmax, ymax]."""
        x0, y1 = self.xy(c0, r0)
        x1, y0 = self.xy(c1, r1)
        return {"px": [round(c0, 2), round(r0, 2), round(c1, 2), round(r1, 2)], "xy": [x0, y0, x1, y1]}


# ----------------------------------------------------------------------------- inputs
def load_regions() -> list[dict]:
    return json.loads(REGIONS_JSON.read_text())["regions"]


def load_tile_bin(region: dict) -> np.ndarray:
    t = region["tile"]
    n = int(t["size"])
    return np.fromfile(WEB_DATA / t["path"], dtype="<f4").reshape(n, n)


def load_dem(region: dict) -> tuple[np.ndarray, str]:
    """float64 DEM on the profile grid; the same array the metrics used when the near20 cache exists."""
    rid = region["id"]
    tile = load_tile_bin(region).astype(np.float64)
    if (INTERIM_MOON / f"{rid}_near20.npz").exists():
        from pipeline.moon.windows import buffered_30m

        d30, _, sl = buffered_30m(rid)
        core = np.asarray(d30[sl], dtype=np.float64)
        if core.shape == tile.shape:
            diff = float(np.nanmax(np.abs(core - tile)))
            if diff > 0.05:
                log.warning("%s: near20 core differs from web .bin by %.3f m", rid, diff)
            return core, "near20 cache (same array as the profile metrics)"
    log.warning("%s: near20 cache missing; using the float32 web tile", rid)
    return tile, "web tile .bin (float32)"


def load_horizon(rid: str) -> np.ndarray | None:
    p = INTERIM_MOON / f"{rid}_horizon30.npy"
    if not p.exists():
        log.warning("%s: no cached horizon; texture renders without cast shadows", rid)
        return None
    return np.asarray(np.load(p, mmap_mode="r"), dtype=np.float32)


# ----------------------------------------------------------------------------- rim
def _direction_offsets(k: int, n_dirs: int, lag_px: float) -> tuple[float, float, float]:
    """(dr, dc, azimuth deg clockwise from grid +y) exactly as ``rim.jump_samples``."""
    th = math.pi * k / n_dirs
    return -math.cos(th) * lag_px, math.sin(th) * lag_px, math.degrees(th)


def jump_grid(dem: np.ndarray, res_m: float, baseline_m: float = RIM_BASELINE_M,
              n_dirs: int = RIM_N_DIRS) -> np.ndarray:
    """(n_dirs, H, W) signed dh = h(p + L*u) - h(p); NaN where the partner leaves the tile.

    |values| (finite) are exactly the pooled samples of ``rim.jump_samples``.
    """
    z = np.asarray(dem, dtype=np.float64)
    n0, n1 = z.shape
    rows, cols = np.mgrid[0:n0, 0:n1].astype(np.float64)
    lag = baseline_m / res_m
    out = np.full((n_dirs, n0, n1), np.nan)
    for k in range(n_dirs):
        dr, dc, _ = _direction_offsets(k, n_dirs, lag)
        rr, cc = rows + dr, cols + dc
        ok = (rr >= 0) & (rr <= n0 - 1) & (cc >= 0) & (cc <= n1 - 1)
        h1 = map_coordinates(z, [rr[ok], cc[ok]], order=1, mode="nearest", prefilter=False)
        out[k][ok] = h1 - z[ok]
    return out


def pick_rim_drops(dem: np.ndarray, res_m: float, n_picks: int = RIM_N_PICKS,
                   min_sep_m: float = RIM_MIN_SEP_M) -> list[dict]:
    """Greedy top-|dh| 1 km segments whose midpoints are >= ``min_sep_m`` apart.

    Two 1 km segments with midpoints >= 1.5 km apart cannot overlap (gap >= 0.5 km).
    Each pick is oriented high -> low (start = higher end). Coordinates are pixel indices.
    """
    g = jump_grid(dem, res_m)
    n_dirs, n0, n1 = g.shape
    lag = RIM_BASELINE_M / res_m
    absg = np.where(np.isfinite(g), np.abs(g), -np.inf)
    rows, cols = np.mgrid[0:n0, 0:n1].astype(np.float64)
    mids = []
    for k in range(n_dirs):
        dr, dc, _ = _direction_offsets(k, n_dirs, lag)
        mids.append((rows + dr / 2.0, cols + dc / 2.0))
    sep_px = min_sep_m / res_m
    picks: list[dict] = []
    for _ in range(n_picks):
        flat = int(np.argmax(absg))
        if not np.isfinite(absg.flat[flat]):
            break
        k, r, c = np.unravel_index(flat, absg.shape)
        dr, dc, az = _direction_offsets(int(k), n_dirs, lag)
        dh = float(g[k, r, c])
        a = (float(c), float(r))
        b = (float(c) + dc, float(r) + dr)
        if dh > 0:  # orient high -> low
            a, b, az, dh = b, a, (az + 180.0) % 360.0, -dh
        picks.append({"start_idx": a, "end_idx": b, "dh_m": dh, "direction_deg": az})
        mr, mc = r + dr / 2.0, c + dc / 2.0
        for kk in range(n_dirs):
            near = (mids[kk][0] - mr) ** 2 + (mids[kk][1] - mc) ** 2 < sep_px ** 2
            absg[kk][near] = -np.inf
    return picks


def _compass(az: float) -> str:
    names = ("grid-north", "grid-northeast", "grid-east", "grid-southeast",
             "grid-south", "grid-southwest", "grid-west", "grid-northwest")
    return names[int(((az % 360.0) + 22.5) // 45.0) % 8]


def rim_block(dem: np.ndarray, geom: TileGeom, prof: dict) -> dict:
    stats = rim_jump_stats(dem, geom.res_m, RIM_BASELINE_M, RIM_N_DIRS, short_baseline_m=None)
    p95 = stats["jump1km_p95_m"]
    drops = []
    for i, p in enumerate(pick_rim_drops(dem, geom.res_m)):
        (c0, r0), (c1, r1) = p["start_idx"], p["end_idx"]
        adh = abs(p["dh_m"])
        mid = geom.centre_of((c0 + c1) / 2.0, (r0 + r1) / 2.0)
        drops.append({
            "rank": i + 1,
            "start": geom.centre_of(c0, r0),
            "end": geom.centre_of(c1, r1),
            "mid": mid,
            "dh_m": round(p["dh_m"], 1),
            "abs_dh_m": round(adh, 1),
            "direction_deg": round(p["direction_deg"], 2),
            "above_p95": bool(adh > p95),
            "label": f"{adh:.0f} m drop over 1 km",
        })
    return {
        "method": ("|h(p+L*u) - h(p)|, L = 1 km, 16 directions over 180 deg (bilinear partner), every "
                   "pixel; greedy top-|dh| picks with midpoints >= 1.5 km apart; start = high end"),
        "baseline_m": RIM_BASELINE_M,
        "n_dirs": RIM_N_DIRS,
        "min_separation_m": RIM_MIN_SEP_M,
        "p95_m": round(p95, 1),
        "p99_m": round(stats["jump1km_p99_m"], 1),
        "profile_p95_m": prof.get("jump1km_p95_m"),
        "profile_p99_m": prof.get("jump1km_p99_m"),
        "drops": drops,
    }


# ----------------------------------------------------------------------------- texture
def fast_cell_counts(hill: np.ndarray, res_m: float, threshold: int = TEX_FAST_THRESHOLD,
                     cell_m: float = TEX_CELL_M) -> np.ndarray:
    """(n_r, n_c) FAST-9 keypoint counts binned exactly like ``texture.fast_density``."""
    img = np.ascontiguousarray(hill, dtype=np.uint8)
    det = cv2.FastFeatureDetector_create(threshold=int(threshold), nonmaxSuppression=True)
    n_r = int(math.floor(img.shape[0] * res_m / cell_m + 1e-9))
    n_c = int(math.floor(img.shape[1] * res_m / cell_m + 1e-9))
    counts = np.zeros((n_r, n_c), dtype=np.int64)
    for kp in det.detect(img, None):
        ci, cj = int(kp.pt[1] * res_m // cell_m), int(kp.pt[0] * res_m // cell_m)
        if ci < n_r and cj < n_c:
            counts[ci, cj] += 1
    return counts


def texture_counts(dem: np.ndarray, horizon: np.ndarray | None, res_m: float) -> np.ndarray:
    """(n_az, n_r, n_c) counts for the 8 sun azimuths at 3 deg (as ``texture.texture_stats``)."""
    out = []
    for k in range(TEX_N_AZ):
        az = 360.0 * k / TEX_N_AZ
        sh = None if horizon is None else shadow_mask(horizon, TEX_SUN_EL, az)
        hill = render_hillshade(dem, res_m, TEX_SUN_EL, az, sh)
        counts = fast_cell_counts(hill, res_m)
        ref = fast_density(hill, res_m, TEX_FAST_THRESHOLD)["empty_cell_frac"]
        if abs(float((counts == 0).mean()) - ref) > 1e-12:
            raise AssertionError(f"cell binning differs from fast_density at az {az}")
        out.append(counts)
    return np.stack(out)


def texture_block(dem: np.ndarray, horizon: np.ndarray | None, geom: TileGeom, prof: dict,
                  n_rich: int = 4) -> dict:
    counts = texture_counts(dem, horizon, geom.res_m)
    empty_az = (counts == 0).mean(axis=0)  # per cell: fraction of the 8 renders with 0 keypoints
    mean_kp = counts.mean(axis=0)
    empty_frac = float(empty_az.mean())  # == mean over azimuths of empty_cell_frac == profile metric
    cpx = TEX_CELL_M / geom.res_m
    n_r, n_c = empty_az.shape

    def cell(i: int, j: int) -> dict:
        d = {"i": int(i), "j": int(j),
             "bbox": geom.bbox(j * cpx, i * cpx, (j + 1) * cpx, (i + 1) * cpx),
             "empty_az_frac": round(float(empty_az[i, j]), 3),
             "mean_keypoints": round(float(mean_kp[i, j]), 2)}
        return d

    empties = [cell(i, j) for i in range(n_r) for j in range(n_c) if empty_az[i, j] > 0]
    empties.sort(key=lambda d: (-d["empty_az_frac"], d["i"], d["j"]))
    order = np.argsort(-mean_kp, axis=None, kind="stable")
    rich = [cell(*np.unravel_index(int(f), mean_kp.shape)) for f in order[:n_rich]]
    always = int((empty_az == 1.0).sum())
    return {
        "method": ("FAST-9 (threshold 20, NMS) on render_hillshade with cast shadows, sun el 3 deg, "
                   "8 azimuths 0..315; 1 km cells from the top-left corner, keypoint pixel index binned "
                   "as fast_density. empty_az_frac = share of the 8 renders in which the cell has 0 "
                   "keypoints; empty_frac = mean of empty_az_frac over all cells (= profile metric)"),
        "sun_el_deg": TEX_SUN_EL,
        "n_az": TEX_N_AZ,
        "grid": [n_r, n_c],
        "cell_m": TEX_CELL_M,
        "empty_frac": round(empty_frac, 6),
        "profile_empty_frac": prof.get("empty_cell_frac_el3"),
        "n_cells_always_empty": always,
        "texture_empty_cells": empties,
        "feature_rich_cells": rich,
    }


# ----------------------------------------------------------------------------- slope
def slope_classes(slope: np.ndarray) -> np.ndarray:
    return np.digitize(slope, SLOPE_EDGES_DEG).astype(np.uint8)  # 0..3


def downsample_mean(a: np.ndarray, n: int) -> np.ndarray:
    f = a.shape[0] // n
    return a[: n * f, : n * f].reshape(n, f, n, f).mean(axis=(1, 3))


def _interior_point(mask: np.ndarray) -> tuple[int, int]:
    """(row, col) of the blob pixel farthest from the blob boundary (always inside the blob)."""
    d = ndimage.distance_transform_edt(np.pad(mask, 1))[1:-1, 1:-1]
    r, c = np.unravel_index(int(np.argmax(d)), d.shape)
    return int(r), int(c)


def largest_blob(mask: np.ndarray) -> tuple[np.ndarray | None, int]:
    lab, n = ndimage.label(mask, structure=EIGHT)
    if n == 0:
        return None, 0
    sizes = np.bincount(lab.ravel())[1:]
    k = int(np.argmax(sizes)) + 1
    return lab == k, int(sizes[k - 1])


def blob_summary(blob: np.ndarray, geom: TileGeom) -> dict:
    rows, cols = np.nonzero(blob)
    area_km2 = rows.size * (geom.res_m / 1000.0) ** 2
    ar, ac = _interior_point(blob)
    return {
        "area_km2": round(area_km2, 3),
        "n_px": int(rows.size),
        "centroid": geom.centre_of(cols.mean(), rows.mean()),
        "anchor": geom.centre_of(ac, ar),
        "bbox": geom.bbox(float(cols.min()), float(rows.min()), float(cols.max() + 1), float(rows.max() + 1)),
    }


def slope_block(slope: np.ndarray, rid: str, geom: TileGeom, prof: dict, out_dir: Path) -> dict:
    ok = np.isfinite(slope)
    s = slope[ok]
    cls = slope_classes(np.where(ok, slope, 0.0))
    grid = slope_classes(downsample_mean(np.where(ok, slope, 0.0), SLOPE_GRID))
    png = f"{rid}_slope_classes.png"
    if not cv2.imwrite(str(out_dir / png), grid):
        raise RuntimeError(f"failed to write {png}")
    steep = slope >= 25.0
    blob, _ = largest_blob(steep)
    if blob is None:
        blob, _ = largest_blob(slope >= 15.0)
    return {
        "method": "Horn 3x3 slope on the 30 m tile (roughness.slope_deg)",
        "thresholds_note": SLOPE_THRESHOLDS_NOTE,
        "illustrative_thresholds": True,
        "frac_ge_15deg": round(float((s >= 15.0).mean()), 4),
        "frac_ge_25deg": round(float((s >= 25.0).mean()), 4),
        "class_fracs": [round(float((cls[ok] == k).mean()), 4) for k in range(4)],
        "class_edges_deg": list(SLOPE_EDGES_DEG),
        "class_names": ["<8 deg", "8-15 deg", "15-25 deg", ">=25 deg"],
        "slope_p50_deg": round(float(np.percentile(s, 50)), 3),
        "slope_p90_deg": round(float(np.percentile(s, 90)), 3),
        "profile_slope_p50_deg": prof.get("slope_p50_deg"),
        "profile_slope_p90_deg": prof.get("slope_p90_deg"),
        "class_png": {"path": f"moon/{png}", "size": SLOPE_GRID, "block_px": slope.shape[0] // SLOPE_GRID,
                      "encoding": ("uint8 grayscale, pixel value = class 0..3 of the MEAN Horn slope of each "
                                   "4x4 block (120 m); row 0 = top, covers the full tile")},
        "steepest_area": None if blob is None else blob_summary(blob, geom),
    }


# ----------------------------------------------------------------------------- shadow
def read_mask_png(path: Path) -> np.ndarray:
    img = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise FileNotFoundError(path)
    return img


def shadow_block(region: dict, geom: TileGeom) -> dict:
    masks = []
    for m in region.get("shadow_masks", []):
        img = read_mask_png(WEB_DATA / m["path"])
        valid = img != 128
        sh = img == 255
        frac = float(sh[valid].mean()) if valid.any() else float("nan")
        blob, _ = largest_blob(sh)
        az = float(m["az"])
        entry = {"el": float(m["el"]), "az": az, "path": m["path"], "frac": round(frac, 4),
                 "sun_from": _compass(az), "largest_blob": None}
        if blob is not None:
            b = blob_summary(blob, geom)
            entry["largest_blob"] = b
            entry["label"] = (f"largest dark patch: {b['area_km2']:.1f} km² at a {m['el']:g}° sun "
                              f"from {_compass(az)}")
        masks.append(entry)
    return {"method": "precomputed cast-shadow masks (PNG 255 = shadow, 0 = lit, 128 = no data); "
                      "largest 8-connected shadow blob; az clockwise from grid +y (tile up)",
            "masks": masks}


# ----------------------------------------------------------------------------- safest patch
def safest_patch(slope: np.ndarray, geom: TileGeom) -> dict | None:
    steep = ~(slope < SAFE_SLOPE_DEG)  # NaN counts as not flat
    dist_m = ndimage.distance_transform_edt(~steep) * geom.res_m  # distance to nearest steep pixel
    safe = (~steep) & (dist_m >= SAFE_BUFFER_M)
    blob, _ = largest_blob(safe)
    if blob is None:
        return None
    out = blob_summary(blob, geom)
    out["label"] = f"flattest patch: {out['area_km2']:.2f} km² under 8°"
    out["rule"] = SAFE_RULE_NOTE
    out["total_safe_km2"] = round(float(safe.sum()) * (geom.res_m / 1000.0) ** 2, 3)
    return out


# ----------------------------------------------------------------------------- labels
def _steep25_phrase(frac: float) -> str:
    if frac < 0.005:
        return "almost none reaches 25\u00b0, around the illustrative walking limit."
    return f"{frac * 100:.0f}% is at or above 25\u00b0, around the illustrative walking limit."


def build_labels(hz: dict, rim: dict, tex: dict, slope: dict, shadow: dict, safe: dict | None,
                 geom: TileGeom) -> list[dict]:
    """4-6 plain-English callouts; numbers quoted from the profile (regions.json hazards)."""
    labels: list[dict] = []
    sh_m = hz["shadow"]["metrics"]
    el3 = [m for m in shadow["masks"] if m["el"] == 3.0 and m["largest_blob"]]
    if el3:
        best = max(el3, key=lambda m: m["largest_blob"]["area_km2"])
        b = best["largest_blob"]
        labels.append({"hazard": "shadow", "anchor": b["anchor"],
                       "title": f"Largest dark patch: {b['area_km2']:.1f} km²",
                       "text": (f"At a 3° sun, {sh_m['shadow_frac_el3'] * 100:.0f}% of this ground is in "
                                f"shadow on average; with the sun from {best['sun_from']} the biggest single "
                                f"shadow covers {b['area_km2']:.1f} km²."),
                       "ref": {"mask": best["path"]}})
    if rim["drops"]:
        d = rim["drops"][0]
        p95 = hz["rim"]["metrics"]["jump1km_p95_m"]
        labels.append({"hazard": "rim", "anchor": d["mid"],
                       "title": d["label"],
                       "text": (f"Biggest height change over 1 km here: {d['abs_dh_m']:.0f} m. 95% of 1 km steps "
                                f"on this tile are under {p95:.0f} m, so this cliff is in the worst 5%."),
                       "ref": {"rim_drop_rank": 1}})
    if tex["texture_empty_cells"]:
        c = tex["texture_empty_cells"][0]
        cb = c["bbox"]["px"]
        ef = hz["texture"]["metrics"]["empty_cell_frac_el3"]
        labels.append({"hazard": "texture", "anchor": geom.pos((cb[0] + cb[2]) / 2, (cb[1] + cb[3]) / 2),
                       "title": f"{ef * 100:.0f}% of 1 km squares look featureless",
                       "text": (f"At a low 3° sun, on average {ef * 100:.0f}% of the 1 km squares give a "
                                "navigation camera no trackable corner points; this square is blank in "
                                f"{c['empty_az_frac'] * 8:.0f} of 8 sun directions."),
                       "ref": {"cell": [c["i"], c["j"]]}})
    if slope["steepest_area"]:
        a = slope["steepest_area"]
        sm = hz["slope"]["metrics"]
        labels.append({"hazard": "slope", "anchor": a["anchor"],
                       "title": f"{slope['frac_ge_15deg'] * 100:.0f}% steeper than 15°",
                       "text": (f"Median slope {sm['slope_p50_deg']:.0f}\u00b0, 1 in 10 spots steeper than "
                                f"{sm['slope_p90_deg']:.0f}\u00b0; " + _steep25_phrase(slope["frac_ge_25deg"])),
                       "ref": {"png": slope["class_png"]["path"]}})
    if safe:
        labels.append({"hazard": "safe", "anchor": safe["anchor"],
                       "title": safe["label"].capitalize(),
                       "text": (f"The largest connected area under 8° that stays 100 m from steeper ground: "
                                f"{safe['area_km2']:.2f} km² (illustrative landing rule)."),
                       "ref": {"safest_patch": True}})
    return labels


# ----------------------------------------------------------------------------- driver
def _check(name: str, ours: float, prof: float | None, tol: float, mismatches: list[str]) -> None:
    if prof is None or not math.isfinite(ours) or abs(ours - prof) > tol:
        msg = f"{name}: ours {ours:.6g} vs profile {prof}"
        mismatches.append(msg)
        log.warning(msg)


def build_region(region: dict, out_dir: Path = WEB_MOON) -> dict:
    rid = region["id"]
    t0 = time.time()
    t = region["tile"]
    geom = TileGeom(float(t["origin_x"]), float(t["origin_y"]), float(t["res_m"]), int(t["size"]))
    dem, dem_src = load_dem(region)
    horizon = load_horizon(rid)
    hz = region["hazards"]
    rim = rim_block(dem, geom, hz["rim"]["metrics"])
    tex = texture_block(dem, horizon, geom, hz["texture"]["metrics"])
    slope = slope_deg(dem, geom.res_m)
    slp = slope_block(slope, rid, geom, hz["slope"]["metrics"], out_dir)
    shadow = shadow_block(region, geom)
    safe = safest_patch(slope, geom)
    mism: list[str] = []
    _check("rim.p95", rim["p95_m"], rim["profile_p95_m"], 0.1, mism)
    _check("texture.empty_frac", tex["empty_frac"], tex["profile_empty_frac"], 1e-5, mism)
    _check("slope.p50", slp["slope_p50_deg"], slp["profile_slope_p50_deg"], 0.01, mism)
    _check("slope.p90", slp["slope_p90_deg"], slp["profile_slope_p90_deg"], 0.01, mism)
    out = {
        "region_id": rid,
        "name": region.get("name"),
        "schema": "annotations/1",
        "generated_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "tile": {"size": geom.size, "res_m": geom.res_m, "origin_x": geom.origin_x, "origin_y": geom.origin_y,
                 "convention": ("px=[col,row] continuous, origin = top-left corner of pixel (0,0), row down; "
                                "xy=[x,y] projected m: x=origin_x+col*res, y=origin_y-row*res"),
                 "dem_source": dem_src},
        "rim_drops": rim,
        "texture": tex,
        "steep_mask_summary": slp,
        "shadow": shadow,
        "safest_patch": safe,
        "labels": build_labels(hz, rim, tex, slp, shadow, safe, geom),
        "profile_mismatches": mism,
    }
    path = out_dir / f"{rid}_annotations.json"
    text = json.dumps(out, separators=(",", ":"), allow_nan=False)
    if len(text.encode()) > MAX_JSON_BYTES:
        raise ValueError(f"{path.name} is {len(text)} bytes > {MAX_JSON_BYTES}")
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(text)
    tmp.replace(path)
    log.info("%s: %d B, biggest drop %.0f m, empty %.1f%%, safest %s km2 (%.1f s)", rid, len(text),
             rim["drops"][0]["abs_dh_m"] if rim["drops"] else float("nan"), tex["empty_frac"] * 100,
             safe["area_km2"] if safe else 0, time.time() - t0)
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m pipeline.moon.annotations", description=__doc__.splitlines()[0])
    ap.add_argument("--force", action="store_true", help="rebuild even if the JSON already exists")
    ap.add_argument("--region", nargs="*", help="only these region ids")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s",
                        datefmt="%H:%M:%S")
    regions = [r for r in load_regions() if not args.region or r["id"] in args.region]
    n_mism = 0
    for r in regions:
        path = WEB_MOON / f"{r['id']}_annotations.json"
        if path.exists() and not args.force:
            log.info("%s: exists, skipping (use --force)", r["id"])
            continue
        n_mism += len(build_region(r)["profile_mismatches"])
    log.info("done: %d regions, %d profile mismatches", len(regions), n_mism)
    return 0 if n_mism == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
