// Walk search over walk/transects.bin rows, off the main thread.
// Default matcher: Euclidean on relative height + slope (see lib/match.ts, mirrors pipeline/walkval/matchers.py),
// scanning every row in both directions. Optional: banded DTW on slope for clearly stretched routes.
import { dtwBanded } from '../lib/dtw';
import { heightsFromSlopes, heightSlopeDistance, libraryScale, type LibraryScale } from '../lib/match';

export type Matcher = 'height_slope' | 'dtw';

export interface InitMsg {
  type: 'init';
  bin: ArrayBuffer;
  points: number;
  /** Walk length (m) per row, indexed by row. */
  lengths: Float64Array;
}

export interface QueryMsg {
  type: 'query';
  id: number;
  matcher: Matcher;
  query: number[];
  /** Length of the query walk (m), for the height reconstruction. */
  lengthM: number;
  /** Rows to score; null = every row. */
  candidates: number[] | null;
  band: number;
  topK: number;
}

export interface ResultRow {
  i: number;
  /** Matcher distance: standardised RMS for height_slope, mean degrees of mismatch for dtw. Smaller = closer. */
  dist: number;
  /** True when the Earth transect matched best walked in the opposite direction. */
  reversed: boolean;
}

export type WorkerReply =
  | { type: 'ready'; n: number }
  | { type: 'result'; id: number; results: ResultRow[]; searched: number; ms: number }
  | { type: 'error'; message: string };

let rows: Float32Array | null = null;
let heights: Float32Array | null = null;
let scale: LibraryScale = { sdHeight: 1, sdSlope: 1 };
let P = 100;
let N = 0;
let allIds: Int32Array = new Int32Array(0);

interface WorkerScope {
  postMessage(m: WorkerReply): void;
  onmessage: ((ev: MessageEvent<InitMsg | QueryMsg>) => void) | null;
}
const ctx = self as unknown as WorkerScope;

function reply(m: WorkerReply): void {
  ctx.postMessage(m);
}

function init(msg: InitMsg): void {
  rows = new Float32Array(msg.bin);
  P = msg.points;
  N = Math.floor(rows.length / P);
  // Earth transects store only slopes: rebuild relative heights once, then take the library spread.
  heights = new Float32Array(N * P);
  const tmp = new Float64Array(P);
  for (let i = 0; i < N; i++) {
    heightsFromSlopes(rows.subarray(i * P, (i + 1) * P), msg.lengths[i] ?? 0, tmp);
    heights.set(tmp, i * P);
  }
  scale = libraryScale(rows, heights);
  allIds = Int32Array.from({ length: N }, (_: unknown, i: number): number => i);
  reply({ type: 'ready', n: N });
}

class TopK {
  readonly best: ResultRow[] = [];
  worst = Infinity;
  private readonly k: number;
  constructor(k: number) {
    this.k = k;
  }
  offer(r: ResultRow): void {
    if (this.best.length >= this.k && r.dist >= this.worst) return;
    this.best.push(r);
    this.best.sort((x: ResultRow, y: ResultRow): number => x.dist - y.dist);
    if (this.best.length > this.k) this.best.pop();
    this.worst = this.best.length === this.k ? this.best[this.best.length - 1].dist : Infinity;
  }
}

function query(msg: QueryMsg): ResultRow[] {
  if (!rows || !heights) throw new Error('worker not initialised');
  const top = new TopK(msg.topK);
  const ids: ArrayLike<number> = msg.candidates ?? allIds;
  if (msg.matcher === 'height_slope') {
    const qs = Float64Array.from(msg.query);
    const qh = heightsFromSlopes(qs, msg.lengthM);
    for (let n = 0; n < ids.length; n++) {
      const i = ids[n];
      const r = heightSlopeDistance(qh, qs, heights.subarray(i * P, (i + 1) * P), rows.subarray(i * P, (i + 1) * P), scale);
      if (Number.isFinite(r.d)) top.offer({ i, dist: r.d, reversed: r.reversed });
    }
    return top.best;
  }
  const q = Float64Array.from(msg.query);
  const rev = new Float64Array(P);
  for (let n = 0; n < ids.length; n++) {
    const i = ids[n];
    const raw = rows.subarray(i * P, (i + 1) * P);
    // Same path walked backwards: reverse order and flip the slope sign.
    for (let k = 0; k < P; k++) rev[k] = -raw[P - 1 - k];
    const limit = top.best.length < msg.topK ? Infinity : top.worst;
    const a = dtwBanded(q, raw, msg.band, limit);
    const b = dtwBanded(q, rev, msg.band, Math.min(limit, a));
    const d = Math.min(a, b);
    if (Number.isFinite(d)) top.offer({ i, dist: d, reversed: b < a });
  }
  return top.best;
}

ctx.onmessage = (ev: MessageEvent<InitMsg | QueryMsg>): void => {
  const msg = ev.data;
  try {
    if (msg.type === 'init') {
      init(msg);
      return;
    }
    const t0 = performance.now();
    const results = query(msg);
    reply({ type: 'result', id: msg.id, results, searched: msg.candidates ? msg.candidates.length : N, ms: performance.now() - t0 });
  } catch (e: unknown) {
    reply({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};
