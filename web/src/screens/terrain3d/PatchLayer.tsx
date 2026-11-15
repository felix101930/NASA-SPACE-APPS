// "Show the 25 patches" on a 3D pane: the 15 km tile's 5 × 5 patches of 3 km as thin draped grid lines, a tint
// per patch (the PatchGrid colour scale, shared by both panes) and small value labels as plain DOM elements moved
// to their projected anchors (no drei <Html>). Geometry depends only on tile + exaggeration, never on the sun, so
// the sun sweep rebuilds nothing; everything is disposed when it changes or unmounts.
import { useEffect, useMemo, useRef, type JSX, type MutableRefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { tileToScene } from '../../components/terrainGeometry';
import { fmtPatch, PATCH_N, patchRGB, scaleT, type PatchUnit } from '../../lib/patchScale';
import type { LoadedTile } from '../../data/tiles';
import type { HazardId } from '../../types/contract';

export interface PatchLayerData {
  /** 25 values, row-major from the tile's top-left (row 0 = tile top = -z in the scene). */
  values: number[];
  unit: PatchUnit;
  scaleMin: number;
  scaleMax: number;
  hazard: HazardId;
}

const LINE_LIFT = 0.03;
const LABEL_LIFT = 0.12;
const LINE_STEP_PX = 2;
/** Label box used for overlap checks (px): wide enough for "100%" / "1,234" at 11 px mono. */
const LABEL_W = 38;
const LABEL_H = 18;
/** Strength of the multiply tint (0 = none, 1 = full patch colour). */
export const PATCH_TINT_OPACITY = 0.6;

/** 5 × 5 RGBA texture of the patch colours. UV v runs bottom-up, so block row i goes to texture row 4 − i. */
export function usePatchTexture(data: PatchLayerData | null): THREE.DataTexture | null {
  const tex = useMemo((): THREE.DataTexture | null => {
    if (!data) return null;
    const px = new Uint8Array(PATCH_N * PATCH_N * 4);
    data.values.forEach((v: number, k: number): void => {
      const i = Math.floor(k / PATCH_N);
      const j = k % PATCH_N;
      const o = ((PATCH_N - 1 - i) * PATCH_N + j) * 4;
      const [r, g, b] = patchRGB(scaleT(v, data.scaleMin, data.scaleMax), data.hazard);
      px[o] = r;
      px[o + 1] = g;
      px[o + 2] = b;
      px[o + 3] = Number.isFinite(v) ? 255 : 0;
    });
    const t = new THREE.DataTexture(px, PATCH_N, PATCH_N, THREE.RGBAFormat);
    t.colorSpace = THREE.SRGBColorSpace;
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  }, [data]);
  useEffect((): (() => void) => (): void => tex?.dispose(), [tex]);
  return tex;
}

/** Pixel coordinate of patch boundary k (0..5): between pixels k·100 − 1 and k·100, clamped to the tile. */
function boundary(k: number, n: number): number {
  return Math.min(n - 1, Math.max(0, (k * n) / PATCH_N - 0.5));
}

/** Thin grid lines draped on the terrain: 6 rows + 6 columns, one draw call. */
export function PatchLines({ tile, exag }: { tile: LoadedTile; exag: number }): JSX.Element {
  const geom = useMemo((): THREE.BufferGeometry => {
    const n = tile.filled.size;
    const pts: number[] = [];
    const push = (c: number, r: number): void => {
      const p = tileToScene(tile, c, r, exag, LINE_LIFT);
      pts.push(p[0], p[1], p[2]);
    };
    for (let k = 0; k <= PATCH_N; k++) {
      const b = boundary(k, n);
      for (let s = 0; s < n - 1; s += LINE_STEP_PX) {
        const e = Math.min(n - 1, s + LINE_STEP_PX);
        push(s, b);
        push(e, b);
        push(b, s);
        push(b, e);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, [tile, exag]);
  useEffect((): (() => void) => (): void => geom.dispose(), [geom]);
  return (
    <lineSegments geometry={geom} renderOrder={2}>
      <lineBasicMaterial color="#edeae4" transparent opacity={0.8} depthWrite={false} toneMapped={false} />
    </lineSegments>
  );
}

/** Label anchors: the centre of each patch, a little above the surface. */
export function patchAnchors(tile: LoadedTile, exag: number): [number, number, number][] {
  const n = tile.filled.size;
  return Array.from({ length: PATCH_N * PATCH_N }, (_: unknown, k: number): [number, number, number] => {
    const c = ((k % PATCH_N) + 0.5) * (n / PATCH_N) - 0.5;
    const r = (Math.floor(k / PATCH_N) + 0.5) * (n / PATCH_N) - 0.5;
    return tileToScene(tile, c, r, exag, LABEL_LIFT);
  });
}

/** Moves the DOM labels to their projected anchors; only writes when the camera, size or anchors change. */
export function PatchLabelProjector({
  anchors,
  els,
}: {
  anchors: [number, number, number][];
  els: MutableRefObject<(HTMLSpanElement | null)[]>;
}): null {
  const camera = useThree((st) => st.camera);
  const size = useThree((st) => st.size);
  const v = useMemo((): THREE.Vector3 => new THREE.Vector3(), []);
  const last = useRef<{ m: THREE.Matrix4; w: number; h: number; anchors: [number, number, number][] | null }>({
    m: new THREE.Matrix4(),
    w: 0,
    h: 0,
    anchors: null,
  });
  useFrame((): void => {
    camera.updateMatrixWorld();
    const L = last.current;
    const ready = els.current.length === anchors.length && els.current.every((e: HTMLSpanElement | null): boolean => e !== null);
    if (ready && L.anchors === anchors && L.w === size.width && L.h === size.height && L.m.equals(camera.matrixWorld)) return;
    // Nearest labels first; a label that would overlap one already placed is hidden (far rows bunch up in
    // perspective). Fixed label box, so no layout reads per frame.
    const pts = anchors.map((a: [number, number, number], k: number) => {
      v.set(a[0], a[1], a[2]).project(camera);
      return { k, x: ((v.x + 1) / 2) * size.width, y: ((1 - v.y) / 2) * size.height, z: v.z };
    });
    pts.sort((a: { z: number }, b: { z: number }): number => a.z - b.z);
    const placed: { x: number; y: number }[] = [];
    for (const q of pts) {
      const el = els.current[q.k];
      if (!el) continue;
      const clash = placed.some((o: { x: number; y: number }): boolean => Math.abs(o.x - q.x) < LABEL_W && Math.abs(o.y - q.y) < LABEL_H);
      const hidden = q.z > 1 || q.z < -1 || clash;
      if (!hidden) placed.push({ x: q.x, y: q.y });
      el.style.visibility = hidden ? 'hidden' : 'visible';
      el.style.transform = `translate(-50%, -50%) translate(${q.x}px, ${q.y}px)`;
    }
    if (ready) {
      L.anchors = anchors;
      L.w = size.width;
      L.h = size.height;
      L.m.copy(camera.matrixWorld);
    }
  });
  return null;
}

/** The labels themselves (outside the canvas, over it). */
export function PatchLabels({ data, els }: { data: PatchLayerData; els: MutableRefObject<(HTMLSpanElement | null)[]> }): JSX.Element {
  return (
    <div className="t3-patch-labels" aria-hidden="true">
      {data.values.map((val: number, k: number) => (
        <span
          key={k}
          className="t3-patch-label"
          style={{ visibility: 'hidden' }}
          ref={(el: HTMLSpanElement | null): void => {
            els.current[k] = el;
          }}
        >
          {fmtPatch(val, data.unit, true)}
        </span>
      ))}
    </div>
  );
}
