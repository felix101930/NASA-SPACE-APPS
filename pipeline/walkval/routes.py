"""Seeded Moon test routes and their distorted "needle" copies.

Routes are straight or two-leg polylines, 1-4 km, kept inside one Moon tile (data contract: Float32
LE 500x500, 30 m, row 0 = top, origin = top-left corner of pixel (0, 0)). The clean profile comes
from ``pipeline.metrics.profile.sample_profile`` (the same code the browser ports).

Needle distortion (all random parts drawn once per route, so a sweep over sigma/stretch is paired):
1. Height noise: i.i.d. N(0, sigma) added to every DEM pixel (bilinear sampling then smooths it a
   little, as it would on a real noisy DEM; ~2 m matches Copernicus GLO-30's relative accuracy).
2. Length stretch s: one contiguous half of the route (random position) is stretched horizontally
   by 1 + 2s, so the copy is L*(1+s) long and its features drift by up to s*L relative to the
   original - a local time warp, not just a uniform rescale (which resampling would undo).
3. Slope is re-derived from the noisy, warped heights with the profile code's rule
   (atan of numpy.gradient over ds = L'/(n-1)).
4. Reversal (p = 0.5): the copy is stored walked backwards (order reversed, slope negated).
"""
from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from pipeline.metrics.profile import _bilinear_clamped, sample_profile

log = logging.getLogger("pipeline.walkval")

MARGIN_M = 60.0  # keep vertices two pixels inside the tile so bilinear sampling never clamps


@dataclass
class MoonTile:
    region_id: str
    dem: np.ndarray
    res_m: float
    origin_x: float
    origin_y: float

    @property
    def bounds(self) -> tuple[float, float, float, float]:
        n0, n1 = self.dem.shape
        return (self.origin_x, self.origin_y - n0 * self.res_m,
                self.origin_x + n1 * self.res_m, self.origin_y)


@dataclass
class MoonRoute:
    idx: int
    region_id: str
    shape: str  # "straight" | "two_leg"
    polyline: np.ndarray  # [k, 2] map metres
    length_m: float
    slope_deg: np.ndarray  # clean profile, [P]
    h_rel_m: np.ndarray  # clean relative height (mean removed), [P]
    climb_m: float
    max_slope_deg: float
    # per-route random draws reused by every distortion setting
    seed: int = 0
    reversed: bool = False
    warp_start_frac: float = 0.0


@dataclass
class Needle:
    slope_deg: np.ndarray  # as stored in the library (possibly reversed)
    h_rel_m: np.ndarray
    length_m: float
    climb_m: float
    max_slope_deg: float
    reversed: bool


def load_tiles(regions: list[dict], web_data: Path) -> list[MoonTile]:
    tiles = []
    for r in regions:
        t = r["tile"]
        size = int(t["size"])
        dem = np.fromfile(web_data / t["path"], dtype="<f4").reshape(size, size).astype(np.float64)
        tiles.append(MoonTile(r["id"], dem, float(t["res_m"]), float(t["origin_x"]), float(t["origin_y"])))
    return tiles


def _inside(tile: MoonTile, pts: np.ndarray) -> bool:
    x0, y0, x1, y1 = tile.bounds
    return bool(np.all((pts[:, 0] >= x0 + MARGIN_M) & (pts[:, 0] <= x1 - MARGIN_M)
                       & (pts[:, 1] >= y0 + MARGIN_M) & (pts[:, 1] <= y1 - MARGIN_M)))


def _random_polyline(rng: np.random.Generator, tile: MoonTile, length: float, shape: str) -> np.ndarray | None:
    x0, y0, x1, y1 = tile.bounds
    start = np.array([rng.uniform(x0 + MARGIN_M, x1 - MARGIN_M), rng.uniform(y0 + MARGIN_M, y1 - MARGIN_M)])
    az = rng.uniform(0, 2 * math.pi)
    if shape == "straight":
        pts = np.array([start, start + length * np.array([math.sin(az), math.cos(az)])])
    else:
        f = rng.uniform(0.3, 0.7)
        turn = math.radians(rng.uniform(30, 150)) * (1 if rng.random() < 0.5 else -1)
        p1 = start + f * length * np.array([math.sin(az), math.cos(az)])
        p2 = p1 + (1 - f) * length * np.array([math.sin(az + turn), math.cos(az + turn)])
        pts = np.array([start, p1, p2])
    return pts if _inside(tile, pts) else None


def generate_routes(tiles: list[MoonTile], n_routes: int, seed: int, points: int) -> list[MoonRoute]:
    """``n_routes`` routes spread round-robin over the tiles; 1-4 km uniform; half two-leg."""
    rng = np.random.default_rng(seed)
    routes: list[MoonRoute] = []
    tries = 0
    while len(routes) < n_routes:
        tries += 1
        if tries > n_routes * 1000:
            raise RuntimeError("could not place routes inside the tiles")
        tile = tiles[len(routes) % len(tiles)]
        length = rng.uniform(1000.0, 4000.0)
        shape = "straight" if rng.random() < 0.5 else "two_leg"
        pts = _random_polyline(rng, tile, length, shape)
        if pts is None:
            continue
        prof = sample_profile(tile.dem, tile.res_m, (tile.origin_x, tile.origin_y), pts, n=points)
        h = np.asarray(prof["h_m"])
        if not np.all(np.isfinite(h)):
            continue
        routes.append(MoonRoute(
            idx=len(routes), region_id=tile.region_id, shape=shape, polyline=pts,
            length_m=float(prof["length_m"]), slope_deg=np.asarray(prof["slope_deg"]),
            h_rel_m=h - h.mean(), climb_m=float(prof["climb_m"]), max_slope_deg=float(prof["max_slope_deg"]),
            seed=int(rng.integers(0, 2**31 - 1)), reversed=bool(rng.random() < 0.5),
            warp_start_frac=float(rng.uniform(0.0, 0.5)),
        ))
    log.info("generated %d Moon routes (%d placement tries)", len(routes), tries)
    return routes


def warp_positions(length_m: float, stretch: float, start_frac: float, points: int) -> tuple[np.ndarray, float]:
    """Arc positions t (m, along the ORIGINAL route) of the copy's ``points`` equally spaced samples.

    The half [a, a + L/2] of the route (a = start_frac * L) is stretched by k = 1 + 2*stretch, so
    the copy's length is L * (1 + stretch). Returns (t, copy_length).
    """
    L = length_m
    k = 1.0 + 2.0 * stretch
    a = start_frac * L
    half = 0.5 * L
    Lc = L * (1.0 + stretch)
    u = np.linspace(0.0, Lc, points)
    t = np.where(u < a, u, np.where(u < a + k * half, a + (u - a) / k, u - (k - 1.0) * half))
    return np.clip(t, 0.0, L), Lc


def make_needle(route: MoonRoute, tile: MoonTile, sigma_m: float, stretch: float, points: int,
                reverse: bool | None = None) -> Needle:
    """Distorted copy of ``route`` (see module docstring). ``reverse`` overrides the route's draw."""
    rng = np.random.default_rng(route.seed)
    noise = rng.standard_normal(tile.dem.shape)
    pts = route.polyline
    seg = np.hypot(np.diff(pts[:, 0]), np.diff(pts[:, 1]))
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    t, Lc = warp_positions(float(cum[-1]), stretch, route.warp_start_frac, points)
    x = np.interp(t, cum, pts[:, 0])
    y = np.interp(t, cum, pts[:, 1])
    col = (x - tile.origin_x) / tile.res_m - 0.5
    row = (tile.origin_y - y) / tile.res_m - 0.5
    h = _bilinear_clamped(tile.dem, row, col) + sigma_m * _bilinear_clamped(noise, row, col)
    rev = route.reversed if reverse is None else reverse
    if rev:
        h = h[::-1]
    ds = Lc / (points - 1)
    slope = np.degrees(np.arctan(np.gradient(h, ds)))
    dh = np.diff(h)
    return Needle(slope_deg=slope, h_rel_m=h - h.mean(), length_m=Lc,
                  climb_m=float(np.clip(dh, 0, None).sum()), max_slope_deg=float(np.abs(slope).max()),
                  reversed=rev)
