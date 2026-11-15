// "Big drop zones": how much the ground height changes over 1 km, per pixel, for the 3D side-by-side overlay.
// Pure computation (no DOM, no imports) so it runs in workers/dropZones.worker.ts and in scripts/check-dropzones.ts.
//
// Definition (same as pipeline/metrics/rim.py `jump_samples`): for 16 directions spread evenly over 180° (θ = π·k/16,
// clockwise from grid north = −row), a 1 km pair is (p, p + L·u) with L = 1000 m / res (33.3 px at 30 m) and the
// partner height bilinear. Only pairs with both ends inside the tile count; pairs touching a NaN are dropped.
//
// Three outputs:
//  - `p95` / `p99`: percentiles of every such pair pooled over the tile, with the pair STARTING at each pixel.
//    This is exactly rim.py's sample set, so `p95` equals jump1km_p95_m in regions.json / matches.json lights.
//  - `field` D(x): max over the 16 directions of |h(x + L/2·u) − h(x − L/2·u)|, i.e. the pair CENTRED on x. Centred
//    reads better on a map (the colour sits on the slope itself, not 1 km uphill of it). Same 1 km baseline and
//    directions; NaN where no direction fits inside the tile or every pair touches a NaN.
//  - `top`: the biggest 1 km height changes, picked greedily from the starting-pair samples (like the pipeline's
//    annotations `rim_drops` and terrain3d/data.ts `findRimSegs`): best direction per pixel, sorted by |Δh|, a pick is
//    skipped if its midpoint lies within 1.5 km of an earlier pick (so 1 km segments never overlap). Start = high end.
//
// Pixel coordinates are (col, row) with pixel centres at integer indices (row 0 = tile top), as the 3D mesh uses.
//
// Speed: the partner offset (dr, dc) is the same for every pixel in one direction, so the bilinear weights and index
// offsets are constants per direction; the whole thing is a few flat loops over the grid (~10^7 multiply-adds).

export interface DropSegment {
  rank: number;
  /** High end, [col, row]. */
  start: [number, number];
  /** Low end, [col, row]. */
  end: [number, number];
  /** |Δh| over the 1 km segment, metres. */
  absDh: number;
}

export interface DropZoneOptions {
  baselineM?: number;
  nDirs?: number;
  minSepM?: number;
  topN?: number;
}

export interface DropZoneResult {
  size: number;
  /** D(x), metres, row-major from the tile top-left; NaN = no valid pair. */
  field: Float32Array;
  /** 95th / 99th percentile of all pooled starting pairs (rim.py jump1km_p95_m / jump1km_p99_m). */
  p95: number;
  p99: number;
  /** 99th percentile of the D(x) field: the per-pane candidate for the shared colour scale maximum. */
  fieldP99: number;
  top: DropSegment[];
  /** Number of pooled pairs behind p95 / p99. */
  samples: number;
}

/** Constant bilinear stencil for one pixel offset (dr, dc). */
interface Stencil {
  /** Offset to the top-left neighbour, flat index. */
  base: number;
  /** +1 if a second column is needed (fractional dc), else 0. */
  dCol: number;
  /** +size if a second row is needed (fractional dr), else 0. */
  dRow: number;
  w00: number;
  w01: number;
  w10: number;
  w11: number;
}

function stencil(dr: number, dc: number, n: number): Stencil {
  const r0 = Math.floor(dr);
  const c0 = Math.floor(dc);
  const fr = dr - r0;
  const fc = dc - c0;
  return {
    base: r0 * n + c0,
    dCol: fc > 0 ? 1 : 0,
    dRow: fr > 0 ? n : 0,
    w00: (1 - fr) * (1 - fc),
    w01: (1 - fr) * fc,
    w10: fr * (1 - fc),
    w11: fr * fc,
  };
}

/** Bilinear height at pixel index i + stencil offset (NaN propagates, like scipy map_coordinates). */
function sampleAt(z: Float32Array, i: number, s: Stencil): number {
  const j = i + s.base;
  return z[j] * s.w00 + z[j + s.dCol] * s.w01 + z[j + s.dRow] * s.w10 + z[j + s.dRow + s.dCol] * s.w11;
}

/** Inclusive index range [lo, hi] of integer x in [0, n−1] with x + d also in [0, n−1] (float test, as rim.py). */
function validRange(d: number, n: number): [number, number] {
  let lo = 0;
  while (lo < n && lo + d < 0) lo++;
  let hi = n - 1;
  while (hi >= 0 && hi + d > n - 1) hi--;
  return [lo, hi];
}

/** Partially sorts a[lo..hi] so a[k] is the k-th smallest and everything after k is >= a[k]. */
function select(a: Float32Array, k: number, lo: number, hi: number): void {
  let l = lo;
  let r = hi;
  while (r > l) {
    const m = (l + r) >>> 1;
    // Median of three as the pivot.
    if (a[m] < a[l]) swap(a, m, l);
    if (a[r] < a[l]) swap(a, r, l);
    if (a[r] < a[m]) swap(a, r, m);
    const pivot = a[m];
    let i = l;
    let j = r;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) {
        swap(a, i, j);
        i++;
        j--;
      }
    }
    if (k <= j) r = j;
    else if (k >= i) l = i;
    else return;
  }
}

function swap(a: Float32Array, i: number, j: number): void {
  const t = a[i];
  a[i] = a[j];
  a[j] = t;
}

/**
 * Percentiles with numpy's default linear interpolation, on the first `count` entries of `a` (reordered in place).
 * `qs` must be ascending, each in [0, 1].
 */
export function percentilesInPlace(a: Float32Array, count: number, qs: number[]): number[] {
  if (count === 0) return qs.map((): number => Number.NaN);
  const out: number[] = [];
  let from = 0;
  for (const q of qs) {
    const pos = q * (count - 1);
    const k = Math.floor(pos);
    select(a, k, from, count - 1);
    let v = a[k];
    if (pos > k) {
      let next = Infinity;
      for (let i = k + 1; i < count; i++) if (a[i] < next) next = a[i];
      v += (pos - k) * (next - v);
    }
    out.push(v);
    from = k;
  }
  return out;
}

export function computeDropZones(dem: Float32Array, size: number, resM: number, opts: DropZoneOptions = {}): DropZoneResult {
  const baselineM = opts.baselineM ?? 1000;
  const nDirs = opts.nDirs ?? 16;
  const minSepM = opts.minSepM ?? 1500;
  const topN = opts.topN ?? 3;
  const n = size;
  const z = dem;
  const lag = baselineM / resM;

  const pooled = new Float32Array(nDirs * n * n);
  let count = 0;
  const best = new Float32Array(n * n);
  const bestDir = new Int8Array(n * n).fill(-1);
  const bestUp = new Uint8Array(n * n);
  const field = new Float32Array(n * n).fill(Number.NaN);
  const dirs: { dr: number; dc: number }[] = [];

  for (let k = 0; k < nDirs; k++) {
    const th = (Math.PI * k) / nDirs;
    const dr = -Math.cos(th) * lag;
    const dc = Math.sin(th) * lag;
    dirs.push({ dr, dc });

    // Starting pairs (p, p + L·u): pooled samples + per-pixel best for the segment picks.
    const s = stencil(dr, dc, n);
    const [r0, r1] = validRange(dr, n);
    const [c0, c1] = validRange(dc, n);
    for (let r = r0; r <= r1; r++) {
      const row = r * n;
      for (let c = c0; c <= c1; c++) {
        const i = row + c;
        const dh = sampleAt(z, i, s) - z[i];
        if (dh !== dh) continue; // NaN
        const a = dh < 0 ? -dh : dh;
        pooled[count++] = a;
        if (a > best[i]) {
          best[i] = a;
          bestDir[i] = k;
          bestUp[i] = dh > 0 ? 1 : 0;
        }
      }
    }

    // Centred pairs (x − L/2·u, x + L/2·u) for the colour field.
    const sa = stencil(-dr / 2, -dc / 2, n);
    const sb = stencil(dr / 2, dc / 2, n);
    const [ra0, ra1] = validRange(-dr / 2, n);
    const [rb0, rb1] = validRange(dr / 2, n);
    const [ca0, ca1] = validRange(-dc / 2, n);
    const [cb0, cb1] = validRange(dc / 2, n);
    const rLo = Math.max(ra0, rb0);
    const rHi = Math.min(ra1, rb1);
    const cLo = Math.max(ca0, cb0);
    const cHi = Math.min(ca1, cb1);
    for (let r = rLo; r <= rHi; r++) {
      const row = r * n;
      for (let c = cLo; c <= cHi; c++) {
        const i = row + c;
        const dh = sampleAt(z, i, sb) - sampleAt(z, i, sa);
        if (dh !== dh) continue;
        const a = dh < 0 ? -dh : dh;
        const cur = field[i];
        if (cur !== cur || a > cur) field[i] = a;
      }
    }
  }

  const [p95, p99] = percentilesInPlace(pooled, count, [0.95, 0.99]);

  // P99 of the field (copy: the field itself is returned untouched).
  const fv = new Float32Array(n * n);
  let fc = 0;
  for (let i = 0; i < field.length; i++) {
    const v = field[i];
    if (v === v) fv[fc++] = v;
  }
  const [fieldP99] = percentilesInPlace(fv, fc, [0.99]);

  const top = pickSegments(best, bestDir, bestUp, dirs, n, minSepM / resM, topN);
  return { size: n, field, p95, p99, fieldP99, top, samples: count };
}

/** Greedy top-|Δh| picks with midpoints at least `sepPx` apart; start = high end. */
function pickSegments(
  best: Float32Array,
  bestDir: Int8Array,
  bestUp: Uint8Array,
  dirs: { dr: number; dc: number }[],
  n: number,
  sepPx: number,
  topN: number,
): DropSegment[] {
  const run = (minValue: number): DropSegment[] | null => {
    const cand: number[] = [];
    for (let i = 0; i < best.length; i++) if (bestDir[i] >= 0 && best[i] > 0 && best[i] >= minValue) cand.push(i);
    cand.sort((a: number, b: number): number => best[b] - best[a] || a - b);
    const picks: DropSegment[] = [];
    const mids: [number, number][] = [];
    for (const i of cand) {
      if (picks.length >= topN) break;
      const r = Math.floor(i / n);
      const c = i - r * n;
      const d = dirs[bestDir[i]];
      const pc = c + d.dc;
      const pr = r + d.dr;
      const mc = (c + pc) / 2;
      const mr = (r + pr) / 2;
      if (mids.some(([x, y]: [number, number]): boolean => Math.hypot(x - mc, y - mr) < sepPx)) continue;
      mids.push([mc, mr]);
      const self: [number, number] = [c, r];
      const partner: [number, number] = [pc, pr];
      const up = bestUp[i] === 1;
      picks.push({ rank: picks.length + 1, start: up ? partner : self, end: up ? self : partner, absDh: best[i] });
    }
    // Only trust a truncated candidate list if it produced every pick.
    return picks.length >= topN || minValue <= 0 ? picks : null;
  };
  // Sorting all ~250k pixels is the slow part; the top 2% almost always holds the picks. Fall back to everything.
  const vals = new Float32Array(best.length);
  let m = 0;
  for (let i = 0; i < best.length; i++) if (bestDir[i] >= 0) vals[m++] = best[i];
  const [cut] = percentilesInPlace(vals, m, [0.98]);
  return run(Number.isFinite(cut) ? cut : 0) ?? run(0) ?? [];
}

/** 0..1 strength of the hazard tint for a D value: none below 20% of the scale, smooth ramp to full at the max. */
export function dropTint(d: number, scaleMax: number): number {
  if (!(d === d) || !(scaleMax > 0)) return 0;
  const t = Math.min(1, Math.max(0, (d / scaleMax - 0.2) / 0.8));
  return t * t * (3 - 2 * t);
}
