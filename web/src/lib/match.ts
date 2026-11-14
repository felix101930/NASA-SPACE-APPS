// Height + slope Euclidean matcher for walk profiles. Mirrors pipeline/walkval/matchers.py
// (`heights_from_slopes`, `Library` scale, `euclid_height_slope`) so the browser ranks walks the same way
// the find-back test measured. Pure functions, shared by the search worker and the check script.

/**
 * Relative height (m, mean removed) from a signed slope profile, by trapezoid-integrating tan(slope)
 * over ds = length / (n - 1). Port of `heights_from_slopes`.
 */
export function heightsFromSlopes(slopeDeg: ArrayLike<number>, lengthM: number, out?: Float64Array): Float64Array {
  const n = slopeDeg.length;
  const h = out ?? new Float64Array(n);
  if (n === 0) return h;
  const ds = lengthM / (n - 1);
  const rad = Math.PI / 180;
  let prevG = Math.tan(slopeDeg[0] * rad);
  h[0] = 0;
  let sum = 0;
  for (let k = 1; k < n; k++) {
    const g = Math.tan(slopeDeg[k] * rad);
    h[k] = h[k - 1] + 0.5 * (g + prevG) * ds;
    prevG = g;
  }
  for (let k = 0; k < n; k++) sum += h[k];
  const mean = sum / n;
  for (let k = 0; k < n; k++) h[k] -= mean;
  return h;
}

/** Net rise (end minus start, m) of the integrated profile: climb - descent for that walk. */
export function netRise(heights: ArrayLike<number>): number {
  return heights.length ? heights[heights.length - 1] - heights[0] : 0;
}

export interface LibraryScale {
  /** Population SD of every relative height in the library (m). */
  sdHeight: number;
  /** Population SD of every slope in the library (deg). */
  sdSlope: number;
}

/** Library spread used to standardise both channels (np.std over all values, ddof 0; 0 -> 1). */
export function libraryScale(slopes: ArrayLike<number>, heights: ArrayLike<number>): LibraryScale {
  const sd = (a: ArrayLike<number>): number => {
    const n = a.length;
    if (!n) return 1;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += a[i];
    mean /= n;
    let v = 0;
    for (let i = 0; i < n; i++) v += (a[i] - mean) ** 2;
    return Math.sqrt(v / n) || 1;
  };
  return { sdHeight: sd(heights), sdSlope: sd(slopes) };
}

export interface PairDistance {
  /** RMS over the 2P standardised values, best of the two walking directions. */
  d: number;
  /** True when the library row matches better walked backwards (ties: as stored, like the worker). */
  reversed: boolean;
}

/**
 * Distance between a query (heights qh, slopes qs) and one library row (heights rh, slopes rs), both
 * standardised by `scale`. Backwards = heights reversed, slopes reversed and negated. Equivalent to
 * `sqrt(min(sa, sb) / (2P))` in `_rms_lib_*` on the concatenated [h / sd_h, s / sd_s] features.
 */
export function heightSlopeDistance(
  qh: ArrayLike<number>,
  qs: ArrayLike<number>,
  rh: ArrayLike<number>,
  rs: ArrayLike<number>,
  scale: LibraryScale,
): PairDistance {
  const P = qs.length;
  const ih = 1 / scale.sdHeight;
  const is = 1 / scale.sdSlope;
  let sa = 0;
  let sb = 0;
  for (let k = 0; k < P; k++) {
    const qhk = qh[k] * ih;
    const qsk = qs[k] * is;
    const fh = qhk - rh[k] * ih;
    const fs = qsk - rs[k] * is;
    const bh = qhk - rh[P - 1 - k] * ih;
    const bs = qsk + rs[P - 1 - k] * is;
    sa += fh * fh + fs * fs;
    sb += bh * bh + bs * bs;
  }
  return { d: Math.sqrt(Math.min(sa, sb) / (2 * P)), reversed: sb < sa };
}
