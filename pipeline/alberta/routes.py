"""Pathway network graph, seeded route chains, DTM profiles and banded DTW (pure functions, testable).

Graph: every LineString part of a pathway feature is an edge between its two end nodes (after noding at
crossings and T-junctions, and optional straight connectors across small gaps); ends closer than
SNAP_M are merged (grid hashing + union-find). Routes are seeded random walks on the graph: no edge or node
is revisited; at each junction the next edge is drawn with weight favouring REGIONAL pathways and edges in
parks and penalising sharp turns; a walk stops when it reaches its drawn target length (0.5-3 km) or a dead
end (kept if >= 0.5 km).
"""
from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass, field

import numba
import numpy as np

SNAP_M = 2.0


@dataclass
class Graph:
    xy: np.ndarray                     # [n_nodes, 2] node coordinates (map metres)
    edges: list[dict]                  # {u, v, coords (k,2) from u to v, length, weight, ...}
    adj: dict[int, list[int]] = field(default_factory=dict)   # node -> edge indices


def _find(parent: list[int], i: int) -> int:
    while parent[i] != i:
        parent[i] = parent[parent[i]]
        i = parent[i]
    return i


def node_lines(lines: list[tuple[np.ndarray, dict]], snap_m: float = SNAP_M,
               gap_m: float = 0.0, connector_attrs: dict | None = None) -> list[tuple[np.ndarray, dict]]:
    """Split lines at (a) crossings with other lines and (b) points nearest to another line's endpoint
    when that endpoint lies within snap_m of the line's interior (T-junctions, digitising slivers).
    (c) If gap_m > snap_m, an endpoint touching nothing within snap_m is joined to the nearest other
    line within gap_m by a straight connector edge (e.g. street crossings between pathway segments)."""
    from shapely import STRtree
    from shapely.geometry import LineString, Point
    from shapely.ops import substring
    geoms = [LineString(c) for c, _ in lines]
    tree = STRtree(geoms)
    cuts: list[set] = [set() for _ in geoms]
    connectors = []

    def cut(j: int, d: float, tol: float) -> None:
        if tol < d < geoms[j].length - tol:
            cuts[j].add(round(d, 2))

    for i, gi in enumerate(geoms):
        for end in (Point(gi.coords[0]), Point(gi.coords[-1])):
            near = []
            for j in tree.query(end.buffer(max(snap_m, gap_m))):
                j = int(j)
                if j != i:
                    near.append((geoms[j].distance(end), j))
            touching = [j for dist, j in near if dist <= snap_m]
            for j in touching:
                cut(j, geoms[j].project(end), snap_m)
            if not touching and gap_m > snap_m and near:
                dist, j = min(near)
                if dist <= gap_m:
                    d = geoms[j].project(end)
                    p = geoms[j].interpolate(d)
                    cut(j, d, 0.5)
                    connectors.append((np.array([[end.x, end.y], [p.x, p.y]]), dict(connector_attrs or {})))
        for j in tree.query(gi, predicate="crosses"):
            j = int(j)
            if j <= i:
                continue
            x = gi.intersection(geoms[j])
            pts = [x] if x.geom_type == "Point" else [p for p in getattr(x, "geoms", []) if p.geom_type == "Point"]
            for p in pts:
                cut(i, gi.project(p), snap_m)
                cut(j, geoms[j].project(p), snap_m)
    out = []
    for (coords, attrs), g, cs in zip(lines, geoms, cuts):
        if not cs:
            out.append((coords, attrs))
            continue
        ds = [0.0] + sorted(cs) + [g.length]
        for a, b in zip(ds[:-1], ds[1:]):
            if b - a > 0.01:
                out.append((np.asarray(substring(g, a, b).coords), attrs))
    return out + connectors


def build_graph(lines: list[tuple[np.ndarray, dict]], snap_m: float = SNAP_M) -> Graph:
    """lines: [(coords (k,2) in metres, attrs)]. Returns the snapped graph."""
    ends = []
    for coords, _ in lines:
        ends.append(coords[0])
        ends.append(coords[-1])
    ends = np.asarray(ends, float)
    n = len(ends)
    parent = list(range(n))
    cell = defaultdict(list)
    keys = np.floor(ends / snap_m).astype(np.int64)
    for i, (kx, ky) in enumerate(keys):
        cell[(kx, ky)].append(i)
    for i, (kx, ky) in enumerate(keys):
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for j in cell.get((kx + dx, ky + dy), ()):
                    if j > i and np.hypot(*(ends[i] - ends[j])) <= snap_m:
                        ri, rj = _find(parent, i), _find(parent, j)
                        if ri != rj:
                            parent[rj] = ri
    roots = {}
    node_of = np.empty(n, np.int64)
    for i in range(n):
        r = _find(parent, i)
        node_of[i] = roots.setdefault(r, len(roots))
    xy = np.zeros((len(roots), 2))
    cnt = np.zeros(len(roots))
    for i in range(n):
        xy[node_of[i]] += ends[i]
        cnt[node_of[i]] += 1
    xy /= cnt[:, None]
    g = Graph(xy=xy, edges=[], adj=defaultdict(list))
    for k, (coords, attrs) in enumerate(lines):
        u, v = int(node_of[2 * k]), int(node_of[2 * k + 1])
        if u == v and len(coords) < 3:
            continue
        length = float(np.hypot(*np.diff(coords, axis=0).T).sum())
        if length <= 0:
            continue
        e = {"u": u, "v": v, "coords": coords, "length": length, **attrs}
        g.adj[u].append(len(g.edges))
        g.adj[v].append(len(g.edges))
        g.edges.append(e)
    return g


def components(g: Graph) -> np.ndarray:
    """Connected-component label per node."""
    lab = -np.ones(len(g.xy), np.int64)
    c = 0
    for s in range(len(g.xy)):
        if lab[s] >= 0:
            continue
        stack = [s]
        lab[s] = c
        while stack:
            a = stack.pop()
            for ei in g.adj.get(a, ()):
                e = g.edges[ei]
                b = e["v"] if e["u"] == a else e["u"]
                if lab[b] < 0:
                    lab[b] = c
                    stack.append(b)
        c += 1
    return lab


def _oriented(e: dict, frm: int) -> np.ndarray:
    return e["coords"] if e["u"] == frm else e["coords"][::-1]


def _heading(p0: np.ndarray, p1: np.ndarray) -> float:
    return math.atan2(p1[1] - p0[1], p1[0] - p0[0])


def random_chain(g: Graph, rng: np.random.Generator, start_edge: int, target_m: float,
                 min_m: float = 500.0) -> tuple[list[int], np.ndarray] | None:
    """One seeded walk starting along start_edge. Returns (edge ids, polyline) or None if < min_m."""
    e0 = g.edges[start_edge]
    frm = e0["u"] if rng.random() < 0.5 else e0["v"]
    used_e, used_n = {start_edge}, {frm}
    seq = [start_edge]
    pts = [_oriented(e0, frm)]
    cur = e0["v"] if frm == e0["u"] else e0["u"]
    used_n.add(cur)
    length = e0["length"]
    while length < target_m:
        last = pts[-1]
        h_in = _heading(last[-2], last[-1]) if len(last) >= 2 else 0.0
        opts, w = [], []
        for ei in g.adj.get(cur, ()):
            if ei in used_e:
                continue
            e = g.edges[ei]
            nxt = e["v"] if e["u"] == cur else e["u"]
            if nxt in used_n:
                continue
            c = _oriented(e, cur)
            turn = abs((_heading(c[0], c[min(len(c) - 1, 3)]) - h_in + math.pi) % (2 * math.pi) - math.pi)
            opts.append((ei, nxt, c))
            w.append(e["weight"] * (1.5 if turn < math.radians(45) else 0.6 if turn > math.radians(120) else 1.0))
        if not opts:
            break
        w = np.asarray(w)
        k = int(rng.choice(len(opts), p=w / w.sum()))
        ei, nxt, c = opts[k]
        seq.append(ei)
        pts.append(c[1:])
        used_e.add(ei)
        used_n.add(nxt)
        length += g.edges[ei]["length"]
        cur = nxt
        if length > target_m * 1.25:
            break
    if length < min_m:
        return None
    return seq, np.vstack(pts)


def trim_polyline(xy: np.ndarray, max_m: float) -> np.ndarray:
    """Cut a polyline to at most max_m along its length."""
    seg = np.hypot(*np.diff(xy, axis=0).T)
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    if cum[-1] <= max_m:
        return xy
    k = int(np.searchsorted(cum, max_m))
    t = (max_m - cum[k - 1]) / max(seg[k - 1], 1e-9)
    end = xy[k - 1] + t * (xy[k] - xy[k - 1])
    return np.vstack([xy[:k], end])


# ----------------------------------------------------------------------------- profiles
def repair_bridges(h: np.ndarray, step_m: float, half_win_m: float = 100.0, drop_m: float = 3.0,
                   bank_grade: float = 0.25) -> tuple[np.ndarray, int]:
    """Bare-earth DTMs drop pathways on bridges/overpasses to the river or road below. Points lower than
    drop_m under the maximum within half_win_m on BOTH sides, in runs bounded by a >= bank_grade step,
    are replaced by linear interpolation between the run edges. Returns (heights, n repaired points)."""
    h = h.copy()
    n = len(h)
    k = max(1, int(round(half_win_m / step_m)))
    swv = np.lib.stride_tricks.sliding_window_view
    left = swv(np.pad(h, (k, 0), mode="edge"), k + 1).max(axis=1)
    right = swv(np.pad(h, (0, k), mode="edge"), k + 1).max(axis=1)
    low = (left - h > drop_m) & (right - h > drop_m)
    if not low.any():
        return h, 0
    grade = np.abs(np.diff(h)) / step_m
    fixed = 0
    i = 0
    while i < n:
        if not low[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and low[j + 1]:
            j += 1
        a, b = max(i - 1, 0), min(j + 1, n - 1)
        steep = grade[max(a - 2, 0):min(b + 2, n - 1)].max() if b > a else 0.0
        if steep >= bank_grade and a < i and b > j:
            h[a:b + 1] = np.linspace(h[a], h[b], b - a + 1)
            fixed += j - i + 1
        i = j + 1
    return h, fixed


def profile_100(h5: np.ndarray, length_m: float, n: int = 100) -> tuple[np.ndarray, np.ndarray]:
    """Heights sampled every ~5 m -> (h100, signed slope deg at n points equally spaced by arc length).
    The 5 m series is box-filtered over ~ds (odd window, anti-aliasing), linearly interpolated at the n
    points, then slope
    = atan(numpy.gradient(h100, ds)) exactly as pipeline.metrics.profile.sample_profile."""
    s5 = np.linspace(0.0, length_m, len(h5))
    s = np.linspace(0.0, length_m, n)
    ds = length_m / (n - 1)
    step = length_m / max(len(h5) - 1, 1)
    k = max(1, int(round(ds / step)))
    k += 1 - k % 2                                  # odd, centred window
    h5 = np.asarray(h5, float)
    hs = h5
    pad = min(k // 2, len(h5) - 1)
    if pad >= 1:   # point-symmetric (odd) padding keeps linear trends exact at the ends
        ext = np.concatenate([2 * h5[0] - h5[pad:0:-1], h5, 2 * h5[-1] - h5[-2:-pad - 2:-1]])
        hs = np.convolve(ext, np.ones(2 * pad + 1) / (2 * pad + 1), mode="valid")
    h100 = np.interp(s, s5, hs)
    slope = np.degrees(np.arctan(np.gradient(h100, ds)))
    return h100, slope


@numba.njit(cache=True)
def dtw_banded(a: np.ndarray, b: np.ndarray, band: int) -> float:
    """DTW with a Sakoe-Chiba band (|i-j| <= band), |a_i - b_j| cost, normalised by path length."""
    n, m = len(a), len(b)
    inf = 1e18
    D = np.full((n + 1, m + 1), inf)
    L = np.zeros((n + 1, m + 1))
    D[0, 0] = 0.0
    for i in range(1, n + 1):
        j0 = max(1, i - band)
        j1 = min(m, i + band)
        for j in range(j0, j1 + 1):
            c = abs(a[i - 1] - b[j - 1])
            best, bl = D[i - 1, j - 1], L[i - 1, j - 1]
            if D[i - 1, j] < best:
                best, bl = D[i - 1, j], L[i - 1, j]
            if D[i, j - 1] < best:
                best, bl = D[i, j - 1], L[i, j - 1]
            D[i, j] = best + c
            L[i, j] = bl + 1.0
    return D[n, m] / max(L[n, m], 1.0)
