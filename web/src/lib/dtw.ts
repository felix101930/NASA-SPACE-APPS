// Banded dynamic time warping (Sakoe-Chiba) on equal-length 1-D series. Pure, shared by worker and mock generator.

export function zNormalise(a: ArrayLike<number>): Float64Array {
  const n = a.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += a[i];
  mean /= n;
  let v = 0;
  for (let i = 0; i < n; i++) v += (a[i] - mean) ** 2;
  const sd = Math.sqrt(v / n) || 1;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = (a[i] - mean) / sd;
  return out;
}

/**
 * Mean absolute DTW cost along the warping path (units of the input, e.g. degrees).
 * Returns Infinity when early-abandoned against `abandonAbove` (also a per-step mean).
 */
export function dtwBanded(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  bandFrac: number = 0.1,
  abandonAbove: number = Infinity,
): number {
  const n = a.length;
  const m = b.length;
  const w = Math.max(1, Math.ceil(bandFrac * Math.max(n, m)), Math.abs(n - m));
  let prev = new Float64Array(m + 1).fill(Infinity);
  let cur = new Float64Array(m + 1).fill(Infinity);
  prev[0] = 0;
  const limit = abandonAbove * (n + m);
  for (let i = 1; i <= n; i++) {
    cur.fill(Infinity);
    const jStart = Math.max(1, i - w);
    const jEnd = Math.min(m, i + w);
    let rowMin = Infinity;
    for (let j = jStart; j <= jEnd; j++) {
      const cost = Math.abs(a[i - 1] - b[j - 1]);
      const best = Math.min(prev[j], prev[j - 1], cur[j - 1]);
      const v = cost + best;
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > limit) return Infinity;
    const t = prev;
    prev = cur;
    cur = t;
  }
  // Normalise by the max path length bound so values read as "average degrees of mismatch".
  return prev[m] / Math.max(n, m);
}
