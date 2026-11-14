// Cast-shadow ray marching off the main thread (3D side by side). A full mask is up to ~10^8 height samples, which
// blocked the page for hundreds of milliseconds per sun change when it ran inline, so the sun sweep stalled.
import { computeShadowMask, type Grid } from '../lib/terrain';

export interface GridMsg {
  type: 'grid';
  key: number;
  data: Float32Array;
  size: number;
  res: number;
}

export interface ComputeMsg {
  type: 'frac' | 'mask';
  id: number;
  key: number;
  el: number;
  az: number;
  maxDist: number;
}

export type ShadowRequest = GridMsg | ComputeMsg;

export type ShadowReply =
  | { type: 'frac'; id: number; key: number; el: number; az: number; frac: number }
  | { type: 'mask'; id: number; key: number; el: number; az: number; mask: Uint8Array; size: number }
  | { type: 'error'; id: number; message: string };

const grids = new Map<number, Grid>();

self.onmessage = (e: MessageEvent<ShadowRequest>): void => {
  const msg = e.data;
  if (msg.type === 'grid') {
    grids.set(msg.key, { data: msg.data, size: msg.size, res: msg.res });
    // Keep only the most recent few tiles (each pane sends one or two).
    if (grids.size > 4) {
      const oldest = grids.keys().next().value;
      if (oldest !== undefined) grids.delete(oldest);
    }
    return;
  }
  const g = grids.get(msg.key);
  if (!g) {
    self.postMessage({ type: 'error', id: msg.id, message: 'grid not loaded' } satisfies ShadowReply);
    return;
  }
  const m = computeShadowMask(g, msg.el, msg.az, msg.maxDist);
  if (msg.type === 'frac') {
    let k = 0;
    for (let i = 0; i < m.length; i++) k += m[i];
    self.postMessage({ type: 'frac', id: msg.id, key: msg.key, el: msg.el, az: msg.az, frac: k / m.length } satisfies ShadowReply);
  } else {
    const reply: ShadowReply = { type: 'mask', id: msg.id, key: msg.key, el: msg.el, az: msg.az, mask: m, size: g.size };
    self.postMessage(reply, { transfer: [m.buffer] });
  }
};
