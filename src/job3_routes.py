"""Job 3: route twin. Given a Moon route, find the Earth route with the same ups and downs.

Matchers (METHOD.md): Euclidean on height; Euclidean on height + slope; DTW (10% band); non-normalized
matrix profile (stumpy, sliding along the line). Find-back test: a distorted copy of each Moon route
(2 m height noise, 5% stretch, random reversal) is hidden among the Earth paths.

Run: python src/job3_routes.py <scratch_dir>
"""
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
from numba import njit, prange
from scipy.ndimage import map_coordinates
from scipy.signal import fftconvolve
from shapely.geometry import Point, Polygon

sys.path.insert(0, str(Path(__file__).parent))
from moon import region_data, regions

ROOT = Path(__file__).resolve().parents[1]
STEP = 30.0
NLINE = 135                       # 4.02 km lines through each Earth window centre
DIRS = np.arange(16) * 22.5


def sample(z, r0, c0, pts_rc):
    return map_coordinates(z, [r0 + pts_rc[:, 0], c0 + pts_rc[:, 1]], order=1)


def earth_lines(scratch, ids):
    t = (np.arange(NLINE) - (NLINE - 1) / 2) * STEP / 30.0
    L, meta = [], []
    for wid in ids:
        z = np.load(Path(scratch) / "earth_z" / f"{wid}.npy")
        c = (z.shape[0] - 1) / 2
        for d in DIRS:
            a = np.radians(d)
            L.append(map_coordinates(z, [c - t * np.cos(a), c + t * np.sin(a)], order=1))
            meta.append((wid, d))
    return np.array(L, np.float32), meta


def moon_routes(n=300, seed=0):
    rng = np.random.default_rng(seed)
    regs = regions()
    names = sorted(regs)
    data = {name: region_data(name) for name in names}
    out = []
    while len(out) < n:
        name = names[len(out) % len(names)]
        d = data[name]
        poly = Polygon(zip(regs[name]["x"], regs[name]["y"]))
        length = rng.uniform(1000, 4000)
        two_leg = rng.random() < 0.5
        x0, y0 = rng.uniform(min(regs[name]["x"]), max(regs[name]["x"])), rng.uniform(min(regs[name]["y"]), max(regs[name]["y"]))
        a1 = rng.uniform(0, 2 * np.pi)
        a2 = a1 + rng.choice([-1, 1]) * rng.uniform(np.radians(30), np.radians(150))
        ns = int(length // STEP) + 1
        s = np.arange(ns) * STEP
        split = length * rng.uniform(0.3, 0.7) if two_leg else length
        xs = np.where(s <= split, x0 + s * np.sin(a1), x0 + split * np.sin(a1) + (s - split) * np.sin(a2))
        ys = np.where(s <= split, y0 + s * np.cos(a1), y0 + split * np.cos(a1) + (s - split) * np.cos(a2))
        if not all(poly.contains(Point(x, y)) for x, y in zip(np.r_[xs[::10], xs[-1]], np.r_[ys[::10], ys[-1]])):
            continue
        r = (d["gy"][0] - ys) / 30.0; c = (xs - d["gx"][0]) / 30.0
        h = map_coordinates(d["z30"], [r, c], order=1)
        out.append(dict(region=name, length=length, two_leg=two_leg, h=h, x0=x0, y0=y0))
    return out


def rel(h):
    return h - h[..., :1]


def slope(h):
    return np.degrees(np.arctan(np.diff(h, axis=-1) / STEP))


def hidden_copy(h, rng):
    n = len(h)
    s_new = np.arange(int(round(n * 1.05))) / 1.05          # 5% stretch
    hc = np.interp(s_new, np.arange(n), h) + rng.normal(0, 2.0, len(s_new))
    if rng.random() < 0.5:
        hc = hc[::-1]
    if len(hc) > NLINE:                                       # stretched copy longer than a line: keep the centre
        s = (len(hc) - NLINE) // 2
        hc = hc[s:s + NLINE]
    # embed in a line of the same length as the Earth lines, centred, padded with a flat continuation
    pad = NLINE - len(hc)
    left = pad // 2
    return np.r_[np.full(left, hc[0]), hc, np.full(pad - left, hc[-1])].astype(np.float32)


def centred(lines, n):
    s = (NLINE - n) // 2
    return lines[:, s:s + n]


def d_euclid(Q, C):
    return np.sqrt(((rel(C) - rel(Q)) ** 2).mean(1))


def d_euclid_slope(Q, C, sh=2.0, ss=2.0):
    dh = np.sqrt(((rel(C) - rel(Q)) ** 2).mean(1)) / sh
    ds = np.sqrt(((slope(C) - slope(Q)) ** 2).mean(1)) / ss
    return dh + ds


@njit(parallel=True, cache=True)
def _dtw_band(q, c, w):
    """DTW per candidate row, rolling two-row DP, Sakoe-Chiba band w. Returns D[n, n]."""
    n = q.shape[0]; m = c.shape[0]
    out = np.empty(m)
    for k in prange(m):
        prev = np.full(n + 1, np.inf); cur = np.full(n + 1, np.inf)
        prev[0] = 0.0
        for i in range(1, n + 1):
            cur[:] = np.inf
            for j in range(max(1, i - w), min(n, i + w) + 1):
                cost = (q[i - 1] - c[k, j - 1]) ** 2
                cur[j] = cost + min(prev[j], cur[j - 1], prev[j - 1])
            prev, cur = cur, prev
        out[k] = prev[n]
    return out


def d_dtw(Q, C, band=0.1):
    q, c = rel(Q).astype(np.float64), rel(C).astype(np.float64)
    n = len(q); w = max(1, int(band * n))
    return np.sqrt(_dtw_band(q, np.ascontiguousarray(c), w) / n)


def d_dtw_chunked(Q, C, chunk=20000):
    return np.concatenate([d_dtw(Q, C[k:k + chunk]) for k in range(0, len(C), chunk)])


def d_aamp(Q, lines, return_offset=False):
    """Non-normalized matrix profile of the query against each line: best sliding Euclidean distance of the
    query anywhere along the whole line. Relative profiles via first differences (start-offset invariant).
    Computed per line with FFT (same as stumpy core.mass_absolute), so there are no separators between lines
    and no window can straddle two lines."""
    n = len(Q)
    dq = np.diff(Q).astype(np.float64)                      # length n-1
    dT = np.diff(lines.astype(np.float64), axis=1)          # (L, NLINE-1)
    m = len(dq)
    if dT.shape[1] < m:
        return (np.full(len(lines), np.inf), np.zeros(len(lines), int)) if return_offset else np.full(len(lines), np.inf)
    qT = fftconvolve(dT, dq[::-1][None], mode="valid", axes=1)          # (L, NLINE-n+1)
    cs = np.concatenate([np.zeros((len(dT), 1)), np.cumsum(dT ** 2, axis=1)], axis=1)
    TT = cs[:, m:] - cs[:, :-m]
    d2 = np.maximum(TT - 2 * qT + (dq ** 2).sum(), 0.0)
    d = np.sqrt(d2.min(1) / n)
    return (d, d2.argmin(1)) if return_offset else d


def main(scratch, n_routes=300, n_earth=None):
    rng = np.random.default_rng(1)
    ew = pd.read_csv(ROOT / "results" / "earth_windows.csv")
    ids = ew[ew.kind == "bare"].id.values
    if n_earth:
        ids = rng.choice(ids, n_earth, replace=False)
    lines, meta = earth_lines(scratch, ids)
    print("earth lines", lines.shape, flush=True)
    routes = moon_routes(n_routes)
    matchers = {"euclid_height": d_euclid, "euclid_height_slope": d_euclid_slope, "dtw_10pct": d_dtw_chunked}
    rows = []
    t_used = {m: 0.0 for m in list(matchers) + ["matrix_profile"]}
    for k, rt in enumerate(routes):
        h = rt["h"]; n = len(h)
        hid = hidden_copy(h, rng)
        allL = np.vstack([lines, hid[None]])
        C = centred(allL, n)
        for m, fn in matchers.items():
            t = time.time()
            d = np.minimum(fn(h, C), fn(h[::-1].copy(), C))
            t_used[m] += time.time() - t
            rank = int((d[:-1] < d[-1]).sum()) + 1
            b = int(np.argmin(d[:-1]))
            fwd = fn(h, C[b:b + 1])[0] <= fn(h[::-1].copy(), C[b:b + 1])[0]
            qb = h if fwd else h[::-1]
            rmse = float(np.sqrt(((rel(C[b]) - rel(qb)) ** 2).mean()))
            dslope = float(abs(np.abs(slope(C[b])).max() - np.abs(slope(qb)).max()))
            rows.append(dict(route=k, region=rt["region"], length=rt["length"], two_leg=rt["two_leg"], matcher=m,
                             hidden_rank=rank, best_earth=meta[b][0], best_dir=meta[b][1], rmse_m=rmse,
                             max_slope_diff=dslope, route_relief=float(np.ptp(h)),
                             route_max_slope=float(np.abs(slope(h)).max())))
        t = time.time()
        d = np.minimum(d_aamp(h, allL), d_aamp(h[::-1].copy(), allL))
        t_used["matrix_profile"] += time.time() - t
        rank = int((d[:-1] < d[-1]).sum()) + 1
        b = int(np.argmin(d[:-1]))
        df_, of_ = d_aamp(h, allL[b:b + 1], True); dr_, or_ = d_aamp(h[::-1].copy(), allL[b:b + 1], True)
        qb, off = (h, int(of_[0])) if df_[0] <= dr_[0] else (h[::-1], int(or_[0]))
        seg = allL[b, off:off + n]
        rows.append(dict(route=k, region=rt["region"], length=rt["length"], two_leg=rt["two_leg"],
                         matcher="matrix_profile", hidden_rank=rank, best_earth=meta[b][0], best_dir=meta[b][1],
                         rmse_m=float(np.sqrt(((rel(seg) - rel(qb)) ** 2).mean())),
                         max_slope_diff=float(abs(np.abs(slope(seg)).max() - np.abs(slope(qb)).max())),
                         route_relief=float(np.ptp(h)), route_max_slope=float(np.abs(slope(h)).max())))
        if k % 25 == 0:
            print(k, {m: round(v, 1) for m, v in t_used.items()}, flush=True)
    df = pd.DataFrame(rows)
    df.to_csv(ROOT / "results" / "job3_routes.csv", index=False, float_format="%.3f")
    summ = df.groupby("matcher").agg(top1=("hidden_rank", lambda r: (r == 1).mean()),
                                     top5=("hidden_rank", lambda r: (r <= 5).mean()),
                                     median_rank=("hidden_rank", "median"),
                                     rmse_m_median=("rmse_m", "median"), max_slope_diff_median=("max_slope_diff", "median"))
    summ["seconds_per_route"] = [t_used[m] / len(routes) for m in summ.index]
    summ.to_csv(ROOT / "results" / "job3_matcher_contest.csv", float_format="%.3f")
    print(summ.round(3).to_string())


if __name__ == "__main__":
    main(sys.argv[1], n_earth=int(sys.argv[2]) if len(sys.argv) > 2 else None)
