// Pure terrain helpers shared by the web app and the mock generator (no DOM, no Node APIs).

export interface Grid {
  /** Row-major heights in metres, row 0 = north/top. NaN = no data (call fillNaN first for most ops). */
  data: Float32Array;
  size: number;
  /** Metres per pixel. */
  res: number;
}

export interface Stats {
  min: number;
  max: number;
  median: number;
}

/** Replaces NaN with the median of valid samples. Returns a new array plus stats over valid data. */
export function fillNaN(data: Float32Array): { filled: Float32Array; stats: Stats; nanCount: number } {
  const valid: number[] = [];
  for (let i = 0; i < data.length; i += 7) {
    const v = data[i];
    if (Number.isFinite(v)) valid.push(v);
  }
  valid.sort((a: number, b: number): number => a - b);
  const median = valid.length > 0 ? valid[Math.floor(valid.length / 2)] : 0;
  const filled = new Float32Array(data.length);
  let min = Infinity;
  let max = -Infinity;
  let nanCount = 0;
  for (let i = 0; i < data.length; i++) {
    let v = data[i];
    if (!Number.isFinite(v)) {
      v = median;
      nanCount++;
    }
    filled[i] = v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min)) {
    min = 0;
    max = 0;
  }
  return { filled, stats: { min, max, median }, nanCount };
}

/**
 * Bilinear sample at fractional pixel coords (col, row); pixel centres are at integer indices.
 * Mirrors pipeline/metrics/profile.py `_bilinear_clamped` exactly (clamp, i0 <= n-2, NaN propagates).
 */
export function sampleBilinear(g: Grid, col: number, row: number): number {
  const n = g.size;
  const r = Math.min(Math.max(row, 0), n - 1);
  const c = Math.min(Math.max(col, 0), n - 1);
  const i0 = Math.min(Math.floor(r), Math.max(n - 2, 0));
  const j0 = Math.min(Math.floor(c), Math.max(n - 2, 0));
  const i1 = Math.min(i0 + 1, n - 1);
  const j1 = Math.min(j0 + 1, n - 1);
  const p = r - i0;
  const q = c - j0;
  const d = g.data;
  return (
    d[i0 * n + j0] * (1 - p) * (1 - q) +
    d[i1 * n + j0] * p * (1 - q) +
    d[i0 * n + j1] * (1 - p) * q +
    d[i1 * n + j1] * p * q
  );
}

/** Unit vector (in pixel space) pointing toward the sun azimuth (clockwise from north, north = -row). */
export function azToPixelDir(azDeg: number): { dc: number; dr: number } {
  const a = (azDeg * Math.PI) / 180;
  return { dc: Math.sin(a), dr: -Math.cos(a) };
}

/**
 * Cast-shadow mask by ray marching toward the sun. Returns 1 for shadowed pixels, 0 for lit.
 * Includes self-shadowing (sun below local slope) via the first march step.
 */
export function computeShadowMask(g: Grid, elDeg: number, azDeg: number, maxDistPx: number = 400): Uint8Array {
  const n = g.size;
  const out = new Uint8Array(n * n);
  const { dc, dr } = azToPixelDir(azDeg);
  const rise = Math.tan((elDeg * Math.PI) / 180) * g.res;
  let gmax = -Infinity;
  for (let i = 0; i < g.data.length; i++) if (g.data[i] > gmax) gmax = g.data[i];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const h0 = g.data[r * n + c];
      let shadow = 0;
      for (let k = 1; k <= maxDistPx; k++) {
        const cc = c + dc * k;
        const rr = r + dr * k;
        if (cc < 0 || rr < 0 || cc > n - 1 || rr > n - 1) break;
        const ray = h0 + rise * k;
        if (ray > gmax) break;
        if (sampleBilinear(g, cc, rr) > ray) {
          shadow = 1;
          break;
        }
      }
      out[r * n + c] = shadow;
    }
  }
  return out;
}

/** Classic Lambertian hillshade, 0..255. */
export function hillshade(g: Grid, azDeg: number, elDeg: number, zFactor: number = 1): Uint8ClampedArray {
  const n = g.size;
  const out = new Uint8ClampedArray(n * n);
  const az = (azDeg * Math.PI) / 180;
  const zen = ((90 - elDeg) * Math.PI) / 180;
  const d = g.data;
  const at = (r: number, c: number): number =>
    d[Math.min(Math.max(r, 0), n - 1) * n + Math.min(Math.max(c, 0), n - 1)];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const dzdx = ((at(r, c + 1) - at(r, c - 1)) / (2 * g.res)) * zFactor;
      const dzdy = ((at(r - 1, c) - at(r + 1, c)) / (2 * g.res)) * zFactor; // +y = north
      const slope = Math.atan(Math.hypot(dzdx, dzdy));
      // aspect measured clockwise from north, direction the slope faces (downhill)
      const aspect = Math.atan2(-dzdx, -dzdy);
      const v = Math.cos(zen) * Math.cos(slope) + Math.sin(zen) * Math.sin(slope) * Math.cos(az - aspect);
      out[r * n + c] = Math.round(Math.max(0, v) * 235 + 12);
    }
  }
  return out;
}

/** Resample a (distance, value) series to n evenly spaced samples over [0, totalLength]. */
export function resampleEven(dist: number[], vals: number[], n: number): number[] {
  const total = dist[dist.length - 1];
  const out: number[] = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : (total * i) / (n - 1);
    while (j < dist.length - 2 && dist[j + 1] < t) j++;
    const d0 = dist[j];
    const d1 = dist[j + 1] ?? d0;
    const f = d1 > d0 ? (t - d0) / (d1 - d0) : 0;
    out.push(vals[j] * (1 - Math.min(Math.max(f, 0), 1)) + (vals[j + 1] ?? vals[j]) * Math.min(Math.max(f, 0), 1));
  }
  return out;
}

export interface WalkProfile {
  /** n signed slopes in degrees along the path (numpy.gradient convention). */
  slopes: number[];
  /** n heights (m) at points equally spaced by arc length. */
  heights: number[];
  /** n map coordinates of the resampled points. */
  xy: [number, number][];
  length_m: number;
  climb_m: number;
  descent_m: number;
  max_slope_deg: number;
  /** True when any sample touched a NaN (no-data) pixel. */
  hasNaN: boolean;
}

/** Map coords -> fractional pixel coords (origin = top-left CORNER of pixel (0,0), centres at +0.5). */
export function mapToPixel(x: number, y: number, originX: number, originY: number, res: number): [number, number] {
  return [(x - originX) / res - 0.5, (originY - y) / res - 0.5];
}

/** Fractional pixel coords -> map coords (inverse of mapToPixel). */
export function pixelToMap(col: number, row: number, originX: number, originY: number, res: number): [number, number] {
  return [originX + (col + 0.5) * res, originY - (row + 0.5) * res];
}

/**
 * Port of pipeline/metrics/profile.py `sample_profile`, kept line-for-line equivalent:
 * 1. resample the polyline (map metres) to n points equally spaced by arc length (endpoints included);
 * 2. bilinear heights, clamped to the pixel-centre hull, NaN neighbours propagate;
 * 3. signed slope = atan(gradient(h, ds)) in degrees, central differences inside, one-sided at the ends;
 * 4. climb/descent from successive height differences, max |slope|.
 * Pass the RAW grid (not NaN-filled) so NaN behaviour matches the pipeline.
 */
export function sampleProfile(
  g: Grid,
  originX: number,
  originY: number,
  polylineXY: [number, number][],
  n: number = 100,
): WalkProfile | null {
  if (polylineXY.length < 2 || n < 2) return null;
  const cum: number[] = [0];
  for (let i = 1; i < polylineXY.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(polylineXY[i][0] - polylineXY[i - 1][0], polylineXY[i][1] - polylineXY[i - 1][1]));
  }
  const length = cum[cum.length - 1];
  if (!(length > 0)) return null;
  const xy: [number, number][] = [];
  const heights: number[] = [];
  let seg = 0;
  for (let k = 0; k < n; k++) {
    const s = (length * k) / (n - 1);
    while (seg < cum.length - 2 && cum[seg + 1] < s) seg++;
    const a = cum[seg];
    const b = cum[seg + 1];
    const f = b > a ? Math.min(Math.max((s - a) / (b - a), 0), 1) : 0;
    const x = polylineXY[seg][0] + (polylineXY[seg + 1][0] - polylineXY[seg][0]) * f;
    const y = polylineXY[seg][1] + (polylineXY[seg + 1][1] - polylineXY[seg][1]) * f;
    xy.push([x, y]);
    const [col, row] = mapToPixel(x, y, originX, originY, g.res);
    heights.push(sampleBilinear(g, col, row));
  }
  const ds = length / (n - 1);
  const slopes: number[] = [];
  for (let i = 0; i < n; i++) {
    let grad: number;
    if (i === 0) grad = (heights[1] - heights[0]) / ds;
    else if (i === n - 1) grad = (heights[n - 1] - heights[n - 2]) / ds;
    else grad = (heights[i + 1] - heights[i - 1]) / (2 * ds);
    slopes.push((Math.atan(grad) * 180) / Math.PI);
  }
  let climb = 0;
  let descent = 0;
  let hasNaN = false;
  for (let i = 1; i < n; i++) {
    const dh = heights[i] - heights[i - 1];
    if (Number.isNaN(dh)) {
      hasNaN = true;
      continue;
    }
    if (dh > 0) climb += dh;
    else descent -= dh;
  }
  let maxSlope = 0;
  for (const v of slopes) if (Number.isFinite(v) && Math.abs(v) > maxSlope) maxSlope = Math.abs(v);
  if (heights.some((h: number): boolean => Number.isNaN(h))) hasNaN = true;
  return { slopes, heights, xy, length_m: length, climb_m: climb, descent_m: descent, max_slope_deg: maxSlope, hasNaN };
}
