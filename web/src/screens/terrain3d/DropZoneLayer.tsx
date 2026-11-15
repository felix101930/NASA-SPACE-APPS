// "Show big-drop zones" on a 3D pane: where the ground height changes a lot within 1 km (the Rim jump hazard).
// A per-pixel hazard-orange tint multiplied onto the lit terrain (calm ground keeps no tint, cast shadows stay black),
// plus the three biggest 1 km height changes as orange lines draped just above the surface. Labels are emitted as
// data and moved as plain DOM elements (no drei <Html>). The computation (lib/dropZones.ts, same definition as
// pipeline/metrics/rim.py) runs in workers/dropZones.worker.ts and is cached per DEM array.
//
// ================================================================================================================
// INTEGRATION NOTE (host = screens/terrain3d/Scene.tsx + screens/Terrain3D.tsx; nothing here edits them)
// ================================================================================================================
// Scene.tsx
//   imports:
//     import { useState } from 'react';   // add to the existing react import
//     import { DropZoneLabels, DropZoneLayer, type DropZoneLabelData, type DropZoneStats } from './DropZoneLayer';
//   PaneProps, add:
//     /** "Show big-drop zones": on/off, the colour max shared by both panes, and where to report this pane's stats. */
//     dropZones?: { visible: boolean; scaleMax: number; onStats: (s: DropZoneStats) => void } | null;
//   Pane body, next to patchEls:
//     const dzEls = useRef<(HTMLSpanElement | null)[]>([]);
//     const [dzLabels, setDzLabels] = useState<DropZoneLabelData[]>([]);
//   Inside <SafeCanvas>, right after <TerrainMesh … />:
//     {p.dropZones && (
//       <DropZoneLayer dem={tile.raw.data} size={tile.raw.size} resM={tile.raw.res} exaggeration={p.exag}
//         scaleMax={p.dropZones.scaleMax} visible={p.dropZones.visible} onStats={p.dropZones.onStats}
//         onLabels={setDzLabels} labelEls={dzEls} />
//     )}
//   After the canvas, next to <PatchLabels …/>:
//     {tile && !p.error && p.dropZones?.visible && <DropZoneLabels labels={dzLabels} els={dzEls} />}
//
// Terrain3D.tsx
//   imports:
//     import { useCallback } from 'react';   // add to the existing react import
//     import { DropZoneLegend, type DropZoneStats } from './terrain3d/DropZoneLayer';
//   state, next to showPatches (off by default, switched on whenever the Rim jump tab is selected):
//     const [showDrops, setShowDrops] = useState<boolean>(false);
//     useEffect((): void => setShowDrops(hazard === 'rim'), [hazard]);
//     const [dzStats, setDzStats] = useState<{ moon: DropZoneStats | null; earth: DropZoneStats | null }>({ moon: null, earth: null });
//     const onMoonDz = useCallback((s: DropZoneStats): void => setDzStats((o) => ({ ...o, moon: s })), []);
//     const onEarthDz = useCallback((s: DropZoneStats): void => setDzStats((o) => ({ ...o, earth: s })), []);
//     // Shared colour max = the larger of the two panes' 99th percentiles, so the same orange means the same metres.
//     const dzScaleMax = Math.max(dzStats.moon?.fieldP99 ?? 0, dzStats.earth?.fieldP99 ?? 0);
//   on the Moon <Pane>:   dropZones={{ visible: showDrops, scaleMax: dzScaleMax, onStats: onMoonDz }}
//   on the Earth <Pane>:  dropZones={{ visible: showDrops, scaleMax: dzScaleMax, onStats: onEarthDz }}
//   The layer draws the same top-3 segments as RimOverlay (verified identical to annotations rim_drops), so while it
//   is on pass rim={showDrops ? null : moonRim} and rim={hazard === 'rim' && !showDrops ? earthRim : null}.
//   In .t3-caption-lines, after the patch key:
//     {showDrops && dzScaleMax > 0 && <DropZoneLegend scaleMax={dzScaleMax} />}
//   In .t3-toggles, first:
//     <label className="check t3-lift">
//       <input type="checkbox" checked={showDrops} onChange={(e): void => setShowDrops(e.target.checked)} />
//       Show big-drop zones
//     </label>
// ================================================================================================================
import { useEffect, useMemo, useRef, useState, type JSX, type MutableRefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import * as THREE from 'three';
import { TERRAIN_KM } from '../../components/terrainGeometry';
import { fillNaN, sampleBilinear, type Grid } from '../../lib/terrain';
import { computeDropZones, dropTint, type DropSegment, type DropZoneResult } from '../../lib/dropZones';
import type { DropZoneReply, DropZoneRequest } from '../../workers/dropZones.worker';
import './dropzones.css';

export type { DropSegment } from '../../lib/dropZones';

const KM = TERRAIN_KM;
export const DROP_COLOR = '#F07B4A';
const DROP_RGB: [number, number, number] = [0xf0, 0x7b, 0x4a];
/** Strength of the multiply tint at the top of the scale (0 = none, 1 = full orange). */
export const DROP_TINT_OPACITY = 0.85;
const LINE_LIFT = 0.05;
const DOT_LIFT = 0.08;
const LABEL_LIFT = 0.6;

export interface DropZoneStats {
  /** P95 of all 1 km pairs (m): equals jump1km_p95_m in regions.json / matches.json. */
  p95: number;
  p99: number;
  /** P99 of the per-pixel field (m): use max over both panes as the shared scaleMax. */
  fieldP99: number;
  top: DropSegment[];
  /** Worker compute time (ms); 0 when served from the cache. */
  ms: number;
}

export interface DropZoneLabelData {
  rank: number;
  text: string;
  /** Scene position of the label anchor (segment midpoint, lifted). */
  anchor: [number, number, number];
}

export interface DropZoneLayerProps {
  /** Row-major heights, row 0 = tile top. Pass the RAW tile (NaN = no data) so the numbers match the pipeline. */
  dem: Float32Array;
  size: number;
  resM: number;
  exaggeration: number;
  /** Colour scale max (m), shared between the Moon and Earth panes. No tint until it is > 0. */
  scaleMax: number;
  visible: boolean;
  onStats?: (s: DropZoneStats) => void;
  /** Label data for the 3 segments (emitted when they or the exaggeration change). */
  onLabels?: (labels: DropZoneLabelData[]) => void;
  /** DOM label elements (from <DropZoneLabels>) that this layer moves to their projected anchors each camera move. */
  labelEls?: MutableRefObject<(HTMLSpanElement | null)[]>;
  /** Reuse the host's terrain geometry for the tint instead of building an identical one. */
  geometry?: THREE.BufferGeometry;
  /** Draw the top-3 lines (default true). */
  showSegments?: boolean;
}

// ------------------------------------------------------------------------------------------------
// Worker client: one shared worker, results cached per DEM array (re-mounts and toggles cost nothing)
// ------------------------------------------------------------------------------------------------

type Computed = DropZoneResult & { ms: number };

let worker: Worker | null = null;
let workerBroken = false;
let nextId = 1;
const pending = new Map<number, { resolve: (r: Computed) => void; reject: (e: Error) => void }>();
const cache = new WeakMap<Float32Array, { key: string; promise: Promise<Computed> }>();

function getWorker(): Worker | null {
  if (worker || workerBroken) return worker;
  try {
    const w = new Worker(new URL('../../workers/dropZones.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<DropZoneReply>): void => {
      const msg = e.data;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.type === 'result') p.resolve({ ...msg.result, ms: msg.ms });
      else p.reject(new Error(msg.message));
    };
    w.onerror = (): void => {
      workerBroken = true;
      worker = null;
      pending.forEach((p): void => p.reject(new Error('drop-zone worker failed')));
      pending.clear();
      w.terminate();
    };
    worker = w;
  } catch {
    workerBroken = true;
  }
  return worker;
}

function computeInline(dem: Float32Array, size: number, resM: number): Computed {
  const t0 = performance.now();
  const r = computeDropZones(dem, size, resM);
  return { ...r, ms: performance.now() - t0 };
}

export function requestDropZones(dem: Float32Array, size: number, resM: number): Promise<Computed> {
  const key = `${size}:${resM}`;
  const hit = cache.get(dem);
  if (hit && hit.key === key) return hit.promise.then((r: Computed): Computed => ({ ...r, ms: 0 }));
  const promise = new Promise<Computed>((resolve, reject): void => {
    const w = getWorker();
    if (!w) {
      resolve(computeInline(dem, size, resM));
      return;
    }
    const id = nextId++;
    pending.set(id, {
      resolve,
      // A broken worker falls back to the main thread rather than leaving the overlay empty.
      reject: (): void => {
        try {
          resolve(computeInline(dem, size, resM));
        } catch (err: unknown) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      },
    });
    const msg: DropZoneRequest = { id, dem, size, resM };
    w.postMessage(msg); // copied, not transferred: the host keeps using the DEM
  });
  cache.set(dem, { key, promise });
  promise.catch((): void => {
    if (cache.get(dem)?.promise === promise) cache.delete(dem);
  });
  return promise;
}

/** Drop-zone result for a DEM, computed in the worker once `enabled` first turns true. */
export function useDropZones(dem: Float32Array, size: number, resM: number, enabled: boolean): Computed | null {
  const [state, setState] = useState<{ dem: Float32Array; r: Computed } | null>(null);
  useEffect((): (() => void) | void => {
    if (!enabled || (state && state.dem === dem)) return;
    let live = true;
    requestDropZones(dem, size, resM).then(
      (r: Computed): void => {
        if (live) setState({ dem, r });
      },
      (err: unknown): void => {
        console.warn('drop zones failed', err);
      },
    );
    return (): void => {
      live = false;
    };
  }, [dem, size, resM, enabled, state]);
  return state && state.dem === dem ? state.r : null;
}

// ------------------------------------------------------------------------------------------------
// Geometry helpers (identical formulas to components/terrainGeometry.ts)
// ------------------------------------------------------------------------------------------------

interface Surface {
  grid: Grid;
  median: number;
}

function useSurface(dem: Float32Array, size: number, resM: number): Surface {
  return useMemo((): Surface => {
    // Same fill + median as data/tiles.ts loadTile, so heights line up with the host mesh exactly.
    const { filled, stats } = fillNaN(dem);
    return { grid: { data: filled, size, res: resM }, median: stats.median };
  }, [dem, size, resM]);
}

/** Scene position of pixel (col, row), `lift` scene units above the exaggerated surface. */
function toScene(s: Surface, c: number, r: number, exag: number, lift: number): [number, number, number] {
  const n = s.grid.size;
  const W = n * s.grid.res * KM;
  const h = (sampleBilinear(s.grid, c, r) - s.median) * KM * exag;
  return [(c / (n - 1) - 0.5) * W, (Number.isFinite(h) ? h : 0) + lift, (r / (n - 1) - 0.5) * W];
}

/** Grid mesh matching useTerrainGeometry's positions + uvs (no normals: the tint material is unlit). */
function useOwnGeometry(s: Surface, exag: number, skip: boolean): THREE.BufferGeometry | null {
  const geom = useMemo((): THREE.BufferGeometry | null => {
    if (skip) return null;
    const n = s.grid.size;
    const W = n * s.grid.res * KM;
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
        idx[k++] = a;
        idx[k++] = a + n;
        idx[k++] = a + 1;
        idx[k++] = a + 1;
        idx[k++] = a + n;
        idx[k++] = a + n + 1;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    return g;
  }, [s, skip]);

  useMemo((): void => {
    if (!geom) return;
    const attr = geom.getAttribute('position');
    if (!(attr instanceof THREE.BufferAttribute)) return;
    const arr = attr.array;
    const d = s.grid.data;
    for (let i = 0; i < d.length; i++) arr[i * 3 + 1] = (d[i] - s.median) * KM * exag;
    attr.needsUpdate = true;
    geom.computeBoundingSphere();
  }, [geom, s, exag]);

  useEffect((): (() => void) => (): void => geom?.dispose(), [geom]);
  return geom;
}

/** n × n RGBA tint: hazard orange, alpha = ramp strength (calm ground alpha 0). UV v runs bottom-up. */
function useDropTexture(field: Float32Array | null, n: number, scaleMax: number): THREE.DataTexture | null {
  const tex = useMemo((): THREE.DataTexture | null => {
    if (!field || !(scaleMax > 0) || field.length !== n * n) return null;
    const px = new Uint8Array(n * n * 4);
    for (let r = 0; r < n; r++) {
      const src = r * n;
      const dst = (n - 1 - r) * n;
      for (let c = 0; c < n; c++) {
        const o = (dst + c) * 4;
        px[o] = DROP_RGB[0];
        px[o + 1] = DROP_RGB[1];
        px[o + 2] = DROP_RGB[2];
        px[o + 3] = Math.round(dropTint(field[src + c], scaleMax) * 255);
      }
    }
    const t = new THREE.DataTexture(px, n, n, THREE.RGBAFormat);
    t.colorSpace = THREE.SRGBColorSpace;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  }, [field, n, scaleMax]);
  useEffect((): (() => void) => (): void => tex?.dispose(), [tex]);
  return tex;
}

// ------------------------------------------------------------------------------------------------
// Labels: data + projection helper
// ------------------------------------------------------------------------------------------------

export function dropLabelText(s: DropSegment): string {
  return `${Math.round(s.absDh).toLocaleString('en-US')} m height change in 1 km`;
}

/** Screen position (px from the canvas top-left) of a scene point; `visible` false when behind the camera. */
export function projectAnchor(
  anchor: [number, number, number],
  camera: THREE.Camera,
  size: { width: number; height: number },
  scratch: THREE.Vector3 = new THREE.Vector3(),
): { x: number; y: number; visible: boolean } {
  scratch.set(anchor[0], anchor[1], anchor[2]).project(camera);
  return {
    x: ((scratch.x + 1) / 2) * size.width,
    y: ((1 - scratch.y) / 2) * size.height,
    visible: scratch.z >= -1 && scratch.z <= 1,
  };
}

/** Moves the DOM labels to their anchors; writes only when the camera, canvas size or anchors change. */
function LabelProjector({ labels, els }: { labels: DropZoneLabelData[]; els: MutableRefObject<(HTMLSpanElement | null)[]> }): null {
  const camera = useThree((st) => st.camera);
  const size = useThree((st) => st.size);
  const v = useMemo((): THREE.Vector3 => new THREE.Vector3(), []);
  const last = useRef<{ m: THREE.Matrix4; w: number; h: number; labels: DropZoneLabelData[] | null }>({
    m: new THREE.Matrix4(),
    w: 0,
    h: 0,
    labels: null,
  });
  useFrame((): void => {
    camera.updateMatrixWorld();
    const L = last.current;
    const ready = labels.every((_: DropZoneLabelData, k: number): boolean => (els.current[k] ?? null) !== null);
    if (ready && L.labels === labels && L.w === size.width && L.h === size.height && L.m.equals(camera.matrixWorld)) return;
    labels.forEach((lab: DropZoneLabelData, k: number): void => {
      const el = els.current[k];
      if (!el) return;
      const q = projectAnchor(lab.anchor, camera, size, v);
      el.style.visibility = q.visible ? 'visible' : 'hidden';
      el.style.transform = `translate(-50%, -100%) translate(${q.x}px, ${q.y}px)`;
    });
    if (ready) {
      L.labels = labels;
      L.w = size.width;
      L.h = size.height;
      L.m.copy(camera.matrixWorld);
    }
  });
  return null;
}

/** The segment labels as DOM elements over the canvas (render outside <Canvas>, inside the positioned pane). */
export function DropZoneLabels({ labels, els }: { labels: DropZoneLabelData[]; els: MutableRefObject<(HTMLSpanElement | null)[]> }): JSX.Element {
  return (
    <div className="dz-labels" aria-hidden="true">
      {labels.map((lab: DropZoneLabelData, k: number) => (
        <span
          key={lab.rank}
          className="dz-label"
          style={{ visibility: 'hidden' }}
          ref={(el: HTMLSpanElement | null): void => {
            els.current[k] = el;
          }}
        >
          <b>#{lab.rank}</b> {lab.text}
        </span>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// The layer
// ------------------------------------------------------------------------------------------------

function Segments({ surface, exag, top }: { surface: Surface; exag: number; top: DropSegment[] }): JSX.Element {
  const lines = useMemo(
    (): [number, number, number][][] =>
      top.map((s: DropSegment): [number, number, number][] => {
        const len = Math.hypot(s.end[0] - s.start[0], s.end[1] - s.start[1]);
        const steps = Math.max(2, Math.ceil(len));
        const pts: [number, number, number][] = [];
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          pts.push(toScene(surface, s.start[0] + (s.end[0] - s.start[0]) * t, s.start[1] + (s.end[1] - s.start[1]) * t, exag, LINE_LIFT));
        }
        return pts;
      }),
    [surface, exag, top],
  );
  const dots = useMemo(
    (): [number, number, number][] => top.map((s: DropSegment): [number, number, number] => toScene(surface, s.start[0], s.start[1], exag, DOT_LIFT)),
    [surface, exag, top],
  );
  const dotGeom = useMemo((): THREE.SphereGeometry => new THREE.SphereGeometry(0.09, 12, 8), []);
  useEffect((): (() => void) => (): void => dotGeom.dispose(), [dotGeom]);
  return (
    <group renderOrder={3}>
      {lines.map((pts: [number, number, number][], k: number) => (
        <Line key={k} points={pts} color={DROP_COLOR} lineWidth={4} toneMapped={false} />
      ))}
      {/* Dot on the high end of each segment. */}
      {dots.map((p: [number, number, number], k: number) => (
        <mesh key={k} geometry={dotGeom} position={p}>
          <meshBasicMaterial color={DROP_COLOR} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

export function DropZoneLayer({
  dem,
  size,
  resM,
  exaggeration,
  scaleMax,
  visible,
  onStats,
  onLabels,
  labelEls,
  geometry,
  showSegments = true,
}: DropZoneLayerProps): JSX.Element | null {
  const result = useDropZones(dem, size, resM, visible);
  const surface = useSurface(dem, size, resM);
  const own = useOwnGeometry(surface, exaggeration, geometry !== undefined || !visible);
  const geom = geometry ?? own;
  const tex = useDropTexture(visible ? (result?.field ?? null) : null, size, scaleMax);

  const statsCb = useRef<DropZoneLayerProps['onStats']>(onStats);
  statsCb.current = onStats;
  const labelsCb = useRef<DropZoneLayerProps['onLabels']>(onLabels);
  labelsCb.current = onLabels;

  useEffect((): void => {
    if (!result) return;
    statsCb.current?.({ p95: result.p95, p99: result.p99, fieldP99: result.fieldP99, top: result.top, ms: result.ms });
  }, [result]);

  const labels = useMemo(
    (): DropZoneLabelData[] =>
      result && showSegments
        ? result.top.map(
            (s: DropSegment): DropZoneLabelData => ({
              rank: s.rank,
              text: dropLabelText(s),
              anchor: toScene(surface, (s.start[0] + s.end[0]) / 2, (s.start[1] + s.end[1]) / 2, exaggeration, LABEL_LIFT),
            }),
          )
        : [],
    [result, surface, exaggeration, showSegments],
  );
  useEffect((): void => {
    labelsCb.current?.(labels);
  }, [labels]);

  if (!visible) return null;
  return (
    <>
      {geom && tex && (
        <mesh geometry={geom} renderOrder={1}>
          {/* Multiply tint: result = terrain × mix(1, orange, alpha), so calm ground is untouched and shadows stay black. */}
          <meshBasicMaterial
            map={tex}
            transparent
            opacity={DROP_TINT_OPACITY}
            premultipliedAlpha
            blending={THREE.CustomBlending}
            blendEquation={THREE.AddEquation}
            blendSrc={THREE.DstColorFactor}
            blendDst={THREE.OneMinusSrcAlphaFactor}
            depthWrite={false}
            polygonOffset
            polygonOffsetFactor={-3}
            polygonOffsetUnits={-3}
            toneMapped={false}
          />
        </mesh>
      )}
      {result && showSegments && <Segments surface={surface} exag={exaggeration} top={result.top} />}
      {labelEls && labels.length > 0 && <LabelProjector labels={labels} els={labelEls} />}
    </>
  );
}

/** Plain-DOM key for the caption: gradient from plain ground to hazard orange, max in metres. */
export function DropZoneLegend({ scaleMax }: { scaleMax: number }): JSX.Element {
  const max = Math.round(scaleMax).toLocaleString('en-US');
  return (
    <div className="dz-legend">
      <span className="dz-legend-text">
        <strong>Big-drop zones</strong> · plain = gentle · orange = big height change within 1 km
      </span>
      <span className="dz-legend-scale" aria-label={`colour scale from 0 to ${max} metres`}>
        <span className="dz-legend-num">0 m</span>
        <i className="dz-legend-bar" aria-hidden="true" />
        <span className="dz-legend-num">{max} m</span>
      </span>
    </div>
  );
}
