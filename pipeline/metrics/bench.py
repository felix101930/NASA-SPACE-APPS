"""Runtime benchmark: 500x500 core at 30 m + 15 km near buffer + 100 km far field at 300 m.

Run: ``.venv/bin/python -m pipeline.metrics.bench [--n-az 72] [--radius-km 100]``
"""
from __future__ import annotations

import argparse
import logging
import time

import numpy as np

from pipeline.common.config import CORE_SIZE_PX, GRID_RES_M, MOON_R_M
from pipeline.metrics import compute_all, horizon_map, to_grid

log = logging.getLogger("pipeline.metrics.bench")


def fractal(n: int, beta: float = 2.6, amp: float = 600.0, seed: int = 0) -> np.ndarray:
    """Synthetic fractal terrain (power-law spectrum), zero mean, std ``amp``."""
    rng = np.random.default_rng(seed)
    kx = np.fft.fftfreq(n)[:, None]
    ky = np.fft.fftfreq(n)[None, :]
    k = np.hypot(kx, ky)
    k[0, 0] = 1.0
    f = (rng.normal(size=(n, n)) + 1j * rng.normal(size=(n, n))) / k ** (beta / 2)
    f[0, 0] = 0
    z = np.real(np.fft.ifft2(f))
    return (z - z.mean()) / z.std() * amp


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n-az", type=int, default=72)
    ap.add_argument("--radius-km", type=float, default=100.0)
    ap.add_argument("--buffer-km", type=float, default=15.0)
    ap.add_argument("--res-far", type=float, default=300.0)
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")

    res, core = GRID_RES_M, CORE_SIZE_PX
    buf = int(round(args.buffer_km * 1000 / res))
    n_near = core + 2 * buf
    half_far_m = core * res / 2 + args.radius_km * 1000 + args.res_far
    n_far = int(np.ceil(2 * half_far_m / args.res_far))
    # synthetic, independent near and far fractals (timing only; terrain is rougher than real)
    far = fractal(n_far, beta=3.2, amp=600.0, seed=1)
    near = fractal(n_near, beta=3.2, amp=400.0, seed=2)
    log.info("near %dx%d @ %.0f m, far %dx%d @ %.0f m, core %d, n_az %d, radius %.0f km",
             n_near, n_near, res, n_far, n_far, args.res_far, core, args.n_az, args.radius_km)
    sl = (slice(buf, buf + core), slice(buf, buf + core))
    kw = dict(n_az=args.n_az, planet_radius_m=MOON_R_M)

    t = time.perf_counter()
    horizon_map(near[:64, :64], res, (slice(16, 48), slice(16, 48)), dem_far=far, res_far=args.res_far,
                n_az=4, max_radius_m=5e3, planet_radius_m=MOON_R_M)
    log.info("jit warm-up: %.2f s", time.perf_counter() - t)

    t = time.perf_counter()
    h_near = horizon_map(near, res, sl, **kw)
    t_near = time.perf_counter() - t
    log.info("horizon near-only (15 km buffer): %.2f s", t_near)

    t = time.perf_counter()
    h_far = horizon_map(near, res, sl, dem_far=far, res_far=args.res_far,
                        max_radius_m=args.radius_km * 1000, **kw)
    t_far = time.perf_counter() - t
    log.info("horizon near + far (%.0f km @ %.0f m): %.2f s", args.radius_km, args.res_far, t_far)
    for el in (1, 3, 5):
        log.info("  shadow el=%d: near-only %.3f, with far field %.3f", el, (h_near > el).mean(), (h_far > el).mean())

    t = time.perf_counter()
    m = compute_all(near[sl], h_far, res, lat_deg=-86.0)
    log.info("compute_all (time-weighted 2048 sun samples, rim, texture, roughness): %.2f s",
             time.perf_counter() - t)
    t = time.perf_counter()
    to_grid(fractal(750, seed=3), 20.0, 30.0)
    log.info("to_grid 750x750 20 m -> 30 m: %.3f s", time.perf_counter() - t)
    log.info("metrics: %s", {k: (round(v, 4) if isinstance(v, float) else v) for k, v in m.items()})


if __name__ == "__main__":
    main()
