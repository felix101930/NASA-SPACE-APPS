import { fillNaN, type Grid, type Stats } from '../lib/terrain';
import type { TileRef } from '../types/contract';
import { loadFloat32, type Origin } from './loader';

export interface LoadedTile {
  /** Raw grid (NaN = no data), for profile sampling that must match the pipeline. */
  raw: Grid;
  /** NaN-filled grid for rendering and shadow casting. */
  filled: Grid;
  stats: Stats;
  nanCount: number;
  ref: TileRef;
}

const cache = new Map<string, Promise<LoadedTile>>();

export function loadTile(ref: TileRef, prefer: Origin): Promise<LoadedTile> {
  const key = ref.path;
  const hit = cache.get(key);
  if (hit) return hit;
  const p = loadFloat32(ref.path, ref.size * ref.size, prefer).then((l: { value: Float32Array }): LoadedTile => {
    const { filled, stats, nanCount } = fillNaN(l.value);
    return {
      raw: { data: l.value, size: ref.size, res: ref.res_m },
      filled: { data: filled, size: ref.size, res: ref.res_m },
      stats,
      nanCount,
      ref,
    };
  });
  cache.set(key, p);
  p.catch((): void => {
    cache.delete(key);
  });
  return p;
}
