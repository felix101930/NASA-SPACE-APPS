// "Big drop zones" off the main thread (3D side by side): 16 directions × ~250k pixels × 3 bilinear samples per tile.
// The DEM is copied in (the host keeps using it); the D(x) field is transferred back.
import { computeDropZones, type DropZoneResult } from '../lib/dropZones';

export interface DropZoneRequest {
  id: number;
  dem: Float32Array;
  size: number;
  resM: number;
}

export type DropZoneReply =
  | { type: 'result'; id: number; result: DropZoneResult; ms: number }
  | { type: 'error'; id: number; message: string };

self.onmessage = (e: MessageEvent<DropZoneRequest>): void => {
  const { id, dem, size, resM } = e.data;
  try {
    if (dem.length !== size * size) throw new Error(`DEM has ${dem.length} values, expected ${size}×${size}`);
    const t0 = performance.now();
    const result = computeDropZones(dem, size, resM);
    const reply: DropZoneReply = { type: 'result', id, result, ms: performance.now() - t0 };
    self.postMessage(reply, { transfer: [result.field.buffer] });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    self.postMessage({ type: 'error', id, message } satisfies DropZoneReply);
  }
};
