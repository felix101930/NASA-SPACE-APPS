// Heightfield mesh shared by the 3D comparison screen and the "How we find analogs" explainer.
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { sampleBilinear } from '../lib/terrain';
import type { LoadedTile } from '../data/tiles';

/** Scene units are kilometres. */
export const TERRAIN_KM = 1 / 1000;
const KM = TERRAIN_KM;

export function terrainHeightAt(tile: LoadedTile, col: number, row: number, exag: number): number {
  return (sampleBilinear(tile.filled, col, row) - tile.stats.median) * KM * exag;
}

/** Grid mesh over the tile (x east, z south, y up), heights centred on the tile median. */
export function useTerrainGeometry(tile: LoadedTile, exag: number): THREE.BufferGeometry {
  const geom = useMemo((): THREE.BufferGeometry => {
    const n = tile.filled.size;
    const W = n * tile.filled.res * KM;
    const pos = new Float32Array(n * n * 3);
    const uv = new Float32Array(n * n * 2);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const i = r * n + c;
        pos[i * 3] = (c / (n - 1) - 0.5) * W;
        pos[i * 3 + 2] = (r / (n - 1) - 0.5) * W;
        uv[i * 2] = c / (n - 1);
        uv[i * 2 + 1] = 1 - r / (n - 1);
      }
    }
    const idx = new Uint32Array((n - 1) * (n - 1) * 6);
    let k = 0;
    for (let r = 0; r < n - 1; r++) {
      for (let c = 0; c < n - 1; c++) {
        const a = r * n + c;
        const b = a + 1;
        const d = a + n;
        const e = d + 1;
        idx[k++] = a;
        idx[k++] = d;
        idx[k++] = b;
        idx[k++] = b;
        idx[k++] = d;
        idx[k++] = e;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    return g;
  }, [tile]);

  useMemo((): void => {
    const attr = geom.getAttribute('position');
    if (!(attr instanceof THREE.BufferAttribute)) return;
    const arr = attr.array;
    const d = tile.filled.data;
    const med = tile.stats.median;
    for (let i = 0; i < d.length; i++) arr[i * 3 + 1] = (d[i] - med) * KM * exag;
    attr.needsUpdate = true;
    geom.computeVertexNormals();
    geom.computeBoundingSphere();
  }, [geom, tile, exag]);

  useEffect((): (() => void) => (): void => geom.dispose(), [geom]);
  return geom;
}
