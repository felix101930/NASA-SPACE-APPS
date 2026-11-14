// Banded DTW search over walk/transects.bin rows, off the main thread.
import { dtwBanded, zNormalise } from '../lib/dtw';

export interface InitMsg {
  type: 'init';
  bin: ArrayBuffer;
  points: number;
}

export interface QueryMsg {
  type: 'query';
  id: number;
  query: number[];
  candidates: number[];
  band: number;
  znorm: boolean;
  topK: number;
}

export interface ResultRow {
  i: number;
  dtw: number;
  /** True when the Earth transect matched best walked in the opposite direction. */
  reversed: boolean;
}

export type WorkerReply =
  | { type: 'ready'; n: number }
  | { type: 'result'; id: number; results: ResultRow[]; searched: number; ms: number }
  | { type: 'error'; message: string };

let rows: Float32Array | null = null;
let P = 100;

interface WorkerScope {
  postMessage(m: WorkerReply): void;
  onmessage: ((ev: MessageEvent<InitMsg | QueryMsg>) => void) | null;
}
const ctx = self as unknown as WorkerScope;

function reply(m: WorkerReply): void {
  ctx.postMessage(m);
}

ctx.onmessage = (ev: MessageEvent<InitMsg | QueryMsg>): void => {
  const msg = ev.data;
  try {
    if (msg.type === 'init') {
      rows = new Float32Array(msg.bin);
      P = msg.points;
      reply({ type: 'ready', n: rows.length / P });
      return;
    }
    if (!rows) throw new Error('worker not initialised');
    const t0 = performance.now();
    const q = msg.znorm ? zNormalise(msg.query) : Float64Array.from(msg.query);
    const best: ResultRow[] = [];
    let worst = Infinity;
    const rev = new Float64Array(P);
    for (const i of msg.candidates) {
      const raw = rows.subarray(i * P, (i + 1) * P);
      const fwd = msg.znorm ? zNormalise(raw) : raw;
      // Same path walked backwards: reverse order and flip the slope sign.
      for (let k = 0; k < P; k++) rev[k] = -raw[P - 1 - k];
      const bwd = msg.znorm ? zNormalise(rev) : rev;
      const limit = best.length < msg.topK ? Infinity : worst;
      const a = dtwBanded(q, fwd, msg.band, limit);
      const b = dtwBanded(q, bwd, msg.band, Math.min(limit, a));
      const d = Math.min(a, b);
      if (!Number.isFinite(d)) continue;
      if (best.length < msg.topK || d < worst) {
        best.push({ i, dtw: d, reversed: b < a });
        best.sort((x: ResultRow, y: ResultRow): number => x.dtw - y.dtw);
        if (best.length > msg.topK) best.pop();
        worst = best.length === msg.topK ? best[best.length - 1].dtw : Infinity;
      }
    }
    reply({ type: 'result', id: msg.id, results: best, searched: msg.candidates.length, ms: performance.now() - t0 });
  } catch (e: unknown) {
    reply({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};
