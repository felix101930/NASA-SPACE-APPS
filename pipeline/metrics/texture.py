"""Optical-navigation texture proxy (Ingenuity / IM-2): FAST keypoint density on a hillshade
that includes cast shadows. A proxy for high-altitude terrain-relative navigation only.

Hillshade: Lambertian ``I = max(0, n . l)`` with the light vector from (sun_el, sun_az), azimuth
clockwise from grid north (row 0 = north). Cast-shadow pixels are set to 0. The image is
auto-exposed like a camera: the 99th percentile of lit pixels maps to 255 (``exposure="auto"``),
or a fixed gain is applied (``exposure=<float>`` -> ``I * gain * 255``).
"""
from __future__ import annotations

import logging
import math

import cv2
import numpy as np

log = logging.getLogger(__name__)


def render_hillshade(dem: np.ndarray, res_m: float, sun_el: float, sun_az: float,
                     shadow: np.ndarray | None = None, exposure: str | float = "auto") -> np.ndarray:
    """uint8 hillshade (0..255). ``shadow``: bool mask of cast-shadow pixels (set to 0)."""
    z = np.asarray(dem, dtype=np.float64)
    gy, gx = np.gradient(z, res_m)  # gy: d/d(row) = -d/dy (north is row 0)
    dzdx, dzdy = gx, -gy
    el, az = math.radians(sun_el), math.radians(sun_az)
    lx, ly, lz = math.cos(el) * math.sin(az), math.cos(el) * math.cos(az), math.sin(el)
    shade = (-dzdx * lx - dzdy * ly + lz) / np.sqrt(dzdx * dzdx + dzdy * dzdy + 1.0)
    shade = np.where(np.isfinite(shade), np.clip(shade, 0.0, None), 0.0)
    if shadow is not None:
        shade[np.asarray(shadow, dtype=bool)] = 0.0
    if exposure == "auto":
        lit = shade[shade > 0]
        ref = float(np.percentile(lit, 99)) if lit.size else 0.0
        gain = 255.0 / ref if ref > 0 else 0.0
    else:
        gain = 255.0 * float(exposure)
    return np.clip(np.rint(shade * gain), 0, 255).astype(np.uint8)


def fast_density(hill: np.ndarray, res_m: float, threshold: int = 20, nms: bool = True,
                 cell_m: float = 1000.0) -> dict[str, float]:
    """FAST-9 keypoints per km^2 and the fraction of whole ``cell_m`` cells with no keypoint.

    Cells tile the image from the top-left corner; partial cells at the right/bottom edge are
    ignored for ``empty_cell_frac`` (a 500 px x 30 m tile has exactly 15 x 15 cells of 1 km).
    """
    img = np.ascontiguousarray(hill, dtype=np.uint8)
    det = cv2.FastFeatureDetector_create(threshold=int(threshold), nonmaxSuppression=bool(nms))
    kps = det.detect(img, None)
    area_km2 = img.size * (res_m / 1000.0) ** 2
    n_r = int(math.floor(img.shape[0] * res_m / cell_m + 1e-9))
    n_c = int(math.floor(img.shape[1] * res_m / cell_m + 1e-9))
    empty = float("nan")
    if n_r > 0 and n_c > 0:
        counts = np.zeros((n_r, n_c), dtype=np.int64)
        for kp in kps:
            ci = int(kp.pt[1] * res_m // cell_m)
            cj = int(kp.pt[0] * res_m // cell_m)
            if ci < n_r and cj < n_c:
                counts[ci, cj] += 1
        empty = float((counts == 0).mean())
    return {"fast_per_km2": len(kps) / area_km2, "empty_cell_frac": empty, "n_keypoints": float(len(kps))}


def texture_stats(dem: np.ndarray, horizon: np.ndarray | None, res_m: float, sun_el: float = 3.0,
                  n_az: int = 8, threshold: int = 20) -> dict[str, float]:
    """FAST metrics averaged over ``n_az`` sun azimuths (0, 360/n_az, ...) at ``sun_el``.

    Cast shadows come from ``horizon`` (n_az_h, H, W) for the same pixels as ``dem``; pass None to
    render without cast shadows. Keys: ``fast_per_km2_el{el}``, ``empty_cell_frac_el{el}``.
    """
    from .horizon import shadow_mask  # local import keeps texture usable without numba warm-up

    dens, empt = [], []
    for k in range(n_az):
        az = 360.0 * k / n_az
        sh = None if horizon is None else shadow_mask(horizon, sun_el, az)
        r = fast_density(render_hillshade(dem, res_m, sun_el, az, sh), res_m, threshold)
        dens.append(r["fast_per_km2"])
        empt.append(r["empty_cell_frac"])
    tag = f"el{sun_el:g}"
    return {f"fast_per_km2_{tag}": float(np.mean(dens)), f"empty_cell_frac_{tag}": float(np.mean(empt))}
