"""Terrain measurements on a 30 m height grid. Same code for Moon and Earth (METHOD.md, Jobs 1 and 4).

Input: a height array covering the window plus a 2 km margin (for shadows and viewshed).
"""
import numpy as np
from scipy import ndimage as ndi

RES = 30.0
MARGIN = 67            # 2 km in 30 m pixels
AZ8 = np.arange(8) * 45.0
SHIFT = 12.9           # sun azimuth change over one Earth day on the Moon
ELEVS = (1.5, 3.0, 6.0)

A_COLS = ["land_frac", "slope_p50", "slope_p90", "slope120_p90", "rough240", "rough960", "edge_m1", "edge_m2"]
B_COLS = [f"shadow_{e}" for e in ELEVS]
C_COLS = ["corners_km2", "lit3", "sunshift"]
BASE_COLS = ["flat5_km2", "walk20", "viewshed", "relief"]
ALL_COLS = A_COLS + B_COLS + C_COLS + BASE_COLS


def slope_deg(z, res=RES):
    gy, gx = np.gradient(z, res)
    return np.degrees(np.arctan(np.hypot(gx, gy)))


def horizon_tan(z, az, nsteps=MARGIN, res=RES):
    """Max tangent of the terrain elevation angle seen from each pixel toward azimuth az (deg, clockwise from grid up)."""
    a = np.radians(az)
    best = np.full(z.shape, -np.inf, dtype=np.float32)
    seen = set()
    n0, n1 = z.shape
    for s in range(1, nsteps + 1):
        dc, dr = int(round(s * np.sin(a))), int(round(-s * np.cos(a)))
        if (dc, dr) in seen:
            continue
        seen.add((dc, dr))
        d = np.hypot(dc, dr) * res
        r0, r1 = max(0, -dr), min(n0, n0 - dr)
        c0, c1 = max(0, -dc), min(n1, n1 - dc)
        t = (z[r0 + dr:r1 + dr, c0 + dc:c1 + dc] - z[r0:r1, c0:c1]) / d
        np.maximum(best[r0:r1, c0:c1], t, out=best[r0:r1, c0:c1])
    return best


def render(z, az, elev, horizon=None, res=RES):
    """Lambertian render with cast shadows; returns (radiance, lit mask)."""
    gy, gx = np.gradient(z, res)
    a, e = np.radians(az), np.radians(elev)
    sx, sy, sz = np.sin(a) * np.cos(e), np.cos(a) * np.cos(e), np.sin(e)
    # grid rows increase downward, so "up" (north of grid) is -row: dz/dnorth = -gy
    n = np.sqrt(gx ** 2 + gy ** 2 + 1)
    cosi = (-gx * sx + gy * sy + sz) / n
    if horizon is None:
        horizon = horizon_tan(z, az)
    lit = (horizon < np.tan(e)) & (cosi > 0)
    return np.where(lit, cosi, 0.0), lit


def _corners(img, lit):
    from skimage.feature import corner_harris, corner_peaks
    v = img[lit]
    if v.size < 50:
        return 0
    im = np.clip(img / (np.percentile(v, 99) + 1e-9), 0, 1)       # auto-exposure
    pk = corner_peaks(corner_harris(im, k=0.05, sigma=1), min_distance=2, threshold_abs=0.01)
    return int(lit[pk[:, 0], pk[:, 1]].sum()) if len(pk) else 0


def _depressions(z):
    from skimage.morphology import reconstruction
    seed = z.copy()
    seed[1:-1, 1:-1] = z.max()
    filled = reconstruction(seed, z, method="erosion")
    depth = filled - z
    lab, n = ndi.label(depth > 0.5)
    if n == 0:
        return 0
    idx = np.arange(1, n + 1)
    dmax = ndi.maximum(depth, lab, idx)
    area = ndi.sum(np.ones_like(z), lab, idx) * RES * RES / 1e6
    return int(((dmax >= 3) & (area >= 0.02)).sum())


def _viewshed(z, r0, c0, h=10.0, radius=MARGIN):
    z0 = z[r0, c0] + h
    vis = np.zeros(z.shape, bool)
    for a in np.radians(np.arange(0, 360, 1.0)):
        best = -np.inf
        for s in range(1, radius + 1):
            r, c = int(round(r0 - s * np.cos(a))), int(round(c0 + s * np.sin(a)))
            if not (0 <= r < z.shape[0] and 0 <= c < z.shape[1]):
                break
            t = (z[r, c] - z0) / (s * RES)
            if t >= best:
                vis[r, c] = True
                best = t
    rr, cc = np.ogrid[:z.shape[0], :z.shape[1]]
    disc = (rr - r0) ** 2 + (cc - c0) ** 2 <= radius ** 2
    return vis[disc].mean()


def window_features(zpad, half=64, margin=MARGIN, horizons=None):
    """All features for the central (2*half)^2 window of zpad (which has `margin` px around it)."""
    m = margin
    c = slice(m, m + 2 * half)
    zc = zpad[c, c]
    if not np.isfinite(zc).all() or np.ptp(zc) == 0:
        return None
    f = {}
    km2 = (2 * half * RES / 1000) ** 2
    s_all = slope_deg(zpad)
    s = s_all[c, c]
    steep = s_all >= 8
    dist = ndi.distance_transform_edt(~steep) * RES
    f["land_frac"] = float(((s < 8) & (dist[c, c] >= 100)).mean())
    f["slope_p50"], f["slope_p90"] = (float(v) for v in np.percentile(s, [50, 90]))
    k = 4
    zb = zc[: zc.shape[0] // k * k, : zc.shape[1] // k * k].reshape(zc.shape[0] // k, k, -1, k).mean((1, 3))
    f["slope120_p90"] = float(np.percentile(slope_deg(zb, RES * k), 90))
    for name, size in (("rough240", 8), ("rough960", 32)):
        resid = (zpad - ndi.uniform_filter(zpad, size))[c, c]
        f[name] = float(1.4826 * np.median(np.abs(resid - np.median(resid))))
    ds = np.maximum(np.abs(s_all[:, 2:] - s_all[:, :-2])[c, m - 1:m - 1 + 2 * half],
                    np.abs(s_all[2:, :] - s_all[:-2, :])[m - 1:m - 1 + 2 * half, c])
    f["edge_m1"] = float((ds > 10).mean())
    f["edge_m2"] = _depressions(zc) / km2
    # shadows and camera
    if horizons is None:
        horizons = {az: horizon_tan(zpad, az) for az in np.concatenate([AZ8, AZ8 + SHIFT])}
    for e in ELEVS:
        f[f"shadow_{e}"] = float(np.mean([(horizons[az][c, c] >= np.tan(np.radians(e))).mean() for az in AZ8]))
    corners, lit3, flips = [], [], []
    for az in AZ8:
        img, lit = render(zpad, az, 3.0, horizons[az])
        _, lit2 = render(zpad, az + SHIFT, 3.0, horizons[az + SHIFT])
        corners.append(_corners(img[c, c], lit[c, c]) / km2)
        lit3.append(lit[c, c].mean())
        flips.append((lit[c, c] != lit2[c, c]).mean())
    f["corners_km2"], f["lit3"], f["sunshift"] = float(np.mean(corners)), float(np.mean(lit3)), float(np.mean(flips))
    # base
    lab, n = ndi.label(s < 5)
    f["flat5_km2"] = float(np.bincount(lab.ravel())[1:].max() * RES * RES / 1e6) if n else 0.0
    f["walk20"] = float((s < 20).mean())
    sm = ndi.uniform_filter(s, 5)
    r0, c0 = np.unravel_index(np.argmin(sm[5:-5, 5:-5]), (2 * half - 10, 2 * half - 10))
    f["viewshed"] = float(_viewshed(zpad, r0 + 5 + m, c0 + 5 + m))
    f["relief"] = float(np.ptp(zc))
    return f
