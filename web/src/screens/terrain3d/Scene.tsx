// One 3D pane: terrain, one sun, and the hazard overlay. Both panes share camera, sun and exaggeration.
import { useEffect, useMemo, useRef, type JSX, type ReactNode } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Html, Line, OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import * as THREE from 'three';
import { SafeCanvas } from '../../components/SafeCanvas';
import { Loading } from '../../components/Loading';
import { TERRAIN_KM, terrainHeightAt, useTerrainGeometry } from '../../components/terrainGeometry';
import type { LoadedTile } from '../../data/tiles';
import type { RimSeg } from './data';

const KM = TERRAIN_KM;
export const SHADOW_MAP = 2048; // per pane; 4096² on two canvases was part of the WebGL context pressure
const RIM_COLOR = '#F07B4A';
const PATH_COLOR = '#edeae4';

// ------------------------------------------------------------------------------------------------
// Camera sync (shared mutable state, not React state, so dragging does not re-render the screen)
// ------------------------------------------------------------------------------------------------

const START_POS: [number, number, number] = [0, 17, 19];
const sync = { pos: new THREE.Vector3(...START_POS), target: new THREE.Vector3(0, 0, 0), version: 0, source: '' };

function SyncedControls({ id }: { id: string }): JSX.Element {
  const ref = useRef<OrbitControlsImpl>(null);
  const camera = useThree((s) => s.camera);
  const seen = useRef<number>(-1);
  const applying = useRef<boolean>(false);
  useFrame((): void => {
    const c = ref.current;
    if (!c || sync.version === seen.current) return;
    seen.current = sync.version;
    if (sync.source === id) return;
    applying.current = true;
    camera.position.copy(sync.pos);
    c.target.copy(sync.target);
    c.update();
    applying.current = false;
  });
  return (
    <OrbitControls
      ref={ref}
      makeDefault
      enableDamping={false}
      maxPolarAngle={Math.PI / 2.05}
      minDistance={3}
      maxDistance={60}
      onChange={(): void => {
        const c = ref.current;
        if (!c || applying.current) return;
        sync.pos.copy(camera.position);
        sync.target.copy(c.target);
        sync.version++;
        sync.source = id;
        seen.current = sync.version;
      }}
    />
  );
}

// ------------------------------------------------------------------------------------------------
// Scene pieces
// ------------------------------------------------------------------------------------------------

function tileToScene(tile: LoadedTile, c: number, r: number, exag: number, lift: number): [number, number, number] {
  const n = tile.filled.size;
  const W = n * tile.filled.res * KM;
  return [(c / (n - 1) - 0.5) * W, terrainHeightAt(tile, c, r, exag) + lift, (r / (n - 1) - 0.5) * W];
}

function TerrainMesh({
  tile,
  exag,
  map,
  emissiveMap,
  shadows,
}: {
  tile: LoadedTile;
  exag: number;
  map: THREE.Texture | null;
  emissiveMap: THREE.Texture | null;
  shadows: boolean;
}): JSX.Element {
  const geom = useTerrainGeometry(tile, exag);
  return (
    <mesh geometry={geom} castShadow={shadows} receiveShadow={shadows}>
      <meshStandardMaterial
        key={`${map ? map.uuid : 'plain'}:${emissiveMap ? emissiveMap.uuid : 'none'}`}
        color="#c4beb3"
        roughness={0.97}
        metalness={0}
        map={map}
        emissive={emissiveMap ? '#ffffff' : '#000000'}
        emissiveMap={emissiveMap}
        emissiveIntensity={emissiveMap ? 0.55 : 0}
      />
    </mesh>
  );
}

function DrapedLine({
  tile,
  exag,
  from,
  to,
  color,
  width,
}: {
  tile: LoadedTile;
  exag: number;
  from: [number, number];
  to: [number, number];
  color: string;
  width: number;
}): JSX.Element | null {
  const pts = useMemo((): [number, number, number][] => {
    const steps = Math.max(2, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1])));
    const out: [number, number, number][] = [];
    for (let s = 0; s <= steps; s++) {
      const c = from[0] + ((to[0] - from[0]) * s) / steps;
      const r = from[1] + ((to[1] - from[1]) * s) / steps;
      out.push(tileToScene(tile, c, r, exag, 0.05));
    }
    return out;
  }, [tile, exag, from, to]);
  if (pts.length < 2) return null;
  return <Line points={pts} color={color} lineWidth={width} />;
}

function RimOverlay({ tile, exag, segs }: { tile: LoadedTile; exag: number; segs: RimSeg[] }): JSX.Element {
  return (
    <group>
      {segs.map((s: RimSeg) => {
        const mid: [number, number] = [(s.start[0] + s.end[0]) / 2, (s.start[1] + s.end[1]) / 2];
        const top = tileToScene(tile, s.start[0], s.start[1], exag, 0.08);
        const labelPos = tileToScene(tile, mid[0], mid[1], exag, 0.9);
        return (
          <group key={s.rank}>
            <DrapedLine tile={tile} exag={exag} from={s.start} to={s.end} color={RIM_COLOR} width={5} />
            <mesh position={top}>
              <sphereGeometry args={[0.09, 12, 12]} />
              <meshBasicMaterial color={RIM_COLOR} />
            </mesh>
            <Html position={labelPos} center zIndexRange={[20, 0]} className="t3-tag3d-wrap">
              <span className="t3-tag3d">
                <b>#{s.rank}</b> {Math.round(s.absDh)} m drop
              </span>
            </Html>
          </group>
        );
      })}
    </group>
  );
}

function Sun({ el, az, shadows, extent }: { el: number; az: number; shadows: boolean; extent: number }): JSX.Element {
  const light = useRef<THREE.DirectionalLight>(null);
  const scene = useThree((s) => s.scene);
  useEffect((): void => {
    const l = light.current;
    if (!l) return;
    const e = (el * Math.PI) / 180;
    const a = (az * Math.PI) / 180;
    const dist = 40;
    // azimuth clockwise from the tile's top (grid +y = -z here); right = +x
    l.position.set(Math.sin(a) * Math.cos(e) * dist, Math.sin(e) * dist, -Math.cos(a) * Math.cos(e) * dist);
    l.target.position.set(0, 0, 0);
    if (!l.target.parent) scene.add(l.target);
    const half = extent * 0.72 + 0.3;
    const cam = l.shadow.camera;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.near = 1;
    cam.far = dist * 2;
    cam.updateProjectionMatrix();
    l.shadow.needsUpdate = true;
  }, [el, az, extent, scene]);
  return (
    <directionalLight
      ref={light}
      intensity={3.2}
      castShadow={shadows}
      shadow-mapSize-width={SHADOW_MAP}
      shadow-mapSize-height={SHADOW_MAP}
      shadow-bias={-0.0005}
      shadow-normalBias={0.04}
    />
  );
}

// ------------------------------------------------------------------------------------------------
// Pane
// ------------------------------------------------------------------------------------------------

export interface PaneProps {
  id: 'moon' | 'earth';
  name: string;
  world: string;
  /** Short line under the name (e.g. data source, country). */
  sub: string;
  /** Tooltip for the name (precise place). */
  nameTitle?: string;
  /** "Up" direction note for this tile. */
  upNote: string;
  tile: LoadedTile | null;
  error: string | null;
  extentKm: number;
  exag: number;
  el: number;
  az: number;
  realtime: boolean;
  lift: boolean;
  shadeMap: THREE.Texture | null;
  cellMap: THREE.Texture | null;
  rim: RimSeg[] | null;
  path: [number, number][] | null;
  /** Big corner readout. */
  readout: ReactNode;
  /** Small note at the bottom right. */
  note?: ReactNode;
}

export function Pane(p: PaneProps): JSX.Element {
  const { tile } = p;
  const shadows = p.realtime;
  return (
    <figure className="t3-pane" data-world={p.id}>
      {p.error ? (
        <div className="t3-pane-error" role="alert">
          <p>Could not load the {p.world} terrain.</p>
          <p className="caption">{p.error}</p>
        </div>
      ) : !tile ? (
        <Loading label={`Loading ${p.name} terrain…`} />
      ) : (
        <SafeCanvas
          name={`3D view (${p.world})`}
          resetKey={tile.ref.path}
          shadows={shadows ? 'percentage' : false}
          dpr={[1, 1.5]}
          camera={{ position: START_POS, fov: 38, near: 0.05, far: 200 }}
          gl={{ antialias: true, powerPreference: 'default' }}
        >
          <color attach="background" args={['#14161b']} />
          <hemisphereLight args={['#9aa3b5', '#2a2620', p.lift ? 0.55 : 0.05]} />
          <Sun el={p.el} az={p.az} shadows={shadows} extent={p.extentKm} />
          <TerrainMesh tile={tile} exag={p.exag} map={p.realtime ? null : p.shadeMap} emissiveMap={p.cellMap} shadows={shadows} />
          {p.rim && <RimOverlay tile={tile} exag={p.exag} segs={p.rim} />}
          {p.path &&
            p.path.slice(1).map((pt: [number, number], i: number) => (
              <DrapedLine key={i} tile={tile} exag={p.exag} from={p.path?.[i] ?? pt} to={pt} color={PATH_COLOR} width={3} />
            ))}
          <SyncedControls id={p.id} />
        </SafeCanvas>
      )}
      <figcaption className="t3-pane-head">
        <span className="t3-pane-world">{p.world}</span>
        <span className="t3-pane-name" title={p.nameTitle}>
          {p.name}
        </span>
        <span className="t3-pane-sub">{p.sub}</span>
      </figcaption>
      <div className="t3-pane-up" aria-hidden="true">
        <svg width="12" height="14" viewBox="0 0 12 14">
          <path d="M6 1l4.5 6H7.2v6H4.8V7H1.5z" fill="currentColor" />
        </svg>
        {p.upNote}
      </div>
      <div className="t3-pane-readout" aria-live="polite">
        {p.readout}
      </div>
      {p.note && <div className="t3-pane-note">{p.note}</div>}
    </figure>
  );
}
